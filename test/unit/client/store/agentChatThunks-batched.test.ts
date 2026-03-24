import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import agentChatReducer from '@/store/agentChatSlice'
import {
  loadAgentTimelineWindow,
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

describe('agentChatThunks batched bodies', () => {
  beforeEach(() => {
    getAgentTimelinePage.mockReset()
    getAgentTurnBody.mockReset()
    _resetAgentChatThunkControllers()
  })

  it('thunk uses inlined bodies when page.bodies is present', async () => {
    getAgentTimelinePage.mockResolvedValue({
      sessionId: 'sess-1',
      items: [
        { turnId: 'turn-2', sessionId: 'sess-1', role: 'assistant', summary: 'Latest', timestamp: '2026-03-10T10:02:00.000Z' },
        { turnId: 'turn-1', sessionId: 'sess-1', role: 'user', summary: 'Older', timestamp: '2026-03-10T10:01:00.000Z' },
      ],
      bodies: {
        'turn-2': {
          sessionId: 'sess-1',
          turnId: 'turn-2',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Inlined body content' }],
            timestamp: '2026-03-10T10:02:00.000Z',
          },
        },
        'turn-1': {
          sessionId: 'sess-1',
          turnId: 'turn-1',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Inlined user content' }],
            timestamp: '2026-03-10T10:01:00.000Z',
          },
        },
      },
      nextCursor: null,
      revision: 2,
    })

    const store = makeStore()
    await store.dispatch(loadAgentTimelineWindow({
      sessionId: 'sess-1',
    }))

    // getAgentTurnBody should NOT have been called since bodies were inlined
    expect(getAgentTurnBody).not.toHaveBeenCalled()

    // The turn body should be in the store from the inlined data
    const session = store.getState().agentChat.sessions['sess-1']
    expect(session.timelineBodies['turn-2']).toEqual(
      expect.objectContaining({
        content: [{ type: 'text', text: 'Inlined body content' }],
      }),
    )
  })

  it('thunk falls back to getAgentTurnBody when page.bodies is absent', async () => {
    getAgentTimelinePage.mockResolvedValue({
      sessionId: 'sess-1',
      items: [
        { turnId: 'turn-0', sessionId: 'sess-1', role: 'user', summary: 'Hello', timestamp: '2026-03-10T10:00:00.000Z' },
      ],
      nextCursor: null,
      revision: 1,
    })
    getAgentTurnBody.mockResolvedValue({
      sessionId: 'sess-1',
      turnId: 'turn-0',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Fetched separately' }],
        timestamp: '2026-03-10T10:00:00.000Z',
      },
    })

    const store = makeStore()
    await store.dispatch(loadAgentTimelineWindow({
      sessionId: 'sess-1',
    }))

    // getAgentTurnBody should have been called (backward compatibility)
    expect(getAgentTurnBody).toHaveBeenCalled()

    const session = store.getState().agentChat.sessions['sess-1']
    expect(session.timelineBodies['turn-0']).toEqual(
      expect.objectContaining({
        content: [{ type: 'text', text: 'Fetched separately' }],
      }),
    )
  })

  it('thunk passes includeBodies: true in the query', async () => {
    getAgentTimelinePage.mockResolvedValue({
      sessionId: 'sess-1',
      items: [],
      nextCursor: null,
      revision: 0,
    })

    const store = makeStore()
    await store.dispatch(loadAgentTimelineWindow({
      sessionId: 'sess-1',
    }))

    expect(getAgentTimelinePage).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ includeBodies: true }),
      expect.anything(),
    )
  })
})
