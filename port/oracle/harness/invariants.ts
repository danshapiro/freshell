/**
 * T2 behavioral-invariant contract for the equivalence oracle.
 *
 * The T2 rung drives a REAL coding-CLI task with a LIVE (cheap) model call
 * THROUGH the freshell server and asserts BEHAVIORAL INVARIANTS — shape,
 * presence, persistence, parseability, and wire behavior — NEVER LLM-text
 * equality (model output is nondeterministic, so byte/text equality is not a
 * valid oracle here). The pinned reply is only checked for *containing* a
 * sentinel token, tolerating provider preamble.
 *
 * This module is deliberately PROVIDER-AGNOSTIC: it reads a structured
 * `T2Observation` produced by a provider-specific harness (opencode today;
 * claude/codex slot in next by registering their id-shapes below). The exact
 * same invariants will later be evaluated against the Rust port's observation,
 * so the ORIGINAL-side observation captured today is the T2 baseline the port
 * is diffed against.
 *
 * No server / network / node-pty imports here — pure logic, cheap to unit-test.
 */

/** The `freshAgent.session.materialized` wire event (server→client). */
export interface T2SessionMaterializedEvent {
  previousSessionId: string
  sessionId: string
  sessionType: string
  provider: string
}

/** A persisted opencode-style session row (provider-agnostic shape subset). */
export interface T2SessionRow {
  id: string
  title: string | null
  directory: string | null
}

/**
 * Structured, serializable observation of ONE live T2 run. Everything the
 * invariants need must live here (no live handles) so the same assertions run
 * against the original and the future Rust port.
 */
export interface T2Observation {
  // ── provenance / baseline context ───────────────────────────────────────
  /** Runtime provider under test: 'opencode' | 'claude' | 'codex'. */
  provider: string
  /** Full model id driven, e.g. 'umans-ai-coding-plan/umans-kimi-k2.7'. */
  model: string
  /** Pinned prompt sent (recorded for reproducibility). */
  prompt: string
  /** Sentinel token the pinned reply is expected to contain. */
  sentinelToken: string

  // ── session lifecycle ───────────────────────────────────────────────────
  /** POST /api/tabs returned a pane + session id. */
  sessionCreated: boolean
  /** Placeholder id returned at create time (e.g. 'freshopencode-...'). */
  initialSessionId: string | null
  /** Durable id after the turn materializes (e.g. 'ses_...'). */
  durableSessionId: string | null
  /** Durable session reference { provider, sessionId } if materialized. */
  sessionRef: { provider: string; sessionId: string } | null

  // ── turn lifecycle ──────────────────────────────────────────────────────
  /** The turn was dispatched and the provider began it (durable session materialized). */
  turnAccepted: boolean
  /**
   * BEHAVIORAL completion: the assistant reply (containing the sentinel) was
   * observed/persisted. NOTE: this is deliberately NOT the provider's idle flag —
   * see `serverReportedIdle`. opencode's headless/isolated serve replies quickly
   * but does not reliably emit a turn-idle signal, so the persisted reply is the
   * authoritative behavioral completion edge for T2.
   */
  turnCompleted: boolean
  /**
   * FINDING (opencode session lifecycle): whether the provider serve actually
   * emitted a turn-idle/complete signal within the observation window. Expected
   * FALSE in the isolated/headless serve — recorded so the Rust port is graded
   * on reproducing the SAME lifecycle (reply persists; idle not signalled).
   */
  serverReportedIdle: boolean
  /** ms from firing the turn to the assistant reply first being observed. */
  assistantReplyLatencyMs: number
  /** Reported send status if the blocking send happened to return ('idle'|'approx'|null). */
  sendStatus: string | null
  submittedTurnId: string | null

  // ── assistant reply (behavioral, NOT text-equality) ─────────────────────
  /** Rendered transcript from GET /panes/:id/capture (may be truncated for record). */
  captureText: string
  captureLength: number
  captureNonEmpty: boolean
  /** Capture contains the sentinel token (case-insensitive; preamble tolerated). */
  captureContainsSentinel: boolean

  // ── persistence into the ISOLATED store (never the user's) ──────────────
  /** Absolute path of the isolated opencode.db this run wrote to. */
  dbPath: string
  dbSessionRowPresent: boolean
  dbSessionRow: T2SessionRow | null
  dbMessageCount: number
  dbPartCount: number
  dbHasAssistantMessage: boolean
  /** At least one persisted message/part `data` JSON parsed to an object. */
  transcriptParseable: boolean

  // ── wire behavior (server→client WS) ────────────────────────────────────
  /** Distinct server→client message types seen during create+turn. */
  wsServerMessageTypes: string[]
  /** The materialized event observed on the wire, if any. */
  sessionMaterializedEvent: T2SessionMaterializedEvent | null

  // ── safety / ownership ──────────────────────────────────────────────────
  /** After teardown: spawned server pid gone AND no sentinel-owned strays remain. */
  ownedCleanupOk: boolean
  /** Pids still carrying our ownership sentinel after teardown (must be empty). */
  strayOwnedPidsAfter: number[]
  /** Number of live model round-trips this run performed (cost discipline). */
  liveModelCalls: number

  // ── timing ──────────────────────────────────────────────────────────────
  timings: { createMs: number; turnMs: number; totalMs: number }
}

/** One evaluated invariant. */
export interface T2InvariantResult {
  name: string
  ok: boolean
  /** Whether a failure here should fail the run, or is informational only. */
  fatal: boolean
  detail: string
}

/** The full pass/fail report for a T2 observation. */
export interface T2InvariantReport {
  ok: boolean
  provider: string
  model: string
  passed: number
  failed: number
  results: T2InvariantResult[]
  summary: string
}

/**
 * Per-provider session-id shape expectations. New providers slot in here.
 *   - placeholder: the id returned by POST /api/tabs before the first turn.
 *   - durable: the id after the first turn materializes a real provider session.
 */
export const PROVIDER_ID_SHAPES: Record<string, { placeholder: RegExp; durable: RegExp }> = {
  opencode: {
    placeholder: /^freshopencode-/,
    durable: /^ses_[A-Za-z0-9]+$/,
  },
  claude: {
    placeholder: /^freshclaude-/,
    durable: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  },
  codex: {
    placeholder: /^freshcodex-/,
    durable: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  },
}

/**
 * Does `text` contain `token`, tolerating surrounding provider preamble and
 * case differences? This is the ONLY thing we check about LLM text — never
 * equality.
 */
export function containsSentinel(text: string, token: string): boolean {
  if (!text || !token) return false
  return text.toLowerCase().includes(token.toLowerCase())
}

function shapeFor(provider: string): { placeholder: RegExp; durable: RegExp } | undefined {
  return PROVIDER_ID_SHAPES[provider]
}

/**
 * Evaluate every T2 behavioral invariant against an observation and return a
 * structured report. Pure and deterministic — safe to unit-test with synthetic
 * observations (no live call required).
 */
export function assertT2Invariants(obs: T2Observation): T2InvariantReport {
  const results: T2InvariantResult[] = []
  const add = (name: string, ok: boolean, detail: string, fatal = true) =>
    results.push({ name, ok, fatal, detail })

  const shape = shapeFor(obs.provider)

  // 1. Session created with a well-formed placeholder id.
  {
    const idOk = !!obs.initialSessionId && !!shape && shape.placeholder.test(obs.initialSessionId)
    add(
      'session.created',
      obs.sessionCreated && idOk,
      shape
        ? `sessionCreated=${obs.sessionCreated}, initialSessionId=${obs.initialSessionId ?? 'null'} ` +
            `(expected /${shape.placeholder.source}/)`
        : `no id-shape registered for provider "${obs.provider}"`,
    )
  }

  // 2. Durable session id has the expected provider shape after the turn.
  {
    const durOk = !!obs.durableSessionId && !!shape && shape.durable.test(obs.durableSessionId)
    add(
      'session.durable-id-shape',
      durOk,
      shape
        ? `durableSessionId=${obs.durableSessionId ?? 'null'} (expected /${shape.durable.source}/)`
        : `no id-shape registered for provider "${obs.provider}"`,
    )
  }

  // 3. The turn was dispatched and the provider began it (durable session made).
  add('turn.accepted', obs.turnAccepted, `turnAccepted=${obs.turnAccepted}`)

  // 4. BEHAVIORAL completion: the assistant reply was observed/persisted (NOT the
  //    provider's unreliable idle flag — see provider.emits-idle-signal below).
  add(
    'turn.completed',
    obs.turnCompleted,
    `turnCompleted(reply-observed)=${obs.turnCompleted}, ` +
      `assistantReplyLatencyMs=${obs.assistantReplyLatencyMs}, sendStatus=${obs.sendStatus ?? 'null'}`,
  )

  // 5. The LIVE model actually replied with the pinned sentinel (preamble ok).
  add(
    'assistant.replied-sentinel',
    obs.captureContainsSentinel,
    `capture contains "${obs.sentinelToken}"=${obs.captureContainsSentinel} ` +
      `(captureLength=${obs.captureLength})`,
  )

  // 6. The session + at least one message persisted into the ISOLATED store.
  add(
    'transcript.persisted',
    obs.dbSessionRowPresent && obs.dbMessageCount > 0,
    `dbSessionRowPresent=${obs.dbSessionRowPresent}, dbMessageCount=${obs.dbMessageCount}, ` +
      `dbPartCount=${obs.dbPartCount}, dbPath=${obs.dbPath}`,
  )

  // 7. The persisted transcript is structurally parseable (JSON message/part data).
  add(
    'transcript.parseable',
    obs.transcriptParseable && obs.captureNonEmpty,
    `transcriptParseable=${obs.transcriptParseable}, captureNonEmpty=${obs.captureNonEmpty}, ` +
      `dbHasAssistantMessage=${obs.dbHasAssistantMessage}`,
  )

  // 8. The server emitted the session-materialized event on the wire, linking
  //    the placeholder id to the durable id.
  {
    const ev = obs.sessionMaterializedEvent
    const linked =
      !!ev &&
      ev.previousSessionId === obs.initialSessionId &&
      ev.sessionId === obs.durableSessionId &&
      ev.provider === obs.provider
    add(
      'wire.session-materialized',
      linked,
      ev
        ? `materialized previous=${ev.previousSessionId} → durable=${ev.sessionId} (provider=${ev.provider})`
        : 'no freshAgent.session.materialized observed on the capture socket',
      // Non-fatal: the materialized broadcast targets the session's authorizing
      // client; an unauthorized capture socket may not receive it. Recorded for
      // the record + the Rust-port diff, but does not gate T2 green.
      false,
    )
  }

  // 9. Ownership-safe teardown: spawned pids gone, no sentinel-owned strays.
  add(
    'ownership.cleanup',
    obs.ownedCleanupOk && obs.strayOwnedPidsAfter.length === 0,
    `ownedCleanupOk=${obs.ownedCleanupOk}, strayOwnedPidsAfter=[${obs.strayOwnedPidsAfter.join(', ')}]`,
  )

  // Informational (non-fatal): does the provider serve emit a turn-idle signal?
  // FINDING: opencode's headless/isolated serve replies fast but leaves the
  // session perpetually "busy" (no idle event / status never flips). Surfaced
  // here so the lifecycle difference is legible and the Rust port is graded on
  // reproducing it — never text — rather than silently regressing on it.
  add(
    'provider.emits-idle-signal',
    obs.serverReportedIdle,
    `serverReportedIdle=${obs.serverReportedIdle} ` +
      `(opencode-in-isolation is expected NOT to emit idle; behavioral completion ` +
      `is asserted via the persisted reply instead)`,
    false,
  )

  // Informational: cost discipline. Not fatal, but surfaced so a runaway
  // live-call count is visible in the report.
  add(
    'cost.live-calls-bounded',
    obs.liveModelCalls >= 1 && obs.liveModelCalls <= 2,
    `liveModelCalls=${obs.liveModelCalls} (expected 1–2 for a single-turn T2 run)`,
    false,
  )

  const fatalResults = results.filter((r) => r.fatal)
  const failed = fatalResults.filter((r) => !r.ok).length
  const passed = fatalResults.filter((r) => r.ok).length
  const ok = failed === 0
  const failedNames = fatalResults.filter((r) => !r.ok).map((r) => r.name)

  return {
    ok,
    provider: obs.provider,
    model: obs.model,
    passed,
    failed,
    results,
    summary: ok
      ? `T2 invariants PASS (${passed}/${fatalResults.length}) for ${obs.provider} · ${obs.model}`
      : `T2 invariants FAIL (${failed} failed: ${failedNames.join(', ')}) for ${obs.provider} · ${obs.model}`,
  }
}
