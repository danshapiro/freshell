import { describe, expect, it } from 'vitest'

import {
  getEffectiveFreshAgentEffort,
  resolveFreshAgentType,
  resolveFreshAgentPaneCreateEffort,
} from '@/lib/fresh-agent-registry'

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
