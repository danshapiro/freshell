/**
 * Client-side mirror of the `GET /api/recovery/inventory` response shape
 * (Task 1's `build_inventory`, crates/freshell-server/src/recovery_inventory.rs).
 */

export interface RecoverySessionRef {
  provider: string
  sessionId: string
}

export type RecoveryLedgerState = 'bound' | 'closed' | 'gc_expired' | 'unknown'

export interface RecoveryPane {
  paneId: string
  kind: string
  mode: string | null
  shell: string | null
  cwd: string | null
  payload: Record<string, unknown>
  /** Effective (ledger-corrected) session ref — the D4 authority chain is applied server-side. */
  sessionRef: RecoverySessionRef | null
  ledgerState: RecoveryLedgerState
  /** True when a Running terminal currently owns the effective session (D7). */
  live: boolean
}

export interface RecoveryTab {
  tabKey: string
  tabName: string
  panes: RecoveryPane[]
}

export interface RecoveryDevice {
  deviceId: string
  deviceLabel: string
  capturedAt: number
  tabs: RecoveryTab[]
}

export interface RecoveryOtherDevice {
  deviceId: string
  deviceLabel: string
  capturedAt: number
  paneCount: number
}

/** Ledger-bound session with no snapshot pane referencing it (live rows are excluded server-side, D7). */
export interface LedgerOnlyEntry {
  provider: string
  sessionId: string
  mode: string
  cwd: string | null
  /**
   * D8 provenance stamp: `<deviceId>:<tabId>` of the tab the pane was open in
   * (present only for rows bound by a connection-scoped lane). The recovery
   * plan joins the row into the restored tab with this key when one exists;
   * rows without it (or whose tab left no retained evidence) fall back to the
   * trailing tab.
   */
  tabKey?: string
}

export interface RecoveryInventory {
  recoverable: boolean
  contentId: string
  device: RecoveryDevice | null
  otherDevices: RecoveryOtherDevice[]
  ledgerOnly: LedgerOnlyEntry[]
}
