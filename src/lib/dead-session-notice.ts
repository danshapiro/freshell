/**
 * Dead-session notice vocabulary (no-modal contract).
 *
 * The dead-copy `reconcileNotice` mint is the DURABLE copy source for a
 * dead-adjudicated terminal pane's one in-buffer explanation line: the
 * fold's dead arm mints it beside the `durable_artifact_missing`
 * restoreError latch, and it stays RESIDENT in the pane content (the
 * Redux store outlives every TerminalView unmount — App's view switch
 * renders Overview/Tabs/Settings in place of the terminal work area, so
 * ordinary navigation destroys the component-side copy records) until
 * the latch clears with it (delta review round 4, finding 1). It is
 * never persisted (persistMiddleware strips `reconcileNotice`), so a
 * reload re-folds the verdict and re-mints.
 *
 * REASON-HONEST: the server also returns `dead_session` with reason
 * `respawn_exhausted` while the session file is PRESENT, so the fold
 * selects the copy from `verdict.reason`. Consumers match the mint by
 * CATEGORY through `isDeadSessionReconcileNotice` — never one string —
 * so the `invalid`-arm and reset notices can never trigger them. The
 * xterm buffer line is a SEPARATE shared const in TerminalView; these
 * copies stay store-side.
 */
export const DEAD_SESSION_RECONCILE_NOTICES = {
  missing: 'Saved session no longer exists on disk.',
  respawnExhausted: 'Saved session could not be resumed.',
} as const

/**
 * The known-missing reason family — the only dead reasons that may claim
 * the session file is gone from disk. Everything else (respawn_exhausted,
 * an absent reason, or a future server's unknown code) maps to the
 * generic "could not be resumed" copy: an unknown reason must never make
 * a disk-loss claim it cannot back (plan Task 2 keying; delta review
 * round 2, finding 2).
 */
const DEAD_SESSION_DISK_LOSS_REASONS: ReadonlySet<string> = new Set([
  'session_not_on_disk',
  'session_file_missing',
])

export function deadSessionReconcileNoticeFor(reason: string | undefined): string {
  return reason !== undefined && DEAD_SESSION_DISK_LOSS_REASONS.has(reason)
    ? DEAD_SESSION_RECONCILE_NOTICES.missing
    : DEAD_SESSION_RECONCILE_NOTICES.respawnExhausted
}

export function isDeadSessionReconcileNotice(notice: string | undefined): boolean {
  return notice === DEAD_SESSION_RECONCILE_NOTICES.missing
    || notice === DEAD_SESSION_RECONCILE_NOTICES.respawnExhausted
}
