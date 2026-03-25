import { describe, it, expect } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { addTab, closeTab, reopenClosedTab } from '@/store/tabsSlice'
import panesReducer, { initLayout, addPane } from '@/store/panesSlice'
import tabRegistryReducer from '@/store/tabRegistrySlice'

function createStore() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      tabRegistry: tabRegistryReducer,
    },
  })
}

describe('reopenClosedTab', () => {
  it('does nothing when reopen stack is empty', async () => {
    const store = createStore()
    await store.dispatch(reopenClosedTab() as any)
    expect(store.getState().tabs.tabs).toHaveLength(0)
  })

  it('reopens the most recently closed tab in LIFO order', async () => {
    const store = createStore()

    // Create and set up two tabs
    store.dispatch(addTab({ title: 'First' }))
    const firstId = store.getState().tabs.tabs[0].id
    store.dispatch(initLayout({
      tabId: firstId,
      content: { kind: 'terminal', mode: 'shell' },
    }))

    store.dispatch(addTab({ title: 'Second' }))
    const secondId = store.getState().tabs.tabs[1].id
    store.dispatch(initLayout({
      tabId: secondId,
      content: { kind: 'terminal', mode: 'claude' },
    }))

    // Close both (second then first — stack order: first on bottom, second on top)
    await store.dispatch(closeTab(secondId) as any)
    await store.dispatch(closeTab(firstId) as any)

    expect(store.getState().tabs.tabs).toHaveLength(0)
    expect(store.getState().tabRegistry.reopenStack).toHaveLength(2)

    // Reopen — should get "First" back (LIFO — it was closed last)
    await store.dispatch(reopenClosedTab() as any)
    expect(store.getState().tabs.tabs).toHaveLength(1)
    expect(store.getState().tabs.tabs[0].title).toBe('First')
    expect(store.getState().tabs.activeTabId).toBe(store.getState().tabs.tabs[0].id)

    // Layout should be restored
    const tabId = store.getState().tabs.tabs[0].id
    expect(store.getState().panes.layouts[tabId]).toBeDefined()

    // Reopen again — should get "Second"
    await store.dispatch(reopenClosedTab() as any)
    expect(store.getState().tabs.tabs).toHaveLength(2)
    expect(store.getState().tabs.tabs[1].title).toBe('Second')

    // Stack should now be empty
    expect(store.getState().tabRegistry.reopenStack).toHaveLength(0)
  })

  it('preserves multi-pane layout structure on reopen', async () => {
    const store = createStore()

    store.dispatch(addTab({ title: 'Multi-pane' }))
    const tabId = store.getState().tabs.tabs[0].id
    store.dispatch(initLayout({
      tabId,
      content: { kind: 'terminal', mode: 'shell' },
    }))
    store.dispatch(addPane({
      tabId,
      newContent: { kind: 'terminal', mode: 'claude' },
    }))

    // Verify multi-pane before close
    const layoutBefore = store.getState().panes.layouts[tabId]!
    expect(layoutBefore.type).toBe('split')

    await store.dispatch(closeTab(tabId) as any)
    expect(store.getState().tabs.tabs).toHaveLength(0)

    await store.dispatch(reopenClosedTab() as any)
    const newTabId = store.getState().tabs.tabs[0].id
    const layoutAfter = store.getState().panes.layouts[newTabId]!
    expect(layoutAfter.type).toBe('split')
  })

  it('restores titleSetByUser flag', async () => {
    const store = createStore()

    store.dispatch(addTab({ title: 'Custom Title' }))
    const tabId = store.getState().tabs.tabs[0].id
    // Simulate user setting the title
    store.dispatch({ type: 'tabs/updateTab', payload: { id: tabId, updates: { titleSetByUser: true } } })
    store.dispatch(initLayout({
      tabId,
      content: { kind: 'terminal', mode: 'shell' },
    }))

    await store.dispatch(closeTab(tabId) as any)
    await store.dispatch(reopenClosedTab() as any)

    expect(store.getState().tabs.tabs[0].titleSetByUser).toBe(true)
    expect(store.getState().tabs.tabs[0].title).toBe('Custom Title')
  })

  it('clears the corresponding localClosed entry when reopening a tab that had one', async () => {
    const store = createStore()

    // Create a tab with enough "significance" to be kept in localClosed
    store.dispatch(addTab({ title: 'Important' }))
    const tabId = store.getState().tabs.tabs[0].id
    // Set titleSetByUser so shouldKeepClosedTab returns true
    store.dispatch({ type: 'tabs/updateTab', payload: { id: tabId, updates: { titleSetByUser: true } } })
    store.dispatch(initLayout({
      tabId,
      content: { kind: 'terminal', mode: 'shell' },
    }))

    await store.dispatch(closeTab(tabId) as any)

    // Both localClosed and reopenStack should have entries
    expect(Object.keys(store.getState().tabRegistry.localClosed).length).toBeGreaterThan(0)
    expect(store.getState().tabRegistry.reopenStack.length).toBeGreaterThan(0)

    // Get the tabKey used in localClosed
    const closedTabKey = Object.keys(store.getState().tabRegistry.localClosed)[0]

    await store.dispatch(reopenClosedTab() as any)

    // After reopen, localClosed entry should be removed
    expect(store.getState().tabRegistry.localClosed[closedTabKey]).toBeUndefined()
  })
})
