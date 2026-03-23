import { describe, it, expect, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { addTab } from '../../../src/store/tabsSlice'
import panesReducer, { initLayout, mergePaneContent, updatePaneTitle } from '../../../src/store/panesSlice'
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

  it('includes fallbackSessionRef for no-layout local session tabs', () => {
    mockSend.mockClear()
    vi.useFakeTimers()
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
      middleware: (g) => g().concat(layoutMirrorMiddleware),
    })

    store.dispatch(addTab({
      id: 'tab-1',
      title: 'alpha',
      mode: 'codex',
      resumeSessionId: 'older-open',
    }))

    vi.runOnlyPendingTimers()

    expect(mockSend).toHaveBeenCalledWith({
      type: 'ui.layout.sync',
      tabs: [
        {
          id: 'tab-1',
          title: 'alpha',
          fallbackSessionRef: {
            provider: 'codex',
            sessionId: 'older-open',
          },
        },
      ],
      activeTabId: 'tab-1',
      layouts: {},
      activePane: {},
      paneTitles: {},
      paneTitleSetByUser: {},
      timestamp: expect.any(Number),
    })

    vi.useRealTimers()
  })

  it('includes cwd in fallbackSessionRef for no-layout Kimi tabs', () => {
    mockSend.mockClear()
    vi.useFakeTimers()
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
      middleware: (g) => g().concat(layoutMirrorMiddleware),
    })

    store.dispatch(addTab({
      id: 'tab-kimi',
      title: 'kimi tab',
      mode: 'kimi',
      resumeSessionId: 'team:alpha',
      initialCwd: '/repo/worktrees/app',
    }))

    vi.runOnlyPendingTimers()

    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ui.layout.sync',
      tabs: [
        {
          id: 'tab-kimi',
          title: 'kimi tab',
          fallbackSessionRef: {
            provider: 'kimi',
            sessionId: 'team:alpha',
            cwd: '/repo/worktrees/app',
          },
        },
      ],
    }))

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

  it('coalesces initial terminal lifecycle churn into a single mirrored sync', () => {
    mockSend.mockClear()
    vi.useFakeTimers()
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
      middleware: (g) => g().concat(layoutMirrorMiddleware),
    })

    store.dispatch(addTab({ id: 'tab-1', title: 'alpha' }))
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: { kind: 'terminal', mode: 'shell' },
    }))

    mockSend.mockClear()
    vi.advanceTimersByTime(999)
    expect(mockSend).not.toHaveBeenCalled()

    store.dispatch(mergePaneContent({
      tabId: 'tab-1',
      paneId: 'pane-1',
      updates: {
        terminalId: 'term-1',
        status: 'running',
      } as any,
    }))
    store.dispatch(updatePaneTitle({
      tabId: 'tab-1',
      paneId: 'pane-1',
      title: 'Terminal Audit',
      setByUser: false,
    }))

    vi.advanceTimersByTime(1000)

    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockSend).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'ui.layout.sync',
      activeTabId: 'tab-1',
      layouts: {
        'tab-1': expect.objectContaining({
          id: 'pane-1',
          type: 'leaf',
          content: expect.objectContaining({
            kind: 'terminal',
            terminalId: 'term-1',
            status: 'running',
          }),
        }),
      },
    }))

    vi.useRealTimers()
  })
})
