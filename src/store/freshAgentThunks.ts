import { createAsyncThunk } from '@reduxjs/toolkit'
import { getFreshAgentTurnBody, getFreshAgentTurnPage } from '@/lib/api'
import {
  historyLoadFailed,
  historyLoadStarted,
  historyPageReceived,
  turnBodyReceived,
} from './freshAgentSlice'
import type { FreshAgentRuntimeProvider, FreshAgentSessionType } from '@shared/fresh-agent'

type FreshAgentThreadThunkLocator = {
  sessionType: FreshAgentSessionType
  provider: FreshAgentRuntimeProvider
  sessionId: string
  cwd?: string
}

const inFlightControllers = new Set<AbortController>()

export function _resetFreshAgentThunkControllers(): void {
  for (const controller of inFlightControllers) {
    controller.abort()
  }
  inFlightControllers.clear()
}

export const loadFreshAgentThreadTurns = createAsyncThunk(
  'freshAgent/loadThreadTurns',
  async (
    input: FreshAgentThreadThunkLocator & {
      revision: number
      cursor?: string
      limit?: number
      includeBodies?: boolean
    },
    { dispatch },
  ) => {
    const controller = new AbortController()
    inFlightControllers.add(controller)
    dispatch(historyLoadStarted(input))
    try {
      const page = await getFreshAgentTurnPage(
        input.sessionType,
        input.provider,
        input.sessionId,
        {
          revision: input.revision,
          cursor: input.cursor,
          limit: input.limit,
          includeBodies: input.includeBodies,
          cwd: input.cwd,
          signal: controller.signal,
        },
      )
      dispatch(historyPageReceived({
        ...input,
        turns: page.turns,
        nextCursor: page.nextCursor,
        revision: page.revision,
      }))
      return page
    } catch (error) {
      dispatch(historyLoadFailed({
        ...input,
        message: error instanceof Error ? error.message : 'Failed to load fresh-agent history',
      }))
      throw error
    } finally {
      inFlightControllers.delete(controller)
    }
  },
)

export const loadFreshAgentTurnBody = createAsyncThunk(
  'freshAgent/loadTurnBody',
  async (
    input: FreshAgentThreadThunkLocator & {
      turnId: string
      revision: number
    },
    { dispatch },
  ) => {
    const controller = new AbortController()
    inFlightControllers.add(controller)
    try {
      const turn = await getFreshAgentTurnBody(
        input.sessionType,
        input.provider,
        input.sessionId,
        input.turnId,
        {
          revision: input.revision,
          cwd: input.cwd,
          signal: controller.signal,
        },
      )
      dispatch(turnBodyReceived({ ...input, turn }))
      return turn
    } finally {
      inFlightControllers.delete(controller)
    }
  },
)
