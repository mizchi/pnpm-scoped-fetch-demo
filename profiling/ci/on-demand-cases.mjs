export const currentStrategies = ['whole', 'scoped', 'chunks', 'registry']
export const currentScenarios = ['sdk', 'sequence']

export function currentDirectories(scenario) {
  if (scenario === 'sdk') return ['sdk']
  if (scenario === 'sequence') return ['packages/system-data', 'sdk', 'sdk']
  throw new Error(`Unknown current-project scenario: ${scenario}`)
}

export function currentMatrix({ catalogDigest, whole, scoped }) {
  const include = []
  for (let sample = 1; sample <= 3; sample++) for (const scenario of currentScenarios) for (const strategy of currentStrategies) {
    include.push({ label: `cwd-${scenario}-${strategy}-${sample}`, strategy, scenario, sample, digest: catalogDigest,
      storeObject: ['whole', 'scoped'].includes(strategy) ? JSON.stringify(strategy === 'whole' ? whole : scoped) : '' })
  }
  return { include }
}
