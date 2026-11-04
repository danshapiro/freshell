// @vitest-environment node
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// No real daemon, filesystem fixture, socket, subprocess, or signal is used.
const control = vi.hoisted(() => ({ owner: undefined as any, probe: vi.fn(), exec: vi.fn(), read: vi.fn() }))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), execFileSync: control.exec,
}))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs') & { default: typeof import('node:fs') }>()
  return { ...actual, default: new Proxy(actual.default, {
    get(target, key, receiver) { return key === 'readFileSync' ? control.read : Reflect.get(target, key, receiver) },
  }) }
})
vi.mock('../../../../scripts/testing/runtime-sandbox.js', () => ({
  ManagedRuntimeOwner: class { constructor() { return control.owner } },
  dockerSocketPath: () => '/virtual/daemon.sock', newSoul: () => 'soul-owned',
}))
vi.mock('../../../../scripts/testing/codex-inflight-owned-probe.js', () => ({ checkInFlightOwnedProbe: control.probe }))
vi.mock('../../../helpers/provider-parity-broker.js', () => ({
  readProviderParitySource: vi.fn(async () => ({ daemonId: 'daemon-owned' })),
}))
import { runOwnedHeartbeatProbe } from '../../../../scripts/testing/codex-real-owned-heartbeat-probe.js'

const volume = `freshell-provider-${createHash('sha256').update('installation-owned\0soul-owned').digest('hex').slice(0, 24)}`
const containerId = 'a'.repeat(64)
const input = { repo: '/virtual/repo', daemonId: 'daemon-owned', socket: '/virtual/daemon.sock', dockerCli: '/virtual/docker' }

function fixture(existing: boolean) {
  let present = existing
  let launched = false
  const trace: Array<string | Record<string, unknown>> = []
  const receipt = { containerId, installationId: 'installation-owned', soulId: 'soul-owned', incarnationId: 'incarnation-owned',
    imageRef: 'image-owned', hostBinaryPath: '/virtual/host', providerVolumeName: volume }
  const runtime = {
    runId: 'run-owned', testRoot: '/virtual/test', buildDir: '/virtual/build', evidenceDir: '/virtual/evidence',
    imageRef: receipt.imageRef, testHostBinary: receipt.hostBinaryPath,
    prepare: vi.fn(async () => {}), startSupervisor: vi.fn(async () => ({ containerId: 'b'.repeat(64) })),
    adminOk: vi.fn(async (_supervisor, request) => {
      if (request.method === 'health') return { kind: 'health', data: { installation_id: receipt.installationId, control_epoch: 3 } }
      trace.push('launch')
      launched = true
      present = true
      return { kind: 'launch', data: { workerLaunchCount: 1, view: { soulId: receipt.soulId, containerId, incarnationId: receipt.incarnationId } } }
    }),
    launchBody: vi.fn(params => ({ method: 'launch', params })),
    isContainerRunning: vi.fn(() => true), runtimeDir: vi.fn(() => '/virtual/runtime'), waitForFile: vi.fn(async () => {}),
    broker: { receipts: vi.fn(() => launched ? [receipt] : []), receiptIds: vi.fn(() => new Set(launched ? [containerId] : [])),
      initialProviderVolumeCreations: vi.fn(() => []) },
  }
  control.owner = { runtime, stop: vi.fn(async () => { if (launched) present = false; return { ok: true, errors: [] } }) }
  control.exec.mockImplementation((_program, args) => {
    if (args[0] === 'info') return `${input.daemonId}\n`
    if (args[0] === 'volume' && args[1] === 'ls') {
      trace.push('volume_observed')
      return present ? `${volume}\n` : ''
    }
    throw new Error('unexpected controlled Docker operation')
  })
  control.read.mockImplementation(() => JSON.stringify({ ok: true, brokerSettlementComplete: true,
    verifiedResourcesAbsent: true, exactContainerIds: [containerId], volumes: [volume] }))
  control.probe.mockImplementation(async ({ owner }) => { await owner.stop() })
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
    trace.push(JSON.parse(String(chunk)))
    callback?.()
    return true
  }) as typeof process.stdout.write)
  return { runtime, trace, isPresent: () => present }
}

beforeEach(() => { vi.stubEnv('DOCKER_HOST', 'unix:///virtual/daemon.sock'); control.probe.mockReset() })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('refuses a pre-existing exact fixture volume before launch and leaves it untouched', async () => {
  const f = fixture(true)

  const failure = await runOwnedHeartbeatProbe(input).then(() => undefined, error => error)

  expect(failure).toBeInstanceOf(AggregateError)
  expect(f.runtime.launchBody).not.toHaveBeenCalled()
  expect(control.probe).not.toHaveBeenCalled()
  expect(control.owner.stop).toHaveBeenCalledOnce()
  expect(f.isPresent()).toBe(true)
})

it('hands off the exact absent volume identity before the launch can allocate it', async () => {
  const f = fixture(false)

  await runOwnedHeartbeatProbe(input)

  const handoff = f.trace.findIndex(item => typeof item !== 'string' && item.event === 'real_probe_driver.fixture_attempt'
    && item.daemonId === input.daemonId && item.runId === 'run-owned' && item.soulId === 'soul-owned' && item.providerVolume === volume)
  const absence = f.trace.indexOf('volume_observed')
  const launch = f.trace.indexOf('launch')
  expect(absence).toBeGreaterThanOrEqual(0)
  expect(handoff).toBeGreaterThan(absence)
  expect(launch).toBeGreaterThan(handoff)
  expect(f.isPresent()).toBe(false)
})
