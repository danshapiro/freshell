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
})
