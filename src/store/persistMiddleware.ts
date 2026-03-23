import type { Middleware } from '@reduxjs/toolkit'
import type { PanesState } from './paneTypes'
import type { TabsState } from './tabsSlice'
import { broadcastPersistedRaw } from './persistBroadcast'
import { createLogger } from '@/lib/client-logger'
import {
  loadPersistedPanes,
  loadPersistedTabs,
  primeLoadedWorkspaceSnapshotCache,
  resetLoadedWorkspaceSnapshotCacheForTests,
  serializeWorkspaceSnapshot,
} from './workspacePersistence'
import { PANES_STORAGE_KEY, TABS_STORAGE_KEY, WORKSPACE_STORAGE_KEY } from './storage-keys'

const log = createLogger('WorkspacePersist')

export { loadPersistedPanes, loadPersistedTabs }

export const PERSIST_DEBOUNCE_MS = 500

const flushCallbacks = new Set<() => void>()
let flushListenersAttached = false

type PersistState = {
  tabs?: TabsState
  panes?: PanesState
}

function notifyFlushCallbacks() {
  for (const cb of flushCallbacks) {
    try {
      cb()
    } catch {
      // ignore
    }
  }
}

function attachFlushListeners() {
  if (flushListenersAttached) return
  if (typeof document === 'undefined' || typeof window === 'undefined') return

  const handleVisibility = () => {
    if (document.visibilityState === 'hidden') {
      notifyFlushCallbacks()
    }
  }
  const handlePageHide = () => {
    notifyFlushCallbacks()
  }

  document.addEventListener('visibilitychange', handleVisibility)
  window.addEventListener('pagehide', handlePageHide)
  window.addEventListener('beforeunload', handlePageHide)

  flushListenersAttached = true
}

function registerFlushCallback(cb: () => void) {
  flushCallbacks.add(cb)
  attachFlushListeners()
}

function createEmptyTabsState(): TabsState {
  return {
    tabs: [],
    activeTabId: null,
    renameRequestTabId: null,
  }
}

function createEmptyPanesState(): PanesState {
  return {
    layouts: {},
    activePane: {},
    paneTitles: {},
    paneTitleSetByUser: {},
    renameRequestTabId: null,
    renameRequestPaneId: null,
    zoomedPane: {},
    refreshRequestsByPane: {},
  }
}

export function resetPersistFlushListenersForTests() {
  flushCallbacks.clear()
}

export function resetPersistedPanesCacheForTests() {
  resetLoadedWorkspaceSnapshotCacheForTests()
}

export const persistMiddleware: Middleware<{}, PersistState> = (store) => {
  let tabsDirty = false
  let panesDirty = false
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  const canUseStorage = () => typeof localStorage !== 'undefined'

  const flush = () => {
    flushTimer = null
    if (!canUseStorage()) return
    if (!tabsDirty && !panesDirty) return

    const state = store.getState()
    const tabsState = state.tabs ?? createEmptyTabsState()
    const panesState = state.panes ?? createEmptyPanesState()
    const serialized = serializeWorkspaceSnapshot({
      tabs: tabsState,
      panes: panesState,
    })

    if (!serialized.ok) {
      log.error('Refusing to persist invalid workspace snapshot', {
        missingLayoutTabIds: serialized.missingLayoutTabIds,
      })
      return
    }

    try {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, serialized.workspaceRaw)
      broadcastPersistedRaw(WORKSPACE_STORAGE_KEY, serialized.workspaceRaw)
      primeLoadedWorkspaceSnapshotCache({
        ...serialized.snapshot,
        source: 'workspace',
        validation: serialized.validation,
      })
    } catch (err) {
      log.error('Failed to save authoritative workspace snapshot to localStorage', err)
      return
    }

    try {
      localStorage.setItem(TABS_STORAGE_KEY, serialized.tabsRaw)
      broadcastPersistedRaw(TABS_STORAGE_KEY, serialized.tabsRaw)
    } catch (err) {
      log.error('Failed to save tabs compatibility mirror to localStorage', err)
    }

    try {
      localStorage.setItem(PANES_STORAGE_KEY, serialized.panesRaw)
      broadcastPersistedRaw(PANES_STORAGE_KEY, serialized.panesRaw)
    } catch (err) {
      log.error('Failed to save panes compatibility mirror to localStorage', err)
    }

    tabsDirty = false
    panesDirty = false
  }

  const scheduleFlush = () => {
    if (flushTimer) return
    flushTimer = setTimeout(flush, PERSIST_DEBOUNCE_MS)
  }

  const flushNow = () => {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    flush()
  }

  registerFlushCallback(flushNow)

  return (next) => (action) => {
    const result = next(action)

    const a = action as any
    if (a?.meta?.skipPersist) {
      return result
    }

    if (typeof a?.type === 'string') {
      if (a.type.startsWith('tabs/')) {
        tabsDirty = true
        scheduleFlush()
      }
      if (a.type.startsWith('panes/')) {
        panesDirty = true
        scheduleFlush()
      }
      if (a.type.startsWith('workspace/')) {
        tabsDirty = true
        panesDirty = true
        scheduleFlush()
      }
    }

    return result
  }
}
