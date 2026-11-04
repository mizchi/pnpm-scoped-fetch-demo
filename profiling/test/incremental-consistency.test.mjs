import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { initializeCurrentProject } from '../initialize-current.mjs'
import { workspaceContext } from '../workspace-context.mjs'
import { fixture } from './project-fixture.mjs'

test('a failed native install requires recovery in the same project before another project can start', async t => {
  const f = await fixture(t), seen = []
  const runInstall = async request => { seen.push(request.cwd); throw new Error('interrupted native install') }
  await assert.rejects(initializeCurrentProject({ ...f, runInstall, offline: true }), /interrupted native/)
  const other = { ...f, cwd: path.join(f.workspace, 'apps/admin'), runInstall: async request => { seen.push(request.cwd); return { ms: 1 } }, offline: true }
  await assert.rejects(initializeCurrentProject(other), /unfinished.*apps\/web/)
  assert.equal(seen.length, 1)
  await initializeCurrentProject({ ...other, cwd: f.cwd })
  await initializeCurrentProject(other)
  assert.equal(seen.length, 3)
})

test('an initialized workspace refuses a different store or a new lockfile generation', async t => {
  const f = await fixture(t), seen = [], runInstall = async request => { seen.push(request.cwd); return { ms: 1 } }
  await initializeCurrentProject({ ...f, runInstall })
  await assert.rejects(initializeCurrentProject({ ...f, runInstall, store: path.join(f.root, 'other-store') }), /store.*changed/)
  fs.appendFileSync(path.join(f.workspace, 'pnpm-lock.yaml'), '\n')
  f.cache.catalog.context = await workspaceContext(f.workspace, f.binary)
  await assert.rejects(initializeCurrentProject({ ...f, runInstall }), /generation.*changed/)
  assert.equal(seen.length, 1)
})

test('changes to an initialized project manifest are refused before another project is installed', async t => {
  const f = await fixture(t), seen = [], runInstall = async request => { seen.push(request.cwd); return { ms: 1 } }
  await initializeCurrentProject({ ...f, runInstall })
  fs.writeFileSync(path.join(f.cwd, 'package.json'), '{"name":"web","dependencies":{"changed":"1.0.0"}}')
  await assert.rejects(initializeCurrentProject({ ...f, cwd: path.join(f.workspace, 'apps/admin'), runInstall }), /manifest.*changed/)
  assert.equal(seen.length, 1)
})

test('a complete marker cannot hide same-size CAFS corruption', async t => {
  const f = await fixture(t), seen = [], runInstall = async request => { seen.push(request.cwd); return { ms: 1 } }
  await initializeCurrentProject({ ...f, runInstall })
  const filename = path.join(f.store, f.file.path), stat = fs.statSync(filename)
  fs.chmodSync(filename, 0o644); fs.writeFileSync(filename, Buffer.alloc(stat.size)); fs.utimesSync(filename, stat.atime, stat.mtime); fs.chmodSync(filename, stat.mode & 0o777)
  await assert.rejects(initializeCurrentProject({ ...f, runInstall }), /Content mismatch/)
  assert.equal(seen.length, 1)
})

test('overlapping initializations in one workspace are refused before their native installs overlap', async t => {
  const f = await fixture(t)
  let entered, release
  const running = new Promise(resolve => { entered = resolve }), barrier = new Promise(resolve => { release = resolve })
  const first = initializeCurrentProject({ ...f, cache: undefined, runInstall: async () => { entered(); await barrier; return { ms: 1 } } })
  await running
  try {
    await assert.rejects(initializeCurrentProject({ ...f, cache: undefined, cwd: path.join(f.workspace, 'apps/admin'), runInstall: async () => ({ ms: 1 }) }), /already running/)
  } finally { release(); await first }
})

test('all 64 success/failure traces of length three match the sequential recovery model', async t => {
  const events = ['web-ok', 'web-fail', 'admin-ok', 'admin-fail']
  for (const first of events) for (const second of events) for (const third of events) {
    const f = await fixture(t), completed = new Set()
    let pending, calls = 0
    for (const event of [first, second, third]) {
      const [name, outcome] = event.split('-'), importer = `apps/${name}`, before = calls
      const attempt = initializeCurrentProject({ ...f, cache: undefined, cwd: path.join(f.workspace, importer), runInstall: async () => {
        calls++; if (outcome === 'fail') throw new Error('model interruption'); return { ms: 1 }
      } })
      if (pending && pending !== importer) {
        await assert.rejects(attempt, /unfinished/); assert.equal(calls, before)
      } else if (outcome === 'fail') {
        await assert.rejects(attempt, /model interruption/); pending = importer
      } else {
        const result = await attempt; pending = undefined; completed.add('.'); completed.add(importer)
        assert.deepEqual(result.completedImporters, [...completed].sort())
      }
      const saved = JSON.parse(fs.readFileSync(path.join(f.workspace, '.pnpm-cache/initialization.json')))
      assert.equal(saved.pending, pending)
      assert.deepEqual(saved.completed, [...completed].sort())
    }
  }
})

test('input changes during native install leave the attempt unfinished and prevent another project from starting', async t => {
  const f = await fixture(t)
  await assert.rejects(initializeCurrentProject({ ...f, runInstall: async () => {
    fs.appendFileSync(path.join(f.cwd, 'package.json'), '\n'); return { ms: 1 }
  } }), /manifest.*changed/)
  await assert.rejects(initializeCurrentProject({ ...f, cwd: path.join(f.workspace, 'apps/admin'), runInstall: async () => ({ ms: 1 }) }), /unfinished/)
})

test('malformed session state and an abandoned writer lock fail closed', async t => {
  const f = await fixture(t), directory = path.join(f.workspace, '.pnpm-cache')
  fs.mkdirSync(directory)
  fs.writeFileSync(path.join(directory, 'initialization.json'), 'null')
  const attempt = () => initializeCurrentProject({ ...f, runInstall: async () => { throw new Error('Native must not run') } })
  await assert.rejects(attempt(), /Invalid initialization session/)
  fs.unlinkSync(path.join(directory, 'initialization.json'))
  fs.writeFileSync(path.join(directory, 'initialization.lock'), '{"pid":999999999}')
  await assert.rejects(attempt(), /lock recovery/)
  assert(fs.existsSync(path.join(directory, 'initialization.lock')))
})

test('a newly selected project must match the producer manifest before cached payloads are used', async t => {
  const f = await fixture(t)
  fs.appendFileSync(path.join(f.workspace, 'apps/admin/package.json'), '\n')
  await assert.rejects(initializeCurrentProject({ ...f, cwd: path.join(f.workspace, 'apps/admin'), runInstall: async () => { throw new Error('Native must not run') } }), /catalog manifest mismatch/)
  assert.equal(f.calls.length, 0)
})

test('a copied session or untracked installation cannot be adopted into another workspace', async t => {
  const f = await fixture(t), runInstall = async () => ({ ms: 1 })
  fs.mkdirSync(path.join(f.cwd, 'node_modules'))
  await assert.rejects(initializeCurrentProject({ ...f, runInstall }), /Untracked node_modules/)
  fs.rmdirSync(path.join(f.cwd, 'node_modules'))
  await initializeCurrentProject({ ...f, runInstall })
  const copy = path.join(f.root, 'copy'); fs.cpSync(f.workspace, copy, { recursive: true })
  await assert.rejects(initializeCurrentProject({ ...f, cwd: path.join(copy, 'apps/admin'), runInstall }), /workspace changed/)
})
