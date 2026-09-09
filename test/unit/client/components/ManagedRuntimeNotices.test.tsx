import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import connectionReducer from '@/store/connectionSlice'
import managedRuntimeReducer from '@/store/managedRuntimeSlice'
import tabRegistryReducer from '@/store/tabRegistrySlice'
import {
  MANAGED_RUNTIME_NOTICE_AUTO_ACK_MS,
  MANAGED_RUNTIME_NOTICE_POLL_MS,
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

  it('marks a stable per-profile notice rendered and records explicit dismissal', async () => {
    apiMocks.getManagedRuntimeNotices.mockResolvedValue([{
      noticeId: 'notice-one',
      kind: 'cleanup_succeeded',
      message: 'Found and cleaned up 1 lost agent process. Details are in the server logs. Reference: ABCD1234.',
      reference: 'ABCD1234',
      incidentIds: ['incident-one'],
      deliveryState: 'pending',
      createdAt: '2026-09-08T00:00:00.000Z',
    }])
    renderNotices()

    expect(await screen.findByRole('status')).toHaveTextContent('Found and cleaned up 1 lost agent process')
    await waitFor(() => {
      expect(apiMocks.recordManagedRuntimeNoticeReceipt).toHaveBeenCalledWith(
        'notice-one',
        noticeProfileId('device-notice-test'),
        'rendered',
      )
    })
    await userEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(await screen.findByText(/provider state was missing/)).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => {
      expect(apiMocks.recordManagedRuntimeNoticeReceipt).toHaveBeenCalledWith(
        'notice-one',
        noticeProfileId('device-notice-test'),
        'dismissed',
      )
    })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('poll refreshes do not postpone the stable notice auto-ack deadline', async () => {
    vi.useFakeTimers()
    apiMocks.getManagedRuntimeNotices.mockImplementation(async () => [{
      noticeId: 'notice-stable',
      kind: 'cleanup_succeeded',
      message: 'Found and cleaned up 1 lost agent process. Details are in the server logs. Reference: STABLE01.',
      reference: 'STABLE01',
      incidentIds: ['incident-one'],
      deliveryState: 'rendered',
      createdAt: '2026-09-08T00:00:00.000Z',
    }])
    renderNotices()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    for (let elapsed = 0; elapsed < MANAGED_RUNTIME_NOTICE_AUTO_ACK_MS; elapsed += MANAGED_RUNTIME_NOTICE_POLL_MS) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MANAGED_RUNTIME_NOTICE_POLL_MS)
      })
    }
    expect(apiMocks.getManagedRuntimeNotices.mock.calls.length).toBeGreaterThan(2)
    expect(apiMocks.recordManagedRuntimeNoticeReceipt).toHaveBeenCalledWith(
      'notice-stable',
      noticeProfileId('device-notice-test'),
      'acknowledged',
    )
  })

  it('auto-acknowledges only after the notice remained visible long enough', async () => {
    vi.useFakeTimers()
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
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByRole('alert')).toHaveTextContent('No unrelated process was touched')
    expect(apiMocks.recordManagedRuntimeNoticeReceipt).not.toHaveBeenCalledWith(
      'notice-failed',
      expect.any(String),
      'acknowledged',
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MANAGED_RUNTIME_NOTICE_AUTO_ACK_MS)
    })
    expect(apiMocks.recordManagedRuntimeNoticeReceipt).toHaveBeenCalledWith(
      'notice-failed',
      noticeProfileId('device-notice-test'),
      'acknowledged',
    )
  })
})
