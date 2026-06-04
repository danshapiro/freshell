import { useEffect, useRef } from 'react'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { collectPaneEntries } from '@/lib/pane-utils'
import {
  isAgentChatBusy,
  isFreshAgentBusy,
  resolveAgentChatSessionKey,
  resolveFreshAgentSessionKey,
} from '@/lib/pane-activity'
import { recordTurnComplete } from '@/store/turnCompletionSlice'
import type { ChatSessionState } from '@/store/agentChatTypes'
import type { FreshAgentSessionState } from '@/store/freshAgentTypes'

const EMPTY_FRESH_AGENT_SESSIONS: Record<string, FreshAgentSessionState> = {}
const EMPTY_AGENT_CHAT_SESSIONS: Record<string, ChatSessionState> = {}

type SessionEdgeState = { wasBusy: boolean; hadPending: boolean }

function hasWaitingItems(
  session: FreshAgentSessionState | ChatSessionState | undefined,
): boolean {
  if (!session) return false
  return Object.keys(session.pendingPermissions).length > 0
    || Object.keys(session.pendingQuestions).length > 0
}

/**
 * Bridges SDK-driven panes (fresh-agent + legacy agent-chat) into the existing
 * GREEN/SOUND pipeline. Watches each SDK pane's busy/pending edges and fires
 * recordTurnComplete on:
 *  - a real busy -> idle transition (turn complete), and
 *  - a 0 -> >=1 pending permission/question transition (waiting-for-approval).
 *
 * The synthetic terminalId is the pane's `provider:sessionId` session key, which
 * recordTurnComplete only uses as a dedupe key (markTab/PaneAttention key on
 * tabId/paneId). Never fires on the FIRST observation of a session, so tab
 * restore / snapshot hydration of an already-idle or already-pending session
 * does not produce a spurious green/sound.
 */
export function useAgentSessionTurnCompletion(): void {
  const dispatch = useAppDispatch()
  const layouts = useAppSelector((s) => s.panes?.layouts)
  const freshAgentSessions = useAppSelector((s) => s.freshAgent?.sessions ?? EMPTY_FRESH_AGENT_SESSIONS)
  const agentChatSessions = useAppSelector((s) => s.agentChat?.sessions ?? EMPTY_AGENT_CHAT_SESSIONS)
  const prevRef = useRef<Map<string, SessionEdgeState>>(new Map())

  useEffect(() => {
    if (!layouts) return
    const seen = new Set<string>()

    for (const [tabId, layout] of Object.entries(layouts)) {
      if (!layout) continue
      for (const entry of collectPaneEntries(layout)) {
        const content = entry.content
        let sessionKey: string | undefined
        let isBusy = false
        let hasPending = false

        if (content.kind === 'fresh-agent') {
          const session = content.sessionId
            ? freshAgentSessions[makeFreshAgentSessionKey({
              sessionType: content.sessionType,
              provider: content.provider,
              sessionId: content.sessionId,
            })]
            : undefined
          sessionKey = resolveFreshAgentSessionKey(content, session)
          isBusy = isFreshAgentBusy(content, session)
          hasPending = hasWaitingItems(session)
        } else if (content.kind === 'agent-chat') {
          const session = content.sessionId ? agentChatSessions[content.sessionId] : undefined
          sessionKey = resolveAgentChatSessionKey(content, session)
          isBusy = isAgentChatBusy(content, session)
          hasPending = hasWaitingItems(session)
        } else {
          continue
        }

        if (!sessionKey) continue
        seen.add(sessionKey)

        const prev = prevRef.current.get(sessionKey)
        if (prev === undefined) {
          // First observation: initialize without firing (avoids spurious green on
          // restore / snapshot hydration of an already-finished or pending session).
          prevRef.current.set(sessionKey, { wasBusy: isBusy, hadPending: hasPending })
          continue
        }

        // Waiting-for-approval: a fresh 0 -> >=1 pending transition.
        if (!prev.hadPending && hasPending) {
          dispatch(recordTurnComplete({
            tabId,
            paneId: entry.paneId,
            terminalId: sessionKey,
            at: Date.now(),
          }))
        } else if (prev.wasBusy && !isBusy && !hasPending) {
          // Turn complete: an observed busy -> idle with nothing pending.
          dispatch(recordTurnComplete({
            tabId,
            paneId: entry.paneId,
            terminalId: sessionKey,
            at: Date.now(),
          }))
        }

        prevRef.current.set(sessionKey, { wasBusy: isBusy, hadPending: hasPending })
      }
    }

    // Drop tracking for sessions whose panes are gone, so a later recreation is
    // treated as a fresh first-observation.
    for (const key of prevRef.current.keys()) {
      if (!seen.has(key)) prevRef.current.delete(key)
    }
  }, [layouts, freshAgentSessions, agentChatSessions, dispatch])
}
