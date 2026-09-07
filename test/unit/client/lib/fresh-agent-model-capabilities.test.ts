import { describe, expect, it } from 'vitest'

import type { FreshAgentModelCapabilities } from '@shared/fresh-agent-model-capabilities'
import {
  FRESH_AGENT_MODEL_CAPABILITY_CACHE_TTL_MS,
  getFreshAgentStaticModelCapabilities,
  FRESH_AGENT_PROVIDER_DEFAULT_MODEL_OPTION_VALUE,
  capFreshAgentModelSourceRows,
  filterFreshAgentModelCapabilitiesByQuery,
  getFreshAgentSettingsModelOptions,
  getFreshAgentSettingsModelValue,
  getFreshAgentSupportedEffortLevels,
  groupFreshAgentModelCapabilitiesBySource,
  isFreshAgentEffortSupported,
  isFreshAgentModelCapabilitiesFresh,
  mergeClaudeModelCapabilities,
  mergeClaudeSelectorOptions,
  parseFreshAgentSettingsModelValue,
  requiresFreshAgentModelCapabilityValidation,
  resolveFreshAgentModelSelection,
  resolveFreshOpencodeCapabilityById,
} from '@/lib/fresh-agent-model-capabilities'

const capabilities = {
  sessionType: 'freshclaude',
  runtimeProvider: 'claude',
  status: 'fresh',
  fetchedAt: 1_234,
  models: [
    {
      id: 'opus',
      displayName: 'Opus',
      provider: 'claude',
      description: 'Latest Opus track',
      supportsEffort: true,
      supportedEffortLevels: ['turbo', 'warp'],
      supportsAdaptiveThinking: true,
    },
    {
      id: 'opus[1m]',
      displayName: 'Opus 1M',
      provider: 'claude',
      description: 'Long context',
      supportsEffort: true,
      supportedEffortLevels: ['warp'],
      supportsAdaptiveThinking: true,
    },
  {
    id: 'haiku',
    displayName: 'Haiku',
    provider: 'claude',
    description: 'Fast path',
    supportsEffort: false,
    supportedEffortLevels: [],
    supportsAdaptiveThinking: false,
  },
  ],
} as const

const opencodeCapabilities = {
  sessionType: 'freshopencode',
  runtimeProvider: 'opencode',
  status: 'fresh',
  fetchedAt: 1_234,
  models: [
    {
      id: 'opencode-go/glm-5.2',
      displayName: 'GLM 5.2',
      provider: 'opencode',
      source: { id: 'opencode-go', displayName: 'opencode-go' },
      supportsEffort: true,
      supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'max'],
      supportsAdaptiveThinking: true,
    },
    {
      id: 'deepseek/deepseek-v4-flash',
      displayName: 'DeepSeek V4 Flash',
      provider: 'opencode',
      source: { id: 'deepseek', displayName: 'deepseek' },
      supportsEffort: true,
      supportedEffortLevels: ['low', 'high'],
      supportsAdaptiveThinking: true,
    },
    {
      id: 'opencode-go/deepseek-v4-pro',
      displayName: 'DeepSeek V4 Pro',
      provider: 'opencode',
      source: { id: 'opencode-go', displayName: 'opencode-go' },
      supportsEffort: true,
      supportedEffortLevels: ['low', 'high'],
      supportsAdaptiveThinking: true,
    },
  ],
} as const

describe('fresh-agent-model-capabilities helpers', () => {
  it('resolves provider-default to the stable opus track alias', () => {
    const resolved = resolveFreshAgentModelSelection({
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
    const resolved = resolveFreshAgentModelSelection({
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
    const resolved = resolveFreshAgentModelSelection({
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
    expect(getFreshAgentSupportedEffortLevels({
      providerDefaultModelId: 'opus',
      capabilities,
    })).toEqual(['turbo', 'warp'])

    expect(getFreshAgentSupportedEffortLevels({
      providerDefaultModelId: 'opus',
      capabilities,
      modelSelection: { kind: 'tracked', modelId: 'haiku' },
    })).toEqual([])
  })

  it('treats supportedEffortLevels as the effort support source of truth', () => {
    const inconsistentCapabilities = {
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      status: 'fresh',
      fetchedAt: 2_345,
      models: [
        {
          id: 'opus',
          displayName: 'Opus',
          provider: 'claude',
          supportsEffort: false,
          supportedEffortLevels: ['turbo'],
          supportsAdaptiveThinking: true,
        },
      ],
    } as const

    const resolved = resolveFreshAgentModelSelection({
      providerDefaultModelId: 'opus',
      capabilities: inconsistentCapabilities,
    })

    expect(getFreshAgentSupportedEffortLevels({
      providerDefaultModelId: 'opus',
      capabilities: inconsistentCapabilities,
    })).toEqual(['turbo'])
    expect(isFreshAgentEffortSupported(resolved.capability, 'turbo')).toBe(true)
  })

  it('builds settings options from provider-default, live capabilities, and unavailable exact selections', () => {
    expect(getFreshAgentSettingsModelOptions({
      providerDefaultModelId: 'opus',
      capabilities,
      modelSelection: { kind: 'exact', modelId: 'claude-opus-4-6' },
    })).toEqual([
      {
        value: FRESH_AGENT_PROVIDER_DEFAULT_MODEL_OPTION_VALUE,
        label: 'Provider default (track latest Opus)',
        description: 'Tracks latest Opus automatically.',
      },
      {
        value: getFreshAgentSettingsModelValue({ kind: 'tracked', modelId: 'opus' }),
        label: 'Opus',
        description: 'Latest Opus track',
      },
      {
        value: getFreshAgentSettingsModelValue({ kind: 'tracked', modelId: 'opus[1m]' }),
        label: 'Opus 1M',
        description: 'Long context',
      },
      {
        value: getFreshAgentSettingsModelValue({ kind: 'tracked', modelId: 'haiku' }),
        label: 'Haiku',
        description: 'Fast path',
      },
      {
        value: getFreshAgentSettingsModelValue(
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
    expect(getFreshAgentSettingsModelOptions({
      providerDefaultModelId: 'opus',
      capabilities: {
        ...capabilities,
        models: capabilities.models.filter((model) => model.id !== 'haiku'),
      },
      modelSelection: { kind: 'tracked', modelId: 'haiku' },
    })).toEqual([
      {
        value: FRESH_AGENT_PROVIDER_DEFAULT_MODEL_OPTION_VALUE,
        label: 'Provider default (track latest Opus)',
        description: 'Tracks latest Opus automatically.',
      },
      {
        value: getFreshAgentSettingsModelValue({ kind: 'tracked', modelId: 'opus' }),
        label: 'Opus',
        description: 'Latest Opus track',
      },
      {
        value: getFreshAgentSettingsModelValue({ kind: 'tracked', modelId: 'opus[1m]' }),
        label: 'Opus 1M',
        description: 'Long context',
      },
      {
        value: getFreshAgentSettingsModelValue({ kind: 'tracked', modelId: 'haiku' }),
        label: 'haiku (Saved selection)',
        description: 'Saved tracked model is not in the latest capability catalog.',
      },
    ])
  })

  it('maps provider-default and tracked settings values back into selection strategies', () => {
    expect(getFreshAgentSettingsModelValue(undefined)).toBe(FRESH_AGENT_PROVIDER_DEFAULT_MODEL_OPTION_VALUE)
    expect(parseFreshAgentSettingsModelValue(FRESH_AGENT_PROVIDER_DEFAULT_MODEL_OPTION_VALUE)).toBeUndefined()
    expect(parseFreshAgentSettingsModelValue(
      getFreshAgentSettingsModelValue({ kind: 'tracked', modelId: 'opus[1m]' }),
    )).toEqual({
      kind: 'tracked',
      modelId: 'opus[1m]',
    })
  })

  it('treats raw magic-string lookalikes as opaque tracked ids', () => {
    expect(parseFreshAgentSettingsModelValue('__provider_default__')).toEqual({
      kind: 'tracked',
      modelId: '__provider_default__',
    })
    expect(parseFreshAgentSettingsModelValue('__exact__:haiku')).toEqual({
      kind: 'tracked',
      modelId: '__exact__:haiku',
    })
  })

  it('round-trips unavailable exact settings values without downgrading them to tracked', () => {
    const unavailableOption = getFreshAgentSettingsModelOptions({
      providerDefaultModelId: 'opus',
      capabilities,
      modelSelection: { kind: 'exact', modelId: 'claude-opus-4-6' },
    }).find((option) => option.unavailable)

    expect(unavailableOption).toBeDefined()
    const selection = parseFreshAgentSettingsModelValue(unavailableOption!.value)
    expect(selection).toEqual({
      kind: 'exact',
      modelId: 'claude-opus-4-6',
    })
    expect(requiresFreshAgentModelCapabilityValidation({ modelSelection: selection ?? undefined })).toBe(true)
  })

  it('treats fetchedAt as a bounded freshness window instead of an unused field', () => {
    expect(isFreshAgentModelCapabilitiesFresh(capabilities, capabilities.fetchedAt)).toBe(true)
    expect(
      isFreshAgentModelCapabilitiesFresh(
        capabilities,
        capabilities.fetchedAt + FRESH_AGENT_MODEL_CAPABILITY_CACHE_TTL_MS,
      ),
    ).toBe(true)
    expect(
      isFreshAgentModelCapabilitiesFresh(
        capabilities,
        capabilities.fetchedAt + FRESH_AGENT_MODEL_CAPABILITY_CACHE_TTL_MS + 1,
      ),
    ).toBe(false)
  })

  it('builds a large capability catalog without catastrophic option-building regressions', () => {
    const largeCatalog = {
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      status: 'fresh',
      fetchedAt: 9_999,
      models: Array.from({ length: 2_000 }, (_, index) => ({
        id: `model-${index}`,
        displayName: `Model ${index}`,
        provider: 'claude' as const,
        description: `Synthetic model ${index}`,
        supportsEffort: index % 2 === 0,
        supportedEffortLevels: index % 2 === 0 ? ['turbo', 'warp', `custom-${index % 5}`] : [],
        supportsAdaptiveThinking: index % 3 === 0,
      })),
    } as const

    const start = performance.now()
    const options = getFreshAgentSettingsModelOptions({
      providerDefaultModelId: 'opus',
      capabilities: largeCatalog,
    })
    const durationMs = performance.now() - start

    expect(options).toHaveLength(2_001)
    expect(options[0]).toEqual({
      value: FRESH_AGENT_PROVIDER_DEFAULT_MODEL_OPTION_VALUE,
      label: 'Provider default (track latest Opus)',
      description: 'Tracks latest Opus automatically.',
    })
    expect(options.at(-1)).toEqual({
      value: getFreshAgentSettingsModelValue({ kind: 'tracked', modelId: 'model-1999' }),
      label: 'Model 1999',
      description: 'Synthetic model 1999',
    })
    expect(durationMs).toBeLessThan(1_000)
  })
})

describe('fresh-agent-model-capabilities opencode catalog helpers', () => {
  it('groups OpenCode capabilities by source and sorts sources and models alphabetically', () => {
    expect(groupFreshAgentModelCapabilitiesBySource(opencodeCapabilities)).toEqual([
      {
        source: { id: 'deepseek', displayName: 'deepseek' },
        models: [expect.objectContaining({ id: 'deepseek/deepseek-v4-flash' })],
      },
      {
        source: { id: 'opencode-go', displayName: 'opencode-go' },
        models: [
          expect.objectContaining({ id: 'opencode-go/deepseek-v4-pro' }),
          expect.objectContaining({ id: 'opencode-go/glm-5.2' }),
        ],
      },
    ])
  })

  it('filters grouped OpenCode capabilities by source, display name, and model id', () => {
    const grouped = groupFreshAgentModelCapabilitiesBySource(opencodeCapabilities)

    expect(filterFreshAgentModelCapabilitiesByQuery(grouped, 'glm').flatMap((group) => group.models.map((model) => model.id))).toEqual([
      'opencode-go/glm-5.2',
    ])
    expect(filterFreshAgentModelCapabilitiesByQuery(grouped, 'deepseek').map((group) => group.source.id)).toEqual([
      'deepseek',
      'opencode-go',
    ])
  })

  it('resolves an OpenCode capability by stable provider-qualified id', () => {
    expect(resolveFreshOpencodeCapabilityById(opencodeCapabilities, 'opencode-go/glm-5.2')).toEqual(
      expect.objectContaining({ displayName: 'GLM 5.2' }),
    )
    expect(resolveFreshOpencodeCapabilityById(opencodeCapabilities, 'glm-5.2')).toBeUndefined()
  })

  it('caps rendered model rows while preserving source grouping order', () => {
    const grouped = groupFreshAgentModelCapabilitiesBySource({
      ...opencodeCapabilities,
      models: Array.from({ length: 300 }, (_, index) => ({
        id: `opencode-go/model-${String(index).padStart(3, '0')}`,
        displayName: `Model ${String(index).padStart(3, '0')}`,
        provider: 'opencode' as const,
        source: { id: 'opencode-go', displayName: 'opencode-go' },
        supportsEffort: true,
        supportedEffortLevels: ['high'],
        supportsAdaptiveThinking: true,
      })),
    })

    const capped = capFreshAgentModelSourceRows(grouped, 250)

    expect(capped.groups.flatMap((group) => group.models)).toHaveLength(250)
    expect(capped.hiddenCount).toBe(50)
  })
})

describe('mergeClaudeSelectorOptions', () => {
  const staticOptions = [
    {
      value: 'opus[1m]',
      label: 'Claude Opus 5 (1M context)',
      thinkingEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
    },
  ] as const

  it('appends non-duplicate probed rows after the statics, deduping by id', () => {
    const merged = mergeClaudeSelectorOptions({
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      status: 'fresh',
      fetchedAt: 1_234,
      models: [
        {
          id: 'opus[1m]',
          displayName: 'Probed duplicate that must not replace the static',
          provider: 'claude',
          supportsEffort: false,
          supportedEffortLevels: [],
          supportsAdaptiveThinking: false,
        },
        {
          id: 'claude-opus-4-7',
          displayName: 'Claude Opus 4.7',
          provider: 'claude',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'high'],
          supportsAdaptiveThinking: false,
        },
        {
          id: 'sonnet',
          displayName: 'Sonnet',
          provider: 'claude',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high'],
          supportsAdaptiveThinking: true,
        },
      ],
    }, staticOptions)

    expect(merged.modelOptions).toEqual([
      {
        value: 'opus[1m]',
        label: 'Claude Opus 5 (1M context)',
        thinkingEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'high',
      },
      { value: 'claude-opus-4-7', label: 'Claude Opus 4.7', thinkingEfforts: ['low', 'high'] },
      { value: 'sonnet', label: 'Sonnet', thinkingEfforts: ['low', 'medium', 'high'] },
    ])
  })

  it('carries catalog effort levels onto probed rows as thinkingEfforts, never a defaultEffort', () => {
    const merged = mergeClaudeSelectorOptions({
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      status: 'fresh',
      fetchedAt: 1_234,
      models: [
        {
          id: 'sonnet',
          displayName: 'Sonnet',
          provider: 'claude',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'high'],
          supportsAdaptiveThinking: false,
        },
      ],
    }, staticOptions)

    expect(merged.modelOptions.at(-1)).toEqual({
      value: 'sonnet',
      label: 'Sonnet',
      thinkingEfforts: ['low', 'high'],
    })
    expect(merged.modelOptions.at(-1)).not.toHaveProperty('defaultEffort')
  })

  it('yields empty thinkingEfforts for probed rows without usable effort data', () => {
    const merged = mergeClaudeSelectorOptions({
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      status: 'fresh',
      fetchedAt: 1_234,
      models: [
        {
          id: 'haiku',
          displayName: 'Haiku',
          provider: 'claude',
          supportsEffort: false,
          supportedEffortLevels: ['low', 'high'],
          supportsAdaptiveThinking: false,
        },
        {
          id: 'levels-absent-at-runtime',
          displayName: 'Levels absent',
          provider: 'claude',
          supportsEffort: true,
          supportsAdaptiveThinking: false,
        },
      ] as unknown as FreshAgentModelCapabilities['models'],
    }, staticOptions)

    expect(merged.modelOptions.at(-2)).toEqual({
      value: 'haiku',
      label: 'Haiku',
      thinkingEfforts: [],
    })
    expect(merged.modelOptions.at(-1)).toEqual({
      value: 'levels-absent-at-runtime',
      label: 'Levels absent',
      thinkingEfforts: [],
    })
  })

  it('returns statics and static labels unchanged for a null catalog', () => {
    const merged = mergeClaudeSelectorOptions(null, staticOptions)

    expect(merged.modelOptions).toEqual(staticOptions)
  })

  it('returns statics and static labels unchanged for an empty catalog', () => {
    const merged = mergeClaudeSelectorOptions({
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      status: 'fresh',
      fetchedAt: 1_234,
      models: [],
    }, staticOptions)

    expect(merged.modelOptions).toEqual(staticOptions)
  })
})

describe('mergeClaudeModelCapabilities', () => {
  const staticCapabilities = getFreshAgentStaticModelCapabilities('freshclaude')!

  it('leaves the statics untouched when the probe catalog is absent (ok:false surfaces as undefined)', () => {
    expect(mergeClaudeModelCapabilities(staticCapabilities, undefined)).toBe(staticCapabilities)
  })

  it('keeps the statics as the full row set for an empty probe catalog', () => {
    const merged = mergeClaudeModelCapabilities(staticCapabilities, {
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      status: 'fresh',
      fetchedAt: 4_321,
      models: [],
    })

    expect(merged.models).toEqual(staticCapabilities.models)
    expect(merged.fetchedAt).toBe(4_321)
  })

  it('drops probed rows whose id matches a static id (static label wins)', () => {
    const merged = mergeClaudeModelCapabilities(staticCapabilities, {
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      status: 'fresh',
      fetchedAt: 4_321,
      models: [
        {
          id: 'opus[1m]',
          displayName: 'Probed duplicate that must not replace the static',
          provider: 'claude',
          description: 'Duplicate alias row',
          supportsEffort: false,
          supportedEffortLevels: [],
          supportsAdaptiveThinking: true,
        },
      ],
    })

    expect(merged.models).toHaveLength(1)
    expect(merged.models[0]).toMatchObject({
      id: 'opus[1m]',
      displayName: 'Claude Opus 5 (1M context)',
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      supportsAdaptiveThinking: false,
    })
  })

  it('appends probed-only rows verbatim in catalog order, preserving each row effort levels', () => {
    const merged = mergeClaudeModelCapabilities(staticCapabilities, {
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      status: 'fresh',
      fetchedAt: 4_321,
      models: [
        {
          id: 'sonnet',
          displayName: 'Sonnet alias row',
          provider: 'claude',
          description: 'Tracked alias',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'high'],
          supportsAdaptiveThinking: true,
        },
        {
          id: 'claude-opus-4-7',
          displayName: 'Claude Opus 4.7',
          provider: 'claude',
          supportsEffort: false,
          supportedEffortLevels: [],
          supportsAdaptiveThinking: false,
        },
      ],
    })

    expect(merged.models.map((model) => model.id)).toEqual(['opus[1m]', 'sonnet', 'claude-opus-4-7'])
    expect(merged.models[1]).toEqual({
      id: 'sonnet',
      displayName: 'Sonnet alias row',
      provider: 'claude',
      description: 'Tracked alias',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'high'],
      supportsAdaptiveThinking: true,
    })
    expect(merged.models[2]).toEqual({
      id: 'claude-opus-4-7',
      displayName: 'Claude Opus 4.7',
      provider: 'claude',
      supportsEffort: false,
      supportedEffortLevels: [],
      supportsAdaptiveThinking: false,
    })
    expect(merged.models[0].supportedEffortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('fresh-agent-model-capabilities static catalog mapping', () => {
  it('maps the freshcodex static menu into the shared capability shape', () => {
    const capabilities = getFreshAgentStaticModelCapabilities('freshcodex')

    expect(capabilities).toMatchObject({
      sessionType: 'freshcodex',
      runtimeProvider: 'codex',
      status: 'fresh',
    })
    expect(capabilities?.models.map((model) => model.id)).toEqual([
      'gpt-6-astra',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.3-codex-spark',
    ])
    expect(capabilities?.models[0]).toMatchObject({
      displayName: 'GPT-6 Astra',
      provider: 'codex',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      supportsAdaptiveThinking: false,
    })
    expect(capabilities?.models[1]?.supportedEffortLevels).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
    for (const model of capabilities?.models ?? []) {
      expect(model.source).toEqual({ id: 'openai', displayName: 'openai' })
    }
  })

  it('maps the claude static menu into the shared capability shape', () => {
    for (const sessionType of ['freshclaude', 'kilroy'] as const) {
      const capabilities = getFreshAgentStaticModelCapabilities(sessionType)

      expect(capabilities).toMatchObject({
        sessionType,
        runtimeProvider: 'claude',
        status: 'fresh',
      })
      expect(capabilities?.models.map((model) => model.id)).toEqual(['opus[1m]'])
      expect(capabilities?.models[0]).toMatchObject({
        displayName: 'Claude Opus 5 (1M context)',
        provider: 'claude',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        supportsAdaptiveThinking: false,
      })
      // No `source` on claude statics: statics and probed rows group together
      // under the provider fallback, exactly as the probed claude catalog does.
      expect(capabilities?.models[0]).not.toHaveProperty('source')
    }
  })

  it('does not fabricate a static catalog for session types without one', () => {
    expect(getFreshAgentStaticModelCapabilities('freshopencode')).toBeUndefined()
  })
})
