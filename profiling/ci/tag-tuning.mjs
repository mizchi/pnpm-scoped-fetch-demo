import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const implementation = process.env.TUNING_IMPLEMENTATION
if (!['baseline', 'candidate'].includes(implementation)) throw new Error('Invalid tuning implementation')
const profile = process.env.TUNING_PROFILE === 'true', filename = path.resolve('.measurements/cwd-consumer.json')
const result = JSON.parse(fs.readFileSync(filename)), source = path.resolve(process.env.TUNING_CODE_ROOT ?? '.')
result.kind = profile ? 'profile-consumer' : 'tuning-consumer'
result.implementation = implementation
result.implementationSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
result.profile = profile
fs.writeFileSync(path.join(path.dirname(filename), profile ? 'profile-consumer.json' : 'tuning-consumer.json'), JSON.stringify(result, null, 2) + '\n')
fs.unlinkSync(filename)
console.log('TUNING_RESULT ' + JSON.stringify({ implementation, implementationSha: result.implementationSha, profile,
  scenario: result.scenario, sample: result.sample, bytes: result.totalProviderBytes, totalMs: result.totalMs,
  steps: result.steps.map(step => ({ importer: step.importer, validationMs: step.validationMs, restoreMs: step.restoreMs,
    hydrateMs: step.hydrateMs, installMs: step.installMs, totalMs: step.totalMs, bytes: step.providerBytes })) }))
