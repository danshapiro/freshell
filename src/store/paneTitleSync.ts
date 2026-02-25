import { createAsyncThunk } from '@reduxjs/toolkit'
import { updatePaneTitleByTerminalId } from './panesSlice'
import { updateTab } from './tabsSlice'
import type { RootState } from './store'
import type { PaneNode } from './paneTypes'

/**
 * Walk a pane tree to check if a leaf with the given terminalId exists.
 */
function hasTerminalId(node: PaneNode, terminalId: string): boolean {
  if (node.type === 'leaf') {
    return node.content.kind === 'terminal' && node.content.terminalId === terminalId
  }
  return hasTerminalId(node.children[0], terminalId) || hasTerminalId(node.children[1], terminalId)
}

/**
 * Update pane titles for all panes matching a terminalId, and also sync
 * the tab title for any single-pane tabs that contain the matching terminal.
 *
 * This thunk bridges the panesSlice (pane titles) and tabsSlice (tab titles)
 * which cannot communicate directly at the reducer level.
 */
export const syncPaneTitleByTerminalId = createAsyncThunk(
  'panes/syncPaneTitleByTerminalId',
  async (
    { terminalId, title }: { terminalId: string; title: string },
    { dispatch, getState }
  ) => {
    // First, update all matching pane titles
    dispatch(updatePaneTitleByTerminalId({ terminalId, title }))

    // Then, sync tab titles for single-pane tabs that contain this terminal
    const state = getState() as RootState
    const layouts = state.panes.layouts

    for (const [tabId, rootNode] of Object.entries(layouts)) {
      // Only sync if the tab has a single pane (root is a leaf)
      if (rootNode.type !== 'leaf') continue

      // Check if this single pane has the matching terminalId
      if (!hasTerminalId(rootNode, terminalId)) continue

      dispatch(updateTab({ id: tabId, updates: { title } }))
    }
  }
)
