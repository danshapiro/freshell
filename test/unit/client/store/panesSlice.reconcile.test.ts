import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'

// Mock localStorage BEFORE importing slices (persistMiddleware reads it at import time)
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
  }
})()
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

import tabsReducer, { addTab } from '../../../../src/store/tabsSlice'
import panesReducer, {
  initLayout,
  updatePaneContent,
  applyReconcileAttach,
  resetPaneForReconcileCreate,
  setPaneReconcileNotice,
  clearPaneReconcileNotice,
  setReconcileWarming,
  clearReconcileWarming,
  setReconcilePendingPanes,
} from '../../../../src/store/panesSlice'
import type { PanesState } from '../../../../src/store/panesSlice'
import { buildRestoreError } from '@shared/session-contract'
import {
  persistMiddleware,
  resetPersistFlushListenersForTests,
  resetPersistedPanesCacheForTests,
  resetPersistedLayoutCacheForTests,
} from '../../../../src/store/persistMiddleware'
import type { PaneNode, TerminalPaneContent } from '../../../../src/store/paneTypes'

function emptyState(): PanesState {
  return {
    layouts: {},
    activePane: {},
    paneTitles: {},
    paneTitleSetByUser: {},
    renameRequestTabId: null,
    renameRequestPaneId: null,
    zoomedPane: {},
    refreshRequestsByPane: {},
    restoreFallbackAttemptsByPane: {},
  }
}

function stateWithTerminalPane(overrides: Partial<TerminalPaneContent> = {}): PanesState {
  return panesReducer(emptyState(), initLayout({
    tabId: 'tab1',
    paneId: 'p1',
    content: {
      kind: 'terminal',
      mode: 'claude',
      shell: 'system',
      createRequestId: 'cr-keep',
      ...overrides,
    },
  }))
}

function findTerminalLeaf(node: PaneNode, paneId: string): TerminalPaneContent | undefined {
  if (node.type === 'leaf') {
    if (node.id === paneId && node.content.kind === 'terminal') return node.content
    return undefined
  }
  return findTerminalLeaf(node.children[0], paneId) ?? findTerminalLeaf(node.children[1], paneId)
}

function terminalContent(state: PanesState, tabId: string, paneId: string): TerminalPaneContent {
  const root = state.layouts[tabId]
  if (!root) throw new Error(`no layout for tab ${tabId}`)
  const content = findTerminalLeaf(root, paneId)
  if (!content) throw new Error(`no terminal pane ${paneId} in tab ${tabId}`)
  return content
}

// Delta round 3, finding 1: the flush writes THIS window's per-window layout key.
const WINDOW_ID = 'client-panes-reconcile-tests'
sessionStorage.setItem('freshell.layout-window-id.v1', WINDOW_ID)

describe('reconcile reducers', () => {
  it('applyReconcileAttach sets terminalId/status without touching createRequestId', () => {
    const state = stateWithTerminalPane({ createRequestId: 'cr-keep', terminalId: undefined, status: 'creating' })
    const next = panesReducer(state, applyReconcileAttach({ tabId: 'tab1', paneId: 'p1', terminalId: 'term-9', serverInstanceId: 'srv-2', sessionRef: { provider: 'claude', sessionId: 's1' } }))
    const c = terminalContent(next, 'tab1', 'p1')
    expect(c.terminalId).toBe('term-9')
    expect(c.status).toBe('running')
    expect(c.createRequestId).toBe('cr-keep')   // council rule: never re-minted
    expect(c.restoreError).toBeUndefined()
    expect(c.reconcileEpoch).toBe(1)            // A1 fix: fold bumps the volatile epoch
  })

  it('every fold bumps reconcileEpoch monotonically (createRequestId untouched)', () => {
    let s = stateWithTerminalPane({ createRequestId: 'cr-keep' })
    s = panesReducer(s, applyReconcileAttach({ tabId: 'tab1', paneId: 'p1', terminalId: 't1' }))
    s = panesReducer(s, resetPaneForReconcileCreate({ tabId: 'tab1', paneId: 'p1', intent: 'fresh' }))
    const c = terminalContent(s, 'tab1', 'p1')
    expect(c.reconcileEpoch).toBe(2)
    expect(c.createRequestId).toBe('cr-keep')
  })

  it('applyReconcileAttach with corrected sets a visible notice', () => {
    const next = panesReducer(stateWithTerminalPane({}), applyReconcileAttach({ tabId: 'tab1', paneId: 'p1', terminalId: 't', corrected: true }))
    expect(terminalContent(next, 'tab1', 'p1').reconcileNotice).toMatch(/corrected/i)
    expect(terminalContent(next, 'tab1', 'p1').reconcileNotice)
      .toBe('Session identity corrected by server — this pane now points at its live session.')
  })

  it('applyReconcileAttach with duplicate sets the duplicate notice verbatim', () => {
    const next = panesReducer(stateWithTerminalPane({}), applyReconcileAttach({ tabId: 'tab1', paneId: 'p1', terminalId: 't', duplicate: true }))
    expect(terminalContent(next, 'tab1', 'p1').reconcileNotice)
      .toBe('A duplicate terminal for this session was detected and ignored.')
  })

  // Task-009b (goal 4): a verdict that CONFIRMS the pane's exact current
  // identity is a no-change fold — it must not bump the volatile epoch (the
  // bump re-fired the lifecycle effect on every reconnect flap and its
  // re-drive superseded the checkpoint delta resume with a full refetch)
  // and must not drop the checkpoint stream identity a later resume needs.
  describe('applyReconcileAttach no-change gate (task-009b)', () => {
    function convergedPane(overrides: Partial<TerminalPaneContent> = {}): PanesState {
      return stateWithTerminalPane({
        createRequestId: 'cr-keep',
        status: 'running',
        terminalId: 't1',
        serverInstanceId: 'srv-1',
        streamId: 'st-1',
        sessionRef: { provider: 'claude', sessionId: 's1' },
        ...overrides,
      })
    }

    it('a no-change fold (same terminal/instance/sessionRef, no flags) skips the epoch bump and keeps the streamId', () => {
      const withPending = panesReducer(convergedPane(), setReconcilePendingPanes({
        paneKeys: ['tab1:p1'],
        startedAt: 123,
      }))
      const next = panesReducer(withPending, applyReconcileAttach({
        tabId: 'tab1',
        paneId: 'p1',
        terminalId: 't1',
        serverInstanceId: 'srv-1',
        sessionRef: { provider: 'claude', sessionId: 's1' },
      }))
      const c = terminalContent(next, 'tab1', 'p1')
      expect(c.reconcileEpoch).toBeUndefined()
      expect(c.streamId).toBe('st-1')
      expect(c.terminalId).toBe('t1')
      expect(c.status).toBe('running')
      expect(c.createRequestId).toBe('cr-keep')
      // The pane's reconcile pending window still closes on its verdict.
      expect(next.reconcilePendingPanes?.['tab1:p1']).toBeUndefined()
    })

    it('a corrective duplicate verdict still bumps the epoch but preserves the same terminal streamId', () => {
      const next = panesReducer(convergedPane(), applyReconcileAttach({
        tabId: 'tab1',
        paneId: 'p1',
        terminalId: 't1',
        serverInstanceId: 'srv-1',
        duplicate: true,
      }))
      const c = terminalContent(next, 'tab1', 'p1')
      expect(c.reconcileEpoch).toBe(1)
      expect(c.streamId).toBe('st-1')
      expect(c.reconcileNotice).toBe('A duplicate terminal for this session was detected and ignored.')
    })

    it('an identity-changing fold drops the stale streamId and bumps the epoch', () => {
      const next = panesReducer(convergedPane(), applyReconcileAttach({
        tabId: 'tab1',
        paneId: 'p1',
        terminalId: 't2',
        serverInstanceId: 'srv-1',
      }))
      const c = terminalContent(next, 'tab1', 'p1')
      expect(c.terminalId).toBe('t2')
      expect(c.streamId).toBeUndefined()
      expect(c.reconcileEpoch).toBe(1)
    })

    it('identity-field changes still fold and bump: serverInstanceId drift', () => {
      const next = panesReducer(convergedPane(), applyReconcileAttach({
        tabId: 'tab1', paneId: 'p1', terminalId: 't1', serverInstanceId: 'srv-2',
      }))
      expect(terminalContent(next, 'tab1', 'p1').reconcileEpoch).toBe(1)
      expect(terminalContent(next, 'tab1', 'p1').serverInstanceId).toBe('srv-2')
    })

    it('identity-field changes still fold and bump: corrected sessionRef', () => {
      const next = panesReducer(convergedPane(), applyReconcileAttach({
        tabId: 'tab1', paneId: 'p1', terminalId: 't1', serverInstanceId: 'srv-1',
        sessionRef: { provider: 'claude', sessionId: 'server-truth' },
      }))
      const c = terminalContent(next, 'tab1', 'p1')
      expect(c.reconcileEpoch).toBe(1)
      expect(c.sessionRef).toEqual({ provider: 'claude', sessionId: 'server-truth' })
    })

    it('a stuck error state still folds and bumps even with matching identity', () => {
      const errored = convergedPane({
        restoreError: buildRestoreError('provider_runtime_failed'),
      })
      const next = panesReducer(errored, applyReconcileAttach({
        tabId: 'tab1', paneId: 'p1', terminalId: 't1', serverInstanceId: 'srv-1',
      }))
      const c = terminalContent(next, 'tab1', 'p1')
      expect(c.reconcileEpoch).toBe(1)
      expect(c.restoreError).toBeUndefined()
    })

    it('a non-running pane still folds and bumps even with matching identity', () => {
      const next = panesReducer(convergedPane({ status: 'creating' }), applyReconcileAttach({
        tabId: 'tab1', paneId: 'p1', terminalId: 't1', serverInstanceId: 'srv-1',
      }))
      const c = terminalContent(next, 'tab1', 'p1')
      expect(c.reconcileEpoch).toBe(1)
      expect(c.status).toBe('running')
    })
  })

  it('resetPaneForReconcileCreate(respawn) clears handles, keeps createRequestId, sets server-named sessionRef', () => {
    const state = stateWithTerminalPane({ createRequestId: 'cr-keep', terminalId: 'dead', streamId: 'st', sessionRef: { provider: 'claude', sessionId: 'client-guess' } })
    const next = panesReducer(state, resetPaneForReconcileCreate({ tabId: 'tab1', paneId: 'p1', intent: 'respawn', sessionRef: { provider: 'claude', sessionId: 'server-truth' } }))
    const c = terminalContent(next, 'tab1', 'p1')
    expect(c.terminalId).toBeUndefined(); expect(c.streamId).toBeUndefined()
    expect(c.status).toBe('creating')
    expect(c.createRequestId).toBe('cr-keep')
    expect(c.sessionRef).toEqual({ provider: 'claude', sessionId: 'server-truth' })
    expect(c.pendingReconcile).toBe('respawn')
  })

  it('resetPaneForReconcileCreate(fresh) clears session identity and notes the reason', () => {
    const state = stateWithTerminalPane({ createRequestId: 'cr-keep', sessionRef: { provider: 'claude', sessionId: 'gone' }, resumeSessionId: 'gone' })
    const next = panesReducer(state, resetPaneForReconcileCreate({ tabId: 'tab1', paneId: 'p1', intent: 'fresh', reason: 'identity_never_observed' }))
    const c = terminalContent(next, 'tab1', 'p1')
    expect(c.sessionRef).toBeUndefined(); expect(c.resumeSessionId).toBeUndefined()
    expect(c.pendingReconcile).toBe('fresh')
    expect(c.reconcileNotice).toMatch(/identity_never_observed/)
    expect(c.reconcileNotice).toBe('Started fresh (identity_never_observed).')
  })

  it('resetPaneForReconcileCreate(fresh) clears a stale crashTrace; respawn keeps it (znhn#1)', () => {
    // Fresh-eyes finding: fresh = a genuinely NEW identity-less conversation —
    // the old "crashed & auto-resumed" trace belongs to the retired session
    // and must not leak onto it. Respawn resumes the SAME conversation, so
    // its trace legitimately stays.
    const trace = { exitCode: 1, resumedAtMs: 1_753_760_220_000 }
    const freshState = stateWithTerminalPane({ crashTrace: trace, sessionRef: { provider: 'claude', sessionId: 'gone' } })
    const fresh = panesReducer(freshState, resetPaneForReconcileCreate({ tabId: 'tab1', paneId: 'p1', intent: 'fresh', reason: 'identity_never_observed' }))
    expect(terminalContent(fresh, 'tab1', 'p1').crashTrace).toBeUndefined()

    const respawnState = stateWithTerminalPane({ crashTrace: trace, sessionRef: { provider: 'claude', sessionId: 'keep' } })
    const respawn = panesReducer(respawnState, resetPaneForReconcileCreate({ tabId: 'tab1', paneId: 'p1', intent: 'respawn', sessionRef: { provider: 'claude', sessionId: 'keep' } }))
    expect(terminalContent(respawn, 'tab1', 'p1').crashTrace).toEqual(trace)
  })

  it('resetPaneForReconcileCreate(respawn) with provider mismatch degrades loudly to fresh', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const state = stateWithTerminalPane({ mode: 'shell', sessionRef: { provider: 'claude', sessionId: 'x' } })
      const next = panesReducer(state, resetPaneForReconcileCreate({ tabId: 'tab1', paneId: 'p1', intent: 'respawn', sessionRef: { provider: 'claude', sessionId: 'srv' } }))
      const c = terminalContent(next, 'tab1', 'p1')
      expect(c.pendingReconcile).toBe('fresh')
      expect(c.sessionRef).toBeUndefined()
      expect(c.reconcileNotice).toMatch(/^Started fresh \(/)
      expect(c.createRequestId).toBe('cr-keep')
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('setPaneReconcileNotice / clearPaneReconcileNotice manage the notice', () => {
    let s = stateWithTerminalPane({})
    s = panesReducer(s, setPaneReconcileNotice({ tabId: 'tab1', paneId: 'p1', notice: 'hello' }))
    expect(terminalContent(s, 'tab1', 'p1').reconcileNotice).toBe('hello')
    s = panesReducer(s, clearPaneReconcileNotice({ tabId: 'tab1', paneId: 'p1' }))
    expect(terminalContent(s, 'tab1', 'p1').reconcileNotice).toBeUndefined()
  })

  it('reconcile warming is set and cleared as one slice-level field', () => {
    let s = panesReducer(undefined, setReconcileWarming({ count: 2, paneRefs: [{ tabId: 't1', paneId: 'p1' }, { tabId: 't1', paneId: 'p2' }] }))
    expect(s.reconcileWarming).toEqual({ count: 2, paneRefs: [{ tabId: 't1', paneId: 'p1' }, { tabId: 't1', paneId: 'p2' }] })
    s = panesReducer(s, clearReconcileWarming())
    expect(s.reconcileWarming).toBeNull()
  })

  it('clears pendingReconcile when terminal.created folds into pane content', () => {
    let s = stateWithTerminalPane({ createRequestId: 'cr-keep' })
    s = panesReducer(s, resetPaneForReconcileCreate({ tabId: 'tab1', paneId: 'p1', intent: 'respawn', sessionRef: { provider: 'claude', sessionId: 'srv' } }))
    const before = terminalContent(s, 'tab1', 'p1')
    expect(before.pendingReconcile).toBe('respawn')
    // Mirror TerminalView's terminal.created fold: spread current content + created updates
    s = panesReducer(s, updatePaneContent({
      tabId: 'tab1',
      paneId: 'p1',
      content: { ...before, terminalId: 'term-new', status: 'running' },
    }))
    const after = terminalContent(s, 'tab1', 'p1')
    expect(after.terminalId).toBe('term-new')
    expect(after.pendingReconcile).toBeUndefined()
    expect(after.createRequestId).toBe('cr-keep')
  })
})

describe('reconcile persistence stripping', () => {
  beforeEach(() => {
    localStorageMock.clear()
    vi.clearAllMocks()
    vi.useFakeTimers()
    resetPersistFlushListenersForTests()
    resetPersistedPanesCacheForTests()
    resetPersistedLayoutCacheForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('strips per-pane volatile reconcile fields and slice-level warming from persistence', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    store.dispatch(addTab({ mode: 'shell' }))
    const tabId = store.getState().tabs.tabs[0].id
    store.dispatch(initLayout({ tabId, paneId: 'p1', content: { kind: 'terminal', mode: 'claude', createRequestId: 'cr-keep' } }))
    // Sets all three per-pane volatile fields: pendingReconcile, reconcileNotice, reconcileEpoch
    store.dispatch(resetPaneForReconcileCreate({ tabId, paneId: 'p1', intent: 'fresh', reason: 'identity_never_observed' }))
    store.dispatch(setReconcileWarming({ count: 1, paneRefs: [{ tabId, paneId: 'p1' }] }))

    // Live state has all volatile fields
    const live = store.getState().panes
    const liveContent = terminalContent(live, tabId, 'p1')
    expect(liveContent.pendingReconcile).toBe('fresh')
    expect(liveContent.reconcileNotice).toBe('Started fresh (identity_never_observed).')
    expect(liveContent.reconcileEpoch).toBe(1)
    expect(live.reconcileWarming).not.toBeNull()

    vi.runAllTimers()

    const raw = localStorage.getItem(`freshell.layout.v3.${WINDOW_ID}`)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!)
    const leaf = parsed.panes.layouts[tabId]
    expect(leaf.type).toBe('leaf')
    expect(leaf.content.kind).toBe('terminal')
    expect(leaf.content.createRequestId).toBe('cr-keep')
    expect('pendingReconcile' in leaf.content).toBe(false)
    expect('reconcileNotice' in leaf.content).toBe(false)
    expect('reconcileEpoch' in leaf.content).toBe(false)
    expect('reconcileWarming' in parsed.panes).toBe(false)
  })
})
