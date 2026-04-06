import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'fs/promises'
import http from 'http'
import os from 'os'
import path from 'path'
import express from 'express'
import WebSocket from 'ws'
import { WsHandler } from '../../../server/ws-handler'
import { TerminalRegistry } from '../../../server/terminal-registry'
import { CodingCliSessionManager } from '../../../server/coding-cli/session-manager'
import { codexProvider } from '../../../server/coding-cli/providers/codex'
import { configStore } from '../../../server/config-store'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol'

vi.mock('../../../server/config-store', () => ({
  configStore: {
    snapshot: vi.fn(),
  },
}))

vi.mock('../../../server/logger', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  }
  logger.child.mockReturnValue(logger)
  return { logger }
})

process.env.AUTH_TOKEN = 'test-token'

const MESSAGE_TIMEOUT_MS = 5_000

async function writeFakeCodexExecutable(binaryPath: string) {
  const script = `#!/usr/bin/env node
const fs = require('fs')

const sessionId = 'fake-codex-session-1'
const argLogPath = process.env.FAKE_CODEX_ARG_LOG
if (argLogPath) {
  fs.writeFileSync(argLogPath, JSON.stringify(process.argv.slice(2)), 'utf8')
}

const events = [
  {
    type: 'session_meta',
    payload: {
      id: sessionId,
      cwd: process.cwd(),
      model: 'gpt-5-codex',
    },
  },
  {
    type: 'event_msg',
    session_id: sessionId,
    payload: {
      type: 'agent_message',
      message: 'hello world',
    },
  },
]

let index = 0
const emitNext = () => {
  if (index >= events.length) {
    setTimeout(() => process.exit(0), 10)
    return
  }
  process.stdout.write(JSON.stringify(events[index]) + '\\n')
  index += 1
  setTimeout(emitNext, 10)
}

emitNext()
`

  await fsp.writeFile(binaryPath, script, 'utf8')
  await fsp.chmod(binaryPath, 0o755)
}

function waitForMessage(
  ws: WebSocket,
  predicate: (msg: any) => boolean,
  timeoutMs = MESSAGE_TIMEOUT_MS,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for WebSocket message'))
    }, timeoutMs)

    const onMessage = (data: WebSocket.Data) => {
      const message = JSON.parse(data.toString())
      if (!predicate(message)) return
      cleanup()
      resolve(message)
    }

    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }

    const onClose = () => {
      cleanup()
      reject(new Error('WebSocket closed before expected message'))
    }

    const cleanup = () => {
      clearTimeout(timeout)
      ws.off('message', onMessage)
      ws.off('error', onError)
      ws.off('close', onClose)
    }

    ws.on('message', onMessage)
    ws.on('error', onError)
    ws.on('close', onClose)
  })
}

async function createAuthenticatedWs(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })

  ws.send(JSON.stringify({
    type: 'hello',
    token: process.env.AUTH_TOKEN || 'test-token',
    protocolVersion: WS_PROTOCOL_VERSION,
  }))

  await waitForMessage(ws, (msg) => msg.type === 'ready')
  return ws
}

async function closeWebSocket(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve()
      return
    }

    const timeout = setTimeout(() => {
      cleanup()
      resolve()
    }, 1_000)

    const cleanup = () => {
      clearTimeout(timeout)
      ws.off('close', onClose)
      ws.off('error', onClose)
    }

    const onClose = () => {
      cleanup()
      resolve()
    }

    ws.on('close', onClose)
    ws.on('error', onClose)
    ws.close()
  })
}

describe('Codex Session Flow Integration', () => {
  let tempDir: string
  let fakeCodexPath: string
  let argLogPath: string
  let previousCodexCmd: string | undefined
  let previousFakeCodexArgLog: string | undefined
  let server: http.Server
  let port: number
  let wsHandler: WsHandler
  let registry: TerminalRegistry
  let cliManager: CodingCliSessionManager

  beforeAll(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-flow-'))
    fakeCodexPath = path.join(tempDir, 'fake-codex')
    argLogPath = path.join(tempDir, 'args.json')
    await writeFakeCodexExecutable(fakeCodexPath)

    previousCodexCmd = process.env.CODEX_CMD
    previousFakeCodexArgLog = process.env.FAKE_CODEX_ARG_LOG
    process.env.CODEX_CMD = fakeCodexPath
    process.env.FAKE_CODEX_ARG_LOG = argLogPath

    const app = express()
    server = http.createServer(app)
    registry = new TerminalRegistry()
    cliManager = new CodingCliSessionManager([codexProvider])
    wsHandler = new WsHandler(server, registry, { codingCliManager: cliManager })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port
        resolve()
      })
    })
  })

  beforeEach(async () => {
    vi.mocked(configStore.snapshot).mockResolvedValue({
      settings: {
        codingCli: {
          enabledProviders: ['codex'],
          providers: {},
        },
      },
    })
    await fsp.rm(argLogPath, { force: true })
  })

  afterAll(async () => {
    if (previousCodexCmd === undefined) {
      delete process.env.CODEX_CMD
    } else {
      process.env.CODEX_CMD = previousCodexCmd
    }
    if (previousFakeCodexArgLog === undefined) {
      delete process.env.FAKE_CODEX_ARG_LOG
    } else {
      process.env.FAKE_CODEX_ARG_LOG = previousFakeCodexArgLog
    }

    cliManager.shutdown()
    registry.shutdown()
    wsHandler.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  it('creates a codex session and streams parsed provider events from a local codex executable', async () => {
    const ws = await createAuthenticatedWs(port)
    const observedMessages: any[] = []
    const onMessage = (data: WebSocket.Data) => {
      observedMessages.push(JSON.parse(data.toString()))
    }
    ws.on('message', onMessage)

    try {
      ws.send(JSON.stringify({
        type: 'codingcli.create',
        requestId: 'test-req-codex',
        provider: 'codex',
        prompt: 'say "hello world" and nothing else',
      }))

      const created = await waitForMessage(
        ws,
        (msg) => msg.type === 'codingcli.created' && msg.requestId === 'test-req-codex',
      )
      const exited = await waitForMessage(
        ws,
        (msg) => msg.type === 'codingcli.exit' && msg.sessionId === created.sessionId,
      )

      const eventMessages = observedMessages
        .filter((msg) => msg.type === 'codingcli.event' && msg.sessionId === created.sessionId)
        .map((msg) => msg.event)

      expect(created.provider).toBe('codex')
      expect(exited.exitCode).toBe(0)
      expect(eventMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'session.start',
            sessionId: 'fake-codex-session-1',
            provider: 'codex',
            session: expect.objectContaining({
              cwd: process.cwd(),
              model: 'gpt-5-codex',
            }),
          }),
          expect.objectContaining({
            type: 'message.assistant',
            sessionId: 'fake-codex-session-1',
            provider: 'codex',
            message: {
              role: 'assistant',
              content: 'hello world',
            },
          }),
        ]),
      )

      const recordedArgs = JSON.parse(await fsp.readFile(argLogPath, 'utf8'))
      expect(recordedArgs).toEqual([
        'exec',
        '--json',
        'say "hello world" and nothing else',
      ])
    } finally {
      ws.off('message', onMessage)
      await closeWebSocket(ws)
    }
  })
})
