import { describe, it, expect, vi, beforeEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import panesReducer, {
  initLayout,
  updatePaneContent,
  splitPane,
  closePane,
  replacePane,
  removeLayout,
  clearDeadTerminals,
  clearTerminalLiveHandles,
  repairCodexIdentityMismatch,
} from '@/store/panesSlice'
import { terminalDetachMiddleware } from '@/store/terminalDetachMiddleware'
import {
  markTerminalReleased,
  resetTerminalReleaseMarks,
} from '@/lib/terminal-release-marks'

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({ send: mockSend }),
}))

function createStore() {
  return configureStore({
    reducer: { panes: panesReducer },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().concat(terminalDetachMiddleware),
  })
}

function terminalContent(terminalId: string, createRequestId = `req-${terminalId}`) {
  return {
    kind: 'terminal' as const,
    mode: 'shell' as const,
    status: 'running' as const,
    terminalId,
    createRequestId,
  }
}

function detachedIds(): string[] {
  return mockSend.mock.calls
    .map(([msg]) => msg as { type?: string; terminalId?: string })
    .filter((msg) => msg?.type === 'terminal.detach')
    .map((msg) => msg.terminalId as string)
}

beforeEach(() => {
  mockSend.mockClear()
  resetTerminalReleaseMarks()
})

describe('terminalDetachMiddleware', () => {
  it('does not send anything when layouts only grow', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-a') }))
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'horizontal',
      newContent: terminalContent('term-b'),
      newPaneId: 'pane-2',
    }))
    expect(detachedIds()).toEqual([])
  })

  it('does not send anything for actions that do not touch pane layouts', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-a') }))
    mockSend.mockClear()
    store.dispatch({ type: 'test/noop' })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('detaches the old terminal when a pane is re-pointed to a new terminal', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-old') }))
    mockSend.mockClear()
    store.dispatch(updatePaneContent({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-new') }))
    expect(detachedIds()).toEqual(['term-old'])
  })

  it('detaches when a pane is replaced with the picker', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-a') }))
    mockSend.mockClear()
    store.dispatch(replacePane({ tabId: 'tab-1', paneId: 'pane-1' }))
    expect(detachedIds()).toEqual(['term-a'])
  })

  it('detaches when a split pane is closed', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-a') }))
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'horizontal',
      newContent: terminalContent('term-b'),
      newPaneId: 'pane-2',
    }))
    mockSend.mockClear()
    store.dispatch(closePane({ tabId: 'tab-1', paneId: 'pane-2' }))
    expect(detachedIds()).toEqual(['term-b'])
  })

  it('detaches every terminal in a removed layout (tab close cascade)', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-a') }))
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'vertical',
      newContent: terminalContent('term-b'),
      newPaneId: 'pane-2',
    }))
    mockSend.mockClear()
    store.dispatch(removeLayout({ tabId: 'tab-1' }))
    expect(detachedIds().sort()).toEqual(['term-a', 'term-b'])
  })

  it('does NOT detach a terminal still referenced by another tab (refcount guard)', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-dup', 'req-1') }))
    store.dispatch(initLayout({ tabId: 'tab-2', paneId: 'pane-2', content: terminalContent('term-dup', 'req-2') }))
    mockSend.mockClear()
    store.dispatch(removeLayout({ tabId: 'tab-1' }))
    expect(detachedIds()).toEqual([])
    store.dispatch(removeLayout({ tabId: 'tab-2' }))
    expect(detachedIds()).toEqual(['term-dup'])
  })

  it('sends a single detach when one action drops multiple references to the same terminal', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-dup', 'req-1') }))
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'horizontal',
      newContent: terminalContent('term-dup', 'req-2'),
      newPaneId: 'pane-2',
    }))
    mockSend.mockClear()
    store.dispatch(removeLayout({ tabId: 'tab-1' }))
    expect(detachedIds()).toEqual(['term-dup'])
  })

  it('skips detach for terminals dropped by clearDeadTerminals (server already reaped them)', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-dead') }))
    mockSend.mockClear()
    store.dispatch(clearDeadTerminals({ liveTerminalIds: [] }))
    expect(detachedIds()).toEqual([])
  })

  it('skips detach for terminals dropped by clearTerminalLiveHandles (recoverable-loss path)', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-lost') }))
    mockSend.mockClear()
    store.dispatch(clearTerminalLiveHandles({ terminalIds: ['term-lost'] }))
    expect(detachedIds()).toEqual([])
  })

  it('detaches the stale terminal on codex identity repair', () => {
    const store = createStore()
    // The preloaded content MUST carry a sessionRef equal to the action's
    // expectedSessionRef: repairCodexIdentityMismatch (panesSlice.ts:1778)
    // guards on sessionRefsEqual(node.content.sessionRef, expectedSessionRef)
    // and no-ops otherwise, so a bare terminalContent() would never trigger
    // the repair (and therefore never drop the reference).
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        ...terminalContent('term-stale'),
        mode: 'codex' as const,
        sessionRef: { provider: 'codex' as const, sessionId: 'session-1' },
      },
    }))
    mockSend.mockClear()
    store.dispatch(repairCodexIdentityMismatch({
      tabId: 'tab-1',
      paneId: 'pane-1',
      staleTerminalId: 'term-stale',
      expectedSessionRef: { provider: 'codex', sessionId: 'session-1' },
      createRequestId: 'req-repair',
    }))
    expect(detachedIds()).toEqual(['term-stale'])
  })

  it('skips detach for a terminal marked released (explicit kill), consuming the mark', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-k') }))
    mockSend.mockClear()
    markTerminalReleased('term-k')
    store.dispatch(replacePane({ tabId: 'tab-1', paneId: 'pane-1' }))
    expect(detachedIds()).toEqual([])

    // The mark was consumed: a fresh reference drop for the same id detaches again.
    store.dispatch(updatePaneContent({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-k', 'req-k2') }))
    mockSend.mockClear()
    store.dispatch(replacePane({ tabId: 'tab-1', paneId: 'pane-1' }))
    expect(detachedIds()).toEqual(['term-k'])
  })
})
