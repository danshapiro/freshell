import { EventEmitter } from 'node:events'
import path from 'node:path'
import type {
  FreshAgentCreateRequest,
  FreshAgentRuntimeAdapter,
  FreshAgentSendResult,
  FreshAgentThreadLocator,
} from '../../runtime-adapter.js'
import { FreshAgentLostSessionError } from '../../runtime-manager.js'
import { normalizeFreshAgentEffort, normalizeFreshAgentModel } from '../../../../shared/fresh-agent-models.js'
import { logger } from '../../../logger.js'
import { defaultOpencodeDataHome } from '../../../coding-cli/providers/opencode.js'
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
  model?: string
  effort?: string
  status: string
  events: EventEmitter
  sendQueue: Promise<unknown>
  unsubscribeServe?: () => void
}

type CreateOpencodeFreshAgentAdapterOptions = {
  serveManager: OpencodeServeManager
  /** Retained ONLY for legacy `freshopencode-*` placeholder resume. */
  historyReader?: OpencodeHistoryReader
  dbPath?: string
  dataHome?: string
  turnTimeoutMs?: number
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

export function createOpencodeFreshAgentAdapter(options: CreateOpencodeFreshAgentAdapterOptions): FreshAgentRuntimeAdapter {
  const serveManager = options.serveManager
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
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

  /** Bridge serve SSE events for this state's real session into the state's
   * own EventEmitter, mapped to sdk.* and stamped with the placeholder id the
   * client first subscribed with. */
  function bindServeStream(state: OpencodeSessionState): void {
    if (state.unsubscribeServe || !state.realSessionId) return
    state.unsubscribeServe = serveManager.subscribe(state.realSessionId, (parsed) => {
      const mapped = serveEventToSdk(parsed, state.placeholderId)
      if (mapped) {
        if (mapped.type === 'sdk.session.snapshot') state.status = mapped.status === 'idle' ? 'idle' : 'running'
        state.events.emit('event', mapped)
      }
    })
  }

  async function materializeOrSend(state: OpencodeSessionState, text: string, settings?: Partial<FreshAgentCreateRequest>): Promise<FreshAgentSendResult> {
    const normalized = settings
      ? normalizeOpencodeInput({ requestId: state.placeholderId, sessionType: 'freshopencode', provider: 'opencode', ...settings } as FreshAgentCreateRequest)
      : undefined
    const modelStr = normalized?.model ?? state.model
    const effort = normalized?.effort ?? state.effort
    const effectiveCwd = normalized?.cwd ?? state.cwd

    if (!state.realSessionId) {
      const session = await serveManager.createSession({ title: undefined, ...(effectiveCwd ? { directory: effectiveCwd } : {}) })
      state.realSessionId = session.id
      if (typeof session.directory === 'string' && session.directory.length > 0) state.cwd = session.directory
      else if (effectiveCwd) state.cwd = effectiveCwd
      remember(state)
      bindServeStream(state)
    }

    const realId = state.realSessionId!
    state.status = 'running'
    state.events.emit('event', { type: 'sdk.session.snapshot', sessionId: state.placeholderId, status: 'running' })
    const idle = serveManager.onceIdle(realId, turnTimeoutMs)
    // If promptAsync fails and we leave via the catch(), `idle` may still
    // reject later on its timeout timer. Attach a no-op handler now so that
    // later rejection cannot become an unhandled rejection.
    void idle.catch(() => {})
    try {
      await serveManager.promptAsync(realId, {
        parts: [{ type: 'text', text }],
        ...(splitOpencodeModel(modelStr) ? { model: splitOpencodeModel(modelStr)! } : {}),
        ...(effort ? { variant: effort } : {}),
      })
      await idle
    } catch (error) {
      state.status = 'idle'
      state.events.emit('event', { type: 'sdk.session.snapshot', sessionId: state.placeholderId, status: 'idle' })
      throw error
    }
    state.model = modelStr ?? state.model
    state.effort = effort
    state.status = 'idle'
    state.events.emit('event', { type: 'sdk.session.snapshot', sessionId: state.placeholderId, status: 'idle' })
    return sendResult(state.realSessionId)
  }

  async function assembleExport(realSessionId: string, query: { limit?: number; before?: string }): Promise<{ exported: OpencodeExport; nextCursor: string | null; revision: number }> {
    const [session, page] = await Promise.all([
      serveManager.getSession(realSessionId).then(
        (session) => session,
        () => ({} as Record<string, unknown>),
      ),
      serveManager.listMessages(realSessionId, query),
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
      return { sessionId, sessionRef: { provider: 'opencode', sessionId } }
    },

    async attach(locator) {
      const existing = sessions.get(locator.sessionId)
      if (existing) { remember(existing); return { sessionId: locator.sessionId, sessionRef: { provider: 'opencode', sessionId: locator.sessionId } } }
      if (isPlaceholderOpencodeSessionId(locator.sessionId) || !isRealOpencodeSessionId(locator.sessionId)) {
        throw new FreshAgentLostSessionError(`OpenCode session ${locator.sessionId} is not a durable OpenCode session.`)
      }
      const state: OpencodeSessionState = {
        placeholderId: locator.sessionId, realSessionId: locator.sessionId, status: 'idle',
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
      if (state.realSessionId) await serveManager.abort(state.realSessionId).catch((err) => log.warn({ err }, 'abort failed'))
      state.status = 'idle'
      state.events.emit('event', { type: 'sdk.session.snapshot', sessionId: state.placeholderId, status: 'idle' })
    },

    async compact(sessionId, input) {
      const state = requireState(sessionId)
      if (!state.realSessionId) return
      const instructions = input?.instructions
      const hasInstructions = instructions !== undefined
      const run = state.sendQueue.then(
        () => (hasInstructions ? serveManager.compact(state.realSessionId!, { instructions }) : serveManager.compact(state.realSessionId!)),
        () => (hasInstructions ? serveManager.compact(state.realSessionId!, { instructions }) : serveManager.compact(state.realSessionId!)),
      )
      state.sendQueue = run.catch(() => undefined)
      await run
    },

    async fork(sessionId) {
      const state = requireState(sessionId)
      if (!state.realSessionId) throw new FreshAgentLostSessionError(`OpenCode session ${sessionId} has not materialized; cannot fork.`)
      const child = await serveManager.fork(state.realSessionId)
      const childState: OpencodeSessionState = {
        placeholderId: child.id,
        realSessionId: child.id,
        cwd: state.cwd,
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
      const { exported, revision } = await assembleExport(realId, { limit: DEFAULT_SNAPSHOT_TURN_LIMIT })
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
      const { exported, nextCursor, revision } = await assembleExport(realId, {
        limit: typeof query.limit === 'number' ? query.limit : DEFAULT_SNAPSHOT_TURN_LIMIT,
        before: typeof query.cursor === 'string' ? query.cursor : undefined,
      })
      return normalizeOpencodeTurnPage({ threadId: thread.threadId, exported, revision, nextCursor })
    },

    async getTurnBody(thread, revision) {
      const liveState = sessions.get(thread.threadId)
      if (liveState && !liveState.realSessionId) return null
      const realId = durableId(thread.threadId)
      const message = await serveManager.getMessage(realId, thread.turnId)
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
