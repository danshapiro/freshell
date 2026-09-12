import { afterEach, describe, expect, it, vi } from 'vitest'
import { OwnedCreateBarriers } from '../../../../scripts/testing/runtime-create-barrier.js'

afterEach(() => vi.useRealTimers())

describe('owned one-shot Docker create barriers', () => {
  it('refuses unknown souls, invalid bounds, and duplicate active barriers', () => {
    const barriers = new OwnedCreateBarriers((id) => id === 'owned')
    expect(() => barriers.arm('foreign')).toThrow(/receipt-owned/)
    for (const timeout of [0, -1, 10_001, NaN, 0.5]) {
      expect(() => barriers.arm('owned', timeout)).toThrow(/bound/)
    }
    const held = barriers.arm('owned')
    expect(() => barriers.arm('owned')).toThrow(/already/)
    held.release()
  })
  it('holds only the first validated create of the exact owned soul', async () => {
    const barriers = new OwnedCreateBarriers((id) => id === 'owned')
    const held = barriers.arm('owned')
    expect(await barriers.enter('another')).toBeNull()
    let completed = false
    const request = barriers.enter('owned').then((result) => { completed = true; return result })
    expect(await held.entered).toBe(true)
    expect(completed).toBe(false)
    expect(await barriers.enter('owned')).toBeNull()
    held.release()
    expect(await request).toBe('released')
    expect(held.expired()).toBe(false)
  })
  it('expires with an explicit failure rather than silently forwarding', async () => {
    vi.useFakeTimers()
    const barriers = new OwnedCreateBarriers(() => true)
    const held = barriers.arm('owned', 100)
    const request = barriers.enter('owned')
    await vi.advanceTimersByTimeAsync(100)
    expect(await request).toBe('expired')
    expect(held.expired()).toBe(true)
    expect(await barriers.enter('owned')).toBeNull()
  })
  it('settles an unentered barrier on timeout, release, or broker shutdown', async () => {
    vi.useFakeTimers()
    const barriers = new OwnedCreateBarriers(() => true)
    const expired = barriers.arm('first', 100)
    await vi.advanceTimersByTimeAsync(100)
    expect(await expired.entered).toBe(false)
    const released = barriers.arm('second')
    released.release()
    expect(await released.entered).toBe(false)
    const closed = barriers.arm('third')
    const request = barriers.enter('third')
    barriers.releaseAll()
    expect(await request).toBe('released')
    expect(vi.getTimerCount()).toBe(0)
  })
})
