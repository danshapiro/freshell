import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import terminalActivityReducer, { recordInput, recordOutput, STREAMING_THRESHOLD_MS } from '@/store/terminalActivitySlice'
import { useTerminalActivityMonitor } from '@/hooks/useTerminalActivityMonitor'
import type { Tab } from '@/store/types'
import type { PaneNode } from '@/store/paneTypes'

const playSound = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useNotificationSound', () => ({
  useNotificationSound: () => ({ play: playSound }),
}))

function TestComponent() {
  useTerminalActivityMonitor()
  return null
}

function createStore(baseTime: number) {
  const tab: Tab = {
    id: 'tab-1',
    createRequestId: 'req-1',
    title: 'Terminal',
    status: 'running',
    mode: 'shell',
    shell: 'system',
    createdAt: baseTime,
  }

  const layout: PaneNode = {
    type: 'leaf',
    id: 'pane-1',
    content: {
      kind: 'terminal',
      createRequestId: 'req-1',
      status: 'running',
      mode: 'shell',
      shell: 'system',
    },
  }

  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      terminalActivity: terminalActivityReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [tab],
        activeTabId: tab.id,
      },
      panes: {
        layouts: { [tab.id]: layout },
        activePane: { [tab.id]: layout.id },
      },
      settings: {
        settings: defaultSettings,
        loaded: true,
      },
      terminalActivity: {
        lastOutputAt: { [layout.id]: baseTime },
        lastInputAt: { [layout.id]: baseTime - 1000 },
        working: { [layout.id]: true },
        finished: {},
      },
    },
  })
}

describe('useTerminalActivityMonitor', () => {
  const baseTime = 1000
  const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden')
  const originalHasFocus = Object.getOwnPropertyDescriptor(document, 'hasFocus')

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(baseTime)
    playSound.mockClear()

    Object.defineProperty(document, 'hidden', {
      value: false,
      configurable: true,
    })

    Object.defineProperty(document, 'hasFocus', {
      value: () => false,
      configurable: true,
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()

    if (originalHidden) {
      Object.defineProperty(document, 'hidden', originalHidden)
    }

    if (originalHasFocus) {
      Object.defineProperty(document, 'hasFocus', originalHasFocus)
    }
  })

  it('plays sound when output finishes while window is unfocused', async () => {
    const store = createStore(baseTime)

    render(
      <Provider store={store}>
        <TestComponent />
      </Provider>,
    )

    await act(async () => {
      vi.setSystemTime(baseTime + STREAMING_THRESHOLD_MS + 1000)
      store.dispatch(recordInput({ paneId: 'pane-1' }))
    })

    expect(playSound).toHaveBeenCalledTimes(1)
  })

  describe('periodic activity timeout check', () => {
    it('marks pane as finished and plays sound when output stops', async () => {
      const store = createStore(baseTime)

      render(
        <Provider store={store}>
          <TestComponent />
        </Provider>,
      )

      // Initially working
      expect(store.getState().terminalActivity.working['pane-1']).toBe(true)
      expect(store.getState().terminalActivity.finished['pane-1']).toBeFalsy()

      // Advance time past the streaming threshold and run interval
      await act(async () => {
        vi.setSystemTime(baseTime + STREAMING_THRESHOLD_MS + 100)
        // Run timers to trigger interval
        vi.runOnlyPendingTimers()
      })

      // working should be false (finished was set then cleared by notification effect)
      expect(store.getState().terminalActivity.working['pane-1']).toBe(false)
      // finished is immediately cleared after playing sound (in unfocused window)
      // The key indicator that checkActivityTimeout worked is that:
      // 1. working is now false
      // 2. sound was played (checked in separate test)
    })

    it('plays notification sound when pane finishes and window is unfocused', async () => {
      const store = createStore(baseTime)

      render(
        <Provider store={store}>
          <TestComponent />
        </Provider>,
      )

      // Advance time past the streaming threshold and trigger interval
      await act(async () => {
        vi.setSystemTime(baseTime + STREAMING_THRESHOLD_MS + 100)
        vi.runOnlyPendingTimers()
      })

      // Should have played sound since window is unfocused
      expect(playSound).toHaveBeenCalledTimes(1)
    })

    it('does not play sound when window is focused', async () => {
      const store = createStore(baseTime)

      // Make window focused
      Object.defineProperty(document, 'hasFocus', {
        value: () => true,
        configurable: true,
      })

      render(
        <Provider store={store}>
          <TestComponent />
        </Provider>,
      )

      // Advance time past the streaming threshold and trigger interval
      await act(async () => {
        vi.setSystemTime(baseTime + STREAMING_THRESHOLD_MS + 100)
        vi.runOnlyPendingTimers()
      })

      // Should NOT have played sound since window is focused
      expect(playSound).not.toHaveBeenCalled()
    })

    it('does not run interval when no panes are working', async () => {
      const store = createStore(baseTime)

      render(
        <Provider store={store}>
          <TestComponent />
        </Provider>,
      )

      // Get initial state - pane should be working
      expect(store.getState().terminalActivity.working['pane-1']).toBe(true)

      // Advance time past threshold and trigger interval to mark as finished
      await act(async () => {
        vi.setSystemTime(baseTime + STREAMING_THRESHOLD_MS + 100)
        vi.runOnlyPendingTimers()
      })

      // Now working should be false and finished should be true
      expect(store.getState().terminalActivity.working['pane-1']).toBe(false)
      expect(store.getState().terminalActivity.finished['pane-1']).toBeFalsy() // Cleared by sound effect

      // Clear the play mock
      playSound.mockClear()

      // Advance more time - should NOT trigger sound since no longer working
      await act(async () => {
        vi.setSystemTime(baseTime + STREAMING_THRESHOLD_MS * 3)
        vi.runOnlyPendingTimers()
      })

      // No additional sound calls since pane is no longer working
      expect(playSound).not.toHaveBeenCalled()
    })

    it('does not recreate the interval on unrelated working-map updates while still working', async () => {
      const store = createStore(baseTime)
      const setIntervalSpy = vi.spyOn(window, 'setInterval')
      const clearIntervalSpy = vi.spyOn(window, 'clearInterval')

      render(
        <Provider store={store}>
          <TestComponent />
        </Provider>,
      )

      expect(setIntervalSpy).toHaveBeenCalledTimes(1)

      await act(async () => {
        // This keeps hasWorkingPanes=true but changes the working map reference by adding a new key.
        store.dispatch(recordOutput({ paneId: 'pane-2', at: baseTime + 10 }))
        store.dispatch(recordOutput({ paneId: 'pane-2', at: baseTime + 20 }))
      })

      expect(clearIntervalSpy).not.toHaveBeenCalled()
      expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    })
  })
})
