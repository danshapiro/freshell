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
export const FRESHOPENCODE_DEFAULT_EFFORT = 'max'

export const FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE = {
  freshclaude: [
    {
      value: 'opus[1m]',
      label: 'Claude Opus 5 (1M context)',
      thinkingEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
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
      value: 'opus[1m]',
      label: 'Claude Opus 5 (1M context)',
      thinkingEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: FRESHCLAUDE_DEFAULT_EFFORT,
    },
  ],
  freshopencode: [] as readonly FreshAgentModelOption[],
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
  if (provider === 'opencode') {
    const normalizedModel = normalizeFreshAgentModel(sessionType, provider, model)
    const hasStaticMenu = FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE.freshopencode
      .some((option) => option.value === normalizedModel)
    if (!hasStaticMenu) {
      // A live-catalog model the static fallback menu does not know has no
      // declared levels to clamp against. Absent/blank effort is the explicit
      // "Default" row from the model selector: pass it through as `undefined`
      // so NO variant is sent and opencode applies the model's own
      // provider-side default. (Previously this path force-defaulted to
      // FRESHOPENCODE_DEFAULT_EFFORT, fabricating a 'max' variant even for
      // models that declare no levels.) An explicit non-empty effort still
      // passes through verbatim — the REST `agent=opencode&effort=<level>`
      // contract is unchanged.
      const normalized = typeof effort === 'string' ? effort.trim() : ''
      return normalized.length > 0 ? normalized : undefined
    }
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
