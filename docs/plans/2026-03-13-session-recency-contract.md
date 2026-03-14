# Semantic Session Recency Contract Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Stop idle sidebar flashes by making session recency semantic and stable, so touch-only or housekeeping-only session-file writes do not broadcast `sessions.changed`, reorder the sidebar, or visibly refresh the left panel.

**Architecture:** File-backed providers derive `createdAt` and `lastActivityAt` from semantic transcript events, while filesystem observation data (`mtimeMs`, `size`) stays internal to the indexer cache only. The system cuts directly to `lastActivityAt` for every session-domain contract surface, and the indexer preserves monotonic semantic clocks across append-only reparses so truncated head/tail reads cannot regress recency.

**Tech Stack:** Node.js, TypeScript, Express, React 18, Redux Toolkit, Zod, Vitest, Testing Library

---

## Strategy Gate

This is a contract bug, not a rendering bug. The sidebar flashes because session file observation time leaks into the session-domain `updatedAt`, the server treats that as directory-visible state, and the client sorts on it by default. A client-only suppression would leave the server contract semantically wrong and would keep websocket invalidation, pagination, search ordering, and CLI output tied to filesystem noise.

Direct decisions:

- Rename session-domain recency from `updatedAt` to `lastActivityAt` everywhere a coding session, session-directory item, session-search result, or CLI session payload is represented.
- Keep unrelated `updatedAt` fields untouched: terminal metadata, codex activity rows, tab registry records, device records, and other non-session domains stay as-is.
- Land the end state directly in one cut. No dual `updatedAt`/`lastActivityAt` compatibility window.
- Keep filesystem `mtimeMs` and `size` internal to `CodingCliSessionIndexer` cache entries only. They may decide whether a file must be reparsed, but they must never be copied onto a `CodingCliSession`.
- The invalidation boundary that matters is `SessionsSyncService`: if only non-directory-visible session fields change, there must be no `sessions.changed` broadcast.
- Do not add renderer-only work or synthetic “flash detector” tests. Fix the contract at the source and prove the websocket invalidation stays quiet.
- `docs/index.html` stays untouched. This is a correctness fix, not a new feature.

Critical nuance from the actual codebase:

- Large file-backed sessions are parsed from a head/tail snippet in [`server/coding-cli/session-indexer.ts`](../../../server/coding-cli/session-indexer.ts), not always from the full file.
- Because of that, a naive semantic-clock parser can still regress `lastActivityAt` on append-only reparses if the newest semantic event falls outside the tail and only housekeeping records are newly appended.
- The indexer therefore must preserve monotonic semantic time for append-only reparses of the same session: `createdAt` may stay the same or move earlier, and `lastActivityAt` may stay the same or move later, but neither may move the wrong direction just because a truncated reparse saw an incomplete semantic subset.

Semantic-clock policy:

- Claude semantic records: `system.init`, user messages, assistant messages with visible content, tool-use/tool-result message content, reasoning/thinking content, and result/error completion records.
- Claude non-semantic records: `file-history-snapshot`, queue bookkeeping, and assistant payloads that contain usage only with no visible content.
- Codex semantic records: `session_meta`, `response_item` values `message`, `function_call`, `function_call_output`, and `event_msg` values `agent_reasoning`, `task_started`, `task_complete`, `turn_aborted`.
- Codex non-semantic records: `token_count`, `turn_context`, and metadata-only snapshots that do not represent visible session progress.

Rejected approaches:

- Keeping the session contract named `updatedAt` and silently redefining it.
- Any client-only sidebar suppression while the server continues to emit `mtime`-driven invalidations.
- Falling back to filesystem `mtime` when semantic timestamps are missing.
- A staged alias period where some code uses `updatedAt` and some code uses `lastActivityAt`.

### Task 1: Red-test provider semantic clocks

**Files:**
- Modify: `test/unit/server/coding-cli/claude-provider.test.ts`
- Modify: `test/unit/server/coding-cli/codex-provider.test.ts`

**Step 1: Add Claude red tests**

Add these tests to `test/unit/server/coding-cli/claude-provider.test.ts`:

```ts
it('derives Claude createdAt and lastActivityAt from semantic transcript records', () => {
  const meta = parseSessionContent([
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: SESSION_A,
      cwd: '/repo',
      timestamp: '2026-03-01T00:00:00.000Z',
    }),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Ship it' },
      timestamp: '2026-03-01T00:00:03.000Z',
    }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'On it' }] },
      timestamp: '2026-03-01T00:00:05.000Z',
    }),
  ].join('\n'))

  expect(meta.createdAt).toBe(Date.parse('2026-03-01T00:00:00.000Z'))
  expect(meta.lastActivityAt).toBe(Date.parse('2026-03-01T00:00:05.000Z'))
})

it('ignores Claude housekeeping-only records when deriving lastActivityAt', () => {
  const meta = parseSessionContent([
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Keep this timestamp' },
      timestamp: '2026-03-01T00:00:04.000Z',
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        usage: { input_tokens: 1, output_tokens: 2 },
      },
      timestamp: '2026-03-01T00:00:20.000Z',
    }),
    JSON.stringify({
      type: 'file-history-snapshot',
      messageId: 'abc123',
      snapshot: {
        messageId: 'abc123',
        trackedFileBackups: {},
        timestamp: '2026-03-01T00:00:21.000Z',
      },
      isSnapshotUpdate: false,
    }),
  ].join('\n'))

  expect(meta.lastActivityAt).toBe(Date.parse('2026-03-01T00:00:04.000Z'))
})
```

**Step 2: Add Codex red tests**

Add these tests to `test/unit/server/coding-cli/codex-provider.test.ts`:

```ts
it('derives Codex createdAt and lastActivityAt from semantic events', () => {
  const meta = parseCodexSessionContent([
    JSON.stringify({
      timestamp: '2026-03-01T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'session-activity', cwd: '/project/codex' },
    }),
    JSON.stringify({
      timestamp: '2026-03-01T00:00:04.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Visible reply' }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-03-01T00:00:06.000Z',
      type: 'event_msg',
      payload: { type: 'turn_aborted' },
    }),
  ].join('\n'))

  expect(meta.createdAt).toBe(Date.parse('2026-03-01T00:00:00.000Z'))
  expect(meta.lastActivityAt).toBe(Date.parse('2026-03-01T00:00:06.000Z'))
})

it('ignores token_count and turn_context when deriving Codex lastActivityAt', () => {
  const meta = parseCodexSessionContent([
    JSON.stringify({
      timestamp: '2026-03-01T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'session-1', cwd: '/repo' },
    }),
    JSON.stringify({
      timestamp: '2026-03-01T00:00:04.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Visible reply' }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-03-01T00:00:20.000Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_usage_tokens: 999 } },
    }),
    JSON.stringify({
      timestamp: '2026-03-01T00:00:21.000Z',
      type: 'turn_context',
      payload: { cwd: '/repo' },
    }),
  ].join('\n'))

  expect(meta.lastActivityAt).toBe(Date.parse('2026-03-01T00:00:04.000Z'))
})
```

**Step 3: Run the focused provider red pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/coding-cli/claude-provider.test.ts test/unit/server/coding-cli/codex-provider.test.ts
```

Expected: FAIL because provider parsers do not yet expose `createdAt` and `lastActivityAt`.

**Step 4: Commit the red tests**

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

In `server/coding-cli/types.ts`, extend `ParsedSessionMeta`:

```ts
export interface ParsedSessionMeta {
  sessionId?: string
  cwd?: string
  createdAt?: number
  lastActivityAt?: number
  // existing fields stay intact
}
```

**Step 2: Implement the Claude semantic clock**

In `server/coding-cli/providers/claude.ts`, add explicit timestamp helpers and semantic classification:

```ts
function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function recordSemanticClock(
  clock: { createdAt?: number; lastActivityAt?: number },
  value: unknown,
): void {
  const at = parseTimestampMs(value)
  if (at === undefined) return
  clock.createdAt = clock.createdAt === undefined ? at : Math.min(clock.createdAt, at)
  clock.lastActivityAt = clock.lastActivityAt === undefined ? at : Math.max(clock.lastActivityAt, at)
}
```

Rules:

- Use an explicit `isClaudeSemanticRecord(obj: any): boolean`.
- `file-history-snapshot` must never move the semantic clock.
- Assistant records that contain usage only and no visible content must never move the semantic clock.
- Keep all existing metadata extraction behavior intact.

**Step 3: Implement the Codex semantic clock**

In `server/coding-cli/providers/codex.ts`, add `createdAt` and `lastActivityAt` using explicit allow-lists:

```ts
const SEMANTIC_CODEX_RESPONSE_TYPES = new Set(['message', 'function_call', 'function_call_output'])
const SEMANTIC_CODEX_EVENT_MSG_TYPES = new Set(['agent_reasoning', 'task_started', 'task_complete', 'turn_aborted'])
```

Rules:

- `session_meta` is semantic.
- `response_item` is semantic only for the explicit response types above.
- `event_msg` is semantic only for the explicit event types above.
- `token_count` and `turn_context` must never move the semantic clock.

**Step 4: Run the focused provider pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/coding-cli/claude-provider.test.ts test/unit/server/coding-cli/codex-provider.test.ts
```

Expected: PASS

**Step 5: Commit the provider implementation**

```bash
git add server/coding-cli/types.ts server/coding-cli/providers/claude.ts server/coding-cli/providers/codex.ts test/unit/server/coding-cli/claude-provider.test.ts test/unit/server/coding-cli/codex-provider.test.ts
git commit -m "refactor: derive semantic provider session clocks"
```

### Task 3: Red-test monotonic file-backed recency and invalidation suppression

**Files:**
- Modify: `test/unit/server/coding-cli/session-indexer.test.ts`
- Modify: `test/unit/server/sessions-sync/service.test.ts`
- Modify: `test/server/ws-sidebar-snapshot-refresh.test.ts`

**Step 1: Add the mtime-only carry-forward red test**

Add this test to `test/unit/server/coding-cli/session-indexer.test.ts`:

```ts
it('preserves semantic recency when a file is touched but the reparse yields no semantic timestamps', async () => {
  const file = path.join(tempDir, 'session-a.jsonl')
  await fsp.writeFile(file, JSON.stringify({ cwd: '/repo', title: 'Deploy' }) + '\n')

  const parseSessionFile = vi.fn()
    .mockResolvedValueOnce({
      cwd: '/repo',
      sessionId: 'session-a',
      title: 'Deploy',
      createdAt: 100,
      lastActivityAt: 200,
      messageCount: 1,
    })
    .mockResolvedValueOnce({
      cwd: '/repo',
      sessionId: 'session-a',
      title: 'Deploy',
      messageCount: 1,
    })

  const provider = makeProvider([file], { parseSessionFile })
  const indexer = new CodingCliSessionIndexer([provider])
  const onUpdate = vi.fn()
  indexer.onUpdate(onUpdate)

  await indexer.refresh()
  await fsp.utimes(file, new Date(10_000), new Date(10_000))
  ;(indexer as any).markDirty(file)
  await indexer.refresh()

  expect(indexer.getProjects()[0]?.sessions[0]?.lastActivityAt).toBe(200)
  expect(onUpdate).toHaveBeenCalledTimes(1)
})
```

**Step 2: Add the truncated-reparse monotonicity red test**

Add this test to `test/unit/server/coding-cli/session-indexer.test.ts`:

```ts
it('does not let append-only reparses move lastActivityAt backwards', async () => {
  const file = path.join(tempDir, 'session-b.jsonl')
  await fsp.writeFile(file, JSON.stringify({ cwd: '/repo', title: 'Deploy' }) + '\n')

  const parseSessionFile = vi.fn()
    .mockResolvedValueOnce({
      cwd: '/repo',
      sessionId: 'session-b',
      title: 'Deploy',
      createdAt: 100,
      lastActivityAt: 900,
      messageCount: 10,
    })
    .mockResolvedValueOnce({
      cwd: '/repo',
      sessionId: 'session-b',
      title: 'Deploy',
      createdAt: 100,
      lastActivityAt: 300,
      messageCount: 11,
    })

  const provider = makeProvider([file], { parseSessionFile })
  const indexer = new CodingCliSessionIndexer([provider])

  await indexer.refresh()
  await fsp.appendFile(file, JSON.stringify({ type: 'file-history-snapshot', snapshot: {} }) + '\n')
  ;(indexer as any).markDirty(file)
  await indexer.refresh()

  expect(indexer.getProjects()[0]?.sessions[0]?.lastActivityAt).toBe(900)
})
```

This test is required because the real indexer reparses head/tail snippets for large files, so “reparse succeeded” is not enough to trust a regressed timestamp.

**Step 3: Add invalidation-boundary red tests**

Update `test/unit/server/sessions-sync/service.test.ts` and `test/server/ws-sidebar-snapshot-refresh.test.ts` so they prove stable semantic recency does not broadcast:

```ts
svc.publish([
  createDetailedProject('/repo', {
    provider: 'codex',
    sessionId: 's1',
    projectPath: '/repo',
    lastActivityAt: 100,
    title: 'Deploy',
    messageCount: 1,
  }),
])
svc.publish([
  createDetailedProject('/repo', {
    provider: 'codex',
    sessionId: 's1',
    projectPath: '/repo',
    lastActivityAt: 100,
    title: 'Deploy',
    messageCount: 99,
    tokenUsage: {
      inputTokens: 9,
      outputTokens: 9,
      cachedTokens: 9,
      totalTokens: 27,
    },
    sourceFile: '/tmp/other.jsonl',
  }),
])

expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(1)
```

In the websocket test, drive the second publish through a real `SessionsSyncService` instance wired to the test `WsHandler`, then assert no second `sessions.changed` message arrives.

**Step 4: Run the focused server red pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/sessions-sync/service.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts
```

Expected: FAIL because the indexer still copies `mtime` into session recency and the session-domain contract still uses `updatedAt`.

**Step 5: Commit the red tests**

```bash
git add test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/sessions-sync/service.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts
git commit -m "test: lock monotonic session recency boundary"
```

### Task 4: Implement monotonic file-backed recency and the core session type rename

**Files:**
- Modify: `server/coding-cli/types.ts`
- Modify: `server/coding-cli/providers/opencode.ts`
- Modify: `server/coding-cli/session-indexer.ts`
- Modify: `server/session-association-coordinator.ts`
- Modify: `server/coding-cli/codex-activity-tracker.ts`
- Modify: `server/index.ts`
- Modify: `test/unit/server/coding-cli/session-indexer.test.ts`
- Modify: `test/unit/server/sessions-sync/service.test.ts`
- Modify: `test/server/ws-sidebar-snapshot-refresh.test.ts`

**Step 1: Rename the core session field**

In `server/coding-cli/types.ts`, rename `CodingCliSession.updatedAt` to `CodingCliSession.lastActivityAt`:

```ts
export interface CodingCliSession {
  provider: CodingCliProviderName
  sessionId: string
  projectPath: string
  lastActivityAt: number
  createdAt?: number
  // existing fields unchanged
}
```

Also update direct-list sessions in `server/coding-cli/providers/opencode.ts` to map the SQL `time_updated` column into `lastActivityAt`.

**Step 2: Implement monotonic carry-forward in the indexer**

In `server/coding-cli/session-indexer.ts`, change `updateCacheEntry()` so file stats stay internal and semantic time is monotonic for append-only reparses of the same session:

```ts
const previous = cached?.baseSession
const sameSession = previous?.provider === provider.name && previous?.sessionId === sessionId
const appendOnlyReparse = sameSession && size >= (cached?.size ?? 0)

const createdAt = appendOnlyReparse
  ? minDefined(previous?.createdAt, meta.createdAt)
  : (meta.createdAt ?? previous?.createdAt)

const lastActivityAt = appendOnlyReparse
  ? maxDefined(previous?.lastActivityAt, meta.lastActivityAt)
  : (meta.lastActivityAt ?? previous?.lastActivityAt ?? createdAt ?? 0)
```

Rules:

- Never copy `mtimeMs` onto `baseSession`.
- If the file shrank or the resolved session ID changed, do not clamp with the prior session.
- Session sorting, project sorting, and new-session callbacks must now use `lastActivityAt`.

**Step 3: Cut core server consumers over to `lastActivityAt`**

Update:

- `server/session-association-coordinator.ts`
- `server/coding-cli/codex-activity-tracker.ts`
- `server/index.ts`

Rules:

- association watermarks and age comparisons use `lastActivityAt`
- codex tracker state like `lastSeenSessionUpdatedAt` is renamed to `lastSeenSessionActivityAt`
- comments and helper names must use “activity” language, not “updated” language

**Step 4: Run the focused green pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/sessions-sync/service.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts test/unit/server/coding-cli/opencode-provider.test.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts test/unit/server/session-association-coordinator.test.ts
```

Expected: PASS

**Step 5: Commit the implementation**

```bash
git add server/coding-cli/types.ts server/coding-cli/providers/opencode.ts server/coding-cli/session-indexer.ts server/session-association-coordinator.ts server/coding-cli/codex-activity-tracker.ts server/index.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/sessions-sync/service.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts test/unit/server/coding-cli/opencode-provider.test.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts test/unit/server/session-association-coordinator.test.ts
git commit -m "refactor: make file-backed session recency semantic"
```

### Task 5: Red-test the server/public contract cutover

**Files:**
- Modify: `test/unit/server/session-directory/projection.test.ts`
- Modify: `test/unit/server/session-directory/service.test.ts`
- Modify: `test/unit/server/session-pagination.test.ts`
- Modify: `test/unit/server/session-search.test.ts`
- Modify: `test/unit/server/sessions-sync/diff.test.ts`
- Modify: `test/integration/server/session-directory-router.test.ts`
- Modify: `test/unit/cli/commands.test.ts`
- Modify: `test/server/session-association.test.ts`
- Modify: `test/integration/server/codex-session-rebind-regression.test.ts`

**Step 1: Convert projection and directory tests to `lastActivityAt`**

Update `test/unit/server/session-directory/projection.test.ts` and `test/unit/server/session-directory/service.test.ts` so they assert:

- `toSessionDirectoryComparableItem()` exposes `lastActivityAt`
- `messageCount`, `tokenUsage`, and `sourceFile` are invisible to the directory projection
- changing `lastActivityAt` is visible
- cursor payloads serialize `{ lastActivityAt, key }`
- directory revision remains `max(session.lastActivityAt, terminalMeta.updatedAt)`

**Step 2: Convert pagination/search/CLI contract tests**

Update these tests to expect `lastActivityAt` instead of session `updatedAt`:

- `test/unit/server/session-pagination.test.ts`
- `test/unit/server/session-search.test.ts`
- `test/integration/server/session-directory-router.test.ts`
- `test/unit/cli/commands.test.ts`

Representative expectation:

```ts
expect(results[0].lastActivityAt).toBeGreaterThanOrEqual(results[results.length - 1].lastActivityAt)
```

**Step 3: Convert association and diff tests**

Update these tests so fixtures use `lastActivityAt` and still prove the same behavior:

- `test/unit/server/sessions-sync/diff.test.ts`
- `test/server/session-association.test.ts`
- `test/integration/server/codex-session-rebind-regression.test.ts`

**Step 4: Run the focused server red pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/session-directory/projection.test.ts test/unit/server/session-directory/service.test.ts test/unit/server/session-pagination.test.ts test/unit/server/session-search.test.ts test/unit/server/sessions-sync/diff.test.ts test/integration/server/session-directory-router.test.ts test/server/session-association.test.ts test/integration/server/codex-session-rebind-regression.test.ts
npm run test:vitest -- test/unit/cli/commands.test.ts
```

Expected: FAIL because the public server/session contract still uses `updatedAt`.

**Step 5: Commit the red tests**

```bash
git add test/unit/server/session-directory/projection.test.ts test/unit/server/session-directory/service.test.ts test/unit/server/session-pagination.test.ts test/unit/server/session-search.test.ts test/unit/server/sessions-sync/diff.test.ts test/integration/server/session-directory-router.test.ts test/unit/cli/commands.test.ts test/server/session-association.test.ts test/integration/server/codex-session-rebind-regression.test.ts
git commit -m "test: lock server session lastActivityAt contract"
```

### Task 6: Implement the server/public contract cutover

**Files:**
- Modify: `shared/read-models.ts`
- Modify: `server/session-directory/types.ts`
- Modify: `server/session-directory/projection.ts`
- Modify: `server/session-directory/service.ts`
- Modify: `server/session-pagination.ts`
- Modify: `server/session-search.ts`
- Modify: `server/sessions-sync/diff.ts`
- Modify: `server/sessions-router.ts`
- Modify: `server/cli/index.ts`
- Modify: `test/unit/server/session-directory/projection.test.ts`
- Modify: `test/unit/server/session-directory/service.test.ts`
- Modify: `test/unit/server/session-pagination.test.ts`
- Modify: `test/unit/server/session-search.test.ts`
- Modify: `test/unit/server/sessions-sync/diff.test.ts`
- Modify: `test/integration/server/session-directory-router.test.ts`
- Modify: `test/unit/cli/commands.test.ts`
- Modify: `test/server/session-association.test.ts`
- Modify: `test/integration/server/codex-session-rebind-regression.test.ts`

**Step 1: Define the shared session-directory schemas**

Add these schemas to `shared/read-models.ts`:

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

In `server/session-directory/types.ts`, alias the server types from these shared schemas rather than keeping a second local shape.

**Step 2: Switch server read models and cursors to `lastActivityAt`**

Update:

- `server/session-directory/projection.ts`
- `server/session-directory/service.ts`
- `server/session-pagination.ts`
- `server/session-search.ts`
- `server/sessions-router.ts`
- `server/cli/index.ts`

Rules:

- directory comparators use `lastActivityAt`
- session-directory cursor payloads encode `{ lastActivityAt, key }`
- pagination cursors and search results sort on `lastActivityAt`
- CLI output exposes `lastActivityAt`
- keep container names like `before`, `oldestIncludedTimestamp`, and `oldestLoadedTimestamp`; only the session field itself is renamed

**Step 3: Sweep strict diff consumers**

Update `server/sessions-sync/diff.ts` and any compile fallout so session-domain helpers speak `lastActivityAt` consistently while terminal/domain `updatedAt` fields remain untouched.

**Step 4: Run the focused green pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/session-directory/projection.test.ts test/unit/server/session-directory/service.test.ts test/unit/server/session-pagination.test.ts test/unit/server/session-search.test.ts test/unit/server/sessions-sync/diff.test.ts test/integration/server/session-directory-router.test.ts test/server/session-association.test.ts test/integration/server/codex-session-rebind-regression.test.ts
npm run test:vitest -- test/unit/cli/commands.test.ts
```

Expected: PASS

**Step 5: Commit the server contract cutover**

```bash
git add shared/read-models.ts server/session-directory/types.ts server/session-directory/projection.ts server/session-directory/service.ts server/session-pagination.ts server/session-search.ts server/sessions-sync/diff.ts server/sessions-router.ts server/cli/index.ts test/unit/server/session-directory/projection.test.ts test/unit/server/session-directory/service.test.ts test/unit/server/session-pagination.test.ts test/unit/server/session-search.test.ts test/unit/server/sessions-sync/diff.test.ts test/integration/server/session-directory-router.test.ts test/unit/cli/commands.test.ts test/server/session-association.test.ts test/integration/server/codex-session-rebind-regression.test.ts
git commit -m "refactor: cut server session contracts to lastActivityAt"
```

### Task 7: Red-test the client data-layer contract cutover

**Files:**
- Modify: `test/unit/client/lib/api.test.ts`
- Modify: `test/unit/client/store/sessionsSlice.test.ts`
- Modify: `test/unit/client/store/sessionsThunks.test.ts`
- Modify: `test/unit/client/sessionsSlice.pagination.test.ts`

**Step 1: Convert API red tests to `lastActivityAt`**

Update `test/unit/client/lib/api.test.ts` so session-directory payloads and mapped search results use `lastActivityAt`, and the encoded cursor JSON contains `lastActivityAt`.

Representative expectation:

```ts
expect(response.projects[0]?.sessions[0]).toMatchObject({
  sessionId: 'session-1',
  lastActivityAt: 1_000,
})
```

**Step 2: Convert store red tests to `lastActivityAt`**

Update:

- `test/unit/client/store/sessionsSlice.test.ts`
- `test/unit/client/store/sessionsThunks.test.ts`
- `test/unit/client/sessionsSlice.pagination.test.ts`

Assertions to keep:

- project merge order uses semantic recency
- pagination state still stores `oldestLoadedTimestamp`
- search results regroup from `lastActivityAt`

**Step 3: Run the focused client red pack**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/api.test.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/sessionsSlice.pagination.test.ts
```

Expected: FAIL because the client data layer still expects `updatedAt`.

**Step 4: Commit the red tests**

```bash
git add test/unit/client/lib/api.test.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/sessionsSlice.pagination.test.ts
git commit -m "test: lock client data session activity contract"
```

### Task 8: Implement the client data-layer contract cutover

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/store/sessionsSlice.ts`
- Modify: `src/store/sessionsThunks.ts`
- Modify: `test/unit/client/lib/api.test.ts`
- Modify: `test/unit/client/store/sessionsSlice.test.ts`
- Modify: `test/unit/client/store/sessionsThunks.test.ts`
- Modify: `test/unit/client/sessionsSlice.pagination.test.ts`

**Step 1: Rename the client session types**

In `src/store/types.ts`, rename session-domain `updatedAt` to `lastActivityAt`:

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

**Step 2: Parse the shared server schema in the client API**

In `src/lib/api.ts`:

- import `SessionDirectoryPageSchema` from `@shared/read-models`
- delete local duplicate `SessionDirectoryItemResponse` and `SessionDirectoryPageResponse` shapes
- parse the HTTP response with the shared schema before regrouping it
- encode the cursor JSON with `lastActivityAt`
- rename client `SearchResult.updatedAt` to `SearchResult.lastActivityAt`

**Step 3: Update store sorting and regrouping**

In `src/store/sessionsSlice.ts` and `src/store/sessionsThunks.ts`, switch all session-domain sorting, merging, search regrouping, and pagination math to `lastActivityAt`. Keep pagination container names unchanged.

**Step 4: Run the focused client green pack**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/api.test.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/sessionsSlice.pagination.test.ts
```

Expected: PASS

**Step 5: Commit the data-layer implementation**

```bash
git add src/store/types.ts src/lib/api.ts src/store/sessionsSlice.ts src/store/sessionsThunks.ts test/unit/client/lib/api.test.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/sessionsSlice.pagination.test.ts
git commit -m "refactor: cut client data sessions to lastActivityAt"
```

### Task 9: Red-test the client UI/session contract cutover

**Files:**
- Modify: `test/unit/client/store/selectors/sidebarSelectors.test.ts`
- Modify: `test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts`
- Modify: `test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts`
- Modify: `test/unit/client/components/App.test.tsx`
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx`
- Modify: `test/unit/client/components/Sidebar.test.tsx`
- Modify: `test/unit/client/components/ContextMenuProvider.test.tsx`
- Modify: `test/unit/client/components/HistoryView.mobile.test.tsx`
- Modify: `test/unit/client/components/HistoryView.a11y.test.tsx`
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`
- Modify: `test/e2e/sidebar-click-opens-pane.test.tsx`
- Modify: `test/e2e/sidebar-busy-icon-flow.test.tsx`

**Step 1: Convert selector red tests**

Update the sidebar selector tests so session fixtures use `lastActivityAt` and still prove the same order/filter behavior.

**Step 2: Convert UI and e2e red tests**

Update these tests so their session fixtures and expectations use `lastActivityAt`:

- `test/unit/client/components/App.test.tsx`
- `test/unit/client/components/App.ws-bootstrap.test.tsx`
- `test/unit/client/components/Sidebar.test.tsx`
- `test/unit/client/components/ContextMenuProvider.test.tsx`
- `test/unit/client/components/HistoryView.mobile.test.tsx`
- `test/unit/client/components/HistoryView.a11y.test.tsx`
- `test/e2e/open-tab-session-sidebar-visibility.test.tsx`
- `test/e2e/sidebar-click-opens-pane.test.tsx`
- `test/e2e/sidebar-busy-icon-flow.test.tsx`

Keep the assertions focused on existing behavior. Do not add a synthetic sidebar flash test.

**Step 3: Run the focused UI red pack**

Run:

```bash
npm run test:vitest -- test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/sidebar-busy-icon-flow.test.tsx
```

Expected: FAIL because the UI/session contract still expects `updatedAt`.

**Step 4: Commit the red tests**

```bash
git add test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/sidebar-busy-icon-flow.test.tsx
git commit -m "test: lock client UI session activity contract"
```

### Task 10: Implement the client UI/session contract cutover

**Files:**
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/HistoryView.tsx`
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `test/unit/client/store/selectors/sidebarSelectors.test.ts`
- Modify: `test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts`
- Modify: `test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts`
- Modify: `test/unit/client/components/App.test.tsx`
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx`
- Modify: `test/unit/client/components/Sidebar.test.tsx`
- Modify: `test/unit/client/components/ContextMenuProvider.test.tsx`
- Modify: `test/unit/client/components/HistoryView.mobile.test.tsx`
- Modify: `test/unit/client/components/HistoryView.a11y.test.tsx`
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`
- Modify: `test/e2e/sidebar-click-opens-pane.test.tsx`
- Modify: `test/e2e/sidebar-busy-icon-flow.test.tsx`

**Step 1: Switch selector/session timestamp usage**

In `src/store/selectors/sidebarSelectors.ts`, build sidebar item timestamps from `session.lastActivityAt`. Leave fallback tab timestamps alone; they are not session-contract data.

**Step 2: Switch UI consumers**

Update:

- `src/components/HistoryView.tsx`
- `src/components/context-menu/ContextMenuProvider.tsx`
- `src/components/Sidebar.tsx`

Rules:

- history sort and “last used” display use `lastActivityAt`
- context-menu copied session metadata and `endDate` use `lastActivityAt`
- Sidebar comments and any session-domain references use `lastActivityAt`

**Step 3: Run the focused UI green pack**

Run:

```bash
npm run test:vitest -- test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/sidebar-busy-icon-flow.test.tsx
```

Expected: PASS

**Step 4: Commit the UI implementation**

```bash
git add src/store/selectors/sidebarSelectors.ts src/components/Sidebar.tsx src/components/HistoryView.tsx src/components/context-menu/ContextMenuProvider.tsx test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/sidebar-busy-icon-flow.test.tsx
git commit -m "refactor: cut client UI sessions to lastActivityAt"
```

### Task 11: Sweep fallout and run full verification

**Files:**
- Modify: `test/unit/client/components/MobileTabStrip.test.tsx`
- Modify: `test/unit/client/components/Sidebar.mobile.test.tsx`
- Modify: `test/unit/client/components/Sidebar.perf-audit.test.tsx`
- Modify: `test/unit/client/components/TabBar.test.tsx`
- Modify: `test/unit/client/components/TabSwitcher.test.tsx`
- Modify: `test/unit/client/components/component-edge-cases.test.tsx`
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx`
- Modify: `test/unit/client/components/settings-view-test-utils.tsx`
- Modify: `test/unit/client/store/state-edge-cases.test.ts`
- Modify: `test/server/ws-handshake-snapshot.test.ts`
- Modify: `test/unit/server/unified-rename.test.ts`
- Modify: `scripts/measure-bandwidth.ts`
- Verify: coordinator status via `npm run test:status`

**Step 1: Sweep remaining session-domain `updatedAt` stragglers**

Run:

```bash
rg -n "\bupdatedAt\b" shared server src test scripts
```

Convert only remaining session-domain occurrences to `lastActivityAt`. Leave non-session domains untouched, especially:

- terminal metadata
- codex activity rows
- tab registry records
- device records
- terminal cursors

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
npm run test:vitest -- test/unit/cli/commands.test.ts test/unit/client/lib/api.test.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/sessionsSlice.pagination.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/Sidebar.perf-audit.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/unit/client/components/MobileTabStrip.test.tsx test/unit/client/components/TabBar.test.tsx test/unit/client/components/TabSwitcher.test.tsx test/unit/client/components/component-edge-cases.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/store/state-edge-cases.test.ts test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/sidebar-busy-icon-flow.test.tsx
```

Expected: PASS

**Step 4: Check coordinator status before the broad repo run**

Run:

```bash
npm run test:status
```

If another holder owns the gate, wait. Do not force a broad run.

**Step 5: Run the full coordinated suite**

Run:

```bash
FRESHELL_TEST_SUMMARY="semantic session recency contract" CI=true npm test
```

Expected: PASS

**Step 6: Commit the fully verified cut**

```bash
git add -A
git commit -m "refactor: land semantic session recency contract"
```

## Outcome checklist

Before considering the work complete, confirm all of the following:

- Touching a session file without semantic transcript progress does not change `CodingCliSession.lastActivityAt`.
- Append-only reparses of the same session cannot move `lastActivityAt` backwards just because a truncated head/tail parse saw an incomplete semantic subset.
- `SessionsSyncService` does not broadcast `sessions.changed` when only non-directory-visible session fields changed.
- Session-directory routes, cursors, search results, and CLI output expose `lastActivityAt`.
- Sidebar ordering, HistoryView ordering, and context-menu “Last used” all render from `lastActivityAt`.
- No session-domain contract surface still exposes session `updatedAt`.
- Terminal metadata and other non-session domains still use their own `updatedAt` fields unchanged.
