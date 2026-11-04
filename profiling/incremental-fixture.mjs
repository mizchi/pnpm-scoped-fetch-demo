import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import tar from 'tar-stream'
import { stringify } from 'yaml'

export async function incrementalFixture(directory) {
  const archives = new Map(), packages = {}, snapshots = {}
  for (const [name, version, expression, peers] of [
    ['versioned-dep', '1.0.0', "'one'"], ['versioned-dep', '2.0.0', "'two'"],
    ['shared-dep', '1.0.0', "'shared'"], ['peer-consumer', '1.0.0', "require('versioned-dep')", { 'versioned-dep': '*' }],
  ]) {
    const manifest = { name, version, main: 'index.js', ...(peers ? { peerDependencies: peers, bin: { 'peer-version': 'cli.js' } } : {}) }
    const pack = tar.pack(), buffers = [], reading = (async () => { for await (const bytes of pack) buffers.push(bytes) })()
    for (const [filename, bytes, mode] of [
      ['package.json', JSON.stringify(manifest), 0o644], ['index.js', `module.exports=${expression}\n`, 0o644],
      ...(peers ? [['cli.js', "#!/usr/bin/env node\nconsole.log(require('./index.js'))\n", 0o755]] : []),
    ]) pack.entry({ name: `package/${filename}`, mode, type: 'file', mtime: new Date(0) }, bytes)
    pack.finalize(); await reading
    const bytes = gzipSync(Buffer.concat(buffers)), route = `/${name}-${version}.tgz`
    archives.set(route, bytes)
    packages[`${name}@${version}`] = { resolution: { tarball: route, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` },
      ...(peers ? { peerDependencies: peers, hasBin: true } : {}) }
    if (!peers) snapshots[`${name}@${version}`] = {}
  }
  for (const version of ['1.0.0', '2.0.0']) snapshots[`peer-consumer@1.0.0(versioned-dep@${version})`] = { dependencies: { 'versioned-dep': version } }
  const requests = [], server = createServer((request, response) => {
    requests.push(request.url)
    const bytes = archives.get(request.url)
    response.writeHead(bytes ? 200 : 404, bytes ? { 'content-length': bytes.length } : {})
    response.end(bytes)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  for (const record of Object.values(packages)) record.resolution.tarball = origin + record.resolution.tarball
  const importers = { '.': {} }
  function project(importer, manifest, dependencies) {
    const target = path.join(directory, importer); fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ ...manifest, version: '1.0.0' }))
    importers[importer] = { dependencies }
  }
  project('.', { name: 'root', private: true }, {})
  project('packages/ui', { name: 'ui', main: 'index.js', dependencies: { 'shared-dep': '1.0.0' } },
    { 'shared-dep': { specifier: '1.0.0', version: '1.0.0' } })
  fs.writeFileSync(path.join(directory, 'packages/ui/index.js'), "module.exports='ui:'+require('shared-dep')\n")
  for (const [importer, version] of [['apps/a', '1.0.0'], ['apps/b', '2.0.0']]) {
    const dependencies = { 'versioned-dep': { specifier: version, version },
      'peer-consumer': { specifier: '1.0.0', version: `1.0.0(versioned-dep@${version})` } }
    if (importer === 'apps/a') dependencies.ui = { specifier: 'workspace:*', version: 'link:../../packages/ui' }
    project(importer, { name: path.basename(importer), dependencies: Object.fromEntries(Object.entries(dependencies).map(([name, entry]) => [name, entry.specifier])) }, dependencies)
  }
  fs.writeFileSync(path.join(directory, 'pnpm-workspace.yaml'), stringify({ packages: ['apps/*', 'packages/*'], trustLockfile: true,
    dedupePeerDependents: false, storeIndexFormat: 'files', virtualStoreType: 'project', updateNotifier: false }))
  const lock = { lockfileVersion: '9.0', settings: { autoInstallPeers: true, excludeLinksFromLockfile: false }, importers, packages, snapshots }
  fs.writeFileSync(path.join(directory, 'pnpm-lock.yaml'), stringify(lock))
  return { requests, lock, close: () => new Promise(resolve => server.close(resolve)) }
}
