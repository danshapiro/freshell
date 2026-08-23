import { describe, expect, it } from 'vitest'

import {
  FRESHOPENCODE_DEFAULT_EFFORT,
  FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE,
  getFreshAgentThinkingOptions,
  normalizeFreshAgentEffort,
  normalizeFreshAgentModel,
  resolveFreshAgentModelOption,
} from '@shared/fresh-agent-models'

describe('fresh-agent-models freshopencode static menu', () => {
  it('has no static fallback entries for freshopencode (models come from the live catalog)', () => {
    expect(FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE.freshopencode).toEqual([])
  })

  it('does not expose a hardcoded default model for freshopencode', () => {
    expect(normalizeFreshAgentModel('freshopencode', 'opencode', undefined)).toBeUndefined()
    expect(normalizeFreshAgentModel('freshopencode', 'opencode', '   ')).toBeUndefined()
  })

  it('preserves provider-qualified freshopencode model ids from the live catalog', () => {
    expect(normalizeFreshAgentModel('freshopencode', 'opencode', 'deepseek/deepseek-v4-pro')).toBe('deepseek/deepseek-v4-pro')
    expect(normalizeFreshAgentModel('freshopencode', 'opencode', 'opencode-go/glm-5.2')).toBe('opencode-go/glm-5.2')
  })

  it('returns undefined for resolveFreshAgentModelOption when the model is not in the empty static menu', () => {
    expect(resolveFreshAgentModelOption('freshopencode', 'opencode-go/glm-5.2')).toBeUndefined()
  })
})

describe('fresh-agent-models freshopencode effort normalization', () => {
  it('passes through explicit effort for any opencode model (no static menu clamping)', () => {
    expect(normalizeFreshAgentEffort('freshopencode', 'opencode', 'any/model', 'high')).toBe('high')
    expect(normalizeFreshAgentEffort('freshopencode', 'opencode', 'opencode-go/glm-5.2', 'low')).toBe('low')
  })

  it('normalizes absent or blank effort to undefined for all opencode models (explicit Default)', () => {
    expect(normalizeFreshAgentEffort('freshopencode', 'opencode', 'any/model', undefined)).toBeUndefined()
    expect(normalizeFreshAgentEffort('freshopencode', 'opencode', 'any/model', '')).toBeUndefined()
    expect(normalizeFreshAgentEffort('freshopencode', 'opencode', 'any/model', '   ')).toBeUndefined()
  })

  it('exposes no thinking options for opencode models (effort levels come from the live catalog)', () => {
    expect(getFreshAgentThinkingOptions('freshopencode', 'opencode', 'any/model')).toEqual([])
  })

  it('keeps FRESHOPENCODE_DEFAULT_EFFORT as max for the registry default', () => {
    expect(FRESHOPENCODE_DEFAULT_EFFORT).toBe('max')
  })
})
