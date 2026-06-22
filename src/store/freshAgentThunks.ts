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

const BACKGROUND_HISTORY_MAX_PAGES_PER_BATCH = 8

const inFlightControllers = new Set<AbortController>()

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message
  }
  return undefined
}

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
      revision?: number
      cursor?: string
      priority?: 'visible' | 'background'
      requestKey?: string
      limit?: number
      includeBodies?: boolean
      suppressFailureDispatch?: boolean
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
          priority: input.priority,
          limit: input.limit,
          includeBodies: input.includeBodies,
          cwd: input.cwd,
          signal: controller.signal,
        },
      )
      dispatch(historyPageReceived({
        ...input,
        turns: page.turns,
        bodies: page.bodies ?? {},
        nextCursor: page.nextCursor,
        revision: page.revision,
      }))
      return page
    } catch (error) {
      if (!input.suppressFailureDispatch) {
        dispatch(historyLoadFailed({
          ...input,
          message: errorMessage(error) ?? 'Failed to load fresh-agent history',
        }))
      }
      throw error
    } finally {
      inFlightControllers.delete(controller)
    }
  },
)

export const backfillFreshAgentOlderHistory = createAsyncThunk(
  'freshAgent/backfillOlderHistory',
  async (
    input: FreshAgentThreadThunkLocator & {
      revision: number
      cursor: string
      requestKey: string
      limit?: number
    },
    { dispatch },
  ) => {
    let cursor: string | null | undefined = input.cursor
    let revision = input.revision
    for (let page = 0; cursor && page < BACKGROUND_HISTORY_MAX_PAGES_PER_BATCH; page += 1) {
      try {
        const result = await dispatch(loadFreshAgentThreadTurns({
          ...input,
          revision,
          cursor,
          priority: 'background',
          limit: input.limit ?? 30,
          includeBodies: true,
          suppressFailureDispatch: true,
        })).unwrap()
        cursor = result.nextCursor
        revision = result.revision
      } catch (error) {
        const rawMessage = errorMessage(error)
        const message = rawMessage && /(cursor|stale|revision)/i.test(rawMessage)
          ? 'Older history cursor expired; refresh history to continue.'
          : (rawMessage ?? 'Failed to load older fresh-agent history')
        dispatch(historyLoadFailed({ ...input, cursor: cursor ?? input.cursor, message }))
        throw error
      }
    }
    return { nextCursor: cursor ?? null, revision }
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
      dispatch(turnBodyReceived({ ...input, turn, revision: input.revision }))
      return turn
    } finally {
      inFlightControllers.delete(controller)
    }
  },
)
