import fs from 'node:fs'
import path from 'node:path'
import { sha256 } from '../action/chunk-identity.mjs'
import { selectProjectPlan } from '../action/project-catalog.mjs'
import { currentProject } from './current-project.mjs'
import { hydrateProject, ProjectCacheMiss } from './hydrate-project.mjs'
import { pinnedBinaryEnvironment } from './native-environment.mjs'
import { workspaceContext } from './workspace-context.mjs'

export async function initializeCurrentProject({ cwd = process.cwd(), binary, store, cache, runInstall, offline = false, ignoreScripts = false }) {
  const started = performance.now(), project = currentProject(cwd), context = await workspaceContext(project.workspace, binary)
  const plan = cache && selectProjectPlan({ catalog: cache.catalog, context, importer: project.importer })
  let hydration = { restored: [], requestedObjects: 0, skippedObjects: 0, restoreMs: 0, hydrateMs: 0 }, cacheMode = 'native'
  if (plan) {
    try {
      hydration = await hydrateProject({ ...cache, plan, store })
      cacheMode = 'restored'
    } catch (error) {
      if (!(error instanceof ProjectCacheMiss) || offline) throw error
      cacheMode = 'miss'
    }
  }
  const args = ['install', '--frozen-lockfile', '--store-dir', store,
    ...(offline ? ['--offline'] : []), ...(ignoreScripts ? ['--ignore-scripts'] : [])]
  const installed = await runInstall({ binary, args, cwd: project.directory, environment: { ...pinnedBinaryEnvironment, PNPM_CONFIG_RECURSIVE_INSTALL: 'false' } })
  if (sha256(fs.readFileSync(path.join(project.workspace, 'pnpm-lock.yaml'))) !== context.lockfile) throw new Error('Wanted lockfile changed during initialization')
  return { importer: project.importer, context, cacheMode, ...hydration, installMs: installed.ms,
    totalMs: performance.now() - started, lockfileUnchanged: true, filters: [] }
}
