import { ChevronLeft, ChevronRight, PanelLeft, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { addTab, closeTab, setActiveTab, reorderTabs, clearTabRenameRequest } from '@/store/tabsSlice'
import { dismissTabGreen } from '@/store/turnCompletionAttention'
import { getWsClient } from '@/lib/ws-client'
import { getTabDisplayTitle } from '@/lib/tab-title'
import { collectPaneEntries, collectTerminalIds } from '@/lib/pane-utils'
import { getBusyPaneIdsForTab } from '@/lib/pane-activity'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTabBarScroll } from '@/hooks/useTabBarScroll'
import TabItem from './TabItem'
import { useMobile } from '@/hooks/useMobile'
import { MobileTabStrip } from './MobileTabStrip'
import { TabSwitcher } from './TabSwitcher'
import {
  DndContext,
  closestCenter,
  rectIntersection,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  horizontalListSortingStrategy,
  rectSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS as DndCSS } from '@dnd-kit/utilities'
import type { Tab, TabAttentionStyle } from '@/store/types'
import type { PaneContent, PaneNode } from '@/store/paneTypes'
import type { FreshAgentSessionState } from '@/store/freshAgentTypes'
import type { PaneRuntimeActivityRecord } from '@/store/paneRuntimeActivitySlice'
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import { applyTabRename } from '@/store/titleSync'

function escapeSelector(id: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(id)
  }
  return id.replace(/(["\\])/g, '\\$1')
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))
}

interface SortableTabProps {
  tab: Tab
  displayTitle: string
  isActive: boolean
  needsAttention: boolean
  busy: boolean
  busyPaneIds: string[]
  isDragging: boolean
  isRenaming: boolean
  renameValue: string
  paneEntries?: Array<{ paneId: string; content: PaneContent }>
  iconsOnTabs?: boolean
  tabAttentionStyle?: TabAttentionStyle
  onRenameChange: (value: string) => void
  onRenameBlur: () => void
  onRenameKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  onClose: (e: React.MouseEvent<HTMLButtonElement>) => void
  onClick: () => void
  onDoubleClick: () => void
}

function SortableTab({
  tab,
  displayTitle,
  isActive,
  needsAttention,
  busy,
  busyPaneIds,
  isDragging,
  isRenaming,
  renameValue,
  paneEntries,
  iconsOnTabs,
  tabAttentionStyle,
  onRenameChange,
  onRenameBlur,
  onRenameKeyDown,
  onClose,
  onClick,
  onDoubleClick,
}: SortableTabProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: tab.id })

  const style = {
    transform: DndCSS.Transform.toString(transform),
    transition: transition || 'transform 150ms ease',
  }

  // Create tab with display title for rendering
  const tabWithDisplayTitle = useMemo(
    () => ({ ...tab, title: displayTitle }),
    [tab, displayTitle]
  )

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <TabItem
        tab={tabWithDisplayTitle}
        isActive={isActive}
        needsAttention={needsAttention}
        busy={busy}
        busyPaneIds={busyPaneIds}
        isDragging={isDragging}
        isRenaming={isRenaming}
        renameValue={renameValue}
        paneEntries={paneEntries}
        iconsOnTabs={iconsOnTabs}
        tabAttentionStyle={tabAttentionStyle}
        onRenameChange={onRenameChange}
        onRenameBlur={onRenameBlur}
        onRenameKeyDown={onRenameKeyDown}
        onClose={onClose}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
      />
    </div>
  )
}

// Stable empty object to avoid creating new references
const EMPTY_LAYOUTS: Record<string, never> = {}
const EMPTY_PANE_TITLES: Record<string, Record<string, string>> = {}
const EMPTY_ATTENTION: Record<string, boolean> = {}
const EMPTY_CODEX_ACTIVITY_BY_ID = {}
const EMPTY_CLAUDE_ACTIVITY_BY_ID = {}
const EMPTY_AMPLIFIER_ACTIVITY_BY_ID = {}
const EMPTY_OPENCODE_ACTIVITY_BY_ID = {}
const EMPTY_FRESH_AGENT_SESSIONS: Record<string, FreshAgentSessionState> = {}
const EMPTY_PANE_RUNTIME_ACTIVITY_BY_ID: Record<string, PaneRuntimeActivityRecord> = {}

interface TabBarProps {
  sidebarCollapsed?: boolean
  onToggleSidebar?: () => void
}

export default function TabBar({ sidebarCollapsed, onToggleSidebar }: TabBarProps = {}) {
  const dispatch = useAppDispatch()
  const tabsState = useAppSelector((s) => s.tabs as any) as
    | { tabs?: Tab[]; activeTabId?: string | null; renameRequestTabId?: string | null }
    | undefined
  const tabs = useMemo(() => tabsState?.tabs ?? [], [tabsState?.tabs])
  const activeTabId = tabsState?.activeTabId ?? null
  const renameRequestTabId = tabsState?.renameRequestTabId ?? null
  const paneLayouts = useAppSelector((s) => s.panes?.layouts) ?? EMPTY_LAYOUTS
  const paneTitles = useAppSelector((s) => s.panes?.paneTitles) ?? EMPTY_PANE_TITLES
  const attentionByTab = useAppSelector((s) => s.turnCompletion?.attentionByTab) ?? EMPTY_ATTENTION
  const codexActivityByTerminalId = useAppSelector((s) => s.codexActivity?.byTerminalId ?? EMPTY_CODEX_ACTIVITY_BY_ID)
  const claudeActivityByTerminalId = useAppSelector((s) => s.claudeActivity?.byTerminalId ?? EMPTY_CLAUDE_ACTIVITY_BY_ID)
  const amplifierActivityByTerminalId = useAppSelector((s) => s.amplifierActivity?.byTerminalId ?? EMPTY_AMPLIFIER_ACTIVITY_BY_ID)
  const opencodeActivityByTerminalId = useAppSelector((s) => s.opencodeActivity?.byTerminalId ?? EMPTY_OPENCODE_ACTIVITY_BY_ID)
  const freshAgentSessions = useAppSelector((s) => s.freshAgent?.sessions ?? EMPTY_FRESH_AGENT_SESSIONS)
  const paneRuntimeActivityByPaneId = useAppSelector(
    (s) => s.paneRuntimeActivity?.byPaneId ?? EMPTY_PANE_RUNTIME_ACTIVITY_BY_ID
  )
  const attentionDismiss = useAppSelector((s) => s.settings?.settings?.panes?.attentionDismiss ?? 'click')
  const iconsOnTabs = useAppSelector((s) => s.settings?.settings?.panes?.iconsOnTabs ?? true)
  const tabAttentionStyle = useAppSelector((s) => s.settings?.settings?.panes?.tabAttentionStyle ?? 'highlight')
  const multirowTabs = useAppSelector((s) => s.settings?.settings?.panes?.multirowTabs ?? false)
  const extensions = useAppSelector((s) => s.extensions?.entries)

  const ws = useMemo(() => getWsClient(), [])

  // Compute display title for a single tab
  // Priority: user-set title > programmatically-set title (e.g., from Claude) > derived name
  const getDisplayTitle = useCallback(
    (tab: Tab): string => getTabDisplayTitle(tab, paneLayouts[tab.id], paneTitles[tab.id], extensions),
    [paneLayouts, paneTitles, extensions]
  )

  const getPaneEntries = useCallback((tab: Tab): Array<{ paneId: string; content: PaneContent }> | undefined => {
    const layout = paneLayouts[tab.id]
    if (layout) {
      return collectPaneEntries(layout)
    }
    // Fallback: synthesize a single content from tab.mode
    if (tab.mode) {
      return [{
        paneId: tab.id,
        content: {
          kind: 'terminal' as const,
          mode: tab.mode,
          shell: tab.shell,
          createRequestId: tab.createRequestId,
          status: tab.status,
          sessionRef: tab.sessionRef,
          initialCwd: tab.initialCwd,
        },
      }]
    }
    return undefined
  }, [paneLayouts])

  const getTerminalIdsForTab = useCallback((tab: Tab): string[] => {
    const layout = paneLayouts[tab.id]
    if (layout) {
      const ids = collectTerminalIds(layout)
      if (ids.length > 0) {
        return Array.from(new Set(ids))
      }
    }
    return []
  }, [paneLayouts])

  const getBusyPaneIds = useCallback((tab: Tab): string[] => getBusyPaneIdsForTab({
    tab,
    paneLayouts: paneLayouts as Record<string, PaneNode | undefined>,
    codexActivityByTerminalId,
    claudeActivityByTerminalId,
    amplifierActivityByTerminalId,
    opencodeActivityByTerminalId,
    paneRuntimeActivityByPaneId,
    freshAgentSessions,
  }), [amplifierActivityByTerminalId, claudeActivityByTerminalId, codexActivityByTerminalId, freshAgentSessions, opencodeActivityByTerminalId, paneLayouts, paneRuntimeActivityByPaneId])

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [showSwitcher, setShowSwitcher] = useState(false)

  useEffect(() => {
    if (!renameRequestTabId) return
    const tab = tabs.find((t: Tab) => t.id === renameRequestTabId)
    if (!tab) {
      dispatch(clearTabRenameRequest())
      return
    }

    setRenamingId(tab.id)
    setRenameValue(getDisplayTitle(tab))
    dispatch(clearTabRenameRequest())
  }, [dispatch, getDisplayTitle, renameRequestTabId, tabs])

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 5 },
    })
  )

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string)
  }, [])

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      setActiveId(null)

      if (over && active.id !== over.id) {
        const oldIndex = tabs.findIndex((t: Tab) => t.id === active.id)
        const newIndex = tabs.findIndex((t: Tab) => t.id === over.id)
        dispatch(reorderTabs({ fromIndex: oldIndex, toIndex: newIndex }))
      }
    },
    [tabs, dispatch]
  )

  const renderSortableTab = useCallback((tab: Tab) => {
    const busyPaneIds = getBusyPaneIds(tab)
    return (
      <SortableTab
        key={tab.id}
        tab={tab}
        displayTitle={getDisplayTitle(tab)}
        isActive={tab.id === activeTabId}
        needsAttention={!!attentionByTab[tab.id]}
        busy={busyPaneIds.length > 0}
        busyPaneIds={busyPaneIds}
        isDragging={activeId === tab.id}
        isRenaming={renamingId === tab.id}
        renameValue={renameValue}
        paneEntries={getPaneEntries(tab)}
        iconsOnTabs={iconsOnTabs}
        tabAttentionStyle={tabAttentionStyle}
        onRenameChange={setRenameValue}
        onRenameBlur={() => {
          dispatch(applyTabRename({ tabId: tab.id, title: renameValue || tab.title }))
          setRenamingId(null)
        }}
        onRenameKeyDown={(e) => {
          e.stopPropagation() // Prevent dnd-kit from intercepting keys (esp. space)
          if (e.key === 'Enter' || e.key === 'Escape') {
            ;(e.target as HTMLInputElement).blur()
          }
        }}
        onClose={(e) => {
          const terminalIds = getTerminalIdsForTab(tab)
          if (terminalIds.length > 0) {
            const messageType = e.shiftKey ? 'terminal.kill' : 'terminal.detach'
            for (const terminalId of terminalIds) {
              ws.send({
                type: messageType,
                terminalId,
              })
            }
          }
          dispatch(closeTab(tab.id))
        }}
        onClick={() => {
          // Clicking a tab in 'click' mode dismisses its green and ALL its panes'
          // green (decision 1 / Fresh-Eyes round 3). No-op if the tab has none.
          if (attentionDismiss === 'click') {
            dispatch(dismissTabGreen(tab.id))
          }
          dispatch(setActiveTab(tab.id))
        }}
        onDoubleClick={() => {
          setRenamingId(tab.id)
          setRenameValue(getDisplayTitle(tab))
        }}
      />
    )
  }, [
    activeId,
    activeTabId,
    attentionByTab,
    attentionDismiss,
    dispatch,
    getDisplayTitle,
    getBusyPaneIds,
    getPaneEntries,
    getTerminalIdsForTab,
    iconsOnTabs,
    renameValue,
    renamingId,
    tabAttentionStyle,
    ws,
  ])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && activeTabId) {
        if (isEditableShortcutTarget(e.target)) return
        const currentIndex = tabs.findIndex((t: Tab) => t.id === activeTabId)
        if (e.key === 'ArrowLeft' && currentIndex > 0) {
          dispatch(reorderTabs({ fromIndex: currentIndex, toIndex: currentIndex - 1 }))
          e.preventDefault()
        } else if (e.key === 'ArrowRight' && currentIndex < tabs.length - 1) {
          dispatch(reorderTabs({ fromIndex: currentIndex, toIndex: currentIndex + 1 }))
          e.preventDefault()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeTabId, tabs, dispatch])

  const {
    callbackRef,
    canScrollLeft,
    canScrollRight,
    scrollToTab,
    handleArrowClick,
    startHoldScroll,
    stopHoldScroll,
    cancelHoldScroll,
  } = useTabBarScroll(activeTabId, tabs.length, multirowTabs)

  // Container ref for multirow auto-scroll (scoped, not global DOM query)
  const multirowContainerRef = useRef<HTMLDivElement | null>(null)
  const combinedRef = useCallback((node: HTMLDivElement | null) => {
    callbackRef(node)
    multirowContainerRef.current = node
  }, [callbackRef])

  // Container-scoped scroll for active tab in multirow mode (vertical)
  useEffect(() => {
    if (!multirowTabs || !activeTabId) return
    const container = multirowContainerRef.current
    if (!container) return
    const tabEl = container.querySelector(`[data-tab-id="${escapeSelector(activeTabId)}"]`) as HTMLElement | null
    if (!tabEl) return
    const containerRect = container.getBoundingClientRect()
    const tabRect = tabEl.getBoundingClientRect()
    // Only scroll if tab is outside the visible area
    if (tabRect.top < containerRect.top || tabRect.bottom > containerRect.bottom) {
      const offset = tabRect.top - containerRect.top - (containerRect.height / 2) + (tabRect.height / 2)
      container.scrollBy({ top: offset, behavior: 'smooth' })
    }
  }, [activeTabId, multirowTabs])

  // Re-fire horizontal scroll when transitioning from multirow to single-row
  const prevMultirowRef = useRef(multirowTabs)
  useEffect(() => {
    let raf: number | null = null
    if (prevMultirowRef.current && !multirowTabs && activeTabId) {
      // Defer to next frame so the DOM has re-rendered with single-row layout
      raf = requestAnimationFrame(() => scrollToTab(activeTabId))
    }
    prevMultirowRef.current = multirowTabs
    return () => { if (raf !== null) cancelAnimationFrame(raf) }
  }, [multirowTabs, activeTabId, scrollToTab])

  const activeTab = activeId ? tabs.find((t: Tab) => t.id === activeId) : null

  const isMobile = useMobile()

  if (tabs.length === 0) return null

  if (isMobile) {
    return (
      <>
        <MobileTabStrip
          onOpenSwitcher={() => setShowSwitcher(true)}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={onToggleSidebar}
        />
        {showSwitcher && <TabSwitcher onClose={() => setShowSwitcher(false)} />}
      </>
    )
  }

  return (
    <div className={cn(
      "relative z-20 shrink-0 flex items-end px-2 bg-background",
      multirowTabs ? "h-auto" : "h-12 md:h-10"
    )} data-context={ContextIds.Global}>
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-muted-foreground/45"
        aria-hidden="true"
      />
      {sidebarCollapsed && onToggleSidebar && (
        <div
          className={cn(
            "flex-shrink-0 w-10 flex items-end justify-center pb-1",
            !multirowTabs && "h-full"
          )}
          data-testid="desktop-sidebar-reopen-slot"
        >
          <button
            className="p-1 min-h-11 min-w-11 md:h-8 md:w-8 md:min-h-0 md:min-w-0 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
            title="Show sidebar"
            aria-label="Show sidebar"
            onClick={onToggleSidebar}
          >
            <PanelLeft className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={multirowTabs ? rectIntersection : closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={tabs.map((t: Tab) => t.id)}
          strategy={multirowTabs ? rectSortingStrategy : horizontalListSortingStrategy}
        >
          {/* Left scroll arrow -- flex sibling alongside the scroll container */}
          {!multirowTabs && (
          <button
            className={cn(
              'flex-shrink-0 w-7 h-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-all duration-150',
              canScrollLeft ? 'opacity-100' : 'opacity-0 pointer-events-none',
            )}
            aria-label="Scroll tabs left"
            aria-hidden={canScrollLeft ? undefined : true}
            tabIndex={canScrollLeft ? 0 : -1}
            onClick={() => handleArrowClick('left')}
            onPointerDown={() => startHoldScroll('left')}
            onPointerUp={stopHoldScroll}
            onPointerLeave={cancelHoldScroll}
            onPointerCancel={cancelHoldScroll}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          )}

          {/* Scrollable tab strip */}
          <div
            ref={combinedRef}
            data-testid="tab-strip"
            className={cn(
              "flex items-end gap-0.5 pt-px flex-1 min-w-0",
              multirowTabs
                ? "flex-wrap max-h-32 overflow-y-auto"
                : "overflow-x-auto overflow-y-hidden scrollbar-none"
            )}
          >
            {tabs.map(renderSortableTab)}
          </div>

          {/* Right scroll arrow -- flex sibling alongside the scroll container */}
          {!multirowTabs && (
          <button
            className={cn(
              'flex-shrink-0 w-7 h-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-all duration-150',
              canScrollRight ? 'opacity-100' : 'opacity-0 pointer-events-none',
            )}
            aria-label="Scroll tabs right"
            aria-hidden={canScrollRight ? undefined : true}
            tabIndex={canScrollRight ? 0 : -1}
            onClick={() => handleArrowClick('right')}
            onPointerDown={() => startHoldScroll('right')}
            onPointerUp={stopHoldScroll}
            onPointerLeave={cancelHoldScroll}
            onPointerCancel={cancelHoldScroll}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          )}
        </SortableContext>

        {/* Pinned + button -- outside the scrollable area */}
        <button
          className="flex-shrink-0 ml-1 mb-1 p-1 min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center rounded-md border border-dashed border-muted-foreground/40 text-muted-foreground hover:text-foreground hover:border-foreground/50 hover:bg-muted/30 transition-colors"
          title="New shell tab"
          aria-label="New shell tab"
          onClick={() => dispatch(addTab({ mode: 'shell' }))}
          data-context={ContextIds.TabAdd}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>

        <DragOverlay>
          {activeTab ? (
            <div
              style={{
                opacity: 0.9,
                transform: 'scale(1.02)',
                boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                cursor: 'grabbing',
              }}
            >
              <TabItem
                tab={{ ...activeTab, title: getDisplayTitle(activeTab) }}
                isActive={activeTab.id === activeTabId}
                needsAttention={!!attentionByTab[activeTab.id]}
                busy={getBusyPaneIds(activeTab).length > 0}
                busyPaneIds={getBusyPaneIds(activeTab)}
                isDragging={false}
                isRenaming={false}
                renameValue=""
                paneEntries={getPaneEntries(activeTab)}
                iconsOnTabs={iconsOnTabs}
                tabAttentionStyle={tabAttentionStyle}
                onRenameChange={() => {}}
                onRenameBlur={() => {}}
                onRenameKeyDown={() => {}}
                onClose={() => {}}
                onClick={() => {}}
                onDoubleClick={() => {}}
              />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  )
}
