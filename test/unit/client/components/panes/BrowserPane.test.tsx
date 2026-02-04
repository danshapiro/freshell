import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
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
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

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
      // The existing regex strips the leading slash after file:///
      expect(iframe!.getAttribute('src')).toBe(
        '/local-file?path=' + encodeURIComponent('home/user/index.html'),
      )
    })
  })

  describe('localhost rewriting for remote access', () => {
    const originalLocation = window.location

    afterEach(() => {
      // Restore original location
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
        configurable: true,
      })
    })

    function setWindowHostname(hostname: string) {
      Object.defineProperty(window, 'location', {
        value: { ...originalLocation, hostname },
        writable: true,
        configurable: true,
      })
    }

    it('rewrites localhost URL to host IP when accessing remotely', () => {
      setWindowHostname('192.168.1.100')
      renderBrowserPane({ url: 'http://localhost:3000' })

      const iframe = document.querySelector('iframe')
      expect(iframe).toBeTruthy()
      expect(iframe!.getAttribute('src')).toBe('http://192.168.1.100:3000/')
    })

    it('rewrites 127.0.0.1 URL to host IP when accessing remotely', () => {
      setWindowHostname('192.168.1.100')
      renderBrowserPane({ url: 'http://127.0.0.1:8080' })

      const iframe = document.querySelector('iframe')
      expect(iframe).toBeTruthy()
      expect(iframe!.getAttribute('src')).toBe('http://192.168.1.100:8080/')
    })

    it('preserves path and query when rewriting localhost', () => {
      setWindowHostname('10.0.0.5')
      renderBrowserPane({ url: 'http://localhost:3000/api/data?q=test' })

      const iframe = document.querySelector('iframe')
      expect(iframe).toBeTruthy()
      expect(iframe!.getAttribute('src')).toBe('http://10.0.0.5:3000/api/data?q=test')
    })

    it('does not rewrite localhost when accessing locally', () => {
      setWindowHostname('localhost')
      renderBrowserPane({ url: 'http://localhost:3000' })

      const iframe = document.querySelector('iframe')
      expect(iframe).toBeTruthy()
      expect(iframe!.getAttribute('src')).toBe('http://localhost:3000')
    })

    it('does not rewrite non-localhost URLs when remote', () => {
      setWindowHostname('192.168.1.100')
      renderBrowserPane({ url: 'https://example.com' })

      const iframe = document.querySelector('iframe')
      expect(iframe).toBeTruthy()
      expect(iframe!.getAttribute('src')).toBe('https://example.com')
    })

    it('does not rewrite file:// URLs when remote', () => {
      setWindowHostname('192.168.1.100')
      renderBrowserPane({ url: 'file:///home/user/index.html' })

      const iframe = document.querySelector('iframe')
      expect(iframe).toBeTruthy()
      // file:// should still go through /local-file endpoint (existing regex strips leading /)
      expect(iframe!.getAttribute('src')).toBe(
        '/local-file?path=' + encodeURIComponent('home/user/index.html'),
      )
    })
  })
})
