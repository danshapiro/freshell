import { describe, it, expect } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { addTab, closeTab } from '../../../../src/store/tabsSlice'
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
      content: { kind: 'terminal', mode: 'shell' },
    }))
    store.dispatch(addPane({
      tabId,
      newContent: { kind: 'terminal', mode: 'shell' },
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
      content: { kind: 'terminal', mode: 'shell' },
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
      content: { kind: 'terminal', mode: 'shell' },
    }))

    store.dispatch(addTab({ title: 'Second' }))
    const secondId = store.getState().tabs.tabs[1]!.id
    store.dispatch(initLayout({
      tabId: secondId,
      content: { kind: 'terminal', mode: 'claude' },
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
