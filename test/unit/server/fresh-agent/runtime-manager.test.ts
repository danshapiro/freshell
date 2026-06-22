import { describe, expect, it, vi } from 'vitest'

import { FreshAgentRuntimeManager } from '../../../../server/fresh-agent/runtime-manager.js'
import { createFreshAgentProviderRegistry } from '../../../../server/fresh-agent/provider-registry.js'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

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

  it('rejects a tracked recovered durable FreshOpenCode session without cwd before mutation', async () => {
    const opencodeAdapter = {
      create: vi.fn(),
      attach: vi.fn().mockResolvedValue({ sessionId: 'ses_recovered_no_route' }),
      send: vi.fn().mockResolvedValue(undefined),
    }
    const registry = createFreshAgentProviderRegistry([
      {
        sessionType: 'freshopencode',
        runtimeProvider: 'opencode',
        adapter: opencodeAdapter as any,
      },
    ])
    const manager = new FreshAgentRuntimeManager({ registry })

    await manager.attach({
      sessionId: 'ses_recovered_no_route',
      sessionType: 'freshopencode',
      provider: 'opencode',
    })

    await expect(manager.send({
      sessionId: 'ses_recovered_no_route',
      sessionType: 'freshopencode',
      provider: 'opencode',
    }, { text: 'must not send' })).rejects.toThrow(/cwd|route|not tracked|not available/i)

    expect(opencodeAdapter.send).not.toHaveBeenCalled()
  })

  it('keeps a directly resumed no-cwd durable FreshOpenCode session read-only until cwd is supplied', async () => {
    const opencodeAdapter = {
      create: vi.fn(),
      resume: vi.fn().mockResolvedValue({ sessionId: 'ses_resumed_no_route' }),
      send: vi.fn().mockResolvedValue(undefined),
    }
    const registry = createFreshAgentProviderRegistry([
      {
        sessionType: 'freshopencode',
        runtimeProvider: 'opencode',
        adapter: opencodeAdapter as any,
      },
    ])
    const manager = new FreshAgentRuntimeManager({ registry })

    await manager.resume({
      requestId: 'req-resume-no-route',
      sessionType: 'freshopencode',
      provider: 'opencode',
      resumeSessionId: 'ses_resumed_no_route',
    })

    await expect(manager.send({
      sessionId: 'ses_resumed_no_route',
      sessionType: 'freshopencode',
      provider: 'opencode',
    }, { text: 'must not send' })).rejects.toThrow(/cwd|route|not tracked|not available/i)

    expect(opencodeAdapter.resume).toHaveBeenCalled()
    expect(opencodeAdapter.send).not.toHaveBeenCalled()
  })

  it('keeps create-resumed no-cwd durable FreshOpenCode sessions read-only until cwd is supplied', async () => {
    const opencodeAdapter = {
      create: vi.fn(),
      resume: vi.fn().mockResolvedValue({ sessionId: 'ses_create_resumed_no_route' }),
      send: vi.fn().mockResolvedValue(undefined),
    }
    const registry = createFreshAgentProviderRegistry([
      {
        sessionType: 'freshopencode',
        runtimeProvider: 'opencode',
        adapter: opencodeAdapter as any,
      },
    ])
    const manager = new FreshAgentRuntimeManager({ registry })

    await manager.create({
      requestId: 'req-create-resume-no-route',
      sessionType: 'freshopencode',
      provider: 'opencode',
      resumeSessionId: 'ses_create_resumed_no_route',
    })

    await expect(manager.send({
      sessionId: 'ses_create_resumed_no_route',
      sessionType: 'freshopencode',
      provider: 'opencode',
    }, { text: 'must not send' })).rejects.toThrow(/cwd|route|not tracked|not available/i)

    expect(opencodeAdapter.resume).toHaveBeenCalled()
    expect(opencodeAdapter.create).not.toHaveBeenCalled()
    expect(opencodeAdapter.send).not.toHaveBeenCalled()
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

  it('recovers a missing FreshOpenCode durable session with cwd before mutation', async () => {
    const opencodeAdapter = {
      create: vi.fn(),
      attach: vi.fn().mockResolvedValue({ sessionId: 'ses_restored' }),
      send: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined),
      compact: vi.fn().mockResolvedValue(undefined),
      fork: vi.fn().mockResolvedValue({ sessionId: 'ses_child' }),
      answerQuestion: vi.fn().mockResolvedValue(undefined),
      resolveApproval: vi.fn().mockResolvedValue(undefined),
    }
    const registry = createFreshAgentProviderRegistry([{
      sessionType: 'freshopencode',
      runtimeProvider: 'opencode',
      adapter: opencodeAdapter as any,
    }])
    const manager = new FreshAgentRuntimeManager({ registry })
    const locator = {
      sessionId: 'ses_restored',
      sessionType: 'freshopencode' as const,
      provider: 'opencode' as const,
      cwd: '/repo/safe',
    }

    await manager.send(locator, { text: 'continue' })
    await manager.interrupt(locator)
    await manager.compact(locator, { instructions: 'keep decisions' })
    await manager.fork(locator)
    await manager.answerQuestion(locator, 'req-question', { choice: 'yes' })
    await manager.resolveApproval(locator, 'req-approval', { action: 'approve' })

    expect(opencodeAdapter.attach).toHaveBeenCalledTimes(1)
    expect(opencodeAdapter.attach).toHaveBeenCalledWith(locator)
    expect(opencodeAdapter.send).toHaveBeenCalledWith('ses_restored', { text: 'continue' })
    expect(opencodeAdapter.interrupt).toHaveBeenCalledWith('ses_restored')
    expect(opencodeAdapter.compact).toHaveBeenCalledWith('ses_restored', { instructions: 'keep decisions' })
    expect(opencodeAdapter.fork).toHaveBeenCalledWith('ses_restored', undefined)
    expect(opencodeAdapter.answerQuestion).toHaveBeenCalledWith('ses_restored', 'req-question', { choice: 'yes' })
    expect(opencodeAdapter.resolveApproval).toHaveBeenCalledWith('ses_restored', 'req-approval', { action: 'approve' })
  })

  it('does not recover placeholders, missing cwd, or non-OpenCode providers', async () => {
    const opencodeAdapter = {
      create: vi.fn(),
      attach: vi.fn(),
      send: vi.fn(),
    }
    const codexAdapter = {
      create: vi.fn(),
      attach: vi.fn(),
      send: vi.fn(),
    }
    const registry = createFreshAgentProviderRegistry([
      {
        sessionType: 'freshopencode',
        runtimeProvider: 'opencode',
        adapter: opencodeAdapter as any,
      },
      {
        sessionType: 'freshcodex',
        runtimeProvider: 'codex',
        adapter: codexAdapter as any,
      },
    ])
    const manager = new FreshAgentRuntimeManager({ registry })

    await expect(manager.send({
      sessionId: 'freshopencode-temp',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/safe',
    }, { text: 'no' })).rejects.toThrow(/not tracked|not available/i)
    await expect(manager.send({
      sessionId: 'ses_missing_cwd',
      sessionType: 'freshopencode',
      provider: 'opencode',
    }, { text: 'no' })).rejects.toThrow(/not tracked|cwd|not available/i)
    await expect(manager.send({
      sessionId: 'codex-thread',
      sessionType: 'freshcodex',
      provider: 'codex',
    }, { text: 'no' })).rejects.toThrow(/not tracked/i)

    expect(opencodeAdapter.attach).not.toHaveBeenCalled()
    expect(codexAdapter.attach).not.toHaveBeenCalled()
  })

  it('enriches an existing FreshOpenCode record with cwd before mutating', async () => {
    const opencodeAdapter = {
      create: vi.fn().mockResolvedValue({ sessionId: 'ses_existing' }),
      attach: vi.fn().mockResolvedValue({ sessionId: 'ses_existing' }),
      send: vi.fn().mockResolvedValue(undefined),
    }
    const registry = createFreshAgentProviderRegistry([
      {
        sessionType: 'freshopencode',
        runtimeProvider: 'opencode',
        adapter: opencodeAdapter as any,
      },
    ])
    const manager = new FreshAgentRuntimeManager({ registry })

    await manager.create({ requestId: 'req-existing', sessionType: 'freshopencode', provider: 'opencode', prompt: 'start' } as any)
    await manager.send({
      sessionId: 'ses_existing',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/safe',
    }, { text: 'continue' })

    expect(opencodeAdapter.attach).toHaveBeenCalledWith({
      sessionId: 'ses_existing',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/safe',
    })
    expect(opencodeAdapter.send).toHaveBeenCalledWith('ses_existing', { text: 'continue' })
  })

  it('singleflights concurrent FreshOpenCode recovery for the same cwd', async () => {
    const attachDeferred = createDeferred<{ sessionId: string }>()
    const opencodeAdapter = {
      create: vi.fn(),
      attach: vi.fn(() => attachDeferred.promise),
      send: vi.fn().mockResolvedValue(undefined),
    }
    const registry = createFreshAgentProviderRegistry([
      {
        sessionType: 'freshopencode',
        runtimeProvider: 'opencode',
        adapter: opencodeAdapter as any,
      },
    ])
    const manager = new FreshAgentRuntimeManager({ registry })
    const locator = {
      sessionId: 'ses_one',
      sessionType: 'freshopencode' as const,
      provider: 'opencode' as const,
      cwd: '/repo',
    }

    const first = manager.send(locator, { text: 'one' })
    const second = manager.send(locator, { text: 'two' })

    await Promise.resolve()

    expect(opencodeAdapter.attach).toHaveBeenCalledTimes(1)

    attachDeferred.resolve({ sessionId: 'ses_one' })

    await Promise.all([first, second])

    expect(opencodeAdapter.send).toHaveBeenCalledTimes(2)
  })

  it('rejects concurrent FreshOpenCode recovery when the same session key arrives with a different cwd', async () => {
    const attachDeferred = createDeferred<{ sessionId: string }>()
    const opencodeAdapter = {
      create: vi.fn(),
      attach: vi.fn(() => attachDeferred.promise),
      send: vi.fn().mockResolvedValue(undefined),
    }
    const registry = createFreshAgentProviderRegistry([
      {
        sessionType: 'freshopencode',
        runtimeProvider: 'opencode',
        adapter: opencodeAdapter as any,
      },
    ])
    const manager = new FreshAgentRuntimeManager({ registry })

    const first = manager.send({
      sessionId: 'ses_one',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/one',
    }, { text: 'one' })

    await Promise.resolve()

    await expect(manager.send({
      sessionId: 'ses_one',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/two',
    }, { text: 'two' })).rejects.toThrow('/repo/one')

    attachDeferred.resolve({ sessionId: 'ses_one' })
    await first
  })

  it('rejects a later FreshOpenCode mutation when the tracked cwd differs', async () => {
    const opencodeAdapter = {
      create: vi.fn().mockResolvedValue({ sessionId: 'ses_existing' }),
      attach: vi.fn().mockResolvedValue({ sessionId: 'ses_existing' }),
      send: vi.fn().mockResolvedValue(undefined),
    }
    const registry = createFreshAgentProviderRegistry([
      {
        sessionType: 'freshopencode',
        runtimeProvider: 'opencode',
        adapter: opencodeAdapter as any,
      },
    ])
    const manager = new FreshAgentRuntimeManager({ registry })

    await manager.create({ requestId: 'req-existing-cwd', sessionType: 'freshopencode', provider: 'opencode' } as any)
    await manager.send({
      sessionId: 'ses_existing',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/one',
    }, { text: 'continue' })

    await expect(manager.send({
      sessionId: 'ses_existing',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/two',
    }, { text: 'mismatch' })).rejects.toThrow('/repo/one')
  })

  it('keeps forked FreshOpenCode child route state independent from the parent', async () => {
    const opencodeAdapter = {
      create: vi.fn(),
      attach: vi.fn().mockResolvedValue({ sessionId: 'ses_parent' }),
      fork: vi.fn().mockResolvedValue({ sessionId: 'ses_child' }),
      send: vi.fn().mockResolvedValue(undefined),
    }
    const registry = createFreshAgentProviderRegistry([
      {
        sessionType: 'freshopencode',
        runtimeProvider: 'opencode',
        adapter: opencodeAdapter as any,
      },
    ])
    const manager = new FreshAgentRuntimeManager({ registry })

    await manager.fork({
      sessionId: 'ses_parent',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/parent',
    })

    await manager.send({
      sessionId: 'ses_child',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/child',
    }, { text: 'child route' })
    await manager.send({
      sessionId: 'ses_parent',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/parent',
    }, { text: 'parent route' })

    expect(opencodeAdapter.attach).toHaveBeenCalledWith({
      sessionId: 'ses_parent',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/parent',
    })
    expect(opencodeAdapter.attach).toHaveBeenCalledWith({
      sessionId: 'ses_child',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/child',
    })
    expect(opencodeAdapter.send).toHaveBeenCalledWith('ses_child', { text: 'child route' })
    expect(opencodeAdapter.send).toHaveBeenCalledWith('ses_parent', { text: 'parent route' })
  })

  it('keeps provider-forked FreshOpenCode children mutable without cwd in this process', async () => {
    const opencodeAdapter = {
      create: vi.fn(),
      attach: vi.fn().mockResolvedValue({ sessionId: 'ses_parent' }),
      fork: vi.fn().mockResolvedValue({ sessionId: 'ses_child' }),
      send: vi.fn().mockResolvedValue(undefined),
    }
    const registry = createFreshAgentProviderRegistry([
      {
        sessionType: 'freshopencode',
        runtimeProvider: 'opencode',
        adapter: opencodeAdapter as any,
      },
    ])
    const manager = new FreshAgentRuntimeManager({ registry })

    await manager.fork({
      sessionId: 'ses_parent',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/parent',
    })
    await manager.send({
      sessionId: 'ses_child',
      sessionType: 'freshopencode',
      provider: 'opencode',
    }, { text: 'child no route' })

    expect(opencodeAdapter.send).toHaveBeenCalledWith('ses_child', { text: 'child no route' })
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

  it('requires the tracked FreshOpenCode route before killing a durable session', async () => {
    const opencodeAdapter = {
      create: vi.fn().mockResolvedValue({ sessionId: 'ses_kill_route' }),
      attach: vi.fn().mockResolvedValue({ sessionId: 'ses_kill_route' }),
      kill: vi.fn().mockResolvedValue(true),
    }
    const registry = createFreshAgentProviderRegistry([
      {
        sessionType: 'freshopencode',
        runtimeProvider: 'opencode',
        adapter: opencodeAdapter as any,
      },
    ])
    const manager = new FreshAgentRuntimeManager({ registry })

    await manager.attach({
      sessionId: 'ses_kill_route',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/safe',
    })

    await expect(manager.attach({
      sessionId: 'ses_kill_route',
      sessionType: 'freshopencode',
      provider: 'opencode',
    })).resolves.toEqual({
      sessionId: 'ses_kill_route',
      sessionType: 'freshopencode',
      runtimeProvider: 'opencode',
    })
    expect(opencodeAdapter.attach).toHaveBeenCalledTimes(2)

    await expect(manager.attach({
      sessionId: 'ses_kill_route',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/other',
    })).rejects.toThrow(/tracked for/i)
    expect(opencodeAdapter.attach).toHaveBeenCalledTimes(2)

    await expect(manager.kill({
      sessionId: 'ses_kill_route',
      sessionType: 'freshopencode',
      provider: 'opencode',
    })).rejects.toThrow(/requires a cwd/i)
    await expect(manager.kill({
      sessionId: 'ses_kill_route',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/other',
    })).rejects.toThrow(/tracked for/i)
    expect(opencodeAdapter.kill).not.toHaveBeenCalled()

    await expect(manager.kill({
      sessionId: 'ses_kill_route',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/safe',
    })).resolves.toBe(true)
    expect(opencodeAdapter.kill).toHaveBeenCalledWith('ses_kill_route')
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
