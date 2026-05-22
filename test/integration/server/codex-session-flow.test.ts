import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'fs/promises'
import http from 'http'
import os from 'os'
import path from 'path'
import express from 'express'
import WebSocket from 'ws'
import { createRequire } from 'module'
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
  return { logger, sessionLifecycleLogger: logger }
})

process.env.AUTH_TOKEN = 'test-token'

const MESSAGE_TIMEOUT_MS = 5_000
const FAKE_APP_SERVER_PATH = path.resolve(
  process.cwd(),
  'test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs',
)
const requireForFixture = createRequire(import.meta.url)
const WS_MODULE_PATH = requireForFixture.resolve('ws')

async function writeFakeCodexExecutable(binaryPath: string) {
  const script = `#!/usr/bin/env node
const fs = require('fs')
let WebSocket

function appendJsonLine(filePath, value) {
  if (!filePath) return
  fs.appendFileSync(filePath, JSON.stringify(value) + '\\n', 'utf8')
}

function remoteUrlFromArgs(args) {
  const index = args.indexOf('--remote')
  if (index === -1 || index === args.length - 1) return undefined
  return args[index + 1]
}

const argLogPath = process.env.FAKE_CODEX_ARG_LOG
if (argLogPath) {
  fs.writeFileSync(argLogPath, JSON.stringify(process.argv.slice(2)), 'utf8')
}

appendJsonLine(process.env.FAKE_CODEX_LAUNCH_LOG, {
  pid: process.pid,
  args: process.argv.slice(2),
})

let isFirstLaunch = false
if (process.env.FAKE_CODEX_FIRST_LAUNCH_CLAIM_PATH) {
  try {
    fs.writeFileSync(process.env.FAKE_CODEX_FIRST_LAUNCH_CLAIM_PATH, String(process.pid), { flag: 'wx' })
    isFirstLaunch = true
  } catch {
    isFirstLaunch = false
  }
}

const remoteUrl = remoteUrlFromArgs(process.argv.slice(2))
let remoteSocket
let remoteMessageId = 1
let remoteThreadId
let remoteReady = false
if (process.env.FAKE_CODEX_CONNECT_REMOTE === '1' && remoteUrl) {
  WebSocket = require(${JSON.stringify(WS_MODULE_PATH)})
  setTimeout(() => {
    remoteSocket = new WebSocket(remoteUrl)
    remoteSocket.on('open', () => {
      remoteSocket.send(JSON.stringify({
        id: remoteMessageId++,
        method: 'thread/start',
        params: { cwd: process.cwd() },
      }))
    })
    remoteSocket.on('message', (raw) => {
      appendJsonLine(process.env.FAKE_CODEX_REMOTE_LOG, {
        pid: process.pid,
        message: JSON.parse(raw.toString('utf8')),
      })
      const message = JSON.parse(raw.toString('utf8'))
      const threadId = message && message.result && message.result.thread && message.result.thread.id
      if (threadId) {
        remoteThreadId = threadId
        remoteReady = true
      }
    })
    remoteSocket.on('error', (error) => {
      appendJsonLine(process.env.FAKE_CODEX_REMOTE_LOG, {
        pid: process.pid,
        error: error.message,
      })
    })
  }, Number(process.env.FAKE_CODEX_REMOTE_CONNECT_DELAY_MS || 0))
}

process.stdin.on('data', (chunk) => {
  appendJsonLine(process.env.FAKE_CODEX_INPUT_LOG, {
    pid: process.pid,
    data: chunk.toString('utf8'),
  })
  if (remoteSocket && remoteSocket.readyState === WebSocket.OPEN && remoteReady && remoteThreadId) {
    remoteSocket.send(JSON.stringify({
      id: remoteMessageId++,
      method: 'turn/start',
      params: {
        threadId: remoteThreadId,
        input: chunk.toString('utf8'),
      },
    }))
  }
})

process.on('SIGTERM', () => {
  if (remoteSocket) remoteSocket.close()
  process.exit(0)
})
process.stdout.write('codex remote attached\\n')
if (process.env.FAKE_CODEX_STAY_ALIVE === '1') {
  if (
    process.env.FAKE_CODEX_EXIT_WHEN_FILE_EXISTS
    && (process.env.FAKE_CODEX_EXIT_WATCH_FIRST_LAUNCH_ONLY !== '1' || isFirstLaunch)
  ) {
    setInterval(() => {
      if (fs.existsSync(process.env.FAKE_CODEX_EXIT_WHEN_FILE_EXISTS)) {
        process.exit(0)
      }
    }, 10)
  }
  process.stdin.resume()
  setInterval(() => undefined, 1000)
} else {
  setTimeout(() => process.exit(0), 50)
}
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

async function killAllTerminals(registry: TerminalRegistry): Promise<void> {
  await Promise.all(
    registry.list().map((term) => registry.killAndWait(term.terminalId).catch(() => false)),
  )
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

async function waitForPidFile(filePath: string, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const raw = await fsp.readFile(filePath, 'utf8').catch(() => '')
    const pid = Number(raw.trim())
    if (Number.isInteger(pid) && pid > 0) return pid
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for pid file: ${filePath}`)
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function readJsonLines(filePath: string): Promise<any[]> {
  const raw = await fsp.readFile(filePath, 'utf8').catch(() => '')
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

async function waitForJsonLine(
  filePath: string,
  predicate: (line: any) => boolean,
  timeoutMs = 3_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const lines = await readJsonLines(filePath)
    const match = lines.find(predicate)
    if (match) return match
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for matching JSON line in ${filePath}`)
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
  let runtimes: Set<CodexAppServerRuntime>
  let planner: CodexLaunchPlanner | null

  const createPlanner = () => new CodexLaunchPlanner(() => {
    const runtime = new CodexAppServerRuntime({
      command: process.execPath,
      commandArgs: [FAKE_APP_SERVER_PATH],
    })
    runtimes.add(runtime)
    return runtime
  })

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
    runtimes = new Set()
    planner = createPlanner()
    const plannerDelegate = {
      planCreate: (input: Parameters<CodexLaunchPlanner['planCreate']>[0]) => {
        if (!planner) throw new Error('Codex launch planner is not initialized')
        return planner.planCreate(input)
      },
    } as CodexLaunchPlanner
    wsHandler = new WsHandler(server, registry, { codexLaunchPlanner: plannerDelegate })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port
        resolve()
      })
    })
  })

  beforeEach(async () => {
    await killAllTerminals(registry)
    delete process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR
    await planner?.shutdown()
    await Promise.all([...runtimes].map((runtime) => runtime.shutdown()))
    runtimes.clear()
    planner = createPlanner()
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

  afterEach(async () => {
    await killAllTerminals(registry)
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

    await planner?.shutdown()
    await Promise.all([...runtimes].map((runtime) => runtime.shutdown()))
    runtimes.clear()
    registry.shutdown()
    wsHandler.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  it('launches fresh Codex in remote mode without treating the bootstrap id as durable', async () => {
    const launchLogPath = path.join(tempDir, 'fresh-codex-launches.jsonl')
    const previousLaunchLog = process.env.FAKE_CODEX_LAUNCH_LOG
    process.env.FAKE_CODEX_LAUNCH_LOG = launchLogPath
    await fsp.rm(launchLogPath, { force: true })
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

      const launch = await waitForJsonLine(launchLogPath, (line) => line.pid === record?.pty.pid)
      const recordedArgs = launch.args
      expect(recordedArgs.slice(0, 2)).toEqual([
        '--remote',
        expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/),
      ])
      const appsFlagIndex = recordedArgs.indexOf('features.apps=false')
      expect(appsFlagIndex).toBeGreaterThan(0)
      expect(recordedArgs[appsFlagIndex - 1]).toBe('-c')
      expect(recordedArgs).not.toContain('resume')
      expect(recordedArgs).not.toContain('thread-new-1')
      expect(recordedArgs).not.toContain('tui.notification_method=bel')
      expect(recordedArgs).not.toContain("tui.notifications=['agent-turn-complete']")
      expect(recordedArgs).not.toContain('--model')
      expect(recordedArgs).not.toContain('--sandbox')
    } finally {
      await closeWebSocket(ws)
      if (previousLaunchLog === undefined) delete process.env.FAKE_CODEX_LAUNCH_LOG
      else process.env.FAKE_CODEX_LAUNCH_LOG = previousLaunchLog
    }
  })

  it('captures a fresh Codex restore identity from the fake TUI and promotes it after turn completion', async () => {
    const testDir = await fsp.mkdtemp(path.join(tempDir, 'fresh-durable-flow-'))
    const rolloutPath = path.join(testDir, 'rollout.jsonl')
    const remoteLogPath = path.join(testDir, 'remote.jsonl')
    const launchLogPath = path.join(testDir, 'codex-launches.jsonl')
    const previousConnectRemote = process.env.FAKE_CODEX_CONNECT_REMOTE
    const previousRemoteDelay = process.env.FAKE_CODEX_REMOTE_CONNECT_DELAY_MS
    const previousRemoteLog = process.env.FAKE_CODEX_REMOTE_LOG
    const previousStayAlive = process.env.FAKE_CODEX_STAY_ALIVE
    const previousLaunchLog = process.env.FAKE_CODEX_LAUNCH_LOG
    process.env.FAKE_CODEX_CONNECT_REMOTE = '1'
    process.env.FAKE_CODEX_REMOTE_CONNECT_DELAY_MS = '25'
    process.env.FAKE_CODEX_REMOTE_LOG = remoteLogPath
    process.env.FAKE_CODEX_STAY_ALIVE = '1'
    process.env.FAKE_CODEX_LAUNCH_LOG = launchLogPath
    process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR = JSON.stringify({
      threadStartThreadId: 'thread-fake-tui-durable',
      threadStartRolloutPath: rolloutPath,
      writeRolloutOnMethods: {
        'turn/start': {
          path: rolloutPath,
          threadId: 'thread-fake-tui-durable',
        },
      },
      notificationsAfterMethods: {
        'turn/start': [{
          method: 'turn/completed',
          params: {
            threadId: 'thread-fake-tui-durable',
            turnId: 'turn-1',
            status: 'completed',
          },
        }],
      },
    })

    const ws = await createAuthenticatedWs(port)

    try {
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'test-req-codex-fake-tui',
        mode: 'codex',
        cwd: testDir,
      }))

      const created = await waitForMessage(
        ws,
        (msg) => (
          msg.requestId === 'test-req-codex-fake-tui'
          && (msg.type === 'terminal.created' || msg.type === 'error')
        ),
      )
      if (created.type === 'error') {
        throw new Error(`terminal.create failed: ${created.message}`)
      }

      await vi.waitFor(() => {
        expect(registry.get(created.terminalId)?.codexDurability).toMatchObject({
          state: 'captured_pre_turn',
          candidate: {
            candidateThreadId: 'thread-fake-tui-durable',
            rolloutPath,
          },
        })
      })
      await waitForJsonLine(remoteLogPath, (line) => (
        line.pid === registry.get(created.terminalId)?.pty.pid
        && line.message?.result?.thread?.id === 'thread-fake-tui-durable'
      ))

      ws.send(JSON.stringify({
        type: 'terminal.input',
        terminalId: created.terminalId,
        data: 'hello from fake TUI\r',
      }))

      await vi.waitFor(() => {
        expect(registry.get(created.terminalId)?.resumeSessionId).toBe('thread-fake-tui-durable')
      })
      expect(registry.get(created.terminalId)?.codexDurability).toMatchObject({
        state: 'durable',
        durableThreadId: 'thread-fake-tui-durable',
      })
      expect(registry.list().find((term) => term.terminalId === created.terminalId)?.sessionRef).toEqual({
        provider: 'codex',
        sessionId: 'thread-fake-tui-durable',
      })
      expect(await fsp.readFile(rolloutPath, 'utf8')).toContain('"thread-fake-tui-durable"')
    } finally {
      await closeWebSocket(ws)
      if (previousConnectRemote === undefined) delete process.env.FAKE_CODEX_CONNECT_REMOTE
      else process.env.FAKE_CODEX_CONNECT_REMOTE = previousConnectRemote
      if (previousRemoteDelay === undefined) delete process.env.FAKE_CODEX_REMOTE_CONNECT_DELAY_MS
      else process.env.FAKE_CODEX_REMOTE_CONNECT_DELAY_MS = previousRemoteDelay
      if (previousRemoteLog === undefined) delete process.env.FAKE_CODEX_REMOTE_LOG
      else process.env.FAKE_CODEX_REMOTE_LOG = previousRemoteLog
      if (previousStayAlive === undefined) delete process.env.FAKE_CODEX_STAY_ALIVE
      else process.env.FAKE_CODEX_STAY_ALIVE = previousStayAlive
      if (previousLaunchLog === undefined) delete process.env.FAKE_CODEX_LAUNCH_LOG
      else process.env.FAKE_CODEX_LAUNCH_LOG = previousLaunchLog
      delete process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR
      await fsp.rm(testDir, { recursive: true, force: true })
    }
  })

  it('restores a persisted Codex session from canonical sessionRef', async () => {
    const launchLogPath = path.join(tempDir, 'restore-codex-launches.jsonl')
    const previousLaunchLog = process.env.FAKE_CODEX_LAUNCH_LOG
    process.env.FAKE_CODEX_LAUNCH_LOG = launchLogPath
    await fsp.rm(launchLogPath, { force: true })
    process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR = JSON.stringify({
      loadedThreadIds: ['thread-existing-1'],
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
        restore: true,
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

      expect(created.effectiveResumeSessionId).toBeUndefined()

      const record = registry.get(created.terminalId)
      expect(record?.resumeSessionId).toBe('thread-existing-1')

      const launch = await waitForJsonLine(launchLogPath, (line) => line.pid === record?.pty.pid)
      const recordedArgs = launch.args
      expect(recordedArgs.slice(0, 2)).toEqual([
        '--remote',
        expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/),
      ])
      expect(recordedArgs).toContain('resume')
      expect(recordedArgs).toContain('thread-existing-1')
    } finally {
      await closeWebSocket(ws)
      delete process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR
      if (previousLaunchLog === undefined) delete process.env.FAKE_CODEX_LAUNCH_LOG
      else process.env.FAKE_CODEX_LAUNCH_LOG = previousLaunchLog
    }
  })

  it('keeps a real durable Codex PTY clean exit final without recovery replacement', async () => {
    const testDir = await fsp.mkdtemp(path.join(tempDir, 'clean-exit-final-'))
    const metadataDir = path.join(testDir, 'metadata')
    const launchLogPath = path.join(testDir, 'codex-launches.jsonl')
    await fsp.mkdir(metadataDir, { recursive: true })

    const previousLaunchLog = process.env.FAKE_CODEX_LAUNCH_LOG
    process.env.FAKE_CODEX_LAUNCH_LOG = launchLogPath

    const oldRuntime = new CodexAppServerRuntime({
      command: process.execPath,
      commandArgs: [FAKE_APP_SERVER_PATH],
      metadataDir,
      serverInstanceId: 'srv-codex-clean-exit-old',
      env: {
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
          loadedThreadIds: ['thread-existing-1'],
        }),
      },
    })
    const replacementRuntime = new CodexAppServerRuntime({
      command: process.execPath,
      commandArgs: [FAKE_APP_SERVER_PATH],
      metadataDir,
      serverInstanceId: 'srv-codex-clean-exit-replacement',
      env: {
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
          loadedThreadIds: ['thread-existing-1'],
        }),
      },
    })
    runtimes.add(oldRuntime)
    runtimes.add(replacementRuntime)
    const oldPlanner = new CodexLaunchPlanner(oldRuntime)
    const replacementPlanner = new CodexLaunchPlanner(replacementRuntime)
    let terminalId: string | undefined

    try {
      const oldPlan = await oldPlanner.planCreate({ resumeSessionId: 'thread-existing-1' })
      const recovery = {
        planCreate: vi.fn(() => replacementPlanner.planCreate({ resumeSessionId: 'thread-existing-1' })),
        retryDelayMs: 0,
      }
      const term = registry.create({
        mode: 'codex',
        resumeSessionId: 'thread-existing-1',
        cwd: tempDir,
        providerSettings: {
          codexAppServer: {
            wsUrl: oldPlan.remote.wsUrl,
            sidecar: oldPlan.sidecar,
            recovery,
          },
        } as any,
      })
      terminalId = term.terminalId
      const exited = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup()
          reject(new Error('Timed out waiting for clean Codex PTY exit'))
        }, MESSAGE_TIMEOUT_MS)
        const cleanup = () => {
          clearTimeout(timeout)
          registry.off('terminal.exit', onExit)
        }
        const onExit = (event: { terminalId: string; exitCode?: number }) => {
          if (event.terminalId !== term.terminalId) return
          try {
            expect(event.exitCode).toBe(0)
            cleanup()
            resolve()
          } catch (err) {
            cleanup()
            reject(err)
          }
        }
        registry.on('terminal.exit', onExit)
      })
      await oldPlan.sidecar.adopt({ terminalId: term.terminalId, generation: 0 })
      await waitForJsonLine(launchLogPath, (line) => line.pid === term.pty.pid)
      await exited

      expect(recovery.planCreate).not.toHaveBeenCalled()
      expect(registry.get(term.terminalId)?.status).toBe('exited')
      expect(registry.get(term.terminalId)?.exitCode).toBe(0)
    } finally {
      if (terminalId) {
        await registry.killAndWait(terminalId).catch(() => undefined)
      }
      await replacementPlanner.shutdown().catch(() => undefined)
      await oldPlanner.shutdown().catch(() => undefined)
      await replacementRuntime.shutdown().catch(() => undefined)
      await oldRuntime.shutdown().catch(() => undefined)
      runtimes.delete(oldRuntime)
      runtimes.delete(replacementRuntime)
      if (previousLaunchLog === undefined) delete process.env.FAKE_CODEX_LAUNCH_LOG
      else process.env.FAKE_CODEX_LAUNCH_LOG = previousLaunchLog
      await fsp.rm(testDir, { recursive: true, force: true })
    }
  })

  it('recovers a real durable Codex PTY that exits 0 after SIGTERM during an active turn', async () => {
    const testDir = await fsp.mkdtemp(path.join(tempDir, 'sigterm-active-turn-'))
    const metadataDir = path.join(testDir, 'metadata')
    const launchLogPath = path.join(testDir, 'codex-launches.jsonl')
    const remoteLogPath = path.join(testDir, 'codex-remote.jsonl')
    await fsp.mkdir(metadataDir, { recursive: true })

    const previousConnectRemote = process.env.FAKE_CODEX_CONNECT_REMOTE
    const previousRemoteLog = process.env.FAKE_CODEX_REMOTE_LOG
    const previousStayAlive = process.env.FAKE_CODEX_STAY_ALIVE
    const previousLaunchLog = process.env.FAKE_CODEX_LAUNCH_LOG
    const previousBehavior = process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR
    process.env.FAKE_CODEX_CONNECT_REMOTE = '1'
    process.env.FAKE_CODEX_REMOTE_LOG = remoteLogPath
    process.env.FAKE_CODEX_STAY_ALIVE = '1'
    process.env.FAKE_CODEX_LAUNCH_LOG = launchLogPath
    process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR = JSON.stringify({
      threadStartThreadId: 'thread-existing-1',
      loadedThreadIds: ['thread-existing-1'],
      threadTurns: [{
        id: 'turn-1',
        status: 'inProgress',
        items: [],
        error: null,
        startedAt: 1770000001,
        completedAt: null,
        durationMs: null,
      }],
      notificationsAfterMethods: {
        'turn/start': [{
          method: 'turn/started',
          params: {
            threadId: 'thread-existing-1',
            turnId: 'turn-1',
          },
        }],
      },
    })

    const oldRuntime = new CodexAppServerRuntime({
      command: process.execPath,
      commandArgs: [FAKE_APP_SERVER_PATH],
      metadataDir,
      serverInstanceId: 'srv-codex-sigterm-active-old',
    })
    const replacementRuntime = new CodexAppServerRuntime({
      command: process.execPath,
      commandArgs: [FAKE_APP_SERVER_PATH],
      metadataDir,
      serverInstanceId: 'srv-codex-sigterm-active-replacement',
    })
    runtimes.add(oldRuntime)
    runtimes.add(replacementRuntime)
    const oldPlanner = new CodexLaunchPlanner(oldRuntime)
    const replacementPlanner = new CodexLaunchPlanner(replacementRuntime)
    let terminalId: string | undefined
    let oldPtyPid: number | undefined

    try {
      const oldPlan = await oldPlanner.planCreate({ resumeSessionId: 'thread-existing-1' })
      const recovery = {
        planCreate: vi.fn(() => replacementPlanner.planCreate({ resumeSessionId: 'thread-existing-1' })),
        retryDelayMs: 0,
      }
      const term = registry.create({
        mode: 'codex',
        resumeSessionId: 'thread-existing-1',
        cwd: tempDir,
        providerSettings: {
          codexAppServer: {
            wsUrl: oldPlan.remote.wsUrl,
            sidecar: oldPlan.sidecar,
            recovery,
          },
        } as any,
      })
      terminalId = term.terminalId
      oldPtyPid = term.pty.pid
      await oldPlan.sidecar.adopt({ terminalId: term.terminalId, generation: 0 })
      await waitForJsonLine(remoteLogPath, (line) => (
        line.pid === oldPtyPid
        && line.message?.result?.thread?.id === 'thread-existing-1'
      ))

      expect(registry.input(term.terminalId, 'start active turn\n')).toEqual({ status: 'written' })
      await vi.waitFor(() => {
        expect((registry.get(term.terminalId) as any)?.codexActiveTurn).toMatchObject({
          threadId: 'thread-existing-1',
          turnId: 'turn-1',
        })
      })

      process.kill(oldPtyPid, 'SIGTERM')

      await vi.waitFor(() => expect(recovery.planCreate).toHaveBeenCalledTimes(1))
      const replacementLaunch = await waitForJsonLine(
        launchLogPath,
        (line) => line.pid !== oldPtyPid && Array.isArray(line.args) && line.args.includes('thread-existing-1'),
      )
      await vi.waitFor(() => {
        const latest = registry.get(term.terminalId)
        expect(latest?.status).toBe('running')
        expect(latest?.pty.pid).toBe(replacementLaunch.pid)
        expect(latest?.exitCode).toBeUndefined()
      })
    } finally {
      if (oldPtyPid && await isProcessAlive(oldPtyPid)) {
        try {
          process.kill(oldPtyPid, 'SIGKILL')
        } catch {
          // Best-effort cleanup for a fake PTY process that can outlive the assertion window under parallel load.
        }
      }
      if (terminalId) {
        await registry.killAndWait(terminalId).catch(() => undefined)
      }
      await replacementPlanner.shutdown().catch(() => undefined)
      await oldPlanner.shutdown().catch(() => undefined)
      await replacementRuntime.shutdown().catch(() => undefined)
      await oldRuntime.shutdown().catch(() => undefined)
      runtimes.delete(oldRuntime)
      runtimes.delete(replacementRuntime)
      if (previousConnectRemote === undefined) delete process.env.FAKE_CODEX_CONNECT_REMOTE
      else process.env.FAKE_CODEX_CONNECT_REMOTE = previousConnectRemote
      if (previousRemoteLog === undefined) delete process.env.FAKE_CODEX_REMOTE_LOG
      else process.env.FAKE_CODEX_REMOTE_LOG = previousRemoteLog
      if (previousStayAlive === undefined) delete process.env.FAKE_CODEX_STAY_ALIVE
      else process.env.FAKE_CODEX_STAY_ALIVE = previousStayAlive
      if (previousLaunchLog === undefined) delete process.env.FAKE_CODEX_LAUNCH_LOG
      else process.env.FAKE_CODEX_LAUNCH_LOG = previousLaunchLog
      if (previousBehavior === undefined) delete process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR
      else process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR = previousBehavior
      await fsp.rm(testDir, { recursive: true, force: true })
    }
  })

  it('retires the previous wrapper/native app-server during recovery replacement and routes later input only to the replacement', async () => {
    const testDir = await fsp.mkdtemp(path.join(tempDir, 'recovery-retire-'))
    const metadataDir = path.join(testDir, 'metadata')
    const oldNativePidFile = path.join(testDir, 'old-native.pid')
    const launchLogPath = path.join(testDir, 'codex-launches.jsonl')
    const inputLogPath = path.join(testDir, 'codex-input.jsonl')
    const firstLaunchClaimPath = path.join(testDir, 'first-tui.claim')
    await fsp.mkdir(metadataDir, { recursive: true })

    const previousStayAlive = process.env.FAKE_CODEX_STAY_ALIVE
    const previousLaunchLog = process.env.FAKE_CODEX_LAUNCH_LOG
    const previousInputLog = process.env.FAKE_CODEX_INPUT_LOG
    const previousFirstLaunchOnly = process.env.FAKE_CODEX_EXIT_WATCH_FIRST_LAUNCH_ONLY
    const previousFirstLaunchClaim = process.env.FAKE_CODEX_FIRST_LAUNCH_CLAIM_PATH
    process.env.FAKE_CODEX_STAY_ALIVE = '1'
    process.env.FAKE_CODEX_LAUNCH_LOG = launchLogPath
    process.env.FAKE_CODEX_INPUT_LOG = inputLogPath
    process.env.FAKE_CODEX_EXIT_WATCH_FIRST_LAUNCH_ONLY = '1'
    process.env.FAKE_CODEX_FIRST_LAUNCH_CLAIM_PATH = firstLaunchClaimPath

    const oldRuntime = new CodexAppServerRuntime({
      command: process.execPath,
      commandArgs: [FAKE_APP_SERVER_PATH],
      metadataDir,
      serverInstanceId: 'srv-codex-recovery-old',
      env: {
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
          spawnNativeChild: true,
          nativePidFile: oldNativePidFile,
          delayExitOnSigtermMs: 200,
          loadedThreadIds: ['thread-existing-1'],
        }),
      },
    })
    const replacementRuntime = new CodexAppServerRuntime({
      command: process.execPath,
      commandArgs: [FAKE_APP_SERVER_PATH],
      metadataDir,
      serverInstanceId: 'srv-codex-recovery-replacement',
      env: {
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
          spawnNativeChild: true,
          wrapperLeavesNativeOnSigterm: true,
          loadedThreadIds: ['thread-existing-1'],
        }),
      },
    })
    runtimes.add(oldRuntime)
    runtimes.add(replacementRuntime)
    const oldPlanner = new CodexLaunchPlanner(oldRuntime)
    const replacementPlanner = new CodexLaunchPlanner(replacementRuntime)
    let terminalId: string | undefined
    let oldPtyPid: number | undefined

    try {
      const oldPlan = await oldPlanner.planCreate({ resumeSessionId: 'thread-existing-1' })
      const oldNativePid = await waitForPidFile(oldNativePidFile)
      expect(oldNativePid).toEqual(expect.any(Number))
      const recovery = {
        planCreate: vi.fn(() => replacementPlanner.planCreate({ resumeSessionId: 'thread-existing-1' })),
        retryDelayMs: 0,
      }
      const term = registry.create({
        mode: 'codex',
        resumeSessionId: 'thread-existing-1',
        cwd: tempDir,
        providerSettings: {
          codexAppServer: {
            wsUrl: oldPlan.remote.wsUrl,
            sidecar: oldPlan.sidecar,
            recovery,
          },
        } as any,
      })
      terminalId = term.terminalId
      await oldPlan.sidecar.adopt({ terminalId: term.terminalId, generation: 0 })
      oldPtyPid = term.pty.pid
      await waitForJsonLine(launchLogPath, (line) => line.pid === oldPtyPid)

      await (registry as any).runCodexRecoveryAttempt(
        registry.get(term.terminalId),
        'thread-existing-1',
      )
      const replacementLaunch = await waitForJsonLine(
        launchLogPath,
        (line) => line.pid !== oldPtyPid && Array.isArray(line.args) && line.args.includes('thread-existing-1'),
      )

      const latest = registry.get(term.terminalId)
      expect(latest?.status).toBe('running')
      expect(latest?.resumeSessionId).toBe('thread-existing-1')
      expect(registry.findRunningTerminalBySession('codex', 'thread-existing-1')?.terminalId).toBe(term.terminalId)
      const replacementPtyPid = latest?.pty.pid
      expect(replacementPtyPid).toEqual(expect.any(Number))
      expect(replacementPtyPid).toBe(replacementLaunch.pid)

      expect(registry.input(term.terminalId, 'after recovery replacement\n')).toEqual({ status: 'written' })
      await waitForJsonLine(
        inputLogPath,
        (line) => line.pid === replacementPtyPid && line.data.includes('after recovery replacement'),
      )
      const inputLines = await readJsonLines(inputLogPath)
      expect(inputLines.some((line) => line.pid === oldPtyPid && line.data.includes('after recovery replacement'))).toBe(false)
    } finally {
      if (oldPtyPid && await isProcessAlive(oldPtyPid)) {
        try {
          process.kill(oldPtyPid, 'SIGKILL')
        } catch {
          // Best-effort cleanup for a fake PTY process that can outlive the assertion window under parallel load.
        }
      }
      if (terminalId) {
        await registry.killAndWait(terminalId).catch(() => undefined)
      }
      await replacementPlanner.shutdown().catch(() => undefined)
      await oldPlanner.shutdown().catch(() => undefined)
      await replacementRuntime.shutdown().catch(() => undefined)
      await oldRuntime.shutdown().catch(() => undefined)
      runtimes.delete(oldRuntime)
      runtimes.delete(replacementRuntime)
      if (previousStayAlive === undefined) delete process.env.FAKE_CODEX_STAY_ALIVE
      else process.env.FAKE_CODEX_STAY_ALIVE = previousStayAlive
      if (previousLaunchLog === undefined) delete process.env.FAKE_CODEX_LAUNCH_LOG
      else process.env.FAKE_CODEX_LAUNCH_LOG = previousLaunchLog
      if (previousInputLog === undefined) delete process.env.FAKE_CODEX_INPUT_LOG
      else process.env.FAKE_CODEX_INPUT_LOG = previousInputLog
      if (previousFirstLaunchOnly === undefined) delete process.env.FAKE_CODEX_EXIT_WATCH_FIRST_LAUNCH_ONLY
      else process.env.FAKE_CODEX_EXIT_WATCH_FIRST_LAUNCH_ONLY = previousFirstLaunchOnly
      if (previousFirstLaunchClaim === undefined) delete process.env.FAKE_CODEX_FIRST_LAUNCH_CLAIM_PATH
      else process.env.FAKE_CODEX_FIRST_LAUNCH_CLAIM_PATH = previousFirstLaunchClaim
      await fsp.rm(testDir, { recursive: true, force: true })
    }
  })
})
