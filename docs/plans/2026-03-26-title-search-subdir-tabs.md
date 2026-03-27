# Sidebar Title Search Subdirectory And Open-Tab Search Behavior Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the already-started sidebar search feature by preserving the shipped leaf-directory title matching and match-aware open-tab visibility, while fixing the remaining refresh drift bug so direct and queued refreshes revalidate only the visible result set without mutating requested search state or aborting a pending browse/search replacement.

**Architecture:** Keep the existing user-facing search behavior already present on this branch: title-tier search matches the leaf subdirectory, fallback open tabs only appear when they locally prove a title-tier match, and applied search disables tab pinning. The remaining work is architectural: make replacement commits and visible-refresh commits distinct reducer contracts, add an explicit monotonic visible result-set token to sidebar window state, and make both `refreshActiveSessionWindow()` and queued invalidations refresh by visible-result identity instead of routing back through the generic replacement path.

**Tech Stack:** React 18, Redux Toolkit, TypeScript, shared utilities, Vitest, Testing Library

---

## Behavior Contract

- Title-tier search must continue to match `title`, then the project-path leaf subtitle, then a distinct `cwd` leaf, then `summary` and `firstUserMessage`.
- Only leaf directory names are searchable for the new metadata behavior. `/home/user/code/trycycle` matches `trycycle`; it does not match `code` unless some other searchable field independently matches `code`.
- During an applied search, open-tab fallback rows appear only when local metadata proves a title-tier match. Deep-search tiers remain server-authoritative and must not inject fallback rows.
- During an applied search, `hasTab` must not pin rows above other matches. Archived-last behavior still applies.
- `query/searchTier` represent the next requested sidebar state. `appliedQuery/appliedSearchTier` represent the result set currently displayed.
- Clearing the search box starts a browse replacement immediately, but the visible list stays on the old applied search result set until browse data commits.
- Visible refreshes are not replacement requests. They revalidate whatever result set is currently on screen and must not:
  - rewrite requested `query/searchTier`
  - abort or replace the controller for a pending replacement request
  - discard a pending replacement request when refresh data commits
- Visible-refresh commit eligibility must be based on visible result-set identity only: `appliedQuery`, `appliedSearchTier`, and a monotonic committed result-set token captured when the refresh starts.
- If a newer commit replaces the visible result set before an older refresh resolves, the stale refresh must be dropped.

## File Structure

- Modify: `src/store/sessionsSlice.ts`
  Responsibility: model committed result-set identity explicitly and give replacement commits and visible-refresh commits different reducer entry points.
- Modify: `src/store/sessionsThunks.ts`
  Responsibility: keep replacement requests abort-driven and make direct/queued refreshes use a separate visible-refresh flow keyed to committed visible identity.
- Modify: `test/unit/client/store/sessionsSlice.test.ts`
  Responsibility: lock the reducer contract for requested state, applied state, result-set identity, and loading preservation.
- Modify: `test/unit/client/store/sessionsThunks.test.ts`
  Responsibility: lock the refresh-vs-replacement thunk contract, including the direct-refresh drift bug that is still open.
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`
  Responsibility: prove the real sidebar keeps visible search results stable during drift, keeps refresh silent, and still lets the pending browse replacement commit afterward.

## Strategy Gate

- Do not rework the already-landed leaf-directory matcher or selector fallback policy unless a regression test proves a real bug. The branch already contains `shared/session-title-search.ts`, server search wiring, and applied-search fallback gating; the remaining blocker is the refresh pipeline.
- Do not keep using ambiguous reducer flags as the primary abstraction. `preserveRequestedSearch` / `preserveLoading` are acceptable only as compatibility shims during the refactor; the final reducer API must make replacement commits and visible-refresh commits obviously different operations.
- Do not route `refreshActiveSessionWindow()` through `fetchSessionWindow()`. That path owns requested state and the surface abort controller, which is exactly what broke the search-to-browse drift contract.
- Do not key refresh safety to requested `query/searchTier`. Requested state is future intent and is allowed to drift while the old result set remains visible.
- Do not use wall-clock timing as the conceptual identity of a visible result set. Add an explicit monotonic token on the sidebar window state so tests can assert stale-refresh dropping without depending on `Date.now()`.
- Do not touch `Sidebar.tsx`, `sidebarSelectors.ts`, shared matcher code, or server search code unless the focused regression runs in Task 2 show a real failure there.

### Task 1: Make Sidebar Window Commits Explicit In The Reducer

**Files:**
- Modify: `src/store/sessionsSlice.ts`
- Modify: `test/unit/client/store/sessionsSlice.test.ts`

- [ ] **Step 1: Write the failing reducer tests for explicit commit types**

In `test/unit/client/store/sessionsSlice.test.ts`, replace the flag-oriented reducer coverage with tests that prove these exact contracts:

- replacement loading updates requested `query/searchTier` immediately, preserves `appliedQuery/appliedSearchTier`, and does not bump the committed result-set token
- replacement commit updates `projects`, requested state, applied state, clears loading, and increments the committed result-set token
- visible-refresh commit updates `projects` and the committed result-set token, preserves requested `query/searchTier`, preserves an in-flight replacement loading state when requested, and keeps `appliedQuery/appliedSearchTier` on the refreshed visible context
- replacement failure preserves the last applied context and the current committed result-set token

Make the tests name the new state field directly. Use `resultVersion` unless an equivalent explicit monotonic name is already present after refactor.

- [ ] **Step 2: Run the targeted reducer tests to verify they fail**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
FRESHELL_TEST_SUMMARY="task1 explicit sidebar reducer commits" \
  npm run test:vitest -- \
  test/unit/client/store/sessionsSlice.test.ts
```

Expected: FAIL because the reducer still relies on one generic data commit shape plus preservation flags, and it does not yet expose an explicit committed result-set token.

- [ ] **Step 3: Refactor the reducer around explicit replacement and visible-refresh commits**

In `src/store/sessionsSlice.ts`:

- add an explicit monotonic committed result-set token on `SessionWindowState`

```ts
resultVersion?: number
```

- keep `setSessionWindowLoading()` as the replacement-start action that writes requested `query/searchTier`
- replace the generic “one payload fits both cases” data commit shape with two explicit reducer actions:

```ts
commitSessionWindowReplacement(...)
commitSessionWindowVisibleRefresh(...)
```

- make `commitSessionWindowReplacement(...)`:
  - write `projects`, paging metadata, and error/loading cleanup
  - advance both requested and applied `query/searchTier`
  - increment `resultVersion`
- make `commitSessionWindowVisibleRefresh(...)`:
  - write `projects`, paging metadata, and clear any refresh error
  - preserve requested `query/searchTier`
  - keep `appliedQuery/appliedSearchTier` on the refreshed visible context
  - preserve replacement loading state when instructed by the thunk
  - increment `resultVersion`
- keep top-level active-surface syncing behavior unchanged

- [ ] **Step 4: Re-run the targeted reducer tests to verify they pass**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
FRESHELL_TEST_SUMMARY="task1 explicit sidebar reducer commits" \
  npm run test:vitest -- \
  test/unit/client/store/sessionsSlice.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify the reducer seam**

After the tests are green:

- remove leftover flag-only branches that no longer express the primary contract
- keep reducer names and payload shapes self-describing enough that a future thunk bug cannot “accidentally” use the wrong commit path

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
FRESHELL_TEST_SUMMARY="task1 reducer seam verification" \
  npm run test:vitest -- \
  test/unit/client/store/sessionsSlice.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
git add \
  src/store/sessionsSlice.ts \
  test/unit/client/store/sessionsSlice.test.ts
git commit -m "refactor: split sidebar replacement and refresh commits"
```

### Task 2: Rebuild Sidebar Refresh Flow Around Visible Result-Set Identity

**Files:**
- Modify: `src/store/sessionsThunks.ts`
- Modify: `test/unit/client/store/sessionsThunks.test.ts`
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`

- [ ] **Step 1: Write the failing thunk and end-to-end regressions**

In `test/unit/client/store/sessionsThunks.test.ts`, add or tighten coverage that proves:

- `refreshActiveSessionWindow()` during search-to-browse drift does **not** call the replacement path contract:
  - the already-started browse `fetchSidebarSessionsSnapshot()` stays the only in-flight browse replacement
  - its `AbortSignal` is still not aborted after the direct refresh completes
  - requested `query` stays cleared while `appliedQuery` stays on the visible search result set
  - the pending browse replacement still resolves and commits after the direct refresh
- `queueActiveSessionWindowRefresh()` obeys the same invariants during the same drift
- a visible refresh captures `{ appliedQuery, appliedSearchTier, resultVersion }` at start and still commits when requested state drifts again but the visible result set has not changed
- a stale visible refresh is dropped when a newer replacement or refresh commit increments `resultVersion` before the old refresh resolves
- direct refresh without drift still uses the visible applied context and remains background/silent rather than “new search” chrome

In `test/e2e/open-tab-session-sidebar-visibility.test.tsx`, strengthen the existing direct-refresh scenario so it asserts:

- clearing the search box starts one browse replacement request and leaves the old search results visible
- dispatching `refreshActiveSessionWindow()` during that drift keeps the search result rows visible and keeps the search indicator silent
- after the direct refresh resolves, the browse replacement still commits and the applied search state finally clears

- [ ] **Step 2: Run the targeted thunk and e2e tests to verify they fail**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
FRESHELL_TEST_SUMMARY="task2 visible refresh identity contract" \
  npm run test:vitest -- \
  test/unit/client/store/sessionsThunks.test.ts \
  test/e2e/open-tab-session-sidebar-visibility.test.tsx
```

Expected: FAIL because `refreshActiveSessionWindow()` still routes through `fetchSessionWindow()`, which rewrites requested state and aborts the pending replacement controller.

- [ ] **Step 3: Refactor the thunks to separate replacement requests from visible refreshes**

In `src/store/sessionsThunks.ts`:

- keep `fetchSessionWindow()` as the explicit browse/search replacement path and the only path that owns the surface abort controller in `controllers`
- introduce an explicit visible-result identity helper:

```ts
type VisibleResultIdentity = {
  query: string
  searchTier: SearchOptions['tier']
  resultVersion: number
}
```

- capture visible refresh identity from `appliedQuery`, `appliedSearchTier`, and the committed `resultVersion`
- make the visible-refresh helper:
  - fetch using the visible applied context
  - commit through `commitSessionWindowVisibleRefresh(...)`
  - decide stale-vs-valid using only the captured visible identity
  - never rewrite requested `query/searchTier`
  - never abort or replace the controller for a pending replacement request
- update `refreshActiveSessionWindow()` to call the visible-refresh helper directly instead of dispatching `fetchSessionWindow()`
- keep `queueActiveSessionWindowRefresh()` queue-based, but make queued invalidations use the same visible-refresh helper whenever they are revalidating what is already on screen
- preserve current two-phase deep search behavior and browse pagination behavior for replacement requests

- [ ] **Step 4: Re-run the targeted thunk and e2e tests to verify they pass**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
FRESHELL_TEST_SUMMARY="task2 visible refresh identity contract" \
  npm run test:vitest -- \
  test/unit/client/store/sessionsThunks.test.ts \
  test/e2e/open-tab-session-sidebar-visibility.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Refactor and run the broader regression suite**

After the targeted tests are green:

- remove any remaining helper path that infers visible refresh safety from requested `query/searchTier`
- confirm the refactor did not regress the already-landed user-facing feature behavior in shared matcher, server search, selector gating, and sidebar rendering

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
FRESHELL_TEST_SUMMARY="task2 title-search subdir regressions" \
  npm run test:vitest -- \
  test/unit/shared/session-title-search.test.ts \
  test/unit/server/session-directory/service.test.ts \
  test/integration/server/session-directory-router.test.ts \
  test/unit/client/store/selectors/sidebarSelectors.test.ts \
  test/unit/client/components/Sidebar.test.tsx \
  test/e2e/sidebar-search-flow.test.tsx \
  test/e2e/open-tab-session-sidebar-visibility.test.tsx \
  test/unit/client/store/sessionsSlice.test.ts \
  test/unit/client/store/sessionsThunks.test.ts
npm run lint
FRESHELL_TEST_SUMMARY="final verification for title-search subdir tabs" npm run check
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
git add \
  src/store/sessionsThunks.ts \
  test/unit/client/store/sessionsThunks.test.ts \
  test/e2e/open-tab-session-sidebar-visibility.test.tsx
git commit -m "fix: refresh sidebar results without mutating requested search"
```
