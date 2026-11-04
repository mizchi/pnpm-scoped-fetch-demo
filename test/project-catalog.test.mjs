import assert from 'node:assert/strict'
import test from 'node:test'
import { createProjectCatalog, selectProjectPlan, catalogId } from '../action/project-catalog.mjs'

const hash = value => value.repeat(64)
const context = { version: 1, lockfile: hash('a'), configuration: hash('b'), pnpm: hash('c'), platform: 'linux', arch: 'x64', node: '24.21.0' }
const index = { sha256: hash('d'), size: 100, tarBytes: 2048 }
const material = { sourceLockfile: context.lockfile, context: { layout: 'v11' }, manifest: {
  entries: { '.': { imports: [] }, 'apps/web': { imports: ['shared', 'web'], index }, 'apps/admin': { imports: ['shared', 'admin'], index } },
  chunks: Object.fromEntries(['shared', 'web', 'admin'].map(key => [key, { size: 10, files: [{ path: `/private/${key}` }] }])),
}, archives: { shared: { sha256: hash('e'), size: 10 }, web: { sha256: hash('f'), size: 11 }, admin: { sha256: hash('1'), size: 12 } } }

test('a global catalog supports every discovered importer without per-job declarations', () => {
  const catalog = createProjectCatalog({ material, context, targetBytes: 64 })
  assert.deepEqual(Object.keys(catalog.projects), ['.', 'apps/admin', 'apps/web'])
  assert(!JSON.stringify(catalog).includes('/private/'))
  const web = selectProjectPlan({ catalog, context, importer: 'apps/web' })
  assert.deepEqual(web.objects.map(object => object.id), [hash('e'), hash('f')])
  assert(!web.objects.some(object => object.id === hash('1')))
  assert.equal(web.query.entry, 'apps/web')
  assert.equal(selectProjectPlan({ catalog, context, importer: '.' }), null)
  assert.notEqual(catalogId(context, 64), catalogId({ ...context, lockfile: hash('2') }, 64))
})

test('foreign inputs, missing references, duplicate references, and traversal importers fail', () => {
  const catalog = createProjectCatalog({ material, context, targetBytes: 64 })
  assert.throws(() => selectProjectPlan({ catalog, context: { ...context, lockfile: hash('2') }, importer: 'apps/web' }), /context/)
  assert.throws(() => selectProjectPlan({ catalog, context, importer: '../escape' }), /importer/)
  assert.throws(() => selectProjectPlan({ catalog, context, importer: 'apps/unknown' }), /Unknown/)
  const duplicate = structuredClone(catalog); duplicate.projects['apps/web'].push(duplicate.projects['apps/web'][0])
  assert.throws(() => selectProjectPlan({ catalog: duplicate, context, importer: 'apps/web' }), /Duplicate/)
  const missing = structuredClone(catalog); delete missing.objects[hash('e')]
  assert.throws(() => selectProjectPlan({ catalog: missing, context, importer: 'apps/web' }), /Missing/)
})

test('producer manifest identities must cover all catalog importers', () => {
  assert.throws(() => createProjectCatalog({ material, context, targetBytes: 64, sourceManifests: {} }), /source manifest identity/)
  const sourceManifests = Object.fromEntries(Object.keys(material.manifest.entries).map(importer => [importer, hash('a')]))
  assert.deepEqual(createProjectCatalog({ material, context, targetBytes: 64, sourceManifests }).sourceManifests, sourceManifests)
})
