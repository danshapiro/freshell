import type { Middleware } from '@reduxjs/toolkit'
import { getWsClient } from '@/lib/ws-client'
import { collectAllTerminalIds } from '@/lib/pane-utils'
import { consumeTerminalReleaseMark } from '@/lib/terminal-release-marks'
import { clearDeadTerminals, clearTerminalLiveHandles } from './panesSlice'
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
])

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

  const before = collectAllTerminalIds(beforeLayouts)
  if (before.size === 0) return result
  const after = collectAllTerminalIds(afterLayouts)

  for (const terminalId of before) {
    if (after.has(terminalId)) continue
    if (consumeTerminalReleaseMark(terminalId)) continue
    getWsClient().send({ type: 'terminal.detach', terminalId })
  }
  return result
}
