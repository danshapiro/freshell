import { beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'

import { WsHandler } from '../../../server/ws-handler.js'
import { TerminalRegistry } from '../../../server/terminal-registry.js'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'

const TEST_AUTH_TOKEN = 'testtoken-testtoken'

describe('WsHandler fresh-agent routing', () => {
  let originalAuthToken: string | undefined

  beforeEach(() => {
    originalAuthToken = process.env.AUTH_TOKEN
    process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
  })

  async function createServer(options: Record<string, unknown> = {}) {
    const server = http.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const registry = new TerminalRegistry()
    const handler = new WsHandler(server, registry, options as any)
    return { server, registry, handler }
  }

  async function connectAndAuth(server: http.Server) {
    const addr = server.address()
    const port = typeof addr === 'object' ? addr!.port : 0
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for ready')), 5000)
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'hello',
          token: TEST_AUTH_TOKEN,
          protocolVersion: WS_PROTOCOL_VERSION,
        }))
      })
      ws.on('message', (data) => {
        const message = JSON.parse(data.toString())
        if (message.type === 'ready') {
          clearTimeout(timeout)
          resolve()
        }
      })
      ws.on('error', reject)
    })
    return ws
  }

  it('routes freshAgent.create through the runtime manager while terminal traffic remains unchanged', async () => {
    const runtimeManager = {
      create: vi.fn().mockResolvedValue({
        sessionId: 'codex-session-1',
        sessionType: 'freshcodex',
        runtimeProvider: 'codex',
      }),
    }
    const { server, registry, handler } = await createServer({ freshAgentRuntimeManager: runtimeManager })

    try {
      const ws = await connectAndAuth(server)
      const seenMessages: any[] = []
      ws.on('message', (data) => {
        seenMessages.push(JSON.parse(data.toString()))
      })

      ws.send(JSON.stringify({
        type: 'freshAgent.create',
        requestId: 'req-1',
        sessionType: 'freshcodex',
        cwd: '/workspace',
      }))
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'term-1',
        mode: 'shell',
      }))

      await vi.waitFor(() => {
        expect(runtimeManager.create).toHaveBeenCalledWith(expect.objectContaining({
          sessionType: 'freshcodex',
        }))
        expect(seenMessages.some((message) => message.type === 'freshAgent.created')).toBe(true)
      })
    } finally {
      handler.close()
      registry.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
