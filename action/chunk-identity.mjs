import { createHash } from 'node:crypto'

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

export function normalizedFile(file) {
  validatePayloadPath(file.path)
  if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 ||
      ![0o444, 0o555].includes(file.mode)) throw new Error(`Invalid file descriptor: ${file.path}`)
  return { path: file.path, sha256: file.sha256, size: file.size, mode: file.mode }
}
