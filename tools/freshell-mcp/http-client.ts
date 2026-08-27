/**
 * Minimal HTTP client for the Freshell REST API, used by the MCP server.
 *
 * Reads FRESHELL_URL and FRESHELL_TOKEN from the environment (injected by
 * Freshell into every spawned terminal). Does NOT read config files -- the
 * MCP server always runs in a terminal that already has env vars set.
 */

export type ApiClientConfig = {
  url: string
  token: string
}

export function resolveConfig(): ApiClientConfig {
  return {
    url: process.env.FRESHELL_URL || 'http://localhost:3001',
    token: process.env.FRESHELL_TOKEN || '',
  }
}

export type ApiClient = {
  get: <T = any>(path: string) => Promise<T>
  post: <T = any>(path: string, body?: unknown) => Promise<T>
  patch: <T = any>(path: string, body?: unknown) => Promise<T>
  delete: <T = any>(path: string) => Promise<T>
}

function joinUrl(base: string, path: string): string {
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${trimmed}${suffix}`
}

async function parseResponse(res: Response) {
  const text = await res.text()
  if (!text) return ''
  const type = res.headers.get('content-type') || ''
  if (type.includes('application/json')) {
    try {
      const parsed = JSON.parse(text)
      // Handle agent API envelope: { status, data, message }
      // Preserve status/message alongside data so callers can distinguish
      // normal vs approximate/degraded outcomes.
      if (parsed && typeof parsed === 'object' && 'data' in parsed) {
        if (parsed.data != null) {
          // Return the full envelope so callers can inspect status/message
          return parsed
        }
        // data is null/undefined -- return message-only envelope or empty object
        if (parsed.message) return { message: parsed.message }
        return {}
      }
      return parsed
    } catch {
      return text
    }
  }
  return text
}

export function createApiClient(config?: ApiClientConfig): ApiClient {
  const { url: baseUrl, token } = config ?? resolveConfig()

  const request = async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = {}
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (token) headers['x-auth-token'] = token

    const res = await fetch(joinUrl(baseUrl, path), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    const data = await parseResponse(res)
    if (!res.ok) {
      const message = (data && typeof data === 'object' && (data.error || data.message))
        || (typeof data === 'string' && data)
        || res.statusText
      const err = new Error(message)
      ;(err as any).status = res.status
      ;(err as any).details = data
      throw err
    }
    return data as T
  }

  return {
    get: <T = any>(path: string) => request<T>('GET', path),
    post: <T = any>(path: string, body?: unknown) => request<T>('POST', path, body),
    patch: <T = any>(path: string, body?: unknown) => request<T>('PATCH', path, body),
    delete: <T = any>(path: string) => request<T>('DELETE', path),
  }
}
