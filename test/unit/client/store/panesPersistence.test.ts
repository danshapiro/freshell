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
} from '../../../../src/store/persistMiddleware'

describe('Panes Persistence Integration', () => {
  beforeEach(() => {
    localStorageMock.clear()
    vi.clearAllMocks()
    vi.useFakeTimers()
    resetPersistFlushListenersForTests()
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
    const savedPanes = localStorage.getItem('freshell.panes.v1')
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
    const savedPanes = localStorage.getItem('freshell.panes.v1')
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

    const savedPanes = localStorage.getItem('freshell.panes.v1')
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

    expect(localStorage.getItem('freshell.panes.v1')).toBeNull()

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))

    expect(localStorage.getItem('freshell.panes.v1')).not.toBeNull()
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
    expect(loaded.version).toBe(3) // Migrated version
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

    localStorage.setItem('freshell.panes.v1', JSON.stringify(corruptedState))

    const loaded = loadPersistedPanes()

    expect(loaded).not.toBeNull()
    expect(loaded.layouts['tab-null']).toBeDefined()
    expect(loaded.layouts['tab-bad-split']).toBeDefined()
  })
})

describe('version 3 migration', () => {
  beforeEach(() => {
    localStorageMock.clear()
  })

  it('adds empty paneTitles when migrating from version 2', () => {
    const v2State = {
      version: 2,
      layouts: { 'tab-1': { type: 'leaf', id: 'pane-1', content: { kind: 'terminal', createRequestId: 'req-1', status: 'running', mode: 'shell' } } },
      activePane: { 'tab-1': 'pane-1' },
      // No paneTitles field
    }
    localStorage.setItem('freshell.panes.v1', JSON.stringify(v2State))

    const result = loadPersistedPanes()

    expect(result.version).toBe(3)
    expect(result.paneTitles).toEqual({})
  })

  it('preserves existing paneTitles when loading version 3', () => {
    const v3State = {
      version: 3,
      layouts: {},
      activePane: {},
      paneTitles: { 'tab-1': { 'pane-1': 'My Title' } },
    }
    localStorage.setItem('freshell.panes.v1', JSON.stringify(v3State))

    const result = loadPersistedPanes()

    expect(result.paneTitles).toEqual({ 'tab-1': { 'pane-1': 'My Title' } })
  })
})

describe('legacy tab resumeSessionId migration', () => {
  const validSessionId = '550e8400-e29b-41d4-a716-446655440000'

  it('migrates tab resumeSessionId into the active claude pane when panes load without it', async () => {
    localStorage.setItem('freshell.tabs.v1', JSON.stringify({
      tabs: {
        tabs: [
          { id: 'tab-1', mode: 'claude', resumeSessionId: validSessionId, status: 'running', title: 'Claude', createRequestId: 'tab-1' },
        ],
        activeTabId: 'tab-1',
      },
    }))

    localStorage.setItem('freshell.panes.v1', JSON.stringify({
      version: 3,
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: { kind: 'terminal', mode: 'claude', createRequestId: 'req-1', status: 'running' },
        },
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: {},
    }))

    vi.resetModules()
    const panesReducer = (await import('../../../../src/store/panesSlice')).default
    const tabsReducer = (await import('../../../../src/store/tabsSlice')).default

    const store = configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } })
    const layout = store.getState().panes.layouts['tab-1'] as any
    expect(layout.content.resumeSessionId).toBe(validSessionId)
  })

  it('migrates resumeSessionId even when tab mode is missing or shell', async () => {
    localStorage.setItem('freshell.tabs.v1', JSON.stringify({
      tabs: {
        tabs: [
          { id: 'tab-1', mode: 'shell', resumeSessionId: validSessionId, status: 'running', title: 'Claude', createRequestId: 'tab-1' },
        ],
        activeTabId: 'tab-1',
      },
    }))

    localStorage.setItem('freshell.panes.v1', JSON.stringify({
      version: 3,
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: { kind: 'terminal', mode: 'claude', createRequestId: 'req-1', status: 'running' },
        },
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: {},
    }))

    vi.resetModules()
    const panesReducer = (await import('../../../../src/store/panesSlice')).default
    const tabsReducer = (await import('../../../../src/store/tabsSlice')).default

    const store = configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } })
    const layout = store.getState().panes.layouts['tab-1'] as any
    expect(layout.content.resumeSessionId).toBe(validSessionId)
  })

  it('does not migrate resumeSessionId into non-claude panes', async () => {
    localStorage.setItem('freshell.tabs.v1', JSON.stringify({
      tabs: {
        tabs: [
          { id: 'tab-1', mode: 'claude', resumeSessionId: validSessionId, status: 'running', title: 'Claude', createRequestId: 'tab-1' },
        ],
        activeTabId: 'tab-1',
      },
    }))

    localStorage.setItem('freshell.panes.v1', JSON.stringify({
      version: 3,
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-1', status: 'running' },
        },
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: {},
    }))

    vi.resetModules()
    const panesReducer = (await import('../../../../src/store/panesSlice')).default
    const tabsReducer = (await import('../../../../src/store/tabsSlice')).default

    const store = configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } })
    const layout = store.getState().panes.layouts['tab-1'] as any
    expect(layout.content.resumeSessionId).toBeUndefined()
  })

  it('migrates resumeSessionId to the first claude pane when active pane is shell', async () => {
    localStorage.setItem('freshell.tabs.v1', JSON.stringify({
      tabs: {
        tabs: [
          { id: 'tab-1', mode: 'claude', resumeSessionId: validSessionId, status: 'running', title: 'Claude', createRequestId: 'tab-1' },
        ],
        activeTabId: 'tab-1',
      },
    }))

    localStorage.setItem('freshell.panes.v1', JSON.stringify({
      version: 3,
      layouts: {
        'tab-1': {
          type: 'split',
          id: 'split-1',
          direction: 'horizontal',
          sizes: [50, 50],
          children: [
            { type: 'leaf', id: 'pane-shell', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-shell', status: 'running' } },
            { type: 'leaf', id: 'pane-claude', content: { kind: 'terminal', mode: 'claude', createRequestId: 'req-claude', status: 'running' } },
          ],
        },
      },
      activePane: { 'tab-1': 'pane-shell' },
      paneTitles: {},
    }))

    vi.resetModules()
    const panesReducer = (await import('../../../../src/store/panesSlice')).default
    const tabsReducer = (await import('../../../../src/store/tabsSlice')).default

    const store = configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } })
    const layout = store.getState().panes.layouts['tab-1'] as any
    expect(layout.children[1].content.resumeSessionId).toBe(validSessionId)
  })

  it('skips migration when resumeSessionId is invalid', async () => {
    localStorage.setItem('freshell.tabs.v1', JSON.stringify({
      tabs: {
        tabs: [
          { id: 'tab-1', mode: 'claude', resumeSessionId: 'not-a-uuid', status: 'running', title: 'Claude', createRequestId: 'tab-1' },
        ],
        activeTabId: 'tab-1',
      },
    }))

    localStorage.setItem('freshell.panes.v1', JSON.stringify({
      version: 3,
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: { kind: 'terminal', mode: 'claude', createRequestId: 'req-1', status: 'running' },
        },
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: {},
    }))

    vi.resetModules()
    const panesReducer = (await import('../../../../src/store/panesSlice')).default
    const tabsReducer = (await import('../../../../src/store/tabsSlice')).default

    const store = configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } })
    const layout = store.getState().panes.layouts['tab-1'] as any
    expect(layout.content.resumeSessionId).toBeUndefined()
  })
})
