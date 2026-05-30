import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import { WS_PROTOCOL_VERSION } from '../../shared/ws-protocol'
import { ClaudeActivityTracker } from '../../server/coding-cli/claude-activity-tracker.js'

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

describe('ws claude activity protocol', () => {
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
    process.env.AUTH_TOKEN = 'claude-activity-token'

    const { WsHandler } = await import('../../server/ws-handler')
    server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    wsHandler = new WsHandler(
      server,
      new FakeRegistry() as any,
      { claudeActivityListProvider: () => sampleActivity as any },
    )
    port = await listen(server)
  })

  afterAll(async () => {
    wsHandler?.close?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('returns claude.activity.list.response for claude.activity.list requests', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'claude-activity-token', protocolVersion: WS_PROTOCOL_VERSION }))
    await waitForMessage(ws, (msg) => msg.type === 'ready')

    ws.send(JSON.stringify({ type: 'claude.activity.list', requestId: 'req-claude-1' }))
    const response = await waitForMessage(
      ws,
      (msg) => msg.type === 'claude.activity.list.response' && msg.requestId === 'req-claude-1',
    )

    expect(response.terminals).toEqual(sampleActivity)
    ws.close()
  })

  it('broadcasts claude.activity.updated payloads', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'claude-activity-token', protocolVersion: WS_PROTOCOL_VERSION }))
    await waitForMessage(ws, (msg) => msg.type === 'ready')

    wsHandler.broadcastClaudeActivityUpdated({
      upsert: sampleActivity as any,
      remove: [],
    })

    const updated = await waitForMessage(ws, (msg) => msg.type === 'claude.activity.updated')
    expect(updated).toEqual({
      type: 'claude.activity.updated',
      upsert: sampleActivity,
      remove: [],
    })
    ws.close()
  })

  it('does not broadcast claude.activity.updated payloads to unauthenticated sockets', async () => {
    const authenticated = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const unauthenticated = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    await Promise.all([
      new Promise<void>((resolve) => authenticated.on('open', () => resolve())),
      new Promise<void>((resolve) => unauthenticated.on('open', () => resolve())),
    ])

    authenticated.send(JSON.stringify({ type: 'hello', token: 'claude-activity-token', protocolVersion: WS_PROTOCOL_VERSION }))
    await waitForMessage(authenticated, (msg) => msg.type === 'ready')

    wsHandler.broadcastClaudeActivityUpdated({
      upsert: sampleActivity as any,
      remove: [],
    })

    const updated = await waitForMessage(authenticated, (msg) => msg.type === 'claude.activity.updated')
    expect(updated).toEqual({
      type: 'claude.activity.updated',
      upsert: sampleActivity,
      remove: [],
    })

    await expect(expectNoMatchingMessage(unauthenticated, (msg) => msg.type === 'claude.activity.updated')).resolves.toBeUndefined()

    authenticated.close()
    unauthenticated.close()
  })

  it('broadcasts terminal.turn.complete(provider=claude) only to authenticated sockets', async () => {
    const authenticated = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const unauthenticated = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    await Promise.all([
      new Promise<void>((resolve) => authenticated.on('open', () => resolve())),
      new Promise<void>((resolve) => unauthenticated.on('open', () => resolve())),
    ])

    authenticated.send(JSON.stringify({ type: 'hello', token: 'claude-activity-token', protocolVersion: WS_PROTOCOL_VERSION }))
    await waitForMessage(authenticated, (msg) => msg.type === 'ready')

    wsHandler.broadcastTerminalTurnComplete({
      provider: 'claude',
      terminalId: 'term-claude',
      at: 1234,
    })

    const completed = await waitForMessage(authenticated, (msg) => msg.type === 'terminal.turn.complete')
    expect(completed).toEqual({
      type: 'terminal.turn.complete',
      provider: 'claude',
      terminalId: 'term-claude',
      at: 1234,
    })

    await expect(expectNoMatchingMessage(unauthenticated, (msg) => msg.type === 'terminal.turn.complete')).resolves.toBeUndefined()

    authenticated.close()
    unauthenticated.close()
  })

  it('wires a real tracker so claude turn.complete fires once per turn and not on reattach/replay', async () => {
    // Wire the tracker to the handler EXACTLY as server/index.ts does.
    const tracker = new ClaudeActivityTracker()
    const onTurnComplete = (payload: { terminalId: string; at: number; sessionId?: string }) => {
      wsHandler.broadcastTerminalTurnComplete({
        provider: 'claude',
        terminalId: payload.terminalId,
        at: payload.at,
        ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
      })
    }
    tracker.on('turn.complete', onTurnComplete)

    const authenticated = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => authenticated.on('open', () => resolve()))
    authenticated.send(JSON.stringify({ type: 'hello', token: 'claude-activity-token', protocolVersion: WS_PROTOCOL_VERSION }))
    await waitForMessage(authenticated, (msg) => msg.type === 'ready')

    const turnCompletes: any[] = []
    authenticated.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'terminal.turn.complete' && msg.terminalId === 't1') {
        turnCompletes.push(msg)
      }
    })

    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    tracker.noteOutput({ terminalId: 't1', data: 'thinking', at: 2500 }) // no BEL -> still busy, no completion
    tracker.noteOutput({ terminalId: 't1', data: '\x07', at: 3000 })     // BEL -> one turn.complete

    const completed = await waitForMessage(
      authenticated,
      (msg) => msg.type === 'terminal.turn.complete' && msg.terminalId === 't1',
    )
    expect(completed).toEqual({
      type: 'terminal.turn.complete',
      provider: 'claude',
      terminalId: 't1',
      at: 3000,
    })
    expect(turnCompletes).toHaveLength(1)

    // A stray BEL while idle does NOT fire another completion.
    tracker.noteOutput({ terminalId: 't1', data: '\x07', at: 4000 })

    // A SECOND client connecting after the turn completed (reattach/replay) gets
    // NO turn.complete -- scrollback replay does not re-drive the tracker.
    const reattached = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => reattached.on('open', () => resolve()))
    reattached.send(JSON.stringify({ type: 'hello', token: 'claude-activity-token', protocolVersion: WS_PROTOCOL_VERSION }))
    await waitForMessage(reattached, (msg) => msg.type === 'ready')

    await expect(
      expectNoMatchingMessage(reattached, (msg) => msg.type === 'terminal.turn.complete'),
    ).resolves.toBeUndefined()

    // Still exactly one completion on the original client.
    expect(turnCompletes).toHaveLength(1)

    tracker.off('turn.complete', onTurnComplete)
    authenticated.close()
    reattached.close()
  })
})
