import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  type CodexSidecarOwnershipMetadata,
  type HeldCodexSidecarOwnership,
  type ReadyState,
} from '../../../../../server/coding-cli/codex-app-server/runtime.js'
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
let fixtureCodexHome: string

beforeEach(async () => {
  fixtureCodexHome = path.join(await makeTempDir(), 'codex-home')
})

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
}): Promise<{ ready: ReadyState; held: HeldCodexSidecarOwnership }> {
  const owner = createRuntime({
    metadataDir: input.metadataDir,
    serverInstanceId: 'srv-previous',
    env: {
      FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({ loadedThreadIds: input.loadedThreadIds }),
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
