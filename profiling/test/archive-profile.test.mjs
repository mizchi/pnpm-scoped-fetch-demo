import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { sha256 } from '../../action/cache-groups.mjs'
import { profileArchivePolicies } from '../../action/chunk-profile.mjs'
import { archiveMaterializer } from '../archive-materializer.mjs'
import { TAR_ZSTD_CODEC } from '../tar-zstd.mjs'

test('real streaming archives keep unchanged bytes across a dependency update', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-archive-profile-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const sourceFiles = {}, files = []
  for (const name of ['common', 'before', 'after']) {
    const filename = path.join(directory, name), bytes = Buffer.from(`${name} package data`)
    fs.writeFileSync(filename, bytes)
    const file = { path: `v11/files/ab/${sha256(bytes)}`, size: bytes.length, sha256: sha256(bytes), mode: 0o444 }
    files.push(file); sourceFiles[file.path] = filename
  }
  const before = { context: { layout: 'v11' }, inventories: { build: files.slice(0, 2) }, sourceFiles }
  const after = { ...before, inventories: { build: [files[0], files[2]] } }
  const produce = archiveMaterializer(directory), materials = []
  const result = await profileArchivePolicies({ before, after, policies: [{ name: 'atomic', targetBytes: 1 }],
    codec: TAR_ZSTD_CODEC, iterations: 2, materialize: async (...args) => {
      const material = await produce(...args); materials.push(material); return material
    },
  })
  const stats = result.policies[0].entries.build
  assert.equal(stats.newPayloadRequests, 1)
  assert(stats.payloadReusePercent > 0 && stats.payloadReusePercent < 100)
  const common = Object.keys(materials[0].archives).find(key => Object.hasOwn(materials[1].archives, key))
  assert(common)
  assert.equal(materials[0].archives[common].sha256, materials[1].archives[common].sha256)
  assert.deepEqual(fs.readFileSync(materials[0].archives[common].filename), fs.readFileSync(materials[1].archives[common].filename))
})

test('rebinding indexes reuses existing payload archives and rejects missing chunks', async t => {
  const { rebindArchiveMaterial } = await import('../rebind-material.mjs')
  const { planGroups } = await import('../../action/cache-groups.mjs')
  const snapshot = { context: { layout: 'v11' }, inventories: { build: [{ path: 'v11/files/ab/shared', size: 5, sha256: sha256('bytes'), mode: 0o444 }] }, indexes: { build: { size: 10 } } }
  const policy = { name: 'small', targetBytes: 10 }
  const manifest = planGroups(snapshot.inventories, { ...policy, context: snapshot.context })
  const key = Object.keys(manifest.chunks)[0]
  const saved = { codec: TAR_ZSTD_CODEC, policy, manifest, archives: { [key]: { sha256: sha256('archive'), size: 3 } } }
  const rebound = rebindArchiveMaterial({ snapshot, saved, snapshotSha256: '1'.repeat(64) })
  assert.deepEqual(rebound.archives, saved.archives)
  assert.equal(rebound.manifest.entries.build.index.size, 10)
  assert.throws(() => rebindArchiveMaterial({ snapshot, saved: { ...saved, archives: {} }, snapshotSha256: '1'.repeat(64) }), /Missing archive/)
})
