import { describe, expect, it, vi } from 'vitest'

import { FreshAgentRuntimeManager } from '../../../../server/fresh-agent/runtime-manager.js'
import { createFreshAgentProviderRegistry } from '../../../../server/fresh-agent/provider-registry.js'

function makeSnapshot(sessionType: 'freshclaude' | 'kilroy', provider: 'claude', threadId: string) {
  return {
    sessionType,
    provider,
    threadId,
    revision: 1,
    status: 'idle',
    capabilities: {
      send: true,
      interrupt: false,
      approvals: true,
      questions: true,
      fork: false,
    },
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    pendingApprovals: [],
    pendingQuestions: [],
    worktrees: [],
    diffs: [],
    childThreads: [],
    turns: [],
    extensions: {},
  }
}

describe('FreshAgentRuntimeManager', () => {
  it('routes freshAgent.create through the adapter selected by sessionType', async () => {
    const codexAdapter = {
      create: vi.fn().mockResolvedValue({ sessionId: 'codex-session-1' }),
    }
    const registry = createFreshAgentProviderRegistry([
      {
        sessionType: 'freshcodex',
        runtimeProvider: 'codex',
        adapter: codexAdapter as any,
      },
    ])
    const manager = new FreshAgentRuntimeManager({ registry })

    const created = await manager.create({
      requestId: 'req-1',
      sessionType: 'freshcodex',
      cwd: '/workspace',
    })

    expect(codexAdapter.create).toHaveBeenCalledWith(expect.objectContaining({
      sessionType: 'freshcodex',
      cwd: '/workspace',
    }))
    expect(created).toEqual({
      sessionId: 'codex-session-1',
      sessionType: 'freshcodex',
      runtimeProvider: 'codex',
    })
  })

  it('routes creates with resumeSessionId through adapter.resume when available', async () => {
    const codexAdapter = {
      create: vi.fn().mockResolvedValue({ sessionId: 'codex-session-created' }),
      resume: vi.fn().mockResolvedValue({ sessionId: 'codex-session-resumed' }),
    }
    const registry = createFreshAgentProviderRegistry([
      {
        sessionType: 'freshcodex',
        runtimeProvider: 'codex',
        adapter: codexAdapter as any,
      },
    ])
    const manager = new FreshAgentRuntimeManager({ registry })

    const resumed = await manager.create({
      requestId: 'req-resume',
      sessionType: 'freshcodex',
      resumeSessionId: 'thread-existing-1',
    })

    expect(codexAdapter.resume).toHaveBeenCalledWith(expect.objectContaining({
      sessionType: 'freshcodex',
      resumeSessionId: 'thread-existing-1',
    }))
    expect(codexAdapter.create).not.toHaveBeenCalled()
    expect(resumed).toEqual({
      sessionId: 'codex-session-resumed',
      sessionType: 'freshcodex',
      runtimeProvider: 'codex',
    })
  })

  it('routes creates with matching sessionRef through adapter.resume', async () => {
    const codexAdapter = {
      create: vi.fn().mockResolvedValue({ sessionId: 'codex-session-created' }),
      resume: vi.fn().mockResolvedValue({ sessionId: 'thread-existing-1' }),
    }
    const registry = createFreshAgentProviderRegistry([
      {
        sessionType: 'freshcodex',
        runtimeProvider: 'codex',
        adapter: codexAdapter as any,
      },
    ])
    const manager = new FreshAgentRuntimeManager({ registry })

    const resumed = await manager.create({
      requestId: 'req-session-ref',
      sessionType: 'freshcodex',
      sessionRef: { provider: 'codex', sessionId: 'thread-existing-1' },
    })

    expect(codexAdapter.resume).toHaveBeenCalledWith(expect.objectContaining({
      sessionType: 'freshcodex',
      resumeSessionId: 'thread-existing-1',
      sessionRef: { provider: 'codex', sessionId: 'thread-existing-1' },
    }))
    expect(codexAdapter.create).not.toHaveBeenCalled()
    expect(resumed).toEqual({
      sessionId: 'thread-existing-1',
      sessionType: 'freshcodex',
      runtimeProvider: 'codex',
    })
  })

  it('tracks forked child sessions immediately', async () => {
    const codexAdapter = {
      create: vi.fn().mockResolvedValue({ sessionId: 'thread-parent-1' }),
      fork: vi.fn().mockResolvedValue({ threadId: 'thread-child-1' }),
      send: vi.fn().mockResolvedValue(undefined),
    }
    const registry = createFreshAgentProviderRegistry([
      {
        sessionType: 'freshcodex',
        runtimeProvider: 'codex',
        adapter: codexAdapter as any,
      },
    ])
    const manager = new FreshAgentRuntimeManager({ registry })
    await manager.create({ requestId: 'req-parent', sessionType: 'freshcodex' })

    await expect(manager.fork({
      sessionId: 'thread-parent-1',
      sessionType: 'freshcodex',
      provider: 'codex',
    })).resolves.toEqual({ threadId: 'thread-child-1' })
    await manager.send({
      sessionId: 'thread-child-1',
      sessionType: 'freshcodex',
      provider: 'codex',
    }, { text: 'hello' })

    expect(codexAdapter.send).toHaveBeenCalledWith('thread-child-1', { text: 'hello' })
  })

  it('routes freshAgent.compact through the tracked adapter', async () => {
    const codexAdapter = {
      create: vi.fn().mockResolvedValue({ sessionId: 'thread-compact-1' }),
      compact: vi.fn().mockResolvedValue(undefined),
    }
    const registry = createFreshAgentProviderRegistry([
      {
        sessionType: 'freshcodex',
        runtimeProvider: 'codex',
        adapter: codexAdapter as any,
      },
    ])
    const manager = new FreshAgentRuntimeManager({ registry })
    await manager.create({ requestId: 'req-compact', sessionType: 'freshcodex' })

    await manager.compact({
      sessionId: 'thread-compact-1',
      sessionType: 'freshcodex',
      provider: 'codex',
    }, { instructions: 'keep decisions' })

    expect(codexAdapter.compact).toHaveBeenCalledWith('thread-compact-1', { instructions: 'keep decisions' })
  })

  it('registers adapter send aliases while keeping the original placeholder routable', async () => {
    const opencodeAdapter = {
      create: vi.fn().mockResolvedValue({
        sessionId: 'freshopencode-req-alias',
        sessionRef: { provider: 'opencode', sessionId: 'freshopencode-req-alias' },
      }),
      send: vi.fn()
        .mockResolvedValueOnce({
          sessionId: 'ses_real_1',
          sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' },
        })
        .mockResolvedValueOnce({
          sessionId: 'ses_real_1',
          sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' },
        })
        .mockResolvedValueOnce({
          sessionId: 'ses_real_1',
          sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' },
        }),
    }
    const registry = createFreshAgentProviderRegistry([
      {
        sessionType: 'freshopencode',
        runtimeProvider: 'opencode',
        adapter: opencodeAdapter as any,
      },
    ])
    const manager = new FreshAgentRuntimeManager({ registry })
    await manager.create({ requestId: 'req-alias', sessionType: 'freshopencode' })

    await expect(manager.send({
      sessionId: 'freshopencode-req-alias',
      sessionType: 'freshopencode',
      provider: 'opencode',
    }, { text: 'first' })).resolves.toEqual({
      sessionId: 'ses_real_1',
      sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' },
    })

    await expect(manager.send({
      sessionId: 'freshopencode-req-alias',
      sessionType: 'freshopencode',
      provider: 'opencode',
    }, { text: 'via placeholder' })).resolves.toEqual({
      sessionId: 'ses_real_1',
      sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' },
    })
    await expect(manager.send({
      sessionId: 'ses_real_1',
      sessionType: 'freshopencode',
      provider: 'opencode',
    }, { text: 'via real id' })).resolves.toEqual({
      sessionId: 'ses_real_1',
      sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' },
    })

    expect(opencodeAdapter.send).toHaveBeenNthCalledWith(1, 'freshopencode-req-alias', { text: 'first' })
    expect(opencodeAdapter.send).toHaveBeenNthCalledWith(2, 'freshopencode-req-alias', { text: 'via placeholder' })
    expect(opencodeAdapter.send).toHaveBeenNthCalledWith(3, 'ses_real_1', { text: 'via real id' })
  })

  it('hydrates adapter state when attaching a restored session before send and compact', async () => {
    const opencodeAdapter = {
      create: vi.fn().mockResolvedValue({ sessionId: 'opencode-created-1' }),
      attach: vi.fn().mockResolvedValue({ sessionId: 'opencode-restored-1' }),
      send: vi.fn().mockResolvedValue(undefined),
      compact: vi.fn().mockResolvedValue(undefined),
    }
    const registry = createFreshAgentProviderRegistry([
      {
        sessionType: 'freshopencode',
        runtimeProvider: 'opencode',
        adapter: opencodeAdapter as any,
      },
    ])
    const manager = new FreshAgentRuntimeManager({ registry })

    await expect(manager.attach({
      sessionId: 'opencode-restored-1',
      sessionType: 'freshopencode',
      provider: 'opencode',
    })).resolves.toEqual({
      sessionId: 'opencode-restored-1',
      sessionType: 'freshopencode',
      runtimeProvider: 'opencode',
      sessionRef: undefined,
    })
    await manager.send({
      sessionId: 'opencode-restored-1',
      sessionType: 'freshopencode',
      provider: 'opencode',
    }, { text: 'reply ok' })
    await manager.compact({
      sessionId: 'opencode-restored-1',
      sessionType: 'freshopencode',
      provider: 'opencode',
    }, { instructions: 'keep decisions' })

    expect(opencodeAdapter.attach).toHaveBeenCalledWith({
      sessionId: 'opencode-restored-1',
      sessionType: 'freshopencode',
      provider: 'opencode',
    })
    expect(opencodeAdapter.send).toHaveBeenCalledWith('opencode-restored-1', { text: 'reply ok' })
    expect(opencodeAdapter.compact).toHaveBeenCalledWith('opencode-restored-1', { instructions: 'keep decisions' })
  })

  it('routes freshAgent.kill through the tracked adapter and removes the session', async () => {
    const claudeAdapter = {
      create: vi.fn().mockResolvedValue({ sessionId: 'claude-session-1' }),
      kill: vi.fn().mockResolvedValue(true),
    }
    const registry = createFreshAgentProviderRegistry([
      {
        sessionType: 'freshclaude',
        runtimeProvider: 'claude',
        adapter: claudeAdapter as any,
      },
    ])
    const manager = new FreshAgentRuntimeManager({ registry })

    await manager.create({
      requestId: 'req-kill',
      sessionType: 'freshclaude',
    })

    await expect(manager.kill({
      sessionId: 'claude-session-1',
      sessionType: 'freshclaude',
      provider: 'claude',
    })).resolves.toBe(true)
    expect(claudeAdapter.kill).toHaveBeenCalledWith('claude-session-1')
    await expect(manager.kill({
      sessionId: 'claude-session-1',
      sessionType: 'freshclaude',
      provider: 'claude',
    })).rejects.toThrow(/not tracked/i)
  })

  it('keeps session-type registration separate when hidden sessions share one runtime adapter', async () => {
    const claudeAdapter = {
      create: vi.fn()
        .mockResolvedValueOnce({ sessionId: 'freshclaude-session-1' })
        .mockResolvedValueOnce({ sessionId: 'kilroy-session-1' }),
      getSnapshot: vi.fn().mockResolvedValue(makeSnapshot('freshclaude', 'claude', 'freshclaude-session-1')),
    }
    const registry = createFreshAgentProviderRegistry([
      {
        sessionType: 'freshclaude',
        runtimeProvider: 'claude',
        adapter: claudeAdapter as any,
      },
      {
        sessionType: 'kilroy',
        runtimeProvider: 'claude',
        adapter: claudeAdapter as any,
      },
    ])
    const manager = new FreshAgentRuntimeManager({ registry })

    await manager.create({ requestId: 'req-1', sessionType: 'freshclaude' })
    await manager.create({ requestId: 'req-2', sessionType: 'kilroy' })
    await manager.getSnapshot({
      sessionType: 'freshclaude',
      provider: 'claude',
      threadId: 'freshclaude-session-1',
    })

    expect(claudeAdapter.create).toHaveBeenNthCalledWith(1, expect.objectContaining({ sessionType: 'freshclaude' }))
    expect(claudeAdapter.create).toHaveBeenNthCalledWith(2, expect.objectContaining({ sessionType: 'kilroy' }))
    expect(claudeAdapter.getSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ sessionType: 'freshclaude', provider: 'claude' }),
      undefined,
    )
  })

  it('rejects a route locator whose sessionType and provider disagree', async () => {
    const codexAdapter = {
      create: vi.fn().mockResolvedValue({ sessionId: 'codex-session-1' }),
      getSnapshot: vi.fn(),
    }
    const registry = createFreshAgentProviderRegistry([
      {
        sessionType: 'freshcodex',
        runtimeProvider: 'codex',
        adapter: codexAdapter as any,
      },
    ])
    const manager = new FreshAgentRuntimeManager({ registry })

    await expect(manager.getSnapshot({
      sessionType: 'freshcodex',
      provider: 'claude',
      threadId: 'codex-session-1',
    })).rejects.toThrow('uses codex, not claude')
    expect(codexAdapter.getSnapshot).not.toHaveBeenCalled()
  })
})
