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
  browser: {
    milestones: Record<string, number>
    perfEvents?: Array<Record<string, unknown>>
    terminalLatencySamplesMs?: number[]
  }
  transport: {
    http?: { requests: VisibleFirstHttpObservation[] }
    ws?: { frames: VisibleFirstWsObservation[] }
  }
}

export type VisibleFirstDerivedMetrics = {
  focusedReadyMs: number
  wsReadyMs?: number
  terminalInputToFirstOutputMs?: number
  httpRequestsBeforeReady: number
  httpBytesBeforeReady: number
  wsFramesBeforeReady: number
  wsBytesBeforeReady: number
  offscreenHttpRequestsBeforeReady: number
  offscreenHttpBytesBeforeReady: number
  offscreenWsFramesBeforeReady: number
  offscreenWsBytesBeforeReady: number
}

const IGNORED_ROUTE_IDS = new Set(['/api/health', '/api/logs/client'])

function normalizeAuditPath(pathname: string): string | null {
  if (!pathname.startsWith('/api/')) return null
  if (IGNORED_ROUTE_IDS.has(pathname)) return null

  const sessionRouteMatch = pathname.match(/^\/api\/sessions\/[^/]+$/)
  if (sessionRouteMatch) {
    return '/api/sessions/:sessionId'
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

function resolveWsReadyMs(input: DerivedMetricsInput): number | undefined {
  const event = input.browser.perfEvents?.find((entry) => entry.event === 'perf.ws_ready')
  const durationMs = event?.durationMs
  return typeof durationMs === 'number' && Number.isFinite(durationMs) ? durationMs : undefined
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

    if (!allowedWsTypes.has(frameType)) {
      offscreenWsFramesBeforeReady += 1
      offscreenWsBytesBeforeReady += bytes
    }
  }

  return {
    focusedReadyMs,
    ...(resolveWsReadyMs(input) !== undefined ? { wsReadyMs: resolveWsReadyMs(input) } : {}),
    ...(typeof input.browser.terminalLatencySamplesMs?.[0] === 'number'
      ? { terminalInputToFirstOutputMs: input.browser.terminalLatencySamplesMs[0] }
      : {}),
    httpRequestsBeforeReady,
    httpBytesBeforeReady,
    wsFramesBeforeReady,
    wsBytesBeforeReady,
    offscreenHttpRequestsBeforeReady,
    offscreenHttpBytesBeforeReady,
    offscreenWsFramesBeforeReady,
    offscreenWsBytesBeforeReady,
  }
}
