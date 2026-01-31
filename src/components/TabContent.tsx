import { PaneLayout } from './panes'
import ClaudeSessionView from './ClaudeSessionView'
import { useAppSelector } from '@/store/hooks'
import type { PaneContentInput } from '@/store/paneTypes'

interface TabContentProps {
  tabId: string
  hidden?: boolean
}

export default function TabContent({ tabId, hidden }: TabContentProps) {
  const tab = useAppSelector((s) => s.tabs.tabs.find((t) => t.id === tabId))
  const defaultNewPane = useAppSelector((s) => s.settings.settings.panes?.defaultNewPane || 'ask')

  if (!tab) return null

  // For claude mode with existing claudeSessionId and no terminal, use ClaudeSessionView
  // This is for viewing historical sessions, not live terminals
  if (tab.mode === 'claude' && tab.claudeSessionId && !tab.terminalId) {
    return <ClaudeSessionView sessionId={tab.claudeSessionId} hidden={hidden} />
  }

  // Build default content based on setting
  let defaultContent: PaneContentInput

  if (defaultNewPane === 'ask') {
    defaultContent = { kind: 'picker' }
  } else if (defaultNewPane === 'browser') {
    defaultContent = { kind: 'browser', url: '', devToolsOpen: false }
  } else if (defaultNewPane === 'editor') {
    defaultContent = {
      kind: 'editor',
      filePath: null,
      language: null,
      readOnly: false,
      content: '',
      viewMode: 'source',
    }
  } else {
    // 'shell' or default - use tab's mode/shell settings
    defaultContent = {
      kind: 'terminal',
      mode: tab.mode,
      shell: tab.shell,
      resumeSessionId: tab.resumeSessionId,
      initialCwd: tab.initialCwd,
      terminalId: tab.terminalId,
    }
  }

  // Use PaneLayout for all terminal-based tabs
  return (
    <div className={hidden ? 'hidden' : 'h-full w-full'}>
      <PaneLayout tabId={tabId} defaultContent={defaultContent} hidden={hidden} />
    </div>
  )
}
