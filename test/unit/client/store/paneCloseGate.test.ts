import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'

const { mockSend, handlers } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  handlers: new Set<(msg: unknown) => void>(),
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockSend,
    onMessage: (handler: (msg: unknown) => void) => {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
  }),
}))

import tabsReducer, {
  addTab,
  closeTab,
  closePaneWithCleanup,
  replacePaneWithCleanup,
  removeTab,
} from '@/store/tabsSlice'
import panesReducer, { initLayout, splitPane, setPaneCloseError, addPane, replacePane, updatePaneContent, hydratePanes, clearDeadTerminals, clearTerminalLiveHandles, repairCodexIdentityMismatch, swapPanes, closePane, removeLayout } from '@/store/panesSlice'
import connectionReducer from '@/store/connectionSlice'
import { terminalDetachMiddleware } from '@/store/terminalDetachMiddleware'
import { KILL_ACK_TIMEOUT_MS } from '@/lib/kill-ack'
import { collectPaneEntries } from '@/lib/pane-utils'
import type { PaneContent } from '@/store/paneTypes'

/**
 * Focused-episode-7 round 2, Finding F2 — the close gate. The pane.close
 * evidence is journaled and ACKNOWLEDGED before the layout loses the pane:
 * `closePaneWithCleanup` / `closeTab` / `replacePaneWithCleanup` send one
 * `pane.closed` per removed terminal-pane identity, await the correlated
 * `pane.closed.result` (bounded), and only then run the reducers. On
 * failure/timeout the layout stands and every failed pane shows the failure
 * on its own error surface (`closeError`, rendered as the xterm notice).
 */
function emit(msg: unknown) {
  for (const handler of [...handlers]) handler(msg)
}

/** Answer every outstanding pane.closed with a success result (the healthy server). */
function ackAllPaneCloses(extra: Record<string, unknown> = {}) {
  for (const [msg] of mockSend.mock.calls) {
    const m = msg as { type?: string; createRequestId?: string }
    if (m?.type === 'pane.closed' && m.createRequestId) {
      emit({ type: 'pane.closed.result', createRequestId: m.createRequestId, success: true, ...extra })
    }
  }
}

/** Answer every outstanding panes.closed batch with a result (the healthy server). */
function ackPanesClosedBatches(extra: Record<string, unknown> = {}) {
  for (const [msg] of mockSend.mock.calls) {
    const m = msg as { type?: string; requestId?: string }
    if (m?.type === 'panes.closed' && m.requestId) {
      emit({ type: 'panes.closed.result', requestId: m.requestId, success: true, ...extra })
    }
  }
}

/** The call-sequence index of the first send of `type` (-1 when never sent). */
function firstSendIndexOf(type: string): number {
  return mockSend.mock.calls.findIndex(([m]) => (m as { type?: string }).type === type)
}

function sentCallsOf(type: string): Array<Record<string, unknown>> {
  return mockSend.mock.calls.map(([m]) => m as Record<string, unknown>).filter((m) => m.type === type)
}

function terminalContent(crid: string, terminalId?: string): PaneContent {
  return {
    kind: 'terminal',
    createRequestId: crid,
    ...(terminalId ? { terminalId } : {}),
    status: 'running',
    mode: 'shell',
  } as PaneContent
}

function freshAgentContent(crid: string): PaneContent {
  return {
    kind: 'fresh-agent',
    createRequestId: crid,
    provider: 'claude',
    sessionType: 'freshclaude',
    sessionId: `sess-${crid}`,
    status: 'idle',
  } as PaneContent
}

function createStore() {
  return configureStore({
    reducer: { tabs: tabsReducer, panes: panesReducer, connection: connectionReducer },
    middleware: (getDefault) => getDefault().concat(terminalDetachMiddleware as any),
  })
}

/** A store with one tab holding two terminal panes (vertical split). */
function createTwoPaneStore(opts?: { cridB?: string; terminalIdB?: string; terminalIdA?: string; sessionRefB?: { provider: string; sessionId: string } }) {
  const store = createStore()
  store.dispatch(addTab({ id: 'tab-1', mode: 'shell' }))
  store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('req-a', opts?.terminalIdA ?? 'term-a') }))
  store.dispatch(splitPane({
    tabId: 'tab-1',
    paneId: 'pane-1',
    direction: 'vertical',
    newContent: {
      ...terminalContent(opts?.cridB ?? 'req-b', opts?.terminalIdB ?? 'term-b'),
      ...(opts?.sessionRefB ? { sessionRef: opts.sessionRefB } : {}),
    },
    newPaneId: 'pane-2',
  }))
  mockSend.mockClear()
  return store
}

function paneContents(store: ReturnType<typeof createStore>, tabId: string): Array<{ paneId: string; content: PaneContent }> {
  const root = store.getState().panes.layouts[tabId]
  return root ? collectPaneEntries(root) : []
}

function paneCloseErrors(store: ReturnType<typeof createStore>, tabId: string) {
  return Object.fromEntries(
    paneContents(store, tabId)
      .filter(({ content }) => (content as { closeError?: string }).closeError)
      .map(({ paneId, content }) => [paneId, (content as { closeError?: string }).closeError]),
  )
}

beforeEach(() => {
  mockSend.mockClear()
  handlers.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('closePaneWithCleanup — the acknowledged close gate (F2)', () => {
  it('success: the pane.close is acked BEFORE the layout loses the pane (success → pane gone)', async () => {
    const store = createTwoPaneStore()
    const close = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))

    // Before the ack the pane MUST still be there — nothing removed on an
    // unconfirmed close (the middleware belt alone cannot/does not reduce it).
    expect(paneContents(store, 'tab-1').map((p) => p.paneId)).toEqual(['pane-1', 'pane-2'])
    expect(mockSend).toHaveBeenCalledWith({
      type: 'pane.closed',
      createRequestId: 'req-b',
      terminalId: 'term-b',
    })

    ackAllPaneCloses()
    await close
    expect(paneContents(store, 'tab-1').map((p) => p.paneId)).toEqual(['pane-1'])
    expect(paneCloseErrors(store, 'tab-1')).toEqual({})
  })

  it('server-answered failure: the pane stays and its closeError carries the reason (failure → pane stays + error visible)', async () => {
    const store = createTwoPaneStore()
    const close = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    emit({
      type: 'pane.closed.result',
      createRequestId: 'req-b',
      success: false,
      error: 'the pane-close record could not be written durably',
    })
    await close
    expect(paneContents(store, 'tab-1').map((p) => p.paneId)).toEqual(['pane-1', 'pane-2'])
    expect(paneCloseErrors(store, 'tab-1')).toEqual({
      'pane-2': 'the pane close could not be recorded durably; the pane was left open',
    })
    // The detach loop never ran for the still-present pane's terminal.
    expect(mockSend.mock.calls.some(([m]) => (m as { type?: string }).type === 'terminal.detach')).toBe(false)
    // F2: the kept pane re-asserts open (after the close on the wire).
    expect(sentCallsOf('pane.opened')).toEqual([
      expect.objectContaining({ type: 'pane.opened', createRequestId: 'req-b', tabId: 'tab-1' }),
    ])
    expect(firstSendIndexOf('pane.closed')).toBeLessThan(firstSendIndexOf('pane.opened'))
  })

  it('a closed pane whose close EVIDENCE came back clean is retryable — a second close re-sends and succeeds', async () => {
    const store = createTwoPaneStore()
    const first = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    emit({ type: 'pane.closed.result', createRequestId: 'req-b', success: false })
    await first
    expect(paneContents(store, 'tab-1')).toHaveLength(2)
    const second = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    ackAllPaneCloses()
    await second
    expect(paneContents(store, 'tab-1').map((p) => p.paneId)).toEqual(['pane-1'])
    expect(mockSend.mock.calls.filter(([m]) => (m as { type?: string }).type === 'pane.closed').length).toBeGreaterThanOrEqual(2)
  })

  it('timeout: the pane stays, the timeout copy lands on the pane, and the pane re-asserts open (F2)', async () => {
    vi.useFakeTimers()
    const store = createTwoPaneStore()
    const close = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 50)
    await close
    expect(paneContents(store, 'tab-1')).toHaveLength(2)
    expect(paneCloseErrors(store, 'tab-1')).toEqual({
      'pane-2': 'the server did not acknowledge the pane close in time; the pane was left open',
    })
    expect(sentCallsOf('pane.opened')).toEqual([
      expect.objectContaining({ createRequestId: 'req-b', tabId: 'tab-1' }),
    ])
  })

  it('an in-flight create close (NO terminalId yet) is gated the same way — CRID-only message, acked before removal', async () => {
    const store = createStore()
    store.dispatch(addTab({ id: 'tab-1', mode: 'shell' }))
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('req-a', 'term-a') }))
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'vertical',
      newContent: terminalContent('req-inflight'),
      newPaneId: 'pane-2',
    }))
    mockSend.mockClear()
    const close = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    expect(mockSend).toHaveBeenCalledWith({ type: 'pane.closed', createRequestId: 'req-inflight' })
    expect(paneContents(store, 'tab-1')).toHaveLength(2)
    ackAllPaneCloses()
    await close
    expect(paneContents(store, 'tab-1')).toHaveLength(1)
  })

  it('a CRID-less pane (the pathological legacy shape) closes with NO gate — nothing to correlate', async () => {
    // The CRID-less shape exists only in legacy/preloaded layouts — the
    // reducers always mint a createRequestId, so preload the tree directly
    // (the terminalDetachMiddleware CRID-less pin's exact construction).
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer, connection: connectionReducer },
      middleware: (getDefault) => getDefault().concat(terminalDetachMiddleware as any),
      preloadedState: {
        tabs: { tabs: [{ id: 'tab-1', title: 'T1', mode: 'shell' }], activeTabId: 'tab-1' },
        panes: {
          layouts: {
            'tab-1': {
              type: 'split' as const,
              id: 'split-1',
              direction: 'horizontal' as const,
              sizes: [50, 50] as [number, number],
              children: [
                { type: 'leaf' as const, id: 'pane-1', content: terminalContent('req-a', 'term-a') },
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
    expect(paneContents(store, 'tab-1')).toHaveLength(2)
    mockSend.mockClear()
    await store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    expect(paneContents(store, 'tab-1')).toHaveLength(1)
    // No gate send AND no belt send for CLOSE EVIDENCE: the identity
    // collectors deliberately skip CRID-less panes (never a malformed record
    // key). The identity-driven terminal.detach still fires — unchanged.
    expect(mockSend.mock.calls.filter(([m]) => (m as { type?: string }).type === 'pane.closed')).toEqual([])
    expect(mockSend).toHaveBeenCalledWith({ type: 'terminal.detach', terminalId: 'term-b' })
  })

  it('a non-terminal pane is never gated', async () => {
    const store = createStore()
    store.dispatch(addTab({ id: 'tab-1', mode: 'shell' }))
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: { kind: 'browser', browserInstanceId: 'bi-1', url: 'https://example.com' } as PaneContent,
    }))
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'vertical',
      newContent: { kind: 'browser', browserInstanceId: 'bi-2', url: 'https://example.com' } as PaneContent,
      newPaneId: 'pane-2',
    }))
    mockSend.mockClear()
    await store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    expect(paneContents(store, 'tab-1')).toHaveLength(1)
    expect(mockSend).not.toHaveBeenCalled()
  })
})

describe('focused-episode-7 round 4 (F2) — fresh-agent panes are gated exactly like terminal panes', () => {
  function createMixedStore() {
    const store = createStore()
    store.dispatch(addTab({ id: 'tab-1', mode: 'shell' }))
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('req-a', 'term-a') }))
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'vertical',
      newContent: freshAgentContent('req-fa'),
      newPaneId: 'pane-fa',
    }))
    mockSend.mockClear()
    return store
  }

  it('closePaneWithCleanup on a fresh-agent pane sends the CRID-only pane.closed and awaits the ack', async () => {
    const store = createMixedStore()
    const close = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-fa' }))
    // Gated: nothing moves before the ack; the message names the pane
    // identity the fresh-agent pane always carries (no terminalId — the
    // in-flight-create shape is the only shape this pane kind knows).
    expect(mockSend).toHaveBeenCalledWith({ type: 'pane.closed', createRequestId: 'req-fa' })
    expect(paneContents(store, 'tab-1')).toHaveLength(2)
    ackAllPaneCloses()
    await close
    expect(paneContents(store, 'tab-1').map((p) => p.paneId)).toEqual(['pane-1'])
  })

  it('a failed fresh-agent pane close keeps the pane and re-asserts it open', async () => {
    const store = createMixedStore()
    const close = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-fa' }))
    emit({ type: 'pane.closed.result', createRequestId: 'req-fa', success: false })
    await close
    expect(paneContents(store, 'tab-1')).toHaveLength(2)
    expect(sentCallsOf('pane.opened')).toEqual([
      expect.objectContaining({ type: 'pane.opened', createRequestId: 'req-fa', tabId: 'tab-1' }),
    ])
  })

  it('replacePaneWithCleanup gates a fresh-agent pane too (the per-REMOVAL evidence, not per-kill)', async () => {
    const store = createMixedStore()
    const replace = store.dispatch(replacePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-fa' }))
    expect(mockSend).toHaveBeenCalledWith({ type: 'pane.closed', createRequestId: 'req-fa' })
    expect(paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-fa')?.content.kind).toBe('fresh-agent')
    ackAllPaneCloses()
    await replace
    expect(paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-fa')?.content.kind).toBe('picker')
  })

  it('a mixed whole-tab close carries BOTH identities in the ONE batch and re-asserts BOTH on failure', async () => {
    const store = createMixedStore()
    const close = store.dispatch(closeTab('tab-1'))
    const batches = sentCallsOf('panes.closed')
    expect(batches).toHaveLength(1)
    expect(batches[0].panes).toEqual([
      { createRequestId: 'req-a', terminalId: 'term-a' },
      { createRequestId: 'req-fa' },
    ])
    // A failed batch keeps the tab and re-asserts EVERY kept pane open —
    // the fresh-agent pane included (its standing close record must be
    // consumable by its own open re-assertion, per-REMOVAL).
    ackPanesClosedBatches({ success: false })
    await close
    expect(store.getState().tabs.tabs.some((t) => t.id === 'tab-1')).toBe(true)
    expect(sentCallsOf('pane.opened')).toEqual([
      expect.objectContaining({ createRequestId: 'req-a', tabId: 'tab-1' }),
      expect.objectContaining({ createRequestId: 'req-fa', tabId: 'tab-1' }),
    ])
    // And the healthy path: an acked mixed batch removes the whole tab.
    const second = store.dispatch(closeTab('tab-1'))
    ackPanesClosedBatches()
    await second
    expect(store.getState().tabs.tabs.some((t) => t.id === 'tab-1')).toBe(false)
  })
})

describe('closeTab — the all-or-nothing close gate (F2) + ONE envelope per tab close (F1)', () => {
  it('success: ONE acknowledged batch envelope covers the whole pane set → the whole tab is gone', async () => {
    const store = createTwoPaneStore()
    const close = store.dispatch(closeTab('tab-1'))
    expect(store.getState().tabs.tabs.some((t) => t.id === 'tab-1')).toBe(true)
    // F1: exactly one batch message carrying the tab's FULL pane-identity set —
    // no per-pane pane.closed traffic from the gated lane, so a partial
    // per-pane durable outcome is impossible by construction.
    const batches = sentCallsOf('panes.closed')
    expect(batches).toHaveLength(1)
    expect(sentCallsOf('pane.closed')).toEqual([])
    expect(batches[0]).toMatchObject({
      type: 'panes.closed',
      tabId: 'tab-1',
      panes: [
        { createRequestId: 'req-a', terminalId: 'term-a' },
        { createRequestId: 'req-b', terminalId: 'term-b' },
      ],
    })
    expect(typeof batches[0].requestId).toBe('string')
    ackPanesClosedBatches()
    await close
    expect(store.getState().tabs.tabs.some((t) => t.id === 'tab-1')).toBe(false)
    expect(store.getState().panes.layouts['tab-1']).toBeUndefined()
  })

  it('a failed batch keeps the WHOLE tab and EVERY gated pane wears the error (F1: a partial per-pane outcome is impossible)', async () => {
    const store = createTwoPaneStore()
    const close = store.dispatch(closeTab('tab-1'))
    ackPanesClosedBatches({ success: false })
    await close
    expect(store.getState().tabs.tabs.some((t) => t.id === 'tab-1')).toBe(true)
    expect(store.getState().panes.layouts['tab-1']).toBeDefined()
    expect(paneCloseErrors(store, 'tab-1')).toEqual({
      'pane-1': 'the pane close could not be recorded durably; the pane was left open',
      'pane-2': 'the pane close could not be recorded durably; the pane was left open',
    })
  })

  it('F2: a failed close re-asserts every kept pane open (pane.opened AFTER the close on the wire)', async () => {
    const store = createTwoPaneStore()
    const close = store.dispatch(closeTab('tab-1'))
    ackPanesClosedBatches({ success: false })
    await close
    const opened = sentCallsOf('pane.opened')
    expect(opened).toEqual([
      expect.objectContaining({ type: 'pane.opened', createRequestId: 'req-a', tabId: 'tab-1' }),
      expect.objectContaining({ type: 'pane.opened', createRequestId: 'req-b', tabId: 'tab-1' }),
    ])
    // The messaging order the server replays: the close journals BEFORE the
    // re-assertions consume it (a socket-down close never leaves the record
    // durable-standing once the client re-asserts).
    expect(firstSendIndexOf('panes.closed')).toBeGreaterThanOrEqual(0)
    expect(firstSendIndexOf('pane.opened')).toBeGreaterThan(firstSendIndexOf('panes.closed'))
  })

  it('F2: a timed-out close re-asserts every kept pane open (the ambiguous-timeout reconciliation)', async () => {
    vi.useFakeTimers()
    const store = createTwoPaneStore()
    const close = store.dispatch(closeTab('tab-1'))
    await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 50)
    await close
    expect(store.getState().tabs.tabs.some((t) => t.id === 'tab-1')).toBe(true)
    expect(paneCloseErrors(store, 'tab-1')).toEqual({
      'pane-1': 'the server did not acknowledge the pane close in time; the pane was left open',
      'pane-2': 'the server did not acknowledge the pane close in time; the pane was left open',
    })
    const opened = sentCallsOf('pane.opened')
    expect(opened).toEqual([
      expect.objectContaining({ createRequestId: 'req-a', tabId: 'tab-1' }),
      expect.objectContaining({ createRequestId: 'req-b', tabId: 'tab-1' }),
    ])
  })

  it('a tab with no terminal panes closes with no gate traffic', async () => {
    const store = createStore()
    store.dispatch(addTab({ id: 'tab-1', mode: 'shell' }))
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: { kind: 'editor', path: '/tmp/x.ts' } as PaneContent,
    }))
    mockSend.mockClear()
    await store.dispatch(closeTab('tab-1'))
    expect(store.getState().tabs.tabs.some((t) => t.id === 'tab-1')).toBe(false)
    expect(mockSend).not.toHaveBeenCalled()
  })
})

describe('focused-episode-7 round 4 (F3) — a pending tab close freezes the pane identity set', () => {
  it.each([
    {
      name: 'splitPane',
      mutate: (store: ReturnType<typeof createStore>) => store.dispatch(splitPane({
        tabId: 'tab-1',
        paneId: 'pane-1',
        direction: 'horizontal',
        newContent: terminalContent('req-late'),
        newPaneId: 'pane-late',
      })),
      expectRefused: (store: ReturnType<typeof createStore>) =>
        expect(paneContents(store, 'tab-1').some((p) => (p.content as { createRequestId?: string }).createRequestId === 'req-late')).toBe(false),
    },
    {
      name: 'addPane',
      mutate: (store: ReturnType<typeof createStore>) => store.dispatch(addPane({
        tabId: 'tab-1',
        newContent: terminalContent('req-late'),
      })),
      expectRefused: (store: ReturnType<typeof createStore>) =>
        expect(paneContents(store, 'tab-1').some((p) => (p.content as { createRequestId?: string }).createRequestId === 'req-late')).toBe(false),
    },
    {
      name: 'replacePane (a re-key to a picker the user could then mint content into)',
      mutate: (store: ReturnType<typeof createStore>) => store.dispatch(replacePane({ tabId: 'tab-1', paneId: 'pane-2' })),
      expectRefused: (store: ReturnType<typeof createStore>) =>
        expect(paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-2')?.content.kind).toBe('terminal'),
    },
    {
      name: 'updatePaneContent minting a new identity (the picker-select path)',
      mutate: (store: ReturnType<typeof createStore>) => store.dispatch(updatePaneContent({
        tabId: 'tab-1',
        paneId: 'pane-2',
        // No createRequestId in the input: normalize mints a NEW pane identity
        // — exactly the gain/re-key the frozen set outlaws mid-close.
        content: { kind: 'terminal', mode: 'shell' } as PaneContent,
      })),
      expectRefused: (store: ReturnType<typeof createStore>) =>
        expect((paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-2')?.content as { createRequestId?: string } | undefined)?.createRequestId).toBe('req-b'),
    },
  ])('a mid-wait $name is refused; the post-ack removal applies exactly the frozen set', async ({ mutate, expectRefused }) => {
    const store = createTwoPaneStore()
    const close = store.dispatch(closeTab('tab-1'))
    // Sanity: the batch named exactly the frozen pair.
    expect(sentCallsOf('panes.closed')[0]?.panes).toEqual([
      { createRequestId: 'req-a', terminalId: 'term-a' },
      { createRequestId: 'req-b', terminalId: 'term-b' },
    ])

    // THE FINDING'S SCENARIO: the still-visible tab gains/re-keys a pane
    // while the close's acknowledgement is in flight — REFUSED, so the pane
    // can never be removed with no close evidence journaled for it.
    mutate(store)
    expectRefused(store)

    ackPanesClosedBatches()
    await close
    expect(store.getState().tabs.tabs.some((t) => t.id === 'tab-1')).toBe(false)
    expect(store.getState().panes.layouts['tab-1']).toBeUndefined()
    // And no second batch ever went out carrying the refused identity.
    expect(sentCallsOf('panes.closed')).toHaveLength(1)
  })

  it('an identity-PRESERVING updatePaneContent fold still lands mid-wait (terminal.created must not be lost)', async () => {
    const store = createStore()
    store.dispatch(addTab({ id: 'tab-1', mode: 'shell' }))
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('req-a', 'term-a') }))
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'vertical',
      newContent: terminalContent('req-b'), // the in-flight create: CRID-only
      newPaneId: 'pane-2',
    }))
    mockSend.mockClear()
    const close = store.dispatch(closeTab('tab-1'))
    expect(sentCallsOf('panes.closed')[0]?.panes).toEqual([
      { createRequestId: 'req-a', terminalId: 'term-a' },
      { createRequestId: 'req-b' },
    ])
    // terminal.created folds the SAME identity — allowed even on a closing tab.
    store.dispatch(updatePaneContent({
      tabId: 'tab-1',
      paneId: 'pane-2',
      content: terminalContent('req-b', 'term-b-late'),
    }))
    expect((paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-2')?.content as { terminalId?: string }).terminalId)
      .toBe('term-b-late')
    ackPanesClosedBatches()
    await close
    expect(store.getState().panes.layouts['tab-1']).toBeUndefined()
  })

  it('a failed close lifts the block — the kept tab mutates normally again', async () => {
    const store = createTwoPaneStore()
    const close = store.dispatch(closeTab('tab-1'))
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'horizontal',
      newContent: terminalContent('req-during'),
      newPaneId: 'pane-during',
    }))
    expect(paneContents(store, 'tab-1')).toHaveLength(2) // refused mid-wait
    ackPanesClosedBatches({ success: false })
    await close
    expect(store.getState().tabs.tabs.some((t) => t.id === 'tab-1')).toBe(true)
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'horizontal',
      newContent: terminalContent('req-after'),
      newPaneId: 'pane-after',
    }))
    expect(paneContents(store, 'tab-1')).toHaveLength(3) // allowed again after resolution
  })

  it('a second closeTab dispatch while the close is in flight sends no second batch — the in-flight close completes it', async () => {
    const store = createTwoPaneStore()
    const first = store.dispatch(closeTab('tab-1'))
    const second = store.dispatch(closeTab('tab-1'))
    expect(sentCallsOf('panes.closed')).toHaveLength(1)
    ackPanesClosedBatches()
    await Promise.all([first, second])
    expect(store.getState().tabs.tabs.some((t) => t.id === 'tab-1')).toBe(false)
  })

  it('a hydratePanes fold mid-wait never re-seeds the closing tab (the remote shape cannot grow the frozen set)', async () => {
    const store = createTwoPaneStore()
    const close = store.dispatch(closeTab('tab-1'))
    const local = store.getState().panes
    // A remote hydration claims the tab holds THREE panes (a newer generation
    // on another device). The closing tab keeps its frozen local layout.
    store.dispatch(hydratePanes({
      ...local,
      layouts: {
        'tab-1': {
          type: 'split',
          id: 'rs1',
          direction: 'horizontal',
          sizes: [50, 50],
          children: [
            { type: 'leaf', id: 'pane-1', content: terminalContent('req-a', 'term-a') },
            {
              type: 'split',
              id: 'rs2',
              direction: 'vertical',
              sizes: [50, 50],
              children: [
                { type: 'leaf', id: 'pane-2', content: terminalContent('req-b', 'term-b') },
                { type: 'leaf', id: 'pane-remote', content: terminalContent('req-remote', 'term-remote') },
              ],
            },
          ],
        },
      },
    }))
    expect(paneContents(store, 'tab-1').some((p) => (p.content as { createRequestId?: string }).createRequestId === 'req-remote')).toBe(false)
    ackPanesClosedBatches()
    await close
    expect(store.getState().panes.layouts['tab-1']).toBeUndefined()
  })

  it.each([
    {
      name: 'clearDeadTerminals (server-reported dead handle → identity re-mint)',
      rekey: (store: ReturnType<typeof createStore>) => store.dispatch(clearDeadTerminals({ liveTerminalIds: [] })),
      expectUnrekeyed: (store: ReturnType<typeof createStore>) => {
        const p1 = paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-1')?.content as { createRequestId?: string; terminalId?: string }
        const p2 = paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-2')?.content as { createRequestId?: string; terminalId?: string }
        expect(p1.createRequestId).toBe('req-a')
        expect(p1.terminalId).toBe('term-a')
        expect(p2.createRequestId).toBe('req-b')
        expect(p2.terminalId).toBe('term-b')
      },
    },
    {
      name: 'clearTerminalLiveHandles (server-driven handle wipe → identity re-mint)',
      rekey: (store: ReturnType<typeof createStore>) => store.dispatch(clearTerminalLiveHandles({ terminalIds: ['term-a', 'term-b'] })),
      expectUnrekeyed: (store: ReturnType<typeof createStore>) => {
        const p1 = paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-1')?.content as { createRequestId?: string; terminalId?: string }
        const p2 = paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-2')?.content as { createRequestId?: string; terminalId?: string }
        expect(p1.createRequestId).toBe('req-a')
        expect(p1.terminalId).toBe('term-a')
        expect(p2.createRequestId).toBe('req-b')
        expect(p2.terminalId).toBe('term-b')
      },
    },
    {
      name: 'repairCodexIdentityMismatch (server-driven mismatch repair re-keys the pane)',
      store: () => createTwoPaneStore({ sessionRefB: { provider: 'codex', sessionId: 'sess-mismatch' } }),
      rekey: (store: ReturnType<typeof createStore>) => store.dispatch(repairCodexIdentityMismatch({
        tabId: 'tab-1',
        paneId: 'pane-2',
        staleTerminalId: 'term-b',
        expectedSessionRef: { provider: 'codex', sessionId: 'sess-mismatch' },
        createRequestId: 'req-repaired',
      })),
      expectUnrekeyed: (store: ReturnType<typeof createStore>) => {
        const p2 = paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-2')?.content as { createRequestId?: string }
        expect(p2.createRequestId).toBe('req-b')
      },
    },
  ])('focused-ep7 round 5 (F2): a mid-close $name is REFUSED for panes of the closing tab; the acked batch stays the whole truth', async ({ store: makeStore, rekey, expectUnrekeyed }) => {
    const store = (makeStore ?? createTwoPaneStore)()
    const close = store.dispatch(closeTab('tab-1'))

    // THE FINDING'S SCENARIO (the tab-close half): a server-driven rekey
    // lands while the batch acknowledgement is in flight. REFUSED — the
    // acknowledgement must cover exactly the identity set the post-ack
    // removal applies; a replacement identity removed evidenceless leaves a
    // recoverable ghost row.
    rekey(store)
    expectUnrekeyed(store)

    ackPanesClosedBatches()
    await close
    expect(store.getState().tabs.tabs.some((t) => t.id === 'tab-1')).toBe(false)
  })
})

describe('focused-episode-7 round 5 (F2) — a pending SINGLE-pane close freezes THAT pane\'s identity (the one shared guard)', () => {
  it('clearDeadTerminals skips the pending pane but still rekeys its un-pending sibling (pane-scoped discrimination)', async () => {
    const store = createTwoPaneStore()
    const close = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))

    // term-b reported dead mid-wait: the pending pane MUST keep its snapshot
    // identity (the awaited pane.closed covers 'req-b'; a re-mint would make
    // the post-ack removal drop evidenceless replacement identity 'req-*').
    store.dispatch(clearDeadTerminals({ liveTerminalIds: ['term-a'] }))
    let p2 = paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-2')?.content as { createRequestId?: string; terminalId?: string }
    expect(p2.createRequestId).toBe('req-b')
    expect(p2.terminalId).toBe('term-b')

    // The SIBLING is not pending: its dead-handle rekey still lands — the
    // guard is pane-scoped, not a whole-reducer refusal of the tab.
    store.dispatch(clearDeadTerminals({ liveTerminalIds: ['term-b'] }))
    const p1 = paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-1')?.content as { createRequestId?: string; terminalId?: string }
    expect(p1.terminalId).toBeUndefined()
    expect(p1.createRequestId).not.toBe('req-a')

    ackAllPaneCloses()
    await close
    expect(paneContents(store, 'tab-1').map((p) => p.paneId)).toEqual(['pane-1'])
  })

  it('clearTerminalLiveHandles skips the pending pane', async () => {
    const store = createTwoPaneStore()
    const close = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    store.dispatch(clearTerminalLiveHandles({ terminalIds: ['term-b'] }))
    const p2 = paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-2')?.content as { createRequestId?: string; terminalId?: string }
    expect(p2.createRequestId).toBe('req-b')
    expect(p2.terminalId).toBe('term-b')
    ackAllPaneCloses()
    await close
    expect(paneContents(store, 'tab-1').map((p) => p.paneId)).toEqual(['pane-1'])
  })

  it('repairCodexIdentityMismatch is refused for the pending pane', async () => {
    const store = createTwoPaneStore({ sessionRefB: { provider: 'codex', sessionId: 'sess-mismatch' } })
    const close = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    store.dispatch(repairCodexIdentityMismatch({
      tabId: 'tab-1',
      paneId: 'pane-2',
      staleTerminalId: 'term-b',
      expectedSessionRef: { provider: 'codex', sessionId: 'sess-mismatch' },
      createRequestId: 'req-repaired',
    }))
    const p2 = paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-2')?.content as { createRequestId?: string }
    expect(p2.createRequestId).toBe('req-b')
    ackAllPaneCloses()
    await close
    expect(paneContents(store, 'tab-1').map((p) => p.paneId)).toEqual(['pane-1'])
  })

  it.each([
    {
      name: 'updatePaneContent minting a fresh identity (the picker-select shape)',
      rekey: (store: ReturnType<typeof createStore>) => store.dispatch(updatePaneContent({
        tabId: 'tab-1',
        paneId: 'pane-2',
        content: { kind: 'terminal', mode: 'shell' } as PaneContent, // no createRequestId → normalize mints
      })),
      expectUnrekeyed: (store: ReturnType<typeof createStore>) => {
        const p2 = paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-2')?.content as { createRequestId?: string }
        expect(p2.createRequestId).toBe('req-b')
      },
    },
    {
      name: 'replacePane (the wholesale re-key to a picker)',
      rekey: (store: ReturnType<typeof createStore>) => store.dispatch(replacePane({ tabId: 'tab-1', paneId: 'pane-2' })),
      expectUnrekeyed: (store: ReturnType<typeof createStore>) => {
        expect(paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-2')?.content.kind).toBe('terminal')
      },
    },
  ])('a mid-wait $name on the pending pane is refused', async ({ rekey, expectUnrekeyed }) => {
    const store = createTwoPaneStore()
    const close = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    rekey(store)
    expectUnrekeyed(store)
    ackAllPaneCloses()
    await close
    expect(paneContents(store, 'tab-1').map((p) => p.paneId)).toEqual(['pane-1'])
  })

  it('a mid-wait split GAIN is still allowed on a single-pane close (additions carry no evidence hole — only re-keys are frozen)', async () => {
    const store = createTwoPaneStore()
    const close = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'horizontal',
      newContent: terminalContent('req-late'),
      newPaneId: 'pane-late',
    }))
    expect(paneContents(store, 'tab-1').some((p) => (p.content as { createRequestId?: string }).createRequestId === 'req-late')).toBe(true)
    ackAllPaneCloses()
    await close
    expect(paneContents(store, 'tab-1').map((p) => p.paneId).sort()).toEqual(['pane-1', 'pane-late'])
  })

  it('two overlapping single-pane closes freeze independently — acking one never unfreezes the other', async () => {
    const store = createStore()
    store.dispatch(addTab({ id: 'tab-1', mode: 'shell' }))
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('req-a', 'term-a') }))
    store.dispatch(splitPane({
      tabId: 'tab-1', paneId: 'pane-1', direction: 'vertical', newContent: terminalContent('req-b', 'term-b'), newPaneId: 'pane-2',
    }))
    store.dispatch(splitPane({
      tabId: 'tab-1', paneId: 'pane-1', direction: 'vertical', newContent: terminalContent('req-c', 'term-c'), newPaneId: 'pane-3',
    }))
    mockSend.mockClear()
    const closeB = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    const closeC = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-3' }))
    // Ack pane-2's close only; pane-2 is removed. pane-3's window is STILL
    // pending: term-c going dead mid-wait must not rekey it.
    emit({ type: 'pane.closed.result', createRequestId: 'req-b', success: true })
    await closeB
    expect(paneContents(store, 'tab-1').some((p) => p.paneId === 'pane-2')).toBe(false)
    store.dispatch(clearDeadTerminals({ liveTerminalIds: ['term-a', 'term-b'] }))
    const p3 = paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-3')?.content as { createRequestId?: string; terminalId?: string }
    expect(p3.createRequestId).toBe('req-c')
    expect(p3.terminalId).toBe('term-c')
    emit({ type: 'pane.closed.result', createRequestId: 'req-c', success: true })
    await closeC
    expect(paneContents(store, 'tab-1').map((p) => p.paneId)).toEqual(['pane-1'])
  })

  it('a FAILED single-pane close lifts its pane freeze — the kept pane rekeys normally again', async () => {
    const store = createTwoPaneStore()
    const close = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    emit({ type: 'pane.closed.result', createRequestId: 'req-b', success: false })
    await close
    expect(paneContents(store, 'tab-1')).toHaveLength(2)
    store.dispatch(clearDeadTerminals({ liveTerminalIds: ['term-a'] }))
    const p2 = paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-2')?.content as { createRequestId?: string; terminalId?: string }
    expect(p2.terminalId).toBeUndefined() // rekeyed — no longer pending
    expect(p2.createRequestId).not.toBe('req-b')
  })

  it('replacePaneWithCleanup freezes the discarded pane during its own wait, and its post-ack replace still lands', async () => {
    const store = createTwoPaneStore()
    const replace = store.dispatch(replacePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    // A server-driven handle wipe mid-wait must not rekey the discarded pane.
    store.dispatch(clearTerminalLiveHandles({ terminalIds: ['term-b'] }))
    const mid = paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-2')?.content as { createRequestId?: string; terminalId?: string }
    expect(mid.createRequestId).toBe('req-b')
    expect(mid.terminalId).toBe('term-b')
    // After the ack the gate's OWN replace lands (the freeze never eats the
    // close op's own follow-through).
    ackAllPaneCloses()
    await replace
    expect(paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-2')?.content.kind).toBe('picker')
  })

  it('a hydratePanes fold mid-single-close never re-keys the pending pane (the remote shape cannot replace the frozen identity)', async () => {
    const store = createTwoPaneStore()
    const close = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    const local = store.getState().panes
    store.dispatch(hydratePanes({
      ...local,
      layouts: {
        'tab-1': {
          type: 'split',
          id: 'rs1',
          direction: 'horizontal',
          sizes: [50, 50],
          children: [
            { type: 'leaf', id: 'pane-1', content: terminalContent('req-a', 'term-a') },
            { type: 'leaf', id: 'pane-2', content: terminalContent('req-remote', 'term-remote') },
          ],
        },
      },
    }))
    const p2 = paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-2')?.content as { createRequestId?: string }
    expect(p2.createRequestId).toBe('req-b')
    ackAllPaneCloses()
    await close
    expect(paneContents(store, 'tab-1').map((p) => p.paneId)).toEqual(['pane-1'])
  })
})

describe('closePaneWithCleanup last-pane cascade (F2)', () => {
  it('closing the last pane routes through the SAME gate (the whole-tab close — one batch envelope, F1)', async () => {
    const store = createStore()
    store.dispatch(addTab({ id: 'tab-1', mode: 'shell' }))
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('req-a', 'term-a') }))
    mockSend.mockClear()
    const close = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-1' }))
    // gated: neither pane nor tab moves before the ack — and the cascade
    // sends the BATCH envelope (the whole tab closes), not a lone pane.closed.
    expect(store.getState().tabs.tabs.some((t) => t.id === 'tab-1')).toBe(true)
    expect(store.getState().panes.layouts['tab-1']).toBeDefined()
    const batches = sentCallsOf('panes.closed')
    expect(batches).toHaveLength(1)
    expect(batches[0].panes).toEqual([{ createRequestId: 'req-a', terminalId: 'term-a' }])
    ackPanesClosedBatches()
    await close
    expect(store.getState().tabs.tabs.some((t) => t.id === 'tab-1')).toBe(false)
  })
})

describe('replacePaneWithCleanup — the context-menu replace gate (F2)', () => {
  it('success: acked close → the pane becomes a picker', async () => {
    const store = createTwoPaneStore()
    const replace = store.dispatch(replacePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    expect(mockSend).toHaveBeenCalledWith({
      type: 'pane.closed',
      createRequestId: 'req-b',
      terminalId: 'term-b',
    })
    ackAllPaneCloses()
    await replace
    const entries = paneContents(store, 'tab-1')
    expect(entries).toHaveLength(2)
    expect(entries.find((p) => p.paneId === 'pane-2')?.content.kind).toBe('picker')
  })

  it('failure: the original terminal content stays, wears the error, and re-asserts open (F2)', async () => {
    const store = createTwoPaneStore()
    const replace = store.dispatch(replacePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    emit({ type: 'pane.closed.result', createRequestId: 'req-b', success: false })
    await replace
    const entry = paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-2')
    expect(entry?.content.kind).toBe('terminal')
    expect((entry?.content as { closeError?: string }).closeError).toBe(
      'the pane close could not be recorded durably; the pane was left open',
    )
    expect(sentCallsOf('pane.opened')).toEqual([
      expect.objectContaining({ createRequestId: 'req-b', tabId: 'tab-1' }),
    ])
  })
})

describe('setPaneCloseError reducer', () => {
  it('sets and is surfaced on the terminal pane content', async () => {
    const store = createTwoPaneStore()
    store.dispatch(setPaneCloseError({ tabId: 'tab-1', paneId: 'pane-1', error: 'boom' }))
    expect(paneCloseErrors(store, 'tab-1')).toEqual({ 'pane-1': 'boom' })
  })
})

/**
 * Delta-round-8 (review fresheyes/usual-fresheyes-20260905T003747Z-3652059.md)
 * Finding F1 — `swapPanes` exchanges the two panes' COMPLETE contents,
 * createRequestId identities included, so it is an identity-CHANGING fold of
 * BOTH panes and goes through the ONE shared pending-close guard exactly like
 * `replacePane` et al.: refused (never deferred) while EITHER pane's close —
 * or the whole tab's — is outstanding.
 *
 * The finding's hazard, verbatim: a single-pane close or replacement awaits
 * its acknowledgement; a mid-wait swap moves the closing identity into the
 * OTHER pane; the ack then covers the moved identity while the post-ack
 * removal drops the swapped-IN identity now occupying the original pane ID.
 * The acknowledged identity stays visibly open under standing close evidence
 * (excluded from recovery while displayed but tombstoned the moment it leaves
 * the layout), and the swapped-in identity's removal rests on the
 * middleware's unacknowledged belt alone.
 */
describe('delta-round-8 (F1) — swapPanes consults the pending-close guard', () => {
  function paneCrid(store: ReturnType<typeof createStore>, tabId: string, paneId: string) {
    return (paneContents(store, tabId).find((p) => p.paneId === paneId)?.content as { createRequestId?: string } | undefined)?.createRequestId
  }

  it.each([
    { name: 'the swap TARGET', closing: 'pane-2', removed: 'pane-2', intact: 'pane-1', intactCrid: 'req-a' },
    { name: 'the swap SOURCE', closing: 'pane-1', removed: 'pane-1', intact: 'pane-2', intactCrid: 'req-b' },
  ])('a swap is refused while a single-pane close on $name is pending; the ack removes exactly the frozen identity', async ({ closing, removed, intact, intactCrid }) => {
    const store = createTwoPaneStore()
    const other = removed === 'pane-2' ? 'pane-1' : 'pane-2'
    const close = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: closing }))
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ type: 'pane.closed' }))

    // THE FINDING'S SCENARIO: the swap would move the pending-close identity
    // into the other pane while its acknowledgement is in flight — REFUSED.
    store.dispatch(swapPanes({ tabId: 'tab-1', paneId: removed, otherId: other }))
    expect(paneCrid(store, 'tab-1', 'pane-1')).toBe('req-a')
    expect(paneCrid(store, 'tab-1', 'pane-2')).toBe('req-b')

    ackAllPaneCloses()
    await close
    // The acked removal dropped exactly the identity the close covered; the
    // sibling kept its own identity — never a swap-shadowed casualty.
    expect(paneContents(store, 'tab-1').map((p) => p.paneId)).toEqual([intact])
    expect(paneCrid(store, 'tab-1', intact)).toBe(intactCrid)
  })

  it('a swap is refused while a replace is pending on EITHER pane (the replace gate is a single-pane close)', async () => {
    const store = createTwoPaneStore()
    const replace = store.dispatch(replacePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    store.dispatch(swapPanes({ tabId: 'tab-1', paneId: 'pane-1', otherId: 'pane-2' }))
    expect(paneCrid(store, 'tab-1', 'pane-1')).toBe('req-a')
    expect(paneCrid(store, 'tab-1', 'pane-2')).toBe('req-b')
    ackAllPaneCloses()
    await replace
    expect(paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-2')?.content.kind).toBe('picker')
    expect(paneCrid(store, 'tab-1', 'pane-1')).toBe('req-a')
  })

  it('a swap is refused while the whole TAB close is pending (every pane of a closing tab is close-pending)', async () => {
    const store = createTwoPaneStore()
    const close = store.dispatch(closeTab('tab-1'))
    store.dispatch(swapPanes({ tabId: 'tab-1', paneId: 'pane-1', otherId: 'pane-2' }))
    expect(paneCrid(store, 'tab-1', 'pane-1')).toBe('req-a')
    expect(paneCrid(store, 'tab-1', 'pane-2')).toBe('req-b')
    ackPanesClosedBatches()
    await close
    expect(store.getState().panes.layouts['tab-1']).toBeUndefined()
  })

  it('discrimination control: a swap of two un-pending panes still lands while a THIRD pane\'s close is pending (the guard is pane-scoped)', async () => {
    const store = createTwoPaneStore()
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'horizontal',
      newContent: terminalContent('req-c', 'term-c'),
      newPaneId: 'pane-3',
    }))
    const close = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-3' }))
    store.dispatch(swapPanes({ tabId: 'tab-1', paneId: 'pane-1', otherId: 'pane-2' }))
    // Neither swapped pane is close-pending: the exchange lands.
    expect(paneCrid(store, 'tab-1', 'pane-1')).toBe('req-b')
    expect(paneCrid(store, 'tab-1', 'pane-2')).toBe('req-a')
    expect(paneCrid(store, 'tab-1', 'pane-3')).toBe('req-c')
    ackAllPaneCloses()
    await close
    expect(paneContents(store, 'tab-1').map((p) => p.paneId).sort()).toEqual(['pane-1', 'pane-2'])
    expect(paneCrid(store, 'tab-1', 'pane-1')).toBe('req-b')
  })
})

/**
 * Delta-round-8 (review fresheyes/usual-fresheyes-20260905T003747Z-3652059.md)
 * Finding F2 — one close op per tab at a time, and the unconfirmed-close heal
 * re-asserts ONLY still-displayed identities.
 *
 * F2-half-1 (serialization): the three gated close thunks used to interleave
 * across scopes — `closeTab` consulted only the tab mark, so a batch close
 * and a single-pane/replace close could run CONCURRENTLY and resolve in
 * either order; the loser's timeout then re-asserted a stale identity the
 * winner's committed close had already removed. The discipline now (the
 * guard's established rule — refuse, logged, never deferred):
 *  - a pane-scope start (`closePaneWithCleanup` / `replacePaneWithCleanup`)
 *    rejects while ANY close touching that tab is outstanding for the SAME
 *    pane (duplicate — idempotent-rejected) or for the WHOLE tab;
 *  - a tab-scope start (`closeTab`) rejects while ANY close touching that
 *    tab is outstanding (its own — the round-4 no-op — or any pane's);
 *  - overlapping closes of DIFFERENT panes in one tab stay allowed (the
 *    round-5 pinned regime: ref-counted, independently frozen).
 *
 * F2-half-2 (the heal's display check): the failure/timeout healing path
 * (`reassertKeptPanesOpen`) consults the CURRENT layout before each
 * `pane.opened` — a pane no longer displayed (e.g. removed by a committed
 * close while the wait was outstanding, however that removal arrived) has
 * nothing to reconcile, and re-asserting it would consume its standing close
 * evidence and re-attribute it open: a later recovery offering a session
 * from a tab the user closed. Both orders are pinned below: the pane close
 * timing out after its tab committed, and the batch timing out after one of
 * its panes committed. (Post-serialization the two gated thunks cannot
 * produce these interleaves between themselves; the pins drive the removals
 * through the direct reducers — the shape every committed close ends in —
 * because the display check is the defense for ANY mid-wait removal path,
 * not only the gated ones.)
 */
describe('delta-round-8 (F2) — close ops serialize per tab', () => {
  it('a single-pane close pending → a closeTab start is REJECTED (no batch, tab untouched); the settled close never latches a later tab close', async () => {
    const store = createTwoPaneStore()
    const closePaneP = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    const rejected = store.dispatch(closeTab('tab-1'))
    // No batch ever went out — the in-flight pane close is the tab's only
    // close op.
    expect(sentCallsOf('panes.closed')).toEqual([])
    ackAllPaneCloses()
    await Promise.all([closePaneP, rejected])
    expect(paneContents(store, 'tab-1').map((p) => p.paneId)).toEqual(['pane-1'])
    expect(store.getState().tabs.tabs.some((t) => t.id === 'tab-1')).toBe(true)
    // The rejection is not a latch: once the pane close settled, the tab
    // close starts and completes normally (NOW the batch covers pane-1 only).
    const second = store.dispatch(closeTab('tab-1'))
    const batches = sentCallsOf('panes.closed')
    expect(batches).toHaveLength(1)
    expect(batches[0].panes).toEqual([{ createRequestId: 'req-a', terminalId: 'term-a' }])
    ackPanesClosedBatches()
    await second
    expect(store.getState().tabs.tabs.some((t) => t.id === 'tab-1')).toBe(false)
  })

  it('a replace pending → a closeTab start is REJECTED (the replace gate holds the same pane-scope close)', async () => {
    const store = createTwoPaneStore()
    const replace = store.dispatch(replacePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    const rejected = store.dispatch(closeTab('tab-1'))
    expect(sentCallsOf('panes.closed')).toEqual([])
    ackAllPaneCloses()
    await Promise.all([replace, rejected])
    expect(paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-2')?.content.kind).toBe('picker')
    expect(store.getState().tabs.tabs.some((t) => t.id === 'tab-1')).toBe(true)
  })

  it('a tab close pending → a single-pane close start is REJECTED (no pane.closed; the batch alone covers the pane)', async () => {
    const store = createTwoPaneStore()
    const close = store.dispatch(closeTab('tab-1'))
    expect(sentCallsOf('panes.closed')).toHaveLength(1)
    const rejected = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    expect(sentCallsOf('pane.closed')).toEqual([])
    // The layout stands untouched until the ONE close op resolves.
    expect(paneContents(store, 'tab-1')).toHaveLength(2)
    ackPanesClosedBatches()
    await Promise.all([close, rejected])
    expect(store.getState().tabs.tabs.some((t) => t.id === 'tab-1')).toBe(false)
    expect(store.getState().panes.layouts['tab-1']).toBeUndefined()
  })

  it('a tab close pending → a replace start is REJECTED (no pane.closed; no picker lands mid-wait)', async () => {
    const store = createTwoPaneStore()
    const close = store.dispatch(closeTab('tab-1'))
    const rejected = store.dispatch(replacePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    expect(sentCallsOf('pane.closed')).toEqual([])
    expect(paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-2')?.content.kind).toBe('terminal')
    ackPanesClosedBatches()
    await Promise.all([close, rejected])
    expect(store.getState().panes.layouts['tab-1']).toBeUndefined()
  })

  it('a duplicate close of the SAME pane is idempotent-rejected — exactly ONE pane.closed; the in-flight close completes it', async () => {
    const store = createTwoPaneStore()
    const first = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    const duplicate = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    expect(sentCallsOf('pane.closed').filter((m) => m.createRequestId === 'req-b')).toHaveLength(1)
    ackAllPaneCloses()
    await Promise.all([first, duplicate])
    expect(paneContents(store, 'tab-1').map((p) => p.paneId)).toEqual(['pane-1'])
  })

  it('a replace of a close-pending pane is rejected (same key) — the close alone completes, no picker', async () => {
    const store = createTwoPaneStore()
    const close = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    const rejected = store.dispatch(replacePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    expect(sentCallsOf('pane.closed').filter((m) => m.createRequestId === 'req-b')).toHaveLength(1)
    ackAllPaneCloses()
    await Promise.all([close, rejected])
    expect(paneContents(store, 'tab-1').map((p) => p.paneId)).toEqual(['pane-1'])
  })

  it('a close of a replace-pending pane is rejected (same key) — the replace alone completes, the picker lands', async () => {
    const store = createTwoPaneStore()
    const replace = store.dispatch(replacePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    const rejected = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    expect(sentCallsOf('pane.closed').filter((m) => m.createRequestId === 'req-b')).toHaveLength(1)
    ackAllPaneCloses()
    await Promise.all([replace, rejected])
    expect(paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-2')?.content.kind).toBe('picker')
  })

  it('an overlapping close of a DIFFERENT pane in the same tab stays allowed (the round-5 pinned regime)', async () => {
    const store = createTwoPaneStore()
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'horizontal',
      newContent: terminalContent('req-c', 'term-c'),
      newPaneId: 'pane-3',
    }))
    const closeB = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    const closeC = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-3' }))
    expect(sentCallsOf('pane.closed')).toHaveLength(2)
    ackAllPaneCloses()
    await Promise.all([closeB, closeC])
    expect(paneContents(store, 'tab-1').map((p) => p.paneId)).toEqual(['pane-1'])
  })
})

describe('delta-round-8 (F2) — the unconfirmed-close heal re-asserts only still-displayed identities', () => {
  it('order 1 (the report\'s): the pane close timing out AFTER its tab\'s committed close re-asserts NOTHING — the pane is no longer displayed', async () => {
    vi.useFakeTimers()
    const store = createTwoPaneStore()
    const close = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    expect(sentCallsOf('pane.closed').filter((m) => m.createRequestId === 'req-b')).toHaveLength(1)
    // The committed batch-close shape (its post-ack ending): the tab and its
    // layout are BOTH gone before the pane close's wait times out.
    store.dispatch(removeTab('tab-1'))
    store.dispatch(removeLayout({ tabId: 'tab-1' }))
    await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 50)
    await close
    // NOTHING re-asserts the stale identity — nothing to reconcile; the
    // committed close evidence must stand consumed by no one.
    expect(sentCallsOf('pane.opened')).toEqual([])
  })

  it('order 2 (the reverse): the batch timing out AFTER one pane\'s committed close re-asserts ONLY the still-displayed siblings', async () => {
    vi.useFakeTimers()
    const store = createTwoPaneStore()
    const close = store.dispatch(closeTab('tab-1'))
    expect(sentCallsOf('panes.closed')[0]?.panes).toEqual([
      { createRequestId: 'req-a', terminalId: 'term-a' },
      { createRequestId: 'req-b', terminalId: 'term-b' },
    ])
    // The committed pane-close shape: pane-2 is already out of the layout
    // when the batch's wait times out.
    store.dispatch(closePane({ tabId: 'tab-1', paneId: 'pane-2' }))
    await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 50)
    await close
    // The still-displayed pane-1 re-asserts exactly as today; pane-2 is NOT
    // re-asserted — re-opening it would resurrect a pane whose committed
    // close already removed it.
    expect(sentCallsOf('pane.opened')).toEqual([
      expect.objectContaining({ type: 'pane.opened', createRequestId: 'req-a', tabId: 'tab-1' }),
    ])
    // The tab stands (its batch was never confirmed); only pane-1 wears the
    // timeout surface — the removed pane's error dispatch no-ops by the
    // content finder.
    expect(store.getState().tabs.tabs.some((t) => t.id === 'tab-1')).toBe(true)
    expect(paneCloseErrors(store, 'tab-1')).toEqual({
      'pane-1': 'the server did not acknowledge the pane close in time; the pane was left open',
    })
  })

  it('a server-answered FAILURE after the pane left the layout re-asserts NOTHING either (the display check is not timeout-specific)', async () => {
    const store = createTwoPaneStore()
    const close = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    store.dispatch(removeTab('tab-1'))
    store.dispatch(removeLayout({ tabId: 'tab-1' }))
    emit({ type: 'pane.closed.result', createRequestId: 'req-b', success: false })
    await close
    expect(sentCallsOf('pane.opened')).toEqual([])
  })
})
