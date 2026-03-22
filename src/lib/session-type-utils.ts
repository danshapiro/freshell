import type { ComponentType } from 'react'
import { PROVIDER_ICONS, DefaultProviderIcon } from '@/components/icons/provider-icons'
import { isNonShellMode, getProviderLabel } from '@/lib/coding-cli-utils'
import { getAgentChatProviderConfig } from '@/lib/agent-chat-utils'
import type { AgentChatProviderName } from '@/lib/agent-chat-types'
import type { CodingCliProviderName } from '@/store/types'
import type { AgentChatPaneInput, SessionLocator, TerminalPaneInput } from '@/store/paneTypes'
import type { ClientExtensionEntry } from '@shared/extension-types'

export interface SessionTypeConfig {
  icon: ComponentType<{ className?: string }>
  label: string
}

export function resolveSessionTypeConfig(sessionType: string, extensions?: ClientExtensionEntry[]): SessionTypeConfig {
  // 1. Check agent-chat providers first (they have explicit configs)
  const agentConfig = getAgentChatProviderConfig(sessionType)
  if (agentConfig) {
    return {
      icon: agentConfig.icon,
      label: agentConfig.label,
    }
  }

  // 2. Any non-shell mode is a coding CLI provider
  if (isNonShellMode(sessionType)) {
    return {
      icon: PROVIDER_ICONS[sessionType as keyof typeof PROVIDER_ICONS] ?? DefaultProviderIcon,
      label: getProviderLabel(sessionType, extensions),
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
  sessionRef?: SessionLocator
  agentChatProviderSettings?: {
    defaultModel?: string
    defaultPermissionMode?: string
    defaultEffort?: 'low' | 'medium' | 'high' | 'max'
  }
}): TerminalPaneInput | AgentChatPaneInput {
  const agentConfig = getAgentChatProviderConfig(opts.sessionType)
  if (agentConfig) {
    const ps = opts.agentChatProviderSettings
    return {
      kind: 'agent-chat',
      provider: agentConfig.name as AgentChatProviderName,
      resumeSessionId: opts.sessionId,
      ...(opts.sessionRef ? { sessionRef: opts.sessionRef } : {}),
      initialCwd: opts.cwd,
      model: ps?.defaultModel ?? agentConfig.defaultModel,
      permissionMode: ps?.defaultPermissionMode ?? agentConfig.defaultPermissionMode,
      effort: ps?.defaultEffort ?? agentConfig.defaultEffort,
    }
  }
  // Terminal pane (claude CLI, codex CLI, or fallback to 'claude')
  const provider: CodingCliProviderName = isNonShellMode(opts.sessionType)
    ? opts.sessionType as CodingCliProviderName
    : 'claude'
  return {
    kind: 'terminal',
    mode: provider,
    resumeSessionId: opts.sessionId,
    ...(opts.sessionRef ? { sessionRef: opts.sessionRef } : {}),
    initialCwd: opts.cwd,
    terminalId: opts.terminalId,
    status: opts.terminalId ? 'running' as const : 'creating' as const,
  }
}
