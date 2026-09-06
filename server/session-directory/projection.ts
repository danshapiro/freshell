import type { CodingCliSession, ProjectGroup } from '../coding-cli/types.js'
import type { SessionDirectoryItem } from './types.js'

export type SessionDirectoryComparableItem = Omit<
  SessionDirectoryItem,
  'isRunning' | 'runningTerminalId' | 'snippet' | 'matchedIn'
>

function buildSessionKey(item: { provider: string; sessionId: string }): string {
  return `${item.provider}:${item.sessionId}`
}

function comparableItemsEqual(a: SessionDirectoryComparableItem, b: SessionDirectoryComparableItem): boolean {
  return (
    a.provider === b.provider &&
    a.sessionId === b.sessionId &&
    a.projectPath === b.projectPath &&
    a.checkoutPath === b.checkoutPath &&
    a.title === b.title &&
    a.summary === b.summary &&
    a.lastActivityAt === b.lastActivityAt &&
    a.createdAt === b.createdAt &&
    a.archived === b.archived &&
    a.cwd === b.cwd &&
    a.sessionType === b.sessionType &&
    a.isSubagent === b.isSubagent &&
    a.isNonInteractive === b.isNonInteractive &&
    a.firstUserMessage === b.firstUserMessage &&
    // b5fb: override provenance is directory-visible — a rename/clear (or any
    // provenance-only change at the same displayed title) must count as a
    // change so `sessions.changed` fires and clients refetch the reset-flow
    // fields.
    a.titleOverridden === b.titleOverridden &&
    a.providerTitle === b.providerTitle &&
    a.titleOverrideSource === b.titleOverrideSource &&
    // STATUS-STRIP: usage ticks must count as a change so `sessions.changed`
    // fires and the strip's context meter refetches — otherwise the meter
    // would only move when some other field happened to change too.
    JSON.stringify(a.tokenUsage ?? null) === JSON.stringify(b.tokenUsage ?? null)
  )
}

export function toSessionDirectoryComparableItem(session: CodingCliSession): SessionDirectoryComparableItem {
  return {
    provider: session.provider,
    sessionId: session.sessionId,
    projectPath: session.projectPath,
    checkoutPath: session.checkoutPath,
    title: session.title,
    summary: session.summary,
    lastActivityAt: session.lastActivityAt,
    createdAt: session.createdAt,
    archived: session.archived,
    cwd: session.cwd,
    sessionType: session.sessionType,
    isSubagent: session.isSubagent,
    isNonInteractive: session.isNonInteractive,
    firstUserMessage: session.firstUserMessage,
    // b5fb: the reviewed reset flow's provenance fields ride the directory row.
    titleOverridden: session.titleOverridden,
    providerTitle: session.providerTitle,
    titleOverrideSource: session.titleOverrideSource,
    tokenUsage: session.tokenUsage,
  }
}

export function compareSessionDirectoryComparableItems(
  a: SessionDirectoryComparableItem,
  b: SessionDirectoryComparableItem,
): number {
  const aArchived = !!a.archived
  const bArchived = !!b.archived
  if (aArchived !== bArchived) return aArchived ? 1 : -1

  const byLastActivityAt = b.lastActivityAt - a.lastActivityAt
  if (byLastActivityAt !== 0) return byLastActivityAt

  return buildSessionKey(b).localeCompare(buildSessionKey(a))
}

export function buildSessionDirectoryComparableSnapshot(projects: ProjectGroup[]): SessionDirectoryComparableItem[] {
  return projects
    .flatMap((project) => project.sessions.map((session) => toSessionDirectoryComparableItem(session)))
    .sort(compareSessionDirectoryComparableItems)
}

export function hasSessionDirectorySnapshotChange(prevProjects: ProjectGroup[], nextProjects: ProjectGroup[]): boolean {
  const prevSnapshot = buildSessionDirectoryComparableSnapshot(prevProjects)
  const nextSnapshot = buildSessionDirectoryComparableSnapshot(nextProjects)

  if (prevSnapshot.length !== nextSnapshot.length) return true

  for (let index = 0; index < prevSnapshot.length; index += 1) {
    const prevItem = prevSnapshot[index]
    const nextItem = nextSnapshot[index]
    if (!prevItem || !nextItem || !comparableItemsEqual(prevItem, nextItem)) {
      return true
    }
  }

  return false
}
