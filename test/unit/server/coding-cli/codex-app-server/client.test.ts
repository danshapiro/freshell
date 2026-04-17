import { afterEach, describe, expect, it } from 'vitest'
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
  ignoreMethods?: string[]
  requireJsonRpc?: boolean
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

afterEach(async () => {
  await Promise.all([...fakeServers].map((server) => stopFakeCodexAppServer(server)))
})

describe('CodexAppServerClient', () => {
  it('initializes the app-server and returns the reported protocol version', async () => {
    const server = await startFakeCodexAppServer()
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    await expect(client.initialize()).resolves.toMatchObject({
      protocolVersion: expect.any(String),
    })
  })

  it('sends thread/start and returns the exact thread id', async () => {
    const server = await startFakeCodexAppServer()
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    await client.initialize()
    await expect(client.startThread({ cwd: '/repo/worktree' })).resolves.toEqual({
      threadId: 'thread-new-1',
    })
  })

  it('sends JSON-RPC 2.0 envelopes to the app-server', async () => {
    const server = await startFakeCodexAppServer({ requireJsonRpc: true })
    const client = new CodexAppServerClient({ wsUrl: server.wsUrl })

    await client.initialize()
    await expect(client.startThread({ cwd: '/repo/worktree' })).resolves.toEqual({
      threadId: 'thread-new-1',
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
      threadId: '019d9859-5670-72b1-851f-794ad7fef112',
    })
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
