import type { ComponentType } from 'react'
import { PROVIDER_ICONS, DefaultProviderIcon } from '@/components/icons/provider-icons'
import { CODING_CLI_PROVIDER_LABELS, isCodingCliMode } from '@/lib/coding-cli-utils'
import { getAgentChatProviderConfig } from '@/lib/agent-chat-utils'
import type { AgentChatProviderName } from '@/lib/agent-chat-types'
import type { CodingCliProviderName } from '@/store/types'
import type { PaneContentInput } from '@/store/paneTypes'

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

/**
 * Build the correct PaneContentInput for resuming a session based on its sessionType.
 * Agent-chat sessions (freshclaude, kilroy) → kind: 'agent-chat'
 * Terminal sessions (claude, codex) → kind: 'terminal'
 */
export function buildResumeContent(opts: {
  sessionType: string
  sessionId: string
  cwd?: string
  terminalId?: string
  agentChatProviderSettings?: {
    defaultModel?: string
    defaultPermissionMode?: string
    defaultEffort?: 'low' | 'medium' | 'high' | 'max'
  }
}): PaneContentInput {
  const agentConfig = getAgentChatProviderConfig(opts.sessionType)
  if (agentConfig) {
    const ps = opts.agentChatProviderSettings
    return {
      kind: 'agent-chat',
      provider: agentConfig.name as AgentChatProviderName,
      resumeSessionId: opts.sessionId,
      initialCwd: opts.cwd,
      model: ps?.defaultModel ?? agentConfig.defaultModel,
      permissionMode: ps?.defaultPermissionMode ?? agentConfig.defaultPermissionMode,
      effort: ps?.defaultEffort ?? agentConfig.defaultEffort,
    }
  }
  // Terminal pane (claude CLI, codex CLI, or fallback to 'claude')
  const provider: CodingCliProviderName = isCodingCliMode(opts.sessionType)
    ? opts.sessionType as CodingCliProviderName
    : 'claude'
  return {
    kind: 'terminal',
    mode: provider,
    resumeSessionId: opts.sessionId,
    initialCwd: opts.cwd,
    terminalId: opts.terminalId,
    status: opts.terminalId ? 'running' as const : 'creating' as const,
  }
}
