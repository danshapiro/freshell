import type { Tab } from '@/store/types'
import type { PaneContent } from '@/store/paneTypes'

/**
 * Canonical tab visual states (presentation layer ONLY — the underlying
 * server-authoritative status machinery is untouched):
 *
 * GREEN is the RESTING state. Semantic: green = "ready for input", derived
 * purely from liveness + busyness — NOT from "has completed a turn".
 *
 * - 'working'       An agent is actively working (formerly blue/busy). Renders
 *                   IDENTICALLY to 'neutral' (plain tab) but is still exposed
 *                   via data-visual-state for tests/automation.
 *                   Source: resolvePaneActivity via getBusyPaneIdsForTab.
 * - 'ready-unacked' GREEN tab + GREEN BAR. A turn completed (or the agent is
 *                   waiting for approval) and the user has not visited the tab
 *                   since. Source: turnCompletion.attentionByTab.
 * - 'ready'         GREEN tab, no bar. The RESTING state: any live, non-busy
 *                   tab (idle shells included). Also the active tab holding
 *                   attention (a selected tab never shows the bar).
 * - 'neutral'       Plain tab: no live pane — all panes exited/errored, or the
 *                   tab is still creating / picker-only (not yet ready for
 *                   input).
 *
 * Edge-case decisions (locked):
 * - Waiting-for-approval => 'ready-unacked': the waiting edge suppresses busy
 *   (isFreshAgentBusy) and marks attention via the `#waiting` namespace, so it
 *   lands here naturally. The agent is blocked ON THE USER — an attention state.
 * - Completion on the ACTIVE tab shows plain green (no bar) while selected.
 *   Attention is not cleared by the mapping; existing dismissal semantics
 *   (click/switch/type via dismissTabGreen) decide when the flag goes away.
 * - A tab with no live pane is 'neutral' no matter what flags are set.
 * - Acknowledgement keeps the tab green with no persistent flag: ready is
 *   simply what a live, non-busy tab looks like.
 */
export type TabVisualState = 'neutral' | 'working' | 'ready' | 'ready-unacked'

export interface TabVisualStateInputs {
  /** Any pane busy per resolvePaneActivity (getBusyPaneIdsForTab().length > 0). */
  isBusy: boolean
  /** turnCompletion.attentionByTab[tabId] — the unacknowledged flag. */
  hasAttention: boolean
  /** Tab is the currently selected tab. */
  isActive: boolean
  /** At least one pane is ready for input (see tabHasLivePane). */
  hasLivePane: boolean
}

export function resolveTabVisualState(input: TabVisualStateInputs): TabVisualState {
  if (!input.hasLivePane) return 'neutral'
  if (input.isBusy) return 'working'
  if (input.hasAttention && !input.isActive) return 'ready-unacked'
  return 'ready'
}

/**
 * A tab is "live" when at least one pane is (or is about to be) ready for
 * input. Terminal panes are dead when exited/errored, and not YET live while
 * still 'creating'. Picker panes are not live (nothing to be ready for).
 * Recovering terminals count as live (transiently reattaching — they were
 * running and will be again). Fresh-agent, browser and other panes count as
 * live (their lifecycle is session-managed — an exited SDK session still
 * shows its transcript and can be resumed). With no pane entries (layout not
 * hydrated), fall back to the aggregate tab.status.
 */
export function tabHasLivePane(
  tab: Pick<Tab, 'status'>,
  paneEntries?: Array<{ content: PaneContent }>,
): boolean {
  if (paneEntries && paneEntries.length > 0) {
    return paneEntries.some((entry) => {
      if (entry.content.kind === 'picker') return false
      if (entry.content.kind !== 'terminal') return true
      const status = entry.content.status
      return status !== 'exited' && status !== 'error' && status !== 'creating'
    })
  }
  return tab.status !== 'exited' && tab.status !== 'error' && tab.status !== 'creating'
}
