// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createAgentHistorySource } from '../../../server/agent-timeline/history-source.js'
import type { SdkSessionState } from '../../../server/sdk-bridge-types.js'
import type { ChatMessage } from '../../../server/session-history-loader.js'

function makeMessage(
  role: 'user' | 'assistant',
  text: string,
  timestamp?: string,
): ChatMessage {
  return {
    role,
    content: [{ type: 'text', text }],
    ...(timestamp ? { timestamp } : {}),
  }
}

function makeLiveSession(
  overrides: Partial<SdkSessionState> & Pick<SdkSessionState, 'sessionId' | 'messages'>,
): SdkSessionState {
  return {
    sessionId: overrides.sessionId,
    status: 'running',
    createdAt: 1,
    messages: overrides.messages,
    streamingActive: false,
    streamingText: '',
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    costUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    ...overrides,
  }
}

describe('agent timeline history source', () => {
  it('appends live post-resume delta onto durable backlog', async () => {
    const source = createAgentHistorySource({
      loadSessionHistory: vi.fn().mockResolvedValue([
        makeMessage('user', 'older question'),
        makeMessage('assistant', 'older answer'),
      ]),
      getLiveSessionBySdkSessionId: vi.fn().mockReturnValue(makeLiveSession({
        sessionId: 'sdk-1',
        resumeSessionId: '00000000-0000-4000-8000-000000000001',
        messages: [
          makeMessage('user', 'new prompt'),
          makeMessage('assistant', 'new reply'),
        ],
      })),
      getLiveSessionByCliSessionId: vi.fn(),
      logDivergence: vi.fn(),
    })

    const resolved = await source.resolve('sdk-1')

    expect(resolved?.timelineSessionId).toBe('00000000-0000-4000-8000-000000000001')
    expect(resolved?.messages).toEqual([
      makeMessage('user', 'older question'),
      makeMessage('assistant', 'older answer'),
      makeMessage('user', 'new prompt'),
      makeMessage('assistant', 'new reply'),
    ])
  })

  it('de-duplicates the overlap when durable history has already flushed the first live delta turn', async () => {
    const source = createAgentHistorySource({
      loadSessionHistory: vi.fn().mockResolvedValue([
        makeMessage('user', 'older question'),
        makeMessage('assistant', 'older answer'),
        makeMessage('user', 'new prompt', '2026-03-10T10:01:00.000Z'),
      ]),
      getLiveSessionBySdkSessionId: vi.fn().mockReturnValue(makeLiveSession({
        sessionId: 'sdk-2',
        resumeSessionId: '00000000-0000-4000-8000-000000000002',
        messages: [
          makeMessage('user', 'new prompt', '2026-03-10T10:01:00.000Z'),
          makeMessage('assistant', 'new reply'),
        ],
      })),
      getLiveSessionByCliSessionId: vi.fn(),
      logDivergence: vi.fn(),
    })

    const resolved = await source.resolve('sdk-2')
    expect(resolved?.messages).toEqual([
      makeMessage('user', 'older question'),
      makeMessage('assistant', 'older answer'),
      makeMessage('user', 'new prompt', '2026-03-10T10:01:00.000Z'),
      makeMessage('assistant', 'new reply'),
    ])
  })

  it('keeps an ambiguous repeated single-message prompt when timestamps show it is a new turn', async () => {
    const source = createAgentHistorySource({
      loadSessionHistory: vi.fn().mockResolvedValue([
        makeMessage('user', 'continue', '2026-03-10T10:00:00.000Z'),
      ]),
      getLiveSessionBySdkSessionId: vi.fn().mockReturnValue(makeLiveSession({
        sessionId: 'sdk-ambiguous',
        resumeSessionId: '00000000-0000-4000-8000-000000000003',
        messages: [
          makeMessage('user', 'continue', '2026-03-10T10:15:00.000Z'),
          makeMessage('assistant', 'new reply', '2026-03-10T10:15:05.000Z'),
        ],
      })),
      getLiveSessionByCliSessionId: vi.fn(),
      logDivergence: vi.fn(),
    })

    const resolved = await source.resolve('sdk-ambiguous')
    expect(resolved?.messages).toEqual([
      makeMessage('user', 'continue', '2026-03-10T10:00:00.000Z'),
      makeMessage('user', 'continue', '2026-03-10T10:15:00.000Z'),
      makeMessage('assistant', 'new reply', '2026-03-10T10:15:05.000Z'),
    ])
  })

  it('keeps a repeated single-message prompt when the timestamps differ by seconds', async () => {
    const source = createAgentHistorySource({
      loadSessionHistory: vi.fn().mockResolvedValue([
        makeMessage('user', 'continue', '2026-03-10T10:00:00.000Z'),
      ]),
      getLiveSessionBySdkSessionId: vi.fn().mockReturnValue(makeLiveSession({
        sessionId: 'sdk-seconds-apart',
        resumeSessionId: '00000000-0000-4000-8000-000000000031',
        messages: [
          makeMessage('user', 'continue', '2026-03-10T10:00:30.000Z'),
          makeMessage('assistant', 'new reply', '2026-03-10T10:00:35.000Z'),
        ],
      })),
      getLiveSessionByCliSessionId: vi.fn(),
      logDivergence: vi.fn(),
    })

    const resolved = await source.resolve('sdk-seconds-apart')
    expect(resolved?.messages).toEqual([
      makeMessage('user', 'continue', '2026-03-10T10:00:00.000Z'),
      makeMessage('user', 'continue', '2026-03-10T10:00:30.000Z'),
      makeMessage('assistant', 'new reply', '2026-03-10T10:00:35.000Z'),
    ])
  })

  it('keeps a repeated single-message prompt when timestamp evidence is missing on one side and logs the ambiguity', async () => {
    const logDivergence = vi.fn()
    const source = createAgentHistorySource({
      loadSessionHistory: vi.fn().mockResolvedValue([
        makeMessage('user', 'continue', '2026-03-10T10:00:00.000Z'),
      ]),
      getLiveSessionBySdkSessionId: vi.fn().mockReturnValue(makeLiveSession({
        sessionId: 'sdk-missing-ts',
        resumeSessionId: '00000000-0000-4000-8000-000000000099',
        messages: [
          makeMessage('user', 'continue'),
          makeMessage('assistant', 'new reply', '2026-03-10T10:15:05.000Z'),
        ],
      })),
      getLiveSessionByCliSessionId: vi.fn(),
      logDivergence,
    })

    const resolved = await source.resolve('sdk-missing-ts')
    expect(resolved?.messages).toEqual([
      makeMessage('user', 'continue', '2026-03-10T10:00:00.000Z'),
      makeMessage('user', 'continue'),
      makeMessage('assistant', 'new reply', '2026-03-10T10:15:05.000Z'),
    ])
    expect(logDivergence).toHaveBeenCalledWith(expect.objectContaining({
      queryId: 'sdk-missing-ts',
      sdkSessionId: 'sdk-missing-ts',
      timelineSessionId: '00000000-0000-4000-8000-000000000099',
      liveMode: 'delta',
      liveCount: 2,
      durableCount: 1,
      reason: 'ambiguous_overlap',
    }))
  })

  it('keeps a repeated single-message prompt when both copies are timestamp-less and logs the ambiguity', async () => {
    const logDivergence = vi.fn()
    const source = createAgentHistorySource({
      loadSessionHistory: vi.fn().mockResolvedValue([
        makeMessage('user', 'continue'),
      ]),
      getLiveSessionBySdkSessionId: vi.fn().mockReturnValue(makeLiveSession({
        sessionId: 'sdk-no-ts',
        resumeSessionId: '00000000-0000-4000-8000-000000000555',
        messages: [
          makeMessage('user', 'continue'),
          makeMessage('assistant', 'reply'),
        ],
      })),
      getLiveSessionByCliSessionId: vi.fn(),
      logDivergence,
    })

    const resolved = await source.resolve('sdk-no-ts')
    expect(resolved?.messages).toEqual([
      makeMessage('user', 'continue'),
      makeMessage('user', 'continue'),
      makeMessage('assistant', 'reply'),
    ])
    expect(logDivergence).toHaveBeenCalledWith(expect.objectContaining({
      queryId: 'sdk-no-ts',
      sdkSessionId: 'sdk-no-ts',
      timelineSessionId: '00000000-0000-4000-8000-000000000555',
      liveMode: 'delta',
      liveCount: 2,
      durableCount: 1,
      reason: 'ambiguous_overlap',
    }))
  })

  it('logs resumed-delta conflicts instead of silently weaving contradictory durable and live turns', async () => {
    const logDivergence = vi.fn()
    const source = createAgentHistorySource({
      loadSessionHistory: vi.fn().mockResolvedValue([
        makeMessage('user', 'older durable turn'),
      ]),
      getLiveSessionBySdkSessionId: vi.fn().mockReturnValue(makeLiveSession({
        sessionId: 'sdk-conflict',
        resumeSessionId: '00000000-0000-4000-8000-000000000556',
        messages: [
          makeMessage('assistant', 'contradictory live turn'),
        ],
      })),
      getLiveSessionByCliSessionId: vi.fn(),
      logDivergence,
    })

    const resolved = await source.resolve('sdk-conflict')
    expect(resolved?.messages).toEqual([
      makeMessage('user', 'older durable turn'),
      makeMessage('assistant', 'contradictory live turn'),
    ])
    expect(logDivergence).toHaveBeenCalledWith(expect.objectContaining({
      queryId: 'sdk-conflict',
      sdkSessionId: 'sdk-conflict',
      timelineSessionId: '00000000-0000-4000-8000-000000000556',
      liveMode: 'delta',
      liveCount: 1,
      durableCount: 1,
      reason: 'conflict',
    }))
  })

  it('prefers the live full transcript when a fresh session has outrun durable JSONL', async () => {
    const source = createAgentHistorySource({
      loadSessionHistory: vi.fn().mockResolvedValue([
        makeMessage('user', 'prompt'),
      ]),
      getLiveSessionBySdkSessionId: vi.fn().mockReturnValue(makeLiveSession({
        sessionId: 'sdk-3',
        cliSessionId: '00000000-0000-4000-8000-000000000004',
        messages: [
          makeMessage('user', 'prompt'),
          makeMessage('assistant', 'reply'),
        ],
      })),
      getLiveSessionByCliSessionId: vi.fn(),
      logDivergence: vi.fn(),
    })

    const resolved = await source.resolve('sdk-3')
    expect(resolved?.timelineSessionId).toBe('00000000-0000-4000-8000-000000000004')
    expect(resolved?.messages).toEqual([
      makeMessage('user', 'prompt'),
      makeMessage('assistant', 'reply'),
    ])
  })

  it('keeps named resume targets live-only until a durable Claude UUID is known', async () => {
    const loadSessionHistory = vi.fn()
    const source = createAgentHistorySource({
      loadSessionHistory,
      getLiveSessionBySdkSessionId: vi.fn().mockReturnValue(makeLiveSession({
        sessionId: 'sdk-named',
        resumeSessionId: 'worktree-hotfix',
        messages: [
          makeMessage('user', 'resume me'),
          makeMessage('assistant', 'still live only'),
        ],
      })),
      getLiveSessionByCliSessionId: vi.fn(),
      logDivergence: vi.fn(),
    })

    const resolved = await source.resolve('sdk-named')

    expect(loadSessionHistory).not.toHaveBeenCalled()
    expect(resolved?.timelineSessionId).toBeUndefined()
    expect(resolved?.messages).toEqual([
      makeMessage('user', 'resume me'),
      makeMessage('assistant', 'still live only'),
    ])
  })

  it('returns durable-only history after restart when no live session exists', async () => {
    const source = createAgentHistorySource({
      loadSessionHistory: vi.fn().mockResolvedValue([
        makeMessage('user', 'persisted'),
        makeMessage('assistant', 'persisted reply'),
      ]),
      getLiveSessionBySdkSessionId: vi.fn().mockReturnValue(undefined),
      getLiveSessionByCliSessionId: vi.fn().mockReturnValue(undefined),
      logDivergence: vi.fn(),
    })

    const resolved = await source.resolve('00000000-0000-4000-8000-000000000123')
    expect(resolved?.timelineSessionId).toBe('00000000-0000-4000-8000-000000000123')
    expect(resolved?.messages).toHaveLength(2)
  })
})
