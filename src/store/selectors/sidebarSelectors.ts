import { createSelector } from '@reduxjs/toolkit'
import type { RootState } from '../store'
import type { BackgroundTerminal } from '../types'

export interface SidebarSessionItem {
  id: string
  sessionId: string
  title: string
  subtitle?: string
  projectPath?: string
  projectColor?: string
  timestamp: number
  cwd?: string
  hasTab: boolean
  tabLastInputAt?: number
  ratchetedActivity?: number
  isRunning: boolean
  runningTerminalId?: string
}

const EMPTY_ACTIVITY: Record<string, number> = {}

const selectProjects = (state: RootState) => state.sessions.projects
const selectTabs = (state: RootState) => state.tabs.tabs
const selectSortMode = (state: RootState) => state.settings.settings.sidebar?.sortMode || 'activity'
const selectSessionActivityForSort = (state: RootState) => {
  const sortMode = state.settings.settings.sidebar?.sortMode || 'activity'
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
  tabs: RootState['tabs']['tabs'],
  terminals: BackgroundTerminal[],
  sessionActivity: Record<string, number>
): SidebarSessionItem[] {
  const items: SidebarSessionItem[] = []
  const runningSessionMap = new Map<string, string>()
  const tabSessionMap = new Map<string, { hasTab: boolean; lastInputAt?: number }>()

  for (const terminal of terminals || []) {
    if (terminal.mode === 'claude' && terminal.status === 'running' && terminal.resumeSessionId) {
      runningSessionMap.set(terminal.resumeSessionId, terminal.terminalId)
    }
  }

  for (const tab of tabs || []) {
    if (!tab.resumeSessionId) continue
    const existing = tabSessionMap.get(tab.resumeSessionId)
    if (!existing) {
      tabSessionMap.set(tab.resumeSessionId, { hasTab: true, lastInputAt: tab.lastInputAt })
      continue
    }
    const existingTime = existing.lastInputAt ?? 0
    const nextTime = tab.lastInputAt ?? 0
    if (nextTime > existingTime) {
      tabSessionMap.set(tab.resumeSessionId, { hasTab: true, lastInputAt: tab.lastInputAt })
    }
  }

  for (const project of projects || []) {
    for (const session of project.sessions || []) {
      const runningTerminalId = runningSessionMap.get(session.sessionId)
      const tabInfo = tabSessionMap.get(session.sessionId)
      const ratchetedActivity = sessionActivity[session.sessionId]
      items.push({
        id: `session-${session.sessionId}`,
        sessionId: session.sessionId,
        title: session.title || session.sessionId.slice(0, 8),
        subtitle: getProjectName(project.projectPath),
        projectPath: project.projectPath,
        projectColor: project.color,
        timestamp: session.updatedAt,
        cwd: session.cwd,
        hasTab: tabInfo?.hasTab ?? false,
        tabLastInputAt: tabInfo?.lastInputAt,
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
      item.projectPath?.toLowerCase().includes(q)
  )
}

function sortSessionItems(items: SidebarSessionItem[], sortMode: string): SidebarSessionItem[] {
  const sorted = [...items]

  if (sortMode === 'recency') {
    return sorted.sort((a, b) => b.timestamp - a.timestamp)
  }

  if (sortMode === 'activity') {
    const withTabs = sorted.filter((i) => i.hasTab)
    const withoutTabs = sorted.filter((i) => !i.hasTab)

    withTabs.sort((a, b) => {
      const aTime = a.tabLastInputAt ?? a.timestamp
      const bTime = b.tabLastInputAt ?? b.timestamp
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
    return sorted.sort((a, b) => {
      const projA = a.projectPath || a.subtitle || ''
      const projB = b.projectPath || b.subtitle || ''
      if (projA !== projB) return projA.localeCompare(projB)
      return b.timestamp - a.timestamp
    })
  }

  return sorted
}

export const makeSelectSortedSessionItems = () =>
  createSelector(
    [selectProjects, selectTabs, selectSessionActivityForSort, selectSortMode, selectTerminals, selectFilter],
    (projects, tabs, sessionActivity, sortMode, terminals, filter) => {
      const items = buildSessionItems(projects, tabs, terminals, sessionActivity)
      const filtered = filterSessionItems(items, filter)
      return sortSessionItems(filtered, sortMode)
    }
  )
