import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import { WS_PROTOCOL_VERSION } from '../../shared/ws-protocol'
import { defaultSettings } from '../../server/config-store'

const TEST_TIMEOUT_MS = 30_000
const HOOK_TIMEOUT_MS = 30_000

vi.setConfig({ testTimeout: TEST_TIMEOUT_MS, hookTimeout: HOOK_TIMEOUT_MS })

type Snapshot = {
  settings: any
  projects: any[]
  perfLogging?: boolean
  configFallback?: { reason: string; backupExists: boolean }
  legacyLocalSettingsSeed?: unknown
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
  private terminals: any[] = []

  detach() {
    return true
  }
  list() {
    return [...this.terminals]
  }

  setTerminals(terminals: any[]) {
    this.terminals = [...terminals]
  }
}

function waitForMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      ws.off('message', handler)
      ws.off('close', onClose)
      ws.off('error', onError)
    }

    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Timeout waiting for message'))
    }, timeoutMs)

    const handler = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (predicate(msg)) {
          cleanup()
          resolve(msg)
        }
      } catch {
        // Ignore malformed frames in tests.
      }
    }

    const onClose = () => {
      cleanup()
      reject(new Error('Socket closed waiting for message'))
    }

    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }

    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      onClose()
      return
    }

    ws.on('message', handler)
    ws.once('close', onClose)
    ws.once('error', onError)
  })
}

function expectNoMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 300): Promise<void> {
  return new Promise((resolve, reject) => {
    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString())
      if (!predicate(msg)) return
      cleanup()
      reject(new Error(`Unexpected message: ${JSON.stringify(msg)}`))
    }

    const cleanup = () => {
      clearTimeout(timeout)
      ws.off('message', handler)
    }

    const timeout = setTimeout(() => {
      cleanup()
      resolve()
    }, timeoutMs)

    ws.on('message', handler)
  })
}

async function closeWs(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return

  const closed = new Promise<void>((resolve) => {
    ws.once('close', () => resolve())
  })

  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.terminate()
  }

  await closed
}

function waitForReady(ws: WebSocket, timeoutMs = 10_000): Promise<any> {
  const readyPromise = waitForMessage(ws, (m) => m.type === 'ready', timeoutMs)
  ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
  return readyPromise
}

describe('ws handshake snapshot', () => {
  let server: http.Server | undefined
  let port: number
  let snapshot: Snapshot
  let registry: FakeRegistry
  let originalNodeEnv: string | undefined
  let originalAuthToken: string | undefined
  let originalHelloTimeoutMs: string | undefined

  beforeEach(async () => {
    originalNodeEnv = process.env.NODE_ENV
    originalAuthToken = process.env.AUTH_TOKEN
    originalHelloTimeoutMs = process.env.HELLO_TIMEOUT_MS
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = 'testtoken-testtoken'
    process.env.HELLO_TIMEOUT_MS = '500'

    vi.resetModules()
    const { WsHandler } = await import('../../server/ws-handler')

    snapshot = {
      settings: {
        ...defaultSettings,
        codingCli: {
          enabledProviders: ['claude'],
          providers: defaultSettings.codingCli.providers,
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
              lastActivityAt: Date.now(),
            },
          ],
        },
      ],
    }

    server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })

    registry = new FakeRegistry()

    new (WsHandler as any)(server, registry as any, {
      handshakeSnapshotProvider: async () => snapshot,
    })

    const info = await listen(server)
    port = info.port
  }, HOOK_TIMEOUT_MS)

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      server = undefined
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = originalNodeEnv
    }
    if (originalAuthToken === undefined) {
      delete process.env.AUTH_TOKEN
    } else {
      process.env.AUTH_TOKEN = originalAuthToken
    }
    if (originalHelloTimeoutMs === undefined) {
      delete process.env.HELLO_TIMEOUT_MS
    } else {
      process.env.HELLO_TIMEOUT_MS = originalHelloTimeoutMs
    }
  }, HOOK_TIMEOUT_MS)

  it('sends settings after ready without a websocket sessions snapshot', async () => {
    snapshot = {
      ...snapshot,
      legacyLocalSettingsSeed: {
        theme: 'dark',
      },
    }
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))

      const MSG_TIMEOUT = 10_000
      const settingsPromise = waitForMessage(ws, (m) => m.type === 'settings.updated', MSG_TIMEOUT)

      await waitForReady(ws, MSG_TIMEOUT)

      const settingsMsg = await settingsPromise

      expect(settingsMsg.settings).toEqual(snapshot.settings)
      expect(settingsMsg.settings).not.toHaveProperty('theme')
      expect(settingsMsg).not.toHaveProperty('legacyLocalSettingsSeed')
      await expectNoMessage(ws, (m) => Object.prototype.hasOwnProperty.call(m, 'legacyLocalSettingsSeed'))
      await expectNoMessage(ws, (m) => m.type === 'sessions.updated')
    } finally {
      await closeWs(ws)
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

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))

      const MSG_TIMEOUT = 10_000
      const fallbackPromise = waitForMessage(ws, (m) => m.type === 'config.fallback', MSG_TIMEOUT)

      await waitForReady(ws, MSG_TIMEOUT)
      const fallbackMsg = await fallbackPromise
      expect(fallbackMsg).toEqual({
        type: 'config.fallback',
        reason: 'PARSE_ERROR',
        backupExists: true,
      })
    } finally {
      await closeWs(ws)
    }
  })

  it('includes a bootId in the ready message that differs from serverInstanceId', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))

      const readyMsg = await waitForReady(ws, 10_000)
      expect(readyMsg).toHaveProperty('bootId')
      expect(typeof readyMsg.bootId).toBe('string')
      expect(readyMsg.bootId.length).toBeGreaterThan(0)
      // bootId should be different from serverInstanceId (boot is ephemeral, instance is persistent)
      expect(readyMsg.bootId).not.toBe(readyMsg.serverInstanceId)
    } finally {
      await closeWs(ws)
    }
  })

  it('sends the same bootId to multiple clients within the same process', async () => {
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await Promise.all([
        new Promise<void>((resolve) => ws1.on('open', () => resolve())),
        new Promise<void>((resolve) => ws2.on('open', () => resolve())),
      ])

      const [ready1, ready2] = await Promise.all([
        waitForReady(ws1, 10_000),
        waitForReady(ws2, 10_000),
      ])

      expect(ready1.bootId).toBe(ready2.bootId)
    } finally {
      await closeWs(ws1)
      await closeWs(ws2)
    }
  })

  it('sends terminal inventory in handshake snapshot', async () => {
    registry.setTerminals([
      {
        terminalId: 'term-inventory-1',
        title: 'Claude CLI',
        mode: 'claude',
        resumeSessionId: '550e8400-e29b-41d4-a716-446655440000',
        createdAt: 1,
        lastActivityAt: 2,
        status: 'running',
      },
    ])

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))

      const inventoryPromise = waitForMessage(ws, (m) => m.type === 'terminal.inventory', 10_000)
      await waitForReady(ws, 10_000)

      const inventory = await inventoryPromise
      expect(inventory).toHaveProperty('type', 'terminal.inventory')
      expect(inventory).toHaveProperty('bootId')
      expect(Array.isArray(inventory.terminals)).toBe(true)
      expect(Array.isArray(inventory.terminalMeta)).toBe(true)
      expect(inventory.terminals).toContainEqual(expect.objectContaining({
        terminalId: 'term-inventory-1',
        sessionRef: {
          provider: 'claude',
          sessionId: '550e8400-e29b-41d4-a716-446655440000',
        },
      }))
      expect(inventory.terminals[0]).not.toHaveProperty('resumeSessionId')
    } finally {
      await closeWs(ws)
    }
  })

  it('still omits websocket sessions payloads when no projects exist', async () => {
    snapshot = {
      ...snapshot,
      projects: [],
    }

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))

      await waitForReady(ws, 10_000)
      await expectNoMessage(ws, (m) => m.type === 'sessions.updated')
    } finally {
      await closeWs(ws)
    }
  })
})
