import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector, useAppStore } from '@/store/hooks'
import { clearReconcileWarming } from '@/store/panesSlice'
import { buildReconcileRequestForPanes, foldVerdicts, paneKeyFor } from '@/lib/pane-reconcile'
import { getWsClient } from '@/lib/ws-client'
import { createLogger } from '@/lib/client-logger'
import type { PaneReconcileRequest } from '@shared/ws-protocol'
import type { RootState } from '@/store/store'
import type {
  FreshAgentPaneContent,
  PaneNode,
  TerminalPaneContent,
} from '@/store/paneTypes'

// Automatic parked-pane recovery (kata vnpc): when the session index reports
// readiness (the ready frame's `sessionIndexReady` state or the
// `sessions.index.ready` broadcast — both folded into
// connection.sessionIndexReady by Task 5), re-issue ONE pane.reconcile
// request for exactly the identity-matching warming panes. This is the
// banner's manual Retry round-trip, automated: same request builder, same
// fold-ownership rule, same clear-on-resolved semantics. The derivation is a
// pure idempotent read server-side; single-writer protection is unchanged.
// Renders null; mounted once beside <ReconcileWarmingBanner />. The banner's
// Retry button remains the non-routine escape hatch (genuine failures,
// ancient servers) — this driver automates routine warming, it does not
// replace it.

const log = createLogger('reconcile-warming-recovery')

/** Bounded backoff between automatic drives while a result still reports warming. */
export const RECOVERY_RETRY_BACKOFF_MS = 2_000
/** Max automatic drives per readiness observation (a new handshake resets the budget). */
export const RECOVERY_RETRY_LIMIT = 2
/** In-flight watchdog for a drive's pane.reconcile.result (mirrors RECONCILE_RESULT_WAIT_MS). */
export const RECOVERY_RESULT_WAIT_MS = 10_000

type ReconcilablePaneContent = TerminalPaneContent | FreshAgentPaneContent

/** Find a pane's CURRENT reconcilable content by tab/pane id (leaf walk). */
function paneContentForRef(
  state: RootState,
  tabId: string,
  paneId: string,
): ReconcilablePaneContent | undefined {
  let found: ReconcilablePaneContent | undefined
  ;(function walk(node: PaneNode | undefined): void {
    if (!node || found !== undefined) return
    if (node.type === 'leaf') {
      if (node.id === paneId && (node.content?.kind === 'terminal' || node.content?.kind === 'fresh-agent')) {
        found = node.content
      }
      return
    }
    walk(node.children[0])
    walk(node.children[1])
  })(state.panes.layouts[tabId])
  return found
}

/**
 * Derived re-run signal for the drive effect: changes identity whenever a
 * warming pane's PRESENCE or IDENTITY changes. Keying on paneKey alone would
 * stay unchanged when a parked pane is rebound via Replace pane (the same
 * paneId with NEW content), so the effect would never re-run its identity
 * check; including the CURRENT content's createRequestId makes any rebind
 * re-run the filter and cancel the replaced pane's pending recovery
 * immediately (auto-restore-warming round-3 finding 3).
 */
function warmingIdentityTick(state: RootState): string {
  const warming = state.panes.reconcileWarming
  if (!warming || warming.count <= 0) return ''
  return warming.paneRefs
    .map((r) => `${r.tabId}:${r.paneId}:${paneContentForRef(state, r.tabId, r.paneId)?.createRequestId ?? 'gone'}`)
    .join(',')
}

/** The diagnosis fields every drive/settle/gave-up/watchdog/refusal log carries. */
function driveContext(request: PaneReconcileRequest): string {
  const paneKeys = request.panes.map((p) => p.paneKey).join(',')
  const sessions = request.panes
    .map((p) => (p.sessionRef ? `${p.sessionRef.provider}:${p.sessionRef.sessionId}` : '-'))
    .join(',')
  return `reconcileId=${request.reconcileId} paneCount=${request.panes.length} paneKeys=${paneKeys} sessions=${sessions}`
}

interface PendingDrive {
  request: PaneReconcileRequest
  unsubscribe: () => void
  watchdog: number
  startedAt: number
}

export function ReconcileWarmingRecoveryDriver(): null {
  const warming = useAppSelector((s) => s.panes.reconcileWarming)
  const sessionIndexReady = useAppSelector((s) => s.connection.sessionIndexReady)
  const lastReadyAt = useAppSelector((s) => s.connection.lastReadyAt)
  const identityTick = useAppSelector(warmingIdentityTick)
  const store = useAppStore()
  const dispatch = useAppDispatch()
  const [recoveryTick, setRecoveryTick] = useState(0)
  const pendingRef = useRef<PendingDrive | null>(null)
  const backoffRef = useRef<number | null>(null)
  const attemptsRef = useRef(0)
  const lastReadySeenRef = useRef<number>(-1)

  const clearPending = useCallback(() => {
    const pending = pendingRef.current
    if (pending) {
      window.clearTimeout(pending.watchdog)
      pending.unsubscribe()
      pendingRef.current = null
    }
    if (backoffRef.current !== null) {
      window.clearTimeout(backoffRef.current)
      backoffRef.current = null
    }
  }, [])

  /**
   * The re-arm path shared by the watchdog expiry, the correlated refusal,
   * and the bounded backoff: drop whatever is in flight and bump the
   * recovery tick so the effect re-evaluates and re-drives while the
   * attempt budget allows. Event-driven only — no interval, no polling.
   */
  const rearmDrive = useCallback(() => {
    clearPending()
    setRecoveryTick((tick) => tick + 1)
  }, [clearPending])

  /**
   * Issue ONE pane.reconcile drive for the given request: subscribe with
   * fold-ownership by reconcileId, arm the result watchdog, and send. The
   * fold's own verdict handling (cardinality first, clear-on-resolved,
   * bounded backoff / gave-up) lives here beside the subscription it owns.
   */
  const driveOnce = useCallback(
    (request: PaneReconcileRequest): void => {
      const startedAt = Date.now()
      log.info(`drive ${attemptsRef.current}/${RECOVERY_RETRY_LIMIT} (${driveContext(request)})`)
      const ws = getWsClient()
      const unsubscribe = ws.onMessage((msg) => {
        if (pendingRef.current?.request !== request) return // drive already finished
        // Correlated server refusal for THIS reconcileId
        // (RECONCILE_TOO_LARGE / RECONCILE_UNAVAILABLE class): drop the drive
        // now with the cause — never wait out the watchdog.
        if (msg.type === 'error') {
          if (msg.requestId !== request.reconcileId) return
          log.warn(
            `drive refused (cause=${msg.code}, elapsedMs=${Date.now() - startedAt}, ${driveContext(request)})`,
          )
          rearmDrive()
          return
        }
        if (msg.type !== 'pane.reconcile.result') return
        // Fold-ownership rule (pane-reconcile.ts): fold ONLY the result whose
        // reconcileId THIS drive minted; foreign reconciles are skipped.
        if (msg.reconcileId !== request.reconcileId) return
        clearPending()
        // Focused review round 2, finding 3: correlate each verdict against
        // the SETTLE-TIME warming state — the parked set as it stands at
        // result arrival, after any mid-drive closure/rebind pruned it,
        // BEFORE this drive's own folds mutate it. Only a pane still parked
        // warming under the SAME createRequestId this drive sent is
        // recovery-relevant; a closed or rebound pane's stale verdict folds
        // nothing (the reducers' identity guard rejects it), and its
        // outcome is a CANCELED recovery, not a failed one.
        const warmingAtSettle = store.getState().panes.reconcileWarming
        const outcome = foldVerdicts(dispatch, request, msg)
        // Cardinality violation FIRST (mirror the banner handler): a
        // malformed result folds NOTHING — keep the banner + manual Retry.
        if (outcome.cardinalityViolation) {
          log.warn(
            `cardinality violation in result — keeping the banner (cause=cardinality-violation, ${driveContext(request)})`,
          )
          return
        }
        // Delta fix finding 2 + focused review round 3, finding 1:
        // TERMINAL outcomes are warn-level (the production client-logger
        // default records warn, suppresses info). A pane THIS drive sent
        // that is STILL warming-relevant at settle and resolves to a
        // terminal failure outcome — an error verdict (any non-warming
        // reason), dead_session (the readiness re-drive confirmed the
        // saved session is gone), or invalid (the claim was rejected) —
        // is a failure transition: log it once per drive result with the
        // verdict and failure cause, the pane and session identifiers,
        // and the drive's elapsed time (focused review round 2, finding
        // 1: the elapsed time must live in THIS record — the info-level
        // `settled` message that also carries it is suppressed in
        // production). A still-warming verdict is the unchanged WAIT, not
        // a terminal outcome: it never produces a per-pane warn here (the
        // bounded backoff debug log and the gave-up aggregate warn at the
        // retry limit are its records), so nothing repeats per poll.
        // Focused review round 2, finding 3: only panes STILL
        // warming-relevant at settle (present in the settle-time warming
        // map with the same createRequestId) get a failure record — a
        // pane closed or rebound mid-drive never does.
        for (const verdict of msg.verdicts) {
          const terminalFailureOutcome =
            verdict.verdict === 'dead_session'
            || verdict.verdict === 'invalid'
            || (verdict.verdict === 'error' && verdict.reason !== 'index_warming')
          if (!terminalFailureOutcome) continue
          const pane = request.panes.find((p) => p.paneKey === verdict.paneKey)
          if (!pane) continue
          const stillWarmingAtSettle = warmingAtSettle?.paneRefs.some(
            (r) =>
              paneKeyFor(r.tabId, r.paneId) === verdict.paneKey &&
              r.createRequestId === pane.createRequestId,
          )
          if (!stillWarmingAtSettle) continue
          log.warn(
            `parked pane recovery failed (verdict=${verdict.verdict}, cause=${verdict.reason ?? 'unknown'}, elapsedMs=${Date.now() - startedAt}, paneKey=${verdict.paneKey}, session=${pane.sessionRef ? `${pane.sessionRef.provider}:${pane.sessionRef.sessionId}` : '-'}, reconcileId=${request.reconcileId})`,
          )
        }
        if (outcome.warming === 0) {
          dispatch(clearReconcileWarming())
          log.info(
            `settled: all parked panes resolved in ${Date.now() - startedAt}ms (${driveContext(request)})`,
          )
          return
        }
        if (attemptsRef.current < RECOVERY_RETRY_LIMIT) {
          log.debug(
            `still warming after drive ${attemptsRef.current}/${RECOVERY_RETRY_LIMIT} — bounded backoff ${RECOVERY_RETRY_BACKOFF_MS}ms (${driveContext(request)})`,
          )
          backoffRef.current = window.setTimeout(rearmDrive, RECOVERY_RETRY_BACKOFF_MS)
          return
        }
        log.warn(
          `gave up after ${attemptsRef.current} drives (cause=still-warming, durationMs=${Date.now() - startedAt}, ${driveContext(request)}) — banner and manual Retry remain`,
        )
      })
      const watchdog = window.setTimeout(() => {
        log.warn(
          `result wait expired — dropping drive (cause=result-lost, elapsedMs=${Date.now() - startedAt}, ${driveContext(request)})`,
        )
        rearmDrive()
      }, RECOVERY_RESULT_WAIT_MS)
      pendingRef.current = { request, unsubscribe, watchdog, startedAt }
      // ws.send never throws on a dead socket (optional-chained no-op, ledger
      // F2) — the watchdog above is the disconnect safety net, mirroring the
      // banner's own Retry which also does not guard the send.
      ws.send(request)
    },
    [dispatch, rearmDrive, clearPending, store],
  )

  // Unmount safety: drop any in-flight subscription/timer.
  useEffect(() => () => clearPending(), [clearPending])

  useEffect(() => {
    // A new handshake (connection.lastReadyAt) is a new readiness
    // observation: the retry budget resets here, BEFORE this run's drive
    // decision — a reconnect re-drives with a fresh budget even while
    // sessionIndexReady stays true (round-1 finding 5).
    if (lastReadyAt !== undefined && lastReadyAt !== lastReadySeenRef.current) {
      lastReadySeenRef.current = lastReadyAt
      attemptsRef.current = 0
    }

    if (!warming || warming.count <= 0) return
    // Identity-matching subset (round-2 finding 3): warming refs whose pane
    // still exists in the live layouts AND whose CURRENT content carries the
    // PARKED createRequestId. A pane replaced while waiting (same paneId,
    // new content) drops out — its pending recovery is canceled exactly as a
    // closed pane's is, never transferred to the replacement.
    const identityMatchingPaneRefs = warming.paneRefs.filter((ref) => {
      const content = paneContentForRef(store.getState(), ref.tabId, ref.paneId)
      return content !== undefined && content.createRequestId === ref.createRequestId
    })
    if (identityMatchingPaneRefs.length === 0) {
      log.debug(
        `no identity-matching panes remain — clearing (${warming.count} parked: ${warming.paneRefs
          .map((r) => paneKeyFor(r.tabId, r.paneId))
          .join(',')})`,
      )
      dispatch(clearReconcileWarming())
      return
    }
    if (!sessionIndexReady) return
    if (pendingRef.current || backoffRef.current !== null) return // single-flight through the backoff window
    if (attemptsRef.current >= RECOVERY_RETRY_LIMIT) return // bounded; a new handshake resets
    const request = buildReconcileRequestForPanes(store.getState(), identityMatchingPaneRefs)
    if (!request) {
      log.debug(
        `request builder found nothing reconcilable — clearing (${identityMatchingPaneRefs.length} refs: ${identityMatchingPaneRefs
          .map((r) => paneKeyFor(r.tabId, r.paneId))
          .join(',')})`,
      )
      dispatch(clearReconcileWarming())
      return
    }
    attemptsRef.current += 1
    driveOnce(request)
  }, [warming, identityTick, sessionIndexReady, lastReadyAt, recoveryTick, dispatch, store, driveOnce, clearPending])

  return null
}
