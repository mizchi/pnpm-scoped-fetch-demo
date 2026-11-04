import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { canonicalJson, sha256 } from '../../action/chunk-identity.mjs'
import { cachePath, objectCacheKey } from '../../action/cache-plan.mjs'
import { catalogId, MAX_CATALOG_BYTES } from '../../action/project-catalog.mjs'
import { fileDigest } from '../github-cache.mjs'
import { initializeCurrentProject } from '../initialize-current.mjs'
import { lockfileGraph, readStore } from '../native-store.mjs'
import { packProjects } from '../pack-projects.mjs'
import { stageStore } from '../store-staging.mjs'
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
  const whole = { kind: 'whole', id: sha256(canonicalJson({ context: context.context, index: packed.catalog.index.id,
    files: packed.full.files })), fileCount: packed.full.files.length, rawBytes: packed.metrics.rawBytes }
  const wholeDirectory = stageStore({ directory: path.join(root, cachePath(whole)), layout: packed.full.layout,
    files: packed.full.files, sourceFiles: packed.full.sourceFiles, indexDirectory: store })
  const records = packed.records.filter(record => record.object.kind !== 'catalog')
  const saves = await transport.publishMany([...records, { object: whole, source: wholeDirectory }])
  assert(saves.every(row => !row.hit), 'Run-specific objects must start cold')
  const catalogSaves = await transport.publishMany(packed.records.filter(record => record.object.kind === 'catalog'))
  assert(catalogSaves.every(row => !row.hit))
  const inventory = await providerSizes(namespace, [...saves, ...catalogSaves].map(row => row.key))
  const matrix = []
  for (const scenario of ['sdk', 'sequence']) for (let sample = 1; sample <= 3; sample++) {
    matrix.push({ label: `cwd-${scenario}-${sample}`, scenario, sample, digest: packed.catalogObject.sha256 })
  }
  output('matrix', { include: matrix })
  json(path.join(results, 'cwd-producer.json'), { kind: 'cwd-producer', context: context.context, namespace,
    metrics: packed.metrics, fetchMs: fetching.ms, totalMs: performance.now() - started,
    catalog: packed.catalogObject, wholeStoreProviderBytes: inventory.get(objectCacheKey(whole, namespace)).bytes,
    saves: [...saves, ...catalogSaves].map(row => ({ ...row, providerBytes: inventory.get(row.key).bytes })) })
}

async function consume(context, transport, namespace) {
  const scenario = input('scenario', 'sdk'), sample = Number(input('sample', '1'))
  assert(['sdk', 'sequence'].includes(scenario))
  const started = performance.now(), object = { kind: 'catalog', id: catalogId(context.context, targetBytes) }
  const catalogRestore = await transport.restoreOne(object)
  assert(catalogRestore.hit, 'Expected a warm catalog')
  const filename = path.join(root, cachePath(object))
  assert(fs.statSync(filename).size <= MAX_CATALOG_BYTES)
  assert.equal(await fileDigest(filename), input('plan-digest'), 'Catalog digest must match the trusted producer output')
  const catalog = JSON.parse(fs.readFileSync(filename, 'utf8')), store = path.join(state, 'cwd-consumer-store')
  const cache = { catalog, stateDirectory: `${store}.chunk-state`, archivePath: item => path.join(root, cachePath(item)), restore: transport.restoreMany }
  const steps = [], directories = scenario === 'sdk' ? ['sdk'] : ['packages/system-data', 'sdk', 'sdk']
  assert(!fs.existsSync(store))
  assert(!fs.existsSync(path.join(source, 'sdk/node_modules')))
  for (const [step, importer] of directories.entries()) {
    const measured = await initializeCurrentProject({ cwd: path.join(source, importer), binary: context.binary, store, cache,
      offline: true, ignoreScripts: true, runInstall: installRunner(true, `cwd-install-${step}`) })
    assert.deepEqual(measured.filters, [])
    const sdkInitialized = fs.existsSync(path.join(source, 'sdk/node_modules'))
    assert.equal(sdkInitialized, importer === 'sdk', 'Only the requested project should have been initialized')
    const unrelatedInitialized = fs.existsSync(path.join(source, 'packages/release-notes-generator/node_modules'))
    assert(!unrelatedInitialized)
    steps.push({ ...measured, sdkInitialized, unrelatedInitialized })
  }
  const totalMs = performance.now() - started
  await verifySdk()
  const all = [catalogRestore, ...steps.flatMap(step => step.restored)], inventory = await providerSizes(namespace, all.map(row => row.key))
  for (const step of steps) step.providerBytes = step.restored.reduce((sum, row) => sum + inventory.get(row.key).bytes, 0)
  const measured = { kind: 'cwd-consumer', scenario, sample, context: context.context, checkout: context.checkout,
    catalogBytes: fs.statSync(filename).size, catalogProviderBytes: inventory.get(catalogRestore.key).bytes,
    steps, totalMs, totalProviderBytes: all.reduce((sum, row) => sum + inventory.get(row.key).bytes, 0),
    objects: all.map(row => ({ ...row, providerBytes: inventory.get(row.key).bytes })), moduleLoad: true, offlineInstall: true }
  json(path.join(results, 'cwd-consumer.json'), measured)
  console.log(JSON.stringify({ scenario, sample, bytes: measured.totalProviderBytes, totalMs,
    steps: steps.map(step => ({ importer: step.importer, bytes: step.providerBytes, objects: step.requestedObjects, skipped: step.skippedObjects })) }))
}

export async function onDemand(mode, context, transport, namespace) {
  if (mode === 'cwd-cold') await cold(context)
  else if (mode === 'cwd-publish') await publish(context, transport, namespace)
  else if (mode === 'cwd-consume') await consume(context, transport, namespace)
  else throw new Error(`Unknown current-directory benchmark mode: ${mode}`)
}
