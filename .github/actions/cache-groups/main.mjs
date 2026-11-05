import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
const source = path.resolve(process.env['INPUT_CODE-ROOT'] || '.')
if (path.relative(process.cwd(), source).startsWith('..')) throw new Error('Benchmark source must be inside the workspace')
const profiling = process.env.INPUT_PROFILE === 'true'
if (profiling) fs.mkdirSync('.measurements/profiles', { recursive: true })
const profiler = fileURLToPath(new URL('../../../profiling/fs-profile.mjs', import.meta.url))
const args = profiling ? ['--cpu-prof', '--cpu-prof-dir=.measurements/profiles', '--cpu-prof-name=runtime.cpuprofile', '--import', profiler] : []
args.push(path.join(source, process.env.INPUT_MODE === 'native-diagnostics' ? 'profiling/ci/native-diagnostics.mjs' : 'profiling/ci/benchmark.mjs'))
const env = { ...process.env, ...(profiling ? { PROFILE_FS_OUTPUT: '.measurements/profiles/file-operations.json' } : {}) }
const child = spawn('node', args, { stdio: 'inherit', env })
try { const [code] = await once(child, 'exit'); process.exitCode = code ?? 1 } catch (error) { console.error(error.message); process.exitCode = 1 }
