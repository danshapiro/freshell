import type { AgentChatProviderName, AgentChatProviderConfig } from './agent-chat-types'
import { resolveFreshAgentType } from '@/lib/fresh-agent-registry'

export type { AgentChatProviderName, AgentChatProviderConfig }

export const AGENT_CHAT_PROVIDERS: AgentChatProviderName[] = [
  'freshclaude',
  'kilroy',
]

export const AGENT_CHAT_PROVIDER_CONFIGS: AgentChatProviderConfig[] = [
  {
    name: 'freshclaude',
    ...(() => {
      const entry = resolveFreshAgentType('freshclaude')
      if (!entry) {
        throw new Error('Missing fresh-agent registry entry for freshclaude')
      }
      return {
        label: entry.label,
        codingCliProvider: entry.runtimeProvider,
        icon: entry.icon,
        providerDefaultModelId: 'opus',
        defaultPermissionMode: entry.defaultPermissionMode,
        settingsVisibility: entry.settingsVisibility,
        pickerShortcut: entry.pickerShortcut,
      }
    })(),
  },
  {
    name: 'kilroy',
    ...(() => {
      const entry = resolveFreshAgentType('kilroy')
      if (!entry) {
        throw new Error('Missing fresh-agent registry entry for kilroy')
      }
      return {
        label: entry.label,
        codingCliProvider: entry.runtimeProvider,
        icon: entry.icon,
        providerDefaultModelId: 'opus',
        defaultPermissionMode: entry.defaultPermissionMode,
        settingsVisibility: entry.settingsVisibility,
        pickerShortcut: entry.pickerShortcut,
        pickerAfterCli: entry.pickerAfterCli,
        hidden: entry.hidden,
        featureFlag: entry.featureFlag,
      }
    })(),
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
