import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { zstdCompressSync } from 'node:zlib'
import test from 'node:test'
import tar from 'tar-stream'
import { sha256 } from '../../action/cache-groups.mjs'
import { writeTarChunk, verifyTarChunk, restoreTarChunk } from '../tar-zstd.mjs'

const payloads = { 'v11/files/ab/plain': Buffer.from('plain bytes'), ['v11/files/cd/' + 'e'.repeat(126) + '-exec']: Buffer.from('executable bytes') }
const chunk = { files: Object.entries(payloads).map(([name, bytes]) => ({ path: name, size: bytes.length, sha256: sha256(bytes), mode: name.endsWith('-exec') ? 0o555 : 0o444 })) }
const source = relative => Readable.from([payloads[relative].subarray(0, 2), payloads[relative].subarray(2)])
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-tar-zstd-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
async function malicious(entries) {
  const pack = tar.pack()
  const buffers = []
  const reading = (async () => { for await (const bytes of pack) buffers.push(bytes) })()
  for (const entry of entries) pack.entry({ name: chunk.files[0].path, mode: 0o444, mtime: new Date(0), type: 'file', ...entry.header }, entry.bytes ?? payloads[chunk.files[0].path])
  pack.finalize(); await reading
  return zstdCompressSync(Buffer.concat(buffers))
}

test('tar/zstd output is deterministic, streams sources, and restores normalized modes', async t => {
  const directory = temporary(t)
  const first = path.join(directory, 'one.tar.zst'), second = path.join(directory, 'two.tar.zst')
  const descriptor = await writeTarChunk({ chunk, source, filename: first })
  await writeTarChunk({ chunk: { files: [...chunk.files].reverse() }, source, filename: second })
  assert.deepEqual(fs.readFileSync(first), fs.readFileSync(second))
  assert.equal(descriptor.size, fs.statSync(first).size)
  assert.equal(descriptor.sha256, sha256(fs.readFileSync(first)))
  assert.match(descriptor.key, /^pnpm-tar-zstd-v1-/)
  await verifyTarChunk({ chunk, input: fs.createReadStream(first), archiveSha256: descriptor.sha256 })
  const store = path.join(directory, 'store'); fs.mkdirSync(store)
  await restoreTarChunk({ chunk, input: fs.createReadStream(first), archiveSha256: descriptor.sha256, directory: store })
  for (const file of chunk.files) {
    assert.deepEqual(fs.readFileSync(path.join(store, file.path)), payloads[file.path])
    assert.equal(fs.statSync(path.join(store, file.path)).mode & 0o777, file.mode)
  }
})

test('wrong source content fails and never publishes an archive', async t => {
  const filename = path.join(temporary(t), 'wrong.tar.zst')
  await assert.rejects(writeTarChunk({ chunk, source: () => Readable.from([Buffer.alloc(11)]), filename }), /Content mismatch/)
  assert(!fs.existsSync(filename))
})

test('unexpected, duplicate, unsafe, linked, missing and corrupt entries commit no files', async t => {
  const directory = temporary(t)
  const one = { files: [chunk.files[0]] }
  const valid = { bytes: payloads[one.files[0].path] }
  const cases = [
    [valid, valid], [{ header: { name: '../escape' } }], [{ header: { name: 'v11/files/ab/unexpected' } }],
    [{ header: { type: 'symlink', linkname: '/tmp/escape' }, bytes: Buffer.alloc(0) }],
    [{ header: { mode: 0o777 } }], [{ bytes: Buffer.from('wrong bytes') }], [],
  ]
  for (let index = 0; index < cases.length; index++) {
    const store = path.join(directory, String(index)); fs.mkdirSync(store)
    const archive = await malicious(cases[index])
    await assert.rejects(restoreTarChunk({ chunk: one, input: Readable.from([archive]), archiveSha256: sha256(archive), directory: store }))
    assert.deepEqual(fs.readdirSync(store), [])
  }
})

test('archive digest and truncation are checked before staged files are committed', async t => {
  const directory = temporary(t)
  const bytes = await malicious([{}])
  for (const [index, archive, hash] of [[0, bytes, '0'.repeat(64)], [1, bytes.subarray(0, -4), sha256(bytes.subarray(0, -4))]]) {
    const store = path.join(directory, String(index)); fs.mkdirSync(store)
    await assert.rejects(restoreTarChunk({ chunk: { files: [chunk.files[0]] }, input: Readable.from([archive]), archiveSha256: hash, directory: store }))
    assert.deepEqual(fs.readdirSync(store), [])
  }
})

test('existing symlink parents and files cannot redirect or overwrite restoration', async t => {
  const directory = temporary(t)
  const archive = await malicious([{}])
  const outside = path.join(directory, 'outside'); fs.mkdirSync(outside)
  const store = path.join(directory, 'store'); fs.mkdirSync(store)
  fs.symlinkSync(outside, path.join(store, 'v11'))
  await assert.rejects(restoreTarChunk({ chunk: { files: [chunk.files[0]] }, input: Readable.from([archive]), archiveSha256: sha256(archive), directory: store }), /directory/)
  assert.deepEqual(fs.readdirSync(outside), [])
  fs.unlinkSync(path.join(store, 'v11'))
  const target = path.join(store, chunk.files[0].path)
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'existing')
  await assert.rejects(restoreTarChunk({ chunk: { files: [chunk.files[0]] }, input: Readable.from([archive]), archiveSha256: sha256(archive), directory: store }), /EEXIST/)
  assert.equal(fs.readFileSync(target, 'utf8'), 'existing')
})

test('archive bytes do not depend on source stream fragmentation', async t => {
  const directory = temporary(t)
  const bytes = Buffer.from(Array.from({ length: 40000 }, (_, index) => `export const value${index} = ${index}; // repeated package content\n`).join(''))
  const file = { path: 'v11/files/ab/fragmented', size: bytes.length, sha256: sha256(bytes), mode: 0o444 }
  const outputs = []
  for (const size of [2048, 65536, 310003]) {
    const filename = path.join(directory, `chunk-${size}`)
    await writeTarChunk({ chunk: { files: [file] }, filename,
      source: () => Readable.from((function* () { for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size) })()) })
    outputs.push(fs.readFileSync(filename))
  }
  assert.deepEqual(outputs[0], outputs[1])
  assert.deepEqual(outputs[0], outputs[2])
})

test('a compressed frame cannot request an excessive decompression window', async t => {
  const filename = path.join(temporary(t), 'window.tar.zst')
  await writeTarChunk({ chunk, source, filename })
  const archive = fs.readFileSync(filename)
  assert.equal(archive[4], 0)
  archive[5] = 0x88
  await assert.rejects(verifyTarChunk({ chunk, input: Readable.from([archive]), archiveSha256: sha256(archive) }), /window|memory/i)
})

test('a thin descriptor restores CAFS by its SHA-512 filename and normalizes timestamps', async t => {
  const { createHash } = await import('node:crypto')
  const directory = temporary(t), bytes = Buffer.from('native content-addressed bytes')
  const hex = createHash('sha512').update(bytes).digest('hex')
  const file = { path: `v11/files/${hex.slice(0, 2)}/${hex.slice(2)}`, sha256: sha256(bytes), size: bytes.length, mode: 0o444 }
  const filename = path.join(directory, 'thin.tar.zst')
  const descriptor = await writeTarChunk({ chunk: { files: [file] }, source: () => Readable.from([bytes]), filename })
  const store = path.join(directory, 'store'); fs.mkdirSync(store)
  await restoreTarChunk({ chunk: { kind: 'cafs', layout: 'v11', rawBytes: bytes.length, fileCount: 1 },
    input: fs.createReadStream(filename), archiveSha256: descriptor.sha256, directory: store })
  assert.deepEqual(fs.readFileSync(path.join(store, file.path)), bytes)
  assert.equal(fs.statSync(path.join(store, file.path)).mtimeMs, 0)
  const badStore = path.join(directory, 'bad'); fs.mkdirSync(badStore)
  await assert.rejects(restoreTarChunk({ chunk: { kind: 'cafs', layout: 'v11', rawBytes: bytes.length + 1, fileCount: 1 },
    input: fs.createReadStream(filename), archiveSha256: descriptor.sha256, directory: badStore }), /size|bounds/)
  assert.deepEqual(fs.readdirSync(badStore), [])
})

test('index archives validate row identities and reject metadata path escapes', async t => {
  const directory = temporary(t), key = 'sha512-package\tpackage@1.0.0', hash = sha256(key)
  const name = `v11/index/${hash.slice(0, 2)}/${hash.slice(2)}`
  const header = Buffer.alloc(4); header.writeUInt32LE(Buffer.byteLength(key))
  const row = Buffer.concat([header, Buffer.from(key), Buffer.from('msgpack bytes')])
  for (const [label, entryName, good] of [['valid', name, true], ['wrong', name.slice(0, -1) + 'f', false], ['escape', '../outside', false]]) {
    const store = path.join(directory, label); fs.mkdirSync(store)
    const bytes = await malicious([{ header: { name: entryName, mode: 0o644 }, bytes: row }])
    const restoring = restoreTarChunk({ chunk: { kind: 'index', layout: 'v11', tarBytes: 10240 },
      input: Readable.from([bytes]), archiveSha256: sha256(bytes), directory: store })
    if (good) { await restoring; assert.deepEqual(fs.readFileSync(path.join(store, name)), row) }
    else { await assert.rejects(restoring); assert.deepEqual(fs.readdirSync(store), []) }
  }
})
