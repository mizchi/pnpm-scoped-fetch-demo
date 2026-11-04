import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { restoreTarChunk } from './tar-zstd.mjs'

export class ProjectCacheMiss extends Error {}

function markerComplete({ object, layout, store, marker }) {
  let saved
  try { saved = JSON.parse(fs.readFileSync(marker, 'utf8')) } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error }
  if (saved.id !== object.id || !Array.isArray(saved.files) || !saved.files.length) return false
  if (object.kind === 'cafs' && (saved.files.length !== object.fileCount || saved.files.reduce((sum, file) => sum + file.size, 0) !== object.rawBytes)) return false
  const seen = new Set()
  for (const file of saved.files) {
    const allowed = object.kind === 'cafs' ? new RegExp(`^${layout}/files/[a-f0-9]{2}/[a-f0-9]{126}(-exec)?$`) : new RegExp(`^${layout}/index(-aliases)?/[a-f0-9]{2}/[a-f0-9]{62}$`)
    if (!allowed.test(file.path) || seen.has(file.path)) return false
    seen.add(file.path)
    let parent = store
    try {
      for (const component of file.path.split('/').slice(0, -1)) {
        parent = path.join(parent, component)
        const stat = fs.lstatSync(parent)
        if (!stat.isDirectory() || stat.isSymbolicLink()) return false
      }
      const stat = fs.lstatSync(path.join(store, file.path))
      // Native installs may update index metadata after a chunk is hydrated.
      if (!stat.isFile() || stat.isSymbolicLink() || object.kind === 'cafs' && (stat.size !== file.size || (stat.mode & 0o777) !== file.mode)) return false
      if (object.kind === 'cafs') {
        const digest = createHash('sha512').update(fs.readFileSync(path.join(store, file.path))).digest('hex')
        const expected = file.path.split('/').slice(-2).join('').replace(/-exec$/, '')
        if (digest !== expected) throw new Error(`Content mismatch: ${file.path}`)
      }
    } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  }
  return true
}

export async function hydrateProject({ plan, store, stateDirectory, restore, archivePath }) {
  fs.mkdirSync(store, { recursive: true }); fs.mkdirSync(stateDirectory, { recursive: true })
  const requested = [], skipped = [], paths = new Map()
  for (const object of [plan.index, ...plan.objects]) {
    const marker = path.join(stateDirectory, `${object.id}.json`)
    paths.set(object.id, marker)
    if (markerComplete({ object, layout: plan.layout, store, marker })) skipped.push(object)
    else requested.push(object)
  }
  const started = performance.now(), restored = requested.length ? await restore(requested) : []
  if (restored.length !== requested.length || restored.some(row => !row.hit)) throw new ProjectCacheMiss('Required project cache object is missing')
  const restoreMs = performance.now() - started, hydrateStart = performance.now()
  for (const object of requested) {
    const files = await restoreTarChunk({ chunk: { ...object, layout: plan.layout }, archiveSha256: object.id,
      input: fs.createReadStream(archivePath(object)), directory: store, reuseExisting: true })
    const marker = paths.get(object.id), temporary = `${marker}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify({ id: object.id, files })); fs.renameSync(temporary, marker)
  }
  return { restored, requestedObjects: requested.length, skippedObjects: skipped.length, restoreMs, hydrateMs: performance.now() - hydrateStart }
}
