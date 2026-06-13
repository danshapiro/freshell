import { useMemo, useState } from 'react'
import { Check, ChevronRight, Loader2, X } from 'lucide-react'
import DiffView from '@/components/agent-chat/DiffView'
import { getToolPreview } from '@/components/agent-chat/tool-preview'
import { LazyMarkdown } from '@/components/markdown/LazyMarkdown'
import type { FreshAgentTranscriptItem } from '@shared/fresh-agent-contract'
import { cn } from '@/lib/utils'

function formatJson(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value ?? null, null, 2)
  } catch {
    return String(value)
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function summarizeResult(name: string, output?: string, isError?: boolean): string | null {
  if (isError) return 'error'
  if (!output) return null
  if (name === 'Read' || name === 'Result') {
    const lineCount = output.split('\n').length
    return `${lineCount} line${lineCount === 1 ? '' : 's'}`
  }
  if (name === 'Grep' || name === 'Glob') {
    const matchCount = output.trim().split('\n').filter(Boolean).length
    return `${matchCount} match${matchCount === 1 ? '' : 'es'}`
  }
  if (name === 'Bash' || name === 'Command') {
    const lineCount = output.split('\n').filter(Boolean).length
    return lineCount > 3 ? `${lineCount} lines` : 'done'
  }
  return 'done'
}

function StatusBadge({ value }: { value?: string }) {
  if (!value) return null
  return (
    <span className="fresh-agent-status-badge rounded-full border border-border/70 bg-background/80 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
      {value}
    </span>
  )
}

export interface FreshAgentToolDisplay {
  id: string
  name: string
  input?: Record<string, unknown>
  output?: string
  isError?: boolean
  status: 'running' | 'complete'
}

export function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

export function FreshAgentToolBlock({
  tool,
  initialExpanded = false,
}: {
  tool: FreshAgentToolDisplay
  initialExpanded?: boolean
}) {
  const [expanded, setExpanded] = useState(initialExpanded)
  const preview = useMemo(() => getToolPreview(tool.name, tool.input), [tool.input, tool.name])
  const resultSummary = summarizeResult(tool.name, tool.output, tool.isError)
  const hasEditDiff = tool.name === 'Edit'
    && typeof tool.input?.old_string === 'string'
    && typeof tool.input?.new_string === 'string'

  return (
    <div
      className={cn(
        'fresh-agent-tool-block my-0.5 border-l-2 text-xs',
        tool.isError ? 'border-l-[hsl(var(--destructive))]' : 'border-l-[hsl(var(--primary))]',
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="fresh-agent-tool-trigger flex w-full items-center gap-2 rounded-r px-2 py-0.5 text-left transition-colors hover:bg-accent/50"
        aria-expanded={expanded}
        aria-label={`${tool.name} tool call`}
      >
        <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', expanded && 'rotate-90')} />
        <span className="fresh-agent-tool-name font-medium">{tool.name}:</span>
        {preview ? <span className="fresh-agent-tool-preview truncate font-mono text-muted-foreground">{preview}</span> : null}
        {resultSummary ? (
          <span className={cn('fresh-agent-tool-result-summary shrink-0 text-muted-foreground', tool.isError && 'text-destructive')}>
            ({resultSummary})
          </span>
        ) : null}
        <span className="fresh-agent-tool-status ml-auto shrink-0">
          {tool.status === 'running' ? <Loader2 className="h-3 w-3 animate-spin" aria-label="running" /> : null}
          {tool.status === 'complete' && !tool.isError ? <Check className="h-3 w-3 text-green-500" aria-label="complete" /> : null}
          {tool.status === 'complete' && tool.isError ? <X className="h-3 w-3 text-destructive" aria-label="error" /> : null}
        </span>
      </button>
      {expanded ? (
        <div className="fresh-agent-tool-body border-t border-border/50 px-2 py-1 text-xs">
          {hasEditDiff ? (
            <DiffView
              oldStr={String(tool.input?.old_string ?? '')}
              newStr={String(tool.input?.new_string ?? '')}
              filePath={typeof tool.input?.file_path === 'string' ? tool.input.file_path : undefined}
            />
          ) : (
            <>
              {tool.input ? (
                <pre
                  className="fresh-agent-tool-pre max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-mono opacity-80"
                  data-tool-input=""
                  data-tool-name={tool.name}
                >
                  {tool.name === 'Bash' && typeof tool.input.command === 'string'
                    ? tool.input.command
                    : JSON.stringify(tool.input, null, 2)}
                </pre>
              ) : null}
              {tool.output ? (
                <pre
                  className={cn(
                    'fresh-agent-tool-pre mt-0.5 max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-mono',
                    tool.isError ? 'text-destructive' : 'opacity-80',
                  )}
                  data-tool-output=""
                >
                  {tool.output}
                </pre>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

export function itemToToolDisplay(item: FreshAgentTranscriptItem): FreshAgentToolDisplay | null {
  if (item.kind === 'tool_use') {
    return {
      id: item.toolUseId,
      name: item.name,
      input: asRecord(item.input),
      status: 'running',
    }
  }
  if (item.kind === 'command') {
    return {
      id: item.id,
      name: 'Bash',
      input: { command: item.command, ...(item.cwd ? { cwd: item.cwd } : {}) },
      output: item.output ?? undefined,
      isError: item.status === 'failed',
      status: item.status === 'running' ? 'running' : 'complete',
    }
  }
  if (item.kind === 'file_change') {
    return {
      id: item.id,
      name: 'Edit',
      input: { changes: item.changes },
      isError: item.status === 'failed',
      status: item.status === 'running' ? 'running' : 'complete',
    }
  }
  if (item.kind === 'mcp_tool') {
    return {
      id: item.id,
      name: `${item.server}/${item.tool}`,
      input: asRecord(item.arguments) ?? { arguments: item.arguments },
      output: item.result !== undefined ? formatJson(item.result) : item.error !== undefined ? formatJson(item.error) : undefined,
      isError: item.status === 'failed',
      status: item.status === 'running' ? 'running' : 'complete',
    }
  }
  if (item.kind === 'dynamic_tool') {
    return {
      id: item.id,
      name: item.namespace ? `${item.namespace}.${item.tool}` : item.tool,
      input: asRecord(item.arguments) ?? { arguments: item.arguments },
      output: item.contentItems !== undefined ? formatJson(item.contentItems) : undefined,
      isError: item.status === 'failed' || item.success === false,
      status: item.status === 'running' ? 'running' : 'complete',
    }
  }
  if (item.kind === 'web_search') {
    return {
      id: item.id,
      name: 'WebSearch',
      input: { query: item.query, ...(item.action ? { action: item.action } : {}) },
      status: 'complete',
    }
  }
  if (item.kind === 'image_view') {
    return {
      id: item.id,
      name: 'Read',
      input: { file_path: item.path },
      status: 'complete',
    }
  }
  if (item.kind === 'image_generation') {
    return {
      id: item.id,
      name: 'ImageGeneration',
      input: { prompt: item.revisedPrompt },
      output: item.savedPath ?? item.result,
      isError: item.status === 'failed',
      status: item.status === 'running' ? 'running' : 'complete',
    }
  }
  return null
}

/**
 * Render visible item text. Assistant-authored text renders as markdown
 * (matching agent-chat's MessageBubble); user text and thinking stay plain
 * so literal input is never re-interpreted. The plain <p> doubles as the
 * Suspense fallback so content is readable while the renderer chunk loads.
 */
function renderText(text: string, markdown = false) {
  const visibleText = stripSystemReminders(text)
  if (!visibleText) return null
  const plain = <p className="whitespace-pre-wrap break-words">{visibleText}</p>
  if (!markdown) return plain
  return (
    <div
      data-markdown-body=""
      className="prose prose-sm dark:prose-invert max-w-none [&_h1]:my-2 [&_h2]:my-1.5 [&_h3]:my-1.5 [&_p]:my-1 [&_pre]:my-1.5 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5"
    >
      <LazyMarkdown content={visibleText} fallback={plain} />
    </div>
  )
}

/** Markdown-rendered body for agent-authored text that lives outside item
 * cards (turn-summary fallbacks, expanded thinking). Keeps every assistant
 * text path on the same renderer so backticks never show literally. */
export function FreshAgentMarkdownBody({ text }: { text: string }) {
  return <>{renderText(text, true)}</>
}

function FreshAgentThinkingDisclosure({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="fresh-agent-thinking-details border-l-2 border-l-[hsl(var(--primary))] text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 rounded-r px-2 py-0.5 text-left font-medium transition-colors hover:bg-accent/50"
        aria-expanded={expanded}
        aria-label="Thinking"
      >
        <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', expanded && 'rotate-90')} />
        <span>Thinking</span>
      </button>
      {expanded ? <div className="px-2 py-1 text-sm">{renderText(text)}</div> : null}
    </div>
  )
}

export function FreshAgentItemCard({
  item,
  markdown = false,
}: {
  item: FreshAgentTranscriptItem
  markdown?: boolean
}) {
  if (item.kind === 'text' || item.kind === 'thinking') {
    if (item.kind === 'thinking') {
      return <FreshAgentThinkingDisclosure text={item.text} />
    }
    return renderText(item.text, markdown)
  }

  if (item.kind === 'reasoning') {
    const summary = item.summary.length > 0 ? item.summary.join('\n') : item.text
    return (
      <details className="fresh-agent-inline-card fresh-agent-reasoning-card rounded-md border border-border/60 bg-background/70 px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium">Reasoning</summary>
        {summary ? <p className="mt-2 whitespace-pre-wrap text-sm">{summary}</p> : null}
        {item.content.length > 0 ? (
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-muted-foreground">{item.content.join('\n')}</pre>
        ) : null}
      </details>
    )
  }

  const tool = itemToToolDisplay(item)
  if (tool) {
    return <FreshAgentToolBlock tool={tool} />
  }

  if (item.kind === 'tool_result') {
    return (
      <div className="fresh-agent-tool-result border-l-2 border-l-border px-2 py-1 text-xs">
        <div className="mb-1 flex items-center gap-2 font-medium">
          Tool result
          {item.isError ? <StatusBadge value="error" /> : null}
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words">{formatJson(item.content)}</pre>
      </div>
    )
  }

  if (item.kind === 'collab_agent') {
    return (
      <div className="fresh-agent-inline-card rounded-md border border-border/60 bg-background/70 px-3 py-2 text-xs">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="font-medium">{item.tool}</span>
          <StatusBadge value={item.status} />
        </div>
        <div className="text-muted-foreground">From {item.senderThreadId}</div>
        <div className="text-muted-foreground">To {item.receiverThreadIds.join(', ')}</div>
        {item.prompt ? <p className="mt-2 whitespace-pre-wrap">{item.prompt}</p> : null}
      </div>
    )
  }

  if (item.kind === 'web_search') {
    return (
      <div className="fresh-agent-inline-card rounded-md border border-border/60 bg-background/70 px-3 py-2 text-xs">
        <div className="font-medium">Web search</div>
        <div className="mt-1 whitespace-pre-wrap">{item.query}</div>
      </div>
    )
  }

  if (item.kind === 'image_view') {
    return (
      <div className="fresh-agent-inline-card rounded-md border border-border/60 bg-background/70 px-3 py-2 text-xs">
        <div className="font-medium">Image</div>
        <div className="mt-1 break-all text-muted-foreground">{item.path}</div>
      </div>
    )
  }

  if (item.kind === 'image_generation') {
    return (
      <div className="fresh-agent-inline-card rounded-md border border-border/60 bg-background/70 px-3 py-2 text-xs">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="font-medium">Image generation</span>
          <StatusBadge value={item.displayStatus ?? item.status} />
        </div>
        {item.revisedPrompt ? <p className="whitespace-pre-wrap">{item.revisedPrompt}</p> : null}
        <div className="mt-1 break-all text-muted-foreground">{item.result}</div>
        {item.savedPath ? <div className="mt-1 break-all text-muted-foreground">{item.savedPath}</div> : null}
      </div>
    )
  }

  if (item.kind === 'review_mode') {
    return (
      <div className="fresh-agent-inline-card rounded-md border border-border/60 bg-background/70 px-3 py-2 text-xs">
        {item.event === 'entered' ? 'Entered review mode' : 'Exited review mode'}
        {item.review ? <span className="text-muted-foreground"> · {item.review}</span> : null}
      </div>
    )
  }

  return (
    <div className="fresh-agent-inline-card rounded-md border border-border/60 bg-background/70 px-3 py-2 text-xs">
      Context compaction
    </div>
  )
}
