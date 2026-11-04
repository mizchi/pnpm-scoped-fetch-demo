import { constants } from 'node:buffer'
import { gunzipSync, gzipSync } from 'node:zlib'
import { canonicalJson, sha256, normalizedFile } from './chunk-identity.mjs'
import { partitionFiles } from './chunk-policy.mjs'
export { canonicalJson, sha256, validatePayloadPath } from './chunk-identity.mjs'

export function planGroups(inventories, { context, shards = 1, ...policy }) {
  if (!Number.isSafeInteger(shards) || shards < 1 || shards > 256) throw new Error('shards must be between 1 and 256')
  const files = new Map()
  const entryNames = Object.keys(inventories).sort()
  if (!entryNames.length) throw new Error('Expected at least one entry')
  for (const entry of entryNames) {
    for (const input of inventories[entry]) {
      const file = normalizedFile(input)
      const previous = files.get(file.path)
      if (previous && canonicalJson(previous.file) !== canonicalJson(file)) throw new Error(`Conflicting store file: ${file.path}`)
      const record = previous ?? { file, consumers: new Set() }
      record.consumers.add(entry)
      files.set(file.path, record)
    }
  }
  const partitions = partitionFiles([...files.values()], { shards, ...policy })
  const entries = Object.fromEntries(entryNames.map(entry => [entry, { imports: [] }]))
  const chunks = {}
  const manualGroups = Object.fromEntries((policy.manualGroups ?? []).map(group => [group.name, { imports: [] }]))
  for (const group of partitions) {
    group.files.sort((left, right) => left.path.localeCompare(right.path, 'en'))
    const key = `pnpm-group-v1-${sha256(canonicalJson({ context, files: group.files }))}`
    chunks[key] = { ...group, size: group.files.reduce((sum, file) => sum + file.size, 0) }
    for (const consumer of group.consumers) entries[consumer].imports.push(key)
    for (const name of group.groups) manualGroups[name].imports.push(key)
  }
  for (const entry of [...Object.values(entries), ...Object.values(manualGroups)]) entry.imports.sort()
  return { version: 1, context, entries, manualGroups, chunks: Object.fromEntries(Object.entries(chunks).sort(([left], [right]) => left.localeCompare(right, 'en'))) }
}

export function selectChunks(manifest, entries) {
  if (!entries.length) throw new Error('Select at least one entry')
  const selected = new Set()
  for (const name of entries) {
    if (!Object.hasOwn(manifest.entries, name)) throw new Error(`Unknown entry: ${name}`)
    for (const key of manifest.entries[name].imports) {
      if (!Object.hasOwn(manifest.chunks, key)) throw new Error(`Missing chunk: ${key}`)
      selected.add(key)
    }
  }
  return [...selected].sort()
}

export function selectManualChunks(manifest, groups) {
  if (!groups.length) throw new Error('Select at least one manual group')
  const keys = new Set()
  for (const name of groups) {
    if (!Object.hasOwn(manifest.manualGroups ?? {}, name)) throw new Error(`Unknown manual group: ${name}`)
    for (const key of manifest.manualGroups[name].imports) {
      if (!Object.hasOwn(manifest.chunks, key)) throw new Error(`Missing chunk: ${key}`)
      keys.add(key)
    }
  }
  return [...keys].sort()
}

export function chunkJsonLength(chunk) {
  return chunk.files.reduce((sum, input, index) => {
    const file = normalizedFile(input)
    return sum + JSON.stringify({ path: file.path, data: '' }).length + Math.ceil(file.size / 3) * 4 + (index ? 1 : 0)
  }, JSON.stringify({ version: 1, files: [] }).length)
}

export function encodeChunk(chunk, readFile) {
  if (chunkJsonLength(chunk) > constants.MAX_STRING_LENGTH) throw new Error('Chunk exceeds JSON codec limit; use a smaller targetBytes or a streaming codec')
  const files = chunk.files.map(input => {
    const file = normalizedFile(input)
    const bytes = readFile(file.path)
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw new Error(`Content mismatch: ${file.path}`)
    return { path: file.path, data: bytes.toString('base64') }
  })
  return gzipSync(JSON.stringify({ version: 1, files }), { level: 3 })
}

export function decodeChunk(chunk, archive) {
  const expected = chunk.files.map(normalizedFile)
  const limit = expected.reduce((sum, file) => sum + Math.ceil(file.size / 3) * 4 + file.path.length * 6 + 128, 1024)
  const envelope = JSON.parse(gunzipSync(archive, { maxOutputLength: limit }).toString('utf8'))
  if (envelope.version !== 1 || !Array.isArray(envelope.files) || envelope.files.length !== expected.length) {
    throw new Error('Invalid chunk envelope')
  }
  return expected.map((file, index) => {
    const encoded = envelope.files[index]
    if (encoded.path !== file.path || typeof encoded.data !== 'string') throw new Error(`Unexpected chunk file: ${encoded.path}`)
    const bytes = Buffer.from(encoded.data, 'base64')
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw new Error(`Content mismatch: ${file.path}`)
    return { ...file, bytes }
  })
}
