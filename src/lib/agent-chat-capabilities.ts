import type {
  AgentChatCapabilities,
  AgentChatExactModelSelection,
  AgentChatModelCapability,
  AgentChatModelSelection,
} from '@shared/agent-chat-capabilities'
import { AGENT_CHAT_CAPABILITY_CACHE_TTL_MS as AGENT_CHAT_CAPABILITY_CACHE_TTL_MS_VALUE } from '@shared/agent-chat-capabilities'

export const AGENT_CHAT_CAPABILITY_CACHE_TTL_MS = AGENT_CHAT_CAPABILITY_CACHE_TTL_MS_VALUE

const AGENT_CHAT_MODEL_SELECTION_OPTION_VALUE_PREFIX = '__agent_chat_selection__:'

type EncodedAgentChatSettingsModelValue =
  | { kind: 'provider-default' }
  | AgentChatModelSelection

function encodeAgentChatSettingsModelValue(
  value: EncodedAgentChatSettingsModelValue,
): string {
  return `${AGENT_CHAT_MODEL_SELECTION_OPTION_VALUE_PREFIX}${encodeURIComponent(JSON.stringify(value))}`
}

function decodeAgentChatSettingsModelValue(
  value: string,
): EncodedAgentChatSettingsModelValue | undefined {
  if (!value.startsWith(AGENT_CHAT_MODEL_SELECTION_OPTION_VALUE_PREFIX)) {
    return undefined
  }

  try {
    const parsed = JSON.parse(
      decodeURIComponent(value.slice(AGENT_CHAT_MODEL_SELECTION_OPTION_VALUE_PREFIX.length)),
    ) as unknown
    if (!parsed || typeof parsed !== 'object' || !('kind' in parsed)) {
      return undefined
    }

    const candidate = parsed as { kind?: unknown; modelId?: unknown }
    if (candidate.kind === 'provider-default') {
      return { kind: 'provider-default' }
    }
    if (
      (candidate.kind === 'tracked' || candidate.kind === 'exact')
      && typeof candidate.modelId === 'string'
      && candidate.modelId.trim().length > 0
    ) {
      return {
        kind: candidate.kind,
        modelId: candidate.modelId,
      }
    }
  } catch {
    return undefined
  }

  return undefined
}

export const AGENT_CHAT_PROVIDER_DEFAULT_OPTION_VALUE = encodeAgentChatSettingsModelValue({
  kind: 'provider-default',
})

export type AgentChatSettingsModelOption = {
  value: string
  label: string
  description?: string
  unavailable?: boolean
}

export type ResolvedAgentChatModelSelection =
  | {
      source: 'provider-default'
      resolvedModelId: string
      capability?: AgentChatModelCapability
      unavailableExactSelection?: undefined
    }
  | {
      source: 'tracked'
      resolvedModelId: string
      capability?: AgentChatModelCapability
      unavailableExactSelection?: undefined
    }
  | {
      source: 'exact'
      resolvedModelId: string
      capability: AgentChatModelCapability
      unavailableExactSelection?: undefined
    }
  | {
      source: 'exact'
      resolvedModelId?: undefined
      capability?: undefined
      unavailableExactSelection: AgentChatExactModelSelection
    }

type ResolveAgentChatModelSelectionArgs = {
  providerDefaultModelId: string
  capabilities?: AgentChatCapabilities
  modelSelection?: AgentChatModelSelection
}

export function getAgentChatModelCapability(
  capabilities: AgentChatCapabilities | undefined,
  modelId: string,
): AgentChatModelCapability | undefined {
  return capabilities?.models.find((model) => model.id === modelId)
}

export function resolveAgentChatModelSelection(
  args: ResolveAgentChatModelSelectionArgs,
): ResolvedAgentChatModelSelection {
  if (!args.modelSelection) {
    return {
      source: 'provider-default',
      resolvedModelId: args.providerDefaultModelId,
      capability: getAgentChatModelCapability(args.capabilities, args.providerDefaultModelId),
    }
  }

  const capability = getAgentChatModelCapability(args.capabilities, args.modelSelection.modelId)
  if (args.modelSelection.kind === 'tracked') {
    return {
      source: 'tracked',
      resolvedModelId: args.modelSelection.modelId,
      capability,
    }
  }

  if (capability) {
    return {
      source: 'exact',
      resolvedModelId: args.modelSelection.modelId,
      capability,
    }
  }

  return {
    source: 'exact',
    resolvedModelId: undefined,
    unavailableExactSelection: args.modelSelection,
  }
}

export function getAgentChatSupportedEffortLevels(
  args: ResolveAgentChatModelSelectionArgs,
): string[] {
  return resolveAgentChatModelSelection(args).capability?.supportedEffortLevels ?? []
}

export function isAgentChatCapabilitiesFresh(
  capabilities: AgentChatCapabilities | undefined,
  now: number = Date.now(),
  ttlMs: number = AGENT_CHAT_CAPABILITY_CACHE_TTL_MS,
): boolean {
  return Boolean(capabilities && now - capabilities.fetchedAt <= ttlMs)
}

export function getAgentChatSettingsModelValue(
  modelSelection: AgentChatModelSelection | undefined,
  capabilities?: AgentChatCapabilities,
): string {
  if (!modelSelection) {
    return AGENT_CHAT_PROVIDER_DEFAULT_OPTION_VALUE
  }

  if (
    modelSelection.kind === 'exact'
    && !getAgentChatModelCapability(capabilities, modelSelection.modelId)
  ) {
    return encodeAgentChatSettingsModelValue(modelSelection)
  }

  return encodeAgentChatSettingsModelValue({
    kind: 'tracked',
    modelId: modelSelection.modelId,
  })
}

export function parseAgentChatSettingsModelValue(
  value: string,
): AgentChatModelSelection | undefined {
  const decoded = decodeAgentChatSettingsModelValue(value)
  if (decoded) {
    if (decoded.kind === 'provider-default') {
      return undefined
    }
    return decoded
  }

  if (value.trim().length === 0) {
    return undefined
  }

  return {
    kind: 'tracked',
    modelId: value,
  }
}

export function requiresAgentChatCapabilityValidation(args: {
  modelSelection?: AgentChatModelSelection
  effort?: string
}): boolean {
  return Boolean(args.effort) || args.modelSelection?.kind === 'exact'
}

export function isAgentChatEffortSupported(
  capability: AgentChatModelCapability | undefined,
  effort: string | undefined,
): boolean {
  return Boolean(
    capability
    && effort
    && capability.supportedEffortLevels.includes(effort),
  )
}

export function getAgentChatModelOptions(
  capabilities: AgentChatCapabilities | undefined,
): Array<{ value: string; displayName: string; description?: string }> | undefined {
  const options = capabilities?.models.map((model) => ({
    value: model.id,
    displayName: model.displayName,
    description: model.description,
  })) ?? []

  return options.length > 0 ? options : undefined
}

export function getAgentChatSettingsModelOptions(args: ResolveAgentChatModelSelectionArgs): AgentChatSettingsModelOption[] {
  const options: AgentChatSettingsModelOption[] = [
    {
      value: AGENT_CHAT_PROVIDER_DEFAULT_OPTION_VALUE,
      label: 'Provider default (track latest Opus)',
      description: 'Tracks latest Opus automatically.',
    },
    ...(args.capabilities?.models.map((model) => ({
      value: getAgentChatSettingsModelValue({ kind: 'tracked', modelId: model.id }),
      label: model.displayName,
      description: model.description,
    })) ?? []),
  ]

  const resolvedSelection = resolveAgentChatModelSelection(args)
  if (resolvedSelection.source === 'tracked' && !resolvedSelection.capability) {
    options.push({
      value: getAgentChatSettingsModelValue({
        kind: 'tracked',
        modelId: resolvedSelection.resolvedModelId,
      }),
      label: `${resolvedSelection.resolvedModelId} (Saved selection)`,
      description: 'Saved tracked model is not in the latest capability catalog.',
    })
  }

  if (resolvedSelection.unavailableExactSelection) {
    options.push({
      value: getAgentChatSettingsModelValue(
        resolvedSelection.unavailableExactSelection,
        args.capabilities,
      ),
      label: `${resolvedSelection.unavailableExactSelection.modelId} (Unavailable)`,
      description: 'Saved legacy model is no longer available.',
      unavailable: true,
    })
  }

  return options
}
