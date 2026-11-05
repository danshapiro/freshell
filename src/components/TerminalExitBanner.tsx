// Lane D1: loud exited-pane presentation for coding-agent terminals.
// - recovering notice (server-driven auto-resume in flight) + cancel
// - error bar + Relaunch after the pane settles exited (non-zero exit)
// - killed-session recovery bar: a clean exit (code 0) whose canonical
//   runtime-owner record folded VACANT (the cross-device-kill shape)
//   surfaces the user-driven Reopen action (the-usual focused fix 2 —
//   never an automatic relaunch)
// - persistent, dismissible crash trace after a successful auto-resume
//   (kata znhn item 1 — replaces the ephemeral 'resumed' strip)
// - persistent, dismissible FreshUnbound stale-session notice (focused
//   repair round 3, Major 2 — the gate's notice naming the refused
//   conversation, carried on terminal.replaced; rendered AHEAD of the
//   generic crash trace because it explains what happened to the
//   conversation)
// Pure presentational: props in, callbacks out — TerminalView owns the render
// conditions and the relaunch dispatch.
import type { AutoResumeNotice } from '../store/terminalLifecycleSlice'
import type { CrashTrace } from '../store/paneTypes'

export interface TerminalExitBannerProps {
  mode: string
  exitCode: number | null
  notice: AutoResumeNotice | null
  crashTrace: CrashTrace | null
  /** Focused repair round 3, Major 2: the gate's stale-id notice naming the
   * refused conversation (the FreshUnbound replacement shape) — a
   * pane-level dismissible notice, mirroring the crash trace. */
  staleSessionNotice?: string | null
  settledDead: boolean
  /** The killed-session recovery shape (the-usual focused fix 2): the pane's
   * canonical runtime-owner record folded VACANT after a clean (code 0)
   * terminal exit — the session is durably stopped (typically killed from
   * another device). The pane surfaces the user-driven reopen action;
   * nothing relaunches automatically. */
  vacantRecovery?: boolean
  /** Flap-circuit-breaker settles only (znhn item 2): successful auto-resumes
   * inside the rolling window, from the settle frame's TYPED field. */
  resumeCycles: number | null
  /** znhn item 5: honest Relaunch copy — true when the pane's sessionRef can
   * resume this conversation (provider matches mode). */
  canResume: boolean
  onRelaunch: () => void
  onCancelAutoResume: () => void
  onDismissCrashTrace: () => void
  onDismissStaleSessionNotice: () => void
}

export function TerminalExitBanner({
  mode,
  exitCode,
  notice,
  crashTrace,
  staleSessionNotice,
  settledDead,
  vacantRecovery,
  resumeCycles,
  canResume,
  onRelaunch,
  onCancelAutoResume,
  onDismissCrashTrace,
  onDismissStaleSessionNotice,
}: TerminalExitBannerProps) {
  if (notice) {
    return (
      <div
        role="status"
        className="flex items-center justify-between gap-2 border-t border-amber-500/30 bg-amber-500/15 px-3 py-1.5 text-sm text-amber-600 dark:text-amber-400"
      >
        <span>
          {mode} crashed (exit {notice.exitCode}) — auto-resuming, attempt {notice.attempt}/{notice.maxAttempts}
        </span>
        <button
          type="button"
          aria-label={`Cancel auto-resume for ${mode}`}
          className="shrink-0 rounded border border-amber-500/40 px-2 py-0.5 text-xs font-medium hover:bg-amber-500/20"
          onClick={onCancelAutoResume}
        >
          Stop
        </button>
      </div>
    )
  }
  if (vacantRecovery) {
    return (
      <div
        role="status"
        data-testid="terminal-vacant-recovery-bar"
        className="flex items-center justify-between gap-2 border-t border-border/60 bg-muted/60 px-3 py-1.5 text-sm text-muted-foreground"
      >
        <span>
          {`${mode} session was stopped${exitCode !== null ? ` (code ${exitCode})` : ''} — ${
            canResume
              ? 'reopen it to resume this conversation'
              // the-usual delta round 6 (rider): with no resumable sessionRef
              // (provider mismatch), resetPaneForReconcileCreate degrades the
              // respawn to a fresh conversation — the sentence must not
              // promise resumption the button's own label already omits.
              : 'reopen it to start a new conversation'
          }`}
        </span>
        <button
          type="button"
          aria-label={`Reopen ${mode} session`}
          className="shrink-0 rounded border border-border/70 px-2 py-0.5 text-xs font-medium hover:bg-muted"
          onClick={onRelaunch}
        >
          {canResume ? 'Reopen — resumes this conversation' : 'Reopen'}
        </button>
      </div>
    )
  }
  if (settledDead) {
    return (
      <div
        role="alert"
        className="flex items-center justify-between gap-2 border-t border-destructive/30 bg-destructive/15 px-3 py-1.5 text-sm text-destructive"
      >
        <span>
          {resumeCycles != null
            ? `${mode} crashed ${resumeCycles} times — auto-resume paused`
            : `process exited${exitCode !== null ? ` (code ${exitCode})` : ''}`}
        </span>
        <button
          type="button"
          aria-label={`Relaunch ${mode} session`}
          className="shrink-0 rounded border border-destructive/40 px-2 py-0.5 text-xs font-medium hover:bg-destructive/20"
          onClick={onRelaunch}
        >
          {canResume ? 'Relaunch — resumes this conversation' : 'Relaunch'}
        </button>
      </div>
    )
  }
  // Focused repair round 3, Major 2: the FreshUnbound stale-session notice —
  // the explanation of what happened to the conversation — renders AHEAD of
  // the generic crash trace (both ride the same replaced fold; after the
  // stale notice is dismissed the crash trace shows). role=status, never
  // alert: e2e happy paths assert alert count 0 (the crash-trace rule).
  if (staleSessionNotice) {
    return (
      <div
        role="status"
        data-testid="stale-session-notice"
        className="flex items-center justify-between gap-2 border-t border-amber-500/30 bg-amber-500/15 px-3 py-1.5 text-sm text-amber-600 dark:text-amber-400"
      >
        <span>{staleSessionNotice}</span>
        <button
          type="button"
          aria-label={`Dismiss ${mode} stale session notice`}
          className="shrink-0 rounded border border-amber-500/40 px-2 py-0.5 text-xs font-medium hover:bg-amber-500/20"
          onClick={onDismissStaleSessionNotice}
        >
          Dismiss
        </button>
      </div>
    )
  }
  if (crashTrace) {
    const d = new Date(crashTrace.resumedAtMs)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return (
      <div
        role="status"
        data-testid="crash-trace"
        className="flex items-center justify-between gap-2 border-t border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-sm text-amber-600 dark:text-amber-400"
      >
        <span>
          {mode} crashed (exit {crashTrace.exitCode}) &amp; auto-resumed at {hh}:{mm}
        </span>
        <button
          type="button"
          aria-label={`Dismiss ${mode} crash notice`}
          className="shrink-0 rounded border border-amber-500/40 px-2 py-0.5 text-xs font-medium hover:bg-amber-500/20"
          onClick={onDismissCrashTrace}
        >
          Dismiss
        </button>
      </div>
    )
  }
  return null
}
