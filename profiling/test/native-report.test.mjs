import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeNative, nativeScenarios } from '../ci/native-report.mjs'

function fixture() {
  return [1, 2, 3].map(sample => ({ sample, codeSha: 'candidate', context: { lockfile: 'wanted' }, adapter: false,
    restore: { hit: true, key: 'same-cache', providerBytes: 100 },
    rows: nativeScenarios.map(scenario => ({ scenario, ms: 100 * sample, frozen: !scenario.includes('unfrozen'),
      lockfileUnchanged: true, moduleLoad: true, retimedFiles: scenario.includes('retimed') ? 20 : 0,
      phases: scenario.includes('unfrozen') ? [] : [{ phase: 'create_virtual_store_partition', warm: scenario.includes('repeat') ? 0 : 3, cold: 0, skipped: 3, total: scenario.includes('repeat') ? 0 : 3 }] })) }))
}

test('native timing separates frozen no-ops, timestamp churn, and the unfrozen diagnostic control', () => {
  const summary = summarizeNative(fixture())
  assert.equal(summary.groups.length, nativeScenarios.length)
  assert.deepEqual(summary.groups[0].ms, { min: 100, median: 200, max: 300 })
  assert.equal(summary.groups.find(group => group.scenario === 'sdk-repeat-frozen').newSlots.median, 0)
})

test('native reporting refuses missing trials, cache misses, changed input, and incomplete observations', () => {
  for (const change of [rows => rows.pop(), rows => { rows[0].restore.hit = false },
    rows => { rows[1].context.lockfile = 'other' }, rows => { rows[0].rows[0].lockfileUnchanged = false },
    rows => { rows[0].rows[0].moduleLoad = false }, rows => { rows[0].rows[1].retimedFiles = 0 },
    rows => { rows[0].rows[0].phases = [] }]) {
    const rows = fixture(); change(rows)
    assert.throws(() => summarizeNative(rows))
  }
})
