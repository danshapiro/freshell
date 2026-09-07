/**
 * kata 1wxv: client-side conversation rollback (/undo + /redo) for fresh-agent
 * panes. Pure module — no react imports — so the composer, the view, and the
 * context-menu registry all share the pinned copy and the single gate.
 *
 * Boundaries of truth (see docs/plans/2026-08-22-freshagent-undo-redo.md "Wire design"):
 * - The client busy gate is ADVISORY + direction-aware; the server BUSY_TURN refusal
 *   is the authority and arrives as a rollback-flagged freshAgent.error — its
 *   server-supplied `message` is pinned server-side and rendered VERBATIM.
 * - Capability truth comes from the snapshot (`capabilities.undo/redo`); legacy
 *   servers emit neither key, and absent means false.
 */

// Pinned client copy (verbatim from the plan's Wire design).
export const ROLLBACK_BUSY_UNDO_NOTICE = 'Undo is unavailable while the agent is mid-turn — queue a message to steer it, or wait for the turn to finish.'
export const ROLLBACK_BUSY_REDO_NOTICE = 'Redo is unavailable while the agent is mid-turn — queue a message to steer it, or wait for the turn to finish.'
export const REDO_CODEX_UNSUPPORTED_NOTICE = 'Redo is not available for Codex sessions — undo permanently replaces codex thread history (codex has no redo primitive). Rolled-back turns stay listed below the transcript.'
export const REDO_DESTROYED_NOTICE = 'Redo is no longer available — a message submitted after the undo permanently retired it.'
export const REDO_EMPTY_NOTICE = 'Nothing to redo.'
export const UNDO_EMPTY_NOTICE = 'Nothing to roll back.'
export const UNDO_REFILL_NOTICE = 'Undone — the removed prompt is back in the composer for editing.'

/** Decision 9: capability-false providers get an explicit rejection, never silence. */
export function rollbackUnsupportedNotice(providerLabel: string): string {
  return `Conversation rollback is not supported for ${providerLabel} sessions.`
}

export type RollbackGate = { kind: 'send' } | { kind: 'reject'; notice: string }

/**
 * The advisory pre-flight gate for a rollback trigger (slash command, per-turn
 * icon, marker-row redo, pane context menu). Order: capability (a permanent
 * property of the session) first, then the transient busy gate with
 * direction-aware copy, then redo availability.
 */
export function gateRollbackCommand(input: {
  direction: 'undo' | 'redo'
  provider: string
  providerLabel: string
  capabilityUndo: boolean | undefined
  capabilityRedo: boolean | undefined
  canRedo: boolean | undefined
  isBusy: boolean
  hasRolledBackTurns: boolean
}): RollbackGate {
  if (input.direction === 'undo') {
    if (input.capabilityUndo !== true) {
      return { kind: 'reject', notice: rollbackUnsupportedNotice(input.providerLabel) }
    }
    if (input.isBusy) return { kind: 'reject', notice: ROLLBACK_BUSY_UNDO_NOTICE }
    return { kind: 'send' }
  }
  // decision 5: codex is undo-only — an explicit pinned explanation, not a generic
  // rejection. Any other capability-false provider gets the parity notice.
  if (input.provider === 'codex') {
    return { kind: 'reject', notice: REDO_CODEX_UNSUPPORTED_NOTICE }
  }
  if (input.capabilityRedo !== true) {
    return { kind: 'reject', notice: rollbackUnsupportedNotice(input.providerLabel) }
  }
  if (input.isBusy) return { kind: 'reject', notice: ROLLBACK_BUSY_REDO_NOTICE }
  if (input.canRedo === false) return { kind: 'reject', notice: REDO_DESTROYED_NOTICE }
  if (!input.hasRolledBackTurns) return { kind: 'reject', notice: REDO_EMPTY_NOTICE }
  return { kind: 'send' }
}

/** Builds the frozen contract-v8 rollback frame. `mode` absent means 'step'. */
export function buildRollbackFrame(input: {
  direction: 'undo' | 'redo'
  requestId: string
  sessionId: string
  sessionType: string
  provider: string
  cwd?: string
  mode?: 'step' | 'toTurn'
  turnId?: string
}): Record<string, unknown> {
  return {
    type: input.direction === 'undo' ? 'freshAgent.undo' : 'freshAgent.redo',
    requestId: input.requestId,
    sessionId: input.sessionId,
    sessionType: input.sessionType,
    provider: input.provider,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
  }
}

export type RollbackAck = {
  kind: 'freshAgent.rolledBack' | 'freshAgent.redone'
  requestId: string
  removedPromptText?: string
  canRedo?: boolean
}

/** Type guard for the requesting-sink acks (`removedPromptText` rides the rolledBack ack only). */
export function asRollbackAck(event: unknown): RollbackAck | null {
  if (!event || typeof event !== 'object') return null
  const record = event as Record<string, unknown>
  if (record.type !== 'freshAgent.rolledBack' && record.type !== 'freshAgent.redone') return null
  if (typeof record.requestId !== 'string' || record.requestId.length === 0) return null
  return {
    kind: record.type,
    requestId: record.requestId,
    ...(typeof record.removedPromptText === 'string' ? { removedPromptText: record.removedPromptText } : {}),
    ...(typeof record.canRedo === 'boolean' ? { canRedo: record.canRedo } : {}),
  }
}

/**
 * Rollback refusals ride freshAgent.error with `{rollback: true}` so they route
 * to the initiating pane's notice banner instead of the pane error surface.
 */
export function isRollbackErrorEvent(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false
  const record = event as Record<string, unknown>
  return record.type === 'freshAgent.error' && record.rollback === true
}
