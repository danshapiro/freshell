import { useEffect, useRef } from 'react'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { collectPaneEntries } from '@/lib/pane-utils'
import { resolveFreshAgentSessionKey } from '@/lib/pane-activity'
import { recordTurnComplete } from '@/store/turnCompletionSlice'
import type { FreshAgentSessionState } from '@/store/freshAgentTypes'

const EMPTY_FRESH_AGENT_SESSIONS: Record<string, FreshAgentSessionState> = {}

type SessionEdgeState = { hadPending: boolean }

function hasWaitingItems(session: FreshAgentSessionState | undefined): boolean {
  if (!session) return false
  return Object.keys(session.pendingPermissions).length > 0
    || Object.keys(session.pendingQuestions).length > 0
}

/**
 * Bridges the fresh-agent "waiting-for-approval" edge into the GREEN/SOUND pipeline.
 * Fires recordTurnComplete on a 0 -> >=1 pending permission/question transition.
 *
 * Turn COMPLETION (a finished turn) is no longer derived here: it is
 * server-authoritative via the discrete freshAgent.turn.complete event
 * (applyFreshAgentCompletion). Differentiating the client-side busy level to recover
 * a completion edge was the source of premature (flicker), missed (fast-turn), and
 * stale-color chimes, so that path is intentionally gone.
 *
 * The synthetic terminalId is the pane's `provider:sessionId` session key with a
 * `#waiting` suffix, which recordTurnComplete only uses as a dedupe key
 * (markTab/PaneAttention key on tabId/paneId). The suffix keeps this client-clock edge
 * in a separate dedupe namespace from the server turn-complete (`provider:sessionId`),
 * so an approval can never suppress a real completion via the monotonic `at` guard.
 * Never fires on the FIRST observation of a session, so tab restore / snapshot hydration
 * of an already-pending session does not produce a spurious green/sound.
 */
export function useAgentSessionTurnCompletion(): void {
  const dispatch = useAppDispatch()
  const layouts = useAppSelector((s) => s.panes?.layouts)
  const freshAgentSessions = useAppSelector((s) => s.freshAgent?.sessions ?? EMPTY_FRESH_AGENT_SESSIONS)
  const prevRef = useRef<Map<string, SessionEdgeState>>(new Map())

  useEffect(() => {
    if (!layouts) return
    const seen = new Set<string>()

    for (const [tabId, layout] of Object.entries(layouts)) {
      if (!layout) continue
      for (const entry of collectPaneEntries(layout)) {
        const content = entry.content
        if (content.kind !== 'fresh-agent') continue

        const session = content.sessionId
          ? freshAgentSessions[makeFreshAgentSessionKey({
            sessionType: content.sessionType,
            provider: content.provider,
            sessionId: content.sessionId,
          })]
          : undefined
        const sessionKey = resolveFreshAgentSessionKey(content, session)
        const hasPending = hasWaitingItems(session)

        if (!sessionKey) continue
        seen.add(sessionKey)

        const prev = prevRef.current.get(sessionKey)
        if (prev === undefined) {
          // First observation: initialize without firing (avoids spurious green on
          // restore / snapshot hydration of an already-pending session).
          prevRef.current.set(sessionKey, { hadPending: hasPending })
          continue
        }

        // Waiting-for-approval: a fresh 0 -> >=1 pending transition.
        if (!prev.hadPending && hasPending) {
          dispatch(recordTurnComplete({
            tabId,
            paneId: entry.paneId,
            // Distinct dedupe namespace from the server turn-complete (whose terminalId is
            // `provider:sessionId`). This edge uses the CLIENT clock; mixing it into the
            // server-completion entry would let an approval stamped ahead of the server
            // clock (common on a remote client) swallow the real completion as `at <= last`.
            terminalId: `${sessionKey}#waiting`,
            at: Date.now(),
          }))
        }

        prevRef.current.set(sessionKey, { hadPending: hasPending })
      }
    }

    // Drop tracking for sessions whose panes are gone, so a later recreation is
    // treated as a fresh first-observation.
    for (const key of prevRef.current.keys()) {
      if (!seen.has(key)) prevRef.current.delete(key)
    }
  }, [layouts, freshAgentSessions, dispatch])
}
