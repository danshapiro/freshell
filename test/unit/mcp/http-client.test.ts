// @vitest-environment node
import { spawn } from 'node:child_process'
import { createServer, type AddressInfo, type Server } from 'node:http'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('resolveConfig', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
    vi.resetModules()
  })

  it('reads FRESHELL_URL and FRESHELL_TOKEN from environment', async () => {
    process.env.FRESHELL_URL = 'http://myhost:4000'
    process.env.FRESHELL_TOKEN = 'abc123'
    const { resolveConfig } = await import('../../../tools/freshell-mcp/http-client.js')
    const config = resolveConfig()
    expect(config).toEqual({ url: 'http://myhost:4000', token: 'abc123' })
  })

  it('defaults to http://localhost:3001 when FRESHELL_URL not set', async () => {
    delete process.env.FRESHELL_URL
    delete process.env.FRESHELL_TOKEN
    const { resolveConfig } = await import('../../../tools/freshell-mcp/http-client.js')
    const config = resolveConfig()
    expect(config.url).toBe('http://localhost:3001')
    expect(config.token).toBe('')
  })

  it('defaults token to empty string when FRESHELL_TOKEN not set', async () => {
    process.env.FRESHELL_URL = 'http://host:3001'
    delete process.env.FRESHELL_TOKEN
    const { resolveConfig } = await import('../../../tools/freshell-mcp/http-client.js')
    const config = resolveConfig()
    expect(config.token).toBe('')
  })
})

describe('createApiClient', () => {
  let mockFetch: ReturnType<typeof vi.fn>
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('get() sends x-auth-token header when token is set', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const { createApiClient } = await import('../../../tools/freshell-mcp/http-client.js')
    const client = createApiClient({ url: 'http://localhost:3001', token: 'mytoken' })
    await client.get('/api/health')
    expect(mockFetch).toHaveBeenCalledOnce()
    const [, init] = mockFetch.mock.calls[0]
    expect(init.headers['x-auth-token']).toBe('mytoken')
  })

  it('get() omits x-auth-token header when token is empty', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const { createApiClient } = await import('../../../tools/freshell-mcp/http-client.js')
    const client = createApiClient({ url: 'http://localhost:3001', token: '' })
    await client.get('/api/health')
    const [, init] = mockFetch.mock.calls[0]
    expect(init.headers['x-auth-token']).toBeUndefined()
  })

  it('get() returns parsed JSON for JSON responses', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const { createApiClient } = await import('../../../tools/freshell-mcp/http-client.js')
    const client = createApiClient({ url: 'http://localhost:3001', token: '' })
    const result = await client.get('/api/health')
    expect(result).toEqual({ ok: true })
  })

  it('get() throws on non-ok response with error details', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    }))
    const { createApiClient } = await import('../../../tools/freshell-mcp/http-client.js')
    const client = createApiClient({ url: 'http://localhost:3001', token: '' })
    try {
      await client.get('/api/health')
      expect.fail('should have thrown')
    } catch (err: any) {
      expect(err.status).toBe(500)
      expect(err.message).toContain('Internal error')
    }
  })

  it('post() sends JSON body with content-type header', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const { createApiClient } = await import('../../../tools/freshell-mcp/http-client.js')
    const client = createApiClient({ url: 'http://localhost:3001', token: '' })
    await client.post('/api/tabs', { name: 'Test' })
    const [, init] = mockFetch.mock.calls[0]
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ name: 'Test' }))
    expect(init.headers['Content-Type']).toBe('application/json')
  })

  it('patch() sends correct method and body', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const { createApiClient } = await import('../../../tools/freshell-mcp/http-client.js')
    const client = createApiClient({ url: 'http://localhost:3001', token: '' })
    await client.patch('/api/tabs/t1', { name: 'New' })
    const [, init] = mockFetch.mock.calls[0]
    expect(init.method).toBe('PATCH')
  })

  it('delete() sends correct method', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const { createApiClient } = await import('../../../tools/freshell-mcp/http-client.js')
    const client = createApiClient({ url: 'http://localhost:3001', token: '' })
    await client.delete('/api/tabs/t1')
    const [, init] = mockFetch.mock.calls[0]
    expect(init.method).toBe('DELETE')
  })

  it('correctly joins base URL and path', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const { createApiClient } = await import('../../../tools/freshell-mcp/http-client.js')
    const client = createApiClient({ url: 'http://localhost:3001/', token: '' })
    await client.get('/api/health')
    const [url] = mockFetch.mock.calls[0]
    expect(url).toBe('http://localhost:3001/api/health')
  })

  it('get() unwraps agent API envelope when response has data field', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ status: 'ok', data: { tabs: [] } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const { createApiClient } = await import('../../../tools/freshell-mcp/http-client.js')
    const client = createApiClient({ url: 'http://localhost:3001', token: '' })
    const result = await client.get('/api/tabs')
    // data should be unwrapped, but status should be preserved for callers
    // that need to distinguish normal vs approximate/degraded outcomes
    expect(result).toHaveProperty('data')
    expect(result.data).toEqual({ tabs: [] })
    expect(result).toHaveProperty('status', 'ok')
  })

  it('get() preserves status and message alongside data in envelope responses', async () => {
    // approx() responses carry meaningful status that MCP callers need
    mockFetch.mockResolvedValue(new Response(JSON.stringify({
      status: 'approximate',
      data: { results: [1, 2] },
      message: 'Using cached data',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const { createApiClient } = await import('../../../tools/freshell-mcp/http-client.js')
    const client = createApiClient({ url: 'http://localhost:3001', token: '' })
    const result = await client.get('/api/search')
    expect(result).toHaveProperty('status', 'approximate')
    expect(result).toHaveProperty('message', 'Using cached data')
    expect(result).toHaveProperty('data')
    expect(result.data).toEqual({ results: [1, 2] })
  })

  it('get() returns full response when no data field present', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const { createApiClient } = await import('../../../tools/freshell-mcp/http-client.js')
    const client = createApiClient({ url: 'http://localhost:3001', token: '' })
    const result = await client.get('/api/health')
    expect(result).toEqual({ ok: true })
  })

  it('get() returns text for text/plain responses', async () => {
    mockFetch.mockResolvedValue(new Response('terminal output', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    }))
    const { createApiClient } = await import('../../../tools/freshell-mcp/http-client.js')
    const client = createApiClient({ url: 'http://localhost:3001', token: '' })
    const result = await client.get('/api/panes/p1/capture')
    expect(result).toBe('terminal output')
  })

  it('get() returns message when envelope has undefined data', async () => {
    // Server responds with ok(undefined, "navigate requested") -> { status: "ok", data: undefined, message: "navigate requested" }
    // Since JSON.stringify strips undefined values, the wire format is { status: "ok", message: "navigate requested" }
    // but if the server explicitly sets data to null, we get { status: "ok", data: null, message: "navigate requested" }
    // Either way, parseResponse should NOT return undefined/null -- it should fall back to a meaningful value.
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ status: 'ok', data: null, message: 'navigate requested' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const { createApiClient } = await import('../../../tools/freshell-mcp/http-client.js')
    const client = createApiClient({ url: 'http://localhost:3001', token: '' })
    const result = await client.get('/api/panes/p1/navigate')
    // Must not be null/undefined -- should return the message or an empty object
    expect(result).not.toBeNull()
    expect(result).not.toBeUndefined()
    // Should contain the message as useful feedback
    expect(result).toHaveProperty('message', 'navigate requested')
  })

  it('get() returns empty object when envelope has undefined data and no message', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ status: 'ok', data: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const { createApiClient } = await import('../../../tools/freshell-mcp/http-client.js')
    const client = createApiClient({ url: 'http://localhost:3001', token: '' })
    const result = await client.get('/api/some-action')
    expect(result).not.toBeNull()
    expect(result).not.toBeUndefined()
  })

  it('sends owned Freshell API traffic directly when Node environment proxies are enabled', async () => {
    let targetRequests = 0
    let proxyRequests = 0
    const targetServer = createServer((_request, response) => {
      targetRequests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'ok' }))
    })
    const proxyServer = createServer((_request, response) => {
      proxyRequests += 1
      const body = 'the model proxy must not receive Freshell API traffic'
      response.writeHead(502, { connection: 'close', 'content-length': String(body.length) })
      response.end(body)
    })
    proxyServer.on('connect', (_request, socket) => {
      proxyRequests += 1
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    })
    const listen = (server: Server) => new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const close = (server: Server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
    await Promise.all([listen(targetServer), listen(proxyServer)])

    try {
      const targetPort = (targetServer.address() as AddressInfo).port
      const proxyPort = (proxyServer.address() as AddressInfo).port
      const targetUrl = `http://127.0.0.1:${targetPort}`
      const proxyUrl = `http://127.0.0.1:${proxyPort}`
      const moduleUrl = new URL('../../../tools/freshell-mcp/http-client.ts', import.meta.url).href
      const source = [
        'import { createApiClient } from ' + JSON.stringify(moduleUrl),
        '(async () => {',
        `const baseUrl = ${JSON.stringify(targetUrl)}`,
        'await createApiClient({ url: baseUrl, token: "" }).get("/api/health")',
        '})().then(() => process.exit(0), () => process.exit(1))',
      ].join('\n')
      const child = spawn(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '--eval', source], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_USE_ENV_PROXY: '1',
          NODE_OPTIONS: '',
          HTTP_PROXY: proxyUrl,
          http_proxy: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          https_proxy: proxyUrl,
          NO_PROXY: '',
          no_proxy: '',
          ALL_PROXY: '',
          all_proxy: '',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => { stderr += chunk })
      const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000)
        child.once('error', (error) => {
          clearTimeout(timeout)
          reject(error)
        })
        child.once('exit', (code) => {
          clearTimeout(timeout)
          child.stderr.destroy()
          resolve({ code, stderr })
        })
      })

      expect({ targetRequests, proxyRequests, exitCode: result.code }, result.stderr).toEqual({
        targetRequests: 1,
        proxyRequests: 0,
        exitCode: 0,
      })
    } finally {
      await Promise.all([close(targetServer), close(proxyServer)])
    }
  })
})
