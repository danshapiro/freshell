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

/** Normalize one decoded `GET /event` SSE payload. opencode 1.17.x nests the
 * payload under `properties` and carries the session id as `properties.sessionID`
 * (also `properties.part.sessionID` / `properties.info.sessionID`). */
export function parseServeEvent(event: unknown): ParsedServeEvent | null {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null
  const raw = event as Record<string, unknown>
  if (typeof raw.type !== 'string') return null
  const props = raw.properties && typeof raw.properties === 'object' && !Array.isArray(raw.properties)
    ? (raw.properties as Record<string, unknown>)
    : {}
  const sessionId =
    stringProperty(props, 'sessionID')
    || stringProperty(props.part, 'sessionID')
    || stringProperty(props.info, 'sessionID')
    || undefined
  return { kind: raw.type, sessionId, properties: { ...props }, raw }
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
