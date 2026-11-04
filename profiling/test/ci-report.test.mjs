import assert from 'node:assert/strict'
import test from 'node:test'
import { summarize } from '../ci/report.mjs'

function measurements() {
  const context = { version: 1, lockfile: 'lock', configuration: 'config', pnpm: 'binary', node: '24.21.0', arch: 'x64', platform: 'linux' }
  const metadata = { workflowRun: '123', runAttempt: 1, codeSha: 'commit' }
  const rows = [
    { ...metadata, kind: 'cold-sdk', query: { ...context, entry: 'sdk', mode: 'chunks', targetBytes: 67108864 }, checkout: { sparse: true, omittedImporters: ['app', 'api'] }, offlineInstall: true, moduleLoad: true, lockfileUnchanged: true },
    { ...metadata, kind: 'producer', context },
  ]
  for (const [entry, strategy, targetBytes, repetitions] of [['sdk', 'whole', 0, 3], ['sdk', 'scoped', 0, 3], ['sdk', 'chunks', 67108864, 3], ['sdk', 'chunks', 16777216, 3], ['app', 'chunks', 67108864, 1], ['api', 'chunks', 67108864, 1]]) {
    for (let sample = 1; sample <= repetitions; sample++) rows.push({ ...metadata, kind: 'warm-consumer', entry, strategy, targetBytes, sample,
      query: { ...context, entry, mode: strategy, targetBytes }, checkout: { sparse: true, omittedImporters: entry === 'sdk' ? ['app', 'api'] : [] }, offlineInstall: true, moduleLoad: true, lockfileUnchanged: true,
      cacheHits: 2, totalObjects: 2, totalProviderBytes: strategy === 'whole' ? 1000 : 300, planBytes: 500,
      planRestoreMs: 10, dataRestoreWallMs: 20, hydrateMs: 30, installMs: 40, totalMs: sample * 100 })
  }
  return rows
}

test('CI report compares complete independent samples and includes plan transfer', () => {
  const summary = summarize(measurements())
  assert.equal(summary.consumers.length, 14)
  const sdk = summary.groups.find(group => group.entry === 'sdk' && group.targetBytes === 67108864)
  assert.equal(sdk.totalMs.median, 200)
  assert.equal(sdk.totalMs.min, 100)
  assert.equal(sdk.totalMs.max, 300)
  assert.equal(sdk.providerBytesReductionPercent, 70)
  assert.equal(sdk.providerBytesReductionVersusScopedPercent, 0)
})

test('CI report refuses incomplete, failed, or mixed-context measurements', () => {
  assert.throws(() => summarize(measurements().slice(0, -1)), /Missing/)
  const failed = measurements(); failed[2].offlineInstall = false
  assert.throws(() => summarize(failed), /offlineInstall/)
  const mixed = measurements(); mixed[2].query.lockfile = 'other'
  assert.throws(() => summarize(mixed), /context/)
  assert.throws(() => summarize(measurements().filter(row => row.strategy !== 'scoped')), /Missing/)
  const fullCheckout = measurements(); fullCheckout[2].checkout.sparse = false
  assert.throws(() => summarize(fullCheckout), /sparse/)
})
