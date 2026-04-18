import type { AppDispatch } from '@/store/store'
import {
  clearPendingCreateFailure,
  createFailed,
  registerPendingCreate,
  sessionCreated,
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
    default:
      return false
  }
}

export type { FreshAgentClientMessage, FreshAgentCreatedMessage, FreshAgentCreateFailedMessage }
