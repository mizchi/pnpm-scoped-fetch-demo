import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function contains(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

export async function resolveBinary(binary, cwd) {
  const candidates = binary.includes('/') || binary.includes('\\')
    ? [path.resolve(cwd, binary)]
    : (process.env.PATH ?? '').split(path.delimiter).map(directory => path.join(directory, binary))
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK)
      return await fs.realpath(candidate)
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error
    }
  }
  throw new Error(`Cannot find the pnpm binary: ${binary}`)
}

function run(binary, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { ...options, shell: false })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', data => { stdout += data })
    child.stderr?.on('data', data => { stderr += data })
    child.on('error', reject)
    child.on('close', code => code === 0
      ? resolve(stdout.trim())
      : reject(new Error(`pnpm exited with ${code}: ${stderr.trim()}`)))
  })
}

export async function prepare(input, { env = process.env } = {}) {
  const filters = (input.filters ?? '').split(/\r?\n/).map(value => value.trim()).filter(Boolean)
  if (filters.length === 0) throw new Error('At least one filter is required')
  if (!input.dependencyHash) throw new Error('A lockfile and configuration fingerprint is required')
  const workspace = await fs.realpath(input.workspace)
  const cwd = await fs.realpath(path.resolve(workspace, input.workingDirectory ?? '.'))
  if (!contains(workspace, cwd)) throw new Error('The working directory must be inside the checkout')
  await fs.access(path.join(cwd, 'pnpm-lock.yaml'))
  const runnerTemp = await fs.realpath(input.runnerTemp)
  const pnpmBinary = await resolveBinary(input.pnpmBinary ?? 'pnpm', cwd)
  const pnpmVersion = await run(pnpmBinary, ['--config.manage-package-manager-versions=false', '--version'], {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(pnpmVersion)) {
    throw new Error(`Unexpected pnpm version: ${pnpmVersion}`)
  }
  const productionOnly = input.productionOnly ?? false
  const includeWorkspaceRoot = input.includeWorkspaceRoot ?? true
  const identity = {
    schema: 1, filters, productionOnly, includeWorkspaceRoot,
    dependencyHash: input.dependencyHash, cacheSalt: input.cacheSalt ?? '',
    pnpmVersion, binaryHash: digest(await fs.readFile(pnpmBinary)),
    platform: process.platform, arch: process.arch, nodeVersion: process.version,
    libc: process.report.getReport().header.glibcVersionRuntime ?? '',
  }
  const cacheKey = `pnpm-scoped-v1-${process.platform}-${process.arch}-${digest(JSON.stringify(identity))}`
  const ownedRoot = path.join(runnerTemp, 'pnpm-scoped-fetch')
  await fs.mkdir(ownedRoot, { recursive: true })
  if (!contains(runnerTemp, await fs.realpath(ownedRoot))) throw new Error('The store root escapes the runner temporary directory')
  const storeDir = path.join(ownedRoot, digest(JSON.stringify([cwd, cacheKey])))
  await fs.rm(storeDir, { recursive: true, force: true })
  await fs.mkdir(storeDir)
  const planPath = path.join(ownedRoot, `plan-${randomUUID()}.json`)
  const plan = { cwd, runnerTemp, storeDir, pnpmBinary, pnpmVersion, filters, productionOnly, includeWorkspaceRoot, cacheKey, planPath }
  await fs.writeFile(planPath, JSON.stringify(plan), { flag: 'wx' })
  return plan
}

export function buildFetchArgs(plan) {
  return [
    '--config.manage-package-manager-versions=false',
    '--store-dir', plan.storeDir,
    '--reporter=append-only',
    'fetch',
    ...plan.filters.map(filter => `${plan.productionOnly ? '--filter-prod' : '--filter'}=${filter}`),
    ...(plan.includeWorkspaceRoot ? ['--workspace-root'] : []),
    ...(plan.productionOnly ? ['--prod'] : []),
    '--fail-if-no-match',
  ]
}

export async function fetchScope(plan, { env = process.env } = {}) {
  await run(plan.pnpmBinary, buildFetchArgs(plan), { cwd: plan.cwd, env, stdio: 'inherit' })
}

export async function writeOutputs(plan, outputFile) {
  const values = {
    'store-dir': plan.storeDir, 'cache-key': plan.cacheKey,
    'pnpm-binary': plan.pnpmBinary, 'pnpm-version': plan.pnpmVersion, 'plan-path': plan.planPath,
  }
  for (const [name, value] of Object.entries(values)) {
    const delimiter = `pnpm_${randomUUID()}`
    await fs.appendFile(outputFile, `${name}<<${delimiter}\n${value}\n${delimiter}\n`)
  }
}

function booleanInput(name) {
  const value = process.env[name]
  if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false`)
  return value === 'true'
}

async function main() {
  switch (process.argv[2]) {
    case 'prepare': {
      const plan = await prepare({
        workspace: process.env.GITHUB_WORKSPACE, runnerTemp: process.env.RUNNER_TEMP,
        workingDirectory: process.env.SCOPED_WORKING_DIRECTORY,
        pnpmBinary: process.env.SCOPED_PNPM_BINARY, filters: process.env.SCOPED_FILTERS,
        productionOnly: booleanInput('SCOPED_PRODUCTION_ONLY'),
        includeWorkspaceRoot: booleanInput('SCOPED_INCLUDE_WORKSPACE_ROOT'),
        dependencyHash: process.env.SCOPED_DEPENDENCY_HASH, cacheSalt: process.env.SCOPED_CACHE_SALT,
      })
      await writeOutputs(plan, process.env.GITHUB_OUTPUT)
      break
    }
    case 'fetch':
      await fetchScope(JSON.parse(await fs.readFile(process.env.SCOPED_PLAN_PATH, 'utf8')))
      break
    default:
      throw new Error('Expected prepare or fetch')
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
