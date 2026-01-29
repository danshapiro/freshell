import { Plus } from 'lucide-react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { addTab, closeTab, setActiveTab, updateTab, reorderTabs } from '@/store/tabsSlice'
import { getWsClient } from '@/lib/ws-client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import TabItem from './TabItem'
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

interface SortableTabProps {
  tab: Tab
  isActive: boolean
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
  isActive,
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

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <TabItem
        tab={tab}
        isActive={isActive}
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

export default function TabBar() {
  const dispatch = useAppDispatch()
  const { tabs, activeTabId } = useAppSelector((s) => s.tabs)

  const ws = useMemo(() => getWsClient(), [])

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)

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
    <div className="h-10 flex items-center gap-1 px-2 border-b border-border/30 bg-background">
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
          <div className="flex items-center gap-0.5 overflow-x-auto flex-1 py-1">
            {tabs.map((tab: Tab) => (
              <SortableTab
                key={tab.id}
                tab={tab}
                isActive={tab.id === activeTabId}
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
                  if (e.key === 'Enter' || e.key === 'Escape') {
                    ;(e.target as HTMLInputElement).blur()
                  }
                }}
                onClose={(e) => {
                  if (tab.terminalId) {
                    ws.send({
                      type: e.shiftKey ? 'terminal.kill' : 'terminal.detach',
                      terminalId: tab.terminalId,
                    })
                  }
                  dispatch(closeTab(tab.id))
                }}
                onClick={() => dispatch(setActiveTab(tab.id))}
                onDoubleClick={() => {
                  setRenamingId(tab.id)
                  setRenameValue(tab.title)
                }}
              />
            ))}
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
                tab={activeTab}
                isActive={activeTab.id === activeTabId}
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

      <button
        className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        title="New shell tab"
        onClick={() => dispatch(addTab({ mode: 'shell' }))}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
