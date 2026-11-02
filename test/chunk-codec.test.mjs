import assert from 'node:assert/strict'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { decodeChunk, encodeChunk, sha256 } from '../action/cache-groups.mjs'

const bytes = Buffer.from('cached payload')
const file = { path: 'v11/files/ab/abcdef', size: bytes.length, sha256: sha256(bytes), mode: 0o444 }
const chunk = { files: [file] }
const envelope = files => gzipSync(JSON.stringify({ version: 1, files }))

test('chunk roundtrip verifies payloads and retains executable modes', () => {
  const executable = { ...file, mode: 0o555 }
  const result = decodeChunk({ files: [executable] }, encodeChunk({ files: [executable] }, () => bytes))
  assert.deepEqual(result, [{ ...executable, bytes }])
})

test('rejects corrupted payloads, missing files, unexpected files and paths', () => {
  for (const files of [[], [{ path: file.path, data: Buffer.from('corrupt').toString('base64') }],
    [{ path: '../escape', data: bytes.toString('base64') }],
    [{ path: file.path, data: bytes.toString('base64') }, { path: file.path, data: bytes.toString('base64') }]]) {
    assert.throws(() => decodeChunk(chunk, envelope(files)))
  }
  assert.throws(() => decodeChunk(chunk, Buffer.from('not gzip')))
})

test('producer rejects source content that changed since planning', () => {
  assert.throws(() => encodeChunk(chunk, () => Buffer.from('changed')), /Content mismatch/)
})

test('decompression limits reject oversized envelopes', () => {
  assert.throws(() => decodeChunk(chunk, gzipSync('x'.repeat(1024 * 1024))))
})
