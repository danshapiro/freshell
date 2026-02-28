import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import { nanoid } from 'nanoid'
import type { PanesState, PaneContent, PaneContentInput, PaneNode } from './paneTypes'
import { derivePaneTitle } from '@/lib/derivePaneTitle'
import { isValidClaudeSessionId } from '@/lib/claude-session-id'
import { loadPersistedPanes } from './persistMiddleware.js'
import { TABS_STORAGE_KEY } from './storage-keys'
import { createLogger } from '@/lib/client-logger'


const log = createLogger('PanesSlice')

/**
 * Normalize terminal input to full PaneContent with defaults.
 */
function normalizeContent(input: PaneContentInput): PaneContent {
  if (input.kind === 'terminal') {
    const mode = input.mode || 'shell'
    // Only validate Claude resume IDs; other providers pass through unchanged.
    const resumeSessionId =
      mode === 'claude' && isValidClaudeSessionId(input.resumeSessionId)
        ? input.resumeSessionId
        : mode === 'claude'
          ? undefined
          : input.resumeSessionId
    const explicitSessionRef = input.sessionRef
      && typeof input.sessionRef.provider === 'string'
      && typeof input.sessionRef.sessionId === 'string'
      && (input.sessionRef.provider !== 'claude' || isValidClaudeSessionId(input.sessionRef.sessionId))
      ? input.sessionRef
      : undefined
    const sessionRef = explicitSessionRef
      ?? (resumeSessionId && mode !== 'shell'
        ? { provider: mode, sessionId: resumeSessionId }
        : undefined)
    return {
      kind: 'terminal',
      terminalId: input.terminalId,
      createRequestId: input.createRequestId || nanoid(),
      status: input.status || 'creating',
      mode,
      shell: input.shell || 'system',
      resumeSessionId,
      ...(sessionRef ? { sessionRef } : {}),
      initialCwd: input.initialCwd,
    }
  }
  if (input.kind === 'agent-chat') {
    const explicitSessionRef = input.sessionRef
      && typeof input.sessionRef.provider === 'string'
      && typeof input.sessionRef.sessionId === 'string'
      && (input.sessionRef.provider !== 'claude' || isValidClaudeSessionId(input.sessionRef.sessionId))
      ? input.sessionRef
      : undefined
    const sessionRef = explicitSessionRef
      ?? (input.resumeSessionId && isValidClaudeSessionId(input.resumeSessionId)
        ? { provider: 'claude' as const, sessionId: input.resumeSessionId }
        : undefined)
    return {
      kind: 'agent-chat',
      provider: input.provider,
      sessionId: input.sessionId,
      createRequestId: input.createRequestId || nanoid(),
      status: input.status || 'creating',
      resumeSessionId: input.resumeSessionId,
      ...(sessionRef ? { sessionRef } : {}),
      initialCwd: input.initialCwd,
    }
  }
  // Browser/editor/picker content passes through unchanged
  return input
}

/**
 * Remove pane layouts/activePane/paneTitles for tabs that no longer exist.
 * Reads the tab list from localStorage (already loaded by tabsSlice at this point).
 */
function cleanOrphanedLayouts(state: PanesState): PanesState {
  try {
    const rawTabs = localStorage.getItem(TABS_STORAGE_KEY)
    if (!rawTabs) return state
    const parsedTabs = JSON.parse(rawTabs)
    const tabs = parsedTabs?.tabs?.tabs
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

    for (const tabId of orphaned) {
      delete nextLayouts[tabId]
      delete nextActivePane[tabId]
      delete nextPaneTitles[tabId]
      delete nextPaneTitleSetByUser[tabId]
    }

    return {
      ...state,
      layouts: nextLayouts,
      activePane: nextActivePane,
      paneTitles: nextPaneTitles,
      paneTitleSetByUser: nextPaneTitleSetByUser,
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

/**
 * Merge incoming (remote) pane tree with local state, preserving local
 * terminal assignments that are more advanced. A local terminal pane
 * with a terminalId beats an incoming pane without one (same createRequestId).
 */
function mergeTerminalState(incoming: PaneNode, local: PaneNode): PaneNode {
  // Guard: bail to incoming if either node is malformed (corrupted localStorage)
  if (!incoming || !local || !incoming.type || !local.type) return incoming

  // If both leaves with terminal content, apply smart merge
  if (incoming.type === 'leaf' && local.type === 'leaf') {
    if (incoming.content?.kind === 'terminal' && local.content?.kind === 'terminal') {
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
          return { ...incoming, content: { ...incoming.content, resumeSessionId: local.content.resumeSessionId } }
        }
      } else if (local.content.status === 'creating') {
        // Different createRequestId and local is reconnecting: local just
        // regenerated its ID (e.g. after INVALID_TERMINAL_ID). Stale remote
        // state must not overwrite the active reconnection.
        return local
      }
    }
    return incoming
  }

  // If both splits with same structure, recurse (guard children array shape)
  if (
    incoming.type === 'split' && local.type === 'split' &&
    Array.isArray(incoming.children) && incoming.children.length === 2 &&
    Array.isArray(local.children) && local.children.length === 2
  ) {
    return {
      ...incoming,
      children: [
        mergeTerminalState(incoming.children[0], local.children[0]),
        mergeTerminalState(incoming.children[1], local.children[1]),
      ],
    }
  }

  // Structure changed (leaf↔split) or malformed children — take incoming
  return incoming
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
      const normalized = normalizeContent(content)
      state.layouts[tabId] = {
        type: 'leaf',
        id: paneId,
        content: normalized,
      }
      state.activePane[tabId] = paneId
    },

    resetLayout: (
      state,
      action: PayloadAction<{ tabId: string; content: PaneContentInput }>
    ) => {
      const { tabId, content } = action.payload
      const paneId = nanoid()
      const normalized = normalizeContent(content)
      state.layouts[tabId] = {
        type: 'leaf',
        id: paneId,
        content: normalized,
      }
      state.activePane[tabId] = paneId
      state.paneTitles[tabId] = { [paneId]: derivePaneTitle(normalized) }
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
      const normalizedContent = normalizeContent(newContent)

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
      const normalizedContent = normalizeContent(newContent)
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
    },

    updatePaneContent: (
      state,
      action: PayloadAction<{ tabId: string; paneId: string; content: PaneContent }>
    ) => {
      const { tabId, paneId, content } = action.payload
      const root = state.layouts[tabId]
      if (!root) return

      function updateContent(node: PaneNode): PaneNode {
        if (node.type === 'leaf') {
          if (node.id === paneId) {
            return { ...node, content }
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
      if (!state.paneTitleSetByUser?.[tabId]?.[paneId]) {
        if (!state.paneTitles[tabId]) {
          state.paneTitles[tabId] = {}
        }
        state.paneTitles[tabId][paneId] = derivePaneTitle(content)
      }
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
    },

    hydratePanes: (state, action: PayloadAction<PanesState>) => {
      const incoming = action.payload

      // Merge layouts: preserve local terminal assignments that are more
      // advanced than the incoming (remote) state. This prevents cross-tab
      // sync from clobbering in-progress terminal creation/attachment.
      const mergedLayouts: Record<string, PaneNode> = {}
      for (const [tabId, incomingNode] of Object.entries(incoming.layouts || {})) {
        const localNode = state.layouts[tabId]
        mergedLayouts[tabId] = localNode
          ? mergeTerminalState(incomingNode as PaneNode, localNode)
          : incomingNode as PaneNode
      }
      // Include any local-only tabs not in incoming (shouldn't normally happen,
      // but defensive)
      for (const tabId of Object.keys(state.layouts)) {
        if (!(tabId in mergedLayouts)) {
          mergedLayouts[tabId] = state.layouts[tabId]
        }
      }

      state.layouts = mergedLayouts
      state.activePane = incoming.activePane || {}
      state.paneTitles = incoming.paneTitles || {}
      // paneTitleSetByUser may not be present on old states; default to empty
      state.paneTitleSetByUser = (incoming as any).paneTitleSetByUser || {}
      // Ephemeral signals must never be hydrated from remote
      state.renameRequestTabId = null
      state.renameRequestPaneId = null
      state.zoomedPane = {}
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
      action: PayloadAction<{ terminalId: string; title: string }>
    ) => {
      const { terminalId, title } = action.payload
      for (const tabId of Object.keys(state.layouts)) {
        const paneId = findPaneIdByTerminalId(state.layouts[tabId], terminalId)
        if (paneId) {
          if (!state.paneTitles[tabId]) state.paneTitles[tabId] = {}
          state.paneTitles[tabId][paneId] = title
          // Mark as user-set so programmatic updates don't overwrite it
          if (!state.paneTitleSetByUser) state.paneTitleSetByUser = {}
          if (!state.paneTitleSetByUser[tabId]) state.paneTitleSetByUser[tabId] = {}
          state.paneTitleSetByUser[tabId][paneId] = true
        }
      }
    },
  },
})

export const {
  initLayout,
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
  removeLayout,
  hydratePanes,
  updatePaneTitle,
  updatePaneTitleByTerminalId,
  requestPaneRename,
  clearPaneRenameRequest,
  toggleZoom,
} = panesSlice.actions

export default panesSlice.reducer
export type { PanesState }
