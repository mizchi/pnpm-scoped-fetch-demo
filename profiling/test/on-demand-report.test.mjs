import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeCurrentProjects } from '../ci/on-demand-report.mjs'

function fixture() {
  const common = { workflowRun: '123', codeSha: 'abc', context: { pnpm: 'native', lockfile: 'lock' } }
  const checkout = { sparse: true, omittedImporters: ['app', 'api'] }
  const producer = { ...common, kind: 'cwd-producer', metrics: { projectCount: 41, projects: { sdk: { fingerprint: 'sdk' } } } }
  const cold = { ...common, kind: 'cwd-cold', checkout, moduleLoad: true, fingerprint: 'sdk', measured: { filters: [], lockfileUnchanged: true } }
  const rows = [producer, cold]
  for (const strategy of ['whole', 'scoped', 'chunks', 'registry']) for (const scenario of ['sdk', 'sequence']) for (let sample = 1; sample <= 3; sample++) {
    const importers = scenario === 'sdk' ? ['sdk'] : ['packages/system-data', 'sdk', 'sdk']
    const steps = importers.map((importer, index) => ({ importer, filters: [], lockfileUnchanged: true, unrelatedInitialized: false,
      sdkInitialized: importer === 'sdk', providerBytes: index || strategy === 'registry' ? 0 : 110,
      requestedObjects: index || strategy === 'registry' ? 0 : 10, skippedObjects: index ? 10 : 0,
      validationMs: strategy === 'chunks' ? 5 : 0, restoreMs: 10, hydrateMs: 20, installMs: 30, totalMs: 100 + sample }))
    rows.push({ ...common, kind: 'cwd-consumer', scenario, strategy, sample, checkout, steps, moduleLoad: true, offlineInstall: strategy !== 'registry',
      validationPolicy: strategy === 'chunks' ? 'chunk-and-native' : 'native', registryArchiveBytes: null,
      objects: strategy === 'registry' ? [] : [{ hit: true, providerBytes: 110 }], totalProviderBytes: strategy === 'registry' ? 0 : 110, totalMs: 200 + sample })
  }
  return rows
}

test('current-project reporting retains incremental transfer and fresh-runner sample ranges', () => {
  const summary = summarizeCurrentProjects(fixture())
  assert.equal(summary.version, 2)
  assert.equal(summary.groups.length, 8)
  assert.equal(summary.groups[0].totalMs.median, 202)
  assert.equal(summary.groups[1].steps[1].providerBytes.median, 0)
  assert.equal(summary.groups[1].steps[2].skippedObjects.median, 10)
  assert.equal(summary.groups.find(row => row.strategy === 'registry' && row.scenario === 'sdk').totalProviderBytes.median, 0)
})

test('current-project reporting rejects incomplete, mixed, failed, or inconsistent evidence', () => {
  for (const mutate of [rows => rows.pop(), rows => { rows[2].context = {} }, rows => { rows[2].offlineInstall = false },
    rows => { rows[2].steps[0].lockfileUnchanged = false }, rows => { rows[2].objects[0].providerBytes++ },
    rows => { rows[2].steps[0].filters = ['sdk'] }, rows => { rows[2].steps[0].unrelatedInitialized = true }]) {
    const rows = fixture(); mutate(rows); assert.throws(() => summarizeCurrentProjects(rows))
  }
})
