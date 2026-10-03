import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'

const { mockSend, handlers, mockManagedRuntimeViewVisibility, mockGetManagedRuntimeSoul } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  handlers: new Set<(msg: unknown) => void>(),
  mockManagedRuntimeViewVisibility: vi.fn(),
  mockGetManagedRuntimeSoul: vi.fn(),
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

vi.mock('@/lib/api', () => ({
  updateManagedRuntimeViewVisibility: mockManagedRuntimeViewVisibility,
  getManagedRuntimeSoul: mockGetManagedRuntimeSoul,
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

function expectManagedVisibilityCall(index: number, expected: [string, 'visible' | 'detached', number, number]) {
  expect(mockManagedRuntimeViewVisibility.mock.calls[index - 1]?.slice(0, 4)).toEqual(expected)
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

function managedTerminalContent(
  crid: string,
  terminalId: string,
  viewIntentId: string,
  viewIntentRevision: number,
  soulIntentRevision: number,
): PaneContent {
  return {
    ...terminalContent(crid, terminalId),
    viewIntentId,
    viewIntentRevision,
    soulIntentRevision,
    soulId: `soul-${viewIntentId}`,
  } as PaneContent
}

function managedViewResult(
  viewIntentId: string,
  visibility: 'visible' | 'detached',
  revision: number,
  soulIntentRevision: number,
) {
  return {
    viewId: viewIntentId,
    soulId: `soul-${viewIntentId}`,
    ownerId: 'owner-1',
    workspaceId: 'workspace-1',
    kind: 'automatic_primary' as const,
    preferredTabId: 'tab-1',
    preferredPaneId: `pane-${viewIntentId}`,
    title: viewIntentId,
    placementGroup: 'default',
    visibility,
    revision,
    soulIntentRevision,
    createdAt: 1,
    updatedAt: 2,
  }
}

function managedSoulDetail(
  viewIntentId: string,
  visibility: 'visible' | 'detached',
  revision: number,
  soulIntentRevision: number,
) {
  return {
    revision: 100,
    readiness: {},
    soul: { intentRevision: soulIntentRevision },
    viewIntents: [managedViewResult(viewIntentId, visibility, revision, soulIntentRevision)],
    actualUsage: null,
  }
}

function createStore(preloadedState?: {
  tabs: ReturnType<typeof tabsReducer>
  panes: ReturnType<typeof panesReducer>
  connection: ReturnType<typeof connectionReducer>
}) {
  return configureStore({
    reducer: { tabs: tabsReducer, panes: panesReducer, connection: connectionReducer },
    middleware: (getDefault) => getDefault().concat(terminalDetachMiddleware as any),
    preloadedState,
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

function createManagedTwoPaneStore(legacyViewId?: string) {
  const store = createStore()
  store.dispatch(addTab({ id: 'tab-1', mode: 'shell' }))
  store.dispatch(initLayout({
    tabId: 'tab-1',
    paneId: 'pane-1',
    content: managedTerminalContent('req-a', 'term-a', 'view-a', 2, 7),
  }))
  store.dispatch(splitPane({
    tabId: 'tab-1',
    paneId: 'pane-1',
    direction: 'vertical',
    newContent: managedTerminalContent('req-b', 'term-b', 'view-b', 3, 8),
    newPaneId: 'pane-2',
  }))
  mockSend.mockClear()
  if (legacyViewId) {
    const state = structuredClone(store.getState())
    const legacy = collectPaneEntries(state.panes.layouts['tab-1']).find(({ content }) => (
      (content as { viewIntentId?: string }).viewIntentId === legacyViewId
    ))!
    delete (legacy.content as { createRequestId?: string }).createRequestId
    return createStore(state)
  }
  return store
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

/** A durable backend that rejects stale fences and records real visibility transitions. */
function installManagedViewBackend() {
  const views = new Map([
    ['view-a', managedViewResult('view-a', 'visible', 2, 7)],
    ['view-b', managedViewResult('view-b', 'visible', 3, 8)],
  ])
  const mutate = async (viewId: string, visibility: 'visible' | 'detached', revision: number, soulRevision: number) => {
    const current = views.get(viewId)!
    if (revision !== current.revision || soulRevision !== current.soulIntentRevision) {
      throw new Error('stale managed view revision')
    }
    // The supervisor checks the soul fence but advances only the view revision,
    // including a visible -> visible mutation (view_intents.rs).
    const next = managedViewResult(viewId, visibility, revision + 1, soulRevision)
    views.set(viewId, next)
    return next
  }
  mockManagedRuntimeViewVisibility.mockImplementation(mutate)
  mockGetManagedRuntimeSoul.mockImplementation(async (soulId: string) => {
    const view = views.get(soulId.replace(/^soul-/, ''))!
    return managedSoulDetail(view.viewId, view.visibility, view.revision, view.soulIntentRevision)
  })
  return { views, mutate }
}

function projectManagedView(store: ReturnType<typeof createManagedTwoPaneStore>, view: ReturnType<typeof managedViewResult>) {
  const pane = paneContents(store, 'tab-1').find(({ content }) => (
    (content as { viewIntentId?: string }).viewIntentId === view.viewId
  ))!
  store.dispatch(updatePaneContent({
    tabId: 'tab-1',
    paneId: pane.paneId,
    content: { ...pane.content, viewIntentRevision: view.revision, soulIntentRevision: view.soulIntentRevision } as PaneContent,
  }))
}

const managedCloseCases = [
  {
    name: 'pane',
    viewId: 'view-b',
    viewRevision: 3,
    soulRevision: 8,
    start: (store: ReturnType<typeof createManagedTwoPaneStore>) => store.dispatch(
      closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }),
    ),
  },
  {
    name: 'tab',
    viewId: 'view-a',
    viewRevision: 2,
    soulRevision: 7,
    start: (store: ReturnType<typeof createManagedTwoPaneStore>) => store.dispatch(closeTab('tab-1')),
  },
  {
    name: 'replace',
    viewId: 'view-b',
    viewRevision: 3,
    soulRevision: 8,
    start: (store: ReturnType<typeof createManagedTwoPaneStore>) => store.dispatch(
      replacePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }),
    ),
  },
]

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
  mockManagedRuntimeViewVisibility.mockReset()
  mockGetManagedRuntimeSoul.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('closePaneWithCleanup — the acknowledged close gate (F2)', () => {
  it.each(managedCloseCases.flatMap((closeCase) => [
    { ...closeCase, identity: 'durable' },
    { ...closeCase, identity: 'legacy' },
  ]))('retains the panes and reports the actual close failure after a refused $name view update ($identity identity)', async ({ name, start, identity }) => {
    let store = createManagedTwoPaneStore()
    if (identity === 'legacy') {
      const state = structuredClone(store.getState())
      for (const { content } of collectPaneEntries(state.panes.layouts['tab-1'])) {
        delete (content as { createRequestId?: string }).createRequestId
      }
      store = createStore(state)
    }
    installManagedViewBackend()
    mockManagedRuntimeViewVisibility.mockRejectedValueOnce(new Error('managed view refusal'))

    const close = start(store)
    if (identity === 'durable') {
      expect(mockManagedRuntimeViewVisibility).not.toHaveBeenCalled()
      if (name === 'tab') ackPanesClosedBatches()
      else ackAllPaneCloses()
    }
    await close

    expect(store.getState().tabs.tabs.some((tab) => tab.id === 'tab-1')).toBe(true)
    expect(paneContents(store, 'tab-1').map(({ paneId, content }) => [paneId, content.kind])).toEqual([
      ['pane-1', 'terminal'],
      ['pane-2', 'terminal'],
    ])
    const failedPaneIds = name === 'tab' ? ['pane-1', 'pane-2'] : ['pane-2']
    expect(paneCloseErrors(store, 'tab-1')).toEqual(Object.fromEntries(
      failedPaneIds.map((paneId) => [paneId, 'The pane could not be closed, so it was left open. Try again.']),
    ))
    expect(store.getState().panes.closingTabs?.['tab-1']).toBeUndefined()
    expect(store.getState().panes.closingPanes?.['tab-1:pane-2']).toBeUndefined()
    expect(mockManagedRuntimeViewVisibility.mock.calls[0]?.[1]).toBe('detached')
    expect(sentCallsOf('pane.opened').map((message) => message.createRequestId)).toEqual(
      identity === 'legacy' ? [] : name === 'tab' ? ['req-a', 'req-b'] : ['req-b'],
    )
  })

  it('bounds unacknowledged visible repair attempts and records the unresolved outcome', async () => {
    vi.useFakeTimers()
    const store = createManagedTwoPaneStore()
    installManagedViewBackend()
    mockManagedRuntimeViewVisibility.mockRejectedValue(new TypeError('response lost'))
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const close = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
      ackAllPaneCloses()
      await vi.advanceTimersByTimeAsync(0)
      await close
      expect(mockGetManagedRuntimeSoul).toHaveBeenCalledTimes(2)
      expect(mockManagedRuntimeViewVisibility.mock.calls.filter(([, visibility]) => visibility === 'visible')).toHaveLength(2)
      expect(paneContents(store, 'tab-1')).toHaveLength(2)
      expect(errorLog.mock.calls.some((call) => call.some((arg) => (
        arg && typeof arg === 'object'
        && (arg as { event?: string }).event === 'managed_view_visibility_uncertain_outcome'
        && (arg as { phase?: string }).phase === 'retry'
      )))).toBe(true)
    } finally {
      errorLog.mockRestore()
    }
  })

  it.each(managedCloseCases.flatMap((closeCase) => ['repair first', 'detach first'].flatMap((ordering) => [
    { ...closeCase, ordering, failure: 'transport', error: new TypeError('Failed to fetch') },
    { ...closeCase, ordering, failure: 'response body', error: new SyntaxError('Invalid response JSON') },
  ])))('fences a delayed server detach after a visible read in a $name close ($failure, $ordering)', async ({ name, viewId, start, ordering, error }) => {
    vi.useFakeTimers()
    const store = createManagedTwoPaneStore()
    const backend = installManagedViewBackend()
    const failedViewId = name === 'tab' ? 'view-b' : viewId
    let commitOriginal!: () => Promise<ReturnType<typeof managedViewResult>>
    let originalCommit: Promise<ReturnType<typeof managedViewResult>> | undefined
    const reads: Array<{ visibility: string; revision: number }> = []
    mockGetManagedRuntimeSoul.mockImplementation(async (soulId: string) => {
      const current = backend.views.get(soulId.replace(/^soul-/, ''))!
      reads.push({ visibility: current.visibility, revision: current.revision })
      return managedSoulDetail(current.viewId, current.visibility, current.revision, current.soulIntentRevision)
    })
    mockManagedRuntimeViewVisibility.mockImplementation(async (id, visibility, revision, soulRevision) => {
      if (id === failedViewId && visibility === 'detached') {
        // The client loses its response while the server-side transaction is
        // still queued. It must validate the original fences when it commits.
        commitOriginal = () => originalCommit ??= backend.mutate(id, visibility, revision, soulRevision)
        throw error
      }
      if (id === failedViewId && visibility === 'visible' && ordering === 'detach first' && !originalCommit) {
        // The queued detach wins after GET returned visible but before the
        // repair PATCH checks that read's now-stale revision.
        await commitOriginal()
      }
      return backend.mutate(id, visibility, revision, soulRevision)
    })

    const close = start(store)
    ackAllPaneCloses()
    ackPanesClosedBatches()
    await vi.advanceTimersByTimeAsync(0)
    await close
    const originalOutcome = await commitOriginal().then(() => 'committed', () => 'stale')
    await vi.advanceTimersByTimeAsync(0)

    expect(reads[0]?.visibility).toBe('visible')
    expect(originalOutcome).toBe(ordering === 'repair first' ? 'stale' : 'committed')
    expect(paneContents(store, 'tab-1')).toHaveLength(2)
    expect(backend.views.get(failedViewId)?.visibility).toBe('visible')
    expect(backend.views.get('view-a')?.visibility).toBe('visible')
    const visibleCalls = mockManagedRuntimeViewVisibility.mock.calls.filter(([id, visibility]) => id === failedViewId && visibility === 'visible')
    expect(visibleCalls).toHaveLength(ordering === 'repair first' ? 1 : 2)
    expect(visibleCalls[0]?.[2]).toBe(reads[0].revision)
    if (ordering === 'detach first') {
      expect(reads[1]?.visibility).toBe('detached')
      expect(visibleCalls[1]?.[2]).toBe(reads[1].revision)
    }
  })

  it.each(managedCloseCases)('does not let an old timed-out detach resurrect a successfully retried $name close', async ({ viewId, start }) => {
    vi.useFakeTimers()
    const store = createManagedTwoPaneStore()
    const backend = installManagedViewBackend()
    const response = deferred<ReturnType<typeof managedViewResult>>()
    let originalResult!: ReturnType<typeof managedViewResult>
    let firstDetach = true
    mockManagedRuntimeViewVisibility.mockImplementation(async (id, visibility, revision, soulRevision) => {
      const result = await backend.mutate(id, visibility, revision, soulRevision)
      if (id === viewId && visibility === 'detached' && firstDetach) {
        firstDetach = false
        originalResult = result
        return response.promise
      }
      return result
    })

    const firstClose = start(store)
    ackAllPaneCloses()
    ackPanesClosedBatches()
    await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 50)
    await firstClose
    expect(backend.views.get(viewId)?.visibility).toBe('visible')
    projectManagedView(store, backend.views.get(viewId)!)

    const retry = start(store)
    ackAllPaneCloses()
    ackPanesClosedBatches()
    await vi.advanceTimersByTimeAsync(0)
    await retry
    expect(paneContents(store, 'tab-1').some(({ content }) => (content as { viewIntentId?: string }).viewIntentId === viewId)).toBe(false)
    const callsBeforeLateResponse = mockManagedRuntimeViewVisibility.mock.calls.length
    response.resolve(originalResult)
    await vi.advanceTimersByTimeAsync(0)

    expect(mockManagedRuntimeViewVisibility.mock.calls).toHaveLength(callsBeforeLateResponse)
    expect(backend.views.get(viewId)?.visibility).toBe('detached')
  })

  it.each(managedCloseCases)('does not PATCH from an older authoritative read after a newer $name close succeeds', async ({ viewId, start }) => {
    vi.useFakeTimers()
    const store = createManagedTwoPaneStore()
    const backend = installManagedViewBackend()
    const response = deferred<ReturnType<typeof managedViewResult>>()
    const read = deferred<ReturnType<typeof managedSoulDetail>>()
    let originalResult!: ReturnType<typeof managedViewResult>
    let firstDetach = true
    mockManagedRuntimeViewVisibility.mockImplementation(async (id, visibility, revision, soulRevision) => {
      const result = await backend.mutate(id, visibility, revision, soulRevision)
      if (id === viewId && visibility === 'detached' && firstDetach) {
        firstDetach = false
        originalResult = result
        return response.promise
      }
      return result
    })
    mockGetManagedRuntimeSoul.mockReturnValueOnce(read.promise)

    const firstClose = start(store)
    ackAllPaneCloses()
    ackPanesClosedBatches()
    await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 50)
    await firstClose
    expect(mockGetManagedRuntimeSoul).toHaveBeenCalledTimes(1)
    projectManagedView(store, backend.views.get(viewId)!)
    const retry = start(store)
    ackAllPaneCloses()
    ackPanesClosedBatches()
    await vi.advanceTimersByTimeAsync(0)
    await retry
    const callsBeforeRead = mockManagedRuntimeViewVisibility.mock.calls.length
    const current = backend.views.get(viewId)!
    read.resolve(managedSoulDetail(viewId, current.visibility, current.revision, current.soulIntentRevision))
    await vi.advanceTimersByTimeAsync(0)
    response.resolve(originalResult)
    await vi.advanceTimersByTimeAsync(0)

    expect(mockManagedRuntimeViewVisibility.mock.calls).toHaveLength(callsBeforeRead)
    expect(backend.views.get(viewId)?.visibility).toBe('detached')
  })

  it.each(managedCloseCases.flatMap((closeCase) => [
    { ...closeCase, legacy: false },
    ...(closeCase.name === 'tab' ? [] : [{ ...closeCase, legacy: true }]),
  ]))('keeps an older repair read inert while a newer $name close is still pending (legacy=$legacy)', async ({ viewId, start, legacy }) => {
    vi.useFakeTimers()
    const store = createManagedTwoPaneStore(legacy ? viewId : undefined)
    const backend = installManagedViewBackend()
    const originalResponse = deferred<ReturnType<typeof managedViewResult>>()
    const retryResponse = deferred<ReturnType<typeof managedViewResult>>()
    const read = deferred<ReturnType<typeof managedSoulDetail>>()
    let originalResult!: ReturnType<typeof managedViewResult>
    let detachCount = 0
    mockManagedRuntimeViewVisibility.mockImplementation(async (id, visibility, revision, soulRevision) => {
      if (legacy && id === viewId && visibility === 'detached' && detachCount === 1) {
        detachCount++
        // Keep the stale-fence legacy retry pending until its response; its
        // absent create identity means Redux supplies no pending close flag.
        await retryResponse.promise
        return backend.mutate(id, visibility, revision, soulRevision)
      }
      const result = await backend.mutate(id, visibility, revision, soulRevision)
      if (id === viewId && visibility === 'detached') {
        if (++detachCount === 1) {
          originalResult = result
          return originalResponse.promise
        }
        return retryResponse.promise
      }
      return result
    })
    mockGetManagedRuntimeSoul.mockReturnValueOnce(read.promise)
    const firstClose = start(store)
    ackAllPaneCloses()
    ackPanesClosedBatches()
    await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 50)
    await firstClose
    if (!legacy) projectManagedView(store, backend.views.get(viewId)!)

    const retry = start(store)
    ackAllPaneCloses()
    ackPanesClosedBatches()
    await vi.advanceTimersByTimeAsync(0)
    const callsBeforeRead = mockManagedRuntimeViewVisibility.mock.calls.length
    const current = backend.views.get(viewId)!
    read.resolve(managedSoulDetail(viewId, current.visibility, current.revision, current.soulIntentRevision))
    originalResponse.resolve(originalResult)
    await vi.advanceTimersByTimeAsync(0)
    expect(mockManagedRuntimeViewVisibility.mock.calls).toHaveLength(callsBeforeRead)
    expect(backend.views.get(viewId)?.visibility).toBe('detached')
    retryResponse.resolve(current)
    await vi.advanceTimersByTimeAsync(0)
    await retry
    expect(paneContents(store, 'tab-1').some(({ content }) => (content as { viewIntentId?: string }).viewIntentId === viewId)).toBe(legacy)
    expect(backend.views.get(viewId)?.visibility).toBe(legacy ? 'visible' : 'detached')
  })

  it.each(managedCloseCases)('retains an older repair when a newer $name close fails before its visibility transaction', async ({ viewId, start }) => {
    vi.useFakeTimers()
    const store = createManagedTwoPaneStore()
    const backend = installManagedViewBackend()
    const originalResponse = deferred<ReturnType<typeof managedViewResult>>()
    const originalRead = deferred<ReturnType<typeof managedSoulDetail>>()
    let originalResult!: ReturnType<typeof managedViewResult>
    mockManagedRuntimeViewVisibility.mockImplementation(async (id, visibility, revision, soulRevision) => {
      const result = await backend.mutate(id, visibility, revision, soulRevision)
      if (id === viewId && visibility === 'detached') {
        originalResult = result
        return originalResponse.promise
      }
      return result
    })
    mockGetManagedRuntimeSoul.mockReturnValueOnce(originalRead.promise)
    const firstClose = start(store)
    ackAllPaneCloses()
    ackPanesClosedBatches()
    await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 50)
    await firstClose
    expect(backend.views.get(viewId)?.visibility).toBe('detached')

    const retry = start(store)
    // The original response arrives while the newer close waits for evidence,
    // which subsequently refuses; no new visibility transaction ever starts.
    originalResponse.resolve(originalResult)
    const current = backend.views.get(viewId)!
    originalRead.resolve(managedSoulDetail(viewId, current.visibility, current.revision, current.soulIntentRevision))
    await vi.advanceTimersByTimeAsync(0)
    ackAllPaneCloses({ success: false })
    ackPanesClosedBatches({ success: false })
    await retry
    expect(paneContents(store, 'tab-1')).toHaveLength(2)
    expect(backend.views.get(viewId)?.visibility).toBe('visible')
  })

  it.each(managedCloseCases.flatMap((closeCase) => [
    { ...closeCase, failure: 'transport', error: new TypeError('Failed to fetch') },
    { ...closeCase, failure: 'response body', error: new SyntaxError('Invalid response JSON') },
  ]))('repairs a committed detach after $failure failure in a $name close with authoritative fences', async ({ name, viewId, start, error }) => {
    vi.useFakeTimers()
    const store = createManagedTwoPaneStore()
    const backend = installManagedViewBackend()
    // A tab close exercises rollback of its first view and repair of the
    // ambiguous failing view in the same transaction.
    const failedViewId = name === 'tab' ? 'view-b' : viewId
    let committed!: ReturnType<typeof managedViewResult>
    mockManagedRuntimeViewVisibility.mockImplementation(async (id, visibility, revision, soulRevision) => {
      const result = await backend.mutate(id, visibility, revision, soulRevision)
      if (id === failedViewId && visibility === 'detached') {
        committed = result
        throw error
      }
      return result
    })

    const close = start(store)
    ackAllPaneCloses()
    ackPanesClosedBatches()
    await vi.advanceTimersByTimeAsync(0)
    await close

    expect(paneContents(store, 'tab-1')).toHaveLength(2)
    expect(backend.views.get(failedViewId)?.visibility).toBe('visible')
    expect(backend.views.get('view-a')?.visibility).toBe('visible')
    expect(mockGetManagedRuntimeSoul).toHaveBeenCalledWith(`soul-${failedViewId}`, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(mockManagedRuntimeViewVisibility.mock.calls.some((call) => (
      call[0] === failedViewId && call[1] === 'visible' && call[2] === committed.revision && call[3] === committed.soulIntentRevision
    ))).toBe(true)
  })

  it('detaches a managed pane after close evidence and before removing its layout', async () => {
    const store = createStore()
    store.dispatch(addTab({ id: 'tab-1', mode: 'shell' }))
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: terminalContent('req-a', 'term-a'),
    }))
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'vertical',
      newContent: managedTerminalContent('req-b', 'term-b', 'view-b', 4, 9),
      newPaneId: 'pane-2',
    }))
    mockSend.mockClear()
    mockManagedRuntimeViewVisibility.mockResolvedValue(
      managedViewResult('view-b', 'detached', 5, 10),
    )

    const close = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    ackAllPaneCloses()
    await close

    expectManagedVisibilityCall(1, ['view-b', 'detached', 4, 9])
    expect(paneContents(store, 'tab-1').map((pane) => pane.paneId)).toEqual(['pane-1'])
  })

  it('keeps the tab open, reasserts panes, and rolls back earlier managed detaches when one refuses', async () => {
    mockGetManagedRuntimeSoul.mockResolvedValue(managedSoulDetail('view-b', 'visible', 3, 8))
    const store = createStore()
    store.dispatch(addTab({ id: 'tab-1', mode: 'shell' }))
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: managedTerminalContent('req-a', 'term-a', 'view-a', 2, 7),
    }))
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'vertical',
      newContent: managedTerminalContent('req-b', 'term-b', 'view-b', 3, 8),
      newPaneId: 'pane-2',
    }))
    mockSend.mockClear()
    mockManagedRuntimeViewVisibility
      .mockImplementation(async (viewId, visibility, revision, soulRevision) => managedViewResult(viewId, visibility, revision + 1, soulRevision))
      .mockResolvedValueOnce(managedViewResult('view-a', 'detached', 4, 9))
      .mockRejectedValueOnce(new Error('managed view refusal'))

    const close = store.dispatch(closeTab('tab-1'))
    ackPanesClosedBatches()
    await close

    expect(store.getState().tabs.tabs.some((tab) => tab.id === 'tab-1')).toBe(true)
    expect(paneContents(store, 'tab-1').map((pane) => pane.paneId)).toEqual(['pane-1', 'pane-2'])
    expectManagedVisibilityCall(1, ['view-a', 'detached', 2, 7])
    expectManagedVisibilityCall(2, ['view-b', 'detached', 3, 8])
    expectManagedVisibilityCall(3, ['view-b', 'visible', 3, 8])
    expectManagedVisibilityCall(4, ['view-a', 'visible', 4, 9])
    expect(sentCallsOf('pane.opened')).toEqual([
      expect.objectContaining({ createRequestId: 'req-a', tabId: 'tab-1' }),
      expect.objectContaining({ createRequestId: 'req-b', tabId: 'tab-1' }),
    ])
    expect(paneCloseErrors(store, 'tab-1')).toEqual({
      'pane-1': 'The pane could not be closed, so it was left open. Try again.',
      'pane-2': 'The pane could not be closed, so it was left open. Try again.',
    })
  })

  it('a managed detach timeout settles a pane close, clears its close mark, keeps the pane, and reasserts it open', async () => {
    vi.useFakeTimers()
    const store = createManagedTwoPaneStore()
    mockManagedRuntimeViewVisibility.mockReturnValue(new Promise(() => {}))

    const close = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    ackAllPaneCloses()
    await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 50)
    let settled = false
    void close.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
    await close

    expect(paneContents(store, 'tab-1').map((pane) => pane.paneId)).toEqual(['pane-1', 'pane-2'])
    expect(paneCloseErrors(store, 'tab-1')).toEqual({
      'pane-2': 'The pane could not be closed, so it was left open. Try again.',
    })
    expect(store.getState().panes.closingPanes?.['tab-1:pane-2']).toBeUndefined()
    expect(sentCallsOf('pane.opened')).toEqual([
      expect.objectContaining({ createRequestId: 'req-b', tabId: 'tab-1' }),
    ])
  })

  it('a managed detach timeout settles a whole-tab close, clears its close mark, keeps the tab, and reasserts every pane', async () => {
    vi.useFakeTimers()
    const store = createManagedTwoPaneStore()
    mockManagedRuntimeViewVisibility.mockReturnValue(new Promise(() => {}))

    const close = store.dispatch(closeTab('tab-1'))
    ackPanesClosedBatches()
    await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 50)
    let settled = false
    void close.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
    await close

    expect(store.getState().tabs.tabs.some((tab) => tab.id === 'tab-1')).toBe(true)
    expect(paneContents(store, 'tab-1').map((pane) => pane.paneId)).toEqual(['pane-1', 'pane-2'])
    expect(store.getState().panes.closingTabs?.['tab-1']).toBeUndefined()
    expect(paneCloseErrors(store, 'tab-1')).toEqual({
      'pane-1': 'The pane could not be closed, so it was left open. Try again.',
      'pane-2': 'The pane could not be closed, so it was left open. Try again.',
    })
    expect(sentCallsOf('pane.opened')).toEqual([
      expect.objectContaining({ createRequestId: 'req-a', tabId: 'tab-1' }),
      expect.objectContaining({ createRequestId: 'req-b', tabId: 'tab-1' }),
    ])
  })

  it('a later managed detach timeout rolls back earlier success with its returned fences before refusing the tab close', async () => {
    vi.useFakeTimers()
    const store = createManagedTwoPaneStore()
    mockManagedRuntimeViewVisibility.mockImplementation((
      viewId: string,
      visibility: 'visible' | 'detached',
    ) => {
      if (viewId === 'view-a' && visibility === 'detached') {
        return Promise.resolve(managedViewResult('view-a', 'detached', 4, 9))
      }
      if (viewId === 'view-a' && visibility === 'visible') {
        return Promise.resolve(managedViewResult('view-a', 'visible', 5, 10))
      }
      return new Promise(() => {})
    })

    const close = store.dispatch(closeTab('tab-1'))
    ackPanesClosedBatches()
    await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 50)
    await close

    expectManagedVisibilityCall(1, ['view-a', 'detached', 2, 7])
    expectManagedVisibilityCall(2, ['view-b', 'detached', 3, 8])
    expect(mockManagedRuntimeViewVisibility.mock.calls.find(([viewId, visibility]) => (
      viewId === 'view-a' && visibility === 'visible'
    ))?.slice(0, 4)).toEqual(['view-a', 'visible', 4, 9])
    expect(store.getState().tabs.tabs.some((tab) => tab.id === 'tab-1')).toBe(true)
    expect(paneContents(store, 'tab-1').map((pane) => pane.paneId)).toEqual(['pane-1', 'pane-2'])
  })

  it.each(managedCloseCases)('repairs a late managed detach outcome for a $name close after the local timeout', async ({
    viewId,
    viewRevision,
    soulRevision,
    start,
  }) => {
    vi.useFakeTimers()
    const store = createManagedTwoPaneStore()
    let resolveDetach: (view: ReturnType<typeof managedViewResult>) => void = () => {}
    const lateDetach = new Promise<ReturnType<typeof managedViewResult>>((resolve) => {
      resolveDetach = resolve
    })
    mockManagedRuntimeViewVisibility.mockImplementation((
      requestedViewId: string,
      visibility: 'visible' | 'detached',
    ) => {
      if (visibility === 'detached') return lateDetach
      return Promise.resolve(managedViewResult(requestedViewId, 'visible', viewRevision + 1, soulRevision + 1))
    })

    const close = start(store)
    ackAllPaneCloses()
    ackPanesClosedBatches()
    await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 50)
    await close

    const originalDetachCall = mockManagedRuntimeViewVisibility.mock.calls.find(([, visibility]) => visibility === 'detached')
    expect(originalDetachCall?.[5]).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }))
    // The close gate times out locally, but the original mutation stays
    // observable so a supervisor commit after the stale repair read can still
    // deliver its returned fences to reconciliation.
    expect((originalDetachCall?.[5] as { signal: AbortSignal }).signal.aborted).toBe(false)
    const firstVisibleCall = mockManagedRuntimeViewVisibility.mock.calls.find(([, visibility]) => visibility === 'visible')
    expect(firstVisibleCall?.slice(0, 4)).toEqual([viewId, 'visible', viewRevision, soulRevision])
    expect(firstVisibleCall?.[5]).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect((firstVisibleCall?.[5] as { signal: AbortSignal }).signal.aborted).toBe(false)

    resolveDetach(managedViewResult(viewId, 'detached', viewRevision + 1, soulRevision + 1))
    await vi.advanceTimersByTimeAsync(0)
    expect(mockManagedRuntimeViewVisibility.mock.calls.filter(([, visibility]) => visibility === 'visible')).toHaveLength(2)
  })

  it.each(managedCloseCases)('keeps watching a timed out $name detach after a stale visible read until its original response arrives', async ({
    viewId,
    viewRevision,
    soulRevision,
    start,
  }) => {
    vi.useFakeTimers()
    const store = createManagedTwoPaneStore()
    const backend = installManagedViewBackend()
    const lateDetach = deferred<ReturnType<typeof managedViewResult>>()
    let originalResult!: ReturnType<typeof managedViewResult>
    const authoritativeSnapshots: Array<{ visibility: string; revision: number; soulIntentRevision: number }> = []
    mockManagedRuntimeViewVisibility.mockImplementation(async (
      requestedViewId: string,
      visibility: 'visible' | 'detached',
      revision: number,
      soulIntentRevision: number,
    ) => {
      const result = await backend.mutate(requestedViewId, visibility, revision, soulIntentRevision)
      if (requestedViewId === viewId && visibility === 'detached') {
        originalResult = result
        return lateDetach.promise
      }
      return result
    })
    mockGetManagedRuntimeSoul.mockImplementation(async (soulId: string) => {
      const currentViewId = soulId.replace(/^soul-/, '')
      // Only the first snapshot predates the committed detach; every retry
      // reads the actual state, and every PATCH validates its revision.
      const current = authoritativeSnapshots.length === 0
        ? managedViewResult(viewId, 'visible', viewRevision, soulRevision)
        : backend.views.get(currentViewId)!
      authoritativeSnapshots.push({
        visibility: current.visibility,
        revision: current.revision,
        soulIntentRevision: current.soulIntentRevision,
      })
      return managedSoulDetail(
        currentViewId,
        current.visibility,
        current.revision,
        current.soulIntentRevision,
      )
    })

    const close = start(store)
    ackAllPaneCloses()
    ackPanesClosedBatches()
    await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 50)
    await close

    expect(mockGetManagedRuntimeSoul).toHaveBeenCalledWith(
      `soul-${viewId}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(authoritativeSnapshots).toEqual([
      { visibility: 'visible', revision: viewRevision, soulIntentRevision: soulRevision },
      { visibility: 'detached', revision: viewRevision + 1, soulIntentRevision: soulRevision },
    ])
    const initialVisibleCall = mockManagedRuntimeViewVisibility.mock.calls.find(([
      requestedViewId,
      visibility,
    ]) => requestedViewId === viewId && visibility === 'visible')
    expect(initialVisibleCall?.slice(0, 4)).toEqual([viewId, 'visible', viewRevision, soulRevision])
    expect((initialVisibleCall?.[5] as { signal: AbortSignal }).signal.aborted).toBe(false)

    expect(backend.views.get(viewId)?.visibility).toBe('visible')
    lateDetach.resolve(originalResult)
    await vi.advanceTimersByTimeAsync(0)

    expect(mockManagedRuntimeViewVisibility.mock.calls.filter(([requestedViewId, visibility]) => (
      requestedViewId === viewId && visibility === 'visible'
    )).map((call) => call.slice(0, 4))).toEqual([
      [viewId, 'visible', viewRevision, soulRevision],
      [viewId, 'visible', viewRevision, soulRevision],
      [viewId, 'visible', viewRevision + 1, soulRevision],
      [viewId, 'visible', viewRevision + 1, soulRevision],
      [viewId, 'visible', viewRevision + 2, soulRevision],
    ])
    expect(backend.views.get(viewId)?.visibility).toBe('visible')
    expect(backend.views.get(viewId)?.revision).toBe(viewRevision + 3)
  })

  it.each(managedCloseCases)('uses authoritative fences after a stale visible repair for a $name close', async ({
    viewId,
    viewRevision,
    soulRevision,
    start,
  }) => {
    vi.useFakeTimers()
    const store = createManagedTwoPaneStore()
    let resolveDetach: (view: ReturnType<typeof managedViewResult>) => void = () => {}
    const lateDetach = new Promise<ReturnType<typeof managedViewResult>>((resolve) => {
      resolveDetach = resolve
    })
    let visibleAttempts = 0
    mockManagedRuntimeViewVisibility.mockImplementation((
      requestedViewId: string,
      visibility: 'visible' | 'detached',
    ) => {
      if (visibility === 'detached') return lateDetach
      visibleAttempts += 1
      if (visibleAttempts === 1) return Promise.reject(new Error('stale managed view revision'))
      return Promise.resolve(managedViewResult(requestedViewId, 'visible', 41, 52))
    })
    mockGetManagedRuntimeSoul.mockResolvedValue(
      managedSoulDetail(viewId, 'detached', 40, 52),
    )

    const close = start(store)
    ackAllPaneCloses()
    ackPanesClosedBatches()
    await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 50)
    await close
    resolveDetach(managedViewResult(viewId, 'detached', viewRevision + 1, soulRevision + 1))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)

    expect(mockGetManagedRuntimeSoul).toHaveBeenCalledWith(
      `soul-${viewId}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    const visibleCalls = mockManagedRuntimeViewVisibility.mock.calls.filter(([, visibility]) => visibility === 'visible')
    expect(visibleCalls[1]?.slice(0, 4)).toEqual([viewId, 'visible', 40, 52])
  })

  it('records a structured uncertainty when a late detach rejects and authoritative reconciliation fails', async () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = createManagedTwoPaneStore()
    let rejectDetach: (error: Error) => void = () => {}
    const lateDetach = new Promise<ReturnType<typeof managedViewResult>>((_, reject) => {
      rejectDetach = reject
    })
    mockManagedRuntimeViewVisibility.mockImplementation((
      viewId: string,
      visibility: 'visible' | 'detached',
    ) => {
      if (viewId === 'view-b' && visibility === 'detached') return lateDetach
      return Promise.reject(new Error('visible repair unavailable'))
    })
    mockGetManagedRuntimeSoul.mockRejectedValue(new Error('authoritative read unavailable'))

    const close = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    ackAllPaneCloses()
    await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 50)
    await close

    rejectDetach(new Error('detach response lost'))
    await vi.advanceTimersByTimeAsync(0)

    expect(errorSpy.mock.calls.some((args) => args.some((arg) => (
      typeof arg === 'object'
      && arg !== null
      && (arg as { event?: unknown }).event === 'managed_view_visibility_uncertain_outcome'
    )))).toBe(true)
    errorSpy.mockRestore()
  })

  it('repairs a rollback visibility PATCH that resolves after its local timeout', async () => {
    vi.useFakeTimers()
    const store = createManagedTwoPaneStore()
    let resolveSecondDetach: (view: ReturnType<typeof managedViewResult>) => void = () => {}
    const secondDetach = new Promise<ReturnType<typeof managedViewResult>>((resolve) => {
      resolveSecondDetach = resolve
    })
    let resolveRollback: (view: ReturnType<typeof managedViewResult>) => void = () => {}
    const lateRollback = new Promise<ReturnType<typeof managedViewResult>>((resolve) => {
      resolveRollback = resolve
    })
    let rollbackVisibleAttempts = 0
    mockManagedRuntimeViewVisibility.mockImplementation((
      viewId: string,
      visibility: 'visible' | 'detached',
    ) => {
      if (viewId === 'view-a' && visibility === 'detached') {
        return Promise.resolve(managedViewResult('view-a', 'detached', 4, 9))
      }
      if (viewId === 'view-b' && visibility === 'detached') return secondDetach
      if (viewId === 'view-a' && visibility === 'visible') {
        rollbackVisibleAttempts += 1
        return rollbackVisibleAttempts === 1
          ? lateRollback
          : Promise.resolve(managedViewResult('view-a', 'visible', 5, 10))
      }
      return Promise.resolve(managedViewResult(viewId, 'visible', 5, 10))
    })

    const close = store.dispatch(closeTab('tab-1'))
    ackPanesClosedBatches()
    await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 50)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 50)
    await close

    expect(mockManagedRuntimeViewVisibility.mock.calls.filter(([, visibility]) => visibility === 'visible')).toHaveLength(3)
    resolveSecondDetach(managedViewResult('view-b', 'detached', 4, 9))
    resolveRollback(managedViewResult('view-a', 'visible', 5, 10))
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getState().tabs.tabs.some((tab) => tab.id === 'tab-1')).toBe(true)
    expect(paneContents(store, 'tab-1').map((pane) => pane.paneId)).toEqual(['pane-1', 'pane-2'])
  })

  it('keeps watching a timed out rollback after a stale repair read and repairs its late visible commit', async () => {
    vi.useFakeTimers()
    const store = createManagedTwoPaneStore()
    const durableViews = new Map([
      ['view-a', managedViewResult('view-a', 'visible', 2, 7)],
      ['view-b', managedViewResult('view-b', 'visible', 3, 8)],
    ])
    let resolveSecondDetach: (view: ReturnType<typeof managedViewResult>) => void = () => {}
    const secondDetach = new Promise<ReturnType<typeof managedViewResult>>((resolve) => {
      resolveSecondDetach = resolve
    })
    let resolveRollback: (view: ReturnType<typeof managedViewResult>) => void = () => {}
    const lateRollback = new Promise<ReturnType<typeof managedViewResult>>((resolve) => {
      resolveRollback = resolve
    })
    let rollbackVisibleAttempts = 0
    const authoritativeSnapshots: Array<{ visibility: string; revision: number; soulIntentRevision: number }> = []
    mockManagedRuntimeViewVisibility.mockImplementation((
      viewId: string,
      visibility: 'visible' | 'detached',
    ) => {
      if (viewId === 'view-a' && visibility === 'detached') {
        const detached = managedViewResult('view-a', 'detached', 4, 9)
        durableViews.set(viewId, detached)
        return Promise.resolve(detached)
      }
      if (viewId === 'view-b' && visibility === 'detached') return secondDetach
      if (viewId === 'view-a' && visibility === 'visible') {
        rollbackVisibleAttempts += 1
        if (rollbackVisibleAttempts === 1) return lateRollback
        if (rollbackVisibleAttempts === 2) return Promise.reject(new Error('stale rollback fence'))
        const repaired = managedViewResult('view-a', 'visible', 6, 11)
        durableViews.set(viewId, repaired)
        return Promise.resolve(repaired)
      }
      const current = durableViews.get(viewId) ?? managedViewResult(viewId, visibility, 1, 1)
      const next = managedViewResult(viewId, visibility, current.revision + 1, current.soulIntentRevision + 1)
      durableViews.set(viewId, next)
      return Promise.resolve(next)
    })
    mockGetManagedRuntimeSoul.mockImplementation(async (soulId: string) => {
      const viewId = soulId.replace(/^soul-/, '')
      const current = durableViews.get(viewId)!
      authoritativeSnapshots.push({
        visibility: current.visibility,
        revision: current.revision,
        soulIntentRevision: current.soulIntentRevision,
      })
      return managedSoulDetail(viewId, current.visibility, current.revision, current.soulIntentRevision)
    })

    const close = store.dispatch(closeTab('tab-1'))
    ackPanesClosedBatches()
    await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 50)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 50)
    await close

    expect(mockGetManagedRuntimeSoul).toHaveBeenCalledWith(
      'soul-view-a',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(authoritativeSnapshots).toEqual([{
      visibility: 'detached',
      revision: 4,
      soulIntentRevision: 9,
    }])
    const firstRollbackCall = mockManagedRuntimeViewVisibility.mock.calls.find(([
      viewId,
      visibility,
    ]) => viewId === 'view-a' && visibility === 'visible')
    expect(firstRollbackCall?.slice(0, 4)).toEqual(['view-a', 'visible', 4, 9])
    expect((firstRollbackCall?.[5] as { signal: AbortSignal }).signal.aborted).toBe(false)

    const lateVisible = managedViewResult('view-a', 'visible', 5, 10)
    durableViews.set('view-a', lateVisible)
    resolveRollback(lateVisible)
    await vi.advanceTimersByTimeAsync(0)

    const rollbackVisibleCalls = mockManagedRuntimeViewVisibility.mock.calls
      .filter(([viewId, visibility]) => viewId === 'view-a' && visibility === 'visible')
      .map((call) => call.slice(0, 4))
    expect(rollbackVisibleCalls).toEqual([
      ['view-a', 'visible', 4, 9],
      ['view-a', 'visible', 4, 9],
      ['view-a', 'visible', 4, 9],
      ['view-a', 'visible', 5, 10],
    ])
    expect(durableViews.get('view-a')?.visibility).toBe('visible')

    resolveSecondDetach(managedViewResult('view-b', 'detached', 4, 9))
    await vi.advanceTimersByTimeAsync(0)
  })

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

  it('managed success orders close evidence before visibility and replaces only after the visibility PATCH resolves', async () => {
    const store = createManagedTwoPaneStore()
    const order: string[] = []
    let sawReplacement = false
    const unsubscribe = store.subscribe(() => {
      if (sawReplacement) return
      if (paneContents(store, 'tab-1').find((pane) => pane.paneId === 'pane-2')?.content.kind === 'picker') {
        sawReplacement = true
        order.push('replace')
      }
    })
    mockSend.mockImplementation((message: unknown) => {
      if ((message as { type?: string }).type === 'pane.closed') order.push('close-evidence')
    })
    let resolveDetach: (view: ReturnType<typeof managedViewResult>) => void = () => {}
    const detach = new Promise<ReturnType<typeof managedViewResult>>((resolve) => {
      resolveDetach = resolve
    })
    mockManagedRuntimeViewVisibility.mockImplementation(async () => {
      order.push('visibility-start')
      const view = await detach
      order.push('visibility-resolved')
      return view
    })

    const replace = store.dispatch(replacePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    expect(order).toEqual(['close-evidence'])
    expect(paneContents(store, 'tab-1').find((pane) => pane.paneId === 'pane-2')?.content.kind).toBe('terminal')

    ackAllPaneCloses()
    await vi.waitFor(() => expect(order).toEqual(['close-evidence', 'visibility-start']))
    expect(paneContents(store, 'tab-1').find((pane) => pane.paneId === 'pane-2')?.content.kind).toBe('terminal')

    resolveDetach(managedViewResult('view-b', 'detached', 4, 9))
    await replace
    unsubscribe()

    expect(order).toEqual(['close-evidence', 'visibility-start', 'visibility-resolved', 'replace'])
    expect(paneContents(store, 'tab-1').find((pane) => pane.paneId === 'pane-2')?.content.kind).toBe('picker')
  })

  it('managed refusal keeps the original content, surfaces the close failure, and reasserts open', async () => {
    mockGetManagedRuntimeSoul.mockResolvedValue(managedSoulDetail('view-b', 'visible', 3, 8))
    const store = createManagedTwoPaneStore()
    mockManagedRuntimeViewVisibility
      .mockImplementation(async (viewId, visibility, revision, soulRevision) => managedViewResult(viewId, visibility, revision + 1, soulRevision))
      .mockRejectedValueOnce(new Error('managed view refusal'))

    const replace = store.dispatch(replacePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    ackAllPaneCloses()
    await replace

    const entry = paneContents(store, 'tab-1').find((pane) => pane.paneId === 'pane-2')
    expect(entry?.content.kind).toBe('terminal')
    expect((entry?.content as { closeError?: string }).closeError).toBe(
      'The pane could not be closed, so it was left open. Try again.',
    )
    expect(store.getState().panes.closingPanes?.['tab-1:pane-2']).toBeUndefined()
    expect(sentCallsOf('pane.opened')).toEqual([
      expect.objectContaining({ createRequestId: 'req-b', tabId: 'tab-1' }),
    ])
  })

  it('managed detach timeout settles replace without installing a picker', async () => {
    vi.useFakeTimers()
    const store = createManagedTwoPaneStore()
    mockManagedRuntimeViewVisibility.mockReturnValue(new Promise(() => {}))

    const replace = store.dispatch(replacePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    ackAllPaneCloses()
    await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 50)
    let settled = false
    void replace.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
    await replace

    const entry = paneContents(store, 'tab-1').find((pane) => pane.paneId === 'pane-2')
    expect(entry?.content.kind).toBe('terminal')
    expect((entry?.content as { closeError?: string }).closeError).toBe(
      'The pane could not be closed, so it was left open. Try again.',
    )
    expect(store.getState().panes.closingPanes?.['tab-1:pane-2']).toBeUndefined()
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
 *    tab is outstanding (its own — the round-4 no-op — or any pane's).
 *
 * Delta-round-9 (review fresheyes/usual-fresheyes-20260905T014750Z-2491856.md,
 * the single Major) STRENGTHENED the pane-scope half: the different-pane
 * overlap this describe used to pin as allowed produced the round-9 finding
 * verbatim — two acknowledged closes on a two-pane tab collapsed the split
 * with the first removal, the second removal was refused by the last-leaf
 * rule, and the survivor stayed displayed under a durable close record (the
 * ack SUCCEEDED, so no heal fired) — recovery omitted a genuinely open pane.
 * Pane-scope starts now reject while ANY close touching the tab is
 * outstanding (`hasAnyClosePending`): ONE close op per tab, full stop; the
 * retargeted pin is below, and the surviving-pane compensation is pinned in
 * the removal-refusal describe at the file's end.
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

  it('an overlapping close of a DIFFERENT pane in the same tab is REFUSED (delta-round-9: one close op per tab, any scope) — and the refusal never latches a later close', async () => {
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
    // The in-flight close is the tab's ONLY close op: pane-3's never left.
    expect(sentCallsOf('pane.closed').filter((m) => m.createRequestId === 'req-b')).toHaveLength(1)
    expect(sentCallsOf('pane.closed').filter((m) => m.createRequestId === 'req-c')).toEqual([])
    ackAllPaneCloses()
    await Promise.all([closeB, closeC])
    // One survivor by construction — but the un-closed pane-3 stays too.
    expect(paneContents(store, 'tab-1').map((p) => p.paneId).sort()).toEqual(['pane-1', 'pane-3'])
    // No latch: once the first close settled, pane-3's close starts and
    // completes normally.
    const retry = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-3' }))
    expect(sentCallsOf('pane.closed').filter((m) => m.createRequestId === 'req-c')).toHaveLength(1)
    ackAllPaneCloses()
    await retry
    expect(paneContents(store, 'tab-1').map((p) => p.paneId)).toEqual(['pane-1'])
  })

  it('a replace of a DIFFERENT pane while a close is pending is REJECTED (the close-op serialization is per TAB, not per pane)', async () => {
    const store = createTwoPaneStore()
    const first = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    const rejected = store.dispatch(replacePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-1' }))
    // Exactly ONE pane.closed ever left — the pending close's own.
    expect(sentCallsOf('pane.closed')).toEqual([
      expect.objectContaining({ type: 'pane.closed', createRequestId: 'req-b' }),
    ])
    ackAllPaneCloses()
    await Promise.all([first, rejected])
    // The close completed; the rejected replace moved nothing.
    expect(paneContents(store, 'tab-1').map((p) => p.paneId)).toEqual(['pane-1'])
    expect(paneContents(store, 'tab-1')[0]?.content.kind).toBe('terminal')
  })

  it('a close of a DIFFERENT pane while a replace is pending is REJECTED (same per-TAB rule, the other direction)', async () => {
    const store = createTwoPaneStore()
    const first = store.dispatch(replacePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    const rejected = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-1' }))
    expect(sentCallsOf('pane.closed')).toEqual([
      expect.objectContaining({ type: 'pane.closed', createRequestId: 'req-b' }),
    ])
    ackAllPaneCloses()
    await Promise.all([first, rejected])
    // The replace completed; the rejected close moved nothing.
    expect(paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-2')?.content.kind).toBe('picker')
    expect(paneContents(store, 'tab-1').find((p) => p.paneId === 'pane-1')?.content.kind).toBe('terminal')
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

/**
 * Delta-round-9 (review fresheyes/usual-fresheyes-20260905T014750Z-2491856.md,
 * the single Major), second half — the removal-refusal compensation. The
 * finding's interleave: two acknowledged closes target both panes of a
 * two-pane tab; the first removal collapses the split to ONE leaf; the second
 * close's post-ack `closePane` is REFUSED by the last-leaf rule. The survivor
 * stays displayed AND running but carries a durable acknowledged close
 * record, and no heal fires — the ack SUCCEEDED, so the failure/timeout
 * re-assertion path never ran. Recovery then omitted a genuinely open pane.
 * The per-tab close serialization (the describe above) makes the interleave
 * unreachable among the three gated thunks; the compensation below is the
 * defense-in-depth for EVERY other way the layout can refuse the removal of
 * an acked pane (the pins drive the collapse through the direct reducer —
 * the committed-close shape — because the refusal is the layout's, however
 * it came to hold a single leaf).
 *
 * The rule: the ack succeeded but the pane is STILL DISPLAYED after the
 * removal dispatch ⇒ the close op treats it as failure for durable purposes
 * — the pane.opened re-assertion goes out (the fenced consume ⇒ the survivor
 * is restorable again) and the normal error chrome surfaces.
 */
describe('delta-round-9 — the removal-refusal compensation', () => {
  it('the acked close whose removal the last-leaf rule refused re-asserts open and wears the error chrome (the survivor carries NO standing close evidence)', async () => {
    const store = createTwoPaneStore()
    const close = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    expect(sentCallsOf('pane.closed').filter((m) => m.createRequestId === 'req-b')).toHaveLength(1)
    // Mid-wait: pane-1's own committed close lands (the direct reducer — the
    // shape every committed close ends in). The split collapses to the sole
    // leaf pane-2 — the close's removal target is now the tab's only pane.
    store.dispatch(closePane({ tabId: 'tab-1', paneId: 'pane-1' }))
    expect(paneContents(store, 'tab-1').map((p) => p.paneId)).toEqual(['pane-2'])
    // The ack arrives — SUCCESS. The closePane reducer refuses the removal
    // (the last leaf): the pane stays displayed under a durable close record.
    emit({ type: 'pane.closed.result', createRequestId: 'req-b', success: true })
    await close
    // The survivor stays displayed and running...
    expect(paneContents(store, 'tab-1').map((p) => p.paneId)).toEqual(['pane-2'])
    // ...wears the normal error chrome (the close op surfaces the refusal)...
    expect(paneCloseErrors(store, 'tab-1')).toEqual({
      'pane-2': 'the pane close was recorded, but the pane could not be removed; the pane was left open',
    })
    // ...and carries NO standing close evidence: the open re-assertion went
    // out AFTER the close on the wire (the fenced consume ⇒ a later recovery
    // offers the survivor again).
    expect(sentCallsOf('pane.opened')).toEqual([
      expect.objectContaining({ type: 'pane.opened', createRequestId: 'req-b', tabId: 'tab-1' }),
    ])
    expect(firstSendIndexOf('pane.closed')).toBeLessThan(firstSendIndexOf('pane.opened'))
  })

  it('the same compensation covers a fresh-agent survivor (the CRID-only identity re-asserts too)', async () => {
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
    const close = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-fa' }))
    expect(sentCallsOf('pane.closed').filter((m) => m.createRequestId === 'req-fa')).toHaveLength(1)
    store.dispatch(closePane({ tabId: 'tab-1', paneId: 'pane-1' }))
    emit({ type: 'pane.closed.result', createRequestId: 'req-fa', success: true })
    await close
    expect(paneContents(store, 'tab-1').map((p) => p.paneId)).toEqual(['pane-fa'])
    expect(sentCallsOf('pane.opened')).toEqual([
      expect.objectContaining({ type: 'pane.opened', createRequestId: 'req-fa', tabId: 'tab-1' }),
    ])
  })

  it('control: the acked close whose removal LANDS re-asserts nothing and surfaces no error (the healthy path is unchanged)', async () => {
    const store = createTwoPaneStore()
    const close = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    ackAllPaneCloses()
    await close
    expect(paneContents(store, 'tab-1').map((p) => p.paneId)).toEqual(['pane-1'])
    expect(sentCallsOf('pane.opened')).toEqual([])
    expect(paneCloseErrors(store, 'tab-1')).toEqual({})
  })

  it('the refused survivor re-closes normally: the sole-leaf follow-up delegates to the whole-tab close (never a stuck pane)', async () => {
    const store = createTwoPaneStore()
    const close = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    store.dispatch(closePane({ tabId: 'tab-1', paneId: 'pane-1' }))
    emit({ type: 'pane.closed.result', createRequestId: 'req-b', success: true })
    await close
    expect(paneContents(store, 'tab-1').map((p) => p.paneId)).toEqual(['pane-2'])
    // A fresh close attempt on the survivor takes the normal last-pane path.
    const retry = store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-2' }))
    const batches = sentCallsOf('panes.closed')
    expect(batches).toHaveLength(1)
    expect(batches[0].panes).toEqual([{ createRequestId: 'req-b', terminalId: 'term-b' }])
    ackPanesClosedBatches()
    await retry
    expect(store.getState().tabs.tabs.some((t) => t.id === 'tab-1')).toBe(false)
  })
})
