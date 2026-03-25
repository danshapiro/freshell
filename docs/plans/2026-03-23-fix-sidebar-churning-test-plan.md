# Fix Sidebar Churning - Test Plan

**Implementation plan:** `docs/plans/2026-03-23-fix-sidebar-churning.md`

**Goal:** Verify that removing `lastActivityAt` and `createdAt` from `comparableItemsEqual()` suppresses unnecessary sidebar broadcasts without breaking legitimate change detection, sort ordering, or client data flow.

---

## Test 1: Unit - `hasSessionDirectorySnapshotChange` returns false when only `lastActivityAt` differs

**File:** `test/unit/server/session-directory/projection.test.ts`
**Type:** Unit (modify existing test)
**Task:** Implementation Plan Task 1, Step 1

The existing test at line 53 (`ignores invisible metadata and project color but still treats lastActivityAt as visible`) asserts that a `lastActivityAt` change from 100 to 101 returns `true`. This assertion must flip to `false` and the test name must be updated to reflect the new contract. Specifically:

- Rename to: `ignores invisible metadata, project color, and timestamp-only changes`
- Keep the first assertion (invisible metadata/color changes return `false`)
- Change the second assertion: `lastActivityAt` 100 -> 101 should now return `false`
- Add a third assertion within the same test: `lastActivityAt` changed alongside identical non-timestamp fields should return `false`

**Passes when:** `comparableItemsEqual()` no longer compares `lastActivityAt`.

---

## Test 2: Unit - `hasSessionDirectorySnapshotChange` returns false when only `createdAt` differs

**File:** `test/unit/server/session-directory/projection.test.ts`
**Type:** Unit (new test)
**Task:** Implementation Plan Task 1, Step 1

Add a new test case:
- Two `ProjectGroup[]` snapshots identical except `createdAt` (e.g., 50 vs 99)
- Assert `hasSessionDirectorySnapshotChange()` returns `false`

**Passes when:** `comparableItemsEqual()` no longer compares `createdAt`.

---

## Test 3: Unit - `hasSessionDirectorySnapshotChange` returns true when sidebar-relevant fields change alongside timestamps

**File:** `test/unit/server/session-directory/projection.test.ts`
**Type:** Unit (new test)
**Task:** Implementation Plan Task 1, Step 1

Add a new test case:
- Two snapshots where `title` changes ('Deploy' -> 'Deploy v2') AND `lastActivityAt` changes (100 -> 200)
- Assert `hasSessionDirectorySnapshotChange()` returns `true`

This is a guard rail: timestamp suppression must not accidentally suppress real changes that happen to coincide with timestamp updates.

**Passes when:** The function still detects non-timestamp field changes even when timestamps also change.

---

## Test 4: Unit - `toSessionDirectoryComparableItem` still includes `lastActivityAt` and `createdAt`

**File:** `test/unit/server/session-directory/projection.test.ts`
**Type:** Unit (existing test - no changes needed)
**Task:** N/A (regression guard)

The existing test at line 17 (`projects only directory-visible fields from a session`) already asserts that `toSessionDirectoryComparableItem()` output includes both `lastActivityAt` and `createdAt`. This test must continue to pass unchanged -- it guards the design decision to keep timestamps on the type and mapping function even though they are excluded from equality.

**Passes when:** No modification to `toSessionDirectoryComparableItem()` or `SessionDirectoryComparableItem` type.

---

## Test 5: Integration - `SessionsSyncService` suppresses broadcast when only timestamps change

**File:** `test/unit/server/sessions-sync/service.test.ts`
**Type:** Integration (new test)
**Task:** Implementation Plan Task 3, Step 1

Add a new test case:
- Create a `SessionsSyncService` with `coalesceMs: 0` (immediate flush mode)
- Publish three snapshots where the same session (`sessionId: 's1'`) has only `lastActivityAt` changing (100 -> 200 -> 300), all other fields identical
- Assert `broadcastSessionsChanged` was called exactly once (the initial publish) -- the subsequent timestamp-only publishes are suppressed

**Passes when:** `hasSessionDirectorySnapshotChange()` (called by `flush()`) returns `false` for timestamp-only diffs.

---

## Test 6: Integration - Update existing `broadcasts only when directory-visible fields change` test

**File:** `test/unit/server/sessions-sync/service.test.ts`
**Type:** Integration (modify existing test at line 164)
**Task:** Implementation Plan Task 3, Step 3

The existing test publishes four snapshots and expects three broadcasts (`[[1], [2], [3]]`):
1. Initial state -> broadcast (revision 1)
2. Token usage / source file / color change -> no broadcast (invisible metadata)
3. `lastActivityAt` 100 -> 101 -> broadcast (revision 2) -- **this must change**
4. `title` 'Deploy' -> 'Deploy v2' -> broadcast (revision 3)

After the fix, publish #3 (timestamp-only) should no longer trigger a broadcast. The expected calls change from `[[1], [2], [3]]` to `[[1], [2]]`:
- Revision 1: initial state
- Revision 2: title change ('Deploy' -> 'Deploy v2')

**Passes when:** `lastActivityAt`-only changes are suppressed in the full `SessionsSyncService` pipeline.

---

## Test 7: E2E - Sidebar DOM stability on `sessions.changed`

**File:** `test/e2e/sidebar-refresh-dom-stability.test.tsx`
**Type:** E2E (existing test - no changes needed)
**Task:** Implementation Plan Task 4, Step 2

The existing test (`keeps unchanged sidebar rows mounted when sessions.changed triggers a background refresh`) verifies that stable sidebar rows are not unmounted and remounted when new sessions arrive via a `sessions.changed` broadcast. This test exercises the client-side rendering path and is orthogonal to the server-side change detection being modified.

This test must continue to pass without modification. It serves as a regression guard ensuring the sidebar DOM stability contract is not broken by the projection changes.

**Passes when:** The existing test passes as-is in the full suite.

---

## Execution order

The tests follow the Red-Green-Refactor TDD cycle specified in the implementation plan:

1. **Red (Task 1):** Write/update Tests 1-3 in `projection.test.ts`. Run them -- they fail because `comparableItemsEqual()` still compares timestamps. Commit.
2. **Green (Task 2):** Remove `lastActivityAt` and `createdAt` from `comparableItemsEqual()`. Run Tests 1-4 -- all pass. Commit.
3. **Refactor (Task 3):** Add Test 5, update Test 6 in `service.test.ts`. Run all sessions-sync tests -- pass. Run full suite -- pass. Commit.
4. **Verify (Task 4):** Run `npm run check` (typecheck + full suite). Confirm Test 7 (e2e sidebar stability) passes. Confirm Test 4 (mapping includes timestamps) passes unchanged.

---

## Files touched

| File | Action |
|------|--------|
| `test/unit/server/session-directory/projection.test.ts` | Modify existing test, add 2 new tests |
| `test/unit/server/sessions-sync/service.test.ts` | Add 1 new test, modify 1 existing test |
| `test/e2e/sidebar-refresh-dom-stability.test.tsx` | No changes (regression guard) |
| `server/session-directory/projection.ts` | Modified by implementation (not by tests) |
