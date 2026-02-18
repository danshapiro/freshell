import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import { WsHandler } from '../../../server/ws-handler'
import { TerminalRegistry } from '../../../server/terminal-registry'
import { SessionAssociationCoordinator } from '../../../server/session-association-coordinator'
import type { CodingCliSession, ProjectGroup } from '../../../server/coding-cli/types'

const TEST_TIMEOUT_MS = 30_000
const HOOK_TIMEOUT_MS = 30_000
const ASSOCIATION_MAX_AGE_MS = 30_000
const CODEX_CWD = '/home/user/project'
const CODEX_SESSION_IDS = [
  'codex-session-a',
  'codex-session-b',
  'codex-session-c',
] as const

vi.setConfig({ testTimeout: TEST_TIMEOUT_MS, hookTimeout: HOOK_TIMEOUT_MS })

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}))

function listen(server: http.Server, timeoutMs = HOOK_TIMEOUT_MS): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for server to listen')), timeoutMs)
    const onError = (err: Error) => {
      clearTimeout(timeout)
      reject(err)
    }
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      clearTimeout(timeout)
      server.off('error', onError)
      const addr = server.address()
      if (typeof addr === 'object' && addr) resolve(addr.port)
    })
  })
}

function waitForMessage(
  ws: WebSocket,
  predicate: (msg: any) => boolean,
  timeoutMs = 3_000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', handler)
      reject(new Error('Timed out waiting for WebSocket message'))
    }, timeoutMs)
    const handler = (data: WebSocket.Data) => {
      const parsed = JSON.parse(data.toString())
      if (!predicate(parsed)) return
      clearTimeout(timeout)
      ws.off('message', handler)
      resolve(parsed)
    }
    ws.on('message', handler)
  })
}

async function createAuthenticatedWs(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })

  ws.send(JSON.stringify({ type: 'hello', token: process.env.AUTH_TOKEN || 'testtoken-testtoken' }))
  await waitForMessage(ws, (msg) => msg.type === 'ready')
  return ws
}

describe('codex session rebind regression', () => {
  let server: http.Server
  let wsHandler: WsHandler
  let registry: TerminalRegistry
  let coordinator: SessionAssociationCoordinator
  let port: number

  beforeAll(async () => {
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = 'testtoken-testtoken'
    process.env.HELLO_TIMEOUT_MS = '200'

    server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    registry = new TerminalRegistry()
    coordinator = new SessionAssociationCoordinator(registry, ASSOCIATION_MAX_AGE_MS)
    wsHandler = new WsHandler(server, registry)
    port = await listen(server)

    // Three independent codex panes on the same cwd (the failure shape from production).
    registry.create({ mode: 'codex', cwd: CODEX_CWD })
    registry.create({ mode: 'codex', cwd: CODEX_CWD })
    registry.create({ mode: 'codex', cwd: CODEX_CWD })
  })

  afterAll(async () => {
    wsHandler.close()
    registry.shutdown()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const applyIndexerUpdate = (updatedAtBase: number) => {
    const sessions: CodingCliSession[] = CODEX_SESSION_IDS.map((sessionId, index) => ({
      provider: 'codex',
      sessionId,
      projectPath: CODEX_CWD,
      updatedAt: updatedAtBase + index,
      cwd: CODEX_CWD,
    }))
    const projects: ProjectGroup[] = [{ projectPath: CODEX_CWD, sessions }]
    for (const session of coordinator.collectNewOrAdvanced(projects)) {
      coordinator.associateSingleSession(session)
    }
  }

  const ownerBySession = (sessionId: string) => (
    registry.findRunningTerminalBySession('codex', sessionId)?.terminalId
  )

  const requestCreate = async (ws: WebSocket, requestId: string, resumeSessionId: string) => {
    ws.send(JSON.stringify({
      type: 'terminal.create',
      requestId,
      mode: 'codex',
      resumeSessionId,
    }))
    return waitForMessage(ws, (msg) => msg.type === 'terminal.created' && msg.requestId === requestId)
  }

  it('keeps codex sessions bound to original panes after reconnect and repeated index updates', async () => {
    const firstUpdateBase = Date.now()
    applyIndexerUpdate(firstUpdateBase)

    const firstOwners = new Map<string, string>()
    for (const sessionId of CODEX_SESSION_IDS) {
      const owner = ownerBySession(sessionId)
      expect(owner).toBeTruthy()
      firstOwners.set(sessionId, owner!)
    }
    expect(new Set(firstOwners.values()).size).toBe(CODEX_SESSION_IDS.length)

    const wsFirst = await createAuthenticatedWs(port)
    try {
      for (const [index, sessionId] of CODEX_SESSION_IDS.entries()) {
        const created = await requestCreate(wsFirst, `first-${index}`, sessionId)
        expect(created.terminalId).toBe(firstOwners.get(sessionId))
        expect(created.effectiveResumeSessionId).toBe(sessionId)
      }
    } finally {
      wsFirst.close()
    }

    // Same watermark (no-op) + advanced watermark (must still not rebind existing owners).
    applyIndexerUpdate(firstUpdateBase)
    applyIndexerUpdate(firstUpdateBase + 60_000)

    const secondOwners = new Map<string, string>()
    for (const sessionId of CODEX_SESSION_IDS) {
      const owner = ownerBySession(sessionId)
      expect(owner).toBeTruthy()
      secondOwners.set(sessionId, owner!)
    }
    expect(secondOwners).toEqual(firstOwners)

    const wsSecond = await createAuthenticatedWs(port)
    try {
      for (const [index, sessionId] of CODEX_SESSION_IDS.entries()) {
        const created = await requestCreate(wsSecond, `second-${index}`, sessionId)
        expect(created.terminalId).toBe(firstOwners.get(sessionId))
        expect(created.effectiveResumeSessionId).toBe(sessionId)
      }
    } finally {
      wsSecond.close()
    }

    for (const sessionId of CODEX_SESSION_IDS) {
      expect(registry.findTerminalsBySession('codex', sessionId)).toHaveLength(1)
    }
  })
})
