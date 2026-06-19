import { describe, expect, it } from 'vitest'

import { normalizeClaudeThreadSnapshot } from '../../../../server/fresh-agent/adapters/claude/normalize.js'
import { makeClaudeLiveSession, makeClaudeRestoreResolution } from '../../../fixtures/fresh-agent/claude/thread.js'

describe('Claude fresh-agent normalization', () => {
  it('normalizes Claude block messages into shared fresh-agent items and metadata', () => {
    const snapshot = normalizeClaudeThreadSnapshot({
      threadId: 'sdk-claude-1',
      liveSession: makeClaudeLiveSession(),
      resolved: makeClaudeRestoreResolution(),
      status: 'running',
    })

    expect(snapshot.turns.map((turn) => turn.source)).toEqual(['durable', 'live'])
    expect(snapshot.turns[1]?.items.map((item) => item.kind)).toEqual([
      'thinking',
      'tool_use',
      'tool_result',
      'text',
    ])
    expect(snapshot.pendingApprovals).toEqual([
      expect.objectContaining({
        requestId: 'approval-1',
        toolName: 'Bash',
        decisionReason: 'Needs approval',
      }),
    ])
    expect(snapshot.pendingQuestions).toEqual([
      expect.objectContaining({
        requestId: 'question-1',
      }),
    ])
    expect(snapshot.settings).toMatchObject({
      model: 'claude-sonnet-4-5-20250929',
      permissionMode: 'plan',
      plugins: ['/tmp/plugin-a', '/tmp/plugin-b'],
    })
    expect(snapshot.tokenUsage).toEqual({
      inputTokens: 12,
      outputTokens: 34,
      totalTokens: 46,
      costUsd: 1.25,
    })
  })

  it('keeps user and assistant messages as separate display turns with their native turnIds', () => {
    const snapshot = normalizeClaudeThreadSnapshot({
      threadId: 'sdk-claude-invariant',
      resolved: {
        kind: 'resolved',
        queryId: 'sdk-claude-invariant',
        liveSessionId: 'sdk-claude-invariant',
        timelineSessionId: '00000000-0000-4000-8000-000000000222',
        readiness: 'merged',
        revision: 2,
        latestTurnId: 'turn:assistant-1',
        turns: [
          {
            sessionId: '00000000-0000-4000-8000-000000000222',
            turnId: 'turn:user-1',
            messageId: 'user-1',
            ordinal: 0,
            source: 'durable',
            message: {
              role: 'user',
              content: [{ type: 'text', text: 'Inspect the config.' }],
              timestamp: '2026-04-18T12:00:00.000Z',
              messageId: 'user-1',
            },
          },
          {
            sessionId: '00000000-0000-4000-8000-000000000222',
            turnId: 'turn:assistant-1',
            messageId: 'assistant-1',
            ordinal: 1,
            source: 'durable',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Inspecting the config now.' }],
              timestamp: '2026-04-18T12:00:01.000Z',
              messageId: 'assistant-1',
            },
          },
        ],
      },
      status: 'running',
    })

    expect(snapshot.turns).toHaveLength(2)
    expect(snapshot.turns).toMatchObject([
      { turnId: 'turn:user-1', messageId: 'user-1', role: 'user', summary: 'Inspect the config.' },
      { turnId: 'turn:assistant-1', messageId: 'assistant-1', role: 'assistant', summary: 'Inspecting the config now.' },
    ])
  })
})
