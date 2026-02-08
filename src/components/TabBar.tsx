import { Plus } from 'lucide-react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { addTab, closeTab, setActiveTab, updateTab, reorderTabs, clearTabRenameRequest } from '@/store/tabsSlice'
import { getWsClient } from '@/lib/ws-client'
import { getTabDisplayTitle } from '@/lib/tab-title'
import { collectTerminalIds } from '@/lib/pane-utils'
import { useCallback, useEffect, useMemo, useState } from 'react'
import TabItem from './TabItem'
import { cancelCodingCliRequest } from '@/store/codingCliSlice'
import {
  DndContext,
  closestCenter,
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
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Tab } from '@/store/types'
import { ContextIds } from '@/components/context-menu/context-menu-constants'

interface SortableTabProps {
  tab: Tab
  displayTitle: string
  isActive: boolean
  needsAttention: boolean
  isDragging: boolean
  isRenaming: boolean
  renameValue: string
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
  isDragging,
  isRenaming,
  renameValue,
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
    transform: CSS.Transform.toString(transform),
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
        isDragging={isDragging}
        isRenaming={isRenaming}
        renameValue={renameValue}
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
const EMPTY_ATTENTION: Record<string, boolean> = {}

export default function TabBar() {
  const dispatch = useAppDispatch()
  const tabsState = useAppSelector((s) => s.tabs as any) as
    | { tabs?: Tab[]; activeTabId?: string | null; renameRequestTabId?: string | null }
    | undefined
  const tabs = useMemo(() => tabsState?.tabs ?? [], [tabsState?.tabs])
  const activeTabId = tabsState?.activeTabId ?? null
  const renameRequestTabId = tabsState?.renameRequestTabId ?? null
  const paneLayouts = useAppSelector((s) => s.panes?.layouts) ?? EMPTY_LAYOUTS
  const attentionByTab = useAppSelector((s) => s.turnCompletion?.attentionByTab) ?? EMPTY_ATTENTION

  const ws = useMemo(() => getWsClient(), [])

  // Compute display title for a single tab
  // Priority: user-set title > programmatically-set title (e.g., from Claude) > derived name
  const getDisplayTitle = useCallback(
    (tab: Tab): string => getTabDisplayTitle(tab, paneLayouts[tab.id]),
    [paneLayouts]
  )

  const getTerminalIdsForTab = useCallback((tab: Tab): string[] => {
    const layout = paneLayouts[tab.id]
    if (layout) {
      const ids = collectTerminalIds(layout)
      if (ids.length > 0) {
        return Array.from(new Set(ids))
      }
    }
    return tab.terminalId ? [tab.terminalId] : []
  }, [paneLayouts])

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)

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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && activeTabId) {
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

  const activeTab = activeId ? tabs.find((t: Tab) => t.id === activeId) : null

  if (tabs.length === 0) return null

  return (
    <div className="h-10 flex items-end px-2 bg-card" data-context={ContextIds.Global}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={tabs.map((t: Tab) => t.id)}
          strategy={horizontalListSortingStrategy}
        >
          <div className="flex items-end gap-0.5 overflow-x-auto flex-1">
            {tabs.map((tab: Tab) => (
              <SortableTab
                key={tab.id}
                tab={tab}
                displayTitle={getDisplayTitle(tab)}
                isActive={tab.id === activeTabId}
                needsAttention={!!attentionByTab[tab.id]}
                isDragging={activeId === tab.id}
                isRenaming={renamingId === tab.id}
                renameValue={renameValue}
                onRenameChange={setRenameValue}
                onRenameBlur={() => {
                  dispatch(
                    updateTab({
                      id: tab.id,
                      updates: { title: renameValue || tab.title, titleSetByUser: true },
                    })
                  )
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
                  } else if (tab.codingCliSessionId) {
                    if (tab.status === 'creating') {
                      dispatch(cancelCodingCliRequest({ requestId: tab.codingCliSessionId }))
                    } else {
                      ws.send({
                        type: 'codingcli.kill',
                        sessionId: tab.codingCliSessionId,
                      })
                    }
                  }
                  dispatch(closeTab(tab.id))
                }}
                onClick={() => dispatch(setActiveTab(tab.id))}
                onDoubleClick={() => {
                  setRenamingId(tab.id)
                  setRenameValue(getDisplayTitle(tab))
                }}
              />
            ))}
            <button
              className="flex-shrink-0 ml-1 mb-1 p-1 rounded-md border border-dashed border-muted-foreground/40 text-muted-foreground hover:text-foreground hover:border-foreground/50 hover:bg-muted/30 transition-colors"
              title="New shell tab"
              aria-label="New shell tab"
              onClick={() => dispatch(addTab({ mode: 'shell' }))}
              data-context={ContextIds.TabAdd}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </SortableContext>

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
                isDragging={false}
                isRenaming={false}
                renameValue=""
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
