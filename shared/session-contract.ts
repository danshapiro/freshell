import { z } from 'zod'

export const SessionRefSchema = z.object({
  provider: z.string().min(1),
  sessionId: z.string().min(1),
}).strict()

export type SessionRef = z.infer<typeof SessionRefSchema>

export const LiveTerminalHandleSchema = z.object({
  terminalId: z.string().min(1),
  serverInstanceId: z.string().min(1),
}).strict()

export type LiveTerminalHandle = z.infer<typeof LiveTerminalHandleSchema>

export const RestoreErrorReasonSchema = z.enum([
  'missing_canonical_identity',
  'invalid_legacy_restore_target',
  'dead_live_handle',
  'provider_runtime_failed',
  'durable_artifact_missing',
])

export type RestoreErrorReason = z.infer<typeof RestoreErrorReasonSchema>

export const RestoreErrorSchema = z.object({
  code: z.literal('RESTORE_UNAVAILABLE'),
  reason: RestoreErrorReasonSchema,
}).strict()

export type RestoreError = z.infer<typeof RestoreErrorSchema>

const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function isCanonicalClaudeSessionId(value: unknown): value is string {
  return typeof value === 'string' && CLAUDE_SESSION_ID_RE.test(value)
}

export function buildRestoreError(reason: RestoreErrorReason): RestoreError {
  return {
    code: 'RESTORE_UNAVAILABLE',
    reason,
  }
}

export function sanitizeSessionRef(value: unknown): SessionRef | undefined {
  if (!isRecord(value)) return undefined
  if (!isNonEmptyString(value.provider) || !isNonEmptyString(value.sessionId)) return undefined
  return {
    provider: value.provider,
    sessionId: value.sessionId,
  }
}

export function dedupeSessionRefs(values: ReadonlyArray<unknown>): SessionRef[] {
  const seen = new Set<string>()
  const deduped: SessionRef[] = []

  for (const value of values) {
    const sessionRef = sanitizeSessionRef(value)
    if (!sessionRef) continue
    const key = `${sessionRef.provider}:${sessionRef.sessionId}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(sessionRef)
  }

  return deduped
}

export function migrateLegacyTerminalDurableState({
  provider,
  sessionRef,
  resumeSessionId,
}: {
  provider?: string
  sessionRef?: unknown
  resumeSessionId?: string
}): {
  sessionRef?: SessionRef
  restoreError?: RestoreError
} {
  const explicitSessionRef = sanitizeSessionRef(sessionRef)
  if (explicitSessionRef) {
    return { sessionRef: explicitSessionRef }
  }

  if (!provider || !resumeSessionId) {
    return {}
  }

  if (provider === 'claude') {
    if (isCanonicalClaudeSessionId(resumeSessionId)) {
      return {
        sessionRef: {
          provider,
          sessionId: resumeSessionId,
        },
      }
    }
    return { restoreError: buildRestoreError('invalid_legacy_restore_target') }
  }

  if (provider === 'codex' || provider === 'opencode') {
    return { restoreError: buildRestoreError('invalid_legacy_restore_target') }
  }

  return {
    sessionRef: {
      provider,
      sessionId: resumeSessionId,
    },
  }
}

export function migrateLegacyAgentChatDurableState({
  sessionRef,
  cliSessionId,
  timelineSessionId,
  resumeSessionId,
}: {
  sessionRef?: unknown
  cliSessionId?: string
  timelineSessionId?: string
  resumeSessionId?: string
}): {
  sessionRef?: SessionRef
  restoreError?: RestoreError
} {
  const explicitSessionRef = sanitizeSessionRef(sessionRef)
  if (explicitSessionRef) {
    return { sessionRef: explicitSessionRef }
  }

  const canonicalClaudeSessionId = isCanonicalClaudeSessionId(cliSessionId)
    ? cliSessionId
    : (isCanonicalClaudeSessionId(timelineSessionId) ? timelineSessionId : undefined)

  if (canonicalClaudeSessionId) {
    return {
      sessionRef: {
        provider: 'claude',
        sessionId: canonicalClaudeSessionId,
      },
    }
  }

  if (resumeSessionId) {
    return { restoreError: buildRestoreError('invalid_legacy_restore_target') }
  }

  return {}
}
