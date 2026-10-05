import { describe, expect, it, vi } from 'vitest'
import {
  forceStopExactOwnedServerAndVerify,
  stopOwnedServerAndVerify,
} from '../../e2e-electron/owned-server-teardown.js'

async function expectAggregateCause(operation: Promise<void>, pattern: RegExp): Promise<void> {
  try {
    await operation
    throw new Error('expected teardown to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError)
    const messages = (error as AggregateError).errors.flatMap((failure) => [
      String(failure),
      String((failure as Error & { cause?: unknown }).cause),
    ])
    expect(messages.some((message) => pattern.test(message))).toBe(true)
  }
}

describe('stopOwnedServerAndVerify', () => {
  it('surfaces a stop failure after still checking the exact owned PID and port', async () => {
    const stop = vi.fn().mockRejectedValue(new Error('SIGTERM failed'))
    const waitForPidGone = vi.fn().mockResolvedValue(false)
    const isPortFree = vi.fn().mockResolvedValue(false)

    await expect(
      stopOwnedServerAndVerify({ stop }, { pid: 4242, port: 4243 }, { waitForPidGone, isPortFree }),
    ).rejects.toThrow(/owned server teardown failed for PID 4242, port 4243/)

    expect(stop).toHaveBeenCalledOnce()
    expect(waitForPidGone).toHaveBeenCalledWith(4242)
    expect(isPortFree).toHaveBeenCalledWith(4243)
  })

  it('accepts teardown only after the exact owned PID and port are gone', async () => {
    const stop = vi.fn().mockResolvedValue(undefined)
    const waitForPidGone = vi.fn().mockResolvedValue(true)
    const isPortFree = vi.fn().mockResolvedValue(true)

    await expect(
      stopOwnedServerAndVerify({ stop }, { pid: 4242, port: 4243 }, { waitForPidGone, isPortFree }),
    ).resolves.toBeUndefined()
  })

  it('contains a still-running exact app-bound Rust PID after parent containment, then proves PID and port release', async () => {
    const order: string[] = []
    const process = {
      pid: 4242,
      alive: true,
      isAlive: vi.fn(() => process.alive),
      signal: vi.fn((signal: NodeJS.Signals) => {
        order.push(`signal:${signal}`)
        process.alive = false
        return true
      }),
    }
    const proveOwnership = vi.fn(async () => {
      order.push('ownership')
    })
    const waitForPidGone = vi.fn(async () => !process.alive)
    const isPortFree = vi.fn(async () => !process.alive)

    await expect(
      forceStopExactOwnedServerAndVerify(
        process,
        { pid: 4242, port: 4243 },
        { proveOwnership, waitForPidGone, isPortFree, sleep: async () => {} },
        1,
      ),
    ).resolves.toBeUndefined()

    expect(order).toEqual(['ownership', 'signal:SIGTERM'])
    expect(proveOwnership).toHaveBeenCalledWith(
      { pid: 4242, port: 4243 },
      expect.objectContaining({ signal: expect.any(AbortSignal), deadline: expect.any(Number) }),
    )
    expect(isPortFree).toHaveBeenCalledWith(4243)
  })

  it('preserves ownership, PID, and port failures without signaling an unproven PID', async () => {
    const process = {
      pid: 4242,
      isAlive: vi.fn(() => true),
      signal: vi.fn(() => true),
    }
    const proveOwnership = vi.fn().mockRejectedValue(new Error('expected Rust binary was not present'))
    const waitForPidGone = vi.fn().mockResolvedValue(false)
    const isPortFree = vi.fn().mockResolvedValue(false)

    await expect(
      forceStopExactOwnedServerAndVerify(
        process,
        { pid: 4242, port: 4243 },
        { proveOwnership, waitForPidGone, isPortFree, sleep: async () => {} },
        1,
      ),
    ).rejects.toThrow(/forced owned server teardown failed/i)

    expect(process.signal).not.toHaveBeenCalled()
    expect(isPortFree).toHaveBeenCalledWith(4243)
  })

  it('does not SIGKILL a PID reused after TERM when its original Rust ownership disappears', async () => {
    let identity: 'owned' | 'reused' = 'owned'
    const process = {
      pid: 4242,
      isAlive: vi.fn(() => true),
      signal: vi.fn((signal: NodeJS.Signals) => {
        if (signal === 'SIGTERM') identity = 'reused'
        return true
      }),
    }
    const proveOwnership = vi.fn(async () => {
      if (identity !== 'owned') throw new Error('PID start identity changed after TERM')
    })
    const waitForPidGone = vi.fn().mockResolvedValue(false)
    const isPortFree = vi.fn().mockResolvedValue(false)

    await expectAggregateCause(
      forceStopExactOwnedServerAndVerify(
        process,
        { pid: 4242, port: 4243 },
        {
          proveOwnership,
          waitForPidGone,
          isPortFree,
          sleep: async () => { await new Promise((resolve) => setTimeout(resolve, 1)) },
        },
        1,
      ),
      /ownership/i,
    )

    expect(process.signal).toHaveBeenCalledWith('SIGTERM')
    expect(process.signal).not.toHaveBeenCalledWith('SIGKILL')
    expect(proveOwnership.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('reproves a TERM-resistant Rust child before SIGKILL and observes its exit', async () => {
    let alive = true
    const process = {
      pid: 4242,
      isAlive: vi.fn(() => alive),
      signal: vi.fn((signal: NodeJS.Signals) => {
        if (signal === 'SIGKILL') alive = false
        return true
      }),
    }
    const proveOwnership = vi.fn().mockResolvedValue(undefined)
    const waitForPidGone = vi.fn(async () => !alive)
    const isPortFree = vi.fn(async () => !alive)

    await expect(
      forceStopExactOwnedServerAndVerify(
        process,
        { pid: 4242, port: 4243 },
        { proveOwnership, waitForPidGone, isPortFree, sleep: async () => { await new Promise((resolve) => setTimeout(resolve, 1)) } },
        1,
      ),
    ).resolves.toBeUndefined()

    expect(process.signal).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(process.signal).toHaveBeenNthCalledWith(2, 'SIGKILL')
    expect(proveOwnership.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('bounds no-progress polling, escalates once, and leaves no detached polling after a resistant child', async () => {
    let aliveChecks = 0
    let alive = true
    const process = {
      pid: 4242,
      isAlive: vi.fn(() => {
        aliveChecks += 1
        // The old Date.now-only loop waited for this artificial process exit
        // instead of honoring its poll budget. The bounded helper must KILL.
        if (aliveChecks > 10) alive = false
        return alive
      }),
      signal: vi.fn((signal: NodeJS.Signals) => {
        if (signal === 'SIGKILL') alive = false
        return true
      }),
    }
    const proveOwnership = vi.fn().mockResolvedValue(undefined)
    const waitForPidGone = vi.fn(async () => !alive)
    const isPortFree = vi.fn(async () => !alive)
    const sleep = vi.fn(async () => {})

    await expect(
      forceStopExactOwnedServerAndVerify(
        process,
        { pid: 4242, port: 4243 },
        { proveOwnership, waitForPidGone, isPortFree, sleep },
        1,
      ),
    ).resolves.toBeUndefined()

    expect(process.signal).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(process.signal).toHaveBeenNthCalledWith(2, 'SIGKILL')
    const checksAtReturn = process.isAlive.mock.calls.length
    await Promise.resolve()
    expect(process.isAlive).toHaveBeenCalledTimes(checksAtReturn)
    // A real clock can exhaust the 1ms wall-clock deadline before either
    // bounded poll sleeps. The invariant is the finite poll cap, not an exact
    // sleep count that assumes a particular scheduler tick.
    expect(sleep.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('aggregates a rejected exact signal and never starts a detached escalation', async () => {
    const process = {
      pid: 4242,
      isAlive: vi.fn(() => true),
      signal: vi.fn(() => { throw new Error('TERM denied') }),
    }
    const proveOwnership = vi.fn().mockResolvedValue(undefined)
    const waitForPidGone = vi.fn().mockResolvedValue(false)
    const isPortFree = vi.fn().mockResolvedValue(false)

    await expectAggregateCause(
      forceStopExactOwnedServerAndVerify(
        process,
        { pid: 4242, port: 4243 },
        { proveOwnership, waitForPidGone, isPortFree, sleep: async () => {} },
        1,
      ),
      /TERM denied/i,
    )

    expect(process.signal).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(process.signal).toHaveBeenCalledTimes(1)
  })

  it('bounds an unresolved ownership proof, aborts it, and leaves no cleanup continuation behind', async () => {
    vi.useFakeTimers()
    try {
      let aborts = 0
      const process = {
        pid: 4242,
        isAlive: vi.fn(() => true),
        signal: vi.fn(() => true),
      }
      const proveOwnership = vi.fn(async (_receipt, context?: { signal: AbortSignal }) => {
        await new Promise<void>((_resolve) => {
          context?.signal.addEventListener('abort', () => { aborts += 1 }, { once: true })
        })
      })
      let result: 'pending' | 'resolved' | 'rejected' = 'pending'
      void forceStopExactOwnedServerAndVerify(
        process,
        { pid: 4242, port: 4243 },
        {
          proveOwnership,
          waitForPidGone: vi.fn().mockResolvedValue(false),
          isPortFree: vi.fn().mockResolvedValue(false),
          sleep: async () => {},
          ownershipProofTimeoutMs: 5,
        },
        5,
      ).then(
        () => { result = 'resolved' },
        () => { result = 'rejected' },
      )

      // Initial observation and final verification each bound their own proof.
      // Advance both deadlines without racing the busy worker's wall clock.
      await vi.advanceTimersToNextTimerAsync()
      await vi.advanceTimersToNextTimerAsync()
      expect(result).toBe('rejected')
      expect(process.signal).not.toHaveBeenCalled()
      expect(aborts).toBeGreaterThan(0)
      const callsAtReturn = process.isAlive.mock.calls.length
      await vi.advanceTimersByTimeAsync(20)
      expect(process.isAlive).toHaveBeenCalledTimes(callsAtReturn)
    } finally {
      vi.useRealTimers()
    }
  })

  it('aggregates a false TERM rejection while the exact child remains alive', async () => {
    const process = {
      pid: 4242,
      isAlive: vi.fn(() => true),
      signal: vi.fn(() => false),
    }
    await expectAggregateCause(
      forceStopExactOwnedServerAndVerify(
        process,
        { pid: 4242, port: 4243 },
        {
          proveOwnership: vi.fn().mockResolvedValue(undefined),
          waitForPidGone: vi.fn().mockResolvedValue(false),
          isPortFree: vi.fn().mockResolvedValue(false),
          sleep: async () => {},
        },
        1,
      ),
      /rejected SIGTERM/i,
    )
    expect(process.signal).toHaveBeenCalledTimes(1)
  })

  it('aggregates a false KILL rejection after re-proving a TERM-resistant exact child', async () => {
    const process = {
      pid: 4242,
      isAlive: vi.fn(() => true),
      signal: vi.fn((signal: NodeJS.Signals) => signal === 'SIGTERM'),
    }
    const proveOwnership = vi.fn().mockResolvedValue(undefined)
    await expectAggregateCause(
      forceStopExactOwnedServerAndVerify(
        process,
        { pid: 4242, port: 4243 },
        {
          proveOwnership,
          waitForPidGone: vi.fn().mockResolvedValue(false),
          isPortFree: vi.fn().mockResolvedValue(false),
          sleep: async () => { await new Promise((resolve) => setTimeout(resolve, 1)) },
        },
        1,
      ),
      /rejected SIGKILL/i,
    )
    expect(process.signal).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(process.signal).toHaveBeenNthCalledWith(2, 'SIGKILL')
    expect(proveOwnership.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
