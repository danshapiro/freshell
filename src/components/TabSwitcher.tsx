import { Plus, X } from 'lucide-react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { addTab, setActiveTab } from '@/store/tabsSlice'
import { getTabDisplayTitle } from '@/lib/tab-title'
import { useCallback, useMemo } from 'react'
import type { Tab, TerminalStatus } from '@/store/types'
import { triggerHapticFeedback } from '@/lib/mobile-haptics'

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

  const getDisplayTitle = useCallback(
    (tab: Tab): string => getTabDisplayTitle(tab, paneLayouts[tab.id]),
    [paneLayouts]
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
                <span className="text-sm font-medium truncate w-full">
                  {title}
                </span>
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
