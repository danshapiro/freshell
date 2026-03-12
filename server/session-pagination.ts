import type { ProjectGroup, CodingCliSession } from './coding-cli/types.js'

const DEFAULT_PAGE_LIMIT = 100

export interface PaginatedResult {
  projects: ProjectGroup[]
  totalSessions: number
  oldestIncludedTimestamp: number
  /**
   * Composite key (provider:sessionId) of the oldest included session.
   * Pass as `beforeId` for the next page request.
   */
  oldestIncludedSessionId: string
  hasMore: boolean
}

export interface PaginateOptions {
  limit?: number
  /** Only include sessions older than this timestamp (exclusive). */
  before?: number
  /**
   * Tie-breaker: composite key (provider:sessionId).
   * When `before` matches a session's updatedAt, only include sessions
   * whose composite key sorts before this value.
   */
  beforeId?: string
  forceIncludeSessionKeys?: ReadonlySet<string>
}

/** Build the composite cursor key for a session. */
function cursorKey(s: CodingCliSession): string {
  return `${s.provider}:${s.sessionId}`
}

/**
 * Compare two sessions for descending sort: newest first, ties broken by
 * composite key (provider:sessionId) descending for deterministic pagination.
 */
function compareSessionsDesc(a: CodingCliSession, b: CodingCliSession): number {
  const diff = b.updatedAt - a.updatedAt
  if (diff !== 0) return diff
  // Deterministic tie-breaker: composite key descending
  const aKey = cursorKey(a)
  const bKey = cursorKey(b)
  if (aKey < bKey) return 1
  if (aKey > bKey) return -1
  return 0
}

/**
 * Paginate a list of project groups by session recency.
 *
 * Flattens all sessions, sorts by updatedAt desc (ties broken by composite key
 * desc), takes the top `limit`, then regroups into ProjectGroup[] preserving
 * project colors.
 *
 * Uses a compound cursor (before + beforeId) for stable pagination when
 * multiple sessions share the same updatedAt timestamp.
 */
export function paginateProjects(
  allProjects: ProjectGroup[],
  options: PaginateOptions,
): PaginatedResult {
  const limit = options.limit ?? DEFAULT_PAGE_LIMIT
  const { before, beforeId } = options

  // Collect all sessions with their project color for regrouping
  const colorByPath = new Map<string, string | undefined>()
  let allSessions: CodingCliSession[] = []

  for (const project of allProjects) {
    colorByPath.set(project.projectPath, project.color)
    for (const session of project.sessions) {
      allSessions.push(session)
    }
  }

  const totalSessions = allSessions.length

  // Apply compound cursor filter
  if (before !== undefined) {
    if (beforeId !== undefined) {
      // Compound cursor: exclude sessions at or after the cursor position
      allSessions = allSessions.filter(s =>
        s.updatedAt < before ||
        (s.updatedAt === before && cursorKey(s) < beforeId),
      )
    } else {
      // Simple timestamp cursor (backward compat)
      allSessions = allSessions.filter(s => s.updatedAt < before)
    }
  }

  // Sort by updatedAt descending, ties broken by composite key descending
  allSessions.sort(compareSessionsDesc)

  const primaryPage = allSessions.slice(0, limit)
  const primaryKeys = new Set(primaryPage.map(cursorKey))
  const forcedExtras = before === undefined && options.forceIncludeSessionKeys?.size
    ? allSessions.filter((session) => (
      options.forceIncludeSessionKeys!.has(cursorKey(session)) && !primaryKeys.has(cursorKey(session))
    ))
    : []
  const page = [...primaryPage, ...forcedExtras].sort(compareSessionsDesc)
  const pageKeys = new Set(page.map(cursorKey))
  const hasMore = allSessions.some((session) => !pageKeys.has(cursorKey(session)))

  // Regroup by project path
  const groupMap = new Map<string, CodingCliSession[]>()
  for (const session of page) {
    const path = session.projectPath
    let group = groupMap.get(path)
    if (!group) {
      group = []
      groupMap.set(path, group)
    }
    group.push(session)
  }

  const projects: ProjectGroup[] = []
  for (const [path, sessions] of groupMap) {
    const color = colorByPath.get(path)
    projects.push({ projectPath: path, sessions, ...(color ? { color } : {}) })
  }

  const oldest = primaryPage.length > 0 ? primaryPage[primaryPage.length - 1] : undefined

  return {
    projects,
    totalSessions,
    oldestIncludedTimestamp: oldest?.updatedAt ?? 0,
    oldestIncludedSessionId: oldest ? cursorKey(oldest) : '',
    hasMore,
  }
}
