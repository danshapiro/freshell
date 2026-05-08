import { describe, expect, it, vi } from 'vitest'

import { createCodexFreshAgentAdapter } from '../../../../server/fresh-agent/adapters/codex/adapter.js'

function makeCodexThread(id: string) {
  return {
    id,
    sessionId: id,
    preview: 'Codex summary',
    ephemeral: false,
    modelProvider: 'openai',
    createdAt: 1770000000,
    updatedAt: 7,
    status: { type: 'idle' },
    cwd: '/repo',
    cliVersion: 'codex-cli 0.129.0',
    source: 'appServer',
    turns: [],
  }
}

function makeCodexTurn(id: string) {
  return {
    id,
    status: 'completed',
    items: [{
      type: 'agentMessage',
      id: `${id}:item-1`,
      text: 'Codex summary',
      phase: null,
      memoryCitation: null,
    }],
  }
}

describe('Codex fresh-agent adapter', () => {
  it('starts fresh Codex threads with generated app-server params', async () => {
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
        thread: makeCodexThread('thread-new-1'),
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
      permissionMode: 'on-request',
      model: 'codex-fixture',
    })).resolves.toEqual({ sessionId: 'thread-new-1' })

    await expect(adapter.resume?.({
      requestId: 'req-2',
      sessionType: 'freshcodex',
      resumeSessionId: 'thread-resume-1',
      cwd: '/repo',
      permissionMode: 'never',
      model: 'codex-fixture',
    })).resolves.toEqual({ sessionId: 'thread-resume-1' })

    expect(runtime.startThread).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo',
      model: 'codex-fixture',
      approvalPolicy: 'on-request',
    }))
    expect(runtime.resumeThread).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-resume-1',
      cwd: '/repo',
      model: 'codex-fixture',
      approvalPolicy: 'never',
    }))
  })

  it('fails clearly for Claude-only Freshcodex approval policies', async () => {
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      readThread: vi.fn(),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    await expect(adapter.create({
      requestId: 'req-1',
      sessionType: 'freshcodex',
      permissionMode: 'bypassPermissions',
    })).rejects.toThrow('Freshcodex does not support approval policy "bypassPermissions"')
    expect(runtime.startThread).not.toHaveBeenCalled()
  })

  it('reads snapshots and turns from the official Codex thread APIs', async () => {
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      readThread: vi.fn().mockResolvedValue({
        thread: makeCodexThread('thread-new-1'),
      }),
      listThreadTurns: vi.fn().mockResolvedValue({
        revision: 7,
        nextCursor: null,
        turns: [makeCodexTurn('turn-1')],
      }),
      readThreadTurn: vi.fn().mockResolvedValue(makeCodexTurn('turn-1')),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    await expect(adapter.getSnapshot?.({ sessionType: 'freshcodex', provider: 'codex', threadId: 'thread-new-1' }, 7)).resolves.toMatchObject({
      provider: 'codex',
      threadId: 'thread-new-1',
      revision: 7,
    })
    await expect(adapter.getTurnPage?.({ sessionType: 'freshcodex', provider: 'codex', threadId: 'thread-new-1' }, { revision: 7 })).resolves.toMatchObject({
      revision: 7,
      turns: [{ id: 'turn-1', turnId: 'turn-1' }],
    })
    await expect(adapter.getTurnBody?.({ sessionType: 'freshcodex', provider: 'codex', threadId: 'thread-new-1', turnId: 'turn-1' }, 7)).resolves.toMatchObject({
      turnId: 'turn-1',
      revision: 7,
    })
  })
})
