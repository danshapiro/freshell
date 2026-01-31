import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'

type MockWatcher = EventEmitter & { close: () => Promise<void> }

const { watchMock, getWatcher, resetWatcher } = vi.hoisted(() => {
  let watcher: MockWatcher | null = null
  const watchMock = vi.fn(() => {
    watcher = new EventEmitter() as MockWatcher
    watcher.close = () => Promise.resolve()
    return watcher
  })
  return {
    watchMock,
    getWatcher: () => watcher,
    resetWatcher: () => {
      watcher = null
    },
  }
})

vi.mock('chokidar', () => ({
  default: {
    watch: watchMock,
  },
}))

import { ClaudeSessionIndexer } from '../../../server/claude-indexer'

describe('ClaudeSessionIndexer start', () => {
  afterEach(() => {
    vi.useRealTimers()
    resetWatcher()
    watchMock.mockClear()
  })

  it('does not trigger a full refresh on watcher ready', async () => {
    vi.useFakeTimers()

    const indexer = new ClaudeSessionIndexer()
    const refreshSpy = vi.spyOn(indexer, 'refresh').mockResolvedValue(undefined)

    await indexer.start()
    expect(refreshSpy).toHaveBeenCalledTimes(1)

    const watcher = getWatcher()
    if (!watcher) throw new Error('watcher not initialized')
    watcher.emit('ready')

    await vi.runAllTimersAsync()

    expect(refreshSpy).toHaveBeenCalledTimes(1)

    indexer.stop()
  })
})
