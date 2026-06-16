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
  raw: Record<string, any>
}

/** Normalize one decoded `GET /event` SSE payload. opencode 1.17.x nests the
 * payload under `properties` and carries the session id as `properties.sessionID`
 * (also `properties.part.sessionID` / `properties.info.sessionID`). */
export function parseServeEvent(event: unknown): ParsedServeEvent | null {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null
  const raw = event as Record<string, any>
  if (typeof raw.type !== 'string') return null
  const props = raw.properties && typeof raw.properties === 'object'
    ? (raw.properties as Record<string, unknown>)
    : {}
  const sessionId =
    (typeof props.sessionID === 'string' && props.sessionID)
    || (typeof (props.part as Record<string, unknown> | undefined)?.sessionID === 'string'
      && ((props.part as Record<string, unknown>).sessionID as string))
    || (typeof (props.info as Record<string, unknown> | undefined)?.sessionID === 'string'
      && ((props.info as Record<string, unknown>).sessionID as string))
    || undefined
  return { kind: raw.type, sessionId, properties: { ...props }, raw }
}

export type SdkProviderEvent =
  | { type: 'sdk.session.snapshot'; sessionId: string; status: 'running' | 'idle' }
  | { type: 'sdk.error'; sessionId: string; message: string }

/** Map a parsed serve event to the `sdk.*` provider event the existing client
 * slice already understands. We deliberately collapse fine-grained part events
 * into a `running` snapshot: the client re-polls the HTTP transcript on every
 * `freshAgent.event`, so this yields live (per-assistant-message) updates with
 * zero client change. `subscribedId` is the id the listener subscribed with
 * (placeholder before materialization, durable `ses_` after). */
export function serveEventToSdk(parsed: ParsedServeEvent, subscribedId: string): SdkProviderEvent | null {
  const props = parsed.properties
  switch (parsed.kind) {
    case 'session.idle':
      return { type: 'sdk.session.snapshot', sessionId: subscribedId, status: 'idle' }
    case 'session.status': {
      const status = props.status as { type?: string } | undefined
      const statusType = status?.type
      return { type: 'sdk.session.snapshot', sessionId: subscribedId, status: statusType === 'idle' ? 'idle' : 'running' }
    }
    case 'message.part.delta':
    case 'message.part.updated':
    case 'message.updated':
      return { type: 'sdk.session.snapshot', sessionId: subscribedId, status: 'running' }
    case 'session.error': {
      const error = props.error as { message?: string } | undefined
      const message = typeof error?.message === 'string'
        ? error.message
        : 'OpenCode session error'
      return { type: 'sdk.error', sessionId: subscribedId, message }
    }
    default:
      return null
  }
}
