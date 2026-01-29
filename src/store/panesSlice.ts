import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import { nanoid } from 'nanoid'
import type { PanesState, PaneContent, PaneContentInput, PaneNode } from './paneTypes'

/**
 * Normalize terminal input to full PaneContent with defaults.
 */
function normalizeContent(input: PaneContentInput): PaneContent {
  if (input.kind === 'terminal') {
    return {
      kind: 'terminal',
      terminalId: input.terminalId,
      createRequestId: input.createRequestId || nanoid(),
      status: input.status || 'creating',
      mode: input.mode || 'shell',
      shell: input.shell || 'system',
      resumeSessionId: input.resumeSessionId,
      initialCwd: input.initialCwd,
    }
  }
  // Browser content passes through unchanged
  return input
}

// Load persisted panes state directly at module initialization time
// This ensures the initial state includes persisted data BEFORE the store is created
function loadInitialPanesState(): PanesState {
  const defaultState: PanesState = {
    layouts: {},
    activePane: {},
  }

  try {
    const raw = localStorage.getItem('freshell.panes.v1')
    if (!raw) return defaultState
    const parsed = JSON.parse(raw) as PanesState
    console.log('[PanesSlice] Loaded initial state from localStorage:', Object.keys(parsed.layouts || {}))
    return {
      layouts: parsed.layouts || {},
      activePane: parsed.activePane || {},
    }
  } catch (err) {
    console.error('[PanesSlice] Failed to load from localStorage:', err)
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
      }
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

      // Find the parent split containing this pane and its sibling
      function findParentAndSibling(
        node: PaneNode,
        targetId: string
      ): { parent: PaneNode; sibling: PaneNode; siblingIndex: 0 | 1 } | null {
        if (node.type === 'leaf') return null

        // Check if either child is the target
        if (node.children[0].type === 'leaf' && node.children[0].id === targetId) {
          return { parent: node, sibling: node.children[1], siblingIndex: 1 }
        }
        if (node.children[1].type === 'leaf' && node.children[1].id === targetId) {
          return { parent: node, sibling: node.children[0], siblingIndex: 0 }
        }

        // Recurse into children
        return (
          findParentAndSibling(node.children[0], targetId) ||
          findParentAndSibling(node.children[1], targetId)
        )
      }

      const result = findParentAndSibling(root, paneId)
      if (!result) return

      const { parent, sibling } = result

      // Replace the parent split with the sibling
      if (parent === root) {
        // Parent is root - sibling becomes new root
        state.layouts[tabId] = sibling
      } else {
        // Replace parent with sibling in the tree
        const newRoot = findAndReplace(root, parent.id, sibling)
        if (newRoot) {
          state.layouts[tabId] = newRoot
        }
      }

      // Update active pane if needed
      if (state.activePane[tabId] === paneId) {
        // Find first leaf in sibling
        function findFirstLeaf(node: PaneNode): string {
          if (node.type === 'leaf') return node.id
          return findFirstLeaf(node.children[0])
        }
        state.activePane[tabId] = findFirstLeaf(sibling)
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
    },

    removeLayout: (
      state,
      action: PayloadAction<{ tabId: string }>
    ) => {
      const { tabId } = action.payload
      delete state.layouts[tabId]
      delete state.activePane[tabId]
    },

    hydratePanes: (state, action: PayloadAction<PanesState>) => {
      state.layouts = action.payload.layouts || {}
      state.activePane = action.payload.activePane || {}
    },
  },
})

export const {
  initLayout,
  splitPane,
  closePane,
  setActivePane,
  resizePanes,
  updatePaneContent,
  removeLayout,
  hydratePanes,
} = panesSlice.actions

export default panesSlice.reducer
export type { PanesState }
