import { makeSessionKey, type CodingCliProviderName, type CodingCliSession, type ProjectGroup } from '../coding-cli/types.js'
import type { SessionDirectoryItem } from './types.js'

export type SessionDirectoryComparableItem = Omit<
  SessionDirectoryItem,
  'isRunning' | 'runningTerminalId' | 'snippet' | 'matchedIn'
>

function buildSessionKey(item: { provider: string; sessionId: string; cwd?: string }): string {
  return makeSessionKey(item.provider as CodingCliProviderName, item.sessionId, item.cwd)
}

function comparableItemsEqual(a: SessionDirectoryComparableItem, b: SessionDirectoryComparableItem): boolean {
  return (
    a.provider === b.provider &&
    a.sessionId === b.sessionId &&
    a.sessionKey === b.sessionKey &&
    a.projectPath === b.projectPath &&
    a.title === b.title &&
    a.summary === b.summary &&
    a.archived === b.archived &&
    a.cwd === b.cwd &&
    a.sessionType === b.sessionType &&
    a.isSubagent === b.isSubagent &&
    a.isNonInteractive === b.isNonInteractive &&
    a.firstUserMessage === b.firstUserMessage
  )
}

export function toSessionDirectoryComparableItem(session: CodingCliSession): SessionDirectoryComparableItem {
  return {
    provider: session.provider,
    sessionId: session.sessionId,
    sessionKey: buildSessionKey(session),
    projectPath: session.projectPath,
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

  return (b.sessionKey ?? buildSessionKey(b)).localeCompare(a.sessionKey ?? buildSessionKey(a))
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
