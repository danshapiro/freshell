import { configureStore } from '@reduxjs/toolkit'
import { Profiler, type ProfilerOnRenderCallback } from 'react'
import { Provider } from 'react-redux'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import connectionReducer from '@/store/connectionSlice'
import managedRuntimeReducer from '@/store/managedRuntimeSlice'
import tabRegistryReducer from '@/store/tabRegistrySlice'
import {
  MANAGED_RUNTIME_NOTICE_POLL_MS,
  ManagedRuntimeNotices,
  noticeProfileId,
} from '@/components/ManagedRuntimeNotices'
import type { ManagedRuntimeIncidentSummary, ManagedRuntimeNotice } from '@shared/managed-runtime'
import { ApiError } from '@/lib/api'

const apiMocks = vi.hoisted(() => ({
  getManagedRuntimeNotices: vi.fn(),
  getManagedRuntimeIncidentSummary: vi.fn(),
  recordManagedRuntimeNoticeReceipt: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>()
  return { ...original, ...apiMocks }
})

const incidentSummary: ManagedRuntimeIncidentSummary = {
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
}

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

function renderNotices(onRender?: ProfilerOnRenderCallback) {
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
      {onRender ? (
        <Profiler id="managed-runtime-notice" onRender={onRender}>
          <ManagedRuntimeNotices />
        </Profiler>
      ) : <ManagedRuntimeNotices />}
    </Provider>,
  )
  return store
}

function cleanupFailure(noticeId: string): ManagedRuntimeNotice {
  return {
    noticeId,
    kind: 'cleanup_failed',
    message: `Cleanup needs attention: ${noticeId}`,
    reference: noticeId,
    incidentIds: ['incident-one'],
    deliveryState: 'pending',
    createdAt: '2026-09-08T00:00:00.000Z',
  }
}

async function renderPollingNotices(notices: ManagedRuntimeNotice[], onRender?: ProfilerOnRenderCallback) {
  vi.useFakeTimers()
  apiMocks.getManagedRuntimeNotices.mockResolvedValue(notices)
  await act(async () => { renderNotices(onRender) })
}

async function pollNotices() {
  await act(async () => { await vi.advanceTimersByTimeAsync(MANAGED_RUNTIME_NOTICE_POLL_MS) })
}

async function clickNoticeButton(name: 'Details' | 'Dismiss') {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name })) })
}

function deferredDetails() {
  let resolve!: (value: ManagedRuntimeIncidentSummary) => void
  let reject!: (error: Error) => void
  const promise = new Promise<ManagedRuntimeIncidentSummary>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

describe('ManagedRuntimeNotices', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    apiMocks.recordManagedRuntimeNoticeReceipt.mockResolvedValue(undefined)
    apiMocks.getManagedRuntimeIncidentSummary.mockResolvedValue(incidentSummary)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('logs a background fetch failure without showing a decisionless popup', async () => {
    const cause = new Error('Notices service refused the request')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    apiMocks.getManagedRuntimeNotices.mockRejectedValue(cause)
    await act(async () => { renderNotices() })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText(cause.message)).not.toBeInTheDocument()
    expect(warn).toHaveBeenCalledWith('[ManagedRuntimeNotices]', expect.objectContaining({
      event: 'managed_runtime_notices_fetch_failed', profileId: noticeProfileId('device-notice-test'), err: cause,
    }))
  })

  it('keeps actionable cleanup context and action errors when background polling fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await renderPollingNotices([cleanupFailure('notice-one')])
    await clickNoticeButton('Details')
    expect(screen.getByRole('alert')).toHaveTextContent('provider state was missing')
    apiMocks.getManagedRuntimeIncidentSummary.mockRejectedValue(new Error('Details request refused'))
    await clickNoticeButton('Details')
    expect(screen.getByRole('alert')).toHaveTextContent('Details request refused')
    apiMocks.getManagedRuntimeNotices.mockRejectedValue(new Error('Background notices request refused'))
    await pollNotices()
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Cleanup needs attention: notice-one')
    expect(alert).toHaveTextContent('provider state was missing')
    expect(alert).toHaveTextContent('Details request refused')
    expect(alert).not.toHaveTextContent('Background notices request refused')
    expect(screen.getByRole('button', { name: 'Details' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeVisible()
    expect(warn).toHaveBeenCalledWith('[ManagedRuntimeNotices]', expect.objectContaining({ event: 'managed_runtime_notices_fetch_failed' }))
  })

  it('keeps expected background unavailability quiet during server recovery', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    apiMocks.getManagedRuntimeNotices.mockRejectedValue(new ApiError(503, 'Server is restarting'))
    await act(async () => { renderNotices() })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(warn).not.toHaveBeenCalled()
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

  it('keeps opened incident details visible across repeated polls of the same warning', async () => {
    await renderPollingNotices([cleanupFailure('notice-one')])
    await clickNoticeButton('Details')
    expect(screen.getByRole('alert')).toHaveTextContent('provider state was missing')

    for (let poll = 0; poll < 2; poll += 1) {
      await pollNotices()
      expect(screen.getByRole('alert')).toHaveTextContent('provider state was missing')
    }
    expect(apiMocks.getManagedRuntimeNotices).toHaveBeenCalledTimes(3)
    expect(apiMocks.getManagedRuntimeIncidentSummary).toHaveBeenCalledTimes(1)
  })

  it('clears opened details when polling replaces the visible warning', async () => {
    await renderPollingNotices([cleanupFailure('notice-one')])
    await clickNoticeButton('Details')
    expect(screen.getByRole('alert')).toHaveTextContent('provider state was missing')

    apiMocks.getManagedRuntimeNotices.mockResolvedValue([cleanupFailure('notice-two')])
    await pollNotices()
    expect(screen.getByRole('alert')).toHaveTextContent('Cleanup needs attention: notice-two')
    expect(screen.getByRole('alert')).not.toHaveTextContent('provider state was missing')
  })

  it('never commits the old incident cause under a replacement warning before effects run', async () => {
    const committedAlerts: string[] = []
    await renderPollingNotices([cleanupFailure('notice-one')], () => {
      // Profiler observes the actual committed DOM before passive effects.
      committedAlerts.push(screen.queryByRole('alert')?.textContent ?? '')
    })
    await clickNoticeButton('Details')
    expect(screen.getByRole('alert')).toHaveTextContent('provider state was missing')

    apiMocks.getManagedRuntimeNotices.mockResolvedValue([cleanupFailure('notice-two')])
    await pollNotices()
    const replacementAlerts = committedAlerts.filter((text) => text.includes('Cleanup needs attention: notice-two'))
    expect(replacementAlerts.length).toBeGreaterThan(0)
    for (const text of replacementAlerts) {
      expect(text).not.toContain('provider state was missing')
    }
  })

  it('clears opened details when dismissing advances to the next queued warning', async () => {
    await renderPollingNotices([cleanupFailure('notice-one'), cleanupFailure('notice-two')])
    await clickNoticeButton('Details')
    expect(screen.getByRole('alert')).toHaveTextContent('provider state was missing')

    await clickNoticeButton('Dismiss')
    expect(screen.getByRole('alert')).toHaveTextContent('Cleanup needs attention: notice-two')
    expect(screen.getByRole('alert')).not.toHaveTextContent('provider state was missing')
  })

  it.each(['success', 'failure'] as const)(
    'ignores a late Details %s after its warning is dismissed',
    async (result) => {
      await renderPollingNotices([cleanupFailure('notice-one')])
      const pending = deferredDetails()
      apiMocks.getManagedRuntimeIncidentSummary.mockReturnValue(pending.promise)
      await clickNoticeButton('Details')
      await clickNoticeButton('Dismiss')
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()

      await act(async () => {
        if (result === 'success') pending.resolve(incidentSummary)
        else pending.reject(new Error('Old details request failed'))
      })
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    },
  )

  it.each(['success', 'failure'] as const)(
    'ignores a late Details %s after polling replaces its warning',
    async (result) => {
      await renderPollingNotices([cleanupFailure('notice-one')])
      const pending = deferredDetails()
      apiMocks.getManagedRuntimeIncidentSummary.mockReturnValue(pending.promise)
      await clickNoticeButton('Details')
      apiMocks.getManagedRuntimeNotices.mockResolvedValue([cleanupFailure('notice-two')])
      await pollNotices()

      await act(async () => {
        if (result === 'success') pending.resolve(incidentSummary)
        else pending.reject(new Error('Old details request failed'))
      })
      expect(screen.getByRole('alert')).toHaveTextContent('Cleanup needs attention: notice-two')
      expect(screen.getByRole('alert')).not.toHaveTextContent('provider state was missing')
      expect(screen.getByRole('alert')).not.toHaveTextContent('Old details request failed')
    },
  )
})
