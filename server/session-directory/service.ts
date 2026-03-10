import type { ProjectGroup } from '../coding-cli/types.js'
import type { TerminalMeta } from '../terminal-metadata-service.js'
import { extractSnippet } from '../session-search.js'
import type {
  SessionDirectoryItem,
  SessionDirectoryPage,
  SessionDirectoryQuery,
} from './types.js'

const MAX_DIRECTORY_PAGE_ITEMS = 50

type QuerySessionDirectoryInput = {
  projects: ProjectGroup[]
  query: SessionDirectoryQuery
  terminalMeta: TerminalMeta[]
  signal?: AbortSignal
}

type CursorPayload = {
  updatedAt: number
  key: string
}

function buildSessionKey(item: { provider: string; sessionId: string }): string {
  return `${item.provider}:${item.sessionId}`
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): CursorPayload {
  try {
    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorPayload>
    if (typeof payload.updatedAt !== 'number' || !Number.isFinite(payload.updatedAt) || typeof payload.key !== 'string' || payload.key.length === 0) {
      throw new Error('invalid')
    }
    return { updatedAt: payload.updatedAt, key: payload.key }
  } catch {
    throw new Error('Invalid session-directory cursor')
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Session-directory request aborted')
  }
}

function compareItems(a: SessionDirectoryItem, b: SessionDirectoryItem): number {
  const aArchived = !!a.archived
  const bArchived = !!b.archived
  if (aArchived !== bArchived) return aArchived ? 1 : -1

  const byUpdatedAt = b.updatedAt - a.updatedAt
  if (byUpdatedAt !== 0) return byUpdatedAt

  const aKey = buildSessionKey(a)
  const bKey = buildSessionKey(b)
  return bKey.localeCompare(aKey)
}

function applySearch(item: SessionDirectoryItem, queryText: string): SessionDirectoryItem | null {
  const normalizedQuery = queryText.toLowerCase()
  const searchable = [
    item.title,
    item.summary,
    item.firstUserMessage,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)

  const match = searchable.find((value) => value.toLowerCase().includes(normalizedQuery))
  if (!match) return null

  return {
    ...item,
    snippet: extractSnippet(match, queryText, 40).slice(0, 140),
  }
}

function joinRunningState(item: SessionDirectoryItem, terminalMeta: TerminalMeta[]): SessionDirectoryItem {
  const match = terminalMeta.find((meta) => (
    meta.provider === item.provider &&
    meta.sessionId === item.sessionId
  ))

  if (!match) {
    return {
      ...item,
      isRunning: false,
    }
  }

  return {
    ...item,
    isRunning: true,
    runningTerminalId: match.terminalId,
  }
}

function toItems(projects: ProjectGroup[], terminalMeta: TerminalMeta[]): SessionDirectoryItem[] {
  const items: SessionDirectoryItem[] = []

  for (const project of projects) {
    for (const session of project.sessions) {
      items.push(joinRunningState({
        sessionId: session.sessionId,
        provider: session.provider,
        projectPath: session.projectPath,
        title: session.title,
        summary: session.summary,
        updatedAt: session.updatedAt,
        createdAt: session.createdAt,
        archived: session.archived,
        cwd: session.cwd,
        sessionType: session.sessionType,
        isSubagent: session.isSubagent,
        isNonInteractive: session.isNonInteractive,
        firstUserMessage: session.firstUserMessage,
        isRunning: false,
      }, terminalMeta))
    }
  }

  return items
}

export async function querySessionDirectory(input: QuerySessionDirectoryInput): Promise<SessionDirectoryPage> {
  const limit = Math.min(input.query.limit ?? MAX_DIRECTORY_PAGE_ITEMS, MAX_DIRECTORY_PAGE_ITEMS)
  const cursor = input.query.cursor ? decodeCursor(input.query.cursor) : null
  const revision = Math.max(
    0,
    ...input.projects.flatMap((project) => project.sessions.map((session) => session.updatedAt)),
    ...input.terminalMeta.map((meta) => meta.updatedAt),
  )

  throwIfAborted(input.signal)

  let items = toItems(input.projects, input.terminalMeta).sort(compareItems)

  if (input.query.query?.trim()) {
    items = items
      .map((item) => applySearch(item, input.query.query!.trim()))
      .filter((item): item is SessionDirectoryItem => item !== null)
      .sort(compareItems)
  }

  if (cursor) {
    items = items.filter((item) => (
      item.updatedAt < cursor.updatedAt ||
      (item.updatedAt === cursor.updatedAt && buildSessionKey(item).localeCompare(cursor.key) < 0)
    ))
  }

  throwIfAborted(input.signal)

  const pageItems = items.slice(0, limit)
  const tail = pageItems.at(-1)
  const nextCursor = items.length > limit && tail
    ? encodeCursor({ updatedAt: tail.updatedAt, key: buildSessionKey(tail) })
    : null

  return {
    items: pageItems,
    nextCursor,
    revision,
  }
}
