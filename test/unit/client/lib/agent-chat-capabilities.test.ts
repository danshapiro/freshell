import { describe, expect, it } from 'vitest'

import {
  AGENT_CHAT_CAPABILITY_CACHE_TTL_MS,
  AGENT_CHAT_PROVIDER_DEFAULT_OPTION_VALUE,
  getAgentChatSettingsModelOptions,
  getAgentChatSettingsModelValue,
  getAgentChatSupportedEffortLevels,
  isAgentChatEffortSupported,
  isAgentChatCapabilitiesFresh,
  parseAgentChatSettingsModelValue,
  requiresAgentChatCapabilityValidation,
  resolveAgentChatModelSelection,
} from '@/lib/agent-chat-capabilities'

const capabilities = {
  provider: 'freshclaude',
  fetchedAt: 1_234,
  models: [
    {
      id: 'opus',
      displayName: 'Opus',
      description: 'Latest Opus track',
      supportsEffort: true,
      supportedEffortLevels: ['turbo', 'warp'],
      supportsAdaptiveThinking: true,
    },
    {
      id: 'opus[1m]',
      displayName: 'Opus 1M',
      description: 'Long context',
      supportsEffort: true,
      supportedEffortLevels: ['warp'],
      supportsAdaptiveThinking: true,
    },
    {
      id: 'haiku',
      displayName: 'Haiku',
      description: 'Fast path',
      supportsEffort: false,
      supportedEffortLevels: [],
      supportsAdaptiveThinking: false,
    },
  ],
} as const

describe('agent-chat-capabilities helpers', () => {
  it('resolves provider-default to the stable opus track alias', () => {
    const resolved = resolveAgentChatModelSelection({
      providerDefaultModelId: 'opus',
      capabilities,
    })

    expect(resolved).toMatchObject({
      source: 'provider-default',
      resolvedModelId: 'opus',
      capability: expect.objectContaining({ id: 'opus' }),
    })
  })

  it('resolves tracked aliases without local remapping', () => {
    const resolved = resolveAgentChatModelSelection({
      providerDefaultModelId: 'opus',
      capabilities,
      modelSelection: { kind: 'tracked', modelId: 'opus[1m]' },
    })

    expect(resolved).toMatchObject({
      source: 'tracked',
      resolvedModelId: 'opus[1m]',
      capability: expect.objectContaining({ id: 'opus[1m]' }),
    })
  })

  it('surfaces unavailable exact selections instead of silently healing them', () => {
    const resolved = resolveAgentChatModelSelection({
      providerDefaultModelId: 'opus',
      capabilities,
      modelSelection: { kind: 'exact', modelId: 'claude-opus-4-6' },
    })

    expect(resolved).toMatchObject({
      source: 'exact',
      resolvedModelId: undefined,
      unavailableExactSelection: { kind: 'exact', modelId: 'claude-opus-4-6' },
    })
  })

  it('derives effort options only from the resolved capability payload', () => {
    expect(getAgentChatSupportedEffortLevels({
      providerDefaultModelId: 'opus',
      capabilities,
    })).toEqual(['turbo', 'warp'])

    expect(getAgentChatSupportedEffortLevels({
      providerDefaultModelId: 'opus',
      capabilities,
      modelSelection: { kind: 'tracked', modelId: 'haiku' },
    })).toEqual([])
  })

  it('treats supportedEffortLevels as the effort support source of truth', () => {
    const inconsistentCapabilities = {
      provider: 'freshclaude',
      fetchedAt: 2_345,
      models: [
        {
          id: 'opus',
          displayName: 'Opus',
          supportsEffort: false,
          supportedEffortLevels: ['turbo'],
          supportsAdaptiveThinking: true,
        },
      ],
    } as const

    const resolved = resolveAgentChatModelSelection({
      providerDefaultModelId: 'opus',
      capabilities: inconsistentCapabilities,
    })

    expect(getAgentChatSupportedEffortLevels({
      providerDefaultModelId: 'opus',
      capabilities: inconsistentCapabilities,
    })).toEqual(['turbo'])
    expect(isAgentChatEffortSupported(resolved.capability, 'turbo')).toBe(true)
  })

  it('builds settings options from provider-default, live capabilities, and unavailable exact selections', () => {
    expect(getAgentChatSettingsModelOptions({
      providerDefaultModelId: 'opus',
      capabilities,
      modelSelection: { kind: 'exact', modelId: 'claude-opus-4-6' },
    })).toEqual([
      {
        value: AGENT_CHAT_PROVIDER_DEFAULT_OPTION_VALUE,
        label: 'Provider default (track latest Opus)',
        description: 'Tracks latest Opus automatically.',
      },
      {
        value: getAgentChatSettingsModelValue({ kind: 'tracked', modelId: 'opus' }),
        label: 'Opus',
        description: 'Latest Opus track',
      },
      {
        value: getAgentChatSettingsModelValue({ kind: 'tracked', modelId: 'opus[1m]' }),
        label: 'Opus 1M',
        description: 'Long context',
      },
      {
        value: getAgentChatSettingsModelValue({ kind: 'tracked', modelId: 'haiku' }),
        label: 'Haiku',
        description: 'Fast path',
      },
      {
        value: getAgentChatSettingsModelValue(
          { kind: 'exact', modelId: 'claude-opus-4-6' },
          capabilities,
        ),
        label: 'claude-opus-4-6 (Unavailable)',
        description: 'Saved legacy model is no longer available.',
        unavailable: true,
      },
    ])
  })

  it('keeps a persisted tracked selection represented when the refreshed catalog drops it', () => {
    expect(getAgentChatSettingsModelOptions({
      providerDefaultModelId: 'opus',
      capabilities: {
        ...capabilities,
        models: capabilities.models.filter((model) => model.id !== 'haiku'),
      },
      modelSelection: { kind: 'tracked', modelId: 'haiku' },
    })).toEqual([
      {
        value: AGENT_CHAT_PROVIDER_DEFAULT_OPTION_VALUE,
        label: 'Provider default (track latest Opus)',
        description: 'Tracks latest Opus automatically.',
      },
      {
        value: getAgentChatSettingsModelValue({ kind: 'tracked', modelId: 'opus' }),
        label: 'Opus',
        description: 'Latest Opus track',
      },
      {
        value: getAgentChatSettingsModelValue({ kind: 'tracked', modelId: 'opus[1m]' }),
        label: 'Opus 1M',
        description: 'Long context',
      },
      {
        value: getAgentChatSettingsModelValue({ kind: 'tracked', modelId: 'haiku' }),
        label: 'haiku (Saved selection)',
        description: 'Saved tracked model is not in the latest capability catalog.',
      },
    ])
  })

  it('maps provider-default and tracked settings values back into selection strategies', () => {
    expect(getAgentChatSettingsModelValue(undefined)).toBe(AGENT_CHAT_PROVIDER_DEFAULT_OPTION_VALUE)
    expect(parseAgentChatSettingsModelValue(AGENT_CHAT_PROVIDER_DEFAULT_OPTION_VALUE)).toBeUndefined()
    expect(parseAgentChatSettingsModelValue(
      getAgentChatSettingsModelValue({ kind: 'tracked', modelId: 'opus[1m]' }),
    )).toEqual({
      kind: 'tracked',
      modelId: 'opus[1m]',
    })
  })

  it('treats raw magic-string lookalikes as opaque tracked ids', () => {
    expect(parseAgentChatSettingsModelValue('__provider_default__')).toEqual({
      kind: 'tracked',
      modelId: '__provider_default__',
    })
    expect(parseAgentChatSettingsModelValue('__exact__:haiku')).toEqual({
      kind: 'tracked',
      modelId: '__exact__:haiku',
    })
  })

  it('round-trips unavailable exact settings values without downgrading them to tracked', () => {
    const unavailableOption = getAgentChatSettingsModelOptions({
      providerDefaultModelId: 'opus',
      capabilities,
      modelSelection: { kind: 'exact', modelId: 'claude-opus-4-6' },
    }).find((option) => option.unavailable)

    expect(unavailableOption).toBeDefined()
    const selection = parseAgentChatSettingsModelValue(unavailableOption!.value)
    expect(selection).toEqual({
      kind: 'exact',
      modelId: 'claude-opus-4-6',
    })
    expect(requiresAgentChatCapabilityValidation({ modelSelection: selection ?? undefined })).toBe(true)
  })

  it('treats fetchedAt as a bounded freshness window instead of an unused field', () => {
    expect(isAgentChatCapabilitiesFresh(capabilities, capabilities.fetchedAt)).toBe(true)
    expect(
      isAgentChatCapabilitiesFresh(
        capabilities,
        capabilities.fetchedAt + AGENT_CHAT_CAPABILITY_CACHE_TTL_MS,
      ),
    ).toBe(true)
    expect(
      isAgentChatCapabilitiesFresh(
        capabilities,
        capabilities.fetchedAt + AGENT_CHAT_CAPABILITY_CACHE_TTL_MS + 1,
      ),
    ).toBe(false)
  })

  it('builds a large capability catalog without catastrophic option-building regressions', () => {
    const largeCatalog = {
      provider: 'freshclaude',
      fetchedAt: 9_999,
      models: Array.from({ length: 2_000 }, (_, index) => ({
        id: `model-${index}`,
        displayName: `Model ${index}`,
        description: `Synthetic model ${index}`,
        supportsEffort: index % 2 === 0,
        supportedEffortLevels: index % 2 === 0 ? ['turbo', 'warp', `custom-${index % 5}`] : [],
        supportsAdaptiveThinking: index % 3 === 0,
      })),
    } as const

    const start = performance.now()
    const options = getAgentChatSettingsModelOptions({
      providerDefaultModelId: 'opus',
      capabilities: largeCatalog,
    })
    const durationMs = performance.now() - start

    expect(options).toHaveLength(2_001)
    expect(options[0]).toEqual({
      value: AGENT_CHAT_PROVIDER_DEFAULT_OPTION_VALUE,
      label: 'Provider default (track latest Opus)',
      description: 'Tracks latest Opus automatically.',
    })
    expect(options.at(-1)).toEqual({
      value: getAgentChatSettingsModelValue({ kind: 'tracked', modelId: 'model-1999' }),
      label: 'Model 1999',
      description: 'Synthetic model 1999',
    })
    expect(durationMs).toBeLessThan(1_000)
  })
})
