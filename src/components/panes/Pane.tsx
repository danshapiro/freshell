import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TerminalStatus } from '@/store/types'
import PaneHeader from './PaneHeader'
import { ContextIds } from '@/components/context-menu/context-menu-constants'

interface PaneProps {
  tabId: string
  paneId: string
  isActive: boolean
  isOnlyPane: boolean
  title?: string
  status?: TerminalStatus
  onClose: () => void
  onFocus: () => void
  children: React.ReactNode
  isRenaming?: boolean
  renameValue?: string
  onRenameChange?: (value: string) => void
  onRenameBlur?: () => void
  onRenameKeyDown?: (e: React.KeyboardEvent) => void
  onDoubleClickTitle?: () => void
}

export default function Pane({
  tabId,
  paneId,
  isActive,
  isOnlyPane,
  title,
  status,
  onClose,
  onFocus,
  children,
  isRenaming,
  renameValue,
  onRenameChange,
  onRenameBlur,
  onRenameKeyDown,
  onDoubleClickTitle,
}: PaneProps) {
  const showHeader = !isOnlyPane && title !== undefined

  return (
    <div
      className={cn(
        'relative h-full w-full overflow-hidden flex flex-col',
        !isActive && 'opacity-[0.85]'
      )}
      role="button"
      aria-label={`Focus pane ${title || 'untitled'}`}
      tabIndex={0}
      onMouseDown={onFocus}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onFocus()
        }
      }}
    >
      {/* Pane header - shown when multiple panes and title available */}
      {showHeader && (
        <div data-context={ContextIds.Pane} data-tab-id={tabId} data-pane-id={paneId}>
          <PaneHeader
            title={title}
            status={status || 'creating'}
            isActive={isActive}
            onClose={onClose}
            isRenaming={isRenaming}
            renameValue={renameValue}
            onRenameChange={onRenameChange}
            onRenameBlur={onRenameBlur}
            onRenameKeyDown={onRenameKeyDown}
            onDoubleClick={onDoubleClickTitle}
          />
        </div>
      )}

      {/* Fallback close button - shown when no header but multiple panes */}
      {!isOnlyPane && !showHeader && (
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          className="absolute top-1 right-1 z-10 p-1 rounded opacity-50 hover:opacity-100 text-muted-foreground hover:bg-muted/50 transition-opacity"
          title="Close pane"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}

      {/* Content */}
      <div className="h-full w-full min-h-0">
        {children}
      </div>
    </div>
  )
}
