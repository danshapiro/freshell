import { describe, expect, it } from 'vitest'

import {
  FRESHOPENCODE_DEFAULT_EFFORT,
  FRESHOPENCODE_DEFAULT_MODEL,
  FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE,
  getFreshAgentThinkingOptions,
  normalizeFreshAgentEffort,
  normalizeFreshAgentModel,
  resolveFreshAgentModelOption,
} from '@shared/fresh-agent-models'

describe('fresh-agent-models freshopencode options', () => {
  const GLM_5_2_MODEL = 'opencode-go/glm-5.2'
  const DEEPSEEK_V4_FLASH_MODEL = 'opencode-go/deepseek-v4-flash'
  const KIMI_K2_7_MODEL = 'umans-ai-coding-plan/umans-kimi-k2.7'

  it('uses GLM 5.2 as the Freshopencode default model', () => {
    expect(FRESHOPENCODE_DEFAULT_MODEL).toBe(GLM_5_2_MODEL)
    expect(FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE.freshopencode[0]).toMatchObject({
      value: GLM_5_2_MODEL,
      label: 'GLM 5.2',
    })
  })

  it('includes GLM 5.2 as a selectable Freshopencode model', () => {
    const option = resolveFreshAgentModelOption('freshopencode', GLM_5_2_MODEL)

    expect(option).toMatchObject({
      value: GLM_5_2_MODEL,
      label: 'GLM 5.2',
      thinkingEfforts: ['minimal', 'low', 'medium', 'high', 'max'],
      defaultEffort: 'max',
    })
  })

  it('normalizes the GLM 5.2 model value for the opencode runtime provider', () => {
    const normalized = normalizeFreshAgentModel('freshopencode', 'opencode', GLM_5_2_MODEL)

    expect(normalized).toBe(GLM_5_2_MODEL)
  })

  it('exposes the expected thinking levels for GLM 5.2', () => {
    const options = getFreshAgentThinkingOptions('freshopencode', 'opencode', GLM_5_2_MODEL)

    expect(options.map((o) => o.value)).toEqual(['minimal', 'low', 'medium', 'high', 'max'])
  })

  it('lists GLM 5.2 in the static Freshopencode options array', () => {
    const values = FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE.freshopencode.map((o) => o.value)

    expect(values).toContain(GLM_5_2_MODEL)
  })

  it('keeps DeepSeek V4 Flash selectable without making it the default', () => {
    const values = FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE.freshopencode.map((o) => o.value)

    expect(values).toContain(DEEPSEEK_V4_FLASH_MODEL)
    expect(FRESHOPENCODE_DEFAULT_MODEL).not.toBe(DEEPSEEK_V4_FLASH_MODEL)
  })

  it('includes Kimi k2.7 as a selectable Freshopencode model', () => {
    const option = resolveFreshAgentModelOption('freshopencode', KIMI_K2_7_MODEL)

    expect(option).toMatchObject({
      value: KIMI_K2_7_MODEL,
      label: 'Kimi k2.7',
      thinkingEfforts: ['minimal', 'low', 'medium', 'high', 'max'],
      defaultEffort: 'max',
    })
  })

  it('normalizes the Kimi k2.7 model value for the opencode runtime provider', () => {
    const normalized = normalizeFreshAgentModel('freshopencode', 'opencode', KIMI_K2_7_MODEL)

    expect(normalized).toBe(KIMI_K2_7_MODEL)
  })

  it('exposes the expected thinking levels for Kimi k2.7', () => {
    const options = getFreshAgentThinkingOptions('freshopencode', 'opencode', KIMI_K2_7_MODEL)

    expect(options.map((o) => o.value)).toEqual(['minimal', 'low', 'medium', 'high', 'max'])
  })

  it('lists Kimi k2.7 in the static Freshopencode options array', () => {
    const values = FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE.freshopencode.map((o) => o.value)

    expect(values).toContain(KIMI_K2_7_MODEL)
  })
})

describe('fresh-agent-models freshopencode live catalog normalization', () => {
  it('preserves provider-qualified Freshopencode model ids from the live catalog', () => {
    expect(normalizeFreshAgentModel('freshopencode', 'opencode', 'deepseek/deepseek-v4-pro')).toBe('deepseek/deepseek-v4-pro')
    expect(normalizeFreshAgentModel('freshopencode', 'opencode', 'opencode-go/glm-5.2')).toBe('opencode-go/glm-5.2')
  })

  it('falls back to the Freshopencode default only for missing or blank model ids', () => {
    expect(normalizeFreshAgentModel('freshopencode', 'opencode', undefined)).toBe(FRESHOPENCODE_DEFAULT_MODEL)
    expect(normalizeFreshAgentModel('freshopencode', 'opencode', '   ')).toBe(FRESHOPENCODE_DEFAULT_MODEL)
  })

  it('preserves Freshopencode effort for live-catalog models not present in the static fallback list', () => {
    expect(normalizeFreshAgentEffort('freshopencode', 'opencode', 'deepseek/deepseek-v4-pro', 'high')).toBe('high')
    expect(normalizeFreshAgentEffort('freshopencode', 'opencode', 'deepseek/deepseek-v4-pro', undefined)).toBe(FRESHOPENCODE_DEFAULT_EFFORT)
  })
})
