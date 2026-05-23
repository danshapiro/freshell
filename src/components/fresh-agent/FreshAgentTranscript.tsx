import type { FreshAgentTurn } from '@shared/fresh-agent-contract'
import { FreshAgentItemCard } from './FreshAgentItemCard'

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

export function FreshAgentTranscript({ turns }: { turns: FreshAgentTurn[] }) {
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-3 py-3" data-context="fresh-agent-transcript">
      {turns.map((turn) => {
        const isUser = turn.role === 'user'
        return (
          <article
            key={turn.id}
            className={isUser
              ? 'max-w-[92%] self-end rounded-xl bg-primary px-4 py-3 text-primary-foreground'
              : 'max-w-[96%] self-start rounded-xl bg-muted px-4 py-3'}
            aria-label={`${getTurnLabel(turn)} transcript turn`}
          >
            <div className="mb-2 flex items-center justify-between gap-2 text-[11px] uppercase tracking-[0.16em] opacity-70">
              <span>{getTurnLabel(turn)}</span>
              {turn.model ? <span>{turn.model}</span> : null}
            </div>
            <div className="space-y-2 text-sm">
              {turn.items.length > 0 ? (
                turn.items.map((item) => <FreshAgentItemCard key={item.id} item={item} />)
              ) : (
                <p className="whitespace-pre-wrap break-words">{turn.summary}</p>
              )}
            </div>
          </article>
        )
      })}
    </div>
  )
}
