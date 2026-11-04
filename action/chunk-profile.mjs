import { performance } from 'node:perf_hooks'
import { planGroups, selectChunks, encodeChunk, decodeChunk } from './cache-groups.mjs'

function timed(operation) {
  const start = performance.now()
  const value = operation()
  return { value, ms: performance.now() - start }
}

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right)
  return { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1), samples }
}

function materialize(snapshot, policy, readFile, iterations) {
  const times = { planMs: [], encodeMs: [], decodeVerifyMs: [] }
  let manifest
  let archiveSizes
  for (let iteration = 0; iteration < iterations; iteration++) {
    const plan = timed(() => planGroups(snapshot.inventories, { ...policy, context: snapshot.context,
      packageGraph: snapshot.packageGraph, filePackages: snapshot.filePackages }))
    manifest = plan.value
    times.planMs.push(plan.ms)
    archiveSizes = {}
    let encodeMs = 0
    let decodeVerifyMs = 0
    for (const [key, chunk] of Object.entries(manifest.chunks)) {
      const encoded = timed(() => encodeChunk(chunk, relative => readFile(snapshot, relative)))
      archiveSizes[key] = encoded.value.length
      encodeMs += encoded.ms
      decodeVerifyMs += timed(() => decodeChunk(chunk, encoded.value)).ms
    }
    times.encodeMs.push(encodeMs)
    times.decodeVerifyMs.push(decodeVerifyMs)
  }
  return { manifest, archiveSizes, timings: Object.fromEntries(Object.entries(times).map(([name, values]) => [name, summarize(values)])) }
}

function queryStats(snapshot, material, entry) {
  const keys = selectChunks(material.manifest, [entry])
  const transferredFiles = keys.flatMap(key => material.manifest.chunks[key].files)
  const needed = new Map(snapshot.inventories[entry].map(file => [file.path, file]))
  const extraRawBytes = transferredFiles.filter(file => !needed.has(file.path)).reduce((sum, file) => sum + file.size, 0)
  const neededRawBytes = [...needed.values()].reduce((sum, file) => sum + file.size, 0)
  const payloadArchiveBytes = keys.reduce((sum, key) => sum + material.archiveSizes[key], 0)
  const index = snapshot.indexes?.[entry]
  return { chunks: keys.length, payloadArchiveBytes, indexBytes: index?.size ?? 0,
    restoreBytes: payloadArchiveBytes + (index?.size ?? 0), restoreRequests: keys.length + (index ? 1 : 0),
    neededRawBytes, extraRawBytes, extraRawPercent: neededRawBytes ? 100 * extraRawBytes / neededRawBytes : 0 }
}

function reuseStats(material, previous, keys) {
  const newKeys = keys.filter(key => !Object.hasOwn(previous.archiveSizes, key))
  const total = keys.reduce((sum, key) => sum + material.archiveSizes[key], 0)
  const fresh = newKeys.reduce((sum, key) => sum + material.archiveSizes[key], 0)
  return { newPayloadArchiveBytes: fresh, newPayloadRequests: newKeys.length, payloadReusePercent: total ? 100 * (1 - fresh / total) : 100 }
}

function percentile(values, ratio) {
  return values.length ? [...values].sort((left, right) => left - right)[Math.ceil(values.length * ratio) - 1] : 0
}

export function paretoCandidates(rows, criteria) {
  return rows.filter(row => !rows.some(other =>
    criteria.every(field => other[field] <= row[field]) && criteria.some(field => other[field] < row[field])
  )).map(row => row.name)
}

function validateProfile(before, after, policies, iterations) {
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 20) throw new Error('iterations must be between 1 and 20')
  if (!Array.isArray(policies) || !policies.length) throw new Error('Expected at least one policy')
  if (after && JSON.stringify(Object.keys(before.inventories).sort()) !== JSON.stringify(Object.keys(after.inventories).sort())) throw new Error('Before and after snapshots must contain the same workloads')
  const seen = new Set()
  for (const policy of policies) {
    if (typeof policy.name !== 'string' || !policy.name) throw new Error('A policy needs a name')
    if (seen.has(policy.name)) throw new Error(`Duplicate policy: ${policy.name}`)
    seen.add(policy.name)
  }
}

function policyResult(before, after, policy, current, updated, baseline) {
  const compressedSizes = Object.values(current.archiveSizes)
  const entries = Object.fromEntries(Object.keys(before.inventories).sort().map(entry => {
    const stats = queryStats(before, current, entry)
    stats.policyTransition = reuseStats(current, baseline, selectChunks(current.manifest, [entry]))
    if (updated && Object.hasOwn(after.inventories, entry)) {
      const updatedKeys = selectChunks(updated.manifest, [entry])
      Object.assign(stats, reuseStats(updated, current, updatedKeys), {
        updatedRestoreBytes: queryStats(after, updated, entry).restoreBytes,
      })
    }
    return [entry, stats]
  }))
  return { name: policy.name, policy, policyTransition: reuseStats(current, baseline, Object.keys(current.archiveSizes)), chunks: compressedSizes.length,
    totalPayloadArchiveBytes: compressedSizes.reduce((sum, size) => sum + size, 0),
    compressedChunkP50: percentile(compressedSizes, 0.5), compressedChunkP95: percentile(compressedSizes, 0.95),
    compressedChunkMax: compressedSizes.reduce((maximum, size) => Math.max(maximum, size), 0),
    oversizedChunks: Object.values(current.manifest.chunks).filter(chunk => chunk.oversized).length,
    ...(updated ? reuseStats(updated, current, Object.keys(updated.archiveSizes)) : {}),
    objective: { restoreBytes: Object.values(entries).reduce((sum, entry) => sum + entry.restoreBytes, 0),
      restoreObjects: Object.values(entries).reduce((sum, entry) => sum + entry.restoreRequests, 0),
      ...(updated ? { newPayloadBytes: reuseStats(updated, current, Object.keys(updated.archiveSizes)).newPayloadArchiveBytes } : {}) },
    entries, timings: current.timings, ...(updated ? { updatedTimings: updated.timings } : {}) }
}

function profileReport(before, after, policies, results, iterations, codec) {
  const criteria = ['restoreBytes', 'restoreObjects', ...(after ? ['newPayloadBytes'] : [])]
  const frontier = new Set(paretoCandidates(results.map(result => ({ name: result.name, ...result.objective })), criteria))
  for (const result of results) result.paretoCandidate = frontier.has(result.name)
  return { version: 1, paretoCriteria: criteria, codec, iterations, context: before.context, baselinePolicy: policies[0].name,
    semantics: { restoreBytes: 'bytes for a fresh consumer, including its index when present',
      restoreRequests: 'logical archive objects, excluding cache API and segment requests',
      newPayloadArchiveBytes: 'new chunk objects absent from the previous snapshot, excluding indexes',
      policyTransition: 'new chunks required when moving from the first policy to this policy on the same snapshot',
      timings: 'local plan, full encode including source reads, and decode/verify; no network or native fetch time' }, policies: results }
}

export function profilePolicies({ before, after, policies, readFile, iterations = 3 }) {
  validateProfile(before, after, policies, iterations)
  let baseline
  const results = policies.map(policy => {
    const current = materialize(before, policy, readFile, iterations)
    baseline ??= current
    const updated = after ? materialize(after, policy, readFile, iterations) : undefined
    return policyResult(before, after, policy, current, updated, baseline)
  })
  return profileReport(before, after, policies, results, iterations, 'JSON + gzip level 3 (prototype)')
}

export async function profileArchivePolicies({ before, after, policies, materialize, codec, iterations = 3 }) {
  validateProfile(before, after, policies, iterations)
  const results = []
  let baseline
  for (const policy of policies) {
    const current = await materialize(before, policy, iterations)
    baseline ??= current
    const updated = after ? await materialize(after, policy, iterations) : undefined
    results.push(policyResult(before, after, policy, current, updated, baseline))
  }
  return profileReport(before, after, policies, results, iterations, codec)
}
