import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { stageStore } from '../store-staging.mjs'

test('a scoped baseline stages only its selected payload and index without hydrating an inner archive', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-stage-store-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source'), index = path.join(root, 'index'), destination = path.join(root, 'destination')
  fs.mkdirSync(source)
  fs.writeFileSync(path.join(source, 'selected'), 'selected')
  fs.writeFileSync(path.join(source, 'other'), 'other')
  fs.mkdirSync(path.join(index, 'v11/index/ab'), { recursive: true })
  fs.writeFileSync(path.join(index, 'v11/index/ab/row'), 'index')
  const relative = 'v11/files/ab/selected'
  stageStore({ directory: destination, layout: 'v11', files: [{ path: relative }], sourceFiles: { [relative]: path.join(source, 'selected') }, indexDirectory: index })
  assert.equal(fs.readFileSync(path.join(destination, relative), 'utf8'), 'selected')
  assert.equal(fs.statSync(path.join(destination, relative)).ino, fs.statSync(path.join(source, 'selected')).ino)
  assert.equal(fs.readFileSync(path.join(destination, 'v11/index/ab/row'), 'utf8'), 'index')
  assert.deepEqual(fs.readdirSync(path.join(destination, 'v11/files/ab')), ['selected'])
})
