import { beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'

vi.mock('../../../server/config-store.js', () => ({
  configStore: {
    snapshot: vi.fn(),
    pushRecentDirectory: vi.fn().mockResolvedValue([]),
  },
}))

import { WsHandler } from '../../../server/ws-handler.js'
import { TerminalRegistry } from '../../../server/terminal-registry.js'
import { configStore } from '../../../server/config-store.js'
import { createDefaultServerSettings } from '../../../shared/settings.js'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'

const TEST_AUTH_TOKEN = 'testtoken-testtoken'

function makeUserConfig(freshClientsEnabled: boolean) {
  const settings = createDefaultServerSettings({ loggingDebug: false })
  settings.freshAgent.enabled = freshClientsEnabled
  return {
    version: 1 as const,
    settings,
    sessionOverrides: {},
    terminalOverrides: {},
    projectColors: {},
    recentDirectories: [],
  }
}

describe('WsHandler fresh-agent routing', () => {
  let originalAuthToken: string | undefined

  beforeEach(() => {
    originalAuthToken = process.env.AUTH_TOKEN
    process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
    vi.mocked(configStore.snapshot).mockResolvedValue(makeUserConfig(true))
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
      subscribe: vi.fn().mockResolvedValue(() => undefined),
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
        provider: 'codex',
        cwd: '/workspace',
        legacyRestoreContext: {
          title: 'Legacy title',
          createdAt: 1_781_291_230_743,
          updatedAt: 1_781_291_259_546,
        },
      }))
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'term-1',
        mode: 'shell',
      }))

      await vi.waitFor(() => {
        expect(runtimeManager.create).toHaveBeenCalledWith(expect.objectContaining({
          sessionType: 'freshcodex',
          provider: 'codex',
          legacyRestoreContext: {
            title: 'Legacy title',
            createdAt: 1_781_291_230_743,
            updatedAt: 1_781_291_259_546,
          },
        }))
        expect(seenMessages.some((message) => message.type === 'freshAgent.created')).toBe(true)
      })
    } finally {
      handler.close()
      registry.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('rejects freshAgent.create without touching the runtime manager when fresh clients are disabled', async () => {
    vi.mocked(configStore.snapshot).mockResolvedValue(makeUserConfig(false))
    const runtimeManager = {
      create: vi.fn().mockResolvedValue({
        sessionId: 'codex-session-disabled',
        sessionType: 'freshcodex',
        runtimeProvider: 'codex',
      }),
      subscribe: vi.fn().mockResolvedValue(() => undefined),
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
        requestId: 'req-disabled',
        sessionType: 'freshcodex',
        provider: 'codex',
        cwd: '/workspace',
      }))

      await vi.waitFor(() => {
        expect(seenMessages).toContainEqual(expect.objectContaining({
          type: 'freshAgent.create.failed',
          requestId: 'req-disabled',
          code: 'FRESH_CLIENTS_DISABLED',
          message: 'Fresh clients are disabled',
          retryable: true,
        }))
        expect(runtimeManager.create).not.toHaveBeenCalled()
      })
    } finally {
      handler.close()
      registry.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('replays duplicate freshAgent.create request ids without creating duplicate runtime sessions', async () => {
    const runtimeManager = {
      create: vi.fn().mockResolvedValue({
        sessionId: 'codex-session-idempotent',
        sessionType: 'freshcodex',
        runtimeProvider: 'codex',
      }),
      subscribe: vi.fn().mockResolvedValue(() => undefined),
    }
    const { server, registry, handler } = await createServer({ freshAgentRuntimeManager: runtimeManager })

    try {
      const ws = await connectAndAuth(server)
      const seenMessages: any[] = []
      ws.on('message', (data) => {
        seenMessages.push(JSON.parse(data.toString()))
      })

      const createMessage = {
        type: 'freshAgent.create',
        requestId: 'req-idempotent',
        sessionType: 'freshcodex',
        provider: 'codex',
        cwd: '/workspace',
      }

      ws.send(JSON.stringify(createMessage))
      await vi.waitFor(() => {
        expect(seenMessages.filter((message) => message.type === 'freshAgent.created')).toHaveLength(1)
      })

      ws.send(JSON.stringify(createMessage))

      await vi.waitFor(() => {
        const created = seenMessages.filter((message) => message.type === 'freshAgent.created')
        expect(created).toHaveLength(2)
        expect(created).toEqual([
          expect.objectContaining({
            requestId: 'req-idempotent',
            sessionId: 'codex-session-idempotent',
            sessionType: 'freshcodex',
            provider: 'codex',
            runtimeProvider: 'codex',
          }),
          expect.objectContaining({
            requestId: 'req-idempotent',
            sessionId: 'codex-session-idempotent',
            sessionType: 'freshcodex',
            provider: 'codex',
            runtimeProvider: 'codex',
          }),
        ])
        expect(runtimeManager.create).toHaveBeenCalledTimes(1)
      })
    } finally {
      handler.close()
      registry.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('replays duplicate freshAgent.create request ids even after fresh clients are disabled', async () => {
    const runtimeManager = {
      create: vi.fn().mockResolvedValue({
        sessionId: 'codex-session-idempotent-disabled',
        sessionType: 'freshcodex',
        runtimeProvider: 'codex',
      }),
      subscribe: vi.fn().mockResolvedValue(() => undefined),
    }
    const { server, registry, handler } = await createServer({ freshAgentRuntimeManager: runtimeManager })

    try {
      const ws = await connectAndAuth(server)
      const seenMessages: any[] = []
      ws.on('message', (data) => {
        seenMessages.push(JSON.parse(data.toString()))
      })

      const createMessage = {
        type: 'freshAgent.create',
        requestId: 'req-idempotent-disabled',
        sessionType: 'freshcodex',
        provider: 'codex',
        cwd: '/workspace',
      }

      ws.send(JSON.stringify(createMessage))
      await vi.waitFor(() => {
        expect(seenMessages.filter((message) => message.type === 'freshAgent.created')).toHaveLength(1)
      })

      vi.mocked(configStore.snapshot).mockResolvedValue(makeUserConfig(false))
      ws.send(JSON.stringify(createMessage))

      await vi.waitFor(() => {
        const created = seenMessages.filter((message) => message.type === 'freshAgent.created')
        expect(created).toHaveLength(2)
        expect(created[1]).toEqual(expect.objectContaining({
          requestId: 'req-idempotent-disabled',
          sessionId: 'codex-session-idempotent-disabled',
          sessionType: 'freshcodex',
          provider: 'codex',
          runtimeProvider: 'codex',
        }))
        expect(seenMessages.some((message) => message.type === 'freshAgent.create.failed')).toBe(false)
        expect(runtimeManager.create).toHaveBeenCalledTimes(1)
      })
    } finally {
      handler.close()
      registry.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('clears fresh-agent create replay entries when the session is killed and when the handler closes', async () => {
    const runtimeManager = {
      create: vi.fn().mockResolvedValue({
        sessionId: 'codex-session-cache-cleanup',
        sessionType: 'freshcodex',
        runtimeProvider: 'codex',
      }),
      subscribe: vi.fn().mockResolvedValue(() => undefined),
      kill: vi.fn().mockResolvedValue(true),
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
        requestId: 'req-cache-cleanup',
        sessionType: 'freshcodex',
        provider: 'codex',
        cwd: '/workspace',
      }))

      await vi.waitFor(() => {
        expect(seenMessages).toContainEqual(expect.objectContaining({
          type: 'freshAgent.created',
          requestId: 'req-cache-cleanup',
          sessionId: 'codex-session-cache-cleanup',
        }))
      })
      expect((handler as any).createdFreshAgentByRequestId.size).toBe(1)

      ws.send(JSON.stringify({
        type: 'freshAgent.kill',
        sessionId: 'codex-session-cache-cleanup',
        sessionType: 'freshcodex',
        provider: 'codex',
      }))

      await vi.waitFor(() => {
        expect(runtimeManager.kill).toHaveBeenCalledWith({
          sessionId: 'codex-session-cache-cleanup',
          sessionType: 'freshcodex',
          provider: 'codex',
        })
        expect((handler as any).createdFreshAgentByRequestId.size).toBe(0)
      })

      ws.send(JSON.stringify({
        type: 'freshAgent.create',
        requestId: 'req-cache-close',
        sessionType: 'freshcodex',
        provider: 'codex',
        cwd: '/workspace',
      }))

      await vi.waitFor(() => {
        expect((handler as any).createdFreshAgentByRequestId.size).toBe(1)
      })

      handler.close()
      expect((handler as any).createdFreshAgentByRequestId.size).toBe(0)
      expect((handler as any).freshAgentCreateLocks.size).toBe(0)
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
      subscribe: vi.fn().mockResolvedValue(() => undefined),
      send: vi.fn().mockResolvedValue({ requestId: 'send-req-1', submittedTurnId: 'display-user-1' }),
      interrupt: vi.fn().mockResolvedValue(undefined),
      resolveApproval: vi.fn().mockResolvedValue(undefined),
      answerQuestion: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn().mockResolvedValue(true),
      fork: vi.fn().mockResolvedValue({ sessionId: 'forked-session' }),
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
        requestId: 'req-2',
        sessionType: 'freshcodex',
        provider: 'codex',
      }))

      await vi.waitFor(() => {
        expect(runtimeManager.create).toHaveBeenCalled()
      })

      ws.send(JSON.stringify({
        type: 'freshAgent.send',
        requestId: 'send-req-1',
        sessionId: 'codex-session-2',
        sessionType: 'freshcodex',
        provider: 'codex',
        text: 'Ship it',
        settings: { cwd: '/repo', model: 'gpt-5.4-mini', effort: 'low' },
      }))
      ws.send(JSON.stringify({
        type: 'freshAgent.interrupt',
        sessionId: 'codex-session-2',
        sessionType: 'freshcodex',
        provider: 'codex',
      }))
      ws.send(JSON.stringify({
        type: 'freshAgent.approval.respond',
        sessionId: 'codex-session-2',
        sessionType: 'freshcodex',
        provider: 'codex',
        requestId: 'approval-1',
        decision: { behavior: 'allow', updatedInput: {} },
      }))
      ws.send(JSON.stringify({
        type: 'freshAgent.question.respond',
        sessionId: 'codex-session-2',
        sessionType: 'freshcodex',
        provider: 'codex',
        requestId: 'question-1',
        answers: { proceed: 'yes' },
      }))
      ws.send(JSON.stringify({
        type: 'freshAgent.fork',
        requestId: 'fork-req-1',
        sessionId: 'codex-session-2',
        sessionType: 'freshcodex',
        provider: 'codex',
      }))
      ws.send(JSON.stringify({
        type: 'freshAgent.kill',
        sessionId: 'codex-session-2',
        sessionType: 'freshcodex',
        provider: 'codex',
      }))

      await vi.waitFor(() => {
        const locator = { sessionId: 'codex-session-2', sessionType: 'freshcodex', provider: 'codex' }
        expect(runtimeManager.send).toHaveBeenCalledWith(locator, {
          requestId: 'send-req-1',
          text: 'Ship it',
          images: undefined,
          settings: { cwd: '/repo', model: 'gpt-5.4-mini', effort: 'low' },
        })
        expect(runtimeManager.interrupt).toHaveBeenCalledWith(locator)
        expect(runtimeManager.resolveApproval).toHaveBeenCalledWith(locator, 'approval-1', { behavior: 'allow', updatedInput: {} })
        expect(runtimeManager.answerQuestion).toHaveBeenCalledWith(locator, 'question-1', { proceed: 'yes' })
        expect(runtimeManager.fork).toHaveBeenCalledWith(locator, undefined)
        expect(runtimeManager.subscribe).toHaveBeenCalledWith(
          { sessionId: 'forked-session', sessionType: 'freshcodex', provider: 'codex' },
          expect.any(Function),
        )
        expect(runtimeManager.kill).toHaveBeenCalledWith(locator)
        expect(seenMessages).toContainEqual(expect.objectContaining({
          type: 'freshAgent.send.accepted',
          requestId: 'send-req-1',
          submittedTurnId: 'display-user-1',
        }))
        expect(seenMessages).toContainEqual(expect.objectContaining({
          type: 'freshAgent.forked',
          requestId: 'fork-req-1',
          parentSessionId: 'codex-session-2',
          sessionId: 'forked-session',
          sessionType: 'freshcodex',
          provider: 'codex',
        }))
      })
    } finally {
      handler.close()
      registry.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('emits freshAgent.session.materialized when send returns a new session id', async () => {
    const unsubscribeByKey = new Map<string, ReturnType<typeof vi.fn>>()
    const placeholderLocator = { sessionId: 'freshopencode-req-1', sessionType: 'freshopencode', provider: 'opencode' }
    const durableLocator = { sessionId: 'ses_real_1', sessionType: 'freshopencode', provider: 'opencode' }
    const placeholderKey = JSON.stringify(placeholderLocator)
    const runtimeManager = {
      create: vi.fn().mockResolvedValue({
        sessionId: 'freshopencode-req-1',
        sessionType: 'freshopencode',
        runtimeProvider: 'opencode',
        sessionRef: { provider: 'opencode', sessionId: 'freshopencode-req-1' },
      }),
      subscribe: vi.fn().mockImplementation(async (locator: unknown) => {
        const off = vi.fn()
        unsubscribeByKey.set(JSON.stringify(locator), off)
        return off
      }),
      send: vi.fn().mockResolvedValue({
        sessionId: 'ses_real_1',
        sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' },
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
        requestId: 'req-materialize',
        sessionType: 'freshopencode',
        provider: 'opencode',
      }))

      await vi.waitFor(() => {
        expect(seenMessages).toContainEqual(expect.objectContaining({
          type: 'freshAgent.created',
          sessionId: 'freshopencode-req-1',
        }))
      })

      ws.send(JSON.stringify({
        type: 'freshAgent.send',
        sessionId: 'freshopencode-req-1',
        sessionType: 'freshopencode',
        provider: 'opencode',
        text: 'Ship it',
      }))

      await vi.waitFor(() => {
        expect(runtimeManager.send).toHaveBeenCalledWith(placeholderLocator, {
          text: 'Ship it',
          images: undefined,
          settings: undefined,
        })
        expect(runtimeManager.subscribe).toHaveBeenCalledWith(durableLocator, expect.any(Function))
        expect(unsubscribeByKey.get(placeholderKey)).toHaveBeenCalledTimes(1)
        expect(seenMessages).toContainEqual({
          type: 'freshAgent.session.materialized',
          previousSessionId: 'freshopencode-req-1',
          sessionId: 'ses_real_1',
          sessionType: 'freshopencode',
          provider: 'opencode',
          sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' },
        })
      })
    } finally {
      handler.close()
      registry.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('forwards provider materialization events as top-level websocket materialization', async () => {
    const listeners = new Map<string, (message: unknown) => void>()
    const unsubscribeByKey = new Map<string, ReturnType<typeof vi.fn>>()
    const placeholderLocator = { sessionId: 'freshopencode-req-event', sessionType: 'freshopencode', provider: 'opencode' }
    const durableLocator = { sessionId: 'ses_event_1', sessionType: 'freshopencode', provider: 'opencode' }
    const placeholderKey = JSON.stringify(placeholderLocator)
    const runtimeManager = {
      create: vi.fn().mockResolvedValue({
        sessionId: 'freshopencode-req-event',
        sessionType: 'freshopencode',
        runtimeProvider: 'opencode',
        sessionRef: { provider: 'opencode', sessionId: 'freshopencode-req-event' },
      }),
      subscribe: vi.fn().mockImplementation(async (locator: unknown, listener: (message: unknown) => void) => {
        const key = JSON.stringify(locator)
        listeners.set(key, listener)
        const off = vi.fn(() => {
          listeners.delete(key)
        })
        unsubscribeByKey.set(key, off)
        return off
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
        requestId: 'req-materialize-event',
        sessionType: 'freshopencode',
        provider: 'opencode',
      }))

      await vi.waitFor(() => {
        expect(runtimeManager.subscribe).toHaveBeenCalledWith(placeholderLocator, expect.any(Function))
        expect(listeners.has(placeholderKey)).toBe(true)
      })

      listeners.get(placeholderKey)?.({
        type: 'freshAgent.session.materialized',
        previousSessionId: 'freshopencode-req-event',
        sessionId: 'ses_event_1',
        sessionRef: { provider: 'opencode', sessionId: 'ses_event_1' },
      })

      await vi.waitFor(() => {
        expect(runtimeManager.subscribe).toHaveBeenCalledWith(durableLocator, expect.any(Function))
        expect(unsubscribeByKey.get(placeholderKey)).toHaveBeenCalledTimes(1)
        expect(listeners.has(placeholderKey)).toBe(false)
        expect(seenMessages).toContainEqual({
          type: 'freshAgent.session.materialized',
          previousSessionId: 'freshopencode-req-event',
          sessionId: 'ses_event_1',
          sessionType: 'freshopencode',
          provider: 'opencode',
          sessionRef: { provider: 'opencode', sessionId: 'ses_event_1' },
        })
      })
    } finally {
      handler.close()
      registry.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('routes freshAgent.compact through the runtime manager', async () => {
    const runtimeManager = {
      create: vi.fn().mockResolvedValue({
        sessionId: 'codex-session-compact',
        sessionType: 'freshcodex',
        runtimeProvider: 'codex',
      }),
      subscribe: vi.fn().mockResolvedValue(() => undefined),
      compact: vi.fn().mockResolvedValue(undefined),
    }
    const { server, registry, handler } = await createServer({ freshAgentRuntimeManager: runtimeManager })

    try {
      const ws = await connectAndAuth(server)
      ws.send(JSON.stringify({
        type: 'freshAgent.create',
        requestId: 'req-compact',
        sessionType: 'freshcodex',
        provider: 'codex',
      }))

      await vi.waitFor(() => {
        expect(runtimeManager.create).toHaveBeenCalled()
      })

      ws.send(JSON.stringify({
        type: 'freshAgent.compact',
        sessionId: 'codex-session-compact',
        sessionType: 'freshcodex',
        provider: 'codex',
        instructions: 'keep findings',
      }))

      await vi.waitFor(() => {
        expect(runtimeManager.compact).toHaveBeenCalledWith({
          sessionId: 'codex-session-compact',
          sessionType: 'freshcodex',
          provider: 'codex',
        }, { instructions: 'keep findings' })
      })
    } finally {
      handler.close()
      registry.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('routes freshAgent.compact through the runtime manager', async () => {
    const runtimeManager = {
      create: vi.fn().mockResolvedValue({
        sessionId: 'codex-session-compact',
        sessionType: 'freshcodex',
        runtimeProvider: 'codex',
      }),
      subscribe: vi.fn().mockResolvedValue(() => undefined),
      compact: vi.fn().mockResolvedValue(undefined),
    }
    const { server, registry, handler } = await createServer({ freshAgentRuntimeManager: runtimeManager })

    try {
      const ws = await connectAndAuth(server)
      ws.send(JSON.stringify({
        type: 'freshAgent.create',
        requestId: 'req-compact',
        sessionType: 'freshcodex',
        provider: 'codex',
      }))

      await vi.waitFor(() => {
        expect(runtimeManager.create).toHaveBeenCalled()
      })

      ws.send(JSON.stringify({
        type: 'freshAgent.compact',
        sessionId: 'codex-session-compact',
        sessionType: 'freshcodex',
        provider: 'codex',
        instructions: 'keep findings',
      }))

      await vi.waitFor(() => {
        expect(runtimeManager.compact).toHaveBeenCalledWith({
          sessionId: 'codex-session-compact',
          sessionType: 'freshcodex',
          provider: 'codex',
        }, { instructions: 'keep findings' })
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
      subscribe: vi.fn().mockImplementation(async (locator: unknown, listener: (message: unknown) => void) => {
        listeners.set(JSON.stringify(locator), listener)
        return () => {
          listeners.delete(JSON.stringify(locator))
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
        provider: 'claude',
        resumeSessionId: 'cli-session-attached',
        cwd: '/repo/restored-worktree',
      }))

      await vi.waitFor(() => {
        expect(runtimeManager.attach).toHaveBeenCalledWith({
          sessionId: 'claude-session-attached',
          sessionType: 'freshclaude',
          provider: 'claude',
          cwd: '/repo/restored-worktree',
        })
        expect(runtimeManager.subscribe).toHaveBeenCalledWith(
          {
            sessionId: 'claude-session-attached',
            sessionType: 'freshclaude',
            provider: 'claude',
            cwd: '/repo/restored-worktree',
          },
          expect.any(Function),
        )
      })

      listeners.get(JSON.stringify({
        sessionId: 'claude-session-attached',
        sessionType: 'freshclaude',
        provider: 'claude',
        cwd: '/repo/restored-worktree',
      }))?.({ kind: 'thread.updated', revision: 2 })

      await vi.waitFor(() => {
        expect(seenMessages).toContainEqual({
          type: 'freshAgent.event',
          sessionId: 'claude-session-attached',
          sessionType: 'freshclaude',
          provider: 'claude',
          event: { kind: 'thread.updated', revision: 2 },
        })
      })
    } finally {
      handler.close()
      registry.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('reports fresh-agent subscription failures instead of silently dropping live updates', async () => {
    const runtimeManager = {
      attach: vi.fn().mockReturnValue({
        sessionId: 'codex-session-no-subscribe',
        sessionType: 'freshcodex',
        runtimeProvider: 'codex',
      }),
      subscribe: vi.fn().mockRejectedValue(new Error('Codex app-server lifecycle subscription failed')),
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
        sessionId: 'codex-session-no-subscribe',
        sessionType: 'freshcodex',
        provider: 'codex',
      }))

      await vi.waitFor(() => {
        expect(runtimeManager.subscribe).toHaveBeenCalledWith(
          { sessionId: 'codex-session-no-subscribe', sessionType: 'freshcodex', provider: 'codex' },
          expect.any(Function),
        )
        expect(seenMessages).toContainEqual({
          type: 'freshAgent.event',
          sessionId: 'codex-session-no-subscribe',
          sessionType: 'freshcodex',
          provider: 'codex',
          event: {
            type: 'freshAgent.error',
            sessionId: 'codex-session-no-subscribe',
            code: 'FRESH_AGENT_SUBSCRIBE_FAILED',
            message: 'Codex app-server lifecycle subscription failed',
          },
        })
      })
    } finally {
      handler.close()
      registry.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('unsubscribes a late fresh-agent subscription when the client clears the session before subscribe resolves', async () => {
    let resolveSubscribe!: (off: () => void) => void
    const off = vi.fn()
    const runtimeManager = {
      attach: vi.fn().mockReturnValue({
        sessionId: 'claude-session-race',
        sessionType: 'freshclaude',
        runtimeProvider: 'claude',
      }),
      subscribe: vi.fn().mockImplementation(async () => (
        await new Promise<() => void>((resolve) => {
          resolveSubscribe = resolve
        })
      )),
      kill: vi.fn().mockResolvedValue(true),
    }
    const { server, registry, handler } = await createServer({ freshAgentRuntimeManager: runtimeManager })

    try {
      const ws = await connectAndAuth(server)

      ws.send(JSON.stringify({
        type: 'freshAgent.attach',
        sessionId: 'claude-session-race',
        sessionType: 'freshclaude',
        provider: 'claude',
      }))

      await vi.waitFor(() => {
        expect(runtimeManager.subscribe).toHaveBeenCalled()
      })

      ws.send(JSON.stringify({
        type: 'freshAgent.kill',
        sessionId: 'claude-session-race',
        sessionType: 'freshclaude',
        provider: 'claude',
      }))

      await vi.waitFor(() => {
        expect(runtimeManager.kill).toHaveBeenCalledWith({
          sessionId: 'claude-session-race',
          sessionType: 'freshclaude',
          provider: 'claude',
        })
      })

      resolveSubscribe(off)

      await vi.waitFor(() => {
        expect(off).toHaveBeenCalledTimes(1)
      })
    } finally {
      handler.close()
      registry.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('deduplicates concurrent fresh-agent subscription registration while subscribe is pending', async () => {
    let resolveSubscribe!: (off: () => void) => void
    const off = vi.fn()
    const runtimeManager = {
      attach: vi.fn().mockReturnValue({
        sessionId: 'codex-session-pending-subscribe',
        sessionType: 'freshcodex',
        runtimeProvider: 'codex',
      }),
      subscribe: vi.fn().mockImplementation(async () => (
        await new Promise<() => void>((resolve) => {
          resolveSubscribe = resolve
        })
      )),
    }
    const { server, registry, handler } = await createServer({ freshAgentRuntimeManager: runtimeManager })

    try {
      const ws = await connectAndAuth(server)
      const attachMessage = {
        type: 'freshAgent.attach',
        sessionId: 'codex-session-pending-subscribe',
        sessionType: 'freshcodex',
        provider: 'codex',
      }

      ws.send(JSON.stringify(attachMessage))
      ws.send(JSON.stringify(attachMessage))

      await vi.waitFor(() => {
        expect(runtimeManager.attach).toHaveBeenCalledTimes(2)
        expect(runtimeManager.subscribe).toHaveBeenCalledTimes(1)
      })

      resolveSubscribe(off)

      await vi.waitFor(() => {
        expect(off).not.toHaveBeenCalled()
      })
    } finally {
      handler.close()
      registry.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
