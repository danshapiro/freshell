export type VisibleFirstHttpObservation = {
  timestamp: number
  routeId?: string | null
  url?: string
  encodedDataLength?: number | null
  bytes?: number | null
}

export type VisibleFirstWsObservation = {
  timestamp: number
  type?: string | null
  payload?: string
  payloadLength?: number | null
  bytes?: number | null
}

export type DerivedMetricsInput = {
  focusedReadyMilestone: string
  allowedApiRouteIdsBeforeReady: readonly string[]
  allowedWsTypesBeforeReady: readonly string[]
  allowedFreshAgentEventTypesBeforeReady?: readonly string[]
  browser: {
    milestones: Record<string, number>
    perfEvents?: Array<Record<string, unknown>>
    terminalLatencySamplesMs?: number[]
  }
  transport: {
    http?: { requests: VisibleFirstHttpObservation[] }
    ws?: { frames: VisibleFirstWsObservation[] }
  }
  server?: {
    terminalReplayEvents?: Array<Record<string, unknown>>
  }
}

export type VisibleFirstDerivedMetrics = {
  focusedReadyMs: number
  wsReadyMs?: number
  maxRafGapMs?: number
  terminalInputToFirstOutputMs?: number
  httpRequestsBeforeReady: number
  httpBytesBeforeReady: number
  wsFramesBeforeReady: number
  wsBytesBeforeReady: number
  offscreenHttpRequestsBeforeReady: number
  offscreenHttpBytesBeforeReady: number
  offscreenWsFramesBeforeReady: number
  offscreenWsBytesBeforeReady: number
  terminalReplayMessageCount: number
  terminalReplaySerializedBytes: number
  terminalParserAppliedLagMs?: number
  terminalReplayGapCount: number
  terminalFullHydrateFallbackCount: number
  terminalSurfaceQuarantineCount: number
  terminalStaleGenerationRejectionCount: number
  terminalStoppedRetentionCoveredMs?: number
  terminalStopResumeGapCount?: number
}

const IGNORED_ROUTE_IDS = new Set(['/api/health', '/api/logs/client'])

function normalizeAuditPath(pathname: string): string | null {
  if (!pathname.startsWith('/api/')) return null
  if (IGNORED_ROUTE_IDS.has(pathname)) return null

  const sessionRouteMatch = pathname.match(/^\/api\/sessions\/[^/]+$/)
  if (sessionRouteMatch) {
    return '/api/sessions/:sessionId'
  }

  const freshAgentTurnsMatch = pathname.match(/^\/api\/fresh-agent\/threads\/[^/]+\/[^/]+\/[^/]+\/turns$/)
  if (freshAgentTurnsMatch) {
    return '/api/fresh-agent/threads/:sessionType/:provider/:threadId/turns'
  }

  const freshAgentTurnMatch = pathname.match(/^\/api\/fresh-agent\/threads\/[^/]+\/[^/]+\/[^/]+\/turns\/[^/]+$/)
  if (freshAgentTurnMatch) {
    return '/api/fresh-agent/threads/:sessionType/:provider/:threadId/turns/:turnId'
  }

  const terminalViewportMatch = pathname.match(/^\/api\/terminals\/[^/]+\/viewport$/)
  if (terminalViewportMatch) {
    return '/api/terminals/:terminalId/viewport'
  }

  const terminalScrollbackMatch = pathname.match(/^\/api\/terminals\/[^/]+\/scrollback$/)
  if (terminalScrollbackMatch) {
    return '/api/terminals/:terminalId/scrollback'
  }

  const terminalSearchMatch = pathname.match(/^\/api\/terminals\/[^/]+\/search$/)
  if (terminalSearchMatch) {
    return '/api/terminals/:terminalId/search'
  }

  const terminalRouteMatch = pathname.match(/^\/api\/terminals\/[^/]+$/)
  if (terminalRouteMatch) {
    return '/api/terminals/:terminalId'
  }

  return pathname
}

export function normalizeAuditRouteId(input: string): string | null {
  try {
    const parsed = input.startsWith('http://') || input.startsWith('https://')
      ? new URL(input)
      : new URL(input, 'http://localhost')
    return normalizeAuditPath(parsed.pathname)
  } catch {
    return normalizeAuditPath(input.split('?')[0] || '')
  }
}

export function classifyWsFrameType(rawPayload: string): string {
  try {
    const parsed = JSON.parse(rawPayload) as { type?: unknown }
    return typeof parsed?.type === 'string' && parsed.type.trim() ? parsed.type : 'unknown'
  } catch {
    return 'unknown'
  }
}

function classifyFreshAgentProviderEventType(rawPayload: string): string | null {
  try {
    const parsed = JSON.parse(rawPayload) as { type?: unknown; event?: { type?: unknown } }
    if (parsed?.type !== 'freshAgent.event') return null
    return typeof parsed.event?.type === 'string' && parsed.event.type.trim()
      ? parsed.event.type
      : 'unknown'
  } catch {
    return null
  }
}

function resolveWsReadyMs(input: DerivedMetricsInput): number | undefined {
  const event = input.browser.perfEvents?.find((entry) => entry.event === 'perf.ws_ready')
  const durationMs = event?.durationMs
  return typeof durationMs === 'number' && Number.isFinite(durationMs) ? durationMs : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nonnegativeMetric(value: unknown): number | undefined {
  const numberValue = finiteNumber(value)
  return numberValue === undefined ? undefined : Math.max(0, numberValue)
}

function parsePayload(payload?: string): Record<string, unknown> | null {
  if (!payload) return null
  try {
    const parsed = JSON.parse(payload) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function eventName(entry: Record<string, unknown>): string | null {
  return typeof entry.event === 'string' ? entry.event : null
}

function sumMetric(values: Iterable<unknown>): number {
  let sum = 0
  for (const value of values) {
    const numberValue = nonnegativeMetric(value)
    if (numberValue !== undefined) {
      sum += numberValue
    }
  }
  return sum
}

function countPerfEvents(input: DerivedMetricsInput, name: string): number {
  return (input.browser.perfEvents ?? []).filter((entry) => eventName(entry) === name).length
}

function finiteNonnegativeValues(values: Iterable<unknown>): number[] {
  return Array.from(values)
    .map(nonnegativeMetric)
    .filter((value): value is number => value !== undefined)
}

function resolveMaxRafGapMs(input: DerivedMetricsInput): number | undefined {
  const values = finiteNonnegativeValues((input.browser.perfEvents ?? [])
    .filter((entry) => eventName(entry) === 'visible_first.audit.max_raf_gap')
    .flatMap((entry) => [entry.maxGapMs, entry.durationMs]))
  return values.length > 0 ? Math.max(...values) : undefined
}

function isReplayBatchEvent(entry: Record<string, unknown>): boolean {
  return (
    entry.event === 'terminal.replay.batch'
    || entry.event === 'terminal.replay.progress'
  ) && entry.source === 'replay'
}

function replayBatchEventMessageCount(entry: Record<string, unknown>): number {
  if (entry.event !== 'terminal.replay.progress') return 1
  return nonnegativeMetric(entry.batchCount) ?? 1
}

function isReplayGapEvent(entry: Record<string, unknown>): boolean {
  return entry.event === 'terminal.replay.gap' || (
    entry.event === 'terminal.output.gap'
    && entry.source === 'replay'
  )
}

function isReceivedTerminalOutputFrame(frame: VisibleFirstWsObservation): boolean {
  return (frame as { direction?: unknown }).direction === undefined
    || (frame as { direction?: unknown }).direction === 'received'
}

function isReplayOutputPayload(payload: Record<string, unknown> | null): boolean {
  if (!payload) return false
  if (payload.type === 'terminal.output.batch') {
    return payload.source === 'replay'
  }
  if (payload.type === 'terminal.output') {
    return payload.source === 'replay'
  }
  return false
}

function replayWsFramesBeforeReady(input: DerivedMetricsInput, focusedReadyMs: number): VisibleFirstWsObservation[] {
  return (input.transport.ws?.frames ?? []).filter((frame) => {
    if (frame.timestamp > focusedReadyMs || !isReceivedTerminalOutputFrame(frame)) return false
    const frameType = frame.type ?? classifyWsFrameType(frame.payload ?? '')
    if (frameType !== 'terminal.output' && frameType !== 'terminal.output.batch') return false
    return isReplayOutputPayload(parsePayload(frame.payload))
  })
}

function replayWsGapFramesBeforeReady(input: DerivedMetricsInput, focusedReadyMs: number): VisibleFirstWsObservation[] {
  return (input.transport.ws?.frames ?? []).filter((frame) => {
    if (frame.timestamp > focusedReadyMs || !isReceivedTerminalOutputFrame(frame)) return false
    const frameType = frame.type ?? classifyWsFrameType(frame.payload ?? '')
    return frameType === 'terminal.output.gap'
  })
}

function isSentTerminalRecoveryInputFrame(frame: VisibleFirstWsObservation): boolean {
  if ((frame as { direction?: unknown }).direction !== 'sent') return false
  const frameType = frame.type ?? classifyWsFrameType(frame.payload ?? '')
  return frameType === 'terminal.input' || frameType === 'terminal.attach'
}

function resolveTerminalInputToFirstOutputMs(
  input: DerivedMetricsInput,
  focusedReadyMs: number,
): number | undefined {
  const explicitSample = input.browser.terminalLatencySamplesMs?.[0]
  if (typeof explicitSample === 'number' && Number.isFinite(explicitSample)) {
    return explicitSample
  }

  const frames = input.transport.ws?.frames ?? []
  const inputFrame = frames
    .filter((frame) => frame.timestamp <= focusedReadyMs && isSentTerminalRecoveryInputFrame(frame))
    .sort((a, b) => a.timestamp - b.timestamp)[0]
  if (!inputFrame) return undefined

  const outputFrame = frames
    .filter((frame) => {
      if (frame.timestamp < inputFrame.timestamp || frame.timestamp > focusedReadyMs) return false
      if (!isReceivedTerminalOutputFrame(frame)) return false
      const frameType = frame.type ?? classifyWsFrameType(frame.payload ?? '')
      return frameType === 'terminal.output' || frameType === 'terminal.output.batch'
    })
    .sort((a, b) => a.timestamp - b.timestamp)[0]
  if (!outputFrame) return undefined

  return Math.max(0, outputFrame.timestamp - inputFrame.timestamp)
}

function resolveReplayMessageCount(input: DerivedMetricsInput, replayFrames: VisibleFirstWsObservation[]): number {
  const serverReplayBatchEvents = (input.server?.terminalReplayEvents ?? []).filter(isReplayBatchEvent)
  return serverReplayBatchEvents.length > 0
    ? sumMetric(serverReplayBatchEvents.map(replayBatchEventMessageCount))
    : replayFrames.length
}

function resolveReplaySerializedBytes(input: DerivedMetricsInput, replayFrames: VisibleFirstWsObservation[]): number {
  const serverReplayBatchEvents = (input.server?.terminalReplayEvents ?? []).filter(isReplayBatchEvent)
  if (serverReplayBatchEvents.length > 0) {
    return sumMetric(serverReplayBatchEvents.map((entry) => entry.serializedBytes))
  }
  return replayFrames.reduce((sum, frame) => sum + resolveObservationBytes(frame), 0)
}

function resolveReplayGapCount(input: DerivedMetricsInput, focusedReadyMs: number): number {
  const serverReplayGapEvents = (input.server?.terminalReplayEvents ?? []).filter(isReplayGapEvent)
  return serverReplayGapEvents.length > 0
    ? serverReplayGapEvents.length
    : replayWsGapFramesBeforeReady(input, focusedReadyMs).length
}

function payloadSeqEnd(frame: VisibleFirstWsObservation): number | undefined {
  const payload = parsePayload(frame.payload)
  const seqEnd = payload?.seqEnd
  return typeof seqEnd === 'number' && Number.isFinite(seqEnd) ? seqEnd : undefined
}

function resolveParserAppliedLagMs(
  input: DerivedMetricsInput,
  replayFrames: VisibleFirstWsObservation[],
): number | undefined {
  const frameMilestones = replayFrames
    .map((frame) => {
      const seqEnd = payloadSeqEnd(frame)
      return seqEnd === undefined ? null : { seqEnd, timestamp: frame.timestamp }
    })
    .filter((entry): entry is { seqEnd: number; timestamp: number } => entry !== null)

  if (frameMilestones.length === 0) return undefined

  let maxLagMs = 0
  let observedParserAppliedEvidence = false
  const parserAppliedEvents = (input.browser.perfEvents ?? [])
    .filter((entry) => eventName(entry) === 'terminal.parser_applied')
  for (const event of parserAppliedEvents) {
    const timestamp = finiteNumber(event.timestamp)
    const parserAppliedSeq = finiteNumber(event.parserAppliedSeq)
    if (timestamp === undefined || parserAppliedSeq === undefined) continue
    const coveredFrames = frameMilestones.filter((frame) => frame.seqEnd <= parserAppliedSeq)
    if (coveredFrames.length === 0) continue
    observedParserAppliedEvidence = true
    const lastFrameTimestamp = Math.max(...coveredFrames.map((frame) => frame.timestamp))
    maxLagMs = Math.max(maxLagMs, Math.max(0, timestamp - lastFrameTimestamp))
  }

  return observedParserAppliedEvidence ? maxLagMs : undefined
}

function resolveStopResumeMetrics(input: DerivedMetricsInput): {
  terminalStoppedRetentionCoveredMs?: number
  terminalStopResumeGapCount?: number
} {
  const events = (input.browser.perfEvents ?? [])
    .filter((entry) => eventName(entry) === 'terminal.catchup.stop_resume')
    .filter((entry) => {
      const stoppedDurationMs = finiteNumber(entry.stoppedDurationMs)
      const outputStartedAfterStopMs = finiteNumber(entry.outputStartedAfterStopMs)
      const outputStartedBeforeResumeMs = finiteNumber(entry.outputStartedBeforeResumeMs)
      const cdpCatchupOutputMessageCount = finiteNumber(entry.cdpCatchupOutputMessageCount)
      const catchupOutputMessageCount = finiteNumber(entry.catchupOutputMessageCount)
      return entry.source === 'visible_first_audit_process_suspend'
        && entry.browserExecutionStopped === true
        && stoppedDurationMs !== undefined
        && stoppedDurationMs > 0
        && outputStartedAfterStopMs !== undefined
        && outputStartedAfterStopMs >= 0
        && outputStartedBeforeResumeMs !== undefined
        && outputStartedBeforeResumeMs >= 0
        && (
          (cdpCatchupOutputMessageCount !== undefined && cdpCatchupOutputMessageCount > 0)
          || (catchupOutputMessageCount !== undefined && catchupOutputMessageCount > 0)
        )
    })
  const retentionCoveredValues = events
    .map((entry) => entry.retentionCoveredMs)
    .map(nonnegativeMetric)
    .filter((value): value is number => value !== undefined)
  const gapCountValues = events
    .map((entry) => nonnegativeMetric(entry.gapCount))
    .filter((value): value is number => value !== undefined)

  return {
    ...(retentionCoveredValues.length > 0
      ? { terminalStoppedRetentionCoveredMs: Math.max(...retentionCoveredValues) }
      : {}),
    ...(gapCountValues.length > 0
      ? { terminalStopResumeGapCount: gapCountValues.reduce((sum, value) => sum + value, 0) }
      : {}),
  }
}

function resolveObservationBytes(observation: { encodedDataLength?: number | null; bytes?: number | null; payloadLength?: number | null }): number {
  if (typeof observation.encodedDataLength === 'number' && Number.isFinite(observation.encodedDataLength)) {
    return Math.max(0, observation.encodedDataLength)
  }
  if (typeof observation.bytes === 'number' && Number.isFinite(observation.bytes)) {
    return Math.max(0, observation.bytes)
  }
  if (typeof observation.payloadLength === 'number' && Number.isFinite(observation.payloadLength)) {
    return Math.max(0, observation.payloadLength)
  }
  return 0
}

export function deriveVisibleFirstMetrics(input: DerivedMetricsInput): VisibleFirstDerivedMetrics {
  const focusedReadyMs = input.browser.milestones[input.focusedReadyMilestone]
  const allowedApiRoutes = new Set(input.allowedApiRouteIdsBeforeReady)
  const allowedWsTypes = new Set(input.allowedWsTypesBeforeReady)
  const allowedFreshAgentEventTypes = new Set(input.allowedFreshAgentEventTypesBeforeReady ?? [])
  const replayFrames = replayWsFramesBeforeReady(input, focusedReadyMs)
  const stopResumeMetrics = resolveStopResumeMetrics(input)
  const terminalInputToFirstOutputMs = resolveTerminalInputToFirstOutputMs(input, focusedReadyMs)
  const maxRafGapMs = resolveMaxRafGapMs(input)
  const terminalParserAppliedLagMs = resolveParserAppliedLagMs(input, replayFrames)

  let httpRequestsBeforeReady = 0
  let httpBytesBeforeReady = 0
  let offscreenHttpRequestsBeforeReady = 0
  let offscreenHttpBytesBeforeReady = 0

  for (const request of input.transport.http?.requests ?? []) {
    const routeId = request.routeId ?? (request.url ? normalizeAuditRouteId(request.url) : null)
    if (!routeId || request.timestamp > focusedReadyMs) continue

    const bytes = resolveObservationBytes(request)
    httpRequestsBeforeReady += 1
    httpBytesBeforeReady += bytes

    if (!allowedApiRoutes.has(routeId)) {
      offscreenHttpRequestsBeforeReady += 1
      offscreenHttpBytesBeforeReady += bytes
    }
  }

  let wsFramesBeforeReady = 0
  let wsBytesBeforeReady = 0
  let offscreenWsFramesBeforeReady = 0
  let offscreenWsBytesBeforeReady = 0

  for (const frame of input.transport.ws?.frames ?? []) {
    if (frame.timestamp > focusedReadyMs) continue

    const frameType = frame.type ?? classifyWsFrameType(frame.payload ?? '')
    const bytes = resolveObservationBytes(frame)
    wsFramesBeforeReady += 1
    wsBytesBeforeReady += bytes

    const freshAgentEventType = frameType === 'freshAgent.event'
      ? classifyFreshAgentProviderEventType(frame.payload ?? '')
      : null
    const freshAgentEventAllowed = freshAgentEventType
      ? allowedFreshAgentEventTypes.has(freshAgentEventType)
      : true

    if (!allowedWsTypes.has(frameType) || !freshAgentEventAllowed) {
      offscreenWsFramesBeforeReady += 1
      offscreenWsBytesBeforeReady += bytes
    }
  }

  return {
    focusedReadyMs,
    ...(resolveWsReadyMs(input) !== undefined ? { wsReadyMs: resolveWsReadyMs(input) } : {}),
    ...(maxRafGapMs !== undefined ? { maxRafGapMs } : {}),
    ...(terminalInputToFirstOutputMs !== undefined
      ? { terminalInputToFirstOutputMs }
      : {}),
    httpRequestsBeforeReady,
    httpBytesBeforeReady,
    wsFramesBeforeReady,
    wsBytesBeforeReady,
    offscreenHttpRequestsBeforeReady,
    offscreenHttpBytesBeforeReady,
    offscreenWsFramesBeforeReady,
    offscreenWsBytesBeforeReady,
    terminalReplayMessageCount: resolveReplayMessageCount(input, replayFrames),
    terminalReplaySerializedBytes: resolveReplaySerializedBytes(input, replayFrames),
    ...(terminalParserAppliedLagMs !== undefined ? { terminalParserAppliedLagMs } : {}),
    terminalReplayGapCount: resolveReplayGapCount(input, focusedReadyMs),
    terminalFullHydrateFallbackCount: countPerfEvents(input, 'terminal.catchup.full_hydrate_fallback'),
    terminalSurfaceQuarantineCount: countPerfEvents(input, 'terminal.catchup.surface_quarantined'),
    terminalStaleGenerationRejectionCount: countPerfEvents(input, 'terminal.attach_generation_stale_rejected'),
    ...stopResumeMetrics,
  }
}
