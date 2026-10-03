import { useState } from 'react'
import type { LaunchFailure } from '@/store/paneTypes'

/**
 * Typed recoverable launch-failure card (kata b8ke) — the stuck-card
 * pattern (role="alert", real buttons, aria-labels). Rendered by
 * TerminalView when the pane carries a typed `launchFailure` (a create
 * refusal with the additive owner fields); the frozen xterm notice still
 * happens for the byte-frozen wire-text contract, this card adds the
 * recoverable actions.
 *
 * b8ke ext r16 F3: the SESSION_MISSING arm renders the typed recoverable
 * missing state — "the durable session is gone" — with the explicit
 * "Start fresh" action as the ONLY new-session path (operator-initiated,
 * clearly a NEW conversation, never a resume; the server no longer
 * auto-substitutes a replacement session).
 */
export function TerminalLaunchFailureCard({ failure, onRetry, onAttach, onOpenFresh, onStartFresh }: {
  failure: LaunchFailure
  onRetry: () => void
  onAttach?: () => void
  onOpenFresh?: () => void
  onStartFresh?: () => void | Promise<void>
}) {
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string>()
  const sessionMissing = failure.code === 'SESSION_MISSING'
  const handleStartFresh = async () => {
    if (starting || !onStartFresh) return
    setStarting(true)
    setStartError(undefined)
    try {
      await onStartFresh()
    } catch (error) {
      setStartError(error instanceof Error ? error.message : 'Cleanup failed. Your conversation has been kept.')
    } finally {
      setStarting(false)
    }
  }
  return (
    <div
      role="alert"
      data-testid="terminal-launch-failure-card"
      aria-label={`Launch failed: ${failure.code}`}
      className="pointer-events-auto absolute inset-x-0 top-0 z-20 m-2 flex items-center justify-between gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm"
    >
      <div>
        <span>{failureTitle(failure)}</span>
        {startError ? <span role="status" className="ml-2 text-xs text-amber-700 dark:text-amber-300">{startError}</span> : null}
      </div>
      <div className="flex shrink-0 gap-2">
        {failure.terminalId !== undefined && onAttach !== undefined ? (
          <button
            type="button"
            className="shrink-0 rounded border border-border/70 px-2 py-1 text-xs"
            aria-label="Attach to running session"
            onClick={onAttach}
          >
            Attach to running session
          </button>
        ) : null}
        {failure.retryable ? (
          <button
            type="button"
            className="shrink-0 rounded border border-border/70 px-2 py-1 text-xs"
            aria-label="Retry launch"
            onClick={onRetry}
          >
            Retry launch
          </button>
        ) : null}
        {failure.ownerKind === 'fresh-agent' && onOpenFresh !== undefined ? (
          <button
            type="button"
            className="shrink-0 rounded border border-border/70 px-2 py-1 text-xs"
            aria-label="Open as Fresh Agent"
            onClick={onOpenFresh}
          >
            Open as Fresh Agent
          </button>
        ) : null}
        {sessionMissing && onStartFresh !== undefined ? (
          <button
            type="button"
            className="shrink-0 rounded border border-amber-500/70 px-2 py-1 text-xs"
            aria-label="Start a fresh conversation (a new session — the old one is gone)"
            data-testid="terminal-launch-failure-start-fresh"
            disabled={starting}
            onClick={() => void handleStartFresh()}
          >
            {starting ? 'Starting…' : 'Start fresh'}
          </button>
        ) : null}
      </div>
    </div>
  )
}

function failureTitle(failure: LaunchFailure): string {
  if (failure.code === 'SESSION_MISSING') {
    return failure.message || 'The durable session is gone. No replacement was started.'
  }
  if (failure.ownerKind === 'fresh-agent') {
    return 'This session is open as a Fresh Agent pane on the server.'
  }
  if (failure.ownerKind === 'terminal') {
    return failure.message
  }
  return failure.message
}
