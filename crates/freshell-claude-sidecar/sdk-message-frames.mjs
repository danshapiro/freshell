// The pure mapping from an SDK message to the sidecar's stdout frames
// (docs/plans/2026-10-22-freshclaude-core-runtime.md §3.2 and §9.1 N6). One
// function per SDK message kind; index.mjs keeps the side effects (emit). The
// core runtime owns the `result` mapping below; the transcript work adds the
// content kinds here.
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
