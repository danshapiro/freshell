import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, GitFork, History, MoreHorizontal } from 'lucide-react'
import { copyText } from '@/lib/clipboard'
import type { FreshAgentTurn } from '@shared/fresh-agent-contract'
import { stripSystemReminders } from './FreshAgentItemCard'
import type { ActionSheetItem } from './FreshAgentActionSheet'
import { cn } from '@/lib/utils'

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
  onForkFromTurn?: (turnId: string) => void
  onRewindToTurn?: (turn: FreshAgentTurn) => void
}

/**
 * One source of truth for what you can do to a turn — consumed by the desktop
 * context menu and the mobile action sheet so they never drift apart.
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
 *   no-hover devices via the (hover:none) media variant;
 * - touch/no-hover: an always-visible ⋯ button (44px target) that opens the
 *   bottom action sheet; long-press on the turn does the same.
 */
export function FreshAgentTurnActions({
  turn,
  canFork,
  onForkFromTurn,
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

type ContextMenuState = { x: number; y: number; turn: FreshAgentTurn } | null

/**
 * Floating right-click menu for fine pointers. Touch devices use
 * FreshAgentActionSheet instead (same items via buildTurnActionItems).
 */
export function FreshAgentTurnContextMenu({
  state,
  canFork,
  onForkFromTurn,
  onRewindToTurn,
  onClose,
}: TurnActionCallbacks & {
  state: ContextMenuState
  onClose: () => void
}) {
  useEffect(() => {
    if (!state) return
    const handle = () => onClose()
    document.addEventListener('click', handle)
    document.addEventListener('contextmenu', handle)
    return () => {
      document.removeEventListener('click', handle)
      document.removeEventListener('contextmenu', handle)
    }
  }, [onClose, state])

  if (!state) return null

  const items = buildTurnActionItems(state.turn, { canFork, onForkFromTurn, onRewindToTurn })

  return (
    <div
      role="menu"
      aria-label="Turn context menu"
      className="fixed z-50 min-w-[220px] rounded-md border border-border bg-popover p-1 text-sm shadow-lg"
      style={{
        left: Math.min(state.x, typeof window !== 'undefined' ? window.innerWidth - 240 : state.x),
        top: Math.min(state.y, typeof window !== 'undefined' ? window.innerHeight - 150 : state.y),
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          className={cn(
            'block w-full rounded px-3 py-1.5 text-left transition-colors',
            item.disabled ? 'cursor-not-allowed opacity-40' : 'hover:bg-accent hover:text-accent-foreground',
          )}
          onClick={() => {
            onClose()
            if (!item.disabled) item.run()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

export type { ContextMenuState as FreshAgentTurnContextMenuState }
