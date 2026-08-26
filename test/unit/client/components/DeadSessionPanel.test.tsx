import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import type { Store } from '@reduxjs/toolkit'
import panesReducer, {
  resetPaneForReconcileCreate,
  resetFreshAgentPaneForReconcileCreate,
  clearReconcileWarming,
} from '@/store/panesSlice'
import type { DeadSessionEntry, PaneNode, ReconcileWarmingState } from '@/store/paneTypes'
import { buildRestoreError } from '@shared/session-contract'
import { DeadSessionPanel } from '@/components/DeadSessionPanel'
import { ReconcileWarmingBanner } from '@/components/ReconcileWarmingBanner'
import { clearReconcileRuntime } from '@/store/freshAgentSlice'

// --- ws-client mock: capture sent frames, support multiple onMessage subscribers ---

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  onMessage: vi.fn(),
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsMocks.send,
    onMessage: wsMocks.onMessage,
  }),
}))

const sentFrames: any[] = []
const messageHandlers = new Set<(msg: any) => void>()

function lastSentOfType(type: string): any {
  return [...sentFrames].reverse().find((f) => f?.type === type)
}

function deliverServerFrame(frame: Record<string, unknown>): void {
  act(() => {
    for (const handler of [...messageHandlers]) handler(frame)
  })
}

// --- store helpers: real panes reducer, seeded layouts ---

function leafPane(paneId: string, extra: Record<string, unknown> = {}): PaneNode {
  return {
    type: 'leaf',
    id: paneId,
    content: {
      kind: 'terminal',
      mode: 'shell',
      shell: 'system',
      status: 'running',
      createRequestId: `cr-${paneId}`,
      terminalId: `term-${paneId}`,
      ...extra,
    } as any,
  }
}

function layoutFor(paneIds: string[], extraByPane: Record<string, Record<string, unknown>> = {}): PaneNode {
  const leaves = paneIds.map((id) => leafPane(id, extraByPane[id] ?? {}))
  return leaves.reduce((acc, leaf, i) =>
    acc === null
      ? leaf
      : ({
          type: 'split',
          id: `split-${i}`,
          direction: 'horizontal',
          children: [acc, leaf],
          sizes: [50, 50],
        } as PaneNode),
  null as PaneNode | null)!
}

function entry(paneId: string): DeadSessionEntry {
  return { tabId: 'tab-1', paneId, title: `Terminal ${paneId}`, mode: 'shell' }
}

function ref(paneId: string): { tabId: string; paneId: string } {
  return { tabId: 'tab-1', paneId }
}

function sevenRefs(): { tabId: string; paneId: string }[] {
  return ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'].map(ref)
}

const storeDispatchedTypes = new WeakMap<Store, string[]>()

function dispatchedTypes(store: Store): string[] {
  return storeDispatchedTypes.get(store) ?? []
}

function renderWithStore(opts: {
  deadSessionAdjudication?: DeadSessionEntry[]
  reconcileWarming?: ReconcileWarmingState | null
  paneIds?: string[]
  extraContentByPane?: Record<string, Record<string, unknown>>
}) {
  const paneIds =
    opts.paneIds ??
    [...new Set([
      ...(opts.deadSessionAdjudication ?? []).map((e) => e.paneId),
      ...(opts.reconcileWarming?.paneRefs ?? []).map((r) => r.paneId),
    ])]
  const captured: string[] = []
  const store = configureStore({
    reducer: { panes: panesReducer },
    middleware: (getDefault) =>
      getDefault().concat(() => (next) => (action: any) => {
        if (typeof action?.type === 'string') captured.push(action.type)
        return next(action)
      }),
    preloadedState: {
      panes: {
        layouts: paneIds.length > 0 ? { 'tab-1': layoutFor(paneIds, opts.extraContentByPane ?? {}) } : {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
        restoreFallbackAttemptsByPane: {},
        deadSessionAdjudication: opts.deadSessionAdjudication ?? [],
        reconcileWarming: opts.reconcileWarming ?? null,
      } as any,
    },
  })
  storeDispatchedTypes.set(store, captured)
  render(
    <Provider store={store}>
      <DeadSessionPanel />
      <ReconcileWarmingBanner />
    </Provider>,
  )
  return { store }
}

function findLeaf(node: any, paneId: string): any {
  if (!node) return null
  if (node.type === 'leaf') return node.id === paneId ? node : null
  return findLeaf(node.children[0], paneId) ?? findLeaf(node.children[1], paneId)
}

describe('DeadSessionPanel + ReconcileWarmingBanner', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    sentFrames.length = 0
    messageHandlers.clear()
    wsMocks.send.mockImplementation((frame: unknown) => {
      sentFrames.push(frame)
    })
    wsMocks.onMessage.mockImplementation((cb: (msg: any) => void) => {
      messageHandlers.add(cb)
      return () => messageHandlers.delete(cb)
    })
  })

  afterEach(() => {
    cleanup()
  })

  // F11-human: one panel, never N modals.
  it('renders ONE dialog listing all dead panes', () => {
    renderWithStore({ deadSessionAdjudication: [entry('p1'), entry('p2'), entry('p3')] })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Dead sessions')
    expect(screen.getAllByRole('button', { name: /start fresh here/i })).toHaveLength(3)
  })

  it('Start fresh dispatches a fresh reset preserving createRequestId and removes the row', async () => {
    const { store } = renderWithStore({ deadSessionAdjudication: [entry('p1')] })
    await userEvent.click(screen.getByRole('button', { name: /start fresh here/i }))
    expect(dispatchedTypes(store)).toContain(resetPaneForReconcileCreate.type)
    expect(store.getState().panes.deadSessionAdjudication).toHaveLength(0)
    // I7: same createRequestId — never re-minted; pane reset for a fresh create.
    const leaf = findLeaf(store.getState().panes.layouts['tab-1'], 'p1')
    expect(leaf.content.createRequestId).toBe('cr-p1')
    expect(leaf.content.status).toBe('creating')
    expect(leaf.content.sessionRef).toBeUndefined()
  })

  // Task 5: fresh-agent rows must dispatch the fresh-agent reset — the
  // terminal-only reducer no-ops on fresh-agent content (a silent wedge).
  it('Start fresh here on a fresh-agent entry dispatches the fresh-agent reset (createRequestId preserved)', async () => {
    const { store } = renderWithStore({
      deadSessionAdjudication: [
        {
          tabId: 'tab-1',
          paneId: 'p1',
          title: 'Freshclaude',
          mode: 'claude',
          kind: 'fresh-agent',
          sessionRef: { provider: 'claude', sessionId: 'sess-dead' },
        },
      ],
      extraContentByPane: {
        p1: {
          kind: 'fresh-agent',
          sessionType: 'claude',
          provider: 'claude',
          status: 'connected',
          sessionId: 'sess-dead',
          sessionRef: { provider: 'claude', sessionId: 'sess-dead' },
          resumeSessionId: 'sess-dead',
          mode: undefined,
          shell: undefined,
          terminalId: undefined,
        },
      },
    })
    await userEvent.click(screen.getByRole('button', { name: /start fresh here/i }))
    expect(dispatchedTypes(store)).toContain(clearReconcileRuntime.type)
    expect(dispatchedTypes(store)).toContain(resetFreshAgentPaneForReconcileCreate.type)
    const leaf = findLeaf(store.getState().panes.layouts['tab-1'], 'p1')
    expect(leaf.content.kind).toBe('fresh-agent')
    expect(leaf.content.status).toBe('creating')
    expect(leaf.content.sessionRef).toBeUndefined()
    expect(leaf.content.resumeSessionId).toBeUndefined()
    // Council rule 2 / I7: same createRequestId — never re-minted by any fold path.
    expect(leaf.content.createRequestId).toBe('cr-p1')
    expect(store.getState().panes.deadSessionAdjudication).toHaveLength(0)
  })

  // Council rule 12: dead_session is a UI state, not a deletion — closing is an explicit user act.
  it('Close pane removes the pane from the layout and resolves the row', async () => {
    const { store } = renderWithStore({
      deadSessionAdjudication: [entry('p1')],
      paneIds: ['p1', 'p2'],
    })
    await userEvent.click(screen.getByRole('button', { name: /close pane/i }))
    const root = store.getState().panes.layouts['tab-1'] as any
    expect(root.type).toBe('leaf')
    expect(root.id).toBe('p2')
    expect(store.getState().panes.deadSessionAdjudication).toHaveLength(0)
  })

  it('Dismiss clears the adjudication list but keeps the per-pane restoreError card', async () => {
    const { store } = renderWithStore({
      deadSessionAdjudication: [entry('p1')],
      extraContentByPane: { p1: { restoreError: buildRestoreError('durable_artifact_missing') } },
    })
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(store.getState().panes.deadSessionAdjudication).toHaveLength(0)
    expect(screen.queryByRole('dialog')).toBeNull()
    const leaf = findLeaf(store.getState().panes.layouts['tab-1'], 'p1')
    expect(leaf.content.restoreError).toBeDefined()
  })

  it('renders nothing when the list is empty', () => {
    renderWithStore({ deadSessionAdjudication: [] })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  // restart-storm-all-panes-warming (council red test, client half):
  it('N warming panes produce exactly ONE banner with the count', () => {
    renderWithStore({ reconcileWarming: { count: 7, paneRefs: sevenRefs() } })
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent(/7/)
  })

  it('Retry now re-sends a reconcile request for exactly the warming panes', async () => {
    renderWithStore({ reconcileWarming: { count: 2, paneRefs: [ref('p1'), ref('p2')] } })
    await userEvent.click(screen.getByRole('button', { name: /retry now/i }))
    const req = lastSentOfType('pane.reconcile.request')
    expect(req).toBeDefined()
    expect(req.panes).toHaveLength(2)
    expect(req.panes.map((p: any) => p.paneKey).sort()).toEqual(['tab-1:p1', 'tab-1:p2'])
  })

  // Fold-ownership rule (Task 9): the banner folds ONLY results whose reconcileId its own Retry minted.
  it('Retry folds only its own reconcile result, skipping foreign reconcileIds', async () => {
    const { store } = renderWithStore({ reconcileWarming: { count: 2, paneRefs: [ref('p1'), ref('p2')] } })
    await userEvent.click(screen.getByRole('button', { name: /retry now/i }))
    const req = lastSentOfType('pane.reconcile.request')

    const resultFor = (reconcileId: string) => ({
      type: 'pane.reconcile.result',
      reconcileId,
      bootId: 'boot-1',
      serverInstanceId: 'srv-1',
      verdicts: req.panes.map((pane: any) => ({
        paneKey: pane.paneKey,
        verdict: 'attach',
        terminalId: `live-${pane.paneKey}`,
      })),
    })

    deliverServerFrame(resultFor('foreign-reconcile-id'))
    expect(store.getState().panes.reconcileWarming).not.toBeNull()
    expect(dispatchedTypes(store)).not.toContain(clearReconcileWarming.type)

    deliverServerFrame(resultFor(req.reconcileId))
    expect(store.getState().panes.reconcileWarming).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })
})
