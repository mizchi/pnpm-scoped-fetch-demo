import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { sha256 } from '../../action/cache-groups.mjs'
import { selectStoreScope, exportScopedIndex } from '../scoped-index.mjs'

const graph = {
  'workspace:.': { dependencies: ['root@1', 'workspace:root-tool'] },
  'workspace:app': { dependencies: ['workspace:lib', 'app@1'] },
  'workspace:lib': { dependencies: ['lib@1', 'workspace:app'] },
  'workspace:root-tool': { dependencies: ['extra@1'] },
  'root@1': { dependencies: [] }, 'app@1': { dependencies: ['common@1'] },
  'lib@1': { dependencies: ['common@1'] }, 'common@1': { dependencies: [] }, 'extra@1': { dependencies: [] },
}
const full = {
  files: ['root@1', 'app@1', 'lib@1', 'common@1', 'extra@1'].map(id => ({ path: id })),
  filePackages: Object.fromEntries(['root@1', 'app@1', 'lib@1', 'common@1', 'extra@1'].map(id => [id, [id]])),
  indexEntries: ['root@1', 'app@1', 'lib@1', 'common@1', 'extra@1'].map(id => ({ packageId: id, key: `integrity\t${id}`, path: id })),
}
const packageIds = Object.fromEntries(full.indexEntries.map(entry => [entry.packageId, [entry.packageId]]))

test('workspace selection closes importer links before adding root tools', () => {
  const scope = selectStoreScope({ full, graph, packageIds, importers: ['app'] })
  assert.deepEqual(scope.files.map(file => file.path), ['root@1', 'app@1', 'lib@1', 'common@1'])
  assert.deepEqual(scope.importers, ['.', 'app', 'lib'])
  assert(!scope.packages.includes('extra@1'))
  assert.throws(() => selectStoreScope({ full, graph, packageIds, importers: ['missing'] }), /Missing package/)
})

test('index export copies only selected rows and aliases without copying payloads', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-scoped-index-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = path.join(directory, 'source'), output = path.join(directory, 'output')
  fs.mkdirSync(store); fs.mkdirSync(output)
  function row(folder, key, value) {
    const hash = sha256(key), relative = `v11/${folder}/${hash.slice(0, 2)}/${hash.slice(2)}`
    const filename = path.join(store, relative), header = Buffer.alloc(4)
    header.writeUInt32LE(Buffer.byteLength(key)); fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, Buffer.concat([header, Buffer.from(key), Buffer.from(value)]))
    return relative
  }
  const kept = row('index', 'integrity\tapp@1', 'kept'), omitted = row('index', 'integrity\textra@1', 'omitted')
  const alias = row('index-aliases', 'alias\tapp@1', 'integrity\tapp@1')
  const omittedAlias = row('index-aliases', 'alias\textra@1', 'integrity\textra@1')
  const scope = { indexEntries: [{ path: kept, key: 'integrity\tapp@1' }] }
  exportScopedIndex({ store, layout: 'v11', scope, directory: output })
  assert.deepEqual(fs.readFileSync(path.join(output, kept)), fs.readFileSync(path.join(store, kept)))
  assert(fs.existsSync(path.join(output, alias)))
  for (const relative of [omitted, omittedAlias, 'v11/files']) assert(!fs.existsSync(path.join(output, relative)))
})
