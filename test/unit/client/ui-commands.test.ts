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
