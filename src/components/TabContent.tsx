import { useEffect, useRef } from 'react'
import { PaneLayout } from './panes'
import MissingLayoutError from './panes/MissingLayoutError'
import SessionView from './SessionView'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import { useAppSelector } from '@/store/hooks'
import type { PaneContentInput } from '@/store/paneTypes'
import { getInstalledPerfAuditBridge } from '@/lib/perf-audit-bridge'
import { buildResumeContent } from '@/lib/session-type-utils'
import { getTabResumeSessionType } from '@/lib/session-metadata'
import { getAgentChatProviderConfig } from '@/lib/agent-chat-utils'
import { detectMissingLayoutCorruption } from '@/lib/tab-layout-integrity'

interface TabContentProps {
  tabId: string
  hidden?: boolean
}

export default function TabContent({ tabId, hidden }: TabContentProps) {
  const tab = useAppSelector((s) => s.tabs.tabs.find((t) => t.id === tabId))
  const layout = useAppSelector((s) => s.panes.layouts[tabId])
  const defaultNewPane = useAppSelector((s) => s.settings.settings.panes?.defaultNewPane || 'ask')
  const previousHiddenRef = useRef(hidden)

  useEffect(() => {
    const wasHidden = previousHiddenRef.current
    previousHiddenRef.current = hidden
    if (!wasHidden || hidden) return
    getInstalledPerfAuditBridge()?.mark('tab.selected_surface_visible', { tabId })
  }, [hidden, tabId])

  if (!tab) return null

  const missingLayoutCorruption = detectMissingLayoutCorruption({ tab, layout })
  const resumeSessionType = tab ? getTabResumeSessionType(tab) : undefined

  // For coding CLI session views with no terminal, use SessionView
  if (tab.codingCliSessionId && !tab.terminalId) {
    return <SessionView sessionId={tab.codingCliSessionId} hidden={hidden} />
  }

  if (missingLayoutCorruption) {
    return (
      <div data-tab-content-id={tabId} className={hidden ? 'tab-hidden' : 'tab-visible h-full w-full'}>
        <ErrorBoundary key={tabId} label="Tab">
          <MissingLayoutError tabTitle={tab.title} />
        </ErrorBoundary>
      </div>
    )
  }

  // Build default content based on setting
  let defaultContent: PaneContentInput

  if (tab.terminalId) {
    defaultContent = {
      kind: 'terminal',
      mode: tab.mode,
      shell: tab.shell,
      resumeSessionId: tab.resumeSessionId,
      initialCwd: tab.initialCwd,
      terminalId: tab.terminalId,
    }
  } else if (tab.resumeSessionId && resumeSessionType) {
    defaultContent = buildResumeContent({
      sessionType: resumeSessionType,
      sessionId: tab.resumeSessionId,
      cwd: tab.initialCwd,
    })
  } else if (tab.mode !== 'shell') {
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
    <div data-tab-content-id={tabId} className={hidden ? 'tab-hidden' : 'tab-visible h-full w-full'}>
      <ErrorBoundary key={tabId} label="Tab">
        <PaneLayout tabId={tabId} defaultContent={defaultContent} hidden={hidden} allowAutoInit={false} />
      </ErrorBoundary>
    </div>
  )
}
