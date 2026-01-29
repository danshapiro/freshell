import { PaneLayout } from './panes'
import ClaudeSessionView from './ClaudeSessionView'
import { useAppSelector } from '@/store/hooks'
import type { PaneContent } from '@/store/paneTypes'

interface TabContentProps {
  tabId: string
  hidden?: boolean
}

export default function TabContent({ tabId, hidden }: TabContentProps) {
  const tab = useAppSelector((s) => s.tabs.tabs.find((t) => t.id === tabId))

  if (!tab) return null

  // For claude mode with existing claudeSessionId and no terminal, use ClaudeSessionView
  // This is for viewing historical sessions, not live terminals
  if (tab.mode === 'claude' && tab.claudeSessionId && !tab.terminalId) {
    return <ClaudeSessionView sessionId={tab.claudeSessionId} hidden={hidden} />
  }

  // Build default content based on tab
  const defaultContent: PaneContent = {
    kind: 'terminal',
    mode: tab.mode,
    resumeSessionId: tab.resumeSessionId,
    initialCwd: tab.initialCwd,
  }

  // Use PaneLayout for all terminal-based tabs
  return (
    <div className={hidden ? 'hidden' : 'h-full w-full'}>
      <PaneLayout tabId={tabId} defaultContent={defaultContent} />
    </div>
  )
}
