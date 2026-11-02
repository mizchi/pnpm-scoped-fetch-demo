import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildFetchArgs, fetchScope, prepare, writeOutputs } from '../action/scoped-fetch.mjs'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scoped-action-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'checkout')
  const runnerTemp = path.join(root, 'runner')
  await fs.mkdir(workspace)
  await fs.mkdir(runnerTemp)
  await fs.writeFile(path.join(workspace, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  const pnpmBinary = path.join(root, 'pnpm with spaces')
  await fs.writeFile(pnpmBinary, `#!/usr/bin/env node
if (process.argv.includes('--version')) console.log('12.17.0');
else require('node:fs').writeFileSync(process.env.ARGV_LOG, JSON.stringify(process.argv.slice(2)));
`)
  await fs.chmod(pnpmBinary, 0o755)
  return { workspace, runnerTemp, pnpmBinary, filters: '{apps/web}...', dependencyHash: 'lock-and-config-hash' }
}

test('cache keys separate scopes, modes, config, and different binaries with the same version', async t => {
  const input = await fixture(t)
  const original = await prepare(input)
  assert.equal((await prepare(input)).cacheKey, original.cacheKey)
  for (const change of [
    { filters: '{apps/admin}...' },
    { filters: '{apps/web}...\n!{packages/test}' },
    { productionOnly: true },
    { includeWorkspaceRoot: false },
    { dependencyHash: 'changed-lock-or-config' },
    { cacheSalt: 'custom-patch-change' },
  ]) {
    assert.notEqual((await prepare({ ...input, ...change })).cacheKey, original.cacheKey)
  }
  await fs.appendFile(input.pnpmBinary, '\n// another build\n')
  assert.notEqual((await prepare(input)).cacheKey, original.cacheKey)
})

test('filter ordering is preserved because later inclusions can override exclusions', async t => {
  const input = await fixture(t)
  const first = await prepare({ ...input, filters: '{apps/web}\n!{apps/admin}' })
  const second = await prepare({ ...input, filters: '!{apps/admin}\n{apps/web}' })
  assert.notEqual(first.cacheKey, second.cacheKey)
  assert.deepEqual(first.filters, ['{apps/web}', '!{apps/admin}'])
})

test('store starts empty inside an action-owned directory and has a stable cache path', async t => {
  const input = await fixture(t)
  const first = await prepare(input)
  await fs.writeFile(path.join(first.storeDir, 'old-whole-store-data'), 'obsolete')
  const unrelated = path.join(input.runnerTemp, 'unrelated')
  await fs.writeFile(unrelated, 'keep')
  const second = await prepare(input)
  assert.equal(second.storeDir, first.storeDir)
  assert.deepEqual(await fs.readdir(second.storeDir), [])
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'keep')
})

test('empty filters, an absent lockfile, and working directories outside the checkout fail', async t => {
  const input = await fixture(t)
  await assert.rejects(prepare({ ...input, filters: ' \n ' }), /filter/i)
  await assert.rejects(prepare({ ...input, workingDirectory: '..' }), /checkout/i)
  await fs.unlink(path.join(input.workspace, 'pnpm-lock.yaml'))
  await assert.rejects(prepare(input), /pnpm-lock.yaml/)
})

test('production fetch follows only production workspace edges and keeps the requested root', async t => {
  const plan = await prepare({ ...await fixture(t), productionOnly: true })
  const args = buildFetchArgs(plan)
  assert(args.some(arg => arg.startsWith('--filter-prod=')))
  assert(args.includes('--prod'))
  assert(args.includes('--workspace-root'))
  assert(args.includes('--fail-if-no-match'))
  assert(!args.some(arg => arg.startsWith('--filter=')))
})

test('filter text is one literal process argument, including shell metacharacters', async t => {
  const input = await fixture(t)
  const plan = await prepare({ ...input, filters: '$(touch should-not-exist); name with spaces' })
  const log = path.join(input.runnerTemp, 'argv.json')
  await fetchScope(plan, { env: { ...process.env, ARGV_LOG: log } })
  assert.deepEqual(JSON.parse(await fs.readFile(log, 'utf8')), buildFetchArgs(plan))
  await assert.rejects(fs.stat(path.join(input.workspace, 'should-not-exist')), { code: 'ENOENT' })
})

test('action outputs use multiline records for paths and remain within the cache key limit', async t => {
  const plan = await prepare(await fixture(t))
  const output = path.join(plan.runnerTemp, 'outputs')
  await writeOutputs(plan, output)
  const text = await fs.readFile(output, 'utf8')
  assert.match(text, /store-dir<</)
  assert.match(text, /cache-key<</)
  assert(text.includes(plan.storeDir))
  assert(plan.cacheKey.length < 512)
})

test('a symlink cannot redirect the action-owned cache root outside the runner directory', async t => {
  const input = await fixture(t)
  const outside = path.join(input.workspace, 'keep')
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'marker'), 'preserve')
  await fs.symlink(outside, path.join(input.runnerTemp, 'pnpm-scoped-fetch'))
  await assert.rejects(prepare(input), /escapes/)
  assert.equal(await fs.readFile(path.join(outside, 'marker'), 'utf8'), 'preserve')
})

test('a failed scoped fetch fails instead of retrying without its filters', async t => {
  const input = await fixture(t)
  const plan = await prepare(input)
  const log = path.join(input.runnerTemp, 'failed-argv.json')
  await fs.writeFile(plan.pnpmBinary, `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.ARGV_LOG, JSON.stringify(process.argv.slice(2)));
process.exitCode = 42;
`)
  await assert.rejects(fetchScope(plan, { env: { ...process.env, ARGV_LOG: log } }), /42/)
  assert.deepEqual(JSON.parse(await fs.readFile(log, 'utf8')), buildFetchArgs(plan))
})
