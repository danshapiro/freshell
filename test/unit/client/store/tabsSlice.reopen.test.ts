// Tests for the reopenClosedTab thunk (Alt+H feature).

import { describe, it, expect } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { addTab, closeTab, reopenClosedTab } from '../../../../src/store/tabsSlice'
import panesReducer, { initLayout, splitPane } from '../../../../src/store/panesSlice'
import tabRegistryReducer from '../../../../src/store/tabRegistrySlice'
import type { TerminalPaneContent, BrowserPaneContent } from '../../../../src/store/paneTypes'

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
  it('restores the most recently closed tab', async () => {
    const store = createStore()

    store.dispatch(addTab({ title: 'Keep Open' }))
    const keepId = store.getState().tabs.tabs[0]!.id
    store.dispatch(initLayout({ tabId: keepId, content: { kind: 'terminal', mode: 'shell' } }))

    store.dispatch(addTab({ title: 'Will Close' }))
    const closeId = store.getState().tabs.tabs[1]!.id
    store.dispatch(initLayout({ tabId: closeId, content: { kind: 'terminal', mode: 'shell' } }))

    await store.dispatch(closeTab(closeId) as any)
    expect(store.getState().tabs.tabs).toHaveLength(1)

    await store.dispatch(reopenClosedTab() as any)

    const tabs = store.getState().tabs.tabs
    expect(tabs).toHaveLength(2)
    expect(tabs[1].title).toBe('Will Close')
    // Should be the active tab
    expect(store.getState().tabs.activeTabId).toBe(tabs[1].id)
    // Should have a new ID (not the old one)
    expect(tabs[1].id).not.toBe(closeId)
  })

  it('restores tabs in LIFO order', async () => {
    const store = createStore()

    store.dispatch(addTab({ title: 'Anchor' }))
    const anchorId = store.getState().tabs.tabs[0]!.id
    store.dispatch(initLayout({ tabId: anchorId, content: { kind: 'terminal', mode: 'shell' } }))

    store.dispatch(addTab({ title: 'First Closed' }))
    const firstId = store.getState().tabs.tabs[1]!.id
    store.dispatch(initLayout({ tabId: firstId, content: { kind: 'terminal', mode: 'shell' } }))

    store.dispatch(addTab({ title: 'Second Closed' }))
    const secondId = store.getState().tabs.tabs[2]!.id
    store.dispatch(initLayout({ tabId: secondId, content: { kind: 'terminal', mode: 'shell' } }))

    await store.dispatch(closeTab(secondId) as any)
    await store.dispatch(closeTab(firstId) as any)

    // First reopen should get "First Closed" (last closed)
    await store.dispatch(reopenClosedTab() as any)
    expect(store.getState().tabs.tabs[1].title).toBe('First Closed')

    // Second reopen should get "Second Closed"
    await store.dispatch(reopenClosedTab() as any)
    expect(store.getState().tabs.tabs[2].title).toBe('Second Closed')
  })

  it('does nothing when the reopen stack is empty', async () => {
    const store = createStore()

    store.dispatch(addTab({ title: 'Only Tab' }))
    const tabId = store.getState().tabs.tabs[0]!.id
    store.dispatch(initLayout({ tabId, content: { kind: 'terminal', mode: 'shell' } }))

    await store.dispatch(reopenClosedTab() as any)

    expect(store.getState().tabs.tabs).toHaveLength(1)
    expect(store.getState().tabs.activeTabId).toBe(tabId)
  })

  it('restores split layouts with fresh terminal IDs', async () => {
    const store = createStore()

    store.dispatch(addTab({ title: 'Anchor' }))
    const anchorId = store.getState().tabs.tabs[0]!.id
    store.dispatch(initLayout({ tabId: anchorId, content: { kind: 'terminal', mode: 'shell' } }))

    store.dispatch(addTab({ title: 'Split Tab' }))
    const splitTabId = store.getState().tabs.tabs[1]!.id
    store.dispatch(initLayout({ tabId: splitTabId, content: { kind: 'terminal', mode: 'shell' } }))

    // Add a split pane
    const firstPaneId = store.getState().panes.activePane[splitTabId]
    store.dispatch(splitPane({
      tabId: splitTabId,
      paneId: firstPaneId,
      direction: 'horizontal',
      newContent: { kind: 'browser', url: 'https://example.com', devToolsOpen: false },
    }))

    const layoutBeforeClose = store.getState().panes.layouts[splitTabId]
    expect(layoutBeforeClose.type).toBe('split')

    await store.dispatch(closeTab(splitTabId) as any)
    await store.dispatch(reopenClosedTab() as any)

    const reopenedTabId = store.getState().tabs.activeTabId!
    const restoredLayout = store.getState().panes.layouts[reopenedTabId]
    expect(restoredLayout).toBeDefined()
    expect(restoredLayout.type).toBe('split')

    if (restoredLayout.type === 'split') {
      const termLeaf = restoredLayout.children[0]
      const browserLeaf = restoredLayout.children[1]
      if (termLeaf.type === 'leaf') {
        // Terminal should have fresh createRequestId and no stale terminalId
        expect((termLeaf.content as TerminalPaneContent).terminalId).toBeUndefined()
        expect((termLeaf.content as TerminalPaneContent).status).toBe('creating')
      }
      if (browserLeaf.type === 'leaf') {
        expect((browserLeaf.content as BrowserPaneContent).url).toBe('https://example.com')
      }
    }
  })

  it('pops the entry from the stack after reopening', async () => {
    const store = createStore()

    store.dispatch(addTab({ title: 'Anchor' }))
    const anchorId = store.getState().tabs.tabs[0]!.id
    store.dispatch(initLayout({ tabId: anchorId, content: { kind: 'terminal', mode: 'shell' } }))

    store.dispatch(addTab({ title: 'Closed' }))
    const closeId = store.getState().tabs.tabs[1]!.id
    store.dispatch(initLayout({ tabId: closeId, content: { kind: 'terminal', mode: 'shell' } }))

    await store.dispatch(closeTab(closeId) as any)
    expect(store.getState().tabRegistry.reopenStack).toHaveLength(1)

    await store.dispatch(reopenClosedTab() as any)
    expect(store.getState().tabRegistry.reopenStack).toHaveLength(0)
  })
})
