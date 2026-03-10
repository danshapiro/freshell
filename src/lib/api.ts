import type { CodingCliProviderName } from './coding-cli-types'
import { getClientPerfConfig, isClientPerfLoggingEnabled, logClientPerf } from '@/lib/perf-logger'
import { getAuthToken } from '@/lib/auth'
import { sanitizeSessionLocators } from '@/lib/session-utils'
import type { SessionLocator } from '@/store/paneTypes'
import {
  AgentTimelinePageQuerySchema,
  SessionDirectoryQuerySchema,
  TerminalDirectoryQuerySchema,
  TerminalScrollbackQuerySchema,
  TerminalSearchQuerySchema,
  type AgentTimelinePageQuery,
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
  matchedIn: 'title' | 'userMessage' | 'assistantMessage' | 'summary'
  snippet?: string
  updatedAt: number
  createdAt?: number
  archived?: boolean
  cwd?: string
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
} = {}): Promise<any> {
  const {
    limit = 100,
    before,
    beforeId,
    openSessions = [],
  } = options
  const sanitizedOpenSessions = sanitizeSessionLocators(openSessions)

  if (sanitizedOpenSessions.length > 0) {
    return api.post('/api/sessions/query', {
      limit,
      ...(before !== undefined ? { before } : {}),
      ...(beforeId !== undefined ? { beforeId } : {}),
      openSessions: sanitizedOpenSessions,
    })
  }

  const params = new URLSearchParams({ limit: String(limit) })
  if (before !== undefined) params.set('before', String(before))
  if (beforeId !== undefined) params.set('beforeId', beforeId)
  return api.get(`/api/sessions?${params}`)
}

export async function searchSessions(options: SearchOptions): Promise<SearchResponse> {
  const { query, tier = 'title', limit, maxFiles } = options
  const params = new URLSearchParams({ q: query, tier })
  if (limit) params.set('limit', String(limit))
  if (maxFiles) params.set('maxFiles', String(maxFiles))

  return api.get<SearchResponse>(`/api/sessions/search?${params}`)
}
