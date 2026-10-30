import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stopFixtureProcess, waitForFixtureProcessExit, type FixtureProcess } from '../../support/stop-fixture-process.js'

class FakeFixtureProcess extends EventEmitter implements FixtureProcess {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly signals: NodeJS.Signals[] = []
  onTerm?: () => void
  onKill?: () => void

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal)
    if (signal === 'SIGTERM') this.onTerm?.()
    if (signal === 'SIGKILL') this.onKill?.()
    return true
  }

  exit(signal: NodeJS.Signals | null): void {
    this.signalCode = signal
    this.exitCode = signal === null ? 0 : null
    this.emit('exit', this.exitCode, signal)
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('waitForFixtureProcessExit', () => {
  it('accepts a protocol exit and releases its deadline without sending a signal', async () => {
    vi.useFakeTimers()
    const child = new FakeFixtureProcess()
    const waiting = waitForFixtureProcessExit(child, 50)

    child.exit(null)
    await waiting

    expect(child.signals).toEqual([])
    expect(child.listenerCount('exit')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a protocol shutdown timeout failed when fallback SIGTERM produces a clean exit', async () => {
    vi.useFakeTimers()
    const child = new FakeFixtureProcess()
    child.onTerm = () => setTimeout(() => child.exit(null), 10)
    const shutdown = waitForFixtureProcessExit(child, 50).finally(() => stopFixtureProcess(child))
    const outcome = shutdown.then(() => null, (error: Error) => error)

    await vi.advanceTimersByTimeAsync(49)
    expect(child.signals).toEqual([])
    await vi.advanceTimersByTimeAsync(11)

    expect(await outcome).toBeInstanceOf(Error)
    expect((await outcome)?.message).toMatch(/did not exit within 50ms/i)
    expect(child.exitCode).toBe(0)
    expect(child.signals).toEqual(['SIGTERM'])
    expect(child.listenerCount('exit')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('stopFixtureProcess', () => {
  it('waits for the exact child to exit after SIGTERM before resolving', async () => {
    vi.useFakeTimers()
    const child = new FakeFixtureProcess()
    child.onTerm = () => setTimeout(() => child.exit('SIGTERM'), 10)

    const stopping = stopFixtureProcess(child, { gracefulTimeoutMs: 50, forceTimeoutMs: 50 })
    await vi.advanceTimersByTimeAsync(10)
    await stopping

    expect(child.signals).toEqual(['SIGTERM'])
    expect(child.listenerCount('exit')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('escalates only the captured child and still awaits its SIGKILL exit', async () => {
    vi.useFakeTimers()
    const child = new FakeFixtureProcess()
    child.onKill = () => setTimeout(() => child.exit('SIGKILL'), 10)

    const stopping = stopFixtureProcess(child, { gracefulTimeoutMs: 50, forceTimeoutMs: 50 })
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(10)
    await stopping

    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(child.listenerCount('exit')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fails closed if the captured child survives SIGKILL and leaves no listener or timer behind', async () => {
    vi.useFakeTimers()
    const child = new FakeFixtureProcess()

    const stopping = stopFixtureProcess(child, { gracefulTimeoutMs: 50, forceTimeoutMs: 50 })
    const rejected = expect(stopping).rejects.toThrow(/did not exit/i)
    await vi.advanceTimersByTimeAsync(100)

    await rejected
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(child.listenerCount('exit')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
