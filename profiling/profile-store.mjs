import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { cachePath } from '../action/cache-plan.mjs'
import { selectProjectPlan } from '../action/project-catalog.mjs'
import { hydrateProject } from './hydrate-project.mjs'
import { startFileProfile } from './fs-profile.mjs'

const { values } = parseArgs({ options: { catalog: { type: 'string' }, 'cache-root': { type: 'string' }, output: { type: 'string' }, importer: { type: 'string', default: 'sdk' } } })
for (const key of ['catalog', 'cache-root', 'output']) if (!values[key]) throw new Error(`Missing --${key}`)
const directory = path.resolve(values.output); fs.mkdirSync(directory, { recursive: true })
const catalog = JSON.parse(fs.readFileSync(values.catalog)), plan = selectProjectPlan({ catalog, context: catalog.context, importer: values.importer })
const store = path.join(directory, 'store'), records = []
if (fs.existsSync(store)) throw new Error('Use a fresh output directory')
for (const phase of ['initial', 'reuse']) {
  const stop = startFileProfile()
  const result = await hydrateProject({ plan, store, stateDirectory: `${store}.state`,
    archivePath: object => path.join(values['cache-root'], cachePath(object)),
    restore: async objects => objects.map(object => ({ key: object.id, hit: true })) })
  records.push({ phase, profile: stop(), validationMs: result.validationMs, hydrateMs: result.hydrateMs })
}
fs.writeFileSync(path.join(directory, 'profile.json'), JSON.stringify({ note: 'Local archive processing only; no network', records }, null, 2) + '\n')
console.log(JSON.stringify(records))
