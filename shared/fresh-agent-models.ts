import type { FreshAgentRuntimeProvider, FreshAgentSessionType } from './fresh-agent.js'

export type FreshAgentThinkingOption = {
  value: string
  label: string
}

export type FreshAgentModelOption = {
  value: string
  label: string
  thinkingEfforts?: readonly string[]
  defaultEffort?: string
}

export const FRESHCODEX_DEFAULT_MODEL = 'gpt-5.5'
export const FRESHCODEX_DEFAULT_EFFORT = 'max'
export const FRESHCLAUDE_DEFAULT_EFFORT = 'high'
export const FRESHOPENCODE_DEFAULT_MODEL = 'opencode-go/deepseek-v4-flash'
export const FRESHOPENCODE_DEFAULT_EFFORT = 'max'

export const FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE = {
  freshclaude: [
    {
      value: 'claude-opus-4-6',
      label: 'Claude Opus 4.6',
      thinkingEfforts: ['low', 'medium', 'high'],
      defaultEffort: FRESHCLAUDE_DEFAULT_EFFORT,
    },
  ],
  freshcodex: [
    {
      value: FRESHCODEX_DEFAULT_MODEL,
      label: 'GPT-5.5',
      thinkingEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'max'],
      defaultEffort: FRESHCODEX_DEFAULT_EFFORT,
    },
    {
      value: 'gpt-5.4-flash',
      label: 'GPT-5.4 Flash',
      thinkingEfforts: ['none', 'minimal', 'low', 'medium', 'high'],
      defaultEffort: 'high',
    },
    {
      value: 'gpt-5.3-codex-spark',
      label: 'GPT-5.3 Codex Spark',
      thinkingEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'max'],
      defaultEffort: FRESHCODEX_DEFAULT_EFFORT,
    },
  ],
  kilroy: [
    {
      value: 'claude-opus-4-6',
      label: 'Claude Opus 4.6',
      thinkingEfforts: ['low', 'medium', 'high'],
      defaultEffort: FRESHCLAUDE_DEFAULT_EFFORT,
    },
  ],
  freshopencode: [
    {
      value: FRESHOPENCODE_DEFAULT_MODEL,
      label: 'DeepSeek V4 Flash',
      thinkingEfforts: ['minimal', 'low', 'medium', 'high', 'max'],
      defaultEffort: FRESHOPENCODE_DEFAULT_EFFORT,
    },
    {
      value: 'opencode-go/glm-5.1',
      label: 'GLM 5.1',
      thinkingEfforts: ['minimal', 'low', 'medium', 'high', 'max'],
      defaultEffort: FRESHOPENCODE_DEFAULT_EFFORT,
    },
    {
      value: 'opencode-go/glm-5.2',
      label: 'GLM 5.2',
      thinkingEfforts: ['minimal', 'low', 'medium', 'high', 'max'],
      defaultEffort: FRESHOPENCODE_DEFAULT_EFFORT,
    },
    {
      value: 'umans-ai-coding-plan/umans-kimi-k2.7',
      label: 'Kimi k2.7',
      thinkingEfforts: ['minimal', 'low', 'medium', 'high', 'max'],
      defaultEffort: FRESHOPENCODE_DEFAULT_EFFORT,
    },
  ],
} as const satisfies Record<FreshAgentSessionType, readonly FreshAgentModelOption[]>

export const FRESHCODEX_MODEL_OPTIONS = FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE.freshcodex
export const FRESHOPENCODE_MODEL_OPTIONS = FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE.freshopencode

function defaultModelForSession(sessionType: FreshAgentSessionType): FreshAgentModelOption | undefined {
  return FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE[sessionType]?.[0]
}

export function resolveFreshAgentModelOption(
  sessionType: FreshAgentSessionType,
  model: string | undefined,
): FreshAgentModelOption | undefined {
  const options = FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE[sessionType] ?? []
  return options.find((option) => option.value === model) ?? defaultModelForSession(sessionType)
}

export function normalizeFreshcodexModel(model: string | undefined): string {
  const option = FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE.freshcodex.find((candidate) => candidate.value === model)
  return option?.value ?? FRESHCODEX_DEFAULT_MODEL
}

export function normalizeFreshAgentModel(
  sessionType: FreshAgentSessionType,
  provider: FreshAgentRuntimeProvider,
  model: string | undefined,
): string | undefined {
  if (provider === 'codex') {
    return normalizeFreshcodexModel(model)
  }
  if (provider === 'opencode') {
    const trimmed = typeof model === 'string' ? model.trim() : ''
    return trimmed.length > 0 ? trimmed : defaultModelForSession(sessionType)?.value
  }
  return model
}

export function getFreshAgentThinkingOptions(
  sessionType: FreshAgentSessionType,
  provider: FreshAgentRuntimeProvider,
  model: string | undefined,
): readonly FreshAgentThinkingOption[] {
  const normalizedModel = normalizeFreshAgentModel(sessionType, provider, model)
  const modelOption = resolveFreshAgentModelOption(sessionType, normalizedModel)
  return (modelOption?.thinkingEfforts ?? []).map((value) => ({ value, label: value }))
}

export function normalizeFreshAgentEffort(
  sessionType: FreshAgentSessionType,
  provider: FreshAgentRuntimeProvider,
  model: string | undefined,
  effort: string | undefined,
): string | undefined {
  const options = getFreshAgentThinkingOptions(sessionType, provider, model)
  if (provider === 'opencode' && options.length === 0) {
    const normalized = typeof effort === 'string' ? effort.trim() : ''
    return normalized.length > 0 ? normalized : FRESHOPENCODE_DEFAULT_EFFORT
  }
  const normalizedEffort = provider === 'codex' && effort === 'xhigh' ? 'max' : effort
  if (normalizedEffort && options.some((option) => option.value === normalizedEffort)) {
    return normalizedEffort
  }
  const normalizedModel = normalizeFreshAgentModel(sessionType, provider, model)
  const modelOption = resolveFreshAgentModelOption(sessionType, normalizedModel)
  if (modelOption?.defaultEffort && options.some((option) => option.value === modelOption.defaultEffort)) {
    return modelOption.defaultEffort
  }
  return options[options.length - 1]?.value
}
