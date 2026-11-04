import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { canonicalJson, planGroups, sha256 } from '../action/cache-groups.mjs'
import { cachePath } from '../action/cache-plan.mjs'
import { catalogId, createProjectCatalog } from '../action/project-catalog.mjs'
import { archiveIndex } from './index-archive.mjs'
import { lockfileGraph, readStore } from './native-store.mjs'
import { selectStoreScope } from './scoped-index.mjs'
import { writeTarChunk, verifyTarChunk } from './tar-zstd.mjs'
import { workspaceContext } from './workspace-context.mjs'

export async function packProjects({ workspace, store, binary, directory, targetBytes = 67108864 }) {
  const started = performance.now(), context = await workspaceContext(workspace, binary)
  const lockfile = parse(fs.readFileSync(path.join(workspace, 'pnpm-lock.yaml'), 'utf8'))
  if (String(lockfile.lockfileVersion) !== '9.0') throw new Error('Project cache adapter requires a v9 lockfile')
  const { graph, packageIds } = lockfileGraph(lockfile), full = readStore(store, packageIds)
  const inventories = {}, projects = {}
  for (const entry of Object.keys(lockfile.importers)) {
    const scope = selectStoreScope({ full, graph, packageIds, importers: [entry] })
    inventories[entry] = scope.files
    projects[entry] = { files: scope.files.length, packages: scope.packages.length,
      rawBytes: scope.files.reduce((sum, file) => sum + file.size, 0), fingerprint: sha256(canonicalJson(scope.files)) }
  }
  const manifest = planGroups(inventories, { targetBytes, context: { layout: full.layout }, packageGraph: graph, filePackages: full.filePackages })
  fs.mkdirSync(directory, { recursive: true })
  const temporary = fs.mkdtempSync(path.join(directory, '.project-pack-')), records = [], archives = {}
  function place(filename, object) {
    const target = path.join(directory, cachePath(object))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.linkSync(filename, target)
    records.push({ object, source: target })
  }
  try {
    const index = archiveIndex({ store, paths: full.indexPaths, archive: path.join(temporary, 'index.tar.zst') })
    const indexObject = { kind: 'index', id: index.sha256, size: index.size, tarBytes: index.tarBytes }
    place(index.archive, indexObject)
    for (const entry of Object.values(manifest.entries)) entry.index = index
    for (const [key, chunk] of Object.entries(manifest.chunks)) {
      const filename = path.join(temporary, `${key}.tar.zst`)
      const archive = await writeTarChunk({ chunk, source: relative => fs.createReadStream(full.sourceFiles[relative]), filename })
      await verifyTarChunk({ chunk, input: fs.createReadStream(filename), archiveSha256: archive.sha256 })
      archives[key] = archive
      place(filename, { kind: 'cafs', id: archive.sha256, size: archive.size, rawBytes: chunk.size, fileCount: chunk.files.length })
      if (records.length % 20 === 0) console.log(`Packed ${records.length - 1}/${Object.keys(manifest.chunks).length} project chunks`)
    }
    const material = { sourceLockfile: context.lockfile, context: { layout: full.layout }, manifest, archives }
    const catalog = createProjectCatalog({ material, context, targetBytes }), bytes = Buffer.from(JSON.stringify(catalog))
    const object = { kind: 'catalog', id: catalogId(context, targetBytes), sha256: sha256(bytes), size: bytes.length }
    const filename = path.join(temporary, 'catalog.json'); fs.writeFileSync(filename, bytes); place(filename, object)
    fs.writeFileSync(path.join(directory, 'catalog.json'), bytes)
    return { catalog, catalogObject: object, records, full, metrics: { context, targetBytes, projects,
      projectCount: Object.keys(projects).length, chunkCount: Object.keys(archives).length, catalogBytes: bytes.length,
      globalIndexBytes: index.size, rawBytes: full.files.reduce((sum, file) => sum + file.size, 0), totalMs: performance.now() - started } }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}
