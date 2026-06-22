import type { AppDispatch, RootState } from '@/store/store'
import {
  makeFreshAgentSessionKey,
  type FreshAgentRuntimeProvider,
  type FreshAgentSessionType,
} from '@shared/fresh-agent'
import type { SessionRef } from '@shared/session-contract'
import { consumeCancelledCreate } from '@/lib/create-cancellation'
import { flushPersistedLayoutNow } from '@/store/persistControl'
import { materializeFreshAgentSession as materializeFreshAgentPaneSession } from '@/store/panesSlice'
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
}

type FreshAgentClientMessage =
  | FreshAgentCreatedMessage
  | FreshAgentCreateFailedMessage
  | FreshAgentSessionMaterializedMessage
  | FreshAgentKilledMessage

interface FreshAgentMessageSink {
  send: (msg: unknown) => void
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
  },
): void {
  dispatch(registerPendingCreate({
    requestId,
    sessionType: options.sessionType,
    provider: options.provider,
    expectsHistoryHydration: Boolean(options.resumeSessionId || options.sessionRef),
  }))
  dispatch(clearPendingCreateFailure({ requestId }))
}

export function handleFreshAgentMessage(dispatch: AppDispatch, msg: Record<string, unknown>, ws?: FreshAgentMessageSink): boolean {
  switch (msg.type) {
    case 'freshAgent.created': {
      const created = msg as FreshAgentCreatedMessage
      const provider = created.provider ?? created.runtimeProvider
      if (consumeCancelledCreate(created.requestId)) {
        if (provider) {
          ws?.send({
            type: 'freshAgent.kill',
            sessionId: created.sessionId,
            sessionType: created.sessionType,
            provider,
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
      dispatch(materializeFreshAgentSessionState({
        previousSessionId: materialized.previousSessionId,
        sessionId: materialized.sessionId,
        sessionType: materialized.sessionType,
        provider: materialized.provider,
      }))
      dispatch((innerDispatch: AppDispatch, getState: () => RootState) => {
        const sessionKey = makeFreshAgentSessionKey({
          sessionId: materialized.sessionId,
          sessionType: materialized.sessionType,
          provider: materialized.provider,
        })
        innerDispatch(materializeFreshAgentPaneSession({
          previousSessionId: materialized.previousSessionId,
          sessionId: materialized.sessionId,
          sessionType: materialized.sessionType,
          provider: materialized.provider,
          sessionRef: materialized.sessionRef ?? {
            provider: materialized.provider,
            sessionId: materialized.sessionId,
          },
          status: getState().freshAgent.sessions[sessionKey]?.status,
        }))
      })
      dispatch(flushPersistedLayoutNow())
      return true
    }
    case 'freshAgent.killed': {
      const killed = msg as FreshAgentKilledMessage
      dispatch(removeSession({
        sessionId: killed.sessionId,
        sessionType: killed.sessionType,
        provider: killed.provider,
      }))
      return true
    }
    case 'freshAgent.event':
      return handleFreshAgentTransportEvent(dispatch, msg as FreshAgentEventMessage)
    default:
      return false
  }
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
    case 'freshAgent.exit':
      dispatch(sessionExited(locator))
      return true
    case 'freshAgent.error':
      if (event.code === 'INVALID_SESSION_ID') {
        dispatch(markSessionLost(locator))
      } else {
        dispatch(sessionError({
          ...locator,
          code: event.code as string | undefined,
          message: (event.message as string) || (event.error as string) || 'Unknown error',
        }))
      }
      return true
    case 'freshAgent.killed':
      dispatch(removeSession(locator))
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
