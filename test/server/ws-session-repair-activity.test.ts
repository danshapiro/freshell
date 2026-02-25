import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import { EventEmitter } from 'events'
import { WS_PROTOCOL_VERSION } from '../../shared/ws-protocol'

const TEST_TIMEOUT_MS = 30_000
const HOOK_TIMEOUT_MS = 30_000

vi.setConfig({
  testTimeout: TEST_TIMEOUT_MS,
  hookTimeout: HOOK_TIMEOUT_MS,
})

class FakeRegistry {
  list() {
    return []
  }
}

class FakeSessionRepairService extends EventEmitter {
  prioritizeSessions() {}
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

describe('ws session repair activity', () => {
  let server: http.Server | undefined
  let port: number
  let sessionRepairService: FakeSessionRepairService

  beforeAll(async () => {
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = 'testtoken-testtoken'

    const { WsHandler } = await import('../../server/ws-handler')
    server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })

    sessionRepairService = new FakeSessionRepairService()
    const registry = new FakeRegistry()

    new WsHandler(server, registry as any, undefined, undefined, sessionRepairService as any)
    const info = await listen(server)
    port = info.port
  }, HOOK_TIMEOUT_MS)

  afterAll(async () => {
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }, HOOK_TIMEOUT_MS)

  it('broadcasts session repair activity on scan events', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))

    await new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'ready') resolve()
      })
    })

    const activityPromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'session.repair.activity') resolve(msg)
      })
    })

    sessionRepairService.emit('scanned', {
      sessionId: 'scan-1',
      filePath: '/tmp/scan-1.jsonl',
      status: 'corrupted',
      chainDepth: 1,
      orphanCount: 2,
      fileSize: 10,
      messageCount: 3,
    })

    const activity = await activityPromise

    expect(activity.event).toBe('scanned')
    expect(activity.sessionId).toBe('scan-1')
    expect(activity.status).toBe('corrupted')

    ws.close()
  })
})
