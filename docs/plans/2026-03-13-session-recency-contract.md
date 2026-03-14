# Semantic Session Recency Contract Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Stop sidebar flashes caused by filesystem-observation churn by replacing coding-session `updatedAt` with a semantic `lastActivityAt` contract that only moves when the session itself meaningfully advances.

**Architecture:** Make provider parsers own the semantic clock. File-backed providers must derive `createdAt` and `lastActivityAt` from transcript events, while the indexer uses filesystem `mtime` only as an internal cache invalidation key. Then cut the new `lastActivityAt` field through the server read model, websocket invalidation boundary, CLI/client API types, Redux store, and UI so every session-facing sort, cursor, and “Last used” label is driven by semantic activity rather than file touches.

**Tech Stack:** Node.js, TypeScript, Express, React 18, Redux Toolkit, Vitest, Testing Library

---

## Strategy Gate

The problem framing is correct: this is a data-contract bug, not a rendering-policy bug. The current contract lets file `mtime` masquerade as session recency, so any background write that does not change what the user sees can still reshuffle the sidebar and trip `sessions.changed`.

The important strategy correction is to finish the contract fix in one cut:

- Rename coding-session recency from `updatedAt` to `lastActivityAt` everywhere that represents a session.
- Keep unrelated `updatedAt` fields alone. Terminal metadata, codex activity records, tab registry records, and device records still use observation/update timestamps and should not be renamed in this change.
- Do not add a long-lived compatibility alias. A mixed `updatedAt`/`lastActivityAt` session contract would preserve the ambiguity that caused the bug.

Clean steady-state decisions:

- `ParsedSessionMeta.createdAt`: earliest semantic timestamp seen in provider data.
- `ParsedSessionMeta.lastActivityAt`: latest semantic timestamp seen in provider data.
- `CodingCliSession.lastActivityAt`: canonical session-recency field for all server and client session consumers.
- File `mtimeMs`: internal cache invalidation input only. Never expose it on a session object, never sort by it, never diff on it, never use it for websocket invalidation.
- If a file reparse yields no semantic timestamps, preserve the prior cached `createdAt`/`lastActivityAt` values instead of falling back to `mtime`.
- Direct-list providers such as OpenCode may map their upstream semantic timestamp straight into `lastActivityAt`.

Provider-specific semantic-clock policy:

- Claude counts transcript/session events that reflect real session progress: session init/start, user/assistant messages, tool use/results, reasoning/thinking, and completion/error-style events if present.
- Claude ignores bookkeeping-only records such as usage/token snapshots or debug-sidecar information.
- Codex counts semantic events such as `session_meta` for creation, `response_item` messages/tool calls/tool results, reasoning events, and task lifecycle events that reflect actual session progression.
- Codex ignores housekeeping-only events such as `token_count`, `turn_context`, and file-history snapshot records.

Implementation invariants:

- `server/coding-cli/session-indexer.ts` may still use `mtimeMs` and file size to decide whether to reparse a file, but reparsing must not itself move session recency.
- `server/session-directory/projection.ts` and `server/sessions-sync/service.ts` must invalidate on `lastActivityAt` changes, not on observation-only churn.
- The session-directory cursor, pagination, search ordering, CLI output, and sidebar/history/context-menu timestamps must all use the same `lastActivityAt` field.
- Existing stale-while-refresh sidebar behavior stays intact; this plan removes the bad invalidations at the source rather than adding more client suppression.
- `docs/index.html` stays untouched. This is a behavioral correctness fix, not a new surface.
- Focused test runs should use repo-owned Vitest entry points. The final broad run must use the coordinator and set `FRESHELL_TEST_SUMMARY`.

Rejected approaches:

- Silently redefining session `updatedAt` to mean semantic activity. That hides the contract change instead of making it explicit.
- Client-only sidebar suppression while keeping `mtime`-driven invalidations. That treats the symptom and leaves every other session consumer wrong.
- Falling back to file `mtime` whenever provider parsing cannot find a timestamp. That reintroduces the same root-cause leak under a new name.
- A staged compatibility period where some session consumers use `updatedAt` and others use `lastActivityAt`. That guarantees drift and makes reviews harder, not easier.

### Task 1: Lock semantic-clock rules with red tests

**Files:**
- Modify: `test/unit/server/coding-cli/claude-provider.test.ts`
- Modify: `test/unit/server/coding-cli/codex-provider.test.ts`
- Modify: `test/unit/server/coding-cli/session-indexer.test.ts`
- Modify: `test/unit/server/session-directory/projection.test.ts`
- Modify: `test/unit/server/sessions-sync/service.test.ts`

**Step 1: Add the Claude parser red tests**

Extend `test/unit/server/coding-cli/claude-provider.test.ts` with two explicit parser cases:

```ts
it('derives createdAt and lastActivityAt from semantic transcript timestamps', () => {
  const meta = parseSessionContent([
    JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION_A, cwd: '/repo', timestamp: '2026-03-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'user', message: 'Ship it', timestamp: '2026-03-01T00:00:03.000Z' }),
    JSON.stringify({ type: 'assistant', message: 'On it', timestamp: '2026-03-01T00:00:05.000Z' }),
  ].join('\n'))

  expect(meta.createdAt).toBe(Date.parse('2026-03-01T00:00:00.000Z'))
  expect(meta.lastActivityAt).toBe(Date.parse('2026-03-01T00:00:05.000Z'))
})

it('does not move lastActivityAt for usage-only bookkeeping lines', () => {
  const meta = parseSessionContent([
    JSON.stringify({ type: 'assistant', message: 'Visible reply', timestamp: '2026-03-01T00:00:05.000Z' }),
    JSON.stringify({ type: 'assistant', uuid: 'usage-only', message: { role: 'assistant', usage: { input_tokens: 1, output_tokens: 2 } }, timestamp: '2026-03-01T00:00:20.000Z' }),
  ].join('\n'))

  expect(meta.lastActivityAt).toBe(Date.parse('2026-03-01T00:00:05.000Z'))
})
```

The second test is the critical guard: later bookkeeping writes must not advance the session clock.

**Step 2: Add the Codex parser red tests**

Extend `test/unit/server/coding-cli/codex-provider.test.ts` with two explicit cases:

```ts
it('derives createdAt and lastActivityAt from semantic codex events', () => {
  const meta = parseCodexSessionContent([
    JSON.stringify({ timestamp: '2026-03-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'session-1', cwd: '/repo' } }),
    JSON.stringify({ timestamp: '2026-03-01T00:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Visible reply' }] } }),
    JSON.stringify({ timestamp: '2026-03-01T00:00:06.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n'))

  expect(meta.createdAt).toBe(Date.parse('2026-03-01T00:00:00.000Z'))
  expect(meta.lastActivityAt).toBe(Date.parse('2026-03-01T00:00:06.000Z'))
})

it('ignores housekeeping-only codex events when deriving lastActivityAt', () => {
  const meta = parseCodexSessionContent([
    JSON.stringify({ timestamp: '2026-03-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'session-1', cwd: '/repo' } }),
    JSON.stringify({ timestamp: '2026-03-01T00:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Visible reply' }] } }),
    JSON.stringify({ timestamp: '2026-03-01T00:00:20.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_usage_tokens: 999 } } }),
    JSON.stringify({ timestamp: '2026-03-01T00:00:21.000Z', type: 'turn_context', payload: { cwd: '/repo' } }),
  ].join('\n'))

  expect(meta.lastActivityAt).toBe(Date.parse('2026-03-01T00:00:04.000Z'))
})
```

If the sanitized fixture exposes a real file-history snapshot payload name, add that as a third ignored-housekeeping example in the same block instead of inventing a new one.

**Step 3: Add the indexer red test that proves `mtime` no longer leaks**

Extend `test/unit/server/coding-cli/session-indexer.test.ts` with a file-backed refresh test:

- initial parse returns `createdAt: 100`, `lastActivityAt: 200`, `title: 'Session A'`
- touch the file so `mtimeMs` changes
- second parse returns the exact same semantic timestamps and visible fields
- expect the refreshed project snapshot to keep `lastActivityAt === 200`
- expect the indexer not to emit a changed project set for the touch-only refresh

Use `indexer.onUpdate()` to count actual update emissions instead of asserting only on file-cache internals.

**Step 4: Rename the projection/sync tests to the new field and keep the behavior red**

Update `test/unit/server/session-directory/projection.test.ts` and `test/unit/server/sessions-sync/service.test.ts` so their comparable snapshots and upserts use `lastActivityAt` instead of `updatedAt`, while preserving the same assertions:

- invisible metadata stays ignored
- `lastActivityAt` remains directory-visible and invalidates the snapshot
- websocket revisions advance only when directory-visible session state changes

These tests should fail at compile/runtime until the server cutover is real.

**Step 5: Run the focused red pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/coding-cli/claude-provider.test.ts test/unit/server/coding-cli/codex-provider.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/session-directory/projection.test.ts test/unit/server/sessions-sync/service.test.ts
```

Expected: FAIL because the session model and parsers still expose `updatedAt` and still derive recency from `mtime`.

**Step 6: Commit the red tests**

Run:

```bash
git add test/unit/server/coding-cli/claude-provider.test.ts test/unit/server/coding-cli/codex-provider.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/session-directory/projection.test.ts test/unit/server/sessions-sync/service.test.ts
git commit -m "test: lock semantic session recency contract"
```

### Task 2: Make providers and the indexer own semantic session time

**Files:**
- Modify: `server/coding-cli/types.ts`
- Modify: `server/coding-cli/providers/claude.ts`
- Modify: `server/coding-cli/providers/codex.ts`
- Modify: `server/coding-cli/providers/opencode.ts`
- Modify: `server/coding-cli/session-indexer.ts`
- Modify: `server/coding-cli/codex-activity-tracker.ts`
- Modify: `server/session-association-coordinator.ts`
- Modify: `server/index.ts`
- Modify: `test/unit/server/coding-cli/claude-provider.test.ts`
- Modify: `test/unit/server/coding-cli/codex-provider.test.ts`
- Modify: `test/unit/server/coding-cli/opencode-provider.test.ts`
- Modify: `test/unit/server/coding-cli/session-indexer.test.ts`
- Modify: `test/unit/server/coding-cli/codex-activity-tracker.test.ts`
- Modify: `test/unit/server/session-association-coordinator.test.ts`
- Modify: `test/server/session-association.test.ts`
- Modify: `test/integration/server/codex-session-rebind-regression.test.ts`

**Step 1: Change the core session types**

In `server/coding-cli/types.ts`:

- add `createdAt?: number` and `lastActivityAt?: number` to `ParsedSessionMeta`
- rename `CodingCliSession.updatedAt` to `CodingCliSession.lastActivityAt`

Use the new names directly. Do not leave both fields on `CodingCliSession`.

Representative target shape:

```ts
export interface ParsedSessionMeta {
  sessionId?: string
  cwd?: string
  createdAt?: number
  lastActivityAt?: number
  // existing fields unchanged...
}

export interface CodingCliSession {
  provider: CodingCliProviderName
  sessionId: string
  projectPath: string
  lastActivityAt: number
  createdAt?: number
  // existing fields unchanged...
}
```

**Step 2: Implement semantic clock extraction in the Claude parser**

Add small helpers in `server/coding-cli/providers/claude.ts`:

- `parseTimestampMs(value: unknown): number | undefined`
- `noteCreatedAt(current, candidate): number | undefined`
- `noteLastActivityAt(current, candidate): number | undefined`
- `isClaudeSemanticRecord(obj: any): boolean`

Then, during the existing line scan in `parseSessionContent()`, capture:

- earliest semantic timestamp into `createdAt`
- latest semantic timestamp into `lastActivityAt`

Exclude usage-only records from `lastActivityAt`. Keep token-usage aggregation behavior unchanged.

**Step 3: Implement semantic clock extraction in the Codex parser**

Add the equivalent helpers in `server/coding-cli/providers/codex.ts` and derive `createdAt`/`lastActivityAt` during the existing JSONL pass.

The semantic-event filter should be explicit and small. A good starting rule is:

```ts
function isSemanticCodexEvent(obj: any): boolean {
  if (obj?.type === 'session_meta') return true
  if (obj?.type === 'response_item') {
    return obj?.payload?.type === 'message' ||
      obj?.payload?.type === 'function_call' ||
      obj?.payload?.type === 'function_call_output'
  }
  if (obj?.type === 'event_msg') {
    return obj?.payload?.type === 'agent_reasoning' ||
      obj?.payload?.type === 'task_started' ||
      obj?.payload?.type === 'task_complete' ||
      obj?.payload?.type === 'turn_aborted'
  }
  return false
}
```

Do not broaden this with catch-all `event_msg` logic. Housekeeping writes are exactly what this change is supposed to stop.

**Step 4: Switch the indexer to semantic recency**

In `server/coding-cli/session-indexer.ts`:

- keep `mtimeMs`/`size` caching exactly for “should we reparse?”
- build `baseSession.lastActivityAt` from `meta.lastActivityAt`, not file stat
- preserve prior cached `createdAt`/`lastActivityAt` when the new parse omits them
- sort sessions/projects/new-session callbacks by `lastActivityAt`
- keep file `mtimeMs` inside `CachedSessionEntry`, not inside `baseSession`

Use a fallback chain like:

```ts
const previous = cached?.baseSession
const createdAt = meta.createdAt ?? previous?.createdAt
const lastActivityAt =
  meta.lastActivityAt ??
  previous?.lastActivityAt ??
  createdAt ??
  0
```

This is the point of the fix: the semantic clock may stay unchanged across reparses even when the file changed.

**Step 5: Update internal session consumers**

Replace session-domain `updatedAt` reads with `lastActivityAt` in:

- `server/coding-cli/codex-activity-tracker.ts` for “last seen session time” bookkeeping
- `server/session-association-coordinator.ts` for association watermarks/age checks
- `server/index.ts` where new-session association passes a session snapshot into the coordinator

Leave terminal-meta and codex-activity record `updatedAt` fields untouched.

**Step 6: Run the focused server model pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/coding-cli/claude-provider.test.ts test/unit/server/coding-cli/codex-provider.test.ts test/unit/server/coding-cli/opencode-provider.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts test/unit/server/session-association-coordinator.test.ts test/server/session-association.test.ts test/integration/server/codex-session-rebind-regression.test.ts
```

Expected: PASS

**Step 7: Commit the semantic-clock implementation**

Run:

```bash
git add server/coding-cli/types.ts server/coding-cli/providers/claude.ts server/coding-cli/providers/codex.ts server/coding-cli/providers/opencode.ts server/coding-cli/session-indexer.ts server/coding-cli/codex-activity-tracker.ts server/session-association-coordinator.ts server/index.ts test/unit/server/coding-cli/claude-provider.test.ts test/unit/server/coding-cli/codex-provider.test.ts test/unit/server/coding-cli/opencode-provider.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts test/unit/server/session-association-coordinator.test.ts test/server/session-association.test.ts test/integration/server/codex-session-rebind-regression.test.ts
git commit -m "refactor: derive semantic coding session recency"
```

### Task 3: Cut the server read model and CLI over to `lastActivityAt`

**Files:**
- Modify: `shared/read-models.ts`
- Modify: `server/session-directory/types.ts`
- Modify: `server/session-directory/projection.ts`
- Modify: `server/session-directory/service.ts`
- Modify: `server/session-search.ts`
- Modify: `server/session-pagination.ts`
- Modify: `server/sessions-sync/service.ts`
- Modify: `server/sessions-router.ts`
- Modify: `server/cli/index.ts`
- Modify: `test/unit/server/session-directory/projection.test.ts`
- Modify: `test/unit/server/session-directory/service.test.ts`
- Modify: `test/unit/server/session-search.test.ts`
- Modify: `test/unit/server/session-pagination.test.ts`
- Modify: `test/unit/server/sessions-sync/diff.test.ts`
- Modify: `test/unit/server/sessions-sync/service.test.ts`
- Modify: `test/integration/server/session-directory-router.test.ts`
- Modify: `test/server/ws-sidebar-snapshot-refresh.test.ts`
- Modify: `test/unit/cli/commands.test.ts`

**Step 1: Centralize the read-model response contract**

Extend `shared/read-models.ts` with shared response schemas/types for the session directory:

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

Then update `server/session-directory/types.ts` to alias these shared types instead of carrying a second local copy. This contract change is the whole feature; keeping a single shared definition is worth the small extra work.

**Step 2: Rename the directory comparator and cursor semantics**

In `server/session-directory/projection.ts` and `server/session-directory/service.ts`:

- rename comparable-item fields and cursor payload from `updatedAt` to `lastActivityAt`
- sort and compare by `lastActivityAt`
- compute route `revision` from session `lastActivityAt` plus terminal-meta `updatedAt`
- keep terminal-meta contribution unchanged

Representative cursor shape:

```ts
type CursorPayload = {
  lastActivityAt: number
  key: string
}
```

The route behavior must stay identical except for the field name and the fact that observation-only file touches no longer move session recency.

**Step 3: Rename every server-side session read-model consumer**

Update `server/session-search.ts`, `server/session-pagination.ts`, `server/sessions-sync/service.ts`, `server/sessions-router.ts`, and `server/cli/index.ts` to use `lastActivityAt`.

Important details:

- `server/session-search.ts` search result schema and sort order must use `lastActivityAt`
- `server/session-pagination.ts` cursor/filter/sort output must use `lastActivityAt`
- `server/cli/index.ts` transformation helpers must emit `lastActivityAt`
- `server/sessions-sync/service.ts` needs only the field rename because the projection helper already defines visibility

Do not touch unrelated terminal or registry schemas in `shared/ws-protocol.ts`.

**Step 4: Run the focused server/CLI contract pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/session-directory/projection.test.ts test/unit/server/session-directory/service.test.ts test/unit/server/session-search.test.ts test/unit/server/session-pagination.test.ts test/unit/server/sessions-sync/diff.test.ts test/unit/server/sessions-sync/service.test.ts test/integration/server/session-directory-router.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts
npm run test:vitest -- test/unit/cli/commands.test.ts
```

Expected: PASS

**Step 5: Commit the server contract cutover**

Run:

```bash
git add shared/read-models.ts server/session-directory/types.ts server/session-directory/projection.ts server/session-directory/service.ts server/session-search.ts server/session-pagination.ts server/sessions-sync/service.ts server/sessions-router.ts server/cli/index.ts test/unit/server/session-directory/projection.test.ts test/unit/server/session-directory/service.test.ts test/unit/server/session-search.test.ts test/unit/server/session-pagination.test.ts test/unit/server/sessions-sync/diff.test.ts test/unit/server/sessions-sync/service.test.ts test/integration/server/session-directory-router.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts test/unit/cli/commands.test.ts
git commit -m "refactor: rename session read model recency to lastActivityAt"
```

### Task 4: Cut the client/store/UI over to `lastActivityAt`

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/store/sessionsSlice.ts`
- Modify: `src/store/sessionsThunks.ts`
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Modify: `src/lib/api.ts`
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

**Step 1: Rename the client session model and API response mapping**

In `src/store/types.ts` and `src/lib/api.ts`:

- rename session-domain `updatedAt` to `lastActivityAt`
- keep non-session `updatedAt` shapes alone
- update `fetchSidebarSessionsSnapshot()` and `searchSessions()` transforms to read/write `lastActivityAt`

Representative client-side shape:

```ts
export interface CodingCliSession {
  provider: CodingCliProviderName
  sessionId: string
  projectPath: string
  createdAt?: number
  lastActivityAt: number
  // ...
}
```

Also rename the legacy cursor encoder in `src/lib/api.ts` so it serializes `lastActivityAt` instead of `updatedAt`.

**Step 2: Switch store-level recency math**

Update `src/store/sessionsSlice.ts` and `src/store/sessionsThunks.ts` so all project sorting, oldest-loaded calculations, pagination cursors, and search-result normalization use `lastActivityAt`.

This includes:

- `projectNewestUpdatedAt()` -> `projectNewestLastActivityAt()`
- `oldestLoadedTimestamp` calculations
- search-result regrouping
- merge logic that compares or sorts session recency

Keep the existing loading and invalidation behavior exactly as-is.

**Step 3: Switch UI consumers**

Update these session-facing UI consumers to read `lastActivityAt`:

- `src/store/selectors/sidebarSelectors.ts` for sidebar timestamps/order
- `src/components/Sidebar.tsx` comments/comparator semantics where session timestamps are compared
- `src/components/HistoryView.tsx` for “last used” sorting and display
- `src/components/context-menu/ContextMenuProvider.tsx` for delete-confirmation and copied session metadata

Do not rename tab or terminal timestamps in the same files. Only the session-domain objects change.

**Step 4: Add and fix client/e2e coverage**

Update the listed client and jsdom e2e tests so they exercise the new contract explicitly:

- `test/unit/client/lib/api.test.ts` should assert `lastActivityAt` is preserved from directory items
- `test/unit/client/store/sessionsSlice.test.ts` should sort by newest `lastActivityAt`
- `test/unit/client/store/sessionsThunks.test.ts` and `test/unit/client/sessionsSlice.pagination.test.ts` should keep pagination and window state anchored to `lastActivityAt`
- `test/unit/client/store/selectors/sidebarSelectors.test.ts` and `.knownKeys.test.ts` should build session fixtures with `lastActivityAt`
- `test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts` should keep running-session joins intact with the renamed field
- `test/unit/client/components/App.test.tsx` and `test/unit/client/components/App.ws-bootstrap.test.tsx` should consume websocket/bootstrap session snapshots with `lastActivityAt`
- `test/unit/client/components/Sidebar.test.tsx` should continue to render relative time from the renamed field
- `test/unit/client/components/ContextMenuProvider.test.tsx` should show “Last used” from `lastActivityAt`
- `test/e2e/open-tab-session-sidebar-visibility.test.tsx` and `test/e2e/sidebar-click-opens-pane.test.tsx` should use the new payload shape so the app-level harness proves the rename is real end-to-end

Do not add a fake browser-visual flash test here. The root-cause contract is already pinned by provider/indexer/sync tests; client coverage only needs to prove the app still consumes the new field correctly.

**Step 5: Run the focused client pack**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/api.test.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/sessionsSlice.pagination.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: PASS

**Step 6: Commit the client cutover**

Run:

```bash
git add src/store/types.ts src/store/sessionsSlice.ts src/store/sessionsThunks.ts src/store/selectors/sidebarSelectors.ts src/lib/api.ts src/components/Sidebar.tsx src/components/HistoryView.tsx src/components/context-menu/ContextMenuProvider.tsx test/unit/client/lib/api.test.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/sessionsSlice.pagination.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
git commit -m "refactor: cut session clients over to lastActivityAt"
```

### Task 5: Sweep remaining session-domain fallout and run the full verification stack

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
- Verify: `package.json`
- Verify: coordinator state via `npm run test:status`

**Step 1: Sweep for session-domain `updatedAt` stragglers**

Run:

```bash
rg -n "\bupdatedAt\b" server src test
```

Convert every remaining coding-session/session-directory/search/sidebar/history/context-menu occurrence to `lastActivityAt`. Leave the following categories alone:

- terminal metadata
- codex activity records
- tab registry records
- device/known-device records
- generic test harness timestamps unrelated to coding sessions

If a file is ambiguous, read it and decide deliberately; do not blanket-replace.

**Step 2: Run lint and typecheck**

Run:

```bash
npm run lint
npm run typecheck
```

Expected: PASS

**Step 3: Run the broad focused suites that matter most for this feature**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/coding-cli/claude-provider.test.ts test/unit/server/coding-cli/codex-provider.test.ts test/unit/server/coding-cli/opencode-provider.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/session-directory/projection.test.ts test/unit/server/session-directory/service.test.ts test/unit/server/session-search.test.ts test/unit/server/session-pagination.test.ts test/unit/server/sessions-sync/diff.test.ts test/unit/server/sessions-sync/service.test.ts test/integration/server/session-directory-router.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts test/server/ws-handshake-snapshot.test.ts test/server/session-association.test.ts test/unit/server/unified-rename.test.ts
npm run test:vitest -- test/unit/cli/commands.test.ts test/unit/client/lib/api.test.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/sessionsSlice.pagination.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/Sidebar.perf-audit.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/unit/client/components/MobileTabStrip.test.tsx test/unit/client/components/SettingsView.behavior.test.tsx test/unit/client/components/TabSwitcher.test.tsx test/unit/client/components/component-edge-cases.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/store/state-edge-cases.test.ts test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
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
FRESHELL_TEST_SUMMARY="session recency contract" CI=true npm test
```

Expected: PASS

**Step 6: Commit the final verified cut**

Run:

```bash
git add -A
git commit -m "refactor: land semantic session recency contract"
```

## Outcome checklist

Before considering the work complete, confirm all of the following are true:

- Touching a session file without changing semantic session events does not change `CodingCliSession.lastActivityAt`.
- `SessionsSyncService` does not broadcast `sessions.changed` for `mtime`-only churn.
- The session-directory route, cursor, search ordering, CLI output, and client API all expose `lastActivityAt`.
- Sidebar ordering, HistoryView ordering, and context-menu “Last used” all render from `lastActivityAt`.
- No coding-session/session-directory contract surface still exposes `updatedAt`.
- Terminal metadata and other non-session domains still use their own `updatedAt` fields unchanged.
