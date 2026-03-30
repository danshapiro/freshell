# Fix Sidebar Session Staleness

## Goal

The sidebar session list goes stale and never recovers. Fresh data arrives from the server every few seconds (confirmed: 200 OK, 50 items), gets committed to Redux (`resultVersion` incrementing), but the sidebar renders old data. Fix the root causes so the sidebar always reflects current server state.

## Root Causes (confirmed via live profiling on localhost:3347)

### 1. Window/top-level state divergence (primary cause)

`sidebarSelectors.ts:38` reads `sessions.windows.sidebar.projects`, falling back to `sessions.projects`. WebSocket patches update `sessions.projects` (top-level) and sync only to the **active** surface via `syncActiveWindowFromTopLevel()`. When sidebar isn't active, its window state goes stale — and the selector always picks the stale window data over the fresh top-level data because it exists.

Key locations:
- `src/store/selectors/sidebarSelectors.ts:38` — selector reads stale window state
- `src/store/sessionsSlice.ts:152` — `syncActiveWindowFromTopLevel()` only syncs active surface
- `src/store/sessionsSlice.ts:243-245, 263-265` — commit guards skip sync when not active
- `src/store/sessionsThunks.ts:609-614` — `queueActiveSessionWindowRefresh()` only refreshes active surface

### 2. Silent error swallowing in refresh path

`refreshVisibleSessionWindowSilently()` (sessionsThunks.ts:420-427) catches all errors and just sets `loading: false`. No retry, no error state surfaced, no logging. If a refresh fails, sidebar stays stale forever.

### 3. Zero observability

`sessionsThunks.ts` has zero `console.log`, `console.warn`, or `console.error` calls. The entire refresh coordination system (generation checks, identity matching, commit/discard decisions) is completely silent. Makes debugging impossible.

## Approach

Fix the selector to always use fresh data, add recovery mechanisms for failed refreshes, and add logging so these issues are visible in the future. Verify with a running server using Chrome browser automation.

## Verification Criteria

1. **Sidebar stays fresh**: With a running dev server, create new Claude sessions and verify they appear in the sidebar within seconds — not just in Redux state, but in the rendered DOM.
2. **Surface switching doesn't cause staleness**: Switch between sidebar and history surfaces, verify sidebar data stays current after switching back.
3. **Error recovery**: Simulate a failed fetch (e.g., kill server briefly), verify sidebar recovers on next successful fetch rather than staying stale forever.
4. **Logging exists**: Key decision points in the refresh flow (commit, discard, error, retry) emit debug-level log messages.
5. **All existing tests pass**: `npm run check` green.
6. **No regressions in history view**: History surface still works correctly since it shares the same window system.
