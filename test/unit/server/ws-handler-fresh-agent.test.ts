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

  it('routes freshAgent.send, freshAgent.interrupt, freshAgent approvals/questions, freshAgent.kill, and freshAgent.fork through the runtime manager after create ownership is established', async () => {
    const runtimeManager = {
      create: vi.fn().mockResolvedValue({
        sessionId: 'codex-session-2',
        sessionType: 'freshcodex',
        runtimeProvider: 'codex',
      }),
      send: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined),
      resolveApproval: vi.fn().mockResolvedValue(undefined),
      answerQuestion: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn().mockResolvedValue(true),
      fork: vi.fn().mockResolvedValue({ sessionId: 'forked-session' }),
    }
    const { server, registry, handler } = await createServer({ freshAgentRuntimeManager: runtimeManager })

    try {
      const ws = await connectAndAuth(server)

      ws.send(JSON.stringify({
        type: 'freshAgent.create',
        requestId: 'req-2',
        sessionType: 'freshcodex',
      }))

      await vi.waitFor(() => {
        expect(runtimeManager.create).toHaveBeenCalled()
      })

      ws.send(JSON.stringify({
        type: 'freshAgent.send',
        sessionId: 'codex-session-2',
        text: 'Ship it',
      }))
      ws.send(JSON.stringify({
        type: 'freshAgent.interrupt',
        sessionId: 'codex-session-2',
      }))
      ws.send(JSON.stringify({
        type: 'freshAgent.approval.respond',
        sessionId: 'codex-session-2',
        requestId: 'approval-1',
        decision: { behavior: 'allow', updatedInput: {} },
      }))
      ws.send(JSON.stringify({
        type: 'freshAgent.question.respond',
        sessionId: 'codex-session-2',
        requestId: 'question-1',
        answers: { proceed: 'yes' },
      }))
      ws.send(JSON.stringify({
        type: 'freshAgent.kill',
        sessionId: 'codex-session-2',
      }))
      ws.send(JSON.stringify({
        type: 'freshAgent.fork',
        sessionId: 'codex-session-2',
      }))

      await vi.waitFor(() => {
        expect(runtimeManager.send).toHaveBeenCalledWith('codex-session-2', { text: 'Ship it', images: undefined })
        expect(runtimeManager.interrupt).toHaveBeenCalledWith('codex-session-2')
        expect(runtimeManager.resolveApproval).toHaveBeenCalledWith('codex-session-2', 'approval-1', { behavior: 'allow', updatedInput: {} })
        expect(runtimeManager.answerQuestion).toHaveBeenCalledWith('codex-session-2', 'question-1', { proceed: 'yes' })
        expect(runtimeManager.kill).toHaveBeenCalledWith('codex-session-2')
        expect(runtimeManager.fork).toHaveBeenCalledWith('codex-session-2', undefined)
      })
    } finally {
      handler.close()
      registry.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('attaches a persisted fresh-agent session and forwards live adapter events over freshAgent.event', async () => {
    const listeners = new Map<string, (message: unknown) => void>()
    const runtimeManager = {
      attach: vi.fn().mockReturnValue({
        sessionId: 'claude-session-attached',
        sessionType: 'freshclaude',
        runtimeProvider: 'claude',
      }),
      subscribe: vi.fn().mockImplementation(async (sessionId: string, listener: (message: unknown) => void) => {
        listeners.set(sessionId, listener)
        return () => {
          listeners.delete(sessionId)
        }
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
        type: 'freshAgent.attach',
        sessionId: 'claude-session-attached',
        sessionType: 'freshclaude',
        resumeSessionId: 'cli-session-attached',
      }))

      await vi.waitFor(() => {
        expect(runtimeManager.attach).toHaveBeenCalledWith({
          sessionId: 'claude-session-attached',
          sessionType: 'freshclaude',
        })
        expect(runtimeManager.subscribe).toHaveBeenCalledWith(
          'claude-session-attached',
          expect.any(Function),
        )
      })

      listeners.get('claude-session-attached')?.({ kind: 'thread.updated', revision: 2 })

      await vi.waitFor(() => {
        expect(seenMessages).toContainEqual({
          type: 'freshAgent.event',
          sessionId: 'claude-session-attached',
          event: { kind: 'thread.updated', revision: 2 },
        })
      })
    } finally {
      handler.close()
      registry.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
