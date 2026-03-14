import type { CodingCliProviderName, SessionListMetadata, Tab } from '@/store/types'

type SessionMetadataInput = {
  sessionType?: string
  firstUserMessage?: string
  isSubagent?: boolean
  isNonInteractive?: boolean
}

export function sessionMetadataKey(provider: CodingCliProviderName, sessionId: string): string {
  return `${provider}:${sessionId}`
}

export function buildSessionListMetadata(input: SessionMetadataInput): SessionListMetadata | undefined {
  const metadata: SessionListMetadata = {}

  if (typeof input.sessionType === 'string' && input.sessionType.length > 0) {
    metadata.sessionType = input.sessionType
  }
  if (typeof input.firstUserMessage === 'string') {
    metadata.firstUserMessage = input.firstUserMessage
  }
  if (typeof input.isSubagent === 'boolean') {
    metadata.isSubagent = input.isSubagent
  }
  if (typeof input.isNonInteractive === 'boolean') {
    metadata.isNonInteractive = input.isNonInteractive
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined
}

export function mergeSessionMetadataByKey(
  existing: Record<string, SessionListMetadata> | undefined,
  provider: CodingCliProviderName,
  sessionId: string,
  input: SessionMetadataInput,
): Record<string, SessionListMetadata> | undefined {
  const nextMetadata = buildSessionListMetadata(input)
  if (!nextMetadata) return existing

  const key = sessionMetadataKey(provider, sessionId)
  const previous = existing?.[key]
  return {
    ...(existing ?? {}),
    [key]: {
      ...(previous ?? {}),
      ...nextMetadata,
    },
  }
}

export function getSessionMetadata(
  source: { sessionMetadataByKey?: Record<string, SessionListMetadata> } | undefined,
  provider: CodingCliProviderName,
  sessionId: string,
): SessionListMetadata | undefined {
  return source?.sessionMetadataByKey?.[sessionMetadataKey(provider, sessionId)]
}

export function getTabResumeSessionType(tab: Pick<Tab, 'mode' | 'codingCliProvider' | 'resumeSessionId' | 'sessionMetadataByKey'>): string | undefined {
  const provider = tab.codingCliProvider || (tab.mode !== 'shell' ? tab.mode : undefined)
  const sessionId = tab.resumeSessionId
  if (!provider || !sessionId) return undefined
  return getSessionMetadata(tab, provider, sessionId)?.sessionType ?? provider
}
