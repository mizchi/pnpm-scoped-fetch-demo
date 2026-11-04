import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Unpackr } from 'msgpackr'
import { parse, refToRelative, tryGetPackageId } from '@pnpm/deps.path'
import { filesUnder } from './store-snapshot.mjs'

const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex')
const unpacker = new Unpackr({ mapsAsObjects: true })

export function decodeStoreEntry(bytes) {
  if (bytes.length < 4) throw new Error('Invalid index header')
  const length = bytes.readUInt32LE()
  if (!length || length > bytes.length - 4) throw new Error('Invalid index key length')
  return { key: bytes.subarray(4, length + 4).toString('utf8'), data: bytes.subarray(length + 4) }
}

export function decodeIndexEntry(bytes) {
  const { key, data } = decodeStoreEntry(bytes)
  const separator = key.indexOf('\t')
  if (separator < 1) throw new Error(`Invalid package index key: ${key}`)
  return { key, packageId: key.slice(separator + 1), value: unpacker.unpack(data) }
}

export function lockfileGraph(lockfile) {
  const graph = {}
  const packageIds = {}
  for (const id of Object.keys(lockfile.snapshots ?? {})) {
    const parsed = parse(id)
    const name = parsed.name
    if (!name || !parsed.version || parsed.nonSemverVersion || parsed.patchHash || parsed.registryName) throw new Error(`Unsupported lockfile package identity: ${id}`)
    graph[id] = { name, dependencies: [] }
    const packageId = tryGetPackageId(id)
    ;(packageIds[packageId] ??= []).push(id)
  }
  for (const id of Object.keys(lockfile.importers ?? {})) graph[`workspace:${id}`] = { name: `workspace:${id}`, dependencies: [] }
  function dependencies(record, importer) {
    const edges = Object.entries({ ...record.dependencies, ...record.optionalDependencies, ...(importer === undefined ? {} : record.devDependencies) })
    return [...new Set(edges.map(([alias, value]) => {
      const reference = typeof value === 'string' ? value : value.version
      const target = reference.startsWith('link:')
        ? `workspace:${path.posix.normalize(path.posix.join(importer ?? '.', reference.slice(5)))}`
        : refToRelative(reference, alias)
      if (!target || !Object.hasOwn(graph, target)) throw new Error(`Missing lockfile dependency: ${alias} -> ${reference} (${importer ?? 'snapshot'})`)
      return target
    }))].sort()
  }
  for (const [id, record] of Object.entries(lockfile.snapshots ?? {})) graph[id].dependencies = dependencies(record)
  for (const [id, record] of Object.entries(lockfile.importers ?? {})) graph[`workspace:${id}`].dependencies = dependencies(record, id)
  return { graph, packageIds }
}

export function readStore(store, packageIds) {
  const layouts = fs.readdirSync(store).filter(name => /^v[0-9]+$/.test(name))
  if (layouts.length !== 1) throw new Error(`Expected one store layout: ${store}`)
  const layout = layouts[0]
  const index = path.join(store, layout, 'index')
  if (!fs.statSync(index).isDirectory()) throw new Error(`Expected files index: ${index}`)
  const files = new Map()
  const filePackages = {}
  const sourceFiles = {}
  const packages = new Set()
  const indexEntries = []
  for (const relative of filesUnder(index).filter(name => !path.basename(name).startsWith('.tmp'))) {
    const { key, packageId, value } = decodeIndexEntry(fs.readFileSync(path.join(index, relative)))
    if (relative.replace('/', '') !== hash('sha256', key)) throw new Error(`Index identity mismatch: ${relative}`)
    const owners = packageIds[packageId]
    if (!owners) throw new Error(`Store package absent from lockfile: ${packageId}`)
    if (value.algo !== 'sha512' || value.sideEffects) throw new Error(`Unsupported store content: ${packageId}`)
    packages.add(packageId)
    indexEntries.push({ packageId, key, path: `${layout}/index/${relative}` })
    for (const info of Object.values(value.files)) {
      if (!/^[a-f0-9]{128}$/.test(info.digest) || !Number.isSafeInteger(info.size) || info.size < 0) throw new Error(`Invalid file metadata: ${packageId}`)
      const executable = (info.mode & 0o111) !== 0
      const name = `${layout}/files/${info.digest.slice(0, 2)}/${info.digest.slice(2)}${executable ? '-exec' : ''}`
      const previous = files.get(name)
      if (previous && previous.size !== info.size) throw new Error(`Conflicting file size: ${name}`)
      if (!previous) {
        const filename = path.join(store, name)
        const bytes = fs.readFileSync(filename)
        if (bytes.length !== info.size || hash('sha512', bytes) !== info.digest) throw new Error(`Content mismatch: ${name}`)
        files.set(name, { path: name, size: bytes.length, mode: executable ? 0o555 : 0o444, sha256: hash('sha256', bytes) })
        sourceFiles[name] = filename
      }
      const names = filePackages[name] ??= new Set()
      for (const owner of owners) names.add(owner)
    }
  }
  const actual = filesUnder(path.join(store, layout, 'files'))
  if (actual.length !== files.size) throw new Error(`Unindexed store files: actual ${actual.length}, indexed ${files.size}`)
  return { layout, indexEntries, files: [...files.values()].sort((left, right) => left.path.localeCompare(right.path, 'en')),
    filePackages: Object.fromEntries(Object.entries(filePackages).map(([name, owners]) => [name, [...owners].sort()])), sourceFiles,
    packages: [...packages].sort(), indexPaths: ['index', 'index-aliases'].filter(name => fs.existsSync(path.join(store, layout, name))).map(name => `${layout}/${name}`) }
}
