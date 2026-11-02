import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { planGroups, selectChunks } from '../action/cache-groups.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
const file = (name, value = name) => ({ path: `v11/files/ab/${name}`, sha256: digest(value), size: value.length, mode: 0o444 })
const shared = file('shared')
const web = file('web')
const admin = file('admin')
const context = { layout: 'v11', platform: 'linux', arch: 'x64', pnpm: 'binary-sha256' }
const inventories = { 'apps/web': [web, shared], 'apps/admin': [shared, admin] }
const plan = (input = inventories, options = {}) => planGroups(input, { context, ...options })
const chunksFor = (manifest, entry) => selectChunks(manifest, [entry]).map(key => manifest.chunks[key])

test('partitions files by their consuming apps and extracts shared content once', () => {
  const manifest = plan()
  assert.equal(Object.keys(manifest.chunks).length, 3)
  assert.deepEqual(chunksFor(manifest, 'apps/web').flatMap(chunk => chunk.files.map(file => file.path)).sort(), [shared.path, web.path].sort())
  const common = Object.values(manifest.chunks).find(chunk => chunk.consumers.length === 2)
  assert.deepEqual(common.consumers, ['apps/admin', 'apps/web'])
  assert.deepEqual(common.files, [shared])
  assert.equal(Object.values(manifest.chunks).flatMap(chunk => chunk.files).length, 3)
})

test('admin content changes preserve web and shared keys', () => {
  const before = plan()
  const after = plan({ ...inventories, 'apps/admin': [shared, file('admin', 'updated admin')] })
  assert.deepEqual(selectChunks(before, ['apps/web']), selectChunks(after, ['apps/web']))
  assert.notDeepEqual(selectChunks(before, ['apps/admin']), selectChunks(after, ['apps/admin']))
})

test('input ordering does not change manifest or content keys', () => {
  assert.deepEqual(plan({ 'apps/admin': [admin, shared], 'apps/web': [shared, web] }), plan())
})

test('combining apps downloads the shared chunk once', () => {
  const manifest = plan()
  assert.equal(selectChunks(manifest, ['apps/web', 'apps/admin', 'apps/web']).length, 3)
})

test('environment and store format changes invalidate chunk keys', () => {
  const before = selectChunks(plan(), ['apps/web'])
  assert.notDeepEqual(selectChunks(plan(inventories, { context: { ...context, arch: 'arm64' } }), ['apps/web']), before)
})

test('rejects conflicting content at an immutable store path', () => {
  assert.throws(() => plan({ ...inventories, 'apps/admin': [file('shared', 'conflict')] }), /Conflicting store file/)
})

test('rejects unknown entries, empty selection, and invalid shard counts', () => {
  assert.throws(() => selectChunks(plan(), ['apps/missing']), /Unknown entry/)
  assert.throws(() => selectChunks(plan(), []), /Select at least one/)
  assert.throws(() => plan(inventories, { shards: 0 }), /shards/)
})

test('accepts only relative store payload paths and valid file descriptors', () => {
  for (const relative of ['../escape', '/tmp/escape', 'v11/index.db', 'v11/files/../escape', 'v11/files/a\\b']) {
    assert.throws(() => plan({ 'apps/web': [{ ...web, path: relative }] }), /Invalid payload path/)
  }
  assert.throws(() => plan({ 'apps/web': [{ ...web, sha256: 'invalid' }] }), /Invalid file descriptor/)
})

test('stable hash shards bound unrelated churn inside a consumer group', () => {
  const manifest = plan({ 'apps/web': Array.from({ length: 64 }, (_, index) => file(`payload-${index}`)) }, { shards: 16 })
  assert(Object.keys(manifest.chunks).length > 1)
  assert(Object.keys(manifest.chunks).length <= 16)
  assert.equal(Object.values(manifest.chunks).flatMap(chunk => chunk.files).length, 64)
  const updated = plan({ 'apps/web': [...Array.from({ length: 64 }, (_, index) => file(`payload-${index}`)), file('new-file')] }, { shards: 16 })
  const unchanged = Object.keys(manifest.chunks).filter(key => Object.hasOwn(updated.chunks, key))
  assert(unchanged.length >= Object.keys(manifest.chunks).length - 1)
})
