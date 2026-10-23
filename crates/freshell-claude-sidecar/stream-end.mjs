// stream-end.mjs — how a session's SDK message stream ended, as the sidecar
// reports it in its last stdout line (docs/plans/
// 2026-10-22-freshclaude-core-runtime.md §5.1 and §5.7).
// ---------------------------------------------------------------------------
// Each sidecar hosts one session, so an end of its SDK stream that nobody asked
// for is the end of the sidecar: index.mjs emits
// `sdk.stream.ended { sessionId, reason, message }` and exits with
// STREAM_ENDED_EXIT_CODE. The Rust server's end-of-output path then ends the
// session (and reports the cause to the user). A requested teardown (shutdown,
// stdin closing) is not a stream end and is never reported here.
//
// Reasons:
//   cli_exited    the CLI process died: the SDK's iterator threw its
//                 "Claude Code process terminated by signal …" or
//                 "… exited with code …" error (T14).
//   stream_error  the iterator threw anything else.
//   stream_eof    the iterator ended with no error: the CLI exited with code 0
//                 (the SDK reports no error for that exit code).

/** The sidecar's exit code after an SDK stream end it did not ask for. */
export const STREAM_ENDED_EXIT_CODE = 3

/** The most characters of an error message the frame carries (the SDK appends the CLI's stderr tail). */
export const STREAM_END_MESSAGE_MAX_CHARS = 1000

const CLI_EXIT = /^Claude Code process (?:terminated by signal|exited with code) /

const EOF_MESSAGE = 'The Claude CLI ended the session without reporting an error.'

/**
 * `{ reason, message }` for a stream end. `failure` is `{ error }` when the
 * SDK's iterator threw `error`, or undefined when it ended normally.
 */
export function streamEnd(failure) {
  if (!failure) return { reason: 'stream_eof', message: EOF_MESSAGE }
  const error = failure.error
  const text = String(error?.message || error)
  return {
    reason: CLI_EXIT.test(text) ? 'cli_exited' : 'stream_error',
    message: text.slice(0, STREAM_END_MESSAGE_MAX_CHARS),
  }
}
