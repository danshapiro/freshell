# Semantic Session Recency Contract Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Stop sidebar flashes caused by filesystem-observation churn by replacing coding-session `updatedAt` with a semantic `lastActivityAt` contract that only moves when the session itself meaningfully advances.

**Architecture:** Make provider parsers own the semantic clock. File-backed providers derive `createdAt` and `lastActivityAt` from transcript events, the session indexer keeps filesystem `mtime` only as an internal cache invalidation key, and every server/client read model that represents a coding session switches to `lastActivityAt` in one cut. The shared session-directory response shape lives in `shared/read-models.ts` so the server, CLI, and browser stop carrying duplicate `updatedAt` definitions.

**Tech Stack:** Node.js, TypeScript, Express, React 18, Redux Toolkit, Vitest, Testing Library

---

## Strategy Gate

The framing is correct: this is a session-data contract bug, not a rendering-policy bug. The sidebar flashes because touch-only file writes currently leak through `CodingCliSession.updatedAt`, which the directory projection treats as visible state and the sidebar sorts on by default. Fixing the renderer while keeping `mtime`-driven recency would leave the read model, websocket invalidation boundary, CLI output, search ordering, and pagination contract wrong.

Direct architectural decisions:

- Rename coding-session recency from `updatedAt` to `lastActivityAt` everywhere the system represents a coding session.
- Keep unrelated `updatedAt` fields alone. Terminal metadata, codex activity records, tab registry records, device records, and other observation timestamps are not part of this change.
- Do not add a compatibility alias. A mixed `updatedAt`/`lastActivityAt` session contract keeps the ambiguity that caused the bug.
- `shared/read-models.ts` becomes the single shared definition for session-directory request and response shapes.
- File `mtimeMs` remains internal cache state only. It must never be copied onto a session object, never drive sort order, never participate in session-directory comparators, and never trigger `sessions.changed`.
- If a file reparse yields no semantic timestamps, carry forward the previous cached `createdAt` and `lastActivityAt` instead of falling back to `mtime`.
- Direct-list providers such as OpenCode may map their upstream semantic timestamp directly into `lastActivityAt`.
- Keep generic container names like `oldestLoadedTimestamp` and `oldestIncludedTimestamp` unless the field itself is part of the session wire/read-model contract. They can continue to hold semantic session time without a wide rename.
- No storage migration is needed. Session windows are in-memory state, not persisted localStorage schema.

Steady-state contract:

- `ParsedSessionMeta.createdAt`: earliest semantic timestamp seen in provider data.
- `ParsedSessionMeta.lastActivityAt`: latest semantic timestamp seen in provider data.
- `CodingCliSession.lastActivityAt`: canonical session-recency field for all coding-session server and client consumers.
- Session-directory ordering, pagination, search results, CLI output, sidebar timestamps, HistoryView timestamps, and context-menu "Last used" all derive from `lastActivityAt`.

Provider semantic-clock policy:

- Claude counts transcript/session records that represent real session progress: init/start records, user/assistant messages, tool use/results, reasoning/thinking, and completion/error-style records if present.
- Claude ignores bookkeeping-only records such as `file-history-snapshot`, usage-only assistant payloads, and debug-sidecar data.
- Codex counts semantic records such as `session_meta`, `response_item` messages/tool calls/tool results, `agent_reasoning`, `task_started`, `task_complete`, and `turn_aborted`.
- Codex ignores housekeeping-only records such as `token_count`, `turn_context`, and any other metadata-only snapshots that do not represent visible session progress.

Implementation invariants:

- `server/coding-cli/session-indexer.ts` may still use `mtimeMs` and file size to decide whether to reparse a file, but reparsing must not itself move session recency.
- `server/session-directory/projection.ts` and `server/sessions-sync/service.ts` must invalidate on `lastActivityAt` changes, not observation-only churn.
- The executor should reuse existing real fixture/event shapes already present in provider tests instead of inventing new fake housekeeping formats where the repo already has one.
- Existing stale-while-refresh sidebar behavior stays intact; this fix removes bad invalidations at the source rather than layering more client suppression on top.
- `docs/index.html` stays untouched. This is a correctness fix, not a new feature surface.
- Focused test runs use repo-owned Vitest entry points. The final broad run uses the coordinator and sets `FRESHELL_TEST_SUMMARY`.

Rejected approaches:

- Silently redefining session `updatedAt` to mean semantic activity. That hides the contract change instead of making it explicit.
- Client-only sidebar suppression while keeping `mtime`-driven invalidations. That treats the symptom and leaves every other session consumer wrong.
- Falling back to file `mtime` when provider parsing cannot find a timestamp. That reintroduces the same root-cause leak under a new name.
- A staged compatibility period where some session consumers use `updatedAt` and others use `lastActivityAt`. That guarantees drift.
- A blanket rename of every generic timestamp variable in the repo. The contract field must change; generic pagination/cache container names do not.

### Task 1: Red-test provider semantic clocks

**Files:**
- Modify: `test/unit/server/coding-cli/claude-provider.test.ts`
- Modify: `test/unit/server/coding-cli/codex-provider.test.ts`

**Step 1: Add Claude parser red tests**

Extend `test/unit/server/coding-cli/claude-provider.test.ts` with:

- one test that derives `createdAt` and `lastActivityAt` from semantic transcript records
- one test that proves later bookkeeping records do not move `lastActivityAt`

Use the real housekeeping shapes the file already knows about: `file-history-snapshot` and usage-only assistant payloads. Do not invent a second fake "bookkeeping" format when the repo already has exact examples.

Representative target:

```ts
it('derives createdAt and lastActivityAt from semantic Claude transcript records', () => {
  const meta = parseSessionContent([
    JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION_A, cwd: '/repo', timestamp: '2026-03-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'user', message: 'Ship it', timestamp: '2026-03-01T00:00:03.000Z' }),
    JSON.stringify({ type: 'assistant', message: 'On it', timestamp: '2026-03-01T00:00:05.000Z' }),
  ].join('\n'))

  expect(meta.createdAt).toBe(Date.parse('2026-03-01T00:00:00.000Z'))
  expect(meta.lastActivityAt).toBe(Date.parse('2026-03-01T00:00:05.000Z'))
})
```

**Step 2: Add Codex parser red tests**

Extend `test/unit/server/coding-cli/codex-provider.test.ts` with:

- one fixture-backed test that proves `task-events.sanitized.jsonl` yields semantic `createdAt` and `lastActivityAt`
- one explicit test that appending later `token_count` and `turn_context` lines does not move `lastActivityAt`

Representative target:

```ts
it('ignores token_count and turn_context when deriving lastActivityAt', () => {
  const meta = parseCodexSessionContent([
    JSON.stringify({ timestamp: '2026-03-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'session-1', cwd: '/repo' } }),
    JSON.stringify({ timestamp: '2026-03-01T00:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Visible reply' }] } }),
    JSON.stringify({ timestamp: '2026-03-01T00:00:20.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_usage_tokens: 999 } } }),
    JSON.stringify({ timestamp: '2026-03-01T00:00:21.000Z', type: 'turn_context', payload: { cwd: '/repo' } }),
  ].join('\n'))

  expect(meta.lastActivityAt).toBe(Date.parse('2026-03-01T00:00:04.000Z'))
})
```

**Step 3: Run the focused red parser pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/coding-cli/claude-provider.test.ts test/unit/server/coding-cli/codex-provider.test.ts
```

Expected: FAIL because providers do not yet expose `createdAt`/`lastActivityAt`.

**Step 4: Commit the red parser tests**

Run:

```bash
git add test/unit/server/coding-cli/claude-provider.test.ts test/unit/server/coding-cli/codex-provider.test.ts
git commit -m "test: lock provider semantic session clocks"
```

### Task 2: Red-test the no-flash invalidation boundary

**Files:**
- Modify: `test/unit/server/coding-cli/session-indexer.test.ts`
- Modify: `test/unit/server/session-directory/projection.test.ts`
- Modify: `test/unit/server/sessions-sync/service.test.ts`

**Step 1: Add the indexer red test for touch-only churn**

Extend `test/unit/server/coding-cli/session-indexer.test.ts` with a file-backed refresh test that proves the root cause is gone:

- the first parse returns `createdAt: 100`, `lastActivityAt: 200`, `title: 'Session A'`
- the file is touched so `mtimeMs` changes
- the second parse returns the same semantic timestamps and visible fields, or omits them entirely so the cache carry-forward path is exercised
- `indexer.getProjects()` still reports `lastActivityAt === 200`
- `indexer.onUpdate()` does not emit a second change for the touch-only refresh

Use `onUpdate()` emission count, not file-cache internals, as the regression signal. This is the direct "sidebar should not flash while idle" guard.

**Step 2: Update projection/sync tests to the new field and the new boundary**

Update `test/unit/server/session-directory/projection.test.ts` and `test/unit/server/sessions-sync/service.test.ts` so they use `lastActivityAt` and explicitly assert:

- invisible metadata stays ignored
- unchanged `lastActivityAt` plus invisible metadata churn does not invalidate the directory snapshot
- changing `lastActivityAt` does invalidate the snapshot and advance websocket revision

**Step 3: Run the focused red invalidation pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/session-directory/projection.test.ts test/unit/server/sessions-sync/service.test.ts
```

Expected: FAIL because the indexer and projection still leak `mtime` through session `updatedAt`.

**Step 4: Commit the red invalidation tests**

Run:

```bash
git add test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/session-directory/projection.test.ts test/unit/server/sessions-sync/service.test.ts
git commit -m "test: lock session invalidation boundary"
```

### Task 3: Implement semantic session clocks in providers and the indexer

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

**Step 1: Cut the core session types**

In `server/coding-cli/types.ts`:

- add `createdAt?: number` and `lastActivityAt?: number` to `ParsedSessionMeta`
- rename `CodingCliSession.updatedAt` to `CodingCliSession.lastActivityAt`

In `server/coding-cli/providers/claude.ts`, either fold `JsonlMeta` into `ParsedSessionMeta` or extend it so the new semantic clock fields exist on the parser return type too. Do not leave a local parser return type that silently omits the new fields.

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

**Step 2: Implement the Claude semantic clock**

In `server/coding-cli/providers/claude.ts`:

- add `parseTimestampMs(value: unknown): number | undefined`
- add helpers to record earliest/latest semantic timestamps
- add a tight `isClaudeSemanticRecord(obj: any): boolean`
- update `parseSessionContent()` so `createdAt` and `lastActivityAt` come only from semantic records

The semantic filter must explicitly ignore `file-history-snapshot` and usage-only assistant payloads.

**Step 3: Implement the Codex semantic clock**

In `server/coding-cli/providers/codex.ts`:

- add the same timestamp helpers
- add an explicit `isSemanticCodexEvent(obj: any): boolean`
- derive `createdAt` and `lastActivityAt` during the existing JSONL scan

Good starting rule:

```ts
function isSemanticCodexEvent(obj: any): boolean {
  if (obj?.type === 'session_meta') return true
  if (obj?.type === 'response_item') {
    return obj?.payload?.type === 'message'
      || obj?.payload?.type === 'function_call'
      || obj?.payload?.type === 'function_call_output'
  }
  if (obj?.type === 'event_msg') {
    return obj?.payload?.type === 'agent_reasoning'
      || obj?.payload?.type === 'task_started'
      || obj?.payload?.type === 'task_complete'
      || obj?.payload?.type === 'turn_aborted'
  }
  return false
}
```

Do not broaden this with catch-all `event_msg` logic.

**Step 4: Switch the indexer to semantic recency**

In `server/coding-cli/session-indexer.ts`:

- keep `mtimeMs` and `size` only for "should we reparse?"
- build `baseSession.lastActivityAt` from parser output, never from file stat
- preserve prior cached `createdAt` and `lastActivityAt` when the new parse omits them
- sort sessions, projects, and new-session callbacks by `lastActivityAt`
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

In `server/coding-cli/providers/opencode.ts`, map the upstream DB timestamp into `lastActivityAt` while leaving the SQL column name alone.

**Step 5: Rename session-domain internal bookkeeping**

Update internal consumers so their names and comparisons match the new contract:

- `server/coding-cli/codex-activity-tracker.ts`: session-domain reads use `lastActivityAt`; rename internal state like `lastSeenSessionUpdatedAt` to `lastSeenSessionActivityAt`
- `server/session-association-coordinator.ts`: compare and watermark by `lastActivityAt`; rename helpers like `normalizeUpdatedAt()` to `normalizeLastActivityAt()`
- `server/index.ts`: pass session snapshots with `lastActivityAt` into association flow and fix any stale comments that still describe session recency as `updatedAt`

Leave terminal-meta and codex-activity record `updatedAt` fields untouched.

**Step 6: Run the focused semantic-clock pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/coding-cli/claude-provider.test.ts test/unit/server/coding-cli/codex-provider.test.ts test/unit/server/coding-cli/opencode-provider.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts test/unit/server/session-association-coordinator.test.ts test/server/session-association.test.ts test/integration/server/codex-session-rebind-regression.test.ts
```

Expected: PASS

**Step 7: Commit the semantic-clock implementation**

Run:

```bash
git add server/coding-cli/types.ts server/coding-cli/providers/claude.ts server/coding-cli/providers/codex.ts server/coding-cli/providers/opencode.ts server/coding-cli/session-indexer.ts server/coding-cli/codex-activity-tracker.ts server/session-association-coordinator.ts server/index.ts test/unit/server/coding-cli/claude-provider.test.ts test/unit/server/coding-cli/codex-provider.test.ts test/unit/server/coding-cli/opencode-provider.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts test/unit/server/session-association-coordinator.test.ts test/server/session-association.test.ts test/integration/server/codex-session-rebind-regression.test.ts
git commit -m "refactor: derive semantic coding session clocks"
```

### Task 4: Cut the shared server and CLI session read model to `lastActivityAt`

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

**Step 1: Centralize the session-directory response contract**

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

Then update `server/session-directory/types.ts` to alias these shared types instead of carrying a second local copy.

**Step 2: Rename the server read model and CLI transforms**

Update `server/session-directory/projection.ts`, `server/session-directory/service.ts`, `server/session-search.ts`, `server/session-pagination.ts`, `server/sessions-sync/service.ts`, `server/sessions-router.ts`, and `server/cli/index.ts` so they use `lastActivityAt`.

Important details:

- comparator fields and cursor payloads use `lastActivityAt`
- route `revision` is the max of session `lastActivityAt` and terminal-meta `updatedAt`
- `server/session-search.ts` search result schema and ordering use `lastActivityAt`
- `server/session-pagination.ts` sorts and paginates by `lastActivityAt`, but generic container names like `oldestIncludedTimestamp` and `before` may stay as generic timestamp names
- `server/cli/index.ts` emits `lastActivityAt` in session/project/search output

Do not touch unrelated terminal or registry schemas in `shared/ws-protocol.ts`.

**Step 3: Update server and CLI tests/fixtures**

Update the listed tests so their fixtures and assertions use `lastActivityAt`, including `test/server/ws-sidebar-snapshot-refresh.test.ts` bootstrap fixtures. Keep the websocket behavior itself unchanged: it should still broadcast lightweight `sessions.changed` invalidations, just no longer for touch-only session churn.

**Step 4: Run the focused server/CLI contract pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/session-directory/projection.test.ts test/unit/server/session-directory/service.test.ts test/unit/server/session-search.test.ts test/unit/server/session-pagination.test.ts test/unit/server/sessions-sync/diff.test.ts test/unit/server/sessions-sync/service.test.ts test/integration/server/session-directory-router.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts
npm run test:vitest -- test/unit/cli/commands.test.ts
```

Expected: PASS

**Step 5: Commit the server/CLI contract cutover**

Run:

```bash
git add shared/read-models.ts server/session-directory/types.ts server/session-directory/projection.ts server/session-directory/service.ts server/session-search.ts server/session-pagination.ts server/sessions-sync/service.ts server/sessions-router.ts server/cli/index.ts test/unit/server/session-directory/projection.test.ts test/unit/server/session-directory/service.test.ts test/unit/server/session-search.test.ts test/unit/server/session-pagination.test.ts test/unit/server/sessions-sync/diff.test.ts test/unit/server/sessions-sync/service.test.ts test/integration/server/session-directory-router.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts test/unit/cli/commands.test.ts
git commit -m "refactor: cut session read model to lastActivityAt"
```

### Task 5: Cut the client/store/UI session contract to `lastActivityAt`

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

**Step 1: Update client session-domain types and response parsing**

In `src/store/types.ts` and `src/lib/api.ts`:

- rename session-domain `updatedAt` to `lastActivityAt`
- keep non-session `updatedAt` shapes alone
- rename `SearchResult.updatedAt` to `lastActivityAt`
- import `SessionDirectoryPageSchema` and the inferred response type from `@shared/read-models`
- remove the local duplicate `SessionDirectoryItemResponse`/`SessionDirectoryPageResponse` types
- parse the HTTP session-directory response with the shared schema before regrouping it

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

Update the legacy cursor encoder in `src/lib/api.ts` so it serializes `lastActivityAt` instead of `updatedAt`.

**Step 2: Switch store-level recency math**

Update `src/store/sessionsSlice.ts` and `src/store/sessionsThunks.ts` so project sorting, merge logic, pagination cursors, oldest-loaded calculations, and search-result regrouping all use `lastActivityAt`.

Keep generic state names like `oldestLoadedTimestamp` as-is; just feed them semantic session time.

**Step 3: Switch UI consumers**

Update these session-facing UI consumers to read `lastActivityAt`:

- `src/store/selectors/sidebarSelectors.ts` for sidebar timestamps/order
- `src/components/Sidebar.tsx` comments and comparator semantics where session timestamps are compared
- `src/components/HistoryView.tsx` for "last used" sorting and display
- `src/components/context-menu/ContextMenuProvider.tsx` for copied session metadata and confirmation UI

Do not rename tab or terminal timestamps in the same files.

**Step 4: Update client and jsdom e2e coverage**

Update the listed client tests so they build session fixtures with `lastActivityAt` and assert the renamed field is preserved end-to-end:

- API tests parse `lastActivityAt` from session-directory payloads
- store tests sort/merge/paginate by `lastActivityAt`
- selector tests build fixtures with `lastActivityAt`
- `App` and websocket bootstrap tests consume `lastActivityAt` session snapshots
- sidebar/history/context-menu tests render relative time from `lastActivityAt`
- jsdom e2e harnesses use the new payload shape

Do not add a fake visual-flash test here. The root cause is already pinned by provider/indexer/projection/sync coverage.

**Step 5: Run the focused client pack**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/api.test.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/sessionsSlice.pagination.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: PASS

**Step 6: Commit the client contract cutover**

Run:

```bash
git add src/store/types.ts src/store/sessionsSlice.ts src/store/sessionsThunks.ts src/store/selectors/sidebarSelectors.ts src/lib/api.ts src/components/Sidebar.tsx src/components/HistoryView.tsx src/components/context-menu/ContextMenuProvider.tsx test/unit/client/lib/api.test.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/sessionsSlice.pagination.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
git commit -m "refactor: cut session clients to lastActivityAt"
```

### Task 6: Sweep remaining fallout and run full verification

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
- Verify: coordinator state via `npm run test:status`

**Step 1: Sweep remaining session-domain `updatedAt` stragglers**

Run:

```bash
rg -n "\bupdatedAt\b" shared server src test
```

Convert only the remaining coding-session, session-directory, session-search, CLI, sidebar, history, and related test-fixture occurrences to `lastActivityAt`. Leave terminal metadata, codex activity records, tab registry records, device records, and generic non-session timestamps alone.

**Step 2: Run lint and typecheck**

Run:

```bash
npm run lint
npm run typecheck
```

Expected: PASS

**Step 3: Run the broad focused suites most likely to catch missed fixture fallout**

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

**Step 6: Commit the fully verified cut**

Run:

```bash
git add -A
git commit -m "refactor: land semantic session recency contract"
```

## Outcome checklist

Before considering the work complete, confirm all of the following are true:

- Touching a session file without changing semantic transcript events does not change `CodingCliSession.lastActivityAt`.
- `CodingCliSessionIndexer` does not emit a changed project update for touch-only churn.
- `SessionsSyncService` does not broadcast `sessions.changed` for touch-only churn.
- The session-directory route, cursor, search ordering, CLI output, and client API all expose `lastActivityAt`.
- Sidebar ordering, HistoryView ordering, and context-menu "Last used" all render from `lastActivityAt`.
- No coding-session or session-directory contract surface still exposes `updatedAt`.
- Terminal metadata and other non-session domains still use their own `updatedAt` fields unchanged.
