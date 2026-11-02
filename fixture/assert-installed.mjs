import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const web = createRequire(path.join(root, 'apps/web/package.json'))
const tools = createRequire(path.join(root, 'package.json'))
assert.equal(web('lodash').VERSION, '4.17.21')
assert.equal(web('ui')(42), 'ui:true')
assert.equal(tools('semver').valid('1.2.3'), '1.2.3')
assert(!fs.existsSync(path.join(root, 'apps/admin')), 'the admin source must be absent in the sparse checkout')
console.log('web, its workspace library and root tooling work after offline installation')
