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
import { logger } from '../../../logger.js'
import { defaultOpencodeDataHome } from '../../../coding-cli/providers/opencode.js'
import {
  hashForLogs,
  recordFreshAgentObservabilityEvent,
} from '../../observability.js'
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
import type { OpencodeServeManager } from './serve-manager.js'
import { serveEventToSdk, splitOpencodeModel } from './serve-events.js'

const OPENCODE_REAL_SESSION_ID = /^ses_/
const OPENCODE_PLACEHOLDER_SESSION_ID = /^freshopencode-/
const DEFAULT_TURN_TIMEOUT_MS = 600_000

type OpencodeSessionState = {
  placeholderId: string
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

export function createOpencodeFreshAgentAdapter(options: CreateOpencodeFreshAgentAdapterOptions): FreshAgentRuntimeAdapter {
  const serveManager = options.serveManager
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
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
    state.status = 'idle'
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
      return
    }
    try {
      const status = await getSessionStatus.call(serveManager, realId, cwdRoute(state.cwd) ?? {})
      // The opencode /session/status map only reports active (busy/retry) sessions,
      // so an idle session is absent (undefined). Treat a missing entry as idle —
      // consistent with the serve manager's onceIdle treatment of absence as idle —
      // rather than logging a false-positive malformed warning.
      if (status == null) return
      if (typeof status !== 'object' || Array.isArray(status) || typeof status.type !== 'string') {
        log.warn({
          ...logContext,
          reason: 'malformed_session_status',
          status,
        }, 'opencode status reconciliation received malformed status')
        return
      }
      const type = status.type
      if (type === 'busy' || type === 'retry') {
        state.status = 'running'
        return
      }
      if (type === 'idle') return
    } catch (err) {
      log.warn({
        ...logContext,
        err,
        reason: 'get_session_status_failed',
      }, 'opencode status reconciliation failed')
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
    state.unsubscribeServe = serveManager.subscribe(state.realSessionId, (parsed) => {
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
    })
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

  function emitMaterialized(state: OpencodeSessionState): void {
    if (!state.realSessionId) return
    state.events.emit('event', {
      type: 'freshAgent.session.materialized',
      previousSessionId: state.placeholderId,
      sessionId: state.realSessionId,
      sessionRef: { provider: 'opencode', sessionId: state.realSessionId },
    })
  }

  async function materializeOrSend(state: OpencodeSessionState, text: string, settings?: Partial<FreshAgentCreateRequest>): Promise<FreshAgentSendResult> {
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
      const idleRoute = cwdRoute(state.cwd)
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
    } catch (error) {
      emitStatus(state, 'idle')
      throw error
    }
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
        cwd: normalized.cwd,
        model: normalized.model,
        effort: normalized.effort,
        status: 'idle',
        events: new EventEmitter(),
        sendQueue: Promise.resolve(),
      }
      remember(state)
      return { sessionId: state.placeholderId, sessionRef: { provider: 'opencode', sessionId: state.placeholderId } }
    },

    async resume(input) {
      const normalized = normalizeOpencodeInput(input)
      const sessionId = normalized.resumeSessionId
      if (!sessionId) throw new Error('OpenCode resume requires a session id.')
      if (isPlaceholderOpencodeSessionId(sessionId)) {
        const real = await resolveLegacyPlaceholder(legacyReader(), normalized, sessionId)
        const state: OpencodeSessionState = {
          placeholderId: sessionId, realSessionId: real, cwd: normalized.cwd, model: normalized.model,
          effort: normalized.effort, status: 'idle', events: new EventEmitter(), sendQueue: Promise.resolve(),
        }
        remember(state)
        bindServeStream(state)
        await reconcileStatus(state)
        return { sessionId: real, sessionRef: { provider: 'opencode', sessionId: real } }
      }
      if (!isRealOpencodeSessionId(sessionId)) {
        throw new FreshAgentLostSessionError(`OpenCode session ${sessionId} is not a durable OpenCode session.`)
      }
      const state: OpencodeSessionState = {
        placeholderId: sessionId, realSessionId: sessionId, cwd: normalized.cwd, model: normalized.model,
        effort: normalized.effort, status: 'idle', events: new EventEmitter(), sendQueue: Promise.resolve(),
      }
      remember(state)
      bindServeStream(state)
      await reconcileStatus(state)
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
        await reconcileStatus(existing)
        return { sessionId: locator.sessionId, sessionRef: { provider: 'opencode', sessionId: locator.sessionId } }
      }
      if (isPlaceholderOpencodeSessionId(locator.sessionId) || !isRealOpencodeSessionId(locator.sessionId)) {
        throw new FreshAgentLostSessionError(`OpenCode session ${locator.sessionId} is not a durable OpenCode session.`)
      }
      const state: OpencodeSessionState = {
        placeholderId: locator.sessionId,
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
      await reconcileStatus(state)
      return { sessionId: locator.sessionId, sessionRef: { provider: 'opencode', sessionId: locator.sessionId } }
    },

    subscribe(sessionId, listener) {
      const state = requireState(sessionId)
      const handler = (event: unknown) => listener(event)
      state.events.on('event', handler)
      return () => state.events.off('event', handler)
    },

    async send(sessionId, input) {
      const state = requireState(sessionId)
      const run = state.sendQueue.then(
        () => materializeOrSend(state, input.text, input.settings),
        () => materializeOrSend(state, input.text, input.settings),
      )
      state.sendQueue = run.catch(() => undefined)
      return await run
    },

    async interrupt(sessionId) {
      const state = requireState(sessionId)
      // Mark before aborting so the in-flight send (parked on onceIdle) sees the abort and
      // suppresses its turn-complete chime when the abort-triggered idle resolves it.
      state.turnAborted = true
      try {
        await abortForState(state)
      } catch (error) {
        // The abort never landed, so the turn may still complete normally — clear the flag
        // so a genuine completion is not silently swallowed.
        state.turnAborted = false
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
      sessions.delete(state.placeholderId)
      if (state.realSessionId) sessions.delete(state.realSessionId)
      return true
    },

    async getSnapshot(thread) {
      const liveState = sessions.get(thread.threadId)
      if (liveState && !liveState.realSessionId) {
        return normalizeOpencodeSnapshot({
          sessionType: 'freshopencode', threadId: thread.threadId, status: liveState.status,
          model: liveState.model, effort: liveState.effort,
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
