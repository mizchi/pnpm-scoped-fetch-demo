import assert from 'node:assert/strict'
import test from 'node:test'
import { planGroups, selectChunks, selectManualChunks, sha256 } from '../action/cache-groups.mjs'

const file = (name, size = 8) => ({ path: `v11/files/ab/${name}`, sha256: sha256(name), size, mode: 0o444 })
const context = { layout: 'v11', platform: 'test' }
const input = { build: [file('a'), file('b'), file('c'), file('d')], lint: [file('c')] }
const graph = {
  'app@1': { name: 'app', dependencies: ['shared@1'] },
  'tool@1': { name: 'tool', dependencies: ['shared@1'] },
  'shared@1': { name: 'shared', dependencies: [] },
}
const filePackages = Object.fromEntries(input.build.map((item, index) => [item.path, [['app@1'], ['tool@1'], ['shared@1'], ['app@1']][index]]))

function plan(options = {}, inventories = input) {
  return planGroups(inventories, { context, ...options })
}

test('automatic byte budgets retain exact required content without directory inputs', () => {
  const manifest = plan({ targetBytes: 16 })
  assert(Object.values(manifest.chunks).every(chunk => chunk.size <= 16))
  assert.deepEqual(selectChunks(manifest, ['lint']).flatMap(key => manifest.chunks[key].files), [file('c')])
  assert.equal(Object.values(manifest.chunks).flatMap(chunk => chunk.files).length, 4)
})

test('an indivisible file exceeding the target is isolated and reported', () => {
  const manifest = plan({ targetBytes: 16 }, { build: [file('huge', 100), file('small', 3)] })
  const oversized = Object.values(manifest.chunks).filter(chunk => chunk.oversized)
  assert.equal(oversized.length, 1)
  assert.deepEqual(oversized[0].files, [file('huge', 100)])
})

test('manual groups resolve package names and follow dependencies through cycles', () => {
  const packageGraph = { ...graph, 'shared@1': { name: 'shared', dependencies: ['app@1'] } }
  const manifest = plan({ packageGraph, filePackages, manualGroups: [{ name: 'runtime', packages: ['app'] }] })
  const files = selectManualChunks(manifest, ['runtime']).flatMap(key => manifest.chunks[key].files)
  assert.deepEqual(files.map(file => file.path).sort(), [file('a').path, file('c').path, file('d').path].sort())
})

test('overlapping manual groups share payloads and manual grouping may introduce overfetch', () => {
  const manifest = plan({ packageGraph: graph, filePackages, manualGroups: [
    { name: 'runtime', packages: ['app', 'tool'] }, { name: 'shared', packages: ['shared'] },
  ] })
  assert.equal(Object.values(manifest.chunks).flatMap(chunk => chunk.files).length, 4)
  const shared = selectManualChunks(manifest, ['shared'])
  assert(shared.every(key => selectManualChunks(manifest, ['runtime']).includes(key)))
  assert(selectChunks(manifest, ['lint']).flatMap(key => manifest.chunks[key].files).every(file => file.path === input.lint[0].path))
  const mixed = plan({ packageGraph: graph, filePackages, manualGroups: [{ name: 'everything', packages: ['app', 'tool'] }] })
  assert.equal(selectChunks(mixed, ['lint']).flatMap(key => mixed.chunks[key].files).length, 4)
})

test('hybrid policy applies byte budgets inside manual groups', () => {
  const manifest = plan({ targetBytes: 16, packageGraph: graph, filePackages,
    manualGroups: [{ name: 'all', packages: ['app', 'tool'] }] })
  assert(selectManualChunks(manifest, ['all']).length > 1)
  assert(Object.values(manifest.chunks).every(chunk => chunk.size <= 16))
})

test('invalid or ambiguous policy input fails before producing a manifest', () => {
  for (const targetBytes of [0, -1, 1.5, Infinity]) assert.throws(() => plan({ targetBytes }), /targetBytes/)
  const base = { packageGraph: graph, filePackages }
  assert.throws(() => plan({ ...base, manualGroups: [{ name: 'bad', packages: ['typo'] }] }), /Unknown package selector/)
  assert.throws(() => plan({ ...base, manualGroups: [{ name: 'same', packages: ['app'] }, { name: 'same', packages: ['tool'] }] }), /Duplicate manual group/)
  assert.throws(() => plan({ ...base, packageGraph: { ...graph, 'shared@1': { name: 'shared', dependencies: ['missing@1'] } }, manualGroups: [{ name: 'bad', packages: ['app'] }] }), /Missing package/)
  assert.throws(() => selectManualChunks(plan(), ['missing']), /Unknown manual group/)
  assert.throws(() => plan({ targetSize: 100 }), /Unknown chunk policy field/)
  assert.throws(() => plan({ ...base, manualGroups: [{ name: 'bad', packages: ['app'], includeDependencies: 'false' }] }), /includeDependencies/)
  const broken = plan({ ...base, manualGroups: [{ name: 'app', packages: ['app'] }] })
  delete broken.chunks[broken.manualGroups.app.imports[0]]
  assert.throws(() => selectManualChunks(broken, ['app']), /Missing chunk/)
})

test('disabling dependency inclusion assigns only explicitly selected package content', () => {
  const manifest = plan({ packageGraph: graph, filePackages,
    manualGroups: [{ name: 'app-only', packages: ['app'], includeDependencies: false }] })
  assert.deepEqual(selectManualChunks(manifest, ['app-only']).flatMap(key => manifest.chunks[key].files.map(file => file.path)).sort(), [file('a').path, file('d').path].sort())
})

test('byte partitioning is deterministic and leaves most chunks reusable after one insertion', () => {
  const files = Array.from({ length: 128 }, (_, index) => file(`payload-${index}`, 10))
  const before = plan({ targetBytes: 80 }, { build: files })
  const reordered = plan({ targetBytes: 80 }, { build: [...files].reverse() })
  assert.deepEqual(before, reordered)
  const after = plan({ targetBytes: 80 }, { build: [...files, file('new', 10)] })
  const keys = Object.keys(before.chunks)
  assert(keys.filter(key => Object.hasOwn(after.chunks, key)).length >= keys.length - 1)
})
