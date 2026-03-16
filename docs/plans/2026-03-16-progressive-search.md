# Progressive Search Implementation Plan

## Problem Statement

When a user selects a deeper search tier (userMessages or fullText), the current system fires a single HTTP request to `/api/session-directory` with the chosen tier. The entire result set is computed server-side (scanning JSONL files sequentially) before any response is sent. During this time, the sidebar shows either a spinner or nothing -- the user sees zero results until the full scan completes, which can take seconds on large session directories.

## Design Overview

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

The change spans three layers: the client thunk (`sessionsThunks.ts`), the Redux slice (`sessionsSlice.ts`), and the Sidebar component (`Sidebar.tsx`). No server changes are needed -- the server already supports tier-specific queries correctly.

### Layer 1: sessionsThunks.ts -- Two-Phase Fetch

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

**Error handling:** If Phase 1 throws (network error, abort, etc.), the existing catch block runs -- it dispatches `setSessionWindowError` and re-throws. Phase 2 never fires. If Phase 2 throws, the catch block also runs, but the Phase 1 data remains visible (it was already dispatched). The catch block should additionally dispatch `setSessionWindowData` with `deepSearchPending: false` to clear the "Scanning files..." indicator on Phase 2 failure, OR handle it by checking whether Phase 1 data was already dispatched. The simplest approach: wrap Phase 2 in its own try/catch inside the main try block.

**Background refreshes:** `refreshActiveSessionWindow` and `queueActiveSessionWindowRefresh` call `fetchSessionWindow` with the window's stored `query` and `searchTier`. This means background WS invalidation refreshes will also use two-phase search when the user has a deep tier selected. This is correct behavior -- the user gets instant title results followed by a background file scan on refresh too.

### Layer 2: sessionsSlice.ts -- New `deepSearchPending` Field

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

**Update `setSessionWindowData` PayloadAction type** to include `deepSearchPending?: boolean` in the payload interface (currently at line 206-215 of `sessionsSlice.ts`).

**`syncTopLevelFromWindow`** does NOT need to sync `deepSearchPending` to top-level state because this flag is only consumed by Sidebar which reads directly from `sidebarWindow?.deepSearchPending`.

### Layer 3: Sidebar.tsx -- UI Indicators

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

- **New query typed:** The 300ms debounce in `Sidebar.tsx` means the effect fires 300ms after the user stops typing. At that point, `fetchSessionWindow` is called, which calls `abortSurface(surface)`, canceling any in-flight Phase 1 or Phase 2 from the previous query. Both use the same AbortController.
- **Tier changed:** The effect also triggers on `searchTier` change. Same abort path.
- **Search cleared:** When `filter` becomes empty, the effect dispatches a non-search `fetchSessionWindow` which aborts the search surface. The non-search `setSessionWindowData` dispatch will set `deepSearchPending` to `false` (via the default-to-false behavior).
- **No orphaned requests:** Because both phases use the same controller, there's no scenario where Phase 2 outlives an aborted Phase 1.

## Flash Prevention

The key insight: we never clear the displayed results between Phase 1 and Phase 2. The sequence is:

1. User types query -> 300ms debounce -> dispatch `setSessionWindowLoading({ loading: true, loadingKind: 'search' })`
2. Phase 1 returns -> dispatch `setSessionWindowData({ projects: titleResults, deepSearchPending: true })` -- this SETS data (the list is now populated), clears loading
3. Phase 2 returns -> dispatch `setSessionWindowData({ projects: mergedResults, deepSearchPending: false })` -- updates data in-place

At no point between steps 2 and 3 is the data cleared. The user sees title results appear, then (potentially) sees the list grow with additional file-match-only sessions when Phase 2 resolves. The match metadata (`matchedIn`, `snippet`) is not currently displayed in the Sidebar, so the visual transition between Phase 1 and Phase 2 is simply "more items may appear."

## Tasks

### Task 1: Add `deepSearchPending` to SessionWindowState

**Files:** `src/store/sessionsSlice.ts`

1. Add `deepSearchPending?: boolean` to `SessionWindowState` interface
2. Add `deepSearchPending?: boolean` to the `setSessionWindowData` PayloadAction type
3. In the `setSessionWindowData` reducer, set `window.deepSearchPending = action.payload.deepSearchPending ?? false`

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
2. When `searchTier === 'title'`, use existing single-phase path with `deepSearchPending: false`
3. Both phases share the same AbortController
4. Error handling:
   - Phase 1 error: existing catch block runs, Phase 2 never fires
   - Phase 2 error: wrap in inner try/catch; on failure, dispatch `setSessionWindowData` with `deepSearchPending: false` (preserving Phase 1 data), then dispatch `setSessionWindowError`
5. All `setSessionWindowData` calls in the non-search branch (browse/paginate) should omit `deepSearchPending` so the default-to-false behavior clears it

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

#### `test/unit/client/components/Sidebar.test.tsx`

New tests to add to the existing Sidebar test suite:

1. Shows "Scanning files..." when `deepSearchPending` is true and items are visible
2. Does not show "Scanning files..." when `deepSearchPending` is false
3. Does not show "Scanning files..." when no items are visible (even if `deepSearchPending` true)
4. "Scanning files..." indicator has `role="status"` for accessibility
5. Clearing search input removes "Scanning files..." indicator

## Files to Modify

1. `src/store/sessionsSlice.ts` -- `deepSearchPending` field in interface and payload type, reducer update
2. `src/store/sessionsThunks.ts` -- two-phase fetch logic, `mergeSearchResults` utility
3. `src/components/Sidebar.tsx` -- deep search pending indicator
4. `test/unit/client/store/sessionsThunks.test.ts` -- ~13 new tests (additions to existing file)
5. `test/unit/client/components/Sidebar.test.tsx` -- ~5 new tests (additions to existing file)
6. `test/unit/client/store/sessionsSlice.test.ts` -- 1 new test for deepSearchPending default (addition to existing file)

## Files NOT Modified

- Server code (`session-search.ts`, `session-directory/service.ts`, `sessions-router.ts`) -- no changes needed
- `shared/read-models.ts` -- no schema changes needed (deepSearchPending is client-only state)
- `src/lib/api.ts` -- no changes needed (already supports tier parameter)
- `src/store/selectors/sidebarSelectors.ts` -- no changes needed (sort/filter logic already correct for merged results)
