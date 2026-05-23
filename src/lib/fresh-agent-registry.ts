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

export type FreshAgentRegistryEntry = {
  sessionType: FreshAgentSessionType
  runtimeProvider: FreshAgentRuntimeProvider
  label: string
  icon: React.ComponentType<{ className?: string }>
  defaultModel: string
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

export const FRESHCODEX_DEFAULT_MODEL = 'gpt-5.5'
export const FRESHCODEX_DEFAULT_EFFORT = 'xhigh'
export const FRESHCODEX_MODEL_OPTIONS = [
  { value: 'gpt-5.5', label: 'GPT-5.5' },
  { value: 'gpt-5.4-flash', label: 'GPT-5.4 Flash' },
  { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
] as const
export const FRESH_AGENT_THINKING_OPTIONS_BY_PROVIDER = {
  claude: [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'max', label: 'Maximum' },
  ],
  codex: [
    { value: 'none', label: 'None' },
    { value: 'minimal', label: 'Minimal' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Maximum' },
  ],
  opencode: [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'max', label: 'Maximum' },
  ],
} as const

export function normalizeFreshcodexModel(model: string | undefined): string {
  if (model && FRESHCODEX_MODEL_OPTIONS.some((option) => option.value === model)) {
    return model
  }
  return FRESHCODEX_DEFAULT_MODEL
}

export function normalizeFreshAgentEffort(provider: FreshAgentRuntimeProvider, effort: string | undefined): string | undefined {
  const options = FRESH_AGENT_THINKING_OPTIONS_BY_PROVIDER[provider] ?? []
  if (effort && options.some((option) => option.value === effort)) {
    return effort
  }
  if (provider === 'codex') return FRESHCODEX_DEFAULT_EFFORT
  if (provider === 'claude') return 'max'
  if (provider === 'opencode') return 'max'
  return undefined
}

export const FRESH_AGENT_REGISTRY: readonly FreshAgentRegistryEntry[] = [
  {
    sessionType: 'freshclaude',
    runtimeProvider: 'claude',
    label: 'Freshclaude',
    icon: FreshclaudeIcon,
    defaultModel: 'claude-opus-4-6',
    defaultPermissionMode: 'bypassPermissions',
    defaultEffort: 'max',
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
    defaultModel: 'claude-opus-4-6',
    defaultPermissionMode: 'bypassPermissions',
    defaultEffort: 'max',
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
    defaultModel: 'opencode',
    defaultPermissionMode: 'bypassPermissions',
    defaultEffort: 'max',
    settingsVisibility: {
      model: true,
      permissionMode: true,
      effort: true,
      thinking: true,
      tools: true,
      timecodes: true,
    },
    pickerShortcut: 'O',
    pickerAfterCli: true,
    disabled: true,
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
