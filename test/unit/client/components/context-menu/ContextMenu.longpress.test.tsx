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

  describe('dismissal policy (scroll / resize / blur)', () => {
    // NOTE: the outer suite's beforeEach already installs vi.useFakeTimers().
    // Vitest's default toFake includes Date (verified by probe against this
    // repo's vitest 3.2.4), so vi.advanceTimersByTime() advances Date.now(),
    // which the grace-window implementation reads. Do NOT add a nested
    // vi.useFakeTimers({ toFake: [...] }) here: re-calling it while fake
    // timers are already installed is a verified silent no-op (the new
    // config is ignored). If Date faking ever regressed, these tests would
    // fail loudly rather than silently.

    function openMenuByLongPress() {
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
      expect(screen.getByRole('menu')).toBeInTheDocument()
    }

    it('ignores scroll events during the post-open grace window, then closes on a later scroll', () => {
      openMenuByLongPress()

      // Mechanical scroll immediately after open (focus scroll-into-view,
      // xterm refit, keyboard viewport settling) must NOT dismiss.
      act(() => {
        window.dispatchEvent(new Event('scroll'))
      })
      expect(screen.getByRole('menu')).toBeInTheDocument()

      // Still inside the 500ms grace window.
      act(() => {
        vi.advanceTimersByTime(100)
      })
      act(() => {
        window.dispatchEvent(new Event('scroll'))
      })
      expect(screen.getByRole('menu')).toBeInTheDocument()

      // 600ms after open — past the 500ms grace window: a genuine user
      // scroll dismisses the menu (correct UX).
      act(() => {
        vi.advanceTimersByTime(500)
      })
      act(() => {
        window.dispatchEvent(new Event('scroll'))
      })
      expect(screen.queryByRole('menu')).toBeNull()
    })

    it('never closes on scrolls that originate inside the menu itself', () => {
      openMenuByLongPress()

      // Get past the grace window so this test proves the target-origin
      // exclusion specifically, not the grace window.
      act(() => {
        vi.advanceTimersByTime(600)
      })

      // scroll does not bubble, but the provider's listener is registered
      // on window with capture: true, so it still sees this event during
      // the capture phase with e.target === the menu element.
      const menu = screen.getByRole('menu')
      act(() => {
        menu.dispatchEvent(new Event('scroll'))
      })
      expect(screen.getByRole('menu')).toBeInTheDocument()

      // Sanity: a window-level scroll at the same moment DOES close.
      act(() => {
        window.dispatchEvent(new Event('scroll'))
      })
      expect(screen.queryByRole('menu')).toBeNull()
    })

    it('ignores resize during the grace window but closes on a later resize', () => {
      openMenuByLongPress()

      // Keyboard show/hide can resize the window (older Android WebViews)
      // right as the menu opens — must not dismiss.
      act(() => {
        window.dispatchEvent(new Event('resize'))
      })
      expect(screen.getByRole('menu')).toBeInTheDocument()

      act(() => {
        vi.advanceTimersByTime(600)
      })
      act(() => {
        window.dispatchEvent(new Event('resize'))
      })
      expect(screen.queryByRole('menu')).toBeNull()
    })

    it('closes on window blur immediately, even during the grace window', () => {
      openMenuByLongPress()

      act(() => {
        window.dispatchEvent(new Event('blur'))
      })
      expect(screen.queryByRole('menu')).toBeNull()
    })
  })

  it('focuses the first menu item with preventScroll so opening never triggers scroll-into-view', () => {
    // The auto-focus effect schedules via requestAnimationFrame; run the
    // callback synchronously so the focus happens within this test.
    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0)
        return 1
      })
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus')

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
    expect(screen.getByRole('menu')).toBeInTheDocument()

    // The only .focus() calls in this flow are the menu's item auto-focus;
    // every one of them must pass { preventScroll: true }.
    expect(focusSpy).toHaveBeenCalled()
    for (const call of focusSpy.mock.calls) {
      expect(call[0]).toEqual({ preventScroll: true })
    }

    rafSpy.mockRestore()
    focusSpy.mockRestore()
  })

  it('positions the menu inside the visual viewport when the on-screen keyboard is showing', () => {
    const originalVisualViewport = window.visualViewport
    // Keyboard visible: visual viewport is 400px tall while the layout
    // viewport (jsdom window.innerHeight) stays 768px.
    Object.defineProperty(window, 'visualViewport', {
      value: {
        width: 1024,
        height: 400,
        offsetLeft: 0,
        offsetTop: 0,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      configurable: true,
    })

    try {
      renderWithProvider(
        <div data-context={ContextIds.Tab} data-tab-id="tab-1">
          Tab One
        </div>
      )
      const target = screen.getByText('Tab One')
      elementFromPointMock.mockReturnValue(target)

      // Long-press at y=600 -- inside the keyboard-occluded region.
      act(() => {
        simulateTouch('touchstart', target, 100, 600)
      })
      act(() => {
        vi.advanceTimersByTime(500)
      })

      const menu = screen.getByRole('menu')
      // jsdom reports a zero-size menu rect, so the clamp ceiling is
      // maxY = 400 - 0 - 8 = 392. The menu must NOT stay at y=600 (under
      // the keyboard, where focus-driven scroll would then dismiss it).
      expect(menu.style.top).toBe('392px')
      expect(menu.style.left).toBe('100px')
    } finally {
      Object.defineProperty(window, 'visualViewport', {
        value: originalVisualViewport,
        configurable: true,
      })
    }
  })

  it('renders the menu itself with text selection suppressed', () => {
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
    // A long-press release drifting onto the menu must not start selecting
    // menu label text on mobile.
    expect(screen.getByRole('menu').className).toContain('select-none')
  })
})
