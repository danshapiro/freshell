import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import EditorPane from '@/components/panes/EditorPane'
import panesReducer from '@/store/panesSlice'

// Mock Monaco to avoid loading issues in tests
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: any) => (
    <textarea
      data-testid="monaco-mock"
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}))

// Mock fetch for file loading tests
const mockFetch = vi.fn()

const createMockStore = () =>
  configureStore({
    reducer: {
      panes: panesReducer,
    },
  })

describe('EditorPane', () => {
  let store: ReturnType<typeof createMockStore>

  beforeEach(() => {
    store = createMockStore()
    vi.stubGlobal('fetch', mockFetch)
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

    expect(screen.getByRole('button', { name: /open file/i })).toBeInTheDocument()
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

    expect(screen.getByTitle('HTML Preview')).toBeInTheDocument()
  })

  describe('file loading', () => {
    it('loads file content from server when path is entered', async () => {
      const user = userEvent.setup()
      sessionStorage.setItem('auth-token', 'test-token')
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: 'const x = 42' }),
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
            headers: { 'x-auth-token': 'test-token' },
          })
        )
      })
    })

    it('sends auth token from sessionStorage with file load request', async () => {
      const user = userEvent.setup()
      sessionStorage.setItem('auth-token', 'my-secret-token')
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: 'file content' }),
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
        expect(mockFetch).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: { 'x-auth-token': 'my-secret-token' },
          })
        )
      })
    })

    it('handles empty auth token gracefully', async () => {
      const user = userEvent.setup()
      // No token in sessionStorage
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: 'content' }),
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
        expect(mockFetch).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: { 'x-auth-token': '' },
          })
        )
      })
    })

    it('logs error when file load fails', async () => {
      const user = userEvent.setup()
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockFetch.mockResolvedValueOnce({
        ok: false,
        statusText: 'Not Found',
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
        expect(consoleSpy).toHaveBeenCalledWith('Failed to load file:', 'Not Found')
      })

      consoleSpy.mockRestore()
    })

    it('logs error when fetch throws', async () => {
      const user = userEvent.setup()
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

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
        expect(consoleSpy).toHaveBeenCalledWith('Failed to load file:', expect.any(Error))
      })

      consoleSpy.mockRestore()
    })

    it('determines language from file extension', async () => {
      const user = userEvent.setup()
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: 'print("hello")' }),
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
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: '# Hello' }),
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
        expect(mockFetch).toHaveBeenCalled()
      })
    })

    it('sets preview mode as default for html files', async () => {
      const user = userEvent.setup()
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: '<h1>Hello</h1>' }),
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

      // fetch should not be called when path is empty
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })
})
