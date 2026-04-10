import { createAsyncThunk } from '@reduxjs/toolkit'
import {
  getAgentTimelinePage,
  getAgentTurnBody,
} from '@/lib/api'
import { isValidClaudeSessionId } from '@/lib/claude-session-id'
import type { AppDispatch, RootState } from './store'
import {
  restoreRetryRequested,
  timelineLoadFailed,
  timelineLoadStarted,
  timelinePageReceived,
  turnBodyReceived,
} from './agentChatSlice'

type LoadAgentTimelineWindowArgs = {
  sessionId: string
  timelineSessionId?: string
  requestKey?: string
  cursor?: string
}

type LoadAgentTurnBodyArgs = {
  sessionId: string
  timelineSessionId?: string
  turnId: string
}

const timelineControllers = new Map<string, AbortController>()

function getTimelineControllerKey(args: LoadAgentTimelineWindowArgs): string {
  return args.requestKey ?? args.sessionId
}

export function _resetAgentChatThunkControllers(): void {
  timelineControllers.clear()
}

function isStaleRevisionError(error: unknown): error is {
  status: number
  details?: { code?: string }
} {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { status?: unknown; details?: { code?: unknown } }
  return candidate.status === 409 && candidate.details?.code === 'RESTORE_STALE_REVISION'
}

function getTimelineErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }
  if (
    typeof error === 'object'
    && error !== null
    && 'message' in error
    && typeof (error as { message?: unknown }).message === 'string'
    && (error as { message: string }).message.trim().length > 0
  ) {
    return (error as { message: string }).message
  }
  return fallback
}

function getRestoreFailureCode(error: unknown): string | undefined {
  if (
    typeof error === 'object'
    && error !== null
    && 'details' in error
    && typeof (error as { details?: { code?: unknown } }).details?.code === 'string'
  ) {
    const code = (error as { details: { code: string } }).details.code
    return code.startsWith('RESTORE_') ? code : undefined
  }
  return undefined
}

function requestStaleRestoreRetry(
  sessionId: string,
  dispatch: AppDispatch,
  getState: () => RootState,
): boolean {
  const retryCount = getState().agentChat.sessions[sessionId]?.restoreRetryCount ?? 0
  if (retryCount >= 1) return false
  dispatch(restoreRetryRequested({
    sessionId,
    code: 'RESTORE_STALE_REVISION',
  }))
  return true
}

export const loadAgentTurnBody = createAsyncThunk<
  void,
  LoadAgentTurnBodyArgs,
  { dispatch: AppDispatch; state: RootState }
>(
  'agentChat/loadTurnBody',
  async ({ sessionId, timelineSessionId, turnId }, { dispatch, signal, getState }) => {
    const revision = getState().agentChat.sessions[sessionId]?.timelineRevision
    if (revision == null) {
      const error = new Error('Restore revision required')
      dispatch(timelineLoadFailed({
        sessionId,
        message: error.message,
      }))
      throw error
    }
    try {
      const turn = await getAgentTurnBody(timelineSessionId ?? sessionId, turnId, { revision, signal })
      dispatch(turnBodyReceived({
        sessionId,
        turn,
      }))
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error
      }

      if (isStaleRevisionError(error)) {
        dispatch(timelineLoadFailed({
          sessionId,
          message: getTimelineErrorMessage(error, 'Timeline request failed'),
        }))
        throw error
      }

      dispatch(timelineLoadFailed({
        sessionId,
        message: getTimelineErrorMessage(error, 'Timeline request failed'),
        code: getRestoreFailureCode(error),
      }))
      throw error
    }
  },
)

export const loadAgentTimelineWindow = createAsyncThunk<
  void,
  LoadAgentTimelineWindowArgs,
  { dispatch: AppDispatch; state: RootState }
>(
  'agentChat/loadTimelineWindow',
  async (args, { dispatch, signal, getState }) => {
    const { sessionId, timelineSessionId, cursor } = args
    const controllerKey = getTimelineControllerKey(args)
    const controller = new AbortController()
    timelineControllers.get(controllerKey)?.abort()
    timelineControllers.set(controllerKey, controller)
    signal.addEventListener('abort', () => controller.abort(), { once: true })

    dispatch(timelineLoadStarted({ sessionId }))
    const revision = getState().agentChat.sessions[sessionId]?.timelineRevision
    if (revision == null) {
      const error = new Error('Restore revision required')
      dispatch(timelineLoadFailed({
        sessionId,
        message: error.message,
      }))
      throw error
    }

    try {
      const page = await getAgentTimelinePage(
        timelineSessionId ?? sessionId,
        {
          priority: 'visible',
          revision,
          ...(!cursor ? { includeBodies: true } : {}),
          ...(cursor ? { cursor } : {}),
        },
        { signal: controller.signal },
      )
      const canonicalTimelineSessionId = isValidClaudeSessionId(page.sessionId)
        ? page.sessionId
        : undefined
      const resolvedTimelineSessionId = canonicalTimelineSessionId ?? timelineSessionId ?? sessionId

      dispatch(timelinePageReceived({
        sessionId,
        timelineSessionId: canonicalTimelineSessionId,
        items: page.items,
        nextCursor: page.nextCursor,
        revision: page.revision,
        replace: !cursor,
        bodies: page.bodies,
      }))

      const newestTurn = page.items[0]
      if (!newestTurn || page.bodies?.[newestTurn.turnId]) return

      const turn = await getAgentTurnBody(
        resolvedTimelineSessionId,
        newestTurn.turnId,
        { revision: page.revision, signal: controller.signal },
      )
      dispatch(turnBodyReceived({
        sessionId,
        turn,
      }))
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error
      }

      if (isStaleRevisionError(error)) {
        if (requestStaleRestoreRetry(sessionId, dispatch, getState)) {
          return
        }
      }

      dispatch(timelineLoadFailed({
        sessionId,
        message: getTimelineErrorMessage(error, 'Timeline request failed'),
        code: getRestoreFailureCode(error),
      }))
      throw error
    } finally {
      if (timelineControllers.get(controllerKey) === controller) {
        timelineControllers.delete(controllerKey)
      }
    }
  },
)
