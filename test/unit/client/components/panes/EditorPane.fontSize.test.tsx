import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { updateSettingsLocal } from '@/store/settingsSlice'
import connectionReducer, { setStatus } from '@/store/connectionSlice'
import tabRegistryReducer from '@/store/tabRegistrySlice'
import {
  BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS,
  browserPreferencesPersistenceMiddleware,
  resetBrowserPreferencesFlushListenersForTests,
} from '@/store/browserPreferencesPersistence'
import { resetPersistBroadcastForTests } from '@/store/persistBroadcast'
import { BROWSER_PREFERENCES_STORAGE_KEY } from '@/store/storage-keys'

// Options-aware Monaco mock: exposes the options the pane passes so the tests
// can pin fontSize wiring (plus a couple of neighbors as a regression guard).
vi.mock('@monaco-editor/react', () => {
  const MonacoMock = ({ value, onChange, options }: any) => (
    <textarea
      data-testid="monaco-mock"
      data-font-size={String(options?.fontSize)}
      data-minimap-enabled={String(options?.minimap?.enabled)}
      data-tab-size={String(options?.tabSize)}
      value={value}
      onChange={(e: any) => onChange?.(e.target.value)}
    />
  )
  return { default: MonacoMock, Editor: MonacoMock }
})

import EditorPane from '@/components/panes/EditorPane'

const mockFetch = vi.fn()

const createMockResponse = (body: object) => ({
  ok: true,
  statusText: 'OK',
  text: () => Promise.resolve(JSON.stringify(body)),
  json: () => Promise.resolve(body),
})

// Routed no-op resolver so mount-time API calls don't reject.
const routedFetch = async (input: any) => {
  const url = String(input)
  if (url.startsWith('/api/terminals')) return createMockResponse([])
  if (url.startsWith('/api/files/complete')) return createMockResponse({ suggestions: [] })
  if (url.startsWith('/api/files/read')) return createMockResponse({ content: '' })
  return createMockResponse({})
}

// No preloadedState: the settings slice default resolves terminal.fontSize to 16.
const createStore = () => {
  const store = configureStore({
    reducer: {
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
    },
  })
  store.dispatch(setStatus('ready'))
  return store
}

const renderEditor = (store: ReturnType<typeof createStore>) =>
  render(
    <Provider store={store}>
      <EditorPane
        paneId="pane-1"
        tabId="tab-1"
        filePath="/test.ts"
        language="typescript"
        readOnly={false}
        content="const x = 1"
        viewMode="source"
      />
    </Provider>
  )

describe('EditorPane font size follows settings.terminal.fontSize', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
    mockFetch.mockImplementation(routedFetch as any)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('defaults to the terminal font size setting (16, not the old hard-coded 14)', () => {
    const store = createStore()
    renderEditor(store)

    const mock = screen.getByTestId('monaco-mock')
    expect(mock.getAttribute('data-font-size')).toBe('16')
    // Regression guard: the rest of the options literal must be untouched.
    expect(mock.getAttribute('data-minimap-enabled')).toBe('false')
    expect(mock.getAttribute('data-tab-size')).toBe('2')
  })

  it('uses the current setting when the editor mounts after the setting changed', () => {
    const store = createStore()
    store.dispatch(updateSettingsLocal({ terminal: { fontSize: 20 } }))
    renderEditor(store)

    expect(screen.getByTestId('monaco-mock').getAttribute('data-font-size')).toBe('20')
  })

  it('updates live without remounting when the setting changes (slider drag)', () => {
    const store = createStore()
    renderEditor(store)

    const mock = screen.getByTestId('monaco-mock')
    expect(mock.getAttribute('data-font-size')).toBe('16')

    act(() => {
      store.dispatch(updateSettingsLocal({ terminal: { fontSize: 24 } }))
    })

    // Same node identity: the editor was updated, not remounted.
    expect(screen.getByTestId('monaco-mock')).toBe(mock)
    expect(mock.getAttribute('data-font-size')).toBe('24')
  })

  it('receives the clamped value for out-of-range settings (999 -> 64)', () => {
    const store = createStore()
    renderEditor(store)

    act(() => {
      store.dispatch(updateSettingsLocal({ terminal: { fontSize: 999 } }))
    })

    expect(store.getState().settings.settings.terminal.fontSize).toBe(64)
    expect(screen.getByTestId('monaco-mock').getAttribute('data-font-size')).toBe('64')
  })
})

// Restart simulation: seeding localStorage and then re-importing the settings
// slice re-runs its module-level `loadInitialLocalSettings()`, which is exactly
// what happens when the app boots.
describe('EditorPane font size after restart', () => {
  const importFreshSettingsReducer = async () => {
    vi.resetModules()
    return (await import('@/store/settingsSlice')).default
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
    mockFetch.mockImplementation(routedFetch as any)
    localStorage.clear()
    resetBrowserPreferencesFlushListenersForTests()
    resetPersistBroadcastForTests()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    localStorage.clear()
    resetBrowserPreferencesFlushListenersForTests()
    resetPersistBroadcastForTests()
  })

  it('keeps the font size chosen before the restart (full persistence round-trip)', async () => {
    vi.useFakeTimers()

    // Session 1: change the terminal font size through the real persistence path.
    const firstStore = configureStore({
      reducer: {
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
        tabRegistry: tabRegistryReducer,
      },
      middleware: (getDefault) => getDefault().concat(browserPreferencesPersistenceMiddleware),
    })
    firstStore.dispatch(setStatus('ready'))
    const firstRender = renderEditor(firstStore)

    const firstMock = screen.getByTestId('monaco-mock')
    expect(firstMock.getAttribute('data-font-size')).toBe('16')

    act(() => {
      firstStore.dispatch(updateSettingsLocal({ terminal: { fontSize: 22 } }))
    })
    expect(firstMock.getAttribute('data-font-size')).toBe('22')

    // The debounced write lands in the browser-preferences blob.
    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)
    expect(JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')).toEqual({
      settings: { terminal: { fontSize: 22 } },
    })

    firstRender.unmount()

    // Session 2 (after restart): a fresh settings slice reads localStorage at init.
    const freshSettingsReducer = await importFreshSettingsReducer()
    const restartedStore = configureStore({
      reducer: {
        panes: panesReducer,
        settings: freshSettingsReducer,
        connection: connectionReducer,
      },
    })
    restartedStore.dispatch(setStatus('ready'))
    renderEditor(restartedStore)

    expect(restartedStore.getState().settings.settings.terminal.fontSize).toBe(22)
    expect(screen.getByTestId('monaco-mock').getAttribute('data-font-size')).toBe('22')
  })

  it('applies the persisted terminal font size when the editor mounts after restart', async () => {
    localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, JSON.stringify({
      settings: { terminal: { fontSize: 20 } },
    }))

    const freshSettingsReducer = await importFreshSettingsReducer()
    const store = configureStore({
      reducer: {
        panes: panesReducer,
        settings: freshSettingsReducer,
        connection: connectionReducer,
      },
    })
    store.dispatch(setStatus('ready'))
    renderEditor(store)

    expect(store.getState().settings.settings.terminal.fontSize).toBe(20)
    expect(screen.getByTestId('monaco-mock').getAttribute('data-font-size')).toBe('20')
  })

  it('applies the clamped persisted font size after restart (999 -> 64)', async () => {
    localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, JSON.stringify({
      settings: { terminal: { fontSize: 999 } },
    }))

    const freshSettingsReducer = await importFreshSettingsReducer()
    const store = configureStore({
      reducer: {
        panes: panesReducer,
        settings: freshSettingsReducer,
        connection: connectionReducer,
      },
    })
    store.dispatch(setStatus('ready'))
    renderEditor(store)

    expect(store.getState().settings.settings.terminal.fontSize).toBe(64)
    expect(screen.getByTestId('monaco-mock').getAttribute('data-font-size')).toBe('64')
  })
})
