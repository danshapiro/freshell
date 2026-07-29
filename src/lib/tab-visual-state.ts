import type { Tab } from '@/store/types'
import type { PaneContent } from '@/store/paneTypes'

/**
 * Canonical tab visual states (presentation layer ONLY — the underlying
 * server-authoritative status machinery is untouched):
 *
 * - 'working'       GREY tab. An agent is actively working (formerly blue/busy).
 *                   Source: resolvePaneActivity via getBusyPaneIdsForTab.
 * - 'ready-unacked' GREEN tab + GREEN BAR. A turn completed (or the agent is
 *                   waiting for approval) and the user has not visited the tab
 *                   since. Source: turnCompletion.attentionByTab.
 * - 'ready'         GREEN tab, no bar. The agent has turned ready at least once
 *                   and the user has acknowledged (clicked/typed), OR the tab is
 *                   currently selected (a selected tab never shows the bar).
 *                   Source: turnCompletion.readyByTab (persistent) / attention on
 *                   the active tab.
 * - 'neutral'       Plain tab: shell tabs, agents that never completed a turn,
 *                   and tabs whose panes are all exited/errored.
 *
 * Edge-case decisions (locked):
 * - Waiting-for-approval => 'ready-unacked': the waiting edge suppresses busy
 *   (isFreshAgentBusy) and marks attention via the `#waiting` namespace, so it
 *   lands here naturally. The agent is blocked ON THE USER — an attention state.
 * - Completion on the ACTIVE tab shows plain green (no bar) while selected.
 *   Attention is not cleared by the mapping; existing dismissal semantics
 *   (click/switch/type via dismissTabGreen) decide when the flag goes away.
 * - A tab with no live pane is 'neutral' no matter what flags are set.
 */
export type TabVisualState = 'neutral' | 'working' | 'ready' | 'ready-unacked'

export interface TabVisualStateInputs {
  /** Any pane busy per resolvePaneActivity (getBusyPaneIdsForTab().length > 0). */
  isBusy: boolean
  /** turnCompletion.attentionByTab[tabId] — the unacknowledged flag. */
  hasAttention: boolean
  /** turnCompletion.readyByTab[tabId] — "turned ready at least once" (persistent). */
  isReady: boolean
  /** Tab is the currently selected tab. */
  isActive: boolean
  /** At least one pane is not exited/errored (see tabHasLivePane). */
  hasLivePane: boolean
}

export function resolveTabVisualState(input: TabVisualStateInputs): TabVisualState {
  if (!input.hasLivePane) return 'neutral'
  if (input.isBusy) return 'working'
  if (input.hasAttention && !input.isActive) return 'ready-unacked'
  if (input.hasAttention || input.isReady) return 'ready'
  return 'neutral'
}

/**
 * A tab is "live" when at least one pane can still do work. Terminal panes are
 * dead when exited/errored; fresh-agent and browser panes count as live (their
 * lifecycle is session-managed — an exited SDK session still shows its
 * transcript and can be resumed). With no pane entries (layout not hydrated),
 * fall back to the aggregate tab.status.
 */
export function tabHasLivePane(
  tab: Pick<Tab, 'status'>,
  paneEntries?: Array<{ content: PaneContent }>,
): boolean {
  if (paneEntries && paneEntries.length > 0) {
    return paneEntries.some((entry) =>
      entry.content.kind !== 'terminal'
      || (entry.content.status !== 'exited' && entry.content.status !== 'error'))
  }
  return tab.status !== 'exited' && tab.status !== 'error'
}
