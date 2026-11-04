// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// The daemon, child, filesystem and elapsed time are all simulated in memory.
// No real socket, fixture process, Docker operation, network or signal occurs.
const control = vi.hoisted(() => ({
  owner: undefined as any, broker: undefined as any, child: undefined as any, authorization: undefined as any,
  spawn: vi.fn(), exec: vi.fn(), read: vi.fn(), raw: [] as string[], trace: [] as string[],
  labels: {} as Record<string, string>, volume: '', present: false, collision: false, now: 0,
  daemonId: 'daemon-owned', failPrepare: false, ownerOk: true, timeoutCode: 'ETIMEDOUT',
  orphanAfterClose: false, orphanForwardSocket: false, infoHoldMs: 7000, daemonChangesAfterTimeout: false,
  holdSavedHandoff: false, releaseHandoff: undefined as undefined | (() => void),
}))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: control.spawn, execFileSync: control.exec,
}))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs') & { default: typeof import('node:fs') }>()
  return { ...actual, default: new Proxy(actual.default, {
    get(target, key, receiver) {
      if (key === 'readFileSync') return control.read
      if (key === 'realpathSync') return (name: string) => name
      if (key === 'lstatSync') return (name: string) => {
        if (name === '/virtual/host') return { isFile: () => true, isSymbolicLink: () => false, size: 14 }
        if (name === '/virtual/private/forward.sock' && control.orphanForwardSocket) return { isSocket: () => true }
        throw Object.assign(new Error('absent'), { code: 'ENOENT' })
      }
      if (key === 'statSync') return () => ({ isSocket: () => true, isDirectory: () => true })
      return Reflect.get(target, key, receiver)
    },
  }) }
})
vi.mock('../../../../scripts/testing/runtime-sandbox.js', () => ({
  ManagedRuntimeOwner: class { constructor() { return control.owner } },
}))
import { runCaptureBudgetCase } from '../../../../scripts/testing/codex-real-capture-budget-case.js'

const input = { repo: '/virtual/repo', daemonId: 'daemon-owned', socket: '/virtual/daemon.sock',
  privateRoot: '/virtual/private', dockerCli: '/virtual/docker' }

function row(event: string, details: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ severity: 'info', event, atMs: control.now, ...details })}\n`
}

function settleControl() {
  queueMicrotask(() => {
    control.now = 11_000
    control.child.stdout.emit('data', Buffer.from(row('forwarder.hold_finished', {
      kind: 'info', elapsedMs: control.infoHoldMs, totalMs: control.infoHoldMs, clientClosed: true,
    }) + row('forwarder.settled', { mode: 'capture_timeout', ok: true, phase: 4,
      socketStillExists: false, active: 0, upstreams: 0, sockets: 0 })))
    if (control.orphanAfterClose) control.orphanForwardSocket = true
    control.child.emit('close', 0, null)
    control.trace.push('control-settled')
  })
}

beforeEach(() => {
  vi.stubEnv('DOCKER_HOST', `unix://${input.socket}`)
  control.raw = []; control.trace = []; control.labels = {}; control.volume = ''; control.now = 0
  control.present = false; control.collision = false; control.authorization = undefined; control.child = undefined
  control.daemonId = input.daemonId; control.failPrepare = false; control.ownerOk = true; control.timeoutCode = 'ETIMEDOUT'
  control.orphanAfterClose = false; control.orphanForwardSocket = false; control.infoHoldMs = 7000; control.daemonChangesAfterTimeout = false
  control.holdSavedHandoff = false; control.releaseHandoff = undefined
  vi.spyOn(Date, 'now').mockImplementation(() => control.now)
  control.broker = {
    authorizeInitialProviderVolume: vi.fn(owner => { control.authorization = owner; control.volume = owner.providerVolumeName }),
    initialProviderVolumeCreations: vi.fn(() => []), receipts: vi.fn(() => []),
  }
  const runtime = {
    runId: 'run-owned', testRoot: '/virtual/test', buildDir: '/virtual/build', evidenceDir: '/virtual/evidence',
    imageRef: `sha256:${'a'.repeat(64)}`, testHostBinary: '/virtual/host', broker: control.broker,
    prepare: vi.fn(async () => {
      control.trace.push('prepare')
      if (control.failPrepare) { control.daemonId = 'different-daemon'; throw new Error('PRIVATE_PREPARE_FAILURE') }
    }), writeIncident: vi.fn(),
  }
  control.owner = { runtime, stop: vi.fn(async () => {
    control.trace.push(`owner-stop:${control.now}`)
    expect(process.env.DOCKER_HOST).toBe(`unix://${input.socket}`)
    expect(control.present || control.collision).toBe(true)
    if (control.child) settleControl()
    return control.ownerOk ? { ok: true, errors: [] } : { ok: false, errors: ['PRIVATE_OWNER_FAILURE'] }
  }) }
  control.read.mockReset().mockImplementation((name: string) => {
    if (name === '/virtual/host') return Buffer.from('fixture-binary')
    if (name.startsWith('/proc/')) return `1234 (node) ${['S', ...Array(18).fill('0'), '12345'].join(' ')}`
    throw new Error('unexpected controlled file read')
  })
  control.exec.mockReset().mockImplementation((_program, args: string[], options: { timeout: number }) => {
    const forwarded = process.env.DOCKER_HOST === 'unix:///virtual/private/forward.sock'
    if (args[0] === 'info') {
      if (forwarded) {
        control.trace.push('second-daemon-response')
        control.child.stdout.emit('data', Buffer.from(row('forwarder.daemon_response_held', {
          daemonId: input.daemonId, volume: control.volume, kind: 'info', status: 200, holdMs: control.infoHoldMs,
        })))
        expect(options.timeout).toBeLessThanOrEqual(6000)
        control.now += options.timeout
        if (control.daemonChangesAfterTimeout) { control.daemonId = 'different-daemon'; settleControl() }
        throw Object.assign(new Error('PRIVATE_CONTROLLED_TIMEOUT'), { code: control.timeoutCode })
      }
      return `${control.daemonId}\n`
    }
    if (args[0] === 'volume' && args[1] === 'ls') {
      if (forwarded) {
        control.trace.push('first-daemon-response')
        control.child.stdout.emit('data', Buffer.from(row('forwarder.daemon_response_held', {
          daemonId: input.daemonId, volume: control.volume, kind: 'volume_list', status: 200, holdMs: 4000,
        })))
        control.now += 4000
        control.child.stdout.emit('data', Buffer.from(row('forwarder.hold_finished', {
          kind: 'volume_list', elapsedMs: 4000, totalMs: 4000, clientClosed: false,
        })))
      }
      return control.present || control.collision ? `${control.volume}\n` : ''
    }
    if (args[0] === 'volume' && args[1] === 'create') {
      control.trace.push('volume-create')
      for (let index = 0; index < args.length; index++) if (args[index] === '--label') {
        const [key, value] = args[++index].split('='); control.labels[key] = value
      }
      control.present = true
      return control.volume
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      return JSON.stringify({ Name: control.volume, Driver: 'local', Options: null, Labels: control.labels })
    }
    if (args[0] === 'container' && args[1] === 'ls') return ''
    if (args[0] === 'volume' && args[1] === 'rm') { control.trace.push('volume-remove'); control.present = false; return control.volume }
    throw new Error('unexpected controlled Docker operation')
  })
  control.spawn.mockReset().mockImplementation(() => {
    control.trace.push('forwarder-start')
    const child = new EventEmitter() as EventEmitter & Record<string, any>
    child.pid = 1234; child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    child.kill = vi.fn(() => { throw new Error('unexpected signal') })
    control.child = child
    queueMicrotask(() => child.stdout.emit('data', Buffer.from(row('forwarder.ready', {
      mode: 'capture_timeout', socket: '/virtual/private/forward.sock', daemonId: input.daemonId, volume: control.volume,
    }))))
    return child
  })
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
    control.raw.push(String(chunk))
    if (JSON.parse(String(chunk)).event === 'real_capture_budget.saved_capture') {
      control.trace.push('saved-capture')
      if (control.holdSavedHandoff) { control.releaseHandoff = () => callback?.(); return true }
    }
    callback?.(); return true
  }) as typeof process.stdout.write)
})

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('bounds the complete capture, restores the direct daemon for owner stop, then recovers only after the control settles', async () => {
  await runCaptureBudgetCase(input)

  expect(control.trace).toContain('first-daemon-response')
  expect(control.trace).toContain('second-daemon-response')
  expect(control.trace).toContain('owner-stop:10000')
  expect(control.trace.indexOf('saved-capture')).toBeGreaterThanOrEqual(0)
  expect(control.trace.indexOf('forwarder-start')).toBeGreaterThan(control.trace.indexOf('saved-capture'))
  expect(control.trace.indexOf('control-settled')).toBeLessThan(control.trace.indexOf('volume-remove'))
  expect(control.owner.stop).toHaveBeenCalledOnce()
  expect(control.child.kill).not.toHaveBeenCalled()
  expect(control.present).toBe(false)
  expect(control.raw.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
    event: 'real_capture_budget.completed', captureFailed: true, ownerStopOk: true, retainedBeforeRecovery: true,
  }))
  expect(control.raw.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
    event: 'real_capture_budget.saved_capture', owner: control.authorization, labels: control.labels,
  }))
  expect(control.raw.join('')).not.toContain('PRIVATE_CONTROLLED_TIMEOUT')
})

it('does not create or remove a pre-existing exact volume', async () => {
  control.collision = true

  const failure = await runCaptureBudgetCase(input).then(() => undefined, error => error)

  expect(failure).toBeInstanceOf(Error)
  expect(control.trace).not.toContain('volume-create')
  expect(control.trace).not.toContain('volume-remove')
  expect(control.spawn).not.toHaveBeenCalled()
  expect(control.owner.stop).toHaveBeenCalledOnce()
  expect(control.collision).toBe(true)
})

it('waits for the saved-capture handoff before starting control or owner cleanup', async () => {
  control.holdSavedHandoff = true
  const pending = runCaptureBudgetCase(input).then(() => undefined, error => error)
  for (let index = 0; index < 30; index++) await Promise.resolve()
  const sawHandoff = typeof control.releaseHandoff === 'function'
  const controlStartedEarly = control.spawn.mock.calls.length > 0
  const ownerStoppedEarly = control.owner.stop.mock.calls.length > 0
  if (!sawHandoff) control.holdSavedHandoff = false
  control.releaseHandoff?.()
  const failure = await pending

  expect(sawHandoff).toBe(true)
  expect(controlStartedEarly).toBe(false)
  expect(ownerStoppedEarly).toBe(false)
  expect(failure).toBeUndefined()
})

it('does not stop an owner against a different daemon after preparation fails', async () => {
  control.failPrepare = true

  const failure = await runCaptureBudgetCase(input).then(() => undefined, error => error)

  expect(failure).toBeInstanceOf(Error)
  expect(control.owner.stop).not.toHaveBeenCalled()
  expect(control.trace).not.toContain('volume-create')
  expect(control.raw.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
    event: 'real_capture_budget.recovery_required', ownerStopOk: null,
    failures: expect.arrayContaining([expect.objectContaining({ phase: 'owner_stop', kind: 'unsettled' })]),
  }))
  expect(control.raw.join('')).not.toContain('PRIVATE_PREPARE_FAILURE')
})

it('retains the volume if capture fails for a reason other than the expected timeout', async () => {
  control.timeoutCode = 'EIO'

  const failure = await runCaptureBudgetCase(input).then(() => undefined, error => error)

  expect(failure).toBeInstanceOf(Error)
  expect(control.owner.stop).toHaveBeenCalledOnce()
  expect(control.present).toBe(true)
  expect(control.trace).not.toContain('volume-remove')
  expect(control.raw.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
    event: 'real_capture_budget.recovery_required', captureStatus: 'failed', ownerStopOk: true,
    failures: expect.arrayContaining([expect.objectContaining({ phase: 'volume_retention', kind: 'unconfirmed' })]),
  }))
  expect(control.raw.join('')).not.toContain('PRIVATE_CONTROLLED_TIMEOUT')
})

it('retains the volume and reports owner cleanup failure separately', async () => {
  control.ownerOk = false

  const failure = await runCaptureBudgetCase(input).then(() => undefined, error => error)

  expect(failure).toBeInstanceOf(Error)
  expect(control.owner.stop).toHaveBeenCalledOnce()
  expect(control.present).toBe(true)
  expect(control.trace).not.toContain('volume-remove')
  expect(control.raw.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
    event: 'real_capture_budget.recovery_required', captureStatus: 'failed', ownerStopOk: false,
    failures: expect.arrayContaining([{ phase: 'owner_stop', kind: 'reported_failure' }]),
  }))
  expect(control.raw.join('')).not.toContain('PRIVATE_OWNER_FAILURE')
})

it('retains the volume when the supposedly settled control leaves its socket behind', async () => {
  control.orphanAfterClose = true

  const failure = await runCaptureBudgetCase(input).then(() => undefined, error => error)

  expect(failure).toBeInstanceOf(Error)
  expect(control.owner.stop).toHaveBeenCalledOnce()
  expect(control.present).toBe(true)
  expect(control.trace).not.toContain('volume-remove')
  expect(control.raw.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
    event: 'real_capture_budget.recovery_required', forwarderSocket: '/virtual/private/forward.sock',
    failures: expect.arrayContaining([{ phase: 'socket', kind: 'unsettled' }]),
  }))
})

it('does not count a shorter second hold as cumulative-budget evidence', async () => {
  control.infoHoldMs = 6999

  const failure = await runCaptureBudgetCase(input).then(() => undefined, error => error)

  expect(failure).toBeInstanceOf(Error)
  expect(control.owner.stop).toHaveBeenCalledOnce()
  expect(control.present).toBe(true)
  expect(control.trace).not.toContain('volume-remove')
  expect(control.raw.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
    event: 'real_capture_budget.recovery_required', controlJoined: true, controlOk: false,
  }))
})

it('retains the volume when the direct daemon changes after capture times out', async () => {
  control.daemonChangesAfterTimeout = true

  const failure = await runCaptureBudgetCase(input).then(() => undefined, error => error)

  expect(failure).toBeInstanceOf(Error)
  expect(control.owner.stop).not.toHaveBeenCalled()
  expect(control.present).toBe(true)
  expect(control.trace).not.toContain('volume-remove')
  expect(control.raw.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
    event: 'real_capture_budget.recovery_required', captureStatus: 'failed', stopRequested: true, stopCalls: 0, ownerStopOk: null,
    failures: expect.arrayContaining([{ phase: 'owner_stop', kind: 'operation' }, { phase: 'volume_retention', kind: 'unconfirmed' }]),
  }))
})
