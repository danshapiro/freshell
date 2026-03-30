// test/integration/server/codex-session-flow.test.ts
//
// NOTE: This is a true end-to-end integration test that requires:
// 1. The `codex` CLI to be installed and in PATH
// 2. A valid OpenAI API key configured for Codex CLI
// 3. Network access to OpenAI's API
//
// Set RUN_CODEX_INTEGRATION=true to run this test:
//   RUN_CODEX_INTEGRATION=true npm run test:server
//
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import express from 'express'
import WebSocket from 'ws'
import { WsHandler } from '../../../server/ws-handler'
import { TerminalRegistry } from '../../../server/terminal-registry'
import { CodingCliSessionManager } from '../../../server/coding-cli/session-manager'
import { codexProvider } from '../../../server/coding-cli/providers/codex'

process.env.AUTH_TOKEN = 'test-token'

const runCodexIntegration = process.env.RUN_CODEX_INTEGRATION === 'true'

describe.skipIf(!runCodexIntegration)('Codex Session Flow Integration', () => {
  let server: http.Server
  let port: number
  let wsHandler: WsHandler
  let registry: TerminalRegistry
  let cliManager: CodingCliSessionManager

  beforeAll(async () => {
    const app = express()
    server = http.createServer(app)
    registry = new TerminalRegistry()
    cliManager = new CodingCliSessionManager([codexProvider])
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
      requestId: 'test-req-codex',
      provider: 'codex',
      prompt: 'say "hello world" and nothing else',
    }))

    await done

    expect(sessionId).toBeDefined()
    expect(events.length).toBeGreaterThan(0)

    const hasInit = events.some((e) => e.type === 'session.init')
    const hasMessage = events.some((e) => e.type === 'message.assistant')
    expect(hasInit || hasMessage).toBe(true)

    ws.close()
  }, 30000)
})
