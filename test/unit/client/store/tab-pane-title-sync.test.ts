import { describe, it, expect, vi, beforeEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { addTab, updateTab } from '../../../../src/store/tabsSlice'
import panesReducer, {
  initLayout,
  splitPane,
  updatePaneTitle,
  updatePaneTitleByTerminalId,
  PanesState,
} from '../../../../src/store/panesSlice'
import type { PaneNode } from '../../../../src/store/paneTypes'
import { syncPaneTitleByTerminalId } from '../../../../src/store/paneTitleSync'

// Mock nanoid to return predictable IDs for testing
let mockIdCounter = 0
vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => `pane-${++mockIdCounter}`),
}))

function createStore() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
    },
  })
}

describe('tab-pane title sync for single-pane tabs', () => {
  beforeEach(() => {
    mockIdCounter = 0
    vi.clearAllMocks()
  })

  describe('Direction 1: commitRename on single-pane tab syncs tab title', () => {
    it('updates tab title when the only pane is renamed', () => {
      const store = createStore()

      // Create a tab
      store.dispatch(addTab({ title: 'Original Tab Title', mode: 'claude' }))
      const tabId = store.getState().tabs.tabs[0].id

      // Initialize a single-pane layout
      store.dispatch(initLayout({
        tabId,
        content: { kind: 'terminal', mode: 'claude', terminalId: 'term-1' },
      }))

      const rootNode = store.getState().panes.layouts[tabId]
      expect(rootNode.type).toBe('leaf')
      const paneId = (rootNode as Extract<PaneNode, { type: 'leaf' }>).id

      // Simulate what commitRename does: dispatch updatePaneTitle, then check
      // if single-pane and dispatch updateTab
      const trimmed = 'New Pane Title'
      store.dispatch(updatePaneTitle({ tabId, paneId, title: trimmed }))

      // If it's a single-pane tab, also update the tab title
      const layout = store.getState().panes.layouts[tabId]
      if (layout?.type === 'leaf') {
        store.dispatch(updateTab({ id: tabId, updates: { title: trimmed } }))
      }

      expect(store.getState().tabs.tabs[0].title).toBe('New Pane Title')
      expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('New Pane Title')
    })

    it('does NOT update tab title when a multi-pane tab pane is renamed', () => {
      const store = createStore()

      // Create a tab
      store.dispatch(addTab({ title: 'Original Tab Title', mode: 'shell' }))
      const tabId = store.getState().tabs.tabs[0].id

      // Initialize a layout and split it
      store.dispatch(initLayout({
        tabId,
        content: { kind: 'terminal', mode: 'shell' },
      }))
      const rootBefore = store.getState().panes.layouts[tabId]
      const firstPaneId = (rootBefore as Extract<PaneNode, { type: 'leaf' }>).id

      store.dispatch(splitPane({
        tabId,
        paneId: firstPaneId,
        direction: 'horizontal',
        newContent: { kind: 'terminal', mode: 'shell' },
      }))

      // Now there are 2 panes (split layout)
      const rootAfter = store.getState().panes.layouts[tabId]
      expect(rootAfter.type).toBe('split')

      // Rename the first pane
      const trimmed = 'Renamed Pane'
      store.dispatch(updatePaneTitle({ tabId, paneId: firstPaneId, title: trimmed }))

      // Check: since it's a multi-pane tab, tab title should NOT change
      const layout = store.getState().panes.layouts[tabId]
      if (layout?.type === 'leaf') {
        store.dispatch(updateTab({ id: tabId, updates: { title: trimmed } }))
      }

      expect(store.getState().tabs.tabs[0].title).toBe('Original Tab Title')
      expect(store.getState().panes.paneTitles[tabId][firstPaneId]).toBe('Renamed Pane')
    })
  })

  describe('Direction 2: syncPaneTitleByTerminalId syncs tab title for single-pane tabs', () => {
    it('updates tab title when the only pane matches the terminalId', async () => {
      const store = createStore()

      // Create a tab
      store.dispatch(addTab({ title: 'Original Title', mode: 'claude' }))
      const tabId = store.getState().tabs.tabs[0].id

      // Initialize a single-pane layout with a terminalId
      store.dispatch(initLayout({
        tabId,
        content: { kind: 'terminal', mode: 'claude', terminalId: 'term-42' },
      }))

      const rootNode = store.getState().panes.layouts[tabId]
      expect(rootNode.type).toBe('leaf')

      // Dispatch the thunk that syncs both pane title and tab title
      await store.dispatch(syncPaneTitleByTerminalId({ terminalId: 'term-42', title: 'Session Rename' }))

      // Pane title should be updated
      const paneId = (store.getState().panes.layouts[tabId] as Extract<PaneNode, { type: 'leaf' }>).id
      expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('Session Rename')

      // Tab title should also be updated because it's a single-pane tab
      expect(store.getState().tabs.tabs[0].title).toBe('Session Rename')
    })

    it('does NOT update tab title for multi-pane tabs', async () => {
      const store = createStore()

      // Create a tab
      store.dispatch(addTab({ title: 'Original Title', mode: 'shell' }))
      const tabId = store.getState().tabs.tabs[0].id

      // Initialize and split
      store.dispatch(initLayout({
        tabId,
        content: { kind: 'terminal', mode: 'claude', terminalId: 'term-42' },
      }))
      const firstPaneId = (store.getState().panes.layouts[tabId] as Extract<PaneNode, { type: 'leaf' }>).id

      store.dispatch(splitPane({
        tabId,
        paneId: firstPaneId,
        direction: 'horizontal',
        newContent: { kind: 'terminal', mode: 'shell' },
      }))

      expect(store.getState().panes.layouts[tabId].type).toBe('split')

      // Dispatch the thunk
      await store.dispatch(syncPaneTitleByTerminalId({ terminalId: 'term-42', title: 'Session Rename' }))

      // Pane title should be updated
      expect(store.getState().panes.paneTitles[tabId][firstPaneId]).toBe('Session Rename')

      // Tab title should NOT be updated (multi-pane)
      expect(store.getState().tabs.tabs[0].title).toBe('Original Title')
    })

    it('updates tab titles across multiple single-pane tabs sharing a terminalId', async () => {
      const store = createStore()

      // Create two tabs, both with single panes and same terminalId
      store.dispatch(addTab({ title: 'Tab 1', mode: 'claude' }))
      store.dispatch(addTab({ title: 'Tab 2', mode: 'claude' }))
      const tab1Id = store.getState().tabs.tabs[0].id
      const tab2Id = store.getState().tabs.tabs[1].id

      store.dispatch(initLayout({
        tabId: tab1Id,
        content: { kind: 'terminal', mode: 'claude', terminalId: 'term-shared' },
      }))
      store.dispatch(initLayout({
        tabId: tab2Id,
        content: { kind: 'terminal', mode: 'claude', terminalId: 'term-shared' },
      }))

      await store.dispatch(syncPaneTitleByTerminalId({ terminalId: 'term-shared', title: 'Shared Session' }))

      // Both tab titles should be updated
      expect(store.getState().tabs.tabs[0].title).toBe('Shared Session')
      expect(store.getState().tabs.tabs[1].title).toBe('Shared Session')
    })

    it('only updates single-pane tab titles, leaving multi-pane tabs unchanged', async () => {
      const store = createStore()

      // Tab 1: single-pane with term-42
      store.dispatch(addTab({ title: 'Single Pane Tab', mode: 'claude' }))
      const tab1Id = store.getState().tabs.tabs[0].id
      store.dispatch(initLayout({
        tabId: tab1Id,
        content: { kind: 'terminal', mode: 'claude', terminalId: 'term-42' },
      }))

      // Tab 2: multi-pane with term-42 in one of its panes
      store.dispatch(addTab({ title: 'Multi Pane Tab', mode: 'shell' }))
      const tab2Id = store.getState().tabs.tabs[1].id
      store.dispatch(initLayout({
        tabId: tab2Id,
        content: { kind: 'terminal', mode: 'claude', terminalId: 'term-42' },
      }))
      const tab2PaneId = (store.getState().panes.layouts[tab2Id] as Extract<PaneNode, { type: 'leaf' }>).id
      store.dispatch(splitPane({
        tabId: tab2Id,
        paneId: tab2PaneId,
        direction: 'horizontal',
        newContent: { kind: 'terminal', mode: 'shell' },
      }))

      await store.dispatch(syncPaneTitleByTerminalId({ terminalId: 'term-42', title: 'New Name' }))

      // Single-pane tab: title updated
      expect(store.getState().tabs.tabs[0].title).toBe('New Name')
      // Multi-pane tab: title NOT updated
      expect(store.getState().tabs.tabs[1].title).toBe('Multi Pane Tab')
    })

    it('does nothing when no pane matches the terminalId', async () => {
      const store = createStore()

      store.dispatch(addTab({ title: 'Some Tab', mode: 'shell' }))
      const tabId = store.getState().tabs.tabs[0].id
      store.dispatch(initLayout({
        tabId,
        content: { kind: 'terminal', mode: 'shell', terminalId: 'term-99' },
      }))

      await store.dispatch(syncPaneTitleByTerminalId({ terminalId: 'term-nonexistent', title: 'Should Not Appear' }))

      expect(store.getState().tabs.tabs[0].title).toBe('Some Tab')
    })
  })
})
