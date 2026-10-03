import { configureStore } from '@reduxjs/toolkit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import tabsReducer, { addTab, closePaneWithCleanup, closeTab, detachManagedRuntimeView, reopenClosedTab, replacePaneWithCleanup } from '../../../../src/store/tabsSlice'
import panesReducer, { initLayout, splitPane, updatePaneContent } from '../../../../src/store/panesSlice'
import managedRuntimeReducer, { managedRuntimeSnapshotReceived, setManagedRuntimeAvailable } from '../../../../src/store/managedRuntimeSlice'
import tabRegistryReducer from '../../../../src/store/tabRegistrySlice'
import {
  buildManagedRuntimeMergePlan,
  queueManagedRuntimeRefresh,
  resetManagedRuntimeRefreshForTest,
} from '../../../../src/lib/recovery/managed-runtime-recovery'
import type {
  ManagedRuntimeInventorySnapshot,
  ManagedRuntimeSoul,
  ManagedRuntimeViewIntent,
} from '@shared/managed-runtime'
import { collectPaneContents } from '@/lib/pane-utils'
import { withManagedVisibilityTransition } from '@/store/managedVisibilityCoordinator'

const apiMocks = vi.hoisted(() => ({
  getManagedRuntimeInventory: vi.fn(),
  updateManagedRuntimeViewVisibility: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>()
  return { ...original, ...apiMocks }
})

const wsMock = vi.hoisted(() => ({
  handlers: new Set<(message: unknown) => void>(),
  sent: [] as unknown[],
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: (message: unknown) => {
      wsMock.sent.push(message)
      const frame = message as { type?: string; requestId?: string }
      if (frame.type === 'pane.closed') {
        const paneFrame = message as { createRequestId?: string }
        for (const handler of [...wsMock.handlers]) {
          handler({ type: 'pane.closed.result', createRequestId: paneFrame.createRequestId, success: true })
        }
        return
      }
      if (frame.type === 'pane.opened') {
        const paneFrame = message as { createRequestId?: string }
        for (const handler of [...wsMock.handlers]) {
          handler({ type: 'pane.opened.result', createRequestId: paneFrame.createRequestId, success: true })
        }
        return
      }
      if (frame.type !== 'panes.closed' || !frame.requestId) return
      for (const handler of [...wsMock.handlers]) {
        handler({ type: 'panes.closed.result', requestId: frame.requestId, success: true })
      }
    },
    onMessage: (handler: (message: unknown) => void) => {
      wsMock.handlers.add(handler)
      return () => wsMock.handlers.delete(handler)
    },
  }),
  resetWsClientForTests: vi.fn(),
}))

function soul(soulId: string): ManagedRuntimeSoul {
  return {
    soulId,
    incarnationId: `incarnation-${soulId}`,
    launchState: 'running',
    cleanupState: 'none',
    intentRevision: 5,
    executionGeneration: 1,
    effectiveLimits: { cpuMilli: 500, memoryBytes: 134_217_728, swapBytes: 0, pidsMax: 64 },
    configuredLimits: { cpuMilli: 500, memoryBytes: 134_217_728, swapBytes: 0, pidsMax: 64 },
    terminalId: `terminal-${soulId}`,
    terminalStreamId: `stream-${soulId}`,
    terminalMode: 'opencode',
    terminalCwd: '/workspace',
    terminalCreateRequestId: `create-${soulId}`,
    projectKey: 'workspace-one',
    profile: 'default_agent',
    desiredState: 'running',
    recoveryState: 'live',
    durabilityState: 'resume_captured',
    allocationState: 'verified_durable',
    provider: 'opencode',
    nativeSessionId: `session-${soulId}`,
    evidenceRevision: 2,
    successfulRecoveriesInWindow: 1,
  }
}

function view(viewId: string, paneIndex: number): ManagedRuntimeViewIntent {
  return {
    viewId,
    soulId: `soul-${viewId}`,
    ownerId: 'installation-one',
    workspaceId: 'workspace-one',
    kind: 'automatic_primary',
    preferredTabId: 'managed-tab',
    preferredPaneId: `managed-pane-${paneIndex}`,
    title: `Managed ${viewId}`,
    placementGroup: 'Recovered agents',
    visibility: 'visible',
    revision: 2,
    soulIntentRevision: 5,
    createdAt: 1,
    updatedAt: 2,
  }
}

function inventory(
  revision: number,
  viewIntents: ManagedRuntimeViewIntent[],
): ManagedRuntimeInventorySnapshot {
  const soulIds = [...new Set(viewIntents.map((entry) => entry.soulId))]
  return {
    revision,
    readiness: {
      inventoryRevision: revision,
      initialScanState: 'complete',
      initialScanStartedAt: 1,
      initialScanFinishedAt: 2,
      blockedSubsystems: [],
      startupRecoveryConcurrencyLimit: 4,
      startupRecoveryPeak: 2,
      initialScanDurationMs: 1,
    },
    souls: soulIds.map(soul),
    viewIntents,
    pendingProjectionCount: 0,
  }
}

function managedContent(viewIntent: ManagedRuntimeViewIntent) {
  const managedSoul = soul(viewIntent.soulId)
  return {
    kind: 'terminal' as const,
    createRequestId: managedSoul.terminalCreateRequestId!,
    terminalId: managedSoul.terminalId,
    streamId: managedSoul.terminalStreamId,
    status: 'running' as const,
    mode: 'opencode' as const,
    shell: 'system' as const,
    sessionRef: { provider: 'opencode' as const, sessionId: managedSoul.nativeSessionId! },
    soulId: viewIntent.soulId,
    viewIntentId: viewIntent.viewId,
    viewIntentRevision: viewIntent.revision,
    soulIntentRevision: viewIntent.soulIntentRevision,
  }
}

function createStore(viewRefs: string[], current = inventory(8, [...new Map(
  viewRefs.map((viewId, index) => [viewId, view(viewId, index)]),
).values()])) {
  const store = configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      managedRuntime: managedRuntimeReducer,
      tabRegistry: tabRegistryReducer,
    },
  })
  store.dispatch(managedRuntimeSnapshotReceived({ snapshot: current, reconstructedViewCount: 0 }))
  const firstView = current.viewIntents.find((entry) => entry.viewId === viewRefs[0])!
  store.dispatch(addTab({
    id: 'managed-tab',
    title: 'Managed agents',
    mode: 'opencode',
    viewIntentId: firstView.viewId,
    viewIntentRevision: firstView.revision,
    soulIntentRevision: firstView.soulIntentRevision,
  }))
  store.dispatch(initLayout({
    tabId: 'managed-tab',
    paneId: 'managed-pane-0',
    content: managedContent(firstView),
  }))
  for (let index = 1; index < viewRefs.length; index += 1) {
    const nextView = current.viewIntents.find((entry) => entry.viewId === viewRefs[index])!
    store.dispatch(splitPane({
      tabId: 'managed-tab',
      paneId: 'managed-pane-0',
      direction: 'vertical',
      newPaneId: `managed-pane-${index}`,
      newContent: managedContent(nextView),
    }))
  }
  return store
}

function withVisibility(
  snapshot: ManagedRuntimeInventorySnapshot,
  viewId: string,
  visibility: ManagedRuntimeViewIntent['visibility'],
): ManagedRuntimeInventorySnapshot {
  return {
    ...snapshot,
    revision: snapshot.revision + 1,
    readiness: { ...snapshot.readiness, inventoryRevision: snapshot.revision + 1 },
    viewIntents: snapshot.viewIntents.map((entry) => entry.viewId === viewId
      ? { ...entry, visibility, revision: entry.revision + 1, updatedAt: entry.updatedAt + 1 }
      : entry),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('closeTab managed runtime visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    wsMock.handlers.clear()
    wsMock.sent = []
    resetManagedRuntimeRefreshForTest()
  })

  afterEach(() => {
    resetManagedRuntimeRefreshForTest()
  })

  it('detaches a created terminal whose local view projection is delayed', async () => {
    let serverSnapshot = inventory(8, [view('view-a', 0)])
    const store = createStore(['view-a'], serverSnapshot)
    store.dispatch(updatePaneContent({
      tabId: 'managed-tab',
      paneId: 'managed-pane-0',
      content: {
        kind: 'terminal',
        createRequestId: 'create-soul-view-a',
        terminalId: 'terminal-soul-view-a',
        status: 'running',
        mode: 'opencode',
      },
    }))
    apiMocks.getManagedRuntimeInventory.mockImplementation(async () => serverSnapshot)
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (viewId: string, visibility: ManagedRuntimeViewIntent['visibility']) => {
      serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
      return serverSnapshot.viewIntents.find((entry) => entry.viewId === viewId)
    })

    await store.dispatch(closeTab('managed-tab'))

    expect(apiMocks.updateManagedRuntimeViewVisibility).toHaveBeenCalledWith('view-a', 'detached', 2, 5)
    expect(store.getState().tabs.tabs).toHaveLength(0)
    expect(serverSnapshot.viewIntents[0]?.visibility).toBe('detached')
  })

  it('keeps a still-creating terminal open while its managed view has not committed', async () => {
    const baseSnapshot = inventory(8, [view('view-a', 0)])
    const pendingSnapshot: ManagedRuntimeInventorySnapshot = {
      ...baseSnapshot,
      souls: [{
        ...soul('soul-view-a'),
        launchState: 'starting',
        terminalId: undefined,
        terminalStreamId: undefined,
      }],
      viewIntents: [],
      pendingProjectionCount: 1,
    }
    const store = createStore(['view-a'], baseSnapshot)
    store.dispatch(updatePaneContent({
      tabId: 'managed-tab',
      paneId: 'managed-pane-0',
      content: {
        kind: 'terminal',
        createRequestId: 'create-soul-view-a',
        status: 'creating',
        mode: 'opencode',
      },
    }))
    apiMocks.getManagedRuntimeInventory.mockResolvedValue(pendingSnapshot)

    await store.dispatch(closeTab('managed-tab'))

    expect(store.getState().tabs.tabs).toHaveLength(1)
    expect(store.getState().panes.layouts['managed-tab']?.type).toBe('leaf')
    expect((store.getState().panes.layouts['managed-tab'] as any)?.content.closeError).toContain('managed view')
    expect(apiMocks.updateManagedRuntimeViewVisibility).not.toHaveBeenCalled()
  })

  it('keeps an unprojected creating terminal when a complete inventory has zero pending projections', async () => {
    const snapshot = inventory(8, [view('view-a', 0)])
    const store = createStore(['view-a'], snapshot)
    store.dispatch(addTab({ id: 'creating-tab', title: 'Creating shell', mode: 'shell' }))
    store.dispatch(initLayout({
      tabId: 'creating-tab',
      paneId: 'creating-pane',
      content: {
        kind: 'terminal',
        createRequestId: 'create-still-pending',
        status: 'creating',
        mode: 'shell',
      },
    }))
    apiMocks.getManagedRuntimeInventory.mockResolvedValue(snapshot)

    await store.dispatch(closeTab('creating-tab'))

    expect(store.getState().tabs.tabs.some((tab) => tab.id === 'creating-tab')).toBe(true)
    const layout = store.getState().panes.layouts['creating-tab']
    expect(layout?.type).toBe('leaf')
    if (layout?.type === 'leaf' && layout.content.kind === 'terminal') {
      expect(layout.content.closeError).toContain('managed view')
    }
    expect(apiMocks.updateManagedRuntimeViewVisibility).not.toHaveBeenCalled()
  })

  it('keeps an unresolved creating terminal when capability is unavailable', async () => {
    const snapshot = inventory(8, [view('view-a', 0)])
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        managedRuntime: managedRuntimeReducer,
        tabRegistry: tabRegistryReducer,
      },
    })
    store.dispatch(managedRuntimeSnapshotReceived({ snapshot, reconstructedViewCount: 0 }))
    store.dispatch(setManagedRuntimeAvailable(false))
    store.dispatch(addTab({ id: 'creating-tab', title: 'Creating shell', mode: 'shell' }))
    store.dispatch(initLayout({
      tabId: 'creating-tab',
      paneId: 'creating-pane',
      content: {
        kind: 'terminal',
        createRequestId: 'create-still-pending',
        status: 'creating',
        mode: 'shell',
      },
    }))

    await store.dispatch(closeTab('creating-tab'))

    expect(store.getState().tabs.tabs.some((tab) => tab.id === 'creating-tab')).toBe(true)
    const layout = store.getState().panes.layouts['creating-tab']
    expect(layout?.type).toBe('leaf')
    if (layout?.type === 'leaf' && layout.content.kind === 'terminal') {
      expect(layout.content.closeError).toContain('managed view')
    }
    expect(apiMocks.getManagedRuntimeInventory).not.toHaveBeenCalled()
    expect(apiMocks.updateManagedRuntimeViewVisibility).not.toHaveBeenCalled()
  })

  it('keeps a known managed view open when managed-runtime capability is unavailable', async () => {
    const store = createStore(['view-a'])
    store.dispatch(setManagedRuntimeAvailable(false))

    await store.dispatch(closeTab('managed-tab'))

    expect(store.getState().tabs.tabs).toHaveLength(1)
    expect(store.getState().panes.layouts['managed-tab']?.type).toBe('leaf')
    expect((store.getState().panes.layouts['managed-tab'] as any)?.content.closeError).toContain('managed view')
    expect(apiMocks.updateManagedRuntimeViewVisibility).not.toHaveBeenCalled()
  })

  it.each(['terminalId', 'createRequestId'] as const)(
    'keeps an unmarked terminal open when its cached managed %s matches after capability loss',
    async (handle) => {
      const store = createStore(['view-a'])
      store.dispatch(updatePaneContent({
        tabId: 'managed-tab',
        paneId: 'managed-pane-0',
        content: {
          kind: 'terminal',
          ...(handle === 'terminalId'
            ? { terminalId: 'terminal-soul-view-a' }
            : { createRequestId: 'create-soul-view-a' }),
          status: 'running',
          mode: 'opencode',
        },
      }))
      store.dispatch(setManagedRuntimeAvailable(false))

      await store.dispatch(closeTab('managed-tab'))

      expect(store.getState().tabs.tabs).toHaveLength(1)
      const layout = store.getState().panes.layouts['managed-tab']
      expect(layout?.type).toBe('leaf')
      if (layout?.type === 'leaf' && layout.content.kind === 'terminal') {
        expect(layout.content.closeError).toContain('managed view')
      }
      expect(apiMocks.getManagedRuntimeInventory).not.toHaveBeenCalled()
      expect(apiMocks.updateManagedRuntimeViewVisibility).not.toHaveBeenCalled()
    },
  )

  it('keeps the pane open when managed inventory cannot be fetched', async () => {
    const store = createStore(['view-a'])
    apiMocks.getManagedRuntimeInventory.mockRejectedValue(new Error('inventory offline'))

    await store.dispatch(closeTab('managed-tab'))

    expect(store.getState().tabs.tabs).toHaveLength(1)
    expect(store.getState().panes.layouts['managed-tab']?.type).toBe('leaf')
    expect((store.getState().panes.layouts['managed-tab'] as any)?.content.closeError).toContain('managed view')
    expect(wsMock.sent.some((message: any) => message.type === 'pane.opened')).toBe(true)
  })

  it('keeps the pane open when terminal identity matches multiple managed views', async () => {
    const primaryView = { ...view('view-a', 0), preferredPaneId: 'different-pane' }
    const otherViewOfSameSoul = { ...view('view-b', 1), soulId: primaryView.soulId, kind: 'explicit' as const }
    const current = inventory(8, [primaryView, otherViewOfSameSoul])
    const store = createStore(['view-a'], current)
    store.dispatch(splitPane({
      tabId: 'managed-tab',
      paneId: 'managed-pane-0',
      direction: 'vertical',
      newPaneId: 'unrelated-pane',
      newContent: {
        kind: 'terminal',
        createRequestId: 'unrelated-create',
        status: 'running',
        mode: 'shell',
      },
    }))
    store.dispatch(updatePaneContent({
      tabId: 'managed-tab',
      paneId: 'managed-pane-0',
      content: {
        kind: 'terminal',
        createRequestId: 'create-soul-view-a',
        terminalId: 'terminal-soul-view-a',
        status: 'running',
        mode: 'opencode',
      },
    }))
    apiMocks.getManagedRuntimeInventory.mockResolvedValue(current)

    await store.dispatch(closeTab('managed-tab'))

    expect(store.getState().tabs.tabs).toHaveLength(1)
    const layout = store.getState().panes.layouts['managed-tab']
    expect(layout?.type).toBe('split')
    expect(collectPaneContents(layout).some((content) => (
      content.kind === 'terminal' && content.closeError?.includes('managed view')
    ))).toBe(true)
    expect(apiMocks.updateManagedRuntimeViewVisibility).not.toHaveBeenCalled()
  })

  it('detaches each distinct managed view and makes an older in-flight inventory harmless', async () => {
    const initialViews = [view('view-a', 0), view('view-b', 1)]
    let serverSnapshot = inventory(8, initialViews)
    const store = createStore(['view-a', 'view-b'], serverSnapshot)
    const delayedInventory = deferred<ManagedRuntimeInventorySnapshot>()
    let inventoryCall = 0
    apiMocks.getManagedRuntimeInventory.mockImplementation(() => {
      inventoryCall += 1
      if (inventoryCall === 1) return delayedInventory.promise
      return Promise.resolve(serverSnapshot)
    })
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (viewId: string, visibility: ManagedRuntimeViewIntent['visibility']) => {
      const current = serverSnapshot.viewIntents.find((entry) => entry.viewId === viewId)!
      expect(current.visibility).toBe('visible')
      serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
      return serverSnapshot.viewIntents.find((entry) => entry.viewId === viewId)
    })

    const staleRefresh = queueManagedRuntimeRefresh(store as any, 'delayed-before-close')
    const closed = store.dispatch(closeTab('managed-tab'))
    await closed

    expect(apiMocks.updateManagedRuntimeViewVisibility).toHaveBeenCalledTimes(2)
    expect(apiMocks.updateManagedRuntimeViewVisibility).toHaveBeenNthCalledWith(
      1,
      'view-a',
      'detached',
      2,
      5,
    )
    expect(apiMocks.updateManagedRuntimeViewVisibility).toHaveBeenNthCalledWith(
      2,
      'view-b',
      'detached',
      2,
      5,
    )
    expect(store.getState().tabs.tabs).toHaveLength(0)
    expect(store.getState().managedRuntime.viewIntents.map((entry) => entry.visibility)).toEqual([
      'detached',
      'detached',
    ])
    expect(store.getState().managedRuntime.souls.every((entry) => entry.desiredState === 'running')).toBe(true)

    delayedInventory.resolve(inventory(9, initialViews))
    await staleRefresh

    expect(store.getState().tabs.tabs).toHaveLength(0)
    expect(buildManagedRuntimeMergePlan(serverSnapshot, store.getState() as any).creates).toHaveLength(0)
  })

  it('deduplicates a managed view referenced by two panes', async () => {
    const views = [view('view-a', 0)]
    let serverSnapshot = inventory(8, views)
    const store = createStore(['view-a', 'view-a'], serverSnapshot)
    apiMocks.getManagedRuntimeInventory.mockImplementation(async () => serverSnapshot)
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (viewId: string, visibility: ManagedRuntimeViewIntent['visibility']) => {
      serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
      return serverSnapshot.viewIntents[0]
    })

    await store.dispatch(closeTab('managed-tab'))

    expect(apiMocks.updateManagedRuntimeViewVisibility).toHaveBeenCalledTimes(1)
    expect(serverSnapshot.viewIntents[0].visibility).toBe('detached')
  })

  it('keeps a multi-view tab open after partial detachment and retry completes remaining views', async () => {
    let serverSnapshot = inventory(8, [view('view-a', 0), view('view-b', 1)])
    const store = createStore(['view-a', 'view-b'], serverSnapshot)
    let failSecond = true
    apiMocks.getManagedRuntimeInventory.mockImplementation(async () => serverSnapshot)
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (viewId: string, visibility: ManagedRuntimeViewIntent['visibility']) => {
      if (viewId === 'view-b' && failSecond) {
        failSecond = false
        throw new Error('view update rejected')
      }
      serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
      return serverSnapshot.viewIntents.find((entry) => entry.viewId === viewId)
    })

    await store.dispatch(closeTab('managed-tab'))
    expect(store.getState().tabs.tabs).toHaveLength(1)
    expect(serverSnapshot.viewIntents.map((entry) => entry.visibility)).toEqual(['detached', 'visible'])
    expect(wsMock.sent.some((message: any) => message.type === 'pane.opened')).toBe(true)

    await store.dispatch(closeTab('managed-tab'))
    expect(store.getState().tabs.tabs).toHaveLength(0)
    expect(serverSnapshot.viewIntents.map((entry) => entry.visibility)).toEqual(['detached', 'detached'])
    expect(apiMocks.updateManagedRuntimeViewVisibility).toHaveBeenCalledTimes(3)
  })

  it('refreshes managed handles and reasserts every restored pane before promoting its views', async () => {
    let serverSnapshot = inventory(10, [
      { ...view('view-a', 0), visibility: 'detached', revision: 3 },
      { ...view('view-b', 1), visibility: 'detached', revision: 4 },
    ])
    const store = createStore(['view-a', 'view-b'], serverSnapshot)
    apiMocks.getManagedRuntimeInventory.mockImplementation(async () => serverSnapshot)
    const patchStarted = deferred<void>()
    const finishPatch = deferred<void>()
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (viewId: string, visibility: ManagedRuntimeViewIntent['visibility']) => {
      patchStarted.resolve()
      await finishPatch.promise
      serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
      return serverSnapshot.viewIntents.find((entry) => entry.viewId === viewId)
    })
    await store.dispatch(closeTab('managed-tab'))
    expect(store.getState().tabRegistry.reopenStack).toHaveLength(1)
    serverSnapshot = {
      ...serverSnapshot,
      revision: serverSnapshot.revision + 1,
      readiness: { ...serverSnapshot.readiness, inventoryRevision: serverSnapshot.revision + 1 },
      souls: serverSnapshot.souls.map((entry, index) => ({
        ...entry,
        terminalId: `terminal-current-${index}`,
        terminalStreamId: `stream-current-${index}`,
        terminalCreateRequestId: `create-current-${index}`,
      })),
    }

    const reopened = store.dispatch(reopenClosedTab())
    await patchStarted.promise
    expect(store.getState().tabs.tabs).toHaveLength(1)
    expect(buildManagedRuntimeMergePlan(
      withVisibility(serverSnapshot, 'view-a', 'visible'),
      store.getState() as any,
    ).creates).toHaveLength(0)

    finishPatch.resolve()
    await reopened
    expect(store.getState().tabs.tabs).toHaveLength(1)
    expect(store.getState().tabRegistry.reopenStack).toHaveLength(0)
    expect(serverSnapshot.viewIntents.map((entry) => entry.visibility)).toEqual(['visible', 'visible'])
    const restoredTabId = store.getState().tabs.tabs[0]!.id
    const restored = store.getState().panes.layouts[restoredTabId]
    if (!restored) throw new Error('expected a restored managed layout')
    const restoredTerminals = collectPaneContents(restored).filter((content) => content.kind === 'terminal')
    expect(restoredTerminals.map((content) => content.terminalId).sort()).toEqual([
      'terminal-current-0',
      'terminal-current-1',
    ])
    expect(restoredTerminals.map((content) => content.streamId).sort()).toEqual([
      'stream-current-0',
      'stream-current-1',
    ])
    expect(restoredTerminals.map((content) => content.createRequestId).sort()).toEqual([
      'create-current-0',
      'create-current-1',
    ])
    expect(restoredTerminals.every((content) => content.status === 'running')).toBe(true)
    const openedCreateRequestIds = wsMock.sent
      .filter((message: any) => message.type === 'pane.opened')
      .map((message: any) => message.createRequestId)
      .sort()
    expect(openedCreateRequestIds).toEqual(['create-current-0', 'create-current-1'])
  })

  it('does not restore or consume a managed tab when its fresh inventory is incomplete', async () => {
    let serverSnapshot = inventory(8, [view('view-a', 0)])
    const store = createStore(['view-a'], serverSnapshot)
    apiMocks.getManagedRuntimeInventory.mockImplementation(async () => serverSnapshot)
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (viewId: string, visibility: ManagedRuntimeViewIntent['visibility']) => {
      serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
      return serverSnapshot.viewIntents.find((entry) => entry.viewId === viewId)
    })
    await store.dispatch(closeTab('managed-tab'))
    const mutationsAfterClose = apiMocks.updateManagedRuntimeViewVisibility.mock.calls.length
    apiMocks.getManagedRuntimeInventory.mockResolvedValue({
      ...serverSnapshot,
      readiness: { ...serverSnapshot.readiness, initialScanState: 'pending' },
    })

    const result = await store.dispatch(reopenClosedTab())

    expect(reopenClosedTab.rejected.match(result)).toBe(true)
    expect(store.getState().tabs.tabs).toHaveLength(0)
    expect(Object.keys(store.getState().panes.layouts)).toEqual([])
    expect(store.getState().tabRegistry.reopenStack).toHaveLength(1)
    expect(apiMocks.updateManagedRuntimeViewVisibility).toHaveBeenCalledTimes(mutationsAfterClose)
  })

  it('does not restore or consume a managed tab when fresh inventory lacks its current create handle', async () => {
    let serverSnapshot = inventory(8, [view('view-a', 0)])
    const store = createStore(['view-a'], serverSnapshot)
    apiMocks.getManagedRuntimeInventory.mockImplementation(async () => serverSnapshot)
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (viewId: string, visibility: ManagedRuntimeViewIntent['visibility']) => {
      serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
      return serverSnapshot.viewIntents.find((entry) => entry.viewId === viewId)
    })
    await store.dispatch(closeTab('managed-tab'))
    const mutationsAfterClose = apiMocks.updateManagedRuntimeViewVisibility.mock.calls.length
    serverSnapshot = {
      ...serverSnapshot,
      souls: serverSnapshot.souls.map((entry) => ({ ...entry, terminalCreateRequestId: undefined })),
    }

    const result = await store.dispatch(reopenClosedTab())

    expect(reopenClosedTab.rejected.match(result)).toBe(true)
    expect(store.getState().tabs.tabs).toHaveLength(0)
    expect(Object.keys(store.getState().panes.layouts)).toEqual([])
    expect(store.getState().tabRegistry.reopenStack).toHaveLength(1)
    expect(apiMocks.updateManagedRuntimeViewVisibility).toHaveBeenCalledTimes(mutationsAfterClose)
    expect(wsMock.sent.filter((message: any) => message.type === 'pane.opened')).toEqual([])
  })

  it('rolls back local restore and keeps the entry when managed visibility promotion fails', async () => {
    let serverSnapshot = inventory(8, [view('view-a', 0)])
    const store = createStore(['view-a'], serverSnapshot)
    apiMocks.getManagedRuntimeInventory.mockImplementation(async () => serverSnapshot)
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (viewId: string, visibility: ManagedRuntimeViewIntent['visibility']) => {
      if (visibility === 'visible') throw new Error('promotion rejected')
      serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
      return serverSnapshot.viewIntents.find((entry) => entry.viewId === viewId)
    })
    await store.dispatch(closeTab('managed-tab'))
    expect(store.getState().tabRegistry.reopenStack).toHaveLength(1)

    const result = await store.dispatch(reopenClosedTab())

    expect(reopenClosedTab.rejected.match(result)).toBe(true)
    expect(store.getState().tabs.tabs).toHaveLength(0)
    expect(Object.keys(store.getState().panes.layouts)).toEqual([])
    expect(store.getState().tabRegistry.reopenStack).toHaveLength(1)
    expect(serverSnapshot.viewIntents[0]?.visibility).toBe('detached')
    expect(wsMock.sent.filter((message: any) => message.type === 'pane.opened')).toHaveLength(1)
  })

  it('does not duplicate a view when promotion committed but confirmation failed and refresh restored it', async () => {
    let serverSnapshot = inventory(8, [view('view-a', 0)])
    const store = createStore(['view-a'], serverSnapshot)
    let failNextConfirmation = false
    apiMocks.getManagedRuntimeInventory.mockImplementation(async () => {
      if (failNextConfirmation) {
        failNextConfirmation = false
        throw new Error('confirmation GET failed')
      }
      return serverSnapshot
    })
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (viewId: string, visibility: ManagedRuntimeViewIntent['visibility']) => {
      serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
      if (visibility === 'visible') {
        failNextConfirmation = true
        throw new Error('PATCH response lost after commit')
      }
      return serverSnapshot.viewIntents.find((entry) => entry.viewId === viewId)
    })
    await store.dispatch(closeTab('managed-tab'))
    expect(store.getState().tabRegistry.reopenStack).toHaveLength(1)

    const firstReopen = await store.dispatch(reopenClosedTab())

    expect(reopenClosedTab.rejected.match(firstReopen)).toBe(true)
    expect(store.getState().tabs.tabs).toHaveLength(0)
    expect(store.getState().tabRegistry.reopenStack).toHaveLength(1)
    await queueManagedRuntimeRefresh(store as any, 'after-ambiguous-promotion')
    expect(store.getState().tabs.tabs).toHaveLength(1)

    const retry = await store.dispatch(reopenClosedTab())

    expect(reopenClosedTab.fulfilled.match(retry)).toBe(true)
    expect(store.getState().tabs.tabs).toHaveLength(1)
    expect(store.getState().tabRegistry.reopenStack).toHaveLength(0)
    const representedViews = Object.values(store.getState().panes.layouts)
      .flatMap((layout) => layout ? collectPaneContents(layout) : [])
      .filter((content) => content.kind === 'terminal' && content.viewIntentId === 'view-a')
    expect(representedViews).toHaveLength(1)
  })

  it('runs fresh managed preflight when a managed tab marker survives an empty runtime cache', async () => {
    let serverSnapshot = inventory(8, [view('view-a', 0)])
    const store = createStore(['view-a'], serverSnapshot)
    store.dispatch(updatePaneContent({
      tabId: 'managed-tab',
      paneId: 'managed-pane-0',
      content: {
        kind: 'terminal',
        terminalId: 'terminal-soul-view-a',
        createRequestId: 'create-soul-view-a',
        status: 'running',
        mode: 'opencode',
      },
    }))
    apiMocks.getManagedRuntimeInventory.mockImplementation(async () => serverSnapshot)
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (viewId: string, visibility: ManagedRuntimeViewIntent['visibility']) => {
      serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
      return serverSnapshot.viewIntents.find((entry) => entry.viewId === viewId)
    })

    await store.dispatch(closeTab('managed-tab'))
    const savedEntry = store.getState().tabRegistry.reopenStack[0]!
    expect(savedEntry.tab.viewIntentId).toBe('view-a')
    expect(savedEntry.layout.type).toBe('leaf')
    if (savedEntry.layout.type === 'leaf' && savedEntry.layout.content.kind === 'terminal') {
      expect(savedEntry.layout.content.viewIntentId).toBeUndefined()
    }
    store.dispatch(managedRuntimeSnapshotReceived({
      snapshot: inventory(serverSnapshot.revision + 1, []),
      reconstructedViewCount: 0,
    }))
    apiMocks.getManagedRuntimeInventory.mockClear()
    apiMocks.getManagedRuntimeInventory.mockImplementation(async () => serverSnapshot)

    const result = await store.dispatch(reopenClosedTab())

    expect(apiMocks.getManagedRuntimeInventory).toHaveBeenCalledTimes(2)
    expect(reopenClosedTab.fulfilled.match(result)).toBe(true)
    const reopened = store.getState().panes.layouts[
      store.getState().tabs.tabs[0]!.id
    ]
    expect(reopened?.type).toBe('leaf')
    if (reopened?.type === 'leaf' && reopened.content.kind === 'terminal') {
      expect(reopened.content.viewIntentId).toBe('view-a')
      expect(reopened.content.terminalId).toBe('terminal-soul-view-a')
      expect(reopened.content.createRequestId).toBe('create-soul-view-a')
    }
    expect(store.getState().tabRegistry.reopenStack).toHaveLength(0)
  })

  it('keeps an automatic-primary tab intact when reopening an explicit sibling view', async () => {
    const primaryView = view('primary-view', 0)
    const explicitView: ManagedRuntimeViewIntent = {
      ...view('explicit-view', 1),
      soulId: primaryView.soulId,
      kind: 'explicit',
      preferredTabId: 'explicit-tab',
      preferredPaneId: 'explicit-pane',
    }
    let serverSnapshot = inventory(8, [primaryView, explicitView])
    const store = createStore(['primary-view'], serverSnapshot)
    store.dispatch(updatePaneContent({
      tabId: 'managed-tab',
      paneId: 'managed-pane-0',
      content: {
        kind: 'terminal',
        terminalId: 'terminal-soul-primary-view',
        createRequestId: 'create-soul-primary-view',
        soulId: primaryView.soulId,
        status: 'running',
        mode: 'opencode',
      },
    }))
    store.dispatch(addTab({
      id: 'explicit-tab',
      title: 'Explicit view',
      mode: 'opencode',
      viewIntentId: explicitView.viewId,
      viewIntentRevision: explicitView.revision,
      soulIntentRevision: explicitView.soulIntentRevision,
    }))
    store.dispatch(initLayout({
      tabId: 'explicit-tab',
      paneId: 'explicit-pane',
      content: managedContent(explicitView),
    }))
    apiMocks.getManagedRuntimeInventory.mockImplementation(async () => serverSnapshot)
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (
      viewId: string,
      visibility: ManagedRuntimeViewIntent['visibility'],
    ) => {
      serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
      return serverSnapshot.viewIntents.find((entry) => entry.viewId === viewId)
    })
    const primaryLayoutBeforeClose = store.getState().panes.layouts['managed-tab']

    await store.dispatch(closeTab('explicit-tab'))
    expect(store.getState().tabs.tabs.map((tab) => tab.id)).toEqual(['managed-tab'])
    expect(store.getState().tabRegistry.reopenStack).toHaveLength(1)
    expect(store.getState().panes.layouts['managed-tab']).toEqual(primaryLayoutBeforeClose)
    expect(serverSnapshot.viewIntents.find((entry) => entry.viewId === 'explicit-view')?.visibility).toBe('detached')
    expect(serverSnapshot.viewIntents.find((entry) => entry.viewId === 'primary-view')?.visibility).toBe('visible')
    expect(apiMocks.updateManagedRuntimeViewVisibility).toHaveBeenCalledWith(
      'explicit-view',
      'detached',
      explicitView.revision,
      explicitView.soulIntentRevision,
    )

    await queueManagedRuntimeRefresh(store as any, 'after-detaching-explicit-sibling')
    expect(store.getState().tabs.tabs.map((tab) => tab.id)).toEqual(['managed-tab'])
    expect(serverSnapshot.viewIntents.find((entry) => entry.viewId === 'explicit-view')?.visibility).toBe('detached')
    expect(store.getState().tabRegistry.reopenStack).toHaveLength(1)
    expect(store.getState().tabs.tabs.some((tab) => tab.viewIntentId === 'explicit-view')).toBe(false)
    expect(Object.values(store.getState().panes.layouts).flatMap((layout) => (
      layout ? collectPaneContents(layout) : []
    )).some((content) => (
      content.kind === 'terminal' && content.viewIntentId === 'explicit-view'
    ))).toBe(false)
    const refreshedPrimaryLayout = store.getState().panes.layouts['managed-tab']
    expect(refreshedPrimaryLayout?.type).toBe('leaf')
    if (refreshedPrimaryLayout?.type === 'leaf' && refreshedPrimaryLayout.content.kind === 'terminal') {
      expect(refreshedPrimaryLayout.content.viewIntentId).toBe('primary-view')
      expect(refreshedPrimaryLayout.content.terminalId).toBe('terminal-soul-primary-view')
    }

    const result = await store.dispatch(reopenClosedTab())

    expect(reopenClosedTab.fulfilled.match(result)).toBe(true)
    expect(store.getState().tabs.tabs.map((tab) => tab.id)).toHaveLength(2)
    expect(store.getState().tabs.tabs.find((tab) => tab.id === 'managed-tab')?.viewIntentId).toBe('primary-view')
    const finalPrimaryLayout = store.getState().panes.layouts['managed-tab']
    expect(finalPrimaryLayout?.type).toBe('leaf')
    if (finalPrimaryLayout?.type === 'leaf' && finalPrimaryLayout.content.kind === 'terminal') {
      expect(finalPrimaryLayout.content.viewIntentId).toBe('primary-view')
      expect(finalPrimaryLayout.content.terminalId).toBe('terminal-soul-primary-view')
    }
    const explicitTab = store.getState().tabs.tabs.find((tab) => tab.id !== 'managed-tab')!
    const reopenedContent = store.getState().panes.layouts[explicitTab.id]
    expect(reopenedContent?.type).toBe('leaf')
    if (reopenedContent?.type === 'leaf' && reopenedContent.content.kind === 'terminal') {
      expect(reopenedContent.content.viewIntentId).toBe('explicit-view')
    }
    expect(store.getState().tabRegistry.reopenStack).toHaveLength(0)
  })

  it('closes an unmarked preferred primary view without detaching its explicit sibling', async () => {
    const primaryView = view('primary-view', 0)
    const explicitView: ManagedRuntimeViewIntent = {
      ...view('explicit-view', 1),
      soulId: primaryView.soulId,
      kind: 'explicit',
      preferredTabId: 'explicit-tab',
      preferredPaneId: 'explicit-pane',
    }
    let serverSnapshot = inventory(8, [primaryView, explicitView])
    const store = createStore(['primary-view'], serverSnapshot)
    store.dispatch(updatePaneContent({
      tabId: 'managed-tab',
      paneId: 'managed-pane-0',
      content: {
        kind: 'terminal',
        terminalId: 'terminal-soul-primary-view',
        createRequestId: 'create-soul-primary-view',
        soulId: primaryView.soulId,
        status: 'running',
        mode: 'opencode',
      },
    }))
    apiMocks.getManagedRuntimeInventory.mockImplementation(async () => serverSnapshot)
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (
      viewId: string,
      visibility: ManagedRuntimeViewIntent['visibility'],
    ) => {
      serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
      return serverSnapshot.viewIntents.find((entry) => entry.viewId === viewId)
    })

    await store.dispatch(closeTab('managed-tab'))

    expect(store.getState().tabs.tabs).toHaveLength(0)
    expect(store.getState().tabRegistry.reopenStack).toHaveLength(1)
    expect(serverSnapshot.viewIntents.find((entry) => entry.viewId === 'primary-view')?.visibility).toBe('detached')
    expect(serverSnapshot.viewIntents.find((entry) => entry.viewId === 'explicit-view')?.visibility).toBe('visible')
    expect(apiMocks.updateManagedRuntimeViewVisibility).toHaveBeenCalledTimes(1)
    expect(apiMocks.updateManagedRuntimeViewVisibility).toHaveBeenCalledWith(
      'primary-view',
      'detached',
      primaryView.revision,
      primaryView.soulIntentRevision,
    )
  })

  it('uses the saved tab view marker to resolve an unmarked pane after a sibling view is added', async () => {
    const primaryView = view('primary-view', 0)
    let serverSnapshot = inventory(8, [primaryView])
    const store = createStore(['primary-view'], serverSnapshot)
    store.dispatch(updatePaneContent({
      tabId: 'managed-tab',
      paneId: 'managed-pane-0',
      content: {
        kind: 'terminal',
        terminalId: 'terminal-soul-primary-view',
        createRequestId: 'create-soul-primary-view',
        soulId: primaryView.soulId,
        status: 'running',
        mode: 'opencode',
      },
    }))
    apiMocks.getManagedRuntimeInventory.mockImplementation(async () => serverSnapshot)
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (
      viewId: string,
      visibility: ManagedRuntimeViewIntent['visibility'],
    ) => {
      serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
      return serverSnapshot.viewIntents.find((entry) => entry.viewId === viewId)
    })

    await store.dispatch(closeTab('managed-tab'))
    const savedEntry = store.getState().tabRegistry.reopenStack[0]!
    expect(savedEntry.tab.viewIntentId).toBe('primary-view')
    expect(savedEntry.layout.type).toBe('leaf')
    if (savedEntry.layout.type === 'leaf' && savedEntry.layout.content.kind === 'terminal') {
      expect(savedEntry.layout.content.viewIntentId).toBeUndefined()
    }
    const explicitSibling: ManagedRuntimeViewIntent = {
      ...view('explicit-sibling', 1),
      soulId: primaryView.soulId,
      kind: 'explicit',
      preferredTabId: 'explicit-sibling-tab',
      preferredPaneId: 'explicit-sibling-pane',
    }
    const nextRevision = serverSnapshot.revision + 1
    serverSnapshot = {
      ...serverSnapshot,
      revision: nextRevision,
      readiness: { ...serverSnapshot.readiness, inventoryRevision: nextRevision },
      viewIntents: [...serverSnapshot.viewIntents, explicitSibling],
    }
    const detachedPrimaryRevision = serverSnapshot.viewIntents.find((entry) => entry.viewId === 'primary-view')!.revision

    const result = await store.dispatch(reopenClosedTab())

    expect(reopenClosedTab.fulfilled.match(result)).toBe(true)
    expect(apiMocks.updateManagedRuntimeViewVisibility).toHaveBeenLastCalledWith(
      'primary-view',
      'visible',
      detachedPrimaryRevision,
      primaryView.soulIntentRevision,
    )
    const reopenedTab = store.getState().tabs.tabs.find((tab) => tab.id !== 'managed-tab')
    expect(reopenedTab).toBeDefined()
    const reopenedLayout = reopenedTab && store.getState().panes.layouts[reopenedTab.id]
    expect(reopenedLayout?.type).toBe('leaf')
    if (reopenedLayout?.type === 'leaf' && reopenedLayout.content.kind === 'terminal') {
      expect(reopenedLayout.content.viewIntentId).toBe('primary-view')
      expect(reopenedLayout.content.terminalId).toBe('terminal-soul-primary-view')
    }
    expect(store.getState().tabRegistry.reopenStack).toHaveLength(0)
  })

  it('restores a mixed saved layout around a view projected before retry', async () => {
    let serverSnapshot = inventory(8, [view('view-a', 0)])
    const store = createStore(['view-a'], serverSnapshot)
    store.dispatch(splitPane({
      tabId: 'managed-tab',
      paneId: 'managed-pane-0',
      direction: 'vertical',
      newPaneId: 'saved-editor-pane',
      newContent: {
        kind: 'editor',
        filePath: '/workspace/notes.md',
        language: 'markdown',
        readOnly: false,
        content: 'keep this editor pane',
        viewMode: 'source',
      },
    }))
    let failNextConfirmation = false
    apiMocks.getManagedRuntimeInventory.mockImplementation(async () => {
      if (failNextConfirmation) {
        failNextConfirmation = false
        throw new Error('confirmation GET failed')
      }
      return serverSnapshot
    })
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (viewId: string, visibility: ManagedRuntimeViewIntent['visibility']) => {
      serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
      if (visibility === 'visible') {
        failNextConfirmation = true
        throw new Error('PATCH response lost after commit')
      }
      return serverSnapshot.viewIntents.find((entry) => entry.viewId === viewId)
    })

    await store.dispatch(closeTab('managed-tab'))
    const savedEntry = store.getState().tabRegistry.reopenStack[0]!
    expect(collectPaneContents(savedEntry.layout).some((content) => (
      content.kind === 'editor' && content.filePath === '/workspace/notes.md'
    ))).toBe(true)

    const firstReopen = await store.dispatch(reopenClosedTab())
    expect(reopenClosedTab.rejected.match(firstReopen)).toBe(true)
    expect(serverSnapshot.viewIntents[0]?.visibility).toBe('visible')

    await queueManagedRuntimeRefresh(store as any, 'after-ambiguous-mixed-promotion')
    expect(store.getState().tabs.tabs).toHaveLength(1)

    const retry = await store.dispatch(reopenClosedTab())

    expect(reopenClosedTab.fulfilled.match(retry)).toBe(true)
    expect(store.getState().tabs.tabs).toHaveLength(1)
    expect(store.getState().tabRegistry.reopenStack).toHaveLength(0)
    const localContents = Object.values(store.getState().panes.layouts)
      .flatMap((layout) => layout ? collectPaneContents(layout) : [])
    expect(localContents.filter((content) => content.kind === 'terminal' && content.viewIntentId === 'view-a')).toHaveLength(1)
    expect(localContents.some((content) => content.kind === 'editor' && content.filePath === '/workspace/notes.md')).toBe(true)
    const restoredLayout = store.getState().panes.layouts[store.getState().tabs.tabs[0]!.id]
    expect(restoredLayout?.type).toBe('split')
    if (restoredLayout?.type === 'split' && savedEntry.layout.type === 'split') {
      expect(restoredLayout.id).toBe(savedEntry.layout.id)
      expect(restoredLayout.direction).toBe(savedEntry.layout.direction)
      expect(restoredLayout.sizes).toEqual(savedEntry.layout.sizes)
      expect(restoredLayout.children.map((child) => child.id)).toEqual(savedEntry.layout.children.map((child) => child.id))
    }
  })

  it('merges a partially projected split layout and keeps the entry until promotion can be confirmed', async () => {
    let serverSnapshot = inventory(8, [view('view-a', 0), view('view-b', 1)])
    const store = createStore(['view-a', 'view-b'], serverSnapshot)
    let failNextConfirmation = false
    let failPromotionFor: string | null = 'view-a'
    apiMocks.getManagedRuntimeInventory.mockImplementation(async () => {
      if (failNextConfirmation) {
        failNextConfirmation = false
        throw new Error('confirmation GET failed')
      }
      return serverSnapshot
    })
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (viewId: string, visibility: ManagedRuntimeViewIntent['visibility']) => {
      serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
      if (visibility === 'visible' && failPromotionFor === viewId) {
        failPromotionFor = viewId === 'view-a' ? 'view-b' : null
        failNextConfirmation = true
        throw new Error('PATCH response lost after commit')
      }
      return serverSnapshot.viewIntents.find((entry) => entry.viewId === viewId)
    })

    await store.dispatch(closeTab('managed-tab'))
    const savedEntry = store.getState().tabRegistry.reopenStack[0]!
    const firstReopen = await store.dispatch(reopenClosedTab())
    expect(reopenClosedTab.rejected.match(firstReopen)).toBe(true)

    await queueManagedRuntimeRefresh(store as any, 'project-one-view-before-split-retry')
    expect(store.getState().tabs.tabs).toHaveLength(1)

    const mergeAttempt = await store.dispatch(reopenClosedTab())
    expect(reopenClosedTab.rejected.match(mergeAttempt)).toBe(true)
    expect(serverSnapshot.viewIntents.every((entry) => entry.visibility === 'visible')).toBe(true)
    expect(store.getState().tabs.tabs).toHaveLength(1)
    expect(store.getState().tabRegistry.reopenStack).toEqual([savedEntry])
    let restoredLayout = store.getState().panes.layouts[store.getState().tabs.tabs[0]!.id]
    expect(restoredLayout?.type).toBe('split')
    expect(collectPaneContents(restoredLayout!)
      .filter((content) => content.kind === 'terminal' && content.viewIntentId)
      .map((content) => content.kind === 'terminal' ? content.viewIntentId : undefined)
      .sort()).toEqual(['view-a', 'view-b'])

    const finalRetry = await store.dispatch(reopenClosedTab())

    expect(reopenClosedTab.fulfilled.match(finalRetry)).toBe(true)
    expect(store.getState().tabs.tabs).toHaveLength(1)
    expect(store.getState().tabRegistry.reopenStack).toHaveLength(0)
    restoredLayout = store.getState().panes.layouts[store.getState().tabs.tabs[0]!.id]
    expect(restoredLayout?.type).toBe('split')
    if (restoredLayout?.type === 'split' && savedEntry.layout.type === 'split') {
      expect(restoredLayout.id).toBe(savedEntry.layout.id)
      expect(restoredLayout.direction).toBe(savedEntry.layout.direction)
      expect(restoredLayout.sizes).toEqual(savedEntry.layout.sizes)
      expect(restoredLayout.children.map((child) => child.id)).toEqual(savedEntry.layout.children.map((child) => child.id))
    }
  })

  it('restores repeated managed leaves inside the saved split without adding another projected tab', async () => {
    let serverSnapshot = inventory(8, [view('view-a', 0)])
    const store = createStore(['view-a'], serverSnapshot)
    store.dispatch(splitPane({
      tabId: 'managed-tab',
      paneId: 'managed-pane-0',
      direction: 'vertical',
      newPaneId: 'saved-repeat-pane',
      newContent: managedContent(view('view-a', 0)),
    }))
    let failNextConfirmation = false
    apiMocks.getManagedRuntimeInventory.mockImplementation(async () => {
      if (failNextConfirmation) {
        failNextConfirmation = false
        throw new Error('confirmation GET failed')
      }
      return serverSnapshot
    })
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (viewId: string, visibility: ManagedRuntimeViewIntent['visibility']) => {
      serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
      if (visibility === 'visible') {
        failNextConfirmation = true
        throw new Error('PATCH response lost after commit')
      }
      return serverSnapshot.viewIntents.find((entry) => entry.viewId === viewId)
    })

    await store.dispatch(closeTab('managed-tab'))
    const savedEntry = store.getState().tabRegistry.reopenStack[0]!
    const firstReopen = await store.dispatch(reopenClosedTab())
    expect(reopenClosedTab.rejected.match(firstReopen)).toBe(true)
    await queueManagedRuntimeRefresh(store as any, 'project-one-view-before-repeated-pane-retry')
    serverSnapshot = withVisibility(serverSnapshot, 'view-a', 'detached')

    const mergeAttempt = await store.dispatch(reopenClosedTab())

    expect(reopenClosedTab.rejected.match(mergeAttempt)).toBe(true)
    expect(store.getState().tabRegistry.reopenStack).toEqual([savedEntry])
    let restoredLayout = store.getState().panes.layouts[store.getState().tabs.tabs[0]!.id]
    expect(restoredLayout?.type).toBe('split')
    expect(collectPaneContents(restoredLayout!).filter((content) => (
      content.kind === 'terminal' && content.viewIntentId === 'view-a'
    ))).toHaveLength(2)

    const retry = await store.dispatch(reopenClosedTab())
    expect(reopenClosedTab.fulfilled.match(retry)).toBe(true)
    expect(store.getState().tabs.tabs).toHaveLength(1)
    expect(store.getState().tabRegistry.reopenStack).toHaveLength(0)
    restoredLayout = store.getState().panes.layouts[store.getState().tabs.tabs[0]!.id]
    expect(restoredLayout?.type).toBe('split')
    expect(collectPaneContents(restoredLayout!).filter((content) => (
      content.kind === 'terminal' && content.viewIntentId === 'view-a'
    ))).toHaveLength(2)
    if (restoredLayout?.type === 'split' && savedEntry.layout.type === 'split') {
      expect(restoredLayout.id).toBe(savedEntry.layout.id)
      expect(restoredLayout.direction).toBe(savedEntry.layout.direction)
      expect(restoredLayout.sizes).toEqual(savedEntry.layout.sizes)
      expect(restoredLayout.children.map((child) => child.id)).toEqual(savedEntry.layout.children.map((child) => child.id))
    }
  })

  it('folds separate managed projections into the saved split layout', async () => {
    let serverSnapshot = inventory(8, [view('view-a', 0), view('view-b', 1)])
    const store = createStore(['view-a', 'view-b'], serverSnapshot)
    apiMocks.getManagedRuntimeInventory.mockImplementation(async () => serverSnapshot)
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (viewId: string, visibility: ManagedRuntimeViewIntent['visibility']) => {
      serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
      return serverSnapshot.viewIntents.find((entry) => entry.viewId === viewId)
    })
    await store.dispatch(closeTab('managed-tab'))
    store.dispatch(addTab({ id: 'already-open-a', title: 'Already open', mode: 'opencode' }))
    store.dispatch(initLayout({
      tabId: 'already-open-a',
      paneId: 'already-open-pane-a',
      content: managedContent(view('view-a', 0)),
    }))
    store.dispatch(addTab({ id: 'already-open-b', title: 'Already open B', mode: 'opencode' }))
    store.dispatch(initLayout({
      tabId: 'already-open-b',
      paneId: 'already-open-pane-b',
      content: managedContent(view('view-b', 1)),
    }))

    const result = await store.dispatch(reopenClosedTab())

    expect(reopenClosedTab.fulfilled.match(result)).toBe(true)
    expect(store.getState().tabs.tabs.map((tab) => tab.id)).toEqual(['already-open-a'])
    expect(store.getState().tabRegistry.reopenStack).toHaveLength(0)
    const restoredLayout = store.getState().panes.layouts['already-open-a']
    expect(restoredLayout?.type).toBe('split')
    expect(collectPaneContents(restoredLayout!).filter((content) => (
      content.kind === 'terminal' && (content.viewIntentId === 'view-a' || content.viewIntentId === 'view-b')
    ))).toHaveLength(2)
  })

  it.each(['terminalId', 'createRequestId'] as const)(
    'treats a locally represented view found by its fresh %s as already open',
    async (handle) => {
      let serverSnapshot = inventory(8, [view('view-a', 0)])
      const store = createStore(['view-a'], serverSnapshot)
      apiMocks.getManagedRuntimeInventory.mockImplementation(async () => serverSnapshot)
      apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (viewId: string, visibility: ManagedRuntimeViewIntent['visibility']) => {
        serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
        return serverSnapshot.viewIntents.find((entry) => entry.viewId === viewId)
      })
      await store.dispatch(closeTab('managed-tab'))
      serverSnapshot = withVisibility(serverSnapshot, 'view-a', 'visible')
      serverSnapshot = {
        ...serverSnapshot,
        souls: serverSnapshot.souls.map((entry) => ({
          ...entry,
          terminalId: 'terminal-current',
          terminalCreateRequestId: 'create-current',
        })),
      }
      store.dispatch(addTab({ id: 'already-local', title: 'Already local', mode: 'opencode' }))
      store.dispatch(initLayout({
        tabId: 'already-local',
        paneId: 'already-local-pane',
        content: {
          kind: 'terminal',
          ...(handle === 'terminalId'
            ? { terminalId: 'terminal-current' }
            : { createRequestId: 'create-current' }),
          status: 'running',
          mode: 'opencode',
        },
      }))

      const result = await store.dispatch(reopenClosedTab())

      expect(reopenClosedTab.fulfilled.match(result)).toBe(true)
      expect(store.getState().tabs.tabs.map((tab) => tab.id)).toEqual(['already-local'])
      expect(store.getState().tabRegistry.reopenStack).toHaveLength(0)
    },
  )

  it('retains a reopen entry when local terminal identity ambiguously matches multiple saved views', async () => {
    const viewA = view('view-a', 0)
    const viewB = { ...view('view-b', 1), soulId: viewA.soulId }
    let serverSnapshot = inventory(8, [viewA, viewB])
    const store = createStore(['view-a', 'view-b'], serverSnapshot)
    apiMocks.getManagedRuntimeInventory.mockImplementation(async () => serverSnapshot)
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (viewId: string, visibility: ManagedRuntimeViewIntent['visibility']) => {
      serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
      return serverSnapshot.viewIntents.find((entry) => entry.viewId === viewId)
    })
    await store.dispatch(closeTab('managed-tab'))
    store.dispatch(addTab({ id: 'ambiguous-local', title: 'Ambiguous local', mode: 'opencode' }))
    store.dispatch(initLayout({
      tabId: 'ambiguous-local',
      paneId: 'ambiguous-local-pane',
      content: {
        kind: 'terminal',
        terminalId: soul(viewA.soulId).terminalId,
        createRequestId: soul(viewA.soulId).terminalCreateRequestId,
        status: 'running',
        mode: 'opencode',
      },
    }))

    const result = await store.dispatch(reopenClosedTab())

    expect(reopenClosedTab.rejected.match(result)).toBe(true)
    expect(store.getState().tabs.tabs.map((tab) => tab.id)).toEqual(['ambiguous-local'])
    expect(store.getState().tabRegistry.reopenStack).toHaveLength(1)
  })

  it('keeps a restored tab when promotion rejects after committing and consumes only its saved entry', async () => {
    let serverSnapshot = inventory(8, [view('view-a', 0), view('view-b', 1)])
    const store = createStore(['view-a'], serverSnapshot)
    const secondView = serverSnapshot.viewIntents.find((entry) => entry.viewId === 'view-b')!
    store.dispatch(addTab({
      id: 'managed-tab-second',
      title: 'Second managed tab',
      mode: 'opencode',
      viewIntentId: 'view-b',
      viewIntentRevision: secondView.revision,
      soulIntentRevision: secondView.soulIntentRevision,
    }))
    store.dispatch(initLayout({
      tabId: 'managed-tab-second',
      paneId: 'managed-pane-second',
      content: managedContent(secondView),
    }))
    apiMocks.getManagedRuntimeInventory.mockImplementation(async () => serverSnapshot)
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (viewId: string, visibility: ManagedRuntimeViewIntent['visibility']) => {
      serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
      if (visibility === 'visible' && viewId === 'view-b') {
        throw new Error('response lost after server commit')
      }
      return serverSnapshot.viewIntents.find((entry) => entry.viewId === viewId)
    })
    await store.dispatch(closeTab('managed-tab'))
    await store.dispatch(closeTab('managed-tab-second'))
    expect(store.getState().tabRegistry.reopenStack.map((entry) => entry.tab.id)).toEqual([
      'managed-tab',
      'managed-tab-second',
    ])

    await store.dispatch(reopenClosedTab())

    expect(serverSnapshot.viewIntents.find((entry) => entry.viewId === 'view-b')?.visibility).toBe('visible')
    expect(store.getState().tabs.tabs).toHaveLength(1)
    const restoredTabId = store.getState().tabs.tabs[0]!.id
    const restored = store.getState().panes.layouts[restoredTabId]
    expect(restored && collectPaneContents(restored).some((content) => (
      content.kind === 'terminal' && content.viewIntentId === 'view-b'
    ))).toBe(true)
    expect(store.getState().tabRegistry.reopenStack.map((entry) => entry.tab.id)).toEqual(['managed-tab'])
    expect(buildManagedRuntimeMergePlan(serverSnapshot, store.getState() as any).creates
      .some((entry) => entry.viewId === 'view-b')).toBe(false)
  })

  it('detaches a removed split pane while keeping the surviving view visible', async () => {
    let serverSnapshot = inventory(8, [view('view-a', 0), view('view-b', 1)])
    const store = createStore(['view-a', 'view-b'], serverSnapshot)
    apiMocks.getManagedRuntimeInventory.mockImplementation(async () => serverSnapshot)
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (viewId: string, visibility: ManagedRuntimeViewIntent['visibility']) => {
      serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
      return serverSnapshot.viewIntents.find((entry) => entry.viewId === viewId)
    })

    await store.dispatch(closePaneWithCleanup({ tabId: 'managed-tab', paneId: 'managed-pane-0' }))

    expect(apiMocks.updateManagedRuntimeViewVisibility).toHaveBeenCalledTimes(1)
    expect(apiMocks.updateManagedRuntimeViewVisibility).toHaveBeenCalledWith('view-a', 'detached', 2, 5)
    expect(serverSnapshot.viewIntents.map((entry) => entry.visibility)).toEqual(['detached', 'visible'])
    expect(store.getState().tabs.tabs).toHaveLength(1)
  })

  it('keeps a pane when its managed view changes during inventory resolution with the same create request', async () => {
    const snapshot = inventory(8, [view('view-a', 0), view('view-b', 1)])
    const store = createStore(['view-a', 'view-b'], snapshot)
    const inventoryStarted = deferred<void>()
    const finishInventory = deferred<ManagedRuntimeInventorySnapshot>()
    apiMocks.getManagedRuntimeInventory.mockImplementation(() => {
      inventoryStarted.resolve()
      return finishInventory.promise
    })
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async () => {
      throw new Error('the changed pane must not detach the captured view')
    })

    const closing = store.dispatch(closePaneWithCleanup({ tabId: 'managed-tab', paneId: 'managed-pane-0' }))
    await inventoryStarted.promise
    store.dispatch(updatePaneContent({
      tabId: 'managed-tab',
      paneId: 'managed-pane-0',
      content: {
        ...managedContent(view('view-b', 1)),
        createRequestId: 'create-soul-view-a',
        terminalId: 'terminal-soul-view-a',
      },
    }))
    finishInventory.resolve(snapshot)
    await closing

    const layout = store.getState().panes.layouts['managed-tab']
    expect(layout).toBeDefined()
    expect(collectContent(layout!, 'managed-pane-0')?.viewIntentId).toBe('view-b')
    expect(apiMocks.updateManagedRuntimeViewVisibility).not.toHaveBeenCalled()
    expect(wsMock.sent.some((message: any) => message.type === 'pane.opened')).toBe(true)
  })

  it('keeps a tab when one pane changes managed view during inventory resolution with the same create request', async () => {
    const snapshot = inventory(8, [view('view-a', 0), view('view-b', 1)])
    const store = createStore(['view-a', 'view-b'], snapshot)
    const inventoryStarted = deferred<void>()
    const finishInventory = deferred<ManagedRuntimeInventorySnapshot>()
    apiMocks.getManagedRuntimeInventory.mockImplementation(() => {
      inventoryStarted.resolve()
      return finishInventory.promise
    })
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async () => {
      throw new Error('the changed tab must not detach the captured view')
    })

    const closing = store.dispatch(closeTab('managed-tab'))
    await inventoryStarted.promise
    store.dispatch(updatePaneContent({
      tabId: 'managed-tab',
      paneId: 'managed-pane-0',
      content: {
        ...managedContent(view('view-b', 1)),
        createRequestId: 'create-soul-view-a',
        terminalId: 'terminal-soul-view-a',
      },
    }))
    finishInventory.resolve(snapshot)
    await closing

    expect(store.getState().tabs.tabs.some((tab) => tab.id === 'managed-tab')).toBe(true)
    expect(collectContent(store.getState().panes.layouts['managed-tab']!, 'managed-pane-0')?.viewIntentId).toBe('view-b')
    expect(apiMocks.updateManagedRuntimeViewVisibility).not.toHaveBeenCalled()
  })

  it.each([
    ['terminal ID', { terminalId: 'terminal-soul-view-a', createRequestId: undefined }],
    ['create request ID', { terminalId: undefined, createRequestId: 'create-soul-view-a' }],
  ])('rechecks local representations by %s after recovery detach acquires the visibility queue', async (_label, identity) => {
    const snapshot = inventory(8, [view('view-a', 0)])
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        managedRuntime: managedRuntimeReducer,
        tabRegistry: tabRegistryReducer,
      },
    })
    store.dispatch(managedRuntimeSnapshotReceived({ snapshot, reconstructedViewCount: 0 }))
    apiMocks.getManagedRuntimeInventory.mockResolvedValue(snapshot)
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async () => {
      throw new Error('a newly local view must not be detached')
    })

    const queueStarted = deferred<void>()
    const releaseQueue = deferred<void>()
    const queuedTransition = withManagedVisibilityTransition(async () => {
      queueStarted.resolve()
      await releaseQueue.promise
    })
    await queueStarted.promise
    const detach = store.dispatch(detachManagedRuntimeView('view-a'))
    store.dispatch(addTab({
      id: 'projected-tab',
      title: 'Managed agents',
      mode: 'opencode',
    }))
    store.dispatch(initLayout({
      tabId: 'projected-tab',
      paneId: 'projected-pane',
      content: {
        kind: 'terminal',
        ...identity,
        status: 'running',
        mode: 'opencode',
      },
    }))
    releaseQueue.resolve()
    await queuedTransition
    const result = await detach

    expect(detachManagedRuntimeView.rejected.match(result)).toBe(true)
    expect(store.getState().tabs.tabs.some((tab) => tab.id === 'projected-tab')).toBe(true)
    expect(store.getState().panes.layouts['projected-tab']?.type).toBe('leaf')
    expect(apiMocks.updateManagedRuntimeViewVisibility).not.toHaveBeenCalled()
  })

  it('does not project a stale visible refresh while direct panel detach is being confirmed', async () => {
    let serverSnapshot = inventory(8, [view('view-a', 0)])
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        managedRuntime: managedRuntimeReducer,
        tabRegistry: tabRegistryReducer,
      },
    })
    store.dispatch(managedRuntimeSnapshotReceived({ snapshot: serverSnapshot, reconstructedViewCount: 0 }))
    const staleInventory = deferred<ManagedRuntimeInventorySnapshot>()
    const patchStarted = deferred<void>()
    const finishPatch = deferred<void>()
    let inventoryCalls = 0
    apiMocks.getManagedRuntimeInventory.mockImplementation(() => {
      inventoryCalls += 1
      if (inventoryCalls === 1) return staleInventory.promise
      return Promise.resolve(serverSnapshot)
    })
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (viewId: string, visibility: ManagedRuntimeViewIntent['visibility']) => {
      patchStarted.resolve()
      await finishPatch.promise
      serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
      return serverSnapshot.viewIntents.find((entry) => entry.viewId === viewId)
    })

    const refresh = queueManagedRuntimeRefresh(store as any, 'before-panel-detach')
    const detach = store.dispatch(detachManagedRuntimeView('view-a'))
    await patchStarted.promise
    staleInventory.resolve(inventory(8, [view('view-a', 0)]))
    await Promise.resolve()
    finishPatch.resolve()
    const detachResult = await detach
    await refresh

    expect(detachManagedRuntimeView.fulfilled.match(detachResult)).toBe(true)
    expect(store.getState().tabs.tabs).toHaveLength(0)
    expect(Object.keys(store.getState().panes.layouts)).toHaveLength(0)
    expect(serverSnapshot.viewIntents[0]?.visibility).toBe('detached')
    expect(wsMock.sent.some((message: any) => message.type === 'pane.closed')).toBe(false)
  })

  it('keeps a replacement when a legacy managed pane changes during inventory resolution', async () => {
    const snapshot = inventory(8, [view('view-a', 0), view('view-b', 1)])
    const seeded = createStore(['view-a', 'view-b'], snapshot)
    const legacyState = JSON.parse(JSON.stringify(seeded.getState())) as any
    const findTarget = (node: any): any => {
      if (node.type === 'leaf') return node.id === 'managed-pane-0' ? node : undefined
      return findTarget(node.children[0]) ?? findTarget(node.children[1])
    }
    delete findTarget(legacyState.panes.layouts['managed-tab']).content.createRequestId
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        managedRuntime: managedRuntimeReducer,
        tabRegistry: tabRegistryReducer,
      },
      preloadedState: legacyState,
    })
    const inventoryStarted = deferred<void>()
    const finishInventory = deferred<ManagedRuntimeInventorySnapshot>()
    let inventoryCalls = 0
    let serverSnapshot = snapshot
    apiMocks.getManagedRuntimeInventory.mockImplementation(() => {
      inventoryCalls += 1
      if (inventoryCalls === 1) {
        inventoryStarted.resolve()
        return finishInventory.promise
      }
      return Promise.resolve(serverSnapshot)
    })
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (viewId: string, visibility: ManagedRuntimeViewIntent['visibility']) => {
      serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
      return serverSnapshot.viewIntents.find((entry) => entry.viewId === viewId)
    })

    const closing = store.dispatch(closePaneWithCleanup({ tabId: 'managed-tab', paneId: 'managed-pane-0' }))
    await inventoryStarted.promise
    store.dispatch(updatePaneContent({
      tabId: 'managed-tab',
      paneId: 'managed-pane-0',
      content: { kind: 'picker' },
    }))
    finishInventory.resolve(snapshot)
    await closing

    const layout = store.getState().panes.layouts['managed-tab']
    expect(layout).toBeDefined()
    expect(collectContent(layout!, 'managed-pane-0')).toEqual({ kind: 'picker' })
    expect(apiMocks.updateManagedRuntimeViewVisibility).not.toHaveBeenCalled()
  })

  it('keeps a shared managed view visible while another pane still represents it', async () => {
    let serverSnapshot = inventory(8, [view('view-a', 0)])
    const store = createStore(['view-a', 'view-a'], serverSnapshot)
    apiMocks.getManagedRuntimeInventory.mockImplementation(async () => serverSnapshot)
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (viewId: string, visibility: ManagedRuntimeViewIntent['visibility']) => {
      serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
      return serverSnapshot.viewIntents[0]
    })

    await store.dispatch(closePaneWithCleanup({ tabId: 'managed-tab', paneId: 'managed-pane-0' }))

    expect(apiMocks.updateManagedRuntimeViewVisibility).not.toHaveBeenCalled()
    expect(serverSnapshot.viewIntents[0].visibility).toBe('visible')
  })

  it('detaches the managed view discarded by replace-pane', async () => {
    let serverSnapshot = inventory(8, [view('view-a', 0), view('view-b', 1)])
    const store = createStore(['view-a', 'view-b'], serverSnapshot)
    apiMocks.getManagedRuntimeInventory.mockImplementation(async () => serverSnapshot)
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (viewId: string, visibility: ManagedRuntimeViewIntent['visibility']) => {
      serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
      return serverSnapshot.viewIntents.find((entry) => entry.viewId === viewId)
    })

    await store.dispatch(replacePaneWithCleanup({ tabId: 'managed-tab', paneId: 'managed-pane-0' }))

    expect(apiMocks.updateManagedRuntimeViewVisibility).toHaveBeenCalledTimes(1)
    expect(apiMocks.updateManagedRuntimeViewVisibility).toHaveBeenCalledWith('view-a', 'detached', 2, 5)
    expect(serverSnapshot.viewIntents.map((entry) => entry.visibility)).toEqual(['detached', 'visible'])
    const layout = store.getState().panes.layouts['managed-tab']
    expect(layout && collectContent(layout, 'managed-pane-0')?.kind).toBe('picker')

    await store.dispatch(closeTab('managed-tab'))
    expect(serverSnapshot.viewIntents.map((entry) => entry.visibility)).toEqual(['detached', 'detached'])
    await store.dispatch(reopenClosedTab())
    expect(serverSnapshot.viewIntents.map((entry) => entry.visibility)).toEqual(['detached', 'visible'])
    expect(buildManagedRuntimeMergePlan(serverSnapshot, store.getState() as any).creates).toHaveLength(0)
  })

  it('does not let a close race a reopened view visibility promotion', async () => {
    let serverSnapshot = inventory(10, [{ ...view('view-a', 0), visibility: 'detached', revision: 3 }])
    const store = createStore(['view-a'], serverSnapshot)
    apiMocks.getManagedRuntimeInventory.mockImplementation(async () => serverSnapshot)
    const patchStarted = deferred<void>()
    const finishPatch = deferred<void>()
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (viewId: string, visibility: ManagedRuntimeViewIntent['visibility']) => {
      patchStarted.resolve()
      await finishPatch.promise
      serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
      return serverSnapshot.viewIntents[0]
    })
    await store.dispatch(closeTab('managed-tab'))

    const reopened = store.dispatch(reopenClosedTab())
    await patchStarted.promise
    const reopenedTabId = store.getState().tabs.tabs[0]?.id
    expect(reopenedTabId).toBeTruthy()
    const closeDuringPromotion = store.dispatch(closeTab(reopenedTabId!))
    expect(store.getState().tabs.tabs).toHaveLength(1)
    expect(apiMocks.updateManagedRuntimeViewVisibility).toHaveBeenCalledTimes(1)

    finishPatch.resolve()
    await Promise.all([reopened, closeDuringPromotion])

    expect(store.getState().tabs.tabs).toHaveLength(0)
    expect(serverSnapshot.viewIntents[0].visibility).toBe('detached')
    expect(apiMocks.updateManagedRuntimeViewVisibility).toHaveBeenCalledTimes(2)
  })

  it('serializes simultaneous reopens so each request consumes a different closed entry', async () => {
    const views = [view('view-a', 0), view('view-b', 1)]
    let serverSnapshot = inventory(8, views)
    const store = createStore(['view-a'], serverSnapshot)
    store.dispatch(addTab({
      id: 'managed-tab-second',
      title: 'Second managed tab',
      mode: 'opencode',
      viewIntentId: 'view-b',
      viewIntentRevision: 2,
      soulIntentRevision: 5,
    }))
    store.dispatch(initLayout({
      tabId: 'managed-tab-second',
      paneId: 'managed-pane-second',
      content: managedContent(views[1]),
    }))
    apiMocks.getManagedRuntimeInventory.mockImplementation(async () => serverSnapshot)
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (viewId: string, visibility: ManagedRuntimeViewIntent['visibility']) => {
      serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
      return serverSnapshot.viewIntents.find((entry) => entry.viewId === viewId)
    })
    await store.dispatch(closeTab('managed-tab'))
    await store.dispatch(closeTab('managed-tab-second'))
    expect(store.getState().tabRegistry.reopenStack).toHaveLength(2)

    const preflight = deferred<ManagedRuntimeInventorySnapshot>()
    const preflightStarted = deferred<void>()
    let inventoryCalls = 0
    apiMocks.getManagedRuntimeInventory.mockImplementation(() => {
      inventoryCalls += 1
      if (inventoryCalls === 1) {
        preflightStarted.resolve()
        return preflight.promise
      }
      return Promise.resolve(serverSnapshot)
    })
    const firstReopen = store.dispatch(reopenClosedTab())
    await preflightStarted.promise
    const secondReopen = store.dispatch(reopenClosedTab())
    expect(store.getState().tabs.tabs).toHaveLength(0)

    preflight.resolve(serverSnapshot)
    await Promise.all([firstReopen, secondReopen])

    expect(store.getState().tabRegistry.reopenStack).toHaveLength(0)
    expect(store.getState().tabs.tabs).toHaveLength(2)
    const reopenedViews = store.getState().tabs.tabs.map((tab) => {
      const layout = store.getState().panes.layouts[tab.id]
      return layout?.type === 'leaf' && layout.content.kind === 'terminal'
        ? layout.content.viewIntentId
        : undefined
    }).sort()
    expect(reopenedViews).toEqual(['view-a', 'view-b'])
  })

  it('detaches a shared view when concurrent closes remove its last representations', async () => {
    let serverSnapshot = inventory(8, [view('view-a', 0)])
    const store = createStore(['view-a'], serverSnapshot)
    store.dispatch(addTab({
      id: 'managed-tab-second',
      title: 'Second managed tab',
      mode: 'opencode',
      viewIntentId: 'view-a',
      viewIntentRevision: 2,
      soulIntentRevision: 5,
    }))
    store.dispatch(initLayout({
      tabId: 'managed-tab-second',
      paneId: 'managed-pane-second',
      content: managedContent(view('view-a', 1)),
    }))
    apiMocks.getManagedRuntimeInventory.mockImplementation(async () => serverSnapshot)
    apiMocks.updateManagedRuntimeViewVisibility.mockImplementation(async (viewId: string, visibility: ManagedRuntimeViewIntent['visibility']) => {
      serverSnapshot = withVisibility(serverSnapshot, viewId, visibility)
      return serverSnapshot.viewIntents[0]
    })

    await Promise.all([
      store.dispatch(closeTab('managed-tab')),
      store.dispatch(closeTab('managed-tab-second')),
    ])

    expect(store.getState().tabs.tabs).toHaveLength(0)
    expect(serverSnapshot.viewIntents[0].visibility).toBe('detached')
    expect(apiMocks.updateManagedRuntimeViewVisibility).toHaveBeenCalledTimes(1)
  })
})

function collectContent(node: { type: 'leaf'; id: string; content: unknown } | { type: 'split'; children: [any, any] }, paneId: string): any {
  if (node.type === 'leaf') return node.id === paneId ? node.content : undefined
  return collectContent(node.children[0], paneId) ?? collectContent(node.children[1], paneId)
}
