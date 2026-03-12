# Sidebar Refresh Stability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Eliminate the left-panel blanking loop by suppressing session-directory invalidations that come from invisible session-file churn and by keeping the sidebar list visible during refreshes.

**Architecture:** Treat the session sidebar as a read model with an explicit visibility contract. On the server, only directory-visible session fields are allowed to advance a file-backed session's directory timestamp or trigger `sessions.changed`; raw file `mtime`, token counters, codex task-event noise, and other non-directory metadata stay available for other surfaces but must not invalidate the sidebar. On the client, switch the sidebar to stale-while-refresh after first load so invalidations and title-search refreshes keep the last loaded list rendered while showing a non-destructive loading indicator.

**Tech Stack:** Node.js, TypeScript, React 18, Redux Toolkit, Vitest, Testing Library

---

## Strategy Gate

This bug is two coupled defects and should be fixed as one cut:

1. The server currently treats file churn as sidebar churn because `CodingCliSession.updatedAt` is sourced from file `mtime` and the diff logic compares entire session objects.
2. The client currently treats any in-flight sidebar refresh as a blank-state render.

The direct end state is:

- `sessions.changed` means "the session-directory/sidebar read model changed in a way the sidebar can observe."
- Once the sidebar has loaded at least once, refreshes are stale-while-refresh, not blank-while-refresh.

Rejected approaches:

- Client-only stale rendering: hides the symptom but keeps the server emitting needless invalidations and the client aborting/refetching on each one.
- Server-only invalidation suppression: reduces the loop frequency but still leaves legitimate refreshes visually disruptive.
- Timer tuning only: changes cadence, not semantics.

Implementation invariants:

- After the first successful sidebar load, `sessions.changed` must never cause the list to disappear.
- File-backed sessions must not advance the sidebar sort timestamp purely because the underlying file was rewritten without changing directory-visible data.
- Directory-visible edits still invalidate immediately: rename, archive, delete, first-user-message changes, summary/title changes, session-type metadata changes, and session appearance/disappearance.
- `docs/index.html` stays untouched; this is a behavioral stability fix, not a new feature surface.

### Task 1: Capture the server-side churn regressions first

**Files:**
- Modify: `test/unit/server/sessions-sync/diff.test.ts`
- Modify: `test/unit/server/sessions-sync/service.test.ts`
- Modify: `test/unit/server/coding-cli/session-indexer.test.ts`

**Step 1: Write the failing tests**

Add server regressions that define the read-model contract explicitly:

- `diff.test.ts`: prove `diffProjects()` ignores session fields that never affect the directory/sidebar surface (`tokenUsage`, `codexTaskEvents`, `sourceFile`) while still reacting to directory-visible fields (`title`, `summary`, `firstUserMessage`, `archived`, `sessionType`, `updatedAt` once it is semantic).
- `service.test.ts`: prove `SessionsSyncService.publish()` does not broadcast when the only snapshot delta is invisible sidebar metadata, but still broadcasts when a directory-visible field changes.
- `session-indexer.test.ts`: create one file-backed session, refresh once, then rewrite the file with a newer `mtime` but identical directory-visible parsed metadata and assert the indexed session keeps its prior `updatedAt`. Add the companion regression where a directory-visible parsed field changes and `updatedAt` advances.

For the indexer test, use `fsp.utimes()` or a second write separated by fake time so the failure is unambiguous.

**Step 2: Run the targeted tests to verify they fail**

Run:

```bash
npx vitest run test/unit/server/sessions-sync/diff.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/coding-cli/session-indexer.test.ts
```

Expected: FAIL because the current diff path still treats invisible fields as meaningful and the indexer still bumps `updatedAt` from raw file `mtime`.

### Task 2: Implement directory-visible comparison and semantic timestamp carry-forward

**Files:**
- Create: `server/session-directory/comparison.ts`
- Modify: `server/coding-cli/session-indexer.ts`
- Modify: `server/sessions-sync/diff.ts`
- Modify only the Task 1 test files as needed

**Step 1: Add the shared directory-comparison helper**

Create a small helper that defines the authoritative "directory-visible session shape" shared by the indexer and sync diff. Keep it intentionally narrow:

```ts
export type DirectoryComparableSession = Pick<
  CodingCliSession,
  'provider' | 'sessionId' | 'projectPath' | 'updatedAt' | 'createdAt' |
  'archived' | 'title' | 'summary' | 'firstUserMessage' | 'cwd' |
  'sessionType' | 'isSubagent' | 'isNonInteractive'
>

export function toDirectoryComparableSession(
  session: CodingCliSession,
  options?: { includeUpdatedAt?: boolean },
): DirectoryComparableSession | Omit<DirectoryComparableSession, 'updatedAt'> { ... }
```

The key rule is that this helper must exclude fields that are real for other surfaces but invisible to the sidebar read model.

**Step 2: Preserve `updatedAt` when a file rewrite changes nothing visible**

In `server/coding-cli/session-indexer.ts`, after building the next file-backed `baseSession`, compare it to the cached prior `baseSession` using the shared helper with `includeUpdatedAt: false`.

If the directory-visible projection is unchanged, carry forward the previous `updatedAt` instead of replacing it with the new file `mtime`.

If the directory-visible projection changed, keep the new timestamp candidate from the file stat.

Do not apply this rewrite heuristic to direct providers that already own their own `updatedAt`.

**Step 3: Make `diffProjects()` use the same directory-visible projection**

Replace the current "compare every own enumerable field" behavior with comparison through the shared directory projection. The diff still needs to respect:

- project path
- project color
- session ordering
- every directory-visible field listed above

It must stop reacting to fields that never reach the sidebar/session-directory payload.

**Step 4: Run the targeted server tests**

Run:

```bash
npx vitest run test/unit/server/sessions-sync/diff.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/coding-cli/session-indexer.test.ts
```

Expected: PASS

**Step 5: Commit the server-side cut**

Run:

```bash
git add server/session-directory/comparison.ts server/coding-cli/session-indexer.ts server/sessions-sync/diff.ts test/unit/server/sessions-sync/diff.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/coding-cli/session-indexer.test.ts
git commit -m "fix(sessions): suppress invisible sidebar invalidations"
```

Expected: one commit containing only the server-side invalidation work and its tests.

### Task 3: Capture the client-side blanking regression with unit and e2e coverage

**Files:**
- Modify: `test/unit/client/components/Sidebar.test.tsx`
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`

**Step 1: Write the failing client tests**

Add two focused regressions:

- `Sidebar.test.tsx`: preload a sidebar window with one or more sessions plus `lastLoadedAt`, then set `loading: true` and assert the existing session rows still render while a refresh status is visible. Add the title-search variant: when a store-owned title search is in flight after the sidebar has already loaded, the previous list stays mounted and the component does not fall through to the empty-state branch.
- `open-tab-session-sidebar-visibility.test.tsx`: make the `sessions.changed` HTTP refetch stay pending, broadcast `sessions.changed`, and assert the previously rendered sidebar row remains in the DOM until the promise resolves. After resolution, assert the new data replaces it.

Keep the assertions DOM-facing. Do not test internal booleans.

**Step 2: Run the targeted client tests to verify they fail**

Run:

```bash
npx vitest run test/unit/client/components/Sidebar.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx
```

Expected: FAIL because the current sidebar render path drops the list whenever `sidebarWindow.loading` is true and the search-loading branch is limited to non-title searches.

### Task 4: Switch the sidebar to stale-while-refresh rendering

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Modify only the Task 3 test files as needed

**Step 1: Implement non-destructive refresh rendering**

Update the session-list render logic so it distinguishes initial load from refresh:

```tsx
const hasLoadedSidebarWindow = typeof sidebarWindow?.lastLoadedAt === 'number'
const showBlockingLoad = sidebarWindow?.loading && !hasLoadedSidebarWindow && sortedItems.length === 0
const showRefreshStatus = sidebarWindow?.loading && hasLoadedSidebarWindow
```

Render rules:

- `showBlockingLoad`: show the centered blocking loading UI.
- `showRefreshStatus`: keep the existing list or empty state rendered and add an inline `role="status"` indicator.
- Empty-state messages only render when not in the blocking-load path.

For copy:

- Non-search refresh or title-search refresh: `Updating sessions...`
- Non-title search refresh: `Searching...`

Preserve the existing `search-loading` test surface for the non-title search case if practical, but make it an overlay/status, not a mutually exclusive branch that removes the list.

**Step 2: Keep the render path simple**

Do not widen Redux state unless the component genuinely needs it. The current store already gives enough signal through `sidebarWindow.loading`, `sidebarWindow.lastLoadedAt`, and the preserved session window contents. The goal is to change rendering policy, not add a second fetch state machine.

**Step 3: Run the targeted client tests**

Run:

```bash
npx vitest run test/unit/client/components/Sidebar.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx
```

Expected: PASS

**Step 4: Commit the client-side cut**

Run:

```bash
git add src/components/Sidebar.tsx test/unit/client/components/Sidebar.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx
git commit -m "fix(sidebar): keep sessions visible during refresh"
```

Expected: one commit containing only the stale-while-refresh client work and its tests.

### Task 5: Run the combined verification gate

**Files:**
- Modify only files already touched by this plan if follow-up fixes are required

**Step 1: Run focused verification for the full bug surface**

Run:

```bash
npx vitest run test/unit/server/sessions-sync/diff.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/client/components/Sidebar.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx
```

Expected: PASS

**Step 2: Run accessibility and full-suite verification**

Run:

```bash
npm run lint
CI=true npm test
```

Expected: PASS

Per repo policy, if `npm test` fails, stop and fix the failure before any merge work, even if it looks unrelated.

**Step 3: Commit only if verification required follow-up edits**

Run only if Step 2 changed files:

```bash
git add <follow-up-files>
git commit -m "test: finish sidebar refresh stability verification"
```

Expected: no extra commit unless verification exposed a real issue.

## Final Verification Checklist

- `sessions.changed` is no longer emitted for raw file rewrites that do not change directory-visible session data.
- A loaded sidebar never goes blank while refresh is in flight.
- Title-search refreshes also preserve the previous list until the new results arrive.
- Session rename/archive/delete flows still refresh correctly because those fields remain directory-visible.
- Server and client targeted regressions pass, then `npm run lint`, then `CI=true npm test`.
