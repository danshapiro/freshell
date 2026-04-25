import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import ChatComposer from '@/components/agent-chat/ChatComposer'

function createStore() {
  return configureStore({
    reducer: { tabs: tabsReducer },
    preloadedState: {
      tabs: { tabs: [], activeTabId: null },
    } as any,
  })
}

describe('ChatComposer mobile touch targets', () => {
  afterEach(() => {
    cleanup()
    ;(globalThis as any).setMobileForTest(false)
  })

  it('send button has min-h-11 min-w-11 on mobile', () => {
    ;(globalThis as any).setMobileForTest(true)
    const store = createStore()
    render(
      <Provider store={store}>
        <ChatComposer onSend={vi.fn()} onInterrupt={vi.fn()} />
      </Provider>,
    )
    const sendButton = screen.getByRole('button', { name: /send message/i })
    expect(sendButton.className).toContain('min-h-11')
    expect(sendButton.className).toContain('min-w-11')
  })

  it('stop button has min-h-11 min-w-11 on mobile', () => {
    ;(globalThis as any).setMobileForTest(true)
    const store = createStore()
    render(
      <Provider store={store}>
        <ChatComposer onSend={vi.fn()} onInterrupt={vi.fn()} isRunning />
      </Provider>,
    )
    const stopButton = screen.getByRole('button', { name: /stop generation/i })
    expect(stopButton.className).toContain('min-h-11')
    expect(stopButton.className).toContain('min-w-11')
  })

  it('send button does not have inflated touch targets on desktop', () => {
    ;(globalThis as any).setMobileForTest(false)
    const store = createStore()
    render(
      <Provider store={store}>
        <ChatComposer onSend={vi.fn()} onInterrupt={vi.fn()} />
      </Provider>,
    )
    const sendButton = screen.getByRole('button', { name: /send message/i })
    expect(sendButton.className).not.toContain('min-h-11')
  })

  it('textarea has larger min-height on mobile', () => {
    ;(globalThis as any).setMobileForTest(true)
    const store = createStore()
    render(
      <Provider store={store}>
        <ChatComposer onSend={vi.fn()} onInterrupt={vi.fn()} />
      </Provider>,
    )
    const textarea = screen.getByRole('textbox', { name: /chat message input/i })
    expect(textarea.className).toContain('min-h-11')
  })

  it('composer outer wrapper uses px-2 on mobile', () => {
    ;(globalThis as any).setMobileForTest(true)
    const store = createStore()
    const { container } = render(
      <Provider store={store}>
        <ChatComposer onSend={vi.fn()} onInterrupt={vi.fn()} />
      </Provider>,
    )
    const outerDiv = container.firstElementChild as HTMLElement
    expect(outerDiv.className).toContain('px-2')
    expect(outerDiv.className).not.toContain('px-3')
  })
})
