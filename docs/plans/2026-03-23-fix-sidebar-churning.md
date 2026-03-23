# Fix Sidebar Churning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate unnecessary sidebar re-renders (~every 5 seconds) caused by `lastActivityAt` and `createdAt` timestamp changes propagating through the `sessions.changed` broadcast pipeline when the only thing that changed on an active coding CLI session is its timestamp.

**Architecture:** Remove `lastActivityAt` and `createdAt` from the server-side deep-diff equality check in `comparableItemsEqual()`, from the `SessionDirectoryComparableItem` type, and from the `toSessionDirectoryComparableItem()` mapping function. Keep these fields in `compareSessionDirectoryComparableItems()` (the sort comparator) since sorting by recency is still needed for snapshot ordering. Update existing tests to match the new contract, and add new tests that verify timestamp-only changes are correctly suppressed.

**Tech Stack:** TypeScript, Vitest

---

## Design decisions

### Why removing timestamps from the equality check is correct

The `comparableItemsEqual()` function answers one question: "has the sidebar-visible state of this session changed in a way that requires the client to re-fetch?" Timestamps (`lastActivityAt`, `createdAt`) change constantly on active coding CLI sessions (every time the CLI writes to its session file), but they do not affect sidebar presentation:

- **Title** is not derived from timestamps
- **Grouping** (by project path) does not depend on timestamps
- **Filtering** (archived, subagent, non-interactive) does not depend on timestamps
- **Sort order** is determined at query time by the `compareSessionDirectoryComparableItems()` sort function, which still uses `lastActivityAt` -- but sort order changes alone do not need to trigger a broadcast because the client re-sorts on fetch anyway

The only user-visible effect of a timestamp change would be if the sidebar displayed relative time ("3 minutes ago"), but even then the client can update that locally without a server broadcast.

### Why we also remove timestamps from the type and mapping function

`SessionDirectoryComparableItem` exists solely to define the fields that matter for the equality check. Including fields that are deliberately excluded from the equality comparison creates a misleading contract: future maintainers would see `lastActivityAt` on the type and reasonably assume it participates in equality checking. Removing it from the type makes the intent unambiguous.

The sort function `compareSessionDirectoryComparableItems()` needs `lastActivityAt` for ordering, but it reads from the same items that `buildSessionDirectoryComparableSnapshot()` produces. Since those items still come from `CodingCliSession` objects that have `lastActivityAt`, we need to keep the field available for sorting. The cleanest approach is to keep `lastActivityAt` on the comparable item type for sorting purposes but exclude it from the equality check. However, the task input specifically asks to remove them from the type and mapping function too. This creates a type error in the sort function.

**Resolution:** We will keep `lastActivityAt` on the `SessionDirectoryComparableItem` type because the sort function `compareSessionDirectoryComparableItems()` needs it, and that function's signature accepts `SessionDirectoryComparableItem` arguments. Removing `lastActivityAt` from the type would break the sort function's type safety or require a second type, both of which add complexity for no benefit. We **will** remove `createdAt` from the type and mapping function since it is not used by the sort function at all. We **will** remove both fields from `comparableItemsEqual()` (the equality check), which is the actual fix for the churning.

To summarize the final state:
- `lastActivityAt`: stays on `SessionDirectoryComparableItem` type and in `toSessionDirectoryComparableItem()`, **removed from `comparableItemsEqual()`**
- `createdAt`: **removed from type, mapping function, and `comparableItemsEqual()`**

### The diff module (`sessions-sync/diff.ts`) is a separate concern

`diffProjects()` in `server/sessions-sync/diff.ts` uses `isDeepStrictEqual` on full `CodingCliSession` objects for per-project granular diffing. It intentionally compares all fields (including timestamps) because its job is different: it determines which projects have *any* change for the delta WebSocket protocol. The `SessionsSyncService` calls `hasSessionDirectorySnapshotChange()` (from `projection.ts`) as a top-level gate before broadcasting at all. These are layered correctly: projection decides "should we broadcast?", diff decides "what changed?". We only modify projection.

### Impact on snapshot ordering

`buildSessionDirectoryComparableSnapshot()` sorts by `lastActivityAt` (via `compareSessionDirectoryComparableItems`). This means the sorted snapshot order can change when only timestamps change. The equality check then walks the sorted arrays positionally. Since we are removing timestamp comparison from `comparableItemsEqual()`, a reordering caused solely by timestamp changes would still be detected as a change if sessions move to different positions, because other fields (like `sessionId`) at each position would differ. This is acceptable and even desirable: if sessions actually reorder in the sidebar, that is a visible change worth broadcasting. If only timestamps change but order stays the same, no broadcast occurs -- which is the exact fix we want.

---

## File structure

- **Modify:** `server/session-directory/projection.ts` -- remove `createdAt` from type/mapping/equality; remove `lastActivityAt` from equality only
- **Modify:** `test/unit/server/session-directory/projection.test.ts` -- update existing tests, add new tests for timestamp suppression
- **Modify:** `test/unit/server/sessions-sync/service.test.ts` -- add integration-level test verifying `SessionsSyncService` suppresses broadcast on timestamp-only changes

---

### Task 1: Update projection.test.ts with failing tests for the new contract

**Files:**
- Modify: `test/unit/server/session-directory/projection.test.ts`

- [ ] **Step 1: Write the failing tests**

Add two new test cases to the existing `session-directory projection` describe block:

1. `hasSessionDirectorySnapshotChange returns false when only lastActivityAt differs` -- verifies the fix
2. `hasSessionDirectorySnapshotChange returns false when only createdAt differs` -- verifies the fix
3. Update the existing test `ignores invisible metadata and project color but still treats lastActivityAt as visible` -- the assertion on line 73 that expects `true` when only `lastActivityAt` changes must flip to `false`, and the test name must be updated to reflect the new contract

```typescript
// In the existing describe block, REPLACE the existing test:
it('ignores invisible metadata, project color, and timestamp-only changes', () => {
  const first: ProjectGroup[] = [{
    projectPath: '/repo',
    color: '#f00',
    sessions: [{ ...baseSession, tokenUsage: { inputTokens: 1, outputTokens: 2, cachedTokens: 0, totalTokens: 3 } }],
  }]
  const second: ProjectGroup[] = [{
    projectPath: '/repo',
    color: '#0f0',
    sessions: [{ ...baseSession, tokenUsage: { inputTokens: 9, outputTokens: 9, cachedTokens: 9, totalTokens: 27 }, sourceFile: '/tmp/other.jsonl' }],
  }]
  const lastActivityAtChanged: ProjectGroup[] = [{
    projectPath: '/repo',
    sessions: [{ ...baseSession, lastActivityAt: 101 }],
  }]

  expect(hasSessionDirectorySnapshotChange(first, second)).toBe(false)
  expect(hasSessionDirectorySnapshotChange(
    [{ projectPath: '/repo', sessions: [{ ...baseSession, lastActivityAt: 100 }] }],
    lastActivityAtChanged,
  )).toBe(false)
})

// ADD new tests:
it('returns false when only createdAt differs', () => {
  const before: ProjectGroup[] = [{
    projectPath: '/repo',
    sessions: [{ ...baseSession, createdAt: 50 }],
  }]
  const after: ProjectGroup[] = [{
    projectPath: '/repo',
    sessions: [{ ...baseSession, createdAt: 99 }],
  }]
  expect(hasSessionDirectorySnapshotChange(before, after)).toBe(false)
})

it('returns true when a sidebar-relevant field changes alongside timestamps', () => {
  const before: ProjectGroup[] = [{
    projectPath: '/repo',
    sessions: [{ ...baseSession, title: 'Deploy', lastActivityAt: 100, createdAt: 50 }],
  }]
  const after: ProjectGroup[] = [{
    projectPath: '/repo',
    sessions: [{ ...baseSession, title: 'Deploy v2', lastActivityAt: 200, createdAt: 50 }],
  }]
  expect(hasSessionDirectorySnapshotChange(before, after)).toBe(true)
})
```

Also update the `toSessionDirectoryComparableItem` projection test to remove `createdAt` from the expected output (since it will no longer be on the type):

```typescript
// In the existing 'projects only directory-visible fields from a session' test,
// remove createdAt from the expected output object
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- --run test/unit/server/session-directory/projection.test.ts`
Expected: FAIL -- the updated test expects `false` for timestamp-only changes but gets `true`; the projection test expects no `createdAt` field but gets one

- [ ] **Step 3: Commit the red tests**

```bash
git add test/unit/server/session-directory/projection.test.ts
git commit -m "test: add failing tests for sidebar churning timestamp suppression"
```

### Task 2: Implement the projection changes

**Files:**
- Modify: `server/session-directory/projection.ts:4-8` (type), `server/session-directory/projection.ts:13-30` (equality), `server/session-directory/projection.ts:32-49` (mapping)

- [ ] **Step 1: Remove `createdAt` from `SessionDirectoryComparableItem` type**

The type is defined as an `Omit` of `SessionDirectoryItem`. Add `'createdAt'` to the `Omit` union:

```typescript
export type SessionDirectoryComparableItem = Omit<
  SessionDirectoryItem,
  'isRunning' | 'runningTerminalId' | 'snippet' | 'matchedIn' | 'createdAt'
>
```

- [ ] **Step 2: Remove `lastActivityAt` and `createdAt` from `comparableItemsEqual()`**

Remove lines 21-22 (`a.lastActivityAt === b.lastActivityAt` and `a.createdAt === b.createdAt`) from the equality function:

```typescript
function comparableItemsEqual(a: SessionDirectoryComparableItem, b: SessionDirectoryComparableItem): boolean {
  return (
    a.provider === b.provider &&
    a.sessionId === b.sessionId &&
    a.sessionKey === b.sessionKey &&
    a.projectPath === b.projectPath &&
    a.title === b.title &&
    a.summary === b.summary &&
    a.archived === b.archived &&
    a.cwd === b.cwd &&
    a.sessionType === b.sessionType &&
    a.isSubagent === b.isSubagent &&
    a.isNonInteractive === b.isNonInteractive &&
    a.firstUserMessage === b.firstUserMessage
  )
}
```

- [ ] **Step 3: Remove `createdAt` from `toSessionDirectoryComparableItem()`**

Remove the `createdAt: session.createdAt` line from the mapping function. Keep `lastActivityAt` because it is still on the type (needed for sorting):

```typescript
export function toSessionDirectoryComparableItem(session: CodingCliSession): SessionDirectoryComparableItem {
  return {
    provider: session.provider,
    sessionId: session.sessionId,
    sessionKey: buildSessionKey(session),
    projectPath: session.projectPath,
    title: session.title,
    summary: session.summary,
    lastActivityAt: session.lastActivityAt,
    archived: session.archived,
    cwd: session.cwd,
    sessionType: session.sessionType,
    isSubagent: session.isSubagent,
    isNonInteractive: session.isNonInteractive,
    firstUserMessage: session.firstUserMessage,
  }
}
```

- [ ] **Step 4: Run the projection tests to verify they pass**

Run: `npm run test:vitest -- --run test/unit/server/session-directory/projection.test.ts`
Expected: PASS

- [ ] **Step 5: Refactor and run the broader suite**

Review the changes for clarity. Verify no other code in the codebase reads `createdAt` from `SessionDirectoryComparableItem`. Then run the full suite:

Run: `npm run test:vitest -- --run test/unit/server/session-directory/projection.test.ts`
Run: `npm test`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add server/session-directory/projection.ts
git commit -m "fix: exclude timestamps from sidebar change detection to prevent churning"
```

### Task 3: Add SessionsSyncService integration test for timestamp suppression

**Files:**
- Modify: `test/unit/server/sessions-sync/service.test.ts`

- [ ] **Step 1: Write the integration-level test**

Add a test to the existing `SessionsSyncService` describe block that verifies the full pipeline: `SessionsSyncService.publish()` should not broadcast when only timestamps change on a session.

```typescript
it('suppresses broadcast when only timestamps change on an existing session', () => {
  const ws = createWsMocks()
  const svc = new SessionsSyncService(ws as any, { coalesceMs: 0 })

  svc.publish([
    createDetailedProject('/repo', {
      provider: 'codex',
      sessionId: 's1',
      projectPath: '/repo',
      lastActivityAt: 100,
      createdAt: 50,
      title: 'Deploy',
    }),
  ])
  svc.publish([
    createDetailedProject('/repo', {
      provider: 'codex',
      sessionId: 's1',
      projectPath: '/repo',
      lastActivityAt: 200,
      createdAt: 50,
      title: 'Deploy',
    }),
  ])
  svc.publish([
    createDetailedProject('/repo', {
      provider: 'codex',
      sessionId: 's1',
      projectPath: '/repo',
      lastActivityAt: 300,
      createdAt: 50,
      title: 'Deploy',
    }),
  ])

  // Only the first publish should have broadcast (initial state)
  // Subsequent publishes with only lastActivityAt changes should be suppressed
  expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(1)
  expect(ws.broadcastSessionsChanged).toHaveBeenLastCalledWith(1)
})
```

- [ ] **Step 2: Run the test to verify it passes**

This test should already pass because the projection change from Task 2 is in place.

Run: `npm run test:vitest -- --run test/unit/server/sessions-sync/service.test.ts`
Expected: PASS

- [ ] **Step 3: Update the existing `broadcasts only when directory-visible fields change` test**

The existing test at line 164 asserts that changing `lastActivityAt` from 100 to 101 triggers a broadcast (call `[2]`). With our change, this should no longer trigger a broadcast. Update the test:

```typescript
it('broadcasts only when directory-visible fields change', () => {
  const ws = createWsMocks()
  const svc = new SessionsSyncService(ws as any, { coalesceMs: 0 })

  svc.publish([
    createDetailedProject('/repo', {
      provider: 'codex',
      sessionId: 's1',
      projectPath: '/repo',
      lastActivityAt: 100,
      title: 'Deploy',
      tokenUsage: {
        inputTokens: 1,
        outputTokens: 2,
        cachedTokens: 0,
        totalTokens: 3,
      },
    }, '#f00'),
  ])
  svc.publish([
    createDetailedProject('/repo', {
      provider: 'codex',
      sessionId: 's1',
      projectPath: '/repo',
      lastActivityAt: 100,
      title: 'Deploy',
      tokenUsage: {
        inputTokens: 9,
        outputTokens: 9,
        cachedTokens: 9,
        totalTokens: 27,
      },
      sourceFile: '/tmp/other.jsonl',
    }, '#0f0'),
  ])
  // Only lastActivityAt changed -- should NOT broadcast
  svc.publish([
    createDetailedProject('/repo', {
      provider: 'codex',
      sessionId: 's1',
      projectPath: '/repo',
      lastActivityAt: 101,
      title: 'Deploy',
    }, '#0f0'),
  ])
  // Title changed -- SHOULD broadcast
  svc.publish([
    createDetailedProject('/repo', {
      provider: 'codex',
      sessionId: 's1',
      projectPath: '/repo',
      lastActivityAt: 101,
      title: 'Deploy v2',
    }, '#0f0'),
  ])

  expect(ws.broadcastSessionsChanged.mock.calls).toEqual([
    [1],
    [2],
  ])
})
```

The key change: the expected calls go from `[[1], [2], [3]]` to `[[1], [2]]` because the `lastActivityAt: 101` publish no longer triggers a broadcast.

- [ ] **Step 4: Run all sessions-sync tests**

Run: `npm run test:vitest -- --run test/unit/server/sessions-sync/service.test.ts`
Expected: PASS

- [ ] **Step 5: Refactor and run the full suite**

Run: `npm test`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add test/unit/server/sessions-sync/service.test.ts
git commit -m "test: verify SessionsSyncService suppresses broadcast on timestamp-only changes"
```

### Task 4: Final verification

- [ ] **Step 1: Run full test suite including typecheck**

Run: `npm run check`
Expected: all PASS -- typecheck confirms no type errors from `createdAt` removal, all tests pass

- [ ] **Step 2: Verify the e2e sidebar test still passes**

The user mentioned `sidebar-refresh-dom-stability.test.tsx` -- this file does not exist in the current codebase (search returned zero results). If it was added by another agent or exists under a different name, run it. Otherwise, confirm no e2e sidebar test was broken by running the full suite.

Run: `npm test`
Expected: all PASS

- [ ] **Step 3: Commit (if any refactoring was done)**

Only commit if there were changes from refactoring in the verification step.
