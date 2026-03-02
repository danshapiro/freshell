import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'

import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import sessionsReducer from '@/store/sessionsSlice'
import connectionReducer from '@/store/connectionSlice'
import settingsReducer from '@/store/settingsSlice'
import { ContextMenuProvider } from '@/components/context-menu/ContextMenuProvider'
import { ContextIds } from '@/components/context-menu/context-menu-constants'

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn().mockReturnValue(() => {}),
    onReconnect: vi.fn().mockReturnValue(() => {}),
    setHelloExtensionProvider: vi.fn(),
  }),
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue([]),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}))

vi.mock('@/lib/clipboard', () => ({
  copyText: vi.fn().mockResolvedValue(undefined),
}))

function createTestStore() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      sessions: sessionsReducer,
      connection: connectionReducer,
      settings: settingsReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({ serializableCheck: false }),
    preloadedState: {
      tabs: {
        tabs: [
          {
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Tab One',
            status: 'running',
            mode: 'shell',
            shell: 'system',
            createdAt: 1,
          },
          {
            id: 'tab-2',
            createRequestId: 'tab-2',
            title: 'Tab Two',
            status: 'running',
            mode: 'shell',
            shell: 'system',
            createdAt: 2,
          },
        ],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      },
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
      },
      sessions: {
        projects: [],
        expandedProjects: new Set<string>(),
      },
      connection: {
        status: 'ready',
        platform: null,
      },
    },
  })
}

function renderWithProvider(ui: React.ReactNode) {
  const store = createTestStore()
  const utils = render(
    <Provider store={store}>
      <ContextMenuProvider
        view="terminal"
        onViewChange={() => {}}
        onToggleSidebar={() => {}}
        sidebarCollapsed={false}
      >
        {ui}
      </ContextMenuProvider>
    </Provider>
  )
  return { store, ...utils }
}

function simulateTouch(
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  target: Element,
  clientX = 100,
  clientY = 100
) {
  const touch = { clientX, clientY, identifier: 0, target }
  const touchEvent = new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: type === 'touchend' || type === 'touchcancel' ? [] : [touch as any],
    changedTouches: [touch as any],
  })
  target.dispatchEvent(touchEvent)
}

describe('ContextMenuProvider long-press', () => {
  let elementFromPointMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    // jsdom does not implement elementFromPoint, so we assign it directly
    elementFromPointMock = vi.fn().mockReturnValue(null)
    document.elementFromPoint = elementFromPointMock
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('opens context menu after 500ms touch hold on element with data-context', () => {
    renderWithProvider(
      <div data-context={ContextIds.Tab} data-tab-id="tab-1">
        Tab One
      </div>
    )

    const target = screen.getByText('Tab One')
    elementFromPointMock.mockReturnValue(target)

    act(() => {
      simulateTouch('touchstart', target, 100, 100)
    })

    expect(screen.queryByRole('menu')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('does NOT open context menu if touch moves >10px during hold', () => {
    renderWithProvider(
      <div data-context={ContextIds.Tab} data-tab-id="tab-1">
        Tab One
      </div>
    )

    const target = screen.getByText('Tab One')
    elementFromPointMock.mockReturnValue(target)

    act(() => {
      simulateTouch('touchstart', target, 100, 100)
    })

    // Move more than 10px
    act(() => {
      simulateTouch('touchmove', target, 120, 100)
    })

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('does NOT open context menu if touchend fires before 500ms', () => {
    renderWithProvider(
      <div data-context={ContextIds.Tab} data-tab-id="tab-1">
        Tab One
      </div>
    )

    const target = screen.getByText('Tab One')
    elementFromPointMock.mockReturnValue(target)

    act(() => {
      simulateTouch('touchstart', target, 100, 100)
    })

    // Release before 500ms
    act(() => {
      vi.advanceTimersByTime(200)
    })

    act(() => {
      simulateTouch('touchend', target)
    })

    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('cleans up timer on unmount', () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')

    const { unmount } = renderWithProvider(
      <div data-context={ContextIds.Tab} data-tab-id="tab-1">
        Tab One
      </div>
    )

    const target = screen.getByText('Tab One')
    elementFromPointMock.mockReturnValue(target)

    act(() => {
      simulateTouch('touchstart', target, 100, 100)
    })

    // Unmount while timer is pending
    unmount()

    // The cleanup should have cleared the timer
    expect(clearTimeoutSpy).toHaveBeenCalled()
  })

  it('does NOT open context menu if touch moves >10px vertically', () => {
    renderWithProvider(
      <div data-context={ContextIds.Tab} data-tab-id="tab-1">
        Tab One
      </div>
    )

    const target = screen.getByText('Tab One')
    elementFromPointMock.mockReturnValue(target)

    act(() => {
      simulateTouch('touchstart', target, 100, 100)
    })

    // Move more than 10px vertically
    act(() => {
      simulateTouch('touchmove', target, 100, 115)
    })

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('allows small touch movement (<=10px) without cancelling', () => {
    renderWithProvider(
      <div data-context={ContextIds.Tab} data-tab-id="tab-1">
        Tab One
      </div>
    )

    const target = screen.getByText('Tab One')
    elementFromPointMock.mockReturnValue(target)

    act(() => {
      simulateTouch('touchstart', target, 100, 100)
    })

    // Small movement within tolerance
    act(() => {
      simulateTouch('touchmove', target, 105, 108)
    })

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('does NOT open custom menu on text inputs (allows native menu)', () => {
    renderWithProvider(
      <div data-context={ContextIds.Global}>
        <input type="text" data-testid="text-input" />
      </div>
    )

    const input = screen.getByTestId('text-input')
    elementFromPointMock.mockReturnValue(input)

    act(() => {
      simulateTouch('touchstart', input, 100, 100)
    })

    act(() => {
      vi.advanceTimersByTime(500)
    })

    // Should NOT open custom menu — native text selection should be used
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('does NOT open custom menu on links (allows native menu)', () => {
    renderWithProvider(
      <div data-context={ContextIds.Global}>
        <a href="https://example.com" data-testid="link">Example</a>
      </div>
    )

    const link = screen.getByTestId('link')
    elementFromPointMock.mockReturnValue(link)

    act(() => {
      simulateTouch('touchstart', link, 100, 100)
    })

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('does NOT open custom menu on elements with data-native-context', () => {
    renderWithProvider(
      <div data-context={ContextIds.Global}>
        <div data-native-context="true" data-testid="native">Native context</div>
      </div>
    )

    const nativeEl = screen.getByTestId('native')
    elementFromPointMock.mockReturnValue(nativeEl)

    act(() => {
      simulateTouch('touchstart', nativeEl, 100, 100)
    })

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('cancels long-press on touchcancel', () => {
    renderWithProvider(
      <div data-context={ContextIds.Tab} data-tab-id="tab-1">
        Tab One
      </div>
    )

    const target = screen.getByText('Tab One')
    elementFromPointMock.mockReturnValue(target)

    act(() => {
      simulateTouch('touchstart', target, 100, 100)
    })

    act(() => {
      simulateTouch('touchcancel', target)
    })

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(screen.queryByRole('menu')).toBeNull()
  })
})
