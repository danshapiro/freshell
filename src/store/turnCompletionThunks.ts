import type { TerminalTurnCompleteMessage } from '@shared/ws-protocol'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import { collectPaneEntries } from '@/lib/pane-utils'
import { resolveFreshAgentSessionKey } from '@/lib/pane-activity'
import type { FreshAgentPaneContent, PaneNode } from './paneTypes'
import { selectTabPaneByTerminalId } from './selectors/paneTerminalSelectors'
import { recordTurnComplete } from './turnCompletionSlice'
import type { AppDispatch, RootState } from './store'

export type ApplyServerCompletionPayload = {
  terminalId: string
  provider: TerminalTurnCompleteMessage['provider']
  at: number
  completionSeq: number
}

export function applyServerCompletion(payload: ApplyServerCompletionPayload) {
  return (dispatch: AppDispatch, getState: () => RootState): void => {
    const state = getState()
    const lastApplied = state.turnCompletion?.lastAppliedCompletionSeqByTerminalId?.[payload.terminalId]
    if (lastApplied !== undefined && payload.completionSeq <= lastApplied) return

    const location = selectTabPaneByTerminalId(state, payload.terminalId)
    if (!location) return

    dispatch(recordTurnComplete({
      tabId: location.tabId,
      paneId: location.paneId,
      terminalId: payload.terminalId,
      at: payload.at,
      completionSeq: payload.completionSeq,
    }))
  }
}

export type ApplyFreshAgentCompletionPayload = {
  provider: string
  sessionId: string
  at: number
}

/**
 * Server-authoritative fresh-agent turn completion. The provider adapters emit a
 * discrete turn-complete edge ONLY on a positive completion, so the client no longer
 * derives green/sound from the busy level. We resolve the owning tab/pane from the
 * `provider:sessionId` session key and fold the event into the GREEN/SOUND pipeline
 * via the `at`-monotonic dedupe regime (no completionSeq). The discrete edge is never
 * replayed from a snapshot, so a reconnect cannot re-green, and a stale/older `at` is
 * dropped. Across a real server restart the client clears the per-terminal `at`
 * baselines (resetCompletionDedupeBaselines), so a resumed durable session whose fresh
 * process stamps a lower wall-clock `at` is not swallowed.
 */
export function applyFreshAgentCompletion(payload: ApplyFreshAgentCompletionPayload) {
  return (dispatch: AppDispatch, getState: () => RootState): void => {
    const state = getState()
    const sessionKey = `${payload.provider}:${payload.sessionId}`
    const location = findFreshAgentPaneBySessionKey(state, sessionKey)
    if (!location) return

    dispatch(recordTurnComplete({
      tabId: location.tabId,
      paneId: location.paneId,
      terminalId: sessionKey,
      at: payload.at,
    }))
  }
}

export type ApplyFreshAgentWaitingPayload = {
  provider: string
  sessionId: string
  at: number
}

/**
 * Server-authoritative fresh-agent "waiting for approval/question" edge. Mirrors
 * applyFreshAgentCompletion but records under a distinct `#waiting` terminalId so the
 * approval attention can never poison (or be poisoned by) the turn-complete dedupe
 * bucket via the monotonic `at` guard. Only Claude/kilroy ever emit this today.
 *
 * Like the completion edge, the server buffers and replays this only to the FIRST
 * subscriber of a session (so a create-then-attach gap still greens once); a
 * reconnecting client gets NO replay and rehydrates pending state from the session
 * snapshot, which carries no waiting edge — so a still-pending approval does not
 * spuriously re-green on reconnect (matching the deleted hook's first-observation
 * suppression).
 */
export function applyFreshAgentWaiting(payload: ApplyFreshAgentWaitingPayload) {
  return (dispatch: AppDispatch, getState: () => RootState): void => {
    const state = getState()
    const sessionKey = `${payload.provider}:${payload.sessionId}`
    const location = findFreshAgentPaneBySessionKey(state, sessionKey)
    if (!location) return

    dispatch(recordTurnComplete({
      tabId: location.tabId,
      paneId: location.paneId,
      terminalId: `${sessionKey}#waiting`,
      at: payload.at,
    }))
  }
}

function findFreshAgentPaneBySessionKey(
  state: RootState,
  sessionKey: string,
): { tabId: string; paneId: string } | undefined {
  const layouts = state.panes?.layouts
  if (!layouts) return undefined
  const sessions = state.freshAgent?.sessions ?? {}
  const activeTabId = state.tabs?.activeTabId

  const scan = (tabId: string, layout: PaneNode): { tabId: string; paneId: string } | undefined => {
    for (const entry of collectPaneEntries(layout)) {
      if (entry.content.kind !== 'fresh-agent') continue
      const content = entry.content as FreshAgentPaneContent
      const session = content.sessionId
        ? sessions[makeFreshAgentSessionKey({
          sessionType: content.sessionType,
          provider: content.provider,
          sessionId: content.sessionId,
        })]
        : undefined
      // The server keys the completion event by the runtime handle it subscribed with
      // (`provider:content.sessionId`). For Claude/kilroy that runtime handle differs
      // from the durable Claude UUID carried in content.sessionRef, which
      // resolveFreshAgentSessionKey prefers — so we must match the runtime handle too,
      // or restored Claude sessions would silently drop every chime.
      const runtimeKey = content.sessionId ? `${content.provider}:${content.sessionId}` : undefined
      if (runtimeKey === sessionKey || resolveFreshAgentSessionKey(content, session) === sessionKey) {
        return { tabId, paneId: entry.paneId }
      }
    }
    return undefined
  }

  if (activeTabId && layouts[activeTabId]) {
    const hit = scan(activeTabId, layouts[activeTabId])
    if (hit) return hit
  }
  for (const [tabId, layout] of Object.entries(layouts)) {
    if (tabId === activeTabId || !layout) continue
    const hit = scan(tabId, layout)
    if (hit) return hit
  }
  return undefined
}
