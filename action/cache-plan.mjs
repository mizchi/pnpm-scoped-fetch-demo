import { canonicalJson, sha256 } from './chunk-identity.mjs'

function digest(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid object digest')
  return value
}

function namespaceName(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) throw new Error('Invalid cache namespace')
  return value
}

export function planId(query) { return sha256(canonicalJson(query)) }
export function planCacheKey(query, namespace = 'shared') { return `pnpm-cg-${namespaceName(namespace)}-plan-${planId(query)}` }
export function planPath(query) { return `.pnpm-cache/plans/${planId(query)}.json` }
export function objectCacheKey(object, namespace = 'shared') { cachePath(object); return `pnpm-cg-${namespaceName(namespace)}-${object.kind}-${digest(object.id)}` }
export function isStoreObject(object) { return object.kind === 'whole' || object.kind === 'scoped' }

export function cachePath(object) {
  digest(object.id)
  switch (object.kind) {
    case 'cafs': return `.pnpm-cache/objects/${object.id}.tar.zst`
    case 'index': return `.pnpm-cache/indexes/${object.id}.tar.zst`
    case 'plan': return `.pnpm-cache/plans/${object.id}.json`
    case 'catalog': return `.pnpm-cache/catalogs/${object.id}.json`
    case 'whole': return '.pnpm-cache/whole-store'
    case 'scoped': return `.pnpm-cache/scoped-stores/${object.id}`
    default: throw new Error(`Unknown cache object kind: ${object.kind}`)
  }
}

export function createThinPlan({ material, entry, query }) {
  if (query.lockfile !== material.sourceLockfile || query.entry !== entry) throw new Error('Material does not match the query')
  const selected = material.manifest.entries[entry]
  if (!selected) throw new Error(`Unknown workload: ${entry}`)
  const objects = selected.imports.map(key => {
    const chunk = material.manifest.chunks[key], archive = material.archives[key]
    return { kind: 'cafs', id: archive.sha256, size: archive.size, rawBytes: chunk.size, fileCount: chunk.files.length }
  }).sort((left, right) => left.id.localeCompare(right.id, 'en'))
  const index = selected.index
  const plan = { version: 1, query, layout: material.context.layout, objects,
    index: { kind: 'index', id: index.sha256, size: index.size, tarBytes: index.tarBytes } }
  validateThinPlan(plan, query)
  return plan
}

export function validateThinPlan(plan, query) {
  if (plan.version !== 1) throw new Error('Unsupported plan version')
  if (canonicalJson(plan.query) !== canonicalJson(query)) throw new Error('Cache plan query mismatch')
  if (!/^v[0-9]+$/.test(plan.layout) || !Array.isArray(plan.objects)) throw new Error('Invalid plan layout or object list')
  const store = query.mode === 'whole' || query.mode === 'scoped'
  if (!['chunks', 'whole', 'scoped'].includes(query.mode) || !plan.objects.length || plan.objects.length > 4096) throw new Error('Invalid plan objects')
  const seen = new Set()
  for (const object of [...plan.objects, ...(plan.index ? [plan.index] : [])]) {
    cachePath(object)
    if (seen.has(`${object.kind}:${object.id}`)) throw new Error('Duplicate plan object')
    seen.add(`${object.kind}:${object.id}`)
    const fields = object.kind === 'index' ? ['size', 'tarBytes'] : object.kind === 'cafs' ? ['size', 'rawBytes', 'fileCount'] : ['rawBytes', 'fileCount']
    if (fields.some(field => !Number.isSafeInteger(object[field]) || object[field] < 0) ||
        (object.fileCount !== undefined && (!object.fileCount || !Number.isSafeInteger(object.rawBytes + object.fileCount * 6144 + 1024)))) throw new Error('Invalid object bounds')
  }
  if (store ? plan.objects.length !== 1 || plan.objects[0].kind !== query.mode || plan.index : plan.objects.some(object => object.kind !== 'cafs') || plan.index?.kind !== 'index') throw new Error('Invalid plan composition')
  return plan
}
