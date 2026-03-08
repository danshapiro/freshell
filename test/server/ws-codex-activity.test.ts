import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import { WS_PROTOCOL_VERSION } from '../../shared/ws-protocol'

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

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind test server'))
        return
      }
      resolve(address.port)
    })
  })
}

function waitForMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error('Timed out waiting for websocket message'))
    }, timeoutMs)

    const onMessage = (raw: WebSocket.Data) => {
      const msg = JSON.parse(raw.toString())
      if (!predicate(msg)) return
      clearTimeout(timeout)
      ws.off('message', onMessage)
      resolve(msg)
    }

    ws.on('message', onMessage)
  })
}

function expectNoMatchingMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 250): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage)
      resolve()
    }, timeoutMs)

    const onMessage = (raw: WebSocket.Data) => {
      const msg = JSON.parse(raw.toString())
      if (!predicate(msg)) return
      clearTimeout(timeout)
      ws.off('message', onMessage)
      reject(new Error(`Unexpected websocket message: ${JSON.stringify(msg)}`))
    }

    ws.on('message', onMessage)
  })
}

class FakeRegistry {
  list() {
    return []
  }
  get() { return null }
  create() { throw new Error('not used') }
  attach() { return null }
  finishAttachSnapshot() {}
  detach() { return false }
  input() { return false }
  resize() { return false }
  kill() { return false }
  findRunningClaudeTerminalBySession() { return undefined }
}

describe('ws codex activity protocol', () => {
  let server: http.Server
  let port: number
  let wsHandler: any
  const sampleActivity = [{
    terminalId: 'term-1',
    sessionId: 'session-1',
    phase: 'busy',
    updatedAt: 1234,
  }]

  beforeAll(async () => {
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = 'codex-activity-token'

    const { WsHandler } = await import('../../server/ws-handler')
    server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    wsHandler = new WsHandler(
      server,
      new FakeRegistry() as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => sampleActivity as any,
    )
    port = await listen(server)
  })

  afterAll(async () => {
    wsHandler?.close?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('returns codex.activity.list.response for codex.activity.list requests', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'codex-activity-token', protocolVersion: WS_PROTOCOL_VERSION }))
    await waitForMessage(ws, (msg) => msg.type === 'ready')

    ws.send(JSON.stringify({ type: 'codex.activity.list', requestId: 'req-codex-1' }))
    const response = await waitForMessage(
      ws,
      (msg) => msg.type === 'codex.activity.list.response' && msg.requestId === 'req-codex-1',
    )

    expect(response.terminals).toEqual(sampleActivity)
    ws.close()
  })

  it('broadcasts codex.activity.updated payloads', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'codex-activity-token', protocolVersion: WS_PROTOCOL_VERSION }))
    await waitForMessage(ws, (msg) => msg.type === 'ready')

    wsHandler.broadcastCodexActivityUpdated({
      upsert: sampleActivity as any,
      remove: [],
    })

    const updated = await waitForMessage(ws, (msg) => msg.type === 'codex.activity.updated')
    expect(updated).toEqual({
      type: 'codex.activity.updated',
      upsert: sampleActivity,
      remove: [],
    })
    ws.close()
  })

  it('does not broadcast codex.activity.updated payloads to unauthenticated sockets', async () => {
    const authenticated = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const unauthenticated = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    await Promise.all([
      new Promise<void>((resolve) => authenticated.on('open', () => resolve())),
      new Promise<void>((resolve) => unauthenticated.on('open', () => resolve())),
    ])

    authenticated.send(JSON.stringify({ type: 'hello', token: 'codex-activity-token', protocolVersion: WS_PROTOCOL_VERSION }))
    await waitForMessage(authenticated, (msg) => msg.type === 'ready')

    wsHandler.broadcastCodexActivityUpdated({
      upsert: sampleActivity as any,
      remove: [],
    })

    const updated = await waitForMessage(authenticated, (msg) => msg.type === 'codex.activity.updated')
    expect(updated).toEqual({
      type: 'codex.activity.updated',
      upsert: sampleActivity,
      remove: [],
    })

    await expect(expectNoMatchingMessage(unauthenticated, (msg) => msg.type === 'codex.activity.updated')).resolves.toBeUndefined()

    authenticated.close()
    unauthenticated.close()
  })
})
