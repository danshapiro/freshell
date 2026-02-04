import { describe, it, expect, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { addTab } from '../../../src/store/tabsSlice'
import panesReducer from '../../../src/store/panesSlice'
import { layoutMirrorMiddleware } from '../../../src/store/layoutMirrorMiddleware'

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({ send: mockSend }),
}))

describe('layoutMirrorMiddleware', () => {
  it('sends ui.layout.sync after tab changes', () => {
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
})
