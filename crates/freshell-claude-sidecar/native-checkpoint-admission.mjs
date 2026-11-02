export function waitForValueOrAbort(value, signals) {
  const observed = Promise.resolve(value).then(
    (resolved) => ({ aborted: false, value: resolved }),
    () => ({ aborted: true }),
  )
  const activeSignals = [...new Set(signals.filter(Boolean))]
  if (activeSignals.some((signal) => signal.aborted)) return Promise.resolve({ aborted: true })

  return new Promise((resolve) => {
    let settled = false
    const listeners = []
    const finish = (result) => {
      if (settled) return
      settled = true
      for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener)
      resolve(result)
    }
    observed.then(finish)
    for (const signal of activeSignals) {
      const listener = () => finish({ aborted: true })
      listeners.push([signal, listener])
      signal.addEventListener('abort', listener, { once: true })
      if (signal.aborted) {
        finish({ aborted: true })
        return
      }
    }
  })
}

/** Waits for the current assistant batch without settling hooks after teardown. */
export async function waitForNativeBatchCompletion(state, generation, hookSignal, {
  timeoutMs = 100,
  waitForTick = () => new Promise((resolve) => setTimeout(resolve, 1)),
} = {}) {
  const retired = () => state.nativeStreamEnded || state.nativeTransportClosing
  const deadline = Date.now() + timeoutMs
  while (!state.nativeBatch?.complete && Date.now() < deadline && !retired()
    && state.queryGeneration === generation && state.nativeReady
    && !state.abort.signal.aborted && !hookSignal?.aborted) {
    await waitForTick()
  }
  if (retired()) return await (state.nativeCallbacksRetired ?? new Promise(() => {}))
  if (state.queryGeneration !== generation || !state.nativeReady
    || state.abort.signal.aborted || hookSignal?.aborted) return false
  return true
}

function isTransportRetired(state, pendingOperation) {
  return state.nativeStreamEnded || state.nativeTransportClosing || pendingOperation?.isStreamEnded()
}

/** Waits on a current clear result, then performs a fresh admission check. */
export async function waitForClearAdmissionAndRecheck({ pending, signals, isCurrent, isStreamEnded, recheck }) {
  const retired = () => isStreamEnded?.() || pending.isStreamEnded?.()
  const stayPending = () => pending.retired
  if (retired()) return await stayPending()
  if (!isCurrent()) return false
  const decision = await waitForValueOrAbort(Promise.race([
    pending.admission.then((value) => ({ admission: value })),
    pending.invalidated.then(() => ({ invalidated: true })),
  ]), signals)
  if (decision.aborted) return retired() ? await stayPending() : false
  if (retired()) return await stayPending()
  if (decision.value?.invalidated || decision.value?.admission !== 'clear' || !isCurrent()) return false

  const settled = await waitForValueOrAbort(Promise.race([
    pending.settled.then(() => ({ settled: true })),
    pending.invalidated.then(() => ({ invalidated: true })),
  ]), signals)
  if (settled.aborted) return retired() ? await stayPending() : false
  if (retired()) return await stayPending()
  if (settled.value?.invalidated || !isCurrent()) return false
  const rechecking = Promise.resolve().then(() => {
    if (retired()) return stayPending()
    if (!isCurrent() || signals.some((signal) => signal?.aborted)) return false
    return recheck()
  })
  const result = await waitForValueOrAbort(rechecking, signals)
  if (result.aborted) {
    if (retired()) return await stayPending()
    // The fresh admission owns its own pending slot. Wait for its cancellation
    // cleanup before returning so teardown cannot leave that slot parked.
    await rechecking.catch(() => false)
    return false
  }
  if (retired()) return await stayPending()
  return isCurrent() ? result.value : false
}

export async function waitForNativeCheckpointRelease(state, input, generation, hookSignal, nativeInputDigest) {
  const admissionSignal = state.nativeAdmissionAbort?.signal
  let pendingOperation
  const isCurrent = () => state.queryGeneration === generation && state.nativeReady
    && !isTransportRetired(state, pendingOperation) && !state.abort.signal.aborted
    && !admissionSignal?.aborted && !hookSignal?.aborted
    && !pendingOperation?.isInvalidated()
  const signals = [...new Set([state.abort.signal, admissionSignal, hookSignal].filter(Boolean))]

  if (state.nativePendingOperation) {
    pendingOperation = state.nativePendingOperation
    if (pendingOperation.toolUseID === input.tool_use_id) return false
    return await waitForClearAdmissionAndRecheck({
      pending: pendingOperation,
      signals,
      isCurrent,
      isStreamEnded: () => isTransportRetired(state, pendingOperation),
      recheck: () => waitForNativeCheckpointRelease(state, input, generation, hookSignal, nativeInputDigest),
    })
  }

  let release
  let resolveAdmission
  const released = new Promise((resolve) => { release = resolve })
  const admission = new Promise((resolve) => { resolveAdmission = resolve })
  let invalidated = false
  let streamEnded = false
  let resolveInvalidated
  const invalidation = new Promise((resolve) => { resolveInvalidated = resolve })
  const retired = state.nativeCallbacksRetired ?? new Promise(() => {})
  let resolveSettled
  const settled = new Promise((resolve) => { resolveSettled = resolve })
  const operationAbort = new AbortController()
  const invalidate = () => {
    if (invalidated) return
    invalidated = true
    resolveInvalidated()
  }
  const cancel = () => {
    invalidate()
    operationAbort.abort()
    release(false)
  }
  const retire = () => {
    streamEnded = true
  }
  pendingOperation = { generation, toolUseID: input.tool_use_id,
    inputDigest: nativeInputDigest(input.tool_input), release, admission, settled,
    invalidated: invalidation, invalidate, cancel, retire, isInvalidated: () => invalidated,
    isStreamEnded: () => streamEnded, retired }
  state.nativePendingOperation = pendingOperation
  signals.push(operationAbort.signal)
  const cancelled = () => release(false)
  for (const signal of signals) signal.addEventListener('abort', cancelled, { once: true })

  try {
    const read = await waitForValueOrAbort(state.nativeStore.readRecoverable(), signals)
    if (isTransportRetired(state, pendingOperation)) return await pendingOperation.retired
    if (read.aborted) {
      resolveAdmission('blocked')
      return false
    }
    const record = read.value
    if (state.nativeContinuation) {
      const original = state.nativeContinuation.checkpoint
      resolveAdmission('claimed')
      return isCurrent() && original.toolUseID === pendingOperation.toolUseID
        && original.inputDigest === pendingOperation.inputDigest
    }
    if (!record) {
      const inputState = await waitForValueOrAbort(state.nativeStore.inputState(), signals)
      if (isTransportRetired(state, pendingOperation)) return await pendingOperation.retired
      if (inputState.aborted) {
        resolveAdmission('blocked')
        return false
      }
      const clear = inputState.value === 'clear' && !state.nativeContinuation && isCurrent()
      resolveAdmission(clear ? 'clear' : 'blocked')
      return clear ? null : false
    }
    if (record.toolUseID !== pendingOperation.toolUseID || record.inputDigest !== pendingOperation.inputDigest) {
      resolveAdmission('blocked')
      return false
    }
    if (!isCurrent()) {
      resolveAdmission('blocked')
      return false
    }
    resolveAdmission('claimed')
    const releaseResult = await waitForValueOrAbort(released, signals)
    if (isTransportRetired(state, pendingOperation)) return await pendingOperation.retired
    return !releaseResult.aborted && releaseResult.value && isCurrent()
      && state.nativeContinuation?.toolUseID === pendingOperation.toolUseID
      && state.nativeContinuation?.inputDigest === pendingOperation.inputDigest
  } catch {
    if (isTransportRetired(state, pendingOperation)) return await pendingOperation.retired
    resolveAdmission('blocked')
    return false
  } finally {
    for (const signal of signals) signal.removeEventListener('abort', cancelled)
    if (state.nativePendingOperation === pendingOperation) state.nativePendingOperation = undefined
    resolveSettled()
  }
}
