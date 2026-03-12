# Sidebar Refresh Stability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Stop the left sidebar from repeatedly blanking by making `sessions.changed` fire only for real session-directory changes and by keeping already-loaded sidebar content visible during refreshes.

**Architecture:** Treat the session directory as a server-owned read model with one shared projection function. Extract the exact "directory-visible session" projection into `server/session-directory/projection.ts`, make the HTTP read model use it directly, make websocket invalidation diffing compare that same projection, and make the file indexer preserve a file-backed session's `updatedAt` when a rewrite changes nothing in that projection. On the client, keep the last loaded sidebar rows mounted for any later refresh and show refresh status inline; only the very first load is allowed to block the list.

**Tech Stack:** Node.js, TypeScript, React 18, Redux Toolkit, Vitest, Testing Library

---

## Strategy Gate

This fix needs to land both defects together:

1. The server currently treats raw file churn as sidebar churn because file-backed sessions advance `updatedAt` from file `mtime`, and `diffProjects()` compares entire `CodingCliSession` objects.
2. The client currently renders refreshes as an empty panel because `Sidebar.tsx` drops the list whenever `sidebarWindow.loading` is true.

The clean architectural direction is:

- `updatedAt` for file-backed sessions should mean "last directory-visible change", not "last raw file write". That is already the timestamp used for session-directory sort order, pagination cursors, and revisioning, so a second parallel timestamp would fork the read model for little gain.
- The session-directory projection must have exactly one source of truth. Do not keep one field list in `session-directory/service.ts` and a second, similar-but-different field list in `sessions-sync/diff.ts`.
- After first load, sidebar refreshes must be stale-while-refresh. Rendering stale rows during refresh is correct here because the alternative is disruptive blanking and the next server response remains authoritative.

Rejected approaches:

- Client-only stale rendering: hides the symptom but keeps the server spamming invalidations and refetches.
- Server-only invalidation suppression: reduces the loop frequency but still leaves legitimate refreshes visually disruptive.
- Adding a new `directoryUpdatedAt` field: duplicates recency semantics across the codebase and forces extra plumbing through session-directory, search, pagination, and client state.
- Debounce or throttle tuning only: changes cadence, not meaning.

Implementation invariants:

- `sessions.changed` means "the session-directory read model changed in a way the sidebar or session search can observe."
- A rewrite that changes only invisible metadata (`tokenUsage`, `codexTaskEvents`, `sourceFile`, other non-directory fields) must not advance a file-backed session's `updatedAt`.
- A rename, summary change, archive toggle, first-user-message change, session-type change, session creation, session deletion, or any visible ordering change must still invalidate immediately.
- Once `sidebarWindow.lastLoadedAt` exists, the sidebar list must never disappear only because a refresh is in flight.
- `docs/index.html` stays untouched; this is a behavior fix, not a new product surface.

### Task 1: Lock the server read-model contract in failing tests

**Files:**
- Create: `test/unit/server/session-directory/projection.test.ts`
- Modify: `test/unit/server/sessions-sync/diff.test.ts`
- Modify: `test/unit/server/coding-cli/session-indexer.test.ts`

**Step 1: Create the failing projection contract test**

Add `test/unit/server/session-directory/projection.test.ts` for the new shared helper module. The test should define the exact visible projection once:

```ts
expect(toSessionDirectoryProjection({
  provider: 'codex',
  sessionId: 's1',
  projectPath: '/repo',
  updatedAt: 100,
  createdAt: 50,
  title: 'Deploy',
  summary: 'Summary',
  firstUserMessage: 'ship it',
  cwd: '/repo',
  archived: false,
  sessionType: 'codex',
  isSubagent: false,
  isNonInteractive: false,
  tokenUsage: { inputTokens: 1, outputTokens: 2, cachedTokens: 3, totalTokens: 6 },
  codexTaskEvents: { latestTaskStartedAt: 99 },
  sourceFile: '/tmp/session.jsonl',
})).toEqual({
  provider: 'codex',
  sessionId: 's1',
  projectPath: '/repo',
  updatedAt: 100,
  createdAt: 50,
  title: 'Deploy',
  summary: 'Summary',
  firstUserMessage: 'ship it',
  cwd: '/repo',
  archived: false,
  sessionType: 'codex',
  isSubagent: false,
  isNonInteractive: false,
})
```

Add the companion equality test that ignores `updatedAt` only when asked:

```ts
expect(directoryProjectionEqual(a, b, { includeUpdatedAt: false })).toBe(true)
expect(directoryProjectionEqual(a, b, { includeUpdatedAt: true })).toBe(false)
```

**Step 2: Run the new projection test and verify it fails**

Run:

```bash
npx vitest run test/unit/server/session-directory/projection.test.ts
```

Expected: FAIL because `server/session-directory/projection.ts` does not exist yet.

**Step 3: Add the failing diff regression**

Extend `test/unit/server/sessions-sync/diff.test.ts` with two cases:

- changing only invisible fields such as `tokenUsage`, `codexTaskEvents`, or `sourceFile` does not produce an upsert
- changing a directory-visible field such as `title`, `summary`, `archived`, `firstUserMessage`, or `sessionType` still produces an upsert

Use the same session identity in both snapshots so the test isolates field visibility, not insert/remove behavior.

**Step 4: Run the diff test and verify the invisible-field case fails**

Run:

```bash
npx vitest run test/unit/server/sessions-sync/diff.test.ts
```

Expected: FAIL because `diffProjects()` still compares whole session objects.

**Step 5: Add the failing indexer regression**

Extend `test/unit/server/coding-cli/session-indexer.test.ts` with a custom `parseSessionFile` stub that actually returns invisible metadata from the fixture content. Do not rely on the default `makeProvider()` parser here; it currently ignores `tokenUsage` and `codexTaskEvents`, so the regression would be false-positive.

Add two tests:

- rewriting a file with newer `mtime` and different invisible metadata only keeps the prior `updatedAt`
- rewriting the same file with a visible change such as `title` or `summary` advances `updatedAt`

Use `fsp.utimes()` or fake time to make the `mtime` jump obvious.

**Step 6: Run the indexer test and verify the new case fails**

Run:

```bash
npx vitest run test/unit/server/coding-cli/session-indexer.test.ts
```

Expected: FAIL because the indexer still copies raw `mtime` into `updatedAt`.

### Task 2: Extract the session-directory projection as the single source of truth

**Files:**
- Create: `server/session-directory/projection.ts`
- Modify: `server/session-directory/service.ts`
- Test: `test/unit/server/session-directory/projection.test.ts`
- Test: `test/unit/server/session-directory/service.test.ts`

**Step 1: Implement the shared projection helper**

Create `server/session-directory/projection.ts` with an explicit projected type and equality helper:

```ts
import type { CodingCliSession } from '../coding-cli/types.js'
import type { SessionDirectoryItem } from './types.js'

export type SessionDirectoryProjection = Omit<
  SessionDirectoryItem,
  'isRunning' | 'runningTerminalId' | 'snippet' | 'matchedIn'
>

export function toSessionDirectoryProjection(session: CodingCliSession): SessionDirectoryProjection {
  return {
    provider: session.provider,
    sessionId: session.sessionId,
    projectPath: session.projectPath,
    title: session.title,
    summary: session.summary,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    archived: session.archived,
    cwd: session.cwd,
    sessionType: session.sessionType,
    isSubagent: session.isSubagent,
    isNonInteractive: session.isNonInteractive,
    firstUserMessage: session.firstUserMessage,
  }
}
```

The equality helper should compare the projected objects after optionally omitting `updatedAt`; do not compare raw `CodingCliSession` fields directly.

**Step 2: Refactor `session-directory/service.ts` to use the helper**

Replace the hand-built object in `toItems()` with:

```ts
items.push(joinRunningState({
  ...toSessionDirectoryProjection(session),
  isRunning: false,
}, terminalMeta))
```

Keep sorting, search, cursor, and running-state behavior unchanged.

**Step 3: Run the projection and session-directory tests**

Run:

```bash
npx vitest run test/unit/server/session-directory/projection.test.ts test/unit/server/session-directory/service.test.ts
```

Expected: PASS

**Step 4: If `service.test.ts` needs expectation updates, make them now**

Only adjust `test/unit/server/session-directory/service.test.ts` if the refactor changes nothing but import paths or object construction details. Do not widen behavior here; this task is about removing duplicated projection logic, not changing the read-model output.

### Task 3: Use the shared projection for invalidation and semantic timestamps

**Files:**
- Modify: `server/sessions-sync/diff.ts`
- Modify: `server/coding-cli/session-indexer.ts`
- Test: `test/unit/server/sessions-sync/diff.test.ts`
- Test: `test/unit/server/coding-cli/session-indexer.test.ts`
- Test: `test/unit/server/session-directory/projection.test.ts`

**Step 1: Make `diffProjects()` compare projected sessions**

Replace `sessionsEqual()` so it compares:

```ts
directoryProjectionEqual(
  toSessionDirectoryProjection(a),
  toSessionDirectoryProjection(b),
  { includeUpdatedAt: true },
)
```

Preserve the existing project-level checks for project path, color, session count, and session order.

**Step 2: Preserve `updatedAt` across invisible file rewrites**

In `server/coding-cli/session-indexer.ts`, after building the next `baseSession`, compare the previous and next projections with `includeUpdatedAt: false`.

Use this rule:

```ts
const previous = cached?.baseSession
const nextUpdatedAt = stat.mtimeMs || stat.mtime.getTime()
const updatedAt =
  previous &&
  directoryProjectionEqual(
    toSessionDirectoryProjection(previous),
    toSessionDirectoryProjection({ ...baseSession, updatedAt: nextUpdatedAt }),
    { includeUpdatedAt: false },
  )
    ? previous.updatedAt
    : nextUpdatedAt
```

Then store `updatedAt` in `baseSession`.

Do not apply this carry-forward logic to direct providers; only the file-backed cache path needs it.

**Step 3: Run the full targeted server regression set**

Run:

```bash
npx vitest run test/unit/server/session-directory/projection.test.ts test/unit/server/session-directory/service.test.ts test/unit/server/sessions-sync/diff.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/sessions-sync/service.test.ts
```

Expected: PASS

**Step 4: Commit the server-side cut**

Run:

```bash
git add server/session-directory/projection.ts server/session-directory/service.ts server/sessions-sync/diff.ts server/coding-cli/session-indexer.ts test/unit/server/session-directory/projection.test.ts test/unit/server/session-directory/service.test.ts test/unit/server/sessions-sync/diff.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/sessions-sync/service.test.ts
git commit -m "fix(sessions): stabilize sidebar invalidation semantics"
```

Expected: one commit containing the projection extraction, semantic timestamp change, and server regressions.

### Task 4: Lock the client stale-while-refresh behavior in failing tests

**Files:**
- Modify: `test/unit/client/components/Sidebar.test.tsx`
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`

**Step 1: Add the failing sidebar unit regression**

In `Sidebar.test.tsx`, preload `sessions.windows.sidebar` with:

```ts
sidebar: {
  projects: recentProjects,
  lastLoadedAt: 1_700_000_000_000,
  loading: true,
  query: '',
  searchTier: 'title',
}
```

If the existing `createTestStore()` helper cannot express that shape cleanly, extend the helper first instead of inlining ad-hoc preloaded state in multiple tests.

Assert all three conditions at once:

- the old row text is still rendered
- the virtualized list is still present
- an inline loading status is rendered

Add the companion search case with `query: 'deploy'` and `searchTier: 'title'` so a background refresh of an active title search also keeps stale rows mounted.

**Step 2: Run the sidebar unit test and verify it fails**

Run:

```bash
npx vitest run test/unit/client/components/Sidebar.test.tsx
```

Expected: FAIL because `Sidebar.tsx` currently returns `null` for the list while loading.

**Step 3: Add the failing sidebar invalidation e2e regression**

In `test/e2e/open-tab-session-sidebar-visibility.test.tsx`, keep the first sidebar snapshot resolved, then make the invalidation-triggered HTTP refetch hang on a deferred promise:

```ts
const deferred = createDeferred<any>()
fetchSidebarSessionsSnapshot
  .mockResolvedValueOnce(initialResponse)
  .mockReturnValueOnce(deferred.promise)
```

Broadcast `sessions.changed`, assert the existing session row remains visible while the promise is pending, then resolve the promise with the new response and assert the new row replaces the old one.

**Step 4: Run the client regressions and verify the new e2e case fails**

Run:

```bash
npx vitest run test/unit/client/components/Sidebar.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx
```

Expected: FAIL because the sidebar still blanks during refresh.

### Task 5: Implement stale-while-refresh sidebar rendering

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Test: `test/unit/client/components/Sidebar.test.tsx`
- Test: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`

**Step 1: Split first-load blocking from refresh loading**

Introduce explicit render guards:

```tsx
const hasLoadedSidebarWindow = typeof sidebarWindow?.lastLoadedAt === 'number'
const showBlockingLoad = !!sidebarWindow?.loading && !hasLoadedSidebarWindow && sortedItems.length === 0
const showRefreshStatus = !!sidebarWindow?.loading && hasLoadedSidebarWindow
```

**Step 2: Keep the list mounted during refresh**

Render policy:

- `showBlockingLoad`: show the centered blocking spinner
- `showRefreshStatus`: keep rendering the list or empty state and add inline status text
- empty-state copy is allowed only when not in the blocking path

Use clear status copy:

- no query or title query: `Updating sessions...`
- non-title search: `Searching...`

Keep the status element accessible with `role="status"`.

**Step 3: Do not add new Redux state unless a test proves it is necessary**

The current store already exposes everything needed:

- `sidebarWindow.loading`
- `sidebarWindow.lastLoadedAt`
- preserved `projects`
- current `query` and `searchTier`

This fix is a rendering-policy change, not a state-model rewrite.

**Step 4: Run the targeted client tests**

Run:

```bash
npx vitest run test/unit/client/components/Sidebar.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx
```

Expected: PASS

**Step 5: Commit the client-side cut**

Run:

```bash
git add src/components/Sidebar.tsx test/unit/client/components/Sidebar.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx
git commit -m "fix(sidebar): preserve session list during refresh"
```

Expected: one commit containing only the sidebar stale-while-refresh change and its regressions.

### Task 6: Run the combined verification gate

**Files:**
- Modify only files already touched by this plan if follow-up fixes are required

**Step 1: Run the focused regression suite**

Run:

```bash
npx vitest run test/unit/server/session-directory/projection.test.ts test/unit/server/session-directory/service.test.ts test/unit/server/sessions-sync/diff.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/client/components/Sidebar.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx
```

Expected: PASS

**Step 2: Run accessibility lint**

Run:

```bash
npm run lint
```

Expected: PASS

**Step 3: Run the full repository test suite**

Run:

```bash
CI=true npm test
```

Expected: PASS

Per repo policy, if this fails, stop and fix the failure before any merge work even if it looks unrelated.

**Step 4: Commit only if verification required follow-up edits**

Run only if Steps 1-3 changed files:

```bash
git add <follow-up-files>
git commit -m "test: finish sidebar refresh verification"
```

Expected: no extra commit unless verification exposed a real issue.

## Final Verification Checklist

- Raw file rewrites that change only invisible metadata do not emit `sessions.changed`.
- File-backed sessions still move in the directory immediately when a directory-visible field changes.
- `server/session-directory/service.ts`, `server/sessions-sync/diff.ts`, and `server/coding-cli/session-indexer.ts` all derive visibility from the same projection helper.
- A loaded sidebar never goes blank while a refresh is in flight.
- The first load can still show a blocking loading state.
- Title-filtered sidebar refreshes also keep stale rows visible until the new response arrives.
- Focused regressions pass, then `npm run lint`, then `CI=true npm test`.
