import fs from 'node:fs'
import path from 'node:path'
import { dependencyClosure } from '../action/chunk-policy.mjs'
import { sha256 } from '../action/cache-groups.mjs'
import { decodeStoreEntry } from './native-store.mjs'
import { filesUnder } from './store-snapshot.mjs'

export function selectWorkspaceImporters({ graph, importers }) {
  if (!importers.length) throw new Error('Select at least one importer')
  const isWorkspace = id => id.startsWith('workspace:')
  const projectGraph = Object.fromEntries(Object.entries(graph).filter(([id]) => isWorkspace(id))
    .map(([id, record]) => [id, { dependencies: record.dependencies.filter(isWorkspace) }]))
  const selected = dependencyClosure(importers.map(id => `workspace:${id}`), projectGraph, true)
  // Expanding root links would include unrelated workspace tools in every scope.
  selected.add('workspace:.')
  return selected
}

export function selectStoreScope({ full, graph, packageIds, importers }) {
  const isWorkspace = id => id.startsWith('workspace:')
  const selected = selectWorkspaceImporters({ graph, importers })
  const registryGraph = Object.fromEntries(Object.entries(graph).filter(([id]) => !isWorkspace(id))
    .map(([id, record]) => [id, { dependencies: record.dependencies.filter(id => !isWorkspace(id)) }]))
  const seeds = [...selected].flatMap(id => {
    if (!Object.hasOwn(graph, id)) throw new Error(`Missing package: ${id}`)
    return graph[id].dependencies.filter(id => !isWorkspace(id))
  })
  const reachable = dependencyClosure(seeds, registryGraph, true)
  const indexEntries = full.indexEntries.filter(entry => packageIds[entry.packageId].some(id => reachable.has(id)))
  const files = full.files.filter(file => full.filePackages[file.path].some(id => reachable.has(id)))
  return { files, indexEntries, packages: [...new Set(indexEntries.map(entry => entry.packageId))].sort(),
    importers: [...selected].map(id => id.slice('workspace:'.length)).sort() }
}

export function exportScopedIndex({ store, layout, scope, directory }) {
  fs.mkdirSync(path.join(directory, layout, 'index'), { recursive: true })
  function copy(relative) {
    const filename = path.join(directory, relative)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.copyFileSync(path.join(store, relative), filename, fs.constants.COPYFILE_EXCL)
  }
  for (const entry of scope.indexEntries) copy(entry.path)
  const keys = new Set(scope.indexEntries.map(entry => entry.key))
  const aliases = path.join(store, layout, 'index-aliases')
  if (fs.existsSync(aliases)) {
    for (const relative of filesUnder(aliases).filter(name => !path.basename(name).startsWith('.tmp'))) {
      const { key, data } = decodeStoreEntry(fs.readFileSync(path.join(aliases, relative)))
      if (relative.replace('/', '') !== sha256(key)) throw new Error(`Alias identity mismatch: ${relative}`)
      if (keys.has(data.toString('utf8'))) copy(`${layout}/index-aliases/${relative}`)
    }
  }
  return ['index', 'index-aliases'].map(name => `${layout}/${name}`).filter(relative => fs.existsSync(path.join(directory, relative)))
}
