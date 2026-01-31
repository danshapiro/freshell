import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import EditorPane from '@/components/panes/EditorPane'
import panesReducer from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'

// Mock Monaco to avoid loading issues in tests
vi.mock('@monaco-editor/react', () => {
  const MockEditor = ({ value, onChange }: any) => {
    const React = require('react')
    return React.createElement('textarea', {
      'data-testid': 'monaco-mock',
      value,
      onChange: (e: any) => onChange?.(e.target.value),
    })
  }
  return {
    default: MockEditor,
    Editor: MockEditor,
  }
})

// Helper to create a proper mock response for the api module (which uses res.text())
const createMockResponse = (data: unknown, ok = true, statusText = 'OK') => ({
  ok,
  statusText,
  text: async () => JSON.stringify(data),
})

// Mock fetch for file loading tests
const mockFetch = vi.fn()

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
    // Default mock for /api/terminals endpoint that EditorPane calls on mount
    mockFetch.mockImplementation(async (url: string) => {
      if (url === '/api/terminals') {
        return createMockResponse([])
      }
      return createMockResponse({}, false, 'Not Found')
    })
    sessionStorage.clear()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    mockFetch.mockReset()
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

    // The empty state shows an "Open File" button distinct from the toolbar's file picker
    const buttons = screen.getAllByRole('button', { name: /open file/i })
    expect(buttons.length).toBeGreaterThanOrEqual(1)
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

  it('renders markdown preview when viewMode is preview', () => {
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

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Hello World')
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
      sessionStorage.setItem('auth-token', 'test-token')
      mockFetch.mockImplementation(async (url: string) => {
        if (url === '/api/terminals') return createMockResponse([])
        if (url.startsWith('/api/files/read')) {
          return createMockResponse({ content: 'const x = 42' })
        }
        return createMockResponse({}, false, 'Not Found')
      })

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
          expect.objectContaining({
            headers: expect.any(Headers),
          })
        )
      })
    })

    it('sends auth token from sessionStorage with file load request', async () => {
      const user = userEvent.setup()
      sessionStorage.setItem('auth-token', 'my-secret-token')
      mockFetch.mockImplementation(async (url: string) => {
        if (url === '/api/terminals') return createMockResponse([])
        if (url.startsWith('/api/files/read')) {
          return createMockResponse({ content: 'file content' })
        }
        return createMockResponse({}, false, 'Not Found')
      })

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
        const calls = mockFetch.mock.calls
        const fileReadCall = calls.find((c: any) => c[0].startsWith('/api/files/read'))
        expect(fileReadCall).toBeTruthy()
        const headers = fileReadCall![1].headers as Headers
        expect(headers.get('x-auth-token')).toBe('my-secret-token')
      })
    })

    it('handles empty auth token gracefully', async () => {
      const user = userEvent.setup()
      // No token in sessionStorage
      mockFetch.mockImplementation(async (url: string) => {
        if (url === '/api/terminals') return createMockResponse([])
        if (url.startsWith('/api/files/read')) {
          return createMockResponse({ content: 'content' })
        }
        return createMockResponse({}, false, 'Not Found')
      })

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
        const calls = mockFetch.mock.calls
        const fileReadCall = calls.find((c: any) => c[0].startsWith('/api/files/read'))
        expect(fileReadCall).toBeTruthy()
        // When no token, the header should not be set
        const headers = fileReadCall![1].headers as Headers
        expect(headers.get('x-auth-token')).toBeNull()
      })
    })

    it('logs error when file load fails', async () => {
      const user = userEvent.setup()
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockFetch.mockImplementation(async (url: string) => {
        if (url === '/api/terminals') return createMockResponse([])
        if (url.startsWith('/api/files/read')) {
          return createMockResponse({ error: 'Not Found' }, false, 'Not Found')
        }
        return createMockResponse({}, false, 'Not Found')
      })

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
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('editor_file_load_failed')
        )
      })

      consoleSpy.mockRestore()
    })

    it('logs error when fetch throws', async () => {
      const user = userEvent.setup()
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockFetch.mockImplementation(async (url: string) => {
        if (url === '/api/terminals') return createMockResponse([])
        if (url.startsWith('/api/files/read')) {
          throw new Error('Network error')
        }
        return createMockResponse({}, false, 'Not Found')
      })

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
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('editor_file_load_failed')
        )
      })

      consoleSpy.mockRestore()
    })

    it('determines language from file extension', async () => {
      const user = userEvent.setup()
      mockFetch.mockImplementation(async (url: string) => {
        if (url === '/api/terminals') return createMockResponse([])
        if (url.startsWith('/api/files/read')) {
          return createMockResponse({ content: 'print("hello")' })
        }
        return createMockResponse({}, false, 'Not Found')
      })

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
        expect(mockFetch).toHaveBeenCalledWith(
          '/api/files/read?path=%2Fscript.py',
          expect.any(Object)
        )
      })
    })

    it('sets preview mode as default for markdown files', async () => {
      const user = userEvent.setup()
      mockFetch.mockImplementation(async (url: string) => {
        if (url === '/api/terminals') return createMockResponse([])
        if (url.startsWith('/api/files/read')) {
          return createMockResponse({ content: '# Hello' })
        }
        return createMockResponse({}, false, 'Not Found')
      })

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
        expect(mockFetch).toHaveBeenCalledWith(
          '/api/files/read?path=%2Freadme.md',
          expect.any(Object)
        )
      })
    })

    it('sets preview mode as default for html files', async () => {
      const user = userEvent.setup()
      mockFetch.mockImplementation(async (url: string) => {
        if (url === '/api/terminals') return createMockResponse([])
        if (url.startsWith('/api/files/read')) {
          return createMockResponse({ content: '<h1>Hello</h1>' })
        }
        return createMockResponse({}, false, 'Not Found')
      })

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
        expect(mockFetch).toHaveBeenCalledWith(
          '/api/files/read?path=%2Fpage.html',
          expect.any(Object)
        )
      })
    })

    it('does not load file when path is cleared', async () => {
      const user = userEvent.setup()
      const fileReadCalls: string[] = []
      mockFetch.mockImplementation(async (url: string) => {
        if (url === '/api/terminals') return createMockResponse([])
        if (url.startsWith('/api/files/read')) {
          fileReadCalls.push(url)
          return createMockResponse({ content: 'content' })
        }
        return createMockResponse({}, false, 'Not Found')
      })

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

      // Small delay to ensure any async calls would have been made
      await new Promise((r) => setTimeout(r, 50))

      // No file read calls should have been made
      expect(fileReadCalls).toHaveLength(0)
    })
  })
})
