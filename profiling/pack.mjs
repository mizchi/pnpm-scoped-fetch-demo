import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { packProjects } from './pack-projects.mjs'

const { values } = parseArgs({ options: { workspace: { type: 'string' }, store: { type: 'string' }, pnpm: { type: 'string' },
  output: { type: 'string' }, 'target-bytes': { type: 'string', default: '67108864' } } })
for (const name of ['workspace', 'store', 'pnpm', 'output']) if (!values[name]) throw new Error(`Missing --${name}`)
const result = await packProjects({ workspace: fs.realpathSync(values.workspace), store: fs.realpathSync(values.store),
  binary: fs.realpathSync(values.pnpm), directory: path.resolve(values.output), targetBytes: Number(values['target-bytes']) })
fs.writeFileSync(path.join(values.output, 'pack.json'), JSON.stringify(result.metrics, null, 2) + '\n')
console.log(JSON.stringify(result.metrics, null, 2))
