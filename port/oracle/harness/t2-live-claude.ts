/**
 * T2 LIVE behavioral-invariant harness — freshclaude + Claude Haiku slice.
 * ---------------------------------------------------------------------------
 * Boots the ORIGINAL freshell server as an isolated external process, seeds the
 * user's Claude OAuth credential (READ-ONLY copy) into that isolated HOME, drives
 * ONE real (cheap) Claude Haiku turn THROUGH the server's real fresh-agent WS
 * surface (`freshAgent.create` → `freshAgent.send`), and distils the result into
 * the SAME structured `T2Observation` that `assertT2Invariants` (invariants.ts)
 * grades on SHAPE / PRESENCE / PERSISTENCE / PARSEABILITY / WIRE behavior — never
 * LLM-text equality. This is the ORIGINAL-side claude T2 baseline; the Rust port
 * will later be driven through the identical surface and diffed against it.
 *
 * ── Why this MIRRORS the opencode/Kimi slice but differs in three concrete ways ─
 *   1. DRIVE PATH — claude is SDK-driven (the @anthropic-ai/claude-agent-sdk
 *      spawns the real `claude` CLI), not a PTY or the opencode HTTP serve. We
 *      drive over the WS `freshAgent.*` surface because `freshAgent.create` /
 *      `freshAgent.send` AUTO-SUBSCRIBE the driving client (ws-handler
 *      ensureFreshAgentSubscription), so the completion edge is delivered to us
 *      directly. (The task allows the WS freshAgent.* surface as the drive path.)
 *   2. COMPLETION EDGE — the PRIMARY signal is the DISCRETE
 *      `freshAgent.turn.complete` wire event. It is emitted ONLY when the Claude
 *      SDK `result` message carries `subtype === 'success'`
 *      (server/sdk-bridge.ts:~469  → `sdk.turn.complete`  →
 *       server/fresh-agent/sdk-events.ts:~71 → `freshAgent.turn.complete`),
 *      so an interrupted/errored turn never fires it. Cleaner than opencode's
 *      idle poll. The persisted transcript is SECONDARY corroboration.
 *   3. PERSISTENCE — claude persists a `<uuid>.jsonl` transcript under the
 *      isolated CLAUDE_HOME (`<HOME>/.claude/projects/<cwd-hash>/<uuid>.jsonl`),
 *      not an opencode.db. We project that .jsonl into the SAME provider-agnostic
 *      db* observation fields the grader already reads.
 *
 * ── Exact seed paths (confirmed by probe + real-session-contract-harness) ────
 *   MODEL   : 'haiku'  (the cheapest Claude tier; a bare alias passed verbatim by
 *             normalizeFreshAgentModel for provider=claude — override with
 *             FRESHELL_T2_CLAUDE_MODEL). NO per-token cost on an OAuth plan.
 *   AUTH src: ~/.claude/.credentials.json                (user, READ-ONLY)
 *   AUTH dst: <isoHOME>/.claude/.credentials.json        (isolated copy)
 *   HOME    : TestServer(runtimeRootMode:'isolated') sets HOME=<isoHOME> and
 *             CLAUDE_HOME=<isoHOME>/.claude, so the CLI the SDK spawns
 *             authenticates from the isolated copy and writes ALL transcripts
 *             under the isolated HOME — NEVER the user's real ~/.claude.
 *   PERMS   : permissionMode='bypassPermissions' so a pure-text turn can never
 *             hang on an interactive tool-permission prompt while unattended.
 *
 * SAFETY: only ever reaps processes carrying THIS run's ownership sentinel
 * (`FRESHELL_PROBE_SENTINEL=<sentinelPath>`, inherited by the server, the spawned
 * `claude` CLI, and any MCP grandchild). Never kills by name; never touches the
 * user's live server (:3001) or their live claude/codex/opencode sessions, and
 * never writes to the user's real ~/.claude.
 */

import { spawnSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { startExternalServer, type ExternalServerHandle } from './external-server.js'
import { WsCaptureClient, type CapturedMessage } from './ws-capture-client.js'
import { collectSentinelOwnedPids, reapSentinelOwned } from './t2-live.js'
import { type T2Observation, type T2SessionMaterializedEvent } from './invariants.js'

// ── constants ───────────────────────────────────────────────────────────────

/** Cheapest Claude tier. Bare alias passed verbatim to the SDK (→ `claude --model haiku`). */
export const CLAUDE_HAIKU_MODEL = process.env.FRESHELL_T2_CLAUDE_MODEL?.trim() || 'haiku'
/** Single tiny pinned-output prompt — bounds cost + makes the reply checkable. */
export const DEFAULT_CLAUDE_T2_PROMPT = 'Reply with exactly this token and nothing else: freshell-t2-ok'
/** The sentinel the reply must CONTAIN (preamble tolerated; never equality). */
export const DEFAULT_CLAUDE_T2_SENTINEL = 'freshell-t2-ok'

const CLAUDE_CRED_SUBPATH = ['.claude', '.credentials.json'] as const
const CLAUDE_PROJECTS_SUBPATH = ['.claude', 'projects'] as const
const CAPTURE_TEXT_CAP = 4000
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

/** Elapsed-time breadcrumbs to stderr; gated so green runs stay quiet. */
function trace(enabled: boolean, startedAt: number, msg: string): void {
  if (!enabled) return
  // eslint-disable-next-line no-console
  console.error(`[t2-claude +${Date.now() - startedAt}ms] ${msg}`)
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

/** Authenticated JSON request against the isolated server (never :3001). */
async function httpJson(
  baseUrl: string,
  token: string,
  method: string,
  routePath: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; json: unknown }> {
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
    let json: unknown
    try { json = text ? JSON.parse(text) : undefined } catch { json = { __raw: text } }
    return { status: res.status, json }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Enable fresh clients on the ISOLATED server so the WS `freshAgent.create` gate
 * (`settings.freshAgent.enabled`, default false) is satisfied — exactly how a real
 * freshclaude user (and the e2e suite) turns the feature on: `PATCH /api/settings`
 * with `{ freshAgent: { enabled: true } }`. Runtime toggle only; never touches
 * source or the user's real settings.
 */
export async function enableFreshClients(baseUrl: string, token: string): Promise<void> {
  const res = await httpJson(baseUrl, token, 'PATCH', '/api/settings', {
    freshAgent: { enabled: true, defaultPlugins: [] },
  }, 15_000)
  const enabled = (res.json as { freshAgent?: { enabled?: unknown } } | undefined)?.freshAgent?.enabled
  if (res.status !== 200 || enabled !== true) {
    throw new Error(`failed to enable fresh clients: status=${res.status} body=${JSON.stringify(res.json)}`)
  }
}

// ── credential path resolution + availability gate ───────────────────────────

export interface ClaudeCredPaths {
  /** User's real Claude OAuth credential (source; READ-ONLY). */
  userCredentials: string
  /** Where the isolated server's CLI reads the credential from, relative to a HOME. */
  relCredentials: string
  /** Where claude persists transcripts, relative to a HOME. */
  relProjects: string
}

export function claudeCredPaths(): ClaudeCredPaths {
  return {
    userCredentials: path.join(os.homedir(), ...CLAUDE_CRED_SUBPATH),
    relCredentials: path.join(...CLAUDE_CRED_SUBPATH),
    relProjects: path.join(...CLAUDE_PROJECTS_SUBPATH),
  }
}

/** Absolute path of the real `claude` binary on PATH, or null if unresolvable. */
export function resolveClaudeBinary(): string | null {
  const r = spawnSync('bash', ['-lc', 'command -v -- claude'], { encoding: 'utf8', timeout: 5000 })
  const resolved = r.status === 0 ? r.stdout.trim().split('\n')[0] : ''
  return resolved ? resolved : null
}

/** The `claude` CLI version string (recorded in the baseline provenance). */
export function claudeVersion(): string {
  const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 15_000 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  return out ? out.split('\n')[0] : 'unknown'
}

/**
 * Gate for the LIVE test: is the claude/Haiku path actually usable in an isolated
 * home on this host? Checks the binary + that the user's `.credentials.json`
 * exists and is parseable JSON. NEVER prints secret material.
 */
export async function claudeHaikuT2Available(): Promise<{ available: boolean; reason: string }> {
  if (process.platform !== 'linux') {
    return { available: false, reason: `ownership-safe reaping is linux-only (platform=${process.platform})` }
  }
  if (resolveClaudeBinary() === null) {
    return { available: false, reason: 'claude binary not on PATH' }
  }
  const { userCredentials } = claudeCredPaths()
  if (!(await pathExists(userCredentials))) {
    return { available: false, reason: `missing Claude credential at ${userCredentials}` }
  }
  try {
    // Parse only to confirm it is well-formed JSON; never inspect/print the contents.
    JSON.parse(await fsp.readFile(userCredentials, 'utf8'))
  } catch (err) {
    return { available: false, reason: `.credentials.json unreadable/unparseable: ${(err as Error).message}` }
  }
  return { available: true, reason: 'claude binary + ~/.claude/.credentials.json present' }
}

/**
 * Seed the user's Claude OAuth credential (READ-ONLY copy) into an isolated HOME
 * so the CLI the SDK spawns can authenticate — while ALL session data (the
 * `<uuid>.jsonl` transcripts) lands under the same isolated HOME, never the user's
 * real ~/.claude. Returns the concrete seeded credential + projects dir paths.
 */
export async function seedClaudeCredsIntoHome(homeDir: string): Promise<{ credTarget: string; projectsDir: string }> {
  const { userCredentials, relCredentials, relProjects } = claudeCredPaths()
  const credTarget = path.join(homeDir, relCredentials)
  await fsp.mkdir(path.dirname(credTarget), { recursive: true })
  await fsp.copyFile(userCredentials, credTarget) // READ user, WRITE temp only
  // Lock the isolated copy down like the original (0600) — defensive hygiene.
  await fsp.chmod(credTarget, 0o600).catch(() => {})

  // PRE-CREATE the claude transcript root (<HOME>/.claude/projects) so it EXISTS
  // at server boot — exactly as it does in every REAL freshclaude user's home.
  // ─────────────────────────────────────────────────────────────────────────
  // WHY (candidate deviation DEV-0002, ledgered — a harness ENV fix, NOT a source
  // patch): seeding only .credentials.json makes ~/.claude exist but ~/.claude/
  // projects ABSENT at boot. freshell's coding-cli session-indexer then can't find
  // an existing claude session-root, so its late-root watcher attaches to the
  // ancestor (~/.claude) at depth 1 and, the instant the first turn creates the
  // `projects` dir, chokidar's _handleRead throws `Cannot read properties of
  // undefined (reading 'on')` — an UNCAUGHT error that kills the whole freshell
  // process mid-turn (proven: crashes with projects absent, survives once it
  // pre-exists; see port/oracle/notes/t2-claude-haiku.md). A real user always has
  // ~/.claude/projects, so this is an isolated-home artifact, not a path real users
  // hit. Pre-creating it makes the isolated env match a real one WITHOUT mutating
  // the reference source. The Rust-port QA must likewise run against a home where
  // ~/.claude/projects already exists (or fix the uncaught watcher error natively).
  const projectsDir = path.join(homeDir, relProjects)
  await fsp.mkdir(projectsDir, { recursive: true })
  return { credTarget, projectsDir }
}

// ── isolated .jsonl transcript reads (never the user's ~/.claude) ─────────────

interface TranscriptFacts {
  transcriptPath: string | null
  /** Canonical Claude session UUID extracted from the transcript (filename / init line). */
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

const EMPTY_TRANSCRIPT_FACTS: TranscriptFacts = {
  transcriptPath: null, sessionUuid: null, present: false, messageCount: 0, partCount: 0,
  hasAssistantMessage: false, parseable: false, assistantText: '', assistantContainsSentinel: false,
}

async function listJsonlTranscripts(projectsDir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full)
    }
  }
  await walk(projectsDir)
  return out
}

/** Newest .jsonl transcript under the isolated projects dir, preferring one whose
 *  name matches `preferUuid` when provided. */
async function pickTranscript(projectsDir: string, preferUuid: string | null): Promise<string | null> {
  const files = await listJsonlTranscripts(projectsDir)
  if (files.length === 0) return null
  if (preferUuid) {
    const match = files.find((f) => path.basename(f) === `${preferUuid}.jsonl`)
    if (match) return match
  }
  // Otherwise the most-recently-modified transcript (this run's turn).
  const withMtime = await Promise.all(files.map(async (f) => ({ f, m: (await fsp.stat(f)).mtimeMs })))
  withMtime.sort((a, b) => b.m - a.m)
  return withMtime[0]?.f ?? null
}

/** Extract the array of text strings from a claude transcript message `content`. */
function collectTextBlocks(content: unknown, into: string[]): number {
  let parts = 0
  if (typeof content === 'string') {
    into.push(content)
    return 1
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      parts += 1
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        const t = (block as { text?: unknown }).text
        if (typeof t === 'string') into.push(t)
      }
    }
  }
  return parts
}

async function readTranscriptFacts(transcriptPath: string, sentinel: string): Promise<TranscriptFacts> {
  const raw = await fsp.readFile(transcriptPath, 'utf8').catch(() => '')
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0)
  const needle = sentinel.toLowerCase()
  let parseable = lines.length > 0
  let messageCount = 0
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
    if (!sessionUuid && typeof obj.session_id === 'string' && UUID_RE.test(obj.session_id)) {
      sessionUuid = obj.session_id
    }
    if (type === 'user' || type === 'assistant') {
      messageCount += 1
      const message = obj.message as { role?: unknown; content?: unknown } | undefined
      const content = message?.content
      if (type === 'assistant') {
        hasAssistant = true
        partCount += collectTextBlocks(content, assistantTextParts)
      }
    }
  }

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
 * Poll the isolated projects dir until a transcript with the assistant reply
 * (containing the sentinel) is persisted. SECONDARY corroboration of the primary
 * turn.complete edge — claude flushes the .jsonl as/after the turn completes.
 */
async function waitForTranscript(
  projectsDir: string,
  preferUuid: string | null,
  sentinel: string,
  budgetMs: number,
): Promise<{ facts: TranscriptFacts; latencyMs: number }> {
  const started = Date.now()
  const deadline = started + budgetMs
  let last: TranscriptFacts = EMPTY_TRANSCRIPT_FACTS
  while (Date.now() < deadline) {
    const transcriptPath = await pickTranscript(projectsDir, preferUuid)
    if (transcriptPath) {
      last = await readTranscriptFacts(transcriptPath, sentinel)
      if (last.assistantContainsSentinel) return { facts: last, latencyMs: Date.now() - started }
    }
    await sleep(400)
  }
  return { facts: last, latencyMs: Date.now() - started }
}

// ── wire-event helpers (freshAgent.event envelopes) ──────────────────────────

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

// ── run orchestration ────────────────────────────────────────────────────────

export interface RunClaudeT2Options {
  model?: string
  prompt?: string
  sentinel?: string
  /** cwd the claude session runs in (default: a fresh temp project dir). */
  cwd?: string
  /** Turn completion budget in ms (Haiku is fast; boot + CLI spawn add slack). Default 150s. */
  turnTimeoutMs?: number
  /** Pipe the spawned server's stdout/stderr. */
  verbose?: boolean
}

export interface T2TeardownFacts {
  serverPidGone: boolean
  strayOwnedPidsAfter: number[]
  ownedCleanupOk: boolean
}

export interface ClaudeT2Run {
  handle: ExternalServerHandle
  /** Isolated project cwd created for this run (removed on teardown). */
  cwd: string
  /** Absolute isolated projects dir observed for transcripts. */
  projectsDir: string
  observation: T2Observation
  teardown(): Promise<T2TeardownFacts>
}

/**
 * Boot the isolated+seeded server, drive one live Claude Haiku turn through the
 * real fresh-agent WS surface while capturing every broadcast, and assemble the
 * T2 observation. Makes EXACTLY ONE live model call (the single `freshAgent.send`).
 */
export async function runClaudeHaikuT2(options: RunClaudeT2Options = {}): Promise<ClaudeT2Run> {
  const model = options.model ?? CLAUDE_HAIKU_MODEL
  const prompt = options.prompt ?? DEFAULT_CLAUDE_T2_PROMPT
  const sentinel = options.sentinel ?? DEFAULT_CLAUDE_T2_SENTINEL
  const turnTimeoutMs = options.turnTimeoutMs ?? 150_000
  const traceOn = options.verbose === true || !!process.env.FRESHELL_T2_TRACE
  const startedAt = Date.now()

  if (resolveClaudeBinary() === null) {
    throw new Error('claude binary not resolvable on PATH (required for the claude T2 harness)')
  }

  const ownsCwd = !options.cwd
  const cwd = options.cwd ?? (await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-t2-claude-project-')))

  const rmOwnedTemps = async () => {
    if (ownsCwd) await fsp.rm(cwd, { recursive: true, force: true }).catch(() => {})
  }

  trace(traceOn, startedAt, `booting isolated server + seeding claude credential…`)
  let projectsDir = ''
  let handle: ExternalServerHandle
  try {
    handle = await startExternalServer({
      provider: 'oracle-t2-claude',
      startTimeoutMs: 90_000,
      verbose: options.verbose ?? false,
      setupHome: async (homeDir) => {
        const { projectsDir: seededProjects } = await seedClaudeCredsIntoHome(homeDir)
        projectsDir = seededProjects
      },
    })
  } catch (err) {
    await rmOwnedTemps()
    throw err
  }
  trace(traceOn, startedAt, `server up: pid=${handle.pid} port=${handle.port}`)
  if (!projectsDir) projectsDir = path.join(handle.homeDir, ...CLAUDE_PROJECTS_SUBPATH)

  const ws = new WsCaptureClient(handle.wsUrl, handle.token)

  // Single reaper used by BOTH the mid-run failure path and the caller's teardown,
  // so a throw anywhere below can never leak the server or its claude CLI grandchild.
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
    provider: 'claude',
    model,
    prompt,
    sentinelToken: sentinel,
    sessionCreated: false,
    initialSessionId: null,
    durableSessionId: null,
    sessionRef: null,
    turnAccepted: false,
    turnCompleted: false,
    serverReportedIdle: false, // N/A for claude — completion is the turn.complete edge
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
    //     freshclaude user / the e2e suite performs (PATCH /api/settings).
    await enableFreshClients(handle.baseUrl, handle.token)
    trace(traceOn, startedAt, 'fresh clients enabled on the isolated server')

    // 1. Create the freshclaude session (auto-subscribes this client). Returns the
    //    SDK bridge's BARE nanoid placeholder in `freshAgent.created.sessionId`.
    const tCreate = Date.now()
    const createRequestId = `oracle-t2-claude-create-${Date.now()}`
    ws.send({
      type: 'freshAgent.create',
      requestId: createRequestId,
      sessionType: 'freshclaude',
      provider: 'claude',
      cwd,
      model,
      permissionMode: 'bypassPermissions',
    })
    const createdOrFailed = await ws.waitForServerMessage(
      (m) => (m.type === 'freshAgent.created' || m.type === 'freshAgent.create.failed')
        && (m.parsed as { requestId?: string })?.requestId === createRequestId,
      30_000,
      'freshAgent.created',
    )
    observation.timings.createMs = Date.now() - tCreate
    if (createdOrFailed.type === 'freshAgent.create.failed') {
      const p = createdOrFailed.parsed as { code?: string; message?: string }
      throw new Error(`freshAgent.create failed: code=${p.code} message=${p.message}`)
    }
    const created = createdOrFailed.parsed as { sessionId?: string }
    const placeholderId = created.sessionId
    if (!placeholderId) throw new Error('freshAgent.created carried no sessionId')
    observation.sessionCreated = true
    observation.initialSessionId = placeholderId
    trace(traceOn, startedAt, `session created: placeholder=${placeholderId}; firing 1 live Haiku turn…`)

    // 2. FIRE the single live turn. EXACTLY ONE live model call.
    const tTurn = Date.now()
    observation.liveModelCalls += 1
    const sendRequestId = `oracle-t2-claude-send-${Date.now()}`
    ws.send({
      type: 'freshAgent.send',
      requestId: sendRequestId,
      sessionId: placeholderId,
      sessionType: 'freshclaude',
      provider: 'claude',
      cwd,
      text: prompt,
    })

    // 2a. Await send acceptance (turn dispatched). Captures submittedTurnId.
    const accepted = await ws.waitForServerMessage(
      (m) => (m.type === 'freshAgent.send.accepted' || m.type === 'error')
        && ((m.parsed as { requestId?: string })?.requestId === sendRequestId),
      30_000,
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
    }

    // 3. AWAIT the PRIMARY completion edge: the discrete freshAgent.turn.complete
    //    (emitted on the SDK result subtype=success). Poll so we can ALSO bail the
    //    moment the isolated server dies (rather than blocking the full budget on a
    //    dead server), and surface loud diagnostics on failure.
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
      // Loud diagnostics: surface any freshAgent.error + the server's own debug log,
      // and flag if the isolated server process exited mid-turn (a crash to report).
      const errEvt = ws.getServerMessages().map(innerEvent).find((e) => e?.type === 'freshAgent.error')
      const logTail = await tailFile(handle.debugLogPath, 40)
      trace(traceOn, startedAt,
        `NO turn.complete after +${observation.timings.turnMs}ms. serverDied=${serverDiedDuringTurn} ` +
        `error=${errEvt ? JSON.stringify(errEvt) : 'none'}\n--- server debug log tail ---\n${logTail}`)
    }

    // 4. Resolve the durable Claude UUID from the wire (session.init cliSessionId)
    //    and/or the persisted transcript filename — the canonical claude identity.
    let cliSessionId: string | null = null
    for (const m of ws.getServerMessages()) {
      const ev = innerEvent(m)
      if (ev && (ev.type === 'freshAgent.session.init' || ev.type === 'freshAgent.session.metadata')) {
        const cid = ev.cliSessionId
        if (typeof cid === 'string' && UUID_RE.test(cid)) { cliSessionId = cid; break }
      }
    }

    // 5. SECONDARY corroboration: wait for the .jsonl transcript (with the sentinel)
    //    to persist into the ISOLATED store, then project it into the db* fields.
    const remaining = Math.max(15_000, turnTimeoutMs - (Date.now() - tTurn))
    const { facts, latencyMs } = await waitForTranscript(projectsDir, cliSessionId, sentinel, remaining)
    observation.assistantReplyLatencyMs = latencyMs
    const durableUuid = cliSessionId ?? facts.sessionUuid
    observation.durableSessionId = durableUuid
    observation.turnAccepted = !!durableUuid
    if (durableUuid) observation.sessionRef = { provider: 'claude', sessionId: durableUuid }
    observation.dbPath = facts.transcriptPath ?? path.join(projectsDir, '<unmaterialized>.jsonl')
    observation.dbSessionRowPresent = facts.present
    observation.dbSessionRow = facts.present
      ? { id: durableUuid ?? '', title: null, directory: cwd }
      : null
    observation.dbMessageCount = facts.messageCount
    observation.dbPartCount = facts.partCount
    observation.dbHasAssistantMessage = facts.hasAssistantMessage
    observation.transcriptParseable = facts.parseable
    observation.turnCompleted = facts.assistantContainsSentinel
    trace(traceOn, startedAt, `durable=${durableUuid ?? 'null'} transcript=${facts.present} reply=${facts.assistantContainsSentinel} (msgs=${facts.messageCount} parts=${facts.partCount}) in ${latencyMs}ms`)

    // 6. Assistant text ("capture"): prefer the persisted transcript; fall back to
    //    the streamed freshAgent.assistant blocks. Never text-equality — presence only.
    let captureText = facts.assistantText
    if (!captureText.trim()) {
      const streamed: string[] = []
      for (const m of ws.getServerMessages()) {
        const ev = innerEvent(m)
        if (ev?.type === 'freshAgent.assistant') collectTextBlocks(ev.content, streamed)
      }
      captureText = streamed.join('\n')
    }
    const captureHasSentinel = captureText.toLowerCase().includes(sentinel.toLowerCase())
    observation.captureLength = captureText.length
    observation.captureText = captureText.slice(0, CAPTURE_TEXT_CAP)
    observation.captureNonEmpty = captureText.trim().length > 0
    observation.turnCompleted = observation.turnCompleted || captureHasSentinel
    observation.captureContainsSentinel = captureHasSentinel || observation.turnCompleted

    // 7. Materialized event (claude usually does NOT emit it on send — the durable
    //    UUID surfaces via session.init + the .jsonl name — so this is recorded when
    //    present but is a NON-FATAL invariant).
    const materialized = ws.getServerMessages().find((m) => m.type === 'freshAgent.session.materialized')
      ?? ws.getServerMessages().find((m) => innerEventType(m) === 'freshAgent.session.materialized')
    if (materialized) {
      const p = (innerEvent(materialized) ?? (materialized.parsed as Record<string, unknown>))
      observation.sessionMaterializedEvent = {
        previousSessionId: String(p.previousSessionId ?? ''),
        sessionId: String(p.sessionId ?? ''),
        sessionType: String(p.sessionType ?? 'freshclaude'),
        provider: String(p.provider ?? 'claude'),
      } satisfies T2SessionMaterializedEvent
    }

    // 8. Distinct wire types seen — BOTH outer envelope types AND the inner
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

  return { handle, cwd, projectsDir, observation, teardown }
}

/** Re-exported so tests can assert ownership without importing t2-live directly. */
export { collectSentinelOwnedPids, reapSentinelOwned }
