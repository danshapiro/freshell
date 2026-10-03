import { useState } from 'react'
import type { ManagedRuntimeRecoverySummary } from '@shared/managed-runtime'

export type ManagedRuntimeRecoveryCardProps = {
  recoverySummary?: ManagedRuntimeRecoverySummary
  onRetry: () => Promise<void>
  onStartFresh: () => void | Promise<void>
}

/** Whether a managed projection owns the pane's recovery decision. */
export function isManagedRuntimeRecoveryDecision(
  recoverySummary?: ManagedRuntimeRecoverySummary,
): boolean {
  return recoverySummary?.recoveryState === 'blocked'
    || recoverySummary?.recoveryState === 'lost'
}

export function ManagedRuntimeRecoveryCard({
  recoverySummary,
  onRetry,
  onStartFresh,
}: ManagedRuntimeRecoveryCardProps) {
  const [pending, setPending] = useState(false)
  const [actionError, setActionError] = useState<string>()
  const recoveryState = recoverySummary?.recoveryState

  if (recoveryState !== 'blocked' && recoveryState !== 'lost') return null

  const blocked = recoveryState === 'blocked'
  const handleAction = async () => {
    if (pending) return
    setPending(true)
    setActionError(undefined)
    try {
      await (blocked ? onRetry() : onStartFresh())
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The action failed. Try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <div
      role="alert"
      data-testid="managed-runtime-recovery-card"
      className="pointer-events-auto flex items-center justify-between gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm"
    >
      <div className="min-w-0">
        <span>
          {blocked
            ? 'This session needs attention before it can continue.'
            : 'This session could not be recovered. Start a new conversation when you are ready.'}
        </span>
        {actionError ? (
          <span role="status" className="ml-2 text-xs text-amber-700 dark:text-amber-300">
            {actionError}
          </span>
        ) : null}
      </div>
      {blocked ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => void handleAction()}
          className="shrink-0 rounded border border-border/70 px-2 py-1 text-xs"
        >
          {pending ? 'Retrying…' : 'Retry recovery'}
        </button>
      ) : (
        <button
          type="button"
          disabled={pending}
          onClick={() => void handleAction()}
          className="shrink-0 rounded border border-border/70 px-2 py-1 text-xs"
        >
          {pending ? 'Starting…' : 'Start new conversation'}
        </button>
      )}
    </div>
  )
}
