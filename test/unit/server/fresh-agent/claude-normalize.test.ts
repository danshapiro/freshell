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
})
