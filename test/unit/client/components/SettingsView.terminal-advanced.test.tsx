import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import SettingsView from '@/components/SettingsView'
import settingsReducer, { defaultSettings, type SettingsState } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import { networkReducer } from '@/store/networkSlice'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  api: {
    patch: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}))

let originalFonts: Document['fonts'] | undefined

function createTestStore(settingsState?: Partial<SettingsState>) {
  return configureStore({
    reducer: {
      settings: settingsReducer,
      tabs: tabsReducer,
      connection: connectionReducer,
      sessions: sessionsReducer,
      network: networkReducer,
    },
    middleware: (getDefault) =>
      getDefault({
        serializableCheck: {
          ignoredPaths: ['sessions.expandedProjects'],
        },
      }),
    preloadedState: {
      settings: {
        settings: defaultSettings,
        loaded: true,
        lastSavedAt: undefined,
        ...settingsState,
      },
    },
  })
}

function renderWithStore(store: ReturnType<typeof createTestStore>) {
  return render(
    <Provider store={store}>
      <SettingsView />
    </Provider>,
  )
}

describe('SettingsView terminal advanced settings', () => {
  beforeEach(() => {
    originalFonts = document.fonts
    Object.defineProperty(document, 'fonts', {
      value: {
        check: vi.fn(() => true),
        ready: Promise.resolve(),
      },
      configurable: true,
    })
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    if (originalFonts) {
      Object.defineProperty(document, 'fonts', {
        value: originalFonts,
        configurable: true,
      })
    } else {
      // @ts-expect-error test cleanup for jsdom fonts override
      delete document.fonts
    }
  })

  it('is collapsed by default', () => {
    const store = createTestStore()
    renderWithStore(store)

    const advancedToggle = screen.getByRole('button', { name: 'Advanced' })
    const panel = document.getElementById(advancedToggle.getAttribute('aria-controls') ?? '')
    expect(advancedToggle).toHaveAttribute('aria-expanded', 'false')
    expect(panel).toHaveAttribute('hidden')
  })

  it('expands to show OSC52 clipboard policy control', () => {
    const store = createTestStore()
    renderWithStore(store)

    const advancedToggle = screen.getByRole('button', { name: 'Advanced' })
    fireEvent.click(advancedToggle)
    const panel = document.getElementById(advancedToggle.getAttribute('aria-controls') ?? '')

    expect(advancedToggle).toHaveAttribute('aria-expanded', 'true')
    expect(panel).not.toHaveAttribute('hidden')
    expect(screen.getByText('OSC52 clipboard access')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ask' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Always' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Never' })).toBeInTheDocument()
  })

  it('persists Always and Never policy updates', async () => {
    const store = createTestStore()
    renderWithStore(store)

    const advancedToggle = screen.getByRole('button', { name: 'Advanced' })
    fireEvent.click(advancedToggle)
    fireEvent.click(screen.getByRole('button', { name: 'Always' }))

    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    expect(api.patch).toHaveBeenCalledWith('/api/settings', { terminal: { osc52Clipboard: 'always' } })

    fireEvent.click(screen.getByRole('button', { name: 'Never' }))

    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    expect(api.patch).toHaveBeenCalledWith('/api/settings', { terminal: { osc52Clipboard: 'never' } })
  })
})
