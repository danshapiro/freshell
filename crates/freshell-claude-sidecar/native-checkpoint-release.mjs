import { nativeInputDigest } from './native-session-channel.mjs'

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

export async function waitForNativeCheckpointRelease(state, input, generation, hookSignal, sessionId, log) {
  if (state.nativePendingOperation) {
    const decision = await concurrentNativeHookDecision(state, generation, hookSignal)
    if (!decision.allowOrdinary) {
      log(decision.reason === 'store_check_failed' ? 'warn' : 'info', 'native.concurrent_hook_denied', { sessionId,
        queryGeneration: generation, reason: decision.reason, ...(decision.inputState ? { inputState: decision.inputState } : {}) })
    }
    return decision.allowOrdinary ? null : false
  }
  let release
  const released = new Promise((resolve) => { release = resolve })
  const pending = { generation, toolUseID: input.tool_use_id,
    inputDigest: nativeInputDigest(input.tool_input), release }
  state.nativePendingOperation = pending
  const cancelled = () => release(false)
  state.abort.signal.addEventListener('abort', cancelled, { once: true })
  hookSignal?.addEventListener('abort', cancelled, { once: true })
  try {
    const record = await state.nativeStore.readRecoverable()
    if (state.nativeContinuation) {
      const original = state.nativeContinuation.checkpoint
      return original.toolUseID === pending.toolUseID && original.inputDigest === pending.inputDigest
    }
    if (!record) return await state.nativeStore.inputState() === 'clear' ? null : false
    if (record.toolUseID !== pending.toolUseID || record.inputDigest !== pending.inputDigest) return false
    if (state.abort.signal.aborted || hookSignal?.aborted) return false
    return await released && state.queryGeneration === generation && state.nativeReady
      && state.nativeContinuation?.toolUseID === pending.toolUseID
      && state.nativeContinuation?.inputDigest === pending.inputDigest
  } catch {
    return false
  } finally {
    state.abort.signal.removeEventListener('abort', cancelled)
    hookSignal?.removeEventListener('abort', cancelled)
    if (state.nativePendingOperation === pending) state.nativePendingOperation = undefined
  }
}
