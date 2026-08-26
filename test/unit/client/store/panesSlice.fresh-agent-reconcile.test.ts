import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
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
  restoreLayout,
  applyReconcileAttach,
  resetPaneForReconcileCreate,
  applyFreshAgentReconcileAttach,
  resetFreshAgentPaneForReconcileCreate,
  setPaneRestoreError,
  setPaneReconcileNotice,
  clearPaneReconcileNotice,
  setReconcilePendingPanes,
  clearReconcilePendingPane,
  clearAllReconcilePendingPanes,
} from '../../../../src/store/panesSlice'
import type { PanesState } from '../../../../src/store/panesSlice'
import {
  persistMiddleware,
  resetPersistFlushListenersForTests,
  resetPersistedPanesCacheForTests,
  resetPersistedLayoutCacheForTests,
} from '../../../../src/store/persistMiddleware'
import type { FreshAgentPaneContent, PaneContentInput, PaneNode } from '../../../../src/store/paneTypes'

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

/** Read the fresh-agent leaf content back out of state.layouts[tabId]. */
function leafContent(state: PanesState, tabId: string): FreshAgentPaneContent {
  const root = state.layouts[tabId]
  if (!root || root.type !== 'leaf' || root.content.kind !== 'fresh-agent') {
    throw new Error(`expected fresh-agent leaf for tab ${tabId}`)
  }
  return root.content
}

/** Same read on the restoreLayout path — named per the restore assertions it serves. */
function restoredLeafContent(state: PanesState, tabId: string): FreshAgentPaneContent {
  return leafContent(state, tabId)
}

/** Build a single-leaf layout with the given fresh-agent content (same cast trick as the model test). */
function leafWith(content: Record<string, unknown>): PaneNode {
  return { type: 'leaf', id: 'pane-1', content } as PaneNode
}

/**
 * Store + persistMiddleware setup copied from
 * test/unit/client/store/panesSlice.reconcile.test.ts:214-251 with a
 * fresh-agent leaf swapped in. Returns the persisted leaf from localStorage.
 */
async function persistLeafWithContent(
  content: Record<string, unknown>,
): Promise<{ content: Record<string, unknown> & { sessionRef?: { sessionId?: string } } }> {
  const store = configureStore({
    reducer: { tabs: tabsReducer, panes: panesReducer },
    middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
  })

  store.dispatch(addTab({ mode: 'shell' }))
  const tabId = store.getState().tabs.tabs[0].id
  store.dispatch(initLayout({ tabId, paneId: 'p1', content: content as PaneContentInput }))

  vi.runAllTimers()

  const raw = localStorage.getItem('freshell.layout.v3')
  if (!raw) throw new Error('nothing persisted to freshell.layout.v3')
  const parsed = JSON.parse(raw)
  const leaf = parsed.panes.layouts[tabId]
  if (!leaf || leaf.type !== 'leaf') throw new Error('expected persisted leaf')
  return leaf
}

describe('fresh-agent reconcile volatile fields', () => {
  const initialState = emptyState()

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

  it('the fold trio survives initLayout normalization on fresh-agent leaves (RED gate)', () => {
    // RED on base: normalizePaneContent's fresh-agent branch enumerates its
    // output fields (no rest spread) and silently drops all three.
    const state = panesReducer(initialState, initLayout({
      tabId: 'tab-1', paneId: 'pane-1',
      content: {
        kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude',
        createRequestId: 'req-1', status: 'connected',
        reconcileEpoch: 3, pendingReconcile: 'respawn', reconcileNotice: 'x',
      } as PaneContentInput,
    }))
    const content = leafContent(state, 'tab-1')
    expect(content.reconcileEpoch).toBe(3)
    expect(content.pendingReconcile).toBe('respawn')
    expect(content.reconcileNotice).toBe('x')
  })

  it('the fold trio survives updatePaneContent normalization (live patch path, RED gate)', () => {
    // RED on base for the same reason. This is the path the created-ack patch,
    // session.materialized patches, and Task 14's nudge flow through (:1378) —
    // preserving here is what stops unrelated patches wiping fold state.
    let state = panesReducer(initialState, initLayout({
      tabId: 'tab-1', paneId: 'pane-1',
      content: { kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude', createRequestId: 'req-1', status: 'connected' },
    }))
    state = panesReducer(state, updatePaneContent({
      tabId: 'tab-1', paneId: 'pane-1',
      content: {
        ...leafContent(state, 'tab-1'),
        reconcileEpoch: 1, pendingReconcile: 'fresh', reconcileNotice: 'n',
      } as PaneContentInput,
    }))
    const content = leafContent(state, 'tab-1')
    expect(content.reconcileEpoch).toBe(1)
    expect(content.pendingReconcile).toBe('fresh')
    expect(content.reconcileNotice).toBe('n')
  })

  it('restoreLayout strips reconcileEpoch/pendingReconcile/reconcileNotice from fresh-agent leaves', () => {
    // GREEN ON BASE — but vacuously (normalizePaneContent drops the trio before
    // stripStaleIds is even consulted). NOT part of the red gate. After Step 3
    // preserves the trio in normalizePaneContent, THIS test is what proves the
    // stripStaleIds edit: it is then the only thing keeping volatile fold state
    // out of restored layouts.
    const state = panesReducer(initialState, restoreLayout({
      tabId: 'tab-1',
      layout: leafWith({
        kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude',
        createRequestId: 'req-1', status: 'connected',
        sessionRef: { provider: 'claude', sessionId: '11111111-1111-4111-8111-111111111111' },
        reconcileEpoch: 3, pendingReconcile: 'respawn', reconcileNotice: 'x',
      }),
    }))
    const content = restoredLeafContent(state, 'tab-1')
    expect('reconcileEpoch' in content).toBe(false)
    expect('pendingReconcile' in content).toBe(false)
    expect('reconcileNotice' in content).toBe(false)
    expect(content.sessionRef?.sessionId).toBe('11111111-1111-4111-8111-111111111111')
  })

  it('persistence strips reconcileEpoch/pendingReconcile/reconcileNotice from fresh-agent panes', async () => {
    // GREEN ON BASE — regression coverage only, NOT part of the red gate.
    // persistMiddleware's kind-agnostic stripTransientSessionFields (:245-268)
    // already strips these three fields for fresh-agent panes (A19 destructure).
    const persisted = await persistLeafWithContent({
      kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude',
      createRequestId: 'req-1', status: 'connected',
      sessionRef: { provider: 'claude', sessionId: '11111111-1111-4111-8111-111111111111' },
      reconcileEpoch: 3, pendingReconcile: 'respawn', reconcileNotice: 'x',
    })
    expect('reconcileEpoch' in persisted.content).toBe(false)
    expect('pendingReconcile' in persisted.content).toBe(false)
    expect('reconcileNotice' in persisted.content).toBe(false)
    expect(persisted.content.sessionRef?.sessionId).toBe('11111111-1111-4111-8111-111111111111')
  })
})

// --- Fresh-agent fold reducers (Task 3) ---

const tabId = 'tab1'
const paneId = 'p1'
const DURABLE = '11111111-1111-4111-8111-111111111111'
const ORIGINAL_CREATE_REQUEST_ID = 'cr-keep'

/** Raw slice state with one fresh-agent leaf (mirrors panesSlice.reconcile.test.ts's builder). */
function stateWithFreshAgentPane(overrides: Record<string, unknown> = {}): PanesState {
  return panesReducer(emptyState(), initLayout({
    tabId,
    paneId,
    content: {
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      createRequestId: ORIGINAL_CREATE_REQUEST_ID,
      status: 'creating',
      ...overrides,
    } as PaneContentInput,
  }))
}

describe('applyFreshAgentReconcileAttach', () => {
  it('sets the live handle from the verdict sessionRef, clears errors, bumps epoch', () => {
    const state = stateWithFreshAgentPane({
      restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'dead_live_handle' },
      createError: { code: 'SPAWN_FAILED', message: 'boom' },
    })
    const next = panesReducer(state, applyFreshAgentReconcileAttach({
      tabId, paneId,
      sessionRef: { provider: 'claude', sessionId: DURABLE },
      serverInstanceId: 'srv-1', corrected: true,
    }))
    const c = leafContent(next, tabId)
    expect(c.sessionId).toBe(DURABLE)
    expect(c.sessionRef).toEqual({ provider: 'claude', sessionId: DURABLE })
    expect(c.resumeSessionId).toBe(DURABLE)
    expect(c.status).toBe('connected')
    expect(c.serverInstanceId).toBe('srv-1')
    expect(c.restoreError).toBeUndefined()
    expect(c.createError).toBeUndefined()
    expect(c.createRequestId).toBe(ORIGINAL_CREATE_REQUEST_ID) // never re-minted
    expect(c.reconcileEpoch).toBe(1)
    expect(c.reconcileNotice).toBeTruthy() // corrected is user-visible
  })

  it('sets the duplicate notice when the verdict is a duplicate', () => {
    const next = panesReducer(stateWithFreshAgentPane(), applyFreshAgentReconcileAttach({
      tabId, paneId,
      sessionRef: { provider: 'claude', sessionId: DURABLE },
      duplicate: true,
    }))
    expect(leafContent(next, tabId).reconcileNotice)
      .toBe('A duplicate terminal for this session was detected and ignored.')
  })

  it('no-ops when the verdict carries no sessionRef', () => {
    const state = stateWithFreshAgentPane()
    const next = panesReducer(state, applyFreshAgentReconcileAttach({ tabId, paneId }))
    expect(next).toEqual(state)
    const c = leafContent(next, tabId)
    expect(c.sessionId).toBeUndefined()
    expect(c.reconcileEpoch).toBeUndefined()
  })

  it('no-ops when the verdict sessionRef provider mismatches the pane provider', () => {
    const state = stateWithFreshAgentPane()
    const next = panesReducer(state, applyFreshAgentReconcileAttach({
      tabId, paneId,
      sessionRef: { provider: 'codex', sessionId: DURABLE },
    }))
    expect(next).toEqual(state)
  })

  it('adopts attach runtime and clears it before a respawn create', () => {
    let state = stateWithFreshAgentPane({ runtimeId: 'fresh-old', runtimeGeneration: 7 })
    state = panesReducer(state, applyFreshAgentReconcileAttach({
      tabId, paneId,
      sessionRef: { provider: 'claude', sessionId: DURABLE },
      runtime: { runtimeId: 'fresh-new', generation: 8 },
    }))
    expect(leafContent(state, tabId)).toMatchObject({ runtimeId: 'fresh-new', runtimeGeneration: 8 })
    state = panesReducer(state, resetFreshAgentPaneForReconcileCreate({
      tabId, paneId, intent: 'respawn', sessionRef: { provider: 'claude', sessionId: DURABLE },
    }))
    expect(leafContent(state, tabId).runtimeId).toBeUndefined()
    expect(leafContent(state, tabId).runtimeGeneration).toBeUndefined()
  })

  it('does not let a stale same-server attach downgrade a replacement runtime', () => {
    const state = stateWithFreshAgentPane({
      sessionId: DURABLE, sessionRef: { provider: 'claude', sessionId: DURABLE },
      runtimeId: 'fresh-new', runtimeGeneration: 8, serverInstanceId: 'server-current',
    })
    const stale = panesReducer(state, applyFreshAgentReconcileAttach({
      tabId, paneId, sessionRef: { provider: 'claude', sessionId: DURABLE },
      serverInstanceId: 'server-current', runtime: { runtimeId: 'fresh-old', generation: 7 },
    }))
    expect(leafContent(stale, tabId)).toMatchObject({ runtimeId: 'fresh-new', runtimeGeneration: 8 })

    const currentServer = panesReducer(stale, applyFreshAgentReconcileAttach({
      tabId, paneId, sessionRef: { provider: 'claude', sessionId: DURABLE },
      serverInstanceId: 'server-next', runtime: { runtimeId: 'fresh-server-next', generation: 0 },
    }))
    expect(leafContent(currentServer, tabId)).toMatchObject({
      runtimeId: 'fresh-server-next', runtimeGeneration: 0, serverInstanceId: 'server-next',
    })
  })
})

describe('resetFreshAgentPaneForReconcileCreate', () => {
  it('respawn adopts the server-named sessionRef and arms pendingReconcile', () => {
    const state = stateWithFreshAgentPane({ sessionId: 'live-old', serverInstanceId: 'srv-old', status: 'connected' })
    const next = panesReducer(state, resetFreshAgentPaneForReconcileCreate({
      tabId, paneId, intent: 'respawn',
      sessionRef: { provider: 'claude', sessionId: DURABLE },
    }))
    const c = leafContent(next, tabId)
    expect(c.sessionId).toBeUndefined()
    expect(c.serverInstanceId).toBeUndefined()
    expect(c.status).toBe('creating')
    expect(c.sessionRef).toEqual({ provider: 'claude', sessionId: DURABLE })
    expect(c.resumeSessionId).toBe(DURABLE)
    expect(c.pendingReconcile).toBe('respawn')
    expect(c.reconcileEpoch).toBe(1)
    expect(c.createRequestId).toBe(ORIGINAL_CREATE_REQUEST_ID)
  })

  it('respawn with provider-mismatched sessionRef degrades loudly to fresh', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const state = stateWithFreshAgentPane()
      const next = panesReducer(state, resetFreshAgentPaneForReconcileCreate({
        tabId, paneId, intent: 'respawn',
        sessionRef: { provider: 'codex', sessionId: DURABLE }, // pane provider is claude
      }))
      const c = leafContent(next, tabId)
      expect(c.pendingReconcile).toBe('fresh')
      expect(c.sessionRef).toBeUndefined()
      expect(c.resumeSessionId).toBeUndefined()
      expect(c.createRequestId).toBe(ORIGINAL_CREATE_REQUEST_ID)
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('fresh wipes durable identity and clears restoreError', () => {
    const state = stateWithFreshAgentPane({
      sessionRef: { provider: 'claude', sessionId: DURABLE },
      resumeSessionId: DURABLE,
      restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'dead_live_handle' },
    })
    const next = panesReducer(state, resetFreshAgentPaneForReconcileCreate({
      tabId, paneId, intent: 'fresh', reason: 'identity_never_observed',
    }))
    const c = leafContent(next, tabId)
    expect(c.sessionRef).toBeUndefined()
    expect(c.resumeSessionId).toBeUndefined()
    expect(c.status).toBe('creating')
    expect(c.restoreError).toBeUndefined()
    expect(c.pendingReconcile).toBe('fresh')
    expect(c.reconcileEpoch).toBe(1)
    expect(c.reconcileNotice).toBe('Started fresh (identity_never_observed).')
    expect(c.createRequestId).toBe(ORIGINAL_CREATE_REQUEST_ID)
  })
})

describe('widened per-pane reducers', () => {
  it('setPaneRestoreError writes restoreError on a fresh-agent pane', () => {
    const next = panesReducer(stateWithFreshAgentPane(), setPaneRestoreError({
      tabId, paneId,
      restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'dead_live_handle' },
    }))
    expect(leafContent(next, tabId).restoreError?.reason).toBe('dead_live_handle')
  })

  it('setPaneReconcileNotice / clearPaneReconcileNotice act on a fresh-agent pane', () => {
    let s = stateWithFreshAgentPane()
    s = panesReducer(s, setPaneReconcileNotice({ tabId, paneId, notice: 'hello' }))
    expect(leafContent(s, tabId).reconcileNotice).toBe('hello')
    s = panesReducer(s, clearPaneReconcileNotice({ tabId, paneId }))
    expect(leafContent(s, tabId).reconcileNotice).toBeUndefined()
  })
})

// --- reconcilePendingPanes: view-level pre-verdict wait state (Task 6) ---

/** One terminal pane (tab1:p1) and one fresh-agent pane (tab2:p2) in the same state. */
function stateWithBothPaneKinds(): PanesState {
  let s = panesReducer(emptyState(), initLayout({
    tabId: 'tab1',
    paneId: 'p1',
    content: { kind: 'terminal', mode: 'claude', shell: 'system', createRequestId: 'cr-term' } as PaneContentInput,
  }))
  s = panesReducer(s, initLayout({
    tabId: 'tab2',
    paneId: 'p2',
    content: {
      kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude',
      createRequestId: 'cr-fa', status: 'creating',
    } as PaneContentInput,
  }))
  return s
}

describe('reconcilePendingPanes', () => {
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

  it('set replaces the map; clearPane removes one; clearAll empties', () => {
    let s = panesReducer(emptyState(), setReconcilePendingPanes({
      paneKeys: ['old:stale'], startedAt: 100,
    }))
    // set REPLACES the map (old:stale gone)
    s = panesReducer(s, setReconcilePendingPanes({
      paneKeys: ['tab1:p1', 'tab2:p2'], startedAt: 200,
    }))
    expect(s.reconcilePendingPanes).toEqual({ 'tab1:p1': 200, 'tab2:p2': 200 })

    s = panesReducer(s, clearReconcilePendingPane({ paneKey: 'tab1:p1' }))
    expect(s.reconcilePendingPanes).toEqual({ 'tab2:p2': 200 })

    s = panesReducer(s, clearAllReconcilePendingPanes())
    expect(s.reconcilePendingPanes).toEqual({})
  })

  it('every fold reducer clears its pane pending flag (attach, both kinds)', () => {
    let s = stateWithBothPaneKinds()
    s = panesReducer(s, setReconcilePendingPanes({ paneKeys: ['tab1:p1', 'tab2:p2'], startedAt: 1 }))

    s = panesReducer(s, applyReconcileAttach({ tabId: 'tab1', paneId: 'p1', terminalId: 'term-1' }))
    expect(s.reconcilePendingPanes).toEqual({ 'tab2:p2': 1 })

    s = panesReducer(s, applyFreshAgentReconcileAttach({
      tabId: 'tab2', paneId: 'p2',
      sessionRef: { provider: 'claude', sessionId: DURABLE },
    }))
    expect(s.reconcilePendingPanes).toEqual({})
  })

  it('every fold reducer clears its pane pending flag (reset-for-create, both kinds)', () => {
    let s = stateWithBothPaneKinds()
    s = panesReducer(s, setReconcilePendingPanes({ paneKeys: ['tab1:p1', 'tab2:p2'], startedAt: 1 }))

    s = panesReducer(s, resetPaneForReconcileCreate({ tabId: 'tab1', paneId: 'p1', intent: 'fresh' }))
    expect(s.reconcilePendingPanes).toEqual({ 'tab2:p2': 1 })

    s = panesReducer(s, resetFreshAgentPaneForReconcileCreate({ tabId: 'tab2', paneId: 'p2', intent: 'fresh' }))
    expect(s.reconcilePendingPanes).toEqual({})
  })

  it('setPaneRestoreError clears the pane pending flag', () => {
    let s = stateWithFreshAgentPane() // tab1:p1 fresh-agent pane
    s = panesReducer(s, setReconcilePendingPanes({ paneKeys: [`${tabId}:${paneId}`], startedAt: 1 }))
    s = panesReducer(s, setPaneRestoreError({
      tabId, paneId,
      restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'dead_live_handle' },
    }))
    expect(s.reconcilePendingPanes).toEqual({})
  })

  it('is not persisted (slice-level field absent from the persisted panes section)', async () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    store.dispatch(addTab({ mode: 'shell' }))
    const persistTabId = store.getState().tabs.tabs[0].id
    store.dispatch(initLayout({
      tabId: persistTabId,
      paneId: 'p1',
      content: { kind: 'terminal', mode: 'shell', shell: 'system', createRequestId: 'cr-1' } as PaneContentInput,
    }))
    store.dispatch(setReconcilePendingPanes({ paneKeys: [`${persistTabId}:p1`], startedAt: Date.now() }))

    vi.runAllTimers()

    const raw = localStorage.getItem('freshell.layout.v3')
    if (!raw) throw new Error('nothing persisted to freshell.layout.v3')
    const parsed = JSON.parse(raw)
    expect('reconcilePendingPanes' in parsed.panes).toBe(false)
    // Neighbouring ephemeral fields are also stripped (sanity anchor for the strip site)
    expect('deadSessionAdjudication' in parsed.panes).toBe(false)
    expect('reconcileWarming' in parsed.panes).toBe(false)
  })
})
