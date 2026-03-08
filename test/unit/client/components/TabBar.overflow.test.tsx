import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import TabBar from '@/components/TabBar'
import tabsReducer from '@/store/tabsSlice'
import codingCliReducer from '@/store/codingCliSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import type { Tab } from '@/store/types'

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({ send: vi.fn() }),
}))

const mockCallbackRef = vi.fn()
const mockScrollToTab = vi.fn()
const mockScrollJumpLeft = vi.fn()
const mockScrollJumpRight = vi.fn()
const mockHandleArrowClick = vi.fn()
const mockStartHoldScroll = vi.fn()
const mockStopHoldScroll = vi.fn()
const mockCancelHoldScroll = vi.fn()
let mockCanScrollLeft = false
let mockCanScrollRight = false

vi.mock('@/hooks/useTabBarScroll', () => ({
  useTabBarScroll: () => ({
    callbackRef: mockCallbackRef,
    canScrollLeft: mockCanScrollLeft,
    canScrollRight: mockCanScrollRight,
    scrollToTab: mockScrollToTab,
    scrollJumpLeft: mockScrollJumpLeft,
    scrollJumpRight: mockScrollJumpRight,
    handleArrowClick: mockHandleArrowClick,
    startHoldScroll: mockStartHoldScroll,
    stopHoldScroll: mockStopHoldScroll,
    cancelHoldScroll: mockCancelHoldScroll,
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

beforeEach(() => {
  mockCanScrollLeft = false
  mockCanScrollRight = false
  mockCallbackRef.mockClear()
  mockScrollToTab.mockClear()
  mockScrollJumpLeft.mockClear()
  mockScrollJumpRight.mockClear()
  mockHandleArrowClick.mockClear()
  mockStartHoldScroll.mockClear()
  mockStopHoldScroll.mockClear()
  mockCancelHoldScroll.mockClear()
})

afterEach(() => cleanup())

describe('TabBar overflow — hard clip (no gradients)', () => {

  it('never renders gradient overlays regardless of overflow state', () => {
    mockCanScrollLeft = true
    mockCanScrollRight = true

    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })
    const { container } = renderWithStore(<TabBar />, store)

    expect(container.querySelector('.bg-gradient-to-r')).toBeNull()
    expect(container.querySelector('.bg-gradient-to-l')).toBeNull()
  })

  it('scrollable container uses overflow-x-auto for hard clip', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })
    const { container } = renderWithStore(<TabBar />, store)

    const scrollContainer = container.querySelector('.overflow-x-auto')
    expect(scrollContainer).not.toBeNull()
  })

  it('+ button remains pinned and always visible outside scroll area', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })
    renderWithStore(<TabBar />, store)

    const addButton = screen.getByRole('button', { name: 'New shell tab' })
    expect(addButton).toBeInTheDocument()
    expect(addButton.tagName).toBe('BUTTON')
    const scrollContainer = addButton.closest('.overflow-x-auto')
    expect(scrollContainer).toBeNull()
  })
})

describe('TabBar arrow navigation buttons', () => {

  it('hides both arrow buttons when tabs do not overflow', () => {
    mockCanScrollLeft = false
    mockCanScrollRight = false

    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })
    renderWithStore(<TabBar />, store)

    // Buttons are always in the DOM but hidden via aria-hidden + pointer-events-none
    const leftBtn = screen.getByLabelText('Scroll tabs left')
    const rightBtn = screen.getByLabelText('Scroll tabs right')
    expect(leftBtn.getAttribute('aria-hidden')).toBe('true')
    expect(rightBtn.getAttribute('aria-hidden')).toBe('true')
    expect(leftBtn.className).toContain('pointer-events-none')
    expect(rightBtn.className).toContain('pointer-events-none')
  })

  it('shows right arrow button when tabs overflow to the right', () => {
    mockCanScrollLeft = false
    mockCanScrollRight = true

    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })
    renderWithStore(<TabBar />, store)

    const leftBtn = screen.getByLabelText('Scroll tabs left')
    const rightBtn = screen.getByLabelText('Scroll tabs right')
    expect(leftBtn.getAttribute('aria-hidden')).toBe('true')
    expect(leftBtn.className).toContain('pointer-events-none')
    expect(rightBtn.getAttribute('aria-hidden')).not.toBe('true')
    expect(rightBtn.className).not.toContain('pointer-events-none')
  })

  it('shows left arrow button when tabs overflow to the left', () => {
    mockCanScrollLeft = true
    mockCanScrollRight = false

    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })
    renderWithStore(<TabBar />, store)

    const leftBtn = screen.getByLabelText('Scroll tabs left')
    const rightBtn = screen.getByLabelText('Scroll tabs right')
    expect(leftBtn.getAttribute('aria-hidden')).not.toBe('true')
    expect(leftBtn.className).not.toContain('pointer-events-none')
    expect(rightBtn.getAttribute('aria-hidden')).toBe('true')
    expect(rightBtn.className).toContain('pointer-events-none')
  })

  it('shows both arrow buttons when tabs overflow in both directions', () => {
    mockCanScrollLeft = true
    mockCanScrollRight = true

    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })
    renderWithStore(<TabBar />, store)

    const leftBtn = screen.getByLabelText('Scroll tabs left')
    const rightBtn = screen.getByLabelText('Scroll tabs right')
    expect(leftBtn.getAttribute('aria-hidden')).not.toBe('true')
    expect(rightBtn.getAttribute('aria-hidden')).not.toBe('true')
    expect(leftBtn.className).not.toContain('pointer-events-none')
    expect(rightBtn.className).not.toContain('pointer-events-none')
  })

  it('click on right arrow calls handleArrowClick with right', () => {
    mockCanScrollRight = true

    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })
    renderWithStore(<TabBar />, store)

    const rightArrow = screen.getByLabelText('Scroll tabs right')
    fireEvent.click(rightArrow)

    expect(mockHandleArrowClick).toHaveBeenCalledWith('right')
  })

  it('click on left arrow calls handleArrowClick with left', () => {
    mockCanScrollLeft = true

    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })
    renderWithStore(<TabBar />, store)

    const leftArrow = screen.getByLabelText('Scroll tabs left')
    fireEvent.click(leftArrow)

    expect(mockHandleArrowClick).toHaveBeenCalledWith('left')
  })

  it('arrow buttons have accessible aria-labels and are semantic buttons', () => {
    mockCanScrollLeft = true
    mockCanScrollRight = true

    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })
    renderWithStore(<TabBar />, store)

    const leftBtn = screen.getByLabelText('Scroll tabs left')
    const rightBtn = screen.getByLabelText('Scroll tabs right')

    expect(leftBtn.tagName).toBe('BUTTON')
    expect(rightBtn.tagName).toBe('BUTTON')
  })

  it('arrow buttons are outside the scrollable container', () => {
    mockCanScrollLeft = true
    mockCanScrollRight = true

    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })
    renderWithStore(<TabBar />, store)

    const leftBtn = screen.getByLabelText('Scroll tabs left')
    const rightBtn = screen.getByLabelText('Scroll tabs right')

    // Buttons should not be inside the overflow-x-auto scrollable container
    expect(leftBtn.closest('.overflow-x-auto')).toBeNull()
    expect(rightBtn.closest('.overflow-x-auto')).toBeNull()
  })

  it('hidden arrow buttons are removed from tab order', () => {
    mockCanScrollLeft = false
    mockCanScrollRight = true

    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })
    renderWithStore(<TabBar />, store)

    const leftBtn = screen.getByLabelText('Scroll tabs left')
    const rightBtn = screen.getByLabelText('Scroll tabs right')

    expect(leftBtn.getAttribute('tabindex')).toBe('-1')
    expect(rightBtn.getAttribute('tabindex')).toBe('0')
  })
})
