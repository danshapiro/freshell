import type { PaneNode, PanesState } from '@/store/paneTypes'
import { isWellFormedPaneTree } from '@/store/paneTreeValidation'
import type { TabsState } from '@/store/tabsSlice'
import type { Tab } from '@/store/types'

export function isPaneBackedTab(tab: Tab): boolean {
  return !tab.codingCliSessionId || !!tab.terminalId
}

export function detectMissingLayoutCorruption(input: {
  tab: Tab
  layout: PaneNode | undefined | unknown
}): { kind: 'missing-layout'; tabId: string } | null {
  const { tab, layout } = input
  if (!isPaneBackedTab(tab) || isWellFormedPaneTree(layout)) {
    return null
  }
  return {
    kind: 'missing-layout',
    tabId: tab.id,
  }
}

export function validateWorkspaceSnapshot(input: {
  tabs: TabsState
  panes: Pick<PanesState, 'layouts'>
}): { ok: true } | { ok: false; missingLayoutTabIds: string[] } {
  const missingLayoutTabIds = input.tabs.tabs
    .map((tab) => detectMissingLayoutCorruption({ tab, layout: input.panes.layouts[tab.id] }))
    .filter((result): result is { kind: 'missing-layout'; tabId: string } => result !== null)
    .map((result) => result.tabId)

  if (missingLayoutTabIds.length === 0) {
    return { ok: true }
  }

  return {
    ok: false,
    missingLayoutTabIds,
  }
}
