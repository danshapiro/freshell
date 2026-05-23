import { describe, expect, it } from 'vitest'

import {
  normalizeCodexThreadSnapshot,
  normalizeCodexTurn,
} from '../../../../server/fresh-agent/adapters/codex/normalize.js'

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

    expect(snapshot.capabilities.send).toBe(true)
    expect(snapshot.capabilities.interrupt).toBe(false)
    expect(snapshot.capabilities.fork).toBe(true)
    expect(snapshot.worktrees[0]?.path).toContain('.worktrees')
    expect(snapshot.childThreads[0]?.origin).toBe('subagent')
    expect(snapshot.extensions.codex).toMatchObject({
      review: { id: 'review-1', status: 'pending' },
      fork: { parentThreadId: 'thread-parent-1' },
    })
    expect(snapshot.diffs[0]).toMatchObject({ path: 'src/app.ts' })
  })

  it('surfaces the Codex turn model in the shared turn state', () => {
    const turn = normalizeCodexTurn({
      id: 'turn-1',
      model: 'gpt-5.4-mini',
      items: [
        {
          id: 'item-1',
          type: 'agentMessage',
          text: 'Done',
        },
      ],
    })

    expect(turn).toMatchObject({
      id: 'turn-1',
      turnId: 'turn-1',
      model: 'gpt-5.4-mini',
      role: 'assistant',
      summary: 'Done',
    })
  })

  it('uses the active runtime model as a fallback when Codex omits per-turn model metadata', () => {
    const turn = normalizeCodexTurn({
      id: 'turn-1',
      items: [
        {
          id: 'item-1',
          type: 'agentMessage',
          text: 'Done',
        },
      ],
    }, 0, { model: 'gpt-5.4-mini' })

    expect(turn.model).toBe('gpt-5.4-mini')
  })

  it('marks user-only Codex turns and explains an empty assistant response', () => {
    const turn = normalizeCodexTurn({
      id: 'turn-empty',
      status: 'completed',
      items: [{
        id: 'item-1',
        type: 'userMessage',
        content: [{ type: 'text', text: 'Write a temp file.' }],
      }],
    })

    expect(turn.role).toBe('user')
    expect(turn.items).toEqual([
      { id: 'item-1:part:0', kind: 'text', text: 'Write a temp file.' },
      {
        id: 'turn-empty:empty-response',
        kind: 'text',
        text: 'Codex completed this turn without recording an assistant response.',
      },
    ])
  })

  it('does not add an empty response sentinel to user turns with tool output', () => {
    const turn = normalizeCodexTurn({
      id: 'turn-tool-only',
      status: 'completed',
      items: [
        {
          id: 'item-1',
          type: 'userMessage',
          content: [{ type: 'text', text: 'Write a temp file.' }],
        },
        {
          id: 'item-2',
          type: 'commandExecution',
          command: 'cat temp.txt',
          status: 'completed',
          aggregatedOutput: 'ok',
          exitCode: 0,
        },
      ],
    })

    expect(turn.items.map((item) => item.id)).not.toContain('turn-tool-only:empty-response')
  })

  it('surfaces Codex turn errors in transcript text', () => {
    const turn = normalizeCodexTurn({
      id: 'turn-error',
      status: 'failed',
      error: { message: 'model rejected the request' },
      items: [{
        id: 'item-1',
        type: 'userMessage',
        content: [{ type: 'text', text: 'Do the thing.' }],
      }],
    })

    expect(turn.items.at(-1)).toEqual({
      id: 'turn-error:error',
      kind: 'text',
      text: 'Codex turn failed: model rejected the request',
    })
  })
})
