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
// assistant and user messages, stream events and the compaction status frames.
// Every other kind maps to no frame here: `result`, `system/init`,
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
 * session and passes it in as `session.stream`.
 */
export function createFrameState() {
  return {}
}

/**
 * The frames for one SDK message of a content kind (none for any other kind).
 * `session` is what the sidecar knows about the session when the message
 * arrives: `{ stream }`, the session's createFrameState().
 */
export function framesForSdkMessage(sessionId, msg, session) {
  switch (msg?.type) {
    case 'assistant': return assistantFrames(sessionId, msg)
    case 'user': return transcriptAnnouncement(sessionId, msg)
    case 'stream_event': return streamEventFrames(sessionId, msg, session.stream)
    case 'system':
      switch (msg.subtype) {
        case 'status': return statusFrames(sessionId, msg)
        case 'compact_boundary': return compactBoundaryFrames(sessionId, msg)
        case 'local_command_output': return transcriptAnnouncement(sessionId, msg)
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

/** A streaming event: `sdk.stream`. */
export function streamEventFrames(sessionId, msg, _stream) {
  return [{ type: 'sdk.stream', sessionId, event: msg.event, parentToolUseId: msg.parent_tool_use_id }]
}

/** A status frame: the CLI started compacting. */
export function statusFrames(sessionId, msg) {
  return msg.status === 'compacting' ? [{ type: 'sdk.status', sessionId, status: 'compacting' }] : []
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
