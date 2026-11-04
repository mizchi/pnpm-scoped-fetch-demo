import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { canonicalJson, planGroups, sha256 } from '../../action/cache-groups.mjs'
import { createThinPlan, validateThinPlan, planId, cachePath, isStoreObject } from '../../action/cache-plan.mjs'
import { lockfileGraph, readStore } from '../native-store.mjs'
import { exportStoreScopes } from '../export-scopes.mjs'
import { writeTarChunk, verifyTarChunk, restoreTarChunk } from '../tar-zstd.mjs'
import { createGitHubCacheTransport, cacheInventory, fileDigest } from '../github-cache.mjs'
import { fileURLToPath } from 'node:url'
import { stageStore } from '../store-staging.mjs'
import { scenarios } from './scenarios.mjs'
import { root, source, state, results, input, json, output, command, prepareSource, queryFor, installAndCheck } from './common.mjs'

function elapsed(start) { return performance.now() - start }
function objectForPlan(query, sha, size) { return { kind: 'plan', id: planId(query), sha256: sha, size } }
function fetchArgs(store, entry) { return ['--store-dir', store, '--reporter=append-only', 'fetch', '--ignore-scripts', ...(entry ? [`--filter={${entry}}...`, '--workspace-root'] : [])] }

async function cold(context, transport) {
  const query = queryFor(context.context, 'sdk', 67108864)
  const started = performance.now(), lookup = await transport.restoreOne(objectForPlan(query))
  assert(!lookup.hit, 'Run-specific plan must start cold')
  const store = path.join(state, 'cold-store')
  const fetched = await command(context.binary, fetchArgs(store, 'sdk'), { name: 'cold-fetch' })
  const progress = [...fetched.text.matchAll(/resolved (\d+), reused (\d+), downloaded (\d+)/g)].at(-1)
  assert(progress && Number(progress[3]) > 0, 'Cold fetch must download packages')
  const validation = await installAndCheck({ binary: context.binary, store, entry: 'sdk', lockfile: context.context.lockfile })
  const totalMs = elapsed(started)
  const nativeInventory = readStore(store, lockfileGraph(context.lockfile).packageIds)
  const fingerprint = sha256(canonicalJson(nativeInventory.files))
  output('sdk-fingerprint', fingerprint)
  json(path.join(results, 'cold.json'), { kind: 'cold-sdk', query, cacheMisses: 1, fetchMs: fetched.ms,
    downloadedPackages: Number(progress[3]), nativeSdkFingerprint: fingerprint, files: nativeInventory.files.length, checkout: context.checkout, ...validation, totalMs, trustLockfile: true })
}

async function publish(context, transport, namespace) {
  const started = performance.now(), store = path.join(state, 'full-store')
  const fetching = await command(context.binary, fetchArgs(store), { name: 'producer-fetch' })
  const exportDirectory = path.join(state, 'export'); fs.mkdirSync(exportDirectory)
  const exportStart = performance.now()
  const data = exportStoreScopes({ store, lockfile: context.lockfile, entries: ['app', 'api', 'sdk'], directory: exportDirectory })
  assert.equal(sha256(canonicalJson(data.inventories.sdk)), input('expected-sdk-fingerprint'), 'Single-store SDK inventory must match the independent native fetch')
  const exportMs = elapsed(exportStart), records = [], plans = [], packing = []
  for (const targetBytes of [67108864, 16777216]) {
    const manifest = planGroups(data.inventories, { targetBytes, context: { layout: data.full.layout }, packageGraph: data.graph, filePackages: data.full.filePackages })
    const destination = path.join(state, `pack-${targetBytes}`); fs.mkdirSync(destination)
    const archives = {}, packStart = performance.now()
    for (const [key, chunk] of Object.entries(manifest.chunks)) {
      const filename = path.join(destination, `${key}.tar.zst`)
      archives[key] = { filename, ...await writeTarChunk({ chunk, source: relative => fs.createReadStream(data.full.sourceFiles[relative]), filename }) }
      await verifyTarChunk({ chunk, input: fs.createReadStream(filename), archiveSha256: archives[key].sha256 })
    }
    packing.push({ targetBytes, chunks: Object.keys(archives).length, encodeAndVerifyMs: elapsed(packStart) })
    for (const [entry, index] of Object.entries(data.indexes)) manifest.entries[entry].index = index
    const material = { sourceLockfile: context.context.lockfile, context: { layout: data.full.layout }, manifest, archives }
    for (const entry of targetBytes === 67108864 ? ['sdk', 'app', 'api'] : ['sdk']) {
      const query = queryFor(context.context, entry, targetBytes)
      const plan = createThinPlan({ material, entry, query })
      plans.push(plan)
      for (const object of plan.objects) {
        const archive = Object.values(archives).find(archive => archive.sha256 === object.id)
        records.push({ object, source: archive.filename })
      }
      records.push({ object: plan.index, source: data.indexes[entry].archive })
    }
  }
  for (const { entry, strategy: kind } of scenarios.filter(row => row.strategy !== 'chunks')) {
    const scope = kind === 'whole' ? 'workspace' : entry, files = data.inventories[scope]
    const object = { kind, id: sha256(canonicalJson({ files, index: data.indexes[scope].sha256 })),
      rawBytes: files.reduce((sum, file) => sum + file.size, 0), fileCount: files.length }
    const plan = { version: 1, layout: data.full.layout, query: queryFor(context.context, entry, 0, kind), objects: [object] }
    validateThinPlan(plan, plan.query); plans.push(plan)
    records.push({ object, source: stageStore({ directory: path.join(root, cachePath(object)), layout: data.full.layout,
      files, sourceFiles: data.full.sourceFiles, indexDirectory: kind === 'whole' ? store : path.join(exportDirectory, `index-${entry}`) }) })
  }
  const saves = await transport.publishMany(records)
  assert(saves.every(row => !row.hit), 'Run-specific data objects must start cold')
  const planRecords = [], planMetadata = []
  for (const plan of plans) {
    const bytes = Buffer.from(JSON.stringify(plan)), digest = sha256(bytes)
    const filename = path.join(state, `${planId(plan.query)}.json`)
    fs.writeFileSync(filename, bytes)
    const object = objectForPlan(plan.query, digest, bytes.length)
    planRecords.push({ object, source: filename })
    planMetadata.push({ query: plan.query, digest, bytes: bytes.length })
  }
  const planSaves = await transport.publishMany(planRecords)
  assert(planSaves.every(row => !row.hit), 'Run-specific plans must start cold')
  const matrix = []
  for (const metadata of planMetadata) {
    const { repetitions } = scenarios.find(row => row.entry === metadata.query.entry && row.strategy === metadata.query.mode && row.targetBytes === metadata.query.targetBytes)
    for (let sample = 1; sample <= repetitions; sample++) matrix.push({ label: `${metadata.query.entry}-${metadata.query.mode}-${metadata.query.targetBytes}-${sample}`,
      entry: metadata.query.entry, strategy: metadata.query.mode, target: String(metadata.query.targetBytes), digest: metadata.digest, sample })
  }
  output('matrix', { include: matrix })
  json(path.join(results, 'producer.json'), { kind: 'producer', context: context.context, namespace,
    fetchMs: fetching.ms, exportMs, packing, saves: [...saves, ...planSaves], plans: planMetadata,
    files: data.full.files.length, packages: data.full.packages.length, rawBytes: data.full.files.reduce((sum, file) => sum + file.size, 0),
    scopeMeasurements: data.measurements, totalMs: elapsed(started), trustLockfile: true })
}

async function providerSizes(namespace, keys) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const entries = await cacheInventory({ repository: process.env.GITHUB_REPOSITORY, token: input('github-token'), namespace, ref: process.env.GITHUB_REF })
    if (keys.every(key => entries.has(key))) return entries
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error('Published cache sizes did not appear in the repository inventory')
}

async function consume(context, transport, namespace) {
  const entry = input('entry', 'sdk'), strategy = input('strategy', 'chunks'), targetBytes = Number(input('target-bytes', '67108864'))
  const query = queryFor(context.context, entry, targetBytes, strategy), started = performance.now()
  const planObject = objectForPlan(query), rootResult = await transport.restoreOne(planObject)
  assert(rootResult.hit, 'Expected an exact warm plan hit')
  const planFile = path.join(root, cachePath(planObject)), expectedDigest = input('plan-digest')
  assert.equal(await fileDigest(planFile), expectedDigest, 'Plan digest differs from the trusted producer output')
  const plan = validateThinPlan(JSON.parse(fs.readFileSync(planFile, 'utf8')), query)
  const downloadStart = performance.now()
  const cached = await transport.restoreMany([...plan.objects, ...(plan.index ? [plan.index] : [])])
  assert(cached.every(row => row.hit), 'Expected every warm data object to hit')
  const downloadMs = elapsed(downloadStart), hydrateStart = performance.now()
  let store
  if (isStoreObject(plan.objects[0])) store = path.join(root, cachePath(plan.objects[0]))
  else {
    store = path.join(state, 'consumer-store'); fs.mkdirSync(store)
    for (const object of [plan.index, ...plan.objects]) {
      await restoreTarChunk({ chunk: { ...object, layout: plan.layout }, input: fs.createReadStream(path.join(root, cachePath(object))),
        archiveSha256: object.id, directory: store })
    }
  }
  const hydrateMs = elapsed(hydrateStart)
  const validation = await installAndCheck({ binary: context.binary, store, entry, lockfile: query.lockfile })
  const all = [rootResult, ...cached], inventory = await providerSizes(namespace, all.map(row => row.key))
  const dataProviderBytes = cached.reduce((sum, row) => sum + inventory.get(row.key).bytes, 0)
  const measured = { kind: 'warm-consumer', entry, strategy, targetBytes, sample: Number(input('sample', '1')), query,
    planBytes: fs.statSync(planFile).size, planProviderBytes: inventory.get(rootResult.key).bytes,
    dataInnerBytes: cached.reduce((sum, row) => sum + row.innerBytes, 0), dataProviderBytes,
    totalProviderBytes: dataProviderBytes + inventory.get(rootResult.key).bytes,
    dataObjects: cached.length, totalObjects: all.length, cacheHits: all.length,
    planRestoreMs: rootResult.restoreMs, dataRestoreWallMs: downloadMs, hydrateMs, ...validation,
    totalMs: elapsed(started), cacheObjects: all.map(row => ({ ...row, providerBytes: inventory.get(row.key).bytes })),
    nodeMaxRssBytes: process.resourceUsage().maxRSS * 1024, checkout: context.checkout, trustLockfile: true }
  json(path.join(results, 'consumer.json'), measured)
  console.log(JSON.stringify({ entry, strategy, targetBytes, sample: measured.sample, dataProviderBytes, totalObjects: all.length, totalMs: measured.totalMs }))
}

export async function main() {
  const context = await prepareSource(), namespace = input('namespace', 'shared')
  const transport = createGitHubCacheTransport({ root, namespace, concurrency: 4 })
  const mode = input('mode', 'consume')
  if (mode === 'cold') await cold(context, transport)
  else if (mode === 'publish') await publish(context, transport, namespace)
  else if (mode === 'consume') await consume(context, transport, namespace)
  else throw new Error(`Unknown benchmark mode: ${mode}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.stack ?? error); process.exitCode = 1 })
