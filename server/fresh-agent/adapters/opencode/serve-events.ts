export type OpencodeModelObject = { providerID: string; modelID: string }

/** Split a `provider/model` string on the FIRST slash. The serve message API
 * wants a `{ providerID, modelID }` object. Returns undefined for blank or
 * slashless values so callers can omit `model` and fall back to the session
 * default. */
export function splitOpencodeModel(value: string | undefined): OpencodeModelObject | undefined {
  if (!value || value.trim().length === 0) return undefined
  const slash = value.indexOf('/')
  if (slash <= 0 || slash >= value.length - 1) return undefined
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) }
}

export type ParsedServeEvent = {
  kind: string
  sessionId: string | undefined
  /** The denormalized properties payload from the source event. */
  properties: Record<string, unknown>
  raw: Record<string, unknown>
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === 'string' ? candidate : undefined
}

function eventPayload(raw: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof raw.type === 'string') return raw
  const payload = raw.payload
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>
  }
  return null
}

function isServerControlEvent(kind: string): boolean {
  return kind === 'server.connected' || kind === 'server.heartbeat'
}

/** Normalize one decoded OpenCode SSE payload. `/event` frames are flat
 * `{ type, properties }`; `/global/event` wraps that shape under `payload`.
 * Session ids appear as `properties.sessionID` (also
 * `properties.part.sessionID` / `properties.info.sessionID`). */
export function parseServeEvent(event: unknown): ParsedServeEvent | null {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null
  const payload = eventPayload(event as Record<string, unknown>)
  if (!payload || typeof payload.type !== 'string') return null
  if (isServerControlEvent(payload.type)) return null
  const props = payload.properties && typeof payload.properties === 'object' && !Array.isArray(payload.properties)
    ? (payload.properties as Record<string, unknown>)
    : {}
  const sessionId =
    stringProperty(props, 'sessionID')
    || stringProperty(props.part, 'sessionID')
    || stringProperty(props.info, 'sessionID')
    || undefined
  return { kind: payload.type, sessionId, properties: { ...props }, raw: payload }
}

export type SdkProviderEvent =
  | { type: 'sdk.session.snapshot'; sessionId: string; status: 'running' | 'idle' }
  | { type: 'sdk.session.changed'; sessionId: string; reason: 'opencode-message' | 'opencode-status' }
  | { type: 'sdk.error'; sessionId: string; message: string }

function opencodeStatusToSnapshotStatus(statusType: string | undefined): 'running' | 'idle' | undefined {
  switch (statusType) {
    case 'busy':
    case 'retry':
      return 'running'
    case 'idle':
      return 'idle'
    default:
      return undefined
  }
}

function isOpencodeTranscriptEvent(kind: string): boolean {
  return kind.startsWith('message.')
}

/** Map a parsed serve event to the `sdk.*` provider event the existing client
 * slice already understands. Transcript events are invalidations, not lifecycle
 * state: OpenCode can emit trailing message metadata after a turn is already
 * idle, and mapping those updates to `running` leaves freshopencode bouncing. */
export function serveEventToSdk(parsed: ParsedServeEvent, subscribedId: string): SdkProviderEvent | null {
  const props = parsed.properties
  switch (parsed.kind) {
    case 'session.idle':
      return { type: 'sdk.session.snapshot', sessionId: subscribedId, status: 'idle' }
    case 'session.status': {
      const status = opencodeStatusToSnapshotStatus(stringProperty(props.status, 'type'))
      if (status) return { type: 'sdk.session.snapshot', sessionId: subscribedId, status }
      return { type: 'sdk.session.changed', sessionId: subscribedId, reason: 'opencode-status' }
    }
    case 'session.error': {
      const message = stringProperty(props.error, 'message') ?? 'OpenCode session error'
      return { type: 'sdk.error', sessionId: subscribedId, message }
    }
    default:
      if (isOpencodeTranscriptEvent(parsed.kind)) {
        return { type: 'sdk.session.changed', sessionId: subscribedId, reason: 'opencode-message' }
      }
      return null
  }
}
