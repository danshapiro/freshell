import { PaneLayout } from './panes'
import SessionView from './SessionView'
import { useAppSelector } from '@/store/hooks'
import type { PaneContentInput } from '@/store/paneTypes'
import { ErrorBoundary } from '@/components/ui/error-boundary'

interface TabContentProps {
  tabId: string
  hidden?: boolean
}

export default function TabContent({ tabId, hidden }: TabContentProps) {
  const tab = useAppSelector((s) => s.tabs.tabs.find((t) => t.id === tabId))
  const defaultNewPane = useAppSelector((s) => s.settings.settings.panes?.defaultNewPane || 'ask')

  if (!tab) return null

  // For coding CLI session views with no terminal, use SessionView
  if (tab.codingCliSessionId && !tab.terminalId) {
    return <SessionView sessionId={tab.codingCliSessionId} hidden={hidden} />
  }

  // Build default content based on setting
  let defaultContent: PaneContentInput

  // If tab already has a terminalId (e.g., restored from persistence), use that
  // Or if the tab is claude/codex mode, or has a resumeSessionId, force terminal
  const forceTerminal = tab.terminalId || tab.mode !== 'shell' || tab.resumeSessionId

  if (forceTerminal) {
    defaultContent = {
      kind: 'terminal',
      mode: tab.mode,
      shell: tab.shell,
      resumeSessionId: tab.resumeSessionId,
      initialCwd: tab.initialCwd,
      terminalId: tab.terminalId,
    }
  } else if (defaultNewPane === 'ask') {
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
    // 'shell' or default
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
    <div className={hidden ? 'tab-hidden' : 'tab-visible h-full w-full'}>
      <ErrorBoundary key={tabId} label="Tab">
        <PaneLayout tabId={tabId} defaultContent={defaultContent} hidden={hidden} />
      </ErrorBoundary>
    </div>
  )
}
