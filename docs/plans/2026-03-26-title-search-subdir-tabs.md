# Sidebar Title Search Subdirectory And Open-Tab Search Behavior Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sidebar title-tier search match a session's leaf subdirectory name and make active search show open-tab fallback sessions only when they truly match, without pinning them above other search results or corrupting in-flight browse/search replacement state.

**Architecture:** Treat the `"title"` tier as metadata search, not literal title-only search. Add one shared pure matcher for title-tier metadata and use it in both the server query path and the client fallback-row gate. Keep sidebar search state split into requested context (`query/searchTier`) and visible applied context (`appliedQuery/appliedSearchTier`), then split session-window orchestration into two explicit flows: replacement requests that own requested state for explicit browse/search changes and visible refreshes that revalidate the committed result set using applied-result identity (applied query/tier plus a committed-window version/token) without consulting requested state, rewriting requested state, or aborting a pending replacement request.

**Tech Stack:** React 18, Redux Toolkit, Express, shared TypeScript utilities, Vitest, Testing Library

---

## Behavior Contract

- Title-tier queries match `title`, then the leaf directory name derived from `projectPath`, then a distinct leaf directory name from `cwd` when it adds information the `projectPath` leaf does not, then the existing metadata fields `summary` and `firstUserMessage`.
- Only leaf directory names are searchable. `/home/user/code/trycycle` matches `trycycle`; it does not match `code` unless some other searchable field independently matches `code`.
- For indexed sessions, the canonical searchable "subdirectory" is the same project-path leaf the sidebar already shows as the subtitle. For synthesized fallback rows that only know `cwd`, the `cwd` leaf remains searchable.
- During an applied search, server-window rows stay authoritative. The client may inject synthesized fallback rows only when it can locally prove they match the applied search tier.
- For `userMessages` and `fullText`, do not inject fallback rows at all. The client cannot safely prove deep-file matches, so the server remains authoritative.
- An applied search disables `hasTab` pinning regardless of sidebar sort mode. Matching open tabs may appear, but they sort with the normal unpinned comparator for that mode, while archived-last behavior remains intact.
- Requested search state and applied search state are different contracts:
  `query/searchTier` track the next requested browse/search state and may change as soon as loading starts.
  `appliedQuery/appliedSearchTier` describe the result set currently stored in `projects` and must remain stable until replacement data commits.
- Typing and in-flight query replacement must not locally re-filter the last committed result set. Selector search inputs must come from `appliedQuery/appliedSearchTier`, not the raw input box text or the just-requested query.
- Clearing the search box starts a browse replacement request immediately, but the visible list remains the old applied search result set until browse data commits.
- Visible refreshes are a separate contract from replacement requests. `refreshActiveSessionWindow()` and queued invalidations revalidate the currently visible applied result set, not the next requested browse/search state. They must not rewrite `query/searchTier`, must not abort a pending browse/search replacement request, and must not discard that pending replacement when the refresh data commits.
- Visible-refresh commit eligibility is based only on the visible applied result-set identity captured at refresh start. Capture the applied query/tier plus the committed window version/token (for example `lastLoadedAt` or an equivalent monotonic commit token). Requested state may drift again while the refresh is in flight; that alone must not block a valid visible-refresh commit. Only the visible result set changing out from under the refresh should invalidate it.
- Once replacement data commits, `appliedQuery/appliedSearchTier` advance to the new result set, and subsequent refreshes follow that newly visible context.
- Blocking first-load behavior stays unchanged: if there is no applied result set yet and search is loading, fallback rows remain hidden.

## File Structure

- Create: `shared/session-title-search.ts`
  Responsibility: cross-platform leaf-directory extraction plus shared title-tier metadata matching.
- Modify: `server/session-directory/service.ts`
  Responsibility: replace inline metadata matching with the shared helper while preserving current paging, cursor, snippet formatting, and schema behavior.
- Modify: `src/store/sessionsSlice.ts`
  Responsibility: keep requested and applied sidebar search state separate at the reducer boundary so the visible result set has an explicit contract.
- Modify: `src/store/sessionsThunks.ts`
  Responsibility: split replacement requests from visible refreshes so refreshes revalidate the applied result set by visible-result identity, without rewriting requested state or aborting pending browse/search replacement.
- Modify: `src/store/selectors/sidebarSelectors.ts`
  Responsibility: gate fallback rows from applied search context and disable tab pinning whenever an applied search is active.
- Modify: `src/components/Sidebar.tsx`
  Responsibility: keep search controls driven by requested state while keeping visible-result-set decisions driven by applied state.
- Create: `test/unit/shared/session-title-search.test.ts`
  Responsibility: direct coverage for cross-platform leaf-directory extraction plus project-path-vs-cwd match precedence.
- Modify: `test/unit/server/session-directory/service.test.ts`
  Responsibility: prove server title-tier search matches the indexed subdirectory leaf, rejects ancestor-only matches, and keeps current result ordering and snippet behavior.
- Modify: `test/integration/server/session-directory-router.test.ts`
  Responsibility: prove `/api/session-directory` preserves the existing transport contract while surfacing leaf-directory title-tier matches.
- Modify: `test/unit/client/store/sessionsSlice.test.ts`
  Responsibility: prove requested state, applied state, and reducer commit boundaries stay intentionally separated.
- Modify: `test/unit/client/store/sessionsThunks.test.ts`
  Responsibility: prove replacement requests and visible refreshes obey different contracts, especially during search-to-browse drift.
- Modify: `test/unit/client/store/selectors/sidebarSelectors.test.ts`
  Responsibility: prove fallback-row matching and applied-search sort behavior, including "no pinning while searching."
- Modify: `test/unit/client/components/Sidebar.test.tsx`
  Responsibility: prove committed search hides unrelated open-tab fallbacks, shows matching title-tier fallbacks, preserves blocking-load behavior, and keeps old visible results stable while replacement work is in flight.
- Modify: `test/e2e/sidebar-search-flow.test.tsx`
  Responsibility: user-visible regression coverage for subdirectory matching plus open-tab search behavior through the real sidebar flow.
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`
  Responsibility: user-visible regression coverage that direct refresh and queued invalidation during search-to-browse drift stay silent and preserve the pending browse replacement.

## Strategy Gate

- Do refactor thunk/control-flow now. The blocker is not just reducer state; the request pipeline must distinguish replacement requests from visible refreshes.
- Do not keep routing visible refreshes through the generic `fetchSessionWindow()` replacement path when requested and applied contexts differ.
- Do not let the visible-refresh path own or replace the surface abort controller for a pending browse/search replacement request.
- Do not make visible-refresh commit eligibility depend on requested `query/searchTier`. Requested state is future intent, not the authority for whether a visible refresh may commit.
- Do not key visible-refresh safety to query/tier alone when the same applied context can be refreshed multiple times. Capture a visible-result version/token so an older refresh cannot overwrite a newer committed window that happens to share the same applied query/tier.
- Do not let a visible-refresh commit rewrite requested `query/searchTier`, clear a pending browse/search replacement, or prematurely advance the applied context to browse mode.
- Do not solve selector behavior by passing raw search-box text into `makeSelectSortedSessionItems()`. The selector must read applied search context from `sessions.windows.sidebar`.
- Do not prefer `cwd` over `projectPath` for indexed sessions. Indexed rows should keep the project-path leaf as the canonical searchable subtitle; `cwd` is the fallback-only or secondary signal.
- Do not move snippet extraction into the shared helper. The shared matcher should answer "what matched?"; server snippet formatting stays in `server/session-directory/service.ts`.
- Do not widen the read-model schema with a new transport field for directory matches. Leaf-directory matches remain represented as `"title"` matches so the HTTP contract stays stable.
- Do not use full-path substring matching for the new behavior. Restrict matching to the leaf directory name so common ancestors like `code`, `src`, and home-directory segments do not produce noisy false positives.
- Do not keep pinning "mostly on" during applied search. Search mode is unpinned mode.

### Task 1: Add Shared Title-Tier Metadata Matching And Wire The Server To It

**Files:**
- Create: `shared/session-title-search.ts`
- Create: `test/unit/shared/session-title-search.test.ts`
- Modify: `server/session-directory/service.ts`
- Modify: `test/unit/server/session-directory/service.test.ts`
- Modify: `test/integration/server/session-directory-router.test.ts`

- [ ] **Step 1: Write the failing shared, service, and router tests**

In `test/unit/shared/session-title-search.test.ts`, add direct coverage for:

- POSIX path leaf extraction: `"/home/user/code/trycycle"` -> `"trycycle"`
- Windows path leaf extraction: `"C:\\Users\\me\\code\\trycycle"` -> `"trycycle"`
- trailing slash trimming on both path styles
- title-tier precedence: title match before project-path leaf, project-path leaf before distinct `cwd` leaf, and both leaf sources before `summary` / `firstUserMessage`
- indexed-session precedence: `projectPath="/repo/trycycle"` and `cwd="/repo/trycycle/server"` still match `trycycle`
- fallback/local-only coverage: `cwd="/repo/trycycle"` with no `projectPath` still matches `trycycle`
- ancestor-only query like `"code"` does not match `"/home/user/code/trycycle"` when no other field contains `"code"`

In `test/unit/server/session-directory/service.test.ts`, extend `querySessionDirectory()` coverage with cases that prove:

- a title-tier query matches a session whose `projectPath` leaf is the query text even when the title does not match
- the same indexed session still matches by `projectPath` leaf when its `cwd` points deeper into that repo
- the same query does not match solely because an ancestor path segment contains the text
- result ordering still follows the existing recency/archived contract after directory matches are added
- title-tier search still works without file providers
- existing snippet behavior remains bounded and query-focused for metadata matches while leaf-directory matches produce the expected short snippet

In `test/integration/server/session-directory-router.test.ts`, extend the real HTTP round-trip to prove:

- `GET /api/session-directory?priority=visible&query=trycycle` returns the leaf-directory match
- `GET /api/session-directory?priority=visible&query=code` does not return that same session on ancestor-only path text
- the response shape stays in the current `SessionDirectoryPage` schema with no new transport fields

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
FRESHELL_TEST_SUMMARY="task1 shared+server title-tier subdirectory search" \
  npm run test:vitest -- \
  test/unit/shared/session-title-search.test.ts \
  test/unit/server/session-directory/service.test.ts \
  test/integration/server/session-directory-router.test.ts
```

Expected: FAIL because the shared matcher is missing or incomplete and the title-tier server/router path still ignores leaf-directory metadata.

- [ ] **Step 3: Implement the shared matcher and switch the server title tier to use it**

In `shared/session-title-search.ts`, add a small pure utility with this contract:

```ts
export type TitleTierMetadata = {
  title?: string
  summary?: string
  firstUserMessage?: string
  cwd?: string
  projectPath?: string
}

export type TitleTierMatch = {
  matchedIn: 'title' | 'summary' | 'firstUserMessage'
  matchedValue: string
}

export function getLeafDirectoryName(pathLike?: string): string | undefined

export function matchTitleTierMetadata(
  metadata: TitleTierMetadata,
  query: string,
): TitleTierMatch | null
```

Implementation requirements:

- normalize both `/` and `\\`
- trim trailing separators before taking the last non-empty segment
- match precedence is `title` -> `projectPath` leaf -> distinct `cwd` leaf -> `summary` -> `firstUserMessage`
- when a leaf directory name is the winning match, return `matchedIn: 'title'` and `matchedValue: leafDirectoryName` so the transport contract stays unchanged

In `server/session-directory/service.ts`:

- replace the inline metadata scan with the shared helper
- keep `extractSnippet(match.matchedValue, queryText, 40).slice(0, 140)` in the server service
- keep the current page/cursor flow, ordering, and archived handling unchanged
- keep title-tier search provider-free

- [ ] **Step 4: Re-run the targeted tests to verify they pass**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
FRESHELL_TEST_SUMMARY="task1 shared+server title-tier subdirectory search" \
  npm run test:vitest -- \
  test/unit/shared/session-title-search.test.ts \
  test/unit/server/session-directory/service.test.ts \
  test/integration/server/session-directory-router.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify the server seam**

Refactor only after the targeted tests are green:

- remove any duplicated leaf-directory extraction logic introduced during the task
- keep helper boundaries clear: shared metadata matching in `shared/`, snippet formatting in the server service
- verify the HTTP layer still honors the unchanged read-model contract

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
FRESHELL_TEST_SUMMARY="task1 server seam verification" \
  npm run test:vitest -- \
  test/unit/shared/session-title-search.test.ts \
  test/unit/server/session-directory/service.test.ts \
  test/integration/server/session-directory-router.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
git add \
  shared/session-title-search.ts \
  server/session-directory/service.ts \
  test/unit/shared/session-title-search.test.ts \
  test/unit/server/session-directory/service.test.ts \
  test/integration/server/session-directory-router.test.ts
git commit -m "feat: extend title search with subdirectory matches"
```

### Task 2: Make The Reducer Boundary Explicit For Requested Vs Applied Search State

**Files:**
- Modify: `src/store/sessionsSlice.ts`
- Modify: `test/unit/client/store/sessionsSlice.test.ts`

- [ ] **Step 1: Write the failing reducer tests**

In `test/unit/client/store/sessionsSlice.test.ts`, add or tighten coverage that proves:

- `setSessionWindowLoading()` updates `query/searchTier` for the next request but preserves existing `appliedQuery/appliedSearchTier`
- `setSessionWindowData()` updates requested and applied fields together when replacement data commits
- starting a browse replacement from previously searched results keeps the old applied search context until browse data commits
- a failed replacement request preserves the last applied search context
- a visible-refresh-style data commit can update the visible result set and applied fields without overwriting requested fields or clearing an in-flight replacement loading state

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
FRESHELL_TEST_SUMMARY="task2 requested vs applied reducer contract" \
  npm run test:vitest -- \
  test/unit/client/store/sessionsSlice.test.ts
```

Expected: FAIL because the reducer boundary is not yet explicit enough for both replacement commits and visible-refresh commits.

- [ ] **Step 3: Implement the reducer contract**

In `src/store/sessionsSlice.ts`:

- keep `query/searchTier` as requested control state written when loading starts
- keep `appliedQuery/appliedSearchTier` as the visible-result-set contract
- make replacement commits advance requested and applied state together
- keep the previous applied fields when loading begins, errors occur, or a replacement request is aborted before new data lands
- support visible-refresh commits without rewriting requested state or dropping an in-flight replacement loading state

The code shape may keep the current action names or narrow them, but the reducer contract must be obvious in both implementation and tests: replacement commits move requested plus applied state; visible refreshes move applied state only.

- [ ] **Step 4: Re-run the targeted tests to verify they pass**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
FRESHELL_TEST_SUMMARY="task2 requested vs applied reducer contract" \
  npm run test:vitest -- \
  test/unit/client/store/sessionsSlice.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify the reducer seam**

Refactor only after the targeted tests are green:

- keep the reducer contract obvious in code, not hidden behind ambiguous flag combinations
- remove duplicated test setup once the helper fixtures express the intended states clearly

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
FRESHELL_TEST_SUMMARY="task2 reducer seam verification" \
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
git commit -m "refactor: clarify applied sidebar search state"
```

### Task 3: Split Replacement Requests From Visible Refreshes In Session Thunks

**Files:**
- Modify: `src/store/sessionsThunks.ts`
- Modify: `test/unit/client/store/sessionsThunks.test.ts`
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`

- [ ] **Step 1: Write the failing thunk and app-level regressions**

In `test/unit/client/store/sessionsThunks.test.ts`, add or tighten coverage that proves:

- with visible search results already committed, dispatching a replacement search immediately changes `query/searchTier` but leaves `appliedQuery/appliedSearchTier` on the old visible results until replacement data commits
- clearing search starts a browse replacement request immediately, but the applied search context remains on the visible search results until browse data commits
- while that search-to-browse drift exists, `queueActiveSessionWindowRefresh()` refreshes the visible applied search results silently, does not rewrite requested browse state, does not abort the pending browse request, and leaves the pending browse replacement alive to commit later
- while that same drift exists, direct `refreshActiveSessionWindow()` follows the same visible-refresh contract instead of routing through the generic replacement path
- while a visible refresh for query A is in flight, requested state may drift again to browse or query B and the refresh still commits if A is still the visible applied result set, leaving requested state untouched
- if a newer commit replaces the visible result set before an older visible refresh resolves, the stale refresh is discarded instead of overwriting the newer committed window
- once the browse replacement commits, `appliedQuery/appliedSearchTier` advance to browse mode and later refreshes follow browse state instead of the stale search

Make the direct-refresh drift test assert the missing invariant explicitly:

- `fetchSidebarSessionsSnapshot` for the browse replacement stays at one in-flight call until it resolves
- its `AbortSignal` is not aborted by the direct refresh
- `query` stays cleared while `appliedQuery` stays on the visible search results

In `test/e2e/open-tab-session-sidebar-visibility.test.tsx`, extend the existing refresh drift scenario to assert:

- clearing search starts a browse request without removing the still-visible search results
- dispatching `refreshActiveSessionWindow()` during that drift keeps the visible search rows on screen and keeps search chrome silent
- after the direct refresh resolves, the browse replacement still commits and the applied search state finally clears

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
FRESHELL_TEST_SUMMARY="task3 sidebar refresh drift contract" \
  npm run test:vitest -- \
  test/unit/client/store/sessionsThunks.test.ts \
  test/e2e/open-tab-session-sidebar-visibility.test.tsx
```

Expected: FAIL because refresh work still shares too much control flow with replacement requests.

- [ ] **Step 3: Refactor thunk control flow around two request types**

In `src/store/sessionsThunks.ts`:

- keep `fetchSessionWindow()` as the replacement-request path for explicit browse/search changes and pagination
- add or refine a dedicated visible-refresh path that:
  - captures the visible result-set identity at refresh start (applied query/tier plus the committed window version/token)
  - fetches using the currently applied visible context
  - commits only if that same visible result set is still on screen when the refresh resolves
  - never consults requested context to decide commit eligibility
  - updates visible results without rewriting requested state
  - never aborts or replaces the controller for an in-flight browse/search replacement request
- update `refreshActiveSessionWindow()` so:
  - it uses the visible-refresh path for revalidating what is already on screen, rather than calling the replacement-request path
- keep `queueActiveSessionWindowRefresh()` queue-based, but make it use the same visible-refresh helper as direct refresh; it may preserve existing loading chrome when a replacement request is already in flight, but it must not own or replace that replacement controller
- preserve current two-phase deep-search behavior and current browse pagination behavior

The key invariant is not optional: refreshing what is visible during drift must not mutate or cancel the pending replacement that will eventually replace it.

- [ ] **Step 4: Re-run the targeted tests to verify they pass**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
FRESHELL_TEST_SUMMARY="task3 sidebar refresh drift contract" \
  npm run test:vitest -- \
  test/unit/client/store/sessionsThunks.test.ts \
  test/e2e/open-tab-session-sidebar-visibility.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify the request seam**

Refactor only after the targeted tests are green:

- keep helper names aligned with the two contracts: replacement request vs visible refresh
- remove any remaining path that infers "current visible query" from requested state during drift
- verify visible-refresh commit guards are based on visible-result identity, not requested state, and that stale refreshes cannot overwrite a newer committed window with the same query/tier
- verify silent refresh, abort behavior, and replacement commits remain consistent

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
FRESHELL_TEST_SUMMARY="task3 request seam verification" \
  npm run test:vitest -- \
  test/unit/client/store/sessionsThunks.test.ts \
  test/e2e/open-tab-session-sidebar-visibility.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
git add \
  src/store/sessionsThunks.ts \
  test/unit/client/store/sessionsThunks.test.ts \
  test/e2e/open-tab-session-sidebar-visibility.test.tsx
git commit -m "fix: separate sidebar refresh from replacement requests"
```

### Task 4: Make Sidebar Search Fallback Rows Match-Aware And Unpinned

**Files:**
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Modify: `src/components/Sidebar.tsx`
- Modify: `test/unit/client/store/selectors/sidebarSelectors.test.ts`
- Modify: `test/unit/client/components/Sidebar.test.tsx`
- Modify: `test/e2e/sidebar-search-flow.test.tsx`

- [ ] **Step 1: Write the failing selector, component, and flow regressions**

In `test/unit/client/store/selectors/sidebarSelectors.test.ts`, add or tighten coverage for:

- synthesized fallback rows are marked distinctly from server-backed rows
- applied title search keeps a fallback row whose leaf directory name matches the query
- applied title search prefers the project-path leaf for indexed rows while still allowing cwd-only fallback rows to match
- applied title search rejects rows when only an ancestor path segment matches
- applied deep search (`userMessages` / `fullText`) drops fallback rows entirely
- applied search disables tab pinning in both `activity` and `recency-pinned` modes while preserving archived-last ordering
- selector search behavior comes from `appliedQuery/appliedSearchTier`, not from the requested `query/searchTier`

In `test/unit/client/components/Sidebar.test.tsx`, add or tighten coverage for:

- a loaded title search result plus an unrelated open fallback tab: only the server result remains visible
- a loaded title search plus a fallback open tab whose `cwd` leaf matches the query: both rows are visible, but the fallback row is not pinned above the newer server result
- a loaded deep search: fallback rows stay hidden even if local title or directory metadata would have matched
- starting a replacement search while an older applied query is still displayed does not locally re-filter the committed result set before the new server response arrives
- clearing the search box while older applied search results are still visible does not release browse append pagination until browse data replaces that visible result set
- blocking first-load search still hides fallback rows under the spinner

In `test/e2e/sidebar-search-flow.test.tsx`, extend the real sidebar flow to prove:

- searching `trycycle` returns a title-tier hit whose title does not contain `trycycle` but whose `projectPath` or fallback `cwd` leaf is `trycycle`
- searching `code` does not return that same hit unless some other searchable metadata actually contains `code`
- during applied search, an open fallback tab is shown only when it matches the applied title-tier query
- that matching fallback row is not pinned above a newer non-tab server match

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
FRESHELL_TEST_SUMMARY="task4 sidebar search fallback gating" \
  npm run test:vitest -- \
  test/unit/client/store/selectors/sidebarSelectors.test.ts \
  test/unit/client/components/Sidebar.test.tsx \
  test/e2e/sidebar-search-flow.test.tsx
```

Expected: FAIL because the selector and sidebar still do not fully treat applied search as the visible-result-set contract.

- [ ] **Step 3: Implement applied-search fallback gating and search-time unpinned sorting**

In `src/store/selectors/sidebarSelectors.ts`:

- keep project-backed server rows authoritative during applied search
- keep fallback rows only when `matchTitleTierMetadata()` can prove a title-tier match from local metadata already on the item
- drop fallback rows entirely for applied deep-search tiers
- disable tab pinning whenever an applied query is active, while preserving archived-last behavior and existing browse-mode ordering
- keep `makeSelectSortedSessionItems()` callable as `(state, terminals, filter)`; read applied search context from `sessions.windows.sidebar` inside the selector

In `src/components/Sidebar.tsx`:

- keep the input control, debounce behavior, loading chrome, and tier dropdown driven by requested `query/searchTier`
- drive "what result set is currently on screen?" decisions from `appliedQuery/appliedSearchTier`
- specifically, keep browse append pagination disabled while `appliedQuery` is non-empty, even if the local input has already been cleared and a browse request is in flight

- [ ] **Step 4: Re-run the targeted tests to verify they pass**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
FRESHELL_TEST_SUMMARY="task4 sidebar search fallback gating" \
  npm run test:vitest -- \
  test/unit/client/store/selectors/sidebarSelectors.test.ts \
  test/unit/client/components/Sidebar.test.tsx \
  test/e2e/sidebar-search-flow.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify the broader required suite**

Refactor only after the targeted tests are green:

- remove any duplicated leaf-directory extraction or applied-search gating logic introduced during the task
- keep helper boundaries clear: shared metadata matching in `shared/`, reducer state in `sessionsSlice`, request orchestration in `sessionsThunks`, selector policy in `sidebarSelectors`, and visible-result-set policy in `Sidebar.tsx`
- verify there is no regression in silent refresh, blocking-load, deep-search pending behavior, or server/router search behavior

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
npm run lint
FRESHELL_TEST_SUMMARY="final verification for title-search subdir tabs" npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
git add \
  src/store/selectors/sidebarSelectors.ts \
  src/components/Sidebar.tsx \
  test/unit/client/store/selectors/sidebarSelectors.test.ts \
  test/unit/client/components/Sidebar.test.tsx \
  test/e2e/sidebar-search-flow.test.tsx
git commit -m "fix: make sidebar search authoritative over open tabs"
```
