import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import TabBar from '../../../../src/components/TabBar'
import tabsReducer, { addTab } from '../../../../src/store/tabsSlice'
import panesReducer, { initLayout } from '../../../../src/store/panesSlice'
import connectionReducer from '../../../../src/store/connectionSlice'
import settingsReducer, { defaultSettings } from '../../../../src/store/settingsSlice'
import sessionNamesReducer, { receiveSessionNames } from '../../../../src/store/sessionNamesSlice'
import { resolvePaneNameRef } from '../../../../src/store/selectors/sessionNameSelectors'
import {
  applyManagedRuntimeMergePlan,
  buildManagedRuntimeMergePlan,
} from '../../../../src/lib/recovery/managed-runtime-recovery'
import type { RootState } from '../../../../src/store/store'
import { ManagedRuntimeInventorySnapshotSchema } from '../../../../shared/managed-runtime'

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(),
    close: vi.fn(),
  }),
}))

vi.stubGlobal('localStorage', {
  getItem: vi.fn().mockReturnValue(null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  length: 0,
  key: vi.fn(),
})

function createStore(tabsState: any, panesState: any) {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      connection: connectionReducer,
      settings: settingsReducer,
    },
    preloadedState: {
      tabs: tabsState,
      panes: panesState,
      connection: {
        ...connectionReducer(undefined, { type: '@@INIT' }),
        status: 'connected' as const,
      },
      settings: {
        ...settingsReducer(undefined, { type: '@@INIT' }),
        settings: defaultSettings,
        loaded: true,
      },
    },
  })
}

describe('TabBar accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(localStorage.getItem).mockReturnValue(null)
  })

  afterEach(() => cleanup())

  it.each(['click', 'Enter', ' '] as const)('exposes and activates the preferred tab projected from a store-blocked managed soul with %j', (activation) => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        connection: connectionReducer,
        settings: settingsReducer,
        sessionNames: sessionNamesReducer,
      },
    })
    store.dispatch(addTab({ id: 'local-tab', title: 'Local shell', mode: 'shell' }))
    store.dispatch(initLayout({
      tabId: 'local-tab',
      paneId: 'local-pane',
      content: { kind: 'terminal', mode: 'shell', status: 'running', createRequestId: 'local-create' },
    }))
    const inventory = ManagedRuntimeInventorySnapshotSchema.parse({
      revision: 9,
      readiness: {
        inventoryRevision: 9,
        initialScanState: 'complete',
        blockedSubsystems: [],
        startupRecoveryConcurrencyLimit: 4,
        startupRecoveryPeak: 1,
      },
      souls: [{
        soulId: 'config-soul',
        incarnationId: 'config-incarnation',
        launchState: 'running',
        cleanupState: 'none',
        intentRevision: 3,
        executionGeneration: 1,
        desiredState: 'running',
        recoveryState: 'blocked',
        recoveryReason: 'STORE_UNREADABLE',
        durabilityState: 'resume_captured',
        allocationState: 'verified_durable',
        provider: 'opencode',
        nativeSessionId: 'ses_config_fixture',
        terminalMode: 'opencode',
        evidenceRevision: 1,
        successfulRecoveriesInWindow: 0,
      }],
      viewIntents: [{
        viewId: 'config-view',
        soulId: 'config-soul',
        ownerId: 'fixture-owner',
        workspaceId: 'fixture-workspace',
        kind: 'automatic_primary',
        preferredTabId: 'config-tab',
        preferredPaneId: 'config-pane',
        title: 'synthetic config-blocked exact retry',
        placementGroup: 'fixture-workspace',
        visibility: 'visible',
        revision: 2,
        soulIntentRevision: 3,
        createdAt: 1,
        updatedAt: 2,
      }],
      pendingProjectionCount: 0,
    })
    const plan = buildManagedRuntimeMergePlan(inventory, store.getState())
    applyManagedRuntimeMergePlan({
      dispatch: store.dispatch,
      getState: () => store.getState() as RootState,
    }, plan)

    const projectedLayout = store.getState().panes.layouts['config-tab']
    // A blocked recovery needs manual retry; it is not actively recovering.
    const expectedBlockedProjection = {
      soulId: 'config-soul',
      incarnationId: 'config-incarnation',
      viewIntentId: 'config-view',
      status: 'error',
      runtimeStatus: 'blocked',
      recoverySummary: { desiredState: 'running', recoveryState: 'blocked', reason: 'STORE_UNREADABLE' },
      sessionRef: { provider: 'opencode', sessionId: 'ses_config_fixture' },
    }
    expect(projectedLayout).toMatchObject({
      type: 'leaf',
      id: 'config-pane',
      content: expectedBlockedProjection,
    })
    const projectedTabRecord = store.getState().tabs.tabs.find(tab => tab.id === 'config-tab')
    expect(projectedTabRecord).toMatchObject(expectedBlockedProjection)
    expect(store.getState().tabs.activeTabId).toBe('local-tab')

    render(<Provider store={store}><TabBar /></Provider>)

    const projectedTab = screen.getByRole('tab', { name: 'synthetic config-blocked exact retry' })
    expect(projectedTab).toBeVisible()
    expect(projectedTab).toHaveAttribute('data-tab-id', 'config-tab')
    expect(projectedTab).toHaveAttribute('aria-selected', 'false')
    const tablist = screen.getByRole('tablist', { name: 'Workspace tabs' })
    expect(within(tablist).getAllByRole('tab')).toHaveLength(2)
    expect(within(tablist).getByRole('tab', { selected: true })).toHaveAttribute('data-tab-id', 'local-tab')

    if (activation === 'click') fireEvent.click(projectedTab)
    else fireEvent.keyDown(projectedTab, { key: activation })

    expect(projectedTab).toHaveAttribute('aria-selected', 'true')
    expect(within(tablist).getByRole('tab', { selected: false })).toHaveAttribute('data-tab-id', 'local-tab')
    expect(store.getState().tabs.activeTabId).toBe('config-tab')
    expect(store.getState().panes.activePane['config-tab']).toBe('config-pane')
    expect(store.getState().panes.layouts[store.getState().tabs.activeTabId!]).toEqual(projectedLayout)
    expect(store.getState().tabs.tabs.find(tab => tab.id === 'config-tab')).toEqual(projectedTabRecord)

    const nameRef = projectedLayout.type === 'leaf' ? resolvePaneNameRef(projectedLayout.content) : undefined
    expect(nameRef).toBeDefined()
    act(() => {
      store.dispatch(receiveSessionNames([{
        record: {
          ref: nameRef!,
          name: 'Canonical managed name',
          source: 'manual',
          revision: 1,
        },
        documentGeneration: 1,
        redirects: [],
        changed: true,
      }]))
    })
    expect(within(tablist).getByRole('tab', { name: 'Canonical managed name', selected: true }))
      .toHaveAttribute('data-tab-id', 'config-tab')
    expect(within(tablist).queryByRole('tab', { name: 'synthetic config-blocked exact retry' }))
      .not.toBeInTheDocument()
  })

  it('exposes an accessible name for the new tab button', () => {
    const store = createStore(
      {
        tabs: [
          {
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Tab 1',
            titleSetByUser: false,
            status: 'running',
            mode: 'shell',
            shell: 'system',
            createdAt: Date.now(),
          },
        ],
        activeTabId: 'tab-1',
      },
      {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-1',
              status: 'running',
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
      }
    )

    render(
      <Provider store={store}>
        <TabBar />
      </Provider>
    )

    expect(screen.getByRole('button', { name: /new shell tab/i })).toBeInTheDocument()
  })
})

