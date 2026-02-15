import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { addTab, switchToNextTab, switchToPrevTab } from '@/store/tabsSlice'
import { getTabDisplayTitle } from '@/lib/tab-title'
import { triggerHapticFeedback } from '@/lib/mobile-haptics'

export function MobileTabStrip({ onOpenSwitcher }: { onOpenSwitcher?: () => void }) {
  const dispatch = useAppDispatch()
  const tabs = useAppSelector((s) => s.tabs.tabs)
  const activeTabId = useAppSelector((s) => s.tabs.activeTabId)
  const paneLayouts = useAppSelector((s) => s.panes.layouts)

  const activeIndex = tabs.findIndex((t) => t.id === activeTabId)
  const activeTab = activeIndex >= 0 ? tabs[activeIndex] : null

  const displayTitle = activeTab
    ? getTabDisplayTitle(activeTab, paneLayouts[activeTab.id])
    : ''

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
    <div className="relative z-20 h-12 flex items-center px-2 bg-background border-b border-border/30">
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
        <span className="text-sm font-medium truncate max-w-[200px]">
          {displayTitle || 'Untitled'}
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
