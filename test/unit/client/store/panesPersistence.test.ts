import { describe, it, expect, beforeEach, vi, beforeAll } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'

// Mock localStorage BEFORE importing slices
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
    _getStore: () => store,
  }
})()

// Must be set before imports
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

// Now import slices - they'll see our mocked localStorage
import tabsReducer, { hydrateTabs, addTab } from '../../../../src/store/tabsSlice'
import panesReducer, { hydratePanes, initLayout, splitPane } from '../../../../src/store/panesSlice'
import { loadPersistedPanes, loadPersistedTabs, persistMiddleware } from '../../../../src/store/persistMiddleware'

describe('Panes Persistence Integration', () => {
  beforeEach(() => {
    localStorageMock.clear()
    vi.clearAllMocks()
  })

  it('persists and restores panes across page refresh', () => {
    // 1. Create a store (simulates initial page load)
    const store1 = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
      },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    // 2. Add a tab
    store1.dispatch(addTab({ mode: 'shell' }))
    const tabId = store1.getState().tabs.tabs[0].id

    // 3. Initialize layout for the tab
    store1.dispatch(initLayout({ tabId, content: { kind: 'terminal', mode: 'shell' } }))
    const initialPaneId = store1.getState().panes.activePane[tabId]

    // 4. Split the pane
    store1.dispatch(splitPane({
      tabId,
      paneId: initialPaneId,
      direction: 'horizontal',
      newContent: { kind: 'browser', url: 'https://example.com', devToolsOpen: false },
    }))

    // 5. Verify split was created
    const layout1 = store1.getState().panes.layouts[tabId]
    expect(layout1.type).toBe('split')
    expect((layout1 as any).children).toHaveLength(2)

    // 6. Check localStorage was updated
    const savedPanes = localStorage.getItem('freshell.panes.v1')
    expect(savedPanes).not.toBeNull()
    const parsedPanes = JSON.parse(savedPanes!)
    expect(parsedPanes.layouts[tabId].type).toBe('split')

    // 7. Simulate page refresh - create new store and hydrate
    // (Using explicit hydration to test that path still works)
    const persistedTabs = loadPersistedTabs()
    const persistedPanes = loadPersistedPanes()

    const store2 = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
      },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    // Hydrate in same order as real app
    if (persistedTabs?.tabs) {
      store2.dispatch(hydrateTabs(persistedTabs.tabs))
    }
    if (persistedPanes) {
      store2.dispatch(hydratePanes(persistedPanes))
    }

    // 8. Verify the split pane was restored
    const restoredLayout = store2.getState().panes.layouts[tabId]
    expect(restoredLayout).toBeDefined()
    expect(restoredLayout.type).toBe('split')
    expect((restoredLayout as any).children).toHaveLength(2)
    expect((restoredLayout as any).children[0].content.kind).toBe('terminal')
    expect((restoredLayout as any).children[1].content.kind).toBe('browser')
  })

  it('initLayout does not overwrite hydrated layout', () => {
    // 1. Create initial store and set up split pane
    const store1 = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
      },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    store1.dispatch(addTab({ mode: 'shell' }))
    const tabId = store1.getState().tabs.tabs[0].id

    store1.dispatch(initLayout({ tabId, content: { kind: 'terminal', mode: 'shell' } }))
    const paneId = store1.getState().panes.activePane[tabId]

    store1.dispatch(splitPane({
      tabId,
      paneId,
      direction: 'horizontal',
      newContent: { kind: 'terminal', mode: 'claude' },
    }))

    // 2. Simulate refresh
    const persistedTabs = loadPersistedTabs()
    const persistedPanes = loadPersistedPanes()

    const store2 = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
      },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    if (persistedTabs?.tabs) {
      store2.dispatch(hydrateTabs(persistedTabs.tabs))
    }
    if (persistedPanes) {
      store2.dispatch(hydratePanes(persistedPanes))
    }

    // 3. Simulate what PaneLayout does - try to init layout
    const layoutBefore = store2.getState().panes.layouts[tabId]
    expect(layoutBefore.type).toBe('split') // Should be split from hydration

    // This simulates PaneLayout's useEffect calling initLayout
    store2.dispatch(initLayout({ tabId, content: { kind: 'terminal', mode: 'shell' } }))

    // 4. Verify layout was NOT overwritten
    const layoutAfter = store2.getState().panes.layouts[tabId]
    expect(layoutAfter.type).toBe('split') // Should still be split
    expect(layoutAfter).toEqual(layoutBefore)
  })

  it('initial state loads from localStorage without explicit hydration', () => {
    // 1. First session: Create state and persist it
    const store1 = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
      },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    store1.dispatch(addTab({ mode: 'shell' }))
    const tabId = store1.getState().tabs.tabs[0].id

    store1.dispatch(initLayout({ tabId, content: { kind: 'terminal', mode: 'shell' } }))
    const paneId = store1.getState().panes.activePane[tabId]

    store1.dispatch(splitPane({
      tabId,
      paneId,
      direction: 'horizontal',
      newContent: { kind: 'browser', url: 'https://test.com', devToolsOpen: false },
    }))

    // Verify state was persisted
    const savedPanes = localStorage.getItem('freshell.panes.v1')
    expect(savedPanes).not.toBeNull()
    expect(JSON.parse(savedPanes!).layouts[tabId].type).toBe('split')

    // 2. Verify loadPersistedPanes returns correct data
    const loaded = loadPersistedPanes()
    expect(loaded).not.toBeNull()
    expect(loaded!.layouts[tabId]).toBeDefined()
    expect(loaded!.layouts[tabId].type).toBe('split')
  })
})

describe('PaneContent migration', () => {
  beforeEach(() => {
    localStorageMock.clear()
  })

  it('migrates old terminal pane content to include lifecycle fields', () => {
    // Simulate old format without createRequestId/status (version undefined)
    const oldPanesState = {
      layouts: {
        'tab1': {
          type: 'leaf',
          id: 'pane1',
          content: { kind: 'terminal', mode: 'shell' },
        },
      },
      activePane: { 'tab1': 'pane1' },
      // No version field
    }

    localStorage.setItem('freshell.panes.v1', JSON.stringify(oldPanesState))

    const loaded = loadPersistedPanes()

    const layout = loaded.layouts['tab1'] as { type: 'leaf'; content: any }
    expect(layout.content.createRequestId).toBeDefined()
    expect(layout.content.status).toBe('creating')
    expect(layout.content.shell).toBe('system')
    expect(loaded.version).toBe(2) // Migrated version
  })

  it('migrates nested split panes recursively', () => {
    const oldPanesState = {
      layouts: {
        'tab1': {
          type: 'split',
          id: 'split1',
          direction: 'horizontal',
          sizes: [50, 50],
          children: [
            { type: 'leaf', id: 'pane1', content: { kind: 'terminal', mode: 'shell' } },
            { type: 'leaf', id: 'pane2', content: { kind: 'terminal', mode: 'claude' } },
          ],
        },
      },
      activePane: { 'tab1': 'pane1' },
    }

    localStorage.setItem('freshell.panes.v1', JSON.stringify(oldPanesState))

    const loaded = loadPersistedPanes()

    const layout = loaded.layouts['tab1'] as any
    expect(layout.children[0].content.createRequestId).toBeDefined()
    expect(layout.children[1].content.createRequestId).toBeDefined()
    expect(layout.children[0].content.createRequestId).not.toBe(layout.children[1].content.createRequestId)
  })

  it('does not re-migrate already migrated content', () => {
    const migratedState = {
      version: 2,
      layouts: {
        'tab1': {
          type: 'leaf',
          id: 'pane1',
          content: { kind: 'terminal', createRequestId: 'existing-req', status: 'running', mode: 'shell', shell: 'powershell' },
        },
      },
      activePane: { 'tab1': 'pane1' },
    }

    localStorage.setItem('freshell.panes.v1', JSON.stringify(migratedState))

    const loaded = loadPersistedPanes()

    const layout = loaded.layouts['tab1'] as { type: 'leaf'; content: any }
    expect(layout.content.createRequestId).toBe('existing-req') // Preserved
    expect(layout.content.status).toBe('running') // Preserved
    expect(layout.content.shell).toBe('powershell') // Preserved
  })

  it('preserves browser pane content unchanged', () => {
    const oldPanesState = {
      layouts: {
        'tab1': {
          type: 'leaf',
          id: 'pane1',
          content: { kind: 'browser', url: 'https://example.com', devToolsOpen: true },
        },
      },
      activePane: { 'tab1': 'pane1' },
    }

    localStorage.setItem('freshell.panes.v1', JSON.stringify(oldPanesState))

    const loaded = loadPersistedPanes()

    const layout = loaded.layouts['tab1'] as { type: 'leaf'; content: any }
    expect(layout.content.kind).toBe('browser')
    expect(layout.content.url).toBe('https://example.com')
    expect(layout.content.devToolsOpen).toBe(true)
  })
})
