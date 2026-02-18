import { Terminal, Globe, FileText, LayoutGrid } from 'lucide-react'
import { ProviderIcon, FreshclaudeIcon } from '@/components/icons/provider-icons'
import { isCodingCliMode } from '@/lib/coding-cli-utils'
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

  if (content.kind === 'claude-chat') {
    return <FreshclaudeIcon className={className} />
  }

  // Picker
  return <LayoutGrid className={className} />
}
