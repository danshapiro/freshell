// A concurrent hook may use ordinary permission policy only after the native
// store confirms that no checkpoint or unfinished operation blocks input.
export async function concurrentNativeHookDecision(state, generation, hookSignal) {
  const pending = state.nativePendingOperation
  const denied = (reason, inputState) => ({ allowOrdinary: false, reason,
    ...(inputState ? { inputState } : {}) })
  if (!pending || pending.generation !== generation || state.queryGeneration !== generation) return denied('stale_generation')
  if (!state.nativeStore) return denied('store_unavailable')
  if (!state.nativeReady) return denied('query_not_ready')
  if (state.abort.signal.aborted || hookSignal?.aborted) return denied('aborted')
  if (state.nativeContinuation) return denied('continuation_active')

  let inputState
  try {
    inputState = await state.nativeStore.inputState()
  } catch {
    return denied('store_check_failed')
  }

  if (state.abort.signal.aborted || hookSignal?.aborted) return denied('aborted', inputState)
  if (state.queryGeneration !== generation) return denied('stale_generation', inputState)
  if (!state.nativeReady) return denied('query_not_ready', inputState)
  if (state.nativeContinuation) return denied('continuation_active', inputState)
  if (state.nativePendingOperation && state.nativePendingOperation !== pending) return denied('pending_operation_replaced', inputState)
  if (inputState !== 'clear') return denied('native_input_not_clear', inputState)
  return { allowOrdinary: true, inputState }
}
