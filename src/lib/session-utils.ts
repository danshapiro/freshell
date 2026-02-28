/**
 * Session utilities for extracting session information from store state.
 */

import type { PaneContent, PaneNode } from '@/store/paneTypes'
import type { RootState } from '@/store/store'
import type { CodingCliProviderName } from '@/store/types'
import { isValidClaudeSessionId } from '@/lib/claude-session-id'

/**
 * Extract a session reference from a single pane's content.
 * Handles both terminal panes (claude/codex mode) and agent-chat (freshclaude) panes.
 */
function extractSessionRef(content: PaneContent): { provider: CodingCliProviderName; sessionId: string } | undefined {
  const explicit = (content as { sessionRef?: { provider?: unknown; sessionId?: unknown } }).sessionRef
  if (explicit && typeof explicit.provider === 'string' && typeof explicit.sessionId === 'string') {
    if (explicit.provider === 'claude' && !isValidClaudeSessionId(explicit.sessionId)) return undefined
    return {
      provider: explicit.provider as CodingCliProviderName,
      sessionId: explicit.sessionId,
    }
  }

  if (content.kind === 'agent-chat') {
    const sessionId = content.resumeSessionId
    if (!sessionId || !isValidClaudeSessionId(sessionId)) return undefined
    return { provider: 'claude', sessionId }
  }
  if (content.kind !== 'terminal') return undefined
  if (content.mode === 'shell') return undefined
  const sessionId = content.resumeSessionId
  if (!sessionId) return undefined
  if (content.mode === 'claude' && !isValidClaudeSessionId(sessionId)) return undefined
  return { provider: content.mode as CodingCliProviderName, sessionId }
}

export function collectSessionRefsFromNode(node: PaneNode): Array<{ provider: CodingCliProviderName; sessionId: string }> {
  if (node.type === 'leaf') {
    const sessionRef = extractSessionRef(node.content)
    return sessionRef ? [sessionRef] : []
  }
  return [
    ...collectSessionRefsFromNode(node.children[0]),
    ...collectSessionRefsFromNode(node.children[1]),
  ]
}

export function getActiveSessionRefForTab(state: RootState, tabId: string): { provider: CodingCliProviderName; sessionId: string } | undefined {
  const layout = state.panes.layouts[tabId]
  if (!layout) return undefined
  const activePaneId = state.panes.activePane[tabId]
  if (!activePaneId) return undefined

  const findLeaf = (node: PaneNode): PaneNode | null => {
    if (node.type === 'leaf') return node.id === activePaneId ? node : null
    return findLeaf(node.children[0]) || findLeaf(node.children[1])
  }

  const leaf = findLeaf(layout)
  if (leaf?.type === 'leaf') {
    return extractSessionRef(leaf.content)
  }
  return undefined
}

export function getTabSessionRefs(state: RootState, tabId: string): Array<{ provider: CodingCliProviderName; sessionId: string }> {
  const layout = state.panes.layouts[tabId]
  if (!layout) return []
  return collectSessionRefsFromNode(layout)
}

export function findTabIdForSession(state: RootState, provider: CodingCliProviderName, sessionId: string): string | undefined {
  if (provider === 'claude' && !isValidClaudeSessionId(sessionId)) return undefined
  for (const tab of state.tabs.tabs) {
    const layout = state.panes.layouts[tab.id]
    if (layout) {
      const refs = getTabSessionRefs(state, tab.id)
      if (refs.some((ref) => ref.provider === provider && ref.sessionId === sessionId)) {
        return tab.id
      }
      continue
    }

    // Fallback for tabs without pane layout yet (e.g., early boot).
    const tabProvider = tab.codingCliProvider || (tab.mode !== 'shell' ? tab.mode : undefined)
    if (tabProvider !== provider) continue
    const tabSessionId = tab.resumeSessionId
    if (!tabSessionId) continue
    if (provider === 'claude' && !isValidClaudeSessionId(tabSessionId)) continue
    if (tabSessionId === sessionId) return tab.id
  }
  return undefined
}

/**
 * Find the tab and pane that contain a specific session.
 * Walks all tabs' pane trees looking for a pane (terminal or agent-chat) matching the provider + sessionId.
 * Falls back to tab-level resumeSessionId when no layout exists (early boot/rehydration).
 */
export function findPaneForSession(
  state: RootState,
  provider: CodingCliProviderName,
  sessionId: string
): { tabId: string; paneId: string | undefined } | undefined {
  for (const tab of state.tabs.tabs) {
    const layout = state.panes.layouts[tab.id]
    if (layout) {
      const paneId = findPaneInNode(layout, provider, sessionId)
      if (paneId) return { tabId: tab.id, paneId }
      continue
    }

    // Fallback: tab has resumeSessionId but no pane layout yet (early boot)
    const tabProvider = tab.codingCliProvider || (tab.mode !== 'shell' ? tab.mode : undefined)
    if (tabProvider !== provider) continue
    const tabSessionId = tab.resumeSessionId
    if (!tabSessionId) continue
    if (provider === 'claude' && !isValidClaudeSessionId(tabSessionId)) continue
    if (tabSessionId === sessionId) return { tabId: tab.id, paneId: undefined }
  }
  return undefined
}

function findPaneInNode(
  node: PaneNode,
  provider: CodingCliProviderName,
  sessionId: string
): string | undefined {
  if (node.type === 'leaf') {
    const ref = extractSessionRef(node.content)
    if (ref && ref.provider === provider && ref.sessionId === sessionId) {
      return node.id
    }
    return undefined
  }
  return findPaneInNode(node.children[0], provider, sessionId)
    ?? findPaneInNode(node.children[1], provider, sessionId)
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
    const allSessions = collectSessionRefsFromNode(layout)
      .filter((ref) => ref.provider === 'claude')
      .map((ref) => ref.sessionId)

    const activeRef = getActiveSessionRefForTab(state, activeTabId)
    if (activeRef?.provider === 'claude') {
      result.active = activeRef.sessionId
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
      backgroundSessions.push(
        ...collectSessionRefsFromNode(layout)
          .filter((ref) => ref.provider === 'claude')
          .map((ref) => ref.sessionId)
      )
    }
  }

  if (backgroundSessions.length > 0) {
    result.background = backgroundSessions
  }

  return result
}
