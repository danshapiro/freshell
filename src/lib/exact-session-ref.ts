import { isValidClaudeSessionId } from '@/lib/claude-session-id'
import type { SessionLocator } from '@/store/paneTypes'
import type { CodingCliProviderName } from '@/store/types'

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function isExactSessionIdentifier(
  provider: CodingCliProviderName,
  sessionId: string,
): boolean {
  if (!isNonEmptyString(sessionId)) return false
  if (provider === 'claude') return isValidClaudeSessionId(sessionId)
  if (provider === 'opencode') return false
  return true
}

export function buildExactSessionRef(input: {
  provider: CodingCliProviderName
  sessionId: string
  serverInstanceId?: string
}): SessionLocator | undefined {
  if (!isNonEmptyString(input.serverInstanceId)) return undefined
  if (!isExactSessionIdentifier(input.provider, input.sessionId)) return undefined
  return {
    provider: input.provider,
    sessionId: input.sessionId,
    serverInstanceId: input.serverInstanceId,
  }
}

export function sanitizeExactSessionRef(
  locator?: {
    provider?: unknown
    sessionId?: unknown
    serverInstanceId?: unknown
  } | null,
): SessionLocator | undefined {
  if (!locator) return undefined
  if (!isNonEmptyString(locator.provider) || !isNonEmptyString(locator.sessionId)) {
    return undefined
  }
  return buildExactSessionRef({
    provider: locator.provider as CodingCliProviderName,
    sessionId: locator.sessionId,
    serverInstanceId: isNonEmptyString(locator.serverInstanceId)
      ? locator.serverInstanceId
      : undefined,
  })
}
