import { createSlice, PayloadAction, createAsyncThunk } from '@reduxjs/toolkit'
import type { Tab, TerminalStatus, TabMode, ShellType, CodingCliProviderName } from './types'
import { nanoid } from 'nanoid'
import { closePane, initLayout, restoreLayout, removeLayout, replacePane, setPaneCloseError, updatePaneContent, updatePaneTitleByTerminalId, updatePaneTitle } from './panesSlice'
import { clearTabAttention, clearPaneAttention } from './turnCompletionSlice.js'
import type { PaneContent, PaneNode } from './paneTypes'
import { findTabIdForSession } from '@/lib/session-utils'
import { getProviderLabel } from '@/lib/coding-cli-utils'
import { basenameSegment } from '@shared/path-basename'
import { buildResumeContent } from '@/lib/session-type-utils'
import { getFreshAgentProviderConfig, getFreshAgentProviderLabel } from '@/lib/fresh-agent-provider-utils'
import { resolveFreshAgentType } from '@/lib/fresh-agent-registry'
import { recordClosedTabSnapshot, pushReopenEntry, popReopenEntry } from './tabRegistrySlice'
import { clearDraft } from '@/lib/draft-store'
import {
  buildClosedTabRegistryRecord,
  countPaneLeaves,
  shouldKeepClosedTab,
} from '@/lib/tab-registry-snapshot'
import { UNKNOWN_SERVER_INSTANCE_ID } from './tabRegistryConstants'
import { KILL_ACK_TIMEOUT_MS, PANE_CLOSE_ACK_TIMEOUT_MESSAGE, PANE_CLOSE_FAILED_MESSAGE, sendPaneClosedAndAwait, sendPaneOpened, sendPanesClosedAndAwait } from '@/lib/kill-ack'
import { collectPaneEntries } from '@/lib/pane-utils'
import { markPaneCloseEvidenceConfirmed } from '@/lib/pane-close-evidence-marks'
import type { RootState } from './store'
import { selectTabIdByTerminalId } from './selectors/paneTerminalSelectors'
import { loadPersistedLayout, markTabsLoadRecovery } from './persistMiddleware'
import { createLogger } from '@/lib/client-logger'
import { mergeSessionMetadataByKey, sessionMetadataKey } from '@/lib/session-metadata'
import { mergeSessionMetadataForPreferredResumeId } from './persistControl'
import { migrateLegacyTerminalDurableState, sanitizeSessionRef } from '@shared/session-contract'
import { sanitizeTabsAgainstLayouts } from '@/lib/tab-fallback-identity'


const log = createLogger('TabsSlice')

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
}

export const tabsSlice = createSlice({
  name: 'tabs',
  initialState,
  reducers: {
    addTab: (state, action: PayloadAction<AddTabPayload | undefined>) => {
      // Dedupe by session is handled in openSessionTab using pane state.
      const payload = action.payload || {}

      const id = payload.id || nanoid()
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
        createdAt: Date.now(),
        updatedAt: Date.now(),
        titleSetByUser: payload.titleSetByUser,
        lastInputAt: undefined,
      }
      state.tabs.push(tab)
      state.activeTabId = id
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
          merged.push(protectCanonicalFallbackIdentity(localTab, remoteTab, titledTab))
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
  },
})

export const {
  addTab,
  setActiveTab,
  requestTabRename,
  clearTabRenameRequest,
  updateTab,
  removeTab,
  hydrateTabs,
  reorderTabs,
  switchToNextTab,
  switchToPrevTab,
} = tabsSlice.actions

function collectPaneIds(node: PaneNode | undefined): string[] {
  if (!node) return []
  if (node.type === 'leaf') return [node.id]
  return [...collectPaneIds(node.children[0]), ...collectPaneIds(node.children[1])]
}

/**
 * Delta-r7-round-3 (focused-episode-7 round 2, Finding F2) — the acknowledged
 * close gate. EVERY user- or system-initiated pane removal routes through one
 * of the three gated thunks below (`closePaneWithCleanup`, `closeTab`,
 * `replacePaneWithCleanup`), and each terminal-pane identity's durable close
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

/** Terminal-pane identities (crid-bearing) in a layout subtree — the gate's unit. */
function collectPaneCloseIdentities(layout: PaneNode | undefined): PaneCloseIdentity[] {
  if (!layout) return []
  const identities: PaneCloseIdentity[] = []
  for (const { paneId, content } of collectPaneEntries(layout)) {
    if (content.kind !== 'terminal') continue
    if (!content.createRequestId) continue // the pathological legacy shape sends nothing
    identities.push({
      paneId,
      createRequestId: content.createRequestId,
      ...(content.terminalId ? { terminalId: content.terminalId } : {}),
    })
  }
  return identities
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
 */
function reassertKeptPanesOpen(tabId: string, identities: PaneCloseIdentity[]) {
  for (const identity of identities) {
    sendPaneOpened({ createRequestId: identity.createRequestId, tabId })
  }
}

/**
 * Close a pane and clean up its attention state.
 * If the target pane is the tab's only pane, closes the tab instead.
 * Otherwise only clears attention if closePane actually removed the pane (i.e. layout changed).
 */
export const closePaneWithCleanup = createAsyncThunk(
  'tabs/closePaneWithCleanup',
  async ({ tabId, paneId }: { tabId: string; paneId: string }, { dispatch, getState }) => {
    const before = (getState() as RootState).panes.layouts[tabId]
    if (before?.type === 'leaf' && before.id === paneId) {
      await dispatch(closeTab(tabId))
      return
    }
    // F2: confirm the durable close evidence BEFORE the layout loses the pane.
    const identity = collectPaneCloseIdentities(before).filter((i) => i.paneId === paneId)
    if (identity.length > 0) {
      const failed = await awaitPaneCloseEvidence(identity)
      if (failed.length > 0) {
        log.warn('pane close evidence was not confirmed; the pane stays', { tabId, paneId })
        surfacePaneCloseFailures(dispatch, tabId, failed)
        reassertKeptPanesOpen(tabId, identity)
        return
      }
    }
    dispatch(closePane({ tabId, paneId }))
    const after = (getState() as RootState).panes.layouts[tabId]
    if (before !== after) {
      clearDraft(paneId)
      dispatch(clearPaneAttention({ paneId }))
      dispatch(clearTabAttention({ tabId }))
    }
  }
)

export const closeTab = createAsyncThunk(
  'tabs/closeTab',
  async (tabId: string, { dispatch, getState }) => {
    // F2: the whole-tab close is all-or-nothing — EVERY terminal-pane
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
    const identities = collectPaneCloseIdentities((getState() as RootState).panes.layouts[tabId])
    if (identities.length > 0) {
      const ack = await sendPanesClosedAndAwait(tabId, identities, { timeoutMs: KILL_ACK_TIMEOUT_MS })
      if (!ack.ok) {
        log.warn('tab close evidence was not confirmed; the tab stays', {
          tabId,
          gatedPanes: identities.map((i) => i.paneId),
        })
        const timedOut = ack.timedOut === true
        surfacePaneCloseFailures(dispatch, tabId, identities.map((identity) => ({ identity, timedOut })))
        reassertKeptPanesOpen(tabId, identities)
        return
      }
      // Confirmed: mark every identity so the detach middleware's belt skips
      // the redundant duplicate sends (the one-shot mark/consume pattern).
      for (const identity of identities) {
        markPaneCloseEvidenceConfirmed(identity.createRequestId)
      }
    }
    const stateBeforeClose = getState() as RootState
    const tab = stateBeforeClose.tabs.tabs.find((item) => item.id === tabId)
    const layout = stateBeforeClose.panes.layouts[tabId]
    const tabRegistryState = (stateBeforeClose as { tabRegistry?: RootState['tabRegistry'] }).tabRegistry
    const serverInstanceId = stateBeforeClose.connection?.serverInstanceId || UNKNOWN_SERVER_INSTANCE_ID
    if (tab && layout && tabRegistryState) {
      const paneCount = countPaneLeaves(layout)
      const openDurationMs = Math.max(0, Date.now() - (tab.createdAt || Date.now()))
      const keep = shouldKeepClosedTab({
        openDurationMs,
        paneCount,
        titleSetByUser: !!tab.titleSetByUser,
      })
      if (keep) {
        dispatch(recordClosedTabSnapshot(buildClosedTabRegistryRecord({
          tab,
          layout,
          serverInstanceId,
          paneTitles: stateBeforeClose.panes.paneTitles[tabId],
          extensions: stateBeforeClose.extensions?.entries,
          deviceId: tabRegistryState.deviceId,
          deviceLabel: tabRegistryState.deviceLabel,
          revision: 0,
          updatedAt: Date.now(),
        })))
      }
    }

    // Push to the reopen stack so Alt+H can restore this tab
    if (tab && layout) {
      dispatch(pushReopenEntry({
        tab: { ...tab },
        layout,
        paneTitles: stateBeforeClose.panes.paneTitles[tabId] || {},
        paneTitleSetByUser: stateBeforeClose.panes.paneTitleSetByUser?.[tabId] || {},
        closedAt: Date.now(),
      }))
    }

    // Collect all pane IDs before removing the layout
    const currentLayout = (getState() as RootState).panes.layouts[tabId]
    const paneIds = collectPaneIds(currentLayout)

    dispatch(removeTab(tabId))
    dispatch(removeLayout({ tabId }))

    // Clean up attention and drafts for the tab and all its panes
    dispatch(clearTabAttention({ tabId }))
    for (const paneId of paneIds) {
      dispatch(clearPaneAttention({ paneId }))
      clearDraft(paneId)
    }
  }
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
    const identity = collectPaneCloseIdentities(
      (getState() as RootState).panes.layouts[tabId],
    ).filter((i) => i.paneId === paneId)
    if (identity.length > 0) {
      const failed = await awaitPaneCloseEvidence(identity)
      if (failed.length > 0) {
        log.warn('replace-pane close evidence was not confirmed; the pane keeps its content', {
          tabId,
          paneId,
        })
        surfacePaneCloseFailures(dispatch, tabId, failed)
        reassertKeptPanesOpen(tabId, identity)
        return
      }
    }
    dispatch(replacePane({ tabId, paneId }))
  }
)

export const reopenClosedTab = createAsyncThunk(
  'tabs/reopenClosedTab',
  async (_, { dispatch, getState }) => {
    const state = getState() as RootState
    const stack = state.tabRegistry.reopenStack
    if (stack.length === 0) return

    const entry = stack[stack.length - 1]
    dispatch(popReopenEntry())

    const newTabId = nanoid()
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
    }))
    dispatch(restoreLayout({
      tabId: newTabId,
      layout: entry.layout,
      paneTitles: entry.paneTitles,
      paneTitleSetByUser: entry.paneTitleSetByUser,
    }))
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
