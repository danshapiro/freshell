import { configureStore } from '@reduxjs/toolkit'
import { enableMapSet } from 'immer'
import tabsReducer from './tabsSlice'
import connectionReducer from './connectionSlice'
import sessionsReducer from './sessionsSlice'
import settingsReducer from './settingsSlice'
import codingCliReducer from './codingCliSlice'
import panesReducer from './panesSlice'
import sessionActivityReducer from './sessionActivitySlice'
import terminalActivityReducer from './terminalActivitySlice'
import idleWarningsReducer from './idleWarningsSlice'
import { collectPaneIdsSafe } from '@/lib/pane-utils'
import { perfMiddleware } from './perfMiddleware'
import { persistMiddleware } from './persistMiddleware'
import { sessionActivityPersistMiddleware } from './sessionActivityPersistence'
import { createPaneCleanupListenerMiddleware } from './paneCleanupListeners'

enableMapSet()

const paneCleanupListenerMiddleware = createPaneCleanupListenerMiddleware()

export const store = configureStore({
  reducer: {
    tabs: tabsReducer,
    connection: connectionReducer,
    sessions: sessionsReducer,
    settings: settingsReducer,
    codingCli: codingCliReducer,
    panes: panesReducer,
    sessionActivity: sessionActivityReducer,
    terminalActivity: terminalActivityReducer,
    idleWarnings: idleWarningsReducer,
  },
  middleware: (getDefault) =>
    getDefault({
      serializableCheck: {
        ignoredPaths: ['sessions.expandedProjects'],
      },
    }).concat(
      paneCleanupListenerMiddleware.middleware,
      perfMiddleware,
      persistMiddleware,
      sessionActivityPersistMiddleware,
    ),
})

// Note: Tabs and Panes are now loaded from localStorage directly in their slice
// initial states (see tabsSlice.ts and panesSlice.ts). This ensures the state
// is available BEFORE the store is created, preventing any race conditions.
//
// The hydration code below is kept for backward compatibility and logging,
// but the slices already have the persisted data by this point.

if (import.meta.env.MODE === 'development') {
  const deferLog =
    typeof queueMicrotask === 'function'
      ? queueMicrotask
      : (fn: () => void) => setTimeout(fn, 0)

  deferLog(() => {
    console.log('[Store] Initial state loaded from localStorage:')
    console.log('[Store] Tab IDs:', store.getState().tabs.tabs.map((t) => t.id))
    console.log('[Store] Pane layout keys:', Object.keys(store.getState().panes.layouts))

    // Verify tabs and panes match.
    const tabIds = new Set(store.getState().tabs.tabs.map((t) => t.id))
    const paneTabIds = Object.keys(store.getState().panes.layouts)
    const orphanedPanes = paneTabIds.filter((id) => !tabIds.has(id))
    if (orphanedPanes.length > 0) {
      console.warn('[Store] Found pane layouts for non-existent tabs:', orphanedPanes)
    }

    const panesState = store.getState().panes
    for (const [tabId, paneId] of Object.entries(panesState.activePane)) {
      const layout = panesState.layouts[tabId]
      if (!layout) {
        console.warn('[Store] activePane references missing layout:', { tabId, paneId })
        continue
      }
      const leafIds = collectPaneIdsSafe(layout)
      if (leafIds.length > 0 && !leafIds.includes(paneId)) {
        console.warn('[Store] activePane references missing pane leaf:', { tabId, paneId })
      }
    }

    const missingLayouts = store.getState().tabs.tabs
      .map((t) => t.id)
      .filter((id) => !(id in panesState.layouts))
    if (missingLayouts.length > 0) {
      console.warn('[Store] Found tabs without pane layouts:', missingLayouts)
    }
  })
}

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
