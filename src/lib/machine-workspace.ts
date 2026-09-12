import { getRecoveryInventory } from '@/lib/api'
import { bootCapturedAtMs } from '@/lib/recovery/boot-state'
import { buildRecoveryPlan } from '@/lib/recovery/build-recovery-plan'
import type { RecoveryInventory } from '@/lib/recovery/types'
import { addTerminalRestoreRequestId, armRecoveredLiveTerminalTarget } from '@/lib/terminal-restore'
import { getCurrentTabRegistryClientInstanceId } from '@/store/tabRegistrySync'
import { clearTabRegistryLocalClosed } from '@/store/tabRegistrySlice'
import { clearTabsForMachine, addTab } from '@/store/tabsSlice'
import { clearPanesForMachine, restoreLayout } from '@/store/panesSlice'
import type { PaneNode } from '@/store/paneTypes'
import type { RootState } from '@/store/store'

type MachineWorkspaceStore = {
  dispatch: (action: any) => unknown
  getState: () => Pick<RootState, 'panes'>
}

function armTerminalRestores(state: Pick<RootState, 'panes'>, tabIds: string[]): void {
  const walk = (node: PaneNode | undefined): void => {
    if (!node) return
    if (node.type === 'leaf') {
      if (node.content.kind === 'terminal' && node.content.sessionRef && node.content.createRequestId) {
        addTerminalRestoreRequestId(node.content.createRequestId)
      }
      return
    }
    for (const child of node.children) walk(child)
  }
  for (const tabId of tabIds) walk(state.panes.layouts[tabId])
}

function assertInventoryIsScopedToMachine(inventory: RecoveryInventory, machineId: string): void {
  const inventoryMachineId = inventory.device?.deviceId
  if (inventoryMachineId && inventoryMachineId !== machineId) {
    throw new Error(
      `Refusing recovery for ${inventoryMachineId}: the selected machine is ${machineId}`,
    )
  }
}

/**
 * Hydrate the selected machine's durable workspace before the websocket and
 * tabs.sync are allowed to start. The server must honor the additive
 * `machineId` inventory scope; checking the returned device id again keeps a
 * stale server from restoring an arbitrary other machine into a fresh client.
 */
export async function restoreMachineWorkspace(
  store: MachineWorkspaceStore,
  machineId: string,
): Promise<{ restoredTabs: number }> {
  const inventory = await getRecoveryInventory(
    getCurrentTabRegistryClientInstanceId(),
    Math.max(0, Date.now() - bootCapturedAtMs),
    { machineId },
  )
  assertInventoryIsScopedToMachine(inventory, machineId)
  const plans = inventory.recoverable ? buildRecoveryPlan(inventory) : []

  // These are local cache actions, not tab/pane closes. Sync is still gated,
  // so no blank or mixed-machine snapshot can reach the server mid-replace.
  store.dispatch(clearTabsForMachine())
  store.dispatch(clearPanesForMachine())
  store.dispatch(clearTabRegistryLocalClosed())

  for (const plan of plans) {
    store.dispatch(addTab({ id: plan.tabId, title: plan.title }))
    store.dispatch(restoreLayout({
      tabId: plan.tabId,
      layout: plan.layout,
      paneTitles: plan.paneTitles,
    }))
    for (const target of plan.liveTerminalReattach ?? []) {
      armRecoveredLiveTerminalTarget(plan.tabId, target.paneId, target.terminalId)
    }
  }
  armTerminalRestores(store.getState(), plans.map((plan) => plan.tabId))
  return { restoredTabs: plans.length }
}
