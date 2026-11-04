import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { parse } from 'yaml'
import { canonicalJson, sha256 } from '../action/chunk-identity.mjs'
import { cachePath } from '../action/cache-plan.mjs'
import { hydrateProject } from './hydrate-project.mjs'
import { initializeCurrentProject } from './initialize-current.mjs'
import { incrementalFixture } from './incremental-fixture.mjs'
import { packProjects } from './pack-projects.mjs'
import { filesUnder } from './store-snapshot.mjs'
import { lockfileGraph } from './native-store.mjs'
import { selectWorkspaceImporters } from './scoped-index.mjs'
import { pinnedBinaryEnvironment } from './native-environment.mjs'

async function command(binary, args, cwd, environment = {}) {
  const started = performance.now(), clean = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !/TOKEN|SECRET|PASSWORD/i.test(name) && !/^(npm|pnpm)_config_/i.test(name)))
  const result = await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env: { ...clean, ...pinnedBinaryEnvironment, ...environment } })
    let text = ''; child.stdout.on('data', bytes => { text += bytes }); child.stderr.on('data', bytes => { text += bytes })
    child.once('error', reject); child.once('exit', code => code ? reject(new Error(`${binary} exited ${code}: ${text}`)) : resolve(text.trim()))
  })
  return { ms: performance.now() - started, text: result }
}

function copySource(from, to) {
  fs.cpSync(from, to, { recursive: true, filter: filename => !['node_modules', '.pnpm-cache'].includes(path.basename(filename)) })
}

function cacheFor(packed, directory, store) {
  return { catalog: packed.catalog, stateDirectory: `${store}.chunk-state`, archivePath: object => path.join(directory, cachePath(object)),
    restore: async objects => objects.map(object => ({ key: object.id, hit: true, innerBytes: object.size })) }
}

function cafsSnapshot(store, layout) {
  const directory = path.join(store, layout, 'files')
  if (!fs.existsSync(directory)) return {}
  return Object.fromEntries(filesUnder(directory).map(relative => [relative, sha256(fs.readFileSync(path.join(directory, relative)))]))
}

function permutations(values) {
  return values.length ? values.flatMap((value, index) => permutations(values.filter((_, other) => other !== index)).map(tail => [value, ...tail])) : [[]]
}

async function probe(source, ready) {
  const script = `const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
    const root=process.cwd(),ready=${JSON.stringify([...ready].sort())},rows=[];
    for(const importer of ready){const requireFrom=createRequire(path.join(root,importer,'package.json'));
      const names=importer==='packages/ui'?['shared-dep']:importer==='apps/a'?['versioned-dep','peer-consumer','ui']:importer==='apps/b'?['versioned-dep','peer-consumer']:[];
      for(const name of names)rows.push({importer,name,value:requireFrom(name),resolved:path.relative(root,fs.realpathSync(requireFrom.resolve(name)))});
      if(importer.startsWith('apps/'))rows.push({importer,name:'bin:peer-version',value:require('node:child_process').execFileSync(path.join(root,importer,'node_modules/.bin/peer-version'),[],{encoding:'utf8'}).trim()});}
    console.log(JSON.stringify(rows));`
  return JSON.parse((await command(process.execPath, ['-e', script], source)).text)
}

function assertCurrentLock(source, ready, wanted) {
  const current = parse(fs.readFileSync(path.join(source, 'node_modules/.pnpm/lock.yaml'), 'utf8'))
  for (const importer of ready) assert.deepEqual(current.importers[importer], wanted.importers[importer], `Lost installed importer: ${importer}`)
}

async function checkRecovery({ binary, directory, source, packed, packedDirectory, expected, lock }) {
  const cases = []
  for (const fault of ['after-native-install', 'corrupt-cache-archive']) {
    const current = path.join(directory, fault), store = path.join(directory, `${fault}-store`)
    copySource(source, current)
    const cache = cacheFor(packed, packedDirectory, store)
    let installs = 0
    const runInstall = request => { installs++; return command(request.binary, request.args, request.cwd, request.environment) }
    const options = { binary, store, cache, offline: true, ignoreScripts: true, runInstall }
    await initializeCurrentProject({ ...options, cwd: path.join(current, 'apps/a') })
    const aReady = new Set(['.', 'apps/a', 'packages/ui']), previous = await probe(current, aReady)
    if (fault === 'after-native-install') {
      await assert.rejects(initializeCurrentProject({ ...options, cwd: path.join(current, 'apps/b'), runInstall: async request => {
        await runInstall(request); throw new Error('Injected interruption after native install')
      } }), /Injected interruption/)
      await assert.rejects(initializeCurrentProject({ ...options, cwd: path.join(current, 'apps/a') }), /unfinished/)
    } else {
      const unique = packed.catalog.projects['apps/b'].find(id => !packed.catalog.projects['apps/a'].includes(id)); assert(unique)
      const descriptor = packed.catalog.objects[unique], filename = path.join(directory, 'corrupt.tar.zst')
      const bytes = fs.readFileSync(cache.archivePath(descriptor)); fs.writeFileSync(filename, bytes.subarray(0, Math.floor(bytes.length / 2)))
      const badCache = { ...cache, archivePath: object => object.id === unique ? filename : cache.archivePath(object) }
      await assert.rejects(initializeCurrentProject({ ...options, cache: badCache, cwd: path.join(current, 'apps/b') }))
      assert.equal(installs, 1, 'A corrupt cache must stop before the second native install')
    }
    assert.deepEqual(await probe(current, aReady), previous, 'The failed attempt changed an initialized project')
    const recovered = await initializeCurrentProject({ ...options, cwd: path.join(current, 'apps/b') })
    const allReady = new Set(['.', 'apps/a', 'apps/b', 'packages/ui'])
    assert.deepEqual(await probe(current, allReady), expected)
    assertCurrentLock(current, allReady, lock)
    cases.push({ fault, nativeInstalls: installs, recovered: true, previousProjectPreserved: true, retryRequestedObjects: recovered.requestedObjects })
  }
  return cases
}

export async function checkIncrementalInitialization({ binary, directory }) {
  fs.mkdirSync(directory, { recursive: true })
  const source = path.join(directory, 'producer'), fixture = await incrementalFixture(source)
  try {
    const full = path.join(directory, 'full-store')
    await command(binary, ['fetch', '--store-dir', full, '--ignore-scripts'], source)
    const packedDirectory = path.join(directory, 'packed'), packed = await packProjects({ workspace: source, store: full, binary, directory: packedDirectory, targetBytes: 1024 })
    const downloadedPackages = fixture.requests.length; assert(downloadedPackages > 0)
    const baseline = path.join(directory, 'baseline'), baselineStore = path.join(directory, 'baseline-store')
    copySource(source, baseline)
    const all = { layout: packed.catalog.layout, index: packed.catalog.index, objects: Object.values(packed.catalog.objects) }
    await hydrateProject({ ...cacheFor(packed, packedDirectory, baselineStore), plan: all, store: baselineStore })
    await command(binary, ['install', '--store-dir', baselineStore, '--frozen-lockfile', '--offline', '--ignore-scripts'], baseline)
    const entries = ['apps/a', 'apps/b', 'packages/ui'], expected = await probe(baseline, entries), expectedCafs = cafsSnapshot(baselineStore, packed.catalog.layout)
    assert.equal(expected.find(row => row.importer === 'apps/a' && row.name === 'peer-consumer').value, 'one')
    assert.equal(expected.find(row => row.importer === 'apps/b' && row.name === 'peer-consumer').value, 'two')
    const { graph } = lockfileGraph(fixture.lock), cases = []
    for (const [index, order] of permutations(entries).entries()) {
      const current = path.join(directory, `order-${index}`), store = path.join(directory, `store-${index}`)
      copySource(source, current)
      const cache = cacheFor(packed, packedDirectory, store), ready = new Set(), steps = []
      let previousFiles = {}
      for (const importer of [...order, order[0]]) {
        const result = await initializeCurrentProject({ cwd: path.join(current, importer), binary, store, cache, offline: true, ignoreScripts: true,
          runInstall: request => command(request.binary, request.args, request.cwd, request.environment) })
        for (const id of selectWorkspaceImporters({ graph, importers: [importer] })) ready.add(id.slice('workspace:'.length))
        const actual = await probe(current, ready)
        assert.deepEqual(actual, expected.filter(row => ready.has(row.importer)), `Resolution changed after ${order.join(' -> ')} / ${importer}`)
        assertCurrentLock(current, ready, fixture.lock)
        const files = cafsSnapshot(store, packed.catalog.layout)
        for (const [name, digest] of Object.entries(previousFiles)) assert.equal(files[name], digest, `Existing CAFS changed: ${name}`)
        previousFiles = files
        for (const candidate of entries) if (!ready.has(candidate)) assert(!fs.existsSync(path.join(current, candidate, 'node_modules')))
        steps.push({ importer, requestedObjects: result.requestedObjects, skippedObjects: result.skippedObjects, completedImporters: result.completedImporters })
      }
      assert.deepEqual(previousFiles, expectedCafs)
      assert.equal(steps.at(-1).requestedObjects, 0)
      cases.push({ order, steps, resolutionMatchesCombinedInstall: true, currentLockPreserved: true, appendOnlyCafs: true })
    }
    const recoveryCases = await checkRecovery({ binary, directory, source, packed, packedDirectory, expected, lock: fixture.lock })
    assert.equal(fixture.requests.length, downloadedPackages, 'An offline consumer requested the registry')
    const result = { version: 1, pnpm: packed.metrics.context.pnpm, context: packed.metrics.context, orders: cases.length,
      nativeInstalls: cases.reduce((sum, row) => sum + row.steps.length, 1) + recoveryCases.reduce((sum, row) => sum + row.nativeInstalls, 0), cases, recoveryCases, combinedResolution: expected,
      finalCafsFingerprint: sha256(canonicalJson(expectedCafs)), offlineRegistryRequests: 0 }
    fs.writeFileSync(path.join(directory, 'consistency.json'), JSON.stringify(result, null, 2) + '\n')
    return result
  } finally { await fixture.close() }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { pnpm: { type: 'string' }, output: { type: 'string' } } })
  if (!values.pnpm || !values.output) throw new Error('Pass --pnpm and a fresh --output directory')
  const result = await checkIncrementalInitialization({ binary: fs.realpathSync(values.pnpm), directory: path.resolve(values.output) })
  console.log(JSON.stringify({ orders: result.orders, nativeInstalls: result.nativeInstalls, recoveryCases: result.recoveryCases.length, offlineRegistryRequests: result.offlineRegistryRequests }))
}
