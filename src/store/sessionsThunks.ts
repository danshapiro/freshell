import {
  fetchSidebarSessionsSnapshot,
  searchSessions,
  type SearchOptions,
} from '@/lib/api'
import type { AppDispatch, RootState } from './store'
import type { ProjectGroup } from './types'
import {
  setActiveSessionSurface,
  setSessionWindowData,
  setSessionWindowError,
  setSessionWindowLoading,
} from './sessionsSlice'

export type SessionSurface = 'sidebar' | 'history' | 'bootstrap'

type FetchSessionWindowArgs = {
  surface: SessionSurface
  priority: 'visible' | 'background'
  query?: string
  searchTier?: SearchOptions['tier']
  append?: boolean
}

const controllers = new Map<string, AbortController>()
const invalidationRefreshState = new Map<SessionSurface, {
  inFlight: Promise<void> | null
  queued: boolean
}>()

function isSessionSurface(value: unknown): value is SessionSurface {
  return value === 'sidebar' || value === 'history' || value === 'bootstrap'
}

function abortSurface(surface: string) {
  const controller = controllers.get(surface)
  if (controller) {
    controller.abort()
    controllers.delete(surface)
  }
}

export function _resetSessionWindowThunkState(): void {
  for (const controller of controllers.values()) {
    controller.abort()
  }
  controllers.clear()
  invalidationRefreshState.clear()
}

function searchResultsToProjects(results: Awaited<ReturnType<typeof searchSessions>>['results']): ProjectGroup[] {
  const grouped = new Map<string, ProjectGroup>()

  for (const result of results) {
    const existing = grouped.get(result.projectPath) ?? {
      projectPath: result.projectPath,
      sessions: [],
    }

    existing.sessions.push({
      provider: result.provider,
      sessionId: result.sessionId,
      projectPath: result.projectPath,
      updatedAt: result.updatedAt,
      createdAt: result.createdAt,
      archived: result.archived,
      cwd: result.cwd,
      title: result.title,
      summary: result.summary,
      sessionType: result.sessionType,
      firstUserMessage: result.firstUserMessage,
      isSubagent: result.isSubagent,
      isNonInteractive: result.isNonInteractive,
    })

    grouped.set(result.projectPath, existing)
  }

  return Array.from(grouped.values())
}

function sessionKey(session: { provider?: string; sessionId: string }) {
  return `${session.provider || 'claude'}:${session.sessionId}`
}

function mergeProjects(existing: ProjectGroup[], incoming: ProjectGroup[]): ProjectGroup[] {
  const projectMap = new Map<string, ProjectGroup>()
  const seenKeys = new Map<string, Set<string>>()

  for (const project of existing) {
    projectMap.set(project.projectPath, {
      ...project,
      sessions: [...project.sessions],
    })
    seenKeys.set(project.projectPath, new Set(project.sessions.map(sessionKey)))
  }

  for (const project of incoming) {
    const current = projectMap.get(project.projectPath)
    if (!current) {
      projectMap.set(project.projectPath, {
        ...project,
        sessions: [...project.sessions],
      })
      seenKeys.set(project.projectPath, new Set(project.sessions.map(sessionKey)))
      continue
    }

    const keys = seenKeys.get(project.projectPath) ?? new Set<string>()
    for (const session of project.sessions) {
      const key = sessionKey(session)
      if (keys.has(key)) continue
      keys.add(key)
      current.sessions.push(session)
    }
    if (project.color && !current.color) {
      current.color = project.color
    }
    seenKeys.set(project.projectPath, keys)
  }

  return Array.from(projectMap.values())
}

export function activateSessionSurface(surface: SessionSurface) {
  return (dispatch: AppDispatch) => {
    dispatch(setActiveSessionSurface(surface))
  }
}

export function fetchSessionWindow(args: FetchSessionWindowArgs) {
  return async (dispatch: AppDispatch, getState: () => RootState) => {
    const { surface, query = '', searchTier = 'title', append = false } = args
    const trimmedQuery = query.trim()
    const windowState = getState().sessions.windows?.[surface]

    abortSurface(surface)
    const controller = new AbortController()
    controllers.set(surface, controller)

    dispatch(setSessionWindowLoading({
      surface,
      loading: true,
      query: trimmedQuery,
      searchTier,
    }))
    dispatch(setSessionWindowError({ surface, error: undefined }))

    try {
      if (trimmedQuery) {
        const response = await searchSessions({
          query: trimmedQuery,
          tier: searchTier,
          signal: controller.signal,
        })
        if (controller.signal.aborted) return

        dispatch(setSessionWindowData({
          surface,
          projects: searchResultsToProjects(response.results),
          totalSessions: response.results.length,
          oldestLoadedTimestamp: response.results.at(-1)?.updatedAt ?? 0,
          oldestLoadedSessionId: response.results.at(-1)
            ? `${response.results.at(-1)!.provider}:${response.results.at(-1)!.sessionId}`
            : '',
          hasMore: false,
          query: trimmedQuery,
          searchTier,
        }))
        return
      }

      const response = await fetchSidebarSessionsSnapshot({
        limit: 50,
        ...(append ? {
          before: windowState?.oldestLoadedTimestamp,
          beforeId: windowState?.oldestLoadedSessionId,
        } : {}),
        signal: controller.signal,
      })
      if (controller.signal.aborted) return

      const nextProjects = Array.isArray(response) ? response : (response?.projects ?? [])
      const projects = append
        ? mergeProjects(windowState?.projects ?? [], nextProjects)
        : nextProjects

      dispatch(setSessionWindowData({
        surface,
        projects,
        totalSessions: response?.totalSessions,
        oldestLoadedTimestamp: response?.oldestIncludedTimestamp,
        oldestLoadedSessionId: response?.oldestIncludedSessionId,
        hasMore: response?.hasMore,
        query: trimmedQuery,
        searchTier,
      }))
    } catch (error) {
      if (controller.signal.aborted) return
      dispatch(setSessionWindowError({
        surface,
        error: error instanceof Error ? error.message : 'Failed to load session window',
      }))
      dispatch(setSessionWindowLoading({
        surface,
        loading: false,
        query: trimmedQuery,
        searchTier,
      }))
      throw error
    } finally {
      if (controllers.get(surface) === controller) {
        controllers.delete(surface)
      }
    }
  }
}

export function refreshActiveSessionWindow() {
  return async (dispatch: AppDispatch, getState: () => RootState) => {
    const surface = getState().sessions.activeSurface as SessionSurface | undefined
    if (!surface) return
    const windowState = getState().sessions.windows[surface]
    await dispatch(fetchSessionWindow({
      surface,
      priority: 'visible',
      query: windowState?.query,
      searchTier: windowState?.searchTier,
    }) as any)
  }
}

export function queueActiveSessionWindowRefresh() {
  return async (dispatch: AppDispatch, getState: () => RootState) => {
    const activeSurface = getState().sessions.activeSurface
    if (!isSessionSurface(activeSurface)) return

    const existing = invalidationRefreshState.get(activeSurface)
    if (existing?.inFlight) {
      existing.queued = true
      return existing.inFlight
    }

    const state = {
      inFlight: null as Promise<void> | null,
      queued: false,
    }
    invalidationRefreshState.set(activeSurface, state)

    const run = (async () => {
      try {
        do {
          state.queued = false
          const windowState = getState().sessions.windows[activeSurface]
          await dispatch(fetchSessionWindow({
            surface: activeSurface,
            priority: 'visible',
            query: windowState?.query,
            searchTier: windowState?.searchTier,
          }) as any)
        } while (state.queued)
      } finally {
        if (invalidationRefreshState.get(activeSurface) === state) {
          invalidationRefreshState.delete(activeSurface)
        }
      }
    })()

    state.inFlight = run
    return run
  }
}

export function loadInitialSessionsWindow() {
  return async (dispatch: AppDispatch) => {
    dispatch(activateSessionSurface('sidebar'))
    await dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)
  }
}

export function loadHistorySessionsWindow() {
  return async (dispatch: AppDispatch) => {
    dispatch(activateSessionSurface('history'))
    await dispatch(fetchSessionWindow({
      surface: 'history',
      priority: 'visible',
    }) as any)
  }
}
