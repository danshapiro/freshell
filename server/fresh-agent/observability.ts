import type { Request, Response, NextFunction } from 'express'
import { freshAgentObservabilityLogger } from '../logger.js'
import { hashForLogs } from './log-hash.js'

// Re-exported so existing `import { hashForLogs } from './observability.js'`
// call sites keep working; the implementation lives in the logger-free leaf
// module log-hash.ts (see its doc comment).
export { hashForLogs }

export type FreshAgentObservabilityEvent =
  | {
    kind: 'fresh_agent_opencode_status_observed'
    provider: 'opencode'
    sessionIdHash: string
    status: 'running' | 'idle'
    source: 'adapter' | 'sse'
    opencodeEventKind?: string
    cwdHash?: string
  }
  | {
    kind: 'fresh_agent_snapshot_served'
    sessionType: string
    provider: string
    threadIdHash: string
    httpStatus: number
    durationMs: number
    payloadBytes?: number
    turnCount: number
    lastTurnIdHash?: string
    revision?: number
    cwdHash?: string
    trigger?: string
  }
  | {
    kind: 'fresh_agent_snapshot_rate_limited'
    sessionType: string
    provider: string
    threadIdHash?: string
    httpStatus: 429
    route: string
    cwdHash?: string
    retryAfterSeconds?: number
    trigger?: string
  }
  | {
    kind: 'fresh_agent_send'
    sessionType: string
    provider: string
    sessionIdHash: string
    cwdHash?: string
    requestId?: string
    outcome: 'accepted' | 'failed'
    errorCode?: string
    durationMs?: number
  }
  | {
    kind: 'fresh_agent_interrupt'
    sessionType: string
    provider: string
    sessionIdHash: string
    cwdHash?: string
    outcome: 'ok' | 'failed'
    errorCode?: string
  }
  | {
    kind: 'fresh_agent_attach'
    sessionType: string
    provider: string
    sessionIdHash: string
    cwdHash?: string
    outcome: 'ok' | 'failed'
    errorCode?: string
    recovered?: boolean
  }
  | {
    kind: 'fresh_agent_materialized'
    sessionType: string
    provider: string
    previousSessionIdHash: string
    sessionIdHash: string
    cwdHash?: string
  }
  | {
    kind: 'fresh_agent_monitor'
    provider: 'opencode'
    sessionIdHash: string
    cwdHash?: string
    phase: 'armed' | 'resolved_idle' | 'timeout' | 'sidecar_lost' | 'duplicate_suppressed'
    sidecarGeneration?: number
  }
  | {
    kind: 'fresh_agent_sidecar'
    provider: 'opencode'
    phase: 'started' | 'exited' | 'discarded'
    generation: number
    pid?: number
    baseUrl?: string
    reason?: string
    code?: number | null
    signal?: string | null
  }
  | {
    kind: 'fresh_agent_snapshot_failed'
    sessionType: string
    provider: string
    threadIdHash?: string
    httpStatus: number
    code?: string
    durationMs?: number
    trigger?: string
    cwdHash?: string
  }
  | {
    kind: 'fresh_agent_turn_recovery'
    provider: 'opencode'
    sessionIdHash: string
    cwdHash?: string
    action:
      | 'continuation_injected'
      | 'suppressed_user_stop'
      | 'suppressed_user_followup'
      | 'suppressed_already_recovered'
      | 'suppressed_low_confidence'
      | 'suppressed_no_route'
    reason: string
    messageIdHash?: string
  }
  | {
    kind: 'fresh_agent_stuck_deadman'
    provider: 'codex'
    sessionIdHash: string
    threadIdHash?: string
    phase: 'armed' | 'fired' | 'resolved'
    resolution?: 'activity' | 'turn_complete' | 'exit' | 'thread_closed' | 'kill' | 'shutdown'
    quietWindowMs: number
  }

type FreshAgentObservabilitySink = Pick<typeof freshAgentObservabilityLogger, 'info' | 'warn'>

const defaultSink: FreshAgentObservabilitySink = freshAgentObservabilityLogger
let sink: FreshAgentObservabilitySink = defaultSink

export function __setFreshAgentObservabilitySinkForTest(next: FreshAgentObservabilitySink): void {
  sink = next
}

function buildPayload(event: FreshAgentObservabilityEvent): Record<string, unknown> {
  const { kind, ...fields } = event
  const payload: Record<string, unknown> = { event: kind, component: 'fresh-agent-observability' }
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) payload[key] = value
  }
  return payload
}

const WARN_KINDS = new Set<FreshAgentObservabilityEvent['kind']>([
  'fresh_agent_snapshot_rate_limited',
  'fresh_agent_snapshot_failed',
])

function isWarnEvent(event: FreshAgentObservabilityEvent): boolean {
  if (WARN_KINDS.has(event.kind)) return true
  if (event.kind === 'fresh_agent_sidecar') return event.phase !== 'started'
  if (event.kind === 'fresh_agent_monitor') return event.phase === 'timeout' || event.phase === 'sidecar_lost'
  if (event.kind === 'fresh_agent_stuck_deadman') return event.phase === 'fired'
  return false
}

export function recordFreshAgentObservabilityEvent(event: FreshAgentObservabilityEvent): void {
  const payload = buildPayload(event)
  if (isWarnEvent(event)) {
    sink.warn(payload, event.kind)
  } else {
    sink.info(payload, event.kind)
  }
}

// Matches all three thread routes relative to the mount point:
//   /:sessionType/:provider/:threadId
//   /:sessionType/:provider/:threadId/turns
//   /:sessionType/:provider/:threadId/turns/:turnId
const SNAPSHOT_PATH_PATTERN = /^\/([^/]+)\/([^/]+)\/([^/]+)(?:\/turns(?:\/[^/]+)?)?$/

const MAX_TRIGGER_LENGTH = 32

export function createFreshAgentSnapshotRateLimitMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const match = SNAPSHOT_PATH_PATTERN.exec(req.path)
    if (match) {
      const [, sessionType, provider, threadId] = match
      const trigger =
        typeof req.query.trigger === 'string' ? req.query.trigger.slice(0, MAX_TRIGGER_LENGTH) : undefined
      res.on('finish', () => {
        if (res.statusCode === 429) {
          const retryAfterSeconds = Number(res.getHeader('Retry-After')) || undefined
          recordFreshAgentObservabilityEvent({
            kind: 'fresh_agent_snapshot_rate_limited',
            sessionType,
            provider,
            threadIdHash: hashForLogs(threadId),
            httpStatus: 429,
            route: `/fresh-agent/threads/${sessionType}/${provider}/:threadId`,
            ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
            ...(trigger ? { trigger } : {}),
          })
        }
      })
    }
    next()
  }
}
