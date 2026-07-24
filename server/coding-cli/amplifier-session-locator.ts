/**
 * AmplifierSessionLocator — deterministic PTY↔session association for FRESH
 * amplifier sessions (docs/plans/2026-07-08-amplifier-session-durability-plan.md
 * §5, Phase 3).
 *
 * Amplifier has no launcher-assigned session ID (E9) and session dirs are
 * created LAZILY at the first prompt submit (E1), so the locator correlates
 * PTY Enter-press ↔ new session dir instead of spawn ↔ dir:
 *
 * 1. Arm at spawn: amplifier-mode terminals starting WITHOUT a resumeSessionId
 *    register {terminalId, cwd, spawnedAt} plus a pre-spawn snapshot of the
 *    existing top-level session dirs (no '_' in name) under
 *    <amplifierHome>/projects/<slug>/sessions/.
 * 2. One shared chokidar watcher on projects/ — pre-created with mkdir -p when
 *    absent (amplifier mkdir -p's it itself, so this is harmless) and NEVER an
 *    ancestor: walking up (worst case to $HOME) with a deep recursive watch
 *    exhausts inotify watches. Runs ONLY while ≥1 armed terminal exists.
 *    Session-indexer hygiene: ignoreInitial, unref'd timers,
 *    close().catch(() => {}). A persistent watcher error disables the locator
 *    (single warn); the coordinator slow-path remains.
 * 3. On PTY submit (isSubmitInput) at time t, open the correlation window
 *    [t - AMPLIFIER_DIR_PRE_EPSILON_MS, t + AMPLIFIER_DIR_APPEAR_WINDOW_MS].
 *    The pre-epsilon is a clock-jitter/event-reorder allowance ONLY (a dir can
 *    be observed marginally before the submit event is delivered) — it must
 *    stay small so dirs created BEFORE the Enter press (foreign sessions) are
 *    never candidates. A candidate is a new top-level dir (not in the
 *    snapshot, no '_'), whose events.jsonl opens with session:start WITHOUT
 *    parent_id (the coordinator's isSubagent guard).
 * 4. Confirm cwd via the session:config record's working_dir/project_dir
 *    (realpath-normalized). Never wait for metadata.json; never guess slugs.
 * 5. Resolve at window close: exactly one cwd-confirmed candidate → emit
 *    'session.located' (handled by AmplifierSessionController, which binds
 *    through registry.bindSession). Multiple → refuse and log
 *    'amplifier_locator_ambiguous' (coordinator slow-path stays eligible).
 *    Zero → keep watching (empty-Enter writes nothing, E5).
 *
 * Dirs may be observed slightly before the submit event and events.jsonl may
 * lag the dir (E1/E4): candidacy is time-window based on the observed
 * appearance and probes poll briefly until the lifecycle records land.
 *
 * The locator never binds or broadcasts itself, and it does NOT bypass the
 * coordinator slow-path — that fallback stays untouched.
 */

import { EventEmitter } from 'events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import chokidar from 'chokidar'
import { isSubmitInput } from '../../shared/turn-complete-signal.js'
import { logger } from '../logger.js'
import {
  createAmplifierReducerState,
  reduceAmplifierEvent,
} from './amplifier-events-reducer.js'
import {
  createAmplifierEventsTailer,
  type AmplifierTailerFs,
} from './amplifier-events-tailer.js'
import type {
  TerminalInputRawEvent,
  TerminalSessionBoundEvent,
} from '../terminal-stream/registry-events.js'

/** Plan Appendix A: observed dir-appearance latency is ~37ms (E1); 50× margin. */
export const AMPLIFIER_DIR_APPEAR_WINDOW_MS = 2_000

/**
 * How far BEFORE the Enter press an observed dir may still correlate. Strictly
 * a clock-jitter / event-reordering allowance (chokidar may report the dir a
 * beat before the registry delivers the submit event) — plan §5 defines the
 * window as [t, t+2000], so anything meaningfully older than the Enter is a
 * foreign session and must never be a candidate (adversarial finding F).
 */
export const AMPLIFIER_DIR_PRE_EPSILON_MS = 250

/** Bounded probe read: session:start + session:config land in the first bytes (E4). */
const PROBE_MAX_READ_BYTES = 64 * 1024
const DEFAULT_PROBE_POLL_MS = 100
/** Discoveries older than this can no longer match any window; safe to prune. */
const DISCOVERY_RETENTION_WINDOWS = 5

export type AmplifierSessionLocatedEvent = {
  terminalId: string
  sessionId: string
  eventsPath: string
  sessionDir: string
}

type LocatorLogger = {
  warn: (payload: object, message?: string) => void
  info?: (payload: object, message?: string) => void
  debug?: (payload: object, message?: string) => void
}

type LocatorTerminalSnapshot = {
  terminalId: string
  mode: string
  status: string
  cwd?: string
  resumeSessionId?: string
  pendingResumeName?: string
}

type LocatorRegistry = {
  on: (event: string, handler: (...args: any[]) => void) => void
  off: (event: string, handler: (...args: any[]) => void) => void
  /** Present on the real TerminalRegistry; used for the construction-order catch-up sweep. */
  list?: () => Array<{ terminalId: string }>
  get?: (terminalId: string) => LocatorTerminalSnapshot | undefined | null
}

export type AmplifierLocatorWatcher = {
  on(event: string, handler: (...args: any[]) => void): unknown
  close(): Promise<void>
}

export type AmplifierLocatorWatchFactory = (
  watchPath: string,
  options: { ignoreInitial: boolean; depth: number },
) => AmplifierLocatorWatcher

type ArmedTerminal = {
  terminalId: string
  cwd: string
  cwdNormalized: string
  spawnedAt: number
  /** Session dirs that existed at arm time — never candidates for this terminal. */
  snapshot: Set<string>
  /** Resolves once the realpath'd cwd and the pre-spawn snapshot are captured. */
  ready: Promise<void>
  window?: CorrelationWindow
}

type CorrelationWindow = {
  openedAt: number
  timer: NodeJS.Timeout
  closed: boolean
  resolved: boolean
  // Finding J: one-shot readdir fallback already performed for this window.
  rescanned: boolean
}

type DiscoveryState = 'pending' | 'confirmed' | 'rejected'

type Discovery = {
  dir: string
  name: string
  appearedAt: number
  state: DiscoveryState
  claimed: boolean
  sessionId?: string
  cwdNormalized?: string
  rejectReason?: string
  deadlineAt: number
  probing: boolean
  retryTimer?: NodeJS.Timeout
}

function normalizeLexicalCwd(input: string): string {
  const normalized = input.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

async function normalizeRealCwd(input: string): Promise<string> {
  let resolved = input
  try {
    resolved = await fsp.realpath(input)
  } catch {
    // Missing/virtual paths still participate via lexical normalization,
    // matching the registry's normalizeSessionCwd behavior.
  }
  return normalizeLexicalCwd(resolved)
}

/** Bounded stat so probe reads never chase a fast-growing events.jsonl tail. */
function cappedProbeFs(maxBytes: number): AmplifierTailerFs {
  return {
    open: (filePath, flags) => fsp.open(filePath, flags),
    stat: async (filePath) => {
      const stat = await fsp.stat(filePath)
      return { size: Math.min(stat.size, maxBytes) }
    },
  }
}

export class AmplifierSessionLocator extends EventEmitter {
  private readonly registry: LocatorRegistry
  private readonly projectsDir: string
  private readonly log: LocatorLogger
  private readonly now: () => number
  private readonly windowMs: number
  private readonly probeTimeoutMs: number
  private readonly probePollMs: number
  private readonly watchImpl: AmplifierLocatorWatchFactory

  private readonly armed = new Map<string, ArmedTerminal>()
  private readonly discoveries = new Map<string, Discovery>()
  private watcher?: AmplifierLocatorWatcher
  private watcherReady: Promise<void> = Promise.resolve()
  private resolveChain: Promise<void> = Promise.resolve()
  private disposed = false
  // Sticky after a watcher error (finding A): the locator self-disables rather
  // than log per-event or churn broken watchers.
  private watcherFailed = false

  private readonly handleCreated = (record: LocatorTerminalSnapshot) => {
    this.arm(record)
  }

  private readonly handleInput = (event: TerminalInputRawEvent) => {
    this.noteInput(event)
  }

  private readonly handleBound = (event: TerminalSessionBoundEvent) => {
    if (!event?.terminalId) return
    this.disarm(event.terminalId)
  }

  private readonly handleExit = (event: { terminalId?: string }) => {
    if (!event?.terminalId) return
    this.disarm(event.terminalId)
  }

  constructor(input: {
    registry: LocatorRegistry
    amplifierHome: string
    log?: LocatorLogger
    now?: () => number
    windowMs?: number
    probeTimeoutMs?: number
    probePollMs?: number
    watchImpl?: AmplifierLocatorWatchFactory
  }) {
    super()
    this.registry = input.registry
    this.projectsDir = path.resolve(path.join(input.amplifierHome, 'projects'))
    this.log = input.log ?? logger.child({ component: 'amplifier-session-locator' })
    this.now = input.now ?? (() => Date.now())
    this.windowMs = input.windowMs ?? AMPLIFIER_DIR_APPEAR_WINDOW_MS
    this.probeTimeoutMs = input.probeTimeoutMs ?? this.windowMs * 2
    this.probePollMs = input.probePollMs ?? DEFAULT_PROBE_POLL_MS
    this.watchImpl = input.watchImpl
      ?? ((watchPath, options) => chokidar.watch(watchPath, options))

    this.registry.on('terminal.created', this.handleCreated)
    this.registry.on('terminal.input.raw', this.handleInput)
    this.registry.on('terminal.session.bound', this.handleBound)
    this.registry.on('terminal.exit', this.handleExit)

    // Construction-order catch-up sweep (finding H, mirroring the activity
    // integration): amplifier terminals created BEFORE the locator existed
    // would otherwise never arm. `arm()` re-applies the mode/status/resume
    // guards, so this is a plain replay of 'terminal.created'.
    if (typeof this.registry.list === 'function' && typeof this.registry.get === 'function') {
      for (const listed of this.registry.list()) {
        const record = this.registry.get(listed.terminalId)
        if (record) this.arm(record)
      }
    }
  }

  armedCount(): number {
    return this.armed.size
  }

  isWatching(): boolean {
    return this.watcher !== undefined
  }

  /** Test/diagnostic hook: resolves once the watcher and all snapshots are ready. */
  async whenReady(): Promise<void> {
    await this.watcherReady
    await Promise.all(Array.from(this.armed.values(), (armed) => armed.ready))
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.registry.off('terminal.created', this.handleCreated)
    this.registry.off('terminal.input.raw', this.handleInput)
    this.registry.off('terminal.session.bound', this.handleBound)
    this.registry.off('terminal.exit', this.handleExit)
    for (const armed of this.armed.values()) {
      if (armed.window) clearTimeout(armed.window.timer)
    }
    this.armed.clear()
    this.clearDiscoveries()
    const watcher = this.watcher
    this.watcher = undefined
    await watcher?.close().catch(() => {})
  }

  // --- Arming -------------------------------------------------------------

  private arm(record: LocatorTerminalSnapshot): void {
    if (this.disposed) return
    if (!record || record.mode !== 'amplifier' || record.status !== 'running') return
    // Resume terminals (bound at create, or awaiting a named-resume association)
    // never arm — the locator only serves fresh sessions (plan §5 step 1).
    if (record.resumeSessionId || record.pendingResumeName) return
    if (!record.cwd) return
    if (this.armed.has(record.terminalId)) return

    const armed: ArmedTerminal = {
      terminalId: record.terminalId,
      cwd: record.cwd,
      cwdNormalized: normalizeLexicalCwd(record.cwd),
      spawnedAt: this.now(),
      snapshot: new Set<string>(),
      ready: Promise.resolve(),
    }
    armed.ready = (async () => {
      armed.cwdNormalized = await normalizeRealCwd(record.cwd!)
      armed.snapshot = await this.snapshotSessionDirs()
    })().catch(() => {})
    this.armed.set(record.terminalId, armed)
    this.ensureWatcher()
  }

  private disarm(terminalId: string): void {
    const armed = this.armed.get(terminalId)
    if (!armed) return
    if (armed.window) clearTimeout(armed.window.timer)
    this.armed.delete(terminalId)
    if (this.armed.size === 0) {
      this.stopWatcher()
    }
  }

  /**
   * Pre-spawn snapshot (plan §5 step 1): every existing top-level session dir
   * (projects/<slug>/sessions/<id>, no '_' in the id) — never candidates for
   * the terminal being armed. No slug guessing: the whole projects/ tree is
   * enumerated at the sessions level.
   */
  private async snapshotSessionDirs(): Promise<Set<string>> {
    const snapshot = new Set<string>()
    let slugs
    try {
      slugs = await fsp.readdir(this.projectsDir, { withFileTypes: true })
    } catch {
      return snapshot
    }
    for (const slug of slugs) {
      if (!slug.isDirectory()) continue
      const sessionsDir = path.join(this.projectsDir, slug.name, 'sessions')
      let ids
      try {
        ids = await fsp.readdir(sessionsDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const id of ids) {
        if (!id.isDirectory()) continue
        if (id.name.includes('_')) continue
        snapshot.add(path.resolve(path.join(sessionsDir, id.name)))
      }
    }
    return snapshot
  }

  // --- Watcher ------------------------------------------------------------

  private ensureWatcher(): void {
    if (this.watcher || this.disposed || this.watcherFailed) return
    // projects/ is created lazily (E1). Pre-create it (amplifier mkdir -p's it
    // itself, so this is harmless) and ALWAYS watch projectsDir at a fixed
    // depth — never an ancestor. An ancestor walk can escape amplifierHome
    // (worst case $HOME) and a deep recursive watch over that tree exhausts
    // inotify watches (adversarial finding A).
    try {
      fs.mkdirSync(this.projectsDir, { recursive: true })
    } catch (error) {
      // Still watch projectsDir only: chokidar tolerates a missing path and
      // picks it up if amplifier creates it later. Never watch outside
      // amplifierHome.
      this.log.warn({
        component: 'amplifier-session-locator',
        event: 'amplifier_locator_projects_mkdir_failed',
        projectsDir: this.projectsDir,
        error: error instanceof Error ? error.message : String(error),
      }, 'Could not pre-create the amplifier projects dir for watching')
    }
    // projects(root)/<slug>(+1)/sessions(+2)/<id>(+3) and the files inside the
    // session dir at (+4) — chokidar depth counts sublevels.
    const depth = 4
    const watcher = this.watchImpl(this.projectsDir, { ignoreInitial: true, depth })
    this.watcher = watcher
    this.watcherReady = new Promise<void>((resolve) => {
      watcher.on('ready', () => resolve())
    })
    watcher.on('addDir', (dirPath: unknown) => {
      if (typeof dirPath !== 'string') return
      this.noteDirAppeared(dirPath)
    })
    const onFileEvent = (filePath: unknown) => {
      if (typeof filePath !== 'string') return
      if (path.basename(filePath) !== 'events.jsonl') return
      const discovery = this.discoveries.get(path.resolve(path.dirname(filePath)))
      if (!discovery) return
      if (discovery.state === 'rejected' && discovery.rejectReason === 'probe_timeout') {
        // probe_timeout is NOT definitive (finding I): the session's config
        // record may simply be slow. New bytes in events.jsonl warrant a
        // re-probe. Definitive classifications (subagent / schema /
        // unexpected shape) stay rejected.
        discovery.state = 'pending'
        discovery.rejectReason = undefined
        discovery.deadlineAt = this.now() + this.probeTimeoutMs
        this.probe(discovery)
        return
      }
      if (discovery.state !== 'pending') return
      this.probe(discovery)
    }
    watcher.on('add', onFileEvent)
    watcher.on('change', onFileEvent)
    watcher.on('error', (error: unknown) => {
      this.handleWatcherError(error)
    })
  }

  /**
   * Persistent watcher errors self-disable the locator (finding A): a single
   * warn, watcher closed, no re-arm. Fresh-session binding falls back to the
   * coordinator slow-path, which stays untouched.
   */
  private handleWatcherError(error: unknown): void {
    if (this.watcherFailed || this.disposed) return
    this.watcherFailed = true
    this.log.warn({
      component: 'amplifier-session-locator',
      event: 'amplifier_locator_watch_error',
      error: error instanceof Error ? error.message : String(error),
    }, 'Amplifier session locator watcher error; disabling the locator (coordinator slow-path remains)')
    this.stopWatcher()
  }

  private stopWatcher(): void {
    const watcher = this.watcher
    this.watcher = undefined
    this.watcherReady = Promise.resolve()
    this.clearDiscoveries()
    void watcher?.close().catch(() => {})
  }

  private clearDiscoveries(): void {
    for (const discovery of this.discoveries.values()) {
      if (discovery.retryTimer) clearTimeout(discovery.retryTimer)
    }
    this.discoveries.clear()
  }

  private isSessionDirPath(dirPath: string): boolean {
    const relative = path.relative(this.projectsDir, dirPath)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false
    const parts = relative.split(path.sep).filter(Boolean)
    return parts.length === 3 && parts[1] === 'sessions'
  }

  private noteDirAppeared(rawPath: string, appearedAtOverride?: number): void {
    if (this.disposed) return
    const dir = path.resolve(rawPath)
    if (!this.isSessionDirPath(dir)) return
    const name = path.basename(dir)
    // Underscore-named dirs are sub-session dirs (plan §2): never candidates.
    if (name.includes('_')) return
    if (this.discoveries.has(dir)) return

    const appearedAt = appearedAtOverride ?? this.now()
    this.pruneDiscoveries(appearedAt)
    const discovery: Discovery = {
      dir,
      name,
      appearedAt,
      state: 'pending',
      claimed: false,
      deadlineAt: appearedAt + this.probeTimeoutMs,
      probing: false,
    }
    this.discoveries.set(dir, discovery)
    this.probe(discovery)
  }

  private pruneDiscoveries(now: number): void {
    const cutoff = now - this.windowMs * DISCOVERY_RETENTION_WINDOWS
    for (const [key, discovery] of this.discoveries) {
      if (discovery.appearedAt >= cutoff) continue
      if (discovery.retryTimer) clearTimeout(discovery.retryTimer)
      this.discoveries.delete(key)
    }
  }

  // --- Candidate probing ----------------------------------------------------

  private probe(discovery: Discovery): void {
    if (this.disposed || discovery.state !== 'pending' || discovery.probing) return
    if (discovery.retryTimer) {
      clearTimeout(discovery.retryTimer)
      discovery.retryTimer = undefined
    }
    discovery.probing = true
    void this.runProbe(discovery)
      .catch(() => {
        this.scheduleProbeRetry(discovery)
      })
      .finally(() => {
        discovery.probing = false
      })
  }

  /**
   * Reads the first records of <dir>/events.jsonl (bounded, via the shared
   * tailer + reducer — no duplicated JSONL parsing) and classifies the dir:
   * confirmed {sessionId, cwd}, rejected (subagent / schema / unexpected
   * shape), or still pending (file/records not there yet — E1/E4 lag).
   */
  private async runProbe(discovery: Discovery): Promise<void> {
    const eventsPath = path.join(discovery.dir, 'events.jsonl')
    try {
      await fsp.stat(eventsPath)
    } catch {
      // events.jsonl appears ~37ms after the dir (E1) — retry until deadline.
      this.scheduleProbeRetry(discovery)
      return
    }

    const tailer = createAmplifierEventsTailer({
      filePath: eventsPath,
      attachAt: 'start',
      fsImpl: cappedProbeFs(PROBE_MAX_READ_BYTES),
    })
    const result = await tailer.read()
    if (discovery.state !== 'pending') return
    if (!result.ok) {
      if (result.reason === 'read_error') {
        this.scheduleProbeRetry(discovery)
        return
      }
      this.rejectDiscovery(discovery, result.reason)
      return
    }
    if (result.records.length === 0) {
      this.scheduleProbeRetry(discovery)
      return
    }
    // A fresh session's log opens with session:start (plan §5 step 3);
    // anything else is not a fresh top-level session.
    if (result.records[0]?.event !== 'session:start') {
      this.rejectDiscovery(discovery, 'unexpected_first_record')
      return
    }

    let state = createAmplifierReducerState()
    let identified: { sessionId?: string; cwd: string } | undefined
    for (const record of result.records) {
      const reduced = reduceAmplifierEvent(state, record)
      state = reduced.state
      if (state.subagent) {
        // session:start with parent_id / session:fork — the coordinator's
        // isSubagent guard, applied at the source (plan §5 step 3).
        this.rejectDiscovery(discovery, 'subagent')
        return
      }
      for (const effect of reduced.effects) {
        if (effect.kind === 'lane.degrade') {
          this.rejectDiscovery(discovery, effect.reason)
          return
        }
        if (effect.kind === 'session.identified' && !identified) {
          identified = { sessionId: effect.sessionId, cwd: effect.cwd }
        }
      }
    }

    if (!identified) {
      // session:config lags session:start by ~10ms (E4) — keep polling.
      this.scheduleProbeRetry(discovery)
      return
    }

    discovery.state = 'confirmed'
    discovery.sessionId = identified.sessionId ?? state.sessionId ?? discovery.name
    discovery.cwdNormalized = await normalizeRealCwd(identified.cwd)
    this.scheduleResolve()
  }

  private scheduleProbeRetry(discovery: Discovery): void {
    if (this.disposed || discovery.state !== 'pending') return
    if (this.now() >= discovery.deadlineAt) {
      this.rejectDiscovery(discovery, 'probe_timeout')
      return
    }
    if (discovery.retryTimer) return
    const timer = setTimeout(() => {
      discovery.retryTimer = undefined
      this.probe(discovery)
    }, this.probePollMs)
    timer.unref?.()
    discovery.retryTimer = timer
  }

  private rejectDiscovery(discovery: Discovery, reason: string): void {
    if (discovery.state !== 'pending') return
    discovery.state = 'rejected'
    discovery.rejectReason = reason
    if (discovery.retryTimer) {
      clearTimeout(discovery.retryTimer)
      discovery.retryTimer = undefined
    }
    this.log.debug?.({
      component: 'amplifier-session-locator',
      dir: discovery.dir,
      reason,
    }, 'Amplifier session dir excluded from Enter-correlation')
    // Windows deferred on this probe can now settle.
    this.scheduleResolve()
  }

  // --- Correlation windows --------------------------------------------------

  private noteInput(event: TerminalInputRawEvent): void {
    if (this.disposed) return
    const armed = this.armed.get(event.terminalId)
    if (!armed) return
    if (!isSubmitInput(event.data)) return
    // One window at a time: mid-turn Enters never re-arm anything (E5). A new
    // window may open after the previous one resolved without a binding.
    if (armed.window && !armed.window.resolved) return

    const openedAt = event.at ?? this.now()
    const window: CorrelationWindow = {
      openedAt,
      closed: false,
      resolved: false,
      rescanned: false,
      timer: setTimeout(() => {
        window.closed = true
        this.scheduleResolve()
      }, this.windowMs),
    }
    window.timer.unref?.()
    armed.window = window
  }

  private scheduleResolve(): void {
    this.resolveChain = this.resolveChain
      .then(() => this.resolveAllWindows())
      .catch(() => {})
  }

  private async resolveAllWindows(): Promise<void> {
    for (const armed of Array.from(this.armed.values())) {
      await this.tryResolveWindow(armed)
    }
  }

  private async tryResolveWindow(armed: ArmedTerminal): Promise<void> {
    const window = armed.window
    if (!window || !window.closed || window.resolved || this.disposed) return
    await armed.ready

    // Pre-epsilon (finding F): a dir may be OBSERVED marginally before the
    // submit event is delivered (clock jitter / event reordering), but a dir
    // that meaningfully predates the Enter is a foreign session — never bind it.
    const lowerBound = window.openedAt - AMPLIFIER_DIR_PRE_EPSILON_MS
    const upperBound = window.openedAt + this.windowMs
    const eligible = Array.from(this.discoveries.values()).filter((discovery) => (
      !discovery.claimed
      && discovery.state !== 'rejected'
      && !armed.snapshot.has(discovery.dir)
      && discovery.appearedAt >= lowerBound
      && discovery.appearedAt <= upperBound
    ))

    // Metadata can arrive late (E4): defer until every eligible probe settles.
    // Probes self-terminate at their deadline, so this deferral is bounded.
    if (eligible.some((discovery) => discovery.state === 'pending')) return

    const matches = eligible.filter((discovery) => (
      discovery.state === 'confirmed'
      && discovery.cwdNormalized === armed.cwdNormalized
    ))

    if (matches.length === 0 && !window.rescanned) {
      // Blind spot (finding J): a dir created DURING chokidar's initial scan is
      // swallowed by ignoreInitial and never announced. Before deciding "zero
      // candidates", take a one-shot readdir snapshot of projects/*/sessions/*
      // and feed unseen dirs through the normal discovery path; their probes
      // re-schedule this resolution.
      window.rescanned = true
      const dirs = await this.snapshotSessionDirs()
      let fedAny = false
      for (const dir of dirs) {
        if (this.discoveries.has(dir)) continue
        if (armed.snapshot.has(dir)) continue
        // N1 (re-verification): anchoring at window.openedAt would auto-satisfy
        // the finding-F eligibility bounds and bind alien pre-Enter dirs. Use
        // the dir's fs birth/mtime as appearedAt instead, and reject dirs that
        // provably predate the Enter (pre-epsilon). Stat failure ⇒ refuse to
        // guess: skip the dir (the coordinator slow-path remains).
        let bornAt: number
        try {
          const stat = await fsp.stat(dir)
          const birthMs = stat.birthtimeMs
          bornAt = Number.isFinite(birthMs) && birthMs > 0 ? birthMs : stat.mtimeMs
        } catch {
          continue
        }
        if (bornAt < window.openedAt - AMPLIFIER_DIR_PRE_EPSILON_MS) continue
        this.noteDirAppeared(dir, bornAt)
        fedAny = true
      }
      if (fedAny) return
    }

    window.resolved = true
    clearTimeout(window.timer)
    armed.window = undefined

    if (matches.length === 0) {
      // Empty-Enter writes nothing (E5) — keep watching.
      return
    }
    if (matches.length > 1) {
      // Never guess: refuse and leave it to the coordinator slow-path.
      this.log.warn({
        component: 'amplifier-session-locator',
        event: 'amplifier_locator_ambiguous',
        terminalId: armed.terminalId,
        cwd: armed.cwd,
        candidates: matches.map((match) => match.name),
      }, 'Multiple cwd-confirmed amplifier session dirs within the correlation window; refusing to bind')
      return
    }

    const match = matches[0]
    match.claimed = true
    this.emit('session.located', {
      terminalId: armed.terminalId,
      sessionId: match.sessionId ?? match.name,
      eventsPath: path.join(match.dir, 'events.jsonl'),
      sessionDir: match.dir,
    } satisfies AmplifierSessionLocatedEvent)
  }
}
