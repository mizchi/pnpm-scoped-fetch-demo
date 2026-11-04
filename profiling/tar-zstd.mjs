import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { constants, createZstdCompress, createZstdDecompress } from 'node:zlib'
import tar from 'tar-stream'
import { normalizedFile } from '../action/chunk-identity.mjs'
import { storeDirectories } from './store-directories.mjs'

export const TAR_ZSTD_CODEC = 'tar + zstd level 3 (streaming v1)'

function integrityStream(expected = {}) {
  const algorithm = expected.algorithm ?? 'sha256'
  const hash = createHash(algorithm)
  let size = 0
  const stream = new Transform({
    transform(bytes, _encoding, callback) {
      size += bytes.length
      if (expected.size !== undefined && size > expected.size) return callback(new Error(`Content mismatch: ${expected.path}`))
      hash.update(bytes); callback(null, bytes)
    },
    flush(callback) {
      const sha256 = hash.digest('hex')
      stream.result = { size, [algorithm]: sha256 }
      if ((expected.size !== undefined && size !== expected.size) || ((expected.digest ?? expected.sha256) && sha256 !== (expected.digest ?? expected.sha256))) {
        callback(new Error(`Content mismatch: ${expected.path ?? 'archive'}`))
      } else callback()
    },
  })
  return stream
}

function manifestFiles(chunk) {
  const files = chunk.files.map(normalizedFile).sort((left, right) => left.path.localeCompare(right.path, 'en'))
  if (new Set(files.map(file => file.path)).size !== files.length) throw new Error('Duplicate manifest file')
  return files
}

function fixedBlocks() {
  const size = 128 * 1024
  let buffer = Buffer.allocUnsafe(size)
  let filled = 0
  return new Transform({
    transform(bytes, _encoding, callback) {
      let offset = 0
      while (offset < bytes.length) {
        const count = Math.min(size - filled, bytes.length - offset)
        bytes.copy(buffer, filled, offset, offset + count)
        offset += count; filled += count
        if (filled === size) {
          this.push(buffer)
          buffer = Buffer.allocUnsafe(size); filled = 0
        }
      }
      callback()
    },
    flush(callback) { if (filled) this.push(buffer.subarray(0, filled)); callback() },
  })
}

export async function writeTarChunk({ chunk, source, filename }) {
  const files = manifestFiles(chunk)
  const temporary = fs.mkdtempSync(path.join(path.dirname(filename), '.pack-'))
  const staged = path.join(temporary, 'archive')
  const pack = tar.pack()
  const digest = integrityStream()
  const output = pipeline(pack, fixedBlocks(), createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: 3, [constants.ZSTD_c_windowLog]: 21 } }),
    digest, fs.createWriteStream(staged, { flags: 'wx', mode: 0o444 }))
  const feeding = (async () => {
    for (const file of files) {
      const entry = pack.entry({ name: file.path, type: 'file', size: file.size, mode: file.mode,
        uid: 0, gid: 0, uname: '', gname: '', mtime: new Date(0) })
      await pipeline(source(file.path), integrityStream(file), entry)
    }
    pack.finalize()
  })()
  try {
    await Promise.all([output, feeding])
    fs.linkSync(staged, filename)
    return { ...digest.result, key: `pnpm-tar-zstd-v1-${digest.result.sha256}`, codec: TAR_ZSTD_CODEC }
  } catch (error) {
    pack.destroy(error)
    await Promise.allSettled([output, feeding])
    throw error
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}

function stagedFileSink(filename) {
  let descriptor = fs.openSync(filename, 'wx', 0o600)
  function close() {
    const current = descriptor
    descriptor = undefined
    if (current !== undefined) fs.closeSync(current)
  }
  return new Writable({
    write(bytes, _encoding, callback) {
      try {
        for (let offset = 0; offset < bytes.length;) {
          const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset)
          if (!written) throw new Error(`Unable to write staged file: ${filename}`)
          offset += written
        }
        callback()
      } catch (error) { callback(error) }
    },
    final(callback) { try { close(); callback() } catch (error) { callback(error) } },
    destroy(error, callback) { try { close(); callback(error) } catch (closeError) { callback(error ?? closeError) } },
  })
}

function chunkReader(chunk) {
  if (chunk.files) {
    const files = manifestFiles(chunk), expected = new Map(files.map(file => [file.path, file]))
    return { maxTarBytes: files.reduce((sum, file) => sum + Math.ceil(file.size / 512) * 512 + 4096 + Buffer.byteLength(file.path) * 4, 1024),
      file(header) { return expected.get(header.name) },
      finish(count) { if (count !== expected.size) throw new Error('Missing tar entries') } }
  }
  if (!/^v[0-9]+$/.test(chunk.layout)) throw new Error('Invalid store layout')
  if (chunk.kind === 'index') {
    const directories = new RegExp(`^${chunk.layout}/(index|index-aliases)(/[a-f0-9]{2})?/?$`)
    const files = new RegExp(`^${chunk.layout}/(index|index-aliases)/[a-f0-9]{2}/[a-f0-9]{62}$`)
    return { maxTarBytes: chunk.tarBytes,
      directory(header) { return header.size === 0 && directories.test(header.name) },
      file(header) {
        if (!files.test(header.name)) return undefined
        return { path: header.name, size: header.size, mode: 0o600, metadata: true }
      }, finish() {} }
  }
  if (chunk.kind !== 'cafs' || !Number.isSafeInteger(chunk.fileCount) || chunk.fileCount < 1 || !Number.isSafeInteger(chunk.rawBytes) || chunk.rawBytes < 0) throw new Error('Invalid CAFS bounds')
  let rawBytes = 0
  const filenames = new RegExp(`^${chunk.layout}/files/([a-f0-9]{2})/([a-f0-9]{126})(-exec)?$`)
  return { maxTarBytes: chunk.rawBytes + chunk.fileCount * 6144 + 1024,
    file(header) {
      const match = filenames.exec(header.name)
      if (!match) return undefined
      rawBytes += header.size
      if (rawBytes > chunk.rawBytes) throw new Error('CAFS size exceeds plan bounds')
      return { path: header.name, size: header.size, mode: match[3] ? 0o555 : 0o444, algorithm: 'sha512', digest: match[1] + match[2] }
    },
    finish(count) { if (count !== chunk.fileCount || rawBytes !== chunk.rawBytes) throw new Error('CAFS size or count differs from plan bounds') } }
}

function indexIdentityStream(file) {
  let prefix = Buffer.alloc(0)
  return new Transform({
    transform(bytes, _encoding, callback) {
      if (prefix.length < 4100) prefix = Buffer.concat([prefix, bytes.subarray(0, 4100 - prefix.length)])
      callback(null, bytes)
    },
    flush(callback) {
      const length = prefix.length >= 4 ? prefix.readUInt32LE() : 0
      const identity = length && length <= 4096 && length <= prefix.length - 4
        ? createHash('sha256').update(prefix.subarray(4, length + 4)).digest('hex') : ''
      callback(identity === file.path.split('/').slice(-2).join('') ? null : new Error(`Index identity mismatch: ${file.path}`))
    },
  })
}

async function readTarChunk({ chunk, input, archiveSha256, stage }) {
  if (!/^[a-f0-9]{64}$/.test(archiveSha256)) throw new Error('Expected archive SHA-256')
  const reader = chunkReader(chunk), seen = new Set(), staged = []
  let remaining = reader.maxTarBytes
  if (!Number.isSafeInteger(remaining) || remaining < 1024) throw new Error('Invalid tar size bounds')
  const limit = new Transform({ transform(bytes, _encoding, callback) {
    remaining -= bytes.length
    callback(remaining < 0 ? new Error('Tar exceeds manifest size limit') : null, bytes)
  } })
  const extract = tar.extract()
  const decoding = pipeline(input, integrityStream({ sha256: archiveSha256 }),
    createZstdDecompress({ params: { [constants.ZSTD_d_windowLogMax]: 23 } }), limit, extract)
  const entries = (async () => {
    for await (const entry of extract) {
      const header = entry.header
      if (header.type === 'directory' && reader.directory?.(header)) { entry.resume(); continue }
      const file = reader.file(header)
      if (!file || seen.has(header.name) || header.type !== 'file' || !Number.isSafeInteger(header.size) || header.size < 0 || header.size !== file.size || (!file.metadata && header.mode !== file.mode)) throw new Error(`Unexpected tar entry: ${header.name}`)
      seen.add(header.name)
      const filename = stage && path.join(stage, String(staged.length))
      const sink = filename ? stagedFileSink(filename) : new Writable({ write(_bytes, _encoding, callback) { callback() } })
      await pipeline(entry, integrityStream(file), ...(file.metadata ? [indexIdentityStream(file)] : []), sink)
      if (filename) { fs.utimesSync(filename, 0, 0); fs.chmodSync(filename, file.mode); staged.push({ file, filename }) }
    }
    reader.finish(seen.size)
  })()
  try {
    await Promise.all([decoding, entries])
    return staged
  } catch (error) {
    extract.destroy(error)
    input.destroy(error)
    await Promise.allSettled([decoding, entries])
    throw error
  }
}

export async function verifyTarChunk(options) {
  await readTarChunk(options)
}

async function verifiedExisting(filename, file) {
  let stat
  try { stat = fs.lstatSync(filename) } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe existing store file: ${filename}`)
  const discard = new Writable({ write(_bytes, _encoding, callback) { callback() } })
  await pipeline(fs.createReadStream(filename), file.metadata ? indexIdentityStream(file) : integrityStream(file), discard)
  return true
}

export async function restoreTarChunk({ directory, reuseExisting = false, ...options }) {
  const prepareParent = storeDirectories(directory, { create: true })
  const staged = fs.mkdtempSync(path.join(directory, '.chunk-'))
  try {
    const files = await readTarChunk({ ...options, stage: staged })
    for (const { file, filename } of files) {
      prepareParent(file.path)
      const target = path.join(directory, file.path)
      if (!reuseExisting || !await verifiedExisting(target, file)) fs.linkSync(filename, target)
    }
    return files.map(({ file }) => ({ path: file.path, size: file.size, mode: file.mode }))
  } finally { fs.rmSync(staged, { recursive: true, force: true }) }
}
