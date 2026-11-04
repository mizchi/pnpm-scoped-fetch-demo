import fs from 'node:fs'
import path from 'node:path'
import { canonicalJson, sha256 } from '../action/chunk-identity.mjs'
import { fileDigest } from './github-cache.mjs'
import { pinnedBinaryEnvironment } from './native-environment.mjs'

export async function workspaceContext(workspace, binary) {
  const inputs = Object.fromEntries(['package.json', '.npmrc', '.pnpmfile.cjs', '.pnpmfile.mjs'].map(name => {
    const filename = path.join(workspace, name)
    return [name, fs.existsSync(filename) ? sha256(fs.readFileSync(filename)) : null]
  }))
  const environment = Object.fromEntries(Object.entries({ ...process.env, ...pinnedBinaryEnvironment, PNPM_CONFIG_RECURSIVE_INSTALL: 'false' })
    .filter(([name]) => /^(npm|pnpm)_config_/i.test(name) && !/_config_(offline|recursive_install|manage_package_manager_versions)$/i.test(name)))
  return { version: 2, inputs: sha256(canonicalJson(inputs)), environment: sha256(canonicalJson(environment)),
    lockfile: sha256(fs.readFileSync(path.join(workspace, 'pnpm-lock.yaml'))),
    configuration: sha256(fs.readFileSync(path.join(workspace, 'pnpm-workspace.yaml'))), pnpm: await fileDigest(binary),
    platform: process.platform, arch: process.arch, node: process.versions.node }
}
