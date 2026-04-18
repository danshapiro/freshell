import { Fragment } from 'react'

type TranscriptTurn = {
  id: string
  role: 'user' | 'assistant'
  items?: Array<{
    id: string
    kind: 'text' | 'thinking' | 'tool_use' | 'tool_result'
    text?: string
    name?: string
    input?: Record<string, unknown>
    content?: unknown
    isError?: boolean
  }>
  summary?: string
}

export function FreshAgentTranscript({ turns }: { turns: TranscriptTurn[] }) {
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-3 py-3" data-context="fresh-agent-transcript">
      {turns.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/60 px-4 py-6 text-sm text-muted-foreground">
          No transcript available yet.
        </div>
      ) : turns.map((turn) => (
        <div
          key={turn.id}
          className={turn.role === 'assistant'
            ? 'max-w-[92%] self-start rounded-xl bg-muted px-4 py-3'
            : 'max-w-[92%] self-end rounded-xl bg-primary px-4 py-3 text-primary-foreground'}
        >
          <div className="mb-2 text-[11px] uppercase tracking-[0.16em] opacity-70">
            {turn.role === 'assistant' ? 'Assistant' : 'You'}
          </div>
          <div className="space-y-2 text-sm">
            {(turn.items ?? []).length > 0 ? (
              turn.items?.map((item) => (
                <Fragment key={item.id}>
                  {item.kind === 'text' || item.kind === 'thinking' ? (
                    <p className="whitespace-pre-wrap break-words">{item.text}</p>
                  ) : null}
                  {item.kind === 'tool_use' ? (
                    <div className="rounded-md border border-border/60 bg-background/70 px-3 py-2 text-xs text-foreground">
                      <div className="mb-1 font-medium">{item.name}</div>
                      <pre className="overflow-x-auto whitespace-pre-wrap break-words">{JSON.stringify(item.input ?? {}, null, 2)}</pre>
                    </div>
                  ) : null}
                  {item.kind === 'tool_result' ? (
                    <div className="rounded-md border border-border/60 bg-background/70 px-3 py-2 text-xs text-foreground">
                      <pre className="overflow-x-auto whitespace-pre-wrap break-words">{typeof item.content === 'string' ? item.content : JSON.stringify(item.content ?? {}, null, 2)}</pre>
                    </div>
                  ) : null}
                </Fragment>
              ))
            ) : (
              <p className="whitespace-pre-wrap break-words">{turn.summary}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
