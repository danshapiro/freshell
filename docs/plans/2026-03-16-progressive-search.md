# Progressive Search Implementation Plan

## Problem Statement

Search is broken in two ways:

1. **Client-side search bypass:** When `searchTier === 'title'` and no `sidebarWindow` exists yet (but top-level sessions are loaded), `Sidebar.tsx` (line 226-229) short-circuits the server request entirely and falls back to client-side filtering via `filterSessionItems` in `sidebarSelectors.ts`. This client-side filter searches different fields (title, subtitle/project name, projectPath, provider) than the server's title tier (title, summary, firstUserMessage). The result: the two code paths produce inconsistent results, and the server's richer metadata search (summary, firstUserMessage) is never exercised for the most common case.

2. **Blocking deep search:** When a user selects a deeper search tier (userMessages or fullText), the current system fires a single HTTP request to `/api/session-directory` with the chosen tier. The entire result set is computed server-side (scanning JSONL files sequentially) before any response is sent. During this time, the sidebar shows either a spinner or nothing -- the user sees zero results until the full scan completes, which can take seconds on large session directories.

### What each search tier actually does (server-side)

Understanding the server behavior is essential. All search goes through `querySessionDirectory` in `server/session-directory/service.ts`:

- **`title` tier:** Metadata-only, no file I/O. The `applySearch` function (service.ts line 65-81) checks `item.title`, `item.summary`, and `item.firstUserMessage` against the query string (case-insensitive substring match). Returns the first matching field as `matchedIn` with a snippet. Fast -- runs against in-memory data.

- **`userMessages` tier:** File-based. For each session, opens the JSONL source file and streams through it line by line. Only matches against `message.user` type events. Returns on first match with the matching text as snippet. Slow -- requires sequential file I/O.

- **`fullText` tier:** File-based, same as userMessages but also includes `message.assistant` events. Slowest tier since it reads both user and assistant messages from every session file.

## Design Overview

Two changes, both on the client:

### Change 1: Remove client-side search bypass (make all search server-side)

Remove the early-return in `Sidebar.tsx` that skips the server request for title-tier search when no `sidebarWindow` exists. Remove the client-side filter fallback (`sidebarWindow ? '' : filter` on line 245). After this change, ALL search queries -- regardless of tier -- go through `fetchSessionWindow` which calls `searchSessions` which hits the `/api/session-directory` endpoint. The client-side `filterSessionItems` function in `sidebarSelectors.ts` is no longer used for search (it remains for non-search scenarios where the selector needs local filtering).

### Change 2: Progressive (two-phase) search for deep tiers

Progressive search works in two phases per keystroke:

1. **Phase 1 (instant):** Always fire a title-tier request first, regardless of the selected tier. Title search is metadata-only (no file I/O), so it returns in milliseconds. Show these results immediately.

2. **Phase 2 (background, only if tier != title):** If the user has selected userMessages or fullText, fire a second request with that tier. While it runs, the user sees the title results from Phase 1. When Phase 2 completes, merge/replace the results: file-search results are authoritative (they found the match in file content), but any title-only matches that weren't superseded should be preserved. A subtle "Scanning files..." indicator shows Phase 2 is in progress.

**Key UX invariants:**
- No flash: title results stay visible during the file scan; they don't disappear and reappear.
- Abort on new query: if the user types a new character or changes tier, both phases of the old query are aborted.
- Abort on clear: clearing the search input cancels all in-flight search requests immediately.
- Tier downgrade: switching from fullText to title cancels any in-flight Phase 2 and shows only the title results.
- Loading indicator: a small inline "Scanning files..." label appears only during Phase 2, not during Phase 1 (Phase 1 is too fast to warrant a spinner).

## Architecture Changes

The change spans three layers: the Sidebar component (`Sidebar.tsx`), the client thunk (`sessionsThunks.ts`), and the Redux slice (`sessionsSlice.ts`). No server changes are needed -- the server already supports tier-specific queries correctly.

### Layer 1: Sidebar.tsx -- Remove client-side search bypass

**Current behavior (broken):** The search effect at line 214-243 has an early-return at line 226-229:
```ts
if (!sidebarWindow && topLevelSessionCount > 0 && searchTier === 'title') {
  return  // <-- BUG: skips server search, falls back to client-side filter
}
```
And line 245 passes the filter to the selector for client-side filtering:
```ts
const localFilteredItems = useAppSelector((state) => selectSortedItems(state, terminals, sidebarWindow ? '' : filter))
```

**New behavior:** Remove the early-return bypass entirely. Always dispatch `fetchSessionWindow` for search queries. Change line 245 to always pass empty string to the selector (server results are authoritative):
```ts
const localFilteredItems = useAppSelector((state) => selectSortedItems(state, terminals, ''))
```

Remove `sidebarWindow` and `topLevelSessionCount` from the search effect's dependency array. The clear-search guard is refactored to use `lastMarkedSearchQueryRef` instead of `sidebarWindow`, which prevents the effect from re-triggering after every search response (see Task 0, step 4 for details).

This means `sidebarSelectors.ts`'s `filterSessionItems` function is no longer invoked for search -- the server handles all filtering. The selector still applies visibility filtering (subagent hiding, empty session hiding, etc.) and sorting, which is correct.

### Layer 2: sessionsThunks.ts -- Two-Phase Fetch

**Current behavior:** `fetchSessionWindow` fires one `searchSessions()` call when a query is present, passing the selected tier. It aborts the previous request for the same surface and dispatches `setSessionWindowData` when done.

**New behavior:** When `trimmedQuery` is non-empty and `searchTier` is NOT `title`:

1. Fire Phase 1: `searchSessions({ query, tier: 'title', signal })` immediately.
2. On Phase 1 resolve: dispatch `setSessionWindowData` with the title results AND a new field `deepSearchPending: true` to indicate Phase 2 is in progress.
3. Fire Phase 2: `searchSessions({ query, tier: searchTier, signal })`.
4. On Phase 2 resolve: merge Phase 2 results with Phase 1 results (deduplicate by sessionKey, Phase 2 wins on conflict because it has the more specific matchedIn), dispatch `setSessionWindowData` with `deepSearchPending: false`.

Both phases share the same `AbortController`. If the user types a new query or changes tier, `abortSurface(surface)` cancels both phases atomically.

**Concretely, the change to `fetchSessionWindow`'s search branch:**

```typescript
// Inside the `if (trimmedQuery)` block:
if (searchTier !== 'title') {
  // Phase 1: title results (instant)
  const titleResponse = await searchSessions({
    query: trimmedQuery,
    tier: 'title',
    signal: controller.signal,
  })
  if (controller.signal.aborted) return

  dispatch(setSessionWindowData({
    surface,
    projects: searchResultsToProjects(titleResponse.results),
    totalSessions: titleResponse.results.length,
    oldestLoadedTimestamp: titleResponse.results.at(-1)?.lastActivityAt ?? 0,
    oldestLoadedSessionId: titleResponse.results.at(-1)
      ? `${titleResponse.results.at(-1)!.provider}:${titleResponse.results.at(-1)!.sessionId}`
      : '',
    hasMore: false,
    query: trimmedQuery,
    searchTier,
    deepSearchPending: true,
  }))

  // Phase 2: file-based search
  try {
    const deepResponse = await searchSessions({
      query: trimmedQuery,
      tier: searchTier,
      signal: controller.signal,
    })
    if (controller.signal.aborted) return

    const merged = mergeSearchResults(titleResponse.results, deepResponse.results)
    dispatch(setSessionWindowData({
      surface,
      projects: searchResultsToProjects(merged),
      totalSessions: merged.length,
      oldestLoadedTimestamp: merged.at(-1)?.lastActivityAt ?? 0,
      oldestLoadedSessionId: merged.at(-1)
        ? `${merged.at(-1)!.provider}:${merged.at(-1)!.sessionId}`
        : '',
      hasMore: false,
      query: trimmedQuery,
      searchTier,
      deepSearchPending: false,
    }))
  } catch (phase2Error) {
    if (controller.signal.aborted) return
    // Phase 2 failed but Phase 1 data is already displayed.
    // Clear the pending indicator and report the error.
    dispatch(setSessionWindowData({
      .../* re-dispatch Phase 1 data with deepSearchPending: false */
      surface,
      projects: searchResultsToProjects(titleResponse.results),
      totalSessions: titleResponse.results.length,
      oldestLoadedTimestamp: titleResponse.results.at(-1)?.lastActivityAt ?? 0,
      oldestLoadedSessionId: titleResponse.results.at(-1)
        ? `${titleResponse.results.at(-1)!.provider}:${titleResponse.results.at(-1)!.sessionId}`
        : '',
      hasMore: false,
      query: trimmedQuery,
      searchTier,
      deepSearchPending: false,
    }))
    dispatch(setSessionWindowError({
      surface,
      error: phase2Error instanceof Error ? phase2Error.message : 'Deep search failed',
    }))
  }
} else {
  // Single-phase title search (existing path, unchanged)
  const response = await searchSessions({
    query: trimmedQuery,
    tier: searchTier,
    signal: controller.signal,
  })
  if (controller.signal.aborted) return

  dispatch(setSessionWindowData({
    surface,
    projects: searchResultsToProjects(response.results),
    totalSessions: response.results.length,
    oldestLoadedTimestamp: response.results.at(-1)?.lastActivityAt ?? 0,
    oldestLoadedSessionId: response.results.at(-1)
      ? `${response.results.at(-1)!.provider}:${response.results.at(-1)!.sessionId}`
      : '',
    hasMore: false,
    query: trimmedQuery,
    searchTier,
    deepSearchPending: false,
  }))
}
```

**`mergeSearchResults` logic:** Build a Map keyed by `provider:sessionId`. Start with title results. For each deep result, overwrite the entry (deep results have better matchedIn + snippet). Return the merged array without re-sorting -- the downstream `searchResultsToProjects` groups by project, and the existing `makeSelectSortedSessionItems` selector in `sidebarSelectors.ts` handles all final ordering (active vs archived, sort mode, etc.).

**Note on match metadata:** `searchResultsToProjects` currently strips `matchedIn` and `snippet` fields when mapping results to `ProjectGroup` sessions. This is acceptable for the initial implementation because the Sidebar renders title/subtitle, not match snippets. If snippet display is added later, `searchResultsToProjects` and the `ProjectGroup` session type should be extended to carry match metadata through.

**`loadingKind` semantics:** Phase 1 sets `loadingKind: 'search'` as today. When Phase 1 resolves and dispatches `setSessionWindowData`, the reducer unconditionally clears `loading` to `false` and `loadingKind` to `undefined` (see `sessionsSlice.ts` lines 224-225). Between Phase 1 resolve and Phase 2 resolve, the window is no longer "loading" in the blocking sense. The `deepSearchPending` flag carries the background-scan state instead.

**Error handling:** If Phase 1 throws (network error, abort, etc.), the existing catch block runs -- it dispatches `setSessionWindowError` and re-throws. Phase 2 never fires. If Phase 2 throws, the inner try/catch handles it: re-dispatches Phase 1 data with `deepSearchPending: false` (clearing the "Scanning files..." indicator) and dispatches `setSessionWindowError`. The Phase 1 results remain visible.

**Background refreshes:** `refreshActiveSessionWindow` and `queueActiveSessionWindowRefresh` call `fetchSessionWindow` with the window's stored `query` and `searchTier`. This means background WS invalidation refreshes will also use two-phase search when the user has a deep tier selected. This is correct behavior -- the user gets instant title results followed by a background file scan on refresh too.

### Layer 3: sessionsSlice.ts -- New `deepSearchPending` Field

Add `deepSearchPending?: boolean` to `SessionWindowState`. This field is set by `setSessionWindowData` and is purely informational for the UI. It defaults to `undefined` (falsy).

```ts
export interface SessionWindowState {
  // ... existing fields ...
  deepSearchPending?: boolean
}
```

**Reducer behavior in `setSessionWindowData`:** Always set `deepSearchPending` from the payload, defaulting to `false` when not provided. This ensures that non-progressive-search dispatches (browse mode, clearing search, pagination) automatically clear any stale `deepSearchPending: true` flag:

```ts
window.deepSearchPending = action.payload.deepSearchPending ?? false
```

This is simpler and safer than conditional `if (action.payload.deepSearchPending !== undefined)` logic because it prevents orphaned `true` values when a new non-search fetch replaces the window data.

**Reducer behavior in `setSessionWindowLoading`:** When `loading` is set to `true`, also clear `deepSearchPending` to `false`. This handles the race condition where a new search starts while a previous Phase 2 is still in progress -- the old `deepSearchPending: true` would otherwise persist until the new Phase 1's `setSessionWindowData` arrives:

```ts
if (action.payload.loading) {
  window.deepSearchPending = false
}
```

**Update `setSessionWindowData` PayloadAction type** to include `deepSearchPending?: boolean` in the payload interface (currently at line 206-215 of `sessionsSlice.ts`).

**`syncTopLevelFromWindow`** does NOT need to sync `deepSearchPending` to top-level state because this flag is only consumed by Sidebar which reads directly from `sidebarWindow?.deepSearchPending`.

### Layer 4: Sidebar.tsx -- UI Indicators

**Current:** `showSearchLoading` is derived from `sidebarWindow?.loading && loadingKind === 'search'`. This drives the inline "Searching..." spinner and the full-list blocking load state.

**New:** Add a derived `showDeepSearchPending` from `sidebarWindow?.deepSearchPending`. This drives a secondary, less prominent indicator:

- When `showSearchLoading` is true AND we have no items yet: show blocking "Searching..." (same as today, for the initial title fetch).
- When items are visible AND `showDeepSearchPending` is true: show a subtle inline "Scanning files..." indicator below the tier dropdown or in the status area. This does NOT block the list -- items from Phase 1 are fully interactive.
- When neither: no indicator.

The existing `showBlockingLoad` logic already handles the "no items + loading" case correctly and will naturally show the spinner during the brief Phase 1 fetch (which resolves in <50ms anyway, so users rarely see it).

**Placement:** The "Scanning files..." indicator should be placed below the search tier dropdown (after the `</select>` wrapper div, inside the `filter.trim()` conditional block). It should use the same subtle styling as the existing search loading indicator -- a small `Loader2` spinner with muted text.

**Accessibility:** The indicator element should have `role="status"` and `aria-live="polite"` so screen readers announce the scanning state without interrupting.

## Result Merging Strategy

When Phase 2 results arrive, the merge follows these rules:

1. **Phase 2 results are primary.** They have the authoritative `matchedIn` and `snippet` from file content.
2. **Phase 1 results that were NOT found by Phase 2 are preserved.** A session might match on title but not contain the query in its file content -- the title match is still useful.
3. **Deduplication by `provider:sessionId`.** If both phases found the same session, Phase 2's version wins (it has the deeper match info).
4. **No re-sorting in the merge function.** The merged array is passed to `searchResultsToProjects` which groups by project, and the existing `makeSelectSortedSessionItems` selector handles final sort order (active/archived partitioning, sort mode preference). Adding a sort in the merge function would be redundant and could conflict with the selector's sort.

## Abort Semantics

- **New query typed:** The 300ms debounce in `Sidebar.tsx` means the effect fires 300ms after the user stops typing. At that point, `fetchSessionWindow` is called, which calls `abortSurface(surface)`, canceling any in-flight Phase 1 or Phase 2 from the previous query. Both use the same AbortController. The effect dependency array is `[dispatch, filter, searchTier]` (after removing `sidebarWindow` and `topLevelSessionCount`), so only user-initiated changes trigger re-runs.
- **Tier changed:** The effect also triggers on `searchTier` change. Same abort path.
- **Search cleared:** When `filter` becomes empty, the effect dispatches a non-search `fetchSessionWindow` which aborts the search surface. The non-search `setSessionWindowData` dispatch will set `deepSearchPending` to `false` (via the default-to-false behavior).
- **No orphaned requests:** Because both phases use the same controller, there's no scenario where Phase 2 outlives an aborted Phase 1.
- **No re-fetch loops:** Since `sidebarWindow` is removed from the dependency array, search responses do not re-trigger the effect. Only user-driven state changes (typing in the filter input, changing the tier dropdown) cause the effect to run.

## Flash Prevention

The key insight: we never clear the displayed results between Phase 1 and Phase 2. The sequence is:

1. User types query -> 300ms debounce -> dispatch `setSessionWindowLoading({ loading: true, loadingKind: 'search' })` -- this also clears `deepSearchPending` to `false` (important when re-searching while a previous Phase 2 was pending)
2. Phase 1 returns -> dispatch `setSessionWindowData({ projects: titleResults, deepSearchPending: true })` -- this SETS data (the list is now populated), clears loading
3. Phase 2 returns -> dispatch `setSessionWindowData({ projects: mergedResults, deepSearchPending: false })` -- updates data in-place

At no point between steps 2 and 3 is the data cleared. The user sees title results appear, then (potentially) sees the list grow with additional file-match-only sessions when Phase 2 resolves. The match metadata (`matchedIn`, `snippet`) is not currently displayed in the Sidebar, so the visual transition between Phase 1 and Phase 2 is simply "more items may appear."

**Re-search while Phase 2 pending:** If the user types a new query while Phase 2 is still running: (a) the abort cancels both phases, (b) `setSessionWindowLoading` fires for the new search, clearing `deepSearchPending` immediately, (c) the "Scanning files..." indicator disappears, (d) the new Phase 1 runs and either shows results or the brief "Searching..." spinner. No flash of the old deep-search indicator during the new search.

## Tasks

### Task 0: Remove client-side search bypass (prerequisite)

**Files:** `src/components/Sidebar.tsx`

This is the root fix for "search is broken." Without this, title-tier searches skip the server entirely.

1. **Remove the early-return bypass** at line 226-229 of `Sidebar.tsx`:
   ```ts
   // DELETE this block:
   if (!sidebarWindow && topLevelSessionCount > 0 && searchTier === 'title') {
     return
   }
   ```
   After removal, all search queries (including title tier) will dispatch `fetchSessionWindow` to hit the server.

2. **Remove client-side filter fallback** at line 245. Change:
   ```ts
   const localFilteredItems = useAppSelector((state) => selectSortedItems(state, terminals, sidebarWindow ? '' : filter))
   ```
   to:
   ```ts
   const localFilteredItems = useAppSelector((state) => selectSortedItems(state, terminals, ''))
   ```
   The selector still applies visibility filtering and sorting; it just no longer does text-based filtering (that is the server's job now).

3. **Remove `topLevelSessionCount` dependency** from the search effect's dependency array (line 243) since the early-return that used it is gone. Also remove the `topLevelSessionCount` selector (line 194) if it is no longer used elsewhere in the component.

4. **Remove `sidebarWindow` from the search effect's dependency array** (line 243) to prevent infinite re-fetch loops. Currently, `sidebarWindow` is in the dependency array because the early-return guard and the clear-search guard reference it. After removing the early-return guard, only the clear-search guard (lines 217-223) still needs it. But `sidebarWindow` changes on every `setSessionWindowData` dispatch (the reducer creates a new object), which would re-trigger the effect after every search response -- causing the debounced dispatch to fire again with the same query/tier, creating an infinite loop.

   **Fix the clear-search guard to not depend on `sidebarWindow`:** Add a new ref `wasSearchingRef = useRef(false)` to track whether a search dispatch has been fired. Set it to `true` inside the debounced dispatch callback (just before dispatching `fetchSessionWindow` with a query). In the clear-search guard, replace `sidebarWindow && lastMarkedSearchQueryRef.current !== null` with `wasSearchingRef.current`, and reset it to `false` after dispatching the browse re-fetch.

   Concretely, change lines 217-223 from:
   ```ts
   if (sidebarWindow && lastMarkedSearchQueryRef.current !== null) {
     lastMarkedSearchQueryRef.current = null
     void dispatch(fetchSessionWindow({
       surface: 'sidebar',
       priority: 'visible',
     }) as any)
   }
   ```
   to:
   ```ts
   if (wasSearchingRef.current) {
     wasSearchingRef.current = false
     lastMarkedSearchQueryRef.current = null
     void dispatch(fetchSessionWindow({
       surface: 'sidebar',
       priority: 'visible',
     }) as any)
   }
   ```

   And inside the debounced dispatch callback (line 231-237), add `wasSearchingRef.current = true` before the dispatch.

   **Why `lastMarkedSearchQueryRef` alone is not sufficient:** The perf-audit effect (line 474-485) only sets `lastMarkedSearchQueryRef` when search results are visible AND `sortedItems.length > 0`. If a search returns zero results, the ref is never set, so clearing the search would not trigger a browse re-fetch -- leaving the sidebar showing "No results" instead of reloading browse data. The dedicated `wasSearchingRef` is set unconditionally whenever a search dispatch occurs.

   **Why the loop didn't occur before:** The removed early-return guard on line 227 prevented the debounced dispatch from firing when `!sidebarWindow` (the common initial state). For the case where `sidebarWindow` exists, the loop existed in theory but was masked because the debounce timeout was cleared by the effect cleanup before it could fire -- except when `sidebarWindow` changed between the debounce starting and the timeout firing (e.g., during a search response). In practice this was a latent bug, now fixed by removing `sidebarWindow` from the dependency array entirely.

### Task 1: Add `deepSearchPending` to SessionWindowState

**Files:** `src/store/sessionsSlice.ts`

1. Add `deepSearchPending?: boolean` to `SessionWindowState` interface
2. Add `deepSearchPending?: boolean` to the `setSessionWindowData` PayloadAction type
3. In the `setSessionWindowData` reducer, set `window.deepSearchPending = action.payload.deepSearchPending ?? false`
4. In the `setSessionWindowLoading` reducer, clear `deepSearchPending` to `false` when `loading` is `true`. This prevents a stale "Scanning files..." indicator from lingering when a new search starts (the old Phase 2 is aborted, but its `deepSearchPending: true` would persist in the window state until the new Phase 1 resolves). Adding `window.deepSearchPending = false` when `action.payload.loading` is `true` clears it immediately at the start of the new search.

### Task 2: Implement `mergeSearchResults` utility

**Files:** `src/store/sessionsThunks.ts`

1. Export `mergeSearchResults(titleResults: SearchResult[], deepResults: SearchResult[]): SearchResult[]`
2. Build a Map keyed by `provider:sessionId` starting with title results
3. Overwrite entries from deep results (they have authoritative match info)
4. Return `Array.from(map.values())` without re-sorting (the selector handles sort)

The existing `sessionKey` helper (line 87-89 of `sessionsThunks.ts`) can be reused for building the dedup key.

### Task 3: Implement two-phase fetch in `fetchSessionWindow`

**Files:** `src/store/sessionsThunks.ts`

1. When `trimmedQuery` is non-empty and `searchTier !== 'title'`:
   - Phase 1: fetch with `tier: 'title'`, dispatch results with `deepSearchPending: true`
   - Phase 2: fetch with `tier: searchTier`, merge with Phase 1, dispatch with `deepSearchPending: false`
   - Phase 2 error: inner try/catch re-dispatches Phase 1 data with `deepSearchPending: false`, dispatches error
2. When `searchTier === 'title'`, use existing single-phase path with `deepSearchPending: false`
3. Both phases share the same AbortController
4. All `setSessionWindowData` calls in the non-search branch (browse/paginate) should omit `deepSearchPending` so the default-to-false behavior clears it

### Task 4: Update Sidebar UI for deep search indicator

**Files:** `src/components/Sidebar.tsx`

1. Derive `showDeepSearchPending` from `sidebarWindow?.deepSearchPending`
2. Below the tier dropdown (inside the `filter.trim()` conditional), render:
   ```tsx
   {showDeepSearchPending && (
     <div role="status" aria-live="polite" className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
       <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
       <span>Scanning files...</span>
     </div>
   )}
   ```
3. Do not block the list -- items remain fully interactive during Phase 2
4. The existing `showSearchLoading` inline indicator in the search input should still show during Phase 1 (brief) but clear when Phase 1 data arrives

### Task 5: Comprehensive test coverage

**Files (additions to existing test files):**

#### `test/unit/client/store/sessionsThunks.test.ts`

New tests to add to the existing `sessionsThunks` describe block:

1. `mergeSearchResults` -- deep results overwrite title results with same key
2. `mergeSearchResults` -- title-only results preserved when not in deep results
3. `mergeSearchResults` -- empty title results with non-empty deep results
4. `mergeSearchResults` -- empty deep results preserves all title results
5. `mergeSearchResults` -- different providers for same sessionId kept separate
6. Two-phase fetch dispatches title results with `deepSearchPending: true` then merged results with `false`
7. Two-phase fetch: Phase 1 abort prevents Phase 2
8. Two-phase fetch: Phase 2 abort after Phase 1 success preserves Phase 1 data
9. Two-phase fetch: title-only tier uses single-phase path with `deepSearchPending: false`
10. Two-phase fetch: Phase 2 error clears `deepSearchPending` while preserving Phase 1 data
11. Two-phase fetch: new query aborts both phases of previous query
12. Two-phase fetch: tier change from fullText to title aborts in-flight Phase 2
13. Background refresh (`queueActiveSessionWindowRefresh`) with deep tier uses two-phase
14. `setSessionWindowData` without explicit `deepSearchPending` defaults to false (slice test, can be in sessionsSlice.test.ts)

#### `test/e2e/sidebar-search-flow.test.tsx` (Sidebar UI tests)

Note: There is no existing `test/unit/client/components/Sidebar.test.tsx` file. Sidebar component tests live in `test/e2e/` using the e2e scaffolding pattern (render with full Redux store + mocked API/WS). The Sidebar UI search tests belong in the new `sidebar-search-flow.test.tsx` file alongside the flow tests, using the same scaffolding as `test/e2e/sidebar-click-opens-pane.test.tsx`.

New tests:

1. Title-tier search always dispatches to server (no client-side bypass)
2. Search with no sidebarWindow dispatches server request (previously was short-circuited)
3. Shows "Scanning files..." when `deepSearchPending` is true and items are visible
4. Does not show "Scanning files..." when `deepSearchPending` is false
5. Does not show "Scanning files..." when no items are visible (even if `deepSearchPending` true)
6. "Scanning files..." indicator has `role="status"` for accessibility
7. Clearing search input removes "Scanning files..." indicator
8. New query typed while deep search pending clears "Scanning files..." indicator immediately (via `setSessionWindowLoading` clearing `deepSearchPending`)
9. Search response does not re-trigger search (no infinite re-fetch loop) -- verify that after a search completes, no additional fetch dispatches occur without user input

#### `test/unit/client/store/sessionsSlice.test.ts`

New tests:

1. `setSessionWindowData` without explicit `deepSearchPending` defaults to false
2. `setSessionWindowLoading` with `loading: true` clears `deepSearchPending`

The `sidebar-search-flow.test.tsx` file is a single new e2e test file that combines both the Sidebar UI tests (items 1-8 above) and the end-to-end flow tests below. It uses the same scaffolding patterns as `test/e2e/sidebar-click-opens-pane.test.tsx` (full Redux store, mocked API/WS).

End-to-end flow scenarios:

1. Title-tier search returns server-side results (verify the bypass is removed)
2. Deep-tier search shows title results first, then merged results after Phase 2 completes
3. Changing query while deep search is pending aborts the old search
4. Clearing search returns to browse mode

## Files to Modify

1. `src/components/Sidebar.tsx` -- remove client-side search bypass, add deep search pending indicator
2. `src/store/sessionsSlice.ts` -- `deepSearchPending` field in interface and payload type, reducer update in both `setSessionWindowData` and `setSessionWindowLoading`
3. `src/store/sessionsThunks.ts` -- two-phase fetch logic, `mergeSearchResults` utility
4. `test/unit/client/store/sessionsThunks.test.ts` -- ~13 new tests (additions to existing file)
5. `test/unit/client/store/sessionsSlice.test.ts` -- 2 new tests (additions to existing file)
6. `test/e2e/sidebar-search-flow.test.tsx` -- new e2e test file (~13 scenarios: 9 Sidebar UI tests + 4 flow tests)

## Files NOT Modified

- Server code (`session-search.ts`, `session-directory/service.ts`, `sessions-router.ts`) -- no changes needed, server search already works correctly for all tiers
- `shared/read-models.ts` -- no schema changes needed (deepSearchPending is client-only state)
- `src/lib/api.ts` -- no changes needed (already supports tier parameter)
- `src/store/selectors/sidebarSelectors.ts` -- no changes needed; `filterSessionItems` remains available but is no longer invoked for search since the selector always receives an empty filter string when the server handles search

## Implementation Notes

### `matchedIn` field mapping

The server-side `SessionDirectoryItem` uses `matchedIn` values: `'title' | 'summary' | 'firstUserMessage' | 'userMessage' | 'assistantMessage'`. The client-side `SearchResult` type maps `'firstUserMessage'` to `'userMessage'` (see `api.ts` line 403). The `mergeSearchResults` function operates on client-side `SearchResult` objects (post-mapping), so it never sees `'firstUserMessage'` -- dedup keys and matchedIn values are already normalized by the time they reach the merge.
