import { describe, expect, it, vi } from 'vitest'

import { FreshAgentRuntimeManager } from '../../../../server/fresh-agent/runtime-manager.js'
import { createFreshAgentProviderRegistry } from '../../../../server/fresh-agent/provider-registry.js'

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

    await expect(manager.kill('claude-session-1')).resolves.toBe(true)
    expect(claudeAdapter.kill).toHaveBeenCalledWith('claude-session-1')
    await expect(manager.kill('claude-session-1')).rejects.toThrow(/not tracked/i)
  })
})
