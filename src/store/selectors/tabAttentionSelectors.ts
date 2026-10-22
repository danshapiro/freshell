/**
 * Tab-surface needs-attention selectors — the ONE derivation every tab surface
 * (desktop TabItem, MobileTabStrip, TabSwitcher) reads.
 *
 * A tab's mark is the UNION of unwitnessed attention (`attentionByTab`) and
 * watched fresh-agent completions (`watchedCompletionByTab`, a tab-surface-
 * only mark that never reaches the sidebar or pane headers — those keep
 * reading the attention maps directly). The user's
 * `tabAttentionStyle: 'none'` hides every mark on every tab surface.
 */
import { createSelector } from '@reduxjs/toolkit'
import type { RootState } from '@/store/store'
import type { TabAttentionStyle } from '@/store/types'

type TabMarks = Record<string, boolean> | undefined

const EMPTY_MARKS: Record<string, boolean> = {}

/** The union rule itself — the only place it is written. */
function tabCarriesMark(attentionByTab: TabMarks, watchedCompletionByTab: TabMarks, tabId: string): boolean {
  return Boolean(attentionByTab?.[tabId] || watchedCompletionByTab?.[tabId])
}

export function selectTabAttentionStyle(state: RootState): TabAttentionStyle {
  return state.settings?.settings?.panes?.tabAttentionStyle ?? 'highlight'
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
      .filter((tab) => tabCarriesMark(attentionByTab, watchedCompletionByTab, tab.id))
      .map((tab) => tab.id)
  },
)

/** Whether one tab shows the needs-attention mark (style-gated union). */
export function selectTabNeedsAttention(state: RootState, tabId: string): boolean {
  if (selectTabAttentionStyle(state) === 'none') return false
  const turnCompletion = state.turnCompletion
  return tabCarriesMark(turnCompletion?.attentionByTab, turnCompletion?.watchedCompletionByTab, tabId)
}
