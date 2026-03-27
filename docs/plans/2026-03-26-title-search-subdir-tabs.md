# Sidebar Title Search Subdirectory And Open-Tab Search Behavior Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sidebar title-tier search match a session's leaf subdirectory name and make active search show open-tab fallback sessions only when they truly match, without pinning them above other search results.

**Architecture:** Treat the `"title"` tier as metadata search, not literal title-only search. Add one shared pure matcher for title-tier metadata and use it in both the server title-tier query path and the client's fallback-row gating, but keep snippet extraction in the server service so existing search-result formatting stays intact. Keep server search authoritative for indexed results, explicitly distinguish synthesized fallback rows inside the selector, and drive search-mode fallback gating plus no-pinning behavior from `sessions.windows.sidebar` state instead of changing the selector's public call signature.

**Tech Stack:** React 18, Redux Toolkit, Express, shared TypeScript utilities, Vitest, Testing Library

---

## Behavior Contract

- Title-tier queries match `title`, then the leaf directory name derived from `projectPath`, then a distinct leaf directory name from `cwd` when it adds information the `projectPath` leaf does not, then the existing metadata fields `summary` and `firstUserMessage`.
- Only leaf directory names are searchable. `/home/user/code/trycycle` matches `trycycle`; it does not match `code` unless some other field independently matches `code`.
- For indexed sessions, the canonical "subdirectory" match is the same project-path leaf the sidebar already shows as the subtitle. For synthesized fallback rows that only know `cwd`, the `cwd` leaf remains searchable.
- During a committed search, server-window rows stay authoritative. The client may inject synthesized fallback rows only when it can locally prove they match the active search tier.
- For `userMessages` and `fullText`, do not inject fallback rows at all. The client cannot safely prove deep-file matches, so the server must stay authoritative.
- A committed search disables `hasTab` pinning regardless of sidebar sort mode. Matching open tabs may appear, but they sort with the normal unpinned comparator for that mode, while archived-last behavior remains intact.
- Uncommitted typing and in-flight query replacement must not locally re-filter the last committed result set. Selector search inputs must come from `sidebarWindow.query` and `sidebarWindow.searchTier`, not the raw input box text.
- Blocking first-load behavior stays unchanged: if there is no committed result set yet and search is loading, fallback rows remain hidden.

## File Structure

- Create: `shared/session-title-search.ts`
  Responsibility: cross-platform leaf-directory extraction plus shared title-tier metadata matching. This becomes the single contract for what `"title"` search means, while leaving snippet formatting to the server.
- Modify: `server/session-directory/service.ts`
  Responsibility: replace inline metadata matching with the shared helper while preserving current paging, cursor, snippet formatting, and schema behavior.
- Modify: `src/store/selectors/sidebarSelectors.ts`
  Responsibility: mark fallback rows explicitly, gate fallback rows during committed search using the shared matcher against existing item metadata, and disable `hasTab` pinning while committed search is active without changing the selector's public signature.
- Create: `test/unit/shared/session-title-search.test.ts`
  Responsibility: direct coverage for cross-platform leaf-directory extraction plus project-path-vs-cwd match precedence.
- Modify: `test/unit/server/session-directory/service.test.ts`
  Responsibility: prove server title-tier search matches the indexed subdirectory leaf, rejects ancestor-only matches, and keeps current result ordering and snippet behavior.
- Modify: `test/unit/client/store/selectors/sidebarSelectors.test.ts`
  Responsibility: prove fallback-row matching and search-time sort behavior, including "no pinning while searching."
- Modify: `test/unit/client/components/Sidebar.test.tsx`
  Responsibility: prove committed search hides unrelated open-tab fallbacks, shows matching title-tier fallbacks, preserves blocking-load behavior, and uses committed search context instead of raw input text.
- Modify: `test/e2e/sidebar-search-flow.test.tsx`
  Responsibility: user-visible regression coverage for subdirectory matching plus open-tab search behavior through the real sidebar flow.

## Strategy Gate

- Do not solve this by passing the raw search box text into the existing selector filter. That would incorrectly drop legitimate server results that matched `summary` or `firstUserMessage`, because the current client filter only sees title/subtitle/path/provider strings.
- Do not prefer `cwd` over `projectPath` for indexed sessions. The sidebar's indexed "subdirectory" comes from `projectPath`; `cwd` is only a secondary signal and the fallback-only path source.
- Do not move snippet extraction into the shared helper. The shared matcher should answer "what matched?" while `server/session-directory/service.ts` keeps the existing `extractSnippet(...).slice(0, 140)` behavior.
- Do not change the public call shape of `makeSelectSortedSessionItems()`. Read committed search context from `sessions.windows.sidebar` inside the selector so existing callers and tests do not need a new argument contract.
- Do not widen the read-model schema with a new `matchedIn` enum for directory matches. The `"title"` tier is already shorthand for metadata-only search, no current client flow distinguishes directory matches, and the clean steady state is to keep the existing transport contract stable.
- Do not keep pinning "mostly on" during search. The user explicitly asked for search to stop pinning open tabs. The clean rule is: pinning is a browse-mode concern, not a search-mode concern.
- Do not use raw full-path substring matching for the new behavior. Restrict matching to the leaf directory name so common ancestors like `code`, `src`, and home-directory segments do not produce noisy false positives.
- Do not add duplicate cached directory-name fields to sidebar items when the existing `projectPath`/`cwd` plus the shared matcher already provide the needed match inputs.

### Task 1: Add Shared Title-Tier Metadata Matching And Wire The Server To It

**Files:**
- Create: `shared/session-title-search.ts`
- Create: `test/unit/shared/session-title-search.test.ts`
- Modify: `server/session-directory/service.ts`
- Modify: `test/unit/server/session-directory/service.test.ts`

- [ ] **Step 1: Write the failing shared and server tests**

In `test/unit/shared/session-title-search.test.ts`, add direct coverage for:

- POSIX path leaf extraction: `"/home/user/code/trycycle"` -> `"trycycle"`
- Windows path leaf extraction: `"C:\\Users\\me\\code\\trycycle"` -> `"trycycle"`
- trailing slash trimming on both path styles
- title-tier precedence: title match wins before project-path leaf, project-path leaf wins before distinct cwd leaf, and both leaf sources win before summary / first-user-message
- indexed-session precedence: `projectPath="/repo/trycycle"` and `cwd="/repo/trycycle/server"` still match `trycycle`
- fallback/local-only coverage: `cwd="/repo/trycycle"` with no `projectPath` still matches `trycycle`
- directory-only match returns a non-null metadata match
- ancestor-only query like `"code"` does not match `"/home/user/code/trycycle"` when no other field contains `"code"`

In `test/unit/server/session-directory/service.test.ts`, extend `querySessionDirectory()` coverage with cases that prove:

- a title-tier query matches a session whose `projectPath` leaf is the query text even when the title does not match
- the same indexed session still matches by `projectPath` leaf when its `cwd` points deeper into that repo
- the same query does **not** match solely because an ancestor path segment contains the text
- result ordering still follows the existing recency/archived contract after directory matches are added
- the server still works without file providers for title-tier search
- existing snippet behavior remains bounded and query-focused for title / summary / first-user-message matches while leaf-directory matches produce the expected short snippet

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
FRESHELL_TEST_SUMMARY="task1 shared+server title-tier subdirectory search" \
  npm run test:vitest -- \
  test/unit/shared/session-title-search.test.ts \
  test/unit/server/session-directory/service.test.ts
```

Expected: FAIL because the shared helper does not exist yet and the server title-tier search still ignores leaf-directory metadata.

- [ ] **Step 3: Implement the shared matcher and switch the server title tier to use it**

In `shared/session-title-search.ts`, add a small pure utility with signatures in this shape:

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
- when a leaf directory name is the winning match, return `matchedIn: 'title'` and `matchedValue: leafDirectoryName`
  Rationale: this keeps the existing transport schema stable while still making the new metadata searchable

In `server/session-directory/service.ts`:

- replace the inline `applySearch()` field scan with the shared helper
- keep `extractSnippet(match.matchedValue, queryText, 40).slice(0, 140)` in the server service so title / summary / first-user-message snippets stay consistent with current behavior
- keep the current page/cursor flow unchanged
- keep existing result ordering and archived handling unchanged
- keep title-tier search provider-free; this remains metadata-only work

- [ ] **Step 4: Re-run the targeted tests to verify they pass**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
FRESHELL_TEST_SUMMARY="task1 shared+server title-tier subdirectory search" \
  npm run test:vitest -- \
  test/unit/shared/session-title-search.test.ts \
  test/unit/server/session-directory/service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
git add \
  shared/session-title-search.ts \
  server/session-directory/service.ts \
  test/unit/shared/session-title-search.test.ts \
  test/unit/server/session-directory/service.test.ts
git commit -m "feat: extend title search with subdirectory matches"
```

### Task 2: Make Sidebar Search Fallback Rows Match-Aware And Unpinned

**Files:**
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Modify: `test/unit/client/store/selectors/sidebarSelectors.test.ts`
- Modify: `test/unit/client/components/Sidebar.test.tsx`
- Modify: `test/e2e/sidebar-search-flow.test.tsx`

- [ ] **Step 1: Write the failing client and user-visible regressions**

In `test/unit/client/store/selectors/sidebarSelectors.test.ts`, add coverage for:

- `buildSessionItems()` marking synthesized local rows with a fallback-origin marker while leaving project-backed rows non-fallback
- committed title search keeping a fallback row whose leaf directory name matches the query
- committed title search preferring the project-path leaf for indexed rows while still allowing cwd-only fallback rows to match
- committed title search rejecting a fallback row when only an ancestor path segment matches
- committed deep search (`userMessages` / `fullText`) dropping fallback rows entirely
- committed search disabling tab pinning in both `activity` and `recency-pinned` modes while still preserving archived-last grouping
- selector search behavior coming from `sessions.windows.sidebar.query/searchTier`, not from a new selector argument

Use fixtures where:

- a server-backed non-tab row is newer than a matching fallback row
- the fallback row has `hasTab: true`
- sort mode is `activity` or `recency-pinned`

Expected ordering after the fix:

- the matching fallback row is present
- it is **not** forced ahead of the newer non-tab row solely because `hasTab === true`

In `test/unit/client/components/Sidebar.test.tsx`, add component regressions for:

- a committed title search result plus an unrelated open fallback tab: only the server result remains visible
- a committed title search plus a fallback open tab whose `cwd` leaf matches the query: both rows are visible, but the fallback row is not pinned above the newer server result
- a committed deep search: fallback tab rows stay hidden even if their title or directory would have matched locally
- typing a new query while an older committed query is still displayed does not locally re-filter the old committed result set before the new server response arrives
  This specifically guards against accidentally wiring the selector to raw `filter` instead of committed `sidebarWindow.query`
- existing blocking-load tests still hold: if there is no committed result set yet, fallback rows do not appear underneath the search spinner

In `test/e2e/sidebar-search-flow.test.tsx`, add a user-visible flow that proves both halves of the requested behavior:

- searching `trycycle` returns a title-tier hit whose title does not contain `trycycle` but whose `cwd` or `projectPath` leaf is `trycycle`
- searching `code` does not return that same hit unless another metadata field actually contains `code`
- when search is active, an open fallback tab is shown only when it matches the active committed title-tier query, and it is not pinned above a newer non-tab server match

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
FRESHELL_TEST_SUMMARY="task2 sidebar search fallback gating" \
  npm run test:vitest -- \
  test/unit/client/store/selectors/sidebarSelectors.test.ts \
  test/unit/client/components/Sidebar.test.tsx \
  test/e2e/sidebar-search-flow.test.tsx
```

Expected: FAIL because the selector currently ignores committed search context, keeps fallback rows during search regardless of match status, and still pins `hasTab` rows in search mode.

- [ ] **Step 3: Implement search-aware fallback gating and search-time unpinned sorting**

In `src/store/selectors/sidebarSelectors.ts`:

- extend `SidebarSessionItem` with the minimum extra metadata needed to distinguish synthesized rows without forcing unrelated typed fixtures to change, for example:

```ts
isFallback?: true
```

- leave project-backed rows without the marker
- set `isFallback: true` for synthesized open-tab fallback rows
- replace the current "one local filter for every row" approach with explicit search-mode behavior:
  - no committed query: keep current browse-mode behavior
  - committed title query: keep all project-backed server-window rows, keep fallback rows only when `matchTitleTierMetadata()` proves the fallback matches via locally available metadata already on the item (`title`, `projectPath`, `cwd`, `firstUserMessage`)
  - committed `userMessages` / `fullText`: keep all server-window rows, drop fallback rows

Drive that search-mode decision from `state.sessions.windows?.sidebar?.query` and `state.sessions.windows?.sidebar?.searchTier` inside the selector. Keep `makeSelectSortedSessionItems()` callable as `(state, terminals, filter)` so existing callers and tests do not take a new search-context parameter.

Add a small sort option rather than a second search-only sorter, for example:

```ts
sortSessionItems(items, sortMode, { disableTabPinning: searchQueryActive })
```

Behavior requirements:

- `recency` stays unchanged
- `recency-pinned` and `activity` skip the `hasTab` split when `disableTabPinning` is true
- archived sessions still stay after active sessions
- project-mode ordering stays unchanged
- keep the existing debounce and loading behavior intact by leaving that UI timing in `Sidebar.tsx` untouched unless a test proves a selector-only change is insufficient

- [ ] **Step 4: Re-run the targeted tests to verify they pass**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-title-search-subdir-tabs
FRESHELL_TEST_SUMMARY="task2 sidebar search fallback gating" \
  npm run test:vitest -- \
  test/unit/client/store/selectors/sidebarSelectors.test.ts \
  test/unit/client/components/Sidebar.test.tsx \
  test/e2e/sidebar-search-flow.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify with the broader required suite**

Refactor only after the targeted tests are green:

- remove any duplicated leaf-directory extraction logic introduced during the task
- keep helper boundaries clear: shared metadata matching in `shared/`, selector policy in `sidebarSelectors`, UI state timing in `Sidebar`
- verify there is no regression in silent refresh, blocking-load, or deep-search pending behavior

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
  test/unit/client/store/selectors/sidebarSelectors.test.ts \
  test/unit/client/components/Sidebar.test.tsx \
  test/e2e/sidebar-search-flow.test.tsx
git commit -m "fix: make sidebar search authoritative over open tabs"
```
