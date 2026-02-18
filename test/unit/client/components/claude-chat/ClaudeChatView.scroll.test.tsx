import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import ClaudeChatView from '@/components/claude-chat/ClaudeChatView'
import claudeChatReducer from '@/store/claudeChatSlice'
import panesReducer from '@/store/panesSlice'
import type { ClaudeChatPaneContent } from '@/store/paneTypes'

// jsdom doesn't implement scrollIntoView
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

// Mock ws-client
vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(),
    onReconnect: vi.fn(() => vi.fn()),
  }),
}))

function makeStore() {
  return configureStore({
    reducer: {
      claudeChat: claudeChatReducer,
      panes: panesReducer,
    },
  })
}

const basePaneContent: ClaudeChatPaneContent = {
  kind: 'claude-chat',
  createRequestId: 'test-req',
  status: 'idle',
  sessionId: 'test-session',
}

describe('ClaudeChatView visibility', () => {
  afterEach(cleanup)

  it('renders with tab-visible class when not hidden', () => {
    const store = makeStore()
    const { container } = render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={basePaneContent} />
      </Provider>
    )
    const region = container.querySelector('[role="region"]')
    expect(region).toBeInTheDocument()
    expect(region!.className).toContain('tab-visible')
  })

  it('renders with tab-hidden class when hidden (does NOT unmount)', () => {
    const store = makeStore()
    const { container } = render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={basePaneContent} hidden />
      </Provider>
    )
    const region = container.querySelector('[role="region"]')
    expect(region).toBeInTheDocument()
    expect(region!.className).toContain('tab-hidden')
  })
})
