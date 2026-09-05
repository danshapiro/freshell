import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import panesReducer, { setActivePane, toggleZoom } from '@/store/panesSlice'
import tabsReducer from '@/store/tabsSlice'
import { TerminalInterestReporter } from '@/components/TerminalInterestReporter'

type Snapshot = { focusedTerminalId: string | null; visibleTerminalIds: string[] }

const wsMocks = vi.hoisted(() => ({
  sendTerminalInterest: vi.fn((snapshot: Snapshot) => true),
  messageHandlers: [] as Array<(message: { type: string }) => void>,
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    onMessage: (handler: (message: { type: string }) => void) => {
      wsMocks.messageHandlers.push(handler)
      return () => {
        wsMocks.messageHandlers = wsMocks.messageHandlers.filter((h) => h !== handler)
      }
    },
    sendTerminalInterest: wsMocks.sendTerminalInterest,
  }),
}))

type TestStore = ReturnType<typeof makeStore>

function leaf(id: string, terminalId: string) {
  return {
    type: 'leaf' as const,
    id,
    content: { kind: 'terminal' as const, terminalId },
  }
}

const twoPanes = () => ({
  type: 'split' as const,
  id: 'root',
  direction: 'horizontal' as const,
  children: [leaf('pane-a', 'TERM-A'), leaf('pane-b', 'TERM-B')] as [
    ReturnType<typeof leaf>,
    ReturnType<typeof leaf>,
  ],
  sizes: [50, 50] as [number, number],
})

function makeStore(workspaceVisible = true) {
  return configureStore({
    reducer: { panes: panesReducer, tabs: tabsReducer },
    preloadedState: {
      tabs: {
        tabs: [
          {
            id: 'tab-1',
            title: 'Tab 1',
            status: 'active' as const,
            type: 'shell' as const,
            createdAt: '2026-01-01T00:00:00.000Z',
            sessionKey: null,
            layoutSnapshot: null,
          },
        ],
        activeTabId: 'tab-1',
      } as any,
      panes: {
        layouts: { 'tab-1': twoPanes() },
        activePane: { 'tab-1': 'pane-a' },
        zoomedPane: {},
      } as any,
    },
  })
}

const unmounters: Array<() => void> = []

async function mountReporter(store: TestStore, workspaceVisible = true) {
  let utils!: ReturnType<typeof render>
  await act(async () => {
    utils = render(
      <Provider store={store}>
        <TerminalInterestReporter workspaceVisible={workspaceVisible} />
      </Provider>,
    )
    await Promise.resolve()
  })
  unmounters.push(() => utils.unmount())
  return utils
}


// The publisher coalesces store-driven updates onto a task (setTimeout(0));
// flush it after each interaction before asserting.
async function flushPublisher() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const lastSnapshot = (): Snapshot =>
  wsMocks.sendTerminalInterest.mock.calls.at(-1)![0]

describe('TerminalInterestReporter', () => {
  beforeEach(() => {
    wsMocks.sendTerminalInterest.mockClear()
    wsMocks.messageHandlers.length = 0
  })
  afterEach(() => {
    while (unmounters.length) unmounters.pop()!()
    vi.restoreAllMocks()
  })

  it('publishes focused+visible terminals from the active tab on mount', async () => {
    const store = makeStore()
    await mountReporter(store)
    expect(wsMocks.sendTerminalInterest).toHaveBeenCalled()
    expect(lastSnapshot()).toEqual({
      focusedTerminalId: 'TERM-A',
      visibleTerminalIds: ['TERM-A', 'TERM-B'],
    })
  })

  it('republishes when the active pane changes and when zoom isolates a pane', async () => {
    const store = makeStore()
    await mountReporter(store)
    const initialCalls = wsMocks.sendTerminalInterest.mock.calls.length

    store.dispatch(setActivePane({ tabId: 'tab-1', paneId: 'pane-b' }))
    await flushPublisher()
    expect(wsMocks.sendTerminalInterest.mock.calls.length).toBeGreaterThan(initialCalls)
    expect(lastSnapshot().focusedTerminalId).toBe('TERM-B')
    expect(lastSnapshot().visibleTerminalIds).toEqual(['TERM-A', 'TERM-B'])

    store.dispatch(toggleZoom({ tabId: 'tab-1', paneId: 'pane-b' }))
    await flushPublisher()
    expect(lastSnapshot()).toEqual({
      focusedTerminalId: 'TERM-B',
      visibleTerminalIds: ['TERM-B'],
    })
  })

  it('refreshes eagerly on a ready frame (reconnect flush)', async () => {
    const store = makeStore()
    await mountReporter(store)
    wsMocks.sendTerminalInterest.mockClear()
    await act(async () => {
      for (const handler of wsMocks.messageHandlers) handler({ type: 'ready' })
      await Promise.resolve()
    })
    expect(wsMocks.sendTerminalInterest).toHaveBeenCalledTimes(1)
    expect(lastSnapshot().focusedTerminalId).toBe('TERM-A')
  })

  it('reports the workspace as hidden immediately on visibilitychange', async () => {
    const store = makeStore()
    await mountReporter(store)
    await flushPublisher() // drain the mount-time scheduled flush
    wsMocks.sendTerminalInterest.mockClear()
    wsMocks.sendTerminalInterest.mockImplementation(() => true)
    const spy = vi.spyOn(Document.prototype, 'hidden', 'get').mockReturnValue(true)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })
    spy.mockRestore()
    const calls = wsMocks.sendTerminalInterest.mock.calls.map((c) => c[0])
    expect(calls.length).toBe(1)
    expect(lastSnapshot()).toEqual({ focusedTerminalId: null, visibleTerminalIds: [] })
  })

  it('reports empty interest while the workspace view is not terminal', async () => {
    const store = makeStore()
    await mountReporter(store, false)
    expect(wsMocks.sendTerminalInterest).toHaveBeenCalled()
    expect(lastSnapshot()).toEqual({ focusedTerminalId: null, visibleTerminalIds: [] })
  })
})
