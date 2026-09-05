// Reverse lookup: map a turn-completion sessionKey (`provider:sessionId`) to the
// tab/pane that owns the SDK session (fresh-agent).
//
// This is the SDK-pane analogue of selectTabPaneByTerminalId (which only matches
// terminal-kind panes). The sessionKey here is the `provider:sessionId` form
// produced by resolveFreshAgentSessionKey — NOT the
// fresh-agent slice-lookup key (makeFreshAgentSessionKey). See the plan's
// "TWO KEY NAMESPACES" note.

import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import { collectPaneEntries } from '@/lib/pane-utils'
import { resolveFreshAgentSessionKey } from '@/lib/pane-activity'
import { clearPaneAttention, clearTabAttention } from './turnCompletionSlice'
import type { AppDispatch, RootState } from './store'

export function selectPaneBySessionKey(
  state: RootState,
  sessionKey: string,
): { tabId: string; paneId: string } | null {
  const layouts = state.panes?.layouts
  if (!layouts) return null

  for (const [tabId, layout] of Object.entries(layouts)) {
    if (!layout) continue
    for (const entry of collectPaneEntries(layout)) {
      const content = entry.content
      if (content.kind === 'fresh-agent') {
        const session = content.sessionId
          ? state.freshAgent?.sessions?.[makeFreshAgentSessionKey({
            sessionType: content.sessionType,
            provider: content.provider,
            sessionId: content.sessionId,
          })]
          : undefined
        if (resolveFreshAgentSessionKey(content, session) === sessionKey) {
          return { tabId, paneId: entry.paneId }
        }
      }
    }
  }

  return null
}

/**
 * Dismiss a tab's green attention: clear the tab flag AND every pane in the tab
 * that still carries attention (not just the active pane). Single source of truth
 * for "the user visited this tab" clearing — used by pane focus, tab-switch, and
 * the tab-bar click. No-op when the tab has no attention.
 */
export function dismissTabGreen(tabId: string) {
  return (dispatch: AppDispatch, getState: () => RootState): void => {
    const tc = getState().turnCompletion
    if (!tc?.attentionByTab?.[tabId]) return
    dispatch(clearTabAttention({ tabId }))
    const layout = getState().panes?.layouts?.[tabId]
    if (!layout) return
    for (const entry of collectPaneEntries(layout)) {
      if (tc.attentionByPane?.[entry.paneId]) {
        dispatch(clearPaneAttention({ paneId: entry.paneId }))
      }
    }
  }
}

/**
 * kata 1wxv decision 10: rollback revokes the rolled-back turn's attention/green on
 * this device. sessionKey is the `provider:sessionId` turn-completion namespace.
 * PANE-SCOPED (r3 correction 7): clears ONLY the owning pane's attention entry, then
 * re-derives the TAB flag as the OR over the tab's REMAINING panes — a sibling pane's
 * attention (an unrelated completion in the same tab) SURVIVES the rollback; the tab is
 * blanket-cleared only when no remaining pane still holds attention. Never chimes and
 * never dispatches recordTurnComplete — an undone done is not done.
 */
export function revokeFreshAgentAttention(sessionKey: string) {
  return (dispatch: AppDispatch, getState: () => RootState): void => {
    const hit = selectPaneBySessionKey(getState(), sessionKey)
    if (!hit) return
    const { tabId, paneId } = hit
    const tc = getState().turnCompletion
    if (tc?.attentionByPane?.[paneId]) dispatch(clearPaneAttention({ paneId }))
    const layout = getState().panes?.layouts?.[tabId]
    const anyRemaining = layout
      ? collectPaneEntries(layout).some((entry) => (
        entry.paneId !== paneId && getState().turnCompletion.attentionByPane?.[entry.paneId]
      ))
      : false
    if (!anyRemaining && tc?.attentionByTab?.[tabId]) dispatch(clearTabAttention({ tabId }))
  }
}
