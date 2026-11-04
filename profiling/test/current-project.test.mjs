import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { currentProject } from '../current-project.mjs'

test('the invocation directory determines its lockfile importer before node_modules exists', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-current-project-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages: [apps/*]')
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0')
  const directory = path.join(root, 'apps/web'); fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'package.json'), '{"name":"web"}')
  assert.deepEqual(currentProject(directory), { workspace: fs.realpathSync(root), directory: fs.realpathSync(directory), importer: 'apps/web' })
  assert(!fs.existsSync(path.join(directory, 'node_modules')))
  fs.mkdirSync(path.join(directory, 'src'))
  assert.equal(currentProject(path.join(directory, 'src')).importer, 'apps/web')
  assert.throws(() => currentProject(root), /package.json/)
})
