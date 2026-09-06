import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CODEX_REATTACH_PROBE_BUDGET_MS,
  CodexAppServerRuntime,
  getCodexSurvivorAttachErrorCode,
  runCodexStartupReaper,
  type CodexSidecarOwnershipMetadata,
  type HeldCodexSidecarOwnership,
  type ReadyState,
} from '../../../../../server/coding-cli/codex-app-server/runtime.js'
import { CodexAppServerClient } from '../../../../../server/coding-cli/codex-app-server/client.js'
import { CodexLaunchPlanner } from '../../../../../server/coding-cli/codex-app-server/launch-planner.js'
import { CodexRemoteProxy } from '../../../../../server/coding-cli/codex-app-server/remote-proxy.js'
import {
  CODEX_SIDECAR_REAP_GRACE_DEFAULT_MS,
  CodexSidecarReconciler,
  resolveCodexSidecarReapGraceMs,
} from '../../../../../server/coding-cli/codex-app-server/sidecar-reattach.js'
import type { LoopbackServerEndpoint } from '../../../../../server/local-port.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FAKE_SERVER_PATH = path.resolve(__dirname, '../../../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs')

// Same load posture as runtime.test.ts: these tests spawn REAL fixture sidecars that must reach
// `initialize` under fileParallelism CPU starvation, so the per-attempt budget stays generous.
const REAL_STARTUP_ATTEMPT_TIMEOUT_MS = 5_000

// Polling deadline for helpers that wait on real OS side effects (process exit).
const WAIT_HELPER_TIMEOUT_MS = 15_000

const runtimes = new Set<CodexAppServerRuntime>()
const blockers = new Set<http.Server>()
const tempDirs = new Set<string>()
// TUI-role clients and remote proxies still tracked by the scenario tests. Both are idempotent
// to close and safe to re-close after a mid-test failure, so they live in their own registries.
const tuiClients = new Set<CodexAppServerClient>()
const launchProxies = new Set<CodexRemoteProxy>()
let fixtureCodexHome: string

beforeEach(async () => {
  fixtureCodexHome = path.join(await makeTempDir(), 'codex-home')
})

async function closeBlocker(server: http.Server): Promise<void> {
  blockers.delete(server)
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

afterEach(async () => {
  await Promise.all([...tuiClients].map(async (client) => {
    tuiClients.delete(client)
    await client.close().catch(() => undefined)
  }))
  await Promise.all([...launchProxies].map(async (proxy) => {
    launchProxies.delete(proxy)
    await proxy.close().catch(() => undefined)
  }))
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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-sidecar-reattach-'))
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

async function getOwnProcessGroupId(): Promise<number> {
  const stat = await fsp.readFile('/proc/self/stat', 'utf8')
  const closeParen = stat.lastIndexOf(')')
  const fields = stat.slice(closeParen + 2).trim().split(/\s+/)
  return Number(fields[2])
}

function createRuntime(options: ConstructorParameters<typeof CodexAppServerRuntime>[0] = {}): CodexAppServerRuntime {
  const runtime = new CodexAppServerRuntime({
    command: process.execPath,
    commandArgs: [FAKE_SERVER_PATH],
    startupAttemptTimeoutMs: REAL_STARTUP_ATTEMPT_TIMEOUT_MS,
    ...options,
    env: {
      CODEX_HOME: fixtureCodexHome,
      FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES: '1',
      ...options.env,
    },
  })
  runtimes.add(runtime)
  return runtime
}

// Simulation of an unclean previous-server death that leaves a SURVIVOR sidecar: a real fixture
// process group is spawned and its authentic ownership record (real wrapper identity plus the
// Task-1 `sessionId` claim key) is rewritten so its owner fields name a dead pid from a previous
// server generation whose last write was an hour ago. The spawning runtime is deliberately NEVER
// shut down by the rig — afterEach teardown stands in for the dead server's missing cleanup.
async function spawnSurvivingFixture(input: {
  metadataDir: string
  loadedThreadIds: string[]
  claimKey: string
  delayMethodsMs?: Record<string, number>
  appendThreadOperationLogPath?: string
}): Promise<{ ready: ReadyState; held: HeldCodexSidecarOwnership }> {
  const owner = createRuntime({
    metadataDir: input.metadataDir,
    serverInstanceId: 'srv-previous',
    env: {
      FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
        loadedThreadIds: input.loadedThreadIds,
        ...(input.delayMethodsMs ? { delayMethodsMs: input.delayMethodsMs } : {}),
        ...(input.appendThreadOperationLogPath
          ? { appendThreadOperationLogPath: input.appendThreadOperationLogPath }
          : {}),
      }),
    },
  })
  const ready = await owner.ensureReady()
  await owner.updateOwnershipMetadata({ sessionId: input.claimKey })

  const staleUpdatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const raw = await fsp.readFile(ready.metadataPath, 'utf8')
  const stale = {
    ...(JSON.parse(raw) as CodexSidecarOwnershipMetadata),
    ownerServerPid: 999_999_999,
    serverInstanceId: 'srv-previous',
    updatedAt: staleUpdatedAt,
  }
  await fsp.writeFile(ready.metadataPath, `${JSON.stringify(stale, null, 2)}\n`, { mode: 0o600 })

  // Held ownership as a boot reconciler would construct it: from the record read back off disk.
  const metadata = JSON.parse(await fsp.readFile(ready.metadataPath, 'utf8')) as CodexSidecarOwnershipMetadata
  return {
    ready,
    held: {
      metadataDir: input.metadataDir,
      metadataPath: ready.metadataPath,
      metadata,
    },
  }
}

const describeWithLinuxProc = process.platform === 'linux' ? describe : describe.skip

describeWithLinuxProc('CodexAppServerRuntime.attachToSurvivingSidecar', () => {
  it('attaches a fresh runtime to a surviving sidecar, retitling its ownership record', async () => {
    const metadataDir = await makeTempDir()
    const { ready: survivorReady, held } = await spawnSurvivingFixture({
      metadataDir,
      loadedThreadIds: ['thr-1'],
      claimKey: 'thr-1',
    })
    const attachRuntime = createRuntime({ metadataDir, serverInstanceId: 'srv-current' })

    const ready = await attachRuntime.attachToSurvivingSidecar(held, { sessionId: 'thr-1' })

    // The ReadyState names the SURVIVOR's still-running incarnation — no fresh spawn occurred.
    expect(ready.wsUrl).toBe(survivorReady.wsUrl)
    expect(ready.processPid).toBe(survivorReady.processPid)
    expect(ready.processGroupId).toBe(survivorReady.processGroupId)
    expect(ready.ownershipId).toBe(survivorReady.ownershipId)
    expect(ready.metadataPath).toBe(survivorReady.metadataPath)
    expect(ready.codexHome).toBe(survivorReady.codexHome)
    expect(attachRuntime.status()).toBe('running')

    // A later ensureReady returns the attached state instead of spawning a new sidecar.
    const again = await attachRuntime.ensureReady()
    expect(again.processPid).toBe(survivorReady.processPid)
    expect(again.wsUrl).toBe(survivorReady.wsUrl)

    // The record on disk was retitled to THIS server process with a fresh complete owner
    // identity; the claim key and the survivor's own identity fields are preserved.
    const retitled = JSON.parse(await fsp.readFile(survivorReady.metadataPath, 'utf8'))
    expect(retitled.ownerServerPid).toBe(process.pid)
    expect(retitled.ownerServerIdentity).toEqual(await readWrapperIdentityForTest(process.pid))
    expect(Date.parse(retitled.updatedAt)).toBeGreaterThan(Date.parse(held.metadata.updatedAt))
    expect(retitled.sessionId).toBe('thr-1')
    expect(retitled.wrapperPid).toBe(survivorReady.processPid)
    expect(retitled.processGroupId).toBe(survivorReady.processGroupId)
    expect(retitled.wsUrl).toBe(survivorReady.wsUrl)
    expect(retitled.ownershipId).toBe(survivorReady.ownershipId)

    // The attaching runtime owns the survivor now: shutdown tears the group down (the
    // conservative ownership-verified path) and unlinks the record.
    await attachRuntime.shutdown()
    await waitForProcessExit(survivorReady.processPid)
    expect(await isProcessGroupAlive(survivorReady.processGroupId)).toBe(false)
    await expect(fsp.stat(survivorReady.metadataPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses attach when the survivor group is gone, without signaling an unrelated live group', async () => {
    const metadataDir = await makeTempDir()

    // A short-lived REAL fixture child: capture its authentic wrapper identity, then let it exit
    // so the record's process group classifies as `gone`.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 50)'], {
      detached: true,
      stdio: 'ignore',
    })
    const deadPid = child.pid
    if (!deadPid) throw new Error('fixture child did not expose a pid')
    const deadWrapperIdentity = await readWrapperIdentityForTest(deadPid)
    await new Promise<void>((resolve, reject) => {
      child.once('exit', () => resolve())
      child.once('error', reject)
    })
    await waitForProcessExit(deadPid)

    const now = new Date().toISOString()
    const metadataPath = path.join(metadataDir, 'gone-sidecar.json')
    const metadata: CodexSidecarOwnershipMetadata = {
      schemaVersion: 1,
      ownershipId: 'gone-sidecar',
      serverInstanceId: 'srv-previous',
      ownerServerPid: 999_999_999,
      terminalId: null,
      generation: null,
      wsUrl: 'ws://127.0.0.1:1',
      wrapperPid: deadPid,
      processGroupId: deadPid,
      wrapperIdentity: deadWrapperIdentity,
      createdAt: now,
      updatedAt: now,
      sessionId: 'thr-gone',
    }
    await fsp.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 })

    // Safety control: a still-live fixture sidecar that shares nothing with the dead record.
    const control = createRuntime({ metadataDir, serverInstanceId: 'srv-control' })
    const controlReady = await control.ensureReady()

    const attachRuntime = createRuntime({ metadataDir, serverInstanceId: 'srv-current' })
    const error = await attachRuntime.attachToSurvivingSidecar(
      { metadataDir, metadataPath, metadata },
      { sessionId: 'thr-gone' },
    ).catch((caught: unknown) => caught)

    expect(getCodexSurvivorAttachErrorCode(error)).toBe('codex_survivor_identity')
    // Disposal belongs to the reconciler's settler, not the runtime: the record stays on disk.
    await expect(fsp.stat(metadataPath)).resolves.toBeDefined()
    // Nothing was signaled: the unrelated live group is untouched.
    expect(await isProcessGroupAlive(controlReady.processGroupId)).toBe(true)
    expect(attachRuntime.status()).toBe('stopped')
  })

  it('fails unreachable when the recorded listener does not answer the probe, inside the shared deadline', async () => {
    const metadataDir = await makeTempDir()
    const { ready: survivorReady, held } = await spawnSurvivingFixture({
      metadataDir,
      loadedThreadIds: ['thr-1'],
      claimKey: 'thr-1',
    })
    // TCP accepts but the codex protocol never answers: the probe cannot succeed.
    const { endpoint } = await occupyLoopbackPort()
    const rerouted: HeldCodexSidecarOwnership = {
      ...held,
      metadata: { ...held.metadata, wsUrl: `ws://${endpoint.hostname}:${endpoint.port}` },
    }
    const attachRuntime = createRuntime({ metadataDir, serverInstanceId: 'srv-current' })

    const startedAt = Date.now()
    const error = await attachRuntime.attachToSurvivingSidecar(rerouted, { sessionId: 'thr-1' })
      .catch((caught: unknown) => caught)
    const elapsedMs = Date.now() - startedAt

    expect(getCodexSurvivorAttachErrorCode(error)).toBe('codex_survivor_unreachable')
    // The whole attach stays inside the single shared probe deadline (never two stacked budgets).
    expect(elapsedMs).toBeLessThan(CODEX_REATTACH_PROBE_BUDGET_MS * 1.5)
    // The survivor is never signaled and its record is NOT retitled.
    expect(await isProcessGroupAlive(survivorReady.processGroupId)).toBe(true)
    const record = JSON.parse(await fsp.readFile(survivorReady.metadataPath, 'utf8'))
    expect(record.ownerServerPid).toBe(999_999_999)
    expect(record.updatedAt).toBe(held.metadata.updatedAt)
    expect(attachRuntime.status()).toBe('stopped')
  })

  it('fails at ~the SINGLE shared deadline when both probes answer slowly, never ~two stacked budgets', async () => {
    // M1 pin (runtime.ts withProbeBudget + `probeDeadlineMs - Date.now()` handoff): each probe
    // races only the REMAINING slice of one shared deadline. With per-probe stacked budgets the
    // attaches below would either take ~2x the budget or SUCCEED — both fail these assertions.
    const delayCases: Array<Record<string, number>> = [
      // initialize consumes ~2.5s of the 3s deadline; the list probe's ~0.5s remainder expires
      // against a 2.5s fixture delay.
      { initialize: 2_500, 'thread/loaded/list': 2_500 },
      // Symmetric: the list WOULD answer (~3.5s) inside a fresh stacked second budget; the shared
      // deadline must cut it off at ~3s because initialize alone ate nearly the whole budget.
      { initialize: 2_500, 'thread/loaded/list': 1_000 },
    ]

    for (const delayMethodsMs of delayCases) {
      const metadataDir = await makeTempDir()
      const { ready: survivorReady, held } = await spawnSurvivingFixture({
        metadataDir,
        loadedThreadIds: ['thr-slow'],
        claimKey: 'thr-slow',
        delayMethodsMs,
      })
      const attachRuntime = createRuntime({ metadataDir, serverInstanceId: 'srv-current' })

      const startedAt = Date.now()
      const error = await attachRuntime.attachToSurvivingSidecar(held, { sessionId: 'thr-slow' })
        .catch((caught: unknown) => caught)
      const elapsedMs = Date.now() - startedAt

      expect(getCodexSurvivorAttachErrorCode(error)).toBe('codex_survivor_unreachable')
      // The deadline governed: the attach ran to ≈ CODEX_REATTACH_PROBE_BUDGET_MS total …
      expect(elapsedMs).toBeGreaterThanOrEqual(CODEX_REATTACH_PROBE_BUDGET_MS * 0.9)
      // … and did NOT take two stacked budgets (~6s) — same 1.5x real-clock tolerance as test 3.
      expect(elapsedMs).toBeLessThan(CODEX_REATTACH_PROBE_BUDGET_MS * 1.5)
      // N1: the timeout message names both the expired remaining slice and the CONFIGURED total.
      expect((error as Error).message).toContain(`of the ${CODEX_REATTACH_PROBE_BUDGET_MS}ms reattach probe budget`)
      // The survivor is never signaled even when its probes time out.
      expect(await isProcessGroupAlive(survivorReady.processGroupId)).toBe(true)
      expect(attachRuntime.status()).toBe('stopped')
    }
  })

  it('keeps a reachable survivor that is not the thread writer, without retitling its record', async () => {
    const metadataDir = await makeTempDir()
    const { ready: survivorReady, held } = await spawnSurvivingFixture({
      metadataDir,
      loadedThreadIds: ['thr-other'],
      claimKey: 'thr-other',
    })
    const attachRuntime = createRuntime({ metadataDir, serverInstanceId: 'srv-current' })

    const error = await attachRuntime.attachToSurvivingSidecar(held, { sessionId: 'thr-live' })
      .catch((caught: unknown) => caught)

    expect(getCodexSurvivorAttachErrorCode(error)).toBe('codex_survivor_not_writer')
    // The survivor is kept alive — it may be the writer of another key's thread.
    expect(await isProcessGroupAlive(survivorReady.processGroupId)).toBe(true)
    // Its record was NOT retitled: the stale dead-owner fields are unchanged on disk.
    const record = JSON.parse(await fsp.readFile(survivorReady.metadataPath, 'utf8'))
    expect(record.ownerServerPid).toBe(999_999_999)
    expect(record.ownerServerIdentity).toEqual(held.metadata.ownerServerIdentity)
    expect(record.updatedAt).toBe(held.metadata.updatedAt)
    expect(attachRuntime.status()).toBe('stopped')
  })
})

// --- Task 3: CodexSidecarReconciler (boot hold + grace-gated sweep) ---

// Raw detached fixture children used as lightweight survivor process groups for the reconciler
// unit tests. afterEach kills only what these tests spawned (pgid-targeted).
const rawChildren = new Set<number>()

async function spawnRawSurvivingChild(): Promise<{ pid: number; identity: CodexSidecarOwnershipMetadata['wrapperIdentity'] }> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  const pid = child.pid
  if (!pid) throw new Error('raw fixture child did not expose a pid')
  rawChildren.add(pid)
  const identity = await readWrapperIdentityForTest(pid)
  return { pid, identity: identity as CodexSidecarOwnershipMetadata['wrapperIdentity'] }
}

async function spawnShortLivedChild(): Promise<{ pid: number; identity: CodexSidecarOwnershipMetadata['wrapperIdentity'] }> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 50)'], {
    detached: true,
    stdio: 'ignore',
  })
  const pid = child.pid
  if (!pid) throw new Error('short-lived fixture child did not expose a pid')
  const identity = await readWrapperIdentityForTest(pid)
  await new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve())
    child.once('error', reject)
  })
  await waitForProcessExit(pid)
  return { pid, identity: identity as CodexSidecarOwnershipMetadata['wrapperIdentity'] }
}

afterEach(async () => {
  await Promise.all([...rawChildren].map(async (pid) => {
    rawChildren.delete(pid)
    try {
      process.kill(-pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    await waitForProcessExit(pid).catch(() => undefined)
  }))
})

function buildHeldRecord(overrides: Record<string, unknown> = {}): CodexSidecarOwnershipMetadata {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    ownershipId: `held-${Math.random().toString(36).slice(2)}`,
    serverInstanceId: 'srv-previous',
    ownerServerPid: 999_999_999,
    terminalId: null,
    generation: null,
    wsUrl: 'ws://127.0.0.1:1',
    wrapperPid: 999_999_998,
    processGroupId: 999_999_997,
    wrapperIdentity: { commandLine: ['codex'], cwd: '/tmp', startTimeTicks: 1 },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as CodexSidecarOwnershipMetadata
}

async function writeHeldRecord(
  metadataDir: string,
  metadata: CodexSidecarOwnershipMetadata,
): Promise<HeldCodexSidecarOwnership> {
  const metadataPath = path.join(metadataDir, `${metadata.ownershipId}.json`)
  await fsp.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 })
  return { metadataDir, metadataPath, metadata }
}

function createReconcilerLog() {
  return { info: vi.fn(), warn: vi.fn() }
}

describeWithLinuxProc('CodexSidecarReconciler hold verdicts', () => {
  it('holds a verified-owned survivor claimable by its session id, leaving the group and record in place', async () => {
    const metadataDir = await makeTempDir()
    const { pid, identity } = await spawnRawSurvivingChild()
    const metadata = buildHeldRecord({
      ownershipId: 'hold-owned',
      wrapperPid: pid,
      processGroupId: pid,
      wrapperIdentity: identity,
      sessionId: 'thr-owned',
    })
    const ownership = await writeHeldRecord(metadataDir, metadata)
    const log = createReconcilerLog()
    const reconciler = new CodexSidecarReconciler({ log })

    const verdict = await reconciler.hold(ownership)

    expect(verdict).toBe('held')
    // The survivor is never signaled by the hold: the group stays alive and its record stays.
    expect(await isProcessGroupAlive(pid)).toBe(true)
    await expect(fsp.stat(ownership.metadataPath)).resolves.toBeDefined()
    expect(reconciler.snapshot()).toMatchObject({ held: 1, claimableSessions: 1, inFlightClaims: 0 })
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ ownershipId: 'hold-owned', sessionId: 'thr-owned', wsUrl: metadata.wsUrl }),
      expect.any(String),
    )
    const claimed = reconciler.claimForSession('thr-owned')
    expect(claimed?.metadata.ownershipId).toBe('hold-owned')
  })

  it('removes a record whose process group is gone without signaling, returning removed-unowned', async () => {
    const metadataDir = await makeTempDir()
    const { pid, identity } = await spawnShortLivedChild()
    const metadata = buildHeldRecord({
      ownershipId: 'hold-gone',
      wrapperPid: pid,
      processGroupId: pid,
      wrapperIdentity: identity,
      sessionId: 'thr-gone',
    })
    const ownership = await writeHeldRecord(metadataDir, metadata)
    const reconciler = new CodexSidecarReconciler({ log: createReconcilerLog() })

    const verdict = await reconciler.hold(ownership)

    expect(verdict).toBe('removed-unowned')
    await expect(fsp.stat(ownership.metadataPath)).rejects.toMatchObject({ code: 'ENOENT' })
    // Nothing was indexed: the record is gone from disk and from the reconciler's maps.
    expect(reconciler.snapshot()).toMatchObject({ held: 0, claimableSessions: 0, inFlightClaims: 0 })
    expect(reconciler.claimForSession('thr-gone')).toBeNull()
  })

  it('refuses a record pointing at the test process own group, keeping the file (kept-unproven)', async () => {
    const metadataDir = await makeTempDir()
    const selfGroupId = await getOwnProcessGroupId()
    const metadata = buildHeldRecord({
      ownershipId: 'hold-self',
      wrapperPid: process.pid,
      processGroupId: selfGroupId,
      wrapperIdentity: await readWrapperIdentityForTest(process.pid),
      sessionId: 'thr-self',
    })
    const ownership = await writeHeldRecord(metadataDir, metadata)
    const reconciler = new CodexSidecarReconciler({ log: createReconcilerLog() })

    const verdict = await reconciler.hold(ownership)

    expect(verdict).toBe('kept-unproven')
    // Refusal keeps the record on disk and indexes nothing.
    await expect(fsp.stat(ownership.metadataPath)).resolves.toBeDefined()
    expect(reconciler.snapshot()).toMatchObject({ held: 0, claimableSessions: 0, inFlightClaims: 0 })
    expect(reconciler.claimForSession('thr-self')).toBeNull()
  })

  it('holds a record without a session id as held but not claimable', async () => {
    const metadataDir = await makeTempDir()
    const { pid, identity } = await spawnRawSurvivingChild()
    const metadata = buildHeldRecord({
      ownershipId: 'hold-no-session',
      wrapperPid: pid,
      processGroupId: pid,
      wrapperIdentity: identity,
    })
    const ownership = await writeHeldRecord(metadataDir, metadata)
    const reconciler = new CodexSidecarReconciler({ log: createReconcilerLog() })

    const verdict = await reconciler.hold(ownership)

    expect(verdict).toBe('held')
    expect(reconciler.snapshot()).toMatchObject({ held: 1, claimableSessions: 0, inFlightClaims: 0 })
    expect(reconciler.claimForSession('thr-anything')).toBeNull()
  })

  it('re-holding the same ownershipId keeps its session index single (review Nit 3)', async () => {
    const metadataDir = await makeTempDir()
    const { pid, identity } = await spawnRawSurvivingChild()
    const ownership = await writeHeldRecord(metadataDir, buildHeldRecord({
      ownershipId: 'hold-twice',
      wrapperPid: pid,
      processGroupId: pid,
      wrapperIdentity: identity,
      sessionId: 'thr-twice',
    }))
    const reconciler = new CodexSidecarReconciler({ log: createReconcilerLog() })
    expect(await reconciler.hold(ownership)).toBe('held')
    // The boot reaper offers each record exactly once, but a re-hold must never double-index.
    expect(await reconciler.hold(ownership)).toBe('held')
    expect(reconciler.snapshot()).toMatchObject({ held: 1, claimableSessions: 1, inFlightClaims: 0 })

    // One claim consumes the single index entry; a duplicated entry would be claimed (and
    // counted in-flight) a second time here.
    expect(reconciler.claimForSession('thr-twice')?.metadata.ownershipId).toBe('hold-twice')
    expect(reconciler.claimForSession('thr-twice')).toBeNull()
    expect(reconciler.snapshot()).toMatchObject({ held: 1, claimableSessions: 0, inFlightClaims: 1 })
  })
})

describeWithLinuxProc('CodexSidecarReconciler claims', () => {
  it('claims a held survivor exactly once per session id, newest-updatedAt first', async () => {
    const metadataDir = await makeTempDir()
    const older = await spawnRawSurvivingChild()
    const newer = await spawnRawSurvivingChild()
    const olderOwnership = await writeHeldRecord(metadataDir, buildHeldRecord({
      ownershipId: 'claim-older',
      wrapperPid: older.pid,
      processGroupId: older.pid,
      wrapperIdentity: older.identity,
      sessionId: 'thr-shared',
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    }))
    const newerOwnership = await writeHeldRecord(metadataDir, buildHeldRecord({
      ownershipId: 'claim-newer',
      wrapperPid: newer.pid,
      processGroupId: newer.pid,
      wrapperIdentity: newer.identity,
      sessionId: 'thr-shared',
    }))
    const reconciler = new CodexSidecarReconciler({ log: createReconcilerLog() })
    expect(await reconciler.hold(olderOwnership)).toBe('held')
    expect(await reconciler.hold(newerOwnership)).toBe('held')

    const first = reconciler.claimForSession('thr-shared')
    expect(first?.metadata.ownershipId).toBe('claim-newer')
    expect(reconciler.snapshot()).toMatchObject({ held: 2, claimableSessions: 1, inFlightClaims: 1 })
    const second = reconciler.claimForSession('thr-shared')
    expect(second?.metadata.ownershipId).toBe('claim-older')
    // Both claims are consumed and in flight: the session key has no claimable candidate left.
    expect(reconciler.claimForSession('thr-shared')).toBeNull()
    expect(reconciler.snapshot()).toMatchObject({ held: 2, claimableSessions: 0, inFlightClaims: 2 })
  })
})

describeWithLinuxProc('CodexSidecarReconciler settleFailedClaim', () => {
  it('settles a codex_survivor_unreachable failure by reaping the verified group and unlinked record', async () => {
    const metadataDir = await makeTempDir()
    const { pid, identity } = await spawnRawSurvivingChild()
    const metadata = buildHeldRecord({
      ownershipId: 'settle-unreachable',
      wrapperPid: pid,
      processGroupId: pid,
      wrapperIdentity: identity,
      sessionId: 'thr-unreachable',
    })
    const ownership = await writeHeldRecord(metadataDir, metadata)
    const reconciler = new CodexSidecarReconciler({ log: createReconcilerLog() })
    expect(await reconciler.hold(ownership)).toBe('held')
    const claimed = reconciler.claimForSession('thr-unreachable')
    expect(claimed).not.toBeNull()

    await reconciler.settleFailedClaim(claimed!, 'codex_survivor_unreachable')

    // The verified-but-unusable survivor is conservatively reaped and unlinked (da92 parity).
    expect(await isProcessGroupAlive(pid)).toBe(false)
    await expect(fsp.stat(ownership.metadataPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(reconciler.snapshot()).toMatchObject({ held: 0, claimableSessions: 0, inFlightClaims: 0 })
  })

  it('settles a codex_survivor_identity failure on a dead survivor by unlinking its record WITHOUT signaling', async () => {
    const metadataDir = await makeTempDir()
    const { pid, identity } = await spawnRawSurvivingChild()
    const metadata = buildHeldRecord({
      ownershipId: 'settle-identity-gone',
      wrapperPid: pid,
      processGroupId: pid,
      wrapperIdentity: identity,
      sessionId: 'thr-identity',
    })
    const ownership = await writeHeldRecord(metadataDir, metadata)
    const log = createReconcilerLog()
    const reconciler = new CodexSidecarReconciler({ log })
    expect(await reconciler.hold(ownership)).toBe('held')
    const claimed = reconciler.claimForSession('thr-identity')
    expect(claimed).not.toBeNull()
    // Pre-settle state: held + in-flight, file on disk — so the drain below is non-vacuous.
    expect(reconciler.snapshot()).toMatchObject({ held: 1, claimableSessions: 0, inFlightClaims: 1 })
    await expect(fsp.stat(ownership.metadataPath)).resolves.toBeDefined()

    // The survivor dies between claim and settle. At settle time the record's process
    // classification is NOT 'owned' (the group resolves 'gone') — the same record shape the
    // runtime codes codex_survivor_identity on and pointedly leaves on disk (see "refuses attach
    // when the survivor group is gone" above; disposal is the settler's job).
    process.kill(-pid, 'SIGKILL')
    await waitForProcessExit(pid)
    rawChildren.delete(pid) // already dead and reaped; afterEach must never signal a reused pgid
    expect(await isProcessGroupAlive(pid)).toBe(false)

    // The conservative verdict pins NO signal delivery: a 'gone' group is unlinked without being
    // signaled. Spy installed AFTER the rig's own SIGKILL so only the settle itself is observed.
    const originalKill = process.kill
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((killPid: number, signal?: NodeJS.Signals | number) =>
      originalKill(killPid, signal as any)) as typeof process.kill)
    try {
      await reconciler.settleFailedClaim(claimed!, 'codex_survivor_identity')
    } finally {
      killSpy.mockRestore()
    }

    // Not one real signal was aimed at the dead group (signal 0 liveness probes excluded).
    expect(killSpy.mock.calls.filter(([killPid, signal]) => killPid === -pid && signal !== 0)).toEqual([])
    // The dead record is unlinked from disk …
    await expect(fsp.stat(ownership.metadataPath)).rejects.toMatchObject({ code: 'ENOENT' })
    // … through the silent-success 'gone' verdict: no refusal/throw warn fired.
    expect(log.warn).not.toHaveBeenCalled()
    // … and dropClaim bookkeeping ran: nothing held, claimable, in-flight, or sweep-protected.
    expect(reconciler.claimForSession('thr-identity')).toBeNull()
    expect(reconciler.snapshot()).toMatchObject({ held: 0, claimableSessions: 0, inFlightClaims: 0 })
    expect(reconciler.sweepProtectionSet()).toEqual(new Set())
  })

  it('settles a codex_survivor_not_writer failure by keeping the survivor alive and held', async () => {
    const metadataDir = await makeTempDir()
    const { pid, identity } = await spawnRawSurvivingChild()
    const metadata = buildHeldRecord({
      ownershipId: 'settle-not-writer',
      wrapperPid: pid,
      processGroupId: pid,
      wrapperIdentity: identity,
      sessionId: 'thr-not-writer',
    })
    const ownership = await writeHeldRecord(metadataDir, metadata)
    const reconciler = new CodexSidecarReconciler({ log: createReconcilerLog() })
    expect(await reconciler.hold(ownership)).toBe('held')
    const claimed = reconciler.claimForSession('thr-not-writer')
    expect(claimed).not.toBeNull()

    await reconciler.settleFailedClaim(claimed!, 'codex_survivor_not_writer')

    // The sidecar may be the writer of another thread: it stays alive, held, and un-signaled …
    expect(await isProcessGroupAlive(pid)).toBe(true)
    await expect(fsp.stat(ownership.metadataPath)).resolves.toBeDefined()
    expect(reconciler.snapshot()).toMatchObject({ held: 1, claimableSessions: 0, inFlightClaims: 0 })
    // … but its claim was consumed: it never re-enters this session index.
    expect(reconciler.claimForSession('thr-not-writer')).toBeNull()
  })

  it('never throws when the survivor teardown throws; the claim leaves held and in-flight (review F2)', async () => {
    const metadataDir = await makeTempDir()
    const { pid, identity } = await spawnRawSurvivingChild()
    const metadata = buildHeldRecord({
      ownershipId: 'settle-teardown-throws',
      wrapperPid: pid,
      processGroupId: pid,
      wrapperIdentity: identity,
      sessionId: 'thr-teardown-throws',
    })
    const ownership = await writeHeldRecord(metadataDir, metadata)
    const log = createReconcilerLog()
    const reconciler = new CodexSidecarReconciler({ log })
    expect(await reconciler.hold(ownership)).toBe('held')
    const claimed = reconciler.claimForSession('thr-teardown-throws')
    expect(claimed).not.toBeNull()

    // Force the ownership-gated teardown to throw through the same process.kill seam the reaper
    // tests use ("isolates process-group signaling failures…"): a throwing settle must still
    // resolve and finish its bookkeeping instead of stranding the candidate in-flight.
    const originalKill = process.kill
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((killPid: number, signal?: NodeJS.Signals | number) => {
      if (killPid === -pid && signal === 'SIGTERM') {
        const error = new Error('simulated SIGTERM failure') as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      }
      return originalKill(killPid, signal as any)
    }) as typeof process.kill)

    try {
      await expect(reconciler.settleFailedClaim(claimed!, 'codex_survivor_unreachable')).resolves.toBeUndefined()
    } finally {
      killSpy.mockRestore()
    }

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ownershipId: 'settle-teardown-throws', code: 'codex_survivor_unreachable' }),
      expect.any(String),
    )
    // dropClaim-equivalent bookkeeping ran despite the throw: the id is neither held nor in-flight,
    // so sweepProtectionSet can never protect a stranded claim. The record stays on disk (the
    // throw happened AT the signal), where the hourly reaper retries it.
    expect(reconciler.snapshot()).toMatchObject({ held: 0, claimableSessions: 0, inFlightClaims: 0 })
    expect(reconciler.sweepProtectionSet()).toEqual(new Set())
    expect(await isProcessGroupAlive(pid)).toBe(true)
    await expect(fsp.stat(ownership.metadataPath)).resolves.toBeDefined()
  })
})

describeWithLinuxProc('CodexSidecarReconciler sweep protection and grace', () => {
  it('protects held ids plus in-flight claims before expiry and only in-flight claims after', async () => {
    let now = 1_000_000
    const metadataDir = await makeTempDir()
    const claimed = await spawnRawSurvivingChild()
    const idle = await spawnRawSurvivingChild()
    const claimedOwnership = await writeHeldRecord(metadataDir, buildHeldRecord({
      ownershipId: 'sweep-claimed',
      wrapperPid: claimed.pid,
      processGroupId: claimed.pid,
      wrapperIdentity: claimed.identity,
      sessionId: 'thr-sweep',
    }))
    const idleOwnership = await writeHeldRecord(metadataDir, buildHeldRecord({
      ownershipId: 'sweep-idle',
      wrapperPid: idle.pid,
      processGroupId: idle.pid,
      wrapperIdentity: idle.identity,
    }))
    const reconciler = new CodexSidecarReconciler({
      reapGraceMs: 30_000,
      nowFn: () => now,
      log: createReconcilerLog(),
    })
    expect(await reconciler.hold(claimedOwnership)).toBe('held')
    expect(await reconciler.hold(idleOwnership)).toBe('held')

    expect(reconciler.hasExpired()).toBe(false)
    expect(reconciler.claimForSession('thr-sweep')?.metadata.ownershipId).toBe('sweep-claimed')
    // Before expiry the reaper must skip everything the reconciler knows about.
    expect(reconciler.sweepProtectionSet()).toEqual(new Set(['sweep-claimed', 'sweep-idle']))

    now += 30_000
    expect(reconciler.hasExpired()).toBe(true)
    // After expiry only the in-flight claim stays protected: an attacher must never be swept.
    expect(reconciler.sweepProtectionSet()).toEqual(new Set(['sweep-claimed']))

    reconciler.dropClaim('sweep-claimed')
    expect(reconciler.sweepProtectionSet()).toEqual(new Set())
    expect(reconciler.snapshot()).toMatchObject({ held: 1, claimableSessions: 0, inFlightClaims: 0 })
  })

  it('forget drops ids another actor removed from disk across every reconciler map', async () => {
    const metadataDir = await makeTempDir()
    const { pid, identity } = await spawnRawSurvivingChild()
    const ownership = await writeHeldRecord(metadataDir, buildHeldRecord({
      ownershipId: 'forget-me',
      wrapperPid: pid,
      processGroupId: pid,
      wrapperIdentity: identity,
      sessionId: 'thr-forget',
    }))
    let now = 2_000_000
    const reconciler = new CodexSidecarReconciler({ nowFn: () => now, log: createReconcilerLog() })
    expect(await reconciler.hold(ownership)).toBe('held')

    reconciler.forget(['forget-me'])

    expect(reconciler.snapshot()).toMatchObject({ held: 0, claimableSessions: 0, inFlightClaims: 0 })
    expect(reconciler.claimForSession('thr-forget')).toBeNull()
    expect(reconciler.sweepProtectionSet()).toEqual(new Set())
    now += Number.MAX_SAFE_INTEGER
    expect(reconciler.sweepProtectionSet()).toEqual(new Set())
  })
})

describe('resolveCodexSidecarReapGraceMs', () => {
  it('parses undefined to the default, honors 0, and warns into the default on garbage', () => {
    expect(CODEX_SIDECAR_REAP_GRACE_DEFAULT_MS).toBe(30 * 60 * 1000)
    const log = createReconcilerLog()

    expect(resolveCodexSidecarReapGraceMs(undefined)).toBe(CODEX_SIDECAR_REAP_GRACE_DEFAULT_MS)
    expect(resolveCodexSidecarReapGraceMs('0', log)).toBe(0)
    expect(log.warn).not.toHaveBeenCalled()
    expect(resolveCodexSidecarReapGraceMs('90000', log)).toBe(90_000)
    expect(log.warn).not.toHaveBeenCalled()
    expect(resolveCodexSidecarReapGraceMs('nonsense', log)).toBe(CODEX_SIDECAR_REAP_GRACE_DEFAULT_MS)
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(resolveCodexSidecarReapGraceMs('-5', log)).toBe(CODEX_SIDECAR_REAP_GRACE_DEFAULT_MS)
    expect(log.warn).toHaveBeenCalledTimes(2)
  })

  it('falls back to the default with a warn on digit strings that overflow a safe integer (review Nit 2)', () => {
    const log = createReconcilerLog()
    // A 400-digit string parses to Infinity; without the safe-integer guard hasExpired() would be
    // permanently false and the sweep would silently never run.
    expect(resolveCodexSidecarReapGraceMs('9'.repeat(400), log)).toBe(CODEX_SIDECAR_REAP_GRACE_DEFAULT_MS)
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith({ raw: '9'.repeat(400) }, expect.any(String))
    // 2^53+1 in digits loses precision on parse (not a safe integer); MAX_SAFE_INTEGER itself is
    // still honored literally.
    expect(resolveCodexSidecarReapGraceMs('9007199254740993', log)).toBe(CODEX_SIDECAR_REAP_GRACE_DEFAULT_MS)
    expect(log.warn).toHaveBeenCalledTimes(2)
    expect(resolveCodexSidecarReapGraceMs(String(Number.MAX_SAFE_INTEGER), log)).toBe(Number.MAX_SAFE_INTEGER)
    expect(log.warn).toHaveBeenCalledTimes(2)
  })
})

// --- Task 5: three-scenario restore-reattach proof at the planner+runtime layer ---

// A TUI-role client: what the codex TUI does against the plan's remote proxy (initialize, then
// thread/resume). Tracked so a mid-test failure never leaks an open socket.
function connectTuiClient(wsUrl: string): CodexAppServerClient {
  const client = new CodexAppServerClient({ wsUrl })
  tuiClients.add(client)
  return client
}

// Planner proxyFactory that hands the REAL CodexRemoteProxy to the plan while keeping a handle
// for afterEach cleanup (proxies listen on real loopback ports).
function trackedProxyFactory(options: ConstructorParameters<typeof CodexRemoteProxy>[0]): CodexRemoteProxy {
  const proxy = new CodexRemoteProxy(options)
  launchProxies.add(proxy)
  return proxy
}

type FixtureThreadOperation = {
  method: string
  threadId: string | null
  listenUrl: string
  at: string
  params?: Record<string, unknown>
}

// The fixture appends one JSONL entry per served thread/* op, each stamped with the SERVING
// sidecar's own --listen URL. An ENOENT log means the fixture received zero thread ops — that is
// itself the readable "no resume ever landed here" signal (the negative-control run leans on it).
async function readThreadOperationLog(logPath: string): Promise<FixtureThreadOperation[]> {
  const raw = await fsp.readFile(logPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FixtureThreadOperation)
}

describeWithLinuxProc('restore-reattach scenarios at the planner+runtime layer (kata 4g2a, da92 parity)', () => {
  it('scenario 1: a resume-keyed restore claims the surviving sidecar and the TUI resume is served by it', async () => {
    const metadataDir = await makeTempDir()
    const logsDir = await makeTempDir()
    const spawnCwd = await makeTempDir()
    const logA = path.join(logsDir, 'fixture-a-thread-ops.jsonl')
    const freshArgLog = path.join(logsDir, 'fresh-spawn-argv.json')
    const freshOpLog = path.join(logsDir, 'fresh-spawn-thread-ops.jsonl')

    // Unclean-death stand-in: fixture A survives with an authentic record retitled to a dead
    // owner from a previous server generation, carrying the thr-A claim key.
    const { ready: survivorReady } = await spawnSurvivingFixture({
      metadataDir,
      loadedThreadIds: ['thr-A'],
      claimKey: 'thr-A',
      appendThreadOperationLogPath: logA,
    })
    const survivorStartTimeTicks = (await readWrapperIdentityForTest(survivorReady.processPid)).startTimeTicks

    // Boot reconcile: A is HELD claimable (the pre-feature reaper would have killed it here).
    const reconciler = new CodexSidecarReconciler({ log: createReconcilerLog() })
    const boot = await runCodexStartupReaper({
      serverInstanceId: 'srv-current',
      metadataDir,
      holdReconciler: reconciler,
    })
    expect(boot.heldOwnershipIds).toEqual([survivorReady.ownershipId])
    expect(await isProcessGroupAlive(survivorReady.processGroupId)).toBe(true)
    expect(reconciler.snapshot()).toMatchObject({ held: 1, claimableSessions: 1, inFlightClaims: 0 })

    // Same wiring the server's restore path takes (serverInstanceId/current); the env below is
    // only ever consumed if the claim silently fails and a fresh spawn runs instead.
    const planner = new CodexLaunchPlanner(() => createRuntime({
      metadataDir,
      serverInstanceId: 'srv-current',
      env: {
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
          loadedThreadIds: ['thr-A'],
          appendThreadOperationLogPath: freshOpLog,
        }),
        FAKE_CODEX_APP_SERVER_ARG_LOG: freshArgLog,
      },
    }), {
      reconciler,
      proxyFactory: trackedProxyFactory,
    })

    const plan = await planner.planCreate({ cwd: spawnCwd, resumeSessionId: 'thr-A' })
    expect(plan.sessionId).toBe('thr-A')

    // Play the TUI through the plan's remote proxy.
    const tui = connectTuiClient(plan.remote.wsUrl)
    await tui.initialize()
    const resume = await tui.resumeThread({ threadId: 'thr-A' })
    expect(resume.threadId).toBe('thr-A')

    // Decisive reattach evidence: A's op log records the resume, stamped with A's OWN listener —
    // the request was served by the surviving sidecar, not by a fresh incarnation.
    const opsA = await readThreadOperationLog(logA)
    expect(opsA.filter((op) => op.method === 'thread/loaded/list').map((op) => op.listenUrl))
      .toEqual([survivorReady.wsUrl])
    const resumes = opsA.filter((op) => op.method === 'thread/resume')
    expect(resumes).toHaveLength(1)
    expect(resumes[0]).toMatchObject({ threadId: 'thr-A', listenUrl: survivorReady.wsUrl })

    // No fresh spawn ever ran: the claim path minted a runtime but never spawned through it.
    await expect(fsp.stat(freshArgLog)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readThreadOperationLog(freshOpLog)).toEqual([])

    // A is alive in the SAME incarnation (identical /proc start time — pid-reuse is excluded).
    process.kill(survivorReady.processPid, 0)
    expect((await readWrapperIdentityForTest(survivorReady.processPid)).startTimeTicks)
      .toBe(survivorStartTimeTicks)

    // adopt() retitles the record to the new terminal identity of this server generation.
    await plan.sidecar.adopt({ terminalId: 't-1', generation: 0 })
    const retitled = JSON.parse(await fsp.readFile(survivorReady.metadataPath, 'utf8'))
    expect(retitled.terminalId).toBe('t-1')
    expect(retitled.generation).toBe(0)
    expect(retitled.ownerServerPid).toBe(process.pid)

    // The claim was one-shot: thr-A has nothing left to claim.
    expect(reconciler.claimForSession('thr-A')).toBeNull()
    expect(reconciler.snapshot()).toMatchObject({ held: 0, claimableSessions: 0, inFlightClaims: 0 })

    await plan.sidecar.shutdown()
  })

  it('scenario 2: an empty survivor store falls back to a byte-compatible fresh spawn', async () => {
    const metadataDir = await makeTempDir()
    const logsDir = await makeTempDir()
    const spawnCwd = await makeTempDir()
    const logB = path.join(logsDir, 'fixture-b-thread-ops.jsonl')
    const argLogB = path.join(logsDir, 'fixture-b-argv.json')

    // Same wiring as scenario 1 but the store holds nothing: claimForSession returns null and the
    // planner takes the pre-feature spawn path unchanged.
    const reconciler = new CodexSidecarReconciler({ log: createReconcilerLog() })
    const planner = new CodexLaunchPlanner(() => createRuntime({
      metadataDir,
      serverInstanceId: 'srv-current',
      env: {
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
          loadedThreadIds: ['thr-B'],
          appendThreadOperationLogPath: logB,
        }),
        FAKE_CODEX_APP_SERVER_ARG_LOG: argLogB,
      },
    }), {
      reconciler,
      proxyFactory: trackedProxyFactory,
    })

    const plan = await planner.planCreate({ cwd: spawnCwd, resumeSessionId: 'thr-B' })
    expect(plan.sessionId).toBe('thr-B')

    const tui = connectTuiClient(plan.remote.wsUrl)
    await tui.initialize()
    const resume = await tui.resumeThread({ threadId: 'thr-B' })
    expect(resume.threadId).toBe('thr-B')

    // A fresh ownership record materialized with the Task-1 session stamp, owned by THIS server.
    const recordFiles = (await fsp.readdir(metadataDir)).filter((entry) => entry.endsWith('.json'))
    expect(recordFiles).toHaveLength(1)
    const record = JSON.parse(
      await fsp.readFile(path.join(metadataDir, recordFiles[0]), 'utf8'),
    ) as CodexSidecarOwnershipMetadata
    expect(record.sessionId).toBe('thr-B')
    expect(record.ownerServerPid).toBe(process.pid)

    // The fresh spawn itself served the resume (its own listener, matching its record).
    const opsB = await readThreadOperationLog(logB)
    const resumes = opsB.filter((op) => op.method === 'thread/resume')
    expect(resumes).toHaveLength(1)
    expect(resumes[0]).toMatchObject({ threadId: 'thr-B', listenUrl: record.wsUrl })

    // Spawn argv integrity: the managed remote config args and `app-server --listen` shape are
    // byte-identical to the pre-feature spawn path.
    const argLog = JSON.parse(await fsp.readFile(argLogB, 'utf8')) as { argv: string[] }
    const listenIndex = argLog.argv.indexOf('--listen')
    expect(argLog.argv).toContain('-c')
    expect(argLog.argv).toContain('features.apps=false')
    expect(argLog.argv).toContain('app-server')
    expect(listenIndex).toBeGreaterThanOrEqual(0)
    expect(argLog.argv[listenIndex + 1]).toBe(record.wsUrl)

    await plan.sidecar.shutdown()
  })

  it('scenario 3: the active-writer -32600 collision stays confined to the fresh-spawn path', async () => {
    const metadataDir = await makeTempDir()
    const spawnCwd = await makeTempDir()

    // Fixture C stands in for a SECOND sidecar that adopted the thread: its scripted override is
    // the exact -32600 the real app-server returns when a thread already has an active writer.
    // Together with scenario 1 this pins the da92 asymmetry: the SAME resume succeeds against a
    // claimed survivor and is rejected only on the fresh path.
    const reconciler = new CodexSidecarReconciler({ log: createReconcilerLog() })
    const planner = new CodexLaunchPlanner(() => createRuntime({
      metadataDir,
      serverInstanceId: 'srv-current',
      env: {
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
          overrides: {
            'thread/resume': {
              error: { code: -32600, message: 'thread already has an active writer' },
            },
          },
        }),
      },
    }), {
      reconciler,
      proxyFactory: trackedProxyFactory,
    })

    const plan = await planner.planCreate({ cwd: spawnCwd, resumeSessionId: 'thr-C' })
    expect(plan.sessionId).toBe('thr-C')

    const tui = connectTuiClient(plan.remote.wsUrl)
    await tui.initialize()
    const error = await tui.resumeThread({ threadId: 'thr-C' }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as { code?: unknown }).code).toBe(-32600)
    expect((error as Error).message).toContain('thread already has an active writer')

    await plan.sidecar.shutdown()
  })
})
