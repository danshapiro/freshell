# Progressive Search Implementation Plan

## Problem Statement

When a user selects a deeper search tier (userMessages or fullText), the current system fires a single HTTP request to `/api/session-directory` with the chosen tier. The entire result set is computed server-side (scanning JSONL files sequentially) before any response is sent. During this time, the sidebar shows either a spinner or nothing -- the user sees zero results until the full scan completes, which can take seconds on large session directories.

## Design Overview

Progressive search works in two phases per keystroke:

1. **Phase 1 (instant):** Always fire a title-tier request first, regardless of the selected tier. Title search is metadata-only (no file I/O), so it returns in milliseconds. Show these results immediately.

2. **Phase 2 (background, only if tier != title):** If the user has selected userMessages or fullText, fire a second request with that tier. While it runs, the user sees the title results from Phase 1. When Phase 2 completes, merge/replace the results: file-search results are authoritative (they found the match in file content), but any title-only matches that weren't superseded should be preserved. A subtle "Searching files..." indicator shows Phase 2 is in progress.

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
    ...paginationFields(titleResponse),
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
    ...paginationFields(deepResponse),
    query: trimmedQuery,
    searchTier,
    deepSearchPending: false,
  }))
} else {
  // Single-phase title search (existing path)
  const response = await searchSessions({ ... })
  dispatch(setSessionWindowData({ ..., deepSearchPending: false }))
}
```

**`mergeSearchResults` logic:** Build a Map keyed by `provider:sessionId`. Start with title results. For each deep result, overwrite the entry (deep results have better matchedIn + snippet). Return values sorted by the standard sort order (non-archived first, then by lastActivityAt descending).

**`loadingKind` semantics:** Phase 1 sets `loadingKind: 'search'` as today. Between Phase 1 resolve and Phase 2 resolve, `loadingKind` is cleared (the window is no longer "loading" in the blocking sense). The `deepSearchPending` flag carries the background-scan state instead.

### Layer 2: sessionsSlice.ts -- New `deepSearchPending` Field

Add `deepSearchPending?: boolean` to `SessionWindowState`. This field is set by `setSessionWindowData` and is purely informational for the UI. It defaults to `undefined` (falsy). The `setSessionWindowData` reducer accepts the new field:

```ts
export interface SessionWindowState {
  // ... existing fields ...
  deepSearchPending?: boolean
}
```

In the `setSessionWindowData` reducer:
```ts
if (action.payload.deepSearchPending !== undefined) {
  window.deepSearchPending = action.payload.deepSearchPending
}
```

And clear it whenever loading is false and no explicit value is provided (reset on non-search fetches).

### Layer 3: Sidebar.tsx -- UI Indicators

**Current:** `showSearchLoading` is derived from `sidebarWindow?.loading && loadingKind === 'search'`. This drives the inline "Searching..." spinner and the full-list blocking load state.

**New:** Add a derived `showDeepSearchPending` from `sidebarWindow?.deepSearchPending`. This drives a secondary, less prominent indicator:

- When `showSearchLoading` is true AND we have no items yet: show blocking "Searching..." (same as today, for the initial title fetch).
- When items are visible AND `showDeepSearchPending` is true: show a subtle inline "Scanning files..." indicator below the tier dropdown or in the status area. This does NOT block the list -- items from Phase 1 are fully interactive.
- When neither: no indicator.

The existing `showBlockingLoad` logic already handles the "no items + loading" case correctly and will naturally show the spinner during the brief Phase 1 fetch (which resolves in <50ms anyway, so users rarely see it).

## Result Merging Strategy

When Phase 2 results arrive, the merge follows these rules:

1. **Phase 2 results are primary.** They have the authoritative `matchedIn` and `snippet` from file content.
2. **Phase 1 results that were NOT found by Phase 2 are preserved.** A session might match on title but not contain the query in its file content -- the title match is still useful.
3. **Deduplication by `provider:sessionId`.** If both phases found the same session, Phase 2's version wins (it has the deeper match info).
4. **Sort order preserved.** After merge, re-sort by the standard comparator (non-archived first, then lastActivityAt descending).

## Abort Semantics

- **New query typed:** The 300ms debounce in `Sidebar.tsx` means the effect fires 300ms after the user stops typing. At that point, `fetchSessionWindow` is called, which calls `abortSurface(surface)`, canceling any in-flight Phase 1 or Phase 2 from the previous query. Both use the same AbortController.
- **Tier changed:** The effect also triggers on `searchTier` change. Same abort path.
- **Search cleared:** When `filter` becomes empty, the effect dispatches a non-search `fetchSessionWindow` which aborts the search surface.
- **No orphaned requests:** Because both phases use the same controller, there's no scenario where Phase 2 outlives an aborted Phase 1.

## Flash Prevention

The key insight: we never clear the displayed results between Phase 1 and Phase 2. The sequence is:

1. User types query -> 300ms debounce -> dispatch `setSessionWindowLoading({ loading: true, loadingKind: 'search' })`
2. Phase 1 returns -> dispatch `setSessionWindowData({ projects: titleResults, deepSearchPending: true })` -- this SETS data (the list is now populated), clears loading
3. Phase 2 returns -> dispatch `setSessionWindowData({ projects: mergedResults, deepSearchPending: false })` -- updates data in-place

At no point between steps 2 and 3 is the data cleared. The user sees title results appear, then (potentially) sees them get enriched with file-match snippets when Phase 2 resolves.

## Tasks

### Task 1: Add `deepSearchPending` to SessionWindowState

**Files:** `src/store/sessionsSlice.ts`

1. Add `deepSearchPending?: boolean` to `SessionWindowState` interface
2. Update `setSessionWindowData` reducer to accept and store `deepSearchPending`
3. Clear `deepSearchPending` on non-search fetches (when query is empty)

### Task 2: Implement `mergeSearchResults` utility

**Files:** `src/store/sessionsThunks.ts`

1. Export `mergeSearchResults(titleResults: SearchResult[], deepResults: SearchResult[]): SearchResult[]`
2. Deduplicate by `provider:sessionId`, deep results win on conflict
3. Preserve title-only results not found in deep results
4. Sort by standard comparator (non-archived first, lastActivityAt desc)

### Task 3: Implement two-phase fetch in `fetchSessionWindow`

**Files:** `src/store/sessionsThunks.ts`

1. When `trimmedQuery` is non-empty and `searchTier !== 'title'`:
   - Phase 1: fetch with `tier: 'title'`, dispatch results with `deepSearchPending: true`
   - Phase 2: fetch with `tier: searchTier`, merge with Phase 1, dispatch with `deepSearchPending: false`
2. When `searchTier === 'title'`, use existing single-phase path with `deepSearchPending: false`
3. Both phases share the same AbortController
4. Handle errors: Phase 1 error prevents Phase 2; Phase 2 error clears deepSearchPending

### Task 4: Update Sidebar UI for deep search indicator

**Files:** `src/components/Sidebar.tsx`

1. Derive `showDeepSearchPending` from `sidebarWindow?.deepSearchPending`
2. Show "Scanning files..." indicator when `showDeepSearchPending` is true and items are visible
3. Do not block the list -- items remain fully interactive during Phase 2

### Task 5: Comprehensive test coverage

**Files:**
- `test/unit/client/store/sessionsThunks.test.ts` -- 14 new tests for two-phase fetch and merge
- `test/unit/client/components/Sidebar.test.tsx` -- 5 new tests for deep search indicator
- New or extended slice tests as needed

## Files to Modify

1. `src/store/sessionsSlice.ts` -- `deepSearchPending` field, reducer update
2. `src/store/sessionsThunks.ts` -- two-phase fetch, `mergeSearchResults`
3. `src/components/Sidebar.tsx` -- deep search indicator
4. `test/unit/client/store/sessionsThunks.test.ts` -- 14 new tests
5. `test/unit/client/components/Sidebar.test.tsx` -- 5 new tests

## Files NOT Modified

- Server code (`session-search.ts`, `session-directory/service.ts`, `sessions-router.ts`) -- no changes needed
- `shared/read-models.ts` -- no schema changes needed (deepSearchPending is client-only state)
- `src/lib/api.ts` -- no changes needed (already supports tier parameter)
