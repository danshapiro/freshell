import { describe, expect, it, vi } from 'vitest'

import { createClaudeFreshAgentHistorySource } from '../../../../server/fresh-agent/history/claude/history-source.js'
import { createClaudeFreshAgentHistoryService } from '../../../../server/fresh-agent/history/claude/history-service.js'
import { createClaudeFreshAgentAdapter } from '../../../../server/fresh-agent/adapters/claude/adapter.js'
import { makeClaudeLiveSession } from '../../../fixtures/fresh-agent/claude/thread.js'
import type { ChatMessage } from '../../../../server/session-history-loader.js'

function makeMessage(
  role: 'user' | 'assistant',
  text: string,
  options: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    role,
    content: [{ type: 'text', text }],
    timestamp: '2026-04-18T12:00:00.000Z',
    ...options,
  }
}

describe('Claude fresh-agent restore contract', () => {
  it('merges ledger-backed restore state and live stream into one canonical snapshot', async () => {
    const liveSession = makeClaudeLiveSession({
      messages: [
        makeMessage('assistant', 'Live reply', { messageId: 'live-2' }),
      ],
    })
    const historySource = createClaudeFreshAgentHistorySource({
      loadSessionHistory: vi.fn().mockResolvedValue([
        makeMessage('user', 'Durable prompt', { messageId: 'durable-1' }),
      ]),
      getLiveSessionBySdkSessionId: vi.fn((sessionId: string) => (
        sessionId === 'sdk-claude-1' ? liveSession : undefined
      )),
      getLiveSessionByCliSessionId: vi.fn((sessionId: string) => (
        sessionId === '00000000-0000-4000-8000-000000000111' ? liveSession : undefined
      )),
    })
    const timelineService = createClaudeFreshAgentHistoryService({
      agentHistorySource: historySource,
    })
    const adapter = createClaudeFreshAgentAdapter({
      sdkBridge: {
        getSession: vi.fn((sessionId: string) => (sessionId === 'sdk-claude-1' ? liveSession : undefined)),
        findSessionByCliSessionId: vi.fn((sessionId: string) => (
          sessionId === '00000000-0000-4000-8000-000000000111' ? liveSession : undefined
        )),
      } as any,
      agentHistorySource: historySource,
      timelineService,
    })

    const snapshot = await adapter.getSnapshot?.({
      sessionType: 'freshclaude',
      provider: 'claude',
      threadId: 'sdk-claude-1',
    })

    expect(snapshot).toMatchObject({
      provider: 'claude',
      threadId: 'sdk-claude-1',
      revision: expect.any(Number),
      latestTurnId: 'turn:live-2',
    })
    expect(snapshot?.turns.map((turn: { source: string }) => turn.source)).toEqual(['durable', 'live'])
    expect(snapshot?.extensions.claude).toMatchObject({
      timelineSessionId: '00000000-0000-4000-8000-000000000111',
      readiness: 'merged',
    })
  })
})
