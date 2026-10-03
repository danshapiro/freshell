import { describe, it, expect, vi } from 'vitest'

const { paneCloseAckHandlers } = vi.hoisted(() => ({
  paneCloseAckHandlers: new Set<(msg: unknown) => void>(),
}))

// Delta-r7-r3 (focused-episode-7 round 2, Finding F2): the close gate awaits
// the correlated `pane.closed.result` before the layout loses a pane — this
// mock answers EVERY pane.closed with success (the healthy-server shape), so
// these tests exercise the acknowledged-close path end to end.
vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: (msg: unknown) => {
      const m = msg as { type?: string; createRequestId?: string; requestId?: string }
      if (m?.type === 'pane.closed' && m.createRequestId) {
        for (const handler of [...paneCloseAckHandlers]) {
          handler({ type: 'pane.closed.result', createRequestId: m.createRequestId, success: true })
        }
      }
      // Focused-episode-7 round 3 (Finding F1): the whole-tab close is ONE
      // batch envelope — answer the correlated `panes.closed.result` (the
      // healthy-server shape), same as the per-pane lane above.
      if (m?.type === 'panes.closed' && m.requestId) {
        for (const handler of [...paneCloseAckHandlers]) {
          handler({ type: 'panes.closed.result', requestId: m.requestId, success: true })
        }
      }
    },
    onMessage: (handler: (msg: unknown) => void) => {
      paneCloseAckHandlers.add(handler)
      return () => {
        paneCloseAckHandlers.delete(handler)
      }
    },
  }),
  resetWsClientForTests: vi.fn(),
}))


import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { addTab, closeTab, reopenClosedTab, setTabNameSource } from '../../../../src/store/tabsSlice'
import panesReducer, { addPane, initLayout } from '../../../../src/store/panesSlice'
import tabRegistryReducer from '../../../../src/store/tabRegistrySlice'

describe('tabsSlice closed registry capture', () => {
  it('keeps closed snapshots when pane count is greater than one', async () => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        tabRegistry: tabRegistryReducer,
      },
    })

    store.dispatch(addTab({ title: 'freshell' }))
    const tabId = store.getState().tabs.tabs[0]!.id

    store.dispatch(initLayout({
      tabId,
      content: { kind: 'terminal', mode: 'shell', status: 'running' },
    }))
    store.dispatch(addPane({
      tabId,
      newContent: { kind: 'terminal', mode: 'shell', status: 'running' },
    }))

    await store.dispatch(closeTab(tabId) as any)
    expect(Object.keys(store.getState().tabRegistry.localClosed)).toHaveLength(1)
  })

  it('pushes a ClosedTabEntry to the reopen stack on close', async () => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        tabRegistry: tabRegistryReducer,
      },
    })

    store.dispatch(addTab({ title: 'My Tab' }))
    const tabId = store.getState().tabs.tabs[0]!.id

    store.dispatch(initLayout({
      tabId,
      content: { kind: 'terminal', mode: 'shell', status: 'running' },
    }))

    await store.dispatch(closeTab(tabId) as any)

    const { reopenStack } = store.getState().tabRegistry
    expect(reopenStack).toHaveLength(1)
    expect(reopenStack[0].tab.title).toBe('My Tab')
    expect(reopenStack[0].layout.type).toBe('leaf')
    expect(reopenStack[0].closedAt).toBeGreaterThan(0)
  })

  it('pushes entries in LIFO order on the reopen stack', async () => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        tabRegistry: tabRegistryReducer,
      },
    })

    store.dispatch(addTab({ title: 'First' }))
    const firstId = store.getState().tabs.tabs[0]!.id
    store.dispatch(initLayout({
      tabId: firstId,
      content: { kind: 'terminal', mode: 'shell', status: 'running' },
    }))

    store.dispatch(addTab({ title: 'Second' }))
    const secondId = store.getState().tabs.tabs[1]!.id
    store.dispatch(initLayout({
      tabId: secondId,
      content: { kind: 'terminal', mode: 'claude', status: 'running' },
    }))

    await store.dispatch(closeTab(secondId) as any)
    await store.dispatch(closeTab(firstId) as any)

    const { reopenStack } = store.getState().tabRegistry
    expect(reopenStack).toHaveLength(2)
    expect(reopenStack[0].tab.title).toBe('Second')
    expect(reopenStack[1].tab.title).toBe('First')
  })

  it('does not keep short-lived single-pane tabs with default title behavior', async () => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        tabRegistry: tabRegistryReducer,
      },
    })

    store.dispatch(addTab({ title: 'temp', titleSetByUser: false }))
    const tabId = store.getState().tabs.tabs[0]!.id

    store.dispatch(initLayout({
      tabId,
      content: { kind: 'terminal', mode: 'shell' },
    }))

    await store.dispatch(closeTab(tabId) as any)
    expect(Object.keys(store.getState().tabRegistry.localClosed)).toHaveLength(0)
  })
})

describe('tabsSlice closed registry capture — unified agent names (Task 6)', () => {
  it('stamps the closed snapshot with the tab nameSource and reopen restores it', async () => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        tabRegistry: tabRegistryReducer,
      },
    })

    store.dispatch(addTab({ title: 'Owned' }))
    const tabId = store.getState().tabs.tabs[0]!.id
    store.dispatch(initLayout({
      tabId,
      paneId: 'p-agent',
      content: { kind: 'terminal', mode: 'claude', status: 'running' },
    }))
    // A second pane makes the closed tab registry-keepable (the single-pane
    // short-lived rule would drop the snapshot).
    store.dispatch(addPane({
      tabId,
      newContent: { kind: 'terminal', mode: 'shell', status: 'running' },
    }))
    // The lifecycle middleware is not registered in this harness; pin the
    // pointer explicitly the way any resolved tab would carry it.
    store.dispatch(setTabNameSource({
      tabId,
      nameSource: { kind: 'session', paneId: 'p-agent' },
    }))

    await store.dispatch(closeTab(tabId) as any)

    // The closed registry record keeps the source relationship.
    const closedRecords = Object.values(store.getState().tabRegistry.localClosed)
    expect(closedRecords).toHaveLength(1)
    expect(closedRecords[0]!.nameSource).toEqual({ kind: 'session', paneId: 'p-agent' })

    // And the reopen stack restores a tab that keeps the pointer.
    const { reopenStack } = store.getState().tabRegistry
    expect(reopenStack).toHaveLength(1)
    expect(reopenStack[0].tab.nameSource).toEqual({ kind: 'session', paneId: 'p-agent' })

    await store.dispatch(reopenClosedTab() as any)
    const reopened = store.getState().tabs.tabs.find((t) => t.id !== tabId)
    expect(reopened).toBeTruthy()
    expect(reopened?.nameSource).toEqual({ kind: 'session', paneId: 'p-agent' })
  })
})
