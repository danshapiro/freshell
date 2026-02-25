import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PERSIST_BROADCAST_CHANNEL_NAME,
  broadcastPersistedRaw,
  onPersistBroadcast,
  resetPersistBroadcastForTests,
} from '@/store/persistBroadcast'

describe('persistBroadcast', () => {
  const originalBroadcastChannel = (globalThis as any).BroadcastChannel

  beforeEach(() => {
    resetPersistBroadcastForTests()
  })

  afterEach(() => {
    ;(globalThis as any).BroadcastChannel = originalBroadcastChannel
    resetPersistBroadcastForTests()
  })

  it('uses v2 broadcast channel namespace', () => {
    expect(PERSIST_BROADCAST_CHANNEL_NAME).toBe('freshell.persist.v2')
  })

  it('always notifies in-process listeners', () => {
    const received: Array<{ key: string; raw: string }> = []
    const unsubscribe = onPersistBroadcast((msg) => {
      received.push({ key: msg.key, raw: msg.raw })
    })

    broadcastPersistedRaw('freshell.tabs.v2', '{"ok":true}')
    unsubscribe()

    expect(received).toEqual([{ key: 'freshell.tabs.v2', raw: '{"ok":true}' }])
  })

  it('publishes to BroadcastChannel when available', () => {
    const instances: Array<{
      name: string
      postMessage: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
    }> = []

    class MockBroadcastChannel {
      name: string
      postMessage = vi.fn()
      close = vi.fn()

      constructor(name: string) {
        this.name = name
        instances.push(this)
      }
    }

    ;(globalThis as any).BroadcastChannel = MockBroadcastChannel

    broadcastPersistedRaw('freshell.panes.v2', '{"pane":1}')

    expect(instances).toHaveLength(1)
    expect(instances[0].name).toBe(PERSIST_BROADCAST_CHANNEL_NAME)
    expect(instances[0].postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'persist',
        key: 'freshell.panes.v2',
        raw: '{"pane":1}',
      }),
    )
    expect(instances[0].close).toHaveBeenCalled()
  })
})
