import { useEffect, useRef } from 'react'
import { useAppDispatch, useAppSelector, useAppStore } from '@/store/hooks'
import { clearReconcileWarming } from '@/store/panesSlice'
import { buildReconcileRequestForPanes, foldVerdicts } from '@/lib/pane-reconcile'
import { getWsClient } from '@/lib/ws-client'
import type { PaneReconcileRequest } from '@shared/ws-protocol'
import { OVERLAY_Z } from '@/components/ui/overlay'

/**
 * ONE warming banner for ALL panes whose reconcile verdicts came back
 * retryable reconciliation deferrals — never one banner per pane. This state
 * is expected while the session index warms or a predecessor runtime finishes
 * retirement, so "Retry now" is the prominent recovery path.
 */
export function ReconcileWarmingBanner() {
  const dispatch = useAppDispatch()
  const store = useAppStore()
  const warming = useAppSelector((s) => s.panes.reconcileWarming)
  const pendingRef = useRef<{ request: PaneReconcileRequest; unsubscribe: () => void } | null>(null)

  // Unmount safety: drop any in-flight retry subscription.
  useEffect(
    () => () => {
      pendingRef.current?.unsubscribe()
      pendingRef.current = null
    },
    [],
  )

  if (!warming || warming.count <= 0) return null

  const handleRetry = () => {
    // Re-send a reconcile request for EXACTLY the warming panes.
    const request = buildReconcileRequestForPanes(store.getState(), warming.paneRefs)
    if (!request) {
      // None of the warming panes are reconcilable any more (closed, etc.).
      dispatch(clearReconcileWarming())
      return
    }
    // Supersede an older in-flight retry: last click wins.
    pendingRef.current?.unsubscribe()
    const ws = getWsClient()
    // Task-12 pattern: subscribe -> match reconcileId -> foldVerdicts -> unsubscribe.
    const unsubscribe = ws.onMessage((msg) => {
      if (msg.type !== 'pane.reconcile.result') return
      // Fold-ownership rule (pane-reconcile.ts): fold ONLY the result whose
      // reconcileId THIS Retry minted; foreign reconciles are silently skipped.
      if (msg.reconcileId !== request.reconcileId) return
      pendingRef.current?.unsubscribe()
      pendingRef.current = null
      const outcome = foldVerdicts(dispatch, request, msg)
      if (outcome.cardinalityViolation) {
        console.error(
          'reconcile warming retry: cardinality violation in result — keeping the banner; Retry again',
        )
        return
      }
      if (outcome.warming === 0) {
        // foldVerdicts re-sets the warming state itself when verdicts are
        // still warm; a fully-resolved retry clears the banner here.
        dispatch(clearReconcileWarming())
      }
    })
    pendingRef.current = { request, unsubscribe }
    ws.send(request)
  }

  return (
    <div
      role="status"
      className={`fixed top-3 left-1/2 -translate-x-1/2 ${OVERLAY_Z.menu} flex items-center gap-3 bg-background border border-border rounded-md shadow-lg px-4 py-2`}
    >
      <span className="text-sm">
        Waiting for session recovery — {warming.count} pane(s)
      </span>
      <button
        onClick={handleRetry}
        className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors shrink-0"
      >
        Retry now
      </button>
    </div>
  )
}
