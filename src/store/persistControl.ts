import { createAction } from '@reduxjs/toolkit'
import type { ChatSessionState } from './agentChatTypes'
import type { AgentChatPaneContent } from './paneTypes'
import type { CodingCliProviderName, SessionListMetadata, Tab } from './types'
import { isValidClaudeSessionId } from '@/lib/claude-session-id'
import { sessionMetadataKey } from '@/lib/session-metadata'
import { sanitizeSessionRef, type SessionRef } from '@shared/session-contract'

export const flushPersistedLayoutNow = createAction('persist/flushNow')

function sessionRefEquals(a?: SessionRef, b?: SessionRef): boolean {
  return a?.provider === b?.provider && a?.sessionId === b?.sessionId
}

export function buildTerminalDurableSessionRefUpdate({
  provider,
  sessionId,
  paneSessionRef,
  tabSessionRef,
  paneResumeSessionId,
  tabResumeSessionId,
}: {
  provider?: CodingCliProviderName
  sessionId?: string
  paneSessionRef?: SessionRef
  tabSessionRef?: SessionRef
  paneResumeSessionId?: string
  tabResumeSessionId?: string
}): {
  paneUpdates?: { sessionRef?: SessionRef; resumeSessionId?: undefined }
  tabUpdates?: Partial<Tab>
  shouldFlush: boolean
} | null {
  const sessionRef = provider && sessionId
    ? sanitizeSessionRef({ provider, sessionId })
    : undefined
  if (!sessionRef) return null

  const paneNeedsSessionRef = !sessionRefEquals(paneSessionRef, sessionRef)
  const tabNeedsSessionRef = !sessionRefEquals(tabSessionRef, sessionRef)
  const paneNeedsResumeClear = typeof paneResumeSessionId === 'string'
  const tabNeedsResumeClear = typeof tabResumeSessionId === 'string'

  const paneUpdates = paneNeedsSessionRef || paneNeedsResumeClear
    ? {
        ...(paneNeedsSessionRef ? { sessionRef } : {}),
        ...(paneNeedsResumeClear ? { resumeSessionId: undefined } : {}),
      }
    : undefined

  const tabUpdates = tabNeedsSessionRef || tabNeedsResumeClear
    ? {
        ...(tabNeedsSessionRef ? { sessionRef } : {}),
        ...(tabNeedsResumeClear ? { resumeSessionId: undefined } : {}),
      }
    : undefined

  const shouldFlush = paneNeedsSessionRef || tabNeedsSessionRef || paneNeedsResumeClear || tabNeedsResumeClear

  if (!paneUpdates && !tabUpdates && !shouldFlush) {
    return null
  }

  return {
    paneUpdates,
    tabUpdates,
    shouldFlush,
  }
}

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
  let matchedCandidateMetadata = mergedPreferredMetadata != null

  for (const sessionId of candidateIds) {
    const key = sessionMetadataKey(provider, sessionId)
    const candidateMetadata =
      existing[key]
      ?? localSessionMetadataByKey?.[key]
      ?? remoteSessionMetadataByKey?.[key]
    if (candidateMetadata) {
      matchedCandidateMetadata = true
      mergedPreferredMetadata = {
        ...(mergedPreferredMetadata ?? {}),
        ...candidateMetadata,
      }
    }
    if (key !== preferredKey) {
      delete nextSessionMetadataByKey[key]
    }
  }

  if (!matchedCandidateMetadata) {
    const providerEntries = new Map<string, SessionListMetadata>()
    for (const source of [existing, localSessionMetadataByKey ?? {}, remoteSessionMetadataByKey ?? {}]) {
      for (const [key, value] of Object.entries(source)) {
        if (!key.startsWith(`${provider}:`)) continue
        providerEntries.set(key, value)
      }
    }
    if (providerEntries.size === 1) {
      const [fallbackMetadata] = providerEntries.values()
      mergedPreferredMetadata = {
        ...(mergedPreferredMetadata ?? {}),
        ...fallbackMetadata,
      }
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
  const canonicalDurableSessionId = getCanonicalDurableSessionId(session)
  if (!canonicalDurableSessionId) return null
  const sessionRef = sanitizeSessionRef({
    provider: 'claude',
    sessionId: canonicalDurableSessionId,
  })
  if (!sessionRef) return null

  const paneNeedsSessionRef = !sessionRefEquals(paneContent.sessionRef, sessionRef)
  const tabNeedsSessionRef = !sessionRefEquals(currentTab?.sessionRef, sessionRef)
  const paneNeedsResumeClear = typeof paneContent.resumeSessionId === 'string'
  const tabNeedsResumeClear = typeof currentTab?.resumeSessionId === 'string'

  const paneUpdates = paneNeedsSessionRef || paneNeedsResumeClear || paneContent.restoreError
    ? {
        ...(paneNeedsSessionRef ? { sessionRef } : {}),
        ...(paneNeedsResumeClear ? { resumeSessionId: undefined } : {}),
        ...(paneContent.restoreError ? { restoreError: undefined } : {}),
      }
    : undefined

  let tabUpdates: Partial<Tab> | undefined
  if (currentTab) {
    const nextTabUpdates: Partial<Tab> = {
      ...(tabNeedsSessionRef ? { sessionRef } : {}),
      ...(tabNeedsResumeClear ? { resumeSessionId: undefined } : {}),
    }
    if (metadataProvider && currentTab.codingCliProvider !== metadataProvider) {
      nextTabUpdates.codingCliProvider = metadataProvider
    }

    const nextSessionMetadataByKey = mergeSessionMetadataForPreferredResumeId({
      localSessionMetadataByKey: currentTab.sessionMetadataByKey,
      remoteSessionMetadataByKey: currentTab.sessionMetadataByKey,
      existingSessionMetadataByKey: currentTab.sessionMetadataByKey,
      provider: metadataProvider,
      localResumeSessionId: currentTab.sessionRef?.sessionId ?? currentTab.resumeSessionId,
      remoteResumeSessionId: paneContent.sessionRef?.sessionId ?? paneContent.resumeSessionId,
      preferredResumeSessionId: canonicalDurableSessionId,
      sessionType: paneContent.provider,
    })

    if (JSON.stringify(nextSessionMetadataByKey ?? {}) !== JSON.stringify(currentTab.sessionMetadataByKey ?? {})) {
      nextTabUpdates.sessionMetadataByKey = nextSessionMetadataByKey
    }

    if (Object.keys(nextTabUpdates).length > 0) {
      tabUpdates = nextTabUpdates
    }
  }

  const shouldFlush = paneNeedsSessionRef || tabNeedsSessionRef || paneNeedsResumeClear || tabNeedsResumeClear

  if (!paneUpdates && !tabUpdates && !shouldFlush) {
    return null
  }

  return {
    paneUpdates,
    tabUpdates,
    shouldFlush,
  }
}
