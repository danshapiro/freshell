import type { CodingCliProvider } from '../coding-cli/provider.js'
import type { ProjectGroup } from '../coding-cli/types.js'
import type { TerminalMeta } from '../terminal-metadata-service.js'
import { extractSnippet, searchSessionFile } from '../session-search.js'
import { MAX_DIRECTORY_PAGE_ITEMS } from '../../shared/read-models.js'
import { matchTitleTierMetadata } from '../../shared/session-title-search.js'
import {
  buildSessionDirectoryComparableSnapshot,
  compareSessionDirectoryComparableItems,
} from './projection.js'
import type {
  SessionDirectoryItem,
  SessionDirectoryPage,
  SessionDirectoryQuery,
} from './types.js'

type QuerySessionDirectoryInput = {
  projects: ProjectGroup[]
  query: SessionDirectoryQuery
  terminalMeta: TerminalMeta[]
  providers?: CodingCliProvider[]
  signal?: AbortSignal
}

type FileSearchResult = {
  items: SessionDirectoryItem[]
  partial?: true
  partialReason?: 'budget' | 'io_error'
}

type CursorPayload = {
  lastActivityAt: number
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
    if (typeof payload.lastActivityAt !== 'number' || !Number.isFinite(payload.lastActivityAt) || typeof payload.key !== 'string' || payload.key.length === 0) {
      throw new Error('invalid')
    }
    return { lastActivityAt: payload.lastActivityAt, key: payload.key }
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
  return compareSessionDirectoryComparableItems(a, b)
}

function applySearch(item: SessionDirectoryItem, queryText: string): SessionDirectoryItem | null {
  const match = matchTitleTierMetadata(item, queryText)
  if (!match) return null

  return {
    ...item,
    matchedIn: match.matchedIn,
    snippet: extractSnippet(match.matchedValue, queryText, 40).slice(0, 140),
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
  return buildSessionDirectoryComparableSnapshot(projects).map((item) => (
    joinRunningState({
      ...item,
      isRunning: false,
    }, terminalMeta)
  ))
}

async function applyFileSearch(
  items: SessionDirectoryItem[],
  queryText: string,
  tier: 'userMessages' | 'fullText',
  input: QuerySessionDirectoryInput,
  limit: number,
): Promise<FileSearchResult> {
  const providersByName = new Map(
    (input.providers ?? []).map((p) => [p.name, p])
  )

  // Build a lookup from sessionKey -> sourceFile from the original projects.
  // The toItems/projection step strips sourceFile, so we must look it up here.
  const sourceFiles = new Map<string, string>()
  for (const project of input.projects) {
    for (const session of project.sessions) {
      if (session.sourceFile) {
        sourceFiles.set(buildSessionKey({ provider: session.provider, sessionId: session.sessionId }), session.sourceFile)
      }
    }
  }

  const results: SessionDirectoryItem[] = []
  const maxScan = limit * 10 // Scan budget to avoid unbounded I/O
  let partial = false
  let partialReason: 'budget' | 'io_error' | undefined

  let scanned = 0
  for (const item of items) {
    if (results.length >= limit + 1) break
    if (scanned >= maxScan) {
      partial = true
      partialReason = 'budget'
      break
    }
    throwIfAborted(input.signal)

    const key = buildSessionKey(item)
    const sourceFile = sourceFiles.get(key)
    if (!sourceFile) continue

    const provider = providersByName.get(item.provider)
    if (!provider) continue

    scanned++

    try {
      const match = await searchSessionFile(provider, sourceFile, queryText, tier, input.signal)
      if (match) {
        results.push({
          ...item,
          matchedIn: match.matchedIn,
          snippet: match.snippet,
        })
      }
    } catch (error) {
      // Re-throw abort errors so they propagate correctly
      if (input.signal?.aborted) throw error
      // Graceful: mark partial and skip sessions with I/O errors
      partial = true
      if (partialReason !== 'budget') {
        partialReason = 'io_error'
      }
      continue
    }
  }

  const result: FileSearchResult = { items: results }
  if (partial) {
    result.partial = true
    result.partialReason = partialReason
  }
  return result
}

export async function querySessionDirectory(input: QuerySessionDirectoryInput): Promise<SessionDirectoryPage> {
  const limit = Math.min(input.query.limit ?? MAX_DIRECTORY_PAGE_ITEMS, MAX_DIRECTORY_PAGE_ITEMS)
  const tier = input.query.tier ?? 'title'
  const cursor = input.query.cursor ? decodeCursor(input.query.cursor) : null
  const revision = Math.max(
    0,
    ...input.projects.flatMap((project) => project.sessions.map((session) => session.lastActivityAt)),
    ...input.terminalMeta.map((meta) => meta.updatedAt),
  )

  throwIfAborted(input.signal)

  let items = toItems(input.projects, input.terminalMeta).sort(compareItems)

  // Server-side visibility pre-filtering to avoid wasting search budget on
  // sessions the client will hide. Matches the client's default sidebar settings.
  if (!input.query.includeSubagents) {
    items = items.filter((item) => !item.isSubagent)
  }
  if (!input.query.includeNonInteractive) {
    items = items.filter((item) => !item.isNonInteractive)
  }
  if (!input.query.includeEmpty) {
    items = items.filter((item) => item.title != null && item.title !== '')
  }

  if (cursor) {
    items = items.filter((item) => (
      item.lastActivityAt < cursor.lastActivityAt ||
      (item.lastActivityAt === cursor.lastActivityAt && buildSessionKey(item).localeCompare(cursor.key) < 0)
    ))
  }

  throwIfAborted(input.signal)

  let partial: true | undefined
  let partialReason: 'budget' | 'io_error' | undefined

  if (input.query.query?.trim()) {
    if (tier === 'title') {
      // Existing metadata-only search
      items = items
        .map((item) => applySearch(item, input.query.query!.trim()))
        .filter((item): item is SessionDirectoryItem => item !== null)
    } else {
      // File-based search for userMessages / fullText
      const fileResult = await applyFileSearch(items, input.query.query!.trim(), tier, input, limit)
      items = fileResult.items
      partial = fileResult.partial
      partialReason = fileResult.partialReason
    }
  }

  const pageItems = items.slice(0, limit)
  const tail = pageItems.at(-1)
  const nextCursor = items.length > limit && tail
    ? encodeCursor({ lastActivityAt: tail.lastActivityAt, key: buildSessionKey(tail) })
    : null

  const page: SessionDirectoryPage = {
    items: pageItems,
    nextCursor,
    revision,
  }

  if (partial) {
    page.partial = partial
    page.partialReason = partialReason
  }

  return page
}
