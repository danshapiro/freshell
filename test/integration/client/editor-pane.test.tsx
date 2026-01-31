import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import panesReducer, { initLayout } from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import PaneLayout from '@/components/panes/PaneLayout'

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

// Mock ws-client to avoid WebSocket connections
const mockSend = vi.fn()
vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockSend,
  }),
}))

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  X: ({ className }: { className?: string }) => (
    <svg data-testid="x-icon" className={className} />
  ),
  Plus: ({ className }: { className?: string }) => (
    <svg data-testid="plus-icon" className={className} />
  ),
  Globe: ({ className }: { className?: string }) => (
    <svg data-testid="globe-icon" className={className} />
  ),
  Terminal: ({ className }: { className?: string }) => (
    <svg data-testid="terminal-icon" className={className} />
  ),
  FileText: ({ className }: { className?: string }) => (
    <svg data-testid="file-text-icon" className={className} />
  ),
  FolderOpen: ({ className }: { className?: string }) => (
    <svg data-testid="folder-open-icon" className={className} />
  ),
  Eye: ({ className }: { className?: string }) => (
    <svg data-testid="eye-icon" className={className} />
  ),
  Code: ({ className }: { className?: string }) => (
    <svg data-testid="code-icon" className={className} />
  ),
  Circle: ({ className }: { className?: string }) => (
    <svg data-testid="circle-icon" className={className} />
  ),
  SplitSquareHorizontal: ({ className }: { className?: string }) => (
    <svg data-testid="split-h-icon" className={className} />
  ),
  SplitSquareVertical: ({ className }: { className?: string }) => (
    <svg data-testid="split-v-icon" className={className} />
  ),
  Maximize2: ({ className }: { className?: string }) => (
    <svg data-testid="maximize-icon" className={className} />
  ),
  Minimize2: ({ className }: { className?: string }) => (
    <svg data-testid="minimize-icon" className={className} />
  ),
}))

// Mock TerminalView component to avoid xterm.js dependencies
vi.mock('@/components/TerminalView', () => ({
  default: ({ tabId, paneId }: { tabId: string; paneId: string }) => (
    <div data-testid={`terminal-${paneId}`}>Terminal for {tabId}/{paneId}</div>
  ),
}))

// Mock BrowserPane component
vi.mock('@/components/panes/BrowserPane', () => ({
  default: ({ paneId, url }: { paneId: string; url: string }) => (
    <div data-testid={`browser-${paneId}`}>Browser: {url}</div>
  ),
}))

// Helper to create a proper mock response for the api module (which uses res.text())
const createMockResponse = (data: unknown, ok = true, statusText = 'OK') => ({
  ok,
  statusText,
  text: async () => JSON.stringify(data),
})

const mockFetch = vi.fn()

const createTestStore = () =>
  configureStore({
    reducer: {
      panes: panesReducer,
      settings: settingsReducer,
    },
  })

describe('Editor Pane Integration', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    store = createTestStore()
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
    mockSend.mockReset()
    sessionStorage.clear()

    // Default mock for all endpoints
    mockFetch.mockImplementation(async (url: RequestInfo | URL) => {
      const urlStr = url.toString()
      if (urlStr === '/api/terminals') {
        return createMockResponse([])
      }
      if (urlStr.startsWith('/api/files/complete')) {
        return createMockResponse({ suggestions: [] })
      }
      return createMockResponse({}, false, 'Not Found')
    })

    // Mock getBoundingClientRect for split direction calculation
    Element.prototype.getBoundingClientRect = vi.fn(() => ({
      width: 1000,
      height: 600,
      top: 0,
      left: 0,
      right: 1000,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => {},
    }))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('can add editor pane via FAB', async () => {
    const user = userEvent.setup()

    // Initialize with terminal
    store.dispatch(
      initLayout({
        tabId: 'tab-1',
        content: { kind: 'terminal', mode: 'shell' },
      })
    )

    render(
      <Provider store={store}>
        <PaneLayout
          tabId="tab-1"
          defaultContent={{ kind: 'terminal', mode: 'shell' }}
        />
      </Provider>
    )

    // Open FAB menu
    await user.click(screen.getByRole('button', { name: /add pane/i }))

    // Click Editor option
    await user.click(screen.getByRole('menuitem', { name: /editor/i }))

    // Should see empty state with Open File button(s) - there may be multiple (toolbar + empty state)
    await waitFor(() => {
      const openFileButtons = screen.getAllByRole('button', { name: /open file/i })
      expect(openFileButtons.length).toBeGreaterThanOrEqual(1)
    })

    // Verify the pane was added to the store
    const state = store.getState().panes
    expect(state.layouts['tab-1'].type).toBe('split')
  })

  it('displays editor toolbar with path input', async () => {
    const user = userEvent.setup()

    store.dispatch(
      initLayout({
        tabId: 'tab-1',
        content: { kind: 'terminal', mode: 'shell' },
      })
    )

    render(
      <Provider store={store}>
        <PaneLayout
          tabId="tab-1"
          defaultContent={{ kind: 'terminal', mode: 'shell' }}
        />
      </Provider>
    )

    // Add editor pane
    await user.click(screen.getByRole('button', { name: /add pane/i }))
    await user.click(screen.getByRole('menuitem', { name: /editor/i }))

    // Should see the path input
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/enter file path/i)).toBeInTheDocument()
    })
  })

  it('loads file when path is entered', async () => {
    const user = userEvent.setup()
    sessionStorage.setItem('auth-token', 'test-token')

    mockFetch.mockImplementation(async (url: RequestInfo | URL) => {
      const urlStr = url.toString()
      if (urlStr === '/api/terminals') {
        return createMockResponse([])
      }
      if (urlStr.startsWith('/api/files/read')) {
        return createMockResponse({
          content: '# Hello',
          size: 7,
          modifiedAt: new Date().toISOString(),
        })
      }
      if (urlStr.startsWith('/api/files/complete')) {
        return createMockResponse({ suggestions: [] })
      }
      return createMockResponse({}, false, 'Not Found')
    })

    store.dispatch(
      initLayout({
        tabId: 'tab-1',
        content: {
          kind: 'editor',
          filePath: null,
          language: null,
          readOnly: false,
          content: '',
          viewMode: 'source',
        },
      })
    )

    render(
      <Provider store={store}>
        <PaneLayout
          tabId="tab-1"
          defaultContent={{ kind: 'terminal', mode: 'shell' }}
        />
      </Provider>
    )

    const input = screen.getByPlaceholderText(/enter file path/i)
    await user.clear(input)
    await user.type(input, '/test.md{Enter}')

    await waitFor(() => {
      const calls = mockFetch.mock.calls
      const fileReadCall = calls.find((c: any) => c[0].toString().startsWith('/api/files/read'))
      expect(fileReadCall).toBeTruthy()
    })

    // Verify the auth token was sent (Headers object is used by the api module)
    const calls = mockFetch.mock.calls
    const fileReadCall = calls.find((c: any) => c[0].toString().includes('/api/files/read'))
    expect(fileReadCall).toBeTruthy()
    const headers = fileReadCall![1].headers as Headers
    expect(headers.get('x-auth-token')).toBe('test-token')
  })

  it('shows Monaco editor when content is loaded', async () => {
    const user = userEvent.setup()
    sessionStorage.setItem('auth-token', 'test-token')

    mockFetch.mockImplementation(async (url: RequestInfo | URL) => {
      const urlStr = url.toString()
      if (urlStr === '/api/terminals') {
        return createMockResponse([])
      }
      if (urlStr.startsWith('/api/files/read')) {
        return createMockResponse({
          content: 'const x = 1',
          size: 11,
          modifiedAt: new Date().toISOString(),
        })
      }
      if (urlStr.startsWith('/api/files/complete')) {
        return createMockResponse({ suggestions: [] })
      }
      return createMockResponse({}, false, 'Not Found')
    })

    store.dispatch(
      initLayout({
        tabId: 'tab-1',
        content: {
          kind: 'editor',
          filePath: null,
          language: null,
          readOnly: false,
          content: '',
          viewMode: 'source',
        },
      })
    )

    render(
      <Provider store={store}>
        <PaneLayout
          tabId="tab-1"
          defaultContent={{ kind: 'terminal', mode: 'shell' }}
        />
      </Provider>
    )

    const input = screen.getByPlaceholderText(/enter file path/i)
    await user.clear(input)
    await user.type(input, '/code.ts{Enter}')

    await waitFor(() => {
      const calls = mockFetch.mock.calls
      const fileReadCall = calls.find((c: any) => c[0].toString().startsWith('/api/files/read'))
      expect(fileReadCall).toBeTruthy()
    })

    // Wait for content to be loaded and Monaco editor to appear
    await waitFor(() => {
      expect(screen.getByTestId('monaco-mock')).toBeInTheDocument()
    })
  })

  it('shows view toggle for markdown files after loading', async () => {
    const user = userEvent.setup()
    sessionStorage.setItem('auth-token', 'test-token')

    mockFetch.mockImplementation(async (url: RequestInfo | URL) => {
      const urlStr = url.toString()
      if (urlStr === '/api/terminals') {
        return createMockResponse([])
      }
      if (urlStr.startsWith('/api/files/read')) {
        return createMockResponse({
          content: '# Hello World',
          size: 13,
          modifiedAt: new Date().toISOString(),
        })
      }
      if (urlStr.startsWith('/api/files/complete')) {
        return createMockResponse({ suggestions: [] })
      }
      return createMockResponse({}, false, 'Not Found')
    })

    store.dispatch(
      initLayout({
        tabId: 'tab-1',
        content: {
          kind: 'editor',
          filePath: null,
          language: null,
          readOnly: false,
          content: '',
          viewMode: 'source',
        },
      })
    )

    render(
      <Provider store={store}>
        <PaneLayout
          tabId="tab-1"
          defaultContent={{ kind: 'terminal', mode: 'shell' }}
        />
      </Provider>
    )

    const input = screen.getByPlaceholderText(/enter file path/i)
    await user.clear(input)
    await user.type(input, '/readme.md{Enter}')

    await waitFor(() => {
      const calls = mockFetch.mock.calls
      const fileReadCall = calls.find((c: any) => c[0].toString().startsWith('/api/files/read'))
      expect(fileReadCall).toBeTruthy()
    })

    // Markdown files should show the preview toggle (Source button when in preview mode)
    // Since markdown defaults to preview mode, look for Source button
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /source/i })).toBeInTheDocument()
    })
  })

  it('can toggle between source and preview modes', async () => {
    const user = userEvent.setup()
    sessionStorage.setItem('auth-token', 'test-token')

    mockFetch.mockImplementation(async (url: RequestInfo | URL) => {
      const urlStr = url.toString()
      if (urlStr === '/api/terminals') {
        return createMockResponse([])
      }
      if (urlStr.startsWith('/api/files/read')) {
        return createMockResponse({
          content: '# Hello World',
          size: 13,
          modifiedAt: new Date().toISOString(),
        })
      }
      if (urlStr.startsWith('/api/files/complete')) {
        return createMockResponse({ suggestions: [] })
      }
      return createMockResponse({}, false, 'Not Found')
    })

    store.dispatch(
      initLayout({
        tabId: 'tab-1',
        content: {
          kind: 'editor',
          filePath: null,
          language: null,
          readOnly: false,
          content: '',
          viewMode: 'source',
        },
      })
    )

    render(
      <Provider store={store}>
        <PaneLayout
          tabId="tab-1"
          defaultContent={{ kind: 'terminal', mode: 'shell' }}
        />
      </Provider>
    )

    const input = screen.getByPlaceholderText(/enter file path/i)
    await user.clear(input)
    await user.type(input, '/readme.md{Enter}')

    await waitFor(() => {
      const calls = mockFetch.mock.calls
      const fileReadCall = calls.find((c: any) => c[0].toString().startsWith('/api/files/read'))
      expect(fileReadCall).toBeTruthy()
    })

    // Should be in preview mode by default for markdown
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /source/i })).toBeInTheDocument()
    })

    // Toggle to source mode
    await user.click(screen.getByRole('button', { name: /source/i }))

    // Should now show Preview button
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /preview/i })).toBeInTheDocument()
    })

    // Should show Monaco editor in source mode
    expect(screen.getByTestId('monaco-mock')).toBeInTheDocument()
  })

  it('maintains editor state when splitting panes', async () => {
    const user = userEvent.setup()

    // Start with an editor pane containing content
    store.dispatch(
      initLayout({
        tabId: 'tab-1',
        content: {
          kind: 'editor',
          filePath: '/test.ts',
          language: 'typescript',
          readOnly: false,
          content: 'const x = 42',
          viewMode: 'source',
        },
      })
    )

    render(
      <Provider store={store}>
        <PaneLayout
          tabId="tab-1"
          defaultContent={{ kind: 'terminal', mode: 'shell' }}
        />
      </Provider>
    )

    // Editor should show with content
    await waitFor(() => {
      expect(screen.getByTestId('monaco-mock')).toHaveValue('const x = 42')
    })

    // Add another pane via FAB
    await user.click(screen.getByRole('button', { name: /add pane/i }))
    await user.click(screen.getByRole('menuitem', { name: /terminal/i }))

    // Original editor content should still be present
    expect(screen.getByTestId('monaco-mock')).toHaveValue('const x = 42')

    // Should also have a terminal pane
    await waitFor(() => {
      const state = store.getState().panes
      expect(state.layouts['tab-1'].type).toBe('split')
    })
  })

  it('handles file load error gracefully', async () => {
    const user = userEvent.setup()
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    mockFetch.mockImplementation(async (url: RequestInfo | URL) => {
      const urlStr = url.toString()
      if (urlStr === '/api/terminals') {
        return createMockResponse([])
      }
      if (urlStr.startsWith('/api/files/read')) {
        return createMockResponse({ error: 'Not Found' }, false, 'Not Found')
      }
      if (urlStr.startsWith('/api/files/complete')) {
        return createMockResponse({ suggestions: [] })
      }
      return createMockResponse({}, false, 'Not Found')
    })

    store.dispatch(
      initLayout({
        tabId: 'tab-1',
        content: {
          kind: 'editor',
          filePath: null,
          language: null,
          readOnly: false,
          content: '',
          viewMode: 'source',
        },
      })
    )

    render(
      <Provider store={store}>
        <PaneLayout
          tabId="tab-1"
          defaultContent={{ kind: 'terminal', mode: 'shell' }}
        />
      </Provider>
    )

    const input = screen.getByPlaceholderText(/enter file path/i)
    await user.clear(input)
    await user.type(input, '/nonexistent.ts{Enter}')

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('editor_file_load_failed')
      )
    })

    // Should still show empty state (Open File button) - we may have multiple buttons
    const openFileButtons = screen.getAllByRole('button', { name: /open file/i })
    expect(openFileButtons.length).toBeGreaterThanOrEqual(1)

    consoleSpy.mockRestore()
  })

  it('integrates with terminal and editor panes in split view', async () => {
    const user = userEvent.setup()

    // Start with a terminal
    store.dispatch(
      initLayout({
        tabId: 'tab-1',
        content: { kind: 'terminal', mode: 'shell' },
      })
    )

    render(
      <Provider store={store}>
        <PaneLayout
          tabId="tab-1"
          defaultContent={{ kind: 'terminal', mode: 'shell' }}
        />
      </Provider>
    )

    // Verify terminal is rendered
    await waitFor(() => {
      const state = store.getState().panes
      const layout = state.layouts['tab-1']
      if (layout.type === 'leaf') {
        expect(screen.getByTestId(`terminal-${layout.id}`)).toBeInTheDocument()
      }
    })

    // Add an editor pane
    await user.click(screen.getByRole('button', { name: /add pane/i }))
    await user.click(screen.getByRole('menuitem', { name: /editor/i }))

    // Both terminal and editor should be visible
    await waitFor(() => {
      // Editor's empty state - may have multiple buttons
      const openFileButtons = screen.getAllByRole('button', { name: /open file/i })
      expect(openFileButtons.length).toBeGreaterThanOrEqual(1)
    })

    // Verify store has split layout with both pane types
    const state = store.getState().panes
    expect(state.layouts['tab-1'].type).toBe('split')

    const layout = state.layouts['tab-1']
    if (layout.type === 'split') {
      const child1 = layout.children[0]
      const child2 = layout.children[1]

      if (child1.type === 'leaf' && child2.type === 'leaf') {
        const kinds = [child1.content.kind, child2.content.kind]
        expect(kinds).toContain('terminal')
        expect(kinds).toContain('editor')
      }
    }
  })
})
