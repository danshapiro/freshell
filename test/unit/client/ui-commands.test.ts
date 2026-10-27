import { describe, it, expect, beforeEach, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { handleUiCommand } from '../../../src/lib/ui-commands'
import { captureUiScreenshot } from '../../../src/lib/ui-screenshot'
import tabsReducer, { addTab } from '../../../src/store/tabsSlice'
import panesReducer, { initLayout } from '../../../src/store/panesSlice'
import sessionNamesReducer from '../../../src/store/sessionNamesSlice'
import { receiveSessionNames } from '../../../src/store/sessionNamesSlice'
import { sessionNameLifecycleMiddleware } from '../../../src/store/sessionNameLifecycleMiddleware'
import { savedNameTabTitleMirrorMiddleware } from '../../../src/store/savedNameTabTitleMirror'

vi.mock('../../../src/lib/ui-screenshot', () => ({
  captureUiScreenshot: vi.fn(),
}))

const apiPost = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message)
    }
  },
  // The naming read rides the real retry wrapper; the mock keeps it a
  // passthrough so the bootstrap path behaves exactly as production minus
  // the (never-hit in these fixtures) 429 backoff.
  with429Retry: async (attempt: () => Promise<unknown>) => attempt(),
  api: {
    get: vi.fn(),
    patch: vi.fn(),
    post: (...args: unknown[]) => apiPost(...args) as unknown as Promise<unknown>,
  },
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

  it('tab.create folds a non-empty caller-provided title as a user-set title; unnamed creates stay unset', () => {
    const actions: any[] = []
    const dispatch = (action: any) => { actions.push(action); return action }

    // Named create (REST/MCP `name`) — the title is an explicit creator title
    // and must outrank pane-title overrides (mirror / registry auto-titles)
    // in getTabDisplayTitle, before AND after a reload or restart.
    handleUiCommand({ type: 'ui.command', command: 'tab.create', payload: { id: 't-named', title: 'work' } }, dispatch)
    expect(actions[0].type).toBe('tabs/addTab')
    expect(actions[0].payload.titleSetByUser).toBe(true)

    // Unnamed create — no caller title; derived/mirror behavior unchanged.
    const actions2: any[] = []
    const dispatch2 = (action: any) => { actions2.push(action); return action }
    handleUiCommand({ type: 'ui.command', command: 'tab.create', payload: { id: 't-unnamed', title: null } }, dispatch2)
    expect(actions2[0].payload.titleSetByUser).toBeUndefined()
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

  it('a scoped pane.rename receipt folds an embedded canonical update and never writes a local alias (Task 5)', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer, sessionNames: sessionNamesReducer },
      preloadedState: {
        tabs: { tabs: [{ id: 't1', createRequestId: 't1', title: 'T1', status: 'running', mode: 'claude', createdAt: 1 }], activeTabId: 't1', renameRequestTabId: null },
        panes: {
          layouts: { t1: { type: 'leaf', id: 'p1', content: { kind: 'terminal', mode: 'claude', status: 'running', terminalId: 'term-1', sessionRef: { provider: 'claude', sessionId: 'sess-ui-1' } } } },
          activePane: { t1: 'p1' },
          paneTitles: { t1: { p1: 'freshell' } },
          paneTitleSetByUser: {},
          renameRequestTabId: null,
          renameRequestPaneId: null,
          zoomedPane: {},
          refreshRequestsByPane: {},
        },
      } as never,
    })
    const dispatched: any[] = []
    const runtime = {
      dispatch: (action: any) => {
        dispatched.push(action)
        return store.dispatch(action)
      },
      getState: () => store.getState(),
    }

    handleUiCommand({
      type: 'ui.command',
      command: 'pane.rename',
      payload: {
        tabId: 't1',
        paneId: 'p1',
        title: 'Agent-applied name',
        sessionName: {
          record: { ref: { kind: 'session', provider: 'claude', sessionId: 'sess-ui-1' }, name: 'Agent-applied name', source: 'first_message', revision: 7 },
          documentGeneration: 9,
          redirects: [],
          changed: true,
        },
      },
    }, runtime)

    const key = JSON.stringify(['session', 'claude', 'sess-ui-1'])
    expect(store.getState().sessionNames.records[key]?.name).toBe('Agent-applied name')
    // No local alias write ever fired: no pane-title alias, no thunk dispatch.
    expect(dispatched.some((a) => a.type === 'panes/updatePaneTitle' || a.type === 'panes/updatePaneTitleByTerminalId')).toBe(false)
    expect(dispatched.some((a) => typeof a === 'function')).toBe(false)
  })

  it('a scoped tab.rename receipt without an embedded record refetches and never writes a local alias (Task 5)', async () => {
    apiPost.mockResolvedValue({
      names: [{
        record: { ref: { kind: 'session', provider: 'claude', sessionId: 'sess-ui-2' }, name: 'Refetched canonical name', source: 'manual', revision: 2 },
        documentGeneration: 3,
        redirects: [],
        changed: false,
      }],
    })
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer, sessionNames: sessionNamesReducer },
      preloadedState: {
        tabs: { tabs: [{ id: 't1', createRequestId: 't1', title: 'T1', status: 'running', mode: 'claude', createdAt: 1 }], activeTabId: 't1', renameRequestTabId: null },
        panes: {
          layouts: { t1: { type: 'leaf', id: 'p1', content: { kind: 'terminal', mode: 'claude', status: 'running', terminalId: 'term-2', sessionRef: { provider: 'claude', sessionId: 'sess-ui-2' } } } },
          activePane: { t1: 'p1' },
          paneTitles: { t1: { p1: 'freshell' } },
          paneTitleSetByUser: {},
          renameRequestTabId: null,
          renameRequestPaneId: null,
          zoomedPane: {},
          refreshRequestsByPane: {},
        },
      } as never,
    })
    const dispatched: any[] = []
    const runtime = {
      dispatch: (action: any) => {
        dispatched.push(action)
        return store.dispatch(action)
      },
      getState: () => store.getState(),
    }

    handleUiCommand({
      type: 'ui.command',
      command: 'tab.rename',
      payload: { id: 't1', title: 'Agent-applied name' },
    }, runtime)

    // No local alias write, no manual flag, no second PATCH: the receipt is
    // consumed through a canonical refetch only.
    expect(dispatched.some((a) => a.type === 'panes/updatePaneTitle' || a.type === 'panes/updatePaneTitleByTerminalId')).toBe(false)
    expect(dispatched.some((a) => typeof a === 'function')).toBe(false)
    const { waitFor } = await import('@testing-library/react')
    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith('/api/session-names/read', expect.anything(), expect.anything())
      const key = JSON.stringify(['session', 'claude', 'sess-ui-2'])
      expect(store.getState().sessionNames.records[key]?.name).toBe('Refetched canonical name')
    })
  })
})

// Name reliability (plan Task 7): a ui.command never freezes or retitles a
// session-owned tab. Its stored title is the saved-name mirror, so a
// caller-provided create name is only a provisional display until the
// session's saved record arrives.
describe('ui.command titles of session-owned tabs', () => {
  function makeNamingStore(opts: { mirror: boolean }) {
    return configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer, sessionNames: sessionNamesReducer },
      middleware: (getDefault) => getDefault({ serializableCheck: false }).concat(
        ...(opts.mirror ? [savedNameTabTitleMirrorMiddleware] : []),
        sessionNameLifecycleMiddleware,
      ),
    })
  }

  function nameUpdate(sessionId: string, name: string, revision: number) {
    return {
      record: { ref: { kind: 'session' as const, provider: 'claude' as const, sessionId }, name, source: 'manual' as const, revision },
      documentGeneration: revision,
      redirects: [],
      changed: true,
    }
  }

  it('tab.create with a caller name on a Claude pane does not freeze the title', () => {
    const store = makeNamingStore({ mirror: true })
    const runtime = { dispatch: store.dispatch, getState: () => store.getState() as never }

    handleUiCommand({
      type: 'ui.command',
      command: 'tab.create',
      payload: {
        id: 't-agent',
        title: 'work',
        mode: 'claude',
        paneId: 'p-agent',
        paneContent: {
          kind: 'terminal',
          mode: 'claude',
          status: 'creating',
          createRequestId: 'c-agent',
          sessionRef: { provider: 'claude', sessionId: 'sess-create' },
        },
      },
    }, runtime)
    // A terminal-id create of a Codex agent (no explicit pane content).
    handleUiCommand({
      type: 'ui.command',
      command: 'tab.create',
      payload: { id: 't-codex', title: 'codex work', mode: 'codex', terminalId: 'term-codex', status: 'running' },
    }, runtime)
    // Out of scope: a named browser create keeps its user-set title.
    handleUiCommand({
      type: 'ui.command',
      command: 'tab.create',
      payload: { id: 't-browser', title: 'docs', paneId: 'p-browser', paneContent: { kind: 'browser', url: 'https://example.com', devToolsOpen: false } },
    }, runtime)

    const tabs = Object.fromEntries(store.getState().tabs.tabs.map((tab) => [tab.id, tab]))
    expect(tabs['t-agent'].title).toBe('work')
    expect(tabs['t-agent'].titleSetByUser).toBeUndefined()
    expect(tabs['t-codex'].titleSetByUser).toBeUndefined()
    expect(tabs['t-browser'].titleSetByUser).toBe(true)

    // When the session's saved record arrives the tab follows it.
    store.dispatch(receiveSessionNames([nameUpdate('sess-create', 'LotL', 1)]))
    const agentTab = store.getState().tabs.tabs.find((tab) => tab.id === 't-agent')
    expect(agentTab?.title).toBe('LotL')
    expect(agentTab?.titleSetByUser).toBeUndefined()
  })

  it('tab.rename for a session-owned tab is consumed as a scoped rename', () => {
    const store = makeNamingStore({ mirror: false })
    store.dispatch(addTab({ id: 't-owned', title: 'LotL', mode: 'claude' }))
    store.dispatch(initLayout({
      tabId: 't-owned',
      paneId: 'p-owned',
      content: {
        kind: 'terminal',
        mode: 'claude',
        status: 'running',
        createRequestId: 'c-owned',
        sessionRef: { provider: 'claude', sessionId: 'sess-owned' },
      },
    }))
    expect(store.getState().tabs.tabs[0].nameSource).toEqual({ kind: 'session', paneId: 'p-owned' })
    const dispatched: any[] = []
    const runtime = {
      dispatch: (action: any) => {
        dispatched.push(action)
        return store.dispatch(action)
      },
      getState: () => store.getState() as never,
    }

    handleUiCommand({
      type: 'ui.command',
      command: 'tab.rename',
      payload: { id: 't-owned', title: 'Agent-applied name', sessionName: nameUpdate('sess-owned', 'Agent-applied name', 2) },
    }, runtime)

    // Consumed through the canonical cache: no legacy tab rename (which
    // would store the title AND freeze it with titleSetByUser).
    expect(dispatched.some((action) => typeof action === 'function')).toBe(false)
    expect(dispatched.some((action) => action?.type === 'tabs/updateTab')).toBe(false)
    const tab = store.getState().tabs.tabs[0]
    expect(tab.titleSetByUser).toBeUndefined()
    expect(tab.title).toBe('LotL')
    const key = JSON.stringify(['session', 'claude', 'sess-owned'])
    expect(store.getState().sessionNames.records[key]?.name).toBe('Agent-applied name')
  })
})
