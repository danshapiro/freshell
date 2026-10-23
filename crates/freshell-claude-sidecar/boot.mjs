// boot.mjs — how a `create` request becomes an SDK launch, and how a launch
// the CLI refused is reported (docs/plans/2026-10-22-freshclaude-core-runtime.md
// §4.2 and §5.1, protocol v2). Pure: index.mjs keeps the side effects.
// ---------------------------------------------------------------------------
// The sidecar answers `created` only once the CLI has booted
// (`initializationResult()` resolved, T2). A boot the CLI refused is answered
// with `create.failed { code, message }` instead, and the sidecar exits with
// BOOT_FAILED_EXIT_CODE. The codes come from the pinned CLI's exact refusal
// strings (claude-cli-contract.test.ts pins them, T4 and T5):
//
//   SESSION_ID_IN_USE        `Session ID X is already in use.` on the CLI's
//                            stderr, then exit code 1 (T4)
//   CONVERSATION_NOT_FOUND   `No conversation found with session ID: X` (T5)
//   RESUME_POINT_NOT_FOUND   `No message found with message.uuid of: U` (T5)
//   FORK_GUARD_REFUSED       `Resume rejected by --resume-drops-turn: …` (T5)
//   BOOT_FAILED              anything else (for one, a CLAUDE_CMD that is not
//                            the CLI)
//   SIDECAR_PROTOCOL_MISMATCH  the request does not speak SIDECAR_PROTOCOL

/** The stdio protocol version this sidecar speaks (`create.protocol`, `created.protocol`). */
export const SIDECAR_PROTOCOL = 2

/** The sidecar's exit code after a `create.failed`: it hosts no session. */
export const BOOT_FAILED_EXIT_CODE = 2

/** The most characters of refusal text a `create.failed` carries. */
export const BOOT_FAILURE_MESSAGE_MAX_CHARS = 1000

/** The refusals the CLI reports by name, each matched on its own line of evidence. */
const REFUSALS = [
  { code: 'SESSION_ID_IN_USE', pattern: /Session ID \S+ is already in use\./ },
  { code: 'CONVERSATION_NOT_FOUND', pattern: /No conversation found with session ID:.*/ },
  { code: 'RESUME_POINT_NOT_FOUND', pattern: /No message found with message\.uuid of:.*/ },
  { code: 'FORK_GUARD_REFUSED', pattern: /Resume rejected by --resume-drops-turn:.*/ },
]

const DIAGNOSTIC_PREFIX = '[ede_diagnostic]'

const BOOT_FAILED_COPY = 'The Claude CLI did not start.'

/** A `create` the sidecar cannot launch: its own code, message and no SDK call. */
export class CreateRequestError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CreateRequestError'
    this.code = code
  }
}

/**
 * The SDK `query()` options that pick which conversation the CLI boots
 * (protocol v2 `create.boot`). `sessionId` is the id Rust minted for this
 * session, when it minted one: a fresh boot runs under it and a fork writes
 * the child under it. A resume never sets `sessionId` (the SDK refuses
 * sessionId with resume unless forking).
 */
export function bootOptions(boot, sessionId) {
  switch (boot?.kind) {
    case 'fresh':
      return sessionId ? { sessionId } : {}
    case 'resume':
      if (!nonEmpty(boot.resume)) throw invalidBoot('a resume boot names no conversation')
      return { resume: boot.resume }
    case 'fork':
      if (!nonEmpty(boot.resume)) throw invalidBoot('a fork boot names no parent conversation')
      return {
        resume: boot.resume,
        forkSession: true,
        ...(nonEmpty(boot.resumeSessionAt) ? { resumeSessionAt: boot.resumeSessionAt } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(nonEmpty(boot.dropsTurn) ? { resumeDropsTurn: boot.dropsTurn } : {}),
      }
    default:
      throw invalidBoot(`unknown boot kind ${JSON.stringify(boot?.kind ?? null)}`)
  }
}

/**
 * Why the CLI refused to boot, as `{ code, message }`. The evidence is what
 * the boot produced: `error` (the `initializationResult()` rejection),
 * `resultErrors` (the `errors` of the `error_during_execution` result the CLI
 * sends before it rejects, T5) and `stderr` (the CLI's own output, where the
 * "already in use" refusal appears, T4). A named refusal's message is the
 * CLI's own sentence; anything else is BOOT_FAILED with the error's text.
 */
export function classifyBootError({ error, resultErrors = [], stderr = '' } = {}) {
  const results = resultErrors
    .filter((text) => typeof text === 'string')
    .map((text) => text.trim())
    .filter((text) => text && !text.startsWith(DIAGNOSTIC_PREFIX))
  const errorMessage = error === undefined ? '' : String(error?.message || error)
  const evidence = [...results, errorMessage, ...String(stderr).split('\n')]
    .flatMap((text) => text.split('\n'))
  for (const { code, pattern } of REFUSALS) {
    for (const line of evidence) {
      const match = pattern.exec(line)
      if (match) return { code, message: cut(match[0].trim()) }
    }
  }
  return { code: 'BOOT_FAILED', message: cut(results.join('\n') || errorMessage || BOOT_FAILED_COPY) }
}

function invalidBoot(message) {
  return new CreateRequestError('BOOT_FAILED', `invalid create request: ${message}`)
}

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0
}

function cut(text) {
  return text.slice(0, BOOT_FAILURE_MESSAGE_MAX_CHARS)
}
