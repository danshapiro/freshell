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
    })).resolves.toEqual({ sessionId: 'thread-new-1', sessionRef: { provider: 'codex', sessionId: 'thread-new-1' } })

    await expect(adapter.resume?.({
      requestId: 'req-2',
      sessionType: 'freshcodex',
      resumeSessionId: 'thread-resume-1',
      cwd: '/repo',
      permissionMode: 'never',
      model: 'codex-fixture',
    })).resolves.toEqual({ sessionId: 'thread-resume-1', sessionRef: { provider: 'codex', sessionId: 'thread-resume-1' } })

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
    const durableTurn = makeCodexTurn('turn-1')
    const expectedFullItem = expect.objectContaining({ kind: 'text', text: 'Codex summary' })
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      readThread: vi.fn().mockResolvedValue({
        thread: {
          ...makeCodexThread('thread-new-1'),
          turns: [durableTurn],
        },
      }),
      listThreadTurns: vi.fn().mockResolvedValue({
        revision: 7,
        nextCursor: null,
        turns: [durableTurn],
      }),
      readThreadTurn: vi.fn().mockResolvedValue(durableTurn),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    await expect(adapter.getSnapshot?.({ sessionType: 'freshcodex', provider: 'codex', threadId: 'thread-new-1' }, 7)).resolves.toMatchObject({
      provider: 'codex',
      threadId: 'thread-new-1',
      revision: 7,
      turns: [{ id: 'turn-1', turnId: 'turn-1' }],
    })
    expect(runtime.readThread).toHaveBeenCalledWith({ threadId: 'thread-new-1', includeTurns: true })
    await expect(adapter.getTurnPage?.({ sessionType: 'freshcodex', provider: 'codex', threadId: 'thread-new-1' }, { revision: 7 })).resolves.toMatchObject({
      revision: 7,
      turns: [{ id: 'turn-1', turnId: 'turn-1', items: [expectedFullItem] }],
      bodies: { 'turn-1': expect.objectContaining({ items: [expectedFullItem] }) },
    })
    await expect(adapter.getTurnBody?.({ sessionType: 'freshcodex', provider: 'codex', threadId: 'thread-new-1', turnId: 'turn-1' }, 7)).resolves.toMatchObject({
      turnId: 'turn-1',
      revision: 7,
      items: [expectedFullItem],
    })
  })

  it('subscribes to Codex lifecycle notifications and projects matching thread updates', async () => {
    let lifecycleHandler: ((event: any) => void) | undefined
    const off = vi.fn()
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      onThreadLifecycle: vi.fn((handler) => {
        lifecycleHandler = handler
        return off
      }),
      readThread: vi.fn(),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })
    const listener = vi.fn()

    const unsubscribe = await adapter.subscribe?.('thread-new-1', listener)

    expect(runtime.onThreadLifecycle).toHaveBeenCalledWith(expect.any(Function))

    lifecycleHandler?.({
      kind: 'thread_status_changed',
      threadId: 'other-thread',
      status: { type: 'active', activeFlags: [] },
    })
    expect(listener).not.toHaveBeenCalled()

    lifecycleHandler?.({
      kind: 'thread_status_changed',
      threadId: 'thread-new-1',
      status: { type: 'active', activeFlags: [] },
    })
    lifecycleHandler?.({
      kind: 'thread_status_changed',
      threadId: 'thread-new-1',
      status: { type: 'idle' },
    })
    lifecycleHandler?.({
      kind: 'thread_closed',
      threadId: 'thread-new-1',
    })

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: 'sdk.session.snapshot',
      sessionId: 'thread-new-1',
      status: 'running',
    }))
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: 'sdk.session.snapshot',
      sessionId: 'thread-new-1',
      status: 'idle',
    }))
    expect(listener).toHaveBeenCalledWith({
      type: 'sdk.status',
      sessionId: 'thread-new-1',
      status: 'exited',
    })

    unsubscribe?.()
    expect(off).toHaveBeenCalledTimes(1)
  })

  it('starts turns with Codex-shaped input/settings and interrupts the active turn', async () => {
    const runtime = {
      startThread: vi.fn().mockResolvedValue({
        threadId: 'thread-new-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      resumeThread: vi.fn(),
      forkThread: vi.fn(),
      startTurn: vi.fn().mockResolvedValue({ turnId: 'turn-active-1' }),
      interruptTurn: vi.fn().mockResolvedValue(undefined),
      readThread: vi.fn(),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    await adapter.create({
      requestId: 'req-1',
      sessionType: 'freshcodex',
      cwd: '/repo',
      permissionMode: 'on-request',
      sandbox: 'workspace-write',
      effort: 'xhigh',
      model: 'codex-fixture',
    })

    await adapter.send?.('thread-new-1', {
      text: 'Review this image',
      images: [{ kind: 'data', mediaType: 'image/png', data: 'abc123' }],
    })
    await adapter.interrupt?.('thread-new-1')

    expect(runtime.startTurn).toHaveBeenCalledWith({
      threadId: 'thread-new-1',
      input: [
        { type: 'text', text: 'Review this image', text_elements: [] },
        { type: 'image', url: 'data:image/png;base64,abc123' },
      ],
      cwd: '/repo',
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'workspaceWrite' },
      model: 'codex-fixture',
      effort: 'xhigh',
    })
    expect(runtime.interruptTurn).toHaveBeenCalledWith({
      threadId: 'thread-new-1',
      turnId: 'turn-active-1',
    })
  })

  it('rejects Claude-only Freshcodex effort values before app-server calls', async () => {
    const runtime = {
      startThread: vi.fn().mockResolvedValue({
        threadId: 'thread-new-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      resumeThread: vi.fn(),
      forkThread: vi.fn(),
      startTurn: vi.fn(),
      interruptTurn: vi.fn(),
      readThread: vi.fn(),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    await expect(adapter.create({
      requestId: 'req-1',
      sessionType: 'freshcodex',
      effort: 'max',
    })).rejects.toThrow('Freshcodex does not support reasoning effort "max"')
    expect(runtime.startThread).not.toHaveBeenCalled()
    expect(runtime.startTurn).not.toHaveBeenCalled()
  })

  it('forks Codex threads with stored runtime settings and excludeTurns', async () => {
    const runtime = {
      startThread: vi.fn().mockResolvedValue({
        threadId: 'thread-new-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      resumeThread: vi.fn(),
      forkThread: vi.fn().mockResolvedValue({
        threadId: 'thread-fork-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      startTurn: vi.fn(),
      interruptTurn: vi.fn(),
      readThread: vi.fn(),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    await adapter.create({
      requestId: 'req-1',
      sessionType: 'freshcodex',
      cwd: '/repo',
      model: 'codex-fixture',
      permissionMode: 'never',
      sandbox: 'read-only',
    })

    await expect(adapter.fork?.('thread-new-1')).resolves.toEqual({
      threadId: 'thread-fork-1',
      wsUrl: 'ws://127.0.0.1:43123',
    })
    expect(runtime.forkThread).toHaveBeenCalledWith({
      threadId: 'thread-new-1',
      cwd: '/repo',
      model: 'codex-fixture',
      sandbox: 'read-only',
      approvalPolicy: 'never',
      excludeTurns: true,
    })
  })
})
