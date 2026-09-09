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

const AUTO_ACK_MS = 10_000
const POLL_MS = 2_000

function noticeProfileId(deviceId: string | undefined): string {
  return `profile:${deviceId || 'local-user'}`
}

function cleanupLabel(summary: ManagedRuntimeIncidentSummary): string {
  if (summary.cleanup.verifiedEmpty) return 'Cleanup was verified empty.'
  if (summary.state === 'cleanup_pending') return 'Cleanup is still pending.'
  return 'Cleanup could not be verified; no unrelated process was touched.'
}

export function ManagedRuntimeNotices() {
  const connectionStatus = useAppSelector((state) => state.connection.status)
  const available = useAppSelector((state) => selectManagedRuntime(state).available)
  const inventoryRevision = useAppSelector((state) => selectManagedRuntime(state).revision)
  const deviceId = useAppSelector((state) => state.tabRegistry?.deviceId)
  const profileId = useMemo(() => noticeProfileId(deviceId), [deviceId])
  const [notices, setNotices] = useState<ManagedRuntimeNotice[]>([])
  const [details, setDetails] = useState<ManagedRuntimeIncidentSummary>()
  const [error, setError] = useState<string>()
  const [pollTick, setPollTick] = useState(0)
  const inFlightRef = useRef<AbortController>()

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
        setNotices(pending)
        setDetails(undefined)
        setError(undefined)
        await Promise.allSettled(pending.map((notice) => (
          recordManagedRuntimeNoticeReceipt(notice.noticeId, profileId, 'rendered')
        )))
      })
      .catch((cause) => {
        if (cancelled || isTransientRequestFailure(cause)) return
        setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [available, connectionStatus, inventoryRevision, pollTick, profileId])

  const current = notices[0]
  const currentNoticeId = current?.noticeId

  useEffect(() => {
    if (!currentNoticeId) return
    const timer = window.setTimeout(() => {
      void recordManagedRuntimeNoticeReceipt(currentNoticeId, profileId, 'acknowledged')
        .then(() => {
          setNotices((existing) => existing.filter((notice) => notice.noticeId !== currentNoticeId))
          setDetails(undefined)
        })
        .catch((cause) => {
          if (!isTransientRequestFailure(cause)) {
            setError(cause instanceof Error ? cause.message : String(cause))
          }
        })
    }, AUTO_ACK_MS)
    return () => window.clearTimeout(timer)
  }, [currentNoticeId, profileId])

  const dismiss = async () => {
    if (!current) return
    try {
      await recordManagedRuntimeNoticeReceipt(current.noticeId, profileId, 'dismissed')
      setNotices((existing) => existing.filter((notice) => notice.noticeId !== current.noticeId))
      setDetails(undefined)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const loadDetails = async () => {
    const incidentId = current?.incidentIds[0]
    if (!incidentId) return
    try {
      setDetails(await getManagedRuntimeIncidentSummary(incidentId))
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  if (!current && !error) return null

  const failed = current?.kind === 'cleanup_failed'
  return (
    <section
      aria-label="Managed runtime notice"
      aria-live={failed || error ? 'assertive' : 'polite'}
      className="fixed bottom-3 left-1/2 z-50 w-[min(40rem,calc(100vw-1.5rem))] -translate-x-1/2 rounded-lg border border-border bg-background p-3 shadow-xl"
      role={failed || error ? 'alert' : 'status'}
    >
      {current && (
        <>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {current.kind === 'cleanup_succeeded'
                  ? 'Recovered runtime cleanup complete'
                  : current.kind === 'cleanup_failed'
                    ? 'Runtime cleanup needs attention'
                    : 'Terminal session ended'}
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
          {notices.length > 1 && (
            <p className="mt-2 text-xs text-muted-foreground">
              {notices.length - 1} more runtime {notices.length === 2 ? 'notice' : 'notices'} pending.
            </p>
          )}
        </>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </section>
  )
}

export const MANAGED_RUNTIME_NOTICE_AUTO_ACK_MS = AUTO_ACK_MS
export const MANAGED_RUNTIME_NOTICE_POLL_MS = POLL_MS
export { noticeProfileId }
