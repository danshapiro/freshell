import type { AppDispatch } from '@/store/store'
import { consumeCancelledCreate } from '@/lib/create-cancellation'
import {
  sessionCreated,
  createFailed,
} from '@/store/freshAgentSlice'
import { handleFreshAgentTransportEvent } from '@/lib/fresh-agent-ws'
export { cancelCreate, _resetCancelledCreates } from '@/lib/create-cancellation'

interface SdkMessageSink {
  send: (msg: unknown) => void
}

/**
 * Handle incoming SDK WebSocket messages and dispatch Redux actions.
 * Returns true if the message was handled (i.e. it was an sdk.* message).
 * @param ws Optional WS client — needed to kill orphaned sessions from cancelled creates.
 */
export function handleSdkMessage(dispatch: AppDispatch, msg: Record<string, unknown>, ws?: SdkMessageSink): boolean {
  switch (msg.type) {
    case 'sdk.created': {
      const requestId = msg.requestId as string
      const sessionId = msg.sessionId as string
      // If the pane was closed before sdk.created arrived, kill the orphan
      if (consumeCancelledCreate(requestId)) {
        ws?.send({ type: 'sdk.kill', sessionId })
        return true
      }
      dispatch(sessionCreated({
        requestId,
        sessionId,
        sessionType: 'freshclaude',
        provider: 'claude',
      }))
      return true
    }

    case 'sdk.create.failed':
      dispatch(createFailed({
        requestId: msg.requestId as string,
        code: msg.code as string,
        message: msg.message as string,
        retryable: msg.retryable as boolean | undefined,
      }))
      return true

    default:
      if (typeof msg.type === 'string' && msg.type.startsWith('sdk.') && typeof msg.sessionId === 'string') {
        return handleFreshAgentTransportEvent(dispatch, {
          type: 'freshAgent.event',
          sessionId: msg.sessionId,
          sessionType: 'freshclaude',
          provider: 'claude',
          event: msg,
        })
      }
      return false
  }
}
