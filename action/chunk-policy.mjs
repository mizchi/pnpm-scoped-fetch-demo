import { canonicalJson, sha256 } from './chunk-identity.mjs'

export function partitionFiles(records, options) {
  const allowed = new Set(['shards', 'targetBytes', 'manualGroups', 'packageGraph', 'filePackages', 'name'])
  for (const field of Object.keys(options)) if (!allowed.has(field)) throw new Error(`Unknown chunk policy field: ${field}`)
  const { shards = 1, targetBytes, manualGroups = [], packageGraph = {}, filePackages = {} } = options
  if (!Array.isArray(manualGroups)) throw new Error('manualGroups must be an array')
  if (targetBytes !== undefined && (!Number.isSafeInteger(targetBytes) || targetBytes < 1)) throw new Error('targetBytes must be a positive integer')
  const rules = compileRules(manualGroups, packageGraph)
  const pools = new Map()
  for (const record of records) {
    const owners = filePackages[record.file.path] ?? []
    if (!Array.isArray(owners)) throw new Error(`Package owners must be an array: ${record.file.path}`)
    for (const owner of owners) if (!Object.hasOwn(packageGraph, owner)) throw new Error(`Missing package: ${owner}`)
    const names = rules.filter(rule => owners.some(owner => rule.packages.has(owner))).map(rule => rule.name).sort()
    const consumers = [...record.consumers].sort()
    const hash = sha256(record.file.path)
    const shard = Number.parseInt(hash.slice(0, 8), 16) % shards
    const poolKey = canonicalJson(names.length ? ['manual', names] : ['auto', consumers, shard])
    const pool = pools.get(poolKey) ?? { groups: names, records: [] }
    pool.records.push({ ...record, hash })
    pools.set(poolKey, pool)
  }
  return [...pools.values()].flatMap(pool => splitBySize(pool.records, targetBytes).map(records => ({
    groups: pool.groups,
    consumers: [...new Set(records.flatMap(record => [...record.consumers]))].sort(),
    files: records.map(record => record.file),
    oversized: targetBytes !== undefined && records.some(record => record.file.size > targetBytes),
  })))
}

function compileRules(groups, graph) {
  const seen = new Set()
  return groups.map(group => {
    if (typeof group.name !== 'string' || !group.name || !Array.isArray(group.packages) || !group.packages.length) throw new Error('A manual group needs a name and package selectors')
    if (group.includeDependencies !== undefined && typeof group.includeDependencies !== 'boolean') throw new Error('includeDependencies must be boolean')
    if (seen.has(group.name)) throw new Error(`Duplicate manual group: ${group.name}`)
    seen.add(group.name)
    const selected = group.packages.flatMap(selector => {
      const ids = Object.hasOwn(graph, selector) ? [selector] : Object.keys(graph).filter(id => graph[id].name === selector)
      if (!ids.length) throw new Error(`Unknown package selector: ${selector}`)
      return ids
    })
    return { name: group.name, packages: dependencyClosure(selected, graph, group.includeDependencies !== false) }
  })
}

export function dependencyClosure(initial, graph, includeDependencies) {
  const visited = new Set()
  const pending = [...initial]
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index]
    if (visited.has(id)) continue
    if (!Object.hasOwn(graph, id)) throw new Error(`Missing package: ${id}`)
    visited.add(id)
    if (includeDependencies) pending.push(...(graph[id].dependencies ?? []))
  }
  return visited
}

function splitBySize(records, targetBytes) {
  if (targetBytes === undefined) return [records]
  const oversized = records.filter(record => record.file.size > targetBytes).map(record => [record])
  const remainder = records.filter(record => record.file.size <= targetBytes)
  return [...oversized, ...splitByHash(remainder, targetBytes, 0)]
}

function splitByHash(records, targetBytes, bit) {
  if (!records.length) return []
  if (records.reduce((sum, record) => sum + record.file.size, 0) <= targetBytes) return [records]
  if (bit >= 256) throw new Error('Cannot partition colliding file identities within targetBytes')
  const left = []
  const right = []
  const position = Math.floor(bit / 4)
  const mask = 1 << (3 - bit % 4)
  for (const record of records) {
    const target = Number.parseInt(record.hash[position], 16) & mask ? right : left
    target.push(record)
  }
  return [...splitByHash(left, targetBytes, bit + 1), ...splitByHash(right, targetBytes, bit + 1)]
}
