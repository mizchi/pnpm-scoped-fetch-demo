import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scenarios } from './scenarios.mjs'

function statistics(values) {
  assert(values.every(value => Number.isFinite(value) && value >= 0), 'Invalid measurement')
  const sorted = values.toSorted((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return { min: sorted[0], median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, max: sorted.at(-1) }
}

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
      samples.push(row)
    }
    const group = { entry, strategy, targetBytes, samples: samples.length }
    for (const field of ['totalProviderBytes', 'planBytes', 'totalObjects', 'planRestoreMs', 'dataRestoreWallMs', 'hydrateMs', 'installMs', 'totalMs']) group[field] = statistics(samples.map(row => row[field]))
    groups.push(group)
  }
  assert.equal(consumers.length, scenarios.reduce((sum, row) => sum + row.repetitions, 0), 'Unexpected consumer samples')
  const baseline = groups[0].totalProviderBytes.median
  const scoped = groups.find(group => group.strategy === 'scoped').totalProviderBytes.median
  for (const group of groups) {
    group.providerBytesReductionPercent = (1 - group.totalProviderBytes.median / baseline) * 100
    if (group.entry === 'sdk') group.providerBytesReductionVersusScopedPercent = (1 - group.totalProviderBytes.median / scoped) * 100
  }
  return { version: 2, workflowRun: producer.workflowRun, codeSha: producer.codeSha, context: producer.context, cold, producer, groups, consumers }
}

function readResults(directory) {
  const rows = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) rows.push(...readResults(filename))
    else if (['cold.json', 'producer.json', 'consumer.json'].includes(entry.name)) rows.push(JSON.parse(fs.readFileSync(filename, 'utf8')))
  }
  return rows
}

function markdown(summary) {
  const mib = bytes => (bytes / 1048576).toFixed(2), seconds = ms => (ms / 1000).toFixed(2)
  const lines = ['# Directus cache benchmark', '', `Code: \`${summary.codeSha}\`. Node: \`${summary.context.node}\`.`, '',
    'Cache bytes are GitHub REST `size_in_bytes`, including the plan and the SDK outer tar/zstd wrapper. Times exclude runner setup, checkout, binary download, and tooling installation. Each sample uses a fresh runner. SDK strategies have three samples; app/API have one.', '',
    '| Scope | Strategy | Samples | Cache MiB | Reduction | Objects | Restore s | Hydrate s | Install s | Total s (median; min–max) |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|']
  for (const group of summary.groups) lines.push(`| ${group.entry} | ${group.strategy === 'whole' ? 'whole store' : group.strategy === 'scoped' ? 'scoped store' : `${group.targetBytes / 1048576} MiB chunks`} | ${group.samples} | ${mib(group.totalProviderBytes.median)} | ${group.providerBytesReductionPercent.toFixed(1)}% | ${group.totalObjects.median} | ${seconds(group.planRestoreMs.median + group.dataRestoreWallMs.median)} | ${seconds(group.hydrateMs.median)} | ${seconds(group.installMs.median)} | ${seconds(group.totalMs.median)}; ${seconds(group.totalMs.min)}–${seconds(group.totalMs.max)} |`)
  lines.push('', `Cold SDK: fetch ${seconds(summary.cold.fetchMs)} s, install ${seconds(summary.cold.installMs)} s, total ${seconds(summary.cold.totalMs)} s.`, '',
    `Producer: full fetch ${seconds(summary.producer.fetchMs)} s, scoped export ${seconds(summary.producer.exportMs)} s, total ${seconds(summary.producer.totalMs)} s.`, '',
    'The immutable public Directus lockfile is trusted for this benchmark (`trustLockfile: true`); install scripts are disabled. Every sample must pass frozen offline install, a module load, and unchanged lockfile checks. Transfer sizes exclude HTTP headers and control requests. Three samples describe this run; they do not establish p95 performance.', '')
  return lines.join('\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.resolve(process.argv[2] ?? 'measurements')
  const summary = summarize(readResults(directory)), text = markdown(summary)
  fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  fs.writeFileSync(path.join(directory, 'summary.md'), text)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
  console.log(text)
}
