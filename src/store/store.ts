import { enableMapSet } from 'immer'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from './tabsSlice'
import connectionReducer from './connectionSlice'
import sessionsReducer from './sessionsSlice'
import settingsReducer from './settingsSlice'
import codingCliReducer from './codingCliSlice'
import panesReducer from './panesSlice'
import sessionActivityReducer from './sessionActivitySlice'
import terminalActivityReducer from './terminalActivitySlice'

import turnCompletionReducer from './turnCompletionSlice'
import terminalMetaReducer from './terminalMetaSlice'
import claudeChatReducer from './claudeChatSlice'
import { networkReducer } from './networkSlice'
import tabRegistryReducer from './tabRegistrySlice'
import { perfMiddleware } from './perfMiddleware'
import { persistMiddleware } from './persistMiddleware'
import { sessionActivityPersistMiddleware } from './sessionActivityPersistence'
import { createLogger } from '@/lib/client-logger'
import { layoutMirrorMiddleware } from './layoutMirrorMiddleware'

enableMapSet()

const log = createLogger('Store')

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

    turnCompletion: turnCompletionReducer,
    terminalMeta: terminalMetaReducer,
    claudeChat: claudeChatReducer,
    network: networkReducer,
    tabRegistry: tabRegistryReducer,
  },
  middleware: (getDefault) =>
    getDefault({
      serializableCheck: {
        ignoredPaths: ['sessions.expandedProjects'],
      },
    }).concat(perfMiddleware, persistMiddleware, layoutMirrorMiddleware, sessionActivityPersistMiddleware),
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
  log.debug('Initial state loaded from localStorage:')
  log.debug('Tab IDs:', store.getState().tabs.tabs.map(t => t.id))
  log.debug('Pane layout keys:', Object.keys(store.getState().panes.layouts))

  // Verify tabs and panes match
  const tabIds = new Set(store.getState().tabs.tabs.map(t => t.id))
  const paneTabIds = Object.keys(store.getState().panes.layouts)
  const orphanedPanes = paneTabIds.filter(id => !tabIds.has(id))
  if (orphanedPanes.length > 0) {
    log.warn('Found pane layouts for non-existent tabs:', orphanedPanes)
  }
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
