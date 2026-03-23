import { z } from 'zod'
import { mergeLocalSettings, resolveLocalSettings } from '@shared/settings'
import { hydratePanes } from './panesSlice'
import { setLocalSettings } from './settingsSlice'
import { setTabRegistrySearchRangeDays } from './tabRegistrySlice'
import { hydrateTabs } from './tabsSlice'
import { getPendingBrowserPreferencesWriteState } from './browserPreferencesPersistence'
import { parsePersistedPanesRaw, parsePersistedTabsRaw } from './persistedState'
import { getPersistBroadcastSourceId, onPersistBroadcast, PERSIST_BROADCAST_CHANNEL_NAME } from './persistBroadcast'
import {
  BROWSER_PREFERENCES_STORAGE_KEY,
  PANES_STORAGE_KEY,
  TABS_STORAGE_KEY,
  WORKSPACE_STORAGE_KEY,
} from './storage-keys'
import { parseBrowserPreferencesRaw, resolveBrowserPreferenceSettings } from '@/lib/browser-preferences'
import { hydrateWorkspaceSnapshot } from './workspaceActions'
import { parsePersistedWorkspaceRaw } from './workspacePersistence'

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

function resolveHydratedActiveTabId(
  localActiveTabId: string | null | undefined,
  remoteTabs: Array<{ id?: string }>,
  remoteActiveTabId: string | null | undefined,
) {
  const remoteIds = new Set(
    remoteTabs
      .map((tab) => tab?.id)
      .filter((id): id is string => typeof id === 'string'),
  )

  const desiredActiveTabId =
    localActiveTabId && remoteIds.has(localActiveTabId)
      ? localActiveTabId
      : remoteActiveTabId

  return desiredActiveTabId && remoteIds.has(desiredActiveTabId)
    ? desiredActiveTabId
    : (remoteTabs[0]?.id ?? null)
}

function resolveHydratedActivePaneByTab(
  layouts: Record<string, unknown>,
  remoteActivePane: Record<string, string> | undefined,
  localActivePaneByTab: Record<string, string>,
) {
  const nextActivePane: Record<string, string> = {}

  for (const [tabId, node] of Object.entries(layouts || {})) {
    const leafIds = collectPaneIdsSafe(node)
    if (leafIds.length === 0) continue
    const leafSet = new Set(leafIds)

    const localDesired = localActivePaneByTab[tabId]
    if (typeof localDesired === 'string' && leafSet.has(localDesired)) {
      nextActivePane[tabId] = localDesired
      continue
    }

    const remoteDesired = remoteActivePane?.[tabId]
    if (typeof remoteDesired === 'string' && leafSet.has(remoteDesired)) {
      nextActivePane[tabId] = remoteDesired
      continue
    }

    nextActivePane[tabId] = leafIds[leafIds.length - 1]
  }

  return nextActivePane
}

function dispatchHydrateTabsFromPersisted(store: StoreLike, raw: string) {
  const parsed = parsePersistedTabsRaw(raw)
  if (!parsed) return

  const state = store.getState()
  const activeTabId = resolveHydratedActiveTabId(
    state?.tabs?.activeTabId as string | null | undefined,
    parsed.tabs.tabs as Array<{ id?: string }>,
    parsed.tabs.activeTabId,
  )

  store.dispatch({
    ...hydrateTabs({
      tabs: parsed.tabs.tabs,
      activeTabId,
      renameRequestTabId: null,
    } as any),
    meta: { skipPersist: true, source: 'cross-tab' },
  })
}

function dispatchHydratePanesFromPersisted(store: StoreLike, raw: string) {
  const parsed = parsePersistedPanesRaw(raw)
  if (!parsed) return

  const state = store.getState()
  const nextActivePane = resolveHydratedActivePaneByTab(
    parsed.layouts,
    parsed.activePane,
    (state?.panes?.activePane || {}) as Record<string, string>,
  )

  store.dispatch({
    ...hydratePanes({
      layouts: parsed.layouts as any,
      activePane: nextActivePane,
      paneTitles: parsed.paneTitles,
      paneTitleSetByUser: parsed.paneTitleSetByUser,
    } as any),
    meta: { skipPersist: true, source: 'cross-tab' },
  })
}

function dispatchHydrateWorkspaceFromPersisted(store: StoreLike, raw: string) {
  const parsed = parsePersistedWorkspaceRaw(raw)
  if (!parsed) return

  const state = store.getState()
  const activeTabId = resolveHydratedActiveTabId(
    state?.tabs?.activeTabId as string | null | undefined,
    parsed.tabs.tabs as Array<{ id?: string }>,
    parsed.tabs.activeTabId,
  )
  const nextActivePane = resolveHydratedActivePaneByTab(
    parsed.panes.layouts,
    parsed.panes.activePane,
    (state?.panes?.activePane || {}) as Record<string, string>,
  )

  store.dispatch({
    ...hydrateWorkspaceSnapshot({
      tabs: {
        tabs: parsed.tabs.tabs as any,
        activeTabId,
        renameRequestTabId: null,
      },
      panes: {
        layouts: parsed.panes.layouts as any,
        activePane: nextActivePane,
        paneTitles: parsed.panes.paneTitles,
        paneTitleSetByUser: parsed.panes.paneTitleSetByUser,
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
    }),
    meta: { skipPersist: true, source: 'cross-tab' },
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

function handleIncomingRaw(store: StoreLike, key: string, raw: string, previousRaw?: string) {
  if (key === WORKSPACE_STORAGE_KEY) {
    dispatchHydrateWorkspaceFromPersisted(store, raw)
  } else if (key === TABS_STORAGE_KEY) {
    dispatchHydrateTabsFromPersisted(store, raw)
  } else if (key === PANES_STORAGE_KEY) {
    dispatchHydratePanesFromPersisted(store, raw)
  } else if (key === BROWSER_PREFERENCES_STORAGE_KEY) {
    dispatchHydrateBrowserPreferencesFromPersisted(store, raw, previousRaw)
  }
}

export function installCrossTabSync(store: StoreLike): () => void {
  if (typeof window === 'undefined') return () => {}

  const lastProcessedRawByKey = new Map<string, string>()
  for (const key of [
    WORKSPACE_STORAGE_KEY,
    TABS_STORAGE_KEY,
    PANES_STORAGE_KEY,
    BROWSER_PREFERENCES_STORAGE_KEY,
  ]) {
    const existingRaw = localStorage.getItem(key)
    if (typeof existingRaw === 'string') {
      lastProcessedRawByKey.set(key, existingRaw)
    }
  }

  const hasAuthoritativeWorkspace = () => typeof localStorage.getItem(WORKSPACE_STORAGE_KEY) === 'string'

  const shouldIgnoreMirrorEvent = (key: string) =>
    key !== WORKSPACE_STORAGE_KEY
    && (key === TABS_STORAGE_KEY || key === PANES_STORAGE_KEY)
    && hasAuthoritativeWorkspace()

  const handleIncomingRawDeduped = (key: string, raw: string) => {
    if (shouldIgnoreMirrorEvent(key)) return
    const previousRaw = lastProcessedRawByKey.get(key)
    if (previousRaw === raw) return
    lastProcessedRawByKey.set(key, raw)
    handleIncomingRaw(store, key, raw, previousRaw)
  }

  const unsubscribeLocal = onPersistBroadcast((msg) => {
    if (
      msg.key !== WORKSPACE_STORAGE_KEY
      && msg.key !== TABS_STORAGE_KEY
      && msg.key !== PANES_STORAGE_KEY
      && msg.key !== BROWSER_PREFERENCES_STORAGE_KEY
    ) {
      return
    }
    lastProcessedRawByKey.set(msg.key, msg.raw)
  })

  const onStorage = (e: StorageEvent) => {
    if (e.storageArea && e.storageArea !== localStorage) return
    const key = e.key
    if (
      key !== WORKSPACE_STORAGE_KEY
      && key !== TABS_STORAGE_KEY
      && key !== PANES_STORAGE_KEY
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
