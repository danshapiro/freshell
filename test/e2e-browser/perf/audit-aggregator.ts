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
  terminalInputToFirstOutputMs?: number
  httpRequestsBeforeReady?: number
  httpBytesBeforeReady?: number
  wsFramesBeforeReady?: number
  wsBytesBeforeReady?: number
  offscreenHttpRequestsBeforeReady?: number
  offscreenHttpBytesBeforeReady?: number
  offscreenWsFramesBeforeReady?: number
  offscreenWsBytesBeforeReady?: number
}>> 

function summarizeSample(sample: VisibleFirstAuditSample) {
  const derived = sample.derived as Record<string, number | undefined>
  return {
    status: sample.status,
    durationMs: sample.durationMs,
    focusedReadyMs: derived.focusedReadyMs,
    wsReadyMs: derived.wsReadyMs,
    terminalInputToFirstOutputMs: derived.terminalInputToFirstOutputMs,
    httpRequestsBeforeReady: derived.httpRequestsBeforeReady,
    httpBytesBeforeReady: derived.httpBytesBeforeReady,
    wsFramesBeforeReady: derived.wsFramesBeforeReady,
    wsBytesBeforeReady: derived.wsBytesBeforeReady,
    offscreenHttpRequestsBeforeReady: derived.offscreenHttpRequestsBeforeReady,
    offscreenHttpBytesBeforeReady: derived.offscreenHttpBytesBeforeReady,
    offscreenWsFramesBeforeReady: derived.offscreenWsFramesBeforeReady,
    offscreenWsBytesBeforeReady: derived.offscreenWsBytesBeforeReady,
  }
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
