import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, ChevronUp, Loader2, Redo2, X } from 'lucide-react'
import SlotReel from '@/components/fresh-agent/shared/SlotReel'
import { formatThoughtDuration } from '@/components/fresh-agent/shared/format-duration'
import { getToolPreview } from '@/components/fresh-agent/shared/tool-preview'
import { cn } from '@/lib/utils'
import type { FreshAgentTranscriptItem, FreshAgentTurn } from '@shared/fresh-agent-contract'
import {
  FreshAgentDelegationBlock,
  FreshAgentItemCard,
  FreshAgentMarkdownBody,
  FreshAgentRetryRow,
  FreshAgentToolBlock,
  itemToToolDisplay,
  stripSystemReminders,
  type FreshAgentToolDisplay,
} from './FreshAgentItemCard'
import {
  buildTurnActionItems,
  FreshAgentTurnActions,
  turnPlainText,
} from './FreshAgentTurnActions'
import { FreshAgentActionSheet } from './FreshAgentActionSheet'
import { FreshAgentTranscriptMinimap } from './FreshAgentTranscriptMinimap'
import { deriveGlomTarget, measureTranscriptUserTurns, type TranscriptMeasurement } from './shared/transcript-measurement'
import { registerFreshAgentTurnItems } from '@/lib/pane-action-registry'
import { buildLongPressHandlers, useCoarsePointer } from '@/lib/pointer'
import { getFreshAgentDisplayTurnKey, turnSummaryIsAuthored } from '@shared/fresh-agent-turns'

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
  // Malformed provider timestamps render no timecode at all — a raw
  // passthrough could leak seconds or a UTC "Z" suffix.
  if (Number.isNaN(date.getTime())) return null
  // Local time, h:mm AM/PM, no seconds (hour12 pins the meridiem even in
  // 24-hour-default locales).
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true })
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
    || item.kind === 'task_delegation'
}

/**
 * Thinking and reasoning roll through the activity strip alongside tools, so a
 * working turn occupies one line instead of stacking disclosures down the pane.
 * Retries are activity-like too — they render the strip's own muted row, never
 * a tool block.
 */
function isActivityLike(item: FreshAgentTranscriptItem): boolean {
  return isToolLike(item) || item.kind === 'thinking' || item.kind === 'reasoning' || item.kind === 'retry'
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
  | { type: 'thinking'; id: string; text: string; durationMs?: number; title?: string }
  | { type: 'tool'; tool: FreshAgentToolDisplay }
  | { type: 'delegation'; id: string; item: Extract<FreshAgentTranscriptItem, { kind: 'task_delegation' }>; tool: FreshAgentToolDisplay }
  | { type: 'retry'; id: string; attempt: number; error?: string }
  | { type: 'caption'; id: string; text: string }

function buildActivity(
  items: FreshAgentTranscriptItem[],
  captions: LineCaption[] = [],
): ActivityRow[] {
  const rows: ActivityRow[] = []
  // First item index that produced each row (tool_use/tool_result stitching and
  // thinking merges keep the FIRST contributing item's index) so captions
  // interleave at the position where they painted.
  const rowStartItemIndexes: number[] = []
  const toolIndexById = new Map<string, number>()
  // Providers stream thinking in chunks; consecutive thinking/reasoning items
  // merge into one row instead of stacking N "Thinking:" fragments. A row
  // survives even with empty text when it carries a TITLE: a streaming
  // `**Planning**` heading arrives before its body, and dropping it would leave
  // the live strip on the unnamed spinner instead of the Thinking behavior.
  const pushThinking = (row: { id: string; text: string; durationMs?: number; title?: string }, itemIndex: number) => {
    if (!row.text && row.title === undefined) return
    const last = rows[rows.length - 1]
    if (last?.type === 'thinking') {
      rows[rows.length - 1] = {
        ...last,
        text: row.text && last.text ? `${last.text}\n\n${row.text}` : (row.text || last.text),
        durationMs: row.durationMs !== undefined ? row.durationMs : last.durationMs,
        title: row.title !== undefined ? row.title : last.title,
      }
      return
    }
    rowStartItemIndexes.push(itemIndex)
    rows.push({ type: 'thinking', ...row })
  }
  for (const [itemIndex, item] of items.entries()) {
    if (item.kind === 'thinking') {
      pushThinking({ id: item.id, text: stripSystemReminders(item.text) }, itemIndex)
      continue
    }
    if (item.kind === 'reasoning') {
      pushThinking({
        id: item.id,
        text: item.summary.length > 0 ? item.summary.join('\n') : (item.text ?? ''),
        durationMs: item.durationMs,
        title: item.title,
      }, itemIndex)
      continue
    }
    if (item.kind === 'task_delegation') {
      rowStartItemIndexes.push(itemIndex)
      rows.push({
        type: 'delegation',
        id: item.id,
        item,
        tool: {
          id: item.id,
          name: 'Task',
          previewOverride: item.title,
          output: item.result,
          isError: item.status === 'failed',
          status: item.status === 'running' ? 'running' : 'complete',
        },
      })
      continue
    }
    if (item.kind === 'retry') {
      rowStartItemIndexes.push(itemIndex)
      rows.push({ type: 'retry', id: item.id, attempt: item.attempt, error: item.error })
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
        rowStartItemIndexes.push(itemIndex)
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
      rowStartItemIndexes.push(itemIndex)
      rows.push({ type: 'tool', tool })
    }
  }
  if (captions.length === 0) return rows
  const withCaptions: ActivityRow[] = []
  const ordered = [...captions].sort((a, b) => a.atItemIndex - b.atItemIndex)
  let captionIndex = 0
  for (const [rowIndex, row] of rows.entries()) {
    while (
      captionIndex < ordered.length
      && ordered[captionIndex].atItemIndex <= rowStartItemIndexes[rowIndex]
    ) {
      withCaptions.push({ type: 'caption', id: ordered[captionIndex].id, text: ordered[captionIndex].text })
      captionIndex += 1
    }
    withCaptions.push(row)
  }
  for (; captionIndex < ordered.length; captionIndex++) {
    withCaptions.push({ type: 'caption', id: ordered[captionIndex].id, text: ordered[captionIndex].text })
  }
  return withCaptions
}

function activityTools(rows: ActivityRow[]): FreshAgentToolDisplay[] {
  // Delegation rows contribute their tool display so settledSummary counts a
  // delegation as a used tool and hasErrors sees its isError.
  return rows.flatMap((row) => (
    row.type === 'tool' || row.type === 'delegation' ? [row.tool] : []
  ))
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
 * they are "something between" by definition. No Rust producer emits a
 * zero-item turn with a non-blank summary (LB-4), so a zero-item turn never
 * folds ITS OWN caption — but the close itself is a later-activity boundary:
 * it supersedes the closing line's last member, whose gated caption folds
 * into THAT LINE's expansion (never cross-line). The supersession stash is
 * the only fold source; the final open line's last member paints in-stream
 * instead (the tail caption). Absorbed follower items get
 * display-only id dedupe (TS claude reuses item ids across turns sharing one
 * provider message id; stitching keys toolUseId, which is verified unique, so
 * stitching is unaffected — only React keys need this).
 */
/** One gated echo caption, positioned by the line's ITEM index where its turn entered. */
type LineCaption = { id: string; text: string; atItemIndex: number }

/** A turn that materially contributes items to an activity line. */
type LineMember = { turnIndex: number; atItemIndex: number; caption: LineCaption | null }

function buildTranscriptLayout(
  turns: FreshAgentTurn[],
): {
  layouts: TurnLayout[]
  lineEndIndex: Map<number, number>
  tail: { blockId: string; turnIndex: number } | null
  tailCaption: LineCaption | null
} {
  const layouts: TurnLayout[] = []
  let open: {
    originIndex: number
    role: FreshAgentTurn['role']
    items: FreshAgentTranscriptItem[]
    members: LineMember[]
    captions: LineCaption[]
  } | null = null
  const lineEndIndex = new Map<number, number>()
  let lineSeq = 0
  let captionSeq = 0
  let tailCaption: LineCaption | null = null

  /** echo AND non-blank — the one gate for paint and stash. Sanitize BEFORE
   * the blank gate (delta review R1-F1): both caption copies (painted tail,
   * stashed expansion) render this string verbatim, so the summary must pass
   * the same stripSystemReminders sanitation the text/thinking/
   * summary-fallback render paths use. A reminder-only summary strips to ''
   * → gated out → neither copy paints anything. Authored summaries stay
   * painted as prose and never fold. */
  const foldCaption = (turn: FreshAgentTurn, atItemIndex: number): LineCaption | null => {
    const text = stripSystemReminders(turn.summary ?? '').trim()
    if (text.length === 0 || turnSummaryIsAuthored(turn)) return null
    const id = `caption:${captionSeq++}`
    return { id, text, atItemIndex }
  }

  const flushOpen = (stashLastMember: boolean, transferTurnIndex?: number) => {
    if (!open) return
    // Every superseded member's pre-gated caption folds into the expansion.
    // The LAST member stashes only when a later visible turn superseded it
    // (stashLastMember) — otherwise its caption paints in-stream via
    // tailCaption and must not double-render here. `transferTurnIndex` skips
    // the closing boundary's OWN turn when that turn has more activity items
    // coming: a multi-line turn ([tool, text, tool], claude/opencode both
    // interleave them) would otherwise stash its caption into the first line
    // AND paint it again after the second — violating the one-caption/one-place
    // invariant (fresh-eyes round 3, Finding 1). Transferred captions are
    // re-created by the turn's next line-open member record.
    const stash = (stashLastMember ? open.members : open.members.slice(0, -1))
      .filter((member) => member.turnIndex !== transferTurnIndex)
    for (const member of stash) {
      if (member.caption) open.captions.push(member.caption)
    }
    const rows = buildActivity(open.items, open.captions)
    if (rows.length > 0) {
      const id = `line:${lineSeq++}`
      layouts[open.originIndex].blocks.push({ kind: 'activity', id, rows })
    }
    if (!stashLastMember) {
      tailCaption = open.members.at(-1)?.caption ?? null
    }
    open = null
  }

  for (const [turnIndex, turn] of turns.entries()) {
    const layout: TurnLayout = { blocks: [] }
    layouts.push(layout)
    if (turn.error) {
      // LB-2 (stage-2 binding): an errored turn is a hard activity-line
      // boundary. Its durable module renders in its own article, so its
      // activity items must never be absorbed into a previous assistant's
      // open line — absorbed turns get no blocks and the render loop below
      // skips them entirely.
      flushOpen(true)
    }
    if (turn.items.length === 0) {
      // Zero-item turns hard-close any open line and render their own article;
      // they never carry a caption OF THEIR OWN (no Rust producer emits a
      // zero-item turn with a non-blank summary, LB-4). The close itself is a
      // later-activity boundary: it supersedes the closing line's last member,
      // whose gated caption folds into the closing line's expansion.
      flushOpen(true)
      continue
    }
    for (const [itemIndex, item] of turn.items.entries()) {
      if (isActivityLike(item)) {
        // The boundary guard applies only to absorbing into a PREVIOUS turn's
        // line. Once this turn has opened its own line, its later activity
        // items chain into it normally. A non-blank AUTHORED summary (or an
        // untagged one — conservative) is "something between": it can render,
        // so the runs behind it are permanently separated. Blank and
        // echo-tagged summaries carry no extra rendering and never block a
        // merge. (The `?? ''` is defensive — the zod schema requires `summary`
        // on the wire, but ported fixtures may omit it.)
        if (
          open
          && open.role === turn.role
          && (
            open.originIndex === turnIndex
            || (turn.summary ?? '').trim().length === 0
            || !turnSummaryIsAuthored(turn)
          )
        ) {
          // Record the turn as a member once, at its first activity item —
          // Task 4's stash anchors the member's caption there.
          if (open.originIndex !== turnIndex && !open.members.some((m) => m.turnIndex === turnIndex)) {
            open.members.push({ turnIndex, atItemIndex: open.items.length, caption: foldCaption(turn, open.items.length) })
          }
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
          flushOpen(true)
          open = { originIndex: turnIndex, role: turn.role, items: [item], members: [{ turnIndex, atItemIndex: 0, caption: foldCaption(turn, 0) }], captions: [] }
        }
        continue
      }
      if (!rendersVisibly(item)) {
        // Invisible content only. Same-role turns merge freely (nothing renders
        // between the lines). A different-role turn still paints its header, so
        // it closes the open line and keeps its (invisible-bodied) block,
        // matching the pre-change renderer's chrome.
        if (open && turn.role !== open.role) {
          flushOpen(true)
          layout.blocks.push({ kind: 'item', item })
        }
        continue
      }
      // Visible content closes the open line. When the CLOSING turn has more
      // activity items coming ([tool, text, tool] — claude/opencode interleave),
      // its caption transfers to the turn's next line instead of stashing here:
      // stashing now plus re-painting after the next line-open would duplicate
      // the same turn summary in one frame.
      const hasLaterActivity = turn.items.slice(itemIndex + 1).some(isActivityLike)
      flushOpen(true, hasLaterActivity ? turnIndex : undefined)
      layout.blocks.push({ kind: 'item', item })
    }
  }
  // The final open line's LAST member is not superseded: its pre-gated
  // caption paints in-stream as the transcript tail (while streaming and
  // after the session settles — the caption stays until later activity
  // supersedes it). `flushOpen(false)` stashes the SUPERSEDED members'
  // captions into the line and yields the last member's caption as tailCaption.
  flushOpen(false)

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
  return { layouts, lineEndIndex, tail, tailCaption }
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
    // Echo only when BOTH sides are echo: an authored segment must never be
    // laundered into a foldable caption, and an untagged side is conservative.
    summaryKind: previous.summaryKind === 'echo' && next.summaryKind === 'echo' ? 'echo' : 'authored',
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
    if (candidate?.kind !== 'activity') return null
    // Settled liveness judges the last NON-caption row: caption rows are fold
    // artifacts, not activity, so a trailing caption must not hide a thinking
    // row that settles the strip live.
    const contentRows = candidate.rows.filter((row) => row.type !== 'caption')
    return contentRows.at(-1)?.type === 'thinking' ? candidate.id : null
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

function FreshAgentThinkingRow({ text, durationMs, title, expanded, onToggle }: {
  text: string
  durationMs?: number
  title?: string
  expanded: boolean
  onToggle: () => void
}) {
  // Settled reasoning rows carry their wire duration (opencode thought parts):
  // `Thought · 3.4s`, or `Thought: <topic> · <duration>` with a disclosure
  // title. Rows without a duration keep the plain streaming "Thinking" label.
  // The button's aria-label MUST equal the visible label.
  const label = durationMs !== undefined
    ? `Thought${title ? `: ${title}` : ''} · ${formatThoughtDuration(durationMs)}`
    : 'Thinking'
  // Controlled/presentational: the expansion state lives in the owning
  // FreshAgentActivityStrip, which never unmounts across the collapsed/
  // expanded branch swap — so a user's toggle survives the strip toggle.
  return (
    <div className="fresh-agent-thinking-row my-0.5 text-xs">
      <button
        type="button"
        onClick={onToggle}
        className="fresh-agent-thinking-trigger flex w-full items-center gap-2 rounded-r px-2 py-0.5 text-left transition-colors hover:bg-accent/50"
        aria-expanded={expanded}
        aria-label={label}
      >
        <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', expanded && 'rotate-90')} />
        <span className="font-medium">{label}</span>
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
  expandThinking = false,
}: {
  rows: ActivityRow[]
  live?: boolean
  /** Strip's starting state — mount-only ("Expand tools"): a live settings
   * flip never stomps a mounted strip's in-pane expansion/collapse. */
  initialExpanded?: boolean
  /** Thinking rows' starting state ("Expand thinking"). */
  expandThinking?: boolean
}) {
  // Mount-only, matching FreshAgentToolBlock and the thinking-row default
  // below: the settings control only whether things START expanded; a live
  // settings flip never stomps in-pane toggles.
  const [expanded, setExpanded] = useState(initialExpanded)
  // "Expand thinking" captured at strip mount — the per-row default. Untouched
  // rows follow it for the strip's lifetime; user-touched rows keep their
  // override in thinkingExpandedById.
  const [initialThinkingExpanded] = useState(expandThinking)
  // Per-row expansion overrides live HERE, not in the row: the strip never
  // unmounts across the collapsed/expanded branch swap (only its children
  // swap), so the overrides survive the tool-disclosure toggle — the row
  // itself remounts, controlled and stateless.
  const [thinkingExpandedById, setThinkingExpandedById] = useState<Record<string, boolean>>({})
  const displayRows = useMemo(() => (
    normalizeActivityRows(rows, live)
  ), [live, rows])
  const tools = activityTools(displayRows)
  const hasErrors = tools.some((tool) => tool.isError)
  const singleToolExpand = tools.length === 1 && displayRows.length === 1
  // Liveness judges the last NON-caption row: a caption positioned after a
  // merged thinking row must not kill thinkingLive/the spinner.
  const lastRow = [...displayRows].reverse().find((row) => row.type !== 'caption') ?? null
  const thinkingLive = live && lastRow?.type === 'thinking'
  // runningTool is NOT gated on `live`: a task_delegation display whose status
  // is 'running' (background child active, server-joined) is live information
  // even while the parent session is idle — background children outlive the
  // parent turn. normalizeActivityRows only settles type:'tool' rows, so a
  // running delegation survives an idle strip.
  const runningTool = [...tools].reverse().find((tool) => tool.status === 'running') ?? null
  // A trailing retry IS the running thing while the turn streams between
  // attempts; a settled tool display must not mask it (LB-4).
  const retryLast = live && lastRow?.type === 'retry' ? lastRow : null
  const liveTool = !thinkingLive && live && !runningTool && !retryLast ? (tools[tools.length - 1] ?? null) : null
  const activeTool = runningTool ?? liveTool
  const reelName = retryLast ? 'Retrying' : activeTool ? activeTool.name : thinkingLive ? 'Thinking' : null
  const reelPreview = retryLast
    ? `attempt ${retryLast.attempt}`
    : activeTool
      ? (activeTool.previewOverride ?? getToolPreview(activeTool.name, activeTool.input))
      : null
  const running = (live && (activeTool !== null || thinkingLive || retryLast !== null)) || runningTool !== null

  const thinkingRows = displayRows.filter((row): row is Extract<ActivityRow, { type: 'thinking' }> => row.type === 'thinking')

  const renderThinkingRow = (row: Extract<ActivityRow, { type: 'thinking' }>) => (
    <FreshAgentThinkingRow
      key={row.id}
      text={row.text}
      durationMs={row.durationMs}
      title={row.title}
      expanded={thinkingExpandedById[row.id] ?? initialThinkingExpanded}
      onToggle={() => setThinkingExpandedById((prev) => ({
        ...prev,
        [row.id]: !(prev[row.id] ?? initialThinkingExpanded),
      }))}
    />
  )

  // One renderer per activity-row type (keys are per-type: captions, thinking,
  // delegations and retries key on their row/item id, tool rows on the tool
  // display id). The thinking-row expansion override stays owned by the strip
  // via renderThinkingRow/thinkingExpandedById.
  const renderActivityRow = (row: ActivityRow) => {
    if (row.type === 'caption') {
      // Non-interactive text — a folded echo caption needs no role/tabIndex.
      return (
        <div
          key={row.id}
          data-testid="fresh-agent-activity-caption"
          className="fresh-agent-activity-caption my-0.5 px-2 py-0.5 text-xs italic text-muted-foreground"
        >
          {row.text}
        </div>
      )
    }
    if (row.type === 'thinking') return renderThinkingRow(row)
    if (row.type === 'delegation') {
      return <FreshAgentDelegationBlock key={row.id} item={row.item} />
    }
    if (row.type === 'retry') {
      return <FreshAgentRetryRow key={row.id} attempt={row.attempt} error={row.error} />
    }
    return <FreshAgentToolBlock key={row.tool.id} tool={row.tool} initialExpanded={initialExpanded || singleToolExpand} />
  }

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

  return (
    <div role="region" aria-label="Activity strip" className="fresh-agent-activity-strip my-0.5">
      {!expanded ? (
        <>
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
          {/* Hoisted thinking rows: on a thinking-only line, every thinking
            * row — including LIVE rows mid-stream — renders its own
            * expandable disclosure under the summary. On a line that used
            * tools, the collapsed view is the single summary line alone:
            * the 'thought' segment carries the thinking, and the rows are
            * reachable by expanding the strip's tool disclosure (where
            * they render in item order). */}
          {tools.length === 0 ? thinkingRows.map(renderThinkingRow) : null}
        </>
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
          {displayRows.map(renderActivityRow)}
        </div>
      )}
    </div>
  )
}

type TurnActionProps = {
  canFork: boolean
  onForkFromTurn?: (turnId: string) => void
  onRewindToTurn?: (turn: FreshAgentTurn) => void
  /** kata 1wxv: the per-turn "undo to here" affordance (decision 3). */
  canRollback?: boolean
  rollbackBusy?: boolean
  onRollbackToTurn?: (turnId: string) => void
  /** Coarse-pointer path: open the bottom action sheet for this turn. */
  onOpenActions?: (turn: FreshAgentTurn) => void
}

/**
 * Build the per-article long-press bundle: the raw `buildLongPressHandlers`
 * product with `notifyOverlayOpened` split out of the DOM spread (it is not a
 * DOM handler — React warns on unknown DOM props). The wrapper also gives the
 * transcript a concrete, non-generic `ReturnType` for the ref-persisted
 * instance below.
 */
function buildTurnLongPress(onLongPress: () => void) {
  const { notifyOverlayOpened, ...handlers } = buildLongPressHandlers<HTMLElement>(onLongPress)
  return { handlers, notifyOverlayOpened }
}

function FreshAgentTurnArticle({
  turn,
  actionTurn,
  blocks,
  actions,
  agentLabel,
  showTimecodes,
  expandThinking,
  expandTools,
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
  expandThinking: boolean
  expandTools: boolean
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
  //
  // Gesture state must survive transcript rerenders: live snapshot refreshes
  // rebuild `actions` with fresh identities on ordinary rerenders, and
  // rebuilding the closure mid-gesture would orphan the armed timer and the
  // release-suppression flag — the DOM would then call the NEW closure's
  // onTouchEnd while the OLD closure held the state. The builder is therefore
  // created at most once per mounted article and reads the LATEST handler and
  // turn through refs, so gesture state persists while behavior stays current.
  const openActionsRef = useRef(actions.onOpenActions)
  openActionsRef.current = actions.onOpenActions
  const actionTurnRef = useRef(actionTurn)
  actionTurnRef.current = actionTurn
  const longPressRef = useRef<ReturnType<typeof buildTurnLongPress> | null>(null)
  if (longPressRef.current === null && actions.onOpenActions) {
    longPressRef.current = buildTurnLongPress(() => {
      openActionsRef.current?.(actionTurnRef.current)
    })
  }
  // Spread + ownership marker key off the CURRENT render's availability: a
  // coarse→fine pointer flip stops advertising/handling long-press even though
  // the instance persists for the article's lifetime.
  const longPress = actions.onOpenActions ? longPressRef.current : null
  return (
    <article
      className={cn(
        'fresh-agent-turn group relative mt-3 w-full border-l-2 py-0.5 pl-2.5 pr-1 first:mt-0',
        isUser ? 'border-l-[hsl(var(--primary))]' : 'border-l-border',
        continuation && 'mt-1.5',
      )}
      data-turn-role={turn.role}
      // Load-bearing beyond the glom chip: the global ContextMenuProvider's
      // fresh-agent menu reads this index at right-click time and resolves
      // the action turn through the pane-registered builder below.
      data-turn-index={index}
      data-turn-continuation={continuation ? 'true' : 'false'}
      // Ownership marker for the global ContextMenuProvider: present exactly
      // when this article's own long-press handlers exist (coarse pointers),
      // so the provider skips its long-press/probe path for turn gestures.
      // Fine pointers (incl. hybrid iPad+trackpad) never set it and keep the
      // provider's long-press fallback.
      data-longpress-owned={longPress ? 'true' : undefined}
      aria-label={`${turnLabel} transcript turn`}
      onContextMenu={(event) => {
        // Coarse pointers only: open the bottom action sheet. On fine
        // pointers this article installs no behavior at all — the global
        // ContextMenuProvider's capture-phase document listener owns every
        // fresh-agent right-click and already opened its unified menu for
        // this gesture (turn action rows ride in via the pane-registered
        // builder, so the transcript needs no menu of its own).
        if (!actions.onOpenActions) return
        event.preventDefault()
        event.stopPropagation()
        // The sheet opens mid-touch via this native-contextmenu route (no
        // long-press timer involved): mark the overlay open so the gesture's
        // touchend suppresses the synthesized compat click.
        longPress?.notifyOverlayOpened?.()
        actions.onOpenActions(actionTurn)
      }}
      {...(longPress?.handlers ?? {})}
    >
      <FreshAgentTurnActions
        turn={actionTurn}
        canFork={actions.canFork}
        canRollback={actions.canRollback}
        rollbackBusy={actions.rollbackBusy}
        onForkFromTurn={actions.onForkFromTurn}
        onRollbackToTurn={actions.onRollbackToTurn}
        onRewindToTurn={actions.onRewindToTurn}
        onOpenActions={actions.onOpenActions}
      />
      {showHeader ? (
        <div className="fresh-agent-turn-header mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
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
                initialExpanded={expandTools}
                expandThinking={expandThinking}
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
          <FreshAgentActivityStrip rows={[]} live initialExpanded={expandTools} />
        ) : null}
        {turn.error && turn.error.name !== 'MessageAbortedError' ? (
          <div
            role="note"
            aria-label="Agent error"
            data-testid="fresh-agent-turn-error"
            className="fresh-agent-error-module rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm"
          >
            <div className="font-medium">Agent error</div>
            <div className="whitespace-pre-wrap break-words">{turn.error.message}</div>
          </div>
        ) : null}
        {turn.error?.name === 'MessageAbortedError' ? (
          <div
            data-testid="fresh-agent-turn-interrupted"
            className="text-xs italic text-muted-foreground"
          >
            interrupted
          </div>
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
  /** Owning pane. When present, the transcript registers a pane-scoped
   * turn-items builder so the global ContextMenuProvider's fresh-agent menu
   * can show per-turn rows for plain-text turn regions. Omitted in
   * isolation/tests: no context-menu turn rows are registered. */
  paneId?: string
  canFork?: boolean
  agentLabel?: string
  showModel?: boolean
  /** "Expand thinking": thinking rows' starting state. */
  expandThinking?: boolean
  /** "Expand tools": the activity strip's starting state. */
  expandTools?: boolean
  showTimecodes?: boolean
  /** "Show transcript minimap" (local setting, default on): a LIVE gate —
   *  false unmounts the rail and its measurement work; the glom chip's shared
   *  sweep is unaffected. */
  showTranscriptMinimap?: boolean
  isStreaming?: boolean
  onForkFromTurn?: (turnId: string) => void
  onRewindToTurn?: (turn: FreshAgentTurn) => void
  /** kata 1wxv: rollback affordances on live turns feed TurnActionProps; the
   * marker bucket + its per-row redo feed the rolled-back section (decision 6). */
  canRollback?: boolean
  rollbackBusy?: boolean
  onRollbackToTurn?: (turnId: string) => void
  rolledBackTurns?: FreshAgentTurn[]
  canRedo?: boolean
  onRedoToTurn?: (turnId: string) => void
  /** Delta-r1 F6: the SERVER-AUTHORED per-marker redo gate (`rollback.redoableTurnIds`
   * from the snapshot — the exact turn ids at the ends of the redoable steps of the
   * CURRENT epoch). Absent (a legacy server surface) or canRedo:false ⇒ no marker
   * offers the affordance: frozen prior-epoch markers are NOT redoable (providers
   * only restore the current epoch's tail). */
  redoableTurnIds?: readonly string[]
  /** The conversation the rolled-back history disclosure scopes to. A different
   * session id (a new conversation started in the same pane, or a session
   * restore) re-collapses the disclosure — the toggle never leaks across
   * conversations. Omitted in isolation/tests (the state keys on null). */
  sessionId?: string
  /** Keep the transcript mounted while a reveal refresh is pending, but pause
   * measurement and scroll bookkeeping until the new snapshot is committed. */
  presentationPaused?: boolean
}

export const FreshAgentTranscript = forwardRef<FreshAgentTranscriptHandle, FreshAgentTranscriptProps>(function FreshAgentTranscript({
  turns,
  paneId,
  canFork = false,
  agentLabel,
  showModel = false,
  expandThinking = false,
  expandTools = false,
  showTimecodes,
  showTranscriptMinimap = true,
  isStreaming = false,
  onForkFromTurn,
  onRewindToTurn,
  canRollback = false,
  rollbackBusy = false,
  onRollbackToTurn,
  rolledBackTurns = [],
  canRedo = false,
  onRedoToTurn,
  redoableTurnIds,
  sessionId,
  presentationPaused = false,
}, ref) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [newMessages, setNewMessages] = useState(0)
  const [sheetTurn, setSheetTurn] = useState<FreshAgentTurn | null>(null)
  const [transcriptMeasurement, setTranscriptMeasurement] = useState<TranscriptMeasurement | null>(null)
  // Rolled-back section lifecycle: historical (non-restorable) markers render
  // behind a quiet disclosure line. The toggle is ephemeral view state SCOPED
  // TO THE CONVERSATION — a different sessionId (a new conversation started
  // in the same pane, or a session restore) re-collapses it, so the
  // disclosure never leaks across conversations. Pure derivation, no effect,
  // no timer; placement itself is a pure function of the snapshot.
  const [historyToggle, setHistoryToggle] = useState<{ sessionId: string | null; expanded: boolean }>({ sessionId: null, expanded: false })
  const historyExpanded = historyToggle.sessionId === (sessionId ?? null) ? historyToggle.expanded : false
  const toggleHistory = () => setHistoryToggle({ sessionId: sessionId ?? null, expanded: !historyExpanded })
  const coarsePointer = useCoarsePointer()
  // F6: the per-marker redo gate set — membership-tested per user marker row.
  const redoableTurnIdSet = useMemo(
    () => (redoableTurnIds ? new Set(redoableTurnIds) : null),
    [redoableTurnIds],
  )
  // Restorable markers (server-stamped flag) keep the expanded section with
  // redo affordances; everything else — redo destroyed by a submission, frozen
  // prior chains, codex from birth, older servers without the flag — renders
  // behind the collapsed history line. Counts are USER-role steps per group;
  // the all-time union is never presented as live state.
  const restorableMarkers = rolledBackTurns.filter((t) => t.restorable === true)
  const historicalMarkers = rolledBackTurns.filter((t) => t.restorable !== true)
  // r2/r3: each count is rollback STEPS (user-role marker groups), not raw
  // marker rows — one undone turn-step contributes a user row AND an assistant
  // row. Each group applies the same user-step rule the server's
  // rollback.undoneDepth computes (r3 correction 5) to its OWN bucket, and
  // restorableSteps + historicalSteps sums to undoneDepth — neither group's
  // count alone equals the union count.
  const restorableSteps = restorableMarkers.filter((t) => t.role === 'user').length
  const historicalSteps = historicalMarkers.filter((t) => t.role === 'user').length
  const resolvedShowTimecodes = showTimecodes ?? showModel
  const displayTurns = useMemo(() => (
    coalesceSyntheticToolResultTurns(turns)
  ), [turns])
  const { layouts: turnLayouts, lineEndIndex, tail, tailCaption } = useMemo(
    () => buildTranscriptLayout(displayTurns),
    [displayTurns],
  )
  const liveActivityBlockId = useMemo(
    () => selectLiveActivityBlockIdFromLayout(turnLayouts, displayTurns, isStreaming, tail),
    [turnLayouts, displayTurns, isStreaming, tail],
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
          const errorLength = 'error' in item && item.error !== undefined ? formatJson(item.error).length : 0
          return `${item.id}:${item.kind}:${item.status}:err:${errorLength}`
        }
        if (item.kind === 'tool_result') {
          return `${item.id}:${item.kind}:${item.isError ? 'error' : 'ok'}:${formatJson(item.content).length}`
        }
        return `${item.id}:${item.kind}`
      }).join(',')
      const errorSignature = turn.error ? `err:${turn.error.name}:${turn.error.message.length}` : ''
      return `${getFreshAgentDisplayTurnKey(turn)}:${turn.summary?.length ?? 0}:${errorSignature}:${itemSignature}`
    }).join('|')
  ), [displayTurns])

  // ONE shared landmark sweep per trigger (scroll + transcriptSignature). The
  // result feeds BOTH the glom chip (derived below) and the minimap rail
  // (passed down as a prop), so a scroll event scans the user-turn articles
  // exactly once. Synchronous on purpose (jsdom act() gate).
  const sweepTranscript = useCallback(() => {
    setTranscriptMeasurement(measureTranscriptUserTurns(scrollerRef.current, displayTurns))
  }, [displayTurns])

  const glomTarget = useMemo(
    () => deriveGlomTarget(transcriptMeasurement),
    [transcriptMeasurement],
  )

  const handleGlomClick = useCallback(() => {
    if (!glomTarget) return
    const scroller = scrollerRef.current
    if (!scroller) return
    const el = scroller.querySelector<HTMLElement>(`[data-turn-index="${glomTarget.index}"]`)
    el?.scrollIntoView?.({ block: 'start' })
  }, [glomTarget])

  const handleOpenActions = useCallback((turn: FreshAgentTurn) => {
    setSheetTurn(turn)
  }, [])

  const actions: TurnActionProps = useMemo(() => ({
    canFork,
    onForkFromTurn,
    onRewindToTurn,
    canRollback,
    rollbackBusy,
    onRollbackToTurn,
    onOpenActions: coarsePointer ? handleOpenActions : undefined,
  }), [canFork, canRollback, coarsePointer, handleOpenActions, onForkFromTurn, onRewindToTurn, onRollbackToTurn, rollbackBusy])

  // Desktop right-click surface: the global ContextMenuProvider owns every
  // fresh-agent contextmenu gesture and asks this pane's registered builder
  // for the per-turn rows. Registering HERE (not in the pane view) keeps the
  // article-index → action-turn resolution next to the merged-line layout it
  // depends on (lineEndIndex), so a merged activity line still forks/undoes/
  // rewinds its LAST contributing turn. Same items as the touch action sheet:
  // buildTurnActionItems is the single builder for both surfaces.
  useEffect(() => {
    if (!paneId) return
    return registerFreshAgentTurnItems(paneId, (articleIndex) => {
      const turn = displayTurns[lineEndIndex.get(articleIndex) ?? articleIndex]
      if (!turn) return null
      return buildTurnActionItems(turn, {
        canFork,
        canRollback,
        rollbackBusy,
        onForkFromTurn,
        onRollbackToTurn,
        onRewindToTurn,
      })
    })
  }, [paneId, displayTurns, lineEndIndex, canFork, canRollback, rollbackBusy, onForkFromTurn, onRollbackToTurn, onRewindToTurn])

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
    if (presentationPaused) return
    const node = scrollerRef.current
    if (!node) return
    if (atBottom) {
      node.scrollTop = node.scrollHeight
      setNewMessages(0)
    } else {
      setNewMessages((count) => count + 1)
    }
  }, [atBottom, presentationPaused, transcriptSignature])

  useEffect(() => {
    if (presentationPaused) return
    sweepTranscript()
  }, [presentationPaused, sweepTranscript, transcriptSignature])

  // Shared row markup for BOTH rolled-back presentations (the e2e locates rows
  // via div.flex.items-start). The redo button branch is gated on the row's
  // restorable group IN ADDITION to the unchanged server-authored redo gate —
  // historical rows never offer the affordance.
  const renderMarkerRow = (turn: FreshAgentTurn, index: number, restorable: boolean) => (
    <div key={`${getFreshAgentDisplayTurnKey(turn)}:${index}`} className="flex items-start justify-between gap-2 rounded px-1 py-1">
      <div className="min-w-0">
        <span className="mr-2 inline-block rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">rolled back</span>
        <span className="text-sm text-muted-foreground">{turn.summary || turnPlainText(turn)}</span>
      </div>
      {restorable && canRedo && onRedoToTurn && turn.role === 'user' && redoableTurnIdSet?.has(turn.turnId ?? turn.id) ? (
        <button
          type="button"
          onClick={() => onRedoToTurn(turn.turnId ?? turn.id)}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          aria-label="Redo to here"
          title={`Restore this turn and the rolled-back turns before it (“${turn.summary.slice(0, 60)}”)`}
        >
          <Redo2 className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  )

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollerRef}
        tabIndex={-1}
        className="fresh-agent-transcript-scroll flex h-full flex-col gap-0 overflow-x-hidden overflow-y-auto overscroll-contain px-3 py-3"
        data-context="fresh-agent-transcript"
        onScroll={(event) => {
          if (presentationPaused) return
          const node = event.currentTarget
          setAtBottom(computeAtBottom(node))
          sweepTranscript()
        }}
      >
        {displayTurns.map((turn, index) => {
          const blocksForTurn = turnLayouts[index]?.blocks ?? []
          // An errored turn is never "absorbed": even when its item mix renders
          // no blocks (e.g. empty-text reasoning), its article must mount for
          // the durable error module. The layout gate above keeps its activity
          // items out of foreign lines.
          const absorbed = turn.items.length > 0 && blocksForTurn.length === 0 && !turn.error
          const isLastStreaming = isStreaming && index === displayTurns.length - 1
          if (absorbed) return null
          if (isLastStreaming && blocksForTurn.length === 0 && turn.items.length === 0 && liveActivityBlockId !== null && !turn.error) return null
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
              expandThinking={expandThinking}
              expandTools={expandTools}
              showHeader={index === 0 || displayTurns[index - 1]?.role !== turn.role}
              continuation={index > 0 && displayTurns[index - 1]?.role === turn.role}
              liveActivityBlockId={liveActivityBlockId}
              isStreamingLastTurn={isLastStreaming}
              index={index}
            />
          )
        })}
        {tailCaption ? (
          <div
            key={tailCaption.id}
            data-testid="fresh-agent-tail-caption"
            className="fresh-agent-activity-caption my-0.5 px-2 py-0.5 text-xs italic text-muted-foreground"
          >
            {tailCaption.text}
          </div>        ) : null}
        {rolledBackTurns.length > 0 ? (
          <section aria-label="Rolled back turns" className="mx-2 mt-2 rounded-md border border-dashed border-border/60 bg-muted/30 p-2 opacity-80">
            {restorableMarkers.length > 0 ? (
              <>
                <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">
                  Rolled back ({restorableSteps}) — gone from the conversation; redo to restore.
                </p>
                {restorableMarkers.map((turn, index) => renderMarkerRow(turn, index, true))}
              </>
            ) : null}
            {historicalMarkers.length > 0 ? (
              <div>
                <button
                  type="button"
                  onClick={() => toggleHistory()}
                  className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/50"
                  aria-expanded={historyExpanded}
                  aria-label={`Rolled back (${historicalSteps}) — kept in history — Toggle rolled-back history`}
                >
                  <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', historyExpanded && 'rotate-90')} aria-hidden="true" />
                  Rolled back ({historicalSteps}) — kept in history
                </button>
                {historyExpanded
                  ? historicalMarkers.map((turn, index) => renderMarkerRow(turn, index, false))
                  : null}
              </div>
            ) : null}
          </section>
        ) : null}
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
          <span className="min-w-0 flex-1 truncate">{glomTarget.text.split('\n')[0]}</span>
        </button>
      ) : null}
      {sheetTurn ? (
        <FreshAgentActionSheet
          title={turnPlainText(sheetTurn).slice(0, 80) || getTurnLabel(sheetTurn, agentLabel)}
          items={buildTurnActionItems(sheetTurn, { canFork, canRollback, rollbackBusy, onForkFromTurn, onRollbackToTurn, onRewindToTurn })}
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
      {showTranscriptMinimap && !presentationPaused ? (
        <FreshAgentTranscriptMinimap
          scrollerRef={scrollerRef}
          measurement={transcriptMeasurement}
          onRemeasure={sweepTranscript}
          transcriptSignature={transcriptSignature}
        />
      ) : null}
    </div>
  )
})

export default memo(FreshAgentTranscript)
