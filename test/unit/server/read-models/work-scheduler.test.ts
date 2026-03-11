// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  createReadModelAbortError,
  createReadModelWorkScheduler,
} from '../../../../server/read-models/work-scheduler.js'

function waitForSchedulerTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function createDeferred() {
  let resolve!: () => void
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

describe('createReadModelWorkScheduler', () => {
  it('starts critical work before visible work', async () => {
    const scheduler = createReadModelWorkScheduler()
    const order: string[] = []
    const releaseCritical = createDeferred()

    const visiblePromise = scheduler.schedule({
      lane: 'visible',
      run: async () => {
        order.push('visible')
      },
    })
    const criticalPromise = scheduler.schedule({
      lane: 'critical',
      run: async () => {
        order.push('critical')
        await releaseCritical.promise
      },
    })

    await waitForSchedulerTick()
    expect(order).toEqual(['critical'])

    releaseCritical.resolve()
    await Promise.all([criticalPromise, visiblePromise])
    expect(order).toEqual(['critical', 'visible'])
  })

  it('starts visible work before background work', async () => {
    const scheduler = createReadModelWorkScheduler()
    const order: string[] = []
    const releaseVisible = createDeferred()
    const releaseBackground = createDeferred()

    const backgroundPromise = scheduler.schedule({
      lane: 'background',
      run: async () => {
        order.push('background')
        await releaseBackground.promise
      },
    })
    const visiblePromise = scheduler.schedule({
      lane: 'visible',
      run: async () => {
        order.push('visible')
        await releaseVisible.promise
      },
    })

    await waitForSchedulerTick()
    expect(order).toEqual(['visible', 'background'])

    releaseVisible.resolve()
    releaseBackground.resolve()
    await Promise.all([visiblePromise, backgroundPromise])
  })

  it('bounds background concurrency', async () => {
    const scheduler = createReadModelWorkScheduler({ backgroundConcurrency: 1 })
    const order: string[] = []
    const releaseFirst = createDeferred()

    const first = scheduler.schedule({
      lane: 'background',
      run: async () => {
        order.push('background-1')
        await releaseFirst.promise
      },
    })
    const second = scheduler.schedule({
      lane: 'background',
      run: async () => {
        order.push('background-2')
      },
    })

    await waitForSchedulerTick()
    expect(order).toEqual(['background-1'])

    releaseFirst.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(['background-1', 'background-2'])
  })

  it('aborts queued and running background work from the owning signal', async () => {
    const scheduler = createReadModelWorkScheduler({ backgroundConcurrency: 1 })
    const started: string[] = []
    const runningController = new AbortController()
    const queuedController = new AbortController()

    const running = scheduler.schedule({
      lane: 'background',
      signal: runningController.signal,
      run: async (signal) => {
        started.push('running')
        await new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(createReadModelAbortError()), { once: true })
        })
      },
    })
    const queued = scheduler.schedule({
      lane: 'background',
      signal: queuedController.signal,
      run: async () => {
        started.push('queued')
      },
    })

    await waitForSchedulerTick()
    expect(started).toEqual(['running'])

    queuedController.abort()
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    expect(started).toEqual(['running'])

    runningController.abort()
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(started).toEqual(['running'])
  })
})
