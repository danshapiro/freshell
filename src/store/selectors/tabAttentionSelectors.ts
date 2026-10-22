/**
 * Tab-surface needs-attention selectors — the ONE derivation every tab surface
 * (desktop TabItem, MobileTabStrip, TabSwitcher) reads.
 *
 * A tab's mark is the UNION of unwitnessed attention (`attentionByTab`) and
 * watched fresh-agent completions (`watchedCompletionByTab`, a tab-surface-
 * only mark that never reaches the sidebar or pane headers). The user's
 * `tabAttentionStyle: 'none'` hides every mark on every tab surface.
 */
import { createSelector } from '@reduxjs/toolkit'
import { selectTabStripAttention } from '@/store/turnCompletionAttention'
import type { RootState } from '@/store/store'
import type { TabAttentionStyle } from '@/store/types'

export { selectTabStripAttention }

const EMPTY_MARKS: Record<string, boolean> = {}

export function selectTabAttentionStyle(state: RootState): TabAttentionStyle {
  return state.settings.settings.panes?.tabAttentionStyle ?? 'highlight'
}

/** Tab ids, in tab-strip order, that carry the union mark ([] when hidden). */
export const selectAttentionTabIds = createSelector(
  [
    (state: RootState) => state.tabs.tabs,
    (state: RootState) => state.turnCompletion?.attentionByTab ?? EMPTY_MARKS,
    (state: RootState) => state.turnCompletion?.watchedCompletionByTab ?? EMPTY_MARKS,
    selectTabAttentionStyle,
  ],
  (tabs, attentionByTab, watchedCompletionByTab, style): string[] => {
    if (style === 'none') return []
    return tabs
      .filter((tab) => attentionByTab[tab.id] || watchedCompletionByTab[tab.id])
      .map((tab) => tab.id)
  },
)

/** Whether one tab shows the needs-attention mark (style-gated union). */
export function selectTabNeedsAttention(state: RootState, tabId: string): boolean {
  return selectTabAttentionStyle(state) !== 'none' && selectTabStripAttention(state, tabId)
}
