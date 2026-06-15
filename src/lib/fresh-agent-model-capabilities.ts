import type {
  FreshAgentModelCapabilities,
  FreshAgentExactModelSelection,
  FreshAgentModelCapability,
  FreshAgentModelCapabilitiesResponse,
  FreshAgentModelSelection,
} from '@shared/fresh-agent-model-capabilities'
import {
  FRESH_AGENT_MODEL_CAPABILITY_CACHE_TTL_MS as FRESH_AGENT_MODEL_CAPABILITY_CACHE_TTL_MS_VALUE,
  FreshAgentModelCapabilitiesResponseSchema,
} from '@shared/fresh-agent-model-capabilities'

export const FRESH_AGENT_MODEL_CAPABILITY_CACHE_TTL_MS = FRESH_AGENT_MODEL_CAPABILITY_CACHE_TTL_MS_VALUE

const FRESH_AGENT_MODEL_SELECTION_OPTION_VALUE_PREFIX = '__agent_chat_selection__:'

type EncodedFreshAgentSettingsModelValue =
  | { kind: 'provider-default' }
  | FreshAgentModelSelection

function encodeFreshAgentSettingsModelValue(
  value: EncodedFreshAgentSettingsModelValue,
): string {
  return `${FRESH_AGENT_MODEL_SELECTION_OPTION_VALUE_PREFIX}${encodeURIComponent(JSON.stringify(value))}`
}

function decodeFreshAgentSettingsModelValue(
  value: string,
): EncodedFreshAgentSettingsModelValue | undefined {
  if (!value.startsWith(FRESH_AGENT_MODEL_SELECTION_OPTION_VALUE_PREFIX)) {
    return undefined
  }

  try {
    const parsed = JSON.parse(
      decodeURIComponent(value.slice(FRESH_AGENT_MODEL_SELECTION_OPTION_VALUE_PREFIX.length)),
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

export const FRESH_AGENT_PROVIDER_DEFAULT_MODEL_OPTION_VALUE = encodeFreshAgentSettingsModelValue({
  kind: 'provider-default',
})

export type FreshAgentSettingsModelOption = {
  value: string
  label: string
  description?: string
  unavailable?: boolean
}

export type ResolvedFreshAgentModelSelection =
  | {
      source: 'provider-default'
      resolvedModelId: string
      capability?: FreshAgentModelCapability
      unavailableExactSelection?: undefined
    }
  | {
      source: 'tracked'
      resolvedModelId: string
      capability?: FreshAgentModelCapability
      unavailableExactSelection?: undefined
    }
  | {
      source: 'exact'
      resolvedModelId: string
      capability: FreshAgentModelCapability
      unavailableExactSelection?: undefined
    }
  | {
      source: 'exact'
      resolvedModelId?: undefined
      capability?: undefined
      unavailableExactSelection: FreshAgentExactModelSelection
    }

type ResolveFreshAgentModelSelectionArgs = {
  providerDefaultModelId: string
  capabilities?: FreshAgentModelCapabilities
  modelSelection?: FreshAgentModelSelection
}

export function getFreshAgentModelCapability(
  capabilities: FreshAgentModelCapabilities | undefined,
  modelId: string,
): FreshAgentModelCapability | undefined {
  return capabilities?.models.find((model) => model.id === modelId)
}

export function resolveFreshAgentModelSelection(
  args: ResolveFreshAgentModelSelectionArgs,
): ResolvedFreshAgentModelSelection {
  if (!args.modelSelection) {
    return {
      source: 'provider-default',
      resolvedModelId: args.providerDefaultModelId,
      capability: getFreshAgentModelCapability(args.capabilities, args.providerDefaultModelId),
    }
  }

  const capability = getFreshAgentModelCapability(args.capabilities, args.modelSelection.modelId)
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

export function parseFreshAgentModelCapabilitiesResponse(
  value: unknown,
): FreshAgentModelCapabilitiesResponse {
  return FreshAgentModelCapabilitiesResponseSchema.parse(value)
}

export function getFreshAgentSupportedEffortLevels(
  args: ResolveFreshAgentModelSelectionArgs,
): string[] {
  return resolveFreshAgentModelSelection(args).capability?.supportedEffortLevels ?? []
}

export function isFreshAgentModelCapabilitiesFresh(
  capabilities: FreshAgentModelCapabilities | undefined,
  now: number = Date.now(),
  ttlMs: number = FRESH_AGENT_MODEL_CAPABILITY_CACHE_TTL_MS,
): boolean {
  return Boolean(capabilities && now - capabilities.fetchedAt <= ttlMs)
}

export function getFreshAgentSettingsModelValue(
  modelSelection: FreshAgentModelSelection | undefined,
  capabilities?: FreshAgentModelCapabilities,
): string {
  if (!modelSelection) {
    return FRESH_AGENT_PROVIDER_DEFAULT_MODEL_OPTION_VALUE
  }

  if (
    modelSelection.kind === 'exact'
    && !getFreshAgentModelCapability(capabilities, modelSelection.modelId)
  ) {
    return encodeFreshAgentSettingsModelValue(modelSelection)
  }

  return encodeFreshAgentSettingsModelValue({
    kind: 'tracked',
    modelId: modelSelection.modelId,
  })
}

export function parseFreshAgentSettingsModelValue(
  value: string,
): FreshAgentModelSelection | undefined {
  const decoded = decodeFreshAgentSettingsModelValue(value)
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

export function requiresFreshAgentModelCapabilityValidation(args: {
  modelSelection?: FreshAgentModelSelection
  effort?: string
}): boolean {
  return Boolean(args.effort) || args.modelSelection?.kind === 'exact'
}

export function isFreshAgentEffortSupported(
  capability: FreshAgentModelCapability | undefined,
  effort: string | undefined,
): boolean {
  return Boolean(
    capability
    && effort
    && capability.supportedEffortLevels.includes(effort),
  )
}

export function getFreshAgentModelOptions(
  capabilities: FreshAgentModelCapabilities | undefined,
): Array<{ value: string; displayName: string; description?: string }> | undefined {
  const options = capabilities?.models.map((model) => ({
    value: model.id,
    displayName: model.displayName,
    description: model.description,
  })) ?? []

  return options.length > 0 ? options : undefined
}

export function getFreshAgentSettingsModelOptions(args: ResolveFreshAgentModelSelectionArgs): FreshAgentSettingsModelOption[] {
  const options: FreshAgentSettingsModelOption[] = [
    {
      value: FRESH_AGENT_PROVIDER_DEFAULT_MODEL_OPTION_VALUE,
      label: 'Provider default (track latest Opus)',
      description: 'Tracks latest Opus automatically.',
    },
    ...(args.capabilities?.models.map((model) => ({
      value: getFreshAgentSettingsModelValue({ kind: 'tracked', modelId: model.id }),
      label: model.displayName,
      description: model.description,
    })) ?? []),
  ]

  const resolvedSelection = resolveFreshAgentModelSelection(args)
  if (resolvedSelection.source === 'tracked' && !resolvedSelection.capability) {
    options.push({
      value: getFreshAgentSettingsModelValue({
        kind: 'tracked',
        modelId: resolvedSelection.resolvedModelId,
      }),
      label: `${resolvedSelection.resolvedModelId} (Saved selection)`,
      description: 'Saved tracked model is not in the latest capability catalog.',
    })
  }

  if (resolvedSelection.unavailableExactSelection) {
    options.push({
      value: getFreshAgentSettingsModelValue(
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
