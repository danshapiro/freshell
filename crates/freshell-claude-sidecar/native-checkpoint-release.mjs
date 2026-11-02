// A concurrent hook may use ordinary permission policy only after the native
// store confirms that no checkpoint or unfinished operation blocks input.
export async function ordinaryPermissionAllowedDuringNativeInspection(state, generation, hookSignal) {
  const pending = state.nativePendingOperation
  if (!pending || pending.generation !== generation || !state.nativeStore
    || state.queryGeneration !== generation || !state.nativeReady
    || state.abort.signal.aborted || hookSignal?.aborted) return false

  try {
    const inputState = await state.nativeStore.inputState()
    return inputState === 'clear'
      && state.nativePendingOperation === pending
      && state.queryGeneration === generation
      && state.nativeReady
      && !state.abort.signal.aborted
      && !hookSignal?.aborted
  } catch {
    return false
  }
}
