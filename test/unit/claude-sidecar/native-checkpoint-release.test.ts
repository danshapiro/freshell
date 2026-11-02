import { describe, expect, it, vi } from 'vitest'
import { concurrentNativeHookDecision } from '../../../crates/freshell-claude-sidecar/native-checkpoint-release.mjs'

const generation = 12

function makeState(inputState: string | Promise<string>) {
  return {
    nativePendingOperation: { generation } as { generation: number } | undefined,
    nativeStore: { inputState: vi.fn(() => Promise.resolve(inputState)) },
    abort: new AbortController(),
    queryGeneration: generation,
    nativeReady: true,
    nativeContinuation: undefined as unknown,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('concurrent native checkpoint inspection', () => {
  it('allows ordinary permission policy when the same live query has no pending native input', async () => {
    const state = makeState('clear')
    await expect(concurrentNativeHookDecision(state, generation)).resolves.toEqual({ allowOrdinary: true, inputState: 'clear' })
    expect(state.nativeStore.inputState).toHaveBeenCalledOnce()
  })

  it('allows ordinary policy if the first clear inspection finishes and releases its slot while this check is queued', async () => {
    const check = deferred<string>()
    const state = makeState(check.promise)
    const result = concurrentNativeHookDecision(state, generation)
    expect(state.nativeStore.inputState).toHaveBeenCalledOnce()
    state.nativePendingOperation = undefined
    check.resolve('clear')
    await expect(result).resolves.toEqual({ allowOrdinary: true, inputState: 'clear' })
  })

  it.each(['recoverable', 'blocked'])('keeps concurrent input denied when the native store is %s', async (inputState) => {
    const state = makeState(inputState)
    await expect(concurrentNativeHookDecision(state, generation)).resolves.toEqual({
      allowOrdinary: false, reason: 'native_input_not_clear', inputState,
    })
  })

  it('denies if the pending inspection is replaced while the store check is running', async () => {
    const check = deferred<string>()
    const state = makeState(check.promise)
    const result = concurrentNativeHookDecision(state, generation)
    state.nativePendingOperation = { generation }
    check.resolve('clear')
    await expect(result).resolves.toEqual({ allowOrdinary: false, reason: 'pending_operation_replaced', inputState: 'clear' })
  })

  const preconditions: Array<[string, (state: any) => void, string]> = [
    ['stale pending generation', (state: any) => { state.nativePendingOperation.generation += 1 }, 'stale_generation'],
    ['stale query generation', (state: any) => { state.queryGeneration += 1 }, 'stale_generation'],
    ['query not ready', (state: any) => { state.nativeReady = false }, 'query_not_ready'],
    ['aborted sidecar', (state: any) => { state.abort.abort() }, 'aborted'],
    ['missing store', (state: any) => { state.nativeStore = undefined }, 'store_unavailable'],
    ['active continuation', (state: any) => { state.nativeContinuation = {} }, 'continuation_active'],
  ]

  it.each(preconditions)('fails closed for %s before reading the store', async (_condition, arrange, reason) => {
    const state = makeState('clear')
    arrange(state)
    await expect(concurrentNativeHookDecision(state, generation)).resolves.toEqual({ allowOrdinary: false, reason })
    if (state.nativeStore) expect(state.nativeStore.inputState).not.toHaveBeenCalled()
  })

  it('fails closed when the hook was already aborted before checking the store', async () => {
    const state = makeState('clear')
    const hook = new AbortController()
    hook.abort()
    await expect(concurrentNativeHookDecision(state, generation, hook.signal)).resolves.toEqual({
      allowOrdinary: false, reason: 'aborted',
    })
    expect(state.nativeStore.inputState).not.toHaveBeenCalled()
  })

  const changesDuringCheck: Array<[string, (state: any, hook: AbortController) => void, string]> = [
    ['query generation changes', (state: any) => { state.queryGeneration += 1 }, 'stale_generation'],
    ['query readiness is lost', (state: any) => { state.nativeReady = false }, 'query_not_ready'],
    ['sidecar aborts', (state: any) => { state.abort.abort() }, 'aborted'],
    ['hook aborts', (_state: any, hook: AbortController) => { hook.abort() }, 'aborted'],
    ['continuation starts', (state: any) => { state.nativeContinuation = {} }, 'continuation_active'],
  ]

  it.each(changesDuringCheck)('fails closed when %s during the store check', async (_condition, arrange, reason) => {
    const check = deferred<string>()
    const state = makeState(check.promise)
    const hook = new AbortController()
    const result = concurrentNativeHookDecision(state, generation, hook.signal)
    arrange(state, hook)
    check.resolve('clear')
    await expect(result).resolves.toEqual({ allowOrdinary: false, reason, inputState: 'clear' })
  })

  it('fails closed when the store cannot establish its input state', async () => {
    const state = makeState('clear')
    state.nativeStore.inputState.mockRejectedValue(new Error('private store detail'))
    await expect(concurrentNativeHookDecision(state, generation)).resolves.toEqual({ allowOrdinary: false, reason: 'store_check_failed' })
  })
})
