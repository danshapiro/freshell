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
