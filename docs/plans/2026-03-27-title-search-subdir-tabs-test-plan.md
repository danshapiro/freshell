# Title Search Subdirectory And Open-Tab Search Behavior Revised Test Plan

Minor reconciliation adjustment: the prior strategy still holds on scope, harness cost, and external dependencies, but the revised implementation plan changes test priority. The blocking contract is now the sidebar window commit model and visible-refresh identity, so the first gates move to `sessionsSlice`, `sessionsThunks`, and the full-app drift scenario. The already-landed leaf-directory matcher, selector fallback gating, and server transport checks remain regression coverage after those red checks.

## Harness requirements

No new harness families are required. Extend the existing local Vitest harnesses with low-complexity fixtures that expose the explicit visible-result identity and drift timing called for by the revised implementation plan.

- **Explicit window-commit reducer harness**: `test/unit/client/store/sessionsSlice.test.ts`. Dispatch reducer actions directly and assert `query`, `searchTier`, `appliedQuery`, `appliedSearchTier`, `loading/loadingKind`, top-level active-surface sync, and the committed result-set token (`resultVersion`, or the final equivalent explicit field name if renamed during refactor). Estimated complexity: low. Depends on tests 1 and 4.
- **Refresh-drift thunk harness**: `test/unit/client/store/sessionsThunks.test.ts`. Redux store with deferred promises, captured `AbortSignal`s, and ordered resolution for replacement requests, direct refreshes, queued invalidations, and stale responses. Estimated complexity: low-medium fixture expansion. Depends on tests 2-5.
- **Full app invalidation harness**: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`. Mount real `App` and `Sidebar`, drive the actual search input and clear button, and trigger websocket invalidation plus direct thunk refresh while observing rendered rows and search chrome. Estimated complexity: low fixture tightening. Depends on test 6.
- **Sidebar search-flow harness**: `test/e2e/sidebar-search-flow.test.tsx`. Real `Sidebar` with mocked `searchSessions` and `fetchSidebarSessionsSnapshot`, fake timers for debounce, and real DOM typing/tier-change/clear interactions. Estimated complexity: none beyond reusing the current branch coverage. Depends on test 7.
- **Selector harness**: `test/unit/client/store/selectors/sidebarSelectors.test.ts`. Pure selector fixtures spanning server rows, synthesized fallback rows, sort modes, archived rows, and requested/applied drift. Estimated complexity: low. Depends on tests 8-9.
- **HTTP router harness**: `test/integration/server/session-directory-router.test.ts`. Express round-trip via `supertest` against `/api/session-directory`. Estimated complexity: none beyond fixture reuse. Depends on test 10.
- **Service harness**: `test/unit/server/session-directory/service.test.ts`. Direct `querySessionDirectory()` calls with project, provider, file, and large-corpus fixtures. Estimated complexity: low. Depends on test 11.
- **Shared matcher harness**: `test/unit/shared/session-title-search.test.ts`. Pure metadata/path fixtures for cross-platform leaf extraction and metadata precedence. Estimated complexity: none beyond current coverage. Depends on test 12.

## Test plan

1. **Name:** Replacement and visible-refresh commits keep requested state, applied state, and committed result identity distinct
   **Type:** unit
   **Disposition:** extend
   **Harness:** Explicit window-commit reducer harness
   **Preconditions:** A sidebar window with committed search results for query `alpha`, `appliedQuery/appliedSearchTier` set to that visible result set, and a known committed result token. A second state also represents an in-flight browse replacement (`query=''`, `loadingKind='search'`) while the `alpha` results are still visible.
   **Actions:** Dispatch the explicit replacement-loading action with query `beta`; dispatch the replacement-commit action with `beta` data; dispatch the visible-refresh-commit action against the still-visible `alpha` context while preserving replacement loading; dispatch replacement failure/error after requested state has moved but before a new commit lands.
   **Expected outcome:** Source of truth: revised implementation plan Behavior Contract and Task 1. Replacement loading updates only requested `query/searchTier`; replacement commit updates both requested and applied search state and increments the committed result token; visible-refresh commit updates projects and increments the committed result token without rewriting requested `query/searchTier` or clearing a preserved replacement load; failure preserves the last applied visible context and current committed result token.
   **Interactions:** Reducer API shape, active-surface top-level sync, loading semantics, and the explicit result-set identity field that later thunk tests depend on.

2. **Name:** Direct refresh during search-to-browse drift revalidates the visible search result set without aborting the pending browse replacement
   **Type:** integration
   **Disposition:** extend
   **Harness:** Refresh-drift thunk harness
   **Preconditions:** The store has committed `alpha` title-search results on screen, requested state has already moved to browse (`query=''`, `searchTier='title'`) because `fetchSessionWindow()` for browse was dispatched and left in flight, and the browse request's `AbortSignal` is captured.
   **Actions:** Dispatch `refreshActiveSessionWindow()` while the browse replacement is still pending; resolve the refresh first; then resolve the browse replacement.
   **Expected outcome:** Source of truth: user transcript plus revised implementation plan Behavior Contract and Task 2. The refresh fetches using the visible applied context (`alpha`, title tier), does not abort the pending browse request, does not rewrite requested browse state, keeps `appliedQuery/appliedSearchTier` on `alpha` after refresh commit, and still allows the original browse replacement to resolve and finally clear the applied search state.
   **Interactions:** `refreshActiveSessionWindow()`, visible-context capture, surface abort-controller ownership, reducer commit boundary, and browse replacement sequencing.

3. **Name:** Queued websocket invalidation during the same drift obeys the same no-abort, no-requested-rewrite contract
   **Type:** integration
   **Disposition:** extend
   **Harness:** Refresh-drift thunk harness
   **Preconditions:** Same as test 2, except the refresh is triggered through `queueActiveSessionWindowRefresh()` while a browse replacement is already in flight.
   **Actions:** Dispatch `queueActiveSessionWindowRefresh()` during the drift; resolve the queued visible refresh; then resolve the pending browse replacement.
   **Expected outcome:** Source of truth: revised implementation plan Behavior Contract and Task 2. The queued invalidation revalidates the visible applied result set instead of routing back through the replacement path, does not abort the pending browse replacement, keeps requested state cleared, keeps applied search state on the visible search results until the browse replacement commits, and coalesces through the existing invalidation runner rather than spawning a second browse replacement.
   **Interactions:** Websocket invalidation path, queue state, in-flight request coordination, visible-refresh helper reuse, and reducer commit sequencing.

4. **Name:** Stale visible refresh responses are dropped once a newer visible result set has committed
   **Type:** invariant
   **Disposition:** extend
   **Harness:** Refresh-drift thunk harness plus explicit window-commit reducer harness
   **Preconditions:** A committed visible result set with an explicit result token is on screen. A visible refresh for that result set is started and held. Before it resolves, a newer replacement or refresh commits a different visible window and increments the committed result token.
   **Actions:** Start the older visible refresh; commit the newer window; then resolve the older refresh response.
   **Expected outcome:** Source of truth: revised implementation plan Behavior Contract and Strategy Gate. The stale refresh is discarded because the visible identity captured at refresh start no longer matches the currently committed visible identity. The newer committed projects, applied search context, and committed result token remain unchanged.
   **Interactions:** Visible-result identity capture, monotonic committed result token, stale-response suppression, and commit-authority rules across reducer and thunk seams.

5. **Name:** Visible deep-search refreshes stay two-phase and remain keyed to the visible applied context, not requested drift
   **Type:** integration
   **Disposition:** extend
   **Harness:** Refresh-drift thunk harness
   **Preconditions:** The store is showing committed deep-search (`userMessages` or `fullText`) results for query `alpha`, and requested state can drift independently while that deep-search result set remains visible.
   **Actions:** Dispatch a visible refresh against the deep-search result set; resolve Phase 1 title results, then Phase 2 deep results; repeat with requested state drifting while the original deep-search result set is still visible.
   **Expected outcome:** Source of truth: revised implementation plan Behavior Contract and unchanged two-phase deep-search behavior in the current branch. The refresh uses the visible applied query and tier, preserves `deepSearchPending` semantics, does not rewrite requested state during drift, and only commits while the captured visible identity is still current.
   **Interactions:** Two-phase search merge, deep-search pending indicator state, visible-refresh helper, and requested-vs-applied drift handling.

6. **Name:** Clearing search leaves stale search rows visible, silent refresh keeps them visible, and the browse replacement commits afterward in the full app
   **Type:** scenario
   **Disposition:** extend
   **Harness:** Full app invalidation harness
   **Preconditions:** `App` is mounted with committed sidebar title-search results, search input populated from requested/applied state, and mocked browse plus refresh requests held as deferred promises.
   **Actions:** Clear the search input through the real `Clear search` button or equivalent input change path; wait for the browse replacement to start; trigger a websocket `sessions.changed` invalidation or direct `refreshActiveSessionWindow()` while the browse request is still pending; resolve the silent refresh; then resolve the browse replacement.
   **Expected outcome:** Source of truth: user transcript plus revised implementation plan Behavior Contract. Clearing search starts exactly one browse replacement request and leaves the old search rows visible; the refresh keeps those rows visible and does not show search-loading chrome; after the refresh resolves, the browse replacement still commits and the applied search state finally clears in the rendered sidebar.
   **Interactions:** Real `Sidebar` search input and clear action, `App` websocket listener, `queueActiveSessionWindowRefresh()` and `refreshActiveSessionWindow()`, Redux state propagation, and rendered DOM assertions.

7. **Name:** Searching by a subdirectory leaf returns indexed sessions and only matching open-tab fallback rows, without pinning tabs above newer server results
   **Type:** scenario
   **Disposition:** existing
   **Harness:** Sidebar search-flow harness
   **Preconditions:** A rendered sidebar with one indexed server session whose title does not contain `trycycle` but whose `projectPath` or distinct `cwd` leaf does; a newer non-tab server result; one open fallback tab whose local metadata leaf also matches `trycycle`; and a second query `code` that appears only in ancestor path segments.
   **Actions:** Type `trycycle` into the search input and wait for debounce plus the title-tier server response; inspect ordered rows. Replace the query with `code` and wait for the next response.
   **Expected outcome:** Source of truth: user transcript and revised implementation plan Behavior Contract. `trycycle` returns the indexed session and the locally provable fallback row; `code` does not match that same session or fallback row on ancestor-only path text; and during the applied search the matching fallback row is not pinned ahead of the newer non-tab server result.
   **Interactions:** Search debounce, title-tier request payload, selector fallback synthesis, applied-search pinning rules, and DOM row ordering.

8. **Name:** Applied title search only injects fallback rows that the client can prove locally, and requested-state drift does not change the visible filtered set early
   **Type:** invariant
   **Disposition:** existing
   **Harness:** Selector harness
   **Preconditions:** Selector state contains server rows, matching and non-matching fallback rows, requested state intentionally different from applied state, and an applied title-search query whose local proof succeeds for only a subset of fallbacks.
   **Actions:** Run `makeSelectSortedSessionItems()` with applied title-search state while requested `query/searchTier` differ from applied fields.
   **Expected outcome:** Source of truth: revised implementation plan Behavior Contract. The selector filters fallback rows based on `appliedQuery/appliedSearchTier`, not requested drift; only locally provable title-tier fallback rows remain; unrelated fallbacks and ancestor-only matches stay hidden; and visible ordering still respects no-pinning during applied search.
   **Interactions:** Applied-vs-requested selector inputs, fallback proof via shared title matcher, sort comparator behavior, and synthesized fallback row construction.

9. **Name:** Applied deep-search result sets never inject fallback tabs and search disables tab pinning while preserving archived-last ordering
   **Type:** invariant
   **Disposition:** existing
   **Harness:** Selector harness
   **Preconditions:** Selector state contains a deep-search result set, fallback tabs whose local metadata would match the query, a newer non-tab row, an archived row, and both `activity` and `recency-pinned` sort modes.
   **Actions:** Run the selector for applied deep-search state, then for applied title-search state, and compare the sorted outputs across sort modes.
   **Expected outcome:** Source of truth: revised implementation plan Behavior Contract. Deep-search tiers show only server-authoritative rows; title-tier applied search may include locally provable fallback rows; applied search disables `hasTab` pinning in both sort modes; and archived rows still sort last.
   **Interactions:** Applied search tier gating, fallback suppression, tab-pinning comparator options, and archived grouping.

10. **Name:** `/api/session-directory` matches leaf directory names and rejects ancestor-only path text through the real HTTP transport contract
    **Type:** integration
    **Disposition:** existing
    **Harness:** HTTP router harness
    **Preconditions:** The Express route is mounted with indexed sessions whose `projectPath` leaf is `trycycle`, whose titles omit that term, and whose ancestor path contains `code`.
    **Actions:** Send `GET /api/session-directory?priority=visible&query=trycycle&tier=title`; then send the same request with `query=code`.
    **Expected outcome:** Source of truth: user transcript, revised implementation plan Behavior Contract, and the `SessionDirectoryPage` schema. The `trycycle` request returns the matching item with the existing HTTP shape and `matchedIn/snippet` semantics; the `code` request returns no match when the only occurrence is an ancestor-only path segment.
    **Interactions:** Router query parsing, service invocation, read-model schema stability, and title-tier metadata search over the real HTTP endpoint the sidebar consumes.

11. **Name:** Service-level title-tier search stays provider-free, preserves metadata precedence and ordering, and keeps the existing low-risk performance guard
    **Type:** integration
    **Disposition:** existing
    **Harness:** Service harness
    **Preconditions:** `querySessionDirectory()` fixtures cover title matches, project-path leaf matches, distinct `cwd` leaf matches, summary matches, first-user-message matches, archived sessions, and a large-enough corpus for the existing generous timing guard.
    **Actions:** Query the service with title-tier searches that hit each metadata source, with an ancestor-only query, and with providers omitted; run the existing large-corpus timing check.
    **Expected outcome:** Source of truth: revised implementation plan Behavior Contract and current `querySessionDirectory()` transport contract. Metadata precedence remains `title`, then project-path leaf, then distinct `cwd` leaf, then `summary`, then `firstUserMessage`; title-tier search stays provider-free; ancestor-only path text does not match; canonical ordering and archived handling remain unchanged; and the existing generous timing guard still passes, catching only catastrophic regressions.
    **Interactions:** Server projection ordering, snippet extraction, provider lookup bypass for title tier, and metadata-search cost.

12. **Name:** Shared title-tier metadata matching extracts cross-platform leaf directory names and rejects ancestor-only segments
    **Type:** unit
    **Disposition:** existing
    **Harness:** Shared matcher harness
    **Preconditions:** Pure metadata fixtures cover POSIX paths, Windows paths, trailing separators, sessions with both `projectPath` and deeper `cwd`, fallback-only metadata with only `cwd`, and an ancestor-only query.
    **Actions:** Call `getLeafDirectoryName()` and `matchTitleTierMetadata()` across those fixtures.
    **Expected outcome:** Source of truth: user transcript and revised implementation plan Behavior Contract. Leaf extraction returns the final directory name on POSIX and Windows inputs, ignores trailing separators, prefers the indexed `projectPath` leaf over a deeper `cwd` leaf when both exist, still matches fallback-only `cwd` metadata, and returns `null` for ancestor-only segments such as `code`.
    **Interactions:** Shared matcher seam used by both client fallback gating and server title-tier search.

## Coverage summary

- **Covered action space:** typing into the sidebar search input; changing the requested search tier; clearing the search input to start a browse replacement; dispatching `refreshActiveSessionWindow()` directly; receiving websocket `sessions.changed` invalidations that flow through `queueActiveSessionWindowRefresh()`; resolving replacement requests, visible refreshes, and stale responses in different orders; rendering search rows and silent-refresh chrome in the mounted app; computing selector-visible rows and sort order from applied search state; calling `GET /api/session-directory`; executing `querySessionDirectory()` title-tier search; and running the shared leaf-directory matcher.
- **Covered high-risk boundaries:** reducer commit semantics for requested versus applied search state, abort-controller ownership for direct replacements versus visible refreshes, invalidation queueing, stale response suppression by explicit visible-result identity, client/server agreement on leaf-directory title-tier matching, and selector fallback injection during applied search.
- **Explicitly excluded:** click-to-open session row behavior, context-menu mutation UX itself, terminal-directory busy-state rendering, and deep file-content search correctness beyond the unchanged two-phase refresh and fallback-suppression contract. Those surfaces are not being changed by this task and already have dedicated coverage elsewhere.
- **Risk carried by the exclusions:** a regression isolated to session-opening, context-menu presentation, busy indicators, or unrelated deep-search file scanning could land alongside this change without this plan catching it. This plan is intentionally concentrated on the search/filter/refresh contract the user asked to fix and the revised implementation plan now makes explicit.
