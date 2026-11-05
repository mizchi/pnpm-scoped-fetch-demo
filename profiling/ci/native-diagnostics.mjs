import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { cachePath } from '../../action/cache-plan.mjs'
import { sha256 } from '../../action/chunk-identity.mjs'
import { cacheInventory, createGitHubCacheTransport } from '../github-cache.mjs'
import { childEnvironment, command, json, prepareSource, results, root, source, state } from './common.mjs'

const prepared = await prepareSource(), sample = Number(process.env.NATIVE_SAMPLE)
assert([1, 2, 3].includes(sample))
assert.equal(prepared.context.pnpm, '1f040be40f06bc3ac1643d90afe7444fc28e65b3db5a92f02f43825a74b92c76')
const seed = JSON.parse(fs.readFileSync('.work/native-seed/cwd-producer.json'))
assert.equal(seed.workflowRun, '41890677535'); assert.equal(seed.codeSha, '48aeb529c97201884a0aff8bd1e108a9d95de3e4')
assert.deepEqual(prepared.context, seed.context)
const saved = seed.saves.filter(record => record.key.includes('-scoped-')); assert.equal(saved.length, 1)
const object = { kind: 'scoped', id: saved[0].key.split('-').at(-1) }
const transport = createGitHubCacheTransport({ root, namespace: seed.namespace })
const restore = await transport.restoreOne(object)
assert(restore.hit); assert.equal(restore.key, saved[0].key)
const inventory = await cacheInventory({ repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN, namespace: seed.namespace, ref: process.env.GITHUB_REF })
restore.providerBytes = inventory.get(restore.key).bytes; assert.equal(restore.providerBytes, saved[0].providerBytes)
const seedStore = path.join(root, cachePath(object)), wantedDigest = sha256(fs.readFileSync(path.join(source, 'pnpm-lock.yaml')))
const rows = []
const environment = { ...childEnvironment(true), PNPM_CONFIG_RECURSIVE_INSTALL: 'false', TRACE: 'pacquet::install::phase=info', TRACE_FORMAT: 'json' }

async function workspace(label, retime = false) {
  const directory = path.join(state, `native-${label}`), project = path.join(directory, 'source'), store = path.join(directory, 'store')
  assert(!fs.existsSync(directory)); fs.mkdirSync(directory, { recursive: true })
  fs.cpSync(source, project, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true,
    filter: filename => !['node_modules', '.git'].includes(path.basename(filename)) })
  await command('cp', ['-a', '--reflink=auto', seedStore, store], { name: `native-copy-${label}`, environment })
  const files = fs.readdirSync(path.join(store, 'v11/files')).flatMap(shard => fs.readdirSync(path.join(store, 'v11/files', shard)).map(file => path.join('v11/files', shard, file)))
  assert.equal(files.length, seed.metrics.projects.sdk.files)
  for (const filename of files) assert.equal(fs.statSync(path.join(seedStore, filename)).mtimeMs, fs.statSync(path.join(store, filename)).mtimeMs)
  if (retime) { const now = new Date(); for (const filename of files) fs.utimesSync(path.join(store, filename), now, now) }
  return { project, store, retimedFiles: retime ? files.length : 0 }
}

function installArgs(store, frozen = true) {
  return ['install', frozen ? '--frozen-lockfile' : '--no-frozen-lockfile', '--offline', '--ignore-scripts', '--store-dir', store, '--reporter=ndjson']
}

function events(text) {
  return text.split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
}

async function install(workspace, scenario, importer, frozen = true) {
  const measured = await command(prepared.binary, installArgs(workspace.store, frozen), { cwd: path.join(workspace.project, importer), environment, name: `native-${scenario}` })
  const observed = events(measured.text)
  assert.equal(sha256(fs.readFileSync(path.join(workspace.project, 'pnpm-lock.yaml'))), wantedDigest)
  const row = { scenario, importer, frozen, retimedFiles: scenario.includes('retimed') ? workspace.retimedFiles : 0, ms: measured.ms,
    lockfileUnchanged: true, phases: observed.filter(event => event.target === 'pacquet::install::phase'),
    integrityReports: observed.filter(event => event.message?.includes('integrity of')),
    alreadyUpToDate: observed.some(event => event.message === 'Already up to date') }
  rows.push(row); console.log('NATIVE_RESULT ' + JSON.stringify(row))
}

async function checkModule(workspace) {
  await command(process.execPath, ['-e', "const assert=require('node:assert/strict');assert.equal(typeof require('typescript').transpile,'function')"],
    { cwd: path.join(workspace.project, 'sdk'), environment, name: `native-check-${path.basename(path.dirname(workspace.project))}` })
  assert(!fs.existsSync(path.join(workspace.project, 'packages/release-notes-generator/node_modules')))
}

let preserved
for (const variant of sample % 2 ? ['preserved', 'retimed'] : ['retimed', 'preserved']) {
  const current = await workspace(variant, variant === 'retimed')
  await install(current, `sdk-initial-${variant}`, 'sdk'); await checkModule(current)
  if (variant === 'preserved') {
    preserved = current
    await install(current, 'sdk-repeat-frozen', 'sdk')
    await install(current, 'sdk-repeat-unfrozen-control', 'sdk', false); await checkModule(current)
  }
}
const sequence = await workspace('sequence')
await install(sequence, 'sequence-system-data', 'packages/system-data')
assert(!fs.existsSync(path.join(sequence.project, 'sdk/node_modules')))
await install(sequence, 'sequence-sdk-add', 'sdk'); await install(sequence, 'sequence-sdk-repeat', 'sdk'); await checkModule(sequence)
for (const frozen of [true, false]) {
  const label = frozen ? 'frozen' : 'unfrozen'
  await command('strace', ['-f', '-c', '-o', path.join(results, `native-${label}.strace.txt`), prepared.binary, ...installArgs(preserved.store, frozen)],
    { cwd: path.join(preserved.project, 'sdk'), environment, name: `native-${label}-strace` })
}
const debug = await command(prepared.binary, installArgs(preserved.store), { cwd: path.join(preserved.project, 'sdk'),
  environment: { ...environment, TRACE: 'pacquet::install=debug,pacquet::download=debug' }, name: 'native-repeat-debug' })
json(path.join(results, 'native-diagnostics.json'), { kind: 'native-diagnostics', sample, adapter: false, context: prepared.context,
  seedRun: seed.workflowRun, restore, node: process.version, platform: process.platform, filesystemCache: 'warm; not flushed',
  rows: rows.map(row => ({ ...row, moduleLoad: true })), diagnosticEvents: events(debug.text).filter(event => event.level === 'DEBUG'),
  excludedFromNativeTimings: ['cache restore', 'source/store copies', 'retiming', 'module checks', 'strace', 'debug trace'] })
