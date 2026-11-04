import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { statistics, readResults } from './report-common.mjs'
import { currentDirectories, currentStrategies, currentScenarios } from './on-demand-cases.mjs'

export function summarizeCurrentProjects(rows) {
  const producer = rows.find(row => row.kind === 'cwd-producer'), cold = rows.find(row => row.kind === 'cwd-cold')
  assert(producer && cold, 'Missing producer or cold measurement')
  const consumers = rows.filter(row => row.kind === 'cwd-consumer')
  assert.equal(consumers.length, 24, 'Expected 24 fresh-runner samples')
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
  for (const strategy of currentStrategies) for (const scenario of currentScenarios) {
    const samples = consumers.filter(row => row.strategy === strategy && row.scenario === scenario).toSorted((left, right) => left.sample - right.sample)
    assert.deepEqual(samples.map(row => row.sample), [1, 2, 3], 'Missing or duplicate sample')
    const expected = currentDirectories(scenario)
    for (const row of samples) validateConsumer(row, strategy, expected)
    const fields = ['providerBytes', 'requestedObjects', 'skippedObjects', 'validationMs', 'restoreMs', 'hydrateMs', 'installMs', 'totalMs', 'otherMs']
    groups.push({ strategy, scenario, samples: samples.length, validationPolicy: samples[0].validationPolicy,
      totalProviderBytes: statistics(samples.map(row => row.totalProviderBytes)), totalMs: statistics(samples.map(row => row.totalMs)),
      steps: expected.map((importer, index) => ({ importer, ...Object.fromEntries(fields.map(field => [field,
        statistics(samples.map(row => field === 'otherMs' ? unassignedTime(row.steps[index]) : row.steps[index][field]))])) })) })
  }
  return { version: 2, workflowRun: producer.workflowRun, codeSha: producer.codeSha, context: producer.context, producer, cold, groups, consumers }
}

function unassignedTime(step) { return step.totalMs - step.validationMs - step.restoreMs - step.hydrateMs - step.installMs }

function validateConsumer(row, strategy, expected) {
  assert.equal(row.offlineInstall, strategy !== 'registry')
  assert.equal(row.validationPolicy, strategy === 'chunks' ? 'chunk-and-native' : 'native')
  assert.equal(row.registryArchiveBytes, null, 'Registry traffic must not be reported as measured')
  assert.deepEqual(row.steps.map(step => step.importer), expected)
  assert.equal(row.objects.reduce((sum, object) => sum + object.providerBytes, 0), row.totalProviderBytes)
  assert(row.objects.every(object => object.hit))
  assert.equal(row.steps.reduce((sum, step) => sum + step.providerBytes, 0), row.totalProviderBytes)
  if (strategy === 'registry') { assert.equal(row.objects.length, 0); assert.equal(row.totalProviderBytes, 0) }
  else assert(row.objects.length > 0 && row.totalProviderBytes > 0)
  for (const step of row.steps) {
    assert.equal(step.lockfileUnchanged, true)
    assert.equal(step.unrelatedInitialized, false)
    assert.equal(step.sdkInitialized, step.importer === 'sdk')
    assert.deepEqual(step.filters, [])
    assert(unassignedTime(step) >= 0, 'Phase timings exceed initialization time')
  }
}

function markdown(summary) {
  const mib = bytes => (bytes / 1048576).toFixed(2), seconds = ms => (ms / 1000).toFixed(2)
  const lines = ['# GitHub cache comparison on Directus', '', `Code: \`${summary.codeSha}\`. ${summary.producer.metrics.projectCount} importers, ${summary.producer.metrics.chunkCount} chunks.`, '',
    'All cache arms publish and restore exact hits through the GitHub Actions cache SDK in this run. Registry is a separate online control; its network bytes are not measured. Every strategy/scenario has three fresh runners. Producer, setup, checkout, tooling installation, and binary download are excluded from consumer times.', '',
    '| Strategy | Scenario | Cache MiB | Total seconds (median; min-max) |', '|---|---|---:|---:|']
  for (const group of summary.groups) lines.push(`| ${group.strategy} | ${group.scenario} | ${group.strategy === 'registry' ? 'n/a' : mib(group.totalProviderBytes.median)} | ${seconds(group.totalMs.median)}; ${seconds(group.totalMs.min)}-${seconds(group.totalMs.max)} |`)
  lines.push('', '| Strategy | Scenario / directory | New cache objects | Cache bytes | Reuse check s | Restore s | Hydrate s | Native install s | Step seconds (median; min-max) |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|')
  for (const group of summary.groups) for (const step of group.steps) lines.push(`| ${group.strategy} | ${group.scenario} / ${step.importer} | ${step.requestedObjects.median} | ${group.strategy === 'registry' ? 'n/a' : step.providerBytes.median} | ${seconds(step.validationMs.median)} | ${seconds(step.restoreMs.median)} | ${seconds(step.hydrateMs.median)} | ${seconds(step.installMs.median)} | ${seconds(step.totalMs.median)}; ${seconds(step.totalMs.min)}-${seconds(step.totalMs.max)} |`)
  lines.push('', 'Upfront catalog/store restore time and bytes are charged to the first step. Restore includes the SDK outer archive download and extraction. Hydrate is inner chunk extraction and verification. Reuse check scans completed chunk markers and verifies their CAFS content. Phase medians are independent and need not sum to the median total.', '',
    'Whole/scoped/registry controls use the normal native content verification policy. Chunk mode additionally verifies archive digests, CAFS identities, and completed payloads on reuse. This measures each implemented path; it does not isolate transport from the extra integrity policy. All paths use the same session guards, native binary, frozen lockfile, scripts-disabled configuration, and sparse source. Cache arms must complete offline. Module loading, untouched projects, and unchanged lockfiles are checked.', '',
    `Producer: full fetch ${seconds(summary.producer.fetchMs)} s, global pack ${seconds(summary.producer.metrics.totalMs)} s, total including both single-store controls ${seconds(summary.producer.totalMs)} s. Cache byte counts use GitHub REST size_in_bytes and include the SDK wrapper. No HTTP control traffic or p95 estimate is included.`, '')
  return lines.join('\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.resolve(process.argv[2] ?? 'measurements'), summary = summarizeCurrentProjects(readResults(directory, ['cwd-cold.json', 'cwd-producer.json', 'cwd-consumer.json'])), text = markdown(summary)
  fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  fs.writeFileSync(path.join(directory, 'summary.md'), text)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
  console.log(text)
}
