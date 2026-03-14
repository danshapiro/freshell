# Semantic Session Recency Contract Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Stop idle sidebar flashes by replacing coding-session filesystem-observation recency with semantic `lastActivityAt`, so touch-only session-file writes no longer invalidate, reorder, or visibly refresh the left panel.

**Architecture:** Provider parsers own the semantic clock. File-backed providers derive `createdAt` and `lastActivityAt` from transcript events; the session indexer keeps file `mtimeMs` only as an internal cache invalidation key and carries forward prior semantic times when a reparse yields none. The server and client switch to `lastActivityAt` in one cut, with the shared session-directory page schema defined once in `shared/read-models.ts` so the HTTP contract cannot drift.

**Tech Stack:** Node.js, TypeScript, Express, React 18, Redux Toolkit, Zod, Vitest, Testing Library

---

## Strategy Gate

This is the right problem to solve. The sidebar flash is not primarily a rendering bug; it is a bad data-contract bug. Session file `mtime` currently leaks into coding-session `updatedAt`, the directory projection treats that as user-visible state, and the client sorts on it by default. A renderer-only patch would leave websocket invalidation, search ordering, pagination, CLI output, and other session consumers semantically wrong.

Direct decisions:

- Rename coding-session recency from `updatedAt` to `lastActivityAt` everywhere a coding session or session-directory/search payload is represented.
- Keep unrelated `updatedAt` fields alone: terminal metadata, codex activity rows, tab registry rows, device metadata, and other non-session timestamps are out of scope.
- Land the direct end state in one cut. No compatibility alias and no staged `updatedAt`/`lastActivityAt` dual-field period.
- Keep filesystem `mtimeMs` internal to the session indexer cache only. It may decide whether to reparse a file, but it must never surface on a session object, drive ordering, or trigger `sessions.changed`.
- If a file reparse yields no semantic timestamps, carry forward cached `createdAt`/`lastActivityAt`; never fall back to `mtime`.
- Direct-list providers may map their upstream semantic timestamp straight into `lastActivityAt`.
- Keep generic container names like `oldestLoadedTimestamp`, `oldestIncludedTimestamp`, and `before` unless the field itself is a session contract surface. Those containers may continue to carry semantic session time.
- `docs/index.html` stays untouched. This is a correctness fix, not a user-facing feature addition.

Semantic-clock policy:

- Claude semantic records: session init/start, user messages, assistant messages, tool use/results, reasoning/thinking, and completion/error-style records that represent visible session progress.
- Claude non-semantic records: `file-history-snapshot`, usage-only assistant payloads, debug sidecars, and other housekeeping-only records.
- Codex semantic records: `session_meta`, `response_item` message/function call/function_call_output, and `event_msg` values `agent_reasoning`, `task_started`, `task_complete`, `turn_aborted`.
- Codex non-semantic records: `token_count`, `turn_context`, and metadata-only snapshots that do not represent visible session progress.

Rejected approaches:

- Client-only sidebar suppression while keeping `mtime`-driven recency.
- Silently redefining session `updatedAt` to mean semantic activity.
- A temporary compatibility period where some code uses `updatedAt` and other code uses `lastActivityAt`.
- Falling back to filesystem `mtime` when semantic timestamps are missing.

### Task 1: Red-test provider semantic clocks

**Files:**
- Modify: `test/unit/server/coding-cli/claude-provider.test.ts`
- Modify: `test/unit/server/coding-cli/codex-provider.test.ts`

**Step 1: Add Claude red tests**

Add two tests to `test/unit/server/coding-cli/claude-provider.test.ts`:

```ts
it('derives Claude createdAt and lastActivityAt from semantic transcript records', () => {
  const meta = parseSessionContent([
    JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION_A, cwd: '/repo', timestamp: '2026-03-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Ship it' }, timestamp: '2026-03-01T00:00:03.000Z' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'On it' }] }, timestamp: '2026-03-01T00:00:05.000Z' }),
  ].join('\n'))

  expect(meta.createdAt).toBe(Date.parse('2026-03-01T00:00:00.000Z'))
  expect(meta.lastActivityAt).toBe(Date.parse('2026-03-01T00:00:05.000Z'))
})

it('ignores file-history-snapshot and usage-only assistant payloads for Claude lastActivityAt', () => {
  const meta = parseSessionContent([
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Keep this timestamp' }, timestamp: '2026-03-01T00:00:04.000Z' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 1, output_tokens: 2 } }, timestamp: '2026-03-01T00:00:20.000Z' }),
    JSON.stringify({ type: 'file-history-snapshot', snapshot: { timestamp: '2026-03-01T00:00:21.000Z' } }),
  ].join('\n'))

  expect(meta.lastActivityAt).toBe(Date.parse('2026-03-01T00:00:04.000Z'))
})
```

Use the real housekeeping shapes already present in this test file. Do not invent a second fake bookkeeping format.

**Step 2: Add Codex red tests**

Add two tests to `test/unit/server/coding-cli/codex-provider.test.ts`:

```ts
it('derives Codex createdAt and lastActivityAt from semantic events', async () => {
  const content = await fsp.readFile(codexTaskEventsFixturePath, 'utf8')
  const meta = parseCodexSessionContent(content)

  expect(meta.createdAt).toBe(Date.parse('2026-03-01T00:00:00.000Z'))
  expect(meta.lastActivityAt).toBe(Date.parse('2026-03-01T00:00:06.000Z'))
})

it('ignores token_count and turn_context when deriving Codex lastActivityAt', () => {
  const meta = parseCodexSessionContent([
    JSON.stringify({ timestamp: '2026-03-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'session-1', cwd: '/repo' } }),
    JSON.stringify({ timestamp: '2026-03-01T00:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Visible reply' }] } }),
    JSON.stringify({ timestamp: '2026-03-01T00:00:20.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_usage_tokens: 999 } } }),
    JSON.stringify({ timestamp: '2026-03-01T00:00:21.000Z', type: 'turn_context', payload: { cwd: '/repo' } }),
  ].join('\n'))

  expect(meta.lastActivityAt).toBe(Date.parse('2026-03-01T00:00:04.000Z'))
})
```

**Step 3: Run the focused provider red pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/coding-cli/claude-provider.test.ts test/unit/server/coding-cli/codex-provider.test.ts
```

Expected: FAIL because provider parsers do not yet expose semantic `createdAt` and `lastActivityAt`.

**Step 4: Commit the red tests**

Run:

```bash
git add test/unit/server/coding-cli/claude-provider.test.ts test/unit/server/coding-cli/codex-provider.test.ts
git commit -m "test: lock provider semantic session clocks"
```

### Task 2: Implement provider semantic clocks

**Files:**
- Modify: `server/coding-cli/types.ts`
- Modify: `server/coding-cli/providers/claude.ts`
- Modify: `server/coding-cli/providers/codex.ts`
- Modify: `test/unit/server/coding-cli/claude-provider.test.ts`
- Modify: `test/unit/server/coding-cli/codex-provider.test.ts`

**Step 1: Extend parsed-session metadata**

In `server/coding-cli/types.ts`, add semantic clock fields to `ParsedSessionMeta`:

```ts
export interface ParsedSessionMeta {
  sessionId?: string
  cwd?: string
  createdAt?: number
  lastActivityAt?: number
  // existing fields stay intact
}
```

Do not rename `CodingCliSession.updatedAt` in this task. Keep the wide contract cut for the next server task.

**Step 2: Implement the Claude semantic clock**

In `server/coding-cli/providers/claude.ts`:

- make the local parser return type include `createdAt` and `lastActivityAt`
- add a timestamp parser and a helper that tracks earliest/latest semantic timestamps
- add an explicit `isClaudeSemanticRecord(obj: any): boolean`
- update `parseSessionContent()` so only semantic records can move `createdAt`/`lastActivityAt`

Representative target:

```ts
function recordSemanticTimestamp(
  clock: { createdAt?: number; lastActivityAt?: number },
  value: unknown,
): void {
  const at = parseTimestampMs(value)
  if (at === undefined) return
  clock.createdAt = clock.createdAt === undefined ? at : Math.min(clock.createdAt, at)
  clock.lastActivityAt = clock.lastActivityAt === undefined ? at : Math.max(clock.lastActivityAt, at)
}
```

The Claude semantic filter must explicitly ignore `file-history-snapshot` and usage-only assistant payloads.

**Step 3: Implement the Codex semantic clock**

In `server/coding-cli/providers/codex.ts`:

- reuse the timestamp helper pattern
- add `isSemanticCodexEvent(obj: any): boolean`
- derive `createdAt` and `lastActivityAt` during the existing JSONL scan

Use explicit allow-lists, not broad `event_msg` catch-alls.

**Step 4: Run the focused provider pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/coding-cli/claude-provider.test.ts test/unit/server/coding-cli/codex-provider.test.ts
```

Expected: PASS

**Step 5: Commit the provider implementation**

Run:

```bash
git add server/coding-cli/types.ts server/coding-cli/providers/claude.ts server/coding-cli/providers/codex.ts test/unit/server/coding-cli/claude-provider.test.ts test/unit/server/coding-cli/codex-provider.test.ts
git commit -m "refactor: derive semantic provider session clocks"
```

### Task 3: Red-test the no-flash server invalidation boundary

**Files:**
- Modify: `test/unit/server/coding-cli/session-indexer.test.ts`
- Modify: `test/unit/server/session-directory/projection.test.ts`
- Modify: `test/unit/server/session-directory/service.test.ts`
- Modify: `test/unit/server/session-pagination.test.ts`
- Modify: `test/unit/server/session-search.test.ts`
- Modify: `test/unit/server/sessions-sync/diff.test.ts`
- Modify: `test/unit/server/sessions-sync/service.test.ts`
- Modify: `test/integration/server/session-directory-router.test.ts`
- Modify: `test/server/ws-sidebar-snapshot-refresh.test.ts`
- Modify: `test/unit/cli/commands.test.ts`

**Step 1: Add the indexer red test for touch-only churn**

Extend `test/unit/server/coding-cli/session-indexer.test.ts` with a file-backed refresh test that proves the root cause is gone:

```ts
it('does not emit a second update when only file observation time changes', async () => {
  const file = path.join(tempDir, 'session-a.jsonl')
  await fsp.writeFile(file, JSON.stringify({ cwd: '/repo', title: 'Deploy' }) + '\n')

  const parseSessionFile = vi.fn()
    .mockResolvedValueOnce({ cwd: '/repo', sessionId: 'session-a', title: 'Deploy', createdAt: 100, lastActivityAt: 200 })
    .mockResolvedValueOnce({ cwd: '/repo', sessionId: 'session-a', title: 'Deploy' })

  const provider = makeProvider([file], { parseSessionFile })
  const indexer = new CodingCliSessionIndexer([provider])
  const seen: number[] = []
  indexer.onUpdate((projects) => {
    seen.push(projects[0]?.sessions[0]?.lastActivityAt ?? -1)
  })

  await indexer.refresh()
  await fsp.utimes(file, new Date(10_000), new Date(10_000))
  await indexer.refresh()

  expect(indexer.getProjects()[0]?.sessions[0]?.lastActivityAt).toBe(200)
  expect(seen).toEqual([200])
})
```

This test must exercise the carry-forward path: the second parse omits semantic timestamps entirely.

**Step 2: Convert the server contract tests to `lastActivityAt`**

Update these tests so their fixtures, cursors, and assertions use `lastActivityAt` instead of session `updatedAt`:

- `test/unit/server/session-directory/projection.test.ts`
- `test/unit/server/session-directory/service.test.ts`
- `test/unit/server/session-pagination.test.ts`
- `test/unit/server/session-search.test.ts`
- `test/unit/server/sessions-sync/diff.test.ts`
- `test/unit/server/sessions-sync/service.test.ts`
- `test/integration/server/session-directory-router.test.ts`
- `test/server/ws-sidebar-snapshot-refresh.test.ts`
- `test/unit/cli/commands.test.ts`

Specific assertions to add:

- touch-only metadata churn does not change the directory snapshot
- session-directory revision uses `max(lastActivityAt, terminalMeta.updatedAt)`
- session-directory cursors serialize semantic session time
- search results sort by `lastActivityAt`
- CLI output exposes `lastActivityAt`

**Step 3: Run the focused server red pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/session-directory/projection.test.ts test/unit/server/session-directory/service.test.ts test/unit/server/session-pagination.test.ts test/unit/server/session-search.test.ts test/unit/server/sessions-sync/diff.test.ts test/unit/server/sessions-sync/service.test.ts test/integration/server/session-directory-router.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts
npm run test:vitest -- test/unit/cli/commands.test.ts
```

Expected: FAIL because the server contract still exposes `updatedAt` and the indexer still leaks `mtime`.

**Step 4: Commit the red tests**

Run:

```bash
git add test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/session-directory/projection.test.ts test/unit/server/session-directory/service.test.ts test/unit/server/session-pagination.test.ts test/unit/server/session-search.test.ts test/unit/server/sessions-sync/diff.test.ts test/unit/server/sessions-sync/service.test.ts test/integration/server/session-directory-router.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts test/unit/cli/commands.test.ts
git commit -m "test: lock semantic session invalidation boundary"
```

### Task 4: Implement the server/domain contract cutover

**Files:**
- Modify: `server/coding-cli/types.ts`
- Modify: `server/coding-cli/providers/opencode.ts`
- Modify: `server/coding-cli/session-indexer.ts`
- Modify: `server/coding-cli/codex-activity-tracker.ts`
- Modify: `server/session-association-coordinator.ts`
- Modify: `server/index.ts`
- Modify: `shared/read-models.ts`
- Modify: `server/session-directory/types.ts`
- Modify: `server/session-directory/projection.ts`
- Modify: `server/session-directory/service.ts`
- Modify: `server/session-pagination.ts`
- Modify: `server/session-search.ts`
- Modify: `server/sessions-sync/diff.ts`
- Modify: `server/sessions-sync/service.ts`
- Modify: `server/sessions-router.ts`
- Modify: `server/cli/index.ts`
- Modify: `test/unit/server/coding-cli/opencode-provider.test.ts`
- Modify: `test/unit/server/coding-cli/session-indexer.test.ts`
- Modify: `test/unit/server/coding-cli/codex-activity-tracker.test.ts`
- Modify: `test/unit/server/session-association-coordinator.test.ts`
- Modify: `test/server/session-association.test.ts`
- Modify: `test/integration/server/codex-session-rebind-regression.test.ts`
- Modify: `test/unit/server/session-directory/projection.test.ts`
- Modify: `test/unit/server/session-directory/service.test.ts`
- Modify: `test/unit/server/session-pagination.test.ts`
- Modify: `test/unit/server/session-search.test.ts`
- Modify: `test/unit/server/sessions-sync/diff.test.ts`
- Modify: `test/unit/server/sessions-sync/service.test.ts`
- Modify: `test/integration/server/session-directory-router.test.ts`
- Modify: `test/server/ws-sidebar-snapshot-refresh.test.ts`
- Modify: `test/unit/cli/commands.test.ts`

**Step 1: Rename the core session contract**

In `server/coding-cli/types.ts`, rename `CodingCliSession.updatedAt` to `CodingCliSession.lastActivityAt`:

```ts
export interface CodingCliSession {
  provider: CodingCliProviderName
  sessionId: string
  projectPath: string
  lastActivityAt: number
  createdAt?: number
  // other fields unchanged
}
```

Also extend `shared/read-models.ts` with shared session-directory schemas:

```ts
export const SessionDirectoryItemSchema = z.object({
  sessionId: z.string().min(1),
  provider: z.string().min(1),
  projectPath: z.string().min(1),
  title: z.string().optional(),
  summary: z.string().optional(),
  snippet: z.string().optional(),
  matchedIn: z.enum(['title', 'summary', 'firstUserMessage']).optional(),
  lastActivityAt: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative().optional(),
  archived: z.boolean().optional(),
  cwd: z.string().optional(),
  sessionType: z.string().optional(),
  firstUserMessage: z.string().optional(),
  isSubagent: z.boolean().optional(),
  isNonInteractive: z.boolean().optional(),
  isRunning: z.boolean(),
  runningTerminalId: z.string().optional(),
})

export const SessionDirectoryPageSchema = z.object({
  items: z.array(SessionDirectoryItemSchema),
  nextCursor: z.string().nullable(),
  revision: z.number().int().nonnegative(),
})
```

Then update `server/session-directory/types.ts` to alias the shared types instead of keeping a second local shape.

**Step 2: Cut the indexer over to semantic recency**

In `server/coding-cli/providers/opencode.ts` and `server/coding-cli/session-indexer.ts`:

- keep the SQL column name `updatedAt` in the query, but map the returned direct-list session object into `lastActivityAt`
- keep `mtimeMs` and `size` only in `CachedSessionEntry`
- build `baseSession.lastActivityAt` from parser output, never from file stat
- carry forward cached `createdAt`/`lastActivityAt` when a reparse omits them
- sort sessions, projects, and new-session callbacks by `lastActivityAt`

Use the fallback chain below:

```ts
const previous = cached?.baseSession
const createdAt = meta.createdAt ?? previous?.createdAt
const lastActivityAt =
  meta.lastActivityAt ??
  previous?.lastActivityAt ??
  createdAt ??
  0
```

`mtimeMs` must not be copied back onto `baseSession`.

**Step 3: Cut downstream server consumers over to `lastActivityAt`**

Update these files so they all speak the same contract:

- `server/session-directory/projection.ts`
- `server/session-directory/service.ts`
- `server/session-pagination.ts`
- `server/session-search.ts`
- `server/sessions-sync/diff.ts`
- `server/sessions-sync/service.ts`
- `server/sessions-router.ts`
- `server/cli/index.ts`
- `server/session-association-coordinator.ts`
- `server/coding-cli/codex-activity-tracker.ts`
- `server/index.ts`

Important details:

- projection comparators use `lastActivityAt`
- directory cursors encode `{ lastActivityAt, key }`
- directory `revision` stays `max(session.lastActivityAt, terminalMeta.updatedAt)`
- search results expose and sort on `lastActivityAt`
- CLI output exposes `lastActivityAt`
- association logic compares terminal creation time to `session.lastActivityAt`
- codex-activity tracker renames session-domain fields like `lastSeenSessionUpdatedAt` to `lastSeenSessionActivityAt`

Leave terminal-meta `updatedAt` fields unchanged.

**Step 4: Run the focused server/domain pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/coding-cli/opencode-provider.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts test/unit/server/session-association-coordinator.test.ts test/unit/server/session-directory/projection.test.ts test/unit/server/session-directory/service.test.ts test/unit/server/session-pagination.test.ts test/unit/server/session-search.test.ts test/unit/server/sessions-sync/diff.test.ts test/unit/server/sessions-sync/service.test.ts test/integration/server/session-directory-router.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts test/server/session-association.test.ts test/integration/server/codex-session-rebind-regression.test.ts
npm run test:vitest -- test/unit/cli/commands.test.ts
```

Expected: PASS

**Step 5: Commit the server/domain cutover**

Run:

```bash
git add server/coding-cli/types.ts server/coding-cli/providers/opencode.ts server/coding-cli/session-indexer.ts server/coding-cli/codex-activity-tracker.ts server/session-association-coordinator.ts server/index.ts shared/read-models.ts server/session-directory/types.ts server/session-directory/projection.ts server/session-directory/service.ts server/session-pagination.ts server/session-search.ts server/sessions-sync/diff.ts server/sessions-sync/service.ts server/sessions-router.ts server/cli/index.ts test/unit/server/coding-cli/opencode-provider.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts test/unit/server/session-association-coordinator.test.ts test/server/session-association.test.ts test/integration/server/codex-session-rebind-regression.test.ts test/unit/server/session-directory/projection.test.ts test/unit/server/session-directory/service.test.ts test/unit/server/session-pagination.test.ts test/unit/server/session-search.test.ts test/unit/server/sessions-sync/diff.test.ts test/unit/server/sessions-sync/service.test.ts test/integration/server/session-directory-router.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts test/unit/cli/commands.test.ts
git commit -m "refactor: cut server sessions to lastActivityAt"
```

### Task 5: Red-test the client/session contract cutover

**Files:**
- Modify: `test/unit/client/lib/api.test.ts`
- Modify: `test/unit/client/store/sessionsSlice.test.ts`
- Modify: `test/unit/client/store/sessionsThunks.test.ts`
- Modify: `test/unit/client/sessionsSlice.pagination.test.ts`
- Modify: `test/unit/client/store/selectors/sidebarSelectors.test.ts`
- Modify: `test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts`
- Modify: `test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts`
- Modify: `test/unit/client/components/App.test.tsx`
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx`
- Modify: `test/unit/client/components/Sidebar.test.tsx`
- Modify: `test/unit/client/components/ContextMenuProvider.test.tsx`
- Modify: `test/unit/client/components/HistoryView.mobile.test.tsx`
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`
- Modify: `test/e2e/sidebar-click-opens-pane.test.tsx`

**Step 1: Convert API/store red tests to `lastActivityAt`**

Update these tests so fixtures and assertions expect the renamed session field and cursor payload:

- `test/unit/client/lib/api.test.ts`
- `test/unit/client/store/sessionsSlice.test.ts`
- `test/unit/client/store/sessionsThunks.test.ts`
- `test/unit/client/sessionsSlice.pagination.test.ts`

Specific expectations:

- session-directory payloads parse `lastActivityAt`
- the session cursor serializes semantic session time
- project/session merge order uses `lastActivityAt`
- search results regroup using `lastActivityAt`

**Step 2: Convert selector/UI red tests to `lastActivityAt`**

Update these tests so sidebar/history/context-menu fixtures all use the new field:

- `test/unit/client/store/selectors/sidebarSelectors.test.ts`
- `test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts`
- `test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts`
- `test/unit/client/components/App.test.tsx`
- `test/unit/client/components/App.ws-bootstrap.test.tsx`
- `test/unit/client/components/Sidebar.test.tsx`
- `test/unit/client/components/ContextMenuProvider.test.tsx`
- `test/unit/client/components/HistoryView.mobile.test.tsx`
- `test/e2e/open-tab-session-sidebar-visibility.test.tsx`
- `test/e2e/sidebar-click-opens-pane.test.tsx`

Do not add a synthetic "flash detector" test. The root cause is already pinned at the provider/indexer/invalidation boundary.

**Step 3: Run the focused client red pack**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/api.test.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/sessionsSlice.pagination.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: FAIL because the client still expects `updatedAt`.

**Step 4: Commit the red tests**

Run:

```bash
git add test/unit/client/lib/api.test.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/sessionsSlice.pagination.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
git commit -m "test: lock client session recency contract"
```

### Task 6: Implement the client/session contract cutover

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/store/sessionsSlice.ts`
- Modify: `src/store/sessionsThunks.ts`
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/HistoryView.tsx`
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `test/unit/client/lib/api.test.ts`
- Modify: `test/unit/client/store/sessionsSlice.test.ts`
- Modify: `test/unit/client/store/sessionsThunks.test.ts`
- Modify: `test/unit/client/sessionsSlice.pagination.test.ts`
- Modify: `test/unit/client/store/selectors/sidebarSelectors.test.ts`
- Modify: `test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts`
- Modify: `test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts`
- Modify: `test/unit/client/components/App.test.tsx`
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx`
- Modify: `test/unit/client/components/Sidebar.test.tsx`
- Modify: `test/unit/client/components/ContextMenuProvider.test.tsx`
- Modify: `test/unit/client/components/HistoryView.mobile.test.tsx`
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`
- Modify: `test/e2e/sidebar-click-opens-pane.test.tsx`

**Step 1: Rename the client session-domain types and parsing**

In `src/store/types.ts` and `src/lib/api.ts`:

- rename coding-session `updatedAt` to `lastActivityAt`
- rename client `SearchResult.updatedAt` to `lastActivityAt`
- import `SessionDirectoryPageSchema` from `@shared/read-models`
- remove local duplicate `SessionDirectoryItemResponse` and `SessionDirectoryPageResponse` types
- parse the session-directory HTTP response with the shared schema before regrouping it

Representative target:

```ts
export interface CodingCliSession {
  provider: CodingCliProviderName
  sessionId: string
  projectPath: string
  createdAt?: number
  lastActivityAt: number
  // existing fields unchanged
}
```

Update the cursor encoder in `src/lib/api.ts` so it serializes `lastActivityAt` rather than `updatedAt`.

**Step 2: Switch store math and UI consumers**

Update:

- `src/store/sessionsSlice.ts`
- `src/store/sessionsThunks.ts`
- `src/store/selectors/sidebarSelectors.ts`
- `src/components/Sidebar.tsx`
- `src/components/HistoryView.tsx`
- `src/components/context-menu/ContextMenuProvider.tsx`

Rules:

- session sorting, merging, pagination, and regrouping use `lastActivityAt`
- sidebar item timestamps/order use `lastActivityAt`
- history "last used" display uses `lastActivityAt`
- context-menu copied session metadata and display timestamps use `lastActivityAt`

Leave non-session timestamps like tab `lastInputAt` untouched.

**Step 3: Run the focused client pack**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/api.test.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/sessionsSlice.pagination.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: PASS

**Step 4: Commit the client cutover**

Run:

```bash
git add src/store/types.ts src/lib/api.ts src/store/sessionsSlice.ts src/store/sessionsThunks.ts src/store/selectors/sidebarSelectors.ts src/components/Sidebar.tsx src/components/HistoryView.tsx src/components/context-menu/ContextMenuProvider.tsx test/unit/client/lib/api.test.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/sessionsSlice.pagination.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
git commit -m "refactor: cut client sessions to lastActivityAt"
```

### Task 7: Sweep fallout and run full verification

**Files:**
- Modify: `test/unit/client/components/MobileTabStrip.test.tsx`
- Modify: `test/unit/client/components/SettingsView.behavior.test.tsx`
- Modify: `test/unit/client/components/Sidebar.mobile.test.tsx`
- Modify: `test/unit/client/components/Sidebar.perf-audit.test.tsx`
- Modify: `test/unit/client/components/TabSwitcher.test.tsx`
- Modify: `test/unit/client/components/component-edge-cases.test.tsx`
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx`
- Modify: `test/unit/client/store/state-edge-cases.test.ts`
- Modify: `test/server/ws-handshake-snapshot.test.ts`
- Modify: `test/unit/server/unified-rename.test.ts`
- Verify: coordinator status via `npm run test:status`

**Step 1: Sweep remaining session-domain `updatedAt` stragglers**

Run:

```bash
rg -n "\bupdatedAt\b" shared server src test
```

Convert only remaining coding-session, session-directory, session-search, CLI, sidebar, history, and related test-fixture occurrences to `lastActivityAt`. Leave non-session `updatedAt` fields intact.

**Step 2: Run lint and typecheck**

Run:

```bash
npm run lint
npm run typecheck
```

Expected: PASS

**Step 3: Run the broad focused suites most likely to catch fallout**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/coding-cli/claude-provider.test.ts test/unit/server/coding-cli/codex-provider.test.ts test/unit/server/coding-cli/opencode-provider.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts test/unit/server/session-association-coordinator.test.ts test/unit/server/session-directory/projection.test.ts test/unit/server/session-directory/service.test.ts test/unit/server/session-pagination.test.ts test/unit/server/session-search.test.ts test/unit/server/sessions-sync/diff.test.ts test/unit/server/sessions-sync/service.test.ts test/integration/server/session-directory-router.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts test/server/ws-handshake-snapshot.test.ts test/server/session-association.test.ts test/integration/server/codex-session-rebind-regression.test.ts test/unit/server/unified-rename.test.ts
npm run test:vitest -- test/unit/cli/commands.test.ts test/unit/client/lib/api.test.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/sessionsSlice.pagination.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/Sidebar.perf-audit.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/unit/client/components/MobileTabStrip.test.tsx test/unit/client/components/SettingsView.behavior.test.tsx test/unit/client/components/TabSwitcher.test.tsx test/unit/client/components/component-edge-cases.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/store/state-edge-cases.test.ts test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: PASS

**Step 4: Check coordinator status before the broad repo run**

Run:

```bash
npm run test:status
```

If another holder owns the gate, wait rather than forcing a broad run.

**Step 5: Run the full coordinated suite**

Run:

```bash
FRESHELL_TEST_SUMMARY="semantic session recency contract" CI=true npm test
```

Expected: PASS

**Step 6: Commit the fully verified cut**

Run:

```bash
git add -A
git commit -m "refactor: land semantic session recency contract"
```

## Outcome checklist

Before considering the work complete, confirm all of the following:

- Touching a session file without semantic transcript changes does not change `CodingCliSession.lastActivityAt`.
- `CodingCliSessionIndexer` does not emit a changed project update for touch-only churn.
- `SessionsSyncService` does not broadcast `sessions.changed` for touch-only churn.
- Session-directory routes, cursors, search results, and CLI output expose `lastActivityAt`.
- Sidebar ordering, HistoryView ordering, and context-menu "Last used" all render from `lastActivityAt`.
- No coding-session or session-directory/search contract surface still exposes session `updatedAt`.
- Terminal metadata and other non-session domains still use their own `updatedAt` fields unchanged.
