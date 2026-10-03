import { createSlice, PayloadAction, createAsyncThunk } from '@reduxjs/toolkit'
import type { Tab, TerminalStatus, TabMode, ShellType, CodingCliProviderName } from './types'
import type {
  ManagedRuntimeInventorySnapshot,
  ManagedRuntimeProjectionFields,
  ManagedRuntimeSoul,
  ManagedRuntimeViewIntent,
  ManagedRuntimeViewVisibility,
} from '@shared/managed-runtime'
import { nanoid } from 'nanoid'
import { closePane, initLayout, restoreLayout, removeLayout, replacePane, setPaneCloseError, updatePaneContent, updatePaneTitleByTerminalId, updatePaneTitle, markTabClosing, clearTabClosing, markPaneClosing, clearPaneClosing, hasAnyClosePending } from './panesSlice'
import { clearTabAttention, clearPaneAttention } from './turnCompletionSlice.js'
import { updateSessionActivity } from './sessionActivitySlice'
import type { PaneContent, PaneNode } from './paneTypes'
import { findTabIdForSession, collectSessionRefsFromTabs, liveTerminalRowIdentity } from '@/lib/session-utils'
import { getProviderLabel } from '@/lib/coding-cli-utils'
import { basenameSegment } from '@shared/path-basename'
import { buildResumeContent } from '@/lib/session-type-utils'
import { getFreshAgentProviderConfig, getFreshAgentProviderLabel } from '@/lib/fresh-agent-provider-utils'
import { resolveFreshAgentType } from '@/lib/fresh-agent-registry'
import { recordClosedTabSnapshot, pushReopenEntry, consumeClosedEntry } from './tabRegistrySlice'
import { clearDraft } from '@/lib/draft-store'
import {
  buildClosedTabRegistryRecord,
  countPaneLeaves,
  shouldKeepClosedTab,
} from '@/lib/tab-registry-snapshot'
import { UNKNOWN_SERVER_INSTANCE_ID } from './tabRegistryConstants'
import { KILL_ACK_TIMEOUT_MS, PANE_CLOSE_ACK_TIMEOUT_MESSAGE, PANE_CLOSE_FAILED_MESSAGE, PANE_CLOSE_REMOVAL_REFUSED_MESSAGE, sendPaneClosedAndAwait, sendPaneOpened, sendPanesClosedAndAwait } from '@/lib/kill-ack'
import { collectSessionPaneIdentities, collectPaneContents, collectPaneEntries, findPaneContent } from '@/lib/pane-utils'
import { markPaneCloseEvidenceConfirmed } from '@/lib/pane-close-evidence-marks'
import type { RootState } from './store'
import { selectTabIdByTerminalId } from './selectors/paneTerminalSelectors'
import { loadPersistedLayout, markTabsLoadRecovery } from './persistMiddleware'
import { createLogger } from '@/lib/client-logger'
import { getManagedRuntimeSoul, updateManagedRuntimeViewVisibility } from '@/lib/api'
import { mergeSessionMetadataByKey, sessionMetadataKey } from '@/lib/session-metadata'
import {
  clearLocalClosePersistencePending,
  flushPersistedLayoutNow,
  isLocalClosePersistencePending,
  markLocalClosePersistencePending,
  mergeSessionMetadataForPreferredResumeId,
} from './persistControl'
import { migrateLegacyTerminalDurableState, sanitizeSessionRef } from '@shared/session-contract'
import { sanitizeTabsAgainstLayouts } from '@/lib/tab-fallback-identity'
import { TabNameSourceSchema, type TabNameSource } from '@shared/session-names'
import { getManagedRuntimeInventory, updateManagedRuntimeViewVisibility } from '@/lib/api'
import { managedRuntimeSnapshotReceived, selectManagedRuntime } from './managedRuntimeSlice'
import { withManagedVisibilityTransition } from './managedVisibilityCoordinator.js'


const log = createLogger('TabsSlice')
const MANAGED_VIEW_CLOSE_FAILED_MESSAGE =
  'the managed view could not be detached from recovery; the tab was left open'

export type Tombstone = { id: string; deletedAt: number }

function matchesDesiredResumeContentKind(
  content: PaneContent,
  desiredResumeContent: ReturnType<typeof buildResumeContent>,
): boolean {
  if (desiredResumeContent.kind === 'fresh-agent') {
    return content.kind === 'fresh-agent'
      && content.sessionType === desiredResumeContent.sessionType
      && content.provider === desiredResumeContent.provider
  }

  return content.kind === 'terminal' && content.mode === desiredResumeContent.mode
}

export interface TabsState {
  tabs: Tab[]
  activeTabId: string | null
  // Ephemeral UI signal: request TabBar to enter inline rename mode for a tab.
  // This must never be persisted.
  renameRequestTabId: string | null
  // IDs of tabs that were explicitly closed. Prevents resurrection during cross-tab merge.
  tombstones: Tombstone[]
}

type HydrateTabsMeta = {
  localLayoutPersistedAt?: number
  remoteLayoutPersistedAt?: number
}

function normalizePersistedTerminalStatus(status: unknown): TerminalStatus {
  if (
    status === 'running'
    || status === 'recovering'
    || status === 'exited'
    || status === 'error'
    || status === 'creating'
  ) {
    return status
  }
  return 'creating'
}

function sanitizeTabNameSource(value: unknown): TabNameSource | undefined {
  return TabNameSourceSchema.safeParse(value).success ? value as TabNameSource : undefined
}

function migrateTabFields(t: Tab): Tab {
  const legacyCodingCliSessionId = typeof (t as any).codingCliSessionId === 'string'
    ? (t as any).codingCliSessionId
    : undefined
  const legacyClaudeSessionId = typeof (t as any).claudeSessionId === 'string'
    ? (t as any).claudeSessionId
    : undefined
  // Strip legacy terminalId field from persisted data
  const {
    terminalId: _legacyTerminalId,
    codingCliSessionId: _legacyCodingCliSessionId,
    claudeSessionId: _legacyClaudeSessionId,
    ...rest
  } = t as Tab & { terminalId?: unknown; codingCliSessionId?: unknown; claudeSessionId?: unknown }
  const codingCliProvider = t.codingCliProvider || (legacyClaudeSessionId ? 'claude' : undefined)
  const provider = codingCliProvider || (t.mode !== 'shell' ? t.mode : undefined)
  const durableState = migrateLegacyTerminalDurableState({
    provider,
    sessionRef: (t as any).sessionRef,
    resumeSessionId: t.resumeSessionId || legacyCodingCliSessionId || legacyClaudeSessionId,
  })
  return {
    ...rest,
    codingCliProvider,
    createdAt: t.createdAt || Date.now(),
    createRequestId: (t as any).createRequestId || t.id,
    status: normalizePersistedTerminalStatus(t.status),
    mode: t.mode || 'shell',
    shell: t.shell || 'system',
    sessionRef: durableState.sessionRef,
    resumeSessionId: undefined,
    lastInputAt: t.lastInputAt,
    // Unified agent names (Task 6): a persisted pointer survives the
    // migration; a malformed one drops instead of entering tab state.
    nameSource: sanitizeTabNameSource((rest as { nameSource?: unknown }).nameSource),
  }
}

function pickHydratedTabWinner(localTab: Tab, remoteTab: Tab, meta: HydrateTabsMeta | undefined): Tab {
  const localLayoutPersistedAt = meta?.localLayoutPersistedAt
  const remoteLayoutPersistedAt = meta?.remoteLayoutPersistedAt
  if (typeof localLayoutPersistedAt === 'number' || typeof remoteLayoutPersistedAt === 'number') {
    if ((remoteLayoutPersistedAt ?? Number.NEGATIVE_INFINITY) > (localLayoutPersistedAt ?? Number.NEGATIVE_INFINITY)) {
      return remoteTab
    }
    if ((remoteLayoutPersistedAt ?? Number.NEGATIVE_INFINITY) < (localLayoutPersistedAt ?? Number.NEGATIVE_INFINITY)) {
      return localTab
    }
  }

  return (localTab.updatedAt ?? 0) > (remoteTab.updatedAt ?? 0) ? localTab : remoteTab
}

/**
 * A user-set tab name (an explicit rename) must survive a cross-device merge
 * even when the other device's tab is more recent: user always wins, otherwise
 * the recency winner's title stands. Auto names (dir / first-message / Gemini)
 * are reconciled server-side via the session override, so the client only needs
 * to keep an explicit rename sticky here.
 */
function reconcileHydratedTabTitle(localTab: Tab, remoteTab: Tab, winner: Tab): Tab {
  if (winner.titleSetByUser) return winner
  const userSide = localTab.titleSetByUser ? localTab : remoteTab.titleSetByUser ? remoteTab : null
  if (!userSide) return winner
  return { ...winner, title: userSide.title, titleSetByUser: true }
}

/**
 * Unified agent names (Task 6): an old mirror without `nameSource` cannot
 * erase an initialized pointer. A pointer, once resolved, is never reset to
 * undefined — so when the recency winner's tab record predates the field,
 * the merged tab keeps whichever side still carries the relationship
 * (hydration accepts the RELATIONSHIP, never a name write).
 */
function preserveHydratedTabNameSource(localTab: Tab, remoteTab: Tab, winner: Tab): Tab {
  if (winner.nameSource) return winner
  const carried = localTab.nameSource ?? remoteTab.nameSource
  return carried ? { ...winner, nameSource: carried } : winner
}

function deriveTabSessionRef(tab: Tab) {
  const explicitSessionRef = sanitizeSessionRef(tab.sessionRef)
  if (explicitSessionRef) return explicitSessionRef

  return migrateLegacyTerminalDurableState({
    provider: tab.codingCliProvider || (tab.mode !== 'shell' ? tab.mode : undefined),
    sessionRef: tab.sessionRef,
    resumeSessionId: tab.resumeSessionId,
  }).sessionRef
}

function protectCanonicalFallbackIdentity(localTab: Tab, remoteTab: Tab, mergedTab: Tab): Tab {
  const localSessionRef = deriveTabSessionRef(localTab)
  const remoteSessionRef = deriveTabSessionRef(remoteTab)
  const mergedSessionRef = deriveTabSessionRef(mergedTab)
  const preferredSessionRef = localSessionRef ?? remoteSessionRef ?? mergedSessionRef

  let nextTab = mergedTab
  if (
    preferredSessionRef
    && (
      nextTab.sessionRef?.provider !== preferredSessionRef.provider
      || nextTab.sessionRef?.sessionId !== preferredSessionRef.sessionId
    )
  ) {
    nextTab = {
      ...nextTab,
      sessionRef: preferredSessionRef,
      resumeSessionId: undefined,
    }
  }

  const metadataProvider =
    nextTab.sessionRef?.provider
    ?? remoteSessionRef?.provider
    ?? localSessionRef?.provider
    ?? nextTab.codingCliProvider
    ?? remoteTab.codingCliProvider
    ?? localTab.codingCliProvider
    ?? (nextTab.mode !== 'shell' ? nextTab.mode : undefined)

  if (metadataProvider && nextTab.codingCliProvider !== metadataProvider) {
    nextTab = {
      ...nextTab,
      codingCliProvider: metadataProvider,
    }
  }

  let nextSessionMetadataByKey = mergeSessionMetadataForPreferredResumeId({
    localSessionMetadataByKey: localTab.sessionMetadataByKey,
    remoteSessionMetadataByKey: remoteTab.sessionMetadataByKey,
    existingSessionMetadataByKey: nextTab.sessionMetadataByKey,
    provider: metadataProvider,
    localResumeSessionId: localSessionRef?.sessionId ?? localTab.resumeSessionId,
    remoteResumeSessionId: remoteSessionRef?.sessionId ?? remoteTab.resumeSessionId,
    preferredResumeSessionId: preferredSessionRef?.sessionId,
  })

  if (metadataProvider && preferredSessionRef && nextSessionMetadataByKey) {
    const preferredKey = sessionMetadataKey(metadataProvider, preferredSessionRef.sessionId)
    nextSessionMetadataByKey = nextSessionMetadataByKey[preferredKey]
      ? { [preferredKey]: nextSessionMetadataByKey[preferredKey] }
      : nextSessionMetadataByKey
  }

  if (JSON.stringify(nextSessionMetadataByKey ?? {}) !== JSON.stringify(nextTab.sessionMetadataByKey ?? {})) {
    nextTab = {
      ...nextTab,
      sessionMetadataByKey: nextSessionMetadataByKey,
    }
  }

  return nextTab
}

// Load persisted tabs state directly at module initialization time
// This ensures the initial state includes persisted data BEFORE the store is created
function loadInitialTabsState(): TabsState {
  const defaultState: TabsState = {
    tabs: [],
    activeTabId: null,
    renameRequestTabId: null,
    tombstones: [],
  }

  try {
    const layout = loadPersistedLayout()
    if (!layout) return defaultState

    const tabsState = layout.tabs?.tabs as Partial<TabsState> | undefined
    if (!Array.isArray(tabsState?.tabs)) {
      // The layout itself parsed, so something was genuinely persisted, but
      // its tabs shape is unusable. Don't let a later flush treat the
      // resulting empty array as a real "user has no tabs" signal.
      markTabsLoadRecovery()
      return defaultState
    }

    const persistedAt = typeof layout.persistedAt === 'number' ? layout.persistedAt : undefined
    const ageMs = persistedAt ? Date.now() - persistedAt : undefined
    const ageHours = ageMs ? Math.round(ageMs / 3600000) : undefined
    if (ageHours !== undefined && ageHours > 24) {
      log.warn(`Restoring tab state from ${ageHours}h ago — may be stale (persistedAt: ${new Date(persistedAt!).toISOString()})`)
    }
    log.debug('Loaded initial state from localStorage:', tabsState.tabs.map((t: Tab) => t.id), persistedAt ? `(${ageHours}h old)` : '(no timestamp)')

    const mappedTabs = sanitizeTabsAgainstLayouts(
      tabsState.tabs.map(migrateTabFields),
      (layout.panes?.layouts || {}) as Record<string, PaneNode | undefined>,
    )
    if (tabsState.tabs.length > 0 && mappedTabs.length === 0) {
      // Every persisted tab was pruned (e.g. its pane layout was missing or
      // malformed). The persisted tabs were real; losing all of them during
      // sanitization is a recovery, not a genuine empty state.
      markTabsLoadRecovery()
    }
    const desired = tabsState.activeTabId
    const has = desired && mappedTabs.some((t: Tab) => t.id === desired)

    return {
      tabs: mappedTabs,
      activeTabId: has ? desired! : (mappedTabs[0]?.id ?? null),
      renameRequestTabId: null,
      tombstones: Array.isArray(layout.tombstones) ? layout.tombstones : [],
    }
  } catch (err) {
    log.error('Failed to load from localStorage:', err)
    markTabsLoadRecovery()
    return defaultState
  }
}

const initialState: TabsState = loadInitialTabsState()

type AddTabPayload = {
  id?: string
  title?: string
  description?: string
  codingCliProvider?: CodingCliProviderName
  status?: TerminalStatus
  mode?: TabMode
  shell?: ShellType
  initialCwd?: string
  sessionRef?: Tab['sessionRef']
  serverInstanceId?: string
  resumeSessionId?: string
  sessionMetadataByKey?: Tab['sessionMetadataByKey']
  forceNew?: boolean
  createRequestId?: string
  titleSetByUser?: boolean
  /**
   * Server-driven creates (ui.command tab.create) pass activate:false so an
   * agent/MCP action never steals the user's focus. Local creates omit the
   * flag and keep the historical auto-activation. Bootstrap exception: the
   * very first tab always becomes active — nothing else promotes it.
   */
  activate?: boolean
  /**
   * Unified agent names (Task 6): the new tab's stable naming-source
   * relationship. Copy/recovery dispatchers pass their explicitly remapped
   * pointer; ordinary creates leave it undefined for the lifecycle
   * middleware to resolve at the initial content choice.
   */
  nameSource?: TabNameSource
} & ManagedRuntimeProjectionFields

export const tabsSlice = createSlice({
  name: 'tabs',
  initialState,
  reducers: {
    addTab: (state, action: PayloadAction<AddTabPayload | undefined>) => {
      // Dedupe by session is handled in openSessionTab using pane state.
      const payload = action.payload || {}

      const id = payload.id || nanoid()
      // API tab.create delivery and the durable inventory projection can race
      // or be redelivered after reconnect. An explicit tab ID denotes one view,
      // not another request to append/activate it or overwrite user state.
      if (state.tabs.some((existing) => existing.id === id)) return
      const codingCliProvider = payload.codingCliProvider
      const sessionRef = sanitizeSessionRef(payload.sessionRef)
      const tab: Tab = {
        id,
        createRequestId: payload.createRequestId || id,
        title: payload.title || `Tab ${state.tabs.length + 1}`,
        description: payload.description,
        codingCliProvider,
        status: payload.status || 'creating',
        mode: payload.mode || 'shell',
        shell: payload.shell || 'system',
        initialCwd: payload.initialCwd,
        sessionRef,
        serverInstanceId: payload.serverInstanceId,
        resumeSessionId: undefined,
        sessionMetadataByKey: payload.sessionMetadataByKey,
        soulId: payload.soulId,
        incarnationId: payload.incarnationId,
        runtimeState: payload.runtimeState,
        viewIntentId: payload.viewIntentId,
        viewIntentRevision: payload.viewIntentRevision,
        soulIntentRevision: payload.soulIntentRevision,
        incidentId: payload.incidentId,
        placementGroup: payload.placementGroup,
        resourceSummary: payload.resourceSummary,
        recoverySummary: payload.recoverySummary,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        titleSetByUser: payload.titleSetByUser,
        lastInputAt: undefined,
        nameSource: payload.nameSource,
      }
      state.tabs.push(tab)
      if (payload.viewIntentId) {
        state.tombstones = (state.tombstones || []).filter((tombstone) => tombstone.id !== id)
      }
      if (payload.activate !== false || state.tabs.length === 1) {
        state.activeTabId = id
      }
    },
    setActiveTab: (state, action: PayloadAction<string>) => {
      state.activeTabId = action.payload
    },
    requestTabRename: (state, action: PayloadAction<string>) => {
      state.renameRequestTabId = action.payload
    },
    clearTabRenameRequest: (state) => {
      state.renameRequestTabId = null
    },
    updateTab: (state, action: PayloadAction<{ id: string; updates: Partial<Tab> }>) => {
      const tab = state.tabs.find((t) => t.id === action.payload.id)
      if (tab) {
        Object.assign(tab, action.payload.updates)
        tab.updatedAt = Date.now()
      }
    },
    removeTab: (state, action: PayloadAction<string>) => {
      const removedTabId = action.payload
      const removedIndex = state.tabs.findIndex((t) => t.id === removedTabId)
      const wasActive = state.activeTabId === removedTabId

      state.tabs = state.tabs.filter((t) => t.id !== removedTabId)
      if (!state.tombstones) state.tombstones = []
      state.tombstones.push({ id: removedTabId, deletedAt: Date.now() })

      if (wasActive) {
        if (state.tabs.length === 0) {
          state.activeTabId = null
          return
        }

        const nextIndex = removedIndex > 0 ? removedIndex - 1 : 0
        state.activeTabId = state.tabs[nextIndex]?.id ?? state.tabs[0].id
      }
    },
    /**
     * A server-confirmed machine switch replaces the local cache before tab
     * registry sync begins. This is deliberately not a user close: it must
     * not emit pane-close evidence for tabs owned by the previously selected
     * machine.
     */
    clearTabsForMachine: (state) => {
      state.tabs = []
      state.activeTabId = null
      state.renameRequestTabId = null
      state.tombstones = []
    },
    hydrateTabs: (state, action: PayloadAction<TabsState>) => {
      const meta = (action as PayloadAction<TabsState, string, HydrateTabsMeta | undefined>).meta
      const remoteTabs = (action.payload.tabs || []).map(migrateTabFields)
      const remoteTombstones: Tombstone[] = Array.isArray(action.payload.tombstones) ? action.payload.tombstones : []

      // Union tombstones from both sides, deduped by ID
      const tombstoneMap = new Map<string, number>()
      for (const t of (state.tombstones || [])) tombstoneMap.set(t.id, Math.max(tombstoneMap.get(t.id) ?? 0, t.deletedAt))
      for (const t of remoteTombstones) tombstoneMap.set(t.id, Math.max(tombstoneMap.get(t.id) ?? 0, t.deletedAt))
      state.tombstones = Array.from(tombstoneMap, ([id, deletedAt]) => ({ id, deletedAt }))

      const tombstoned = new Set(tombstoneMap.keys())
      const localById = new Map(state.tabs.map((t) => [t.id, t]))
      const remoteById = new Map(remoteTabs.map((t) => [t.id, t]))

      // Build merged list: remote order for shared tabs, then local-only tabs appended
      const merged: Tab[] = []
      const seen = new Set<string>()

      for (const remoteTab of remoteTabs) {
        if (tombstoned.has(remoteTab.id)) continue
        seen.add(remoteTab.id)
        const localTab = localById.get(remoteTab.id)
        if (localTab) {
          const winningTab = pickHydratedTabWinner(localTab, remoteTab, meta)
          const titledTab = reconcileHydratedTabTitle(localTab, remoteTab, winningTab)
          const sourcedTab = preserveHydratedTabNameSource(localTab, remoteTab, titledTab)
          merged.push(protectCanonicalFallbackIdentity(localTab, remoteTab, sourcedTab))
        } else {
          merged.push(remoteTab)
        }
      }

      // Append local-only tabs (not in remote, not tombstoned)
      for (const localTab of state.tabs) {
        if (seen.has(localTab.id) || tombstoned.has(localTab.id)) continue
        if (!remoteById.has(localTab.id)) {
          merged.push(localTab)
        }
      }

      state.tabs = merged

      // Prefer local activeTabId if it still exists in merged set
      const localActive = state.activeTabId
      const mergedIds = new Set(merged.map((t) => t.id))
      if (localActive && mergedIds.has(localActive)) {
        // keep local
      } else {
        const desired = action.payload.activeTabId
        state.activeTabId = (desired && mergedIds.has(desired)) ? desired : (merged[0]?.id ?? null)
      }

      state.renameRequestTabId = null
    },
    reorderTabs: (
      state,
      action: PayloadAction<{ fromIndex: number; toIndex: number }>
    ) => {
      const { fromIndex, toIndex } = action.payload
      if (fromIndex === toIndex) return
      const [removed] = state.tabs.splice(fromIndex, 1)
      state.tabs.splice(toIndex, 0, removed)
    },
    switchToNextTab: (state) => {
      if (state.tabs.length <= 1) return
      const currentIndex = state.tabs.findIndex((t) => t.id === state.activeTabId)
      const nextIndex = (currentIndex + 1) % state.tabs.length
      state.activeTabId = state.tabs[nextIndex].id
    },
    switchToPrevTab: (state) => {
      if (state.tabs.length <= 1) return
      const currentIndex = state.tabs.findIndex((t) => t.id === state.activeTabId)
      const prevIndex = (currentIndex - 1 + state.tabs.length) % state.tabs.length
      state.activeTabId = state.tabs[prevIndex].id
    },
    /**
     * Unified agent names (Task 6): set one tab's stable naming-source
     * relationship. The lifecycle middleware drives this from actual layout
     * transitions; copy/recovery dispatchers pass their explicitly remapped
     * pointer. A tab stores the RELATIONSHIP, never a second name.
     */
    setTabNameSource: (
      state,
      action: PayloadAction<{ tabId: string; nameSource: TabNameSource }>,
    ) => {
      const tab = state.tabs.find((t) => t.id === action.payload.tabId)
      if (!tab) {
        log.warn('setTabNameSource targeted a missing tab', { tabId: action.payload.tabId })
        return
      }
      tab.nameSource = action.payload.nameSource
    },
  },
})

export const {
  addTab,
  setActiveTab,
  requestTabRename,
  clearTabRenameRequest,
  updateTab,
  removeTab,
  clearTabsForMachine,
  hydrateTabs,
  reorderTabs,
  switchToNextTab,
  switchToPrevTab,
  setTabNameSource,
} = tabsSlice.actions

function collectPaneIds(node: PaneNode | undefined): string[] {
  if (!node) return []
  if (node.type === 'leaf') return [node.id]
  return [...collectPaneIds(node.children[0]), ...collectPaneIds(node.children[1])]
}

type FrozenManagedViewProjection = {
  paneId: string
  createRequestId?: string
  soulId?: string
  viewId: string
  viewRevision: number
  soulRevision: number
}

type ManagedViewCloseProjection = FrozenManagedViewProjection & {
  canRepair: () => boolean
  allowOlderRepairs: () => void
}

// Close ownership is ephemeral and belongs to one Redux store. A retry takes
// its view only when it reaches the visibility transaction after evidence.
const managedViewCloseOwners = new WeakMap<() => unknown, Map<string, { failed: boolean }>>()

function ownManagedViewProjection(
  projection: FrozenManagedViewProjection,
  tabId: string,
  getState: () => unknown,
): ManagedViewCloseProjection {
  let owners = managedViewCloseOwners.get(getState)
  if (!owners) {
    owners = new Map()
    managedViewCloseOwners.set(getState, owners)
  }
  const owner = { failed: false }
  owners.set(projection.viewId, owner)
  return {
    ...projection,
    canRepair: () => {
      const state = getState() as RootState
      const layout = state.panes.layouts[tabId]
      const content = layout ? findPaneContent(layout, projection.paneId) : undefined
      if (
        !content || (content.kind !== 'terminal' && content.kind !== 'fresh-agent')
        || content.createRequestId !== projection.createRequestId
        || content.viewIntentId !== projection.viewId || content.soulId !== projection.soulId
      ) return false
      // A newer pending visibility transaction decides visibility. If it
      // fails and keeps the pane, older late outcomes can repair it again.
      const latest = owners.get(projection.viewId)
      return latest === owner || latest?.failed === true
    },
    allowOlderRepairs: () => { owner.failed = true },
  }
}

class ManagedViewRepairSupersededError extends Error {}

export const MANAGED_VIEW_DETACH_TIMEOUT_MS = KILL_ACK_TIMEOUT_MS
/**
 * Keep the original timed-out PATCH observed for one additional bounded
 * window. A late result after this point is still handled, but the client has
 * already recorded that it could not establish the outcome in time.
 */
export const MANAGED_VIEW_LATE_SETTLEMENT_GRACE_MS = KILL_ACK_TIMEOUT_MS * 2

class ManagedRuntimeRequestTimeoutError extends Error {
  constructor(operation: string) {
    super(`${operation} timed out`)
    this.name = 'ManagedRuntimeRequestTimeoutError'
  }
}

function isManagedRuntimeRequestTimeout(error: unknown): error is ManagedRuntimeRequestTimeoutError {
  return error instanceof ManagedRuntimeRequestTimeoutError
}

type ManagedRuntimeRequestOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown }

type ManagedRuntimeRequestHooks<T> = {
  onTimeout?: () => void
  onGraceExpired?: () => void
  onLateSettlement?: (outcome: ManagedRuntimeRequestOutcome<T>) => void | Promise<void>
}

function managedRuntimeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function logManagedRuntimeLateSettlementFailure(
  operation: string,
  error: unknown,
) {
  log.error('managed runtime late-settlement repair failed', {
    event: 'managed_view_visibility_late_settlement_repair_failed',
    operation,
    error: managedRuntimeErrorMessage(error),
  })
}

function logManagedRuntimeUncertainOutcome(
  projection: ManagedViewCloseProjection,
  operation: 'detach' | 'rollback',
  phase: string,
  error?: unknown,
) {
  if (!projection.canRepair()) return
  log.error('managed view visibility outcome is uncertain', {
    event: 'managed_view_visibility_uncertain_outcome',
    operation,
    phase,
    paneId: projection.paneId,
    soulId: projection.soulId,
    viewId: projection.viewId,
    ...(error ? { error: managedRuntimeErrorMessage(error) } : {}),
  })
}

/**
 * Keep managed-runtime close work bounded while still attaching a rejection
 * handler to the original request. The server may commit a PATCH after the
 * client-side wait expires, so the original request must remain observable
 * through the reconciliation window instead of being aborted at the timeout.
 * `onLateSettlement` is deliberately separate from the bounded promise: a
 * timeout settles the close gate, while the original request remains observed
 * until it resolves or rejects.
 */
function awaitBoundedManagedRuntimeRequest<T>(
  operation: string,
  request: (signal: AbortSignal) => Promise<T>,
  hooks: ManagedRuntimeRequestHooks<T> = {},
): Promise<T> {
  const controller = new AbortController()
  return new Promise((resolve, reject) => {
    let settled = false
    let timedOut = false
    let lateSettled = false
    let lateGraceTimer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      timedOut = true
      settled = true
      lateGraceTimer = setTimeout(() => {
        if (lateSettled) return
        try {
          hooks.onGraceExpired?.()
        } catch (error) {
          logManagedRuntimeLateSettlementFailure(`${operation} grace-expired handler`, error)
        }
      }, MANAGED_VIEW_LATE_SETTLEMENT_GRACE_MS)
      try {
        hooks.onTimeout?.()
      } catch (error) {
        logManagedRuntimeLateSettlementFailure(`${operation} timeout handler`, error)
      }
      reject(new ManagedRuntimeRequestTimeoutError(operation))
    }, MANAGED_VIEW_DETACH_TIMEOUT_MS)

    const handleLateSettlement = (outcome: ManagedRuntimeRequestOutcome<T>) => {
      if (!timedOut) return
      lateSettled = true
      if (lateGraceTimer) clearTimeout(lateGraceTimer)
      if (!hooks.onLateSettlement) return
      try {
        void Promise.resolve(hooks.onLateSettlement(outcome)).catch((error) => {
          logManagedRuntimeLateSettlementFailure(operation, error)
        })
      } catch (error) {
        logManagedRuntimeLateSettlementFailure(operation, error)
      }
    }

    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback()
    }

    Promise.resolve()
      .then(() => request(controller.signal))
      .then(
        (view) => {
          if (timedOut) {
            handleLateSettlement({ ok: true, value: view })
            return
          }
          finish(() => resolve(view))
        },
        (error) => {
          if (timedOut) {
            handleLateSettlement({ ok: false, error })
            return
          }
          finish(() => reject(error))
        },
      )
  })
}

function updateManagedViewVisibilityWithSignal(
  viewId: string,
  visibility: 'visible' | 'detached',
  expectedRevision: number,
  expectedSoulIntentRevision: number,
  signal: AbortSignal,
): Promise<ManagedRuntimeViewIntent> {
  return updateManagedRuntimeViewVisibility(
    viewId,
    visibility,
    expectedRevision,
    expectedSoulIntentRevision,
    undefined,
    { signal },
  )
}

function updateManagedViewRepairWithSignal(
  projection: ManagedViewCloseProjection,
  fence: ManagedViewRepairFence,
  signal: AbortSignal,
): Promise<ManagedRuntimeViewIntent> {
  // The bounded request schedules its callback in a microtask, so check at
  // the actual send as well as after each asynchronous read/response.
  if (!projection.canRepair()) throw new ManagedViewRepairSupersededError()
  return updateManagedViewVisibilityWithSignal(
    projection.viewId, 'visible', fence.viewRevision, fence.soulRevision, signal,
  )
}

/**
 * Freeze the managed-view fences carried by the panes before a close starts.
 * The pane projection is the last-known view identity for that exact layout;
 * reading the live inventory while a close is in flight could pair the close
 * with a newer view revision or a different incarnation.
 */
function collectManagedViewProjections(
  layout: PaneNode | undefined,
): FrozenManagedViewProjection[] {
  const byViewId = new Map<string, FrozenManagedViewProjection>()
  const visit = (node: PaneNode) => {
    if (node.type === 'split') {
      visit(node.children[0])
      visit(node.children[1])
      return
    }
    const content = node.content
    if (
      (content.kind !== 'terminal' && content.kind !== 'fresh-agent')
      || !content.viewIntentId
      || typeof content.viewIntentRevision !== 'number'
      || typeof content.soulIntentRevision !== 'number'
    ) {
      return
    }
    if (!byViewId.has(content.viewIntentId)) {
      byViewId.set(content.viewIntentId, {
        paneId: node.id,
        createRequestId: content.createRequestId,
        soulId: content.soulId,
        viewId: content.viewIntentId,
        viewRevision: content.viewIntentRevision,
        soulRevision: content.soulIntentRevision,
      })
    }
  }
  if (layout) visit(layout)
  return [...byViewId.values()]
}

type ManagedViewRepairFence = {
  viewRevision: number
  soulRevision: number
}

const MANAGED_VIEW_AUTHORITATIVE_REPAIR_ATTEMPTS = 2

/**
 * An authoritative read is a snapshot, so even a visible result needs an
 * acknowledged visible PATCH to fence a queued detach. The caller owns the
 * finite attempt budget; one reread handles a detach winning between read
 * and PATCH without an unbounded retry loop.
 */
async function repairManagedViewFromAuthoritativeDetail(
  projection: ManagedViewCloseProjection,
  operation: 'detach' | 'rollback',
  authoritative: Awaited<ReturnType<typeof getManagedRuntimeSoul>>,
  previousError: unknown,
  attemptsRemaining: number,
): Promise<void> {
  if (!projection.canRepair()) return
  const currentView = authoritative.viewIntents.find((view) => view.viewId === projection.viewId)
  if (!currentView) {
    log.error('managed view authoritative repair failed', {
      event: 'managed_view_visibility_uncertain_outcome',
      operation,
      phase: 'read',
      paneId: projection.paneId,
      soulId: projection.soulId,
      viewId: projection.viewId,
      reason: 'view_missing',
      error: previousError ? managedRuntimeErrorMessage(previousError) : undefined,
    })
    return
  }
  if (currentView.visibility !== 'visible' && currentView.visibility !== 'detached') {
    log.error('managed view authoritative repair failed', {
      event: 'managed_view_visibility_uncertain_outcome',
      operation,
      phase: 'read',
      paneId: projection.paneId,
      soulId: projection.soulId,
      viewId: projection.viewId,
      reason: 'unexpected_visibility',
      visibility: currentView.visibility,
      error: previousError ? managedRuntimeErrorMessage(previousError) : undefined,
    })
    return
  }

  try {
    // A visible read can precede the queued detach's commit. The acknowledged
    // PATCH advances the view revision even when it is already visible, so
    // that original detach can no longer commit using its old fence.
    const repaired = await awaitBoundedManagedRuntimeRequest(
      'managed view authoritative visibility repair',
      (signal) => updateManagedViewRepairWithSignal(projection, {
        viewRevision: currentView.revision,
        soulRevision: authoritative.soul.intentRevision,
      }, signal),
      {
        onGraceExpired: () => {
          logManagedRuntimeUncertainOutcome(projection, operation, 'authoritative_repair_grace_expired')
        },
        onLateSettlement: (outcome) => {
          return repairManagedViewAfterLateOutcome(projection, operation, outcome)
        },
      },
    )
    if (!projection.canRepair()) return
    if (repaired.visibility === 'visible') return
    log.error('managed view authoritative repair failed', {
      event: 'managed_view_visibility_uncertain_outcome',
      operation,
      phase: 'retry',
      paneId: projection.paneId,
      soulId: projection.soulId,
      viewId: projection.viewId,
      reason: 'retry_returned_non_visible',
      visibility: repaired.visibility,
      error: previousError ? managedRuntimeErrorMessage(previousError) : undefined,
    })
  } catch (error) {
    if (error instanceof ManagedViewRepairSupersededError || !projection.canRepair()) return
    if (attemptsRemaining > 0 && !isManagedRuntimeRequestTimeout(error)) {
      // The detach may have won between GET and PATCH. Re-read once with a
      // finite budget; persistent failure remains a diagnosed uncertainty.
      await repairManagedViewAuthoritatively(projection, operation, error, attemptsRemaining)
      return
    }
    log.error('managed view authoritative repair failed', {
      event: 'managed_view_visibility_uncertain_outcome',
      operation,
      phase: 'retry',
      paneId: projection.paneId,
      soulId: projection.soulId,
      viewId: projection.viewId,
      error: managedRuntimeErrorMessage(error),
    })
  }
}

async function repairManagedViewAuthoritatively(
  projection: ManagedViewCloseProjection,
  operation: 'detach' | 'rollback',
  previousError?: unknown,
  attemptsRemaining = MANAGED_VIEW_AUTHORITATIVE_REPAIR_ATTEMPTS,
): Promise<void> {
  if (!projection.canRepair()) return
  if (!projection.soulId) {
    log.error('managed view authoritative repair failed', {
      event: 'managed_view_visibility_uncertain_outcome',
      operation,
      phase: 'read',
      paneId: projection.paneId,
      viewId: projection.viewId,
      reason: 'missing_soul_id',
      error: previousError ? managedRuntimeErrorMessage(previousError) : undefined,
    })
    return
  }

  try {
    const authoritative = await awaitBoundedManagedRuntimeRequest(
      'managed runtime soul read',
      (signal) => getManagedRuntimeSoul(projection.soulId!, { signal }),
      {
        onGraceExpired: () => {
          logManagedRuntimeUncertainOutcome(projection, operation, 'authoritative_read_grace_expired', previousError)
        },
        onLateSettlement: (outcome) => {
          if (!projection.canRepair()) return
          if (!outcome.ok) {
            log.error('managed view authoritative repair failed', {
              event: 'managed_view_visibility_uncertain_outcome',
              operation,
              phase: 'late_read',
              paneId: projection.paneId,
              soulId: projection.soulId,
              viewId: projection.viewId,
              error: managedRuntimeErrorMessage(outcome.error),
            })
            return
          }
          return repairManagedViewFromAuthoritativeDetail(
            projection,
            operation,
            outcome.value,
            previousError,
            attemptsRemaining - 1,
          )
        },
      },
    )
    await repairManagedViewFromAuthoritativeDetail(projection, operation, authoritative, previousError, attemptsRemaining - 1)
  } catch (error) {
    if (!projection.canRepair()) return
    log.error('managed view authoritative repair failed', {
      event: 'managed_view_visibility_uncertain_outcome',
      operation,
      phase: 'read',
      paneId: projection.paneId,
      soulId: projection.soulId,
      viewId: projection.viewId,
      error: managedRuntimeErrorMessage(error),
    })
  }
}

async function repairManagedViewAfterLateOutcome(
  projection: ManagedViewCloseProjection,
  operation: 'detach' | 'rollback',
  outcome: ManagedRuntimeRequestOutcome<ManagedRuntimeViewIntent>,
): Promise<void> {
  if (!projection.canRepair()) return
  if (!outcome.ok) {
    await repairManagedViewAuthoritatively(projection, operation, outcome.error)
    return
  }

  try {
    const repaired = await awaitBoundedManagedRuntimeRequest(
      'managed view late visibility repair',
      (signal) => updateManagedViewRepairWithSignal(projection, {
        viewRevision: outcome.value.revision,
        soulRevision: outcome.value.soulIntentRevision,
      }, signal),
      {
        onGraceExpired: () => {
          logManagedRuntimeUncertainOutcome(projection, operation, 'late_repair_grace_expired')
        },
        onLateSettlement: (lateOutcome) => {
          return repairManagedViewAfterLateOutcome(projection, operation, lateOutcome)
        },
      },
    )
    if (!projection.canRepair()) return
    if (repaired.visibility === 'visible') return
    await repairManagedViewAuthoritatively(
      projection,
      operation,
      new Error(`late repair returned ${repaired.visibility}`),
    )
  } catch (error) {
    if (error instanceof ManagedViewRepairSupersededError || !projection.canRepair()) return
    await repairManagedViewAuthoritatively(projection, operation, error)
  }
}

async function repairManagedViewAfterTimeout(
  projection: ManagedViewCloseProjection,
  fence: ManagedViewRepairFence,
  operation: 'detach' | 'rollback',
): Promise<void> {
  if (!projection.canRepair()) return
  let immediateError: unknown
  try {
    const repaired = await awaitBoundedManagedRuntimeRequest(
      'managed view visibility repair',
      (signal) => updateManagedViewRepairWithSignal(projection, fence, signal),
      {
        onGraceExpired: () => {
          logManagedRuntimeUncertainOutcome(projection, operation, 'repair_grace_expired')
        },
        onLateSettlement: (outcome) => {
          return repairManagedViewAfterLateOutcome(projection, operation, outcome)
        },
      },
    )
    if (!projection.canRepair()) return
    if (repaired.visibility === 'visible') return
    immediateError = new Error(`repair returned ${repaired.visibility}`)
  } catch (error) {
    if (error instanceof ManagedViewRepairSupersededError || !projection.canRepair()) return
    immediateError = error
  }

  await repairManagedViewAuthoritatively(projection, operation, immediateError)
}

function managedViewTimeoutHooks(
  projection: ManagedViewCloseProjection,
  fence: ManagedViewRepairFence,
  operation: 'detach' | 'rollback',
): ManagedRuntimeRequestHooks<ManagedRuntimeViewIntent> {
  let timeoutRepair = Promise.resolve()
  return {
    onTimeout: () => {
      timeoutRepair = repairManagedViewAfterTimeout(projection, fence, operation)
    },
    onGraceExpired: () => {
      logManagedRuntimeUncertainOutcome(projection, operation, 'mutation_grace_expired')
    },
    onLateSettlement: (outcome) => {
      return timeoutRepair.then(() => repairManagedViewAfterLateOutcome(projection, operation, outcome))
    },
  }
}

/**
 * Confirm every frozen managed view detached or already closed as one close
 * transaction. If a later view refuses the mutation, use each completed
 * detach response's new fences to return its view to visible before the
 * pane/tab can be removed. Every
 * timeout also starts a bounded late-outcome repair while the original
 * visibility mutation remains observable. Other failed responses reconcile
 * the failing view too, because a rejected response does not prove refusal.
 */
async function detachManagedViews(
  projections: FrozenManagedViewProjection[],
  tabId: string,
  getState: () => unknown,
): Promise<boolean> {
  const completedDetaches: Array<{ projection: ManagedViewCloseProjection; view: ManagedRuntimeViewIntent }> = []
  const owned: ManagedViewCloseProjection[] = []
  for (const frozenProjection of projections) {
    const projection = ownManagedViewProjection(frozenProjection, tabId, getState)
    owned.push(projection)
    try {
      const view = await awaitBoundedManagedRuntimeRequest(
        'managed view visibility mutation',
        (signal) => updateManagedViewVisibilityWithSignal(
          projection.viewId,
          'detached',
          projection.viewRevision,
          projection.soulRevision,
          signal,
        ),
        managedViewTimeoutHooks(projection, {
          viewRevision: projection.viewRevision,
          soulRevision: projection.soulRevision,
        }, 'detach'),
      )
      // A verified stop may already have hidden this view before the
      // browser saw its new fences. That successful no-op has no detach
      // mutation to roll back if a later view refuses this close.
      if (view.visibility === 'detached') completedDetaches.push({ projection, view })
    } catch (error) {
      log.warn('managed view detach refused during close; rolling back earlier detaches', {
        event: 'managed_view_visibility_detach_unconfirmed',
        viewId: projection.viewId,
        paneId: projection.paneId,
        error: managedRuntimeErrorMessage(error),
      })
      if (!isManagedRuntimeRequestTimeout(error)) {
        // Transport and response-body failures can follow a committed PATCH
        // just as a timeout can. Read current fences before compensating it.
        await repairManagedViewAuthoritatively(projection, 'detach', error)
      }
      for (const completed of [...completedDetaches].reverse()) {
        try {
          await awaitBoundedManagedRuntimeRequest(
            'managed view rollback mutation',
            (signal) => updateManagedViewRepairWithSignal(completed.projection, {
              viewRevision: completed.view.revision,
              soulRevision: completed.view.soulIntentRevision,
            }, signal),
            managedViewTimeoutHooks(completed.projection, {
              viewRevision: completed.view.revision,
              soulRevision: completed.view.soulIntentRevision,
            }, 'rollback'),
          )
        } catch (rollbackError) {
          if (rollbackError instanceof ManagedViewRepairSupersededError || !completed.projection.canRepair()) continue
          if (!isManagedRuntimeRequestTimeout(rollbackError)) {
            log.error('managed view detach rollback failed after close refusal', {
              event: 'managed_view_visibility_rollback_failed',
              viewId: completed.view.viewId,
              paneId: completed.projection.paneId,
              error: managedRuntimeErrorMessage(rollbackError),
            })
            await repairManagedViewAuthoritatively(completed.projection, 'rollback', rollbackError)
          }
        }
      }
      for (const view of owned) view.allowOlderRepairs()
      return false
    }
  }
  return true
}

// A view-update failure must not be described as a close-evidence failure.
function surfaceManagedViewDetachFailure(
  dispatch: (action: unknown) => void,
  tabId: string,
  panes: ReadonlyArray<{ paneId: string }>,
) {
  for (const pane of panes) {
    dispatch(setPaneCloseError({
      tabId,
      paneId: pane.paneId,
      error: 'The pane could not be closed, so it was left open. Try again.',
    }))
  }
}

/**
 * Delta-r7-round-3 (focused-episode-7 round 2, Finding F2) — the acknowledged
 * close gate. EVERY user- or system-initiated pane removal routes through one
 * of the three gated thunks below (`closePaneWithCleanup`, `closeTab`,
 * `replacePaneWithCleanup`), and each session-pane identity's durable close
 * evidence must be CONFIRMED before the layout loses the pane — the kill
 * lane's close-ack rule applied to the non-retiring pane-close family. An
 * unacknowledged send after `next(action)` (the r7-r2 shape) could be lost by
 * a disconnect/half-open socket/page termination AFTER the user acted, and
 * the recovery offer would later recreate a pane the user explicitly removed.
 *
 * Focused-episode-7 round 3 (Finding F1) — the whole-tab close is ONE
 * envelope: `closeTab` sends ONE `panes.closed` carrying the tab's full
 * pane-identity set and awaits ONE correlated answer; the server journals
 * ONE record atomically, so a partial per-pane durable outcome is impossible
 * (pre-fix a pane-A-ack + pane-B-failure pair left pane A durably closed
 * under a still-standing tab, and recovery suppressed the visibly OPEN pane
 * A). The single-pane removals (pane-X, replace-pane) keep the degenerate
 * per-pane `pane.closed` envelope; both route through the same server-side
 * envelope writer.
 *
 * The gate: the close evidence is awaited BEFORE any reducer runs —
 * all-or-nothing for a multi-pane close (a partial removal would strand the
 * tab mid-close). On success the reducers run exactly as before (the
 * detach middleware's belt re-sends idempotently). On failure/timeout the
 * pane STAYS (server's authority: the close either recorded or it didn't)
 * and every failed pane's own error surface (`closeError`, the xterm
 * "[Close failed]" notice) carries why.
 *
 * Focused-episode-7 round 3 (Finding F2) — the kept pane re-asserts OPEN:
 * every close whose evidence failed to confirm (failure or the ambiguous
 * timeout — the record may have committed durably with the ack lost on the
 * wire) is followed by a durable `pane.opened` re-assertion. The server
 * consumes any standing close record for the pane and re-asserts the row's
 * attribution, so server state re-agrees with the layout the client is
 * displaying; the send queues until `ready`, so over a socket-down close
 * the close replays BEFORE the re-assertion consumes it on the returned
 * socket — the fence never stays durable-standing once the client
 * re-asserts.
 */
type PaneCloseIdentity = { paneId: string; createRequestId: string; terminalId?: string }

/**
 * Session-pane identities (crid-bearing) in a layout subtree — the gate's
 * unit. Focused-episode-7 round 4 (Finding F2): FRESH-AGENT panes are
 * collected exactly like terminal panes — they carry the same mandatory
 * createRequestId `pane.closed` / `panes.closed` key by, so a whole-tab or
 * replace-pane removal journals their per-REMOVAL close evidence too (the
 * pane-header kill lane is an ADDITIONAL close path whose retiring kill
 * envelope coexists; it never covered the removal of the pane itself).
 * Fresh-agent identities are always CRID-only: no terminal id ever exists.
 * The walk itself is the shared one (`collectSessionPaneIdentities`).
 */
function collectPaneCloseIdentities(layout: PaneNode | undefined): PaneCloseIdentity[] {
  if (!layout) return []
  return collectSessionPaneIdentities(layout)
}

/**
 * The single-pane-removal evidence send (pane-X / replace-pane — the
 * degenerate envelope). Returns the FAILED verdicts (empty = confirmed
 * durable). One shared bounded wait, first in flight.
 */
async function awaitPaneCloseEvidence(
  identities: PaneCloseIdentity[],
): Promise<Array<{ identity: PaneCloseIdentity; timedOut: boolean }>> {
  const verdicts = await Promise.all(
    identities.map(async (identity) => ({
      identity,
      ack: await sendPaneClosedAndAwait({
        createRequestId: identity.createRequestId,
        ...(identity.terminalId ? { terminalId: identity.terminalId } : {}),
      }, { timeoutMs: KILL_ACK_TIMEOUT_MS }),
    })),
  )
  // A confirmed close marks its identity so the detach middleware's belt
  // skips the redundant duplicate send (the one-shot mark/consume pattern —
  // `terminal-release-marks`).
  for (const v of verdicts) {
    if (v.ack.ok) markPaneCloseEvidenceConfirmed(v.identity.createRequestId)
  }
  return verdicts
    .filter((v) => !v.ack.ok)
    .map((v) => ({ identity: v.identity, timedOut: v.ack.ok === false && v.ack.timedOut === true }))
}

/** Surface the failure on every pane whose close evidence was not confirmed. */
function surfacePaneCloseFailures(
  dispatch: (action: unknown) => void,
  tabId: string,
  failed: Array<{ identity: PaneCloseIdentity; timedOut: boolean }>,
) {
  for (const { identity, timedOut } of failed) {
    dispatch(setPaneCloseError({
      tabId,
      paneId: identity.paneId,
      error: timedOut ? PANE_CLOSE_ACK_TIMEOUT_MESSAGE : PANE_CLOSE_FAILED_MESSAGE,
    }))
  }
}

/**
 * F2: re-assert every still-kept pane as OPEN after an unconfirmed close.
 * The record may be durable with its ack lost (the ambiguous timeout); the
 * server consumes it durably so recovery re-agrees with the displayed
 * layout. Queued until `ready` — over a socket-down close the close replays
 * before this assertion on the returned socket.
 *
 * Delta-round-8 (Finding F2) — the display check: the identity list was
 * frozen at close-SEND time, and between the send and the failed/timed-out
 * resolution the pane may have left the layout by ANY committed path (the
 * report's interleave — the tab's batch close committing while a pane close
 * timed out — is unreachable among the three gated thunks under the
 * serialization rule above, but a removal is a removal however it arrived).
 * A pane no longer displayed has nothing to reconcile: re-asserting it would
 * consume its standing close evidence and re-attribute it OPEN, so a later
 * recovery offers a session from a tab the user closed. Re-assert only what
 * the CURRENT layout still shows, keyed by the same createRequestId the
 * close lanes key by.
 */
function reassertKeptPanesOpen(
  currentLayout: PaneNode | undefined,
  tabId: string,
  identities: PaneCloseIdentity[],
) {
  const displayed = new Set(collectPaneCloseIdentities(currentLayout).map((i) => i.createRequestId))
  for (const identity of identities) {
    if (!displayed.has(identity.createRequestId)) {
      log.warn('skipping the open re-assertion of a no-longer-displayed pane', {
        tabId,
        paneId: identity.paneId,
        createRequestId: identity.createRequestId,
      })
      continue
    }
    sendPaneOpened({ createRequestId: identity.createRequestId, tabId })
  }
}

function paneCloseTargetChanged(
  dispatch: (action: unknown) => void,
  getState: () => RootState,
  tabId: string,
  paneId: string,
  identity: PaneCloseTargetIdentity,
  closeIdentities: PaneCloseIdentity[],
): boolean {
  const currentLayout = (getState() as RootState).panes.layouts[tabId]
  const currentContent = currentLayout ? findPaneContent(currentLayout, paneId) : null
  if (samePaneCloseTargetIdentity(identity, currentContent)) return false
  log.warn('pane content changed during close resolution; keeping the current pane content', { tabId, paneId })
  dispatch(setPaneCloseError({ tabId, paneId, error: PANE_CLOSE_REMOVAL_REFUSED_MESSAGE }))
  reassertKeptPanesOpen(currentLayout, tabId, closeIdentities)
  return true
}

function paneCloseTargetSetChanged(
  dispatch: (action: unknown) => void,
  getState: () => RootState,
  tabId: string,
  targets: PaneCloseTarget[],
  closeIdentities: PaneCloseIdentity[],
): boolean {
  const currentLayout = (getState() as RootState).panes.layouts[tabId]
  const changedPaneIds = changedPaneCloseTargetIds(targets, currentLayout)
  if (changedPaneIds.length === 0) return false
  log.warn('tab contents changed during close resolution; keeping the current tab contents', {
    tabId,
    paneIds: changedPaneIds,
  })
  for (const paneId of changedPaneIds) {
    dispatch(setPaneCloseError({ tabId, paneId, error: PANE_CLOSE_REMOVAL_REFUSED_MESSAGE }))
  }
  reassertKeptPanesOpen(currentLayout, tabId, closeIdentities)
  return true
}

function isManagedRuntimeProjection(content: PaneContent): content is Extract<PaneContent, { kind: 'terminal' }> {
  return content.kind === 'terminal'
}

function hasManagedRuntimeMarker(content: Extract<PaneContent, { kind: 'terminal' }>): boolean {
  return [content.viewIntentId, content.soulId, content.incarnationId, content.runtimeState]
    .some((value) => typeof value === 'string' && value.length > 0)
}

type ManagedTerminalCloseIdentity = {
  kind: 'managed-terminal-close-identity'
  createRequestId?: string
  viewIntentId?: string
  soulId?: string
  incarnationId?: string
  terminalId?: string
  sessionProvider?: string
  sessionId?: string
  hasManagedMarker: boolean
  isCreating: boolean
}

type PaneCloseTargetIdentity = string | PaneContent | ManagedTerminalCloseIdentity

function paneCloseTargetIdentity(content: PaneContent): PaneCloseTargetIdentity {
  if (content.kind === 'terminal') {
    // The view/soul/creation handles fence which managed view this pane is
    // about. A terminal.created fold may add its first terminal ID while the
    // create request remains stable, but a known terminal ID may never be
    // replaced during an asynchronous close.
    return {
      kind: 'managed-terminal-close-identity',
      createRequestId: content.createRequestId,
      viewIntentId: content.viewIntentId,
      soulId: content.soulId,
      incarnationId: content.incarnationId,
      terminalId: content.terminalId,
      sessionProvider: content.sessionRef?.provider,
      sessionId: content.sessionRef?.sessionId,
      hasManagedMarker: hasManagedRuntimeMarker(content),
      isCreating: content.status === 'creating',
    }
  }
  if (content.kind === 'fresh-agent') {
    if (content.createRequestId) return JSON.stringify(['fresh-agent', 'create', content.createRequestId])
    if (content.sessionId) return JSON.stringify(['fresh-agent', 'session', content.sessionId])
    return content
  }
  if (content.kind === 'browser') return JSON.stringify(['browser', content.browserInstanceId])
  if (content.kind === 'editor' && content.filePath) return JSON.stringify(['editor', content.filePath])
  return content
}

function samePaneCloseTargetIdentity(
  original: PaneCloseTargetIdentity,
  current: PaneContent | null,
): boolean {
  if (!current) return false
  if (typeof original === 'object' && 'kind' in original && original.kind === 'managed-terminal-close-identity') {
    if (current.kind !== 'terminal') return false
    const currentIdentity = paneCloseTargetIdentity(current)
    if (
      typeof currentIdentity !== 'object'
      || !('kind' in currentIdentity)
      || currentIdentity.kind !== 'managed-terminal-close-identity'
    ) return false
    if (
      original.createRequestId !== currentIdentity.createRequestId
      || original.viewIntentId !== currentIdentity.viewIntentId
      || original.soulId !== currentIdentity.soulId
      || original.incarnationId !== currentIdentity.incarnationId
      || original.sessionProvider !== currentIdentity.sessionProvider
      || original.sessionId !== currentIdentity.sessionId
      || original.hasManagedMarker !== currentIdentity.hasManagedMarker
    ) return false
    const terminalIdMatches = original.terminalId === currentIdentity.terminalId
      || (!original.terminalId && Boolean(currentIdentity.terminalId) && Boolean(original.createRequestId))
    const creationStateMatches = original.isCreating === currentIdentity.isCreating
      || (original.isCreating && !currentIdentity.isCreating && Boolean(original.createRequestId))
    return terminalIdMatches && creationStateMatches
  }
  if (typeof original !== 'string') return current === original
  return paneCloseTargetIdentity(current) === original
}

type PaneCloseTarget = { paneId: string; identity: PaneCloseTargetIdentity }

function collectPaneCloseTargets(layout: PaneNode | undefined): PaneCloseTarget[] {
  if (!layout) return []
  return collectPaneEntries(layout).map(({ paneId, content }) => ({
    paneId,
    identity: paneCloseTargetIdentity(content),
  }))
}

function changedPaneCloseTargetIds(
  targets: PaneCloseTarget[],
  currentLayout: PaneNode | undefined,
): string[] {
  const currentEntries = currentLayout ? collectPaneEntries(currentLayout) : []
  const currentById = new Map(currentEntries.map(({ paneId, content }) => [paneId, content]))
  const targetIds = new Set(targets.map(({ paneId }) => paneId))
  const changed = new Set<string>()
  if (targets.length !== currentEntries.length) {
    for (const { paneId } of targets) changed.add(paneId)
    for (const { paneId } of currentEntries) changed.add(paneId)
  }
  for (const { paneId, identity } of targets) {
    if (!samePaneCloseTargetIdentity(identity, currentById.get(paneId) ?? null)) changed.add(paneId)
  }
  for (const { paneId } of currentEntries) {
    if (!targetIds.has(paneId)) changed.add(paneId)
  }
  return [...changed]
}

function applyManagedRuntimeInventory(
  snapshot: ManagedRuntimeInventorySnapshot,
  dispatch: (action: unknown) => void,
  getState: () => RootState,
): void {
  dispatch(managedRuntimeSnapshotReceived({
    snapshot,
    reconstructedViewCount: selectManagedRuntime(getState()).reconstructedViewCount,
  }))
}

type ManagedViewResolution =
  | { kind: 'resolved'; viewIntentIds: string[] }
  | { kind: 'none'; viewIntentIds: [] }
  | { kind: 'unresolved'; viewIntentIds: string[] }

export type ManagedLocalViewIdentityResolution = {
  viewIntentIds: string[]
  ambiguous: boolean
}

type ManagedLocalRuntimeIdentity = {
  viewIntentId?: string
  soulId?: string
  terminalId?: string
  createRequestId?: string
}

function managedSoulsForLocalIdentity(
  identity: ManagedLocalRuntimeIdentity,
  snapshot: ManagedRuntimeInventorySnapshot,
): ManagedRuntimeSoul[] {
  return snapshot.souls.filter((soul) => (
    (identity.soulId && identity.soulId === soul.soulId)
    || (identity.terminalId && identity.terminalId === soul.terminalId)
    || (identity.createRequestId && identity.createRequestId === soul.terminalCreateRequestId)
  ))
}

function resolveUnmarkedManagedLocalIdentity(
  identity: ManagedLocalRuntimeIdentity,
  snapshot: ManagedRuntimeInventorySnapshot,
): ManagedLocalViewIdentityResolution {
  const identityMatchedSouls = managedSoulsForLocalIdentity(identity, snapshot)
  if (identityMatchedSouls.length > 1) {
    const viewIntentIds = [...new Set(identityMatchedSouls.flatMap((soul) => (
      snapshot.viewIntents.filter((view) => view.soulId === soul.soulId).map((view) => view.viewId)
    )))]
    return { viewIntentIds, ambiguous: true }
  }
  if (identityMatchedSouls.length === 0) return { viewIntentIds: [], ambiguous: false }

  const matchedSoul = identityMatchedSouls[0]!
  const soulViews = snapshot.viewIntents.filter((view) => view.soulId === matchedSoul.soulId)
  if (soulViews.length !== 1 || soulViews[0]!.kind === 'explicit') {
    return { viewIntentIds: soulViews.map((view) => view.viewId), ambiguous: soulViews.length > 0 }
  }
  return { viewIntentIds: [soulViews[0]!.viewId], ambiguous: false }
}

/** Resolve an unmarked local tab without aliasing sibling views of the same soul. */
export function resolveManagedLocalTabViewIdentity(
  identity: ManagedLocalRuntimeIdentity,
  snapshot: ManagedRuntimeInventorySnapshot,
): ManagedLocalViewIdentityResolution {
  if (identity.viewIntentId) return { viewIntentIds: [identity.viewIntentId], ambiguous: false }
  return resolveUnmarkedManagedLocalIdentity(identity, snapshot)
}

/** Resolve one local terminal without aliasing sibling views of the same soul. */
export function resolveManagedLocalViewIdentity(
  content: PaneContent,
  snapshot: ManagedRuntimeInventorySnapshot,
  tabViewIntentId?: string,
  paneId?: string,
  terminalPaneCount = 1,
): ManagedLocalViewIdentityResolution {
  if (!isManagedRuntimeProjection(content)) return { viewIntentIds: [], ambiguous: false }
  if (content.viewIntentId) return { viewIntentIds: [content.viewIntentId], ambiguous: false }

  if (tabViewIntentId) {
    const tabViews = snapshot.viewIntents.filter((view) => view.viewId === tabViewIntentId)
    if (tabViews.length > 1) return { viewIntentIds: [tabViewIntentId], ambiguous: true }
    const tabView = tabViews[0]
    if (terminalPaneCount === 1 || paneId === tabView?.preferredPaneId) {
      if (tabView) {
        const matchedSouls = managedSoulsForLocalIdentity(content, snapshot)
        if (
          matchedSouls.length > 0
          && (matchedSouls.length !== 1 || matchedSouls[0]!.soulId !== tabView.soulId)
        ) {
          const inferredIdentity = resolveUnmarkedManagedLocalIdentity(content, snapshot)
          return {
            viewIntentIds: [...new Set([tabViewIntentId, ...inferredIdentity.viewIntentIds])],
            ambiguous: true,
          }
        }
      }
      return tabView
        ? { viewIntentIds: [tabViewIntentId], ambiguous: false }
        : { viewIntentIds: [tabViewIntentId], ambiguous: true }
    }
  }

  return resolveUnmarkedManagedLocalIdentity(content, snapshot)
}

function resolveManagedViewForTerminal(
  content: Extract<PaneContent, { kind: 'terminal' }>,
  snapshot: ManagedRuntimeInventorySnapshot,
  fallbackViewIntentId?: string,
): ManagedViewResolution {
  if (content.viewIntentId) {
    const matches = snapshot.viewIntents.filter((view) => view.viewId === content.viewIntentId)
    return matches.length === 1
      ? { kind: 'resolved', viewIntentIds: [matches[0]!.viewId] }
      : { kind: 'unresolved', viewIntentIds: [content.viewIntentId] }
  }

  const identityMatchedSouls = snapshot.souls.filter((soul) => (
    (content.terminalId && soul.terminalId === content.terminalId)
    || (content.createRequestId && soul.terminalCreateRequestId === content.createRequestId)
  ))
  const matchedSouls = content.soulId
    ? identityMatchedSouls.filter((soul) => soul.soulId === content.soulId)
    : identityMatchedSouls
  if (matchedSouls.length > 1) return { kind: 'unresolved', viewIntentIds: [] }

  const matchedSoul = matchedSouls[0]
  if (fallbackViewIntentId) {
    const views = snapshot.viewIntents.filter((view) => view.viewId === fallbackViewIntentId)
    if (views.length !== 1) return { kind: 'unresolved', viewIntentIds: [fallbackViewIntentId] }
    const fallbackView = views[0]!
    if (
      (content.soulId && content.soulId !== fallbackView.soulId)
      || (identityMatchedSouls.length > 0 && !identityMatchedSouls.some((soul) => soul.soulId === fallbackView.soulId))
      || (matchedSoul && matchedSoul.soulId !== fallbackView.soulId)
    ) {
      return { kind: 'unresolved', viewIntentIds: [fallbackViewIntentId] }
    }
    return { kind: 'resolved', viewIntentIds: [fallbackViewIntentId] }
  }
  if (matchedSoul) {
    const views = snapshot.viewIntents.filter((view) => view.soulId === matchedSoul.soulId)
    if (views.length === 1 && views[0]!.kind === 'automatic_primary') {
      return { kind: 'resolved', viewIntentIds: [views[0]!.viewId] }
    }
    return { kind: 'unresolved', viewIntentIds: views.map((view) => view.viewId) }
  }

  const inventoryComplete = snapshot.readiness.initialScanState === 'complete'
    && snapshot.pendingProjectionCount === 0
  if (
    hasManagedRuntimeMarker(content)
    || content.status === 'creating'
    || !inventoryComplete
  ) {
    return { kind: 'unresolved', viewIntentIds: [] }
  }
  return { kind: 'none', viewIntentIds: [] }
}

function collectOtherLocalManagedViewIds(
  state: RootState,
  snapshot: ManagedRuntimeInventorySnapshot,
  targetTabId: string,
  targetPaneId?: string,
  targetViewIntentIds: Set<string> = new Set(),
): Set<string> {
  const viewIntentIds = new Set<string>()
  const addLayoutRepresentations = (
    tabId: string,
    layout: PaneNode,
    tabViewIntentId?: string,
  ) => {
    if (tabId === targetTabId && !targetPaneId) return
    const entries = collectPaneEntries(layout)
    const terminalPaneCount = entries.filter(({ content }) => isManagedRuntimeProjection(content)).length
    for (const entry of entries) {
      if (tabId === targetTabId && entry.paneId === targetPaneId) continue
      const identity = resolveManagedLocalViewIdentity(
        entry.content,
        snapshot,
        tabViewIntentId,
        entry.paneId,
        terminalPaneCount,
      )
      if (identity.ambiguous && identity.viewIntentIds.some((id) => targetViewIntentIds.has(id))) {
        throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
      }
      for (const id of identity.viewIntentIds) viewIntentIds.add(id)
    }
  }

  const representedLayoutTabIds = new Set<string>()
  for (const tab of state.tabs.tabs) {
    const layout = state.panes.layouts[tab.id]
    if (tab.id !== targetTabId && !layout) {
      const identity = resolveManagedLocalTabViewIdentity(tab, snapshot)
      if (identity.ambiguous && identity.viewIntentIds.some((id) => targetViewIntentIds.has(id))) {
        throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
      }
      for (const id of identity.viewIntentIds) viewIntentIds.add(id)
      continue
    }
    if (!layout) continue
    representedLayoutTabIds.add(tab.id)
    addLayoutRepresentations(tab.id, layout, tab.viewIntentId)
  }
  for (const [tabId, layout] of Object.entries(state.panes.layouts)) {
    if (!layout || representedLayoutTabIds.has(tabId)) continue
    addLayoutRepresentations(tabId, layout)
  }
  return viewIntentIds
}

function isManagedViewRepresentedLocally(
  state: RootState,
  view: ManagedRuntimeViewIntent,
  snapshot: ManagedRuntimeInventorySnapshot,
): boolean {
  for (const tab of state.tabs.tabs) {
    const layout = state.panes.layouts[tab.id]
    if (!layout) {
      const identity = resolveManagedLocalTabViewIdentity(tab, snapshot)
      if (identity.viewIntentIds.includes(view.viewId)) return true
      continue
    }
    const entries = collectPaneEntries(layout)
    const terminalPaneCount = entries.filter(({ content }) => isManagedRuntimeProjection(content)).length
    for (const { paneId, content } of entries) {
      if (!isManagedRuntimeProjection(content)) continue
      const identity = resolveManagedLocalViewIdentity(
        content,
        snapshot,
        tab.viewIntentId,
        paneId,
        terminalPaneCount,
      )
      if (identity.viewIntentIds.includes(view.viewId)) return true
    }
  }
  return false
}

/** Resolve exact close targets before detaching the local representation. */
type ManagedViewCloseResolution = {
  viewIntentIds: string[]
  paneIds: string[]
  snapshot?: ManagedRuntimeInventorySnapshot
}

function resolveManagedViewIntentsToRemove(
  state: RootState,
  tabId: string,
  paneId: string | undefined,
  dispatch: (action: unknown) => void,
  getState: () => RootState,
): ManagedViewCloseResolution | Promise<ManagedViewCloseResolution> {
  const tab = state.tabs.tabs.find((item) => item.id === tabId)
  const layout = state.panes.layouts[tabId]
  const targetEntries = layout
    ? collectPaneEntries(layout).filter((entry) => paneId === undefined || entry.paneId === paneId)
    : []
  const terminalTargets = targetEntries.filter((entry) => isManagedRuntimeProjection(entry.content))
  const tabMarkerViewIntentId = tab?.viewIntentId
  const tabViewIntentId = !layout && paneId === undefined ? tab?.viewIntentId : undefined
  if (terminalTargets.length === 0 && !tabViewIntentId) return { viewIntentIds: [], paneIds: [] }

  const runtime = selectManagedRuntime(state)
  const hasKnownMarker = terminalTargets.some(({ content }) => (
    isManagedRuntimeProjection(content) && hasManagedRuntimeMarker(content)
  )) || Boolean(tabMarkerViewIntentId)
  const unresolvedCreation = terminalTargets.some(({ content }) => (
    isManagedRuntimeProjection(content) && content.status === 'creating'
  ))
  if (!runtime.available && unresolvedCreation) {
    throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
  }
  if (!runtime.available) {
    const matchesCachedManagedIdentity = terminalTargets.some(({ content }) => (
      isManagedRuntimeProjection(content)
      && runtime.souls.some((soul) => (
        (content.terminalId && soul.terminalId === content.terminalId)
        || (content.createRequestId && soul.terminalCreateRequestId === content.createRequestId)
      ))
    ))
    if (hasKnownMarker || matchesCachedManagedIdentity) {
      throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
    }
    return { viewIntentIds: [], paneIds: [] }
  }

  return getManagedRuntimeInventory().then((snapshot) => {
    applyManagedRuntimeInventory(snapshot, dispatch, getState)

    const targetViewIntentIds = new Set<string>()
    const paneIds = new Set<string>()
    if (tabViewIntentId) {
      const matches = snapshot.viewIntents.filter((view) => view.viewId === tabViewIntentId)
      if (matches.length !== 1) throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
      targetViewIntentIds.add(tabViewIntentId)
    }
    const terminalEntries = layout
      ? collectPaneEntries(layout).filter(({ content }) => isManagedRuntimeProjection(content))
      : []
    const tabMarkerMatches = tabMarkerViewIntentId
      ? snapshot.viewIntents.filter((view) => view.viewId === tabMarkerViewIntentId)
      : []
    const tabMarkerView = tabMarkerMatches.length === 1 ? tabMarkerMatches[0] : undefined
    const markedPaneId = tabMarkerView
      ? terminalEntries.find(({ paneId: candidatePaneId }) => (
        candidatePaneId === tabMarkerView.preferredPaneId
      ))?.paneId ?? (terminalEntries.length === 1 ? terminalEntries[0]!.paneId : undefined)
      : undefined
    for (const { paneId: targetPaneId, content } of terminalTargets) {
      if (!isManagedRuntimeProjection(content)) continue
      const fallbackViewIntentId = tabMarkerViewIntentId
        && targetPaneId === markedPaneId
        && !content.viewIntentId
        ? tabMarkerViewIntentId
        : undefined
      const resolution = resolveManagedViewForTerminal(content, snapshot, fallbackViewIntentId)
      if (resolution.kind === 'unresolved') {
        paneIds.add(targetPaneId)
        throw Object.assign(new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE), { paneIds: [...paneIds] })
      }
      if (resolution.kind === 'resolved') {
        paneIds.add(targetPaneId)
        for (const viewIntentId of resolution.viewIntentIds) targetViewIntentIds.add(viewIntentId)
      }
    }

    const otherRepresentations = collectOtherLocalManagedViewIds(
      state,
      snapshot,
      tabId,
      paneId,
      targetViewIntentIds,
    )
    return {
      viewIntentIds: [...targetViewIntentIds].filter((viewIntentId) => !otherRepresentations.has(viewIntentId)),
      paneIds: [...paneIds],
      snapshot,
    }
  }).catch((error) => {
    log.warn('could not resolve managed views before local close', {
      tabId,
      paneId,
      error: error instanceof Error ? error.message : String(error),
    })
    throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
  })
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | null)?.then === 'function'
}

function managedRuntimeTerminalStatus(soul: ManagedRuntimeSoul): TerminalStatus {
  if (soul.desiredState === 'stopped' || soul.recoveryState === 'stopped') return 'exited'
  if (soul.recoveryState === 'recovering' || soul.recoveryState === 'blocked') return 'recovering'
  if (soul.launchState === 'running' && soul.recoveryState === 'live') return 'running'
  if (soul.launchState === 'failed' || soul.recoveryState === 'lost') return 'error'
  return 'creating'
}

function hasManagedRuntimeReopenCandidate(
  tab: Tab | undefined,
  layout: PaneNode | undefined,
  runtime: ReturnType<typeof selectManagedRuntime>,
): boolean {
  if (tab?.viewIntentId || tab?.soulId || tab?.incarnationId || tab?.runtimeState) return true
  if (!layout) return false
  return collectPaneContents(layout).some((content) => {
    if (content.kind !== 'terminal') return false
    if (hasManagedRuntimeMarker(content)) return true
    return runtime.souls.some((soul) => (
      (content.soulId && content.soulId === soul.soulId)
      || (content.terminalId && content.terminalId === soul.terminalId)
      || (content.createRequestId && content.createRequestId === soul.terminalCreateRequestId)
    ))
  })
}

function resolveManagedReopenTarget(
  content: Extract<PaneContent, { kind: 'terminal' }>,
  snapshot: ManagedRuntimeInventorySnapshot,
  fallbackViewIntentId?: string,
): { view: ManagedRuntimeViewIntent; soul: ManagedRuntimeSoul; terminalCreateRequestId: string } | undefined {
  let view: ManagedRuntimeViewIntent | undefined
  if (content.viewIntentId) {
    const matches = snapshot.viewIntents.filter((candidate) => candidate.viewId === content.viewIntentId)
    if (matches.length !== 1) throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
    view = matches[0]!
  } else {
    const identityMatchedSouls = snapshot.souls.filter((soul) => (
      (content.soulId && soul.soulId === content.soulId)
      || (content.terminalId && soul.terminalId === content.terminalId)
      || (content.createRequestId && soul.terminalCreateRequestId === content.createRequestId)
    ))
    if (identityMatchedSouls.length > 1) throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
    if (identityMatchedSouls.length === 0 && fallbackViewIntentId) {
      const matches = snapshot.viewIntents.filter((candidate) => candidate.viewId === fallbackViewIntentId)
      if (matches.length !== 1) throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
      view = matches[0]!
    } else if (identityMatchedSouls.length === 0) {
      if (hasManagedRuntimeMarker(content)) throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
      return undefined
    } else {
      const matchedSoul = identityMatchedSouls[0]!
      if (fallbackViewIntentId) {
        const matches = snapshot.viewIntents.filter((candidate) => candidate.viewId === fallbackViewIntentId)
        if (matches.length !== 1 || matches[0]!.soulId !== matchedSoul.soulId) {
          throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
        }
        view = matches[0]!
      } else {
        const matches = snapshot.viewIntents.filter((candidate) => candidate.soulId === matchedSoul.soulId)
        if (matches.length !== 1) throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
        view = matches[0]!
      }
    }
  }

  if (content.soulId && content.soulId !== view.soulId) {
    throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
  }
  const souls = snapshot.souls.filter((candidate) => candidate.soulId === view!.soulId)
  if (souls.length !== 1) throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
  const soul = souls[0]!
  if (
    soul.launchState !== 'running'
    || soul.desiredState !== 'running'
    || soul.recoveryState !== 'live'
    || !soul.terminalId
    || !soul.terminalCreateRequestId
  ) {
    throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
  }
  const terminalCreateRequestId = soul.terminalCreateRequestId
  if (!terminalCreateRequestId) throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
  return { view, soul, terminalCreateRequestId }
}

/** Validate managed identities and refresh handles before restoring a closed layout. */
function prepareManagedRuntimeReopenLayout(
  layout: PaneNode,
  snapshot: ManagedRuntimeInventorySnapshot,
  tab: Tab,
): { layout: PaneNode; viewIntentIds: string[] } {
  const viewIntentIds = new Set<string>()
  const terminalLeaves: Extract<PaneNode, { type: 'leaf' }>[] = []
  const collectTerminalLeaves = (node: PaneNode) => {
    if (node.type === 'split') {
      collectTerminalLeaves(node.children[0])
      collectTerminalLeaves(node.children[1])
    } else if (node.content.kind === 'terminal') {
      terminalLeaves.push(node)
    }
  }
  collectTerminalLeaves(layout)
  const tabViewMatches = tab.viewIntentId
    ? snapshot.viewIntents.filter((view) => view.viewId === tab.viewIntentId)
    : []
  const tabSoulViewMatches = tab.soulId
    ? snapshot.viewIntents.filter((view) => view.soulId === tab.soulId)
    : []
  const tabManagedViewId = tab.viewIntentId
    ?? (tabSoulViewMatches.length === 1 ? tabSoulViewMatches[0]!.viewId : undefined)
  const preferredPaneLeaf = tabViewMatches.length === 1
    ? terminalLeaves.find((leaf) => leaf.id === tabViewMatches[0]!.preferredPaneId)
    : undefined
  const fallbackPaneId = preferredPaneLeaf?.id
    ?? (terminalLeaves.length === 1 ? terminalLeaves[0]!.id : undefined)
  const visit = (node: PaneNode): PaneNode => {
    if (node.type === 'split') {
      return {
        ...node,
        children: [visit(node.children[0]), visit(node.children[1])],
      }
    }
    if (node.content.kind !== 'terminal') return node
    const fallbackViewIntentId = fallbackPaneId === node.id ? tabManagedViewId : undefined
    const target = resolveManagedReopenTarget(node.content, snapshot, fallbackViewIntentId)
    if (!target) return node
    const { view, soul, terminalCreateRequestId } = target
    viewIntentIds.add(view.viewId)
    const sessionRef = soul.provider && soul.provider !== 'shell' && soul.nativeSessionId
      ? { provider: soul.provider, sessionId: soul.nativeSessionId }
      : undefined
    return {
      ...node,
      content: {
        ...node.content,
        terminalId: soul.terminalId,
        streamId: soul.terminalStreamId,
        createRequestId: terminalCreateRequestId,
        status: managedRuntimeTerminalStatus(soul),
        mode: (soul.terminalMode || soul.provider || node.content.mode) as TabMode,
        ...(soul.terminalCwd ? { initialCwd: soul.terminalCwd } : {}),
        ...(sessionRef ? { sessionRef } : {}),
        soulId: soul.soulId,
        incarnationId: soul.incarnationId,
        runtimeState: soul.launchState,
        viewIntentId: view.viewId,
        viewIntentRevision: view.revision,
        soulIntentRevision: soul.intentRevision,
        placementGroup: view.placementGroup,
      },
    }
  }

  return { layout: visit(layout), viewIntentIds: [...viewIntentIds] }
}

function locallyRepresentedManagedReopenViews(
  state: RootState,
  viewIntentIds: string[],
  snapshot: ManagedRuntimeInventorySnapshot,
): {
  representedViewIntentIds: Set<string>
  representationCountByViewIntentId: Map<string, number>
  representationsByViewIntentId: Map<string, ManagedReopenLocalRepresentation[]>
  ambiguous: boolean
} {
  const targetViews = viewIntentIds.map((viewIntentId) => {
    const matches = snapshot.viewIntents.filter((view) => view.viewId === viewIntentId)
    if (matches.length !== 1) throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
    const view = matches[0]!
    const souls = snapshot.souls.filter((soul) => soul.soulId === view.soulId)
    if (souls.length !== 1) throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
    return { view, soul: souls[0]! }
  })
  type Candidate = {
    tabId: string
    pane?: PaneNode
    paneViewIntentId?: string
    tabViewIntentId?: string
    soulId?: string
    terminalId?: string
    createRequestId?: string
    terminalPaneCount: number
  }
  const candidates: Candidate[] = []

  for (const tab of state.tabs.tabs) {
    const layout = state.panes.layouts[tab.id]
    if (!layout) {
      candidates.push({
        tabId: tab.id,
        tabViewIntentId: tab.viewIntentId,
        soulId: tab.soulId,
        createRequestId: tab.createRequestId,
        terminalPaneCount: 0,
      })
      continue
    }
    const tabCandidates: Omit<Candidate, 'terminalPaneCount'>[] = []
    const visit = (node: PaneNode) => {
      if (node.type === 'split') {
        visit(node.children[0])
        visit(node.children[1])
        return
      }
      const { content } = node
      if (content.kind !== 'terminal') return
      tabCandidates.push({
        tabId: tab.id,
        pane: node,
        paneViewIntentId: content.viewIntentId,
        tabViewIntentId: tab.viewIntentId,
        soulId: content.soulId,
        terminalId: content.terminalId,
        createRequestId: content.createRequestId,
      })
    }
    visit(layout)
    candidates.push(...tabCandidates.map((candidate) => ({
      ...candidate,
      terminalPaneCount: tabCandidates.length,
    })))
  }

  const representedViewIntentIds = new Set<string>()
  const representationCountByViewIntentId = new Map<string, number>()
  const representationsByViewIntentId = new Map<string, ManagedReopenLocalRepresentation[]>()
  const recordRepresentation = (viewIntentId: string, candidate: Candidate) => {
    representedViewIntentIds.add(viewIntentId)
    representationCountByViewIntentId.set(
      viewIntentId,
      (representationCountByViewIntentId.get(viewIntentId) ?? 0) + 1,
    )
    const matches = representationsByViewIntentId.get(viewIntentId) ?? []
    matches.push({ tabId: candidate.tabId, pane: candidate.pane })
    representationsByViewIntentId.set(viewIntentId, matches)
  }
  const ambiguousResult = () => ({
    representedViewIntentIds,
    representationCountByViewIntentId,
    representationsByViewIntentId,
    ambiguous: true,
  })
  for (const candidate of candidates) {
    if (candidate.paneViewIntentId) {
      if (viewIntentIds.includes(candidate.paneViewIntentId)) {
        recordRepresentation(candidate.paneViewIntentId, candidate)
      }
      // A different nonempty view ID is authoritative; terminal handles do
      // not let one managed view claim another view's local pane.
      continue
    }
    if (candidate.tabViewIntentId) {
      const matches = targetViews.filter(({ view }) => view.viewId === candidate.tabViewIntentId)
      if (matches.length === 1) {
        const target = matches[0]!
        const paneIsIdentifiedByTabMarker = !candidate.pane
          || candidate.terminalPaneCount === 1
          || candidate.pane.id === target.view.preferredPaneId
        if (paneIsIdentifiedByTabMarker) recordRepresentation(target.view.viewId, candidate)
      }
      // A tab marker is authoritative for that tab; shared writer handles
      // cannot make it represent a different saved view.
      continue
    }

    const identityMatchedSouls = snapshot.souls.filter((soul) => (
      (!candidate.soulId || candidate.soulId === soul.soulId)
      && (
        (candidate.terminalId && candidate.terminalId === soul.terminalId)
        || (candidate.createRequestId && candidate.createRequestId === soul.terminalCreateRequestId)
      )
    ))
    if (identityMatchedSouls.length > 1) {
      return ambiguousResult()
    }
    if (identityMatchedSouls.length === 0) continue
    const soulViews = snapshot.viewIntents.filter((view) => view.soulId === identityMatchedSouls[0]!.soulId)
    const targetedViews = soulViews.filter((view) => viewIntentIds.includes(view.viewId))
    if (targetedViews.some((view) => view.kind === 'explicit')) {
      return ambiguousResult()
    }
    if (targetedViews.length > 0 && soulViews.length !== 1) {
      return ambiguousResult()
    }
    if (targetedViews.length === 1) recordRepresentation(targetedViews[0]!.viewId, candidate)
  }

  return {
    representedViewIntentIds,
    representationCountByViewIntentId,
    representationsByViewIntentId,
    ambiguous: false,
  }
}

interface ManagedReopenLocalRepresentation {
  tabId: string
  pane?: PaneNode
}

function stableReopenContent(content: PaneContent): string {
  if (content.kind === 'terminal' && content.viewIntentId) {
    return JSON.stringify({ kind: content.kind, viewIntentId: content.viewIntentId })
  }
  const omitted = content.kind === 'browser'
    ? new Set(['browserInstanceId'])
    : new Set([
        'terminalId', 'createRequestId', 'status', 'serverInstanceId', 'streamId', 'sessionId',
        'restoreError', 'reconcileNotice', 'closeError', 'pendingReconcile', 'reconcileEpoch',
        'launchFailure', 'handoffError', 'createError',
      ])
  const stable = Object.fromEntries(Object.entries(content).filter(([key]) => !omitted.has(key)))
  return JSON.stringify(stable)
}

function sameRestoredPaneTopology(expected: PaneNode, actual: PaneNode): boolean {
  if (expected.type !== actual.type || expected.id !== actual.id) return false
  if (expected.type === 'leaf' && actual.type === 'leaf') {
    return expected.content.kind === actual.content.kind
      && stableReopenContent(expected.content) === stableReopenContent(actual.content)
  }
  if (expected.type !== 'split' || actual.type !== 'split') return false
  return expected.direction === actual.direction
    && expected.sizes[0] === actual.sizes[0]
    && expected.sizes[1] === actual.sizes[1]
    && sameRestoredPaneTopology(expected.children[0], actual.children[0])
    && sameRestoredPaneTopology(expected.children[1], actual.children[1])
}

function findAlreadyRestoredManagedReopenTab(
  state: RootState,
  preparedLayout: PaneNode,
): Tab | undefined {
  return state.tabs.tabs.find((tab) => {
    const layout = state.panes.layouts[tab.id]
    return layout !== undefined && sameRestoredPaneTopology(preparedLayout, layout)
  })
}

function planRedundantManagedProjectionTabRemoval(
  state: RootState,
  viewIntentIds: string[],
  representationsByViewIntentId: Map<string, ManagedReopenLocalRepresentation[]>,
  keepTabId: string,
): string[] {
  const paneViewByTab = new Map<string, Map<string, string>>()
  const candidateTabIds = new Set<string>()
  for (const viewIntentId of viewIntentIds) {
    for (const representation of representationsByViewIntentId.get(viewIntentId) ?? []) {
      candidateTabIds.add(representation.tabId)
      if (!representation.pane) continue
      const panes = paneViewByTab.get(representation.tabId) ?? new Map<string, string>()
      panes.set(representation.pane.id, viewIntentId)
      paneViewByTab.set(representation.tabId, panes)
    }
  }

  const redundantTabIds = [...candidateTabIds].filter((tabId) => tabId !== keepTabId)
  for (const tabId of redundantTabIds) {
    if (state.panes.closingTabs?.[tabId] || hasAnyClosePending(state.panes, tabId)) {
      throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
    }
    const layout = state.panes.layouts[tabId]
    if (!layout) continue
    let safeProjectionLayout = true
    const visit = (node: PaneNode) => {
      if (node.type === 'split') {
        visit(node.children[0])
        visit(node.children[1])
        return
      }
      if (node.content.kind !== 'terminal' || !paneViewByTab.get(tabId)?.has(node.id)) {
        safeProjectionLayout = false
      }
    }
    visit(layout)
    if (!safeProjectionLayout) throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
  }
  return redundantTabIds
}

function planManagedReopenProjectionMerge(
  state: RootState,
  viewIntentIds: string[],
  representationsByViewIntentId: Map<string, ManagedReopenLocalRepresentation[]>,
  representationCountByViewIntentId: Map<string, number>,
): { targetTabId: string; redundantTabIds: string[] } {
  const representationTabs = new Map<string, Map<string, PaneNode | undefined>>()
  for (const viewIntentId of viewIntentIds) {
    const count = representationCountByViewIntentId.get(viewIntentId) ?? 0
    if (count > 1) throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
    for (const representation of representationsByViewIntentId.get(viewIntentId) ?? []) {
      const panes = representationTabs.get(representation.tabId) ?? new Map<string, PaneNode | undefined>()
      panes.set(viewIntentId, representation.pane)
      representationTabs.set(representation.tabId, panes)
    }
  }
  const tabIds = [...representationTabs.keys()]
  if (tabIds.length === 0) throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)

  for (const tabId of tabIds) {
    if (state.panes.closingTabs?.[tabId] || hasAnyClosePending(state.panes, tabId)) {
      throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
    }
    const layout = state.panes.layouts[tabId]
    const paneToView = new Map<string, string>()
    for (const [viewIntentId, pane] of representationTabs.get(tabId)!) {
      if (pane) paneToView.set(pane.id, viewIntentId)
    }
    if (!layout) continue
    let safeProjectionLayout = true
    const visit = (node: PaneNode) => {
      if (node.type === 'split') {
        visit(node.children[0])
        visit(node.children[1])
        return
      }
      if (node.content.kind !== 'terminal' || !paneToView.has(node.id)) {
        safeProjectionLayout = false
      }
    }
    visit(layout)
    if (!safeProjectionLayout) throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
  }

  return { targetTabId: tabIds[0]!, redundantTabIds: tabIds.slice(1) }
}

/**
 * Persist a managed view visibility change and synchronize the inventory
 * revision before the caller changes local layout state. A close can otherwise
 * race an older inventory GET: after the tab is removed, that GET could still
 * see a visible view and recreate it. The final snapshot advances the store's
 * revision while the local pane is still present, so older responses are
 * rejected by the managed-runtime refresh path.
 *
 * Repeated panes may reference one view intent; mutate each intent only once.
 * If a later view mutation fails, the verification read still records any
 * earlier successful changes. The caller keeps the tab and a retry uses the
 * current per-view revisions.
 */
async function persistManagedViewVisibility(
  viewIntentIds: string[],
  visibility: ManagedRuntimeViewVisibility,
  dispatch: (action: unknown) => void,
  getState: () => RootState,
  options: {
    initialSnapshot?: ManagedRuntimeInventorySnapshot
  } = {},
): Promise<void> {
  if (viewIntentIds.length === 0) return
  if (!selectManagedRuntime(getState()).available) throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)

  const initialSnapshot = options.initialSnapshot ?? await getManagedRuntimeInventory()
  applyManagedRuntimeInventory(initialSnapshot, dispatch, getState)
  const currentViews = new Map<string, ManagedRuntimeViewIntent[]>()
  for (const view of initialSnapshot.viewIntents) {
    const matches = currentViews.get(view.viewId) ?? []
    matches.push(view)
    currentViews.set(view.viewId, matches)
  }
  const targetViews = viewIntentIds.map((viewIntentId) => {
    const matches = currentViews.get(viewIntentId) ?? []
    if (matches.length !== 1) throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
    return matches[0]!
  })

  const needsMutation = targetViews.some((view) => view.visibility !== visibility)
  if (!needsMutation) return

  let mutationError: unknown
  for (const view of targetViews) {
    if (view.visibility === visibility) continue
    try {
      await updateManagedRuntimeViewVisibility(
        view.viewId,
        visibility,
        view.revision,
        view.soulIntentRevision,
      )
    } catch (error) {
      mutationError = error
      break
    }
  }

  let confirmedSnapshot: ManagedRuntimeInventorySnapshot
  try {
    confirmedSnapshot = await getManagedRuntimeInventory()
  } catch (error) {
    log.warn('could not confirm managed view visibility after update', {
      viewIntentIds,
      visibility,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
  applyManagedRuntimeInventory(confirmedSnapshot, dispatch, getState)

  const confirmedViews = new Map<string, ManagedRuntimeViewIntent[]>()
  for (const view of confirmedSnapshot.viewIntents) {
    const matches = confirmedViews.get(view.viewId) ?? []
    matches.push(view)
    confirmedViews.set(view.viewId, matches)
  }
  const unconfirmedIds = viewIntentIds.filter((viewIntentId) => {
    const matches = confirmedViews.get(viewIntentId) ?? []
    return matches.length !== 1 || matches[0]!.visibility !== visibility
  })
  if (unconfirmedIds.length > 0) {
    if (mutationError !== undefined) throw mutationError
    throw new Error(`Managed view visibility was not confirmed for ${unconfirmedIds.join(', ')}`)
  }
  if (mutationError !== undefined) {
    log.warn('managed view update reported an error but inventory confirms the requested visibility', {
      viewIntentIds,
      visibility,
      error: mutationError instanceof Error ? mutationError.message : String(mutationError),
    })
  }
}

function clearDetachedManagedTabProjection(
  tabId: string,
  detachedViewIntentIds: string[],
  dispatch: (action: unknown) => void,
  getState: () => RootState,
): void {
  const state = getState()
  const tab = state.tabs.tabs.find((entry) => entry.id === tabId)
  const viewIntentId = tab?.viewIntentId
  if (!viewIntentId || !detachedViewIntentIds.includes(viewIntentId)) return

  const remainingLayout = state.panes.layouts[tabId]
  if (remainingLayout && collectPaneEntries(remainingLayout).some(({ content }) => (
    content.kind === 'terminal' && content.viewIntentId === viewIntentId
  ))) return

  dispatch(updateTab({
    id: tabId,
    updates: {
      preserveCreateRequestIdsOnNextReopen: true,
      soulId: undefined,
      incarnationId: undefined,
      runtimeState: undefined,
      viewIntentId: undefined,
      viewIntentRevision: undefined,
      soulIntentRevision: undefined,
      incidentId: undefined,
      placementGroup: undefined,
      resourceSummary: undefined,
      recoverySummary: undefined,
    },
  }))
}

/**
 * Close a pane and clean up its attention state.
 * If the target pane is the tab's only pane, closes the tab instead.
 * Otherwise only clears attention if closePane actually removed the pane (i.e. layout changed).
 */
export const closePaneWithCleanup = createAsyncThunk(
  'tabs/closePaneWithCleanup',
  async ({ tabId, paneId }: { tabId: string; paneId: string }, { dispatch, getState }) => {
    const initialState = getState() as RootState
    const before = initialState.panes.layouts[tabId]
    if (before?.type === 'leaf' && before.id === paneId) {
      await dispatch(closeTab(tabId))
      return
    }
    // Delta-round-8 (Finding F2), strengthened delta-round-9 (the review's
    // single Major) — the close-op serialization rule, the same shared guard
    // the reducers consult: ONE close op per TAB at a time, any scope. ANY
    // close touching the tab already outstanding — this pane's own close (a
    // duplicate — idempotent-rejected: the in-flight close completes it), a
    // DIFFERENT pane's close, or the whole tab's — ⇒ refuse to start; never
    // deferred. The round-9 finding's interleave: two acknowledged different-
    // pane closes on a two-pane tab collapsed the split with the first
    // removal, the second removal was refused by the last-leaf rule, and the
    // survivor stayed displayed under a durable close record (its ack
    // SUCCEEDED, so no heal fired) — recovery omitted a genuinely open pane.
    if (hasAnyClosePending(initialState.panes, tabId)) {
      log.warn('refusing to start a pane close while a close is already in flight for its tab', { tabId, paneId })
      return
    }
    const identity = collectPaneCloseIdentities(before).filter((i) => i.paneId === paneId)
    const targetContent = before ? findPaneContent(before, paneId) : null
    const targetIdentity = targetContent ? paneCloseTargetIdentity(targetContent) : undefined
    const freezePane = targetIdentity !== undefined
    if (freezePane) {
      // Freeze the pane identity while its close acknowledgement and managed
      // visibility transition are outstanding.
      dispatch(markPaneClosing({ tabId, paneId }))
    }
    try {
      await withManagedVisibilityTransition(async () => {
        if (targetIdentity && paneCloseTargetChanged(
          dispatch,
          getState as () => RootState,
          tabId,
          paneId,
          targetIdentity,
          identity,
        )) return
        if (identity.length > 0) {
          const failed = await awaitPaneCloseEvidence(identity)
          if (failed.length > 0) {
            log.warn('pane close evidence was not confirmed; the pane stays', { tabId, paneId })
            surfacePaneCloseFailures(dispatch, tabId, failed)
            reassertKeptPanesOpen((getState() as RootState).panes.layouts[tabId], tabId, identity)
            return
          }
        }

        if (targetIdentity && paneCloseTargetChanged(
          dispatch,
          getState as () => RootState,
          tabId,
          paneId,
          targetIdentity,
          identity,
        )) return

        let managedViews: ManagedViewCloseResolution
        try {
          const resolution = resolveManagedViewIntentsToRemove(
            getState() as RootState,
            tabId,
            paneId,
            dispatch,
            getState as () => RootState,
          )
          managedViews = isPromiseLike(resolution) ? await resolution : resolution
        } catch (error) {
          log.warn('managed view identity could not be resolved; the pane stays open', {
            tabId,
            paneId,
            error: error instanceof Error ? error.message : String(error),
          })
          dispatch(setPaneCloseError({ tabId, paneId, error: MANAGED_VIEW_CLOSE_FAILED_MESSAGE }))
          reassertKeptPanesOpen((getState() as RootState).panes.layouts[tabId], tabId, identity)
          return
        }
        if (targetIdentity && paneCloseTargetChanged(
          dispatch,
          getState as () => RootState,
          tabId,
          paneId,
          targetIdentity,
          identity,
        )) return
        if (managedViews.viewIntentIds.length > 0) {
          try {
            await persistManagedViewVisibility(
              managedViews.viewIntentIds,
              'detached',
              dispatch,
              getState as () => RootState,
              { initialSnapshot: managedViews.snapshot },
            )
          } catch (error) {
            log.warn('managed view detachment was not confirmed; the pane stays open', {
              tabId,
              paneId,
              viewIntentIds: managedViews.viewIntentIds,
              error: error instanceof Error ? error.message : String(error),
            })
            dispatch(setPaneCloseError({ tabId, paneId, error: MANAGED_VIEW_CLOSE_FAILED_MESSAGE }))
            reassertKeptPanesOpen((getState() as RootState).panes.layouts[tabId], tabId, identity)
            return
          }
        }

        if (targetIdentity && paneCloseTargetChanged(
          dispatch,
          getState as () => RootState,
          tabId,
          paneId,
          targetIdentity,
          identity,
        )) return

        const layoutBeforeRemoval = (getState() as RootState).panes.layouts[tabId]
        const closePersistenceAlreadyPending = isLocalClosePersistencePending(getState)
        const hasPaneToRemove = Boolean(layoutBeforeRemoval && findPaneContent(layoutBeforeRemoval, paneId))
        if (hasPaneToRemove) markLocalClosePersistencePending(getState)
        dispatch(closePane({ tabId, paneId }))
        const after = (getState() as RootState).panes.layouts[tabId]
        if (after && findPaneContent(after, paneId)) {
          if (hasPaneToRemove && !closePersistenceAlreadyPending) {
            clearLocalClosePersistencePending(getState)
          }
          log.warn('pane removal was refused after managed view detachment; the pane stays open', { tabId, paneId })
          dispatch(setPaneCloseError({ tabId, paneId, error: PANE_CLOSE_REMOVAL_REFUSED_MESSAGE }))
          reassertKeptPanesOpen(after, tabId, identity)
          return
        }

        if (before !== after) {
          clearDetachedManagedTabProjection(
            tabId,
            managedViews.viewIntentIds,
            dispatch,
            getState as () => RootState,
          )
          clearDraft(paneId)
          dispatch(clearPaneAttention({ paneId }))
          dispatch(clearTabAttention({ tabId }))
          if (hasPaneToRemove) dispatch(flushPersistedLayoutNow())
        }
      })
    } finally {
      if (freezePane) dispatch(clearPaneClosing({ tabId, paneId }))
    }
  }
)

export const closeTab = createAsyncThunk(
  'tabs/closeTab',
  async (tabId: string, { dispatch, getState }) => {
    // F2: the whole-tab close is all-or-nothing — EVERY session-pane
    // identity's close evidence must confirm before ANY state moves (the
    // closed-tab snapshot, the reopen stack, the tab list, the layout). One
    // failed close keeps the whole tab standing, exactly the TabBar
    // shift-close kill lane's rule ("a kill whose close envelope failed
    // leaves BOTH the terminal running AND the tab standing").
    //
    // F1: the tab's evidence is ONE batch envelope — ONE `panes.closed`
    // carrying the full pane set, ONE correlated answer, ONE atomic journal
    // record server-side. A partial per-pane durable outcome is impossible
    // by construction (pre-fix, an acked pane committed its record beside a
    // sibling's failed one and the still-standing tab's recovery suppressed
    // the visibly open acked pane). On failure/timeout the tab stays, EVERY
    // gated pane wears the error (there is no per-pane answer to partition
    // by — the batch resolved as one op), and the kept set re-asserts open
    // (F2 — see the reassert helper).
    //
    // Focused-episode-7 round 4 (Finding F3) — the close FREEZES the pane
    // identity set: the batch names exactly the panes the tab held when the
    // user acted, the panes slice refuses every pane-gaining / re-keying
    // mutation on the closing tab while the batch is in flight
    // (`panes.closingTabs` — the mid-wait split hazard), and the post-ack
    // removal applies exactly that frozen set (pre-fix the removal read the
    // CURRENT layout post-ack, so a pane minted into the still-visible tab
    // during the bounded wait was removed with no close evidence ever
    // journaled for it — and recovery could later re-offer it). A second
    // close of an already-closing tab is a no-op; the in-flight close
    // completes it.
    //
    // Delta-round-8 (Finding F2), strengthened delta-round-9 — the close-op
    // serialization rule: ONE close op per tab at a time, ANY scope. The
    // tab-scope start rejects while ANY close touching this tab is
    // outstanding — its own prior start (above) OR any pane-scope close
    // inside it (pre-fix the batch and the pane close ran concurrently and
    // could resolve in either order; the loser's timeout then re-asserted a
    // stale identity the winner's committed close had already removed, and
    // the server re-attributed it open). The pane-scope starts reject on the
    // same predicate, so even two DIFFERENT panes' closes never overlap in
    // one tab (delta-round-9: the second removal of a collapsed split was
    // refused by the last-leaf rule and left the survivor under a durable
    // close record).
    const stateAtClose = getState() as RootState
    if (hasAnyClosePending(stateAtClose.panes, tabId)) {
      log.warn('refusing to start a tab close while a close for it or one of its panes is already in flight', { tabId })
      return
    }
    const frozenLayout = stateAtClose.panes.layouts[tabId]
    const frozenPaneCloseTargets = collectPaneCloseTargets(frozenLayout)
    const frozenTab = stateAtClose.tabs.tabs.find((item) => item.id === tabId)
    const frozenPaneTitles = stateAtClose.panes.paneTitles[tabId]
    const frozenPaneTitleSetByUser = stateAtClose.panes.paneTitleSetByUser?.[tabId]
    const identities = collectPaneCloseIdentities(frozenLayout)
    const managedViews = collectManagedViewProjections(frozenLayout)
    dispatch(markTabClosing({ tabId }))
    try {
      await withManagedVisibilityTransition(async () => {
        if (paneCloseTargetSetChanged(
          dispatch,
          getState as () => RootState,
          tabId,
          frozenPaneCloseTargets,
          identities,
        )) return
        if (identities.length > 0) {
          const ack = await sendPanesClosedAndAwait(tabId, identities, { timeoutMs: KILL_ACK_TIMEOUT_MS })
          if (!ack.ok) {
            log.warn('tab close evidence was not confirmed; the tab stays', {
              tabId,
              gatedPanes: identities.map((i) => i.paneId),
            })
            const timedOut = ack.timedOut === true
            surfacePaneCloseFailures(dispatch, tabId, identities.map((identity) => ({ identity, timedOut })))
            reassertKeptPanesOpen((getState() as RootState).panes.layouts[tabId], tabId, identities)
            return
          }
          for (const identity of identities) {
            markPaneCloseEvidenceConfirmed(identity.createRequestId)
          }
        }

        if (paneCloseTargetSetChanged(
          dispatch,
          getState as () => RootState,
          tabId,
          frozenPaneCloseTargets,
          identities,
        )) return

        let managedViews: ManagedViewCloseResolution
        try {
          const resolution = resolveManagedViewIntentsToRemove(
            getState() as RootState,
            tabId,
            undefined,
            dispatch,
            getState as () => RootState,
          )
          managedViews = isPromiseLike(resolution) ? await resolution : resolution
        } catch (error) {
          log.warn('managed view identity could not be resolved; the tab stays open', {
            tabId,
            error: error instanceof Error ? error.message : String(error),
          })
          for (const identity of identities) {
            dispatch(setPaneCloseError({
              tabId,
              paneId: identity.paneId,
              error: MANAGED_VIEW_CLOSE_FAILED_MESSAGE,
            }))
          }
          reassertKeptPanesOpen((getState() as RootState).panes.layouts[tabId], tabId, identities)
          return
        }
        if (paneCloseTargetSetChanged(
          dispatch,
          getState as () => RootState,
          tabId,
          frozenPaneCloseTargets,
          identities,
        )) return
        if (managedViews.viewIntentIds.length > 0) {
          try {
            await persistManagedViewVisibility(
              managedViews.viewIntentIds,
              'detached',
              dispatch,
              getState as () => RootState,
              { initialSnapshot: managedViews.snapshot },
            )
          } catch (error) {
            log.warn('managed view detachment was not confirmed; the tab stays open', {
              tabId,
              viewIntentIds: managedViews.viewIntentIds,
              error: error instanceof Error ? error.message : String(error),
            })
            for (const identity of identities) {
              dispatch(setPaneCloseError({
                tabId,
                paneId: identity.paneId,
                error: MANAGED_VIEW_CLOSE_FAILED_MESSAGE,
              }))
            }
            reassertKeptPanesOpen((getState() as RootState).panes.layouts[tabId], tabId, identities)
            return
          }
        }

        if (paneCloseTargetSetChanged(
          dispatch,
          getState as () => RootState,
          tabId,
          frozenPaneCloseTargets,
          identities,
        )) return

        const tabRegistryState = (stateAtClose as { tabRegistry?: RootState['tabRegistry'] }).tabRegistry
        const serverInstanceId = stateAtClose.connection?.serverInstanceId || UNKNOWN_SERVER_INSTANCE_ID
        if (frozenTab && frozenLayout && tabRegistryState) {
          const paneCount = countPaneLeaves(frozenLayout)
          const openDurationMs = Math.max(0, Date.now() - (frozenTab.createdAt || Date.now()))
          const keep = shouldKeepClosedTab({
            openDurationMs,
            paneCount,
            titleSetByUser: !!frozenTab.titleSetByUser,
          })
          if (keep) {
            dispatch(recordClosedTabSnapshot(buildClosedTabRegistryRecord({
              tab: frozenTab,
              layout: frozenLayout,
              serverInstanceId,
              paneTitles: frozenPaneTitles,
              extensions: stateAtClose.extensions?.entries,
              deviceId: tabRegistryState.deviceId,
              deviceLabel: tabRegistryState.deviceLabel,
              revision: 0,
              updatedAt: Date.now(),
            })))
          }
        }

        // Push to the reopen stack so Alt+H can restore this tab
        if (frozenTab && frozenLayout) {
          dispatch(pushReopenEntry({
            tab: { ...frozenTab },
            layout: frozenLayout,
            paneTitles: frozenPaneTitles || {},
            paneTitleSetByUser: frozenPaneTitleSetByUser || {},
            closedAt: Date.now(),
          }))
        }

        // Closing a tab counts as a user touch on its sessions: ratchet each
        // one's locally-stored activity timestamp at close-commit time so the
        // just-closed session floats to the top of the grey section under the
        // default 'activity' sort (the grey tier consumes the ratchet with
        // presence-priority — compareByStatusTiers in
        // selectors/sidebarSelectors.ts). Two loops over the frozen pre-close
        // snapshot, both ratchet-only (updateSessionActivity never lowers a
        // stored value):
        //
        // 1. Canonical session refs — collectSessionRefsFromTabs covers both
        //    layout leaves and layout-less tabs (buildTabFallbackLocator).
        // 2. Leaf contents whose own locators are empty but still correspond
        //    to sidebar rows: registry-only canonical identity (sessionRef /
        //    codex durability known only to the terminal directory),
        //    identity-less live-terminal fallback rows keyed
        //    `<mode>:terminal:<terminalId>`, and terminals whose directory
        //    entry hasn't loaded yet — liveTerminalRowIdentity resolves the
        //    right key (or none) per content.
        //
        // Unconditional by design: REST/MCP/server-broadcast closes flow
        // through this same thunk on every connected client (ui-commands.ts
        // tab.close → closeTab), so a mirrored close ratchets too —
        // harmless-to-useful under ratchet-only semantics. The app-level
        // grey-transition touch watcher (store/sessionGreyTouch.ts) also
        // touches tier-visible keys at close; the overlap is equally harmless.
        if (frozenTab) {
          const touchedAt = Date.now()
          for (const ref of collectSessionRefsFromTabs([frozenTab], stateAtClose.panes)) {
            dispatch(updateSessionActivity({
              sessionId: ref.sessionId,
              provider: ref.provider,
              lastInputAt: touchedAt,
            }))
          }
          if (frozenLayout) {
            const directoryItems = (stateAtClose as {
              terminalDirectory?: RootState['terminalDirectory']
            }).terminalDirectory?.windows?.sidebar?.items
            for (const content of collectPaneContents(frozenLayout)) {
              const identity = liveTerminalRowIdentity(
                content,
                content.kind === 'terminal' && content.terminalId
                  ? directoryItems?.find((item) => item.terminalId === content.terminalId)
                  : undefined,
              )
              if (!identity) continue
              // identity.key is pre-composed and contains colons, so
              // makeSessionKey passes it through unchanged (provider is kept
              // for dispatch parity with the canonical loop above, not for
              // key construction).
              dispatch(updateSessionActivity({
                sessionId: identity.key,
                provider: identity.provider,
                lastInputAt: touchedAt,
              }))
            }
          }
        }

        // The frozen set is authoritative (F3): remove the tab and the layout
        // and clean up exactly the panes the acknowledged batch covered — with
        // the freeze above, the current layout equals it by construction.
        const paneIds = collectPaneIds(frozenLayout)

        markLocalClosePersistencePending(getState)
        dispatch(removeTab(tabId))
        dispatch(removeLayout({ tabId }))

        // Clean up attention and drafts for the tab and all its panes
        dispatch(clearTabAttention({ tabId }))
        for (const paneId of paneIds) {
          dispatch(clearPaneAttention({ paneId }))
          clearDraft(paneId)
        }
        dispatch(flushPersistedLayoutNow())
      })
    } finally {
      // removeLayout already cleared the flag on the success path; this
      // covers the failure return and any throw — a stuck flag would freeze
      // the kept tab forever.
      dispatch(clearTabClosing({ tabId }))
    }
  }
)

/** Detach a recovery-panel view that has no local tab or pane representation. */
export const detachManagedRuntimeView = createAsyncThunk(
  'tabs/detachManagedRuntimeView',
  async (viewIntentId: string, { dispatch, getState }) => {
    await withManagedVisibilityTransition(async () => {
      if (!selectManagedRuntime(getState() as RootState).available) {
        throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
      }
      const snapshot = await getManagedRuntimeInventory()
      applyManagedRuntimeInventory(snapshot, dispatch, getState as () => RootState)
      if (
        snapshot.readiness.initialScanState !== 'complete'
        || snapshot.pendingProjectionCount !== 0
      ) {
        throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
      }
      const matches = snapshot.viewIntents.filter((view) => view.viewId === viewIntentId)
      if (matches.length !== 1) throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
      const targetView = matches[0]!
      const souls = snapshot.souls.filter((soul) => soul.soulId === targetView.soulId)
      if (souls.length !== 1) throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
      if (isManagedViewRepresentedLocally(getState() as RootState, targetView, snapshot)) {
        throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
      }
      await persistManagedViewVisibility(
        [viewIntentId],
        'detached',
        dispatch,
        getState as () => RootState,
        { initialSnapshot: snapshot },
      )
    })
  },
)

/**
 * The context-menu "Replace pane" close gate (delta-r7-round-3, F2): the
 * discarded pane's identity removal needs its confirmed close evidence
 * exactly like a plain X-close — the pane becomes a picker only once the
 * journal acked. On failure the original content stays and wears the error.
 */
export const replacePaneWithCleanup = createAsyncThunk(
  'tabs/replacePaneWithCleanup',
  async ({ tabId, paneId }: { tabId: string; paneId: string }, { dispatch, getState }) => {
    // Delta-round-8 (Finding F2), strengthened delta-round-9 — the close-op
    // serialization rule (the same shared guard): the replace gate IS a
    // single-pane close of the discarded pane, so it rejects while ANY close
    // touching the tab is already outstanding — the pane's own close, a
    // DIFFERENT pane's close, or the whole tab's — never deferred.
    const initialState = getState() as RootState
    if (hasAnyClosePending(initialState.panes, tabId)) {
      log.warn('refusing to start a pane replace while a close is already in flight for its tab', { tabId, paneId })
      return
    }
    const before = initialState.panes.layouts[tabId]
    const identity = collectPaneCloseIdentities(before).filter((i) => i.paneId === paneId)
    const targetContent = before ? findPaneContent(before, paneId) : null
    const targetIdentity = targetContent ? paneCloseTargetIdentity(targetContent) : undefined
    const freezePane = targetIdentity !== undefined
    if (freezePane) {
      dispatch(markPaneClosing({ tabId, paneId }))
    }
    let paneFreezeHeld = freezePane
    try {
      await withManagedVisibilityTransition(async () => {
        if (targetIdentity && paneCloseTargetChanged(
          dispatch,
          getState as () => RootState,
          tabId,
          paneId,
          targetIdentity,
          identity,
        )) return
        if (identity.length > 0) {
          const failed = await awaitPaneCloseEvidence(identity)
          if (failed.length > 0) {
            log.warn('replace-pane close evidence was not confirmed; the pane keeps its content', {
              tabId,
              paneId,
            })
            surfacePaneCloseFailures(dispatch, tabId, failed)
            reassertKeptPanesOpen((getState() as RootState).panes.layouts[tabId], tabId, identity)
            return
          }
        }

        if (targetIdentity && paneCloseTargetChanged(
          dispatch,
          getState as () => RootState,
          tabId,
          paneId,
          targetIdentity,
          identity,
        )) return

        let managedViews: ManagedViewCloseResolution
        try {
          const resolution = resolveManagedViewIntentsToRemove(
            getState() as RootState,
            tabId,
            paneId,
            dispatch,
            getState as () => RootState,
          )
          managedViews = isPromiseLike(resolution) ? await resolution : resolution
        } catch (error) {
          log.warn('managed view identity could not be resolved; the pane keeps its content', {
            tabId,
            paneId,
            error: error instanceof Error ? error.message : String(error),
          })
          dispatch(setPaneCloseError({ tabId, paneId, error: MANAGED_VIEW_CLOSE_FAILED_MESSAGE }))
          reassertKeptPanesOpen((getState() as RootState).panes.layouts[tabId], tabId, identity)
          return
        }
        if (targetIdentity && paneCloseTargetChanged(
          dispatch,
          getState as () => RootState,
          tabId,
          paneId,
          targetIdentity,
          identity,
        )) return
        if (managedViews.viewIntentIds.length > 0) {
          try {
            await persistManagedViewVisibility(
              managedViews.viewIntentIds,
              'detached',
              dispatch,
              getState as () => RootState,
              { initialSnapshot: managedViews.snapshot },
            )
          } catch (error) {
            log.warn('managed view detachment was not confirmed; the pane keeps its content', {
              tabId,
              paneId,
              viewIntentIds: managedViews.viewIntentIds,
              error: error instanceof Error ? error.message : String(error),
            })
            dispatch(setPaneCloseError({ tabId, paneId, error: MANAGED_VIEW_CLOSE_FAILED_MESSAGE }))
            reassertKeptPanesOpen((getState() as RootState).panes.layouts[tabId], tabId, identity)
            return
          }
        }

        if (targetIdentity && paneCloseTargetChanged(
          dispatch,
          getState as () => RootState,
          tabId,
          paneId,
          targetIdentity,
          identity,
        )) return

        if (paneFreezeHeld) {
          dispatch(clearPaneClosing({ tabId, paneId }))
          paneFreezeHeld = false
        }
        const layoutBeforeReplacement = (getState() as RootState).panes.layouts[tabId]
        const hadPaneToReplace = Boolean(layoutBeforeReplacement && findPaneContent(layoutBeforeReplacement, paneId))
        const closePersistenceAlreadyPending = isLocalClosePersistencePending(getState)
        if (hadPaneToReplace) markLocalClosePersistencePending(getState)
        dispatch(replacePane({ tabId, paneId }))
        const after = (getState() as RootState).panes.layouts[tabId]
        const afterContent = after ? findPaneContent(after, paneId) : null
        if (afterContent && afterContent.kind !== 'picker') {
          if (hadPaneToReplace && !closePersistenceAlreadyPending) {
            clearLocalClosePersistencePending(getState)
          }
          log.warn('pane replacement was refused after managed view detachment; the pane keeps its content', { tabId, paneId })
          dispatch(setPaneCloseError({ tabId, paneId, error: PANE_CLOSE_REMOVAL_REFUSED_MESSAGE }))
          reassertKeptPanesOpen(after, tabId, identity)
          return
        }
        if (afterContent?.kind === 'picker') {
          clearDetachedManagedTabProjection(
            tabId,
            managedViews.viewIntentIds,
            dispatch,
            getState as () => RootState,
          )
          if (hadPaneToReplace) dispatch(flushPersistedLayoutNow())
        }
      })
    } finally {
      if (paneFreezeHeld) dispatch(clearPaneClosing({ tabId, paneId }))
    }
  }
)

export const reopenClosedTab = createAsyncThunk(
  'tabs/reopenClosedTab',
  async (_, { dispatch, getState }) => {
    await withManagedVisibilityTransition(async () => {
      const state = getState() as RootState
      const stack = state.tabRegistry.reopenStack
      if (stack.length === 0) return

      const entry = stack[stack.length - 1]
      const runtime = selectManagedRuntime(state)
      const preserveCreateRequestIds = entry.tab.preserveCreateRequestIdsOnNextReopen === true
      const needsManagedPreflight = hasManagedRuntimeReopenCandidate(entry.tab, entry.layout, runtime)
      let runtimeSnapshot: ManagedRuntimeInventorySnapshot | undefined
      let restoredLayout = entry.layout
      let managedViewIntentIds: string[] = []
      if (needsManagedPreflight) {
        if (!runtime.available) throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
        runtimeSnapshot = await getManagedRuntimeInventory()
        if (
          runtimeSnapshot.readiness.initialScanState !== 'complete'
          || runtimeSnapshot.pendingProjectionCount !== 0
        ) {
          throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
        }
        const prepared = prepareManagedRuntimeReopenLayout(entry.layout, runtimeSnapshot, entry.tab)
        restoredLayout = prepared.layout
        managedViewIntentIds = prepared.viewIntentIds
        if (managedViewIntentIds.length === 0) throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
        const localRepresentations = locallyRepresentedManagedReopenViews(
          getState() as RootState,
          managedViewIntentIds,
          runtimeSnapshot,
        )
        if (localRepresentations.ambiguous) throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
        if (localRepresentations.representedViewIntentIds.size > 0) {
          const currentState = getState() as RootState
          const alreadyRestoredTab = findAlreadyRestoredManagedReopenTab(currentState, restoredLayout)
          if (alreadyRestoredTab) {
            if (currentState.panes.closingTabs?.[alreadyRestoredTab.id] || hasAnyClosePending(currentState.panes, alreadyRestoredTab.id)) {
              throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
            }
            const redundantTabIds = planRedundantManagedProjectionTabRemoval(
              currentState,
              managedViewIntentIds,
              localRepresentations.representationsByViewIntentId,
              alreadyRestoredTab.id,
            )
            applyManagedRuntimeInventory(runtimeSnapshot, dispatch, getState as () => RootState)
            for (const redundantTabId of redundantTabIds) {
              dispatch(removeTab(redundantTabId))
              dispatch(removeLayout({ tabId: redundantTabId }))
            }
            for (const { paneId, content } of collectPaneEntries(restoredLayout)) {
              if (content.kind !== 'terminal' || !content.viewIntentId) continue
              dispatch(updatePaneContent({
                tabId: alreadyRestoredTab.id,
                paneId,
                content,
              }))
            }
            dispatch(setActiveTab(alreadyRestoredTab.id))
            for (const identity of collectPaneCloseIdentities(restoredLayout)) {
              sendPaneOpened({ createRequestId: identity.createRequestId, tabId: alreadyRestoredTab.id })
            }
            await persistManagedViewVisibility(
              managedViewIntentIds,
              'visible',
              dispatch,
              getState as () => RootState,
              { initialSnapshot: runtimeSnapshot },
            )
            dispatch(consumeClosedEntry({ tabId: entry.tab.id, closedAt: entry.closedAt }))
            return
          }

          const mergePlan = planManagedReopenProjectionMerge(
            currentState,
            managedViewIntentIds,
            localRepresentations.representationsByViewIntentId,
            localRepresentations.representationCountByViewIntentId,
          )
          applyManagedRuntimeInventory(runtimeSnapshot, dispatch, getState as () => RootState)

          for (const redundantTabId of mergePlan.redundantTabIds) {
            dispatch(removeTab(redundantTabId))
            dispatch(removeLayout({ tabId: redundantTabId }))
          }
          const {
            id: _savedTabId,
            preserveCreateRequestIdsOnNextReopen: _preserveCreateRequestIdsOnNextReopen,
            ...savedTabFields
          } = entry.tab
          dispatch(updateTab({ id: mergePlan.targetTabId, updates: savedTabFields }))
          dispatch(restoreLayout({
            tabId: mergePlan.targetTabId,
            layout: restoredLayout,
            paneTitles: entry.paneTitles,
            paneTitleSetByUser: entry.paneTitleSetByUser,
            preserveCreateRequestIds,
            preserveManagedRuntimeHandles: true,
            replaceExistingLayout: true,
          }))
          dispatch(setActiveTab(mergePlan.targetTabId))
          const mergedLayout = (getState() as RootState).panes.layouts[mergePlan.targetTabId]
          if (!mergedLayout || !sameRestoredPaneTopology(restoredLayout, mergedLayout)) {
            throw new Error(MANAGED_VIEW_CLOSE_FAILED_MESSAGE)
          }
          for (const identity of collectPaneCloseIdentities(restoredLayout)) {
            sendPaneOpened({ createRequestId: identity.createRequestId, tabId: mergePlan.targetTabId })
          }
          await persistManagedViewVisibility(
            managedViewIntentIds,
            'visible',
            dispatch,
            getState as () => RootState,
            { initialSnapshot: runtimeSnapshot },
          )
          dispatch(consumeClosedEntry({ tabId: entry.tab.id, closedAt: entry.closedAt }))
          return
        }
        applyManagedRuntimeInventory(runtimeSnapshot, dispatch, getState as () => RootState)
      }

      const newTabId = nanoid()
      let localRestoreCommitted = false
      try {
        dispatch(addTab({
          id: newTabId,
          title: entry.tab.title,
          titleSetByUser: entry.tab.titleSetByUser,
          mode: entry.tab.mode,
          shell: entry.tab.shell,
          initialCwd: entry.tab.initialCwd,
          codingCliProvider: entry.tab.codingCliProvider,
          resumeSessionId: entry.tab.resumeSessionId,
          sessionMetadataByKey: entry.tab.sessionMetadataByKey,
          // Unified agent names (Task 6): the reopened tab keeps the frozen
          // pointer — restoreLayout preserves the layout's pane ids verbatim.
          nameSource: entry.tab.nameSource,
        }))
        dispatch(restoreLayout({
          tabId: newTabId,
          layout: restoredLayout,
          paneTitles: entry.paneTitles,
          paneTitleSetByUser: entry.paneTitleSetByUser,
          preserveCreateRequestIds,
          preserveManagedRuntimeHandles: true,
        }))
        localRestoreCommitted = true

        // Reopened panes must consume any durable close evidence before the
        // visibility transition completes. The existing helper listens for
        // the correlated result and retries failures on a later ready sweep.
        for (const identity of collectPaneCloseIdentities(restoredLayout)) {
          sendPaneOpened({ createRequestId: identity.createRequestId, tabId: newTabId })
        }

        if (managedViewIntentIds.length > 0) {
          await persistManagedViewVisibility(
            managedViewIntentIds,
            'visible',
            dispatch,
            getState as () => RootState,
            { initialSnapshot: runtimeSnapshot },
          )
        }
        dispatch(consumeClosedEntry({ tabId: entry.tab.id, closedAt: entry.closedAt }))
      } catch (error) {
        if (localRestoreCommitted) {
          dispatch(removeTab(newTabId))
          dispatch(removeLayout({ tabId: newTabId }))
        }
        log.warn('managed tab reopen failed; its saved entry remains available to retry', {
          tabId: newTabId,
          viewIntentIds: managedViewIntentIds,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    })
  }
)

export const openSessionTab = createAsyncThunk(
  'tabs/openSessionTab',
  async (
    { sessionId, title, cwd, provider, sessionType, terminalId, forceNew, firstUserMessage, isSubagent, isNonInteractive, hasTitle, liveTerminalOnly }: {
      sessionId: string
      title?: string
      cwd?: string
      provider?: CodingCliProviderName
      sessionType?: string
      terminalId?: string
      forceNew?: boolean
      firstUserMessage?: string
      isSubagent?: boolean
      isNonInteractive?: boolean
      /** Only sync title into an existing tab when the session title is a real rename (not a synthesized fallback). */
      hasTitle?: boolean
      /** Live-only fallback terminals are not durable provider sessions yet. */
      liveTerminalOnly?: boolean
    },
    { dispatch, getState }
  ) => {
    const resolvedProvider = provider || 'claude'
    const resolvedSessionType = sessionType || resolvedProvider
    const state = getState() as RootState
    const localServerInstanceId = (state as Partial<RootState>).connection?.serverInstanceId
    const extensions = (state as Partial<RootState>).extensions?.entries ?? []
    const freshAgentType = resolveFreshAgentType(resolvedSessionType)
    const freshAgentProviderConfig = getFreshAgentProviderConfig(resolvedSessionType)
    const freshAgentProviderSettings = freshAgentType || freshAgentProviderConfig
      ? state.settings?.settings.freshAgent?.providers?.[resolvedSessionType]
      : undefined
    const sessionMetadataInput = {
      sessionType: resolvedSessionType,
      firstUserMessage,
      isSubagent,
      isNonInteractive,
    }

    const buildSessionMetadataByKey = (existing?: Tab['sessionMetadataByKey']) =>
      mergeSessionMetadataByKey(existing, resolvedProvider, sessionId, sessionMetadataInput)

    const desiredResumeContent = buildResumeContent({
      sessionType: resolvedSessionType,
      sessionId,
      cwd,
      freshAgentProviderSettings,
    })

    const updateExistingTabMetadata = (tab: Tab | undefined) => {
      if (!tab) return
      const sessionMetadataByKey = buildSessionMetadataByKey(tab.sessionMetadataByKey)
      if (sessionMetadataByKey === tab.sessionMetadataByKey) return
      dispatch(updateTab({
        id: tab.id,
        updates: { sessionMetadataByKey },
      }))
    }

    const repairExistingTabLayout = (tab: Tab | undefined) => {
      if (!tab) return
      const layout = state.panes.layouts[tab.id]
      if (!layout) return

      const matchingLeaves: Array<{ id: string; content: PaneContent }> = []
      const visit = (node: PaneNode) => {
        if (node.type === 'leaf') {
          const content = node.content
          const sessionRef = (content as { sessionRef?: { provider?: unknown; sessionId?: unknown } }).sessionRef
          const matchesExplicitSessionRef =
            typeof sessionRef?.provider === 'string'
            && typeof sessionRef?.sessionId === 'string'
            && sessionRef.provider === resolvedProvider
            && sessionRef.sessionId === sessionId
          const matchesImplicitSessionRef = (
            content.kind === 'terminal'
            && content.mode === resolvedProvider
            && content.resumeSessionId === sessionId
          ) || (
            content.kind === 'fresh-agent'
            && content.provider === resolvedProvider
            && content.resumeSessionId === sessionId
          )
          if (matchesExplicitSessionRef || matchesImplicitSessionRef) {
            matchingLeaves.push({ id: node.id, content })
          }
          return
        }
        visit(node.children[0])
        visit(node.children[1])
      }

      visit(layout)

      if (matchingLeaves.length !== 1) return
      const [{ id: paneId, content }] = matchingLeaves
      if (content.kind === 'terminal' && content.terminalId) return

      if (matchesDesiredResumeContentKind(content, desiredResumeContent)) return

      dispatch(updatePaneContent({
        tabId: tab.id,
        paneId,
        content: desiredResumeContent,
      }))
    }

    if (terminalId) {
      if (!forceNew) {
        const existingTabId = selectTabIdByTerminalId(state, terminalId)
        const existingTab = existingTabId
          ? state.tabs.tabs.find((t) => t.id === existingTabId)
          : undefined
        if (existingTab) {
          updateExistingTabMetadata(existingTab)
          if (title && hasTitle && title !== existingTab.title && !existingTab.titleSetByUser) {
            dispatch(updateTab({ id: existingTab.id, updates: { title } }))
          }
          if (hasTitle && title) {
            dispatch(updatePaneTitleByTerminalId({ terminalId, title, setByUser: false }))
          }
          dispatch(setActiveTab(existingTab.id))
          return
        }
      }
      // Running terminals are always terminal panes (fresh-agent uses SDK, not PTY)
      const tabId = nanoid()
      dispatch(addTab({
        id: tabId,
        // Coding agents name by working directory; provider label is the fallback.
        title: title || (cwd ? basenameSegment(cwd) : null) || getProviderLabel(resolvedProvider, extensions),
        status: 'running',
        mode: resolvedProvider,
        codingCliProvider: resolvedProvider,
        initialCwd: cwd,
        sessionRef: desiredResumeContent.sessionRef,
        sessionMetadataByKey: buildSessionMetadataByKey(),
      }))
      dispatch(initLayout({
        tabId,
        content: {
          kind: 'terminal',
          mode: resolvedProvider,
          terminalId,
          serverInstanceId: localServerInstanceId,
          sessionRef: liveTerminalOnly ? undefined : desiredResumeContent.sessionRef,
          initialCwd: cwd,
          status: 'running',
        },
      }))
      return
    }

    if (!forceNew) {
      const existingTabId = findTabIdForSession(
        state,
        { provider: resolvedProvider, sessionId },
        localServerInstanceId,
      )
      if (existingTabId) {
        const existingTab = state.tabs.tabs.find((tab) => tab.id === existingTabId)
        updateExistingTabMetadata(existingTab)
        if (existingTab && title && hasTitle && title !== existingTab.title && !existingTab.titleSetByUser) {
          dispatch(updateTab({ id: existingTab.id, updates: { title } }))
        }
        if (hasTitle && title) {
          const layout = state.panes.layouts[existingTabId]
          if (layout) {
            const syncPaneTitles = (node: PaneNode) => {
              if (node.type === 'leaf') {
                const content = node.content
                const sessionRef = (content as { sessionRef?: { provider?: unknown; sessionId?: unknown } }).sessionRef
                const matchesExplicitRef =
                  typeof sessionRef?.provider === 'string'
                  && typeof sessionRef?.sessionId === 'string'
                  && sessionRef.provider === resolvedProvider
                  && sessionRef.sessionId === sessionId
                const matchesImplicitRef = (
                  (content.kind === 'terminal' && content.mode === resolvedProvider && content.resumeSessionId === sessionId) ||
                  (content.kind === 'fresh-agent' && content.provider === resolvedProvider && content.resumeSessionId === sessionId)
                )
                if (matchesExplicitRef || matchesImplicitRef) {
                  dispatch(updatePaneTitle({ tabId: existingTabId, paneId: node.id, title, setByUser: false }))
                }
                return
              }
              syncPaneTitles(node.children[0])
              syncPaneTitles(node.children[1])
            }
            syncPaneTitles(layout)
          }
        }
        repairExistingTabLayout(existingTab)
        dispatch(setActiveTab(existingTabId))
        return
      }
    }

    // For fresh-agent sessions, create a tab then immediately set up the resolved layout
    // so TabContent's fallback initLayout (which always creates terminal panes) doesn't win
    if (desiredResumeContent.kind === 'fresh-agent') {
      const tabId = nanoid()
      dispatch(addTab({
        id: tabId,
        title: title || (cwd ? basenameSegment(cwd) : null) || freshAgentType?.label || getFreshAgentProviderLabel(resolvedSessionType),
        mode: resolvedProvider,
        codingCliProvider: resolvedProvider,
        initialCwd: cwd,
        sessionRef: desiredResumeContent.sessionRef,
        sessionMetadataByKey: buildSessionMetadataByKey(),
      }))
      dispatch(initLayout({
        tabId,
        content: desiredResumeContent,
      }))
      return
    }

    const tabId = nanoid()
    dispatch(addTab({
      id: tabId,
      title: title || (cwd ? basenameSegment(cwd) : null) || getProviderLabel(resolvedProvider, extensions),
      mode: resolvedProvider,
      codingCliProvider: resolvedProvider,
      initialCwd: cwd,
      sessionRef: desiredResumeContent.sessionRef,
      sessionMetadataByKey: buildSessionMetadataByKey(),
    }))
    dispatch(initLayout({
      tabId,
      content: desiredResumeContent,
    }))
  }
)

export default tabsSlice.reducer
