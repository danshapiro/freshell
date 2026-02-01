import type { CodingCliProviderName } from './coding-cli-types'

export type ApiError = {
  status: number
  message: string
  details?: unknown
}

function getAuthToken(): string | undefined {
  return sessionStorage.getItem('auth-token') || undefined
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {})
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json')
  }

  const token = getAuthToken()
  if (token) {
    headers.set('x-auth-token', token)
  }

  const res = await fetch(path, { ...options, headers })
  const text = await res.text()

  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
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
  get<T>(path: string): Promise<T> {
    return request<T>(path)
  },
  post<T>(path: string, body: unknown): Promise<T> {
    return request<T>(path, { method: 'POST', body: JSON.stringify(body) })
  },
  patch<T>(path: string, body: unknown): Promise<T> {
    return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) })
  },
  put<T>(path: string, body: unknown): Promise<T> {
    return request<T>(path, { method: 'PUT', body: JSON.stringify(body) })
  },
  delete<T>(path: string): Promise<T> {
    return request<T>(path, { method: 'DELETE' })
  },
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
  cwd?: string
}

export type SearchResponse = {
  results: SearchResult[]
  tier: 'title' | 'userMessages' | 'fullText'
  query: string
  totalScanned: number
}

export type SearchOptions = {
  query: string
  tier?: 'title' | 'userMessages' | 'fullText'
  limit?: number
}

export async function searchSessions(options: SearchOptions): Promise<SearchResponse> {
  const { query, tier = 'title', limit } = options
  const params = new URLSearchParams({ q: query, tier })
  if (limit) params.set('limit', String(limit))

  return api.get<SearchResponse>(`/api/sessions/search?${params}`)
}
