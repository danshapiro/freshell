import { createPortal } from 'react-dom'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  clearDeadSessionAdjudication,
  resetFreshAgentPaneForReconcileCreate,
  resetPaneForReconcileCreate,
  resolveDeadSessionEntry,
} from '@/store/panesSlice'
import { closePaneWithCleanup } from '@/store/tabsSlice'
import { clearReconcileRuntime } from '@/store/freshAgentSlice'
import type { DeadSessionEntry } from '@/store/paneTypes'
import { OVERLAY_Z } from '@/components/ui/overlay'

/**
 * Batched dead-session adjudication panel (council rule 1 / F11-human):
 * ONE dialog listing ALL panes whose saved session the server reported
 * dead — never one modal per pane. Council rule 12: dead_session is a UI
 * state, not a deletion — nothing is auto-closed; every row waits for an
 * explicit user decision.
 */
export function DeadSessionPanel() {
  const dispatch = useAppDispatch()
  // Default OUTSIDE the selector: `?? []` inside would mint a new array per
  // call and trip react-redux's memoization warning.
  const entries = useAppSelector((s) => s.panes.deadSessionAdjudication) ?? []

  if (entries.length === 0) return null

  const handleStartFresh = (entry: DeadSessionEntry) => {
    // I7: same createRequestId — both reducers preserve it; only intent
    // resets to a fresh, identity-less create. The reducer must match the
    // pane kind: the terminal reducer no-ops on fresh-agent content (and
    // vice versa), which would silently wedge the row.
    if (entry.kind === 'fresh-agent') {
      if (entry.sessionRef) {
        dispatch(clearReconcileRuntime({
          provider: entry.sessionRef.provider,
          sessionIds: [entry.sessionRef.sessionId],
        }))
      }
      dispatch(resetFreshAgentPaneForReconcileCreate({ tabId: entry.tabId, paneId: entry.paneId, intent: 'fresh' }))
    } else {
      dispatch(resetPaneForReconcileCreate({ tabId: entry.tabId, paneId: entry.paneId, intent: 'fresh' }))
    }
    dispatch(resolveDeadSessionEntry({ tabId: entry.tabId, paneId: entry.paneId }))
  }

  const handleClosePane = (entry: DeadSessionEntry) => {
    dispatch(closePaneWithCleanup({ tabId: entry.tabId, paneId: entry.paneId }))
    dispatch(resolveDeadSessionEntry({ tabId: entry.tabId, paneId: entry.paneId }))
  }

  return createPortal(
    <div
      className={`fixed inset-0 flex items-center justify-center bg-black/50 ${OVERLAY_Z.modal}`}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Dead sessions"
        className="bg-background border border-border rounded-lg shadow-lg w-full max-w-lg mx-4 p-5 max-h-[80vh] flex flex-col"
      >
        <h2 className="text-lg font-semibold mb-2">Dead sessions</h2>
        <p className="text-sm text-muted-foreground mb-4">
          These panes reference saved sessions that no longer exist. Nothing has been
          closed — choose what to do with each pane.
        </p>
        <ul className="space-y-3 overflow-y-auto flex-1 min-h-0">
          {entries.map((entry) => (
            <li
              key={`${entry.tabId}:${entry.paneId}`}
              className="flex items-center justify-between gap-3 border border-border rounded-md p-3"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{entry.title}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {entry.mode}
                  {entry.reason ? ` — ${entry.reason}` : ''}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => handleStartFresh(entry)}
                  className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
                >
                  Start fresh here
                </button>
                <button
                  onClick={() => handleClosePane(entry)}
                  className="px-3 py-1.5 text-xs border border-border rounded-md hover:bg-muted transition-colors"
                >
                  Close pane
                </button>
              </div>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end">
          {/* Dismiss keeps the per-pane restoreError cards — panes stay untouched. */}
          <button
            onClick={() => dispatch(clearDeadSessionAdjudication())}
            className="px-4 py-2 text-sm border border-border rounded-md hover:bg-muted transition-colors"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
