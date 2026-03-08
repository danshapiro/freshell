import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import { WS_PROTOCOL_VERSION } from '../../shared/ws-protocol'

const TEST_TIMEOUT_MS = 30_000
const HOOK_TIMEOUT_MS = 30_000

vi.setConfig({ testTimeout: TEST_TIMEOUT_MS, hookTimeout: HOOK_TIMEOUT_MS })

type Snapshot = {
  settings: any
  projects: any[]
}

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
      if (predicate(msg)) {
        clearTimeout(timeout)
        ws.off('message', handler)
        resolve(msg)
      }
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

function flattenSessions(projects: Array<{ sessions?: Array<{ sessionId: string }> }>): string[] {
  return projects.flatMap((project) => (project.sessions || []).map((session) => session.sessionId))
}

describe('ws sidebar snapshot refresh', () => {
  let server: http.Server | undefined
  let port: number
  let snapshot: Snapshot
  let wsHandler: any

  beforeAll(async () => {
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = 'testtoken-testtoken'
    process.env.HELLO_TIMEOUT_MS = '100'
    delete process.env.MAX_WS_CHUNK_BYTES

    vi.resetModules()
    const { WsHandler } = await import('../../server/ws-handler')
    const { LayoutStore } = await import('../../server/agent-api/layout-store')

    snapshot = {
      settings: { theme: 'dark' },
      projects: [],
    }

    server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })

    wsHandler = new (WsHandler as any)(
      server,
      new FakeRegistry() as any,
      undefined,
      undefined,
      undefined,
      async () => snapshot,
      undefined,
      undefined,
      'srv-local',
      new (LayoutStore as any)(),
    )

    const info = await listen(server)
    port = info.port
  }, HOOK_TIMEOUT_MS)

  afterAll(async () => {
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }, HOOK_TIMEOUT_MS)

  it('refreshes and preserves personalized sidebar snapshots when ui.layout.sync changes the local open-session keys', async () => {
    const targetSessionId = 'older-open'
    const foreignSessionId = 'older-foreign'

    snapshot = {
      settings: { theme: 'dark' },
      projects: [{
        projectPath: '/demo',
        sessions: [
          ...Array.from({ length: 100 }, (_, index) => ({
            provider: 'claude',
            sessionId: `new-${index}`,
            projectPath: '/demo',
            updatedAt: 10_000 - index,
          })),
          {
            provider: 'claude',
            sessionId: targetSessionId,
            projectPath: '/demo',
            updatedAt: 10,
          },
          {
            provider: 'claude',
            sessionId: foreignSessionId,
            projectPath: '/demo',
            updatedAt: 9,
          },
        ],
      }],
    }

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const closeWs = async () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate()
      }
      await new Promise<void>((resolve) => ws.on('close', () => resolve()))
    }

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))

      const readyPromise = waitForMessage(ws, (m) => m.type === 'ready')
      const initialSessionsPromise = waitForMessage(ws, (m) => m.type === 'sessions.updated')

      ws.send(JSON.stringify({
        type: 'hello',
        token: 'testtoken-testtoken',
        protocolVersion: WS_PROTOCOL_VERSION,
        capabilities: {
          sessionsPaginationV1: true,
        },
      }))

      await readyPromise
      const initialSessions = await initialSessionsPromise
      const initialIds = flattenSessions(initialSessions.projects)
      expect(initialIds).not.toContain(targetSessionId)
      expect(initialIds).not.toContain(foreignSessionId)

      const refreshPromise = waitForMessage(
        ws,
        (m) => m.type === 'sessions.updated' && flattenSessions(m.projects).includes(targetSessionId),
      )

      ws.send(JSON.stringify({
        type: 'ui.layout.sync',
        tabs: [
          { id: 'tab-layout', title: 'layout local' },
          {
            id: 'tab-no-layout',
            title: 'no layout local',
            fallbackSessionRef: { provider: 'claude', sessionId: targetSessionId },
          },
          { id: 'tab-foreign', title: 'foreign copy' },
        ],
        activeTabId: 'tab-no-layout',
        layouts: {
          'tab-layout': {
            type: 'leaf',
            id: 'pane-layout',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-layout',
              status: 'running',
              resumeSessionId: targetSessionId,
              sessionRef: {
                provider: 'claude',
                sessionId: targetSessionId,
                serverInstanceId: 'srv-local',
              },
            },
          },
          'tab-foreign': {
            type: 'leaf',
            id: 'pane-foreign',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-foreign',
              status: 'running',
              sessionRef: {
                provider: 'claude',
                sessionId: foreignSessionId,
                serverInstanceId: 'srv-remote',
              },
            },
          },
        },
        activePane: {
          'tab-layout': 'pane-layout',
          'tab-foreign': 'pane-foreign',
        },
        paneTitles: {},
        timestamp: Date.now(),
      }))

      const refreshedSessions = await refreshPromise
      const refreshedIds = flattenSessions(refreshedSessions.projects)
      expect(refreshedIds).toContain(targetSessionId)
      expect(refreshedIds.filter((sessionId) => sessionId === targetSessionId)).toHaveLength(1)
      expect(refreshedIds).not.toContain(foreignSessionId)
      expect(refreshedSessions.hasMore).toBe(true)

      ws.send(JSON.stringify({
        type: 'ui.layout.sync',
        tabs: [
          { id: 'tab-layout', title: 'layout local' },
          {
            id: 'tab-no-layout',
            title: 'no layout local',
            fallbackSessionRef: { provider: 'claude', sessionId: targetSessionId },
          },
          { id: 'tab-foreign', title: 'foreign copy' },
        ],
        activeTabId: 'tab-no-layout',
        layouts: {
          'tab-layout': {
            type: 'leaf',
            id: 'pane-layout',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-layout',
              status: 'running',
              resumeSessionId: targetSessionId,
              sessionRef: {
                provider: 'claude',
                sessionId: targetSessionId,
                serverInstanceId: 'srv-local',
              },
            },
          },
          'tab-foreign': {
            type: 'leaf',
            id: 'pane-foreign',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-foreign',
              status: 'running',
              sessionRef: {
                provider: 'claude',
                sessionId: foreignSessionId,
                serverInstanceId: 'srv-remote',
              },
            },
          },
        },
        activePane: {
          'tab-layout': 'pane-layout',
          'tab-foreign': 'pane-foreign',
        },
        paneTitles: {},
        timestamp: Date.now(),
      }))

      await expectNoMessage(ws, (m) => m.type === 'sessions.updated')

      const broadcastPromise = waitForMessage(
        ws,
        (m) => m.type === 'sessions.updated' && flattenSessions(m.projects).includes(targetSessionId),
      )
      wsHandler.broadcastSessionsUpdated(snapshot.projects)

      const broadcastedSessions = await broadcastPromise
      const broadcastedIds = flattenSessions(broadcastedSessions.projects)
      expect(broadcastedIds).toContain(targetSessionId)
      expect(broadcastedIds).not.toContain(foreignSessionId)
    } finally {
      await closeWs()
    }
  })

  it('normalizes agent-chat resumeSessionId to claude when refreshing personalized sidebar snapshots', async () => {
    const targetSessionId = '550e8400-e29b-41d4-a716-446655440000'

    snapshot = {
      settings: { theme: 'dark' },
      projects: [{
        projectPath: '/claude',
        sessions: [
          ...Array.from({ length: 100 }, (_, index) => ({
            provider: 'claude',
            sessionId: `newer-${index}`,
            projectPath: '/claude',
            updatedAt: 20_000 - index,
          })),
          {
            provider: 'claude',
            sessionId: targetSessionId,
            projectPath: '/claude',
            updatedAt: 1,
          },
        ],
      }],
    }

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const closeWs = async () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate()
      }
      await new Promise<void>((resolve) => ws.on('close', () => resolve()))
    }

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))

      const readyPromise = waitForMessage(ws, (m) => m.type === 'ready')
      const initialSessionsPromise = waitForMessage(ws, (m) => m.type === 'sessions.updated')

      ws.send(JSON.stringify({
        type: 'hello',
        token: 'testtoken-testtoken',
        protocolVersion: WS_PROTOCOL_VERSION,
        capabilities: {
          sessionsPaginationV1: true,
        },
      }))

      await readyPromise
      const initialSessions = await initialSessionsPromise
      expect(flattenSessions(initialSessions.projects)).not.toContain(targetSessionId)

      const refreshPromise = waitForMessage(
        ws,
        (m) => m.type === 'sessions.updated' && flattenSessions(m.projects).includes(targetSessionId),
      )

      ws.send(JSON.stringify({
        type: 'ui.layout.sync',
        tabs: [{ id: 'tab-agent', title: 'agent chat' }],
        activeTabId: 'tab-agent',
        layouts: {
          'tab-agent': {
            type: 'leaf',
            id: 'pane-agent',
            content: {
              kind: 'agent-chat',
              provider: 'freshclaude',
              createRequestId: 'req-agent',
              status: 'connected',
              resumeSessionId: targetSessionId,
            },
          },
        },
        activePane: {
          'tab-agent': 'pane-agent',
        },
        paneTitles: {},
        timestamp: Date.now(),
      }))

      const refreshedSessions = await refreshPromise
      expect(flattenSessions(refreshedSessions.projects)).toContain(targetSessionId)
      expect(refreshedSessions.hasMore).toBe(false)
    } finally {
      await closeWs()
    }
  })
})
