// The pure mapping from an SDK message to the sidecar's stdout frames
// (docs/plans/2026-10-22-freshclaude-core-runtime.md §3.2 and §9.1 N6). One
// function per SDK message kind; index.mjs keeps the side effects (emit). The
// `result` mapping below; the transcript work owns the content kinds
// (framesForSdkMessage and the functions it dispatches to, at the end).
//
// Result shapes are the pinned CLI's (test/integration/providers/
// claude-cli-contract.test.ts): a Stop ends the turn with
// `error_during_execution`, `terminal_reason: aborted_streaming|aborted_tools`
// and an `[ede_diagnostic] …` error (T11); an API error is a `success` with
// `is_error` (T18). The server reads these facts for its verdict (design §5.3):
// whether the turn rings, and the failure banner it shows (C18). The sidecar
// decides neither.

const DIAGNOSTIC_PREFIX = '[ede_diagnostic]'

/**
 * The CLI's own error text for a result, one error per line, without its
 * internal `[ede_diagnostic]` lines; undefined when none is left.
 */
export function resultErrors(result) {
  const errors = Array.isArray(result.errors) ? result.errors : []
  const messages = errors
    .filter((message) => typeof message === 'string')
    .map((message) => message.trim())
    .filter((message) => message && !message.startsWith(DIAGNOSTIC_PREFIX))
  return messages.length ? messages.join('\n') : undefined
}

function resultUsage(usage) {
  if (!usage) return undefined
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
  }
}

/**
 * The frames for an SDK `result`: one `sdk.result` carrying the facts the
 * server's verdict reads (design §5.3): `subtype` (also as the older
 * `result`), `isError`, `terminalReason` and `numTurns` when the CLI reports
 * them, and `errorText`, the CLI's own error text without diagnostics
 * (resultErrors).
 */
export function resultFrames(sessionId, result) {
  const errorText = resultErrors(result)
  return [{
    type: 'sdk.result',
    sessionId,
    result: result.subtype,
    subtype: result.subtype,
    isError: typeof result.is_error === 'boolean' ? result.is_error : result.subtype !== 'success',
    ...(typeof result.terminal_reason === 'string' ? { terminalReason: result.terminal_reason } : {}),
    ...(Number.isInteger(result.num_turns) ? { numTurns: result.num_turns } : {}),
    ...(errorText !== undefined ? { errorText } : {}),
    durationMs: result.duration_ms,
    costUsd: result.total_cost_usd,
    usage: resultUsage(result.usage),
  }]
}

// ── content kinds (docs/plans/2026-10-22-freshclaude-transcript-live.md §4.2) ──
//
// framesForSdkMessage maps the SDK messages whose content reaches the server:
// assistant and user messages, stream events, the status frames (compacting,
// a compaction's outcome, the CLI's permission mode), and the provider events
// that never end a turn (an API retry becomes `sdk.retry`; a rate limit, a
// prominent informational message or a failed compaction becomes
// `sdk.notice`). Every other kind maps to no frame here: `result`,
// `system/init`, `commands_changed` and the checkpoint replay binding carry
// side effects, so index.mjs handles them itself.
//
// Transcript announcements: the CLI writes each assistant and user message,
// each compaction boundary and each local command's output to its transcript
// (JSONL) under the message's own uuid (main or subagent file), about 100 ms
// after it emits it. Each such message is followed by
// `sdk.session.changed {reason:'transcript', uuid, parentToolUseId}`, which
// tells the client to refetch the snapshot and which line to expect in it.

/**
 * The per-session state of the content mapping. index.mjs keeps one per
 * session and passes it in as `session.stream`. `messageId` is the API
 * message id of the main thread's message being streamed (its message_start).
 */
export function createFrameState() {
  return { messageId: null }
}

/**
 * The frames for one SDK message of a content kind (none for any other kind).
 * `session` is what the sidecar knows about the session when the message
 * arrives: `{ stream, permissionMode }` — the session's createFrameState()
 * and the permission mode it believes the CLI is in.
 */
export function framesForSdkMessage(sessionId, msg, session) {
  switch (msg?.type) {
    case 'assistant': return assistantFrames(sessionId, msg)
    case 'user': return transcriptAnnouncement(sessionId, msg)
    case 'stream_event': return streamEventFrames(sessionId, msg, session.stream)
    case 'rate_limit_event': return rateLimitFrames(sessionId, msg)
    case 'system':
      switch (msg.subtype) {
        case 'status': return [
          ...statusFrames(sessionId, msg),
          ...compactionOutcomeFrames(sessionId, msg, session),
          ...permissionModeFrames(sessionId, msg, session),
        ]
        case 'compact_boundary': return compactBoundaryFrames(sessionId, msg)
        case 'local_command_output': return transcriptAnnouncement(sessionId, msg)
        case 'api_retry': return apiRetryFrames(sessionId, msg)
        case 'informational': return informationalFrames(sessionId, msg)
        default: return []
      }
    default: return []
  }
}

/** A content block as the server reads it (a thinking block's signature stays behind). */
function contentBlock(block) {
  if (block.type === 'text') return { type: 'text', text: block.text }
  if (block.type === 'thinking') return { type: 'thinking', thinking: block.thinking }
  if (block.type === 'tool_use') return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
  if (block.type === 'tool_result') return { type: 'tool_result', tool_use_id: block.tool_use_id, content: block.content, is_error: block.is_error }
  return block
}

/** The parent tool use of a subagent (sidechain) message, or null for the main thread. */
function parentToolUseIdOf(msg) {
  return typeof msg.parent_tool_use_id === 'string' && msg.parent_tool_use_id ? msg.parent_tool_use_id : null
}

/**
 * The announcement that the CLI writes this message to its transcript under
 * its uuid (none for a message without one).
 */
export function transcriptAnnouncement(sessionId, msg) {
  if (typeof msg.uuid !== 'string' || !msg.uuid) return []
  return [{ type: 'sdk.session.changed', sessionId, reason: 'transcript', uuid: msg.uuid, parentToolUseId: parentToolUseIdOf(msg) }]
}

/**
 * An assistant message (the CLI sends one per completed content block, all
 * sharing the API message id): `sdk.assistant`, then its announcement. The
 * uuid and messageId bind a streamed block to the transcript line it becomes.
 */
export function assistantFrames(sessionId, msg) {
  const content = msg.message?.content || []
  return [
    {
      type: 'sdk.assistant',
      sessionId,
      content: content.map(contentBlock),
      model: msg.message?.model,
      uuid: msg.uuid,
      messageId: msg.message?.id,
      parentToolUseId: parentToolUseIdOf(msg),
    },
    ...transcriptAnnouncement(sessionId, msg),
  ]
}

/** The stream events a live pane renders (a block's start and stop, and its text or thinking). */
const STREAMED_EVENTS = new Set(['message_start', 'content_block_start', 'content_block_stop'])
const STREAMED_DELTAS = new Set(['text_delta', 'thinking_delta'])

/**
 * A streaming event of the main thread: `sdk.stream`, stamped with the API
 * message id it belongs to (the one each of its blocks' sdk.assistant then
 * carries). Only what a live pane renders is streamed: a subagent's events,
 * tool input JSON, signatures and the message's own delta and stop are not.
 */
export function streamEventFrames(sessionId, msg, stream) {
  if (parentToolUseIdOf(msg) !== null) return []
  const event = msg.event
  if (event?.type === 'message_start') stream.messageId = event.message?.id ?? null
  const streamed = STREAMED_EVENTS.has(event?.type)
    || (event?.type === 'content_block_delta' && STREAMED_DELTAS.has(event.delta?.type))
  if (!streamed) return []
  return [{ type: 'sdk.stream', sessionId, event, parentToolUseId: null, messageId: stream.messageId }]
}

/** A status frame: the CLI started compacting. */
export function statusFrames(sessionId, msg) {
  return msg.status === 'compacting' ? [{ type: 'sdk.status', sessionId, status: 'compacting' }] : []
}

const COMPACTION_FAILED_COPY = 'Claude could not compact the conversation.'

/**
 * A compaction ended (`status:null` with `compact_result`, T15). A failed one
 * is a notice with the CLI's reason (the transcript keeps the same reason as
 * a command error); it never ends the turn. Either way, while a send still
 * waits for its result the session is running again, not compacting.
 * The server's turn ledger computes whether the session remains busy from
 * the raw status:null fact (lifecycle-frames.mjs).
 */
export function compactionOutcomeFrames(sessionId, msg) {
  if (msg.status !== null || msg.compact_result === undefined) return []
  const frames = []
  if (msg.compact_result === 'failed') {
    const reason = typeof msg.compact_error === 'string' ? msg.compact_error.trim() : ''
    frames.push({ type: 'sdk.notice', sessionId, level: 'error', code: 'COMPACTION_FAILED', message: reason || COMPACTION_FAILED_COPY })
  }
  return frames
}

/**
 * The CLI reports the permission mode it is in now (after an ExitPlanMode
 * approval, F12, or a mode suggestion the user accepted). A mode that differs
 * from the session's becomes `sdk.session.metadata {permissionMode}`; index.mjs
 * adopts it as the session's mode, so a later configure to that mode applies
 * nothing.
 */
export function permissionModeFrames(sessionId, msg, { permissionMode }) {
  if (typeof msg.permissionMode !== 'string' || msg.permissionMode === permissionMode) return []
  return [{ type: 'sdk.session.metadata', sessionId, permissionMode: msg.permissionMode }]
}

/**
 * A compaction finished: its trigger. kata 1wxv ep3-r1 F1: the bare
 * compacting STATUS frame carries no trigger — the SDK fires it for an
 * explicit `/compact` AND for its own automatic context compaction, and
 * misattributing the automatic one to a queued explicit compact wedges the
 * rollback busy gate (the phantom compact absorbs the turn's own terminal
 * edge). Only the compact COMPLETION boundary discriminates the trigger, so
 * the server gets it from here. A missing or unknown trigger counts as
 * 'auto', so promotion to a queued explicit compact never happens without a
 * proven manual run.
 */
export function compactBoundaryFrames(sessionId, msg) {
  const trigger = msg.compact_metadata?.trigger === 'manual' ? 'manual' : 'auto'
  return [{ type: 'sdk.compact_boundary', sessionId, trigger }, ...transcriptAnnouncement(sessionId, msg)]
}

/**
 * The CLI will retry a failed API request (live only; never in the
 * transcript): `sdk.retry`. `errorStatus` is null for a connection error.
 */
export function apiRetryFrames(sessionId, msg) {
  return [{
    type: 'sdk.retry',
    sessionId,
    attempt: msg.attempt,
    maxRetries: msg.max_retries,
    delayMs: msg.retry_delay_ms,
    errorStatus: msg.error_status ?? null,
    error: msg.error,
  }]
}

const RATE_LIMIT_NOTICES = {
  allowed_warning: { level: 'warning', code: 'RATE_LIMIT_WARNING', message: 'You are close to your Claude usage limit.' },
  rejected: { level: 'error', code: 'RATE_LIMITED', message: 'You have reached your Claude usage limit.' },
}
const RATE_LIMIT_FIELDS = ['status', 'resetsAt', 'rateLimitType', 'utilization']

/**
 * A change in the account's usage limits: a notice when the limit is near
 * (`allowed_warning`) or reached (`rejected`), carrying the limit so the
 * client can show when it resets. An `allowed` status says nothing.
 */
export function rateLimitFrames(sessionId, msg) {
  const info = msg.rate_limit_info ?? {}
  const notice = RATE_LIMIT_NOTICES[info.status]
  if (!notice) return []
  const rateLimit = {}
  for (const key of RATE_LIMIT_FIELDS) if (info[key] !== undefined) rateLimit[key] = info[key]
  return [{ type: 'sdk.notice', sessionId, ...notice, rateLimit }]
}

/** The informational levels the CLI itself shows prominently (SDKInformationalMessage.level). */
const PROMINENT_INFORMATIONAL_LEVELS = new Set(['warning', 'suggestion'])

/**
 * A banner the CLI shows as plain text (hook feedback, status lines): a
 * notice with its text when the CLI shows it prominently (a warning or a
 * suggestion) or when it stops the turn. The CLI's own quiet levels stay
 * quiet: `info` (transcript mode only) and `notice` (inactive gray text,
 * including its per-tool progress lines) never interrupt the pane.
 */
export function informationalFrames(sessionId, msg) {
  const stopsTurn = msg.prevent_continuation === true
  if (!stopsTurn && !PROMINENT_INFORMATIONAL_LEVELS.has(msg.level)) return []
  const message = typeof msg.content === 'string' ? msg.content.trim() : ''
  if (!message) return []
  const level = stopsTurn || msg.level === 'warning' ? 'warning' : 'info'
  return [{ type: 'sdk.notice', sessionId, level, code: 'INFORMATIONAL', message }]
}

const NOTICE_SEVERITY = { info: 'info', warning: 'warn', error: 'error' }

/**
 * The sidecar's log record for a frame worth logging (`{severity, event,
 * fields}`), else undefined. Like every sidecar record (log.mjs) it carries
 * ids, numbers and error text only: the text of an informational notice is
 * logged by its size.
 */
export function frameLogRecord(frame) {
  if (frame?.type === 'sdk.retry') {
    const { type: _type, ...fields } = frame
    return { severity: 'warn', event: 'api.retry', fields }
  }
  if (frame?.type === 'sdk.notice') {
    const fields = { sessionId: frame.sessionId, code: frame.code }
    if (frame.code === 'COMPACTION_FAILED') {
      fields.error = frame.message
    } else if (frame.rateLimit) {
      fields.rateLimitStatus = frame.rateLimit.status
      if (frame.rateLimit.rateLimitType !== undefined) fields.rateLimitType = frame.rateLimit.rateLimitType
      if (frame.rateLimit.resetsAt !== undefined) fields.resetsAt = frame.rateLimit.resetsAt
    } else {
      fields.bytes = Buffer.byteLength(frame.message ?? '')
    }
    return { severity: NOTICE_SEVERITY[frame.level] ?? 'info', event: 'notice', fields }
  }
  if (frame?.type === 'sdk.session.metadata' && frame.permissionMode !== undefined) {
    return { severity: 'info', event: 'permission_mode.changed', fields: { sessionId: frame.sessionId, permissionMode: frame.permissionMode } }
  }
  return undefined
}
