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
  it('allocates separate runtimes for fresh Codex threads in different cwd values', async () => {
    const runtimes = ['/repo/one', '/repo/two'].map((cwd, index) => ({
      startThread: vi.fn().mockImplementation(async (input) => {
        if (input.cwd !== cwd) {
          throw new Error(`runtime ${index + 1} received unexpected cwd ${input.cwd}`)
        }
        return {
          threadId: `thread-${index + 1}`,
          wsUrl: `ws://127.0.0.1:${43000 + index}`,
        }
      }),
      resumeThread: vi.fn(),
      readThread: vi.fn(),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }))
    const runtimeFactory = vi.fn()
      .mockReturnValueOnce(runtimes[0])
      .mockReturnValueOnce(runtimes[1])
    const adapter = createCodexFreshAgentAdapter({ runtimeFactory: runtimeFactory as any })

    await expect(adapter.create({
      requestId: 'req-1',
      sessionType: 'freshcodex',
      cwd: '/repo/one',
    })).resolves.toMatchObject({ sessionId: 'thread-1' })
    await expect(adapter.create({
      requestId: 'req-2',
      sessionType: 'freshcodex',
      cwd: '/repo/two',
    })).resolves.toMatchObject({ sessionId: 'thread-2' })

    expect(runtimeFactory).toHaveBeenCalledTimes(2)
    expect(runtimes[0].startThread).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/repo/one' }))
    expect(runtimes[1].startThread).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/repo/two' }))

    await adapter.shutdown?.()
    expect(runtimes[0].shutdown).toHaveBeenCalledTimes(1)
    expect(runtimes[1].shutdown).toHaveBeenCalledTimes(1)
  })

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
    expect(runtime.startThread).toHaveBeenCalledWith(expect.not.objectContaining({
      excludeTurns: expect.anything(),
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
      turns: [{ id: 'turn-1', turnId: 'turn-1' }],
    })
    await expect(adapter.getTurnBody?.({ sessionType: 'freshcodex', provider: 'codex', threadId: 'thread-new-1', turnId: 'turn-1' }, 7)).resolves.toMatchObject({
      turnId: 'turn-1',
      revision: 7,
    })
  })

  it('reads a just-created Codex thread without turns when includeTurns is not materialized yet', async () => {
    const runtime = {
      startThread: vi.fn().mockResolvedValue({
        threadId: 'thread-empty-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      resumeThread: vi.fn(),
      readThread: vi.fn()
        .mockRejectedValueOnce(new Error('Codex app-server thread/read failed: thread thread-empty-1 is not materialized yet; includeTurns is unavailable before first user message'))
        .mockResolvedValueOnce({
          thread: makeCodexThread('thread-empty-1'),
        }),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    await adapter.create({
      requestId: 'req-empty',
      sessionType: 'freshcodex',
      cwd: '/repo',
    })

    await expect(adapter.getSnapshot?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-empty-1',
    }, 0)).resolves.toMatchObject({
      threadId: 'thread-empty-1',
      status: 'idle',
      turns: [],
    })

    expect(runtime.readThread).toHaveBeenNthCalledWith(1, { threadId: 'thread-empty-1', includeTurns: true })
    expect(runtime.readThread).toHaveBeenNthCalledWith(2, { threadId: 'thread-empty-1', includeTurns: false })
  })

  it('lazily resumes a Codex runtime before reading a persisted thread after server reload', async () => {
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn().mockResolvedValue({
        threadId: 'thread-existing-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      readThread: vi.fn().mockResolvedValue({
        thread: makeCodexThread('thread-existing-1'),
      }),
      listThreadTurns: vi.fn().mockResolvedValue({ turns: [], nextCursor: null, revision: 7 }),
      readThreadTurn: vi.fn().mockResolvedValue(makeCodexTurn('turn-1')),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const adapter = createCodexFreshAgentAdapter({ runtimeFactory: vi.fn(() => runtime) as any })

    await expect(adapter.getSnapshot?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-existing-1',
    }, 7)).resolves.toMatchObject({
      provider: 'codex',
      threadId: 'thread-existing-1',
      revision: 7,
    })

    expect(runtime.resumeThread).toHaveBeenCalledWith({ threadId: 'thread-existing-1' })
    expect(runtime.readThread).toHaveBeenCalledWith({ threadId: 'thread-existing-1', includeTurns: true })

    await adapter.shutdown?.()
    expect(runtime.shutdown).toHaveBeenCalledTimes(1)
  })

  it('dedupes concurrent lazy runtime resumes for the same persisted thread', async () => {
    let resolveResume: ((value: { threadId: string; wsUrl: string }) => void) | undefined
    const resumePromise = new Promise<{ threadId: string; wsUrl: string }>((resolve) => {
      resolveResume = resolve
    })
    const off = vi.fn()
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn().mockReturnValue(resumePromise),
      onThreadLifecycle: vi.fn(() => off),
      readThread: vi.fn().mockResolvedValue({
        thread: makeCodexThread('thread-existing-1'),
      }),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const runtimeFactory = vi.fn(() => runtime)
    const adapter = createCodexFreshAgentAdapter({ runtimeFactory: runtimeFactory as any })

    const snapshotPromise = adapter.getSnapshot?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-existing-1',
    }, 7)
    const subscribePromise = adapter.subscribe?.('thread-existing-1', vi.fn())

    resolveResume?.({ threadId: 'thread-existing-1', wsUrl: 'ws://127.0.0.1:43123' })
    await Promise.all([snapshotPromise, subscribePromise])

    expect(runtimeFactory).toHaveBeenCalledTimes(1)
    expect(runtime.resumeThread).toHaveBeenCalledTimes(1)
  })

  it('does not attach a lazy runtime resume that completes after the thread is killed', async () => {
    let resolveResume: ((value: { threadId: string; wsUrl: string }) => void) | undefined
    const resumePromise = new Promise<{ threadId: string; wsUrl: string }>((resolve) => {
      resolveResume = resolve
    })
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn().mockReturnValue(resumePromise),
      readThread: vi.fn().mockResolvedValue({
        thread: makeCodexThread('thread-existing-1'),
      }),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const adapter = createCodexFreshAgentAdapter({ runtimeFactory: vi.fn(() => runtime) as any })

    const snapshotPromise = adapter.getSnapshot?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-existing-1',
    }, 7)
    await Promise.resolve()
    await adapter.kill?.('thread-existing-1')
    resolveResume?.({ threadId: 'thread-existing-1', wsUrl: 'ws://127.0.0.1:43123' })

    await expect(snapshotPromise).rejects.toThrow(/resume was cancelled/)
    expect(runtime.shutdown).toHaveBeenCalledTimes(1)
    expect(runtime.readThread).not.toHaveBeenCalled()
  })

  it('lazily resumes a Codex runtime with send settings before starting a turn after server reload', async () => {
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn().mockResolvedValue({
        threadId: 'thread-existing-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      forkThread: vi.fn(),
      startTurn: vi.fn().mockResolvedValue({ turnId: 'turn-active-1' }),
      interruptTurn: vi.fn(),
      readThread: vi.fn(),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const adapter = createCodexFreshAgentAdapter({ runtimeFactory: vi.fn(() => runtime) as any })

    await adapter.send?.('thread-existing-1', {
      text: 'Continue',
      settings: {
        requestId: 'req-1',
        sessionType: 'freshcodex',
        cwd: '/repo',
        model: 'codex-fixture',
        permissionMode: 'never',
        sandbox: 'workspace-write',
      },
    })

    expect(runtime.resumeThread).toHaveBeenCalledWith({
      threadId: 'thread-existing-1',
      cwd: '/repo',
      model: 'codex-fixture',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    })
    expect(runtime.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-existing-1',
      cwd: '/repo',
      model: 'codex-fixture',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'workspaceWrite' },
    }))
  })

  it('uses per-turn send models without relabeling earlier turns', async () => {
    const runtime = {
      startThread: vi.fn().mockResolvedValue({
        threadId: 'thread-new-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      resumeThread: vi.fn(),
      startTurn: vi.fn().mockResolvedValue({ turnId: 'turn-2' }),
      readThread: vi.fn().mockResolvedValue({
        thread: {
          ...makeCodexThread('thread-new-1'),
          turns: [makeCodexTurn('turn-1'), makeCodexTurn('turn-2')],
        },
      }),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
    }
    const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

    await adapter.create({
      requestId: 'req-1',
      sessionType: 'freshcodex',
      cwd: '/repo',
      model: 'gpt-5-codex',
    })
    await adapter.send?.('thread-new-1', {
      text: 'Use the small model',
      settings: { model: 'gpt-5.4-mini' },
    })

    await expect(adapter.getSnapshot?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-new-1',
    }, 7)).resolves.toMatchObject({
      turns: [
        { id: 'turn-1' },
        { id: 'turn-2', model: 'gpt-5.4-mini' },
      ],
    })
    const snapshot = await adapter.getSnapshot?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-new-1',
    }, 7) as any
    expect(snapshot.turns[0]).not.toHaveProperty('model')
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

  it('lazily resumes a Codex runtime before subscribing to a persisted thread after server reload', async () => {
    let lifecycleHandler: ((event: any) => void) | undefined
    const off = vi.fn()
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn().mockResolvedValue({
        threadId: 'thread-existing-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      onThreadLifecycle: vi.fn((handler) => {
        lifecycleHandler = handler
        return off
      }),
      readThread: vi.fn(),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const adapter = createCodexFreshAgentAdapter({ runtimeFactory: vi.fn(() => runtime) as any })
    const listener = vi.fn()

    const unsubscribe = await adapter.subscribe?.('thread-existing-1', listener)

    expect(runtime.resumeThread).toHaveBeenCalledWith({ threadId: 'thread-existing-1' })
    expect(runtime.onThreadLifecycle).toHaveBeenCalledWith(expect.any(Function))

    lifecycleHandler?.({
      kind: 'thread_status_changed',
      threadId: 'thread-existing-1',
      status: { type: 'active', activeFlags: [] },
    })
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'thread-existing-1',
      status: 'running',
    }))
    lifecycleHandler?.({
      kind: 'thread_closed',
      threadId: 'thread-existing-1',
    })
    await vi.waitFor(() => {
      expect(runtime.shutdown).toHaveBeenCalledTimes(1)
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

  it('recovers an in-progress turn id before interrupting a restored running thread', async () => {
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn().mockResolvedValue({
        threadId: 'thread-existing-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      readThread: vi.fn().mockResolvedValue({
        thread: {
          ...makeCodexThread('thread-existing-1'),
          status: { type: 'active', activeFlags: [] },
          turns: [
            makeCodexTurn('turn-done-1'),
            { ...makeCodexTurn('turn-active-1'), status: 'inProgress' },
          ],
        },
      }),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
      interruptTurn: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const adapter = createCodexFreshAgentAdapter({ runtimeFactory: vi.fn(() => runtime) as any })

    await adapter.interrupt?.('thread-existing-1')

    expect(runtime.resumeThread).toHaveBeenCalledWith({ threadId: 'thread-existing-1' })
    expect(runtime.readThread).toHaveBeenCalledWith({ threadId: 'thread-existing-1', includeTurns: true })
    expect(runtime.interruptTurn).toHaveBeenCalledWith({ threadId: 'thread-existing-1', turnId: 'turn-active-1' })
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

  it('keeps a shared fork runtime alive until all sibling threads are released', async () => {
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
      readThread: vi.fn().mockResolvedValue({
        thread: makeCodexThread('thread-fork-1'),
      }),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const adapter = createCodexFreshAgentAdapter({ runtimeFactory: vi.fn(() => runtime) as any })

    await adapter.create({
      requestId: 'req-1',
      sessionType: 'freshcodex',
      cwd: '/repo',
    })
    await adapter.fork?.('thread-new-1')

    await adapter.kill?.('thread-new-1')
    expect(runtime.shutdown).not.toHaveBeenCalled()
    await expect(adapter.getSnapshot?.({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-fork-1',
    }, 7)).resolves.toMatchObject({
      threadId: 'thread-fork-1',
    })

    await adapter.kill?.('thread-fork-1')
    expect(runtime.shutdown).toHaveBeenCalledTimes(1)
  })

  it('keeps an owned runtime retryable when final release shutdown fails', async () => {
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
      shutdown: vi.fn()
        .mockRejectedValueOnce(new Error('teardown failed'))
        .mockResolvedValueOnce(undefined),
    }
    const adapter = createCodexFreshAgentAdapter({ runtimeFactory: vi.fn(() => runtime) as any })

    await adapter.create({
      requestId: 'req-1',
      sessionType: 'freshcodex',
      cwd: '/repo',
    })
    await expect(adapter.kill?.('thread-new-1')).rejects.toThrow(/teardown failed/)
    await adapter.shutdown?.()

    expect(runtime.shutdown).toHaveBeenCalledTimes(2)
  })

  it('lazily resumes a Codex runtime before forking a persisted thread after server reload', async () => {
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn().mockResolvedValue({
        threadId: 'thread-existing-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      forkThread: vi.fn().mockResolvedValue({
        threadId: 'thread-fork-1',
        wsUrl: 'ws://127.0.0.1:43123',
      }),
      startTurn: vi.fn(),
      interruptTurn: vi.fn(),
      readThread: vi.fn(),
      listThreadTurns: vi.fn(),
      readThreadTurn: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const adapter = createCodexFreshAgentAdapter({ runtimeFactory: vi.fn(() => runtime) as any })

    await expect(adapter.fork?.('thread-existing-1')).resolves.toEqual({
      threadId: 'thread-fork-1',
      wsUrl: 'ws://127.0.0.1:43123',
    })

    expect(runtime.resumeThread).toHaveBeenCalledWith({ threadId: 'thread-existing-1' })
    expect(runtime.forkThread).toHaveBeenCalledWith({
      threadId: 'thread-existing-1',
      cwd: undefined,
      model: undefined,
      sandbox: undefined,
      approvalPolicy: undefined,
      excludeTurns: true,
    })
  })
})
