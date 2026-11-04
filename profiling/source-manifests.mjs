import fs from 'node:fs'
import path from 'node:path'
import { sha256 } from '../action/chunk-identity.mjs'

export function sourceManifests(workspace, importers) {
  workspace = fs.realpathSync(workspace)
  return Object.fromEntries(importers.map(importer => {
    const filename = fs.realpathSync(path.join(workspace, importer, 'package.json')), relative = path.relative(workspace, filename)
    if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error(`Project manifest escapes the workspace: ${importer}`)
    return [importer, sha256(fs.readFileSync(filename))]
  }))
}
