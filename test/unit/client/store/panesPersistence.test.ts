import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
import {
  loadPersistedPanes,
  loadPersistedTabs,
  persistMiddleware,
  resetPersistFlushListenersForTests,
  resetPersistedPanesCacheForTests,
} from '../../../../src/store/persistMiddleware'
import { PANES_SCHEMA_VERSION } from '../../../../src/store/persistedState'

describe('Panes Persistence Integration', () => {
  beforeEach(() => {
    localStorageMock.clear()
    vi.clearAllMocks()
    vi.useFakeTimers()
    resetPersistFlushListenersForTests()
    resetPersistedPanesCacheForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
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
    vi.runAllTimers()
    const savedPanes = localStorage.getItem('freshell.panes.v2')
    expect(savedPanes).not.toBeNull()
    const parsedPanes = JSON.parse(savedPanes!)
    expect(parsedPanes.layouts[tabId].type).toBe('split')

    // 7. Simulate page refresh - create new store and hydrate
    // (Using explicit hydration to test that path still works)
    vi.runAllTimers()
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
    vi.runAllTimers()
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
    vi.runAllTimers()
    const savedPanes = localStorage.getItem('freshell.panes.v2')
    expect(savedPanes).not.toBeNull()
    expect(JSON.parse(savedPanes!).layouts[tabId].type).toBe('split')

    // 2. Verify loadPersistedPanes returns correct data
    const loaded = loadPersistedPanes()
    expect(loaded).not.toBeNull()
    expect(loaded!.layouts[tabId]).toBeDefined()
    expect(loaded!.layouts[tabId].type).toBe('split')
  })

  it('strips editor content when persisting panes', () => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
      },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    store.dispatch(addTab({ mode: 'shell' }))
    const tabId = store.getState().tabs.tabs[0].id

    store.dispatch(initLayout({
      tabId,
      content: {
        kind: 'editor',
        filePath: null,
        language: 'markdown',
        readOnly: false,
        content: 'Large editor buffer that should not be persisted',
        viewMode: 'source',
      },
    }))

    vi.runAllTimers()

    const savedPanes = localStorage.getItem('freshell.panes.v2')
    expect(savedPanes).not.toBeNull()
    const parsedPanes = JSON.parse(savedPanes!)
    const layout = parsedPanes.layouts[tabId]
    expect(layout.content.kind).toBe('editor')
    expect(layout.content.content).toBe('')
  })

  it('flushes pending writes on visibility change', () => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
      },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    store.dispatch(addTab({ mode: 'shell' }))
    const tabId = store.getState().tabs.tabs[0].id
    store.dispatch(initLayout({ tabId, content: { kind: 'terminal', mode: 'shell' } }))

    expect(localStorage.getItem('freshell.panes.v2')).toBeNull()

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))

    expect(localStorage.getItem('freshell.panes.v2')).not.toBeNull()
  })
})

describe('PaneContent migration', () => {
  beforeEach(() => {
    localStorageMock.clear()
    resetPersistedPanesCacheForTests()
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

    localStorage.setItem('freshell.panes.v2', JSON.stringify(oldPanesState))

    const loaded = loadPersistedPanes()

    const layout = loaded.layouts['tab1'] as { type: 'leaf'; content: any }
    expect(layout.content.createRequestId).toBeDefined()
    expect(layout.content.status).toBe('creating')
    expect(layout.content.shell).toBe('system')
    expect(loaded.version).toBe(PANES_SCHEMA_VERSION) // Migrated version
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

    localStorage.setItem('freshell.panes.v2', JSON.stringify(oldPanesState))

    const loaded = loadPersistedPanes()

    const layout = loaded.layouts['tab1'] as any
    expect(layout.children[0].content.createRequestId).toBeDefined()
    expect(layout.children[1].content.createRequestId).toBeDefined()
    expect(layout.children[0].content.createRequestId).not.toBe(layout.children[1].content.createRequestId)
  })

  it('returns identical nanoid values for legacy data across multiple loadPersistedPanes calls', () => {
    const oldPanesState = {
      layouts: {
        'tab1': {
          type: 'leaf',
          id: 'pane1',
          content: { kind: 'terminal', mode: 'shell' },
        },
      },
      activePane: { 'tab1': 'pane1' },
    }

    localStorage.setItem('freshell.panes.v2', JSON.stringify(oldPanesState))

    const first = loadPersistedPanes()
    const second = loadPersistedPanes()

    // Both calls must return the same object (memoized)
    expect(first).toBe(second)
    // And the migrated createRequestId must be consistent
    expect(first.layouts['tab1'].content.createRequestId).toBeDefined()
    expect(first.layouts['tab1'].content.createRequestId)
      .toBe(second.layouts['tab1'].content.createRequestId)
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

    localStorage.setItem('freshell.panes.v2', JSON.stringify(migratedState))

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

    localStorage.setItem('freshell.panes.v2', JSON.stringify(oldPanesState))

    const loaded = loadPersistedPanes()

    const layout = loaded.layouts['tab1'] as { type: 'leaf'; content: any }
    expect(layout.content.kind).toBe('browser')
    expect(layout.content.url).toBe('https://example.com')
    expect(layout.content.devToolsOpen).toBe(true)
  })

  it('handles malformed pane content without crashing', () => {
    const corruptedState = {
      layouts: {
        'tab-null': {
          type: 'leaf',
          id: 'pane-null',
          content: null,
        },
        'tab-bad-split': {
          type: 'split',
          id: 'split1',
          direction: 'horizontal',
          sizes: [50, 50],
          children: [],
        },
      },
      activePane: { 'tab-null': 'pane-null' },
    }

    localStorage.setItem('freshell.panes.v2', JSON.stringify(corruptedState))

    const loaded = loadPersistedPanes()

    expect(loaded).not.toBeNull()
    expect(loaded.layouts['tab-null']).toBeDefined()
    expect(loaded.layouts['tab-bad-split']).toBeDefined()
  })
})

describe('version 3 migration', () => {
  beforeEach(() => {
    localStorageMock.clear()
    resetPersistedPanesCacheForTests()
  })

  it('adds empty paneTitles when migrating from version 2', () => {
    const v2State = {
      version: 2,
      layouts: { 'tab-1': { type: 'leaf', id: 'pane-1', content: { kind: 'terminal', createRequestId: 'req-1', status: 'running', mode: 'shell' } } },
      activePane: { 'tab-1': 'pane-1' },
      // No paneTitles field
    }
    localStorage.setItem('freshell.panes.v2', JSON.stringify(v2State))

    const result = loadPersistedPanes()

    expect(result.version).toBe(PANES_SCHEMA_VERSION)
    expect(result.paneTitles).toEqual({})
  })

  it('preserves existing paneTitles when loading version 3', () => {
    const v3State = {
      version: 3,
      layouts: {},
      activePane: {},
      paneTitles: { 'tab-1': { 'pane-1': 'My Title' } },
    }
    localStorage.setItem('freshell.panes.v2', JSON.stringify(v3State))

    const result = loadPersistedPanes()

    expect(result.paneTitles).toEqual({ 'tab-1': { 'pane-1': 'My Title' } })
  })
})

describe('loadInitialPanesState consistency', () => {
  beforeEach(() => {
    localStorageMock.clear()
    resetPersistedPanesCacheForTests()
  })

  it('initial pane state matches loadPersistedPanes output for migrated data', async () => {
    // Simulate v1 data (no lifecycle fields) that needs migration
    localStorageMock.clear()
    localStorage.setItem('freshell.panes.v2', JSON.stringify({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: { kind: 'terminal', mode: 'shell' },
        },
      },
      activePane: { 'tab-1': 'pane-1' },
    }))

    // loadPersistedPanes runs migrations (generates createRequestId)
    const migrated = loadPersistedPanes()
    expect(migrated).not.toBeNull()
    const migratedContent = (migrated!.layouts['tab-1'] as any).content
    expect(migratedContent.createRequestId).toBeDefined()

    // Re-import panesSlice to trigger fresh loadInitialPanesState
    vi.resetModules()
    const { default: freshPanesReducer } = await import('../../../../src/store/panesSlice')
    const store = configureStore({ reducer: { panes: freshPanesReducer } })

    const initialContent = (store.getState().panes.layouts['tab-1'] as any)?.content

    // The key assertion: initial state should have lifecycle fields
    // (even if createRequestId values differ, both must be defined)
    expect(initialContent?.createRequestId).toBeDefined()
    expect(initialContent?.status).toBeDefined()
  })
})

describe('orphaned layout cleanup', () => {
  beforeEach(() => {
    localStorageMock.clear()
    resetPersistedPanesCacheForTests()
  })

  it('removes pane layouts for tabs that no longer exist', async () => {
    // Set up: panes for tab-1 and tab-orphan, but only tab-1 exists in tabs
    localStorageMock.clear()
    localStorage.setItem('freshell.tabs.v2', JSON.stringify({
      tabs: {
        tabs: [{ id: 'tab-1', title: 'Tab 1', createdAt: 1, status: 'running', mode: 'shell', createRequestId: 'tab-1' }],
        activeTabId: 'tab-1',
      },
    }))
    localStorage.setItem('freshell.panes.v2', JSON.stringify({
      version: 4,
      layouts: {
        'tab-1': { type: 'leaf', id: 'pane-1', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-1', status: 'running' } },
        'tab-orphan': { type: 'leaf', id: 'pane-orphan', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-orphan', status: 'running' } },
      },
      activePane: { 'tab-1': 'pane-1', 'tab-orphan': 'pane-orphan' },
      paneTitles: { 'tab-1': { 'pane-1': 'Tab 1' }, 'tab-orphan': { 'pane-orphan': 'Orphan' } },
    }))

    vi.resetModules()
    const panesReducer = (await import('../../../../src/store/panesSlice')).default
    const tabsReducer = (await import('../../../../src/store/tabsSlice')).default

    const store = configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } })

    // tab-1's layout should exist
    expect(store.getState().panes.layouts['tab-1']).toBeDefined()
    // tab-orphan's layout should be cleaned up
    expect(store.getState().panes.layouts['tab-orphan']).toBeUndefined()
    // activePane should also be cleaned
    expect(store.getState().panes.activePane['tab-orphan']).toBeUndefined()
    // paneTitles should also be cleaned
    expect(store.getState().panes.paneTitles['tab-orphan']).toBeUndefined()
  })
})

describe('version 5 migration (drop claude-chat panes)', () => {
  beforeEach(() => {
    localStorageMock.clear()
    resetPersistedPanesCacheForTests()
  })

  it('drops claude-chat leaf panes during v4→v5 migration', () => {
    const v4Data = {
      version: 4,
      layouts: {
        tab1: {
          type: 'leaf',
          id: 'pane1',
          content: {
            kind: 'claude-chat',
            createRequestId: 'req1',
            status: 'idle',
            sessionId: 'sess1',
          },
        },
      },
      activePane: { tab1: 'pane1' },
      paneTitles: {},
      paneTitleSetByUser: {},
    }
    localStorage.setItem('freshell.panes.v2', JSON.stringify(v4Data))

    const result = loadPersistedPanes()
    // The claude-chat leaf should be replaced with a picker pane
    expect(result!.layouts.tab1.content.kind).toBe('picker')
    expect(result!.version).toBe(PANES_SCHEMA_VERSION)
  })

  it('drops claude-chat panes inside splits', () => {
    const v4Data = {
      version: 4,
      layouts: {
        tab1: {
          type: 'split',
          id: 'split1',
          direction: 'horizontal',
          sizes: [50, 50],
          children: [
            { type: 'leaf', id: 'pane1', content: { kind: 'terminal', createRequestId: 'req1', status: 'running', mode: 'shell' } },
            { type: 'leaf', id: 'pane2', content: { kind: 'claude-chat', createRequestId: 'req2', status: 'idle' } },
          ],
        },
      },
      activePane: { tab1: 'pane1' },
      paneTitles: {},
      paneTitleSetByUser: {},
    }
    localStorage.setItem('freshell.panes.v2', JSON.stringify(v4Data))

    const result = loadPersistedPanes()
    const layout = result!.layouts.tab1 as any
    expect(layout.children[0].content.kind).toBe('terminal')
    expect(layout.children[1].content.kind).toBe('picker')
  })

  it('preserves non-claude-chat panes during migration', () => {
    const v4Data = {
      version: 4,
      layouts: {
        tab1: {
          type: 'leaf',
          id: 'pane1',
          content: { kind: 'terminal', createRequestId: 'req1', status: 'running', mode: 'shell' },
        },
      },
      activePane: { tab1: 'pane1' },
      paneTitles: {},
      paneTitleSetByUser: {},
    }
    localStorage.setItem('freshell.panes.v2', JSON.stringify(v4Data))

    const result = loadPersistedPanes()
    expect(result!.layouts.tab1.content.kind).toBe('terminal')
  })
})

describe('schema version consistency', () => {
  beforeEach(() => {
    localStorageMock.clear()
    vi.useFakeTimers()
    resetPersistFlushListenersForTests()
    resetPersistedPanesCacheForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('persists panes with the same version that persistedState accepts', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    store.dispatch(addTab({ mode: 'shell' }))
    const tabId = store.getState().tabs.tabs[0].id
    store.dispatch(initLayout({ tabId, content: { kind: 'terminal', mode: 'shell' } }))
    vi.runAllTimers()

    const raw = localStorage.getItem('freshell.panes.v2')!
    const parsed = JSON.parse(raw)
    // The version written by persist middleware must match persistedState's version
    expect(parsed.version).toBe(PANES_SCHEMA_VERSION)
  })
})
