import { useEffect, useMemo, useRef, useState } from 'react'
import { selectManagedRuntime } from '@/store/managedRuntimeSlice'
import type { ManagedRuntimeIncidentSummary, ManagedRuntimeNotice } from '@shared/managed-runtime'
import {
  getManagedRuntimeIncidentSummary,
  getManagedRuntimeNotices,
  isTransientRequestFailure,
  recordManagedRuntimeNoticeReceipt,
} from '@/lib/api'
import { useAppSelector } from '@/store/hooks'
import { createLogger } from '@/lib/client-logger'

const POLL_MS = 2_000
const log = createLogger('ManagedRuntimeNotices')

type NoticeDetails = {
  noticeId: string
  profileId: string
  summary: ManagedRuntimeIncidentSummary
}

function noticeProfileId(deviceId: string | undefined): string {
  return `profile:${deviceId || 'local-user'}`
}

function cleanupLabel(summary: ManagedRuntimeIncidentSummary): string {
  if (summary.cleanup.verifiedEmpty) return 'Cleanup was verified empty.'
  if (summary.state === 'cleanup_pending') return 'Cleanup is still pending.'
  return 'Cleanup could not be verified; no unrelated process was touched.'
}

function isRoutineNotice(notice: ManagedRuntimeNotice): boolean {
  return notice.kind === 'cleanup_succeeded' || notice.kind === 'ended_without_process'
}

function isCleanupFailureNotice(notice: ManagedRuntimeNotice): boolean {
  return notice.kind === 'cleanup_failed'
}

export function ManagedRuntimeNotices() {
  const connectionStatus = useAppSelector((state) => state.connection.status)
  const available = useAppSelector((state) => selectManagedRuntime(state).available)
  const inventoryRevision = useAppSelector((state) => selectManagedRuntime(state).revision)
  const deviceId = useAppSelector((state) => state.tabRegistry?.deviceId)
  const profileId = useMemo(() => noticeProfileId(deviceId), [deviceId])
  const [notices, setNotices] = useState<ManagedRuntimeNotice[]>([])
  const current = notices[0]
  const [loadedDetails, setLoadedDetails] = useState<NoticeDetails>()
  const details = loadedDetails
    && loadedDetails.noticeId === current?.noticeId
    && loadedDetails.profileId === profileId
    ? loadedDetails.summary
    : undefined
  const [error, setError] = useState<string>()
  const [pollTick, setPollTick] = useState(0)
  const inFlightRef = useRef<AbortController>()
  const acknowledgedRoutineIdsRef = useRef(new Set<string>())
  const renderedFailureIdsRef = useRef(new Set<string>())
  // Polls replace notice objects; the stable notice/profile identity owns
  // opened details and any response still pending when the warning changes.
  const currentNoticeRef = useRef({ noticeId: current?.noticeId, profileId })
  currentNoticeRef.current = { noticeId: current?.noticeId, profileId }

  useEffect(() => {
    setLoadedDetails(undefined)
  }, [current?.noticeId, profileId])

  useEffect(() => {
    acknowledgedRoutineIdsRef.current.clear()
    renderedFailureIdsRef.current.clear()
  }, [profileId])

  useEffect(() => {
    if (!available || connectionStatus !== 'ready') return
    const timer = window.setInterval(() => setPollTick((value) => value + 1), POLL_MS)
    return () => window.clearInterval(timer)
  }, [available, connectionStatus])

  useEffect(() => {
    if (!available || connectionStatus !== 'ready') {
      inFlightRef.current?.abort()
      return
    }
    const controller = new AbortController()
    inFlightRef.current?.abort()
    inFlightRef.current = controller
    let cancelled = false
    getManagedRuntimeNotices(profileId, 20, { signal: controller.signal })
      .then(async (pending) => {
        if (cancelled) return
        const routine = pending.filter(isRoutineNotice)
        const failures = pending.filter(isCleanupFailureNotice)
        setNotices(failures)
        setError(undefined)
        const routineToAcknowledge = routine.filter((notice) => {
          if (acknowledgedRoutineIdsRef.current.has(notice.noticeId)) return false
          acknowledgedRoutineIdsRef.current.add(notice.noticeId)
          return true
        })
        const failuresToMarkRendered = failures.filter((notice) => {
          if (notice.deliveryState !== 'pending' || renderedFailureIdsRef.current.has(notice.noticeId)) {
            return false
          }
          renderedFailureIdsRef.current.add(notice.noticeId)
          return true
        })
        await Promise.allSettled([
          ...routineToAcknowledge.map(async (notice) => {
            try {
              await recordManagedRuntimeNoticeReceipt(notice.noticeId, profileId, 'acknowledged')
            } catch {
              acknowledgedRoutineIdsRef.current.delete(notice.noticeId)
            }
          }),
          ...failuresToMarkRendered.map(async (notice) => {
            try {
              await recordManagedRuntimeNoticeReceipt(notice.noticeId, profileId, 'rendered')
            } catch {
              renderedFailureIdsRef.current.delete(notice.noticeId)
            }
          }),
        ])
      })
      .catch((cause) => {
        if (cancelled || controller.signal.aborted || isTransientRequestFailure(cause)) return
        log.warn({ event: 'managed_runtime_notices_fetch_failed', profileId, err: cause })
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [available, connectionStatus, inventoryRevision, pollTick, profileId])

  const dismiss = async () => {
    if (!current) return
    try {
      await recordManagedRuntimeNoticeReceipt(current.noticeId, profileId, 'dismissed')
      setNotices((existing) => existing.filter((notice) => notice.noticeId !== current.noticeId))
      setLoadedDetails(undefined)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const loadDetails = async () => {
    const incidentId = current?.incidentIds[0]
    const noticeId = current?.noticeId
    if (!incidentId || !noticeId) return
    const isCurrentNotice = () => (
      currentNoticeRef.current.noticeId === noticeId
      && currentNoticeRef.current.profileId === profileId
    )
    try {
      const summary = await getManagedRuntimeIncidentSummary(incidentId)
      if (!isCurrentNotice()) return
      setLoadedDetails({ noticeId, profileId, summary })
      setError(undefined)
    } catch (cause) {
      if (!isCurrentNotice()) return
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  if (!current) return null

  return (
    <section
      aria-label="Managed runtime notice"
      aria-live="assertive"
      className="fixed bottom-3 left-1/2 z-50 w-[min(40rem,calc(100vw-1.5rem))] -translate-x-1/2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 shadow-xl"
      role="alert"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            Runtime cleanup needs attention
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{current.message}</p>
          {details && (
            <p className="mt-2 text-xs text-muted-foreground">
              {details.observedCause} {cleanupLabel(details)}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {current.incidentIds.length > 0 && (
            <button
              className="rounded border border-border px-2 py-1 text-xs hover:bg-muted"
              onClick={() => void loadDetails()}
              type="button"
            >
              Details
            </button>
          )}
          <button
            className="rounded border border-border px-2 py-1 text-xs hover:bg-muted"
            onClick={() => void dismiss()}
            type="button"
          >
            Dismiss
          </button>
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </section>
  )
}

export const MANAGED_RUNTIME_NOTICE_POLL_MS = POLL_MS
export { noticeProfileId }
