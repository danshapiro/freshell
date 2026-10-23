// The app's root reducer map: one place that names every slice the store
// holds, so tests can build a store with the app's exact state shape (and
// therefore the exact selector inputs every component sees) without the
// production store's module-level side effects.
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
import freshAgentLiveReducer from './freshAgentLiveSlice'
import paneRuntimeActivityReducer from './paneRuntimeActivitySlice'
import hostStatsReducer from './hostStatsSlice'
import { networkReducer } from './networkSlice'
import tabRegistryReducer from './tabRegistrySlice'
import machineIdentityReducer from './machineIdentitySlice'
import extensionsReducer from './extensionsSlice'
import deckReducer from './deckSlice'
import sessionNamesReducer from './sessionNamesSlice'
import managedRuntimeReducer from './managedRuntimeSlice'

export const appReducers = {
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
  // The live tail of running turns (streamed blocks, retries, notices): its
  // own root key so token-rate updates never touch freshAgent.sessions.
  // Ephemeral — never persisted (allowlist rule).
  freshAgentLive: freshAgentLiveReducer,
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
}
