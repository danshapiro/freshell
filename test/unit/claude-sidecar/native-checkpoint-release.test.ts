import { describe, expect, it, vi } from 'vitest'
import { ordinaryPermissionAllowedDuringNativeInspection } from '../../../crates/freshell-claude-sidecar/native-checkpoint-release.mjs'

const generation = 12

function makeState(inputState: string | Promise<string>) {
  return {
    nativePendingOperation: { generation },
    nativeStore: { inputState: vi.fn(() => Promise.resolve(inputState)) },
    abort: new AbortController(),
    queryGeneration: generation,
    nativeReady: true,
  }
}

describe('concurrent native checkpoint inspection', () => {
  it('allows ordinary permission policy when the same live query has no pending native input', async () => {
    const state = makeState('clear')
    await expect(ordinaryPermissionAllowedDuringNativeInspection(state, generation)).resolves.toBe(true)
    expect(state.nativeStore.inputState).toHaveBeenCalledOnce()
  })

  it.each(['recoverable', 'blocked'])('keeps concurrent input denied when the native store is %s', async (inputState) => {
    const state = makeState(inputState)
    await expect(ordinaryPermissionAllowedDuringNativeInspection(state, generation)).resolves.toBe(false)
  })

  it('denies if the pending inspection or query changes while the store check is running', async () => {
    let finishCheck!: (inputState: string) => void
    const check = new Promise<string>((resolve) => { finishCheck = resolve })
    const state = makeState(check)
    const result = ordinaryPermissionAllowedDuringNativeInspection(state, generation)
    state.nativePendingOperation = { generation }
    finishCheck('clear')
    await expect(result).resolves.toBe(false)
  })

  it('fails closed when the inspection is aborted before the store check finishes', async () => {
    let finishCheck!: (inputState: string) => void
    const check = new Promise<string>((resolve) => { finishCheck = resolve })
    const state = makeState(check)
    const result = ordinaryPermissionAllowedDuringNativeInspection(state, generation)
    state.abort.abort()
    finishCheck('clear')
    await expect(result).resolves.toBe(false)
  })
})
