import type { AppDispatch } from '@/store/store'
import type { FreshAgentRuntimeProvider, FreshAgentSessionType } from '@shared/fresh-agent'
import type { SessionRef } from '@shared/session-contract'
import { consumeCancelledCreate } from '@/lib/create-cancellation'
import {
  clearPendingCreateFailure,
  createFailed,
  markSessionLost,
  registerPendingCreate,
  sessionError,
  sessionCreated,
  sessionInit,
  sessionMetadataReceived,
  sessionSnapshotReceived,
  setSessionStatus,
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

type FreshAgentClientMessage =
  | FreshAgentCreatedMessage
  | FreshAgentCreateFailedMessage
  | FreshAgentSessionMaterializedMessage

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
    case 'freshAgent.session.materialized':
      return true
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
    case 'sdk.session.snapshot':
      dispatch(sessionSnapshotReceived({
        ...locator,
        latestTurnId: (event.latestTurnId as string | null | undefined) ?? null,
        status: event.status as never,
        timelineSessionId: event.timelineSessionId as string | undefined,
        revision: event.revision as number | undefined,
        streamingActive: event.streamingActive as boolean | undefined,
        streamingText: event.streamingText as string | undefined,
      }))
      return true
    case 'sdk.session.init':
      dispatch(sessionInit({
        ...locator,
        cliSessionId: event.cliSessionId as string | undefined,
        model: event.model as string | undefined,
        cwd: event.cwd as string | undefined,
        tools: event.tools as Array<{ name: string }> | undefined,
      }))
      return true
    case 'sdk.session.metadata':
      dispatch(sessionMetadataReceived({
        ...locator,
        cliSessionId: event.cliSessionId as string | undefined,
        model: event.model as string | undefined,
        cwd: event.cwd as string | undefined,
        tools: event.tools as Array<{ name: string }> | undefined,
      }))
      return true
    case 'sdk.status':
      dispatch(setSessionStatus({
        ...locator,
        status: event.status as never,
      }))
      return true
    case 'sdk.error':
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
