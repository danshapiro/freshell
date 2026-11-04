// @vitest-environment node
import { createHash } from 'node:crypto'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// These controls intercept only the draft harness's external operations.
// There are no Docker clients, subprocesses, sockets, or real fixture files.
const control = vi.hoisted(() => ({
  exec: vi.fn(),
  execAsync: vi.fn(),
  reads: new Map<string, unknown>(),
  stats: new Map<string, unknown>(),
  fsOverrides: new Map<string, Map<string, unknown>>(),
  syncOutput: undefined as undefined | ((data: string) => number),
  owner: undefined as unknown,
  cleanup: undefined as undefined | ((...args: unknown[]) => Promise<void>),
}))

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: control.execAsync, execFileSync: control.exec }
})

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs') & { default: typeof import('node:fs') }>()
  const fake = new Proxy(actual.default, {
    get(target, property, receiver) {
      if (property === 'writeSync') {
        return (fd: number, data: string | Uint8Array, offset?: number, length?: number) => {
          if (fd !== 1) return Reflect.apply(Reflect.get(target, property, receiver), target, [fd, data, offset, length])
          const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data).subarray(offset ?? 0, (offset ?? 0) + (length ?? data.length))
          if (control.syncOutput) return control.syncOutput(bytes.toString('utf8'))
          process.stdout.write(bytes.toString('utf8'))
          return bytes.length
        }
      }
      if (typeof property === 'string' && ['readFileSync', 'lstatSync', 'statSync', 'realpathSync', 'readdirSync', 'accessSync'].includes(property)) {
        return (...args: unknown[]) => {
          const overrides = property === 'readFileSync' ? control.reads
            : property === 'lstatSync' ? control.stats : control.fsOverrides.get(property)
          const key = String(args[0])
          if (overrides?.has(key)) {
            const value = overrides.get(key)
            if (value instanceof Error) throw value
            return value
          }
          return Reflect.apply(Reflect.get(target, property, receiver), target, args)
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })
  return { ...actual, default: fake }
})

vi.mock('../../../../scripts/testing/runtime-sandbox.js', () => ({
  ManagedRuntimeOwner: class {
    constructor() { return control.owner as this }
  },
}))

vi.mock('../../../helpers/codex-managed-cleanup.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../helpers/codex-managed-cleanup.js')>()
  return {
    ...actual,
    cleanupManagedCodexParity: (...args: Parameters<typeof actual.cleanupManagedCodexParity>) =>
      control.cleanup ? control.cleanup(...args) : actual.cleanupManagedCodexParity(...args),
  }
})

import { captureInitialProviderVolumes } from '../../../../scripts/testing/initial-provider-volume.js'
import { ownershipAndUnreserved, settle } from '../../../../scripts/testing/codex-real-volume-lifecycle.js'
import { checkInFlightOwnedProbe } from '../../../../scripts/testing/codex-inflight-owned-probe.js'
import { managedCodexCleanupDependencies } from '../../../helpers/codex-managed-cleanup.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function flushMicrotasks() {
  for (let i = 0; i < 16; i++) await Promise.resolve()
}

function appendLifecycle(lifecyclePath: string, event: string, data: unknown) {
  control.reads.set(lifecyclePath, `${control.reads.get(lifecyclePath) ?? ''}${JSON.stringify({ event, data })}\n`)
}

function nestedErrors(value: unknown, seen = new Set<unknown>()): unknown[] {
  if (value === null || value === undefined || seen.has(value)) return []
  seen.add(value)
  if (typeof value !== 'object') return [value]
  const error = value as { cause?: unknown; errors?: unknown[] }
  return [value, ...nestedErrors(error.cause, seen), ...(error.errors ?? []).flatMap(item => nestedErrors(item, seen))]
}

function volumeFixture() {
  const binary = Buffer.from('controlled fixture host binary')
  const owner = {
    installationId: 'controlled-installation', soulId: 'controlled-soul',
    providerVolumeName: `freshell-provider-${'a'.repeat(24)}`,
    imageRef: 'controlled-image', hostBinaryPath: '/virtual/task4-host',
    binarySha256: createHash('sha256').update(binary).digest('hex'), daemonId: 'controlled-daemon',
  }
  const labels = {
    'com.freshell.installation-id': owner.installationId,
    'com.freshell.soul-id': owner.soulId,
    'freshell.input.daemon': owner.daemonId,
    'freshell.input.image': owner.imageRef,
    'freshell.input.binary-sha256': owner.binarySha256,
    'freshell.input.intent': '1',
    'freshell.input.reservation': '00000000-0000-4000-8000-000000000001',
    'freshell.input.incarnation': 'controlled-incarnation',
  }
  const fixture = { owner, labels, attempted: true, captured: undefined as ReturnType<typeof captureInitialProviderVolumes> | undefined }
  const docker = { present: true, removals: 0 }
  control.reads.set(owner.hostBinaryPath, binary)
  control.stats.set(owner.hostBinaryPath, { size: binary.length, isFile: () => true, isSymbolicLink: () => false })
  return { fixture, docker }
}

function mockDocker(
  { fixture, docker }: ReturnType<typeof volumeFixture>,
  waitFor?: (args: string[], timeout: number) => void,
) {
  control.exec.mockImplementation((program: string, args: string[], options: { timeout: number }) => {
    if (program !== 'docker') throw new Error('unexpected subprocess')
    waitFor?.(args, options.timeout)
    if (args[0] === 'volume' && args[1] === 'ls') return docker.present ? `${fixture.owner.providerVolumeName}\n` : ''
    if (args[0] === 'volume' && args[1] === 'inspect') {
      return JSON.stringify({ Name: fixture.owner.providerVolumeName, Driver: 'local', Options: null, Labels: fixture.labels })
    }
    if (args[0] === 'info') return `${fixture.owner.daemonId}\n`
    if (args[0] === 'container' && args[1] === 'ls') return ''
    if (args[0] === 'volume' && args[1] === 'rm') {
      docker.removals++
      docker.present = false
      return `${fixture.owner.providerVolumeName}\n`
    }
    throw new Error('unexpected controlled Docker operation')
  })
}

function volumeState(fixture: ReturnType<typeof volumeFixture>['fixture'], stop: () => Promise<{ ok: boolean; errors: string[] }>) {
  return {
    rig: { stop, runtime: { writeIncident: vi.fn() } },
    fixtures: [fixture], attachments: [], stopped: false,
  } as unknown as Parameters<typeof settle>[0]
}

beforeEach(() => {
  control.exec.mockReset()
  control.execAsync.mockReset()
  control.reads.clear()
  control.stats.clear()
  control.fsOverrides.clear()
  control.syncOutput = undefined
  control.owner = undefined
  control.cleanup = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('retains the volume when a fresh ownership capture fails after an earlier capture', async () => {
  const f = volumeFixture()
  mockDocker(f)
  f.fixture.captured = captureInitialProviderVolumes([f.fixture.owner])
  expect(f.fixture.captured).toHaveLength(1)
  control.stats.set(f.fixture.owner.hostBinaryPath, new Error('controlled artifact became unavailable'))
  const stop = vi.fn(async () => ({ ok: true, errors: [] as string[] }))

  const failure = await settle(volumeState(f.fixture, stop), { expectedDaemonId: f.fixture.owner.daemonId }).then(() => undefined, error => error)

  expect(stop).toHaveBeenCalledOnce()
  expect(failure).toBeInstanceOf(Error)
  expect(f.docker.removals).toBe(0)
  expect(f.docker.present).toBe(true)
})

it.each(['before_capture', 'after_owner_stop'] as const)(
  'retains daemon A volume identity when the socket switches to daemon B %s', async switchAt => {
    const f = volumeFixture()
    let daemon = switchAt === 'before_capture' ? 'daemon-b' : f.fixture.owner.daemonId
    let removals = 0
    control.exec.mockImplementation((_program: string, args: string[]) => {
      if (args[0] === 'info') return `${daemon}\n`
      if (args[0] === 'volume' && args[1] === 'ls') return daemon === f.fixture.owner.daemonId ? `${f.fixture.owner.providerVolumeName}\n` : ''
      if (args[0] === 'volume' && args[1] === 'inspect') {
        return JSON.stringify({ Name: f.fixture.owner.providerVolumeName, Driver: 'local', Options: null, Labels: f.fixture.labels })
      }
      if (args[0] === 'container' && args[1] === 'ls') return ''
      if (args[0] === 'volume' && args[1] === 'rm') { removals++; f.docker.present = false; return f.fixture.owner.providerVolumeName }
      throw new Error('unexpected controlled Docker operation')
    })
    const output: string[] = []
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      output.push(String(chunk)); return true
    }) as typeof process.stdout.write)
    const stop = vi.fn(async () => {
      if (switchAt === 'after_owner_stop') daemon = 'daemon-b'
      return { ok: true, errors: [] as string[] }
    })
    let failure: unknown
    try { failure = await settle(volumeState(f.fixture, stop), { expectedDaemonId: f.fixture.owner.daemonId }).then(() => undefined, error => error) }
    finally { stdout.mockRestore() }

    const recovery = output.map(line => JSON.parse(line)).find(row => row.event === 'real_volume.recovery_required')
    expect(stop).toHaveBeenCalledTimes(switchAt === 'before_capture' ? 0 : 1)
    expect.soft(failure).toBeInstanceOf(Error)
    expect.soft(removals).toBe(0)
    expect.soft(f.docker.present).toBe(true)
    expect.soft(f.fixture.attempted).toBe(true)
    expect.soft(recovery).toMatchObject({ daemonId: f.fixture.owner.daemonId, volumes: [f.fixture.owner.providerVolumeName],
      ownerStopped: switchAt === 'after_owner_stop' })
  },
)

it('retains the volume when the daemon changes while final absence is being observed', async () => {
  const f = volumeFixture()
  let daemon = f.fixture.owner.daemonId
  control.exec.mockImplementation((_program: string, args: string[]) => {
    if (args[0] === 'info') return `${daemon}\n`
    if (args[0] === 'volume' && args[1] === 'ls') { daemon = 'daemon-b'; return '' }
    throw new Error('unexpected controlled Docker operation')
  })
  const state = volumeState(f.fixture, vi.fn())
  state.stopped = true
  const failure = await settle(state, { expectedDaemonId: f.fixture.owner.daemonId }).then(() => undefined, error => error)
  expect.soft(failure).toBeInstanceOf(Error)
  expect.soft(f.fixture.attempted).toBe(true)
  expect.soft(f.docker.present).toBe(true)
})

it('joins the in-flight probe after cleanup rejects and preserves both failures', async () => {
  const probe = deferred<void>()
  const original = new Error('controlled probe observation failed')
  const teardown = new Error('controlled cleanup failed')
  const cleanup = vi.fn(async () => { throw teardown })
  control.cleanup = cleanup
  const containerId = 'b'.repeat(64)
  const daemonId = 'controlled-daemon'
  const lifecyclePath = '/virtual/task4-lifecycle.jsonl'
  control.reads.set(lifecyclePath, '')
  control.reads.set(`/proc/self/task/${process.pid}/children`, original)
  control.exec.mockImplementation((_program: string, args: string[]) => {
    if (args[0] === 'info') return `${daemonId}\n`
    throw new Error('unexpected controlled Docker operation')
  })
  vi.stubEnv('DOCKER_HOST', 'unix:///virtual/task4-daemon.sock')
  const ownedProviderExec = vi.fn(() => probe.promise)
  const owner = {
    runtime: { lifecyclePath, broker: {
      receiptIds: () => new Set([containerId]),
      receipts: () => [{ containerId }],
    } },
    ownedProviderExec,
    stop: vi.fn(),
  }
  let settled = false
  const observed = checkInFlightOwnedProbe({ owner, containerId, owners: [], daemonId,
    daemonSocket: '/virtual/task4-daemon.sock', dockerCli: '/virtual/docker' } as unknown as Parameters<typeof checkInFlightOwnedProbe>[0])
    .then(() => { settled = true; return undefined }, error => { settled = true; return error })
  let settledBeforeProbe = false
  let failure: unknown
  try {
    await flushMicrotasks()
    expect(ownedProviderExec).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
    settledBeforeProbe = settled
  } finally {
    probe.resolve()
    failure = await observed
    await flushMicrotasks()
  }
  expect.soft(settledBeforeProbe).toBe(false)
  expect.soft(nestedErrors(failure)).toContain(original)
  expect.soft(nestedErrors(failure)).toContain(teardown)
})

it('preserves an unexpected deferred probe rejection with the observation and cleanup failures', async () => {
  const probe = deferred<void>()
  const observation = new Error('controlled observation failed')
  const teardown = new Error('controlled cleanup failed')
  const rejectedProbe = new Error('synthetic-probe-secret-marker')
  const cleanup = vi.fn(async () => { throw teardown })
  control.cleanup = cleanup
  const containerId = 'b'.repeat(64)
  const daemonId = 'controlled-daemon'
  const lifecyclePath = '/virtual/task4-lifecycle.jsonl'
  control.reads.set(lifecyclePath, '')
  control.reads.set(`/proc/self/task/${process.pid}/children`, observation)
  control.exec.mockImplementation((_program: string, args: string[]) => {
    if (args[0] === 'info') return `${daemonId}\n`
    throw new Error('unexpected controlled Docker operation')
  })
  vi.stubEnv('DOCKER_HOST', 'unix:///virtual/task4-daemon.sock')
  const owner = {
    runtime: { lifecyclePath, broker: { receiptIds: () => new Set([containerId]), receipts: () => [{ containerId }] } },
    ownedProviderExec: vi.fn(() => probe.promise), stop: vi.fn(),
  }
  const output: string[] = []
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    output.push(String(chunk)); return true
  }) as typeof process.stdout.write)
  let failure: unknown
  try {
    const pending = checkInFlightOwnedProbe({ owner, containerId, owners: [], daemonId,
      daemonSocket: '/virtual/task4-daemon.sock', dockerCli: '/virtual/docker' } as unknown as Parameters<typeof checkInFlightOwnedProbe>[0])
      .then(() => undefined, error => error)
    await flushMicrotasks()
    expect(cleanup).toHaveBeenCalledOnce()
    probe.reject(rejectedProbe)
    failure = await pending
  } finally { stdout.mockRestore() }
  expect.soft(nestedErrors(failure)).toEqual(expect.arrayContaining([observation, teardown, rejectedProbe]))
  expect.soft(output.join('')).not.toContain(rejectedProbe.message)
})

// Exercise the actual owner's tracking, capture wait, stop, and callback with
// an in-memory child and process observations. No subprocess or signal exists.
async function actualOwnerProbeInterleaving(
  independent: boolean, failedStage?: 'capture' | 'remove',
  fault?: 'signal_not_accepted' | 'different_probe_id' | 'signal_evidence_unavailable',
) {
  const { ManagedRuntimeOwner } = await vi.importActual<typeof import('../../../../scripts/testing/runtime-sandbox.js')>(
    '../../../../scripts/testing/runtime-sandbox.js')
  const containerId = 'b'.repeat(64)
  const daemonId = 'controlled-daemon'
  const cliPid = 21111
  const insidePid = 21112
  const fakeCli = '/virtual/docker'
  const capture = deferred<void>()
  const trace: string[] = []
  const output: EventRow[] = []
  const cause = Object.assign(new Error('synthetic-independent-probe-secret-marker'), { signal: 'SIGKILL' as const })
  const cleanupFailure = new Error(`synthetic-${failedStage}-secret-marker`)
  const stat = (pid: number) => `${pid} (task4) ${['S', ...Array(18).fill('0'), '1234'].join(' ')}`
  const gone = Object.assign(new Error('gone'), { code: 'ENOENT' })
  let callback: ((error: typeof cause, stdout: string, stderr: string) => void) | undefined
  let exited = false
  const child = {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((signal: NodeJS.Signals) => { trace.push(`owner-signal:${signal}`); return fault !== 'signal_not_accepted' }),
  }
  const exitProbe = () => {
    if (exited || !callback) return
    exited = true
    trace.push(independent ? 'independent-signal' : 'probe-exit')
    child.signalCode = 'SIGKILL'
    control.reads.set(`/proc/${cliPid}/stat`, gone)
    control.reads.set(`/proc/${insidePid}/stat`, gone)
    callback(cause, '', '')
  }
  setFsOverride('realpathSync', '/virtual/repo', '/virtual/repo')
  setFsOverride('realpathSync', `/proc/${cliPid}/exe`, fakeCli)
  setFsOverride('realpathSync', fakeCli, fakeCli)
  control.reads.set(`/proc/self/task/${process.pid}/children`, `${cliPid}`)
  control.reads.set(`/proc/${cliPid}/stat`, stat(cliPid))
  control.reads.set(`/proc/${insidePid}/stat`, stat(insidePid))
  vi.stubEnv('DOCKER_HOST', 'unix:///virtual/task4-daemon.sock')
  let nonce = ''
  control.exec.mockImplementation((program: string, args: string[]) => {
    if (program === 'git') return 'a'.repeat(40)
    if (args[0] === 'info') return `${daemonId}\n`
    if (args[0] === 'top') return `PID ARGS\n${insidePid} node ${nonce}\n`
    if (args[0] === 'container' && args[1] === 'ls') return ''
    throw new Error('unexpected controlled Docker operation')
  })
  control.execAsync.mockImplementation((_program: string, args: string[], _options: unknown, done: typeof callback) => {
    nonce = args[args.length - 1]
    control.reads.set(`/proc/${cliPid}/cmdline`, Buffer.from(`${[fakeCli, ...args].join('\0')}\0`))
    control.reads.set(`/proc/${insidePid}/cmdline`, Buffer.from(`node\0${nonce}\0`))
    callback = done
    return child
  })
  const owner = new ManagedRuntimeOwner(() => { throw new Error('unused web factory') }, '/virtual/repo')
  const lifecyclePath = owner.runtime.lifecyclePath
  control.reads.set(lifecyclePath, '')
  Object.defineProperty(owner.runtime, 'broker', { value: {
    receiptIds: () => new Set([containerId]), receipts: () => [{ containerId }],
  } })
  vi.spyOn(owner.runtime, 'recordLifecycle').mockImplementation((event, data) => {
    trace.push(event)
    if (event === 'external.provider_probe_signal_attempted' && fault === 'signal_evidence_unavailable') {
      throw new Error('synthetic-signal-evidence-secret-marker')
    }
    // Change only the signal receipt to model an unrelated probe's receipt.
    const recorded = event === 'external.provider_probe_signal_attempted' && fault === 'different_probe_id'
      ? { ...data as Record<string, unknown>, probeId: 'unrelated-probe' } : data
    appendLifecycle(lifecyclePath, event, recorded)
  })
  const runtimeCleanup = vi.spyOn(owner.runtime, 'cleanup').mockImplementation(async () => {
    trace.push('runtime-cleanup')
    return { ok: true, errors: [] }
  })
  vi.spyOn(owner.runtime, 'writeArtifact').mockReturnValue('/virtual/cleanup.json')
  vi.spyOn(managedCodexCleanupDependencies, 'captureVolumes').mockImplementation(() => {
    if (failedStage === 'capture') throw cleanupFailure
    return []
  })
  vi.spyOn(managedCodexCleanupDependencies, 'removeVolumes').mockImplementation(() => {
    if (failedStage === 'remove') throw cleanupFailure
    return []
  })
  const internals = owner as unknown as {
    trackNativeCapture(work: () => Promise<void>): Promise<void>
    stopWebAndReleaseHeldHosts(): Promise<void>
    providerProbes: Map<string, unknown>
  }
  const stopWeb = internals.stopWebAndReleaseHeldHosts.bind(owner)
  vi.spyOn(internals, 'stopWebAndReleaseHeldHosts').mockImplementation(async () => {
    trace.push('owner-signal-boundary')
    return stopWeb()
  })
  const stop = owner.stop.bind(owner)
  vi.spyOn(owner, 'stop').mockImplementation(() => { trace.push('owner-stop-start'); return stop() })
  const nativeCapture = internals.trackNativeCapture(() => capture.promise)
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    output.push(JSON.parse(String(chunk)) as EventRow); return true
  }) as typeof process.stdout.write)
  let finished = false
  const pending = checkInFlightOwnedProbe({ owner, containerId, owners: [], daemonId,
    daemonSocket: '/virtual/task4-daemon.sock', dockerCli: fakeCli })
    .then(() => undefined, error => error).then(result => { finished = true; return result })
  try {
    await flushMicrotasks()
    expect(output.some(row => row.event === 'real_probe.in_flight')).toBe(true)
    expect(trace).toContain('owner-stop-start')
    expect(trace).not.toContain('owner-signal-boundary')
    expect(internals.providerProbes.size).toBe(1)
    if (independent) {
      exitProbe()
      await flushMicrotasks()
      expect(trace).toContain('external.provider_probe_settled')
      expect(trace).not.toContain('owner-signal-boundary')
      expect(child.kill).not.toHaveBeenCalled()
      expect(internals.providerProbes.size).toBe(0)
    }
    capture.resolve()
    await nativeCapture
    await flushMicrotasks()
    expect(trace).toContain('owner-signal-boundary')
    if (!independent) {
      expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
      expect(runtimeCleanup).not.toHaveBeenCalled()
      expect(finished).toBe(false)
      exitProbe()
    }
    const failure = await pending
    expect(runtimeCleanup).toHaveBeenCalledOnce()
    expect(internals.providerProbes.size).toBe(0)
    if (!independent) {
      const rows = String(control.reads.get(lifecyclePath)).trim().split('\n').map(line => JSON.parse(line))
      const start = rows.find(row => row.event === 'external.provider_probe_started')
      const attempt = rows.find(row => row.event === 'external.provider_probe_signal_attempted')
      if (fault === 'signal_evidence_unavailable') {
        expect(attempt).toBeUndefined()
      } else {
        expect(attempt.data).toMatchObject({
          probeId: fault === 'different_probe_id' ? 'unrelated-probe' : start.data.probeId,
          signal: 'SIGKILL', sent: fault !== 'signal_not_accepted',
        })
      }
    }
    if (independent || fault) {
      if (independent) {
        expect.soft(trace.indexOf('independent-signal')).toBeLessThan(trace.indexOf('external.provider_probe_settled'))
        expect.soft(trace.indexOf('external.provider_probe_settled')).toBeLessThan(trace.indexOf('owner-signal-boundary'))
        expect.soft(child.kill).not.toHaveBeenCalled()
      }
      expect.soft(output.some(row => row.event === 'real_probe.case_passed')).toBe(false)
      expect.soft(nestedErrors(failure)).toContain(cause)
      expect.soft(output.flatMap(row => Array.isArray(row.failures) ? row.failures : []))
        .toContainEqual({ phase: 'probe', kind: 'cancellation_unconfirmed' })
      if (failedStage) {
        expect.soft(nestedErrors(failure)).toContain(cleanupFailure)
        expect.soft(output.flatMap(row => Array.isArray(row.failures) ? row.failures : []))
          .toContainEqual({ phase: 'cleanup', kind: 'exception' })
      }
    } else {
      expect.soft(failure).toBeUndefined()
      expect.soft(output.some(row => row.event === 'real_probe.case_passed')).toBe(true)
    }
    expect(JSON.stringify(output)).not.toContain(cause.message)
    expect(JSON.stringify(output)).not.toContain(cleanupFailure.message)
    expect(JSON.stringify(output)).not.toContain('synthetic-signal-evidence-secret-marker')
  } finally {
    capture.resolve()
    exitProbe()
    await pending
    stdout.mockRestore()
  }
}

it.each([undefined, 'capture', 'remove'] as const)(
  'does not attribute an independently settled probe to the actual owner (cleanup failure: %s)',
  async failedStage => { await actualOwnerProbeInterleaving(true, failedStage) },
)

it('joins the actual owner cancellation before reporting the probe passed', async () => {
  await actualOwnerProbeInterleaving(false)
})

it.each(['signal_not_accepted', 'different_probe_id', 'signal_evidence_unavailable'] as const)(
  'does not confirm cancellation when the actual owner signal evidence has fault %s',
  async fault => { await actualOwnerProbeInterleaving(false, undefined, fault) },
)

it.each(['SIGKILL', 'SIGTERM'] as const)(
  'treats an owned probe rejection with %s according to the owner cancellation contract', async signal => {
    const probe = deferred<void>()
    const containerId = 'b'.repeat(64)
    const daemonId = 'controlled-daemon'
    const lifecyclePath = '/virtual/task4-lifecycle.jsonl'
    const cliPid = 21111
    const insidePid = 21112
    const fakeCli = '/virtual/docker'
    const stat = (pid: number) => `${pid} (task4) ${['S', ...Array(18).fill('0'), '1234'].join(' ')}`
    control.reads.set(lifecyclePath, '')
    control.reads.set(`/proc/self/task/${process.pid}/children`, `${cliPid}`)
    control.reads.set(`/proc/${cliPid}/stat`, stat(cliPid))
    control.reads.set(`/proc/${insidePid}/stat`, stat(insidePid))
    setFsOverride('realpathSync', `/proc/${cliPid}/exe`, fakeCli)
    setFsOverride('realpathSync', fakeCli, fakeCli)
    vi.stubEnv('DOCKER_HOST', 'unix:///virtual/task4-daemon.sock')
    const rejectedProbe = new Error('synthetic-owned-probe-secret-marker', { cause: { signal } })
    let nonce = ''
    control.exec.mockImplementation((_program: string, args: string[]) => {
      if (args[0] === 'info') return `${daemonId}\n`
      if (args[0] === 'top') return `PID ARGS\n${insidePid} node ${nonce}\n`
      if (args[0] === 'container' && args[1] === 'ls') return ''
      throw new Error('unexpected controlled Docker operation')
    })
    const owner = {
      runtime: { lifecyclePath, broker: { receiptIds: () => new Set([containerId]), receipts: () => [{ containerId }] } },
      ownedProviderExec: vi.fn((_id: string, command: string[]) => {
        nonce = command[command.length - 1]
        const args = [fakeCli, 'exec', '--user', '65534:0', containerId, 'env', 'HOME=/home/freshell/provider', ...command]
        control.reads.set(`/proc/${cliPid}/cmdline`, Buffer.from(`${args.join('\0')}\0`))
        control.reads.set(`/proc/${insidePid}/cmdline`, Buffer.from(`node\0${nonce}\0`))
        appendLifecycle(lifecyclePath, 'external.provider_probe_started', { probeId: 'probe-1', containerId })
        return probe.promise
      }),
      stop: vi.fn(async () => {
        const gone = Object.assign(new Error('gone'), { code: 'ENOENT' })
        control.reads.set(`/proc/${cliPid}/stat`, gone)
        control.reads.set(`/proc/${insidePid}/stat`, gone)
        appendLifecycle(lifecyclePath, 'external.provider_probe_signal_attempted', { probeId: 'probe-1', signal: 'SIGKILL', sent: true })
        appendLifecycle(lifecyclePath, 'external.provider_probe_settled', { probeId: 'probe-1' })
        probe.reject(rejectedProbe)
        return { ok: true, errors: [] as string[] }
      }),
    }
    control.cleanup = async (...args: unknown[]) => { await (args[0] as { rig: { stop(): Promise<unknown> } }).rig.stop() }
    const output: string[] = []
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      output.push(String(chunk)); return true
    }) as typeof process.stdout.write)
    let failure: unknown
    try {
      failure = await checkInFlightOwnedProbe({ owner, containerId, owners: [], daemonId,
        daemonSocket: '/virtual/task4-daemon.sock', dockerCli: fakeCli } as unknown as Parameters<typeof checkInFlightOwnedProbe>[0])
        .then(() => undefined, error => error)
    } finally { stdout.mockRestore() }
    expect(owner.stop).toHaveBeenCalledOnce()
    if (signal === 'SIGKILL') {
      expect(failure).toBeUndefined()
      expect(output.some(line => JSON.parse(line).event === 'real_probe.case_passed')).toBe(true)
    } else {
      expect(nestedErrors(failure)).toContain(rejectedProbe)
      expect(output.flatMap(line => JSON.parse(line).failures ?? []))
        .toContainEqual({ phase: 'probe', kind: 'unexpected_rejection' })
      expect(output.join('')).not.toContain(rejectedProbe.message)
    }
  },
)

it.each([
  ['capture', true], ['remove', true], ['capture', false],
] as const)(
  'checks expected owner cancellation with independent %s failure (owner succeeded: %s)', async (failedStage, ownerSucceeded) => {
    const probe = deferred<void>()
    const containerId = 'b'.repeat(64)
    const daemonId = 'controlled-daemon'
    const lifecyclePath = '/virtual/task4-lifecycle.jsonl'
    const cliPid = 21111
    const insidePid = 21112
    const fakeCli = '/virtual/docker'
    const stat = (pid: number) => `${pid} (task4) ${['S', ...Array(18).fill('0'), '1234'].join(' ')}`
    control.reads.set(lifecyclePath, '')
    control.reads.set(`/proc/self/task/${process.pid}/children`, `${cliPid}`)
    control.reads.set(`/proc/${cliPid}/stat`, stat(cliPid))
    control.reads.set(`/proc/${insidePid}/stat`, stat(insidePid))
    setFsOverride('realpathSync', `/proc/${cliPid}/exe`, fakeCli)
    setFsOverride('realpathSync', fakeCli, fakeCli)
    vi.stubEnv('DOCKER_HOST', 'unix:///virtual/task4-daemon.sock')
    const cancellation = new Error('synthetic-cancellation-secret-marker', { cause: { signal: 'SIGKILL' } })
    const cleanupFailure = new Error(`synthetic-${failedStage}-secret-marker`)
    const capture = vi.spyOn(managedCodexCleanupDependencies, 'captureVolumes').mockImplementation(() => {
      if (failedStage === 'capture') throw cleanupFailure
      return []
    })
    const remove = vi.spyOn(managedCodexCleanupDependencies, 'removeVolumes').mockImplementation(() => {
      if (failedStage === 'remove') throw cleanupFailure
      return []
    })
    let nonce = ''
    control.exec.mockImplementation((_program: string, args: string[]) => {
      if (args[0] === 'info') return `${daemonId}\n`
      if (args[0] === 'top') return `PID ARGS\n${insidePid} node ${nonce}\n`
      throw new Error('unexpected controlled Docker operation')
    })
    const owner = {
      runtime: { lifecyclePath, broker: { receiptIds: () => new Set([containerId]), receipts: () => [{ containerId }] } },
      ownedProviderExec: vi.fn((_id: string, command: string[]) => {
        nonce = command[command.length - 1]
        const args = [fakeCli, 'exec', '--user', '65534:0', containerId, 'env', 'HOME=/home/freshell/provider', ...command]
        control.reads.set(`/proc/${cliPid}/cmdline`, Buffer.from(`${args.join('\0')}\0`))
        control.reads.set(`/proc/${insidePid}/cmdline`, Buffer.from(`node\0${nonce}\0`))
        appendLifecycle(lifecyclePath, 'external.provider_probe_started', { probeId: 'probe-1', containerId })
        return probe.promise
      }),
      stop: vi.fn(async () => {
        const gone = Object.assign(new Error('gone'), { code: 'ENOENT' })
        control.reads.set(`/proc/${cliPid}/stat`, gone)
        control.reads.set(`/proc/${insidePid}/stat`, gone)
        appendLifecycle(lifecyclePath, 'external.provider_probe_signal_attempted', { probeId: 'probe-1', signal: 'SIGKILL', sent: true })
        appendLifecycle(lifecyclePath, 'external.provider_probe_settled', { probeId: 'probe-1' })
        probe.reject(cancellation)
        return ownerSucceeded ? { ok: true, errors: [] as string[] }
          : { ok: false, errors: ['synthetic-owner-secret-marker'] }
      }),
    }
    const rows: EventRow[] = []
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      rows.push(JSON.parse(String(chunk)) as EventRow); return true
    }) as typeof process.stdout.write)
    let failure: unknown
    try {
      failure = await checkInFlightOwnedProbe({ owner, containerId, owners: [], daemonId,
        daemonSocket: '/virtual/task4-daemon.sock', dockerCli: fakeCli } as unknown as Parameters<typeof checkInFlightOwnedProbe>[0])
        .then(() => undefined, error => error)
    } finally { stdout.mockRestore() }
    const failures = rows.flatMap(row => Array.isArray(row.failures) ? row.failures : [])
    expect.soft(owner.stop).toHaveBeenCalledOnce()
    expect.soft(capture).toHaveBeenCalledOnce()
    expect.soft(remove).toHaveBeenCalledTimes(failedStage === 'remove' ? 1 : 0)
    expect.soft(rows.some(row => row.event === 'real_probe.in_flight')).toBe(true)
    expect.soft(nestedErrors(failure)).toContain(cleanupFailure)
    expect.soft(failures).toContainEqual({ phase: 'cleanup', kind: 'exception' })
    expect.soft(failures).not.toContainEqual({ phase: 'probe', kind: 'unexpected_rejection' })
    if (ownerSucceeded) {
      expect.soft(nestedErrors(failure)).not.toContain(cancellation)
      expect.soft(failures).not.toContainEqual({ phase: 'probe', kind: 'cancellation_unconfirmed' })
    } else {
      expect.soft(nestedErrors(failure)).toContain(cancellation)
      expect.soft(failures).toContainEqual({ phase: 'probe', kind: 'cancellation_unconfirmed' })
    }
    expect.soft(JSON.stringify(rows)).not.toContain(cleanupFailure.message)
    expect.soft(JSON.stringify(rows)).not.toContain('synthetic-owner-secret-marker')
    expect(JSON.stringify(rows)).not.toContain(cancellation.message)
  },
)

it('bounds the complete fallback capture before attempting owner stop', async () => {
  const f = volumeFixture()
  let now = 0
  let captureTimedOutAt = -1
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  mockDocker(f, (args, timeout) => {
    const cost = (args[0] === 'volume' && args[1] === 'ls') || args[0] === 'info' ? 6000 : 0
    if (cost > timeout) {
      now += timeout
      captureTimedOutAt = now
      throw Object.assign(new Error('controlled daemon command timeout'), { code: 'ETIMEDOUT' })
    }
    now += cost
  })
  let stopStartedAt = -1
  const stop = vi.fn(async () => {
    stopStartedAt = now
    return { ok: true, errors: [] as string[] }
  })

  const failure = await settle(volumeState(f.fixture, stop), { expectedDaemonId: f.fixture.owner.daemonId }).then(() => undefined, error => error)

  expect(stop).toHaveBeenCalledOnce()
  expect.soft(control.exec.mock.calls.some(([, args]) => args[0] === 'info')).toBe(true)
  expect.soft(captureTimedOutAt).toBeGreaterThanOrEqual(6000)
  expect.soft(captureTimedOutAt).toBeLessThanOrEqual(10_000)
  expect.soft(stopStartedAt).toBeGreaterThanOrEqual(captureTimedOutAt)
  expect.soft(stopStartedAt).toBeLessThanOrEqual(captureTimedOutAt + 10_000)
  expect.soft(f.docker.present).toBe(true)
  expect.soft(nestedErrors(failure).some(error => error instanceof Error && error.message === 'controlled daemon command timeout')).toBe(true)
})

it('reports original and teardown phases without emitting raw failure details', async () => {
  const original = new Error('synthetic-original-secret-marker')
  const ownerError = 'synthetic-owner-secret-marker'
  const stop = vi.fn(async () => ({ ok: false, errors: [ownerError] }))
  control.exec.mockImplementation((_program: string, args: string[]) => {
    if (args[0] === 'info') return 'controlled-daemon\n'
    throw new Error('unexpected controlled Docker operation')
  })
  control.owner = {
    runtime: {
      runId: 'controlled-run', testRoot: '/virtual/task4-root', evidenceDir: '/virtual/task4-evidence',
      prepare: vi.fn(async () => { throw original }),
    },
    stop,
  }
  const output: string[] = []
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    output.push(String(chunk))
    return true
  }) as typeof process.stdout.write)
  let failure: unknown
  try {
    failure = await ownershipAndUnreserved('/virtual/repo', 'controlled-daemon').then(() => undefined, error => error)
  } finally {
    stdout.mockRestore()
  }

  const events = output.flatMap(line => {
    try { return [JSON.parse(line) as { failures?: Array<{ phase?: string; kind?: string }> }] } catch { return [] }
  })
  const failures = events.flatMap(event => event.failures ?? [])
  expect(stop).toHaveBeenCalledOnce()
  expect.soft(nestedErrors(failure)).toContain(original)
  expect.soft(failures).toEqual(expect.arrayContaining([
    expect.objectContaining({ phase: 'prepare', kind: 'operation' }),
    expect.objectContaining({ phase: 'owner_stop', kind: 'reported_failure' }),
  ]))
  expect.soft(output.join('')).not.toContain(original.message)
  expect.soft(output.join('')).not.toContain(ownerError)
})

type EventRow = Record<string, unknown> & { event?: string }
type DaemonFault = 'changed' | 'uncheckable'

/** An in-memory daemon which exercises the real case functions without starting Docker. */
function fakeLifecycleDaemon(options: {
  atBoundary?: (point: string, args: string[]) => void
  unreservedObservation?: 'before_stop' | 'after_stop' | 'final_absence'
  unreservedDaemonChange?: boolean
  unreservedBeforeStopFault?: { fault: DaemonFault; observationFails?: boolean }
  fixtureAlreadyExists?: boolean
} = {}) {
  const volumes = new Map<string, Record<string, string>>()
  const createdNames: string[] = []
  const listCounts = new Map<string, number>()
  let attachment: { name: string; volume: string; runId: string; id: string } | undefined
  let daemonId = 'controlled-daemon'
  let infoFails = false
  const containerId = 'c'.repeat(64)
  const faultDaemon = (fault: DaemonFault) => {
    if (fault === 'changed') daemonId = 'daemon-b'
    else infoFails = true
  }
  control.exec.mockImplementation((_program: string, args: string[]) => {
    if (args[0] === 'info') {
      if (infoFails) throw new Error('synthetic-daemon-info-secret-marker')
      return args.includes('{{json .SecurityOptions}}') ? '["name=rootless"]' : `${daemonId}\n`
    }
    if (args[0] === 'volume' && args[1] === 'ls') {
      options.atBoundary?.('volume_list', args)
      const name = args[3].slice('name=^'.length, -1)
      const count = (listCounts.get(name) ?? 0) + 1
      listCounts.set(name, count)
      if (options.unreservedBeforeStopFault && name === createdNames[2] && count === 4) {
        faultDaemon(options.unreservedBeforeStopFault.fault)
        options.atBoundary?.('unreserved_before_stop_fault', args)
        if (options.unreservedBeforeStopFault.observationFails) throw new Error('synthetic-observation-secret-marker')
        return `${name}\n` // The observation completed on the admitted daemon before the fault.
      }
      const faultAt = { before_stop: 4, after_stop: 5, final_absence: 8 } as const
      if (options.unreservedObservation && name === createdNames[2] && count === faultAt[options.unreservedObservation]) {
        options.atBoundary?.('unreserved_observation', args)
        return options.unreservedObservation === 'final_absence' ? `${name}\n` : ''
      }
      if (options.unreservedDaemonChange && name === createdNames[2] && count === 5) {
        daemonId = 'daemon-b'
        options.atBoundary?.('unreserved_daemon_change', args)
        return `${name}\n` // The after-stop observation completed on the admitted daemon.
      }
      if (daemonId !== 'controlled-daemon') return ''
      return volumes.has(name) || (options.fixtureAlreadyExists && createdNames.length === 0) ? `${name}\n` : ''
    }
    if (args[0] === 'volume' && args[1] === 'create') {
      const name = args[args.length - 1]
      const labels: Record<string, string> = {}
      for (let index = 2; index < args.length; index++) {
        if (args[index] === '--label') {
          const label = args[++index]
          const separator = label.indexOf('=')
          labels[label.slice(0, separator)] = label.slice(separator + 1)
        }
      }
      const replacement = createdNames.includes(name)
      options.atBoundary?.(replacement ? 'volume_replace' : 'volume_create', args)
      if (!replacement) createdNames.push(name)
      volumes.set(name, labels)
      return `${name}\n`
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      const name = args[2]
      return JSON.stringify({ Name: name, Driver: 'local', Options: null, Labels: volumes.get(name) })
    }
    if (args[0] === 'volume' && args[1] === 'rm') { volumes.delete(args[2]); return `${args[2]}\n` }
    if (args[0] === 'container' && args[1] === 'create') {
      options.atBoundary?.('attachment_create', args)
      const name = args[args.indexOf('--name') + 1]
      const runId = args[args.indexOf('--label') + 1].split('=')[1]
      const volume = args[args.indexOf('--mount') + 1].split(',')[1].slice('source='.length)
      attachment = { name, volume, runId, id: containerId }
      return `${containerId}\n`
    }
    if (args[0] === 'container' && args[1] === 'ls') {
      const filter = args[args.indexOf('--filter') + 1]
      if (attachment && filter === `name=^/${attachment.name}$`) {
        options.atBoundary?.('attachment_known', args)
        return `${attachment.id}\n`
      }
      if (attachment && filter === `volume=${attachment.volume}`) return `${attachment.id}\n`
      return ''
    }
    if (args[0] === 'container' && args[1] === 'inspect' && attachment) {
      return JSON.stringify({ Id: attachment.id, Config: { Labels: { 'com.freshell.runtime-test-run-id': attachment.runId } },
        State: { Running: false }, Mounts: [{ Name: attachment.volume, Destination: '/task4-volume' }] })
    }
    if (args[0] === 'container' && args[1] === 'rm' && attachment) {
      const id = attachment.id
      attachment = undefined
      return `${id}\n`
    }
    throw new Error('unexpected controlled Docker operation')
  })
  return { containerId, createdNames, volumes, faultDaemon, get daemonId() { return daemonId } }
}

function fakeLifecycleOwner(options: { prepareError?: Error; stopError?: string } = {}) {
  const binary = Buffer.from('controlled fixture host binary')
  const hostBinaryPath = '/virtual/task4-host'
  control.reads.set(hostBinaryPath, binary)
  control.stats.set(hostBinaryPath, { size: binary.length, isFile: () => true, isSymbolicLink: () => false })
  const owner = {
    runtime: {
      runId: 'controlled-run', testRoot: '/virtual/task4-root', evidenceDir: '/virtual/task4-evidence',
      testHostBinary: hostBinaryPath, imageRef: 'controlled-image',
      prepare: vi.fn(async () => { if (options.prepareError) throw options.prepareError }),
      broker: { authorizeInitialProviderVolume: vi.fn(), initialProviderVolumeCreations: () => [], receipts: () => [] },
    },
    stop: vi.fn(async () => options.stopError ? { ok: false, errors: [options.stopError] } : { ok: true, errors: [] as string[] }),
  }
  control.owner = owner
  return owner
}

it.each(['changed', 'uncheckable'] as const)(
  'retains the owner without stopping it when the daemon is %s after setup fails before any volume exists', async fault => {
    const original = new Error('synthetic-setup-secret-marker')
    const rows: EventRow[] = []
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
      rows.push(JSON.parse(String(chunk)) as EventRow); callback?.(); return true
    }) as typeof process.stdout.write)
    const daemon = fakeLifecycleDaemon()
    const owner = fakeLifecycleOwner({ prepareError: original })
    daemon.faultDaemon(fault)
    let failure: unknown
    try { failure = await ownershipAndUnreserved('/virtual/repo', 'controlled-daemon').then(() => undefined, error => error) }
    finally { stdout.mockRestore() }

    expect.soft(nestedErrors(failure)).toContain(original)
    expect.soft(owner.stop).not.toHaveBeenCalled()
    expect.soft(rows.find(row => row.event === 'real_volume.recovery_required')).toMatchObject({
      daemonId: 'controlled-daemon', volumes: [], ownerStopped: false,
      failures: expect.arrayContaining([{ phase: 'owner_stop', kind: 'exception' }]),
    })
    expect(JSON.stringify(rows)).not.toContain(original.message)
  },
)

it.each(['unchanged', 'changed', 'uncheckable'] as const)(
  'checks the daemon after fallback volume capture fails (%s)', async fault => {
    const captureError = new Error('synthetic-capture-secret-marker')
    const rows: EventRow[] = []
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
      rows.push(JSON.parse(String(chunk)) as EventRow); callback?.(); return true
    }) as typeof process.stdout.write)
    let interrupted = false
    const daemon = fakeLifecycleDaemon({ atBoundary: point => {
      if (point === 'attachment_create') { interrupted = true; throw new Error('controlled attachment interruption') }
    } })
    const owner = fakeLifecycleOwner()
    const capture = vi.spyOn(managedCodexCleanupDependencies, 'captureVolumes').mockImplementation(() => {
      if (fault !== 'unchanged') daemon.faultDaemon(fault)
      throw captureError
    })
    let failure: unknown
    try { failure = await ownershipAndUnreserved('/virtual/repo', 'controlled-daemon').then(() => undefined, error => error) }
    finally { stdout.mockRestore() }

    const volume = daemon.createdNames[1]
    expect.soft(interrupted).toBe(true)
    expect.soft(capture).toHaveBeenCalledOnce()
    expect.soft(nestedErrors(failure)).toContain(captureError)
    expect.soft(owner.stop).toHaveBeenCalledTimes(fault === 'unchanged' ? 1 : 0)
    expect.soft(daemon.volumes.has(volume)).toBe(true)
    expect.soft(rows.find(row => row.event === 'real_volume.recovery_required')).toMatchObject({
      daemonId: 'controlled-daemon', volumes: [volume], ownerStopped: fault === 'unchanged',
      failures: expect.arrayContaining([{ phase: 'volume_capture', kind: 'exception' }]),
    })
    expect.soft(rows.find(row => row.event === 'real_volume.case_failed')).toMatchObject({
      failures: [{ phase: 'attachment_create', kind: 'operation' }],
    })
    expect(JSON.stringify(rows)).not.toContain(captureError.message)
  },
)

it.each([
  ['changed', false], ['uncheckable', false], ['changed', true], ['uncheckable', true],
] as const)(
  'does not stop the unreserved owner when the daemon is %s before stop (observation fails: %s)',
  async (fault, observationFails) => {
    const rows: EventRow[] = []
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
      rows.push(JSON.parse(String(chunk)) as EventRow); callback?.(); return true
    }) as typeof process.stdout.write)
    let faultReached = false
    const daemon = fakeLifecycleDaemon({ unreservedBeforeStopFault: { fault, observationFails }, atBoundary: point => {
      if (point === 'unreserved_before_stop_fault') faultReached = true
    } })
    const owner = fakeLifecycleOwner()
    let failure: unknown
    try { failure = await ownershipAndUnreserved('/virtual/repo', 'controlled-daemon').then(() => undefined, error => error) }
    finally { stdout.mockRestore() }

    const volume = daemon.createdNames[2]
    expect.soft(faultReached).toBe(true)
    expect.soft(failure).toBeInstanceOf(Error)
    expect.soft(owner.stop).not.toHaveBeenCalled()
    expect.soft(daemon.volumes.has(volume)).toBe(true)
    expect.soft(rows.find(row => row.event === 'real_volume.recovery_required')).toMatchObject({
      daemonId: 'controlled-daemon', volumes: [volume], ownerStopped: false,
      failures: expect.arrayContaining([{ phase: 'owner_stop', kind: 'exception' }]),
    })
    expect.soft(rows.some(row => row.event === 'real_volume.case_passed' && row.case === 'unreserved_outer_removal')).toBe(false)
    if (observationFails) expect.soft(nestedErrors(failure).some(error =>
      error instanceof Error && error.message === 'fixture Docker operation failed: volume_list')).toBe(true)
    expect(JSON.stringify(rows)).not.toMatch(/synthetic-(daemon-info|observation)-secret-marker/)
  },
)

it.each(['volume_create', 'volume_replace', 'attachment_create', 'attachment_known'] as const)(
  'records exact recovery identity before the %s interruption boundary', async boundary => {
    const output: EventRow[] = []
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
      output.push(JSON.parse(String(chunk)) as EventRow); callback?.(); return true
    }) as typeof process.stdout.write)
    let snapshot: EventRow[] = []
    let operation: string[] = []
    let tripped = false
    const daemon = fakeLifecycleDaemon({ atBoundary: (point, args) => {
      if (point === boundary && !tripped) {
        tripped = true
        snapshot = [...output]
        operation = args
        throw new Error('controlled interruption')
      }
    } })
    fakeLifecycleOwner()
    try { await ownershipAndUnreserved('/virtual/repo', 'controlled-daemon').catch(() => undefined) }
    finally { stdout.mockRestore() }
    expect(tripped).toBe(true)
    if (boundary === 'volume_create' || boundary === 'volume_replace') {
      const name = operation[operation.length - 1]
      const labels = Object.fromEntries(operation.flatMap((arg, index): Array<[string, string]> => {
        if (arg !== '--label') return []
        const value = operation[index + 1]
        const separator = value.indexOf('=')
        return [[value.slice(0, separator), value.slice(separator + 1)]]
      }))
      expect(snapshot).toContainEqual(expect.objectContaining({ event: 'real_volume.volume_attempt',
        daemonId: 'controlled-daemon', volume: name, labels,
        operation: boundary === 'volume_create' ? 'create' : 'replace' }))
    } else if (boundary === 'attachment_create') {
      const name = operation[operation.indexOf('--name') + 1]
      const runId = operation[operation.indexOf('--label') + 1].split('=')[1]
      const volume = operation[operation.indexOf('--mount') + 1].split(',')[1].slice('source='.length)
      expect(snapshot).toContainEqual(expect.objectContaining({ event: 'real_volume.attachment_attempt',
        daemonId: 'controlled-daemon', name, runId, volume, labels: { 'com.freshell.runtime-test-run-id': runId } }))
    } else {
      expect(snapshot).toContainEqual(expect.objectContaining({ event: 'real_volume.attachment_created',
        daemonId: 'controlled-daemon', containerId: daemon.containerId }))
    }
  },
)

it('does not create a volume if handing its recovery identity to the output pipe fails', async () => {
  const writeFailure = new Error('controlled identity output failure')
  let createCalls = 0
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
    const row = JSON.parse(String(chunk)) as EventRow
    if (row.event === 'real_volume.volume_attempt') {
      callback?.(writeFailure)
      process.stdout.emit('error', writeFailure)
      return true
    }
    callback?.()
    return true
  }) as typeof process.stdout.write)
  fakeLifecycleDaemon({ atBoundary: point => { if (point === 'volume_create') createCalls++ } })
  const owner = fakeLifecycleOwner()
  let failure: unknown
  try { failure = await ownershipAndUnreserved('/virtual/repo', 'controlled-daemon').then(() => undefined, error => error) }
  finally { stdout.mockRestore() }
  expect.soft(createCalls).toBe(0)
  expect.soft(nestedErrors(failure)).toContain(writeFailure)
  expect(owner.stop).toHaveBeenCalledOnce()
})

it('waits for ordered output handoff before creating a volume', async () => {
  let earlierOutputPending = false
  let identityInStream = false
  let bypassedPendingOutput = false
  let createCalls = 0
  let releaseHandoff: (() => void) | undefined
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, callback?: () => void) => {
    const row = JSON.parse(String(chunk)) as EventRow
    if (row.event === 'real_volume.owner_created') earlierOutputPending = true
    if (row.event === 'real_volume.volume_attempt' && !identityInStream) {
      identityInStream = true
      releaseHandoff = () => { earlierOutputPending = false; callback?.() }
      return true
    }
    callback?.()
    return true
  }) as typeof process.stdout.write)
  control.syncOutput = data => {
    if (JSON.parse(data).event === 'real_volume.volume_attempt' && earlierOutputPending) bypassedPendingOutput = true
    return Buffer.byteLength(data)
  }
  fakeLifecycleDaemon({ atBoundary: point => {
    if (point === 'volume_create') { createCalls++; throw new Error('controlled post-handoff stop') }
  } })
  const owner = fakeLifecycleOwner()
  const pending = ownershipAndUnreserved('/virtual/repo', 'controlled-daemon').then(() => undefined, error => error)
  let createBeforeHandoff = false
  let sawIdentityInStream = false
  try {
    await flushMicrotasks()
    createBeforeHandoff = createCalls > 0
    sawIdentityInStream = identityInStream
  } finally {
    const release = releaseHandoff as (() => void) | undefined
    release?.()
    await pending
    stdout.mockRestore()
  }
  expect.soft(sawIdentityInStream).toBe(true)
  expect.soft(createBeforeHandoff).toBe(false)
  expect.soft(bypassedPendingOutput).toBe(false)
  expect(createCalls).toBe(1)
  expect(owner.stop).toHaveBeenCalledOnce()
})

it('retains the unreserved volume when the daemon changes before final cleanup and absence', async () => {
  const rows: EventRow[] = []
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
    rows.push(JSON.parse(String(chunk)) as EventRow); callback?.(); return true
  }) as typeof process.stdout.write)
  let switched = false
  const daemon = fakeLifecycleDaemon({ unreservedDaemonChange: true, atBoundary: point => {
    if (point === 'unreserved_daemon_change') switched = true
  } })
  const owner = fakeLifecycleOwner()
  let failure: unknown
  try { failure = await ownershipAndUnreserved('/virtual/repo', 'controlled-daemon').then(() => undefined, error => error) }
  finally { stdout.mockRestore() }
  const volume = daemon.createdNames[2]
  const recovery = rows.find(row => row.event === 'real_volume.recovery_required')
  expect(switched).toBe(true)
  expect(owner.stop).toHaveBeenCalledOnce()
  expect.soft(failure).toBeInstanceOf(Error)
  expect.soft(daemon.daemonId).toBe('daemon-b')
  expect.soft(daemon.volumes.has(volume)).toBe(true)
  expect.soft(recovery).toMatchObject({ daemonId: 'controlled-daemon', volumes: [volume], ownerStopped: true })
  expect.soft(rows.some(row => row.event === 'real_volume.case_passed' && row.case === 'unreserved_outer_removal')).toBe(false)
})

function setFsOverride(method: string, target: string, value: unknown) {
  let entries = control.fsOverrides.get(method)
  if (!entries) control.fsOverrides.set(method, entries = new Map())
  entries.set(target, value)
}

/** Enter the actual script main guard with only the guest checks simulated. */
async function runExecutableCase(options: {
  prepareError?: Error
  stopError?: string
  fixtureAlreadyExists?: boolean
  unreservedObservation?: 'before_stop' | 'after_stop' | 'final_absence'
  unreservedCleanupFailure?: 'capture' | 'remove'
  fallbackObservationFailure?: boolean
  unprovenStopDaemonFault?: DaemonFault
  expectedSuccess?: boolean
}): Promise<{ rows: EventRow[]; owner: ReturnType<typeof fakeLifecycleOwner>; daemon: ReturnType<typeof fakeLifecycleDaemon> }> {
  const repo = process.cwd()
  const privateRoot = '/virtual/task4-private'
  const socket = '/virtual/task4-daemon.sock'
  const cli = '/virtual/task4-bin/docker'
  vi.stubEnv('FRESHELL_TASK4_GUEST_QUALIFIED', '1')
  vi.stubEnv('FRESHELL_TASK4_SOURCE_ROOT', repo)
  vi.stubEnv('FRESHELL_TASK4_PRIVATE_ROOT', privateRoot)
  vi.stubEnv('FRESHELL_TASK4_DOCKER_SOCKET', socket)
  vi.stubEnv('FRESHELL_TASK4_DAEMON_ID', 'controlled-daemon')
  vi.stubEnv('FRESHELL_TASK4_DOCKER_CLI', cli)
  vi.stubEnv('DOCKER_HOST', `unix://${socket}`)
  for (const name of ['DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY']) vi.stubEnv(name, undefined)
  vi.stubEnv('PATH', '/virtual/task4-bin')
  setFsOverride('realpathSync', privateRoot, privateRoot)
  setFsOverride('realpathSync', cli, cli)
  setFsOverride('statSync', socket, { isSocket: () => true })
  setFsOverride('statSync', cli, { isFile: () => true })
  setFsOverride('accessSync', cli, undefined)
  for (const key of ['HOME', 'TMPDIR', 'DOCKER_CONFIG', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) {
    const value = `${privateRoot}/${key}`
    vi.stubEnv(key, value)
    setFsOverride('realpathSync', value, value)
    if (key === 'DOCKER_CONFIG') setFsOverride('readdirSync', value, [])
  }
  let observationFaultReached = false
  let cleanupFaultReached = false
  let fallbackFaultReached = false
  let postStopVolumeLists = 0
  let owner: ReturnType<typeof fakeLifecycleOwner>
  let daemon: ReturnType<typeof fakeLifecycleDaemon>
  daemon = fakeLifecycleDaemon({ ...options, atBoundary: (point, args) => {
    if (point === 'unreserved_observation') observationFaultReached = true
    if (point === 'volume_list' && owner.stop.mock.calls.length > 0
      && args[3] === `name=^${daemon.createdNames[2]}$`) {
      postStopVolumeLists++
      if (options.fallbackObservationFailure && cleanupFaultReached && postStopVolumeLists === 2) {
        fallbackFaultReached = true
        throw new Error('synthetic-fallback-secret-marker')
      }
    }
  } })
  owner = fakeLifecycleOwner(options)
  const realCapture = managedCodexCleanupDependencies.captureVolumes
  const realRemove = managedCodexCleanupDependencies.removeVolumes
  const capture = vi.spyOn(managedCodexCleanupDependencies, 'captureVolumes').mockImplementation((...args) => {
    if (options.unreservedCleanupFailure === 'capture') {
      cleanupFaultReached = true
      throw new Error('synthetic-capture-secret-marker')
    }
    if (options.unprovenStopDaemonFault && args[0][0]?.daemonId.startsWith('changed-')) {
      try { return realCapture(...args) }
      finally { daemon.faultDaemon(options.unprovenStopDaemonFault) }
    }
    return realCapture(...args)
  })
  const remove = vi.spyOn(managedCodexCleanupDependencies, 'removeVolumes').mockImplementation((...args) => {
    if (options.unreservedCleanupFailure === 'remove') {
      cleanupFaultReached = true
      throw new Error('synthetic-remove-secret-marker')
    }
    return realRemove(...args)
  })
  const output: EventRow[] = []
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
    output.push(JSON.parse(String(chunk)) as EventRow); callback?.(); return true
  }) as typeof process.stdout.write)
  const previousArg = process.argv[1]
  const previousExitCode = process.exitCode
  try {
    process.argv[1] = path.join(repo, 'scripts/testing/codex-real-volume-lifecycle.ts')
    vi.resetModules()
    await import('../../../../scripts/testing/codex-real-volume-lifecycle.js')
    // The case uses only in-memory async functions, so bounded microtask turns
    // are enough to observe its real main() catch without a host subprocess.
    for (let index = 0; index < 200 && !output.some(row => row.event === 'real_volume.failed' || row.event === 'real_volume.completed'); index++) await Promise.resolve()
    expect(output.some(row => row.event === (options.expectedSuccess ? 'real_volume.completed' : 'real_volume.failed'))).toBe(true)
    expect(process.exitCode).toBe(options.expectedSuccess ? previousExitCode : 1)
    if (options.unreservedObservation) expect(observationFaultReached).toBe(true)
    if (options.unreservedCleanupFailure) {
      expect(cleanupFaultReached).toBe(true)
      expect(owner.stop).toHaveBeenCalledOnce()
      expect(capture).toHaveBeenCalledOnce()
      expect(remove).toHaveBeenCalledTimes(options.unreservedCleanupFailure === 'remove' ? 1 : 0)
      const volume = daemon.createdNames[2]
      expect(daemon.volumes.has(volume)).toBe(true)
      expect(output.find(row => row.event === 'real_volume.recovery_required')).toMatchObject({
        volumes: [volume], ownerStopped: true,
      })
      if (options.fallbackObservationFailure) expect(fallbackFaultReached).toBe(true)
    }
    return { rows: output, owner, daemon }
  } finally {
    process.argv[1] = previousArg
    process.exitCode = previousExitCode
    stdout.mockRestore()
  }
}

async function runExecutableFailure(options: Parameters<typeof runExecutableCase>[0]): Promise<EventRow[]> {
  return (await runExecutableCase(options)).rows
}

it.each(['changed', 'uncheckable'] as const)(
  'does not stop the unproven-capture owner when the daemon is %s after the expected capture failure', async fault => {
    const { rows, owner, daemon } = await runExecutableCase({ unprovenStopDaemonFault: fault })
    const volume = daemon.createdNames[3]
    expect.soft(daemon.createdNames).toHaveLength(4)
    expect.soft(owner.stop).toHaveBeenCalledOnce() // Only the preceding unreserved case stopped its owner.
    expect.soft(daemon.volumes.has(volume)).toBe(true)
    expect.soft(rows.find(row => row.event === 'real_volume.recovery_required')).toMatchObject({
      daemonId: 'controlled-daemon', volumes: [volume], ownerStopped: false,
      failures: expect.arrayContaining([{ phase: 'owner_stop', kind: 'exception' }]),
    })
    expect.soft(rows.find(row => row.event === 'real_volume.case_failed')).toMatchObject({
      failures: [{ phase: 'unproven_capture', kind: 'operation' }],
    })
    expect.soft(rows.some(row => row.event === 'real_volume.case_passed' && row.case === 'unproven_capture_owner_stop')).toBe(false)
    expect(JSON.stringify(rows)).not.toContain('synthetic-daemon-info-secret-marker')
  },
)

it('completes all four real volume caller cases when the admitted daemon remains unchanged', async () => {
  const { rows, owner, daemon } = await runExecutableCase({ expectedSuccess: true })
  expect(rows.filter(row => row.event === 'real_volume.case_passed').map(row => row.case)).toEqual([
    'changed_owner', 'attached', 'unreserved_outer_removal', 'unproven_capture_owner_stop',
  ])
  expect(owner.stop).toHaveBeenCalledTimes(2)
  expect(daemon.volumes.size).toBe(0)
  expect(rows.find(row => row.event === 'real_volume.completed')).toMatchObject({ passedCases: 4, daemonId: 'controlled-daemon' })
})

it('reports setup and teardown failures at the executable boundary without raw causes', async () => {
  const setup = new Error('synthetic-setup-secret-marker')
  const teardown = 'synthetic-teardown-secret-marker'
  const rows = await runExecutableFailure({ prepareError: setup, stopError: teardown })
  const failures = rows.flatMap(row => Array.isArray(row.failures) ? row.failures : [])
  expect.soft(failures).toEqual(expect.arrayContaining([
    expect.objectContaining({ phase: 'prepare', kind: 'operation' }),
    expect.objectContaining({ phase: 'owner_stop', kind: 'reported_failure' }),
  ]))
  expect.soft(JSON.stringify(rows)).not.toContain(setup.message)
  expect.soft(JSON.stringify(rows)).not.toContain(teardown)
})

it.each([
  ['capture', false], ['capture', true], ['remove', false], ['remove', true],
] as const)('executable distinguishes unreserved cleanup %s failure (fallback failure: %s)', async (stage, fallbackFailure) => {
  const rows = await runExecutableFailure({ unreservedCleanupFailure: stage, fallbackObservationFailure: fallbackFailure })
  const original = rows.find(row => row.event === 'real_volume.unreserved_cleanup_failed')
  expect.soft(original).toMatchObject({ failures: [{ phase: `volume_${stage}`, kind: 'exception' }] })
  const recovery = rows.find(row => row.event === 'real_volume.recovery_required')
  if (fallbackFailure) {
    expect.soft(recovery).toMatchObject({ failures: [{ phase: 'volume_observation', kind: 'exception' }] })
  } else {
    expect.soft(recovery).toMatchObject({ failures: [{ phase: 'volume_retention', kind: 'unconfirmed' }] })
  }
  const metadata = JSON.stringify(rows)
  expect.soft(metadata).not.toContain('synthetic-capture-secret-marker')
  expect.soft(metadata).not.toContain('synthetic-remove-secret-marker')
  expect(metadata).not.toContain('synthetic-fallback-secret-marker')
})

it('executable distinguishes unreserved cleanup owner stop failure without exposing its cause', async () => {
  const rows = await runExecutableFailure({ stopError: 'synthetic-owner-secret-marker' })
  const original = rows.find(row => row.event === 'real_volume.unreserved_cleanup_failed')
  expect.soft(original).toMatchObject({ failures: [{ phase: 'owner_stop', kind: 'reported_failure' }] })
  const recovery = rows.find(row => row.event === 'real_volume.recovery_required')
  expect.soft(recovery).toMatchObject({ ownerStopped: false,
    failures: [{ phase: 'owner_stop', kind: 'reported_failure' }] })
  expect(JSON.stringify(rows)).not.toContain('synthetic-owner-secret-marker')
})

it('distinguishes a pre-existing fixture assertion at the executable boundary', async () => {
  const rows = await runExecutableFailure({ fixtureAlreadyExists: true })
  const failures = rows.flatMap(row => Array.isArray(row.failures) ? row.failures : [])
  expect(failures).toEqual(expect.arrayContaining([
    expect.objectContaining({ phase: 'fixture_absence', kind: 'assertion', observed: true }),
  ]))
})

it.each([
  ['before_stop', 'unreserved_before_stop', false],
  ['after_stop', 'unreserved_after_stop', false],
  ['final_absence', 'unreserved_final_absence', true],
] as const)('distinguishes the %s assertion and observed state at the executable boundary', async (fault, phase, observed) => {
  const rows = await runExecutableFailure({ unreservedObservation: fault })
  const failures = rows.flatMap(row => Array.isArray(row.failures) ? row.failures : [])
  expect(failures).toEqual(expect.arrayContaining([
    expect.objectContaining({ phase, kind: 'assertion', observed }),
  ]))
})
