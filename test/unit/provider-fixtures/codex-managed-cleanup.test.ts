// @vitest-environment node
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'

import { cleanupManagedCodexParity, collectManagedCodexProviderDiagnostics } from '../../helpers/codex-managed-cleanup.js'

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: vi.fn(),
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function flushMicrotasks() {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

function nestedErrors(value: unknown, seen = new Set<unknown>()): unknown[] {
  if (value === null || value === undefined || seen.has(value)) return []
  seen.add(value)
  if (typeof value !== 'object') return [value]
  const error = value as { cause?: unknown; errors?: unknown[] }
  return [value, ...nestedErrors(error.cause, seen), ...(error.errors ?? []).flatMap(item => nestedErrors(item, seen))]
}

function fixture() {
  const order: string[] = []
  const owner = { installationId: 'fixture-installation', soulId: 'fixture-soul', providerVolumeName: 'owned-volume',
    imageRef: 'fixture-image', hostBinaryPath: '/virtual/host', binarySha256: 'a'.repeat(64), daemonId: 'fixture-daemon' }
  const captured = [{ owner, labels: {} }]
  const owners = [owner]
  const rig = {
    stop: vi.fn(async () => { order.push('runtime'); return { ok: true, errors: [] as string[] } }),
    runtime: { writeIncident: vi.fn((_name: string, _value: unknown) => { order.push('incident') }) },
  }
  const resources = {
    rig,
    owners,
    wire: { close: vi.fn(async () => { order.push('wire') }) },
    model: { stop: vi.fn(async () => { order.push('model') }) },
    finalObservation: vi.fn(async (_signal: AbortSignal) => ({ state: 'final' })),
    naming: {
      closeAllConnections: vi.fn(() => { order.push('naming-connections') }),
      close: vi.fn((callback: () => void) => { order.push('naming'); callback() }),
    },
    restoreGrants: vi.fn(() => { order.push('restore') }),
    grantsDirectory: '/virtual/grants',
    home: '/virtual/home',
  }
  const dependencies = {
    captureVolumes: vi.fn((_owners: unknown[], _budgetMs?: number) => { order.push('capture'); return captured }),
    removeVolumes: vi.fn((_volumes: unknown[], _budgetMs?: number) => { order.push('volumes'); return ['owned-volume'] }),
    removeDirectory: vi.fn((directory: string) => { order.push(directory) }),
  }
  return { order, rig, resources, dependencies, owners, captured }
}

it('awaits both failed closes and still stops the owned runtime, preserving both errors', async () => {
  const f = fixture()
  const wire = deferred()
  const model = deferred()
  const wireFailure = new Error('wire close failed')
  const modelFailure = new Error('model stop failed')
  f.resources.wire.close.mockImplementation(() => { f.order.push('wire'); return wire.promise })
  f.resources.model.stop.mockImplementation(() => { f.order.push('model'); return model.promise })
  const observed = cleanupManagedCodexParity(f.resources, f.dependencies).then(() => undefined, error => error)
  await flushMicrotasks()
  if (f.order.includes('wire')) {
    wire.reject(wireFailure)
    await flushMicrotasks()
    expect(f.order).toContain('model')
    model.reject(modelFailure)
  } else {
    expect(f.order).toContain('model')
    model.reject(modelFailure)
    await flushMicrotasks()
    expect(f.order).toContain('wire')
    wire.reject(wireFailure)
  }
  const error = await observed
  expect(nestedErrors(error)).toEqual(expect.arrayContaining([wireFailure, modelFailure]))
  expect(f.rig.stop).toHaveBeenCalledOnce()
  expect(f.dependencies.captureVolumes).toHaveBeenCalledOnce()
  expect(f.dependencies.captureVolumes.mock.calls[0][0]).toEqual(f.owners)
  expect(f.dependencies.removeVolumes).toHaveBeenCalledOnce()
  expect(f.dependencies.removeVolumes.mock.calls[0][0]).toEqual(f.captured)
  expect(f.order.indexOf('capture')).toBeLessThan(f.order.indexOf('runtime'))
  expect(f.order.indexOf('runtime')).toBeLessThan(f.order.indexOf('volumes'))
  expect(f.resources.restoreGrants).toHaveBeenCalledOnce()
  expect(f.dependencies.removeDirectory.mock.calls.map(([directory]) => directory))
    .toEqual(expect.arrayContaining(['/virtual/grants', '/virtual/home']))
  expect(f.dependencies.removeDirectory).toHaveBeenCalledTimes(2)
})

it.each(['final observation', 'fixture stop'])(
  'cancels and joins a stalled owned probe during %s before the hook expires', async stage => {
    vi.useFakeTimers()
    const f = fixture()
    const probe = deferred()
    const workFinishing = deferred()
    const runtimeFinishing = deferred()
    const cancelled = new Error(`owned ${stage} probe cancelled`)
    let activeProbe = false
    let workSettled = false
    let runtimeSettled = false
    let cleanupSettled = false

    const stalledWork = async () => {
      activeProbe = true
      try { await probe.promise }
      catch (error) {
        activeProbe = false
        // Probe settlement and its caller's settlement are separate events.
        await workFinishing.promise
        throw error
      } finally { workSettled = true }
    }
    if (stage === 'final observation') {
      f.resources.finalObservation.mockImplementation(async () => {
        await stalledWork()
        return { state: 'final' }
      })
    } else {
      f.resources.model.stop.mockImplementation(stalledWork)
    }
    f.rig.stop.mockImplementation(async () => {
      f.order.push('runtime')
      // ManagedRuntimeOwner.stop cancels and joins its currently owned probes.
      probe.reject(cancelled)
      await probe.promise.catch(() => {})
      await runtimeFinishing.promise
      runtimeSettled = true
      return { ok: true, errors: [] }
    })
    const observed = cleanupManagedCodexParity(f.resources, f.dependencies).then(
      () => { cleanupSettled = true; return undefined },
      error => { cleanupSettled = true; return error },
    )
    try {
      await flushMicrotasks()
      expect(activeProbe).toBe(true)
      // Reaching the owner within the first minute leaves the rest of the
      // real afterAll budget for its own cleanup and broker drain.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(f.rig.stop).toHaveBeenCalledOnce()
      expect(activeProbe).toBe(false)
      expect(cleanupSettled).toBe(false)
      expect(f.dependencies.removeDirectory).not.toHaveBeenCalled()

      runtimeFinishing.resolve()
      await flushMicrotasks()
      expect(runtimeSettled).toBe(true)
      expect(workSettled).toBe(false)
      expect(cleanupSettled).toBe(false)
      expect(f.dependencies.removeDirectory).not.toHaveBeenCalled()

      workFinishing.resolve()
      const result = await observed
      expect(workSettled).toBe(true)
      expect(activeProbe).toBe(false)
      expect(cleanupSettled).toBe(true)
      if (stage === 'final observation') {
        expect(f.rig.runtime.writeIncident).toHaveBeenCalledWith(
          'freshcodex-managed-native-final-state-error', { error: String(cancelled) },
        )
      } else {
        expect(nestedErrors(result)).toContain(cancelled)
      }
      expect(f.resources.restoreGrants).toHaveBeenCalledOnce()
      expect(f.dependencies.removeDirectory).toHaveBeenCalledTimes(2)
    } finally {
      // Settle even the deliberately failing pre-fix path without starting
      // any real process or leaving a pending test-owned promise.
      probe.reject(cancelled)
      workFinishing.resolve()
      runtimeFinishing.resolve()
      await flushMicrotasks()
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  },
)

it.each(['confirmed', 'unconfirmed'])(
  'settles cleanup within the hook after a finite slow volume capture (%s owner)', async ownerOutcome => {
    vi.useFakeTimers()
    const f = fixture()
    const observation = deferred()
    const startedAt = Date.now()
    let observationSettled = false
    let ownerSettled = false
    let removedPrematurely = false
    let cleanupFinishedAt: number | undefined
    const captureFailure = new Error('controlled volume capture exceeded its time budget')
    // Model the three finite Docker calls in volume capture consuming their
    // individual 120-second timeouts without allocating, sleeping, or Docker.
    f.dependencies.captureVolumes.mockImplementation((_owners, budgetMs = 3 * 120_000) => {
      f.order.push('capture')
      const spent = Math.min(3 * 120_000, budgetMs)
      vi.setSystemTime(Date.now() + spent)
      if (spent < 3 * 120_000) throw captureFailure
      return f.captured
    })
    f.resources.finalObservation.mockImplementation(async () => {
      await observation.promise
      observationSettled = true
      return { state: 'final' }
    })
    f.rig.stop.mockImplementation(async () => {
      f.order.push('runtime')
      observation.resolve()
      await flushMicrotasks()
      // Model a separate finite owner settlement: a 120-second native capture,
      // the existing 90-second broker drain, and 30 seconds of further cleanup.
      vi.setSystemTime(Date.now() + 240_000)
      ownerSettled = true
      return ownerOutcome === 'confirmed'
        ? { ok: true, errors: [] }
        : { ok: false, errors: ['runtime ownership settlement failed'] }
    })
    f.dependencies.removeVolumes.mockImplementation(() => {
      removedPrematurely ||= !ownerSettled || !observationSettled
      return []
    })
    const observed = cleanupManagedCodexParity(f.resources, f.dependencies)
      .then(() => { cleanupFinishedAt = Date.now(); return undefined }, error => { cleanupFinishedAt = Date.now(); return error })
    try {
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(30_000)
      const result = await observed
      expect(cleanupFinishedAt).toBeDefined()
      expect(cleanupFinishedAt! - startedAt).toBeLessThanOrEqual(600_000)
      expect(ownerSettled).toBe(true)
      expect(observationSettled).toBe(true)
      expect(removedPrematurely).toBe(false)
      expect(nestedErrors(result).map(String).join(' ')).toContain('grace period')
      expect(nestedErrors(result)).toContain(captureFailure)
      expect(f.dependencies.removeVolumes).not.toHaveBeenCalled()
      if (ownerOutcome === 'unconfirmed') {
        expect(nestedErrors(result).map(String).join(' ')).toContain('runtime ownership settlement failed')
        expect(f.dependencies.removeDirectory).not.toHaveBeenCalled()
      }
    } finally {
      observation.resolve()
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  },
)

it('does not begin a later provider diagnostic after cancellation of the first', async () => {
  const first = deferred()
  const failure = new Error('first owned provider read cancelled')
  const controller = new AbortController()
  const traffic = vi.fn(async () => [{ index: 1 }])
  const observed = collectManagedCodexProviderDiagnostics(controller.signal, () => first.promise, traffic, [])
    .then(value => value, error => error)

  controller.abort()
  first.reject(failure)
  const result = await observed
  expect(traffic).not.toHaveBeenCalled()
  expect(result).toBe(failure)
})

it('retains a failed first provider diagnostic and still collects traffic when not cancelled', async () => {
  const failure = new Error('first provider diagnostic failed')
  const traffic = vi.fn(async () => [{ index: 1 }])
  const result = await collectManagedCodexProviderDiagnostics(
    new AbortController().signal, async () => { throw failure }, traffic, [],
  )
  expect(result).toEqual({ nativeFiles: { error: String(failure) }, traffic: [{ index: 1 }] })
  expect(traffic).toHaveBeenCalledOnce()
})

it('records a final-observation failure and cleans up when startup never assigned a model', async () => {
  const f = fixture()
  const failure = new Error('final observation failed')
  f.resources.finalObservation.mockRejectedValue(failure)
  await cleanupManagedCodexParity({ ...f.resources, model: undefined }, f.dependencies)
  expect(f.rig.runtime.writeIncident).toHaveBeenCalledWith(
    'freshcodex-managed-native-final-state-error', { error: String(failure) },
  )
  expect(f.rig.stop).toHaveBeenCalledOnce()
  expect(f.dependencies.removeVolumes).toHaveBeenCalledOnce()
  expect(f.resources.restoreGrants).toHaveBeenCalledOnce()
})

it('stops the runtime after volume capture fails and does not remove unproven volumes', async () => {
  const f = fixture()
  const failure = new Error('volume capture failed')
  f.dependencies.captureVolumes.mockImplementation(() => { f.order.push('capture'); throw failure })
  const error = await cleanupManagedCodexParity(f.resources, f.dependencies).then(() => undefined, reason => reason)
  expect(nestedErrors(error)).toContain(failure)
  expect(f.rig.stop).toHaveBeenCalledOnce()
  expect(f.dependencies.removeVolumes).not.toHaveBeenCalled()
  expect(f.resources.restoreGrants).toHaveBeenCalledOnce()
  expect(f.dependencies.removeDirectory).toHaveBeenCalledTimes(2)
})

it.each(['returns a failure', 'throws'])(
  'retains fixture paths and volumes when runtime stop %s', async mode => {
    const f = fixture()
    const failure = new Error('runtime stop failed')
    const restoreFailure = new Error('grant restoration failed')
    f.rig.stop.mockImplementation(async () => {
      f.order.push('runtime')
      if (mode === 'throws') throw failure
      return { ok: false, errors: ['runtime stop failed'] }
    })
    f.resources.restoreGrants.mockImplementation(() => { f.order.push('restore'); throw restoreFailure })
    const error = await cleanupManagedCodexParity(f.resources, f.dependencies).then(() => undefined, reason => reason)
    if (mode === 'throws') expect(nestedErrors(error)).toContain(failure)
    expect(nestedErrors(error)).toContain(restoreFailure)
    expect(nestedErrors(error).some(value => String(value).includes('runtime stop failed'))).toBe(true)
    expect(f.dependencies.removeVolumes).not.toHaveBeenCalled()
    expect(f.dependencies.removeDirectory).not.toHaveBeenCalled()
    const diagnostics = nestedErrors(error).map(String).join('\n')
    expect(diagnostics).toContain('/virtual/grants')
    expect(diagnostics).toContain('/virtual/home')
    expect(f.resources.naming.closeAllConnections).toHaveBeenCalledOnce()
    expect(f.resources.naming.close).toHaveBeenCalledOnce()
    expect(f.resources.restoreGrants).toHaveBeenCalledOnce()
  },
)

it('attempts both directories and reports restoration and directory errors after a successful stop', async () => {
  const f = fixture()
  const restoreFailure = new Error('grant restoration failed')
  const directoryFailure = new Error('grant directory cleanup failed')
  f.resources.restoreGrants.mockImplementation(() => { f.order.push('restore'); throw restoreFailure })
  f.dependencies.removeDirectory.mockImplementation(directory => {
    f.order.push(directory)
    if (directory === '/virtual/grants') throw directoryFailure
  })
  const error = await cleanupManagedCodexParity(f.resources, f.dependencies).then(() => undefined, reason => reason)
  expect(nestedErrors(error)).toEqual(expect.arrayContaining([restoreFailure, directoryFailure]))
  expect(f.dependencies.removeVolumes).toHaveBeenCalledOnce()
  expect(f.resources.naming.closeAllConnections).toHaveBeenCalledOnce()
  expect(f.resources.naming.close).toHaveBeenCalledOnce()
  expect(f.dependencies.removeDirectory.mock.calls.map(([directory]) => directory))
    .toEqual(expect.arrayContaining(['/virtual/grants', '/virtual/home']))
  expect(f.dependencies.removeDirectory).toHaveBeenCalledTimes(2)
})

it('removes owned fixture paths when setup failed before runtime creation', async () => {
  const f = fixture()
  await cleanupManagedCodexParity({ ...f.resources, rig: undefined, wire: undefined, model: undefined,
    finalObservation: undefined }, f.dependencies)
  expect(f.dependencies.captureVolumes).not.toHaveBeenCalled()
  expect(f.dependencies.removeVolumes).not.toHaveBeenCalled()
  expect(f.resources.restoreGrants).toHaveBeenCalledOnce()
  expect(f.dependencies.removeDirectory.mock.calls.map(([directory]) => directory))
    .toEqual(expect.arrayContaining(['/virtual/grants', '/virtual/home']))
  expect(f.dependencies.removeDirectory).toHaveBeenCalledTimes(2)
})

// The path and Docker I/O boundaries are simulated; the helper itself must
// bind and check the same environment that the independently qualified guest
// supplies to the installed-Codex test.
function qualifiedGuest(order: string[] = []) {
  const env = {
    FRESHELL_TASK4_GUEST_QUALIFIED: '1',
    FRESHELL_TASK4_INSTALLED_CLEANUP_GUARD: '1',
    FRESHELL_TASK4_DAEMON_ID: 'qualified-daemon',
    FRESHELL_TASK4_DOCKER_SOCKET: '/qualified/docker.sock',
    FRESHELL_TASK4_DOCKER_CLI: '/qualified/bin/docker',
    DOCKER_HOST: 'unix:///qualified/docker.sock',
    DOCKER_CONTEXT: undefined,
    DOCKER_CERT_PATH: undefined,
    DOCKER_TLS_VERIFY: undefined,
    PATH: '/qualified/bin',
  }
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)

  const realpath = fs.realpathSync
  const access = fs.accessSync
  const stat = fs.statSync
  vi.spyOn(fs, 'realpathSync').mockImplementation(((input: fs.PathLike) => {
    if (String(input).startsWith('/qualified/')) return String(input)
    return realpath(input)
  }) as typeof fs.realpathSync)
  vi.spyOn(fs, 'accessSync').mockImplementation((input, mode) => {
    if (String(input) === '/qualified/bin/docker') return
    if (String(input).startsWith('/different/')) throw new Error('not an executable')
    return access(input, mode)
  })
  vi.spyOn(fs, 'statSync').mockImplementation(((input: fs.PathLike) => {
    if (String(input) === '/qualified/bin/docker') return { isFile: () => true } as fs.Stats
    if (String(input) === '/qualified/docker.sock') return { isSocket: () => true } as fs.Stats
    return stat(input)
  }) as typeof fs.statSync)

  const info = vi.mocked(execFileSync)
  info.mockReset()
  info.mockImplementation((() => { order.push('daemon'); return 'qualified-daemon' }) as typeof execFileSync)
  return info
}

function expectRetainedWithLocalCleanup(f: ReturnType<typeof fixture>, error: unknown) {
  expect(error).toBeInstanceOf(AggregateError)
  expect(nestedErrors(error).map(String).join('\n')).toContain('daemon')
  expect(f.rig.stop).not.toHaveBeenCalled()
  expect(f.dependencies.removeVolumes).not.toHaveBeenCalled()
  expect(f.dependencies.removeDirectory).not.toHaveBeenCalled()
  expect(f.resources.wire.close).toHaveBeenCalledOnce()
  expect(f.resources.naming.closeAllConnections).toHaveBeenCalledOnce()
  expect(f.resources.naming.close).toHaveBeenCalledOnce()
  expect(f.resources.restoreGrants).toHaveBeenCalledOnce()
}

it.each(['changed', 'unavailable'])(
  'retains an early assigned runtime with no owners when the qualified daemon is %s', async state => {
    const f = fixture()
    const info = qualifiedGuest(f.order)
    if (state === 'changed') info.mockReturnValue('replacement-daemon' as never)
    else info.mockImplementation(() => { throw new Error('private Docker stderr SECRET_VALUE') })
    const work = { cancel: vi.fn(() => false), join: vi.fn(async () => {}) }

    const error = await cleanupManagedCodexParity({ ...f.resources, owners: [], fixtureWork: work }, f.dependencies)
      .then(() => undefined, reason => reason)

    expectRetainedWithLocalCleanup(f, error)
    expect(f.resources.finalObservation).not.toHaveBeenCalled()
    expect(f.rig.runtime.writeIncident).not.toHaveBeenCalled()
    expect(f.resources.model.stop).not.toHaveBeenCalled()
    expect(f.dependencies.captureVolumes).not.toHaveBeenCalled()
    expect(work.cancel).toHaveBeenCalledOnce()
    expect(work.join).toHaveBeenCalledOnce()
    expect(nestedErrors(error).map(String).join('\n')).not.toContain('SECRET_VALUE')
  },
)

it.each([
  ['missing guest qualification', 'FRESHELL_TASK4_GUEST_QUALIFIED', ''],
  ['missing daemon identity', 'FRESHELL_TASK4_DAEMON_ID', ''],
  ['malformed daemon identity', 'FRESHELL_TASK4_DAEMON_ID', 'bad\nidentity'],
  ['relative socket', 'FRESHELL_TASK4_DOCKER_SOCKET', 'docker.sock'],
  ['relative CLI', 'FRESHELL_TASK4_DOCKER_CLI', 'docker'],
  ['different effective socket', 'DOCKER_HOST', 'unix:///different/docker.sock'],
  ['Docker context override', 'DOCKER_CONTEXT', 'other-context'],
  ['Docker certificate override', 'DOCKER_CERT_PATH', '/different/certs'],
  ['Docker TLS override', 'DOCKER_TLS_VERIFY', '1'],
  ['different effective CLI', 'PATH', '/different/bin'],
])('rejects a qualified cleanup with %s before contacting Docker', async (_description, key, value) => {
  const f = fixture()
  const info = qualifiedGuest()
  vi.stubEnv(key, value)
  const error = await cleanupManagedCodexParity({ ...f.resources, owners: [] }, f.dependencies)
    .then(() => undefined, reason => reason)
  expectRetainedWithLocalCleanup(f, error)
  expect(info).not.toHaveBeenCalled()
  expect(f.resources.finalObservation).not.toHaveBeenCalled()
  expect(f.resources.model.stop).not.toHaveBeenCalled()
  expect(f.dependencies.captureVolumes).not.toHaveBeenCalled()
})

it('checks the environment-bound daemon before observations and again immediately before owner stop', async () => {
  const f = fixture()
  const info = qualifiedGuest(f.order)
  await cleanupManagedCodexParity(f.resources, f.dependencies)

  expect(info).toHaveBeenCalledTimes(2)
  expect(info).toHaveBeenCalledWith('docker', ['info', '--format', '{{.ID}}'], expect.objectContaining({ timeout: expect.any(Number) }))
  expect(f.order).toEqual([
    'daemon', 'incident', 'wire', 'model', 'capture', 'daemon', 'runtime', 'volumes',
    'naming-connections', 'naming', 'restore', '/virtual/grants', '/virtual/home',
  ])
})

it('retains captured resources when the daemon changes before the actual owner stop', async () => {
  const f = fixture()
  const info = qualifiedGuest(f.order)
  info.mockImplementationOnce((() => { f.order.push('daemon'); return 'qualified-daemon' }) as typeof execFileSync)
  info.mockImplementationOnce((() => { f.order.push('daemon'); return 'replacement-daemon' }) as typeof execFileSync)
  const error = await cleanupManagedCodexParity(f.resources, f.dependencies).then(() => undefined, reason => reason)

  expectRetainedWithLocalCleanup(f, error)
  expect(f.resources.finalObservation).toHaveBeenCalledOnce()
  expect(f.resources.model.stop).toHaveBeenCalledOnce()
  expect(f.dependencies.captureVolumes).toHaveBeenCalledOnce()
  expect(info).toHaveBeenCalledTimes(2)
  expect(f.order.indexOf('capture')).toBeLessThan(f.order.lastIndexOf('daemon'))
})

it.each([
  ['effective socket', 'DOCKER_HOST', 'unix:///different/docker.sock'],
  ['effective CLI', 'PATH', '/different/bin'],
  ['context', 'DOCKER_CONTEXT', 'other-context'],
])('rechecks the %s immediately before stop', async (_description, key, value) => {
  const f = fixture()
  const info = qualifiedGuest()
  f.dependencies.captureVolumes.mockImplementation(() => {
    vi.stubEnv(key, value)
    return f.captured
  })
  const error = await cleanupManagedCodexParity(f.resources, f.dependencies).then(() => undefined, reason => reason)
  expectRetainedWithLocalCleanup(f, error)
  expect(info).toHaveBeenCalledOnce()
  expect(f.dependencies.captureVolumes).toHaveBeenCalledOnce()
})

it('keeps the original admitted daemon identity when its environment value changes during cleanup', async () => {
  const f = fixture()
  const info = qualifiedGuest()
  f.dependencies.captureVolumes.mockImplementation(() => {
    vi.stubEnv('FRESHELL_TASK4_DAEMON_ID', 'replacement-daemon')
    return f.captured
  })
  info.mockReturnValueOnce('qualified-daemon' as never).mockReturnValueOnce('replacement-daemon' as never)
  const error = await cleanupManagedCodexParity(f.resources, f.dependencies).then(() => undefined, reason => reason)
  expectRetainedWithLocalCleanup(f, error)
})

it('checks the daemon on the grace-timer owner-stop path', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const info = qualifiedGuest()
  info.mockReturnValueOnce('qualified-daemon' as never).mockReturnValueOnce('replacement-daemon' as never)
  const observation = deferred()
  f.resources.finalObservation.mockImplementation(async signal => {
    signal.addEventListener('abort', () => observation.reject(new Error('observation cancelled')), { once: true })
    await observation.promise
    return { state: 'final' }
  })
  const result = cleanupManagedCodexParity(f.resources, f.dependencies).then(() => undefined, reason => reason)
  try {
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(30_000)
    const error = await result
    expectRetainedWithLocalCleanup(f, error)
    expect(info).toHaveBeenCalledTimes(2)
    expect(nestedErrors(error).map(String).join('\n')).toContain('grace period')
  } finally {
    observation.resolve()
    await flushMicrotasks()
    vi.clearAllTimers()
  }
})

it('reports unresolved work rather than waiting forever when the changed daemon cannot stop an active probe', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const info = qualifiedGuest()
  info.mockReturnValueOnce('qualified-daemon' as never).mockReturnValueOnce('replacement-daemon' as never)
  const observation = deferred()
  let finished = false
  f.resources.finalObservation.mockImplementation(async () => { await observation.promise; return { state: 'final' } })
  const result = cleanupManagedCodexParity(f.resources, f.dependencies).then(
    () => { finished = true; return undefined }, error => { finished = true; return error },
  )
  try {
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(finished).toBe(true)
    const error = await result
    expectRetainedWithLocalCleanup(f, error)
    expect(nestedErrors(error).map(String).join('\n')).toContain('unresolved')
  } finally {
    observation.resolve()
    await flushMicrotasks()
    vi.clearAllTimers()
  }
})

it('reports unresolved fixture work after a failed identity check and retains its directories', async () => {
  vi.useFakeTimers()
  const f = fixture()
  qualifiedGuest().mockReturnValue('replacement-daemon' as never)
  const joining = deferred()
  const work = { cancel: vi.fn(() => true), join: vi.fn(() => joining.promise) }
  let finished = false
  const result = cleanupManagedCodexParity({ ...f.resources, fixtureWork: work }, f.dependencies).then(
    () => { finished = true; return undefined }, error => { finished = true; return error },
  )
  try {
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(finished).toBe(true)
    const error = await result
    expectRetainedWithLocalCleanup(f, error)
    expect(work.cancel).toHaveBeenCalledOnce()
    expect(work.join).toHaveBeenCalledOnce()
    expect(nestedErrors(error).map(String).join('\n')).toContain('unresolved')
  } finally {
    joining.resolve()
    await flushMicrotasks()
    vi.clearAllTimers()
  }
})

it('still stops a confirmed qualified owner after volume capture fails', async () => {
  const f = fixture()
  const info = qualifiedGuest()
  const failure = new Error('volume capture failed')
  f.dependencies.captureVolumes.mockImplementation(() => { throw failure })
  const error = await cleanupManagedCodexParity(f.resources, f.dependencies).then(() => undefined, reason => reason)
  expect(nestedErrors(error)).toContain(failure)
  expect(info).toHaveBeenCalledTimes(2)
  expect(f.rig.stop).toHaveBeenCalledOnce()
  expect(f.dependencies.removeVolumes).not.toHaveBeenCalled()
  expect(f.dependencies.removeDirectory).toHaveBeenCalledTimes(2)
})

it('keeps no-rig cleanup harmless even when qualified guest inputs are unavailable', async () => {
  const f = fixture()
  const info = qualifiedGuest()
  vi.stubEnv('FRESHELL_TASK4_DAEMON_ID', '')
  await cleanupManagedCodexParity({ ...f.resources, rig: undefined, wire: undefined, model: undefined,
    finalObservation: undefined }, f.dependencies)
  expect(info).not.toHaveBeenCalled()
  expect(f.dependencies.captureVolumes).not.toHaveBeenCalled()
  expect(f.dependencies.removeVolumes).not.toHaveBeenCalled()
  expect(f.dependencies.removeDirectory).toHaveBeenCalledTimes(2)
  expect(f.resources.restoreGrants).toHaveBeenCalledOnce()
})

it('leaves the common qualified lifecycle unchanged without the installed cleanup opt-in', async () => {
  const f = fixture()
  const info = qualifiedGuest()
  vi.stubEnv('FRESHELL_TASK4_INSTALLED_CLEANUP_GUARD', undefined)
  vi.stubEnv('FRESHELL_TASK4_DAEMON_ID', '')
  await cleanupManagedCodexParity(f.resources, f.dependencies)
  expect(info).not.toHaveBeenCalled()
  expect(f.rig.stop).toHaveBeenCalledOnce()
  expect(f.dependencies.removeVolumes).toHaveBeenCalledOnce()
  expect(f.dependencies.removeDirectory).toHaveBeenCalledTimes(2)
})

it('leaves ordinary nonqualified cleanup unchanged', async () => {
  const f = fixture()
  const info = qualifiedGuest()
  vi.stubEnv('FRESHELL_TASK4_INSTALLED_CLEANUP_GUARD', undefined)
  vi.stubEnv('FRESHELL_TASK4_GUEST_QUALIFIED', undefined)
  await cleanupManagedCodexParity(f.resources, f.dependencies)
  expect(info).not.toHaveBeenCalled()
  expect(f.rig.stop).toHaveBeenCalledOnce()
  expect(f.dependencies.removeVolumes).toHaveBeenCalledOnce()
  expect(f.dependencies.removeDirectory).toHaveBeenCalledTimes(2)
})
