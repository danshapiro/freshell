import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { allocateLocalhostPort } from '../../../../../server/local-port.js'
import { CodexAppServerClient } from '../../../../../server/coding-cli/codex-app-server/client.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FAKE_SERVER_PATH = path.resolve(__dirname, '../../../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs')

type FakeServerBehavior = {
  closeSocketAfterMethodsOnce?: string[]
  delayMethodsMs?: Record<string, number>
  ignoreMethods?: string[]
  notifyAfterMethodsOnce?: Record<string, Array<{ method: string; params?: unknown }>>
  requireJsonRpc?: boolean
  requireInitializeBeforeOtherMethods?: boolean
  overrides?: Record<string, { result?: unknown; error?: { code: number; message: string } }>
}

type FakeServerHandle = {
  child: ChildProcessWithoutNullStreams
  wsUrl: string
}

const fakeServers = new Set<FakeServerHandle>()

async function waitForWebSocketReady(wsUrl: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl)
        const cleanup = () => {
          ws.off('open', onOpen)
          ws.off('error', onError)
        }
        const onOpen = () => {
          cleanup()
          ws.close()
          resolve()
        }
        const onError = (error: Error) => {
          cleanup()
          ws.close()
          reject(error)
        }
        ws.once('open', onOpen)
        ws.once('error', onError)
      })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  throw new Error(`Timed out waiting for fake Codex app-server at ${wsUrl}`)
}

async function startFakeCodexAppServer(behavior: FakeServerBehavior = {}): Promise<FakeServerHandle> {
  const endpoint = await allocateLocalhostPort()
  const wsUrl = `ws://${endpoint.hostname}:${endpoint.port}`
  const child = spawn(process.execPath, [
    FAKE_SERVER_PATH,
    'app-server',
    '--listen',
    wsUrl,
  ], {
    env: {
      ...process.env,
      FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify(behavior),
    },
    stdio: 'pipe',
  })

  const handle = { child, wsUrl }
  fakeServers.add(handle)
  await waitForWebSocketReady(wsUrl)
  return handle
}

async function stopFakeCodexAppServer(handle: FakeServerHandle): Promise<void> {
  fakeServers.delete(handle)

  if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
    return
  }

  handle.child.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    handle.child.once('exit', () => resolve())
    setTimeout(resolve, 1_000)
  })
}

async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() < deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  if (lastError instanceof Error) throw lastError
  throw new Error('Timed out waiting for assertion')
}

afterEach(async () => {
  await Promise.all([...fakeServers].map((server) => stopFakeCodexAppServer(server)))
})

describe('CodexAppServerClient', () => {
  it('initializes the app-server and returns the negotiated server metadata', async () => {
    const server = await startFakeCodexAppServer()
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    await expect(client.initialize()).resolves.toMatchObject({
      userAgent: expect.any(String),
      codexHome: expect.any(String),
      platformFamily: expect.any(String),
      platformOs: expect.any(String),
    })
  })

  it('sends thread/start and returns the exact thread id', async () => {
    const server = await startFakeCodexAppServer()
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    await client.initialize()
    await expect(client.startThread({ cwd: '/repo/worktree' })).resolves.toEqual({
      thread: {
        id: 'thread-new-1',
        path: expect.stringMatching(/\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-thread-new-1\.jsonl$/),
        ephemeral: false,
      },
    })
  })

  it('surfaces thread/started notifications to sidecar consumers', async () => {
    const server = await startFakeCodexAppServer()
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    const startedThread = new Promise<{ id: string; path: string | null; ephemeral: boolean }>((resolve) => {
      client.onThreadStarted((thread) => resolve(thread))
    })

    await client.initialize()
    await client.startThread({ cwd: '/repo/worktree' })

    await expect(startedThread).resolves.toEqual({
      id: 'thread-new-1',
      path: expect.stringMatching(/\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-thread-new-1\.jsonl$/),
      ephemeral: false,
    })
  })

  it('emits thread lifecycle notifications from app-server notifications', async () => {
    const server = await startFakeCodexAppServer({
      notifyAfterMethodsOnce: {
        initialize: [
          {
            method: 'thread/started',
            params: {
              thread: {
                id: 'thread-resume-1',
                path: '/tmp/codex/rollout-thread-resume-1.jsonl',
                ephemeral: false,
              },
            },
          },
        ],
      },
    })
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })
    const lifecycle = vi.fn()
    client.onThreadLifecycle(lifecycle)

    await client.initialize()

    await waitFor(() => expect(lifecycle).toHaveBeenCalledWith({
      kind: 'thread_started',
      thread: {
        id: 'thread-resume-1',
        path: '/tmp/codex/rollout-thread-resume-1.jsonl',
        ephemeral: false,
      },
    }))
  })

  it('emits thread closed lifecycle notifications from app-server notifications', async () => {
    const server = await startFakeCodexAppServer({
      notifyAfterMethodsOnce: {
        initialize: [
          {
            method: 'thread/closed',
            params: {
              threadId: 'thread-resume-1',
            },
          },
        ],
      },
    })
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })
    const lifecycle = vi.fn()
    client.onThreadLifecycle(lifecycle)

    await client.initialize()

    await waitFor(() => expect(lifecycle).toHaveBeenCalledWith({
      kind: 'thread_closed',
      threadId: 'thread-resume-1',
    }))
  })

  it('emits thread status lifecycle notifications from app-server notifications', async () => {
    const server = await startFakeCodexAppServer({
      notifyAfterMethodsOnce: {
        initialize: [
          {
            method: 'thread/status/changed',
            params: {
              threadId: 'thread-resume-1',
              status: { type: 'notLoaded' },
            },
          },
        ],
      },
    })
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })
    const lifecycle = vi.fn()
    client.onThreadLifecycle(lifecycle)

    await client.initialize()

    await waitFor(() => expect(lifecycle).toHaveBeenCalledWith({
      kind: 'thread_status_changed',
      threadId: 'thread-resume-1',
      status: { type: 'notLoaded' },
    }))
  })

  it('emits a disconnect callback when the app-server client socket closes unexpectedly', async () => {
    const server = await startFakeCodexAppServer({ closeSocketAfterMethodsOnce: ['initialize'] })
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })
    const onDisconnect = vi.fn()
    client.onDisconnect(onDisconnect)

    await client.initialize()

    await waitFor(() => expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'close',
    })))
  })

  it('sends JSON-RPC 2.0 envelopes to the app-server', async () => {
    const server = await startFakeCodexAppServer({ requireJsonRpc: true })
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    await client.initialize()
    await expect(client.startThread({ cwd: '/repo/worktree' })).resolves.toEqual({
      thread: {
        id: 'thread-new-1',
        path: expect.stringMatching(/\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-thread-new-1\.jsonl$/),
        ephemeral: false,
      },
    })
  })

  it('sends thread/resume and returns the exact resumed thread id', async () => {
    const server = await startFakeCodexAppServer()
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    await client.initialize()
    await expect(client.resumeThread({
      threadId: '019d9859-5670-72b1-851f-794ad7fef112',
      cwd: '/repo/worktree',
    })).resolves.toEqual({
      thread: {
        id: '019d9859-5670-72b1-851f-794ad7fef112',
        path: expect.stringMatching(/rollout-019d9859-5670-72b1-851f-794ad7fef112\.jsonl$/),
        ephemeral: false,
      },
    })
  })

  it('re-initializes after the app-server drops the websocket without exiting', async () => {
    const server = await startFakeCodexAppServer({ closeSocketAfterMethodsOnce: ['initialize'] })
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    await client.initialize()
    await new Promise((resolve) => setTimeout(resolve, 25))

    await expect(client.startThread({ cwd: '/repo/worktree' })).resolves.toEqual({
      thread: {
        id: 'thread-new-1',
        path: expect.stringMatching(/\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-thread-new-1\.jsonl$/),
        ephemeral: false,
      },
    })
  })

  it('waits for an in-flight initialize before sending thread/start', async () => {
    const server = await startFakeCodexAppServer({
      delayMethodsMs: { initialize: 50 },
      requireInitializeBeforeOtherMethods: true,
    })
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    const initializePromise = client.initialize()
    const startThreadPromise = client.startThread({ cwd: '/repo/worktree' })

    await expect(initializePromise).resolves.toMatchObject({
      userAgent: expect.any(String),
      codexHome: expect.any(String),
      platformFamily: expect.any(String),
      platformOs: expect.any(String),
    })
    await expect(startThreadPromise).resolves.toEqual({
      thread: {
        id: 'thread-new-1',
        path: expect.stringMatching(/\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-thread-new-1\.jsonl$/),
        ephemeral: false,
      },
    })
  })

  it('sends fs/watch and fs/unwatch envelopes and surfaces fs/changed notifications with the original watchId', async () => {
    const rolloutPath = '/repo/worktree/.codex/sessions/2026/04/23/rollout-thread-new-1.jsonl'
    const server = await startFakeCodexAppServer({
      notifyAfterMethodsOnce: {
        'fs/watch': [
          {
            method: 'fs/changed',
            params: {
              watchId: 'watch-rollout',
              changedPaths: [rolloutPath],
            },
          },
        ],
      },
    })
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    const changedEvent = new Promise<{ watchId: string; changedPaths: string[] }>((resolve) => {
      client.onFsChanged((event) => resolve(event))
    })

    await client.initialize()
    await expect(client.watchPath(rolloutPath, 'watch-rollout')).resolves.toEqual({
      path: rolloutPath,
    })
    await expect(changedEvent).resolves.toEqual({
      watchId: 'watch-rollout',
      changedPaths: [rolloutPath],
    })
    await expect(client.unwatchPath('watch-rollout')).resolves.toBeUndefined()
  })

  it('fails clearly when the app-server never answers a request', async () => {
    const server = await startFakeCodexAppServer({ ignoreMethods: ['thread/start'] })
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl }, { requestTimeoutMs: 50 })

    await client.initialize()
    await expect(client.startThread({ cwd: '/repo/worktree' })).rejects.toThrow(
      'Codex app-server did not respond to thread/start within 50ms.',
    )
  })

  it('fails clearly when the app-server returns a malformed thread payload', async () => {
    const server = await startFakeCodexAppServer({
      overrides: {
        'thread/start': { result: { thread: { notId: true } } },
      },
    })
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    await client.initialize()
    await expect(client.startThread({ cwd: '/repo/worktree' })).rejects.toThrow(
      'Codex app-server returned an invalid thread/start payload.',
    )
  })
})
