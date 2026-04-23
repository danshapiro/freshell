import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import agentChatReducer from '@/store/agentChatSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'

// jsdom doesn't implement scrollIntoView
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

// Mock useKeyboardInset to control keyboard inset value directly
const useKeyboardInsetMock = vi.hoisted(() => vi.fn(() => 0))
vi.mock('@/hooks/useKeyboardInset', () => ({ useKeyboardInset: useKeyboardInsetMock }))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(),
    onReconnect: vi.fn(() => vi.fn()),
  }),
}))

import AgentChatView from '@/components/agent-chat/AgentChatView'
import type { AgentChatPaneContent } from '@/store/paneTypes'

function createStore() {
  return configureStore({
    reducer: {
      agentChat: agentChatReducer,
      panes: panesReducer,
      settings: settingsReducer,
    },
  })
}

const basePaneContent: AgentChatPaneContent = {
  kind: 'agent-chat',
  provider: 'freshclaude',
  createRequestId: 'req-1',
  status: 'idle',
  sessionId: 'session-1',
}

describe('AgentChatView mobile keyboard', () => {
  afterEach(() => {
    cleanup()
    ;(globalThis as any).setMobileForTest(false)
  })

  it('applies keyboard inset padding to the outer container on mobile', () => {
    ;(globalThis as any).setMobileForTest(true)
    useKeyboardInsetMock.mockReturnValue(300)

    const store = createStore()
    const { container } = render(
      <Provider store={store}>
        <AgentChatView tabId="tab-1" paneId="pane-1" paneContent={basePaneContent} />
      </Provider>,
    )

    // The outermost container should have padding-bottom to push content above the keyboard
    const region = container.querySelector('[role="region"]') as HTMLElement
    expect(region).toBeTruthy()
    expect(region.style.paddingBottom).toBe('300px')
  })

  it('does not apply keyboard inset on desktop', () => {
    ;(globalThis as any).setMobileForTest(false)
    useKeyboardInsetMock.mockReturnValue(0)

    const store = createStore()
    const { container } = render(
      <Provider store={store}>
        <AgentChatView tabId="tab-1" paneId="pane-1" paneContent={basePaneContent} />
      </Provider>,
    )

    const region = container.querySelector('[role="region"]') as HTMLElement
    expect(region).toBeTruthy()
    expect(region.style.paddingBottom).toBeFalsy()
  })

  it('uses tighter horizontal padding (px-2) on mobile', () => {
    ;(globalThis as any).setMobileForTest(true)
    useKeyboardInsetMock.mockReturnValue(0)

    const store = createStore()
    const { container } = render(
      <Provider store={store}>
        <AgentChatView tabId="tab-1" paneId="pane-1" paneContent={basePaneContent} />
      </Provider>,
    )

    // The scroll container has data-context="agent-chat"
    const scrollContainer = container.querySelector('[data-context="agent-chat"]') as HTMLElement
    expect(scrollContainer).toBeTruthy()
    expect(scrollContainer.className).toContain('px-2')
    expect(scrollContainer.className).not.toContain('px-3')
  })

  it('uses standard horizontal padding (px-3) on desktop', () => {
    ;(globalThis as any).setMobileForTest(false)
    useKeyboardInsetMock.mockReturnValue(0)

    const store = createStore()
    const { container } = render(
      <Provider store={store}>
        <AgentChatView tabId="tab-1" paneId="pane-1" paneContent={basePaneContent} />
      </Provider>,
    )

    const scrollContainer = container.querySelector('[data-context="agent-chat"]') as HTMLElement
    expect(scrollContainer).toBeTruthy()
    expect(scrollContainer.className).toContain('px-3')
    expect(scrollContainer.className).not.toContain('px-2')
  })
})
