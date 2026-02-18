import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import connectionReducer, { setStatus, setError } from '@/store/connectionSlice'
import { AuthRequiredModal } from '@/components/AuthRequiredModal'

vi.mock('@/lib/auth', () => ({
  setAuthToken: vi.fn(),
}))

function createStore(overrides?: { status?: string; lastError?: string }) {
  return configureStore({
    reducer: { connection: connectionReducer },
    preloadedState: {
      connection: {
        status: (overrides?.status ?? 'ready') as any,
        lastError: overrides?.lastError,
        platform: null,
        availableClis: {},
      },
    },
  })
}

function renderModal(overrides?: { status?: string; lastError?: string }) {
  const store = createStore(overrides)
  const utils = render(
    <Provider store={store}>
      <AuthRequiredModal />
    </Provider>,
  )
  return { ...utils, store }
}

describe('AuthRequiredModal', () => {
  const originalReload = window.location.reload

  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    // Mock location.reload
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: vi.fn() },
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    cleanup()
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: originalReload },
      writable: true,
      configurable: true,
    })
  })

  it('does not render when connection is ready', () => {
    renderModal({ status: 'ready' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('does not render when disconnected but error is not auth-related', () => {
    renderModal({ status: 'disconnected', lastError: 'Connection timeout' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('does not render when connecting', () => {
    renderModal({ status: 'connecting', lastError: 'Authentication failed' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('renders when disconnected with auth failure error', () => {
    renderModal({ status: 'disconnected', lastError: 'Authentication failed' })
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeInTheDocument()
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByText(/missing a valid auth token/i)).toBeInTheDocument()
    expect(screen.getByText(/\/\?token=YOUR_AUTH_TOKEN/i)).toBeInTheDocument()
    expect(screen.getByText('AUTH_TOKEN')).toBeInTheDocument()
  })

  it('renders when disconnected with auth failure code error', () => {
    renderModal({ status: 'disconnected', lastError: 'Authentication failed (code 4001)' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('has a token input field', () => {
    renderModal({ status: 'disconnected', lastError: 'Authentication failed' })
    expect(screen.getByLabelText(/token/i)).toBeInTheDocument()
  })

  it('has a Connect button', () => {
    renderModal({ status: 'disconnected', lastError: 'Authentication failed' })
    expect(screen.getByRole('button', { name: /connect/i })).toBeInTheDocument()
  })

  it('dismisses when close button is clicked', () => {
    renderModal({ status: 'disconnected', lastError: 'Authentication failed' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    const closeButton = screen.getByRole('button', { name: /dismiss/i })
    fireEvent.click(closeButton)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('dismisses when Escape is pressed', () => {
    renderModal({ status: 'disconnected', lastError: 'Authentication failed' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('dismisses when backdrop is clicked', () => {
    renderModal({ status: 'disconnected', lastError: 'Authentication failed' })
    const backdrop = screen.getByRole('dialog').parentElement!
    fireEvent.click(backdrop)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('stays dismissed after being closed (does not re-show)', () => {
    const { store } = renderModal({ status: 'disconnected', lastError: 'Authentication failed' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // Simulate the store re-dispatching the same error (e.g. reconnect attempt)
    store.dispatch(setStatus('disconnected'))
    store.dispatch(setError('Authentication failed'))

    // Should remain dismissed for the component's lifetime
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('calls setAuthToken and reloads when raw token is submitted', async () => {
    const { setAuthToken } = await import('@/lib/auth')
    const user = userEvent.setup()

    renderModal({ status: 'disconnected', lastError: 'Authentication failed' })

    const input = screen.getByLabelText(/token/i)
    await user.type(input, 'my-raw-token')

    const connectButton = screen.getByRole('button', { name: /connect/i })
    await user.click(connectButton)

    expect(setAuthToken).toHaveBeenCalledWith('my-raw-token')
    expect(window.location.reload).toHaveBeenCalled()
  })

  it('extracts token from URL and calls setAuthToken', async () => {
    const { setAuthToken } = await import('@/lib/auth')
    const user = userEvent.setup()

    renderModal({ status: 'disconnected', lastError: 'Authentication failed' })

    const input = screen.getByLabelText(/token/i)
    await user.type(input, 'http://192.168.1.100:3000/?token=extracted-token')

    const connectButton = screen.getByRole('button', { name: /connect/i })
    await user.click(connectButton)

    expect(setAuthToken).toHaveBeenCalledWith('extracted-token')
    expect(window.location.reload).toHaveBeenCalled()
  })

  it('rejects a URL without a token param (does not store garbage)', async () => {
    const { setAuthToken } = await import('@/lib/auth')
    const user = userEvent.setup()

    renderModal({ status: 'disconnected', lastError: 'Authentication failed' })

    const input = screen.getByLabelText(/token/i)
    await user.type(input, 'http://192.168.1.100:3000/')

    const connectButton = screen.getByRole('button', { name: /connect/i })
    await user.click(connectButton)

    expect(setAuthToken).not.toHaveBeenCalled()
    expect(window.location.reload).not.toHaveBeenCalled()
  })

  it('does not submit when input is empty', async () => {
    const { setAuthToken } = await import('@/lib/auth')
    const user = userEvent.setup()

    renderModal({ status: 'disconnected', lastError: 'Authentication failed' })

    const connectButton = screen.getByRole('button', { name: /connect/i })
    await user.click(connectButton)

    expect(setAuthToken).not.toHaveBeenCalled()
    expect(window.location.reload).not.toHaveBeenCalled()
  })

  it('submits on Enter key in input field', async () => {
    const { setAuthToken } = await import('@/lib/auth')
    const user = userEvent.setup()

    renderModal({ status: 'disconnected', lastError: 'Authentication failed' })

    const input = screen.getByLabelText(/token/i)
    await user.type(input, 'enter-token{enter}')

    expect(setAuthToken).toHaveBeenCalledWith('enter-token')
    expect(window.location.reload).toHaveBeenCalled()
  })
})
