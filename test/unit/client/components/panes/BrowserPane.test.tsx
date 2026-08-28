import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import panesReducer, { requestPaneRefresh } from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import paneRuntimeActivityReducer from '@/store/paneRuntimeActivitySlice'
import BrowserPane, { resolveBrowserSource } from '@/components/panes/BrowserPane'

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
      paneRuntimeActivity: paneRuntimeActivityReducer,
    },
    preloadedState: {
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
      paneRuntimeActivity: {
        byPaneId: {},
      },
    },
  })

function renderBrowserPane(
  props: Partial<React.ComponentProps<typeof BrowserPane>> = {},
  store = createMockStore(),
) {
  const defaultProps = {
    paneId: 'pane-1',
    tabId: 'tab-1',
    browserInstanceId: 'browser-1',
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
      const { store } = renderBrowserPane({ url: 'https://example.com' })

      const iframe = document.querySelector('iframe')
      expect(iframe).toBeTruthy()
      expect(iframe!.getAttribute('src')).toBe('https://example.com')
      expect(store.getState().paneRuntimeActivity.byPaneId['pane-1']).toMatchObject({
        source: 'browser',
      })
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

    it('preserves http:// protocol when specified', async () => {
      setWindowHostname('localhost')
      renderBrowserPane()

      const input = screen.getByPlaceholderText('Enter URL...')
      await act(async () => {
        // Use port 4000 to avoid collision with jsdom's default port (3000)
        fireEvent.change(input, { target: { value: 'http://localhost:4000' } })
        fireEvent.keyDown(input, { key: 'Enter' })
      })

      await waitFor(() => {
        const iframe = document.querySelector('iframe')
        expect(iframe).toBeTruthy()
        // Localhost URLs are proxied through Freshell's HTTP proxy (handles WSL2/Docker)
        expect(iframe!.getAttribute('src')).toBe('/api/proxy/http/4000/')
      })
    })

    it('syncs input and history when url prop changes externally', () => {
      const store = createMockStore()
      const baseProps = {
        paneId: 'pane-1',
        tabId: 'tab-1',
        devToolsOpen: false,
      }

      const { rerender } = render(
        <Provider store={store}>
          <BrowserPane {...baseProps} url="https://first.example.com" />
        </Provider>,
      )

      const input = screen.getByPlaceholderText('Enter URL...') as HTMLInputElement
      expect(input.value).toBe('https://first.example.com')
      expect(screen.getByTitle('Back')).toBeDisabled()

      rerender(
        <Provider store={store}>
          <BrowserPane {...baseProps} url="https://second.example.com" />
        </Provider>,
      )

      expect((screen.getByPlaceholderText('Enter URL...') as HTMLInputElement).value).toBe('https://second.example.com')
      const iframe = document.querySelector('iframe')
      expect(iframe).toBeTruthy()
      expect(iframe!.getAttribute('src')).toBe('https://second.example.com')
      expect(screen.getByTitle('Back')).not.toBeDisabled()

      fireEvent.click(screen.getByTitle('Back'))

      expect((screen.getByPlaceholderText('Enter URL...') as HTMLInputElement).value).toBe('https://first.example.com')
      expect(iframe!.getAttribute('src')).toBe('https://first.example.com')
    })

    it('clears navigation state when url prop is externally cleared', () => {
      const store = createMockStore()
      const baseProps = {
        paneId: 'pane-1',
        tabId: 'tab-1',
        devToolsOpen: false,
      }

      const { rerender } = render(
        <Provider store={store}>
          <BrowserPane {...baseProps} url="https://example.com" />
        </Provider>,
      )

      rerender(
        <Provider store={store}>
          <BrowserPane {...baseProps} url="" />
        </Provider>,
      )

      const input = screen.getByPlaceholderText('Enter URL...') as HTMLInputElement
      expect(input.value).toBe('')
      expect(screen.getByText('Enter a URL to browse')).toBeInTheDocument()
      expect(screen.getByTitle('Back')).toBeDisabled()
      expect(screen.getByTitle('Forward')).toBeDisabled()
    })
  })

  describe('refresh requests', () => {
    function createBrowserStore() {
      return configureStore({
        reducer: {
          panes: panesReducer,
          settings: settingsReducer,
          paneRuntimeActivity: paneRuntimeActivityReducer,
        },
        preloadedState: {
          panes: {
            layouts: {
              'tab-1': {
                type: 'leaf',
                id: 'pane-1',
                content: {
                  kind: 'browser',
                  browserInstanceId: 'browser-1',
                  url: 'https://example.com',
                  devToolsOpen: false,
                },
              },
            },
            activePane: { 'tab-1': 'pane-1' },
            paneTitles: {},
            paneTitleSetByUser: {},
            renameRequestTabId: null,
            renameRequestPaneId: null,
            zoomedPane: {},
            refreshRequestsByPane: {},
          },
          paneRuntimeActivity: {
            byPaneId: {},
          },
        },
      })
    }

    it('reloads the live iframe when a matching refresh request arrives', async () => {
      const store = createBrowserStore()
      renderBrowserPane({ url: 'https://example.com' }, store)

      const iframe = document.querySelector('iframe') as HTMLIFrameElement
      expect(iframe).toBeTruthy()

      const reload = vi.fn()
      Object.defineProperty(iframe, 'contentWindow', {
        configurable: true,
        value: { location: { reload } },
      })

      act(() => {
        store.dispatch(requestPaneRefresh({ tabId: 'tab-1', paneId: 'pane-1' }))
      })

      await waitFor(() => {
        expect(reload).toHaveBeenCalledTimes(1)
      })
      expect(store.getState().panes.refreshRequestsByPane['tab-1']).toBeUndefined()
    })

  })

  describe('runtime activity', () => {
    it('marks the pane idle after iframe load succeeds', () => {
      const { store } = renderBrowserPane({ url: 'https://example.com' })

      const iframe = document.querySelector('iframe') as HTMLIFrameElement
      fireEvent.load(iframe)

      expect(store.getState().paneRuntimeActivity.byPaneId['pane-1']).toMatchObject({
        source: 'browser',
        phase: 'idle',
      })
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

  describe('localhost HTTP proxying', () => {
    it('proxies http: localhost URLs through HTTP proxy when accessing remotely', async () => {
      setWindowHostname('192.168.1.100')

      await act(async () => {
        // Use port 4000 to avoid collision with jsdom's default port (3000)
        renderBrowserPane({ url: 'http://localhost:4000' })
      })

      // http: localhost URLs use the same-origin HTTP proxy, not TCP forwarding
      expect(api.post).not.toHaveBeenCalled()

      await waitFor(() => {
        const iframe = document.querySelector('iframe')
        expect(iframe).toBeTruthy()
        expect(iframe!.getAttribute('src')).toBe('/api/proxy/http/4000/')
      })
    })

    it('keeps the HTTP proxy when recovering a failed remote localhost page', async () => {
      setWindowHostname('192.168.1.100')
      renderBrowserPane({ url: 'http://localhost:4000/path' })

      const iframe = await screen.findByTitle('Browser content')
      expect(iframe).toHaveAttribute('src', '/api/proxy/http/4000/path')

      await act(async () => {
        fireEvent.error(iframe, { bubbles: true })
      })
      fireEvent.click(await screen.findByRole('button', { name: 'Try Again' }))

      await waitFor(() => {
        expect(screen.getByTitle('Browser content')).toHaveAttribute(
          'src',
          '/api/proxy/http/4000/path',
        )
      })
    })

    it('proxies http://127.0.0.1 URLs through HTTP proxy when accessing remotely', async () => {
      setWindowHostname('192.168.1.100')

      await act(async () => {
        renderBrowserPane({ url: 'http://127.0.0.1:8080' })
      })

      expect(api.post).not.toHaveBeenCalled()

      await waitFor(() => {
        const iframe = document.querySelector('iframe')
        expect(iframe).toBeTruthy()
        expect(iframe!.getAttribute('src')).toBe('/api/proxy/http/8080/')
      })
    })

    it('preserves path and query when proxying http: localhost URLs remotely', async () => {
      setWindowHostname('10.0.0.5')

      await act(async () => {
        // Use port 4000 to avoid collision with jsdom's default port (3000)
        renderBrowserPane({ url: 'http://localhost:4000/api/data?q=test' })
      })

      expect(api.post).not.toHaveBeenCalled()

      await waitFor(() => {
        const iframe = document.querySelector('iframe')
        expect(iframe).toBeTruthy()
        expect(iframe!.getAttribute('src')).toBe('/api/proxy/http/4000/api/data?q=test')
      })
    })


    it('proxies localhost URLs through HTTP proxy when accessing locally', async () => {
      setWindowHostname('localhost')
      await act(async () => {
        // Use port 4000 to avoid collision with jsdom's default port (3000)
        renderBrowserPane({ url: 'http://localhost:4000' })
      })

      // No TCP port forward needed — uses HTTP proxy instead
      expect(api.post).not.toHaveBeenCalled()

      await waitFor(() => {
        const iframe = document.querySelector('iframe')
        expect(iframe).toBeTruthy()
        // Routed through Freshell's HTTP proxy (handles WSL2/Docker networking)
        expect(iframe!.getAttribute('src')).toBe('/api/proxy/http/4000/')
      })
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

  })

  it('uses the HTTP proxy for localhost and clearly disables remote HTTPS loopback', async () => {
    setWindowHostname('remote.example')
    const { rerender } = renderBrowserPane({ url: 'http://localhost:4040/path' })
    expect(await screen.findByTitle('Browser content')).toHaveAttribute('src', '/api/proxy/http/4040/path')
    rerender(<Provider store={createMockStore()}><BrowserPane paneId="pane-1" tabId="tab-1" browserInstanceId="browser-1" url="https://localhost:4040" devToolsOpen={false} /></Provider>)
    expect(await screen.findByRole('status')).toHaveTextContent('Remote loopback forwarding is unavailable; use a localhost HTTP URL or open the URL on the server host.')
    expect(api.post).not.toHaveBeenCalledWith('/api/proxy/forward', expect.anything())
  })

  it('keeps remote HTTPS loopback unavailable when resolving a recovery source', () => {
    setWindowHostname('remote.example')

    expect(resolveBrowserSource('https://localhost:4040/path')).toEqual({
      src: null,
      baselineUnavailable: true,
    })
  })
})
