import { describe, expect, it, vi } from 'vitest'

import { createCodexFreshAgentAdapter } from '../../../../server/fresh-agent/adapters/codex/adapter.js'

describe('Codex fresh-agent adapter', () => {
  it('starts fresh rich codex threads with raw events enabled', async () => {
    const runtime = {
      startThread: vi.fn().mockResolvedValue({
        threadId: 'thread-new-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      resumeThread: vi.fn().mockResolvedValue({
        threadId: 'thread-resume-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      readThread: vi.fn().mockResolvedValue({
        threadId: 'thread-new-1',
        revision: 7,
        status: 'idle',
        summary: 'Codex summary',
        turns: [],
        tokenUsage: { inputTokens: 1, outputTokens: 2, cachedTokens: 0, totalTokens: 3 },
        worktrees: [],
        diffs: [],
        childThreads: [],
        extension: { codex: {} },
      }),
      listThreadTurns: vi.fn().mockResolvedValue({ turns: [], nextCursor: null, revision: 7 }),
      readThreadTurn: vi.fn().mockResolvedValue(null),
    }
    const adapter = createCodexFreshAgentAdapter({
      runtime: runtime as any,
    })

    await expect(adapter.create({
      requestId: 'req-1',
      sessionType: 'freshcodex',
      cwd: '/repo',
    })).resolves.toEqual({ sessionId: 'thread-new-1' })

    await expect(adapter.resume?.({
      requestId: 'req-2',
      sessionType: 'freshcodex',
      resumeSessionId: 'thread-resume-1',
      cwd: '/repo',
    })).resolves.toEqual({ sessionId: 'thread-resume-1' })

    expect(runtime.startThread).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo',
      richClient: true,
    }))
    expect(runtime.resumeThread).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-resume-1',
      cwd: '/repo',
      richClient: true,
    }))
  })

  it('reads snapshots and turns from the official Codex thread APIs', async () => {
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      readThread: vi.fn().mockResolvedValue({
        threadId: 'thread-new-1',
        revision: 7,
        status: 'idle',
        summary: 'Codex summary',
        turns: [],
        tokenUsage: { inputTokens: 1, outputTokens: 2, cachedTokens: 0, totalTokens: 3 },
        worktrees: [],
        diffs: [],
        childThreads: [],
        extension: { codex: {} },
      }),
      listThreadTurns: vi.fn().mockResolvedValue({
        revision: 7,
        nextCursor: null,
        turns: [{ turnId: 'turn-1' }],
      }),
      readThreadTurn: vi.fn().mockResolvedValue({
        turnId: 'turn-1',
        revision: 7,
      }),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    await expect(adapter.getSnapshot?.({ provider: 'codex', threadId: 'thread-new-1' }, 7)).resolves.toMatchObject({
      provider: 'codex',
      threadId: 'thread-new-1',
      revision: 7,
    })
    await expect(adapter.getTurnPage?.({ provider: 'codex', threadId: 'thread-new-1' }, { revision: 7 })).resolves.toMatchObject({
      revision: 7,
      turns: [{ turnId: 'turn-1' }],
    })
    await expect(adapter.getTurnBody?.({ provider: 'codex', threadId: 'thread-new-1', turnId: 'turn-1' }, 7)).resolves.toMatchObject({
      turnId: 'turn-1',
      revision: 7,
    })
  })
})
