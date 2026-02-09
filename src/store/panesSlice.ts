import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import { nanoid } from 'nanoid'
import type { PanesState, PaneContent, PaneContentInput, PaneNode } from './paneTypes'
import { derivePaneTitle } from '@/lib/derivePaneTitle'
import { isValidClaudeSessionId } from '@/lib/claude-session-id'
import { loadPersistedPanes } from './persistMiddleware.js'

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
    return {
      kind: 'terminal',
      terminalId: input.terminalId,
      createRequestId: input.createRequestId || nanoid(),
      status: input.status || 'creating',
      mode,
      shell: input.shell || 'system',
      resumeSessionId,
      initialCwd: input.initialCwd,
    }
  }
  // Browser content passes through unchanged
  return input
}

function applyLegacyResumeSessionIds(state: PanesState): PanesState {
  if (typeof localStorage === 'undefined') return state
  const rawTabs = localStorage.getItem('freshell.tabs.v1')
  if (!rawTabs) return state

  let parsedTabs: any
  try {
    parsedTabs = JSON.parse(rawTabs)
  } catch {
    return state
  }

  const tabsState = parsedTabs?.tabs
  if (!tabsState?.tabs) return state

  const resumeByTabId = new Map<string, string>()
  for (const tab of tabsState.tabs) {
    // Legacy tabs may not have mode persisted; resumeSessionId is the signal.
    if (isValidClaudeSessionId(tab?.resumeSessionId)) {
      resumeByTabId.set(tab.id, tab.resumeSessionId)
    }
  }

  if (resumeByTabId.size === 0) return state

  const nextLayouts: Record<string, PaneNode> = {}
  let changed = false

  const findLeaf = (node: PaneNode, targetId: string): Extract<PaneNode, { type: 'leaf' }> | null => {
    if (node.type === 'leaf') return node.id === targetId ? node : null
    return findLeaf(node.children[0], targetId) || findLeaf(node.children[1], targetId)
  }

  const findFirstClaudeLeaf = (node: PaneNode): Extract<PaneNode, { type: 'leaf' }> | null => {
    if (node.type === 'leaf') {
      if (node.content.kind === 'terminal' && node.content.mode === 'claude') return node
      return null
    }
    return findFirstClaudeLeaf(node.children[0]) || findFirstClaudeLeaf(node.children[1])
  }

  const assignToTarget = (node: PaneNode, targetId: string, resumeSessionId: string): PaneNode => {
    if (node.type === 'leaf') {
      if (node.id !== targetId) return node
      if (node.content.kind !== 'terminal' || node.content.mode !== 'claude') return node
      if (node.content.resumeSessionId) return node
      changed = true
      return { ...node, content: { ...node.content, resumeSessionId } }
    }

    const left = assignToTarget(node.children[0], targetId, resumeSessionId)
    const right = assignToTarget(node.children[1], targetId, resumeSessionId)
    if (left === node.children[0] && right === node.children[1]) return node
    return { ...node, children: [left, right] }
  }

  for (const [tabId, node] of Object.entries(state.layouts)) {
    const resume = resumeByTabId.get(tabId)
    if (!resume) {
      nextLayouts[tabId] = node as PaneNode
      continue
    }

    const activeId = state.activePane[tabId]
    const activeLeaf = activeId ? findLeaf(node as PaneNode, activeId) : null
    const targetLeaf =
      activeLeaf && activeLeaf.content.kind === 'terminal' && activeLeaf.content.mode === 'claude'
        ? activeLeaf
        : findFirstClaudeLeaf(node as PaneNode)

    if (!targetLeaf) {
      nextLayouts[tabId] = node as PaneNode
      continue
    }

    nextLayouts[tabId] = assignToTarget(node as PaneNode, targetLeaf.id, resume)
  }

  return changed ? { ...state, layouts: nextLayouts } : state
}

/**
 * Remove pane layouts/activePane/paneTitles for tabs that no longer exist.
 * Reads the tab list from localStorage (already loaded by tabsSlice at this point).
 */
function cleanOrphanedLayouts(state: PanesState): PanesState {
  try {
    const rawTabs = localStorage.getItem('freshell.tabs.v1')
    if (!rawTabs) return state
    const parsedTabs = JSON.parse(rawTabs)
    const tabs = parsedTabs?.tabs?.tabs
    if (!Array.isArray(tabs)) return state

    const tabIds = new Set(tabs.map((t: any) => t?.id).filter(Boolean))
    const layoutTabIds = Object.keys(state.layouts)
    const orphaned = layoutTabIds.filter(id => !tabIds.has(id))

    if (orphaned.length === 0) return state

    if (import.meta.env.MODE === 'development') {
      console.log('[PanesSlice] Cleaning orphaned pane layouts:', orphaned)
    }

    const nextLayouts = { ...state.layouts }
    const nextActivePane = { ...state.activePane }
    const nextPaneTitles = { ...state.paneTitles }

    for (const tabId of orphaned) {
      delete nextLayouts[tabId]
      delete nextActivePane[tabId]
      delete nextPaneTitles[tabId]
    }

    return { layouts: nextLayouts, activePane: nextActivePane, paneTitles: nextPaneTitles }
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
  }

  try {
    const loaded = loadPersistedPanes()
    if (!loaded) return defaultState

    if (import.meta.env.MODE === 'development') {
      console.log('[PanesSlice] Loaded initial state from localStorage:', Object.keys(loaded.layouts || {}))
    }
    let state: PanesState = {
      layouts: loaded.layouts || {},
      activePane: loaded.activePane || {},
      paneTitles: loaded.paneTitles || {},
    }
    state = applyLegacyResumeSessionIds(state)
    state = cleanOrphanedLayouts(state)
    return state
  } catch (err) {
    if (import.meta.env.MODE === 'development') {
      console.error('[PanesSlice] Failed to load from localStorage:', err)
    }
    return defaultState
  }
}

const initialState: PanesState = loadInitialPanesState()

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

// Helper to create a horizontal split from an array of leaves
function buildHorizontalRow(leaves: Extract<PaneNode, { type: 'leaf' }>[]): PaneNode {
  if (leaves.length === 1) return leaves[0]
  if (leaves.length === 2) {
    return {
      type: 'split',
      id: nanoid(),
      direction: 'horizontal',
      sizes: [50, 50],
      children: [leaves[0], leaves[1]],
    }
  }
  // For 3+ panes in a row, nest horizontally: [a, [b, c]] -> [a, [b, [c, d]]] etc.
  // Or use a more balanced approach: split in half
  const mid = Math.ceil(leaves.length / 2)
  const left = leaves.slice(0, mid)
  const right = leaves.slice(mid)
  return {
    type: 'split',
    id: nanoid(),
    direction: 'horizontal',
    sizes: [50, 50],
    children: [buildHorizontalRow(left), buildHorizontalRow(right)],
  }
}

/**
 * Build a grid layout from leaves.
 * Pattern:
 * - 1 pane: single leaf
 * - 2 panes: [1][2] horizontal
 * - 3 panes: [1][2] top, [3] bottom (full width)
 * - 4 panes: [1][2] top, [3][4] bottom
 * - 5 panes: [1][2][3] top, [4][5] bottom
 * - 6 panes: [1][2][3] top, [4][5][6] bottom
 * - etc.
 */
function buildGridLayout(leaves: Extract<PaneNode, { type: 'leaf' }>[]): PaneNode {
  if (leaves.length === 1) return leaves[0]
  if (leaves.length === 2) {
    return {
      type: 'split',
      id: nanoid(),
      direction: 'horizontal',
      sizes: [50, 50],
      children: [leaves[0], leaves[1]],
    }
  }

  // For 3+ panes, use 2 rows with ceiling division for top row
  // 3 panes: 2 top, 1 bottom
  // 4 panes: 2 top, 2 bottom
  // 5 panes: 3 top, 2 bottom
  // 6 panes: 3 top, 3 bottom
  const topCount = Math.ceil(leaves.length / 2)
  const topLeaves = leaves.slice(0, topCount)
  const bottomLeaves = leaves.slice(topCount)

  const topRow = buildHorizontalRow(topLeaves)
  const bottomRow = buildHorizontalRow(bottomLeaves)

  return {
    type: 'split',
    id: nanoid(),
    direction: 'vertical',
    sizes: [50, 50],
    children: [topRow, bottomRow],
  }
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
      action: PayloadAction<{ tabId: string; content: PaneContentInput }>
    ) => {
      const { tabId, content } = action.payload
      // Don't overwrite existing layout
      if (state.layouts[tabId]) return

      const paneId = nanoid()
      state.layouts[tabId] = {
        type: 'leaf',
        id: paneId,
        content: normalizeContent(content),
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
      }>
    ) => {
      const { tabId, paneId, direction, newContent } = action.payload
      const root = state.layouts[tabId]
      if (!root) return

      const newPaneId = nanoid()

      // Find the target pane and get its content
      function findPane(node: PaneNode, id: string): PaneNode | null {
        if (node.type === 'leaf') return node.id === id ? node : null
        return findPane(node.children[0], id) || findPane(node.children[1], id)
      }

      const targetPane = findPane(root, paneId)
      if (!targetPane || targetPane.type !== 'leaf') return

      // Create the split node
      const splitNode: PaneNode = {
        type: 'split',
        id: nanoid(),
        direction,
        sizes: [50, 50],
        children: [
          { ...targetPane }, // Keep original pane
          { type: 'leaf', id: newPaneId, content: normalizeContent(newContent) }, // New pane with normalized content
        ],
      }

      // Replace the target pane with the split
      const newRoot = findAndReplace(root, paneId, splitNode)
      if (newRoot) {
        state.layouts[tabId] = newRoot
        state.activePane[tabId] = newPaneId

        // Initialize title for new pane
        const normalizedContent = normalizeContent(newContent)
        if (!state.paneTitles[tabId]) {
          state.paneTitles[tabId] = {}
        }
        state.paneTitles[tabId][newPaneId] = derivePaneTitle(normalizedContent)
      }
    },

    /**
     * Add a pane using grid layout pattern.
     * Restructures the entire layout to maintain the grid:
     * - 2 panes: [1][2] side by side
     * - 3 panes: [1][2] top, [3] bottom (full width)
     * - 4 panes: [1][2] / [3][4] (2x2 grid)
     * - 5 panes: [1][2][3] top, [4][5] bottom
     * - etc.
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

      // Collect existing leaves
      const existingLeaves = collectLeaves(root)

      // Create new leaf
      const newPaneId = nanoid()
      const newLeaf: Extract<PaneNode, { type: 'leaf' }> = {
        type: 'leaf',
        id: newPaneId,
        content: normalizeContent(newContent),
      }

      // Build new grid layout with all leaves
      const allLeaves = [...existingLeaves, newLeaf]
      state.layouts[tabId] = buildGridLayout(allLeaves)
      state.activePane[tabId] = newPaneId

      // Initialize title for new pane
      if (!state.paneTitles[tabId]) {
        state.paneTitles[tabId] = {}
      }
      state.paneTitles[tabId][newPaneId] = derivePaneTitle(newLeaf.content)
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

      // Collect all leaves except the one being closed
      const allLeaves = collectLeaves(root)
      const remainingLeaves = allLeaves.filter(leaf => leaf.id !== paneId)

      // If no leaves remain (shouldn't happen), bail out
      if (remainingLeaves.length === 0) return

      // Rebuild layout with remaining leaves using grid pattern
      state.layouts[tabId] = buildGridLayout(remainingLeaves)

      // Update active pane if needed
      if (state.activePane[tabId] === paneId) {
        // Set active to the last remaining leaf (similar to where the new pane would be)
        state.activePane[tabId] = remainingLeaves[remainingLeaves.length - 1].id
      }

      // Clean up pane title
      if (state.paneTitles[tabId]?.[paneId]) {
        delete state.paneTitles[tabId][paneId]
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

      // Update pane title when content changes
      if (!state.paneTitles[tabId]) {
        state.paneTitles[tabId] = {}
      }
      state.paneTitles[tabId][paneId] = derivePaneTitle(content)
    },

    removeLayout: (
      state,
      action: PayloadAction<{ tabId: string }>
    ) => {
      const { tabId } = action.payload
      delete state.layouts[tabId]
      delete state.activePane[tabId]
      delete state.paneTitles[tabId]
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
    },

    updatePaneTitle: (
      state,
      action: PayloadAction<{ tabId: string; paneId: string; title: string }>
    ) => {
      const { tabId, paneId, title } = action.payload
      if (!state.paneTitles[tabId]) {
        state.paneTitles[tabId] = {}
      }
      state.paneTitles[tabId][paneId] = title
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
  resetSplit,
  swapSplit,
  updatePaneContent,
  removeLayout,
  hydratePanes,
  updatePaneTitle,
} = panesSlice.actions

export default panesSlice.reducer
export type { PanesState }
