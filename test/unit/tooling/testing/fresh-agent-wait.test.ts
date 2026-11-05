import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor, waitForFreshAgentFrame } from '../../../helpers/fresh-agent-wait.js'

describe('fresh-agent fixture completion waits', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  const matchesCreate = (frame: any) => frame.requestId === 'primary'
    && ['freshAgent.created', 'freshAgent.create.failed'].includes(frame.type)

  it.each(['freshAgent.created', 'freshAgent.create.failed'])('observes delayed %s within the existing case deadline', async type => {
    const deadline = Date.now() + 240_000
    const frames: any[] = []
    const outcome = { type, requestId: 'primary', code: 'original-failure-detail' }
    setTimeout(() => frames.push(outcome), 95_000)
    const result = waitForFreshAgentFrame(frames, matchesCreate, deadline)
      .then(value => ({ value }), error => ({ error }))
    await vi.advanceTimersByTimeAsync(95_000)
    expect(await result).toEqual({ value: outcome })
  })

  it('counts connection/setup time and does not renew the case deadline for unrelated frames', async () => {
    const deadline = Date.now() + 240_000
    await vi.advanceTimersByTimeAsync(80_000)
    const frames: any[] = []
    const noise = setInterval(() => frames.push({ type: 'runtime.inventory.changed' }), 10_000)
    let settledAt: number | undefined
    const result = waitForFreshAgentFrame(frames, matchesCreate, deadline)
      .catch(error => { settledAt = Date.now(); return error })
    await vi.advanceTimersByTimeAsync(159_999)
    expect(settledAt).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toBeInstanceOf(Error)
    expect(settledAt).toBe(deadline)
    clearInterval(noise)
  })

  it.each([240_000, 240_001])('refuses an outcome arriving at or beyond the absolute bound (%i)', async arrival => {
    const frames: any[] = []
    setTimeout(() => frames.push({ type: 'freshAgent.created', requestId: 'primary' }), arrival)
    const result = waitForFreshAgentFrame(frames, matchesCreate, 240_000)
      .then(value => ({ value }), error => ({ error }))
    await vi.advanceTimersByTimeAsync(arrival)
    expect(await result).toEqual({ error: expect.objectContaining({ message: expect.stringContaining('timed out') }) })
  })

  it('refuses an already expired deadline even when a matching frame is retained', async () => {
    const frames = [{ type: 'freshAgent.created', requestId: 'primary' }]
    await expect(waitForFreshAgentFrame(frames, matchesCreate, Date.now())).rejects.toThrow('timed out')
  })

  it('ends a no-outcome wait at its absolute deadline, including a partial polling interval', async () => {
    let settledAt: number | undefined
    const result = waitForFreshAgentFrame([], matchesCreate, 101)
      .catch(error => { settledAt = Date.now(); return error })
    await vi.advanceTimersByTimeAsync(101)
    expect(settledAt).toBe(101)
    expect(await result).toBeInstanceOf(Error)
  })

  it('keeps the generic 90-second default and recent-frame failure evidence', async () => {
    const frames = [{ type: 'freshAgent.created', requestId: 'another-request' }]
    const result = waitForFreshAgentFrame(frames, matchesCreate).catch(error => error)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(await result).toEqual(expect.objectContaining({ message: expect.stringContaining('another-request') }))
    expect(Date.now()).toBe(90_000)
  })

  it('retains caller-specific generic polling timeouts', async () => {
    const result = waitFor('native name', () => undefined, 15_000).catch(error => error)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await result).toEqual(expect.objectContaining({ message: 'timed out waiting for native name' }))
  })
})
