/**
 * Session utilities for extracting session information from store state.
 */

import type { PaneContent, PaneNode } from '@/store/paneTypes'
import type { RootState } from '@/store/store'

/**
 * Extract all session IDs from a pane tree.
 */
function extractClaudeSessionId(content: PaneContent): string | undefined {
  if (content.kind !== 'terminal') return undefined
  if (content.mode !== 'claude') return undefined
  return content.resumeSessionId
}

function collectSessionIds(node: PaneNode): string[] {
  if (node.type === 'leaf') {
    const sessionId = extractClaudeSessionId(node.content)
    return sessionId ? [sessionId] : []
  }
  return [
    ...collectSessionIds(node.children[0]),
    ...collectSessionIds(node.children[1]),
  ]
}

/**
 * Build session info for the WebSocket hello message.
 * Returns session IDs categorized by priority:
 * - active: session in the active pane of the active tab
 * - visible: sessions in visible (but not active) panes of the active tab
 * - background: sessions in background tabs
 */
export function getSessionsForHello(state: RootState): {
  active?: string
  visible?: string[]
  background?: string[]
} {
  const activeTabId = state.tabs.activeTabId
  const tabs = state.tabs.tabs
  const panes = state.panes

  const result: {
    active?: string
    visible?: string[]
    background?: string[]
  } = {}

  // Get active tab's sessions
  if (activeTabId && panes.layouts[activeTabId]) {
    const layout = panes.layouts[activeTabId]
    const activePane = panes.activePane[activeTabId]

    const allSessions = collectSessionIds(layout)

    // Find the active pane's session
    if (activePane) {
      const findLeaf = (node: PaneNode): PaneNode | null => {
        if (node.type === 'leaf') {
          return node.id === activePane ? node : null
        }
        return findLeaf(node.children[0]) || findLeaf(node.children[1])
      }

      const activeLeaf = findLeaf(layout)
      if (activeLeaf?.type === 'leaf') {
        result.active = extractClaudeSessionId(activeLeaf.content)
      }
    }

    // Other sessions in the active tab are "visible"
    result.visible = allSessions.filter((s) => s !== result.active)
  }

  // Collect sessions from background tabs
  const backgroundSessions: string[] = []
  for (const tab of tabs) {
    if (tab.id === activeTabId) continue
    const layout = panes.layouts[tab.id]
    if (layout) {
      backgroundSessions.push(...collectSessionIds(layout))
    }
  }

  if (backgroundSessions.length > 0) {
    result.background = backgroundSessions
  }

  return result
}
