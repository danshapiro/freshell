import { describe, expect, it } from 'vitest'
import { waitForClearAdmissionAndRecheck, waitForNativeBatchCompletion, waitForNativeCheckpointRelease, waitForValueOrAbort } from '../../../crates/freshell-claude-sidecar/native-checkpoint-admission.mjs'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((finish, fail) => { resolve = finish; reject = fail })
  return { promise, resolve, reject }
}

function admissionState(readRecoverable: () => Promise<unknown>) {
  return {
    abort: new AbortController(),
    nativeAdmissionAbort: new AbortController(),
    nativeReady: true,
    queryGeneration: 7,
    nativeStore: { readRecoverable, inputState: async () => 'clear' },
    nativeContinuation: undefined,
    nativePendingOperation: undefined as any,
  }
}

const hookInput = (tool_use_id: string) => ({ tool_use_id, tool_input: { command: tool_use_id } })
const digestInput = (input: { command: string }) => input.command

describe('native checkpoint admission waiters', () => {
  it('does not settle a batch hook after the SDK stream ends during its wait', async () => {
    const tickStarted = deferred<void>()
    const tick = deferred<void>()
    const state = { nativeBatch: { complete: false }, nativeStreamEnded: false, nativeTransportClosing: false,
      nativeReady: true, queryGeneration: 7, abort: new AbortController(), nativeCallbacksRetired: new Promise<void>(() => {}) }
    let didSettle = false
    const waiting = waitForNativeBatchCompletion(state, 7, undefined,
      { timeoutMs: 1_000, waitForTick: () => { tickStarted.resolve(); return tick.promise } })
      .then((value) => { didSettle = true; return value })

    await tickStarted.promise
    state.nativeStreamEnded = true
    tick.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    expect(didSettle).toBe(false)
    void waiting
  })

  it('does not settle a batch hook when session shutdown aborts its transport', async () => {
    const tickStarted = deferred<void>()
    const tick = deferred<void>()
    const state = { nativeBatch: { complete: false }, nativeStreamEnded: false, nativeTransportClosing: false,
      nativeReady: true, queryGeneration: 7, abort: new AbortController(), nativeCallbacksRetired: new Promise<void>(() => {}) }
    let didSettle = false
    const waiting = waitForNativeBatchCompletion(state, 7, undefined,
      { timeoutMs: 1_000, waitForTick: () => { tickStarted.resolve(); return tick.promise } })
      .then((value) => { didSettle = true; return value })

    await tickStarted.promise
    state.nativeTransportClosing = true
    state.abort.abort()
    tick.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    expect(didSettle).toBe(false)
    void waiting
  })

  it('denies a batch hook canceled while its session remains live', async () => {
    const tickStarted = deferred<void>()
    const tick = deferred<void>()
    const hook = new AbortController()
    const state = { nativeBatch: { complete: false }, nativeStreamEnded: false, nativeTransportClosing: false,
      nativeReady: true, queryGeneration: 7, abort: new AbortController() }
    const waiting = waitForNativeBatchCompletion(state, 7, hook.signal,
      { timeoutMs: 1_000, waitForTick: () => { tickStarted.resolve(); return tick.promise } })

    await tickStarted.promise
    hook.abort()
    tick.resolve()
    await expect(waiting).resolves.toBe(false)
  })

  it('observes a supplied operation even when its signal was already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const operation = deferred<void>()

    await expect(waitForValueOrAbort(operation.promise, [controller.signal])).resolves.toEqual({ aborted: true })
    operation.reject(new Error('late store read failure'))
    await new Promise((resolve) => setImmediate(resolve))
  })

  it('settles a canceled waiter while the owning probe is still pending', async () => {
    const admission = deferred<'clear'>()
    const settled = deferred<void>()
    const invalidated = deferred<void>()
    const controller = new AbortController()
    let rechecks = 0
    const waiting = waitForClearAdmissionAndRecheck({
      pending: { admission: admission.promise, settled: settled.promise, invalidated: invalidated.promise },
      signals: [controller.signal],
      isCurrent: () => !controller.signal.aborted,
      recheck: async () => { rechecks += 1; return null },
    })

    controller.abort()
    await expect(waiting).resolves.toBe(false)
    expect(rechecks).toBe(0)
    admission.resolve('clear')
    settled.resolve()
  })

  it('does not proceed when the native query was replaced while waiting', async () => {
    const admission = deferred<'clear'>()
    const settled = deferred<void>()
    const invalidated = deferred<void>()
    let currentGeneration = 4
    let rechecks = 0
    const waiting = waitForClearAdmissionAndRecheck({
      pending: { admission: admission.promise, settled: settled.promise, invalidated: invalidated.promise },
      signals: [],
      isCurrent: () => currentGeneration === 4,
      recheck: async () => { rechecks += 1; return null },
    })

    currentGeneration += 1
    invalidated.resolve()
    await expect(waiting).resolves.toBe(false)
    expect(rechecks).toBe(0)
    admission.resolve('clear')
    settled.resolve()
  })

  it('settles a replaced waiter after clear admission but before owner cleanup', async () => {
    const admission = deferred<'clear'>()
    const settled = deferred<void>()
    const invalidated = deferred<void>()
    let rechecks = 0
    const waiting = waitForClearAdmissionAndRecheck({
      pending: { admission: admission.promise, settled: settled.promise, invalidated: invalidated.promise },
      signals: [],
      isCurrent: () => true,
      recheck: async () => { rechecks += 1; return null },
    })

    admission.resolve('clear')
    invalidated.resolve()
    await expect(waiting).resolves.toBe(false)
    expect(rechecks).toBe(0)
    settled.resolve()
  })

  it('leaves a waiter pending when the stream ends after owner cleanup but before its continuation', async () => {
    const admission = deferred<'clear'>()
    const settled = deferred<void>()
    const invalidated = deferred<void>()
    let streamEnded = false
    let rechecks = 0
    let didSettle = false
    const waiting = waitForClearAdmissionAndRecheck({
      pending: { admission: admission.promise, settled: settled.promise, invalidated: invalidated.promise,
        retired: new Promise<void>(() => {}) },
      signals: [],
      isCurrent: () => !streamEnded,
      isStreamEnded: () => streamEnded,
      recheck: async () => { rechecks += 1; return null },
    }).then((value) => { didSettle = true; return value })

    admission.resolve('clear')
    settled.resolve()
    streamEnded = true
    await new Promise((resolve) => setImmediate(resolve))
    expect(didSettle).toBe(false)
    expect(rechecks).toBe(0)
    void waiting
  })

  it('rechecks the store after a shared clear result before allowing the waiter', async () => {
    const admission = deferred<'clear'>()
    const settled = deferred<void>()
    const invalidated = deferred<void>()
    let storeState: 'clear' | 'blocked' = 'clear'
    let rechecks = 0
    const waiting = waitForClearAdmissionAndRecheck({
      pending: { admission: admission.promise, settled: settled.promise, invalidated: invalidated.promise },
      signals: [],
      isCurrent: () => true,
      recheck: async () => {
        rechecks += 1
        return storeState === 'clear' ? null : false
      },
    })

    storeState = 'blocked'
    admission.resolve('clear')
    settled.resolve()
    await expect(waiting).resolves.toBe(false)
    expect(rechecks).toBe(1)
  })

  it('rechecks a queued hook after the first clear inspection releases its pending slot', async () => {
    const firstRead = deferred<unknown>()
    const secondRead = deferred<unknown>()
    const firstInputState = deferred<string>()
    const secondInputState = deferred<string>()
    const firstInputStateStarted = deferred<void>()
    const secondReadStarted = deferred<void>()
    const secondInputStateStarted = deferred<void>()
    let readCount = 0
    let inputStateCount = 0
    const state = admissionState(() => {
      readCount += 1
      if (readCount === 1) return firstRead.promise
      secondReadStarted.resolve()
      return secondRead.promise
    })
    state.nativeStore.inputState = () => {
      inputStateCount += 1
      if (inputStateCount === 1) {
        firstInputStateStarted.resolve()
        return firstInputState.promise
      }
      secondInputStateStarted.resolve()
      return secondInputState.promise
    }

    const ownerResult = waitForNativeCheckpointRelease(state, hookInput('first-tool'), 7, undefined, digestInput)
    const firstPending = state.nativePendingOperation
    const waiterResult = waitForNativeCheckpointRelease(state, hookInput('second-tool'), 7, undefined, digestInput)
    firstRead.resolve(null)
    await firstInputStateStarted.promise
    firstInputState.resolve('clear')
    await expect(firstPending.admission).resolves.toBe('clear')
    await expect(ownerResult).resolves.toBeNull()
    await expect(firstPending.settled).resolves.toBeUndefined()

    await secondReadStarted.promise
    secondRead.resolve(null)
    await secondInputStateStarted.promise
    secondInputState.resolve('clear')

    await expect(waiterResult).resolves.toBeNull()
    expect(readCount).toBe(2)
    expect(inputStateCount).toBe(2)
    expect(state.nativePendingOperation).toBeUndefined()
  })

  it.each(['recoverable', 'blocked'] as const)('logs a concurrent hook denial when native input is %s', async (inputState) => {
    const firstRead = deferred<unknown>()
    const inputStateResult = deferred<string>()
    const inputStateStarted = deferred<void>()
    const state = admissionState(() => firstRead.promise)
    state.nativeStore.inputState = () => {
      inputStateStarted.resolve()
      return inputStateResult.promise
    }
    const events: unknown[][] = []
    const log = (...event: unknown[]) => events.push(event)
    const ownerResult = waitForNativeCheckpointRelease(state, hookInput('first-tool'), 7, undefined,
      digestInput, 'session-current', log)
    const pending = state.nativePendingOperation
    const waiterResult = waitForNativeCheckpointRelease(state, hookInput('second-tool'), 7, undefined,
      digestInput, 'session-current', log)

    firstRead.resolve(null)
    await inputStateStarted.promise
    inputStateResult.resolve(inputState)

    await expect(pending.admission).resolves.toBe('blocked')
    await expect(ownerResult).resolves.toBe(false)
    await expect(waiterResult).resolves.toBe(false)
    expect(events).toEqual([['info', 'native.concurrent_hook_denied', {
      sessionId: 'session-current', queryGeneration: 7, reason: 'concurrent_admission_not_clear',
    }]])
  })

  it('logs when the same native tool is already pending', async () => {
    const firstRead = deferred<unknown>()
    const state = admissionState(() => firstRead.promise)
    const events: unknown[][] = []
    const log = (...event: unknown[]) => events.push(event)
    const ownerResult = waitForNativeCheckpointRelease(state, hookInput('same-tool'), 7, undefined,
      digestInput, 'session-current', log)

    await expect(waitForNativeCheckpointRelease(state, hookInput('same-tool'), 7, undefined,
      digestInput, 'session-current', log)).resolves.toBe(false)

    firstRead.resolve(null)
    await expect(ownerResult).resolves.toBeNull()
    expect(events).toEqual([['info', 'native.concurrent_hook_denied', {
      sessionId: 'session-current', queryGeneration: 7, reason: 'same_tool_use_pending',
    }]])
  })

  it('cleans up a matching-checkpoint recheck when native-root reset invalidates its release', async () => {
    const firstRead = deferred<unknown>()
    const secondRead = deferred<unknown>()
    const secondReadStarted = deferred<void>()
    let reads = 0
    const state = admissionState(() => {
      reads += 1
      if (reads === 1) return firstRead.promise
      secondReadStarted.resolve()
      return secondRead.promise
    })

    const ownerResult = waitForNativeCheckpointRelease(state, hookInput('first-tool'), 7, undefined, digestInput)
    const waiterResult = waitForNativeCheckpointRelease(state, hookInput('second-tool'), 7, undefined, digestInput)
    const originalPending = state.nativePendingOperation
    firstRead.resolve(null)
    await expect(originalPending.admission).resolves.toBe('clear')
    await expect(originalPending.settled).resolves.toBeUndefined()
    await expect(ownerResult).resolves.toBeNull()

    await secondReadStarted.promise
    const recheckPending = state.nativePendingOperation
    secondRead.resolve({ toolUseID: 'second-tool', inputDigest: 'second-tool' })
    await expect(recheckPending.admission).resolves.toBe('claimed')

    state.nativeReady = false
    recheckPending.cancel()
    state.nativeAdmissionAbort.abort()
    state.nativeAdmissionAbort = new AbortController()
    await expect(waiterResult).resolves.toBe(false)
    expect(state.nativePendingOperation).toBeUndefined()
  })

  it('cleans up a fresh recheck when its waiting hook is aborted during store I/O', async () => {
    const firstRead = deferred<unknown>()
    const secondRead = deferred<unknown>()
    const secondReadStarted = deferred<void>()
    const controller = new AbortController()
    let reads = 0
    const state = admissionState(() => {
      reads += 1
      if (reads === 1) return firstRead.promise
      secondReadStarted.resolve()
      return secondRead.promise
    })

    const ownerResult = waitForNativeCheckpointRelease(state, hookInput('first-tool'), 7, undefined, digestInput)
    const waiterResult = waitForNativeCheckpointRelease(state, hookInput('second-tool'), 7, controller.signal, digestInput)
    const originalPending = state.nativePendingOperation
    firstRead.resolve(null)
    await expect(originalPending.admission).resolves.toBe('clear')
    await expect(originalPending.settled).resolves.toBeUndefined()
    await expect(ownerResult).resolves.toBeNull()

    await secondReadStarted.promise
    controller.abort()
    await expect(waiterResult).resolves.toBe(false)
    expect(state.nativePendingOperation).toBeUndefined()
    secondRead.resolve(null)
  })
})
