import { createHash } from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'
import { logger } from '../logger.js'

const HASH_LENGTH = 12

export function hashForLogs(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, HASH_LENGTH)
}

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
  }
  | {
    kind: 'fresh_agent_snapshot_rate_limited'
    sessionType: string
    provider: string
    threadIdHash?: string
    httpStatus: 429
    route: string
    cwdHash?: string
  }

type FreshAgentObservabilitySink = Pick<typeof logger, 'info' | 'warn'>

const defaultSink: FreshAgentObservabilitySink = logger
let sink: FreshAgentObservabilitySink = defaultSink

export function __setFreshAgentObservabilitySinkForTest(next: FreshAgentObservabilitySink): void {
  sink = next
}

function buildPayload(event: FreshAgentObservabilityEvent): Record<string, unknown> {
  const base = { event: event.kind, component: 'fresh-agent-observability' }
  switch (event.kind) {
    case 'fresh_agent_opencode_status_observed':
      return {
        ...base,
        provider: event.provider,
        sessionIdHash: event.sessionIdHash,
        status: event.status,
        source: event.source,
        ...(event.opencodeEventKind ? { opencodeEventKind: event.opencodeEventKind } : {}),
        ...(event.cwdHash ? { cwdHash: event.cwdHash } : {}),
      }
    case 'fresh_agent_snapshot_served':
      return {
        ...base,
        sessionType: event.sessionType,
        provider: event.provider,
        threadIdHash: event.threadIdHash,
        httpStatus: event.httpStatus,
        durationMs: event.durationMs,
        ...(event.payloadBytes !== undefined ? { payloadBytes: event.payloadBytes } : {}),
        turnCount: event.turnCount,
        ...(event.lastTurnIdHash ? { lastTurnIdHash: event.lastTurnIdHash } : {}),
        ...(event.revision !== undefined ? { revision: event.revision } : {}),
        ...(event.cwdHash ? { cwdHash: event.cwdHash } : {}),
      }
    case 'fresh_agent_snapshot_rate_limited':
      return {
        ...base,
        sessionType: event.sessionType,
        provider: event.provider,
        ...(event.threadIdHash ? { threadIdHash: event.threadIdHash } : {}),
        httpStatus: event.httpStatus,
        route: event.route,
        ...(event.cwdHash ? { cwdHash: event.cwdHash } : {}),
      }
  }
}

export function recordFreshAgentObservabilityEvent(event: FreshAgentObservabilityEvent): void {
  const payload = buildPayload(event)
  if (event.kind === 'fresh_agent_snapshot_rate_limited') {
    sink.warn(payload, event.kind)
  } else {
    sink.info(payload, event.kind)
  }
}

const SNAPSHOT_PATH_PATTERN = /^\/([^/]+)\/([^/]+)\/([^/]+)$/

export function createFreshAgentSnapshotRateLimitMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const match = SNAPSHOT_PATH_PATTERN.exec(req.path)
    if (match) {
      const [, sessionType, provider, threadId] = match
      res.on('finish', () => {
        if (res.statusCode === 429) {
          recordFreshAgentObservabilityEvent({
            kind: 'fresh_agent_snapshot_rate_limited',
            sessionType,
            provider,
            threadIdHash: hashForLogs(threadId),
            httpStatus: 429,
            route: `/fresh-agent/threads/${sessionType}/${provider}/:threadId`,
          })
        }
      })
    }
    next()
  }
}
