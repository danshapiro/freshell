import { EventEmitter } from 'node:events'
import { stat } from 'node:fs/promises'
import type {
  FreshAgentCreateRequest,
  FreshAgentRuntimeAdapter,
  FreshAgentSendResult,
  FreshAgentThreadLocator,
} from '../../runtime-adapter.js'
import { FreshAgentLostSessionError, FreshAgentStaleThreadRevisionError } from '../../runtime-manager.js'
import { normalizeFreshAgentEffort, normalizeFreshAgentModel } from '../../../../shared/fresh-agent-models.js'
import { logger } from '../../../logger.js'
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
import type { OpencodeServeManager } from './serve-manager.js'
import { serveEventToSdk, splitOpencodeModel } from './serve-events.js'

const OPENCODE_REAL_SESSION_ID = /^ses_/
const OPENCODE_PLACEHOLDER_SESSION_ID = /^freshopencode-/
const DEFAULT_SNAPSHOT_TURN_LIMIT = 200
const DEFAULT_TURN_TIMEOUT_MS = 600_000

type OpencodeSessionState = {
  placeholderId: string
  realSessionId?: string
  cwd?: string
  model?: string
  effort?: string
  status: string
  events: EventEmitter
  sendQueue: Promise<unknown>
  unsubscribeServe?: () => void
}

type CreateOpencodeFreshAgentAdapterOptions = {
  serveManager: OpencodeServeManager
  turnTimeoutMs?: number
  validateCwd?: (cwd: string) => Promise<void>
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
    const route = cwdRoute(state.cwd)
    if (route) {
      await serveManager.abort(state.realSessionId, route)
      return
    }
    await serveManager.abort(state.realSessionId)
  }

  async function compactForState(state: OpencodeSessionState, input?: { instructions?: string }): Promise<void> {
    if (!state.realSessionId) return
    const route = cwdRoute(state.cwd)
    if (route) {
      await serveManager.compact(state.realSessionId, input, route)
      return
    }
    if (input) {
      await serveManager.compact(state.realSessionId, input)
      return
    }
    await serveManager.compact(state.realSessionId)
  }

  async function forkForState(state: OpencodeSessionState): Promise<{ id: string; directory?: string }> {
    if (!state.realSessionId) {
      throw new FreshAgentLostSessionError(`OpenCode session ${state.placeholderId} has not materialized; cannot fork.`)
    }
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

    emitStatus(state, 'running')
    try {
      if (!state.realSessionId) {
        if (effectiveCwd) await validateCwd(effectiveCwd)
        const session = await serveManager.createSession({ title: undefined, ...(effectiveCwd ? { directory: effectiveCwd } : {}) })
        state.realSessionId = session.id
        if (typeof session.directory === 'string' && session.directory.length > 0) state.cwd = session.directory
        else if (effectiveCwd) state.cwd = effectiveCwd
        remember(state)
        bindServeStream(state)
        emitMaterialized(state)
      }

      const realId = state.realSessionId!
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
        throw new FreshAgentLostSessionError(`OpenCode session ${sessionId} is a temporary Freshopencode id. Restore requires a durable OpenCode session id that starts with ses_.`)
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
      return { sessionId, sessionRef: { provider: 'opencode', sessionId } }
    },

    async attach(locator) {
      const existing = sessions.get(locator.sessionId)
      if (existing) {
        if (locator.cwd) {
          existing.cwd = locator.cwd
        }
        remember(existing)
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
      remember(state)
      bindServeStream(state)
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
      await abortForState(state).catch((err) => log.warn({ err }, 'abort failed'))
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

    kill(sessionId) {
      const state = requireState(sessionId)
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
      if (typeof query.revision === 'number' && query.revision !== revision) {
        throw new FreshAgentStaleThreadRevisionError(revision)
      }
      return normalizeOpencodeTurnPage({
        threadId: thread.threadId,
        exported,
        revision,
        nextCursor,
        includeBodies: query.includeBodies === true,
      })
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
