import { afterEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { CodexTerminalSidecar } from '../../../../../server/coding-cli/codex-app-server/sidecar.js'

const SIDECAR_OWNERSHIP_DIR = path.join(os.tmpdir(), 'freshell-codex-sidecars')
const children = new Set<ChildProcess>()

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

async function readLinuxProcessIdentity(pid: number): Promise<{
  commandLine: string[]
  cwd: string
  startTimeTicks: string
}> {
  const [cmdlineRaw, cwd, statRaw] = await Promise.all([
    fsp.readFile(`/proc/${pid}/cmdline`, 'utf8'),
    fsp.readlink(`/proc/${pid}/cwd`),
    fsp.readFile(`/proc/${pid}/stat`, 'utf8'),
  ])
  const statFields = statRaw.trim().split(' ')
  return {
    commandLine: cmdlineRaw.split('\0').filter(Boolean),
    cwd,
    startTimeTicks: statFields[21] ?? '',
  }
}

afterEach(async () => {
  await Promise.all([...children].map(async (child) => {
    children.delete(child)
    if (child.exitCode !== null || child.signalCode !== null) {
      return
    }
    child.kill('SIGKILL')
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  }))

  const entries = await fsp.readdir(SIDECAR_OWNERSHIP_DIR, { withFileTypes: true }).catch(() => [])
  await Promise.all(entries.map(async (entry) => {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      await fsp.rm(path.join(SIDECAR_OWNERSHIP_DIR, entry.name), { force: true }).catch(() => undefined)
    }
  }))
})

describe('CodexTerminalSidecar orphan reaper', () => {
  it('refuses to SIGTERM a live pid when ownership metadata lacks a verified process match', async () => {
    await fsp.mkdir(SIDECAR_OWNERSHIP_DIR, { recursive: true })
    const metadataPath = path.join(SIDECAR_OWNERSHIP_DIR, `${randomUUID()}.json`)
    await fsp.writeFile(metadataPath, JSON.stringify({
      pid: process.pid,
      wsUrl: 'ws://127.0.0.1:4545',
      codexHome: '/tmp/fake-codex-home',
      terminalId: 'term-mismatch',
      createdAt: new Date().toISOString(),
    }), 'utf8')

    const killSpy = vi.spyOn(process, 'kill')

    await CodexTerminalSidecar.reapOrphanedSidecars()

    expect(killSpy).not.toHaveBeenCalledWith(process.pid, 'SIGTERM')
  })

  it('SIGTERMs only a pid whose command line, cwd, and start time still match the recorded sidecar', async () => {
    const wsUrl = 'ws://127.0.0.1:4546'
    const child = spawn(process.execPath, [
      '-e',
      'setInterval(() => {}, 1000)',
      'app-server',
      '--listen',
      wsUrl,
    ], {
      cwd: process.cwd(),
      stdio: 'ignore',
    })
    children.add(child)

    if (!child.pid) {
      throw new Error('Failed to spawn test sidecar process')
    }

    const identity = await readLinuxProcessIdentity(child.pid)
    await fsp.mkdir(SIDECAR_OWNERSHIP_DIR, { recursive: true })
    const metadataPath = path.join(SIDECAR_OWNERSHIP_DIR, `${randomUUID()}.json`)
    await fsp.writeFile(metadataPath, JSON.stringify({
      pid: child.pid,
      wsUrl,
      codexHome: '/tmp/test-codex-home',
      terminalId: 'term-owned',
      createdAt: new Date().toISOString(),
      process: identity,
    }), 'utf8')

    await CodexTerminalSidecar.reapOrphanedSidecars()
    await waitForProcessExit(child.pid)
  })
})

describe('CodexTerminalSidecar durable rollout tracking', () => {
  it('forwards thread handles into the exact-path tracker and promotes when the tracker confirms durability', () => {
    let threadStartedHandler: ((thread: { id: string; path: string | null; ephemeral: boolean }) => void) | null = null
    let trackerOptions:
      | {
        onDurableRollout: (sessionId: string) => void
      }
      | null = null

    const runtime = {
      onExit: vi.fn(() => () => undefined),
      onThreadStarted: vi.fn((handler) => {
        threadStartedHandler = handler
        return () => {
          threadStartedHandler = null
        }
      }),
      onThreadLifecycle: vi.fn(() => () => undefined),
      shutdown: vi.fn(async () => undefined),
      ensureReady: vi.fn(async () => ({
        wsUrl: 'ws://127.0.0.1:4567',
        processPid: 101,
        codexHome: '/tmp/fake-codex-home',
      })),
    }

    const tracker = {
      trackThread: vi.fn(),
      dispose: vi.fn(async () => undefined),
    }

    const sidecar = new CodexTerminalSidecar({
      runtime: runtime as any,
      createDurableRolloutTracker: (options) => {
        trackerOptions = {
          onDurableRollout: options.onDurableRollout,
        }
        return tracker
      },
    })

    const onDurableSession = vi.fn()
    sidecar.attachTerminal({
      terminalId: 'term-1',
      onDurableSession,
      onThreadLifecycle: vi.fn(),
      onFatal: vi.fn(),
    })

    const thread = {
      id: 'thread-new-1',
      path: '/tmp/fake-codex-home/sessions/2026/04/23/rollout-thread-new-1.jsonl',
      ephemeral: false,
    }
    threadStartedHandler?.(thread)

    expect(tracker.trackThread).toHaveBeenCalledWith(thread)
    trackerOptions?.onDurableRollout('thread-new-1')
    expect(onDurableSession).toHaveBeenCalledWith('thread-new-1')
  })

  it('forwards current thread lifecycle evidence to the attached terminal', () => {
    let threadLifecycleHandler: ((event: {
      kind: 'thread_started'
      thread: { id: string; path: string | null; ephemeral: boolean }
    }) => void) | null = null
    const runtime = {
      onExit: vi.fn(() => () => undefined),
      onThreadStarted: vi.fn(() => () => undefined),
      onThreadLifecycle: vi.fn((handler) => {
        threadLifecycleHandler = handler
        return () => {
          threadLifecycleHandler = null
        }
      }),
      shutdown: vi.fn(async () => undefined),
      ensureReady: vi.fn(async () => ({
        wsUrl: 'ws://127.0.0.1:4567',
        processPid: 101,
        codexHome: '/tmp/fake-codex-home',
      })),
    }
    const sidecar = new CodexTerminalSidecar({
      runtime: runtime as any,
      createDurableRolloutTracker: () => ({
        trackThread: vi.fn(),
        dispose: vi.fn(async () => undefined),
      }),
    })
    const onThreadLifecycle = vi.fn()
    sidecar.attachTerminal({
      terminalId: 'term-1',
      onDurableSession: vi.fn(),
      onThreadLifecycle,
      onFatal: vi.fn(),
    })

    threadLifecycleHandler?.({
      kind: 'thread_started',
      thread: { id: 'thread-1', path: '/tmp/rollout.jsonl', ephemeral: false },
    })

    expect(onThreadLifecycle).toHaveBeenCalledWith({
      kind: 'thread_started',
      thread: expect.objectContaining({ id: 'thread-1' }),
    })
  })

  it('replays lifecycle evidence observed before terminal attachment', () => {
    let threadLifecycleHandler: ((event: {
      kind: 'thread_started'
      thread: { id: string; path: string | null; ephemeral: boolean }
    }) => void) | null = null
    const runtime = {
      onExit: vi.fn(() => () => undefined),
      onThreadStarted: vi.fn(() => () => undefined),
      onThreadLifecycle: vi.fn((handler) => {
        threadLifecycleHandler = handler
        return () => {
          threadLifecycleHandler = null
        }
      }),
      shutdown: vi.fn(async () => undefined),
      ensureReady: vi.fn(async () => ({
        wsUrl: 'ws://127.0.0.1:4567',
        processPid: 101,
        codexHome: '/tmp/fake-codex-home',
      })),
    }
    const sidecar = new CodexTerminalSidecar({
      runtime: runtime as any,
      createDurableRolloutTracker: () => ({
        trackThread: vi.fn(),
        dispose: vi.fn(async () => undefined),
      }),
    })

    threadLifecycleHandler?.({
      kind: 'thread_started',
      thread: { id: 'thread-1', path: '/tmp/rollout.jsonl', ephemeral: false },
    })

    const onThreadLifecycle = vi.fn()
    sidecar.attachTerminal({
      terminalId: 'term-1',
      onDurableSession: vi.fn(),
      onThreadLifecycle,
      onFatal: vi.fn(),
    })

    expect(onThreadLifecycle).toHaveBeenCalledWith({
      kind: 'thread_started',
      thread: expect.objectContaining({ id: 'thread-1' }),
    })
  })

  it('replays durable promotion before pending lifecycle evidence on terminal attachment', () => {
    let threadLifecycleHandler: ((event: {
      kind: 'thread_started'
      thread: { id: string; path: string | null; ephemeral: boolean }
    }) => void) | null = null
    let trackerOptions:
      | {
        onDurableRollout: (sessionId: string) => void
      }
      | null = null
    const runtime = {
      onExit: vi.fn(() => () => undefined),
      onThreadStarted: vi.fn(() => () => undefined),
      onThreadLifecycle: vi.fn((handler) => {
        threadLifecycleHandler = handler
        return () => {
          threadLifecycleHandler = null
        }
      }),
      shutdown: vi.fn(async () => undefined),
      ensureReady: vi.fn(async () => ({
        wsUrl: 'ws://127.0.0.1:4567',
        processPid: 101,
        codexHome: '/tmp/fake-codex-home',
      })),
    }
    const sidecar = new CodexTerminalSidecar({
      runtime: runtime as any,
      createDurableRolloutTracker: (options) => {
        trackerOptions = { onDurableRollout: options.onDurableRollout }
        return {
          trackThread: vi.fn(),
          dispose: vi.fn(async () => undefined),
        }
      },
    })

    threadLifecycleHandler?.({
      kind: 'thread_started',
      thread: { id: 'thread-fast', path: '/tmp/rollout.jsonl', ephemeral: false },
    })
    trackerOptions?.onDurableRollout('thread-fast')

    const replayOrder: string[] = []
    sidecar.attachTerminal({
      terminalId: 'term-1',
      onDurableSession: (sessionId) => replayOrder.push(`durable:${sessionId}`),
      onThreadLifecycle: (event) => {
        if (event.kind === 'thread_started') {
          replayOrder.push(`lifecycle:${event.thread.id}`)
        }
      },
      onFatal: vi.fn(),
    })

    expect(replayOrder).toEqual(['durable:thread-fast', 'lifecycle:thread-fast'])
  })

  it('disposes the rollout tracker before shutting the runtime down', async () => {
    const lifecycle: string[] = []
    const runtime = {
      onExit: vi.fn(() => () => undefined),
      onThreadStarted: vi.fn(() => () => undefined),
      onThreadLifecycle: vi.fn(() => () => undefined),
      shutdown: vi.fn(async () => {
        lifecycle.push('runtime')
      }),
      ensureReady: vi.fn(async () => ({
        wsUrl: 'ws://127.0.0.1:4567',
        processPid: 101,
        codexHome: '/tmp/fake-codex-home',
      })),
    }
    const tracker = {
      trackThread: vi.fn(),
      dispose: vi.fn(async () => {
        lifecycle.push('tracker')
      }),
    }

    const sidecar = new CodexTerminalSidecar({
      runtime: runtime as any,
      createDurableRolloutTracker: () => tracker,
    })

    await sidecar.shutdown()

    expect(lifecycle).toEqual(['tracker', 'runtime'])
  })

  it('does not boot a stopped runtime just to unwatch during tracker cleanup', async () => {
    let trackerOptions:
      | {
        unwatchPath: (watchId: string) => Promise<void>
      }
      | null = null

    const runtime = {
      status: vi.fn(() => 'stopped'),
      unwatchPath: vi.fn(async () => undefined),
      onExit: vi.fn(() => () => undefined),
      onThreadStarted: vi.fn(() => () => undefined),
      onThreadLifecycle: vi.fn(() => () => undefined),
      shutdown: vi.fn(async () => undefined),
      ensureReady: vi.fn(async () => ({
        wsUrl: 'ws://127.0.0.1:4567',
        processPid: 101,
        codexHome: '/tmp/fake-codex-home',
      })),
    }

    new CodexTerminalSidecar({
      runtime: runtime as any,
      createDurableRolloutTracker: (options) => {
        trackerOptions = {
          unwatchPath: options.unwatchPath,
        }
        return {
          trackThread: vi.fn(),
          dispose: vi.fn(async () => undefined),
        }
      },
    })

    await trackerOptions?.unwatchPath('watch-rollout')
    expect(runtime.unwatchPath).not.toHaveBeenCalled()
  })
})
