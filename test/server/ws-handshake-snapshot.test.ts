import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'

const TEST_TIMEOUT_MS = 30_000
const HOOK_TIMEOUT_MS = 30_000

vi.setConfig({ testTimeout: TEST_TIMEOUT_MS, hookTimeout: HOOK_TIMEOUT_MS })

type Snapshot = {
  settings: any
  projects: any[]
  perfLogging?: boolean
  configFallback?: { reason: string; backupExists: boolean }
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

class FakeRegistry {
  detach() {
    return true
  }
}

function waitForMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 2000): Promise<any> {
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

function collectAllMessages(
  ws: WebSocket,
  predicate: (msg: any) => boolean,
  idleTimeoutMs = 500,
  maxTimeoutMs = 5000
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const messages: any[] = []
    let idleTimeout: ReturnType<typeof setTimeout>

    const maxTimeout = setTimeout(() => {
      clearTimeout(idleTimeout)
      ws.off('message', handler)
      if (messages.length > 0) {
        resolve(messages)
      } else {
        reject(new Error('Timeout waiting for messages'))
      }
    }, maxTimeoutMs)

    const resetIdleTimeout = () => {
      clearTimeout(idleTimeout)
      idleTimeout = setTimeout(() => {
        clearTimeout(maxTimeout)
        ws.off('message', handler)
        resolve(messages)
      }, idleTimeoutMs)
    }

    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString())
      if (predicate(msg)) {
        messages.push(msg)
        resetIdleTimeout()
      }
    }

    ws.on('message', handler)
    resetIdleTimeout()
  })
}

describe('ws handshake snapshot', () => {
  let server: http.Server | undefined
  let port: number
  let snapshot: Snapshot

  beforeAll(async () => {
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = 'testtoken-testtoken'
    process.env.HELLO_TIMEOUT_MS = '100'

    const { WsHandler } = await import('../../server/ws-handler')

    snapshot = {
      settings: {
        theme: 'dark',
        uiScale: 1,
        terminal: {
          fontSize: 14,
          lineHeight: 1,
          cursorBlink: true,
          scrollback: 5000,
          theme: 'auto',
        },
        safety: {
          autoKillIdleMinutes: 180,
          warnBeforeKillMinutes: 5,
        },
        panes: {
          defaultNewPane: 'ask',
        },
        sidebar: {
          sortMode: 'activity',
          showProjectBadges: true,
          width: 288,
          collapsed: false,
        },
        codingCli: {
          enabledProviders: ['claude'],
          providers: {},
        },
      },
      projects: [
        {
          projectPath: '/tmp/demo',
          sessions: [
            {
              provider: 'claude',
              sessionId: 'sess-1',
              projectPath: '/tmp/demo',
              updatedAt: Date.now(),
            },
          ],
        },
      ],
    }

    server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })

    new (WsHandler as any)(
      server,
      new FakeRegistry() as any,
      undefined,
      undefined,
      undefined,
      async () => snapshot
    )

    const info = await listen(server)
    port = info.port
  }, HOOK_TIMEOUT_MS)

  afterAll(async () => {
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }, HOOK_TIMEOUT_MS)

  it('sends settings and sessions snapshot after ready', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const closeWs = async () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate()
      }
      await new Promise<void>((resolve) => ws.on('close', () => resolve()))
    }

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))

      const MSG_TIMEOUT = 10_000
      const readyPromise = waitForMessage(ws, (m) => m.type === 'ready', MSG_TIMEOUT)
      const settingsPromise = waitForMessage(ws, (m) => m.type === 'settings.updated', MSG_TIMEOUT)
      const sessionsPromise = waitForMessage(ws, (m) => m.type === 'sessions.updated', MSG_TIMEOUT)

      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))

      await readyPromise

      const settingsMsg = await settingsPromise
      const sessionsMsg = await sessionsPromise

      expect(settingsMsg.settings).toEqual(snapshot.settings)
      expect(sessionsMsg.projects).toEqual(snapshot.projects)
    } finally {
      await closeWs()
    }
  })

  it('sends config fallback snapshot payload when available', async () => {
    snapshot = {
      ...snapshot,
      configFallback: {
        reason: 'PARSE_ERROR',
        backupExists: true,
      },
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

      const MSG_TIMEOUT = 10_000
      const readyPromise = waitForMessage(ws, (m) => m.type === 'ready', MSG_TIMEOUT)
      const fallbackPromise = waitForMessage(ws, (m) => m.type === 'config.fallback', MSG_TIMEOUT)

      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))

      await readyPromise
      const fallbackMsg = await fallbackPromise
      expect(fallbackMsg).toEqual({
        type: 'config.fallback',
        reason: 'PARSE_ERROR',
        backupExists: true,
      })
    } finally {
      await closeWs()
    }
  })
})

describe('ws handshake snapshot with chunking', () => {
  let server: http.Server | undefined
  let port: number
  let largeSnapshot: Snapshot

  beforeAll(async () => {
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = 'testtoken-testtoken'
    process.env.HELLO_TIMEOUT_MS = '100'
    // Set a very small chunk size to force multiple chunks
    process.env.MAX_WS_CHUNK_BYTES = '500'

    // Need to re-import WsHandler to pick up the new env var
    vi.resetModules()
    const { WsHandler } = await import('../../server/ws-handler')

    // Create many projects to force chunking
    const projects = Array.from({ length: 20 }, (_, i) => ({
      projectPath: `/tmp/project-${i}`,
      sessions: Array.from({ length: 5 }, (_, j) => ({
        provider: 'claude' as const,
        sessionId: `sess-${i}-${j}`,
        projectPath: `/tmp/project-${i}`,
        updatedAt: Date.now(),
      })),
    }))

    largeSnapshot = {
      settings: { theme: 'dark' },
      projects,
    }

    server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })

    new (WsHandler as any)(
      server,
      new FakeRegistry() as any,
      undefined,
      undefined,
      undefined,
      async () => largeSnapshot
    )

    const info = await listen(server)
    port = info.port
  }, HOOK_TIMEOUT_MS)

  afterAll(async () => {
    delete process.env.MAX_WS_CHUNK_BYTES
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }, HOOK_TIMEOUT_MS)

  it('sends chunked sessions with clear/append flags for large data', async () => {
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
      // Collect all sessions.updated messages (wait for idle to detect end of stream)
      const sessionsPromise = collectAllMessages(ws, (m) => m.type === 'sessions.updated', 500, 5000)

      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))

      await readyPromise

      const sessionsMsgs = await sessionsPromise

      // Verify we got multiple chunks
      expect(sessionsMsgs.length).toBeGreaterThanOrEqual(2)

      // First chunk should have clear: true
      expect(sessionsMsgs[0].clear).toBe(true)
      expect(sessionsMsgs[0].append).toBeUndefined()

      // Subsequent chunks should have append: true
      for (let i = 1; i < sessionsMsgs.length; i++) {
        expect(sessionsMsgs[i].append).toBe(true)
        expect(sessionsMsgs[i].clear).toBeUndefined()
      }

      // Verify all projects are included across chunks
      const allProjects = sessionsMsgs.flatMap((m) => m.projects)
      expect(allProjects.length).toBe(largeSnapshot.projects.length)
    } finally {
      await closeWs()
    }
  })
})
