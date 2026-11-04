import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeTuning } from '../ci/tuning-report.mjs'
import { tuningMatrix, tuningBaseline } from '../ci/tuning-cases.mjs'

function fixture() {
  const common = { codeSha: 'candidate', workflowRun: 'run', context: { lockfile: 'fixed' } }
  return tuningMatrix('digest').include.map(row => ({ ...common, ...row,
    kind: row.profile ? 'profile-consumer' : 'tuning-consumer', implementationSha: row.implementation === 'baseline' ? tuningBaseline : common.codeSha,
    offlineInstall: true, moduleLoad: true, validationPolicy: 'chunk-and-native', totalProviderBytes: 100,
    objects: [{ key: 'same-cache-key', providerBytes: 100, hit: true }], checkout: { sparse: true },
    totalMs: row.implementation === 'baseline' ? 1000 + row.sample : 700 + row.sample,
    steps: (row.scenario === 'sdk' ? ['sdk'] : ['packages/system-data', 'sdk', 'sdk']).map(importer => ({ importer,
      completedImporters: ['.', 'packages/system-data', 'sdk'], lockfileUnchanged: true, unrelatedInitialized: false, filters: [],
      validationMs: 20, restoreMs: 100, hydrateMs: 200, installMs: 50, totalMs: 600 })) }))
}

test('tuning compares identical cached objects and excludes separate profiler runs', () => {
  const summary = summarizeTuning(fixture())
  assert.equal(summary.groups.length, 2)
  assert.equal(summary.consumers.length, 12)
  assert.equal(summary.profiles.length, 2)
  assert.equal(summary.groups[0].baseline.totalMs.median, 1002)
  assert.equal(summary.groups[0].candidate.totalMs.median, 702)
})

test('tuning refuses changed payloads, changed code, missing samples and weaker validation', () => {
  for (const mutate of [rows => rows.splice(0, 1), rows => { rows[0].objects[0].key = 'another' },
    rows => { rows[0].implementationSha = 'wrong' }, rows => { rows[0].validationPolicy = 'native' },
    rows => { rows[0].offlineInstall = false }, rows => { rows[0].steps[0].lockfileUnchanged = false }]) {
    const rows = fixture(); mutate(rows); assert.throws(() => summarizeTuning(rows))
  }
})
