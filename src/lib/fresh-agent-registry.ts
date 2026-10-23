import {
  getFreshAgentDescriptor,
  type FreshAgentRuntimeProvider,
  type FreshAgentSessionType,
} from '@shared/fresh-agent'
import {
  FreshclaudeIcon,
  FreshcodexIcon,
  FreshopencodeIcon,
  KilroyIcon,
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
    icon: FreshcodexIcon,
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
    hidden: true,
    featureFlag: 'kilroy',
  },
  {
    sessionType: 'freshopencode',
    runtimeProvider: 'opencode',
    label: 'Freshopencode',
    icon: FreshopencodeIcon,
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
  },
] as const

export function resolveFreshAgentType(
  sessionType: string | undefined,
): FreshAgentRegistryEntry | undefined {
  if (!sessionType) return undefined
  return FRESH_AGENT_REGISTRY.find((entry) => entry.sessionType === sessionType)
}

/**
 * Display names for the runtime providers that back fresh-agent panes, in the
 * approved-preview casing ("Claude", "Codex", "OpenCode"). Used where the UI
 * names the coding AGENT (e.g. the pane-header icon tooltip) rather than the
 * pane type — the registry `label` names the pane type ("Freshclaude", …).
 */
export const FRESH_AGENT_RUNTIME_PROVIDER_LABELS: Record<FreshAgentRuntimeProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
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

/** The saved per-type fresh-pane defaults the model resolver reads. */
export type FreshAgentPaneModelDefaultsSettings = {
  modelSelection?: { modelId?: string }
  modelEffortLevels?: { modelId: string; levels: string[] }
}

export type FreshAgentPaneModelDefaults = {
  /** The model a new or resumed pane starts on (undefined: provider default). */
  model: string | undefined
  /** Whether to stamp `model` into the pane content. An opencode pane with
   * nothing configured persists no model, so its provider default applies. */
  persistModel: boolean
  /** Claude only: the effort levels saved with `model` (captured when it was
   * picked), to stamp as the pane's `modelEffortLevels`. Absent when none were
   * saved for exactly this model. */
  modelEffortLevels?: string[]
}

function nonBlank(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * The one rule for the model a NEW or RESUMED fresh-agent pane starts on.
 * An existing pane keeps its own model; this only seeds pane content.
 *
 * - claude (freshclaude, kilroy): the saved fresh-pane default for the type,
 *   then the registry default. The terminal Claude CLI model is deliberately
 *   NOT consulted (decision D1): fresh panes have their own saved default.
 * - codex, opencode: the saved fresh-pane default, then the runtime CLI model
 *   (`codingCli.providers[runtime].model`), then the registry default.
 *
 * `runtimeProviderModel` is only supplied where the CLI model applies (the
 * picker); resume content omits it.
 */
export function resolveFreshAgentPaneModelDefaults(args: {
  entry: FreshAgentRegistryEntry
  providerSettings?: FreshAgentPaneModelDefaultsSettings
  runtimeProviderModel?: string
}): FreshAgentPaneModelDefaults {
  const { entry } = args
  const saved = nonBlank(args.providerSettings?.modelSelection?.modelId)
  const runtimeProviderModel = entry.runtimeProvider === 'claude'
    ? undefined
    : nonBlank(args.runtimeProviderModel)
  const configured = saved ?? runtimeProviderModel ?? entry.defaultModel
  const model = normalizeFreshAgentModel(entry.sessionType, entry.runtimeProvider, configured) ?? configured
  const persistModel = entry.runtimeProvider !== 'opencode'
    || saved !== undefined
    || runtimeProviderModel !== undefined
  // Levels are saved paired with their model: a mismatched pair (levels for
  // another model) is stale and ignored.
  const savedLevels = args.providerSettings?.modelEffortLevels
  const modelEffortLevels = entry.runtimeProvider === 'claude'
    && model !== undefined
    && savedLevels?.modelId === model
    && Array.isArray(savedLevels.levels)
    ? [...savedLevels.levels]
    : undefined
  return { model, persistModel, ...(modelEffortLevels ? { modelEffortLevels } : {}) }
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
 * Probed-only claude models clamp effort against the levels stamped when the
 * model was picked: the staged value survives when the stamp knows it, an
 * unknown staged value re-clamps to the stamp's first level, and an empty
 * stamp (the model declared no levels) clears the effort.
 */
export function clampEffortToStampedLevels(levels: readonly string[], staged: string | undefined): string | undefined {
  if (staged && levels.includes(staged)) return staged
  return levels.length > 0 ? levels[0] : undefined
}

/** Whether stamped levels govern this model's effort: claude, a stamp, and a
 * model absent from the static menu (static rows keep the static table). */
function usesStampedEffortLevels(
  sessionType: FreshAgentSessionType,
  provider: FreshAgentRuntimeProvider,
  model: string | undefined,
  levels: readonly string[] | undefined,
): levels is readonly string[] {
  return provider === 'claude'
    && Boolean(model)
    && Array.isArray(levels)
    && !(FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE[sessionType] ?? [])
      .some((option) => option.value === model)
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
  if (usesStampedEffortLevels(content.sessionType, content.provider, resolvedModel, content.modelEffortLevels)) {
    return clampEffortToStampedLevels(content.modelEffortLevels, content.effort ?? providerDefaults?.effort)
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
  /** Claude: the levels saved with a probed-only model (see
   * resolveFreshAgentPaneModelDefaults); effort clamps against them. */
  modelEffortLevels?: readonly string[]
}): string | undefined {
  const { sessionType, provider, model, providerEffort, fallbackEffort, modelEffortLevels } = args
  if (usesStampedEffortLevels(sessionType, provider, model, modelEffortLevels)) {
    return clampEffortToStampedLevels(modelEffortLevels, providerEffort ?? fallbackEffort)
  }
  if (provider === 'opencode') {
    return normalizeFreshAgentEffort(sessionType, provider, model, providerEffort)
  }
  return normalizeFreshAgentEffort(sessionType, provider, model, providerEffort ?? fallbackEffort)
    ?? fallbackEffort
}
