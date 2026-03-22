/**
 * Session utilities for extracting session information from store state.
 */

import { isNonShellMode } from '@/lib/coding-cli-utils'
import type { PaneContent, PaneNode, SessionLocator } from '@/store/paneTypes'
import type { RootState } from '@/store/store'
import type { CodingCliProviderName } from '@/store/types'
import { isValidClaudeSessionId } from '@/lib/claude-session-id'

type SessionRef = Pick<SessionLocator, 'provider' | 'sessionId'>
type SessionMatchCandidate = {
  tabId: string
  paneId: string | undefined
  locator: SessionLocator
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isValidSessionRef(provider: string, sessionId: string): provider is CodingCliProviderName {
  // Provider names are validated at creation time; here we just check it's a valid non-shell mode.
  if (!isNonShellMode(provider) || sessionId.length === 0) return false
  // All non-empty session IDs are valid refs. Claude named resumes (non-UUID)
  // are legitimate: the terminal was launched with --resume "<name>" and is
  // waiting for the association coordinator to discover the real UUID.
  return true
}

function locatorIdentity(locator: SessionLocator): string {
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

export function sanitizeSessionLocator(
  locator?: { provider?: unknown; sessionId?: unknown; serverInstanceId?: unknown } | null,
): SessionLocator | undefined {
  if (!locator || !isNonEmptyString(locator.provider) || !isNonEmptyString(locator.sessionId)) {
    return undefined
  }
  if (!isValidSessionRef(locator.provider, locator.sessionId)) return undefined
  return {
    provider: locator.provider,
    sessionId: locator.sessionId,
    ...(isNonEmptyString(locator.serverInstanceId) ? { serverInstanceId: locator.serverInstanceId } : {}),
  }
}

export function sanitizeSessionLocators(
  locators: ReadonlyArray<{ provider?: unknown; sessionId?: unknown; serverInstanceId?: unknown } | null | undefined>,
): SessionLocator[] {
  return dedupeBy(
    locators.flatMap((locator) => {
      const sanitized = sanitizeSessionLocator(locator)
      return sanitized ? [sanitized] : []
    }),
    locatorIdentity,
  )
}

function extractExplicitSessionLocator(content: PaneContent): {
  provider: CodingCliProviderName
  sessionId: string
  serverInstanceId?: string
} | undefined {
  const explicit = (content as { sessionRef?: { provider?: unknown; sessionId?: unknown; serverInstanceId?: unknown } }).sessionRef
  return sanitizeSessionLocator(explicit)
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
    return dedupeBy(locators, locatorIdentity)
  }

  if (content.kind === 'agent-chat') {
    const sessionId = content.resumeSessionId
    if (!sessionId || !isValidClaudeSessionId(sessionId)) return dedupeBy(locators, locatorIdentity)
    locators.push({ provider: 'claude', sessionId })
    return dedupeBy(locators, locatorIdentity)
  }
  if (content.kind !== 'terminal') return dedupeBy(locators, locatorIdentity)
  if (content.mode === 'shell') return dedupeBy(locators, locatorIdentity)
  if (!isNonShellMode(content.mode)) return dedupeBy(locators, locatorIdentity)
  const sessionId = content.resumeSessionId
  if (!sessionId) return dedupeBy(locators, locatorIdentity)
  locators.push({ provider: content.mode, sessionId })
  return dedupeBy(locators, locatorIdentity)
}

function buildTabFallbackLocator(tab: RootState['tabs']['tabs'][number]): SessionLocator | undefined {
  const provider = tab.codingCliProvider || (tab.mode !== 'shell' ? tab.mode : undefined)
  const sessionId = tab.resumeSessionId
  if (!provider || !sessionId) return undefined
  return sanitizeSessionLocator({ provider, sessionId })
}

function matchScore(
  candidate: SessionLocator,
  target: SessionLocator,
  localServerInstanceId?: string,
): number {
  if (candidate.provider !== target.provider || candidate.sessionId !== target.sessionId) return 0
  if (target.serverInstanceId) {
    if (candidate.serverInstanceId === target.serverInstanceId) return 3
    if (target.serverInstanceId === localServerInstanceId && candidate.serverInstanceId == null) return 2
    return 0
  }
  if (candidate.serverInstanceId === localServerInstanceId) return 3
  if (candidate.serverInstanceId == null) return 2
  return 0
}

function collectPaneSessionMatchCandidates(
  node: PaneNode,
  tabId: string,
  candidates: SessionMatchCandidate[],
): void {
  if (node.type === 'leaf') {
    for (const locator of extractSessionLocators(node.content)) {
      candidates.push({ tabId, paneId: node.id, locator })
    }
    return
  }
  collectPaneSessionMatchCandidates(node.children[0], tabId, candidates)
  collectPaneSessionMatchCandidates(node.children[1], tabId, candidates)
}

function selectBestSessionMatch(
  candidates: SessionMatchCandidate[],
  target: SessionLocator,
  localServerInstanceId?: string,
): SessionMatchCandidate | undefined {
  let bestCandidate: SessionMatchCandidate | undefined
  let bestScore = 0

  for (const candidate of candidates) {
    const score = matchScore(candidate.locator, target, localServerInstanceId)
    if (score <= 0) continue
    if (score > bestScore) {
      bestCandidate = candidate
      bestScore = score
    }
  }

  return bestCandidate
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

    const fallbackLocator = buildTabFallbackLocator(tab)
    if (fallbackLocator) locators.push(fallbackLocator)
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

export function findTabIdForSession(
  state: RootState,
  target: SessionLocator,
  localServerInstanceId?: string,
): string | undefined {
  const sanitizedTarget = sanitizeSessionLocator(target)
  if (!sanitizedTarget) return undefined

  const candidates: SessionMatchCandidate[] = []
  for (const tab of state.tabs.tabs) {
    const layout = state.panes.layouts[tab.id]
    if (layout) {
      for (const locator of collectSessionLocatorsFromNode(layout)) {
        candidates.push({ tabId: tab.id, paneId: undefined, locator })
      }
      continue
    }

    const locator = buildTabFallbackLocator(tab)
    if (locator) {
      candidates.push({ tabId: tab.id, paneId: undefined, locator })
    }
  }

  return selectBestSessionMatch(candidates, sanitizedTarget, localServerInstanceId)?.tabId
}

/**
 * Find the tab and pane that contain a specific session.
 * Walks all tabs' pane trees looking for a pane (terminal or agent-chat) matching the provider + sessionId.
 * Falls back to tab-level resumeSessionId when no layout exists (early boot/rehydration).
 */
export function findPaneForSession(
  state: RootState,
  target: SessionLocator,
  localServerInstanceId?: string,
): { tabId: string; paneId: string | undefined } | undefined {
  const sanitizedTarget = sanitizeSessionLocator(target)
  if (!sanitizedTarget) return undefined

  const candidates: SessionMatchCandidate[] = []
  for (const tab of state.tabs.tabs) {
    const layout = state.panes.layouts[tab.id]
    if (layout) {
      collectPaneSessionMatchCandidates(layout, tab.id, candidates)
      continue
    }

    const locator = buildTabFallbackLocator(tab)
    if (locator) {
      candidates.push({ tabId: tab.id, paneId: undefined, locator })
    }
  }

  const bestMatch = selectBestSessionMatch(candidates, sanitizedTarget, localServerInstanceId)
  return bestMatch ? { tabId: bestMatch.tabId, paneId: bestMatch.paneId } : undefined
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
