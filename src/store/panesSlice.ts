import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import { nanoid } from 'nanoid'
import type { PanesState, PaneContent, PaneContentInput, PaneNode } from './paneTypes'
import { derivePaneTitle } from '@/lib/derivePaneTitle'
import { isValidClaudeSessionId } from '@/lib/claude-session-id'

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

// Load persisted panes state directly at module initialization time
// This ensures the initial state includes persisted data BEFORE the store is created
function loadInitialPanesState(): PanesState {
  const defaultState: PanesState = {
    layouts: {},
    activePane: {},
    paneTitles: {},
  }

  try {
    const raw = localStorage.getItem('freshell.panes.v1')
    if (!raw) return defaultState
    const parsed = JSON.parse(raw) as PanesState
    if (import.meta.env.MODE === 'development') {
      console.log('[PanesSlice] Loaded initial state from localStorage:', Object.keys(parsed.layouts || {}))
    }
    const state = {
      layouts: parsed.layouts || {},
      activePane: parsed.activePane || {},
      paneTitles: parsed.paneTitles || {},
    }
    return applyLegacyResumeSessionIds(state)
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
      state.layouts = action.payload.layouts || {}
      state.activePane = action.payload.activePane || {}
      state.paneTitles = action.payload.paneTitles || {}
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
