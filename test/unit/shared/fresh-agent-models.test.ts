import { describe, expect, it } from 'vitest'

import {
  FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE,
  getFreshAgentThinkingOptions,
  normalizeFreshAgentModel,
  resolveFreshAgentModelOption,
} from '@shared/fresh-agent-models'

describe('fresh-agent-models freshopencode options', () => {
  const GLM_5_2_MODEL = 'opencode-go/glm-5.2'
  const KIMI_K2_7_MODEL = 'umans-ai-coding-plan/umans-kimi-k2.7'

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
