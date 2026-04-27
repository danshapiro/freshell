import { z } from 'zod'
import { mergeLocalSettings, resolveLocalSettings } from '@shared/settings'
import { hydratePanes } from './panesSlice'
import { setLocalSettings } from './settingsSlice'
import { setTabRegistrySearchRangeDays } from './tabRegistrySlice'
import { hydrateTabs } from './tabsSlice'
import { getPendingBrowserPreferencesWriteState } from './browserPreferencesPersistence'
import { parsePersistedLayoutRaw, LAYOUT_STORAGE_KEY } from './persistedState'
import { getPersistBroadcastSourceId, onPersistBroadcast, PERSIST_BROADCAST_CHANNEL_NAME } from './persistBroadcast'
import { shouldPreserveLocalCanonicalResumeSessionId } from './persistControl'
import { BROWSER_PREFERENCES_STORAGE_KEY } from './storage-keys'
import { parseBrowserPreferencesRaw, resolveBrowserPreferenceSettings } from '@/lib/browser-preferences'

type StoreLike = {
  dispatch: (action: any) => any
  getState: () => any
}

const DEFAULT_SEARCH_RANGE_DAYS = 30

const zPersistBroadcastMsg = z.object({
  type: z.literal('persist'),
  key: z.string(),
  raw: z.string(),
  sourceId: z.string(),
})

function collectPaneIdsSafe(node: unknown): string[] {
  const ids: string[] = []

  const visit = (n: any) => {
    if (!n || typeof n !== 'object') return

    if (n.type === 'leaf') {
      if (typeof n.id === 'string') ids.push(n.id)
      return
    }

    if (n.type === 'split' && Array.isArray(n.children) && n.children.length >= 2) {
      visit(n.children[0])
      visit(n.children[1])
      return
    }
  }

  visit(node)
  return ids
}

function findLeafContentById(node: unknown, paneId: string): any | undefined {
  const visit = (candidate: any): any | undefined => {
    if (!candidate || typeof candidate !== 'object') return undefined
    if (candidate.type === 'leaf') {
      return candidate.id === paneId ? candidate.content : undefined
    }
    if (candidate.type === 'split' && Array.isArray(candidate.children) && candidate.children.length >= 2) {
      return visit(candidate.children[0]) ?? visit(candidate.children[1])
    }
    return undefined
  }

  return visit(node)
}

function buildCanonicalClaudeSessionRef(localContent: any, localResumeSessionId: string): {
  provider: 'claude'
  sessionId: string
} | undefined {
  const explicit = localContent?.sessionRef
  if (
    explicit
    && typeof explicit === 'object'
    && explicit.provider === 'claude'
    && explicit.sessionId === localResumeSessionId
  ) {
    return {
      provider: 'claude',
      sessionId: localResumeSessionId,
    }
  }

  if (
    localContent?.kind === 'agent-chat'
    || (localContent?.kind === 'terminal' && localContent?.mode === 'claude')
  ) {
    return {
      provider: 'claude',
      sessionId: localResumeSessionId,
    }
  }

  return undefined
}

function protectCanonicalPaneResumeIdentity(remoteNode: unknown, localLayout: unknown): unknown {
  const visit = (candidate: any): any => {
    if (!candidate || typeof candidate !== 'object') return candidate
    if (candidate.type === 'leaf') {
      const localContent = findLeafContentById(localLayout, candidate.id)
      const localResumeSessionId = localContent?.resumeSessionId
      const remoteResumeSessionId = candidate.content?.resumeSessionId
      if (
        (candidate.content?.kind === 'terminal' || candidate.content?.kind === 'agent-chat')
        && shouldPreserveLocalCanonicalResumeSessionId(localResumeSessionId, remoteResumeSessionId)
      ) {
        const preservedSessionRef = buildCanonicalClaudeSessionRef(localContent, localResumeSessionId)
        return {
          ...candidate,
          content: {
            ...candidate.content,
            resumeSessionId: localResumeSessionId,
            sessionRef: preservedSessionRef,
          },
        }
      }
      return candidate
    }
    if (candidate.type === 'split' && Array.isArray(candidate.children) && candidate.children.length >= 2) {
      return {
        ...candidate,
        children: [
          visit(candidate.children[0]),
          visit(candidate.children[1]),
        ],
      }
    }
    return candidate
  }

  return visit(remoteNode)
}

function dispatchHydrateLayoutFromPersisted(
  store: StoreLike,
  raw: string,
  localLayoutPersistedAt?: number,
) {
  const parsed = parsePersistedLayoutRaw(raw)
  if (!parsed) return
  const state = store.getState()
  const localLayouts = (state?.panes?.layouts || {}) as Record<string, unknown>
  const protectedLayouts = Object.fromEntries(
    Object.entries(parsed.panes.layouts || {}).map(([tabId, node]) => [
      tabId,
      protectCanonicalPaneResumeIdentity(node, localLayouts[tabId]),
    ]),
  )

  // Hydrate tabs with merge
  store.dispatch({
    ...hydrateTabs({
      tabs: parsed.tabs.tabs,
      activeTabId: parsed.tabs.activeTabId,
      renameRequestTabId: null,
      tombstones: parsed.tombstones,
    } as any),
    meta: {
      skipPersist: true,
      source: 'cross-tab',
      localLayoutPersistedAt,
      remoteLayoutPersistedAt: parsed.persistedAt,
    },
  })

  // Hydrate panes
  const localActiveByTab = (state?.panes?.activePane || {}) as Record<string, string>
  const nextActive: Record<string, string> = {}

  for (const [tabId, node] of Object.entries(protectedLayouts)) {
    const leafIds = collectPaneIdsSafe(node)
    if (leafIds.length === 0) continue
    const leafSet = new Set(leafIds)

    const localDesired = localActiveByTab[tabId]
    if (typeof localDesired === 'string' && leafSet.has(localDesired)) {
      nextActive[tabId] = localDesired
      continue
    }

    const remoteDesired = parsed.panes.activePane?.[tabId]
    if (typeof remoteDesired === 'string' && leafSet.has(remoteDesired)) {
      nextActive[tabId] = remoteDesired
      continue
    }

    nextActive[tabId] = leafIds[leafIds.length - 1]
  }

  store.dispatch({
    ...hydratePanes({
      layouts: protectedLayouts as any,
      activePane: nextActive,
      paneTitles: parsed.panes.paneTitles,
      paneTitleSetByUser: parsed.panes.paneTitleSetByUser,
    } as any),
    meta: {
      skipPersist: true,
      source: 'cross-tab',
      localLayoutPersistedAt,
      remoteLayoutPersistedAt: parsed.persistedAt,
    },
  })
}

function dispatchHydrateBrowserPreferencesFromPersisted(
  store: StoreLike,
  raw: string,
  previousRaw?: string,
) {
  const parsed = parseBrowserPreferencesRaw(raw)
  if (!parsed) return

  const previousParsed = previousRaw ? parseBrowserPreferencesRaw(previousRaw) : null
  const remoteResetSettingsToDefaults = previousParsed?.settings !== undefined && parsed.settings === undefined
  const remoteResetSearchRangeToDefault =
    previousParsed?.tabs?.searchRangeDays !== undefined && parsed.tabs?.searchRangeDays === undefined
  const pendingWriteState = getPendingBrowserPreferencesWriteState(store)
  const remoteSettingsPatch = parsed.settings ?? {}
  let mergedSettingsPatch = remoteSettingsPatch
  if (pendingWriteState.settingsPatch) {
    mergedSettingsPatch = mergeLocalSettings(mergedSettingsPatch, pendingWriteState.settingsPatch)
  }
  const nextSettings = pendingWriteState.settingsPatch
    ? resolveLocalSettings(mergedSettingsPatch)
    : resolveBrowserPreferenceSettings(parsed)
  const nextSearchRangeDays = pendingWriteState.hasPendingSearchRangeDays
    ? pendingWriteState.searchRangeDays
    : (parsed.tabs?.searchRangeDays ?? DEFAULT_SEARCH_RANGE_DAYS)

  if (
    parsed.settings
    || remoteResetSettingsToDefaults
    || pendingWriteState.settingsPatch
  ) {
    store.dispatch({
      ...setLocalSettings(nextSettings),
      meta: { skipPersist: true, source: 'cross-tab' },
    })
  }
  if (
    parsed.tabs?.searchRangeDays !== undefined
    || remoteResetSearchRangeToDefault
    || pendingWriteState.hasPendingSearchRangeDays
  ) {
    store.dispatch({
      ...setTabRegistrySearchRangeDays(nextSearchRangeDays),
      meta: { skipPersist: true, source: 'cross-tab' },
    })
  }
}

function handleIncomingRaw(
  store: StoreLike,
  key: string,
  raw: string,
  previousRaw?: string,
  localLayoutPersistedAt?: number,
) {
  if (key === LAYOUT_STORAGE_KEY) {
    dispatchHydrateLayoutFromPersisted(store, raw, localLayoutPersistedAt)
  } else if (key === BROWSER_PREFERENCES_STORAGE_KEY) {
    dispatchHydrateBrowserPreferencesFromPersisted(store, raw, previousRaw)
  }
}

export function installCrossTabSync(store: StoreLike): () => void {
  if (typeof window === 'undefined') return () => {}

  // Storage events and BroadcastChannel can both deliver the same persisted payload.
  // Dedupe by exact raw value so we don't hydrate twice.
  const lastProcessedRawByKey = new Map<string, string>()
  let currentLocalLayoutPersistedAt: number | undefined
  for (const key of [LAYOUT_STORAGE_KEY, BROWSER_PREFERENCES_STORAGE_KEY]) {
    const existingRaw = localStorage.getItem(key)
    if (typeof existingRaw === 'string') {
      lastProcessedRawByKey.set(key, existingRaw)
      if (key === LAYOUT_STORAGE_KEY) {
        const parsed = parsePersistedLayoutRaw(existingRaw)
        currentLocalLayoutPersistedAt = parsed?.persistedAt
      }
    }
  }

  const mergeAuthoritativeLayoutPersistedAt = (candidate?: number) => {
    if (typeof candidate !== 'number') return
    if (typeof currentLocalLayoutPersistedAt !== 'number' || candidate > currentLocalLayoutPersistedAt) {
      currentLocalLayoutPersistedAt = candidate
    }
  }

  const tryDedupeAndMark = (key: string, raw: string): boolean => {
    if (lastProcessedRawByKey.get(key) === raw) return false
    lastProcessedRawByKey.set(key, raw)
    return true
  }

  const handleIncomingRawDeduped = (key: string, raw: string) => {
    const previousRaw = lastProcessedRawByKey.get(key)
    if (!tryDedupeAndMark(key, raw)) return
    handleIncomingRaw(store, key, raw, previousRaw, currentLocalLayoutPersistedAt)
    if (key === LAYOUT_STORAGE_KEY) {
      mergeAuthoritativeLayoutPersistedAt(parsePersistedLayoutRaw(raw)?.persistedAt)
    }
  }

  // Keep dedupe state in sync with local writes too. Otherwise, if we process a remote raw,
  // then diverge locally (persisted raw changes), a later remote event with the original raw
  // could be incorrectly ignored.
  const unsubscribeLocal = onPersistBroadcast((msg) => {
    if (
      msg.key !== LAYOUT_STORAGE_KEY
      && msg.key !== BROWSER_PREFERENCES_STORAGE_KEY
    ) {
      return
    }
    lastProcessedRawByKey.set(msg.key, msg.raw)
    if (msg.key === LAYOUT_STORAGE_KEY) {
      currentLocalLayoutPersistedAt = parsePersistedLayoutRaw(msg.raw)?.persistedAt
    }
  })

  const onStorage = (e: StorageEvent) => {
    if (e.storageArea && e.storageArea !== localStorage) return
    const key = e.key
    if (
      key !== LAYOUT_STORAGE_KEY
      && key !== BROWSER_PREFERENCES_STORAGE_KEY
    ) {
      return
    }
    if (typeof e.newValue !== 'string') return
    handleIncomingRawDeduped(key, e.newValue)
  }

  window.addEventListener('storage', onStorage)

  let channel: BroadcastChannel | null = null
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(PERSIST_BROADCAST_CHANNEL_NAME)
    channel.onmessage = (event) => {
      const res = zPersistBroadcastMsg.safeParse((event as any)?.data)
      if (!res.success) return
      if (res.data.sourceId === getPersistBroadcastSourceId()) return
      handleIncomingRawDeduped(res.data.key, res.data.raw)
    }
  }

  return () => {
    unsubscribeLocal()
    window.removeEventListener('storage', onStorage)
    if (channel) {
      try {
        channel.close()
      } catch {
        // ignore
      }
    }
  }
}
