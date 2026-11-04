// @vitest-environment node
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// HTTP, filesystem, sockets and the upstream daemon are controlled in memory;
// this test does not start a server or a child process.
const control = vi.hoisted(() => ({
  handler: undefined as undefined | ((request: unknown, response: unknown) => void),
  server: undefined as any,
  socketExists: false,
  upstreamRequests: [] as Array<{ method: string; path: string; body: string }>,
  upstreamVolume: '',
  holds: [] as Array<{ ms: number; resolve: () => void }>,
}))

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs') & { default: typeof import('node:fs') }>()
  const fake = new Proxy(actual.default, {
    get(target, property, receiver) {
      if (property === 'realpathSync') return (name: string) => name
      if (property === 'statSync') return () => ({ isSocket: () => true })
      if (property === 'chmodSync') return () => {}
      if (property === 'lstatSync') return () => {
        if (control.socketExists) return {}
        throw Object.assign(new Error('absent'), { code: 'ENOENT' })
      }
      return Reflect.get(target, property, receiver)
    },
  })
  return { ...actual, default: fake }
})

vi.mock('node:http', async importOriginal => {
  const actual = await importOriginal<typeof import('node:http') & { default: typeof import('node:http') }>()
  const { EventEmitter } = await import('node:events')
  const { Readable } = await import('node:stream')
  return { ...actual, default: {
    ...actual.default,
    createServer(handler: typeof control.handler) {
      control.handler = handler
      const server = new EventEmitter() as EventEmitter & Record<string, any>
      server.listen = (_socket: string, callback: () => void) => { control.socketExists = true; callback() }
      server.close = (callback: () => void) => { control.socketExists = false; queueMicrotask(callback) }
      control.server = server
      return server
    },
    request(options: { method: string; path: string }, callback: (result: unknown) => void) {
      const upstream = new EventEmitter() as EventEmitter & Record<string, any>
      let closed = false
      upstream.setTimeout = () => upstream
      upstream.destroy = () => { if (!closed) { closed = true; queueMicrotask(() => upstream.emit('close')) } }
      upstream.end = (body: Buffer) => {
        control.upstreamRequests.push({ method: options.method, path: options.path, body: body.toString('utf8') })
        const capture = process.env.FRESHELL_TASK4_FORWARD_MODE === 'capture_timeout'
        const response = Readable.from([Buffer.from(JSON.stringify(capture ? {} : { Name: control.upstreamVolume }))]) as Readable & Record<string, any>
        response.statusCode = capture ? 200 : 201
        response.headers = { 'content-type': 'application/json' }
        response.once('end', () => upstream.destroy())
        callback(response)
      }
      return upstream
    },
  } }
})

vi.mock('node:timers/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:timers/promises')>(),
  setTimeout: (ms: number, _value: unknown, options: { signal: AbortSignal }) => new Promise<void>((resolve, reject) => {
    control.holds.push({ ms, resolve })
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
  }),
}))

const target = `freshell-provider-${'a'.repeat(24)}`
let originalExitCode: number | undefined

function downstream(name: string) {
  const request = Readable.from([Buffer.from(JSON.stringify({ Name: name, Driver: 'local', Labels: {} }))]) as Readable & Record<string, any>
  request.method = 'POST'
  request.url = '/v1.47/volumes/create'
  const response = new EventEmitter() as EventEmitter & Record<string, any>
  response.destroyed = false
  response.destroy = vi.fn(() => { response.destroyed = true; response.emit('close') })
  response.writeHead = vi.fn((status: number) => { response.status = status; return response })
  response.end = vi.fn(() => { response.emit('finish'); response.emit('close') })
  return { request, response }
}

function downstreamGet(url: string) {
  const request = Readable.from([]) as Readable & Record<string, any>
  request.method = 'GET'; request.url = url
  const response = new EventEmitter() as EventEmitter & Record<string, any>
  response.destroyed = false
  response.destroy = vi.fn(() => { response.destroyed = true; response.emit('close') })
  response.writeHead = vi.fn((status: number) => { response.status = status; return response })
  response.end = vi.fn(() => { response.emit('finish'); response.emit('close') })
  return { request, response }
}

beforeEach(() => {
  vi.resetModules()
  originalExitCode = process.exitCode
  control.handler = undefined
  control.server = undefined
  control.socketExists = false
  control.upstreamRequests = []
  control.upstreamVolume = target
  control.holds = []
  vi.stubEnv('FRESHELL_TASK4_GUEST_QUALIFIED', '1')
  vi.stubEnv('FRESHELL_TASK4_FORWARD_MODE', 'lost_ack')
  vi.stubEnv('FRESHELL_TASK4_FORWARD_SOCKET', '/virtual/private/f.sock')
  vi.stubEnv('FRESHELL_TASK4_DOCKER_SOCKET', '/virtual/daemon.sock')
  vi.stubEnv('FRESHELL_TASK4_PRIVATE_ROOT', '/virtual/private')
  vi.stubEnv('FRESHELL_TASK4_FORWARD_VOLUME', target)
  vi.stubEnv('FRESHELL_TASK4_DAEMON_ID', 'daemon-owned')
})

afterEach(() => {
  process.exitCode = originalExitCode
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function untilSettled(events: string[]) {
  for (let index = 0; index < 50; index++) {
    if (events.some(line => JSON.parse(line).event === 'forwarder.settled')) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('controlled forwarding did not settle')
}

async function until(condition: () => boolean) {
  for (let index = 0; index < 50; index++) {
    if (condition()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('controlled forwarding state did not settle')
}

it('drops only the exact creation acknowledgement after the upstream creation has succeeded', async () => {
  const events: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { events.push(String(chunk)); return true }) as typeof process.stdout.write)
  await import('../../../../scripts/testing/codex-one-volume-forwarder.mjs')
  expect(control.handler).toBeTypeOf('function')
  const { request, response } = downstream(target)
  control.handler!(request, response)
  await untilSettled(events)

  expect(control.upstreamRequests).toEqual([{ method: 'POST', path: '/v1.47/volumes/create',
    body: JSON.stringify({ Name: target, Driver: 'local', Labels: {} }) }])
  expect(response.destroy).toHaveBeenCalledOnce()
  expect(response.writeHead).not.toHaveBeenCalled()
  const rows = events.map(line => JSON.parse(line))
  expect(rows.findIndex(row => row.event === 'forwarder.daemon_create_observed')).toBeLessThan(rows.findIndex(row => row.event === 'forwarder.acknowledgement_dropped'))
  expect(rows).toContainEqual(expect.objectContaining({ event: 'forwarder.settled', ok: true, phase: 1, active: 0, upstreams: 0, sockets: 0, socketStillExists: false }))
})

it('refuses another volume without forwarding its create request', async () => {
  const events: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { events.push(String(chunk)); return true }) as typeof process.stdout.write)
  await import('../../../../scripts/testing/codex-one-volume-forwarder.mjs')
  expect(control.handler).toBeTypeOf('function')
  const { request, response } = downstream(`freshell-provider-${'b'.repeat(24)}`)
  control.handler!(request, response)
  await untilSettled(events)

  expect(control.upstreamRequests).toEqual([])
  expect(response.status).toBe(403)
  expect(events.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ event: 'forwarder.settled', ok: false }))
})

it('does not report a dropped acknowledgment when the upstream returns a different volume', async () => {
  const events: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { events.push(String(chunk)); return true }) as typeof process.stdout.write)
  control.upstreamVolume = `freshell-provider-${'b'.repeat(24)}`
  await import('../../../../scripts/testing/codex-one-volume-forwarder.mjs')
  expect(control.handler).toBeTypeOf('function')
  const { request, response } = downstream(target)
  control.handler!(request, response)
  await untilSettled(events)

  expect(control.upstreamRequests).toHaveLength(1)
  expect(response.destroy).toHaveBeenCalledOnce()
  const rows = events.map(line => JSON.parse(line))
  expect(rows).toContainEqual(expect.objectContaining({ event: 'forwarder.settled', ok: false }))
  expect(rows.some(row => row.event === 'forwarder.daemon_create_observed' || row.event === 'forwarder.acknowledgement_dropped')).toBe(false)
})

it('holds the two capture responses in order and records the timed-out client before settling', async () => {
  const events: string[] = []
  let now = 0
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  vi.stubEnv('FRESHELL_TASK4_FORWARD_MODE', 'capture_timeout')
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { events.push(String(chunk)); return true }) as typeof process.stdout.write)
  await import('../../../../scripts/testing/codex-one-volume-forwarder.mjs')
  expect(control.handler).toBeTypeOf('function')
  const filters = encodeURIComponent(JSON.stringify({ name: { [`^${target}$`]: true } }))
  const first = downstreamGet(`/v1.47/volumes?filters=${filters}`)
  control.handler!(first.request, first.response)
  await until(() => control.holds.length === 1)
  expect(control.holds[0].ms).toBe(4000)
  expect(first.response.writeHead).not.toHaveBeenCalled()
  now = 4000; control.holds[0].resolve()
  await until(() => first.response.end.mock.calls.length === 1)
  expect(first.response.status).toBe(200)

  const second = downstreamGet('/v1.47/info')
  control.handler!(second.request, second.response)
  await until(() => control.holds.length === 2)
  expect(control.holds[1].ms).toBe(7000)
  second.response.destroy()
  now = 11_000; control.holds[1].resolve()
  await untilSettled(events)

  const rows = events.map(line => JSON.parse(line))
  expect(rows).toContainEqual(expect.objectContaining({ event: 'forwarder.hold_finished', kind: 'volume_list', elapsedMs: 4000, clientClosed: false }))
  expect(rows).toContainEqual(expect.objectContaining({ event: 'forwarder.hold_finished', kind: 'info', elapsedMs: 7000, clientClosed: true }))
  expect(rows).toContainEqual(expect.objectContaining({ event: 'forwarder.settled', mode: 'capture_timeout', ok: true, phase: 4,
    socketStillExists: false, active: 0, upstreams: 0, sockets: 0 }))
  expect(control.upstreamRequests.map(request => request.path)).toEqual([`/v1.47/volumes?filters=${filters}`, '/v1.47/info'])
})

it('refuses an out-of-order capture info request without reaching the daemon', async () => {
  const events: string[] = []
  vi.stubEnv('FRESHELL_TASK4_FORWARD_MODE', 'capture_timeout')
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { events.push(String(chunk)); return true }) as typeof process.stdout.write)
  await import('../../../../scripts/testing/codex-one-volume-forwarder.mjs')
  expect(control.handler).toBeTypeOf('function')
  const request = downstreamGet('/v1.47/info')
  control.handler!(request.request, request.response)
  await untilSettled(events)

  expect(control.upstreamRequests).toEqual([])
  expect(request.response.status).toBe(403)
  expect(events.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ event: 'forwarder.settled', ok: false }))
})
