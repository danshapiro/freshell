import type { PaneContent } from '@/store/paneTypes'
import { getProviderLabel, isNonShellMode } from '@/lib/coding-cli-utils'
import { getAgentChatProviderLabel } from '@/lib/agent-chat-utils'
import { getFreshAgentLabel } from '@/lib/fresh-agent-registry'
import { basenameSegment } from '@shared/path-basename'
import type { ClientExtensionEntry } from '@shared/extension-types'

/**
 * Derives a default title for a pane based on its content.
 * For terminals: based on mode and shell type.
 * For browsers: based on URL hostname.
 */
export function derivePaneTitle(content: PaneContent, extensions?: ClientExtensionEntry[]): string {
  if (content.kind === 'picker') {
    return 'New Tab'
  }

  if (content.kind === 'editor') {
    if (!content.filePath) return 'Editor'
    const parts = content.filePath.replace(/\\/g, '/').split('/')
    return parts[parts.length - 1] || 'Editor'
  }

  if (content.kind === 'agent-chat') {
    const segment = content.initialCwd ? basenameSegment(content.initialCwd) : null
    return segment ?? getAgentChatProviderLabel(content.provider)
  }

  if (content.kind === 'fresh-agent') {
    const segment = content.initialCwd ? basenameSegment(content.initialCwd) : null
    return segment ?? getFreshAgentLabel(content.sessionType)
  }

  if (content.kind === 'browser') {
    if (!content.url) return 'Browser'
    try {
      const url = new URL(content.url)
      return url.hostname || 'Browser'
    } catch {
      return 'Browser'
    }
  }

  if (content.kind === 'extension') {
    return content.extensionName
  }

  // Terminal content — coding-agent (non-shell) terminals name by working directory
  if (isNonShellMode(content.mode)) {
    const segment = content.initialCwd ? basenameSegment(content.initialCwd) : null
    return segment ?? getProviderLabel(content.mode, extensions)
  }

  // Shell mode - use shell type if specified
  if (content.shell) {
    switch (content.shell) {
      case 'powershell':
        return 'PowerShell'
      case 'cmd':
        return 'Command Prompt'
      case 'wsl':
        return 'WSL'
      case 'system':
      default:
        return 'Shell'
    }
  }

  return 'Shell'
}
