import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import type { ProjectGroup } from './types'

function normalizeProjects(payload: unknown): ProjectGroup[] {
  if (!Array.isArray(payload)) return []
  const out: ProjectGroup[] = []
  for (const raw of payload as any[]) {
    if (!raw || typeof raw !== 'object') continue
    const projectPath = (raw as any).projectPath
    if (typeof projectPath !== 'string' || projectPath.length === 0) continue
    const sessionsRaw = (raw as any).sessions
    const sessions = Array.isArray(sessionsRaw)
      ? sessionsRaw.filter((s) => !!s && typeof s === 'object' && !Array.isArray(s))
      : []
    const color = typeof (raw as any).color === 'string' ? (raw as any).color : undefined
    out.push({ projectPath, sessions, ...(color ? { color } : {}) } as ProjectGroup)
  }
  return out
}

function projectNewestUpdatedAt(project: ProjectGroup): number {
  // Sessions are expected sorted by updatedAt desc from the server, but don't rely on it.
  let max = 0
  for (const s of project.sessions || []) {
    if (typeof (s as any).updatedAt === 'number') max = Math.max(max, (s as any).updatedAt)
  }
  return max
}

function sortProjectsByRecency(projects: ProjectGroup[]): ProjectGroup[] {
  const newestByPath = new Map<string, number>()
  const newest = (project: ProjectGroup): number => {
    if (newestByPath.has(project.projectPath)) return newestByPath.get(project.projectPath)!
    const time = projectNewestUpdatedAt(project)
    newestByPath.set(project.projectPath, time)
    return time
  }

  return [...projects].sort((a, b) => {
    const diff = newest(b) - newest(a)
    if (diff !== 0) return diff
    if (a.projectPath < b.projectPath) return -1
    if (a.projectPath > b.projectPath) return 1
    return 0
  })
}

export interface SessionsState {
  projects: ProjectGroup[]
  expandedProjects: Set<string>
  wsSnapshotReceived: boolean
  lastLoadedAt?: number
  totalSessions?: number
  oldestLoadedTimestamp?: number
  oldestLoadedSessionId?: string
  hasMore?: boolean
  loadingMore?: boolean
}

const initialState: SessionsState = {
  projects: [],
  expandedProjects: new Set<string>(),
  wsSnapshotReceived: false,
}

export const sessionsSlice = createSlice({
  name: 'sessions',
  initialState,
  reducers: {
    markWsSnapshotReceived: (state) => {
      state.wsSnapshotReceived = true
    },
    resetWsSnapshotReceived: (state) => {
      state.wsSnapshotReceived = false
    },
    setProjects: (state, action: PayloadAction<ProjectGroup[]>) => {
      state.projects = normalizeProjects(action.payload)
      state.lastLoadedAt = Date.now()
      const valid = new Set(state.projects.map((p) => p.projectPath))
      state.expandedProjects = new Set(Array.from(state.expandedProjects).filter((k) => valid.has(k)))
    },
    clearProjects: (state) => {
      state.projects = []
      state.expandedProjects = new Set()
      state.wsSnapshotReceived = false
      state.totalSessions = undefined
      state.oldestLoadedTimestamp = undefined
      state.oldestLoadedSessionId = undefined
      state.hasMore = undefined
      state.loadingMore = undefined
    },
    mergeProjects: (state, action: PayloadAction<ProjectGroup[]>) => {
      const incoming = normalizeProjects(action.payload)
      // Merge incoming projects with existing ones by projectPath
      const projectMap = new Map(state.projects.map((p) => [p.projectPath, p]))
      for (const project of incoming) {
        projectMap.set(project.projectPath, project)
      }
      state.projects = Array.from(projectMap.values())
      state.lastLoadedAt = Date.now()
      const valid = new Set(state.projects.map((p) => p.projectPath))
      state.expandedProjects = new Set(Array.from(state.expandedProjects).filter((k) => valid.has(k)))
    },
    applySessionsPatch: (
      state,
      action: PayloadAction<{ upsertProjects: ProjectGroup[]; removeProjectPaths: string[] }>
    ) => {
      if (!state.wsSnapshotReceived) return
      const remove = new Set(action.payload.removeProjectPaths || [])
      const incoming = normalizeProjects(action.payload.upsertProjects)

      const projectMap = new Map(state.projects.map((p) => [p.projectPath, p]))

      for (const key of remove) projectMap.delete(key)
      for (const project of incoming) projectMap.set(project.projectPath, project)

      state.projects = sortProjectsByRecency(Array.from(projectMap.values()))
      state.lastLoadedAt = Date.now()

      const valid = new Set(state.projects.map((p) => p.projectPath))
      state.expandedProjects = new Set(Array.from(state.expandedProjects).filter((k) => valid.has(k)))
    },
    clearPaginationMeta: (state) => {
      state.totalSessions = undefined
      state.oldestLoadedTimestamp = undefined
      state.oldestLoadedSessionId = undefined
      state.hasMore = undefined
      state.loadingMore = undefined
    },
    setPaginationMeta: (
      state,
      action: PayloadAction<{
        totalSessions: number
        oldestLoadedTimestamp: number
        oldestLoadedSessionId: string
        hasMore: boolean
      }>,
    ) => {
      const { totalSessions, oldestLoadedTimestamp, oldestLoadedSessionId, hasMore } = action.payload
      state.totalSessions = totalSessions
      state.oldestLoadedTimestamp = oldestLoadedTimestamp
      state.oldestLoadedSessionId = oldestLoadedSessionId
      state.hasMore = hasMore
    },
    appendSessionsPage: (state, action: PayloadAction<ProjectGroup[]>) => {
      const incoming = normalizeProjects(action.payload)
      // Build a set of existing session keys for deduplication
      const existingKeys = new Set<string>()
      for (const project of state.projects) {
        for (const session of project.sessions) {
          const s = session as any
          existingKeys.add(`${s.provider}:${s.sessionId}`)
        }
      }
      // Merge incoming sessions into existing projects, deduplicating
      const projectMap = new Map(state.projects.map((p) => [p.projectPath, { ...p, sessions: [...p.sessions] }]))
      for (const project of incoming) {
        const existing = projectMap.get(project.projectPath)
        if (existing) {
          for (const session of project.sessions) {
            const key = `${(session as any).provider}:${(session as any).sessionId}`
            if (!existingKeys.has(key)) {
              existing.sessions.push(session)
              existingKeys.add(key)
            }
          }
        } else {
          // New project — filter out any globally duplicate sessions
          const filtered = project.sessions.filter((s) => {
            const key = `${(s as any).provider}:${(s as any).sessionId}`
            if (existingKeys.has(key)) return false
            existingKeys.add(key)
            return true
          })
          if (filtered.length > 0) {
            projectMap.set(project.projectPath, { ...project, sessions: filtered })
          }
        }
      }
      state.projects = sortProjectsByRecency(Array.from(projectMap.values()))
      state.lastLoadedAt = Date.now()
      state.loadingMore = false
      const valid = new Set(state.projects.map((p) => p.projectPath))
      state.expandedProjects = new Set(Array.from(state.expandedProjects).filter((k) => valid.has(k)))
    },
    setLoadingMore: (state, action: PayloadAction<boolean>) => {
      state.loadingMore = action.payload
    },
    toggleProjectExpanded: (state, action: PayloadAction<string>) => {
      const key = action.payload
      if (state.expandedProjects.has(key)) state.expandedProjects.delete(key)
      else state.expandedProjects.add(key)
    },
    setProjectExpanded: (state, action: PayloadAction<{ projectPath: string; expanded: boolean }>) => {
      const { projectPath, expanded } = action.payload
      if (expanded) state.expandedProjects.add(projectPath)
      else state.expandedProjects.delete(projectPath)
    },
    collapseAll: (state) => {
      state.expandedProjects = new Set()
    },
    expandAll: (state) => {
      state.expandedProjects = new Set(state.projects.map((p) => p.projectPath))
    },
  },
})

export const {
  markWsSnapshotReceived,
  resetWsSnapshotReceived,
  setProjects,
  clearProjects,
  mergeProjects,
  applySessionsPatch,
  clearPaginationMeta,
  setPaginationMeta,
  appendSessionsPage,
  setLoadingMore,
  toggleProjectExpanded,
  setProjectExpanded,
  collapseAll,
  expandAll,
} =
  sessionsSlice.actions

export default sessionsSlice.reducer
