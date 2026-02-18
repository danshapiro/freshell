import type { AppDispatch } from '@/store/store'
import type { ChatContentBlock } from '@/store/claudeChatTypes'
import {
  sessionCreated,
  sessionInit,
  addAssistantMessage,
  setStreaming,
  appendStreamDelta,
  clearStreaming,
  addPermissionRequest,
  removePermission,
  setSessionStatus,
  turnResult,
  sessionExited,
  replayHistory,
  sessionError,
  removeSession,
  setAvailableModels,
} from '@/store/claudeChatSlice'

/**
 * Tracks createRequestIds whose owning pane was closed before sdk.created arrived.
 * When sdk.created arrives for a cancelled ID, we skip session creation and send sdk.kill.
 */
const cancelledCreateRequestIds = new Set<string>()

/** Mark a createRequestId as cancelled so the arriving sdk.created will be killed. */
export function cancelCreate(requestId: string): void {
  cancelledCreateRequestIds.add(requestId)
}

/** Visible for testing — clear all cancelled creates. */
export function _resetCancelledCreates(): void {
  cancelledCreateRequestIds.clear()
}

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
      if (cancelledCreateRequestIds.has(requestId)) {
        cancelledCreateRequestIds.delete(requestId)
        ws?.send({ type: 'sdk.kill', sessionId })
        return true
      }
      dispatch(sessionCreated({ requestId, sessionId }))
      return true
    }

    case 'sdk.session.init':
      dispatch(sessionInit({
        sessionId: msg.sessionId as string,
        cliSessionId: msg.cliSessionId as string | undefined,
        model: msg.model as string | undefined,
        cwd: msg.cwd as string | undefined,
        tools: msg.tools as Array<{ name: string }> | undefined,
      }))
      return true

    case 'sdk.assistant':
      dispatch(addAssistantMessage({
        sessionId: msg.sessionId as string,
        content: msg.content as ChatContentBlock[],
        model: msg.model as string | undefined,
      }))
      return true

    case 'sdk.stream': {
      const event = msg.event as Record<string, unknown> | undefined
      if (event?.type === 'content_block_start') {
        dispatch(setStreaming({ sessionId: msg.sessionId as string, active: true }))
      }
      if (event?.type === 'content_block_delta') {
        const delta = event.delta as Record<string, unknown> | undefined
        if (delta?.type === 'text_delta') {
          dispatch(appendStreamDelta({
            sessionId: msg.sessionId as string,
            text: delta.text as string,
          }))
        }
      }
      if (event?.type === 'content_block_stop') {
        dispatch(clearStreaming({ sessionId: msg.sessionId as string }))
      }
      return true
    }

    case 'sdk.result':
      dispatch(turnResult({
        sessionId: msg.sessionId as string,
        costUsd: msg.costUsd as number | undefined,
        durationMs: msg.durationMs as number | undefined,
        usage: msg.usage as { input_tokens: number; output_tokens: number } | undefined,
      }))
      return true

    case 'sdk.permission.request':
      dispatch(addPermissionRequest({
        sessionId: msg.sessionId as string,
        requestId: msg.requestId as string,
        subtype: msg.subtype as string,
        tool: msg.tool as { name: string; input?: Record<string, unknown> } | undefined,
      }))
      return true

    case 'sdk.permission.cancelled':
      dispatch(removePermission({
        sessionId: msg.sessionId as string,
        requestId: msg.requestId as string,
      }))
      return true

    case 'sdk.status':
      dispatch(setSessionStatus({
        sessionId: msg.sessionId as string,
        status: msg.status as any,
      }))
      return true

    case 'sdk.exit':
      dispatch(sessionExited({
        sessionId: msg.sessionId as string,
        exitCode: msg.exitCode as number | undefined,
      }))
      return true

    case 'sdk.history':
      dispatch(replayHistory({
        sessionId: msg.sessionId as string,
        messages: msg.messages as Array<{ role: 'user' | 'assistant'; content: any[]; timestamp?: string }>,
      }))
      return true

    case 'sdk.error':
      dispatch(sessionError({
        sessionId: msg.sessionId as string,
        message: (msg.message as string) || (msg.error as string) || 'Unknown error',
      }))
      return true

    case 'sdk.killed':
      // Session killed confirmation — clean up client state
      dispatch(removeSession({
        sessionId: msg.sessionId as string,
      }))
      return true

    case 'sdk.models':
      dispatch(setAvailableModels({
        models: msg.models as Array<{ value: string; displayName: string; description: string }>,
      }))
      return true

    default:
      return false
  }
}
