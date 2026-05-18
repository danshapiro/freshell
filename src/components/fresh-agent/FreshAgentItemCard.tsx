import type { FreshAgentTranscriptItem } from '@shared/fresh-agent-contract'

function formatJson(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value ?? null, null, 2)
  } catch {
    return String(value)
  }
}

function StatusBadge({ value }: { value?: string }) {
  if (!value) return null
  return (
    <span className="rounded-full border border-border/70 bg-background/80 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
      {value}
    </span>
  )
}

export function FreshAgentItemCard({ item }: { item: FreshAgentTranscriptItem }) {
  if (item.kind === 'text' || item.kind === 'thinking') {
    return (
      <p className="whitespace-pre-wrap break-words">
        {item.text}
      </p>
    )
  }

  if (item.kind === 'reasoning') {
    const summary = item.summary.length > 0 ? item.summary.join('\n') : item.text
    return (
      <details className="rounded-md border border-border/60 bg-background/70 px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium">Reasoning</summary>
        {summary ? <p className="mt-2 whitespace-pre-wrap text-sm">{summary}</p> : null}
        {item.content.length > 0 ? (
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-muted-foreground">{item.content.join('\n')}</pre>
        ) : null}
      </details>
    )
  }

  if (item.kind === 'tool_use') {
    return (
      <div className="rounded-md border border-border/60 bg-background/70 px-3 py-2 text-xs">
        <div className="mb-1 font-medium">{item.name}</div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words">{formatJson(item.input ?? {})}</pre>
      </div>
    )
  }

  if (item.kind === 'tool_result') {
    return (
      <div className="rounded-md border border-border/60 bg-background/70 px-3 py-2 text-xs">
        <div className="mb-1 flex items-center gap-2 font-medium">
          Tool result
          {item.isError ? <StatusBadge value="error" /> : null}
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words">{formatJson(item.content)}</pre>
      </div>
    )
  }

  if (item.kind === 'command') {
    return (
      <div className="rounded-md border border-border/60 bg-background/70 px-3 py-2 text-xs">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="font-medium">Command</span>
          <StatusBadge value={item.status} />
        </div>
        {item.cwd ? <div className="mb-1 text-muted-foreground">{item.cwd}</div> : null}
        <pre className="overflow-x-auto whitespace-pre-wrap break-words">$ {item.command}</pre>
        {item.output ? <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-muted-foreground">{item.output}</pre> : null}
        {typeof item.exitCode === 'number' ? <div className="mt-1 text-muted-foreground">exit {item.exitCode}</div> : null}
      </div>
    )
  }

  if (item.kind === 'file_change') {
    return (
      <details className="rounded-md border border-border/60 bg-background/70 px-3 py-2 text-xs">
        <summary className="cursor-pointer font-medium">
          File changes <StatusBadge value={item.status} />
        </summary>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words">{formatJson(item.changes)}</pre>
      </details>
    )
  }

  if (item.kind === 'mcp_tool' || item.kind === 'dynamic_tool') {
    const title = item.kind === 'mcp_tool' ? `${item.server}/${item.tool}` : item.tool
    return (
      <details className="rounded-md border border-border/60 bg-background/70 px-3 py-2 text-xs">
        <summary className="cursor-pointer font-medium">
          {title} <StatusBadge value={item.status} />
        </summary>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words">{formatJson(item.arguments)}</pre>
        {'result' in item && item.result !== undefined ? (
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-muted-foreground">{formatJson(item.result)}</pre>
        ) : null}
        {'contentItems' in item && item.contentItems ? (
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-muted-foreground">{formatJson(item.contentItems)}</pre>
        ) : null}
      </details>
    )
  }

  if (item.kind === 'collab_agent') {
    return (
      <div className="rounded-md border border-border/60 bg-background/70 px-3 py-2 text-xs">
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
      <div className="rounded-md border border-border/60 bg-background/70 px-3 py-2 text-xs">
        <div className="font-medium">Web search</div>
        <div className="mt-1 whitespace-pre-wrap">{item.query}</div>
      </div>
    )
  }

  if (item.kind === 'image_view') {
    return (
      <div className="rounded-md border border-border/60 bg-background/70 px-3 py-2 text-xs">
        <div className="font-medium">Image</div>
        <div className="mt-1 break-all text-muted-foreground">{item.path}</div>
      </div>
    )
  }

  if (item.kind === 'image_generation') {
    return (
      <div className="rounded-md border border-border/60 bg-background/70 px-3 py-2 text-xs">
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
      <div className="rounded-md border border-border/60 bg-background/70 px-3 py-2 text-xs">
        {item.event === 'entered' ? 'Entered review mode' : 'Exited review mode'}
        {item.review ? <span className="text-muted-foreground"> · {item.review}</span> : null}
      </div>
    )
  }

  return (
    <div className="rounded-md border border-border/60 bg-background/70 px-3 py-2 text-xs">
      Context compaction
    </div>
  )
}
