// The pure mapping from an SDK message to the sidecar's stdout frames
// (docs/plans/2026-10-22-freshclaude-core-runtime.md §3.2 and §9.1 N6). One
// function per SDK message kind; index.mjs keeps the side effects (the turn
// gate, pendingResults, the attention clock, emit). The core runtime owns the
// `result` mapping below; the transcript work owns the content kinds
// (framesForSdkMessage and the functions it dispatches to, at the end).
//
// Result shapes are the pinned CLI's (test/integration/providers/
// claude-cli-contract.test.ts): a Stop ends the turn with
// `error_during_execution`, `terminal_reason: aborted_streaming|aborted_tools`
// and an `[ede_diagnostic] …` error (T11); an API error is a `success` with
// `is_error` (T18), which the transcript shows, so it gets no failure text.

/** terminal_reason values of a turn that was aborted (a Stop landed on it). */
export const ABORTED_TERMINAL_REASONS = new Set(['aborted_streaming', 'aborted_tools'])

const DIAGNOSTIC_PREFIX = '[ede_diagnostic]'

const ABORTED_COPY = 'Claude stopped the turn before it finished.'
const SUBTYPE_COPY = {
  error_max_turns: 'Claude reached its turn limit. Send a message to continue.',
  error_max_budget_usd: 'Claude reached the configured spending limit.',
  error_max_structured_output_retries: 'Claude could not produce the requested response format.',
}
const DEFAULT_COPY = 'Claude could not complete this turn. Try sending your message again.'

/** The CLI ended this turn because it was aborted (its terminal_reason says so). */
export function isAbortedResult(result) {
  return ABORTED_TERMINAL_REASONS.has(result?.terminal_reason)
}

/**
 * The text a failed turn shows the user, or undefined for a successful result.
 * The CLI's internal `[ede_diagnostic]` lines are never shown; when nothing
 * else is left, the text explains the result kind in plain words.
 */
export function resultErrorText(result) {
  if (result.subtype === 'success') return undefined
  const errors = Array.isArray(result.errors) ? result.errors : []
  const messages = errors
    .filter((message) => typeof message === 'string')
    .map((message) => message.trim())
    .filter((message) => message && !message.startsWith(DIAGNOSTIC_PREFIX))
  if (messages.length) return messages.join('\n')
  if (isAbortedResult(result)) return ABORTED_COPY
  return SUBTYPE_COPY[result.subtype] ?? DEFAULT_COPY
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
 * The frames for an SDK `result`: `sdk.result`, then, for a failed turn, the
 * `sdk.error{turnFailure}` the client shows as its "Agent error" banner.
 * `userStopped` is the turn gate's verdict that this result is the user's own
 * Stop: that is not a failure, so it carries no error frame (G03).
 */
export function resultFrames(sessionId, result, { userStopped }) {
  const frames = [{
    type: 'sdk.result',
    sessionId,
    result: result.subtype,
    durationMs: result.duration_ms,
    costUsd: result.total_cost_usd,
    usage: resultUsage(result.usage),
  }]
  const failure = userStopped ? undefined : resultErrorText(result)
  if (failure) frames.push({ type: 'sdk.error', sessionId, message: failure, turnFailure: true })
  return frames
}

// ── content kinds (docs/plans/2026-10-22-freshclaude-transcript-live.md §4.2) ──
//
// framesForSdkMessage maps the SDK messages whose content reaches the server:
// assistant and user messages, stream events, the status frames (compacting,
// a compaction's outcome, the CLI's permission mode), and the provider events
// that never end a turn (an API retry becomes `sdk.retry`; a rate limit, an
// informational message or a failed compaction becomes `sdk.notice`). Every
// other kind maps to no frame here: `result`, `system/init`,
// `commands_changed` and the checkpoint replay binding carry side effects, so
// index.mjs handles them itself.
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
 * arrives: `{ stream, permissionMode, turnPending }` — the session's
 * createFrameState(), the permission mode it believes the CLI is in, and
 * whether a send still waits for its result.
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
 * (Interim: core's turn ledger will compute this itself, docs/plans/
 * 2026-10-22-freshclaude-core-runtime.md §9.1 N2.)
 */
export function compactionOutcomeFrames(sessionId, msg, { turnPending }) {
  if (msg.status !== null || msg.compact_result === undefined) return []
  const frames = []
  if (msg.compact_result === 'failed') {
    const reason = typeof msg.compact_error === 'string' ? msg.compact_error.trim() : ''
    frames.push({ type: 'sdk.notice', sessionId, level: 'error', code: 'COMPACTION_FAILED', message: reason || COMPACTION_FAILED_COPY })
  }
  if (turnPending) frames.push({ type: 'sdk.status', sessionId, status: 'running' })
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

/**
 * A banner the CLI shows as plain text (hook feedback, status lines): a
 * notice with its text. Only the CLI's `warning` level is more than info.
 */
export function informationalFrames(sessionId, msg) {
  const message = typeof msg.content === 'string' ? msg.content.trim() : ''
  if (!message) return []
  return [{ type: 'sdk.notice', sessionId, level: msg.level === 'warning' ? 'warning' : 'info', code: 'INFORMATIONAL', message }]
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
