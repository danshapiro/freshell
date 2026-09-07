import type { AppDispatch } from '@/store/store'
import { makeFreshAgentSessionKey, type FreshAgentRuntimeProvider, type FreshAgentSessionType } from '@shared/fresh-agent'
import type { SessionRef } from '@shared/session-contract'
import type { RuntimeDescriptor } from '@shared/ws-protocol'
import { createLogger } from '@/lib/client-logger'
import { collectPaneContents } from '@/lib/pane-utils'
import type { PaneNode } from '@/store/paneTypes'
import { consumeCancelledCreate, consumeCreateRoute, rememberCreateRoute } from '@/lib/create-cancellation'
import { flushPersistedLayoutNow } from '@/store/persistControl'
import { KILL_FAILED_MESSAGE } from '@/lib/kill-ack'
import { materializeFreshAgentSession as materializeFreshAgentPaneSession } from '@/store/panesSlice'
import { applyFreshAgentCompletion, applyFreshAgentWaiting } from '@/store/turnCompletionThunks'
import { revokeFreshAgentAttention } from '@/store/turnCompletionAttention'
import {
  addAssistantMessage,
  addPermissionRequest,
  addQuestionRequest,
  appendStreamDelta,
  clearPendingCreateFailure,
  createFailed,
  markSessionLost,
  materializeSession as materializeFreshAgentSessionState,
  removePermission,
  removeQuestion,
  removeSession,
  registerPendingCreate,
  sessionError,
  sessionCreated,
  sessionExited,
  sessionInit,
  sessionMetadataReceived,
  sessionSnapshotReceived,
  setSessionStatus,
  setStreaming,
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
  runtime?: RuntimeDescriptor
}

type FreshAgentCreateFailedMessage = {
  type: 'freshAgent.create.failed'
  requestId: string
  code: string
  message: string
  retryable?: boolean
}

type FreshAgentSessionMaterializedMessage = {
  type: 'freshAgent.session.materialized'
  previousSessionId: string
  sessionId: string
  sessionType: FreshAgentSessionType
  provider: FreshAgentRuntimeProvider
  sessionRef?: SessionRef
  runtime?: RuntimeDescriptor
}

type FreshAgentKilledMessage = {
  type: 'freshAgent.killed'
  sessionId: string
  sessionType: FreshAgentSessionType
  provider: FreshAgentRuntimeProvider
  success: boolean
  runtime?: RuntimeDescriptor
}

type FreshAgentClientMessage =
  | FreshAgentCreatedMessage
  | FreshAgentCreateFailedMessage
  | FreshAgentSessionMaterializedMessage
  | FreshAgentKilledMessage

interface FreshAgentMessageSink {
  send: (msg: unknown) => void
}

/** The minimal live store projection required to validate transport fences. */
export type FreshAgentTransportState = {
  freshAgent?: {
    sessions?: Record<string, {
      runtimeId?: string
      runtimeGeneration?: number
    }>
  }
  panes?: {
    layouts?: Record<string, PaneNode | undefined>
  }
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
  locator: { sessionId: string; sessionType: FreshAgentSessionType; provider: FreshAgentRuntimeProvider; runtime?: RuntimeDescriptor },
  success: boolean | undefined,
): void {
  if (success === false) {
    log.warn('freshAgent.killed reported success:false — the close was not durably recorded; the session may still be running on the server', {
      sessionId: locator.sessionId,
      sessionType: locator.sessionType,
      provider: locator.provider,
    })
    dispatch(sessionError({
      ...locator,
      code: 'KILL_FAILED',
      message: KILL_FAILED_MESSAGE, // one copy for both writers (see kill-ack.ts)
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
  runtime?: RuntimeDescriptor
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
  getState?: () => FreshAgentTransportState,
): boolean {
  switch (msg.type) {
    case 'freshAgent.created': {
      const created = msg as FreshAgentCreatedMessage
      if (!isFreshAgentLifecycleMessageCurrent(created, getState?.())) return true
      const provider = created.provider ?? created.runtimeProvider
      const route = consumeCreateRoute(created.requestId)
      if (consumeCancelledCreate(created.requestId)) {
        if (provider) {
          ws?.send({
            type: 'freshAgent.kill',
            sessionId: created.sessionId,
            sessionType: created.sessionType,
            provider,
            ...(created.runtime ? {
              expectedRuntimeId: created.runtime.runtimeId,
              expectedGeneration: created.runtime.generation,
            } : {}),
            ...(route?.cwd ? { cwd: route.cwd } : {}),
          })
        }
        return true
      }
      dispatch(sessionCreated({
        requestId: created.requestId,
        sessionId: created.sessionId,
        sessionType: created.sessionType,
        provider,
        runtime: created.runtime,
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
      }))
      return true
    }
    case 'freshAgent.session.materialized': {
      const materialized = msg as FreshAgentSessionMaterializedMessage
      if (!isFreshAgentLifecycleMessageCurrent(materialized, getState?.())) return true
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
      // Restart fence first: a stale-runtime kill frame must not fold the
      // live generation away. Then the kill-ack: a failed durable close is
      // not a close (foldFreshAgentKilled keeps the session on success:false).
      if (!isFreshAgentKilledMessageCurrent(killed, getState?.())) return true
      foldFreshAgentKilled(dispatch, {
        sessionId: killed.sessionId,
        sessionType: killed.sessionType,
        provider: killed.provider,
        runtime: killed.runtime,
      }, killed.success)
      return true
    }
    case 'freshAgent.event':
      // Reducers guard their own stored runtime too, but this is the only
      // boundary that can see a pane fence before an event creates/mutates a
      // session. Completion/waiting events mutate a separate activity slice,
      // so they must be stopped here as well.
      if (!isFreshAgentTransportEventCurrent(msg as FreshAgentEventMessage, getState?.())) {
        return true
      }
      return handleFreshAgentTransportEvent(dispatch, msg as FreshAgentEventMessage)
    default:
      return false
  }
}

function isFreshAgentKilledMessageCurrent(
  msg: FreshAgentKilledMessage,
  state: FreshAgentTransportState | undefined,
): boolean {
  if (!state) return true

  const fences: Array<{ runtimeId?: string, runtimeGeneration?: number }> = []
  const session = state.freshAgent?.sessions?.[makeFreshAgentSessionKey({
    sessionId: msg.sessionId,
    sessionType: msg.sessionType,
    provider: msg.provider,
  })]
  if (session && isRuntimeFenced(session)) fences.push(session)

  for (const layout of Object.values(state.panes?.layouts ?? {})) {
    if (!layout) continue
    for (const content of collectPaneContents(layout)) {
      if (
        content.kind === 'fresh-agent'
        && content.sessionId === msg.sessionId
        && content.sessionType === msg.sessionType
        && content.provider === msg.provider
        && isRuntimeFenced(content)
      ) {
        fences.push(content)
      }
    }
  }

  return fences.every((fence) => matchesRuntimeFence(msg.runtime, fence))
}

function isRuntimeFenced(value: { runtimeId?: string, runtimeGeneration?: number }): boolean {
  return typeof value.runtimeId === 'string' && Number.isFinite(value.runtimeGeneration)
}

function matchesRuntimeFence(runtime: RuntimeDescriptor | undefined, fence: { runtimeId?: string, runtimeGeneration?: number }): boolean {
  return runtime?.runtimeId === fence.runtimeId && runtime?.generation === fence.runtimeGeneration
}

/**
 * Lifecycle acknowledgements mutate before a session event can reach the
 * reducer fence. Resolve the pane/session they target first, then require the
 * same exact descriptor as ordinary transport frames once that target is
 * fenced. This keeps delayed create/materialize acknowledgements from
 * resurrecting an old runtime after a restart replacement.
 */
function isFreshAgentLifecycleMessageCurrent(
  msg: FreshAgentCreatedMessage | FreshAgentSessionMaterializedMessage,
  state: FreshAgentTransportState | undefined,
): boolean {
  if (!state) return true

  const fences: Array<{ runtimeId?: string, runtimeGeneration?: number }> = []
  const targetSessionId = msg.type === 'freshAgent.session.materialized'
    ? msg.previousSessionId
    : undefined
  const provider = msg.type === 'freshAgent.created'
    ? (msg.provider ?? msg.runtimeProvider)
    : msg.provider

  if (targetSessionId && provider) {
    const session = state.freshAgent?.sessions?.[makeFreshAgentSessionKey({
      sessionId: targetSessionId,
      sessionType: msg.sessionType,
      provider,
    })]
    if (session && isRuntimeFenced(session)) fences.push(session)
  }

  for (const layout of Object.values(state.panes?.layouts ?? {})) {
    if (!layout) continue
    for (const content of collectPaneContents(layout)) {
      if (content.kind !== 'fresh-agent' || !isRuntimeFenced(content)) continue
      const targetsCreatedPane = msg.type === 'freshAgent.created'
        && content.createRequestId === msg.requestId
      const targetsMaterializedPane = msg.type === 'freshAgent.session.materialized'
        && content.sessionId === msg.previousSessionId
        && content.sessionType === msg.sessionType
        && content.provider === msg.provider
      if (targetsCreatedPane || targetsMaterializedPane) fences.push(content)
    }
  }

  return fences.every((fence) => matchesRuntimeFence(msg.runtime, fence))
}

/**
 * A durable fresh-agent session id survives restarts; it is never sufficient
 * to authorize a transport frame once the pane/session has a live runtime
 * descriptor. Missing runtime metadata is therefore stale, not legacy-safe.
 */
export function isFreshAgentTransportEventCurrent(
  msg: FreshAgentEventMessage,
  state: FreshAgentTransportState | undefined,
): boolean {
  if (!state) return true

  const fences: Array<{ runtimeId?: string, runtimeGeneration?: number }> = []
  const sessionId = typeof msg.sessionId === 'string'
    ? msg.sessionId
    : (typeof msg.event.sessionId === 'string' ? msg.event.sessionId : undefined)
  if (!sessionId) return true

  const session = state.freshAgent?.sessions?.[makeFreshAgentSessionKey({
    sessionId,
    sessionType: msg.sessionType,
    provider: msg.provider,
  })]
  if (session && isRuntimeFenced(session)) fences.push(session)

  for (const layout of Object.values(state.panes?.layouts ?? {})) {
    if (!layout) continue
    for (const content of collectPaneContents(layout)) {
      if (
        content.kind === 'fresh-agent'
        && content.sessionId === sessionId
        && content.sessionType === msg.sessionType
        && content.provider === msg.provider
        && isRuntimeFenced(content)
      ) {
        fences.push(content)
      }
    }
  }

  return fences.every((fence) => matchesRuntimeFence(msg.runtime, fence))
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
    runtime: msg.runtime,
  }

  switch (event.type) {
    case 'freshAgent.session.snapshot':
      dispatch(sessionSnapshotReceived({
        ...locator,
        latestTurnId: (event.latestTurnId as string | null | undefined) ?? null,
        status: event.status as never,
        historySessionId: event.timelineSessionId as string | undefined,
        revision: event.revision as number | undefined,
        streamingActive: event.streamingActive as boolean | undefined,
        streamingText: event.streamingText as string | undefined,
      }))
      return true
    case 'freshAgent.session.changed':
      return true
    case 'freshAgent.session.init':
      dispatch(sessionInit({
        ...locator,
        cliSessionId: event.cliSessionId as string | undefined,
        model: event.model as string | undefined,
        cwd: event.cwd as string | undefined,
        tools: event.tools as Array<{ name: string }> | undefined,
      }))
      return true
    case 'freshAgent.session.metadata':
      dispatch(sessionMetadataReceived({
        ...locator,
        cliSessionId: event.cliSessionId as string | undefined,
        model: event.model as string | undefined,
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
      dispatch(addAssistantMessage({
        ...locator,
        content: Array.isArray(event.content) ? event.content as Record<string, unknown>[] : [],
        model: event.model as string | undefined,
      }))
      return true
    case 'freshAgent.stream': {
      const streamEvent = event.event as Record<string, unknown> | undefined
      if (streamEvent?.type === 'content_block_start') {
        dispatch(setStreaming({ ...locator, active: true }))
      }
      if (streamEvent?.type === 'content_block_delta') {
        const delta = streamEvent.delta as Record<string, unknown> | undefined
        if (delta?.type === 'text_delta') {
          dispatch(appendStreamDelta({
            ...locator,
            text: delta.text as string,
          }))
        }
      }
      if (streamEvent?.type === 'content_block_stop') {
        dispatch(setStreaming({ ...locator, active: false }))
      }
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
      foldFreshAgentKilled(dispatch, locator, event.success as boolean | undefined)
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
