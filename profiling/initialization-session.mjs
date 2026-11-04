import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { parse } from 'yaml'
import { canonicalJson } from '../action/chunk-identity.mjs'
import { lockfileGraph } from './native-store.mjs'
import { selectWorkspaceImporters } from './scoped-index.mjs'
import { sourceManifests } from './source-manifests.mjs'

export async function withWorkspaceInitializationLock(workspace, operation) {
  const directory = path.join(workspace, '.pnpm-cache'); fs.mkdirSync(directory, { recursive: true })
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Unsafe initialization state directory')
  const filename = path.join(directory, 'initialization.lock')
  let handle
  try { handle = fs.openSync(filename, 'wx', 0o600) } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Initialization is already running or needs lock recovery: ${filename}`)
    throw error
  }
  try {
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid }))
    return await operation(path.join(directory, 'initialization.json'))
  } finally { fs.closeSync(handle); fs.unlinkSync(filename) }
}

function readSession(filename) {
  let saved
  try {
    if (!fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink()) throw new Error('Invalid initialization session file')
    saved = JSON.parse(fs.readFileSync(filename, 'utf8'))
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
  if (!saved || saved.version !== 1 || !Array.isArray(saved.completed) || !saved.manifests || typeof saved.manifests !== 'object' ||
      Array.isArray(saved.manifests) || typeof saved.store !== 'string' || typeof saved.workspace !== 'string' || !saved.context || saved.pending !== undefined && typeof saved.pending !== 'string') throw new Error('Invalid initialization session')
  return saved
}

function writeSession(filename, state) {
  const temporary = `${filename}.${randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, filename)
}

function checkManifests(workspace, manifests) {
  const current = sourceManifests(workspace, Object.keys(manifests))
  for (const [importer, digest] of Object.entries(manifests)) if (current[importer] !== digest) throw new Error(`Project manifest changed: ${importer}`)
}

export function initializationSession({ filename, project, context, store, ignoreScripts, expectedManifests }) {
  fs.mkdirSync(store, { recursive: true }); store = fs.realpathSync(store)
  const saved = readSession(filename)
  const lock = parse(fs.readFileSync(path.join(project.workspace, 'pnpm-lock.yaml'), 'utf8'))
  if (saved) {
    if (saved.workspace !== project.workspace) throw new Error('Initialization workspace changed; use a fresh workspace')
    if (canonicalJson(saved.context) !== canonicalJson(context) || saved.ignoreScripts !== ignoreScripts) throw new Error('Initialization generation or options changed; use a fresh workspace')
    if (saved.store !== store) throw new Error('Initialization store changed; use a fresh workspace')
    if (saved.pending && saved.pending !== project.importer) throw new Error(`Initialization is unfinished for ${saved.pending}; retry that project first`)
    checkManifests(project.workspace, saved.manifests)
  } else {
    for (const importer of Object.keys(lock.importers ?? {})) {
      if (fs.existsSync(path.join(project.workspace, importer, 'node_modules'))) throw new Error(`Untracked node_modules for ${importer}; start with a fresh workspace`)
    }
  }
  const state = saved ?? { version: 1, context, workspace: project.workspace, store, ignoreScripts, completed: [], manifests: {} }
  const { graph } = lockfileGraph(lock)
  const selected = selectWorkspaceImporters({ graph, importers: [project.importer] })
  const manifests = sourceManifests(project.workspace, [...selected].map(id => id.slice('workspace:'.length)))
  if (expectedManifests) for (const [importer, digest] of Object.entries(manifests)) {
    if (expectedManifests[importer] !== digest) throw new Error(`Project catalog manifest mismatch: ${importer}`)
  }
  return {
    begin() {
      Object.assign(state.manifests, manifests); state.pending = project.importer; writeSession(filename, state)
    },
    complete(currentContext) {
      if (canonicalJson(currentContext) !== canonicalJson(context)) throw new Error('Initialization inputs changed during install')
      checkManifests(project.workspace, state.manifests)
      state.completed = [...new Set([...state.completed, ...Object.keys(manifests)])].sort()
      delete state.pending; writeSession(filename, state)
      return state.completed
    },
  }
}
