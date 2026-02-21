import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { ConnectionErrorOverlay } from '@/components/terminal/ConnectionErrorOverlay'
import connectionReducer from '@/store/connectionSlice'

afterEach(() => cleanup())

function renderWithStore(errorCode?: number, errorMessage?: string) {
  const store = configureStore({
    reducer: { connection: connectionReducer },
    preloadedState: {
      connection: {
        status: 'disconnected' as const,
        lastError: errorMessage,
        lastErrorCode: errorCode,
        platform: null,
        availableClis: {},
      },
    },
  })
  return render(
    <Provider store={store}>
      <ConnectionErrorOverlay />
    </Provider>,
  )
}

describe('TerminalView connection error wiring', () => {
  // TerminalView depends on xterm and cannot be rendered in jsdom.
  // These tests verify the wiring by reading the actual source code
  // to ensure ConnectionErrorOverlay is imported and used, and that
  // spinner suppression logic references the 4003 error code.
  const terminalViewSource = readFileSync(
    resolve(__dirname, '../../../../../src/components/TerminalView.tsx'),
    'utf-8',
  )

  it('imports ConnectionErrorOverlay', () => {
    expect(terminalViewSource).toContain(
      "import { ConnectionErrorOverlay } from '@/components/terminal/ConnectionErrorOverlay'",
    )
  })

  it('reads lastErrorCode from Redux', () => {
    expect(terminalViewSource).toMatch(/useAppSelector\(.*lastErrorCode/)
  })

  it('suppresses spinner when error code is 4003', () => {
    expect(terminalViewSource).toMatch(/connectionErrorCode\s*!==\s*4003/)
  })

  it('renders ConnectionErrorOverlay in JSX', () => {
    expect(terminalViewSource).toContain('<ConnectionErrorOverlay />')
  })
})

describe('ConnectionErrorOverlay', () => {
  it('renders nothing when no error code is set', () => {
    const { container } = renderWithStore()
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing for non-4003 error codes', () => {
    const { container } = renderWithStore(4001, 'Authentication failed')
    expect(container.firstChild).toBeNull()
  })

  it('renders max connections message for code 4003', () => {
    renderWithStore(4003, 'Server busy: max connections reached')
    expect(screen.getByText(/connection limit reached/i)).toBeInTheDocument()
    expect(screen.getByText(/MAX_CONNECTIONS/)).toBeInTheDocument()
  })

  it('has accessible role and label', () => {
    renderWithStore(4003, 'Server busy: max connections reached')
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})
