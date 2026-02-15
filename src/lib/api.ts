import type { CodingCliProviderName } from './coding-cli-types'
import { getClientPerfConfig, isClientPerfLoggingEnabled, logClientPerf } from '@/lib/perf-logger'
import { getAuthToken } from '@/lib/auth'

export type ApiError = {
  status: number
  message: string
  details?: unknown
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
      message: (data && data.error) || res.statusText,
      details: data,
    }
    throw err
  }

  return data as T
}

export const api = {
  get<T = any>(path: string): Promise<T> {
    return request<T>(path)
  },
  post<T = any>(path: string, body: unknown): Promise<T> {
    return request<T>(path, { method: 'POST', body: JSON.stringify(body) })
  },
  patch<T = any>(path: string, body: unknown): Promise<T> {
    return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) })
  },
  put<T = any>(path: string, body: unknown): Promise<T> {
    return request<T>(path, { method: 'PUT', body: JSON.stringify(body) })
  },
  delete<T = any>(path: string): Promise<T> {
    return request<T>(path, { method: 'DELETE' })
  },
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

export async function searchSessions(options: SearchOptions): Promise<SearchResponse> {
  const { query, tier = 'title', limit, maxFiles } = options
  const params = new URLSearchParams({ q: query, tier })
  if (limit) params.set('limit', String(limit))
  if (maxFiles) params.set('maxFiles', String(maxFiles))

  return api.get<SearchResponse>(`/api/sessions/search?${params}`)
}
