import { ChevronLeft, ChevronRight, PanelLeft, Plus } from 'lucide-react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { addTab, switchToNextTab, switchToPrevTab } from '@/store/tabsSlice'
import { getTabDisplayTitle } from '@/lib/tab-title'
import { getBusyPaneIdsForTab } from '@/lib/pane-activity'
import { triggerHapticFeedback } from '@/lib/mobile-haptics'
import type { ChatSessionState } from '@/store/agentChatTypes'
import type { PaneRuntimeActivityRecord } from '@/store/paneRuntimeActivitySlice'

const EMPTY_CODEX_ACTIVITY_BY_ID = {}
const EMPTY_AGENT_CHAT_SESSIONS: Record<string, ChatSessionState> = {}
const EMPTY_PANE_RUNTIME_ACTIVITY_BY_ID: Record<string, PaneRuntimeActivityRecord> = {}

interface MobileTabStripProps {
  onOpenSwitcher?: () => void
  sidebarCollapsed?: boolean
  onToggleSidebar?: () => void
}

export function MobileTabStrip({ onOpenSwitcher, sidebarCollapsed, onToggleSidebar }: MobileTabStripProps) {
  const dispatch = useAppDispatch()
  const tabs = useAppSelector((s) => s.tabs.tabs)
  const activeTabId = useAppSelector((s) => s.tabs.activeTabId)
  const paneLayouts = useAppSelector((s) => s.panes.layouts)
  const paneTitles = useAppSelector((s) => s.panes.paneTitles)
  const codexActivityByTerminalId = useAppSelector((s) => s.codexActivity?.byTerminalId ?? EMPTY_CODEX_ACTIVITY_BY_ID)
  const agentChatSessions = useAppSelector((s) => s.agentChat?.sessions ?? EMPTY_AGENT_CHAT_SESSIONS)
  const paneRuntimeActivityByPaneId = useAppSelector(
    (s) => s.paneRuntimeActivity?.byPaneId ?? EMPTY_PANE_RUNTIME_ACTIVITY_BY_ID
  )
  const extensions = useAppSelector((s) => s.extensions?.entries)

  const activeIndex = tabs.findIndex((t) => t.id === activeTabId)
  const activeTab = activeIndex >= 0 ? tabs[activeIndex] : null

  const displayTitle = activeTab
    ? getTabDisplayTitle(activeTab, paneLayouts[activeTab.id], paneTitles?.[activeTab.id], extensions)
    : ''
  const isActiveBusy = activeTab
    ? getBusyPaneIdsForTab({
      tab: activeTab,
      paneLayouts,
      codexActivityByTerminalId,
      paneRuntimeActivityByPaneId,
      agentChatSessions,
    }).length > 0
    : false

  const isFirst = activeIndex <= 0
  const isLast = activeIndex >= tabs.length - 1

  const handleRightAction = () => {
    triggerHapticFeedback()
    if (isLast) {
      dispatch(addTab({ mode: 'shell' }))
      return
    }
    dispatch(switchToNextTab())
  }

  return (
    <div className="relative z-20 h-12 shrink-0 flex items-center px-2 bg-background border-b border-border/30">
      {sidebarCollapsed && onToggleSidebar && (
        <button
          className="min-h-11 min-w-11 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
          onClick={() => { triggerHapticFeedback(); onToggleSidebar() }}
          title="Show sidebar"
          aria-label="Show sidebar"
        >
          <PanelLeft className="h-5 w-5" />
        </button>
      )}
      <button
        className="min-h-11 min-w-11 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground disabled:opacity-30"
        onClick={() => { triggerHapticFeedback(); dispatch(switchToPrevTab()) }}
        disabled={isFirst}
        aria-label="Previous tab"
      >
        <ChevronLeft className="h-5 w-5" />
      </button>

      <button
        className="flex-1 flex items-center justify-center gap-2 min-h-11 rounded-md"
        onClick={() => { triggerHapticFeedback(); onOpenSwitcher?.() }}
        aria-label="Open tab switcher"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-medium truncate max-w-[160px]">
            {displayTitle || 'Untitled'}
          </span>
          {isActiveBusy && (
            <span
              className="inline-flex shrink-0 items-center rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400"
              data-testid="mobile-tab-busy-badge"
            >
              Busy
            </span>
          )}
        </span>
        <span className="text-xs text-muted-foreground">
          {activeIndex + 1} / {tabs.length}
        </span>
      </button>

      <button
        className="min-h-11 min-w-11 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
        onClick={handleRightAction}
        aria-label={isLast ? 'New tab' : 'Next tab'}
      >
        {isLast ? <Plus className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
      </button>
    </div>
  )
}
