import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { planGroups, selectChunks, encodeChunk, decodeChunk, sha256 } from './action/cache-groups.mjs'
import { resolveBinary } from './action/scoped-fetch.mjs'

function filesUnder(directory, relative = '') {
  const files = []
  for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name)
    if (entry.isDirectory()) files.push(...filesUnder(directory, name))
    else if (entry.isFile()) files.push(name)
    else throw new Error(`Unexpected store entry: ${name}`)
  }
  return files.sort()
}

function inventory(store) {
  const layouts = fs.readdirSync(store).filter(name => /^v[0-9]+$/.test(name))
  assert.equal(layouts.length, 1)
  const layout = layouts[0]
  assert(fs.existsSync(path.join(store, layout, 'index')), 'use the existing files index backend')
  assert(!fs.existsSync(path.join(store, layout, 'index.db')), 'do not merge SQLite databases')
  const files = filesUnder(path.join(store, layout, 'files')).map(relative => {
    const filename = path.join(store, layout, 'files', relative)
    const bytes = fs.readFileSync(filename)
    return { path: `${layout}/files/${relative}`, sha256: sha256(bytes), size: bytes.length,
      mode: fs.statSync(filename).mode & 0o111 ? 0o555 : 0o444 }
  })
  const indexPaths = ['index', 'index-aliases'].map(name => `${layout}/${name}`)
    .filter(relative => fs.existsSync(path.join(store, relative)))
  return { files, indexPaths, layout }
}

async function transfer(base, route, expected) {
  const response = await fetch(`${base}${route}`)
  assert.equal(response.status, 200)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.equal(sha256(bytes), expected)
  return bytes
}

export async function runGroupsDemo({ work, source, candidate, command, sparseCheckout, registry, cacheArchives, writeJson, demoRoot, updateAdmin }) {
  const directory = path.join(work, 'groups')
  fs.mkdirSync(directory)
  const entries = fs.readdirSync(path.join(source, 'apps')).sort().filter(name => fs.existsSync(path.join(source, 'apps', name, 'package.json'))).map(name => `apps/${name}`)
  assert.deepEqual(entries, ['apps/admin', 'apps/web'])
  candidate = await resolveBinary(candidate, source)
  const binaryHash = sha256(fs.readFileSync(candidate))
  const baseArgs = ['--config.manage-package-manager-versions=false', '--config.store-index-format=files', '--reporter=silent']
  const sources = new Map()
  const metadata = {}
  const inventories = {}
  const stores = {}
  const produce = async (entry, suffix = '') => {
    const name = entry.replace('/', '-') + suffix
    const checkout = path.join(directory, `${name}-checkout`)
    const store = path.join(directory, `${name}-store`)
    await sparseCheckout(checkout)
    await command(candidate, [...baseArgs, '--store-dir', store, 'fetch', `--filter={${entry}}...`, '--workspace-root'], checkout)
    return { ...inventory(store), store }
  }
  for (const entry of entries) {
    const result = await produce(entry)
    inventories[entry] = result.files
    stores[entry] = result.store
    for (const file of result.files) sources.set(file.path, path.join(result.store, file.path))
    const tar = path.join(directory, `${entry.replace('/', '-')}-index.tar`)
    const archive = `${tar}.zst`
    await command('tar', ['-cf', tar, '-C', result.store, ...result.indexPaths], directory)
    await command('zstd', ['-q', '-T1', '-3', '-f', tar, '-o', archive], directory)
    const bytes = fs.readFileSync(archive)
    metadata[entry] = { key: `pnpm-index-v1-${sha256(bytes)}`, size: bytes.length, sha256: sha256(bytes) }
    cacheArchives.set(`/groups/${metadata[entry].key}`, archive)
  }
  const context = {
    pnpm: binaryHash, node: process.versions.node, platform: process.platform, arch: process.arch,
    layout: inventory(stores[entries[0]]).layout, storeIndexFormat: 'files',
    workspaceConfig: sha256(fs.readFileSync(path.join(source, 'pnpm-workspace.yaml'))),
  }
  const manifest = planGroups(inventories, { context })
  for (const entry of entries) manifest.entries[entry].index = metadata[entry]
  const archives = {}
  for (const [key, chunk] of Object.entries(manifest.chunks)) {
    const bytes = encodeChunk(chunk, relative => fs.readFileSync(sources.get(relative)))
    const archive = path.join(directory, `${key}.json.gz`)
    fs.writeFileSync(archive, bytes)
    archives[key] = { size: bytes.length, sha256: sha256(bytes) }
    cacheArchives.set(`/groups/${key}`, archive)
  }
  manifest.archives = archives
  manifest.sourceLockfile = sha256(fs.readFileSync(path.join(source, 'pnpm-lock.yaml')))
  writeJson(path.join(directory, 'manifest.json'), manifest)
  writeJson(path.join(demoRoot, 'groups-manifest.json'), manifest)
  const cached = new Map()
  const requests = []
  const measurements = []
  for (const entry of ['apps/web', 'apps/admin']) {
    const selected = selectChunks(manifest, [entry])
    let downloaded = 0
    const restored = path.join(directory, `restore-${entry.replace('/', '-')}`)
    fs.mkdirSync(restored)
    for (const key of selected) {
      let bytes = cached.get(key)
      if (!bytes) {
        bytes = await transfer(registry, `/groups/${key}`, archives[key].sha256)
        downloaded += bytes.length
        requests.push(key)
        cached.set(key, bytes)
      }
      for (const file of decodeChunk(manifest.chunks[key], bytes)) {
        const filename = path.join(restored, file.path)
        fs.mkdirSync(path.dirname(filename), { recursive: true })
        fs.writeFileSync(filename, file.bytes, { flag: 'wx', mode: file.mode })
      }
    }
    const index = metadata[entry]
    const bytes = await transfer(registry, `/groups/${index.key}`, index.sha256)
    downloaded += bytes.length
    const archive = path.join(directory, `${entry.replace('/', '-')}-restored.tar.zst`)
    const tar = `${archive}.tar`
    fs.writeFileSync(archive, bytes)
    await command('zstd', ['-q', '-d', '-f', archive, '-o', tar], directory)
    await command('tar', ['-xf', tar, '-C', restored], directory)
    const checkout = path.join(directory, `restore-${entry.replace('/', '-')}-checkout`)
    await sparseCheckout(checkout, [entry, 'packages/ui'])
    await command(candidate, [...baseArgs, '--store-dir', restored, 'install', '--frozen-lockfile', '--offline', `--filter={${entry}}...`], checkout)
    const expression = entry === 'apps/web'
      ? "const assert = require('node:assert/strict'); assert.equal(require('web-dep'), 'web-dep:shared-dep'); assert.equal(require('ui'), 'ui:shared-dep')"
      : "require('node:assert/strict').equal(require('admin-dep'), 'admin-dep')"
    await command(process.execPath, ['-e', expression], path.join(checkout, entry))
    assert.equal(sha256(fs.readFileSync(path.join(checkout, 'pnpm-lock.yaml'))), manifest.sourceLockfile)
    measurements.push({ entry, chunks: selected.length, cacheTransferBytes: downloaded, offlineInstall: true, lockfileUnchanged: true })
  }
  const shared = Object.entries(manifest.chunks).filter(([, chunk]) => chunk.consumers.length > 1).map(([key]) => key)
  assert(shared.length > 0)
  for (const key of shared) assert.equal(requests.filter(request => request === key).length, 1)
  const webFiles = selectChunks(manifest, ['apps/web']).flatMap(key => manifest.chunks[key].files)
  assert(webFiles.reduce((sum, file) => sum + file.size, 0) < 1024 * 1024, 'web must exclude the admin payload')
  await updateAdmin()
  const updatedInventories = {}
  for (const entry of entries) updatedInventories[entry] = (await produce(entry, '-updated')).files
  const updatedManifest = planGroups(updatedInventories, { context })
  assert.deepEqual(selectChunks(updatedManifest, ['apps/web']), selectChunks(manifest, ['apps/web']))
  assert.notDeepEqual(selectChunks(updatedManifest, ['apps/admin']), selectChunks(manifest, ['apps/admin']))
  const fullTransferBytes = Object.values(archives).reduce((sum, archive) => sum + archive.size, 0) + Object.values(metadata).reduce((sum, index) => sum + index.size, 0)
  const summary = {
    pnpmVersion: await command(candidate, ['--version'], source),
    fixture: { entries, workspaceLibraries: ['packages/ui'], storeIndexFormat: 'files', codec: 'JSON + gzip level 3 (prototype)' },
    chunks: Object.keys(manifest.chunks).length, sharedChunks: shared.length, fullTransferBytes,
    measurements, webReductionPercent: 100 * (1 - measurements[0].cacheTransferBytes / fullTransferBytes),
    sharedChunkDownloadedOnce: true, webKeysUnchangedAfterAdminUpdate: true,
    sourceLockfileChanged: sha256(fs.readFileSync(path.join(source, 'pnpm-lock.yaml'))) !== manifest.sourceLockfile,
  }
  assert(summary.sourceLockfileChanged)
  writeJson(path.join(directory, 'results.json'), summary)
  writeJson(path.join(demoRoot, 'groups-results.json'), summary)
  console.table(measurements)
  console.log(JSON.stringify(summary, null, 2))
}
