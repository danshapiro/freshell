import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import ExtensionPane from '@/components/panes/ExtensionPane'
import extensionsReducer, { updateServerStatus } from '@/store/extensionsSlice'
import type { ClientExtensionEntry } from '@shared/extension-types'
import type { ExtensionPaneContent } from '@/store/paneTypes'

// Mock the api module for port forwarding tests
const mockApiPost = vi.fn()
const mockApiDelete = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    post: (...args: unknown[]) => mockApiPost(...args),
    delete: (...args: unknown[]) => mockApiDelete(...args),
  },
}))

// Mock isLoopbackHostname to simulate remote access
const mockIsLoopback = vi.fn(() => true) // Default: localhost (local access)
vi.mock('@/lib/url-rewrite', () => ({
  isLoopbackHostname: (...args: unknown[]) => mockIsLoopback(...args),
}))

function createStore(entries: ClientExtensionEntry[] = []) {
  return configureStore({
    reducer: {
      extensions: extensionsReducer,
    },
    preloadedState: {
      extensions: { entries },
    },
  })
}

function renderWithStore(
  ui: React.ReactElement,
  entries: ClientExtensionEntry[] = [],
) {
  const store = createStore(entries)
  return render(<Provider store={store}>{ui}</Provider>)
}

afterEach(cleanup)

describe('ExtensionPane', () => {
  it('renders iframe with correct URL for a server extension', () => {
    const ext: ClientExtensionEntry = {
      name: 'my-dashboard',
      version: '1.0.0',
      label: 'My Dashboard',
      description: 'A dashboard extension',
      category: 'server',
      url: '/dashboard/{{view}}',
      serverRunning: true,
      serverPort: 4500,
    }

    const content: ExtensionPaneContent = {
      kind: 'extension',
      extensionName: 'my-dashboard',
      props: { view: 'overview' },
    }

    renderWithStore(
      <ExtensionPane tabId="tab-1" paneId="pane-1" content={content} />,
      [ext],
    )

    const iframe = screen.getByTitle('My Dashboard') as HTMLIFrameElement
    expect(iframe.tagName).toBe('IFRAME')
    expect(iframe.src).toBe('http://localhost:4500/dashboard/overview')
  })

  it('renders iframe with correct URL for a client extension', () => {
    const ext: ClientExtensionEntry = {
      name: 'notes-widget',
      version: '0.1.0',
      label: 'Notes Widget',
      description: 'A notes widget',
      category: 'client',
      url: '/index.html',
    }

    const content: ExtensionPaneContent = {
      kind: 'extension',
      extensionName: 'notes-widget',
      props: {},
    }

    renderWithStore(
      <ExtensionPane tabId="tab-1" paneId="pane-1" content={content} />,
      [ext],
    )

    const iframe = screen.getByTitle('Notes Widget') as HTMLIFrameElement
    expect(iframe.tagName).toBe('IFRAME')
    expect(iframe.src).toContain('/api/extensions/notes-widget/client/index.html')
  })

  it('shows error when extension not found in registry', () => {
    const content: ExtensionPaneContent = {
      kind: 'extension',
      extensionName: 'nonexistent-ext',
      props: {},
    }

    renderWithStore(
      <ExtensionPane tabId="tab-1" paneId="pane-1" content={content} />,
      [],
    )

    expect(screen.getByText('Extension not available')).toBeInTheDocument()
    expect(
      screen.getByText('Extension "nonexistent-ext" is not installed or failed to load.'),
    ).toBeInTheDocument()
  })

  it('renders iframe with correct sandbox attributes', () => {
    const ext: ClientExtensionEntry = {
      name: 'sandbox-test',
      version: '1.0.0',
      label: 'Sandbox Test',
      description: 'Testing sandbox',
      category: 'client',
      url: '/app.html',
    }

    const content: ExtensionPaneContent = {
      kind: 'extension',
      extensionName: 'sandbox-test',
      props: {},
    }

    renderWithStore(
      <ExtensionPane tabId="tab-1" paneId="pane-1" content={content} />,
      [ext],
    )

    const iframe = screen.getByTitle('Sandbox Test') as HTMLIFrameElement
    expect(iframe.getAttribute('sandbox')).toBe(
      'allow-scripts allow-same-origin allow-forms allow-popups',
    )
  })

  it('interpolates URL template variables from content.props', () => {
    const ext: ClientExtensionEntry = {
      name: 'multi-var',
      version: '1.0.0',
      label: 'Multi Var',
      description: 'Interpolation test',
      category: 'server',
      url: '/page/{{section}}/item/{{itemId}}',
      serverRunning: true,
      serverPort: 9000,
    }

    const content: ExtensionPaneContent = {
      kind: 'extension',
      extensionName: 'multi-var',
      props: { section: 'reports', itemId: '42' },
    }

    renderWithStore(
      <ExtensionPane tabId="tab-1" paneId="pane-1" content={content} />,
      [ext],
    )

    const iframe = screen.getByTitle('Multi Var') as HTMLIFrameElement
    expect(iframe.src).toBe('http://localhost:9000/page/reports/item/42')
  })

  it('shows loading state when server extension is not running (auto-start)', () => {
    mockApiPost.mockReturnValue(new Promise(() => {}))

    const ext: ClientExtensionEntry = {
      name: 'stopped-ext',
      version: '1.0.0',
      label: 'Stopped Ext',
      description: 'Not running',
      category: 'server',
      url: '/app',
      serverRunning: false,
    }

    const content: ExtensionPaneContent = {
      kind: 'extension',
      extensionName: 'stopped-ext',
      props: {},
    }

    renderWithStore(
      <ExtensionPane tabId="tab-1" paneId="pane-1" content={content} />,
      [ext],
    )

    expect(screen.getByText('Starting extension server...')).toBeInTheDocument()
  })

  it('replaces undefined template variables with empty string', () => {
    const ext: ClientExtensionEntry = {
      name: 'missing-var',
      version: '1.0.0',
      label: 'Missing Var',
      description: 'Missing var test',
      category: 'server',
      url: '/path/{{missing}}/end',
      serverRunning: true,
      serverPort: 3000,
    }

    const content: ExtensionPaneContent = {
      kind: 'extension',
      extensionName: 'missing-var',
      props: {},
    }

    renderWithStore(
      <ExtensionPane tabId="tab-1" paneId="pane-1" content={content} />,
      [ext],
    )

    const iframe = screen.getByTitle('Missing Var') as HTMLIFrameElement
    expect(iframe.src).toBe('http://localhost:3000/path//end')
  })

  describe('auto-start server extensions', () => {
    beforeEach(() => {
      mockApiPost.mockReset()
      mockApiDelete.mockReset()
      mockIsLoopback.mockReturnValue(true) // local access
    })

    afterEach(() => {
      mockIsLoopback.mockReturnValue(true)
    })

    it('calls POST /api/extensions/:name/start when server not running', () => {
      mockApiPost.mockReturnValue(new Promise(() => {}))

      const ext: ClientExtensionEntry = {
        name: 'my-server-ext',
        version: '1.0.0',
        label: 'My Server Ext',
        description: 'Auto-start test',
        category: 'server',
        url: '/app',
        serverRunning: false,
      }

      const content: ExtensionPaneContent = {
        kind: 'extension',
        extensionName: 'my-server-ext',
        props: {},
      }

      renderWithStore(
        <ExtensionPane tabId="tab-1" paneId="pane-1" content={content} />,
        [ext],
      )

      expect(mockApiPost).toHaveBeenCalledWith(
        '/api/extensions/my-server-ext/start',
        {},
      )
    })

    it('does not call start when server already running', () => {
      const ext: ClientExtensionEntry = {
        name: 'running-ext',
        version: '1.0.0',
        label: 'Running Ext',
        description: 'Already running',
        category: 'server',
        url: '/app',
        serverRunning: true,
        serverPort: 5000,
      }

      const content: ExtensionPaneContent = {
        kind: 'extension',
        extensionName: 'running-ext',
        props: {},
      }

      renderWithStore(
        <ExtensionPane tabId="tab-1" paneId="pane-1" content={content} />,
        [ext],
      )

      // Should not have called start endpoint (may call port forwarding, but not start)
      expect(mockApiPost).not.toHaveBeenCalledWith(
        expect.stringContaining('/start'),
        expect.anything(),
      )
    })

    it('shows error with retry button on start failure', async () => {
      mockApiPost.mockRejectedValue(new Error('spawn ENOENT'))

      const ext: ClientExtensionEntry = {
        name: 'fail-ext',
        version: '1.0.0',
        label: 'Fail Ext',
        description: 'Fails to start',
        category: 'server',
        url: '/app',
        serverRunning: false,
      }

      const content: ExtensionPaneContent = {
        kind: 'extension',
        extensionName: 'fail-ext',
        props: {},
      }

      renderWithStore(
        <ExtensionPane tabId="tab-1" paneId="pane-1" content={content} />,
        [ext],
      )

      await waitFor(() => {
        expect(screen.getByText(/Failed to start "Fail Ext"/)).toBeInTheDocument()
        expect(screen.getByText(/spawn ENOENT/)).toBeInTheDocument()
      })

      expect(screen.getByText('Retry')).toBeInTheDocument()
    })

    it('retries auto-start when Retry button is clicked', async () => {
      const user = userEvent.setup()
      // First call rejects, second call stays pending (simulating retry in progress)
      mockApiPost
        .mockRejectedValueOnce(new Error('spawn ENOENT'))
        .mockReturnValueOnce(new Promise(() => {}))

      const ext: ClientExtensionEntry = {
        name: 'retry-ext',
        version: '1.0.0',
        label: 'Retry Ext',
        description: 'Retry test',
        category: 'server',
        url: '/app',
        serverRunning: false,
      }

      const content: ExtensionPaneContent = {
        kind: 'extension',
        extensionName: 'retry-ext',
        props: {},
      }

      renderWithStore(
        <ExtensionPane tabId="tab-1" paneId="pane-1" content={content} />,
        [ext],
      )

      // Wait for error to appear
      await waitFor(() => {
        expect(screen.getByText('Retry')).toBeInTheDocument()
      })

      // Click retry
      await user.click(screen.getByText('Retry'))

      // Should have called start twice now
      expect(mockApiPost).toHaveBeenCalledTimes(2)
      expect(screen.getByText('Starting extension server...')).toBeInTheDocument()
    })

    it('transitions to iframe after Redux update (simulating WS broadcast)', async () => {
      mockApiPost.mockResolvedValue({ port: 5000 })

      const ext: ClientExtensionEntry = {
        name: 'transition-ext',
        version: '1.0.0',
        label: 'Transition Ext',
        description: 'Transition test',
        category: 'server',
        url: '/dashboard',
        serverRunning: false,
      }

      const content: ExtensionPaneContent = {
        kind: 'extension',
        extensionName: 'transition-ext',
        props: {},
      }

      const store = createStore([ext])
      render(
        <Provider store={store}>
          <ExtensionPane tabId="tab-1" paneId="pane-1" content={content} />
        </Provider>,
      )

      // Initially shows loading
      expect(screen.getByText('Starting extension server...')).toBeInTheDocument()

      // Simulate WS broadcast updating Redux
      store.dispatch(
        updateServerStatus({ name: 'transition-ext', serverRunning: true, serverPort: 5000 }),
      )

      await waitFor(() => {
        const iframe = screen.getByTitle('Transition Ext') as HTMLIFrameElement
        expect(iframe.tagName).toBe('IFRAME')
        expect(iframe.src).toBe('http://localhost:5000/dashboard')
      })
    })

    it('extracts message from ApiError objects (not Error instances)', async () => {
      // api.post throws ApiError objects: { status, message, details }
      mockApiPost.mockRejectedValue({ status: 500, message: 'Extension crashed on startup' })

      const ext: ClientExtensionEntry = {
        name: 'api-err-ext',
        version: '1.0.0',
        label: 'Api Err Ext',
        description: 'ApiError test',
        category: 'server',
        url: '/app',
        serverRunning: false,
      }

      const content: ExtensionPaneContent = {
        kind: 'extension',
        extensionName: 'api-err-ext',
        props: {},
      }

      renderWithStore(
        <ExtensionPane tabId="tab-1" paneId="pane-1" content={content} />,
        [ext],
      )

      await waitFor(() => {
        expect(screen.getByText(/Extension crashed on startup/)).toBeInTheDocument()
      })
      // Must NOT show [object Object]
      expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument()
    })

    it('falls back to API response when WS broadcast is missed', async () => {
      // API resolves with port, but no WS broadcast dispatches updateServerStatus
      mockApiPost.mockResolvedValue({ port: 7777 })

      const ext: ClientExtensionEntry = {
        name: 'fallback-ext',
        version: '1.0.0',
        label: 'Fallback Ext',
        description: 'Fallback test',
        category: 'server',
        url: '/app',
        serverRunning: false,
      }

      const content: ExtensionPaneContent = {
        kind: 'extension',
        extensionName: 'fallback-ext',
        props: {},
      }

      const store = createStore([ext])
      render(
        <Provider store={store}>
          <ExtensionPane tabId="tab-1" paneId="pane-1" content={content} />
        </Provider>,
      )

      // Without WS broadcast, the API response should still update Redux as fallback
      await waitFor(() => {
        const iframe = screen.getByTitle('Fallback Ext') as HTMLIFrameElement
        expect(iframe.tagName).toBe('IFRAME')
        expect(iframe.src).toBe('http://localhost:7777/app')
      })
    })
  })

  describe('remote access (port forwarding)', () => {
    beforeEach(() => {
      // Simulate remote access by returning false for isLoopbackHostname
      mockIsLoopback.mockReturnValue(false)
      mockApiPost.mockReset()
      mockApiDelete.mockReset()
      // Default: delete always resolves (cleanup should never throw)
      mockApiDelete.mockResolvedValue({ ok: true })
    })

    afterEach(() => {
      // Restore local access default
      mockIsLoopback.mockReturnValue(true)
    })

    it('shows loading state while port forwarding is in progress', () => {
      // Keep the promise pending (never resolves)
      mockApiPost.mockReturnValue(new Promise(() => {}))

      const ext: ClientExtensionEntry = {
        name: 'remote-ext',
        version: '1.0.0',
        label: 'Remote Ext',
        description: 'Remote test',
        category: 'server',
        url: '/app',
        serverRunning: true,
        serverPort: 5000,
      }

      const content: ExtensionPaneContent = {
        kind: 'extension',
        extensionName: 'remote-ext',
        props: {},
      }

      renderWithStore(
        <ExtensionPane tabId="tab-1" paneId="pane-1" content={content} />,
        [ext],
      )

      expect(screen.getByText('Connecting to extension server...')).toBeInTheDocument()
    })

    it('renders iframe with forwarded port on success', async () => {
      mockApiPost.mockResolvedValue({ forwardedPort: 54321 })

      const ext: ClientExtensionEntry = {
        name: 'remote-ok',
        version: '1.0.0',
        label: 'Remote OK',
        description: 'Forwarding success',
        category: 'server',
        url: '/dashboard',
        serverRunning: true,
        serverPort: 5000,
      }

      const content: ExtensionPaneContent = {
        kind: 'extension',
        extensionName: 'remote-ok',
        props: {},
      }

      renderWithStore(
        <ExtensionPane tabId="tab-1" paneId="pane-1" content={content} />,
        [ext],
      )

      await waitFor(() => {
        const iframe = screen.getByTitle('Remote OK') as HTMLIFrameElement
        // In jsdom, window.location.hostname is "localhost"
        expect(iframe.src).toBe('http://localhost:54321/dashboard')
      })

      expect(mockApiPost).toHaveBeenCalledWith('/api/proxy/forward', { port: 5000 })
    })

    it('shows error when port forwarding fails', async () => {
      mockApiPost.mockRejectedValue(new Error('Connection refused'))

      const ext: ClientExtensionEntry = {
        name: 'remote-fail',
        version: '1.0.0',
        label: 'Remote Fail',
        description: 'Forwarding failure',
        category: 'server',
        url: '/app',
        serverRunning: true,
        serverPort: 6000,
      }

      const content: ExtensionPaneContent = {
        kind: 'extension',
        extensionName: 'remote-fail',
        props: {},
      }

      renderWithStore(
        <ExtensionPane tabId="tab-1" paneId="pane-1" content={content} />,
        [ext],
      )

      await waitFor(() => {
        expect(screen.getByText('Extension not available')).toBeInTheDocument()
        expect(
          screen.getByText(/Failed to connect to extension server on port 6000/),
        ).toBeInTheDocument()
      })
    })

    it('calls delete on cleanup when unmounting', async () => {
      mockApiPost.mockResolvedValue({ forwardedPort: 54321 })
      mockApiDelete.mockResolvedValue({ ok: true })

      const ext: ClientExtensionEntry = {
        name: 'remote-cleanup',
        version: '1.0.0',
        label: 'Remote Cleanup',
        description: 'Cleanup test',
        category: 'server',
        url: '/app',
        serverRunning: true,
        serverPort: 7000,
      }

      const content: ExtensionPaneContent = {
        kind: 'extension',
        extensionName: 'remote-cleanup',
        props: {},
      }

      const { unmount } = renderWithStore(
        <ExtensionPane tabId="tab-1" paneId="pane-1" content={content} />,
        [ext],
      )

      // Wait for the forward to be established
      await waitFor(() => {
        expect(screen.getByTitle('Remote Cleanup')).toBeInTheDocument()
      })

      unmount()

      expect(mockApiDelete).toHaveBeenCalledWith('/api/proxy/forward/7000')
    })
  })
})
