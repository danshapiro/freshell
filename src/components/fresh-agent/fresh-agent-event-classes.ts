/**
 * Pure classification of fresh-agent WS events by what they make stale in a
 * pane. FreshAgentView uses it to decide whether a frame re-drives the
 * snapshot, marks a hidden pane's transcript dirty (blocking reveal refresh),
 * or only owes a non-blocking surface refresh on reveal.
 */

export const FRESH_AGENT_BUSY_STATUSES: ReadonlySet<string> = new Set(['running', 'compacting'])

// Events that re-drive the pane's snapshot while it is visible.
export const SNAPSHOT_INVALIDATING_FRESH_AGENT_EVENTS: ReadonlySet<string> = new Set([
  'freshAgent.session.changed',
  'freshAgent.session.snapshot',
  'freshAgent.result',
  'freshAgent.turn.complete',
  'freshAgent.permission.request',
  'freshAgent.permission.cancelled',
  'freshAgent.question.request',
  // A provider-cancelled question must also re-drive the snapshot, so the card clears
  // even if the freshAgent.question.cancelled fold races (fresh-eyes round-3 F3).
  'freshAgent.question.cancelled',
  // kata 1wxv: rollback converges through the invalidating snapshot — the marker
  // bucket, the active prefix, and rollback{canRedo,undoneDepth} all ride it.
  'freshAgent.session.rolledBack',
  'freshAgent.session.redone',
  'freshAgent.rolledBack', // the requesting pane's ack also refetches
  'freshAgent.redone',
])

// These events mean the durable transcript may have changed. Status, approval,
// and question events are deliberately excluded: they update the surrounding
// pane UI, but do not make an already-rendered transcript stale. That keeps a
// hidden pane immediately usable when its last transcript snapshot is still
// current.
export const TRANSCRIPT_INVALIDATING_FRESH_AGENT_EVENTS: ReadonlySet<string> = new Set([
  'freshAgent.session.changed',
  'freshAgent.result',
  'freshAgent.turn.complete',
  'freshAgent.error',
  'freshAgent.assistant',
  'freshAgent.stream',
  'freshAgent.transcript.patch',
  'freshAgent.session.rolledBack',
  'freshAgent.session.redone',
  'freshAgent.rolledBack',
  'freshAgent.redone',
])

// Approval and question lifecycle events change only the pane surface (the
// cards rendered from the snapshot's pendingApprovals/pendingQuestions). A
// hidden pane owes a non-blocking refresh for them on reveal; they must not
// take the blocking transcript path, whose overlay clears only on a newer
// transcript revision that an approval never produces.
export const SURFACE_INVALIDATING_FRESH_AGENT_EVENTS: ReadonlySet<string> = new Set([
  'freshAgent.permission.request',
  'freshAgent.permission.cancelled',
  'freshAgent.question.request',
  'freshAgent.question.cancelled',
])

export type HiddenPaneEventClass = 'transcript' | 'surface' | 'none'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readFreshAgentEvent(message: Record<string, unknown>): Record<string, unknown> | undefined {
  if (message.type !== 'freshAgent.event') return undefined
  return isRecord(message.event) ? message.event : undefined
}

export function readMessageEventType(message: Record<string, unknown>): string | undefined {
  const event = isRecord(message.event) ? message.event : undefined
  return typeof event?.type === 'string' ? event.type : undefined
}

export function isSnapshotInvalidatingFreshAgentEvent(message: Record<string, unknown>): boolean {
  const eventType = readFreshAgentEvent(message)?.type
  return typeof eventType === 'string' && SNAPSHOT_INVALIDATING_FRESH_AGENT_EVENTS.has(eventType)
}

export function isTranscriptInvalidatingFreshAgentEvent(message: Record<string, unknown>): boolean {
  const event = readFreshAgentEvent(message)
  const eventType = event?.type
  if (eventType === 'freshAgent.session.snapshot') {
    return typeof event?.status === 'string' && FRESH_AGENT_BUSY_STATUSES.has(event.status)
  }
  return typeof eventType === 'string' && TRANSCRIPT_INVALIDATING_FRESH_AGENT_EVENTS.has(eventType)
}

/**
 * What a frame makes stale in its pane:
 * - 'transcript': the durable conversation may have changed (a hidden pane
 *   marks itself dirty and blocks on a fresh revision at reveal).
 * - 'surface': only the approval/question cards changed (a hidden pane owes
 *   one non-blocking refresh at reveal).
 * - 'none': nothing a hidden pane needs to refetch.
 *
 * `busySnapshotSettled` is the caller's observation that a status snapshot
 * moved the pane from busy to settled, which ends a turn.
 */
export function classifyHiddenPaneEvent(
  message: Record<string, unknown>,
  { busySnapshotSettled }: { busySnapshotSettled: boolean },
): HiddenPaneEventClass {
  if (isTranscriptInvalidatingFreshAgentEvent(message) || busySnapshotSettled) return 'transcript'
  const eventType = readFreshAgentEvent(message)?.type
  if (typeof eventType === 'string' && SURFACE_INVALIDATING_FRESH_AGENT_EVENTS.has(eventType)) return 'surface'
  return 'none'
}
