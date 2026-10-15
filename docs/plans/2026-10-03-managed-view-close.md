# Managed views stay closed after a tab close — Implementation Plan

> For agentic workers: execute the tasks in order with a fresh implementer and
> a specification-plus-quality review after each task. Keep the checkboxes and
> run record current.

## User Request

### Requested result
Stop Freshell from recreating shell and coding CLI tabs after they have been
closed by fixing the managed-view recovery root cause, then rebase the working
branch onto remote `main`.

### Explicit constraints
- Treat “Windows” as terminal tabs, per the user's clarification.
- Follow the-usual workflow through independent review and configured
  repository verification.
- Continue routine implementation and verification without pausing for
  progress or routine-choice questions; provide status updates as work
  proceeds.
- Keep the live Freshell server running; do not restart or deploy it.
- Do not create a PR or merge the branch.
- Rebase the feature branch onto fetched `origin/main`.

### Accepted tradeoffs and residuals
- Closing a tab detaches the managed view while leaving its process running
  for a later reopen.
- Automatic-primary view promotion during supervisor startup remains unchanged.

**Goal:** A successful close keeps the local tab or pane closed through later
managed-runtime refreshes, persisted-layout events, and reopen activity, while
the managed process remains available for an explicit reopen.

**Architecture:** Keep the existing managed-view visibility API and durable
pane-close evidence. Before removing a managed representation, resolve its
exact view intent from current local identity or an authoritative inventory
match. If identity, capability, or detachment cannot be confirmed, retain the
local content and report a retryable error. For an ambiguous failed visibility
response, read the exact view and soul revisions and repair a committed detach
back to visible before retaining the local pane. If a later view refuses a
multi-view close, restore earlier successful detaches in reverse order using
their returned fences. A hidden view counts as closed only when its matching
soul is confirmed stopped. Every repair is tied to its local projection so
newer visibility work supersedes it. Serialize each browser's managed visibility
transitions with their associated local layout changes, route the recovery
panel through the same coordinator, and never repair from a stale snapshot.
Protect committed closes from stale own-key layout hydration. Reopen only from
a complete fresh managed identity, reassert the pane as open, and consume only
the saved entry that was restored.

**Tech Stack:** React, Redux Toolkit, TypeScript, Vitest, existing Rust
managed-runtime and WebSocket contracts.

## Global Constraints

- Use pnpm 10.34.5 and the repo-owned test commands.
- Keep the managed process running when its view is detached. Do not alter
  supervisor startup promotion, server recovery policy, or Electron crash
  recovery.
- Keep the live Freshell server on port 3001 running. Do not deploy, restart,
  create a PR, merge, or push this branch.
- Work only in the dedicated worktree and within the requested close/reopen
  behavior. Do not add a server endpoint or persistent machine-state format.
- Keep the configured cloud test backend. Do not silently substitute local
  testing for a configured cloud lane.
- Preserve the User Request block above verbatim.

## Task 1 review repair scope adjustment

The Task 1 review found that the reopen visibility promotion already present in
the branch could consume a saved entry while leaving a local tab whose view
was still detached. To make that existing behavior safe, this repair pulls
forward only the Task 3 reopen contract needed at that seam: complete fresh
inventory preflight with current terminal/create handles, `pane.opened`
assertions for restored panes, promotion confirmation before consuming the
exact saved entry, and rollback of local restoration when promotion fails.
The shared visibility coordinator remains in use. Task 2 persistence and
cross-tab changes, and the separate fallback-matcher change, remain out of
this repair.

After a committed promotion with a failed confirmation read, a retry that
finds a saved managed view already represented locally must either prove the
complete saved pane topology is present or fold the complete saved layout into
the projection tab. Tab-level managed markers select fresh inventory
preflight even when a layout exists, and the current inventory refreshes the
saved pane identities. Redundant projection-only tabs are removed as part of
the fold. A failed visibility confirmation leaves the merged layout and exact
reopen entry in place so the next retry can confirm it. If a projection tab
contains unrelated local panes or is closing, the operation retains the entry
and fails before changing local tabs or layouts. A set of distinct view IDs
alone does not prove that the saved pane topology has been restored.

Local retry matching treats pane view IDs as authoritative and carries the
containing tab view marker for unmarked panes. A tab marker can identify only
its own view; shared terminal handles cannot make that pane represent a
different view. Handle-only inference is accepted only for one fresh automatic
view on the matched soul. For an unmarked saved preferred pane, the saved tab
view marker disambiguates a handle-matched soul only when fresh inventory
confirms that exact view belongs to that soul; sibling-view ambiguity remains
retryable.

## Load-bearing decisions

The immutable base is commit
091b24bf0e0e8c00a9e8e9384db52f0cff9dd2f5. The focused baseline receipt is
/home/dan/code/freshell/.worktrees/.the-usual-logs/managed-view-close/reports/workspace-baseline.md.
It records two unrelated failing tests at base; classify them as pre-existing
only if the same failures recur in final verification.

- F01 and F02 are verified: detachment is durable against ordinary runtime
  activity, and closing a view does not stop its managed process. Keep the
  existing startup promotion and process lifecycle behavior.
- F03 is falsified: a managed terminal can be allocated before the local pane
  receives its view ID, and pane-close evidence does not detach the intent.
  Resolve the view using authoritative terminal/create identity; if allocation
  or projection is still unresolved, retain the pane and allow retry.
- F04 is falsified: a known view plus unavailable managed-runtime capability
  is not a successful detach. Keep its pane/tab until authoritative detachment
  succeeds.
- F05 is falsified as a coherent-snapshot claim. Inventory revision and rows
  are read separately, so equal revisions do not prove identical contents.
  Use only the narrower fence established by the report: in the specified
  unchanged-visibility history, a confirming read after a successful mutation
  and revision-monotonic application fence an older pre-mutation response. Do
  not claim a general snapshot transaction.
- F06 is falsified: delayed own-key storage hydration can restore a just-closed
  pane before the normal persistence debounce. Persist the close promptly and
  keep stale own-key hydration from applying while that close is not durably
  written.
- F07 is falsified: fallback matching may not replace a pane's different,
  nonempty view ID. Existing installation-shared view ownership remains in
  effect; detaching prevents recovery of missing representations but does not
  remove an already-open representation on another client. Per-device view
  ownership is outside this repair.
- F08 is falsified: current locks do not cover reopen and the recovery panel's
  direct visibility write. Serialize client-side visibility writers together
  with their local commit/restore, and make a close requested during promotion
  wait and execute instead of resolving as a no-op. Remove visible rollback
  compensation; retain local content on a partial failure.
- F09 is falsified: reattaching with the same create request does not consume
  durable close evidence. Reassert each restored pane as open through the
  existing pane-open contract.
- F10's original permissive fallback is unproven. Remove reliance on it: a
  failed or incomplete fresh preflight returns before local restore or saved
  entry consumption, then releases the queue so the same entry can be retried.
  This simpler seam was verified as feasible by source inspection.

The detailed source evidence and limits are recorded in
/home/dan/code/freshell/.worktrees/.the-usual-logs/managed-view-close/reports/.

## File responsibilities

- src/store/managedVisibilityCoordinator.ts: expose
  withManagedVisibilityTransition<T>(operation: () => Promise<T>): Promise<T>
  as one FIFO queue shared by this browser's managed visibility writers.
- src/store/tabsSlice.ts: resolve exact managed close targets, coordinate
  visibility transitions, keep content on failure, reopen from authoritative
  identity, and consume the exact restored entry.
- src/store/panesSlice.ts: preserve managed handles and reject recovery
  fallback across different nonempty view IDs.
- src/lib/recovery/managed-runtime-recovery.ts: keep exact view identity while
  matching and updating existing panes.
- src/components/ManagedAgentRecoveryStatus.tsx: route a direct view detach
  through the same serialized store operation as tab and pane close.
- src/store/crossTabSync.ts: reject stale own-key full-layout hydration while
  a local close commit is awaiting durable persistence.
- src/store/persistControl.ts: export
  markLocalClosePersistencePending(), isLocalClosePersistencePending(), and
  clearLocalClosePersistencePending() for the close-write barrier.
- src/store/persistMiddleware.ts: clear the barrier only after a successful
  layout write and stamp each persisted layout with a strictly newer
  persistedAt value.
- src/store/tabRegistrySlice.ts: remove only the exact saved entry restored.
- test/unit/client/store/tabsSlice.managed-runtime-close.test.ts: cover exact
  identity, unavailable capability, close/reopen order, partial failure,
  open evidence, and exact-entry consumption.
- test/unit/client/store/tabsPersistence.test.ts: cover immediate close
  persistence and failed-flush protection.
- test/unit/client/store/crossTabSync.test.ts: cover delayed same-key storage
  events and close-persistence gating.
- test/unit/lib/managed-runtime-recovery.test.ts: cover matching panes that
  carry a different nonempty view ID.
- test/unit/client/components/ManagedAgentRecoveryStatus.test.tsx: cover panel
  routing through the shared store operation.

## Task 1: Resolve and detach managed views before local close

**Files:**
- Create: src/store/managedVisibilityCoordinator.ts
- Modify: src/store/tabsSlice.ts and src/components/ManagedAgentRecoveryStatus.tsx
- Test: test/unit/client/store/tabsSlice.managed-runtime-close.test.ts and
  test/unit/client/components/ManagedAgentRecoveryStatus.test.tsx

**Interface:** the coordinator exports
withManagedVisibilityTransition<T>(operation: () => Promise<T>): Promise<T>.
Task 3 reopen and the no-local-pane recovery-panel action use the same queue.

- [x] Step 1: Add named behavior cases for delayed view projection, still-creating
  allocation, capability loss for a known view, close requested during reopen
  promotion, and direct recovery-panel detach overlapping local close. For every
  failed close case, assert the original local pane or tab remains.
- [x] **Step 2: Run the tests and verify the intended failures**

  Run: pnpm run test:vitest run test/unit/client/store/tabsSlice.managed-runtime-close.test.ts test/unit/client/components/ManagedAgentRecoveryStatus.test.tsx --config config/vitest/vitest.config.ts

  Expected: FAIL because the current code skips unresolved or unavailable view
  intents and lets local close/reopen and panel writes overtake each other.
- [x] **Step 3: Add the client-side transition coordinator**

  Hold its FIFO slot across close evidence, current inventory resolution,
  visibility mutation and confirmation, and the associated local removal.
  Remove the managed-promotion fulfilled-no-op guard. A close that arrives
  during reopen waits for the transition and then runs. Route a no-local-pane
  recovery-panel detach through an exported store thunk using this coordinator;
  local panel targets continue to call the gated close thunks.
- [x] Step 4: Resolve an unprojected view only from one authoritative
  inventory row matched through the pane's terminal ID or create request ID
  to its soul and view. A nonempty local view ID remains authoritative. Add
  coverage for a created terminal whose view projection is delayed and for a
  still-creating terminal whose view has not committed. An ambiguous match,
  unresolved creation, failed inventory request, or unavailable capability
  for a known managed view keeps the pane and sets the existing retryable close
  error. After a successful complete inventory, a settled pane with no managed
  marker or matching managed terminal may use the ordinary close path. Do not
  infer detachment from a missing row or a pane-close ack when creation or
  managed identity is still unresolved.
- [x] Step 5: Detach only views with no other local representation. After a
  successful mutation, fetch and apply a confirming inventory and require the
  target to be detached before removing local content. If a multi-view close
  partly fails, retain the source layout and report the failure, restoring
  earlier successful detaches in reverse order with their returned revision
  fences. For an ambiguous failed mutation, reconcile the exact target through
  its authoritative soul read and repair it to visible with current fences.
  A hidden view counts as confirmed for close only when its matching soul is
  stopped. Reassert retained panes as open after an ambiguous or failed close
  acknowledgement or visibility mutation. A later GET must be applied through
  the existing managed-runtime revision guard; do not infer equal-revision
  snapshot coherence.
- [x] Step 6: Run impacted close, panel, pane-gate, recovery, and tab-bar tests,
  then client typecheck. Refactor while green and obtain an independent task
  review.

  Run: pnpm run test:vitest run test/unit/client/store/tabsSlice.managed-runtime-close.test.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/store/paneCloseGate.test.ts test/unit/client/components/ManagedAgentRecoveryStatus.test.tsx test/unit/client/components/TabBar.test.tsx test/unit/lib/managed-runtime-recovery.test.ts --config config/vitest/vitest.config.ts

  Expected: PASS.

  Run: pnpm run typecheck:client

  Expected: PASS.
- [x] Step 7: Commit the coordinator, close and panel code, the reopen contract
  pulled forward by the Task 1 review repair, and their focused tests with
  focused commit messages.

## Task 2: Protect closed layouts from alternate restore and matching paths

**Files:**
- Modify: src/store/crossTabSync.ts, src/store/persistControl.ts,
  src/store/persistMiddleware.ts, src/store/tabsSlice.ts, and
  src/lib/recovery/managed-runtime-recovery.ts
- Test: test/unit/client/store/crossTabSync.test.ts,
  test/unit/client/store/tabsPersistence.test.ts,
  test/unit/client/store/persistControl.test.ts, and
  test/unit/lib/managed-runtime-recovery.test.ts

- [x] Step 1: Add the same-key stale StorageEvent case after a managed split
  close but before the normal debounce, plus a failed-immediate-flush case.
  Assert that the stale event does not restore the pane and that protection
  ends after a later successful flush. Add automatic-primary and explicit
  views for one soul; a pane with a different nonempty view ID must not be
  claimed through soul, terminal, create-request, or session fallback. Preserve
  fallback adoption when the pane has no view ID.
- [x] **Step 2: Run the tests and verify the intended failures**

  Run: pnpm run test:vitest run test/unit/client/store/crossTabSync.test.ts test/unit/client/store/tabsPersistence.test.ts test/unit/lib/managed-runtime-recovery.test.ts --config config/vitest/vitest.config.ts

  Expected: FAIL because the current own-key path can rehydrate a just-closed
  pane before persistence, and fallback matching can replace another view's
  nonempty identity.
- [x] Step 3: Mark a successful close, pane removal, or replacement as a
  persistence boundary and synchronously request the existing layout flush.
  If storage fails, keep the close-protection marker active until a later
  successful flush. Generate persistedAt monotonically above the current
  authoritative local envelope so an equal-millisecond stale event cannot
  pass the recency check.
- [x] Step 4: In the own-key full-hydration path, do not apply an incoming
  layout while a local close is awaiting durable persistence. Do not advance
  the recency floor for a rejected event. A successful close write advances
  the floor before a previously queued stale event can restore the pane.
- [x] Step 5: Reject fallback matching when a pane has a different nonempty
  view ID; keep the current identity when it matches exactly. Continue
  adopting a pane with no view ID only when existing fallback identity is
  unique and unclaimed.
- [x] Step 6: Run the task tests and client typecheck, refactor while green,
  then obtain an independent task review. The final 13-file close/reopen/panel/
  recovery set passed (436 tests), client typecheck passed, and review 8 passed.

  Run: pnpm run test:vitest run test/unit/client/store/crossTabSync.test.ts test/unit/client/store/tabsPersistence.test.ts test/unit/client/store/persistControl.test.ts test/unit/lib/managed-runtime-recovery.test.ts --config config/vitest/vitest.config.ts

  Expected: PASS.

  Run: pnpm run typecheck:client

  Expected: PASS.
- [x] Step 7: Commit persistence gating, identity matching, and their
  focused tests with a focused commit message.

**Review 2 follow-up repair (2026-10-03):** A second independent review found
that another document sharing the same layout key could flush its stale pane
tree after a close and stamp it newer than the close. The two-store regression
now controls the debounce and StorageEvent delivery, verifies that the closing
store commits even after an unseen shared write, confirms that the stale store
does not rewrite storage or advance its timestamp floor, and checks that its
retained dirty work retries only after applying the close. Close barriers,
layout baselines and timestamp floors are scoped to each store, and in-process
persist broadcasts carry the writer identity. The regression was red before
the repair. After the repair, ten focused suites passed (244 tests), client
typecheck passed, and `git diff --check` passed. The requested independent
review of this follow-up is pending.

**Task 2 review 2 repair (2026-10-03):** Added two-store coverage for a stale
explicit sibling close, a same-key close arriving while the local pane tree is
frozen, an own-key close below a higher foreign-title floor, and an own-key
close that commits after the local close preflight but before its flush. A
conflicting layout discovered at the flush boundary now cancels the unsaved
local close and lets the queued shared topology reconcile after the close
freeze clears. Successful local writes supersede deferred pre-close events;
failed writes leave them queued for retry. Rejected own-key events do not
advance accepted topology/title floors. A separate per-store write-stamp
high-water keeps the next successful timestamp monotonic without authorizing
the rejected payload. Immediate close flushes also retain dirty work and the
close marker when legacy-name evidence capture defers the write. The five
focused suites passed (101 tests), `pnpm run typecheck:client` passed, and
`git diff --check` passed. Independent review of this repair is pending.

**Task 2 review 3 follow-up (2026-10-03):** Close preflight now also refuses a
newer same-key layout whose surviving tab or pane titles differ, since the
close would serialize that older full title map. Late persistence cancellation
after a local pane removal or replacement now waits for shared-layout replay,
then restores `pane.opened` and visible status only for the exact original
managed panes that replay put back. The pane-tree merge uses pane IDs to avoid
folding a former sibling's runtime identity into a restored leaf. Ordinary
detach failures still retain the existing retry behavior. The affected focused
suites passed (313 tests), client typecheck and `git diff --check` passed; the
independent review of this follow-up is pending.

**Task 2 review 4 repair (2026-10-03):** Close and replacement preflight now
refuse newer same-key envelopes that change surviving title metadata, with
checks after each asynchronous boundary. The final flush barrier compares the
full title metadata as well as topology, while excluding only the pane title
that the pane-close or replacement removes. A late tab-close replay restores
managed visibility only if the tab itself survived tombstone hydration.
Replacement now checks the captured pane identity again after releasing its
close freeze, before dispatching the picker replacement. Regressions cover
closeTab with a renamed pane in another surviving tab, replacePane with a
renamed sibling, a sibling title arriving after close preflight, a tombstoned
tab with an orphan pane layout, and a different managed identity replayed at
the replacement thaw boundary. Seven focused suites passed (352 tests),
`pnpm run typecheck:client` passed, and `git diff --check` passed. Independent
review of this repair is pending.

**Task 2 review 5 repair (2026-10-03):** Managed-close compensation now waits
for the visibility queue before reasserting pane-open evidence. After acquiring
the queue it checks that the tab still exists, then rechecks exact pane
identity before restoring managed visibility. A regression holds the queue,
applies a same-key tombstone that leaves an orphan pane layout, then releases
the queue; the orphan receives neither `pane.opened` nor a visible promotion.
The nine focused suites passed (384 tests), client typecheck and
`git diff --check` passed. Independent review of this repair is pending.

**Task 2 review 6 repair (2026-10-03):** Close compensation now fetches and
applies managed inventory inside the visibility queue, then checks that the
original tab and exact pane identity still exist before sending pane-open
evidence. It waits for the correlated pane-open result and rechecks after that
acknowledgement and after the visibility update plus confirming inventory
read. If the original tab disappears, compensation recloses each exact pane
identity and detaches its view only when no active exact view representation
remains; a sibling representation is reopened and kept visible. Regressions
cover tombstones during inventory lookup, pane-open acknowledgement, and the
visible update, plus preservation of a surviving sibling representation.
Thirteen focused suites passed (433 tests), client typecheck and
`git diff --check` passed. Independent review of this repair is pending.

**Task 2 review 7 repair (2026-10-03):** Managed visibility restoration now
promotes each view independently and checks the exact original tab/pane
representation after each mutation. If one view disappears, compensation
closes and detaches only that view when no exact sibling remains, or reopens
the surviving sibling with its own tab identity; remaining restored views are
still promoted. Regressions cover a partial replay that removes view A while
view B remains, both with and without another exact representation of A.
Thirteen focused suites passed (436 tests), client typecheck and
`git diff --check` passed. Independent review 8 passed; its report is
`task-002-final-review8.md` in the usual-sdd report directory.

## Task 3: Reopen only from current identity and clear close evidence

**Status:** Completed and pulled forward into Task 1 after its independent
review found that restoring a managed tab could otherwise consume the saved
entry while leaving the view detached. The close/reopen behavior, regressions,
focused verification, and reviews are recorded in the Task 1 implementation
and review history above; no separate Task 3 implementation commit was needed.

**Files:**
- Modify: src/store/tabsSlice.ts, src/store/panesSlice.ts,
  src/store/tabRegistrySlice.ts, and src/lib/kill-ack.ts only if the existing
  correlated pane-open result cannot be observed by the reopen caller
- Test: test/unit/client/store/tabsSlice.managed-runtime-close.test.ts,
  test/unit/client/store/tabsSlice.reopen.test.ts,
  test/unit/client/store/tabRegistrySlice.test.ts, and
  test/unit/client/lib/kill-ack.test.ts

**Interface:** tabRegistrySlice exports consumeClosedEntry(entry: { tabId: string;
closedAt: number }): reducer action; reopenClosedTab remains the public thunk.

- [x] Step 1: Add cases for unavailable runtime, rejected inventory GET, missing
  view, missing soul, missing terminal handle, conflicting saved view identity,
  queue release and retry, pane-open reassertion for the preserved create
  request, close during promotion, and an unrelated close while reopen waits.
  On failed preflight assert there is no tab/layout mutation, no entry
  consumption, and no terminal-create request.
- [x] **Step 2: Run the reopen tests and verify the intended failures**

  Run: pnpm run test:vitest run test/unit/client/store/tabsSlice.managed-runtime-close.test.ts test/unit/client/store/tabsSlice.reopen.test.ts test/unit/client/store/tabRegistrySlice.test.ts test/unit/client/lib/kill-ack.test.ts --config config/vitest/vitest.config.ts

  Expected: FAIL because current reopen proceeds with stale or partial cached
  identity, omits pane.opened, and pops whichever entry is now on top.
- [x] Step 3: Under the shared managed-visibility coordinator, fetch current
  inventory before changing local tabs, layouts, or the reopen stack. For a
  managed entry, validate every terminal leaf against its exact view and
  running soul and require the current terminal/create identity needed by the
  attach lifecycle. Do not use cached handles after failed or incomplete
  preflight. On failure, leave state and the saved entry untouched, report a
  retryable error, and release both queues in finally.
- [x] Step 4: On a valid preflight, preserve the saved view identity while
  hydrating current handles, restore the local tab, and send pane.opened for
  each restored create request so existing durable close evidence is
  consumed. Keep the existing correlated failure/reconnect retry behavior.
  Promote detached views only after the local representation exists. A later
  promotion failure leaves that local tab usable and the exact entry consumed.
- [x] Step 5: Consume only the captured closed entry keyed by its saved tab ID
  and closedAt value, after local restore. Do not pop an unrelated newer entry.
  Keep the close/reopen coordinator held until open assertion and promotion
  have settled, so a pending close runs afterward rather than being dropped.
- [x] Step 6: Run impacted reopen, close, pane, tab-registry, kill-ack, and
  tab-bar tests, then client typecheck. Refactor while green and obtain an
  independent task review.

  Run: pnpm run test:vitest run test/unit/client/store/tabsSlice.managed-runtime-close.test.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/store/tabsSlice.reopen.test.ts test/unit/client/store/tabsSlice.closed-registry.test.ts test/unit/client/store/tabRegistrySlice.test.ts test/unit/client/store/paneCloseGate.test.ts test/unit/client/components/TabBar.test.tsx test/unit/client/lib/kill-ack.test.ts --config config/vitest/vitest.config.ts

  Expected: PASS.

  Run: pnpm run typecheck:client

  Expected: PASS.
- [x] Step 7: Commit the reopen code and focused tests with the Task 1 review
  repair commits listed above.

## Final verification and review

1. Run the configured full repository suite once on final HEAD with pnpm run
   test. Carry forward only the two base failures in the baseline receipt if
   the same failures recur; investigate every new failure.
2. Run pnpm run typecheck:client and git diff --check on final HEAD.
3. Do not add a browser spec or change server process lifecycle. The behavior
   is exercised at the Redux/API and existing storage-event boundaries; the
   Docker-supervisor browser rig is local-only and excluded from the configured
   cloud lane.
4. Review the complete committed delta independently before returning the
   branch. Do not push, deploy, restart the live server, create a PR, or merge.
