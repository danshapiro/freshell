import { createContext, memo, useContext, useMemo, useState } from 'react'
import { Ban, Check, ChevronRight, Loader2, X } from 'lucide-react'
import FreshAgentQuestionBanner from './FreshAgentQuestionBanner.js'
import DiffView from '@/components/fresh-agent/shared/DiffView'
import { formatThoughtDuration } from '@/components/fresh-agent/shared/format-duration'
import { getToolPreview } from '@/components/fresh-agent/shared/tool-preview'
import { LazyMarkdown } from '@/components/markdown/LazyMarkdown'
import { asyncQuestionKey, type AsyncQuestionAnswer, type AsyncQuestionAnswerStatus } from '@/lib/fresh-agent-async-questions'
import type { FreshAgentTranscriptItem } from '@shared/fresh-agent-contract'
import { cn } from '@/lib/utils'
import { childActivitySummary } from './shared/child-activity.js'
import type { FreshAgentChildParent } from './FreshAgentChildObserver.js'

export const FreshAgentAsyncQuestionContext = createContext<{ onAnswer?: (answer: AsyncQuestionAnswer) => void; statuses?: Record<string, AsyncQuestionAnswerStatus> }>({})
const ASYNC_ANSWER_STATUS: Record<AsyncQuestionAnswerStatus, string> = {
  draft: 'Answer draft is in the composer',
  sending: 'Sending answer as a message',
  accepted: 'Answer accepted as a message',
  refused: 'Answer not sent; your draft is in the composer.',
  ambiguous: 'Answer delivery uncertain; review the composer before sending again.',
}

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
  status: 'running' | 'complete' | 'failed' | 'declined' | 'interrupted'
  exitCode?: number | null
  nativeOutcome?: boolean
  references?: Array<{ label: string; href: string }>
  /** Display-first preview: when present, wins over getToolPreview(name, input). */
  previewOverride?: string
}

/**
 * Opens a fresh-agent session (e.g. a delegation's child) in the UI. The no-op
 * default keeps item cards renderable anywhere; the provider lands with the
 * transcript/pane wiring.
 */
export const FreshAgentOpenSessionContext = createContext<(sessionId: string, title?: string) => void>(() => {})
export const FreshAgentObserveChildContext = createContext<{
  parent: FreshAgentChildParent
  onObserve: (action: { type: 'observe-child'; parent: FreshAgentChildParent; childThreadId: string }) => void
} | undefined>(undefined)

export function FreshAgentChildLink({ childThreadId }: { childThreadId: string }) {
  const observer = useContext(FreshAgentObserveChildContext)
  return observer ? <button type="button" className="underline" aria-label={`Observe child ${childThreadId}`} onClick={() => observer.onObserve({ type: 'observe-child', parent: observer.parent, childThreadId })}>Observe conversation</button> : null
}

export function outputReferences(value: unknown): Array<{ label: string; href: string }> {
  const values = Array.isArray(value) ? value : [value]
  return values.flatMap((entry) => {
    const record = asRecord(entry)
    if (!record) return []
    const path = record.path ?? record.image_url ?? record.url ?? record.savedPath
    if (typeof path !== 'string') return Array.isArray(record.content) ? outputReferences(record.content) : []
    if (/^https?:\/\//.test(path)) return [{ label: path, href: path }]
    if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return [{ label: path, href: `/api/files/raw?path=${encodeURIComponent(path)}` }]
    return []
  })
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
  const preview = useMemo(
    () => tool.previewOverride ?? getToolPreview(tool.name, tool.input),
    [tool.previewOverride, tool.input, tool.name],
  )
  const resultSummary = tool.status === 'declined' ? 'declined' : summarizeResult(tool.name, tool.output, tool.isError)
  const hasEditDiff = tool.name === 'Edit'
    && typeof tool.input?.old_string === 'string'
    && typeof tool.input?.new_string === 'string'

  return (
    <div
      className={cn(
        'fresh-agent-tool-block my-0.5 text-xs',
        tool.isError && 'bg-destructive/10',
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
          {tool.status === 'declined' ? <Ban className="h-3 w-3 text-muted-foreground" aria-label="declined" /> : null}
          {tool.status === 'interrupted' ? <Ban className="h-3 w-3 text-muted-foreground" aria-label="interrupted" /> : null}
          {tool.status === 'complete' && !tool.isError ? <Check className="h-3 w-3 text-green-500" aria-label="complete" /> : null}
          {(tool.status === 'failed' || (tool.status === 'complete' && tool.isError)) ? <X className="h-3 w-3 text-destructive" aria-label="error" /> : null}
        </span>
      </button>
      {expanded ? (
        <div className="fresh-agent-tool-body border-t border-border/50 px-2 py-1 text-xs">
          {tool.exitCode != null ? <div>Exit code: {tool.exitCode}</div> : null}
          {tool.references?.map((reference) => <a className="block break-all underline" key={reference.href} href={reference.href} target="_blank" rel="noreferrer">{reference.label}</a>)}
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

/** First-letter uppercase display transform for wire-provided labels. */
function titleCaseFirst(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return value
  return trimmed[0].toUpperCase() + trimmed.slice(1)
}

/**
 * One activity-strip member for an opencode `task` tool part: the delegation
 * header (status icon + title + duration), compact non-expandable child
 * tool rows, the clamped task result, and the "Open session" link to the
 * child session. Full detail lives in the child session pane.
 */
export function FreshAgentDelegationBlock({ item }: { item: Extract<FreshAgentTranscriptItem, { kind: 'task_delegation' }> }) {
  const openSession = useContext(FreshAgentOpenSessionContext)
  const activity = item.activity ?? []
  return (
    <div className="fresh-agent-delegation-block my-0.5 text-xs" data-testid="fresh-agent-delegation-block" data-status={item.status}>
      <div className="flex min-w-0 items-center gap-2 rounded-r px-2 py-0.5">
        {item.status === 'running' ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-label="running" /> : null}
        {item.status === 'completed' ? <Check className="h-3 w-3 shrink-0 text-green-500" aria-label="complete" /> : null}
        {item.status === 'failed' ? <X className="h-3 w-3 shrink-0 text-destructive" aria-label="error" /> : null}
        {item.status === 'interrupted' ? <Ban className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="interrupted" /> : null}
        <span className="fresh-agent-delegation-title truncate font-medium">{item.title}</span>
        {item.durationMs !== undefined ? (
          <span className="shrink-0 text-muted-foreground">{formatThoughtDuration(item.durationMs)}</span>
        ) : null}
      </div>
      {item.provider === 'codex' ? <div className="px-3 py-1 text-muted-foreground">{childActivitySummary(item)}</div> : null}
      {activity.length > 0 ? (
        <div className="border-t border-border/50 px-3 py-1">
          {activity.map((row, index) => (
            <div key={`${row.tool}-${index}`} className="flex min-w-0 items-center gap-2 py-0.5 text-muted-foreground" data-testid="fresh-agent-delegation-row">
              <span aria-hidden="true">↳</span>
              <span className="shrink-0 font-medium">{titleCaseFirst(row.tool)}</span>
              {row.preview ? <span className="truncate font-mono">{row.preview}</span> : null}
              {row.status === 'failed' ? <span className="shrink-0 text-destructive">(failed)</span> : null}
              {row.status === 'running' ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-label={`${titleCaseFirst(row.tool)} running`} /> : null}
            </div>
          ))}
        </div>
      ) : null}
      {item.result ? (
        <div className="border-t border-border/50 px-3 py-1">
          <pre data-testid="fresh-agent-delegation-result" className="fresh-agent-delegation-result max-h-24 overflow-y-auto whitespace-pre-wrap break-words font-mono opacity-80">
            {item.result}
          </pre>
        </div>
      ) : null}
      {item.childSessionId && item.provider === 'codex' ? <div className="px-3 py-1"><span>{item.childSessionId} </span><FreshAgentChildLink childThreadId={item.childSessionId} /></div> : item.childSessionId ? (
        <div className="border-t border-border/50 px-3 py-1">
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground underline-offset-2 transition-colors hover:bg-accent/50 hover:underline"
            onClick={() => openSession(item.childSessionId!, item.description)}
            aria-label={`Open session ${item.description ?? item.childSessionId}`}
          >
            Open session
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** Muted activity-strip row for an opencode retry part. */
export function FreshAgentRetryRow({ attempt, error }: { attempt: number; error?: string }) {
  return (
    <div data-testid="fresh-agent-retry-row" className="my-0.5 px-2 py-0.5 text-xs italic text-muted-foreground">
      {`Retrying (attempt ${attempt})${error ? ` — ${error}` : ''}`}
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
      status: item.status === 'completed' ? 'complete' : item.status,
      exitCode: item.exitCode,
      nativeOutcome: true,
    }
  }
  if (item.kind === 'file_change') {
    return {
      id: item.id,
      name: 'Edit',
      input: { changes: item.changes },
      output: item.output,
      isError: item.status === 'failed',
      status: item.status === 'completed' ? 'complete' : item.status,
      nativeOutcome: true,
    }
  }
  if (item.kind === 'mcp_tool') {
    return {
      id: item.id,
      name: `${item.server}/${item.tool}`,
      input: asRecord(item.arguments) ?? { arguments: item.arguments },
      output: item.status === 'running' && item.progress ? item.progress : item.result !== undefined ? formatJson(item.result) : item.error !== undefined ? formatJson(item.error) : undefined,
      references: outputReferences(item.result),
      isError: item.status === 'failed',
      status: item.status === 'running' ? 'running' : 'complete',
      nativeOutcome: true,
    }
  }
  if (item.kind === 'dynamic_tool') {
    const argumentsRecord = asRecord(item.arguments)
    return {
      id: item.id,
      name: item.namespace ? `${item.namespace}.${item.tool}` : item.tool,
      input: argumentsRecord ?? { arguments: item.arguments },
      previewOverride: item.tool === 'Sleep' && typeof argumentsRecord?.durationMs === 'number' ? `${argumentsRecord.durationMs} ms` : undefined,
      // A persisted failed opencode tool carries its CLI-visible text in
      // `state.error` (never `state.output`), so the absent-JSON-null
      // contentItems path uses that text — the same destructive slot the card
      // already renders for failed tool output.
      output: item.contentItems != null
        ? formatJson(item.contentItems)
        : item.error ?? undefined,
      references: outputReferences(item.contentItems),
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
      references: outputReferences({ path: item.path }),
      status: 'complete',
    }
  }
  if (item.kind === 'image_generation') {
    return {
      id: item.id,
      name: 'ImageGeneration',
      input: { prompt: item.revisedPrompt },
      output: item.savedPath ?? item.result,
      references: outputReferences({ path: item.savedPath ?? item.result }),
      isError: item.status === 'failed',
      status: item.status === 'running' ? 'running' : 'complete',
    }
  }
  return null
}

/**
 * Render visible item text. Assistant-authored text renders as markdown
 * (matching the fresh-agent message bubble); user text and thinking stay plain
 * so literal input is never re-interpreted. The plain <p> doubles as the
 * Suspense fallback so content is readable while the renderer chunk loads.
 */
function renderText(text: string, markdown = false) {
  const visibleText = stripSystemReminders(text)
  if (!visibleText) return null
  const plain = <p className="whitespace-pre-wrap break-words leading-[inherit]">{visibleText}</p>
  if (!markdown) return plain
  return (
    <div
      data-markdown-body=""
      className="prose prose-sm dark:prose-invert max-w-none [&_h1]:my-2 [&_h2]:my-1.5 [&_h3]:my-1.5 [&_p]:my-1 [&_pre]:my-1.5 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 [&_code]:before:!content-none [&_code]:after:!content-none"
    >
      <LazyMarkdown content={visibleText} fallback={plain} />
    </div>
  )
}

/** Markdown-rendered body for agent-authored text that lives outside item
 * cards (turn-summary fallbacks, expanded thinking). Keeps every assistant
 * text path on the same renderer so backticks never show literally. */
export const FreshAgentMarkdownBody = memo(function FreshAgentMarkdownBody({ text }: { text: string }) {
  return <>{renderText(text, true)}</>
})

function FreshAgentThinkingDisclosure({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="fresh-agent-thinking-details text-xs text-muted-foreground">
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

/**
 * One transcript item. Memoized: snapshot commits keep an unchanged item's
 * object (fresh-agent-turn-sharing), so history never re-renders (or
 * re-parses its markdown) when only the newest turns change.
 */
export const FreshAgentItemCard = memo(function FreshAgentItemCard({
  item,
  markdown = false,
  onAnswerQuestion,
}: {
  item: FreshAgentTranscriptItem
  markdown?: boolean
  onAnswerQuestion?: (answer: AsyncQuestionAnswer) => void
}) {
  const asyncQuestions = useContext(FreshAgentAsyncQuestionContext)
  const answerQuestion = onAnswerQuestion ?? asyncQuestions.onAnswer
  if (item.kind === 'text' || item.kind === 'thinking') {
    if (item.kind === 'thinking') {
      return <FreshAgentThinkingDisclosure text={item.text} />
    }
    const native = asRecord(item.extensions?.codex)
    const questions = Array.isArray(native?.questions) ? native.questions : []
    return <>{renderText(item.text, markdown)}{questions.map((question, index) => {
      const value = asRecord(question)
      if (!value || typeof value.title !== 'string') return null
      const itemId = typeof native?.itemId === 'string' ? native.itemId : item.id
      const questionId = typeof value.id === 'string' ? value.id : String(index)
      const status = asyncQuestions.statuses?.[asyncQuestionKey(itemId, questionId)]
      if (native?.delivery === 'async' && answerQuestion) {
        const options = Array.isArray(value.options)
          ? value.options.filter((option): option is string => typeof option === 'string').map((label) => ({ label, description: '' }))
          : []
        return (
          <div key={questionId} className="my-2">
            <FreshAgentQuestionBanner
              providerLabel="Codex"
              question={{ questions: [{ id: questionId, header: 'Reply as a message', question: value.title, options, multiSelect: false, isOther: true }] }}
              onAnswer={(answers) => answerQuestion({ itemId, questionId, question: value.title as string, text: answers[questionId] })}
            />
            {status ? <p role="status" className="text-xs">{ASYNC_ANSWER_STATUS[status]}</p> : null}
          </div>
        )
      }
      return <div key={index} className="px-2 py-1"><p>{value.title}</p>{Array.isArray(value.options) ? <ul>{value.options.filter((option): option is string => typeof option === 'string').map((option, i) => <li key={i}>{option}</li>)}</ul> : null}</div>
    })}</>
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

  if (item.kind === 'task_delegation') {
    return <FreshAgentDelegationBlock item={item} />
  }

  if (item.kind === 'retry') {
    return <FreshAgentRetryRow attempt={item.attempt} error={item.error} />
  }

  if (item.kind === 'delegated_task') {
    return (
      <div data-testid="fresh-agent-delegated-task" className="my-0.5 px-2 py-0.5 text-xs italic text-muted-foreground">
        {`Delegated — ${titleCaseFirst(item.agent ?? 'Task')}${item.description ? ` · ${item.description}` : ''}`}
      </div>
    )
  }

  const tool = itemToToolDisplay(item)
  if (tool) {
    return <FreshAgentToolBlock tool={tool} />
  }

  if (item.kind === 'tool_result') {
    return (
      <div className="fresh-agent-tool-result px-2 py-1 text-xs">
        <div className="mb-1 flex items-center gap-2 font-medium">
          Tool result
          {item.isError ? <StatusBadge value="error" /> : null}
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words">{formatJson(item.content)}</pre>
        {outputReferences(item.content).map((reference) => <a key={reference.href} href={reference.href} target="_blank" rel="noreferrer">{reference.label}</a>)}
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
        {item.receiverThreadIds.map((id) => <div key={id} className="border-t py-1"><div className="text-muted-foreground">To {id}</div><p>{childActivitySummary({ model: item.model, reasoningEffort: item.reasoningEffort, ...asRecord(item.agentsStates[id]) })}</p><FreshAgentChildLink childThreadId={id} /></div>)}
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
})
