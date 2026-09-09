import { configureStore } from '@reduxjs/toolkit'
import { describe, expect, it } from 'vitest'
import tabsReducer, { addTab, setActiveTab, updateTab } from '@/store/tabsSlice'
import { handleUiCommand } from '@/lib/ui-commands'
import panesReducer from '@/store/panesSlice'
import managedRuntimeReducer from '@/store/managedRuntimeSlice'
import {
  applyManagedRuntimeMergePlan,
  buildManagedRuntimeMergePlan,
} from '@/lib/recovery/managed-runtime-recovery'
import type {
  ManagedRuntimeInventorySnapshot,
  ManagedRuntimeSoul,
  ManagedRuntimeViewIntent,
} from '@shared/managed-runtime'

function soul(overrides: Partial<ManagedRuntimeSoul> = {}): ManagedRuntimeSoul {
  return {
    soulId: 'soul-one',
    incarnationId: 'incarnation-one',
    launchState: 'running',
    cleanupState: 'none',
    intentRevision: 3,
    executionGeneration: 1,
    effectiveLimits: { cpuMilli: 500, memoryBytes: 134_217_728, swapBytes: 0, pidsMax: 64 },
    configuredLimits: { cpuMilli: 500, memoryBytes: 134_217_728, swapBytes: 0, pidsMax: 64 },
    terminalId: 'terminal-one',
    terminalStreamId: 'stream-one',
    terminalMode: 'opencode',
    terminalCwd: '/workspace',
    terminalCreateRequestId: 'create-one',
    terminalResumeSessionId: 'ses_one',
    projectKey: 'workspace-one',
    profile: 'default_agent',
    desiredState: 'running',
    recoveryState: 'live',
    durabilityState: 'resume_captured',
    allocationState: 'verified_durable',
    provider: 'opencode',
    nativeSessionId: 'ses_one',
    evidenceRevision: 2,
    successfulRecoveriesInWindow: 1,
    ...overrides,
  }
}

function view(overrides: Partial<ManagedRuntimeViewIntent> = {}): ManagedRuntimeViewIntent {
  return {
    viewId: 'view-one',
    soulId: 'soul-one',
    ownerId: 'installation-one',
    workspaceId: 'workspace-one',
    kind: 'automatic_primary',
    preferredTabId: 'tab-recovered-one',
    preferredPaneId: 'pane-recovered-one',
    title: 'Recovered OpenCode agent',
    placementGroup: 'Recovered agents',
    visibility: 'visible',
    revision: 2,
    soulIntentRevision: 3,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

function snapshot(
  souls: ManagedRuntimeSoul[] = [soul()],
  viewIntents: ManagedRuntimeViewIntent[] = [view()],
): ManagedRuntimeInventorySnapshot {
  return {
    revision: 9,
    readiness: {
      inventoryRevision: 9,
      initialScanState: 'complete',
      initialScanStartedAt: 1,
      initialScanFinishedAt: 4,
      blockedSubsystems: [],
      startupRecoveryConcurrencyLimit: 4,
      startupRecoveryPeak: 2,
      initialScanDurationMs: 3,
    },
    souls,
    viewIntents,
    pendingProjectionCount: 0,
  }
}

function baseState() {
  return {
    tabs: {
      tabs: [{
        id: 'user-tab',
        createRequestId: 'user-tab',
        title: 'My layout',
        status: 'running',
        mode: 'shell',
        shell: 'system',
        createdAt: 1,
        updatedAt: 1,
      }],
      activeTabId: 'user-tab',
      renameRequestTabId: null,
      tombstones: [],
    },
    panes: {
      layouts: {
        'user-tab': {
          type: 'leaf',
          id: 'user-pane',
          content: {
            kind: 'terminal',
            createRequestId: 'user-pane',
            status: 'running',
            mode: 'shell',
            shell: 'system',
          },
        },
      },
      activePane: { 'user-tab': 'user-pane' },
      paneTitles: { 'user-tab': { 'user-pane': 'Shell' } },
      paneTitleSetByUser: {},
      renameRequestTabId: null,
      renameRequestPaneId: null,
      zoomedPane: {},
      closingTabs: {},
      closingPanes: {},
      refreshRequests: {},
      restoreFallbackAttemptsByPane: {},
      deadSessionAdjudication: [],
      reconcilePendingPanes: {},
    },
    managedRuntime: {
      available: true,
      status: 'idle',
      revision: 0,
      souls: [],
      viewIntents: [],
      pendingProjectionCount: 0,
      reconstructedViewCount: 0,
    },
  } as any
}

function storeWithState(state = baseState()) {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      managedRuntime: managedRuntimeReducer,
    },
    preloadedState: state,
  })
}

describe('managed runtime recovery merge', () => {
  it.each(['inventory-first', 'api-first'] as const)('coalesces one REST-created managed view when %s wins the race', (order) => {
    const store = storeWithState()
    const current = snapshot()
    const command = { type: 'ui.command', command: 'tab.create', payload: {
      id: 'tab-recovered-one', paneId: 'pane-recovered-one', title: 'Created shell',
      terminalId: 'terminal-one', mode: 'opencode',
      paneContent: { kind: 'terminal', terminalId: 'terminal-one', createRequestId: 'create-one',
        status: 'running', mode: 'opencode', shell: 'system' },
    } }
    const commandRuntime = { dispatch: store.dispatch, getState: () => store.getState() as any }
    const reconcile = () => applyManagedRuntimeMergePlan(store as any, buildManagedRuntimeMergePlan(current, store.getState() as any))
    if (order === 'inventory-first') { reconcile(); handleUiCommand(command, commandRuntime) }
    else { handleUiCommand(command, commandRuntime); reconcile() }
    expect(store.getState().tabs.tabs.map((tab) => tab.id)).toEqual(['user-tab', 'tab-recovered-one'])
    expect(Object.keys(store.getState().panes.layouts)).toHaveLength(2)
    const recovered = store.getState().panes.layouts['tab-recovered-one']
    expect(recovered.type).toBe('leaf')
    if (recovered.type !== 'leaf') throw new Error('expected recovered leaf')
    expect(recovered.id).toBe('pane-recovered-one')
    expect(recovered.content).toMatchObject({ terminalId: 'terminal-one', soulId: 'soul-one', viewIntentId: 'view-one' })
    // Redelivery after a user changes focus/title is not a new create intent.
    store.dispatch(updateTab({ id: 'tab-recovered-one', updates: { title: 'My retained title', titleSetByUser: true } }))
    store.dispatch(setActiveTab('user-tab'))
    for (let replay = 0; replay < 4; replay += 1) { handleUiCommand(command, commandRuntime); reconcile() }
    expect(store.getState().tabs.tabs).toHaveLength(2)
    expect(store.getState().tabs.activeTabId).toBe('user-tab')
    expect(store.getState().tabs.tabs[1].title).toBe('My retained title')
    expect(store.getState().panes.layouts['tab-recovered-one']).toEqual(recovered)
  })

  it('makes explicit tab identity idempotent without suppressing genuinely new tabs', () => {
    const store = storeWithState()
    const original = structuredClone(store.getState().tabs.tabs[0])
    store.dispatch(addTab({ id: 'user-tab', title: 'duplicate must not replace title', activate: true }))
    expect(store.getState().tabs.tabs).toEqual([original])
    store.dispatch(addTab({ title: 'Fresh one' }))
    store.dispatch(addTab({ title: 'Fresh two' }))
    expect(store.getState().tabs.tabs).toHaveLength(3)
    expect(new Set(store.getState().tabs.tabs.map((tab) => tab.id)).size).toBe(3)
  })

  it('adopts a pane whose managed terminal is still being created', () => {
    // The originating pane knows its createRequestId long before the server
    // answers with a terminalId. Matching only on terminalId/soulId therefore
    // misses it for the whole create round trip, and the reconciler
    // manufactures a SECOND view of the same soul — a duplicate tab over one
    // writer. The create request id is the stable identity across that window.
    const state = baseState()
    state.panes.layouts['user-tab'].content = {
      kind: 'terminal',
      createRequestId: 'create-one',
      status: 'creating',
      mode: 'opencode',
    }
    const plan = buildManagedRuntimeMergePlan(snapshot(), state)
    expect(plan.creates).toHaveLength(0)
    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0]).toMatchObject({ tabId: 'user-tab', paneId: 'user-pane' })
  })

  it('never erases local pane truth with an unset field from a partial projection', () => {
    // A supervisor projection is partial while a soul is still materialising.
    // Spreading it wholesale writes `terminalId: undefined` over the pane's
    // real terminal id, which silently detaches the pane from its own output
    // and stops the session ref from ever being stamped.
    const state = baseState()
    state.panes.layouts['user-tab'].content = {
      kind: 'terminal',
      createRequestId: 'create-one',
      terminalId: 'terminal-real',
      streamId: 'stream-real',
      status: 'running',
      mode: 'opencode',
      sessionRef: { provider: 'opencode', sessionId: 'ses_real' },
      initialCwd: '/workspace/real',
    }
    const partial = soul({
      terminalId: undefined,
      terminalStreamId: undefined,
      nativeSessionId: undefined,
      terminalCwd: undefined,
    })
    const plan = buildManagedRuntimeMergePlan(snapshot([partial]), state)
    expect(plan.updates).toHaveLength(1)
    const content: any = plan.updates[0].content
    expect(content.terminalId).toBe('terminal-real')
    expect(content.streamId).toBe('stream-real')
    expect(content.sessionRef).toEqual({ provider: 'opencode', sessionId: 'ses_real' })
    expect(content.initialCwd).toBe('/workspace/real')
  })

  it('does not adopt an unrelated pane that merely lacks a terminal id', () => {
    const state = baseState()
    state.panes.layouts['user-tab'].content = {
      kind: 'terminal',
      createRequestId: 'some-other-create',
      status: 'creating',
      mode: 'shell',
    }
    const plan = buildManagedRuntimeMergePlan(snapshot(), state)
    expect(plan.creates).toHaveLength(1)
    expect(plan.updates).toHaveLength(0)
  })

  it('adds a missing recovered view without replacing layout or stealing focus', () => {
    const store = storeWithState()
    const plan = buildManagedRuntimeMergePlan(snapshot(), store.getState() as any)
    expect(plan.creates).toHaveLength(1)
    expect(plan.updates).toHaveLength(0)

    applyManagedRuntimeMergePlan(store as any, plan)
    const state = store.getState()
    expect(state.tabs.activeTabId).toBe('user-tab')
    expect(state.panes.layouts['user-tab']).toEqual(baseState().panes.layouts['user-tab'])
    expect(state.tabs.tabs.map((tab) => tab.id)).toEqual(['user-tab', 'tab-recovered-one'])
    const recovered = state.panes.layouts['tab-recovered-one']
    expect(recovered.type).toBe('leaf')
    if (recovered.type !== 'leaf') throw new Error('expected recovered leaf')
    expect(recovered.id).toBe('pane-recovered-one')
    expect(recovered.content).toMatchObject({
      kind: 'terminal',
      terminalId: 'terminal-one',
      soulId: 'soul-one',
      viewIntentId: 'view-one',
      sessionRef: { provider: 'opencode', sessionId: 'ses_one' },
    })

    const replay = buildManagedRuntimeMergePlan(snapshot(), state as any)
    expect(replay.creates).toHaveLength(0)
    expect(replay.updates).toHaveLength(1)
  })

  it('adopts a matching saved session pane in place', () => {
    const state = baseState()
    state.tabs.tabs[0].mode = 'opencode'
    state.panes.layouts['user-tab'].content = {
      kind: 'terminal',
      createRequestId: 'old-create',
      status: 'creating',
      mode: 'opencode',
      shell: 'system',
      sessionRef: { provider: 'opencode', sessionId: 'ses_one' },
    }
    const plan = buildManagedRuntimeMergePlan(snapshot(), state)
    expect(plan.creates).toHaveLength(0)
    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0]).toMatchObject({ tabId: 'user-tab', paneId: 'user-pane' })
    expect(plan.updates[0].content).toMatchObject({
      terminalId: 'terminal-one',
      soulId: 'soul-one',
      status: 'running',
    })
  })

  it('keeps two explicit views over one soul as two deterministic panes', () => {
    const state = baseState()
    const views = [
      view({
        viewId: 'view-explicit-a',
        kind: 'explicit',
        preferredTabId: 'tab-explicit-a',
        preferredPaneId: 'pane-explicit-a',
      }),
      view({
        viewId: 'view-explicit-b',
        kind: 'explicit',
        preferredTabId: 'tab-explicit-b',
        preferredPaneId: 'pane-explicit-b',
      }),
    ]
    const plan = buildManagedRuntimeMergePlan(snapshot([soul()], views), state)
    expect(plan.creates.map((entry) => entry.tabId)).toEqual([
      'tab-explicit-a',
      'tab-explicit-b',
    ])
    expect(plan.creates.every((entry) => entry.content.soulId === 'soul-one')).toBe(true)
    expect(new Set(plan.creates.map((entry) => entry.content.terminalId))).toEqual(
      new Set(['terminal-one']),
    )
  })

  it('projects blocked recovery honestly instead of substituting a fresh session', () => {
    const blocked = soul({
      launchState: 'stopped',
      recoveryState: 'blocked',
      recoveryReason: 'CREDENTIALS_EXPIRED',
      containerId: undefined,
    })
    const plan = buildManagedRuntimeMergePlan(snapshot([blocked]), baseState())
    expect(plan.creates[0].content).toMatchObject({
      status: 'recovering',
      soulId: 'soul-one',
      sessionRef: { provider: 'opencode', sessionId: 'ses_one' },
      recoverySummary: {
        recoveryState: 'blocked',
        reason: 'CREDENTIALS_EXPIRED',
      },
    })
  })
})
