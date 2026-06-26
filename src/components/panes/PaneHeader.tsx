import { useRef, useEffect } from 'react'
import { X, Maximize2, Minimize2, Search, RefreshCw, SquareTerminal, Terminal, FileSearch, Globe, FilePen, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getTerminalStatusIconClassName } from '@/lib/terminal-status-indicator'
import type { TerminalStatus } from '@/store/types'
import type { PaneContent } from '@/store/paneTypes'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { splitPane } from '@/store/panesSlice'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import PaneIcon from '@/components/icons/PaneIcon'
import FreshAgentSettingsButton from '@/components/fresh-agent/FreshAgentSettingsButton'
import FreshAgentContextMeter from '@/components/fresh-agent/FreshAgentContextMeter'
import { getFreshAgentLabel } from '@/lib/fresh-agent-registry'

interface PaneHeaderProps {
  tabId?: string
  paneId?: string
  title: string
  metaLabel?: string
  metaTooltip?: string
  needsAttention?: boolean
  busy?: boolean
  status: TerminalStatus
  isActive: boolean
  onClose: () => void
  onToggleZoom?: () => void
  isZoomed?: boolean
  content: PaneContent
  isRenaming?: boolean
  renameValue?: string
  renameError?: string
  onRenameChange?: (value: string) => void
  onRenameBlur?: () => void
  onRenameKeyDown?: (e: React.KeyboardEvent) => void
  onDoubleClick?: () => void
  onSearch?: () => void
  onRefresh?: () => void
}

const FRESH_AGENT_TOOL_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Bash: Terminal,
  Read: FileText,
  Write: FilePen,
  Edit: FilePen,
  Glob: FileSearch,
  Grep: FileSearch,
  WebFetch: Globe,
  WebSearch: Globe,
}

function FreshAgentToolIcons({
  content,
}: {
  content: Extract<PaneContent, { kind: 'fresh-agent' }>
}) {
  const sessionKey = content.sessionId ? makeFreshAgentSessionKey({
    sessionId: content.sessionId,
    sessionType: content.sessionType,
    provider: content.provider,
  }) : undefined
  const tools = useAppSelector((state) =>
    sessionKey ? state.freshAgent?.sessions?.[sessionKey]?.tools : undefined,
  )

  if (!tools?.length) return null

  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 text-muted-foreground/60" title={tools.map((t) => t.name).join(', ')}>
      {tools.map((tool) => {
        const Icon = FRESH_AGENT_TOOL_ICONS[tool.name]
        if (!Icon) return null
        return <Icon key={tool.name} className="h-3 w-3" aria-label={tool.name} />
      })}
    </span>
  )
}

function FreshAgentOpenTerminalButton({
  tabId,
  paneId,
  content,
}: {
  tabId: string
  paneId: string
  content: Extract<PaneContent, { kind: 'fresh-agent' }>
}) {
  const dispatch = useAppDispatch()

  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        // normalizePaneContent fills createRequestId/status for terminal
        // inputs; mode 'shell' + cwd is a complete input.
        dispatch(splitPane({
          tabId,
          paneId,
          direction: 'horizontal',
          newContent: {
            kind: 'terminal',
            mode: 'shell',
            ...(content.initialCwd ? { initialCwd: content.initialCwd } : {}),
          } as Parameters<typeof splitPane>[0]['newContent'],
        }))
      }}
      className="inline-flex h-6 w-6 items-center justify-center rounded opacity-60 hover:opacity-100 transition-opacity sm:h-4 sm:w-4"
      title={content.initialCwd
        ? `Open terminal pane at ${content.initialCwd}`
        : 'Open terminal pane at this session’s directory'}
      aria-label="Open terminal at session directory"
    >
      <SquareTerminal className="h-[18px] w-[18px] sm:h-3 sm:w-3" />
    </button>
  )
}

export default function PaneHeader({
  tabId = '',
  paneId = '',
  title,
  metaLabel,
  metaTooltip,
  needsAttention,
  busy,
  status,
  isActive,
  onClose,
  onToggleZoom,
  isZoomed,
  content,
  isRenaming,
  renameValue,
  renameError,
  onRenameChange,
  onRenameBlur,
  onRenameKeyDown,
  onDoubleClick,
  onSearch,
  onRefresh,
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
        'flex items-center gap-2 h-[2.625rem] sm:h-7 px-2 text-sm border-b border-border shrink-0',
        needsAttention
          ? 'bg-emerald-50 border-l-2 border-l-emerald-500 dark:bg-emerald-900/30'
          : isActive ? 'bg-muted' : 'bg-muted/50 text-muted-foreground'
      )}
      onDoubleClick={isRenaming ? undefined : onDoubleClick}
      role="banner"
      aria-label={`Pane: ${title}`}
    >
      <PaneIcon
        content={content}
        className={cn(
          'h-3.5 w-3.5 shrink-0',
          busy && status === 'running' ? 'text-blue-500' : getTerminalStatusIconClassName(status),
        )}
      />

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
            aria-invalid={renameError ? true : undefined}
          />
        ) : (
          <span className="block truncate" title={title}>
            {title}
          </span>
        )}
      </div>

      <div className="ml-auto flex h-full items-center gap-2">
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
            className="inline-flex h-6 w-6 items-center justify-center rounded opacity-60 hover:opacity-100 transition-opacity sm:h-4 sm:w-4"
            title="Search in terminal"
            aria-label="Search in terminal"
          >
            <Search className="h-[18px] w-[18px] sm:h-3 sm:w-3" />
          </button>
        )}

        {onRefresh && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onRefresh()
            }}
            className="inline-flex h-6 w-6 items-center justify-center rounded opacity-60 hover:opacity-100 transition-opacity sm:h-4 sm:w-4"
            title="Refresh pane"
            aria-label="Refresh pane"
          >
            <RefreshCw className="h-[18px] w-[18px] sm:h-3 sm:w-3" />
          </button>
        )}

        {content.kind === 'fresh-agent' && (
          <>
            <FreshAgentToolIcons content={content} />
            {/* Cwd/prompt-derived titles make the three fresh clients look
                identical — pin the agent identity in the header. */}
            <span
              className="shrink-0 rounded-full border border-border/70 px-2 py-0.5 text-2xs text-muted-foreground"
              title={`${getFreshAgentLabel(content.sessionType)} session`}
            >
              {getFreshAgentLabel(content.sessionType)}
            </span>
            <FreshAgentContextMeter paneContent={content} />
            {tabId && paneId ? (
              <FreshAgentOpenTerminalButton tabId={tabId} paneId={paneId} content={content} />
            ) : null}
            <FreshAgentSettingsButton
              tabId={tabId}
              paneId={paneId}
              paneContent={content}
            />
          </>
        )}

        {onToggleZoom && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onToggleZoom()
            }}
            className="inline-flex h-6 w-6 items-center justify-center rounded opacity-60 hover:opacity-100 transition-opacity sm:h-4 sm:w-4"
            title={isZoomed ? 'Restore pane' : 'Maximize pane'}
            aria-label={isZoomed ? 'Restore pane' : 'Maximize pane'}
          >
            {isZoomed
              ? <Minimize2 className="h-[18px] w-[18px] sm:h-3 sm:w-3" />
              : <Maximize2 className="h-[18px] w-[18px] sm:h-3 sm:w-3" />}
          </button>
        )}

        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          className="inline-flex h-6 w-6 items-center justify-center rounded opacity-60 hover:opacity-100 hover:bg-background/50 transition-opacity sm:h-4 sm:w-4"
          title="Close pane"
        >
          <X className="h-[18px] w-[18px] sm:h-3 sm:w-3" />
        </button>
      </div>
    </div>
  )
}
