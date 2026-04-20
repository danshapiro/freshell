import { createAction } from '@reduxjs/toolkit'
import type { ChatSessionState } from './agentChatTypes'
import type { AgentChatPaneContent } from './paneTypes'
import type { CodingCliProviderName, SessionListMetadata, Tab } from './types'
import { isValidClaudeSessionId } from '@/lib/claude-session-id'
import { sessionMetadataKey } from '@/lib/session-metadata'
import { sanitizeSessionRef, type SessionRef } from '@shared/session-contract'

export const flushPersistedLayoutNow = createAction('persist/flushNow')

export function buildDurableResumeIdentityUpdate({
  paneResumeSessionId,
  tabResumeSessionId,
  sessionId,
  flushSessionId = sessionId,
}: {
  paneResumeSessionId?: string
  tabResumeSessionId?: string
  sessionId?: string
  flushSessionId?: string
}): {
  paneUpdates?: { resumeSessionId: string }
  tabUpdates?: { resumeSessionId: string }
  shouldFlush: boolean
} | null {
  if (!sessionId) return null

  const paneUpdates =
    paneResumeSessionId !== sessionId
      ? { resumeSessionId: sessionId }
      : undefined

  const tabUpdates =
    tabResumeSessionId !== sessionId
      ? { resumeSessionId: sessionId }
      : undefined

  const shouldFlush = Boolean(
    flushSessionId
      && (
        paneResumeSessionId !== flushSessionId
        || tabResumeSessionId !== flushSessionId
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
  paneUpdates?: { sessionRef: SessionRef; resumeSessionId?: string }
  tabUpdates?: Partial<Tab>
  shouldFlush: boolean
} | null {
  const sessionRef = provider && sessionId
    ? sanitizeSessionRef({ provider, sessionId })
    : undefined
  if (!sessionRef) return null

  const paneNeedsSessionRef = !sessionRefEquals(paneSessionRef, sessionRef)
  const tabNeedsSessionRef = !sessionRefEquals(tabSessionRef, sessionRef)
  const paneNeedsResumeMirror = paneResumeSessionId !== sessionRef.sessionId
  const tabNeedsResumeMirror = tabResumeSessionId !== sessionRef.sessionId

  const paneUpdates = paneNeedsSessionRef || paneNeedsResumeMirror
    ? {
        sessionRef,
        ...(paneNeedsResumeMirror ? { resumeSessionId: sessionRef.sessionId } : {}),
      }
    : undefined

  const tabUpdates = tabNeedsSessionRef || tabNeedsResumeMirror
    ? {
        ...(tabNeedsSessionRef ? { sessionRef } : {}),
        ...(tabNeedsResumeMirror ? { resumeSessionId: sessionRef.sessionId } : {}),
      }
    : undefined

  const shouldFlush = paneNeedsSessionRef || tabNeedsSessionRef || paneNeedsResumeMirror || tabNeedsResumeMirror

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
  const canonicalDurableSessionId = getCanonicalDurableSessionId(session)
  const durableIdentityUpdate = buildDurableResumeIdentityUpdate({
    paneResumeSessionId: paneContent.resumeSessionId,
    tabResumeSessionId: currentTab?.resumeSessionId,
    sessionId: preferredResumeSessionId,
    flushSessionId: canonicalDurableSessionId,
  })
  const paneUpdates = durableIdentityUpdate?.paneUpdates

  let tabUpdates: Partial<Tab> | undefined
  if (currentTab) {
    const nextTabUpdates: Partial<Tab> = { ...(durableIdentityUpdate?.tabUpdates ?? {}) }
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

  const shouldFlush = durableIdentityUpdate?.shouldFlush ?? false

  if (!paneUpdates && !tabUpdates && !shouldFlush) {
    return null
  }

  return {
    paneUpdates,
    tabUpdates,
    shouldFlush,
  }
}
