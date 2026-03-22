import { isValidClaudeSessionId } from '@/lib/claude-session-id'
import type { SessionLocator } from '@/store/paneTypes'
import type { CodingCliProviderName } from '@/store/types'

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

const EXACT_NON_CLAUDE_PROVIDERS = new Set<CodingCliProviderName>(['codex'])

export function isExactSessionIdentifier(
  provider: CodingCliProviderName,
  sessionId: string,
): boolean {
  if (!isNonEmptyString(sessionId)) return false
  if (provider === 'claude') return isValidClaudeSessionId(sessionId)
  return EXACT_NON_CLAUDE_PROVIDERS.has(provider)
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
  expectedProvider?: string,
): SessionLocator | undefined {
  if (!locator) return undefined
  if (!isNonEmptyString(locator.provider) || !isNonEmptyString(locator.sessionId)) {
    return undefined
  }
  if (isNonEmptyString(expectedProvider) && locator.provider !== expectedProvider) {
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
