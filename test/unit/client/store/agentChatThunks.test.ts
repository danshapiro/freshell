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
        { turnId: 'turn-2', sessionId: 'sess-1', role: 'assistant', summary: 'Latest summary', timestamp: '2026-03-10T10:01:00.000Z' },
        { turnId: 'turn-1', sessionId: 'sess-1', role: 'user', summary: 'Older summary', timestamp: '2026-03-10T10:00:00.000Z' },
      ],
      nextCursor: 'cursor-2',
      revision: 2,
    })
    getAgentTurnBody.mockResolvedValue({
      sessionId: 'sess-1',
      turnId: 'turn-2',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Latest full body' }],
        timestamp: '2026-03-10T10:01:00.000Z',
      },
    })

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
      content: [{ type: 'text', text: 'Latest full body' }],
    }))
    expect(session.nextTimelineCursor).toBe('cursor-2')
  })

  it('requests includeBodies on the first visible page and skips getAgentTurnBody when the newest body is inline', async () => {
    getAgentTimelinePage.mockResolvedValue({
      sessionId: 'cli-sess-1',
      items: [{ turnId: 'turn-2', sessionId: 'cli-sess-1', role: 'assistant', summary: 'Latest summary' }],
      nextCursor: null,
      revision: 2,
      bodies: {
        'turn-2': {
          sessionId: 'cli-sess-1',
          turnId: 'turn-2',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Latest full body' }],
            timestamp: '2026-03-10T10:01:00.000Z',
          },
        },
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
        { turnId: 'turn-older', sessionId: 'cli-sess-1', role: 'user', summary: 'Older summary', timestamp: '2026-03-10T09:59:00.000Z' },
      ],
      nextCursor: null,
      revision: 3,
    })

    const store = makeStore()
    store.dispatch(turnBodyReceived({
      sessionId: 'sdk-sess-1',
      turnId: 'turn-newest',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Newest full body' }],
        timestamp: '2026-03-10T10:01:00.000Z',
      },
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
      content: [{ type: 'text', text: 'Newest full body' }],
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
    getAgentTurnBody.mockResolvedValue({
      sessionId: 'sess-3',
      turnId: 'turn-7',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Older hydrated turn' }],
        timestamp: '2026-03-10T09:55:00.000Z',
      },
    })

    const store = makeStore()
    await store.dispatch(loadAgentTurnBody({
      sessionId: 'sess-3',
      timelineSessionId: 'cli-sess-3',
      turnId: 'turn-7',
    }))

    expect(getAgentTurnBody).toHaveBeenCalledWith(
      'cli-sess-3',
      'turn-7',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(store.getState().agentChat.sessions['sess-3'].timelineBodies['turn-7']).toEqual(
      expect.objectContaining({
        content: [{ type: 'text', text: 'Older hydrated turn' }],
      }),
    )
  })

  it('pins the snapshot revision onto timeline-page and turn-body restore reads', async () => {
    getAgentTimelinePage.mockResolvedValue({
      sessionId: 'cli-sess-1',
      items: [
        { turnId: 'turn-2', sessionId: 'cli-sess-1', role: 'assistant', summary: 'Latest summary', timestamp: '2026-03-10T10:01:00.000Z' },
      ],
      nextCursor: null,
      revision: 13,
    })
    getAgentTurnBody.mockResolvedValue({
      sessionId: 'cli-sess-1',
      turnId: 'turn-2',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Latest full body' }],
        timestamp: '2026-03-10T10:01:00.000Z',
      },
    })

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
