import type {
  VisibleFirstAuditSample,
  VisibleFirstAuditScenario,
  VisibleFirstProfileId,
} from './audit-contract.js'

export type VisibleFirstScenarioSummary = Partial<Record<VisibleFirstProfileId, {
  status: VisibleFirstAuditSample['status']
  durationMs: number
  focusedReadyMs?: number
  wsReadyMs?: number
  maxRafGapMs?: number
  terminalInputToFirstOutputMs?: number
  httpRequestsBeforeReady?: number
  httpBytesBeforeReady?: number
  wsFramesBeforeReady?: number
  wsBytesBeforeReady?: number
  offscreenHttpRequestsBeforeReady?: number
  offscreenHttpBytesBeforeReady?: number
  offscreenWsFramesBeforeReady?: number
  offscreenWsBytesBeforeReady?: number
  terminalReplayMessageCount?: number
  terminalReplaySerializedBytes?: number
  terminalParserAppliedLagMs?: number
  terminalReplayGapCount?: number
  terminalFullHydrateFallbackCount?: number
  terminalSurfaceQuarantineCount?: number
  terminalStaleGenerationRejectionCount?: number
  terminalStoppedRetentionCoveredMs?: number
  terminalStopResumeGapCount?: number
} & Record<string, unknown>>>

function summarizeSample(sample: VisibleFirstAuditSample) {
  const derived = sample.derived as Record<string, number | undefined>
  const summary: Record<string, unknown> = {
    status: sample.status,
    durationMs: sample.durationMs,
  }

  for (const [metric, value] of Object.entries(derived)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      summary[metric] = value
    }
  }

  return summary
}

export function summarizeScenarioSamples(
  scenario: Pick<VisibleFirstAuditScenario, 'samples'>,
): VisibleFirstScenarioSummary {
  const summary: VisibleFirstScenarioSummary = {}

  for (const sample of scenario.samples) {
    summary[sample.profileId] = summarizeSample(sample)
  }

  return summary
}
