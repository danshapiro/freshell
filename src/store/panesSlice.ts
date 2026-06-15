import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import { nanoid } from 'nanoid'
import {
  normalizeFreshAgentEffortOverride,
  normalizeFreshAgentModelSelection,
  type LivePaneContentInput,
  type PanesState,
  type PaneContent,
  type PaneContentInput,
  type PaneNode,
  type PaneRefreshRequest,
  type TerminalPaneContent,
} from './paneTypes'
import { derivePaneTitle } from '@/lib/derivePaneTitle'
import { matchesDerivedPaneTitle } from '@/lib/pane-title'
import { isValidClaudeSessionId } from '@/lib/claude-session-id'
import { buildPaneRefreshTarget, paneRefreshTargetMatchesContent } from '@/lib/pane-utils'
import { loadPersistedPanes, loadPersistedTabs } from './persistMiddleware.js'
import { hasPaneTreeShape, isWellFormedPaneTree } from './paneTreeValidation.js'
import { createLogger } from '@/lib/client-logger'
import { shouldPreserveLocalCanonicalResumeSessionId } from './persistControl'
import { RestoreErrorSchema, sanitizeSessionRef, type RestoreError } from '@shared/session-contract'
import { sanitizeCodexDurabilityRef } from '@shared/codex-durability'
import { migrateLegacyFreshAgentContent, migrateLegacyFreshAgentDurableState } from '@shared/fresh-agent'
import { normalizeFreshAgentStyleOverride } from '@shared/settings'


const log = createLogger('PanesSlice')

type HydratePanesMeta = {
  localLayoutPersistedAt?: number
  remoteLayoutPersistedAt?: number
}

function buildPreservedSessionRef(
  localContent: Extract<PaneContent, { kind: 'terminal' | 'fresh-agent' }>,
  _preservedResumeSessionId?: string,
) {
  return sanitizeSessionRef(localContent.sessionRef)
}

function readRestoreError(value: unknown): RestoreError | undefined {
  const parsed = RestoreErrorSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/**
 * Normalize pane content to the full persisted/runtime shape.
 */
function normalizePaneContent(
  rawInput: PaneContentInput | PaneContent | Record<string, unknown>,
  previous?: PaneContent,
): PaneContent {
  const input = migrateLegacyFreshAgentContent(rawInput as Record<string, unknown>) as LivePaneContentInput | PaneContent
  if (input.kind === 'terminal') {
    const mode = typeof input.mode === 'string' ? input.mode : 'shell'
    const inputResumeSessionId = typeof input.resumeSessionId === 'string'
      ? input.resumeSessionId
      : undefined
    const resumeSessionId = inputResumeSessionId
    const sessionRef = sanitizeSessionRef(input.sessionRef)
    const codexDurability = sanitizeCodexDurabilityRef(input.codexDurability)
    const restoreError = RestoreErrorSchema.safeParse((input as { restoreError?: unknown }).restoreError)
    return {
      kind: 'terminal',
      terminalId: typeof input.terminalId === 'string' ? input.terminalId : undefined,
      createRequestId: typeof input.createRequestId === 'string' && input.createRequestId
        ? input.createRequestId
        : nanoid(),
      status: typeof input.status === 'string' ? input.status : 'creating',
      mode,
      shell: typeof input.shell === 'string' ? input.shell : 'system',
      resumeSessionId,
      ...(sessionRef ? { sessionRef } : {}),
      ...(codexDurability ? { codexDurability } : {}),
      serverInstanceId: typeof input.serverInstanceId === 'string' ? input.serverInstanceId : undefined,
      streamId: typeof input.streamId === 'string' && input.streamId.length > 0 ? input.streamId : undefined,
      ...(restoreError.success ? { restoreError: restoreError.data } : {}),
      initialCwd: typeof input.initialCwd === 'string' ? input.initialCwd : undefined,
    }
  }
  if (input.kind === 'browser') {
    const previousBrowserInstanceId =
      previous?.kind === 'browser' ? previous.browserInstanceId : undefined
    return {
      kind: 'browser',
      browserInstanceId:
        typeof input.browserInstanceId === 'string' && input.browserInstanceId
          ? input.browserInstanceId
          : previousBrowserInstanceId || nanoid(),
      url: typeof input.url === 'string' ? input.url : '',
      devToolsOpen: typeof input.devToolsOpen === 'boolean' ? input.devToolsOpen : false,
    }
  }
  if (input.kind === 'fresh-agent') {
    const rawFreshAgent = input as Record<string, unknown>
    const existingRestoreError = readRestoreError(rawFreshAgent.restoreError)
    const style = normalizeFreshAgentStyleOverride((input as { style?: unknown }).style)
    if (existingRestoreError) {
      return {
        kind: 'fresh-agent',
        sessionType: input.sessionType,
        provider: input.provider,
        sessionId: input.sessionId,
        createRequestId: input.createRequestId || nanoid(),
        status: input.status || 'creating',
        ...(existingRestoreError.reason === 'invalid_legacy_restore_target'
          ? {}
          : { resumeSessionId: input.resumeSessionId }),
        serverInstanceId: typeof input.serverInstanceId === 'string' ? input.serverInstanceId : undefined,
        restoreError: existingRestoreError,
        initialCwd: input.initialCwd,
        createError: input.createError,
        modelSelection: normalizeFreshAgentModelSelection(
          (input as { modelSelection?: unknown }).modelSelection,
          (input as { model?: unknown }).model,
        ),
        model: input.model,
        permissionMode: input.permissionMode,
        sandbox: input.sandbox,
        effort: normalizeFreshAgentEffortOverride(input.effort),
        plugins: input.plugins,
        ...(style ? { style } : {}),
        settingsDismissed: input.settingsDismissed,
        showThinking: typeof input.showThinking === 'boolean' ? input.showThinking : undefined,
        showTools: typeof input.showTools === 'boolean' ? input.showTools : undefined,
        showTimecodes: typeof input.showTimecodes === 'boolean' ? input.showTimecodes : undefined,
      }
    }

    const durableState = migrateLegacyFreshAgentDurableState({
      provider: input.provider,
      sessionRef: input.sessionRef,
      resumeSessionId: typeof input.resumeSessionId === 'string'
        ? input.resumeSessionId
        : (typeof rawFreshAgent.timelineSessionId === 'string'
            ? rawFreshAgent.timelineSessionId
            : (typeof rawFreshAgent.cliSessionId === 'string' ? rawFreshAgent.cliSessionId : undefined)),
      rejectNonCanonicalClaudeSessionRef: true,
    })
    const sessionRef = durableState.sessionRef
    return {
      kind: 'fresh-agent',
      sessionType: input.sessionType,
      provider: input.provider,
      sessionId: input.sessionId,
      createRequestId: input.createRequestId || nanoid(),
      status: input.status || 'creating',
      ...(typeof input.resumeSessionId === 'string' ? { resumeSessionId: input.resumeSessionId } : {}),
      ...(sessionRef ? { sessionRef } : {}),
      serverInstanceId: typeof input.serverInstanceId === 'string' ? input.serverInstanceId : undefined,
      ...('restoreError' in durableState && durableState.restoreError ? { restoreError: durableState.restoreError } : {}),
      initialCwd: input.initialCwd,
      createError: input.createError,
      modelSelection: normalizeFreshAgentModelSelection(
        (input as { modelSelection?: unknown }).modelSelection,
        (input as { model?: unknown }).model,
      ),
      model: input.model,
      permissionMode: input.permissionMode,
      sandbox: input.sandbox,
      effort: normalizeFreshAgentEffortOverride(input.effort),
      plugins: input.plugins,
      ...(style ? { style } : {}),
      settingsDismissed: input.settingsDismissed,
      showThinking: typeof input.showThinking === 'boolean' ? input.showThinking : undefined,
      showTools: typeof input.showTools === 'boolean' ? input.showTools : undefined,
      showTimecodes: typeof input.showTimecodes === 'boolean' ? input.showTimecodes : undefined,
    }
  }
  if (input.kind === 'extension') {
    return input  // Extension content passes through unchanged
  }
  // Editor/picker content passes through unchanged
  return input
}

function shouldPreferLocalAgentPaneDuringHydration(
  localContent: PaneContent,
  incomingContent: PaneContent,
  meta: HydratePanesMeta | undefined,
): boolean {
  const localIsAgentPane = localContent.kind === 'fresh-agent'
  const incomingIsAgentPane = incomingContent.kind === 'fresh-agent'
  if (!localIsAgentPane || !incomingIsAgentPane || localContent.kind !== incomingContent.kind) {
    return false
  }

  const localLayoutPersistedAt = meta?.localLayoutPersistedAt
  const remoteLayoutPersistedAt = meta?.remoteLayoutPersistedAt
  if (
    typeof localLayoutPersistedAt !== 'number'
    || typeof remoteLayoutPersistedAt !== 'number'
    || remoteLayoutPersistedAt >= localLayoutPersistedAt
  ) {
    return false
  }

  return isValidClaudeSessionId(localContent.resumeSessionId)
}

/**
 * Remove pane layouts/activePane/paneTitles for tabs that no longer exist.
 * Reads the tab list from localStorage (already loaded by tabsSlice at this point).
 */
function cleanOrphanedLayouts(state: PanesState): PanesState {
  try {
    const persistedTabs = loadPersistedTabs()
    if (!persistedTabs) return state
    const tabs = persistedTabs?.tabs?.tabs
    if (!Array.isArray(tabs)) return state

    const tabIds = new Set(tabs.map((t: any) => t?.id).filter(Boolean))
    const layoutTabIds = Object.keys(state.layouts)
    const orphaned = layoutTabIds.filter(id => !tabIds.has(id))

    if (orphaned.length === 0) return state

    log.debug('Cleaning orphaned pane layouts:', orphaned)

    const nextLayouts = { ...state.layouts }
    const nextActivePane = { ...state.activePane }
    const nextPaneTitles = { ...state.paneTitles }
    const nextPaneTitleSetByUser = { ...state.paneTitleSetByUser }
    const nextRefreshRequestsByPane = { ...state.refreshRequestsByPane }
    const nextRestoreFallbackAttemptsByPane = { ...state.restoreFallbackAttemptsByPane }

    for (const tabId of orphaned) {
      delete nextLayouts[tabId]
      delete nextActivePane[tabId]
      delete nextPaneTitles[tabId]
      delete nextPaneTitleSetByUser[tabId]
      delete nextRefreshRequestsByPane[tabId]
      delete nextRestoreFallbackAttemptsByPane[tabId]
    }

    return {
      ...state,
      layouts: nextLayouts,
      activePane: nextActivePane,
      paneTitles: nextPaneTitles,
      paneTitleSetByUser: nextPaneTitleSetByUser,
      refreshRequestsByPane: nextRefreshRequestsByPane,
      restoreFallbackAttemptsByPane: nextRestoreFallbackAttemptsByPane,
    }
  } catch {
    return state
  }
}

// Load persisted panes state directly at module initialization time
// This ensures the initial state includes persisted data BEFORE the store is created.
// Delegates to loadPersistedPanes() so that both Redux initial state and
// terminal-restore.ts see identically migrated data.
function loadInitialPanesState(): PanesState {
  const defaultState: PanesState = {
    layouts: {},
    activePane: {},
    paneTitles: {},
    paneTitleSetByUser: {},
    renameRequestTabId: null,
    renameRequestPaneId: null,
    zoomedPane: {},
    refreshRequestsByPane: {},
    restoreFallbackAttemptsByPane: {},
  }

  try {
    const loaded = loadPersistedPanes()
    if (!loaded) return defaultState

    log.debug('Loaded initial state from localStorage:', Object.keys(loaded.layouts || {}))
    let state: PanesState = {
      layouts: loaded.layouts || {},
      activePane: loaded.activePane || {},
      paneTitles: loaded.paneTitles || {},
      paneTitleSetByUser: loaded.paneTitleSetByUser || {},
      renameRequestTabId: null,
      renameRequestPaneId: null,
      zoomedPane: {},
      refreshRequestsByPane: {},
      restoreFallbackAttemptsByPane: {},
    }
    state = cleanOrphanedLayouts(state)
    return state
  } catch (err) {
    log.error('Failed to load from localStorage:', err)
    return defaultState
  }
}

const initialState: PanesState = loadInitialPanesState()

/**
 * Recursively walk a pane tree to find the leaf pane ID whose terminal
 * content has the given terminalId. Returns undefined if no match.
 */
function findPaneIdByTerminalId(node: PaneNode, terminalId: string): string | undefined {
  if (node.type === 'leaf') {
    if (node.content.kind === 'terminal' && node.content.terminalId === terminalId) {
      return node.id
    }
    return undefined
  }
  return findPaneIdByTerminalId(node.children[0], terminalId)
    ?? findPaneIdByTerminalId(node.children[1], terminalId)
}

// Helper to find and replace a node (leaf or split) in the tree
function findAndReplace(
  node: PaneNode,
  targetId: string,
  replacement: PaneNode
): PaneNode | null {
  // Check if this node is the target
  if (node.id === targetId) return replacement

  // If it's a leaf and not the target, no match in this branch
  if (node.type === 'leaf') return null

  // It's a split - check children recursively
  const leftResult = findAndReplace(node.children[0], targetId, replacement)
  if (leftResult) {
    return {
      ...node,
      children: [leftResult, node.children[1]],
    }
  }

  const rightResult = findAndReplace(node.children[1], targetId, replacement)
  if (rightResult) {
    return {
      ...node,
      children: [node.children[0], rightResult],
    }
  }

  return null
}

// Helper to collect all leaf nodes in order (left-to-right, top-to-bottom)
function collectLeaves(node: PaneNode): Extract<PaneNode, { type: 'leaf' }>[] {
  if (node.type === 'leaf') return [node]
  return [...collectLeaves(node.children[0]), ...collectLeaves(node.children[1])]
}

// Helper to find a leaf node by id in the tree
function findLeaf(node: PaneNode, id: string): Extract<PaneNode, { type: 'leaf' }> | null {
  if (node.type === 'leaf') return node.id === id ? node : null
  return findLeaf(node.children[0], id) || findLeaf(node.children[1], id)
}

function normalizePaneTree(node: PaneNode, previous?: PaneNode): PaneNode | null {
  const previousValid = previous && isWellFormedPaneTree(previous) ? previous : null
  if (!hasPaneTreeShape(node)) {
    return previousValid
  }
  if (node.type === 'leaf') {
    const previousLeaf = previousValid ? findLeaf(previousValid, node.id) : null
    const normalizedLeaf: Extract<PaneNode, { type: 'leaf' }> = {
      ...node,
      content: normalizePaneContent(node.content, previousLeaf?.content),
    }
    if (isWellFormedPaneTree(normalizedLeaf)) {
      return normalizedLeaf
    }
    return previousLeaf && isWellFormedPaneTree(previousLeaf) ? previousLeaf : null
  }
  const normalizedLeft = normalizePaneTree(node.children[0] as PaneNode, previousValid ?? undefined)
  const normalizedRight = normalizePaneTree(node.children[1] as PaneNode, previousValid ?? undefined)
  if (!normalizedLeft || !normalizedRight) {
    return previousValid
  }
  return {
    ...node,
    children: [normalizedLeft, normalizedRight],
  }
}

function collectLeafPaneIds(node: PaneNode): string[] {
  if (node.type === 'leaf') {
    return [node.id]
  }
  return [
    ...collectLeafPaneIds(node.children[0]),
    ...collectLeafPaneIds(node.children[1]),
  ]
}

function filterPaneMetadataByLayout<T>(
  metadata: Record<string, Record<string, T>> | undefined,
  tabId: string,
  paneIds: Set<string>,
): Record<string, T> | undefined {
  const tabMetadata = metadata?.[tabId]
  if (!tabMetadata) return undefined
  const filtered = Object.fromEntries(
    Object.entries(tabMetadata).filter(([paneId]) => paneIds.has(paneId)),
  )
  return Object.keys(filtered).length > 0 ? filtered : undefined
}

function pickHydratedActivePane(
  paneIds: string[],
  incomingActivePaneId: string | undefined,
  localActivePaneId: string | undefined,
): string | undefined {
  const paneIdSet = new Set(paneIds)
  if (incomingActivePaneId && paneIdSet.has(incomingActivePaneId)) {
    return incomingActivePaneId
  }
  if (localActivePaneId && paneIdSet.has(localActivePaneId)) {
    return localActivePaneId
  }
  return paneIds[paneIds.length - 1]
}

function mergeHydratedPaneMetadata(
  state: PanesState,
  incoming: PanesState,
  layouts: Record<string, PaneNode>,
  incomingLayoutTabIds: Set<string>,
): Pick<PanesState, 'activePane' | 'paneTitles' | 'paneTitleSetByUser'> {
  const activePane: Record<string, string> = {}
  const paneTitles: Record<string, Record<string, string>> = {}
  const paneTitleSetByUser: Record<string, Record<string, boolean>> = {}

  for (const [tabId, layout] of Object.entries(layouts)) {
    const paneIds = collectLeafPaneIds(layout)
    const paneIdSet = new Set(paneIds)
    const localLayoutPreserved = !incomingLayoutTabIds.has(tabId)
    const preferredTitleSource = localLayoutPreserved
      ? state.paneTitles
      : incoming.paneTitles
    const preferredTitleSetByUserSource = localLayoutPreserved
      ? state.paneTitleSetByUser
      : incoming.paneTitleSetByUser

    const nextActivePane = pickHydratedActivePane(
      paneIds,
      localLayoutPreserved ? undefined : incoming.activePane?.[tabId],
      state.activePane?.[tabId],
    )
    if (nextActivePane) {
      activePane[tabId] = nextActivePane
    }

    const nextPaneTitles = filterPaneMetadataByLayout(preferredTitleSource, tabId, paneIdSet)
    const fallbackTitles = !localLayoutPreserved
      ? filterPaneMetadataByLayout(state.paneTitles, tabId, paneIdSet)
      : undefined
    const localUserSetTitleFlags = !localLayoutPreserved
      ? filterPaneMetadataByLayout(state.paneTitleSetByUser, tabId, paneIdSet)
      : undefined
    if (nextPaneTitles) {
      if (fallbackTitles && localUserSetTitleFlags) {
        const merged = { ...nextPaneTitles }
        for (const [paneId, title] of Object.entries(fallbackTitles)) {
          if (localUserSetTitleFlags[paneId]) {
            merged[paneId] = title
          }
        }
        paneTitles[tabId] = merged
      } else {
        paneTitles[tabId] = nextPaneTitles
      }
    } else if (fallbackTitles) {
      paneTitles[tabId] = fallbackTitles
    }

    const nextPaneTitleSetByUser = filterPaneMetadataByLayout(
      preferredTitleSetByUserSource,
      tabId,
      paneIdSet,
    )
    const fallbackTitleSetByUser = !localLayoutPreserved
      ? filterPaneMetadataByLayout(state.paneTitleSetByUser, tabId, paneIdSet)
      : undefined
    if (nextPaneTitleSetByUser || fallbackTitleSetByUser) {
      paneTitleSetByUser[tabId] = {
        ...(nextPaneTitleSetByUser || {}),
        ...(fallbackTitleSetByUser || {}),
      }
    }
  }

  return { activePane, paneTitles, paneTitleSetByUser }
}

function clearPaneRefreshRequest(state: PanesState, tabId: string, paneId: string) {
  const tabRequests = state.refreshRequestsByPane?.[tabId]
  if (!tabRequests?.[paneId]) return

  delete tabRequests[paneId]
  if (Object.keys(tabRequests).length === 0) {
    delete state.refreshRequestsByPane?.[tabId]
  }
}

function clearRestoreFallbackAttemptForPane(state: PanesState, tabId: string, paneId: string) {
  const tabAttempts = state.restoreFallbackAttemptsByPane?.[tabId]
  if (!tabAttempts?.[paneId]) return

  delete tabAttempts[paneId]
  if (Object.keys(tabAttempts).length === 0) {
    delete state.restoreFallbackAttemptsByPane?.[tabId]
  }
}

function sessionRefsEqual(left?: { provider?: string; sessionId?: string }, right?: { provider?: string; sessionId?: string }): boolean {
  return left?.provider === right?.provider && left?.sessionId === right?.sessionId
}

function codexDurabilityMatchesCanonicalSession(
  codexDurability: TerminalPaneContent['codexDurability'],
  sessionRef: { provider?: string; sessionId?: string } | undefined,
): boolean {
  return Boolean(
    sessionRef?.provider === 'codex'
    && codexDurability?.state === 'durable'
    && codexDurability.durableThreadId === sessionRef.sessionId,
  )
}

function pickCanonicalCodexDurability(
  localContent: TerminalPaneContent,
  incomingContent: TerminalPaneContent,
  sessionRef: { provider?: string; sessionId?: string } | undefined,
): TerminalPaneContent['codexDurability'] | undefined {
  if (codexDurabilityMatchesCanonicalSession(localContent.codexDurability, sessionRef)) {
    return localContent.codexDurability
  }
  return codexDurabilityMatchesCanonicalSession(incomingContent.codexDurability, sessionRef)
    ? incomingContent.codexDurability
    : undefined
}

function preserveLocalCanonicalTerminalIdentity(
  localContent: TerminalPaneContent,
  incomingContent: TerminalPaneContent,
): TerminalPaneContent {
  const localSessionRef = sanitizeSessionRef(localContent.sessionRef)
  if (!localSessionRef) return incomingContent
  return {
    ...incomingContent,
    createRequestId: localContent.createRequestId,
    status: localContent.status,
    sessionRef: localSessionRef,
    resumeSessionId: undefined,
    terminalId: localContent.terminalId,
    serverInstanceId: localContent.serverInstanceId,
    streamId: localContent.streamId,
    codexDurability: pickCanonicalCodexDurability(localContent, incomingContent, localSessionRef),
  }
}

function reconcileRefreshRequestsForTab(state: PanesState, tabId: string) {
  const tabRequests = state.refreshRequestsByPane?.[tabId]
  if (!tabRequests) return

  const layout = state.layouts[tabId]
  if (!layout) {
    delete state.refreshRequestsByPane?.[tabId]
    return
  }

  const nextRequests: Record<string, PaneRefreshRequest> = {}
  for (const [paneId, request] of Object.entries(tabRequests)) {
    const content = findLeaf(layout, paneId)?.content
    if (paneRefreshTargetMatchesContent(request.target, content)) {
      nextRequests[paneId] = request
    }
  }

  if (Object.keys(nextRequests).length === 0) {
    delete state.refreshRequestsByPane?.[tabId]
    return
  }

  if (!state.refreshRequestsByPane) {
    state.refreshRequestsByPane = {}
  }
  state.refreshRequestsByPane[tabId] = nextRequests
}

/**
 * Merge incoming (remote) pane tree with local state, preserving local
 * terminal assignments that are more advanced. A local terminal pane
 * with a terminalId beats an incoming pane without one (same createRequestId).
 */
function mergeTerminalState(
  incoming: PaneNode,
  local: PaneNode,
  meta?: HydratePanesMeta,
): PaneNode | null {
  const incomingValid = hasPaneTreeShape(incoming)
  const localValid = hasPaneTreeShape(local)
  if (!incomingValid) return localValid ? local : null
  if (!localValid) return incoming

  // If both leaves, apply smart merge for terminal and fresh-agent content
  if (incoming.type === 'leaf' && local.type === 'leaf') {
    if (incoming.content?.kind === 'terminal' && local.content?.kind === 'terminal') {
      const localSessionRef = sanitizeSessionRef(local.content.sessionRef)
      if (incoming.content.createRequestId === local.content.createRequestId) {
        // Same createRequestId: prefer local if it has terminalId and
        // incoming is still creating (not exited). Exit state must propagate.
        if (
          local.content.terminalId && !incoming.content.terminalId &&
          incoming.content.status !== 'exited'
        ) {
          return { ...incoming, content: local.content }
        }
        // Guard resumeSessionId: if the local pane has a session and incoming
        // differs, preserve the local session. resumeSessionId is pane identity
        // (which Claude session this pane represents) and must not be silently
        // swapped by cross-tab sync from another browser tab's terminal.
        if (
          local.content.resumeSessionId &&
          incoming.content.resumeSessionId !== local.content.resumeSessionId
        ) {
          return {
            ...incoming,
            content: {
              ...incoming.content,
              resumeSessionId: local.content.resumeSessionId,
              sessionRef: buildPreservedSessionRef(local.content, local.content.resumeSessionId),
            },
          }
        }
      } else if (local.content.status === 'creating') {
        // Different createRequestId and local is reconnecting: local just
        // regenerated its ID (e.g. after INVALID_TERMINAL_ID). Stale remote
        // state must not overwrite the active reconnection.
        return local
      }

      if (localSessionRef) {
        return {
          ...incoming,
          content: preserveLocalCanonicalTerminalIdentity(local.content, incoming.content),
        }
      }
    }

    // Agent panes: prefer local sessionId and status when the local state
    // is more advanced. The persist debounce means incoming (from localStorage)
    // can be stale — e.g. status 'starting' when local has already reached 'connected'.
    if (
      incoming.content?.kind === 'fresh-agent'
      && incoming.content?.kind === local.content?.kind
    ) {
      if (shouldPreferLocalAgentPaneDuringHydration(local.content, incoming.content, meta)) {
        return local
      }
      if (incoming.content.createRequestId === local.content.createRequestId) {
        if (
          shouldPreserveLocalCanonicalResumeSessionId(
            local.content.resumeSessionId,
            incoming.content.resumeSessionId,
          )
        ) {
          return {
            ...incoming,
            content: {
              ...incoming.content,
              resumeSessionId: local.content.resumeSessionId,
              sessionRef: buildPreservedSessionRef(local.content, local.content.resumeSessionId),
            },
          }
        }
        // Preserve local sessionId if incoming doesn't have it yet
        if (local.content.sessionId && !incoming.content.sessionId) {
          return { ...incoming, content: local.content }
        }
        // Don't regress back to early states (creating/starting) once past them.
        // Normal cycles like running→idle are fine and must not be blocked.
        if (local.content.sessionId && incoming.content.sessionId === local.content.sessionId) {
          const EARLY_STATES = new Set(['creating', 'starting'])
          const localStatus = local.content.status ?? ''
          const incomingStatus = incoming.content.status ?? ''
          if (!EARLY_STATES.has(localStatus) && EARLY_STATES.has(incomingStatus)) {
            return { ...incoming, content: { ...incoming.content, status: local.content.status } }
          }
        }
      }
    }

    // Guard cross-kind overwrites: if local and incoming have different content
    // kinds, preserve local to prevent pane corruption during cross-tab sync
    if (incoming.content?.kind !== local.content?.kind) {
      return local
    }

    return incoming
  }

  // If both splits with same structure, recurse (guard children array shape)
  if (
    incoming.type === 'split' && local.type === 'split' &&
    Array.isArray(incoming.children) && incoming.children.length === 2 &&
    Array.isArray(local.children) && local.children.length === 2
  ) {
    const mergedLeft = mergeTerminalState(incoming.children[0], local.children[0], meta)
    const mergedRight = mergeTerminalState(incoming.children[1], local.children[1], meta)
    if (!mergedLeft || !mergedRight) {
      return local
    }
    return {
      ...incoming,
      children: [mergedLeft, mergedRight],
    }
  }

  // Structure changed (leaf↔split) or malformed children
  // Cross-tab sync can deliver stale structure changes. Use both timestamps
  // and content heuristics to decide which side to keep.
  if (local.type !== incoming.type) {
    const localAt = meta?.localLayoutPersistedAt
    const remoteAt = meta?.remoteLayoutPersistedAt
    const timestampsAvailable = typeof localAt === 'number' && typeof remoteAt === 'number'
    const localIsNewer = timestampsAvailable && remoteAt < localAt
    const remoteIsNewer = timestampsAvailable && remoteAt >= localAt

    if (local.type === 'split' && incoming.type === 'leaf') {
      if (localIsNewer) return local
      if (remoteIsNewer) return incoming
    }

    if (local.type === 'leaf' && incoming.type === 'split') {
      if (localIsNewer) return local
      if (remoteIsNewer) return incoming
    }
  }

  return incoming
}

/**
 * Strip stale runtime IDs from pane content so restored panes get fresh ones.
 */
function stripStaleIds(content: PaneContent): PaneContentInput {
  if (content.kind === 'terminal') {
    const { terminalId: _terminalId, createRequestId: _createRequestId, status: _status, ...rest } = content
    return rest
  }
  if (content.kind === 'browser') {
    const { browserInstanceId: _browserInstanceId, ...rest } = content
    return rest
  }
  if (content.kind === 'fresh-agent') {
    const {
      sessionId: _sessionId,
      createRequestId: _createRequestId,
      status: _status,
      serverInstanceId: _serverInstanceId,
      createError: _createError,
      ...rest
    } = content
    return rest
  }
  return content
}

/**
 * Walk a PaneNode tree, normalizing each leaf's content with fresh IDs.
 */
function normalizeRestoredTree(node: PaneNode): PaneNode {
  if (node.type === 'leaf') {
    return {
      type: 'leaf',
      id: node.id,
      content: normalizePaneContent(stripStaleIds(node.content)),
    }
  }
  return {
    type: 'split',
    id: node.id,
    direction: node.direction,
    sizes: node.sizes,
    children: [
      normalizeRestoredTree(node.children[0]),
      normalizeRestoredTree(node.children[1]),
    ],
  }
}

function findFirstLeafId(node: PaneNode): string {
  if (node.type === 'leaf') return node.id
  return findFirstLeafId(node.children[0])
}

export const panesSlice = createSlice({
  name: 'panes',
  initialState,
  reducers: {
    initLayout: (
      state,
      action: PayloadAction<{ tabId: string; content: PaneContentInput; paneId?: string }>
    ) => {
      const { tabId, content, paneId: providedPaneId } = action.payload
      // Don't overwrite existing layout
      if (state.layouts[tabId]) return

      const paneId = providedPaneId ?? nanoid()
      const normalized = normalizePaneContent(content)
      state.layouts[tabId] = {
        type: 'leaf',
        id: paneId,
        content: normalized,
      }
      state.activePane[tabId] = paneId
      state.paneTitles[tabId] = { [paneId]: derivePaneTitle(normalized) }
      reconcileRefreshRequestsForTab(state, tabId)
      delete state.restoreFallbackAttemptsByPane?.[tabId]
    },

    restoreLayout: (
      state,
      action: PayloadAction<{ tabId: string; layout: PaneNode; paneTitles: Record<string, string>; paneTitleSetByUser?: Record<string, boolean> }>
    ) => {
      const { tabId, layout, paneTitles, paneTitleSetByUser } = action.payload
      if (state.layouts[tabId]) return

      const normalizedLayout = normalizeRestoredTree(layout)
      state.layouts[tabId] = normalizedLayout
      state.activePane[tabId] = findFirstLeafId(normalizedLayout)
      state.paneTitles[tabId] = paneTitles
      if (paneTitleSetByUser && Object.keys(paneTitleSetByUser).length > 0) {
        state.paneTitleSetByUser[tabId] = paneTitleSetByUser
      }
      reconcileRefreshRequestsForTab(state, tabId)
      delete state.restoreFallbackAttemptsByPane?.[tabId]
    },

    resetLayout: (
      state,
      action: PayloadAction<{ tabId: string; content: PaneContentInput }>
    ) => {
      const { tabId, content } = action.payload
      const paneId = nanoid()
      const normalized = normalizePaneContent(content)
      state.layouts[tabId] = {
        type: 'leaf',
        id: paneId,
        content: normalized,
      }
      state.activePane[tabId] = paneId
      state.paneTitles[tabId] = { [paneId]: derivePaneTitle(normalized) }
      reconcileRefreshRequestsForTab(state, tabId)
      delete state.restoreFallbackAttemptsByPane?.[tabId]
    },

    splitPane: (
      state,
      action: PayloadAction<{
        tabId: string
        paneId: string
        direction: 'horizontal' | 'vertical'
        newContent: PaneContentInput
        newPaneId?: string
      }>
    ) => {
      const { tabId, paneId, direction, newContent, newPaneId: providedPaneId } = action.payload
      const root = state.layouts[tabId]
      if (!root) return

      const newPaneId = providedPaneId ?? nanoid()
      const normalizedContent = normalizePaneContent(newContent)

      const targetPane = findLeaf(root, paneId)
      if (!targetPane) return

      // Create the split node
      const splitNode: PaneNode = {
        type: 'split',
        id: nanoid(),
        direction,
        sizes: [50, 50],
        children: [
          { ...targetPane }, // Keep original pane
          { type: 'leaf', id: newPaneId, content: normalizedContent },
        ],
      }

      // Replace the target pane with the split
      const newRoot = findAndReplace(root, paneId, splitNode)
      if (newRoot) {
        state.layouts[tabId] = newRoot
        state.activePane[tabId] = newPaneId

        // Clear zoom so the new pane is visible
        if (state.zoomedPane?.[tabId]) {
          delete state.zoomedPane[tabId]
        }

        // Initialize title for new pane
        if (!state.paneTitles[tabId]) {
          state.paneTitles[tabId] = {}
        }
        state.paneTitles[tabId][newPaneId] = derivePaneTitle(normalizedContent)
        reconcileRefreshRequestsForTab(state, tabId)
      }
    },

    /**
     * Add a pane by splitting the active pane horizontally (to the right).
     * Preserves the existing layout structure instead of rebuilding a grid.
     * The new pane is placed to the right of the active pane and becomes active.
     */
    addPane: (
      state,
      action: PayloadAction<{
        tabId: string
        newContent: PaneContentInput
      }>
    ) => {
      const { tabId, newContent } = action.payload
      const root = state.layouts[tabId]
      if (!root) return

      const activePaneId = state.activePane[tabId]

      // Find the active pane; fall back to first leaf if active pane is missing
      const activeLeaf = (activePaneId && findLeaf(root, activePaneId))
        || collectLeaves(root)[0]
      if (!activeLeaf) return

      // Create new leaf
      const newPaneId = nanoid()
      const normalizedContent = normalizePaneContent(newContent)
      const newLeaf: PaneNode = {
        type: 'leaf',
        id: newPaneId,
        content: normalizedContent,
      }

      // Replace the active pane with a horizontal split: [activePane, newPane]
      const replacement: PaneNode = {
        type: 'split',
        id: nanoid(),
        direction: 'horizontal',
        sizes: [50, 50],
        children: [{ ...activeLeaf }, newLeaf],
      }

      const newRoot = findAndReplace(root, activeLeaf.id, replacement)
      if (!newRoot) return

      state.layouts[tabId] = newRoot
      state.activePane[tabId] = newPaneId

      // Clear zoom so the new pane is visible
      if (state.zoomedPane?.[tabId]) {
        delete state.zoomedPane[tabId]
      }

      // Initialize title for new pane
      if (!state.paneTitles[tabId]) {
        state.paneTitles[tabId] = {}
      }
      state.paneTitles[tabId][newPaneId] = derivePaneTitle(normalizedContent)
      reconcileRefreshRequestsForTab(state, tabId)
    },

    closePane: (
      state,
      action: PayloadAction<{ tabId: string; paneId: string }>
    ) => {
      const { tabId, paneId } = action.payload
      const root = state.layouts[tabId]
      if (!root) return

      // Can't close the only pane
      if (root.type === 'leaf') return

      // Find the parent split containing the target pane and replace it
      // with the surviving sibling. This preserves the rest of the tree
      // structure exactly as the user arranged it.
      // Returns [newTree, siblingNode] where siblingNode is the promoted sibling.
      function removePane(node: PaneNode, targetId: string): [PaneNode, PaneNode] | null {
        if (node.type === 'leaf') return null

        const [left, right] = node.children

        // Check if target is a direct child (leaf or split)
        if (left.id === targetId) return [right, right]
        if (right.id === targetId) return [left, left]

        // Recurse into children
        const leftResult = removePane(left, targetId)
        if (leftResult) {
          return [{ ...node, children: [leftResult[0], right] }, leftResult[1]]
        }
        const rightResult = removePane(right, targetId)
        if (rightResult) {
          return [{ ...node, children: [left, rightResult[0]] }, rightResult[1]]
        }
        return null
      }

      const result = removePane(root, paneId)
      if (result) {
        const [newRoot, sibling] = result
        state.layouts[tabId] = newRoot

        // Update active pane if the closed pane was active.
        // Focus the first leaf in the promoted sibling subtree — that's the
        // pane that now occupies the space where the closed pane was.
        if (state.activePane[tabId] === paneId) {
          const siblingLeaves = collectLeaves(sibling)
          state.activePane[tabId] = siblingLeaves[0].id
        }

        // Clean up pane title and user-set flag
        if (state.paneTitles[tabId]?.[paneId]) {
          delete state.paneTitles[tabId][paneId]
        }
        if (state.paneTitleSetByUser?.[tabId]?.[paneId]) {
          delete state.paneTitleSetByUser[tabId][paneId]
        }

        // Clear zoom if the zoomed pane was closed
        if (state.zoomedPane?.[tabId] === paneId) {
          delete state.zoomedPane[tabId]
        }

        reconcileRefreshRequestsForTab(state, tabId)
      }
    },

    setActivePane: (
      state,
      action: PayloadAction<{ tabId: string; paneId: string }>
    ) => {
      const { tabId, paneId } = action.payload
      state.activePane[tabId] = paneId
    },

    resizePanes: (
      state,
      action: PayloadAction<{ tabId: string; splitId: string; sizes: [number, number] }>
    ) => {
      const { tabId, splitId, sizes } = action.payload
      const root = state.layouts[tabId]
      if (!root) return

      function updateSizes(node: PaneNode): PaneNode {
        if (node.type === 'leaf') return node
        if (node.id === splitId) {
          return { ...node, sizes }
        }
        return {
          ...node,
          children: [updateSizes(node.children[0]), updateSizes(node.children[1])],
        }
      }

      state.layouts[tabId] = updateSizes(root)
    },

    resizeMultipleSplits: (
      state,
      action: PayloadAction<{
        tabId: string
        resizes: Array<{ splitId: string; sizes: [number, number] }>
      }>
    ) => {
      const { tabId, resizes } = action.payload
      const root = state.layouts[tabId]
      if (!root) return

      function applySizes(node: PaneNode): PaneNode {
        if (node.type === 'leaf') return node
        const match = resizes.find(r => r.splitId === node.id)
        const newSizes = match ? match.sizes : node.sizes
        return {
          ...node,
          sizes: newSizes,
          children: [applySizes(node.children[0]), applySizes(node.children[1])],
        }
      }

      state.layouts[tabId] = applySizes(root)
    },

    resetSplit: (
      state,
      action: PayloadAction<{ tabId: string; splitId: string }>
    ) => {
      const { tabId, splitId } = action.payload
      const root = state.layouts[tabId]
      if (!root) return

      function update(node: PaneNode): PaneNode {
        if (node.type === 'leaf') return node
        if (node.id === splitId) {
          return { ...node, sizes: [50, 50] }
        }
        return {
          ...node,
          children: [update(node.children[0]), update(node.children[1])],
        }
      }

      state.layouts[tabId] = update(root)
    },

    swapSplit: (
      state,
      action: PayloadAction<{ tabId: string; splitId: string }>
    ) => {
      const { tabId, splitId } = action.payload
      const root = state.layouts[tabId]
      if (!root) return

      function update(node: PaneNode): PaneNode {
        if (node.type === 'leaf') return node
        if (node.id === splitId) {
          return {
            ...node,
            children: [node.children[1], node.children[0]],
            sizes: [node.sizes[1], node.sizes[0]],
          }
        }
        return {
          ...node,
          children: [update(node.children[0]), update(node.children[1])],
        }
      }

      state.layouts[tabId] = update(root)
    },

    swapPanes: (
      state,
      action: PayloadAction<{ tabId: string; paneId: string; otherId: string }>
    ) => {
      const { tabId, paneId, otherId } = action.payload
      const root = state.layouts[tabId]
      if (!root) return

      function findLeaf(node: PaneNode, id: string): Extract<PaneNode, { type: 'leaf' }> | null {
        if (node.type === 'leaf') return node.id === id ? node : null
        return findLeaf(node.children[0], id) || findLeaf(node.children[1], id)
      }

      const a = findLeaf(root, paneId)
      const b = findLeaf(root, otherId)
      if (!a || !b) return
      const paneContent = a.content
      const otherContent = b.content

      function update(node: PaneNode): PaneNode {
        if (node.type === 'leaf') {
          if (node.id === paneId) return { ...node, content: otherContent }
          if (node.id === otherId) return { ...node, content: paneContent }
          return node
        }
        return {
          ...node,
          children: [update(node.children[0]), update(node.children[1])],
        }
      }

      state.layouts[tabId] = update(root)

      if (state.paneTitles[tabId]) {
        const titles = state.paneTitles[tabId]
        const temp = titles[paneId]
        titles[paneId] = titles[otherId]
        titles[otherId] = temp
      }

      if (state.paneTitleSetByUser[tabId]) {
        const titleSetByUser = state.paneTitleSetByUser[tabId]
        const temp = titleSetByUser[paneId]
        if (titleSetByUser[otherId] === undefined) {
          delete titleSetByUser[paneId]
        } else {
          titleSetByUser[paneId] = titleSetByUser[otherId]
        }
        if (temp === undefined) {
          delete titleSetByUser[otherId]
        } else {
          titleSetByUser[otherId] = temp
        }
      }

      reconcileRefreshRequestsForTab(state, tabId)
    },

    replacePane: (
      state,
      action: PayloadAction<{ tabId: string; paneId: string }>
    ) => {
      const { tabId, paneId } = action.payload
      const root = state.layouts[tabId]
      if (!root) return

      const pickerContent: PaneContent = { kind: 'picker' }
      let found = false

      function updateContent(node: PaneNode): PaneNode {
        if (node.type === 'leaf') {
          if (node.id === paneId) {
            found = true
            return { ...node, content: pickerContent }
          }
          return node
        }
        return {
          ...node,
          children: [updateContent(node.children[0]), updateContent(node.children[1])],
        }
      }

      state.layouts[tabId] = updateContent(root)

      if (!found) return

      // Reset title to picker-derived title ("New Tab")
      if (!state.paneTitles[tabId]) {
        state.paneTitles[tabId] = {}
      }
      state.paneTitles[tabId][paneId] = derivePaneTitle(pickerContent)

      // Clear user-set flag so title auto-derives again
      if (state.paneTitleSetByUser?.[tabId]?.[paneId]) {
        delete state.paneTitleSetByUser[tabId][paneId]
      }

      reconcileRefreshRequestsForTab(state, tabId)
    },

    updatePaneContent: (
      state,
      action: PayloadAction<{ tabId: string; paneId: string; content: PaneContentInput | PaneContent }>
    ) => {
      const { tabId, paneId, content } = action.payload
      const root = state.layouts[tabId]
      if (!root) return
      let normalizedContentForTitle: PaneContent | null = null
      let previousContentForTitle: PaneContent | null = null

      function updateContent(node: PaneNode): PaneNode {
        if (node.type === 'leaf') {
          if (node.id === paneId) {
            previousContentForTitle = node.content
            const nextContent = normalizePaneContent(content, node.content)
            normalizedContentForTitle = nextContent
            return { ...node, content: nextContent }
          }
          return node
        }
        return {
          ...node,
          children: [updateContent(node.children[0]), updateContent(node.children[1])],
        }
      }

      state.layouts[tabId] = updateContent(root)

      // Update pane title when content changes, unless user explicitly set it
      if (normalizedContentForTitle && !state.paneTitleSetByUser?.[tabId]?.[paneId]) {
        if (!state.paneTitles[tabId]) {
          state.paneTitles[tabId] = {}
        }
        const existingTitle = state.paneTitles[tabId][paneId]
        // Pane titles are stored extension-unaware in this slice; canonical labels
        // such as "OpenCode" are normalized later in the display layer.
        if (!existingTitle || (previousContentForTitle && matchesDerivedPaneTitle(existingTitle, previousContentForTitle))) {
          state.paneTitles[tabId][paneId] = derivePaneTitle(normalizedContentForTitle)
        }
      }

      reconcileRefreshRequestsForTab(state, tabId)
    },

    /** Partially merge fields into existing pane content (avoids stale-ref overwrites
     *  when multiple effects dispatch in the same render batch). */
    mergePaneContent: (
      state,
      action: PayloadAction<{ tabId: string; paneId: string; updates: Partial<PaneContent> | Record<string, unknown> }>
    ) => {
      const { tabId, paneId, updates } = action.payload
      const root = state.layouts[tabId]
      if (!root) return
      let previousContentForTitle: PaneContent | null = null

      function mergeContent(node: PaneNode): PaneNode {
        if (node.type === 'leaf') {
          if (node.id === paneId) {
            previousContentForTitle = node.content
            return {
              ...node,
              content: normalizePaneContent({ ...node.content, ...updates } as Record<string, unknown>, node.content),
            }
          }
          return node
        }
        return {
          ...node,
          children: [mergeContent(node.children[0]), mergeContent(node.children[1])],
        }
      }

      state.layouts[tabId] = mergeContent(root)

      // Update pane title if content changed in a way that affects it
      const leaf = findLeaf(state.layouts[tabId]!, paneId)
      if (leaf && !state.paneTitleSetByUser?.[tabId]?.[paneId]) {
        if (!state.paneTitles[tabId]) {
          state.paneTitles[tabId] = {}
        }
        const existingTitle = state.paneTitles[tabId][paneId]
        // Pane titles are stored extension-unaware in this slice; canonical labels
        // such as "OpenCode" are normalized later in the display layer.
        if (!existingTitle || (previousContentForTitle && matchesDerivedPaneTitle(existingTitle, previousContentForTitle))) {
          state.paneTitles[tabId][paneId] = derivePaneTitle(leaf.content)
        }
      }

      reconcileRefreshRequestsForTab(state, tabId)
    },

    restartFreshAgentCreate: (
      state,
      action: PayloadAction<{ tabId: string; paneId: string }>
    ) => {
      const { tabId, paneId } = action.payload
      const root = state.layouts[tabId]
      if (!root) return

      function restartContent(node: PaneNode): PaneNode {
        if (node.type === 'leaf') {
          if (node.id !== paneId || node.content.kind !== 'fresh-agent') {
            return node
          }
          return {
            ...node,
            content: normalizePaneContent({
              ...node.content,
              sessionId: undefined,
              createRequestId: nanoid(),
              status: 'creating',
              createError: undefined,
            }, node.content),
          }
        }
        return {
          ...node,
          children: [restartContent(node.children[0]), restartContent(node.children[1])],
        }
      }

      state.layouts[tabId] = restartContent(root)
      reconcileRefreshRequestsForTab(state, tabId)
    },

    requestPaneRefresh: (
      state,
      action: PayloadAction<{ tabId: string; paneId: string }>
    ) => {
      const { tabId, paneId } = action.payload
      const root = state.layouts[tabId]
      if (!root) return

      const leaf = findLeaf(root, paneId)
      if (!leaf) return

      const target = buildPaneRefreshTarget(leaf.content)
      if (!target) {
        clearPaneRefreshRequest(state, tabId, paneId)
        return
      }

      if (!state.refreshRequestsByPane) {
        state.refreshRequestsByPane = {}
      }
      if (!state.refreshRequestsByPane[tabId]) {
        state.refreshRequestsByPane[tabId] = {}
      }
      state.refreshRequestsByPane[tabId][paneId] = {
        requestId: nanoid(),
        target,
      }
    },

    requestTabRefresh: (
      state,
      action: PayloadAction<{ tabId: string }>
    ) => {
      const { tabId } = action.payload
      const root = state.layouts[tabId]
      if (!root) return

      // This intentional unzoom-first behavior is the user-requested and desired behavior so Refresh Tab refreshes the full tab immediately.
      if (state.zoomedPane[tabId]) {
        delete state.zoomedPane[tabId]
      }

      const nextRequests: Record<string, PaneRefreshRequest> = {}
      for (const leaf of collectLeaves(root)) {
        const target = buildPaneRefreshTarget(leaf.content)
        if (!target) continue
        nextRequests[leaf.id] = {
          requestId: nanoid(),
          target,
        }
      }

      if (Object.keys(nextRequests).length === 0) {
        delete state.refreshRequestsByPane?.[tabId]
        return
      }

      if (!state.refreshRequestsByPane) {
        state.refreshRequestsByPane = {}
      }
      state.refreshRequestsByPane[tabId] = nextRequests
    },

    consumePaneRefreshRequest: (
      state,
      action: PayloadAction<{ tabId: string; paneId: string; requestId: string }>
    ) => {
      const { tabId, paneId, requestId } = action.payload
      const request = state.refreshRequestsByPane?.[tabId]?.[paneId]
      if (!request || request.requestId !== requestId) return
      clearPaneRefreshRequest(state, tabId, paneId)
    },

    removeLayout: (
      state,
      action: PayloadAction<{ tabId: string }>
    ) => {
      const { tabId } = action.payload
      delete state.layouts[tabId]
      delete state.activePane[tabId]
      delete state.paneTitles[tabId]
      if (state.zoomedPane) {
        delete state.zoomedPane[tabId]
      }
      if (state.paneTitleSetByUser) {
        delete state.paneTitleSetByUser[tabId]
      }
      if (state.refreshRequestsByPane) {
        delete state.refreshRequestsByPane[tabId]
      }
      if (state.restoreFallbackAttemptsByPane) {
        delete state.restoreFallbackAttemptsByPane[tabId]
      }
    },

    hydratePanes: (state, action: PayloadAction<PanesState>) => {
      const meta = (action as PayloadAction<PanesState, string, HydratePanesMeta | undefined>).meta
      const incoming = action.payload

      // Merge layouts: preserve local terminal assignments that are more
      // advanced than the incoming (remote) state. This prevents cross-tab
      // sync from clobbering in-progress terminal creation/attachment.
      const mergedLayouts: Record<string, PaneNode> = {}
      const incomingLayoutTabIds = new Set<string>()
      for (const [tabId, incomingNode] of Object.entries(incoming.layouts || {})) {
        const localNode = state.layouts[tabId]
        const incomingHasShape = hasPaneTreeShape(incomingNode)
        const mergedNode = localNode
          ? mergeTerminalState(incomingNode as PaneNode, localNode, meta)
          : (incomingHasShape ? incomingNode as PaneNode : null)
        const mergeUsedIncoming = mergedNode !== localNode
        const normalizedNode = mergedNode ? normalizePaneTree(mergedNode, localNode) : null
        if (normalizedNode) {
          mergedLayouts[tabId] = normalizedNode
          if (incomingHasShape && mergeUsedIncoming) {
            incomingLayoutTabIds.add(tabId)
          }
        }
      }
      // Include any local-only tabs not in incoming (shouldn't normally happen,
      // but defensive)
      for (const tabId of Object.keys(state.layouts)) {
        if (!(tabId in mergedLayouts)) {
          const normalizedLocalNode = normalizePaneTree(state.layouts[tabId])
          if (normalizedLocalNode) {
            mergedLayouts[tabId] = normalizedLocalNode
          }
        }
      }

      state.layouts = mergedLayouts
      const nextMetadata = mergeHydratedPaneMetadata(state, incoming, mergedLayouts, incomingLayoutTabIds)
      state.activePane = nextMetadata.activePane
      state.paneTitles = nextMetadata.paneTitles
      state.paneTitleSetByUser = nextMetadata.paneTitleSetByUser
      // Ephemeral signals must never be hydrated from remote
      state.renameRequestTabId = null
      state.renameRequestPaneId = null
      state.zoomedPane = {}
      state.refreshRequestsByPane = {}
      state.restoreFallbackAttemptsByPane = {}
    },

    updatePaneTitle: (
      state,
      action: PayloadAction<{ tabId: string; paneId: string; title: string; setByUser?: boolean }>
    ) => {
      const { tabId, paneId, title, setByUser } = action.payload
      // Skip programmatic updates when user has explicitly set the title
      if (setByUser === false && state.paneTitleSetByUser?.[tabId]?.[paneId]) {
        return
      }
      if (!state.paneTitles[tabId]) {
        state.paneTitles[tabId] = {}
      }
      state.paneTitles[tabId][paneId] = title
      if (setByUser !== false) {
        if (!state.paneTitleSetByUser) {
          state.paneTitleSetByUser = {}
        }
        if (!state.paneTitleSetByUser[tabId]) {
          state.paneTitleSetByUser[tabId] = {}
        }
        state.paneTitleSetByUser[tabId][paneId] = true
      }
    },

    requestPaneRename: (
      state,
      action: PayloadAction<{ tabId: string; paneId: string }>
    ) => {
      state.renameRequestTabId = action.payload.tabId
      state.renameRequestPaneId = action.payload.paneId
    },

    clearPaneRenameRequest: (state) => {
      state.renameRequestTabId = null
      state.renameRequestPaneId = null
    },

    toggleZoom: (
      state,
      action: PayloadAction<{ tabId: string; paneId: string }>
    ) => {
      const { tabId, paneId } = action.payload
      if (state.zoomedPane[tabId] === paneId) {
        // Same pane already zoomed -> unzoom
        delete state.zoomedPane[tabId]
      } else {
        // Different pane or not zoomed -> zoom it
        state.zoomedPane[tabId] = paneId
      }
    },

    /**
     * Walk all tabs' pane trees and update the title for any pane whose
     * terminal content has the given terminalId. Used when a session rename
     * from the history view should cascade to the pane title bar.
     */
    updatePaneTitleByTerminalId: (
      state,
      action: PayloadAction<{ terminalId: string; title: string; setByUser?: boolean }>
    ) => {
      const { terminalId, title, setByUser } = action.payload
      for (const tabId of Object.keys(state.layouts)) {
        const paneId = findPaneIdByTerminalId(state.layouts[tabId], terminalId)
        if (paneId) {
          if (setByUser === false && state.paneTitleSetByUser?.[tabId]?.[paneId]) {
            continue
          }
          if (!state.paneTitles[tabId]) state.paneTitles[tabId] = {}
          state.paneTitles[tabId][paneId] = title
          if (setByUser !== false) {
            // Mark as user-set so programmatic updates don't overwrite it
            if (!state.paneTitleSetByUser) state.paneTitleSetByUser = {}
            if (!state.paneTitleSetByUser[tabId]) state.paneTitleSetByUser[tabId] = {}
            state.paneTitleSetByUser[tabId][paneId] = true
          }
        }
      }
    },

    reconcileTerminalSessionRefByTerminalId: (
      state,
      action: PayloadAction<{ terminalId: string; sessionRef: unknown }>
    ) => {
      const terminalId = action.payload.terminalId
      const sessionRef = sanitizeSessionRef(action.payload.sessionRef)
      if (!terminalId || !sessionRef) return
      const canonicalSessionRef = sessionRef

      function reconcileNode(node: PaneNode, tabId: string): void {
        if (node.type === 'leaf') {
          const content = node.content
          if (
            content.kind !== 'terminal'
            || content.terminalId !== terminalId
          ) {
            return
          }

          if (!sessionRefsEqual(content.sessionRef, canonicalSessionRef)) {
            content.sessionRef = canonicalSessionRef
          }
          content.resumeSessionId = undefined
          if (!codexDurabilityMatchesCanonicalSession(content.codexDurability, canonicalSessionRef)) {
            content.codexDurability = undefined
          }
          clearRestoreFallbackAttemptForPane(state, tabId, node.id)
          return
        }
        reconcileNode(node.children[0], tabId)
        reconcileNode(node.children[1], tabId)
      }

      for (const [tabId, layout] of Object.entries(state.layouts)) {
        reconcileNode(layout, tabId)
      }
    },

    clearDeadTerminals: (state, action: PayloadAction<{ liveTerminalIds: string[] }>) => {
      const liveSet = new Set(action.payload.liveTerminalIds)

      function clearDeadInNode(node: PaneNode, tabId: string): boolean {
        if (node.type === 'leaf') {
          if (
            node.content?.kind === 'terminal' &&
            node.content.terminalId &&
            !liveSet.has(node.content.terminalId)
          ) {
            const staleTerminalId = node.content.terminalId
            const nextRequestId = nanoid()
            node.content.terminalId = undefined
            node.content.serverInstanceId = undefined
            node.content.streamId = undefined
            node.content.status = 'creating'
            node.content.createRequestId = nextRequestId
            if (!sanitizeSessionRef(node.content.sessionRef)) {
              if (!state.restoreFallbackAttemptsByPane) state.restoreFallbackAttemptsByPane = {}
              if (!state.restoreFallbackAttemptsByPane[tabId]) state.restoreFallbackAttemptsByPane[tabId] = {}
              state.restoreFallbackAttemptsByPane[tabId][node.id] = {
                staleTerminalId,
                requestId: nextRequestId,
                reason: 'dead_live_handle_without_session_ref',
              }
            } else {
              clearRestoreFallbackAttemptForPane(state, tabId, node.id)
            }
            return true
          }
          return false
        }
        if (node.type === 'split' && Array.isArray(node.children)) {
          let changed = false
          for (const child of node.children) {
            if (clearDeadInNode(child, tabId)) changed = true
          }
          return changed
        }
        return false
      }

      for (const [tabId, layout] of Object.entries(state.layouts)) {
        clearDeadInNode(layout, tabId)
      }
    },

    repairCodexIdentityMismatch: (
      state,
      action: PayloadAction<{
        tabId: string
        paneId: string
        staleTerminalId: string
        expectedSessionRef: { provider: string; sessionId: string }
        createRequestId: string
      }>
    ) => {
      const { tabId, paneId, staleTerminalId, expectedSessionRef, createRequestId } = action.payload
      const root = state.layouts[tabId]
      if (!root) return

      function repairNode(node: PaneNode): void {
        if (node.type === 'leaf') {
          if (node.id !== paneId || node.content.kind !== 'terminal') return
          if (node.content.terminalId !== staleTerminalId) return
          if (!sessionRefsEqual(node.content.sessionRef, expectedSessionRef)) return

          node.content.terminalId = undefined
          node.content.serverInstanceId = undefined
          node.content.streamId = undefined
          node.content.status = 'creating'
          node.content.createRequestId = createRequestId
          node.content.sessionRef = expectedSessionRef
          node.content.codexDurability = codexDurabilityMatchesCanonicalSession(
            node.content.codexDurability,
            expectedSessionRef,
          )
            ? node.content.codexDurability
            : undefined
          clearRestoreFallbackAttemptForPane(state, tabId, paneId)
          return
        }
        repairNode(node.children[0])
        repairNode(node.children[1])
      }

      repairNode(root)
    },
  },
})

export const {
  initLayout,
  restoreLayout,
  resetLayout,
  splitPane,
  addPane,
  closePane,
  setActivePane,
  resizePanes,
  resizeMultipleSplits,
  resetSplit,
  swapSplit,
  replacePane,
  swapPanes,
  updatePaneContent,
  mergePaneContent,
  restartFreshAgentCreate,
  requestPaneRefresh,
  requestTabRefresh,
  consumePaneRefreshRequest,
  removeLayout,
  hydratePanes,
  updatePaneTitle,
  updatePaneTitleByTerminalId,
  reconcileTerminalSessionRefByTerminalId,
  requestPaneRename,
  clearPaneRenameRequest,
  toggleZoom,
  clearDeadTerminals,
  repairCodexIdentityMismatch,
} = panesSlice.actions

export default panesSlice.reducer
export type { PanesState }
