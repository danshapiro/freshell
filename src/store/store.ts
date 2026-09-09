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
import machineIdentityReducer from './machineIdentitySlice'
import extensionsReducer from './extensionsSlice'
import deckReducer from './deckSlice'
import sessionNamesReducer from './sessionNamesSlice'
import managedRuntimeReducer from './managedRuntimeSlice'
import { perfMiddleware } from './perfMiddleware'
import { persistMiddleware } from './persistMiddleware'
import { sessionActivityPersistMiddleware } from './sessionActivityPersistence'
import { browserPreferencesPersistenceMiddleware } from './browserPreferencesPersistence'
import { createLogger } from '@/lib/client-logger'
import { layoutMirrorMiddleware } from './layoutMirrorMiddleware'
import { sessionTitleMirrorMiddleware } from './sessionTitleMirror'
import { terminalInventoryTitleReplayMiddleware } from '@/lib/terminal-inventory-titles'
import { sessionNamesIngestMiddleware } from './sessionNamesSlice'
import { sessionNameLifecycleMiddleware } from './sessionNameLifecycleMiddleware'
import {
  collectLegacyPendingHandleAssignments,
  registerLegacyNameSubmitGate,
  submitPendingLegacyNameImports,
} from '@/lib/session-name-migration'
import { stampLegacyMigrationHandles } from './panesSlice'
import { subagentInterestMiddleware } from './subagentInterestMiddleware'
import { terminalDetachMiddleware } from './terminalDetachMiddleware'
import { serverSettingsSaveStateMiddleware } from './settingsThunks'
import { tabFallbackIdentityMiddleware } from './tabFallbackIdentityMiddleware'
import {
  pruneTabRecencyToCurrentLayout,
  tabRecencyPruneMiddleware,
} from './tabRecencyPruneMiddleware'
import {
  wirePaneFocusOwnershipInvalidation,
  paneSelectionMiddleware,
} from '@/lib/pane-focus-ownership'
import { turnCompletionReceiptMiddleware } from './turnCompletionReceipt'

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
    // Server-owned workspace selection. This state gates renderer mounts and
    // all tab-registry transport until a machine has been resolved.
    machineIdentity: machineIdentityReducer,
    extensions: extensionsReducer,
    // Ephemeral device state — never persisted (allowlist rule)
    deck: deckReducer,
    // Unified agent names (Task 5): the revisioned canonical-name cache —
    // last-known server projections only, rebuilt from bootstrap/pushes.
    // Never persisted (allowlist rule).
    sessionNames: sessionNamesReducer,
    // Authoritative managed-runtime projection — reconstructed from the
    // supervisor on every connection and deliberately never persisted.
    managedRuntime: managedRuntimeReducer,
  },
  middleware: (getDefault) =>
    getDefault({
      serializableCheck: {
        ignoredPaths: ['sessions.expandedProjects'],
      },
    }).concat(
      paneSelectionMiddleware,
      // DR5-3: stamp the watched witness bit at event-RECEIPT (the dispatch
      // that queues a turn-completion/terminal-idle event), so the
      // notification hook consumes the receipt-time classification instead
      // of recomputing at drain time.
      turnCompletionReceiptMiddleware,
      perfMiddleware,
      tabFallbackIdentityMiddleware,
      tabRecencyPruneMiddleware,
      persistMiddleware,
      serverSettingsSaveStateMiddleware,
      browserPreferencesPersistenceMiddleware,
      layoutMirrorMiddleware,
      sessionTitleMirrorMiddleware,
      terminalInventoryTitleReplayMiddleware,
      sessionNamesIngestMiddleware,
      subagentInterestMiddleware,
      terminalDetachMiddleware,
      sessionActivityPersistMiddleware,
      // Unified agent names (Task 6): the source-pointer coordinator sits
      // INNER to the persistence/mirror subscribers — its post-`next`
      // reconciliation runs before either subscriber reads state, and its
      // own follow-up dispatches flow back through the whole chain, so
      // every persisted envelope and ui.layout.sync payload carries the
      // already-reconciled pointer.
      sessionNameLifecycleMiddleware,
    ),
})

pruneTabRecencyToCurrentLayout(store)

// Pane focus-ownership memory: explicit selections (activePane value changes
// and epoch nudges) advance the restore-guard serial; ownership records are
// forgotten the moment their pane id RE-APPEARS in any layout (a reopened
// tab's preserved leaf ids), so reopening a closed tab never reads a stale
// close-time record. Removal-time records intentionally linger (LRU-bounded)
// because React's teardown re-record lands after the store update.
wirePaneFocusOwnershipInvalidation(store)

// Unified agent names (Task 7): the client side of the one-time legacy-name
// consolidation.
//
// (1) Stamp the derived legacy-pending naming handles onto the hydrated
//     panes they were derived from (the capture already ran — the migration
//     module is imported first in main.tsx — so the assignments are
//     available without re-reading any source). Idempotent per pane.
// (2) Submit the still-pending captured imports ONCE per server
//     connection-ready edge: the server acknowledges candidates one at a
//     time (repeated submits are idempotent), acknowledged evidence is
//     retained for recovery, and a failed submit stays pending for the
//     next ready edge.
try {
  const assignments = collectLegacyPendingHandleAssignments()
  if (assignments.length > 0) {
    store.dispatch(stampLegacyMigrationHandles(assignments))
  }
} catch (error) {
  log.error('failed to stamp legacy migration naming handles', { error })
}
wireLegacyNameImportSubmission(store)

function wireLegacyNameImportSubmission(appStore: typeof store): void {
  let submitting = false
  let wasReady = false
  // The readiness gate for mid-session captures (crossTabSync deliveries):
  // a capture while ready submits immediately; otherwise it waits for the
  // next ready edge below.
  registerLegacyNameSubmitGate(() => appStore.getState().connection?.status === 'ready')
  appStore.subscribe(() => {
    // Fire on TRANSITIONS to ready only — the server's per-candidate
    // acknowledgments make repeated submits idempotent, but a per-dispatch
    // resubmit would enumerate the captured evidence on every state change.
    const nowReady = appStore.getState().connection?.status === 'ready'
    const becameReady = nowReady && !wasReady
    wasReady = nowReady
    if (!becameReady || submitting) return
    submitting = true
    void submitPendingLegacyNameImports()
      .catch((error) => {
        log.error('legacy-name import submission failed; retrying on the next ready edge', { error })
      })
      .finally(() => {
        submitting = false
      })
  })
}

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
