import { describe, expect, it } from 'vitest'

import { normalizeCodexThreadSnapshot } from '../../../../server/fresh-agent/adapters/codex/normalize.js'

describe('Codex fresh-agent normalization', () => {
  it('normalizes codex fork, review, worktree, and child-thread metadata into the shared snapshot', () => {
    const snapshot = normalizeCodexThreadSnapshot({
      threadId: 'thread-codex-1',
      revision: 7,
      status: 'idle',
      transcript: {
        turns: [
          {
            id: 'turn-1',
            turnId: 'turn-1',
            messageId: 'msg-1',
            ordinal: 0,
            source: 'durable',
            role: 'assistant',
            summary: 'Codex finished a review pass',
            items: [{ id: 'turn-1:item-0', kind: 'text', text: 'Codex finished a review pass.' }],
          },
        ],
      },
      rawSnapshot: {
        summary: 'Codex finished a review pass',
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 6,
          cachedTokens: 2,
          totalTokens: 18,
          contextTokens: 18,
          compactPercent: 4,
        },
        worktrees: [{ id: 'wt-1', path: '/repo/.worktrees/task-1', branch: 'feature/task-1' }],
        diffs: [{ id: 'diff-1', path: 'src/app.ts', title: 'src/app.ts' }],
        childThreads: [{ id: 'child-1', threadId: 'thread-child-1', origin: 'subagent', title: 'Review shell' }],
        extension: {
          codex: {
            review: { id: 'review-1', status: 'pending' },
            fork: { parentThreadId: 'thread-parent-1' },
          },
        },
      },
    })

    expect(snapshot.capabilities.send).toBe(false)
    expect(snapshot.capabilities.interrupt).toBe(false)
    expect(snapshot.capabilities.fork).toBe(false)
    expect(snapshot.worktrees[0]?.path).toContain('.worktrees')
    expect(snapshot.childThreads[0]?.origin).toBe('subagent')
    expect(snapshot.extensions.codex).toMatchObject({
      review: { id: 'review-1', status: 'pending' },
      fork: { parentThreadId: 'thread-parent-1' },
    })
    expect(snapshot.diffs[0]).toMatchObject({ path: 'src/app.ts' })
  })
})
