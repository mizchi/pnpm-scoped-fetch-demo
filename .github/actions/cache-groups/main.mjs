import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
const child = spawn('node', [fileURLToPath(new URL('../../../profiling/ci/benchmark.mjs', import.meta.url))], { stdio: 'inherit', env: process.env })
try { const [code] = await once(child, 'exit'); process.exitCode = code ?? 1 } catch (error) { console.error(error.message); process.exitCode = 1 }
