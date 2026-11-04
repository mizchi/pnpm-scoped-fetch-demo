import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { hydrateProject, ProjectCacheMiss } from '../hydrate-project.mjs'
import { initializeCurrentProject } from '../initialize-current.mjs'
import { pinnedBinaryEnvironment } from '../native-environment.mjs'
import { fixture } from './project-fixture.mjs'

test('hydration skips completed chunks and repairs missing files without replacing valid index rows', async t => {
  const f = await fixture(t), options = { ...f.cache, plan: f.plan, store: f.store }
  assert.equal((await hydrateProject(options)).requestedObjects, 2)
  const target = path.join(f.store, f.file.path), inode = fs.statSync(target).ino
  assert.equal((await hydrateProject(options)).requestedObjects, 0)
  assert.equal(fs.statSync(target).ino, inode)
  fs.unlinkSync(target)
  const indexTarget = path.join(f.store, f.indexFile.path)
  const updated = Buffer.concat([f.row.subarray(0, -13), Buffer.from('updated metadata')]); fs.writeFileSync(indexTarget, updated)
  fs.unlinkSync(path.join(f.cache.stateDirectory, `${f.plan.index.id}.json`))
  const repaired = await hydrateProject(options)
  assert.equal(repaired.requestedObjects, 2)
  assert.deepEqual(fs.readFileSync(indexTarget), updated)
  assert(fs.existsSync(target))
  fs.writeFileSync(path.join(f.cache.stateDirectory, `${f.plan.objects[0].id}.json`), '{')
  assert.equal((await hydrateProject(options)).requestedObjects, 1)
})

test('a missing cache object is reported before any object is committed to the store', async t => {
  const f = await fixture(t)
  for (const restore of [async () => [], async objects => objects.map((object, index) => ({ key: object.id, hit: index !== 1 }))]) {
    await assert.rejects(hydrateProject({ ...f.cache, plan: f.plan, store: f.store, restore }), ProjectCacheMiss)
    assert.deepEqual(fs.readdirSync(f.store), [])
  }
})

test('current-directory initialization uses frozen nonrecursive native install without a filter', async t => {
  const f = await fixture(t), invocations = []
  const runInstall = async request => { invocations.push(request); return { ms: 12 } }
  const result = await initializeCurrentProject({ ...f, runInstall, offline: true, ignoreScripts: true })
  assert.equal(result.importer, 'apps/web')
  assert.equal(result.requestedObjects, 2)
  assert.deepEqual(invocations[0], { binary: fs.realpathSync(f.binary), cwd: fs.realpathSync(f.cwd), environment: { ...pinnedBinaryEnvironment, PNPM_CONFIG_RECURSIVE_INSTALL: 'false' },
    args: ['install', '--frozen-lockfile', '--store-dir', f.store, '--offline', '--ignore-scripts'] })
  assert.equal((await initializeCurrentProject({ ...f, runInstall, offline: true, ignoreScripts: true })).requestedObjects, 0)
  fs.appendFileSync(path.join(f.workspace, 'pnpm-lock.yaml'), '\nchanged: true')
  await assert.rejects(initializeCurrentProject({ ...f, runInstall }), /context mismatch/)
  assert.equal(invocations.length, 2)
})

test('only a cache miss permits online native fallback; offline and integrity failures stop', async t => {
  const f = await fixture(t), invocations = []
  const runInstall = async request => { invocations.push(request); return { ms: 1 } }
  const cache = { ...f.cache, restore: async objects => objects.map(object => ({ key: object.id, hit: false })) }
  assert.equal((await initializeCurrentProject({ ...f, cache, runInstall })).cacheMode, 'miss')
  assert.equal(invocations.length, 1)
  await assert.rejects(initializeCurrentProject({ ...f, cache, runInstall, offline: true }), ProjectCacheMiss)
  cache.restore = async () => { throw new Error('integrity failure') }
  await assert.rejects(initializeCurrentProject({ ...f, cache, runInstall }), /integrity failure/)
  assert.equal(invocations.length, 1)
})
