import { Terminal, Globe, FileText, LayoutGrid } from 'lucide-react'
import { ProviderIcon } from '@/components/icons/provider-icons'
import { isCodingCliMode } from '@/lib/coding-cli-utils'
import { getAgentChatProviderConfig } from '@/lib/agent-chat-utils'
import type { PaneContent } from '@/store/paneTypes'

interface PaneIconProps {
  content: PaneContent
  className?: string
}

export default function PaneIcon({ content, className }: PaneIconProps) {
  if (content.kind === 'terminal') {
    if (isCodingCliMode(content.mode)) {
      return <ProviderIcon provider={content.mode} className={className} />
    }
    return <Terminal className={className} />
  }

  if (content.kind === 'browser') {
    return <Globe className={className} />
  }

  if (content.kind === 'editor') {
    return <FileText className={className} />
  }

  if (content.kind === 'agent-chat') {
    const config = getAgentChatProviderConfig(content.provider)
    if (config) {
      const Icon = config.icon
      return <Icon className={className} />
    }
    return <LayoutGrid className={className} />
  }

  if (content.kind === 'extension') {
    // V1: LayoutGrid fallback. Future: load SVG from iconUrl
    return <LayoutGrid className={className} />
  }

  // Picker
  return <LayoutGrid className={className} />
}
