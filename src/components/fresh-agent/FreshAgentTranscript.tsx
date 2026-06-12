import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import SlotReel from '@/components/fresh-agent/shared/SlotReel'
import { getToolPreview } from '@/components/fresh-agent/shared/tool-preview'
import { cn } from '@/lib/utils'
import type { FreshAgentTranscriptItem, FreshAgentTurn } from '@shared/fresh-agent-contract'
import {
  FreshAgentItemCard,
  FreshAgentMarkdownBody,
  FreshAgentToolBlock,
  itemToToolDisplay,
  stripSystemReminders,
  type FreshAgentToolDisplay,
} from './FreshAgentItemCard'
import {
  buildTurnActionItems,
  FreshAgentTurnActions,
  FreshAgentTurnContextMenu,
  turnPlainText,
  type FreshAgentTurnContextMenuState,
} from './FreshAgentTurnActions'
import { FreshAgentActionSheet } from './FreshAgentActionSheet'
import { buildLongPressHandlers, useCoarsePointer } from '@/lib/pointer'
import { getFreshAgentDisplayTurnKey } from '@shared/fresh-agent-turns'

function getTurnLabel(turn: FreshAgentTurn, agentLabel?: string): string {
  switch (turn.role) {
    case 'user':
      return 'You'
    case 'assistant':
      return agentLabel ?? 'Assistant'
    case 'system':
      return 'System'
    case 'tool':
      return 'Tool'
    default:
      return 'Turn'
  }
}

function formatTurnTimecode(timestamp: string | undefined): string | null {
  if (!timestamp) return null
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return timestamp
  return date.toLocaleTimeString()
}

function isToolLike(item: FreshAgentTranscriptItem): boolean {
  return item.kind === 'tool_use'
    || item.kind === 'tool_result'
    || item.kind === 'command'
    || item.kind === 'file_change'
    || item.kind === 'mcp_tool'
    || item.kind === 'dynamic_tool'
    || item.kind === 'web_search'
    || item.kind === 'image_view'
    || item.kind === 'image_generation'
}

/**
 * Thinking and reasoning roll through the activity strip alongside tools, so a
 * working turn occupies one line instead of stacking disclosures down the pane.
 */
function isActivityLike(item: FreshAgentTranscriptItem): boolean {
  return isToolLike(item) || item.kind === 'thinking' || item.kind === 'reasoning'
}

type TranscriptDisplayOptions = {
  showThinking: boolean
}

function shouldDisplayTranscriptItem(
  item: FreshAgentTranscriptItem,
  options: TranscriptDisplayOptions,
): boolean {
  if (item.kind === 'thinking' || item.kind === 'reasoning') {
    return options.showThinking
  }
  return true
}

function formatJson(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value ?? null, null, 2)
  } catch {
    return String(value)
  }
}

type ActivityRow =
  | { type: 'thinking'; id: string; text: string }
  | { type: 'tool'; tool: FreshAgentToolDisplay }

function buildActivity(items: FreshAgentTranscriptItem[]): ActivityRow[] {
  const rows: ActivityRow[] = []
  const toolIndexById = new Map<string, number>()
  // Providers stream thinking in chunks; consecutive thinking/reasoning items
  // merge into one row instead of stacking N "Thinking:" fragments.
  const pushThinking = (id: string, text: string) => {
    if (!text) return
    const last = rows[rows.length - 1]
    if (last?.type === 'thinking') {
      rows[rows.length - 1] = { ...last, text: `${last.text}\n\n${text}` }
      return
    }
    rows.push({ type: 'thinking', id, text })
  }
  for (const item of items) {
    if (item.kind === 'thinking') {
      pushThinking(item.id, stripSystemReminders(item.text))
      continue
    }
    if (item.kind === 'reasoning') {
      pushThinking(item.id, item.summary.length > 0 ? item.summary.join('\n') : (item.text ?? ''))
      continue
    }
    if (item.kind === 'tool_result') {
      const index = toolIndexById.get(item.toolUseId)
      if (index !== undefined) {
        const existing = rows[index] as Extract<ActivityRow, { type: 'tool' }>
        rows[index] = {
          type: 'tool',
          tool: {
            ...existing.tool,
            output: formatJson(item.content),
            isError: item.isError,
            status: 'complete',
          },
        }
      } else {
        toolIndexById.set(item.id, rows.length)
        rows.push({
          type: 'tool',
          tool: {
            id: item.id,
            name: 'Result',
            output: formatJson(item.content),
            isError: item.isError,
            status: 'complete',
          },
        })
      }
      continue
    }
    const tool = itemToToolDisplay(item)
    if (!tool) continue
    const existingIndex = toolIndexById.get(tool.id)
    if (existingIndex !== undefined) {
      rows[existingIndex] = { type: 'tool', tool }
    } else {
      toolIndexById.set(tool.id, rows.length)
      rows.push({ type: 'tool', tool })
    }
  }
  return rows
}

function activityTools(rows: ActivityRow[]): FreshAgentToolDisplay[] {
  return rows
    .filter((row): row is Extract<ActivityRow, { type: 'tool' }> => row.type === 'tool')
    .map((row) => row.tool)
}

const FILE_CHANGING_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

function countFilesChanged(tools: FreshAgentToolDisplay[]): number {
  const paths = new Set<string>()
  let anonymous = 0
  for (const tool of tools) {
    if (!FILE_CHANGING_TOOLS.has(tool.name)) continue
    const path = typeof tool.input?.file_path === 'string' ? tool.input.file_path : null
    if (path) paths.add(path)
    else anonymous += 1
  }
  return paths.size + anonymous
}

function settledSummary(rows: ActivityRow[]): string {
  const tools = activityTools(rows)
  const hasThinking = rows.some((row) => row.type === 'thinking')
  const filesChanged = countFilesChanged(tools)
  const parts: string[] = []
  if (hasThinking) parts.push('thought')
  if (tools.length > 0) parts.push(`${tools.length} tool${tools.length === 1 ? '' : 's'} used`)
  if (filesChanged > 0) parts.push(`${filesChanged} file${filesChanged === 1 ? '' : 's'} changed`)
  return parts.join(' · ') || 'thought'
}

type RenderBlock =
  | { kind: 'item'; item: FreshAgentTranscriptItem }
  | { kind: 'activity'; id: string; rows: ActivityRow[] }

function buildBlocks(
  items: FreshAgentTranscriptItem[],
  options: TranscriptDisplayOptions,
): RenderBlock[] {
  const blocks: RenderBlock[] = []
  let pending: FreshAgentTranscriptItem[] = []
  const flush = () => {
    if (pending.length === 0) return
    const rows = buildActivity(pending)
    if (rows.length > 0) {
      blocks.push({
        kind: 'activity',
        id: pending.map((item) => item.id).join(':'),
        rows,
      })
    }
    pending = []
  }
  for (const item of items) {
    if (!shouldDisplayTranscriptItem(item, options)) {
      continue
    }
    if (isActivityLike(item)) {
      pending.push(item)
      continue
    }
    flush()
    blocks.push({ kind: 'item', item })
  }
  flush()
  return blocks
}

function filterTurnsForDisplay(
  turns: FreshAgentTurn[],
  options: TranscriptDisplayOptions,
): FreshAgentTurn[] {
  return turns
    .map((turn) => {
      const items = turn.items.filter((item) => shouldDisplayTranscriptItem(item, options))
      if (turn.items.length > 0 && items.length === 0) return null
      return items === turn.items ? turn : { ...turn, items }
    })
    .filter((turn): turn is FreshAgentTurn => turn !== null)
}

function normalizeActivityRows(rows: ActivityRow[], live: boolean): ActivityRow[] {
  const runningToolIds = rows
    .filter((row): row is Extract<ActivityRow, { type: 'tool' }> => row.type === 'tool' && row.tool.status === 'running')
    .map((row) => row.tool.id)
  const activeRunningToolId = live ? (runningToolIds.at(-1) ?? null) : null

  let changed = false
  const settledRows = rows.map((row) => {
    if (
      row.type !== 'tool'
      || row.tool.status !== 'running'
      || row.tool.id === activeRunningToolId
    ) {
      return row
    }
    changed = true
    return {
      type: 'tool' as const,
      tool: {
        ...row.tool,
        status: 'complete' as const,
      },
    }
  })
  return changed ? settledRows : rows
}

function selectLiveActivityBlockId(
  turns: FreshAgentTurn[],
  isStreaming: boolean,
  options: TranscriptDisplayOptions,
): string | null {
  let latestActivityBlockId: string | null = null
  let latestTrailingThinkingBlockId: string | null = null

  turns.forEach((turn, turnIndex) => {
    const blocks = buildBlocks(turn.items, options)
    for (const block of blocks) {
      if (block.kind === 'activity') {
        latestActivityBlockId = block.id
      }
    }

    if (turnIndex === turns.length - 1) {
      const lastBlock = blocks[blocks.length - 1]
      if (lastBlock?.kind === 'activity' && lastBlock.rows.at(-1)?.type === 'thinking') {
        latestTrailingThinkingBlockId = lastBlock.id
      }
    }
  })

  if (isStreaming) return latestActivityBlockId
  return latestTrailingThinkingBlockId
}

function FreshAgentThinkingRow({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="fresh-agent-thinking-row my-0.5 border-l-2 border-l-[hsl(var(--primary))] text-xs">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="fresh-agent-thinking-trigger flex w-full items-center gap-2 rounded-r px-2 py-0.5 text-left transition-colors hover:bg-accent/50"
        aria-expanded={expanded}
        aria-label="Thinking"
      >
        <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', expanded && 'rotate-90')} />
        <span className="font-medium">Thinking</span>
      </button>
      {expanded ? (
        <div className="fresh-agent-thinking-body border-t border-border/50 px-2 py-1 text-sm text-muted-foreground">
          <FreshAgentMarkdownBody text={text} />
        </div>
      ) : null}
    </div>
  )
}

function FreshAgentActivityStrip({
  rows,
  live = false,
  initialExpanded = false,
}: {
  rows: ActivityRow[]
  live?: boolean
  initialExpanded?: boolean
}) {
  const [expanded, setExpanded] = useState(initialExpanded)
  useEffect(() => { setExpanded(initialExpanded) }, [initialExpanded])
  const displayRows = useMemo(() => (
    normalizeActivityRows(rows, live)
  ), [live, rows])
  const tools = activityTools(displayRows)
  const hasErrors = tools.some((tool) => tool.isError)
  const lastRow = displayRows[displayRows.length - 1] ?? null
  const runningTool = live ? [...tools].reverse().find((tool) => tool.status === 'running') ?? null : null
  const thinkingLive = live && lastRow?.type === 'thinking'
  const liveTool = !thinkingLive && live ? (tools[tools.length - 1] ?? null) : null
  const activeTool = runningTool ?? liveTool
  const running = live && (activeTool !== null || thinkingLive)

  if (displayRows.length === 0) return null

  const reelName = activeTool ? activeTool.name : thinkingLive ? 'Thinking' : null
  const reelPreview = activeTool ? getToolPreview(activeTool.name, activeTool.input) : null

  return (
    <div role="region" aria-label="Activity strip" className="fresh-agent-activity-strip my-0.5">
      {!expanded ? (
        <div
          className={cn(
            'fresh-agent-activity-summary flex min-w-0 items-center gap-1.5 border-l-2 px-2 py-0.5 text-xs',
            hasErrors ? 'border-l-[hsl(var(--destructive))]' : 'border-l-[hsl(var(--primary))]',
          )}
        >
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="shrink-0 rounded p-0.5 transition-colors hover:bg-accent/50"
            aria-label="Toggle activity details"
            aria-expanded={false}
          >
            <ChevronRight className="h-3 w-3" />
          </button>
          <span
            className="fresh-agent-activity-status-slot"
            data-testid="fresh-agent-activity-status-slot"
            aria-hidden={running ? undefined : true}
          >
            {running ? <Loader2 className="h-3 w-3 animate-spin" aria-label="running" /> : null}
          </span>
          <SlotReel
            toolName={running ? reelName : null}
            previewText={running ? reelPreview : null}
            settledText={running ? undefined : settledSummary(displayRows)}
          />
        </div>
      ) : (
        <div className="fresh-agent-activity-details">
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="ml-1.5 shrink-0 rounded p-0.5 transition-colors hover:bg-accent/50"
            aria-label="Toggle activity details"
            aria-expanded={true}
          >
            <ChevronRight className="h-3 w-3 rotate-90 transition-transform" />
          </button>
          {displayRows.map((row) => (
            row.type === 'thinking'
              ? <FreshAgentThinkingRow key={row.id} text={row.text} />
              : <FreshAgentToolBlock key={row.tool.id} tool={row.tool} initialExpanded={initialExpanded} />
          ))}
        </div>
      )}
    </div>
  )
}

type TurnActionProps = {
  canFork: boolean
  onForkFromTurn?: (turnId: string) => void
  onRewindToTurn?: (turn: FreshAgentTurn) => void
  onTurnContextMenu?: (event: React.MouseEvent, turn: FreshAgentTurn) => void
  /** Coarse-pointer path: open the bottom action sheet for this turn. */
  onOpenActions?: (turn: FreshAgentTurn) => void
}

function FreshAgentTurnArticle({
  turn,
  actions,
  agentLabel,
  showTimecodes,
  showTools,
  showHeader,
  continuation,
  liveActivityBlockId,
  displayOptions,
}: {
  turn: FreshAgentTurn
  actions: TurnActionProps
  agentLabel?: string
  showTimecodes: boolean
  showTools: boolean
  showHeader: boolean
  continuation: boolean
  liveActivityBlockId: string | null
  displayOptions: TranscriptDisplayOptions
}) {
  const isUser = turn.role === 'user'
  const blocks = buildBlocks(turn.items, displayOptions)
  const turnLabel = getTurnLabel(turn, agentLabel)
  const timecode = formatTurnTimecode(turn.timestamp)
  // Long-press opens the action sheet on touch devices (iOS fires no
  // contextmenu event; Android does — both paths land on onOpenActions and
  // the second call is a no-op re-set of the same state).
  const longPress = useMemo(() => (
    actions.onOpenActions
      ? buildLongPressHandlers<HTMLElement>(() => actions.onOpenActions?.(turn))
      : null
  ), [actions, turn])
  return (
    <article
      className={cn(
        'fresh-agent-turn group relative mt-3 w-full border-l-2 py-0.5 pl-2.5 pr-1 first:mt-0',
        isUser ? 'border-l-[hsl(var(--primary))]' : 'border-l-border',
        continuation && 'mt-1.5',
      )}
      data-turn-role={turn.role}
      data-turn-continuation={continuation ? 'true' : 'false'}
      aria-label={`${turnLabel} transcript turn`}
      onContextMenu={(event) => {
        // stopPropagation matters: freshell has a global contextmenu handler
        // that renders the app menu over ours otherwise (live-test finding).
        if (actions.onOpenActions) {
          event.preventDefault()
          event.stopPropagation()
          actions.onOpenActions(turn)
          return
        }
        if (!actions.onTurnContextMenu) return
        event.preventDefault()
        event.stopPropagation()
        actions.onTurnContextMenu(event, turn)
      }}
      {...(longPress ?? {})}
    >
      <FreshAgentTurnActions
        turn={turn}
        canFork={actions.canFork}
        onForkFromTurn={actions.onForkFromTurn}
        onRewindToTurn={actions.onRewindToTurn}
        onOpenActions={actions.onOpenActions}
      />
      {showHeader ? (
        <div className="fresh-agent-turn-header mb-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>{turnLabel}</span>
          {showTimecodes && (timecode || turn.model) ? (
            <span className="flex min-w-0 items-center gap-2">
              {timecode ? <time>{timecode}</time> : null}
              {turn.model ? <span className="truncate">{turn.model}</span> : null}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="fresh-agent-transcript-copy space-y-1.5">
        {blocks.length > 0 ? blocks.map((block) => {
          if (block.kind === 'activity') {
            return (
              <FreshAgentActivityStrip
                key={block.id}
                rows={block.rows}
                live={block.id === liveActivityBlockId}
                initialExpanded={showTools}
              />
            )
          }
          return <FreshAgentItemCard key={block.item.id} item={block.item} markdown={!isUser} />
        }) : isUser ? (
          <p className="whitespace-pre-wrap break-words leading-[inherit]">{stripSystemReminders(turn.summary)}</p>
        ) : (
          // Summary-only agent turns went through the plain-text path and
          // showed literal backticks (live-test finding) — render markdown.
          <FreshAgentMarkdownBody text={turn.summary ?? ''} />
        )}
      </div>
    </article>
  )
}

export function FreshAgentTranscript({
  turns,
  canFork = false,
  agentLabel,
  showModel = false,
  showThinking = true,
  showTools = false,
  showTimecodes,
  isStreaming = false,
  onForkFromTurn,
  onRewindToTurn,
  isInitialLoading = false,
  hasOlderHistory = false,
  isLoadingOlder = false,
  historyError,
  historyErrorActionLabel = 'Retry',
  onLoadOlder,
}: {
  turns: FreshAgentTurn[]
  canFork?: boolean
  agentLabel?: string
  showModel?: boolean
  showThinking?: boolean
  showTools?: boolean
  showTimecodes?: boolean
  isStreaming?: boolean
  onForkFromTurn?: (turnId: string) => void
  onRewindToTurn?: (turn: FreshAgentTurn) => void
  isInitialLoading?: boolean
  hasOlderHistory?: boolean
  isLoadingOlder?: boolean
  historyError?: string
  historyErrorActionLabel?: string
  onLoadOlder?: () => void | Promise<void>
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const layoutRef = useRef<{
    firstKey: string | null
    lastKey: string | null
    count: number
    scrollHeight: number
  } | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [newMessages, setNewMessages] = useState(0)
  const [contextMenu, setContextMenu] = useState<FreshAgentTurnContextMenuState>(null)
  const [sheetTurn, setSheetTurn] = useState<FreshAgentTurn | null>(null)
  const coarsePointer = useCoarsePointer()
  const resolvedShowTimecodes = showTimecodes ?? showModel
  const displayOptions = useMemo<TranscriptDisplayOptions>(() => ({
    showThinking,
  }), [showThinking])
  const displayTurns = useMemo(() => (
    filterTurnsForDisplay(turns, displayOptions)
  ), [displayOptions, turns])
  const displayTurnsRef = useRef(displayTurns)
  displayTurnsRef.current = displayTurns
  const liveActivityBlockId = useMemo(
    () => selectLiveActivityBlockId(displayTurns, isStreaming, displayOptions),
    [displayOptions, displayTurns, isStreaming],
  )
  const transcriptSignature = useMemo(() => (
    displayTurns.map((turn) => {
      const itemSignature = turn.items.map((item) => {
        if (item.kind === 'text' || item.kind === 'thinking') {
          return `${item.id}:${item.kind}:${item.text.length}`
        }
        if (item.kind === 'reasoning') {
          return `${item.id}:${item.kind}:${item.text?.length ?? 0}:${item.summary.join('\n').length}`
        }
        if ('status' in item) {
          return `${item.id}:${item.kind}:${item.status}`
        }
        if (item.kind === 'tool_result') {
          return `${item.id}:${item.kind}:${item.isError ? 'error' : 'ok'}:${formatJson(item.content).length}`
        }
        return `${item.id}:${item.kind}`
      }).join(',')
      return `${getFreshAgentDisplayTurnKey(turn)}:${turn.summary?.length ?? 0}:${itemSignature}`
    }).join('|')
  ), [displayTurns])

  const handleTurnContextMenu = useCallback((event: React.MouseEvent, turn: FreshAgentTurn) => {
    setContextMenu({ x: event.clientX, y: event.clientY, turn })
  }, [])

  const handleOpenActions = useCallback((turn: FreshAgentTurn) => {
    setSheetTurn(turn)
  }, [])

  const actions: TurnActionProps = useMemo(() => ({
    canFork,
    onForkFromTurn,
    onRewindToTurn,
    onTurnContextMenu: coarsePointer ? undefined : handleTurnContextMenu,
    onOpenActions: coarsePointer ? handleOpenActions : undefined,
  }), [canFork, coarsePointer, handleOpenActions, handleTurnContextMenu, onForkFromTurn, onRewindToTurn])

  const loadOlder = useCallback(() => {
    if (!hasOlderHistory || isLoadingOlder) return
    void onLoadOlder?.()
  }, [hasOlderHistory, isLoadingOlder, onLoadOlder])

  useLayoutEffect(() => {
    const node = scrollerRef.current
    if (!node) return
    const currentDisplayTurns = displayTurnsRef.current
    const firstKey = currentDisplayTurns[0] ? getFreshAgentDisplayTurnKey(currentDisplayTurns[0]) : null
    const lastKey = currentDisplayTurns.at(-1) ? getFreshAgentDisplayTurnKey(currentDisplayTurns.at(-1)!) : null
    const previous = layoutRef.current
    const prependedOlderHistory = Boolean(
      previous
        && firstKey !== previous.firstKey
        && lastKey === previous.lastKey
        && currentDisplayTurns.length > previous.count,
    )

    if (atBottom) {
      node.scrollTop = node.scrollHeight
      setNewMessages(0)
    } else if (prependedOlderHistory && previous) {
      node.scrollTop += node.scrollHeight - previous.scrollHeight
    } else {
      setNewMessages((count) => count + 1)
    }
    layoutRef.current = {
      firstKey,
      lastKey,
      count: currentDisplayTurns.length,
      scrollHeight: node.scrollHeight,
    }
  }, [atBottom, transcriptSignature])

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollerRef}
        className="fresh-agent-transcript-scroll flex h-full flex-col gap-0 overflow-x-hidden overflow-y-auto overscroll-contain px-3 py-3"
        data-context="fresh-agent-transcript"
        onScroll={(event) => {
          const node = event.currentTarget
          setAtBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 24)
          if (node.scrollTop < 48) loadOlder()
        }}
      >
        {hasOlderHistory || historyError ? (
          <div className="fresh-agent-history-controls sticky top-0 z-10 mb-2 flex justify-center py-1">
            {historyError ? (
              <div className="flex max-w-full items-center gap-2 rounded-md border border-destructive/50 bg-background px-3 py-1.5 text-xs text-destructive shadow-sm">
                <span className="truncate">{historyError}</span>
                {hasOlderHistory ? (
                  <button
                    type="button"
                    className="shrink-0 rounded border border-border/70 px-2 py-0.5 text-foreground"
                    onClick={loadOlder}
                  >
                    {historyErrorActionLabel}
                  </button>
                ) : null}
              </div>
            ) : (
              <button
                type="button"
                className="flex items-center gap-1 rounded-full border border-border bg-background px-3 py-1 text-xs shadow-sm"
                onClick={loadOlder}
                disabled={isLoadingOlder}
              >
                {isLoadingOlder ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : null}
                {isLoadingOlder ? 'Loading older' : 'Load older'}
              </button>
            )}
          </div>
        ) : null}
        {isInitialLoading && displayTurns.length === 0 ? (
          <div
            className="flex min-h-24 items-center justify-center gap-2 text-xs text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            <span>Restoring history</span>
          </div>
        ) : null}
        {displayTurns.map((turn, index) => (
          <FreshAgentTurnArticle
            key={`${getFreshAgentDisplayTurnKey(turn)}:${index}`}
            turn={turn}
            actions={actions}
            agentLabel={agentLabel}
            showTimecodes={resolvedShowTimecodes}
            showTools={showTools}
            showHeader={index === 0 || displayTurns[index - 1]?.role !== turn.role}
            continuation={index > 0 && displayTurns[index - 1]?.role === turn.role}
            liveActivityBlockId={liveActivityBlockId}
            displayOptions={displayOptions}
          />
        ))}
      </div>
      <FreshAgentTurnContextMenu
        state={contextMenu}
        canFork={canFork}
        onForkFromTurn={onForkFromTurn}
        onRewindToTurn={onRewindToTurn}
        onClose={() => setContextMenu(null)}
      />
      {sheetTurn ? (
        <FreshAgentActionSheet
          title={turnPlainText(sheetTurn).slice(0, 80) || getTurnLabel(sheetTurn, agentLabel)}
          items={buildTurnActionItems(sheetTurn, { canFork, onForkFromTurn, onRewindToTurn })}
          onClose={() => setSheetTurn(null)}
        />
      ) : null}
      {!atBottom ? (
        <button
          type="button"
          className="fresh-agent-scroll-bottom absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-background px-3 py-1 text-xs shadow"
          onClick={() => {
            const node = scrollerRef.current
            if (!node) return
            node.scrollTop = node.scrollHeight
            setAtBottom(true)
            setNewMessages(0)
          }}
          aria-label="Scroll to bottom"
        >
          <ChevronDown className="h-3 w-3" />
          {newMessages > 0 ? `${newMessages} new` : 'Bottom'}
        </button>
      ) : null}
    </div>
  )
}

export default memo(FreshAgentTranscript)
