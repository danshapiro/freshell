import { resolveConfig } from './config.js'

export type HttpClient = {
  get: <T = any>(path: string) => Promise<T>
  post: <T = any>(path: string, body?: unknown) => Promise<T>
  patch: <T = any>(path: string, body?: unknown) => Promise<T>
  delete: <T = any>(path: string) => Promise<T>
  request: <T = any>(method: string, path: string, body?: unknown) => Promise<T>
}

function joinUrl(base: string, path: string) {
  if (path.startsWith('http://') || path.startsWith('https://')) return path
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
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}

export function createHttpClient(config = resolveConfig()) : HttpClient {
  const token = config.token
  const baseUrl = config.url

  const request = async <T = any>(method: string, path: string, body?: unknown) => {
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
      const message = (data && (data.error || data.message)) || res.statusText
      const err = new Error(message)
      ;(err as any).status = res.status
      ;(err as any).details = data
      throw err
    }
    return data as T
  }

  return {
    request,
    get: <T = any>(path: string) => request<T>('GET', path),
    post: <T = any>(path: string, body?: unknown) => request<T>('POST', path, body),
    patch: <T = any>(path: string, body?: unknown) => request<T>('PATCH', path, body),
    delete: <T = any>(path: string) => request<T>('DELETE', path),
  }
}
