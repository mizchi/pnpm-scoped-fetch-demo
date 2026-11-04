import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'
import { lockfileGraph } from '../native-store.mjs'
import { selectWorkspaceImporters } from '../scoped-index.mjs'

const entry = process.argv[2], source = path.resolve('benchmark-source')
assert(['app', 'api', 'sdk'].includes(entry), 'Unknown checkout workload')
const lock = parse(fs.readFileSync(path.join(source, 'pnpm-lock.yaml'), 'utf8'))
const { graph } = lockfileGraph(lock)
const importers = [...selectWorkspaceImporters({ graph, importers: [entry] })].map(id => id.slice('workspace:'.length)).filter(id => id !== '.')
const paths = [...new Set(['packages', ...importers])].sort()
const result = spawnSync('git', ['sparse-checkout', 'set', '--', ...paths], { cwd: source, encoding: 'utf8' })
assert.equal(result.status, 0, result.stderr)
const omittedImporters = Object.keys(lock.importers).filter(id => id !== '.' && !fs.existsSync(path.join(source, id, 'package.json')))
for (const id of importers) assert(fs.existsSync(path.join(source, id, 'package.json')), `Missing selected importer: ${id}`)
if (entry === 'sdk') assert(omittedImporters.includes('api') && omittedImporters.includes('app'), 'SDK must omit unrelated app and API manifests')
fs.mkdirSync('.measurements', { recursive: true })
fs.writeFileSync('.measurements/checkout.json', JSON.stringify({ sparse: true, entry, paths, selectedImporters: importers, omittedImporters }, null, 2) + '\n')
console.log(JSON.stringify({ entry, omittedImporters }))
