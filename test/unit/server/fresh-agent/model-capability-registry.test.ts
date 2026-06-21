import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FreshAgentModelCapabilityRegistry } from '../../../../server/fresh-agent/model-capability-registry.js'

describe('FreshAgentModelCapabilityRegistry', () => {
  let now = 1_000
  let closeMock: ReturnType<typeof vi.fn>
  let supportedModelsMock: ReturnType<typeof vi.fn>
  let queryFactory: ReturnType<typeof vi.fn>

  beforeEach(() => {
    now = 1_000
    closeMock = vi.fn().mockResolvedValue(undefined)
    supportedModelsMock = vi.fn()
    queryFactory = vi.fn(() => ({
      supportedModels: supportedModelsMock,
      close: closeMock,
    }))
  })

  it('normalizes model capabilities, closes the probe query, and preserves sdk runtime metadata', async () => {
    supportedModelsMock.mockResolvedValue([
      {
        value: 'opus',
        displayName: 'opus',
        description: 'Primary track',
        supportedEffortLevels: [' low ', 'medium'],
        supportsAdaptiveThinking: true,
      },
      {
        id: 'haiku',
        display_name: 'haiku',
        supported_effort_levels: [],
        supports_adaptive_thinking: false,
      },
    ])

    const registry = new FreshAgentModelCapabilityRegistry({
      queryFactory,
      now: () => now,
      ttlMs: 5_000,
    })

    const result = await registry.getCapabilities('freshclaude')

    expect(queryFactory).toHaveBeenCalledTimes(1)
    expect(closeMock).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      ok: true,
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      status: 'fresh',
      fetchedAt: 1_000,
      models: [
        {
          id: 'opus',
          displayName: 'Opus',
          provider: 'claude',
          description: 'Primary track',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium'],
          supportsAdaptiveThinking: true,
        },
        {
          id: 'haiku',
          displayName: 'Haiku',
          provider: 'claude',
          description: undefined,
          supportsEffort: false,
          supportedEffortLevels: [],
          supportsAdaptiveThinking: false,
        },
      ],
    })
  })

  it('normalizes effort support from supportedEffortLevels so the shared contract stays self-consistent', async () => {
    supportedModelsMock.mockResolvedValue([
      {
        value: 'opus',
        displayName: 'opus',
        supportsEffort: false,
        supportedEffortLevels: ['turbo'],
        supportsAdaptiveThinking: true,
      },
      {
        value: 'haiku',
        displayName: 'haiku',
        supportsEffort: true,
        supportedEffortLevels: [],
        supportsAdaptiveThinking: false,
      },
    ])

    const registry = new FreshAgentModelCapabilityRegistry({
      queryFactory,
      now: () => now,
      ttlMs: 5_000,
    })

    const result = await registry.getCapabilities('freshclaude')

    expect(result).toEqual({
      ok: true,
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      status: 'fresh',
      fetchedAt: 1_000,
      models: [
        {
          id: 'opus',
          displayName: 'Opus',
          provider: 'claude',
          description: undefined,
          supportsEffort: true,
          supportedEffortLevels: ['turbo'],
          supportsAdaptiveThinking: true,
        },
        {
          id: 'haiku',
          displayName: 'Haiku',
          provider: 'claude',
          description: undefined,
          supportsEffort: false,
          supportedEffortLevels: [],
          supportsAdaptiveThinking: false,
        },
      ],
    })
    expect(closeMock).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent refreshes, reuses successful cache within ttl, and refreshes again after expiry', async () => {
    let resolveProbe: ((value: unknown[]) => void) | undefined
    supportedModelsMock.mockImplementation(() => new Promise((resolve) => {
      resolveProbe = resolve
    }))

    const registry = new FreshAgentModelCapabilityRegistry({
      queryFactory,
      now: () => now,
      ttlMs: 5_000,
    })

    const pendingA = registry.refreshCapabilities('freshclaude')
    const pendingB = registry.refreshCapabilities('kilroy')

    expect(queryFactory).toHaveBeenCalledTimes(1)

    resolveProbe?.([
      {
        value: 'opus',
        displayName: 'opus',
        supportedEffortLevels: ['high'],
        supportsAdaptiveThinking: true,
      },
    ])

    const [first, second] = await Promise.all([pendingA, pendingB])
    expect(first).toMatchObject({ ok: true, sessionType: 'freshclaude', runtimeProvider: 'claude' })
    expect(second).toMatchObject({ ok: true, sessionType: 'kilroy', runtimeProvider: 'claude' })

    await registry.getCapabilities('freshclaude')
    expect(queryFactory).toHaveBeenCalledTimes(1)

    now += 5_001
    supportedModelsMock.mockResolvedValue([
      {
        value: 'haiku',
        displayName: 'haiku',
        supportedEffortLevels: [],
        supportsAdaptiveThinking: false,
      },
    ])

    const refreshed = await registry.getCapabilities('freshclaude')

    expect(queryFactory).toHaveBeenCalledTimes(2)
    expect(refreshed).toMatchObject({
      ok: true,
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      models: [{ id: 'haiku' }],
    })
  })

  it('serves non-Claude fresh-agent catalogs without reusing the Claude probe cache', async () => {
    const getCatalog = vi.fn(async () => ({
      providers: {
        'opencode-go': {
          id: 'opencode-go',
          models: { 'glm-5.2': { id: 'glm-5.2', name: 'GLM 5.2' } },
        },
      },
    }))
    const registry = new FreshAgentModelCapabilityRegistry({
      queryFactory,
      now: () => now,
      ttlMs: 5_000,
      opencodeCatalogProvider: { getCatalog },
    })

    const codex = await registry.getCapabilities('freshcodex')
    const opencode = await registry.getCapabilities('freshopencode')

    expect(queryFactory).not.toHaveBeenCalled()
    expect(codex).toMatchObject({
      ok: true,
      sessionType: 'freshcodex',
      runtimeProvider: 'codex',
      status: 'fresh',
      models: expect.arrayContaining([expect.objectContaining({ provider: 'codex' })]),
    })
    expect(opencode).toMatchObject({
      ok: true,
      sessionType: 'freshopencode',
      runtimeProvider: 'opencode',
      status: 'fresh',
      models: expect.arrayContaining([expect.objectContaining({ provider: 'opencode' })]),
    })
  })

  it('keeps the last successful catalog after a failed refresh', async () => {
    supportedModelsMock.mockResolvedValueOnce([
      {
        value: 'opus',
        displayName: 'opus',
        supportedEffortLevels: ['high'],
        supportsAdaptiveThinking: true,
      },
    ])

    const registry = new FreshAgentModelCapabilityRegistry({
      queryFactory,
      now: () => now,
      ttlMs: 5_000,
    })

    const first = await registry.getCapabilities('freshclaude')
    expect(first).toMatchObject({
      ok: true,
      models: [{ id: 'opus' }],
    })

    supportedModelsMock.mockRejectedValueOnce(new Error('probe failed'))

    const refresh = await registry.refreshCapabilities('freshclaude')
    expect(refresh).toEqual({
      ok: false,
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      status: 'unavailable',
      models: [],
      error: {
        code: 'CAPABILITY_PROBE_FAILED',
        message: 'probe failed',
        retryable: true,
      },
    })

    const cached = await registry.getCapabilities('freshclaude')
    expect(cached).toMatchObject({
      ok: true,
      models: [{ id: 'opus' }],
    })
  })

  it('times out a hung probe, closes it, and lets a later retry succeed', async () => {
    vi.useFakeTimers()
    try {
      supportedModelsMock.mockImplementation(() => new Promise(() => {}))

      const registry = new FreshAgentModelCapabilityRegistry({
        queryFactory,
        now: () => now,
        ttlMs: 5_000,
        probeTimeoutMs: 100,
      })

      const timedOut = registry.refreshCapabilities('freshclaude')
      await vi.advanceTimersByTimeAsync(100)

      await expect(timedOut).resolves.toEqual({
        ok: false,
        sessionType: 'freshclaude',
        runtimeProvider: 'claude',
        status: 'unavailable',
        models: [],
        error: {
          code: 'CAPABILITY_PROBE_FAILED',
          message: 'Capability probe timed out after 100ms',
          retryable: true,
        },
      })

      const firstCall = queryFactory.mock.calls[0]?.[0] as
        | { options?: { abortController?: AbortController } }
        | undefined
      expect(firstCall?.options?.abortController?.signal.aborted).toBe(true)
      expect(closeMock).toHaveBeenCalledTimes(1)

      supportedModelsMock.mockResolvedValueOnce([
        {
          value: 'haiku',
          displayName: 'haiku',
          supportedEffortLevels: [],
          supportsAdaptiveThinking: false,
        },
      ])

      const retried = await registry.refreshCapabilities('freshclaude')
      expect(queryFactory).toHaveBeenCalledTimes(2)
      expect(retried).toMatchObject({
        ok: true,
        sessionType: 'freshclaude',
        runtimeProvider: 'claude',
        models: [{ id: 'haiku' }],
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects malformed upstream payloads with a typed error', async () => {
    supportedModelsMock.mockResolvedValue([
      {
        displayName: 'Missing id',
        supportedEffortLevels: ['high'],
      },
    ])

    const registry = new FreshAgentModelCapabilityRegistry({
      queryFactory,
      now: () => now,
      ttlMs: 5_000,
    })

    const result = await registry.refreshCapabilities('freshclaude')

    expect(result).toEqual({
      ok: false,
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      status: 'unavailable',
      models: [],
      error: {
        code: 'CAPABILITY_PAYLOAD_INVALID',
        message: 'Capability payload is missing a model id',
        retryable: false,
      },
    })
    expect(closeMock).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed nested effort metadata with a typed error', async () => {
    supportedModelsMock.mockResolvedValue([
      {
        value: 'opus',
        displayName: 'opus',
        supportedEffortLevels: 'turbo',
      },
    ])

    const registry = new FreshAgentModelCapabilityRegistry({
      queryFactory,
      now: () => now,
      ttlMs: 5_000,
    })

    const result = await registry.refreshCapabilities('freshclaude')

    expect(result).toEqual({
      ok: false,
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      status: 'unavailable',
      models: [],
      error: {
        code: 'CAPABILITY_PAYLOAD_INVALID',
        message: 'Capability payload has invalid supported effort levels for opus',
        retryable: false,
      },
    })
    expect(closeMock).toHaveBeenCalledTimes(1)
  })

  it('caches OpenCode capabilities by cwd without probing Claude or live session sidecars', async () => {
    const getCatalog = vi.fn(async ({ cwd }: { cwd?: string }) => ({
      providers: {
        [cwd === '/repo/a' ? 'opencode-go' : 'google']: {
          id: cwd === '/repo/a' ? 'opencode-go' : 'google',
          models: {
            [cwd === '/repo/a' ? 'glm-5.2' : 'gemini-3-pro']: {
              id: cwd === '/repo/a' ? 'glm-5.2' : 'gemini-3-pro',
            },
          },
        },
      },
    }))
    const registry = new FreshAgentModelCapabilityRegistry({
      queryFactory,
      now: () => now,
      ttlMs: 5_000,
      opencodeCatalogProvider: { getCatalog },
    })

    await expect(registry.getCapabilities('freshopencode', { cwd: '/repo/a' })).resolves.toMatchObject({
      ok: true,
      models: [expect.objectContaining({ id: 'opencode-go/glm-5.2' })],
    })
    await expect(registry.getCapabilities('freshopencode', { cwd: '/repo/b' })).resolves.toMatchObject({
      ok: true,
      models: [expect.objectContaining({ id: 'google/gemini-3-pro' })],
    })
    await registry.getCapabilities('freshopencode', { cwd: '/repo/a' })

    expect(getCatalog).toHaveBeenCalledTimes(2)
    expect(queryFactory).not.toHaveBeenCalled()
  })
})
