import { getRecoveryInventory } from '@/lib/api'
import { createLogger } from '@/lib/client-logger'
import { captureLegacyNameEvidence } from '@/lib/session-name-migration'
import {
  getMachineWorkspaceOriginId,
  persistMachineWorkspaceOriginId,
} from '@/lib/machine-identity'
import { bootCapturedAtMs } from '@/lib/recovery/boot-state'
import { buildRecoveryPlan } from '@/lib/recovery/build-recovery-plan'
import type { RecoveryInventory } from '@/lib/recovery/types'
import { addTerminalRestoreRequestId, armRecoveredLiveTerminalTarget } from '@/lib/terminal-restore'
import { getCurrentTabRegistryClientInstanceId } from '@/store/tabRegistrySync'
import { clearTabRegistryLocalClosed } from '@/store/tabRegistrySlice'
import { clearTabsForMachine, addTab, setActiveTab } from '@/store/tabsSlice'
import { clearPanesForMachine, restoreLayout, setPaneCrashTrace } from '@/store/panesSlice'
import type { CrashTrace, PaneNode } from '@/store/paneTypes'
import type { RootState } from '@/store/store'

const log = createLogger('machine-workspace')

type MachineWorkspaceStore = {
  dispatch: (action: any) => unknown
  getState: () => Pick<RootState, 'panes' | 'tabs'>
}

const MACHINE_BOOTSTRAP_RECOVERY_EXCLUSION_PREFIX = 'machine-bootstrap:'

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

type CrashTraceDecoration = {
  tabId: string
  paneId: string
  mode: string
  createRequestId: string
  crashTrace: CrashTrace
}

function collectLocalCrashTraceDecorations(state: Pick<RootState, 'panes'>): CrashTraceDecoration[] {
  const decorations: CrashTraceDecoration[] = []
  const walk = (tabId: string, node: PaneNode | undefined): void => {
    if (!node) return
    if (node.type === 'leaf') {
      const { content } = node
      if (content.kind === 'terminal' && content.crashTrace) {
        decorations.push({
          tabId,
          paneId: node.id,
          mode: content.mode,
          createRequestId: content.createRequestId,
          crashTrace: content.crashTrace,
        })
      }
      return
    }
    for (const child of node.children) walk(tabId, child)
  }
  for (const [tabId, layout] of Object.entries(state.panes.layouts)) walk(tabId, layout)
  return decorations
}

function reapplyMatchingCrashTraceDecorations(
  store: MachineWorkspaceStore,
  decorations: CrashTraceDecoration[],
): void {
  for (const decoration of decorations) {
    const layout = store.getState().panes.layouts[decoration.tabId]
    const findMatchingPane = (node: PaneNode | undefined): boolean => {
      if (!node) return false
      if (node.type === 'leaf') {
        const { content } = node
        return node.id === decoration.paneId
          && content.kind === 'terminal'
          && content.mode === decoration.mode
          && content.createRequestId === decoration.createRequestId
      }
      return findMatchingPane(node.children[0]) || findMatchingPane(node.children[1])
    }
    if (findMatchingPane(layout)) {
      store.dispatch(setPaneCrashTrace({
        tabId: decoration.tabId,
        paneId: decoration.paneId,
        crashTrace: decoration.crashTrace,
      }))
    }
  }
}

function assertInventoryIsScopedToMachine(inventory: RecoveryInventory, machineId: string): void {
  const inventoryMachineId = inventory.device?.deviceId
  if (inventoryMachineId && inventoryMachineId !== machineId) {
    throw new Error(
      `Refusing recovery for ${inventoryMachineId}: the selected machine is ${machineId}`,
    )
  }
}

export type RestoreMachineWorkspaceReason = 'absent' | 'corrupt' | 'foreign' | 'stale'

export type RestoreMachineWorkspaceOptions = {
  /** Why this boot is rebuilding instead of keeping the local layout. */
  reason?: RestoreMachineWorkspaceReason
}

/**
 * Hydrate the selected machine's durable workspace before the websocket and
 * tabs.sync are allowed to start. The server must honor the additive
 * `machineId` inventory scope; checking the returned device id again keeps a
 * stale server from restoring an arbitrary other machine into a fresh client.
 *
 * Reconciliation note (Choice B merge of #774/#699): the App boot gate owns
 * the keep-vs-rebuild decision — classifyPersistedLayoutHealth keeps a
 * healthy local layout and calls this ONLY for an absent/corrupt/foreign/
 * stale one. #774's activeSelection option (the clear-if-non-recoverable
 * gate that used to live here) is therefore superseded: its keep-on-natural-
 * reload intent is subsumed by the gate's healthy-keep, and its
 * clear-on-active-choice intent moved into the classifier, where delta r4
 * removed its demotion power — the chooser's one-shot active-selection
 * marker has no classification effect anymore, an otherwise-healthy
 * UNSTAMPED envelope keeps as healthy legacy (same-machine re-pick
 * preservation), and only a stamp naming a different machine classifies
 * foreign.
 * Because the gate has already decided to rebuild, the local clear below is
 * unconditional.
 */
export async function restoreMachineWorkspace(
  store: MachineWorkspaceStore,
  machineId: string,
  options: RestoreMachineWorkspaceOptions = {},
): Promise<{ restoredTabs: number }> {
  log.info('rebuilding machine workspace from server inventory', {
    reason: options.reason,
    machineId,
  })
  // Unified agent names (Task 7): the belt beneath the module-import capture
  // — preserve every raw legacy layout/backup envelope BEFORE this
  // bootstrap clears the local cache below. Idempotent (the capture
  // dedupes by storageKey+raw) and read-only w.r.t. the sources.
  try {
    captureLegacyNameEvidence(localStorage)
  } catch (error) {
    log.error('legacy-name evidence capture failed before the rebuild; retrying next boot', { error })
  }
  // The recovery endpoint treats clientInstanceId as an opaque exclusion key.
  // The general recovery offer passes the real id so it cannot offer the page
  // its own already-loaded state. Machine bootstrap is different: a rebuild
  // WANTS the window's own last durable snapshot included, and a reload keeps
  // the same sessionStorage id. A reserved, non-client prefix therefore
  // includes that window's last snapshot without changing the normal
  // recovery-offer contract.
  const bootstrapExclusionId =
    `${MACHINE_BOOTSTRAP_RECOVERY_EXCLUSION_PREFIX}${getCurrentTabRegistryClientInstanceId()}`
  const inventory = await getRecoveryInventory(
    bootstrapExclusionId,
    Math.max(0, Date.now() - bootCapturedAtMs),
    { machineId },
  )
  assertInventoryIsScopedToMachine(inventory, machineId)
  const plans = inventory.recoverable
    ? buildRecoveryPlan(inventory, { preserveIdsForMachine: machineId })
    : []
  const priorActiveTabId = store.getState().tabs.activeTabId
  // Crash traces are a deliberate local-only UI decoration. Capture exactly
  // that decoration before replacing the local cache; the server inventory
  // remains authoritative for every recovered workspace field.
  // The selected-machine key is updated before a switch reload, while this
  // persisted layout may still belong to the prior selection. Retain a local
  // crash trace only when this layout was last restored for this same machine;
  // exact pane identifiers alone are not a cross-machine identity proof.
  const localCrashTraceDecorations = getMachineWorkspaceOriginId() === machineId
    ? collectLocalCrashTraceDecorations(store.getState())
    : []
  const recoveredTabIds = new Set(plans.map((plan) => plan.tabId))

  // The gate decided to rebuild (see the reconciliation note above), so the
  // local layout is absent, corrupt, foreign, or stale — clear it and replace
  // with the machine's durable truth. A non-recoverable inventory means the
  // chosen machine has NO durable workspace, so the clear yields the chosen
  // machine's empty truth (this is also the actively-chosen-machine lane from
  // #774: the gate classifies a possibly-foreign local cache as foreign).
  // These are local cache actions, not tab/pane closes. Sync is still gated,
  // so no blank or mixed-machine snapshot can reach the server mid-replace.
  store.dispatch(clearTabsForMachine())
  store.dispatch(clearPanesForMachine())
  store.dispatch(clearTabRegistryLocalClosed())

  for (const plan of plans) {
    store.dispatch(addTab({
      id: plan.tabId,
      title: plan.title,
      // Unified agent names (Task 6): the recovered tab keeps its stable
      // naming-source relationship (the plan remapped it through the
      // old→new pane-id map; machine bootstrap preserves ids verbatim).
      ...(plan.nameSource ? { nameSource: plan.nameSource } : {}),
    }))
    store.dispatch(restoreLayout({
      tabId: plan.tabId,
      layout: plan.layout,
      paneTitles: plan.paneTitles,
      // The inventory is scoped to this selected machine and the plan already
      // chose only valid snapshot IDs. Preserve that durable pane identity;
      // ordinary and cross-device restore callers intentionally omit this.
      preserveCreateRequestIds: true,
    }))
    for (const target of plan.liveTerminalReattach ?? []) {
      armRecoveredLiveTerminalTarget(plan.tabId, target.paneId, target.terminalId)
    }
  }
  // A local trace follows only the exact same terminal identity on this
  // machine. In particular, a new create request or a different terminal mode
  // cannot inherit a stale "crashed and resumed" notice.
  reapplyMatchingCrashTraceDecorations(store, localCrashTraceDecorations)
  if (priorActiveTabId && recoveredTabIds.has(priorActiveTabId)) {
    store.dispatch(setActiveTab(priorActiveTabId))
  }
  armTerminalRestores(store.getState(), plans.map((plan) => plan.tabId))
  // Record the origin only after the scoped inventory has replaced the local
  // workspace successfully. This marker is local metadata, never server
  // snapshot state and never a cross-device recovery channel.
  persistMachineWorkspaceOriginId(machineId)
  return { restoredTabs: plans.length }
}
