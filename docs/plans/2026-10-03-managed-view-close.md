# Managed views stay closed after a tab close

## Request

Prevent client inventory refreshes from recreating managed shell and coding CLI
tabs after the user closes them. The close should detach the saved view while
leaving its managed process running in the background.

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
   flow finds managed view intents represented by the tab and reads current
   revisions from the supervisor inventory before persisting visibility as
   `detached`.
2. Before removing local state, the close flow reads and dispatches a fresh
   inventory snapshot, verifies all target views are no longer visible, and
   thereby advances the Redux inventory revision. This makes any older in-flight
   visible snapshot too old to recreate the tab. If mutation or verification
   fails, keep the tab and re-assert pane-open evidence. Do not stop or restart
   the managed process.
3. Deduplicate repeated references to the same view. If a multi-view tab only
   partially detaches, keep it open; already-detached views stay detached, and
   a retry reads current revisions and completes the remaining visible views.
4. The recovery panel routes an open tab through `closeTab` so it cannot send a
   duplicate stale-revision mutation. It may still detach an inventory view
   that has no local tab.
5. `Reopen closed tab` restores its local tab and layout before making detached
   managed views visible again. Inventory refreshes during that request then
   match the restored local pane instead of creating a second tab. The reopen
   entry is consumed when the local restore succeeds; if visibility promotion
   fails, leave the restored tab open and log the failure so Alt+H cannot create
   a duplicate.

## Boundary

The supervisor currently promotes automatic-primary views to visible on its
own startup. This change addresses client refresh and reconnect recreation while
the supervisor remains running; it does not change that separate server-startup
policy. Changing the startup policy needs a separate decision about whether an
automatic managed view should return after a server restart.

## Work and checks

1. Add focused client tests for managed view detachment through `closeTab`,
   multiple and repeated view references, partial failure and retry, process
   intent remaining running, recovery not recreating a detached missing view,
   an old delayed inventory response after close, and reopening promoting the
   view back to visible without creating a second tab.
2. Implement the smallest shared close/reopen integration, retaining existing
   pane-close acknowledgement and retry behavior. Keep API calls behind the
   existing managed-runtime visibility helper.
3. Review the plan and implementation independently; run focused tests and the
   configured full repo gate. Record the pre-existing base failure distinctly.

## Scope boundaries

Do not change Electron crash recovery, process lifecycle, server recovery
semantics, or the user's saved machine state. Do not restart the live Freshell
server or create a PR.
