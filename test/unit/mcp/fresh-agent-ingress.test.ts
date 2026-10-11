// @vitest-environment node
import { createServer } from 'node:http'
import { once } from 'node:events'
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { observeFreshMcpIngress } from '../../e2e-browser/helpers/managed-runtime.js'
import { executeAction } from '../../../tools/freshell-mcp/freshell-tool.js'

const profiles = [
  { agent: 'claude', provider: 'claude', model: 'haiku', effort: 'low' },
  { agent: 'kilroy', provider: 'claude', model: 'haiku', effort: 'low' },
  { agent: 'codex', provider: 'codex', model: 'gpt-5.6-luna', effort: 'low' },
  { agent: 'opencode', provider: 'opencode', model: 'opencode/big-pickle', effort: undefined },
]
type RequestFact = { method: string; path: string; body: any }
const requests: RequestFact[] = []
let reply: unknown
let status: number
const server = createServer((request, response) => {
  let body = ''
  request.on('data', chunk => { body += String(chunk) })
  request.on('end', () => {
    const path = request.url ?? ''
    requests.push({ method: request.method ?? '', path, body: body ? JSON.parse(body) : undefined })
    response.setHeader('content-type', 'application/json')
    if (request.method === 'GET' && path === '/api/tabs') {
      response.end(JSON.stringify({ data: { tabs: [{ id: 't1', activePaneId: 'p1' }], activeTabId: 't1' } }))
    } else if (request.method === 'GET' && path === '/api/panes?tabId=t1') {
      response.end(JSON.stringify({ data: { panes: [{ id: 'p1', index: 0, kind: 'fresh-agent' }] } }))
    } else if (request.method === 'POST' && (path === '/api/tabs' || path === '/api/panes/p1/split')) {
      response.statusCode = status
      response.end(JSON.stringify(reply))
    } else {
      response.statusCode = 404
      response.end(JSON.stringify({ error: 'unexpected loopback route' }))
    }
  })
})

beforeAll(async () => {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('loopback fixture did not listen')
  vi.stubEnv('FRESHELL_URL', `http://127.0.0.1:${address.port}`)
  vi.stubEnv('FRESHELL_TOKEN', '')
  vi.stubEnv('FRESHELL_TAB_ID', '')
  vi.stubEnv('FRESHELL_PANE_ID', '')
})
afterAll(async () => {
  const closed = once(server, 'close')
  server.close()
  server.closeAllConnections()
  await closed
  expect(server.listening).toBe(false)
  vi.unstubAllEnvs()
})
beforeEach(() => {
  requests.length = 0
  status = 200
  reply = { status: 'ok', data: { paneId: 'alias-pane', sessionId: 'native-root' } }
})

describe('shared actual MCP fresh-agent ingress observer', () => {
  for (const action of ['new-tab', 'split-pane']) {
    it.each(profiles)('observes one actual ' + action + ' POST for $agent with its current profile and canonical root', async profile => {
      const params = {
        agent: profile.agent, cwd: '/workspace', model: profile.model, effort: profile.effort,
        permissionMode: 'default', sessionRef: { provider: profile.provider, sessionId: 'native-root' },
        ...(action === 'split-pane' ? { target: 'p1', direction: 'horizontal' } : {}),
      }
      const priorFetch = globalThis.fetch
      const observed = await observeFreshMcpIngress(action, params)
      expect(globalThis.fetch).toBe(priorFetch)
      const posts = requests.filter(request => request.method === 'POST')
      expect(posts).toHaveLength(1)
      expect(posts[0].path).toBe(action === 'new-tab' ? '/api/tabs' : '/api/panes/p1/split')
      expect(posts[0].body).toMatchObject({
        agent: profile.agent, model: profile.model, cwd: '/workspace', permissionMode: 'default',
        sessionRef: { provider: profile.provider, sessionId: 'native-root' },
      })
      if (profile.effort) expect(posts[0].body.effort).toBe(profile.effort)
      else expect(posts[0].body).not.toHaveProperty('effort')
      expect(observed).toEqual({ request: posts[0], reply: { paneId: 'alias-pane', sessionId: 'native-root' } })
    })
  }

  it.each([
    ['unknown-action', {}],
    ['run', { command: 'never run' }],
    ['fresh-send', { sessionId: 'root', text: 'never sent' }],
    ['attach', { target: 'p1', terminalId: 'terminal' }],
    ['new-tab', { agent: 'unknown' }],
    ['split-pane', { agent: 'unknown', target: 'p1' }],
    ['new-tab', { agent: 'claude', unknownParameter: true }],
    ['split-pane', { agent: 'claude', target: 'p1', unknownParameter: true }],
    ['new-tab', { agent: 'codex', resume: 'raw-thread' }],
    ['new-tab', { agent: 'codex', resumeSessionId: 'raw-thread' }],
    ['split-pane', { agent: 'codex', target: 'p1', resume: 'raw-thread' }],
  ] as const)('refuses %s locally without any creation POST', async (action, params) => {
    const result = await executeAction(action, params)
    expect(result).toHaveProperty('error')
    expect(requests).toHaveLength(0)
  })

  it('reports a local refusal with safe zero-request facts and restores fetch', async () => {
    const prior = globalThis.fetch
    await expect(observeFreshMcpIngress('new-tab', { unknownParameter: 'private-input' })).rejects.toThrow(
      '"requestCount":0,"paneIdPresent":false,"errorPresent":true,"status":"absent"',
    )
    expect(requests).toHaveLength(0)
    expect(globalThis.fetch).toBe(prior)
  })

  it('refuses a missing split target instead of accepting zero POSTs', async () => {
    await expect(observeFreshMcpIngress('split-pane', { agent: 'opencode', target: 'missing' })).rejects.toThrow('"requestCount":0')
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(0)
  })

  it.each([
    [409, { status: 'error', message: 'private-provider-error', data: { paneId: 'alias-pane' } }],
    [200, { status: 'error', message: 'private-provider-error', data: { paneId: 'alias-pane' } }],
    [200, { status: 'ok', data: { paneId: 'alias-pane', error: 'private-provider-error' } }],
    [200, { status: 'private-status', data: { paneId: 'alias-pane' } }],
    [200, { status: 'ok', data: { sessionId: 'native-root' } }],
    [200, { status: 'ok', data: { paneId: '' } }],
    [200, { status: 'ok', data: { paneId: 42 } }],
  ])('refuses an actual HTTP %i invalid create reply with safe diagnostics', async (httpStatus, body) => {
    status = httpStatus
    reply = body
    const prior = globalThis.fetch
    const error = await observeFreshMcpIngress('new-tab', { agent: 'opencode' }).then(() => null, error => error)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('"requestCount":1')
    expect(error.message).not.toContain('private-')
    expect(globalThis.fetch).toBe(prior)
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1)
  })

  it('refuses two actual creation POSTs even when their returned pane IDs agree', async () => {
    const prior = globalThis.fetch
    await expect(observeFreshMcpIngress('new-tab', { agent: 'opencode' }, async (action, params) => {
      await executeAction(action, params)
      return executeAction(action, params)
    })).rejects.toThrow('"requestCount":2')
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(2)
    expect(globalThis.fetch).toBe(prior)
  })

  it.each(['new-window', 'new-session', 'split-window'])('observes actual fresh-agent creation through alias %s', async action => {
    const observed = await observeFreshMcpIngress(action, {
      agent: 'kilroy', permissionMode: 'default', model: 'haiku', effort: 'low',
      sessionRef: { provider: 'claude', sessionId: 'native-root' },
      ...(action === 'split-window' ? { target: 'p1' } : {}),
    })
    expect(requests.filter(row => row.method === 'POST')).toHaveLength(1)
    expect(observed.reply).toEqual({ paneId: 'alias-pane', sessionId: 'native-root' })
    expect(observed.request.body.agent).toBe('kilroy')
    expect(observed.request.body.sessionRef).toEqual({ provider: 'claude', sessionId: 'native-root' })
  })
})
