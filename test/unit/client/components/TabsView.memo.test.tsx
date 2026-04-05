import { useCallback, useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { addTab } from '@/store/tabsSlice'
import panesReducer, { initLayout } from '@/store/panesSlice'
import tabRegistryReducer, { setTabRegistrySnapshot } from '@/store/tabRegistrySlice'
import connectionReducer from '@/store/connectionSlice'
import TabsView from '@/components/TabsView'

const renderCounters = vi.hoisted(() => ({
  contextMenuCalls: 0,
}))

const wsMock = {
  state: 'ready',
  sendTabsSyncQuery: vi.fn(),
  sendTabsSyncPush: vi.fn(),
  onMessage: vi.fn(() => () => {}),
  onReconnect: vi.fn(() => () => {}),
}

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => wsMock,
}))

vi.mock('@/lib/clipboard', () => ({
  copyText: vi.fn(() => Promise.resolve(true)),
}))

vi.mock('@/components/context-menu/ContextMenu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/context-menu/ContextMenu')>()
  return {
    ...actual,
    ContextMenu: ({ children }: { children: any }) => {
      renderCounters.contextMenuCalls += 1
      return <>{children}</>
    },
  }
})

function createStore() {
  const store = configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      tabRegistry: tabRegistryReducer,
      connection: connectionReducer,
    },
  })

  store.dispatch(addTab({ id: 'local-tab', title: 'local tab', mode: 'shell' }))
  store.dispatch(initLayout({
    tabId: 'local-tab',
    content: { kind: 'terminal', mode: 'shell' },
  }))

  store.dispatch(setTabRegistrySnapshot({
    localOpen: [],
    remoteOpen: [{
      tabKey: 'remote:open',
      tabId: 'open-1',
      serverInstanceId: 'srv-remote',
      deviceId: 'remote',
      deviceLabel: 'remote-device',
      tabName: 'remote open',
      status: 'open',
      revision: 1,
      createdAt: 1,
      updatedAt: 2,
      paneCount: 1,
      titleSetByUser: false,
      panes: [],
    }],
    closed: [],
  }))

  return store
}

function StableTabsViewHarness() {
  const [count, setCount] = useState(0)
  const handleOpenTab = useCallback(() => {}, [])

  return (
    <>
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        Parent rerender {count}
      </button>
      <TabsView onOpenTab={handleOpenTab} />
    </>
  )
}

function InlineTabsViewHarness() {
  const [count, setCount] = useState(0)

  return (
    <>
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        Parent rerender {count}
      </button>
      <TabsView onOpenTab={() => {}} />
    </>
  )
}

describe('TabsView memo behavior', () => {
  beforeEach(() => {
    wsMock.sendTabsSyncQuery.mockClear()
    renderCounters.contextMenuCalls = 0
  })

  afterEach(() => {
    cleanup()
  })

  it('does not rerender on an unrelated parent rerender when onOpenTab is stable', () => {
    const store = createStore()

    render(
      <Provider store={store}>
        <StableTabsViewHarness />
      </Provider>,
    )

    const initialRenderCount = renderCounters.contextMenuCalls
    expect(initialRenderCount).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: /parent rerender/i }))

    expect(renderCounters.contextMenuCalls).toBe(initialRenderCount)
  })

  it('rerenders when a parent rerender passes a fresh inline onOpenTab callback', () => {
    const store = createStore()

    render(
      <Provider store={store}>
        <InlineTabsViewHarness />
      </Provider>,
    )

    const initialRenderCount = renderCounters.contextMenuCalls
    expect(initialRenderCount).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: /parent rerender/i }))

    expect(renderCounters.contextMenuCalls).toBeGreaterThan(initialRenderCount)
  })
})
