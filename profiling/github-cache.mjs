import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import * as cache from '@actions/cache'
import { cachePath, objectCacheKey, isStoreObject } from '../action/cache-plan.mjs'
import { MAX_CATALOG_BYTES } from '../action/project-catalog.mjs'

export async function fileDigest(filename) {
  const hash = createHash('sha256')
  for await (const bytes of fs.createReadStream(filename)) hash.update(bytes)
  return hash.digest('hex')
}

async function concurrent(items, limit, operation) {
  const results = [], workers = []
  let next = 0, failure
  for (let worker = 0; worker < Math.min(limit, items.length); worker++) {
    workers.push((async () => {
      while (next < items.length && !failure) {
        const index = next++
        try { results[index] = await operation(items[index]) } catch (error) { failure ??= error }
      }
    })())
  }
  await Promise.all(workers)
  if (failure) throw failure
  return results
}

function ensureParents(root, relative) {
  let directory = root
  for (const name of relative.split('/').slice(0, -1)) {
    directory = path.join(directory, name)
    try { fs.mkdirSync(directory) } catch (error) { if (error.code !== 'EEXIST') throw error }
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe cache directory: ${directory}`)
  }
}

export function createGitHubCacheTransport({ root, namespace = 'shared', concurrency = 4, api = cache }) {
  root = path.resolve(root)
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('Cache concurrency must be between 1 and 16')
  if (api === cache && fs.realpathSync(root) !== fs.realpathSync(process.cwd())) throw new Error('Run cache operations from the workspace root')
  async function restoreOne(object) {
    const relative = cachePath(object), key = objectCacheKey(object, namespace)
    ensureParents(root, relative)
    const started = performance.now()
    const matched = await api.restoreCache([relative], key, [], { downloadConcurrency: 1, timeoutInMs: 30000, segmentTimeoutInMs: 120000 })
    const hit = matched === key
    if (!hit) fs.rmSync(path.join(root, relative), { recursive: true, force: true })
    if (hit) {
      const stat = fs.lstatSync(path.join(root, relative))
      if (stat.isSymbolicLink() || (isStoreObject(object) ? !stat.isDirectory() : !stat.isFile())) throw new Error(`Invalid cached object: ${key}`)
      if (object.size !== undefined && stat.size !== object.size) throw new Error(`Cached object size mismatch: ${key}`)
      if (object.kind === 'plan' && stat.size > 128 * 1024) throw new Error('Cache plan exceeds 128 KiB')
      if (object.kind === 'catalog' && stat.size > MAX_CATALOG_BYTES) throw new Error('Project catalog exceeds its size limit')
    }
    return { key, hit, relative, restoreMs: performance.now() - started, innerBytes: hit && !isStoreObject(object) ? fs.statSync(path.join(root, relative)).size : 0 }
  }
  async function publish({ object, source }) {
    const relative = cachePath(object), key = objectCacheKey(object, namespace), destination = path.join(root, relative)
    ensureParents(root, relative)
    const matched = await api.restoreCache([relative], key, [], { lookupOnly: true })
    if (matched === key) return { key, hit: true, cacheId: undefined, saveMs: 0 }
    if (!fs.existsSync(destination)) {
      if (isStoreObject(object)) throw new Error('Stage the store at its fixed cache path before publishing')
      try { fs.linkSync(source, destination) } catch (error) {
        if (error.code !== 'EXDEV') throw error
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
      }
    }
    if (!isStoreObject(object)) {
      const expected = object.kind === 'plan' || object.kind === 'catalog' ? object.sha256 : object.id
      if (expected && await fileDigest(destination) !== expected) throw new Error(`Publish content mismatch: ${key}`)
    }
    const started = performance.now()
    const cacheId = await api.saveCache([relative], key)
    if (!(cacheId > 0)) throw new Error(`GitHub cache save failed: ${key}`)
    return { key, hit: false, cacheId, saveMs: performance.now() - started }
  }
  return { restoreOne, restoreMany: objects => concurrent(objects, concurrency, restoreOne),
    publishMany: records => {
      const unique = new Map(records.map(record => [objectCacheKey(record.object, namespace), record]))
      return concurrent([...unique.values()], concurrency, publish)
    } }
}

export async function cacheInventory({ repository, token, namespace, ref }) {
  const entries = new Map()
  for (let page = 1; page <= 50; page++) {
    const url = new URL(`https://api.github.com/repos/${repository}/actions/caches`)
    url.search = new URLSearchParams({ key: `pnpm-cg-${namespace}-`, ref, per_page: '100', page: String(page) }).toString()
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } })
    if (!response.ok) throw new Error(`Cache inventory request failed: HTTP ${response.status}`)
    const body = await response.json()
    for (const entry of body.actions_caches) entries.set(entry.key, { id: entry.id, bytes: entry.size_in_bytes, ref: entry.ref })
    if (body.actions_caches.length < 100) return entries
  }
  throw new Error('Cache inventory exceeded its page limit')
}
