// Storage migration MUST be imported first (before slices load from localStorage)
import './storage-migration'

import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from './tabsSlice'
import connectionReducer from './connectionSlice'
import sessionsReducer from './sessionsSlice'
import settingsReducer from './settingsSlice'
import codingCliReducer from './codingCliSlice'
import panesReducer from './panesSlice'
import sessionActivityReducer from './sessionActivitySlice'
import terminalActivityReducer from './terminalActivitySlice'
import { perfMiddleware } from './perfMiddleware'
import { persistMiddleware } from './persistMiddleware'
import { sessionActivityPersistMiddleware } from './sessionActivityPersistence'

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
  },
  middleware: (getDefault) =>
    getDefault({
      serializableCheck: {
        ignoredPaths: ['sessions.expandedProjects'],
      },
    }).concat(perfMiddleware, persistMiddleware, sessionActivityPersistMiddleware),
})

// Note: Tabs and Panes are now loaded from localStorage directly in their slice
// initial states (see tabsSlice.ts and panesSlice.ts). This ensures the state
// is available BEFORE the store is created, preventing any race conditions.
//
// The hydration code below is kept for backward compatibility and logging,
// but the slices already have the persisted data by this point.

const deferLog = typeof queueMicrotask === 'function'
  ? queueMicrotask
  : (fn: () => void) => setTimeout(fn, 0)

deferLog(() => {
  console.log('[Store] Initial state loaded from localStorage:')
  console.log('[Store] Tab IDs:', store.getState().tabs.tabs.map(t => t.id))
  console.log('[Store] Pane layout keys:', Object.keys(store.getState().panes.layouts))

  // Verify tabs and panes match
  const tabIds = new Set(store.getState().tabs.tabs.map(t => t.id))
  const paneTabIds = Object.keys(store.getState().panes.layouts)
  const orphanedPanes = paneTabIds.filter(id => !tabIds.has(id))
  if (orphanedPanes.length > 0) {
    console.warn('[Store] Found pane layouts for non-existent tabs:', orphanedPanes)
  }
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
