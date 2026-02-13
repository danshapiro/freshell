import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, act, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer, { setActiveTab } from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import turnCompletionReducer, { recordTurnComplete } from '@/store/turnCompletionSlice'
import { useTurnCompletionNotifications } from '@/hooks/useTurnCompletionNotifications'
import type { Tab, AttentionDismiss } from '@/store/types'

const playSound = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useNotificationSound', () => ({
  useNotificationSound: () => ({ play: playSound }),
}))

function TestComponent() {
  useTurnCompletionNotifications()
  return null
}

function createStore(activeTabId = 'tab-1', attentionDismiss: AttentionDismiss = 'click') {
  const now = Date.now()
  const tabs: Tab[] = [
    {
      id: 'tab-1',
      createRequestId: 'req-1',
      title: 'Tab 1',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      createdAt: now,
    },
    {
      id: 'tab-2',
      createRequestId: 'req-2',
      title: 'Tab 2',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      createdAt: now,
    },
  ]

  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      turnCompletion: turnCompletionReducer,
    },
    preloadedState: {
      tabs: {
        tabs,
        activeTabId,
        renameRequestTabId: null,
      },
      panes: {
        layouts: {},
        activePane: {
          'tab-1': 'pane-1',
          'tab-2': 'pane-2',
        },
        paneTitles: {},
      },
      settings: {
        settings: {
          ...defaultSettings,
          panes: { ...defaultSettings.panes, attentionDismiss },
        },
        loaded: true,
      },
      turnCompletion: {
        seq: 0,
        lastEvent: null,
        pendingEvents: [],
        attentionByTab: {},
        attentionByPane: {},
      },
    },
  })
}

describe('useTurnCompletionNotifications', () => {
  let hasFocus = true
  let hidden = false
  const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden')
  const originalHasFocus = Object.getOwnPropertyDescriptor(document, 'hasFocus')

  beforeEach(() => {
    playSound.mockClear()
    hasFocus = true
    hidden = false

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hidden,
    })

    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => hasFocus,
    })
  })

  afterEach(() => {
    cleanup()

    if (originalHidden) {
      Object.defineProperty(document, 'hidden', originalHidden)
    }

    if (originalHasFocus) {
      Object.defineProperty(document, 'hasFocus', originalHasFocus)
    }
  })

  it('plays bell and marks attention when a background tab completes while focused', async () => {
    const store = createStore('tab-1')

    render(
      <Provider store={store}>
        <TestComponent />
      </Provider>
    )

    act(() => {
      store.dispatch(recordTurnComplete({ tabId: 'tab-2', paneId: 'pane-2', terminalId: 'term-2', at: 100 }))
    })

    await waitFor(() => {
      expect(playSound).toHaveBeenCalledTimes(1)
    })
    expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBe(true)
    expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
  })

  it('marks pane attention alongside tab attention on completion', async () => {
    const store = createStore('tab-1')

    render(
      <Provider store={store}>
        <TestComponent />
      </Provider>
    )

    act(() => {
      store.dispatch(recordTurnComplete({ tabId: 'tab-2', paneId: 'pane-2', terminalId: 'term-2', at: 100 }))
    })

    await waitFor(() => {
      expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
    })

    expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBe(true)
    expect(store.getState().turnCompletion.attentionByPane['pane-2']).toBe(true)
  })

  it('marks attention but does not play bell when the active tab completes while focused', async () => {
    const store = createStore('tab-1', 'type')

    render(
      <Provider store={store}>
        <TestComponent />
      </Provider>
    )

    act(() => {
      store.dispatch(recordTurnComplete({ tabId: 'tab-1', paneId: 'pane-1', terminalId: 'term-1', at: 100 }))
    })

    await waitFor(() => {
      expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
    })

    expect(playSound).not.toHaveBeenCalled()
    // Attention is always marked — in 'type' mode, cleared by typing
    expect(store.getState().turnCompletion.attentionByTab['tab-1']).toBe(true)
  })

  it('plays bell and marks attention when active tab completes while window is unfocused', async () => {
    hasFocus = false
    const store = createStore('tab-1')

    render(
      <Provider store={store}>
        <TestComponent />
      </Provider>
    )

    act(() => {
      store.dispatch(recordTurnComplete({ tabId: 'tab-1', paneId: 'pane-1', terminalId: 'term-1', at: 100 }))
    })

    await waitFor(() => {
      expect(playSound).toHaveBeenCalledTimes(1)
    })
    expect(store.getState().turnCompletion.attentionByTab['tab-1']).toBe(true)
    expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
  })

  it('does not drop completion when focus state transitions before blur listener updates (type mode)', async () => {
    const store = createStore('tab-1', 'type')

    render(
      <Provider store={store}>
        <TestComponent />
      </Provider>
    )

    act(() => {
      hasFocus = false
      store.dispatch(recordTurnComplete({ tabId: 'tab-1', paneId: 'pane-1', terminalId: 'term-1', at: 100 }))
    })

    await waitFor(() => {
      expect(playSound).toHaveBeenCalledTimes(1)
    })
    expect(store.getState().turnCompletion.attentionByTab['tab-1']).toBe(true)
    expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
  })

  it('marks attention on all tabs in burst completions', async () => {
    const store = createStore('tab-1', 'type')

    render(
      <Provider store={store}>
        <TestComponent />
      </Provider>
    )

    act(() => {
      store.dispatch(recordTurnComplete({ tabId: 'tab-1', paneId: 'pane-1', terminalId: 'term-1', at: 100 }))
      store.dispatch(recordTurnComplete({ tabId: 'tab-2', paneId: 'pane-2', terminalId: 'term-2', at: 200 }))
    })

    await waitFor(() => {
      expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
    })

    // Sound plays once (for the background tab-2; active tab-1 skips sound)
    expect(playSound).toHaveBeenCalledTimes(1)
    // In 'type' mode, attention is marked on ALL tabs — cleared by typing only
    expect(store.getState().turnCompletion.attentionByTab['tab-1']).toBe(true)
    expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBe(true)
  })

  it('attention persists in type mode after switching tabs', async () => {
    hasFocus = false
    const store = createStore('tab-1', 'type')

    render(
      <Provider store={store}>
        <TestComponent />
      </Provider>
    )

    act(() => {
      store.dispatch(recordTurnComplete({ tabId: 'tab-2', paneId: 'pane-2', terminalId: 'term-2', at: 100 }))
    })

    await waitFor(() => {
      expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBe(true)
    })

    // Regain focus — in 'type' mode, attention should persist (only typing clears it)
    act(() => {
      hasFocus = true
      window.dispatchEvent(new Event('focus'))
    })

    await waitFor(() => {
      expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBe(true)
    })
  })

  it('click mode: attention persists on active tab until user switches away and back', async () => {
    const store = createStore('tab-1', 'click')

    render(
      <Provider store={store}>
        <TestComponent />
      </Provider>
    )

    // Completion on active tab while focused — attention should persist (no auto-clear)
    act(() => {
      store.dispatch(recordTurnComplete({ tabId: 'tab-1', paneId: 'pane-1', terminalId: 'term-1', at: 100 }))
    })

    await waitFor(() => {
      expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
    })
    expect(store.getState().turnCompletion.attentionByTab['tab-1']).toBe(true)
    expect(store.getState().turnCompletion.attentionByPane['pane-1']).toBe(true)
  })

  it('click mode: attention persists through window blur/focus cycle without tab switch', async () => {
    hasFocus = false
    const store = createStore('tab-2', 'click')

    render(
      <Provider store={store}>
        <TestComponent />
      </Provider>
    )

    act(() => {
      store.dispatch(recordTurnComplete({ tabId: 'tab-2', paneId: 'pane-2', terminalId: 'term-2', at: 100 }))
    })

    await waitFor(() => {
      expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBe(true)
    })

    // Regain focus without switching tabs — attention should persist
    act(() => {
      hasFocus = true
      window.dispatchEvent(new Event('focus'))
    })

    // Give React a chance to flush effects
    await waitFor(() => {
      expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBe(true)
    })
    expect(store.getState().turnCompletion.attentionByPane['pane-2']).toBe(true)
  })

  it('click mode: switching to a tab with attention clears both tab and pane attention', async () => {
    const store = createStore('tab-1', 'click')

    render(
      <Provider store={store}>
        <TestComponent />
      </Provider>
    )

    // Background tab completes
    act(() => {
      store.dispatch(recordTurnComplete({ tabId: 'tab-2', paneId: 'pane-2', terminalId: 'term-2', at: 100 }))
    })

    await waitFor(() => {
      expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBe(true)
    })
    expect(store.getState().turnCompletion.attentionByPane['pane-2']).toBe(true)

    // Simulate switching to tab-2 (as TabBar click would)
    act(() => {
      store.dispatch(setActiveTab('tab-2'))
    })

    await waitFor(() => {
      expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBeUndefined()
    })
    expect(store.getState().turnCompletion.attentionByPane['pane-2']).toBeUndefined()
  })
})
