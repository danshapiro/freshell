import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import SlotReel from '@/components/agent-chat/SlotReel'
import { getToolPreview } from '@/components/agent-chat/tool-preview'
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

function getTurnLabel(turn: FreshAgentTurn): string {
  switch (turn.role) {
    case 'user':
      return 'You'
    case 'assistant':
      return 'Assistant'
    case 'system':
      return 'System'
    case 'tool':
      return 'Tool'
    default:
      return 'Turn'
  }
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

function thinkingPreview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 64 ? `…${flat.slice(-60)}` : flat
}

type RenderBlock =
  | { kind: 'item'; item: FreshAgentTranscriptItem }
  | { kind: 'activity'; id: string; rows: ActivityRow[]; endsWithThinking: boolean }

function buildBlocks(items: FreshAgentTranscriptItem[]): RenderBlock[] {
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
        endsWithThinking: rows[rows.length - 1]?.type === 'thinking',
      })
    }
    pending = []
  }
  for (const item of items) {
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

function FreshAgentThinkingRow({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="my-0.5 border-l-2 border-l-[hsl(var(--primary))] text-xs">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 rounded-r px-2 py-0.5 text-left transition-colors hover:bg-accent/50"
        aria-expanded={expanded}
        aria-label="Thinking"
      >
        <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', expanded && 'rotate-90')} />
        <span className="font-medium">Thinking:</span>
        <span className="truncate italic text-muted-foreground">{thinkingPreview(text)}</span>
      </button>
      {expanded ? (
        <div className="border-t border-border/50 px-2 py-1 text-sm text-muted-foreground">
          <FreshAgentMarkdownBody text={text} />
        </div>
      ) : null}
    </div>
  )
}

function FreshAgentActivityStrip({
  rows,
  liveTrailingThinking = false,
}: {
  rows: ActivityRow[]
  liveTrailingThinking?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const tools = activityTools(rows)
  const hasErrors = tools.some((tool) => tool.isError)
  const lastRow = rows[rows.length - 1] ?? null
  const runningTool = [...tools].reverse().find((tool) => tool.status === 'running') ?? null
  const thinkingLive = liveTrailingThinking && lastRow?.type === 'thinking'
  const running = runningTool !== null || thinkingLive

  if (rows.length === 0) return null

  const reelName = runningTool ? runningTool.name : thinkingLive ? 'Thinking' : null
  const reelPreview = runningTool
    ? getToolPreview(runningTool.name, runningTool.input)
    : thinkingLive && lastRow?.type === 'thinking'
      ? thinkingPreview(lastRow.text)
      : null

  return (
    <div role="region" aria-label="Activity strip" className="my-0.5">
      {!expanded ? (
        <div
          className={cn(
            'flex min-w-0 items-center gap-1.5 border-l-2 px-2 py-0.5 text-xs',
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
            settledText={running ? undefined : settledSummary(rows)}
          />
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="ml-1.5 shrink-0 rounded p-0.5 transition-colors hover:bg-accent/50"
            aria-label="Toggle activity details"
            aria-expanded={true}
          >
            <ChevronRight className="h-3 w-3 rotate-90 transition-transform" />
          </button>
          {rows.map((row) => (
            row.type === 'thinking'
              ? <FreshAgentThinkingRow key={row.id} text={row.text} />
              : <FreshAgentToolBlock key={row.tool.id} tool={row.tool} initialExpanded={false} />
          ))}
        </>
      )}
    </div>
  )
}

function countTools(turn: FreshAgentTurn): number {
  return activityTools(buildActivity(turn.items.filter(isToolLike))).length
}

function getTurnSummary(turn: FreshAgentTurn): string {
  const text = turn.items
    .filter((item): item is Extract<FreshAgentTranscriptItem, { kind: 'text' }> => item.kind === 'text')
    .map((item) => stripSystemReminders(item.text))
    .join(' ')
    .trim()
    .replace(/\s+/g, ' ')
  const base = text || turn.summary || getTurnLabel(turn)
  const short = base.length > 44 ? `${base.slice(0, 41)}...` : base
  const toolCount = countTools(turn)
  const itemCount = turn.items.filter((item) => item.kind === 'text').length
  const parts: string[] = []
  if (toolCount > 0) parts.push(`${toolCount} tool${toolCount === 1 ? '' : 's'}`)
  if (itemCount > 0 && turn.role !== 'user') parts.push(`${itemCount} msg${itemCount === 1 ? '' : 's'}`)
  return parts.length > 0 ? `${short} -> ${parts.join(', ')}` : short
}

type TurnActionProps = {
  canFork: boolean
  onForkFromTurn?: (turnId: string) => void
  onRewindToTurn?: (turn: FreshAgentTurn) => void
  onTurnContextMenu?: (event: React.MouseEvent, turn: FreshAgentTurn) => void
  /** Coarse-pointer path: open the bottom action sheet for this turn. */
  onOpenActions?: (turn: FreshAgentTurn) => void
}

function CollapsedFreshAgentTurn({ turn, actions }: { turn: FreshAgentTurn; actions: TurnActionProps }) {
  const [expanded, setExpanded] = useState(false)
  const summary = getTurnSummary(turn)
  if (expanded) {
    return (
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={true}
          aria-label="Collapse turn"
        >
          <ChevronRight className="h-3 w-3 rotate-90 transition-transform" />
          <span className="truncate font-mono opacity-70">{summary}</span>
        </button>
        <FreshAgentTurnArticle turn={turn} compact={false} isLatest={false} actions={actions} />
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={() => setExpanded(true)}
      className="flex w-full items-center gap-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
      aria-expanded={false}
      aria-label="Expand turn"
    >
      <ChevronRight className="h-3 w-3 shrink-0 transition-transform" />
      <span className="truncate font-mono">{summary}</span>
    </button>
  )
}

function FreshAgentTurnArticle({
  turn,
  compact,
  isLatest,
  actions,
}: {
  turn: FreshAgentTurn
  compact: boolean
  isLatest: boolean
  actions: TurnActionProps
}) {
  const isUser = turn.role === 'user'
  const blocks = buildBlocks(turn.items)
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
        'group relative w-full border-l-2 py-0.5 pl-2.5 pr-1',
        isUser ? 'border-l-[hsl(var(--primary))]' : 'border-l-border',
        compact && 'opacity-95',
      )}
      aria-label={`${getTurnLabel(turn)} transcript turn`}
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
      <div className="mb-1 flex items-center justify-between gap-2 text-[11px] uppercase text-muted-foreground">
        <span>{getTurnLabel(turn)}</span>
        {turn.model ? <span className="truncate normal-case">{turn.model}</span> : null}
      </div>
      <div className="fresh-agent-transcript-copy space-y-1.5">
        {blocks.length > 0 ? blocks.map((block, blockIndex) => {
          if (block.kind === 'activity') {
            return (
              <FreshAgentActivityStrip
                key={block.id}
                rows={block.rows}
                liveTrailingThinking={isLatest && blockIndex === blocks.length - 1 && block.endsWithThinking}
              />
            )
          }
          return <FreshAgentItemCard key={block.item.id} item={block.item} markdown={!isUser} />
        }) : isUser ? (
          <p className="whitespace-pre-wrap break-words">{stripSystemReminders(turn.summary)}</p>
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
  onForkFromTurn,
  onRewindToTurn,
}: {
  turns: FreshAgentTurn[]
  canFork?: boolean
  onForkFromTurn?: (turnId: string) => void
  onRewindToTurn?: (turn: FreshAgentTurn) => void
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [newMessages, setNewMessages] = useState(0)
  const [contextMenu, setContextMenu] = useState<FreshAgentTurnContextMenuState>(null)
  const [sheetTurn, setSheetTurn] = useState<FreshAgentTurn | null>(null)
  const coarsePointer = useCoarsePointer()
  const transcriptSignature = useMemo(() => (
    turns.map((turn) => {
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
      return `${turn.id}:${turn.summary?.length ?? 0}:${itemSignature}`
    }).join('|')
  ), [turns])

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

  useEffect(() => {
    const node = scrollerRef.current
    if (!node) return
    if (atBottom) {
      node.scrollTop = node.scrollHeight
      setNewMessages(0)
    } else {
      setNewMessages((count) => count + 1)
    }
  }, [atBottom, transcriptSignature])

  const collapsedCutoff = Math.max(0, turns.length - 8)

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollerRef}
        className="flex h-full flex-col gap-3 overflow-x-hidden overflow-y-auto overscroll-contain px-3 py-3"
        data-context="fresh-agent-transcript"
        onScroll={(event) => {
          const node = event.currentTarget
          setAtBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 24)
        }}
      >
        {turns.map((turn, index) => (
          index < collapsedCutoff
            ? <CollapsedFreshAgentTurn key={turn.id} turn={turn} actions={actions} />
            : (
              <FreshAgentTurnArticle
                key={turn.id}
                turn={turn}
                compact={index < collapsedCutoff}
                isLatest={index === turns.length - 1}
                actions={actions}
              />
            )
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
          title={turnPlainText(sheetTurn).slice(0, 80) || getTurnLabel(sheetTurn)}
          items={buildTurnActionItems(sheetTurn, { canFork, onForkFromTurn, onRewindToTurn })}
          onClose={() => setSheetTurn(null)}
        />
      ) : null}
      {!atBottom ? (
        <button
          type="button"
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-background px-3 py-1 text-xs shadow"
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
