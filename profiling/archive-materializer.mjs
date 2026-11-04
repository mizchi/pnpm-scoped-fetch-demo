import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { planGroups } from '../action/cache-groups.mjs'
import { writeTarChunk, verifyTarChunk } from './tar-zstd.mjs'

function summary(samples) {
  const sorted = [...samples].sort((left, right) => left - right)
  return { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1), samples }
}

export function archiveMaterializer(directory, { onProgress } = {}) {
  let run = 0
  return async (snapshot, policy, iterations) => {
    const timings = { planMs: [], encodeMs: [], decodeVerifyMs: [] }
    let material, previous
    for (let iteration = 0; iteration < iterations; iteration++) {
      const destination = path.join(directory, `run-${run++}`)
      fs.mkdirSync(destination)
      const started = performance.now()
      const manifest = planGroups(snapshot.inventories, { ...policy, context: snapshot.context,
        packageGraph: snapshot.packageGraph, filePackages: snapshot.filePackages })
      timings.planMs.push(performance.now() - started)
      const archives = {}, archiveSizes = {}
      let encodeMs = 0, decodeMs = 0
      for (const [key, chunk] of Object.entries(manifest.chunks)) {
        const filename = path.join(destination, `${key}.tar.zst`)
        const encodeStart = performance.now()
        archives[key] = { filename, ...await writeTarChunk({ chunk,
          source: relative => fs.createReadStream(snapshot.sourceFiles[relative]), filename }) }
        encodeMs += performance.now() - encodeStart
        archiveSizes[key] = archives[key].size
        const decodeStart = performance.now()
        await verifyTarChunk({ chunk, input: fs.createReadStream(filename), archiveSha256: archives[key].sha256 })
        decodeMs += performance.now() - decodeStart
        if (previous) assert.equal(archives[key].sha256, previous.archives[key].sha256, 'Repeated encodes must be byte-identical')
      }
      timings.encodeMs.push(encodeMs); timings.decodeVerifyMs.push(decodeMs)
      material = { manifest, archiveSizes, archives, directory: destination }
      if (previous) fs.rmSync(previous.directory, { recursive: true, force: true })
      previous = material
      onProgress?.({ policy: policy.name, iteration: iteration + 1, chunks: Object.keys(archives).length, encodeMs, decodeMs })
    }
    material.timings = Object.fromEntries(Object.entries(timings).map(([name, samples]) => [name, summary(samples)]))
    return material
  }
}
