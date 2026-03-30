// Selectors that derive terminal IDs from pane tree layouts,
// replacing direct reads of the legacy Tab.terminalId field.

import type { RootState } from '../store'
import type { PaneNode } from '../paneTypes'
import { collectTerminalIds, findPaneContent } from '@/lib/pane-utils'

/**
 * Collect all terminal IDs from a tab's pane layout tree.
 * Returns an empty array if no layout exists or no terminals are assigned.
 */
export function selectTerminalIdsForTab(state: RootState, tabId: string): string[] {
  const layout = state.panes.layouts[tabId]
  if (!layout) return []
  return collectTerminalIds(layout)
}

/**
 * Return the "primary" terminal ID for a tab: the active pane's terminalId
 * if available, otherwise the first leaf's terminalId.
 */
export function selectPrimaryTerminalIdForTab(state: RootState, tabId: string): string | undefined {
  const layout = state.panes.layouts[tabId]
  if (!layout) return undefined

  // Try active pane first
  const activePaneId = state.panes.activePane[tabId]
  if (activePaneId) {
    const content = findPaneContent(layout, activePaneId)
    if (content?.kind === 'terminal' && content.terminalId) {
      return content.terminalId
    }
  }

  // Fall back to first leaf with a terminal ID
  return findFirstTerminalId(layout)
}

/**
 * Reverse lookup: find the tab ID that owns a given terminal ID
 * by searching all pane layout trees.
 */
export function selectTabIdByTerminalId(state: RootState, terminalId: string): string | undefined {
  for (const [tabId, layout] of Object.entries(state.panes.layouts)) {
    if (nodeContainsTerminalId(layout, terminalId)) {
      return tabId
    }
  }
  return undefined
}

function findFirstTerminalId(node: PaneNode): string | undefined {
  if (node.type === 'leaf') {
    return node.content.kind === 'terminal' ? node.content.terminalId : undefined
  }
  return findFirstTerminalId(node.children[0]) ?? findFirstTerminalId(node.children[1])
}

function nodeContainsTerminalId(node: PaneNode, terminalId: string): boolean {
  if (node.type === 'leaf') {
    return node.content.kind === 'terminal' && node.content.terminalId === terminalId
  }
  return nodeContainsTerminalId(node.children[0], terminalId)
    || nodeContainsTerminalId(node.children[1], terminalId)
}
