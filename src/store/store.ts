import { enableMapSet } from 'immer'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from './tabsSlice'
import connectionReducer from './connectionSlice'
import sessionsReducer from './sessionsSlice'
import settingsReducer from './settingsSlice'
import panesReducer from './panesSlice'
import sessionActivityReducer from './sessionActivitySlice'
import terminalDirectoryReducer from './terminalDirectorySlice'
import tabRecencyReducer from './tabRecencySlice'

import turnCompletionReducer from './turnCompletionSlice'
import terminalLifecycleReducer from './terminalLifecycleSlice'
import terminalMetaReducer from './terminalMetaSlice'
import repoIconsReducer from './repoIconsSlice'
import codexActivityReducer from './codexActivitySlice'
import claudeActivityReducer from './claudeActivitySlice'
import amplifierActivityReducer from './amplifierActivitySlice'
import opencodeActivityReducer from './opencodeActivitySlice'
import freshAgentReducer from './freshAgentSlice'
import paneRuntimeActivityReducer from './paneRuntimeActivitySlice'
import hostStatsReducer from './hostStatsSlice'
import { networkReducer } from './networkSlice'
import tabRegistryReducer from './tabRegistrySlice'
import extensionsReducer from './extensionsSlice'
import deckReducer from './deckSlice'
import { perfMiddleware } from './perfMiddleware'
import { persistMiddleware } from './persistMiddleware'
import { sessionActivityPersistMiddleware } from './sessionActivityPersistence'
import { browserPreferencesPersistenceMiddleware } from './browserPreferencesPersistence'
import { createLogger } from '@/lib/client-logger'
import { layoutMirrorMiddleware } from './layoutMirrorMiddleware'
import { subagentInterestMiddleware } from './subagentInterestMiddleware'
import { terminalDetachMiddleware } from './terminalDetachMiddleware'
import { serverSettingsSaveStateMiddleware } from './settingsThunks'
import { tabFallbackIdentityMiddleware } from './tabFallbackIdentityMiddleware'
import {
  pruneTabRecencyToCurrentLayout,
  tabRecencyPruneMiddleware,
} from './tabRecencyPruneMiddleware'

enableMapSet()

const log = createLogger('Store')

export const store = configureStore({
  reducer: {
    tabs: tabsReducer,
    connection: connectionReducer,
    sessions: sessionsReducer,
    settings: settingsReducer,
    panes: panesReducer,
    sessionActivity: sessionActivityReducer,
    terminalDirectory: terminalDirectoryReducer,
    tabRecency: tabRecencyReducer,

    turnCompletion: turnCompletionReducer,
    // Ephemeral crash/auto-resume presentation state — never persisted
    // (persistence is an allowlist in persistMiddleware; do not add this).
    terminalLifecycle: terminalLifecycleReducer,
    terminalMeta: terminalMetaReducer,
    repoIcons: repoIconsReducer,
    codexActivity: codexActivityReducer,
    claudeActivity: claudeActivityReducer,
    amplifierActivity: amplifierActivityReducer,
    opencodeActivity: opencodeActivityReducer,
    freshAgent: freshAgentReducer,
    paneRuntimeActivity: paneRuntimeActivityReducer,
    // Ephemeral live host metrics — never persisted (allowlist rule)
    hostStats: hostStatsReducer,
    network: networkReducer,
    tabRegistry: tabRegistryReducer,
    extensions: extensionsReducer,
    // Ephemeral device state — never persisted (allowlist rule)
    deck: deckReducer,
  },
  middleware: (getDefault) =>
    getDefault({
      serializableCheck: {
        ignoredPaths: ['sessions.expandedProjects'],
      },
    }).concat(
      perfMiddleware,
      tabFallbackIdentityMiddleware,
      tabRecencyPruneMiddleware,
      persistMiddleware,
      serverSettingsSaveStateMiddleware,
      browserPreferencesPersistenceMiddleware,
      layoutMirrorMiddleware,
      subagentInterestMiddleware,
      terminalDetachMiddleware,
      sessionActivityPersistMiddleware,
    ),
})

pruneTabRecencyToCurrentLayout(store)

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
export type AppStore = typeof store
