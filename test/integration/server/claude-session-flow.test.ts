// test/integration/server/claude-session-flow.test.ts
//
// NOTE: This is a true end-to-end integration test that requires:
// 1. The `claude` CLI to be installed and in PATH
// 2. A valid Claude API key configured
// 3. Network access to Anthropic's API
//
// Set RUN_CLAUDE_INTEGRATION=true to run this test:
//   RUN_CLAUDE_INTEGRATION=true npm run test:server
//
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import http from 'http'
import express from 'express'
import WebSocket from 'ws'
import { WsHandler } from '../../../server/ws-handler'
import { TerminalRegistry } from '../../../server/terminal-registry'
import { CodingCliSessionManager } from '../../../server/coding-cli/session-manager'
import { claudeProvider } from '../../../server/coding-cli/providers/claude'
import { SessionRepairService, createSessionScanner } from '../../../server/session-scanner'
import { claudeIndexer } from '../../../server/claude-indexer'
import { configStore } from '../../../server/config-store'

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}))

// Set auth token for tests
process.env.AUTH_TOKEN = 'test-token'

// Skip unless explicitly enabled - this test requires real Claude CLI
const runClaudeIntegration = process.env.RUN_CLAUDE_INTEGRATION === 'true'

describe.skipIf(!runClaudeIntegration)('Claude Session Flow Integration', () => {
  let server: http.Server
  let port: number
  let wsHandler: WsHandler
  let registry: TerminalRegistry
  let cliManager: CodingCliSessionManager

  beforeAll(async () => {
    const app = express()
    server = http.createServer(app)
    registry = new TerminalRegistry()
    cliManager = new CodingCliSessionManager([claudeProvider])
    wsHandler = new WsHandler(server, registry, cliManager)

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as any).port
        resolve()
      })
    })
  })

  afterAll(async () => {
    cliManager.shutdown()
    registry.shutdown()
    wsHandler.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  function createAuthenticatedWs(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', token: process.env.AUTH_TOKEN || 'test-token' }))
      })
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'ready') resolve(ws)
      })
      ws.on('error', reject)
      setTimeout(() => reject(new Error('Timeout')), 5000)
    })
  }

  it('creates session and streams events', async () => {
    const ws = await createAuthenticatedWs()
    const events: any[] = []
    let sessionId: string | null = null

    const done = new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())

        if (msg.type === 'codingcli.created') {
          sessionId = msg.sessionId
        }

        if (msg.type === 'codingcli.event') {
          events.push(msg.event)
        }

        if (msg.type === 'codingcli.exit') {
          resolve()
        }
      })
    })

    ws.send(JSON.stringify({
      type: 'codingcli.create',
      requestId: 'test-req-1',
      provider: 'claude',
      prompt: 'say \"hello world\" and nothing else',
      permissionMode: 'bypassPermissions',
    }))

    await done

    expect(sessionId).toBeDefined()
    expect(events.length).toBeGreaterThan(0)

    // Should have at least init and end events
    const hasInit = events.some((e) => e.type === 'session.init')
    const hasResult = events.some((e) => e.type === 'session.end')
    expect(hasInit || hasResult).toBe(true)

    ws.close()
  }, 60 * 1000)

  it('resumes a known claude session via terminal.create', async () => {
    const originalClaudeHome = process.env.CLAUDE_HOME
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-session-flow-'))
    const claudeHome = path.join(tempDir, '.claude')
    const projectDir = path.join(claudeHome, 'projects', 'session-project')
    const sessionId = '550e8400-e29b-41d4-a716-446655440000'
    const sessionFile = path.join(projectDir, `${sessionId}.jsonl`)

    process.env.CLAUDE_HOME = claudeHome
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(sessionFile, `{\"sessionId\":\"${sessionId}\",\"cwd\":\"/tmp\",\"role\":\"user\",\"content\":\"hello\"}\\n`)

    vi.spyOn(configStore, 'snapshot').mockResolvedValue({
      version: 1,
      settings: {},
      sessionOverrides: {},
      terminalOverrides: {},
      projectColors: {},
    } as any)
    vi.spyOn(configStore, 'getProjectColors').mockResolvedValue({})

    await claudeIndexer.refresh()

    const sessionRepairService = new SessionRepairService({
      cacheDir: tempDir,
      scanner: createSessionScanner(),
    })
    sessionRepairService.setFilePathResolver((id) => claudeIndexer.getFilePathForSession(id))
    await sessionRepairService.start()

    const app = express()
    const server2 = http.createServer(app)
    const registry2 = new TerminalRegistry()
    const cliManager2 = new CodingCliSessionManager([claudeProvider])
    const wsHandler2 = new WsHandler(server2, registry2, cliManager2, undefined, sessionRepairService)

    let port2 = 0
    await new Promise<void>((resolve) => {
      server2.listen(0, '127.0.0.1', () => {
        port2 = (server2.address() as any).port
        resolve()
      })
    })

    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port2}/ws`)
      socket.on('open', () => {
        socket.send(JSON.stringify({ type: 'hello', token: process.env.AUTH_TOKEN || 'test-token' }))
      })
      socket.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'ready') resolve(socket)
      })
      socket.on('error', reject)
      setTimeout(() => reject(new Error('Timeout')), 5000)
    })

    const created = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'terminal.created') resolve(msg)
      })
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'resume-req-1',
        mode: 'claude',
        resumeSessionId: sessionId,
      }))
    })

    expect(created.effectiveResumeSessionId).toBe(sessionId)
    const content = await fs.readFile(sessionFile, 'utf8')
    expect(content).toContain(sessionId)

    ws.close()
    wsHandler2.close()
    cliManager2.shutdown()
    registry2.shutdown()
    await new Promise<void>((resolve) => server2.close(() => resolve()))
    await sessionRepairService.stop()
    vi.restoreAllMocks()
    await fs.rm(tempDir, { recursive: true, force: true })
    if (originalClaudeHome === undefined) {
      delete process.env.CLAUDE_HOME
    } else {
      process.env.CLAUDE_HOME = originalClaudeHome
    }
  }, 30000)
})
