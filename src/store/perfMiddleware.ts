import type { Middleware } from '@reduxjs/toolkit'
import { getClientPerfConfig, isClientPerfLoggingEnabled, logClientPerf } from '@/lib/perf-logger'

type PayloadSummary = Record<string, unknown>

const perfConfig = getClientPerfConfig()

function summarizePayload(payload: unknown): PayloadSummary | undefined {
  if (Array.isArray(payload)) {
    const summary: PayloadSummary = { arrayLength: payload.length }
    let sessionCount = 0
    let maxSessions = 0
    let projectsWithSessions = 0

    for (const item of payload) {
      if (!item || typeof item !== 'object') continue
      const sessions = (item as { sessions?: unknown }).sessions
      if (Array.isArray(sessions)) {
        projectsWithSessions += 1
        sessionCount += sessions.length
        if (sessions.length > maxSessions) maxSessions = sessions.length
      }
    }

    if (projectsWithSessions > 0) {
      summary.projectCount = payload.length
      summary.sessionCount = sessionCount
      summary.maxSessionsPerProject = maxSessions
    }

    return summary
  }

  if (payload && typeof payload === 'object') {
    const keys = Object.keys(payload as Record<string, unknown>)
    return {
      payloadKeyCount: keys.length,
      payloadKeys: keys.slice(0, 8),
    }
  }

  if (typeof payload === 'string') {
    return { payloadLength: payload.length }
  }

  return undefined
}

export const perfMiddleware: Middleware = () => (next) => (action) => {
  if (!isClientPerfLoggingEnabled() || typeof performance === 'undefined') {
    return next(action)
  }

  const start = performance.now()
  const result = next(action)
  const durationMs = performance.now() - start

  if (durationMs >= perfConfig.reduxActionSlowMs) {
    const actionType = typeof (action as { type?: unknown })?.type === 'string'
      ? (action as { type: string }).type
      : 'unknown'
    const summary = summarizePayload((action as { payload?: unknown })?.payload)
    const context: Record<string, unknown> = {
      actionType,
      durationMs: Number(durationMs.toFixed(2)),
    }
    if (summary) Object.assign(context, summary)

    logClientPerf('perf.redux_action_slow', context, 'warn')
  }

  return result
}
