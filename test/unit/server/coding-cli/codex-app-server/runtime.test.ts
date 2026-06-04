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

// These tests spawn a REAL `node` sidecar (the fake-app-server fixture) and require it to
// reach `initialize`. The suite runs with fileParallelism + maxConcurrency (vitest.server.config.ts),
// so freshly-spawned sidecars are CPU-starved; a tight per-attempt budget makes a real spawn+bind+
// initialize miss its deadline and the runtime reject (`did not finish initialize within Nms` /
// `ECONNREFUSED`) — the dominant flake under load. These tests assert lifecycle *behavior*, not
// startup latency, so the budget is generous on purpose. Production's own default is
// DEFAULT_STARTUP_ATTEMPT_TIMEOUT_MS = 3000; this stays above it to absorb CI contention.
const REAL_STARTUP_ATTEMPT_TIMEOUT_MS = 5_000

// Polling deadline for the test helpers that wait on real OS side effects (pid files, process
// exit, metadata records). These observe second-order spawns (e.g. a fixture's native child) that
// can lag well past a second under CI contention. Generous because it only bites when the awaited
// effect is genuinely slow; a real hang still trips the suite's 30s wall-clock.
const WAIT_HELPER_TIMEOUT_MS = 15_000

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

async function waitForProcessExit(pid: number, timeoutMs = WAIT_HELPER_TIMEOUT_MS): Promise<void> {
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

async function waitForMetadataRecord(
  metadataDir: string,
  predicate: (record: any) => boolean = () => true,
  timeoutMs = WAIT_HELPER_TIMEOUT_MS,
): Promise<any> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const entries = await fsp.readdir(metadataDir).catch(() => [])
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const raw = await fsp.readFile(path.join(metadataDir, entry), 'utf8')
      const record = JSON.parse(raw)
      // The runtime writes the record twice: first with an empty wrapper identity, then again once
      // /proc identity resolves. A bare read can catch the first write (null startTimeTicks); the
      // predicate lets callers wait for the field they assert on instead of racing that gap.
      if (predicate(record)) return record
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  throw new Error(`Timed out waiting for metadata record in ${metadataDir}`)
}

async function waitForPidFile(pidFile: string, timeoutMs = WAIT_HELPER_TIMEOUT_MS): Promise<number> {
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

if (process.platform !== 'linux') {
  describe('CodexAppServerRuntime unsupported platform', () => {
    it('rejects before spawning without Linux /proc ownership support', async () => {
      const metadataDir = await makeTempDir()
      const runtime = createRuntime({
        metadataDir,
        startupAttemptLimit: 1,
      })

      await expect(runtime.ensureReady()).rejects.toThrow(/linux.*\/proc/i)
      const entries = await fsp.readdir(metadataDir).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      })
      expect(entries).toEqual([])
    })
  })
}

const describeWithLinuxProc = process.platform === 'linux' ? describe : describe.skip

describeWithLinuxProc('CodexAppServerRuntime', () => {
  it('starts one owned loopback app-server sidecar on first use', async () => {
    const runtime = createRuntime()

    const ready = await runtime.ensureReady()

    expect(ready.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/)
    expect(ready.processPid).toBeGreaterThan(0)
    expect(runtime.status()).toBe('running')
  })

  it('disables Codex apps while starting Freshell-managed app-server processes', async () => {
    const tempDir = await makeTempDir()
    const argLogPath = path.join(tempDir, 'argv.json')
    const runtime = createRuntime({
      env: {
        FAKE_CODEX_APP_SERVER_ARG_LOG: argLogPath,
      },
    })

    await runtime.ensureReady()

    const payload = JSON.parse(await fsp.readFile(argLogPath, 'utf8')) as {
      argv: string[]
    }
    const args = payload.argv

    expect(args).toContain('-c')
    expect(args).toContain('features.apps=false')
    expect(args.indexOf('features.apps=false')).toBeLessThan(args.indexOf('app-server'))
    expect(args).toContain('--listen')
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
    // Wait for the identity-complete write; a bare read can catch the runtime's first (empty) write.
    const metadata = await waitForMetadataRecord(
      metadataDir,
      (record) => typeof record.wrapperIdentity?.startTimeTicks === 'number',
    )
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
      processIdentityReader: async (pid) => {
        if (pid === process.pid) return readWrapperIdentityForTest(pid)
        identityLookupStarted()
        return identityReleased
      },
    })

    const readyPromise = runtime.ensureReady()
    try {
      await identityStarted
      // This test asserts the FIRST (empty-identity) write, so keep the default predicate.
      const metadata = await waitForMetadataRecord(metadataDir, () => true, 500)

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

  it('keeps the same sidecar when wrapper identity is transiently incomplete', async () => {
    const tempDir = await makeTempDir()
    const metadataDir = path.join(tempDir, 'metadata')
    const processGroups: number[] = []
    const seenProcessGroups = new Set<number>()
    let identityReadAttempts = 0
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
      startupAttemptLimit: 1,
      startupAttemptTimeoutMs: REAL_STARTUP_ATTEMPT_TIMEOUT_MS,
      processIdentityReader: async (pid) => {
        if (pid === process.pid) return readWrapperIdentityForTest(pid)
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

    expect(processGroups).toEqual([ready.processGroupId])
    expect(identityReadAttempts).toBe(2)
    expect(record.wrapperIdentity.commandLine.length).toBeGreaterThan(0)
    expect(record.wrapperIdentity.cwd).toEqual(expect.any(String))
    expect(record.wrapperIdentity.startTimeTicks).toEqual(expect.any(Number))
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
      startupAttemptTimeoutMs: 500,
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
    // A tight per-attempt budget is intentional here: this test verifies the per-attempt timeout
    // FIRES and tears down a hung initialize before retrying (the fake server ignores `initialize`).
    const STARTUP_ATTEMPT_LIMIT = 2
    const STARTUP_ATTEMPT_TIMEOUT_MS = 500
    const start = Date.now()
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
      startupAttemptLimit: STARTUP_ATTEMPT_LIMIT,
      startupAttemptTimeoutMs: STARTUP_ATTEMPT_TIMEOUT_MS,
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
    // Boundedness: the per-attempt timeout (not a longer/absent one) must govern how fast we give
    // up and retry. Generous slack absorbs two real spawn+teardown cycles under CI contention; a
    // genuine hang is still caught by the suite's 30s wall-clock.
    expect(Date.now() - start).toBeLessThan(STARTUP_ATTEMPT_LIMIT * STARTUP_ATTEMPT_TIMEOUT_MS + 6_000)
  })

  it('tears down the owned process group before retry when wrapper identity cannot be read', async () => {
    const tempDir = await makeTempDir()
    const metadataDir = path.join(tempDir, 'metadata')
    const processGroups: number[] = []
    const seenProcessGroups = new Set<number>()
    let previousAttemptGoneBeforeRetry = false
    let identityReadAttempts = 0
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
      startupAttemptLimit: 2,
      startupAttemptTimeoutMs: REAL_STARTUP_ATTEMPT_TIMEOUT_MS,
      requestTimeoutMs: 1_000,
      processIdentityReader: async (pid) => {
        identityReadAttempts += 1
        if (pid === processGroups[0]) return null
        return readWrapperIdentityForTest(pid)
      },
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
    })

    const ready = await runtime.ensureReady()
    const record = JSON.parse(await fsp.readFile(ready.metadataPath, 'utf8'))

    expect(processGroups).toHaveLength(2)
    expect(identityReadAttempts).toBeGreaterThan(2)
    expect(previousAttemptGoneBeforeRetry).toBe(true)
    expect(record.processGroupId).toBe(processGroups[1])
    expect(record.wrapperIdentity.startTimeTicks).toEqual(expect.any(Number))
  })

  it('tears down the owned process group before retry when wrapper identity is incomplete', async () => {
    const tempDir = await makeTempDir()
    const metadataDir = path.join(tempDir, 'metadata')
    const processGroups: number[] = []
    const seenProcessGroups = new Set<number>()
    let previousAttemptGoneBeforeRetry = false
    let identityReadAttempts = 0
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
      startupAttemptLimit: 2,
      startupAttemptTimeoutMs: REAL_STARTUP_ATTEMPT_TIMEOUT_MS,
      requestTimeoutMs: 1_000,
      processIdentityReader: async (pid) => {
        identityReadAttempts += 1
        if (pid === processGroups[0]) {
          return { commandLine: [], cwd: null, startTimeTicks: null }
        }
        return readWrapperIdentityForTest(pid)
      },
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
    })

    const ready = await runtime.ensureReady()
    const record = JSON.parse(await fsp.readFile(ready.metadataPath, 'utf8'))

    expect(processGroups).toHaveLength(2)
    expect(identityReadAttempts).toBeGreaterThan(2)
    expect(previousAttemptGoneBeforeRetry).toBe(true)
    expect(record.processGroupId).toBe(processGroups[1])
    expect(record.wrapperIdentity.commandLine.length).toBeGreaterThan(0)
    expect(record.wrapperIdentity.cwd).toEqual(expect.any(String))
    expect(record.wrapperIdentity.startTimeTicks).toEqual(expect.any(Number))
  })

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

  it('cleans up the stale record and refuses to signal when ownership moved to a different process group', async () => {
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
      const firstMetadataPath = ownership.metadataPath as string
      // Our wrapper is no longer in this group and nothing in it carries our ownership env:
      // the sidecar is effectively gone and the PGID is foreign.
      ownership.metadata.processGroupId = secondReady.processGroupId

      // Foreign ownership: shutdown resolves, cleans up our stale record, and never signals the
      // foreign group.
      await firstRuntime.shutdown()

      await expect(fsp.stat(firstMetadataPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await isProcessGroupAlive(secondReady.processGroupId)).toBe(true)
      expect(await isProcessGroupAlive(firstReady.processGroupId)).toBe(true)
    } finally {
      runtimes.delete(firstRuntime)
      runtimes.delete(secondRuntime)
      if (firstReady) await killProcessGroupForTest(firstReady.processGroupId)
      if (secondReady) await killProcessGroupForTest(secondReady.processGroupId)
    }
  })

  it('cleans up the stale record at the SIGKILL gate when ownership changes during shutdown', async () => {
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
    const originalKill = process.kill.bind(process)
    let killSpy: ReturnType<typeof vi.spyOn> | undefined

    try {
      firstReady = await firstRuntime.ensureReady()
      secondReady = await secondRuntime.ensureReady()
      const ownership = (firstRuntime as any).ownership
      const firstMetadataPath = ownership.metadataPath as string
      const ownedGroup = firstReady.processGroupId
      const foreignGroup = secondReady.processGroupId

      // Ownership is valid at the first gate. When the runtime SIGTERMs the owned group, swallow the
      // signal (so the owned group survives the 1s grace window and we reach the SIGKILL gate) and
      // move ownership to a live foreign group, so the recheck classifies `foreign`. Liveness probes
      // (signal 0) and every other signal pass through unchanged.
      killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === -ownedGroup && signal === 'SIGTERM') {
          ownership.metadata.processGroupId = foreignGroup
          return true
        }
        return originalKill(pid as any, signal as any)
      }) as typeof process.kill)

      await firstRuntime.shutdown()

      await expect(fsp.stat(firstMetadataPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await isProcessGroupAlive(foreignGroup)).toBe(true)
      expect(await isProcessGroupAlive(ownedGroup)).toBe(true)
    } finally {
      killSpy?.mockRestore()
      runtimes.delete(firstRuntime)
      runtimes.delete(secondRuntime)
      if (firstReady) await killProcessGroupForTest(firstReady.processGroupId)
      if (secondReady) await killProcessGroupForTest(secondReady.processGroupId)
    }
  }, 20_000)

  it('disowns the stale record when the wrapper PID is gone and the PGID was reused by a foreign group', async () => {
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
    let readFileSpy: ReturnType<typeof vi.spyOn> | undefined

    try {
      firstReady = await firstRuntime.ensureReady()
      secondReady = await secondRuntime.ensureReady()
      const ownership = (firstRuntime as any).ownership
      const firstMetadataPath = ownership.metadataPath as string
      // Canonical production case: the sidecar process EXITED (its /proc/<wrapperPid>/stat reads
      // ENOENT, so the wrapper read classifies `gone`) and the recorded PGID was REUSED by a live,
      // unrelated group. This pins the `wrapperResult.kind === 'gone'` -> `foreign` branch — distinct
      // from the wrapper-in-a-different-live-group branch every other foreign test exercises.
      const goneWrapperStatPath = `/proc/${firstReady.processPid}/stat`
      ownership.metadata.processGroupId = secondReady.processGroupId
      const originalReadFile = fsp.readFile.bind(fsp)
      readFileSpy = vi.spyOn(fsp, 'readFile').mockImplementation(((target: any, options?: any) => {
        if (String(target) === goneWrapperStatPath) {
          const error = new Error('no such process') as NodeJS.ErrnoException
          error.code = 'ENOENT'
          return Promise.reject(error) as any
        }
        return originalReadFile(target, options as any) as any
      }) as typeof fsp.readFile)

      await firstRuntime.shutdown()

      await expect(fsp.stat(firstMetadataPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await isProcessGroupAlive(secondReady.processGroupId)).toBe(true)
      expect(await isProcessGroupAlive(firstReady.processGroupId)).toBe(true)
    } finally {
      readFileSpy?.mockRestore()
      runtimes.delete(firstRuntime)
      runtimes.delete(secondRuntime)
      if (firstReady) await killProcessGroupForTest(firstReady.processGroupId)
      if (secondReady) await killProcessGroupForTest(secondReady.processGroupId)
    }
  }, 20_000)

  it('does not use wrapper start ticks alone when command line and cwd no longer match', async () => {
    const metadataDir = await makeTempDir()
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
    })
    const ready = await runtime.ensureReady()
    const ownership = (runtime as any).ownership
    const indeterminateMetadataPath = ownership.metadataPath as string
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
      await expect(fsp.stat(indeterminateMetadataPath)).resolves.toBeDefined()
    } finally {
      readFileSpy.mockRestore()
      runtimes.delete(runtime)
      await killProcessGroupForTest(ready.processGroupId)
    }
  })

  it('refuses to disown and keeps the record when a group member ownership proof is unreadable', async () => {
    const metadataDir = await makeTempDir()
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
    })
    const ready = await runtime.ensureReady()
    const ownership = (runtime as any).ownership
    const metadataPath = ownership.metadataPath as string
    // Force the member scan (wrapper no longer resident in the group), then make every
    // /proc/<pid>/environ read fail with EACCES so no live member can be proven ours.
    ownership.metadata.wrapperPid = 1
    const originalReadFile = fsp.readFile.bind(fsp)
    const readFileSpy = vi.spyOn(fsp, 'readFile').mockImplementation(((target: any, options?: any) => {
      if (/^\/proc\/\d+\/environ$/.test(String(target))) {
        const error = new Error('permission denied') as NodeJS.ErrnoException
        error.code = 'EACCES'
        return Promise.reject(error) as any
      }
      return originalReadFile(target, options as any) as any
    }) as typeof fsp.readFile)

    try {
      await expect(runtime.shutdown()).rejects.toThrow(/could not be verified|failed|ownership/i)
      await expect(fsp.stat(metadataPath)).resolves.toBeDefined()
      expect(await isProcessGroupAlive(ready.processGroupId)).toBe(true)
    } finally {
      readFileSpy.mockRestore()
      runtimes.delete(runtime)
      await killProcessGroupForTest(ready.processGroupId)
    }
  }, 20_000)

  it('refuses to disown and keeps the record when the wrapper stat is unreadable', async () => {
    const metadataDir = await makeTempDir()
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
    })
    const ready = await runtime.ensureReady()
    const ownership = (runtime as any).ownership
    const metadataPath = ownership.metadataPath as string
    // No member can positively match (bogus id), and the wrapper's /proc/<pid>/stat is unreadable —
    // so membership is unprovable and the group must classify `indeterminate`, never `foreign`.
    ownership.metadata.ownershipId = 'no-such-ownership-id'
    const wrapperStatPath = `/proc/${ready.processPid}/stat`
    const originalReadFile = fsp.readFile.bind(fsp)
    const readFileSpy = vi.spyOn(fsp, 'readFile').mockImplementation(((target: any, options?: any) => {
      if (String(target) === wrapperStatPath) {
        const error = new Error('permission denied') as NodeJS.ErrnoException
        error.code = 'EACCES'
        return Promise.reject(error) as any
      }
      return originalReadFile(target, options as any) as any
    }) as typeof fsp.readFile)

    try {
      await expect(runtime.shutdown()).rejects.toThrow(/could not be verified|failed|ownership/i)
      await expect(fsp.stat(metadataPath)).resolves.toBeDefined()
      expect(await isProcessGroupAlive(ready.processGroupId)).toBe(true)
    } finally {
      readFileSpy.mockRestore()
      runtimes.delete(runtime)
      await killProcessGroupForTest(ready.processGroupId)
    }
  }, 20_000)

  it('refuses to disown and keeps the record when the wrapper stat is present but unparseable', async () => {
    const metadataDir = await makeTempDir()
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
    })
    const ready = await runtime.ensureReady()
    const ownership = (runtime as any).ownership
    const metadataPath = ownership.metadataPath as string
    // No member can positively match (bogus id), and the wrapper's /proc/<pid>/stat is present but
    // unparseable. That must classify `unreadable` (NOT `gone`) so the group stays `indeterminate`
    // and is never disowned — guarding the present-but-unparseable branch distinct from EACCES.
    ownership.metadata.ownershipId = 'no-such-ownership-id'
    const wrapperStatPath = `/proc/${ready.processPid}/stat`
    const originalReadFile = fsp.readFile.bind(fsp)
    const readFileSpy = vi.spyOn(fsp, 'readFile').mockImplementation(((target: any, options?: any) => {
      if (String(target) === wrapperStatPath) {
        // Non-empty but missing the ')' delimiter parseProcStat requires -> parse returns null.
        return Promise.resolve('garbage proc stat without a close paren') as any
      }
      return originalReadFile(target, options as any) as any
    }) as typeof fsp.readFile)

    try {
      await expect(runtime.shutdown()).rejects.toThrow(/could not be verified|failed|ownership/i)
      await expect(fsp.stat(metadataPath)).resolves.toBeDefined()
      expect(await isProcessGroupAlive(ready.processGroupId)).toBe(true)
    } finally {
      readFileSpy.mockRestore()
      runtimes.delete(runtime)
      await killProcessGroupForTest(ready.processGroupId)
    }
  }, 20_000)

  it('cleans up and never signals when the process group is already gone', async () => {
    const metadataDir = await makeTempDir()
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-runtime-test',
    })
    const ready = await runtime.ensureReady()
    const metadataPath = (runtime as any).ownership.metadataPath as string

    const originalKill = process.kill.bind(process)
    const signalsToGroup: Array<NodeJS.Signals | number> = []
    // Install the spy BEFORE the group dies so it observes *any* teardown — the runtime's child-exit
    // handler may run teardown before shutdown() is even called. Liveness probes (signal 0) are
    // ignored; the setup kill below uses originalKill so it is not counted as a teardown signal.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -ready.processGroupId && signal !== 0) signalsToGroup.push(signal as any)
      return originalKill(pid as any, signal as any)
    }) as typeof process.kill)

    try {
      // The sidecar exits independently of teardown: its process group is genuinely gone.
      originalKill(-ready.processGroupId, 'SIGKILL')
      await waitForProcessExit(ready.processGroupId).catch(() => undefined)

      await runtime.shutdown()
      await expect(fsp.stat(metadataPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(signalsToGroup).toEqual([])
    } finally {
      killSpy.mockRestore()
      runtimes.delete(runtime)
    }
  }, 20_000)

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
    })).toThrow(/startup reaper blocked startup.*failed to reap 2 ownership record.*ownership-alpha.*ownership-beta/i)
  })

  it('allows startup when ownership records still belong to live sidecar owners', () => {
    expect(() => assertCodexStartupReaperSucceeded({
      reapedOwnershipIds: [],
      ignoredLegacyRecords: [],
      skippedActiveOwnershipIds: ['active-owner'],
      failedOwnershipIds: [],
    })).not.toThrow()
  })

  it('reports failed reaps without treating live active owners as fatal', () => {
    let thrown: Error | undefined

    try {
      assertCodexStartupReaperSucceeded({
        reapedOwnershipIds: [],
        ignoredLegacyRecords: [],
        skippedActiveOwnershipIds: ['active-owner'],
        failedOwnershipIds: ['failed-owner'],
      })
    } catch (error) {
      thrown = error as Error
    }

    expect(thrown).toBeDefined()
    expect(thrown?.message).toContain('failed to reap 1 ownership record(s): failed-owner')
    expect(thrown?.message).not.toContain('active-owner')
  })

  it('reports a skipped new-schema ownership record when the owner pid is live', async () => {
    const metadataDir = await makeTempDir()
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-previous',
    })
    const ready = await runtime.ensureReady()
    await markOwnershipRecordStale(ready.metadataPath, {
      ownerServerPid: process.pid,
      ownerServerIdentity: await readWrapperIdentityForTest(process.pid),
    })

    const result = await reapOrphanedCodexAppServerSidecars({
      metadataDir,
      serverInstanceId: 'srv-current',
      terminateGraceMs: 1,
    })

    expect(result.skippedActiveOwnershipIds).toContain(ready.ownershipId)
    expect(() => assertCodexStartupReaperSucceeded(result)).not.toThrow()
    await expect(fsp.stat(ready.metadataPath)).resolves.toBeDefined()
    expect(await isProcessGroupAlive(ready.processGroupId)).toBe(true)
  })

  it('does not treat a live reused owner pid as active without matching owner identity', async () => {
    const metadataDir = await makeTempDir()
    const runtime = createRuntime({
      metadataDir,
      serverInstanceId: 'srv-previous',
    })
    const ready = await runtime.ensureReady()
    await markOwnershipRecordStale(ready.metadataPath, {
      ownerServerPid: process.pid,
      ownerServerIdentity: {
        commandLine: ['different-process'],
        cwd: '/tmp/different-process',
        startTimeTicks: 1,
      },
    })

    const result = await reapOrphanedCodexAppServerSidecars({
      metadataDir,
      serverInstanceId: 'srv-current',
      terminateGraceMs: 1,
    })

    expect(result.skippedActiveOwnershipIds).not.toContain(ready.ownershipId)
    expect(result.failedOwnershipIds).toContain(ready.ownershipId)
    expect(() => assertCodexStartupReaperSucceeded(result)).toThrow(new RegExp(ready.ownershipId))
    await expect(fsp.stat(ready.metadataPath)).resolves.toBeDefined()
    expect(await isProcessGroupAlive(ready.processGroupId)).toBe(true)
  })

  it('reaps a stale ownership record whose process group was reused by a foreign process', async () => {
    const metadataDir = await makeTempDir()
    const ownerRuntime = createRuntime({ metadataDir, serverInstanceId: 'srv-previous' })
    const foreignRuntime = createRuntime({
      metadataDir: await makeTempDir(),
      serverInstanceId: 'srv-foreign',
    })
    let ownerReady: Awaited<ReturnType<CodexAppServerRuntime['ensureReady']>> | undefined
    let foreignReady: Awaited<ReturnType<CodexAppServerRuntime['ensureReady']>> | undefined

    try {
      ownerReady = await ownerRuntime.ensureReady()
      foreignReady = await foreignRuntime.ensureReady()
      // Dead owner server + the recorded PGID now belongs to a live, unrelated (foreign) group.
      await markOwnershipRecordStale(ownerReady.metadataPath, {
        processGroupId: foreignReady.processGroupId,
      })

      const result = await reapOrphanedCodexAppServerSidecars({
        metadataDir,
        serverInstanceId: 'srv-current',
        terminateGraceMs: 1,
      })

      expect(result.reapedOwnershipIds).toContain(ownerReady.ownershipId)
      expect(result.failedOwnershipIds).not.toContain(ownerReady.ownershipId)
      await expect(fsp.stat(ownerReady.metadataPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await isProcessGroupAlive(foreignReady.processGroupId)).toBe(true)
    } finally {
      runtimes.delete(ownerRuntime)
      runtimes.delete(foreignRuntime)
      if (ownerReady) await killProcessGroupForTest(ownerReady.processGroupId)
      if (foreignReady) await killProcessGroupForTest(foreignReady.processGroupId)
    }
  }, 20_000)

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
    const launchCwd = await makeTempDir()

    await expect(runtime.startThread({ cwd: launchCwd })).resolves.toEqual({
      threadId: 'thread-new-1',
      wsUrl: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/),
    })
  })

  it('starts the app-server wrapper in the requested thread cwd', async () => {
    const metadataDir = await makeTempDir()
    const launchCwd = await makeTempDir()
    const runtime = createRuntime({ metadataDir })

    await runtime.startThread({ cwd: launchCwd })

    const record = await waitForMetadataRecord(metadataDir)
    expect(record.wrapperIdentity.cwd).toBe(launchCwd)
  })

  it('proxies thread/resume through the sidecar client after boot', async () => {
    const runtime = createRuntime()
    const launchCwd = await makeTempDir()

    await expect(runtime.resumeThread({
      threadId: '019d9859-5670-72b1-851f-794ad7fef112',
      cwd: launchCwd,
    })).resolves.toEqual({
      threadId: '019d9859-5670-72b1-851f-794ad7fef112',
      wsUrl: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/),
    })
  })

  it('starts the app-server wrapper in the requested resume cwd', async () => {
    const metadataDir = await makeTempDir()
    const launchCwd = await makeTempDir()
    const runtime = createRuntime({ metadataDir })

    await runtime.resumeThread({
      threadId: '019d9859-5670-72b1-851f-794ad7fef112',
      cwd: launchCwd,
    })

    const record = await waitForMetadataRecord(metadataDir)
    expect(record.wrapperIdentity.cwd).toBe(launchCwd)
  })

  it('re-emits turn notifications from the sidecar client', async () => {
    const runtime = createRuntime({
      env: {
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
          notificationsAfterMethods: {
            'thread/loaded/list': [
              {
                method: 'turn/started',
                params: { threadId: 'thread-1', turnId: 'turn-1' },
              },
              {
                method: 'turn/completed',
                params: { threadId: 'thread-1', turnId: 'turn-1', status: 'completed' },
              },
            ],
          },
        }),
      },
    })
    const started: unknown[] = []
    const completed: unknown[] = []
    const unsubscribeStarted = runtime.onTurnStarted((event) => started.push(event))
    const unsubscribeCompleted = runtime.onTurnCompleted((event) => completed.push(event))

    await runtime.listLoadedThreads()
    await new Promise((resolve) => setTimeout(resolve, 25))
    unsubscribeStarted()
    unsubscribeCompleted()

    expect(started).toEqual([
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
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
      startupAttemptTimeoutMs: REAL_STARTUP_ATTEMPT_TIMEOUT_MS,
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

  it('keeps child stdio drained so large app-server logs do not stall thread/start replies', async () => {
    const launchCwd = await makeTempDir()
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

    await expect(runtime.startThread({ cwd: launchCwd })).resolves.toEqual({
      threadId: 'thread-new-1',
      wsUrl: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/),
    })
  })

  it('keeps child stderr drained so large app-server error logs do not stall thread/resume replies', async () => {
    const launchCwd = await makeTempDir()
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
      cwd: launchCwd,
    })).resolves.toEqual({
      threadId: '019d9859-5670-72b1-851f-794ad7fef112',
      wsUrl: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/),
    })
  })
})
