// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createAgentHistorySource } from '../../../server/agent-timeline/history-source.js'
import type { SdkSessionState } from '../../../server/sdk-bridge-types.js'
import type { ChatMessage } from '../../../server/session-history-loader.js'

function makeMessage(
  role: 'user' | 'assistant',
  text: string,
  options: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    role,
    content: [{ type: 'text', text }],
    timestamp: '2026-04-03T12:00:00.000Z',
    ...options,
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
  it('returns a typed missing outcome instead of null when no restore authority exists', async () => {
    const source = createAgentHistorySource({
      loadSessionHistory: vi.fn().mockResolvedValue(null),
      getLiveSessionBySdkSessionId: vi.fn().mockReturnValue(undefined),
      getLiveSessionByCliSessionId: vi.fn().mockReturnValue(undefined),
    })

    await expect(source.resolve('missing-session')).resolves.toEqual({
      kind: 'missing',
      code: 'RESTORE_NOT_FOUND',
    })
  })

  it('returns a typed merged outcome with canonical turn identity', async () => {
    const source = createAgentHistorySource({
      loadSessionHistory: vi.fn().mockResolvedValue([
        makeMessage('user', 'older durable prompt', { messageId: 'durable-1' }),
      ]),
      getLiveSessionBySdkSessionId: vi.fn().mockReturnValue(makeLiveSession({
        sessionId: 'sdk-1',
        cliSessionId: '00000000-0000-4000-8000-000000000111',
        resumeSessionId: 'named-resume',
        messages: [
          makeMessage('assistant', 'live reply', { messageId: 'live-2' }),
        ],
      })),
      getLiveSessionByCliSessionId: vi.fn(),
      logDivergence: vi.fn(),
    })

    const resolved = await source.resolve('sdk-1')

    expect(resolved).toMatchObject({
      kind: 'resolved',
      readiness: 'merged',
      timelineSessionId: '00000000-0000-4000-8000-000000000111',
      latestTurnId: 'turn:live-2',
      revision: expect.any(Number),
    })
    if (resolved.kind !== 'resolved') throw new Error('expected resolved')
    expect(resolved.turns.map((turn) => ({
      turnId: turn.turnId,
      messageId: turn.messageId,
      ordinal: turn.ordinal,
    }))).toEqual([
      { turnId: 'turn:durable-1', messageId: 'durable-1', ordinal: 0 },
      { turnId: 'turn:live-2', messageId: 'live-2', ordinal: 1 },
    ])
  })

  it('tears down unrecoverable live aliases so stale in-memory authority cannot outlive the session', async () => {
    const liveSession = makeLiveSession({
      sessionId: 'sdk-gone',
      resumeSessionId: 'named-only',
      messages: [makeMessage('user', 'ephemeral', { messageId: 'live-msg-1' })],
    })

    const source = createAgentHistorySource({
      loadSessionHistory: vi.fn().mockResolvedValue(null),
      getLiveSessionBySdkSessionId: vi.fn((queryId: string) => (
        queryId === liveSession.sessionId ? liveSession : undefined
      )),
      getLiveSessionByCliSessionId: vi.fn().mockReturnValue(undefined),
    })

    await expect(source.resolve('sdk-gone')).resolves.toMatchObject({
      kind: 'resolved',
      readiness: 'live_only',
      liveSessionId: 'sdk-gone',
      timelineSessionId: 'named-only',
    })

    await expect(source.resolve('named-only')).resolves.toMatchObject({
      kind: 'resolved',
      readiness: 'live_only',
    })

    source.teardownLiveSession('sdk-gone', { recoverable: false })

    await expect(source.resolve('named-only')).resolves.toEqual({
      kind: 'missing',
      code: 'RESTORE_NOT_FOUND',
    })
  })
})
