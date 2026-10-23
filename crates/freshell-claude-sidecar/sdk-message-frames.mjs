// The pure mapping from an SDK message to the sidecar's stdout frames
// (docs/plans/2026-10-22-freshclaude-core-runtime.md §3.2 and §9.1 N6). One
// function per SDK message kind; index.mjs keeps the side effects (the turn
// gate, pendingResults, the attention clock, emit). The core runtime owns the
// `result` mapping below; the transcript work adds the content kinds here.
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

/**
 * The text a failed turn shows the user, or undefined for a successful result.
 * The CLI's internal `[ede_diagnostic]` lines are never shown; when nothing
 * else is left, the text explains the result kind in plain words.
 */
export function resultErrorText(result) {
  if (result.subtype === 'success') return undefined
  const errors = resultErrors(result)
  if (errors) return errors
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
 *
 * `sdk.result` carries the facts the server's verdict reads (design §5.3):
 * `subtype` (also as the older `result`), `isError`, `terminalReason` and
 * `numTurns` when the CLI reports them, and `errorText`, the CLI's own error
 * text without diagnostics (resultErrors).
 */
export function resultFrames(sessionId, result, { userStopped }) {
  const errorText = resultErrors(result)
  const frames = [{
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
  const failure = userStopped ? undefined : resultErrorText(result)
  if (failure) frames.push({ type: 'sdk.error', sessionId, message: failure, turnFailure: true })
  return frames
}
