import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'fs/promises'
import http from 'http'
import os from 'os'
import path from 'path'
import express from 'express'
import WebSocket from 'ws'
import { WsHandler } from '../../../server/ws-handler.js'
import { TerminalRegistry } from '../../../server/terminal-registry.js'
import { CodexAppServerRuntime } from '../../../server/coding-cli/codex-app-server/runtime.js'
import { CodexLaunchPlanner } from '../../../server/coding-cli/codex-app-server/launch-planner.js'
import { configStore } from '../../../server/config-store.js'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'

vi.mock('../../../server/config-store.js', () => ({
  configStore: {
    snapshot: vi.fn(),
    pushRecentDirectory: vi.fn().mockResolvedValue(undefined),
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
const FAKE_APP_SERVER_PATH = path.resolve(
  process.cwd(),
  'test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs',
)

async function writeFakeCodexExecutable(binaryPath: string) {
  const script = `#!/usr/bin/env node
const fs = require('fs')

const argLogPath = process.env.FAKE_CODEX_ARG_LOG
if (argLogPath) {
  fs.writeFileSync(argLogPath, JSON.stringify(process.argv.slice(2)), 'utf8')
}

process.stdout.write('codex remote attached\\n')
setTimeout(() => process.exit(0), 50)
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

async function waitForFile(filePath: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fsp.access(filePath)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw new Error(`Timed out waiting for file: ${filePath}`)
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
  let runtime: CodexAppServerRuntime
  let planner: CodexLaunchPlanner

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
    runtime = new CodexAppServerRuntime({
      command: process.execPath,
      commandArgs: [FAKE_APP_SERVER_PATH],
    })
    planner = new CodexLaunchPlanner(runtime)
    wsHandler = new WsHandler(server, registry, { codexLaunchPlanner: planner })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port
        resolve()
      })
    })
  })

  beforeEach(async () => {
    delete process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR
    await runtime.shutdown()
    vi.mocked(configStore.snapshot).mockResolvedValue({
      settings: {
        codingCli: {
          enabledProviders: ['codex'],
          providers: {
            codex: {
              model: 'gpt-5-codex',
              sandbox: 'workspace-write',
            },
          },
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

    await runtime.shutdown()
    registry.shutdown()
    wsHandler.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  it('launches a fresh codex terminal in remote mode without promoting a provisional thread id to durable identity', async () => {
    const ws = await createAuthenticatedWs(port)

    try {
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'test-req-codex',
        mode: 'codex',
        cwd: tempDir,
      }))

      const created = await waitForMessage(
        ws,
        (msg) => (
          msg.requestId === 'test-req-codex'
          && (msg.type === 'terminal.created' || msg.type === 'error')
        ),
      )
      if (created.type === 'error') {
        throw new Error(`terminal.create failed: ${created.message}`)
      }

      expect(created.effectiveResumeSessionId).toBeUndefined()

      const record = registry.get(created.terminalId)
      expect(record?.resumeSessionId).toBeUndefined()

      await waitForFile(argLogPath)
      const recordedArgs = JSON.parse(await fsp.readFile(argLogPath, 'utf8'))
      expect(recordedArgs.slice(0, 2)).toEqual([
        '--remote',
        expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/),
      ])
      expect(recordedArgs).not.toContain('resume')
      expect(recordedArgs).not.toContain('thread-new-1')
      expect(recordedArgs).toContain('tui.notification_method=bel')
      expect(recordedArgs).not.toContain('--model')
      expect(recordedArgs).not.toContain('--sandbox')
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('restores a persisted Codex session without calling thread/resume on the app-server', async () => {
    process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR = JSON.stringify({
      overrides: {
        'thread/resume': {
          error: {
            code: -32600,
            message: 'no rollout found for thread id thread-existing-1',
          },
        },
      },
    })

    const ws = await createAuthenticatedWs(port)

    try {
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'test-req-codex-restore',
        mode: 'codex',
        cwd: tempDir,
        resumeSessionId: 'thread-existing-1',
      }))

      const created = await waitForMessage(
        ws,
        (msg) => (
          msg.requestId === 'test-req-codex-restore'
          && (msg.type === 'terminal.created' || msg.type === 'error')
        ),
      )
      if (created.type === 'error') {
        throw new Error(`terminal.create failed: ${created.message}`)
      }

      expect(created.effectiveResumeSessionId).toBe('thread-existing-1')

      const record = registry.get(created.terminalId)
      expect(record?.resumeSessionId).toBe('thread-existing-1')

      await waitForFile(argLogPath)
      const recordedArgs = JSON.parse(await fsp.readFile(argLogPath, 'utf8'))
      expect(recordedArgs.slice(0, 2)).toEqual([
        '--remote',
        expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/),
      ])
      expect(recordedArgs).toContain('resume')
      expect(recordedArgs).toContain('thread-existing-1')
    } finally {
      await closeWebSocket(ws)
      delete process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR
    }
  })
})
