import type { AppDispatch } from '@/store/store'
import type { FreshAgentRuntimeProvider, FreshAgentSessionType } from '@shared/fresh-agent'
import type { SessionRef } from '@shared/session-contract'
import type { FreshAgentRecoveryStoppedMessage, ReadyMessage, SessionRuntimeOwnerMessage } from '@shared/ws-protocol'
import { createLogger } from '@/lib/client-logger'
import { consumeCancelledCreate, consumeCreateRoute, rememberCreateRoute } from '@/lib/create-cancellation'
import { flushPersistedLayoutNow } from '@/store/persistControl'
import { KILL_FAILED_MESSAGE } from '@/lib/kill-ack'
import { materializeFreshAgentSession as materializeFreshAgentPaneSession } from '@/store/panesSlice'
import { applyFreshAgentCompletion, applyFreshAgentWaiting } from '@/store/turnCompletionThunks'
import { revokeFreshAgentAttention } from '@/store/turnCompletionAttention'
import type { ObservedOwnerFence } from '@/store/selectors/runtimeOwner'
import { streamBatcherFor } from '@/lib/fresh-agent-stream-batcher'
import type { LiveBlockKind, LiveNotice, LiveNoticeLevel, LiveRateLimit, LiveRetry, LiveStreamOp } from '@/store/freshAgentLiveTypes'
import { assistantBlockBound, liveNoticeReceived, liveRetrySet, transcriptAnnounced } from '@/store/freshAgentLiveSlice'
import {
  addPermissionRequest,
  addQuestionRequest,
  applyRuntimeOwner,
  clearPendingCreateFailure,
  createFailed,
  markSessionLost,
  materializeSession as materializeFreshAgentSessionState,
  removePermission,
  removeQuestion,
  removeSession,
  registerPendingCreate,
  resetRuntimeOwners,
  sessionError,
  sessionCreated,
  sessionExited,
  sessionInit,
  sessionMetadataReceived,
  sessionSnapshotReceived,
  setSessionStatus,
  streamOpened,
  turnResult,
} from '@/store/freshAgentSlice'

const log = createLogger('fresh-agent-ws')

type FreshAgentCreatedMessage = {
  type: 'freshAgent.created'
  requestId: string
  sessionId: string
  sessionType: FreshAgentSessionType
  provider?: FreshAgentRuntimeProvider
  runtimeProvider?: FreshAgentRuntimeProvider
}

type FreshAgentCreateFailedMessage = {
  type: 'freshAgent.create.failed'
  requestId: string
  code: string
  message: string
  retryable?: boolean
  /** kata b8ke: ownership-conflict refusals only — the owning kind, its
   *  generation, and the emitting server's boot epoch (Task 2 added the
   *  fields server-side; the fold PRESERVES them so the typed-conflict
   *  recovery UI can refresh its observed fence from the refusal itself). */
  ownerKind?: 'terminal' | 'fresh-agent'
  ownerGeneration?: number
  ownerEpoch?: number
}

type FreshAgentSessionMaterializedMessage = {
  type: 'freshAgent.session.materialized'
  previousSessionId: string
  sessionId: string
  sessionType: FreshAgentSessionType
  provider: FreshAgentRuntimeProvider
  sessionRef?: SessionRef
}

type FreshAgentKilledMessage = {
  type: 'freshAgent.killed'
  sessionId: string
  sessionType: FreshAgentSessionType
  provider: FreshAgentRuntimeProvider
  success: boolean
  /** b8ke focused FR9: the typed refusal code when success is false (e.g.
   *  INVALID_FENCE for a half-sent observed fence pair) — additive and
   *  optional (legacy servers never send it). */
  code?: string
  /** The typed refusal's human-readable message (rides with code). */
  message?: string
}

type FreshAgentClientMessage =
  | FreshAgentCreatedMessage
  | FreshAgentCreateFailedMessage
  | FreshAgentSessionMaterializedMessage
  | FreshAgentKilledMessage
  | FreshAgentRecoveryStoppedMessage

interface FreshAgentMessageSink {
  send: (msg: unknown) => void
}

/**
 * Delta-r6-r2 (focused-episode-6 round 1, Finding 5): the kill answer's
 * `success` field is load-bearing. The server's durable close FAILED
 * (`success:false`) — every provider then leaves the LIVE session untouched
 * (the close was never recorded; a `Bound` row beside an unacknowledged
 * close stays self-consistent and retryable). Folding the session away as
 * closed would let the browser proceed as though the kill landed — leaving
 * a live Bound server session that recreates exactly the stale recovery
 * candidate the restore-exactness campaign exists to prevent. So a failed
 * kill is NOT a close: keep the session record and surface the failure on
 * the pane's ordinary session-error surface (the pane's error banner reads
 * `lastError`/`lastErrorCode`), logged structured. `success` absent (the
 * legacy wire shape) means the old unconditional-close server — current
 * behavior.
 */
function foldFreshAgentKilled(
  dispatch: AppDispatch,
  locator: { sessionId: string; sessionType: FreshAgentSessionType; provider: FreshAgentRuntimeProvider },
  success: boolean | undefined,
  code?: string,
  message?: string,
): void {
  if (success === false) {
    log.warn('freshAgent.killed reported success:false — the close was not durably recorded; the session may still be running on the server', {
      sessionId: locator.sessionId,
      sessionType: locator.sessionType,
      provider: locator.provider,
      code: code ?? 'KILL_FAILED',
    })
    dispatch(sessionError({
      ...locator,
      // b8ke focused FR9: a typed refusal code from the server (e.g.
      // INVALID_FENCE) reduces HERE — only the code-less legacy shape keeps
      // the generic KILL_FAILED default.
      code: code ?? 'KILL_FAILED',
      message: message ?? KILL_FAILED_MESSAGE, // one copy for both writers (see kill-ack.ts)
    }))
    return
  }
  dispatch(removeSession(locator))
}

type FreshAgentEventMessage = {
  type: 'freshAgent.event'
  sessionId: string
  sessionType: FreshAgentSessionType
  provider: FreshAgentRuntimeProvider
  event: Record<string, unknown>
}

export function registerFreshAgentCreate(
  dispatch: AppDispatch,
  requestId: string,
  options: {
    resumeSessionId?: string
    sessionRef?: SessionRef
    sessionType: FreshAgentSessionType
    provider: FreshAgentRuntimeProvider
    cwd?: string
  },
): void {
  rememberCreateRoute(requestId, { cwd: options.cwd })
  dispatch(registerPendingCreate({
    requestId,
    sessionType: options.sessionType,
    provider: options.provider,
    cwd: options.cwd,
    expectsHistoryHydration: Boolean(options.resumeSessionId || options.sessionRef),
  }))
  dispatch(clearPendingCreateFailure({ requestId }))
}

export function handleFreshAgentMessage(
  dispatch: AppDispatch,
  msg: Record<string, unknown>,
  ws?: FreshAgentMessageSink,
  getOwnerFence?: (provider: string, sessionId: string) => ObservedOwnerFence | undefined,
): boolean {
  switch (msg.type) {
    case 'freshAgent.created': {
      const created = msg as FreshAgentCreatedMessage
      const provider = created.provider ?? created.runtimeProvider
      const route = consumeCreateRoute(created.requestId)
      if (consumeCancelledCreate(created.requestId)) {
        if (provider) {
          // kata b8ke (round-3 F6): the cleanup kill is a lifecycle
          // producer — it carries the observed (epoch, generation) fence so
          // a stale callback can never issue an unfenced kill (no known
          // record means legacy-unfenced; the server falls back to its
          // retained stamp).
          const fence = getOwnerFence?.(provider, created.sessionId)
          ws?.send({
            type: 'freshAgent.kill',
            sessionId: created.sessionId,
            sessionType: created.sessionType,
            provider,
            ...(route?.cwd ? { cwd: route.cwd } : {}),
            ...(fence ? { observedEpoch: fence.epoch, observedGeneration: fence.generation } : {}),
          })
        }
        return true
      }
      dispatch(sessionCreated({
        requestId: created.requestId,
        sessionId: created.sessionId,
        sessionType: created.sessionType,
        provider,
      }))
      return true
    }
    case 'freshAgent.create.failed': {
      const failed = msg as FreshAgentCreateFailedMessage
      if (failed.code === 'SESSION_RESERVED' && failed.retryable) {
        // Task 14: transient reservation -- no pendingCreateFailures entry (no
        // error card / no Retry racing the same-requestId re-drive), and the
        // create route stays alive so the re-driven create's eventual
        // created/failed still routes to this pane. The pane-level handler in
        // FreshAgentView owns the bounded re-drive.
        return true
      }
      consumeCreateRoute(failed.requestId)
      dispatch(createFailed({
        requestId: failed.requestId,
        code: failed.code,
        message: failed.message,
        retryable: failed.retryable,
        ...(failed.ownerKind !== undefined ? { ownerKind: failed.ownerKind } : {}),
        ...(failed.ownerGeneration !== undefined ? { ownerGeneration: failed.ownerGeneration } : {}),
        ...(failed.ownerEpoch !== undefined ? { ownerEpoch: failed.ownerEpoch } : {}),
      }))
      return true
    }
    case 'freshAgent.session.materialized': {
      const materialized = msg as FreshAgentSessionMaterializedMessage
      // Stream events queued under the old id land before the re-key moves them.
      streamBatcherFor(dispatch).flush({
        sessionId: materialized.previousSessionId,
        sessionType: materialized.sessionType,
        provider: materialized.provider,
      })
      dispatch(materializeFreshAgentSessionState({
        previousSessionId: materialized.previousSessionId,
        sessionId: materialized.sessionId,
        sessionType: materialized.sessionType,
        provider: materialized.provider,
      }))
      dispatch(materializeFreshAgentPaneSession({
        previousSessionId: materialized.previousSessionId,
        sessionId: materialized.sessionId,
        sessionType: materialized.sessionType,
        provider: materialized.provider,
        sessionRef: materialized.sessionRef ?? {
          provider: materialized.provider,
          sessionId: materialized.sessionId,
        },
      }))
      dispatch(flushPersistedLayoutNow())
      return true
    }
    case 'freshAgent.killed': {
      const killed = msg as FreshAgentKilledMessage
      streamBatcherFor(dispatch).flush({
        sessionId: killed.sessionId,
        sessionType: killed.sessionType,
        provider: killed.provider,
      })
      foldFreshAgentKilled(dispatch, {
        sessionId: killed.sessionId,
        sessionType: killed.sessionType,
        provider: killed.provider,
      }, killed.success, killed.code, killed.message)
      return true
    }
    case 'freshAgent.recovery.stopped': {
      const stopped = msg as FreshAgentRecoveryStoppedMessage
      if (stopped.success) {
        dispatch(removeSession({
          sessionId: stopped.sessionId,
          sessionType: stopped.sessionType,
          provider: stopped.provider,
        }))
      }
      return true
    }
    case 'freshAgent.event':
      return handleFreshAgentTransportEvent(dispatch, msg as FreshAgentEventMessage)
    default:
      return false
  }
}

/**
 * kata b8ke: fold ONE `session.runtimeOwner` broadcast frame into the
 * runtimeOwners store (the App message-chain case — session.runtimeOwner
 * is not a freshAgent.* frame, so it is folded explicitly ahead of the
 * handleFreshAgentMessage catch-all). The reducer is epoch-aware
 * generation-monotonic, so interleaved broadcast/replay folding is safe.
 */
export function foldSessionRuntimeOwnerFrame(
  dispatch: AppDispatch,
  msg: SessionRuntimeOwnerMessage,
): void {
  dispatch(applyRuntimeOwner(msg))
}

/**
 * kata b8ke (reconnect owner discovery, round-1 T1 rec A4): the App ready
 * fold. Resets the client's runtime-owner state FIRST (round-2 review: the
 * owner/generation state is server-authoritative per connection lifetime —
 * a restarted server's newer generations must never be ignored in favor
 * of stale pre-reconnect records), THEN folds every ready.runtimeOwners
 * entry. App calls this BEFORE the pane-reconcile request is built and
 * sent, so a device that missed the handoff broadcast (offline during
 * handoff, lag-4008, page reload) converges on its very first
 * post-reconnect reconcile.
 *
 * b8ke focused round-3 R3-5: a FENCED replay record folds truthfully —
 * the typed recovery state (handoff-failed + the typed reason, plus the
 * fenced marker the divergence/recovery UI derives from) — never a false
 * "handoff-committed" owner.
 *
 * b8ke focused round-4 R4-6: an IN-PROGRESS lifecycle replay
 * (state 'starting' | 'handoff' | 'stopping') folds as the transition
 * state ('handoff-started' — the existing Task 8 semantics: no attach
 * action, no polling resume), never as committed live ownership.
 */
export function foldReadyRuntimeOwners(
  dispatch: AppDispatch,
  owners: ReadyMessage['runtimeOwners'],
): void {
  dispatch(resetRuntimeOwners())
  for (const owner of owners ?? []) {
    const fenced = owner.state === 'fenced'
    const inProgress = owner.state === 'starting'
      || owner.state === 'handoff'
      || owner.state === 'stopping'
    dispatch(applyRuntimeOwner({
      type: 'session.runtimeOwner',
      provider: owner.provider,
      sessionId: owner.sessionId,
      epoch: owner.epoch,
      generation: owner.generation,
      ownerKind: owner.ownerKind,
      ...(owner.terminalId !== undefined ? { terminalId: owner.terminalId } : {}),
      ...(owner.aliasOf !== undefined ? { aliasOf: owner.aliasOf } : {}),
      operationId: 'ready-replay',
      transition: fenced
        ? 'handoff-failed'
        : inProgress
          ? 'handoff-started'
          : owner.ownerKind === 'vacant' ? 'released' : 'handoff-committed',
      ...(fenced ? {
        reason: owner.reason ?? 'fenced',
        fenced: true,
      } : {}),
    }))
  }
}

const LIVE_BLOCK_KINDS: ReadonlySet<string> = new Set<LiveBlockKind>(['text', 'thinking', 'tool_use'])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The part of a `freshAgent.stream` frame the live tail renders: a text,
 * thinking or tool block opening, or a text/thinking delta, of the main
 * thread (the sidecar already drops subagent events; a frame that still
 * names a parent tool use is ignored). Anything else maps to nothing.
 */
function hasParentToolUse(frame: Record<string, unknown>): boolean {
  return typeof frame.parentToolUseId === 'string' && frame.parentToolUseId.length > 0
}

/** A `freshAgent.retry` frame (the sidecar's `sdk.retry`), or nothing if it is malformed. */
function parseLiveRetry(frame: Record<string, unknown>): LiveRetry | undefined {
  if (typeof frame.attempt !== 'number' || !Number.isInteger(frame.attempt) || frame.attempt < 1) return undefined
  const optionalNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
  const maxRetries = optionalNumber(frame.maxRetries)
  const delayMs = optionalNumber(frame.delayMs)
  const errorStatus = frame.errorStatus === null ? null : optionalNumber(frame.errorStatus)
  return {
    attempt: frame.attempt,
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    ...(delayMs !== undefined ? { delayMs } : {}),
    ...(errorStatus !== undefined ? { errorStatus } : {}),
    ...(typeof frame.error === 'string' && frame.error ? { error: frame.error } : {}),
  }
}

const NOTICE_LEVELS: ReadonlySet<string> = new Set<LiveNoticeLevel>(['info', 'warning', 'error'])

/** A `freshAgent.notice` frame (the sidecar's `sdk.notice`), or nothing if it is malformed. */
function parseLiveNotice(frame: Record<string, unknown>): Omit<LiveNotice, 'seq'> | undefined {
  if (typeof frame.code !== 'string' || !frame.code) return undefined
  if (typeof frame.message !== 'string' || !frame.message.trim()) return undefined
  const level = typeof frame.level === 'string' && NOTICE_LEVELS.has(frame.level) ? frame.level as LiveNoticeLevel : 'info'
  let rateLimit: LiveRateLimit | undefined
  if (isObject(frame.rateLimit)) {
    const limit = frame.rateLimit
    rateLimit = {
      ...(typeof limit.status === 'string' ? { status: limit.status } : {}),
      ...(typeof limit.resetsAt === 'number' && Number.isFinite(limit.resetsAt) ? { resetsAt: limit.resetsAt } : {}),
      ...(typeof limit.rateLimitType === 'string' ? { rateLimitType: limit.rateLimitType } : {}),
      ...(typeof limit.utilization === 'number' && Number.isFinite(limit.utilization) ? { utilization: limit.utilization } : {}),
    }
  }
  return { level, code: frame.code, message: frame.message.trim(), ...(rateLimit ? { rateLimit } : {}) }
}

function parseLiveStreamOp(frame: Record<string, unknown>): LiveStreamOp | undefined {
  if (hasParentToolUse(frame)) return undefined
  const event = frame.event
  if (!isObject(event) || typeof event.index !== 'number') return undefined
  const messageId = typeof frame.messageId === 'string' && frame.messageId ? frame.messageId : null
  const index = event.index
  if (event.type === 'content_block_start') {
    const block = event.content_block
    if (!isObject(block) || typeof block.type !== 'string' || !LIVE_BLOCK_KINDS.has(block.type)) return undefined
    const kind = block.type as LiveBlockKind
    if (kind === 'tool_use') {
      return {
        op: 'start',
        messageId,
        index,
        kind,
        ...(typeof block.name === 'string' ? { name: block.name } : {}),
        ...(typeof block.id === 'string' ? { toolUseId: block.id } : {}),
      }
    }
    return { op: 'start', messageId, index, kind }
  }
  if (event.type === 'content_block_delta' && isObject(event.delta)) {
    const delta = event.delta
    const text = delta.type === 'text_delta' ? delta.text : delta.type === 'thinking_delta' ? delta.thinking : undefined
    if (typeof text !== 'string' || text.length === 0) return undefined
    return { op: 'delta', messageId, index, text }
  }
  return undefined
}

export function handleFreshAgentTransportEvent(dispatch: AppDispatch, msg: FreshAgentEventMessage): boolean {
  const event = msg.event
  const sessionId = typeof msg.sessionId === 'string'
    ? msg.sessionId
    : (typeof event.sessionId === 'string' ? event.sessionId : undefined)
  if (!sessionId || typeof event?.type !== 'string') return false

  const locator = {
    sessionId,
    sessionType: msg.sessionType,
    provider: msg.provider,
  }

  // Stream events are batched; every other event of the session first
  // applies the ones still waiting, so the store sees them in arrival order.
  if (event.type !== 'freshAgent.stream') streamBatcherFor(dispatch).flush(locator)

  switch (event.type) {
    case 'freshAgent.session.snapshot':
      dispatch(sessionSnapshotReceived({
        ...locator,
        latestTurnId: (event.latestTurnId as string | null | undefined) ?? null,
        status: event.status as never,
        historySessionId: event.timelineSessionId as string | undefined,
        revision: event.revision as number | undefined,
        streamingActive: event.streamingActive as boolean | undefined,
      }))
      return true
    case 'freshAgent.session.changed':
      // A main-thread transcript line is on its way: the pane's landing check
      // expects it in a snapshot (a subagent's lines refresh its delegation).
      if (event.reason === 'transcript' && typeof event.uuid === 'string' && event.uuid && !hasParentToolUse(event)) {
        dispatch(transcriptAnnounced({ ...locator, uuid: event.uuid }))
      }
      return true
    case 'freshAgent.session.init':
      dispatch(sessionInit({
        ...locator,
        cliSessionId: event.cliSessionId as string | undefined,
        model: event.model as string | null | undefined,
        effort: event.effort as string | null | undefined,
        cwd: event.cwd as string | undefined,
        tools: event.tools as Array<{ name: string }> | undefined,
      }))
      return true
    case 'freshAgent.session.metadata':
      dispatch(sessionMetadataReceived({
        ...locator,
        cliSessionId: event.cliSessionId as string | undefined,
        model: event.model as string | null | undefined,
        effort: event.effort as string | null | undefined,
        // Absent = no statement (as for model/effort); only a mode name states one.
        ...(typeof event.permissionMode === 'string' && event.permissionMode ? { permissionMode: event.permissionMode } : {}),
        cwd: event.cwd as string | undefined,
        tools: event.tools as Array<{ name: string }> | undefined,
      }))
      return true
    case 'freshAgent.status':
      dispatch(setSessionStatus({
        ...locator,
        status: event.status as never,
      }))
      return true
    case 'freshAgent.turn.complete': {
      // The server always stamps a monotonic numeric `at`. Drop a malformed event rather
      // than fabricating a client `Date.now()`, which could collide with or regress against
      // the server clock and swallow a real later completion (or spuriously green).
      if (typeof event.at !== 'number' || !Number.isFinite(event.at)) {
        log.warn('dropping malformed freshAgent.turn.complete without a numeric at', { sessionId, at: event.at })
        return true
      }
      dispatch(applyFreshAgentCompletion({
        provider: locator.provider,
        sessionId,
        at: event.at,
      }))
      return true
    }
    case 'freshAgent.turn.waiting': {
      if (typeof event.at !== 'number' || !Number.isFinite(event.at)) {
        log.warn('dropping malformed freshAgent.turn.waiting without a numeric at', { sessionId, at: event.at })
        return true
      }
      dispatch(applyFreshAgentWaiting({
        provider: locator.provider,
        sessionId,
        at: event.at,
      }))
      return true
    }
    case 'freshAgent.assistant':
      // Durable content comes from the snapshot (transcript-live P1). The
      // message only names the transcript line its streamed block becomes
      // (the pending stream events were applied above).
      if (typeof event.uuid === 'string' && event.uuid && !hasParentToolUse(event) && Array.isArray(event.content)) {
        dispatch(assistantBlockBound({
          ...locator,
          uuid: event.uuid,
          ...(typeof event.messageId === 'string' && event.messageId ? { messageId: event.messageId } : {}),
          content: event.content.filter(isObject),
        }))
      }
      return true
    case 'freshAgent.retry': {
      const retry = parseLiveRetry(event)
      if (retry) dispatch(liveRetrySet({ ...locator, ...retry }))
      return true
    }
    case 'freshAgent.notice': {
      // Non-terminal (P4): a notice is shown, never folded into the error path.
      const notice = parseLiveNotice(event)
      if (notice) dispatch(liveNoticeReceived({ ...locator, ...notice }))
      else log.warn('dropping malformed freshAgent.notice', { sessionId, code: event.code })
      return true
    }
    case 'freshAgent.stream': {
      const op = parseLiveStreamOp(event)
      if (!op) return true
      // The first block of a turn marks the session streaming (busy) at once;
      // the block's text follows with the next batch.
      if (op.op === 'start') dispatch(streamOpened(locator))
      streamBatcherFor(dispatch).enqueue(locator, op)
      return true
    }
    case 'freshAgent.result':
      dispatch(turnResult({
        ...locator,
        costUsd: event.costUsd as number | undefined,
        durationMs: event.durationMs as number | undefined,
        usage: event.usage as { input_tokens?: number; output_tokens?: number } | undefined,
      }))
      return true
    case 'freshAgent.rolledBack':
    case 'freshAgent.redone':
      // kata 1wxv requesting-sink ack: consumed by the initiating pane's own ws
      // subscriber (FreshAgentView — composer refill + refill notice). Redux state
      // rehydrates from the snapshot these events invalidate; nothing to write here.
      return true
    case 'freshAgent.session.rolledBack': {
      // Decision 10: an undone done is not done — revoke green/attention on EVERY
      // device (the initiating pane included). Never touches recordTurnComplete.
      // The thunk is pane-scoped: tab-level green re-derives as the OR over the
      // tab's REMAINING panes (r3 correction 7).
      dispatch(revokeFreshAgentAttention(`${locator.provider}:${sessionId}`))
      return true
    }
    case 'freshAgent.session.redone':
      // Sibling-convergence broadcast; the invalidating snapshot carries the state.
      return true
    case 'freshAgent.permission.request': {
      const tool = event.tool as { name?: string; input?: Record<string, unknown> } | undefined
      dispatch(addPermissionRequest({
        ...locator,
        requestId: event.requestId as string,
        toolName: tool?.name,
        input: tool?.input,
        providerRequest: {
          subtype: event.subtype,
          tool,
        },
      }))
      return true
    }
    case 'freshAgent.permission.cancelled':
      dispatch(removePermission({
        ...locator,
        requestId: event.requestId as string,
      }))
      return true
    case 'freshAgent.question.request':
      dispatch(addQuestionRequest({
        ...locator,
        requestId: event.requestId as string,
        questions: event.questions as never,
        providerRequest: event,
      }))
      return true
    case 'freshAgent.question.cancelled':
      // Provider-originated cancellation: the Rust claude/kilroy slice forwards
      // the sidecar's question-cancel edge as this event type. Clear the card
      // without inventing a user decision.
      dispatch(removeQuestion({
        ...locator,
        requestId: event.requestId as string,
      }))
      return true
    case 'freshAgent.exit':
      dispatch(sessionExited(locator))
      return true
    case 'freshAgent.error':
      if (event.code === 'INVALID_SESSION_ID') {
        dispatch(markSessionLost(locator))
      } else if (event.rollback === true) {
        // kata 1wxv: rollback rejections route to the initiating pane's notice
        // banner via the view's own ws subscriber (matched on requestId) —
        // never the pane error surface.
        return true
      } else {
        dispatch(sessionError({
          ...locator,
          code: event.code as string | undefined,
          message: (event.message as string) || (event.error as string) || 'Unknown error',
        }))
      }
      return true
    case 'freshAgent.killed':
      foldFreshAgentKilled(
        dispatch,
        locator,
        event.success as boolean | undefined,
        event.code as string | undefined,
        event.message as string | undefined,
      )
      return true
    default:
      return false
  }
}

export type {
  FreshAgentClientMessage,
  FreshAgentCreatedMessage,
  FreshAgentCreateFailedMessage,
  FreshAgentEventMessage,
  FreshAgentSessionMaterializedMessage,
}
