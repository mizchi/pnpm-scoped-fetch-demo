import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readResults, statistics } from './report-common.mjs'
import { currentDirectories } from './on-demand-cases.mjs'
import { tuningBaseline } from './tuning-cases.mjs'

export function summarizeTuning(rows) {
  const consumers = rows.filter(row => row.kind === 'tuning-consumer'), profiles = rows.filter(row => row.kind === 'profile-consumer')
  assert.equal(consumers.length, 12, 'Expected twelve unprofiled timing samples')
  assert.equal(profiles.length, 2, 'Expected separate baseline and candidate profiles')
  const first = consumers[0]
  for (const row of [...consumers, ...profiles]) {
    assert.deepEqual(row.context, first.context)
    assert.equal(row.workflowRun, first.workflowRun); assert.equal(row.codeSha, first.codeSha)
    assert.equal(row.implementationSha, row.implementation === 'baseline' ? tuningBaseline : row.codeSha)
    assert.equal(row.validationPolicy, 'chunk-and-native'); assert.equal(row.offlineInstall, true); assert.equal(row.moduleLoad, true)
    assert.equal(row.checkout.sparse, true); assert(row.objects.every(object => object.hit))
    assert.equal(row.objects.reduce((sum, object) => sum + object.providerBytes, 0), row.totalProviderBytes)
    assert.deepEqual(row.steps.map(step => step.importer), currentDirectories(row.scenario))
    for (const step of row.steps) {
      assert.equal(step.lockfileUnchanged, true); assert.equal(step.unrelatedInitialized, false); assert.deepEqual(step.filters, [])
    }
  }
  assert.deepEqual(profiles.map(row => row.implementation).sort(), ['baseline', 'candidate'])
  const groups = []
  for (const scenario of ['sdk', 'sequence']) {
    const group = { scenario }
    for (const implementation of ['baseline', 'candidate']) {
      const samples = consumers.filter(row => row.scenario === scenario && row.implementation === implementation).toSorted((a, b) => a.sample - b.sample)
      assert.deepEqual(samples.map(row => row.sample), [1, 2, 3])
      assert(samples.every(row => row.profile === false))
      group[implementation] = { totalMs: statistics(samples.map(row => row.totalMs)), totalProviderBytes: statistics(samples.map(row => row.totalProviderBytes)),
        steps: samples[0].steps.map((step, index) => ({ importer: step.importer,
          ...Object.fromEntries(['validationMs', 'restoreMs', 'hydrateMs', 'installMs', 'totalMs'].map(field => [field, statistics(samples.map(row => row.steps[index][field]))])),
          otherMs: statistics(samples.map(row => { const value = row.steps[index]; return value.totalMs - value.validationMs - value.restoreMs - value.hydrateMs - value.installMs })) })) }
    }
    for (let sample = 1; sample <= 3; sample++) {
      const pair = consumers.filter(row => row.scenario === scenario && row.sample === sample)
      assert.equal(pair.length, 2)
      const keys = row => row.objects.map(object => [object.key, object.providerBytes]).sort(([left], [right]) => left.localeCompare(right))
      assert.deepEqual(keys(pair[0]), keys(pair[1]), 'A/B samples must restore identical remote objects')
    }
    group.timeReductionPercent = 100 * (1 - group.candidate.totalMs.median / group.baseline.totalMs.median)
    groups.push(group)
  }
  return { version: 1, workflowRun: first.workflowRun, codeSha: first.codeSha, context: first.context, baselineSha: tuningBaseline, groups, consumers, profiles }
}

function markdown(summary) {
  const sec = value => (value / 1000).toFixed(2)
  const lines = ['# Chunk cache tuning', '', `Candidate: \`${summary.codeSha}\`. Baseline: \`${summary.baselineSha}\`.`, '',
    'Both implementations restore identical objects from the GitHub Actions cache service. Both retain archive SHA-256, per-file CAFS SHA-512, full content verification on reuse, and native install/session checks. Profiled diagnostic runs are excluded from timing samples. Each implementation/scenario has three fresh runners.', '',
    '| Scenario | Implementation | Total seconds (median; min-max) |', '|---|---|---:|']
  for (const group of summary.groups) for (const implementation of ['baseline', 'candidate']) {
    const total = group[implementation].totalMs
    lines.push(`| ${group.scenario} | ${implementation} | ${sec(total.median)}; ${sec(total.min)}-${sec(total.max)} |`)
  }
  lines.push('', '| Scenario / directory | Implementation | Reuse verification s | Restore s | Hydrate s | Native s | Other s | Step total s |', '|---|---|---:|---:|---:|---:|---:|---:|')
  for (const group of summary.groups) for (const implementation of ['baseline', 'candidate']) for (const step of group[implementation].steps) {
    lines.push(`| ${group.scenario} / ${step.importer} | ${implementation} | ${sec(step.validationMs.median)} | ${sec(step.restoreMs.median)} | ${sec(step.hydrateMs.median)} | ${sec(step.installMs.median)} | ${sec(step.otherMs.median)} | ${sec(step.totalMs.median)} |`)
  }
  lines.push('', 'Restore includes the catalog and SDK outer archive handling. Hydrate includes the inner archive extraction and content verification. Other includes context, workspace selection, and session work. Independent phase medians need not sum to the total median. Setup, checkout, tooling installation, binary download, producer, and diagnostic profiler overhead are excluded. Three samples do not establish p95 performance.', '')
  return lines.join('\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.resolve(process.argv[2] ?? 'measurements')
  const summary = summarizeTuning(readResults(directory, ['tuning-consumer.json', 'profile-consumer.json'])), text = markdown(summary)
  fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n'); fs.writeFileSync(path.join(directory, 'summary.md'), text)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
  console.log(text)
}
