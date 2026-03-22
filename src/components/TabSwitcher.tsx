import { Plus, X } from 'lucide-react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { addTab, setActiveTab } from '@/store/tabsSlice'
import { getTabDisplayTitle } from '@/lib/tab-title'
import { getBusyPaneIdsForTab } from '@/lib/pane-activity'
import { useCallback, useMemo } from 'react'
import type { Tab, TerminalStatus } from '@/store/types'
import { triggerHapticFeedback } from '@/lib/mobile-haptics'
import type { ChatSessionState } from '@/store/agentChatTypes'
import type { PaneRuntimeActivityRecord } from '@/store/paneRuntimeActivitySlice'

const EMPTY_CODEX_ACTIVITY_BY_ID = {}
const EMPTY_AGENT_CHAT_SESSIONS: Record<string, ChatSessionState> = {}
const EMPTY_PANE_RUNTIME_ACTIVITY_BY_ID: Record<string, PaneRuntimeActivityRecord> = {}
const EMPTY_PANE_TITLE_SOURCES: Record<string, Record<string, 'derived' | 'stable' | 'user'>> = {}
const EMPTY_PANE_RUNTIME_TITLES: Record<string, string> = {}

interface TabSwitcherProps {
  onClose: () => void
}

function statusLabel(status: TerminalStatus): string {
  switch (status) {
    case 'running':
      return 'Running'
    case 'exited':
      return 'Exited'
    case 'creating':
      return 'Creating...'
    case 'error':
      return 'Error'
    default:
      return ''
  }
}

export function TabSwitcher({ onClose }: TabSwitcherProps) {
  const dispatch = useAppDispatch()
  const tabs = useAppSelector((s) => s.tabs.tabs) as Tab[]
  const activeTabId = useAppSelector((s) => s.tabs.activeTabId)
  const paneLayouts = useAppSelector((s) => s.panes.layouts)
  const paneTitles = useAppSelector((s) => s.panes.paneTitles)
  const paneTitleSources = useAppSelector((s) => s.panes.paneTitleSources ?? EMPTY_PANE_TITLE_SOURCES)
  const paneRuntimeTitles = useAppSelector((s) => s.paneRuntimeTitle?.titlesByPaneId ?? EMPTY_PANE_RUNTIME_TITLES)
  const codexActivityByTerminalId = useAppSelector((s) => s.codexActivity?.byTerminalId ?? EMPTY_CODEX_ACTIVITY_BY_ID)
  const agentChatSessions = useAppSelector((s) => s.agentChat?.sessions ?? EMPTY_AGENT_CHAT_SESSIONS)
  const paneRuntimeActivityByPaneId = useAppSelector(
    (s) => s.paneRuntimeActivity?.byPaneId ?? EMPTY_PANE_RUNTIME_ACTIVITY_BY_ID
  )
  const extensions = useAppSelector((s) => s.extensions?.entries)

  const getDisplayTitle = useCallback(
    (tab: Tab): string => getTabDisplayTitle(
      tab,
      paneLayouts[tab.id],
      paneTitles?.[tab.id],
      paneTitleSources?.[tab.id],
      paneRuntimeTitles,
      extensions,
    ),
    [paneLayouts, paneRuntimeTitles, paneTitleSources, paneTitles, extensions]
  )

  const handleCardClick = useCallback(
    (tabId: string) => {
      triggerHapticFeedback()
      dispatch(setActiveTab(tabId))
      onClose()
    },
    [dispatch, onClose]
  )

  const handleNewTab = useCallback(() => {
    triggerHapticFeedback()
    dispatch(addTab({ mode: 'shell' }))
    onClose()
  }, [dispatch, onClose])

  const tabCount = tabs.length
  const tabCountLabel = useMemo(
    () => `${tabCount} ${tabCount === 1 ? 'Tab' : 'Tabs'}`,
    [tabCount]
  )

  return (
    <div className="fixed inset-0 z-50 bg-background/95 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
        <h2 className="text-sm font-medium text-foreground">{tabCountLabel}</h2>
        <button
          className="min-h-11 min-w-11 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
          onClick={onClose}
          aria-label="Close tab switcher"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Tab grid */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-2 gap-3">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId
            const title = getDisplayTitle(tab)
            const isBusy = getBusyPaneIdsForTab({
              tab,
              paneLayouts,
              codexActivityByTerminalId,
              paneRuntimeActivityByPaneId,
              agentChatSessions,
            }).length > 0
            return (
              <button
                key={tab.id}
                className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors ${
                  isActive
                    ? 'ring-2 ring-primary border-primary bg-primary/5'
                    : 'border-border bg-card hover:bg-accent/50'
                }`}
                onClick={() => handleCardClick(tab.id)}
                aria-label={`Switch to ${title}`}
              >
                <div className="flex w-full items-start justify-between gap-2">
                  <span className="text-sm font-medium truncate flex-1">
                    {title}
                  </span>
                  {isBusy && (
                    <span
                      className="inline-flex shrink-0 items-center rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400"
                      data-testid={`tab-switcher-busy-badge-${tab.id}`}
                    >
                      Busy
                    </span>
                  )}
                </div>
                <span
                  className={`text-xs ${
                    tab.status === 'exited' || tab.status === 'error'
                      ? 'text-destructive'
                      : 'text-muted-foreground'
                  }`}
                >
                  {statusLabel(tab.status)}
                </span>
              </button>
            )
          })}

          {/* New Tab card */}
          <button
            className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-muted-foreground/40 p-3 text-muted-foreground hover:text-foreground hover:border-foreground/50 hover:bg-muted/30 transition-colors"
            onClick={handleNewTab}
            aria-label="New tab"
          >
            <Plus className="h-5 w-5" />
            <span className="text-xs">New Tab</span>
          </button>
        </div>
      </div>
    </div>
  )
}
