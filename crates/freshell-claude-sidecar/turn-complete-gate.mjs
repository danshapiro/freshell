/**
 * Unified "needs attention" turn-complete gate (freshell-claude-sidecar).
 * Interim: the Rust Stop latch replaces it (docs/plans/
 * 2026-10-22-freshclaude-core-runtime.md §5.3-5.4, C18).
 *
 * Every SDK `result` — success, error_during_execution, error_max_turns,
 * error_max_budget_usd, error_max_structured_output_retries, and
 * success-with-is_error — ends a turn the user may not have been watching,
 * so every result emits `sdk.turn.complete`. The ONE exception is the
 * result of the turn the user stopped. The arm site (index.mjs
 * handleInterrupt) arms the mark ONLY while a turn is plausibly awaiting a
 * terminal frame — `if (st.pendingResults > 0)
 * st.turnCompleteGate.noteInterruptRequest()` — because the SDK RESOLVES an
 * interrupt with nothing in flight (sdk.d.ts:2384-2394; no result follows).
 * A rejected interrupt (ok:false — the turn kept running) clears the mark.
 *
 * The next result consumes the mark, and it is silenced only when it was
 * aborted (terminal_reason aborted_streaming/aborted_tools, T11; or, on a
 * CLI that reports no terminal_reason, error_during_execution). A Stop that
 * missed its turn — one sent while the CLI was still starting, whose receipt
 * comes back ok while the turn then runs to success/completed (T13) — must
 * not silence that turn (G06): the user believes it stopped, and it did not.
 * Consuming the mark on every result also means a stale mark (armed for a
 * send the CLI absorbed into an earlier turn, T10) never swallows a later
 * turn's bell.
 *
 * There is DELIBERATELY no reset-on-send: the SDK serializes turns within
 * one query (a queued send is input pushed onto the same stream, and
 * results arrive in turn order), so the stopped turn's result is the FIRST
 * result after the accepted settle. A reset-at-send would race a queued send
 * against the stopped turn's late result and let the user's own Stop ring.
 */

import { isAbortedResult } from './sdk-message-frames.mjs'

/** The result is the turn a Stop landed on. */
function wasStopped(result) {
  if (isAbortedResult(result)) return true
  // A CLI that predates terminal_reason reports a stopped turn only as
  // error_during_execution.
  return result?.terminal_reason == null && result?.subtype === 'error_during_execution'
}

export function createTurnCompleteGate() {
  let userInterruptPending = false
  return {
    noteInterruptRequest() { userInterruptPending = true },
    noteInterruptSettled(ok) { if (!ok) userInterruptPending = false },
    /** Whether this SDK `result` rings; consumes any pending Stop mark. */
    resultEmitsAttention(result) {
      const stopped = userInterruptPending && wasStopped(result)
      userInterruptPending = false
      return !stopped
    },
  }
}
