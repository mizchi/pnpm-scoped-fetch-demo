import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { canonicalJson, sha256 } from '../../action/chunk-identity.mjs'
import { cachePath, objectCacheKey, validateThinPlan } from '../../action/cache-plan.mjs'
import { catalogId, MAX_CATALOG_BYTES } from '../../action/project-catalog.mjs'
import { fileDigest } from '../github-cache.mjs'
import { initializeCurrentProject } from '../initialize-current.mjs'
import { lockfileGraph, readStore } from '../native-store.mjs'
import { packProjects } from '../pack-projects.mjs'
import { stageStore } from '../store-staging.mjs'
import { exportScopedIndex, selectStoreScope } from '../scoped-index.mjs'
import { archiveIndex } from '../index-archive.mjs'
import { currentDirectories, currentMatrix, currentStrategies } from './on-demand-cases.mjs'
import { tuningMatrix } from './tuning-cases.mjs'
import { root, source, state, results, input, json, output, command, childEnvironment, providerSizes } from './common.mjs'

const targetBytes = 67108864

function installRunner(offline, label) {
  return request => command(request.binary, request.args, { cwd: request.cwd, name: label,
    environment: { ...childEnvironment(offline), ...request.environment } })
}

async function verifySdk() {
  await command(process.execPath, ['-e', "const assert=require('node:assert/strict');assert.equal(typeof require('typescript').transpile,'function')"],
    { cwd: path.join(source, 'sdk'), offline: true, name: 'cwd-module-load' })
}

async function cold(context) {
  const store = path.join(state, 'cwd-cold-store')
  assert(!fs.existsSync(store))
  assert(!fs.existsSync(path.join(source, 'sdk/node_modules')))
  const measured = await initializeCurrentProject({ cwd: path.join(source, 'sdk'), binary: context.binary, store,
    ignoreScripts: true, runInstall: installRunner(false, 'cwd-cold-install') })
  await verifySdk()
  const inventory = readStore(store, lockfileGraph(context.lockfile).packageIds)
  const fingerprint = sha256(canonicalJson(inventory.files))
  output('sdk-fingerprint', fingerprint)
  json(path.join(results, 'cwd-cold.json'), { kind: 'cwd-cold', context: context.context, measured, fingerprint,
    files: inventory.files.length, packages: inventory.packages.length, checkout: context.checkout, moduleLoad: true })
}

async function publish(context, transport, namespace) {
  const started = performance.now(), store = path.join(state, 'cwd-full-store')
  const fetching = await command(context.binary, ['--store-dir', store, 'fetch', '--ignore-scripts'], { name: 'cwd-producer-fetch' })
  const packed = await packProjects({ workspace: source, store, binary: context.binary, directory: path.join(state, 'cwd-pack'), targetBytes })
  assert.equal(packed.metrics.projectCount, Object.keys(context.lockfile.importers).length)
  assert.equal(packed.metrics.projects.sdk.fingerprint, input('expected-sdk-fingerprint'), 'Automatic SDK plan must match a native current-directory cold install')
  const whole = { kind: 'whole', layout: packed.full.layout, id: sha256(canonicalJson({ context: context.context, index: packed.catalog.index.id,
    files: packed.full.files })), fileCount: packed.full.files.length, rawBytes: packed.metrics.rawBytes }
  const wholeDirectory = stageStore({ directory: path.join(root, cachePath(whole)), layout: packed.full.layout,
    files: packed.full.files, sourceFiles: packed.full.sourceFiles, indexDirectory: store })
  const { graph, packageIds } = lockfileGraph(context.lockfile)
  const scope = selectStoreScope({ full: packed.full, graph, packageIds, importers: ['sdk'] })
  assert.equal(sha256(canonicalJson(scope.files)), input('expected-sdk-fingerprint'))
  const indexDirectory = path.join(state, 'scoped-sdk-index')
  const indexPaths = exportScopedIndex({ store, layout: packed.full.layout, scope, directory: indexDirectory })
  const index = archiveIndex({ store: indexDirectory, paths: indexPaths, archive: path.join(state, 'scoped-sdk-index.tar.zst') })
  const scoped = { kind: 'scoped', layout: packed.full.layout, id: sha256(canonicalJson({ files: scope.files, index: index.sha256 })),
    fileCount: scope.files.length, rawBytes: scope.files.reduce((sum, file) => sum + file.size, 0) }
  const scopedDirectory = stageStore({ directory: path.join(root, cachePath(scoped)), layout: packed.full.layout,
    files: scope.files, sourceFiles: packed.full.sourceFiles, indexDirectory })
  const records = packed.records.filter(record => record.object.kind !== 'catalog')
  const saves = await transport.publishMany([...records, { object: whole, source: wholeDirectory }, { object: scoped, source: scopedDirectory }])
  assert(saves.every(row => !row.hit), 'Run-specific objects must start cold')
  const catalogSaves = await transport.publishMany(packed.records.filter(record => record.object.kind === 'catalog'))
  assert(catalogSaves.every(row => !row.hit))
  const inventory = await providerSizes(namespace, [...saves, ...catalogSaves].map(row => row.key))
  output('matrix', input('benchmark-kind') === 'chunk-tuning' ? tuningMatrix(packed.catalogObject.sha256)
    : currentMatrix({ catalogDigest: packed.catalogObject.sha256, whole, scoped }))
  json(path.join(results, 'cwd-producer.json'), { kind: 'cwd-producer', context: context.context, namespace,
    metrics: packed.metrics, fetchMs: fetching.ms, totalMs: performance.now() - started,
    catalog: packed.catalogObject, wholeStoreProviderBytes: inventory.get(objectCacheKey(whole, namespace)).bytes,
    scopedStoreProviderBytes: inventory.get(objectCacheKey(scoped, namespace)).bytes,
    saves: [...saves, ...catalogSaves].map(row => ({ ...row, providerBytes: inventory.get(row.key).bytes })) })
}

async function consume(context, transport, namespace) {
  const scenario = input('scenario', 'sdk'), sample = Number(input('sample', '1'))
  const strategy = input('strategy', 'chunks'); assert(currentStrategies.includes(strategy))
  const started = performance.now(), upfront = [], upfrontStart = performance.now()
  let store = path.join(state, 'cwd-consumer-store'), cache
  if (strategy === 'chunks') {
    const object = { kind: 'catalog', id: catalogId(context.context, targetBytes) }
    const catalogRestore = await transport.restoreOne(object); assert(catalogRestore.hit, 'Expected a warm catalog')
    upfront.push(catalogRestore)
    const filename = path.join(root, cachePath(object)); assert(fs.statSync(filename).size <= MAX_CATALOG_BYTES)
    assert.equal(await fileDigest(filename), input('plan-digest'), 'Catalog digest must match the trusted producer output')
    cache = { catalog: JSON.parse(fs.readFileSync(filename, 'utf8')), stateDirectory: `${store}.chunk-state`,
      archivePath: item => path.join(root, cachePath(item)), restore: transport.restoreMany }
  } else if (strategy !== 'registry') {
    const object = JSON.parse(input('store-object'))
    validateThinPlan({ version: 1, layout: object.layout, objects: [object], query: { mode: strategy } }, { mode: strategy })
    assert.equal(object.kind, strategy)
    store = path.join(root, cachePath(object)); assert(!fs.existsSync(store))
    const restored = await transport.restoreOne(object); assert(restored.hit, 'Expected an exact store cache hit'); upfront.push(restored)
  }
  const upfrontMs = performance.now() - upfrontStart
  if (!['whole', 'scoped'].includes(strategy)) assert(!fs.existsSync(store))
  const steps = [], directories = currentDirectories(scenario), offline = strategy !== 'registry'
  assert(!fs.existsSync(path.join(source, 'sdk/node_modules')))
  for (const [step, importer] of directories.entries()) {
    const measured = await initializeCurrentProject({ cwd: path.join(source, importer), binary: context.binary, store, cache,
      offline, ignoreScripts: true, runInstall: installRunner(offline, `cwd-install-${step}`) })
    assert.deepEqual(measured.filters, [])
    const sdkInitialized = fs.existsSync(path.join(source, 'sdk/node_modules'))
    assert.equal(sdkInitialized, importer === 'sdk', 'Only the requested project should have been initialized')
    const unrelatedInitialized = fs.existsSync(path.join(source, 'packages/release-notes-generator/node_modules'))
    assert(!unrelatedInitialized)
    const first = step === 0
    steps.push({ ...measured, initializationMs: measured.totalMs,
      restoreMs: measured.restoreMs + (first ? upfrontMs : 0), totalMs: measured.totalMs + (first ? upfrontMs : 0),
      requestedObjects: measured.requestedObjects + (first ? upfront.length : 0), sdkInitialized, unrelatedInitialized })
  }
  const totalMs = performance.now() - started
  await verifySdk()
  const all = [...upfront, ...steps.flatMap(step => step.restored)]
  const inventory = all.length ? await providerSizes(namespace, all.map(row => row.key)) : new Map()
  for (const [index, step] of steps.entries()) {
    step.providerBytes = [...step.restored, ...(index === 0 ? upfront : [])].reduce((sum, row) => sum + inventory.get(row.key).bytes, 0)
  }
  const measured = { kind: 'cwd-consumer', scenario, strategy, sample, context: context.context, checkout: context.checkout,
    upfrontRestoreMs: upfrontMs, validationPolicy: strategy === 'chunks' ? 'chunk-and-native' : 'native', registryArchiveBytes: null,
    steps, totalMs, totalProviderBytes: all.reduce((sum, row) => sum + inventory.get(row.key).bytes, 0),
    objects: all.map(row => ({ ...row, providerBytes: inventory.get(row.key).bytes })), moduleLoad: true, offlineInstall: offline }
  json(path.join(results, 'cwd-consumer.json'), measured)
  console.log(JSON.stringify({ scenario, strategy, sample, bytes: measured.totalProviderBytes, totalMs,
    steps: steps.map(step => ({ importer: step.importer, bytes: step.providerBytes, objects: step.requestedObjects, skipped: step.skippedObjects,
      validationMs: step.validationMs, restoreMs: step.restoreMs, hydrateMs: step.hydrateMs, installMs: step.installMs, totalMs: step.totalMs })) }))
}

export async function onDemand(mode, context, transport, namespace) {
  if (mode === 'cwd-cold') await cold(context)
  else if (mode === 'cwd-publish') await publish(context, transport, namespace)
  else if (mode === 'cwd-consume') await consume(context, transport, namespace)
  else throw new Error(`Unknown current-directory benchmark mode: ${mode}`)
}
