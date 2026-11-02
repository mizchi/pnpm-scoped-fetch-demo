import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { fetchScope, prepare } from './action/scoped-fetch.mjs'
import { runGroupsDemo } from './groups-demo.mjs'

const { values } = parseArgs({
  options: {
    candidate: { type: 'string' },
    baseline: { type: 'string', default: 'pnpm' },
    'admin-mib': { type: 'string', default: '16' },
    'expect-reduction': { type: 'boolean', default: false },
    action: { type: 'boolean', default: false },
    groups: { type: 'boolean', default: false },
  },
})
const candidate = values.candidate ?? values.baseline
const adminMiB = Number(values['admin-mib'])
assert(Number.isSafeInteger(adminMiB) && adminMiB > 0 && adminMiB <= 256)
const demoRoot = path.dirname(fileURLToPath(import.meta.url))
const work = path.join(demoRoot, '.work', new Date().toISOString().replaceAll(':', '-'))
fs.mkdirSync(work, { recursive: true })
const cleanEnv = { COPYFILE_DISABLE: '1', ...Object.fromEntries(Object.entries(process.env).filter(([name]) => {
  const lower = name.toLowerCase()
  return !lower.startsWith('npm_config_') && !lower.startsWith('pnpm_config_')
})) }

async function command(binary, args, cwd, extraEnv = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env: { ...cleanEnv, ...extraEnv } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.on('error', reject)
    child.on('close', code => code === 0
      ? resolve(stdout.trim())
      : reject(new Error(`${binary} ${args.join(' ')} exited ${code}\n${stdout}\n${stderr}`)))
  })
}

function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n')
}

function payload(name, size) {
  const buffer = Buffer.alloc(size)
  for (let offset = 0; offset < size; offset += 32) {
    const block = createHash('sha256').update(`${name}:${offset}`).digest()
    block.copy(buffer, offset, 0, Math.min(32, size - offset))
  }
  return buffer
}

const packages = [
  { name: 'shared-dep', size: 128 * 1024, dependencies: {} },
  { name: 'web-dep', size: 256 * 1024, dependencies: { 'shared-dep': '1.0.0' } },
  { name: 'admin-dep', size: adminMiB * 1024 * 1024, dependencies: { 'shared-dep': '1.0.0' } },
  { name: 'root-tool', size: 64 * 1024, dependencies: {} },
]
const blobs = new Map()
for (const pkg of packages) {
  const directory = path.join(work, 'packages', pkg.name, 'package')
  writeJson(path.join(directory, 'package.json'), {
    name: pkg.name, version: '1.0.0', main: 'index.js', dependencies: pkg.dependencies,
  })
  fs.writeFileSync(path.join(directory, 'payload.bin'), payload(pkg.name, pkg.size))
  const expression = pkg.name === 'web-dep' ? "'web-dep:' + require('shared-dep')" : JSON.stringify(pkg.name)
  fs.writeFileSync(path.join(directory, 'index.js'), `module.exports = ${expression}\n`)
  const tarPath = path.join(work, `${pkg.name}.tar`)
  await command('tar', ['-cf', tarPath, '-C', path.dirname(directory), 'package'], work)
  const bytes = gzipSync(fs.readFileSync(tarPath), { level: 6 })
  pkg.integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64')
  blobs.set(`/${pkg.name}.tgz`, bytes)
}

let packageBytes = 0
let packageRequests = []
const cacheArchives = new Map()
const server = createServer((request, response) => {
  const bytes = blobs.get(request.url)
  if (bytes) {
    packageBytes += bytes.length
    packageRequests.push(request.url)
    response.writeHead(200, { 'content-length': bytes.length })
    response.end(bytes)
    return
  }
  const archive = cacheArchives.get(request.url)
  if (archive) {
    response.writeHead(200, { 'content-length': fs.statSync(archive).size })
    fs.createReadStream(archive).pipe(response)
    return
  }
  response.writeHead(404)
  response.end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const registry = `http://127.0.0.1:${server.address().port}`
const source = path.join(work, 'source')
writeJson(path.join(source, 'package.json'), {
  name: 'fixture-root', private: true, devDependencies: { 'root-tool': '1.0.0' },
})
fs.writeFileSync(path.join(source, 'pnpm-workspace.yaml'), [
  'packages:', '  - apps/*', '  - packages/*',
  'trustLockfile: true', 'updateNotifier: false',
  'virtualStoreType: project', '',
].join('\n'))
writeJson(path.join(source, 'apps/web/package.json'), {
  name: 'web', version: '1.0.0', dependencies: { 'web-dep': '1.0.0', ui: 'workspace:*' },
})
writeJson(path.join(source, 'apps/admin/package.json'), {
  name: 'admin', version: '1.0.0', dependencies: { 'admin-dep': '1.0.0' },
})
writeJson(path.join(source, 'packages/ui/package.json'), {
  name: 'ui', version: '1.0.0', main: 'index.js', dependencies: { 'shared-dep': '1.0.0' },
})
fs.writeFileSync(path.join(source, 'packages/ui/index.js'), "module.exports = 'ui:' + require('shared-dep')\n")
let lockfile = `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
importers:
  .:
    devDependencies:
      root-tool: {specifier: 1.0.0, version: 1.0.0}
  apps/web:
    dependencies:
      web-dep: {specifier: 1.0.0, version: 1.0.0}
      ui: {specifier: 'workspace:*', version: 'link:../../packages/ui'}
  apps/admin:
    dependencies:
      admin-dep: {specifier: 1.0.0, version: 1.0.0}
  packages/ui:
    dependencies:
      shared-dep: {specifier: 1.0.0, version: 1.0.0}
packages:
`
for (const pkg of packages) {
  lockfile += `  ${pkg.name}@1.0.0:\n    resolution: {tarball: '${registry}/${pkg.name}.tgz', integrity: '${pkg.integrity}'}\n`
}
lockfile += 'snapshots:\n'
for (const pkg of packages) {
  lockfile += `  ${pkg.name}@1.0.0:\n`
  if (Object.keys(pkg.dependencies).length === 0) {
    lockfile += '    {}\n'
  } else {
    lockfile += '    dependencies:\n'
    for (const [name, version] of Object.entries(pkg.dependencies)) lockfile += `      ${name}: ${version}\n`
  }
}
fs.writeFileSync(path.join(source, 'pnpm-lock.yaml'), lockfile)
await command('git', ['init', '--quiet'], source)
await command('git', ['add', '.'], source)
await command('git', ['-c', 'user.name=pnpm demo', '-c', 'user.email=demo@example.invalid', 'commit', '--quiet', '-m', 'test: add scoped fetch fixture'], source)

async function sparseCheckout(directory, directories = ['apps/web', 'packages/ui']) {
  await command('git', ['clone', '--quiet', '--no-local', source, directory], work)
  await command('git', ['sparse-checkout', 'set', '--cone', ...directories], directory)
  if (!directories.includes('apps/admin')) assert(!fs.existsSync(path.join(directory, 'apps/admin')))
}

function storeStats(directory) {
  let bytes = 0
  let files = 0
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = storeStats(filename)
      bytes += nested.bytes
      files += nested.files
    } else if (entry.isFile()) {
      bytes += fs.statSync(filename).size
      files++
    }
  }
  return { bytes, files }
}

async function measure(name, binary, filtered) {
  const directory = path.join(work, name)
  const checkout = path.join(directory, 'checkout')
  let store = path.join(directory, 'store')
  fs.mkdirSync(directory, { recursive: true })
  await sparseCheckout(checkout)
  const env = {
    PNPM_CONFIG_CI: 'false', PNPM_CONFIG_UPDATE_NOTIFIER: 'false',
    XDG_CONFIG_HOME: path.join(directory, 'config'), XDG_CACHE_HOME: path.join(directory, 'cache'),
    PNPM_CONFIG_NPMRC_AUTH_FILE: path.join(directory, 'npmrc'),
    PNPM_CONFIG_STATE_DIR: path.join(directory, 'state'),
  }
  fs.writeFileSync(env.PNPM_CONFIG_NPMRC_AUTH_FILE, '')
  let actionPlan
  const actionInput = {
    filters: '{apps/web}...', pnpmBinary: binary,
    runnerTemp: path.join(directory, 'runner-temp'),
    dependencyHash: createHash('sha256').update(lockfile).digest('hex'),
  }
  if (values.action && name === 'candidate-filtered') {
    fs.mkdirSync(actionInput.runnerTemp)
    actionPlan = await prepare({ ...actionInput, workspace: checkout }, { env: { ...cleanEnv, ...env } })
    store = actionPlan.storeDir
  }
  const common = ['--reporter=silent', '--store-dir', store, '--state-dir', path.join(directory, 'state')]
  const scope = ['--filter', '{apps/web}...', '--workspace-root']
  packageBytes = 0
  packageRequests = []
  if (actionPlan) {
    await fetchScope(actionPlan, { env: { ...cleanEnv, ...env } })
  } else {
    await command(binary, [...common, 'fetch', ...(filtered ? scope : [])], checkout, env)
  }
  const downloads = { packageBytes, packageRequests: [...packageRequests].sort() }
  assert.equal(fs.readFileSync(path.join(checkout, 'pnpm-lock.yaml'), 'utf8'), lockfile)
  const stats = storeStats(store)
  const tarPath = path.join(directory, 'store.tar')
  const archive = `${tarPath}.zst`
  await command('tar', ['-cf', tarPath, '-C', store, '.'], directory)
  await command('zstd', ['-q', '-T1', '-3', '-f', tarPath, '-o', archive], directory)
  cacheArchives.set(`/cache/${name}`, archive)
  const downloaded = path.join(directory, 'downloaded.tar.zst')
  const response = await fetch(`${registry}/cache/${name}`)
  assert.equal(response.status, 200)
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(downloaded))
  assert.deepEqual(fs.readFileSync(downloaded), fs.readFileSync(archive))
  const cacheTransferBytes = fs.statSync(downloaded).size
  let restoredStore = path.join(directory, 'restored-store')
  const restoredCheckout = path.join(directory, 'restored-checkout')
  await sparseCheckout(restoredCheckout)
  let restoredPlan
  if (actionPlan) {
    restoredPlan = await prepare({ ...actionInput, workspace: restoredCheckout }, { env: { ...cleanEnv, ...env } })
    assert.equal(restoredPlan.cacheKey, actionPlan.cacheKey)
    restoredStore = restoredPlan.storeDir
  } else {
    fs.mkdirSync(restoredStore)
  }
  await command('zstd', ['-q', '-d', '-f', downloaded, '-o', path.join(directory, 'restored.tar')], directory)
  await command('tar', ['-xf', path.join(directory, 'restored.tar'), '-C', restoredStore], directory)
  packageRequests = []
  if (restoredPlan) {
    await fetchScope(restoredPlan, { env: { ...cleanEnv, ...env } })
    assert.deepEqual(packageRequests, [], 'fetch after a scoped cache restore must not download any package')
  }
  await command(binary, ['--reporter=silent', '--store-dir', restoredStore, '--state-dir', path.join(directory, 'restored-state'), 'install', '--frozen-lockfile', '--offline', '--filter', '{apps/web}...'], restoredCheckout, env)
  assert.deepEqual(packageRequests, [], 'offline install must not fetch any package')
  assert.equal(fs.readFileSync(path.join(restoredCheckout, 'pnpm-lock.yaml'), 'utf8'), lockfile)
  await command(process.execPath, ['-e', "const assert = require('node:assert/strict'); assert.equal(require('web-dep'), 'web-dep:shared-dep'); assert.equal(require('ui'), 'ui:shared-dep')"], path.join(restoredCheckout, 'apps/web'), env)
  return { name, pnpmVersion: await command(binary, ['--version'], checkout, env), ...downloads, storeBytes: stats.bytes, storeFiles: stats.files, cacheTransferBytes, offlineInstall: true, lockfileUnchanged: true, ...(actionPlan ? { actionColdFetch: true, actionWarmFetch: true } : {}) }
}

async function updateAdmin() {
  const directory = path.join(work, 'packages/admin-dep/package')
  writeJson(path.join(directory, 'package.json'), {
    name: 'admin-dep', version: '2.0.0', main: 'index.js', dependencies: { 'shared-dep': '1.0.0' },
  })
  fs.writeFileSync(path.join(directory, 'payload.bin'), payload('admin-dep-v2', adminMiB * 1024 * 1024))
  const tar = path.join(work, 'admin-v2.tar')
  await command('tar', ['-cf', tar, '-C', path.dirname(directory), 'package'], work)
  const bytes = gzipSync(fs.readFileSync(tar), { level: 6 })
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64')
  blobs.set('/admin-dep-v2.tgz', bytes)
  const previous = packages.find(pkg => pkg.name === 'admin-dep')
  lockfile = lockfile.replaceAll('admin-dep@1.0.0', 'admin-dep@2.0.0')
    .replace('admin-dep: {specifier: 1.0.0, version: 1.0.0}', 'admin-dep: {specifier: 2.0.0, version: 2.0.0}')
    .replace(`${registry}/admin-dep.tgz`, `${registry}/admin-dep-v2.tgz`)
    .replace(previous.integrity, integrity)
  fs.writeFileSync(path.join(source, 'pnpm-lock.yaml'), lockfile)
  writeJson(path.join(source, 'apps/admin/package.json'), {
    name: 'admin', version: '1.0.0', dependencies: { 'admin-dep': '2.0.0' },
  })
  await command('git', ['add', '.'], source)
  await command('git', ['-c', 'user.name=pnpm demo', '-c', 'user.email=demo@example.invalid', 'commit', '--quiet', '-m', 'test: update admin dependency'], source)
}

try {
  if (values.groups) {
    await runGroupsDemo({ work, source, candidate, command, sparseCheckout, registry, cacheArchives, writeJson, demoRoot, updateAdmin })
  } else {
    const results = []
    results.push(await measure('baseline-full', values.baseline, false))
    results.push(await measure('baseline-filtered', values.baseline, true))
    results.push(await measure('candidate-full', candidate, false))
    results.push(await measure('candidate-filtered', candidate, true))
    const full = results[2]
    const scoped = results[3]
    const summary = {
      fixture: { actionMode: values.action, adminMiB, sparseDirectories: ['apps/web', 'packages/ui'], cacheCodec: 'tar + zstd level 3' },
      results,
      reduction: {
        packagePercent: 100 * (1 - scoped.packageBytes / full.packageBytes),
        cachePercent: 100 * (1 - scoped.cacheTransferBytes / full.cacheTransferBytes),
      },
    }
    const resultsFile = values.action ? 'action-results.json' : 'results.json'
    writeJson(path.join(work, resultsFile), summary)
    writeJson(path.join(demoRoot, resultsFile), summary)
    console.table(results.map(({ name, packageBytes, cacheTransferBytes, storeFiles, offlineInstall }) => ({ name, packageBytes, cacheTransferBytes, storeFiles, offlineInstall })))
    console.log(JSON.stringify({ reduction: summary.reduction, results: path.join(work, resultsFile) }, null, 2))
    if (values['expect-reduction']) {
      assert(!scoped.packageRequests.includes('/admin-dep.tgz'), 'unselected package must not be fetched')
      assert(scoped.packageBytes < full.packageBytes, 'package transfer must shrink')
      assert(scoped.cacheTransferBytes < full.cacheTransferBytes, 'compressed cache transfer must shrink')
    }
  }
} finally {
  await new Promise(resolve => server.close(resolve))
}
