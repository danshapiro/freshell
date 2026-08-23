import {
  getFreshAgentDescriptor,
  type FreshAgentRuntimeProvider,
  type FreshAgentSessionType,
} from '@shared/fresh-agent'
import {
  CodexIcon,
  FreshclaudeIcon,
  KilroyIcon,
  OpencodeIcon,
} from '@/components/icons/provider-icons'
import {
  FRESHCODEX_DEFAULT_EFFORT,
  FRESHCODEX_DEFAULT_MODEL,
  FRESHCLAUDE_DEFAULT_EFFORT,
  FRESHOPENCODE_DEFAULT_EFFORT,
} from '@/lib/fresh-agent-models'
export {
  FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE,
  FRESHCODEX_DEFAULT_EFFORT,
  FRESHCODEX_DEFAULT_MODEL,
  FRESHCLAUDE_DEFAULT_EFFORT,
  FRESHCODEX_MODEL_OPTIONS,
  FRESHOPENCODE_DEFAULT_EFFORT,
  FRESHOPENCODE_MODEL_OPTIONS,
  getFreshAgentThinkingOptions,
  normalizeFreshAgentEffort,
  normalizeFreshAgentModel,
  normalizeFreshcodexModel,
} from '@/lib/fresh-agent-models'
// `export ... from` above does not bind module-scope names; import the
// normalizers and the static options table for the effective-value helpers
// below.
import {
  FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE,
  normalizeFreshAgentEffort,
  normalizeFreshAgentModel,
} from '@/lib/fresh-agent-models'
import type { FreshAgentPaneContent } from '@/store/paneTypes'

export type FreshAgentRegistryEntry = {
  sessionType: FreshAgentSessionType
  runtimeProvider: FreshAgentRuntimeProvider
  label: string
  icon: React.ComponentType<{ className?: string }>
  defaultModel?: string
  defaultPermissionMode: string
  defaultEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  settingsVisibility: {
    model: boolean
    permissionMode: boolean
    effort: boolean
    thinking: boolean
    tools: boolean
    timecodes: boolean
  }
  pickerShortcut: string
  pickerAfterCli?: boolean
  hidden?: boolean
  disabled?: boolean
  featureFlag?: string
}

export const FRESH_AGENT_REGISTRY: readonly FreshAgentRegistryEntry[] = [
  {
    sessionType: 'freshclaude',
    runtimeProvider: 'claude',
    label: 'Freshclaude',
    icon: FreshclaudeIcon,
    defaultModel: 'opus[1m]',
    defaultPermissionMode: 'bypassPermissions',
    defaultEffort: FRESHCLAUDE_DEFAULT_EFFORT,
    settingsVisibility: {
      model: true,
      permissionMode: true,
      effort: true,
      thinking: true,
      tools: true,
      timecodes: true,
    },
    pickerShortcut: 'A',
  },
  {
    sessionType: 'freshcodex',
    runtimeProvider: 'codex',
    label: 'Freshcodex',
    icon: CodexIcon,
    defaultModel: FRESHCODEX_DEFAULT_MODEL,
    defaultPermissionMode: 'on-request',
    defaultEffort: FRESHCODEX_DEFAULT_EFFORT,
    settingsVisibility: {
      model: true,
      permissionMode: true,
      effort: true,
      thinking: true,
      tools: true,
      timecodes: true,
    },
    pickerShortcut: 'X',
    pickerAfterCli: true,
  },
  {
    sessionType: 'kilroy',
    runtimeProvider: 'claude',
    label: 'Kilroy',
    icon: KilroyIcon,
    defaultModel: 'opus[1m]',
    defaultPermissionMode: 'bypassPermissions',
    defaultEffort: FRESHCLAUDE_DEFAULT_EFFORT,
    settingsVisibility: {
      model: true,
      permissionMode: true,
      effort: true,
      thinking: true,
      tools: true,
      timecodes: true,
    },
    pickerShortcut: 'K',
    pickerAfterCli: true,
    hidden: true,
    featureFlag: 'kilroy',
  },
  {
    sessionType: 'freshopencode',
    runtimeProvider: 'opencode',
    label: 'Freshopencode',
    icon: OpencodeIcon,
    defaultModel: undefined,
    defaultPermissionMode: 'default',
    defaultEffort: FRESHOPENCODE_DEFAULT_EFFORT,
    settingsVisibility: {
      model: true,
      permissionMode: false,
      effort: true,
      thinking: true,
      tools: true,
      timecodes: true,
    },
    pickerShortcut: 'O',
    pickerAfterCli: true,
  },
] as const

export function resolveFreshAgentType(
  sessionType: string | undefined,
): FreshAgentRegistryEntry | undefined {
  if (!sessionType) return undefined
  return FRESH_AGENT_REGISTRY.find((entry) => entry.sessionType === sessionType)
}

export function getFreshAgentLabel(sessionType: string | undefined): string {
  return resolveFreshAgentType(sessionType)?.label
    ?? getFreshAgentDescriptor(sessionType)?.label
    ?? 'Fresh Agent'
}

export type FreshAgentProviderDefaultsForModel = {
  modelSelection?: { modelId: string }
  effort?: string
}

/**
 * The pane's effective model: the staged pane value first, then the explicit
 * pane selection, then the persisted provider default, normalized for the
 * runtime provider. Shared by the send/create paths, the settings popover,
 * and the model+thinking dialog so a commit reads back exactly as staged.
 */
export function resolveEffectiveFreshAgentModel(
  content: Pick<FreshAgentPaneContent, 'sessionType' | 'provider' | 'model' | 'modelSelection'>,
  providerDefaults?: FreshAgentProviderDefaultsForModel,
): string | undefined {
  const configured = content.model
    ?? content.modelSelection?.modelId
    ?? providerDefaults?.modelSelection?.modelId
  return normalizeFreshAgentModel(content.sessionType, content.provider, configured)
}

/**
 * The pane's effective thinking level: the staged pane value first, then the
 * persisted provider default, normalized against the model's known levels.
 * For opencode live-catalog models an absent value stays absent (the model
 * selector's explicit Default — no variant is sent).
 *
 * Probed-only claude models (absent from the static menu) clamp against the
 * levels stamped onto the pane at selection time (`modelEffortLevels`)
 * instead of falling through to the static table's default-model fallback:
 * the staged value survives when the stamp knows it, an unknown staged value
 * re-clamps to the stamp's first level, and an empty stamp (the model
 * declared no levels) clears the effort. No stamp (REST/MCP/restored panes)
 * keeps the static-table normalization, unchanged.
 */
export function getEffectiveFreshAgentEffort(
  content: Pick<FreshAgentPaneContent, 'sessionType' | 'provider' | 'model' | 'modelSelection' | 'effort' | 'modelEffortLevels'>,
  providerDefaults?: FreshAgentProviderDefaultsForModel,
): string | undefined {
  const resolvedModel = resolveEffectiveFreshAgentModel(content, providerDefaults)
  if (
    content.provider === 'claude'
    && resolvedModel
    && Array.isArray(content.modelEffortLevels)
    && !(FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE[content.sessionType] ?? [])
      .some((option) => option.value === resolvedModel)
  ) {
    const levels = content.modelEffortLevels
    const staged = content.effort ?? providerDefaults?.effort
    if (staged && levels.includes(staged)) return staged
    return levels.length > 0 ? levels[0] : undefined
  }
  return normalizeFreshAgentEffort(
    content.sessionType,
    content.provider,
    resolvedModel,
    content.effort ?? providerDefaults?.effort,
  )
}

/**
 * The effort a NEW pane starts with. Non-opencode providers fall back to the
 * registry default when nothing is staged. For opencode, `normalizeFreshAgentEffort`
 * alone is authoritative: static-menu models clamp to their menu default, while
 * live-catalog models with no staged level resolve to NO effort — the selector's
 * explicit Default must not be re-fabricated as 'max' for new panes.
 */
export function resolveFreshAgentPaneCreateEffort(args: {
  sessionType: FreshAgentSessionType
  provider: FreshAgentRuntimeProvider
  model: string | undefined
  providerEffort: string | undefined
  fallbackEffort: string
}): string | undefined {
  const { sessionType, provider, model, providerEffort, fallbackEffort } = args
  if (provider === 'opencode') {
    return normalizeFreshAgentEffort(sessionType, provider, model, providerEffort)
  }
  return normalizeFreshAgentEffort(sessionType, provider, model, providerEffort ?? fallbackEffort)
    ?? fallbackEffort
}
