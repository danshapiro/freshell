import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { expect, it, vi } from 'vitest'
import {
  DEFAULT_UPDATE_REMINDER,
  RESET_UPDATE_REMINDER,
  buildSelectedArtifacts,
  buildReopenCandidates,
  createJsonLogger,
  parseManagedUpdateMode,
  runManagedUpdateBootstrap,
  runManagedUpdateCli,
  runManagedRuntimeUpdate,
  runManagedRuntimeWorker,
  swapDirectoryOnDestination,
  webActionCanReachSupervisor,
  type ManagedRuntimeUpdateDependencies,
  type RuntimeView,
  type SystemdUnitGraph,
} from '../../../scripts/update-managed-runtime.js'

const owner = {
  checkoutRoot: '/srv/freshell',
  webUnit: 'freshell-rust.service',
  supervisorUnit: 'freshell-supervisor.service',
  webExecutable: '/srv/freshell/target/release/freshell-server',
  supervisorExecutable: '/srv/freshell/target/release/freshell-supervisor',
  adminCli: '/srv/freshell/target/release/freshell-supervisor-admin',
  sessionHostBinary: '/srv/freshell/target/release/freshell-session-host',
  clientDirectory: '/srv/freshell/dist/client',
  dockerSocket: '/run/user/1000/docker.sock',
  controlSocket: '/home/operator/.freshell/managed-runtime/control/supervisor.sock',
  callbackSocket: '/home/operator/.freshell/managed-runtime/control/mcp.sock',
  controlSecretFile: '/home/operator/.freshell/managed-runtime/control/secret',
  registryRoot: '/home/operator/.freshell/managed-runtime/registry',
  runtimeRoot: '/home/operator/.freshell/managed-runtime/runtime',
  providerRoot: '/home/operator/.freshell/managed-runtime/providers',
  workspaceRoot: '/home/operator/workspaces',
  environmentFile: '/srv/freshell/.env',
  imageEnvironmentFile: '/home/operator/.config/freshell/managed-runtime.env',
  imageReference: 'sha256:' + 'a'.repeat(64),
  databasePath: '/home/operator/.freshell/managed-runtime/registry/registry.sqlite3',
  callbackAddress: 'http://127.0.0.1:3001',
}

function view(overrides: Partial<RuntimeView> = {}): RuntimeView {
  return {
    soulId: 'soul-codex',
    incarnationId: 'incarnation-1',
    launchState: 'running',
    cleanupState: 'none',
    intentRevision: 12,
    desiredState: 'running',
    provider: 'codex',
    nativeSessionId: 'native-session-1',
    terminalResumeSessionId: 'native-session-1',
    freshAgentSessionId: null,
    ...overrides,
  }
}

function dependencies(overrides: Partial<ManagedRuntimeUpdateDependencies> = {}) {
  const effects: string[] = []
  const events: Record<string, unknown>[] = []
  const runtimeApi = fakeRuntimeApi(effects)
  const defaultDeps = {
    paths: {
      checkoutRoot: '/srv/freshell',
      home: '/home/operator',
      runtimeDirectory: '/run/user/1000',
      node: '/usr/bin/node',
      tsxEntry: '/srv/freshell/node_modules/tsx/dist/cli.mjs',
      updaterScript: '/srv/freshell/scripts/update-managed-runtime.ts',
      env: '/usr/bin/env',
      flock: '/usr/bin/flock',
      systemdRun: '/usr/bin/systemd-run',
      systemctl: '/usr/bin/systemctl',
      pnpm: '/home/operator/.local/share/pnpm/pnpm',
      cargo: '/home/operator/.cargo/bin/cargo',
      docker: '/usr/bin/docker',
      sqlite: '/usr/bin/sqlite3',
      toolPath: '/home/operator/.local/share/pnpm:/home/operator/.cargo/bin:/usr/local/bin:/usr/bin:/bin',
      pnpmHome: '/home/operator/.local/share/pnpm',
      cargoHome: '/home/operator/.cargo',
      rustupHome: '/home/operator/.rustup',
      cargoTargetDirectory: '/tmp/freshell-update/cargo-target',
    },
    approval: {
      readLine: vi.fn(async () => 'APPROVED'),
      create: vi.fn(async () => '/run/user/1000/freshell-update-approval-one'),
      consume: vi.fn(async () => true),
      remove: vi.fn(async () => undefined),
    },
    handoff: {
      submit: vi.fn(async (_request) => {
        effects.push('handoff')
        return 0
      }),
      runLockedWorker: vi.fn(async () => 0),
    },
    owner: {
      resolve: vi.fn(async () => {
        effects.push('owner')
        return owner
      }),
      inspectGraph: vi.fn(async () => {
        effects.push('graph')
        return { units: {} }
      }),
    },
    artifacts: {
      build: vi.fn(async (_selectedOwner, mode) => {
        effects.push(`build:${mode}`)
        return {
          webExecutable: '/tmp/stage/freshell-server',
          clientDirectory: '/tmp/stage/client',
          supervisorExecutable: '/tmp/stage/freshell-supervisor',
          adminCli: '/tmp/stage/freshell-supervisor-admin',
          sessionHostBinary: '/tmp/stage/freshell-session-host',
          imageId: 'sha256:' + 'b'.repeat(64),
        }
      }),
    },
    filesystem: {
      webExecutableIdentity: vi.fn(async () => ({
        live: { path: owner.webExecutable, device: 1, inode: 10 },
        selected: { path: owner.webExecutable, device: 1, inode: 10 },
      })),
      installExecutable: vi.fn(async (_source, target) => { effects.push(`install:${target}`) }),
      swapClientDirectory: vi.fn(async (_source, target) => { effects.push(`client:${target}`) }),
      installImageReference: vi.fn(async (_environmentFile, _imageId) => { effects.push('install:image-ref') }),
    },
    services: {
      stop: vi.fn(async (unit) => { effects.push(`stop:${unit}`) }),
      start: vi.fn(async (unit) => { effects.push(`start:${unit}`) }),
      restart: vi.fn(async (unit) => { effects.push(`restart:${unit}`) }),
      isActive: vi.fn(async (unit) => unit === owner.supervisorUnit),
      state: vi.fn(async (unit) => unit === owner.supervisorUnit ? 'active' : 'inactive'),
      waitSupervisorReady: vi.fn(async () => { effects.push('supervisor-ready') }),
      waitWebReady: vi.fn(async () => { effects.push('web-ready') }),
      waitCallbackReady: vi.fn(async () => { effects.push('callback-ready') }),
    },
    admin: {
      candidateSchemaVersion: vi.fn(async () => 19),
      currentSchemaVersion: vi.fn(async () => 19),
      health: vi.fn(async () => {
        effects.push('health')
        return { state: 'ok' as const, installationId: 'installation-1', controlEpoch: 7 }
      }),
      inventory: vi.fn(async () => [view()]),
      maintenanceInventory: vi.fn(async (_supervisorExecutable, _databasePath) => []),
      stop: vi.fn(async (soulId, expectedIntentRevision) => ({
        outcome: 'verified_empty' as const,
        view: view({ soulId, intentRevision: expectedIntentRevision + 1, desiredState: 'stopped', launchState: 'stopped', cleanupState: 'verified_empty' }),
      })),
      reopen: vi.fn(async (_candidate) => ({ outcome: 'reopened' as const })),
    },
    docker: {
      buildImage: vi.fn(async () => 'sha256:' + 'b'.repeat(64)),
      verifyDaemon: vi.fn(async () => undefined),
    },
    logger: {
      event: vi.fn(async (event) => { events.push(event) }),
      operator: vi.fn(async (line) => { effects.push(`operator:${line}`) }),
    },
    now: vi.fn(() => new Date('2026-11-01T12:34:56.789Z')),
    randomSuffix: vi.fn(() => 'abc123def456'),
    ...overrides,
  } as unknown as ManagedRuntimeUpdateDependencies
  Object.assign(defaultDeps.owner, {
    loadPersistentResourceManifest: vi.fn(async () => { effects.push('resource-manifest') }),
  })
  Object.assign(defaultDeps.artifacts, {
    serverBuildInfo: vi.fn(async (candidate: string) => {
      effects.push(`build-info:${candidate}`)
      return { managedRuntimeV1: true }
    }),
  })
  Object.assign(defaultDeps.services, {
    waitWebStopped: vi.fn(async () => { effects.push('web-stopped') }),
  })
  const deps = Object.assign(defaultDeps, { runtimeApi }) as ManagedRuntimeUpdateDependencies & {
    runtimeApi: FakeRuntimeApi
  }
  return { deps, effects, events, runtimeApi }
}

interface FakeRuntimeResponse {
  status: number
  body: unknown
}

type TestOwner = typeof owner

interface FakeRuntimeCall {
  owner: TestOwner
  token: string
  method: string
  endpoint: string
  body?: unknown
}

interface FakeRuntimeApi {
  calls: FakeRuntimeCall[]
  readAuthToken(selectedOwner: TestOwner): Promise<string>
  request(selectedOwner: TestOwner, token: string, method: string, endpoint: string, body?: unknown): Promise<FakeRuntimeResponse>
  respond(method: string, endpoint: string, response: FakeRuntimeResponse | ((body: unknown) => FakeRuntimeResponse)): void
}

function readinessReport(overrides: {
  installationId?: string
  controlEpoch?: number
  readiness?: Record<string, unknown>
  paneOwnership?: Record<string, unknown>
} = {}) {
  return {
    installationId: overrides.installationId ?? 'installation-1',
    controlEpoch: overrides.controlEpoch ?? 7,
    revision: 44,
    readiness: {
      initialScanState: 'complete',
      blockedSubsystems: [],
      ...(overrides.readiness ?? {}),
    },
    paneOwnership: {
      complete: true,
      panes: [],
      unattachedProcesses: [],
      readyToStop: true,
      ...(overrides.paneOwnership ?? {}),
    },
  }
}

function fakeRuntimeApi(effects: string[]): FakeRuntimeApi {
  const calls: FakeRuntimeCall[] = []
  const responses = new Map<string, FakeRuntimeResponse | ((body: unknown) => FakeRuntimeResponse)>()
  const key = (method: string, endpoint: string) => `${method} ${endpoint}`
  const initialReadiness = readinessReport()
  let maintenancePhase = 'open'
  let maintenanceOwner: string | null = null
  const defaultResponse = (method: string, endpoint: string, body: unknown): FakeRuntimeResponse => {
    if (method === 'GET' && endpoint === '/api/runtime/readiness') {
      return { status: 200, body: initialReadiness }
    }
    if (method === 'POST' && endpoint === '/api/runtime/maintenance/quiesce') {
      const request = body as { ownerId?: string }
      return {
        status: 200,
        body: {
          drained: true,
          readyToStop: true,
          lease: { ownerId: request.ownerId, leaseId: 'fixture-lease', expiresInMs: 30_000 },
          admission: { phase: 'quiesced', activePermits: 0 },
          readiness: initialReadiness,
        },
      }
    }
    if (method === 'POST' && endpoint === '/api/runtime/maintenance/commit-stop') {
      return { status: 200, body: { committed: true, readiness: initialReadiness, admission: { phase: 'shutdown-latched' } } }
    }
    if (method === 'POST' && endpoint === '/api/runtime/maintenance/release') {
      return { status: 200, body: { admission: { phase: 'open' } } }
    }
    if (method === 'GET' && endpoint === '/api/runtime/maintenance/status') {
      return { status: 200, body: { phase: maintenancePhase, activePermits: 0, leaseOwner: maintenanceOwner } }
    }
    return { status: 404, body: {} }
  }
  return {
    calls,
    async readAuthToken(selectedOwner) {
      effects.push('runtime-auth-token')
      expect(selectedOwner).toBe(owner)
      return 'test-auth-token-not-for-output'
    },
    async request(selectedOwner, token, method, endpoint, body) {
      effects.push(`runtime:${method}:${endpoint}`)
      calls.push({ owner: selectedOwner, token, method, endpoint, body })
      const selected = responses.get(key(method, endpoint))
      const response = typeof selected === 'function' ? selected(body) : selected ?? defaultResponse(method, endpoint, body)
      const responseBody = response.body && typeof response.body === 'object' && !Array.isArray(response.body)
        ? response.body as Record<string, unknown>
        : {}
      if (method === 'POST' && endpoint === '/api/runtime/maintenance/quiesce' && responseBody.lease) {
        const lease = responseBody.lease as Record<string, unknown>
        maintenancePhase = 'quiesced'
        maintenanceOwner = typeof lease.ownerId === 'string' ? lease.ownerId : null
      } else if (method === 'POST' && endpoint === '/api/runtime/maintenance/release' && response.status === 200) {
        maintenancePhase = 'open'
        maintenanceOwner = null
      } else if (method === 'POST' && endpoint === '/api/runtime/maintenance/commit-stop'
        && response.status === 200 && responseBody.committed === true) {
        maintenancePhase = 'shutdown-latched'
      }
      return response
    },
    respond(method, endpoint, response) { responses.set(key(method, endpoint), response) },
  }
}

it('reset abort restores web before supervisor shutdown', async () => {
    const f = dependencies()
    const addressed = view({
      soulId: 'soul-already-stopped',
      desiredState: 'stopped',
      launchState: 'running',
      cleanupState: 'termination_unconfirmed',
      nativeSessionId: null,
      terminalResumeSessionId: null,
    })
    f.deps.admin.inventory = vi.fn(async () => {
      f.effects.push('inventory')
      return [addressed]
    })

    const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

    expect(result).toBe(1)
    expect(f.effects.indexOf('stop:freshell-rust.service')).toBeLessThan(f.effects.indexOf('inventory'))
    expect(f.effects.indexOf('start:freshell-rust.service')).toBeGreaterThan(f.effects.indexOf('inventory'))
    expect(f.effects).not.toContain('stop:freshell-supervisor.service')
    expect(f.deps.admin.stop).not.toHaveBeenCalled()
})

it('stop batch halts after first nonverified outcome', async () => {
    const f = dependencies()
    f.deps.admin.inventory = vi.fn(async () => [
      view({ soulId: 'soul-first', incarnationId: 'incarnation-first', provider: 'codex', intentRevision: 4 }),
      view({ soulId: 'soul-second', incarnationId: 'incarnation-second', provider: 'claude', intentRevision: 9 }),
    ])
    f.deps.admin.stop = vi.fn(async (soulId) => {
      f.effects.push(`admin-stop:${soulId}`)
      return { outcome: 'blocked_ownership' as const, view: view({ soulId }) }
    })

    const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

    expect(result).toBe(1)
    expect(f.deps.admin.stop).toHaveBeenCalledTimes(1)
    expect(f.deps.admin.stop).toHaveBeenCalledWith('soul-first', 4, owner)
    expect(f.effects).not.toContain('admin-stop:soul-second')
    expect(f.effects).not.toContain('stop:freshell-supervisor.service')
    expect(f.effects.indexOf('start:freshell-rust.service')).toBeGreaterThan(f.effects.indexOf('admin-stop:soul-first'))
})

it('stop failure reports the attempted prefix and verified-empty set', async () => {
  const f = dependencies()
  f.deps.admin.inventory = vi.fn(async () => [
    view({ soulId: 'soul-first', intentRevision: 4 }),
    view({ soulId: 'soul-second', intentRevision: 9 }),
    view({ soulId: 'soul-third', intentRevision: 15 }),
  ])
  f.deps.admin.stop = vi.fn(async (soulId, expectedIntentRevision) => {
    f.effects.push(`admin-stop:${soulId}`)
    if (soulId === 'soul-second') return { outcome: 'backend_unavailable' as const }
    return {
      outcome: 'verified_empty' as const,
      view: view({
        soulId,
        intentRevision: expectedIntentRevision + 1,
        desiredState: 'stopped',
        launchState: 'stopped',
        cleanupState: 'verified_empty',
      }),
    }
  })

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(1)
  expect(f.deps.admin.inventory).toHaveBeenCalledTimes(1)
  expect(f.deps.admin.stop).toHaveBeenCalledTimes(2)
  expect(f.effects).not.toContain('admin-stop:soul-third')
  expect(f.events).toContainEqual(expect.objectContaining({
    event: 'update.stop_failed',
    attempted_prefix: ['soul-first', 'soul-second'],
    verified_empty_stopped: ['soul-first'],
  }))
})

it('unverified Stop view restores web and prevents the next soul or supervisor action', async () => {
  const f = dependencies()
  f.deps.admin.inventory = vi.fn(async () => [
    view({ soulId: 'soul-first' }),
    view({ soulId: 'soul-second', provider: 'claude' }),
  ])
  f.deps.admin.stop = vi.fn(async (soulId, expectedIntentRevision) => ({
    outcome: 'verified_empty' as const,
    view: view({
      soulId,
      intentRevision: expectedIntentRevision + 1,
      desiredState: 'stopped',
      launchState: 'running',
      cleanupState: 'verified_empty',
    }),
  }))

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(1)
  expect(f.deps.admin.stop).toHaveBeenCalledTimes(1)
  expect(f.deps.admin.stop).not.toHaveBeenCalledWith('soul-second', expect.anything(), expect.anything())
  expect(f.deps.services.stop).not.toHaveBeenCalledWith(owner.supervisorUnit)
  expect(f.deps.services.start).toHaveBeenCalledWith(owner.webUnit)
})

it('stop result incarnation must match addressed view', async () => {
  const f = dependencies()
  f.deps.admin.inventory = vi.fn(async () => [
    view({ soulId: 'soul-first', incarnationId: 'addressed-incarnation' }),
    view({ soulId: 'soul-second', incarnationId: 'second-incarnation', provider: 'claude' }),
  ])
  f.deps.admin.stop = vi.fn(async (soulId, expectedIntentRevision) => ({
    outcome: 'verified_empty' as const,
    view: view({
      soulId,
      incarnationId: 'different-incarnation',
      intentRevision: expectedIntentRevision + 1,
      desiredState: 'stopped',
      launchState: 'stopped',
      cleanupState: 'verified_empty',
    }),
  }))

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(1)
  expect(f.deps.admin.stop).toHaveBeenCalledTimes(1)
  expect(f.deps.admin.stop).toHaveBeenCalledWith('soul-first', 12, owner)
  expect(f.deps.services.stop).not.toHaveBeenCalledWith(owner.supervisorUnit)
  expect(f.deps.services.start).toHaveBeenCalledWith(owner.webUnit)
  expect(f.events).toContainEqual(expect.objectContaining({
    event: 'update.failed',
    attempted_prefix: ['soul-first'],
    verified_empty_stopped: [],
  }))
})

it('durable-only refuses changed web executable', async () => {
    const f = dependencies()
    f.deps.filesystem.webExecutableIdentity = vi.fn(async () => ({
      live: { path: '/srv/freshell/target/release/old-server', device: 1, inode: 10 },
      selected: { path: owner.webExecutable, device: 1, inode: 11 },
    }))

    const result = await runManagedRuntimeWorker('durable-only', f.deps, '/run/user/1000/approval')

    expect(result).toBe(2)
    expect(f.deps.filesystem.webExecutableIdentity).toHaveBeenCalledWith(owner.webExecutable)
    expect(f.effects).not.toContain('stop:freshell-rust.service')
    expect(f.effects).not.toContain('stop:freshell-supervisor.service')
    expect(f.deps.admin.inventory).not.toHaveBeenCalled()
})

it('default completion event includes reminder', async () => {
    const f = dependencies()

    const result = await runManagedRuntimeWorker('client', f.deps)

    expect(result).toBe(0)
    expect(f.deps.services.stop).toHaveBeenCalledWith(owner.webUnit)
    expect(f.deps.services.waitWebStopped).toHaveBeenCalledWith(owner)
    expect(f.deps.services.start).toHaveBeenCalledWith(owner.webUnit)
    expect(f.deps.services.restart).not.toHaveBeenCalledWith(owner.supervisorUnit)
    expect(f.events).toContainEqual(expect.objectContaining({
      event: 'update.completed',
      mode: 'client',
      reminder: DEFAULT_UPDATE_REMINDER,
    }))
})

it('bootstrap invokes resolved tsx entrypoint with pinned node', async () => {
    const f = dependencies()

    const result = await runManagedRuntimeUpdate([], f.deps)

    expect(result).toBe(0)
    expect(f.deps.handoff.submit).toHaveBeenCalledTimes(1)
    const request = vi.mocked(f.deps.handoff.submit).mock.calls[0]?.[0]
    expect(request?.unit).toMatch(/^freshell-update-managed-runtime-20261101T123456789Z-abc123def456\.service$/)
    expect(request?.args).toContain('--wait')
    expect(request?.args).not.toContain('--pipe')
    expect(request?.args).not.toContain('--collect')
    expect(request?.args).toContain('/usr/bin/node')
    expect(request?.args).toContain('/srv/freshell/node_modules/tsx/dist/cli.mjs')
    expect(request?.args).not.toContain('/srv/freshell/node_modules/.bin/tsx')
    expect(request?.environment).not.toHaveProperty('APPROVED')
})

it('invalid update modes refuse before approval or handoff', async () => {
  const f = dependencies()

  const result = await runManagedRuntimeUpdate(['--all', '--durable-only'], f.deps)

  expect(result).toBe(2)
  expect(f.deps.approval.readLine).not.toHaveBeenCalled()
  expect(f.deps.approval.create).not.toHaveBeenCalled()
  expect(f.deps.handoff.submit).not.toHaveBeenCalled()
})

it('public mode rejects internal worker flags', async () => {
  const f = dependencies()
  const runId = '20261101T123456789Z-abc123def456'
  const unitName = `freshell-update-managed-runtime-${runId}.service`

  const workerResult = await runManagedUpdateCli([
    '--worker', '--mode', 'client', '--unit-name', unitName, '--run-id', runId,
  ], f.deps)
  const bootstrapResult = await runManagedUpdateCli([
    '--bootstrap', '--mode', 'client', '--unit-name', unitName, '--run-id', runId,
  ], f.deps)

  expect(workerResult).toBe(2)
  expect(bootstrapResult).toBe(2)
  expect(f.deps.owner.resolve).not.toHaveBeenCalled()
  expect(f.deps.artifacts.build).not.toHaveBeenCalled()
  expect(f.deps.services.restart).not.toHaveBeenCalled()
  expect(f.effects).toEqual([])
})

it('reset mode requires the exact approval line and creates a mode-0600 handoff file', async () => {
  const f = dependencies()

  const result = await runManagedRuntimeUpdate(['--all'], f.deps)

  expect(result).toBe(0)
  expect(f.deps.approval.create).toHaveBeenCalledWith('APPROVED\n', 0o600)
  expect(f.deps.approval.remove).toHaveBeenCalledWith('/run/user/1000/freshell-update-approval-one')
  const request = vi.mocked(f.deps.handoff.submit).mock.calls[0]?.[0]
  expect(request?.args).toContain('/run/user/1000/freshell-update-approval-one')
  expect(request?.args).not.toContain('APPROVED')
  expect(Object.values(request?.environment ?? {})).not.toContain('APPROVED')
  expect(f.effects.indexOf(`operator:Durable log: ${request?.logPath}`)).toBeLessThan(f.effects.indexOf('handoff'))
  expect(f.effects.findIndex((effect) => effect.startsWith(`operator:${RESET_UPDATE_REMINDER}`))).toBeLessThan(f.effects.indexOf('handoff'))
})

it('inexact reset approval refuses before file creation and handoff', async () => {
  const f = dependencies()
  f.deps.approval.readLine = vi.fn(async () => 'APPROVED ')

  const result = await runManagedRuntimeUpdate(['--durable-only'], f.deps)

  expect(result).toBe(2)
  expect(f.deps.approval.create).not.toHaveBeenCalled()
  expect(f.deps.handoff.submit).not.toHaveBeenCalled()
})

it('flock contention logs and removes only this invocation approval without worker effects', async () => {
  const f = dependencies()
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-runtime-lock-'))
  const lockPath = path.join(temp, 'freshell-update-managed-runtime.lock')
  const markerPath = path.join(temp, 'holder-ready')
  const approvalPath = path.join(temp, 'this-approval')
  const otherApprovalPath = path.join(temp, 'other-approval')
  fs.writeFileSync(approvalPath, 'APPROVED\n', { mode: 0o600 })
  fs.writeFileSync(otherApprovalPath, 'APPROVED\n', { mode: 0o600 })
  f.deps.paths.runtimeDirectory = temp
  f.deps.approval.remove = vi.fn(async (filePath) => { await fs.promises.unlink(filePath) })
  f.deps.approval.consume = vi.fn(async () => { throw new Error('contention must not read approval') })
  f.deps.handoff.runLockedWorker = vi.fn(async (request) => {
    const result = spawnSync(f.deps.paths.flock, ['-n', '-E', '75', request.lockPath, ...request.command], {
      env: request.environment,
      stdio: 'ignore',
    })
    return result.status ?? 1
  })
  const holderScript = "require('node:fs').writeFileSync(process.argv[1], 'locked'); setTimeout(() => {}, 60000)"
  const holder = spawn(f.deps.paths.flock, [
    '-n', lockPath, process.execPath, '-e', holderScript, markerPath,
  ], { detached: true, stdio: 'ignore' })

  try {
    await once(holder, 'spawn')
    const deadline = Date.now() + 5_000
    while (!fs.existsSync(markerPath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    expect(fs.existsSync(markerPath)).toBe(true)

    const result = await runManagedUpdateBootstrap({
      mode: 'all',
      unitName: 'freshell-update-managed-runtime-20261101T123456789Z-abc123def456.service',
      runId: '20261101T123456789Z-abc123def456',
      approvalFile: approvalPath,
    }, f.deps)

    expect(result).toBe(75)
    expect(f.events).toContainEqual({
      event: 'update.lock_contention',
      severity: 'error',
      mode: 'all',
      phase: 'lock',
      error_code: 'update_lock_busy',
    })
    expect(f.deps.approval.consume).not.toHaveBeenCalled()
    expect(f.deps.approval.remove).toHaveBeenCalledExactlyOnceWith(approvalPath)
    expect(fs.existsSync(approvalPath)).toBe(false)
    expect(fs.existsSync(otherApprovalPath)).toBe(true)
    expect(f.deps.owner.resolve).not.toHaveBeenCalled()
    expect(f.deps.artifacts.build).not.toHaveBeenCalled()
    expect(f.effects).toEqual([])
  } finally {
    if (holder.exitCode === null) {
      try { process.kill(-holder.pid!, 'SIGTERM') } catch { /* the holder may have exited */ }
      await once(holder, 'exit').catch(() => undefined)
    }
    await fs.promises.rm(temp, { recursive: true, force: true })
  }
}, 15_000)

it('handoff completion and JSONL logging survive the launcher process exit', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-runtime-boundary-'))
  const modulePath = path.resolve('scripts/update-managed-runtime.ts')
  const tsxEntry = fs.realpathSync('node_modules/tsx/dist/cli.mjs')
  const workerPath = path.join(temp, 'worker.mts')
  const launcherPath = path.join(temp, 'launcher.mts')
  const runId = '20261101T123456789Z-abc123def456'
  const logPath = path.join(temp, '.freshell', 'logs', `managed-runtime-update-${runId}.jsonl`)
  fs.writeFileSync(workerPath, `
import { createJsonLogger } from ${JSON.stringify(modulePath)}
await createJsonLogger(process.argv[2]).event({ event: 'update.completed', severity: 'info', mode: 'client', phase: 'complete' })
`)
  fs.writeFileSync(launcherPath, `
import { spawn } from 'node:child_process'
import { runManagedRuntimeUpdate } from ${JSON.stringify(modulePath)}
const home = ${JSON.stringify(temp)}
const deps = {
  paths: { checkoutRoot: home, home, runtimeDirectory: home, node: process.execPath, tsxEntry: ${JSON.stringify(tsxEntry)}, updaterScript: ${JSON.stringify(modulePath)}, env: '/usr/bin/env', flock: '/usr/bin/flock', systemdRun: '/usr/bin/systemd-run', systemctl: '/usr/bin/systemctl', pnpm: '/usr/bin/pnpm', cargo: '/usr/bin/cargo', docker: '/usr/bin/docker', sqlite: '/usr/bin/sqlite3', toolPath: '/usr/bin' },
  approval: { async readLine() { throw new Error('default mode must not prompt') }, async create() { throw new Error('default mode must not create approval') }, async consume() { return false }, async remove() {} },
  handoff: { submit(request) { const child = spawn(process.execPath, [${JSON.stringify(tsxEntry)}, ${JSON.stringify(workerPath)}, request.logPath], { detached: true, stdio: 'ignore' }); child.unref(); return Promise.resolve(0) }, async runLockedWorker() { return 0 } },
  owner: { async resolve() { throw new Error('handoff worker owns update actions') }, async inspectGraph() { return { units: {} } } },
  artifacts: { async build() { throw new Error('handoff worker owns update actions') } },
  filesystem: { async webExecutableIdentity() { return { live: null, selected: null } }, async installExecutable() {}, async swapClientDirectory() {}, async installImageReference() {} },
  services: { async stop() {}, async start() {}, async restart() {}, async isActive() { return false }, async state() { return 'inactive' }, async waitSupervisorReady() {}, async waitWebReady() {}, async waitCallbackReady() {} },
  admin: { async candidateSchemaVersion() { return 19 }, async currentSchemaVersion() { return 19 }, async health() { return { state: 'ok' } }, async inventory() { return [] }, async maintenanceInventory() { return [] }, async stop() { return { outcome: 'backend_unavailable' } }, async reopen() { return { outcome: 'failed' } } },
  docker: { async buildImage() { return 'sha256:' + 'b'.repeat(64) }, async verifyDaemon() {} },
  logger: { async event() {}, async operator() {} },
  now() { return new Date('2026-11-01T12:34:56.789Z') }, randomSuffix() { return 'abc123def456' },
}
await runManagedRuntimeUpdate([], deps)
`)

  try {
    const launcher = spawn(process.execPath, [tsxEntry, launcherPath], { stdio: 'pipe' })
    let launcherOutput = ''
    launcher.stdout?.on('data', (chunk: Buffer) => { launcherOutput += chunk.toString() })
    launcher.stderr?.on('data', (chunk: Buffer) => { launcherOutput += chunk.toString() })
    const [exitCode] = await once(launcher, 'exit') as [number]
    expect(exitCode, launcherOutput).toBe(0)
    const deadline = Date.now() + 5_000
    while (!fs.existsSync(logPath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    expect(fs.existsSync(logPath)).toBe(true)
    expect(fs.readFileSync(logPath, 'utf8')).toContain('"event":"update.completed"')
    expect(fs.statSync(logPath).mode & 0o777).toBe(0o600)
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true })
  }
}, 15_000)

it('worker consumes approval before owner inspection', async () => {
  const f = dependencies()
  f.deps.approval.consume = vi.fn(async () => {
    f.effects.push('consume-approval')
    return true
  })

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(0)
  expect(f.effects.indexOf('consume-approval')).toBeLessThan(f.effects.indexOf('owner'))
  expect(f.deps.approval.consume).toHaveBeenCalledWith('/run/user/1000/approval')
})

it('worker approval refusal does not inspect or mutate the owner', async () => {
  const f = dependencies()
  f.deps.approval.consume = vi.fn(async () => false)

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/invalid-approval')

  expect(result).toBe(2)
  expect(f.deps.owner.resolve).not.toHaveBeenCalled()
  expect(f.deps.artifacts.build).not.toHaveBeenCalled()
  expect(f.effects).toEqual([])
})

it('approval deletion failure refuses before owner inspection', async () => {
  const f = dependencies()
  f.deps.approval.consume = vi.fn(async () => {
    const error = Object.assign(new Error('approval file could not be removed'), { code: 'EACCES' })
    throw error
  })

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(2)
  expect(f.deps.owner.resolve).not.toHaveBeenCalled()
  expect(f.deps.artifacts.build).not.toHaveBeenCalled()
  expect(f.deps.services.stop).not.toHaveBeenCalled()
  expect(f.events).toContainEqual(expect.objectContaining({
    event: 'update.approval_refused', phase: 'approval', error_code: 'approval_invalid',
  }))
})

it('owner inspection errors refuse before building or service effects', async () => {
  const f = dependencies()
  f.deps.owner.resolve = vi.fn(async () => {
    throw new Error('selected runtime owner could not be verified')
  })

  const result = await runManagedRuntimeWorker('client', f.deps)

  expect(result).toBe(2)
  expect(f.deps.artifacts.build).not.toHaveBeenCalled()
  expect(f.deps.services.restart).not.toHaveBeenCalled()
})

it('candidate schema read errors refuse before stopping web ingress', async () => {
  const f = dependencies()
  f.deps.admin.candidateSchemaVersion = vi.fn(async () => {
    throw new Error('candidate schema could not be verified')
  })

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(2)
  expect(f.effects).not.toContain('stop:freshell-rust.service')
  expect(f.effects).not.toContain('stop:freshell-supervisor.service')
  expect(f.deps.admin.inventory).not.toHaveBeenCalled()
})

it('schema mismatch refuses before web ingress or session mutation', async () => {
  const f = dependencies()
  f.deps.admin.candidateSchemaVersion = vi.fn(async () => 20)
  f.deps.admin.currentSchemaVersion = vi.fn(async () => 19)

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(2)
  expect(f.deps.admin.candidateSchemaVersion).toHaveBeenCalledWith('/tmp/stage/freshell-supervisor')
  expect(f.deps.admin.currentSchemaVersion).toHaveBeenCalledWith(owner.databasePath)
  expect(f.deps.services.stop).not.toHaveBeenCalled()
  expect(f.deps.admin.inventory).not.toHaveBeenCalled()
})

it('owner path mismatch refuses before building or changing a service', async () => {
  const f = dependencies()
  f.deps.owner.resolve = vi.fn(async () => ({ ...owner, webExecutable: '/other/freshell-server' }))

  const result = await runManagedRuntimeWorker('client', f.deps)

  expect(result).toBe(2)
  expect(f.deps.artifacts.build).not.toHaveBeenCalled()
  expect(f.deps.services.restart).not.toHaveBeenCalled()
})

it('reopen uses the stopped revision returned by the fenced Stop', async () => {
  const f = dependencies()
  f.deps.admin.inventory = vi.fn(async () => [view({ intentRevision: 12 })])
  f.deps.admin.stop = vi.fn(async (soulId, expectedIntentRevision) => ({
    outcome: 'verified_empty' as const,
    view: view({
      soulId,
      intentRevision: expectedIntentRevision + 1,
      desiredState: 'stopped',
      launchState: 'stopped',
      cleanupState: 'verified_empty',
    }),
  }))

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(0)
  expect(f.deps.admin.reopen).toHaveBeenCalledWith(expect.objectContaining({
    soulId: 'soul-codex',
    expectedIntentRevision: 13,
  }), owner)
})

it.each([
  ['Requires', 'web', 'supervisor'],
  ['Wants', 'web', 'supervisor'],
  ['Requisite', 'web', 'supervisor'],
  ['PartOf', 'supervisor', 'web'],
  ['BindsTo', 'web', 'supervisor'],
  ['BindsTo', 'supervisor', 'web'],
  ['Upholds', 'web', 'supervisor'],
  ['PropagatesStopTo', 'web', 'supervisor'],
  ['ConsistsOf', 'web', 'supervisor'],
  ['BoundBy', 'web', 'supervisor'],
  ['UpheldBy', 'supervisor', 'web'],
  ['StopPropagatedFrom', 'supervisor', 'web'],
])('web action rejects effective %s relationship from %s to %s', (property, source, target) => {
  const web = 'freshell-rust.service'
  const supervisor = 'freshell-supervisor.service'
  const units: Record<string, Record<string, string[]>> = {
    [web]: {},
    [supervisor]: {},
  }
  const key = source === 'web' ? web : supervisor
  const value = target === 'web' ? web : supervisor
  units[key]![property] = [value]

  expect(webActionCanReachSupervisor({ units } as SystemdUnitGraph, web, supervisor)).toBe(true)
})

it('ordering-only After does not make a web action reach the supervisor', () => {
  const graph = {
    units: {
      'freshell-rust.service': { After: ['freshell-supervisor.service'] },
      'freshell-supervisor.service': {},
    },
  } as SystemdUnitGraph

  expect(webActionCanReachSupervisor(graph, 'freshell-rust.service', 'freshell-supervisor.service')).toBe(false)
})

it('transitive activation and stop relationships that reach the supervisor block web actions', () => {
  const web = 'freshell-rust.service'
  const supervisor = 'freshell-supervisor.service'
  const activationGraph = {
    units: {
      [web]: { Wants: ['intermediate.service'] },
      'intermediate.service': { Requisite: [supervisor] },
      [supervisor]: {},
    },
  } as SystemdUnitGraph
  const stopPropagationGraph = {
    units: {
      [web]: { ConsistsOf: ['intermediate.service'] },
      'intermediate.service': { PropagatesStopTo: [supervisor] },
      [supervisor]: {},
    },
  } as SystemdUnitGraph

  expect(webActionCanReachSupervisor(activationGraph, web, supervisor)).toBe(true)
  expect(webActionCanReachSupervisor(stopPropagationGraph, web, supervisor)).toBe(true)
})

it('all mode stops ingress, fences the coding-soul reset, then installs and reopens', async () => {
  const f = dependencies()
  f.deps.admin.candidateSchemaVersion = vi.fn(async () => { f.effects.push('candidate-schema'); return 19 })
  f.deps.admin.currentSchemaVersion = vi.fn(async () => { f.effects.push('current-schema'); return 19 })
  f.deps.docker.verifyDaemon = vi.fn(async () => { f.effects.push('verify-daemon') })
  f.deps.admin.inventory = vi.fn(async () => {
    f.effects.push('inventory')
    return [view()]
  })
  f.deps.admin.stop = vi.fn(async (soulId, expectedIntentRevision) => {
    f.effects.push(`admin-stop:${soulId}:${expectedIntentRevision}`)
    return {
      outcome: 'verified_empty' as const,
      view: view({
        soulId,
        intentRevision: expectedIntentRevision + 1,
        desiredState: 'stopped',
        launchState: 'stopped',
        cleanupState: 'verified_empty',
      }),
    }
  })
  f.deps.admin.health = vi.fn(async () => {
    f.effects.push('health')
    return { state: 'ok' as const, installationId: 'installation-1', controlEpoch: 7 }
  })
  f.deps.admin.reopen = vi.fn(async (candidate) => {
    f.effects.push(`reopen:${candidate.soulId}:${candidate.expectedIntentRevision}`)
    return { outcome: 'reopened' as const }
  })

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(0)
  expect(f.deps.artifacts.build).toHaveBeenCalledWith(owner, 'all')
  expect(f.deps.admin.inventory).toHaveBeenCalledTimes(1)
  expect(f.deps.admin.stop).toHaveBeenCalledTimes(1)
  expect(f.effects.indexOf('candidate-schema')).toBeLessThan(f.effects.indexOf('stop:freshell-rust.service'))
  expect(f.effects.indexOf('current-schema')).toBeLessThan(f.effects.indexOf('stop:freshell-rust.service'))
  expect(f.effects.indexOf('stop:freshell-rust.service')).toBeLessThan(f.effects.indexOf('inventory'))
  expect(f.effects.indexOf('inventory')).toBeLessThan(f.effects.indexOf('admin-stop:soul-codex:12'))
  expect(f.effects.indexOf('admin-stop:soul-codex:12')).toBeLessThan(f.effects.indexOf('stop:freshell-supervisor.service'))
  expect(f.effects.indexOf('stop:freshell-supervisor.service')).toBeLessThan(f.effects.indexOf(`install:${owner.supervisorExecutable}`))
  expect(f.effects.indexOf(`install:${owner.supervisorExecutable}`)).toBeLessThan(f.effects.indexOf('start:freshell-supervisor.service'))
  expect(f.effects.indexOf('health')).toBeLessThan(f.effects.indexOf('start:freshell-rust.service'))
  expect(f.effects.indexOf('callback-ready')).toBeLessThan(f.effects.indexOf('reopen:soul-codex:13'))
})

it('durable-only skips web artifact replacement and verifies the selected running executable', async () => {
  const f = dependencies()
  f.deps.filesystem.webExecutableIdentity = vi.fn(async (selectedPath) => {
    f.effects.push('web-executable-identity')
    return {
      live: { path: selectedPath, device: 1, inode: 10 },
      selected: { path: selectedPath, device: 1, inode: 10 },
    }
  })

  const result = await runManagedRuntimeWorker('durable-only', f.deps, '/run/user/1000/approval')

  expect(result).toBe(0)
  expect(f.deps.artifacts.build).toHaveBeenCalledWith(owner, 'durable-only')
  expect(f.effects.indexOf('web-executable-identity')).toBeLessThan(f.effects.indexOf('stop:freshell-rust.service'))
  expect(f.effects).not.toContain(`install:${owner.webExecutable}`)
  expect(f.effects).not.toContain(`client:${owner.clientDirectory}`)
  expect(f.effects).toContain('stop:freshell-rust.service')
  expect(f.effects).toContain('start:freshell-rust.service')
})

it('client mode builds web assets and replaces only the web service', async () => {
  const f = dependencies()

  const result = await runManagedRuntimeWorker('client', f.deps)

  expect(result).toBe(0)
  expect(f.deps.artifacts.build).toHaveBeenCalledWith(owner, 'client')
  expect(f.deps.services.stop).toHaveBeenCalledWith(owner.webUnit)
  expect(f.deps.services.waitWebStopped).toHaveBeenCalledWith(owner)
  expect(f.deps.services.start).toHaveBeenCalledWith(owner.webUnit)
  expect(f.deps.services.restart).not.toHaveBeenCalled()
  expect(f.deps.admin.inventory).not.toHaveBeenCalled()
  expect(f.deps.admin.stop).not.toHaveBeenCalled()
  expect(f.deps.admin.reopen).not.toHaveBeenCalled()
  expect(f.effects).toContain('web-ready')
  expect(f.effects).toContain('callback-ready')
})

it('coding-provider souls are reset across prepared and recovering states while shell is excluded', async () => {
  const f = dependencies()
  f.deps.admin.inventory = vi.fn(async () => [
    view({
      soulId: 'soul-prepared',
      provider: 'kilroy',
      launchState: 'prepared',
      nativeSessionId: null,
      terminalResumeSessionId: null,
      recoveryState: 'recovering',
    }),
    view({ soulId: 'soul-shell', provider: 'shell', launchState: 'running' }),
  ])
  f.deps.admin.stop = vi.fn(async (soulId, expectedIntentRevision) => ({
    outcome: 'verified_empty' as const,
    view: view({
      soulId,
      intentRevision: expectedIntentRevision + 1,
      desiredState: 'stopped',
      launchState: 'stopped',
      cleanupState: 'verified_empty',
    }),
  }))

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(0)
  expect(f.deps.admin.stop).toHaveBeenCalledTimes(1)
  expect(f.deps.admin.stop).toHaveBeenCalledWith('soul-prepared', 12, owner)
  expect(f.deps.admin.stop).not.toHaveBeenCalledWith('soul-shell', expect.anything(), expect.anything())
})

it('client directory swap preserves the old sibling and prevents web restart on activation failure', async () => {
  const f = dependencies()
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-runtime-swap-'))
  const source = path.join(temp, 'staged-client')
  const target = path.join(temp, 'served-client')
  fs.mkdirSync(source)
  fs.mkdirSync(target)
  fs.writeFileSync(path.join(source, 'index.html'), 'new client')
  fs.writeFileSync(path.join(target, 'index.html'), 'old client')
  let renameCount = 0
  const rename = async (from: Parameters<typeof fs.promises.rename>[0], to: Parameters<typeof fs.promises.rename>[1]) => {
    renameCount += 1
    if (renameCount === 1) return fs.promises.rename(from, to)
    throw new Error('simulated second rename failure')
  }
  f.deps.filesystem.swapClientDirectory = vi.fn(async () => swapDirectoryOnDestination(source, target, rename))

  try {
    const result = await runManagedRuntimeWorker('client', f.deps)

    expect(result).toBe(1)
    expect(renameCount).toBe(2)
    expect(f.deps.services.restart).not.toHaveBeenCalled()
    const message = f.effects.find((effect) => effect.startsWith('operator:Client directory activation failed;'))
    const retained = message?.match(/prior directory remains at (.+)\. The web service was not restarted\./)?.[1]
    expect(retained).toBeDefined()
    expect(fs.readFileSync(path.join(retained!, 'index.html'), 'utf8')).toBe('old client')
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true })
  }
})

it('missing isolated Cargo target configuration leaves no staging directory', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-runtime-stage-'))
  const paths = {
    ...dependencies().deps.paths,
    home: temp,
    cargoTargetDirectory: undefined,
  }
  const docker = { buildImage: vi.fn(async () => 'sha256:' + 'b'.repeat(64)), verifyDaemon: vi.fn(async () => undefined) }

  try {
    await expect(buildSelectedArtifacts(paths, owner, 'client', vi.fn(() => ''), docker)).rejects.toThrow(
      'An isolated Cargo target directory was not configured.',
    )
    const stageParent = path.join(temp, '.cache', 'freshell')
    expect(fs.existsSync(stageParent) ? fs.readdirSync(stageParent) : []).toEqual([])
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true })
  }
})

it('durable build omits web-only feature', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-runtime-durable-build-'))
  const paths = {
    ...dependencies().deps.paths,
    home: temp,
    cargoTargetDirectory: path.join(temp, 'cargo-target'),
  }
  const commands: Array<{ command: string; args: string[] }> = []
  const run = (command: string, args: string[]) => {
    commands.push({ command, args })
    if (command === paths.cargo) {
      const release = path.join(paths.cargoTargetDirectory!, 'release')
      fs.mkdirSync(release, { recursive: true })
      if (args.includes('freshell-supervisor')) {
        fs.writeFileSync(path.join(release, 'freshell-supervisor'), 'supervisor executable')
        fs.writeFileSync(path.join(release, 'freshell-session-host'), 'session host')
      }
      if (args.includes('freshell-runtime-client')) fs.writeFileSync(path.join(release, 'freshell-supervisor-admin'), 'admin cli')
    }
    return ''
  }
  const docker = { buildImage: vi.fn(async () => 'sha256:' + 'b'.repeat(64)), verifyDaemon: vi.fn(async () => undefined) }

  try {
    const artifacts = await buildSelectedArtifacts(paths, owner, 'durable-only', run, docker)
    const durableBuild = commands.find(({ command, args }) => command === paths.cargo && args.includes('freshell-supervisor'))

    expect(durableBuild?.args).toEqual([
      'build', '--release', '-p', 'freshell-supervisor', '-p', 'freshell-session-host', '--locked',
    ])
    expect(artifacts.supervisorExecutable).toBeDefined()
    await fs.promises.rm(artifacts.stagingRoot!, { recursive: true, force: true })
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true })
  }
})

it('artifact staging builds only the web or durable outputs selected by mode', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-runtime-artifacts-'))
  const paths = {
    ...dependencies().deps.paths,
    home: temp,
    cargoTargetDirectory: path.join(temp, 'cargo-target'),
  }
  const commands: Array<{ command: string; args: string[]; cwd?: string; target?: string }> = []
  const run = (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    commands.push({ command, args, cwd: options?.cwd, target: options?.env?.CARGO_TARGET_DIR })
    if (command === paths.pnpm) {
      const outIndex = args.indexOf('--outDir')
      const output = args[outIndex + 1]!
      fs.mkdirSync(output, { recursive: true })
      fs.writeFileSync(path.join(output, 'index.html'), 'client fixture')
    }
    if (command === paths.cargo) {
      const release = path.join(paths.cargoTargetDirectory!, 'release')
      fs.mkdirSync(release, { recursive: true })
      if (args.includes('freshell-server')) fs.writeFileSync(path.join(release, 'freshell-server'), 'web executable')
      if (args.includes('freshell-supervisor')) {
        fs.writeFileSync(path.join(release, 'freshell-supervisor'), 'supervisor executable')
        fs.writeFileSync(path.join(release, 'freshell-session-host'), 'session host')
      }
      if (args.includes('freshell-runtime-client')) fs.writeFileSync(path.join(release, 'freshell-supervisor-admin'), 'admin cli')
    }
    return ''
  }
  const docker = {
    buildImage: vi.fn(async () => 'sha256:' + 'b'.repeat(64)),
    verifyDaemon: vi.fn(async () => undefined),
  }
  const stagedRoots: string[] = []

  try {
    const clientArtifacts = await buildSelectedArtifacts(paths, owner, 'client', run, docker)
    stagedRoots.push(clientArtifacts.stagingRoot!)
    expect(clientArtifacts.webExecutable).toBeDefined()
    expect(clientArtifacts.clientDirectory).toBeDefined()
    expect(clientArtifacts.supervisorExecutable).toBeUndefined()
    expect(clientArtifacts.imageId).toBeUndefined()
    expect(commands.some(({ command }) => command === paths.pnpm)).toBe(true)
    expect(commands.some(({ command, args }) => command === paths.cargo && args.includes('freshell-server'))).toBe(true)
    expect(docker.buildImage).not.toHaveBeenCalled()

    commands.length = 0
    const durableArtifacts = await buildSelectedArtifacts(paths, owner, 'durable-only', run, docker)
    stagedRoots.push(durableArtifacts.stagingRoot!)
    expect(durableArtifacts.webExecutable).toBeUndefined()
    expect(durableArtifacts.clientDirectory).toBeUndefined()
    expect(durableArtifacts.supervisorExecutable).toBeDefined()
    expect(durableArtifacts.adminCli).toBeDefined()
    expect(durableArtifacts.sessionHostBinary).toBeDefined()
    expect(durableArtifacts.imageId).toBe('sha256:' + 'b'.repeat(64))
    expect(commands.some(({ command }) => command === paths.pnpm)).toBe(false)
    expect(commands.some(({ command, args }) => command === paths.cargo && args.includes('freshell-server'))).toBe(false)
    expect(commands.every(({ cwd, target }) => cwd === owner.checkoutRoot && target === paths.cargoTargetDirectory)).toBe(true)
    expect(docker.buildImage).toHaveBeenCalledWith(owner, owner.dockerSocket)
  } finally {
    for (const root of stagedRoots) await fs.promises.rm(root, { recursive: true, force: true })
    await fs.promises.rm(temp, { recursive: true, force: true })
  }
})

it('historical failed incarnations do not replace the active stop and reopen reference', async () => {
  const f = dependencies()
  const history = view({
    incarnationId: 'historical',
    launchState: 'failed',
    cleanupState: 'termination_unconfirmed',
    nativeSessionId: 'historical-native',
  })
  const active = view({
    incarnationId: 'current',
    launchState: 'running',
    nativeSessionId: 'current-native',
    terminalResumeSessionId: 'current-resume',
  })
  f.deps.admin.inventory = vi.fn(async () => [history, active])
  f.deps.admin.stop = vi.fn(async (soulId, expectedIntentRevision) => ({
    outcome: 'verified_empty' as const,
    view: view({
      soulId,
      incarnationId: active.incarnationId,
      intentRevision: expectedIntentRevision + 1,
      desiredState: 'stopped',
      launchState: 'stopped',
      cleanupState: 'verified_empty',
    }),
  }))

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(0)
  expect(f.deps.admin.stop).toHaveBeenCalledWith('soul-codex', 12, owner)
  expect(f.deps.admin.reopen).toHaveBeenCalledWith(expect.objectContaining({
    conversation: { kind: 'terminal', nativeSessionId: 'current-native', resumeSessionId: 'current-resume' },
    expectedIntentRevision: 13,
  }), owner)
})

it('Reopen candidate uses the captured addressed view and post-Stop revision', () => {
  const historical = view({
    incarnationId: 'historical',
    launchState: 'failed',
    cleanupState: 'termination_unconfirmed',
    nativeSessionId: 'historical-native',
  })
  const addressed = view({
    incarnationId: 'current',
    launchState: 'running',
    nativeSessionId: 'current-native',
    terminalResumeSessionId: 'current-resume',
  })
  const targets = [{
    soulId: addressed.soulId,
    expectedIntentRevision: addressed.intentRevision,
    provider: addressed.provider!,
    addressedView: addressed,
  }]

  const work = buildReopenCandidates([historical, addressed], targets, new Map([[addressed.soulId, 13]]))

  expect(work.candidates).toEqual([{
    soulId: addressed.soulId,
    expectedIntentRevision: 13,
    provider: 'codex',
    conversation: { kind: 'terminal', nativeSessionId: 'current-native', resumeSessionId: 'current-resume' },
  }])
  expect(work.noReferenceCount).toBe(0)
  expect(work.ineligibleReferenceCount).toBe(0)
})

it('fresh-agent session references remain saved conversation candidates', () => {
  const addressed = view({
    provider: 'amplifier',
    nativeSessionId: null,
    terminalResumeSessionId: null,
    freshAgentSessionId: 'saved-fresh-agent-session',
  })
  const target = {
    soulId: addressed.soulId,
    expectedIntentRevision: addressed.intentRevision,
    provider: 'amplifier',
    addressedView: addressed,
  }

  const work = buildReopenCandidates([addressed], [target], new Map([[addressed.soulId, 13]]))

  expect(work.candidates).toEqual([{
    soulId: addressed.soulId,
    expectedIntentRevision: 13,
    provider: 'amplifier',
    conversation: { kind: 'fresh_agent', sessionId: 'saved-fresh-agent-session' },
  }])
  expect(work.unavailable).toEqual([])
})

it('inventory failure restores web ingress without stopping the supervisor', async () => {
  const f = dependencies()
  f.deps.admin.inventory = vi.fn(async () => {
    f.effects.push('inventory')
    throw new Error('supervisor control socket unavailable')
  })

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(1)
  expect(f.effects.indexOf('stop:freshell-rust.service')).toBeLessThan(f.effects.indexOf('inventory'))
  expect(f.effects.indexOf('start:freshell-rust.service')).toBeGreaterThan(f.effects.indexOf('inventory'))
  expect(f.deps.services.start).toHaveBeenCalledWith(owner.webUnit)
  expect(f.deps.services.stop).not.toHaveBeenCalledWith(owner.supervisorUnit)
  expect(f.deps.admin.stop).not.toHaveBeenCalled()
  expect(f.effects.some((effect) => effect.includes('supervisor control socket unavailable'))).toBe(true)
})

it('desired-stopped cleanup checks the addressed incarnation and restores web before any new stop', async () => {
  const f = dependencies()
  const addressed = view({
    soulId: 'soul-already-stopped',
    incarnationId: 'incarnation-current',
    desiredState: 'stopped',
    launchState: 'stopping',
    cleanupState: 'termination_unconfirmed',
    provider: 'codex',
    nativeSessionId: null,
    terminalResumeSessionId: null,
  })
  const historical = view({
    soulId: 'soul-already-stopped',
    incarnationId: 'incarnation-historical',
    desiredState: 'stopped',
    launchState: 'stopped',
    cleanupState: 'verified_empty',
    nativeSessionId: null,
    terminalResumeSessionId: null,
  })
  f.deps.admin.inventory = vi.fn(async () => [historical, addressed])

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(1)
  expect(f.deps.admin.stop).not.toHaveBeenCalled()
  expect(f.deps.services.start).toHaveBeenCalledWith(owner.webUnit)
  expect(f.deps.services.stop).not.toHaveBeenCalledWith(owner.supervisorUnit)
})

it('inventory uses staged read-only registry snapshot for missing souls', async () => {
  const f = dependencies()
  f.deps.admin.inventory = vi.fn(async () => {
    f.effects.push('live-inventory')
    return []
  })
  f.deps.admin.maintenanceInventory = vi.fn(async (_supervisorExecutable, _databasePath) => {
    f.effects.push('candidate-maintenance-inventory')
    return []
  })

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(0)
  expect(f.deps.admin.inventory).toHaveBeenCalledTimes(1)
  expect(f.deps.admin.maintenanceInventory).toHaveBeenCalledWith('/tmp/stage/freshell-supervisor', owner.databasePath)
  expect(f.effects.indexOf('stop:freshell-rust.service')).toBeLessThan(f.effects.indexOf('live-inventory'))
  expect(f.effects.indexOf('live-inventory')).toBeLessThan(f.effects.indexOf('candidate-maintenance-inventory'))
  expect(f.effects.indexOf('candidate-maintenance-inventory')).toBeLessThan(f.effects.indexOf('stop:freshell-supervisor.service'))
  expect(f.deps.admin.stop).not.toHaveBeenCalled()
})

it('candidate no-runtime snapshot conflicts with live inventory before Stops', async () => {
  const f = dependencies()
  f.deps.admin.inventory = vi.fn(async () => [view({ intentRevision: 12, incarnationId: 'live-incarnation' })])
  f.deps.admin.maintenanceInventory = vi.fn(async () => [{
    soulId: 'soul-codex', desiredState: 'stopped', intentRevision: 99, outcome: 'verified_empty' as const,
  }])

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(1)
  expect(f.deps.admin.stop).not.toHaveBeenCalled()
  expect(f.deps.services.stop).not.toHaveBeenCalledWith(owner.supervisorUnit)
  expect(f.deps.services.start).toHaveBeenCalledWith(owner.webUnit)
})

it('failed supervisor stop reports partial shutdown and forward recovery', async () => {
  const f = dependencies()
  f.deps.admin.inventory = vi.fn(async () => [])
  f.deps.services.stop = vi.fn(async (unit) => {
    f.effects.push(`stop:${unit}`)
    if (unit === owner.supervisorUnit) throw new Error('systemd stop failed after shutdown began')
  })
  f.deps.services.state = vi.fn(async (unit) => unit === owner.supervisorUnit ? 'failed' : 'inactive')

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(1)
  expect(f.deps.services.stop).toHaveBeenCalledWith(owner.supervisorUnit)
  expect(f.deps.services.state).toHaveBeenCalledWith(owner.supervisorUnit)
  expect(f.deps.services.start).not.toHaveBeenCalledWith(owner.webUnit)
  expect(f.events).toContainEqual(expect.objectContaining({
    event: 'update.supervisor_stop_failed',
    phase: 'stop_supervisor',
    unit_state: 'failed',
    partial_state: true,
    manual_recovery: expect.stringContaining('forward-recovery runbook'),
  }))
  expect(f.events).toContainEqual(expect.objectContaining({
    event: 'update.failed',
    phase: 'stop_supervisor',
    manual_recovery: expect.stringContaining('forward-recovery runbook'),
  }))
  expect(f.effects.some((effect) => effect.includes('forward-recovery runbook'))).toBe(true)
})

it('an explicit no-runtime VerifiedEmpty record permits reset with no coding targets', async () => {
  const f = dependencies()
  f.deps.admin.inventory = vi.fn(async () => [])
  f.deps.admin.maintenanceInventory = vi.fn(async () => [{
    soulId: 'soul-no-runtime', desiredState: 'stopped', intentRevision: 2, outcome: 'verified_empty' as const,
  }])

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(0)
  expect(f.deps.admin.stop).not.toHaveBeenCalled()
  expect(f.deps.admin.reopen).not.toHaveBeenCalled()
  expect(f.deps.services.stop).toHaveBeenCalledWith(owner.supervisorUnit)
})

it('an unresolved no-runtime stopped soul refuses before new Stops and restores web', async () => {
  const f = dependencies()
  f.deps.admin.inventory = vi.fn(async () => [])
  f.deps.admin.maintenanceInventory = vi.fn(async () => [{
    soulId: 'soul-unresolved', desiredState: 'stopped', intentRevision: 3, outcome: 'unresolved' as const,
  }])

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(1)
  expect(f.deps.admin.stop).not.toHaveBeenCalled()
  expect(f.deps.services.start).toHaveBeenCalledWith(owner.webUnit)
  expect(f.deps.services.stop).not.toHaveBeenCalledWith(owner.supervisorUnit)
})

it('web restoration failure reports the original error and the resulting unit state', async () => {
  const f = dependencies()
  f.deps.admin.inventory = vi.fn(async () => { throw new Error('inventory read failed') })
  f.deps.services.start = vi.fn(async (unit) => {
    f.effects.push(`start:${unit}`)
    if (unit === owner.webUnit) throw new Error('web start failed')
  })

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(1)
  expect(f.events).toContainEqual(expect.objectContaining({
    event: 'update.web_restore_after_abort',
    restored: false,
    unit_state: 'inactive',
    restoration_error_code: 'web_restore_failed',
  }))
  expect(f.events).toContainEqual(expect.objectContaining({ event: 'update.failed', phase: 'inventory' }))
  expect(f.effects).toContain('operator:inventory read failed')
})

it('web restoration requires healthy supervisor control socket', async () => {
  const f = dependencies()
  f.deps.admin.inventory = vi.fn(async () => { throw new Error('inventory socket failed') })
  let healthCount = 0
  f.deps.admin.health = vi.fn(async () => {
    healthCount += 1
    if (healthCount > 6) throw new Error('supervisor control socket failed')
    return { state: 'ok' as const, installationId: 'installation-1', controlEpoch: 7 }
  })

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(1)
  expect(f.deps.services.isActive).toHaveBeenCalledWith(owner.supervisorUnit)
  expect(f.deps.admin.health).toHaveBeenCalledTimes(7)
  expect(f.deps.services.start).not.toHaveBeenCalledWith(owner.webUnit)
  expect(f.events).toContainEqual(expect.objectContaining({
    event: 'update.web_restore_after_abort',
    restored: false,
    unit_state: 'supervisor-not-healthy',
    restoration_error_code: 'supervisor_not_healthy',
  }))
})

it('pending Reopen does not prevent later saved conversations from being attempted', async () => {
  const f = dependencies()
  f.deps.admin.inventory = vi.fn(async () => [
    view({ soulId: 'soul-first', nativeSessionId: 'native-first' }),
    view({ soulId: 'soul-second', provider: 'claude', nativeSessionId: 'native-second' }),
  ])
  f.deps.admin.stop = vi.fn(async (soulId, expectedIntentRevision) => ({
    outcome: 'verified_empty' as const,
    view: view({
      soulId,
      intentRevision: expectedIntentRevision + 1,
      desiredState: 'stopped',
      launchState: 'stopped',
      cleanupState: 'verified_empty',
    }),
  }))
  f.deps.admin.reopen = vi.fn(async (candidate) => {
    f.effects.push(`reopen:${candidate.soulId}`)
    return { outcome: candidate.soulId === 'soul-first' ? 'pending' as const : 'reopened' as const }
  })

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(1)
  expect(f.deps.admin.reopen).toHaveBeenCalledTimes(2)
  expect(f.effects.indexOf('reopen:soul-first')).toBeLessThan(f.effects.indexOf('reopen:soul-second'))
  expect(f.events).toContainEqual(expect.objectContaining({ event: 'update.completed_with_reopen_failures' }))
})

it('post-supervisor-stop failure reports partial state and forward recovery without rollback', async () => {
  const f = dependencies()
  f.deps.filesystem.installExecutable = vi.fn(async (_source, target) => {
    f.effects.push(`install:${target}`)
    if (target === owner.supervisorExecutable) throw new Error('updated supervisor install failed')
  })

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(1)
  expect(f.effects).toContain('stop:freshell-supervisor.service')
  expect(f.deps.services.start).not.toHaveBeenCalledWith(owner.webUnit)
  expect(f.deps.services.start).not.toHaveBeenCalledWith(owner.supervisorUnit)
  expect(f.events).toContainEqual(expect.objectContaining({
    event: 'update.failed',
    phase: 'install_durable',
    manual_recovery: expect.any(String),
  }))
  expect(f.effects).toContain('operator:updated supervisor install failed')
  expect(f.effects.some((effect) => effect.includes('forward-recovery runbook'))).toBe(true)
})

it('a resumable terminal context without native identity is unavailable without Reopen dispatch', async () => {
  const f = dependencies()
  f.deps.admin.inventory = vi.fn(async () => [view({ nativeSessionId: null, terminalResumeSessionId: 'resume-only' })])

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(1)
  expect(f.deps.admin.reopen).not.toHaveBeenCalled()
  expect(f.events).toContainEqual(expect.objectContaining({
    event: 'update.reopen_inventory_summary',
    unavailable_count: 1,
    eligible_count: 0,
  }))
})

it('unavailable reopen emits safe per-soul result', async () => {
  const f = dependencies()
  f.deps.admin.inventory = vi.fn(async () => [view({
    soulId: 'soul-unavailable',
    nativeSessionId: null,
    terminalResumeSessionId: 'private-resume-session-id',
  })])

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(1)
  expect(f.deps.admin.reopen).not.toHaveBeenCalled()
  expect(f.events).toContainEqual(expect.objectContaining({
    event: 'update.reopen_result',
    phase: 'reopen',
    soul_id: 'soul-unavailable',
    provider: 'codex',
    outcome: 'unavailable',
    reason: 'missing_native_session_identity',
  }))
  expect(JSON.stringify(f.events)).not.toContain('private-resume-session-id')
})

it('reset summary counts absent and ineligible saved conversation references', async () => {
  const f = dependencies()
  f.deps.admin.inventory = vi.fn(async () => [
    view({ soulId: 'soul-no-reference', nativeSessionId: null, terminalResumeSessionId: null }),
    view({
      soulId: 'soul-already-stopped',
      desiredState: 'stopped',
      launchState: 'stopped',
      cleanupState: 'verified_empty',
      nativeSessionId: 'stopped-native',
    }),
  ])
  f.deps.admin.stop = vi.fn(async (soulId, expectedIntentRevision) => ({
    outcome: 'verified_empty' as const,
    view: view({
      soulId,
      intentRevision: expectedIntentRevision + 1,
      desiredState: 'stopped',
      launchState: 'stopped',
      cleanupState: 'verified_empty',
    }),
  }))

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(0)
  expect(f.deps.admin.reopen).not.toHaveBeenCalled()
  expect(f.events).toContainEqual(expect.objectContaining({
    event: 'update.reopen_inventory_summary',
    no_reference_count: 1,
    ineligible_reference_count: 1,
    unavailable_count: 0,
    eligible_count: 0,
  }))
})

it('host-managed panes refuse before mutation and are reported', async () => {
  const f = dependencies()
  f.runtimeApi.respond('GET', '/api/runtime/readiness', {
    status: 200,
    body: readinessReport({
      paneOwnership: {
        panes: [{ clientId: 'client-safe-1', tabId: 'tab-safe-1', paneId: 'pane-host-safe-1', kind: 'fresh-agent', ownership: 'host-managed' }],
        readyToStop: false,
      },
    }),
  })

  const result = await runManagedRuntimeWorker('client', f.deps)

  expect(result).toBe(2)
  expect(f.effects).not.toContain('resource-manifest')
  expect(f.effects).not.toContain('build:client')
  expect(f.effects.some((effect) => effect.startsWith('install:'))).toBe(false)
  expect(f.effects.some((effect) => effect.startsWith('restart:') || effect.startsWith('stop:') || effect.startsWith('start:'))).toBe(false)
  expect(f.effects.some((effect) => effect.includes('pane-host-safe-1') && effect.includes('host-managed'))).toBe(true)
})

it('unknown pane ownership refuses before mutation', async () => {
  const f = dependencies()
  f.runtimeApi.respond('GET', '/api/runtime/readiness', {
    status: 200,
    body: readinessReport({
      paneOwnership: {
        panes: [{ clientId: 'client-safe-2', tabId: 'tab-safe-2', paneId: 'pane-unknown-safe-2', kind: 'terminal', ownership: 'unknown' }],
        readyToStop: false,
      },
    }),
  })

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(2)
  expect(f.effects).not.toContain('resource-manifest')
  expect(f.effects).not.toContain('build:all')
  expect(f.effects.some((effect) => effect.startsWith('install:'))).toBe(false)
  expect(f.effects.some((effect) => effect.startsWith('stop:') || effect.startsWith('start:'))).toBe(false)
  expect(f.effects.some((effect) => effect.includes('pane-unknown-safe-2') && effect.includes('unknown'))).toBe(true)
})

it('legacy featureless server refuses before mutation', async () => {
  const f = dependencies()
  f.runtimeApi.respond('GET', '/api/runtime/readiness', { status: 404, body: {} })

  const result = await runManagedRuntimeWorker('client', f.deps)

  expect(result).toBe(2)
  expect(f.effects).not.toContain('resource-manifest')
  expect(f.effects).not.toContain('build:client')
  expect(f.effects.some((effect) => effect.startsWith('install:') || effect.startsWith('restart:'))).toBe(false)
})

it('initial readiness requires a complete report and finished unblocked scan', async () => {
  const f = dependencies()
  f.runtimeApi.respond('GET', '/api/runtime/readiness', {
    status: 200,
    body: readinessReport({
      readiness: { initialScanState: 'pending', blockedSubsystems: ['fixture-provider'] },
      paneOwnership: { complete: false },
    }),
  })

  const result = await runManagedRuntimeWorker('client', f.deps)

  expect(result).toBe(2)
  expect(f.effects).not.toContain('resource-manifest')
  expect(f.effects).not.toContain('build:client')
  expect(f.effects.some((effect) => effect.startsWith('stop:') || effect.startsWith('start:'))).toBe(false)
})

it('authenticated readiness identity brackets intended supervisor', async () => {
  const f = dependencies()

  const result = await runManagedRuntimeWorker('client', f.deps)

  expect(result).toBe(0)
  const reads = f.runtimeApi.calls.filter((call) => call.method === 'GET' && call.endpoint === '/api/runtime/readiness')
  expect(reads).toHaveLength(2)
  expect(reads.every((call) => call.token === 'test-auth-token-not-for-output')).toBe(true)
  for (const call of reads) {
    const index = f.effects.indexOf(`runtime:${call.method}:${call.endpoint}`)
    expect(f.effects[index - 1]).toBe('health')
    expect(f.effects[index + 1]).toBe('health')
  }
  expect(f.effects.indexOf('runtime:GET:/api/runtime/readiness')).toBeLessThan(f.effects.indexOf('resource-manifest'))
})

it('quiesced final inventory catches create during build and releases on refusal', async () => {
  const f = dependencies()
  f.runtimeApi.respond('POST', '/api/runtime/maintenance/quiesce', (body) => {
    const ownerId = (body as { ownerId: string }).ownerId
    return {
      status: 200,
      body: {
        drained: true,
        readyToStop: false,
        lease: { ownerId, leaseId: 'fixture-lease', expiresInMs: 30_000 },
        admission: { phase: 'quiesced', activePermits: 0 },
        readiness: readinessReport({
          paneOwnership: {
            panes: [{ clientId: 'client-safe-3', tabId: 'tab-safe-3', paneId: 'pane-created-in-build', kind: 'fresh-agent', ownership: 'host-managed' }],
            readyToStop: false,
          },
        }),
      },
    }
  })

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(2)
  expect(f.effects.indexOf('build:all')).toBeLessThan(f.effects.indexOf('runtime:POST:/api/runtime/maintenance/quiesce'))
  expect(f.runtimeApi.calls.some((call) => call.endpoint === '/api/runtime/maintenance/release')).toBe(true)
  expect(f.effects).not.toContain('stop:freshell-rust.service')
  expect(f.effects).not.toContain(`install:${owner.webExecutable}`)
  expect(f.effects.some((effect) => effect.includes('pane-created-in-build') && effect.includes('host-managed'))).toBe(true)
})

it('updater never stops web without a live quiesce lease', async () => {
  const f = dependencies()
  f.runtimeApi.respond('POST', '/api/runtime/maintenance/quiesce', {
    status: 200,
    body: { drained: true, readyToStop: true, admission: { phase: 'quiesced', activePermits: 0 }, readiness: readinessReport() },
  })

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(2)
  expect(f.effects).not.toContain('stop:freshell-rust.service')
  expect(f.effects).not.toContain('stop:freshell-supervisor.service')
  expect(f.effects).not.toContain('start:freshell-rust.service')
})

it('quiesce drain timeout releases the returned lease and never stops web', async () => {
  const f = dependencies()
  f.runtimeApi.respond('POST', '/api/runtime/maintenance/quiesce', (body) => {
    const ownerId = (body as { ownerId: string }).ownerId
    return {
      status: 503,
      body: {
        drained: false,
        readyToStop: false,
        lease: { ownerId, leaseId: 'fixture-drain-timeout-lease', expiresInMs: 30_000 },
        admission: { phase: 'quiesced', activePermits: 1 },
      },
    }
  })

  const result = await runManagedRuntimeWorker('client', f.deps)

  expect(result).toBe(2)
  expect(f.runtimeApi.calls.some((call) => call.endpoint === '/api/runtime/maintenance/release'
    && (call.body as { leaseId?: string })?.leaseId === 'fixture-drain-timeout-lease')).toBe(true)
  expect(f.effects.some((effect) => effect.startsWith('stop:') || effect.startsWith('restart:'))).toBe(false)
})

it('commit-stop blocker releases the temporary lease before refusing', async () => {
  const f = dependencies()
  f.runtimeApi.respond('POST', '/api/runtime/maintenance/commit-stop', () => ({
    status: 409,
    body: {
      readyToStop: false,
      readiness: readinessReport({
        paneOwnership: {
          unattachedProcesses: [{ kind: 'fresh-agent', source: 'host-registry', provider: 'claude', terminalId: 'terminal-safe-commit', ownership: 'unknown', reason: 'unattached' }],
          readyToStop: false,
        },
      }),
    },
  }))

  const result = await runManagedRuntimeWorker('client', f.deps)

  expect(result).toBe(2)
  expect(f.runtimeApi.calls.some((call) => call.endpoint === '/api/runtime/maintenance/release')).toBe(true)
  expect(f.effects.some((effect) => effect.startsWith('stop:') || effect.startsWith('restart:'))).toBe(false)
  expect(f.effects.some((effect) => effect.includes('terminal-safe-commit') && effect.includes('unknown'))).toBe(true)
})

it('quiesce identity must match direct supervisor health before web can stop', async () => {
  const f = dependencies()
  let healthCount = 0
  f.deps.admin.health = vi.fn(async () => {
    healthCount += 1
    f.effects.push('health')
    return { state: 'ok' as const, installationId: 'installation-1', controlEpoch: healthCount === 4 ? 9 : 7 }
  })

  const result = await runManagedRuntimeWorker('client', f.deps)

  expect(result).toBe(2)
  expect(f.runtimeApi.calls.some((call) => call.endpoint === '/api/runtime/maintenance/release')).toBe(true)
  expect(f.effects.some((effect) => effect.startsWith('stop:') || effect.startsWith('restart:'))).toBe(false)
})

it('commit-stop precedes web stop and candidate installation', async () => {
  const f = dependencies()

  const result = await runManagedRuntimeWorker('client', f.deps)

  expect(result).toBe(0)
  const commit = f.effects.indexOf('runtime:POST:/api/runtime/maintenance/commit-stop')
  const stop = f.effects.indexOf('stop:freshell-rust.service')
  const install = f.effects.indexOf(`install:${owner.webExecutable}`)
  expect(commit).toBeGreaterThanOrEqual(0)
  expect(commit).toBeLessThan(stop)
  expect(stop).toBeLessThan(install)
})

it('unattached process census refuses before build and reports safe identifiers', async () => {
  const f = dependencies()
  f.runtimeApi.respond('GET', '/api/runtime/readiness', {
    status: 200,
    body: readinessReport({
      paneOwnership: {
        unattachedProcesses: [{ kind: 'terminal', source: 'host-registry', provider: 'codex', terminalId: 'terminal-safe-unattached', ownership: 'unknown', reason: 'unattached' }],
        readyToStop: false,
      },
    }),
  })

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(2)
  expect(f.effects).not.toContain('build:all')
  expect(f.effects.some((effect) => effect.includes('terminal-safe-unattached') && effect.includes('unknown'))).toBe(true)
})

it('shutdown committed gate cannot reopen while old server is alive', async () => {
  const f = dependencies()
  f.deps.services.stop = vi.fn(async (unit) => {
    f.effects.push(`stop:${unit}`)
    if (unit === owner.webUnit) throw new Error('injected web stop failure')
  })

  const result = await runManagedRuntimeWorker('client', f.deps)

  expect(result).toBe(1)
  expect(f.runtimeApi.calls.some((call) => call.endpoint === '/api/runtime/maintenance/commit-stop')).toBe(true)
  expect(f.runtimeApi.calls.some((call) => call.endpoint === '/api/runtime/maintenance/release')).toBe(false)
  expect(f.events).toContainEqual(expect.objectContaining({ event: 'update.failed', manual_recovery: expect.any(String) }))
})

it('candidate without managed runtime is refused before install', async () => {
  const buildInfo = (fDeps: ManagedRuntimeUpdateDependencies) =>
    (fDeps.artifacts as ManagedRuntimeUpdateDependencies['artifacts'] & { serverBuildInfo: ReturnType<typeof vi.fn> }).serverBuildInfo
  const f = dependencies()
  buildInfo(f.deps).mockResolvedValue({ managedRuntimeV1: false })

  const result = await runManagedRuntimeWorker('client', f.deps)

  expect(result).toBe(2)
  expect(buildInfo(f.deps)).toHaveBeenCalledWith('/tmp/stage/freshell-server')
  expect(f.effects.some((effect) => effect.startsWith('install:') || effect.startsWith('restart:') || effect.startsWith('stop:'))).toBe(false)
})

it('durable-only probes the installed web binary before web stop', async () => {
  const f = dependencies()

  const result = await runManagedRuntimeWorker('durable-only', f.deps, '/run/user/1000/approval')

  expect(result).toBe(0)
  const probe = f.effects.indexOf(`build-info:${owner.webExecutable}`)
  const stop = f.effects.indexOf(`stop:${owner.webUnit}`)
  expect(probe).toBeGreaterThanOrEqual(0)
  expect(probe).toBeLessThan(stop)
  expect(f.deps.artifacts.serverBuildInfo).toHaveBeenCalledWith(owner.webExecutable)
})

it('missing candidate build-info command refuses before service effects', async () => {
  const f = dependencies()
  vi.mocked(f.deps.artifacts.serverBuildInfo).mockRejectedValue(new Error('spawn ENOENT'))

  const result = await runManagedRuntimeWorker('client', f.deps)

  expect(result).toBe(2)
  expect(f.effects.some((effect) => effect.startsWith('stop:') || effect.startsWith('start:') || effect.startsWith('restart:'))).toBe(false)
  expect(f.deps.services.stop).not.toHaveBeenCalled()
})

it('preflight refuses readiness whose supervisor identity changes across the bracket', async () => {
  const f = dependencies()
  let healthCount = 0
  f.deps.admin.health = vi.fn(async () => {
    healthCount += 1
    f.effects.push('health')
    return { state: 'ok' as const, installationId: 'installation-1', controlEpoch: healthCount === 1 ? 7 : 8 }
  })

  const result = await runManagedRuntimeWorker('client', f.deps)

  expect(result).toBe(2)
  expect(f.effects).not.toContain('resource-manifest')
  expect(f.effects).not.toContain('build:client')
  expect(f.effects.some((effect) => effect.startsWith('restart:') || effect.startsWith('stop:'))).toBe(false)
})

it('post-update scan must be complete and unblocked before success', async () => {
  const f = dependencies()
  let readCount = 0
  f.runtimeApi.respond('GET', '/api/runtime/readiness', () => {
    readCount += 1
    return {
      status: 200,
      body: readCount === 1
        ? readinessReport()
        : readinessReport({ readiness: { initialScanState: 'blocked', blockedSubsystems: ['fixture-provider'] } }),
    }
  })

  const result = await runManagedRuntimeWorker('client', f.deps)

  expect(result).toBe(1)
  expect(f.events).not.toContainEqual(expect.objectContaining({ event: 'update.completed' }))
})

it('web-only completion reports post-start host and unknown ownership while leaving it running', async () => {
  const f = dependencies()
  let readCount = 0
  f.runtimeApi.respond('GET', '/api/runtime/readiness', () => {
    readCount += 1
    return {
      status: 200,
      body: readCount === 1
        ? readinessReport()
        : readinessReport({
          paneOwnership: {
            panes: [{
              clientId: 'client/post-start', tabId: 'tab post-start', paneId: 'pane\npost-start', kind: 'fresh-agent',
              provider: 'claude', terminalId: 'terminal-post-start', sessionId: 'session:post-start', ownership: 'host-managed',
              path: '/private/provider/history', prompt: 'PRIVATE_PROMPT', message: 'PRIVATE_MESSAGE',
            }],
            unattachedProcesses: [{
              kind: 'terminal', source: 'private-source', provider: 'codex', terminalId: 'unknown/terminal',
              sessionId: 'unknown:session', ownership: 'unknown', reason: 'PRIVATE_REASON', path: '/private/runtime',
            }],
            readyToStop: false,
          },
        }),
    }
  })

  const result = await runManagedRuntimeWorker('client', f.deps)

  expect(result).toBe(0)
  const completion = f.events.find((event) => event.event === 'update.completed')
  expect(completion).toEqual(expect.objectContaining({
    post_start_ownership: {
      observed_after_replacement_startup: true,
      outside_durable_soul_ownership: true,
      remain_running: true,
      covered_by_prior_maintenance_lease: false,
      panes: [{
        client_id: 'client_post-start', tab_id: 'tab_post-start', pane_id: 'pane_post-start', kind: 'fresh-agent',
        provider: 'claude', terminal_id: 'terminal-post-start', session_id: 'session:post-start', ownership: 'host-managed',
      }],
      unattached_processes: [{
        kind: 'terminal', provider: 'codex', terminal_id: 'unknown_terminal', session_id: 'unknown:session', ownership: 'unknown',
      }],
    },
  }))
  const output = f.effects.filter((effect) => effect.startsWith('operator:')).join('\n')
  expect(output).toContain('observed after replacement startup')
  expect(output).toContain('outside durable-soul ownership')
  expect(output).toContain('remain running')
  expect(output).toContain('not covered by the prior maintenance lease')
  expect(output).toContain('client_post-start')
  expect(output).toContain('host-managed')
  expect(output).toContain('unknown_terminal')
  expect(output).not.toContain('PRIVATE_PROMPT')
  expect(output).not.toContain('PRIVATE_MESSAGE')
  expect(output).not.toContain('PRIVATE_REASON')
  expect(output).not.toContain('/private/')
  expect(output).not.toContain('test-auth-token-not-for-output')
  expect(JSON.stringify(completion)).not.toContain('PRIVATE_')
  expect(JSON.stringify(completion)).not.toContain('/private/')
  expect(JSON.stringify(completion)).not.toContain('test-auth-token-not-for-output')
  expect(f.deps.admin.stop).not.toHaveBeenCalled()
})

it('reset completion reports post-start host and unknown ownership while leaving it running', async () => {
  const f = dependencies()
  let readCount = 0
  f.runtimeApi.respond('GET', '/api/runtime/readiness', () => {
    readCount += 1
    return {
      status: 200,
      body: readCount === 1
        ? readinessReport()
        : readinessReport({
          paneOwnership: {
            panes: [{
              clientId: 'reset-client', tabId: 'reset-tab', paneId: 'reset-pane', kind: 'fresh-agent',
              provider: 'claude', terminalId: 'reset-terminal', ownership: 'host-managed',
            }],
            unattachedProcesses: [{ kind: 'terminal', source: 'host-registry', provider: 'codex', terminalId: 'reset-unknown-terminal', ownership: 'unknown', reason: 'unattached' }],
            readyToStop: false,
          },
        }),
    }
  })

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(0)
  const completion = f.events.find((event) => event.event === 'update.completed')
  expect(completion).toEqual(expect.objectContaining({
    post_start_ownership: expect.objectContaining({
      observed_after_replacement_startup: true,
      outside_durable_soul_ownership: true,
      remain_running: true,
      covered_by_prior_maintenance_lease: false,
      panes: [expect.objectContaining({ pane_id: 'reset-pane', ownership: 'host-managed' })],
      unattached_processes: [expect.objectContaining({ terminal_id: 'reset-unknown-terminal', ownership: 'unknown' })],
    }),
  }))
  const output = f.effects.filter((effect) => effect.startsWith('operator:')).join('\n')
  expect(output).toContain('reset-pane')
  expect(output).toContain('reset-unknown-terminal')
  expect(output).toContain('not covered by the prior maintenance lease')
  expect(f.deps.admin.stop).toHaveBeenCalledTimes(1)
  expect(f.deps.admin.stop).not.toHaveBeenCalledWith('reset-pane', expect.anything(), expect.anything())
})

it('default update refuses a changed supervisor identity after web restart', async () => {
  const f = dependencies()
  let healthCount = 0
  f.deps.admin.health = vi.fn(async () => {
    healthCount += 1
    f.effects.push('health')
    return {
      state: 'ok' as const,
      installationId: 'installation-1',
      controlEpoch: healthCount <= 6 ? 7 : 8,
    }
  })
  let readinessCount = 0
  f.runtimeApi.respond('GET', '/api/runtime/readiness', () => {
    readinessCount += 1
    return { status: 200, body: readinessReport({ controlEpoch: readinessCount === 1 ? 7 : 8 }) }
  })

  const result = await runManagedRuntimeWorker('client', f.deps)

  expect(result).toBe(1)
  expect(f.events).not.toContainEqual(expect.objectContaining({ event: 'update.completed' }))
})

it('reset update compares readiness with the deliberately restarted supervisor identity', async () => {
  const f = dependencies()
  let healthCount = 0
  f.deps.admin.health = vi.fn(async () => {
    healthCount += 1
    f.effects.push('health')
    return {
      state: 'ok' as const,
      installationId: 'installation-1',
      controlEpoch: healthCount <= 6 ? 7 : 8,
    }
  })
  let readinessCount = 0
  f.runtimeApi.respond('GET', '/api/runtime/readiness', () => {
    readinessCount += 1
    return { status: 200, body: readinessReport({ controlEpoch: readinessCount === 1 ? 7 : 8 }) }
  })
  f.runtimeApi.respond('POST', '/api/runtime/maintenance/quiesce', (body) => {
    const request = body as { ownerId: string }
    const report = readinessReport()
    return {
      status: 200,
      body: { drained: true, readyToStop: true, lease: { ownerId: request.ownerId, leaseId: 'fixture-lease', expiresInMs: 30_000 }, admission: { phase: 'quiesced', activePermits: 0 }, readiness: report },
    }
  })
  f.runtimeApi.respond('POST', '/api/runtime/maintenance/commit-stop', () => ({
    status: 200,
    body: { committed: true, readiness: readinessReport(), admission: { phase: 'shutdown-latched' } },
  }))

  const result = await runManagedRuntimeWorker('all', f.deps, '/run/user/1000/approval')

  expect(result).toBe(0)
  expect(f.events).toContainEqual(expect.objectContaining({ event: 'update.completed' }))
})

it('readiness token stays out of args, logs, events, and operator output', async () => {
  const f = dependencies()

  const result = await runManagedRuntimeWorker('client', f.deps)

  expect(result).toBe(0)
  const exposed = JSON.stringify({
    effects: f.effects,
    events: f.events,
    handoff: [
      vi.mocked(f.deps.handoff.submit).mock.calls,
      vi.mocked(f.deps.handoff.runLockedWorker).mock.calls,
    ],
  })
  expect(exposed).not.toContain('test-auth-token-not-for-output')
  expect(f.runtimeApi.calls.every((call) => call.token === 'test-auth-token-not-for-output')).toBe(true)
})
