import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { parse, stringify } from 'yaml'
import { sha256 } from '../../action/cache-groups.mjs'
import { cacheInventory } from '../github-cache.mjs'
import { workspaceContext } from '../workspace-context.mjs'
import { pinnedBinaryEnvironment } from '../native-environment.mjs'

export const root = process.cwd()
export const source = path.join(root, 'benchmark-source')
export const state = path.join(root, '.work', 'github-cache-benchmark')
export const results = path.join(root, '.measurements')

export function input(name, fallback = '') { return process.env[`INPUT_${name.toUpperCase()}`] || fallback }
export function json(filename, value) { fs.writeFileSync(filename, JSON.stringify({ workflowRun: process.env.GITHUB_RUN_ID, runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 1), codeSha: process.env.GITHUB_SHA, ...value }, null, 2) + '\n') }
export function output(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${typeof value === 'string' ? value : JSON.stringify(value)}\n`)
}

export function childEnvironment(offline = false) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD/i.test(key)) delete env[key]
  const config = path.join(state, 'config')
  fs.mkdirSync(config, { recursive: true }); fs.writeFileSync(path.join(config, 'empty-npmrc'), '')
  return { ...env, CI: 'true', XDG_CONFIG_HOME: config, XDG_CACHE_HOME: path.join(state, 'metadata'), XDG_STATE_HOME: path.join(state, 'state'),
    PNPM_CONFIG_NPMRC_AUTH_FILE: path.join(config, 'empty-npmrc'), PNPM_CONFIG_OFFLINE: String(offline),
    ...pinnedBinaryEnvironment }
}

export async function command(program, args, { cwd = source, offline = false, name = 'command', environment } = {}) {
  fs.mkdirSync(results, { recursive: true })
  const filename = path.join(results, `${name}.log`), log = fs.openSync(filename, 'w')
  const started = performance.now()
  const status = await new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env: environment ?? childEnvironment(offline), stdio: ['ignore', log, log] })
    child.once('error', reject); child.once('exit', code => resolve(code))
  }).finally(() => fs.closeSync(log))
  const text = fs.readFileSync(filename, 'utf8')
  if (status !== 0) throw new Error(`${name} exited ${status}: ${text.slice(-4000)}`)
  return { ms: performance.now() - started, text }
}

export async function prepareSource() {
  fs.mkdirSync(state, { recursive: true }); fs.mkdirSync(results, { recursive: true })
  const binary = fs.realpathSync(path.resolve(input('pnpm-binary', 'dist/pnpm')))
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
  const configFile = path.join(source, 'pnpm-workspace.yaml'), settings = parse(fs.readFileSync(configFile, 'utf8'))
  settings.overrides = manifest.pnpm.overrides
  settings.trustLockfile = true
  settings.engineStrict = false
  settings.storeIndexFormat = 'files'
  settings.virtualStoreType = 'project'
  fs.writeFileSync(configFile, stringify(settings))
  const lockfile = fs.readFileSync(path.join(source, 'pnpm-lock.yaml'))
  const context = await workspaceContext(source, binary)
  const version = await command(binary, ['--version'], { name: 'version' })
  if (!/^12\./.test(version.text.trim())) throw new Error(`Expected pnpm v12, got ${version.text.trim()}`)
  const checkoutFile = path.join(results, 'checkout.json')
  const checkout = fs.existsSync(checkoutFile) ? JSON.parse(fs.readFileSync(checkoutFile, 'utf8')) : { sparse: false }
  return { binary, context, lockfile: parse(lockfile.toString()), pnpmVersion: version.text.trim(), checkout }
}

export async function providerSizes(namespace, keys) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const entries = await cacheInventory({ repository: process.env.GITHUB_REPOSITORY, token: input('github-token'), namespace, ref: process.env.GITHUB_REF })
    if (keys.every(key => entries.has(key))) return entries
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error('Published cache sizes did not appear in the repository inventory')
}

export function queryFor(context, entry, targetBytes, mode = 'chunks') { return { ...context, entry, mode, targetBytes: mode === 'chunks' ? targetBytes : 0 } }

export async function installAndCheck({ binary, store, entry, lockfile }) {
  const install = await command(binary, ['--store-dir', store, 'install', '--frozen-lockfile', '--offline', '--ignore-scripts', `--filter={${entry}}...`, '--workspace-root'], { offline: true, name: 'offline-install' })
  const expression = entry === 'app' ? "assert.equal(typeof require('vue').reactive,'function')" : entry === 'api' ? "assert.equal(typeof require('express'),'function')" : "assert.equal(typeof require('typescript').transpile,'function')"
  await command(process.execPath, ['-e', `const assert=require('node:assert/strict');${expression}`], { cwd: path.join(source, entry), offline: true, name: 'module-load' })
  const unchanged = sha256(fs.readFileSync(path.join(source, 'pnpm-lock.yaml'))) === lockfile
  if (!unchanged) throw new Error('Wanted lockfile changed')
  return { installMs: install.ms, offlineInstall: true, moduleLoad: true, lockfileUnchanged: true }
}
