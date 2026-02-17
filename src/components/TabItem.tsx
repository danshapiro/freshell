import { X, Circle } from 'lucide-react'
import { useRef, useEffect } from 'react'
import { cn } from '@/lib/utils'
import PaneIcon from '@/components/icons/PaneIcon'
import type { Tab, TabAttentionStyle } from '@/store/types'
import type { PaneContent } from '@/store/paneTypes'
import type { MouseEvent, KeyboardEvent } from 'react'
import { ContextIds } from '@/components/context-menu/context-menu-constants'

function StatusDot({ status }: { status: string }) {
  if (status === 'running') {
    return <Circle className="h-2 w-2 fill-success text-success" />
  }
  if (status === 'exited') {
    return <Circle className="h-2 w-2 text-muted-foreground/40" />
  }
  if (status === 'error') {
    return <Circle className="h-2 w-2 fill-destructive text-destructive" />
  }
  // Creating state
  return <Circle className="h-2 w-2 text-muted-foreground/20 animate-pulse" />
}

function statusClassName(status: string): string {
  switch (status) {
    case 'running': return 'text-success'
    case 'exited': return 'text-muted-foreground/40'
    case 'error': return 'text-destructive'
    default: return 'text-muted-foreground/20 animate-pulse'
  }
}

const MAX_TAB_ICONS = 6

export interface TabItemProps {
  tab: Tab
  isActive: boolean
  needsAttention: boolean
  isDragging: boolean
  isRenaming: boolean
  renameValue: string
  paneContents?: PaneContent[]
  iconsOnTabs?: boolean
  tabAttentionStyle?: TabAttentionStyle
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
  needsAttention,
  isDragging,
  isRenaming,
  renameValue,
  paneContents,
  iconsOnTabs = true,
  tabAttentionStyle = 'highlight',
  onRenameChange,
  onRenameBlur,
  onRenameKeyDown,
  onClose,
  onClick,
  onDoubleClick,
}: TabItemProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isRenaming])

  const renderIcons = () => {
    if (!iconsOnTabs || !paneContents || paneContents.length === 0) {
      return <StatusDot status={tab.status} />
    }

    const visible = paneContents.slice(0, MAX_TAB_ICONS)
    const overflow = paneContents.length - MAX_TAB_ICONS

    return (
      <span className="flex items-center gap-0.5">
        {visible.map((content, i) => {
          const status = content.kind === 'terminal' ? content.status : 'running'
          return (
            <PaneIcon
              key={i}
              content={content}
              className={cn('h-3 w-3 shrink-0', statusClassName(status))}
            />
          )
        })}
        {overflow > 0 && (
          <span className="text-[10px] text-muted-foreground leading-none">+{overflow}</span>
        )}
      </span>
    )
  }

  return (
    <div
      className={cn(
        'group relative flex items-center gap-2 h-8 px-3 rounded-t-md border-x border-t border-muted-foreground/45 text-sm cursor-pointer transition-colors',
        isActive
          ? cn(
              "z-30 -mb-px border-b border-b-background bg-background text-foreground after:pointer-events-none after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:bg-background after:content-['']",
              needsAttention && tabAttentionStyle !== 'none' && (
                tabAttentionStyle === 'darken'
                  ? 'border-t-[3px] border-t-muted-foreground bg-foreground/[0.08] shadow-[inset_0_4px_8px_hsl(var(--foreground)/0.1)]'
                  : 'border-t-[3px] border-t-success bg-success/15 shadow-[inset_0_4px_8px_hsl(var(--success)/0.2)]'
              ),
              needsAttention && tabAttentionStyle === 'pulse' && 'animate-pulse'
            )
          : needsAttention && tabAttentionStyle !== 'none'
            ? tabAttentionStyle === 'darken'
              ? 'bg-foreground/15 text-foreground hover:bg-foreground/20 dark:bg-foreground/20 dark:text-foreground dark:hover:bg-foreground/25'
              : cn(
                  'bg-emerald-100 text-emerald-900 hover:bg-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-100 dark:hover:bg-emerald-900/55',
                  tabAttentionStyle === 'pulse' && 'animate-pulse'
                )
            : 'bg-muted text-muted-foreground hover:text-foreground hover:bg-muted/90',
        isDragging && 'opacity-50'
      )}
      role="button"
      tabIndex={0}
      aria-label={tab.title}
      data-context={ContextIds.Tab}
      data-tab-id={tab.id}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
    >
      {renderIcons()}

      {isRenaming ? (
        <input
          ref={inputRef}
          className="bg-transparent outline-none w-32 text-sm"
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onBlur={onRenameBlur}
          onKeyDown={onRenameKeyDown}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="whitespace-nowrap truncate text-sm max-w-[5rem]">
          {tab.title}
        </span>
      )}

      <button
        className={cn(
          'ml-0.5 p-0.5 min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center rounded transition-opacity',
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
