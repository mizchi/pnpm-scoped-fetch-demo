import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { sha256 } from '../../action/cache-groups.mjs'
import { archiveIndex } from '../index-archive.mjs'
import { restoreTarChunk } from '../tar-zstd.mjs'

test('native index archives roundtrip with only portable index entries', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-index-archive-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const source = path.join(directory, 'source'), target = path.join(directory, 'target')
  const key = Buffer.from('sha512-integrity\tpackage@1.0.0'), hash = sha256(key)
  const relative = `v11/index/${hash.slice(0, 2)}/${hash.slice(2)}`, filename = path.join(source, relative)
  fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.mkdirSync(target)
  const header = Buffer.alloc(4); header.writeUInt32LE(key.length)
  fs.writeFileSync(filename, Buffer.concat([header, key, Buffer.from('index data')]))
  if (process.platform === 'darwin') {
    const xattr = spawnSync('xattr', ['-w', 'com.apple.metadata:test', 'fixture', filename])
    assert.equal(xattr.status, 0)
  }
  const archive = path.join(directory, 'index.tar.zst'), descriptor = archiveIndex({ store: source, paths: ['v11/index'], archive })
  await restoreTarChunk({ chunk: { ...descriptor, kind: 'index', layout: 'v11' }, input: fs.createReadStream(archive), archiveSha256: descriptor.sha256, directory: target })
  assert.deepEqual(fs.readFileSync(path.join(target, relative)), fs.readFileSync(filename))
})
