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

/** Every detach message verbatim (CRID-bearing detaches must NOT exist — the
 * detach lane is identity-driven only; delta-round-7-round-2 F2). */
function detachMessages(): Array<{ type?: string; terminalId?: string; createRequestId?: string }> {
  return mockSend.mock.calls
    .map(([msg]) => msg as { type?: string; terminalId?: string; createRequestId?: string })
    .filter((msg) => msg?.type === 'terminal.detach')
}

/** The pane-close evidence messages (delta-round-7-round-2 F1/F2): one per
 * REMOVED pane identity on a genuine close action, keyed by the pane's
 * createRequestId, independent of whether its terminal detached. */
function paneClosedMessages(): Array<{ type?: string; createRequestId?: string; terminalId?: string }> {
  return mockSend.mock.calls
    .map(([msg]) => msg as { type?: string; createRequestId?: string; terminalId?: string })
    .filter((msg) => msg?.type === 'pane.closed')
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

describe('terminalDetachMiddleware — durable pane-close evidence (delta-r7-r2 findings F1+F2)', () => {
  it('F1: replacePane journals pane.close evidence for the replaced pane AND sends a plain (CRID-less) detach', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-a', 'req-replaced') }))
    mockSend.mockClear()
    store.dispatch(replacePane({ tabId: 'tab-1', paneId: 'pane-1' }))
    expect(paneClosedMessages()).toEqual([
      { type: 'pane.closed', createRequestId: 'req-replaced', terminalId: 'term-a' },
    ])
    // The detach itself stays identity-driven: never a createRequestId rider.
    expect(detachMessages()).toEqual([{ type: 'terminal.detach', terminalId: 'term-a' }])
  })

  it('F1: closePane journals pane-close evidence keyed by the closing pane\'s createRequestId', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-a', 'req-1') }))
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'horizontal',
      newContent: terminalContent('term-b', 'req-2'),
      newPaneId: 'pane-2',
    }))
    mockSend.mockClear()
    store.dispatch(closePane({ tabId: 'tab-1', paneId: 'pane-2' }))
    expect(paneClosedMessages()).toEqual([
      { type: 'pane.closed', createRequestId: 'req-2', terminalId: 'term-b' },
    ])
    expect(detachMessages()).toEqual([{ type: 'terminal.detach', terminalId: 'term-b' }])
  })

  it('F2: closing ONE of two panes sharing a terminal journals the close evidence even though NO detach fires (last-reference guard)', () => {
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
    store.dispatch(closePane({ tabId: 'tab-1', paneId: 'pane-2' }))
    // The terminal survives in pane-1: the subscription stays (no detach)…
    expect(detachedIds()).toEqual([])
    // …but THE PANE closed — its durable close evidence must land regardless.
    expect(paneClosedMessages()).toEqual([
      { type: 'pane.closed', createRequestId: 'req-2', terminalId: 'term-dup' },
    ])
  })

  it('F2: a tab close removing two panes sharing one terminal journals ONE detach but TWO pane-close records (one per removed pane identity)', () => {
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
    expect(paneClosedMessages().sort((a, b) => (a.createRequestId ?? '').localeCompare(b.createRequestId ?? ''))).toEqual([
      { type: 'pane.closed', createRequestId: 'req-1', terminalId: 'term-dup' },
      { type: 'pane.closed', createRequestId: 'req-2', terminalId: 'term-dup' },
    ])
  })

  it('F2: closing a pane whose create is still in flight (NO terminalId yet) journals the close evidence keyed by its createRequestId and sends NO detach', () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: { kind: 'terminal' as const, mode: 'claude' as const, status: 'creating' as const, createRequestId: 'req-inflight' },
    }))
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'horizontal',
      newContent: terminalContent('term-b', 'req-2'),
      newPaneId: 'pane-2',
    }))
    mockSend.mockClear()
    store.dispatch(closePane({ tabId: 'tab-1', paneId: 'pane-1' }))
    expect(detachedIds()).toEqual([])
    expect(paneClosedMessages()).toEqual([
      { type: 'pane.closed', createRequestId: 'req-inflight' },
    ])
  })

  it('the evidence follows the close evidence before the detach (evidence-first ordering)', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-a', 'req-1') }))
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'horizontal',
      newContent: terminalContent('term-b', 'req-2'),
      newPaneId: 'pane-2',
    }))
    mockSend.mockClear()
    store.dispatch(closePane({ tabId: 'tab-1', paneId: 'pane-2' }))
    expect(mockSend.mock.calls.map(([msg]) => (msg as { type?: string }).type)).toEqual([
      'pane.closed',
      'terminal.detach',
    ])
  })

  it('a CRID-less terminal pane close sends a plain detach and NO pane.closed (never a malformed record key)', () => {
    // The CRID-less shape exists only in legacy/preloaded layouts — reducers
    // always mint a createRequestId. Preload the tree directly.
    const store = configureStore({
      reducer: { panes: panesReducer },
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(terminalDetachMiddleware),
      preloadedState: {
        panes: {
          layouts: {
            'tab-1': {
              type: 'split' as const,
              id: 'split-1',
              direction: 'horizontal' as const,
              sizes: [50, 50] as [number, number],
              children: [
                { type: 'leaf' as const, id: 'pane-1', content: terminalContent('term-a', 'req-1') },
                { type: 'leaf' as const, id: 'pane-2', content: { kind: 'terminal' as const, mode: 'shell' as const, status: 'running' as const, terminalId: 'term-b' } },
              ],
            },
          },
          activePane: { 'tab-1': 'pane-1' },
          paneTitles: {},
          paneTitleSetByUser: {},
          renameRequestTabId: null,
          renameRequestPaneId: null,
          zoomedPane: {},
          refreshRequestsByPane: {},
          restoreFallbackAttemptsByPane: {},
          deadSessionAdjudication: [],
          reconcileWarming: null,
          reconcilePendingPanes: {},
        },
      },
    })
    mockSend.mockClear()
    store.dispatch(closePane({ tabId: 'tab-1', paneId: 'pane-2' }))
    expect(detachMessages()).toEqual([{ type: 'terminal.detach', terminalId: 'term-b' }])
    expect(paneClosedMessages()).toEqual([])
  })

  it('focused-episode-7 round 4 (F2): the belt covers FRESH-AGENT pane removals too — per-REMOVAL, CRID-only (their kill envelope coexists; pane-close evidence is the removal)', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-a', 'req-1') }))
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'horizontal',
      newContent: {
        kind: 'fresh-agent' as const,
        sessionType: 'freshclaude' as const,
        provider: 'claude' as const,
        sessionId: 'sess-fa',
        createRequestId: 'req-fa',
        status: 'idle' as const,
      },
      newPaneId: 'pane-fa',
    }))
    mockSend.mockClear()
    store.dispatch(removeLayout({ tabId: 'tab-1' }))
    expect(detachedIds()).toEqual(['term-a'])
    expect(paneClosedMessages().sort((a, b) => (a.createRequestId ?? '').localeCompare(b.createRequestId ?? ''))).toEqual([
      { type: 'pane.closed', createRequestId: 'req-1', terminalId: 'term-a' },
      { type: 'pane.closed', createRequestId: 'req-fa' },
    ])
  })

  it('NON-close removals NEVER journal pane-close evidence (updatePaneContent re-point, reconcile-fold family)', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-old', 'req-live') }))
    mockSend.mockClear()
    store.dispatch(updatePaneContent({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-new', 'req-live') }))
    expect(detachedIds()).toEqual(['term-old'])
    expect(paneClosedMessages()).toEqual([])
    // The server-dead cleanup family likewise: no evidence (nothing the user closed).
    mockSend.mockClear()
    store.dispatch(clearDeadTerminals({ liveTerminalIds: [] }))
    expect(paneClosedMessages()).toEqual([])
  })
})
