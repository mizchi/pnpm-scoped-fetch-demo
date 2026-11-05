import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readResults, statistics } from './report-common.mjs'

export const nativeScenarios = ['sdk-initial-preserved', 'sdk-initial-retimed', 'sdk-repeat-frozen',
  'sdk-repeat-unfrozen-control', 'sequence-system-data', 'sequence-sdk-add', 'sequence-sdk-repeat']

export function summarizeNative(records) {
  assert.deepEqual(records.map(record => record.sample).sort(), [1, 2, 3])
  const first = records[0]
  for (const record of records) {
    assert.equal(record.adapter, false); assert.equal(record.restore.hit, true)
    assert.equal(record.codeSha, first.codeSha); assert.deepEqual(record.context, first.context)
    assert.equal(record.restore.key, first.restore.key); assert.equal(record.restore.providerBytes, first.restore.providerBytes)
    assert.deepEqual(record.rows.map(row => row.scenario).sort(), [...nativeScenarios].sort())
    for (const row of record.rows) {
      assert.equal(row.lockfileUnchanged, true); assert.equal(row.moduleLoad, true)
      assert.equal(row.frozen, !row.scenario.includes('unfrozen'))
      assert.equal(row.retimedFiles > 0, row.scenario.includes('retimed'))
      if (row.frozen) assert(row.phases.some(phase => phase.phase === 'create_virtual_store_partition'))
    }
  }
  const groups = nativeScenarios.map(scenario => {
    const rows = records.map(record => record.rows.find(row => row.scenario === scenario))
    const phases = [...new Set(rows.flatMap(row => row.phases.filter(phase => phase.elapsed_ms !== undefined).map(phase => phase.phase)))].sort()
    const slots = rows.flatMap(row => row.phases.filter(phase => phase.phase === 'create_virtual_store_partition').map(phase => phase.total))
    return { scenario, ms: statistics(rows.map(row => row.ms)), newSlots: slots.length ? statistics(slots) : undefined,
      phases: Object.fromEntries(phases.map(name => [name, statistics(rows.flatMap(row => row.phases.filter(phase => phase.phase === name).map(phase => phase.elapsed_ms)))])) }
  })
  return { codeSha: first.codeSha, context: first.context, cache: first.restore, groups, records }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.resolve(process.argv[2] ?? 'measurements'), summary = summarizeNative(readResults(directory, ['native-diagnostics.json']))
  const lines = ['# Native install diagnostics', '', 'Direct native CLI calls after one exact GitHub cache restore. No chunk adapter. Three fresh runners; local filesystem caches are warm. The unfrozen row is a diagnostic with different semantics, not a CI optimization recommendation.', '',
    '| Scenario | Seconds median (min-max) | Newly materialized slots |', '|---|---:|---:|']
  for (const group of summary.groups) lines.push(`| ${group.scenario} | ${(group.ms.median / 1000).toFixed(3)} (${(group.ms.min / 1000).toFixed(3)}-${(group.ms.max / 1000).toFixed(3)}) | ${group.newSlots?.median ?? 'fast path'} |`)
  lines.push('', 'Cache restore, source/store copies, mtime changes, module checks, and strace runs are excluded from native timings. Phase timings can overlap and must not be summed. Re-timed stores contain unchanged bytes. This is a timestamp sensitivity experiment, not evidence that the normal cache restore changes timestamps.', '')
  const markdown = lines.join('\n')
  fs.writeFileSync(path.join(directory, 'native-summary.json'), JSON.stringify(summary, null, 2) + '\n')
  fs.writeFileSync(path.join(directory, 'native-summary.md'), markdown)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
  console.log(markdown)
}
