import type {
  VisibleFirstAuditArtifact,
  VisibleFirstAuditSample,
  VisibleFirstProfileId,
} from './audit-contract.js'

type NumericDelta = {
  base?: number
  candidate?: number
  delta: number
}

type DiffProfile = {
  profileId: VisibleFirstProfileId
  baseStatus?: VisibleFirstAuditSample['status']
  candidateStatus?: VisibleFirstAuditSample['status']
  derived: Record<string, NumericDelta>
}

type DiffScenario = {
  scenarioId: string
  profiles: DiffProfile[]
}

export type VisibleFirstAuditDiff = {
  schemaVersion: 1
  baseGeneratedAt: string
  candidateGeneratedAt: string
  scenarios: DiffScenario[]
}

function toSampleMap(samples: VisibleFirstAuditSample[]): Map<VisibleFirstProfileId, VisibleFirstAuditSample> {
  return new Map(samples.map((sample) => [sample.profileId, sample]))
}

function diffDerived(
  baseDerived: Record<string, unknown>,
  candidateDerived: Record<string, unknown>,
): Record<string, NumericDelta> {
  const keys = new Set([...Object.keys(baseDerived), ...Object.keys(candidateDerived)])
  const diff: Record<string, NumericDelta> = {}

  for (const key of keys) {
    const base = typeof baseDerived[key] === 'number' ? baseDerived[key] as number : undefined
    const candidate = typeof candidateDerived[key] === 'number' ? candidateDerived[key] as number : undefined
    diff[key] = {
      ...(base !== undefined ? { base } : {}),
      ...(candidate !== undefined ? { candidate } : {}),
      delta: (candidate ?? 0) - (base ?? 0),
    }
  }

  return diff
}

export function compareVisibleFirstAudits(
  base: VisibleFirstAuditArtifact,
  candidate: VisibleFirstAuditArtifact,
): VisibleFirstAuditDiff {
  return {
    schemaVersion: 1,
    baseGeneratedAt: base.generatedAt,
    candidateGeneratedAt: candidate.generatedAt,
    scenarios: base.scenarios.map((baseScenario) => {
      const candidateScenario = candidate.scenarios.find((scenario) => scenario.id === baseScenario.id)
      const baseSamples = toSampleMap(baseScenario.samples)
      const candidateSamples = toSampleMap(candidateScenario?.samples ?? [])
      const profileIds = new Set<VisibleFirstProfileId>([
        ...baseSamples.keys(),
        ...candidateSamples.keys(),
      ])

      return {
        scenarioId: baseScenario.id,
        profiles: [...profileIds].map((profileId) => {
          const baseSample = baseSamples.get(profileId)
          const candidateSample = candidateSamples.get(profileId)
          return {
            profileId,
            ...(baseSample ? { baseStatus: baseSample.status } : {}),
            ...(candidateSample ? { candidateStatus: candidateSample.status } : {}),
            derived: diffDerived(
              (baseSample?.derived as Record<string, unknown> | undefined) ?? {},
              (candidateSample?.derived as Record<string, unknown> | undefined) ?? {},
            ),
          }
        }),
      }
    }),
  }
}
