import type { CodingCliProviderName } from './coding-cli-types'
import { getClientPerfConfig, isClientPerfLoggingEnabled, logClientPerf } from '@/lib/perf-logger'
import { getAuthToken } from '@/lib/auth'
import { sanitizeSessionLocators } from '@/lib/session-utils'
import type { SessionLocator } from '@/store/paneTypes'
import {
  AgentTimelinePageQuerySchema,
  SessionDirectoryPageSchema,
  SessionDirectoryQuerySchema,
  TerminalDirectoryQuerySchema,
  TerminalScrollbackQuerySchema,
  TerminalSearchQuerySchema,
  type AgentTimelinePageQuery,
  type SessionDirectoryItem as ReadModelSessionDirectoryItem,
  type SessionDirectoryPage as ReadModelSessionDirectoryPage,
  type SessionDirectoryQuery,
  type TerminalDirectoryQuery,
  type TerminalScrollbackQuery,
  type TerminalSearchQuery,
} from '@shared/read-models'

export type ApiError = {
  status: number
  message: string
  details?: unknown
}

export type ApiRequestOptions = {
  signal?: AbortSignal
}

export function isApiUnauthorizedError(error: unknown): error is ApiError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status?: unknown }).status === 401
  )
}

async function request<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const perfEnabled = isClientPerfLoggingEnabled() && typeof performance !== 'undefined'
  const perfConfig = getClientPerfConfig()
  const startAt = perfEnabled ? performance.now() : 0

  const headers = new Headers(options.headers || {})
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json')
  }

  const token = getAuthToken()
  if (token) {
    headers.set('x-auth-token', token)
  }

  const res = await fetch(path, { ...options, headers })
  const headersAt = perfEnabled ? performance.now() : 0
  const text = await res.text()
  const bodyAt = perfEnabled ? performance.now() : 0

  let data: any = null
  let parseMs: number | undefined
  if (text) {
    const parseStart = perfEnabled ? performance.now() : 0
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    } finally {
      if (perfEnabled) {
        parseMs = performance.now() - parseStart
      }
    }
  } else {
    data = null
  }

  if (perfEnabled) {
    const totalMs = bodyAt - startAt
    const ttfbMs = headersAt - startAt
    const bodyMs = bodyAt - headersAt
    const payloadChars = text.length
    const method = options.method || 'GET'

    if (totalMs >= perfConfig.apiSlowMs) {
      logClientPerf(
        'perf.api_slow',
        {
          path,
          method,
          status: res.status,
          durationMs: Number(totalMs.toFixed(2)),
          ttfbMs: Number(ttfbMs.toFixed(2)),
          bodyMs: Number(bodyMs.toFixed(2)),
          parseMs: parseMs !== undefined ? Number(parseMs.toFixed(2)) : undefined,
          payloadChars,
        },
        'warn',
      )
    }

    if (parseMs !== undefined && parseMs >= perfConfig.apiParseSlowMs) {
      logClientPerf(
        'perf.api_parse_slow',
        {
          path,
          method,
          status: res.status,
          parseMs: Number(parseMs.toFixed(2)),
          payloadChars,
        },
        'warn',
      )
    }
  }

  if (!res.ok) {
    const err: ApiError = {
      status: res.status,
      message: (data && (data.message || data.error)) || res.statusText,
      details: data,
    }
    throw err
  }

  return data as T
}

export const api = {
  get<T = any>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    return request<T>(path, options)
  },
  post<T = any>(path: string, body: unknown, options: ApiRequestOptions = {}): Promise<T> {
    return request<T>(path, { ...options, method: 'POST', body: JSON.stringify(body) })
  },
  patch<T = any>(path: string, body: unknown, options: ApiRequestOptions = {}): Promise<T> {
    return request<T>(path, { ...options, method: 'PATCH', body: JSON.stringify(body) })
  },
  put<T = any>(path: string, body: unknown, options: ApiRequestOptions = {}): Promise<T> {
    return request<T>(path, { ...options, method: 'PUT', body: JSON.stringify(body) })
  },
  delete<T = any>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    return request<T>(path, { ...options, method: 'DELETE' })
  },
}

function buildQueryString(entries: Array<[string, string | number | undefined]>): string {
  const params = new URLSearchParams()
  for (const [key, value] of entries) {
    if (value === undefined) continue
    params.set(key, String(value))
  }
  const query = params.toString()
  return query.length > 0 ? `?${query}` : ''
}

export async function getBootstrap(options: ApiRequestOptions = {}): Promise<any> {
  return api.get('/api/bootstrap', options)
}

export async function getSessionDirectoryPage(
  query: SessionDirectoryQuery,
  options: ApiRequestOptions = {},
): Promise<any> {
  const parsed = SessionDirectoryQuerySchema.parse(query)
  return api.get(
    `/api/session-directory${buildQueryString([
      ['query', parsed.query],
      ['tier', parsed.tier === 'title' ? undefined : parsed.tier],
      ['cursor', parsed.cursor],
      ['priority', parsed.priority],
      ['revision', parsed.revision],
      ['limit', parsed.limit],
    ])}`,
    options,
  )
}

export async function getTerminalDirectoryPage(
  query: TerminalDirectoryQuery,
  options: ApiRequestOptions = {},
): Promise<any> {
  const parsed = TerminalDirectoryQuerySchema.parse(query)
  return api.get(
    `/api/terminals${buildQueryString([
      ['cursor', parsed.cursor],
      ['priority', parsed.priority],
      ['revision', parsed.revision],
      ['limit', parsed.limit],
    ])}`,
    options,
  )
}

export async function getAgentTimelinePage(
  sessionId: string,
  query: AgentTimelinePageQuery = {},
  options: ApiRequestOptions = {},
): Promise<any> {
  const parsed = AgentTimelinePageQuerySchema.parse(query)
  return api.get(
    `/api/agent-sessions/${encodeURIComponent(sessionId)}/timeline${buildQueryString([
      ['cursor', parsed.cursor],
      ['priority', parsed.priority],
      ['limit', parsed.limit],
    ])}`,
    options,
  )
}

export async function getAgentTurnBody(
  sessionId: string,
  turnId: string,
  options: ApiRequestOptions = {},
): Promise<any> {
  return api.get(
    `/api/agent-sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`,
    options,
  )
}

export async function getTerminalViewport(
  terminalId: string,
  options: ApiRequestOptions = {},
): Promise<any> {
  return api.get(`/api/terminals/${encodeURIComponent(terminalId)}/viewport`, options)
}

export async function getTerminalScrollbackPage(
  terminalId: string,
  query: TerminalScrollbackQuery = {},
  options: ApiRequestOptions = {},
): Promise<any> {
  const parsed = TerminalScrollbackQuerySchema.parse(query)
  return api.get(
    `/api/terminals/${encodeURIComponent(terminalId)}/scrollback${buildQueryString([
      ['cursor', parsed.cursor],
      ['limit', parsed.limit],
    ])}`,
    options,
  )
}

export async function searchTerminalView(
  terminalId: string,
  query: TerminalSearchQuery,
  options: ApiRequestOptions = {},
): Promise<any> {
  const parsed = TerminalSearchQuerySchema.parse(query)
  return api.get(
    `/api/terminals/${encodeURIComponent(terminalId)}/search${buildQueryString([
      ['query', parsed.query],
      ['cursor', parsed.cursor],
      ['limit', parsed.limit],
    ])}`,
    options,
  )
}

export type VersionInfo = {
  currentVersion: string
  updateCheck: {
    updateAvailable: boolean
    currentVersion: string
    latestVersion: string | null
    releaseUrl: string | null
    error: string | null
  } | null
}

export type SearchResult = {
  sessionId: string
  provider: CodingCliProviderName
  projectPath: string
  title?: string
  summary?: string
  sessionType?: string
  matchedIn: 'title' | 'userMessage' | 'assistantMessage' | 'summary'
  snippet?: string
  lastActivityAt: number
  createdAt?: number
  archived?: boolean
  cwd?: string
  firstUserMessage?: string
  isSubagent?: boolean
  isNonInteractive?: boolean
}

export type SearchResponse = {
  results: SearchResult[]
  tier: 'title' | 'userMessages' | 'fullText'
  query: string
  totalScanned: number
  partial?: boolean
  partialReason?: 'budget' | 'io_error'
}

export type SearchOptions = {
  query: string
  tier?: 'title' | 'userMessages' | 'fullText'
  limit?: number
  maxFiles?: number
  signal?: AbortSignal
}

function encodeSessionCursor(before: number | undefined, beforeId: string | undefined): string | undefined {
  if (before === undefined || beforeId === undefined) return undefined
  const raw = JSON.stringify({ lastActivityAt: before, key: beforeId })
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function groupDirectoryItemsAsProjects(items: ReadModelSessionDirectoryItem[]) {
  const groups = new Map<string, Array<ReadModelSessionDirectoryItem>>()
  for (const item of items) {
    const bucket = groups.get(item.projectPath) ?? []
    bucket.push(item)
    groups.set(item.projectPath, bucket)
  }

  return Array.from(groups.entries()).map(([projectPath, sessions]) => ({
    projectPath,
    sessions: sessions.map((item) => ({
      provider: item.provider,
      sessionId: item.sessionId,
      projectPath: item.projectPath,
      lastActivityAt: item.lastActivityAt,
      createdAt: item.createdAt,
      archived: item.archived,
      cwd: item.cwd,
      title: item.title,
      summary: item.summary,
      isSubagent: item.isSubagent,
      isNonInteractive: item.isNonInteractive,
      firstUserMessage: item.firstUserMessage,
      sessionType: item.sessionType,
    })),
  }))
}

export async function setSessionMetadata(
  provider: string,
  sessionId: string,
  sessionType: string,
): Promise<void> {
  await api.post('/api/session-metadata', { provider, sessionId, sessionType })
}

export async function fetchSidebarSessionsSnapshot(options: {
  limit?: number
  before?: number
  beforeId?: string
  openSessions?: SessionLocator[]
  signal?: AbortSignal
} = {}): Promise<any> {
  const {
    limit = 100,
    before,
    beforeId,
    openSessions = [],
    signal,
  } = options
  sanitizeSessionLocators(openSessions)

  const page = SessionDirectoryPageSchema.parse(await getSessionDirectoryPage({
    priority: 'visible',
    limit: Math.min(limit, 50),
    cursor: encodeSessionCursor(before, beforeId),
  }, {
    signal,
  })) as ReadModelSessionDirectoryPage

  const projects = groupDirectoryItemsAsProjects(page.items)
  const oldest = page.items.at(-1)

  return {
    projects,
    totalSessions: page.items.length,
    oldestIncludedTimestamp: oldest?.lastActivityAt ?? 0,
    oldestIncludedSessionId: oldest ? `${oldest.provider}:${oldest.sessionId}` : '',
    hasMore: page.nextCursor !== null,
  }
}

export async function searchSessions(options: SearchOptions): Promise<SearchResponse> {
  const { query, tier = 'title', limit, signal } = options
  const page = SessionDirectoryPageSchema.parse(await getSessionDirectoryPage({
    priority: 'visible',
    query,
    tier,
    ...(limit ? { limit } : {}),
  }, {
    signal,
  })) as ReadModelSessionDirectoryPage

  return {
    results: page.items.map((item) => ({
      sessionId: item.sessionId,
      provider: item.provider,
      projectPath: item.projectPath,
      title: item.title,
      summary: item.summary,
      matchedIn: item.matchedIn === 'firstUserMessage' ? 'userMessage' : item.matchedIn ?? 'title',
      snippet: item.snippet,
      lastActivityAt: item.lastActivityAt,
      createdAt: item.createdAt,
      archived: item.archived,
      cwd: item.cwd,
      sessionType: item.sessionType,
      firstUserMessage: item.firstUserMessage,
      isSubagent: item.isSubagent,
      isNonInteractive: item.isNonInteractive,
    })),
    tier,
    query,
    totalScanned: page.items.length,
  }
}
