# Sidebar Silent Refresh Search Test Plan

## Strategy Reconciliation
No strategy changes requiring user approval are needed.

The current implementation plan in [`docs/plans/2026-03-13-sidebar-silent-refresh-search.md`](/home/user/code/freshell/.worktrees/trycycle-sidebar-silent-refresh-search/docs/plans/2026-03-13-sidebar-silent-refresh-search.md) narrows this follow-up to a client-only fix. The server-side invalidation boundary is already correct enough for this issue. The regression is now in client request-intent and presentation policy: websocket invalidations, user-driven search requests, initial loads, and pagination all currently collapse into the same visible loading state.

This test plan therefore shifts coverage away from new server tests and toward a heavier client matrix:
- store-level request-intent classification
- component-level rendering for loaded, empty, and searched states
- App-level websocket invalidation integration
- focused regression guards that prove only user-requested search work shows visible `Searching...`

## Sources Of Truth
- `S1 User requirement`: websocket/background sidebar refreshes must be silent and non-jumping; `Searching...` is required only when the user requested a search action that is still in flight.
- `S2 Implementation plan`: [`docs/plans/2026-03-13-sidebar-silent-refresh-search.md`](/home/user/code/freshell/.worktrees/trycycle-sidebar-silent-refresh-search/docs/plans/2026-03-13-sidebar-silent-refresh-search.md) requires explicit per-window loading intent, keeps the current invalidation/coalescing mechanics, and removes the in-flow loading row.
- `S3 Store contract`: [`src/store/sessionsSlice.ts`](/home/user/code/freshell/.worktrees/trycycle-sidebar-silent-refresh-search/src/store/sessionsSlice.ts) and [`src/store/sessionsThunks.ts`](/home/user/code/freshell/.worktrees/trycycle-sidebar-silent-refresh-search/src/store/sessionsThunks.ts) define sidebar window state, direct fetch behavior, invalidation queueing, abort control, and reset hooks.
- `S4 Sidebar render contract`: [`src/components/Sidebar.tsx`](/home/user/code/freshell/.worktrees/trycycle-sidebar-silent-refresh-search/src/components/Sidebar.tsx) defines when the sidebar blocks, when it keeps committed rows or empty state mounted, and where visible search chrome is rendered.
- `S5 App invalidation contract`: [`src/App.tsx`](/home/user/code/freshell/.worktrees/trycycle-sidebar-silent-refresh-search/src/App.tsx) routes `sessions.changed` into `queueActiveSessionWindowRefresh()`, so App-level tests need to exercise the real websocket-to-sidebar path.
- `S6 Existing regression harnesses`: [`test/unit/client/store/sessionsThunks.test.ts`](/home/user/code/freshell/.worktrees/trycycle-sidebar-silent-refresh-search/test/unit/client/store/sessionsThunks.test.ts), [`test/unit/client/components/Sidebar.test.tsx`](/home/user/code/freshell/.worktrees/trycycle-sidebar-silent-refresh-search/test/unit/client/components/Sidebar.test.tsx), and [`test/e2e/open-tab-session-sidebar-visibility.test.tsx`](/home/user/code/freshell/.worktrees/trycycle-sidebar-silent-refresh-search/test/e2e/open-tab-session-sidebar-visibility.test.tsx) are the primary harnesses and should be extended rather than replaced.

## Harness Requirements
This feature can be covered with existing harnesses, but Heavy fidelity means using all three client layers and broadening the scenario matrix rather than relying on one or two happy-path assertions.

| Harness | What it exposes | Complexity | Tests |
| --- | --- | --- | --- |
| `H1 Session-window thunk harness` | Real Redux store, mocked API helpers, abort signals, queued invalidation orchestration, and `_resetSessionWindowThunkState()` cleanup via [`test/unit/client/store/sessionsThunks.test.ts`](/home/user/code/freshell/.worktrees/trycycle-sidebar-silent-refresh-search/test/unit/client/store/sessionsThunks.test.ts). | Existing plus small state additions | 1, 2, 3, 4, 5, 6 |
| `H2 Sidebar render-matrix harness` | Real `Sidebar` rendering with preloaded session-window state, search input control, empty-state branches, and DOM queries via [`test/unit/client/components/Sidebar.test.tsx`](/home/user/code/freshell/.worktrees/trycycle-sidebar-silent-refresh-search/test/unit/client/components/Sidebar.test.tsx). | Existing | 7, 8, 9, 10, 11 |
| `H3 App invalidation integration harness` | Real `App` wiring, websocket message injection, mocked sidebar fetches, and DOM assertions across the websocket-to-sidebar path via [`test/e2e/open-tab-session-sidebar-visibility.test.tsx`](/home/user/code/freshell/.worktrees/trycycle-sidebar-silent-refresh-search/test/e2e/open-tab-session-sidebar-visibility.test.tsx). | Existing | 12, 13, 14 |

## Test Plan
1. **Name:** Initial visible load with no committed sidebar data uses initial loading intent.
   **Type:** unit
   **Harness:** `H1 Session-window thunk harness`
   **Preconditions:** No committed sidebar window data; `activeSurface` is `sidebar`; `_resetSessionWindowThunkState()` has run.
   **Actions:** Dispatch `fetchSessionWindow({ surface: 'sidebar', priority: 'visible' })` and hold the request open.
   **Expected outcome:** The sidebar window enters `loading: true` with `loadingKind: 'initial'`, proving first-load blocking is distinguishable from all later refreshes.

2. **Name:** Explicit non-empty query submission is classified as visible search work.
   **Type:** unit
   **Harness:** `H1 Session-window thunk harness`
   **Preconditions:** Sidebar is active; no request is in flight.
   **Actions:** Dispatch `fetchSessionWindow()` with `query: 'needle'` and a visible priority.
   **Expected outcome:** The window enters `loadingKind: 'search'`, not `background`, and settles back to no loading kind after the request resolves.

3. **Name:** Search-tier changes and clearing a non-empty query both remain visible user search actions.
   **Type:** unit
   **Harness:** `H1 Session-window thunk harness`
   **Preconditions:** A committed sidebar search window exists.
   **Actions:** First dispatch a tier change for the same query. Then dispatch a clear from a non-empty query back to the default list.
   **Expected outcome:** Both requests classify as `loadingKind: 'search'`, because both are user-requested search-context changes.

4. **Name:** Websocket revalidation of a loaded default-list window is always background.
   **Type:** unit
   **Harness:** `H1 Session-window thunk harness`
   **Preconditions:** A committed sidebar default-list window exists with `lastLoadedAt` and rows.
   **Actions:** Dispatch `queueActiveSessionWindowRefresh()` and hold the resulting request open.
   **Expected outcome:** The window enters `loadingKind: 'background'` and does not claim visible search ownership.

5. **Name:** Websocket revalidation of a loaded active query is still silent background work.
   **Type:** unit
   **Harness:** `H1 Session-window thunk harness`
   **Preconditions:** A committed sidebar search window exists with query, tier, rows, and `lastLoadedAt`.
   **Actions:** Dispatch `queueActiveSessionWindowRefresh()`.
   **Expected outcome:** The window uses `loadingKind: 'background'` even though the active query is non-empty, proving query presence no longer implies visible search chrome.

6. **Name:** Invalidation bursts coalesce without breaking direct-refresh abort behavior.
   **Type:** integration
   **Harness:** `H1 Session-window thunk harness`
   **Preconditions:** First queued invalidation request is deferred; `_resetSessionWindowThunkState()` has run.
   **Actions:** Dispatch `queueActiveSessionWindowRefresh()` three times, then resolve the first request; separately, dispatch two direct `refreshActiveSessionWindow()` or visible `fetchSessionWindow()` calls before the first direct call resolves.
   **Expected outcome:** Queued invalidations produce one in-flight request plus at most one trailing refresh; direct visible refreshes still abort older direct requests. This keeps the new behavior scoped to websocket invalidations only.

7. **Name:** Loaded default-list rows stay mounted during background refresh with no refresh row.
   **Type:** unit
   **Harness:** `H2 Sidebar render-matrix harness`
   **Preconditions:** Loaded sidebar rows are present; `loading: true`; `loadingKind: 'background'`; `query` is empty.
   **Actions:** Render `Sidebar`.
   **Expected outcome:** Existing rows remain visible. `sessions-refreshing` is absent. `search-loading` is absent. The sidebar height does not depend on an inserted status row.

8. **Name:** Loaded search results stay mounted during background refresh with no visible search chrome.
   **Type:** unit
   **Harness:** `H2 Sidebar render-matrix harness`
   **Preconditions:** Loaded search results are present; `loading: true`; `loadingKind: 'background'`; `query` is non-empty.
   **Actions:** Render `Sidebar`.
   **Expected outcome:** Existing search results remain visible. `search-loading` is absent. No fallback loading row appears.

9. **Name:** Loaded search results show visible searching only for visible search intent.
   **Type:** unit
   **Harness:** `H2 Sidebar render-matrix harness`
   **Preconditions:** Loaded search results are present; `loading: true`; `loadingKind: 'search'`; `query` is non-empty.
   **Actions:** Render `Sidebar`.
   **Expected outcome:** Existing results remain mounted while `search-loading` renders inside stable chrome for the search control rather than as a list row.

10. **Name:** Initial search with no committed data still blocks correctly.
    **Type:** unit
    **Harness:** `H2 Sidebar render-matrix harness`
    **Preconditions:** No committed rows or empty-state timestamp; `loading: true`; `loadingKind: 'initial'`; query may be empty or non-empty depending on case.
    **Actions:** Render `Sidebar`.
    **Expected outcome:** The sidebar may still block with initial loading UI. This preserves the allowed disruptive case: first load with no committed content.

11. **Name:** Loaded empty state survives silent background refresh.
    **Type:** unit
    **Harness:** `H2 Sidebar render-matrix harness`
    **Preconditions:** The window has `lastLoadedAt`, no rows, `loading: true`, and `loadingKind: 'background'`.
    **Actions:** Render `Sidebar`.
    **Expected outcome:** The empty-state message remains mounted. No blank container appears. No `sessions-refreshing` or `search-loading` row is shown.

12. **Name:** App-level websocket invalidation keeps loaded default-list content visible and silent.
    **Type:** scenario
    **Harness:** `H3 App invalidation integration harness`
    **Preconditions:** `App` is rendered with a loaded default-list sidebar window and websocket handlers attached; the next sidebar fetch is deferred.
    **Actions:** Broadcast `sessions.changed`, confirm the fetch begins, then inspect the DOM before resolving the request.
    **Expected outcome:** Current rows stay visible, there is no `Updating sessions...` row, and the refresh remains silent until the new snapshot commits.

13. **Name:** App-level websocket invalidation of a loaded active query stays silent.
    **Type:** scenario
    **Harness:** `H3 App invalidation integration harness`
    **Preconditions:** `App` is rendered with loaded search results, a non-empty active query, and deferred sidebar fetch response.
    **Actions:** Broadcast `sessions.changed` while the active query is loaded; inspect the DOM before resolving the request.
    **Expected outcome:** Existing search results remain visible, `search-loading` does not appear, and no layout-shifting status row is rendered during the background revalidation.

14. **Name:** Only an actual user query change surfaces visible searching after App integration.
    **Type:** scenario
    **Harness:** `H3 App invalidation integration harness`
    **Preconditions:** `App` is rendered with a loaded active query and functioning search input control.
    **Actions:** First trigger a websocket invalidation and confirm silence. Then change the query or tier through the UI while deferring the request.
    **Expected outcome:** Websocket invalidation remains silent, but the direct user action surfaces `search-loading` until the latest user-requested search settles.

## Coverage Summary
This Heavy plan covers:
- request-intent classification for initial load, visible search, background refresh, and direct refresh
- loaded default-list, loaded search, and loaded empty-state rendering while background work is in flight
- queueing/coalescing behavior under invalidation bursts
- the crucial integration boundary where `App` translates `sessions.changed` into silent sidebar revalidation
- the user-facing rule that visible `Searching...` belongs only to user-requested search work

Intentionally excluded:
- new server-side invalidation tests, because this follow-up plan does not change server behavior
- browser-engine screenshot automation, because the bug is state/render-policy-driven and the existing App-level DOM harness already exercises the real invalidation path

## Execution Order
1. Add red tests in [`test/unit/client/store/sessionsThunks.test.ts`](/home/user/code/freshell/.worktrees/trycycle-sidebar-silent-refresh-search/test/unit/client/store/sessionsThunks.test.ts).
2. Add red tests in [`test/unit/client/components/Sidebar.test.tsx`](/home/user/code/freshell/.worktrees/trycycle-sidebar-silent-refresh-search/test/unit/client/components/Sidebar.test.tsx).
3. Add red scenarios in [`test/e2e/open-tab-session-sidebar-visibility.test.tsx`](/home/user/code/freshell/.worktrees/trycycle-sidebar-silent-refresh-search/test/e2e/open-tab-session-sidebar-visibility.test.tsx).
4. Run the focused client pack.
5. Run `npm run lint`.
6. Run `npm run test:status`.
7. Run `FRESHELL_TEST_SUMMARY="sidebar silent refresh search" CI=true npm test`.
