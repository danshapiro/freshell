import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import TabBar from '@/components/TabBar'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    onReconnect: vi.fn(() => () => {}),
    state: 'ready',
  }),
}))

const resizeCallbacks: Array<() => void> = []

class MockResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallbacks.push(() => callback([], this as unknown as ResizeObserver))
  }

  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

function createStore() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      turnCompletion: turnCompletionReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [
          {
            id: 'tab-1',
            title: 'Tab 1',
            createRequestId: 'req-1',
            status: 'running' as const,
            mode: 'shell' as const,
            shell: 'system' as const,
            createdAt: 1,
          },
          {
            id: 'tab-2',
            title: 'Tab 2',
            createRequestId: 'req-2',
            status: 'running' as const,
            mode: 'shell' as const,
            shell: 'system' as const,
            createdAt: 2,
          },
          {
            id: 'tab-3',
            title: 'Tab 3',
            createRequestId: 'req-3',
            status: 'running' as const,
            mode: 'shell' as const,
            shell: 'system' as const,
            createdAt: 3,
          },
        ],
        activeTabId: 'tab-2',
        renameRequestTabId: null,
      },
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
      },
      settings: {
        settings: defaultSettings,
        loaded: true,
      },
      turnCompletion: {
        seq: 0,
        lastEvent: null,
        pendingEvents: [],
        attentionByTab: {},
        attentionByPane: {},
      },
    },
  })
}

describe('tab bar active visibility (e2e)', () => {
  beforeEach(() => {
    resizeCallbacks.length = 0
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('keeps the active tab onscreen when the scroll container shrinks', () => {
    const store = createStore()
    const { container } = render(
      <Provider store={store}>
        <TabBar />
      </Provider>,
    )

    const scrollContainer = container.querySelector('.overflow-x-auto') as HTMLDivElement | null
    expect(scrollContainer).toBeTruthy()

    Object.defineProperty(scrollContainer, 'scrollWidth', { value: 800, configurable: true })
    Object.defineProperty(scrollContainer, 'clientWidth', { value: 300, configurable: true })
    Object.defineProperty(scrollContainer, 'scrollLeft', {
      value: 0,
      writable: true,
      configurable: true,
    })
    scrollContainer!.scrollTo = vi.fn((opts: ScrollToOptions) => {
      if (opts.left !== undefined) {
        ;(scrollContainer as HTMLDivElement).scrollLeft = opts.left
      }
    }) as typeof scrollContainer.scrollTo
    scrollContainer!.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      right: 300,
      top: 0,
      bottom: 40,
      width: 300,
      height: 40,
      x: 0,
      y: 0,
      toJSON: () => {},
    }))

    const activeTab = container.querySelector('[data-tab-id="tab-2"]') as HTMLDivElement | null
    expect(activeTab).toBeTruthy()
    activeTab!.getBoundingClientRect = vi.fn(() => ({
      left: 180,
      right: 280,
      top: 0,
      bottom: 32,
      width: 100,
      height: 32,
      x: 180,
      y: 0,
      toJSON: () => {},
    }))

    ;(scrollContainer!.scrollTo as ReturnType<typeof vi.fn>).mockClear()
    Object.defineProperty(scrollContainer, 'clientWidth', { value: 200, configurable: true })

    act(() => {
      resizeCallbacks.forEach((callback) => callback())
    })

    expect(scrollContainer!.scrollTo).toHaveBeenCalledWith({
      left: 80,
      behavior: 'instant',
    })
  })
})
