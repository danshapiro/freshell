import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import TabBar from '@/components/TabBar'
import tabsReducer from '@/store/tabsSlice'
import codingCliReducer from '@/store/codingCliSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import type { Tab } from '@/store/types'

// Mock the ws-client module
vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({ send: vi.fn() }),
}))

// Mock useTabBarScroll to control overflow state
const mockCallbackRef = vi.fn()
const mockScrollToTab = vi.fn()
let mockCanScrollLeft = false
let mockCanScrollRight = false

vi.mock('@/hooks/useTabBarScroll', () => ({
  useTabBarScroll: () => ({
    callbackRef: mockCallbackRef,
    canScrollLeft: mockCanScrollLeft,
    canScrollRight: mockCanScrollRight,
    scrollToTab: mockScrollToTab,
  }),
}))

function createTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: `tab-${Math.random().toString(36).slice(2)}`,
    createRequestId: 'req-1',
    title: 'Terminal 1',
    status: 'running',
    mode: 'shell',
    shell: 'system',
    createdAt: Date.now(),
    ...overrides,
  }
}

function createStore(initialState: { tabs: Tab[]; activeTabId: string | null }) {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      codingCli: codingCliReducer,
      panes: panesReducer,
      settings: settingsReducer,
      turnCompletion: turnCompletionReducer,
    },
    preloadedState: {
      tabs: { tabs: initialState.tabs, activeTabId: initialState.activeTabId, renameRequestTabId: null },
      codingCli: { sessions: {}, pendingRequests: {} },
      panes: { layouts: {}, activePane: {}, paneTitles: {} },
      settings: { settings: defaultSettings, loaded: true },
      turnCompletion: { seq: 0, lastEvent: null, pendingEvents: [], attentionByTab: {} },
    },
  })
}

function renderWithStore(ui: React.ReactElement, store: ReturnType<typeof createStore>) {
  return render(<Provider store={store}>{ui}</Provider>)
}

describe('TabBar overflow indicators', () => {
  beforeEach(() => {
    mockCanScrollLeft = false
    mockCanScrollRight = false
    mockCallbackRef.mockClear()
    mockScrollToTab.mockClear()
  })

  afterEach(() => cleanup())

  it('renders no gradient overlays when both canScrollLeft and canScrollRight are false', () => {
    mockCanScrollLeft = false
    mockCanScrollRight = false

    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })
    const { container } = renderWithStore(<TabBar />, store)

    const leftGradient = container.querySelector('.bg-gradient-to-r')
    const rightGradient = container.querySelector('.bg-gradient-to-l')
    expect(leftGradient).toBeNull()
    expect(rightGradient).toBeNull()
  })

  it('renders right gradient when canScrollRight is true', () => {
    mockCanScrollLeft = false
    mockCanScrollRight = true

    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })
    const { container } = renderWithStore(<TabBar />, store)

    const leftGradient = container.querySelector('.bg-gradient-to-r')
    const rightGradient = container.querySelector('.bg-gradient-to-l')
    expect(leftGradient).toBeNull()
    expect(rightGradient).not.toBeNull()
    expect(rightGradient?.getAttribute('aria-hidden')).toBe('true')
    expect(rightGradient?.className).toContain('pointer-events-none')
  })

  it('renders left gradient when canScrollLeft is true', () => {
    mockCanScrollLeft = true
    mockCanScrollRight = false

    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })
    const { container } = renderWithStore(<TabBar />, store)

    const leftGradient = container.querySelector('.bg-gradient-to-r')
    const rightGradient = container.querySelector('.bg-gradient-to-l')
    expect(leftGradient).not.toBeNull()
    expect(leftGradient?.getAttribute('aria-hidden')).toBe('true')
    expect(leftGradient?.className).toContain('pointer-events-none')
    expect(rightGradient).toBeNull()
  })

  it('renders both gradients when both overflow directions are true', () => {
    mockCanScrollLeft = true
    mockCanScrollRight = true

    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })
    const { container } = renderWithStore(<TabBar />, store)

    const leftGradient = container.querySelector('.bg-gradient-to-r')
    const rightGradient = container.querySelector('.bg-gradient-to-l')
    expect(leftGradient).not.toBeNull()
    expect(rightGradient).not.toBeNull()
    expect(leftGradient?.getAttribute('aria-hidden')).toBe('true')
    expect(rightGradient?.getAttribute('aria-hidden')).toBe('true')
  })

  it('gradient overlays are non-interactive (pointer-events-none)', () => {
    mockCanScrollLeft = true
    mockCanScrollRight = true

    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })
    const { container } = renderWithStore(<TabBar />, store)

    const leftGradient = container.querySelector('.bg-gradient-to-r')
    const rightGradient = container.querySelector('.bg-gradient-to-l')
    expect(leftGradient?.className).toContain('pointer-events-none')
    expect(rightGradient?.className).toContain('pointer-events-none')
  })

  it('+ button remains keyboard-reachable outside scroll area', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })
    renderWithStore(<TabBar />, store)

    const addButton = screen.getByRole('button', { name: 'New shell tab' })
    expect(addButton).toBeInTheDocument()
    // Button should be a real <button> element (inherently keyboard-focusable)
    expect(addButton.tagName).toBe('BUTTON')
  })
})
