import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { sha256 } from '../action/cache-groups.mjs'

export function archiveIndex({ store, paths, archive }) {
  const tar = `${archive}.tar`
  for (const [program, args] of [
    ['tar', ['-cf', tar, '-C', store, ...paths]],
    ['zstd', ['-q', '-T1', '-3', '-f', tar, '-o', archive]],
  ]) {
    const result = spawnSync(program, args, { encoding: 'utf8' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`${program}: ${result.stderr}`)
  }
  const tarBytes = fs.statSync(tar).size
  const bytes = fs.readFileSync(archive)
  fs.unlinkSync(tar)
  return { size: bytes.length, sha256: sha256(bytes), tarBytes, archive }
}
