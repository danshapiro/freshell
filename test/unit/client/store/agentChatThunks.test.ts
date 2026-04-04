import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import agentChatReducer, { sessionSnapshotReceived, turnBodyReceived } from '@/store/agentChatSlice'
import {
  loadAgentTimelineWindow,
  loadAgentTurnBody,
  _resetAgentChatThunkControllers,
} from '@/store/agentChatThunks'

const getAgentTimelinePage = vi.fn()
const getAgentTurnBody = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getAgentTimelinePage: (...args: unknown[]) => getAgentTimelinePage(...args),
    getAgentTurnBody: (...args: unknown[]) => getAgentTurnBody(...args),
  }
})

function makeStore() {
  return configureStore({
    reducer: {
      agentChat: agentChatReducer,
    },
  })
}

function makeTimelineItem(
  turnId: string,
  role: 'user' | 'assistant',
  summary: string,
  overrides: Partial<{
    messageId: string
    ordinal: number
    source: 'durable' | 'live'
    sessionId: string
    timestamp: string
  }> = {},
) {
  return {
    turnId,
    messageId: overrides.messageId ?? `message:${turnId}`,
    ordinal: overrides.ordinal ?? 0,
    source: overrides.source ?? 'durable',
    sessionId: overrides.sessionId ?? 'sess-1',
    role,
    summary,
    ...(overrides.timestamp ? { timestamp: overrides.timestamp } : {}),
  }
}

function makeTimelineTurn(
  turnId: string,
  role: 'user' | 'assistant',
  text: string,
  overrides: Partial<{
    messageId: string
    ordinal: number
    source: 'durable' | 'live'
    sessionId: string
    timestamp: string
  }> = {},
) {
  return {
    sessionId: overrides.sessionId ?? 'sess-1',
    turnId,
    messageId: overrides.messageId ?? `message:${turnId}`,
    ordinal: overrides.ordinal ?? 0,
    source: overrides.source ?? 'durable',
    message: {
      role,
      content: [{ type: 'text', text }],
      timestamp: overrides.timestamp ?? '2026-03-10T10:01:00.000Z',
    },
  }
}

describe('agentChatThunks', () => {
  beforeEach(() => {
    getAgentTimelinePage.mockReset()
    getAgentTurnBody.mockReset()
    _resetAgentChatThunkControllers()
  })

  it('loads a visible timeline window and hydrates the most recent turn body', async () => {
    getAgentTimelinePage.mockResolvedValue({
      sessionId: 'sess-1',
      items: [
        makeTimelineItem('turn-2', 'assistant', 'Latest summary', {
          sessionId: 'sess-1',
          ordinal: 1,
          timestamp: '2026-03-10T10:01:00.000Z',
        }),
        makeTimelineItem('turn-1', 'user', 'Older summary', {
          sessionId: 'sess-1',
          ordinal: 0,
          timestamp: '2026-03-10T10:00:00.000Z',
        }),
      ],
      nextCursor: 'cursor-2',
      revision: 2,
    })
    getAgentTurnBody.mockResolvedValue(makeTimelineTurn('turn-2', 'assistant', 'Latest full body', {
      sessionId: 'sess-1',
      ordinal: 1,
    }))

    const store = makeStore()
    await store.dispatch(loadAgentTimelineWindow({
      sessionId: 'sess-1',
      timelineSessionId: 'cli-sess-1',
      requestKey: 'tab-1:pane-1',
    }))

    expect(getAgentTimelinePage).toHaveBeenCalledWith(
      'cli-sess-1',
      expect.objectContaining({ priority: 'visible' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(getAgentTurnBody).toHaveBeenCalledWith(
      'cli-sess-1',
      'turn-2',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )

    const session = store.getState().agentChat.sessions['sess-1']
    expect(session.historyLoaded).toBe(true)
    expect(session.timelineItems).toEqual([
      expect.objectContaining({ turnId: 'turn-2', summary: 'Latest summary' }),
      expect.objectContaining({ turnId: 'turn-1', summary: 'Older summary' }),
    ])
    expect(session.timelineBodies['turn-2']).toEqual(expect.objectContaining({
      messageId: 'message:turn-2',
      ordinal: 1,
      source: 'durable',
      message: expect.objectContaining({
        content: [{ type: 'text', text: 'Latest full body' }],
      }),
    }))
    expect(session.nextTimelineCursor).toBe('cursor-2')
  })

  it('requests includeBodies on the first visible page and skips getAgentTurnBody when the newest body is inline', async () => {
    getAgentTimelinePage.mockResolvedValue({
      sessionId: 'cli-sess-1',
      items: [makeTimelineItem('turn-2', 'assistant', 'Latest summary', { sessionId: 'cli-sess-1' })],
      nextCursor: null,
      revision: 2,
      bodies: {
        'turn-2': makeTimelineTurn('turn-2', 'assistant', 'Latest full body', { sessionId: 'cli-sess-1' }),
      },
    })

    const store = makeStore()
    await store.dispatch(loadAgentTimelineWindow({
      sessionId: 'sdk-sess-1',
      timelineSessionId: 'cli-sess-1',
      requestKey: 'tab-1:pane-1',
    }))

    expect(getAgentTimelinePage).toHaveBeenCalledWith(
      'cli-sess-1',
      expect.objectContaining({ priority: 'visible', includeBodies: true }),
      expect.anything(),
    )
    expect(getAgentTurnBody).not.toHaveBeenCalled()
  })

  it('preserves previously expanded bodies when appending an older timeline page', async () => {
    getAgentTimelinePage.mockResolvedValue({
      sessionId: 'cli-sess-1',
      items: [
        makeTimelineItem('turn-older', 'user', 'Older summary', {
          sessionId: 'cli-sess-1',
          ordinal: 1,
          timestamp: '2026-03-10T09:59:00.000Z',
        }),
      ],
      nextCursor: null,
      revision: 3,
    })

    const store = makeStore()
    store.dispatch(turnBodyReceived({
      sessionId: 'sdk-sess-1',
      turn: makeTimelineTurn('turn-newest', 'assistant', 'Newest full body', { sessionId: 'cli-sess-1' }),
    }))

    await store.dispatch(loadAgentTimelineWindow({
      sessionId: 'sdk-sess-1',
      timelineSessionId: 'cli-sess-1',
      requestKey: 'tab-1:pane-1',
      cursor: 'cursor-2',
    }))

    expect(getAgentTimelinePage).toHaveBeenCalledWith(
      'cli-sess-1',
      expect.objectContaining({ priority: 'visible', cursor: 'cursor-2' }),
      expect.anything(),
    )
    expect(store.getState().agentChat.sessions['sdk-sess-1'].timelineBodies['turn-newest']).toEqual(expect.objectContaining({
      message: expect.objectContaining({
        content: [{ type: 'text', text: 'Newest full body' }],
      }),
    }))
  })

  it('aborts a stale timeline request when a pane switches sessions', async () => {
    let capturedSignal: AbortSignal | undefined
    getAgentTimelinePage.mockImplementation(async (_sessionId, _query, options) => {
      capturedSignal = options.signal
      await new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
      return null
    })

    const store = makeStore()
    const firstPromise = store.dispatch(loadAgentTimelineWindow({
      sessionId: 'sess-2',
      timelineSessionId: 'cli-sess-2',
      requestKey: 'tab-1:pane-1',
    }))
    const secondPromise = store.dispatch(loadAgentTimelineWindow({
      sessionId: 'sess-3',
      timelineSessionId: 'cli-sess-3',
      requestKey: 'tab-1:pane-1',
    }))

    await expect(firstPromise.unwrap()).rejects.toMatchObject({ name: 'AbortError' })
    secondPromise.abort()
    expect(capturedSignal?.aborted).toBe(true)
    expect(store.getState().agentChat.sessions['sess-2']).toBeUndefined()
  })

  it('hydrates an older turn body on demand', async () => {
    getAgentTurnBody.mockResolvedValue(makeTimelineTurn('turn-7', 'user', 'Older hydrated turn', {
      sessionId: 'sess-3',
      ordinal: 7,
      timestamp: '2026-03-10T09:55:00.000Z',
    }))

    const store = makeStore()
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sess-3',
      latestTurnId: 'turn-9',
      status: 'idle',
      timelineSessionId: 'cli-sess-3',
      revision: 12,
    }))
    await store.dispatch(loadAgentTurnBody({
      sessionId: 'sess-3',
      timelineSessionId: 'cli-sess-3',
      turnId: 'turn-7',
    }))

    expect(getAgentTurnBody).toHaveBeenCalledWith(
      'cli-sess-3',
      'turn-7',
      expect.objectContaining({ signal: expect.any(AbortSignal), revision: 12 }),
    )
    expect(store.getState().agentChat.sessions['sess-3'].timelineBodies['turn-7']).toEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          content: [{ type: 'text', text: 'Older hydrated turn' }],
        }),
      }),
    )
  })

  it('restarts restore instead of leaving stale turn-body hydration pinned to an old revision', async () => {
    const staleError = {
      status: 409,
      message: 'Stale restore revision',
      details: {
        code: 'RESTORE_STALE_REVISION',
        currentRevision: 13,
      },
    }
    getAgentTurnBody.mockRejectedValue(staleError)

    const store = makeStore()
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sdk-sess-3',
      latestTurnId: 'turn-2',
      status: 'idle',
      timelineSessionId: 'cli-sess-3',
      revision: 12,
    }))
    store.dispatch(turnBodyReceived({
      sessionId: 'sdk-sess-3',
      turn: makeTimelineTurn('turn-2', 'assistant', 'Stale hydrated body', {
        sessionId: 'cli-sess-3',
        ordinal: 2,
      }),
    }))

    await store.dispatch(loadAgentTurnBody({
      sessionId: 'sdk-sess-3',
      timelineSessionId: 'cli-sess-3',
      turnId: 'turn-7',
    }))

    const session = store.getState().agentChat.sessions['sdk-sess-3']
    expect(getAgentTurnBody).toHaveBeenCalledWith(
      'cli-sess-3',
      'turn-7',
      expect.objectContaining({ signal: expect.any(AbortSignal), revision: 12 }),
    )
    expect(session.historyLoaded).toBe(false)
    expect(session.timelineBodies).toEqual({})
    expect(session.timelineRevision).toBeUndefined()
    expect(session.latestTurnId).toBeUndefined()
    expect(session.restoreRetryCount).toBe(1)
    expect(session.restoreFailureCode).toBe('RESTORE_STALE_REVISION')
  })

  it('pins the snapshot revision onto timeline-page and turn-body restore reads', async () => {
    getAgentTimelinePage.mockResolvedValue({
      sessionId: 'cli-sess-1',
      items: [
        makeTimelineItem('turn-2', 'assistant', 'Latest summary', {
          sessionId: 'cli-sess-1',
          ordinal: 2,
          timestamp: '2026-03-10T10:01:00.000Z',
        }),
      ],
      nextCursor: null,
      revision: 13,
    })
    getAgentTurnBody.mockResolvedValue(makeTimelineTurn('turn-2', 'assistant', 'Latest full body', {
      sessionId: 'cli-sess-1',
      ordinal: 2,
    }))

    const store = makeStore()
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sdk-sess-1',
      latestTurnId: 'turn-2',
      status: 'idle',
      timelineSessionId: 'cli-sess-1',
      revision: 13,
    }))

    await store.dispatch(loadAgentTimelineWindow({
      sessionId: 'sdk-sess-1',
      timelineSessionId: 'cli-sess-1',
      requestKey: 'tab-1:pane-1',
    }))

    expect(getAgentTimelinePage).toHaveBeenCalledWith(
      'cli-sess-1',
      expect.objectContaining({ priority: 'visible', includeBodies: true, revision: 13 }),
      expect.anything(),
    )
    expect(getAgentTurnBody).toHaveBeenCalledWith(
      'cli-sess-1',
      'turn-2',
      expect.objectContaining({ signal: expect.any(AbortSignal), revision: 13 }),
    )
  })

  it('pins the fallback newest-turn body fetch to the accepted page revision when the page advances restore state', async () => {
    getAgentTimelinePage.mockResolvedValue({
      sessionId: 'cli-sess-advancing',
      items: [
        makeTimelineItem('turn-9', 'assistant', 'Latest summary', {
          sessionId: 'cli-sess-advancing',
          ordinal: 9,
          timestamp: '2026-03-10T10:03:00.000Z',
        }),
      ],
      nextCursor: null,
      revision: 13,
    })
    getAgentTurnBody.mockResolvedValue(makeTimelineTurn('turn-9', 'assistant', 'Latest full body', {
      sessionId: 'cli-sess-advancing',
      ordinal: 9,
      timestamp: '2026-03-10T10:03:00.000Z',
    }))

    const store = makeStore()
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sdk-sess-advancing',
      latestTurnId: 'turn-9',
      status: 'idle',
      timelineSessionId: 'cli-sess-advancing',
      revision: 12,
    }))

    await store.dispatch(loadAgentTimelineWindow({
      sessionId: 'sdk-sess-advancing',
      timelineSessionId: 'cli-sess-advancing',
      requestKey: 'tab-1:pane-advancing',
    }))

    expect(getAgentTimelinePage).toHaveBeenCalledWith(
      'cli-sess-advancing',
      expect.objectContaining({ priority: 'visible', includeBodies: true, revision: 12 }),
      expect.anything(),
    )
    expect(getAgentTurnBody).toHaveBeenCalledWith(
      'cli-sess-advancing',
      'turn-9',
      expect.objectContaining({ signal: expect.any(AbortSignal), revision: 13 }),
    )
  })

  it('bookkeeps one stale-revision retry request instead of mixing stale data into state', async () => {
    const staleError = {
      status: 409,
      message: 'Stale restore revision',
      details: {
        code: 'RESTORE_STALE_REVISION',
        currentRevision: 13,
      },
    }
    getAgentTimelinePage.mockRejectedValue(staleError)

    const store = makeStore()
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sdk-sess-stale',
      latestTurnId: 'turn-2',
      status: 'idle',
      timelineSessionId: 'cli-sess-stale',
      revision: 12,
    }))

    await store.dispatch(loadAgentTimelineWindow({
      sessionId: 'sdk-sess-stale',
      timelineSessionId: 'cli-sess-stale',
      requestKey: 'tab-1:pane-1',
    }))

    const session = store.getState().agentChat.sessions['sdk-sess-stale']
    expect(session.timelineItems).toEqual([])
    expect((session as any).restoreRetryCount).toBe(1)
    expect((session as any).restoreFailureCode).toBe('RESTORE_STALE_REVISION')
  })
})
