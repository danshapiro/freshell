import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import { WS_PROTOCOL_VERSION } from '../../shared/ws-protocol'

const TEST_TIMEOUT_MS = 30_000
const HOOK_TIMEOUT_MS = 30_000

vi.setConfig({ testTimeout: TEST_TIMEOUT_MS, hookTimeout: HOOK_TIMEOUT_MS })

class FakeRegistry {
  detach() {
    return true
  }
}

function listen(server: http.Server, timeoutMs = HOOK_TIMEOUT_MS): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.off('error', onError)
      reject(new Error('Timed out waiting for server to listen'))
    }, timeoutMs)

    const onError = (err: Error) => {
      clearTimeout(timeout)
      reject(err)
    }

    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      clearTimeout(timeout)
      server.off('error', onError)
      const addr = server.address()
      if (typeof addr === 'object' && addr) resolve({ port: addr.port })
    })
  })
}

function waitForMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', handler)
      reject(new Error('Timeout waiting for message'))
    }, timeoutMs)

    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString())
      if (!predicate(msg)) return
      clearTimeout(timeout)
      ws.off('message', handler)
      resolve(msg)
    }

    ws.on('message', handler)
  })
}

function expectNoMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 300): Promise<void> {
  return new Promise((resolve, reject) => {
    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString())
      if (!predicate(msg)) return
      clearTimeout(timeout)
      ws.off('message', handler)
      reject(new Error(`Unexpected message: ${JSON.stringify(msg)}`))
    }

    const timeout = setTimeout(() => {
      ws.off('message', handler)
      resolve()
    }, timeoutMs)

    ws.on('message', handler)
  })
}

function getSingleClientState(wsHandler: any): any {
  const states = Array.from(wsHandler.clientStates.values())
  expect(states).toHaveLength(1)
  return states[0]
}

describe('ws sidebar snapshot refresh', () => {
  let server: http.Server | undefined
  let port: number
  let wsHandler: any
  let layoutStore: any

  beforeAll(async () => {
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = 'testtoken-testtoken'
    process.env.HELLO_TIMEOUT_MS = '100'

    vi.resetModules()
    const { WsHandler } = await import('../../server/ws-handler')
    const { LayoutStore } = await import('../../server/agent-api/layout-store')

    server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    layoutStore = new (LayoutStore as any)()

    wsHandler = new (WsHandler as any)(server, new FakeRegistry() as any, {
      handshakeSnapshotProvider: async () => ({
        settings: { theme: 'dark' },
        projects: [
          {
            projectPath: '/demo',
            sessions: [
              {
                provider: 'claude',
                sessionId: 'older-open',
                projectPath: '/demo',
                lastActivityAt: 10,
              },
            ],
          },
        ],
      }),
      serverInstanceId: 'srv-local',
      layoutStore,
    })

    const info = await listen(server)
    port = info.port
  }, HOOK_TIMEOUT_MS)

  afterAll(async () => {
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }, HOOK_TIMEOUT_MS)

  it('does not send sessions.updated during hello or ui.layout.sync refreshes', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))

      const readyPromise = waitForMessage(ws, (m) => m.type === 'ready')

      ws.send(JSON.stringify({
        type: 'hello',
        token: 'testtoken-testtoken',
        protocolVersion: WS_PROTOCOL_VERSION,
      }))

      await readyPromise
      await expectNoMessage(ws, (m) => m.type === 'sessions.updated')

      ws.send(JSON.stringify({
        type: 'ui.layout.sync',
        tabs: [{ id: 'tab-agent', title: 'agent chat' }],
        activeTabId: 'tab-agent',
        layouts: {
          'tab-agent': {
            type: 'leaf',
            id: 'pane-agent',
            content: {
              kind: 'fresh-agent',
              provider: 'freshclaude',
              createRequestId: 'req-agent',
              status: 'connected',
              resumeSessionId: 'older-open',
            },
          },
        },
        activePane: {
          'tab-agent': 'pane-agent',
        },
        paneTitles: {},
        timestamp: Date.now(),
      }))

      await expectNoMessage(ws, (m) => m.type === 'sessions.updated')
    } finally {
      ws.terminate()
      await new Promise<void>((resolve) => ws.on('close', () => resolve()))
    }
  })

  it('normalizes legacy agent-chat panes before deriving sidebar locators', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const liveLegacySessionId = '00000000-0000-4000-8000-000000000123'

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))

      const readyPromise = waitForMessage(ws, (m) => m.type === 'ready')

      ws.send(JSON.stringify({
        type: 'hello',
        token: 'testtoken-testtoken',
        protocolVersion: WS_PROTOCOL_VERSION,
      }))

      await readyPromise

      ws.send(JSON.stringify({
        type: 'ui.layout.sync',
        tabs: [{ id: 'tab-agent', title: 'agent chat' }],
        activeTabId: 'tab-agent',
        layouts: {
          'tab-agent': {
            type: 'split',
            id: 'split-agent',
            direction: 'horizontal',
            sizes: [50, 50],
            children: [
              {
                type: 'leaf',
                id: 'pane-live-agent',
                content: {
                  kind: 'agent-chat',
                  provider: 'freshclaude',
                  createRequestId: 'req-live-agent',
                  status: 'connected',
                  resumeSessionId: liveLegacySessionId,
                },
              },
              {
                type: 'leaf',
                id: 'pane-stale-agent',
                content: {
                  kind: 'agent-chat',
                  provider: 'freshclaude',
                  createRequestId: 'req-stale-agent',
                  status: 'connected',
                  resumeSessionId: 'legacy-named-alias',
                },
              },
            ],
          },
        },
        activePane: {
          'tab-agent': 'pane-live-agent',
        },
        paneTitles: {},
        timestamp: Date.now(),
      }))

      const pongPromise = waitForMessage(ws, (m) => m.type === 'pong')
      ws.send(JSON.stringify({ type: 'ping' }))
      await pongPromise

      const state = getSingleClientState(wsHandler)
      expect(state.sidebarOpenSessionKeys).toEqual(new Set([`claude:${liveLegacySessionId}`]))
      expect(state.sidebarOpenSessionKeys.has('claude:legacy-named-alias')).toBe(false)
      expect(layoutStore.getPaneSnapshot('pane-live-agent')?.paneContent).toMatchObject({
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        sessionRef: { provider: 'claude', sessionId: liveLegacySessionId },
      })
      expect(layoutStore.getPaneSnapshot('pane-stale-agent')?.paneContent).toMatchObject({
        kind: 'fresh-agent',
        restoreError: { reason: 'invalid_legacy_restore_target' },
      })
    } finally {
      ws.terminate()
      await new Promise<void>((resolve) => ws.on('close', () => resolve()))
    }
  })

  it('broadcasts sessions.changed invalidations instead of snapshot payloads', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))

      const readyPromise = waitForMessage(ws, (m) => m.type === 'ready')

      ws.send(JSON.stringify({
        type: 'hello',
        token: 'testtoken-testtoken',
        protocolVersion: WS_PROTOCOL_VERSION,
      }))

      await readyPromise

      const invalidationPromise = waitForMessage(ws, (m) => m.type === 'sessions.changed')
      wsHandler.broadcastSessionsChanged(7)

      await expect(invalidationPromise).resolves.toEqual({
        type: 'sessions.changed',
        revision: 7,
      })
      await expectNoMessage(ws, (m) => m.type === 'sessions.updated')
    } finally {
      ws.terminate()
      await new Promise<void>((resolve) => ws.on('close', () => resolve()))
    }
  })
})
