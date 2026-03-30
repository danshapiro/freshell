import {
  fetchSidebarSessionsSnapshot,
  searchSessions,
  type SearchOptions,
  type SearchResult,
} from '@/lib/api'
import type { AppDispatch, RootState } from './store'
import type { ProjectGroup } from './types'
import {
  commitSessionWindowReplacement,
  commitSessionWindowVisibleRefresh,
  setActiveSessionSurface,
  setSessionWindowError,
  setSessionWindowLoading,
  type SessionWindowLoadingKind,
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
const inFlightRequests = new Map<SessionSurface, Promise<void>>()
const invalidationRefreshState = new Map<SessionSurface, {
  inFlight: Promise<void> | null
  queued: boolean
}>()
let sessionWindowThunkGeneration = 0

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
  sessionWindowThunkGeneration += 1
  for (const controller of controllers.values()) {
    controller.abort()
  }
  controllers.clear()
  inFlightRequests.clear()
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
      ...(result.checkoutPath ? { checkoutPath: result.checkoutPath } : {}),
      lastActivityAt: result.lastActivityAt,
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

/**
 * Merge Phase 1 (title) and Phase 2 (deep) search results.
 * Deep results overwrite title results for the same session key (provider:sessionId).
 * Title-only results that were not found by the deep search are preserved.
 */
export function mergeSearchResults(titleResults: SearchResult[], deepResults: SearchResult[]): SearchResult[] {
  const merged = new Map<string, SearchResult>()

  for (const result of titleResults) {
    const key = sessionKey(result)
    merged.set(key, result)
  }

  for (const result of deepResults) {
    const key = sessionKey(result)
    merged.set(key, result) // Deep results overwrite title results
  }

  return Array.from(merged.values())
}

type SessionWindowSearchContext = {
  query: string
  searchTier: SearchOptions['tier']
}

type VisibleResultIdentity = SessionWindowSearchContext & {
  resultVersion: number
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

function getLoadingKind(args: {
  priority: 'visible' | 'background'
  append: boolean
  trimmedQuery: string
  previousQuery: string
  previousTier: SearchOptions['tier']
  nextTier: SearchOptions['tier']
  hasCommittedWindow: boolean
  hasCommittedItems: boolean
}): SessionWindowLoadingKind {
  if (args.append) return 'pagination'
  if (!args.hasCommittedWindow && !args.hasCommittedItems) return 'initial'
  if (args.priority === 'background') return 'background'

  const queryChanged = args.trimmedQuery !== args.previousQuery
  const tierChanged = args.nextTier !== args.previousTier
  if (queryChanged || tierChanged) {
    return 'search'
  }

  return 'background'
}

function normalizeWindowSearchContext(context?: {
  query?: string
  searchTier?: SearchOptions['tier']
}): SessionWindowSearchContext {
  return {
    query: context?.query?.trim() ?? '',
    searchTier: context?.searchTier ?? 'title',
  }
}

function getRequestedWindowSearchContext(windowState?: {
  query?: string
  searchTier?: SearchOptions['tier']
}) {
  return normalizeWindowSearchContext({
    query: windowState?.query,
    searchTier: windowState?.searchTier,
  })
}

function getVisibleWindowSearchContext(windowState?: {
  query?: string
  searchTier?: SearchOptions['tier']
  appliedQuery?: string
  appliedSearchTier?: SearchOptions['tier']
}) {
  const hasAppliedContext = windowState?.appliedQuery !== undefined
    || windowState?.appliedSearchTier !== undefined

  if (hasAppliedContext) {
    return normalizeWindowSearchContext({
      query: windowState?.appliedQuery ?? '',
      searchTier: windowState?.appliedSearchTier ?? windowState?.searchTier ?? 'title',
    })
  }

  return getRequestedWindowSearchContext(windowState)
}

function getVisibleResultIdentity(windowState?: {
  query?: string
  searchTier?: SearchOptions['tier']
  appliedQuery?: string
  appliedSearchTier?: SearchOptions['tier']
  resultVersion?: number
}): VisibleResultIdentity {
  const visibleContext = getVisibleWindowSearchContext(windowState)
  return {
    ...visibleContext,
    resultVersion: windowState?.resultVersion ?? 0,
  }
}

function searchContextsEqual(
  left: SessionWindowSearchContext,
  right: SessionWindowSearchContext,
) {
  return left.query === right.query && left.searchTier === right.searchTier
}

function visibleResultIdentitiesEqual(
  left: VisibleResultIdentity,
  right: VisibleResultIdentity,
) {
  return searchContextsEqual(left, right) && left.resultVersion === right.resultVersion
}

function hasCommittedWindowData(windowState?: {
  lastLoadedAt?: number
}) {
  return typeof windowState?.lastLoadedAt === 'number'
}

export function activateSessionSurface(surface: SessionSurface) {
  return (dispatch: AppDispatch) => {
    dispatch(setActiveSessionSurface(surface))
  }
}

function buildSearchPayload(
  surface: SessionSurface,
  results: SearchResult[],
  query: string,
  searchTier: SearchOptions['tier'],
  deepSearchPending: boolean,
  opts?: { partial?: boolean; partialReason?: 'budget' | 'io_error' },
) {
  const last = results.at(-1)
  return {
    surface,
    projects: searchResultsToProjects(results),
    totalSessions: results.length,
    oldestLoadedTimestamp: last?.lastActivityAt ?? 0,
    oldestLoadedSessionId: last ? `${last.provider}:${last.sessionId}` : '',
    hasMore: false,
    query,
    searchTier,
    deepSearchPending,
    partial: opts?.partial,
    partialReason: opts?.partialReason,
  }
}

function getSidebarVisibilityOptions(state: RootState) {
  const sidebarSettings = state.settings?.settings?.sidebar
  return {
    includeSubagents: sidebarSettings?.showSubagents || undefined,
    includeNonInteractive: sidebarSettings?.showNoninteractiveSessions || undefined,
    includeEmpty: sidebarSettings?.hideEmptySessions === false || undefined,
  }
}

function canCommitVisibleRefresh(args: {
  generation: number
  getState: () => RootState
  surface: SessionSurface
  identity: VisibleResultIdentity
}) {
  if (args.generation !== sessionWindowThunkGeneration) return false
  const windowState = args.getState().sessions.windows?.[args.surface]
  return visibleResultIdentitiesEqual(getVisibleResultIdentity(windowState), args.identity)
}

async function refreshVisibleSessionWindowSilently(args: {
  dispatch: AppDispatch
  getState: () => RootState
  surface: SessionSurface
  generation: number
  identity: VisibleResultIdentity
  preserveLoadingState: boolean
}) {
  const {
    dispatch,
    getState,
    surface,
    generation,
    preserveLoadingState,
  } = args
  let identity = args.identity
  const visibilityOpts = getSidebarVisibilityOptions(getState())
  const controller = new AbortController()
  const canCommit = () => canCommitVisibleRefresh({
    generation,
    getState,
    surface,
    identity,
  })
  const commitData = (payload: ReturnType<typeof buildSearchPayload> | {
    surface: SessionSurface
    projects: ProjectGroup[]
    totalSessions?: number
    oldestLoadedTimestamp?: number
    oldestLoadedSessionId?: string
    hasMore?: boolean
    query?: string
    searchTier?: SearchOptions['tier']
  }) => {
    if (!canCommit()) return false
    dispatch(commitSessionWindowVisibleRefresh({
      ...payload,
      preserveLoading: preserveLoadingState,
    }))
    identity = getVisibleResultIdentity(getState().sessions.windows?.[surface])
    return true
  }

  if (!preserveLoadingState) {
    dispatch(setSessionWindowLoading({
      surface,
      loading: true,
      loadingKind: 'background',
    }))
  }

  try {
    if (identity.query) {
      if (identity.searchTier !== 'title') {
        const titleResponse = await searchSessions({
          query: identity.query,
          tier: 'title',
          signal: controller.signal,
          ...visibilityOpts,
        })
        if (!commitData(buildSearchPayload(surface, titleResponse.results, identity.query, identity.searchTier, true))) {
          return
        }

        try {
          const deepResponse = await searchSessions({
            query: identity.query,
            tier: identity.searchTier,
            signal: controller.signal,
            ...visibilityOpts,
          })
          const merged = mergeSearchResults(titleResponse.results, deepResponse.results)
          commitData(buildSearchPayload(surface, merged, identity.query, identity.searchTier, false, {
            partial: deepResponse.partial,
            partialReason: deepResponse.partialReason,
          }))
        } catch {
          commitData(buildSearchPayload(surface, titleResponse.results, identity.query, identity.searchTier, false))
        }
        return
      }

      const response = await searchSessions({
        query: identity.query,
        tier: identity.searchTier,
        signal: controller.signal,
        ...visibilityOpts,
      })
      commitData(buildSearchPayload(surface, response.results, identity.query, identity.searchTier, false, {
        partial: response.partial,
        partialReason: response.partialReason,
      }))
      return
    }

    const response = await fetchSidebarSessionsSnapshot({
      limit: 50,
      signal: controller.signal,
      ...visibilityOpts,
    })
    const nextProjects = Array.isArray(response) ? response : (response?.projects ?? [])
    commitData({
      surface,
      projects: nextProjects,
      totalSessions: response?.totalSessions,
      oldestLoadedTimestamp: response?.oldestIncludedTimestamp,
      oldestLoadedSessionId: response?.oldestIncludedSessionId,
      hasMore: response?.hasMore,
      query: identity.query,
      searchTier: identity.searchTier,
    })
  } catch {
    if (!preserveLoadingState && canCommit()) {
      dispatch(setSessionWindowLoading({
        surface,
        loading: false,
      }))
    }
  }
}

export function fetchSessionWindow(args: FetchSessionWindowArgs) {
  return async (dispatch: AppDispatch, getState: () => RootState) => {
    const { surface, query = '', searchTier = 'title', append = false } = args
    const trimmedQuery = query.trim()
    const state = getState()
    const windowState = state.sessions.windows?.[surface]
    const visibilityOpts = getSidebarVisibilityOptions(state)
    const previousQuery = (windowState?.query ?? '').trim()
    const previousTier = windowState?.searchTier ?? 'title'
    const hasCommittedWindow = hasCommittedWindowData(windowState)
    const hasCommittedItems = (windowState?.projects ?? []).some((project) => (project.sessions?.length ?? 0) > 0)
    const previousVisibleQuery = windowState?.appliedQuery?.trim()
      ?? (hasCommittedWindow ? previousQuery : '')
    const previousVisibleTier = windowState?.appliedSearchTier
      ?? (hasCommittedWindow ? previousTier : 'title')
    const loadingKind = getLoadingKind({
      priority: args.priority,
      append,
      trimmedQuery,
      previousQuery: previousVisibleQuery,
      previousTier: previousVisibleTier,
      nextTier: searchTier,
      hasCommittedWindow,
      hasCommittedItems,
    })

    abortSurface(surface)
    const controller = new AbortController()
    controllers.set(surface, controller)

    let requestPromise!: Promise<void>
    requestPromise = (async () => {
      dispatch(setSessionWindowLoading({
        surface,
        loading: true,
        loadingKind,
        query: trimmedQuery,
        searchTier,
      }))
      dispatch(setSessionWindowError({ surface, error: undefined }))

      try {
        if (trimmedQuery) {
          if (searchTier !== 'title') {
            // Two-phase search: Phase 1 (title) then Phase 2 (deep)
            const titleResponse = await searchSessions({
              query: trimmedQuery,
              tier: 'title',
              signal: controller.signal,
              ...visibilityOpts,
            })
            if (controller.signal.aborted) return

            dispatch(commitSessionWindowReplacement(buildSearchPayload(surface, titleResponse.results, trimmedQuery, searchTier, true)))

            // Phase 2: file-based search
            try {
              const deepResponse = await searchSessions({
                query: trimmedQuery,
                tier: searchTier,
                signal: controller.signal,
                ...visibilityOpts,
              })
              if (controller.signal.aborted) return

              const merged = mergeSearchResults(titleResponse.results, deepResponse.results)
              dispatch(commitSessionWindowReplacement(buildSearchPayload(surface, merged, trimmedQuery, searchTier, false, {
                partial: deepResponse.partial,
                partialReason: deepResponse.partialReason,
              })))
            } catch (phase2Error) {
              if (controller.signal.aborted) return
              // Phase 2 failed but Phase 1 data is already displayed.
              // Clear the pending indicator and report the error.
              dispatch(commitSessionWindowReplacement(buildSearchPayload(surface, titleResponse.results, trimmedQuery, searchTier, false)))
              dispatch(setSessionWindowError({
                surface,
                error: phase2Error instanceof Error ? phase2Error.message : 'Deep search failed',
              }))
            }
          } else {
            // Single-phase title search
            const response = await searchSessions({
              query: trimmedQuery,
              tier: searchTier,
              signal: controller.signal,
              ...visibilityOpts,
            })
            if (controller.signal.aborted) return

            dispatch(commitSessionWindowReplacement(buildSearchPayload(surface, response.results, trimmedQuery, searchTier, false, {
              partial: response.partial,
              partialReason: response.partialReason,
            })))
          }
          return
        }

        const response = await fetchSidebarSessionsSnapshot({
          limit: 50,
          ...(append ? {
            before: windowState?.oldestLoadedTimestamp,
            beforeId: windowState?.oldestLoadedSessionId,
          } : {}),
          signal: controller.signal,
          ...visibilityOpts,
        })
        if (controller.signal.aborted) return

        const nextProjects = Array.isArray(response) ? response : (response?.projects ?? [])
        const projects = append
          ? mergeProjects(windowState?.projects ?? [], nextProjects)
          : nextProjects

        dispatch(commitSessionWindowReplacement({
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
        if (inFlightRequests.get(surface) === requestPromise) {
          inFlightRequests.delete(surface)
        }
      }
    })()

    inFlightRequests.set(surface, requestPromise)
    return requestPromise
  }
}

export function refreshActiveSessionWindow() {
  return async (dispatch: AppDispatch, getState: () => RootState) => {
    const active = getState().sessions.activeSurface as SessionSurface | undefined
    const surface: SessionSurface = active ?? 'sidebar'
    const windowState = getState().sessions.windows[surface]
    if (!hasCommittedWindowData(windowState)) {
      const requestedSearchContext = getRequestedWindowSearchContext(windowState)
      await dispatch(fetchSessionWindow({
        surface,
        priority: 'background',
        query: requestedSearchContext.query,
        searchTier: requestedSearchContext.searchTier,
      }) as any)
      return
    }

    await refreshVisibleSessionWindowSilently({
      dispatch,
      getState,
      surface,
      generation: sessionWindowThunkGeneration,
      identity: getVisibleResultIdentity(windowState),
      preserveLoadingState: inFlightRequests.get(surface) !== null && inFlightRequests.get(surface) !== undefined,
    })
  }
}

export function queueActiveSessionWindowRefresh() {
  return async (dispatch: AppDispatch, getState: () => RootState) => {
    const activeSurface = getState().sessions.activeSurface
    // Default to 'sidebar' if activeSurface hasn't been initialized yet —
    // sessions.changed can arrive before bootstrap sets the active surface.
    const surface: SessionSurface = isSessionSurface(activeSurface) ? activeSurface : 'sidebar'

    const existing = invalidationRefreshState.get(surface)
    if (existing?.inFlight) {
      existing.queued = true
      return existing.inFlight
    }

    const generation = sessionWindowThunkGeneration
    const state = {
      inFlight: null as Promise<void> | null,
      queued: true,
    }
    invalidationRefreshState.set(surface, state)

    const run = (async () => {
      try {
        while (generation === sessionWindowThunkGeneration) {
          const activeRequest = inFlightRequests.get(surface) ?? null
          const windowState = getState().sessions.windows[surface]
          const hasCommittedWindow = hasCommittedWindowData(windowState)

          if (!hasCommittedWindow) {
            if (activeRequest) {
              try {
                await activeRequest
              } catch {
                // A queued invalidation should still retry after an aborted/failed direct fetch.
              }
              continue
            }
            if (!state.queued) break
            state.queued = false
            const requestedSearchContext = getRequestedWindowSearchContext(windowState)
            await dispatch(fetchSessionWindow({
              surface,
              priority: 'background',
              query: requestedSearchContext.query,
              searchTier: requestedSearchContext.searchTier,
            }) as any)
            continue
          }

          const requestedSearchContext = getRequestedWindowSearchContext(windowState)
          const visibleSearchContext = getVisibleWindowSearchContext(windowState)
          const hasRequestedAppliedDrift = !searchContextsEqual(
            requestedSearchContext,
            visibleSearchContext,
          )
          if (hasRequestedAppliedDrift) {
            if (!state.queued) break
            state.queued = false
            await refreshVisibleSessionWindowSilently({
              dispatch,
              getState,
              surface,
              generation,
              identity: getVisibleResultIdentity(windowState),
              preserveLoadingState: activeRequest !== null,
            })
            continue
          }
          if (activeRequest) {
            try {
              await activeRequest
            } catch {
              // A queued invalidation should still retry after an aborted/failed direct fetch.
            }
            continue
          }
          if (!state.queued) break
          state.queued = false
          await refreshVisibleSessionWindowSilently({
            dispatch,
            getState,
            surface,
            generation,
            identity: getVisibleResultIdentity(windowState),
            preserveLoadingState: false,
          })
        }
      } finally {
        if (invalidationRefreshState.get(surface) === state) {
          invalidationRefreshState.delete(surface)
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
