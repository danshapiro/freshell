import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import ExtensionPane from '@/components/panes/ExtensionPane'
import { resetEnsureExtensionsRegistryCacheForTests } from '@/hooks/useEnsureExtensionsRegistry'
import extensionsReducer, { updateServerStatus } from '@/store/extensionsSlice'
import type { ClientExtensionEntry } from '@shared/extension-types'
import type { ExtensionPaneContent } from '@/store/paneTypes'

// Mock the api module for port forwarding tests
const mockApiGet = vi.fn()
const mockApiPost = vi.fn()
const mockApiDelete = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
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
  beforeEach(() => {
    vi.clearAllMocks()
    resetEnsureExtensionsRegistryCacheForTests()
    localStorage.clear()
    localStorage.setItem('freshell.auth-token', 'test-token')
  })

  afterEach(() => {
    resetEnsureExtensionsRegistryCacheForTests()
  })

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
    expect(iframe.src).toContain('/api/proxy/http/4500/dashboard/overview')
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

  it('hydrates the extension registry on demand when the active pane entry is missing', async () => {
    const ext: ClientExtensionEntry = {
      name: 'notes-widget',
      version: '0.1.0',
      label: 'Notes Widget',
      description: 'A notes widget',
      category: 'client',
      url: '/index.html',
    }
    mockApiGet.mockResolvedValue([ext])

    const content: ExtensionPaneContent = {
      kind: 'extension',
      extensionName: 'notes-widget',
      props: {},
    }

    renderWithStore(
      <ExtensionPane tabId="tab-1" paneId="pane-1" content={content} />,
      [],
    )

    await waitFor(() => {
      expect(mockApiGet).toHaveBeenCalledWith(expect.stringContaining('/api/extensions'))
    })

    const iframe = await screen.findByTitle('Notes Widget')
    expect(iframe).toBeInTheDocument()
    expect((iframe as HTMLIFrameElement).src).toContain('/api/extensions/notes-widget/client/index.html')
  })

  it('does not hydrate the extension registry without an auth token', async () => {
    localStorage.removeItem('freshell.auth-token')
    mockApiGet.mockResolvedValue([
      {
        name: 'notes-widget',
        version: '0.1.0',
        label: 'Notes Widget',
        description: 'A notes widget',
        category: 'client',
        url: '/index.html',
      } satisfies ClientExtensionEntry,
    ])

    const content: ExtensionPaneContent = {
      kind: 'extension',
      extensionName: 'notes-widget',
      props: {},
    }

    renderWithStore(
      <ExtensionPane tabId="tab-1" paneId="pane-1" content={content} />,
      [],
    )

    await Promise.resolve()

    expect(mockApiGet).not.toHaveBeenCalled()
    expect(screen.getByText('Extension not available')).toBeInTheDocument()
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
    expect(iframe.src).toContain('/api/proxy/http/9000/page/reports/item/42')
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
    expect(iframe.src).toContain('/api/proxy/http/3000/path//end')
  })

  describe('auto-start server extensions', () => {
    beforeEach(() => {
      mockApiGet.mockReset()
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
        expect(iframe.src).toContain('/api/proxy/http/5000/dashboard')
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
        expect(iframe.src).toContain('/api/proxy/http/7777/app')
      })
    })
  })

  it('uses proxy path for server extensions regardless of remote access', () => {
    // Even when accessing remotely, server extensions use the proxy path
    mockIsLoopback.mockReturnValue(false)

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

    const iframe = screen.getByTitle('Remote Ext') as HTMLIFrameElement
    expect(iframe.src).toContain('/api/proxy/http/5000/app')

    mockIsLoopback.mockReturnValue(true)
  })

  describe('iframe load error detection', () => {
    it('shows error overlay when iframe fires error event', async () => {
      const ext: ClientExtensionEntry = {
        name: 'err-ext',
        version: '1.0.0',
        label: 'Err Ext',
        description: 'Error test',
        category: 'client',
        url: '/index.html',
      }

      const content: ExtensionPaneContent = {
        kind: 'extension',
        extensionName: 'err-ext',
        props: {},
      }

      renderWithStore(
        <ExtensionPane tabId="tab-1" paneId="pane-1" content={content} />,
        [ext],
      )

      const iframe = screen.getByTitle('Err Ext') as HTMLIFrameElement
      iframe.dispatchEvent(new Event('error'))

      await waitFor(() => {
        expect(screen.getByText('Extension not available')).toBeInTheDocument()
        expect(screen.getByText(/failed to load/i)).toBeInTheDocument()
      })
    })

    it('shows error with response details when iframe loads an error page', async () => {
      const ext: ClientExtensionEntry = {
        name: 'http-err-ext',
        version: '1.0.0',
        label: 'HTTP Err Ext',
        description: 'HTTP error test',
        category: 'server',
        url: '/app',
        serverRunning: true,
        serverPort: 5000,
      }

      const content: ExtensionPaneContent = {
        kind: 'extension',
        extensionName: 'http-err-ext',
        props: {},
      }

      renderWithStore(
        <ExtensionPane tabId="tab-1" paneId="pane-1" content={content} />,
        [ext],
      )

      const iframe = screen.getByTitle('HTTP Err Ext') as HTMLIFrameElement

      // Simulate an iframe that loaded an error JSON response
      Object.defineProperty(iframe, 'contentDocument', {
        value: {
          body: {
            textContent: '{"error":"Failed to connect to localhost:5000"}',
          },
        },
        configurable: true,
      })
      iframe.dispatchEvent(new Event('load'))

      await waitFor(() => {
        expect(screen.getByText('Extension not available')).toBeInTheDocument()
        expect(screen.getByText(/Failed to connect/i)).toBeInTheDocument()
      })
    })

    it('does not show error when iframe loads valid content', async () => {
      const ext: ClientExtensionEntry = {
        name: 'ok-ext',
        version: '1.0.0',
        label: 'OK Ext',
        description: 'Success test',
        category: 'client',
        url: '/index.html',
      }

      const content: ExtensionPaneContent = {
        kind: 'extension',
        extensionName: 'ok-ext',
        props: {},
      }

      renderWithStore(
        <ExtensionPane tabId="tab-1" paneId="pane-1" content={content} />,
        [ext],
      )

      const iframe = screen.getByTitle('OK Ext') as HTMLIFrameElement

      // Simulate normal page load with real HTML content
      Object.defineProperty(iframe, 'contentDocument', {
        value: {
          body: {
            textContent: 'Hello from extension - this is real content with enough text',
          },
        },
        configurable: true,
      })
      iframe.dispatchEvent(new Event('load'))

      // Should still show the iframe, not an error
      await waitFor(() => {
        expect(screen.getByTitle('OK Ext')).toBeInTheDocument()
      })
      expect(screen.queryByText('Extension not available')).not.toBeInTheDocument()
    })

    it('provides retry button on load error', async () => {
      const ext: ClientExtensionEntry = {
        name: 'retry-load',
        version: '1.0.0',
        label: 'Retry Load',
        description: 'Retry test',
        category: 'client',
        url: '/index.html',
      }

      const content: ExtensionPaneContent = {
        kind: 'extension',
        extensionName: 'retry-load',
        props: {},
      }

      renderWithStore(
        <ExtensionPane tabId="tab-1" paneId="pane-1" content={content} />,
        [ext],
      )

      const iframe = screen.getByTitle('Retry Load') as HTMLIFrameElement
      iframe.dispatchEvent(new Event('error'))

      await waitFor(() => {
        expect(screen.getByText('Retry')).toBeInTheDocument()
      })
    })
  })
})
