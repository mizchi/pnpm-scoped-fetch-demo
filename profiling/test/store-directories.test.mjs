import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { storeDirectories } from '../store-directories.mjs'

test('one store operation validates a shared parent once and creates missing directories', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-store-directories-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let calls = 0
  const original = fs.lstatSync
  fs.lstatSync = (...args) => { calls++; return original(...args) }
  try {
    const prepare = storeDirectories(root, { create: true })
    for (let index = 0; index < 20; index++) prepare(`v11/files/ab/${index}`)
    prepare('v11/files/cd/next')
    assert.equal(calls, 5)
    assert(fs.statSync(path.join(root, 'v11/files/cd')).isDirectory())
  } finally { fs.lstatSync = original }
})

test('directory validation is not retained across operations and refuses symlinks and escapes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-store-directories-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  storeDirectories(root, { create: true })('v11/files/ab/one')
  fs.renameSync(path.join(root, 'v11'), path.join(root, 'old'))
  fs.symlinkSync(path.join(root, 'old'), path.join(root, 'v11'))
  assert.throws(() => storeDirectories(root)('v11/files/ab/two'), /directory/)
  for (const name of ['../escape', '/absolute', 'v11/../escape', 'v11/files:bad/value', 'v11\\files\\escape']) {
    assert.throws(() => storeDirectories(root)(name), /Unsafe/)
  }
})
