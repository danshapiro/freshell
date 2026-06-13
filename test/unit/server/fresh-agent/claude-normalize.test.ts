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

  it('drops Claude skill instruction payloads serialized as user messages', () => {
    const resolved = makeClaudeRestoreResolution()
    resolved.turns = [
      {
        turnId: 'turn:user-request',
        messageId: 'user-request',
        ordinal: 0,
        source: 'durable',
        message: {
          role: 'user',
          timestamp: '2026-04-18T12:00:00.000Z',
          content: [{ type: 'text', text: 'Review this plan with fresheyes.' }],
        },
      },
      {
        turnId: 'turn:assistant-tool',
        messageId: 'assistant-tool',
        ordinal: 1,
        source: 'durable',
        message: {
          role: 'assistant',
          timestamp: '2026-04-18T12:00:01.000Z',
          content: [
            {
              type: 'tool_use',
              id: 'tool-skill',
              name: 'Skill',
              input: { skill: 'fresheyes' },
            },
          ],
        },
      },
      {
        turnId: 'turn:skill-payload',
        messageId: 'skill-payload',
        ordinal: 2,
        source: 'durable',
        message: {
          role: 'user',
          timestamp: '2026-04-18T12:00:02.000Z',
          content: [{
            type: 'text',
            text: [
              'Base directory for this skill: /home/dan/.claude/skills/fresheyes',
              '',
              '# Fresh Eyes - Independent Code Review',
              '',
              'Invoke an independent model to perform a code review.',
            ].join('\n'),
          }],
        },
      },
    ]

    const snapshot = normalizeClaudeThreadSnapshot({
      threadId: 'sdk-claude-1',
      resolved,
      status: 'idle',
    })

    expect(snapshot.turns.map((turn) => turn.turnId)).toEqual([
      'turn:user-request',
      'turn:assistant-tool',
    ])
    expect(snapshot.turns.map((turn) => turn.role)).toEqual(['user', 'assistant'])
    expect(snapshot.turns[0]?.items).toEqual([
      expect.objectContaining({ kind: 'text', text: 'Review this plan with fresheyes.' }),
    ])
    expect(JSON.stringify(snapshot.turns)).not.toContain('Base directory for this skill')
    expect(JSON.stringify(snapshot.turns)).not.toContain('Fresh Eyes - Independent Code Review')
  })
})
