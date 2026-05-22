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
  rejectJsonRpc?: boolean
  requireInitializeBeforeOtherMethods?: boolean
  overrides?: Record<string, { result?: unknown; error?: { code: number; message: string } }>
  threadTurns?: Array<{
    id: string
    status: string
    itemsView?: string
    items: unknown[]
    error: unknown
    startedAt: number
    completedAt: number | null
    durationMs: number | null
  }>
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
    await expect(client.startThread({ cwd: '/repo/worktree' })).resolves.toMatchObject({
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

    await expect(startedThread).resolves.toMatchObject({
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
      thread: expect.objectContaining({
        id: 'thread-resume-1',
        path: '/tmp/codex/rollout-thread-resume-1.jsonl',
        ephemeral: false,
      }),
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

  it('starts rich Codex threads with raw events enabled when requested', async () => {
    const server = await startFakeCodexAppServer({
      overrides: {
        'thread/start': {
          result: {
            thread: { id: 'thread-rich-1', path: null, ephemeral: false },
            cwd: '/repo/worktree',
            model: 'fixture-model',
            modelProvider: 'openai',
            instructionSources: [],
            approvalPolicy: 'never',
            approvalsReviewer: 'user',
            sandbox: 'danger-full-access',
          },
        },
      },
    })
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    await client.initialize()
    await expect(client.startThread({ cwd: '/repo/worktree', richClient: true })).resolves.toMatchObject({
      thread: {
        id: 'thread-rich-1',
        path: null,
        ephemeral: false,
      },
    })
  })

  it('sends Codex app-server envelopes without jsonrpc', async () => {
    const server = await startFakeCodexAppServer({ rejectJsonRpc: true })
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    await client.initialize()
    await expect(client.startThread({ cwd: '/repo/worktree' })).resolves.toMatchObject({
      thread: {
        id: 'thread-new-1',
        path: expect.stringMatching(/\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-thread-new-1\.jsonl$/),
        ephemeral: false,
      },
    })
  })

  it('sends thread/resume and returns the exact resumed thread id', async () => {
    const server = await startFakeCodexAppServer({
      overrides: {
        'thread/resume': {
          result: {
            thread: {
              id: '019d9859-5670-72b1-851f-794ad7fef112',
              path: '/tmp/rollout-019d9859-5670-72b1-851f-794ad7fef112.jsonl',
              ephemeral: false,
            },
            cwd: '/repo/worktree',
            model: 'fixture-model',
            modelProvider: 'openai',
            instructionSources: [],
            approvalPolicy: 'never',
            approvalsReviewer: 'user',
            sandbox: { type: 'dangerFullAccess' },
          },
        },
      },
    })
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    await client.initialize()
    await expect(client.resumeThread({
      threadId: '019d9859-5670-72b1-851f-794ad7fef112',
      cwd: '/repo/worktree',
    })).resolves.toMatchObject({
      thread: {
        id: '019d9859-5670-72b1-851f-794ad7fef112',
        path: expect.stringMatching(/rollout-019d9859-5670-72b1-851f-794ad7fef112\.jsonl$/),
        ephemeral: false,
      },
      sandbox: { type: 'dangerFullAccess' },
    })
  })

  it('re-initializes after the app-server drops the websocket without exiting', async () => {
    const server = await startFakeCodexAppServer({ closeSocketAfterMethodsOnce: ['initialize'] })
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    await client.initialize()
    await new Promise((resolve) => setTimeout(resolve, 25))

    await expect(client.startThread({ cwd: '/repo/worktree' })).resolves.toMatchObject({
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
    await expect(startThreadPromise).resolves.toMatchObject({
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

  it('emits turn started and completed notifications', async () => {
    const server = await startFakeCodexAppServer({
      notificationsAfterMethods: {
        'thread/loaded/list': [
          {
            method: 'turn/started',
            params: { threadId: 'thread-1', turnId: 'turn-1', extra: true },
          },
          {
            method: 'turn/completed',
            params: { threadId: 'thread-1', turnId: 'turn-1', status: 'completed' },
          },
        ],
      },
    })
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })
    const started: unknown[] = []
    const completed: unknown[] = []
    const unsubscribeStarted = client.onTurnStarted((event) => started.push(event))
    const unsubscribeCompleted = client.onTurnCompleted((event) => completed.push(event))

    await client.initialize()
    await client.listLoadedThreads()
    await new Promise((resolve) => setTimeout(resolve, 25))
    unsubscribeStarted()
    unsubscribeCompleted()

    expect(started).toEqual([
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        params: { threadId: 'thread-1', turnId: 'turn-1', extra: true },
      },
    ])
    expect(completed).toEqual([
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        params: { threadId: 'thread-1', turnId: 'turn-1', status: 'completed' },
      },
    ])
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

  it('reads thread snapshots from the app-server thread surface', async () => {
    const server = await startFakeCodexAppServer()
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    await client.initialize()
    await expect(client.readThread({ threadId: 'thread-new-1', includeTurns: false })).resolves.toMatchObject({
      thread: {
        id: 'thread-new-1',
        status: { type: 'idle' },
        turns: [],
      },
    })
  })

  it('lists thread turns from the app-server thread surface', async () => {
    const server = await startFakeCodexAppServer()
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    await client.initialize()
    await expect(client.listThreadTurns({
      threadId: 'thread-new-1',
      itemsView: 'full',
    })).resolves.toMatchObject({
      revision: 1770000007,
      nextCursor: null,
      turns: [expect.objectContaining({
        id: 'turn-1',
        itemsView: 'full',
        items: [expect.objectContaining({ type: 'agentMessage', text: 'Fixture turn' })],
      })],
      bodies: {
        'turn-1': expect.objectContaining({
          id: 'turn-1',
          itemsView: 'full',
          items: [expect.objectContaining({ type: 'agentMessage', text: 'Fixture turn' })],
        }),
      },
    })
  })

  it('lists newest thread turns first when descending sort is requested', async () => {
    const turns = Array.from({ length: 75 }, (_, index) => ({
      id: `turn-${index + 1}`,
      status: index === 74 ? 'inProgress' : 'completed',
      items: [],
      error: null,
      startedAt: 1770000001 + index,
      completedAt: index === 74 ? null : 1770000002 + index,
      durationMs: index === 74 ? null : 1000,
    }))
    const server = await startFakeCodexAppServer({ threadTurns: turns })
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    await client.initialize()
    const page = await client.listThreadTurns({
      threadId: 'thread-long-1',
      limit: 50,
      sortDirection: 'desc',
      itemsView: 'summary',
    })
    expect(page.turns).toHaveLength(50)
    expect(page.turns[0]).toMatchObject({ id: 'turn-75', status: 'inProgress' })
    expect(page.turns[1]).toMatchObject({ id: 'turn-74' })
    expect(page.bodies).toMatchObject({
      'turn-75': expect.objectContaining({ status: 'inProgress' }),
    })
  })

  it('does not use full thread reads when listing thread turns', async () => {
    const server = await startFakeCodexAppServer({
      overrides: {
        'thread/read': {
          error: { code: -32000, message: 'thread/read should not be used for turn paging' },
        },
      },
    })
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    await client.initialize()
    await expect(client.listThreadTurns({
      threadId: 'thread-new-1',
      limit: 1,
      sortDirection: 'desc',
      itemsView: 'full',
    })).resolves.toMatchObject({
      turns: [expect.objectContaining({ id: 'turn-1' })],
    })
  })

  it('reads an individual thread turn from the app-server thread surface', async () => {
    const server = await startFakeCodexAppServer()
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    await client.initialize()
    await expect(client.readThreadTurn({
      threadId: 'thread-new-1',
      turnId: 'turn-1',
      revision: 1770000007,
    })).resolves.toMatchObject({
      turnId: 'turn-1',
      revision: 1770000007,
      itemsView: 'full',
      items: [expect.objectContaining({ type: 'agentMessage', text: 'Fixture turn' })],
    })
  })

  it('rejects an individual thread turn when the list revision no longer matches the requested revision', async () => {
    const client = new CodexAppServerClient({ wsUrl: 'ws://127.0.0.1:1' })
    vi.spyOn(client as any, 'request').mockImplementation(async (method: string) => {
      if (method !== 'thread/turns/list') throw new Error(`unexpected method ${method}`)
      return {
        revision: 8,
        nextCursor: null,
        turns: [{
          id: 'turn-target',
          status: 'completed',
          itemsView: 'full',
          items: [],
          error: null,
          startedAt: 1770000001,
          completedAt: 1770000002,
          durationMs: 1000,
        }],
      }
    })

    await expect(client.readThreadTurn({
      threadId: 'thread-new-1',
      turnId: 'turn-target',
      revision: 7,
    })).rejects.toThrow('list revision does not match requested revision')
  })

  it('falls back to thread/read when thread turn listing is unavailable', async () => {
    const server = await startFakeCodexAppServer({
      overrides: {
        'thread/turns/list': {
          error: { code: -32601, message: 'method not found' },
        },
      },
    })
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    await client.initialize()
    await expect(client.listThreadTurns({
      threadId: 'thread-new-1',
      itemsView: 'full',
    })).resolves.toMatchObject({
      revision: 1770000007,
      turns: [expect.objectContaining({
        id: 'turn-1',
        itemsView: 'full',
        items: [expect.objectContaining({ type: 'agentMessage', text: 'Fixture turn' })],
      })],
    })
  })

  it('falls back to thread/read for thread turn listing when JSON-RPC code reports an unknown method', async () => {
    const server = await startFakeCodexAppServer({
      overrides: {
        'thread/turns/list': {
          error: { code: -32601, message: 'No such procedure' },
        },
      },
    })
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    await client.initialize()
    await expect(client.listThreadTurns({
      threadId: 'thread-new-1',
      itemsView: 'full',
    })).resolves.toMatchObject({
      turns: [expect.objectContaining({ id: 'turn-1' })],
    })
  })

  it('uses one thread/read snapshot for individual thread-turn fallback when listing is unavailable', async () => {
    const client = new CodexAppServerClient({ wsUrl: 'ws://127.0.0.1:1' })
    const turns = Array.from({ length: 75 }, (_, index) => ({
      id: `turn-${index + 1}`,
      status: 'completed',
      itemsView: 'full',
      items: [],
      error: null,
      startedAt: 1770000001 + index,
      completedAt: 1770000002 + index,
      durationMs: 1000,
    }))
    const request = vi.spyOn(client as any, 'request').mockImplementation(async (method: string) => {
      if (method === 'thread/turns/list') throw new Error('method not found')
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'thread-new-1',
            sessionId: 'thread-new-1',
            updatedAt: 1770000007,
            turns,
          },
        }
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(client.readThreadTurn({
      threadId: 'thread-new-1',
      turnId: 'turn-10',
    })).resolves.toMatchObject({
      id: 'turn-10',
      turnId: 'turn-10',
      revision: 1770000007,
    })
    expect(request.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(1)
  })

  it('rejects individual thread-turn fallback when thread/read revision no longer matches the requested revision', async () => {
    const client = new CodexAppServerClient({ wsUrl: 'ws://127.0.0.1:1' })
    vi.spyOn(client as any, 'request').mockImplementation(async (method: string) => {
      if (method === 'thread/turns/list') throw new Error('method not found')
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'thread-new-1',
            sessionId: 'thread-new-1',
            updatedAt: 8,
            turns: [{
              id: 'turn-target',
              status: 'completed',
              itemsView: 'full',
              items: [],
              error: null,
              startedAt: 1770000001,
              completedAt: 1770000002,
              durationMs: 1000,
            }],
          },
        }
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(client.readThreadTurn({
      threadId: 'thread-new-1',
      turnId: 'turn-target',
      revision: 7,
    })).rejects.toThrow('thread/read revision does not match requested revision')
  })

  it('normalizes fractional thread/read updatedAt revisions in the thread-turn listing fallback', async () => {
    const server = await startFakeCodexAppServer({
      overrides: {
        'thread/turns/list': {
          error: { code: -32601, message: 'method not found' },
        },
        'thread/read': {
          result: {
            thread: {
              id: 'thread-new-1',
              sessionId: 'thread-new-1',
              updatedAt: 1770000007.25,
              turns: [{
                id: 'turn-1',
                status: 'completed',
                itemsView: 'full',
                items: [{
                  type: 'agentMessage',
                  id: 'turn-1:item-0',
                  text: 'Fixture turn',
                  phase: null,
                  memoryCitation: null,
                }],
                error: null,
                startedAt: 1770000001,
                completedAt: 1770000002,
                durationMs: 1000,
              }],
            },
          },
        },
      },
    })
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    await client.initialize()
    await expect(client.listThreadTurns({
      threadId: 'thread-new-1',
      itemsView: 'full',
    })).resolves.toMatchObject({
      revision: 1770000007,
      turns: [expect.objectContaining({ id: 'turn-1' })],
    })
  })

  it('does not fall back to thread/read for non-compatibility paging failures', async () => {
    const server = await startFakeCodexAppServer({
      overrides: {
        'thread/turns/list': {
          error: { code: -32000, message: 'temporary paging failure' },
        },
      },
    })
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    await client.initialize()
    await expect(client.listThreadTurns({
      threadId: 'thread-new-1',
      itemsView: 'full',
    })).rejects.toThrow('temporary paging failure')
  })

  it('does not reinterpret opaque app-server cursors through the thread/read fallback', async () => {
    const server = await startFakeCodexAppServer({
      overrides: {
        'thread/turns/list': {
          error: { code: -32601, message: 'method not found' },
        },
      },
    })
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    await client.initialize()
    await expect(client.listThreadTurns({
      threadId: 'thread-new-1',
      cursor: 'opaque-cursor',
      itemsView: 'full',
    })).rejects.toThrow('cannot honor opaque cursor')
  })

  it('does not reinterpret numeric app-server cursors through the thread/read fallback', async () => {
    const server = await startFakeCodexAppServer({
      overrides: {
        'thread/turns/list': {
          error: { code: -32601, message: 'method not found' },
        },
      },
    })
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    await client.initialize()
    await expect(client.listThreadTurns({
      threadId: 'thread-new-1',
      cursor: '1',
      itemsView: 'full',
    })).rejects.toThrow('cannot honor opaque cursor')
  })

  it('uses revision-bound cursors when paging through the thread/read fallback', async () => {
    const client = new CodexAppServerClient({ wsUrl: 'ws://127.0.0.1:1' })
    const turns = Array.from({ length: 3 }, (_, index) => ({
      id: `turn-${index + 1}`,
      status: 'completed',
      itemsView: 'full',
      items: [],
      error: null,
      startedAt: 1770000001 + index,
      completedAt: 1770000002 + index,
      durationMs: 1000,
    }))
    vi.spyOn(client as any, 'request').mockImplementation(async (method: string) => {
      if (method === 'thread/turns/list') throw new Error('method not found')
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'thread-new-1',
            sessionId: 'thread-new-1',
            updatedAt: 1770000007,
            turns,
          },
        }
      }
      throw new Error(`unexpected method ${method}`)
    })

    const firstPage = await client.listThreadTurns({
      threadId: 'thread-new-1',
      limit: 1,
      sortDirection: 'desc',
      itemsView: 'full',
    })
    expect(firstPage.turns.map((turn) => turn.id)).toEqual(['turn-3'])
    expect(firstPage.nextCursor).toBe('thread-read:1770000007:1')

    const secondPage = await client.listThreadTurns({
      threadId: 'thread-new-1',
      limit: 1,
      sortDirection: 'desc',
      cursor: firstPage.nextCursor ?? undefined,
      itemsView: 'full',
    })
    expect(secondPage.turns.map((turn) => turn.id)).toEqual(['turn-2'])
  })

  it('summarizes thread/read fallback items like thread/turns/list summary pages', async () => {
    const client = new CodexAppServerClient({ wsUrl: 'ws://127.0.0.1:1' })
    vi.spyOn(client as any, 'request').mockImplementation(async (method: string) => {
      if (method === 'thread/turns/list') throw new Error('method not found')
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'thread-new-1',
            sessionId: 'thread-new-1',
            updatedAt: 1770000007,
            turns: [{
              id: 'turn-1',
              status: 'completed',
              itemsView: 'full',
              items: [
                { id: 'item-summary', type: 'agentMessage', summary: 'existing summary', text: 'ignored text' },
                { id: 'item-text', type: 'userMessage', text: 'typed prompt' },
                { id: 'item-command', type: 'commandExecution', command: 'npm test' },
                { id: 'item-type', type: 'plan' },
              ],
              error: null,
              startedAt: 1770000001,
              completedAt: 1770000002,
              durationMs: 1000,
            }],
          },
        }
      }
      throw new Error(`unexpected method ${method}`)
    })

    const page = await client.listThreadTurns({
      threadId: 'thread-new-1',
      limit: 1,
      sortDirection: 'desc',
      itemsView: 'summary',
    })

    expect(page.turns[0].items).toEqual([
      { id: 'item-summary', type: 'agentMessage', summary: 'existing summary' },
      { id: 'item-text', type: 'userMessage', summary: 'typed prompt' },
      { id: 'item-command', type: 'commandExecution', summary: 'npm test' },
      { id: 'item-type', type: 'plan', summary: 'plan' },
    ])
  })

  it('keeps thread/read fallback cursors on the fallback path when thread/turns/list becomes available', async () => {
    const client = new CodexAppServerClient({ wsUrl: 'ws://127.0.0.1:1' })
    const turns = Array.from({ length: 3 }, (_, index) => ({
      id: `turn-${index + 1}`,
      status: 'completed',
      itemsView: 'full',
      items: [],
      error: null,
      startedAt: 1770000001 + index,
      completedAt: 1770000002 + index,
      durationMs: 1000,
    }))
    let turnsListCalls = 0
    vi.spyOn(client as any, 'request').mockImplementation(async (method: string) => {
      if (method === 'thread/turns/list') {
        turnsListCalls += 1
        if (turnsListCalls === 1) throw new Error('method not found')
        throw new Error('thread/read fallback cursor was sent to thread/turns/list')
      }
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'thread-new-1',
            sessionId: 'thread-new-1',
            updatedAt: 1770000007,
            turns,
          },
        }
      }
      throw new Error(`unexpected method ${method}`)
    })

    const firstPage = await client.listThreadTurns({
      threadId: 'thread-new-1',
      limit: 1,
      sortDirection: 'desc',
      itemsView: 'full',
    })
    expect(firstPage.nextCursor).toBe('thread-read:1770000007:1')

    const secondPage = await client.listThreadTurns({
      threadId: 'thread-new-1',
      limit: 1,
      sortDirection: 'desc',
      cursor: firstPage.nextCursor ?? undefined,
      itemsView: 'full',
    })

    expect(secondPage.turns.map((turn) => turn.id)).toEqual(['turn-2'])
    expect(turnsListCalls).toBe(1)
  })

  it('defaults thread/read fallback turn pages to newest first', async () => {
    const client = new CodexAppServerClient({ wsUrl: 'ws://127.0.0.1:1' })
    const turns = Array.from({ length: 3 }, (_, index) => ({
      id: `turn-${index + 1}`,
      status: 'completed',
      itemsView: 'full',
      items: [],
      error: null,
      startedAt: 1770000001 + index,
      completedAt: 1770000002 + index,
      durationMs: 1000,
    }))
    vi.spyOn(client as any, 'request').mockImplementation(async (method: string) => {
      if (method === 'thread/turns/list') throw new Error('method not found')
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'thread-new-1',
            sessionId: 'thread-new-1',
            updatedAt: 1770000007,
            turns,
          },
        }
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(client.listThreadTurns({
      threadId: 'thread-new-1',
      limit: 2,
      itemsView: 'full',
    })).resolves.toMatchObject({
      turns: [
        expect.objectContaining({ id: 'turn-3' }),
        expect.objectContaining({ id: 'turn-2' }),
      ],
    })
  })

  it('rejects thread/read fallback paging when the snapshot revision changes', async () => {
    const client = new CodexAppServerClient({ wsUrl: 'ws://127.0.0.1:1' })
    const turns = Array.from({ length: 3 }, (_, index) => ({
      id: `turn-${index + 1}`,
      status: 'completed',
      itemsView: 'full',
      items: [],
      error: null,
      startedAt: 1770000001 + index,
      completedAt: 1770000002 + index,
      durationMs: 1000,
    }))
    let readCount = 0
    vi.spyOn(client as any, 'request').mockImplementation(async (method: string) => {
      if (method === 'thread/turns/list') throw new Error('method not found')
      if (method === 'thread/read') {
        readCount += 1
        return {
          thread: {
            id: 'thread-new-1',
            sessionId: 'thread-new-1',
            updatedAt: readCount === 1 ? 1770000007 : 1770000008,
            turns,
          },
        }
      }
      throw new Error(`unexpected method ${method}`)
    })

    const firstPage = await client.listThreadTurns({
      threadId: 'thread-new-1',
      limit: 1,
      sortDirection: 'desc',
      itemsView: 'full',
    })

    await expect(client.listThreadTurns({
      threadId: 'thread-new-1',
      limit: 1,
      sortDirection: 'desc',
      cursor: firstPage.nextCursor ?? undefined,
      itemsView: 'full',
    })).rejects.toThrow('snapshot changed while paging')
  })

  it('pages until it finds an older individual thread turn', async () => {
    const turns = Array.from({ length: 75 }, (_, index) => ({
      id: `turn-${index + 1}`,
      status: 'completed',
      items: [],
      error: null,
      startedAt: 1770000001 + index,
      completedAt: 1770000002 + index,
      durationMs: 1000,
    }))
    const server = await startFakeCodexAppServer({ threadTurns: turns })
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    await client.initialize()
    await expect(client.readThreadTurn({
      threadId: 'thread-long-1',
      turnId: 'turn-10',
      revision: 1770000007,
    })).resolves.toMatchObject({
      id: 'turn-10',
      turnId: 'turn-10',
      revision: 1770000007,
    })
  })

  it('rejects individual thread-turn paging when list revisions change', async () => {
    const client = new CodexAppServerClient({ wsUrl: 'ws://127.0.0.1:1' })
    let pageCount = 0
    vi.spyOn(client as any, 'request').mockImplementation(async (method: string) => {
      if (method !== 'thread/turns/list') throw new Error(`unexpected method ${method}`)
      pageCount += 1
      return pageCount === 1
        ? {
            revision: 7,
            nextCursor: 'cursor-2',
            turns: [{
              id: 'turn-newer',
              status: 'completed',
              itemsView: 'full',
              items: [],
              error: null,
              startedAt: 1770000001,
              completedAt: 1770000002,
              durationMs: 1000,
            }],
          }
        : {
            revision: 8,
            nextCursor: null,
            turns: [{
              id: 'turn-target',
              status: 'completed',
              itemsView: 'full',
              items: [],
              error: null,
              startedAt: 1770000003,
              completedAt: 1770000004,
              durationMs: 1000,
            }],
          }
    })

    await expect(client.readThreadTurn({
      threadId: 'thread-new-1',
      turnId: 'turn-target',
    })).rejects.toThrow('revision changed while paging')
  })
})
