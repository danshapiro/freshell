import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import SlotReel from '@/components/agent-chat/SlotReel'
import { getToolPreview } from '@/components/agent-chat/tool-preview'
import { cn } from '@/lib/utils'
import type { FreshAgentTranscriptItem, FreshAgentTurn } from '@shared/fresh-agent-contract'
import {
  FreshAgentItemCard,
  FreshAgentToolBlock,
  itemToToolDisplay,
  stripSystemReminders,
  type FreshAgentToolDisplay,
} from './FreshAgentItemCard'

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

function formatJson(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value ?? null, null, 2)
  } catch {
    return String(value)
  }
}

function buildTools(items: FreshAgentTranscriptItem[]): FreshAgentToolDisplay[] {
  const tools = new Map<string, FreshAgentToolDisplay>()
  const orderedIds: string[] = []
  for (const item of items) {
    if (item.kind === 'tool_result') {
      const existing = tools.get(item.toolUseId)
      if (existing) {
        tools.set(item.toolUseId, {
          ...existing,
          output: formatJson(item.content),
          isError: item.isError,
          status: 'complete',
        })
      } else {
        orderedIds.push(item.id)
        tools.set(item.id, {
          id: item.id,
          name: 'Result',
          output: formatJson(item.content),
          isError: item.isError,
          status: 'complete',
        })
      }
      continue
    }
    const tool = itemToToolDisplay(item)
    if (!tool) continue
    if (!tools.has(tool.id)) orderedIds.push(tool.id)
    tools.set(tool.id, tool)
  }
  return orderedIds.map((id) => tools.get(id)).filter(Boolean) as FreshAgentToolDisplay[]
}

type RenderBlock =
  | { kind: 'item'; item: FreshAgentTranscriptItem }
  | { kind: 'tools'; id: string; tools: FreshAgentToolDisplay[] }

function buildBlocks(items: FreshAgentTranscriptItem[]): RenderBlock[] {
  const blocks: RenderBlock[] = []
  let pendingTools: FreshAgentTranscriptItem[] = []
  const flushTools = () => {
    if (pendingTools.length === 0) return
    const tools = buildTools(pendingTools)
    if (tools.length > 0) {
      blocks.push({ kind: 'tools', id: pendingTools.map((item) => item.id).join(':'), tools })
    }
    pendingTools = []
  }
  for (const item of items) {
    if (isToolLike(item)) {
      pendingTools.push(item)
      continue
    }
    flushTools()
    blocks.push({ kind: 'item', item })
  }
  flushTools()
  return blocks
}

function FreshAgentToolStrip({ tools }: { tools: FreshAgentToolDisplay[] }) {
  const [expanded, setExpanded] = useState(false)
  const hasErrors = tools.some((tool) => tool.isError)
  const allComplete = tools.every((tool) => tool.status === 'complete')
  const currentTool = [...tools].reverse().find((tool) => tool.status === 'running') ?? tools[tools.length - 1] ?? null
  const settledText = `${tools.length} tool${tools.length === 1 ? '' : 's'} used`

  if (tools.length === 0) return null
  return (
    <div role="region" aria-label="Tool strip" className="my-0.5">
      {!expanded ? (
        <div
          className={cn(
            'flex min-w-0 items-center gap-1 border-l-2 px-2 py-0.5 text-xs',
            hasErrors ? 'border-l-[hsl(var(--destructive))]' : 'border-l-[hsl(var(--primary))]',
          )}
        >
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="shrink-0 rounded p-0.5 transition-colors hover:bg-accent/50"
            aria-label="Toggle tool details"
            aria-expanded={false}
          >
            <ChevronRight className="h-3 w-3" />
          </button>
          <SlotReel
            toolName={allComplete ? null : (currentTool?.name ?? null)}
            previewText={allComplete ? null : (currentTool ? getToolPreview(currentTool.name, currentTool.input) : null)}
            settledText={allComplete ? settledText : undefined}
          />
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="ml-1.5 shrink-0 rounded p-0.5 transition-colors hover:bg-accent/50"
            aria-label="Toggle tool details"
            aria-expanded={true}
          >
            <ChevronRight className="h-3 w-3 rotate-90 transition-transform" />
          </button>
          {tools.map((tool) => (
            <FreshAgentToolBlock key={tool.id} tool={tool} initialExpanded={false} />
          ))}
        </>
      )}
    </div>
  )
}

function countTools(turn: FreshAgentTurn): number {
  return buildTools(turn.items.filter(isToolLike)).length
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

function CollapsedFreshAgentTurn({ turn }: { turn: FreshAgentTurn }) {
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
        <FreshAgentTurnArticle turn={turn} compact={false} />
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

function FreshAgentTurnArticle({ turn, compact }: { turn: FreshAgentTurn; compact: boolean }) {
  const isUser = turn.role === 'user'
  const blocks = buildBlocks(turn.items)
  return (
    <article
      className={cn(
        'w-full border-l-2 py-0.5 pl-2.5 pr-1',
        isUser ? 'border-l-[hsl(var(--primary))]' : 'border-l-border',
        compact && 'opacity-95',
      )}
      aria-label={`${getTurnLabel(turn)} transcript turn`}
    >
      <div className="mb-1 flex items-center justify-between gap-2 text-[11px] uppercase text-muted-foreground">
        <span>{getTurnLabel(turn)}</span>
        {turn.model ? <span className="truncate normal-case">{turn.model}</span> : null}
      </div>
      <div className="space-y-1.5 text-sm">
        {blocks.length > 0 ? blocks.map((block) => {
          if (block.kind === 'tools') return <FreshAgentToolStrip key={block.id} tools={block.tools} />
          return <FreshAgentItemCard key={block.item.id} item={block.item} />
        }) : (
          <p className="whitespace-pre-wrap break-words">{stripSystemReminders(turn.summary)}</p>
        )}
      </div>
    </article>
  )
}

export function FreshAgentTranscript({ turns }: { turns: FreshAgentTurn[] }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [newMessages, setNewMessages] = useState(0)
  const turnKeys = useMemo(() => turns.map((turn) => turn.id).join('|'), [turns])

  useEffect(() => {
    const node = scrollerRef.current
    if (!node) return
    if (atBottom) {
      node.scrollTop = node.scrollHeight
      setNewMessages(0)
    } else {
      setNewMessages((count) => count + 1)
    }
  }, [atBottom, turnKeys])

  const collapsedCutoff = Math.max(0, turns.length - 8)

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollerRef}
        className="flex h-full flex-col gap-3 overflow-y-auto px-3 py-3"
        data-context="fresh-agent-transcript"
        onScroll={(event) => {
          const node = event.currentTarget
          setAtBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 24)
        }}
      >
        {turns.map((turn, index) => (
          index < collapsedCutoff
            ? <CollapsedFreshAgentTurn key={turn.id} turn={turn} />
            : <FreshAgentTurnArticle key={turn.id} turn={turn} compact={index < collapsedCutoff} />
        ))}
      </div>
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
