import fs from 'node:fs'
import path from 'node:path'

const methods = ['mkdirSync', 'lstatSync', 'readFileSync', 'openSync', 'writeSync', 'closeSync', 'linkSync', 'chmodSync', 'utimesSync', 'rmSync']

export function startFileProfile() {
  const originals = Object.fromEntries(methods.map(name => [name, fs[name]])), operations = {}
  const started = performance.now(), cpu = process.cpuUsage()
  for (const name of methods) fs[name] = function (...args) {
    const row = operations[name] ??= { calls: 0, ms: 0, errors: 0 }, before = performance.now()
    row.calls++
    try { return originals[name].apply(this, args) } catch (error) { row.errors++; throw error }
    finally { row.ms += performance.now() - before }
  }
  return () => {
    for (const name of methods) fs[name] = originals[name]
    return { note: 'Inclusive synchronous fs timings; do not sum nested operations', platform: process.platform,
      node: process.version, elapsedMs: performance.now() - started, cpu: process.cpuUsage(cpu), operations }
  }
}

if (process.env.PROFILE_FS_OUTPUT) {
  const stop = startFileProfile()
  process.once('exit', () => {
    const result = stop(), filename = process.env.PROFILE_FS_OUTPUT
    fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, JSON.stringify(result, null, 2) + '\n')
  })
}
