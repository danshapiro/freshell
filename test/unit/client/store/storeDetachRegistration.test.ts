import { describe, it, expect, vi } from 'vitest'

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockSend,
    connect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn().mockReturnValue(() => {}),
    onReconnect: vi.fn().mockReturnValue(() => {}),
    onDisconnect: vi.fn().mockReturnValue(() => {}),
  }),
  resetWsClientForTests: vi.fn(),
}))

import { store } from '@/store/store'
import { initLayout, removeLayout } from '@/store/panesSlice'

describe('production store', () => {
  it('registers terminalDetachMiddleware (removing a layout emits terminal.detach)', () => {
    store.dispatch(initLayout({
      tabId: 'detach-reg-tab',
      paneId: 'detach-reg-pane',
      content: {
        kind: 'terminal',
        mode: 'shell',
        status: 'running',
        terminalId: 'detach-reg-term',
        createRequestId: 'detach-reg-req',
      },
    }))
    mockSend.mockClear()
    store.dispatch(removeLayout({ tabId: 'detach-reg-tab' }))
    // removeLayout is the closeTab thunk's layout removal — a pane close —
    // so the detach carries the closing pane's createRequestId (delta-round-7
    // F2: the durable non-retiring pane-close record's key).
    expect(mockSend).toHaveBeenCalledWith({
      type: 'terminal.detach',
      terminalId: 'detach-reg-term',
      createRequestId: 'detach-reg-req',
    })
  })
})
