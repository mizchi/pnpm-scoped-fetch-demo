import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Expected JSON context')
  return encoded
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function validatePayloadPath(relative) {
  if (typeof relative !== 'string' || !/^v[0-9]+\/files\/.+/.test(relative) ||
      relative.includes('\\') || relative.includes('\0') ||
      relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid payload path: ${relative}`)
  }
}

function normalizedFile(file) {
  validatePayloadPath(file.path)
  if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 ||
      ![0o444, 0o555].includes(file.mode)) throw new Error(`Invalid file descriptor: ${file.path}`)
  return { path: file.path, sha256: file.sha256, size: file.size, mode: file.mode }
}

export function planGroups(inventories, { context, shards = 1 }) {
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
  const groups = new Map()
  for (const { file, consumers } of files.values()) {
    const sortedConsumers = [...consumers].sort()
    const shard = Number.parseInt(sha256(file.path).slice(0, 8), 16) % shards
    const groupId = canonicalJson([sortedConsumers, shard])
    const group = groups.get(groupId) ?? { consumers: sortedConsumers, files: [] }
    group.files.push(file)
    groups.set(groupId, group)
  }
  const entries = Object.fromEntries(entryNames.map(entry => [entry, { imports: [] }]))
  const chunks = {}
  for (const group of groups.values()) {
    group.files.sort((left, right) => left.path.localeCompare(right.path, 'en'))
    const key = `pnpm-group-v1-${sha256(canonicalJson({ context, files: group.files }))}`
    chunks[key] = { ...group, size: group.files.reduce((sum, file) => sum + file.size, 0) }
    for (const consumer of group.consumers) entries[consumer].imports.push(key)
  }
  for (const entry of Object.values(entries)) entry.imports.sort()
  return { version: 1, context, entries, chunks: Object.fromEntries(Object.entries(chunks).sort(([left], [right]) => left.localeCompare(right, 'en'))) }
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


export function encodeChunk(chunk, readFile) {
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
