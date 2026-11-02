// @vitest-environment node
import { expect, it, vi } from 'vitest'

import { cleanupManagedCodexParity, collectManagedCodexProviderDiagnostics } from '../../helpers/codex-managed-cleanup.js'

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
    finalObservation: vi.fn(async () => ({ state: 'final' })),
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
