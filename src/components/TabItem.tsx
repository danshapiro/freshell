import { X, Circle } from 'lucide-react'
import { useRef, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { getTerminalStatusDotClassName, getTerminalStatusIconClassName } from '@/lib/terminal-status-indicator'
import PaneIcon from '@/components/icons/PaneIcon'
import RepoIcon, { type RepoIconInfo } from '@/components/icons/RepoIcon'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import type { Tab, TabAttentionStyle, TerminalStatus } from '@/store/types'
import type { PaneContent } from '@/store/paneTypes'
import type { MouseEvent, KeyboardEvent } from 'react'
import { ContextIds } from '@/components/context-menu/context-menu-constants'

type TabPaneEntry = {
  paneId: string
  content: PaneContent
  /** cwd hint identifying this pane's repo (coding-agent panes only). */
  repoCwd?: string
}

function StatusDot({ status, busy }: { status: TerminalStatus; busy?: boolean }) {
  // `busy` is already the authoritative per-pane busy aggregate (busyPaneIds);
  // do NOT AND it with the last-writer-wins tab.status, which a sibling pane's
  // 'exited' can clobber and wrongly suppress blue.
  return <Circle className={cn('h-2 w-2 shrink-0', busy ? 'fill-blue-500 text-blue-500' : getTerminalStatusDotClassName(status))} />
}

/** Max pane-type icons shown per tab; panes beyond this fold into the '+N' badge. */
const MAX_PANE_ICONS = 3

/**
 * Max distinct repo icons shown per tab (locked decision: each icon group
 * is capped independently at 3). Repos beyond the cap are silently
 * truncated -- the '+N' badge counts hidden panes only.
 */
const MAX_REPO_ICONS = 3

export interface TabItemProps {
  tab: Tab
  isActive: boolean
  needsAttention: boolean
  busy?: boolean
  busyPaneIds?: string[]
  isDragging: boolean
  isRenaming: boolean
  renameValue: string
  paneEntries?: TabPaneEntry[]
  iconsOnTabs?: boolean
  repoIconsOnTabs?: boolean
  repoIcons?: Record<string, RepoIconInfo>
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
  busy,
  busyPaneIds = [],
  isDragging,
  isRenaming,
  renameValue,
  paneEntries,
  iconsOnTabs = true,
  repoIconsOnTabs = true,
  repoIcons,
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
    if (!iconsOnTabs || !paneEntries || paneEntries.length === 0) {
      return <StatusDot status={tab.status} busy={busy} />
    }

    const visible = paneEntries.slice(0, MAX_PANE_ICONS)
    const overflow = paneEntries.length - MAX_PANE_ICONS
    const hiddenBusyPane = paneEntries
      .slice(MAX_PANE_ICONS)
      .some((entry) => busyPaneIds.includes(entry.paneId))

    // Group visible entries by repo identity (first-appearance order) so each
    // distinct repo icon renders once, immediately left of that repo's agent
    // icons. Entries without repo info keep their position as singleton groups.
    type Group = { key: string; info?: RepoIconInfo; entries: typeof visible }
    const groups: Group[] = []
    const groupIndex = new Map<string, number>()
    for (const entry of visible) {
      const info = repoIconsOnTabs && entry.repoCwd ? repoIcons?.[entry.repoCwd] : undefined
      const key = info ? `repo:${info.repoKey}` : `pane:${entry.paneId}`
      const existing = groupIndex.get(key)
      if (existing !== undefined) {
        groups[existing].entries.push(entry)
        continue
      }
      groupIndex.set(key, groups.length)
      groups.push({ key, info, entries: [entry] })
    }

    // Cap distinct repo icons independently of the pane cap. The visible
    // slice (<= MAX_PANE_ICONS entries) cannot yield more repo groups than
    // that today; this guard keeps the repo-icon bound at 3 even if
    // MAX_PANE_ICONS changes.
    const repoIconKeys = new Set(
      groups
        .filter((group) => group.info)
        .slice(0, MAX_REPO_ICONS)
        .map((group) => group.key),
    )

    return (
      <span className="flex shrink-0 items-center gap-0.5">
        {groups.map((group) => (
          <span key={group.key} className="flex items-center gap-0.5">
            {group.info && repoIconKeys.has(group.key) && (
              <RepoIcon info={group.info} className="h-3 w-3 shrink-0" />
            )}
            {group.entries.map(({ paneId, content }) => {
              const status: TerminalStatus = content.kind === 'terminal' ? content.status : 'running'
              const isBusy = busyPaneIds.includes(paneId)
              return (
                <PaneIcon
                  key={paneId}
                  content={content}
                  className={cn(
                    'h-3 w-3 shrink-0',
                    isBusy ? 'text-blue-500' : getTerminalStatusIconClassName(status),
                  )}
                />
              )
            })}
          </span>
        ))}
        {overflow > 0 && (
          <span className={cn('text-[10px] leading-none', hiddenBusyPane ? 'text-blue-500' : 'text-muted-foreground')}>+{overflow}</span>
        )}
      </span>
    )
  }

  const tabContent = (
    <div
      className={cn(
        'group relative flex w-full min-w-0 items-center gap-2 h-8 px-3 rounded-t-md border-x border-t border-muted-foreground/45 text-sm cursor-pointer transition-colors',
        isActive
          ? cn(
              "z-30 border-b border-b-background bg-background text-foreground after:pointer-events-none after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:bg-background after:content-['']",
              needsAttention && tabAttentionStyle !== 'none' && (
                tabAttentionStyle === 'darken'
                  ? 'border-t-[3px] border-t-muted-foreground bg-foreground/[0.08] shadow-[inset_0_4px_8px_hsl(var(--foreground)/0.1)]'
                  : 'border-t-[3px] border-t-success bg-success/15 shadow-[inset_0_4px_8px_hsl(var(--success)/0.2)]'
              ),
              needsAttention && tabAttentionStyle === 'pulse' && 'animate-pulse'
            )
          : cn(
              'shadow-[inset_0_-1px_0_hsl(var(--muted-foreground)/0.45)]',
              needsAttention && tabAttentionStyle !== 'none'
                ? tabAttentionStyle === 'darken'
                  ? 'bg-foreground/15 text-foreground hover:bg-foreground/20 dark:bg-foreground/20 dark:text-foreground dark:hover:bg-foreground/25'
                  : cn(
                      'bg-emerald-100 text-emerald-900 hover:bg-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-100 dark:hover:bg-emerald-900/55',
                      tabAttentionStyle === 'pulse' && 'animate-pulse'
                    )
                : 'bg-muted text-muted-foreground hover:text-foreground hover:bg-muted/90'
            ),
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
          className="bg-transparent outline-none flex-1 min-w-0 text-sm"
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onBlur={onRenameBlur}
          onKeyDown={onRenameKeyDown}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="flex-1 min-w-0 whitespace-nowrap truncate text-sm">
          {tab.title}
        </span>
      )}

      <button
        className={cn(
          'ml-0.5 p-0.5 min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex shrink-0 items-center justify-center rounded transition-opacity',
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

  // Suppress tooltip during rename and drag — the Tooltip's hover
  // events would interfere with the rename input and DnD overlay.
  if (isRenaming || isDragging) {
    return tabContent
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {tabContent}
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {tab.title}
      </TooltipContent>
    </Tooltip>
  )
}
