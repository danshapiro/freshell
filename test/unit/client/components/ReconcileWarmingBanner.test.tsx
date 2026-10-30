import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import type { Store } from '@reduxjs/toolkit'
import panesReducer, { clearReconcileWarming } from '@/store/panesSlice'
import type { PaneNode, ReconcileWarmingState } from '@/store/paneTypes'
import { ReconcileWarmingBanner } from '@/components/ReconcileWarmingBanner'

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

function leafPane(paneId: string): PaneNode {
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
    } as any,
  }
}

function layoutFor(paneIds: string[]): PaneNode {
  const leaves = paneIds.map((id) => leafPane(id))
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
  reconcileWarming?: ReconcileWarmingState | null
  paneIds?: string[]
}) {
  const paneIds =
    opts.paneIds ??
    [...new Set([
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
        layouts: paneIds.length > 0 ? { 'tab-1': layoutFor(paneIds) } : {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
        restoreFallbackAttemptsByPane: {},
        reconcileWarming: opts.reconcileWarming ?? null,
      } as any,
    },
  })
  storeDispatchedTypes.set(store, captured)
  render(
    <Provider store={store}>
      <ReconcileWarmingBanner />
    </Provider>,
  )
  return { store }
}

describe('ReconcileWarmingBanner', () => {
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

  // restart-storm-all-panes-warming (council red test, client half):
  it('N warming panes produce exactly ONE banner with the count', () => {
    renderWithStore({ reconcileWarming: { count: 7, paneRefs: sevenRefs() } })
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent(/waiting for session index/i)
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
