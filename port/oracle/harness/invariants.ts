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
   * SECONDARY corroboration of completion: the assistant reply (containing the
   * sentinel) was observed/persisted into the isolated store. This CORROBORATES
   * the primary idle edge (`serverReportedIdle`) but is deliberately not the
   * primary completion signal — see the debugger's finding in
   * `port/oracle/notes/t2-opencode-stall.md`: opencode 1.17.13 DOES emit
   * `session.idle` / `session.status{type:idle}` ~5s after the turn, so the idle
   * edge is the authoritative completion signal and the persisted reply merely
   * confirms it.
   */
  turnCompleted: boolean
  /**
   * PRIMARY completion edge: whether the provider serve emitted a turn-idle
   * signal (`session.idle` / `session.status{type:idle}`) that freshell surfaced
   * through its blocking send (send-keys returned `data.status === 'idle'`).
   * Expected TRUE — a correctly-driven turn completes on the idle edge. (The
   * earlier "opencode never flips to idle" premise was a MISdiagnosis caused by a
   * cold-serve health-probe wedge; with the serve warmed the idle edge fires.)
   * The Rust port is graded on reproducing this SAME idle-edge completion.
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

  // 4. SECONDARY corroboration of completion: the assistant reply (sentinel) was
  //    observed/persisted. This confirms the PRIMARY idle edge asserted in
  //    provider.emits-idle-signal below — never the sole completion signal.
  add(
    'turn.completed',
    obs.turnCompleted,
    `turnCompleted(reply-persisted, secondary)=${obs.turnCompleted}, ` +
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

  // PRIMARY completion invariant (FATAL): the provider serve emitted a turn-idle
  // signal (session.idle / session.status{type:idle}) that freshell surfaced as a
  // completed turn (send-keys returned status=idle). The debugger PROVED opencode
  // 1.17.13 emits the idle edge ~5s post-turn once the serve is health-ready, so a
  // correctly-driven turn MUST complete on this edge — the persisted reply
  // (turn.completed above) only corroborates it. The Rust port is graded on
  // reproducing this same idle-edge completion.
  add(
    'provider.emits-idle-signal',
    obs.serverReportedIdle,
    `serverReportedIdle=${obs.serverReportedIdle} ` +
      `(turn completion observed via session.idle/session.status{idle}, surfaced through ` +
      `freshell's blocking send returning status=idle; persisted reply corroborates it)`,
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

// ── baseline projection (LLM-text-free) ─────────────────────────────────────────

/**
 * The ORIGINAL-side T2 baseline the Rust port is diffed against. Deliberately
 * LLM-text-FREE and free of per-run nondeterminism (no captureText, no concrete
 * random ids, no temp paths, no timings): only the structural SHAPES + the
 * invariant PASS/FAIL matrix — the facts a correct port must reproduce.
 */
export interface T2Baseline {
  tier: 'T2'
  provider: string
  model: string
  sentinelToken: string
  /** Fatal invariant names — these MUST be green for a conformant port. */
  assertedInvariants: string[]
  /** Non-fatal invariant names — recorded/observed but do not gate green. */
  informationalInvariants: string[]
  /** Overall grade of the captured original run (must be true to be a valid baseline). */
  ok: boolean
  passed: number
  failed: number
  /** The invariant matrix (name/ok/fatal only — details are dropped as they carry per-run ids/paths). */
  invariantMatrix: Array<{ name: string; ok: boolean; fatal: boolean }>
  /** Structural shapes the port must reproduce (booleans / counts / patterns / wire-type set). */
  shapes: {
    /** Regex source the placeholder id must match (provider id-shape). */
    placeholderIdPattern: string | null
    /** Regex source the durable id must match (provider id-shape). */
    durableIdPattern: string | null
    placeholderIdMatches: boolean
    durableIdMatches: boolean
    sessionCreated: boolean
    turnAccepted: boolean
    /** PRIMARY completion edge: provider signalled idle (session.idle/status{idle}). */
    serverReportedIdle: boolean
    /** SECONDARY corroboration: assistant reply persisted with the sentinel. */
    turnCompleted: boolean
    dbSessionRowPresent: boolean
    dbMessageCount: number
    dbPartCount: number
    dbHasAssistantMessage: boolean
    transcriptParseable: boolean
    captureNonEmpty: boolean
    captureContainsSentinel: boolean
    /** Distinct server→client wire types seen (types only — never payloads). */
    wsServerMessageTypes: string[]
    sessionMaterializedObserved: boolean
    liveModelCalls: number
    ownedCleanupOk: boolean
  }
}

/**
 * Project a live observation + its graded report into the stable, LLM-text-free
 * T2 baseline. Provenance (opencode version, capture timestamp) is added by the
 * caller that persists the file.
 */
export function summarizeT2ForBaseline(obs: T2Observation, report: T2InvariantReport): T2Baseline {
  const shape = shapeFor(obs.provider)
  return {
    tier: 'T2',
    provider: obs.provider,
    model: obs.model,
    sentinelToken: obs.sentinelToken,
    assertedInvariants: report.results.filter((r) => r.fatal).map((r) => r.name),
    informationalInvariants: report.results.filter((r) => !r.fatal).map((r) => r.name),
    ok: report.ok,
    passed: report.passed,
    failed: report.failed,
    invariantMatrix: report.results.map((r) => ({ name: r.name, ok: r.ok, fatal: r.fatal })),
    shapes: {
      placeholderIdPattern: shape ? shape.placeholder.source : null,
      durableIdPattern: shape ? shape.durable.source : null,
      placeholderIdMatches: !!obs.initialSessionId && !!shape && shape.placeholder.test(obs.initialSessionId),
      durableIdMatches: !!obs.durableSessionId && !!shape && shape.durable.test(obs.durableSessionId),
      sessionCreated: obs.sessionCreated,
      turnAccepted: obs.turnAccepted,
      serverReportedIdle: obs.serverReportedIdle,
      turnCompleted: obs.turnCompleted,
      dbSessionRowPresent: obs.dbSessionRowPresent,
      dbMessageCount: obs.dbMessageCount,
      dbPartCount: obs.dbPartCount,
      dbHasAssistantMessage: obs.dbHasAssistantMessage,
      transcriptParseable: obs.transcriptParseable,
      captureNonEmpty: obs.captureNonEmpty,
      captureContainsSentinel: obs.captureContainsSentinel,
      wsServerMessageTypes: [...obs.wsServerMessageTypes].sort(),
      sessionMaterializedObserved: obs.sessionMaterializedEvent !== null,
      liveModelCalls: obs.liveModelCalls,
      ownedCleanupOk: obs.ownedCleanupOk,
    },
  }
}
