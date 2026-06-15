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

function enabledConfig() {
  const settings = createDefaultServerSettings({ loggingDebug: false })
  settings.freshAgent.enabled = true
  return {
    version: 1 as const,
    settings,
    sessionOverrides: {},
    terminalOverrides: {},
    projectColors: {},
    recentDirectories: [],
  }
}

async function createServer(options: Record<string, unknown>) {
  const server = http.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const registry = new TerminalRegistry()
  const handler = new WsHandler(server, registry, options as never)
  return { server, registry, handler }
}

async function connectAndAuth(server: http.Server) {
  const addr = server.address()
  const port = typeof addr === 'object' ? addr!.port : 0
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const messages: any[] = []
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
      messages.push(message)
      if (message.type === 'ready') {
        clearTimeout(timeout)
        resolve()
      }
    })
    ws.on('error', reject)
  })
  return { ws, messages }
}

describe('WsHandler fresh-agent ownership', () => {
  beforeEach(() => {
    process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
    vi.mocked(configStore.snapshot).mockResolvedValue(enabledConfig())
  })

  it.each([
    {
      type: 'freshAgent.send',
      method: 'send',
      payload: { text: 'not allowed' },
    },
    {
      type: 'freshAgent.interrupt',
      method: 'interrupt',
      payload: {},
    },
    {
      type: 'freshAgent.compact',
      method: 'compact',
      payload: { instructions: 'summarize' },
    },
    {
      type: 'freshAgent.approval.respond',
      method: 'resolveApproval',
      payload: { requestId: 'approval-1', decision: { behavior: 'allow' } },
    },
    {
      type: 'freshAgent.question.respond',
      method: 'answerQuestion',
      payload: { requestId: 'question-1', answers: { proceed: 'yes' } },
    },
    {
      type: 'freshAgent.fork',
      method: 'fork',
      payload: { requestId: 'fork-1', input: { prompt: 'branch' } },
    },
    {
      type: 'freshAgent.kill',
      method: 'kill',
      payload: {},
    },
  ])('rejects unauthorized $type before calling the runtime manager', async ({ type, method, payload }) => {
    const runtimeManager = {
      send: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined),
      compact: vi.fn().mockResolvedValue(undefined),
      resolveApproval: vi.fn().mockResolvedValue(undefined),
      answerQuestion: vi.fn().mockResolvedValue(undefined),
      fork: vi.fn().mockResolvedValue({ sessionId: 'forked-session' }),
      kill: vi.fn().mockResolvedValue(true),
    }
    const { server, registry, handler } = await createServer({ freshAgentRuntimeManager: runtimeManager })

    try {
      const { ws, messages } = await connectAndAuth(server)
      ws.send(JSON.stringify({
        type,
        sessionId: 'codex-session-owned-elsewhere',
        sessionType: 'freshcodex',
        provider: 'codex',
        ...payload,
      }))

      await vi.waitFor(() => {
        expect(messages).toContainEqual(expect.objectContaining({
          type: 'error',
          code: 'UNAUTHORIZED',
        }))
        expect(runtimeManager[method as keyof typeof runtimeManager]).not.toHaveBeenCalled()
      })
    } finally {
      handler.close()
      registry.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('grants mutation rights to a second client after successful attach', async () => {
    const runtimeManager = {
      attach: vi.fn().mockResolvedValue({ sessionId: 'codex-session-attach', runtimeProvider: 'codex' }),
      subscribe: vi.fn().mockResolvedValue(() => undefined),
      send: vi.fn().mockResolvedValue(undefined),
    }
    const { server, registry, handler } = await createServer({ freshAgentRuntimeManager: runtimeManager })

    try {
      const { ws } = await connectAndAuth(server)
      ws.send(JSON.stringify({
        type: 'freshAgent.attach',
        sessionId: 'codex-session-attach',
        sessionType: 'freshcodex',
        provider: 'codex',
      }))

      await vi.waitFor(() => {
        expect(runtimeManager.attach).toHaveBeenCalled()
      })

      ws.send(JSON.stringify({
        type: 'freshAgent.send',
        sessionId: 'codex-session-attach',
        sessionType: 'freshcodex',
        provider: 'codex',
        text: 'allowed',
      }))

      await vi.waitFor(() => {
        expect(runtimeManager.send).toHaveBeenCalledWith({
          sessionId: 'codex-session-attach',
          sessionType: 'freshcodex',
          provider: 'codex',
        }, {
          text: 'allowed',
          images: undefined,
          settings: undefined,
        })
      })
    } finally {
      handler.close()
      registry.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
