import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import connectionReducer from '@/store/connectionSlice'
import managedRuntimeReducer from '@/store/managedRuntimeSlice'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import {
  ManagedAgentRecoveryStatus,
  managedAgentStatusLabel,
} from '@/components/ManagedAgentRecoveryStatus'
import { AgentResourceLimits } from '@/components/AgentResourceLimits'
import type { ManagedRuntimeSoul } from '@shared/managed-runtime'
import {
  getManagedRuntimeSoul,
  retryManagedRuntimeSoul,
  stopManagedRuntimeSoul,
  updateManagedRuntimeLimits,
} from '@/lib/api'

const apiMocks = vi.hoisted(() => ({
  getManagedRuntimeSoul: vi.fn(),
  retryManagedRuntimeSoul: vi.fn(),
  stopManagedRuntimeSoul: vi.fn(),
  updateManagedRuntimeLimits: vi.fn(),
  updateManagedRuntimeViewVisibility: vi.fn(),
  getManagedRuntimeIncidentSummary: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>()
  return { ...original, ...apiMocks }
})

const refreshMocks = vi.hoisted(() => ({
  queueManagedRuntimeRefresh: vi.fn(async () => undefined),
}))
vi.mock('@/lib/recovery/managed-runtime-recovery', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/recovery/managed-runtime-recovery')>()
  return { ...original, ...refreshMocks }
})

function soul(overrides: Partial<ManagedRuntimeSoul> = {}): ManagedRuntimeSoul {
  return {
    soulId: 'soul-one',
    incarnationId: 'incarnation-one',
    launchState: 'stopped',
    cleanupState: 'verified_empty',
    intentRevision: 7,
    executionGeneration: 1,
    effectiveLimits: { cpuMilli: 500, memoryBytes: 256 * 1024 * 1024, swapBytes: 0, pidsMax: 64 },
    configuredLimits: { cpuMilli: 1_000, memoryBytes: 512 * 1024 * 1024, swapBytes: 0, pidsMax: 128 },
    viewIntentRevision: 3,
    terminalId: 'terminal-one',
    terminalStreamId: 'stream-one',
    terminalMode: 'opencode',
    terminalCwd: '/workspace',
    terminalCreateRequestId: 'create-one',
    terminalResumeSessionId: 'ses_one',
    projectKey: 'workspace-one',
    profile: 'default_agent',
    desiredState: 'running',
    recoveryState: 'blocked',
    recoveryReason: 'CREDENTIALS_EXPIRED',
    durabilityState: 'resume_captured',
    allocationState: 'verified_durable',
    provider: 'opencode',
    nativeSessionId: 'ses_one',
    recoveryAttemptId: 'recovery-one',
    evidenceRevision: 2,
    successfulRecoveriesInWindow: 0,
    ...overrides,
  }
}

function renderStatus(currentSoul = soul()) {
  const store = configureStore({
    reducer: {
      connection: connectionReducer,
      managedRuntime: managedRuntimeReducer,
      tabs: tabsReducer,
      panes: panesReducer,
    },
    preloadedState: {
      connection: { status: 'ready' },
      managedRuntime: {
        available: true,
        status: 'ready',
        revision: 12,
        readiness: {
          inventoryRevision: 12,
          initialScanState: 'complete',
          blockedSubsystems: [],
          startupRecoveryConcurrencyLimit: 4,
          startupRecoveryPeak: 2,
        },
        souls: [currentSoul],
        viewIntents: [{
          viewId: 'view-one',
          soulId: currentSoul.soulId,
          ownerId: 'owner-one',
          workspaceId: 'workspace-one',
          kind: 'automatic_primary',
          preferredTabId: 'tab-one',
          preferredPaneId: 'pane-one',
          title: 'Recovered OpenCode agent',
          placementGroup: 'Recovered agents',
          visibility: 'visible',
          revision: 3,
          soulIntentRevision: currentSoul.intentRevision,
          createdAt: 1,
          updatedAt: 2,
        }],
        pendingProjectionCount: 0,
        reconstructedViewCount: 1,
      },
      tabs: {
        tabs: [],
        activeTabId: null,
        renameRequestTabId: null,
        tombstones: [],
      },
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
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
    } as any,
  })
  render(
    <Provider store={store}>
      <ManagedAgentRecoveryStatus />
    </Provider>,
  )
  return store
}

describe('managed agent recovery status', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.getManagedRuntimeSoul.mockResolvedValue({
      revision: 12,
      readiness: {
        inventoryRevision: 12,
        initialScanState: 'complete',
        blockedSubsystems: [],
        startupRecoveryConcurrencyLimit: 4,
        startupRecoveryPeak: 2,
      },
      soul: soul(),
      viewIntents: [],
      actualUsage: {
        cpuUsageUsec: 2_000_000,
        cpuThrottledUsec: 0,
        cpuNrThrottled: 0,
        memoryCurrentBytes: 128 * 1024 * 1024,
        memoryPeakBytes: 160 * 1024 * 1024,
        memoryOom: 0,
        memoryOomKill: 0,
        pidsCurrent: 9,
        pidsMax: 64,
      },
    })
    apiMocks.retryManagedRuntimeSoul.mockResolvedValue({})
    apiMocks.stopManagedRuntimeSoul.mockResolvedValue({})
    apiMocks.getManagedRuntimeIncidentSummary.mockResolvedValue({
      incidentId: 'incident-one',
      correlationId: 'correlation-one',
      soulId: 'soul-one',
      provider: 'opencode',
      state: 'closed',
      reasonCode: 'all_applicable_recovery_paths_definitively_unavailable',
      observedCause: 'provider store missing',
      cleanup: {
        ownedHandleRef: 'registry://incarnation-one',
        ownershipVerified: true,
        gracefulAttempt: 'not_required',
        forcedAttempt: 'not_required',
        verifiedEmpty: true,
        verifiedAt: '2026-09-08T00:00:00.000Z',
        foreignObjectsTouched: 0,
      },
      createdAt: '2026-09-08T00:00:00.000Z',
      updatedAt: '2026-09-08T00:00:01.000Z',
    })
    apiMocks.updateManagedRuntimeLimits.mockResolvedValue({
      view: soul({ intentRevision: 8 }),
      application: 'next_incarnation',
      configuredLimits: { cpuMilli: 1_500, memoryBytes: 768 * 1024 * 1024, swapBytes: 0, pidsMax: 160 },
      effectiveLimits: soul().effectiveLimits,
    })
  })

  afterEach(cleanup)

  it('uses explicit lifecycle labels including certified loss', () => {
    expect(managedAgentStatusLabel('connecting', soul())).toBe('Reconnecting')
    expect(managedAgentStatusLabel('ready', soul({ recoveryState: 'recovering' }))).toBe('Restarting agent')
    expect(managedAgentStatusLabel('ready', soul())).toBe('Recovery blocked')
    expect(managedAgentStatusLabel('ready', soul({
      recoveryState: 'lost',
      desiredState: 'stopped',
      incidentId: 'incident-one',
    }))).toBe('Lost')
    expect(managedAgentStatusLabel('ready', soul({
      launchState: 'running',
      recoveryState: 'live',
    }))).toBe('Ready')
    expect(managedAgentStatusLabel('ready', soul({
      desiredState: 'stopped',
      recoveryState: 'stopped',
    }))).toBe('Stopped')
  })

  it('shows blocked identity and keeps retry, close-view, and stop-agent actions distinct', async () => {
    renderStatus()
    expect(screen.getByRole('complementary', { name: 'Managed agent recovery' })).toBeVisible()
    expect(screen.getByText('Recovery blocked')).toBeVisible()
    expect(screen.getByText(/CREDENTIALS_EXPIRED/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Retry recovery' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Close view' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Stop agent' })).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: 'Retry recovery' }))
    await waitFor(() => {
      expect(apiMocks.retryManagedRuntimeSoul).toHaveBeenCalledWith('soul-one', 7)
    })
    expect(apiMocks.stopManagedRuntimeSoul).not.toHaveBeenCalled()
  })

  it('shows certified loss without offering retry and opens its incident summary', async () => {
    renderStatus(soul({
      recoveryState: 'lost',
      desiredState: 'stopped',
      recoveryReason: 'LOSS_CERTIFIED:incident-one',
      incidentId: 'incident-one',
    }))
    expect(screen.getByText('Lost')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Retry recovery' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'View incident details' }))
    await waitFor(() => {
      expect(apiMocks.getManagedRuntimeIncidentSummary).toHaveBeenCalledWith('incident-one')
    })
    expect(await screen.findByText(/provider store missing/)).toBeVisible()
  })

  it('exposes configured, effective, and actual resources separately', async () => {
    renderStatus()
    await userEvent.click(screen.getByText('Resource limits and usage'))
    expect(screen.getByText(/Configured:/)).toBeVisible()
    expect(screen.getByText(/Effective:/)).toBeVisible()
    await waitFor(() => expect(screen.getByText(/Actual:/)).toBeVisible())
    await waitFor(() => expect(screen.getByText(/128 MiB memory/)).toBeVisible())
  })
})

describe('AgentResourceLimits', () => {
  afterEach(cleanup)

  it('submits validated limits and announces next-incarnation policy', async () => {
    apiMocks.getManagedRuntimeSoul.mockResolvedValue({
      revision: 12,
      readiness: {
        inventoryRevision: 12,
        initialScanState: 'complete',
        blockedSubsystems: [],
        startupRecoveryConcurrencyLimit: 4,
        startupRecoveryPeak: 2,
      },
      soul: soul(),
      viewIntents: [],
      actualUsage: null,
    })
    apiMocks.updateManagedRuntimeLimits.mockResolvedValue({
      view: soul({ intentRevision: 8 }),
      application: 'next_incarnation',
      configuredLimits: {
        cpuMilli: 1_500,
        memoryBytes: 768 * 1024 * 1024,
        swapBytes: 0,
        pidsMax: 160,
      },
      effectiveLimits: soul().effectiveLimits,
    })
    render(<AgentResourceLimits soul={soul()} onSaved={vi.fn()} />)
    await userEvent.click(screen.getByText('Resource limits and usage'))
    const cpu = screen.getByLabelText('CPU (millicores)')
    await userEvent.clear(cpu)
    await userEvent.type(cpu, '1500')
    await userEvent.click(screen.getByRole('button', { name: 'Save limits' }))
    await waitFor(() => {
      expect(apiMocks.updateManagedRuntimeLimits).toHaveBeenCalledWith(
        'soul-one',
        7,
        expect.objectContaining({ cpuMilli: 1500 }),
      )
    })
    expect(await screen.findByRole('status')).toHaveTextContent(
      'They will apply to the next agent incarnation',
    )
  })
})
