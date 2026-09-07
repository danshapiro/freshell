import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import type { SessionDirectoryContextUsageExtra, SessionDirectoryIntegrityError } from '@shared/read-models'
import type { TokenSummary } from '@shared/ws-protocol'
import type { ProjectGroup } from './types'
import type { TerminalMetaRecord } from './terminalMetaSlice'

export type SessionWindowLoadingKind = 'initial' | 'search' | 'background' | 'pagination'

export interface SessionWindowState {
  projects: ProjectGroup[]
  lastLoadedAt?: number
  resultVersion?: number
  totalSessions?: number
  oldestLoadedTimestamp?: number
  oldestLoadedSessionId?: string
  hasMore?: boolean
  /** Opaque cursor for continuing an active search query's pagination (server-side). */
  searchCursor?: string
  loading?: boolean
  loadingKind?: SessionWindowLoadingKind
  error?: string
  query?: string
  searchTier?: 'title' | 'userMessages' | 'fullText'
  appliedQuery?: string
  appliedSearchTier?: 'title' | 'userMessages' | 'fullText'
  deepSearchPending?: boolean
  partial?: boolean
  partialReason?: 'budget' | 'io_error'
  /** Conflicted persisted identities were quarantined by the server. */
  integrityError?: SessionDirectoryIntegrityError
}

function sessionKey(s: any): string {
  return `${s.provider || 'claude'}:${s.sessionId}`
}

/**
 * The usual session-window path is already valid and identity-unique. Keep
 * its project and session references intact instead of rebuilding every row
 * on each WebSocket patch; the slower normalizer below remains the defensive
 * path for persisted or malformed input.
 */
function projectsAreAlreadyNormalized(payload: unknown): payload is ProjectGroup[] {
  if (!Array.isArray(payload)) return false
  const seenSessionKeys = new Set<string>()
  for (const raw of payload) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
    const project = raw as ProjectGroup
    if (typeof project.projectPath !== 'string' || project.projectPath.length === 0) return false
    if (!Array.isArray(project.sessions)) return false
    if (project.color !== undefined && (typeof project.color !== 'string' || project.color.length === 0)) {
      return false
    }
    for (const session of project.sessions) {
      if (!session || typeof session !== 'object' || Array.isArray(session)) return false
      if (typeof session.sessionId !== 'string' || session.sessionId.length === 0) return false
      if (typeof session.provider !== 'string' || session.provider.length === 0) return false
      const key = sessionKey(session)
      if (seenSessionKeys.has(key)) return false
      seenSessionKeys.add(key)
    }
  }
  return true
}

function normalizeProjects(payload: unknown): ProjectGroup[] {
  if (projectsAreAlreadyNormalized(payload)) return payload
  if (!Array.isArray(payload)) return []
  const result: ProjectGroup[] = []
  const seenSessionKeys = new Set<string>()
  for (const raw of payload as any[]) {
    if (!raw || typeof raw !== 'object') continue
    const projectPath = (raw as any).projectPath
    if (typeof projectPath !== 'string' || projectPath.length === 0) continue
    const sessionsRaw = (raw as any).sessions
    const validSessions = Array.isArray(sessionsRaw)
      ? sessionsRaw.filter((s) => !!s && typeof s === 'object' && !Array.isArray(s))
      : []
    const sessions = validSessions.flatMap((session) => {
      const normalized = {
        ...session,
        provider: session.provider || 'claude',
      }
      const key = sessionKey(normalized)
      if (seenSessionKeys.has(key)) return []
      seenSessionKeys.add(key)
      return [normalized]
    })
    // Keep intentionally empty groups, but prune a group whose candidates
    // were all duplicates of an earlier authoritative appearance.
    if (validSessions.length > 0 && sessions.length === 0) continue
    const color = typeof (raw as any).color === 'string' ? (raw as any).color : undefined
    result.push({ projectPath, sessions, ...(color ? { color } : {}) } as ProjectGroup)
  }
  return result
}

function collectSessionKeys(projects: ProjectGroup[]): Set<string> {
  return new Set(
    projects.flatMap((project) => (project.sessions ?? []).map(sessionKey)),
  )
}

function removeSessionKeys(
  projects: ProjectGroup[],
  keys: Set<string>,
): ProjectGroup[] {
  if (keys.size === 0) return projects
  return projects.flatMap((project) => {
    const sourceSessions = project.sessions ?? []
    const sessions = sourceSessions.filter((session) => !keys.has(sessionKey(session)))
    if (sourceSessions.length > 0 && sessions.length === 0) return []
    return [{ ...project, sessions }]
  })
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
  /**
   * STATUS-STRIP: usage for open fresh-agent pane sessions. Keyed
   * `provider:sessionId`. Never merged into `projects`/windows; bounded to
   * the current `includeKeys` set on every commit. Competing writes are
   * ordered by the page's per-instance monotonic `snapshotSeq` (same
   * `serverInstance` only; cross-instance writes replace unconditionally).
   */
  contextUsageByKey: Record<string, {
    tokenUsage: TokenSummary
    sourceSeq: number
    serverInstance?: string
    bootId?: string
    /** Client-side wall-clock stamp of the redis write — drives the validity window. */
    fetchedAt: number
  }>
}

const initialState: SessionsState = {
  projects: [],
  expandedProjects: new Set<string>(),
  wsSnapshotReceived: false,
  windows: {},
  contextUsageByKey: {},
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

type SessionWindowCommitPayload = {
  surface: string
  projects: ProjectGroup[]
  totalSessions?: number
  oldestLoadedTimestamp?: number
  oldestLoadedSessionId?: string
  hasMore?: boolean
  searchCursor?: string
  query?: string
  searchTier?: 'title' | 'userMessages' | 'fullText'
  deepSearchPending?: boolean
  partial?: boolean
  partialReason?: 'budget' | 'io_error'
  integrityError?: SessionDirectoryIntegrityError
}

// Usage for the fresh-agent strip feeds the unified map ONLY through thunk-side
// stamping (applyContextUsageExtras) — never from this commit path: committed
// windows may contain merged/retained rows whose usage is not fresh and must
// never be re-served as current.
function commitWindowPayload(
  window: SessionWindowState,
  payload: SessionWindowCommitPayload,
) {
  window.projects = normalizeProjects(payload.projects)
  window.lastLoadedAt = Date.now()
  window.resultVersion = (window.resultVersion ?? 0) + 1
  window.totalSessions = payload.totalSessions
  window.oldestLoadedTimestamp = payload.oldestLoadedTimestamp
  window.oldestLoadedSessionId = payload.oldestLoadedSessionId
  window.hasMore = payload.hasMore
  window.searchCursor = payload.searchCursor
  window.error = undefined
  window.deepSearchPending = payload.deepSearchPending ?? false
  window.partial = payload.partial
  window.partialReason = payload.partialReason
  window.integrityError = payload.integrityError
}

function syncWindowProjectsFromTopLevel(window: SessionWindowState, state: SessionsState) {
  window.projects = state.projects
  window.lastLoadedAt = state.lastLoadedAt
  window.totalSessions = state.totalSessions
  window.oldestLoadedTimestamp = state.oldestLoadedTimestamp
  window.oldestLoadedSessionId = state.oldestLoadedSessionId
  window.hasMore = state.hasMore
}

function syncActiveWindowFromTopLevel(state: SessionsState) {
  if (!state.activeSurface) return
  const window = ensureWindow(state, state.activeSurface)
  syncWindowProjectsFromTopLevel(window, state)
  window.loading = state.loadingMore
  window.loadingKind = state.loadingKind
}

function syncAllWindowsFromTopLevel(state: SessionsState) {
  if (!state.windows) return
  for (const [surface, window] of Object.entries(state.windows)) {
    if (!window) continue
    // Skip windows with active search queries — their results are query-specific
    if (window.appliedQuery) continue
    syncWindowProjectsFromTopLevel(window, state)
    // Only sync loading state to the active surface
    if (surface === state.activeSurface) {
      window.loading = state.loadingMore
      window.loadingKind = state.loadingKind
    }
  }
}

function patchProjectRunningState(
  projects: ProjectGroup[],
  payload: {
    upsert: TerminalMetaRecord[]
    remove: string[]
  },
) {
  const clearedTerminalIds = new Set(payload.remove)
  for (const record of payload.upsert) {
    if (!record.provider || !record.sessionId) {
      clearedTerminalIds.add(record.terminalId)
    }
  }

  const runningBySessionKey = new Map<string, string>()
  for (const record of payload.upsert) {
    if (!record.provider || !record.sessionId) continue
    runningBySessionKey.set(`${record.provider}:${record.sessionId}`, record.terminalId)
  }

  // Identity moves (server-side rebind): an upsert saying terminal T now
  // belongs to session key X implies every OTHER row's stale claim on T is
  // over. terminalId → its current session key per this payload.
  const currentKeyByTerminalId = new Map<string, string>()
  for (const record of payload.upsert) {
    if (record.provider && record.sessionId) {
      currentKeyByTerminalId.set(record.terminalId, `${record.provider}:${record.sessionId}`)
    }
  }

  for (const project of projects) {
    for (const session of project.sessions) {
      const sessionRecord = session as typeof session & {
        isRunning?: boolean
        runningTerminalId?: string
      }
      if (sessionRecord.runningTerminalId) {
        const rowKey = `${session.provider || 'claude'}:${session.sessionId}`
        const movedToKey = currentKeyByTerminalId.get(sessionRecord.runningTerminalId)
        if (
          clearedTerminalIds.has(sessionRecord.runningTerminalId)
          || (movedToKey !== undefined && movedToKey !== rowKey)
        ) {
          sessionRecord.isRunning = false
          sessionRecord.runningTerminalId = undefined
        }
      }

      const runningTerminalId = runningBySessionKey.get(`${session.provider || 'claude'}:${session.sessionId}`)
      if (runningTerminalId) {
        sessionRecord.isRunning = true
        sessionRecord.runningTerminalId = runningTerminalId
      }
    }
  }
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
    commitSessionWindowReplacement: (
      state,
      action: PayloadAction<SessionWindowCommitPayload>,
    ) => {
      const window = ensureWindow(state, action.payload.surface)
      commitWindowPayload(window, action.payload)
      window.loading = false
      window.loadingKind = undefined
      if (action.payload.query !== undefined) {
        window.query = action.payload.query
        window.appliedQuery = action.payload.query
      }
      if (action.payload.searchTier !== undefined) {
        window.searchTier = action.payload.searchTier
        window.appliedSearchTier = action.payload.searchTier
      }
      if (!state.activeSurface || state.activeSurface === action.payload.surface) {
        syncTopLevelFromWindow(state, action.payload.surface)
      }
    },
    commitSessionWindowVisibleRefresh: (
      state,
      action: PayloadAction<SessionWindowCommitPayload & { preserveLoading?: boolean }>,
    ) => {
      const window = ensureWindow(state, action.payload.surface)
      commitWindowPayload(window, action.payload)
      if (!action.payload.preserveLoading) {
        window.loading = false
        window.loadingKind = undefined
      }
      if (action.payload.query !== undefined) {
        window.appliedQuery = action.payload.query
      }
      if (action.payload.searchTier !== undefined) {
        window.appliedSearchTier = action.payload.searchTier
      }
      if (!state.activeSurface || state.activeSurface === action.payload.surface) {
        syncTopLevelFromWindow(state, action.payload.surface)
      }
      // A successful HTTP fetch establishes a valid baseline for WS patches.
      if (!state.wsSnapshotReceived) {
        state.wsSnapshotReceived = true
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
      syncAllWindowsFromTopLevel(state)
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
      const staleProjects = removeSessionKeys(
        normalizeProjects(state.projects),
        collectSessionKeys(incoming),
      )
      // Merge incoming projects with existing ones by projectPath
      const projectMap = new Map(staleProjects.map((p) => [p.projectPath, p]))
      for (const project of incoming) {
        projectMap.set(project.projectPath, project)
      }
      state.projects = normalizeProjects(Array.from(projectMap.values()))
      state.lastLoadedAt = Date.now()
      const valid = new Set(state.projects.map((p) => p.projectPath))
      state.expandedProjects = new Set(Array.from(state.expandedProjects).filter((k) => valid.has(k)))
      syncAllWindowsFromTopLevel(state)
    },
    applySessionsPatch: (
      state,
      action: PayloadAction<{ upsertProjects: ProjectGroup[]; removeProjectPaths: string[] }>
    ) => {
      if (!state.wsSnapshotReceived) return
      const remove = new Set(action.payload.removeProjectPaths || [])
      const incoming = normalizeProjects(action.payload.upsertProjects)
      const staleProjects = removeSessionKeys(
        normalizeProjects(state.projects),
        collectSessionKeys(incoming),
      )
      const projectMap = new Map(staleProjects.map((p) => [p.projectPath, p]))

      for (const key of remove) projectMap.delete(key)
      for (const project of incoming) projectMap.set(project.projectPath, project)

      state.projects = sortProjectsByRecency(normalizeProjects(Array.from(projectMap.values())))
      state.lastLoadedAt = Date.now()

      const valid = new Set(state.projects.map((p) => p.projectPath))
      state.expandedProjects = new Set(Array.from(state.expandedProjects).filter((k) => valid.has(k)))
      syncAllWindowsFromTopLevel(state)
    },
    patchSessionRunningStateFromTerminalMeta: (
      state,
      action: PayloadAction<{
        upsert: TerminalMetaRecord[]
        remove: string[]
      }>,
    ) => {
      patchProjectRunningState(state.projects, action.payload)
      if (!state.windows) return
      for (const window of Object.values(state.windows)) {
        if (!window) continue
        patchProjectRunningState(window.projects, action.payload)
      }
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
      const existingProjects = normalizeProjects(state.projects)
      const incoming = normalizeProjects(action.payload)
      // Build a set of existing session keys for deduplication
      const existingKeys = new Set<string>()
      for (const project of existingProjects) {
        for (const session of project.sessions) {
          existingKeys.add(sessionKey(session))
        }
      }
      // Merge incoming sessions into existing projects, deduplicating
      const projectMap = new Map(existingProjects.map((p) => [p.projectPath, { ...p, sessions: [...p.sessions] }]))
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
      state.projects = sortProjectsByRecency(normalizeProjects(Array.from(projectMap.values())))
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
    removeSessionFromProjects: (state, action: PayloadAction<{ provider?: string; sessionId: string }>) => {
      const key = sessionKey(action.payload)
      const removeFrom = (projects: ProjectGroup[]) =>
        projects
          .map((project) => ({
            ...project,
            sessions: (project.sessions || []).filter((s) => sessionKey(s) !== key),
          }))
          .filter((project) => project.sessions.length > 0)
      state.projects = removeFrom(state.projects || [])
      if (state.windows) {
        for (const window of Object.values(state.windows)) {
          if (!window) continue
          window.projects = removeFrom(window.projects || [])
        }
      }
    },
    /**
     * STATUS-STRIP: upsert usage into the unified map. `paneKeys` bounds the
     * map to the pane-relevant keys currently requested — retention stays at
     * most one entry per open fresh-agent pane. `sourceSeq`/`serverInstance` are the
     * session-directory revision of the response the entries came from; a
     * newer entry is never overwritten by an older one (cross-surface
     * completion inversion can't regress an entry).
     */
    applyContextUsageExtras: (
      state,
      action: PayloadAction<{
        entries: SessionDirectoryContextUsageExtra[]
        sourceSeq: number
        serverInstance?: string
        bootId?: string
        paneKeys: string[]
      }>,
    ) => {
      const { entries, sourceSeq, serverInstance, bootId, paneKeys } = action.payload
      const keep = new Set(paneKeys)
      const next: SessionsState['contextUsageByKey'] = {}
      for (const key of Object.keys(state.contextUsageByKey ?? {})) {
        if (keep.has(key)) next[key] = state.contextUsageByKey[key]
      }
      state.contextUsageByKey = next
      for (const extra of entries) {
        const key = `${extra.provider}:${extra.sessionId}`
        if (!keep.has(key)) continue
        const existing = state.contextUsageByKey[key]
        // Ordering namespace: (serverInstance, bootId). Higher seq wins within
        // one namespace; lower seq dropped; equal → last write. A changed
        // namespace (restart or instance migration) replaces unconditionally —
        // the clock-seeded counter may not be monotonic across processes.
        if (
          existing
          && existing.serverInstance === serverInstance
          && existing.bootId === bootId
          && existing.sourceSeq > sourceSeq
        ) continue
        if (!extra.tokenUsage) {
          // Explicit server signal: this response reached the session but
          // carries no usage — reporting stopped. Evict rather than let the
          // last percentage ride forever (no client-side time expiry by design).
          delete state.contextUsageByKey[key]
          continue
        }
        state.contextUsageByKey[key] = {
          tokenUsage: extra.tokenUsage as TokenSummary,
          sourceSeq,
          ...(serverInstance !== undefined ? { serverInstance } : {}),
          ...(bootId !== undefined ? { bootId } : {}),
          fetchedAt: Date.now(),
        }
      }
    },
  },
})

export const {
  setActiveSessionSurface,
  setSessionWindowLoading,
  applyContextUsageExtras,
  setSessionWindowError,
  commitSessionWindowReplacement,
  commitSessionWindowVisibleRefresh,
  markWsSnapshotReceived,
  resetWsSnapshotReceived,
  setProjects,
  clearProjects,
  mergeProjects,
  applySessionsPatch,
  patchSessionRunningStateFromTerminalMeta,
  clearPaginationMeta,
  setPaginationMeta,
  appendSessionsPage,
  setLoadingMore,
  toggleProjectExpanded,
  setProjectExpanded,
  removeSessionFromProjects,
} =
  sessionsSlice.actions

export default sessionsSlice.reducer
