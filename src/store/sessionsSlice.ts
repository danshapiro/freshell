import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import type { ProjectGroup } from './types'

export type SessionWindowLoadingKind = 'initial' | 'search' | 'background' | 'pagination'

export interface SessionWindowState {
  projects: ProjectGroup[]
  lastLoadedAt?: number
  totalSessions?: number
  oldestLoadedTimestamp?: number
  oldestLoadedSessionId?: string
  hasMore?: boolean
  loading?: boolean
  loadingKind?: SessionWindowLoadingKind
  error?: string
  query?: string
  searchTier?: 'title' | 'userMessages' | 'fullText'
  deepSearchPending?: boolean
  partial?: boolean
  partialReason?: 'budget' | 'io_error'
}

function sessionKey(s: any): string {
  return `${s.provider || 'claude'}:${s.sessionId}`
}

function normalizeProjects(payload: unknown): ProjectGroup[] {
  if (!Array.isArray(payload)) return []
  const result: ProjectGroup[] = []
  for (const raw of payload as any[]) {
    if (!raw || typeof raw !== 'object') continue
    const projectPath = (raw as any).projectPath
    if (typeof projectPath !== 'string' || projectPath.length === 0) continue
    const sessionsRaw = (raw as any).sessions
    const sessions = Array.isArray(sessionsRaw)
      ? sessionsRaw.filter((s) => !!s && typeof s === 'object' && !Array.isArray(s))
      : []
    const color = typeof (raw as any).color === 'string' ? (raw as any).color : undefined
    result.push({ projectPath, sessions, ...(color ? { color } : {}) } as ProjectGroup)
  }
  return result
}

function projectNewestLastActivityAt(project: ProjectGroup): number {
  // Sessions are expected sorted by lastActivityAt desc from the server, but don't rely on it.
  let max = 0
  for (const s of project.sessions || []) {
    if (typeof (s as any).lastActivityAt === 'number') max = Math.max(max, (s as any).lastActivityAt)
  }
  return max
}

function sortProjectsByRecency(projects: ProjectGroup[]): ProjectGroup[] {
  const newestByPath = new Map<string, number>()
  const newest = (project: ProjectGroup): number => {
    if (newestByPath.has(project.projectPath)) return newestByPath.get(project.projectPath)!
    const time = projectNewestLastActivityAt(project)
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
  loadingKind?: SessionWindowLoadingKind
  activeSurface?: string
  windows: Record<string, SessionWindowState>
}

const initialState: SessionsState = {
  projects: [],
  expandedProjects: new Set<string>(),
  wsSnapshotReceived: false,
  windows: {},
}

function ensureWindow(state: SessionsState, surface: string): SessionWindowState {
  if (!state.windows) {
    state.windows = {}
  }
  if (!state.windows[surface]) {
    state.windows[surface] = {
      projects: [],
    }
  }
  return state.windows[surface]
}

function syncTopLevelFromWindow(state: SessionsState, surface: string) {
  const window = ensureWindow(state, surface)
  state.activeSurface = surface
  state.projects = window.projects
  state.lastLoadedAt = window.lastLoadedAt
  state.totalSessions = window.totalSessions
  state.oldestLoadedTimestamp = window.oldestLoadedTimestamp
  state.oldestLoadedSessionId = window.oldestLoadedSessionId
  state.hasMore = window.hasMore
  state.loadingMore = window.loading
  state.loadingKind = window.loadingKind
}

function syncActiveWindowFromTopLevel(state: SessionsState) {
  if (!state.activeSurface) return
  const window = ensureWindow(state, state.activeSurface)
  window.projects = state.projects
  window.lastLoadedAt = state.lastLoadedAt
  window.totalSessions = state.totalSessions
  window.oldestLoadedTimestamp = state.oldestLoadedTimestamp
  window.oldestLoadedSessionId = state.oldestLoadedSessionId
  window.hasMore = state.hasMore
  window.loading = state.loadingMore
  window.loadingKind = state.loadingKind
}

export const sessionsSlice = createSlice({
  name: 'sessions',
  initialState,
  reducers: {
    setActiveSessionSurface: (state, action: PayloadAction<string>) => {
      if (!state.windows) {
        state.windows = {}
      }
      if (
        !state.windows?.[action.payload] &&
        !state.activeSurface &&
        (state.projects.length > 0 || state.lastLoadedAt !== undefined)
      ) {
        state.windows[action.payload] = {
          projects: state.projects,
          lastLoadedAt: state.lastLoadedAt,
          totalSessions: state.totalSessions,
          oldestLoadedTimestamp: state.oldestLoadedTimestamp,
          oldestLoadedSessionId: state.oldestLoadedSessionId,
          hasMore: state.hasMore,
          loading: state.loadingMore,
          loadingKind: state.loadingKind,
        }
      }
      syncTopLevelFromWindow(state, action.payload)
    },
    setSessionWindowLoading: (
      state,
      action: PayloadAction<{
        surface: string
        loading: boolean
        loadingKind?: SessionWindowLoadingKind
        query?: string
        searchTier?: 'title' | 'userMessages' | 'fullText'
      }>,
    ) => {
      const window = ensureWindow(state, action.payload.surface)
      window.loading = action.payload.loading
      window.loadingKind = action.payload.loading ? action.payload.loadingKind : undefined
      if (action.payload.loading) {
        window.deepSearchPending = false
      }
      if (action.payload.query !== undefined) window.query = action.payload.query
      if (action.payload.searchTier !== undefined) window.searchTier = action.payload.searchTier
      if (state.activeSurface === action.payload.surface) {
        state.loadingMore = action.payload.loading
        state.loadingKind = action.payload.loading ? action.payload.loadingKind : undefined
      }
    },
    setSessionWindowError: (
      state,
      action: PayloadAction<{ surface: string; error?: string }>,
    ) => {
      const window = ensureWindow(state, action.payload.surface)
      window.error = action.payload.error
      if (action.payload.error !== undefined) {
        window.loadingKind = undefined
        if (state.activeSurface === action.payload.surface) {
          state.loadingKind = undefined
        }
      }
    },
    setSessionWindowData: (
      state,
      action: PayloadAction<{
        surface: string
        projects: ProjectGroup[]
        totalSessions?: number
        oldestLoadedTimestamp?: number
        oldestLoadedSessionId?: string
        hasMore?: boolean
        query?: string
        searchTier?: 'title' | 'userMessages' | 'fullText'
        deepSearchPending?: boolean
        partial?: boolean
        partialReason?: 'budget' | 'io_error'
      }>,
    ) => {
      const window = ensureWindow(state, action.payload.surface)
      window.projects = normalizeProjects(action.payload.projects)
      window.lastLoadedAt = Date.now()
      window.totalSessions = action.payload.totalSessions
      window.oldestLoadedTimestamp = action.payload.oldestLoadedTimestamp
      window.oldestLoadedSessionId = action.payload.oldestLoadedSessionId
      window.hasMore = action.payload.hasMore
      window.loading = false
      window.loadingKind = undefined
      window.error = undefined
      window.deepSearchPending = action.payload.deepSearchPending ?? false
      window.partial = action.payload.partial
      window.partialReason = action.payload.partialReason
      if (action.payload.query !== undefined) window.query = action.payload.query
      if (action.payload.searchTier !== undefined) window.searchTier = action.payload.searchTier
      if (!state.activeSurface || state.activeSurface === action.payload.surface) {
        syncTopLevelFromWindow(state, action.payload.surface)
      }
    },
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
      syncActiveWindowFromTopLevel(state)
    },
    clearProjects: (state) => {
      state.projects = []
      state.expandedProjects = new Set()
      state.wsSnapshotReceived = false
      state.lastLoadedAt = undefined
      state.totalSessions = undefined
      state.oldestLoadedTimestamp = undefined
      state.oldestLoadedSessionId = undefined
      state.hasMore = undefined
      state.loadingMore = undefined
      state.loadingKind = undefined
      if (state.activeSurface) {
        state.windows[state.activeSurface] = {
          projects: [],
        }
      }
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
      syncActiveWindowFromTopLevel(state)
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
      syncActiveWindowFromTopLevel(state)
    },
    clearPaginationMeta: (state) => {
      state.totalSessions = undefined
      state.oldestLoadedTimestamp = undefined
      state.oldestLoadedSessionId = undefined
      state.hasMore = undefined
      state.loadingMore = undefined
      state.loadingKind = undefined
      syncActiveWindowFromTopLevel(state)
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
      syncActiveWindowFromTopLevel(state)
    },
    appendSessionsPage: (state, action: PayloadAction<ProjectGroup[]>) => {
      const incoming = normalizeProjects(action.payload)
      // Build a set of existing session keys for deduplication
      const existingKeys = new Set<string>()
      for (const project of state.projects) {
        for (const session of project.sessions) {
          existingKeys.add(sessionKey(session))
        }
      }
      // Merge incoming sessions into existing projects, deduplicating
      const projectMap = new Map(state.projects.map((p) => [p.projectPath, { ...p, sessions: [...p.sessions] }]))
      for (const project of incoming) {
        const existing = projectMap.get(project.projectPath)
        if (existing) {
          for (const session of project.sessions) {
            const key = sessionKey(session)
            if (!existingKeys.has(key)) {
              existing.sessions.push(session)
              existingKeys.add(key)
            }
          }
        } else {
          // New project — filter out any globally duplicate sessions
          const filtered = project.sessions.filter((s) => {
            const key = sessionKey(s)
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
      state.loadingKind = undefined
      const valid = new Set(state.projects.map((p) => p.projectPath))
      state.expandedProjects = new Set(Array.from(state.expandedProjects).filter((k) => valid.has(k)))
      syncActiveWindowFromTopLevel(state)
    },
    setLoadingMore: (state, action: PayloadAction<boolean>) => {
      state.loadingMore = action.payload
      if (!action.payload) {
        state.loadingKind = undefined
      }
      syncActiveWindowFromTopLevel(state)
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
  },
})

export const {
  setActiveSessionSurface,
  setSessionWindowLoading,
  setSessionWindowError,
  setSessionWindowData,
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
} =
  sessionsSlice.actions

export default sessionsSlice.reducer
