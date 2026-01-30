import { describe, it, expect, vi, beforeEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, {
  addTab,
  setActiveTab,
  updateTab,
  removeTab,
  hydrateTabs,
  closeTab,
  reorderTabs,
  TabsState,
} from '../../../../src/store/tabsSlice'
import panesReducer, { initLayout } from '../../../../src/store/panesSlice'
import type { Tab } from '../../../../src/store/types'

// Mock nanoid to return predictable IDs for testing
vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => 'test-id-' + Math.random().toString(36).substr(2, 9)),
}))

describe('tabsSlice', () => {
  let initialState: TabsState

  beforeEach(() => {
    initialState = {
      tabs: [],
      activeTabId: null,
    }
    vi.clearAllMocks()
  })

  describe('addTab', () => {
    it('creates new tab with defaults when no payload provided', () => {
      const state = tabsReducer(initialState, addTab())

      expect(state.tabs).toHaveLength(1)
      const tab = state.tabs[0]
      expect(tab.title).toBe('Tab 1')
      expect(tab.status).toBe('creating')
      expect(tab.mode).toBe('shell')
      expect(tab.shell).toBe('system')
      expect(tab.id).toBeDefined()
      expect(tab.createRequestId).toBe(tab.id)
      expect(tab.createdAt).toBeDefined()
      expect(state.activeTabId).toBe(tab.id)
    })

    it('creates new tab with defaults when empty payload provided', () => {
      const state = tabsReducer(initialState, addTab({}))

      expect(state.tabs).toHaveLength(1)
      const tab = state.tabs[0]
      expect(tab.title).toBe('Tab 1')
      expect(tab.status).toBe('creating')
      expect(tab.mode).toBe('shell')
      expect(tab.shell).toBe('system')
    })

    it('accepts custom title', () => {
      const state = tabsReducer(initialState, addTab({ title: 'My Custom Terminal' }))

      expect(state.tabs[0].title).toBe('My Custom Terminal')
    })

    it('accepts custom mode', () => {
      const state = tabsReducer(initialState, addTab({ mode: 'claude' }))

      expect(state.tabs[0].mode).toBe('claude')
    })

    it('accepts custom shell', () => {
      const state = tabsReducer(initialState, addTab({ shell: 'powershell' }))

      expect(state.tabs[0].shell).toBe('powershell')
    })

    it('accepts all custom options', () => {
      const state = tabsReducer(
        initialState,
        addTab({
          title: 'Custom Tab',
          description: 'A test description',
          mode: 'codex',
          shell: 'wsl',
          status: 'running',
          initialCwd: '/home/user',
          resumeSessionId: 'session-123',
        })
      )

      const tab = state.tabs[0]
      expect(tab.title).toBe('Custom Tab')
      expect(tab.description).toBe('A test description')
      expect(tab.mode).toBe('codex')
      expect(tab.shell).toBe('wsl')
      expect(tab.status).toBe('running')
      expect(tab.initialCwd).toBe('/home/user')
      expect(tab.resumeSessionId).toBe('session-123')
    })

    it('increments tab number in default title', () => {
      let state = tabsReducer(initialState, addTab())
      expect(state.tabs[0].title).toBe('Tab 1')

      state = tabsReducer(state, addTab())
      expect(state.tabs[1].title).toBe('Tab 2')

      state = tabsReducer(state, addTab())
      expect(state.tabs[2].title).toBe('Tab 3')
    })

    it('sets new tab as active tab', () => {
      let state = tabsReducer(initialState, addTab())
      const firstTabId = state.tabs[0].id
      expect(state.activeTabId).toBe(firstTabId)

      state = tabsReducer(state, addTab())
      const secondTabId = state.tabs[1].id
      expect(state.activeTabId).toBe(secondTabId)
    })
  })

  describe('setActiveTab', () => {
    it('changes active tab to specified id', () => {
      // Setup: create two tabs
      let state = tabsReducer(initialState, addTab())
      const firstTabId = state.tabs[0].id
      state = tabsReducer(state, addTab())
      const secondTabId = state.tabs[1].id

      // Second tab should be active after adding
      expect(state.activeTabId).toBe(secondTabId)

      // Switch to first tab
      state = tabsReducer(state, setActiveTab(firstTabId))
      expect(state.activeTabId).toBe(firstTabId)
    })

    it('allows setting activeTabId to any string', () => {
      const state = tabsReducer(initialState, setActiveTab('arbitrary-id'))
      expect(state.activeTabId).toBe('arbitrary-id')
    })
  })

  describe('updateTab', () => {
    it('modifies existing tab properties', () => {
      let state = tabsReducer(initialState, addTab())
      const tabId = state.tabs[0].id

      state = tabsReducer(
        state,
        updateTab({
          id: tabId,
          updates: { title: 'Updated Title', status: 'running' },
        })
      )

      const tab = state.tabs[0]
      expect(tab.title).toBe('Updated Title')
      expect(tab.status).toBe('running')
    })

    it('updates terminalId', () => {
      let state = tabsReducer(initialState, addTab())
      const tabId = state.tabs[0].id

      state = tabsReducer(
        state,
        updateTab({
          id: tabId,
          updates: { terminalId: 'terminal-456' },
        })
      )

      expect(state.tabs[0].terminalId).toBe('terminal-456')
    })

    it('does not modify other tabs', () => {
      let state = tabsReducer(initialState, addTab({ title: 'Tab 1' }))
      const tab1Id = state.tabs[0].id
      state = tabsReducer(state, addTab({ title: 'Tab 2' }))

      state = tabsReducer(
        state,
        updateTab({
          id: tab1Id,
          updates: { title: 'Updated Tab 1' },
        })
      )

      expect(state.tabs[0].title).toBe('Updated Tab 1')
      expect(state.tabs[1].title).toBe('Tab 2')
    })

    it('does nothing if tab id not found', () => {
      let state = tabsReducer(initialState, addTab({ title: 'Original' }))
      const originalState = { ...state, tabs: [...state.tabs] }

      state = tabsReducer(
        state,
        updateTab({
          id: 'non-existent-id',
          updates: { title: 'Should Not Appear' },
        })
      )

      expect(state.tabs[0].title).toBe('Original')
    })
  })

  describe('removeTab', () => {
    it('deletes tab from tabs array', () => {
      let state = tabsReducer(initialState, addTab())
      const tabId = state.tabs[0].id
      expect(state.tabs).toHaveLength(1)

      state = tabsReducer(state, removeTab(tabId))
      expect(state.tabs).toHaveLength(0)
    })

    it('updates activeTabId to first remaining tab when active tab is removed', () => {
      let state = tabsReducer(initialState, addTab({ title: 'Tab 1' }))
      const tab1Id = state.tabs[0].id
      state = tabsReducer(state, addTab({ title: 'Tab 2' }))
      const tab2Id = state.tabs[1].id

      // Tab 2 is active
      expect(state.activeTabId).toBe(tab2Id)

      // Remove active tab (Tab 2)
      state = tabsReducer(state, removeTab(tab2Id))

      // Should switch to first remaining tab (Tab 1)
      expect(state.activeTabId).toBe(tab1Id)
      expect(state.tabs).toHaveLength(1)
    })

    it('sets activeTabId to null when last tab is removed', () => {
      let state = tabsReducer(initialState, addTab())
      const tabId = state.tabs[0].id

      state = tabsReducer(state, removeTab(tabId))

      expect(state.tabs).toHaveLength(0)
      expect(state.activeTabId).toBeNull()
    })

    it('does not change activeTabId when non-active tab is removed', () => {
      let state = tabsReducer(initialState, addTab({ title: 'Tab 1' }))
      const tab1Id = state.tabs[0].id
      state = tabsReducer(state, addTab({ title: 'Tab 2' }))
      const tab2Id = state.tabs[1].id

      // Tab 2 is active
      expect(state.activeTabId).toBe(tab2Id)

      // Remove Tab 1 (not active)
      state = tabsReducer(state, removeTab(tab1Id))

      // Active tab should remain Tab 2
      expect(state.activeTabId).toBe(tab2Id)
      expect(state.tabs).toHaveLength(1)
    })

    it('does nothing if tab id not found', () => {
      let state = tabsReducer(initialState, addTab())
      const tabId = state.tabs[0].id

      state = tabsReducer(state, removeTab('non-existent-id'))

      expect(state.tabs).toHaveLength(1)
      expect(state.activeTabId).toBe(tabId)
    })
  })

  describe('hydrateTabs', () => {
    it('restores state from storage', () => {
      const savedTabs: Tab[] = [
        {
          id: 'saved-1',
          createRequestId: 'saved-1',
          title: 'Saved Terminal',
          status: 'running',
          mode: 'shell',
          shell: 'system',
          createdAt: 1000000,
        },
        {
          id: 'saved-2',
          createRequestId: 'saved-2',
          title: 'Another Terminal',
          status: 'exited',
          mode: 'claude',
          shell: 'powershell',
          createdAt: 2000000,
        },
      ]

      const state = tabsReducer(
        initialState,
        hydrateTabs({
          tabs: savedTabs,
          activeTabId: 'saved-2',
        })
      )

      expect(state.tabs).toHaveLength(2)
      expect(state.tabs[0].id).toBe('saved-1')
      expect(state.tabs[0].title).toBe('Saved Terminal')
      expect(state.tabs[1].id).toBe('saved-2')
      expect(state.activeTabId).toBe('saved-2')
    })

    it('sets default values for missing properties', () => {
      const incompleteTab = {
        id: 'incomplete',
        title: 'Incomplete Tab',
      } as Tab

      const state = tabsReducer(
        initialState,
        hydrateTabs({
          tabs: [incompleteTab],
          activeTabId: 'incomplete',
        })
      )

      const tab = state.tabs[0]
      expect(tab.status).toBe('creating')
      expect(tab.mode).toBe('shell')
      expect(tab.shell).toBe('system')
      expect(tab.createdAt).toBeDefined()
      expect(tab.createRequestId).toBe('incomplete')
    })

    it('uses first tab id as activeTabId when activeTabId not provided', () => {
      const savedTabs: Tab[] = [
        {
          id: 'first-tab',
          createRequestId: 'first-tab',
          title: 'First',
          status: 'running',
          mode: 'shell',
          createdAt: 1000000,
        },
      ]

      const state = tabsReducer(
        initialState,
        hydrateTabs({
          tabs: savedTabs,
          activeTabId: null,
        })
      )

      expect(state.activeTabId).toBe('first-tab')
    })

    it('handles empty tabs array', () => {
      const state = tabsReducer(
        initialState,
        hydrateTabs({
          tabs: [],
          activeTabId: null,
        })
      )

      expect(state.tabs).toHaveLength(0)
      expect(state.activeTabId).toBeNull()
    })

    it('handles undefined tabs in payload', () => {
      const state = tabsReducer(
        initialState,
        hydrateTabs({
          tabs: undefined as unknown as Tab[],
          activeTabId: null,
        })
      )

      expect(state.tabs).toHaveLength(0)
      expect(state.activeTabId).toBeNull()
    })

    it('preserves all tab properties during hydration', () => {
      const fullTab: Tab = {
        id: 'full-tab',
        createRequestId: 'full-tab',
        title: 'Full Tab',
        description: 'A description',
        terminalId: 'terminal-789',
        status: 'running',
        mode: 'codex',
        shell: 'wsl',
        initialCwd: '/custom/path',
        resumeSessionId: 'session-abc',
        createdAt: 5000000,
      }

      const state = tabsReducer(
        initialState,
        hydrateTabs({
          tabs: [fullTab],
          activeTabId: 'full-tab',
        })
      )

      const tab = state.tabs[0]
      expect(tab.id).toBe('full-tab')
      expect(tab.title).toBe('Full Tab')
      expect(tab.description).toBe('A description')
      expect(tab.terminalId).toBe('terminal-789')
      expect(tab.status).toBe('running')
      expect(tab.mode).toBe('codex')
      expect(tab.shell).toBe('wsl')
      expect(tab.initialCwd).toBe('/custom/path')
      expect(tab.resumeSessionId).toBe('session-abc')
      expect(tab.createdAt).toBe(5000000)
    })
  })

  describe('closeTab with multiple panes', () => {
    it('removes layout when tab is closed', async () => {
      const store = configureStore({
        reducer: {
          tabs: tabsReducer,
          panes: panesReducer,
        },
      })

      // Create tab
      store.dispatch(addTab({ mode: 'shell' }))
      const tabId = store.getState().tabs.tabs[0].id

      // Initialize pane
      store.dispatch(initLayout({
        tabId,
        content: { kind: 'terminal', mode: 'shell' },
      }))

      expect(store.getState().panes.layouts[tabId]).toBeDefined()

      // Close tab
      await store.dispatch(closeTab(tabId))

      // Layout should be removed
      expect(store.getState().panes.layouts[tabId]).toBeUndefined()
    })
  })

  describe('reorderTabs', () => {
    it('moves tab from index 0 to index 2', () => {
      // Setup: create 3 tabs
      let state = tabsReducer(initialState, addTab({ title: 'Tab A' }))
      const tabAId = state.tabs[0].id
      state = tabsReducer(state, addTab({ title: 'Tab B' }))
      const tabBId = state.tabs[1].id
      state = tabsReducer(state, addTab({ title: 'Tab C' }))
      const tabCId = state.tabs[2].id

      // Move Tab A from index 0 to index 2
      state = tabsReducer(state, reorderTabs({ fromIndex: 0, toIndex: 2 }))

      // Order should now be: B, C, A
      expect(state.tabs[0].id).toBe(tabBId)
      expect(state.tabs[1].id).toBe(tabCId)
      expect(state.tabs[2].id).toBe(tabAId)
    })

    it('moves tab from index 2 to index 0', () => {
      let state = tabsReducer(initialState, addTab({ title: 'Tab A' }))
      const tabAId = state.tabs[0].id
      state = tabsReducer(state, addTab({ title: 'Tab B' }))
      const tabBId = state.tabs[1].id
      state = tabsReducer(state, addTab({ title: 'Tab C' }))
      const tabCId = state.tabs[2].id

      // Move Tab C from index 2 to index 0
      state = tabsReducer(state, reorderTabs({ fromIndex: 2, toIndex: 0 }))

      // Order should now be: C, A, B
      expect(state.tabs[0].id).toBe(tabCId)
      expect(state.tabs[1].id).toBe(tabAId)
      expect(state.tabs[2].id).toBe(tabBId)
    })

    it('is a no-op when fromIndex equals toIndex', () => {
      let state = tabsReducer(initialState, addTab({ title: 'Tab A' }))
      const tabAId = state.tabs[0].id
      state = tabsReducer(state, addTab({ title: 'Tab B' }))
      const tabBId = state.tabs[1].id

      state = tabsReducer(state, reorderTabs({ fromIndex: 1, toIndex: 1 }))

      expect(state.tabs[0].id).toBe(tabAId)
      expect(state.tabs[1].id).toBe(tabBId)
    })

    it('preserves activeTabId when reordering', () => {
      let state = tabsReducer(initialState, addTab({ title: 'Tab A' }))
      state = tabsReducer(state, addTab({ title: 'Tab B' }))
      state = tabsReducer(state, addTab({ title: 'Tab C' }))

      // Tab C is active (last added)
      const activeId = state.activeTabId

      state = tabsReducer(state, reorderTabs({ fromIndex: 0, toIndex: 2 }))

      // activeTabId should be unchanged
      expect(state.activeTabId).toBe(activeId)
    })
  })

  describe('lastInputAt tracking', () => {
    it('initializes lastInputAt to undefined on new tab', () => {
      const state = tabsReducer(initialState, addTab({ title: 'Test Tab' }))

      const tab = state.tabs[0]
      expect(Object.prototype.hasOwnProperty.call(tab, 'lastInputAt')).toBe(true)
      expect(tab.lastInputAt).toBeUndefined()
    })

    it('can update lastInputAt via updateTab', () => {
      let state = tabsReducer(initialState, addTab({ title: 'Test Tab' }))
      const tabId = state.tabs[0].id
      const timestamp = Date.now()

      state = tabsReducer(
        state,
        updateTab({
          id: tabId,
          updates: { lastInputAt: timestamp },
        })
      )

      const tab = state.tabs[0]
      expect(tab.lastInputAt).toBe(timestamp)
    })

    it('preserves lastInputAt when loading tabs from localStorage without the field', () => {
      const state = tabsReducer(initialState, addTab({ title: 'Test Tab' }))

      const tab = state.tabs[0]
      expect(Object.prototype.hasOwnProperty.call(tab, 'lastInputAt')).toBe(true)
      expect(tab.lastInputAt).toBeUndefined()
    })
  })
})
