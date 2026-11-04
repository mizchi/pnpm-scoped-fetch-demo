import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scenarios } from './scenarios.mjs'
import { statistics, readResults } from './report-common.mjs'

function sameContext(query, context) {
  for (const [key, value] of Object.entries(context)) assert.equal(query[key], value, `Mixed benchmark context: ${key}`)
}

export function summarize(rows) {
  const producers = rows.filter(row => row.kind === 'producer').toSorted((left, right) => right.runAttempt - left.runAttempt)
  const producer = producers[0]; assert(producer, 'Missing producer measurements')
  const cold = rows.find(row => row.kind === 'cold-sdk'); assert(cold, 'Missing cold measurements')
  const selected = new Map()
  for (const row of rows.filter(row => row.kind === 'warm-consumer')) {
    const key = `${row.entry}/${row.strategy}/${row.targetBytes}/${row.sample}`
    if (!selected.has(key) || row.runAttempt > selected.get(key).runAttempt) selected.set(key, row)
  }
  const consumers = [...selected.values()]
  for (const row of [cold, ...consumers]) {
    sameContext(row.query, producer.context)
    assert.equal(row.workflowRun, producer.workflowRun, 'Mixed workflow runs')
    assert.equal(row.codeSha, producer.codeSha, 'Mixed code revisions')
    assert.equal(row.checkout?.sparse, true, 'Consumer must use a sparse checkout')
    if (row.query.entry === 'sdk') assert(row.checkout.omittedImporters.includes('app') && row.checkout.omittedImporters.includes('api'), 'SDK checkout must omit app and API')
    for (const check of ['offlineInstall', 'moduleLoad', 'lockfileUnchanged']) assert.equal(row[check], true, `Failed ${check}`)
  }
  const groups = []
  for (const { entry, strategy, targetBytes, repetitions } of scenarios) {
    const samples = []
    for (let sample = 1; sample <= repetitions; sample++) {
      const row = selected.get(`${entry}/${strategy}/${targetBytes}/${sample}`)
      assert(row, `Missing sample: ${entry}/${strategy}/${targetBytes}/${sample}`)
      assert.equal(row.cacheHits, row.totalObjects, 'Cache miss in a warm sample')
      assert(row.totalObjects > 0 && row.totalProviderBytes > 0, 'Missing provider measurement')
      assert.equal(row.cacheObjects.length, row.totalObjects, 'Missing cache object measurements')
      assert.equal(row.cacheObjects.reduce((sum, object) => sum + object.providerBytes, 0), row.totalProviderBytes, 'Cache object sizes differ from total')
      samples.push(row)
    }
    const group = { entry, strategy, targetBytes, samples: samples.length }
    for (const field of ['totalProviderBytes', 'planBytes', 'totalObjects', 'planRestoreMs', 'dataRestoreWallMs', 'hydrateMs', 'installMs', 'totalMs']) group[field] = statistics(samples.map(row => row[field]))
    groups.push(group)
  }
  assert.equal(consumers.length, scenarios.reduce((sum, row) => sum + row.repetitions, 0), 'Unexpected consumer samples')
  const baseline = groups[0].totalProviderBytes.median
  const scoped = new Map(groups.filter(group => group.strategy === 'scoped').map(group => [group.entry, group]))
  for (const group of groups) {
    group.providerBytesReductionPercent = (1 - group.totalProviderBytes.median / baseline) * 100
    group.providerBytesReductionVersusScopedPercent = (1 - group.totalProviderBytes.median / scoped.get(group.entry).totalProviderBytes.median) * 100
  }
  const representatives = consumers.filter(row => row.sample === 1 && (row.strategy === 'scoped' || row.strategy === 'chunks' && row.targetBytes === 67108864))
  const chunks = representatives.filter(row => row.strategy === 'chunks'), unique = new Map()
  for (const object of chunks.flatMap(row => row.cacheObjects)) {
    if (unique.has(object.key)) assert.equal(unique.get(object.key), object.providerBytes, 'Conflicting shared object sizes')
    unique.set(object.key, object.providerBytes)
  }
  const storageComparison = { scopedStoresBytes: representatives.filter(row => row.strategy === 'scoped').reduce((sum, row) => sum + row.totalProviderBytes, 0),
    chunkedReferenceBytes: chunks.reduce((sum, row) => sum + row.totalProviderBytes, 0),
    chunkedUniqueBytes: [...unique.values()].reduce((sum, bytes) => sum + bytes, 0), chunkedUniqueObjects: unique.size }
  storageComparison.reductionVersusScopedStoresPercent = (1 - storageComparison.chunkedUniqueBytes / storageComparison.scopedStoresBytes) * 100
  return { version: 3, workflowRun: producer.workflowRun, codeSha: producer.codeSha, context: producer.context, cold, producer, groups, storageComparison, consumers }
}

function markdown(summary) {
  const mib = bytes => (bytes / 1048576).toFixed(2), seconds = ms => (ms / 1000).toFixed(2)
  const lines = ['# Directus cache benchmark', '', `Code: \`${summary.codeSha}\`. Node: \`${summary.context.node}\`.`, '',
    'Cache bytes are GitHub REST `size_in_bytes`, including the plan and the SDK outer tar/zstd wrapper. Times exclude runner setup, checkout, binary download, and tooling installation. Each sample uses a fresh runner and a sparse checkout. Store baselines and SDK chunk strategies have three samples; app/API chunk strategies have one.', '',
    '| Scope | Strategy | Samples | Cache MiB | Reduction | Objects | Restore s | Hydrate s | Install s | Total s (median; min–max) |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|']
  for (const group of summary.groups) lines.push(`| ${group.entry} | ${group.strategy === 'whole' ? 'whole store' : group.strategy === 'scoped' ? 'scoped store' : `${group.targetBytes / 1048576} MiB chunks`} | ${group.samples} | ${mib(group.totalProviderBytes.median)} | ${group.providerBytesReductionPercent.toFixed(1)}% | ${group.totalObjects.median} | ${seconds(group.planRestoreMs.median + group.dataRestoreWallMs.median)} | ${seconds(group.hydrateMs.median)} | ${seconds(group.installMs.median)} | ${seconds(group.totalMs.median)}; ${seconds(group.totalMs.min)}–${seconds(group.totalMs.max)} |`)
  lines.push('', `Cold SDK: fetch ${seconds(summary.cold.fetchMs)} s, install ${seconds(summary.cold.installMs)} s, total ${seconds(summary.cold.totalMs)} s.`, '',
    `Combined storage for app/API/SDK: independent scoped stores ${mib(summary.storageComparison.scopedStoresBytes)} MiB; unique 64 MiB chunk objects ${mib(summary.storageComparison.chunkedUniqueBytes)} MiB (${summary.storageComparison.reductionVersusScopedStoresPercent.toFixed(1)}% less). This storage saving does not remove downloads to fresh runners.`, '',
    `Producer: full fetch ${seconds(summary.producer.fetchMs)} s, scoped export ${seconds(summary.producer.exportMs)} s, total ${seconds(summary.producer.totalMs)} s.`, '',
    'The immutable public Directus lockfile is trusted for this benchmark (`trustLockfile: true`); install scripts are disabled. Every sample must pass frozen offline install, a module load, and unchanged lockfile checks. Transfer sizes exclude HTTP headers and control requests. Three samples describe this run; they do not establish p95 performance.', '')
  return lines.join('\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.resolve(process.argv[2] ?? 'measurements')
  const summary = summarize(readResults(directory, ['cold.json', 'producer.json', 'consumer.json'])), text = markdown(summary)
  fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  fs.writeFileSync(path.join(directory, 'summary.md'), text)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
  console.log(text)
}
