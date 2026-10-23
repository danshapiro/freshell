// The pure mapping from the CLI's lifecycle messages to the sidecar's fact
// frames (docs/plans/2026-10-22-freshclaude-core-runtime.md §5.1, C16). The
// server folds these facts into its turn accounting; none of them is content
// for the client. The core runtime owns these kinds (§9.1 N6): per-command
// lifecycle and replays, session state, the end of a status, and liveness
// heartbeats. Content (assistant, stream events, transcript announcements,
// notices) is sdk-message-frames.mjs's.
//
// Facts are forwarded only for commands this sidecar sent: the CLI also
// queues and replays uuids it minted itself (setModel's /model command, cron
// triggers, auto-resume continuations, T8), which the server never knew.
//
//   sdk.command        {sessionId, uuid, state: queued|started|completed|cancelled|discarded|replayed}
//                      — the command's lifecycle (T8); `replayed` is its first replay
//   sdk.session.state  {sessionId, state: running|idle|requires_action} (T9)
//   sdk.status         {sessionId, status: null, compactResult?, compactError?, permissionMode?}
//                      — a status ended (T15); {status: 'requesting'} is a model request
//   sdk.heartbeat      {sessionId, kind: tool|task|retry, toolUseId?, elapsedMs?}
//                      — liveness only, at most one per kind every HEARTBEAT_INTERVAL_MS (T17)

/** At most one heartbeat of each kind is forwarded in this many milliseconds. */
export const HEARTBEAT_INTERVAL_MS = 5000

const COMMAND_STATES = new Set(['queued', 'started', 'completed', 'cancelled', 'discarded'])
const TERMINAL_COMMAND_STATES = new Set(['completed', 'cancelled', 'discarded'])
const SESSION_STATES = new Set(['running', 'idle', 'requires_action'])
const TASK_SUBTYPES = new Set(['task_started', 'task_progress', 'task_updated', 'task_notification'])

/** Leading-edge rate limit per heartbeat kind: the first beat passes, then one per interval. */
export function createHeartbeatLimiter(intervalMs = HEARTBEAT_INTERVAL_MS) {
  const lastAdmitted = new Map()
  return {
    admit(kind, now) {
      const last = lastAdmitted.get(kind)
      if (last !== undefined && now - last < intervalMs) return false
      lastAdmitted.set(kind, now)
      return true
    },
  }
}

/** One session's lifecycle state: its outstanding sent commands and heartbeat allowance. */
export function createLifecycleState() {
  return { sent: new Map(), heartbeats: createHeartbeatLimiter() }
}

/** The sidecar is about to send this command to the CLI; keep it until terminal lifecycle. */
export function rememberSend(state, uuid) {
  state.sent.delete(uuid)
  state.sent.set(uuid, { replayed: false })
}

/** The facts one SDK message carries (none for any other kind). `now` is in milliseconds. */
export function lifecycleFrames(sessionId, msg, state, now = Date.now()) {
  switch (msg?.type) {
    case 'command_lifecycle': return commandFrames(sessionId, msg, state)
    case 'user': return replayFrames(sessionId, msg, state)
    case 'tool_progress': return heartbeatFrames(sessionId, state, now, toolHeartbeat(msg))
    case 'system': return systemFrames(sessionId, msg, state, now)
    default: return []
  }
}

/**
 * The sent commands an interrupt receipt says will still run (T12, T13), or
 * undefined when the CLI sent no receipt (older CLIs resolve undefined).
 */
export function stillQueuedOf(receipt, state) {
  if (!Array.isArray(receipt?.still_queued)) return undefined
  return receipt.still_queued.filter((uuid) => state.sent.has(uuid))
}

function commandFrames(sessionId, msg, state) {
  if (!state.sent.has(msg.command_uuid) || !COMMAND_STATES.has(msg.state)) return []
  const frame = { type: 'sdk.command', sessionId, uuid: msg.command_uuid, state: msg.state }
  // Only outstanding commands are needed to recognize future lifecycle and
  // interrupt-receipt facts. Retire terminal ids here so long-lived sessions
  // do not accumulate completed history, while an arbitrarily large queue
  // remains fully attributable to the server's turn ledger.
  if (TERMINAL_COMMAND_STATES.has(msg.state)) state.sent.delete(msg.command_uuid)
  return [frame]
}

/** The first replay of a sent command: the CLI took it as a user message (T8). */
function replayFrames(sessionId, msg, state) {
  if (msg.isReplay !== true) return []
  const sent = state.sent.get(msg.uuid)
  if (!sent || sent.replayed) return []
  sent.replayed = true
  return [{ type: 'sdk.command', sessionId, uuid: msg.uuid, state: 'replayed' }]
}

function systemFrames(sessionId, msg, state, now) {
  if (msg.subtype === 'session_state_changed') {
    return SESSION_STATES.has(msg.state) ? [{ type: 'sdk.session.state', sessionId, state: msg.state }] : []
  }
  if (msg.subtype === 'status') return statusFrames(sessionId, msg)
  if (msg.subtype === 'api_retry') return heartbeatFrames(sessionId, state, now, { kind: 'retry' })
  if (TASK_SUBTYPES.has(msg.subtype)) {
    return heartbeatFrames(sessionId, state, now, { kind: 'task', ...(typeof msg.tool_use_id === 'string' ? { toolUseId: msg.tool_use_id } : {}) })
  }
  return []
}

/**
 * A status ended (`null`: a compaction's outcome or a new permission mode,
 * T15) or a model request started (`requesting`). `compacting` is content:
 * the client shows it, and sdk-message-frames.mjs forwards it.
 */
function statusFrames(sessionId, msg) {
  if (msg.status === 'requesting') return [{ type: 'sdk.status', sessionId, status: 'requesting' }]
  if (msg.status !== null) return []
  return [{
    type: 'sdk.status',
    sessionId,
    status: null,
    ...(msg.compact_result !== undefined ? { compactResult: msg.compact_result } : {}),
    ...(msg.compact_error !== undefined ? { compactError: msg.compact_error } : {}),
    ...(msg.permissionMode !== undefined ? { permissionMode: msg.permissionMode } : {}),
  }]
}

/**
 * A running tool's progress. A heartbeat is stamped with an id of its own and
 * names the tool it belongs to as its parent (T17).
 */
function toolHeartbeat(msg) {
  const toolUseId = msg.heartbeat === true ? (msg.parent_tool_use_id ?? msg.tool_use_id) : msg.tool_use_id
  return {
    kind: 'tool',
    ...(typeof toolUseId === 'string' ? { toolUseId } : {}),
    ...(Number.isFinite(msg.elapsed_time_seconds) ? { elapsedMs: msg.elapsed_time_seconds * 1000 } : {}),
  }
}

function heartbeatFrames(sessionId, state, now, beat) {
  if (!state.heartbeats.admit(beat.kind, now)) return []
  return [{ type: 'sdk.heartbeat', sessionId, ...beat }]
}
