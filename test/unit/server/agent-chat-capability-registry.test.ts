import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentChatCapabilityRegistry } from '../../../server/agent-chat-capability-registry.js'

describe('AgentChatCapabilityRegistry', () => {
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

    const registry = new AgentChatCapabilityRegistry({
      queryFactory,
      now: () => now,
      ttlMs: 5_000,
    })

    const result = await registry.getCapabilities('freshclaude')

    expect(queryFactory).toHaveBeenCalledTimes(1)
    expect(closeMock).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      ok: true,
      capabilities: {
        provider: 'freshclaude',
        fetchedAt: 1_000,
        models: [
          {
            id: 'opus',
            displayName: 'Opus',
            description: 'Primary track',
            supportsEffort: true,
            supportedEffortLevels: ['low', 'medium'],
            supportsAdaptiveThinking: true,
          },
          {
            id: 'haiku',
            displayName: 'Haiku',
            description: undefined,
            supportsEffort: false,
            supportedEffortLevels: [],
            supportsAdaptiveThinking: false,
          },
        ],
      },
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

    const registry = new AgentChatCapabilityRegistry({
      queryFactory,
      now: () => now,
      ttlMs: 5_000,
    })

    const result = await registry.getCapabilities('freshclaude')

    expect(result).toEqual({
      ok: true,
      capabilities: {
        provider: 'freshclaude',
        fetchedAt: 1_000,
        models: [
          {
            id: 'opus',
            displayName: 'Opus',
            description: undefined,
            supportsEffort: true,
            supportedEffortLevels: ['turbo'],
            supportsAdaptiveThinking: true,
          },
          {
            id: 'haiku',
            displayName: 'Haiku',
            description: undefined,
            supportsEffort: false,
            supportedEffortLevels: [],
            supportsAdaptiveThinking: false,
          },
        ],
      },
    })
    expect(closeMock).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent refreshes, reuses successful cache within ttl, and refreshes again after expiry', async () => {
    let resolveProbe: ((value: unknown[]) => void) | undefined
    supportedModelsMock.mockImplementation(() => new Promise((resolve) => {
      resolveProbe = resolve
    }))

    const registry = new AgentChatCapabilityRegistry({
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
    expect(first).toMatchObject({ ok: true, capabilities: { provider: 'freshclaude' } })
    expect(second).toMatchObject({ ok: true, capabilities: { provider: 'kilroy' } })

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
      capabilities: {
        provider: 'freshclaude',
        models: [{ id: 'haiku' }],
      },
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

    const registry = new AgentChatCapabilityRegistry({
      queryFactory,
      now: () => now,
      ttlMs: 5_000,
    })

    const first = await registry.getCapabilities('freshclaude')
    expect(first).toMatchObject({
      ok: true,
      capabilities: { models: [{ id: 'opus' }] },
    })

    supportedModelsMock.mockRejectedValueOnce(new Error('probe failed'))

    const refresh = await registry.refreshCapabilities('freshclaude')
    expect(refresh).toEqual({
      ok: false,
      error: {
        code: 'CAPABILITY_PROBE_FAILED',
        message: 'probe failed',
        retryable: true,
      },
    })

    const cached = await registry.getCapabilities('freshclaude')
    expect(cached).toMatchObject({
      ok: true,
      capabilities: { models: [{ id: 'opus' }] },
    })
  })

  it('times out a hung probe, closes it, and lets a later retry succeed', async () => {
    vi.useFakeTimers()
    try {
      supportedModelsMock.mockImplementation(() => new Promise(() => {}))

      const registry = new AgentChatCapabilityRegistry({
        queryFactory,
        now: () => now,
        ttlMs: 5_000,
        probeTimeoutMs: 100,
      })

      const timedOut = registry.refreshCapabilities('freshclaude')
      await vi.advanceTimersByTimeAsync(100)

      await expect(timedOut).resolves.toEqual({
        ok: false,
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
        capabilities: {
          provider: 'freshclaude',
          models: [{ id: 'haiku' }],
        },
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

    const registry = new AgentChatCapabilityRegistry({
      queryFactory,
      now: () => now,
      ttlMs: 5_000,
    })

    const result = await registry.refreshCapabilities('freshclaude')

    expect(result).toEqual({
      ok: false,
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

    const registry = new AgentChatCapabilityRegistry({
      queryFactory,
      now: () => now,
      ttlMs: 5_000,
    })

    const result = await registry.refreshCapabilities('freshclaude')

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'CAPABILITY_PAYLOAD_INVALID',
        message: 'Capability payload has invalid supported effort levels for opus',
        retryable: false,
      },
    })
    expect(closeMock).toHaveBeenCalledTimes(1)
  })
})
