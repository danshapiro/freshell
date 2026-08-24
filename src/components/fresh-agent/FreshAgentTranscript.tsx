import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, ChevronUp, Loader2, X } from 'lucide-react'
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

type TurnLayout = { blocks: RenderBlock[] }

/** Mirrors FreshAgentItemCard's null-render path for text items: a text item
 * that renders nothing must not close an open line (nothing visibly between). */
function rendersVisibly(item: FreshAgentTranscriptItem): boolean {
  if (item.kind === 'text') return stripSystemReminders(item.text).trim().length > 0
  return true
}

/**
 * One OPEN activity line per transcript state: a next turn's leading
 * activity items append to the open line when the turn has the same role and
 * no message item has rendered between (a role change paints a header, so it
 * counts as "something between"). Lines are re-built from the concatenated
 * item list so buildActivity's tool_use/tool_result stitching stays intact.
 *
 * Line ids use a global per-layout sequence (`line:${n}`), NOT the origin turn
 * index: one turn can own two lines (`tool → text → tool`), and identical keys
 * would make React reuse state/DOM across what must stay two separate strips.
 * The key is stable while a line extends (no new line opens mid-extension), so
 * the strip keeps its DOM node — the "started in the right place" behavior.
 *
 * Zero-item turns (Rust codex `subAgentActivity` rows, opencode structural
 * messages) render real articles today, so they hard-close any open line —
 * they are "something between" by definition. Absorbed follower items get
 * display-only id dedupe (TS claude reuses item ids across turns sharing one
 * provider message id; stitching keys toolUseId, which is verified unique, so
 * stitching is unaffected — only React keys need this).
 */
/*
 * A non-empty turn summary is either an echo of one of the turn's own items
 * (codex builds tool-row summaries from the first item — `summarize_codex_items`
 * maps tool_use→name, command→command text, mcp_tool→"server:tool", etc.) or
 * authored content with no item counterpart (e.g. claude keeps thinking text as
 * the summary after a tool arrives, which the summary fallback paints while the
 * turn is still empty). Only the authored kind is "something between" the tool
 * runs: it can render, so the runs behind it are permanently separated — even
 * later, when blocks exist and the base fallback no longer paints the summary.
 * Echo summaries carry no extra rendering, so they never block a merge.
 */
const SUMMARY_LABEL_BY_KIND: Record<string, string> = {
  file_change: 'File change',
  context_compaction: 'Context compacted',
}
function itemEchoes(item: FreshAgentTranscriptItem): string[] {
  const echoes: string[] = []
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.trim().length > 0) echoes.push(value)
  }
  const rec = item as unknown as Record<string, unknown>
  push(rec.text)
  push(rec.name)
  push(rec.command)
  push(rec.query)
  push(rec.path)
  push(rec.tool)
  // Codex image_generation summarizes as its result (normalize.ts); live
  // claude summarizes a tool_result by its string content
  // (summarizeFreshAgentItems) — both are plain echoes of the item.
  push(rec.result)
  push(rec.content)
  if (typeof rec.server === 'string' && typeof rec.tool === 'string') {
    push(`${rec.server}:${rec.tool}`)
  }
  if (typeof rec.event === 'string') push(`${rec.event} review mode`)
  const joinStrings = (value: unknown) =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').join('\n') : ''
  push(joinStrings(rec.summary))
  push(joinStrings(rec.content))
  const kind = typeof rec.kind === 'string' ? rec.kind : ''
  push(SUMMARY_LABEL_BY_KIND[kind])
  if (kind === 'tool_result') {
    // TS normalizer: 'Tool result'/'Tool error'; Rust claude snapshot:
    // '[tool result]' (no error variant — claude_snapshot.rs).
    push(rec.isError === true ? 'Tool error' : 'Tool result')
    push('[tool result]')
  }
  return echoes
}

/**
 * A summary segment is an echo when it tiles completely from the turn's item
 * echoes joined by single spaces — the live claude summarizer space-joins
 * per-block summaries ('Read Read'), and codex truncates each block summary,
 * so the final tile may be a prefix of an echo.
 */
function segmentMatchesEchoes(segment: string, echoes: string[]): boolean {
  if (echoes.some((echo) => echo.includes(segment))) return true
  const n = segment.length
  const reachable: boolean[] = new Array(n + 1).fill(false)
  reachable[0] = true
  for (let i = 0; i < n; i++) {
    if (!reachable[i]) continue
    for (const echo of echoes) {
      if (segment.startsWith(echo, i)) {
        const end = i + echo.length
        if (end === n) reachable[n] = true
        else if (segment[end] === ' ') reachable[end + 1] = true
      }
      if (echo.length > n - i && echo.startsWith(segment.slice(i))) {
        reachable[n] = true
      }
    }
  }
  return reachable[n]
}

function summaryIsAuthoredContent(turn: DisplayTurn): boolean {
  const summary = typeof turn.summary === 'string' ? turn.summary : ''
  // Synthetic tool-result coalescing joins summaries with blank lines; judge
  // each segment against the turn's items independently.
  const segments = summary.split(/\n+/).map((segment) => segment.trim()).filter(Boolean)
  if (segments.length === 0) return false
  const sourceItems = turn.echoItems ?? turn.items
  if (sourceItems.length === 0) return true
  const echoes = sourceItems.flatMap((item) => itemEchoes(item))
  return segments.some((segment) => !segmentMatchesEchoes(segment, echoes))
}

function buildTranscriptLayout(
  turns: DisplayTurn[],
  paintedSummaryKeys: PaintedSummaryStore,
): {
  layouts: TurnLayout[]
  lineEndIndex: Map<number, number>
  tail: { blockId: string; turnIndex: number } | null
} {
  const layouts: TurnLayout[] = []
  let open: { originIndex: number; role: FreshAgentTurn['role']; items: FreshAgentTranscriptItem[] } | null = null
  const lineEndIndex = new Map<number, number>()
  let lineSeq = 0

  const flushOpen = () => {
    if (!open) return
    const rows = buildActivity(open.items)
    if (rows.length > 0) {
      const id = `line:${lineSeq++}`
      layouts[open.originIndex].blocks.push({ kind: 'activity', id, rows })
    }
    open = null
  }

  for (const [turnIndex, turn] of turns.entries()) {
    const layout: TurnLayout = { blocks: [] }
    layouts.push(layout)
    if (turn.items.length === 0) {
      flushOpen()
      continue
    }
    for (const item of turn.items) {
      if (isActivityLike(item)) {
        // The boundary guards apply only to absorbing into a PREVIOUS turn's
        // line. Once this turn has opened its own line, its later activity
        // items chain into it normally. Two cross-turn boundaries: an
        // authored summary (no echo among the turn's items), and a summary
        // this view already PAINTED — the echo verdict is recomputed from
        // current items each frame, so a painted summary that later gains an
        // echoing item must still hold its boundary or the lines
        // retro-collapse across content that rendered.
        if (
          open
          && open.role === turn.role
          && (
            open.originIndex === turnIndex
            || (!paintedSummaryMatches(paintedSummaryKeys, turn) && !summaryIsAuthoredContent(turn))
          )
        ) {
          const taken = new Set(open.items.map((openItem) => openItem.id))
          let displayItem = item
          let counter = 2
          while (taken.has(displayItem.id)) {
            displayItem = { ...item, id: `${item.id}:d${counter}` }
            counter += 1
          }
          open.items.push(displayItem as FreshAgentTranscriptItem)
          lineEndIndex.set(open.originIndex, turnIndex)
        } else {
          flushOpen()
          open = { originIndex: turnIndex, role: turn.role, items: [item] }
        }
        continue
      }
      if (!rendersVisibly(item)) {
        // Invisible content only. Same-role turns merge freely (nothing renders
        // between the lines). A different-role turn still paints its header, so
        // it closes the open line and keeps its (invisible-bodied) block,
        // matching the pre-change renderer's chrome.
        if (open && turn.role !== open.role) {
          flushOpen()
          layout.blocks.push({ kind: 'item', item })
        }
        continue
      }
      flushOpen()
      layout.blocks.push({ kind: 'item', item })
    }
  }
  flushOpen()

  // tail = last rendered block overall when it is an activity line; null when
  // the transcript visibly ends in a message.
  let tail: { blockId: string; turnIndex: number } | null = null
  for (let i = layouts.length - 1; i >= 0; i--) {
    const blocks = layouts[i].blocks
    if (blocks.length === 0) continue
    const last = blocks[blocks.length - 1]
    if (last.kind === 'activity') tail = { blockId: last.id, turnIndex: i }
    break
  }
  return { layouts, lineEndIndex, tail }
}

function isSyntheticToolResultTurn(turn: FreshAgentTurn): boolean {
  return turn.role === 'user'
    && turn.items.length > 0
    && turn.items.every((item) => item.kind === 'tool_result')
}

function appendTurnItems(previous: FreshAgentTurn, next: FreshAgentTurn): FreshAgentTurn {
  return {
    ...previous,
    id: `${previous.id}:${next.id}`,
    summary: [previous.summary, next.summary].filter(Boolean).join('\n\n'),
    items: [...previous.items, ...next.items],
    model: next.model ?? previous.model,
    timestamp: next.timestamp ?? previous.timestamp,
  }
}

function coalesceSyntheticToolResultTurns(turns: FreshAgentTurn[]): FreshAgentTurn[] {
  const coalesced: FreshAgentTurn[] = []
  for (const turn of turns) {
    const previous = coalesced[coalesced.length - 1]
    if (isSyntheticToolResultTurn(turn)) {
      if (previous?.role === 'assistant') {
        coalesced[coalesced.length - 1] = appendTurnItems(previous, turn)
      } else {
        coalesced.push({ ...turn, role: 'tool' })
      }
      continue
    }
    coalesced.push(turn)
  }
  return coalesced
}

/**
 * A turn whose items were all filtered out (e.g. hidden thinking with the
 * default showThinking=false) still painted its summary while it was the
 * streaming tail. That summary rendered between the surrounding tool runs,
 * so once the turn is superseded it must leave a permanent, invisible
 * boundary: dropping it outright would let the runs retro-collapse and the
 * rendered summary vanish after the fact. The placeholder keeps the layout
 * boundary (zero-item turns hard-close an open line) without rendering
 * anything — the hidden thinking text stays hidden.
 *
 * Permanence is scoped to what THIS mounted view actually painted: the
 * caller passes the keys of summaries rendered so far (recorded from the
 * render loop), so the boundary survives the busy→idle isStreaming flip and
 * every later frame, while a transcript mounted already-settled — where the
 * hidden summary never rendered — still collapses freely.
 */
type DisplayTurn = FreshAgentTurn & {
  filteredPlaceholder?: true
  /** Pre-filter items, attached when display filtering dropped any. Echo
   * classification judges the summary against everything the turn CONTAINS —
   * hidden thinking is part of production summaries (live: space-joined with
   * the tool name; Rust snapshot: the thinking text itself), and the summary
   * never renders when an activity block does, so hidden items must still
   * count as echoes or the common claude thinking→tool turn can never merge. */
  echoItems?: FreshAgentTranscriptItem[]
}

/**
 * Painted-summary identity: per-turnId list of summaries this view has
 * rendered for that turn. Two failure shapes pull in opposite directions and
 * this structure holds both:
 * - Streaming summaries GROW (accumulated OpenCode reasoning parts, etc.):
 *   'Considering' paints, then becomes 'Considering options'. Matching uses a
 *   prefix relation, so the grown summary still inherits its painted
 *   boundary (a painted boundary must be permanent across frames).
 * - Validated claude data permits duplicate display turnIds across JSONL
 *   rows: painting 'First thought' must not mark a different occurrence
 *   whose summary 'Second thought' never painted (no prefix relation).
 */
type PaintedSummaryStore = ReadonlyMap<string, readonly string[]>

function recordPaintedSummary(
  store: Map<string, string[]>,
  turn: Pick<FreshAgentTurn, 'turnId' | 'id' | 'summary'>,
): void {
  const summary = (turn.summary ?? '').trim()
  if (!summary) return
  const key = getFreshAgentDisplayTurnKey(turn)
  const list = store.get(key) ?? []
  if (!list.includes(summary)) list.push(summary)
  store.set(key, list)
}

function paintedSummaryMatches(
  store: PaintedSummaryStore,
  turn: Pick<FreshAgentTurn, 'turnId' | 'id' | 'summary'>,
): boolean {
  const summary = (turn.summary ?? '').trim()
  if (!summary) return false
  const painted = store.get(getFreshAgentDisplayTurnKey(turn))
  return painted?.some((p) => p === summary || p.startsWith(summary) || summary.startsWith(p)) ?? false
}

function filterTurnsForDisplay(
  turns: FreshAgentTurn[],
  options: TranscriptDisplayOptions,
  isStreaming: boolean,
  paintedSummaryKeys: PaintedSummaryStore,
): DisplayTurn[] {
  return turns
    .map((turn, index): DisplayTurn | null => {
      const items = turn.items.filter((item) => shouldDisplayTranscriptItem(item, options))
      if (turn.items.length > 0 && items.length === 0) {
        if (isStreaming && index === turns.length - 1) {
          return { ...turn, items: [] }
        }
        if (paintedSummaryMatches(paintedSummaryKeys, turn)) {
          return { ...turn, items: [], summary: '', filteredPlaceholder: true }
        }
        return null
      }
      if (items.length === turn.items.length) return turn
      return { ...turn, items, echoItems: turn.items }
    })
    .filter((turn): turn is DisplayTurn => turn !== null)
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

function selectLiveActivityBlockIdFromLayout(
  layouts: TurnLayout[],
  turns: FreshAgentTurn[],
  isStreaming: boolean,
  tail: { blockId: string; turnIndex: number } | null,
): string | null {
  let latestActivityBlockId: string | null = null
  layouts.forEach((layout) => {
    for (const block of layout.blocks) {
      if (block.kind === 'activity') latestActivityBlockId = block.id
    }
  })

  const lastIndex = turns.length - 1
  const lastTurn = turns[lastIndex]

  if (!isStreaming) {
    // Settled sessions mark only a trailing thinking strip as live. Mirror the
    // old last-turn rule; when the last turn was absorbed, its items live at
    // the tail of the latest line, so check that line instead.
    const blocks = lastIndex >= 0 ? layouts[lastIndex].blocks : []
    const lastBlock = blocks.length > 0 ? blocks[blocks.length - 1] : null
    const candidateId = lastBlock?.kind === 'activity'
      ? lastBlock.id
      : (lastTurn?.items.length ?? 0) > 0 && tail && tail.turnIndex < lastIndex
        ? tail.blockId
        : null
    if (!candidateId) return null
    const candidate = [...layouts.flatMap((l) => l.blocks)].find((b) => b.kind === 'activity' && b.id === candidateId)
    return candidate?.kind === 'activity' && candidate.rows.at(-1)?.type === 'thinking'
      ? candidate.id
      : null
  }

  if (lastTurn && lastTurn.items.length > 0) return latestActivityBlockId
  if (!lastTurn || !tail) return null
  // A summary-only last turn renders its own article (summary markdown plus
  // the injected live strip); handing liveness to the tail line would skip
  // that article and hide the summary. A rendered summary is a message — it
  // closes the line.
  if (lastTurn.summary && lastTurn.summary.trim().length > 0) return null

  // Last display turn streams with zero visible items: hand liveness to the
  // trailing line when nothing rendered between them (intermediate turns were
  // absorbed into that line; a zero-item or message intermediate is a real
  // boundary) and roles match the whole way across.
  const absorbedOnly = turns.slice(tail.turnIndex + 1, lastIndex)
    .every((turn, offset) =>
      turn.items.length > 0 && layouts[tail.turnIndex + 1 + offset].blocks.length === 0)
  if (absorbedOnly && turns[tail.turnIndex].role === lastTurn.role) {
    return tail.blockId
  }
  return null
}

function FreshAgentThinkingRow({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="fresh-agent-thinking-row my-0.5 text-xs">
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
  const singleToolExpand = tools.length === 1 && displayRows.length === 1
  const lastRow = displayRows[displayRows.length - 1] ?? null
  const runningTool = live ? [...tools].reverse().find((tool) => tool.status === 'running') ?? null : null
  const thinkingLive = live && lastRow?.type === 'thinking'
  const liveTool = !thinkingLive && live ? (tools[tools.length - 1] ?? null) : null
  const activeTool = runningTool ?? liveTool
  const running = live && (activeTool !== null || thinkingLive)

  if (displayRows.length === 0) {
    if (!live) return null
    return (
      <div role="region" aria-label="Activity strip" className="fresh-agent-activity-strip my-0.5">
        <div className="fresh-agent-activity-summary flex min-w-0 items-center gap-1.5 px-2 py-0.5 text-xs">
          <span
            className="fresh-agent-activity-status-slot"
            data-testid="fresh-agent-activity-status-slot"
          >
            <Loader2 className="h-3 w-3 animate-spin" aria-label="running" />
          </span>
          <SlotReel toolName={null} previewText={null} settledText={undefined} />
        </div>
      </div>
    )
  }

  const reelName = activeTool ? activeTool.name : thinkingLive ? 'Thinking' : null
  const reelPreview = activeTool ? getToolPreview(activeTool.name, activeTool.input) : null

  return (
    <div role="region" aria-label="Activity strip" className="fresh-agent-activity-strip my-0.5">
      {!expanded ? (
        <div
          className={cn(
            'fresh-agent-activity-summary flex min-w-0 items-center gap-1.5 px-2 py-0.5 text-xs',
            hasErrors && 'bg-destructive/10',
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
            aria-hidden={running || hasErrors ? undefined : true}
          >
            {running ? <Loader2 className="h-3 w-3 animate-spin" aria-label="running" /> : null}
            {!running && hasErrors ? <X className="h-3 w-3 text-destructive" aria-label="error" /> : null}
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
              : <FreshAgentToolBlock key={row.tool.id} tool={row.tool} initialExpanded={initialExpanded || singleToolExpand} />
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
  actionTurn,
  blocks,
  actions,
  agentLabel,
  showTimecodes,
  showTools,
  showHeader,
  continuation,
  liveActivityBlockId,
  isStreamingLastTurn,
  index,
}: {
  turn: FreshAgentTurn
  /** Turn the action affordances target — the line's LAST contributing turn
   * when this article's activity line absorbed later turns, else `turn`. */
  actionTurn: FreshAgentTurn
  blocks: RenderBlock[]
  actions: TurnActionProps
  agentLabel?: string
  showTimecodes: boolean
  showTools: boolean
  showHeader: boolean
  continuation: boolean
  liveActivityBlockId: string | null
  isStreamingLastTurn: boolean
  index: number
}) {
  const isUser = turn.role === 'user'
  const turnLabel = getTurnLabel(turn, agentLabel)
  const timecode = formatTurnTimecode(turn.timestamp)
  // Long-press opens the action sheet on touch devices (iOS fires no
  // contextmenu event; Android does — both paths land on onOpenActions and
  // the second call is a no-op re-set of the same state).
  const longPress = useMemo(() => (
    actions.onOpenActions
      ? buildLongPressHandlers<HTMLElement>(() => actions.onOpenActions?.(actionTurn))
      : null
  ), [actions, actionTurn])
  return (
    <article
      className={cn(
        'fresh-agent-turn group relative mt-3 w-full border-l-2 py-0.5 pl-2.5 pr-1 first:mt-0',
        isUser ? 'border-l-[hsl(var(--primary))]' : 'border-l-border',
        continuation && 'mt-1.5',
      )}
      data-turn-role={turn.role}
      data-turn-index={index}
      data-turn-continuation={continuation ? 'true' : 'false'}
      aria-label={`${turnLabel} transcript turn`}
      onContextMenu={(event) => {
        // stopPropagation matters: freshell has a global contextmenu handler
        // that renders the app menu over ours otherwise (live-test finding).
        if (actions.onOpenActions) {
          event.preventDefault()
          event.stopPropagation()
          actions.onOpenActions(actionTurn)
          return
        }
        if (!actions.onTurnContextMenu) return
        event.preventDefault()
        event.stopPropagation()
        actions.onTurnContextMenu(event, actionTurn)
      }}
      {...(longPress ?? {})}
    >
      <FreshAgentTurnActions
        turn={actionTurn}
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
        {isStreamingLastTurn && blocks.length === 0 && liveActivityBlockId === null ? (
          <FreshAgentActivityStrip rows={[]} live initialExpanded={showTools} />
        ) : null}
      </div>
    </article>
  )
}

const AT_BOTTOM_THRESHOLD = 24
const TRANSCRIPT_LINE_HEIGHT = 40
const TRANSCRIPT_PAGE_OVERLAP = 40

function computeAtBottom(node: HTMLElement): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight < AT_BOTTOM_THRESHOLD
}

export type FreshAgentTranscriptHandle = {
  scrollByLine: (direction: 1 | -1) => void
  scrollByPage: (direction: 1 | -1) => void
  scrollToTop: () => void
  scrollToBottom: () => void
}

export type FreshAgentTranscriptProps = {
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
}

export const FreshAgentTranscript = forwardRef<FreshAgentTranscriptHandle, FreshAgentTranscriptProps>(function FreshAgentTranscript({
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
}, ref) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [newMessages, setNewMessages] = useState(0)
  const [contextMenu, setContextMenu] = useState<FreshAgentTurnContextMenuState>(null)
  const [sheetTurn, setSheetTurn] = useState<FreshAgentTurn | null>(null)
  const [glomTarget, setGlomTarget] = useState<{ index: number; text: string } | null>(null)
  const coarsePointer = useCoarsePointer()
  const resolvedShowTimecodes = showTimecodes ?? showModel
  const displayOptions = useMemo<TranscriptDisplayOptions>(() => ({
    showThinking,
  }), [showThinking])
  // Keys of summaries this mounted view has actually painted (see the
  // recording effect below). Feeds the placeholder boundary so it survives
  // the busy→idle isStreaming flip without blocking settled-history merges.
  const paintedSummaryKeysRef = useRef<Map<string, string[]>>(new Map())
  const displayTurns = useMemo(() => (
    filterTurnsForDisplay(
      coalesceSyntheticToolResultTurns(turns),
      displayOptions,
      isStreaming,
      paintedSummaryKeysRef.current,
    )
  ), [displayOptions, turns, isStreaming])
  const { layouts: turnLayouts, lineEndIndex, tail } = useMemo(
    () => buildTranscriptLayout(displayTurns, paintedSummaryKeysRef.current),
    [displayTurns],
  )
  const liveActivityBlockId = useMemo(
    () => selectLiveActivityBlockIdFromLayout(turnLayouts, displayTurns, isStreaming, tail),
    [turnLayouts, displayTurns, isStreaming, tail],
  )
  // Record every zero-item summary that reached an article (mirrors the
  // render loop's skip conditions) so a later frame can leave a placeholder
  // boundary where the summary once painted.
  useEffect(() => {
    const painted = paintedSummaryKeysRef.current
    displayTurns.forEach((turn, index) => {
      if (turn.filteredPlaceholder || turn.items.length > 0) return
      if (typeof turn.summary !== 'string' || turn.summary.trim().length === 0) return
      const isLastStreaming = isStreaming && index === displayTurns.length - 1
      if (isLastStreaming && liveActivityBlockId !== null) return
      recordPaintedSummary(painted, turn)
    })
  }, [displayTurns, isStreaming, liveActivityBlockId])
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

  const recomputeGlom = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) {
      setGlomTarget(null)
      return
    }
    const scrollerTop = scroller.getBoundingClientRect().top
    const userTurnEls = scroller.querySelectorAll<HTMLElement>('[data-turn-role="user"]')
    let target: { index: number; text: string } | null = null
    userTurnEls.forEach((el) => {
      if (el.getBoundingClientRect().top < scrollerTop) {
        const indexAttr = el.getAttribute('data-turn-index')
        if (indexAttr == null) return
        const index = Number(indexAttr)
        if (Number.isNaN(index)) return
        const turn = displayTurns[index]
        if (!turn) return
        const text = turnPlainText(turn)
        if (!text) return
        target = { index, text }
      }
    })
    setGlomTarget(target)
  }, [displayTurns])

  const handleGlomClick = useCallback(() => {
    if (!glomTarget) return
    const scroller = scrollerRef.current
    if (!scroller) return
    const el = scroller.querySelector<HTMLElement>(`[data-turn-index="${glomTarget.index}"]`)
    el?.scrollIntoView?.({ block: 'start' })
  }, [glomTarget])

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

  useImperativeHandle(ref, () => ({
    scrollByLine: (direction) => {
      const node = scrollerRef.current
      if (!node) return
      node.scrollTop += direction * TRANSCRIPT_LINE_HEIGHT
      setAtBottom(computeAtBottom(node))
    },
    scrollByPage: (direction) => {
      const node = scrollerRef.current
      if (!node) return
      const delta = Math.max(1, node.clientHeight - TRANSCRIPT_PAGE_OVERLAP)
      node.scrollTop += direction * delta
      setAtBottom(computeAtBottom(node))
    },
    scrollToTop: () => {
      const node = scrollerRef.current
      if (!node) return
      node.scrollTop = 0
      setAtBottom(computeAtBottom(node))
    },
    scrollToBottom: () => {
      const node = scrollerRef.current
      if (!node) return
      node.scrollTop = node.scrollHeight
      setAtBottom(true)
      setNewMessages(0)
    },
  }), [])

  useLayoutEffect(() => {
    const node = scrollerRef.current
    if (!node) return
    if (atBottom) {
      node.scrollTop = node.scrollHeight
      setNewMessages(0)
    } else {
      setNewMessages((count) => count + 1)
    }
  }, [atBottom, transcriptSignature])

  useEffect(() => {
    recomputeGlom()
  }, [recomputeGlom, transcriptSignature])

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollerRef}
        className="fresh-agent-transcript-scroll flex h-full flex-col gap-0 overflow-x-hidden overflow-y-auto overscroll-contain px-3 py-3"
        data-context="fresh-agent-transcript"
        onScroll={(event) => {
          const node = event.currentTarget
          setAtBottom(computeAtBottom(node))
          recomputeGlom()
        }}
      >
        {displayTurns.map((turn, index) => {
          const blocksForTurn = turnLayouts[index]?.blocks ?? []
          const absorbed = turn.items.length > 0 && blocksForTurn.length === 0
          const isLastStreaming = isStreaming && index === displayTurns.length - 1
          if (absorbed) return null
          // Invisible boundary marker: painted its summary as the streaming
          // tail, now superseded — it separates lines but renders nothing.
          if (turn.filteredPlaceholder) return null
          if (isLastStreaming && blocksForTurn.length === 0 && turn.items.length === 0 && liveActivityBlockId !== null) return null
          // Fork/rewind/copy resolve to the article line's LAST contributing turn
          // (the most recent point the line covers), so the existing "fork from
          // the latest activity turn" protection survives merging.
          const actionTurn = displayTurns[lineEndIndex.get(index) ?? index]
          return (
            <FreshAgentTurnArticle
              key={`${getFreshAgentDisplayTurnKey(turn)}:${index}`}
              turn={turn}
              actionTurn={actionTurn}
              blocks={blocksForTurn}
              actions={actions}
              agentLabel={agentLabel}
              showTimecodes={resolvedShowTimecodes}
              showTools={showTools}
              showHeader={index === 0 || displayTurns[index - 1]?.role !== turn.role}
              continuation={index > 0 && displayTurns[index - 1]?.role === turn.role}
              liveActivityBlockId={liveActivityBlockId}
              isStreamingLastTurn={isLastStreaming}
              index={index}
            />
          )
        })}
      </div>
      {glomTarget ? (
        <button
          type="button"
          className="fresh-agent-glom-chip absolute left-3 right-3 top-0 z-20 flex items-center gap-1.5 overflow-hidden border-b border-border bg-background/95 px-2 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur"
          onClick={handleGlomClick}
          aria-label={`Jump to your message: ${glomTarget.text}`}
          title={glomTarget.text}
        >
          <ChevronUp className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{glomTarget.text}</span>
        </button>
      ) : null}
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
})

export default memo(FreshAgentTranscript)
