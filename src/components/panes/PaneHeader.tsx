import { useRef, useEffect } from 'react'
import { X, Maximize2, Minimize2, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TerminalStatus } from '@/store/types'
import type { PaneContent } from '@/store/paneTypes'
import PaneIcon from '@/components/icons/PaneIcon'

function statusClassName(status: TerminalStatus): string {
  switch (status) {
    case 'running': return 'text-success'
    case 'exited': return 'text-muted-foreground/40'
    case 'error': return 'text-destructive'
    default: return 'text-muted-foreground/20 animate-pulse'
  }
}

interface PaneHeaderProps {
  title: string
  metaLabel?: string
  metaTooltip?: string
  needsAttention?: boolean
  status: TerminalStatus
  isActive: boolean
  onClose: () => void
  onToggleZoom?: () => void
  isZoomed?: boolean
  content: PaneContent
  isRenaming?: boolean
  renameValue?: string
  onRenameChange?: (value: string) => void
  onRenameBlur?: () => void
  onRenameKeyDown?: (e: React.KeyboardEvent) => void
  onDoubleClick?: () => void
  onSearch?: () => void
}

export default function PaneHeader({
  title,
  metaLabel,
  metaTooltip,
  needsAttention,
  status,
  isActive,
  onClose,
  onToggleZoom,
  isZoomed,
  content,
  isRenaming,
  renameValue,
  onRenameChange,
  onRenameBlur,
  onRenameKeyDown,
  onDoubleClick,
  onSearch,
}: PaneHeaderProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isRenaming])

  return (
    <div
      className={cn(
        'flex items-center gap-2 h-7 px-2 text-sm border-b border-border shrink-0',
        needsAttention
          ? 'bg-emerald-50 border-l-2 border-l-emerald-500 dark:bg-emerald-900/30'
          : isActive ? 'bg-muted' : 'bg-muted/50 text-muted-foreground'
      )}
      onDoubleClick={isRenaming ? undefined : onDoubleClick}
      role="banner"
      aria-label={`Pane: ${title}`}
    >
      <PaneIcon content={content} className={cn('h-3.5 w-3.5 shrink-0', statusClassName(status))} />

      <div className="min-w-0 flex-1">
        {isRenaming ? (
          <input
            ref={inputRef}
            className="bg-transparent outline-none w-full min-w-0 text-sm"
            value={renameValue ?? ''}
            onChange={(e) => onRenameChange?.(e.target.value)}
            onBlur={onRenameBlur}
            onKeyDown={onRenameKeyDown}
            onClick={(e) => e.stopPropagation()}
            aria-label="Rename pane"
          />
        ) : (
          <span className="block truncate" title={title}>
            {title}
          </span>
        )}
      </div>

      <div className="ml-auto flex items-center gap-2">
        {metaLabel && (
          <span
            className="max-w-[18rem] truncate text-xs text-muted-foreground text-right"
            title={metaTooltip || metaLabel}
          >
            {metaLabel}
          </span>
        )}

        {onSearch && content.kind === 'terminal' && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onSearch()
            }}
            className="p-0.5 rounded opacity-60 hover:opacity-100 transition-opacity"
            title="Search in terminal"
            aria-label="Search in terminal"
          >
            <Search className="h-3 w-3" />
          </button>
        )}

        {onToggleZoom && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onToggleZoom()
            }}
            className="p-0.5 rounded opacity-60 hover:opacity-100 transition-opacity"
            title={isZoomed ? 'Restore pane' : 'Maximize pane'}
            aria-label={isZoomed ? 'Restore pane' : 'Maximize pane'}
          >
            {isZoomed ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
          </button>
        )}

        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          className="p-0.5 rounded opacity-60 hover:opacity-100 hover:bg-background/50 transition-opacity"
          title="Close pane"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </div>
  )
}
