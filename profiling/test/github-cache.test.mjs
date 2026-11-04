import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { sha256 } from '../../action/cache-groups.mjs'
import { cachePath, objectCacheKey } from '../../action/cache-plan.mjs'
import { createGitHubCacheTransport } from '../github-cache.mjs'

test('cache transport uses stable paths and bounds concurrent SDK restores', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-gh-cache-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let active = 0, maximum = 0
  const calls = []
  const objects = Array.from({ length: 5 }, (_, index) => ({ kind: 'cafs', id: sha256(`object-${index}`), size: index + 1 }))
  const api = { async restoreCache(paths, key, restoreKeys, options) {
    calls.push({ paths, key, restoreKeys, options }); active++; maximum = Math.max(maximum, active)
    await new Promise(resolve => setTimeout(resolve, 3))
    fs.writeFileSync(path.join(root, paths[0]), Buffer.alloc(objects.find(object => objectCacheKey(object, 'test') === key).size))
    active--; return key
  } }
  const transport = createGitHubCacheTransport({ root, namespace: 'test', api, concurrency: 2 })
  const rows = await transport.restoreMany(objects)
  assert.equal(maximum, 2)
  assert(rows.every(row => row.hit))
  assert.deepEqual(calls[0].paths, [cachePath(objects[0])])
  assert.deepEqual(calls[0].restoreKeys, [])
  assert.equal(calls[0].options.downloadConcurrency, 1)
})

test('prefix matches are rejected and missing caches are recorded without using stale files', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-gh-cache-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const object = { kind: 'cafs', id: sha256('one'), size: 3 }
  const transport = createGitHubCacheTransport({ root, namespace: 'test', api: { async restoreCache(paths, key) {
    fs.writeFileSync(path.join(root, paths[0]), 'bad'); return `${key}-other`
  } } })
  const result = await transport.restoreOne(object)
  assert.equal(result.hit, false)
  assert(!fs.existsSync(path.join(root, cachePath(object))))
})

test('publishing requires a successful reservation and deduplicates physical objects', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-gh-cache-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source'); fs.writeFileSync(source, 'object bytes')
  const object = { kind: 'cafs', id: sha256('object bytes'), size: 12 }
  let saves = 0
  const transport = createGitHubCacheTransport({ root, namespace: 'test', api: {
    async restoreCache() { return undefined }, async saveCache() { saves++; return 123 },
  } })
  const results = await transport.publishMany([{ object, source }, { object, source }])
  assert.equal(saves, 1); assert.equal(results.length, 1); assert.equal(results[0].cacheId, 123)
  const failing = createGitHubCacheTransport({ root, namespace: 'other', api: { async restoreCache() { return undefined }, async saveCache() { return -1 } } })
  await assert.rejects(failing.publishMany([{ object, source }]), /save/)
})
