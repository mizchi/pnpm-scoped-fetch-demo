import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { zstdCompressSync } from 'node:zlib'
import test from 'node:test'
import tar from 'tar-stream'
import { sha256 } from '../../action/chunk-identity.mjs'
import { hydrateProject, ProjectCacheMiss } from '../hydrate-project.mjs'
import { initializeCurrentProject } from '../initialize-current.mjs'
import { pinnedBinaryEnvironment } from '../native-environment.mjs'
import { writeTarChunk } from '../tar-zstd.mjs'
import { workspaceContext } from '../workspace-context.mjs'

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-initialize-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = path.join(root, 'store'), stateDirectory = path.join(root, 'state'), workspace = path.join(root, 'workspace')
  const cwd = path.join(workspace, 'apps/web'); fs.mkdirSync(cwd, { recursive: true })
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"web"}')
  fs.writeFileSync(path.join(workspace, 'pnpm-workspace.yaml'), 'packages: [apps/*]')
  fs.writeFileSync(path.join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0')
  const binary = path.join(root, 'pnpm'); fs.writeFileSync(binary, 'native-binary-fixture')
  const bytes = Buffer.from('shared package content'), digest = createHash('sha512').update(bytes).digest('hex')
  const file = { path: `v11/files/${digest.slice(0, 2)}/${digest.slice(2)}`, size: bytes.length, sha256: sha256(bytes), mode: 0o444 }
  const cafs = await writeTarChunk({ chunk: { files: [file] }, source: () => Readable.from([bytes]), filename: path.join(root, 'cafs') })
  const key = 'sha512-package\tpackage@1.0.0', hash = sha256(key), header = Buffer.alloc(4); header.writeUInt32LE(Buffer.byteLength(key))
  const row = Buffer.concat([header, Buffer.from(key), Buffer.from('msgpack bytes')])
  const indexFile = { path: `v11/index/${hash.slice(0, 2)}/${hash.slice(2)}`, size: row.length, sha256: sha256(row), mode: 0o644 }
  const pack = tar.pack(), buffers = []
  const reading = (async () => { for await (const bytes of pack) buffers.push(bytes) })()
  pack.entry({ name: indexFile.path, mode: 0o644, type: 'file', mtime: new Date(0) }, row); pack.finalize(); await reading
  const archive = zstdCompressSync(Buffer.concat(buffers)); fs.writeFileSync(path.join(root, 'index'), archive)
  const object = { kind: 'cafs', id: cafs.sha256, size: cafs.size, fileCount: 1, rawBytes: bytes.length }
  const index = { kind: 'index', id: sha256(archive), size: archive.length, tarBytes: row.length + 10240 }
  const plan = { layout: 'v11', objects: [object], index }, calls = []
  const cache = { stateDirectory, archivePath: entry => path.join(root, entry.kind), restore: async entries => {
    calls.push(entries.map(entry => entry.id)); return entries.map(entry => ({ key: entry.id, hit: true }))
  } }
  const context = await workspaceContext(workspace, binary)
  cache.catalog = { version: 1, context, targetBytes: 1024, layout: 'v11', projects: { 'apps/web': [object.id] }, objects: { [object.id]: object }, index }
  return { root, store, plan, cache, calls, file, indexFile, row, cwd, workspace, binary }
}

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
  assert.deepEqual(invocations[0], { binary: f.binary, cwd: fs.realpathSync(f.cwd), environment: { ...pinnedBinaryEnvironment, PNPM_CONFIG_RECURSIVE_INSTALL: 'false' },
    args: ['install', '--frozen-lockfile', '--store-dir', f.store, '--offline', '--ignore-scripts'] })
  assert.equal((await initializeCurrentProject({ ...f, runInstall, offline: true })).requestedObjects, 0)
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
