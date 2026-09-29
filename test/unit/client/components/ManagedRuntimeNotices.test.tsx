import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import connectionReducer from '@/store/connectionSlice'
import managedRuntimeReducer from '@/store/managedRuntimeSlice'
import tabRegistryReducer from '@/store/tabRegistrySlice'
import {
  ManagedRuntimeNotices,
  noticeProfileId,
} from '@/components/ManagedRuntimeNotices'

const apiMocks = vi.hoisted(() => ({
  getManagedRuntimeNotices: vi.fn(),
  getManagedRuntimeIncidentSummary: vi.fn(),
  recordManagedRuntimeNoticeReceipt: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>()
  return { ...original, ...apiMocks }
})

function runtimeState() {
  return {
    available: true,
    status: 'ready',
    revision: 4,
    souls: [],
    viewIntents: [],
    pendingProjectionCount: 0,
    reconstructedViewCount: 0,
  }
}

function renderNotices() {
  const store = configureStore({
    reducer: {
      connection: connectionReducer,
      managedRuntime: managedRuntimeReducer,
      tabRegistry: tabRegistryReducer,
    },
    preloadedState: {
      connection: { status: 'ready' },
      managedRuntime: runtimeState(),
      tabRegistry: {
        deviceId: 'device-notice-test',
        deviceLabel: 'Test device',
        aliases: {},
        dismissedDeviceIds: [],
        devices: [],
        records: [],
        loading: false,
        searchRangeDays: 30,
      },
    } as any,
  })
  render(
    <Provider store={store}>
      <ManagedRuntimeNotices />
    </Provider>,
  )
  return store
}

describe('ManagedRuntimeNotices', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    apiMocks.recordManagedRuntimeNoticeReceipt.mockResolvedValue(undefined)
    apiMocks.getManagedRuntimeIncidentSummary.mockResolvedValue({
      incidentId: 'incident-one',
      correlationId: 'correlation-one',
      soulId: 'soul-one',
      provider: 'opencode',
      state: 'closed',
      reasonCode: 'all_applicable_recovery_paths_definitively_unavailable',
      observedCause: 'provider state was missing',
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
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('silently acknowledges routine notices and leaves no popup behind', async () => {
    apiMocks.getManagedRuntimeNotices.mockResolvedValue([{
      noticeId: 'notice-one',
      kind: 'cleanup_succeeded',
      message: 'Found and cleaned up 1 lost agent process.',
      reference: 'SUCCESS01',
      incidentIds: ['incident-one'],
      deliveryState: 'pending',
      createdAt: '2026-09-08T00:00:00.000Z',
    }, {
      noticeId: 'notice-two',
      kind: 'ended_without_process',
      message: 'The managed agent ended without a running process.',
      reference: 'ENDED001',
      incidentIds: [],
      deliveryState: 'pending',
      createdAt: '2026-09-08T00:00:01.000Z',
    }])
    renderNotices()

    await waitFor(() => {
      expect(apiMocks.recordManagedRuntimeNoticeReceipt).toHaveBeenCalledWith(
        'notice-one',
        noticeProfileId('device-notice-test'),
        'acknowledged',
      )
      expect(apiMocks.recordManagedRuntimeNoticeReceipt).toHaveBeenCalledWith(
        'notice-two',
        noticeProfileId('device-notice-test'),
        'acknowledged',
      )
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByText('Managed agent recovery')).not.toBeInTheDocument()
    expect(screen.queryByText(/Resource limits and usage/i)).not.toBeInTheDocument()
    expect(screen.queryByText('soul-one')).not.toBeInTheDocument()
  })

  it('renders cleanup failures as an actionable amber alert without auto-acknowledging', async () => {
    apiMocks.getManagedRuntimeNotices.mockResolvedValue([{
      noticeId: 'notice-failed',
      kind: 'cleanup_failed',
      message: 'Found 1 lost agent process, but cleanup could not be verified. No unrelated process was touched. Reference: FAIL0001.',
      reference: 'FAIL0001',
      incidentIds: ['incident-one'],
      deliveryState: 'pending',
      createdAt: '2026-09-08T00:00:00.000Z',
    }])
    renderNotices()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('No unrelated process was touched')
    expect(alert).toHaveClass('border-amber-500/50', 'bg-amber-500/10')
    expect(screen.getByRole('button', { name: 'Details' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeVisible()
    await waitFor(() => {
      expect(apiMocks.recordManagedRuntimeNoticeReceipt).toHaveBeenCalledWith(
        'notice-failed',
        noticeProfileId('device-notice-test'),
        'rendered',
      )
    })
    expect(apiMocks.recordManagedRuntimeNoticeReceipt).not.toHaveBeenCalledWith(
      'notice-failed',
      expect.any(String),
      'acknowledged',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(await screen.findByText(/provider state was missing/)).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => {
      expect(apiMocks.recordManagedRuntimeNoticeReceipt).toHaveBeenCalledWith(
        'notice-failed',
        noticeProfileId('device-notice-test'),
        'dismissed',
      )
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
