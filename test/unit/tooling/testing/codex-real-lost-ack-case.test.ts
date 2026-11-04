// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// In-memory filesystem, Docker, broker, and forwarder boundaries: no real
// socket, daemon, fixture process, network operation, or signal is used.
const control = vi.hoisted(() => ({
  owner: undefined as any, broker: undefined as any, child: undefined as any,
  spawn: vi.fn(), exec: vi.fn(), request: vi.fn(), read: vi.fn(),
  links: new Map<string, string>(), trace: [] as string[], authorized: undefined as any,
  reservation: false, present: false, collision: false, raw: [] as string[],
  daemonId: 'daemon-owned', failLink: false, orphanForwardSocket: false, orphanAfterClose: false,
  forwarderOk: true,
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
      if (key === 'symlinkSync') return (target: string, name: string) => {
        if (control.failLink) { control.daemonId = 'different-daemon'; throw new Error('PRIVATE_LINK_FAILURE') }
        control.links.set(name, target); control.trace.push('link-create')
      }
      if (key === 'readlinkSync') return (name: string) => control.links.get(name)
      if (key === 'renameSync') return (from: string, to: string) => {
        const value = control.links.get(from)
        if (!value) throw new Error('missing controlled link')
        control.links.set(to, value); control.links.delete(from); control.trace.push(`link-target:${value}`)
      }
      if (key === 'unlinkSync') return (name: string) => { control.links.delete(name); control.trace.push('link-remove') }
      if (key === 'lstatSync') return (name: string) => {
        if (control.links.has(name)) return { isSymbolicLink: () => true }
        if (name === '/virtual/private/forward.sock' && control.orphanForwardSocket) return { isSocket: () => true }
        if (name === '/virtual/host') return { isFile: () => true, isSymbolicLink: () => false, size: 14 }
        throw Object.assign(new Error('absent'), { code: 'ENOENT' })
      }
      if (key === 'statSync') return () => ({ isSocket: () => true, isDirectory: () => true })
      return Reflect.get(target, key, receiver)
    },
  }) }
})
vi.mock('node:http', async importOriginal => {
  const actual = await importOriginal<typeof import('node:http') & { default: typeof import('node:http') }>()
  return { ...actual, default: { ...actual.default, request: control.request,
    get(_options: unknown, callback: (response: EventEmitter & { statusCode: number }) => void) {
      const request = new EventEmitter()
      control.trace.push('broker-source')
      queueMicrotask(() => {
        const response = new EventEmitter() as EventEmitter & { statusCode: number }
        response.statusCode = 200
        callback(response)
        response.emit('data', Buffer.from(JSON.stringify({ ID: 'daemon-owned' })))
        response.emit('end')
      })
      return request
    },
  } }
})
vi.mock('../../../../scripts/testing/runtime-sandbox.js', () => ({
  ManagedRuntimeOwner: class { constructor() { return control.owner } },
}))
import { runLostAckVolumeCase } from '../../../../scripts/testing/codex-real-lost-ack-case.js'

const input = { repo: '/virtual/repo', daemonId: 'daemon-owned', socket: '/virtual/daemon.sock',
  privateRoot: '/virtual/private', dockerCli: '/virtual/docker' }

function row(event: string, details: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ severity: 'info', event, ...details })}\n`
}

beforeEach(() => {
  vi.stubEnv('DOCKER_HOST', `unix://${input.socket}`)
  control.links.clear(); control.trace = []; control.raw = []; control.authorized = undefined
  control.reservation = false; control.present = false; control.collision = false
  control.daemonId = input.daemonId; control.failLink = false; control.orphanForwardSocket = false; control.orphanAfterClose = false; control.forwarderOk = true
  control.broker = {
    proxySocketPath: '/virtual/private/broker.sock',
    authorizeInitialProviderVolume: vi.fn(owner => { control.authorized = owner; control.trace.push('authorize') }),
    initialProviderVolumeCreations: vi.fn(() => {
      control.trace.push(control.reservation ? 'reservation-present' : 'reservation-absent')
      return control.reservation ? [control.authorized] : []
    }),
    receipts: vi.fn(() => []), settleForwarded: vi.fn(async () => { control.trace.push('broker-idle'); return true }),
  }
  const runtime = {
    runId: 'run-owned', testRoot: '/virtual/test', buildDir: '/virtual/build', evidenceDir: '/virtual/evidence',
    imageRef: `sha256:${'a'.repeat(64)}`, testHostBinary: '/virtual/host', broker: control.broker,
    prepare: vi.fn(async () => { control.trace.push('prepare') }),
  }
  control.owner = { runtime, stop: vi.fn(async () => {
    control.trace.push('owner-stop')
    expect(process.env.DOCKER_HOST).toBe(`unix://${input.socket}`)
    expect([...control.links.values()]).not.toContain('/virtual/private/forward.sock')
    if (control.reservation) control.present = false
    return control.reservation ? { ok: false, errors: ['broker settlement: upstream_request_failed (POST /v1.47/volumes/create)'] }
      : { ok: true, errors: [] }
  }) }
  control.exec.mockReset().mockImplementation((_program, args) => {
    if (args[0] === 'info') return `${control.daemonId}\n`
    if (args[0] === 'volume' && args[1] === 'ls') {
      control.trace.push(control.present || control.collision ? 'volume-present' : 'volume-absent')
      return control.present || control.collision ? `${control.authorized.providerVolumeName}\n` : ''
    }
    throw new Error('unexpected controlled Docker operation')
  })
  control.read.mockReset().mockImplementation((name: string) => {
    if (name === '/virtual/host') return Buffer.from('fixture-binary')
    if (name.startsWith('/proc/')) return `1234 (node) ${['S', ...Array(18).fill('0'), '12345'].join(' ')}`
    if (name.endsWith('/cleanup.json')) return JSON.stringify({ ok: false, verifiedKnownResourcesAbsent: true, verifiedResourcesAbsent: true,
      brokerSettlementComplete: true, brokerSettlementFailures: [{ method: 'POST', url: '/v1.47/volumes/create',
        reason: 'upstream_request_failed', allocationUnknown: false }], volumes: [control.authorized.providerVolumeName] })
    throw new Error('unexpected controlled file read')
  })
  control.spawn.mockReset().mockImplementation(() => {
    control.trace.push('forwarder-start')
    const child = new EventEmitter() as EventEmitter & Record<string, any>
    child.pid = 1234; child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    child.kill = vi.fn(() => { throw new Error('unexpected signal') })
    control.child = child
    queueMicrotask(() => child.stdout.emit('data', Buffer.from(row('forwarder.ready', {
      mode: 'lost_ack', socket: '/virtual/private/forward.sock', daemonId: input.daemonId,
      volume: control.authorized.providerVolumeName,
    }))))
    return child
  })
  control.request.mockReset().mockImplementation((_options, _callback) => {
    const request = new EventEmitter() as EventEmitter & Record<string, any>
    request.setTimeout = () => request
    request.destroy = () => {}
    request.end = (body: string | Buffer) => {
      const value = JSON.parse(String(body))
      expect([...control.links.values()]).toContain('/virtual/private/forward.sock')
      expect(value.Name).toBe(control.authorized.providerVolumeName)
      expect(value.Driver).toBe('local')
      expect(value.Labels['com.freshell.installation-id']).toBe(control.authorized.installationId)
      expect(value.Labels['com.freshell.soul-id']).toBe(control.authorized.soulId)
      control.trace.push('broker-create')
      control.reservation = true; control.present = true
      queueMicrotask(() => {
        control.child.stdout.emit('data', Buffer.from(row('forwarder.daemon_create_observed', {
          daemonId: input.daemonId, volume: value.Name, status: 201,
        }) + row('forwarder.acknowledgement_dropped', { volume: value.Name })
          + row('forwarder.settled', { mode: 'lost_ack', ok: control.forwarderOk, phase: 1, socketStillExists: false, active: 0, upstreams: 0, sockets: 0 })))
        request.emit('error', Object.assign(new Error('PRIVATE_CLIENT_ERROR'), { code: 'ECONNRESET' }))
        request.emit('close')
        if (control.orphanAfterClose) control.orphanForwardSocket = true
        control.child.emit('close', control.forwarderOk ? 0 : 1, null)
      })
    }
    return request
  })
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
    const line = String(chunk); control.raw.push(line)
    const event = JSON.parse(line).event
    if (event === 'real_lost_ack.volume_attempt') control.trace.push('identity')
    callback?.(); return true
  }) as typeof process.stdout.write)
})

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('observes the real-owner reservation and allocation before the dropped acknowledgment, then joins exact owner cleanup', async () => {
  await runLostAckVolumeCase(input)

  expect(control.broker.authorizeInitialProviderVolume).toHaveBeenCalledOnce()
  expect(control.authorized.soulId).toMatch(/^soul-fresh-codex-/)
  expect(control.trace.indexOf('broker-source')).toBeGreaterThanOrEqual(0)
  expect(control.trace.indexOf('identity')).toBeGreaterThan(control.trace.indexOf('authorize'))
  expect(control.trace.indexOf('volume-absent')).toBeLessThan(control.trace.indexOf('broker-create'))
  expect(control.trace.indexOf('reservation-absent')).toBeLessThan(control.trace.indexOf('broker-create'))
  expect(control.trace.indexOf('broker-create')).toBeGreaterThan(control.trace.indexOf('identity'))
  expect(control.trace.indexOf('volume-present')).toBeGreaterThan(control.trace.indexOf('broker-create'))
  expect(control.trace.indexOf('reservation-present')).toBeGreaterThan(control.trace.indexOf('broker-create'))
  expect(control.trace.indexOf('owner-stop')).toBeGreaterThan(control.trace.indexOf('volume-present'))
  expect(control.trace.indexOf('owner-stop')).toBeGreaterThan(control.trace.indexOf('broker-create'))
  expect(control.owner.stop).toHaveBeenCalledOnce()
  expect(control.present).toBe(false)
  expect(control.child.kill).not.toHaveBeenCalled()
  expect(control.links.size).toBe(0)
  expect(control.raw.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
    event: 'real_lost_ack.completed', ownerStopOk: false, expectedTransportFailure: true, beforeStop: true, afterStop: false,
  }))
  expect(control.raw.join('')).not.toContain('PRIVATE_')
})

it('refuses an already existing exact volume before sending a create and leaves it untouched', async () => {
  control.collision = true

  const failure = await runLostAckVolumeCase(input).then(() => undefined, error => error)

  expect(failure).toBeInstanceOf(Error)
  expect(control.request).not.toHaveBeenCalled()
  expect(control.spawn).not.toHaveBeenCalled()
  expect(control.owner.stop).toHaveBeenCalledOnce()
  expect(control.collision).toBe(true)
  expect(control.links.size).toBe(0)
})

it('does not invoke owner cleanup on a different daemon after control-link creation fails', async () => {
  control.failLink = true

  const failure = await runLostAckVolumeCase(input).then(() => undefined, error => error)

  expect(failure).toBeInstanceOf(Error)
  expect(control.owner.stop).not.toHaveBeenCalled()
  expect(control.raw.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
    event: 'real_lost_ack.recovery_required', allocationAttempted: false, ownerStopOk: null,
    failures: expect.arrayContaining([expect.objectContaining({ phase: 'owner_stop', kind: 'unsettled' })]),
  }))
  expect(control.raw.join('')).not.toContain('PRIVATE_LINK_FAILURE')
})

it('reports an unexpectedly retained forwarder socket instead of counting success', async () => {
  control.orphanAfterClose = true

  const failure = await runLostAckVolumeCase(input).then(() => undefined, error => error)

  expect(failure).toBeInstanceOf(Error)
  expect(control.orphanForwardSocket).toBe(true)
  expect(control.raw.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
    event: 'real_lost_ack.recovery_required', forwarderSocket: '/virtual/private/forward.sock',
  }))
})

it('keeps the original collision and a separate owner-stop failure without exposing either cause', async () => {
  control.collision = true
  control.owner.stop.mockRejectedValue(new Error('PRIVATE_OWNER_STOP_FAILURE'))

  const failure = await runLostAckVolumeCase(input).then(() => undefined, error => error)

  expect(failure).toBeInstanceOf(AggregateError)
  expect(control.owner.stop).toHaveBeenCalledOnce()
  expect(control.raw.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
    event: 'real_lost_ack.recovery_required', allocationAttempted: false, ownerStopOk: null,
    failures: expect.arrayContaining([{ phase: 'case', kind: 'assertion' }, { phase: 'owner_stop', kind: 'operation' }]),
  }))
  expect(control.raw.join('')).not.toContain('PRIVATE_OWNER_STOP_FAILURE')
  expect(control.collision).toBe(true)
})

it('reports a joined but unsuccessful forwarder separately from its case and owner-stop failures', async () => {
  control.forwarderOk = false

  const failure = await runLostAckVolumeCase(input).then(() => undefined, error => error)

  expect(failure).toBeInstanceOf(Error)
  expect(control.owner.stop).toHaveBeenCalledOnce()
  expect(control.raw.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
    event: 'real_lost_ack.recovery_required', controlJoined: true, controlOk: false,
    allocationAttempted: true, ownerStopOk: false,
  }))
})
