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
