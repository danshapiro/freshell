import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { describe, it, expect } from 'vitest'
import { FAKE_CODEX_APP_SERVER, installDualRoleCodexCli } from '../fixtures/codex-dual-role'
import {
  canBindLoopbackPort,
  canConnectLoopbackPort,
  findFreePort,
} from './server-fixture-support.js'

/**
 * Behavioral pinning for the dual-role codex shim installed by e2e specs.
 *
 * The Rust server's codex terminal lane spawns TWO processes from the same
 * CODEX_CMD: the TUI (plain argv) and a `codex app-server` sidecar FIRST.
 * A terminal-only fake at CODEX_CMD exits 0 instantly on the sidecar spawn
 * (stdin is /dev/null), and every codex pane create dies PTY_SPAWN_FAILED.
 * The dual-role shim must therefore:
 *   (a) run the given terminal fake for plain argv (stdi. in/out passthrough), and
 *   (b) route argv containing `app-server` to the shared fake app-server,
 *       which STAYS ALIVE listening (the sidecar contract).
 */

const TERMINAL_MARKER = 'DUAL_ROLE_TERMINAL_RAN'
const SKIP_UNIX_SHIM_ON_WINDOWS = process.platform === 'win32'

interface ShimProcess {
  child: ChildProcess
  stdout: string[]
  exited: Promise<ExitOutcome>
}

interface ExitOutcome {
  code: number | null
  signal: NodeJS.Signals | null
}

function createReadinessControlledShim(): {
  shim: Pick<ShimProcess, 'child'>
  exit: (outcome: ExitOutcome) => void
  fail: (error: Error) => void
} {
  const child = new EventEmitter() as unknown as ChildProcess
  Object.assign(child, { exitCode: null, signalCode: null })
  return {
    shim: { child },
    exit: (outcome) => child.emit('exit', outcome.code, outcome.signal),
    fail: (error) => child.emit('error', error),
  }
}

async function writeTerminalFake(binDir: string): Promise<string> {
  const terminalSrc = path.join(binDir, 'terminal-src.mjs')
  await fs.writeFile(terminalSrc, `console.log(${JSON.stringify(TERMINAL_MARKER)})\nprocess.exit(0)\n`, 'utf8')
  return terminalSrc
}

function spawnShim(binPath: string, args: string[], env?: NodeJS.ProcessEnv): ShimProcess {
  const stdout: string[] = []
  const child = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
  const exited = new Promise<ExitOutcome>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  child.stdout?.on('data', (d) => stdout.push(String(d)))
  return { child, stdout, exited }
}

async function waitExit(shim: ShimProcess, timeoutMs: number): Promise<ExitOutcome | undefined> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    void shim.exited.then((outcome) => {
      clearTimeout(timer)
      resolve(outcome)
    }, (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function stopShim(shim: ShimProcess): Promise<ExitOutcome> {
  if (shim.child.exitCode !== null || shim.child.signalCode !== null) {
    return await shim.exited
  }
  const pid = shim.child.pid ?? 'unknown'
  if (!shim.child.kill('SIGTERM')) {
    throw new Error(`dual-role shim PID ${pid} could not receive SIGTERM`)
  }
  const gracefulExit = await waitExit(shim, 2_500)
  if (gracefulExit) return gracefulExit

  if (!shim.child.kill('SIGKILL')) {
    throw new Error(`dual-role shim PID ${pid} could not receive SIGKILL`)
  }
  const forcedExit = await waitExit(shim, 2_500)
  if (!forcedExit) {
    throw new Error(`dual-role shim PID ${pid} did not exit after SIGKILL`)
  }
  return forcedExit
}

function directChildPids(pid: number): number[] {
  const raw = fsSync.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim()
  return raw === '' ? [] : raw.split(/\s+/).map(Number)
}

async function withCleanup<T>(body: () => Promise<T>, cleanupSteps: Array<() => Promise<unknown>>): Promise<T> {
  let result: T | undefined
  let primaryError: unknown
  try {
    result = await body()
  } catch (error) {
    primaryError = error
  }

  const cleanupErrors: unknown[] = []
  for (const cleanup of cleanupSteps) {
    try {
      await cleanup()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }

  if (primaryError !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError([primaryError, ...cleanupErrors], 'dual-role test and cleanup both failed')
    }
    throw primaryError
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'dual-role cleanup failed')
  }
  return result as T
}

const READINESS_RETRY_INTERVAL_MS = 25

interface ReadinessDependencies {
  now: () => number
  connect: (port: number, timeoutMs: number, signal: AbortSignal) => Promise<boolean>
  pause: (delayMs: number, signal: AbortSignal) => Promise<void>
}

function pauseForReadiness(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(finish, delayMs)
    const onAbort = () => finish()
    function finish() {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function appServerExitedBeforeReadiness(code: number | null, signal: NodeJS.Signals | null): Error {
  return new Error(`dual-role app-server exited before accepting transport connections (${signal ?? code ?? 'unknown'})`)
}

async function waitForAppServerReady(
  shim: Pick<ShimProcess, 'child'>,
  port: number,
  timeoutMs: number,
  dependencies: Partial<ReadinessDependencies> = {},
): Promise<void> {
  const now = dependencies.now ?? Date.now
  const connect = dependencies.connect ?? canConnectLoopbackPort
  const pause = dependencies.pause ?? pauseForReadiness
  const deadline = now() + timeoutMs
  const controller = new AbortController()
  const { signal } = controller
  let polling: Promise<void> | undefined
  let settled = false
  let removeExitWatcher = () => undefined

  const readiness = new Promise<void>((resolve, reject) => {
    const settle = (error?: Error) => {
      if (settled) return
      settled = true
      controller.abort()
      removeExitWatcher()
      if (error) reject(error)
      else resolve()
    }
    const onExit = (code: number | null, exitSignal: NodeJS.Signals | null) => settle(appServerExitedBeforeReadiness(code, exitSignal))
    const onError = (error: Error) => settle(error)
    removeExitWatcher = () => {
      shim.child.off('exit', onExit)
      shim.child.off('error', onError)
    }

    if (shim.child.exitCode !== null || shim.child.signalCode !== null) {
      settle(appServerExitedBeforeReadiness(shim.child.exitCode, shim.child.signalCode))
      return
    }
    shim.child.once('exit', onExit)
    shim.child.once('error', onError)

    polling = (async () => {
      while (!signal.aborted && now() < deadline) {
        const remaining = Math.max(1, deadline - now())
        if (await connect(port, Math.min(250, remaining), signal)) return
        if (signal.aborted) return
        await pause(Math.min(READINESS_RETRY_INTERVAL_MS, Math.max(1, deadline - now())), signal)
      }
      if (!signal.aborted) {
        throw new Error(`dual-role app-server did not accept a transport connection within ${timeoutMs}ms`)
      }
    })()
    void polling.then(() => settle(), (error: Error) => settle(error))
  })

  try {
    await readiness
  } finally {
    controller.abort()
    removeExitWatcher()
    await polling?.catch(() => undefined)
  }
}

describe('codex-dual-role shim', () => {
  it('preserves the test failure while attempting every cleanup step', async () => {
    const primary = new Error('primary test failure')
    const firstCleanup = new Error('first cleanup failure')
    const secondCleanup = new Error('second cleanup failure')
    const attempted: string[] = []
    let thrown: unknown

    try {
      await withCleanup(
        async () => {
          throw primary
        },
        [
          async () => {
            attempted.push('first')
            throw firstCleanup
          },
          async () => {
            attempted.push('second')
            throw secondCleanup
          },
        ],
      )
    } catch (error) {
      thrown = error
    }

    expect(attempted).toEqual(['first', 'second'])
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([primary, firstCleanup, secondCleanup])
  })

  it('surfaces cleanup failures after a successful test body and still attempts every step', async () => {
    const firstCleanup = new Error('first cleanup failure')
    const secondCleanup = new Error('second cleanup failure')
    const attempted: string[] = []
    let thrown: unknown

    try {
      await withCleanup(
        async () => 'body result',
        [
          async () => {
            attempted.push('first')
            throw firstCleanup
          },
          async () => {
            attempted.push('second')
            throw secondCleanup
          },
        ],
      )
    } catch (error) {
      thrown = error
    }

    expect(attempted).toEqual(['first', 'second'])
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([firstCleanup, secondCleanup])
  })

  it('rejects lifecycle waits when spawning the shim itself fails', async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-role-spawn-error-'))
    try {
      const shim = spawnShim(path.join(binDir, 'missing-codex'), [])
      await expect(waitExit(shim, 1_000)).rejects.toThrow()
    } finally {
      await fs.rm(binDir, { recursive: true, force: true })
    }
  })

  it('paces refused readiness probes before a later transport success', async () => {
    const { shim } = createReadinessControlledShim()
    const events: string[] = []
    const pauseDelays: number[] = []
    let now = 0

    await waitForAppServerReady(shim, 1, 150, {
      now: () => now,
      connect: async () => {
        events.push('connect')
        return events.filter((event) => event === 'connect').length === 2
      },
      pause: async (delayMs) => {
        events.push('pause')
        pauseDelays.push(delayMs)
        now += delayMs
      },
    })

    expect(events).toEqual(['connect', 'pause', 'connect'])
    expect(pauseDelays).toEqual([READINESS_RETRY_INTERVAL_MS])
  })

  it('stops the one owned readiness poll when the exact child exits early', async () => {
    const { shim, exit } = createReadinessControlledShim()
    const initialExitListeners = shim.child.listenerCount('exit')
    const initialErrorListeners = shim.child.listenerCount('error')
    let attempts = 0
    let pauses = 0
    let connectStarted!: () => void
    const connectStartedPromise = new Promise<void>((resolve) => {
      connectStarted = resolve
    })

    const readiness = waitForAppServerReady(shim, 1, 5_000, {
      connect: async (_port, _timeoutMs, signal) => {
        attempts += 1
        connectStarted()
        return await new Promise<boolean>((resolve) => signal.addEventListener('abort', () => resolve(false), { once: true }))
      },
      pause: async () => {
        pauses += 1
      },
    })
    await connectStartedPromise
    expect(shim.child.listenerCount('exit')).toBe(initialExitListeners + 1)
    expect(shim.child.listenerCount('error')).toBe(initialErrorListeners + 1)
    exit({ code: 1, signal: null })

    await expect(readiness).rejects.toThrow('exited before accepting transport connections')
    await Promise.resolve()
    expect(attempts).toBe(1)
    expect(pauses).toBe(0)
    expect(shim.child.listenerCount('exit')).toBe(initialExitListeners)
    expect(shim.child.listenerCount('error')).toBe(initialErrorListeners)
  })

  it('removes its owned exit and error watchers after successful readiness', async () => {
    const { shim } = createReadinessControlledShim()
    const initialExitListeners = shim.child.listenerCount('exit')
    const initialErrorListeners = shim.child.listenerCount('error')
    let connectCalls = 0
    let pauseCalls = 0
    let finishConnect!: (connected: boolean) => void
    const connectPending = new Promise<boolean>((resolve) => {
      finishConnect = resolve
    })

    const readiness = waitForAppServerReady(shim, 1, 5_000, {
      connect: async () => {
        connectCalls += 1
        return await connectPending
      },
      pause: async () => {
        pauseCalls += 1
      },
    })
    await Promise.resolve()
    expect(shim.child.listenerCount('exit')).toBe(initialExitListeners + 1)
    expect(shim.child.listenerCount('error')).toBe(initialErrorListeners + 1)

    finishConnect(true)
    await readiness
    await Promise.resolve()
    expect(connectCalls).toBe(1)
    expect(pauseCalls).toBe(0)
    expect(shim.child.listenerCount('exit')).toBe(initialExitListeners)
    expect(shim.child.listenerCount('error')).toBe(initialErrorListeners)
  })

  it('removes its owned exit and error watchers after an exact child error', async () => {
    const { shim, fail } = createReadinessControlledShim()
    const initialExitListeners = shim.child.listenerCount('exit')
    const initialErrorListeners = shim.child.listenerCount('error')
    let connectCalls = 0
    let pauseCalls = 0
    let connectStarted!: () => void
    const connectStartedPromise = new Promise<void>((resolve) => {
      connectStarted = resolve
    })

    const readiness = waitForAppServerReady(shim, 1, 5_000, {
      connect: async (_port, _timeoutMs, signal) => {
        connectCalls += 1
        connectStarted()
        return await new Promise<boolean>((resolve) => signal.addEventListener('abort', () => resolve(false), { once: true }))
      },
      pause: async () => {
        pauseCalls += 1
      },
    })
    await connectStartedPromise
    expect(shim.child.listenerCount('exit')).toBe(initialExitListeners + 1)
    expect(shim.child.listenerCount('error')).toBe(initialErrorListeners + 1)

    const expected = new Error('exact child spawn failure')
    fail(expected)
    await expect(readiness).rejects.toBe(expected)
    await Promise.resolve()
    expect(connectCalls).toBe(1)
    expect(pauseCalls).toBe(0)
    expect(shim.child.listenerCount('exit')).toBe(initialExitListeners)
    expect(shim.child.listenerCount('error')).toBe(initialErrorListeners)
  })

  // The installed fixture is an extensionless Unix shebang. Keep the process
  // lifecycle seams above portable; only actual shim execution is Unix-only.
  it.skipIf(SKIP_UNIX_SHIM_ON_WINDOWS)('runs the terminal fake for plain argv', async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-role-'))
    try {
      const terminalSrc = await writeTerminalFake(binDir)
      const bin = await installDualRoleCodexCli(binDir, terminalSrc)
      expect(bin).toBe(path.join(binDir, 'codex'))

      const shim = spawnShim(bin, [])
      const exit = await waitExit(shim, 10_000)
      expect(exit?.code).toBe(0)
      await waitUntil(2_000, () => shim.stdout.join('').includes(TERMINAL_MARKER))
    } finally {
      await fs.rm(binDir, { recursive: true, force: true })
    }
  }, 30_000)

  it.skipIf(SKIP_UNIX_SHIM_ON_WINDOWS)('routes `app-server` argv to the fake app-server, which keeps listening (the sidecar contract)', async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-role-'))
    let shim: ShimProcess | undefined
    await withCleanup(async () => {
      const terminalSrc = await writeTerminalFake(binDir)
      const bin = await installDualRoleCodexCli(binDir, terminalSrc)

      shim = spawnShim(bin, ['-c', 'features.apps=false', 'app-server', '--listen', 'ws://127.0.0.1:0'])
      // A listening sidecar survives its whole lifetime — it does NOT exit 0
      // instantly the way a terminal-only fake does when stdin is /dev/null.
      const earlyExit = await waitExit(shim, 3_000)
      expect(earlyExit).toBeUndefined()
      // And it never confused itself for the terminal fake.
      await new Promise((r) => setTimeout(r, 100))
      expect(shim.stdout.join('')).not.toContain(TERMINAL_MARKER)
    }, [
      async () => { if (shim) await stopShim(shim) },
      () => fs.rm(binDir, { recursive: true, force: true }),
    ])
  }, 30_000)

  it.skipIf(SKIP_UNIX_SHIM_ON_WINDOWS)('keeps the app-server runnable when its authoring source is unavailable', async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-role-copied-app-server-'))
    let shim: ShimProcess | undefined
    await withCleanup(async () => {
      const terminalSrc = await writeTerminalFake(binDir)
      const appServerSource = path.join(binDir, 'authoring-app-server.mjs')
      await fs.copyFile(FAKE_CODEX_APP_SERVER, appServerSource)
      const bin = await installDualRoleCodexCli(binDir, terminalSrc, undefined, appServerSource)
      // The managed runtime mounts this fixture workspace, not the checkout
      // path where the shared app-server source lives. Removing the source
      // here reproduces that runtime boundary without a Docker dependency.
      await fs.rm(appServerSource)
      const port = await findFreePort()
      shim = spawnShim(bin, ['-c', 'features.apps=false', 'app-server', '--listen', `ws://127.0.0.1:${port}`])
      await waitForAppServerReady(shim, port, 5_000)
      expect(await waitExit(shim, 100)).toBeUndefined()
    }, [
      async () => { if (shim) await stopShim(shim) },
      () => fs.rm(binDir, { recursive: true, force: true }),
    ])
  }, 30_000)

  it.skipIf(SKIP_UNIX_SHIM_ON_WINDOWS)('keeps the terminal fake runnable when its authoring source is unavailable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-role-copied-terminal-'))
    const workspace = path.join(root, 'workspace')
    const binDir = path.join(workspace, 'bin')
    const terminalSource = path.join(root, 'authoring-terminal.mjs')
    let shim: ShimProcess | undefined
    await withCleanup(async () => {
      await fs.chmod(root, 0o755)
      await fs.mkdir(workspace, { mode: 0o755 })
      await fs.chmod(workspace, 0o755)
      await fs.writeFile(terminalSource, `console.log(${JSON.stringify(TERMINAL_MARKER)})\nprocess.exit(0)\n`)
      const bin = await installDualRoleCodexCli(binDir, terminalSource)
      // The managed runtime mounts this fixture workspace, not the source
      // checkout path supplied by the browser test.
      await fs.rm(terminalSource)
      shim = spawnShim(bin, [])
      const exit = await waitExit(shim, 10_000)
      expect(exit?.code).toBe(0)
      await waitUntil(2_000, () => shim!.stdout.join('').includes(TERMINAL_MARKER))
    }, [
      async () => { if (shim && shim.child.exitCode === null) await stopShim(shim) },
      () => fs.rm(root, { recursive: true, force: true }),
    ])
  }, 30_000)

  it.skipIf(SKIP_UNIX_SHIM_ON_WINDOWS)('stages the Codex app-server tree for the managed provider uid under a private umask', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-role-managed-provider-'))
    const workspace = path.join(root, 'workspace')
    const binDir = path.join(workspace, 'bin')
    const terminalSource = path.join(workspace, 'terminal-fake.mjs')
    try {
      await fs.chmod(root, 0o755)
      await fs.mkdir(workspace, { mode: 0o755 })
      await fs.chmod(workspace, 0o755)
      await fs.writeFile(terminalSource, 'process.exit(0)\n', { mode: 0o555 })
      await fs.chmod(terminalSource, 0o555)

      const previousUmask = process.umask(0o077)
      try {
        await installDualRoleCodexCli(binDir, terminalSource)
      } finally {
        process.umask(previousUmask)
      }

      const assertProviderCanTraverse = async (directory: string): Promise<void> => {
        const stat = await fs.stat(directory)
        expect(stat.mode & 0o005, `${path.relative(root, directory)} must be traversable by uid 65534`).toBe(0o005)
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name)
          if (entry.isDirectory()) await assertProviderCanTraverse(file)
          else if (entry.isFile()) {
            const fileMode = (await fs.stat(file)).mode
            expect(fileMode & 0o004, `${path.relative(root, file)} must be readable by uid 65534`).toBe(0o004)
            if (file === path.join(binDir, 'codex')) {
              expect(fileMode & 0o001, 'the Codex shim must be executable by uid 65534').toBe(0o001)
            }
          }
        }
      }
      await assertProviderCanTraverse(workspace)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it.skipIf(SKIP_UNIX_SHIM_ON_WINDOWS)('passes terminalEnv through to the terminal role only', async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-role-'))
    try {
      const terminalSrc = path.join(binDir, 'terminal-src.mjs')
      await fs.writeFile(
        terminalSrc,
        "console.log('env=' + process.env.DUAL_ROLE_TEST_ENV)\nprocess.exit(0)\n",
        'utf8',
      )
      const bin = await installDualRoleCodexCli(binDir, terminalSrc, {
        DUAL_ROLE_TEST_ENV: 'env-carry-1',
      })
      const shim = spawnShim(bin, [])
      const exit = await waitExit(shim, 10_000)
      expect(exit?.code).toBe(0)
      await waitUntil(2_000, () => shim.stdout.join('').includes('env=env-carry-1'))
    } finally {
      await fs.rm(binDir, { recursive: true, force: true })
    }
  }, 30_000)

  it.skipIf(SKIP_UNIX_SHIM_ON_WINDOWS)('a terminal-only fake at CODEX_CMD exits 0 instantly under sidecar argv (the pathology this shim fixes)', async () => {
    // Contrast test: documents the failure this helper prevents. If the
    // shared app-server fake stops working, the previous test fails; if the
    // dispatch breaks toward the terminal role, this one catches regression
    // in the FIXture's transitive meaning.
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-role-'))
    let shim: ShimProcess | undefined
    await withCleanup(async () => {
      const terminalSrc = await writeTerminalFake(binDir)
      const bin = await installDualRoleCodexCli(binDir, terminalSrc)

      shim = spawnShim(bin, ['-c', 'features.apps=false', 'app-server', '--listen', 'ws://127.0.0.1:0'])
      const exit = await waitExit(shim, 10_000)
      // Terminal fake must NOT have run.
      expect(shim.stdout.join('')).not.toContain(TERMINAL_MARKER)
      expect(exit).toBeUndefined()
    }, [
      async () => { if (shim) await stopShim(shim) },
      () => fs.rm(binDir, { recursive: true, force: true }),
    ])
  }, 30_000)

  it.skipIf(SKIP_UNIX_SHIM_ON_WINDOWS)('releases its direct app-server listener after bounded graceful cleanup', async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-role-reap-'))
    const terminalSrc = await writeTerminalFake(binDir)
    const bin = await installDualRoleCodexCli(binDir, terminalSrc)
    const port = await findFreePort()
    const shim = spawnShim(bin, ['-c', 'features.apps=false', 'app-server', '--listen', `ws://127.0.0.1:${port}`])

    await withCleanup(async () => {
      await waitForAppServerReady(shim, port, 5_000)

      const exit = await stopShim(shim)
      expect(exit).toEqual({ code: 0, signal: null })
      expect(shim.child.exitCode).toBe(0)
      expect(shim.child.signalCode).toBeNull()
      expect(await canBindLoopbackPort(port)).toBe(true)
    }, [
      () => stopShim(shim),
      () => fs.rm(binDir, { recursive: true, force: true }),
    ])
  }, 30_000)

  it.skipIf(SKIP_UNIX_SHIM_ON_WINDOWS || process.platform !== 'linux')('runs the app-server in the shim process instead of an extra child', async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-role-direct-'))
    const terminalSrc = await writeTerminalFake(binDir)
    const bin = await installDualRoleCodexCli(binDir, terminalSrc)
    const port = await findFreePort()
    const shim = spawnShim(bin, ['-c', 'features.apps=false', 'app-server', '--listen', `ws://127.0.0.1:${port}`])

    await withCleanup(async () => {
      await waitForAppServerReady(shim, port, 5_000)
      expect(directChildPids(shim.child.pid ?? -1)).toEqual([])
    }, [
      () => stopShim(shim),
      () => fs.rm(binDir, { recursive: true, force: true }),
    ])
  }, 30_000)

  it.skipIf(process.platform === 'win32')('escalates cleanup when the direct app-server rejects SIGTERM', async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-role-escalate-'))
    const terminalSrc = await writeTerminalFake(binDir)
    const bin = await installDualRoleCodexCli(binDir, terminalSrc)
    const port = await findFreePort()
    const shim = spawnShim(
      bin,
      ['-c', 'features.apps=false', 'app-server', '--listen', `ws://127.0.0.1:${port}`],
      { ...process.env, FAKE_CODEX_APP_SERVER_IGNORE_SIGTERM: '1' },
    )

    await withCleanup(async () => {
      await waitForAppServerReady(shim, port, 5_000)

      const exit = await stopShim(shim)
      expect(exit.signal).toBe('SIGKILL')
      expect(shim.child.signalCode).toBe('SIGKILL')
      expect(await canBindLoopbackPort(port)).toBe(true)
    }, [
      () => stopShim(shim),
      () => fs.rm(binDir, { recursive: true, force: true }),
    ])
  }, 30_000)
})

async function waitUntil(timeoutMs: number, pred: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pred()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('waitUntil timed out')
}
