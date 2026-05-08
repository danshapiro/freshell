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

export const FRESH_AGENT_REGISTRY: readonly FreshAgentRegistryEntry[] = [
  {
    sessionType: 'freshclaude',
    runtimeProvider: 'claude',
    label: 'Freshclaude',
    icon: FreshclaudeIcon,
    defaultModel: 'claude-opus-4-6',
    defaultPermissionMode: 'bypassPermissions',
    defaultEffort: 'high',
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
    defaultModel: 'gpt-5-codex',
    defaultPermissionMode: 'on-request',
    defaultEffort: 'high',
    settingsVisibility: {
      model: true,
      permissionMode: true,
      effort: true,
      thinking: false,
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
    defaultEffort: 'high',
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
    defaultEffort: 'high',
    settingsVisibility: {
      model: true,
      permissionMode: true,
      effort: true,
      thinking: false,
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
