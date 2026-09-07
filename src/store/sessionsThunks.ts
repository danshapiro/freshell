import {
  fetchSidebarSessionsSnapshot,
  isApiUnauthorizedError,
  searchSessions,
  type SearchOptions,
  type SearchResult,
  type SearchResponse,
} from '@/lib/api'
import { collectFreshAgentContextUsageKeys } from '@/lib/fresh-agent-context-usage'
import { createLogger } from '@/lib/client-logger'
import type { AppDispatch, RootState } from './store'
import type { ProjectGroup } from './types'
import type { SessionDirectoryContextUsageExtra, SessionDirectoryIntegrityError } from '@shared/read-models'
import type { TokenSummary } from '@shared/ws-protocol'

const log = createLogger('SessionsThunks')
import {
  commitSessionWindowReplacement,
  commitSessionWindowVisibleRefresh,
  applyContextUsageExtras,
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

export type FetchSessionWindowResult = {
  /** True when the window load committed (or the fetch was aborted/superseded); false on a real API failure. */
  ok: boolean
  /** True only when the failure was an authentication (HTTP 401) error. */
  unauthorized: boolean
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

function searchResultsToProjects(
  results: Awaited<ReturnType<typeof searchSessions>>['results'],
  projectColors?: Record<string, string>,
): ProjectGroup[] {
  const grouped = new Map<string, ProjectGroup>()

  for (const result of results) {
    const existing = grouped.get(result.projectPath) ?? {
      projectPath: result.projectPath,
      // SESSION-05: overlay the page's color map so search windows render
      // the same project colors as the plain session list.
      ...(projectColors?.[result.projectPath] ? { color: projectColors[result.projectPath] } : {}),
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
      isRunning: result.isRunning,
      runningTerminalId: result.runningTerminalId,
      liveTerminalOnly: result.liveTerminalOnly,
      // STATUS-STRIP: search-result rows carry live usage for the strip meter.
      ...(result.tokenUsage ? { tokenUsage: result.tokenUsage } : {}),
      // b5fb: search rows are an explicit allowlist — forward the reviewed
      // reset flow's provenance fields or they never reach Redux.
      ...(result.titleOverridden ? { titleOverridden: true } : {}),
      ...(result.providerTitle !== undefined ? { providerTitle: result.providerTitle } : {}),
      ...(result.titleOverrideSource ? { titleOverrideSource: result.titleOverrideSource } : {}),
    })

    grouped.set(result.projectPath, existing)
  }

  return Array.from(grouped.values())
}

function sessionKey(session: { provider?: string; sessionId: string }) {
  return `${session.provider || 'claude'}:${session.sessionId}`
}

function countSessions(projects: ProjectGroup[]): number {
  return projects.reduce((total, project) => total + (project.sessions?.length ?? 0), 0)
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

function mergeProjects(
  existing: ProjectGroup[],
  incoming: ProjectGroup[],
  opts?: {
    /**
     * Which side's `color` wins when BOTH name the same project. The rule
     * is "the later-fetched page wins" (server-authoritative) — NOT
     * "incoming wins": the append/search-pagination callers fetch page N+1
     * LATER than the stored window, so they use the default 'incoming',
     * while the deep-window silent-refresh merge passes its FRESH page-1
     * as `existing` (see the caller), so it must pass 'existing' or a
     * stale color from the stored window would resurrect over the fetch
     * (regression pinned by sessionsThunks.project-colors.test.ts).
     */
    preferColorsFrom?: 'existing' | 'incoming'
  },
): ProjectGroup[] {
  const preferIncomingColors = opts?.preferColorsFrom !== 'existing'
  const projectMap = new Map<string, ProjectGroup>()
  const seenKeys = new Set<string>()

  const addProjects = (projects: ProjectGroup[], side: 'existing' | 'incoming') => {
    for (const project of projects) {
      const sourceSessions = project.sessions ?? []
      const uniqueSessions = sourceSessions.filter((session) => {
        const key = sessionKey(session)
        if (seenKeys.has(key)) return false
        seenKeys.add(key)
        return true
      })
      const current = projectMap.get(project.projectPath)

      if (!current) {
        // Preserve groups that were genuinely empty, but do not leave behind
        // a second project whose only sessions lost a global identity clash.
        if (sourceSessions.length === 0 || uniqueSessions.length > 0) {
          projectMap.set(project.projectPath, {
            ...project,
            sessions: uniqueSessions,
          })
        }
        continue
      }

      current.sessions.push(...uniqueSessions)
      // SESSION-05: the later-fetched page is server-authoritative for
      // color. The previous additive-only adoption (`&& !current.color`)
      // silently kept a STALE color when another browser changed it — the
      // refetch after `sessions.changed` is the only recolor channel, so a
      // fresher fetched color must win. Which side that is depends on the
      // caller (see the `preferColorsFrom` option doc). (Removal is
      // unobservable: no server path deletes a project color, matching the
      // legacy no-clear-UI surface.)
      if (
        side === 'incoming'
        && project.color
        && (preferIncomingColors || !current.color)
      ) {
        current.color = project.color
      }
    }
  }

  addProjects(existing, 'existing')
  addProjects(incoming, 'incoming')

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
  opts?: {
    partial?: boolean
    partialReason?: 'budget' | 'io_error'
    integrityError?: SessionDirectoryIntegrityError
    hasMore?: boolean
    searchCursor?: string | null
    /** SESSION-05: colors from the freshest search response page. */
    projectColors?: Record<string, string>
  },
) {
  const last = results.at(-1)
  return {
    surface,
    projects: searchResultsToProjects(results, opts?.projectColors),
    totalSessions: results.length,
    oldestLoadedTimestamp: last?.lastActivityAt ?? 0,
    oldestLoadedSessionId: last ? `${last.provider}:${last.sessionId}` : '',
    hasMore: opts?.hasMore ?? false,
    searchCursor: opts?.searchCursor ?? undefined,
    query,
    searchTier,
    deepSearchPending,
    partial: opts?.partial,
    partialReason: opts?.partialReason,
    integrityError: opts?.integrityError,
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

/**
 * STATUS-STRIP: fresh-agent panes' context sessions, passed as `includeKeys`
 * on every window/search fetch so the server returns their usage out-of-band
 * (contextUsageExtras) regardless of the sidebar's search/pagination window.
 */
function getContextUsageOpts(state: RootState): { includeKeys?: string[] } {
  const includeKeys = collectFreshAgentContextUsageKeys({
    layouts: state.panes?.layouts,
    freshAgentSessions: state.freshAgent?.sessions,
  })
  return includeKeys.length > 0 ? { includeKeys } : {}
}

type UsageBearingRow = {
  provider: string
  sessionId: string
  tokenUsage?: TokenSummary
}

type UsageStampResponse = {
  snapshotSeq?: number
  serverInstance?: string
  bootId?: string
  contextUsageExtras?: SearchResponse['contextUsageExtras']
}

/**
 * STATUS-STRIP: stamp the unified usage map from ONLY this response's fresh
 * rows (never merged windows — retained row data must never be re-marked
 * fresh). Extras are server-filtered off the page, so no overlap exists
 * between the two upsert sources. The stamp is bounded to the CURRENT
 * includeKeys (`paneKeys` — dropped-pane entries are pruned) and ordered by
 * the response's per-instance monotonic page sequence (`snapshotSeq` — NEVER
 * the data-derived `revision`, which can tie or decrease) so a late older
 * response can never regress a newer entry.
 */
function commitContextUsageFromRows(
  dispatch: AppDispatch,
  getState: () => RootState,
  response: UsageStampResponse,
  rows: UsageBearingRow[],
): void {
  const entries: SessionDirectoryContextUsageExtra[] = []
  const paneKeys = getContextUsageOpts(getState()).includeKeys ?? []
  const paneKeySet = new Set(paneKeys)

  for (const row of rows) {
    const key = `${row.provider}:${row.sessionId}`
    if (row.tokenUsage) {
      entries.push({ provider: row.provider, sessionId: row.sessionId, tokenUsage: row.tokenUsage })
    } else if (paneKeySet.has(key)) {
      // A fresh page row reached the session WITHOUT usage: the provider
      // stopped reporting. Relay the absence so the reducer evicts the stale
      // entry instead of letting the last percentage ride forever.
      entries.push({ provider: row.provider, sessionId: row.sessionId })
    }
  }
  for (const extra of response.contextUsageExtras ?? []) {
    entries.push(extra)
  }
  dispatch(applyContextUsageExtras({
    entries,
    sourceSeq: response.snapshotSeq ?? 0,
    serverInstance: response.serverInstance,
    bootId: response.bootId,
    paneKeys,
  }))
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
    partial?: boolean
    partialReason?: 'budget' | 'io_error'
    integrityError?: SessionDirectoryIntegrityError
  }) => {
    if (!canCommit()) {
      log.debug('Discarded refresh result for', surface, '— identity mismatch or generation changed')
      return false
    }
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
          ...getContextUsageOpts(getState()),
        })
        if (!commitData(buildSearchPayload(surface, titleResponse.results, identity.query, identity.searchTier, true, {
          projectColors: titleResponse.projectColors,
          partial: titleResponse.partial,
          partialReason: titleResponse.partialReason,
          integrityError: titleResponse.integrityError,
        }))) {
          return
        }
        commitContextUsageFromRows(dispatch, getState, titleResponse, titleResponse.results)

        try {
          const deepResponse = await searchSessions({
            query: identity.query,
            tier: identity.searchTier,
            signal: controller.signal,
            ...visibilityOpts,
            ...getContextUsageOpts(getState()),
          })
          const merged = mergeSearchResults(titleResponse.results, deepResponse.results)
          const committed = commitData(buildSearchPayload(surface, merged, identity.query, identity.searchTier, false, {
            partial: deepResponse.partial,
            partialReason: deepResponse.partialReason,
            integrityError: deepResponse.integrityError ?? titleResponse.integrityError,
            projectColors: deepResponse.projectColors ?? titleResponse.projectColors,
          }))
          // A rejected (stale-generation / mismatched-identity) window commit
          // must not still stamp its extras as fresh — old percentage would
          // ride the 60s staleness window on top of newer data.
          if (committed) commitContextUsageFromRows(dispatch, getState, deepResponse, deepResponse.results)
        } catch {
          commitData(buildSearchPayload(surface, titleResponse.results, identity.query, identity.searchTier, false, {
            projectColors: titleResponse.projectColors,
            partial: titleResponse.partial,
            partialReason: titleResponse.partialReason,
            integrityError: titleResponse.integrityError,
          }))
        }
        return
      }

      const response = await searchSessions({
        query: identity.query,
        tier: identity.searchTier,
        signal: controller.signal,
        ...visibilityOpts,
        ...getContextUsageOpts(getState()),
      })
      const committed = commitData(buildSearchPayload(surface, response.results, identity.query, identity.searchTier, false, {
        partial: response.partial,
        partialReason: response.partialReason,
        integrityError: response.integrityError,
        projectColors: response.projectColors,
      }))
      if (committed) commitContextUsageFromRows(dispatch, getState, response, response.results)
      return
    }

    const response = await fetchSidebarSessionsSnapshot({
      limit: 50,
      signal: controller.signal,
      ...visibilityOpts,
      ...getContextUsageOpts(getState()),
    })
    const nextProjects = Array.isArray(response) ? response : (response?.projects ?? [])
    // A silent refresh must never shrink the loaded window. The sidebar may
    // have paginated past page 1 (infinite scroll / viewport backfill);
    // replacing N loaded pages with page 1 makes the visible row count
    // sawtooth every few seconds, clamps scrollTop to 0 and re-sorts under
    // the user, then forces the backfill to re-walk the same pages. When the
    // existing window is deeper than the fresh page, merge the fresh page
    // over it (fresh session objects win for overlaps; deeper sessions are
    // retained) and keep the deeper cursor + hasMore so backfill stays idle.
    const prevWindow = getState().sessions.windows?.[surface]
    const prevOldestTimestamp = prevWindow?.oldestLoadedTimestamp
    const freshOldestTimestamp = response?.oldestIncludedTimestamp
    const hasDeeperWindow =
      typeof prevOldestTimestamp === 'number' &&
      prevOldestTimestamp > 0 &&
      typeof freshOldestTimestamp === 'number' &&
      freshOldestTimestamp > 0 &&
      prevOldestTimestamp < freshOldestTimestamp
    const projects = hasDeeperWindow
      // NOTE the argument-and-color-source asymmetry: `nextProjects` (the
      // FRESH page-1 just fetched) occupies the `existing` slot so the
      // deeper previously-loaded sessions accrete onto it — but its colors
      // are the FRESHEST, so they must win the merge, unlike the default
      // append/pagination direction (`mergeProjects` doc).
      ? mergeProjects(nextProjects, prevWindow?.projects ?? [], { preferColorsFrom: 'existing' })
      : nextProjects
    const committed = commitData({
      surface,
      projects,
      totalSessions: hasDeeperWindow ? countSessions(projects) : response?.totalSessions,
      oldestLoadedTimestamp: hasDeeperWindow
        ? prevOldestTimestamp
        : response?.oldestIncludedTimestamp,
      oldestLoadedSessionId: hasDeeperWindow
        ? prevWindow?.oldestLoadedSessionId
        : response?.oldestIncludedSessionId,
      hasMore: hasDeeperWindow ? prevWindow?.hasMore : response?.hasMore,
      query: identity.query,
      searchTier: identity.searchTier,
      partial: response?.partial,
      partialReason: response?.partialReason,
      integrityError: response?.integrityError,
    })
    // Fresh-page rows ONLY (nextProjects is exactly the page the server just
    // returned) — never the merged window with its retained deeper rows.
    if (committed) commitContextUsageFromRows(dispatch, getState, response, nextProjects.flatMap((p: { sessions?: UsageBearingRow[] }) => p.sessions ?? []))
  } catch (error) {
    log.warn('Background refresh failed for', surface, error instanceof Error ? error.message : error)
    if (canCommit()) {
      if (!preserveLoadingState) {
        dispatch(setSessionWindowError({
          surface,
          error: error instanceof Error ? error.message : 'Background refresh failed',
        }))
        dispatch(setSessionWindowLoading({
          surface,
          loading: false,
        }))
      }
    }
  }
}

export function fetchSessionWindow(args: FetchSessionWindowArgs) {
  return async (dispatch: AppDispatch, getState: () => RootState): Promise<FetchSessionWindowResult> => {
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

    let settled!: Promise<void>
    settled = (async () => {
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
          if (append) {
            // Search pagination: continue the active query from the stored
            // cursor and append the next page, mirroring the plain-list append.
            const searchCursor = windowState?.searchCursor
            if (!searchCursor) {
              // No further pages to load; drop the pagination loading state
              // and keep the currently committed results untouched.
              dispatch(setSessionWindowLoading({
                surface,
                loading: false,
                query: trimmedQuery,
                searchTier,
              }))
              return
            }

            const response = await searchSessions({
              query: trimmedQuery,
              tier: searchTier,
              cursor: searchCursor,
              signal: controller.signal,
              ...visibilityOpts,
              ...getContextUsageOpts(getState()),
            })
            if (controller.signal.aborted) return

            const pagePayload = buildSearchPayload(surface, response.results, trimmedQuery, searchTier, false, {
              partial: response.partial,
              partialReason: response.partialReason,
              integrityError: response.integrityError,
              hasMore: response.hasMore,
              searchCursor: response.nextCursor,
              projectColors: response.projectColors,
            })
            const mergedProjects = mergeProjects(windowState?.projects ?? [], pagePayload.projects)
            dispatch(commitSessionWindowReplacement({
              ...pagePayload,
              projects: mergedProjects,
              totalSessions: countSessions(mergedProjects),
            }))
            commitContextUsageFromRows(dispatch, getState, response, response.results)
            return
          }

          if (searchTier !== 'title') {
            // Two-phase search: Phase 1 (title) then Phase 2 (deep)
            const titleResponse = await searchSessions({
              query: trimmedQuery,
              tier: 'title',
              signal: controller.signal,
              ...visibilityOpts,
              ...getContextUsageOpts(getState()),
            })
            if (controller.signal.aborted) return

            commitContextUsageFromRows(dispatch, getState, titleResponse, titleResponse.results)
            dispatch(commitSessionWindowReplacement(buildSearchPayload(surface, titleResponse.results, trimmedQuery, searchTier, true, {
              projectColors: titleResponse.projectColors,
              partial: titleResponse.partial,
              partialReason: titleResponse.partialReason,
              integrityError: titleResponse.integrityError,
            })))

            // Phase 2: file-based search
            try {
              const deepResponse = await searchSessions({
                query: trimmedQuery,
                tier: searchTier,
                signal: controller.signal,
                ...visibilityOpts,
                ...getContextUsageOpts(getState()),
              })
              if (controller.signal.aborted) return

              commitContextUsageFromRows(dispatch, getState, deepResponse, deepResponse.results)
              const merged = mergeSearchResults(titleResponse.results, deepResponse.results)
              dispatch(commitSessionWindowReplacement(buildSearchPayload(surface, merged, trimmedQuery, searchTier, false, {
                partial: deepResponse.partial,
                partialReason: deepResponse.partialReason,
                integrityError: deepResponse.integrityError ?? titleResponse.integrityError,
                projectColors: deepResponse.projectColors ?? titleResponse.projectColors,
              })))
            } catch (phase2Error) {
              if (controller.signal.aborted) return
              // Phase 2 failed but Phase 1 data is already displayed.
              // Clear the pending indicator and report the error.
              dispatch(commitSessionWindowReplacement(buildSearchPayload(surface, titleResponse.results, trimmedQuery, searchTier, false, {
                projectColors: titleResponse.projectColors,
                partial: titleResponse.partial,
                partialReason: titleResponse.partialReason,
                integrityError: titleResponse.integrityError,
              })))
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
              ...getContextUsageOpts(getState()),
            })
            if (controller.signal.aborted) return

            dispatch(commitSessionWindowReplacement(buildSearchPayload(surface, response.results, trimmedQuery, searchTier, false, {
              partial: response.partial,
              partialReason: response.partialReason,
              integrityError: response.integrityError,
              hasMore: response.hasMore,
              searchCursor: response.nextCursor,
              projectColors: response.projectColors,
            })))
            commitContextUsageFromRows(dispatch, getState, response, response.results)
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
          ...getContextUsageOpts(getState()),
        })
        if (controller.signal.aborted) return

        const nextProjects = Array.isArray(response) ? response : (response?.projects ?? [])
        const projects = append
          ? mergeProjects(windowState?.projects ?? [], nextProjects)
          : nextProjects

        dispatch(commitSessionWindowReplacement({
          surface,
          projects,
          totalSessions: append ? countSessions(projects) : response?.totalSessions,
          oldestLoadedTimestamp: response?.oldestIncludedTimestamp,
          oldestLoadedSessionId: response?.oldestIncludedSessionId,
          hasMore: response?.hasMore,
          query: trimmedQuery,
          searchTier,
          partial: response?.partial,
          partialReason: response?.partialReason,
          integrityError: response?.integrityError,
        }))
        // Fresh-page rows only (nextProjects is the server's page, before the
        // append merge stapled retained rows onto it).
        commitContextUsageFromRows(dispatch, getState, response, nextProjects.flatMap((p: { sessions?: UsageBearingRow[] }) => p.sessions ?? []))
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
        if (inFlightRequests.get(surface) === settled) {
          inFlightRequests.delete(surface)
        }
      }
    })()

    inFlightRequests.set(surface, settled)
    // The returned promise never rejects: success/abort -> ok:true, real failure ->
    // ok:false. `settled` (the void promise stored for in-flight coalescing) still
    // rejects internally — queueActiveSessionWindowRefresh awaits it only inside
    // try/catch — but the .then below attaches a rejection handler to it, so a
    // fire-and-forget caller can never leak an unhandled rejection.
    return settled.then(
      (): FetchSessionWindowResult => ({ ok: true, unauthorized: false }),
      (error: unknown): FetchSessionWindowResult => ({
        ok: false,
        unauthorized: isApiUnauthorizedError(error),
      }),
    )
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
  return async (dispatch: AppDispatch): Promise<FetchSessionWindowResult> => {
    dispatch(activateSessionSurface('sidebar'))
    return dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any) as Promise<FetchSessionWindowResult>
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
