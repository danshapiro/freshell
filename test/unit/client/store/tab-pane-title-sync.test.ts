import { describe, it, expect, vi, beforeEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { addTab } from '../../../../src/store/tabsSlice'
import panesReducer, {
  initLayout,
  splitPane,
  updatePaneTitle,
} from '../../../../src/store/panesSlice'
import type { PaneNode } from '../../../../src/store/paneTypes'
import { syncPaneTitleByTerminalId } from '../../../../src/store/paneTitleSync'
import { applyPaneRename, applyTabRename } from '../../../../src/store/titleSync'
import { getTabDisplayTitle } from '../../../../src/lib/tab-title'

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

  describe('explicit rename coordinators', () => {
    it('renaming the only pane also renames its tab', () => {
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

      const trimmed = 'New Pane Title'
      store.dispatch(applyPaneRename({ tabId, paneId, title: trimmed }))

      expect(store.getState().tabs.tabs[0].title).toBe('New Pane Title')
      expect(store.getState().tabs.tabs[0].titleSetByUser).toBe(true)
      expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('New Pane Title')
    })

    it('renaming a pane in a multi-pane tab leaves the tab title alone', () => {
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
      store.dispatch(applyPaneRename({ tabId, paneId: firstPaneId, title: trimmed }))

      expect(store.getState().tabs.tabs[0].title).toBe('Original Tab Title')
      expect(store.getState().panes.paneTitles[tabId][firstPaneId]).toBe('Renamed Pane')
    })

    it('renaming a single-pane tab also renames its only pane', () => {
      const store = createStore()

      store.dispatch(addTab({ title: 'Original Tab Title', mode: 'shell' }))
      const tabId = store.getState().tabs.tabs[0].id
      store.dispatch(initLayout({
        tabId,
        content: { kind: 'terminal', mode: 'shell', terminalId: 'term-42' },
      }))

      const paneId = (store.getState().panes.layouts[tabId] as Extract<PaneNode, { type: 'leaf' }>).id

      store.dispatch(applyTabRename({ tabId, title: 'Ops Desk' }))

      expect(store.getState().tabs.tabs[0].title).toBe('Ops Desk')
      expect(store.getState().tabs.tabs[0].titleSetByUser).toBe(true)
      expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('Ops Desk')
    })

    it('renaming a multi-pane tab does not rewrite existing pane titles', () => {
      const store = createStore()

      store.dispatch(addTab({ title: 'Original Tab Title', mode: 'shell' }))
      const tabId = store.getState().tabs.tabs[0].id
      store.dispatch(initLayout({
        tabId,
        content: { kind: 'terminal', mode: 'shell', terminalId: 'term-42' },
      }))
      const firstPaneId = (store.getState().panes.layouts[tabId] as Extract<PaneNode, { type: 'leaf' }>).id
      store.dispatch(splitPane({
        tabId,
        paneId: firstPaneId,
        direction: 'horizontal',
        newContent: { kind: 'terminal', mode: 'shell' },
      }))
      store.dispatch(updatePaneTitle({ tabId, paneId: firstPaneId, title: 'Shell A' }))

      store.dispatch(applyTabRename({ tabId, title: 'Workspace' }))

      expect(store.getState().tabs.tabs[0].title).toBe('Workspace')
      expect(store.getState().panes.paneTitles[tabId][firstPaneId]).toBe('Shell A')
    })
  })

  describe('runtime title sync uses pane state as the source of truth', () => {
    it('updates the only pane title and lets the tab display follow it', async () => {
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
      expect(store.getState().panes.paneTitleSetByUser?.[tabId]?.[paneId]).toBeUndefined()

      // The stored tab title remains untouched; display title resolves from the only pane.
      expect(store.getState().tabs.tabs[0].title).toBe('Original Title')
      expect(getTabDisplayTitle(
        store.getState().tabs.tabs[0],
        store.getState().panes.layouts[tabId],
        store.getState().panes.paneTitles[tabId],
      )).toBe('Session Rename')
    })

    it('does not update tab display for multi-pane tabs', async () => {
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

      // Tab title should NOT be updated; the display stays on the tab-derived label.
      expect(store.getState().tabs.tabs[0].title).toBe('Original Title')
      expect(getTabDisplayTitle(
        store.getState().tabs.tabs[0],
        store.getState().panes.layouts[tabId],
        store.getState().panes.paneTitles[tabId],
      )).toBe('Claude')
    })

    it('updates the display title across multiple single-pane tabs sharing a terminalId', async () => {
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

      // Both tabs keep their stored titles, but their display titles follow the only pane.
      expect(store.getState().tabs.tabs[0].title).toBe('Tab 1')
      expect(store.getState().tabs.tabs[1].title).toBe('Tab 2')
      expect(getTabDisplayTitle(
        store.getState().tabs.tabs[0],
        store.getState().panes.layouts[tab1Id],
        store.getState().panes.paneTitles[tab1Id],
      )).toBe('Shared Session')
      expect(getTabDisplayTitle(
        store.getState().tabs.tabs[1],
        store.getState().panes.layouts[tab2Id],
        store.getState().panes.paneTitles[tab2Id],
      )).toBe('Shared Session')
    })

    it('only updates single-pane displays, leaving multi-pane tabs unchanged', async () => {
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

      // Single-pane tab: display title follows the only pane.
      expect(store.getState().tabs.tabs[0].title).toBe('Single Pane Tab')
      expect(getTabDisplayTitle(
        store.getState().tabs.tabs[0],
        store.getState().panes.layouts[tab1Id],
        store.getState().panes.paneTitles[tab1Id],
      )).toBe('New Name')
      // Multi-pane tab: stored title stays unchanged and display stays on the tab-derived label.
      expect(store.getState().tabs.tabs[1].title).toBe('Multi Pane Tab')
      expect(getTabDisplayTitle(
        store.getState().tabs.tabs[1],
        store.getState().panes.layouts[tab2Id],
        store.getState().panes.paneTitles[tab2Id],
      )).toBe('Claude')
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
      expect(getTabDisplayTitle(
        store.getState().tabs.tabs[0],
        store.getState().panes.layouts[tabId],
        store.getState().panes.paneTitles[tabId],
      )).toBe('Shell')
    })
  })
})
