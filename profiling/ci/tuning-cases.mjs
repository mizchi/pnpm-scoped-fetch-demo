export const tuningBaseline = 'd4aca5a1a871a5c08b79c1c294384f7e02899ec9'

export function tuningMatrix(catalogDigest) {
  const include = []
  for (let sample = 1; sample <= 3; sample++) for (const scenario of ['sdk', 'sequence']) for (const implementation of ['baseline', 'candidate']) {
    include.push({ label: `tuning-${scenario}-${implementation}-${sample}`, strategy: 'chunks', scenario, implementation, sample, profile: false, digest: catalogDigest })
  }
  for (const implementation of ['baseline', 'candidate']) include.push({ label: `tuning-profile-${implementation}`, strategy: 'chunks',
    scenario: 'sequence', implementation, sample: 0, profile: true, digest: catalogDigest })
  return { include }
}
