import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import { TerminalStuckSchema } from '@shared/ws-protocol'
import { collectPaneEntries } from '@/lib/pane-utils'
import { resolveFreshAgentSessionKey } from '@/lib/pane-activity'
import type { FreshAgentPaneContent, PaneNode } from './paneTypes'
import { selectTabPaneByTerminalId } from './selectors/paneTerminalSelectors'
import { advanceCompletionBaseline, recordTerminalIdle, recordTurnComplete } from './turnCompletionSlice'
import type { ReadyMessage } from '@shared/ws-protocol'
import { createLogger } from '@/lib/client-logger'
import { clearTerminalStuck, recordTerminalStuck } from './terminalLifecycleSlice'
import type { AppDispatch, RootState } from './store'

const log = createLogger('TurnCompletion')

function completionDedupeKey(provider: string, sessionId: string): string {
  return `${provider}:${sessionId}`
}

function waitingDedupeKey(provider: string, sessionId: string): string {
  return `${completionDedupeKey(provider, sessionId)}#waiting`
}

/** A newly registered session's first turn can end while this page is offline. */
export function observeFreshAgentSession(payload: { provider: string; sessionId: string }) {
  return (dispatch: AppDispatch): void => {
    for (const terminalId of [completionDedupeKey(payload.provider, payload.sessionId), waitingDedupeKey(payload.provider, payload.sessionId)]) {
      dispatch(advanceCompletionBaseline({ terminalId, at: 0 }))
    }
  }
}

/** Materialization changes the envelope, not what this page has witnessed. */
export function rekeyFreshAgentAttention(payload: { provider: string; previousSessionId: string; sessionId: string }) {
  return (dispatch: AppDispatch, getState: () => RootState): void => {
    for (const keyFor of [completionDedupeKey, waitingDedupeKey]) {
      const previousKey = keyFor(payload.provider, payload.previousSessionId)
      const at = getState().turnCompletion?.lastAtByTerminalId[previousKey] ?? 0
      dispatch(advanceCompletionBaseline({ terminalId: keyFor(payload.provider, payload.sessionId), at }))
    }
  }
}

/** First observation seeds silently; a same-page reconnect replays unseen edges. */
export function foldReadyFreshAgentAttention(marks: ReadyMessage['freshAgentAttention']) {
  return (dispatch: AppDispatch, getState: () => RootState): void => {
    for (const mark of marks ?? []) {
      const payload = { provider: mark.provider, sessionId: mark.sessionId }
      for (const [terminalId, at, apply] of [
        [completionDedupeKey(mark.provider, mark.sessionId), mark.lastTurnCompleteAt, applyFreshAgentCompletion],
        [waitingDedupeKey(mark.provider, mark.sessionId), mark.lastWaitingAt, applyFreshAgentWaiting],
      ] as const) {
        const known = getState().turnCompletion.lastAtByTerminalId[terminalId]
        if (known === undefined) {
          dispatch(advanceCompletionBaseline({ terminalId, at: at ?? 0 }))
        } else if (at !== undefined && at > known) {
          log.info('fresh_agent_attention_replayed', { terminalId, at })
          dispatch(apply({ ...payload, at }))
        }
      }
    }
  }
}

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
}

/**
 * Server-authoritative fresh-agent turn completion. The provider adapters emit a
 * discrete turn-complete edge for ANY turn end except a user-initiated interrupt —
 * successes, errors, max-turns, crashes, deadman fires, and mid-turn stream
 * exceptions all ring the same unified attention signal — so the client never
 * derives green/sound from the busy level or the turn's outcome. We resolve the
 * owning tab/pane from the `provider:sessionId` session key and fold the event into
 * the GREEN/SOUND pipeline via the `at`-monotonic dedupe regime (no completionSeq).
 * A reconnect's ready marks replay only edges this page missed. First connect,
 * reload and server restart seed without replaying history. Equal or older `at`
 * values are dropped by the same baseline as live edges.
 */
export function applyFreshAgentCompletion(payload: ApplyFreshAgentCompletionPayload) {
  return (dispatch: AppDispatch, getState: () => RootState): void => {
    dispatch(observeFreshAgentSession(payload))
    const state = getState()
    const sessionKey = completionDedupeKey(payload.provider, payload.sessionId)
    const location = findFreshAgentPaneBySessionKey(state, sessionKey)
    if (!location) {
      dispatch(advanceCompletionBaseline({ terminalId: sessionKey, at: payload.at }))
      return
    }

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
 * bucket via the monotonic `at` guard. Claude/kilroy and codex controls emit
 * this edge on their own 0→≥1 pending approval/question transitions.
 *
 * Ready replay includes a waiting mark only while a control is still pending.
 * The separate high-water mark prevents a completed turn from swallowing a
 * waiting edge, and prevents a reconnect from ringing the same approval twice.
 */
export function applyFreshAgentWaiting(payload: ApplyFreshAgentWaitingPayload) {
  return (dispatch: AppDispatch, getState: () => RootState): void => {
    dispatch(observeFreshAgentSession(payload))
    const state = getState()
    const sessionKey = completionDedupeKey(payload.provider, payload.sessionId)
    const terminalId = waitingDedupeKey(payload.provider, payload.sessionId)
    const location = findFreshAgentPaneBySessionKey(state, sessionKey)
    if (!location) {
      dispatch(advanceCompletionBaseline({ terminalId, at: payload.at }))
      return
    }

    dispatch(recordTurnComplete({
      tabId: location.tabId,
      paneId: location.paneId,
      terminalId,
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
