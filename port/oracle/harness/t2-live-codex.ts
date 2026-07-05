/**
 * T2 LIVE behavioral-invariant harness — freshcodex + cheap-GPT (codex-spark) slice.
 * ---------------------------------------------------------------------------
 * Boots the ORIGINAL freshell server as an isolated external process, seeds the
 * user's Codex credential + config (READ-ONLY copies) into that isolated HOME's
 * CODEX_HOME, drives ONE real (cheap) GPT turn THROUGH the server's real fresh-agent
 * WS surface (`freshAgent.create` → `freshAgent.send`), and distils the result into
 * the SAME structured `T2Observation` that `assertT2Invariants` (invariants.ts) grades
 * on SHAPE / PRESENCE / PERSISTENCE / PARSEABILITY / WIRE behavior — never LLM-text
 * equality. This is the ORIGINAL-side codex T2 baseline; the Rust port will later be
 * driven through the identical surface and diffed against it.
 *
 * ── Why this MIRRORS the claude/Haiku slice but differs in four concrete ways ──
 *   1. DRIVE PATH — codex is app-server-driven (freshell spawns the real `codex
 *      app-server` and speaks JSON-RPC 2.0 over WS), not the Claude SDK CLI. We still
 *      drive over the WS `freshAgent.*` surface because `freshAgent.create` /
 *      `freshAgent.send` AUTO-SUBSCRIBE the driving client (ws-handler
 *      ensureFreshAgentSubscription), so the completion edge is delivered to us.
 *   2. COMPLETION EDGE — the PRIMARY signal is the DISCRETE `freshAgent.turn.complete`
 *      wire event, but it is STATUS-GUARDED server-side: the codex `turn/completed`
 *      notification ALSO fires on interrupt/failure (CodexTurnStatusSchema =
 *      completed|interrupted|failed|inProgress), so the codex adapter emits
 *      `sdk.turn.complete` ONLY when `params.turn.status ?? params.status ===
 *      'completed'`  (server/fresh-agent/adapters/codex/adapter.ts:~922  →
 *       server/fresh-agent/sdk-events.ts:~71 → `freshAgent.turn.complete`). Observing
 *      the event on the wire is therefore a positive completion signal. The persisted
 *      rollout transcript is SECONDARY corroboration.
 *   3. SESSION ID — freshcodex `create` returns the codex app-server THREAD ID verbatim
 *      as the session id (adapter.create → runtime.startThread → { sessionId:
 *      started.threadId }; surfaced as freshAgent.created.sessionId). That id is a
 *      UUID (UUIDv7 in codex-cli 0.142.x) and is STABLE from create — there is NO
 *      placeholder→durable materialization (unlike opencode's freshopencode-→ses_), so
 *      placeholder == durable and NO freshAgent.session.materialized event fires.
 *   4. PERSISTENCE — codex persists a `rollout-<ts>-<threadId>.jsonl` under the isolated
 *      CODEX_HOME (`<HOME>/.codex/sessions/<date-dirs>/`), not a .jsonl under
 *      ~/.claude. We project that rollout into the SAME provider-agnostic db* fields.
 *
 * ── Exact seed paths (confirmed by probe + real-session-contract-harness) ────
 *   MODEL   : 'gpt-5.3-codex-spark' (override with FRESHELL_T2_CODEX_MODEL). It is the
 *             CHEAPEST GPT model reachable through freshell's freshcodex surface: the
 *             adapter clamps the model to the {gpt-5.5, gpt-5.4-flash,
 *             gpt-5.3-codex-spark} allowlist (shared/fresh-agent-models.ts
 *             normalizeFreshcodexModel, falling back to gpt-5.5), so the literal
 *             "mini" (gpt-5.4-mini, present in the codex model catalog) is UNREACHABLE
 *             — it would be silently rewritten to gpt-5.5. Of the reachable three,
 *             codex-spark is the small/cheap tier AND the only non-flagship one also
 *             present in the real codex model catalog (gpt-5.4-flash is absent from
 *             it). EFFORT is pinned to 'low' — the cheapest effort the codex model
 *             actually supports (probed live via model/list: codex models advertise
 *             ONLY {low,medium,high,xhigh}; freshell ALSO offers 'none'/'minimal',
 *             which the codex model rejects → a dispatched turn then silently STALLS.
 *             See notes/t2-codex-gptmini.md / candidate finding DEV-CODEX-EFFORT).
 *   AUTH src: ~/.codex/auth.json        (user, READ-ONLY)
 *   CFG  src: ~/.codex/config.toml      (user, READ-ONLY)
 *   AUTH dst: <isoHOME>/.codex/auth.json     (isolated copy)
 *   CFG  dst: <isoHOME>/.codex/config.toml   (isolated copy)
 *   HOME    : TestServer(runtimeRootMode:'isolated') sets HOME=<isoHOME>. codex resolves
 *             CODEX_HOME as `process.env.CODEX_HOME || $HOME/.codex`
 *             (server/coding-cli/providers/codex.ts:26) and neither the server nor the
 *             app-server child sets CODEX_HOME (verified: parent env has it unset), so
 *             the codex app-server authenticates from and writes ALL rollout/session
 *             data under the isolated `<isoHOME>/.codex` — NEVER the user's real ~/.codex.
 *   SANDBOX : permissionMode='never' (→ approvalPolicy 'never') + sandbox='read-only',
 *             so a pure-text turn can never hang on an interactive approval prompt nor
 *             write to the workspace while unattended.
 *
 * SAFETY: only ever reaps processes carrying THIS run's ownership sentinel
 * (`FRESHELL_PROBE_SENTINEL=<sentinelPath>`, inherited by the server, the spawned
 * `codex app-server`, and any MCP grandchild). Never kills by name; never touches the
 * user's live server (:3001) or their live codex sessions, and never writes to the
 * user's real ~/.codex.
 */

import { spawnSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { startExternalServer, type ExternalServerHandle, type OracleTarget } from './external-server.js'
import { WsCaptureClient, type CapturedMessage } from './ws-capture-client.js'
import { collectSentinelOwnedPids, reapSentinelOwned } from './t2-live.js'
import { enableFreshClients } from './t2-live-claude.js'
import { type T2Observation, type T2SessionMaterializedEvent } from './invariants.js'

// ── constants ───────────────────────────────────────────────────────────────

/**
 * Cheapest GPT model REACHABLE through freshell's freshcodex surface. See the header:
 * the freshcodex adapter clamps to a fixed allowlist, so gpt-5.4-mini is unreachable
 * (rewritten to gpt-5.5); codex-spark is the cheapest reachable + catalog-present model.
 */
export const CODEX_GPTMINI_MODEL = process.env.FRESHELL_T2_CODEX_MODEL?.trim() || 'gpt-5.3-codex-spark'
/**
 * Lowest VALID reasoning effort — bounds cost + latency for the trivial pinned turn.
 * NOTE: must be one of low/medium/high/max (max→codex 'xhigh'). The real codex
 * app-server only advertises efforts {low, medium, high, xhigh} for these models (probed
 * live via model/list), even though freshell's freshcodex options ALSO offer
 * 'none'/'minimal' (shared/fresh-agent-models.ts) — those are NOT accepted by the codex
 * models and, when sent, the turn is dispatched but the inference silently STALLS
 * (see notes/t2-codex-gptmini.md, candidate finding DEV-CODEX-EFFORT). 'low' is the
 * cheapest effort the codex model actually supports.
 */
export const CODEX_GPTMINI_EFFORT = process.env.FRESHELL_T2_CODEX_EFFORT?.trim() || 'low'
/** Single tiny pinned-output prompt — bounds cost + makes the reply checkable. */
export const DEFAULT_CODEX_T2_PROMPT = 'Reply with exactly: freshell-t2-ok'
/** The sentinel the reply must CONTAIN (preamble tolerated; never equality). */
export const DEFAULT_CODEX_T2_SENTINEL = 'freshell-t2-ok'

const CODEX_AUTH_SUBPATH = ['.codex', 'auth.json'] as const
const CODEX_CONFIG_SUBPATH = ['.codex', 'config.toml'] as const
const CODEX_SESSIONS_SUBPATH = ['.codex', 'sessions'] as const
const CAPTURE_TEXT_CAP = 4000
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

/** Elapsed-time breadcrumbs to stderr; gated so green runs stay quiet. */
function trace(enabled: boolean, startedAt: number, msg: string): void {
  if (!enabled) return
  // eslint-disable-next-line no-console
  console.error(`[t2-codex +${Date.now() - startedAt}ms] ${msg}`)
}

async function pathExists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true } catch { return false }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Last `n` lines of the isolated server's debug log (diagnostics only). */
async function tailFile(filePath: string, n: number): Promise<string> {
  try {
    const txt = await fsp.readFile(filePath, 'utf8')
    return txt.split('\n').slice(-n).join('\n')
  } catch (e) {
    return `(no server debug log at ${filePath}: ${(e as Error).message})`
  }
}

/**
 * On a STALL (no turn.complete edge) preserve the isolated server debug log + the rollout
 * transcript to a KEPT dir (teardown would otherwise delete them), and return a raw
 * rollout line-`type` histogram — so a stall is fully diagnosable WITHOUT another live
 * model call. Best-effort; never throws into the run.
 */
async function preserveStallDiagnostics(input: {
  debugLogPath: string
  sessionsDir: string
  rolloutPath: string | null
}): Promise<string> {
  try {
    const keepDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-t2-codex-diag-'))
    await fsp.copyFile(input.debugLogPath, path.join(keepDir, 'server-debug.log')).catch(() => {})
    let histogram = '(no rollout)'
    if (input.rolloutPath) {
      await fsp.copyFile(input.rolloutPath, path.join(keepDir, path.basename(input.rolloutPath))).catch(() => {})
      const raw = await fsp.readFile(input.rolloutPath, 'utf8').catch(() => '')
      const counts: Record<string, number> = {}
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const o = JSON.parse(line) as { type?: unknown; payload?: { type?: unknown } }
          const key = `${typeof o.type === 'string' ? o.type : '?'}${o.payload && typeof o.payload === 'object' && typeof o.payload.type === 'string' ? '/' + o.payload.type : ''}`
          counts[key] = (counts[key] ?? 0) + 1
        } catch { counts['<unparseable>'] = (counts['<unparseable>'] ?? 0) + 1 }
      }
      histogram = JSON.stringify(counts)
    }
    return `diagnostics preserved → ${keepDir}\n  rollout line-type histogram: ${histogram}`
  } catch (e) {
    return `(failed to preserve diagnostics: ${(e as Error).message})`
  }
}

// ── credential path resolution + availability gate ───────────────────────────

export interface CodexCredPaths {
  /** User's real Codex OAuth/API credential (source; READ-ONLY). */
  userAuth: string
  /** User's real Codex config.toml (source; READ-ONLY). */
  userConfig: string
  /** Where the isolated server's codex reads auth from, relative to a HOME. */
  relAuth: string
  /** Where the isolated server's codex reads config from, relative to a HOME. */
  relConfig: string
  /** Where codex persists rollout/session transcripts, relative to a HOME. */
  relSessions: string
}

export function codexCredPaths(): CodexCredPaths {
  return {
    userAuth: path.join(os.homedir(), ...CODEX_AUTH_SUBPATH),
    userConfig: path.join(os.homedir(), ...CODEX_CONFIG_SUBPATH),
    relAuth: path.join(...CODEX_AUTH_SUBPATH),
    relConfig: path.join(...CODEX_CONFIG_SUBPATH),
    relSessions: path.join(...CODEX_SESSIONS_SUBPATH),
  }
}

/** Absolute path of the real `codex` binary on PATH, or null if unresolvable. */
export function resolveCodexBinary(): string | null {
  const r = spawnSync('bash', ['-lc', 'command -v -- codex'], { encoding: 'utf8', timeout: 5000 })
  const resolved = r.status === 0 ? r.stdout.trim().split('\n')[0] : ''
  return resolved ? resolved : null
}

/** The `codex` CLI version string (recorded in the baseline provenance). */
export function codexVersion(): string {
  const r = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 15_000 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  return out ? out.split('\n')[0] : 'unknown'
}

/**
 * Gate for the LIVE test: is the codex/GPT path actually usable in an isolated home on
 * this host? Checks the binary + that the user's auth.json exists and is parseable JSON
 * + that config.toml exists. Also confirms CODEX_HOME is NOT leaking from the parent env
 * (which would break isolation). NEVER prints secret material.
 */
export async function codexGptMiniT2Available(): Promise<{ available: boolean; reason: string }> {
  if (process.platform !== 'linux') {
    return { available: false, reason: `ownership-safe reaping is linux-only (platform=${process.platform})` }
  }
  if (resolveCodexBinary() === null) {
    return { available: false, reason: 'codex binary not on PATH' }
  }
  if (process.env.CODEX_HOME && process.env.CODEX_HOME.trim().length > 0) {
    return {
      available: false,
      reason: `CODEX_HOME is set in the environment (${process.env.CODEX_HOME}); it would break isolation — unset it before running`,
    }
  }
  const { userAuth, userConfig } = codexCredPaths()
  if (!(await pathExists(userAuth))) {
    return { available: false, reason: `missing Codex auth at ${userAuth}` }
  }
  try {
    // Parse only to confirm it is well-formed JSON; never inspect/print the contents.
    JSON.parse(await fsp.readFile(userAuth, 'utf8'))
  } catch (err) {
    return { available: false, reason: `auth.json unreadable/unparseable: ${(err as Error).message}` }
  }
  if (!(await pathExists(userConfig))) {
    return { available: false, reason: `missing Codex config at ${userConfig}` }
  }
  return { available: true, reason: 'codex binary + ~/.codex/{auth.json,config.toml} present' }
}

/**
 * Seed the user's Codex credential + config (READ-ONLY copies) into an isolated HOME's
 * CODEX_HOME so the codex app-server the adapter spawns can authenticate — while ALL
 * session data (the `rollout-*.jsonl` transcripts) lands under the same isolated HOME,
 * never the user's real ~/.codex. Returns the concrete seeded paths.
 */
export async function seedCodexCredsIntoHome(homeDir: string): Promise<{
  authTarget: string
  configTarget: string
  sessionsDir: string
}> {
  const { userAuth, userConfig, relAuth, relConfig, relSessions } = codexCredPaths()
  const authTarget = path.join(homeDir, relAuth)
  const configTarget = path.join(homeDir, relConfig)
  await fsp.mkdir(path.dirname(authTarget), { recursive: true })
  await fsp.copyFile(userAuth, authTarget) // READ user, WRITE temp only
  await fsp.copyFile(userConfig, configTarget) // READ user, WRITE temp only
  // Lock the isolated copies down like the originals (0600) — defensive hygiene.
  await fsp.chmod(authTarget, 0o600).catch(() => {})
  await fsp.chmod(configTarget, 0o600).catch(() => {})

  // PRE-CREATE the codex rollout root (<CODEX_HOME>/sessions) so it EXISTS at app-server
  // boot — exactly as it does in every REAL codex user's home. A real user always has
  // ~/.codex/sessions (codex creates it on first run and its session-indexer watches it);
  // seeding only auth+config would leave it ABSENT in the isolated home at boot. This
  // pre-creation makes the isolated env match a real one WITHOUT mutating the reference
  // source (harness ENV parity, analogous to claude's ~/.claude/projects pre-create /
  // DEV-0002). If codex nonetheless crashes the freshell process during the first turn
  // because of an isolated-home path it expects but that is absent, that is a candidate
  // deviation: STOP and report it — do NOT patch source.
  const sessionsDir = path.join(homeDir, relSessions)
  await fsp.mkdir(sessionsDir, { recursive: true })
  return { authTarget, configTarget, sessionsDir }
}

// ── isolated rollout transcript reads (never the user's ~/.codex) ─────────────

interface RolloutFacts {
  transcriptPath: string | null
  /** Canonical codex thread/session UUID extracted from the rollout filename / session_meta. */
  sessionUuid: string | null
  present: boolean
  /** Count of user+assistant message lines. */
  messageCount: number
  /** Count of content blocks across assistant messages. */
  partCount: number
  hasAssistantMessage: boolean
  /** Every non-empty JSONL line parsed to an object. */
  parseable: boolean
  /** Concatenated assistant text (for the sentinel presence check). */
  assistantText: string
  assistantContainsSentinel: boolean
}

const EMPTY_ROLLOUT_FACTS: RolloutFacts = {
  transcriptPath: null, sessionUuid: null, present: false, messageCount: 0, partCount: 0,
  hasAssistantMessage: false, parseable: false, assistantText: '', assistantContainsSentinel: false,
}

async function listRolloutTranscripts(sessionsDir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes('rollout')) out.push(full)
    }
  }
  await walk(sessionsDir)
  return out
}

/** Newest rollout `.jsonl` under the isolated sessions dir, preferring one whose name
 *  contains `preferThreadId` when provided. */
async function pickRollout(sessionsDir: string, preferThreadId: string | null): Promise<string | null> {
  const files = await listRolloutTranscripts(sessionsDir)
  if (files.length === 0) return null
  if (preferThreadId) {
    const match = files.find((f) => path.basename(f).includes(preferThreadId))
    if (match) return match
  }
  // Otherwise the most-recently-modified rollout (this run's turn).
  const withMtime = await Promise.all(files.map(async (f) => ({ f, m: (await fsp.stat(f)).mtimeMs })))
  withMtime.sort((a, b) => b.m - a.m)
  return withMtime[0]?.f ?? null
}

/** Collect the array of text strings from a codex message `content` array. */
function collectContentText(content: unknown, into: string[]): number {
  let parts = 0
  if (typeof content === 'string') {
    into.push(content)
    return 1
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      parts += 1
      if (block && typeof block === 'object') {
        const t = (block as { text?: unknown }).text
        if (typeof t === 'string') into.push(t)
      }
    }
  }
  return parts
}

/**
 * Parse a codex rollout `.jsonl` into provider-agnostic facts. The rollout format is a
 * sequence of `{ type, timestamp, payload }` lines:
 *   - type='session_meta'                       → session/thread metadata (id, cwd)
 *   - type='response_item', payload.type='message' → { role, content:[{type,text}] }
 *   - type='event_msg', payload.type='agent_message' → { message } (assistant text)
 *   - type='event_msg', payload.type='user_message'  → { message } (user text)
 * We count response_item messages primarily; if none are present we fall back to the
 * event_msg user/agent messages. Assistant text is collected from BOTH forms.
 */
async function readRolloutFacts(transcriptPath: string, sentinel: string): Promise<RolloutFacts> {
  const raw = await fsp.readFile(transcriptPath, 'utf8').catch(() => '')
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0)
  const needle = sentinel.toLowerCase()
  let parseable = lines.length > 0
  let responseItemMessages = 0
  let eventMessages = 0
  let partCount = 0
  let hasAssistant = false
  let sessionUuid = UUID_RE.exec(path.basename(transcriptPath))?.[1] ?? null
  const assistantTextParts: string[] = []

  for (const line of lines) {
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      parseable = false
      continue
    }
    if (!obj || typeof obj !== 'object') { parseable = false; continue }
    const type = typeof obj.type === 'string' ? obj.type : undefined
    const payload = (obj.payload && typeof obj.payload === 'object' ? obj.payload : {}) as Record<string, unknown>
    const payloadType = typeof payload.type === 'string' ? payload.type : undefined

    if (!sessionUuid) {
      for (const cand of [obj.id, obj.sessionId, payload.id, payload.sessionId, (payload as { thread?: { id?: unknown } }).thread?.id]) {
        if (typeof cand === 'string' && UUID_RE.test(cand)) { sessionUuid = UUID_RE.exec(cand)![1]; break }
      }
    }

    if (type === 'response_item' && payloadType === 'message') {
      responseItemMessages += 1
      const role = typeof payload.role === 'string' ? payload.role : undefined
      if (role === 'assistant') {
        hasAssistant = true
        partCount += collectContentText(payload.content, assistantTextParts)
      }
    } else if (type === 'event_msg' && payloadType === 'agent_message') {
      eventMessages += 1
      hasAssistant = true
      if (typeof payload.message === 'string') { assistantTextParts.push(payload.message); partCount += 1 }
    } else if (type === 'event_msg' && payloadType === 'user_message') {
      eventMessages += 1
    }
  }

  const messageCount = responseItemMessages > 0 ? responseItemMessages : eventMessages
  const assistantText = assistantTextParts.join('\n')
  return {
    transcriptPath,
    sessionUuid,
    present: true,
    messageCount,
    partCount,
    hasAssistantMessage: hasAssistant,
    parseable,
    assistantText,
    assistantContainsSentinel: assistantText.toLowerCase().includes(needle),
  }
}

/**
 * Poll the isolated sessions dir until a rollout transcript with the assistant reply
 * (containing the sentinel) is persisted. SECONDARY corroboration of the primary
 * turn.complete edge — codex flushes the rollout as/after the turn completes.
 */
async function waitForRollout(
  sessionsDir: string,
  preferThreadId: string | null,
  sentinel: string,
  budgetMs: number,
): Promise<{ facts: RolloutFacts; latencyMs: number }> {
  const started = Date.now()
  const deadline = started + budgetMs
  let last: RolloutFacts = EMPTY_ROLLOUT_FACTS
  while (Date.now() < deadline) {
    const transcriptPath = await pickRollout(sessionsDir, preferThreadId)
    if (transcriptPath) {
      last = await readRolloutFacts(transcriptPath, sentinel)
      if (last.assistantContainsSentinel) return { facts: last, latencyMs: Date.now() - started }
    }
    await sleep(400)
  }
  return { facts: last, latencyMs: Date.now() - started }
}

// ── wire-event helpers (freshAgent.event envelopes) ───────────────────────────

/** Inner `event.type` of a `freshAgent.event` envelope, if present. */
function innerEventType(m: CapturedMessage): string | undefined {
  const parsed = m.parsed as { type?: unknown; event?: { type?: unknown } } | undefined
  if (!parsed || parsed.type !== 'freshAgent.event') return undefined
  const t = parsed.event?.type
  return typeof t === 'string' ? t : undefined
}

/** The inner event object of a `freshAgent.event` envelope. */
function innerEvent(m: CapturedMessage): Record<string, unknown> | undefined {
  const parsed = m.parsed as { type?: unknown; event?: unknown } | undefined
  if (!parsed || parsed.type !== 'freshAgent.event') return undefined
  const ev = parsed.event
  return ev && typeof ev === 'object' ? (ev as Record<string, unknown>) : undefined
}

// ── run orchestration ─────────────────────────────────────────────────────────

export interface RunCodexT2Options {
  model?: string
  effort?: string
  prompt?: string
  sentinel?: string
  /** cwd the codex session runs in (default: a fresh temp project dir). */
  cwd?: string
  /** Turn completion budget in ms (codex-spark is fast; app-server cold boot adds slack). Default 180s. */
  turnTimeoutMs?: number
  /** Pipe the spawned server's stdout/stderr. */
  verbose?: boolean
  /**
   * Which server to drive: the node original (`'node'`, default) or the Rust port
   * (`'rust'`). The SAME driver produces the T2Observation for both, so the oracle's
   * original-vs-rust comparison is a true same-driver / different-SUT differential
   * (mirrors the opencode T2-rust equivalence path). Both spawn the REAL `codex app-server`
   * under the isolated CODEX_HOME and drive the identical WS `freshAgent.*` surface.
   */
  target?: OracleTarget
}

export interface T2TeardownFacts {
  serverPidGone: boolean
  strayOwnedPidsAfter: number[]
  ownedCleanupOk: boolean
}

export interface CodexT2Run {
  handle: ExternalServerHandle
  /** Which server was driven ('node' original or 'rust' port). */
  target: OracleTarget
  /** Isolated project cwd created for this run (removed on teardown). */
  cwd: string
  /** Absolute isolated sessions dir observed for rollout transcripts. */
  sessionsDir: string
  observation: T2Observation
  teardown(): Promise<T2TeardownFacts>
}

/**
 * Boot the isolated+seeded server, drive one live cheap-GPT turn through the real
 * fresh-agent WS surface while capturing every broadcast, and assemble the T2
 * observation. Makes EXACTLY ONE live model call (the single `freshAgent.send`).
 */
export async function runCodexGptMiniT2(options: RunCodexT2Options = {}): Promise<CodexT2Run> {
  const model = options.model ?? CODEX_GPTMINI_MODEL
  const effort = options.effort ?? CODEX_GPTMINI_EFFORT
  const prompt = options.prompt ?? DEFAULT_CODEX_T2_PROMPT
  const sentinel = options.sentinel ?? DEFAULT_CODEX_T2_SENTINEL
  const turnTimeoutMs = options.turnTimeoutMs ?? 180_000
  const traceOn = options.verbose === true || !!process.env.FRESHELL_T2_TRACE
  const startedAt = Date.now()
  const target: OracleTarget = options.target ?? 'node'

  if (resolveCodexBinary() === null) {
    throw new Error('codex binary not resolvable on PATH (required for the codex T2 harness)')
  }

  const ownsCwd = !options.cwd
  const cwd = options.cwd ?? (await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-t2-codex-project-')))

  const rmOwnedTemps = async () => {
    if (ownsCwd) await fsp.rm(cwd, { recursive: true, force: true }).catch(() => {})
  }

  trace(traceOn, startedAt, `booting isolated server + seeding codex credential…`)
  let sessionsDir = ''
  let handle: ExternalServerHandle
  try {
    handle = await startExternalServer({
      target,
      provider: 'oracle-t2-codex',
      startTimeoutMs: 90_000,
      verbose: options.verbose ?? false,
      setupHome: async (homeDir) => {
        const { sessionsDir: seededSessions } = await seedCodexCredsIntoHome(homeDir)
        sessionsDir = seededSessions
      },
    })
  } catch (err) {
    await rmOwnedTemps()
    throw err
  }
  trace(traceOn, startedAt, `server up: pid=${handle.pid} port=${handle.port}`)
  if (!sessionsDir) sessionsDir = path.join(handle.homeDir, ...CODEX_SESSIONS_SUBPATH)

  const ws = new WsCaptureClient(handle.wsUrl, handle.token)

  // Single reaper used by BOTH the mid-run failure path and the caller's teardown, so a
  // throw anywhere below can never leak the server or its codex app-server grandchild.
  const hardCleanup = async (): Promise<T2TeardownFacts> => {
    const serverPid = handle.pid
    const sentinelPath = handle.sentinelPath
    await ws.close().catch(() => {})
    try { await handle.stop() } catch { /* idempotent; sweep below is the net */ }
    const strays = await reapSentinelOwned(sentinelPath)
    const serverPidGone = !pidAlive(serverPid)
    await rmOwnedTemps()
    return { serverPidGone, strayOwnedPidsAfter: strays, ownedCleanupOk: serverPidGone && strays.length === 0 }
  }

  // Seed observation with pre-turn provenance; live facts fill in below.
  const observation: T2Observation = {
    provider: 'codex',
    model,
    prompt,
    sentinelToken: sentinel,
    sessionCreated: false,
    initialSessionId: null,
    durableSessionId: null,
    sessionRef: null,
    turnAccepted: false,
    turnCompleted: false,
    serverReportedIdle: false, // N/A for codex — completion is the turn.complete edge
    turnCompleteEventObserved: false, // PRIMARY edge (filled below)
    assistantReplyLatencyMs: 0,
    sendStatus: null,
    submittedTurnId: null,
    captureText: '',
    captureLength: 0,
    captureNonEmpty: false,
    captureContainsSentinel: false,
    dbPath: '',
    dbSessionRowPresent: false,
    dbSessionRow: null,
    dbMessageCount: 0,
    dbPartCount: 0,
    dbHasAssistantMessage: false,
    transcriptParseable: false,
    wsServerMessageTypes: [],
    sessionMaterializedEvent: null,
    ownedCleanupOk: false,
    strayOwnedPidsAfter: [],
    liveModelCalls: 0,
    timings: { createMs: 0, turnMs: 0, totalMs: 0 },
  }

  try {
    // 0. Connect + authenticate (hello handshake). The capture client records every
    //    inbound message continuously, so the completion edge is never missed even
    //    while we await an earlier step.
    await ws.connect()
    await ws.captureHandshake(20_000)

    // 0a. Enable fresh clients on the ISOLATED server (default off) so the WS
    //     freshAgent.create gate is satisfied — the same runtime toggle a real
    //     freshcodex user / the e2e suite performs (PATCH /api/settings).
    await enableFreshClients(handle.baseUrl, handle.token)
    trace(traceOn, startedAt, 'fresh clients enabled on the isolated server')

    // 1. Create the freshcodex session (auto-subscribes this client). This SPAWNS the
    //    codex app-server child and starts a thread, so `created.sessionId` is the codex
    //    THREAD ID (a UUID), STABLE from create (no later materialization). NOT a model
    //    call — the model runs on send.
    const tCreate = Date.now()
    const createRequestId = `oracle-t2-codex-create-${Date.now()}`
    ws.send({
      type: 'freshAgent.create',
      requestId: createRequestId,
      sessionType: 'freshcodex',
      provider: 'codex',
      cwd,
      model,
      effort,
      permissionMode: 'never',
      sandbox: 'read-only',
    })
    const createdOrFailed = await ws.waitForServerMessage(
      (m) => (m.type === 'freshAgent.created' || m.type === 'freshAgent.create.failed')
        && (m.parsed as { requestId?: string })?.requestId === createRequestId,
      90_000, // generous: create awaits the codex app-server cold spawn + init
      'freshAgent.created',
    )
    observation.timings.createMs = Date.now() - tCreate
    if (createdOrFailed.type === 'freshAgent.create.failed') {
      const p = createdOrFailed.parsed as { code?: string; message?: string }
      throw new Error(`freshAgent.create failed: code=${p.code} message=${p.message}`)
    }
    const created = createdOrFailed.parsed as { sessionId?: string; sessionRef?: { provider: string; sessionId: string } }
    const threadId = created.sessionId
    if (!threadId) throw new Error('freshAgent.created carried no sessionId')
    observation.sessionCreated = true
    observation.initialSessionId = threadId
    // Codex's session id is stable from create — placeholder == durable.
    observation.durableSessionId = threadId
    observation.sessionRef = created.sessionRef ?? { provider: 'codex', sessionId: threadId }
    trace(traceOn, startedAt, `session created: threadId=${threadId}; firing 1 live ${model} turn…`)

    // 2. FIRE the single live turn. EXACTLY ONE live model call.
    const tTurn = Date.now()
    observation.liveModelCalls += 1
    const sendRequestId = `oracle-t2-codex-send-${Date.now()}`
    ws.send({
      type: 'freshAgent.send',
      requestId: sendRequestId,
      sessionId: threadId,
      sessionType: 'freshcodex',
      provider: 'codex',
      cwd,
      text: prompt,
    })

    // 2a. Await send acceptance (turn dispatched → runtime.startTurn returned a turnId).
    //     This is the codex "turn accepted" signal. Captures submittedTurnId.
    const accepted = await ws.waitForServerMessage(
      (m) => (m.type === 'freshAgent.send.accepted' || m.type === 'error')
        && ((m.parsed as { requestId?: string })?.requestId === sendRequestId),
      60_000,
      'freshAgent.send.accepted',
    ).catch(() => null)
    if (accepted?.type === 'error') {
      const p = accepted.parsed as { message?: string }
      throw new Error(`freshAgent.send rejected: ${p.message}`)
    }
    if (accepted) {
      const p = accepted.parsed as { submittedTurnId?: string }
      observation.submittedTurnId = p.submittedTurnId ?? null
      observation.sendStatus = 'accepted'
      observation.turnAccepted = true
    }

    // 3. AWAIT the PRIMARY completion edge: the discrete freshAgent.turn.complete. It is
    //    STATUS-GUARDED server-side (emitted only when the codex turn/completed carries
    //    turn.status/status==='completed'; interrupt/failure never fire it), so observing
    //    it here IS a positive completion signal. Poll so we can ALSO bail the moment the
    //    isolated server dies (rather than blocking the full budget on a dead server), and
    //    surface loud diagnostics on failure.
    const turnDeadline = Date.now() + turnTimeoutMs
    let serverDiedDuringTurn = false
    while (Date.now() < turnDeadline) {
      if (ws.getServerMessages().some((m) => innerEventType(m) === 'freshAgent.turn.complete')) break
      if (!pidAlive(handle.pid)) { serverDiedDuringTurn = true; break }
      await sleep(300)
    }
    const complete = ws.getServerMessages().find((m) => innerEventType(m) === 'freshAgent.turn.complete') ?? null
    observation.turnCompleteEventObserved = complete !== null
    observation.timings.turnMs = Date.now() - tTurn
    if (complete) {
      trace(traceOn, startedAt, `turn.complete edge observed (+${observation.timings.turnMs}ms)`)
    } else {
      // Loud diagnostics: surface any freshAgent.error + the server's own debug log, and
      // flag if the isolated server process exited mid-turn (a crash to report).
      const errEvt = ws.getServerMessages().map(innerEvent).find((e) => e?.type === 'freshAgent.error')
      const logTail = await tailFile(handle.debugLogPath, 40)
      trace(traceOn, startedAt,
        `NO turn.complete after +${observation.timings.turnMs}ms. serverDied=${serverDiedDuringTurn} ` +
        `error=${errEvt ? JSON.stringify(errEvt) : 'none'}\n--- server debug log tail ---\n${logTail}`)
    }

    // 4. SECONDARY corroboration: wait for the rollout .jsonl (with the sentinel) to
    //    persist into the ISOLATED store, then project it into the db* fields.
    const remaining = Math.max(15_000, turnTimeoutMs - (Date.now() - tTurn))
    const { facts, latencyMs } = await waitForRollout(sessionsDir, threadId, sentinel, remaining)
    observation.assistantReplyLatencyMs = latencyMs
    observation.dbPath = facts.transcriptPath ?? path.join(sessionsDir, '<unmaterialized>-rollout.jsonl')
    observation.dbSessionRowPresent = facts.present
    observation.dbSessionRow = facts.present
      ? { id: facts.sessionUuid ?? threadId, title: null, directory: cwd }
      : null
    observation.dbMessageCount = facts.messageCount
    observation.dbPartCount = facts.partCount
    observation.dbHasAssistantMessage = facts.hasAssistantMessage
    observation.transcriptParseable = facts.parseable
    observation.turnCompleted = facts.assistantContainsSentinel
    trace(traceOn, startedAt, `rollout=${facts.present} reply=${facts.assistantContainsSentinel} (msgs=${facts.messageCount} parts=${facts.partCount}) in ${latencyMs}ms`)

    // On a STALL, preserve the server debug log + rollout (teardown deletes the isolated
    // home) and print a raw rollout line-type histogram — so the cause is diagnosable
    // WITHOUT spending another live model call. Only fires on failure; green runs skip it.
    if (!observation.turnCompleteEventObserved) {
      const diag = await preserveStallDiagnostics({
        debugLogPath: handle.debugLogPath,
        sessionsDir,
        rolloutPath: facts.transcriptPath,
      })
      trace(true, startedAt, `STALL diagnostics — ${diag}`)
    }

    // 5. Assistant text ("capture"): prefer the persisted rollout; fall back to the
    //    streamed freshAgent.assistant blocks. Never text-equality — presence only.
    let captureText = facts.assistantText
    if (!captureText.trim()) {
      const streamed: string[] = []
      for (const m of ws.getServerMessages()) {
        const ev = innerEvent(m)
        if (ev?.type === 'freshAgent.assistant') collectContentText(ev.content, streamed)
      }
      captureText = streamed.join('\n')
    }
    const captureHasSentinel = captureText.toLowerCase().includes(sentinel.toLowerCase())
    observation.captureLength = captureText.length
    observation.captureText = captureText.slice(0, CAPTURE_TEXT_CAP)
    observation.captureNonEmpty = captureText.trim().length > 0
    observation.turnCompleted = observation.turnCompleted || captureHasSentinel
    observation.captureContainsSentinel = captureHasSentinel || observation.turnCompleted

    // 6. Materialized event (codex does NOT emit it — the thread id is stable from create,
    //    so there is no placeholder→durable transition — so this is recorded when present
    //    but is a NON-FATAL invariant, expected absent for codex).
    const materialized = ws.getServerMessages().find((m) => m.type === 'freshAgent.session.materialized')
      ?? ws.getServerMessages().find((m) => innerEventType(m) === 'freshAgent.session.materialized')
    if (materialized) {
      const p = (innerEvent(materialized) ?? (materialized.parsed as Record<string, unknown>))
      observation.sessionMaterializedEvent = {
        previousSessionId: String(p.previousSessionId ?? ''),
        sessionId: String(p.sessionId ?? ''),
        sessionType: String(p.sessionType ?? 'freshcodex'),
        provider: String(p.provider ?? 'codex'),
      } satisfies T2SessionMaterializedEvent
    }

    // 7. Distinct wire types seen — BOTH outer envelope types AND the inner
    //    freshAgent.event types (so the completion edge is visible in the baseline).
    const wireTypes = new Set<string>()
    for (const m of ws.getServerMessages()) {
      if (m.type) wireTypes.add(m.type)
      const inner = innerEventType(m)
      if (inner) wireTypes.add(inner)
    }
    observation.wsServerMessageTypes = Array.from(wireTypes)
  } catch (err) {
    trace(traceOn, startedAt, `run failed: ${(err as Error)?.message}; self-reaping owned processes…`)
    await hardCleanup().catch(() => {})
    throw err
  } finally {
    observation.timings.totalMs = Date.now() - startedAt
    await ws.close().catch(() => { /* best effort */ })
  }

  const teardown = async (): Promise<T2TeardownFacts> => {
    const facts = await hardCleanup()
    observation.strayOwnedPidsAfter = facts.strayOwnedPidsAfter
    observation.ownedCleanupOk = facts.ownedCleanupOk
    return facts
  }

  return { handle, target, cwd, sessionsDir, observation, teardown }
}

/** Re-exported so tests can assert ownership without importing t2-live directly. */
export { collectSentinelOwnedPids, reapSentinelOwned }
