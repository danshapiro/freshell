/**
 * T2 LIVE behavioral-invariant harness — opencode + Kimi k2.7 slice.
 * ---------------------------------------------------------------------------
 * Boots the ORIGINAL freshell server as an isolated external process, seeds the
 * user's opencode auth (read-only) into that isolated HOME, drives ONE real
 * coding-CLI turn with a LIVE (cheap) Kimi call THROUGH the server's real
 * fresh-agent surface, and distils the result into a structured `T2Observation`
 * that `assertT2Invariants` (invariants.ts) grades on SHAPE / PRESENCE /
 * PERSISTENCE / PARSEABILITY / WIRE behavior — never LLM-text equality.
 *
 * This is the ORIGINAL-side T2 baseline. The Rust port will later be driven
 * through the identical surface and its T2Observation diffed against this one.
 *
 * ── Exact seed paths (confirmed by probe on this host) ──────────────────────
 *   MODEL   : umans-ai-coding-plan/umans-kimi-k2.7   (the already-wired cheapest path)
 *   AUTH src: ~/.local/share/opencode/auth.json      (user, READ-ONLY)
 *   AUTH dst: <isoHOME>/.local/share/opencode/auth.json   (= XDG_DATA_HOME/opencode/auth.json)
 *   DB      : <isoHOME>/.local/share/opencode/opencode.db  (ISOLATED — never the user's 4.6 GB store)
 *   CONFIG  : NOT seeded. Probe proved auth.json alone makes `umans-kimi-k2.7`
 *             available via opencode's built-in registry; seeding the user's
 *             ~/.config/opencode would drag in plugins + an MCP sidecar. We also
 *             pin XDG_CONFIG_HOME/XDG_CACHE_HOME at empty temp dirs so a leaked
 *             parent XDG_CONFIG_HOME can never load the user's opencode plugins.
 *
 * ── Opencode session lifecycle the Rust port must reproduce ─────────────────
 *   1. POST /api/tabs {agent:'opencode',model,effort} → placeholder id
 *      `freshopencode-<nanoid>` (NO provider session, NO serve spawn yet — lazy).
 *   2. The first turn spawns `opencode serve`, creates the real `ses_<...>`
 *      session, and persists the assistant reply + messages + parts into the
 *      isolated opencode.db.
 *
 * Turn completion uses the IDLE EDGE as the PRIMARY signal: opencode's provider
 * send blocks server-side until the session goes idle, and freshell's fresh-agent
 * send-keys returns `data.status === 'idle'` on that edge. The debugger PROVED
 * (notes/t2-opencode-stall.md, Exp4) that opencode 1.17.13 DOES emit session.idle /
 * session.status{type:idle} ~5s post-turn — the earlier "never flips to idle" note
 * was a MISdiagnosis caused by a cold-serve health-probe wedge. So this harness
 * AWAITS the turn, treats the idle edge as primary completion, and uses the
 * persisted assistant reply as SECONDARY corroboration. Never LLM-text equality.
 *
 * ── STATUS (original-side, captured this run) ───────────────────────────────
 * VERIFIED directly: with the seed paths above, `opencode serve` in an isolated
 * home creates a session in ~0.2s and Kimi returns the pinned reply (containing
 * the sentinel), persisted to the isolated opencode.db, in ~10s. So the auth
 * seeding, HOME/XDG isolation, warm-cache sharing, and the live model path are
 * all correct and the T2 invariants are satisfiable.
 *
 * DEV-0001 (the cold-serve health-probe wedge) was the SOLE blocker to driving
 * that same turn THROUGH the freshell fresh-agent adapter (POST /api/tabs +
 * send-keys). It is now stepped around here by an `OPENCODE_CMD` warm-proxy
 * (`opencode-warm-proxy.ts`) that starts the real `opencode serve` on a private
 * inner port, waits for its health, then opens an L4 passthrough on freshell's
 * port — so freshell's own un-timed probe succeeds immediately, with ZERO source
 * mutation (the PORT, not this baseline, fixes the probe itself). The proxy + its
 * inner serve inherit this run's ownership sentinel and are reaped normally. With
 * the warm-proxy the full turn completes: durable `ses_…` (turnAccepted), reply
 * persisted (secondary corroboration), send-keys returns status=idle (primary
 * idle edge). `t2-opencode-kimi.test.ts` now FAILS LOUDLY (never silently skips)
 * whenever the gate is on but the turn does not accept or complete.
 *
 * SAFETY: only ever reaps processes carrying THIS run's ownership sentinel
 * (`FRESHELL_PROBE_SENTINEL=<sentinelPath>`, inherited by the server and every
 * grandchild). Never kills by name; never touches the user's live server
 * (:3001) or their live opencode/codex sessions.
 */

import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { startExternalServer, type ExternalServerHandle, type OracleTarget } from './external-server.js'
import { writeWarmProxyShim } from './opencode-warm-proxy.js'
import { WsCaptureClient } from './ws-capture-client.js'
import {
  type T2Observation,
  type T2SessionMaterializedEvent,
} from './invariants.js'

// ── constants ───────────────────────────────────────────────────────────────

/** The already-wired cheapest path. DO NOT change to a pricier model. */
export const KIMI_MODEL = 'umans-ai-coding-plan/umans-kimi-k2.7'
/** Single tiny pinned-output prompt — bounds cost + makes the reply checkable. */
export const DEFAULT_T2_PROMPT = 'Reply with exactly this token and nothing else: freshell-t2-ok'
/** The sentinel the reply must CONTAIN (preamble tolerated; never equality). */
export const DEFAULT_T2_SENTINEL = 'freshell-t2-ok'

const OPENCODE_DATA_SUBPATH = ['.local', 'share', 'opencode'] as const
const CAPTURE_TEXT_CAP = 4000

/**
 * DETERMINISM GATE for the T2 DB snapshot (fixes the T2-opencode structural flake).
 * After the sentinel reply text lands in a `part` row (~0.5s), the third-party
 * `opencode serve` binary commits the assistant MESSAGE row a few seconds later
 * (the committed original baseline settled at ~+5.5s with dbMessageCount=2). The
 * harness must WAIT for that durable steady state before snapshotting the DB, or it
 * reads dbMessageCount/dbHasAssistantMessage at a NON-DETERMINISTIC instant
 * (msgs=1/false before the row commits vs 2/true after). 15s is ~3x the observed
 * settle time; poll every 250ms.
 */
const DB_STEADY_STATE_BUDGET_MS = 15_000
const DB_STEADY_STATE_POLL_MS = 250

/** Elapsed-time breadcrumbs to stderr; gated so green runs stay quiet. */
function trace(enabled: boolean, startedAt: number, msg: string): void {
  if (!enabled) return
  // eslint-disable-next-line no-console
  console.error(`[t2-live +${Date.now() - startedAt}ms] ${msg}`)
}

/** Best-effort: last `n` lines of a text file (warm-proxy diagnostics only). */
async function tailFile(filePath: string, n: number): Promise<string> {
  try {
    const txt = await fsp.readFile(filePath, 'utf8')
    return txt.split('\n').slice(-n).join('\n')
  } catch {
    return '(no warm-proxy log)'
  }
}

// ── auth path resolution + availability gate ─────────────────────────────────

export interface OpencodeAuthPaths {
  /** User's real auth store (source; READ-ONLY). */
  userAuthJson: string
  /** Where the isolated server reads auth from, relative to a HOME. */
  relAuthJson: string
  /** Where the isolated opencode.db lands, relative to a HOME. */
  relDbPath: string
}

export function opencodeAuthPaths(): OpencodeAuthPaths {
  return {
    userAuthJson: path.join(os.homedir(), ...OPENCODE_DATA_SUBPATH, 'auth.json'),
    relAuthJson: path.join(...OPENCODE_DATA_SUBPATH, 'auth.json'),
    relDbPath: path.join(...OPENCODE_DATA_SUBPATH, 'opencode.db'),
  }
}

async function pathExists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true } catch { return false }
}

/** Absolute path of the real `opencode` binary on PATH, or null if unresolvable. */
export function resolveOpencodeBinary(): string | null {
  const r = spawnSync('bash', ['-lc', 'command -v -- opencode'], { encoding: 'utf8', timeout: 5000 })
  const resolved = r.status === 0 ? r.stdout.trim() : ''
  return resolved ? resolved : null
}

function opencodeBinaryResolvable(): boolean {
  return resolveOpencodeBinary() !== null
}

/**
 * Gate for the LIVE test: is the opencode/Kimi path actually usable in an
 * isolated home on this host? Checks the binary + that the user's auth.json
 * exists and carries the `umans-ai-coding-plan` credential Kimi needs. NEVER
 * prints secret material.
 */
export async function opencodeKimiT2Available(): Promise<{ available: boolean; reason: string }> {
  if (process.platform !== 'linux') {
    return { available: false, reason: `ownership-safe reaping is linux-only (platform=${process.platform})` }
  }
  if (!opencodeBinaryResolvable()) {
    return { available: false, reason: 'opencode binary not on PATH' }
  }
  const { userAuthJson } = opencodeAuthPaths()
  if (!(await pathExists(userAuthJson))) {
    return { available: false, reason: `missing opencode auth at ${userAuthJson}` }
  }
  try {
    const parsed = JSON.parse(await fsp.readFile(userAuthJson, 'utf8')) as Record<string, unknown>
    if (!('umans-ai-coding-plan' in parsed)) {
      return { available: false, reason: 'auth.json has no "umans-ai-coding-plan" credential (Kimi provider)' }
    }
  } catch (err) {
    return { available: false, reason: `auth.json unreadable/unparseable: ${(err as Error).message}` }
  }
  return { available: true, reason: 'opencode + umans-kimi-k2.7 credential present' }
}

/**
 * Seed the user's opencode auth (read-only copy) into an isolated HOME so the
 * server's lazily-spawned `opencode serve` can authenticate — while ALL session
 * data (opencode.db, transcripts) lands under the same isolated HOME, never the
 * user's real store. Returns the concrete seeded + db paths for the record.
 */
export async function seedOpencodeAuthIntoHome(homeDir: string): Promise<{ authTarget: string; dbPath: string }> {
  const { userAuthJson, relAuthJson, relDbPath } = opencodeAuthPaths()
  const authTarget = path.join(homeDir, relAuthJson)
  await fsp.mkdir(path.dirname(authTarget), { recursive: true })
  await fsp.copyFile(userAuthJson, authTarget) // READ user, WRITE temp only
  return { authTarget, dbPath: path.join(homeDir, relDbPath) }
}

// ── ownership-safe process accounting (sentinel-scoped) ──────────────────────

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Every process this run spawned (the server and every grandchild — opencode
 * serve included) inherits `FRESHELL_PROBE_SENTINEL=<sentinelPath>`. Scanning
 * /proc for that exact value yields a provably-ours pid set that can NEVER
 * match the user's live server or their opencode sessions.
 */
export async function collectSentinelOwnedPids(sentinelPath: string): Promise<number[]> {
  if (process.platform !== 'linux') return []
  const marker = `FRESHELL_PROBE_SENTINEL=${sentinelPath}`
  const entries = await fsp.readdir('/proc').catch(() => [] as string[])
  const owned: number[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    const raw = await fsp.readFile(`/proc/${pid}/environ`).catch(() => null)
    if (!raw) continue
    if (raw.toString('utf8').split('\0').includes(marker)) owned.push(pid)
  }
  return owned
}

/** SIGTERM→SIGKILL every sentinel-owned pid; return any that survive. */
export async function reapSentinelOwned(sentinelPath: string): Promise<number[]> {
  let owned = await collectSentinelOwnedPids(sentinelPath)
  for (const pid of owned) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
  for (let i = 0; i < 20 && owned.length > 0; i++) {
    await sleep(150)
    owned = await collectSentinelOwnedPids(sentinelPath)
    if (owned.length === 0) break
  }
  for (const pid of owned) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  await sleep(200)
  return collectSentinelOwnedPids(sentinelPath)
}

// ── isolated opencode.db reads (read-only; never the user's DB) ──────────────

interface DbFacts {
  sessionRowPresent: boolean
  sessionRow: { id: string; title: string | null; directory: string | null } | null
  messageCount: number
  partCount: number
  hasAssistantMessage: boolean
  transcriptParseable: boolean
  /** An assistant message/part whose persisted text contains the sentinel token. */
  assistantContainsSentinel: boolean
}

/** Newest persisted session id in the isolated DB, or null. */
function newestSessionId(dbPath: string): string | null {
  const db = openDbReadOnly(dbPath)
  try {
    try { db.exec('PRAGMA busy_timeout=5000') } catch { /* best effort */ }
    const row = db
      .prepare('SELECT id FROM session ORDER BY time_created DESC LIMIT 1')
      .get() as { id?: unknown } | undefined
    return row?.id ? String(row.id) : null
  } finally {
    db.close()
  }
}

/** Poll until a durable session row appears in the isolated DB (turn start). */
async function waitForDurableSessionId(dbPath: string, budgetMs: number): Promise<string | null> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (await pathExists(dbPath)) {
      try {
        const id = newestSessionId(dbPath)
        if (id) return id
      } catch { /* DB mid-write; retry */ }
    }
    await sleep(200)
  }
  return null
}

function openDbReadOnly(dbPath: string): DatabaseSync {
  try {
    return new DatabaseSync(dbPath, { readOnly: true } as unknown as Record<string, unknown>)
  } catch {
    return new DatabaseSync(dbPath)
  }
}

function readDbFacts(dbPath: string, sessionId: string, sentinel: string): DbFacts {
  const db = openDbReadOnly(dbPath)
  const needle = sentinel.toLowerCase()
  try {
    try { db.exec('PRAGMA busy_timeout=5000') } catch { /* best effort */ }
    const sessionRow = db
      .prepare('SELECT id, title, directory FROM session WHERE id = ? LIMIT 1')
      .get(sessionId) as { id?: unknown; title?: unknown; directory?: unknown } | undefined

    const messageCount = Number(
      (db.prepare('SELECT COUNT(*) AS n FROM message WHERE session_id = ?').get(sessionId) as { n?: unknown })?.n ?? 0,
    )
    const partCount = Number(
      (db.prepare('SELECT COUNT(*) AS n FROM part WHERE session_id = ?').get(sessionId) as { n?: unknown })?.n ?? 0,
    )

    const msgRows = db
      .prepare('SELECT data FROM message WHERE session_id = ? LIMIT 100')
      .all(sessionId) as Array<{ data?: unknown }>
    let parseable = false
    let hasAssistant = false
    const assistantMessageIds = new Set<string>()
    for (const row of msgRows) {
      const data = typeof row.data === 'string' ? row.data : undefined
      if (!data) continue
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>
        if (parsed && typeof parsed === 'object') parseable = true
        if (parsed.role === 'assistant' || /"role"\s*:\s*"assistant"/.test(data)) {
          hasAssistant = true
          if (typeof parsed.id === 'string') assistantMessageIds.add(parsed.id)
        }
      } catch { /* a non-JSON row does not prove parseability */ }
    }

    // The reply text lives in the `part` table (type=text). Scan assistant
    // parts for the sentinel — never equality, just presence.
    let assistantContainsSentinel = false
    const partRows = db
      .prepare('SELECT message_id, data FROM part WHERE session_id = ? LIMIT 200')
      .all(sessionId) as Array<{ message_id?: unknown; data?: unknown }>
    for (const row of partRows) {
      const data = typeof row.data === 'string' ? row.data : undefined
      if (!data) continue
      if (parseable === false) { try { JSON.parse(data); parseable = true } catch { /* ignore */ } }
      const belongsToAssistant = typeof row.message_id === 'string' && assistantMessageIds.has(row.message_id)
      if ((belongsToAssistant || assistantMessageIds.size === 0) && data.toLowerCase().includes(needle)) {
        assistantContainsSentinel = true
      }
    }

    return {
      sessionRowPresent: !!sessionRow?.id,
      sessionRow: sessionRow?.id
        ? {
            id: String(sessionRow.id),
            title: sessionRow.title == null ? null : String(sessionRow.title),
            directory: sessionRow.directory == null ? null : String(sessionRow.directory),
          }
        : null,
      messageCount,
      partCount,
      hasAssistantMessage: hasAssistant,
      transcriptParseable: parseable,
      assistantContainsSentinel,
    }
  } finally {
    db.close()
  }
}

const EMPTY_DB_FACTS: DbFacts = {
  sessionRowPresent: false, sessionRow: null, messageCount: 0, partCount: 0,
  hasAssistantMessage: false, transcriptParseable: false, assistantContainsSentinel: false,
}

/**
 * Poll the isolated DB until the assistant reply (containing the sentinel) is
 * persisted. This is the BEHAVIORAL completion edge for T2 — opencode replies
 * fast but never flips the session to idle in a headless/isolated serve, so we
 * observe the persisted reply directly rather than waiting on a status flag.
 */
async function waitForAssistantReply(
  dbPath: string,
  sessionId: string,
  sentinel: string,
  budgetMs: number,
): Promise<{ facts: DbFacts; latencyMs: number }> {
  const started = Date.now()
  const deadline = started + budgetMs
  let last: DbFacts = EMPTY_DB_FACTS
  while (Date.now() < deadline) {
    if (await pathExists(dbPath)) {
      try {
        last = readDbFacts(dbPath, sessionId, sentinel)
        if (last.assistantContainsSentinel) return { facts: last, latencyMs: Date.now() - started }
      } catch { /* DB mid-write; retry */ }
    }
    await sleep(500)
  }
  return { facts: last, latencyMs: Date.now() - started }
}

/**
 * The durable STEADY STATE the T2 DB snapshot must wait for: the assistant reply
 * text is present AND opencode has committed the assistant MESSAGE row (>=2 rows:
 * the user turn + the assistant reply). Message counts only grow within a single
 * turn, so this predicate is MONOTONIC — once true it stays true, so gating on it
 * can never re-introduce a race.
 */
function dbFactsAtSteadyState(f: DbFacts): boolean {
  return f.assistantContainsSentinel && f.messageCount >= 2 && f.hasAssistantMessage
}

/**
 * DETERMINISM GATE — poll the isolated DB until it reaches the durable steady state
 * (assistant MESSAGE row committed), bounded by `budgetMs`. Returns the settled
 * facts and whether the steady state was actually reached (false ⇒ the caller must
 * FAIL LOUD rather than snapshot a non-deterministic partial state).
 *
 * The `opencode serve` binary that writes this DB is IDENTICAL for the node original
 * and the rust port, so this only changes WHEN the harness reads the DB — never any
 * server/port behavior. Called from the shared driver, so the original-side capture
 * and the rust-side capture wait identically and read the SAME settled DB state.
 */
async function waitForDbSteadyState(
  dbPath: string,
  sessionId: string,
  sentinel: string,
  budgetMs: number,
): Promise<{ facts: DbFacts; reachedSteadyState: boolean }> {
  const deadline = Date.now() + budgetMs
  let last: DbFacts = EMPTY_DB_FACTS
  for (;;) {
    try { last = readDbFacts(dbPath, sessionId, sentinel) } catch { /* DB mid-write; retry */ }
    if (dbFactsAtSteadyState(last)) return { facts: last, reachedSteadyState: true }
    if (Date.now() >= deadline) return { facts: last, reachedSteadyState: false }
    await sleep(DB_STEADY_STATE_POLL_MS)
  }
}

// ── authenticated HTTP against the isolated server ───────────────────────────

async function httpJson(
  baseUrl: string,
  token: string,
  method: string,
  routePath: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; json: any }> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl}${routePath}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-auth-token': token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: ac.signal,
    })
    const text = await res.text()
    let json: any = undefined
    try { json = text ? JSON.parse(text) : undefined } catch { json = { __raw: text } }
    return { status: res.status, json }
  } finally {
    clearTimeout(timer)
  }
}

async function httpText(
  baseUrl: string,
  token: string,
  routePath: string,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl}${routePath}`, {
      headers: { 'x-auth-token': token },
      signal: ac.signal,
    })
    return { status: res.status, text: await res.text() }
  } finally {
    clearTimeout(timer)
  }
}

// ── run orchestration ────────────────────────────────────────────────────────

export interface RunT2Options {
  model?: string
  prompt?: string
  sentinel?: string
  /** cwd the opencode session runs in (default: a fresh temp project dir). */
  cwd?: string
  /** Turn idle budget in ms (Kimi round-trips can take 30–120s). Default 180s. */
  turnTimeoutMs?: number
  /** Pipe the spawned server's stdout/stderr. */
  verbose?: boolean
  /**
   * Which server to drive: the node original (`'node'`, default) or the Rust port
   * (`'rust'`). The SAME driver produces the T2Observation for both, so the oracle's
   * original-vs-rust comparison is a true same-driver / different-SUT differential.
   */
  target?: OracleTarget
  /**
   * Whether to front the `opencode serve` with the DEV-0001 warm-proxy. Defaults to
   * TRUE for the node original (which needs it to step around the cold-serve
   * health-probe wedge) and FALSE for the Rust port, which carries the DEV-0001 fix
   * natively and COLD-STARTS the serve clean — the fingerprint the T2-rust equivalence
   * test asserts (`usedWarmProxy === false`).
   */
  warmProxy?: boolean
}

export interface T2TeardownFacts {
  serverPidGone: boolean
  strayOwnedPidsAfter: number[]
  ownedCleanupOk: boolean
}

export interface T2Run {
  handle: ExternalServerHandle
  /** Which server was driven ('node' original or 'rust' port). */
  target: OracleTarget
  /**
   * Whether the DEV-0001 warm-proxy fronted the serve. FALSE for the Rust port —
   * the cold-start-clean fingerprint the T2-rust equivalence test asserts.
   */
  usedWarmProxy: boolean
  /** Isolated project cwd created for this run (removed on teardown). */
  cwd: string
  /** Empty temp XDG_CONFIG_HOME pinned for opencode config isolation (removed on teardown). */
  xdgConfigHome: string
  /** Shared warm XDG_CACHE_HOME (the user's ~/.cache) — NOT temp, never removed. */
  xdgCacheHome: string
  /**
   * Observation with everything populated EXCEPT ownership fields, which are
   * filled by `teardown()` (they can only be known post-reap).
   */
  observation: T2Observation
  /** Stop the server, reap sentinel-owned strays, patch ownership fields in. */
  teardown(): Promise<T2TeardownFacts>
}

/**
 * Boot the isolated+seeded server, drive one live Kimi turn through the real
 * fresh-agent REST surface while a WS capture client records broadcasts, and
 * assemble the T2 observation. Makes EXACTLY ONE live model call.
 */
export async function runOpencodeKimiT2(options: RunT2Options = {}): Promise<T2Run> {
  const model = options.model ?? KIMI_MODEL
  const prompt = options.prompt ?? DEFAULT_T2_PROMPT
  const sentinel = options.sentinel ?? DEFAULT_T2_SENTINEL
  const turnTimeoutMs = options.turnTimeoutMs ?? 180_000
  const traceOn = options.verbose === true || !!process.env.FRESHELL_T2_TRACE
  const startedAt = Date.now()

  // Isolate opencode's CONFIG at an empty temp dir so a leaked parent
  // XDG_CONFIG_HOME can never pull in the user's opencode plugins/MCP.
  const xdgConfigHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-t2-xdgcfg-'))
  await fsp.mkdir(path.join(xdgConfigHome, 'opencode'), { recursive: true })

  // SHARE the user's regenerable model/package CACHE (~1 GB of provider SDKs +
  // the models.dev registry). This is NOT session data: sharing it read-mostly
  // keeps the first live turn from re-downloading/re-installing ~1 GB into a
  // cold cache (which blew past a 170s budget in an earlier run). Sessions /
  // transcripts still land ONLY in the isolated XDG_DATA_HOME.
  const xdgCacheHome = path.join(os.homedir(), '.cache')

  const ownsCwd = !options.cwd
  const cwd = options.cwd ?? (await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-t2-project-')))

  const target: OracleTarget = options.target ?? 'node'
  // The node original needs the DEV-0001 warm-proxy; the Rust port cold-starts clean.
  const useWarmProxy = options.warmProxy ?? target === 'node'

  // Both targets spawn the REAL `opencode serve` (the node original via the warm-proxy
  // passthrough; the Rust port directly, `OPENCODE_CMD` unset). Resolve it up front.
  const realOpencode = resolveOpencodeBinary()
  if (!realOpencode) {
    if (ownsCwd) await fsp.rm(cwd, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(xdgConfigHome, { recursive: true, force: true }).catch(() => {})
    throw new Error('opencode binary not resolvable on PATH (required for the T2 serve)')
  }

  // Warm-proxy (NODE ONLY): freshell honors OPENCODE_CMD as its serve command and invokes
  // it as `<cmd> serve --hostname H --port P`. We point it at a shim that warms the real
  // serve past DEV-0001's cold-accept race with ZERO source mutation (opencode-warm-proxy.ts).
  // The Rust port carries the DEV-0001 fix natively, so it gets NO OPENCODE_CMD and
  // cold-starts the serve directly — the observable fingerprint the T2-rust test asserts.
  let proxyDir: string | null = null
  let proxyLogPath = ''
  let warmProxyCmd: string | null = null
  if (useWarmProxy) {
    proxyDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-t2-proxy-'))
    proxyLogPath = path.join(proxyDir, 'warm-proxy.log')
    warmProxyCmd = await writeWarmProxyShim(proxyDir)
  }

  const rmOwnedTemps = async () => {
    await fsp.rm(xdgConfigHome, { recursive: true, force: true }).catch(() => {})
    if (proxyDir) await fsp.rm(proxyDir, { recursive: true, force: true }).catch(() => {})
    if (ownsCwd) await fsp.rm(cwd, { recursive: true, force: true }).catch(() => {})
  }

  trace(
    traceOn,
    startedAt,
    `booting isolated ${target} server + seeding opencode auth ` +
      `(warm-proxy: ${warmProxyCmd ?? 'none — cold-start'})…`,
  )
  let seededDbPath = ''
  let handle: ExternalServerHandle
  try {
    handle = await startExternalServer({
      target,
      provider: 'oracle-t2-opencode',
      startTimeoutMs: 90_000,
      verbose: options.verbose ?? false,
      env: {
        XDG_CONFIG_HOME: xdgConfigHome,
        XDG_CACHE_HOME: xdgCacheHome,
        // Warm-proxy wiring (node original only). Omitted for the Rust cold-start so its
        // ServeConfig command defaults to the real `opencode` binary.
        ...(useWarmProxy && warmProxyCmd
          ? {
              OPENCODE_CMD: warmProxyCmd,
              FRESHELL_T2_REAL_OPENCODE: realOpencode,
              FRESHELL_T2_PROXY_LOG: proxyLogPath,
            }
          : {}),
      },
      setupHome: async (homeDir) => {
        const { dbPath } = await seedOpencodeAuthIntoHome(homeDir)
        seededDbPath = dbPath
      },
    })
  } catch (err) {
    // startExternalServer cleans its own probe workspace on failure; we still
    // own the temp dirs created above.
    await rmOwnedTemps()
    throw err
  }
  trace(traceOn, startedAt, `server up: pid=${handle.pid} port=${handle.port}`)
  // Fallback if setupHome's closure value was not captured for any reason.
  if (!seededDbPath) seededDbPath = path.join(handle.homeDir, ...OPENCODE_DATA_SUBPATH, 'opencode.db')

  const ws = new WsCaptureClient(handle.wsUrl, handle.token)

  // The live turn's abort controller — held so teardown (or a blown deadline) can
  // cancel a still-open send-keys request.
  let pendingSendAbort: AbortController | null = null

  // Single reaper used by BOTH the mid-run failure path and the caller's
  // teardown, so a throw anywhere below can never leak the server or its
  // opencode serve grandchild.
  const hardCleanup = async (): Promise<T2TeardownFacts> => {
    const serverPid = handle.pid
    const sentinelPath = handle.sentinelPath
    try { pendingSendAbort?.abort() } catch { /* already settled */ }
    await ws.close().catch(() => {})
    try { await handle.stop() } catch { /* idempotent; sweep below is the net */ }
    const strays = await reapSentinelOwned(sentinelPath)
    const serverPidGone = !pidAlive(serverPid)
    await rmOwnedTemps()
    return { serverPidGone, strayOwnedPidsAfter: strays, ownedCleanupOk: serverPidGone && strays.length === 0 }
  }

  // Seed observation with pre-turn provenance; live facts fill in below.
  const observation: T2Observation = {
    provider: 'opencode',
    model,
    prompt,
    sentinelToken: sentinel,
    sessionCreated: false,
    initialSessionId: null,
    durableSessionId: null,
    sessionRef: null,
    turnAccepted: false,
    turnCompleted: false,
    serverReportedIdle: false,
    assistantReplyLatencyMs: 0,
    sendStatus: null,
    submittedTurnId: null,
    captureText: '',
    captureLength: 0,
    captureNonEmpty: false,
    captureContainsSentinel: false,
    dbPath: seededDbPath,
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
    // 0. Connect the capture socket + record the handshake so the materialized
    //    broadcast and the server→client message inventory are observed on the
    //    real wire. Best-effort: the capture client is an observer, never a driver.
    try {
      await ws.connect()
      await ws.captureHandshake(20_000)
    } catch (wsErr) {
      trace(traceOn, startedAt, `ws capture handshake skipped: ${(wsErr as Error)?.message}`)
    }

    // 1. Create the fresh-agent opencode pane (placeholder id; no serve yet).
    const tCreate = Date.now()
    const created = await httpJson(handle.baseUrl, handle.token, 'POST', '/api/tabs', {
      agent: 'opencode', cwd, model, effort: 'low',
    }, 30_000)
    observation.timings.createMs = Date.now() - tCreate
    if (created.status !== 200 || !created.json?.data?.paneId) {
      throw new Error(`POST /api/tabs failed: status=${created.status} body=${JSON.stringify(created.json)}`)
    }
    const paneId: string = created.json.data.paneId
    observation.sessionCreated = true
    observation.initialSessionId = created.json.data.sessionId ?? null
    trace(traceOn, startedAt, `tab created: pane=${paneId} placeholder=${observation.initialSessionId}; firing 1 live turn…`)

    // 2. FIRE the live turn. With the warm-proxy the serve is health-ready, so the
    //    fresh-agent send drives the turn and BLOCKS server-side until the session
    //    goes idle (the completion edge). We fire now so steps 3-4 can watch the
    //    durable session + reply materialize mid-turn, then AWAIT the idle edge in
    //    step 5. EXACTLY ONE live model call.
    const tTurn = Date.now()
    observation.liveModelCalls += 1
    const sendAc = new AbortController()
    pendingSendAbort = sendAc
    // Belt: abort the socket if freshell's own idle deadline (turnTimeoutMs) is
    // blown, so a network-level hang can never exceed the run budget.
    const sendAbortTimer = setTimeout(() => { try { sendAc.abort() } catch { /* settled */ } }, turnTimeoutMs + 15_000)
    if (typeof sendAbortTimer.unref === 'function') sendAbortTimer.unref()
    let sendOutcome = 'pending'
    const sendPromise = fetch(`${handle.baseUrl}/api/panes/${paneId}/send-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth-token': handle.token },
      body: JSON.stringify({ data: prompt, timeout: Math.floor(turnTimeoutMs / 1000) }),
      signal: sendAc.signal,
    }).then(
      async (res) => {
        const body = await res.text().catch(() => '')
        sendOutcome = `status=${res.status} body=${body.slice(0, 400)}`
        trace(traceOn, startedAt, `send-keys RESPONDED ${sendOutcome}`)
        try {
          const json = JSON.parse(body) as any
          observation.sendStatus = json?.data?.status ?? observation.sendStatus
          observation.submittedTurnId = json?.data?.submittedTurnId ?? observation.submittedTurnId
          observation.durableSessionId = observation.durableSessionId ?? json?.data?.sessionId ?? null
          observation.sessionRef = observation.sessionRef ?? json?.data?.sessionRef ?? null
          // PRIMARY completion edge: freshell surfaces the provider's idle signal
          // (session.idle / session.status{type:idle}) as an `ok` response with
          // data.status==='idle'. `approx` means the idle deadline was missed.
          if (res.status === 200 && json?.status === 'ok' && json?.data?.status === 'idle') {
            observation.serverReportedIdle = true
          }
        } catch { /* non-JSON body already captured in sendOutcome */ }
      },
      (err) => {
        sendOutcome = `rejected: ${(err as Error)?.name ?? String(err)}`
        trace(traceOn, startedAt, `send-keys ${sendOutcome}`)
      },
    ).finally(() => clearTimeout(sendAbortTimer))

    // 3. Observe the durable session materialize (created at turn start), from
    //    the DB OR the send-keys response — whichever surfaces the durable id.
    let durableId = await waitForDurableSessionId(seededDbPath, 60_000)
    if (!durableId && observation.durableSessionId) durableId = observation.durableSessionId
    observation.durableSessionId = durableId
    observation.turnAccepted = !!durableId
    if (durableId) {
      observation.sessionRef = observation.sessionRef ?? { provider: 'opencode', sessionId: durableId }
      trace(traceOn, startedAt, `durable session: ${durableId} (+${Date.now() - tTurn}ms)`)
    } else {
      const dbExists = await pathExists(seededDbPath)
      const proxyTail = await tailFile(proxyLogPath, 12)
      trace(traceOn, startedAt, `NO durable session after 60s. dbExists=${dbExists} newest=${dbExists ? newestSessionId(seededDbPath) : 'n/a'} sendOutcome=[${sendOutcome}]\n--- warm-proxy.log tail ---\n${proxyTail}`)
    }

    // 4. SECONDARY corroboration: wait for the assistant reply (with the sentinel)
    //    to PERSIST into the isolated store — confirms the idle edge from step 5.
    if (durableId) {
      // (a) BEHAVIORAL completion edge: the reply text (sentinel) lands FAST in a
      //     `part` row (~0.5s). This is what `turnCompleted` corroborates.
      const { facts: replyFacts, latencyMs } = await waitForAssistantReply(
        seededDbPath, durableId, sentinel, turnTimeoutMs,
      )
      observation.assistantReplyLatencyMs = latencyMs

      // (b) DETERMINISM GATE: the sentinel part appears BEFORE opencode commits the
      //     assistant MESSAGE row, so snapshotting here would read dbMessageCount /
      //     dbHasAssistantMessage at a non-deterministic instant (the T2-opencode
      //     flake: msgs=1/false vs 2/true). Wait, bounded, for the DURABLE STEADY
      //     STATE (message row committed) before snapshotting, so both the node
      //     original and the rust port read the SAME settled DB. Only gated when the
      //     sentinel actually landed — a missing reply is a separate, already-asserted
      //     turn-completion failure and must NOT be masked by (or wait out) this gate.
      let facts = replyFacts
      let reachedSteadyState = dbFactsAtSteadyState(replyFacts)
      if (replyFacts.assistantContainsSentinel && !reachedSteadyState) {
        const settled = await waitForDbSteadyState(
          seededDbPath, durableId, sentinel, DB_STEADY_STATE_BUDGET_MS,
        )
        facts = settled.facts
        reachedSteadyState = settled.reachedSteadyState
      }

      observation.dbSessionRowPresent = facts.sessionRowPresent
      observation.dbSessionRow = facts.sessionRow
      observation.dbMessageCount = facts.messageCount
      observation.dbPartCount = facts.partCount
      observation.dbHasAssistantMessage = facts.hasAssistantMessage
      observation.transcriptParseable = facts.transcriptParseable
      observation.turnCompleted = facts.assistantContainsSentinel
      trace(
        traceOn, startedAt,
        `reply persisted=${facts.assistantContainsSentinel} in ${latencyMs}ms ` +
          `(msgs=${facts.messageCount} parts=${facts.partCount} ` +
          `hasAssistant=${facts.hasAssistantMessage} steadyState=${reachedSteadyState})`,
      )

      // FAIL LOUD if the assistant reply landed but the durable MESSAGE row never
      // committed within the bound — refuse to snapshot a non-deterministic partial
      // DB state (do NOT silently snapshot early). Per the diagnosis the row commits
      // at ~+5.5s, so the 15s bound is ~3x margin; a genuine miss is worth surfacing.
      if (facts.assistantContainsSentinel && !reachedSteadyState) {
        throw new Error(
          `[t2-opencode] assistant reply persisted but the durable assistant message row did ` +
            `not commit within ${DB_STEADY_STATE_BUDGET_MS}ms ` +
            `(dbMessageCount=${facts.messageCount}, dbHasAssistantMessage=${facts.hasAssistantMessage}, ` +
            `dbPartCount=${facts.partCount}). Refusing to snapshot a non-deterministic partial DB ` +
            `state for the T2 structural baseline.`,
        )
      }
    }

    // 5. AWAIT the PRIMARY completion edge: send-keys resolves when the turn goes
    //    idle (data.status==='idle'), setting serverReportedIdle. Bounded by the
    //    abort timer above, so this can never hang past the run budget.
    await sendPromise
    observation.timings.turnMs = Date.now() - tTurn
    trace(traceOn, startedAt, `idle edge: serverReportedIdle=${observation.serverReportedIdle} sendStatus=${observation.sendStatus ?? 'null'} (+${observation.timings.turnMs}ms)`)

    // 5. Capture the rendered transcript via the real REST surface (best-effort;
    //    the persisted DB reply above is authoritative for the sentinel).
    const capture = await httpText(handle.baseUrl, handle.token, `/api/panes/${paneId}/capture`, 30_000)
      .catch(() => ({ status: 0, text: '' }))
    const captureText = capture.status === 200 ? capture.text : ''
    const captureHasSentinel = captureText.toLowerCase().includes(sentinel.toLowerCase())
    observation.captureLength = captureText.length
    observation.captureText = captureText.slice(0, CAPTURE_TEXT_CAP)
    observation.captureNonEmpty = captureText.trim().length > 0
    // Behavioral completion / sentinel presence via EITHER surface (persisted
    // transcript or capture render). Never text-equality — just presence.
    observation.turnCompleted = observation.turnCompleted || captureHasSentinel
    observation.captureContainsSentinel = captureHasSentinel || observation.turnCompleted

    // 6. Best-effort: the materialized broadcast may not reach an unauthorized
    //    capture socket. Recorded when present; non-fatal when absent.
    const materialized = await ws.waitForType('freshAgent.session.materialized', 3_000).catch(() => null)
    if (materialized) {
      const p = materialized.parsed as Record<string, unknown>
      observation.sessionMaterializedEvent = {
        previousSessionId: String(p.previousSessionId ?? ''),
        sessionId: String(p.sessionId ?? ''),
        sessionType: String(p.sessionType ?? ''),
        provider: String(p.provider ?? ''),
      } satisfies T2SessionMaterializedEvent
    }
    observation.wsServerMessageTypes = Array.from(
      new Set(ws.getServerMessages().map((m) => m.type).filter((t): t is string => !!t)),
    )
  } catch (err) {
    // A mid-run throw must NOT leak the isolated server or its opencode serve
    // grandchild (an earlier version did). Reap everything we own, then rethrow.
    trace(traceOn, startedAt, `run failed: ${(err as Error)?.message}; self-reaping owned processes…`)
    await hardCleanup().catch(() => {})
    throw err
  } finally {
    observation.timings.totalMs = Date.now() - startedAt
    await ws.close().catch(() => { /* best effort */ })
  }

  const teardown = async (): Promise<T2TeardownFacts> => {
    // Delegates to the shared reaper. NOTE: xdgCacheHome is the USER's ~/.cache
    // (shared warm cache) and is deliberately NEVER removed here.
    const facts = await hardCleanup()
    observation.strayOwnedPidsAfter = facts.strayOwnedPidsAfter
    observation.ownedCleanupOk = facts.ownedCleanupOk
    return facts
  }

  return { handle, target, usedWarmProxy: useWarmProxy, cwd, xdgConfigHome, xdgCacheHome, observation, teardown }
}
