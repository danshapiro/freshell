import { describe, it, expect, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { addTab } from '../../../src/store/tabsSlice'
import panesReducer, { initLayout, updatePaneTitle } from '../../../src/store/panesSlice'
import { layoutMirrorMiddleware } from '../../../src/store/layoutMirrorMiddleware'

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({ send: mockSend }),
}))

describe('layoutMirrorMiddleware', () => {
  it('sends ui.layout.sync after tab changes', () => {
    mockSend.mockClear()
    vi.useFakeTimers()
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
      middleware: (g) => g().concat(layoutMirrorMiddleware),
    })
    store.dispatch(addTab({ title: 'alpha' }))
    vi.runOnlyPendingTimers()
    expect(mockSend).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('dedupes unchanged layout payloads', () => {
    mockSend.mockClear()
    vi.useFakeTimers()
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
      middleware: (g) => g().concat(layoutMirrorMiddleware),
    })
    store.dispatch(addTab({ title: 'alpha' }))
    vi.runOnlyPendingTimers()
    expect(mockSend).toHaveBeenCalledTimes(1)

    store.dispatch({ type: 'noop' })
    vi.runOnlyPendingTimers()
    expect(mockSend).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('includes paneTitleSetByUser in mirrored layout payloads', () => {
    mockSend.mockClear()
    vi.useFakeTimers()
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
      middleware: (g) => g().concat(layoutMirrorMiddleware),
    })

    store.dispatch(addTab({ title: 'alpha' }))
    const tabId = store.getState().tabs.tabs[0]?.id
    expect(tabId).toBeTruthy()

    store.dispatch(initLayout({
      tabId: tabId!,
      content: { kind: 'terminal', mode: 'shell' },
    }))
    const paneId = (store.getState().panes.layouts[tabId!] as { id: string }).id

    mockSend.mockClear()
    store.dispatch(updatePaneTitle({ tabId: tabId!, paneId, title: 'Ops desk' }))
    vi.runOnlyPendingTimers()

    expect(mockSend).toHaveBeenLastCalledWith(expect.objectContaining({
      paneTitleSetByUser: {
        [tabId!]: {
          [paneId]: true,
        },
      },
    }))
    vi.useRealTimers()
  })
})
