import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertCodexStartupReaperSucceeded,
  CodexAppServerRuntime,
  reapOrphanedCodexAppServerSidecars,
  runCodexStartupReaper,
} from '../../../../../server/coding-cli/codex-app-server/runtime.js'
import { allocateLocalhostPort, type LoopbackServerEndpoint } from '../../../../../server/local-port.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FAKE_SERVER_PATH = path.resolve(__dirname, '../../../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs')

const runtimes = new Set<CodexAppServerRuntime>()
const blockers = new Set<http.Server>()
const tempDirs = new Set<string>()

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
  await Promise.all([...tempDirs].map(async (dir) => {
    tempDirs.delete(dir)
    await fsp.rm(dir, { recursive: true, force: true })
  }))
})

async function makeTempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-runtime-'))
  tempDirs.add(dir)
  return dir
}

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

async function killProcessGroupForTest(processGroupId: number): Promise<void> {
  try {
    process.kill(-processGroupId, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
  await waitForProcessExit(processGroupId).catch(() => undefined)
}

async function waitForMetadataRecord(metadataDir: string, timeoutMs = 5_000): Promise<any> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const entries = await fsp.readdir(metadataDir).catch(() => [])
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const raw = await fsp.readFile(path.join(metadataDir, entry), 'utf8')
      return JSON.parse(raw)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  throw new Error(`Timed out waiting for metadata record in ${metadataDir}`)
}

async function waitForPidFile(pidFile: string, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const raw = await fsp.readFile(pidFile, 'utf8').catch(() => '')
    const pid = Number(raw.trim())
    if (Number.isInteger(pid) && pid > 0) return pid
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for pid file ${pidFile}`)
}

async function readProcessEnvironment(pid: number): Promise<Record<string, string>> {
  const raw = await fsp.readFile(`/proc/${pid}/environ`)
  const pairs = raw.toString('utf8').split('\0').filter(Boolean)
  return Object.fromEntries(pairs.map((pair) => {
    const index = pair.indexOf('=')
    return index === -1 ? [pair, ''] : [pair.slice(0, index), pair.slice(index + 1)]
  }))
}

async function readCurrentProcessGroupId(): Promise<number> {
  const stat = await fsp.readFile('/proc/self/stat', 'utf8')
  const closeParen = stat.lastIndexOf(')')
  const fields = stat.slice(closeParen + 2).trim().split(/\s+/)
  return Number(fields[2])
}

async function markOwnershipRecordStale(
  metadataPath: string,
  overrides: Record<string, unknown> = {},
): Promise<any> {
  const raw = await fsp.readFile(metadataPath, 'utf8')
  const metadata = JSON.parse(raw)
  const stale = {
    ...metadata,
    ownerServerPid: 999_999_999,
    serverInstanceId: 'srv-previous',
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
  await fsp.writeFile(metadataPath, JSON.stringify(stale, null, 2), 'utf8')
  return stale
}

async function isProcessGroupAlive(processGroupId: number): Promise<boolean> {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function readWrapperIdentityForTest(pid: number) {
  const [cmdline, cwd, stat] = await Promise.all([
    fsp.readFile(`/proc/${pid}/cmdline`).catch(() => Buffer.from('')),
    fsp.readlink(`/proc/${pid}/cwd`).catch(() => null),
    fsp.readFile(`/proc/${pid}/stat`, 'utf8'),
  ])
  const closeParen = stat.lastIndexOf(')')
  const fields = stat.slice(closeParen + 2).trim().split(/\s+/)
  const startTimeTicks = Number(fields[19])
  return {
    commandLine: cmdline.toString('utf8').split('\0').filter(Boolean),
    cwd,
    startTimeTicks: Number.isFinite(startTimeTicks) ? startTimeTicks : null,
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
  it('starts one owned loopback app-server sidecar on first use', async () => {
    const runtime = createRuntime()

    const ready = await runtime.ensureReady()

    expect(ready.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/)
    expect(ready.processPid).toBeGreaterThan(0)
    expect(runtime.status()).toBe('running')
  })

  it('waits for a complete wrapper identity proof during startup', async () => {
    let identityReads = 0
    const runtime = createRuntime({
      startupAttemptLimit: 1,
      startupAttemptTimeoutMs: 1_000,
      processIdentityReader: async (pid) => {
        identityReads += 1
        if (identityReads === 1) return null
        return readWrapperIdentityForTest(pid)
      },
    })

    await expect(runtime.ensureReady()).resolves.toEqual(expect.objectContaining({
      wsUrl: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/),
    }))
    expect(identityReads).toBeGreaterThan(1)
  })

  it('rejects before spawning on platforms without Linux /proc ownership support', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    if (!originalPlatform?.configurable) {
      throw new Error('process.platform descriptor is not configurable in this test environment')
    }
    const metadataDir = await makeTempDir()
    const runtime = createRuntime({
      metadataDir,
      startupAttemptLimit: 1,
    })

    try {
      Object.defineProperty(process, 'platform', { value: 'darwin' })

      await expect(runtime.ensureReady()).rejects.toThrow(/linux.*\/proc/i)
      const entries = await fsp.readdir(metadataDir).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      })
      expect(entries).toEqual([])
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('rejects before spawning when Linux /proc ownership proof is unavailable', async () => {
    const metadataDir = await makeTempDir()
    let ownershipIdCalls = 0
    const originalReaddir = fsp.readdir.bind(fsp)
    const readdirSpy = vi.spyOn(fsp, 'readdir').mockImplementation(((target: any, options?: any) => {
      if (String(target) === '/proc') {
        const error = new Error('simulated /proc read failure') as NodeJS.ErrnoException
        error.code = 'EACCES'
        return Promise.reject(error)
      }
      return originalReaddir(target, options as any) as any
    }) as typeof fsp.readdir)
    const runtime = createRuntime({
      metadataDir,
      startupAttemptLimit: 1,
      ownershipIdFactory: () => {
        ownershipIdCalls += 1
        return `ownership-${ownershipIdCalls}`
      },
    })

    try {
      await expect(runtime.ensureReady()).rejects.toThrow(/\/proc.*ownership proof/i)
      expect(ownershipIdCalls).toBe(0)
      const entries = await originalReaddir(metadataDir).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      })
      expect(entries).toEqual([])
    } finally {
      readdirSpy.mockRestore()
    }
  })

  it('reuses the same process for repeated ensureReady calls on one runtime', async () => {
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

  it('writes ownership metadata immediately after spawn before initialize completes', async () => {
    const metadataDir = await makeTempDir()
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
      env: {
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
          delayMethodsMs: {
            initialize: 250,
          },
        }),
      },
    })

    const readyPromise = runtime.ensureReady()
    const metadata = await waitForMetadataRecord(metadataDir)
    const ready = await readyPromise

    expect(metadata.schemaVersion).toBe(1)
    expect(metadata.ownershipId).toBe(ready.ownershipId)
    expect(metadata.serverInstanceId).toBe('srv-runtime-test')
    expect(metadata.ownerServerPid).toBe(process.pid)
    expect(metadata.terminalId).toBeNull()
    expect(metadata.generation).toBeNull()
    expect(metadata.wsUrl).toBe(ready.wsUrl)
    expect(metadata.wrapperPid).toBe(ready.processPid)
    expect(metadata.processGroupId).toBe(ready.processGroupId)
    expect(metadata.wrapperIdentity.startTimeTicks).toEqual(expect.any(Number))
  })

  it('writes durable ownership metadata before wrapper identity lookup resolves', async () => {
    const metadataDir = await makeTempDir()
    let identityLookupStarted!: () => void
    let releaseIdentityLookup!: (identity: null) => void
    const identityStarted = new Promise<void>((resolve) => {
      identityLookupStarted = resolve
    })
    const identityReleased = new Promise<null>((resolve) => {
      releaseIdentityLookup = resolve
    })
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
      processIdentityReader: async () => {
        identityLookupStarted()
        return identityReleased
      },
    })

    const readyPromise = runtime.ensureReady()
    try {
      await identityStarted
      const metadata = await waitForMetadataRecord(metadataDir, 500)

      expect(metadata.schemaVersion).toBe(1)
      expect(metadata.serverInstanceId).toBe('srv-runtime-test')
      expect(metadata.wrapperIdentity).toEqual({
        commandLine: [],
        cwd: null,
        startTimeTicks: null,
      })
    } finally {
      releaseIdentityLookup(null)
      await readyPromise.catch(() => undefined)
    }
  })

  it('tears down both the wrapper and native child in its process group', async () => {
    const metadataDir = await makeTempDir()
    const nativePidFile = path.join(metadataDir, 'native.pid')
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
      env: {
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
          spawnNativeChild: true,
          nativePidFile,
          wrapperLeavesNativeOnSigterm: true,
        }),
      },
    })

    const ready = await runtime.ensureReady()
    const nativePid = await waitForPidFile(nativePidFile)

    expect(nativePid).not.toBe(ready.processPid)

    await runtime.shutdown()

    await waitForProcessExit(ready.processPid)
    await waitForProcessExit(nativePid)
    await expect(fsp.readdir(metadataDir)).resolves.not.toContain(path.basename(ready.metadataPath))
  })

  it('tears down an owned native child after the wrapper exits hard before restarting', async () => {
    const metadataDir = await makeTempDir()
    const nativePidFile = path.join(metadataDir, 'native.pid')
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
      env: {
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
          spawnNativeChild: true,
          nativePidFile,
          wrapperLeavesNativeOnSigterm: true,
        }),
      },
    })

    const first = await runtime.ensureReady()
    const oldNativePid = await waitForPidFile(nativePidFile)

    process.kill(first.processPid, 'SIGKILL')
    await waitForProcessExit(first.processPid)

    const second = await runtime.ensureReady()

    expect(second.processPid).not.toBe(first.processPid)
    await waitForProcessExit(oldNativePid)
  })

  it('tears down a native child when the wrapper exits before initialize', async () => {
    const metadataDir = await makeTempDir()
    const nativePidFile = path.join(metadataDir, 'native.pid')
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
      startupAttemptLimit: 1,
      startupAttemptTimeoutMs: 100,
      env: {
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
          spawnNativeChild: true,
          nativePidFile,
          wrapperLeavesNativeOnSigterm: true,
          exitAfterSpawningNative: true,
        }),
      },
    })

    await expect(runtime.ensureReady()).rejects.toThrow(/failed to start codex app-server/i)

    const nativePid = await waitForPidFile(nativePidFile)
    await waitForProcessExit(nativePid)
  })

  it('uses the startup attempt timeout to tear down an initialize hang before retrying', async () => {
    const tempDir = await makeTempDir()
    const metadataDir = path.join(tempDir, 'metadata')
    const processGroups: number[] = []
    const seenProcessGroups = new Set<number>()
    let previousAttemptGoneBeforeRetry = false
    const start = Date.now()
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
      startupAttemptLimit: 2,
      startupAttemptTimeoutMs: 120,
      requestTimeoutMs: 1_000,
      metadataWriter: async (filePath, metadata) => {
        if (!seenProcessGroups.has(metadata.processGroupId)) {
          if (processGroups.length > 0) {
            previousAttemptGoneBeforeRetry = !(await isProcessGroupAlive(processGroups[0]))
          }
          seenProcessGroups.add(metadata.processGroupId)
          processGroups.push(metadata.processGroupId)
        }
        await fsp.mkdir(path.dirname(filePath), { recursive: true })
        await fsp.writeFile(filePath, JSON.stringify(metadata), 'utf8')
      },
      env: {
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
          ignoreMethods: ['initialize'],
        }),
      },
    })

    await expect(runtime.ensureReady()).rejects.toThrow(/initialize|failed to start codex app-server/i)

    expect(processGroups).toHaveLength(2)
    expect(previousAttemptGoneBeforeRetry).toBe(true)
    expect(Date.now() - start).toBeLessThan(1_500)
  }, 3_000)

  it('waits for a transiently unreadable wrapper identity without retrying startup', async () => {
    const tempDir = await makeTempDir()
    const metadataDir = path.join(tempDir, 'metadata')
    const processGroups: number[] = []
    const seenProcessGroups = new Set<number>()
    let identityReadAttempts = 0
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
      startupAttemptLimit: 2,
      startupAttemptTimeoutMs: 120,
      requestTimeoutMs: 1_000,
      processIdentityReader: async (pid) => {
        identityReadAttempts += 1
        if (identityReadAttempts === 1) return null
        return readWrapperIdentityForTest(pid)
      },
      metadataWriter: async (filePath, metadata) => {
        if (!seenProcessGroups.has(metadata.processGroupId)) {
          seenProcessGroups.add(metadata.processGroupId)
          processGroups.push(metadata.processGroupId)
        }
        await fsp.mkdir(path.dirname(filePath), { recursive: true })
        await fsp.writeFile(filePath, JSON.stringify(metadata), 'utf8')
      },
    })

    const ready = await runtime.ensureReady()
    const record = JSON.parse(await fsp.readFile(ready.metadataPath, 'utf8'))

    expect(processGroups).toHaveLength(1)
    expect(identityReadAttempts).toBe(2)
    expect(record.processGroupId).toBe(processGroups[0])
    expect(record.wrapperIdentity.startTimeTicks).toEqual(expect.any(Number))
  }, 3_000)

  it('waits for a transiently incomplete wrapper identity without retrying startup', async () => {
    const tempDir = await makeTempDir()
    const metadataDir = path.join(tempDir, 'metadata')
    const processGroups: number[] = []
    const seenProcessGroups = new Set<number>()
    let identityReadAttempts = 0
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
      startupAttemptLimit: 2,
      startupAttemptTimeoutMs: 120,
      requestTimeoutMs: 1_000,
      processIdentityReader: async (pid) => {
        identityReadAttempts += 1
        if (identityReadAttempts === 1) {
          return { commandLine: [], cwd: null, startTimeTicks: null }
        }
        return readWrapperIdentityForTest(pid)
      },
      metadataWriter: async (filePath, metadata) => {
        if (!seenProcessGroups.has(metadata.processGroupId)) {
          seenProcessGroups.add(metadata.processGroupId)
          processGroups.push(metadata.processGroupId)
        }
        await fsp.mkdir(path.dirname(filePath), { recursive: true })
        await fsp.writeFile(filePath, JSON.stringify(metadata), 'utf8')
      },
    })

    const ready = await runtime.ensureReady()
    const record = JSON.parse(await fsp.readFile(ready.metadataPath, 'utf8'))

    expect(processGroups).toHaveLength(1)
    expect(identityReadAttempts).toBe(2)
    expect(record.processGroupId).toBe(processGroups[0])
    expect(record.wrapperIdentity.commandLine.length).toBeGreaterThan(0)
    expect(record.wrapperIdentity.cwd).toEqual(expect.any(String))
    expect(record.wrapperIdentity.startTimeTicks).toEqual(expect.any(Number))
  }, 3_000)

  it('escalates to SIGKILL when the native child ignores SIGTERM', async () => {
    const metadataDir = await makeTempDir()
    const nativePidFile = path.join(metadataDir, 'native.pid')
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
      env: {
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
          spawnNativeChild: true,
          nativePidFile,
          nativeChildIgnoresSigterm: true,
          wrapperLeavesNativeOnSigterm: true,
        }),
      },
    })

    const ready = await runtime.ensureReady()
    const nativePid = await waitForPidFile(nativePidFile)

    await runtime.shutdown()

    await waitForProcessExit(ready.processPid)
    await waitForProcessExit(nativePid)
    await expect(fsp.stat(ready.metadataPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('sets the ownership id in the fake native child environment', async () => {
    const metadataDir = await makeTempDir()
    const nativePidFile = path.join(metadataDir, 'native.pid')
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
      env: {
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
          spawnNativeChild: true,
          nativePidFile,
        }),
      },
    })

    const ready = await runtime.ensureReady()
    const nativePid = await waitForPidFile(nativePidFile)
    const nativeEnv = await readProcessEnvironment(nativePid)

    expect(ready.ownershipId).toEqual(expect.any(String))
    expect(nativeEnv.FRESHELL_CODEX_SIDECAR_ID).toBe(ready.ownershipId)
  })

  it('rejects adoption metadata updates when no active owned sidecar exists', async () => {
    const runtime = createRuntime()

    await expect(runtime.updateOwnershipMetadata({
      terminalId: 'term-missing',
      generation: 1,
    })).rejects.toThrow(/no active owned codex app-server sidecar/i)
  })

  it('tears down the process group and fails startup when ownership metadata cannot be written', async () => {
    const tempDir = await makeTempDir()
    const metadataDir = path.join(tempDir, 'metadata')
    const nativePidFile = path.join(tempDir, 'native.pid')
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
      startupAttemptLimit: 1,
      metadataWriter: async () => {
        await waitForPidFile(nativePidFile)
        throw new Error('simulated metadata write failure')
      },
      env: {
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
          spawnNativeChild: true,
          nativePidFile,
          wrapperLeavesNativeOnSigterm: true,
        }),
      },
    })

    await expect(runtime.ensureReady()).rejects.toThrow(/ownership metadata/i)

    const nativePid = await waitForPidFile(nativePidFile)
    await waitForProcessExit(nativePid)
  })

  it('does not retry startup when failed-attempt teardown cannot be verified', async () => {
    const tempDir = await makeTempDir()
    const metadataDir = path.join(tempDir, 'metadata')
    const spawnedProcessGroups: number[] = []
    let metadataWriteAttempts = 0
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
      startupAttemptLimit: 3,
      metadataWriter: async (_filePath, metadata) => {
        metadataWriteAttempts += 1
        spawnedProcessGroups.push(metadata.processGroupId)
        metadata.processGroupId = await readCurrentProcessGroupId()
        throw new Error('simulated metadata write failure')
      },
    })

    try {
      await expect(runtime.ensureReady()).rejects.toThrow(/teardown failed|process-group teardown failed/i)
      expect(metadataWriteAttempts).toBe(1)
    } finally {
      runtimes.delete(runtime)
      for (const processGroupId of spawnedProcessGroups) {
        await killProcessGroupForTest(processGroupId)
      }
    }
  })

  it('rejects shutdown when owned process-group teardown cannot be verified', async () => {
    const metadataDir = await makeTempDir()
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
    })

    const ready = await runtime.ensureReady()
    const ownership = (runtime as any).ownership
    ownership.metadata.processGroupId = await readCurrentProcessGroupId()

    await expect(runtime.shutdown()).rejects.toThrow(/could not be verified|failed/i)

    runtimes.delete(runtime)
    await killProcessGroupForTest(ready.processGroupId)
  })

  it('does not use matching wrapper identity to authorize teardown of a different process group', async () => {
    const firstRuntime = createRuntime({
      metadataDir: await makeTempDir(),
      serverInstanceId: 'srv-runtime-test',
    })
    const secondRuntime = createRuntime({
      metadataDir: await makeTempDir(),
      serverInstanceId: 'srv-runtime-test',
    })
    let firstReady: Awaited<ReturnType<CodexAppServerRuntime['ensureReady']>> | undefined
    let secondReady: Awaited<ReturnType<CodexAppServerRuntime['ensureReady']>> | undefined

    try {
      firstReady = await firstRuntime.ensureReady()
      secondReady = await secondRuntime.ensureReady()
      const ownership = (firstRuntime as any).ownership
      ownership.metadata.processGroupId = secondReady.processGroupId

      await expect(firstRuntime.shutdown()).rejects.toThrow(/could not be verified|failed|ownership/i)
      expect(await isProcessGroupAlive(secondReady.processGroupId)).toBe(true)
      expect(await isProcessGroupAlive(firstReady.processGroupId)).toBe(true)
    } finally {
      runtimes.delete(firstRuntime)
      runtimes.delete(secondRuntime)
      if (firstReady) await killProcessGroupForTest(firstReady.processGroupId)
      if (secondReady) await killProcessGroupForTest(secondReady.processGroupId)
    }
  })

  it('does not use wrapper start ticks alone when command line and cwd no longer match', async () => {
    const metadataDir = await makeTempDir()
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
    })
    const ready = await runtime.ensureReady()
    const ownership = (runtime as any).ownership
    ownership.metadata.wrapperIdentity = {
      commandLine: ['not-the-recorded-wrapper-command'],
      cwd: '/not/the/recorded/cwd',
      startTimeTicks: ownership.metadata.wrapperIdentity.startTimeTicks,
    }
    const originalReadFile = fsp.readFile.bind(fsp)
    const readFileSpy = vi.spyOn(fsp, 'readFile').mockImplementation(((target: any, options?: any) => {
      if (String(target) === `/proc/${ready.processPid}/environ`) {
        return Promise.resolve(Buffer.from('')) as any
      }
      return originalReadFile(target, options as any) as any
    }) as typeof fsp.readFile)

    try {
      await expect(runtime.shutdown()).rejects.toThrow(/could not be verified|failed|ownership/i)
      expect(await isProcessGroupAlive(ready.processGroupId)).toBe(true)
    } finally {
      readFileSpy.mockRestore()
      runtimes.delete(runtime)
      await killProcessGroupForTest(ready.processGroupId)
    }
  })

  it('keeps failed teardown ownership sticky and refuses a later startup', async () => {
    const metadataDir = await makeTempDir()
    let metadataWriteAttempts = 0
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
      metadataWriter: async (filePath, metadata) => {
        metadataWriteAttempts += 1
        await fsp.mkdir(path.dirname(filePath), { recursive: true })
        await fsp.writeFile(filePath, JSON.stringify(metadata), 'utf8')
      },
    })

    const ready = await runtime.ensureReady()
    const metadataWriteAttemptsAfterReady = metadataWriteAttempts
    const ownership = (runtime as any).ownership
    ownership.metadata.processGroupId = await readCurrentProcessGroupId()

    await expect(runtime.shutdown()).rejects.toThrow(/could not be verified|failed/i)
    await expect(runtime.ensureReady()).rejects.toThrow(/teardown failed|blocked/i)
    expect(metadataWriteAttempts).toBe(metadataWriteAttemptsAfterReady)

    runtimes.delete(runtime)
    await killProcessGroupForTest(ready.processGroupId)
  })

  it('does not treat a live process group as gone when /proc member scanning returns no members', async () => {
    const metadataDir = await makeTempDir()
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
    })
    const ready = await runtime.ensureReady()
    const ownership = (runtime as any).ownership
    ownership.metadata.wrapperIdentity = {
      ...ownership.metadata.wrapperIdentity,
      startTimeTicks: -1,
    }
    const originalReaddir = fsp.readdir.bind(fsp)
    const readdirSpy = vi.spyOn(fsp, 'readdir').mockImplementation(((target: any, options?: any) => {
      if (String(target) === '/proc') {
        return Promise.resolve([]) as any
      }
      return originalReaddir(target, options as any) as any
    }) as typeof fsp.readdir)

    try {
      await expect(runtime.shutdown()).rejects.toThrow(/could not be verified|failed|ownership/i)
      expect(await isProcessGroupAlive(ready.processGroupId)).toBe(true)
    } finally {
      readdirSpy.mockRestore()
      runtimes.delete(runtime)
      await killProcessGroupForTest(ready.processGroupId)
    }
  })

  it('sets sticky failed ownership when process-group teardown throws', async () => {
    const metadataDir = await makeTempDir()
    let ownershipIdCalls = 0
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
      ownershipIdFactory: () => {
        ownershipIdCalls += 1
        return `ownership-throws-${ownershipIdCalls}`
      },
    })
    const ready = await runtime.ensureReady()
    const originalUnlink = fsp.unlink.bind(fsp)
    const unlinkSpy = vi.spyOn(fsp, 'unlink').mockImplementation(((target: any) => {
      if (String(target) === ready.metadataPath) {
        return Promise.reject(new Error('simulated metadata unlink failure'))
      }
      return originalUnlink(target) as any
    }) as typeof fsp.unlink)

    try {
      await expect(runtime.shutdown()).rejects.toThrow('simulated metadata unlink failure')
      await expect(runtime.ensureReady()).rejects.toThrow(/simulated metadata unlink failure|blocked/i)
      expect(ownershipIdCalls).toBe(1)
    } finally {
      unlinkSpy.mockRestore()
      await runtime.shutdown().catch(() => undefined)
      runtimes.delete(runtime)
      await killProcessGroupForTest(ready.processGroupId)
    }
  })

  it('retries a failed live process-group teardown on a later shutdown join', async () => {
    const metadataDir = await makeTempDir()
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
    })
    const ready = await runtime.ensureReady()
    const originalKill = process.kill
    let injected = false
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (!injected && pid === -ready.processGroupId && signal === 'SIGTERM') {
        injected = true
        const error = new Error('simulated transient SIGTERM failure') as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      }
      return originalKill(pid, signal as any)
    }) as typeof process.kill)

    try {
      await expect(runtime.shutdown()).rejects.toThrow('simulated transient SIGTERM failure')
      expect(await isProcessGroupAlive(ready.processGroupId)).toBe(true)

      killSpy.mockRestore()

      await expect(runtime.shutdown()).resolves.toBeUndefined()
      await waitForProcessExit(ready.processPid)
      expect(await isProcessGroupAlive(ready.processGroupId)).toBe(false)
      await expect(fsp.stat(ready.metadataPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      killSpy.mockRestore()
      runtimes.delete(runtime)
      await killProcessGroupForTest(ready.processGroupId)
    }
  })

  it('rejects with a launch error instead of crashing when the command is missing', async () => {
    const runtime = new CodexAppServerRuntime({
      command: '/tmp/definitely-missing-freshell-codex-binary',
      startupAttemptLimit: 1,
      startupAttemptTimeoutMs: 100,
    })
    runtimes.add(runtime)

    await expect(runtime.ensureReady()).rejects.toThrow(/failed to launch codex app-server sidecar|enoent/i)
  })

  it('reaps only verified stale new-schema sidecar groups on startup', async () => {
    const metadataDir = await makeTempDir()
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-previous',
    })
    const ready = await runtime.ensureReady()
    const raw = await fsp.readFile(ready.metadataPath, 'utf8')
    const metadata = JSON.parse(raw)
    await fsp.writeFile(ready.metadataPath, JSON.stringify({
      ...metadata,
      ownerServerPid: 999_999_999,
      serverInstanceId: 'srv-previous',
      updatedAt: new Date().toISOString(),
    }, null, 2), 'utf8')

    const result = await reapOrphanedCodexAppServerSidecars({
      metadataDir,
      serverInstanceId: 'srv-current',
    })
    runtimes.delete(runtime)

    expect(result.reapedOwnershipIds).toContain(ready.ownershipId)
    await waitForProcessExit(ready.processPid)
    await expect(fsp.stat(ready.metadataPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('treats unreaped new-schema ownership records as a startup-blocking reaper failure', () => {
    expect(() => assertCodexStartupReaperSucceeded({
      reapedOwnershipIds: [],
      ignoredLegacyRecords: [],
      skippedActiveOwnershipIds: [],
      failedOwnershipIds: ['ownership-alpha', 'ownership-beta'],
    })).toThrow(/startup reaper failed.*ownership-alpha.*ownership-beta/i)
  })

  it('blocks startup when a new-schema ownership record is skipped because the owner pid is live', async () => {
    const metadataDir = await makeTempDir()
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-previous',
    })
    const ready = await runtime.ensureReady()
    await markOwnershipRecordStale(ready.metadataPath, {
      ownerServerPid: process.pid,
    })

    await expect(runCodexStartupReaper({
      metadataDir,
      serverInstanceId: 'srv-current',
      terminateGraceMs: 1,
    })).rejects.toThrow(new RegExp(ready.ownershipId))
    await expect(fsp.stat(ready.metadataPath)).resolves.toBeDefined()
    expect(await isProcessGroupAlive(ready.processGroupId)).toBe(true)
  })

  it('propagates thrown startup reaper failures instead of treating them as warning fallbacks', async () => {
    const metadataDir = await makeTempDir()
    const originalReaddir = fsp.readdir.bind(fsp)
    const readdirSpy = vi.spyOn(fsp, 'readdir').mockImplementation(((target: any, options?: any) => {
      if (String(target) === metadataDir) {
        return Promise.reject(new Error('simulated startup reaper metadata scan failure'))
      }
      return originalReaddir(target, options as any) as any
    }) as typeof fsp.readdir)

    try {
      await expect(runCodexStartupReaper({
        metadataDir,
        serverInstanceId: 'srv-current',
      })).rejects.toThrow('simulated startup reaper metadata scan failure')
    } finally {
      readdirSpy.mockRestore()
    }
  })

  it('propagates startup reaper ownership verification failures', async () => {
    const metadataDir = await makeTempDir()
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-previous',
    })
    const ready = await runtime.ensureReady()
    const raw = await fsp.readFile(ready.metadataPath, 'utf8')
    const metadata = JSON.parse(raw)
    await markOwnershipRecordStale(ready.metadataPath, {
      wrapperIdentity: {
        ...metadata.wrapperIdentity,
        startTimeTicks: -1,
      },
    })
    const originalReaddir = fsp.readdir.bind(fsp)
    let procReaddirCalls = 0
    const readdirSpy = vi.spyOn(fsp, 'readdir').mockImplementation(((target: any, options?: any) => {
      if (String(target) === '/proc') {
        procReaddirCalls += 1
        if (procReaddirCalls > 1) {
          return Promise.reject(new Error('simulated ownership verification proc failure'))
        }
      }
      return originalReaddir(target, options as any) as any
    }) as typeof fsp.readdir)

    try {
      await expect(runCodexStartupReaper({
        metadataDir,
        serverInstanceId: 'srv-current',
        terminateGraceMs: 1,
      })).rejects.toThrow('simulated ownership verification proc failure')
    } finally {
      readdirSpy.mockRestore()
    }
  })

  it('propagates startup reaper process-group signaling failures', async () => {
    const metadataDir = await makeTempDir()
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-previous',
    })
    const ready = await runtime.ensureReady()
    await markOwnershipRecordStale(ready.metadataPath)
    const originalKill = process.kill
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -ready.processGroupId && signal === 'SIGTERM') {
        const error = new Error('simulated SIGTERM failure') as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      }
      return originalKill(pid, signal as any)
    }) as typeof process.kill)

    try {
      await expect(runCodexStartupReaper({
        metadataDir,
        serverInstanceId: 'srv-current',
        terminateGraceMs: 1,
      })).rejects.toThrow('simulated SIGTERM failure')
      expect(await isProcessGroupAlive(ready.processGroupId)).toBe(true)
    } finally {
      killSpy.mockRestore()
    }
  })

  it('propagates startup reaper wait-for-gone diagnostic failures', async () => {
    const metadataDir = await makeTempDir()
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-previous',
    })
    const ready = await runtime.ensureReady()
    await markOwnershipRecordStale(ready.metadataPath)
    const originalKill = process.kill
    let throwRemainingScan = false
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -ready.processGroupId && (signal === 'SIGTERM' || signal === 'SIGKILL')) {
        if (signal === 'SIGKILL') throwRemainingScan = true
        return true
      }
      return originalKill(pid, signal as any)
    }) as typeof process.kill)
    const originalReaddir = fsp.readdir.bind(fsp)
    const readdirSpy = vi.spyOn(fsp, 'readdir').mockImplementation(((target: any, options?: any) => {
      if (String(target) === '/proc' && throwRemainingScan) {
        return Promise.reject(new Error('simulated wait-for-gone process scan failure'))
      }
      return originalReaddir(target, options as any) as any
    }) as typeof fsp.readdir)

    try {
      await expect(runCodexStartupReaper({
        metadataDir,
        serverInstanceId: 'srv-current',
        terminateGraceMs: 1,
      })).rejects.toThrow('simulated wait-for-gone process scan failure')
      expect(await isProcessGroupAlive(ready.processGroupId)).toBe(true)
    } finally {
      readdirSpy.mockRestore()
      killSpy.mockRestore()
    }
  })

  it('propagates startup reaper metadata removal failures', async () => {
    const metadataDir = await makeTempDir()
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-previous',
    })
    const ready = await runtime.ensureReady()
    await markOwnershipRecordStale(ready.metadataPath)
    const originalKill = process.kill
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -ready.processGroupId && signal === 0) {
        const error = new Error('simulated process group gone') as NodeJS.ErrnoException
        error.code = 'ESRCH'
        throw error
      }
      return originalKill(pid, signal as any)
    }) as typeof process.kill)
    const originalUnlink = fsp.unlink.bind(fsp)
    const unlinkSpy = vi.spyOn(fsp, 'unlink').mockImplementation(((target: any) => {
      if (String(target) === ready.metadataPath) {
        return Promise.reject(new Error('simulated metadata removal failure'))
      }
      return originalUnlink(target) as any
    }) as typeof fsp.unlink)

    try {
      await expect(runCodexStartupReaper({
        metadataDir,
        serverInstanceId: 'srv-current',
        terminateGraceMs: 1,
      })).rejects.toThrow('simulated metadata removal failure')
      await expect(fsp.stat(ready.metadataPath)).resolves.toBeDefined()
    } finally {
      unlinkSpy.mockRestore()
      killSpy.mockRestore()
    }
  })

  it('removes legacy sidecar records without process-name cleanup', async () => {
    const metadataDir = await makeTempDir()
    const legacyPath = path.join(metadataDir, 'legacy.json')
    await fsp.writeFile(legacyPath, JSON.stringify({
      pid: 12345,
      wsUrl: 'ws://127.0.0.1:55555',
    }), 'utf8')

    const result = await reapOrphanedCodexAppServerSidecars({
      metadataDir,
      serverInstanceId: 'srv-current',
    })

    expect(result.ignoredLegacyRecords).toContain(legacyPath)
    await expect(fsp.stat(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains malformed new-schema ownership records and reports them as startup-blocking failures', async () => {
    const metadataDir = await makeTempDir()
    const malformedPath = path.join(metadataDir, 'damaged-new-schema.json')
    await fsp.writeFile(malformedPath, JSON.stringify({
      schemaVersion: 1,
      ownershipId: 'damaged-ownership',
      serverInstanceId: 'srv-previous',
      ownerServerPid: 999_999_999,
    }), 'utf8')

    const result = await reapOrphanedCodexAppServerSidecars({
      metadataDir,
      serverInstanceId: 'srv-current',
    })

    expect(result.ignoredLegacyRecords).not.toContain(malformedPath)
    expect(result.failedOwnershipIds).toContain('damaged-ownership')
    await expect(fsp.stat(malformedPath)).resolves.toBeDefined()
    expect(() => assertCodexStartupReaperSucceeded(result)).toThrow(/damaged-ownership/)
  })

  it('retains schema-v1 ownership records with invalid numeric ownership fields', async () => {
    const metadataDir = await makeTempDir()
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-previous',
    })
    const ready = await runtime.ensureReady()
    await markOwnershipRecordStale(ready.metadataPath, {
      processGroupId: 0,
    })

    const result = await reapOrphanedCodexAppServerSidecars({
      metadataDir,
      serverInstanceId: 'srv-current',
    })

    expect(result.reapedOwnershipIds).not.toContain(ready.ownershipId)
    expect(result.failedOwnershipIds).toContain(ready.ownershipId)
    await expect(fsp.stat(ready.metadataPath)).resolves.toBeDefined()
    expect(await isProcessGroupAlive(ready.processGroupId)).toBe(true)
    expect(() => assertCodexStartupReaperSucceeded(result)).toThrow(new RegExp(ready.ownershipId))
  })

  it('does not reap new-schema records for the current process group', async () => {
    const metadataDir = await makeTempDir()
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-previous',
    })
    const ready = await runtime.ensureReady()
    const raw = await fsp.readFile(ready.metadataPath, 'utf8')
    const metadata = JSON.parse(raw)
    await fsp.writeFile(ready.metadataPath, JSON.stringify({
      ...metadata,
      ownerServerPid: 999_999_999,
      processGroupId: await readCurrentProcessGroupId(),
      updatedAt: new Date().toISOString(),
    }, null, 2), 'utf8')

    const result = await reapOrphanedCodexAppServerSidecars({
      metadataDir,
      serverInstanceId: 'srv-current',
    })

    expect(result.skippedActiveOwnershipIds).toContain(ready.ownershipId)
    await expect(fsp.stat(ready.metadataPath)).resolves.toBeDefined()
  })

  it('proxies thread/start through the sidecar client after boot', async () => {
    const runtime = createRuntime()

    await expect(runtime.startThread({ cwd: '/repo/worktree' })).resolves.toEqual({
      threadId: 'thread-new-1',
      wsUrl: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/),
    })
  })

  it('proxies thread/resume through the sidecar client after boot', async () => {
    const runtime = createRuntime()

    await expect(runtime.resumeThread({
      threadId: '019d9859-5670-72b1-851f-794ad7fef112',
      cwd: '/repo/worktree',
    })).resolves.toEqual({
      threadId: '019d9859-5670-72b1-851f-794ad7fef112',
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

  it('does not publish ready when the app-server client socket disconnects before startup completes', async () => {
    const runtime = createRuntime({
      startupAttemptLimit: 1,
      metadataWriter: async (filePath, metadata) => {
        if (metadata.codexHome) {
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
        await fsp.mkdir(path.dirname(filePath), { recursive: true })
        await fsp.writeFile(filePath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 })
      },
      env: {
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
          closeSocketAfterMethodsOnce: ['initialize'],
        }),
      },
    })
    const onExit = vi.fn()
    runtime.onExit(onExit)

    await expect(runtime.ensureReady()).rejects.toThrow(
      /Codex app-server client disconnected before startup completed/,
    )
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
      threadId: 'thread-new-1',
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
      threadId: '019d9859-5670-72b1-851f-794ad7fef112',
      wsUrl: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/),
    })
  })
})
