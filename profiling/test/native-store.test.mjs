import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Packr } from 'msgpackr'
import { decodeIndexEntry, lockfileGraph, readStore } from '../native-store.mjs'
const digest = (algorithm, value) => createHash(algorithm).update(value).digest('hex')
const envelope = (key, value) => {
  const header = Buffer.alloc(4)
  header.writeUInt32LE(Buffer.byteLength(key))
  return Buffer.concat([header, Buffer.from(key), new Packr({ useRecords: true }).pack(value)])
}
const lock = {
  importers: { '.': {}, app: { dependencies: { alias: { version: 'real@1.0.0(peer@2.0.0)' }, lib: { version: 'link:../packages/lib' } } }, 'packages/lib': {} },
  packages: { 'real@1.0.0': {}, 'peer@2.0.0': {} },
  snapshots: { 'real@1.0.0(peer@2.0.0)': { dependencies: { peer: '2.0.0' } }, 'peer@2.0.0': {}, 'real@1.0.0(peer@3.0.0)': {} },
}
test('native index header and msgpackr records decode and malformed rows fail', () => {
  const bytes = envelope('sha512-xxx\treal@1.0.0', { algo: 'sha512', files: {} })
  assert.equal(decodeIndexEntry(bytes).packageId, 'real@1.0.0')
  assert.equal(decodeIndexEntry(bytes).value.algo, 'sha512')
  assert.throws(() => decodeIndexEntry(Buffer.from([0, 0])), /header/)
  const invalid = Buffer.alloc(4); invalid.writeUInt32LE(999)
  assert.throws(() => decodeIndexEntry(invalid), /key length/)
})
test('graph keeps peer identities, resolves aliases and workspace links, and rejects dangling edges', () => {
  const { graph, packageIds } = lockfileGraph(lock)
  assert.deepEqual(graph['workspace:app'].dependencies, ['real@1.0.0(peer@2.0.0)', 'workspace:packages/lib'])
  assert.deepEqual(graph['real@1.0.0(peer@2.0.0)'].dependencies, ['peer@2.0.0'])
  assert.deepEqual(packageIds['real@1.0.0'], ['real@1.0.0(peer@2.0.0)', 'real@1.0.0(peer@3.0.0)'])
  assert.throws(() => lockfileGraph({ ...lock, snapshots: { 'real@1.0.0': { dependencies: { missing: '9.0.0' } } } }), /Missing lockfile dependency/)
})
test('store inventory verifies CAFS digests, retains executable mode, and assigns all peer owners', () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-real-store-'))
  try {
    const bytes = Buffer.from('real package bytes')
    const hex = digest('sha512', bytes)
    const relative = `v11/files/${hex.slice(0, 2)}/${hex.slice(2)}-exec`
    fs.mkdirSync(path.dirname(path.join(store, relative)), { recursive: true })
    fs.writeFileSync(path.join(store, relative), bytes, { mode: 0o555 })
    const key = 'sha512-xxx\treal@1.0.0'
    const indexHash = digest('sha256', key)
    const index = path.join(store, 'v11/index', indexHash.slice(0, 2), indexHash.slice(2))
    fs.mkdirSync(path.dirname(index), { recursive: true })
    fs.writeFileSync(index, envelope(key, { algo: 'sha512', files: { bin: { digest: hex, size: bytes.length, mode: 0o755 } } }))
    const result = readStore(store, lockfileGraph(lock).packageIds)
    assert.equal(result.files.length, 1)
    assert.equal(result.files[0].mode, 0o555)
    assert.deepEqual(result.filePackages[relative], ['real@1.0.0(peer@2.0.0)', 'real@1.0.0(peer@3.0.0)'])
    fs.chmodSync(path.join(store, relative), 0o755)
    fs.writeFileSync(path.join(store, relative), Buffer.from('wrong'))
    assert.throws(() => readStore(store, lockfileGraph(lock).packageIds), /Content mismatch/)
  } finally { fs.rmSync(store, { recursive: true, force: true }) }
})

test('unsupported file locators and patched package identities fail explicitly', () => {
  for (const id of ['local@file:../local', 'real@1.0.0(patch_hash=abc)']) {
    assert.throws(() => lockfileGraph({ importers: {}, snapshots: { [id]: {} } }), /Unsupported lockfile package identity/)
  }
})
