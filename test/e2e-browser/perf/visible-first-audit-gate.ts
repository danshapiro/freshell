import {
  AUDIT_PROFILE_IDS,
  AUDIT_SCENARIO_IDS,
  assertVisibleFirstAuditTrusted,
  type VisibleFirstAuditArtifact,
  type VisibleFirstProfileId,
  type VisibleFirstScenarioId,
} from './audit-contract.js'

export type VisibleFirstAuditGateResult = {
  ok: boolean
  violations: Array<{
    scenarioId: string
    profileId: string
    metric:
      | 'focusedReadyMs'
      | 'terminalInputToFirstOutputMs'
      | 'offscreenHttpRequestsBeforeReady'
      | 'offscreenHttpBytesBeforeReady'
      | 'offscreenWsFramesBeforeReady'
      | 'offscreenWsBytesBeforeReady'
    base: number
    candidate: number
    delta: number
  }>
}

type GateMetric = VisibleFirstAuditGateResult['violations'][number]['metric']

const TERMINAL_LATENCY_SCENARIOS = new Set<VisibleFirstScenarioId>([
  'terminal-cold-boot',
  'terminal-reconnect-backlog',
])

const OFFSCREEN_METRICS: GateMetric[] = [
  'offscreenHttpRequestsBeforeReady',
  'offscreenHttpBytesBeforeReady',
  'offscreenWsFramesBeforeReady',
  'offscreenWsBytesBeforeReady',
]

function assertFullAuditMatrix(artifact: VisibleFirstAuditArtifact, label: string): void {
  const profileIds = new Set(artifact.profiles.map((profile) => profile.id))
  for (const profileId of AUDIT_PROFILE_IDS) {
    if (!profileIds.has(profileId)) {
      throw new Error(`${label} missing profile ${profileId}`)
    }
  }

  const scenarios = new Map(artifact.scenarios.map((scenario) => [scenario.id, scenario]))
  for (const scenarioId of AUDIT_SCENARIO_IDS) {
    const scenario = scenarios.get(scenarioId)
    if (!scenario) {
      throw new Error(`${label} missing scenario ${scenarioId}`)
    }

    const sampleProfiles = new Set(scenario.samples.map((sample) => sample.profileId))
    for (const profileId of AUDIT_PROFILE_IDS) {
      if (!sampleProfiles.has(profileId)) {
        throw new Error(`${label} missing scenario/profile pair ${scenarioId}/${profileId}`)
      }
    }
  }
}

function getScenario(
  artifact: VisibleFirstAuditArtifact,
  scenarioId: VisibleFirstScenarioId,
) {
  const scenario = artifact.scenarios.find((entry) => entry.id === scenarioId)
  if (!scenario) {
    throw new Error(`Visible-first audit missing scenario ${scenarioId}`)
  }
  return scenario
}

function getMetricValue(
  artifact: VisibleFirstAuditArtifact,
  scenarioId: VisibleFirstScenarioId,
  profileId: VisibleFirstProfileId,
  metric: GateMetric,
): number {
  const scenario = getScenario(artifact, scenarioId)
  const summary = scenario.summaryByProfile[profileId]
  const value = summary?.[metric]
  return typeof value === 'number' ? value : 0
}

function createViolation(
  base: VisibleFirstAuditArtifact,
  candidate: VisibleFirstAuditArtifact,
  scenarioId: VisibleFirstScenarioId,
  profileId: VisibleFirstProfileId,
  metric: GateMetric,
) {
  const baseValue = getMetricValue(base, scenarioId, profileId, metric)
  const candidateValue = getMetricValue(candidate, scenarioId, profileId, metric)
  const delta = candidateValue - baseValue

  if (delta <= 0) {
    return null
  }

  return {
    scenarioId,
    profileId,
    metric,
    base: baseValue,
    candidate: candidateValue,
    delta,
  }
}

export function evaluateVisibleFirstAuditGate(
  base: VisibleFirstAuditArtifact,
  candidate: VisibleFirstAuditArtifact,
): VisibleFirstAuditGateResult {
  assertVisibleFirstAuditTrusted(base)
  assertVisibleFirstAuditTrusted(candidate)
  assertFullAuditMatrix(base, 'base')
  assertFullAuditMatrix(candidate, 'candidate')

  const violations: VisibleFirstAuditGateResult['violations'] = []

  for (const scenarioId of AUDIT_SCENARIO_IDS) {
    const focusedReadyViolation = createViolation(
      base,
      candidate,
      scenarioId,
      'mobile_restricted',
      'focusedReadyMs',
    )
    if (focusedReadyViolation) {
      violations.push(focusedReadyViolation)
    }
  }

  for (const scenarioId of AUDIT_SCENARIO_IDS) {
    if (!TERMINAL_LATENCY_SCENARIOS.has(scenarioId)) continue
    const terminalLatencyViolation = createViolation(
      base,
      candidate,
      scenarioId,
      'mobile_restricted',
      'terminalInputToFirstOutputMs',
    )
    if (terminalLatencyViolation) {
      violations.push(terminalLatencyViolation)
    }
  }

  for (const scenarioId of AUDIT_SCENARIO_IDS) {
    for (const profileId of AUDIT_PROFILE_IDS) {
      for (const metric of OFFSCREEN_METRICS) {
        const offscreenViolation = createViolation(base, candidate, scenarioId, profileId, metric)
        if (offscreenViolation) {
          violations.push(offscreenViolation)
        }
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
  }
}
