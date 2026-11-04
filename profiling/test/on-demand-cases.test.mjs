import assert from 'node:assert/strict'
import test from 'node:test'
import { currentMatrix, currentDirectories } from '../ci/on-demand-cases.mjs'

test('the service comparison includes each strategy and scenario on three independent runners', () => {
  const whole = { kind: 'whole', id: 'a'.repeat(64) }, scoped = { kind: 'scoped', id: 'b'.repeat(64) }
  const { include } = currentMatrix({ catalogDigest: 'c'.repeat(64), whole, scoped })
  assert.equal(include.length, 24)
  assert.equal(new Set(include.map(row => row.label)).size, 24)
  for (const scenario of ['sdk', 'sequence']) for (const strategy of ['whole', 'scoped', 'chunks', 'registry']) {
    assert.deepEqual(include.filter(row => row.scenario === scenario && row.strategy === strategy).map(row => row.sample), [1, 2, 3])
  }
  assert.deepEqual(JSON.parse(include.find(row => row.strategy === 'whole').storeObject), whole)
  assert.equal(include.find(row => row.strategy === 'chunks').storeObject, '')
  assert.deepEqual(currentDirectories('sequence'), ['packages/system-data', 'sdk', 'sdk'])
  assert.throws(() => currentDirectories('unknown'), /Unknown/)
})
