import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import { WS_PROTOCOL_VERSION } from '../../shared/ws-protocol'
import { CodexActivityTracker } from '../../server/coding-cli/codex-activity-tracker.js'
import type { CodingCliSession, ProjectGroup } from '../../server/coding-cli/types.js'

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

function createSession(sessionId: string, codexTaskEvents?: Record<string, number>): CodingCliSession {
  return {
    provider: 'codex',
    sessionId,
    projectPath: '/repo/project',
    lastActivityAt: 1_000,
    cwd: '/repo/project',
    ...(codexTaskEvents ? { codexTaskEvents } : {}),
  } as CodingCliSession
}

function createProjects(...sessions: CodingCliSession[]): ProjectGroup[] {
  return [{ projectPath: '/repo/project', sessions }]
}

describe('ws codex turn.complete (server-authoritative)', () => {
  let server: http.Server
  let port: number
  let wsHandler: any

  beforeAll(async () => {
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = 'codex-turn-complete-token'
    const { WsHandler } = await import('../../server/ws-handler')
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    wsHandler = new WsHandler(server, new FakeRegistry() as any, {})
    port = await listen(server)
  })

  afterAll(async () => {
    wsHandler?.close?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('wires a real tracker so codex turn.complete fires once per turn and not on reattach/replay', async () => {
    // Wire the tracker EXACTLY as server/index.ts does.
    const tracker = new CodexActivityTracker()
    const onTurnComplete = (payload: { terminalId: string; at: number; sessionId?: string; completionSeq: number }) => {
      wsHandler.broadcastTerminalTurnComplete({
        provider: 'codex',
        terminalId: payload.terminalId,
        at: payload.at,
        completionSeq: payload.completionSeq,
        ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
      })
    }
    tracker.on('turn.complete', onTurnComplete)

    const authenticated = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => authenticated.on('open', () => resolve()))
    authenticated.send(JSON.stringify({ type: 'hello', token: 'codex-turn-complete-token', protocolVersion: WS_PROTOCOL_VERSION }))
    await waitForMessage(authenticated, (msg) => msg.type === 'ready')

    const turnCompletes: any[] = []
    authenticated.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'terminal.turn.complete' && msg.terminalId === 't1') {
        turnCompletes.push(msg)
      }
    })

    tracker.bindTerminal({ terminalId: 't1', sessionId: 's1', reason: 'association', session: createSession('s1'), at: 1_000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2_000 })
    tracker.reconcileProjects(createProjects(createSession('s1', { latestTaskStartedAt: 2_100 })), 2_200) // -> busy
    tracker.noteOutput({ terminalId: 't1', data: 'thinking', at: 2_500 }) // no BEL, still busy
    tracker.noteOutput({ terminalId: 't1', data: '\x07', at: 3_000 })      // BEL -> one turn.complete

    const completed = await waitForMessage(
      authenticated,
      (msg) => msg.type === 'terminal.turn.complete' && msg.terminalId === 't1',
    )
    expect(completed).toEqual({
      type: 'terminal.turn.complete',
      provider: 'codex',
      terminalId: 't1',
      sessionId: 's1',
      at: 3_000,
      completionSeq: 1,
    })
    expect(turnCompletes).toHaveLength(1)

    // A stray BEL while idle does NOT fire another completion.
    tracker.noteOutput({ terminalId: 't1', data: '\x07', at: 4_000 })

    // A second client connecting after the turn completed (reattach/replay) gets NONE.
    const reattached = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => reattached.on('open', () => resolve()))
    reattached.send(JSON.stringify({ type: 'hello', token: 'codex-turn-complete-token', protocolVersion: WS_PROTOCOL_VERSION }))
    await waitForMessage(reattached, (msg) => msg.type === 'ready')

    await expect(
      expectNoMatchingMessage(reattached, (msg) => msg.type === 'terminal.turn.complete'),
    ).resolves.toBeUndefined()

    expect(turnCompletes).toHaveLength(1)

    tracker.off('turn.complete', onTurnComplete)
    authenticated.close()
    reattached.close()
  })
})
