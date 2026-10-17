import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import { TerminalStuckSchema } from '@shared/ws-protocol'
import { collectPaneEntries } from '@/lib/pane-utils'
import { resolveFreshAgentSessionKey } from '@/lib/pane-activity'
import type { FreshAgentPaneContent, PaneNode } from './paneTypes'
import { selectTabPaneByTerminalId } from './selectors/paneTerminalSelectors'
import { recordTerminalIdle, recordTurnComplete } from './turnCompletionSlice'
import { clearTerminalStuck, recordTerminalStuck } from './terminalLifecycleSlice'
import type { AppDispatch, RootState } from './store'

export type ApplyServerIdlePayload = {
  terminalId: string
  at: number
  reason: 'grace' | 'queue-empty'
}

/**
 * Server-authoritative truly-idle edge (`terminal.idle`) for terminal CLI panes.
 * The ONLY event that rings the bell / shades the tab for claude/codex/opencode/
 * amplifier terminal panes. Resolves the owning tab/pane by terminalId and folds
 * the edge into the notification pipeline under the `at`-monotonic idle dedupe
 * namespace (reconnect replay cannot re-ring).
 */
export function applyServerIdle(payload: ApplyServerIdlePayload) {
  return (dispatch: AppDispatch, getState: () => RootState): void => {
    const state = getState()
    const location = selectTabPaneByTerminalId(state, payload.terminalId)
    if (!location) return

    dispatch(recordTerminalIdle({
      tabId: location.tabId,
      paneId: location.paneId,
      terminalId: payload.terminalId,
      at: payload.at,
      reason: payload.reason,
    }))
  }
}

export type ApplyTerminalStuckPayload = {
  type: 'terminal.stuck'
  terminalId: string
  at: number
  stuck: boolean
}

/**
 * Server-authoritative wedged-agent flag (`terminal.stuck`) for terminal-mode
 * agent panes — the terminal-mode twin of freshcodex's `freshAgent.status:
 * 'stuck'` deadman. Parses the frame with TerminalStuckSchema, resolves the
 * owning tab/pane by terminalId (the applyServerIdle precedent), and folds
 * the flag into terminalLifecycleSlice keyed by paneId. NEVER dispatches a
 * turnCompletion/* action: the stuck card is surface-only — a wedged pane
 * must not fabricate a completion edge (green/sound), mirroring the
 * freshcodex deadman contract.
 */
export function applyTerminalStuck(payload: ApplyTerminalStuckPayload) {
  return (dispatch: AppDispatch, getState: () => RootState): void => {
    const parsed = TerminalStuckSchema.safeParse(payload)
    if (!parsed.success) return
    const { terminalId, at, stuck } = parsed.data

    const state = getState()
    const location = selectTabPaneByTerminalId(state, terminalId)
    if (!location) return

    if (stuck) {
      dispatch(recordTerminalStuck({
        paneId: location.paneId,
        terminalId,
        at,
      }))
    } else {
      dispatch(clearTerminalStuck({ paneId: location.paneId }))
    }
  }
}

export type ApplyFreshAgentCompletionPayload = {
  provider: string
  sessionId: string
  at: number
  outcome?: 'completed' | 'failed'
}

/**
 * Server-authoritative fresh-agent turn completion. The provider adapters emit a
 * discrete turn-complete edge for ANY turn end except a user-initiated interrupt —
 * successes, errors, max-turns, crashes, deadman fires, and mid-turn stream
 * exceptions all ring the same unified attention signal — so the client never
 * derives green/sound from the busy level or the turn's outcome. The fixed
 * outcome category is retained as metadata only. We resolve the
 * owning tab/pane from the `provider:sessionId` session key and fold the event into
 * the GREEN/SOUND pipeline via the `at`-monotonic dedupe regime (no completionSeq).
 * The discrete edge is never replayed from a snapshot, so a reconnect cannot
 * re-green, and a stale/older `at` is dropped. Across a real server restart the
 * client clears the per-terminal `at` baselines (resetCompletionDedupeBaselines),
 * so a resumed durable session whose fresh process stamps a lower wall-clock `at`
 * is not swallowed.
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
      ...(payload.outcome ? { outcome: payload.outcome } : {}),
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
 * bucket via the monotonic `at` guard. Claude/kilroy and codex controls emit
 * this edge on their own 0→≥1 pending approval/question transitions.
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
