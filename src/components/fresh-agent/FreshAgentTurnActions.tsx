import { useCallback, useState } from 'react'
import { Check, Copy, GitFork, History, MoreHorizontal, Undo2 } from 'lucide-react'
import { copyText } from '@/lib/clipboard'
import type { FreshAgentTurn } from '@shared/fresh-agent-contract'
import { stripSystemReminders } from './FreshAgentItemCard'
import type { ActionSheetItem } from './FreshAgentActionSheet'

export function turnPlainText(turn: FreshAgentTurn): string {
  const text = turn.items
    .filter((item): item is Extract<FreshAgentTurn['items'][number], { kind: 'text' }> => item.kind === 'text')
    .map((item) => stripSystemReminders(item.text))
    .filter(Boolean)
    .join('\n\n')
  return text || stripSystemReminders(turn.summary ?? '')
}

export type TurnActionCallbacks = {
  canFork: boolean
  /** kata 1wxv: snapshot-stamped `capabilities.undo` — absent/false hides the icon. */
  canRollback?: boolean
  /** Mid-turn: the advisory pre-flight gate disables the affordance (decision 7). */
  rollbackBusy?: boolean
  canRedo?: boolean
  onForkFromTurn?: (turnId: string) => void
  onRewindToTurn?: (turn: FreshAgentTurn) => void
  onRollbackToTurn?: (turnId: string) => void
  onRedoToTurn?: (turnId: string) => void
}

/**
 * One source of truth for what you can do to a turn — consumed by the mobile
 * action sheet directly and by the desktop unified context menu through the
 * transcript's pane-registered FreshAgentTurnItemsBuilder, so the two
 * surfaces never drift apart.
 */
export function buildTurnActionItems(turn: FreshAgentTurn, callbacks: TurnActionCallbacks): ActionSheetItem[] {
  return [
    {
      label: 'Copy turn text',
      run: () => { void copyText(turnPlainText(turn)) },
    },
    {
      label: 'Fork conversation from here',
      disabled: !callbacks.canFork || !callbacks.onForkFromTurn,
      run: () => callbacks.onForkFromTurn?.(turn.turnId ?? turn.id),
    },
    {
      // kata 1wxv decision 3: "undo to here" — one N-step rollback to just before
      // this user turn. Conversation-only, so deliberately NOT marked `destructive`
      // (the file-rewind sibling owns that flag). Redo rows for the rolled-back
      // bucket are built by the transcript section, not here.
      label: 'Undo to here',
      disabled: callbacks.canRollback !== true || callbacks.rollbackBusy === true || !callbacks.onRollbackToTurn || turn.role !== 'user',
      run: () => callbacks.onRollbackToTurn?.(turn.turnId ?? turn.id),
    },
    {
      label: 'Rewind code to here',
      disabled: callbacks.onRewindToTurn === undefined || turn.role !== 'user',
      destructive: true,
      run: () => callbacks.onRewindToTurn?.(turn),
    },
  ]
}

/**
 * Per-turn affordances. Pointer-capability aware:
 * - hover/fine: a hover toolbar (copy / fork / rewind) — hidden entirely on
 *   no-hover devices via the (hover:none) media variant; right-click is owned
 *   by the global ContextMenuProvider's unified fresh-agent menu (the turn
 *   rows ride in through the pane-registered builder the transcript registers
 *   around buildTurnActionItems);
 * - touch/no-hover: an always-visible ⋯ button (44px target) that opens the
 *   bottom action sheet; long-press on the turn does the same.
 */
export function FreshAgentTurnActions({
  turn,
  canFork,
  canRollback,
  rollbackBusy,
  onForkFromTurn,
  onRollbackToTurn,
  onRewindToTurn,
  onOpenActions,
}: TurnActionCallbacks & {
  turn: FreshAgentTurn
  onOpenActions?: (turn: FreshAgentTurn) => void
}) {
  const [copied, setCopied] = useState(false)
  const canRewind = onRewindToTurn !== undefined && turn.role === 'user'

  const handleCopy = useCallback(async () => {
    const ok = await copyText(turnPlainText(turn))
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }, [turn])

  return (
    <>
      <span
        role="toolbar"
        aria-label="Turn actions"
        className="absolute -top-2.5 right-1 z-10 hidden items-center gap-0.5 rounded-md border border-border bg-popover p-0.5 shadow-md group-hover:inline-flex [@media(hover:none)]:!hidden"
      >
        <button
          type="button"
          onClick={handleCopy}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          aria-label="Copy turn"
          title="Copy turn text"
        >
          {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
        </button>
        {canFork && onForkFromTurn ? (
          <button
            type="button"
            onClick={() => onForkFromTurn(turn.turnId ?? turn.id)}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            aria-label="Fork conversation from here"
            title="Fork conversation from this turn"
          >
            <GitFork className="h-3 w-3" />
          </button>
        ) : null}
        {canRollback && onRollbackToTurn && turn.role === 'user' ? (
          <button
            type="button"
            onClick={() => onRollbackToTurn(turn.turnId ?? turn.id)}
            disabled={rollbackBusy === true}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Undo to here"
            title={`Roll back this turn and everything after “${turn.summary.slice(0, 60)}” — conversation only; files stay as they are`}
          >
            <Undo2 className="h-3 w-3" />
          </button>
        ) : null}
        {canRewind ? (
          <button
            type="button"
            onClick={() => onRewindToTurn?.(turn)}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            aria-label="Rewind code to here"
            title="Rewind code to the checkpoint taken when this message was sent"
          >
            <History className="h-3 w-3" />
          </button>
        ) : null}
      </span>
      {onOpenActions ? (
        <button
          type="button"
          aria-label="Turn actions menu"
          className="absolute right-0 top-0 z-10 hidden h-11 w-11 items-center justify-center rounded-md text-muted-foreground active:bg-accent [@media(hover:none)]:inline-flex"
          onClick={(event) => {
            event.stopPropagation()
            onOpenActions(turn)
          }}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      ) : null}
    </>
  )
}


