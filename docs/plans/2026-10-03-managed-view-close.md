# Managed views stay closed after a tab close

## Request

Prevent managed shell and coding CLI tabs from returning after the user closes
them. The close should detach the saved view while leaving its managed process
running in the background.

## Evidence and cause

The managed runtime inventory still reports a closed tab's view as `visible`
and its soul as `running`. Client recovery creates any missing visible view on
runtime refresh. The normal tab-close path writes pane-close evidence and
removes the local tab, but never updates the managed view intent. The separate
managed recovery panel does update visibility, which confirms the available
server mutation and intended `detached` state.

The recent full base gate has one known failure on `origin/main`:
`rust-only-server-runtime.test.ts` reports the existing stale
`service-systemd-supervisor` manifest row. The same failure is recorded in
`docs/plans/2026-09-30-terminal-replay-credit.md`. The implementation will
retain this baseline result and report it separately from change verification.

## Intended behavior

1. Once the existing pane-close acknowledgement succeeds, the shared `closeTab`
   flow finds managed view intents represented by the tab and persists their
   visibility as `detached` before removing local state.
2. If a visibility update fails, keep the tab and re-assert its pane-open
   evidence. Do not stop or restart the managed process.
3. The recovery panel routes an open tab through `closeTab` so it cannot send a
   duplicate stale-revision mutation. It may still detach an inventory view
   that has no local tab.
4. `Reopen closed tab` makes detached managed views visible again before
   restoring their local layout, preserving explicit user intent.

## Work and checks

1. Add focused client tests for managed view detachment through `closeTab`,
   multiple and repeated view references, failure keeping the tab, process
   intent remaining running, recovery not recreating a detached missing view,
   and reopening promoting the view back to visible.
2. Implement the smallest shared close/reopen integration, retaining existing
   pane-close acknowledgement and retry behavior. Keep API calls behind the
   existing managed-runtime visibility helper.
3. Review the plan and implementation independently; run focused tests and the
   configured full repo gate. Record the pre-existing base failure distinctly.

## Scope boundaries

Do not change Electron crash recovery, process lifecycle, server recovery
semantics, or the user's saved machine state. Do not restart the live Freshell
server or create a PR.
