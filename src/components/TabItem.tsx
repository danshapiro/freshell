import { X, Circle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Tab } from '@/store/types'
import type { MouseEvent, KeyboardEvent } from 'react'

function StatusIndicator({ status }: { status: string }) {
  if (status === 'running') {
    return (
      <div className="relative">
        <Circle className="h-2 w-2 fill-success text-success" />
      </div>
    )
  }
  if (status === 'exited') {
    return <Circle className="h-2 w-2 text-muted-foreground/40" />
  }
  if (status === 'error') {
    return <Circle className="h-2 w-2 fill-destructive text-destructive" />
  }
  return <Circle className="h-2 w-2 text-muted-foreground/20 animate-pulse" />
}

export interface TabItemProps {
  tab: Tab
  isActive: boolean
  isDragging: boolean
  isRenaming: boolean
  renameValue: string
  onRenameChange: (value: string) => void
  onRenameBlur: () => void
  onRenameKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
  onClose: (e: MouseEvent<HTMLButtonElement>) => void
  onClick: () => void
  onDoubleClick: () => void
}

export default function TabItem({
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
}: TabItemProps) {
  return (
    <div
      className={cn(
        'group flex items-center gap-2 h-7 px-3 rounded-md text-sm cursor-pointer transition-all',
        isActive
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
        isDragging && 'opacity-50'
      )}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <StatusIndicator status={tab.status} />

      {isRenaming ? (
        <input
          className="bg-transparent outline-none w-32 text-sm"
          value={renameValue}
          autoFocus
          onChange={(e) => onRenameChange(e.target.value)}
          onBlur={onRenameBlur}
          onKeyDown={onRenameKeyDown}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          className={cn(
            'whitespace-nowrap truncate text-sm',
            isActive ? 'max-w-[10rem]' : 'max-w-[5rem]'
          )}
          title={tab.title}
        >
          {tab.title}
        </span>
      )}

      <button
        className={cn(
          'ml-0.5 p-0.5 rounded transition-opacity',
          isActive
            ? 'opacity-60 hover:opacity-100'
            : 'opacity-0 group-hover:opacity-60 hover:!opacity-100'
        )}
        title="Close (Shift+Click to kill)"
        onClick={(e) => {
          e.stopPropagation()
          onClose(e)
        }}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}
