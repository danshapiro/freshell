// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

// Every external operation is intercepted. These tests create no subprocesses,
// sockets, Docker resources, or fixture files.
const control = vi.hoisted(() => ({
  owner: undefined as any,
  probe: vi.fn(),
  exec: vi.fn(),
  read: vi.fn(),
}))

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: control.exec,
}))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs') & { default: typeof import('node:fs') }>()
  return { ...actual, default: new Proxy(actual.default, {
    get(target, key, receiver) {
      return key === 'readFileSync' ? control.read : Reflect.get(target, key, receiver)
    },
  }) }
})
vi.mock('../../../../scripts/testing/runtime-sandbox.js', () => ({
  ManagedRuntimeOwner: class { constructor() { return control.owner } },
  dockerSocketPath: () => '/virtual/daemon.sock',
  newSoul: () => 'soul-owned',
}))
vi.mock('../../../../scripts/testing/codex-inflight-owned-probe.js', () => ({
  checkInFlightOwnedProbe: control.probe,
}))
vi.mock('../../../helpers/provider-parity-broker.js', () => ({
  readProviderParitySource: vi.fn(async () => ({ daemonId: 'daemon-owned' })),
}))

import { runOwnedHeartbeatProbe } from '../../../../scripts/testing/codex-real-owned-heartbeat-probe.js'

const containerId = 'a'.repeat(64)
const supervisorId = 'b'.repeat(64)
const volume = `freshell-provider-${createHash('sha256').update('installation-owned\0soul-owned').digest('hex').slice(0, 24)}`
const input = { repo: '/virtual/repo', daemonId: 'daemon-owned', socket: '/virtual/daemon.sock', dockerCli: '/virtual/docker' }

function observeEvents(): string[] {
  const events: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
    events.push(String(chunk))
    callback?.()
    return true
  }) as typeof process.stdout.write)
  return events
}

beforeEach(() => {
  vi.stubEnv('DOCKER_HOST', 'unix:///virtual/daemon.sock')
  const receipt = { containerId, installationId: 'installation-owned', soulId: 'soul-owned', incarnationId: 'incarnation-owned',
    imageRef: 'image-owned', hostBinaryPath: '/virtual/host', providerVolumeName: volume }
  let volumePresent = false
  const runtime = {
    runId: 'run-owned', testRoot: '/virtual/test', buildDir: '/virtual/build', evidenceDir: '/virtual/evidence',
    imageRef: receipt.imageRef, testHostBinary: receipt.hostBinaryPath,
    prepare: vi.fn(async () => {}), startSupervisor: vi.fn(async () => ({ containerId: supervisorId })),
    adminOk: vi.fn(async (_supervisor, request) => {
      if (request.method === 'health') return { kind: 'health', data: { installation_id: receipt.installationId, control_epoch: 3 } }
      volumePresent = true
      return { kind: 'launch', data: { workerLaunchCount: 1, view: { soulId: receipt.soulId, containerId, incarnationId: receipt.incarnationId } } }
    }),
    launchBody: vi.fn(params => ({ method: 'launch', params })),
    isContainerRunning: vi.fn(() => true), runtimeDir: vi.fn(() => '/virtual/runtime'), waitForFile: vi.fn(async () => {}),
    broker: { receipts: vi.fn(() => [receipt]), receiptIds: vi.fn(() => new Set([containerId])),
      initialProviderVolumeCreations: vi.fn(() => []) },
  }
  control.owner = { runtime, stop: vi.fn(async () => { volumePresent = false; return { ok: true, errors: [] } }) }
  control.exec.mockImplementation((_program, args) => args[0] === 'info' ? `${input.daemonId}\n`
    : args[0] === 'volume' && args[1] === 'ls' && volumePresent ? `${volume}\n` : '')
  control.read.mockImplementation(() => JSON.stringify({ ok: true, brokerSettlementComplete: true,
    verifiedResourcesAbsent: true, exactContainerIds: [containerId], volumes: [volume] }))
  control.probe.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('runs the probe only after a real receipt and heartbeat are confirmed and joins the one owner stop', async () => {
  const events = observeEvents()
  control.probe.mockImplementation(async ({ owner }) => {
    expect(owner.runtime.waitForFile).toHaveBeenCalledOnce()
    expect(owner.runtime.broker.receipts).toHaveBeenCalled()
    await owner.stop()
  })

  await runOwnedHeartbeatProbe(input)

  expect(control.owner.runtime.prepare).toHaveBeenCalledOnce()
  expect(control.owner.runtime.startSupervisor).toHaveBeenCalledOnce()
  expect(control.owner.runtime.launchBody).toHaveBeenCalledWith(expect.objectContaining({ fixture: 'heartbeat', soulId: 'soul-owned', expectedControlEpoch: 3 }))
  expect(control.probe).toHaveBeenCalledWith({ owner: control.owner, containerId, owners: [], daemonId: input.daemonId,
    daemonSocket: input.socket, dockerCli: input.dockerCli })
  expect(control.owner.stop).toHaveBeenCalledOnce()
  expect(events.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ event: 'real_probe_driver.completed', passedCases: 1 }))
})

it('keeps the setup and owner cleanup failures separate without publishing their raw messages', async () => {
  const events = observeEvents()
  const setupError = new Error('PRIVATE_SETUP_SENTINEL')
  const stopError = new Error('PRIVATE_STOP_SENTINEL')
  control.owner.runtime.prepare.mockRejectedValue(setupError)
  control.owner.stop.mockRejectedValue(stopError)

  const failure = await runOwnedHeartbeatProbe(input).then(() => undefined, error => error)

  expect(failure).toBeInstanceOf(AggregateError)
  expect(failure.errors).toEqual([setupError, stopError])
  expect(control.owner.stop).toHaveBeenCalledOnce()
  expect(control.probe).not.toHaveBeenCalled()
  expect(events.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
    event: 'real_probe_driver.recovery_required', ownerStopped: null,
    failures: [{ phase: 'case', kind: 'operation' }, { phase: 'owner_stop', kind: 'operation' }],
  }))
  expect(events.join('')).not.toContain('PRIVATE_')
})

it('does not start the probe when the exact container has no broker receipt', async () => {
  const events = observeEvents()
  control.owner.runtime.broker.receipts.mockReturnValue([])

  const failure = await runOwnedHeartbeatProbe(input).then(() => undefined, error => error)

  expect(failure).toBeInstanceOf(AggregateError)
  expect(control.probe).not.toHaveBeenCalled()
  expect(control.owner.stop).toHaveBeenCalledOnce()
  expect(events.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
    event: 'real_probe_driver.recovery_required', containerId, providerVolume: volume, ownerStopped: true,
    failures: [{ phase: 'case', kind: 'assertion' }],
  }))
})

it('fails if the probe returns without starting its required owner stop', async () => {
  const events = observeEvents()
  control.probe.mockResolvedValue(undefined)

  const failure = await runOwnedHeartbeatProbe(input).then(() => undefined, error => error)

  expect(failure).toBeInstanceOf(AggregateError)
  expect(control.owner.stop).toHaveBeenCalledOnce()
  expect(events.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
    event: 'real_probe_driver.recovery_required', ownerStopped: true,
    failures: [{ phase: 'case', kind: 'assertion' }],
  }))
  expect(events.join('')).not.toContain('real_probe_driver.completed')
})

it('joins a stop already started by a failing probe instead of starting another', async () => {
  const events = observeEvents()
  let release!: (result: { ok: boolean; errors: string[] }) => void
  const stop = new Promise<{ ok: boolean; errors: string[] }>(resolve => { release = resolve })
  const stopSpy = control.owner.stop.mockReturnValue(stop)
  control.probe.mockImplementation(async ({ owner }) => { void owner.stop(); throw new Error('PRIVATE_PROBE_SENTINEL') })
  let completed = false
  const pending = runOwnedHeartbeatProbe(input).then(() => undefined, error => error).then(result => { completed = true; return result })
  for (let index = 0; index < 20; index++) await Promise.resolve()

  expect(stopSpy).toHaveBeenCalledOnce()
  expect(completed).toBe(false)
  release({ ok: true, errors: [] })
  expect(await pending).toBeInstanceOf(AggregateError)
  expect(stopSpy).toHaveBeenCalledOnce()
  expect(events.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
    event: 'real_probe_driver.recovery_required', stopCalls: 1, ownerStopped: true,
    failures: [{ phase: 'case', kind: 'operation' }],
  }))
  expect(events.join('')).not.toContain('PRIVATE_PROBE_SENTINEL')
})

it('fails if the receipt-owned volume remains after an apparently successful stop', async () => {
  const events = observeEvents()
  control.exec.mockImplementation((_program, args) => args[0] === 'info' ? `${input.daemonId}\n`
    : control.owner.runtime.launchBody.mock.calls.length ? `${volume}\n` : '')
  control.probe.mockImplementation(async ({ owner }) => { await owner.stop() })

  const failure = await runOwnedHeartbeatProbe(input).then(() => undefined, error => error)

  expect(failure).toBeInstanceOf(AggregateError)
  expect(control.owner.stop).toHaveBeenCalledOnce()
  expect(events.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
    event: 'real_probe_driver.recovery_required', providerVolume: volume, ownerStopped: true,
    failures: [{ phase: 'final_observation', kind: 'assertion' }],
  }))
})

it('does not treat a volume absent on a different daemon as successful cleanup', async () => {
  const events = observeEvents()
  let switched = false
  control.exec.mockImplementation((_program, args) => {
    if (args[0] === 'info') return `${switched ? 'different-daemon' : input.daemonId}\n`
    if (args[0] === 'volume' && args[1] === 'ls') return !control.owner.runtime.launchBody.mock.calls.length || switched ? '' : `${volume}\n`
    throw new Error('unexpected controlled Docker operation')
  })
  control.probe.mockImplementation(async ({ owner }) => { await owner.stop(); switched = true })

  const failure = await runOwnedHeartbeatProbe(input).then(() => undefined, error => error)

  expect(failure).toBeInstanceOf(AggregateError)
  expect(control.owner.stop).toHaveBeenCalledOnce()
  expect(events.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
    event: 'real_probe_driver.recovery_required', providerVolume: volume, ownerStopped: true,
    failures: [{ phase: 'final_observation', kind: 'assertion' }],
  }))
})

it('retains the owner when a different daemon is observed before setup-failure stop', async () => {
  const events = observeEvents()
  let switched = false
  control.exec.mockImplementation((_program, args) => {
    if (args[0] === 'info') return `${switched ? 'different-daemon' : input.daemonId}\n`
    throw new Error('unexpected controlled Docker operation')
  })
  control.owner.runtime.prepare.mockImplementation(async () => {
    switched = true
    throw new Error('PRIVATE_SETUP_SENTINEL')
  })

  const failure = await runOwnedHeartbeatProbe(input).then(() => undefined, error => error)

  expect(failure).toBeInstanceOf(AggregateError)
  expect(control.owner.stop).not.toHaveBeenCalled()
  expect(events.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
    event: 'real_probe_driver.recovery_required', ownerStopped: null, stopCalls: 0,
    failures: expect.arrayContaining([expect.objectContaining({ phase: 'owner_stop', kind: 'unsettled' })]),
  }))
  expect(events.join('')).not.toContain('PRIVATE_SETUP_SENTINEL')
})

it('records the unresolved heartbeat before waiting when the daemon changes just before probe stop', async () => {
  const events = observeEvents()
  const realStop = control.owner.stop
  let switched = false
  control.exec.mockImplementation((_program, args) => {
    if (args[0] === 'info') return `${switched ? 'different-daemon' : input.daemonId}\n`
    if (args[0] === 'volume' && args[1] === 'ls') return control.owner.runtime.launchBody.mock.calls.length ? `${volume}\n` : ''
    throw new Error('unexpected controlled Docker operation')
  })
  let release!: () => void
  const probeSettlement = new Promise<void>(resolve => { release = resolve })
  control.probe.mockImplementation(async ({ owner }) => {
    switched = true
    void owner.stop().catch(() => {})
    await probeSettlement
    throw new Error('PRIVATE_PROBE_SENTINEL')
  })

  const pending = runOwnedHeartbeatProbe(input).then(() => undefined, error => error)
  for (let index = 0; index < 30; index++) await Promise.resolve()
  const early = events.map(line => JSON.parse(line))
  const stopStarted = realStop.mock.calls.length > 0
  release()
  const failure = await pending

  expect(failure).toBeInstanceOf(AggregateError)
  expect(stopStarted).toBe(false)
  expect(realStop).not.toHaveBeenCalled()
  expect(early).toContainEqual(expect.objectContaining({
    event: 'real_probe_driver.recovery_required', containerId, providerVolume: volume,
    ownerStopped: null, stopCalls: 0,
    failures: expect.arrayContaining([expect.objectContaining({ phase: 'owner_stop', kind: 'unsettled' })]),
  }))
  expect(events.join('')).not.toContain('PRIVATE_PROBE_SENTINEL')
})

it('separately reports a failed owner result from a probe failure without publishing its errors', async () => {
  const events = observeEvents()
  control.owner.stop.mockResolvedValue({ ok: false, errors: ['PRIVATE_OWNER_RESULT_SENTINEL'] })
  control.probe.mockImplementation(async ({ owner }) => { await owner.stop(); throw new Error('PRIVATE_PROBE_SENTINEL') })

  const failure = await runOwnedHeartbeatProbe(input).then(() => undefined, error => error)

  expect(failure).toBeInstanceOf(AggregateError)
  expect(control.owner.stop).toHaveBeenCalledOnce()
  expect(events.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
    event: 'real_probe_driver.recovery_required', ownerStopped: false,
    failures: [{ phase: 'case', kind: 'operation' }, { phase: 'owner_stop', kind: 'reported_failure' }],
  }))
  expect(events.join('')).not.toContain('PRIVATE_')
})
