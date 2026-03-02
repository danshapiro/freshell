import type { AgentChatProviderName, AgentChatProviderConfig } from './agent-chat-types'
import { FreshclaudeIcon, KilroyIcon } from '@/components/icons/provider-icons'

export type { AgentChatProviderName, AgentChatProviderConfig }

export const AGENT_CHAT_PROVIDERS: AgentChatProviderName[] = [
  'freshclaude',
  'kilroy',
]

export const AGENT_CHAT_PROVIDER_CONFIGS: AgentChatProviderConfig[] = [
  {
    name: 'freshclaude',
    label: 'Freshclaude',
    codingCliProvider: 'claude',
    icon: FreshclaudeIcon,
    defaultModel: 'claude-opus-4-6',
    defaultPermissionMode: 'bypassPermissions',
    defaultEffort: 'high',
    defaultShowThinking: true,
    defaultShowTools: true,
    defaultShowTimecodes: false,
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
    name: 'kilroy',
    label: 'Kilroy',
    codingCliProvider: 'claude',
    icon: KilroyIcon,
    defaultModel: 'claude-opus-4-6',
    defaultPermissionMode: 'bypassPermissions',
    defaultEffort: 'high',
    defaultShowThinking: true,
    defaultShowTools: true,
    defaultShowTimecodes: false,
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
]

export function isAgentChatProviderName(value?: string): value is AgentChatProviderName {
  if (!value) return false
  return AGENT_CHAT_PROVIDERS.includes(value as AgentChatProviderName)
}

export function getAgentChatProviderConfig(name?: string): AgentChatProviderConfig | undefined {
  if (!name) return undefined
  return AGENT_CHAT_PROVIDER_CONFIGS.find((c) => c.name === name)
}

export function getAgentChatProviderLabel(name?: string): string {
  const config = getAgentChatProviderConfig(name)
  return config?.label ?? 'Agent Chat'
}

/** Returns provider configs visible in the pane picker, filtering out hidden providers unless their feature flag is enabled. */
export function getVisibleAgentChatConfigs(featureFlags: Record<string, boolean>): AgentChatProviderConfig[] {
  return AGENT_CHAT_PROVIDER_CONFIGS.filter((config) => {
    if (!config.hidden) return true
    const flag = config.featureFlag ?? config.name
    return featureFlags[flag] === true
  })
}
