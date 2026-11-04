import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { statistics, readResults } from './report-common.mjs'

export function summarizeCurrentProjects(rows) {
  const producer = rows.find(row => row.kind === 'cwd-producer'), cold = rows.find(row => row.kind === 'cwd-cold')
  assert(producer && cold, 'Missing producer or cold measurement')
  const consumers = rows.filter(row => row.kind === 'cwd-consumer')
  assert.equal(consumers.length, 6, 'Expected six fresh-runner samples')
  for (const row of [cold, ...consumers]) {
    assert.deepEqual(row.context, producer.context, 'Mixed runtime context')
    for (const key of ['workflowRun', 'codeSha']) assert.equal(row[key], producer[key], `Mixed ${key}`)
    assert.equal(row.checkout?.sparse, true)
    assert(row.checkout.omittedImporters.includes('app') && row.checkout.omittedImporters.includes('api'))
    assert.equal(row.moduleLoad, true)
  }
  assert.equal(producer.metrics.projects.sdk.fingerprint, cold.fingerprint)
  assert(producer.metrics.projectCount > 3, 'Catalog must discover the whole workspace')
  assert.deepEqual(cold.measured.filters, [])
  assert.equal(cold.measured.lockfileUnchanged, true)
  const groups = []
  for (const scenario of ['sdk', 'sequence']) {
    const samples = consumers.filter(row => row.scenario === scenario).toSorted((left, right) => left.sample - right.sample)
    assert.deepEqual(samples.map(row => row.sample), [1, 2, 3], 'Missing or duplicate sample')
    const expected = scenario === 'sdk' ? ['sdk'] : ['packages/system-data', 'sdk', 'sdk']
    for (const row of samples) {
      assert.equal(row.offlineInstall, true)
      assert.deepEqual(row.steps.map(step => step.importer), expected)
      assert.equal(row.objects.reduce((sum, object) => sum + object.providerBytes, 0), row.totalProviderBytes)
      assert(row.objects.every(object => object.hit))
      assert.equal(row.catalogProviderBytes + row.steps.reduce((sum, step) => sum + step.providerBytes, 0), row.totalProviderBytes)
      for (const step of row.steps) {
        assert.equal(step.lockfileUnchanged, true)
        assert.equal(step.unrelatedInitialized, false)
        assert.equal(step.sdkInitialized, step.importer === 'sdk')
        assert.deepEqual(step.filters, [])
      }
    }
    groups.push({ scenario, samples: samples.length, totalProviderBytes: statistics(samples.map(row => row.totalProviderBytes)),
      totalMs: statistics(samples.map(row => row.totalMs)), steps: expected.map((importer, index) => ({ importer,
        providerBytes: statistics(samples.map(row => row.steps[index].providerBytes)),
        requestedObjects: statistics(samples.map(row => row.steps[index].requestedObjects)),
        skippedObjects: statistics(samples.map(row => row.steps[index].skippedObjects)),
        totalMs: statistics(samples.map(row => row.steps[index].totalMs)) })) })
  }
  return { version: 1, workflowRun: producer.workflowRun, codeSha: producer.codeSha, context: producer.context, producer, cold, groups, consumers }
}

function markdown(summary) {
  const mib = bytes => (bytes / 1048576).toFixed(2), seconds = ms => (ms / 1000).toFixed(2)
  const sdk = summary.groups.find(group => group.scenario === 'sdk')
  const lines = ['# Current-directory initialization', '', `Code: \`${summary.codeSha}\`. Catalog: ${summary.producer.metrics.projectCount} discovered importers, ${summary.producer.metrics.chunkCount} chunks, ${summary.producer.metrics.catalogBytes} JSON bytes.`, '',
    `Fresh SDK initialization downloads ${mib(sdk.totalProviderBytes.median)} MiB including catalog and index. The full-store cache archive is ${mib(summary.producer.wholeStoreProviderBytes)} MiB (${(100 * (1 - sdk.totalProviderBytes.median / summary.producer.wholeStoreProviderBytes)).toFixed(1)}% fewer archive bytes). The full-store number is a byte-only control, without a timed restore in this experiment.`, '',
    '| Scenario | Directory | New objects | Reused objects | Extra archive bytes | Init seconds (median; min–max) |',
    '|---|---|---:|---:|---:|---:|']
  for (const group of summary.groups) for (const step of group.steps) lines.push(`| ${group.scenario} | ${step.importer} | ${step.requestedObjects.median} | ${step.skippedObjects.median} | ${step.providerBytes.median} | ${seconds(step.totalMs.median)}; ${seconds(step.totalMs.min)}–${seconds(step.totalMs.max)} |`)
  lines.push('', `Each scenario has three fresh runners. Catalog download is counted once per runner. Cold SDK current-directory initialization: ${seconds(summary.cold.measured.totalMs)} seconds. The initial global index is ${mib(summary.producer.metrics.globalIndexBytes)} MiB before the SDK cache wrapper.`, '',
    'All consumers use sparse checkouts, a dedicated empty store, frozen offline install without filters, and recursiveInstall=false. SDK module loading and unchanged lockfiles are checked. The sequence retains its store between directories. Setup, checkout, tooling installation, and binary download are excluded. Cache bytes come from GitHub REST size_in_bytes; HTTP control traffic is excluded. This adapter currently targets registry packages in the pinned v9 lockfile, trusts that lockfile, uses a files index, and disables install scripts.', '')
  return lines.join('\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.resolve(process.argv[2] ?? 'measurements'), summary = summarizeCurrentProjects(readResults(directory, ['cwd-cold.json', 'cwd-producer.json', 'cwd-consumer.json'])), text = markdown(summary)
  fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  fs.writeFileSync(path.join(directory, 'summary.md'), text)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
  console.log(text)
}
