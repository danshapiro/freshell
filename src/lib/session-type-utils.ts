import type { ComponentType } from 'react'
import { PROVIDER_ICONS, DefaultProviderIcon } from '@/components/icons/provider-icons'
import { CODING_CLI_PROVIDER_LABELS, isCodingCliMode } from '@/lib/coding-cli-utils'
import { getAgentChatProviderConfig } from '@/lib/agent-chat-utils'

export interface SessionTypeConfig {
  icon: ComponentType<{ className?: string }>
  label: string
}

export function resolveSessionTypeConfig(sessionType: string): SessionTypeConfig {
  // 1. Check coding CLI providers
  if (isCodingCliMode(sessionType)) {
    return {
      icon: PROVIDER_ICONS[sessionType as keyof typeof PROVIDER_ICONS] ?? DefaultProviderIcon,
      label: CODING_CLI_PROVIDER_LABELS[sessionType as keyof typeof CODING_CLI_PROVIDER_LABELS] ?? sessionType,
    }
  }

  // 2. Check agent-chat providers
  const agentConfig = getAgentChatProviderConfig(sessionType)
  if (agentConfig) {
    return {
      icon: agentConfig.icon,
      label: agentConfig.label,
    }
  }

  // 3. Fallback for unknown types
  return {
    icon: DefaultProviderIcon,
    label: sessionType,
  }
}
