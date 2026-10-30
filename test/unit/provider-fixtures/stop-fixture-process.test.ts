import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stopFixtureProcess, stopFixtureProcessThen, type FixtureProcess } from '../../support/stop-fixture-process.js'

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

  exit(signal: NodeJS.Signals): void {
    this.signalCode = signal
    this.emit('exit', null, signal)
  }
}

afterEach(() => {
  vi.useRealTimers()
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

  it('does not run fixture cleanup when the captured child never confirms exit', async () => {
    vi.useFakeTimers()
    const child = new FakeFixtureProcess()
    const cleanup = vi.fn(async () => {})
    const stopping = stopFixtureProcessThen(child, cleanup, {
      gracefulTimeoutMs: 50,
      forceTimeoutMs: 50,
    })
    const rejected = expect(stopping).rejects.toThrow(/did not exit/i)
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(50)
    await rejected
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(cleanup).not.toHaveBeenCalled()
    expect(child.listenerCount('exit')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
