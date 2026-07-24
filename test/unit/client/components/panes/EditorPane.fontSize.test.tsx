import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { updateSettingsLocal } from '@/store/settingsSlice'
import connectionReducer, { setStatus } from '@/store/connectionSlice'

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
