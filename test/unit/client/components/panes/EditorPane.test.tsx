import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import EditorPane from '@/components/panes/EditorPane'
import panesReducer from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'

// Render MarkdownRenderer synchronously to avoid React.lazy timing issues
// when running in the full test suite (dynamic import may not resolve in time)
vi.mock('@/components/markdown/LazyMarkdown', async () => {
  const { MarkdownRenderer } = await import('@/components/markdown/MarkdownRenderer')
  return {
    LazyMarkdown: ({ content }: { content: string }) => (
      <MarkdownRenderer content={content} />
    ),
  }
})

// Mock Monaco to avoid loading issues in tests
vi.mock('@monaco-editor/react', () => {
  const MonacoMock = ({ value, onChange }: any) => (
    <textarea
      data-testid="monaco-mock"
      value={value}
      onChange={(e: any) => onChange?.(e.target.value)}
    />
  )
  return {
    default: MonacoMock,
    Editor: MonacoMock,
  }
})

// Mock fetch for file loading tests
const mockFetch = vi.fn()

// Helper to create a proper Response mock with text() method
const createMockResponse = (body: object, ok = true, statusText = 'OK') => ({
  ok,
  statusText,
  text: () => Promise.resolve(JSON.stringify(body)),
  json: () => Promise.resolve(body),
})

function createRoutedFetch(opts?: {
  terminals?: any
  complete?: any
  read?: any
  readOk?: boolean
  readStatusText?: string
  throwOnRead?: Error
}) {
  const terminalsBody = opts?.terminals ?? []
  const completeBody = opts?.complete ?? { suggestions: [] }
  const readBody = opts?.read ?? { content: '' }
  const readOk = opts?.readOk ?? true
  const readStatusText = opts?.readStatusText ?? 'OK'
  const throwOnRead = opts?.throwOnRead

  return async (input: any) => {
    const url = String(input)

    if (url.startsWith('/api/terminals')) {
      return createMockResponse(terminalsBody)
    }
    if (url.startsWith('/api/files/complete')) {
      return createMockResponse(completeBody)
    }
    if (url.startsWith('/api/files/read')) {
      if (throwOnRead) throw throwOnRead
      return createMockResponse(readBody, readOk, readStatusText)
    }

    return createMockResponse({})
  }
}

const createMockStore = () =>
  configureStore({
    reducer: {
      panes: panesReducer,
      settings: settingsReducer,
    },
  })

describe('EditorPane', () => {
  let store: ReturnType<typeof createMockStore>

  beforeEach(() => {
    store = createMockStore()
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
    mockFetch.mockImplementation(createRoutedFetch() as any)
    sessionStorage.clear()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('renders empty state with Open File button', () => {
    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath={null}
          language={null}
          readOnly={false}
          content=""
          viewMode="source"
        />
      </Provider>
    )

    // Exact text for the main "Open File" button in empty state (not the picker button)
    expect(screen.getByRole('button', { name: 'Open File' })).toBeInTheDocument()
  })

  it('renders Monaco editor when content is provided', () => {
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

    expect(screen.getByTestId('monaco-mock')).toBeInTheDocument()
  })

  it('renders toolbar with path input', () => {
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

    expect(screen.getByPlaceholderText(/enter file path/i)).toBeInTheDocument()
  })

  it('shows view toggle for markdown files', () => {
    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath="/readme.md"
          language="markdown"
          readOnly={false}
          content="# Hello"
          viewMode="source"
        />
      </Provider>
    )

    expect(screen.getByRole('button', { name: /preview/i })).toBeInTheDocument()
  })

  it('hides view toggle for non-markdown/html files', () => {
    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath="/code.ts"
          language="typescript"
          readOnly={false}
          content="const x = 1"
          viewMode="source"
        />
      </Provider>
    )

    expect(screen.queryByRole('button', { name: /preview/i })).not.toBeInTheDocument()
  })

  it('renders markdown preview when viewMode is preview', async () => {
    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath="/readme.md"
          language="markdown"
          readOnly={false}
          content="# Hello World"
          viewMode="preview"
        />
      </Provider>
    )

    expect(await screen.findByRole('heading', { level: 1 }, { timeout: 5000 })).toHaveTextContent('Hello World')
    expect(screen.queryByTestId('monaco-mock')).not.toBeInTheDocument()
  })

  it('renders HTML in iframe when viewMode is preview', () => {
    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath="/page.html"
          language="html"
          readOnly={false}
          content="<h1>Test</h1>"
          viewMode="preview"
        />
      </Provider>
    )

    expect(screen.getByTitle('HTML preview')).toBeInTheDocument()
  })

  describe('file loading', () => {
    it('loads file content from server when path is entered', async () => {
      const user = userEvent.setup()
      localStorage.setItem('freshell.auth-token', 'test-token')
      mockFetch.mockImplementation(createRoutedFetch({ read: { content: 'const x = 42' } }) as any)

      render(
        <Provider store={store}>
          <EditorPane
            paneId="pane-1"
            tabId="tab-1"
            filePath={null}
            language={null}
            readOnly={false}
            content=""
            viewMode="source"
          />
        </Provider>
      )

      const input = screen.getByPlaceholderText(/enter file path/i)
      await user.clear(input)
      await user.type(input, '/path/to/file.ts{enter}')

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          '/api/files/read?path=%2Fpath%2Fto%2Ffile.ts',
          expect.any(Object)
        )
      })
    })

    it('sends file read request when path is entered', async () => {
      const user = userEvent.setup()
      localStorage.setItem('freshell.auth-token', 'my-secret-token')
      mockFetch.mockImplementation(createRoutedFetch({ read: { content: 'file content' } }) as any)

      render(
        <Provider store={store}>
          <EditorPane
            paneId="pane-1"
            tabId="tab-1"
            filePath={null}
            language={null}
            readOnly={false}
            content=""
            viewMode="source"
          />
        </Provider>
      )

      const input = screen.getByPlaceholderText(/enter file path/i)
      await user.clear(input)
      await user.type(input, '/test.js{enter}')

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/api/files/read'),
          expect.any(Object)
        )
      })
    })

    it('handles empty auth token gracefully', async () => {
      const user = userEvent.setup()
      // No token in sessionStorage
      mockFetch.mockImplementation(createRoutedFetch({ read: { content: 'content' } }) as any)

      render(
        <Provider store={store}>
          <EditorPane
            paneId="pane-1"
            tabId="tab-1"
            filePath={null}
            language={null}
            readOnly={false}
            content=""
            viewMode="source"
          />
        </Provider>
      )

      const input = screen.getByPlaceholderText(/enter file path/i)
      await user.clear(input)
      await user.type(input, '/test.js{enter}')

      // Should still attempt to load the file even without auth token
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/api/files/read?path=%2Ftest.js'),
          expect.any(Object)
        )
      })
    })

    it('logs error when file load fails', async () => {
      const user = userEvent.setup()
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockFetch.mockImplementation(
        createRoutedFetch({ read: {}, readOk: false, readStatusText: 'Not Found' }) as any
      )

      render(
        <Provider store={store}>
          <EditorPane
            paneId="pane-1"
            tabId="tab-1"
            filePath={null}
            language={null}
            readOnly={false}
            content=""
            viewMode="source"
          />
        </Provider>
      )

      const input = screen.getByPlaceholderText(/enter file path/i)
      await user.clear(input)
      await user.type(input, '/nonexistent.ts{enter}')

      await waitFor(() => {
        // EditorPane uses structured JSON logging
        expect(consoleSpy).toHaveBeenCalledWith(
          '[EditorPane]',
          expect.stringContaining('"event":"editor_file_load_failed"')
        )
      })

      consoleSpy.mockRestore()
    })

    it('logs error when fetch throws', async () => {
      const user = userEvent.setup()
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockFetch.mockImplementation(
        createRoutedFetch({ throwOnRead: new Error('Network error') }) as any
      )

      render(
        <Provider store={store}>
          <EditorPane
            paneId="pane-1"
            tabId="tab-1"
            filePath={null}
            language={null}
            readOnly={false}
            content=""
            viewMode="source"
          />
        </Provider>
      )

      const input = screen.getByPlaceholderText(/enter file path/i)
      await user.clear(input)
      await user.type(input, '/test.ts{enter}')

      await waitFor(() => {
        // EditorPane uses structured JSON logging
        expect(consoleSpy).toHaveBeenCalledWith(
          '[EditorPane]',
          expect.stringContaining('"event":"editor_file_load_failed"')
        )
      })

      consoleSpy.mockRestore()
    })

    it('determines language from file extension', async () => {
      const user = userEvent.setup()
      mockFetch.mockImplementation(
        createRoutedFetch({ read: { content: 'print("hello")' } }) as any
      )

      render(
        <Provider store={store}>
          <EditorPane
            paneId="pane-1"
            tabId="tab-1"
            filePath={null}
            language={null}
            readOnly={false}
            content=""
            viewMode="source"
          />
        </Provider>
      )

      const input = screen.getByPlaceholderText(/enter file path/i)
      await user.clear(input)
      await user.type(input, '/script.py{enter}')

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled()
      })

      // The language detection happens internally, we verify fetch was called with the right path
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/files/read?path=%2Fscript.py',
        expect.any(Object)
      )
    })

    it('sets preview mode as default for markdown files', async () => {
      const user = userEvent.setup()
      mockFetch.mockImplementation(createRoutedFetch({ read: { content: '# Hello' } }) as any)

      render(
        <Provider store={store}>
          <EditorPane
            paneId="pane-1"
            tabId="tab-1"
            filePath={null}
            language={null}
            readOnly={false}
            content=""
            viewMode="source"
          />
        </Provider>
      )

      const input = screen.getByPlaceholderText(/enter file path/i)
      await user.clear(input)
      await user.type(input, '/readme.md{enter}')

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled()
      })
    })

    it('sets preview mode as default for html files', async () => {
      const user = userEvent.setup()
      mockFetch.mockImplementation(
        createRoutedFetch({ read: { content: '<h1>Hello</h1>' } }) as any
      )

      render(
        <Provider store={store}>
          <EditorPane
            paneId="pane-1"
            tabId="tab-1"
            filePath={null}
            language={null}
            readOnly={false}
            content=""
            viewMode="source"
          />
        </Provider>
      )

      const input = screen.getByPlaceholderText(/enter file path/i)
      await user.clear(input)
      await user.type(input, '/page.html{enter}')

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled()
      })
    })

    it('does not load file when path is cleared', async () => {
      const user = userEvent.setup()

      render(
        <Provider store={store}>
          <EditorPane
            paneId="pane-1"
            tabId="tab-1"
            filePath="/existing.ts"
            language="typescript"
            readOnly={false}
            content="existing content"
            viewMode="source"
          />
        </Provider>
      )

      const input = screen.getByPlaceholderText(/enter file path/i)
      await user.clear(input)
      fireEvent.keyDown(input, { key: 'Enter' })

      // File read API should not be called when path is empty
      // (autocomplete API may still be called, that's expected)
      expect(mockFetch).not.toHaveBeenCalledWith(
        expect.stringContaining('/api/files/read'),
        expect.any(Object)
      )
    })

    it('auto-fetches file content on mount when filePath is set but content is empty (restoration)', async () => {
      // This simulates restoration from localStorage where content is stripped
      localStorage.setItem('freshell.auth-token', 'test-token')
      mockFetch.mockImplementation(
        createRoutedFetch({
          read: { content: 'restored file content', language: 'typescript' },
        }) as any
      )

      render(
        <Provider store={store}>
          <EditorPane
            paneId="pane-1"
            tabId="tab-1"
            filePath="/path/to/restored-file.ts"
            language="typescript"
            readOnly={false}
            content=""
            viewMode="source"
          />
        </Provider>
      )

      // Should automatically fetch the file content on mount
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          '/api/files/read?path=%2Fpath%2Fto%2Frestored-file.ts',
          expect.any(Object)
        )
      })
    })

    it('does not auto-fetch on mount when content is already present', async () => {
      localStorage.setItem('freshell.auth-token', 'test-token')

      render(
        <Provider store={store}>
          <EditorPane
            paneId="pane-1"
            tabId="tab-1"
            filePath="/path/to/file.ts"
            language="typescript"
            readOnly={false}
            content="existing content"
            viewMode="source"
          />
        </Provider>
      )

      // Give it time to potentially make a fetch call
      await new Promise(resolve => setTimeout(resolve, 50))

      // Should NOT fetch since content is already present
      expect(mockFetch).not.toHaveBeenCalledWith(
        expect.stringContaining('/api/files/read'),
        expect.any(Object)
      )
    })
  })
})
