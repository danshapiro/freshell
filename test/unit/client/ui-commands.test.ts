import { describe, it, expect, beforeEach, vi } from 'vitest'
import { handleUiCommand } from '../../../src/lib/ui-commands'
import { captureUiScreenshot } from '../../../src/lib/ui-screenshot'

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
    expect(actions[0].payload.titleSource).toBe('stable')
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

    expect(actions.map((a) => a.type)).toEqual(['tabs/addTab', 'panes/initLayout', 'panes/updatePaneTitle'])
    expect(actions[1].payload.paneId).toBe('pane-1')
    expect(actions[1].payload.content.kind).toBe('browser')
    expect(actions[2].payload).toEqual({
      tabId: 't1',
      paneId: 'pane-1',
      title: 'Alpha',
      source: 'stable',
    })
  })

  it('preserves createRequestId and synthesizes exact local sessionRef for server-originated coding panes', () => {
    const actions: any[] = []
    const dispatch = (action: any) => {
      actions.push(action)
      return action
    }

    handleUiCommand({
      type: 'ui.command',
      command: 'tab.create',
      payload: {
        id: 't1',
        title: 'Codex',
        mode: 'codex',
        resumeSessionId: 'codex-session-123',
        paneId: 'pane-1',
        paneContent: {
          kind: 'terminal',
          mode: 'codex',
          shell: 'system',
          createRequestId: 'req-codex',
          resumeSessionId: 'codex-session-123',
        },
      },
    }, {
      dispatch,
      getState: () => ({
        connection: { serverInstanceId: 'srv-local' },
      } as any),
    })

    expect(actions[1].payload.content).toMatchObject({
      createRequestId: 'req-codex',
      resumeSessionId: 'codex-session-123',
      sessionRef: {
        provider: 'codex',
        sessionId: 'codex-session-123',
        serverInstanceId: 'srv-local',
      },
    })
  })

  it('does not fabricate an exact sessionRef for named claude resume identifiers', () => {
    const actions: any[] = []
    const dispatch = (action: any) => {
      actions.push(action)
      return action
    }

    handleUiCommand({
      type: 'ui.command',
      command: 'pane.attach',
      payload: {
        tabId: 't1',
        paneId: 'pane-1',
        content: {
          kind: 'terminal',
          mode: 'claude',
          shell: 'system',
          createRequestId: 'req-claude',
          resumeSessionId: 'named-claude-resume',
        },
      },
    }, {
      dispatch,
      getState: () => ({
        connection: { serverInstanceId: 'srv-local' },
      } as any),
    })

    expect(actions[0].payload.content.createRequestId).toBe('req-claude')
    expect(actions[0].payload.content.sessionRef).toBeUndefined()
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
    const getState = vi.fn(() => ({}) as any)

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
      { dispatch: dispatch as any, getState, send },
    )

    await Promise.resolve()

    expect(captureUiScreenshot).toHaveBeenCalledWith(
      { scope: 'view', paneId: undefined, tabId: undefined },
      expect.objectContaining({ dispatch, getState }),
    )
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ui.screenshot.result',
      requestId: 'req-1',
      ok: true,
      changedFocus: false,
      restoredFocus: false,
    }))
  })
})
