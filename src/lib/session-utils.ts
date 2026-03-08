/**
 * Session utilities for extracting session information from store state.
 */

import type { PaneContent, PaneNode } from '@/store/paneTypes'
import type { RootState } from '@/store/store'
import type { CodingCliProviderName } from '@/store/types'
import { isValidClaudeSessionId } from '@/lib/claude-session-id'

type SessionRef = { provider: CodingCliProviderName; sessionId: string }

function isValidSessionRef(provider: string, sessionId: string): provider is CodingCliProviderName {
  return provider !== 'claude' || isValidClaudeSessionId(sessionId)
}

function locatorIdentity(locator: { provider: CodingCliProviderName; sessionId: string; serverInstanceId?: string }): string {
  return `${locator.provider}:${locator.sessionId}:${locator.serverInstanceId ?? ''}`
}

function sessionKey(locator: SessionRef): string {
  return `${locator.provider}:${locator.sessionId}`
}

function dedupeBy<T>(values: T[], getKey: (value: T) => string): T[] {
  const seen = new Set<string>()
  const deduped: T[] = []
  for (const value of values) {
    const key = getKey(value)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(value)
  }
  return deduped
}

function extractExplicitSessionLocator(content: PaneContent): {
  provider: CodingCliProviderName
  sessionId: string
  serverInstanceId?: string
} | undefined {
  const explicit = (content as { sessionRef?: { provider?: unknown; sessionId?: unknown; serverInstanceId?: unknown } }).sessionRef
  if (!explicit || typeof explicit.provider !== 'string' || typeof explicit.sessionId !== 'string') {
    return undefined
  }
  if (!isValidSessionRef(explicit.provider, explicit.sessionId)) return undefined
  return {
    provider: explicit.provider,
    sessionId: explicit.sessionId,
    ...(typeof explicit.serverInstanceId === 'string' ? { serverInstanceId: explicit.serverInstanceId } : {}),
  }
}

/**
 * Extract exact and intrinsic session locators from a single pane's content.
 * Explicit sessionRef preserves cross-device identity; resumeSessionId is kept as an
 * intrinsic local fallback for local-session matching before serverInstanceId is known.
 */
function extractSessionLocators(content: PaneContent): Array<{
  provider: CodingCliProviderName
  sessionId: string
  serverInstanceId?: string
}> {
  const locators: Array<{
    provider: CodingCliProviderName
    sessionId: string
    serverInstanceId?: string
  }> = []

  const explicit = extractExplicitSessionLocator(content)
  if (explicit) {
    locators.push(explicit)
  }

  if (content.kind === 'agent-chat') {
    const sessionId = content.resumeSessionId
    if (!sessionId || !isValidClaudeSessionId(sessionId)) return dedupeBy(locators, locatorIdentity)
    locators.push({ provider: 'claude', sessionId })
    return dedupeBy(locators, locatorIdentity)
  }
  if (content.kind !== 'terminal') return dedupeBy(locators, locatorIdentity)
  if (content.mode === 'shell') return dedupeBy(locators, locatorIdentity)
  const sessionId = content.resumeSessionId
  if (!sessionId) return dedupeBy(locators, locatorIdentity)
  if (content.mode === 'claude' && !isValidClaudeSessionId(sessionId)) return dedupeBy(locators, locatorIdentity)
  locators.push({ provider: content.mode as CodingCliProviderName, sessionId })
  return dedupeBy(locators, locatorIdentity)
}

export function collectSessionLocatorsFromNode(node: PaneNode): Array<{
  provider: CodingCliProviderName
  sessionId: string
  serverInstanceId?: string
}> {
  if (node.type === 'leaf') {
    return extractSessionLocators(node.content)
  }
  return dedupeBy([
    ...collectSessionLocatorsFromNode(node.children[0]),
    ...collectSessionLocatorsFromNode(node.children[1]),
  ], locatorIdentity)
}

export function collectSessionRefsFromNode(node: PaneNode): SessionRef[] {
  return dedupeBy(
    collectSessionLocatorsFromNode(node).map((locator) => ({
      provider: locator.provider,
      sessionId: locator.sessionId,
    })),
    sessionKey,
  )
}

export function collectSessionLocatorsFromTabs(
  tabs: RootState['tabs']['tabs'],
  panes: RootState['panes'],
): Array<{
  provider: CodingCliProviderName
  sessionId: string
  serverInstanceId?: string
}> {
  const locators: Array<{
    provider: CodingCliProviderName
    sessionId: string
    serverInstanceId?: string
  }> = []

  for (const tab of tabs || []) {
    const layout = panes.layouts[tab.id]
    if (layout) {
      locators.push(...collectSessionLocatorsFromNode(layout))
      continue
    }

    const provider = tab.codingCliProvider || (tab.mode !== 'shell' ? tab.mode : undefined)
    const sessionId = tab.resumeSessionId
    if (!provider || !sessionId) continue
    if (!isValidSessionRef(provider, sessionId)) continue
    locators.push({ provider, sessionId })
  }

  return dedupeBy(locators, locatorIdentity)
}

export function collectSessionRefsFromTabs(
  tabs: RootState['tabs']['tabs'],
  panes: RootState['panes'],
): SessionRef[] {
  return dedupeBy(
    collectSessionLocatorsFromTabs(tabs, panes).map((locator) => ({
      provider: locator.provider,
      sessionId: locator.sessionId,
    })),
    sessionKey,
  )
}

export function getActiveSessionRefForTab(state: RootState, tabId: string): SessionRef | undefined {
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
    return collectSessionRefsFromNode(leaf)[0]
  }
  return undefined
}

export function getTabSessionRefs(state: RootState, tabId: string): SessionRef[] {
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
    const refs = collectSessionRefsFromNode(node)
    if (refs.some((ref) => ref.provider === provider && ref.sessionId === sessionId)) {
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
