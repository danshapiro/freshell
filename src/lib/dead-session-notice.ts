/**
 * Terminal restore-notice vocabulary (no-modal contract).
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
 * The unreadable-store mint (SESSION_STORE_UNREADABLE_RECONCILE_NOTICE,
 * auto-restore-warming delta fix finding 1) is the sibling category: the
 * terminal fold's error{session_store_unreadable} arm mints it beside the
 * same-named restoreError latch, and TerminalView's notice-line machinery
 * renders it the same way. Fresh-agent panes never mint either category
 * (FreshAgentView renders the restoreError copy directly).
 *
 * REASON-HONEST: the server also returns `dead_session` with reason
 * `respawn_exhausted` while the session file is PRESENT, so the fold
 * selects the copy from `verdict.reason`. Consumers match the mint by
 * CATEGORY through `isDeadSessionReconcileNotice` /
 * `isSessionStoreUnreadableReconcileNotice` — never one string — so the
 * `invalid`-arm and reset notices can never trigger them. The xterm
 * buffer lines are SEPARATE shared consts in TerminalView; these copies
 * stay store-side.
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

/**
 * Unreadable-store notice copy (auto-restore-warming delta fix, finding 1;
 * focused review round 3, finding 2): the terminal-pane sibling of the
 * dead-copy mint. A pane whose verdict is error{session_store_unreadable}
 * (the index PUBLISHED but this identity's store could not be read) gets
 * ONE in-buffer explanation line through the SAME no-modal machinery —
 * visible with no user interaction, cleared with the latch by the
 * recovery folds. Plain and honest: names the unreadable store, claims
 * ONLY what the verdict proves (the session IDENTITY is preserved — the
 * saved conversation itself may be lost if the store is damaged; never
 * an unproven blanket preservation claim), and says how recovery happens
 * (a reconnect retries once the store is readable).
 */
export const SESSION_STORE_UNREADABLE_RECONCILE_NOTICE =
  'Saved session store could not be read - the session identity is preserved, but its saved conversation may be lost. Reconnecting will retry once the store is readable.'

export function isSessionStoreUnreadableReconcileNotice(notice: string | undefined): boolean {
  return notice === SESSION_STORE_UNREADABLE_RECONCILE_NOTICE
}

/**
 * True for a DURABLE restore-notice mint (dead or unreadable-store): the
 * copy stays RESIDENT in the pane content exactly as long as the
 * restoreError latch it explains, and the recovery folds clear it together
 * with the latch (foldLiveTerminalAttach / resetPaneForReconcileCreate).
 * One-shot notices (corrected/duplicate/fresh/invalid copies) keep their
 * own anchor-scoped lifecycle and are NOT durable mints.
 */
export function isDurableRestoreNoticeMint(notice: string | undefined): boolean {
  return isDeadSessionReconcileNotice(notice) || isSessionStoreUnreadableReconcileNotice(notice)
}
