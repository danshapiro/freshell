import { createAction } from '@reduxjs/toolkit'
import type { ChatSessionState } from './agentChatTypes'
import type { AgentChatPaneContent } from './paneTypes'
import type { CodingCliProviderName, SessionListMetadata, Tab } from './types'
import { isValidClaudeSessionId } from '@/lib/claude-session-id'
import { sessionMetadataKey } from '@/lib/session-metadata'

export const flushPersistedLayoutNow = createAction('persist/flushNow')

type SessionIdentityState = Pick<ChatSessionState, 'timelineSessionId' | 'cliSessionId'> | undefined

export function getPreferredResumeSessionId(session: SessionIdentityState): string | undefined {
  return getCanonicalDurableSessionId(session)
    ?? session?.timelineSessionId
    ?? session?.cliSessionId
}

export function getCanonicalDurableSessionId(session: SessionIdentityState): string | undefined {
  if (isValidClaudeSessionId(session?.cliSessionId)) {
    return session.cliSessionId
  }
  if (isValidClaudeSessionId(session?.timelineSessionId)) {
    return session.timelineSessionId
  }
  return undefined
}

export function preferCanonicalResumeSessionId(
  localResumeSessionId?: string,
  remoteResumeSessionId?: string,
  fallbackResumeSessionId?: string,
): string | undefined {
  const localCanonical = isValidClaudeSessionId(localResumeSessionId)
  const remoteCanonical = isValidClaudeSessionId(remoteResumeSessionId)
  if (localCanonical && !remoteCanonical) return localResumeSessionId
  if (remoteCanonical && !localCanonical) return remoteResumeSessionId
  return fallbackResumeSessionId
}

export function shouldPreserveLocalCanonicalResumeSessionId(
  localResumeSessionId?: string,
  remoteResumeSessionId?: string,
): localResumeSessionId is string {
  return Boolean(
    localResumeSessionId
      && isValidClaudeSessionId(localResumeSessionId)
      && localResumeSessionId !== remoteResumeSessionId
      && !isValidClaudeSessionId(remoteResumeSessionId),
  )
}

type SessionMetadataShape = Record<string, SessionListMetadata> | undefined

export function mergeSessionMetadataForPreferredResumeId({
  localSessionMetadataByKey,
  remoteSessionMetadataByKey,
  existingSessionMetadataByKey,
  provider,
  localResumeSessionId,
  remoteResumeSessionId,
  preferredResumeSessionId,
  sessionType,
}: {
  localSessionMetadataByKey?: SessionMetadataShape
  remoteSessionMetadataByKey?: SessionMetadataShape
  existingSessionMetadataByKey?: SessionMetadataShape
  provider?: CodingCliProviderName
  localResumeSessionId?: string
  remoteResumeSessionId?: string
  preferredResumeSessionId?: string
  sessionType?: string
}): SessionMetadataShape {
  if (!provider || !preferredResumeSessionId) {
    return existingSessionMetadataByKey
  }

  const existing = existingSessionMetadataByKey ?? {}
  const preferredKey = sessionMetadataKey(provider, preferredResumeSessionId)
  const candidateIds = Array.from(new Set([
    localResumeSessionId,
    remoteResumeSessionId,
    preferredResumeSessionId,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)))

  const nextSessionMetadataByKey: Record<string, SessionListMetadata> = { ...existing }
  let mergedPreferredMetadata: SessionListMetadata | undefined = existing[preferredKey]

  for (const sessionId of candidateIds) {
    const key = sessionMetadataKey(provider, sessionId)
    const candidateMetadata =
      existing[key]
      ?? localSessionMetadataByKey?.[key]
      ?? remoteSessionMetadataByKey?.[key]
    if (candidateMetadata) {
      mergedPreferredMetadata = {
        ...(mergedPreferredMetadata ?? {}),
        ...candidateMetadata,
      }
    }
    if (key !== preferredKey) {
      delete nextSessionMetadataByKey[key]
    }
  }

  if (sessionType) {
    mergedPreferredMetadata = {
      ...(mergedPreferredMetadata ?? {}),
      sessionType,
    }
  }

  if (mergedPreferredMetadata && Object.keys(mergedPreferredMetadata).length > 0) {
    nextSessionMetadataByKey[preferredKey] = mergedPreferredMetadata
  }

  return nextSessionMetadataByKey
}

export function buildAgentChatPersistedIdentityUpdate({
  session,
  paneContent,
  currentTab,
  metadataProvider,
}: {
  session: SessionIdentityState
  paneContent: AgentChatPaneContent
  currentTab?: Tab
  metadataProvider?: CodingCliProviderName
}): {
  paneUpdates?: Partial<AgentChatPaneContent>
  tabUpdates?: Partial<Tab>
  shouldFlush: boolean
} | null {
  const preferredResumeSessionId = getPreferredResumeSessionId(session)
  if (!preferredResumeSessionId) return null

  const paneUpdates =
    paneContent.resumeSessionId !== preferredResumeSessionId
      ? { resumeSessionId: preferredResumeSessionId }
      : undefined

  let tabUpdates: Partial<Tab> | undefined
  if (currentTab) {
    const nextTabUpdates: Partial<Tab> = {}
    if (currentTab.resumeSessionId !== preferredResumeSessionId) {
      nextTabUpdates.resumeSessionId = preferredResumeSessionId
    }
    if (metadataProvider && currentTab.codingCliProvider !== metadataProvider) {
      nextTabUpdates.codingCliProvider = metadataProvider
    }

    const nextSessionMetadataByKey = mergeSessionMetadataForPreferredResumeId({
      localSessionMetadataByKey: currentTab.sessionMetadataByKey,
      remoteSessionMetadataByKey: currentTab.sessionMetadataByKey,
      existingSessionMetadataByKey: currentTab.sessionMetadataByKey,
      provider: metadataProvider,
      localResumeSessionId: currentTab.resumeSessionId,
      remoteResumeSessionId: paneContent.resumeSessionId,
      preferredResumeSessionId,
      sessionType: paneContent.provider,
    })

    if (JSON.stringify(nextSessionMetadataByKey ?? {}) !== JSON.stringify(currentTab.sessionMetadataByKey ?? {})) {
      nextTabUpdates.sessionMetadataByKey = nextSessionMetadataByKey
    }

    if (Object.keys(nextTabUpdates).length > 0) {
      tabUpdates = nextTabUpdates
    }
  }

  const canonicalDurableSessionId = getCanonicalDurableSessionId(session)
  const shouldFlush = Boolean(
    canonicalDurableSessionId
      && (
        paneContent.resumeSessionId !== canonicalDurableSessionId
        || currentTab?.resumeSessionId !== canonicalDurableSessionId
      ),
  )

  if (!paneUpdates && !tabUpdates && !shouldFlush) {
    return null
  }

  return {
    paneUpdates,
    tabUpdates,
    shouldFlush,
  }
}
