import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import panesReducer from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import BrowserPane from '@/components/panes/BrowserPane'

// Mock clipboard
vi.mock('@/lib/clipboard', () => ({
  copyText: vi.fn(),
}))

// Mock pane-action-registry to avoid side effects
vi.mock('@/lib/pane-action-registry', () => ({
  registerBrowserActions: vi.fn(() => () => {}),
}))

// Mock API for port forwarding
vi.mock('@/lib/api', () => ({
  api: {
    post: vi.fn().mockResolvedValue({ forwardedPort: 45678 }),
    delete: vi.fn().mockResolvedValue({ ok: true }),
  },
}))

import { api } from '@/lib/api'

const createMockStore = () =>
  configureStore({
    reducer: {
      panes: panesReducer,
      settings: settingsReducer,
    },
  })

function renderBrowserPane(
  props: Partial<React.ComponentProps<typeof BrowserPane>> = {},
  store = createMockStore(),
) {
  const defaultProps = {
    paneId: 'pane-1',
    tabId: 'tab-1',
    url: '',
    devToolsOpen: false,
    ...props,
  }
  return {
    ...render(
      <Provider store={store}>
        <BrowserPane {...defaultProps} />
      </Provider>,
    ),
    store,
  }
}

describe('BrowserPane', () => {
  const originalLocation = window.location

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    // Restore original location
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
    cleanup()
  })

  function setWindowHostname(hostname: string) {
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, hostname },
      writable: true,
      configurable: true,
    })
  }

  describe('rendering', () => {
    it('renders URL input and navigation buttons', () => {
      renderBrowserPane()

      expect(screen.getByPlaceholderText('Enter URL...')).toBeInTheDocument()
      expect(screen.getByTitle('Back')).toBeInTheDocument()
      expect(screen.getByTitle('Forward')).toBeInTheDocument()
    })

    it('shows empty state when no URL is set', () => {
      renderBrowserPane({ url: '' })

      expect(screen.getByText('Enter a URL to browse')).toBeInTheDocument()
    })

    it('renders iframe when URL is provided', () => {
      renderBrowserPane({ url: 'https://example.com' })

      const iframe = document.querySelector('iframe')
      expect(iframe).toBeTruthy()
      expect(iframe!.getAttribute('src')).toBe('https://example.com')
    })

    it('shows dev tools panel when devToolsOpen is true', () => {
      renderBrowserPane({ url: 'https://example.com', devToolsOpen: true })

      expect(screen.getByText('Developer Tools')).toBeInTheDocument()
    })

    it('hides dev tools panel when devToolsOpen is false', () => {
      renderBrowserPane({ url: 'https://example.com', devToolsOpen: false })

      expect(screen.queryByText('Developer Tools')).not.toBeInTheDocument()
    })
  })

  describe('navigation', () => {
    it('navigates when Enter is pressed in URL input', () => {
      renderBrowserPane()

      const input = screen.getByPlaceholderText('Enter URL...')
      fireEvent.change(input, { target: { value: 'example.com' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      const iframe = document.querySelector('iframe')
      expect(iframe).toBeTruthy()
      // Should add https:// protocol
      expect(iframe!.getAttribute('src')).toBe('https://example.com')
    })

    it('preserves http:// protocol when specified', () => {
      setWindowHostname('localhost')
      renderBrowserPane()

      const input = screen.getByPlaceholderText('Enter URL...')
      fireEvent.change(input, { target: { value: 'http://localhost:3000' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      const iframe = document.querySelector('iframe')
      expect(iframe).toBeTruthy()
      expect(iframe!.getAttribute('src')).toContain('localhost:3000')
    })
  })

  describe('file:// URL handling', () => {
    it('converts file:// URLs to /local-file API endpoint', () => {
      renderBrowserPane({ url: 'file:///home/user/index.html' })

      const iframe = document.querySelector('iframe')
      expect(iframe).toBeTruthy()
      expect(iframe!.getAttribute('src')).toBe(
        '/local-file?path=' + encodeURIComponent('/home/user/index.html'),
      )
    })

    it('keeps Windows drive file URLs compatible with local-file path resolution', () => {
      renderBrowserPane({ url: 'file:///C:/Users/user/index.html' })

      const iframe = document.querySelector('iframe')
      expect(iframe).toBeTruthy()
      expect(iframe!.getAttribute('src')).toBe(
        '/local-file?path=' + encodeURIComponent('C:/Users/user/index.html'),
      )
    })

    it('maps non-localhost file URL hostnames to UNC-style paths', () => {
      renderBrowserPane({ url: 'file://server/share/index.html' })

      const iframe = document.querySelector('iframe')
      expect(iframe).toBeTruthy()
      expect(iframe!.getAttribute('src')).toBe(
        '/local-file?path=' + encodeURIComponent('//server/share/index.html'),
      )
    })
  })

  describe('port forwarding for remote access', () => {
    it('requests a port forward for localhost URLs when accessing remotely', async () => {
      setWindowHostname('192.168.1.100')
      vi.mocked(api.post).mockResolvedValue({ forwardedPort: 45678 })

      await act(async () => {
        renderBrowserPane({ url: 'http://localhost:3000' })
      })

      expect(api.post).toHaveBeenCalledWith('/api/proxy/forward', { port: 3000 })

      await waitFor(() => {
        const iframe = document.querySelector('iframe')
        expect(iframe).toBeTruthy()
        expect(iframe!.getAttribute('src')).toBe('http://192.168.1.100:45678/')
      })
    })

    it('requests a port forward for 127.0.0.1 URLs when accessing remotely', async () => {
      setWindowHostname('192.168.1.100')
      vi.mocked(api.post).mockResolvedValue({ forwardedPort: 45679 })

      await act(async () => {
        renderBrowserPane({ url: 'http://127.0.0.1:8080' })
      })

      expect(api.post).toHaveBeenCalledWith('/api/proxy/forward', { port: 8080 })

      await waitFor(() => {
        const iframe = document.querySelector('iframe')
        expect(iframe).toBeTruthy()
        expect(iframe!.getAttribute('src')).toBe('http://192.168.1.100:45679/')
      })
    })

    it('preserves path and query when port forwarding', async () => {
      setWindowHostname('10.0.0.5')
      vi.mocked(api.post).mockResolvedValue({ forwardedPort: 55555 })

      await act(async () => {
        renderBrowserPane({ url: 'http://localhost:3000/api/data?q=test' })
      })

      expect(api.post).toHaveBeenCalledWith('/api/proxy/forward', { port: 3000 })

      await waitFor(() => {
        const iframe = document.querySelector('iframe')
        expect(iframe).toBeTruthy()
        expect(iframe!.getAttribute('src')).toBe('http://10.0.0.5:55555/api/data?q=test')
      })
    })

    it('preserves https: protocol for forwarded https: localhost URLs', async () => {
      setWindowHostname('192.168.1.100')
      vi.mocked(api.post).mockResolvedValue({ forwardedPort: 45678 })

      await act(async () => {
        renderBrowserPane({ url: 'https://localhost:3000/app' })
      })

      expect(api.post).toHaveBeenCalledWith('/api/proxy/forward', { port: 3000 })

      await waitFor(() => {
        const iframe = document.querySelector('iframe')
        expect(iframe).toBeTruthy()
        // Protocol preserved — TCP proxy passes bytes verbatim (including TLS handshake)
        expect(iframe!.getAttribute('src')).toBe('https://192.168.1.100:45678/app')
      })
    })

    it('does not request port forwarding when accessing locally', () => {
      setWindowHostname('localhost')
      renderBrowserPane({ url: 'http://localhost:3000' })

      expect(api.post).not.toHaveBeenCalled()

      const iframe = document.querySelector('iframe')
      expect(iframe).toBeTruthy()
      expect(iframe!.getAttribute('src')).toBe('http://localhost:3000')
    })

    it('does not request port forwarding for non-localhost URLs', () => {
      setWindowHostname('192.168.1.100')
      renderBrowserPane({ url: 'https://example.com' })

      expect(api.post).not.toHaveBeenCalled()

      const iframe = document.querySelector('iframe')
      expect(iframe).toBeTruthy()
      expect(iframe!.getAttribute('src')).toBe('https://example.com')
    })

    it('does not request port forwarding for file:// URLs when remote', () => {
      setWindowHostname('192.168.1.100')
      renderBrowserPane({ url: 'file:///home/user/index.html' })

      expect(api.post).not.toHaveBeenCalled()

      const iframe = document.querySelector('iframe')
      expect(iframe).toBeTruthy()
      expect(iframe!.getAttribute('src')).toBe(
        '/local-file?path=' + encodeURIComponent('/home/user/index.html'),
      )
    })

    it('shows connecting state while port forward is pending', async () => {
      setWindowHostname('192.168.1.100')
      let resolveForward!: (value: { forwardedPort: number }) => void
      vi.mocked(api.post).mockReturnValue(
        new Promise((resolve) => {
          resolveForward = resolve
        }),
      )

      renderBrowserPane({ url: 'http://localhost:3000' })

      // Should show connecting state (no iframe yet)
      expect(screen.getByText(/Connecting/i)).toBeInTheDocument()
      expect(document.querySelector('iframe')).toBeNull()

      // Resolve the forward
      await act(async () => {
        resolveForward({ forwardedPort: 45678 })
      })

      // Now the iframe should appear
      await waitFor(() => {
        const iframe = document.querySelector('iframe')
        expect(iframe).toBeTruthy()
        expect(iframe!.getAttribute('src')).toBe('http://192.168.1.100:45678/')
      })
    })

    it('clears forwarding state when navigating to a non-forward URL', async () => {
      setWindowHostname('192.168.1.100')
      vi.mocked(api.post).mockReturnValue(new Promise(() => {}))

      renderBrowserPane({ url: 'http://localhost:3000' })

      expect(screen.getByText(/Connecting/i)).toBeInTheDocument()

      const input = screen.getByPlaceholderText('Enter URL...')
      fireEvent.change(input, { target: { value: 'https://example.com' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(screen.queryByText(/Connecting/i)).not.toBeInTheDocument()
        const iframe = document.querySelector('iframe')
        expect(iframe).toBeTruthy()
        expect(iframe!.getAttribute('src')).toBe('https://example.com')
      })
    })

    it('releases port forward when navigating away from a forwarded URL', async () => {
      setWindowHostname('192.168.1.100')
      vi.mocked(api.post).mockResolvedValue({ forwardedPort: 45678 })

      await act(async () => {
        renderBrowserPane({ url: 'http://localhost:3000' })
      })

      await waitFor(() => {
        const iframe = document.querySelector('iframe')
        expect(iframe).toBeTruthy()
      })

      // Navigate away
      const input = screen.getByPlaceholderText('Enter URL...')
      fireEvent.change(input, { target: { value: 'https://example.com' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(api.delete).toHaveBeenCalledWith('/api/proxy/forward/3000')
      })
    })

    it('shows error when port forwarding fails', async () => {
      setWindowHostname('192.168.1.100')
      vi.mocked(api.post).mockRejectedValue(
        new Error('Failed to create port forward'),
      )

      await act(async () => {
        renderBrowserPane({ url: 'http://localhost:3000' })
      })

      await waitFor(() => {
        // Use exact string to avoid matching the description which also contains "Failed to connect"
        expect(screen.getByText('Failed to connect')).toBeInTheDocument()
      })
    })

    it('clears loading state when port forwarding fails', async () => {
      setWindowHostname('192.168.1.100')
      vi.mocked(api.post).mockRejectedValue(new Error('Connection refused'))

      await act(async () => {
        renderBrowserPane({ url: 'http://localhost:3000' })
      })

      await waitFor(() => {
        expect(screen.getByText('Failed to connect')).toBeInTheDocument()
      })

      // Toolbar should show Refresh (not Stop), meaning isLoading is false
      expect(screen.getByTitle('Refresh')).toBeInTheDocument()
      expect(screen.queryByTitle('Stop')).not.toBeInTheDocument()
    })

    it('retries port forwarding when Try Again is clicked after failure', async () => {
      setWindowHostname('192.168.1.100')
      vi.mocked(api.post)
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockResolvedValueOnce({ forwardedPort: 45678 })

      await act(async () => {
        renderBrowserPane({ url: 'http://localhost:3000' })
      })

      await waitFor(() => {
        expect(screen.getByText('Failed to connect')).toBeInTheDocument()
      })

      expect(api.post).toHaveBeenCalledTimes(1)

      // Click Try Again
      await act(async () => {
        fireEvent.click(screen.getByText('Try Again'))
      })

      // Should have made a second API call
      await waitFor(() => {
        expect(api.post).toHaveBeenCalledTimes(2)
      })

      // Should now show the iframe
      await waitFor(() => {
        const iframe = document.querySelector('iframe')
        expect(iframe).toBeTruthy()
        expect(iframe!.getAttribute('src')).toBe('http://192.168.1.100:45678/')
      })
    })
  })
})
