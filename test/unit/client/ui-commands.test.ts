import { describe, it, expect, beforeEach, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { handleUiCommand } from '../../../src/lib/ui-commands'
import { captureUiScreenshot } from '../../../src/lib/ui-screenshot'
import tabsReducer from '../../../src/store/tabsSlice'
import panesReducer from '../../../src/store/panesSlice'

vi.mock('../../../src/lib/ui-screenshot', () => ({
  captureUiScreenshot: vi.fn(),
}))

describe('handleUiCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('handles tab.create', () => {
    const actions: any[] = []
    const dispatch = (action: any) => {
      actions.push(action)
      return action
    }

    handleUiCommand({ type: 'ui.command', command: 'tab.create', payload: { id: 't1', title: 'Alpha' } }, dispatch)
    expect(actions[0].type).toBe('tabs/addTab')
  })

  it('tab.create dispatches addTab with activate: false (agent actions must not steal focus)', () => {
    const actions: any[] = []
    const dispatch = (action: any) => { actions.push(action); return action }

    handleUiCommand({ type: 'ui.command', command: 'tab.create', payload: { id: 't1', title: 'Alpha' } }, dispatch)

    expect(actions[0].type).toBe('tabs/addTab')
    expect(actions[0].payload.activate).toBe(false)
  })

  it('initializes layout when tab.create includes pane content', () => {
    const actions: any[] = []
    const dispatch = (action: any) => {
      actions.push(action)
      return action
    }

    handleUiCommand({
      type: 'ui.command',
      command: 'tab.create',
      payload: { id: 't1', title: 'Alpha', paneId: 'pane-1', paneContent: { kind: 'browser', url: 'https://example.com', devToolsOpen: false } },
    }, dispatch)

    expect(actions.map((a) => a.type)).toEqual(['tabs/addTab', 'panes/initLayout'])
    expect(actions[1].payload.paneId).toBe('pane-1')
    expect(actions[1].payload.content.kind).toBe('browser')
  })

  it('passes through newPaneId on pane.split', () => {
    const actions: any[] = []
    const dispatch = (action: any) => {
      actions.push(action)
      return action
    }

    handleUiCommand({
      type: 'ui.command',
      command: 'pane.split',
      payload: { tabId: 't1', paneId: 'p1', direction: 'horizontal', newPaneId: 'p2', newContent: { kind: 'terminal', mode: 'shell' } },
    }, dispatch)

    expect(actions[0].type).toBe('panes/splitPane')
    expect(actions[0].payload.newPaneId).toBe('p2')
  })

  it('pane.split dispatches splitPane with activate: false', () => {
    const actions: any[] = []
    const dispatch = (action: any) => { actions.push(action); return action }

    handleUiCommand({
      type: 'ui.command',
      command: 'pane.split',
      payload: { tabId: 't1', paneId: 'p1', direction: 'horizontal', newPaneId: 'p2', newContent: { kind: 'terminal', mode: 'shell' } },
    }, dispatch)

    expect(actions[0].type).toBe('panes/splitPane')
    expect(actions[0].payload.newPaneId).toBe('p2')
    expect(actions[0].payload.activate).toBe(false)
  })

  it('handles pane.resize and pane.swap', () => {
    const actions: any[] = []
    const dispatch = (action: any) => {
      actions.push(action)
      return action
    }

    handleUiCommand({
      type: 'ui.command',
      command: 'pane.resize',
      payload: { tabId: 't1', splitId: 's1', sizes: [30, 70] },
    }, dispatch)

    handleUiCommand({
      type: 'ui.command',
      command: 'pane.swap',
      payload: { tabId: 't1', paneId: 'p1', otherId: 'p2' },
    }, dispatch)

    expect(actions[0].type).toBe('panes/resizePanes')
    expect(actions[1].type).toBe('panes/swapPanes')
  })

  it('selects the tab before selecting a pane', () => {
    const actions: any[] = []
    const dispatch = (action: any) => {
      actions.push(action)
      return action
    }

    handleUiCommand({
      type: 'ui.command',
      command: 'pane.select',
      payload: { tabId: 't1', paneId: 'p1' },
    }, dispatch)

    expect(actions.map((a) => a.type)).toEqual(['tabs/setActiveTab', 'panes/setActivePane'])
    expect(actions[0].payload).toBe('t1')
    // focusNudge: explicit selects must move DOM focus even for an already-
    // active target (no eligibility transition exists to re-run focus
    // effects); the epoch bump is that signal.
    expect(actions[1].payload).toEqual({ tabId: 't1', paneId: 'p1', focusNudge: true })
  })

  it('handles pane.rename', () => {
    const actions: any[] = []
    const dispatch = (action: any) => {
      actions.push(action)
      return action
    }

    handleUiCommand({
      type: 'ui.command',
      command: 'pane.rename',
      payload: { tabId: 't1', paneId: 'p1', title: 'Logs' },
    }, dispatch)

    expect(actions).toHaveLength(1)
    expect(typeof actions[0]).toBe('function')
  })

  it('dispatches closeTab thunk for tab.close', () => {
    const actions: any[] = []
    const dispatch = (action: any) => {
      actions.push(action)
      return action
    }

    handleUiCommand({
      type: 'ui.command',
      command: 'tab.close',
      payload: { id: 't1' },
    }, dispatch)

    // closeTab is a createAsyncThunk — dispatch receives the thunk function
    expect(actions).toHaveLength(1)
    expect(typeof actions[0]).toBe('function')
  })

  it('dispatches closePaneWithCleanup thunk for pane.close', () => {
    const actions: any[] = []
    const dispatch = (action: any) => {
      actions.push(action)
      return action
    }

    handleUiCommand({
      type: 'ui.command',
      command: 'pane.close',
      payload: { tabId: 't1', paneId: 'p1' },
    }, dispatch)

    // closePaneWithCleanup is a createAsyncThunk — dispatch receives the thunk function
    expect(actions).toHaveLength(1)
    expect(typeof actions[0]).toBe('function')
  })

  it('delegates screenshot.capture and sends ui.screenshot.result', async () => {
    const dispatch = vi.fn()
    const send = vi.fn()

    vi.mocked(captureUiScreenshot).mockResolvedValue({
      ok: true,
      changedFocus: false,
      restoredFocus: false,
      mimeType: 'image/png',
      imageBase64: 'aGVsbG8=',
      width: 100,
      height: 50,
    })

    handleUiCommand(
      {
        type: 'ui.command',
        command: 'screenshot.capture',
        payload: { requestId: 'req-1', scope: 'view' },
      },
      { dispatch: dispatch as any, send },
    )

    await Promise.resolve()

    expect(captureUiScreenshot).toHaveBeenCalledWith(
      { scope: 'view', paneId: undefined, tabId: undefined },
    )
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ui.screenshot.result',
      requestId: 'req-1',
      ok: true,
      changedFocus: false,
      restoredFocus: false,
    }))
  })

  it('rejects an invalid screenshot scope with an error result frame', async () => {
    const dispatch = vi.fn()
    const send = vi.fn()

    handleUiCommand(
      {
        type: 'ui.command',
        command: 'screenshot.capture',
        payload: { requestId: 'req-bad', scope: 'universe' },
      },
      { dispatch: dispatch as any, send },
    )

    await Promise.resolve()

    expect(vi.mocked(captureUiScreenshot)).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ui.screenshot.result',
      requestId: 'req-bad',
      ok: false,
      error: 'invalid screenshot scope',
    }))
  })

  it('forwards a failing capture honestly on the result frame', async () => {
    const dispatch = vi.fn()
    const send = vi.fn()

    vi.mocked(captureUiScreenshot).mockResolvedValue({
      ok: false,
      changedFocus: false,
      restoredFocus: false,
      error: 'capture target not found',
    })

    handleUiCommand(
      {
        type: 'ui.command',
        command: 'screenshot.capture',
        payload: { requestId: 'req-err', scope: 'pane', paneId: 'pane-x' },
      },
      { dispatch: dispatch as any, send },
    )

    await Promise.resolve()

    expect(captureUiScreenshot).toHaveBeenCalledWith(
      { scope: 'pane', paneId: 'pane-x', tabId: undefined },
    )
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ui.screenshot.result',
      requestId: 'req-err',
      ok: false,
      error: 'capture target not found',
    }))
  })
})

describe('ui.command focus neutrality through a real Redux store', () => {
  function makeUiStore() {
    return configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
      middleware: (getDefault) => getDefault({ serializableCheck: false }),
      preloadedState: {
        tabs: {
          tabs: [{
            id: 'tab-A',
            createRequestId: 'req-A',
            title: 'Tab A',
            status: 'running' as const,
            mode: 'shell' as const,
            shell: 'system' as const,
            createdAt: 1,
          }],
          activeTabId: 'tab-A',
          renameRequestTabId: null,
        },
        panes: {
          layouts: {
            'tab-A': { type: 'leaf' as const, id: 'pane-A1', content: { kind: 'terminal' as const, mode: 'shell' as const, status: 'running' as const, terminalId: 'term-A1' } },
          },
          activePane: { 'tab-A': 'pane-A1' },
          paneTitles: { 'tab-A': { 'pane-A1': 'Tab A' } },
          paneTitleSetByUser: {},
          renameRequestTabId: null,
          renameRequestPaneId: null,
          zoomedPane: {},
          refreshRequestsByPane: {},
        },
      } as any,
    })
  }

  it('tab.create never activates; explicit tab.select still does', () => {
    const store = makeUiStore()
    handleUiCommand({ type: 'ui.command', command: 'tab.create', payload: { id: 'tab-B', title: 'Agent tab' } }, store.dispatch)
    expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['tab-A', 'tab-B'])
    expect(store.getState().tabs.activeTabId).toBe('tab-A')

    handleUiCommand({ type: 'ui.command', command: 'tab.select', payload: { id: 'tab-B' } }, store.dispatch)
    expect(store.getState().tabs.activeTabId).toBe('tab-B')
  })

  it('pane.split never activates; explicit pane.select still does', () => {
    const store = makeUiStore()
    handleUiCommand({
      type: 'ui.command',
      command: 'pane.split',
      payload: { tabId: 'tab-A', paneId: 'pane-A1', direction: 'horizontal', newPaneId: 'pane-A2', newContent: { kind: 'terminal', mode: 'shell' } },
    }, store.dispatch)
    expect(store.getState().panes.layouts['tab-A'].type).toBe('split')
    expect(store.getState().panes.activePane['tab-A']).toBe('pane-A1')

    handleUiCommand({ type: 'ui.command', command: 'pane.select', payload: { tabId: 'tab-A', paneId: 'pane-A2' } }, store.dispatch)
    expect(store.getState().panes.activePane['tab-A']).toBe('pane-A2')
    expect(store.getState().tabs.activeTabId).toBe('tab-A')
  })

  it('pane.select on the ALREADY-active pane still emits a focus nudge (same-target select)', () => {
    const store = makeUiStore()
    // pane-A1 is already the active pane of the active tab: the select fold
    // produces no eligibility transition, so the focus epoch is the contract.
    handleUiCommand({ type: 'ui.command', command: 'pane.select', payload: { tabId: 'tab-A', paneId: 'pane-A1' } }, store.dispatch)
    expect(store.getState().panes.activePane['tab-A']).toBe('pane-A1')
    expect(store.getState().panes.focusEpochByPaneId?.['pane-A1'] ?? 0).toBe(1)
  })

  it("tab.select nudges the target tab's active pane focus epoch", () => {
    const store = makeUiStore()
    // Same-tab select (tab-A is already active)
    handleUiCommand({ type: 'ui.command', command: 'tab.select', payload: { id: 'tab-A' } }, store.dispatch)
    expect(store.getState().panes.focusEpochByPaneId?.['pane-A1'] ?? 0).toBe(1)
    // Cross-tab select also nudges the newly-active tab's pane (harmless;
    // the eligibility flip is the primary focus path there).
    handleUiCommand({ type: 'ui.command', command: 'tab.create', payload: { id: 'tab-B', title: 'B' } }, store.dispatch)
    handleUiCommand({ type: 'ui.command', command: 'tab.select', payload: { id: 'tab-B' } }, store.dispatch)
    expect(store.getState().tabs.activeTabId).toBe('tab-B')
    expect(store.getState().panes.focusEpochByPaneId?.['pane-A1']).toBe(1) // unchanged: tab-B has no active pane
  })
})
