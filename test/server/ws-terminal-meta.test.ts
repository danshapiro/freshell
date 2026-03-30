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

describe('ws terminal metadata protocol', () => {
  let server: http.Server
  let port: number
  let wsHandler: any
  const sampleMeta = [{
    terminalId: 'term-1',
    cwd: '/workspace/repo/src',
    checkoutRoot: '/workspace/repo',
    repoRoot: '/workspace',
    displaySubdir: 'repo',
    branch: 'main',
    isDirty: true,
    provider: 'codex',
    sessionId: 'session-1',
    tokenUsage: {
      inputTokens: 20,
      outputTokens: 10,
      cachedTokens: 5,
      totalTokens: 35,
      contextTokens: 35,
      compactThresholdTokens: 140,
      compactPercent: 25,
    },
    updatedAt: 1234,
  }]

  beforeAll(async () => {
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = 'terminal-meta-token'

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
      () => sampleMeta as any,
    )
    port = await listen(server)
  })

  afterAll(async () => {
    wsHandler?.close?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('broadcasts terminals.changed revision invalidations', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'terminal-meta-token', protocolVersion: WS_PROTOCOL_VERSION }))
    await waitForMessage(ws, (msg) => msg.type === 'ready')

    wsHandler.broadcastTerminalsChanged()

    const changed = await waitForMessage(ws, (msg) => msg.type === 'terminals.changed')
    expect(changed).toEqual({
      type: 'terminals.changed',
      revision: 1,
    })
    ws.close()
  })

})
