import type { AppDispatch } from '@/store/store'
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
}

type FreshAgentCreateFailedMessage = {
  type: 'freshAgent.create.failed'
  requestId: string
  code: string
  message: string
  retryable?: boolean
}

type FreshAgentClientMessage = FreshAgentCreatedMessage | FreshAgentCreateFailedMessage

type FreshAgentEventMessage = {
  type: 'freshAgent.event'
  sessionId: string
  event: Record<string, unknown>
}

export function registerFreshAgentCreate(
  dispatch: AppDispatch,
  requestId: string,
  options: { resumeSessionId?: string } = {},
): void {
  dispatch(registerPendingCreate({
    requestId,
    expectsHistoryHydration: Boolean(options.resumeSessionId),
  }))
  dispatch(clearPendingCreateFailure({ requestId }))
}

export function handleFreshAgentMessage(dispatch: AppDispatch, msg: Record<string, unknown>): boolean {
  switch (msg.type) {
    case 'freshAgent.created': {
      const created = msg as FreshAgentCreatedMessage
      dispatch(sessionCreated({
        requestId: created.requestId,
        sessionId: created.sessionId,
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

  switch (event.type) {
    case 'sdk.session.snapshot':
      dispatch(sessionSnapshotReceived({
        sessionId,
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
        sessionId,
        cliSessionId: event.cliSessionId as string | undefined,
        model: event.model as string | undefined,
        cwd: event.cwd as string | undefined,
        tools: event.tools as Array<{ name: string }> | undefined,
      }))
      return true
    case 'sdk.session.metadata':
      dispatch(sessionMetadataReceived({
        sessionId,
        cliSessionId: event.cliSessionId as string | undefined,
        model: event.model as string | undefined,
        cwd: event.cwd as string | undefined,
        tools: event.tools as Array<{ name: string }> | undefined,
      }))
      return true
    case 'sdk.status':
      dispatch(setSessionStatus({
        sessionId,
        status: event.status as never,
      }))
      return true
    case 'sdk.error':
      if (event.code === 'INVALID_SESSION_ID') {
        dispatch(markSessionLost({ sessionId }))
      } else {
        dispatch(sessionError({
          sessionId,
          code: event.code as string | undefined,
          message: (event.message as string) || (event.error as string) || 'Unknown error',
        }))
      }
      return true
    default:
      return false
  }
}

export type { FreshAgentClientMessage, FreshAgentCreatedMessage, FreshAgentCreateFailedMessage, FreshAgentEventMessage }
