# Managed views stay closed after a tab close — Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Stop Freshell from recreating shell and coding CLI tabs after they have been
closed by fixing the managed-view recovery root cause.

### Explicit constraints
- Treat “Windows” as terminal tabs, per the user's clarification.
- Follow the-usual workflow through independent review and configured
  repository verification.
- Keep the live Freshell server running; do not restart or deploy it.
- Do not create a PR or merge the branch.

### Accepted tradeoffs and residuals
- Closing a tab detaches the managed view while leaving its process running
  for a later reopen.
- Automatic-primary view promotion during supervisor startup remains unchanged.

**Goal:** Closing a shell or coding CLI tab removes its managed view from the
client without stopping the process or allowing a later runtime inventory
refresh to recreate the tab.

**Architecture:** Route tab close, pane close, and pane replacement through the
existing managed-runtime visibility API. Read current revisions, detach only
views with no remaining local pane, verify the resulting inventory before
removing local state, and compensate on partial failure. Reopen restores the
local tab with current supervisor handles before making views visible again,
and consumes the exact saved entry that was restored.

**Tech Stack:** React, Redux Toolkit, TypeScript, Vitest, Playwright, Rust
managed-runtime API.

## Global Constraints

- Use pnpm 10.34.5 and the repo-owned test commands.
- Keep the managed process running when a view is detached. Do not alter
  supervisor startup promotion, server recovery policy, or Electron crash
  recovery.
- Keep the live Freshell server on port 3001 running. Do not deploy, restart,
  create a PR, merge, or push this branch.
- Keep the implementation within the dedicated worktree and the requested
  managed-view close/reopen behavior.
- Keep the configured cloud test backend. Do not silently substitute local
  testing for a configured cloud lane.
- Do not change persisted machine state or introduce new server endpoints.

---

## Cause and existing evidence

Managed runtime inventory can report a running view as `visible`. Recovery
creates a local tab for any visible view with no matching pane. The ordinary
tab close path already waits for the pane-close acknowledgement and removes the
local tab, but it does not change the view intent to `detached`; a later
inventory refresh therefore sees an unmatched visible view and creates the tab
again. The recovery panel already updates visibility through the existing API.

The immutable base commit is
`091b24bf0e0e8c00a9e8e9384db52f0cff9dd2f5`. The focused baseline receipt is
`/home/dan/code/freshell/.worktrees/.the-usual-logs/managed-view-close/reports/workspace-baseline.md`.
It records two unrelated failing tests at base; classify them as pre-existing
only when they recur in final verification.

## File responsibilities

- `src/store/tabsSlice.ts`: find the removed view intents, serialize visibility
  changes, guard close/replacement, and restore a closed tab.
- `src/store/panesSlice.ts`: preserve current managed terminal handles when
  restoring a local managed-runtime layout.
- `src/store/tabRegistrySlice.ts`: consume one exact entry from the local
  reopen stack.
- `src/components/ManagedAgentRecoveryStatus.tsx`: route a close through the
  view's actual local pane when one exists; retain the existing API path for a
  view with no local pane.
- `test/unit/client/store/tabsSlice.managed-runtime-close.test.ts`: protect
  close, pane representation, failure recovery, inventory races, and reopen
  ordering at the Redux/API boundary.
- `test/unit/client/components/ManagedAgentRecoveryStatus.test.tsx`: protect
  recovery-panel routing when its top-level tab projection is stale.

## Task 1: Detach views before local close

**Files:**
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/components/ManagedAgentRecoveryStatus.tsx`
- Test: `test/unit/client/store/tabsSlice.managed-runtime-close.test.ts`
- Test: `test/unit/client/components/ManagedAgentRecoveryStatus.test.tsx`

**Interfaces:**
- Consume the existing `getManagedRuntimeInventory()` and
  `updateManagedRuntimeViewVisibility(viewId, visibility, expectedRevision, expectedSoulIntentRevision, requestId?)`
  API functions.
- Keep the existing exported `closeTab`, `closePaneWithCleanup`, and
  `replacePaneWithCleanup` thunk interfaces.
- Keep `buildManagedRuntimeMergePlan` as the recovery projection that ignores
  detached views without a local pane.

- [x] **Step 1: Write behavior tests for close and recovery**

  Cover whole-tab close, split-pane close, replacement, duplicate view
  references, shared representations, partial detachment failure and retry,
  delayed stale inventory, concurrent close, stale tab projection, and
  recovery-panel routing.

- [x] **Step 2: Run the focused tests and confirm the missing behavior**

  Run: `pnpm run test:vitest run test/unit/client/store/tabsSlice.managed-runtime-close.test.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/store/paneCloseGate.test.ts test/unit/client/components/ManagedAgentRecoveryStatus.test.tsx test/unit/client/components/TabBar.test.tsx test/unit/lib/managed-runtime-recovery.test.ts --config config/vitest/vitest.config.ts`

  Expected: the new close-path cases fail because closing local state leaves
  its managed view visible in runtime inventory.

- [x] **Step 3: Add the shared close and recovery-panel integration**

  After the close acknowledgement, collect distinct view IDs from current pane
  projections, excluding views still shown elsewhere. Under per-view locks,
  read fresh revisions, set each view to `detached`, read and dispatch a final
  inventory, and verify the targets are no longer visible before removing local
  state. Keep the managed process running. On partial failure, compensate
  visible local views, keep the tab or pane open, and reassert pane-open
  evidence. Treat a current layout as authoritative over stale top-level tab
  metadata.

- [x] **Step 4: Run the focused test set**

  Run: `pnpm run test:vitest run test/unit/client/store/tabsSlice.managed-runtime-close.test.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/store/paneCloseGate.test.ts test/unit/client/components/ManagedAgentRecoveryStatus.test.tsx test/unit/client/components/TabBar.test.tsx test/unit/lib/managed-runtime-recovery.test.ts --config config/vitest/vitest.config.ts`

  Expected: PASS.

- [x] **Step 5: Refactor while green**

  Keep inventory revision handling and per-view close serialization in shared
  helpers. Preserve synchronous behavior for ordinary tabs with no managed
  view IDs.

- [ ] **Step 6: Run impacted-test verification**

  Run the focused command above plus `pnpm run typecheck:client`.

  Expected: PASS.

- [ ] **Step 7: Commit the task**

  Commit the close path, recovery-panel routing, and their focused tests as one
  behavior change after independent task review.

## Task 2: Reopen the selected entry without creating duplicates

**Files:**
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/store/panesSlice.ts`
- Modify: `src/store/tabRegistrySlice.ts`
- Test: `test/unit/client/store/tabsSlice.managed-runtime-close.test.ts`

**Interfaces:**
- `ClosedTabEntry` remains the saved tab, layout, pane-title maps, and
  `closedAt` timestamp.
- Add an exact-entry consumption action keyed by the saved tab ID and
  `closedAt`; do not make reopen depend on removing the current stack top after
  an asynchronous request.
- Keep the public `reopenClosedTab()` thunk interface.

- [ ] **Step 1: Add the delayed-inventory race test**

  Close two managed tabs, begin reopening the newest one with its inventory
  request held, then close a third tab while that request is pending. Resolve
  inventory and verify that local restore removes only the selected saved
  entry; the tab closed during the request remains the next reopen target and
  each saved tab can be restored once.

- [ ] **Step 2: Run the test and verify the intended failure**

  Run: `pnpm run test:vitest run test/unit/client/store/tabsSlice.managed-runtime-close.test.ts --config config/vitest/vitest.config.ts`

  Expected: FAIL because the current unconditional stack pop consumes the
  entry added by the unrelated close and leaves the already restored entry
  available for a duplicate reopen.

- [ ] **Step 3: Consume the captured entry after local restore**

  Add a reducer that locates the selected `ClosedTabEntry` by `tab.id` and
  `closedAt` and removes that element only. Dispatch it after `addTab` and
  `restoreLayout` have committed the local restore. Keep reopen serialization,
  current-handle hydration, and the close-during-promotion guard.

- [ ] **Step 4: Run focused and impacted tests**

  Run: `pnpm run test:vitest run test/unit/client/store/tabsSlice.managed-runtime-close.test.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/store/tabsSlice.reopen.test.ts test/unit/client/store/tabsSlice.closed-registry.test.ts test/unit/client/store/paneCloseGate.test.ts test/unit/client/components/TabBar.test.tsx --config config/vitest/vitest.config.ts`

  Expected: PASS.

- [ ] **Step 5: Refactor while green**

  Use one exact-entry action for successful local restore. Keep visibility
  promotion failure recoverable without restoring the consumed entry or
  reopening a duplicate tab.

- [ ] **Step 6: Run client typecheck**

  Run: `pnpm run typecheck:client`

  Expected: PASS.

- [ ] **Step 7: Commit the task**

  Commit the exact-entry reducer, reopen change, and delayed-request regression
  test with a focused message.

## Final verification and review

1. Run the configured full repository suite once on final `HEAD`:
   `pnpm run test`. Carry forward only the two base failures in the baseline
   receipt when the same failures recur; investigate every new failure.
2. Run `pnpm run typecheck:client` and `git diff --check` on final `HEAD`.
3. Run the configured e2e suite only for any added browser specs. The
   Docker-supervisor browser rig is marked local-only and excluded from the
   configured cloud lane; this change adds no server API or process-lifecycle
   behavior, so close/recovery correctness is covered at the Redux/API
   boundary.
4. Review the complete committed delta independently before returning the
   branch.
