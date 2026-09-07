import { createSelector } from '@reduxjs/toolkit'
import type { RootState } from '../store'
import type { BackgroundTerminal, CodingCliProviderName, WorktreeGrouping, ProjectGroup } from '../types'
import { collectSessionRefsFromTabs } from '@/lib/session-utils'
import { getFreshAgentProviderConfig } from '@/lib/fresh-agent-provider-utils'
import { resolveFreshAgentType } from '@/lib/fresh-agent-registry'
import { getSessionMetadata } from '@/lib/session-metadata'
import { getProviderLabel, isNonShellMode } from '@/lib/coding-cli-utils'
import type { SessionListMetadata } from '../types'
import { getLeafDirectoryName, matchTitleTierMetadata } from '../../../shared/session-title-search.js'
import { deriveTabRecencyAt } from '@/lib/tab-recency'
import type { CodexDurabilityRef, CodexDurabilityStateName } from '../../../shared/codex-durability.js'
import { sessionStatusTierRank, type SessionStatusTier } from '@/store/selectors/sessionStatusTiers'
import { makeSelectSessionStatusTiers } from '@/store/selectors/sessionStatusTiers'

/**
 * Module-scope instance of the status-tier selector, shared by every
 * makeSelectSortedSessionItems() instance (pure function of store state, and
 * createSelector's last-args memo makes shared use safe).
 */
const selectSessionStatusTiers = makeSelectSessionStatusTiers()

export interface SidebarSessionItem {
  id: string
  sessionId: string
  provider: CodingCliProviderName
  sessionType: string  // Defaults to provider when not explicitly set
  title: string
  subtitle?: string
  projectPath?: string
  // Repo root (ProjectGroup.projectPath) — independent of the worktreeGrouping
  // display setting. Undefined for fallback rows, for server-fabricated
  // live-terminal rows (both variants: liveTerminalOnly / 'terminal:<id>'
  // sessionIds, and sessionId-bearing-but-unindexed rows identified by
  // checkoutPath === projectPath), and for the literal 'unknown' group path —
  // none of which carry a repo root.
  repoPath?: string
  projectColor?: string
  archived?: boolean
  timestamp: number
  cwd?: string
  hasTab: boolean
  ratchetedActivity?: number
  isRunning: boolean
  runningTerminalId?: string
  runningTerminalIds?: string[]
  isSubagent?: boolean
  isNonInteractive?: boolean
  firstUserMessage?: string
  hasTitle: boolean
  isFallback?: true
  liveTerminalOnly?: boolean
  isRestorable?: boolean
  codexDurability?: CodexDurabilityRef
  codexDurabilityState?: CodexDurabilityStateName
  codexDurabilityReason?: string
}

const EMPTY_ACTIVITY: Record<string, number> = {}
const EMPTY_STRINGS: string[] = []
const EMPTY_PANE_LAST_INPUT_AT: Record<string, number | undefined> = {}

const selectProjects = (state: RootState) => state.sessions.windows?.sidebar?.projects ?? state.sessions.projects
const selectTabs = (state: RootState) => state.tabs.tabs
const selectPanes = (state: RootState) => state.panes
const selectPaneLastInputAt = (state: RootState) => state.tabRecency?.paneLastInputAt ?? EMPTY_PANE_LAST_INPUT_AT
const selectSortMode = (state: RootState) => state.settings.settings.sidebar?.sortMode || 'activity'
const selectSessionActivityForSort = (state: RootState) => {
  const sortMode = state.settings.settings.sidebar?.sortMode || 'activity'
  if (sortMode !== 'activity') return EMPTY_ACTIVITY
  return state.sessionActivity?.sessions || EMPTY_ACTIVITY
}
const selectWorktreeGrouping = (state: RootState): WorktreeGrouping => state.settings.settings.sidebar?.worktreeGrouping || 'repo'
const selectShowSubagents = (state: RootState) => state.settings.settings.sidebar?.showSubagents ?? false
const selectIgnoreCodexSubagents = (state: RootState) => state.settings.settings.sidebar?.ignoreCodexSubagents ?? true
const selectShowNoninteractiveSessions = (state: RootState) => state.settings.settings.sidebar?.showNoninteractiveSessions ?? false
const selectHideEmptySessions = (state: RootState) => state.settings.settings.sidebar?.hideEmptySessions ?? true
const selectExcludeFirstChatSubstrings = (state: RootState) => state.settings.settings.sidebar?.excludeFirstChatSubstrings ?? EMPTY_STRINGS
const selectExcludeFirstChatMustStart = (state: RootState) => state.settings.settings.sidebar?.excludeFirstChatMustStart ?? false
const selectAppliedQuery = (state: RootState) => state.sessions.windows?.sidebar?.appliedQuery ?? ''
const selectAppliedSearchTier = (state: RootState) => state.sessions.windows?.sidebar?.appliedSearchTier
const selectTerminals = (_state: RootState, terminals: BackgroundTerminal[]) => terminals
const selectFilter = (_state: RootState, _terminals: BackgroundTerminal[], filter: string) => filter

function getProjectName(projectPath: string): string {
  return getLeafDirectoryName(projectPath) ?? projectPath
}

function liveTerminalSessionId(terminalId: string): string {
  return `terminal:${terminalId}`
}

function collectTerminalPaneTitles(
  tabs: RootState['tabs']['tabs'],
  panes: RootState['panes'],
): Map<string, { title?: string; hasTab: boolean }> {
  const result = new Map<string, { title?: string; hasTab: boolean }>()
  const paneTitles = panes?.paneTitles ?? {}

  const visit = (
    node: RootState['panes']['layouts'][string],
    tab: RootState['tabs']['tabs'][number],
  ) => {
    if (!node) return
    if (node.type !== 'leaf') {
      visit(node.children[0], tab)
      visit(node.children[1], tab)
      return
    }
    if (node.content.kind !== 'terminal' || !node.content.terminalId) return
    result.set(node.content.terminalId, {
      title: paneTitles?.[tab.id]?.[node.id] || tab.title,
      hasTab: true,
    })
  }

  for (const tab of tabs || []) {
    const layout = panes.layouts?.[tab.id]
    if (layout) visit(layout, tab)
  }

  return result
}

function getCodexDurabilitySessionId(durability?: CodexDurabilityRef): string | undefined {
  return durability?.durableThreadId ?? durability?.candidate?.candidateThreadId
}

function isCodexDurabilityRestorable(durability?: CodexDurabilityRef): boolean {
  return Boolean(durability?.state === 'durable' && durability.durableThreadId)
}

function getCodexDurabilityReason(durability?: CodexDurabilityRef): string | undefined {
  return durability?.nonRestorableReason ?? durability?.lastProofFailure?.message ?? durability?.lastProofFailure?.reason
}

type RunningSessionInfo = {
  terminalId: string
  createdAt: number
  allTerminalIds: string[]
  isRestorable?: boolean
  resumeTargetIsSubagent?: boolean
  codexDurability?: CodexDurabilityRef
  codexDurabilityState?: CodexDurabilityStateName
  codexDurabilityReason?: string
}

// Rows whose group path is NOT a repo root get repoPath: undefined.
// Server-fabricated live-terminal rows (buildLiveTerminalSessionItem in
// server/session-directory/service.ts) use checkoutRoot || cwd || 'terminal:<id>'
// — never repo-root-collapsed — in two variants: sessionId-less rows
// (liveTerminalOnly: true, sessionId 'terminal:<id>') and
// sessionId-bearing-but-unindexed rows (liveTerminalOnly: false), which are
// identified by checkoutPath === projectPath: the indexer suppresses
// checkoutPath whenever it would equal projectPath
// (server/coding-cli/session-indexer.ts), so that equality holds only for
// fabricated rows. 'unknown' is the literal group path of cwd-less indexed
// sessions. See the "repoPath semantics" design note in the plan.
function resolveRepoPath(
  session: ProjectGroup['sessions'][number],
  groupProjectPath: string,
): string | undefined {
  if (session.liveTerminalOnly) return undefined
  if (session.sessionId.startsWith('terminal:')) return undefined
  if (session.checkoutPath && session.checkoutPath === session.projectPath) return undefined
  if (groupProjectPath === 'unknown') return undefined
  return groupProjectPath
}

export function buildSessionItems(
  projects: RootState['sessions']['projects'],
  tabs: RootState['tabs']['tabs'],
  panes: RootState['panes'],
  terminals: BackgroundTerminal[],
  sessionActivity: Record<string, number>,
  worktreeGrouping: WorktreeGrouping = 'repo',
  paneLastInputAt: Record<string, number | undefined> = EMPTY_PANE_LAST_INPUT_AT,
): SidebarSessionItem[] {
  const itemsByKey = new Map<string, SidebarSessionItem>()
  const runningSessionMap = new Map<string, RunningSessionInfo>()
  const tabSessionMap = new Map<string, { hasTab: boolean }>()
  const terminalPaneTitles = collectTerminalPaneTitles(tabs, panes)

  for (const terminal of terminals || []) {
    if (terminal.status === 'running') {
      const codexDurabilitySessionId = terminal.mode === 'codex'
        ? getCodexDurabilitySessionId(terminal.codexDurability)
        : undefined
      const sessionRef = terminal.sessionRef ?? (
        codexDurabilitySessionId
          ? { provider: 'codex' as const, sessionId: codexDurabilitySessionId }
          : undefined
      )
      if (!sessionRef) continue

      const sessionKey = `${sessionRef.provider}:${sessionRef.sessionId}`
      const isRestorable = sessionRef === terminal.sessionRef
        ? true
        : isCodexDurabilityRestorable(terminal.codexDurability)
      const codexDurability = terminal.mode === 'codex'
        ? terminal.codexDurability
        : undefined
      const codexDurabilityState = terminal.mode === 'codex'
        ? terminal.codexDurability?.state
        : undefined
      const codexDurabilityReason = terminal.mode === 'codex'
        ? getCodexDurabilityReason(terminal.codexDurability)
        : undefined
      const existing = runningSessionMap.get(sessionKey)
      if (existing) {
        existing.allTerminalIds.push(terminal.terminalId)
        existing.isRestorable = existing.isRestorable || isRestorable
        existing.resumeTargetIsSubagent = existing.resumeTargetIsSubagent || terminal.resumeTargetIsSubagent
        existing.codexDurability = existing.codexDurability ?? codexDurability
        if (!existing.codexDurabilityState || codexDurabilityState === 'durable') {
          existing.codexDurabilityState = codexDurabilityState
        }
        existing.codexDurabilityReason = existing.codexDurabilityReason ?? codexDurabilityReason
        if (terminal.createdAt < existing.createdAt) {
          existing.terminalId = terminal.terminalId
          existing.createdAt = terminal.createdAt
        }
      } else {
        runningSessionMap.set(sessionKey, {
          terminalId: terminal.terminalId,
          createdAt: terminal.createdAt,
          allTerminalIds: [terminal.terminalId],
          isRestorable,
          resumeTargetIsSubagent: terminal.resumeTargetIsSubagent,
          codexDurability,
          codexDurabilityState,
          codexDurabilityReason,
        })
      }
    }
  }

  for (const ref of collectSessionRefsFromTabs(tabs, panes)) {
    const key = `${ref.provider}:${ref.sessionId}`
    if (!tabSessionMap.has(key)) {
      tabSessionMap.set(key, { hasTab: true })
    }
  }

  for (const project of projects || []) {
    for (const session of project.sessions || []) {
      const provider = session.provider || 'claude'
      const key = `${provider}:${session.sessionId}`
      const runningTerminal = runningSessionMap.get(key)
      const serverRunningTerminalId = session.isRunning ? session.runningTerminalId : undefined
      const runningTerminalId = runningTerminal?.terminalId ?? serverRunningTerminalId
      const runningTerminalIds = runningTerminal?.allTerminalIds
      const tabInfo = tabSessionMap.get(key)
      const ratchetedActivity = sessionActivity[key]
      const hasTitle = !!session.title
      const effectivePath = worktreeGrouping === 'worktree'
        ? (session.checkoutPath || project.projectPath)
        : project.projectPath
      const item: SidebarSessionItem = {
        id: `session-${provider}-${session.sessionId}`,
        sessionId: session.sessionId,
        provider,
        sessionType: session.sessionType || provider,
        title: session.title || session.sessionId.slice(0, 8),
        hasTitle,
        subtitle: getProjectName(effectivePath),
        projectPath: effectivePath,
        repoPath: resolveRepoPath(session, project.projectPath),
        projectColor: project.color,
        archived: session.archived,
        timestamp: session.lastActivityAt,
        cwd: session.cwd,
        hasTab: tabInfo?.hasTab ?? false,
        ratchetedActivity,
        isRunning: !!runningTerminalId,
        runningTerminalId,
        runningTerminalIds,
        isSubagent: session.isSubagent,
        isNonInteractive: session.isNonInteractive,
        firstUserMessage: session.firstUserMessage,
        isFallback: undefined,
        liveTerminalOnly: session.liveTerminalOnly,
        isRestorable: runningTerminal?.isRestorable,
        codexDurability: runningTerminal?.codexDurability,
        codexDurabilityState: runningTerminal?.codexDurabilityState,
        codexDurabilityReason: runningTerminal?.codexDurabilityReason,
      }
      // Persisted project order is authoritative. Keep the first appearance
      // if malformed/preloaded state bypasses reducer normalization.
      if (!itemsByKey.has(key)) {
        itemsByKey.set(key, item)
      }
    }
  }

  const paneTitles = panes?.paneTitles ?? {}

  const pushFallbackItem = (input: {
    provider: CodingCliProviderName
    sessionId: string
    sessionType: string
    title?: string
    cwd?: string
    timestamp?: number
    metadata?: SessionListMetadata
    hasTab?: boolean
    isRestorable?: boolean
    codexDurability?: CodexDurabilityRef
    codexDurabilityState?: CodexDurabilityStateName
    codexDurabilityReason?: string
  }) => {
    const key = `${input.provider}:${input.sessionId}`
    const existing = itemsByKey.get(key)
    if (existing) {
      existing.timestamp = Math.max(existing.timestamp, input.timestamp ?? 0)
      const fallbackTitle = input.title?.trim()
      if (!existing.hasTitle && fallbackTitle) {
        existing.title = fallbackTitle
      }
      const fallbackSessionType = input.metadata?.sessionType || input.sessionType
      if (fallbackSessionType && (!existing.sessionType || existing.sessionType === existing.provider)) {
        existing.sessionType = fallbackSessionType
      }
      if (!existing.cwd && input.cwd) {
        existing.cwd = input.cwd
      }
      if (!existing.firstUserMessage && input.metadata?.firstUserMessage) {
        existing.firstUserMessage = input.metadata.firstUserMessage
      }
      existing.hasTab = existing.hasTab || (input.hasTab ?? true)
      existing.isRestorable = existing.isRestorable || input.isRestorable
      existing.codexDurability = existing.codexDurability
        ?? input.codexDurability
        ?? runningSessionMap.get(key)?.codexDurability
      existing.codexDurabilityState = existing.codexDurabilityState
        ?? input.codexDurabilityState
        ?? runningSessionMap.get(key)?.codexDurabilityState
      existing.codexDurabilityReason = existing.codexDurabilityReason
        ?? input.codexDurabilityReason
        ?? runningSessionMap.get(key)?.codexDurabilityReason
      if (existing.isSubagent === undefined && input.metadata?.isSubagent !== undefined) {
        existing.isSubagent = input.metadata.isSubagent
      }
      if (existing.isNonInteractive === undefined && input.metadata?.isNonInteractive !== undefined) {
        existing.isNonInteractive = input.metadata.isNonInteractive
      }
      return
    }

    const fallbackTitle = input.title?.trim() || input.sessionId.slice(0, 8)
    const runningTerminal = runningSessionMap.get(key)
    const runningTerminalId = runningTerminal?.terminalId
    const runningTerminalIds = runningTerminal?.allTerminalIds
    const hasTab = input.hasTab ?? true
    const item: SidebarSessionItem = {
      id: `session-${input.provider}-${input.sessionId}`,
      sessionId: input.sessionId,
      provider: input.provider,
      sessionType: input.metadata?.sessionType || input.sessionType,
      title: fallbackTitle,
      hasTitle: false,
      subtitle: input.cwd ? getProjectName(input.cwd) : undefined,
      projectPath: input.cwd,
      timestamp: input.timestamp ?? 0,
      cwd: input.cwd,
      hasTab,
      ratchetedActivity: sessionActivity[key],
      isRunning: !!runningTerminalId,
      runningTerminalId,
      runningTerminalIds,
      isSubagent: input.metadata?.isSubagent
        ?? (runningTerminal?.resumeTargetIsSubagent === true ? true : undefined),
      isNonInteractive: input.metadata?.isNonInteractive,
      firstUserMessage: input.metadata?.firstUserMessage,
      isFallback: true,
      isRestorable: input.isRestorable ?? runningTerminal?.isRestorable,
      codexDurability: input.codexDurability ?? runningTerminal?.codexDurability,
      codexDurabilityState: input.codexDurabilityState ?? runningTerminal?.codexDurabilityState,
      codexDurabilityReason: input.codexDurabilityReason ?? runningTerminal?.codexDurabilityReason,
    }
    itemsByKey.set(key, item)
  }

  const collectFallbackItemsFromNode = (
    node: RootState['panes']['layouts'][string],
    tab: RootState['tabs']['tabs'][number],
  ) => {
    if (node.type !== 'leaf') {
      collectFallbackItemsFromNode(node.children[0], tab)
      collectFallbackItemsFromNode(node.children[1], tab)
      return
    }

    const paneTitle = paneTitles?.[tab.id]?.[node.id]
    const fallbackTimestamp = deriveTabRecencyAt({
      tab,
      layout: panes.layouts?.[tab.id],
      paneLastInputAt,
    })

    if (node.content.kind === 'fresh-agent') {
      const sessionId = node.content.resumeSessionId
      const runtimeProvider = resolveFreshAgentType(node.content.sessionType)?.runtimeProvider ?? node.content.provider
      if (!sessionId) return
      const metadata = getSessionMetadata(tab, runtimeProvider, sessionId)
      pushFallbackItem({
        provider: runtimeProvider,
        sessionId,
        sessionType: node.content.sessionType || runtimeProvider,
        title: paneTitle || tab.title,
        cwd: node.content.initialCwd,
        timestamp: fallbackTimestamp,
        metadata,
      })
      return
    }

    if (node.content.kind !== 'terminal') return
    if (node.content.mode === 'shell') return
    const sessionRef = node.content.sessionRef
    if (!sessionRef) {
      const codexDurability = node.content.mode === 'codex'
        ? node.content.codexDurability
        : undefined
      const codexSessionId = getCodexDurabilitySessionId(codexDurability)
      if (!codexSessionId) return
      pushFallbackItem({
        provider: 'codex',
        sessionId: codexSessionId,
        sessionType: 'codex',
        title: paneTitle || tab.title,
        cwd: node.content.initialCwd,
        timestamp: fallbackTimestamp,
        isRestorable: isCodexDurabilityRestorable(codexDurability),
        codexDurability,
        codexDurabilityState: codexDurability?.state,
        codexDurabilityReason: getCodexDurabilityReason(codexDurability),
      })
      return
    }

    const metadata = getSessionMetadata(tab, sessionRef.provider, sessionRef.sessionId)
    pushFallbackItem({
      provider: sessionRef.provider,
      sessionId: sessionRef.sessionId,
      sessionType: sessionRef.provider,
      title: paneTitle || tab.title,
      cwd: node.content.initialCwd,
      timestamp: fallbackTimestamp,
      metadata,
    })
  }

  for (const tab of tabs || []) {
    const layout = panes.layouts?.[tab.id]
    if (layout) {
      collectFallbackItemsFromNode(layout, tab)
      continue
    }

    const provider = tab.sessionRef?.provider
    const sessionId = tab.sessionRef?.sessionId
    if (!provider || !sessionId) continue

    const metadata = getSessionMetadata(tab, provider, sessionId)
    pushFallbackItem({
      provider,
      sessionId,
      sessionType: metadata?.sessionType || provider,
      title: tab.title,
      cwd: undefined,
      timestamp: deriveTabRecencyAt({
        tab,
        layout: undefined,
        paneLastInputAt,
      }),
      metadata,
    })
  }

  for (const terminal of terminals || []) {
    if (terminal.status !== 'running') continue
    if (terminal.sessionRef) continue
    if (!terminal.mode || terminal.mode === 'shell' || !isNonShellMode(terminal.mode)) continue

    const provider = terminal.mode as CodingCliProviderName
    const codexDurability = provider === 'codex' ? terminal.codexDurability : undefined
    const codexSessionId = getCodexDurabilitySessionId(codexDurability)
    if (provider === 'codex' && codexSessionId) {
      pushFallbackItem({
        provider: 'codex',
        sessionId: codexSessionId,
        sessionType: 'codex',
        title: terminal.title,
        cwd: terminal.cwd,
        timestamp: terminal.lastActivityAt ?? terminal.createdAt,
        hasTab: false,
        isRestorable: isCodexDurabilityRestorable(codexDurability),
        codexDurability,
        codexDurabilityState: codexDurability?.state,
        codexDurabilityReason: getCodexDurabilityReason(codexDurability),
      })
      continue
    }

    const sessionId = liveTerminalSessionId(terminal.terminalId)
    const key = `${provider}:${sessionId}`
    if (itemsByKey.has(key)) continue

    const paneInfo = terminalPaneTitles.get(terminal.terminalId)
    const fallbackTitle = paneInfo?.title?.trim() || terminal.title?.trim() || getProviderLabel(provider)
    const item: SidebarSessionItem = {
      id: `session-${provider}-${sessionId}`,
      sessionId,
      provider,
      sessionType: provider,
      title: fallbackTitle,
      hasTitle: fallbackTitle.length > 0,
      subtitle: terminal.cwd ? getProjectName(terminal.cwd) : undefined,
      projectPath: terminal.cwd,
      timestamp: terminal.lastActivityAt ?? terminal.createdAt,
      cwd: terminal.cwd,
      hasTab: paneInfo?.hasTab ?? false,
      ratchetedActivity: sessionActivity[key],
      isRunning: true,
      runningTerminalId: terminal.terminalId,
      runningTerminalIds: [terminal.terminalId],
      isFallback: true,
      liveTerminalOnly: true,
      isRestorable: false,
      isSubagent: terminal.resumeTargetIsSubagent === true ? true : undefined,
    }
    itemsByKey.set(key, item)
  }

  return Array.from(itemsByKey.values())
}

function filterSessionItems(items: SidebarSessionItem[], filter: string): SidebarSessionItem[] {
  if (!filter.trim()) return items
  const q = filter.toLowerCase()
  return items.filter(
    (item) =>
      item.title.toLowerCase().includes(q) ||
      item.subtitle?.toLowerCase().includes(q) ||
      item.projectPath?.toLowerCase().includes(q) ||
      item.provider.toLowerCase().includes(q)
  )
}

export const ALL_REPOS = 'all'

export interface RepoFilterOption {
  value: string
  label: string
}

export function filterSessionItemsByRepo(
  items: SidebarSessionItem[],
  repoFilter: string,
): SidebarSessionItem[] {
  if (repoFilter === ALL_REPOS) return items
  return items.filter((item) => item.repoPath === repoFilter)
}

export function collectRepoFilterOptions(
  items: SidebarSessionItem[],
  selected: string,
): RepoFilterOption[] {
  const paths = new Set<string>()
  for (const item of items) {
    if (item.repoPath) paths.add(item.repoPath)
  }
  if (selected !== ALL_REPOS) paths.add(selected)
  return [...paths]
    .map((value) => ({ value, label: getProjectName(value) }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value))
}

// 'all' cannot collide with a real sessionType in practice; mirrors ALL_REPOS.
export const ALL_AGENTS = 'all'

export interface AgentFilterOption {
  value: string
  label: string
}

export function filterSessionItemsByAgent(
  items: SidebarSessionItem[],
  agentFilter: string,
): SidebarSessionItem[] {
  if (agentFilter === ALL_AGENTS) return items
  return items.filter((item) => item.sessionType === agentFilter)
}

export function collectAgentFilterOptions(
  items: SidebarSessionItem[],
  selected: string,
  getLabel: (sessionType: string) => string,
): AgentFilterOption[] {
  const types = new Set<string>()
  for (const item of items) {
    if (item.sessionType) types.add(item.sessionType)
  }
  if (selected !== ALL_AGENTS) types.add(selected)
  return [...types]
    .map((value) => ({ value, label: getLabel(value) }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value))
}

function filterSessionItemsForAppliedSearch(
  items: SidebarSessionItem[],
  appliedQuery: string,
  appliedSearchTier?: 'title' | 'userMessages' | 'fullText',
): SidebarSessionItem[] {
  const query = appliedQuery.trim()
  if (!query) return items

  const tier = appliedSearchTier ?? 'title'
  if (tier !== 'title') {
    return items.filter((item) => !item.isFallback)
  }

  return items.filter((item) => (
    !item.isFallback || matchTitleTierMetadata({
      title: item.title,
      projectPath: item.projectPath,
      cwd: item.cwd,
      firstUserMessage: item.firstUserMessage,
    }, query) !== null
  ))
}

export interface VisibilitySettings {
  showSubagents: boolean
  ignoreCodexSubagents: boolean
  showNoninteractiveSessions: boolean
  hideEmptySessions: boolean
  excludeFirstChatSubstrings: string[]
  excludeFirstChatMustStart: boolean
}

function isExcludedByFirstUserMessage(
  firstUserMessage: string | undefined,
  exclusions: string[],
  mustStart: boolean,
): boolean {
  if (!firstUserMessage || exclusions.length === 0) return false
  return exclusions.some((term) => (
    mustStart
      ? firstUserMessage.startsWith(term)
      : firstUserMessage.includes(term)
  ))
}

function shouldHideAsNonInteractive(item: SidebarSessionItem, showNoninteractiveSessions: boolean): boolean {
  if (showNoninteractiveSessions || !item.isNonInteractive) return false
  return !getFreshAgentProviderConfig(item.sessionType)
}

export function filterSessionItemsByVisibility(
  items: SidebarSessionItem[],
  settings: VisibilitySettings,
): SidebarSessionItem[] {
  const exclusions = settings.excludeFirstChatSubstrings
    .map((term) => term.trim())
    .filter((term) => term.length > 0)

  return items.filter((item) => {
    if (!settings.showSubagents && item.isSubagent) return false
    if (settings.ignoreCodexSubagents && item.isSubagent && item.provider === 'codex') return false
    if (shouldHideAsNonInteractive(item, settings.showNoninteractiveSessions)) return false
    if (settings.hideEmptySessions && !item.hasTitle && !item.hasTab && !item.isRunning) return false
    if (isExcludedByFirstUserMessage(item.firstUserMessage, exclusions, settings.excludeFirstChatMustStart)) return false
    return true
  })
}

export function sortSessionItems(
  items: SidebarSessionItem[],
  sortMode: string,
  options?: { disableTabPinning?: boolean; statusTiers?: Record<string, SessionStatusTier> },
): SidebarSessionItem[] {
  const sorted = [...items]

  const active = sorted.filter((i) => !i.archived)
  const archived = sorted.filter((i) => i.archived)

  const compareBySessionKey = (a: SidebarSessionItem, b: SidebarSessionItem) =>
    a.provider.localeCompare(b.provider) || a.sessionId.localeCompare(b.sessionId)

  const compareByRecency = (a: SidebarSessionItem, b: SidebarSessionItem) =>
    b.timestamp - a.timestamp || compareBySessionKey(a, b)
  const compareByActivity = (a: SidebarSessionItem, b: SidebarSessionItem) => {
    const aHasRatcheted = typeof a.ratchetedActivity === 'number'
    const bHasRatcheted = typeof b.ratchetedActivity === 'number'
    if (aHasRatcheted !== bHasRatcheted) return aHasRatcheted ? -1 : 1
    const aTime = a.ratchetedActivity ?? a.timestamp
    const bTime = b.ratchetedActivity ?? b.timestamp
    return bTime - aTime || compareBySessionKey(a, b)
  }

  /**
   * Activity-recency WITHOUT the hasRatcheted-first sub-partition. Used by the
   * tiered path: within a status tier the ordering is pure recency
   * (ratchetedActivity ?? timestamp), so a grey session touched on transition
   * to grey competes with untouched greys on timestamp alone.
   */
  const compareByActivityRecency = (a: SidebarSessionItem, b: SidebarSessionItem) => {
    const aTime = a.ratchetedActivity ?? a.timestamp
    const bTime = b.ratchetedActivity ?? b.timestamp
    return bTime - aTime || compareBySessionKey(a, b)
  }

  /**
   * Tiered activity ordering for the default sidebar sort: local-busy (solid
   * blue) → local-open (solid green) → remote-busy (blue ring) → remote-open
   * (green ring) → grey, with activity recency inside each tier. The tier map
   * is authoritative — an item absent from it is grey here even if it happens
   * to carry hasTab (the producing selector owns that mapping).
   *
   * Within-tier comparators preserve the pre-tiering semantics exactly:
   * locally-open tiers reuse the old withTabs comparator (pure recency), while
   * remote/grey tiers reuse the old withoutTabs comparator (ratchet-presence
   * first, then recency) — so a grey-transition touch (a ratchet write) floats
   * the session to the very top of the grey tier.
   */
  const LOCAL_TIER_MAX_RANK = 1
  const compareByStatusTiers = (statusTiers: Record<string, SessionStatusTier>) =>
    (a: SidebarSessionItem, b: SidebarSessionItem) => {
      const aRank = sessionStatusTierRank(statusTiers, `${a.provider}:${a.sessionId}`)
      const bRank = sessionStatusTierRank(statusTiers, `${b.provider}:${b.sessionId}`)
      if (aRank !== bRank) return aRank - bRank
      return aRank <= LOCAL_TIER_MAX_RANK ? compareByActivityRecency(a, b) : compareByActivity(a, b)
    }

  const sortByMode = (list: SidebarSessionItem[]) => {
    const copy = [...list]

    if (sortMode === 'recency') {
      return copy.sort(compareByRecency)
    }

    if (sortMode === 'recency-pinned') {
      if (options?.disableTabPinning) {
        return copy.sort(compareByRecency)
      }

      const withTabs = copy.filter((i) => i.hasTab)
      const withoutTabs = copy.filter((i) => !i.hasTab)

      withTabs.sort(compareByRecency)
      withoutTabs.sort(compareByRecency)

      return [...withTabs, ...withoutTabs]
    }

    if (sortMode === 'activity') {
      if (options?.disableTabPinning) {
        return copy.sort(compareByActivity)
      }

      if (options?.statusTiers) {
        return copy.sort(compareByStatusTiers(options.statusTiers))
      }

      const withTabs = copy.filter((i) => i.hasTab)
      const withoutTabs = copy.filter((i) => !i.hasTab)

      withTabs.sort((a, b) => {
        const aTime = a.ratchetedActivity ?? a.timestamp
        const bTime = b.ratchetedActivity ?? b.timestamp
        return bTime - aTime || compareBySessionKey(a, b)
      })

      withoutTabs.sort((a, b) => {
        const aHasRatcheted = typeof a.ratchetedActivity === 'number'
        const bHasRatcheted = typeof b.ratchetedActivity === 'number'
        if (aHasRatcheted !== bHasRatcheted) return aHasRatcheted ? -1 : 1
        const aTime = a.ratchetedActivity ?? a.timestamp
        const bTime = b.ratchetedActivity ?? b.timestamp
        return bTime - aTime || compareBySessionKey(a, b)
      })

      return [...withTabs, ...withoutTabs]
    }

    if (sortMode === 'project') {
      return copy.sort((a, b) => {
        const projA = a.projectPath || a.subtitle || ''
        const projB = b.projectPath || b.subtitle || ''
        if (projA !== projB) return projA.localeCompare(projB)
        return b.timestamp - a.timestamp || compareBySessionKey(a, b)
      })
    }

    return copy
  }

  return [...sortByMode(active), ...sortByMode(archived)]
}

export const makeSelectSortedSessionItems = () =>
  createSelector(
    [
      selectProjects,
      selectTabs,
      selectPanes,
      selectPaneLastInputAt,
      selectSessionActivityForSort,
      selectSortMode,
      selectWorktreeGrouping,
      selectShowSubagents,
      selectIgnoreCodexSubagents,
      selectShowNoninteractiveSessions,
      selectHideEmptySessions,
      selectExcludeFirstChatSubstrings,
      selectExcludeFirstChatMustStart,
      selectAppliedQuery,
      selectAppliedSearchTier,
      selectTerminals,
      selectFilter,
      selectSessionStatusTiers,
    ],
    (
      projects,
      tabs,
      panes,
      paneLastInputAt,
      sessionActivity,
      sortMode,
      worktreeGrouping,
      showSubagents,
      ignoreCodexSubagents,
      showNoninteractiveSessions,
      hideEmptySessions,
      excludeFirstChatSubstrings,
      excludeFirstChatMustStart,
      appliedQuery,
      appliedSearchTier,
      terminals,
      filter,
      sessionStatusTiers,
    ) => {
      const items = buildSessionItems(projects, tabs, panes, terminals, sessionActivity, worktreeGrouping, paneLastInputAt)
      const visible = filterSessionItemsByVisibility(items, {
        showSubagents,
        ignoreCodexSubagents,
        showNoninteractiveSessions,
        hideEmptySessions,
        excludeFirstChatSubstrings,
        excludeFirstChatMustStart,
      })
      const searchAware = filterSessionItemsForAppliedSearch(visible, appliedQuery, appliedSearchTier)
      const filtered = filterSessionItems(searchAware, filter)
      return sortSessionItems(filtered, sortMode, {
        disableTabPinning: appliedQuery.trim().length > 0,
        statusTiers: sessionStatusTiers,
      })
    }
  )

export const makeSelectKnownSessionKeys = () =>
  createSelector(
    [selectProjects],
    (projects) => {
      const keys = new Set<string>()
      for (const project of projects || []) {
        for (const session of project.sessions || []) {
          const provider = session.provider || 'claude'
          keys.add(`${provider}:${session.sessionId}`)
        }
      }
      return keys
    }
  )
