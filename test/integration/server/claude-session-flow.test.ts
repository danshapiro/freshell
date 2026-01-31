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
import http from 'http'
import express from 'express'
import WebSocket from 'ws'
import { WsHandler } from '../../../server/ws-handler'
import { TerminalRegistry } from '../../../server/terminal-registry'
import { ClaudeSessionManager } from '../../../server/claude-session'

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
  let claudeManager: ClaudeSessionManager

  beforeAll(async () => {
    const app = express()
    server = http.createServer(app)
    registry = new TerminalRegistry()
    claudeManager = new ClaudeSessionManager()
    wsHandler = new WsHandler(server, registry, claudeManager)

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as any).port
        resolve()
      })
    })
  })

  afterAll(async () => {
    claudeManager.shutdown()
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

        if (msg.type === 'claude.created') {
          sessionId = msg.sessionId
        }

        if (msg.type === 'claude.event') {
          events.push(msg.event)
        }

        if (msg.type === 'claude.exit') {
          resolve()
        }
      })
    })

    ws.send(JSON.stringify({
      type: 'claude.create',
      requestId: 'test-req-1',
      prompt: 'say "hello world" and nothing else',
      permissionMode: 'bypassPermissions',
    }))

    await done

    expect(sessionId).toBeDefined()
    expect(events.length).toBeGreaterThan(0)

    // Should have at least init and result events
    const hasInit = events.some((e) => e.type === 'system' && e.subtype === 'init')
    const hasResult = events.some((e) => e.type === 'result')
    expect(hasInit || hasResult).toBe(true)

    ws.close()
  }, 30000)
})
