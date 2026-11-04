import assert from 'node:assert/strict'
import test from 'node:test'
import { constants } from 'node:buffer'
import { encodeChunk } from '../action/cache-groups.mjs'

test('oversized JSON chunks fail with an actionable error before reading payloads', () => {
  let reads = 0
  const chunk = { files: [{ path: 'v11/files/ab/large', size: constants.MAX_STRING_LENGTH, sha256: '0'.repeat(64), mode: 0o444 }] }
  assert.throws(() => encodeChunk(chunk, () => { reads++; throw new Error('Payload read') }), /JSON codec limit.*targetBytes/)
  assert.equal(reads, 0)
})
