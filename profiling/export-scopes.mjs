import fs from 'node:fs'
import path from 'node:path'
import { lockfileGraph, readStore } from './native-store.mjs'
import { selectStoreScope, exportScopedIndex } from './scoped-index.mjs'
import { archiveIndex } from './index-archive.mjs'

export function exportStoreScopes({ store, lockfile, entries, directory }) {
  if (String(lockfile.lockfileVersion) !== '9.0') throw new Error('Expected a v9 lockfile')
  const { graph, packageIds } = lockfileGraph(lockfile)
  const full = readStore(store, packageIds)
  const inventories = { workspace: full.files }, indexes = {}, measurements = {}
  indexes.workspace = archiveIndex({ store, paths: full.indexPaths, archive: path.join(directory, 'index-workspace.tar.zst') })
  for (const entry of entries) {
    const begin = performance.now()
    const scope = selectStoreScope({ full, graph, packageIds, importers: [entry] })
    inventories[entry] = scope.files
    const name = encodeURIComponent(entry), destination = path.join(directory, `index-${name}`)
    fs.mkdirSync(destination)
    const paths = exportScopedIndex({ store, layout: full.layout, scope, directory: destination })
    indexes[entry] = archiveIndex({ store: destination, paths, archive: path.join(directory, `index-${name}.tar.zst`) })
    measurements[entry] = { files: scope.files.length, packages: scope.packages.length, selectedImporters: scope.importers,
      rawBytes: scope.files.reduce((sum, file) => sum + file.size, 0), indexBytes: indexes[entry].size, exportMs: performance.now() - begin }
  }
  return { full, graph, packageIds, inventories, indexes, measurements }
}
