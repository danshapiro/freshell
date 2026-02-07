import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import terminalActivityReducer, { recordInput, STREAMING_THRESHOLD_MS } from '@/store/terminalActivitySlice'
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
})
