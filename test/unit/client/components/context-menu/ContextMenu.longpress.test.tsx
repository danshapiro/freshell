import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'

import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import sessionsReducer from '@/store/sessionsSlice'
import connectionReducer from '@/store/connectionSlice'
import settingsReducer from '@/store/settingsSlice'
import tabRegistryReducer, { setTabRegistrySnapshot } from '@/store/tabRegistrySlice'
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
      tabRegistry: tabRegistryReducer,
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
  return touchEvent
}

function seedRemoteCardRecord(store: ReturnType<typeof createTestStore>) {
  store.dispatch(setTabRegistrySnapshot({
    localOpen: [],
    remoteOpen: [{
      tabKey: 'remote:open-1',
      tabId: 'open-1',
      serverInstanceId: 'srv-remote',
      deviceId: 'remote-device',
      deviceLabel: 'Remote Device',
      tabName: 'remote open',
      status: 'open',
      revision: 1,
      createdAt: 1,
      updatedAt: 2,
      paneCount: 1,
      titleSetByUser: false,
      panes: [],
    }],
    closed: [],
  }))
}

function simulateNativeContextMenu(target: Element, clientX = 100, clientY = 100) {
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
  })
  target.dispatchEvent(event)
  return event
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

  it('keeps the menu open when the long-press release lands on a menu item', () => {
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
      vi.advanceTimersByTime(500)
    })

    const firstItem = screen.getAllByRole('menuitem')[0]

    act(() => {
      const release = simulateTouch('touchend', firstItem, 100, 100)
      if (!release.defaultPrevented) {
        firstItem.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      }
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

  it('keeps the menu open when a native contextmenu wins the long-press race (Android)', () => {
    const { store } = renderWithProvider(
      <div data-context={ContextIds.Tab} data-tab-id="tab-1">
        Tab One
      </div>
    )

    const target = screen.getByText('Tab One')
    elementFromPointMock.mockReturnValue(target)

    act(() => {
      simulateTouch('touchstart', target, 100, 100)
    })

    // Android fires a real (trusted) contextmenu event mid-gesture,
    // BEFORE our 500ms JS timer fires.
    act(() => {
      vi.advanceTimersByTime(100)
    })
    act(() => {
      simulateNativeContextMenu(target, 100, 100)
    })

    expect(screen.getByRole('menu')).toBeInTheDocument()

    // Finger lifts. On click-synthesizing engines (iOS-like; Chromium-Android
    // does not synthesize one after a native contextmenu) an unsuppressed
    // release becomes a click at (100,100) -- exactly where the menu's
    // top-left (first item) now sits.
    const firstItem = screen.getAllByRole('menuitem')[0]
    act(() => {
      const release = simulateTouch('touchend', firstItem, 100, 100)
      if (!release.defaultPrevented) {
        firstItem.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      }
    })

    // Any menu-item click also closes the menu, so "menu still open" proves
    // no item action fired.
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(store.getState().tabs.tabs).toHaveLength(2)
  })

  it('cancels the pending long-press timer when a native contextmenu opens the menu mid-gesture', () => {
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
      vi.advanceTimersByTime(100)
    })
    act(() => {
      simulateNativeContextMenu(target, 100, 100)
    })
    expect(screen.getByRole('menu')).toBeInTheDocument()

    // The custom long-press timer must have been cancelled: its callback is
    // the only code path that calls document.elementFromPoint.
    elementFromPointMock.mockClear()
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(elementFromPointMock).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('ignores a native contextmenu that arrives after the long-press timer already opened the menu', () => {
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
      vi.advanceTimersByTime(500)
    })

    const menu = screen.getByRole('menu')
    expect(menu.style.left).toBe('100px')

    // Some Android browsers fire contextmenu AFTER the 500ms threshold --
    // i.e. after our timer already opened the menu for this same gesture.
    // Re-opening would jump the menu position and corrupt focus restore.
    act(() => {
      simulateNativeContextMenu(target, 300, 300)
    })

    const menuAfter = screen.getByRole('menu')
    expect(menuAfter).toBeInTheDocument()
    expect(menuAfter.style.left).toBe('100px')
  })

  it('opens the menu at the touch-session position when the native contextmenu reports drifted coords', () => {
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
      vi.advanceTimersByTime(100)
    })
    // Mid-gesture native contextmenu with coordinates that drifted away from
    // the touch start (some engines report offset/degenerate coords). The
    // unified handler must prefer the live touch-session position.
    act(() => {
      simulateNativeContextMenu(target, 300, 300)
    })

    const menu = screen.getByRole('menu')
    expect(menu.style.left).toBe('100px')
  })

  it('long-press opens the tabs-card menu and suppresses the card click', () => {
    const onCardClick = vi.fn()
    const { store } = renderWithProvider(
      <button type="button" data-context={ContextIds.TabsCard} data-tab-key="remote:open-1" onClick={onCardClick}>
        remote card
      </button>
    )
    act(() => {
      seedRemoteCardRecord(store)
    })

    const target = screen.getByText('remote card')
    elementFromPointMock.mockReturnValue(target)

    act(() => {
      simulateTouch('touchstart', target, 100, 100)
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Pull to this device/i })).toBeInTheDocument()

    act(() => {
      const release = simulateTouch('touchend', target, 100, 100)
      if (!release.defaultPrevented) {
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      }
    })

    // The card is a <button> with onClick -- suppression must prevent the
    // synthetic click from both closing the menu AND pulling the tab.
    expect(onCardClick).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('keeps the tabs-card menu open when a native contextmenu wins the race (Android)', () => {
    const onCardClick = vi.fn()
    const { store } = renderWithProvider(
      <button type="button" data-context={ContextIds.TabsCard} data-tab-key="remote:open-1" onClick={onCardClick}>
        remote card
      </button>
    )
    act(() => {
      seedRemoteCardRecord(store)
    })

    const target = screen.getByText('remote card')
    elementFromPointMock.mockReturnValue(target)

    act(() => {
      simulateTouch('touchstart', target, 100, 100)
    })
    act(() => {
      vi.advanceTimersByTime(100)
    })
    act(() => {
      simulateNativeContextMenu(target, 100, 100)
    })
    expect(screen.getByRole('menu')).toBeInTheDocument()

    const firstItem = screen.getAllByRole('menuitem')[0]
    act(() => {
      const release = simulateTouch('touchend', firstItem, 100, 100)
      if (!release.defaultPrevented) {
        firstItem.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      }
    })

    expect(onCardClick).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })
})
