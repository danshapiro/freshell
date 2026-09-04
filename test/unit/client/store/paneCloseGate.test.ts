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
} from '@/store/tabsSlice'
import panesReducer, { initLayout, splitPane, setPaneCloseError } from '@/store/panesSlice'
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

function createStore() {
  return configureStore({
    reducer: { tabs: tabsReducer, panes: panesReducer, connection: connectionReducer },
    middleware: (getDefault) => getDefault().concat(terminalDetachMiddleware as any),
  })
}

/** A store with one tab holding two terminal panes (vertical split). */
function createTwoPaneStore(opts?: { cridB?: string; terminalIdB?: string; terminalIdA?: string }) {
  const store = createStore()
  store.dispatch(addTab({ id: 'tab-1', mode: 'shell' }))
  store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('req-a', opts?.terminalIdA ?? 'term-a') }))
  store.dispatch(splitPane({
    tabId: 'tab-1',
    paneId: 'pane-1',
    direction: 'vertical',
    newContent: terminalContent(opts?.cridB ?? 'req-b', opts?.terminalIdB ?? 'term-b'),
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
