import { z } from 'zod'
import { hydratePanes } from './panesSlice'
import { hydrateTabs } from './tabsSlice'
import { parsePersistedPanesRaw, parsePersistedTabsRaw, PANES_STORAGE_KEY, TABS_STORAGE_KEY } from './persistedState'
import { getPersistBroadcastSourceId, onPersistBroadcast, PERSIST_BROADCAST_CHANNEL_NAME } from './persistBroadcast'

type StoreLike = {
  dispatch: (action: any) => any
  getState: () => any
}

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

function dispatchHydrateTabsFromPersisted(store: StoreLike, raw: string) {
  const parsed = parsePersistedTabsRaw(raw)
  if (!parsed) return

  const remoteTabs = parsed.tabs.tabs
  const remoteIds = new Set(remoteTabs.map((t: any) => t?.id).filter((id: any): id is string => typeof id === 'string'))

  const state = store.getState()
  const localActive = state?.tabs?.activeTabId as string | null | undefined

  const desired = (localActive && remoteIds.has(localActive)) ? localActive : parsed.tabs.activeTabId
  const activeTabId =
    desired && remoteIds.has(desired)
      ? desired
      : (remoteTabs[0]?.id ?? null)

  store.dispatch({
    ...hydrateTabs({
      tabs: remoteTabs,
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
  const localActiveByTab = (state?.panes?.activePane || {}) as Record<string, string>

  const nextActive: Record<string, string> = {}

  for (const [tabId, node] of Object.entries(parsed.layouts || {})) {
    const leafIds = collectPaneIdsSafe(node)
    if (leafIds.length === 0) continue
    const leafSet = new Set(leafIds)

    const localDesired = localActiveByTab[tabId]
    if (typeof localDesired === 'string' && leafSet.has(localDesired)) {
      nextActive[tabId] = localDesired
      continue
    }

    const remoteDesired = parsed.activePane?.[tabId]
    if (typeof remoteDesired === 'string' && leafSet.has(remoteDesired)) {
      nextActive[tabId] = remoteDesired
      continue
    }

    nextActive[tabId] = leafIds[leafIds.length - 1]
  }

  store.dispatch({
    ...hydratePanes({
      layouts: parsed.layouts as any,
      activePane: nextActive,
      paneTitles: parsed.paneTitles,
      paneTitleSetByUser: parsed.paneTitleSetByUser,
    } as any),
    meta: { skipPersist: true, source: 'cross-tab' },
  })
}

function handleIncomingRaw(store: StoreLike, key: string, raw: string) {
  if (key === TABS_STORAGE_KEY) {
    dispatchHydrateTabsFromPersisted(store, raw)
  } else if (key === PANES_STORAGE_KEY) {
    dispatchHydratePanesFromPersisted(store, raw)
  }
}

export function installCrossTabSync(store: StoreLike): () => void {
  if (typeof window === 'undefined') return () => {}

  // Storage events and BroadcastChannel can both deliver the same persisted payload.
  // Dedupe by exact raw value so we don't hydrate twice.
  const lastProcessedRawByKey = new Map<string, string>()
  const handleIncomingRawDeduped = (key: string, raw: string) => {
    if (lastProcessedRawByKey.get(key) === raw) return
    lastProcessedRawByKey.set(key, raw)
    handleIncomingRaw(store, key, raw)
  }

  // Keep dedupe state in sync with local writes too. Otherwise, if we process a remote raw,
  // then diverge locally (persisted raw changes), a later remote event with the original raw
  // could be incorrectly ignored.
  const unsubscribeLocal = onPersistBroadcast((msg) => {
    if (msg.key !== TABS_STORAGE_KEY && msg.key !== PANES_STORAGE_KEY) return
    lastProcessedRawByKey.set(msg.key, msg.raw)
  })

  const onStorage = (e: StorageEvent) => {
    if (e.storageArea && e.storageArea !== localStorage) return
    const key = e.key
    if (key !== TABS_STORAGE_KEY && key !== PANES_STORAGE_KEY) return
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
