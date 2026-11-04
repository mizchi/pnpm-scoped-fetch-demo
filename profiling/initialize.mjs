import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { cachePath } from '../action/cache-plan.mjs'
import { MAX_CATALOG_BYTES } from '../action/project-catalog.mjs'
import { initializeCurrentProject } from './initialize-current.mjs'

const { values } = parseArgs({ options: { catalog: { type: 'string' }, 'cache-root': { type: 'string' }, pnpm: { type: 'string' },
  store: { type: 'string' }, offline: { type: 'boolean', default: false }, 'ignore-scripts': { type: 'boolean', default: false } } })
if (!values.pnpm || !values.store) throw new Error('Pass --pnpm with the native binary path and --store with a dedicated store path')
const store = path.resolve(values.store), binary = fs.realpathSync(path.resolve(values.pnpm))
let cache
if (values.catalog) {
  if (!values['cache-root']) throw new Error('--catalog requires --cache-root')
  if (fs.statSync(values.catalog).size > MAX_CATALOG_BYTES) throw new Error('Project catalog exceeds its size limit')
  const catalog = JSON.parse(fs.readFileSync(values.catalog, 'utf8')), cacheRoot = path.resolve(values['cache-root'])
  cache = { catalog, stateDirectory: `${store}.chunk-state`, archivePath: object => path.join(cacheRoot, cachePath(object)),
    restore: async objects => objects.map(object => ({ key: object.id, hit: fs.existsSync(path.join(cacheRoot, cachePath(object))), innerBytes: object.size })) }
}
const result = await initializeCurrentProject({ binary, store, cache, offline: values.offline, ignoreScripts: values['ignore-scripts'],
  runInstall: async request => {
    const started = performance.now()
    await new Promise((resolve, reject) => {
      const child = spawn(request.binary, request.args, { cwd: request.cwd, env: { ...process.env, ...request.environment }, stdio: 'inherit' })
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`pnpm install exited ${code}`)))
    })
    return { ms: performance.now() - started }
  } })
console.log(JSON.stringify(result, null, 2))
