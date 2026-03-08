import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import type { ProjectGroup } from './types'

function normalizeProjects(payload: unknown): ProjectGroup[] {
  if (!Array.isArray(payload)) return []
  // Use a Map to merge entries that share a projectPath (happens when the
  // server splits an oversized project across multiple WebSocket chunks).
  const merged = new Map<string, ProjectGroup>()
  for (const raw of payload as any[]) {
    if (!raw || typeof raw !== 'object') continue
    const projectPath = (raw as any).projectPath
    if (typeof projectPath !== 'string' || projectPath.length === 0) continue
    const sessionsRaw = (raw as any).sessions
    const sessions = Array.isArray(sessionsRaw)
      ? sessionsRaw.filter((s) => !!s && typeof s === 'object' && !Array.isArray(s))
      : []
    const color = typeof (raw as any).color === 'string' ? (raw as any).color : undefined
    const existing = merged.get(projectPath)
    if (existing) {
      const seen = new Set(existing.sessions.map((s: any) => s.sessionId))
      existing.sessions.push(...sessions.filter((s: any) => !seen.has(s.sessionId)))
      if (color && !existing.color) existing.color = color
    } else {
      merged.set(projectPath, { projectPath, sessions, ...(color ? { color } : {}) } as ProjectGroup)
    }
  }
  return Array.from(merged.values())
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
    /**
     * Merge a paginated snapshot into existing state. Unlike setProjects (which
     * replaces everything), this preserves sessions the user already loaded via
     * scroll pagination that fall outside the server's pagination window.
     *
     * For each project in the incoming snapshot, its sessions are authoritative
     * (freshest data from the server). Any existing sessions for that project
     * that are NOT present in the incoming data are appended (they're the older
     * ones beyond the pagination window). Projects not in the snapshot at all
     * are kept as-is.
     */
    mergeSnapshotProjects: (state, action: PayloadAction<ProjectGroup[]>) => {
      const incoming = normalizeProjects(action.payload)
      const existingMap = new Map(state.projects.map((p) => [p.projectPath, p]))

      for (const incomingProject of incoming) {
        const existing = existingMap.get(incomingProject.projectPath)
        if (!existing) {
          existingMap.set(incomingProject.projectPath, incomingProject)
          continue
        }
        // Build a set of session keys present in the incoming snapshot
        const incomingKeys = new Set(
          incomingProject.sessions.map((s: any) => `${s.provider || 'claude'}:${s.sessionId}`)
        )
        // Keep existing sessions that aren't in the incoming snapshot
        const retained = existing.sessions.filter(
          (s: any) => !incomingKeys.has(`${s.provider || 'claude'}:${s.sessionId}`)
        )
        existingMap.set(incomingProject.projectPath, {
          ...incomingProject,
          sessions: [...incomingProject.sessions, ...retained],
        })
      }

      state.projects = sortProjectsByRecency(Array.from(existingMap.values()))
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
  mergeSnapshotProjects,
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
