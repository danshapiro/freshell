import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'fs/promises'
import http from 'http'
import os from 'os'
import path from 'path'
import { createRequire } from 'node:module'
import express from 'express'
import WebSocket from 'ws'
import { WsHandler } from '../../../server/ws-handler.js'
import { TerminalRegistry } from '../../../server/terminal-registry.js'
import { CodexAppServerRuntime } from '../../../server/coding-cli/codex-app-server/runtime.js'
import { CodexLaunchPlanner } from '../../../server/coding-cli/codex-app-server/launch-planner.js'
import { CodexTerminalSidecar } from '../../../server/coding-cli/codex-app-server/sidecar.js'
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
const require = createRequire(import.meta.url)
const WS_MODULE_PATH = require.resolve('ws')

async function writeFakeCodexExecutable(binaryPath: string) {
  const script = `#!/usr/bin/env node
const fs = require('fs')
const WebSocket = require(${JSON.stringify(WS_MODULE_PATH)})

const argLogPath = process.env.FAKE_CODEX_ARG_LOG
if (argLogPath) {
  fs.writeFileSync(argLogPath, JSON.stringify(process.argv.slice(2)), 'utf8')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function maybeDriveRemote() {
  const rawBehavior = process.env.FAKE_CODEX_REMOTE_BEHAVIOR
  if (!rawBehavior) {
    return
  }

  const args = process.argv.slice(2)
  const remoteIndex = args.indexOf('--remote')
  if (remoteIndex === -1 || remoteIndex === args.length - 1) {
    return
  }

  const wsUrl = args[remoteIndex + 1]
  const resumeIndex = args.indexOf('resume')
  const resumeSessionId = resumeIndex === -1 ? undefined : args[resumeIndex + 1]
  const behavior = JSON.parse(rawBehavior)

  if (behavior.recordStdinPath) {
    process.stdin.on('data', (chunk) => {
      fs.appendFileSync(behavior.recordStdinPath, chunk)
    })
    process.stdin.resume()
  }

  const socket = new WebSocket(wsUrl)
  const pending = new Map()
  let nextId = 1

  const waitForOpen = new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })

  socket.on('message', (raw) => {
    let message
    try {
      message = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (typeof message.id !== 'number') {
      return
    }
    const pendingRequest = pending.get(message.id)
    if (!pendingRequest) {
      return
    }
    pending.delete(message.id)
    if (message.error) {
      pendingRequest.reject(new Error(message.error.message || 'remote app-server request failed'))
      return
    }
    pendingRequest.resolve(message.result)
  })

  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      }), (error) => {
        if (!error) {
          return
        }
        pending.delete(id)
        reject(error)
      })
    })
  }

  await waitForOpen
  await request('initialize', {
    clientInfo: { name: 'fake-codex-cli', version: '1.0.0' },
    capabilities: { experimentalApi: true },
  })

  let threadId = resumeSessionId
  if (resumeSessionId) {
    await request('thread/resume', {
      threadId: resumeSessionId,
      cwd: process.cwd(),
      persistExtendedHistory: true,
    })
  } else {
    const started = await request('thread/start', {
      cwd: process.cwd(),
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    })
    threadId = started?.thread?.id
  }

  if ((behavior.sendTurnStart || (behavior.sendTurnStartOnFreshOnly && !resumeSessionId)) && threadId) {
    await request('turn/start', {
      threadId,
      input: 'fake turn',
    })
  }

  if (behavior.recordRemoteThreadIdPath && threadId) {
    fs.writeFileSync(behavior.recordRemoteThreadIdPath, threadId, 'utf8')
  }

  if (behavior.sleepMs) {
    await sleep(behavior.sleepMs)
  }

  await new Promise((resolve) => socket.close(() => resolve()))
}

Promise.resolve()
  .then(() => maybeDriveRemote())
  .then(() => {
    process.stdout.write('codex remote attached\\n')
    setTimeout(() => process.exit(0), 50)
  })
  .catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error)
    process.stderr.write(message + '\\n')
    process.exit(1)
  })
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

async function waitForCondition(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for condition')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readThreadOperations(filePath: string): Promise<Array<{ method: string; threadId: string }>> {
  await waitForFile(filePath)
  return (await fsp.readFile(filePath, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; threadId: string })
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
  let appServerArgLogPath: string
  let remoteThreadLogPath: string
  let remoteInputLogPath: string
  let threadOperationLogPath: string
  let appServerCloseMarkerPath: string
  let providerLossMarkerPath: string
  let codexHomePath: string
  let previousCodexCmd: string | undefined
  let previousFakeCodexArgLog: string | undefined
  let previousFakeCodexAppServerArgLog: string | undefined
  let previousFakeCodexRemoteBehavior: string | undefined
  let previousCodexHome: string | undefined
  let server: http.Server
  let port: number
  let wsHandler: WsHandler
  let registry: TerminalRegistry
  let planner: CodexLaunchPlanner

  beforeAll(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-flow-'))
    fakeCodexPath = path.join(tempDir, 'fake-codex')
    argLogPath = path.join(tempDir, 'args.json')
    appServerArgLogPath = path.join(tempDir, 'app-server-args.json')
    remoteThreadLogPath = path.join(tempDir, 'remote-thread.txt')
    remoteInputLogPath = path.join(tempDir, 'remote-input.txt')
    threadOperationLogPath = path.join(tempDir, 'thread-ops.jsonl')
    appServerCloseMarkerPath = path.join(tempDir, 'app-server-close-once.marker')
    providerLossMarkerPath = path.join(tempDir, 'provider-loss-once.marker')
    codexHomePath = path.join(tempDir, '.codex-home')
    await writeFakeCodexExecutable(fakeCodexPath)

    previousCodexCmd = process.env.CODEX_CMD
    previousFakeCodexArgLog = process.env.FAKE_CODEX_ARG_LOG
    previousFakeCodexAppServerArgLog = process.env.FAKE_CODEX_APP_SERVER_ARG_LOG
    previousFakeCodexRemoteBehavior = process.env.FAKE_CODEX_REMOTE_BEHAVIOR
    previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_CMD = fakeCodexPath
    process.env.FAKE_CODEX_ARG_LOG = argLogPath
    process.env.FAKE_CODEX_APP_SERVER_ARG_LOG = appServerArgLogPath
    process.env.CODEX_HOME = codexHomePath

    const app = express()
    server = http.createServer(app)
    registry = new TerminalRegistry()
    planner = new CodexLaunchPlanner((input) => new CodexTerminalSidecar({
      runtime: new CodexAppServerRuntime({
        command: process.execPath,
        commandArgs: [FAKE_APP_SERVER_PATH, ...input.commandArgs],
        env: input.env,
      }),
    }))
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
    delete process.env.FAKE_CODEX_REMOTE_BEHAVIOR
    await fsp.rm(codexHomePath, { recursive: true, force: true })
    await fsp.mkdir(codexHomePath, { recursive: true })
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
    await fsp.rm(appServerArgLogPath, { force: true })
    await fsp.rm(remoteThreadLogPath, { force: true })
    await fsp.rm(remoteInputLogPath, { force: true })
    await fsp.rm(threadOperationLogPath, { force: true })
    await fsp.rm(appServerCloseMarkerPath, { force: true })
    await fsp.rm(providerLossMarkerPath, { force: true })
  })

  afterEach(() => {
    for (const terminal of registry.list()) {
      registry.remove(terminal.terminalId)
    }
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
    if (previousFakeCodexAppServerArgLog === undefined) {
      delete process.env.FAKE_CODEX_APP_SERVER_ARG_LOG
    } else {
      process.env.FAKE_CODEX_APP_SERVER_ARG_LOG = previousFakeCodexAppServerArgLog
    }
    if (previousFakeCodexRemoteBehavior === undefined) {
      delete process.env.FAKE_CODEX_REMOTE_BEHAVIOR
    } else {
      process.env.FAKE_CODEX_REMOTE_BEHAVIOR = previousFakeCodexRemoteBehavior
    }
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME
    } else {
      process.env.CODEX_HOME = previousCodexHome
    }

    registry.shutdown()
    wsHandler.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  it('launches a fresh codex terminal in remote mode without promoting a provisional thread id to durable identity', async () => {
    process.env.FAKE_CODEX_REMOTE_BEHAVIOR = JSON.stringify({
      recordRemoteThreadIdPath: remoteThreadLogPath,
    })
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

      expect(created).not.toHaveProperty('effectiveResumeSessionId')

      const record = registry.get(created.terminalId)
      expect(record?.resumeSessionId).toBeUndefined()
      await waitForFile(remoteThreadLogPath)
      expect(await fsp.readFile(remoteThreadLogPath, 'utf8')).toBe('thread-new-1')
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

      await waitForFile(appServerArgLogPath)
      const appServerLaunch = JSON.parse(await fsp.readFile(appServerArgLogPath, 'utf8'))
      expect(appServerLaunch.argv).toContain('app-server')
      expect(appServerLaunch.argv).toContain('mcp_servers.freshell.command="node"')
      expect(appServerLaunch.argv.some((arg: string) => arg.startsWith('mcp_servers.freshell.args=['))).toBe(true)
      expect(appServerLaunch.argv.indexOf('mcp_servers.freshell.command="node"')).toBeLessThan(
        appServerLaunch.argv.indexOf('app-server'),
      )
      expect(appServerLaunch.env.FRESHELL_TERMINAL_ID).toBe(created.terminalId)
      expect(appServerLaunch.env.FRESHELL_TOKEN).toBe('test-token')
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('promotes a fresh codex terminal only after notification plus durable artifact proof', async () => {
    process.env.FAKE_CODEX_REMOTE_BEHAVIOR = JSON.stringify({
      sendTurnStart: true,
      recordRemoteThreadIdPath: remoteThreadLogPath,
      sleepMs: 500,
    })
    const ws = await createAuthenticatedWs(port)

    try {
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'test-req-codex-promotion',
        mode: 'codex',
        cwd: tempDir,
      }))

      const created = await waitForMessage(
        ws,
        (msg) => (
          msg.requestId === 'test-req-codex-promotion'
          && (msg.type === 'terminal.created' || msg.type === 'error')
        ),
      )
      if (created.type === 'error') {
        throw new Error(`terminal.create failed: ${created.message}`)
      }

      expect(created).not.toHaveProperty('effectiveResumeSessionId')

      await waitForFile(remoteThreadLogPath)
      expect(await fsp.readFile(remoteThreadLogPath, 'utf8')).toBe('thread-new-1')
      await waitForCondition(() => registry.get(created.terminalId)?.resumeSessionId === 'thread-new-1')

      const record = registry.get(created.terminalId)
      expect(record?.resumeSessionId).toBe('thread-new-1')
    } finally {
      await closeWebSocket(ws)
      delete process.env.FAKE_CODEX_REMOTE_BEHAVIOR
    }
  })

  it('keeps the terminal alive when the owning Codex sidecar dies after launch', async () => {
    process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR = JSON.stringify({
      appendThreadOperationLogPath: threadOperationLogPath,
      assertNoDuplicateActiveThread: true,
      exitProcessAfterMethodsOnce: ['turn/start'],
    })
    process.env.FAKE_CODEX_REMOTE_BEHAVIOR = JSON.stringify({
      recordRemoteThreadIdPath: remoteThreadLogPath,
      recordStdinPath: remoteInputLogPath,
      sendTurnStartOnFreshOnly: true,
      sleepMs: 5_000,
    })
    const ws = await createAuthenticatedWs(port)
    const receivedMessages: any[] = []
    ws.on('message', (raw) => {
      receivedMessages.push(JSON.parse(raw.toString()))
    })

    try {
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'test-req-codex-sidecar-dies',
        mode: 'codex',
        cwd: tempDir,
      }))

      const created = await waitForMessage(
        ws,
        (msg) => (
          msg.requestId === 'test-req-codex-sidecar-dies'
          && (msg.type === 'terminal.created' || msg.type === 'error')
        ),
      )
      if (created.type === 'error') {
        throw new Error(`terminal.create failed: ${created.message}`)
      }

      await waitForCondition(() => registry.get(created.terminalId)?.resumeSessionId === 'thread-new-1')
      await waitForCondition(() => receivedMessages.some((msg) => (
        msg.type === 'terminal.status'
        && msg.terminalId === created.terminalId
        && msg.status === 'recovering'
      )))
      await waitForCondition(() => receivedMessages.some((msg) => (
        msg.type === 'terminal.status'
        && msg.terminalId === created.terminalId
        && msg.status === 'running'
      )))
      expect(receivedMessages.some((msg) => (
        msg.type === 'terminal.exit'
        && msg.terminalId === created.terminalId
      ))).toBe(false)

      const record = registry.get(created.terminalId)
      expect(record?.status).toBe('running')
      expect(record?.codex?.durableSessionId).toBe('thread-new-1')
      expect(record?.terminalId).toBe(created.terminalId)

      ws.send(JSON.stringify({
        type: 'terminal.input',
        terminalId: created.terminalId,
        data: 'after-recovery-input\n',
      }))
      await waitForCondition(async () => {
        try {
          return (await fsp.readFile(remoteInputLogPath, 'utf8')).includes('after-recovery-input')
        } catch {
          return false
        }
      })

      await waitForCondition(async () => {
        const operations = await readThreadOperations(threadOperationLogPath).catch(() => [])
        return operations.some((entry) => (
          entry.method === 'thread/resume'
          && entry.threadId === 'thread-new-1'
        ))
      })
      const operations = await readThreadOperations(threadOperationLogPath)
      expect(operations.some((entry) => entry.method === 'thread/start')).toBe(true)
      expect(operations.some((entry) => entry.method === 'thread/resume' && entry.threadId === 'thread-new-1')).toBe(true)
    } finally {
      await closeWebSocket(ws)
      delete process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR
      delete process.env.FAKE_CODEX_REMOTE_BEHAVIOR
    }
  })

  it('recovers when the Codex app-server client socket disconnects while the child stays alive', async () => {
    process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR = JSON.stringify({
      appendThreadOperationLogPath: threadOperationLogPath,
      assertNoDuplicateActiveThread: true,
      closeSocketAfterMethodsOnce: ['fs/watch'],
      closeSocketAfterMethodsOnceMarkerPath: appServerCloseMarkerPath,
    })
    process.env.FAKE_CODEX_REMOTE_BEHAVIOR = JSON.stringify({
      recordStdinPath: remoteInputLogPath,
      sleepMs: 5_000,
    })
    const ws = await createAuthenticatedWs(port)
    const receivedMessages: any[] = []
    ws.on('message', (raw) => {
      receivedMessages.push(JSON.parse(raw.toString()))
    })

    try {
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'test-req-codex-app-server-client-disconnect',
        mode: 'codex',
        cwd: tempDir,
        sessionRef: {
          provider: 'codex',
          sessionId: 'thread-existing-1',
        },
      }))

      const created = await waitForMessage(
        ws,
        (msg) => (
          msg.requestId === 'test-req-codex-app-server-client-disconnect'
          && (msg.type === 'terminal.created' || msg.type === 'error')
        ),
      )
      if (created.type === 'error') {
        throw new Error(`terminal.create failed: ${created.message}`)
      }

      await waitForCondition(() => receivedMessages.some((msg) => (
        msg.type === 'terminal.status'
        && msg.terminalId === created.terminalId
        && msg.status === 'recovering'
        && msg.reason === 'app_server_client_disconnect'
      )))
      await waitForCondition(() => receivedMessages.some((msg) => (
        msg.type === 'terminal.status'
        && msg.terminalId === created.terminalId
        && msg.status === 'running'
      )))
      expect(receivedMessages.some((msg) => (
        msg.type === 'terminal.exit'
        && msg.terminalId === created.terminalId
      ))).toBe(false)

      const record = registry.get(created.terminalId)
      expect(record?.status).toBe('running')
      expect(record?.codex?.durableSessionId).toBe('thread-existing-1')
      expect(record?.terminalId).toBe(created.terminalId)

      ws.send(JSON.stringify({
        type: 'terminal.input',
        terminalId: created.terminalId,
        data: 'after-client-disconnect-recovery\n',
      }))
      await waitForCondition(async () => {
        try {
          return (await fsp.readFile(remoteInputLogPath, 'utf8')).includes('after-client-disconnect-recovery')
        } catch {
          return false
        }
      })

      const operations = await readThreadOperations(threadOperationLogPath)
      expect(operations.filter((entry) => (
        entry.method === 'thread/resume'
        && entry.threadId === 'thread-existing-1'
      )).length).toBeGreaterThanOrEqual(2)
      expect(operations.some((entry) => entry.method === 'thread/start')).toBe(false)
    } finally {
      await closeWebSocket(ws)
      delete process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR
      delete process.env.FAKE_CODEX_REMOTE_BEHAVIOR
    }
  })

  it('recovers when the provider reports the active durable thread closed', async () => {
    process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR = JSON.stringify({
      appendThreadOperationLogPath: threadOperationLogPath,
      assertNoDuplicateActiveThread: true,
      threadClosedAfterMethodsOnce: ['thread/resume'],
      threadClosedAfterMethodsOnceMarkerPath: providerLossMarkerPath,
    })
    process.env.FAKE_CODEX_REMOTE_BEHAVIOR = JSON.stringify({
      recordStdinPath: remoteInputLogPath,
      sleepMs: 5_000,
    })
    const ws = await createAuthenticatedWs(port)
    const receivedMessages: any[] = []
    ws.on('message', (raw) => {
      receivedMessages.push(JSON.parse(raw.toString()))
    })

    try {
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'test-req-codex-thread-closed-recovery',
        mode: 'codex',
        cwd: tempDir,
        sessionRef: {
          provider: 'codex',
          sessionId: 'thread-existing-1',
        },
      }))

      const created = await waitForMessage(
        ws,
        (msg) => (
          msg.requestId === 'test-req-codex-thread-closed-recovery'
          && (msg.type === 'terminal.created' || msg.type === 'error')
        ),
      )
      if (created.type === 'error') {
        throw new Error(`terminal.create failed: ${created.message}`)
      }

      await waitForCondition(() => receivedMessages.some((msg) => (
        msg.type === 'terminal.status'
        && msg.terminalId === created.terminalId
        && msg.status === 'recovering'
        && msg.reason === 'provider_thread_lifecycle_loss'
      )))
      await waitForCondition(() => receivedMessages.some((msg) => (
        msg.type === 'terminal.status'
        && msg.terminalId === created.terminalId
        && msg.status === 'running'
      )))
      expect(receivedMessages.some((msg) => (
        msg.type === 'terminal.exit'
        && msg.terminalId === created.terminalId
      ))).toBe(false)

      ws.send(JSON.stringify({
        type: 'terminal.input',
        terminalId: created.terminalId,
        data: 'after-thread-closed-recovery\n',
      }))
      await waitForCondition(async () => {
        try {
          return (await fsp.readFile(remoteInputLogPath, 'utf8')).includes('after-thread-closed-recovery')
        } catch {
          return false
        }
      })

      const record = registry.get(created.terminalId)
      expect(record?.status).toBe('running')
      expect(record?.codex?.durableSessionId).toBe('thread-existing-1')
      expect(record?.terminalId).toBe(created.terminalId)

      const operations = await readThreadOperations(threadOperationLogPath)
      expect(operations.filter((entry) => (
        entry.method === 'thread/resume'
        && entry.threadId === 'thread-existing-1'
      ))).toHaveLength(2)
      expect(operations.some((entry) => entry.method === 'thread/start')).toBe(false)
    } finally {
      await closeWebSocket(ws)
      delete process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR
      delete process.env.FAKE_CODEX_REMOTE_BEHAVIOR
    }
  })

  it.each(['notLoaded', 'systemError'])(
    'recovers when the provider reports active durable thread status %s',
    async (statusType) => {
      process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR = JSON.stringify({
        appendThreadOperationLogPath: threadOperationLogPath,
        assertNoDuplicateActiveThread: true,
        threadStatusChangedAfterMethodsOnceMarkerPath: providerLossMarkerPath,
        threadStatusChangedAfterMethodsOnce: {
          'thread/resume': [
            {
              threadId: 'thread-existing-1',
              status: { type: statusType },
            },
          ],
        },
      })
      process.env.FAKE_CODEX_REMOTE_BEHAVIOR = JSON.stringify({
        recordStdinPath: remoteInputLogPath,
        sleepMs: 5_000,
      })
      const ws = await createAuthenticatedWs(port)
      const receivedMessages: any[] = []
      ws.on('message', (raw) => {
        receivedMessages.push(JSON.parse(raw.toString()))
      })

      try {
        ws.send(JSON.stringify({
          type: 'terminal.create',
          requestId: `test-req-codex-thread-status-${statusType}`,
          mode: 'codex',
          cwd: tempDir,
          sessionRef: {
            provider: 'codex',
            sessionId: 'thread-existing-1',
          },
        }))

        const created = await waitForMessage(
          ws,
          (msg) => (
            msg.requestId === `test-req-codex-thread-status-${statusType}`
            && (msg.type === 'terminal.created' || msg.type === 'error')
          ),
        )
        if (created.type === 'error') {
          throw new Error(`terminal.create failed: ${created.message}`)
        }

        await waitForCondition(() => receivedMessages.some((msg) => (
          msg.type === 'terminal.status'
          && msg.terminalId === created.terminalId
          && msg.status === 'recovering'
          && msg.reason === 'provider_thread_lifecycle_loss'
        )))
        await waitForCondition(() => receivedMessages.some((msg) => (
          msg.type === 'terminal.status'
          && msg.terminalId === created.terminalId
          && msg.status === 'running'
        )))
        expect(receivedMessages.some((msg) => (
          msg.type === 'terminal.exit'
          && msg.terminalId === created.terminalId
        ))).toBe(false)

        const operations = await readThreadOperations(threadOperationLogPath)
        expect(operations.filter((entry) => (
          entry.method === 'thread/resume'
          && entry.threadId === 'thread-existing-1'
        ))).toHaveLength(2)
        expect(operations.some((entry) => entry.method === 'thread/start')).toBe(false)
      } finally {
        await closeWebSocket(ws)
        delete process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR
        delete process.env.FAKE_CODEX_REMOTE_BEHAVIOR
      }
    },
  )

  it('ignores provider lifecycle-loss notifications for other durable threads', async () => {
    process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR = JSON.stringify({
      appendThreadOperationLogPath: threadOperationLogPath,
      assertNoDuplicateActiveThread: true,
      notifyAfterMethodsOnce: {
        'thread/resume': [
          {
            method: 'thread/closed',
            params: { threadId: 'thread-other-1' },
          },
          {
            method: 'thread/status/changed',
            params: {
              threadId: 'thread-other-2',
              status: { type: 'notLoaded' },
            },
          },
        ],
      },
    })
    process.env.FAKE_CODEX_REMOTE_BEHAVIOR = JSON.stringify({
      sleepMs: 800,
    })
    const ws = await createAuthenticatedWs(port)
    const receivedMessages: any[] = []
    ws.on('message', (raw) => {
      receivedMessages.push(JSON.parse(raw.toString()))
    })

    try {
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'test-req-codex-ignore-other-thread-loss',
        mode: 'codex',
        cwd: tempDir,
        sessionRef: {
          provider: 'codex',
          sessionId: 'thread-existing-1',
        },
      }))

      const created = await waitForMessage(
        ws,
        (msg) => (
          msg.requestId === 'test-req-codex-ignore-other-thread-loss'
          && (msg.type === 'terminal.created' || msg.type === 'error')
        ),
      )
      if (created.type === 'error') {
        throw new Error(`terminal.create failed: ${created.message}`)
      }

      await waitForCondition(async () => {
        const operations = await readThreadOperations(threadOperationLogPath)
        return operations.some((entry) => (
          entry.method === 'thread/resume'
          && entry.threadId === 'thread-existing-1'
        ))
      })
      await sleep(350)

      const record = registry.get(created.terminalId)
      expect(record?.status).toBe('running')
      expect(record?.codex?.workerGeneration).toBe(1)
      expect(record?.codex?.recoveryState).toBe('running_durable')
      expect(receivedMessages.some((msg) => (
        msg.type === 'terminal.status'
        && msg.terminalId === created.terminalId
        && msg.status === 'recovering'
      ))).toBe(false)
      expect(receivedMessages.some((msg) => (
        msg.type === 'terminal.exit'
        && msg.terminalId === created.terminalId
      ))).toBe(false)
    } finally {
      await closeWebSocket(ws)
      delete process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR
      delete process.env.FAKE_CODEX_REMOTE_BEHAVIOR
    }
  })

  it('recovers a durable Codex PTY exit by resuming the existing upstream thread', async () => {
    process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR = JSON.stringify({
      assertNoDuplicateActiveThread: true,
      appendThreadOperationLogPath: threadOperationLogPath,
    })
    process.env.FAKE_CODEX_REMOTE_BEHAVIOR = JSON.stringify({
      sleepMs: 100,
    })
    const ws = await createAuthenticatedWs(port)

    try {
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'test-req-codex-durable-recovery',
        mode: 'codex',
        cwd: tempDir,
        sessionRef: {
          provider: 'codex',
          sessionId: 'thread-existing-1',
        },
      }))

      const created = await waitForMessage(
        ws,
        (msg) => (
          msg.requestId === 'test-req-codex-durable-recovery'
          && (msg.type === 'terminal.created' || msg.type === 'error')
        ),
      )
      if (created.type === 'error') {
        throw new Error(`terminal.create failed: ${created.message}`)
      }

      await waitForMessage(
        ws,
        (msg) => msg.type === 'terminal.status'
          && msg.terminalId === created.terminalId
          && msg.status === 'recovering',
      )
      await waitForMessage(
        ws,
        (msg) => msg.type === 'terminal.status'
          && msg.terminalId === created.terminalId
          && msg.status === 'running',
      )
      await waitForCondition(() => (registry.get(created.terminalId)?.codex?.workerGeneration ?? 0) >= 2)

      const record = registry.get(created.terminalId)
      expect(record?.status).toBe('running')
      expect(record?.codex?.durableSessionId).toBe('thread-existing-1')
      expect(record?.terminalId).toBe(created.terminalId)

      await waitForFile(threadOperationLogPath)
      const operations = (await fsp.readFile(threadOperationLogPath, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { method: string; threadId: string })
      expect(operations.some((entry) => entry.method === 'thread/resume' && entry.threadId === 'thread-existing-1')).toBe(true)
      expect(operations.some((entry) => entry.method === 'thread/start')).toBe(false)
    } finally {
      await closeWebSocket(ws)
      delete process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR
      delete process.env.FAKE_CODEX_REMOTE_BEHAVIOR
    }
  })

  it('restores a persisted Codex session through the exact durable CLI form', async () => {
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
    process.env.FAKE_CODEX_REMOTE_BEHAVIOR = JSON.stringify({
      sleepMs: 300,
    })
    const ws = await createAuthenticatedWs(port)

    try {
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'test-req-codex-restore',
        mode: 'codex',
        cwd: tempDir,
        sessionRef: {
          provider: 'codex',
          sessionId: 'thread-existing-1',
        },
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

      expect(created).not.toHaveProperty('effectiveResumeSessionId')

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
      delete process.env.FAKE_CODEX_REMOTE_BEHAVIOR
    }
  })
})
