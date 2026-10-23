import { addTab } from '@/store/tabsSlice'
import { restoreLayout } from '@/store/panesSlice'
import { armRecoveredLiveTerminalTarget } from '@/lib/terminal-restore'
import type { RecoveryTabPlan } from './build-recovery-plan'

type RecoveryPlanDispatch = (action: ReturnType<typeof addTab> | ReturnType<typeof restoreLayout>) => unknown

export interface ApplyRecoveryTabPlanOptions {
  /**
   * Machine bootstrap only: the inventory is scoped to the selected machine
   * and the plan already chose only valid snapshot ids, so the durable pane
   * identity is preserved. The cross-device recovery offer remints them.
   */
  preserveCreateRequestIds?: boolean
}

/**
 * Restore one planned tab into the store — the ONE restore step shared by the
 * machine-workspace rebuild and the recovery offer, so both bring back the
 * same tab:
 * - the tab, with its stable naming-source pointer (unified agent names,
 *   Task 6: the plan remapped it through the old→new pane-id map) and its
 *   "user renamed" flag (name reliability, Task 9: set only for a tab that is
 *   not session-owned);
 * - its layout, with the restored pane titles and pane "user renamed" flags
 *   (Task 9), keyed by the restored pane ids;
 * - the one-shot reattach targets of its LIVE terminal panes
 *   (focused-episode-6 round 5, Finding F1): pane node ids survive
 *   restoreLayout normalization, so the restored leaf's own TerminalView
 *   consults this exact key before any create.
 */
export function applyRecoveryTabPlan(
  dispatch: RecoveryPlanDispatch,
  plan: RecoveryTabPlan,
  options: ApplyRecoveryTabPlanOptions = {},
): void {
  dispatch(addTab({
    id: plan.tabId,
    title: plan.title,
    ...(plan.nameSource ? { nameSource: plan.nameSource } : {}),
    ...(plan.titleSetByUser ? { titleSetByUser: true } : {}),
  }))
  dispatch(restoreLayout({
    tabId: plan.tabId,
    layout: plan.layout,
    paneTitles: plan.paneTitles,
    paneTitleSetByUser: plan.paneTitleSetByUser,
    ...(options.preserveCreateRequestIds ? { preserveCreateRequestIds: true } : {}),
  }))
  for (const target of plan.liveTerminalReattach ?? []) {
    armRecoveredLiveTerminalTarget(plan.tabId, target.paneId, target.terminalId)
  }
}
