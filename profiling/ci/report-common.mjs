import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

export function statistics(values) {
  assert(values.length && values.every(value => Number.isFinite(value) && value >= 0), 'Invalid measurement')
  const sorted = values.toSorted((left, right) => left - right), middle = Math.floor(sorted.length / 2)
  return { min: sorted[0], median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, max: sorted.at(-1) }
}

export function readResults(directory, names) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) return readResults(filename, names)
    return names.includes(entry.name) ? [JSON.parse(fs.readFileSync(filename, 'utf8'))] : []
  })
}
