import { describe, expect, it } from 'vitest'

import {
  getEffectiveFreshAgentEffort,
  resolveFreshAgentPaneModelDefaults,
  resolveFreshAgentType,
  resolveFreshAgentPaneCreateEffort,
  type FreshAgentRegistryEntry,
} from '@/lib/fresh-agent-registry'

function registryEntry(sessionType: string): FreshAgentRegistryEntry {
  const entry = resolveFreshAgentType(sessionType)
  if (!entry) throw new Error(`no registry entry for ${sessionType}`)
  return entry
}

describe('fresh-agent registry', () => {
  it('keeps kilroy as a hidden claude-backed fresh-agent type', () => {
    expect(resolveFreshAgentType('kilroy')).toMatchObject({
      runtimeProvider: 'claude',
      hidden: true,
    })
  })

  it('registers freshcodex as a codex-backed session type', () => {
    expect(resolveFreshAgentType('freshcodex')).toMatchObject({
      runtimeProvider: 'codex',
      label: 'Freshcodex',
    })
  })
})

describe('resolveFreshAgentPaneCreateEffort', () => {
  it('keeps claude/codex falling back to the registry default effort', () => {
    expect(resolveFreshAgentPaneCreateEffort({
      sessionType: 'freshclaude',
      provider: 'claude',
      model: 'claude-opus-4-6',
      providerEffort: undefined,
      fallbackEffort: 'high',
    })).toBe('high')
    expect(resolveFreshAgentPaneCreateEffort({
      sessionType: 'freshcodex',
      provider: 'codex',
      model: 'gpt-5.5',
      providerEffort: undefined,
      fallbackEffort: 'max',
    })).toBe('max')
  })

  it('passes an explicit freshopencode provider default through for live-catalog models', () => {
    expect(resolveFreshAgentPaneCreateEffort({
      sessionType: 'freshopencode',
      provider: 'opencode',
      model: 'deepseek/deepseek-v4-pro',
      providerEffort: 'high',
      fallbackEffort: 'max',
    })).toBe('high')
  })

  it('does not fabricate a variant for live-catalog freshopencode models when no default is staged', () => {
    // A cleared provider default (the selector committed Default for this
    // model) must not come back as 'max' for new panes.
    expect(resolveFreshAgentPaneCreateEffort({
      sessionType: 'freshopencode',
      provider: 'opencode',
      model: 'deepseek/deepseek-v4-pro',
      providerEffort: undefined,
      fallbackEffort: 'max',
    })).toBeUndefined()
  })

  it('does not fabricate effort for freshopencode models when nothing is staged (no static menu)', () => {
    expect(resolveFreshAgentPaneCreateEffort({
      sessionType: 'freshopencode',
      provider: 'opencode',
      model: 'opencode-go/glm-5.2',
      providerEffort: undefined,
      fallbackEffort: 'max',
    })).toBeUndefined()
  })
})

describe('getEffectiveFreshAgentEffort', () => {
  it('keeps a staged probed-model effort the stamped selection-time levels know', () => {
    // 'sonnet' is a probed-only claude model (absent from the static table):
    // static-table normalization would re-clamp 'alpha' to the static
    // default's 'high', silently losing the staged value.
    expect(getEffectiveFreshAgentEffort({
      sessionType: 'freshclaude',
      provider: 'claude',
      model: 'sonnet',
      effort: 'alpha',
      modelEffortLevels: ['alpha', 'beta'],
    })).toBe('alpha')
  })

  it('re-clamps a staged effort the stamped levels do not know to the first stamped level', () => {
    expect(getEffectiveFreshAgentEffort({
      sessionType: 'freshclaude',
      provider: 'claude',
      model: 'sonnet',
      effort: 'high',
      modelEffortLevels: ['alpha', 'beta'],
    })).toBe('alpha')
  })

  it('clears the effort when the stamp records a probed model with no levels', () => {
    // An empty stamped array is still a stamp: the selected model declared
    // zero effort levels, so the pane has no effort — never the static
    // default's fabricated fallback.
    expect(getEffectiveFreshAgentEffort({
      sessionType: 'freshclaude',
      provider: 'claude',
      model: 'haiku',
      effort: 'high',
      modelEffortLevels: [],
    })).toBeUndefined()
  })

  it('keeps static-table normalization for a probed model with no stamp (restored/REST panes)', () => {
    // Regression witness: no stamp means the selector never ran for this
    // pane, so the pre-fix static fallback ('alpha' unknown to the static
    // default's levels → its defaultEffort 'high') is unchanged.
    expect(getEffectiveFreshAgentEffort({
      sessionType: 'freshclaude',
      provider: 'claude',
      model: 'sonnet',
      effort: 'alpha',
    })).toBe('high')
  })

  it('ignores the stamp for static-table models (their static levels are authoritative)', () => {
    expect(getEffectiveFreshAgentEffort({
      sessionType: 'freshclaude',
      provider: 'claude',
      model: 'opus[1m]',
      effort: 'alpha',
      modelEffortLevels: ['alpha', 'beta'],
    })).toBe('high')
  })

  it('does not consult the stamp on the opencode path (byte-identical behavior)', () => {
    expect(getEffectiveFreshAgentEffort({
      sessionType: 'freshopencode',
      provider: 'opencode',
      model: 'deepseek/deepseek-v4-pro',
      effort: 'high',
      modelEffortLevels: ['alpha'],
    })).toBe('high')
  })
})

describe('resolveFreshAgentPaneModelDefaults', () => {
  const saved = (modelId: string) => ({ modelSelection: { kind: 'exact' as const, modelId } })

  it.each([
    // [label, sessionType, providerSettings, runtimeProviderModel, expected model, expected persistModel]
    ['claude: saved default wins', 'freshclaude', saved('sonnet'), undefined, 'sonnet', true],
    ['claude: registry default when nothing is saved', 'freshclaude', undefined, undefined, 'opus[1m]', true],
    ['claude: a blank saved id falls back to the registry default', 'freshclaude', saved('   '), undefined, 'opus[1m]', true],
    ['claude: never falls back to the terminal CLI model (D1)', 'freshclaude', undefined, 'haiku', 'opus[1m]', true],
    ['claude: saved default beats the terminal CLI model', 'freshclaude', saved('sonnet'), 'haiku', 'sonnet', true],
    ['kilroy: saved default wins', 'kilroy', saved('sonnet'), undefined, 'sonnet', true],
    ['kilroy: registry default when nothing is saved', 'kilroy', undefined, undefined, 'opus[1m]', true],
    ['codex: saved default wins', 'freshcodex', saved('gpt-5.6-luna'), 'gpt-5.6-terra', 'gpt-5.6-luna', true],
    ['codex: runtime CLI model when nothing is saved', 'freshcodex', undefined, 'gpt-5.6-terra', 'gpt-5.6-terra', true],
    ['codex: unknown saved model normalizes to the codex default', 'freshcodex', saved('gpt-unknown'), undefined, 'gpt-6-astra', true],
    ['codex: registry default when nothing is configured', 'freshcodex', undefined, undefined, 'gpt-6-astra', true],
    ['opencode: saved default persists', 'freshopencode', saved('umans/kimi'), undefined, 'umans/kimi', true],
    ['opencode: runtime CLI model persists', 'freshopencode', undefined, 'umans/kimi', 'umans/kimi', true],
    ['opencode: nothing configured persists no model', 'freshopencode', undefined, undefined, undefined, false],
  ] as const)('%s', (_label, sessionType, providerSettings, runtimeProviderModel, model, persistModel) => {
    const result = resolveFreshAgentPaneModelDefaults({
      entry: registryEntry(sessionType),
      providerSettings,
      runtimeProviderModel,
    })
    expect(result.model).toBe(model)
    expect(result.persistModel).toBe(persistModel)
  })
})
