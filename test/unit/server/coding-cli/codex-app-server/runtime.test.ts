import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CodexAppServerRuntime } from '../../../../../server/coding-cli/codex-app-server/runtime.js'
import { allocateLocalhostPort, type OpencodeServerEndpoint } from '../../../../../server/local-port.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FAKE_SERVER_PATH = path.resolve(__dirname, '../../../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs')

const runtimes = new Set<CodexAppServerRuntime>()
const blockers = new Set<http.Server>()

async function closeBlocker(server: http.Server): Promise<void> {
  blockers.delete(server)
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

afterEach(async () => {
  await Promise.all([...runtimes].map(async (runtime) => {
    runtimes.delete(runtime)
    await runtime.shutdown()
  }))
  await Promise.all([...blockers].map((blocker) => closeBlocker(blocker)))
})

async function occupyLoopbackPort(): Promise<{ blocker: http.Server; endpoint: OpencodeServerEndpoint }> {
  const blocker = http.createServer((_req, res) => {
    res.statusCode = 404
    res.end()
  })

  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject)
    blocker.listen(0, '127.0.0.1', () => resolve())
  })

  blockers.add(blocker)
  const address = blocker.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to occupy loopback port for test')
  }

  return {
    blocker,
    endpoint: {
      hostname: '127.0.0.1',
      port: address.port,
    },
  }
}

function createRuntime(options: ConstructorParameters<typeof CodexAppServerRuntime>[0] = {}): CodexAppServerRuntime {
  const runtime = new CodexAppServerRuntime({
    command: process.execPath,
    commandArgs: [FAKE_SERVER_PATH],
    ...options,
  })
  runtimes.add(runtime)
  return runtime
}

describe('CodexAppServerRuntime', () => {
  it('starts one shared loopback app-server runtime on first use', async () => {
    const runtime = createRuntime()

    const ready = await runtime.ensureReady()

    expect(ready.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/)
    expect(ready.processPid).toBeGreaterThan(0)
    expect(runtime.status()).toBe('running')
  })

  it('reuses the same process for repeated ensureReady calls', async () => {
    const runtime = createRuntime()

    const first = await runtime.ensureReady()
    const second = await runtime.ensureReady()

    expect(second.processPid).toBe(first.processPid)
    expect(second.wsUrl).toBe(first.wsUrl)
  })

  it('shuts down the child process cleanly', async () => {
    const runtime = createRuntime()
    await runtime.ensureReady()

    await runtime.shutdown()

    expect(runtime.status()).toBe('stopped')
  })

  it('proxies thread/start through the shared client after boot', async () => {
    const runtime = createRuntime()

    await expect(runtime.startThread({ cwd: '/repo/worktree' })).resolves.toEqual({
      threadId: 'thread-new-1',
    })
  })

  it('proxies thread/resume through the shared client after boot', async () => {
    const runtime = createRuntime()

    await expect(runtime.resumeThread({
      threadId: '019d9859-5670-72b1-851f-794ad7fef112',
      cwd: '/repo/worktree',
    })).resolves.toEqual({
      threadId: '019d9859-5670-72b1-851f-794ad7fef112',
    })
  })

  it('drops cached state after an unexpected child exit and starts a fresh process on the next call', async () => {
    const runtime = createRuntime()

    const first = await runtime.ensureReady()
    await runtime.simulateChildExitForTest()
    const second = await runtime.ensureReady()

    expect(second.processPid).not.toBe(first.processPid)
    expect(second.wsUrl).not.toBe(first.wsUrl)
  })

  it('retries startup when the preallocated loopback port is lost before Codex binds', async () => {
    const { blocker, endpoint } = await occupyLoopbackPort()
    let first = true
    const runtime = createRuntime({
      startupRetryLimit: 3,
      startupAttemptTimeoutMs: 200,
      portAllocator: async () => {
        if (first) {
          first = false
          return endpoint
        }
        return allocateLocalhostPort()
      },
    })

    const ready = await runtime.ensureReady()

    expect(ready.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/)
    expect(ready.wsUrl).not.toBe(`ws://${endpoint.hostname}:${endpoint.port}`)
    await closeBlocker(blocker)
  })
})
