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
    }
    const adapter = createCodexFreshAgentAdapter({
      runtime: runtime as any,
      readStore: {
        getSnapshot: vi.fn().mockResolvedValue({
          summary: 'Codex summary',
          tokenUsage: { inputTokens: 1, outputTokens: 2, cachedTokens: 0, totalTokens: 3 },
          worktrees: [],
          diffs: [],
          childThreads: [],
          extension: { codex: {} },
        }),
        getTurnPage: vi.fn().mockResolvedValue({ turns: [], nextCursor: null }),
        getTurnBody: vi.fn().mockResolvedValue(null),
      } as any,
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
})
