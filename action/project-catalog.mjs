import { canonicalJson } from './chunk-identity.mjs'
import { createThinPlan, validateThinPlan, planId } from './cache-plan.mjs'

export const MAX_CATALOG_BYTES = 4 * 1024 * 1024

export function catalogId(context, targetBytes) {
  return planId({ ...context, mode: 'project-catalog', targetBytes })
}

function checkedImporter(importer) {
  if (typeof importer !== 'string' || !importer || importer.startsWith('/') || /[\\\x00-\x1f]/.test(importer) ||
      importer !== '.' && importer.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Invalid importer: ${importer}`)
}

export function createProjectCatalog({ material, context, targetBytes, sourceManifests }) {
  const projects = {}, objects = {}
  let index
  for (const entry of Object.keys(material.manifest.entries).sort()) {
    checkedImporter(entry)
    if (!material.manifest.entries[entry].imports.length) { projects[entry] = []; continue }
    const query = { ...context, entry, mode: 'chunks', targetBytes }
    const plan = createThinPlan({ material, entry, query })
    if (index && canonicalJson(index) !== canonicalJson(plan.index)) throw new Error('Project catalog requires a shared index')
    index = plan.index
    projects[entry] = plan.objects.map(object => object.id)
    for (const object of plan.objects) objects[object.id] = object
  }
  if (sourceManifests) for (const importer of Object.keys(projects)) {
    if (!/^[a-f0-9]{64}$/.test(sourceManifests[importer])) throw new Error(`Missing source manifest identity: ${importer}`)
  }
  const catalog = { version: 1, context, targetBytes, layout: material.context.layout, projects, objects, index, sourceManifests }
  if (Buffer.byteLength(JSON.stringify(catalog)) > MAX_CATALOG_BYTES) throw new Error('Project catalog exceeds its size limit')
  return catalog
}

export function selectProjectPlan({ catalog, context, importer }) {
  checkedImporter(importer)
  if (catalog.version !== 1 || canonicalJson(catalog.context) !== canonicalJson(context)) throw new Error('Project catalog context mismatch')
  if (!Number.isSafeInteger(catalog.targetBytes) || catalog.targetBytes < 1) throw new Error('Invalid catalog targetBytes')
  if (!Object.hasOwn(catalog.projects, importer)) throw new Error(`Unknown catalog importer: ${importer}`)
  const ids = catalog.projects[importer]
  if (!Array.isArray(ids)) throw new Error('Invalid catalog project references')
  if (!ids.length) return null
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate catalog object reference')
  const objects = ids.map(id => {
    if (!Object.hasOwn(catalog.objects, id)) throw new Error(`Missing catalog object: ${id}`)
    const object = catalog.objects[id]
    if (object.id !== id) throw new Error(`Catalog object identity mismatch: ${id}`)
    return object
  })
  return validateThinPlan({ version: 1, layout: catalog.layout, query: { ...context, entry: importer, mode: 'chunks', targetBytes: catalog.targetBytes },
    objects, index: catalog.index }, { ...context, entry: importer, mode: 'chunks', targetBytes: catalog.targetBytes })
}
