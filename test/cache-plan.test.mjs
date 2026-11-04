import assert from 'node:assert/strict'
import test from 'node:test'
import { createThinPlan, planId, planCacheKey, objectCacheKey, cachePath, validateThinPlan } from '../action/cache-plan.mjs'
const digest = letter => letter.repeat(64)
const query = { version: 1, lockfile: digest('a'), configuration: digest('b'), pnpm: digest('c'), platform: 'linux', arch: 'x64', node: '24.21.0', entry: 'sdk', mode: 'chunks', targetBytes: 67108864 }
const material = { sourceLockfile: query.lockfile, context: { layout: 'v11' }, manifest: {
  entries: { sdk: { imports: ['logical'], index: { sha256: digest('e'), size: 100, tarBytes: 8192, archive: '/private/index.tar.zst' } } },
  chunks: { logical: { size: 1000, files: Array.from({ length: 1000 }, (_, n) => ({ path: `/private/file-${n}` })) } },
}, archives: { logical: { sha256: digest('d'), size: 400, filename: '/private/payload.tar.zst' } } }

test('thin plans contain references and bounds without local paths or file inventories', () => {
  const plan = createThinPlan({ material, entry: 'sdk', query })
  const bytes = JSON.stringify(plan)
  assert(bytes.length < 2000)
  assert(!bytes.includes('/private/'))
  assert(!bytes.includes('imports'))
  assert.equal(plan.objects[0].fileCount, 1000)
  assert.equal(plan.objects[0].rawBytes, 1000)
  assert.equal(plan.index.tarBytes, 8192)
  assert.doesNotThrow(() => validateThinPlan(plan, query))
})

test('plan keys vary with dependency inputs while object locations and IDs stay reusable', () => {
  const plan = createThinPlan({ material, entry: 'sdk', query })
  assert.notEqual(planId(query), planId({ ...query, lockfile: digest('f') }))
  assert.equal(cachePath(plan.objects[0]), `.pnpm-cache/objects/${digest('d')}.tar.zst`)
  assert.notEqual(objectCacheKey(plan.objects[0], 'run-1'), objectCacheKey(plan.objects[0], 'run-2'))
  assert.equal(cachePath(plan.objects[0]), cachePath({ ...plan.objects[0] }))
  assert.match(planCacheKey(query, 'run-1'), /^pnpm-cg-run-1-plan-/)
})

test('foreign queries, unknown formats, invalid paths and oversized numeric bounds fail', () => {
  const plan = createThinPlan({ material, entry: 'sdk', query })
  assert.throws(() => validateThinPlan(plan, { ...query, entry: 'api' }), /query/)
  assert.throws(() => validateThinPlan({ ...plan, version: 2 }, query), /version/)
  assert.throws(() => cachePath({ kind: 'cafs', id: '../escape' }), /digest/)
  assert.throws(() => objectCacheKey(plan.objects[0], '../bad'), /namespace/)
  assert.throws(() => validateThinPlan({ ...plan, objects: [{ ...plan.objects[0], fileCount: Number.MAX_SAFE_INTEGER }] }, query), /bounds/)
})

test('a scoped store is an independent baseline and cannot masquerade as the full store', () => {
  const scopedQuery = { ...query, mode: 'scoped', targetBytes: 0 }
  const object = { kind: 'scoped', id: digest('d'), rawBytes: 1000, fileCount: 4 }
  const plan = { version: 1, query: scopedQuery, layout: 'v11', objects: [object] }
  assert.doesNotThrow(() => validateThinPlan(plan, scopedQuery))
  assert.equal(cachePath(object), `.pnpm-cache/scoped-stores/${object.id}`)
  assert.notEqual(cachePath(object), cachePath({ ...object, kind: 'whole' }))
  assert.throws(() => validateThinPlan({ ...plan, objects: [{ ...object, kind: 'whole' }] }, scopedQuery), /composition/)
})
