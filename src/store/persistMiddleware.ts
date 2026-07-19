import type { Middleware } from '@reduxjs/toolkit'
import type { TabsState } from './tabsSlice'
import type { PanesState } from './paneTypes'
import type { Tab } from './types'
import { nanoid } from 'nanoid'
import { broadcastPersistedRaw } from './persistBroadcast'
import { isWellFormedPaneTree } from './paneTreeValidation.js'
import {
  LAYOUT_FRESH_AGENT_BACKUP_KEY,
  LAYOUT_FRESH_AGENT_COMMIT_MARKER_KEY,
  LAYOUT_FRESH_AGENT_PENDING_MARKER_KEY,
  PANES_SCHEMA_VERSION,
  LAYOUT_SCHEMA_VERSION,
  parsePersistedLayoutRaw,
  readRecoverablePersistedLayoutRaw,
} from './persistedState.js'
import { LAYOUT_STORAGE_KEY, PANES_STORAGE_KEY, TAB_RECENCY_STORAGE_KEY, TURN_COMPLETION_STORAGE_KEY } from './storage-keys'
import { createLogger } from '@/lib/client-logger'
import { flushPersistedLayoutNow } from './persistControl'
import { sanitizeSessionRef } from '@shared/session-contract'
import { normalizeFreshAgentEffortOverride, normalizeFreshAgentPaneModelSelection } from './paneTypes'
import {
  loadPersistedTabRecency,
  mergeTabRecencyStatesByMax,
  prunePaneTabActivityToLiveTerminalPanes,
  serializePersistableTabRecency,
  type TabRecencyState,
} from './tabRecencySlice'
import { migrateLegacyFreshAgentContent } from '@shared/fresh-agent'
import type { TurnCompletionState } from './turnCompletionSlice'


const log = createLogger('PanesPersist')

export const PERSIST_DEBOUNCE_MS = 500

const flushCallbacks = new Set<() => void>()
let flushListenersAttached = false

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

function stripTabVolatileFields(tab: Tab) {
  const sessionRef = sanitizeSessionRef(tab.sessionRef)
  return {
    ...tab,
    sessionRef,
    resumeSessionId: undefined,
    lastInputAt: undefined,
  }
}

export function resetPersistFlushListenersForTests() {
  flushCallbacks.clear()
}

export function resetPersistedPanesCacheForTests() {
  cachedPersistedPanes = undefined
}

import { migrateV2ToV3 } from './persistedState.js'

let cachedPersistedLayout: { tabs: any; panes: any; tombstones: any; persistedAt?: number } | null | undefined

// --- Destructive empty-tabs write guard ---
//
// If the persisted layout exists on disk but could not be turned into a
// usable tabs array (corrupt JSON, a thrown exception, or every tab getting
// pruned by sanitization), loadInitialTabsState() falls back to an empty
// tabs array. That in-memory emptiness is NOT trustworthy -- it's an
// artifact of a failed read, not a signal that the user closed their tabs.
// `markTabsLoadRecovery()` records that this session started in that
// untrustworthy state; `flush()` consults it before ever persisting an
// empty tabs array over a non-empty one already on disk.
let tabsLoadRecoveryInProgress = false

export function markTabsLoadRecovery(): void {
  tabsLoadRecoveryInProgress = true
}

export function wasTabsLoadRecovery(): boolean {
  return tabsLoadRecoveryInProgress
}

export function resetTabsLoadRecoveryForTests(): void {
  tabsLoadRecoveryInProgress = false
}

/**
 * Load the combined layout from v3 key, or migrate from v2 keys.
 * Cached so both tabs and panes loading see the same data.
 */
export function loadPersistedLayout(): typeof cachedPersistedLayout {
  if (cachedPersistedLayout !== undefined) return cachedPersistedLayout

  // Tracks whether there was raw persisted data on disk that we ultimately
  // failed to turn into a usable layout. If so, the caller (loadInitialTabsState)
  // is about to fall back to an empty state that must not be trusted for
  // persistence purposes -- see markTabsLoadRecovery() above.
  let rawExisted = false

  try {
    const raw = readRecoverablePersistedLayoutRaw(localStorage)
    rawExisted = !!raw
    if (raw) {
      const layoutParsed = parsePersistedLayoutRaw(raw)
      if (layoutParsed) {
        cachedPersistedLayout = {
          tabs: { tabs: layoutParsed.tabs },
          panes: layoutParsed.panes,
          tombstones: layoutParsed.tombstones,
          persistedAt: typeof layoutParsed.persistedAt === 'number' ? layoutParsed.persistedAt : undefined,
        }
        return cachedPersistedLayout
      }
    }

    // Try migration from v2 keys
    const migrated = migrateV2ToV3()
    if (migrated) {
      cachedPersistedLayout = {
        tabs: { tabs: migrated.tabs },
        panes: migrated.panes,
        tombstones: migrated.tombstones,
      }
      return cachedPersistedLayout
    }
  } catch {
    // An exception means we can't be sure whether there was something on
    // disk worth protecting -- default to the conservative assumption that
    // there was.
    rawExisted = true
  }

  if (rawExisted) {
    markTabsLoadRecovery()
  }

  cachedPersistedLayout = null
  return null
}

export function resetPersistedLayoutCacheForTests() {
  cachedPersistedLayout = undefined
}

export function loadPersistedTabs(): any | null {
  const layout = loadPersistedLayout()
  return layout?.tabs ?? null
}

/**
 * Migrate pane content to include required lifecycle/identity fields.
 */
function migratePaneContent(content: any): any {
  if (!content || typeof content !== 'object') {
    return content
  }
  content = migrateLegacyFreshAgentContent(content)
  if (content.kind === 'fresh-agent') {
    const { model: legacyModel, modelSelection: legacyModelSelection, ...rest } = content
    if (content.provider === 'codex') {
      return {
        ...rest,
        ...(typeof legacyModel === 'string' ? { model: legacyModel } : {}),
        effort: normalizeFreshAgentEffortOverride(content.effort),
      }
    }
    return {
      ...rest,
      modelSelection: normalizeFreshAgentPaneModelSelection({
        sessionType: content.sessionType,
        provider: content.provider,
        modelSelection: legacyModelSelection,
        legacyModel,
      }),
      effort: normalizeFreshAgentEffortOverride(content.effort),
    }
  }
  if (content.kind === 'browser') {
    return {
      ...content,
      browserInstanceId:
        typeof content.browserInstanceId === 'string' && content.browserInstanceId
          ? content.browserInstanceId
          : nanoid(),
      url: typeof content.url === 'string' ? content.url : '',
      devToolsOpen: typeof content.devToolsOpen === 'boolean' ? content.devToolsOpen : false,
    }
  }
  if (content.kind !== 'terminal') {
    return content
  }

  return {
    ...content,
    createRequestId: content.createRequestId || nanoid(),
    status: content.status || 'creating',
    mode: content.mode || 'shell',
    shell: content.shell || 'system',
  }
}

function stripEditorContent(content: any): any {
  if (content?.kind !== 'editor') return content
  if (content.content === '') return content
  return {
    ...content,
    content: '',
  }
}

function stripTransientSessionFields(content: any): any {
  if (!content || typeof content !== 'object') return content
  if (content.kind !== 'terminal' && content.kind !== 'fresh-agent') return content

  const sessionRef = sanitizeSessionRef(content.sessionRef)
  const {
    resumeSessionId: _resumeSessionId,
    sessionRef: _legacySessionRef,
    sessionId: _sessionId,
    ...rest
  } = content

  return {
    ...rest,
    ...(content.kind === 'fresh-agent' && !sessionRef && typeof content.serverInstanceId === 'string' && typeof content.sessionId === 'string'
      ? { sessionId: content.sessionId }
      : {}),
    ...(sessionRef ? { sessionRef } : {}),
  }
}

function stripEditorContentFromNode(node: any): any {
  if (!node) return node

  if (node.type === 'leaf') {
    const nextContent = stripTransientSessionFields(stripEditorContent(node.content))
    if (nextContent === node.content) return node
    return {
      ...node,
      content: nextContent,
    }
  }

  if (node.type === 'split') {
    if (!Array.isArray(node.children) || node.children.length < 2) {
      return node
    }
    const left = stripEditorContentFromNode(node.children[0])
    const right = stripEditorContentFromNode(node.children[1])
    if (left === node.children[0] && right === node.children[1]) return node
    return {
      ...node,
      children: [left, right],
    }
  }

  return node
}

/**
 * Recursively migrate all pane nodes in a tree.
 */
function migrateNode(node: any): any {
  if (!node) return node

  if (node.type === 'leaf') {
    return {
      ...node,
      content: migratePaneContent(node.content),
    }
  }

  if (node.type === 'split') {
    if (!Array.isArray(node.children) || node.children.length < 2) {
      return node
    }
    return {
      ...node,
      children: [
        migrateNode(node.children[0]),
        migrateNode(node.children[1]),
      ],
    }
  }

  return node
}

function dropClaudeChatNodes(node: any): any {
  if (!node) return node
  if (node.type === 'leaf') {
    if (node.content?.kind === 'claude-chat') {
      return { ...node, content: { kind: 'picker' } }
    }
    return node
  }
  if (node.type === 'split' && Array.isArray(node.children) && node.children.length >= 2) {
    return {
      ...node,
      children: [
        dropClaudeChatNodes(node.children[0]),
        dropClaudeChatNodes(node.children[1]),
      ],
    }
  }
  return node
}

let cachedPersistedPanes: any | null | undefined

export function loadPersistedPanes(): any | null {
  // Memoize: legacy migrations generate nanoid() values, so both callers
  // (panesSlice and terminal-restore) must see the same result.
  if (cachedPersistedPanes !== undefined) return cachedPersistedPanes

  // Try the combined v3 layout first
  const layout = loadPersistedLayout()
  if (layout?.panes) {
    cachedPersistedPanes = migratePanesData(layout.panes)
    return cachedPersistedPanes
  }

  // Fall back to v2 panes key
  cachedPersistedPanes = loadPersistedPanesFromV2Key()
  return cachedPersistedPanes
}

function loadPersistedPanesFromV2Key(): any | null {
  try {
    const raw = localStorage.getItem(PANES_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return migratePanesData(parsed)
  } catch {
    return null
  }
}

function migratePanesData(parsed: any): any | null {
  try {

    // Check if migration needed
    const currentVersion = parsed.version || 1
    if (currentVersion >= PANES_SCHEMA_VERSION) {
      const sanitizedLayouts: Record<string, any> = {}
      const droppedTabIds = new Set<string>()
      for (const [tabId, node] of Object.entries(parsed.layouts || {})) {
        const sanitizedNode = stripEditorContentFromNode(migrateNode(node))
        if (isWellFormedPaneTree(sanitizedNode)) {
          sanitizedLayouts[tabId] = sanitizedNode
        } else {
          droppedTabIds.add(tabId)
        }
      }
      // Already up to date, but ensure paneTitles/paneTitleSetByUser exist
      return {
        ...parsed,
        layouts: sanitizedLayouts,
        activePane: Object.fromEntries(
          Object.entries(parsed.activePane || {}).filter(([tabId]) => !droppedTabIds.has(tabId)),
        ),
        paneTitles: Object.fromEntries(
          Object.entries(parsed.paneTitles || {}).filter(([tabId]) => !droppedTabIds.has(tabId)),
        ),
        paneTitleSetByUser: Object.fromEntries(
          Object.entries(parsed.paneTitleSetByUser || {}).filter(([tabId]) => !droppedTabIds.has(tabId)),
        ),
      }
    }

    // Run migrations
    let layouts = parsed.layouts || {}
    let paneTitles = parsed.paneTitles || {}

    // Version 1 -> 2: migrate pane content to include lifecycle fields
    if (currentVersion < 2) {
      const migratedLayouts: Record<string, any> = {}
      for (const [tabId, node] of Object.entries(layouts)) {
        migratedLayouts[tabId] = migrateNode(node)
      }
      layouts = migratedLayouts
    }

    // Version 2 -> 3: add paneTitles (already defaulted to {} above)
    // No additional migration needed, just ensure the field exists

    // Version 4 -> 5: drop claude-chat panes.
    if (currentVersion < 5) {
      const droppedLayouts: Record<string, any> = {}
      for (const [tabId, node] of Object.entries(layouts)) {
        droppedLayouts[tabId] = dropClaudeChatNodes(node)
      }
      layouts = droppedLayouts
    }

    // Version 5 -> 6: assign stable browser instance ids.
    if (currentVersion < 6) {
      const migratedLayouts: Record<string, any> = {}
      for (const [tabId, node] of Object.entries(layouts)) {
        migratedLayouts[tabId] = migrateNode(node)
      }
      layouts = migratedLayouts
    }

    // Version 6 -> 7: migrate fresh-agent model/effort persistence to selection strategies.
    if (currentVersion < 7) {
      const migratedLayouts: Record<string, any> = {}
      for (const [tabId, node] of Object.entries(layouts)) {
        migratedLayouts[tabId] = migrateNode(node)
      }
      layouts = migratedLayouts
    }

    const sanitizedLayouts: Record<string, any> = {}
    const droppedTabIds = new Set<string>()
    for (const [tabId, node] of Object.entries(layouts)) {
      const sanitizedNode = stripEditorContentFromNode(node)
      if (isWellFormedPaneTree(sanitizedNode)) {
        sanitizedLayouts[tabId] = sanitizedNode
      } else {
        droppedTabIds.add(tabId)
      }
    }

    return {
      layouts: sanitizedLayouts,
      activePane: Object.fromEntries(
        Object.entries(parsed.activePane || {}).filter(([tabId]) => !droppedTabIds.has(tabId)),
      ),
      paneTitles: Object.fromEntries(
        Object.entries(paneTitles).filter(([tabId]) => !droppedTabIds.has(tabId)),
      ),
      paneTitleSetByUser: Object.fromEntries(
        Object.entries(parsed.paneTitleSetByUser || {}).filter(([tabId]) => !droppedTabIds.has(tabId)),
      ),
      version: PANES_SCHEMA_VERSION,
    }
  } catch {
    return null
  }
}

type PersistState = {
  tabs?: TabsState
  panes?: PanesState
  tabRecency?: TabRecencyState
  turnCompletion?: TurnCompletionState
}

export const persistMiddleware: Middleware<{}, PersistState> = (store) => {
  let tabsDirty = false
  let panesDirty = false
  let tabRecencyDirty = false
  let tabRecencyPruneDirty = false
  let turnCompletionDirty = false
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  // See "Destructive empty-tabs write guard" above loadPersistedLayout().
  // If this session's initial tabs load was a recovery from a failed/partial
  // read, an empty in-memory tabs array is not trustworthy until real tab
  // content is observed -- at which point emptiness (e.g. the user closing
  // their last tab) becomes a genuine, persistable action again.
  let distrustEmptyTabs = wasTabsLoadRecovery()

  const canUseStorage = () => typeof localStorage !== 'undefined'

  const flush = () => {
    flushTimer = null
    if (!canUseStorage()) return
    if (!tabsDirty && !panesDirty && !tabRecencyDirty && !turnCompletionDirty) return

    const state = store.getState()

    if ((state.tabs?.tabs?.length ?? 0) > 0) {
      distrustEmptyTabs = false
    }

    try {
      if (tabsDirty || panesDirty) {
        const nextTabs = state.tabs?.tabs ?? []

        if (nextTabs.length === 0 && distrustEmptyTabs && canUseStorage()) {
          const existingRaw = localStorage.getItem(LAYOUT_STORAGE_KEY)
          if (existingRaw) {
            log.warn(
              'Refusing to persist empty tabs: this session recovered from a failed/partial ' +
              'layout load and no genuine tab activity has been observed yet. Leaving the ' +
              'existing persisted layout untouched to avoid destroying it.',
            )
            tabsDirty = false
            panesDirty = false
            if (!tabRecencyDirty && !turnCompletionDirty) return
          }
        }
      }

      if (tabsDirty || panesDirty) {
        // Prune tombstones older than 1 hour
        const TOMBSTONE_MAX_AGE_MS = 60 * 60 * 1000
        const tombstoneCutoff = Date.now() - TOMBSTONE_MAX_AGE_MS
        const tombstones = (state.tabs?.tombstones || []).filter((t: { deletedAt: number }) => t.deletedAt > tombstoneCutoff)

        const sanitizedLayouts: Record<string, any> = {}
        if (state.panes?.layouts) {
          for (const [tabId, node] of Object.entries(state.panes.layouts)) {
            sanitizedLayouts[tabId] = stripEditorContentFromNode(node)
          }
        }

        let persistablePanesSection: Record<string, any> = {
          layouts: sanitizedLayouts,
          version: PANES_SCHEMA_VERSION,
        }
        if (state.panes) {
          const {
            renameRequestTabId: _rrt,
            renameRequestPaneId: _rrp,
            zoomedPane: _zp,
            refreshRequestsByPane: _rrbp,
            restoreFallbackAttemptsByPane: _rfabp,
            ...persistablePanes
          } = state.panes
          persistablePanesSection = {
            ...persistablePanes,
            layouts: sanitizedLayouts,
            version: PANES_SCHEMA_VERSION,
          }
        }

        const layoutPayload = {
          persistedAt: Date.now(),
          version: LAYOUT_SCHEMA_VERSION,
          tabs: {
            activeTabId: state.tabs?.activeTabId ?? null,
            tabs: (state.tabs?.tabs ?? []).map(stripTabVolatileFields),
          },
          panes: persistablePanesSection,
          tombstones,
        }

        const raw = JSON.stringify(layoutPayload)
        localStorage.setItem(LAYOUT_STORAGE_KEY, raw)
        localStorage.removeItem(LAYOUT_FRESH_AGENT_BACKUP_KEY)
        localStorage.removeItem(LAYOUT_FRESH_AGENT_COMMIT_MARKER_KEY)
        localStorage.removeItem(LAYOUT_FRESH_AGENT_PENDING_MARKER_KEY)
        broadcastPersistedRaw(LAYOUT_STORAGE_KEY, raw)
      }

      if (tabRecencyDirty) {
        const liveTabIds = new Set((state.tabs?.tabs ?? []).map((tab) => tab.id))
        const nextTabRecency = serializePersistableTabRecency(
          state.tabRecency ?? { paneLastInputAt: {} },
          tabRecencyPruneDirty ? state.panes?.layouts ?? {} : undefined,
          tabRecencyPruneDirty ? liveTabIds : undefined,
        )
        const persistedTabRecency = tabRecencyPruneDirty
          ? nextTabRecency
          : mergeTabRecencyStatesByMax(
            loadPersistedTabRecency(localStorage.getItem(TAB_RECENCY_STORAGE_KEY)),
            { paneLastInputAt: nextTabRecency.paneLastInputAt },
          )
        const rawTabRecency = JSON.stringify({
          version: 1,
          paneLastInputAt: persistedTabRecency.paneLastInputAt,
        })
        localStorage.setItem(TAB_RECENCY_STORAGE_KEY, rawTabRecency)
        broadcastPersistedRaw(TAB_RECENCY_STORAGE_KEY, rawTabRecency)
      }

      if (turnCompletionDirty) {
        const rawTurnCompletion = JSON.stringify({
          version: 1,
          attentionByTab: state.turnCompletion?.attentionByTab ?? {},
          attentionByPane: state.turnCompletion?.attentionByPane ?? {},
          lastAppliedCompletionSeqByTerminalId: state.turnCompletion?.lastAppliedCompletionSeqByTerminalId ?? {},
        })
        localStorage.setItem(TURN_COMPLETION_STORAGE_KEY, rawTurnCompletion)
        broadcastPersistedRaw(TURN_COMPLETION_STORAGE_KEY, rawTurnCompletion)
      }
    } catch (err) {
      log.error('Failed to save to localStorage:', err)
    }

    tabsDirty = false
    panesDirty = false
    tabRecencyDirty = false
    tabRecencyPruneDirty = false
    turnCompletionDirty = false
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
    const previousState = store.getState()
    const result = next(action)
    const state = store.getState()

    const a = action as any
    if (a?.type === flushPersistedLayoutNow.type) {
      flushNow()
      return result
    }
    if (a?.meta?.skipPersist) {
      return result
    }

    if (typeof a?.type === 'string') {
      const tabsChanged = state.tabs !== previousState.tabs
      const panesChanged = state.panes !== previousState.panes
      const tabRecencyChanged = state.tabRecency !== previousState.tabRecency
      const turnCompletionChanged = (
        state.turnCompletion?.attentionByTab !== previousState.turnCompletion?.attentionByTab
        || state.turnCompletion?.attentionByPane !== previousState.turnCompletion?.attentionByPane
        || state.turnCompletion?.lastAppliedCompletionSeqByTerminalId !== previousState.turnCompletion?.lastAppliedCompletionSeqByTerminalId
      )

      if (a.type.startsWith('tabs/') && tabsChanged) {
        tabsDirty = true
        scheduleFlush()
      }
      if (a.type.startsWith('panes/') && panesChanged) {
        panesDirty = true
        scheduleFlush()
      }
      if (a.type.startsWith('tabRecency/') && tabRecencyChanged) {
        tabRecencyDirty = true
        if (a.type === prunePaneTabActivityToLiveTerminalPanes.type) {
          tabRecencyPruneDirty = true
        }
        scheduleFlush()
      }
      if (turnCompletionChanged) {
        turnCompletionDirty = true
        scheduleFlush()
      }
    }

    return result
  }
}
