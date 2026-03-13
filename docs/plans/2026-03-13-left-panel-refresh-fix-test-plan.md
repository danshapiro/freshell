# Sidebar Refresh Stability Test Plan

## Strategy Reconciliation
No strategy changes requiring user approval are needed.

The agreed strategy still holds, with one important refinement from the final implementation plan: the server-side fix now has two distinct correctness boundaries. `SessionsSyncService` must invalidate only when the `/api/session-directory` read model changes in a user-visible way, while `diffProjects()` must remain the strict full-fidelity comparator used by the session indexer and other internal consumers. That refinement changes which harnesses need coverage, but it does not increase scope, require external services, or change the user-visible goal.

## Sources Of Truth
- `S1 User Goal`: The user reported that the left sidebar repeatedly blanks during live updates, and explicitly clarified that even when updates are legitimate, the sidebar must not blank during refresh.
- `S2 Plan Architecture And Invariants`: The implementation plan requires a dedicated session-directory projection/comparator for websocket invalidations, keeps `updatedAt` as true activity time, preserves stale sidebar content during refresh, coalesces websocket invalidations to at most one follow-up refresh, and leaves explicit user-driven refresh paths direct.
- `S3 Session Directory Contract`: [`shared/read-models.ts`](/home/user/code/freshell/.worktrees/trycycle-left-panel-refresh-fix/shared/read-models.ts), [`server/session-directory/types.ts`](/home/user/code/freshell/.worktrees/trycycle-left-panel-refresh-fix/server/session-directory/types.ts), [`server/session-directory/service.ts`](/home/user/code/freshell/.worktrees/trycycle-left-panel-refresh-fix/server/session-directory/service.ts), and existing server tests define the HTTP-owned directory fields, ordering, search behavior, cursor semantics, running-session join, and revision behavior.
- `S4 Websocket Invalidation Contract`: [`shared/ws-protocol.ts`](/home/user/code/freshell/.worktrees/trycycle-left-panel-refresh-fix/shared/ws-protocol.ts) and [`test/server/ws-sidebar-snapshot-refresh.test.ts`](/home/user/code/freshell/.worktrees/trycycle-left-panel-refresh-fix/test/server/ws-sidebar-snapshot-refresh.test.ts) define `sessions.changed` as a lightweight invalidation `{ type, revision }`, not a snapshot payload.
- `S5 Client Session-Window Contract`: [`src/store/sessionsSlice.ts`](/home/user/code/freshell/.worktrees/trycycle-left-panel-refresh-fix/src/store/sessionsSlice.ts), [`src/store/sessionsThunks.ts`](/home/user/code/freshell/.worktrees/trycycle-left-panel-refresh-fix/src/store/sessionsThunks.ts), [`src/components/Sidebar.tsx`](/home/user/code/freshell/.worktrees/trycycle-left-panel-refresh-fix/src/components/Sidebar.tsx), [`test/unit/client/components/Sidebar.test.tsx`](/home/user/code/freshell/.worktrees/trycycle-left-panel-refresh-fix/test/unit/client/components/Sidebar.test.tsx), and [`test/e2e/open-tab-session-sidebar-visibility.test.tsx`](/home/user/code/freshell/.worktrees/trycycle-left-panel-refresh-fix/test/e2e/open-tab-session-sidebar-visibility.test.tsx) define HTTP-owned sidebar windows, `lastLoadedAt` as the loaded-window marker, current query/search-tier reuse on refresh, and the existing blocking `search-loading` contract for first-load search.
- `S6 Internal Diff Contract`: [`server/sessions-sync/diff.ts`](/home/user/code/freshell/.worktrees/trycycle-left-panel-refresh-fix/server/sessions-sync/diff.ts) and [`server/coding-cli/session-indexer.ts`](/home/user/code/freshell/.worktrees/trycycle-left-panel-refresh-fix/server/coding-cli/session-indexer.ts) define `diffProjects()` as the strict comparator that drives indexer `onUpdate` behavior for internal consumers.

## Harness Requirements
No brand-new standalone harnesses are required, but one small test-support hook must be added before the client invalidation tests can be written deterministically.

| Harness | What it does / exposes | Estimated complexity | Tests |
| --- | --- | --- | --- |
| `H1 Client app invalidation harness` | Reuses the real-`App` Vitest/RTL harness in [`test/e2e/open-tab-session-sidebar-visibility.test.tsx`](/home/user/code/freshell/.worktrees/trycycle-left-panel-refresh-fix/test/e2e/open-tab-session-sidebar-visibility.test.tsx); exposes preloaded Redux state, mocked `fetchSidebarSessionsSnapshot`, websocket message injection, and DOM assertions across the full App-to-Sidebar path. | Existing, medium | 1 |
| `H2 Sidebar render-matrix harness` | Reuses the real-`Sidebar` component harness in [`test/unit/client/components/Sidebar.test.tsx`](/home/user/code/freshell/.worktrees/trycycle-left-panel-refresh-fix/test/unit/client/components/Sidebar.test.tsx); exposes preloaded session-window state, search input actions, mocked list rendering, and direct DOM/status assertions for loaded, empty, and search states. | Existing, low | 2, 3, 4 |
| `H3 Session-window thunk harness` | Reuses the Redux-store harness in [`test/unit/client/store/sessionsThunks.test.ts`](/home/user/code/freshell/.worktrees/trycycle-left-panel-refresh-fix/test/unit/client/store/sessionsThunks.test.ts); add `_resetSessionWindowThunkState()` in [`src/store/sessionsThunks.ts`](/home/user/code/freshell/.worktrees/trycycle-left-panel-refresh-fix/src/store/sessionsThunks.ts) so tests can clear abort controllers and invalidation queue state between runs; exposes mocked API calls, abort signals, and dispatch promises. | Existing plus small support hook, low | 5, 6 |
| `H4 Session-directory read-model harness` | Uses pure server fixtures plus existing router/service tests in [`test/unit/server/session-directory/service.test.ts`](/home/user/code/freshell/.worktrees/trycycle-left-panel-refresh-fix/test/unit/server/session-directory/service.test.ts), [`test/integration/server/session-directory-router.test.ts`](/home/user/code/freshell/.worktrees/trycycle-left-panel-refresh-fix/test/integration/server/session-directory-router.test.ts), and the planned projection test file [`test/unit/server/session-directory/projection.test.ts`](/home/user/code/freshell/.worktrees/trycycle-left-panel-refresh-fix/test/unit/server/session-directory/projection.test.ts); exposes comparable items, page payloads, ordering, search results, cursor windows, and route status codes. | Existing plus one new pure-function test file, low | 7, 10 |
| `H5 Server invalidation-boundary harness` | Reuses pure Vitest fixtures for [`test/unit/server/sessions-sync/service.test.ts`](/home/user/code/freshell/.worktrees/trycycle-left-panel-refresh-fix/test/unit/server/sessions-sync/service.test.ts), [`test/unit/server/sessions-sync/diff.test.ts`](/home/user/code/freshell/.worktrees/trycycle-left-panel-refresh-fix/test/unit/server/sessions-sync/diff.test.ts), and the real websocket invalidation check in [`test/server/ws-sidebar-snapshot-refresh.test.ts`](/home/user/code/freshell/.worktrees/trycycle-left-panel-refresh-fix/test/server/ws-sidebar-snapshot-refresh.test.ts); exposes mocked websocket broadcasts, revision counts, and strict/full-diff outcomes. | Existing, low | 8, 9, 11 |

## Test Plan
1. **Name:** Loaded sidebar rows survive a websocket invalidation burst and then refresh to the new snapshot.
   **Type:** scenario
   **Harness:** `H1 Client app invalidation harness`
   **Preconditions:** `state.sessions.windows.sidebar` is already loaded with `lastLoadedAt` set and one visible row; `activeSurface` is `sidebar`; the next `fetchSidebarSessionsSnapshot` call is deferred so the refresh stays in flight; websocket handlers are active.
   **Actions:** Render `App`; broadcast `sessions.changed`; while the HTTP request is still pending, broadcast `sessions.changed` again; resolve the deferred request with a different sidebar snapshot; if the queued follow-up request starts, resolve it too.
   **Expected outcome:** Per `S1`, `S2`, `S4`, and `S5`, the existing sidebar row remains visible while refresh is in flight, the sidebar never drops to a blank panel, only one request is in flight at a time, the second invalidation does not abort and restart the first request, and the DOM eventually updates to the new row set after the pending refreshes settle.
   **Interactions:** `App` websocket message bridge, `queueActiveSessionWindowRefresh()`, `fetchSidebarSessionsSnapshot()`, sessions reducers, `Sidebar` rendering.

2. **Name:** A loaded non-search sidebar keeps its current rows visible while a refresh is running.
   **Type:** scenario
   **Harness:** `H2 Sidebar render-matrix harness`
   **Preconditions:** The sidebar window has `projects`, `lastLoadedAt`, empty `query`, and `loading: true`; at least one session row is already present.
   **Actions:** Render `Sidebar` against that store state.
   **Expected outcome:** Per `S1`, `S2`, and `S5`, the existing session row text remains rendered during the refresh, the user sees inline refresh status instead of an empty panel, and the sidebar continues to present the same loaded content until the refresh completes.
   **Interactions:** Session selectors, sidebar render matrix, inline refresh status UI, virtualized list host.

3. **Name:** A loaded search keeps current results visible while refresh is in flight, and first-load search remains blocking.
   **Type:** scenario
   **Harness:** `H2 Sidebar render-matrix harness`
   **Preconditions:** Case A: the sidebar window has a non-empty `query`, loaded results, `lastLoadedAt`, and `loading: true`. Case B: the sidebar has a non-empty `query`, `loading: true`, no `lastLoadedAt`, and no results yet.
   **Actions:** Render `Sidebar` for Case A and Case B.
   **Expected outcome:** Per `S1`, `S2`, and `S5`, Case A keeps the previous search result rows visible and still shows the existing `search-loading` status; Case B preserves the current first-load contract by showing blocking `search-loading` with no stale result rows.
   **Interactions:** Sidebar search render path, session-window loading state, existing `search-loading` contract.

4. **Name:** A loaded empty sidebar keeps the empty-state message visible during refresh instead of showing a blank panel.
   **Type:** scenario
   **Harness:** `H2 Sidebar render-matrix harness`
   **Preconditions:** The sidebar window has `lastLoadedAt`, empty `projects`, empty `query`, and `loading: true`.
   **Actions:** Render `Sidebar`.
   **Expected outcome:** Per `S1`, `S2`, and `S5`, the sidebar continues to render its empty-state message while refresh is running and adds inline refresh status instead of collapsing to an empty container.
   **Interactions:** Sidebar empty-state branch, loaded-window detection via `lastLoadedAt`, inline refresh status UI.

5. **Name:** Repeated websocket invalidations coalesce to one in-flight fetch plus at most one trailing refresh.
   **Type:** integration
   **Harness:** `H3 Session-window thunk harness`
   **Preconditions:** `activeSurface` is `sidebar`; the current sidebar window exists; the first `fetchSidebarSessionsSnapshot` call is deferred; `_resetSessionWindowThunkState()` runs before the test.
   **Actions:** Dispatch `queueActiveSessionWindowRefresh()` three times before the first fetch resolves; then resolve the first fetch and await all returned promises.
   **Expected outcome:** Per `S2` and `S5`, exactly one fetch starts immediately, its abort signal remains live while later invalidations queue behind it, and once it settles the thunk runs at most one follow-up refresh to catch up with queued invalidations.
   **Interactions:** Module-scope invalidation queue state, abort-controller map, API helper, sessions reducers.

6. **Name:** Explicit user-driven refresh remains direct and abort-driven; only invalidation refreshes are queued.
   **Type:** regression
   **Harness:** `H3 Session-window thunk harness`
   **Preconditions:** `activeSurface` is `sidebar`; the active window has an existing query/search-tier context; the first explicit refresh call is held open long enough to observe abort behavior; `_resetSessionWindowThunkState()` runs before the test.
   **Actions:** Dispatch `refreshActiveSessionWindow()` twice, or dispatch `fetchSessionWindow()` twice for the same surface, before the first request resolves.
   **Expected outcome:** Per `S2` and `S5`, the second explicit refresh aborts the first using the existing controller policy, proving the new coalescing behavior is scoped to websocket invalidations rather than all refresh paths.
   **Interactions:** Explicit refresh thunk, `fetchSessionWindow()`, abort-controller reuse, query/search-tier propagation.

7. **Name:** The session-directory route keeps its existing ordering, search, cursor, running-state, and revision contract after projection extraction.
   **Type:** integration
   **Harness:** `H4 Session-directory read-model harness`
   **Preconditions:** Server fixtures include archived and non-archived sessions, tied timestamps, search hits in different fields, and running terminal metadata.
   **Actions:** Query the directory for a normal page, a search page, and a cursor-follow-up page through `querySessionDirectory()` and/or `GET /api/session-directory`.
   **Expected outcome:** Per `S2` and `S3`, the route still sorts by directory recency, applies server-side search/snippet behavior, returns deterministic cursor windows, joins running-terminal metadata, caps page size correctly, and computes revision from the newest visible session/terminal activity.
   **Interactions:** Projection helper, `querySessionDirectory()`, router validation, terminal metadata join, read-model scheduler.

8. **Name:** `SessionsSyncService` broadcasts `sessions.changed` only for directory-visible changes.
   **Type:** integration
   **Harness:** `H5 Server invalidation-boundary harness`
   **Preconditions:** A baseline project snapshot exists; later snapshots vary only by invisible metadata and project color, then by `updatedAt`, then by another visible field such as `title`.
   **Actions:** Call `publish()` with the baseline, the invisible-metadata-only snapshot, the `updatedAt` snapshot, and the visible-field snapshot.
   **Expected outcome:** Per `S2`, `S3`, and `S4`, the first publish broadcasts revision `1`, invisible metadata plus project-color-only changes broadcast nothing, an `updatedAt` change broadcasts revision `2`, and a visible field change broadcasts revision `3`.
   **Interactions:** `SessionsSyncService`, session-directory comparator, websocket broadcast mock, revision tracking.

9. **Name:** `sessions.changed` remains a lightweight invalidation message rather than a snapshot payload.
   **Type:** regression
   **Harness:** `H5 Server invalidation-boundary harness`
   **Preconditions:** A real authenticated websocket client is connected to a real `WsHandler`.
   **Actions:** Trigger `broadcastSessionsChanged(7)` and observe the websocket traffic.
   **Expected outcome:** Per `S4`, the client receives exactly `{ type: 'sessions.changed', revision: 7 }` and does not receive a `sessions.updated` snapshot in response to that invalidation.
   **Interactions:** `WsHandler`, authentication gating, websocket protocol serialization.

10. **Name:** The session-directory projection ignores invisible metadata and project color but still treats `updatedAt` as visible recency.
    **Type:** boundary
    **Harness:** `H4 Session-directory read-model harness`
    **Preconditions:** Comparable snapshots differ only in `tokenUsage`, `codexTaskEvents`, `sourceFile`, and project `color`; a second pair differs only in `updatedAt`.
    **Actions:** Build comparable items/snapshots with the new projection helper and compare both pairs.
    **Expected outcome:** Per `S2` and `S3`, invisible metadata and project color do not count as a session-directory snapshot change, while `updatedAt` still does count so active sessions can reorder and invalidate the directory when their visible recency changes.
    **Interactions:** Comparable-item projection, ordered snapshot builder, session-directory field list.

11. **Name:** `diffProjects()` stays strict for internal consumers when non-directory metadata changes.
    **Type:** invariant
    **Harness:** `H5 Server invalidation-boundary harness`
    **Preconditions:** Two project snapshots differ only in internal metadata such as `codexTaskEvents` or `sourceFile`.
    **Actions:** Call `diffProjects(prev, next)`.
    **Expected outcome:** Per `S2` and `S6`, the diff still reports an upsert for that project, protecting the session indexer and downstream internal consumers from losing real metadata updates just because websocket invalidation became narrower.
    **Interactions:** Session indexer refresh pipeline, internal project/session diff, downstream on-update consumers.

## Coverage Summary
Covered action space:
- Websocket-driven sidebar refresh from the real `App` message bridge down through the HTTP-owned session window.
- Non-search, search, and empty loaded sidebar render states while refresh is in flight.
- First-load search blocking behavior, which must remain distinct from loaded stale-while-refresh behavior.
- Invalidation coalescing policy and the explicit-refresh non-coalescing regression boundary.
- Server-side `/api/session-directory` payload semantics, including ordering, search, cursor, running-state join, and revision behavior.
- Websocket invalidation semantics: what changes trigger `sessions.changed`, what message shape is broadcast, and what remains strict for internal server consumers.

Explicit exclusions:
- No differential/reference-implementation tests are planned because there is no independent runnable reference for sidebar invalidation semantics; the strongest available sources of truth are the user goal, the approved implementation plan, and the existing route/protocol contracts.
- No browser-automation test is planned. The highest-risk user behavior is already observable through the existing real-`App` jsdom harness plus server integration tests, and adding a browser harness would increase maintenance cost without adding a new contract surface for this fix.
- No dedicated mobile-only duplicate test is planned. The stale-while-refresh logic lives in the shared `Sidebar` component render matrix, so the same DOM contract covers both desktop and mobile shells; existing mobile sidebar coverage remains the regression backstop for responsive chrome.
- No standalone performance benchmark is planned beyond the request-count/coalescing assertions in Tests 1 and 5. This fix is correctness-first; the meaningful catastrophic performance regression here is repeated redundant fetches, which those tests already pin down.

Residual risks carried by the exclusions:
- Without a reference implementation, correctness depends on strong scenario and boundary tests at the App, route, and websocket seams; weak unit-only coverage would still miss user-visible regressions.
- Without browser automation, a purely CSS/layout-only blanking regression that does not manifest in jsdom could slip through, though the current bug is state/render-policy-driven rather than browser-engine-specific.
- Without a mobile-specific duplicate, a future mobile-only wrapper change around `Sidebar` could regress refresh visibility independently of the shared render matrix.
