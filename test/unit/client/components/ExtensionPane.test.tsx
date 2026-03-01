import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import ExtensionPane from '@/components/panes/ExtensionPane'
import extensionsReducer from '@/store/extensionsSlice'
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

  it('shows error when server extension is not running', () => {
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

    expect(screen.getByText('Extension not available')).toBeInTheDocument()
    expect(
      screen.getByText('Server extension "Stopped Ext" is not running.'),
    ).toBeInTheDocument()
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
