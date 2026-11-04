import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { zstdCompressSync } from 'node:zlib'
import tar from 'tar-stream'
import { sha256 } from '../../action/chunk-identity.mjs'
import { writeTarChunk } from '../tar-zstd.mjs'
import { workspaceContext } from '../workspace-context.mjs'

export async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-initialize-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = path.join(root, 'store'), stateDirectory = path.join(root, 'state'), workspace = path.join(root, 'workspace')
  const cwd = path.join(workspace, 'apps/web'); fs.mkdirSync(cwd, { recursive: true })
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"web"}')
  fs.writeFileSync(path.join(workspace, 'pnpm-workspace.yaml'), 'packages: [apps/*]')
  fs.writeFileSync(path.join(workspace, 'package.json'), '{"name":"root","private":true}')
  fs.mkdirSync(path.join(workspace, 'apps/admin'), { recursive: true }); fs.writeFileSync(path.join(workspace, 'apps/admin/package.json'), '{"name":"admin"}')
  fs.writeFileSync(path.join(workspace, 'pnpm-lock.yaml'), JSON.stringify({ lockfileVersion: '9.0', importers: { '.': {}, 'apps/web': {}, 'apps/admin': {} }, snapshots: {} }))
  const binary = path.join(root, 'pnpm'); fs.writeFileSync(binary, 'native-binary-fixture')
  const bytes = Buffer.from('shared package content'), digest = createHash('sha512').update(bytes).digest('hex')
  const file = { path: `v11/files/${digest.slice(0, 2)}/${digest.slice(2)}`, size: bytes.length, sha256: sha256(bytes), mode: 0o444 }
  const cafs = await writeTarChunk({ chunk: { files: [file] }, source: () => Readable.from([bytes]), filename: path.join(root, 'cafs') })
  const key = 'sha512-package\tpackage@1.0.0', hash = sha256(key), header = Buffer.alloc(4); header.writeUInt32LE(Buffer.byteLength(key))
  const row = Buffer.concat([header, Buffer.from(key), Buffer.from('msgpack bytes')])
  const indexFile = { path: `v11/index/${hash.slice(0, 2)}/${hash.slice(2)}`, size: row.length, sha256: sha256(row), mode: 0o644 }
  const pack = tar.pack(), buffers = []
  const reading = (async () => { for await (const bytes of pack) buffers.push(bytes) })()
  pack.entry({ name: indexFile.path, mode: 0o644, type: 'file', mtime: new Date(0) }, row); pack.finalize(); await reading
  const archive = zstdCompressSync(Buffer.concat(buffers)); fs.writeFileSync(path.join(root, 'index'), archive)
  const object = { kind: 'cafs', id: cafs.sha256, size: cafs.size, fileCount: 1, rawBytes: bytes.length }
  const index = { kind: 'index', id: sha256(archive), size: archive.length, tarBytes: row.length + 10240 }
  const plan = { layout: 'v11', objects: [object], index }, calls = []
  const cache = { stateDirectory, archivePath: entry => path.join(root, entry.kind), restore: async entries => {
    calls.push(entries.map(entry => entry.id)); return entries.map(entry => ({ key: entry.id, hit: true }))
  } }
  const context = await workspaceContext(workspace, binary)
  const sourceManifests = Object.fromEntries(['.', 'apps/web', 'apps/admin'].map(importer => [importer, sha256(fs.readFileSync(path.join(workspace, importer, 'package.json')))]))
  cache.catalog = { version: 1, context, targetBytes: 1024, layout: 'v11', projects: { 'apps/web': [object.id], 'apps/admin': [object.id] }, objects: { [object.id]: object }, index, sourceManifests }
  return { root, store, plan, cache, calls, file, indexFile, row, cwd, workspace, binary }
}

