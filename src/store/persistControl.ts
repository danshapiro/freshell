import { createAction } from '@reduxjs/toolkit'
import type { CodingCliProviderName, SessionListMetadata, Tab } from './types'
import { isValidClaudeSessionId } from '@/lib/claude-session-id'
import { sessionMetadataKey } from '@/lib/session-metadata'
import { sanitizeSessionRef, type SessionRef } from '@shared/session-contract'

export const flushPersistedLayoutNow = createAction('persist/flushNow')

type PersistControlOwner = object

const defaultPersistControlOwner = {}
const ownerKey = (owner?: PersistControlOwner) => owner ?? defaultPersistControlOwner

let localClosePersistencePendingByOwner = new WeakSet<PersistControlOwner>()
export type LocalClosePersistenceTopology = { layoutKey: string; topologySignature: string }
let localClosePersistenceTopologyByOwner = new WeakMap<PersistControlOwner, LocalClosePersistenceTopology>()
let authoritativeLocalLayoutPersistedAtByOwner = new WeakMap<PersistControlOwner, Map<string, number>>()
let localLayoutBaselinePersistedAtByOwner = new WeakMap<PersistControlOwner, Map<string, number | null>>()
// A rejected same-key event must not advance the acceptance/freshness floor,
// but a later write still must not emit a lower persistedAt than a timestamp
// it has already observed. Keep that serialization high-water separate from
// the topology baseline and authoritative recency floor.
let localLayoutWriteTimestampByOwner = new WeakMap<PersistControlOwner, Map<string, number>>()

/** Mark that local close state must reach durable layout storage before hydration. */
export function markLocalClosePersistencePending(
  owner?: PersistControlOwner,
  layoutKey?: string,
  topologySignature?: string,
): void {
  const resolvedOwner = ownerKey(owner)
  if (
    !localClosePersistencePendingByOwner.has(resolvedOwner)
    && typeof layoutKey === 'string'
    && layoutKey.length > 0
    && typeof topologySignature === 'string'
  ) {
    localClosePersistenceTopologyByOwner.set(resolvedOwner, { layoutKey, topologySignature })
  }
  localClosePersistencePendingByOwner.add(resolvedOwner)
}

export function isLocalClosePersistencePending(owner?: PersistControlOwner): boolean {
  return localClosePersistencePendingByOwner.has(ownerKey(owner))
}

/** Clear the barrier after a durable write or when a stale close is abandoned. */
export function clearLocalClosePersistencePending(owner?: PersistControlOwner): void {
  const resolvedOwner = ownerKey(owner)
  localClosePersistencePendingByOwner.delete(resolvedOwner)
  localClosePersistenceTopologyByOwner.delete(resolvedOwner)
}

/** Snapshot of the topology from which a pending close was committed. */
export function getLocalClosePersistenceTopology(
  owner?: PersistControlOwner,
): LocalClosePersistenceTopology | undefined {
  return localClosePersistenceTopologyByOwner.get(ownerKey(owner))
}

/** Keep the accepted local-layout recency floor available to persistence. */
export function observeAuthoritativeLocalLayoutPersistedAt(
  key: string,
  candidate?: number,
  owner?: PersistControlOwner,
): void {
  if (!key || typeof candidate !== 'number' || !Number.isFinite(candidate)) return
  const ownerFloors = getOrCreateMap(authoritativeLocalLayoutPersistedAtByOwner, ownerKey(owner))
  const current = ownerFloors.get(key)
  if (
    typeof current !== 'number'
    || candidate > current
  ) {
    ownerFloors.set(key, candidate)
  }
}

export function getAuthoritativeLocalLayoutPersistedAt(key: string, owner?: PersistControlOwner): number | undefined {
  return authoritativeLocalLayoutPersistedAtByOwner.get(ownerKey(owner))?.get(key)
}

/** Initialize the persisted version represented by this store's current Redux tree. */
export function initializeLocalLayoutBaselinePersistedAt(
  key: string,
  candidate: number | null,
  owner: PersistControlOwner,
): void {
  if (!key) return
  const ownerBaselines = getOrCreateMap(localLayoutBaselinePersistedAtByOwner, owner)
  if (!ownerBaselines.has(key)) ownerBaselines.set(key, candidate)
}

/** Record the exact persisted version that was applied to this store or written by it. */
export function setLocalLayoutBaselinePersistedAt(
  key: string,
  candidate: number | null,
  owner: PersistControlOwner,
): void {
  if (!key) return
  getOrCreateMap(localLayoutBaselinePersistedAtByOwner, owner).set(key, candidate)
}

export function getLocalLayoutBaselinePersistedAt(
  key: string,
  owner: PersistControlOwner,
): number | null | undefined {
  return localLayoutBaselinePersistedAtByOwner.get(owner)?.get(key)
}

export function observeLocalLayoutWriteTimestamp(
  key: string,
  candidate?: number,
  owner?: PersistControlOwner,
): void {
  if (!key || typeof candidate !== 'number' || !Number.isFinite(candidate)) return
  const ownerTimestamps = getOrCreateMap(localLayoutWriteTimestampByOwner, ownerKey(owner))
  const current = ownerTimestamps.get(key)
  if (typeof current !== 'number' || candidate > current) ownerTimestamps.set(key, candidate)
}

export function getLocalLayoutWriteTimestamp(key: string, owner?: PersistControlOwner): number | undefined {
  return localLayoutWriteTimestampByOwner.get(ownerKey(owner))?.get(key)
}

function getOrCreateMap<K, V>(weakMap: WeakMap<PersistControlOwner, Map<K, V>>, owner: PersistControlOwner): Map<K, V> {
  let values = weakMap.get(owner)
  if (!values) {
    values = new Map<K, V>()
    weakMap.set(owner, values)
  }
  return values
}

export function resetAuthoritativeLocalLayoutPersistedAtForTests(): void {
  authoritativeLocalLayoutPersistedAtByOwner = new WeakMap()
  localLayoutBaselinePersistedAtByOwner = new WeakMap()
  localLayoutWriteTimestampByOwner = new WeakMap()
  localClosePersistencePendingByOwner = new WeakSet()
  localClosePersistenceTopologyByOwner = new WeakMap()
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
  tabSessionMetadataByKey,
}: {
  provider?: CodingCliProviderName
  sessionId?: string
  paneSessionRef?: SessionRef
  tabSessionRef?: SessionRef
  paneResumeSessionId?: string
  tabResumeSessionId?: string
  tabSessionMetadataByKey?: Record<string, SessionListMetadata>
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

  const nextTabUpdates: Partial<Tab> = {
    ...(tabNeedsSessionRef ? { sessionRef } : {}),
    ...(tabNeedsResumeClear ? { resumeSessionId: undefined } : {}),
  }

  // Rebind metadata re-key (same idiom as buildFreshAgentPersistedIdentityUpdate
  // below): merge whatever the tab knew under the superseded id(s) into the
  // `${provider}:${sessionId}` key of the new canonical id, deleting the old
  // keys. The merge helper ALWAYS returns a fresh object, so deep-compare
  // before writing to avoid churn updates on every broadcast.
  const nextSessionMetadataByKey = mergeSessionMetadataForPreferredResumeId({
    localSessionMetadataByKey: tabSessionMetadataByKey,
    remoteSessionMetadataByKey: tabSessionMetadataByKey,
    existingSessionMetadataByKey: tabSessionMetadataByKey,
    provider,
    localResumeSessionId: tabSessionRef?.sessionId ?? tabResumeSessionId,
    remoteResumeSessionId: paneSessionRef?.sessionId ?? paneResumeSessionId,
    preferredResumeSessionId: sessionRef.sessionId,
  })

  if (JSON.stringify(nextSessionMetadataByKey ?? {}) !== JSON.stringify(tabSessionMetadataByKey ?? {})) {
    nextTabUpdates.sessionMetadataByKey = nextSessionMetadataByKey
  }

  const tabUpdates = Object.keys(nextTabUpdates).length > 0 ? nextTabUpdates : undefined

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

export type SessionIdentityState = {
  historySessionId?: string
  cliSessionId?: string
} | undefined

type LegacyFreshAgentPersistedIdentityContent = Record<string, unknown> & {
  provider?: string
  resumeSessionId?: string
  sessionRef?: SessionRef
  restoreError?: unknown
}

export function getPreferredResumeSessionId(session: SessionIdentityState): string | undefined {
  return getCanonicalDurableSessionId(session)
    ?? session?.historySessionId
    ?? session?.cliSessionId
}

export function getCanonicalDurableSessionId(session: SessionIdentityState): string | undefined {
  if (isValidClaudeSessionId(session?.cliSessionId)) {
    return session.cliSessionId
  }
  if (isValidClaudeSessionId(session?.historySessionId)) {
    return session.historySessionId
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

export function buildFreshAgentPersistedIdentityUpdate({
  session,
  paneContent,
  currentTab,
  metadataProvider,
}: {
  session: SessionIdentityState
  paneContent: LegacyFreshAgentPersistedIdentityContent
  currentTab?: Tab
  metadataProvider?: CodingCliProviderName
}): {
  paneUpdates?: Partial<LegacyFreshAgentPersistedIdentityContent>
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
