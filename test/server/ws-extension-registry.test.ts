import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import { WS_PROTOCOL_VERSION } from '../../shared/ws-protocol'

const TEST_TIMEOUT_MS = 30_000
const HOOK_TIMEOUT_MS = 30_000

vi.setConfig({ testTimeout: TEST_TIMEOUT_MS, hookTimeout: HOOK_TIMEOUT_MS })

// Mock the config-store module before importing ws-handler
vi.mock('../../server/config-store', () => ({
  configStore: {
    snapshot: vi.fn().mockResolvedValue({
      version: 1,
      settings: {},
      sessionOverrides: {},
      terminalOverrides: {},
      projectColors: {},
    }),
  },
}))

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

function waitForMessage(
  ws: WebSocket,
  predicate: (msg: any) => boolean,
  timeoutMs = 2000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage)
      ws.off('close', onClose)
      reject(new Error('Timed out waiting for expected WebSocket message'))
    }, timeoutMs)

    const onClose = (code: number, reason: Buffer) => {
      clearTimeout(timeout)
      ws.off('message', onMessage)
      ws.off('close', onClose)
      reject(new Error(`WebSocket closed before expected message (code ${code}, reason ${reason.toString()})`))
    }

    const onMessage = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString())
      if (!predicate(msg)) return
      clearTimeout(timeout)
      ws.off('message', onMessage)
      ws.off('close', onClose)
      resolve(msg)
    }

    ws.on('message', onMessage)
    ws.on('close', onClose)
  })
}

class FakeRegistry {
  detach() { return true }
}

const fakeExtensions = [
  {
    name: 'test-ext',
    version: '1.0.0',
    label: 'Test Extension',
    description: 'A test extension',
    category: 'client' as const,
    iconUrl: '/api/extensions/test-ext/icon',
  },
  {
    name: 'server-ext',
    version: '2.0.0',
    label: 'Server Extension',
    description: 'A server extension',
    category: 'server' as const,
    serverRunning: true,
    serverPort: 9999,
  },
]

class FakeExtensionManager {
  toClientRegistry() {
    return fakeExtensions
  }
}

describe('ws extension registry', () => {
  let server: http.Server | undefined
  let port: number

  beforeAll(async () => {
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = 'testtoken-testtoken'
    process.env.HELLO_TIMEOUT_MS = '100'

    const { WsHandler } = await import('../../server/ws-handler')

    server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })

    new (WsHandler as any)(
      server,
      new FakeRegistry() as any,
      undefined, // codingCliManager
      undefined, // sdkBridge
      undefined, // sessionRepairService
      undefined, // handshakeSnapshotProvider
      undefined, // terminalMetaListProvider
      undefined, // tabsRegistryStore
      undefined, // serverInstanceId
      undefined, // layoutStore
      new FakeExtensionManager() as any, // extensionManager
    )

    const info = await listen(server)
    port = info.port
  }, HOOK_TIMEOUT_MS)

  afterAll(async () => {
    if (!server) return
    await new Promise<void>((resolve) => server!.close(() => resolve()))
  }, HOOK_TIMEOUT_MS)

  it('sends extensions.registry message after ready on hello', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))

      const MSG_TIMEOUT = 10_000
      const readyPromise = waitForMessage(ws, (m) => m.type === 'ready', MSG_TIMEOUT)
      const registryPromise = waitForMessage(ws, (m) => m.type === 'extensions.registry', MSG_TIMEOUT)

      ws.send(JSON.stringify({
        type: 'hello',
        token: 'testtoken-testtoken',
        protocolVersion: WS_PROTOCOL_VERSION,
      }))

      await readyPromise
      const registryMsg = await registryPromise

      expect(registryMsg.type).toBe('extensions.registry')
      expect(registryMsg.extensions).toEqual(fakeExtensions)
      expect(registryMsg.extensions).toHaveLength(2)
      expect(registryMsg.extensions[0].name).toBe('test-ext')
      expect(registryMsg.extensions[1].name).toBe('server-ext')
      expect(registryMsg.extensions[1].serverRunning).toBe(true)
      expect(registryMsg.extensions[1].serverPort).toBe(9999)
    } finally {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate()
      }
      await new Promise<void>((resolve) => ws.on('close', () => resolve()))
    }
  })
})

describe('ws extension registry (no extension manager)', () => {
  let server: http.Server | undefined
  let port: number

  beforeAll(async () => {
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = 'testtoken-testtoken'
    process.env.HELLO_TIMEOUT_MS = '100'

    const { WsHandler } = await import('../../server/ws-handler')

    server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })

    // No extensionManager passed — should still work without error
    new (WsHandler as any)(
      server,
      new FakeRegistry() as any,
    )

    const info = await listen(server)
    port = info.port
  }, HOOK_TIMEOUT_MS)

  afterAll(async () => {
    if (!server) return
    await new Promise<void>((resolve) => server!.close(() => resolve()))
  }, HOOK_TIMEOUT_MS)

  it('does not send extensions.registry when extensionManager is not provided', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const received: any[] = []

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))

      // Collect all messages
      ws.on('message', (data) => {
        received.push(JSON.parse(data.toString()))
      })

      ws.send(JSON.stringify({
        type: 'hello',
        token: 'testtoken-testtoken',
        protocolVersion: WS_PROTOCOL_VERSION,
      }))

      // Wait for ready message
      await waitForMessage(ws, (m) => m.type === 'ready', 10_000)

      // Give a small window for any additional messages
      await new Promise((resolve) => setTimeout(resolve, 200))

      const extensionMessages = received.filter((m) => m.type === 'extensions.registry')
      expect(extensionMessages).toHaveLength(0)
    } finally {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate()
      }
      await new Promise<void>((resolve) => ws.on('close', () => resolve()))
    }
  })
})
