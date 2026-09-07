import { loadPersistedPanes } from '@/store/persistMiddleware'

type PaneNode = {
  type: 'leaf' | 'split'
  content?: { kind?: string; createRequestId?: string }
  children?: PaneNode[]
}

const restoredCreateRequestIds = new Set<string>()
export type TerminalFreshRecoveryIntent = 'fresh_after_restore_unavailable'
const freshRecoveryRequestIds = new Map<string, TerminalFreshRecoveryIntent>()

function collectCreateRequestIds(node: PaneNode | null | undefined): void {
  if (!node) return
  if (node.type === 'leaf') {
    if (node.content?.kind === 'terminal' && node.content.createRequestId) {
      restoredCreateRequestIds.add(node.content.createRequestId)
    }
    return
  }
  if (node.type === 'split' && Array.isArray(node.children)) {
    for (const child of node.children) {
      collectCreateRequestIds(child)
    }
  }
}

// While the pane.reconcile protocol owns pane adoption (server acked the
// paneReconcileV1 capability on the CURRENT connection), the legacy
// restore/fresh-recovery latches must report not-armed: reconcile verdicts
// carry the authoritative restore intent, and a latch firing alongside them
// would double-restore. The bypass is a first-line early return — armed
// entries are preserved untouched, so deactivating (census fallback, or a
// reconnect to a server without the capability) restores the exact previous
// behavior.
let paneReconcileActive = false

export function setPaneReconcileActive(v: boolean): void {
  paneReconcileActive = v
}

const persisted = loadPersistedPanes()
if (persisted?.layouts && typeof persisted.layouts === 'object') {
  for (const node of Object.values(persisted.layouts)) {
    collectCreateRequestIds(node as PaneNode)
  }
}

// NOTE ON SEMANTICS (non-destructive peek, not one-shot consume):
//
// A restore round can be interrupted by any number of dropped connections /
// server restarts before a pane actually anchors (receives terminal.created
// for its createRequestId). Every retry of terminal.create for the SAME
// requestId must still see restore:true, or the server mints a fresh
// session and the pane's history becomes invisible even though the pane
// itself never gave up trying to restore.
//
// So despite the name (kept for call-site compatibility), this function does
// NOT delete the entry on read -- it is a peek. The flag is only ever removed
// by an explicit call to `clearTerminalRestoreRequestId`, which callers must
// invoke once the requestId's fate is settled: the pane anchored, or the
// requestId is being abandoned in favor of a newly-minted one. Until that
// happens, this keeps returning true for as many interrupted restore rounds
// as it takes to anchor.
export function consumeTerminalRestoreRequestId(requestId: string): boolean {
  if (paneReconcileActive) return false
  if (freshRecoveryRequestIds.has(requestId)) return false
  return restoredCreateRequestIds.has(requestId)
}

// Explicitly resolves a restore-request id, removing it from the armed set.
// Call this once the requestId's restore fate is settled -- e.g. the pane
// anchored (terminal.created received for this requestId), or the requestId
// is being abandoned in favor of a newly-minted one. Safe to call on an id
// that was never armed (no-op).
export function clearTerminalRestoreRequestId(requestId: string): void {
  restoredCreateRequestIds.delete(requestId)
}

export function addTerminalRestoreRequestId(requestId: string): void {
  if (freshRecoveryRequestIds.has(requestId)) return
  restoredCreateRequestIds.add(requestId)
}

export function consumeTerminalFreshRecoveryRequest(
  requestId: string,
): TerminalFreshRecoveryIntent | undefined {
  if (paneReconcileActive) return undefined
  const intent = freshRecoveryRequestIds.get(requestId)
  if (!intent) return undefined
  freshRecoveryRequestIds.delete(requestId)
  clearTerminalRestoreRequestId(requestId)
  return intent
}

export function addTerminalFreshRecoveryRequestId(
  requestId: string,
  intent: TerminalFreshRecoveryIntent,
): void {
  clearTerminalRestoreRequestId(requestId)
  freshRecoveryRequestIds.set(requestId, intent)
}

// Focused-episode-6 round 5 (Finding F1) — the restore offer's LIVE terminal
// panes: a live pane is a genuinely-open session still running server-side, so
// accepting the offer puts the pane back IN ITS TAB by reattaching to the
// still-running terminal — never by spawning a second process (Rust ignores
// the terminal.create `liveTerminal` hint, so the reattach target rides this
// client-side arm instead). The plan records the snapshot's
// `payload.liveTerminal.terminalId` (whose liveness the inventory asserted
// from its OWN current registry), and TerminalView's lifecycle consults the
// arm BEFORE it would dispatch a create.
//
// SEMANTICS: one-shot consume (get + delete), deliberately UNLIKE
// `consumeTerminalRestoreRequestId`'s non-destructive peek above. The
// consult's fold is a local dispatch (no socket needed) that sets the pane's
// live terminal handle synchronously, so the create branch — the only
// consult site — never runs again for that pane. Any later recovery that
// clears the handle (a died-before-attach target heals through the
// INVALID_TERMINAL_ID reconnect) re-enters through the fresh-recovery path,
// never re-arming this target. A server reconcile verdict naming the pane
// always wins: the consult runs only after the pre-verdict wait releases.
//
// KEY: `tabId:paneId` — NOT createRequestId. restoreLayout normalization
// re-mints terminal createRequestIds but preserves pane node ids, so the
// plan (pre-normalization) and the mounted pane (post-normalization) share
// exactly one stable key. Nanoid pane ids + the tabId prefix make the key
// unique across tabs.
const recoveredLiveTerminalTargets = new Map<string, string>()

function recoveredLiveTerminalKey(tabId: string, paneId: string): string {
  return `${tabId}:${paneId}`
}

export function armRecoveredLiveTerminalTarget(tabId: string, paneId: string, terminalId: string): void {
  recoveredLiveTerminalTargets.set(recoveredLiveTerminalKey(tabId, paneId), terminalId)
}

export function consumeRecoveredLiveTerminalTarget(tabId: string, paneId: string): string | undefined {
  const key = recoveredLiveTerminalKey(tabId, paneId)
  const terminalId = recoveredLiveTerminalTargets.get(key)
  if (terminalId !== undefined) recoveredLiveTerminalTargets.delete(key)
  return terminalId
}
