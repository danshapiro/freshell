# Test Plan: Progressive Search

## Strategy Reconciliation

The implementation plan introduces two client-side changes: (1) removing the client-side search bypass so all search goes through the server, and (2) adding two-phase progressive search for deep tiers. No server changes are needed. The testing strategy calls for heavy automated testing at all layers -- unit tests for pure functions, integration tests for Redux thunk+slice interactions, and e2e component tests for the Sidebar UI.

Key observations from the codebase:

- **Existing thunk harness is well-suited.** `test/unit/client/store/sessionsThunks.test.ts` already tests `fetchSessionWindow`, abort semantics, `queueActiveSessionWindowRefresh`, and loading kind classification. The `createDeferred` pattern lets us control phase timing precisely -- essential for testing two-phase search.
- **Existing slice harness covers window state.** `test/unit/client/store/sessionsSlice.test.ts` tests `setSessionWindowData`, `setSessionWindowLoading`, and window surface isolation. Adding `deepSearchPending` tests fits naturally.
- **Existing Sidebar test file has search coverage.** `test/unit/client/components/Sidebar.test.tsx` already tests search tier UI (dropdown, loading indicator, clearing), backend search integration, and the client-side bypass behavior (test at line 2492: "does not call API for title tier (uses local filter)"). Several existing tests need updating since the bypass removal changes behavior.
- **The e2e scaffolding in `test/e2e/sidebar-click-opens-pane.test.tsx` and `test/e2e/sidebar-refresh-dom-stability.test.tsx`** provides patterns for full Redux store + mocked API + component rendering. The new `sidebar-search-flow.test.tsx` file uses this pattern.
- **`mergeSearchResults` is a pure function.** It takes two arrays and returns a merged array. Pure unit tests are ideal here -- fast, deterministic, no mocking.
- **No server test changes needed.** The server already supports all tiers correctly. The prior test plan (`2026-03-16-fix-server-side-search-test-plan.md`) covers server-side search thoroughly.

### Strategy changes from default

None. The plan uses existing test infrastructure throughout. The only new test file is `test/e2e/sidebar-search-flow.test.tsx` for progressive search flow scenarios.

## Harness Requirements

No new harnesses need to be built. All tests use existing infrastructure:

| Harness | File(s) | What it exposes | Tests that depend on it |
|---------|---------|-----------------|------------------------|
| **Thunks unit harness** | `test/unit/client/store/sessionsThunks.test.ts` | Mocked `searchSessions`/`fetchSidebarSessionsSnapshot`, Redux store with `sessionsReducer`, `createDeferred` for controlling async timing, `_resetSessionWindowThunkState` for cleanup | Tests 1-14, 23 |
| **Slice unit harness** | `test/unit/client/store/sessionsSlice.test.ts` | Direct reducer calls with `sessionsReducer`, PayloadAction dispatches | Tests 15-16 |
| **Sidebar component harness** | `test/unit/client/components/Sidebar.test.tsx` | Full React component with Provider, mocked API layer (`searchSessions`, `fetchSidebarSessionsSnapshot`), Testing Library queries, fake timers for debounce control | Tests 17-22 |
| **E2E flow harness** | `test/e2e/sidebar-search-flow.test.tsx` (new file) | Full Redux store with Sidebar component, mocked WS/API, ability to simulate multi-phase search timing | Tests 24-27 |

---

## Test Plan

### Scenario/Integration Tests (Highest Priority)

These tests verify user-visible end-to-end behavior across multiple layers.

### 1. Two-phase fetch dispatches title results immediately, then merged results on Phase 2

- **Name:** Deep-tier search shows title results first, then merged results after file scan
- **Type:** integration
- **Disposition:** new
- **Harness:** Thunks unit harness
- **Preconditions:** Store with `activeSurface: 'sidebar'` and a committed sidebar window. `searchSessions` mock returns deferred promises for both calls.
- **Actions:** Dispatch `fetchSessionWindow({ surface: 'sidebar', priority: 'visible', query: 'needle', searchTier: 'fullText' })`. Resolve Phase 1 (title) with session A (matched in title). Check state. Resolve Phase 2 (fullText) with session B (matched in userMessage). Check state.
- **Expected outcome:** After Phase 1 resolve: `windows.sidebar.projects` contains session A, `deepSearchPending` is `true`. After Phase 2 resolve: `windows.sidebar.projects` contains both session A and session B (merged), `deepSearchPending` is `false`.
- **Interactions:** Exercises `fetchSessionWindow` two-phase path, `mergeSearchResults`, `setSessionWindowData` with `deepSearchPending`.

### 2. Title-tier search uses single-phase path with deepSearchPending false

- **Name:** Title-only search completes in one phase without deep search indicator
- **Type:** integration
- **Disposition:** extend (existing test "passes tier to searchSessions" covers the call but not deepSearchPending)
- **Harness:** Thunks unit harness
- **Preconditions:** Store with active sidebar surface. `searchSessions` mock resolves with title results.
- **Actions:** Dispatch `fetchSessionWindow({ surface: 'sidebar', priority: 'visible', query: 'needle', searchTier: 'title' })`. Await completion.
- **Expected outcome:** `searchSessions` called exactly once with `tier: 'title'`. `windows.sidebar.deepSearchPending` is `false`. Results are set correctly.
- **Interactions:** Exercises single-phase path, confirms `deepSearchPending` default behavior.

### 3. New query aborts both phases of previous two-phase search

- **Name:** Typing a new query cancels in-flight deep search
- **Type:** integration
- **Disposition:** new
- **Harness:** Thunks unit harness
- **Preconditions:** Store with active sidebar. First `searchSessions` call (Phase 1 of query "alpha") returns a deferred.
- **Actions:** Dispatch `fetchSessionWindow` with query "alpha", searchTier "fullText". Do NOT resolve Phase 1. Dispatch a second `fetchSessionWindow` with query "beta", searchTier "fullText".
- **Expected outcome:** The first dispatch's AbortController signal is aborted. The second dispatch proceeds independently. `searchSessions` was called at least twice (one for "alpha" Phase 1, one for "beta" Phase 1). The aborted call's signal is confirmed aborted.
- **Interactions:** Exercises `abortSurface` cancellation across both phases of the old query.

### 4. Phase 2 error preserves Phase 1 results and clears deepSearchPending

- **Name:** File scan failure keeps title results visible and removes scanning indicator
- **Type:** integration
- **Disposition:** new
- **Harness:** Thunks unit harness
- **Preconditions:** Store with active sidebar. Phase 1 mock resolves with session A. Phase 2 mock rejects with an error.
- **Actions:** Dispatch `fetchSessionWindow({ surface: 'sidebar', priority: 'visible', query: 'needle', searchTier: 'fullText' })`. Resolve Phase 1. Reject Phase 2 with `new Error('Deep search failed')`.
- **Expected outcome:** `windows.sidebar.projects` still contains session A from Phase 1. `deepSearchPending` is `false`. `windows.sidebar.error` contains 'Deep search failed'.
- **Interactions:** Exercises Phase 2 error handling in the inner try/catch.

### 5. Phase 1 abort prevents Phase 2 from firing

- **Name:** Aborted title fetch does not trigger file scan
- **Type:** integration
- **Disposition:** new
- **Harness:** Thunks unit harness
- **Preconditions:** Store with active sidebar. Phase 1 mock returns a deferred that never resolves. AbortController from `fetchSessionWindow`.
- **Actions:** Dispatch `fetchSessionWindow` with query "needle", searchTier "fullText". Immediately dispatch another `fetchSessionWindow` (causing abort of the first). Resolve the first deferred (simulating late resolution after abort).
- **Expected outcome:** `searchSessions` from the first dispatch was called only once (Phase 1). Phase 2 never fires because the signal was aborted before Phase 1 resolved. The abort check `if (controller.signal.aborted) return` in the thunk prevents Phase 2.
- **Interactions:** Exercises abort guard between Phase 1 and Phase 2.

### 6. Background refresh with deep tier uses two-phase search

- **Name:** WebSocket invalidation refresh uses progressive search when deep tier is active
- **Type:** integration
- **Disposition:** new
- **Harness:** Thunks unit harness
- **Preconditions:** Store with active sidebar window that has `query: 'needle'` and `searchTier: 'fullText'`. `searchSessions` mock resolves both phases.
- **Actions:** Dispatch `queueActiveSessionWindowRefresh()`. Await completion.
- **Expected outcome:** `searchSessions` was called twice: once with `tier: 'title'`, once with `tier: 'fullText'`. Final state has `deepSearchPending: false` and merged results.
- **Interactions:** Exercises `queueActiveSessionWindowRefresh` -> `fetchSessionWindow` -> two-phase path.

### 7. Tier downgrade from fullText to title cancels in-flight Phase 2

- **Name:** Switching to title tier cancels deep scan and shows only title results
- **Type:** integration
- **Disposition:** new
- **Harness:** Thunks unit harness
- **Preconditions:** Store with active sidebar. Phase 1 (title) resolves. Phase 2 (fullText) returns a deferred that hangs.
- **Actions:** Dispatch `fetchSessionWindow` with query "needle", searchTier "fullText". Resolve Phase 1 (so title results are displayed with `deepSearchPending: true`). Before Phase 2 resolves, dispatch `fetchSessionWindow` with query "needle", searchTier "title" (tier downgrade). Await the second dispatch.
- **Expected outcome:** The first dispatch's signal is aborted (canceling Phase 2). The second dispatch calls `searchSessions` with `tier: 'title'` and completes as single-phase. Final `deepSearchPending` is `false`.
- **Interactions:** Exercises abort-on-tier-change and single-phase fallback.

### 8. mergeSearchResults: deep results overwrite title results with same session key

- **Name:** File scan results replace title matches for the same session
- **Type:** unit
- **Disposition:** new
- **Harness:** Thunks unit harness (exported function)
- **Preconditions:** Title results contain session A with `matchedIn: 'title'`. Deep results contain session A with `matchedIn: 'userMessage'`.
- **Actions:** Call `mergeSearchResults(titleResults, deepResults)`.
- **Expected outcome:** Merged array has one entry for session A. Its `matchedIn` is `'userMessage'` (deep result wins).
- **Interactions:** Pure function test.

### 9. mergeSearchResults: title-only results preserved when absent from deep results

- **Name:** Sessions matching only in title are kept after file scan
- **Type:** unit
- **Disposition:** new
- **Harness:** Thunks unit harness
- **Preconditions:** Title results contain sessions A and B. Deep results contain only session C (a new match found in file content).
- **Actions:** Call `mergeSearchResults(titleResults, deepResults)`.
- **Expected outcome:** Merged array contains sessions A, B, and C (3 entries). A and B retain their title-tier match metadata.
- **Interactions:** Pure function test.

### 10. mergeSearchResults: empty title results with non-empty deep results

- **Name:** File-only matches produce correct results when title search finds nothing
- **Type:** unit
- **Disposition:** new
- **Harness:** Thunks unit harness
- **Preconditions:** Title results array is empty. Deep results contain session A.
- **Actions:** Call `mergeSearchResults([], deepResults)`.
- **Expected outcome:** Merged array has one entry: session A from deep results.
- **Interactions:** Pure function test.

### 11. mergeSearchResults: empty deep results preserves all title results

- **Name:** Empty file scan preserves all title matches
- **Type:** unit
- **Disposition:** new
- **Harness:** Thunks unit harness
- **Preconditions:** Title results contain sessions A and B. Deep results array is empty.
- **Actions:** Call `mergeSearchResults(titleResults, [])`.
- **Expected outcome:** Merged array is identical to title results (2 entries).
- **Interactions:** Pure function test.

### 12. mergeSearchResults: different providers for same sessionId kept separate

- **Name:** Sessions from different providers are not deduplicated
- **Type:** unit
- **Disposition:** new
- **Harness:** Thunks unit harness
- **Preconditions:** Title results contain `claude:session-1`. Deep results contain `codex:session-1` (same sessionId, different provider).
- **Actions:** Call `mergeSearchResults(titleResults, deepResults)`.
- **Expected outcome:** Merged array has 2 entries (one per provider). Neither overwrites the other.
- **Interactions:** Exercises the `provider:sessionId` composite key.

### 13. Phase 2 abort after Phase 1 success preserves Phase 1 data

- **Name:** Aborting file scan mid-flight keeps title results displayed
- **Type:** integration
- **Disposition:** new
- **Harness:** Thunks unit harness
- **Preconditions:** Store with active sidebar. Phase 1 resolves successfully with session A. Phase 2 hangs.
- **Actions:** Dispatch two-phase `fetchSessionWindow` with fullText tier. Resolve Phase 1 (title results displayed, `deepSearchPending: true`). Abort the surface (simulating user clearing search). Check state.
- **Expected outcome:** Phase 1 data (session A) remains in `windows.sidebar.projects`. The abort does not clear the already-committed Phase 1 data. The pending Phase 2 is canceled. (Note: the next dispatch -- browse mode re-fetch or new search -- will replace the data.)
- **Interactions:** Exercises the abort-doesn't-clear-committed-data guarantee.

### 14. Two-phase fetch: non-search dispatches clear deepSearchPending via default

- **Name:** Browse mode fetch clears stale scanning indicator
- **Type:** integration
- **Disposition:** new
- **Harness:** Thunks unit harness
- **Preconditions:** Store with sidebar window where `deepSearchPending: true` (simulating mid-scan state). `fetchSidebarSessionsSnapshot` mock resolves with browse data.
- **Actions:** Dispatch `fetchSessionWindow({ surface: 'sidebar', priority: 'visible' })` (no query -- browse mode).
- **Expected outcome:** `windows.sidebar.deepSearchPending` is `false` after the dispatch completes. The `setSessionWindowData` payload omits `deepSearchPending`, so the reducer defaults it to `false`.
- **Interactions:** Exercises the default-to-false behavior in the reducer.

### Boundary/Edge Case Tests

### 15. setSessionWindowData defaults deepSearchPending to false when omitted

- **Name:** Window data update without explicit deepSearchPending clears the flag
- **Type:** unit
- **Disposition:** new
- **Harness:** Slice unit harness
- **Preconditions:** Session state with a sidebar window where `deepSearchPending: true`.
- **Actions:** Dispatch `setSessionWindowData({ surface: 'sidebar', projects: [...], ... })` without `deepSearchPending` in the payload.
- **Expected outcome:** `state.windows.sidebar.deepSearchPending` is `false`.
- **Interactions:** Pure reducer test.

### 16. setSessionWindowLoading with loading=true clears deepSearchPending

- **Name:** Starting a new search clears stale scanning indicator immediately
- **Type:** unit
- **Disposition:** new
- **Harness:** Slice unit harness
- **Preconditions:** Session state with sidebar window where `deepSearchPending: true`.
- **Actions:** Dispatch `setSessionWindowLoading({ surface: 'sidebar', loading: true, loadingKind: 'search' })`.
- **Expected outcome:** `state.windows.sidebar.deepSearchPending` is `false`.
- **Interactions:** Pure reducer test. Validates the race condition fix described in the implementation plan (new search starts while Phase 2 of old search is pending).

### 17. Title-tier search always dispatches to server (bypass removed)

- **Name:** Title search no longer uses client-side filtering
- **Type:** scenario
- **Disposition:** extend (existing test "does not call API for title tier (uses local filter)" at line 2492 needs to be updated/replaced)
- **Harness:** Sidebar component harness
- **Preconditions:** Sidebar rendered with projects containing sessions. `searchSessions` mock configured. No `sidebarWindow` in initial state (the condition that previously triggered the bypass).
- **Actions:** Type "test" into search input. Keep default tier (title). Advance timers past 300ms debounce.
- **Expected outcome:** `searchSessions` IS called (previously it was NOT called due to the bypass). The mock is called with `tier: 'title'`.
- **Interactions:** Validates bypass removal (Task 0).

### 18. Shows "Scanning files..." when deepSearchPending is true and items are visible

- **Name:** Deep search indicator appears during file scan with visible results
- **Type:** scenario
- **Disposition:** new
- **Harness:** Sidebar component harness
- **Preconditions:** Store with sidebar window containing projects (items visible) and `deepSearchPending: true`. Search input has text.
- **Actions:** Render Sidebar. Query for "Scanning files..." text.
- **Expected outcome:** An element with `role="status"` containing "Scanning files..." is visible. The session list is also visible and interactive (not blocked).
- **Interactions:** Exercises the `showDeepSearchPending` derived state and the conditional rendering.

### 19. Does not show "Scanning files..." when deepSearchPending is false

- **Name:** No scanning indicator when file scan is not running
- **Type:** scenario
- **Disposition:** new
- **Harness:** Sidebar component harness
- **Preconditions:** Store with sidebar window containing search results and `deepSearchPending: false`.
- **Actions:** Render Sidebar with search text. Query for "Scanning files...".
- **Expected outcome:** "Scanning files..." text is NOT in the document.
- **Interactions:** Exercises false branch of the indicator conditional.

### 20. "Scanning files..." indicator has role="status" for accessibility

- **Name:** Deep search indicator is accessible to screen readers
- **Type:** scenario
- **Disposition:** new
- **Harness:** Sidebar component harness
- **Preconditions:** Store with sidebar window with `deepSearchPending: true` and visible items. Search input has text.
- **Actions:** Render Sidebar. Query for the element by `role="status"`.
- **Expected outcome:** Element with `role="status"` exists. It has `aria-live="polite"`. Its text content includes "Scanning files...".
- **Interactions:** Validates WCAG compliance for the scanning indicator.

### 21. Clearing search removes "Scanning files..." indicator

- **Name:** Clearing search dismisses scanning indicator
- **Type:** scenario
- **Disposition:** new
- **Harness:** Sidebar component harness
- **Preconditions:** Sidebar rendered with search active and `deepSearchPending: true` showing the indicator.
- **Actions:** Clear the search input (click the X button or set value to empty).
- **Expected outcome:** "Scanning files..." text disappears (because the clear-search dispatch will trigger `setSessionWindowLoading` which clears `deepSearchPending`, and the non-search `fetchSessionWindow` will set `deepSearchPending: false`).
- **Interactions:** Exercises the clear-search -> abort -> browse-refetch flow.

### 22. Does not show "Scanning files..." when no items are visible (blocking load state)

- **Name:** Scanning indicator hidden during initial blocking search
- **Type:** boundary
- **Disposition:** new
- **Harness:** Sidebar component harness
- **Preconditions:** Store with sidebar window that has `loading: true`, `loadingKind: 'search'`, no projects (empty), and `deepSearchPending: true`.
- **Actions:** Render Sidebar with search text.
- **Expected outcome:** "Scanning files..." is NOT shown. Instead, the blocking "Searching..." spinner is shown (because `showBlockingLoad` takes precedence when there are no items).
- **Interactions:** Validates the indicator hierarchy: blocking load > deep search pending.

### 23. Two-phase fetch: both phases share the same AbortController

- **Name:** Both search phases are canceled atomically
- **Type:** unit
- **Disposition:** new
- **Harness:** Thunks unit harness
- **Preconditions:** Store with active sidebar. `searchSessions` mock captures the signal from each call.
- **Actions:** Dispatch `fetchSessionWindow` with query "needle", searchTier "fullText". Capture the `signal` from the first `searchSessions` call (Phase 1). Resolve Phase 1. Capture the `signal` from the second `searchSessions` call (Phase 2). Dispatch a new `fetchSessionWindow` (triggering abort).
- **Expected outcome:** Both captured signals reference the same AbortController (both are now aborted). Verified by checking `signal.aborted === true` on both.
- **Interactions:** Validates the shared-controller design.

### E2E Flow Tests

### 24. Title-tier search returns server-side results (bypass removed, full flow)

- **Name:** Title search goes through server and renders results
- **Type:** scenario
- **Disposition:** new
- **Harness:** E2E flow harness (`sidebar-search-flow.test.tsx`)
- **Preconditions:** Sidebar rendered with full Redux store. `searchSessions` mock returns results for "deploy" query. No `sidebarWindow` initially (the condition that previously triggered the client-side bypass).
- **Actions:** Type "deploy" into search input. Advance timers past 300ms debounce. Flush promises.
- **Expected outcome:** `searchSessions` was called. Session titles from the mock response are rendered in the sidebar.
- **Interactions:** Full chain: Sidebar component -> useEffect -> debounce -> dispatch fetchSessionWindow -> searchSessions mock -> setSessionWindowData -> re-render with results.

### 25. Deep-tier search shows title results first, then merged results after Phase 2

- **Name:** Progressive search shows instant title results then augments with file matches
- **Type:** scenario
- **Disposition:** new
- **Harness:** E2E flow harness
- **Preconditions:** Sidebar rendered. `searchSessions` mock returns different results for title vs fullText tiers (controlled via deferred promises).
- **Actions:** Type "auth" into search input. Change tier to "fullText". Advance timers past debounce. Resolve Phase 1 (title) mock with session "Auth Design". Verify "Auth Design" is rendered. Verify "Scanning files..." indicator is visible. Resolve Phase 2 (fullText) mock with sessions "Auth Design" (updated) and "Login Bug" (new match). Verify both are rendered. Verify "Scanning files..." is gone.
- **Expected outcome:** Session list progresses: empty -> "Auth Design" (Phase 1) -> "Auth Design" + "Login Bug" (Phase 2). Scanning indicator appears between phases and disappears after Phase 2.
- **Interactions:** Full e2e chain with visual verification at each phase.

### 26. Changing query while deep search is pending aborts the old search

- **Name:** Re-typing during file scan cancels old search and starts fresh
- **Type:** scenario
- **Disposition:** new
- **Harness:** E2E flow harness
- **Preconditions:** Sidebar rendered. First search ("alpha") with fullText tier is in Phase 2 (Phase 1 resolved, "Scanning files..." visible).
- **Actions:** Type "beta" into search input (replacing "alpha"). Advance timers past debounce. Resolve the new Phase 1 for "beta".
- **Expected outcome:** "Scanning files..." from the "alpha" search disappears when the new search loading starts. Results from "beta" Phase 1 are rendered. The old Phase 2 for "alpha" was aborted and its results are never displayed.
- **Interactions:** Exercises abort-on-new-query across the full component stack.

### 27. Clearing search returns to browse mode

- **Name:** Clearing search input restores the browse session list
- **Type:** scenario
- **Disposition:** new
- **Harness:** E2E flow harness
- **Preconditions:** Sidebar rendered with an active deep-tier search showing results and "Scanning files..." indicator.
- **Actions:** Clear the search input (click X button). Advance timers. Flush promises for the browse fetch.
- **Expected outcome:** "Scanning files..." indicator disappears. Search tier dropdown disappears. The sidebar shows browse-mode session list (from `fetchSidebarSessionsSnapshot` mock).
- **Interactions:** Exercises clear-search -> abort -> browse re-fetch flow.

---

## Coverage Summary

### Covered areas

| Area | Tests | Coverage |
|------|-------|----------|
| **`mergeSearchResults` pure function** | 8-12 | Deep overwrite, title preservation, empty inputs, multi-provider dedup |
| **Two-phase fetch in `fetchSessionWindow`** | 1, 2, 3, 5, 6, 7, 13, 14, 23 | Happy path, title-only single-phase, abort semantics, Phase 2 error, tier downgrade, background refresh, shared controller |
| **Phase 2 error handling** | 4 | Error preserves Phase 1, clears pending flag, dispatches error |
| **`deepSearchPending` in sessionsSlice** | 15, 16 | Default-to-false on omission, cleared by setSessionWindowLoading |
| **Sidebar bypass removal (Task 0)** | 17, 24 | Title search dispatches to server, no client-side filter |
| **"Scanning files..." indicator** | 18, 19, 20, 21, 22 | Show/hide conditions, accessibility, clearing, blocking load precedence |
| **E2E progressive flow** | 25, 26, 27 | Two-phase visual progression, abort on re-type, clear to browse |

### Existing tests that need updating

| Test | File | Change needed |
|------|------|--------------|
| "does not call API for title tier (uses local filter)" | `Sidebar.test.tsx` line 2492 | **Reverse the assertion**: after bypass removal, title-tier search DOES call `searchSessions`. Update to expect the API call. |
| "calls searchSessions API when tier is not title and query exists" | `Sidebar.test.tsx` line 2436 | **May need timing adjustment** if two-phase fetch changes the number of `searchSessions` calls (title-tier Phase 1 fires first). |
| "displays search results from API" | `Sidebar.test.tsx` line 2466 | **Same timing consideration** as above for two-phase behavior. |

### Explicitly excluded

| Area | Reason | Risk |
|------|--------|------|
| **Server-side search** | No server changes. Covered by `2026-03-16-fix-server-side-search-test-plan.md`. | None |
| **`filterSessionItems` in sidebarSelectors.ts** | Still exists for non-search scenarios. Not modified. | None |
| **Snippet/matchedIn display in Sidebar** | Not displayed in UI per implementation plan ("Sidebar renders title/subtitle, not match snippets"). | None |
| **`searchResultsToProjects` function** | Existing function, not modified, already exercised by existing thunk tests. | Low |
| **Performance benchmarks for two-phase search** | Title tier is <50ms (covered by prior plan test 36). Phase 2 latency is inherently server-bound. No client-side perf concern. | Low |
| **`docs/index.html`** | No significant UI change requiring mock update (indicator is subtle). | None |
