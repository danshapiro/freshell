import { EventEmitter } from 'node:events'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type {
  FreshAgentCreateRequest,
  FreshAgentRuntimeAdapter,
  FreshAgentSendResult,
  FreshAgentThreadLocator,
} from '../../runtime-adapter.js'
import { FreshAgentLostSessionError } from '../../runtime-manager.js'
import { nextMonotonicTurnCompleteAt } from '../../turn-complete-clock.js'
import { normalizeFreshAgentEffort, normalizeFreshAgentModel } from '../../../../shared/fresh-agent-models.js'
import type { FreshAgentSessionCommand } from '../../../../shared/fresh-agent-contract.js'
import {
  matchOpencodeSlashCommand,
  normalizeOpencodeCommandCatalog,
  type OpencodeSlashCommandMatch,
} from './commands-catalog.js'
import { logger } from '../../../logger.js'
import { defaultOpencodeDataHome } from '../../../coding-cli/providers/opencode.js'
import {
  hashForLogs,
  recordFreshAgentObservabilityEvent,
} from '../../observability.js'
import {
  type FreshAgentRecoveryStore,
  getFreshAgentRecoveryStore,
} from '../../recovery-store.js'
import { detectInterruptedTurn } from './interrupted-turn.js'
import {
  type OpencodeExport,
  normalizeOpencodeSnapshot,
  normalizeOpencodeTurnBody,
  normalizeOpencodeTurnPage,
} from './normalize.js'
import { DEFAULT_SNAPSHOT_TURN_LIMIT } from './history-query.js'
import {
  createWorkerHistoryReader,
  type OpencodeHistoryReader,
} from './history-runner.js'
import { OpencodeServeLostError, type OpencodeServeManager, type OpencodeServeMessage } from './serve-manager.js'
import { serveEventToSdk, splitOpencodeModel } from './serve-events.js'

const OPENCODE_REAL_SESSION_ID = /^ses_/
const OPENCODE_PLACEHOLDER_SESSION_ID = /^freshopencode-/
const DEFAULT_TURN_TIMEOUT_MS = 600_000

/** Transcript-settle freshness proof (kata zrrj): after onceIdle resolves, the final
 * assistant message must be provably queryable on the REST read path before the adapter
 * declares the turn complete — `session.idle` carries no ordering guarantee relative to
 * message persistence, so the client's post-idle snapshot could otherwise miss the answer. */
const TRANSCRIPT_SETTLE_POLL_MS = 150
const TRANSCRIPT_SETTLE_MAX_POLLS = 10 // ~1.5 s worst case
const TRANSCRIPT_SETTLE_PAGE_LIMIT = 20
const CLOCK_SKEW_MS = 5_000
/** Lazy catalog re-capture gate: after a failed create/resume/attach-time capture, the
 * send path re-attempts at most ONCE per session, and only once this much wall time has
 * passed since the failure (a persistently failing sidecar must not be pounded per send). */
const COMMANDS_CAPTURE_RETRY_BACKOFF_MS = 60_000

const defaultSettleSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Freshell-OWNED continuation instruction for a recovered interrupted turn. Never echoes
 * user text; safe to hardcode. It appears in the transcript as a user-role message — that
 * IS the visible transcript marker for the recovery. */
const FRESHELL_CONTINUATION_PROMPT =
  'Freshell detected that your previous response was interrupted (for example by a restart). Please continue exactly where you left off. If the work was already complete, briefly confirm the final result.'

/** Module-scope monotonic counter for OpencodeSessionState identity. Holds no
 * per-instance state; every newly constructed state gets the next value. */
let stateGenerationCounter = 0

function nextStateGeneration(): number {
  return ++stateGenerationCounter
}

type OpencodeSessionState = {
  placeholderId: string
  /** Monotonic identity of this state object (and its EventEmitter). Consumers
   * (ws-handler) compare generations to detect state recreation and rebind
   * their subscriptions to the new emitter. */
  stateGeneration: number
  realSessionId?: string
  cwd?: string
  routeValidatedCwd?: string
  providerCreatedInThisAdapter?: boolean
  model?: string
  effort?: string
  status: string
  events: EventEmitter
  sendQueue: Promise<unknown>
  unsubscribeServe?: () => void
  /** Last emitted turn-complete `at`, kept per session so the edge stays strictly monotonic. */
  lastTurnCompleteAt?: number
  /** Set by interrupt() so the in-flight send suppresses its chime when idle resolves. */
  turnAborted?: boolean
  /**
   * Set when the serve stream relays a `session.error` during the in-flight turn, so the
   * success path suppresses its chime. onceIdle resolves on the idle that follows an
   * errored turn without inspecting the error, so a positive completion must independently
   * confirm the turn did not error — the OpenCode analogue of Claude's `subtype === 'success'`
   * and Codex's `status === 'completed'`.
   */
  turnErrored?: boolean
  /**
   * True once reconcileStatus's getSessionStatus read has resolved to a trustworthy
   * answer (busy/retry, or confirmed idle via absence / a non-busy status). Left unset
   * on the error-swallow and malformed/missing-helper fallbacks, so a failed read never
   * licenses the client's snapshot busy-clear gate (kata zrrj, Task 4's server half).
   */
  initialReconcileCompleted?: boolean
  /**
   * The in-flight interrupted-turn recovery pass kicked off by resume/attach (kata zrrj).
   * Fire-and-forget for callers (restore must never fail because recovery failed); kept
   * on the state for test determinism. Never rejects — failures are logged internally.
   */
  pendingRecovery?: Promise<void>
  /** Sidecar /command catalog for the session's directory, captured per established
   * adapter state (create/resume/attach) plus at most one lazy send-path retry after a
   * failed capture. Absent while the fetch is in flight or when it failed — the send
   * path then never matches and slash text stays verbatim. */
  commands?: FreshAgentSessionCommand[]
  /** The in-flight catalog capture (fire-and-forget for callers; kept on the state so the
   * send path can await it before classifying leading-slash text — a send fired the
   * instant after create must not miss its match and leak verbatim to the model). */
  pendingCommands?: Promise<void>
  /** Wall-clock of the last failed (or malformed) catalog capture; undefined on success.
   * Gates the lazy send-path retry (see COMMANDS_CAPTURE_RETRY_BACKOFF_MS). */
  commandsCaptureFailedAt?: number
  /** True once the session's single lazy send-path re-capture has been fired. */
  commandsCaptureRetried?: boolean
}

/** Content-free per-session summary served by the read-only incident endpoint
 * (kata zrrj). Identity is reported ONLY as hashForLogs() hashes — never raw
 * session ids, cwds, prompts, or OpenCode payloads. */
export type OpencodeInspectedSession = {
  sessionIdHash: string
  status: string
  hasRealSession: boolean
  cwdHash?: string
  monitorArmed: boolean
  turnAborted?: boolean
  turnErrored?: boolean
  lastTurnCompleteAt?: number
}

/** The sessions map and the idle-recovery monitor registry live in the factory
 * closure, so incident inspection must be an adapter-INSTANCE method — hence the
 * intersection type instead of a module-level export. */
export type OpencodeFreshAgentAdapter = FreshAgentRuntimeAdapter & {
  inspectSessions(): OpencodeInspectedSession[]
}

type CreateOpencodeFreshAgentAdapterOptions = {
  serveManager: OpencodeServeManager
  /** Retained ONLY for legacy `freshopencode-*` placeholder resume. */
  historyReader?: OpencodeHistoryReader
  dbPath?: string
  dataHome?: string
  turnTimeoutMs?: number
  validateCwd?: (cwd: string) => Promise<void>
  canonicalizePath?: (cwd: string) => Promise<string>
  /** Durable interrupt-intent + recovery ledger (kata zrrj). Tests inject a store on a
   * temp file; production defaults to the process-wide singleton. */
  recoveryStore?: FreshAgentRecoveryStore
  /** Sleep between transcript-settle polls (kata zrrj). Tests inject a no-op so the
   * poll budget drains in microtasks; production defaults to a real setTimeout sleep. */
  settleSleep?: (ms: number) => Promise<void>
}

/** True when the page contains an assistant message created at/after `sentAtMs`
 * (minus clock skew) whose `time.completed` is finite — i.e. the final answer is
 * visible AND complete on the REST read path. */
function hasSettledAssistantMessage(messages: OpencodeServeMessage[], sentAtMs: number): boolean {
  return messages.some((message) => {
    const info = message?.info
    if (!info || typeof info !== 'object') return false
    if (info.role !== 'assistant') return false
    const time = info.time
    if (!time || typeof time !== 'object') return false
    if (!Number.isFinite(time.completed)) return false
    return typeof time.created === 'number' && time.created >= sentAtMs - CLOCK_SKEW_MS
  })
}

function makePlaceholderId(requestId: string): string {
  return `freshopencode-${requestId}`
}
function isRealOpencodeSessionId(id: string): boolean { return OPENCODE_REAL_SESSION_ID.test(id) }
function isPlaceholderOpencodeSessionId(id: string): boolean { return OPENCODE_PLACEHOLDER_SESSION_ID.test(id) }

function normalizeOpencodeInput(input: FreshAgentCreateRequest): FreshAgentCreateRequest {
  const model = normalizeFreshAgentModel(input.sessionType, 'opencode', input.model)
  return { ...input, model, effort: normalizeFreshAgentEffort(input.sessionType, 'opencode', model, input.effort) }
}

async function defaultValidateCwd(cwd: string): Promise<void> {
  const info = await stat(cwd).catch(() => {
    throw new Error(`OpenCode cwd is not accessible: ${cwd}`)
  })
  if (!info.isDirectory()) throw new Error(`OpenCode cwd is not a directory: ${cwd}`)
}

export function createOpencodeFreshAgentAdapter(options: CreateOpencodeFreshAgentAdapterOptions): OpencodeFreshAgentAdapter {
  const serveManager = options.serveManager
  const recoveryStore = options.recoveryStore ?? getFreshAgentRecoveryStore()
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
  const settleSleep = options.settleSleep ?? defaultSettleSleep
  const validateCwd = options.validateCwd ?? defaultValidateCwd
  const canonicalizePath = options.canonicalizePath ?? realpath
  const dbPath = options.dbPath ?? path.join(options.dataHome ?? defaultOpencodeDataHome(), 'opencode.db')
  // Lazily create the legacy reader only if a legacy placeholder resume is attempted.
  let historyReader: OpencodeHistoryReader | undefined = options.historyReader
  const legacyReader = (): OpencodeHistoryReader => {
    if (!historyReader) historyReader = createWorkerHistoryReader({ dbPath })
    return historyReader
  }
  const log = logger.child({ component: 'freshopencode-serve-adapter' })
  const sessions = new Map<string, OpencodeSessionState>()

  /** Exactly one monitored idle-recovery per durable session key (kata zrrj).
   * Factory-closure scope: the registry is per adapter instance, so tests get
   * isolation by constructing a fresh adapter and a second adapter (simulated
   * restart) cannot suppress or leak this instance's monitors. */
  type IdleRecoveryMonitor = { promise: Promise<void>; cancelled: boolean }
  const idleRecoveryMonitors = new Map<string, IdleRecoveryMonitor>()

  /** Real ses_ ids with a user send currently in flight. armIdleRecovery must not arm
   * while the send path's own onceIdle owns the turn (attach-mid-send double-fire guard). */
  const sendsInFlight = new Set<string>()

  /** Called by materializeOrSend before arming the send path's own onceIdle so a
   * still-pending cold monitor cannot double-emit idle/chime for the new turn. */
  function disarmIdleRecovery(realId: string): void {
    const existing = idleRecoveryMonitors.get(realId)
    if (existing) {
      existing.cancelled = true
      idleRecoveryMonitors.delete(realId)
    }
  }

  function remember(state: OpencodeSessionState) {
    sessions.set(state.placeholderId, state)
    if (state.realSessionId) sessions.set(state.realSessionId, state)
  }
  function requireState(sessionId: string): OpencodeSessionState {
    const state = sessions.get(sessionId)
    if (!state) throw new FreshAgentLostSessionError(`OpenCode fresh-agent session ${sessionId} is not available.`)
    return state
  }
  function sendResult(sessionId: string | undefined): FreshAgentSendResult {
    return sessionId ? { sessionId, sessionRef: { provider: 'opencode', sessionId } } : undefined
  }

  function cwdRoute(cwd?: string): { cwd: string } | undefined {
    return typeof cwd === 'string' && cwd.trim().length > 0 ? { cwd } : undefined
  }

  async function validateSessionRoute(realId: string, cwd: string): Promise<string> {
    const expected = await canonicalizePath(cwd)
    await validateCwd(cwd)
    const session = await serveManager.getSession(realId, { cwd })
    if (typeof session?.id === 'string' && session.id !== realId) {
      throw new FreshAgentLostSessionError(`OpenCode session lookup for ${realId} returned ${session.id}.`)
    }
    const reportedDirectory = typeof session?.directory === 'string' ? session.directory : undefined
    if (!reportedDirectory) {
      throw new FreshAgentLostSessionError(`OpenCode session ${realId} did not report a directory.`)
    }
    const actual = await canonicalizePath(reportedDirectory)
    if (expected !== actual) {
      throw new FreshAgentLostSessionError(`OpenCode session ${realId} belongs to ${reportedDirectory}, not ${cwd}.`)
    }
    return expected
  }

  async function ensureMutableRoute(state: OpencodeSessionState): Promise<void> {
    const realId = state.realSessionId
    if (!realId) return
    const cwd = state.cwd
    if (state.providerCreatedInThisAdapter && (!cwd || cwd.trim().length === 0)) return
    if (!cwd || cwd.trim().length === 0) {
      throw new FreshAgentLostSessionError(`OpenCode session ${realId} requires a cwd before it can be mutated after recovery.`)
    }
    const expected = await canonicalizePath(cwd)
    if (state.routeValidatedCwd === expected) return
    state.routeValidatedCwd = await validateSessionRoute(realId, cwd)
  }

  async function reconcileStatus(state: OpencodeSessionState): Promise<void> {
    const realId = state.realSessionId
    if (!realId) return
    // Reconciliation resolves to idle unless the status map positively reports the
    // session busy/retry. EMIT the transition (instead of mutating silently) so the
    // client learns the restored status — but stay quiet on a fresh attach where the
    // state is already idle, to avoid snapshot noise (kata zrrj).
    const settleIdle = () => {
      if (state.status !== 'idle') emitStatus(state, 'idle')
    }
    const getSessionStatus = (serveManager as { getSessionStatus?: (sessionId: string, route?: { cwd?: string }) => Promise<{ type?: unknown } | undefined> }).getSessionStatus
    const logContext = {
      provider: 'opencode',
      sessionIdHash: hashForLogs(realId),
      ...(state.cwd ? { cwdHash: hashForLogs(state.cwd) } : {}),
    }
    if (typeof getSessionStatus !== 'function') {
      log.warn({
        ...logContext,
        reason: 'missing_get_session_status',
      }, 'opencode status reconciliation skipped')
      settleIdle()
      return
    }
    try {
      const status = await getSessionStatus.call(serveManager, realId, cwdRoute(state.cwd) ?? {})
      // The opencode /session/status map only reports active (busy/retry) sessions,
      // so an idle session is absent (undefined). Treat a missing entry as idle —
      // consistent with the serve manager's onceIdle treatment of absence as idle —
      // rather than logging a false-positive malformed warning.
      if (status == null) {
        state.initialReconcileCompleted = true
        settleIdle()
        return
      }
      if (typeof status !== 'object' || Array.isArray(status) || typeof status.type !== 'string') {
        log.warn({
          ...logContext,
          reason: 'malformed_session_status',
          status,
        }, 'opencode status reconciliation received malformed status')
        settleIdle()
        return
      }
      const type = status.type
      state.initialReconcileCompleted = true
      if (type === 'busy' || type === 'retry') {
        emitStatus(state, 'running')
        // A restored running session needs a waiter or no idle/turn-complete ever
        // arrives. armIdleRecovery dedupes against existing monitors AND against an
        // in-flight send (whose own onceIdle owns the turn).
        armIdleRecovery(state)
        return
      }
      settleIdle()
    } catch (err) {
      log.warn({
        ...logContext,
        err,
        reason: 'get_session_status_failed',
      }, 'opencode status reconciliation failed')
      settleIdle()
    }
  }

  async function promptAsyncForState(
    state: OpencodeSessionState,
    realId: string,
    body: Parameters<OpencodeServeManager['promptAsync']>[1],
  ): Promise<void> {
    const route = cwdRoute(state.cwd)
    if (route) {
      await serveManager.promptAsync(realId, body, route)
      return
    }
    await serveManager.promptAsync(realId, body)
  }

  /** VAL-A LB-04b dispatch lane: execute a catalog-matched slash command via
   * POST /session/:id/command. The route is synchronous at turn scale — its response is
   * the completed assistant message and IS the completion edge, so the adapter arms NO
   * onceIdle waiter here (onceIdle's busy/idle evidence is SSE/status-map-driven and
   * unproven for command turns; the emitStatus bracket in materializeOrSend covers
   * truthfulness either way). timeoutMs must be turn-scale, not request-scale. */
  async function commandForState(
    state: OpencodeSessionState,
    realId: string,
    match: OpencodeSlashCommandMatch,
    timeoutMs: number,
  ): Promise<void> {
    const route = cwdRoute(state.cwd)
    const body = { command: match.name, arguments: match.arguments }
    if (route) {
      await serveManager.runCommand(realId, body, route, timeoutMs)
      return
    }
    await serveManager.runCommand(realId, body, undefined, timeoutMs)
  }

  async function abortForState(state: OpencodeSessionState): Promise<void> {
    if (!state.realSessionId) return
    await ensureMutableRoute(state)
    const route = cwdRoute(state.cwd)
    if (route) {
      await serveManager.abort(state.realSessionId, route)
      return
    }
    await serveManager.abort(state.realSessionId)
  }

  async function compactForState(state: OpencodeSessionState, input?: { instructions?: string }): Promise<void> {
    if (!state.realSessionId) return
    await ensureMutableRoute(state)
    const realId = state.realSessionId
    const route = cwdRoute(state.cwd)
    // Compact is a user-visible turn: it must green/chime on completion like a send. Set up
    // the idle waiter before issuing the request so we don't miss the idle, and gate the
    // chime on turnAborted/turnErrored so an interrupt or error during compact does not
    // falsely complete.
    state.turnAborted = false
    state.turnErrored = false
    emitStatus(state, 'running')
    // The compact turn owns its idle (same mechanic as materializeOrSend): cancel any
    // still-pending restore idle-recovery monitor (it would otherwise resolve on THIS
    // turn's idle and double-emit idle/chime), and flag the turn so armIdleRecovery
    // cannot arm a second waiter while we are parked on our own onceIdle.
    disarmIdleRecovery(realId)
    sendsInFlight.add(realId)
    try {
      const idle = route
        ? serveManager.onceIdle(realId, turnTimeoutMs, route)
        : serveManager.onceIdle(realId, turnTimeoutMs)
      void idle.catch(() => {})
      try {
        if (route) await serveManager.compact(realId, input, route)
        else if (input) await serveManager.compact(realId, input)
        else await serveManager.compact(realId)
        await idle
        emitStatus(state, 'idle')
        if (!state.turnAborted && !state.turnErrored) {
          const completionAt = nextMonotonicTurnCompleteAt(state.lastTurnCompleteAt, Date.now())
          state.lastTurnCompleteAt = completionAt
          state.events.emit('event', { type: 'sdk.turn.complete', sessionId: state.placeholderId, at: completionAt })
        }
      } catch (error) {
        emitStatus(state, 'idle')
        throw error
      }
    } finally {
      // The compact's turn has settled either way; a later restore/attach may arm a
      // monitor again.
      sendsInFlight.delete(realId)
    }
  }

  async function forkForState(state: OpencodeSessionState): Promise<{ id: string; directory?: string }> {
    if (!state.realSessionId) {
      throw new FreshAgentLostSessionError(`OpenCode session ${state.placeholderId} has not materialized; cannot fork.`)
    }
    await ensureMutableRoute(state)
    const route = cwdRoute(state.cwd)
    return route
      ? await serveManager.fork(state.realSessionId, route)
      : await serveManager.fork(state.realSessionId)
  }

  /** Bridge serve SSE events for this state's real session into the state's
   * own EventEmitter, mapped to sdk.* and stamped with the placeholder id the
   * client first subscribed with. */
  function bindServeStream(state: OpencodeSessionState): void {
    if (state.unsubscribeServe || !state.realSessionId) return
    state.unsubscribeServe = serveManager.subscribe(
      state.realSessionId,
      (parsed) => {
        const mapped = serveEventToSdk(parsed, state.placeholderId)
        if (mapped) {
          if (mapped.type === 'sdk.error') {
            // A turn error means the in-flight turn did not positively complete; the
            // success path consults this when onceIdle later resolves on the post-error idle.
            state.turnErrored = true
          }
          if (mapped.type === 'sdk.session.snapshot') {
            const status: 'running' | 'idle' = mapped.status === 'idle' ? 'idle' : 'running'
            state.status = status
            recordFreshAgentObservabilityEvent({
              kind: 'fresh_agent_opencode_status_observed',
              provider: 'opencode',
              sessionIdHash: hashForLogs(state.realSessionId ?? state.placeholderId),
              status,
              source: 'sse',
              opencodeEventKind: parsed.kind,
              ...(state.cwd ? { cwdHash: hashForLogs(state.cwd) } : {}),
            })
          }
          state.events.emit('event', mapped)
        }
      },
      () => {
        // Sidecar lost while this session shows running: never leave the pane busy.
        // Idempotent with the idle-recovery monitor's own loss reaction — whichever runs
        // first flips status to idle and the other no-ops on the status guard, so one
        // loss yields exactly one structured interruption. (With survive-replacement
        // emitters, this same subscription keeps receiving events from a replacement
        // sidecar — no rebind needed.)
        if (state.status === 'running') {
          emitStatus(state, 'idle')
          state.events.emit('event', {
            type: 'sdk.error',
            sessionId: state.placeholderId,
            message: 'OpenCode turn interrupted: sidecar connection was lost while the turn was running.',
          })
        }
      },
    )
  }

  function emitStatus(state: OpencodeSessionState, status: 'running' | 'idle'): void {
    state.status = status
    state.events.emit('event', { type: 'sdk.session.snapshot', sessionId: state.placeholderId, status })
    recordFreshAgentObservabilityEvent({
      kind: 'fresh_agent_opencode_status_observed',
      provider: 'opencode',
      sessionIdHash: hashForLogs(state.realSessionId ?? state.placeholderId),
      status,
      source: 'adapter',
      ...(state.cwd ? { cwdHash: hashForLogs(state.cwd) } : {}),
    })
  }

  /** Capture the sidecar's /command listing once per established adapter state
   * (create/resume/attach), scoped to the pane's directory via the serve manager's
   * withRoute convention — the SAME long-lived sidecar the session itself runs on; never
   * a scratch spawn (VAL-A LB-03: --pure drops config-inline user commands). A blank
   * state cwd intentionally fetches the undirected listing: a cwd-less session materializes
   * in the sidecar's root directory, which is exactly what undirected /command serves.
   *
   * Fire-and-forget for callers; failure/absent/5xx/timeout ⇒ commands stay absent and
   * leading-slash sends keep the verbatim prompt path — NEVER session-fatal. The sidecar
   * scans project-layer command files at startup only, so a catalog captured here does not
   * see command files created after the sidecar booted (E4 freshness caveat). */
  function captureCommands(state: OpencodeSessionState): void {
    const route = cwdRoute(state.cwd)
    state.pendingCommands = (async () => {
      try {
        const raw = route ? await serveManager.listCommands(route) : await serveManager.listCommands()
        const rows = normalizeOpencodeCommandCatalog(raw)
        if (!rows) {
          state.commandsCaptureFailedAt = Date.now()
          log.warn({
            provider: 'opencode',
            sessionIdHash: hashForLogs(state.realSessionId ?? state.placeholderId),
            ...(state.cwd ? { cwdHash: hashForLogs(state.cwd) } : {}),
          }, 'opencode command catalog listing was malformed; advertising no session commands')
          return
        }
        state.commands = rows
        state.commandsCaptureFailedAt = undefined
        // The claude-side invalidation precedent: freshAgent.session.changed (translated
        // from sdk.session.changed) is already in the client's snapshot-invalidating set,
        // so a live composer refetches the snapshot and sees the catalog — no new WS shape.
        state.events.emit('event', { type: 'sdk.session.changed', sessionId: state.placeholderId, reason: 'session-commands' })
      } catch (error) {
        state.commandsCaptureFailedAt = Date.now()
        log.warn({
          provider: 'opencode',
          sessionIdHash: hashForLogs(state.realSessionId ?? state.placeholderId),
          ...(state.cwd ? { cwdHash: hashForLogs(state.cwd) } : {}),
          err: error,
        }, 'opencode command catalog fetch failed; advertising no session commands')
      }
    })()
  }

  /** Settle the catalog before the send path classifies leading-slash text. Always
   * awaits any in-flight capture; when the last capture FAILED (or was malformed) and
   * the backoff has elapsed, also fires this session's single lazy re-capture and
   * awaits it — a create-time failure otherwise leaves commands permanently absent
   * and every slash send leaks verbatim to the model. Never rejects. */
  async function settleCommandsBeforeSend(state: OpencodeSessionState): Promise<void> {
    await state.pendingCommands
    if (state.commands || state.commandsCaptureRetried) return
    if (state.commandsCaptureFailedAt === undefined) return
    if (Date.now() - state.commandsCaptureFailedAt < COMMANDS_CAPTURE_RETRY_BACKOFF_MS) return
    state.commandsCaptureRetried = true
    captureCommands(state)
    await state.pendingCommands
  }

  /**
   * After idle, verify the final assistant message is queryable via the REST
   * read path before declaring the turn complete (kata zrrj freshness contract).
   * Returns true when settled; false when polling exhausted (idle is still
   * emitted — the turn is not stranded — but the client re-poll covers the gap).
   *
   * Settled means: the newest page of `listMessages` contains an assistant message
   * created at/after `sentAtMs` (minus CLOCK_SKEW_MS) with a finite `time.completed`.
   * `sentAtMs = 0` accepts ANY completed assistant message (restore monitor path,
   * where the pre-restart send time is unknowable).
   */
  async function awaitTranscriptSettled(state: OpencodeSessionState, sentAtMs: number): Promise<boolean> {
    const realId = state.realSessionId
    if (!realId) return true
    const route = cwdRoute(state.cwd)
    for (let attempt = 0; attempt <= TRANSCRIPT_SETTLE_MAX_POLLS; attempt++) {
      if (attempt > 0) await settleSleep(TRANSCRIPT_SETTLE_POLL_MS)
      try {
        const page = route
          ? await serveManager.listMessages(realId, { limit: TRANSCRIPT_SETTLE_PAGE_LIMIT }, route)
          : await serveManager.listMessages(realId, { limit: TRANSCRIPT_SETTLE_PAGE_LIMIT })
        if (hasSettledAssistantMessage(page.messages, sentAtMs)) return true
      } catch {
        // A transient read failure counts as an unsettled poll; the budget bounds it.
      }
    }
    log.warn({
      provider: 'opencode',
      sessionIdHash: hashForLogs(realId),
      ...(state.cwd ? { cwdHash: hashForLogs(state.cwd) } : {}),
      polls: TRANSCRIPT_SETTLE_MAX_POLLS + 1,
    }, 'transcript did not settle after idle')
    return false
  }

  /** Arm the restore idle-recovery monitor for a durable session reconciled as busy.
   * Exactly one monitor per real ses_ id; no-op while a user send is in flight (its own
   * onceIdle owns the turn). Resolve emits idle (+ chime unless the turn aborted/errored);
   * reject (timeout / sidecar loss) emits idle + a structured interruption signal so the
   * pane is never left busy forever. */
  function armIdleRecovery(state: OpencodeSessionState): void {
    const realId = state.realSessionId
    if (!realId) return
    if (idleRecoveryMonitors.has(realId) || sendsInFlight.has(realId)) {
      // Second disjunct: attach-mid-send guard — the send path's own onceIdle owns this turn.
      recordFreshAgentObservabilityEvent({
        kind: 'fresh_agent_monitor',
        provider: 'opencode',
        sessionIdHash: hashForLogs(realId),
        ...(state.cwd ? { cwdHash: hashForLogs(state.cwd) } : {}),
        phase: 'duplicate_suppressed',
      })
      return
    }
    const route = cwdRoute(state.cwd)
    const generation = typeof serveManager.currentGeneration === 'function' ? serveManager.currentGeneration() : undefined
    const monitorEvent = (phase: 'armed' | 'resolved_idle' | 'timeout' | 'sidecar_lost') =>
      recordFreshAgentObservabilityEvent({
        kind: 'fresh_agent_monitor',
        provider: 'opencode',
        sessionIdHash: hashForLogs(realId),
        ...(state.cwd ? { cwdHash: hashForLogs(state.cwd) } : {}),
        phase,
        ...(generation !== undefined ? { sidecarGeneration: generation } : {}),
      })
    monitorEvent('armed')
    const monitor: IdleRecoveryMonitor = { promise: Promise.resolve(), cancelled: false }
    // assumeActive: arming always follows a reconcile that OBSERVED busy, so seed the
    // activity gate — without it, a turn that finished in the read->arm gap hangs to the
    // 10-min timeout and emits a false "interrupted" (A4).
    const idle = route
      ? serveManager.onceIdle(realId, DEFAULT_TURN_TIMEOUT_MS, route, { assumeActive: true })
      : serveManager.onceIdle(realId, DEFAULT_TURN_TIMEOUT_MS, undefined, { assumeActive: true })
    monitor.promise = idle
      .then(async () => {
        if (monitor.cancelled) return // disarmed by a newer user send — its own onceIdle owns this turn
        // Freshness proof (kata zrrj): before declaring the recovered turn complete, prove
        // the REST read path can serve a completed assistant message. sentAtMs = 0: the
        // pre-restart send time is unknowable, so ANY completed assistant message settles.
        await awaitTranscriptSettled(state, 0)
        if (monitor.cancelled) return // a user send may have disarmed us while settling
        emitStatus(state, 'idle')
        monitorEvent('resolved_idle')
        // Restored sessions have both flags undefined -> falsy -> chime allowed; the
        // pre-restart error is unobservable and OpenCode reporting busy->idle is the
        // best positive-completion signal available.
        if (!state.turnAborted && !state.turnErrored) {
          const completionAt = nextMonotonicTurnCompleteAt(state.lastTurnCompleteAt, Date.now())
          state.lastTurnCompleteAt = completionAt
          state.events.emit('event', { type: 'sdk.turn.complete', sessionId: state.placeholderId, at: completionAt })
        }
      })
      .catch((error: unknown) => {
        if (monitor.cancelled) return
        const lost = error instanceof OpencodeServeLostError
        monitorEvent(lost ? 'sidecar_lost' : 'timeout')
        // Status guard makes the loss reaction idempotent with bindServeStream's onLost
        // handler: whichever runs first flips status to idle; the other becomes a no-op,
        // so one loss yields exactly one structured interruption emission.
        if (state.status !== 'running') return
        emitStatus(state, 'idle')
        state.events.emit('event', {
          type: 'sdk.error',
          sessionId: state.placeholderId,
          message: lost
            ? 'OpenCode turn interrupted: sidecar connection was lost while the turn was running.'
            : 'OpenCode turn interrupted: idle recovery timed out.',
        })
      })
      .finally(() => {
        if (idleRecoveryMonitors.get(realId) === monitor) idleRecoveryMonitors.delete(realId)
      })
    idleRecoveryMonitors.set(realId, monitor)
  }

  function emitMaterialized(state: OpencodeSessionState): void {
    if (!state.realSessionId) return
    state.events.emit('event', {
      type: 'freshAgent.session.materialized',
      previousSessionId: state.placeholderId,
      sessionId: state.realSessionId,
      sessionRef: { provider: 'opencode', sessionId: state.realSessionId },
    })
  }

  async function materializeOrSend(
    state: OpencodeSessionState,
    text: string,
    settings?: Partial<FreshAgentCreateRequest>,
    opts?: { freshellContinuation?: boolean },
  ): Promise<FreshAgentSendResult> {
    const normalized = settings
      ? normalizeOpencodeInput({ requestId: state.placeholderId, sessionType: 'freshopencode', provider: 'opencode', ...settings } as FreshAgentCreateRequest)
      : undefined
    const modelStr = normalized?.model ?? state.model
    const effort = normalized?.effort ?? state.effort
    const effectiveCwd = normalized?.cwd ?? state.cwd

    // A fresh turn starts un-aborted and un-errored; interrupt() flips turnAborted while we
    // are parked on idle, and the serve stream flips turnErrored if the turn reports an error.
    state.turnAborted = false
    state.turnErrored = false
    emitStatus(state, 'running')
    try {
      if (!state.realSessionId) {
        if (effectiveCwd) await validateCwd(effectiveCwd)
        const session = await serveManager.createSession({ title: undefined, ...(effectiveCwd ? { directory: effectiveCwd } : {}) })
        state.realSessionId = session.id
        state.providerCreatedInThisAdapter = true
        if (typeof session.directory === 'string' && session.directory.length > 0) state.cwd = session.directory
        else if (effectiveCwd) state.cwd = effectiveCwd
        if (typeof session.directory === 'string' && session.directory.length > 0 && state.cwd) {
          state.routeValidatedCwd = await canonicalizePath(state.cwd)
        }
        remember(state)
        bindServeStream(state)
        emitMaterialized(state)
      }

      const realId = state.realSessionId!
      await ensureMutableRoute(state)
      if (!opts?.freshellContinuation) {
        // A user follow-up cancels any recorded stop intent (kata zrrj). Freshell-owned
        // continuation sends are internal and must NOT clear it — otherwise a recovery
        // injection would erase the very intent that gates future recoveries.
        await recoveryStore.clearInterrupt(realId)
      }
      // The user send owns this turn: cancel any still-pending restore idle-recovery
      // monitor (it would otherwise resolve on THIS turn's idle and double-emit
      // idle/chime), and flag the send so armIdleRecovery cannot arm a second waiter
      // while we are parked on our own onceIdle (attach-mid-send).
      disarmIdleRecovery(realId)
      sendsInFlight.add(realId)
      try {
        const idleRoute = cwdRoute(state.cwd)
        // A catalog capture fired at create/resume/attach may still be in flight; settle
        // it BEFORE classifying the text so a leading-slash send issued the instant after
        // create cannot miss its match and leak verbatim to the model as prose. The settle
        // is cheap in the steady state (the fetch resolved with the sidecar startup that
        // materialization above already waited on) and never rejects; a failed create-time
        // capture gets its one lazy re-attempt here, gated by backoff.
        await settleCommandsBeforeSend(state)
        const slashCommand = matchOpencodeSlashCommand(text, state.commands)
        // Freshness anchor (kata zrrj): the settle proof below accepts only assistant
        // messages created at/after this send (minus clock skew).
        const sentAtMs = Date.now()
        if (slashCommand) {
          // Command-route turn (VAL-A LB-04b): POST /session/:id/command executes the row
          // server-side (template expansion is the provider's) and RETURNS on turn
          // completion — no onceIdle waiter, no verbatim prompt is ever sent. Busy/idle
          // stay the adapter-synthesized bracket below; whether the live sidecar also
          // emits busy SSE around /command turns is unprobed (VAL-A) and irrelevant to
          // the bracket's truthfulness.
          await commandForState(state, realId, slashCommand, turnTimeoutMs)
        } else {
          const idle = idleRoute
            ? serveManager.onceIdle(realId, turnTimeoutMs, idleRoute)
            : serveManager.onceIdle(realId, turnTimeoutMs)
          // If promptAsync fails and we leave via the catch(), `idle` may still
          // reject later on its timeout timer. Attach a no-op handler now so that
          // later rejection cannot become an unhandled rejection.
          void idle.catch(() => {})
          await promptAsyncForState(state, realId, {
            parts: [{ type: 'text', text }],
            ...(splitOpencodeModel(modelStr) ? { model: splitOpencodeModel(modelStr)! } : {}),
            ...(effort ? { variant: effort } : {}),
          })
          await idle
          state.model = modelStr ?? state.model
          state.effort = effort
        }
        // Prove the final assistant message is queryable via the REST read path BEFORE
        // emitting idle/turn-complete — session.idle does not sequence behind message
        // persistence, so the client's post-idle snapshot could otherwise miss the answer.
        await awaitTranscriptSettled(state, sentAtMs)
        emitStatus(state, 'idle')
        // Server-authoritative turn-complete edge for the GREEN/SOUND pipeline. onceIdle
        // resolves on ANY idle — including the idle an interrupt's abort triggers or the idle
        // that follows an errored turn — so a positive completion requires that the turn was
        // neither interrupted nor errored. (The catch below for abort/interrupt/sidecar loss
        // and the serve SSE idle relay also never chime.)
        if (!state.turnAborted && !state.turnErrored) {
          const completionAt = nextMonotonicTurnCompleteAt(state.lastTurnCompleteAt, Date.now())
          state.lastTurnCompleteAt = completionAt
          state.events.emit('event', { type: 'sdk.turn.complete', sessionId: state.placeholderId, at: completionAt })
        }
        return sendResult(state.realSessionId)
      } finally {
        // The send's turn has settled either way; a later restore/attach may arm a
        // monitor again.
        sendsInFlight.delete(realId)
      }
    } catch (error) {
      emitStatus(state, 'idle')
      throw error
    }
  }

  /** Send-queue entry shared by the public send() and the recovery continuation: every
   * send is serialized on the state's queue, route-validated (ensureMutableRoute) and
   * armed with onceIdle inside materializeOrSend. */
  async function sendForState(
    state: OpencodeSessionState,
    input: { text: string; settings?: Partial<FreshAgentCreateRequest>; freshellContinuation?: boolean },
  ): Promise<FreshAgentSendResult> {
    const opts = { freshellContinuation: input.freshellContinuation }
    const run = state.sendQueue.then(
      () => materializeOrSend(state, input.text, input.settings, opts),
      () => materializeOrSend(state, input.text, input.settings, opts),
    )
    state.sendQueue = run.catch(() => undefined)
    return await run
  }

  type TurnRecoveryAction =
    | 'continuation_injected'
    | 'suppressed_user_stop'
    | 'suppressed_user_followup'
    | 'suppressed_already_recovered'
    | 'suppressed_low_confidence'
    | 'suppressed_no_route'

  /** Restore-time interrupted-turn recovery (kata zrrj): after a resume/attach reconciled
   * the session as idle, inspect the live transcript and inject at most ONE Freshell-owned
   * continuation per failed turn. Gates, in order: durable user stop intent, evidence-based
   * detection, route/mutability precondition, then the persisted once-per-(session, message)
   * ledger — recorded BEFORE injection so a crash can never double-recover. Never throws. */
  async function maybeRecoverInterruptedTurn(state: OpencodeSessionState): Promise<void> {
    const realId = state.realSessionId
    if (!realId) return
    const audit = (action: TurnRecoveryAction, reason: string, messageId?: string) =>
      recordFreshAgentObservabilityEvent({
        kind: 'fresh_agent_turn_recovery',
        provider: 'opencode',
        sessionIdHash: hashForLogs(realId),
        ...(state.cwd ? { cwdHash: hashForLogs(state.cwd) } : {}),
        action,
        reason,
        ...(messageId ? { messageIdHash: hashForLogs(messageId) } : {}),
      })
    try {
      if (await recoveryStore.hasInterrupt(realId)) {
        // NEVER auto-recover after an explicit user stop.
        audit('suppressed_user_stop', 'user_interrupt_on_record')
        return
      }
      const route = cwdRoute(state.cwd)
      const page = route
        ? await serveManager.listMessages(realId, { limit: DEFAULT_SNAPSHOT_TURN_LIMIT }, route)
        : await serveManager.listMessages(realId, { limit: DEFAULT_SNAPSHOT_TURN_LIMIT })
      const verdict = detectInterruptedTurn(page.messages, { nowMs: Date.now() })
      if (!verdict.interrupted) {
        if (verdict.reason === 'last_message_not_assistant') {
          audit('suppressed_user_followup', verdict.reason)
        } else if (verdict.reason !== 'empty_transcript') {
          audit('suppressed_low_confidence', verdict.reason)
        }
        return
      }
      if (!verdict.messageId) {
        // An id-less trailing message cannot be tracked in the per-(session, message)
        // ledger, so an injection could never be made once-only. Err on the safe side.
        audit('suppressed_low_confidence', 'missing_message_id')
        return
      }
      // Route/mutability precondition BEFORE any ledger write (A6/N-V1a):
      // ensureMutableRoute throws for a non-provider-created state without a cwd. If we
      // recorded the recovery first and the send then threw, the (session, message)
      // ledger entry would be permanently burned — a later cwd-bearing attach could never
      // recover this turn. So: no usable route -> audit and return WITHOUT recording.
      const hasUsableRoute = state.providerCreatedInThisAdapter
        || (typeof state.cwd === 'string' && state.cwd.trim().length > 0)
      if (!hasUsableRoute) {
        audit('suppressed_no_route', 'no_cwd_for_mutation', verdict.messageId)
        return
      }
      if (await recoveryStore.hasRecovery(realId, verdict.messageId)) {
        audit('suppressed_already_recovered', 'ledger_hit', verdict.messageId)
        return
      }
      // Record BEFORE injecting: crash-safe loop prevention. Accepted residual: a
      // transient send failure after this write burns the one allowed recovery for the
      // turn — errs on the safe side (never risks double injection).
      await recoveryStore.recordRecovery(realId, verdict.messageId)
      audit('continuation_injected', verdict.evidence.join(','), verdict.messageId)
      state.events.emit('event', {
        type: 'sdk.session.changed', sessionId: state.placeholderId, reason: 'freshell-turn-recovery',
      })
      await sendForState(state, { text: FRESHELL_CONTINUATION_PROMPT, freshellContinuation: true })
    } catch (error) {
      log.warn({ provider: 'opencode', sessionIdHash: hashForLogs(realId), err: error }, 'interrupted-turn recovery failed')
    }
  }

  /** Fire-and-forget recovery kickoff after reconcileStatus on resume/attach. Only an
   * idle-reconciled restore is a candidate — a running session is being monitored by
   * armIdleRecovery; if that monitor later reports loss, the NEXT restore attempt will
   * find the unfinished transcript and recover it here.
   *
   * Passes are CHAINED on the state, not fired in parallel: two near-simultaneous
   * restores of the same session (multi-pane restore after a restart) must not both
   * pass the `hasRecovery` gate before either `recordRecovery` lands — the store
   * serializes operations individually but has no atomic check-and-set, so parallel
   * passes could double-inject. Chaining guarantees the second pass's ledger read
   * sees the first pass's record. The `.catch` keeps the chain rejection-safe
   * (maybeRecoverInterruptedTurn never rejects by contract, but a poisoned chain
   * would silently disable recovery forever). */
  function scheduleInterruptedTurnRecovery(state: OpencodeSessionState): void {
    if (state.status !== 'idle') return
    state.pendingRecovery = (state.pendingRecovery ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => maybeRecoverInterruptedTurn(state))
  }

  async function assembleExport(
    realSessionId: string,
    query: { limit?: number; before?: string },
    route?: { cwd: string },
  ): Promise<{ exported: OpencodeExport; nextCursor: string | null; revision: number }> {
    const [session, page] = await Promise.all([
      (route ? serveManager.getSession(realSessionId, route) : serveManager.getSession(realSessionId)).then(
        (session) => session,
        () => ({} as Record<string, unknown>),
      ),
      route ? serveManager.listMessages(realSessionId, query, route) : serveManager.listMessages(realSessionId, query),
    ])
    const sessionTime = session && typeof session === 'object' ? session.time : undefined
    const sessionTimeUpdated = sessionTime && typeof sessionTime === 'object' && !Array.isArray(sessionTime)
      ? (sessionTime as Record<string, unknown>).updated
      : undefined
    const revision = Number.isFinite(Number(sessionTimeUpdated)) ? Number(sessionTimeUpdated) : page.messages.length
    const exported: OpencodeExport = {
      info: { id: realSessionId, ...(session ?? {}) },
      messages: page.messages.map((m) => ({ info: m.info, parts: m.parts })),
    }
    return { exported, nextCursor: page.nextCursor, revision }
  }

  function durableId(threadId: string): string {
    const state = sessions.get(threadId)
    if (state?.realSessionId) return state.realSessionId
    if (isRealOpencodeSessionId(threadId)) return threadId
    throw new FreshAgentLostSessionError(`OpenCode fresh-agent session ${threadId} has not materialized.`)
  }

  return {
    runtimeProvider: 'opencode',

    async create(input) {
      const normalized = normalizeOpencodeInput(input)
      const state: OpencodeSessionState = {
        placeholderId: makePlaceholderId(String(input.requestId)),
        stateGeneration: nextStateGeneration(),
        cwd: normalized.cwd,
        model: normalized.model,
        effort: normalized.effort,
        status: 'idle',
        events: new EventEmitter(),
        sendQueue: Promise.resolve(),
      }
      remember(state)
      captureCommands(state)
      return { sessionId: state.placeholderId, sessionRef: { provider: 'opencode', sessionId: state.placeholderId } }
    },

    async resume(input) {
      const normalized = normalizeOpencodeInput(input)
      const sessionId = normalized.resumeSessionId
      if (!sessionId) throw new Error('OpenCode resume requires a session id.')
      if (isPlaceholderOpencodeSessionId(sessionId)) {
        const real = await resolveLegacyPlaceholder(legacyReader(), normalized, sessionId)
        const state: OpencodeSessionState = {
          placeholderId: sessionId, stateGeneration: nextStateGeneration(), realSessionId: real, cwd: normalized.cwd,
          model: normalized.model, effort: normalized.effort, status: 'idle', events: new EventEmitter(), sendQueue: Promise.resolve(),
        }
        remember(state)
        bindServeStream(state)
        captureCommands(state)
        await reconcileStatus(state)
        scheduleInterruptedTurnRecovery(state)
        return { sessionId: real, sessionRef: { provider: 'opencode', sessionId: real } }
      }
      if (!isRealOpencodeSessionId(sessionId)) {
        throw new FreshAgentLostSessionError(`OpenCode session ${sessionId} is not a durable OpenCode session.`)
      }
      const state: OpencodeSessionState = {
        placeholderId: sessionId, stateGeneration: nextStateGeneration(), realSessionId: sessionId, cwd: normalized.cwd,
        model: normalized.model, effort: normalized.effort, status: 'idle', events: new EventEmitter(), sendQueue: Promise.resolve(),
      }
      remember(state)
      bindServeStream(state)
      captureCommands(state)
      await reconcileStatus(state)
      scheduleInterruptedTurnRecovery(state)
      return { sessionId, sessionRef: { provider: 'opencode', sessionId } }
    },

    async attach(locator) {
      const existing = sessions.get(locator.sessionId)
      if (existing) {
        if (locator.cwd && existing.realSessionId) {
          const routeValidatedCwd = await validateSessionRoute(existing.realSessionId, locator.cwd)
          if (existing.cwd !== locator.cwd) existing.routeValidatedCwd = undefined
          existing.cwd = locator.cwd
          existing.routeValidatedCwd = routeValidatedCwd
        } else if (locator.cwd) {
          existing.cwd = locator.cwd
        }
        remember(existing)
        captureCommands(existing)
        await reconcileStatus(existing)
        scheduleInterruptedTurnRecovery(existing)
        return { sessionId: locator.sessionId, sessionRef: { provider: 'opencode', sessionId: locator.sessionId } }
      }
      if (isPlaceholderOpencodeSessionId(locator.sessionId) || !isRealOpencodeSessionId(locator.sessionId)) {
        throw new FreshAgentLostSessionError(`OpenCode session ${locator.sessionId} is not a durable OpenCode session.`)
      }
      const state: OpencodeSessionState = {
        placeholderId: locator.sessionId,
        stateGeneration: nextStateGeneration(),
        realSessionId: locator.sessionId,
        cwd: locator.cwd,
        status: 'idle',
        events: new EventEmitter(), sendQueue: Promise.resolve(),
      }
      if (locator.cwd) {
        state.routeValidatedCwd = await validateSessionRoute(locator.sessionId, locator.cwd)
      }
      remember(state)
      bindServeStream(state)
      captureCommands(state)
      await reconcileStatus(state)
      scheduleInterruptedTurnRecovery(state)
      return { sessionId: locator.sessionId, sessionRef: { provider: 'opencode', sessionId: locator.sessionId } }
    },

    subscribe(sessionId, listener) {
      const state = requireState(sessionId)
      const handler = (event: unknown) => listener(event)
      state.events.on('event', handler)
      return () => state.events.off('event', handler)
    },

    sessionStateGeneration(sessionId) {
      return sessions.get(sessionId)?.stateGeneration
    },

    /** Read-only incident inspection (kata zrrj): a content-free summary of every
     * tracked session state. The sessions map aliases each state under both its
     * placeholder and real id, so states are deduped by object identity. Pure map
     * walk; mutates nothing. */
    inspectSessions(): OpencodeInspectedSession[] {
      const seen = new Set<OpencodeSessionState>()
      const summaries: OpencodeInspectedSession[] = []
      for (const state of sessions.values()) {
        if (seen.has(state)) continue
        seen.add(state)
        summaries.push({
          sessionIdHash: hashForLogs(state.realSessionId ?? state.placeholderId),
          status: state.status,
          hasRealSession: Boolean(state.realSessionId),
          ...(state.cwd ? { cwdHash: hashForLogs(state.cwd) } : {}),
          monitorArmed: state.realSessionId ? idleRecoveryMonitors.has(state.realSessionId) : false,
          ...(state.turnAborted !== undefined ? { turnAborted: state.turnAborted } : {}),
          ...(state.turnErrored !== undefined ? { turnErrored: state.turnErrored } : {}),
          ...(state.lastTurnCompleteAt !== undefined ? { lastTurnCompleteAt: state.lastTurnCompleteAt } : {}),
        })
      }
      return summaries
    },

    async send(sessionId, input) {
      const state = requireState(sessionId)
      return await sendForState(state, { text: input.text, settings: input.settings })
    },

    /** Apply settings to the LIVE session record without a turn (opencode's
     * per-send scope: the NEXT prompt_async body carries the recorded pair).
     * Mirrors `materializeOrSend`'s settings-merge semantics (present settings
     * normalize over the record; an absent key keeps the stored value), then
     * emits the `sdk.session.metadata` convergence event so every subscribed
     * device's model surfaces update immediately. No busy refusal: recording
     * mid-turn is safe — the in-flight turn keeps the pair it prompted with. */
    async configure(sessionId, input) {
      const state = requireState(sessionId)
      const settings = (input.settings ?? {}) as Partial<FreshAgentCreateRequest>
      const normalized = input.settings
        ? normalizeOpencodeInput({ requestId: state.placeholderId, sessionType: 'freshopencode', provider: 'opencode', ...settings } as FreshAgentCreateRequest)
        : undefined
      const model = normalized?.model ?? state.model
      const effort = normalized?.effort ?? state.effort
      if (state.model === model && state.effort === effort) return
      state.model = model
      state.effort = effort
      state.events.emit('event', {
        type: 'sdk.session.metadata',
        sessionId,
        model: state.model,
        effort: state.effort,
      })
    },

    async interrupt(sessionId) {
      const state = requireState(sessionId)
      // Mark before aborting so the in-flight send (parked on onceIdle) sees the abort and
      // suppresses its turn-complete chime when the abort-triggered idle resolves it.
      state.turnAborted = true
      const realId = state.realSessionId
      try {
        // Record the user's explicit stop intent durably BEFORE the abort lands (kata
        // zrrj): if the process dies right after the abort, a later restore must already
        // see the intent and never auto-recover a turn the user deliberately stopped.
        if (realId) await recoveryStore.recordInterrupt(realId)
        await abortForState(state)
      } catch (error) {
        // The abort never landed, so the turn may still complete normally — clear the flag
        // so a genuine completion is not silently swallowed, and roll back the durable
        // stop intent (mirroring the turnAborted rollback) so a genuine later
        // interruption can still be recovered.
        state.turnAborted = false
        if (realId) await recoveryStore.clearInterrupt(realId).catch(() => undefined)
        throw error
      }
      emitStatus(state, 'idle')
    },

    async compact(sessionId, input) {
      const state = requireState(sessionId)
      if (!state.realSessionId) return
      const instructions = input?.instructions
      const hasInstructions = instructions !== undefined
      const run = state.sendQueue.then(
        () => compactForState(state, hasInstructions ? { instructions } : undefined),
        () => compactForState(state, hasInstructions ? { instructions } : undefined),
      )
      state.sendQueue = run.catch(() => undefined)
      await run
    },

    async fork(sessionId) {
      const state = requireState(sessionId)
      const child = await forkForState(state)
      const childState: OpencodeSessionState = {
        placeholderId: child.id,
        stateGeneration: nextStateGeneration(),
        realSessionId: child.id,
        cwd: child.directory ?? state.cwd,
        providerCreatedInThisAdapter: true,
        model: state.model,
        effort: state.effort,
        status: 'idle',
        events: new EventEmitter(),
        sendQueue: Promise.resolve(),
      }
      remember(childState)
      bindServeStream(childState)
      return { sessionId: child.id, sessionRef: { provider: 'opencode', sessionId: child.id } }
    },

    async kill(sessionId) {
      const state = requireState(sessionId)
      await ensureMutableRoute(state)
      try { state.unsubscribeServe?.() } catch { /* ignore */ }
      // A killed session must not receive a late monitor idle/interruption emission.
      if (state.realSessionId) disarmIdleRecovery(state.realSessionId)
      sessions.delete(state.placeholderId)
      if (state.realSessionId) sessions.delete(state.realSessionId)
      return true
    },

    async getSnapshot(thread) {
      const liveState = sessions.get(thread.threadId)
      if (liveState && !liveState.realSessionId) {
        return normalizeOpencodeSnapshot({
          sessionType: 'freshopencode', threadId: thread.threadId, status: liveState.status,
          model: liveState.model, effort: liveState.effort, commands: liveState.commands,
        })
      }
      const realId = durableId(thread.threadId)
      const route = cwdRoute(liveState?.cwd ?? thread.cwd)
      const { exported, revision } = route
        ? await assembleExport(realId, { limit: DEFAULT_SNAPSHOT_TURN_LIMIT }, route)
        : await assembleExport(realId, { limit: DEFAULT_SNAPSHOT_TURN_LIMIT })
      return normalizeOpencodeSnapshot({
        sessionType: 'freshopencode', threadId: thread.threadId,
        exported: { ...exported, info: { ...(exported.info ?? {}), time: { ...((exported.info?.time) ?? {}), updated: revision } } },
        status: liveState?.status ?? 'idle', model: liveState?.model, effort: liveState?.effort,
        commands: liveState?.commands,
        // Task 4's client busy-clear gate: only a snapshot whose status comes from live,
        // reconciled adapter state may clear busy; the untracked default above must not.
        statusFromLiveState: liveState?.initialReconcileCompleted === true,
      })
    },

    async getTurnPage(thread, query) {
      const liveState = sessions.get(thread.threadId)
      if (liveState && !liveState.realSessionId) {
        return normalizeOpencodeTurnPage({ threadId: thread.threadId, exported: { messages: [] }, revision: Number(query.revision) || 0, nextCursor: null })
      }
      const realId = durableId(thread.threadId)
      const route = cwdRoute(liveState?.cwd ?? thread.cwd)
      const pageQuery = {
        limit: typeof query.limit === 'number' ? query.limit : DEFAULT_SNAPSHOT_TURN_LIMIT,
        before: typeof query.cursor === 'string' ? query.cursor : undefined,
      }
      const { exported, nextCursor, revision } = route
        ? await assembleExport(realId, pageQuery, route)
        : await assembleExport(realId, pageQuery)
      return normalizeOpencodeTurnPage({ threadId: thread.threadId, exported, revision, nextCursor })
    },

    async getTurnBody(thread, revision) {
      const liveState = sessions.get(thread.threadId)
      if (liveState && !liveState.realSessionId) return null
      const realId = durableId(thread.threadId)
      const route = cwdRoute(liveState?.cwd ?? thread.cwd)
      const message = route
        ? await serveManager.getMessage(realId, thread.turnId, route)
        : await serveManager.getMessage(realId, thread.turnId)
      if (!message) return null
      return normalizeOpencodeTurnBody({ threadId: thread.threadId, exported: { messages: [{ info: message.info, parts: message.parts }] }, turnId: thread.turnId, revision })
    },

    async shutdown() {
      for (const state of sessions.values()) { try { state.unsubscribeServe?.() } catch { /* ignore */ } }
      sessions.clear()
      await serveManager.shutdown()
    },
  }
}

async function resolveLegacyPlaceholder(reader: OpencodeHistoryReader, input: FreshAgentCreateRequest, placeholderId: string): Promise<string> {
  const ctx = input.legacyRestoreContext
  const title = typeof ctx?.title === 'string' ? ctx.title : undefined
  const createdAt = typeof ctx?.createdAt === 'number' ? ctx.createdAt : undefined
  const updatedAt = typeof ctx?.updatedAt === 'number' ? ctx.updatedAt : undefined
  if (!input.cwd || (!title && createdAt === undefined && updatedAt === undefined)) {
    throw new FreshAgentLostSessionError(`OpenCode session ${placeholderId} is not a durable OpenCode session.`)
  }
  let resolved: Awaited<ReturnType<OpencodeHistoryReader['resolveLegacySession']>>
  try {
    resolved = await reader.resolveLegacySession({ cwd: input.cwd, title, createdAt, updatedAt })
  } catch {
    throw new FreshAgentLostSessionError(`OpenCode session ${placeholderId} is not a durable OpenCode session.`)
  }
  if (!resolved?.id || !/^ses_/.test(resolved.id)) {
    throw new FreshAgentLostSessionError(`OpenCode session ${placeholderId} is not a durable OpenCode session.`)
  }
  return resolved.id
}
