import type { Middleware } from '@reduxjs/toolkit'
import { getWsClient } from '@/lib/ws-client'
import { collectAllTerminalIds } from '@/lib/pane-utils'
import { consumeTerminalReleaseMark } from '@/lib/terminal-release-marks'
import { applyReconcileAttach, clearDeadTerminals, clearTerminalLiveHandles, closePane, removeLayout } from './panesSlice'
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
 * Delta-round-7 (Finding F2): the actions that mean "the user CLOSED pane(s)"
 * — the plain pane-X (`closePane`, via closePaneWithCleanup) and a whole-tab
 * close (`removeLayout`, via the closeTab thunk). When one of these removes
 * the last layout reference to a terminal, the detach carries the closing
 * pane's `createRequestId`, and the server journals a durable, NON-retiring
 * pane-close record keyed by it BEFORE/ALONGSIDE the detach (the session
 * survives — sidebar reattach; the record answers "was this PANE closed",
 * never "is the session dead"). No other detach shape carries the key:
 * reconcile folds, server-driven handle swaps, resume-create respawns (e.g.
 * resetPaneForReconcileCreate — which PRESERVES the pane's createRequestId
 * for the SAME still-open pane), and the dead-terminal cleanup reducers all
 * detach WITHOUT it, so a live handle swap can never mislabel the pane's
 * createRequestId as closed. MAINTENANCE WARNING (same discipline as the
 * skip-list above): register new genuine pane/tab-close actions here, and
 * NEVER register an action that merely swaps a live handle.
 */
const paneCloseActionTypes = new Set<string>([closePane.type, removeLayout.type])

/** The createRequestId of the (pre-action) pane that owned `terminalId`, if any. */
function createRequestIdOfTerminal(layouts: PanesStateSlice['panes']['layouts'], terminalId: string): string | undefined {
  for (const root of Object.values(layouts)) {
    const stack: PaneNode[] = []
    if (root && typeof root === 'object') stack.push(root)
    while (stack.length) {
      const node = stack.pop()!
      if (node.type === 'leaf') {
        if (node.content.kind === 'terminal' && node.content.terminalId === terminalId) {
          return node.content.createRequestId || undefined
        }
      } else {
        stack.push(...node.children)
      }
    }
  }
  return undefined
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
  // F2: only a genuine pane/tab close keys the durable pane-close record.
  const isPaneClose = typeof actionType === 'string' && paneCloseActionTypes.has(actionType)

  const before = collectAllTerminalIds(beforeLayouts)
  if (before.size === 0) return result
  const after = collectAllTerminalIds(afterLayouts)

  for (const terminalId of before) {
    if (after.has(terminalId)) continue
    if (consumeTerminalReleaseMark(terminalId)) continue
    const createRequestId = isPaneClose
      ? createRequestIdOfTerminal(beforeLayouts, terminalId)
      : undefined
    getWsClient().send({
      type: 'terminal.detach',
      terminalId,
      ...(createRequestId ? { createRequestId } : {}),
    })
  }
  return result
}
