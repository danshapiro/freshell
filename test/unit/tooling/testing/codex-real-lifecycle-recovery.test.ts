// @vitest-environment node
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// These controls intercept only the draft harness's external operations.
// There are no Docker clients, subprocesses, sockets, or real fixture files.
const control = vi.hoisted(() => ({
  exec: vi.fn(),
  reads: new Map<string, unknown>(),
  stats: new Map<string, unknown>(),
  owner: undefined as unknown,
  cleanup: undefined as undefined | ((...args: unknown[]) => Promise<void>),
}))

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: control.exec }
})

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs') & { default: typeof import('node:fs') }>()
  const fake = new Proxy(actual.default, {
    get(target, property, receiver) {
      if (property === 'readFileSync' || property === 'lstatSync') {
        return (...args: unknown[]) => {
          const overrides = property === 'readFileSync' ? control.reads : control.stats
          const key = String(args[0])
          if (overrides.has(key)) {
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function flushMicrotasks() {
  for (let i = 0; i < 16; i++) await Promise.resolve()
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
  control.reads.clear()
  control.stats.clear()
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

  const failure = await settle(volumeState(f.fixture, stop)).then(() => undefined, error => error)

  expect(stop).toHaveBeenCalledOnce()
  expect(failure).toBeInstanceOf(Error)
  expect(f.docker.removals).toBe(0)
  expect(f.docker.present).toBe(true)
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

it('bounds the complete fallback capture before attempting owner stop', async () => {
  const f = volumeFixture()
  let now = 0
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  mockDocker(f, (args, timeout) => {
    const cost = (args[0] === 'volume' && args[1] === 'ls') || args[0] === 'info' ? 6000 : 0
    if (cost > timeout) {
      now += timeout
      throw Object.assign(new Error('controlled daemon command timeout'), { code: 'ETIMEDOUT' })
    }
    now += cost
  })
  let stopStartedAt = -1
  const stop = vi.fn(async () => {
    stopStartedAt = now
    return { ok: true, errors: [] as string[] }
  })

  const failure = await settle(volumeState(f.fixture, stop)).then(() => undefined, error => error)

  expect(stop).toHaveBeenCalledOnce()
  expect.soft(control.exec.mock.calls.some(([, args]) => args[0] === 'info')).toBe(true)
  expect.soft(stopStartedAt).toBeGreaterThanOrEqual(6000)
  expect.soft(stopStartedAt).toBeLessThanOrEqual(10_000)
  expect.soft(f.docker.present).toBe(true)
  expect.soft(nestedErrors(failure).some(error => error instanceof Error && error.message === 'controlled daemon command timeout')).toBe(true)
})

it('reports original and teardown phases without emitting raw failure details', async () => {
  const original = new Error('synthetic-original-secret-marker')
  const ownerError = 'synthetic-owner-secret-marker'
  const stop = vi.fn(async () => ({ ok: false, errors: [ownerError] }))
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
    expect.objectContaining({ phase: 'case', kind: 'operation' }),
    expect.objectContaining({ phase: 'owner_stop', kind: 'reported_failure' }),
  ]))
  expect.soft(output.join('')).not.toContain(original.message)
  expect.soft(output.join('')).not.toContain(ownerError)
})
