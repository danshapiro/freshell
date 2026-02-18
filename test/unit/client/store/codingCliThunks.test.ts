import { describe, it, expect, vi, beforeEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import codingCliReducer from '@/store/codingCliSlice'
import { createCodingCliTab } from '@/store/codingCliThunks'
import { cancelCodingCliRequest } from '@/store/codingCliSlice'

const mockSend = vi.fn()
const mockConnect = vi.fn().mockResolvedValue(undefined)
let messageHandler: ((msg: any) => void) | null = null

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockSend,
    connect: mockConnect,
    onMessage: (handler: (msg: any) => void) => {
      messageHandler = handler
      return () => {}
    },
  }),
}))

function createStore() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      codingCli: codingCliReducer,
    },
    preloadedState: {
      tabs: { tabs: [], activeTabId: null },
      codingCli: { sessions: {}, pendingRequests: {} },
    },
  })
}

describe('codingCliThunks', () => {
  beforeEach(() => {
    mockSend.mockClear()
    mockConnect.mockClear()
    messageHandler = null
  })

  it('creates a coding CLI tab and updates it when the session is created', async () => {
    const store = createStore()

    const promise = store.dispatch(
      createCodingCliTab({ provider: 'codex', prompt: 'Do the thing' })
    )

    const tabsAfterAdd = store.getState().tabs.tabs
    expect(tabsAfterAdd).toHaveLength(1)
    const tab = tabsAfterAdd[0]
    expect(tab.codingCliProvider).toBe('codex')
    expect(tab.codingCliSessionId).toBeDefined()
    expect(tab.status).toBe('creating')
    expect(tab.mode).toBe('codex')

    await Promise.resolve()

    const sent = mockSend.mock.calls[0]?.[0]
    expect(sent).toMatchObject({
      type: 'codingcli.create',
      provider: 'codex',
      prompt: 'Do the thing',
      cwd: undefined,
    })
    expect(sent?.requestId).toBe(tab.codingCliSessionId)

    messageHandler?.({
      type: 'codingcli.created',
      requestId: tab.codingCliSessionId,
      sessionId: 'session-123',
      provider: 'codex',
    })

    await promise

    const updatedTab = store.getState().tabs.tabs[0]
    expect(updatedTab.codingCliSessionId).toBe('session-123')
    expect(updatedTab.status).toBe('running')
    expect(store.getState().codingCli.sessions['session-123']).toBeDefined()
  })

  it('times out after 30s and sets tab to error state', async () => {
    vi.useFakeTimers()
    try {
      const store = createStore()

      const promise = store.dispatch(
        createCodingCliTab({ provider: 'codex', prompt: 'Slow creation' })
      )

      const tab = store.getState().tabs.tabs[0]
      expect(tab.status).toBe('creating')

      // Advance past the 30s timeout
      await vi.advanceTimersByTimeAsync(30_000)

      const result = await promise
      expect(result.type).toBe('codingCli/createTab/rejected')
      expect(result.error?.message).toBe('Coding CLI creation timed out after 30 seconds')

      // Tab should be in error state
      const updatedTab = store.getState().tabs.tabs[0]
      expect(updatedTab.status).toBe('error')

      // Pending request should be cleaned up
      const requestId = tab.codingCliSessionId as string
      expect(store.getState().codingCli.pendingRequests[requestId]).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('kills a late-created session that arrives after timeout', async () => {
    vi.useFakeTimers()
    try {
      const store = createStore()

      const promise = store.dispatch(
        createCodingCliTab({ provider: 'codex', prompt: 'Late create' })
      )

      const tab = store.getState().tabs.tabs[0]
      const requestId = tab.codingCliSessionId as string

      await vi.advanceTimersByTimeAsync(30_000)
      await promise

      messageHandler?.({
        type: 'codingcli.created',
        requestId,
        sessionId: 'session-late',
        provider: 'codex',
      })

      expect(mockSend).toHaveBeenCalledWith({
        type: 'codingcli.kill',
        sessionId: 'session-late',
      })
      expect(store.getState().codingCli.sessions['session-late']).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('kills created session when request was canceled', async () => {
    const store = createStore()

    const promise = store.dispatch(
      createCodingCliTab({ provider: 'claude', prompt: 'Cancel me' })
    )

    const tab = store.getState().tabs.tabs[0]
    const requestId = tab.codingCliSessionId as string

    store.dispatch(cancelCodingCliRequest({ requestId }))

    await Promise.resolve()

    messageHandler?.({
      type: 'codingcli.created',
      requestId,
      sessionId: 'session-canceled',
      provider: 'claude',
    })

    const result = await promise
    expect(result.type).toBe('codingCli/createTab/rejected')
    expect(result.error?.message).toBe('Canceled')

    expect(mockSend).toHaveBeenCalledWith({
      type: 'codingcli.kill',
      sessionId: 'session-canceled',
    })
    expect(store.getState().codingCli.sessions['session-canceled']).toBeUndefined()
  })
})
