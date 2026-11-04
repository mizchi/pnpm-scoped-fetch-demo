import fs from 'node:fs'
import path from 'node:path'
import { sha256 } from '../action/chunk-identity.mjs'
import { fileDigest } from './github-cache.mjs'

export async function workspaceContext(workspace, binary) {
  return { version: 1, lockfile: sha256(fs.readFileSync(path.join(workspace, 'pnpm-lock.yaml'))),
    configuration: sha256(fs.readFileSync(path.join(workspace, 'pnpm-workspace.yaml'))), pnpm: await fileDigest(binary),
    platform: process.platform, arch: process.arch, node: process.versions.node }
}
