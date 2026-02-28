import type { AgentChatProviderName, AgentChatProviderConfig } from './agent-chat-types'
import { FreshclaudeIcon } from '@/components/icons/provider-icons'

export type { AgentChatProviderName, AgentChatProviderConfig }

export const AGENT_CHAT_PROVIDERS: AgentChatProviderName[] = [
  'freshclaude',
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
