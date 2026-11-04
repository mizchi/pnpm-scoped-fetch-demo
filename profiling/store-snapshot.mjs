import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { sha256 } from '../action/cache-groups.mjs'

export function filesUnder(directory, relative = '') {
  const files = []
  for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name)
    if (entry.isDirectory()) files.push(...filesUnder(directory, name))
    else if (entry.isFile()) files.push(name)
    else throw new Error(`Unexpected store entry: ${name}`)
  }
  return files.sort()
}

export function fixtureSnapshot({ inventories, stores, packageDirectory, context, indexes }) {
  const packages = fs.readdirSync(packageDirectory).map(name => {
    const directory = path.join(packageDirectory, name, 'package')
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    return { directory, manifest, id: `${manifest.name}@${manifest.version}` }
  })
  const ids = new Map(packages.map(pkg => [pkg.manifest.name, pkg.id]))
  const graph = Object.fromEntries(packages.map(pkg => [pkg.id, {
    name: pkg.manifest.name, dependencies: Object.keys(pkg.manifest.dependencies ?? {}).map(name => {
      assert(ids.has(name), `Missing fixture package: ${name}`)
      return ids.get(name)
    }),
  }]))
  const owners = new Map()
  for (const pkg of packages) {
    for (const relative of filesUnder(pkg.directory)) {
      const hash = sha256(fs.readFileSync(path.join(pkg.directory, relative)))
      const names = owners.get(hash) ?? new Set()
      names.add(pkg.id)
      owners.set(hash, names)
    }
  }
  const sourceFiles = {}
  const filePackages = {}
  for (const [entry, files] of Object.entries(inventories)) {
    for (const file of files) {
      sourceFiles[file.path] = path.join(stores[entry], file.path)
      assert(owners.has(file.sha256), `No fixture package owns ${file.path}`)
      filePackages[file.path] = [...owners.get(file.sha256)].sort()
    }
  }
  return { context, inventories, indexes, sourceFiles, filePackages, packageGraph: graph }
}
