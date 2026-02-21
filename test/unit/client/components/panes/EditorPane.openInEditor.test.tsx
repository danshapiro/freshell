import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import EditorPane from '@/components/panes/EditorPane'
import { getEditorActions } from '@/lib/pane-action-registry'
import panesReducer from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'

// Capture the onMount callback so we can invoke it with a mock editor
let capturedOnMount: ((editor: any) => void) | null = null

vi.mock('@monaco-editor/react', () => {
  const MonacoMock = ({ value, onChange, onMount }: any) => {
    capturedOnMount = onMount
    return (
      <textarea
        data-testid="monaco-mock"
        value={value}
        onChange={(e: any) => onChange?.(e.target.value)}
      />
    )
  }
  return {
    default: MonacoMock,
    Editor: MonacoMock,
  }
})

const createMockStore = () =>
  configureStore({
    reducer: {
      panes: panesReducer,
      settings: settingsReducer,
    },
  })

function createRoutedFetch() {
  return async (input: any) => {
    const url = String(input)

    if (url.startsWith('/api/terminals')) {
      return {
        ok: true,
        text: () => Promise.resolve(JSON.stringify([])),
      }
    }
    if (url.startsWith('/api/files/complete')) {
      return {
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ suggestions: [] })),
      }
    }

    // Default: return success for any POST (e.g. /api/files/open)
    return {
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ success: true })),
    }
  }
}

describe('EditorPane openInEditor cursor position', () => {
  let store: ReturnType<typeof createMockStore>
  const mockFetch = vi.fn()

  beforeEach(() => {
    store = createMockStore()
    capturedOnMount = null
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
    mockFetch.mockImplementation(createRoutedFetch() as any)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('sends cursor line and column to /api/files/open', async () => {
    const mockEditor = {
      focus: vi.fn(),
      getPosition: vi.fn().mockReturnValue({ lineNumber: 42, column: 7 }),
    }

    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-open-test"
          tabId="tab-1"
          filePath="/src/app.ts"
          language="typescript"
          readOnly={false}
          content="const x = 1"
          viewMode="source"
        />
      </Provider>
    )

    // Simulate Monaco mounting by calling the captured onMount callback
    expect(capturedOnMount).not.toBeNull()
    act(() => {
      capturedOnMount!(mockEditor)
    })

    // Retrieve the registered editor actions and call openInEditor
    const actions = getEditorActions('pane-open-test')
    expect(actions).toBeDefined()

    await act(async () => {
      await actions!.openInEditor()
    })

    // Verify fetch was called with the correct path and body
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/files/open',
      expect.objectContaining({
        method: 'POST',
      })
    )

    // Find the /api/files/open call and verify its body
    const openCall = mockFetch.mock.calls.find(
      ([url]: [string]) => url === '/api/files/open'
    )
    expect(openCall).toBeDefined()

    const body = JSON.parse(openCall![1].body)
    expect(body).toEqual({
      path: '/src/app.ts',
      reveal: false,
      line: 42,
      column: 7,
    })
  })

  it('sends undefined line/column when no cursor position is available', async () => {
    const mockEditor = {
      focus: vi.fn(),
      getPosition: vi.fn().mockReturnValue(null),
    }

    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-no-pos"
          tabId="tab-1"
          filePath="/src/app.ts"
          language="typescript"
          readOnly={false}
          content="const x = 1"
          viewMode="source"
        />
      </Provider>
    )

    act(() => {
      capturedOnMount!(mockEditor)
    })

    const actions = getEditorActions('pane-no-pos')
    expect(actions).toBeDefined()

    await act(async () => {
      await actions!.openInEditor()
    })

    const openCall = mockFetch.mock.calls.find(
      ([url]: [string]) => url === '/api/files/open'
    )
    expect(openCall).toBeDefined()

    const body = JSON.parse(openCall![1].body)
    expect(body.path).toBe('/src/app.ts')
    expect(body.line).toBeUndefined()
    expect(body.column).toBeUndefined()
  })

  it('revealInExplorer sends reveal:true with cursor position', async () => {
    const mockEditor = {
      focus: vi.fn(),
      getPosition: vi.fn().mockReturnValue({ lineNumber: 10, column: 3 }),
    }

    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-reveal"
          tabId="tab-1"
          filePath="/src/index.ts"
          language="typescript"
          readOnly={false}
          content="export default {}"
          viewMode="source"
        />
      </Provider>
    )

    act(() => {
      capturedOnMount!(mockEditor)
    })

    const actions = getEditorActions('pane-reveal')
    expect(actions).toBeDefined()

    await act(async () => {
      await actions!.revealInExplorer()
    })

    const openCall = mockFetch.mock.calls.find(
      ([url]: [string]) => url === '/api/files/open'
    )
    expect(openCall).toBeDefined()

    const body = JSON.parse(openCall![1].body)
    expect(body).toEqual({
      path: '/src/index.ts',
      reveal: true,
      line: 10,
      column: 3,
    })
  })
})
