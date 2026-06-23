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
 * via the `at`-monotonic dedupe regime (no completionSeq): a wall-clock `at` is
 * inherently monotonic across a server restart, so a resumed durable session cannot
 * swallow real completions, and the discrete edge is never replayed from a snapshot
 * so a reconnect cannot re-green.
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
      if (resolveFreshAgentSessionKey(content, session) === sessionKey) {
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
