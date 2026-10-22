import { configureStore } from '@reduxjs/toolkit'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The session-link step below rides the real association fold, which also
// asks the server for the newly linked session's record; the test feeds that
// record itself, so the read answers nothing.
vi.mock('@/lib/session-names', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session-names')>()),
  bootstrapSessionNames: vi.fn(async () => []),
}))

import tabsReducer, { addTab, setActiveTab, updateTab } from '@/store/tabsSlice'
import { handleUiCommand } from '@/lib/ui-commands'
import panesReducer, { startNewManagedRuntimeConversation, updatePaneContent } from '@/store/panesSlice'
import managedRuntimeReducer from '@/store/managedRuntimeSlice'
import sessionNamesReducer, { receiveSessionNames } from '@/store/sessionNamesSlice'
import sessionActivityReducer from '@/store/sessionActivitySlice'
import { savedNameTabTitleMirrorMiddleware } from '@/store/savedNameTabTitleMirror'
import { sessionNameLifecycleMiddleware } from '@/store/sessionNameLifecycleMiddleware'
import { selectTabDisplayName } from '@/store/selectors/sessionNameSelectors'
import { reconcileTerminalSessionAssociation } from '@/lib/terminal-session-association'
import { getTabDisplayTitle } from '@/lib/tab-title'
import { deriveTabName } from '@/lib/deriveTabName'
import {
  applyManagedRuntimeMergePlan,
  buildManagedRuntimeMergePlan,
} from '@/lib/recovery/managed-runtime-recovery'
import type {
  ManagedRuntimeInventorySnapshot,
  ManagedRuntimeSoul,
  ManagedRuntimeViewIntent,
} from '@shared/managed-runtime'
import type { PaneNode } from '@/store/paneTypes'
import type { Tab } from '@/store/types'
import type { SessionNameRef } from '@shared/session-names'

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

  it('clears a stale typed launch failure when the supervisor reports the managed terminal live', () => {
    const state = baseState()
    state.panes.layouts['user-tab'].content = {
      kind: 'terminal',
      createRequestId: 'create-one',
      terminalId: 'terminal-one',
      streamId: 'stream-one',
      status: 'error',
      mode: 'opencode',
      shell: 'system',
      soulId: 'soul-one',
      launchFailure: { code: 'LAUNCH_FAILED', message: 'Previous create attempt failed', retryable: true },
    }
    const store = storeWithState(state)
    const liveSnapshot = snapshot([soul({ launchState: 'running', recoveryState: 'live' })])
    const plan = buildManagedRuntimeMergePlan(liveSnapshot, store.getState() as any)

    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0].content).toMatchObject({
      status: 'running',
      runtimeStatus: 'running',
      recoverySummary: { recoveryState: 'live' },
    })
    expect((plan.updates[0].content as any).launchFailure).toBeUndefined()

    applyManagedRuntimeMergePlan(store as any, plan)
    const content = (store.getState().panes.layouts['user-tab'] as any).content
    expect(content.status).toBe('running')
    expect(content.launchFailure).toBeUndefined()
  })

  it('preserves the live host stream epoch when a same-terminal inventory refresh arrives', () => {
    const state = baseState()
    state.panes.layouts['user-tab'].content = {
      kind: 'terminal',
      createRequestId: 'create-one',
      terminalId: 'terminal-one',
      streamId: 'stream-one-hostboot-replacement',
      status: 'running',
      mode: 'opencode',
      shell: 'system',
      soulId: 'soul-one',
      viewIntentId: 'view-one',
      incarnationId: 'incarnation-replacement',
    }
    const staleLaunchIdentity = soul({ incarnationId: 'incarnation-replacement' })

    const plan = buildManagedRuntimeMergePlan(snapshot([staleLaunchIdentity]), state)

    expect(plan.updates).toHaveLength(1)
    expect((plan.updates[0].content as any).streamId).toBe('stream-one-hostboot-replacement')
  })

  it('takes the projected stream ID when the pane is rebound to a different terminal', () => {
    const state = baseState()
    state.panes.layouts['user-tab'].content = {
      kind: 'terminal',
      createRequestId: 'create-one',
      terminalId: 'terminal-old',
      streamId: 'stream-old-hostboot',
      status: 'running',
      mode: 'opencode',
      shell: 'system',
      soulId: 'soul-one',
      viewIntentId: 'view-one',
    }

    const plan = buildManagedRuntimeMergePlan(snapshot(), state)

    expect(plan.updates).toHaveLength(1)
    expect((plan.updates[0].content as any).terminalId).toBe('terminal-one')
    expect((plan.updates[0].content as any).streamId).toBe('stream-one')
  })

  it('rekeys an offline fresh-agent view to the supervisor current native branch after provider fork', () => {
    const state = baseState()
    state.tabs.tabs[0].mode = 'freshcodex'
    state.panes.layouts['user-tab'].content = {
      kind: 'fresh-agent',
      createRequestId: 'view-create-parent',
      status: 'connected',
      sessionType: 'freshcodex',
      provider: 'codex',
      sessionId: 'native-parent',
      resumeSessionId: 'native-parent',
      sessionRef: { provider: 'codex', sessionId: 'native-parent' },
      soulId: 'soul-one',
      viewIntentId: 'view-one',
      incarnationId: 'incarnation-one',
    }
    const forked = soul({
      provider: 'codex',
      nativeSessionId: 'native-child',
      terminalId: undefined,
      terminalStreamId: undefined,
      terminalMode: undefined,
      terminalCwd: undefined,
      terminalCreateRequestId: undefined,
      terminalResumeSessionId: undefined,
      freshAgentSessionId: 'native-child',
      freshAgentSessionType: 'freshcodex',
      freshAgentRuntimeVariant: 'codex-app-server',
    })
    const plan = buildManagedRuntimeMergePlan(snapshot([forked]), state)
    expect(plan.creates).toHaveLength(0)
    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0].content).toMatchObject({
      kind: 'fresh-agent',
      createRequestId: 'view-create-parent',
      sessionId: 'native-child',
      resumeSessionId: 'native-child',
      sessionRef: { provider: 'codex', sessionId: 'native-child' },
      soulId: 'soul-one',
      viewIntentId: 'view-one',
    })
  })

  it('binds the newly launched Fresh Agent after start-new before native identity arrives', () => {
    const state = baseState()
    state.tabs.tabs[0].mode = 'freshcodex'
    state.panes.layouts['user-tab'].content = {
      kind: 'fresh-agent', createRequestId: 'old-create', status: 'error',
      sessionType: 'freshcodex', provider: 'codex', sessionId: 'old-native',
      sessionRef: { provider: 'codex', sessionId: 'old-native' },
      soulId: 'old-soul', viewIntentId: 'old-view',
    }
    const store = storeWithState(state)
    store.dispatch(startNewManagedRuntimeConversation({ tabId: 'user-tab', paneId: 'user-pane' }))
    const restarted = store.getState().panes.layouts['user-tab'].content
    store.dispatch(updatePaneContent({ tabId: 'user-tab', paneId: 'user-pane', content: {
      ...restarted, sessionId: 'fresh-runtime-id', status: 'connected',
    } }))
    const inventory = snapshot([soul({
      provider: 'codex', nativeSessionId: undefined, freshAgentSessionId: 'fresh-runtime-id',
      freshAgentSessionType: 'freshcodex', terminalId: undefined,
      terminalCreateRequestId: undefined, terminalMode: undefined,
    })])
    const plan = buildManagedRuntimeMergePlan(inventory, store.getState() as any)
    expect(plan.creates).toHaveLength(0)
    expect(plan.updates).toHaveLength(1)
    applyManagedRuntimeMergePlan(store as any, plan)
    expect(store.getState().tabs.tabs).toHaveLength(1)
    expect(store.getState().panes.layouts['user-tab'].content).toMatchObject({
      kind: 'fresh-agent', createRequestId: restarted.createRequestId,
      sessionId: 'fresh-runtime-id', soulId: 'soul-one', viewIntentId: 'view-one',
    })
    expect(store.getState().panes.layouts['user-tab'].content.sessionRef).toBeUndefined()
  })

  it.each(['freshclaude', 'kilroy', 'freshcodex', 'freshopencode'] as const)('adopts native-free %s through its runtime session identity', (sessionType) => {
    const provider = sessionType === 'freshcodex' ? 'codex' : sessionType === 'freshopencode' ? 'opencode' : 'claude'
    const state = baseState()
    state.panes.layouts['user-tab'].content = {
      kind: 'fresh-agent', createRequestId: 'pending-create', status: 'connected',
      sessionType, provider, sessionId: 'runtime-pending',
    }
    const plan = buildManagedRuntimeMergePlan(snapshot([soul({
      provider: sessionType === 'kilroy' ? 'kilroy' : provider,
      nativeSessionId: undefined, terminalId: undefined, terminalCreateRequestId: undefined,
      freshAgentSessionId: 'runtime-pending', freshAgentSessionType: sessionType,
    })]), state)
    expect(plan.creates).toHaveLength(0)
    expect(plan.updates[0].content).toMatchObject({ kind: 'fresh-agent', provider, sessionType, sessionId: 'runtime-pending', soulId: 'soul-one' })
    expect(plan.updates[0].content.sessionRef).toBeUndefined()
  })

  it('preserves the public Claude identity when a Kilroy native session becomes available', () => {
    const state = baseState()
    const nativeSessionId = 'd4430000-0000-4444-8444-000000000093'
    state.panes.layouts['user-tab'].content = { kind: 'fresh-agent', createRequestId: 'kilroy-create', status: 'connected',
      sessionType: 'kilroy', provider: 'claude', sessionId: 'kilroy-runtime',
    }
    const plan = buildManagedRuntimeMergePlan(snapshot([soul({
      provider: 'kilroy', nativeSessionId, terminalId: undefined, terminalCreateRequestId: undefined,
      freshAgentSessionId: 'kilroy-runtime', freshAgentSessionType: 'kilroy',
    })]), state)
    expect(plan.creates).toHaveLength(0)
    expect(plan.updates[0].content).toMatchObject({ kind: 'fresh-agent', provider: 'claude', sessionType: 'kilroy',
      sessionId: nativeSessionId, sessionRef: { provider: 'claude', sessionId: nativeSessionId },
    })
    applyManagedRuntimeMergePlan(storeWithState(state) as any, plan)
  })

  it.each(['provider', 'sessionType', 'createRequestId'] as const)('never binds a pending Fresh launch with mismatched %s', (mismatch) => {
    const state = baseState()
    state.panes.layouts['user-tab'].content = { kind: 'fresh-agent', createRequestId: 'pending-create', status: 'creating',
      sessionType: 'freshcodex', provider: 'codex',
    }
    const plan = buildManagedRuntimeMergePlan(snapshot([soul({
      provider: mismatch === 'provider' ? 'opencode' : 'codex', nativeSessionId: undefined,
      terminalId: undefined, terminalCreateRequestId: undefined, freshAgentSessionId: 'runtime-pending',
      freshAgentSessionType: mismatch === 'sessionType' ? 'freshopencode' : 'freshcodex',
      freshAgentCreateRequestId: mismatch === 'createRequestId' ? 'different-create' : 'pending-create',
    })]), state)
    expect(plan.updates).toHaveLength(0)
    expect(plan.creates).toHaveLength(1)
  })

  it.each(['create', 'view'] as const)('prefers the originating Fresh %s identity over an earlier pane sharing its session', (identity) => {
    const state = baseState()
    const content = { kind: 'fresh-agent', status: 'connected', sessionType: 'freshcodex', provider: 'codex', sessionId: 'shared-runtime' }
    state.panes.layouts['user-tab'] = { type: 'split', id: 'split-root', direction: 'horizontal', sizes: [50, 50], children: [
      { type: 'leaf', id: 'other-pane', content: { ...content, createRequestId: 'other-create' } },
      { type: 'leaf', id: 'origin-pane', content: { ...content, createRequestId: 'origin-create',
        ...(identity === 'view' ? { viewIntentId: 'view-one' } : {}) } },
    ] }
    const inventory = snapshot([soul({ provider: 'codex', nativeSessionId: undefined, terminalId: undefined,
      terminalCreateRequestId: undefined, freshAgentSessionId: 'shared-runtime', freshAgentSessionType: 'freshcodex',
      freshAgentCreateRequestId: identity === 'create' ? 'origin-create' : 'other-create',
      recoveryState: 'lost', desiredState: 'stopped', recoveryReason: 'provider_state_missing',
    })])
    const store = storeWithState(state)
    const plan = buildManagedRuntimeMergePlan(inventory, store.getState() as any)
    expect(plan.creates).toHaveLength(0)
    expect(plan.updates.map((update) => update.paneId)).toEqual(['origin-pane'])
    applyManagedRuntimeMergePlan(store as any, plan)
    const panes = store.getState().panes.layouts['user-tab'].children
    expect(panes[0].content.recoverySummary).toBeUndefined()
    expect(panes[1].content).toMatchObject({ createRequestId: 'origin-create', viewIntentId: 'view-one',
      recoverySummary: { recoveryState: 'lost', desiredState: 'stopped' } })
  })

  it.each([true, false])('preserves an explicit Fresh view sharing the automatic view creation seed (origin present: %s)', (originPresent) => {
    const state = baseState()
    const content = { kind: 'fresh-agent', createRequestId: 'source-create', status: 'connected',
      sessionType: 'freshcodex', provider: 'codex', sessionId: 'shared-runtime', soulId: 'soul-one' }
    const explicitPane = { type: 'leaf', id: 'explicit-pane', content: { ...content, viewIntentId: 'z-explicit' } }
    state.panes.layouts['user-tab'] = originPresent
      ? { type: 'split', id: 'split-root', direction: 'horizontal', sizes: [50, 50], children: [explicitPane,
        { type: 'leaf', id: 'origin-pane', content: { ...content, createRequestId: 'reminted-create', viewIntentId: 'a-automatic' } }] }
      : explicitPane
    const inventory = snapshot([soul({ provider: 'codex', nativeSessionId: undefined, terminalId: undefined,
      terminalCreateRequestId: undefined, freshAgentSessionId: 'shared-runtime', freshAgentSessionType: 'freshcodex',
      freshAgentCreateRequestId: 'source-create',
    })], [view({ viewId: 'a-automatic' }), view({ viewId: 'z-explicit', kind: 'explicit' })])
    const plan = buildManagedRuntimeMergePlan(inventory, state)
    expect(plan.updates.find((update) => update.content.viewIntentId === 'z-explicit')?.paneId).toBe('explicit-pane')
    if (originPresent) {
      expect(plan.creates).toHaveLength(0)
      expect(plan.updates.find((update) => update.content.viewIntentId === 'a-automatic')?.paneId).toBe('origin-pane')
    } else {
      expect(plan.updates).toHaveLength(1)
      expect(plan.creates.map((create) => create.content.viewIntentId)).toEqual(['a-automatic'])
    }
    const store = storeWithState(state)
    applyManagedRuntimeMergePlan(store as any, plan)
    expect(buildManagedRuntimeMergePlan(inventory, store.getState() as any).creates).toHaveLength(0)
  })

  it('adopts a restored Fresh pane through native identity when its local create key was reminted', () => {
    const state = baseState()
    state.panes.layouts['user-tab'].content = { kind: 'fresh-agent', createRequestId: 'restored-local-create',
      status: 'connected', sessionType: 'freshcodex', provider: 'codex', sessionId: 'native-one',
      sessionRef: { provider: 'codex', sessionId: 'native-one' } }
    const plan = buildManagedRuntimeMergePlan(snapshot([soul({ provider: 'codex', nativeSessionId: 'native-one',
      terminalId: undefined, terminalCreateRequestId: undefined, freshAgentSessionId: 'runtime-one',
      freshAgentSessionType: 'freshcodex', freshAgentCreateRequestId: 'original-server-create',
    })]), state)
    expect(plan.creates).toHaveLength(0)
    expect(plan.updates[0]).toMatchObject({ paneId: 'user-pane', content: { kind: 'fresh-agent',
      createRequestId: 'restored-local-create', viewIntentId: 'view-one' } })
  })

  it.each(['ack-first', 'inventory-first'] as const)('correlates concurrent Fresh launches with %s delivery and still restores unrelated cold views', (order) => {
    const state = baseState()
    state.panes.layouts['user-tab'] = { type: 'split', id: 'split-root', direction: 'horizontal', sizes: [50, 50], children: [
      { type: 'leaf', id: 'first-pane', content: { kind: 'fresh-agent', createRequestId: 'first-create', status: 'creating', sessionType: 'freshcodex', provider: 'codex' } },
      { type: 'leaf', id: 'second-pane', content: { kind: 'fresh-agent', createRequestId: 'second-create', status: 'creating', sessionType: 'freshcodex', provider: 'codex' } },
    ] }
    const store = storeWithState(state)
    const inventory = snapshot(['second', 'first', 'cold'].map((key) => soul({
      soulId: `${key}-soul`, provider: 'codex', nativeSessionId: undefined,
      terminalId: undefined, terminalCreateRequestId: undefined,
      freshAgentCreateRequestId: `${key}-create`, freshAgentSessionId: `${key}-runtime`, freshAgentSessionType: 'freshcodex',
    })), ['second', 'first', 'cold'].map((key) => view({
      viewId: `${key}-view`, soulId: `${key}-soul`, preferredTabId: 'user-tab', preferredPaneId: `${key}-preferred-pane`,
    })))
    const acknowledge = () => {
      for (const key of ['first', 'second']) {
        const root = store.getState().panes.layouts['user-tab']
        const leaf = root.children.find((node: any) => node.id === `${key}-pane`)
        store.dispatch(updatePaneContent({ tabId: 'user-tab', paneId: `${key}-pane`, content: {
          ...leaf.content, sessionId: `${key}-runtime`, status: 'connected',
        } }))
      }
    }
    if (order === 'ack-first') acknowledge()
    const plan = buildManagedRuntimeMergePlan(inventory, store.getState() as any)
    expect(plan.updates.map((update) => update.paneId).sort()).toEqual(['first-pane', 'second-pane'])
    expect(plan.creates).toHaveLength(1)
    expect(plan.creates[0].content.soulId).toBe('cold-soul')
    applyManagedRuntimeMergePlan(store as any, plan)
    if (order === 'inventory-first') acknowledge()
    const root = store.getState().panes.layouts['user-tab']
    for (const key of ['first', 'second']) expect(root.children.find((node: any) => node.id === `${key}-pane`).content).toMatchObject({
      kind: 'fresh-agent', createRequestId: `${key}-create`, sessionId: `${key}-runtime`, soulId: `${key}-soul`, viewIntentId: `${key}-view`,
    })
    expect(store.getState().tabs.tabs).toHaveLength(2)
    const replay = buildManagedRuntimeMergePlan(inventory, store.getState() as any)
    expect(replay.creates).toHaveLength(0)
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
      status: 'error',
      soulId: 'soul-one',
      sessionRef: { provider: 'opencode', sessionId: 'ses_one' },
      recoverySummary: {
        recoveryState: 'blocked',
        reason: 'CREDENTIALS_EXPIRED',
      },
    })
  })

  it('updates an already represented stopped/lost terminal in place without creating a replacement', () => {
    const state = baseState()
    state.tabs.tabs[0].mode = 'opencode'
    state.panes.layouts['user-tab'].content = {
      kind: 'terminal',
      createRequestId: 'create-one',
      terminalId: 'terminal-one',
      streamId: 'stream-one',
      status: 'exited',
      mode: 'opencode',
      shell: 'system',
      sessionRef: { provider: 'opencode', sessionId: 'ses_one' },
      soulId: 'soul-one',
      viewIntentId: 'view-one',
    }
    const lost = soul({
      launchState: 'stopped',
      desiredState: 'stopped',
      recoveryState: 'lost',
      recoveryReason: 'provider_state_missing',
      terminalId: undefined,
      terminalStreamId: undefined,
      terminalCreateRequestId: undefined,
    })

    const plan = buildManagedRuntimeMergePlan(snapshot([lost]), state)

    expect(plan.creates).toHaveLength(0)
    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0]).toMatchObject({ tabId: 'user-tab', paneId: 'user-pane' })
    expect(plan.updates[0].content).toMatchObject({
      kind: 'terminal',
      soulId: 'soul-one',
      viewIntentId: 'view-one',
      status: 'error',
      recoverySummary: { desiredState: 'stopped', recoveryState: 'lost' },
    })
  })

  it.each([
    ['live', 'running', 'running'],
    ['recovering', 'stopped', 'recovering'],
    ['blocked', 'stopped', 'error'],
    ['lost', 'stopped', 'error'],
    ['stopped', 'stopped', 'exited'],
  ] as const)('projects %s recovery with launch state %s while retaining the same conversation and diagnostics', (recoveryState, launchState, status) => {
    const state = baseState()
    state.panes.layouts['user-tab'].content = {
      kind: 'terminal', createRequestId: 'create-one', terminalId: 'terminal-one',
      streamId: 'transport-stream', mode: 'opencode', status: 'running', soulId: 'soul-one',
      viewIntentId: 'view-one', sessionRef: { provider: 'opencode', sessionId: 'ses_one' },
    }
    const retained = soul({ recoveryState, launchState,
      desiredState: recoveryState === 'lost' || recoveryState === 'stopped' ? 'stopped' : 'running',
      recoveryReason: 'STORE_UNREADABLE', recoveryAttemptId: 'attempt-retained', incidentId: 'incident-retained' })
    const plan = buildManagedRuntimeMergePlan(snapshot([retained]), state)
    expect(plan.creates).toHaveLength(0)
    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0].content).toMatchObject({
      terminalId: 'terminal-one', streamId: 'transport-stream', status,
      soulId: 'soul-one', incarnationId: 'incarnation-one',
      sessionRef: { provider: 'opencode', sessionId: 'ses_one' },
      recoverySummary: { recoveryState, reason: 'STORE_UNREADABLE',
        attemptId: 'attempt-retained', incidentId: 'incident-retained' },
    })
    expect(plan.updates[0].tabUpdates.status).toBe(status)
  })

  it.each([
    ['live', 'running'], ['recovering', 'recovering'], ['blocked', 'blocked'],
    ['lost', 'exited'], ['stopped', 'exited'],
  ] as const)('projects %s inventory into the authoritative retained transport status %s', (recoveryState, runtimeStatus) => {
    const retained = soul({
      recoveryState, launchState: recoveryState === 'live' ? 'running' : 'stopped',
      desiredState: recoveryState === 'lost' || recoveryState === 'stopped' ? 'stopped' : 'running',
    })
    const state = baseState()
    if (retained.desiredState === 'stopped') {
      state.panes.layouts['user-tab'].content = {
        kind: 'terminal', createRequestId: 'create-one', terminalId: 'terminal-one',
        streamId: 'transport-stream', mode: 'opencode', status: 'running', soulId: 'soul-one',
        viewIntentId: 'view-one', sessionRef: { provider: 'opencode', sessionId: 'ses_one' },
      }
    }
    const plan = buildManagedRuntimeMergePlan(snapshot([retained]), state)
    if (retained.desiredState === 'stopped') {
      expect(plan.creates).toHaveLength(0)
      expect(plan.updates).toHaveLength(1)
      expect(plan.updates[0].content).toMatchObject({
        terminalId: 'terminal-one', streamId: 'transport-stream', soulId: 'soul-one', runtimeStatus,
        sessionRef: { provider: 'opencode', sessionId: 'ses_one' },
      })
      expect(plan.updates[0].tabUpdates).toMatchObject({ soulId: 'soul-one', runtimeStatus })
    } else {
      expect(plan.creates).toHaveLength(1)
      expect(plan.creates[0].content).toMatchObject({
        terminalId: 'terminal-one', soulId: 'soul-one', runtimeStatus,
      })
      expect(plan.creates[0].tab).toMatchObject({ soulId: 'soul-one', runtimeStatus })
    }
  })

  it('updates an already represented stopped/lost Fresh Agent in place', () => {
    const state = baseState()
    state.tabs.tabs[0].mode = 'freshopencode'
    state.panes.layouts['user-tab'].content = {
      kind: 'fresh-agent',
      createRequestId: 'fresh-create-one',
      status: 'exited',
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionId: 'ses_one',
      resumeSessionId: 'ses_one',
      sessionRef: { provider: 'opencode', sessionId: 'ses_one' },
      soulId: 'soul-one',
      viewIntentId: 'view-one',
      incarnationId: 'incarnation-one',
    }
    const lost = soul({
      launchState: 'stopped',
      desiredState: 'stopped',
      recoveryState: 'lost',
      terminalId: undefined,
      terminalStreamId: undefined,
      terminalMode: undefined,
      terminalCwd: undefined,
      terminalCreateRequestId: undefined,
    })

    const plan = buildManagedRuntimeMergePlan(snapshot([lost]), state)

    expect(plan.creates).toHaveLength(0)
    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0].content).toMatchObject({
      kind: 'fresh-agent',
      soulId: 'soul-one',
      viewIntentId: 'view-one',
      sessionRef: { provider: 'opencode', sessionId: 'ses_one' },
      recoverySummary: { desiredState: 'stopped', recoveryState: 'lost' },
    })
  })

  it('never creates a pane for an absent stopped/lost view', () => {
    const lost = soul({
      launchState: 'stopped',
      desiredState: 'stopped',
      recoveryState: 'lost',
      terminalId: undefined,
      terminalStreamId: undefined,
      terminalCreateRequestId: undefined,
    })
    const plan = buildManagedRuntimeMergePlan(snapshot([lost]), baseState())

    expect(plan.creates).toHaveLength(0)
    expect(plan.updates).toHaveLength(0)
  })

  it('clears a lost managed terminal before an old inventory snapshot can reattach it', () => {
    const state = baseState()
    state.tabs.tabs[0].mode = 'opencode'
    state.panes.layouts['user-tab'].content = {
      kind: 'terminal',
      createRequestId: 'old-create',
      terminalId: 'terminal-one',
      streamId: 'stream-one',
      status: 'error',
      mode: 'opencode',
      shell: 'system',
      namingHandle: 'old-managed-name-handle',
      nameRef: { kind: 'pending', id: 'old-managed-name-handle' },
      soulId: 'soul-one',
      incarnationId: 'incarnation-one',
      viewIntentId: 'view-one',
      viewIntentRevision: 2,
      soulIntentRevision: 3,
      incidentId: 'incident-one',
      placementGroup: 'Recovered agents',
      resourceSummary: {
        configured: soul().configuredLimits,
        effective: soul().effectiveLimits,
      },
      recoverySummary: {
        desiredState: 'stopped',
        recoveryState: 'lost',
        reason: 'provider_state_missing',
        durabilityState: 'resume_captured',
        allocationState: 'verified_durable',
      },
    }
    const store = storeWithState(state)
    const oldCreateRequestId = store.getState().panes.layouts['user-tab'].type === 'leaf'
      ? store.getState().panes.layouts['user-tab'].content.createRequestId
      : undefined

    store.dispatch(startNewManagedRuntimeConversation({ tabId: 'user-tab', paneId: 'user-pane' }))

    const content = store.getState().panes.layouts['user-tab']
    if (content.type !== 'leaf' || content.content.kind !== 'terminal') {
      throw new Error('expected a terminal pane after starting a new conversation')
    }
    expect(content.content.createRequestId).not.toBe(oldCreateRequestId)
    expect(content.content.status).toBe('creating')
    expect(content.content.terminalId).toBeUndefined()
    expect(content.content.namingHandle).toBeUndefined()
    expect(content.content.nameRef).toBeUndefined()
    expect(content.content.soulId).toBeUndefined()
    expect(content.content.incarnationId).toBeUndefined()
    expect(content.content.viewIntentId).toBeUndefined()
    expect(content.content.viewIntentRevision).toBeUndefined()
    expect(content.content.soulIntentRevision).toBeUndefined()
    expect(content.content.incidentId).toBeUndefined()
    expect(content.content.placementGroup).toBeUndefined()
    expect(content.content.resourceSummary).toBeUndefined()
    expect(content.content.recoverySummary).toBeUndefined()

    const oldInventoryPlan = buildManagedRuntimeMergePlan(
      snapshot([soul({
        desiredState: 'stopped',
        launchState: 'stopped',
        recoveryState: 'lost',
        recoveryReason: 'provider_state_missing',
      })]),
      store.getState() as any,
    )
    expect(oldInventoryPlan.creates).toHaveLength(0)
    expect(oldInventoryPlan.updates).toHaveLength(0)
  })
})

// Name reliability (plan Task 8, D6): a managed-runtime refresh merges
// RUNTIME facts into the layout and never names a tab. Before the fix every
// existing tab matched to a view took the view's title ("Shell agent",
// "OpenCode agent") and a fresh `updatedAt`, a split tab took its tab-level
// fields from whichever pane matched, and a reconstructed tab was titled with
// the view's provider label and never owned by its session.
describe('managed runtime merge never writes names', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function shellSoul(overrides: Partial<ManagedRuntimeSoul> = {}): ManagedRuntimeSoul {
    return soul({
      terminalId: 'terminal-shell',
      terminalStreamId: 'stream-shell',
      terminalMode: 'shell',
      terminalCreateRequestId: 'user-pane',
      terminalResumeSessionId: undefined,
      provider: 'shell',
      nativeSessionId: undefined,
      ...overrides,
    })
  }

  function tabById(store: { getState: () => unknown }, tabId: string): Tab {
    const tab = (store.getState() as { tabs: { tabs: Tab[] } }).tabs.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) throw new Error(`no tab ${tabId}`)
    return tab
  }

  /** A store with the name cache, the saved-name tab title mirror and the
   * naming-source lifecycle coordinator, in their production order. */
  function namingStore(state = baseState()) {
    return configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        managedRuntime: managedRuntimeReducer,
        sessionNames: sessionNamesReducer,
        sessionActivity: sessionActivityReducer,
      },
      middleware: (getDefault) => getDefault().concat(
        savedNameTabTitleMirrorMiddleware,
        sessionNameLifecycleMiddleware,
      ),
      ...(state ? { preloadedState: state as never } : {}),
    })
  }

  it('a stored "Shell agent" title is visible on a single-pane shell tab', () => {
    // Why the overwrite mattered: a non-default stored title that differs
    // from the derived name is what a single-pane shell tab displays.
    const layout: PaneNode = {
      type: 'leaf',
      id: 'pane-1',
      content: { kind: 'terminal', createRequestId: 'create-1', status: 'running', mode: 'shell', shell: 'system' },
    }
    const tab = {
      id: 'tab-1', createRequestId: 'tab-1', title: 'Shell agent', status: 'running',
      mode: 'shell', shell: 'system', createdAt: 1, updatedAt: 1,
    } as Tab
    expect(getTabDisplayTitle(tab, layout)).toBe('Shell agent')
  })

  it('an existing tab matched to a "Shell agent" view keeps its title and updatedAt', () => {
    vi.useFakeTimers({ now: 9_000 })
    const state = baseState()
    state.tabs.tabs[0].title = 'Tab 1'
    const store = storeWithState(state)

    const plan = buildManagedRuntimeMergePlan(
      snapshot([shellSoul()], [view({ title: 'Shell agent' })]),
      store.getState() as any,
    )
    expect(plan.updates.map((update) => update.paneId)).toEqual(['user-pane'])
    applyManagedRuntimeMergePlan(store as any, plan)

    const tab = tabById(store, 'user-tab')
    expect(tab.title).toBe('Tab 1')
    expect(tab.updatedAt).toBe(1)
    expect(tab.titleSetByUser).toBeUndefined()
    // The runtime facts still land: the matched pane is the tab's naming pane.
    expect(tab.soulId).toBe('soul-one')
    expect((store.getState().panes.layouts['user-tab'] as any).content.soulId).toBe('soul-one')
  })

  it('an existing OpenCode tab matched to an "OpenCode agent" view keeps its title', () => {
    vi.useFakeTimers({ now: 9_000 })
    const state = baseState()
    Object.assign(state.tabs.tabs[0], {
      title: 'Billing bug',
      mode: 'opencode',
      nameSource: { kind: 'session', paneId: 'user-pane' },
    })
    state.panes.layouts['user-tab'].content = {
      kind: 'terminal',
      createRequestId: 'create-one',
      terminalId: 'terminal-one',
      status: 'running',
      mode: 'opencode',
      shell: 'system',
      sessionRef: { provider: 'opencode', sessionId: 'ses_one' },
    }
    const store = storeWithState(state)

    const plan = buildManagedRuntimeMergePlan(snapshot([soul()], [view({ title: 'OpenCode agent' })]), store.getState() as any)
    applyManagedRuntimeMergePlan(store as any, plan)

    const tab = tabById(store, 'user-tab')
    expect(tab.title).toBe('Billing bug')
    expect(tab.updatedAt).toBe(1)
    expect(tab.soulId).toBe('soul-one')
  })

  function splitShellAndAgentState(nameSource: Tab['nameSource']) {
    const state = baseState()
    Object.assign(state.tabs.tabs[0], { title: 'Tab 1', nameSource })
    state.panes.layouts['user-tab'] = {
      type: 'split',
      id: 'split-root',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        state.panes.layouts['user-tab'],
        {
          type: 'leaf',
          id: 'agent-pane',
          content: { kind: 'terminal', createRequestId: 'create-one', status: 'creating', mode: 'opencode', shell: 'system' },
        },
      ],
    }
    return state
  }

  it('a split tab takes tab-level fields only from its naming pane', () => {
    vi.useFakeTimers({ now: 9_000 })
    const store = storeWithState(splitShellAndAgentState({ kind: 'legacy' }))
    const before = structuredClone(tabById(store, 'user-tab'))

    const plan = buildManagedRuntimeMergePlan(snapshot(), store.getState() as any)
    expect(plan.creates).toHaveLength(0)
    expect(plan.updates.map((update) => update.paneId)).toEqual(['agent-pane'])
    applyManagedRuntimeMergePlan(store as any, plan)

    // The naming pane is the shell (the first leaf of a legacy tab): the
    // managed OpenCode pane beside it updates itself, never the tab.
    expect(tabById(store, 'user-tab')).toEqual(before)
    const agentPane = (store.getState().panes.layouts['user-tab'] as any).children[1].content
    expect(agentPane).toMatchObject({ soulId: 'soul-one', terminalId: 'terminal-one', viewIntentId: 'view-one' })
  })

  it('a split tab whose naming pane is the managed pane takes that pane\'s tab-level fields', () => {
    vi.useFakeTimers({ now: 9_000 })
    const store = storeWithState(splitShellAndAgentState({ kind: 'session', paneId: 'agent-pane' }))

    applyManagedRuntimeMergePlan(store as any, buildManagedRuntimeMergePlan(snapshot(), store.getState() as any))

    const tab = tabById(store, 'user-tab')
    expect(tab).toMatchObject({
      mode: 'opencode',
      codingCliProvider: 'opencode',
      sessionRef: { provider: 'opencode', sessionId: 'ses_one' },
      soulId: 'soul-one',
      title: 'Tab 1',
      updatedAt: 1,
    })
  })

  it('a reconstructed agent tab carries a session nameSource and no provider label', () => {
    const store = storeWithState()
    const plan = buildManagedRuntimeMergePlan(snapshot([soul()], [view({ title: 'OpenCode agent' })]), store.getState() as any)
    expect(plan.creates).toHaveLength(1)
    const [create] = plan.creates
    expect(create.tab?.nameSource).toEqual({ kind: 'session', paneId: create.paneId })
    expect(create.tab?.title).toBeUndefined()

    applyManagedRuntimeMergePlan(store as any, plan)

    const tab = tabById(store, create.tabId)
    expect(tab.title).toBe('Tab 2')
    expect(tab.nameSource).toEqual({ kind: 'session', paneId: create.paneId })
    const layout = store.getState().panes.layouts[create.tabId] as PaneNode
    const label = selectTabDisplayName(store.getState() as any, create.tabId)
    expect(label).toBe(deriveTabName(layout))
    expect(label).not.toMatch(/agent/i)
  })

  it('a reconstructed OpenCode tab without a native id fills its title after the session links', () => {
    const store = namingStore()
    const nativeFree = soul({ nativeSessionId: undefined, terminalResumeSessionId: undefined })
    const plan = buildManagedRuntimeMergePlan(
      snapshot([nativeFree], [view({ title: 'OpenCode agent' })]),
      store.getState() as any,
    )
    applyManagedRuntimeMergePlan(store as any, plan)
    const [{ tabId, paneId }] = plan.creates

    // No native id yet: nothing names the tab, and it never shows the
    // provider label in the meantime.
    expect(tabById(store, tabId).title).toBe('Tab 2')
    expect(tabById(store, tabId).nameSource).toEqual({ kind: 'session', paneId })
    expect((store.getState().panes.layouts[tabId] as any).content.sessionRef).toBeUndefined()

    // terminal.session.associated links the terminal to its OpenCode session.
    const linked: SessionNameRef = { kind: 'session', provider: 'opencode', sessionId: 'ses_linked' }
    expect(reconcileTerminalSessionAssociation({
      dispatch: store.dispatch,
      getState: () => store.getState() as any,
      terminalId: 'terminal-one',
      sessionRef: { provider: 'opencode', sessionId: 'ses_linked' },
    })).toBe('reconciled')
    store.dispatch(receiveSessionNames([{
      record: { ref: linked, name: 'Billing bug', source: 'manual', revision: 1 },
      documentGeneration: 1,
      redirects: [],
      changed: true,
    }]))

    expect(tabById(store, tabId).title).toBe('Billing bug')
    expect(selectTabDisplayName(store.getState() as any, tabId)).toBe('Billing bug')
  })

  it('a reconstructed kilroy tab stays a legacy tab', () => {
    const nativeSessionId = 'd4430000-0000-4444-8444-000000000094'
    const kilroy = soul({
      provider: 'kilroy',
      freshAgentSessionType: 'kilroy',
      terminalMode: undefined,
      nativeSessionId,
    })
    const plan = buildManagedRuntimeMergePlan(snapshot([kilroy], [view({ title: 'Recovered Kilroy agent' })]), baseState())
    expect(plan.creates).toHaveLength(1)
    // It resolves a Claude ref, but kilroy is never a scoped naming mode.
    expect(plan.creates[0].content.sessionRef).toEqual({ provider: 'claude', sessionId: nativeSessionId })
    expect(plan.creates[0].tab?.nameSource).toBeUndefined()
  })

  it.each([
    ['Build watcher', 'Build watcher'],
    ['Shell agent', undefined],
    ['Recovered Shell agent', undefined],
    ['Shell', undefined],
    ['Tab 4', undefined],
    ['workspace', undefined],
    ['   ', undefined],
    ['', undefined],
  ] as const)('a reconstructed shell tab uses a real view title but never a default label (%j)', (viewTitle, expected) => {
    const store = storeWithState()
    const plan = buildManagedRuntimeMergePlan(
      snapshot([shellSoul({ terminalCreateRequestId: 'create-shell', terminalCwd: '/workspace' })], [view({ title: viewTitle })]),
      store.getState() as any,
    )
    expect(plan.creates).toHaveLength(1)
    const [create] = plan.creates
    expect(create.tab?.title).toBe(expected)
    expect(create.tab?.nameSource).toBeUndefined()

    applyManagedRuntimeMergePlan(store as any, plan)
    expect(tabById(store, create.tabId).title).toBe(expected ?? 'Tab 2')
  })
})
