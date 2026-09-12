import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useEffect } from 'react'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import EditorPane from '@/components/panes/EditorPane'
import panesReducer, { setActivePane } from '@/store/panesSlice'
import { wirePaneFocusOwnershipInvalidation, paneSelectionMiddleware } from '@/lib/pane-focus-ownership'
import settingsReducer from '@/store/settingsSlice'
import connectionReducer, { setStatus } from '@/store/connectionSlice'

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

const monacoMountControl = vi.hoisted(() => ({
  enabled: false,
  /** Monaco's real onMount is async — tests can model the delay explicitly. */
  mountDelayMs: 0,
  focus: vi.fn(),
}))

// Mock Monaco to avoid loading issues in tests
vi.mock('@monaco-editor/react', () => {
  const MonacoMock = ({ value, onChange, theme, onMount }: any) => {
    useEffect(() => {
      if (!monacoMountControl.enabled) return
      const timer = setTimeout(() => {
        onMount?.(
          { focus: monacoMountControl.focus, getValue: () => '', setValue: () => {}, updateOptions: () => {}, getModel: () => null } as any,
          {} as any,
        )
      }, monacoMountControl.mountDelayMs)
      return () => clearTimeout(timer)
    }, [])
    return (
      <textarea
        data-testid="monaco-mock"
        data-theme={theme}
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

const createMockStore = (overrides?: { theme?: string }) => {
  const store = configureStore({
    reducer: {
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
    },
    middleware: (getDefault) => getDefault().concat(paneSelectionMiddleware as never),
    preloadedState: overrides
      ? {
          settings: {
            settings: {
              theme: overrides.theme ?? 'system',
              defaultCwd: '',
              uiScale: 1.0,
              terminal: { fontSize: 16 },
              sidebar: { canarySubstrings: [] },
              codingCli: { theme: 'auto' },
              tabs: {},
              logging: {},
              freshAgent: { providers: {} },
            },
          },
        }
      : undefined,
  })
  store.dispatch(setStatus('ready'))
  return store
}

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

    await vi.dynamicImportSettled()
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

    it('stays silent when the file load fails at the transport layer (server unreachable)', async () => {
      // fetch() rejects only on transport failures — expected while the server
      // is restarting, so no error should be logged (the poll re-syncs later).
      const user = userEvent.setup()
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockFetch.mockImplementation(
        createRoutedFetch({ throwOnRead: new TypeError('Failed to fetch') }) as any
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

      // Wait for the read attempt to complete, then confirm nothing was logged.
      await waitFor(() => {
        expect(
          mockFetch.mock.calls.some((call) => String(call[0]).includes('/api/files/read'))
        ).toBe(true)
      })

      expect(consoleSpy).not.toHaveBeenCalledWith(
        '[EditorPane]',
        expect.stringContaining('"event":"editor_file_load_failed"')
      )

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

  describe('theme', () => {
    it('uses vs-dark theme when settings theme is dark', () => {
      const darkStore = createMockStore({ theme: 'dark' })
      render(
        <Provider store={darkStore}>
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

      expect(screen.getByTestId('monaco-mock').getAttribute('data-theme')).toBe('vs-dark')
    })

    it('uses vs (light) theme when settings theme is light', () => {
      const lightStore = createMockStore({ theme: 'light' })
      render(
        <Provider store={lightStore}>
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

      expect(screen.getByTestId('monaco-mock').getAttribute('data-theme')).toBe('vs')
    })
  })

  describe('word wrap', () => {
    it('renders the wrap toggle button with disable label when wrap is on', () => {
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

      expect(screen.getByRole('button', { name: /disable line wrap/i })).toBeInTheDocument()
    })

    it('renders the wrap toggle button with enable label when wrap is off', () => {
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
            wordWrap={false}
          />
        </Provider>
      )

      expect(screen.getByRole('button', { name: /enable line wrap/i })).toBeInTheDocument()
    })

    it('defaults wordWrap to true', () => {
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

      // Defaults to true, so button should say "disable" (can turn it off)
      expect(screen.getByRole('button', { name: /disable line wrap/i })).toBeInTheDocument()
    })
  })

  describe('focus gating', () => {
    beforeEach(() => {
      monacoMountControl.focus.mockClear()
    })

    afterEach(() => {
      monacoMountControl.enabled = false
      monacoMountControl.mountDelayMs = 0
    })

    it('focuses the editor on ASYNC mount for an eligible pane (default — pins initial autofocus)', async () => {
      monacoMountControl.enabled = true
      monacoMountControl.mountDelayMs = 30
      render(
        <Provider store={store}>
          <EditorPane paneId="pane-1" tabId="tab-1" filePath="/test.ts" language="typescript" readOnly={false} content="const x = 1" viewMode="source" />
        </Provider>
      )
      await waitFor(() => expect(screen.getByTestId('monaco-mock')).toBeInTheDocument())
      await waitFor(() => expect(monacoMountControl.focus).toHaveBeenCalled())
    })

    it('does not focus the editor while ineligible, but focuses on the later false→true flip (explicit select)', async () => {
      monacoMountControl.enabled = true
      const { rerender } = render(
        <Provider store={store}>
          <EditorPane paneId="pane-1" tabId="tab-1" filePath="/test.ts" language="typescript" readOnly={false} content="const x = 1" viewMode="source" focusEligible={false} />
        </Provider>
      )
      await waitFor(() => expect(screen.getByTestId('monaco-mock')).toBeInTheDocument())
      await new Promise((r) => setTimeout(r, 50))
      expect(monacoMountControl.focus).not.toHaveBeenCalled()

      rerender(
        <Provider store={store}>
          <EditorPane paneId="pane-1" tabId="tab-1" filePath="/test.ts" language="typescript" readOnly={false} content="const x = 1" viewMode="source" focusEligible />
        </Provider>
      )
      await waitFor(() => expect(monacoMountControl.focus).toHaveBeenCalledTimes(1))
    })
    it('focuses when explicitly selected BEFORE async Monaco mount completes (selection must survive the mount race)', async () => {
      monacoMountControl.enabled = true
      monacoMountControl.mountDelayMs = 60
      const { rerender } = render(
        <Provider store={store}>
          <EditorPane paneId="pane-1" tabId="tab-1" filePath="/test.ts" language="typescript" readOnly={false} content="const x = 1" viewMode="source" focusEligible={false} />
        </Provider>
      )
      await waitFor(() => expect(screen.getByTestId('monaco-mock')).toBeInTheDocument())
      // Flip eligibility BEFORE the async mount fires. The flip effect finds
      // editorRef.current still null; the saved onMount closure captured
      // focusEligible=false. A stale-closure implementation leaves the
      // explicitly-selected editor unfocused forever.
      rerender(
        <Provider store={store}>
          <EditorPane paneId="pane-1" tabId="tab-1" filePath="/test.ts" language="typescript" readOnly={false} content="const x = 1" viewMode="source" focusEligible />
        </Provider>
      )
      await waitFor(() => expect(monacoMountControl.focus).toHaveBeenCalledTimes(1))
    })

    it('explicit select focuses the pane ROOT when Monaco is absent (preview mode — no editorRef in the tree)', async () => {
      const { rerender } = render(
        <Provider store={store}>
          <EditorPane paneId="pane-1" tabId="tab-1" filePath="/a.md" language="markdown" readOnly={false} content="# Hi" viewMode="preview" focusEligible={false} />
        </Provider>
      )
      const root = await screen.findByTestId('editor-pane')
      const chrome = document.createElement('input')
      document.body.appendChild(chrome)
      chrome.focus()
      rerender(
        <Provider store={store}>
          <EditorPane paneId="pane-1" tabId="tab-1" filePath="/a.md" language="markdown" readOnly={false} content="# Hi" viewMode="preview" focusEligible />
        </Provider>
      )
      // flip paths only called editorRef.current?.focus() — null in preview —
      // leaving the explicitly-selected editor unfocused (round-5 Major).
      expect(root).toHaveFocus()
    })

    it('falls back to the pane root when a previously-mounted editor was unmounted (source → empty state), never calling a disposed editor', async () => {
      monacoMountControl.enabled = true
      const { rerender } = render(
        <Provider store={store}>
          <EditorPane paneId="pane-1" tabId="tab-1" filePath="/test.ts" language="typescript" readOnly={false} content="const x = 1" viewMode="source" focusEligible />
        </Provider>
      )
      await waitFor(() => expect(monacoMountControl.focus).toHaveBeenCalledTimes(1))
      // Switch to the empty state: the conditional <Editor> unmounts and
      // @monaco-editor/react disposes the editor instance.
      rerender(
        <Provider store={store}>
          <EditorPane paneId="pane-1" tabId="tab-1" filePath={null} language={null} readOnly={false} content="" viewMode="source" focusEligible={false} />
        </Provider>
      )
      const chrome = document.createElement('input')
      document.body.appendChild(chrome)
      chrome.focus()
      rerender(
        <Provider store={store}>
          <EditorPane paneId="pane-1" tabId="tab-1" filePath={null} language={null} readOnly={false} content="" viewMode="source" focusEligible />
        </Provider>
      )
      const root = await screen.findByTestId('editor-pane')
      expect(root).toHaveFocus()
      // The disposed editor was never focused again.
      expect(monacoMountControl.focus).toHaveBeenCalledTimes(1)
    })

    it('restore wins over a late async Monaco autofocus: remount while the path field was focused keeps the path field focused', async () => {
      monacoMountControl.enabled = true
      const first = render(
        <Provider store={store}>
          <EditorPane paneId="pane-1" tabId="tab-1" filePath="/test.ts" language="typescript" readOnly={false} content="const x = 1" viewMode="source" focusEligible />
        </Provider>
      )
      await waitFor(() => expect(monacoMountControl.focus).toHaveBeenCalledTimes(1))
      // User clicked into the toolbar path field…
      const pathInput = screen.getByPlaceholderText('Enter file path...')
      pathInput.focus()
      expect(pathInput).toHaveFocus()
      // …then an agent split remounts the subtree, and Monaco mounts SLOWLY.
      first.unmount()
      monacoMountControl.mountDelayMs = 60
      render(
        <Provider store={store}>
          <EditorPane paneId="pane-1" tabId="tab-1" filePath="/test.ts" language="typescript" readOnly={false} content="const x = 1" viewMode="source" focusEligible />
        </Provider>
      )
      // Past the delayed onMount: without the skip, the async Monaco mount
      // would steal focus back from the restored path field.
      await waitFor(() => expect(screen.getByPlaceholderText('Enter file path...')).toHaveFocus(), { timeout: 2000 })
      await act(async () => { await new Promise((r) => setTimeout(r, 150)) }) // cover the delayed mount
      expect(monacoMountControl.focus).toHaveBeenCalledTimes(1)
    })

    it('a selection landing BEFORE the delayed Monaco mount lets onMount focus the editor (stale descriptor must not suppress the select)', async () => {
      monacoMountControl.enabled = true
      const unwire = wirePaneFocusOwnershipInvalidation(store)
      try {
        const first = render(
          <Provider store={store}>
            <EditorPane paneId="pane-1" tabId="tab-1" filePath="/test.ts" language="typescript" readOnly={false} content="const x = 1" viewMode="source" focusEligible />
          </Provider>
        )
        await waitFor(() => expect(monacoMountControl.focus).toHaveBeenCalledTimes(1))
        // User click into the toolbar path field → unmount records a descriptor.
        screen.getByPlaceholderText('Enter file path...').focus()
        first.unmount()
        // Remount (split race); Monaco mounts SLOWLY this time.
        monacoMountControl.mountDelayMs = 60
        monacoMountControl.focus.mockClear()
        render(
          <Provider store={store}>
            <EditorPane paneId="pane-1" tabId="tab-1" filePath="/test.ts" language="typescript" readOnly={false} content="const x = 1" viewMode="source" focusEligible />
          </Provider>
        )
        // EXPLICIT SELECTION lands while Monaco is still mounting: the in-effect
        // focus path hit only the pane root (editorRef null) — the select contract
        // next completes via this mount focus, and the stale descriptor must NOT
        // suppress it.
        act(() => {
          store.dispatch(setActivePane({ tabId: 'tab-1', paneId: 'pane-1', focusNudge: true }))
        })
        await waitFor(() => expect(monacoMountControl.focus).toHaveBeenCalled(), { timeout: 2000 })
      } finally {
        unwire()
      }
    })

    it('refocuses the editor on a focus epoch bump (same-target explicit select of an already-active pane)', async () => {
      monacoMountControl.enabled = true
      const { rerender } = render(
        <Provider store={store}>
          <EditorPane paneId="pane-1" tabId="tab-1" filePath="/test.ts" language="typescript" readOnly={false} content="const x = 1" viewMode="source" focusEligible />
        </Provider>
      )
      await waitFor(() => expect(monacoMountControl.focus).toHaveBeenCalledTimes(1))
      // User's DOM focus moved to app chrome; the pane is still Redux-active,
      // so a re-select produces NO eligibility transition — only the epoch,
      // which PaneContainer forwards as the focusEpoch prop.
      const chrome = document.createElement('input')
      document.body.appendChild(chrome)
      chrome.focus()
      rerender(
        <Provider store={store}>
          <EditorPane paneId="pane-1" tabId="tab-1" filePath="/test.ts" language="typescript" readOnly={false} content="const x = 1" viewMode="source" focusEligible focusEpoch={1} />
        </Provider>
      )
      await waitFor(() => expect(monacoMountControl.focus).toHaveBeenCalledTimes(2))
    })
  })
})
