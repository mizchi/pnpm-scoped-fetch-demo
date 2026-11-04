import fs from 'node:fs'
import path from 'node:path'

/** Validate each parent once during one store operation with exclusive access. */
export function storeDirectories(directory, { create = false } = {}) {
  const checked = new Set()
  function check(parent, createParent = create) {
    if (checked.has(parent)) return
    if (createParent) try { fs.mkdirSync(parent) } catch (error) { if (error.code !== 'EEXIST') throw error }
    const stat = fs.lstatSync(parent)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe destination directory: ${parent}`)
    checked.add(parent)
  }
  check(directory, false)
  return relative => {
    const segments = relative.split('/')
    if (/^[\\/]|\\/.test(relative) || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes(':'))) throw new Error(`Unsafe destination path: ${relative}`)
    let parent = directory
    for (const segment of segments.slice(0, -1)) { parent = path.join(parent, segment); check(parent) }
  }
}
