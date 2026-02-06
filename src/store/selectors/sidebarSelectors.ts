import { createSelector } from '@reduxjs/toolkit'
import type { RootState } from '../store'
import type { BackgroundTerminal, CodingCliProviderName } from '../types'
import { collectTerminalPanes, collectSessionPanes } from '@/lib/pane-utils'

export interface SidebarSessionItem {
  id: string
  sessionId: string
  provider: CodingCliProviderName
  title: string
  subtitle?: string
  projectPath?: string
  projectColor?: string
  archived?: boolean
  timestamp: number
  cwd?: string
  hasTab: boolean
  tabLastInputAt?: number
  ratchetedActivity?: number
  isRunning: boolean
  runningTerminalId?: string
}

const EMPTY_ACTIVITY: Record<string, number> = {}
const EMPTY_PROJECTS: RootState['sessions']['projects'] = []
const EMPTY_LAYOUTS: RootState['panes']['layouts'] = {}

const selectProjects = (state: RootState) => state.sessions?.projects ?? EMPTY_PROJECTS
const selectLayouts = (state: RootState) => state.panes?.layouts ?? EMPTY_LAYOUTS
const selectSortMode = (state: RootState) => state.settings?.settings?.sidebar?.sortMode || 'recency-pinned'
const selectSessionActivityForSort = (state: RootState) => {
  const sortMode = state.settings?.settings?.sidebar?.sortMode || 'recency-pinned'
  if (sortMode !== 'activity') return EMPTY_ACTIVITY
  return state.sessionActivity?.sessions || EMPTY_ACTIVITY
}
const selectTerminals = (_state: RootState, terminals: BackgroundTerminal[]) => terminals
const selectFilter = (_state: RootState, _terminals: BackgroundTerminal[], filter: string) => filter

function getProjectName(projectPath: string): string {
  const parts = projectPath.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || projectPath
}

function buildSessionItems(
  projects: RootState['sessions']['projects'],
  layouts: RootState['panes']['layouts'],
  terminals: BackgroundTerminal[],
  sessionActivity: Record<string, number>
): SidebarSessionItem[] {
  const items: SidebarSessionItem[] = []
  const runningSessionMap = new Map<string, string>()
  const tabSessionSet = new Set<string>()

  for (const terminal of terminals || []) {
    if (terminal.mode && terminal.mode !== 'shell' && terminal.status === 'running' && terminal.resumeSessionId) {
      runningSessionMap.set(`${terminal.mode}:${terminal.resumeSessionId}`, terminal.terminalId)
    }
  }

  for (const layout of Object.values(layouts || {})) {
    // Collect from terminal panes (which may have resumeSessionId)
    const terminals = collectTerminalPanes(layout)
    for (const terminal of terminals) {
      if (!terminal.content.resumeSessionId) continue
      if (!terminal.content.mode || terminal.content.mode === 'shell') continue
      const key = `${terminal.content.mode}:${terminal.content.resumeSessionId}`
      tabSessionSet.add(key)
    }

    // Collect from session panes (non-terminal session views)
    const sessionPanes = collectSessionPanes(layout)
    for (const sessionPane of sessionPanes) {
      const provider = sessionPane.content.provider || 'claude'
      const key = `${provider}:${sessionPane.content.sessionId}`
      tabSessionSet.add(key)
    }
  }

  for (const project of projects || []) {
    for (const session of project.sessions || []) {
      const provider = session.provider || 'claude'
      const key = `${provider}:${session.sessionId}`
      const runningTerminalId = runningSessionMap.get(key)
      const hasTab = tabSessionSet.has(key)
      const ratchetedActivity = sessionActivity[key]
      items.push({
        id: `session-${provider}-${session.sessionId}`,
        sessionId: session.sessionId,
        provider,
        title: session.title || session.sessionId.slice(0, 8),
        subtitle: getProjectName(project.projectPath),
        projectPath: project.projectPath,
        projectColor: project.color,
        archived: session.archived,
        timestamp: session.updatedAt,
        cwd: session.cwd,
        hasTab,
        tabLastInputAt: hasTab ? sessionActivity[key] : undefined,
        ratchetedActivity,
        isRunning: !!runningTerminalId,
        runningTerminalId,
      })
    }
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

export function sortSessionItems(items: SidebarSessionItem[], sortMode: string): SidebarSessionItem[] {
  const sorted = [...items]

  const active = sorted.filter((i) => !i.archived)
  const archived = sorted.filter((i) => i.archived)

  const sortByMode = (list: SidebarSessionItem[]) => {
    const copy = [...list]

    if (sortMode === 'recency') {
      return copy.sort((a, b) => b.timestamp - a.timestamp)
    }

    if (sortMode === 'recency-pinned') {
      const withTabs = copy.filter((i) => i.hasTab)
      const withoutTabs = copy.filter((i) => !i.hasTab)

      withTabs.sort((a, b) => b.timestamp - a.timestamp)
      withoutTabs.sort((a, b) => b.timestamp - a.timestamp)

      return [...withTabs, ...withoutTabs]
    }

    if (sortMode === 'activity') {
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
    [selectProjects, selectLayouts, selectSessionActivityForSort, selectSortMode, selectTerminals, selectFilter],
    (projects, layouts, sessionActivity, sortMode, terminals, filter) => {
      const items = buildSessionItems(projects, layouts, terminals, sessionActivity)
      const filtered = filterSessionItems(items, filter)
      return sortSessionItems(filtered, sortMode)
    }
  )
