import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import { WS_PROTOCOL_VERSION } from '../../shared/ws-protocol'
import { ClaudeActivityTracker } from '../../server/coding-cli/claude-activity-tracker.js'
import {
  TrulyIdleEmitter,
  wireTrulyIdleEmitter,
  type TrulyIdleEvent,
} from '../../server/coding-cli/truly-idle-emitter.js'

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

const GRACE_MS = 100

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

function expectNoMatchingMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 400): Promise<void> {
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
  list() { return [] }
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

describe('ws terminal.idle (server-authoritative truly-idle edge)', () => {
  let server: http.Server
  let port: number
  let wsHandler: any

  beforeAll(async () => {
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = 'terminal-idle-token'
    const { WsHandler } = await import('../../server/ws-handler')
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    wsHandler = new WsHandler(server, new FakeRegistry() as any, {})
    port = await listen(server)
  })

  afterAll(async () => {
    wsHandler?.close?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  async function connectClient(): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'terminal-idle-token', protocolVersion: WS_PROTOCOL_VERSION }))
    await waitForMessage(ws, (msg) => msg.type === 'ready')
    return ws
  }

  it('broadcasts one terminal.idle after a quiet grace window, wired exactly like server/index.ts', async () => {
    const tracker = new ClaudeActivityTracker()
    const trulyIdle = new TrulyIdleEmitter({ graceMs: GRACE_MS })
    const wiring = wireTrulyIdleEmitter({ tracker, emitter: trulyIdle })
    const onIdle = (event: TrulyIdleEvent) => {
      wsHandler.broadcastTerminalIdle(event)
    }
    trulyIdle.on('idle', onIdle)

    const client = await connectClient()
    const idles: any[] = []
    client.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'terminal.idle') idles.push(msg)
    })

    const before = Date.now()
    tracker.trackTerminal({ terminalId: 't1', at: before })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: before })   // submit -> busy
    tracker.noteOutput({ terminalId: 't1', data: '\x07', at: before + 10 }) // Stop BEL -> idle + turn.complete

    const idle = await waitForMessage(client, (msg) => msg.type === 'terminal.idle' && msg.terminalId === 't1')
    expect(idle).toEqual({
      type: 'terminal.idle',
      terminalId: 't1',
      at: expect.any(Number),
      reason: 'grace',
    })
    expect(idle.at).toBeGreaterThanOrEqual(before + GRACE_MS)
    expect(idles).toHaveLength(1)

    trulyIdle.off('idle', onIdle)
    wiring.dispose()
    client.close()
  })

  it('does not broadcast terminal.idle when the terminal exits inside the grace window', async () => {
    const tracker = new ClaudeActivityTracker()
    const trulyIdle = new TrulyIdleEmitter({ graceMs: GRACE_MS })
    const wiring = wireTrulyIdleEmitter({ tracker, emitter: trulyIdle })
    const onIdle = (event: TrulyIdleEvent) => {
      wsHandler.broadcastTerminalIdle(event)
    }
    trulyIdle.on('idle', onIdle)

    const client = await connectClient()

    const at = Date.now()
    tracker.trackTerminal({ terminalId: 't2', at })
    tracker.noteInput({ terminalId: 't2', data: '\r', at })
    tracker.noteOutput({ terminalId: 't2', data: '\x07', at: at + 10 })
    tracker.noteExit({ terminalId: 't2' }) // crash/exit inside the grace window

    await expect(
      expectNoMatchingMessage(client, (msg) => msg.type === 'terminal.idle' && msg.terminalId === 't2'),
    ).resolves.toBeUndefined()

    trulyIdle.off('idle', onIdle)
    wiring.dispose()
    client.close()
  })
})
