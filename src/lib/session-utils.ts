/**
 * Session utilities for extracting session information from store state.
 */

import { isNonShellMode } from '@/lib/coding-cli-utils'
import { getCodingCliSessionKey, sessionKeyRequiresCwdScope } from '@/lib/coding-cli-session-key'
import type { PaneContent, PaneNode, SessionLocator } from '@/store/paneTypes'
import type { RootState } from '@/store/store'
import type { CodingCliProviderName } from '@/store/types'
import { isValidClaudeSessionId } from '@/lib/claude-session-id'

type SessionRef = Pick<SessionLocator, 'provider' | 'sessionId'> & { cwd?: string }
type SessionLocatorInput = {
  provider?: unknown
  sessionId?: unknown
  serverInstanceId?: unknown
  cwd?: unknown
}
type SessionMatchLocator = SessionRef & { serverInstanceId?: string }
type SessionMatchCandidate = {
  tabId: string
  paneId: string | undefined
  locator: SessionLocator
  locatorKind: 'explicit' | 'intrinsic'
  explicitLocator?: SessionLocator
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

function locatorIdentity(locator: SessionMatchLocator): string {
  return `${getCodingCliSessionKey(locator)}:${locator.serverInstanceId ?? ''}`
}

function sessionKey(locator: SessionRef): string {
  return getCodingCliSessionKey(locator)
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
  locator?: { provider?: unknown; sessionId?: unknown; serverInstanceId?: unknown; cwd?: unknown } | null,
): SessionLocator | undefined {
  if (!locator || !isNonEmptyString(locator.provider) || !isNonEmptyString(locator.sessionId)) {
    return undefined
  }
  if (!isValidSessionRef(locator.provider, locator.sessionId)) return undefined
  return {
    provider: locator.provider,
    sessionId: locator.sessionId,
    ...(isNonEmptyString(locator.cwd) ? { cwd: locator.cwd } : {}),
    ...(isNonEmptyString(locator.serverInstanceId) ? { serverInstanceId: locator.serverInstanceId } : {}),
  }
}

export function sanitizeSessionLocators(
  locators: ReadonlyArray<{ provider?: unknown; sessionId?: unknown; serverInstanceId?: unknown; cwd?: unknown } | null | undefined>,
): SessionLocator[] {
  return dedupeBy(
    locators.flatMap((locator) => {
      const sanitized = sanitizeSessionLocator(locator)
      return sanitized ? [sanitized] : []
    }),
    locatorIdentity,
  )
}

function sanitizeSessionMatchLocator(locator?: SessionLocatorInput | null): SessionMatchLocator | undefined {
  const sanitized = sanitizeSessionLocator(locator)
  if (!sanitized) return undefined
  return sanitized
}

function extractExplicitSessionLocator(content: PaneContent): {
  provider: CodingCliProviderName
  sessionId: string
  serverInstanceId?: string
  cwd?: string
} | undefined {
  const explicit = (content as { sessionRef?: SessionLocatorInput }).sessionRef
  return sanitizeSessionMatchLocator(explicit)
}

/**
 * Extract intrinsic session locators from a single pane's content.
 * resumeSessionId is kept as an
 * intrinsic local fallback for local-session matching before serverInstanceId is known.
 */
function extractIntrinsicSessionLocators(content: PaneContent): Array<{
  provider: CodingCliProviderName
  sessionId: string
  serverInstanceId?: string
  cwd?: string
}> {
  const locators: Array<{
    provider: CodingCliProviderName
    sessionId: string
    serverInstanceId?: string
    cwd?: string
  }> = []

  if (content.kind === 'agent-chat') {
    const sessionId = content.resumeSessionId
    if (!sessionId || !isValidClaudeSessionId(sessionId)) return dedupeBy(locators, locatorIdentity)
    locators.push({ provider: 'claude', sessionId, cwd: content.initialCwd })
    return dedupeBy(locators, locatorIdentity)
  }
  if (content.kind !== 'terminal') return dedupeBy(locators, locatorIdentity)
  if (content.mode === 'shell') return dedupeBy(locators, locatorIdentity)
  if (!isNonShellMode(content.mode)) return dedupeBy(locators, locatorIdentity)
  const sessionId = content.resumeSessionId
  if (!sessionId) return dedupeBy(locators, locatorIdentity)
  locators.push({ provider: content.mode, sessionId, cwd: content.initialCwd })
  return dedupeBy(locators, locatorIdentity)
}

/**
 * Extract exact and intrinsic session locators from a single pane's content.
 * Explicit sessionRef preserves cross-device identity while resumeSessionId provides
 * an intrinsic local fallback until the local server identity is known.
 */
export function collectSessionLocatorsFromContent(content: PaneContent): Array<{
  provider: CodingCliProviderName
  sessionId: string
  serverInstanceId?: string
  cwd?: string
}> {
  return dedupeBy(
    buildSessionMatchLocators(content).map((candidate) => candidate.locator),
    locatorIdentity,
  )
}

function buildSessionMatchLocators(content: PaneContent): Array<{
  locator: SessionLocator
  locatorKind: 'explicit' | 'intrinsic'
  explicitLocator?: SessionLocator
}> {
  const explicit = extractExplicitSessionLocator(content)
  const locators: Array<{
    locator: SessionLocator
    locatorKind: 'explicit' | 'intrinsic'
    explicitLocator?: SessionLocator
  }> = []

  if (explicit) {
    locators.push({
      locator: explicit,
      locatorKind: 'explicit',
      explicitLocator: explicit,
    })
  }

  locators.push(
    ...extractIntrinsicSessionLocators(content).map((locator) => ({
      locator,
      locatorKind: 'intrinsic' as const,
      explicitLocator: explicit,
    })),
  )

  return dedupeBy(
    locators,
    (candidate) => `${candidate.locatorKind}:${locatorIdentity(candidate.locator)}:${candidate.explicitLocator ? locatorIdentity(candidate.explicitLocator) : ''}`,
  )
}

function matchScore(
  candidate: SessionMatchLocator,
  target: SessionMatchLocator,
  localServerInstanceId?: string,
): number {
  if (candidate.provider !== target.provider || candidate.sessionId !== target.sessionId) return 0
  if (sessionKeyRequiresCwdScope(target.provider) && target.cwd) {
    if (getCodingCliSessionKey(candidate) !== getCodingCliSessionKey(target)) return 0
  }
  if (target.serverInstanceId) {
    if (candidate.serverInstanceId === target.serverInstanceId) return 3
    if (target.serverInstanceId === localServerInstanceId && candidate.serverInstanceId == null) return 2
    return 0
  }
  if (candidate.serverInstanceId === localServerInstanceId) return 3
  if (candidate.serverInstanceId == null) return 2
  return 0
}

function candidateMatchScore(
  candidate: SessionMatchCandidate,
  target: SessionLocator,
  localServerInstanceId?: string,
): number {
  if (
    candidate.locatorKind === 'intrinsic'
    && candidate.explicitLocator?.serverInstanceId
  ) {
    if (target.serverInstanceId && candidate.explicitLocator.serverInstanceId !== target.serverInstanceId) {
      return 0
    }
    if (!target.serverInstanceId && localServerInstanceId && candidate.explicitLocator.serverInstanceId !== localServerInstanceId) {
      return 0
    }
  }

  return matchScore(candidate.locator, target, localServerInstanceId)
}

function collectPaneSessionMatchCandidates(
  node: PaneNode,
  tabId: string,
  candidates: SessionMatchCandidate[],
): void {
  if (node.type === 'leaf') {
    for (const locator of buildSessionMatchLocators(node.content)) {
      candidates.push({ tabId, paneId: node.id, ...locator })
    }
    return
  }
  collectPaneSessionMatchCandidates(node.children[0], tabId, candidates)
  collectPaneSessionMatchCandidates(node.children[1], tabId, candidates)
}

function selectBestSessionMatch(
  candidates: SessionMatchCandidate[],
  target: SessionMatchLocator,
  localServerInstanceId?: string,
): SessionMatchCandidate | undefined {
  let bestCandidate: SessionMatchCandidate | undefined
  let bestScore = 0

  for (const candidate of candidates) {
    const score = candidateMatchScore(candidate, target, localServerInstanceId)
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
  cwd?: string
}> {
  if (node.type === 'leaf') {
    return collectSessionLocatorsFromContent(node.content)
  }
  return dedupeBy([
    ...collectSessionLocatorsFromNode(node.children[0]),
    ...collectSessionLocatorsFromNode(node.children[1]),
  ], locatorIdentity)
}

export function collectSessionRefsFromContent(content: PaneContent): SessionRef[] {
  return dedupeBy(
    collectSessionLocatorsFromContent(content).map((locator) => ({
      provider: locator.provider,
      sessionId: locator.sessionId,
    })),
    sessionKey,
  )
}

export function collectSessionRefsFromNode(node: PaneNode): SessionRef[] {
  return dedupeBy(
    collectSessionLocatorsFromNode(node).map((locator) => ({
      provider: locator.provider,
      sessionId: locator.sessionId,
      cwd: locator.cwd,
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
  cwd?: string
}> {
  const locators: Array<{
    provider: CodingCliProviderName
    sessionId: string
    serverInstanceId?: string
    cwd?: string
  }> = []

  for (const tab of tabs || []) {
    const layout = panes.layouts[tab.id]
    if (!layout) continue
    locators.push(...collectSessionLocatorsFromNode(layout))
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
      cwd: locator.cwd,
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
  target: SessionLocator & { cwd?: string },
  localServerInstanceId?: string,
): string | undefined {
  const sanitizedTarget = sanitizeSessionMatchLocator(target)
  if (!sanitizedTarget) return undefined

  const candidates: SessionMatchCandidate[] = []
  for (const tab of state.tabs.tabs) {
    const layout = state.panes.layouts[tab.id]
    if (layout) {
      for (const locator of buildNodeSessionMatchLocators(layout)) {
        candidates.push({ tabId: tab.id, paneId: undefined, ...locator })
      }
    }
  }

  return selectBestSessionMatch(candidates, sanitizedTarget, localServerInstanceId)?.tabId
}

/**
 * Find the tab and pane that contain a specific session.
 * Walks all tabs' pane trees looking for a pane (terminal or agent-chat) matching the provider + sessionId.
 */
export function findPaneForSession(
  state: RootState,
  target: SessionLocator & { cwd?: string },
  localServerInstanceId?: string,
): { tabId: string; paneId: string | undefined } | undefined {
  const sanitizedTarget = sanitizeSessionMatchLocator(target)
  if (!sanitizedTarget) return undefined

  const candidates: SessionMatchCandidate[] = []
  for (const tab of state.tabs.tabs) {
    const layout = state.panes.layouts[tab.id]
    if (layout) {
      collectPaneSessionMatchCandidates(layout, tab.id, candidates)
    }
  }

  const bestMatch = selectBestSessionMatch(candidates, sanitizedTarget, localServerInstanceId)
  return bestMatch ? { tabId: bestMatch.tabId, paneId: bestMatch.paneId } : undefined
}

function buildNodeSessionMatchLocators(node: PaneNode): Array<{
  locator: SessionLocator
  locatorKind: 'explicit' | 'intrinsic'
  explicitLocator?: SessionLocator
}> {
  if (node.type === 'leaf') {
    return buildSessionMatchLocators(node.content)
  }

  return dedupeBy(
    [
      ...buildNodeSessionMatchLocators(node.children[0]),
      ...buildNodeSessionMatchLocators(node.children[1]),
    ],
    (candidate) => `${candidate.locatorKind}:${locatorIdentity(candidate.locator)}:${candidate.explicitLocator ? locatorIdentity(candidate.explicitLocator) : ''}`,
  )
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
