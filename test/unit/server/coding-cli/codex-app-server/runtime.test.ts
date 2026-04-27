import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CodexAppServerRuntime } from '../../../../../server/coding-cli/codex-app-server/runtime.js'
import { allocateLocalhostPort, type LoopbackServerEndpoint } from '../../../../../server/local-port.js'

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

async function occupyLoopbackPort(): Promise<{ blocker: http.Server; endpoint: LoopbackServerEndpoint }> {
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

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        return
      }
      throw error
    }

    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  throw new Error(`Timed out waiting for process ${pid} to exit`)
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

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type RuntimeCleanupHook = {
  stopActiveChild(): Promise<void>
}

describe('CodexAppServerRuntime', () => {
  it('starts one loopback app-server runtime on first use', async () => {
    const runtime = createRuntime()

    const ready = await runtime.ensureReady()

    expect(ready.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/)
    expect(ready.processPid).toBeGreaterThan(0)
    expect(runtime.status()).toBe('running')
  })

  it('starts the app-server process in the requested cwd', async () => {
    if (process.platform !== 'linux') {
      return
    }

    const runtimeCwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-runtime-cwd-'))
    const runtime = createRuntime({ cwd: runtimeCwd })

    try {
      const ready = await runtime.ensureReady()
      await expect(fsp.readlink(`/proc/${ready.processPid}/cwd`)).resolves.toBe(runtimeCwd)
    } finally {
      await fsp.rm(runtimeCwd, { recursive: true, force: true })
    }
  })

  it('keeps separate runtime instances isolated for concurrent codex terminals', async () => {
    const firstRuntime = createRuntime()
    const secondRuntime = createRuntime()

    const [first, second] = await Promise.all([
      firstRuntime.ensureReady(),
      secondRuntime.ensureReady(),
    ])

    expect(first.processPid).not.toBe(second.processPid)
    expect(first.wsUrl).not.toBe(second.wsUrl)
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

  it('forces the child down when it ignores SIGTERM', async () => {
    const runtime = createRuntime({
      env: {
        FAKE_CODEX_APP_SERVER_IGNORE_SIGTERM: '1',
      },
    })

    const ready = await runtime.ensureReady()
    await runtime.shutdown()

    await waitForProcessExit(ready.processPid)
    expect(runtime.status()).toBe('stopped')
  })

  it('proxies thread/start through the runtime client after boot', async () => {
    const runtime = createRuntime()

    await expect(runtime.startThread({ cwd: '/repo/worktree' })).resolves.toEqual({
      thread: {
        id: 'thread-new-1',
        path: expect.stringMatching(/\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-thread-new-1\.jsonl$/),
        ephemeral: false,
      },
      wsUrl: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/),
    })
  })

  it('proxies thread/resume through the runtime client after boot', async () => {
    const runtime = createRuntime()

    await expect(runtime.resumeThread({
      threadId: '019d9859-5670-72b1-851f-794ad7fef112',
      cwd: '/repo/worktree',
    })).resolves.toEqual({
      thread: {
        id: '019d9859-5670-72b1-851f-794ad7fef112',
        path: expect.stringMatching(/rollout-019d9859-5670-72b1-851f-794ad7fef112\.jsonl$/),
        ephemeral: false,
      },
      wsUrl: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/),
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
      startupAttemptLimit: 3,
      startupAttemptTimeoutMs: 1_000,
      portAllocator: async () => {
        if (first) {
          first = false
          return endpoint
        }
        return allocateLocalhostPort()
      },
    })
    const onExit = vi.fn()
    runtime.onExit(onExit)

    const ready = await runtime.ensureReady()

    expect(ready.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/)
    expect(ready.wsUrl).not.toBe(`ws://${endpoint.hostname}:${endpoint.port}`)
    expect(onExit).not.toHaveBeenCalled()
    await closeBlocker(blocker)
  })

  it('coalesces ensureReady callers while startup spawn-error cleanup is still in progress', async () => {
    const attemptedPorts: number[] = []
    const runtime = createRuntime({
      command: path.join(os.tmpdir(), `missing-codex-app-server-coalesce-${process.pid}`),
      requestTimeoutMs: 50,
      startupAttemptLimit: 1,
      startupAttemptTimeoutMs: 500,
      portAllocator: async () => {
        const endpoint = await allocateLocalhostPort()
        attemptedPorts.push(endpoint.port)
        return endpoint
      },
    })
    const cleanupStarted = deferred()
    const allowCleanup = deferred()
    const cleanupHook = runtime as unknown as RuntimeCleanupHook
    const originalStopActiveChild = cleanupHook.stopActiveChild.bind(runtime)
    let cleanupCalls = 0
    cleanupHook.stopActiveChild = vi.fn(async () => {
      cleanupCalls += 1
      cleanupStarted.resolve()
      await allowCleanup.promise
      return originalStopActiveChild()
    })

    let first: Promise<unknown> | undefined
    let second: Promise<unknown> | undefined
    try {
      first = runtime.ensureReady()
      void first.catch(() => undefined)
      await cleanupStarted.promise
      second = runtime.ensureReady()
      void second.catch(() => undefined)

      allowCleanup.resolve()
      await expect(Promise.allSettled([first, second])).resolves.toEqual([
        expect.objectContaining({ status: 'rejected' }),
        expect.objectContaining({ status: 'rejected' }),
      ])
      expect(cleanupCalls).toBe(1)
      expect(attemptedPorts).toHaveLength(1)
    } finally {
      allowCleanup.resolve()
      cleanupHook.stopActiveChild = originalStopActiveChild
      await Promise.allSettled([first, second].filter((promise): promise is Promise<unknown> => Boolean(promise)))
    }
  })

  it('rejects through the startup retry path when the app-server command cannot spawn', async () => {
    const attemptedPorts: number[] = []
    const runtime = createRuntime({
      command: path.join(os.tmpdir(), `missing-codex-app-server-${process.pid}`),
      requestTimeoutMs: 50,
      startupAttemptLimit: 2,
      startupAttemptTimeoutMs: 500,
      portAllocator: async () => {
        const endpoint = await allocateLocalhostPort()
        attemptedPorts.push(endpoint.port)
        return endpoint
      },
    })
    const onExit = vi.fn()
    runtime.onExit(onExit)

    await expect(runtime.ensureReady()).rejects.toThrow(
      /Failed to start Codex app-server on a loopback endpoint after 2 attempts: .*ENOENT/,
    )

    expect(attemptedPorts).toHaveLength(2)
    expect(runtime.status()).toBe('stopped')
    expect(onExit).not.toHaveBeenCalled()
  })

  it('keeps child stdio drained so large app-server logs do not stall thread/start replies', async () => {
    const runtime = createRuntime({
      env: {
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
          floodStdoutBeforeMethodsBytes: {
            'thread/start': 512 * 1024,
          },
        }),
      },
      requestTimeoutMs: 1_500,
    })

    await expect(runtime.startThread({ cwd: '/repo/worktree' })).resolves.toEqual({
      thread: {
        id: 'thread-new-1',
        path: expect.stringMatching(/\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-thread-new-1\.jsonl$/),
        ephemeral: false,
      },
      wsUrl: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/),
    })
  })

  it('keeps child stderr drained so large app-server error logs do not stall thread/resume replies', async () => {
    const runtime = createRuntime({
      env: {
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
          floodStderrBeforeMethodsBytes: {
            'thread/resume': 512 * 1024,
          },
        }),
      },
      requestTimeoutMs: 1_500,
    })

    await expect(runtime.resumeThread({
      threadId: '019d9859-5670-72b1-851f-794ad7fef112',
      cwd: '/repo/worktree',
    })).resolves.toEqual({
      thread: {
        id: '019d9859-5670-72b1-851f-794ad7fef112',
        path: expect.stringMatching(/rollout-019d9859-5670-72b1-851f-794ad7fef112\.jsonl$/),
        ephemeral: false,
      },
      wsUrl: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/),
    })
  })

  it('passes thread and fs watch notifications through runtime subscribers', async () => {
    const rolloutPath = '/repo/worktree/.codex/sessions/2026/04/23/rollout-thread-new-1.jsonl'
    const runtime = createRuntime({
      env: {
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
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
        }),
      },
    })

    const startedThread = new Promise<{ id: string; path: string | null; ephemeral: boolean }>((resolve) => {
      runtime.onThreadStarted((thread) => resolve(thread))
    })
    const changedEvent = new Promise<{ watchId: string; changedPaths: string[] }>((resolve) => {
      runtime.onFsChanged((event) => resolve(event))
    })

    await runtime.startThread({ cwd: '/repo/worktree' })
    await expect(startedThread).resolves.toEqual({
      id: 'thread-new-1',
      path: expect.stringMatching(/\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-thread-new-1\.jsonl$/),
      ephemeral: false,
    })
    await expect(runtime.watchPath(rolloutPath, 'watch-rollout')).resolves.toEqual({
      path: rolloutPath,
    })
    await expect(changedEvent).resolves.toEqual({
      watchId: 'watch-rollout',
      changedPaths: [rolloutPath],
    })
    await expect(runtime.unwatchPath('watch-rollout')).resolves.toBeUndefined()
  })

  it('notifies runtime exit handlers when the app-server client socket disconnects while the child is alive', async () => {
    const runtime = createRuntime({
      env: {
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
          closeSocketAfterMethodsOnce: ['initialize'],
        }),
      },
    })
    const onExit = vi.fn()
    runtime.onExit(onExit)

    await runtime.ensureReady()

    await waitFor(() => expect(onExit).toHaveBeenCalledWith(
      expect.any(Error),
      'app_server_client_disconnect',
    ))
  })

  it('includes pid, websocket port, exit code, signal, and stderr tail when a child exits unexpectedly', async () => {
    const runtime = createRuntime({
      env: {
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
          stderrBeforeExit: 'queue full diagnostic',
          exitProcessAfterMethodsOnce: ['initialize'],
        }),
      },
    })
    const onExit = vi.fn()
    runtime.onExit(onExit)

    await runtime.ensureReady()
    await waitFor(() => expect(onExit.mock.calls[0]?.[0]).toBeInstanceOf(Error))

    const message = String(onExit.mock.calls[0]?.[0]?.message ?? '')
    expect(message).toContain('pid ')
    expect(message).toContain('ws port ')
    expect(message).toContain('exit code ')
    expect(message).toContain('signal ')
    expect(message).toContain('stderr tail')
    expect(message).toContain('queue full diagnostic')
  })
})
