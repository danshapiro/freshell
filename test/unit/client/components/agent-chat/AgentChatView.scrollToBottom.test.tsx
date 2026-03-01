import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import AgentChatView from '@/components/agent-chat/AgentChatView'
import agentChatReducer, {
  sessionCreated,
  addUserMessage,
  addAssistantMessage,
  setSessionStatus,
} from '@/store/agentChatSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import type { AgentChatPaneContent } from '@/store/paneTypes'

// jsdom doesn't implement scrollIntoView
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(),
    onReconnect: vi.fn(() => vi.fn()),
  }),
}))

function makeStore() {
  return configureStore({
    reducer: {
      agentChat: agentChatReducer,
      panes: panesReducer,
      settings: settingsReducer,
    },
  })
}

const BASE_PANE: AgentChatPaneContent = {
  kind: 'agent-chat', provider: 'freshclaude',
  createRequestId: 'req-1',
  sessionId: 'sess-1',
  status: 'idle',
}

function setupSessionWithMessages(store: ReturnType<typeof makeStore>, msgCount: number) {
  store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
  for (let i = 0; i < msgCount; i++) {
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: `Question ${i + 1}` }))
    store.dispatch(addAssistantMessage({
      sessionId: 'sess-1',
      content: [{ type: 'text', text: `Answer ${i + 1}` }],
    }))
  }
  store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))
}

/** Simulate scroll position on the scroll container. */
function simulateScrollPosition(container: HTMLElement, opts: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(container, 'scrollTop', { value: opts.scrollTop, writable: true, configurable: true })
  Object.defineProperty(container, 'scrollHeight', { value: opts.scrollHeight, writable: true, configurable: true })
  Object.defineProperty(container, 'clientHeight', { value: opts.clientHeight, writable: true, configurable: true })
}

describe('Scroll-to-bottom button', () => {
  afterEach(cleanup)

  it('does not show scroll-to-bottom button when at the bottom', () => {
    const store = makeStore()
    setupSessionWithMessages(store, 2)

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    // By default isAtBottom is true, so button should not appear
    expect(screen.queryByLabelText('Scroll to bottom')).not.toBeInTheDocument()
  })

  it('shows scroll-to-bottom button when scrolled away from bottom', () => {
    const store = makeStore()
    setupSessionWithMessages(store, 2)

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    // Find the scroll container
    const scrollContainer = screen.getByRole('region').querySelector('[data-context="agent-chat"]')!
    // Simulate being scrolled up (far from bottom)
    simulateScrollPosition(scrollContainer as HTMLElement, {
      scrollTop: 0,
      scrollHeight: 2000,
      clientHeight: 500,
    })
    fireEvent.scroll(scrollContainer)

    expect(screen.getByLabelText('Scroll to bottom')).toBeInTheDocument()
  })

  it('hides scroll-to-bottom button when scrolled back to bottom', () => {
    const store = makeStore()
    setupSessionWithMessages(store, 2)

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    const scrollContainer = screen.getByRole('region').querySelector('[data-context="agent-chat"]')!

    // Scroll away from bottom
    simulateScrollPosition(scrollContainer as HTMLElement, {
      scrollTop: 0,
      scrollHeight: 2000,
      clientHeight: 500,
    })
    fireEvent.scroll(scrollContainer)
    expect(screen.getByLabelText('Scroll to bottom')).toBeInTheDocument()

    // Scroll back to bottom (within threshold)
    simulateScrollPosition(scrollContainer as HTMLElement, {
      scrollTop: 1470,
      scrollHeight: 2000,
      clientHeight: 500,
    })
    fireEvent.scroll(scrollContainer)
    expect(screen.queryByLabelText('Scroll to bottom')).not.toBeInTheDocument()
  })

  it('scrolls to bottom when button is clicked', () => {
    const store = makeStore()
    setupSessionWithMessages(store, 2)

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    const scrollContainer = screen.getByRole('region').querySelector('[data-context="agent-chat"]')!

    // Scroll away from bottom
    simulateScrollPosition(scrollContainer as HTMLElement, {
      scrollTop: 0,
      scrollHeight: 2000,
      clientHeight: 500,
    })
    fireEvent.scroll(scrollContainer)

    // Clear any prior scrollIntoView calls from mount/auto-scroll
    ;(Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mockClear()

    const button = screen.getByLabelText('Scroll to bottom')
    fireEvent.click(button)

    // scrollIntoView should have been called exactly by the click handler
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1)
  })
})

describe('New message indicator badge', () => {
  afterEach(cleanup)

  it('shows badge when new message arrives while scrolled up', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'Question 1' }))
    store.dispatch(addAssistantMessage({
      sessionId: 'sess-1',
      content: [{ type: 'text', text: 'Answer 1' }],
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))

    const { rerender } = render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    const scrollContainer = screen.getByRole('region').querySelector('[data-context="agent-chat"]')!

    // Scroll away from bottom
    simulateScrollPosition(scrollContainer as HTMLElement, {
      scrollTop: 0,
      scrollHeight: 2000,
      clientHeight: 500,
    })
    fireEvent.scroll(scrollContainer)

    // Now a new message arrives
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'Question 2' }))
    store.dispatch(addAssistantMessage({
      sessionId: 'sess-1',
      content: [{ type: 'text', text: 'Answer 2' }],
    }))

    // Re-render to pick up store changes
    rerender(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    // The scroll-to-bottom button should show the new message badge
    const button = screen.getByLabelText('Scroll to bottom')
    const badge = button.querySelector('[data-testid="new-message-badge"]')
    expect(badge).toBeInTheDocument()
  })

  it('clears badge when scroll-to-bottom button is clicked', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'Question 1' }))
    store.dispatch(addAssistantMessage({
      sessionId: 'sess-1',
      content: [{ type: 'text', text: 'Answer 1' }],
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))

    const { rerender } = render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    const scrollContainer = screen.getByRole('region').querySelector('[data-context="agent-chat"]')!

    // Scroll away from bottom
    simulateScrollPosition(scrollContainer as HTMLElement, {
      scrollTop: 0,
      scrollHeight: 2000,
      clientHeight: 500,
    })
    fireEvent.scroll(scrollContainer)

    // New message arrives
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'Question 2' }))
    store.dispatch(addAssistantMessage({
      sessionId: 'sess-1',
      content: [{ type: 'text', text: 'Answer 2' }],
    }))

    rerender(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    // Click scroll-to-bottom
    const button = screen.getByLabelText('Scroll to bottom')
    fireEvent.click(button)

    // Badge should be cleared (button may also disappear since clicking scrolls to bottom)
    const badgeAfterClick = screen.queryByTestId('new-message-badge')
    expect(badgeAfterClick).not.toBeInTheDocument()
  })

  it('does not show badge when new message arrives while at bottom', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'Question 1' }))
    store.dispatch(addAssistantMessage({
      sessionId: 'sess-1',
      content: [{ type: 'text', text: 'Answer 1' }],
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))

    const { rerender } = render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    // Stay at bottom (default state) - add another message
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'Question 2' }))
    store.dispatch(addAssistantMessage({
      sessionId: 'sess-1',
      content: [{ type: 'text', text: 'Answer 2' }],
    }))

    rerender(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    // No scroll-to-bottom button at all since we're at bottom
    expect(screen.queryByLabelText('Scroll to bottom')).not.toBeInTheDocument()
  })
})
