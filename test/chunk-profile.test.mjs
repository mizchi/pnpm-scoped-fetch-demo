import assert from 'node:assert/strict'
import test from 'node:test'
import { profilePolicies } from '../action/chunk-profile.mjs'
import { sha256 } from '../action/cache-groups.mjs'

const bytes = { a: Buffer.alloc(64, 1), b: Buffer.alloc(64, 2), c: Buffer.alloc(64, 3), changed: Buffer.alloc(64, 4) }
const file = name => ({ path: `v11/files/ab/${name}`, size: bytes[name].length, sha256: sha256(bytes[name]), mode: 0o444 })
const before = {
  context: { test: true }, inventories: { build: [file('a'), file('b')], lint: [file('c')] },
  packageGraph: { 'pkg@1': { name: 'pkg', dependencies: [] } },
  filePackages: Object.fromEntries(['a', 'b', 'c'].map(name => [file(name).path, ['pkg@1']])),
  indexes: { build: { size: 7 }, lint: { size: 11 } },
}
const readFile = (_snapshot, relative) => bytes[relative.split('/').at(-1)]
const policies = [{ name: 'auto', targetBytes: 64 }, { name: 'manual', manualGroups: [{ name: 'all', packages: ['pkg'] }] }]

function profile(after = before) {
  return profilePolicies({ before, after, policies, readFile, iterations: 2 })
}

test('profile reports the request and overfetch tradeoff for manual coalescing', () => {
  const report = profile()
  const automatic = report.policies[0].entries.lint
  const manual = report.policies[1].entries.lint
  assert.equal(automatic.extraRawBytes, 0)
  assert.equal(manual.extraRawBytes, 128)
  assert.equal(automatic.restoreBytes, automatic.payloadArchiveBytes + 11)
  assert.equal(automatic.restoreRequests, 2)
  assert.equal(report.policies[0].entries.build.restoreRequests, 3)
  assert.equal(report.policies[1].entries.build.restoreRequests, 2)
  assert.equal(report.policies[0].policyTransition.newPayloadArchiveBytes, 0)
  assert(report.policies[1].policyTransition.newPayloadArchiveBytes > 0)
})

test('unchanged content needs no new chunk upload while a fresh runner still restores bytes', () => {
  for (const result of profile().policies) {
    assert.equal(result.newPayloadArchiveBytes, 0)
    assert.equal(result.entries.build.newPayloadArchiveBytes, 0)
    assert(result.entries.build.restoreBytes > 0)
    assert.equal(result.entries.build.payloadReusePercent, 100)
  }
})

test('one update retains unaffected chunk identities and upload bytes count only new chunks', () => {
  const after = { ...before, inventories: { ...before.inventories, build: [file('a'), file('changed')] },
    filePackages: { ...before.filePackages, [file('changed').path]: ['pkg@1'] } }
  const report = profile(after)
  const automatic = report.policies[0]
  const manual = report.policies[1]
  assert.equal(automatic.entries.lint.newPayloadArchiveBytes, 0)
  assert.equal(automatic.entries.build.newPayloadRequests, 1)
  assert(automatic.entries.build.payloadReusePercent > 0)
  assert.equal(manual.entries.build.payloadReusePercent, 0)
  assert.equal(manual.entries.lint.newPayloadRequests, 1)
})

test('timings retain samples and bounded summary, and invalid iteration counts fail', () => {
  const result = profile().policies[0]
  assert.equal(result.timings.encodeMs.samples.length, 2)
  assert(result.timings.encodeMs.min <= result.timings.encodeMs.median)
  assert(result.timings.encodeMs.median <= result.timings.encodeMs.max)
  assert.throws(() => profilePolicies({ before, policies, readFile, iterations: 0 }), /iterations/)
  assert.throws(() => profilePolicies({ before, policies: [policies[0], policies[0]], readFile }), /Duplicate policy/)
  assert.throws(() => profilePolicies({ before, policies: [], readFile }), /at least one policy/)
})

test('Pareto candidates retain byte/request tradeoffs and reject a dominated policy', async () => {
  const { paretoCandidates } = await import('../action/chunk-profile.mjs')
  const candidates = [
    { name: 'small', bytes: 100, requests: 5 },
    { name: 'large', bytes: 200, requests: 2 },
    { name: 'waste', bytes: 300, requests: 6 },
  ]
  assert.deepEqual(paretoCandidates(candidates, ['bytes', 'requests']), ['small', 'large'])
})

test('comparison rejects changed workload sets rather than omitting new consumers', () => {
  assert.throws(() => profilePolicies({ before, after: { ...before, inventories: { ...before.inventories, deploy: [file('c')] } }, policies, readFile }), /same workloads/)
})

test('async archive profiling shares restore/reuse accounting with the buffer codec', async () => {
  const { profileArchivePolicies } = await import('../action/chunk-profile.mjs')
  const { planGroups, encodeChunk } = await import('../action/cache-groups.mjs')
  const report = await profileArchivePolicies({ before, after: before, policies, iterations: 1, codec: 'external archive',
    materialize: async (snapshot, policy, iterations) => {
      assert.equal(iterations, 1)
      const manifest = planGroups(snapshot.inventories, { ...policy, context: snapshot.context,
        packageGraph: snapshot.packageGraph, filePackages: snapshot.filePackages })
      const archiveSizes = Object.fromEntries(Object.entries(manifest.chunks).map(([key, chunk]) => [key, encodeChunk(chunk, relative => readFile(snapshot, relative)).length]))
      return { manifest, archiveSizes, timings: {} }
    },
  })
  assert.equal(report.codec, 'external archive')
  assert.deepEqual(report.policies.map(policy => policy.entries), profile().policies.map(policy => policy.entries))
  await assert.rejects(profileArchivePolicies({ before, policies, iterations: 0, materialize: () => assert.fail('Must validate first') }), /iterations/)
})
