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
import {
  addActivityEvent,
  updateTokenUsage,
  addPendingApproval,
  resolvePendingApproval,
} from '@/store/activityPanelSlice'
import type { NormalizedEvent } from '@/lib/coding-cli-types'
import { isActivityPanelRelevant } from '@/lib/activity-panel-utils'

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

    case 'sdk.assistant': {
      const assistantSessionId = msg.sessionId as string
      const content = msg.content as ChatContentBlock[]
      dispatch(addAssistantMessage({
        sessionId: assistantSessionId,
        content,
        model: msg.model as string | undefined,
      }))
      // Fan-out tool_use and tool_result blocks to the activity panel
      for (const block of content) {
        if (block.type === 'tool_use' && block.name) {
          dispatch(addActivityEvent({
            sessionId: assistantSessionId,
            event: {
              type: 'tool.call',
              timestamp: new Date().toISOString(),
              sessionId: assistantSessionId,
              provider: 'claude',
              toolCall: {
                name: block.name,
                args: block.input ? JSON.stringify(block.input).slice(0, 200) : undefined,
              },
            },
          }))
        }
        if (block.type === 'tool_result') {
          dispatch(addActivityEvent({
            sessionId: assistantSessionId,
            event: {
              type: 'tool.result',
              timestamp: new Date().toISOString(),
              sessionId: assistantSessionId,
              provider: 'claude',
              toolResult: {
                name: block.tool_use_id ?? '',
                success: !block.is_error,
                output: typeof block.content === 'string' ? block.content.slice(0, 200) : undefined,
              },
            },
          }))
        }
      }
      return true
    }

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

    case 'sdk.result': {
      const resultSessionId = msg.sessionId as string
      const usage = msg.usage as { input_tokens: number; output_tokens: number } | undefined
      dispatch(turnResult({
        sessionId: resultSessionId,
        costUsd: msg.costUsd as number | undefined,
        durationMs: msg.durationMs as number | undefined,
        usage,
      }))
      // Route token usage to activity panel
      if (usage) {
        dispatch(updateTokenUsage({
          sessionId: resultSessionId,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          totalCost: msg.costUsd as number | undefined,
        }))
        dispatch(addActivityEvent({
          sessionId: resultSessionId,
          event: {
            type: 'token.usage',
            timestamp: new Date().toISOString(),
            sessionId: resultSessionId,
            provider: 'claude',
            tokens: {
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              totalCost: msg.costUsd as number | undefined,
            },
          },
        }))
      }
      return true
    }

    case 'sdk.permission.request': {
      const permSessionId = msg.sessionId as string
      const permRequestId = msg.requestId as string
      const tool = msg.tool as { name: string; input?: Record<string, unknown> } | undefined
      dispatch(addPermissionRequest({
        sessionId: permSessionId,
        requestId: permRequestId,
        subtype: msg.subtype as string,
        tool,
      }))
      // Route to activity panel as a pending approval
      dispatch(addPendingApproval({
        sessionId: permSessionId,
        approval: {
          requestId: permRequestId,
          toolName: tool?.name ?? 'unknown',
          description: msg.subtype as string,
          timestamp: new Date().toISOString(),
        },
      }))
      // Also add as a tool.call event for the feed
      dispatch(addActivityEvent({
        sessionId: permSessionId,
        event: {
          type: 'approval.request',
          timestamp: new Date().toISOString(),
          sessionId: permSessionId,
          provider: 'claude',
          approval: {
            requestId: permRequestId,
            toolName: tool?.name ?? 'unknown',
            description: msg.subtype as string,
          },
        },
      }))
      return true
    }

    case 'sdk.permission.cancelled':
      dispatch(removePermission({
        sessionId: msg.sessionId as string,
        requestId: msg.requestId as string,
      }))
      // Also resolve in activity panel
      dispatch(resolvePendingApproval({
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

    // Coding CLI events: fan-out to activity panel for terminal panes.
    // SessionView.tsx handles this for headless sessions, but terminal panes
    // don't mount SessionView — they need global handling here.
    case 'codingcli.event': {
      const cliSessionId = msg.sessionId as string
      const event = msg.event as NormalizedEvent
      if (isActivityPanelRelevant(event)) {
        dispatch(addActivityEvent({ sessionId: cliSessionId, event }))
      }
      if (event.type === 'token.usage' && event.tokens) {
        dispatch(updateTokenUsage({
          sessionId: cliSessionId,
          inputTokens: event.tokens.inputTokens,
          outputTokens: event.tokens.outputTokens,
          cachedTokens: event.tokens.cachedTokens,
          totalCost: event.tokens.totalCost,
        }))
      }
      if (event.type === 'approval.request' && event.approval) {
        dispatch(addPendingApproval({
          sessionId: cliSessionId,
          approval: {
            requestId: event.approval.requestId,
            toolName: event.approval.toolName,
            description: event.approval.description,
            timestamp: event.timestamp,
          },
        }))
      }
      if (event.type === 'approval.response' && event.approval?.requestId) {
        dispatch(resolvePendingApproval({ sessionId: cliSessionId, requestId: event.approval.requestId }))
      }
      // Return false — don't consume the message. SessionView (if mounted) and
      // terminal-runtime may also need to process codingcli.event messages.
      return false
    }

    default:
      return false
  }
}
