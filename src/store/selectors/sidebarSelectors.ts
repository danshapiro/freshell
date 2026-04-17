import { createSelector } from '@reduxjs/toolkit'
import type { RootState } from '../store'
import type { BackgroundTerminal, CodingCliProviderName, WorktreeGrouping } from '../types'
import { isValidClaudeSessionId } from '@/lib/claude-session-id'
import { collectSessionRefsFromNode, collectSessionRefsFromTabs } from '@/lib/session-utils'
import { getAgentChatProviderConfig } from '@/lib/agent-chat-utils'
import { getSessionMetadata } from '@/lib/session-metadata'
import type { SessionListMetadata } from '../types'
import { getLeafDirectoryName, matchTitleTierMetadata } from '../../../shared/session-title-search.js'

export interface SidebarSessionItem {
  id: string
  sessionId: string
  provider: CodingCliProviderName
  sessionType: string  // Defaults to provider when not explicitly set
  title: string
  subtitle?: string
  projectPath?: string
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
}

const EMPTY_ACTIVITY: Record<string, number> = {}
const EMPTY_STRINGS: string[] = []

const selectProjects = (state: RootState) => state.sessions.windows?.sidebar?.projects ?? state.sessions.projects
const selectTabs = (state: RootState) => state.tabs.tabs
const selectPanes = (state: RootState) => state.panes
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

export function buildSessionItems(
  projects: RootState['sessions']['projects'],
  tabs: RootState['tabs']['tabs'],
  panes: RootState['panes'],
  terminals: BackgroundTerminal[],
  sessionActivity: Record<string, number>,
  worktreeGrouping: WorktreeGrouping = 'repo',
): SidebarSessionItem[] {
  const items: SidebarSessionItem[] = []
  const itemsByKey = new Map<string, SidebarSessionItem>()
  const runningSessionMap = new Map<string, { terminalId: string; createdAt: number; allTerminalIds: string[] }>()
  const tabSessionMap = new Map<string, { hasTab: boolean }>()

  for (const terminal of terminals || []) {
    if (terminal.mode && terminal.mode !== 'shell' && terminal.status === 'running' && terminal.resumeSessionId) {
      const sessionKey = `${terminal.mode}:${terminal.resumeSessionId}`
      const existing = runningSessionMap.get(sessionKey)
      if (existing) {
        existing.allTerminalIds.push(terminal.terminalId)
        if (terminal.createdAt < existing.createdAt) {
          existing.terminalId = terminal.terminalId
          existing.createdAt = terminal.createdAt
        }
      } else {
        runningSessionMap.set(sessionKey, { terminalId: terminal.terminalId, createdAt: terminal.createdAt, allTerminalIds: [terminal.terminalId] })
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
      const runningTerminalId = runningTerminal?.terminalId
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
      }
      items.push(item)
      itemsByKey.set(key, item)
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
  }) => {
    const key = `${input.provider}:${input.sessionId}`
    const existing = itemsByKey.get(key)
    if (existing) {
      existing.hasTab = true
      existing.timestamp = Math.max(existing.timestamp, input.timestamp ?? 0)
      const fallbackTitle = input.title?.trim()
      if (!existing.hasTitle && fallbackTitle) {
        existing.title = fallbackTitle
        existing.hasTitle = true
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
    const item: SidebarSessionItem = {
      id: `session-${input.provider}-${input.sessionId}`,
      sessionId: input.sessionId,
      provider: input.provider,
      sessionType: input.metadata?.sessionType || input.sessionType,
      title: fallbackTitle,
      hasTitle: fallbackTitle !== input.sessionId.slice(0, 8),
      subtitle: input.cwd ? getProjectName(input.cwd) : undefined,
      projectPath: input.cwd,
      timestamp: input.timestamp ?? 0,
      cwd: input.cwd,
      hasTab: true,
      ratchetedActivity: sessionActivity[key],
      isRunning: !!runningTerminalId,
      runningTerminalId,
      runningTerminalIds,
      isSubagent: input.metadata?.isSubagent,
      isNonInteractive: input.metadata?.isNonInteractive,
      firstUserMessage: input.metadata?.firstUserMessage,
      isFallback: true,
    }
    items.push(item)
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
    const fallbackTimestamp = tab.lastInputAt ?? tab.createdAt ?? 0

    if (node.content.kind === 'agent-chat') {
      const sessionId = node.content.resumeSessionId
      if (!sessionId || !isValidClaudeSessionId(sessionId)) return
      const metadata = getSessionMetadata(tab, 'claude', sessionId)
      pushFallbackItem({
        provider: 'claude',
        sessionId,
        sessionType: node.content.provider || 'claude',
        title: paneTitle || tab.title,
        cwd: undefined,
        timestamp: fallbackTimestamp,
        metadata,
      })
      return
    }

    if (node.content.kind !== 'terminal') return
    if (node.content.mode === 'shell' || !node.content.resumeSessionId) return

    const metadata = getSessionMetadata(tab, node.content.mode, node.content.resumeSessionId)
    pushFallbackItem({
      provider: node.content.mode,
      sessionId: node.content.resumeSessionId,
      sessionType: node.content.mode,
      title: paneTitle || tab.title,
      cwd: node.content.initialCwd,
      timestamp: fallbackTimestamp,
      metadata,
    })
  }

  for (const tab of tabs || []) {
    const layout = panes.layouts?.[tab.id]
    if (layout) {
      const refs = collectSessionRefsFromNode(layout)
      if (refs.length > 0) {
        collectFallbackItemsFromNode(layout, tab)
      }
      continue
    }

    const provider = tab.codingCliProvider || (tab.mode !== 'shell' ? tab.mode : undefined)
    const sessionId = tab.resumeSessionId
    if (!provider || !sessionId) continue

    const metadata = getSessionMetadata(tab, provider, sessionId)
    pushFallbackItem({
      provider,
      sessionId,
      sessionType: metadata?.sessionType || provider,
      title: tab.title,
      cwd: undefined,
      timestamp: tab.lastInputAt ?? tab.createdAt ?? 0,
      metadata,
    })
  }

  return items
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
  return !getAgentChatProviderConfig(item.sessionType)
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
  options?: { disableTabPinning?: boolean },
): SidebarSessionItem[] {
  const sorted = [...items]

  const active = sorted.filter((i) => !i.archived)
  const archived = sorted.filter((i) => i.archived)

  const compareByRecency = (a: SidebarSessionItem, b: SidebarSessionItem) => b.timestamp - a.timestamp
  const compareByActivity = (a: SidebarSessionItem, b: SidebarSessionItem) => {
    const aHasRatcheted = typeof a.ratchetedActivity === 'number'
    const bHasRatcheted = typeof b.ratchetedActivity === 'number'
    if (aHasRatcheted !== bHasRatcheted) return aHasRatcheted ? -1 : 1
    const aTime = a.ratchetedActivity ?? a.timestamp
    const bTime = b.ratchetedActivity ?? b.timestamp
    return bTime - aTime
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

      const withTabs = copy.filter((i) => i.hasTab)
      const withoutTabs = copy.filter((i) => !i.hasTab)

      withTabs.sort((a, b) => {
        const aTime = a.ratchetedActivity ?? a.timestamp
        const bTime = b.ratchetedActivity ?? b.timestamp
        return bTime - aTime
      })

      withoutTabs.sort((a, b) => {
        const aHasRatcheted = typeof a.ratchetedActivity === 'number'
        const bHasRatcheted = typeof b.ratchetedActivity === 'number'
        if (aHasRatcheted !== bHasRatcheted) return aHasRatcheted ? -1 : 1
        const aTime = a.ratchetedActivity ?? a.timestamp
        const bTime = b.ratchetedActivity ?? b.timestamp
        return bTime - aTime
      })

      return [...withTabs, ...withoutTabs]
    }

    if (sortMode === 'project') {
      return copy.sort((a, b) => {
        const projA = a.projectPath || a.subtitle || ''
        const projB = b.projectPath || b.subtitle || ''
        if (projA !== projB) return projA.localeCompare(projB)
        return b.timestamp - a.timestamp
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
    ],
    (
      projects,
      tabs,
      panes,
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
      filter
    ) => {
      const items = buildSessionItems(projects, tabs, panes, terminals, sessionActivity, worktreeGrouping)
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
