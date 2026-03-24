import { createAsyncThunk } from '@reduxjs/toolkit'
import {
  getAgentTimelinePage,
  getAgentTurnBody,
} from '@/lib/api'
import type { AppDispatch, RootState } from './store'
import {
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

export const loadAgentTurnBody = createAsyncThunk<
  void,
  LoadAgentTurnBodyArgs,
  { dispatch: AppDispatch; state: RootState }
>(
  'agentChat/loadTurnBody',
  async ({ sessionId, timelineSessionId, turnId }, { dispatch, signal }) => {
    const turn = await getAgentTurnBody(timelineSessionId ?? sessionId, turnId, { signal })
    dispatch(turnBodyReceived({
      sessionId,
      turnId,
      message: turn.message,
    }))
  },
)

export const loadAgentTimelineWindow = createAsyncThunk<
  void,
  LoadAgentTimelineWindowArgs,
  { dispatch: AppDispatch; state: RootState }
>(
  'agentChat/loadTimelineWindow',
  async (args, { dispatch, signal }) => {
    const { sessionId, timelineSessionId, cursor } = args
    const controllerKey = getTimelineControllerKey(args)
    const controller = new AbortController()
    timelineControllers.get(controllerKey)?.abort()
    timelineControllers.set(controllerKey, controller)
    signal.addEventListener('abort', () => controller.abort(), { once: true })

    dispatch(timelineLoadStarted({ sessionId }))

    try {
      const page = await getAgentTimelinePage(
        timelineSessionId ?? sessionId,
        {
          priority: 'visible',
          includeBodies: true,
          ...(cursor ? { cursor } : {}),
        },
        { signal: controller.signal },
      )

      dispatch(timelinePageReceived({
        sessionId,
        items: page.items,
        nextCursor: page.nextCursor,
        revision: page.revision,
        replace: !cursor,
      }))

      const newestTurn = page.items[0]
      if (!newestTurn) return

      // Use inlined bodies when available (avoids separate HTTP request per turn)
      const inlinedBody = page.bodies?.[newestTurn.turnId]
      if (inlinedBody) {
        dispatch(turnBodyReceived({
          sessionId,
          turnId: newestTurn.turnId,
          message: inlinedBody.message,
        }))
      } else {
        // Fall back to separate request (backward compatibility with older servers)
        const turn = await getAgentTurnBody(
          timelineSessionId ?? sessionId,
          newestTurn.turnId,
          { signal: controller.signal },
        )
        dispatch(turnBodyReceived({
          sessionId,
          turnId: newestTurn.turnId,
          message: turn.message,
        }))
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error
      }

      dispatch(timelineLoadFailed({
        sessionId,
        message: error instanceof Error ? error.message : 'Timeline request failed',
      }))
      throw error
    } finally {
      if (timelineControllers.get(controllerKey) === controller) {
        timelineControllers.delete(controllerKey)
      }
    }
  },
)
