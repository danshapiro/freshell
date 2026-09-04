import type { Middleware } from '@reduxjs/toolkit'
import { getWsClient } from '@/lib/ws-client'
import { collectAllTerminalIds, collectPaneEntries } from '@/lib/pane-utils'
import { consumeTerminalReleaseMark } from '@/lib/terminal-release-marks'
import { applyReconcileAttach, clearDeadTerminals, clearTerminalLiveHandles, closePane, removeLayout, replacePane } from './panesSlice'
import type { PaneNode } from './paneTypes'

type PanesStateSlice = { panes: { layouts: Record<string, PaneNode | undefined> } }

/**
 * These actions strip terminalIds ONLY for terminals the server itself
 * reported dead or unrecoverable (terminal.inventory / terminals.changed).
 * There is no live subscription to release, and the server replies with an
 * error for terminal.detach on a non-existent terminal — so skip them.
 *
 * MAINTENANCE WARNING: this skip-list is maintained BY HAND. If you add a
 * new reducer/action that removes terminalIds from layouts because the
 * SERVER already reported those terminals dead, you MUST register it here —
 * otherwise this middleware sends a redundant terminal.detach for each one
 * and the server answers with an error (harmless but noisy). Conversely,
 * never register an action that removes a LIVE terminal from the layouts:
 * skipping it would leak the server-side subscription — the exact bug this
 * middleware exists to prevent (see PR #534).
 */
const skipDetachActionTypes = new Set<string>([
  clearDeadTerminals.type,
  clearTerminalLiveHandles.type,
  // Two dispatch sites, both safe to skip:
  // 1. Lane D1 crash fold (TerminalView terminal.replaced handler): the old
  //    terminal already exited server-side — never detach-storm it.
  // 2. Reconnect reconcile (pane-reconcile.ts:428): runs on a fresh
  //    connection BEFORE any attach, so no live subscription exists for the
  //    terminalId being swapped out.
  applyReconcileAttach.type,
])

/**
 * The actions that mean "the user CLOSED pane(s)" (delta-round-7 Finding F2,
 * hardened by delta-r7-round-2 Findings F1+F2):
 *
 * * `closePane` — the plain pane-X (via closePaneWithCleanup: PaneContainer,
 *   context menu, ui-commands, DeadSessionPanel).
 * * `removeLayout` — a whole-tab close (via the closeTab thunk), covering
 *   every pane in the tab tree.
 * * `replacePane` — the context-menu "Replace pane": the pane's content is
 *   discarded for a picker — the user-visible REMOVAL of that pane identity
 *   (F1: it previously sent a plain detach and journaled nothing).
 *
 * For EVERY removed terminal-pane identity the middleware sends ONE
 * `pane.closed` message keyed by the pane's `createRequestId` — present from
 * creation, never absent — and carrying the pane's terminalId when it has
 * one. This is deliberately decoupled from the detach loop below (F2):
 * close evidence is about the PANE (terminalId-less in-flight creates count;
 * panes sharing one terminal each count; a multi-pane removal journals every
 * pane's CRID), while the detach is about the TERMINAL (identity-driven,
 * last-reference only — unchanged). The server journals a durable,
 * NON-retiring pane-close record per message (the session survives —
 * sidebar reattach; the record answers "was this PANE closed", never "is the
 * session dead").
 *
 * Every non-close shape (reconcile folds, server-driven handle swaps,
 * resume-create respawns like resetPaneForReconcileCreate — which PRESERVES
 * the still-open pane's createRequestId; the dead-terminal cleanup reducers)
 * sends NO pane.closed, so a live handle swap can never mislabel the pane's
 * key as closed. MAINTENANCE WARNING (same discipline as the skip-list
 * above): register new genuine pane/tab-close actions here, and NEVER
 * register an action that merely swaps a live handle. Pre-killed flows (the
 * reopen-as-type swap; fresh-agent kill+close) journal through the KILL lane
 * already; their later layout removals still emit pane.closed, harmlessly —
 * the record family is non-retiring and dedupes by key.
 */
const paneCloseActionTypes = new Set<string>([closePane.type, removeLayout.type, replacePane.type])

/** The terminal-pane identities (createRequestId) of every layout, keyed `tabId:paneId`. */
function collectTerminalPaneIdentities(
  layouts: PanesStateSlice['panes']['layouts'],
): Map<string, { createRequestId: string; terminalId?: string }> {
  const identities = new Map<string, { createRequestId: string; terminalId?: string }>()
  for (const [tabId, root] of Object.entries(layouts)) {
    if (!root) continue
    for (const { paneId, content } of collectPaneEntries(root)) {
      if (content.kind !== 'terminal') continue
      const createRequestId = typeof content.createRequestId === 'string' && content.createRequestId
        ? content.createRequestId
        : undefined
      if (!createRequestId) continue
      identities.set(`${tabId}:${paneId}`, {
        createRequestId,
        ...(content.terminalId ? { terminalId: content.terminalId } : {}),
      })
    }
  }
  return identities
}

/** The before-pane identities whose (tabId, paneId, createRequestId) no longer exists after. */
function collectRemovedPaneIdentities(
  before: PanesStateSlice['panes']['layouts'],
  after: PanesStateSlice['panes']['layouts'],
): Array<{ createRequestId: string; terminalId?: string }> {
  const afterIdentities = collectTerminalPaneIdentities(after)
  const removed: Array<{ createRequestId: string; terminalId?: string }> = []
  for (const [key, identity] of collectTerminalPaneIdentities(before)) {
    if (afterIdentities.get(key)?.createRequestId === identity.createRequestId) continue
    removed.push(identity)
  }
  return removed
}

/**
 * Detach reconciler: whenever an action makes a terminalId disappear from
 * ALL pane layouts, the client no longer references that terminal and must
 * release its server-side attach subscription — otherwise the server sees
 * hasClients=true forever and its idle reaper can never collect the
 * terminal. The set diff over every layout is what guards the multi-pane
 * case: a terminal referenced by two panes only detaches when the LAST
 * reference goes away.
 *
 * Stateless by design (derives everything from getState) — safe under the
 * test suite's per-test ws-client reset.
 */
export const terminalDetachMiddleware: Middleware = (store) => (next) => (action) => {
  const beforeLayouts = (store.getState() as PanesStateSlice).panes.layouts
  const result = next(action)
  const afterLayouts = (store.getState() as PanesStateSlice).panes.layouts
  if (afterLayouts === beforeLayouts) return result

  const actionType = (action as { type?: unknown }).type
  if (typeof actionType === 'string' && skipDetachActionTypes.has(actionType)) {
    return result
  }
  // Only a genuine pane/tab close keys the durable pane-close evidence.
  const isPaneClose = typeof actionType === 'string' && paneCloseActionTypes.has(actionType)

  // Evidence first (the kill lane's durable-close-before-teardown order):
  // one `pane.closed` per REMOVED pane identity — including terminalId-less
  // in-flight creates and panes whose terminal retains other references.
  if (isPaneClose) {
    for (const removed of collectRemovedPaneIdentities(beforeLayouts, afterLayouts)) {
      getWsClient().send({
        type: 'pane.closed',
        createRequestId: removed.createRequestId,
        ...(removed.terminalId ? { terminalId: removed.terminalId } : {}),
      })
    }
  }

  const before = collectAllTerminalIds(beforeLayouts)
  if (before.size === 0) return result
  const after = collectAllTerminalIds(afterLayouts)

  for (const terminalId of before) {
    if (after.has(terminalId)) continue
    if (consumeTerminalReleaseMark(terminalId)) continue
    getWsClient().send({
      type: 'terminal.detach',
      terminalId,
    })
  }
  return result
}
