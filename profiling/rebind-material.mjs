import { canonicalJson, planGroups } from '../action/cache-groups.mjs'
import { TAR_ZSTD_CODEC } from './tar-zstd.mjs'

export function rebindArchiveMaterial({ snapshot, saved, snapshotSha256 }) {
  if (saved.codec !== TAR_ZSTD_CODEC) throw new Error(`Unsupported archive codec: ${saved.codec}`)
  const manifest = planGroups(snapshot.inventories, { ...saved.policy, context: snapshot.context,
    packageGraph: snapshot.packageGraph, filePackages: snapshot.filePackages })
  const archives = {}
  for (const [key, chunk] of Object.entries(manifest.chunks)) {
    if (!Object.hasOwn(saved.archives, key) || !Object.hasOwn(saved.manifest.chunks, key)) throw new Error(`Missing archive: ${key}`)
    if (canonicalJson(chunk.files) !== canonicalJson(saved.manifest.chunks[key].files)) throw new Error(`Chunk identity mismatch: ${key}`)
    archives[key] = saved.archives[key]
  }
  for (const [entry, index] of Object.entries(snapshot.indexes ?? {})) manifest.entries[entry].index = index
  return { codec: saved.codec, policy: saved.policy, context: snapshot.context, manifest, archives,
    sourceLockfile: snapshot.provenance?.lockfileSha256, snapshotSha256 }
}
