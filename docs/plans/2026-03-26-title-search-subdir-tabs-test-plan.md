# Title Search Subdirectory And Open-Tab Search Behavior Test Plan

## Harness requirements

No new harnesses are required. The implementation plan stays within existing local test infrastructure and does not add paid APIs, external services, or new browser automation dependencies. Extend the existing harnesses with low-complexity fixtures instead of building new ones.

- **Sidebar search flow harness**: `test/e2e/sidebar-search-flow.test.tsx`. Real `Sidebar` + Redux store + mocked `searchSessions` and `fetchSidebarSessionsSnapshot`, with fake timers for debounce and direct DOM actions for typing, tier changes, and clearing. Estimated complexity: low fixture expansion. Depends on test 1.
- **Sidebar component harness**: `test/unit/client/components/Sidebar.test.tsx`. Rendered `Sidebar` with preloaded store state, tabs/panes fixtures, and scroll geometry helpers for append behavior. Estimated complexity: low fixture expansion. Depends on tests 2-6.
- **Open-tab App harness**: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`. Full `App` with mocked WebSocket invalidation and API calls. Estimated complexity: none beyond reusing an existing regression gate. Depends on test 7.
- **Store harnesses**: `test/unit/client/store/sessionsThunks.test.ts` and `test/unit/client/store/sessionsSlice.test.ts`. Redux store with deferred promises for in-flight request timing plus direct reducer action coverage. Estimated complexity: none. Depends on tests 8-10.
- **Selector harness**: `test/unit/client/store/selectors/sidebarSelectors.test.ts`. Pure selector state fixtures spanning server rows, synthesized fallback rows, tabs, panes, sort modes, and requested/applied search drift. Estimated complexity: low fixture expansion. Depends on tests 11-12.
- **HTTP router harness**: `test/integration/server/session-directory-router.test.ts`. Express router round-trip via `supertest`. Estimated complexity: low fixture expansion. Depends on test 13.
- **Service harness**: `test/unit/server/session-directory/service.test.ts`. Direct `querySessionDirectory()` calls with provider and file fixtures. Estimated complexity: low fixture expansion. Depends on test 14.
- **Shared matcher harness**: `test/unit/shared/session-title-search.test.ts`. New pure unit harness for cross-platform path leaf extraction and metadata precedence. Estimated complexity: low. Depends on test 15.

Minor reconciliation adjustment: in addition to the implementation plan's unit/service coverage, keep the existing `/api/session-directory` router round-trip as an explicit acceptance gate because that is the transport contract the sidebar actually consumes.

## Test plan

1. **Name:** Searching by a subdirectory leaf returns the session, ancestor-only terms do not, and open tabs only appear when they also match
   **Type:** scenario
   **Disposition:** extend
   **Harness:** Sidebar search flow harness
   **Preconditions:** A rendered sidebar with one indexed session whose `title` does not contain `trycycle`, whose `projectPath` or `cwd` leaf is `trycycle`, plus an open fallback tab whose leaf also matches `trycycle`; a newer non-tab server result is also present so ordering is observable; sidebar sort mode is `activity`.
   **Actions:** Type `trycycle` into the search input; wait for debounce and mocked title-tier server response; observe the ordered rows. Then replace the query with `code`; wait for the new response.
   **Expected outcome:** Source of truth: the user transcript, plus the implementation plan Behavior Contract bullets for leaf-directory matching, ancestor rejection, authoritative server rows during applied search, and "no pinning while searching." The `trycycle` query renders the indexed session even though the title lacks `trycycle`; the `code` query does not return that same session unless another metadata field independently contains `code`; the matching fallback open tab is shown only for the matching query; the matching fallback row is not forced above the newer non-tab server row.
   **Interactions:** Sidebar debounce, `searchSessions()` request payload, Redux search state, selector fallback synthesis, sort policy, and DOM row ordering.

2. **Name:** Applied title search hides unrelated fallback tabs and keeps only locally provable fallback matches
   **Type:** scenario
   **Disposition:** extend
   **Harness:** Sidebar component harness
   **Preconditions:** Sidebar window already contains committed title-search results from the server. Tabs/panes include one open fallback tab whose `cwd` leaf matches the applied query and one open fallback tab whose metadata does not match. A newer server-backed non-tab row is present.
   **Actions:** Render the sidebar with the committed search window and inspect the visible rows without issuing a new request.
   **Expected outcome:** Source of truth: implementation plan Behavior Contract bullets for authoritative server rows during applied search and local fallback injection only when the client can prove a title-tier match. The unrelated fallback tab is absent, the matching fallback tab is present, and the newer server row remains above the fallback row even when the fallback row has `hasTab: true`.
   **Interactions:** Selector merge of server rows with synthesized fallback rows, applied search gating, activity sort behavior, and row rendering.

3. **Name:** Applied deep search never injects fallback tabs, even when local metadata would have matched
   **Type:** regression
   **Disposition:** extend
   **Harness:** Sidebar component harness
   **Preconditions:** Sidebar window contains committed `userMessages` or `fullText` results. Tabs/panes include an open fallback tab whose title or `cwd` leaf matches the query text locally.
   **Actions:** Render the sidebar while the applied deep-search result set is on screen.
   **Expected outcome:** Source of truth: implementation plan Behavior Contract bullet stating that `userMessages` and `fullText` searches must not inject fallback rows because the client cannot prove deep-file matches. Only server-window rows are visible; the locally matching fallback row is hidden.
   **Interactions:** Applied search tier handling, selector fallback suppression, and deep-search UI state.

4. **Name:** Starting a replacement search does not locally re-filter the previous committed result set
   **Type:** regression
   **Disposition:** extend
   **Harness:** Sidebar component harness
   **Preconditions:** Sidebar shows a committed title-search result set for query A. A replacement title-search request for query B is configured to stay in flight after the search input changes.
   **Actions:** Type query B into the search input and advance past debounce without resolving the new server response.
   **Expected outcome:** Source of truth: implementation plan Behavior Contract bullets separating requested `query/searchTier` from applied `appliedQuery/appliedSearchTier`, and forbidding local re-filtering of the last committed result set while a replacement query is in flight. The old rows for query A remain visible until query B data commits, even though the input now shows query B and the search-loading chrome is active.
   **Interactions:** Search input, debounce timer, requested vs applied search state, search-loading indicator, and selector inputs.

5. **Name:** Clearing search keeps browse append pagination disabled until browse data replaces the stale search results
   **Type:** regression
   **Disposition:** extend
   **Harness:** Sidebar component harness
   **Preconditions:** Sidebar is displaying committed search results with `hasMore: true`. The user clears the search box, triggering a browse reload that has not resolved yet. The list can be scrolled near the bottom.
   **Actions:** Click the clear-search button; before the browse response resolves, trigger near-bottom scroll or underfilled-viewport backfill logic; then resolve the browse response and repeat the append trigger.
   **Expected outcome:** Source of truth: implementation plan Behavior Contract bullet that browse pagination must stay disabled while stale search results remain on screen during a search-to-browse transition. No append fetch is issued before browse data lands; once browse results replace the visible search result set, append requests are allowed again.
   **Interactions:** Clear-search button, fetch-session browse path, requested vs applied search state, append guard, scroll handler, and resize/backfill logic.

6. **Name:** First-load search remains blocking and does not reveal fallback tabs under the spinner
   **Type:** regression
   **Disposition:** existing
   **Harness:** Sidebar component harness
   **Preconditions:** Sidebar has no committed result set yet, `loadingKind` is `initial`, the applied search is empty because nothing has committed, and tabs/panes contain fallback open sessions.
   **Actions:** Render the sidebar during the first blocking search load.
   **Expected outcome:** Source of truth: implementation plan Behavior Contract bullet that blocking first-load behavior stays unchanged. The search-loading UI remains the only visible state; fallback rows do not appear underneath it.
   **Interactions:** Loading-state hierarchy, fallback synthesis suppression, and empty-result rendering.

7. **Name:** Active-query refresh stays silent while already-committed search results remain on screen
   **Type:** regression
   **Disposition:** existing
   **Harness:** Open-tab App harness
   **Preconditions:** The full app is mounted with committed search results in the sidebar and a WebSocket-driven refresh is triggered for the active query.
   **Actions:** Broadcast the refresh/invalidation event and keep the refresh request in flight long enough to observe the UI before it resolves.
   **Expected outcome:** Source of truth: current user-visible refresh behavior already covered by the existing suite, plus the implementation plan requirement that component logic reason from the result set currently on screen. The existing search result rows remain visible and no extra search chrome appears during the silent refresh. This scenario remains the broad UI regression gate; the store-level commit-authority invariants live in tests 8-9.
   **Interactions:** App-level WebSocket invalidation, `refreshActiveSessionWindow`, active-query reuse, and sidebar rendering under background work.

8. **Name:** In-flight replacement requests move requested search state immediately but keep applied search state on the visible results until commit
   **Type:** integration
   **Disposition:** extend
   **Harness:** Store harnesses (`sessionsThunks.test.ts`)
   **Preconditions:** A store with committed sidebar search results for query A. Deferred promises are used for a replacement search for query B and a subsequent search-to-browse transition.
   **Actions:** Dispatch `fetchSessionWindow()` for query B and inspect state before resolution; resolve query B and inspect state again. Then dispatch `fetchSessionWindow()` for an empty query to return to browse mode and inspect state before and after the browse response resolves.
   **Expected outcome:** Source of truth: implementation plan Behavior Contract bullets for requested vs applied search state. `query/searchTier` change as soon as loading starts; `appliedQuery/appliedSearchTier` keep describing query A until query B data commits; clearing search starts a browse request but leaves the applied search context intact until browse data commits.
   **Interactions:** Thunk control flow, reducer commit boundary, abort handling, loading-kind classification, and browse/search request routing.

9. **Name:** Visible refresh commits against the same visible result set even if requested state drifts again, and stale refreshes cannot overwrite a newer committed window
   **Type:** integration
   **Disposition:** extend
   **Harness:** Store harnesses (`sessionsThunks.test.ts`)
   **Preconditions:** A store with committed sidebar search results for query A plus deferred promises for a visible refresh of A, a replacement request whose requested state moves to browse or query B, and a later replacement or refresh that can commit a newer visible window before the older refresh resolves.
   **Actions:** Start a visible refresh for query A, then change requested state with a replacement request while leaving A visible; resolve the older visible refresh and inspect state. In a second phase, let a newer commit replace the visible window before the older visible refresh resolves, then resolve the stale refresh.
   **Expected outcome:** Source of truth: implementation plan Behavior Contract bullets for visible-refresh authority. Requested-state drift alone does not invalidate the visible refresh: if query A is still the visible applied result set and the captured visible-window version/token is unchanged, the refresh may commit without rewriting requested state or cancelling the pending replacement. If a newer commit has already replaced the visible window, the stale refresh is discarded instead of overwriting newer data that happens to share the same query/tier.
   **Interactions:** Visible-refresh commit guard, applied result-set identity token, replacement sequencing, stale response suppression, and requested-vs-applied drift.

10. **Name:** The reducer only advances applied search fields when new window data commits
   **Type:** unit
   **Disposition:** extend
   **Harness:** Store harnesses (`sessionsSlice.test.ts`)
   **Preconditions:** A `SessionWindowState` with committed search results and populated applied search fields.
   **Actions:** Dispatch `setSessionWindowLoading()` with a new requested query and tier; inspect state. Then dispatch `setSessionWindowData()` for the replacement result set; inspect state again.
   **Expected outcome:** Source of truth: implementation plan Strategy Gate and Behavior Contract sections describing `setSessionWindowLoading()` as a requested-state update and `setSessionWindowData()` as the commit point for the visible result set. Loading updates only `query/searchTier`; data commit updates both requested and applied fields to the newly committed values.
   **Interactions:** Pure reducer boundary for the visible-result-set contract.

11. **Name:** Applied title search uses the shared metadata rules for fallback gating and rejects ancestor-only matches
    **Type:** invariant
    **Disposition:** extend
    **Harness:** Selector harness
    **Preconditions:** Selector state contains server-backed items, synthesized fallback rows, and requested search state that intentionally differs from applied search state. Fixtures cover an indexed row whose `projectPath` leaf is `trycycle`, a fallback row whose `cwd` leaf is `trycycle`, and rows whose ancestor path segment is `code`.
    **Actions:** Run `makeSelectSortedSessionItems()` with an applied title query of `trycycle`, then with an applied title query of `code`, then with an applied deep-search tier while keeping the same fallback fixtures.
    **Expected outcome:** Source of truth: user transcript plus implementation plan Behavior Contract bullets on leaf-only directory matching, project-path precedence for indexed rows, fallback `cwd` matching, and no fallback injection for deep tiers. Indexed rows match on their leaf subtitle metadata, cwd-only fallback rows match on their leaf, ancestor-only `code` does not match, and deep tiers drop fallback rows entirely.
    **Interactions:** Shared metadata matcher contract, selector state inputs, fallback-row synthesis, and applied tier handling.

12. **Name:** Applied search disables tab pinning in `activity` and `recency-pinned` modes while preserving archived-last ordering and ignoring requested-state drift
    **Type:** invariant
    **Disposition:** extend
    **Harness:** Selector harness
    **Preconditions:** Selector state includes a newer non-tab server row, an older matching fallback row with `hasTab: true`, archived and non-archived rows, and requested search state that differs from applied search state.
    **Actions:** Run the selector under `activity` sort, then under `recency-pinned`, first with an applied search active and then with no applied search.
    **Expected outcome:** Source of truth: implementation plan Behavior Contract bullets that search disables `hasTab` pinning regardless of sort mode, archived-last remains intact, and selector search behavior must come from applied fields rather than requested ones. During applied search, the older fallback row is not promoted above the newer non-tab row in either sort mode, archived rows remain last, and requested-state drift does not re-enable pinning or re-filter the visible set early. Without applied search, the existing pinning behavior stays unchanged.
    **Interactions:** Sort comparator behavior, archived grouping, requested vs applied state, and synthesized fallback rows.

13. **Name:** `/api/session-directory` title-tier search matches the subdirectory leaf through the real HTTP contract and keeps the existing schema
    **Type:** integration
    **Disposition:** extend
    **Harness:** HTTP router harness
    **Preconditions:** The Express router is mounted with indexed sessions whose `projectPath` or deeper `cwd` leaf is `trycycle`, while titles omit that term. A sibling path containing ancestor segment `code` is also present to prove rejection. Providers are omitted for title-tier requests where possible.
    **Actions:** Issue `GET /api/session-directory?priority=visible&query=trycycle`, then `GET /api/session-directory?priority=visible&query=code`, and inspect the returned JSON.
    **Expected outcome:** Source of truth: user transcript, implementation plan Behavior Contract, and the unchanged `SessionDirectoryPage` schema in `shared/read-models.ts`. The `trycycle` query returns the matching session through the real endpoint; the `code` query does not return it on ancestor-only path text; the response shape stays in the current read-model contract, including existing `matchedIn` semantics and no new transport fields.
    **Interactions:** Router query parsing, service invocation, read-model schema validation, and title-tier provider-free search path.

14. **Name:** Service-level title-tier search keeps ordering, snippet behavior, provider-free execution, and the existing low-risk performance guard after directory matching is added
    **Type:** integration
    **Disposition:** extend
    **Harness:** Service harness
    **Preconditions:** Direct `querySessionDirectory()` fixtures cover title matches, summary or first-user-message matches, project-path leaf matches, deeper `cwd` values for indexed sessions, archived sessions, and a large corpus for the performance guard.
    **Actions:** Query the service with title-tier searches that hit each metadata source; query with an ancestor-only term; query without providers; run the existing many-session timing guard.
    **Expected outcome:** Source of truth: implementation plan Behavior Contract and Strategy Gate, especially the rules to keep title-tier metadata search provider-free and keep snippet extraction in the service. Directory matches preserve the canonical ordering and archived handling, metadata snippets stay bounded and query-focused, title-tier search still works without file providers, ancestor-only queries do not match, and the generous timing guard still catches catastrophic regressions without turning this task into performance work.
    **Interactions:** Projection ordering, server-side snippet extraction, provider lookup bypass for title tier, and metadata-only search cost.

15. **Name:** Shared title-tier metadata matching extracts leaf directory names cross-platform and honors the required precedence
    **Type:** unit
    **Disposition:** new
    **Harness:** Shared matcher harness
    **Preconditions:** Pure metadata fixtures cover POSIX and Windows paths, trailing separators, indexed sessions with both `projectPath` and deeper `cwd`, fallback rows with only `cwd`, summary and first-user-message metadata, and an ancestor-only query.
    **Actions:** Call `getLeafDirectoryName()` and `matchTitleTierMetadata()` across those fixtures.
    **Expected outcome:** Source of truth: implementation plan Behavior Contract and Task 1 test requirements. Leaf extraction returns `trycycle` from both POSIX and Windows paths, trailing separators are ignored, precedence is `title` then `projectPath` leaf then distinct `cwd` leaf then `summary` then `firstUserMessage`, indexed sessions prefer the `projectPath` leaf, cwd-only fallback metadata still matches, and ancestor-only `code` does not match.
    **Interactions:** Pure shared metadata-matching seam used by both the server search path and client fallback gating.

## Coverage summary

- **Covered action space:** typing into the sidebar search input; changing the search tier dropdown; clicking the clear-search button; triggering near-bottom scroll and underfilled-viewport append logic; rendering committed search results while replacement work is in flight; active-query refresh via app-level invalidation; visible-refresh commit ordering under requested-state drift; selector merging of server rows with synthesized fallback rows from tabs/panes; HTTP `GET /api/session-directory` title-tier queries; service-level metadata search; shared path-leaf extraction.
- **Covered unchanged behaviors kept as regression gates:** first-load blocking search hides fallback tabs; active-query background refresh remains silent; title-tier search remains provider-free; archived-last ordering remains intact; existing read-model transport shape does not change.
- **Explicitly excluded:** deep file-content matching correctness beyond fallback suppression, click-to-open session behavior, and terminal-directory/busy-indicator behavior. Those surfaces are unchanged by this task and already have dedicated coverage elsewhere.
- **Risk carried by the exclusions:** if unrelated deep-search file scanning, session-open behavior, or terminal-state rendering regress at the same time, this plan will detect only the parts that overlap with applied search state and fallback gating, not every independent failure in those adjacent features.
