import { useEffect, useLayoutEffect, useRef } from 'react'
import { PaneLayout } from './panes'
import SessionView from './SessionView'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import { useAppSelector } from '@/store/hooks'
import type { PaneContentInput } from '@/store/paneTypes'
import { getInstalledPerfAuditBridge } from '@/lib/perf-audit-bridge'
import { buildResumeContent } from '@/lib/session-type-utils'
import { getTabResumeSessionType } from '@/lib/session-metadata'
import { addTerminalRestoreRequestId } from '@/lib/terminal-restore'
import { getAgentChatProviderConfig } from '@/lib/agent-chat-utils'

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

  const resumeSessionType = tab ? getTabResumeSessionType(tab) : undefined
  const isNoLayoutPtyCodingRestore = !layout
    && tab?.mode !== 'shell'
    && !tab?.codingCliSessionId
    && !getAgentChatProviderConfig(resumeSessionType || '')

  useLayoutEffect(() => {
    if (!isNoLayoutPtyCodingRestore || !tab) return
    addTerminalRestoreRequestId(tab.createRequestId)
  }, [isNoLayoutPtyCodingRestore, tab?.createRequestId])

  if (!tab) return null

  // For coding CLI session views with no terminal, use SessionView
  if (tab.codingCliSessionId && !tab.terminalId) {
    return <SessionView sessionId={tab.codingCliSessionId} hidden={hidden} />
  }

  // Build default content based on setting
  let defaultContent: PaneContentInput

  if (tab.terminalId && !isNoLayoutPtyCodingRestore) {
    defaultContent = {
      kind: 'terminal',
      mode: tab.mode,
      shell: tab.shell,
      ...(isNoLayoutPtyCodingRestore ? { createRequestId: tab.createRequestId } : {}),
      resumeSessionId: tab.resumeSessionId,
      initialCwd: tab.initialCwd,
      terminalId: tab.terminalId,
    }
  } else if (isNoLayoutPtyCodingRestore) {
    defaultContent = {
      kind: 'terminal',
      mode: tab.mode,
      shell: tab.shell,
      createRequestId: tab.createRequestId,
      status: 'creating',
      resumeSessionId: tab.resumeSessionId,
      initialCwd: tab.initialCwd,
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
        <PaneLayout tabId={tabId} defaultContent={defaultContent} hidden={hidden} />
      </ErrorBoundary>
    </div>
  )
}
