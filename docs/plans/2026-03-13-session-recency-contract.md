# Semantic Session Recency Contract Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Eliminate idle sidebar flashes by making session recency semantic and stable, so touch-only or housekeeping-only session-file writes do not reorder the sidebar or emit `sessions.changed`.

**Architecture:** Claude/Codex providers will derive `createdAt` and `lastActivityAt` from transcript events that represent user-visible session progress. The file indexer will keep filesystem `mtimeMs` and `size` private to its cache, preserve monotonic semantic clocks across append-only truncated reparses, and expose `lastActivityAt` across every session-domain contract surface. Session-directory invalidation stays projection-driven, so non-visible metadata churn cannot trigger websocket refreshes.

**Tech Stack:** Node.js, TypeScript, Express, React 18, Redux Toolkit, Zod, Vitest, Testing Library

---

## Strategy Gate

This is a contract bug with a rendering symptom. The sidebar flash happens because filesystem observation time currently leaks into session recency, which then drives session-directory ordering and websocket invalidation. A client-only suppression would leave the server contract wrong and would keep background refreshes tied to file noise.

Direct decisions:

- Rename session-domain recency from `updatedAt` to `lastActivityAt` everywhere session models, session-directory items, search results, pagination cursors, websocket invalidation inputs, and CLI output expose it.
- Do not introduce an alias window. The implementation sequence may be incremental, but the shipped contract must land directly on `lastActivityAt`.
- Keep non-session `updatedAt` fields untouched: terminal metadata, codex activity rows, tab/device records, and other unrelated domains stay as-is.
- Filesystem `mtimeMs` and `size` remain internal cache invalidation data in `CodingCliSessionIndexer`; they must never be copied onto `CodingCliSession`.
- Providers must derive semantic clocks from transcript events only. Housekeeping records such as Claude `file-history-snapshot` and Codex `token_count` / `turn_context` must not move `lastActivityAt`.
- For truncated head/tail reparses of an append-only file, semantic clocks must be monotonic for the same resolved session: `createdAt` may stay the same or move earlier, and `lastActivityAt` may stay the same or move later, but neither may regress because a truncated parse saw an incomplete subset.
- The invalidation boundary is the session-directory projection. If only projection-invisible fields change (`messageCount`, `tokenUsage`, `sourceFile`, raw cache stats, etc.), `SessionsSyncService` must not broadcast `sessions.changed`.
- Do not add a renderer-only “flash detector” test or an animation tweak. Fix the contract at the source.
- `docs/index.html` stays untouched. This is a correctness fix, not a product-surface change.

Provider semantic-clock policy:

- Claude semantic records: `system.init`, user messages, assistant messages with visible content, reasoning/thinking content, tool-use/tool-result content, and result/error completion records.
- Claude non-semantic records: `file-history-snapshot`, queue bookkeeping, and assistant payloads that contain usage only and no visible content.
- Codex semantic records: `session_meta`, `response_item` values `message`, `function_call`, `function_call_output`, and `event_msg` values `agent_reasoning`, `task_started`, `task_complete`, `turn_aborted`.
- Codex non-semantic records: `token_count`, `turn_context`, and metadata-only snapshots that do not represent visible session progress.

Rejected approaches:

- Silently redefining session-domain `updatedAt` and leaving the misleading name in place.
- Any client-only sidebar suppression while the server keeps emitting `mtime`-driven invalidations.
- Falling back to filesystem `mtime` for session recency when semantic timestamps are missing.
- A staged compatibility period where some session surfaces expose `updatedAt` and others expose `lastActivityAt`.

### Task 1: Claude Provider Semantic Clock

**Files:**
- Modify: `server/coding-cli/types.ts`
- Modify: `server/coding-cli/providers/claude.ts`
- Modify: `test/unit/server/coding-cli/claude-provider.test.ts`

**Step 1: Write the failing Claude tests**

Add these tests to `test/unit/server/coding-cli/claude-provider.test.ts`:

```ts
it('derives Claude createdAt and lastActivityAt from semantic transcript records', () => {
  const meta = parseSessionContent([
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'session-a',
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
      message: { role: 'assistant', usage: { input_tokens: 1, output_tokens: 2 } },
      timestamp: '2026-03-01T00:00:20.000Z',
    }),
    JSON.stringify({
      type: 'file-history-snapshot',
      messageId: 'abc123',
      snapshot: { timestamp: '2026-03-01T00:00:21.000Z' },
    }),
  ].join('\n'))

  expect(meta.lastActivityAt).toBe(Date.parse('2026-03-01T00:00:04.000Z'))
})
```

**Step 2: Run the focused Claude red test**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/coding-cli/claude-provider.test.ts
```

Expected: FAIL because `ParsedSessionMeta` and `parseSessionContent()` do not yet expose semantic clocks.

**Step 3: Implement the Claude semantic clock**

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

In `server/coding-cli/providers/claude.ts`, add timestamp parsing and semantic classification:

```ts
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

Implementation rules:

- Keep existing title/summary/usage extraction intact.
- Add an explicit `isClaudeSemanticRecord()` helper instead of scattering timestamp rules inline.
- `file-history-snapshot` must never move the semantic clock.
- Assistant payloads that contain usage only and no visible content must never move the semantic clock.
- Return `createdAt` and `lastActivityAt` from `parseSessionContent()`.

**Step 4: Run the focused Claude green test**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/coding-cli/claude-provider.test.ts
```

Expected: PASS

**Step 5: Commit the Claude semantic clock**

```bash
git add server/coding-cli/types.ts server/coding-cli/providers/claude.ts test/unit/server/coding-cli/claude-provider.test.ts
git commit -m "refactor: derive Claude semantic session clocks"
```

### Task 2: Codex Provider Semantic Clock

**Files:**
- Modify: `server/coding-cli/providers/codex.ts`
- Modify: `test/unit/server/coding-cli/codex-provider.test.ts`

**Step 1: Write the failing Codex tests**

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

**Step 2: Run the focused Codex red test**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/coding-cli/codex-provider.test.ts
```

Expected: FAIL because `parseCodexSessionContent()` does not yet derive semantic clocks.

**Step 3: Implement the Codex semantic clock**

In `server/coding-cli/providers/codex.ts`, add explicit allow-lists:

```ts
const SEMANTIC_CODEX_RESPONSE_TYPES = new Set(['message', 'function_call', 'function_call_output'])
const SEMANTIC_CODEX_EVENT_MSG_TYPES = new Set(['agent_reasoning', 'task_started', 'task_complete', 'turn_aborted'])
```

Implementation rules:

- `session_meta` is semantic and can establish both `createdAt` and `lastActivityAt`.
- `response_item` is semantic only for the allow-listed response types.
- `event_msg` is semantic only for the allow-listed event types.
- `token_count` and `turn_context` must never move the semantic clock.
- Keep existing token/task metadata extraction intact.

**Step 4: Run the focused Codex green test**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/coding-cli/codex-provider.test.ts
```

Expected: PASS

**Step 5: Commit the Codex semantic clock**

```bash
git add server/coding-cli/providers/codex.ts test/unit/server/coding-cli/codex-provider.test.ts
git commit -m "refactor: derive Codex semantic session clocks"
```

### Task 3: Core Session Model Rename and Monotonic Indexer Recency

**Files:**
- Modify: `server/coding-cli/types.ts`
- Modify: `server/coding-cli/providers/opencode.ts`
- Modify: `server/coding-cli/session-indexer.ts`
- Modify: `server/session-association-coordinator.ts`
- Modify: `server/coding-cli/codex-activity-tracker.ts`
- Modify: `server/index.ts`
- Modify: `test/unit/server/coding-cli/session-indexer.test.ts`
- Modify: `test/unit/server/coding-cli/opencode-provider.test.ts`
- Modify: `test/unit/server/coding-cli/codex-activity-tracker.test.ts`
- Modify: `test/unit/server/session-association-coordinator.test.ts`

**Step 1: Write the failing core-server tests**

Add these tests to `test/unit/server/coding-cli/session-indexer.test.ts`:

```ts
it('preserves semantic recency when a touched file reparses without semantic timestamps', async () => {
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

  await indexer.refresh()
  await fsp.utimes(file, new Date(10_000), new Date(10_000))
  ;(indexer as any).markDirty(file)
  await indexer.refresh()

  expect(indexer.getProjects()[0]?.sessions[0]?.lastActivityAt).toBe(200)
})

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

Also convert the session fixtures in:

- `test/unit/server/coding-cli/opencode-provider.test.ts`
- `test/unit/server/coding-cli/codex-activity-tracker.test.ts`
- `test/unit/server/session-association-coordinator.test.ts`

from session-domain `updatedAt` to `lastActivityAt`, keeping the behavioral assertions unchanged.

**Step 2: Run the focused core-server red pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/coding-cli/opencode-provider.test.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts test/unit/server/session-association-coordinator.test.ts
```

Expected: FAIL because the core session model still uses `updatedAt` and the indexer still copies `mtime`.

**Step 3: Implement the core rename and monotonic carry-forward**

In `server/coding-cli/types.ts`, rename the core session field:

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

In `server/coding-cli/session-indexer.ts`, keep file stats internal and clamp semantic time only when the same session reparses append-only:

```ts
const appendOnlyReparse = sameSession && size >= (cached?.size ?? 0)

const createdAt = appendOnlyReparse
  ? minDefined(previous?.createdAt, meta.createdAt)
  : (meta.createdAt ?? previous?.createdAt)

const lastActivityAt = appendOnlyReparse
  ? maxDefined(previous?.lastActivityAt, meta.lastActivityAt)
  : (meta.lastActivityAt ?? previous?.lastActivityAt ?? createdAt ?? 0)
```

Implementation rules:

- Never copy `mtimeMs` onto `CodingCliSession`.
- If the file shrank or the resolved session changed, do not clamp against the prior session.
- `providers/opencode.ts` must map the SQL `time_updated` column into `lastActivityAt`.
- `session-association-coordinator.ts`, `codex-activity-tracker.ts`, and `server/index.ts` must switch their session-domain comparisons/comments to `lastActivityAt`.
- Keep non-session `updatedAt` fields untouched.

**Step 4: Run the focused core-server green pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/coding-cli/opencode-provider.test.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts test/unit/server/session-association-coordinator.test.ts
```

Expected: PASS

**Step 5: Commit the core-server cutover**

```bash
git add server/coding-cli/types.ts server/coding-cli/providers/opencode.ts server/coding-cli/session-indexer.ts server/session-association-coordinator.ts server/coding-cli/codex-activity-tracker.ts server/index.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/coding-cli/opencode-provider.test.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts test/unit/server/session-association-coordinator.test.ts
git commit -m "refactor: make core session recency semantic"
```

### Task 4: Session Directory Projection and Invalidation Boundary

**Files:**
- Modify: `shared/read-models.ts`
- Modify: `server/session-directory/types.ts`
- Modify: `server/session-directory/projection.ts`
- Modify: `server/session-directory/service.ts`
- Modify: `test/unit/server/session-directory/projection.test.ts`
- Modify: `test/unit/server/session-directory/service.test.ts`
- Modify: `test/unit/server/sessions-sync/service.test.ts`
- Modify: `test/server/ws-sidebar-snapshot-refresh.test.ts`

**Step 1: Write the failing projection/invalidation tests**

Update `test/unit/server/session-directory/projection.test.ts` and `test/unit/server/session-directory/service.test.ts` so they assert:

- `toSessionDirectoryComparableItem()` exposes `lastActivityAt`
- projection equality ignores `messageCount`, `tokenUsage`, and `sourceFile`
- changing `lastActivityAt` is visible
- the encoded cursor payload is `{ lastActivityAt, key }`
- directory revision remains `max(session.lastActivityAt, terminalMeta.updatedAt)`

Update `test/unit/server/sessions-sync/service.test.ts` and `test/server/ws-sidebar-snapshot-refresh.test.ts` so a publish that only changes projection-invisible fields does not trigger a second `sessions.changed`.

Representative expectation:

```ts
svc.publish([createDetailedProject('/repo', {
  provider: 'codex',
  sessionId: 's1',
  projectPath: '/repo',
  lastActivityAt: 100,
  title: 'Deploy',
  messageCount: 1,
})])

svc.publish([createDetailedProject('/repo', {
  provider: 'codex',
  sessionId: 's1',
  projectPath: '/repo',
  lastActivityAt: 100,
  title: 'Deploy',
  messageCount: 99,
  tokenUsage: { inputTokens: 9, outputTokens: 9, cachedTokens: 9, totalTokens: 27 },
  sourceFile: '/tmp/other.jsonl',
})])

expect(ws.broadcastSessionsChanged).toHaveBeenCalledTimes(1)
```

**Step 2: Run the focused projection/invalidation red pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/session-directory/projection.test.ts test/unit/server/session-directory/service.test.ts test/unit/server/sessions-sync/service.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts
```

Expected: FAIL because the session-directory contract still uses `updatedAt`.

**Step 3: Implement the session-directory contract**

In `shared/read-models.ts`, add the shared page schema:

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
```

Implementation rules:

- `server/session-directory/types.ts` should alias from the shared schema instead of maintaining a duplicate shape.
- `projection.ts` must compare and sort on `lastActivityAt`.
- `service.ts` must decode/encode cursors using `{ lastActivityAt, key }`.
- Keep container names such as `revision` untouched; only the session field changes name.

**Step 4: Run the focused projection/invalidation green pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/session-directory/projection.test.ts test/unit/server/session-directory/service.test.ts test/unit/server/sessions-sync/service.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts
```

Expected: PASS

**Step 5: Commit the projection/invalidation cutover**

```bash
git add shared/read-models.ts server/session-directory/types.ts server/session-directory/projection.ts server/session-directory/service.ts test/unit/server/session-directory/projection.test.ts test/unit/server/session-directory/service.test.ts test/unit/server/sessions-sync/service.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts
git commit -m "refactor: cut session directory to lastActivityAt"
```

### Task 5: Server Search, Pagination, Router, CLI, and Diff Contract

**Files:**
- Modify: `server/session-pagination.ts`
- Modify: `server/session-search.ts`
- Modify: `server/sessions-sync/diff.ts`
- Modify: `server/sessions-router.ts`
- Modify: `server/cli/index.ts`
- Modify: `test/unit/server/session-pagination.test.ts`
- Modify: `test/unit/server/session-search.test.ts`
- Modify: `test/unit/server/sessions-sync/diff.test.ts`
- Modify: `test/integration/server/session-directory-router.test.ts`
- Modify: `test/unit/cli/commands.test.ts`
- Modify: `test/server/session-association.test.ts`
- Modify: `test/integration/server/codex-session-rebind-regression.test.ts`

**Step 1: Write the failing public-server contract tests**

Convert the session-domain fixtures and expectations in the listed tests from `updatedAt` to `lastActivityAt`.

Keep these assertions explicit:

- pagination sorts by `lastActivityAt` descending with the same tie-break rules
- search results expose `lastActivityAt`
- router responses and CLI output expose `lastActivityAt`
- diff tests still prove deterministic session comparison using the renamed field
- association and codex rebind regression tests still prove the same behavior after the rename

Representative assertion:

```ts
expect(results[0].lastActivityAt).toBeGreaterThanOrEqual(results[results.length - 1].lastActivityAt)
```

**Step 2: Run the focused public-server red pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/session-pagination.test.ts test/unit/server/session-search.test.ts test/unit/server/sessions-sync/diff.test.ts test/integration/server/session-directory-router.test.ts test/server/session-association.test.ts test/integration/server/codex-session-rebind-regression.test.ts
npm run test:vitest -- test/unit/cli/commands.test.ts
```

Expected: FAIL because the remaining server/public session contract still expects `updatedAt`.

**Step 3: Implement the public-server contract cutover**

In `server/session-search.ts`, rename the schema field:

```ts
export const SearchResultSchema = z.object({
  sessionId: z.string(),
  provider: z.string().min(1),
  projectPath: z.string(),
  matchedIn: z.enum(['title', 'userMessage', 'assistantMessage', 'summary']),
  lastActivityAt: z.number(),
  createdAt: z.number().optional(),
  archived: z.boolean().optional(),
  cwd: z.string().optional(),
})
```

Implementation rules:

- `session-pagination.ts` must compare and cursor on `lastActivityAt` while keeping container names like `oldestIncludedTimestamp`.
- `session-search.ts` must emit `lastActivityAt` in all search tiers and sort archived/non-archived results exactly as before.
- `sessions-router.ts` and `server/cli/index.ts` must expose `lastActivityAt`.
- `sessions-sync/diff.ts` must compare the renamed field without changing its “compare all enumerable fields” behavior.

**Step 4: Run the focused public-server green pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/session-pagination.test.ts test/unit/server/session-search.test.ts test/unit/server/sessions-sync/diff.test.ts test/integration/server/session-directory-router.test.ts test/server/session-association.test.ts test/integration/server/codex-session-rebind-regression.test.ts
npm run test:vitest -- test/unit/cli/commands.test.ts
```

Expected: PASS

**Step 5: Commit the public-server contract cutover**

```bash
git add server/session-pagination.ts server/session-search.ts server/sessions-sync/diff.ts server/sessions-router.ts server/cli/index.ts test/unit/server/session-pagination.test.ts test/unit/server/session-search.test.ts test/unit/server/sessions-sync/diff.test.ts test/integration/server/session-directory-router.test.ts test/unit/cli/commands.test.ts test/server/session-association.test.ts test/integration/server/codex-session-rebind-regression.test.ts
git commit -m "refactor: cut public session contracts to lastActivityAt"
```

### Task 6: Client API and Store Data Contract

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/store/sessionsSlice.ts`
- Modify: `src/store/sessionsThunks.ts`
- Modify: `test/unit/client/lib/api.test.ts`
- Modify: `test/unit/client/store/sessionsSlice.test.ts`
- Modify: `test/unit/client/store/sessionsThunks.test.ts`
- Modify: `test/unit/client/sessionsSlice.pagination.test.ts`

**Step 1: Write the failing client data-layer tests**

Convert the listed tests to expect `lastActivityAt` instead of session `updatedAt`.

Keep these assertions explicit:

- `fetchSidebarSessionsSnapshot()` groups sessions using `lastActivityAt`
- cursor JSON encodes `{ lastActivityAt, key }`
- merged project order still follows session recency
- pagination state still stores `oldestLoadedTimestamp`
- search results regroup from `lastActivityAt`

Representative expectation:

```ts
expect(response.projects[0]?.sessions[0]).toMatchObject({
  sessionId: 'session-1',
  lastActivityAt: 1_000,
})
```

**Step 2: Run the focused client data-layer red pack**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/api.test.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/sessionsSlice.pagination.test.ts
```

Expected: FAIL because the client data layer still expects `updatedAt`.

**Step 3: Implement the client data-layer cutover**

In `src/lib/api.ts`, delete the duplicate local session-directory response shape and parse the HTTP response with the shared schema from `@shared/read-models`.

Representative mapping:

```ts
const page = SessionDirectoryPageSchema.parse(await getSessionDirectoryPage(...))

const projects = groupDirectoryItemsAsProjects(page.items.map((item) => ({
  ...item,
  lastActivityAt: item.lastActivityAt,
})))
```

Implementation rules:

- `src/store/types.ts` must rename session-domain `updatedAt` to `lastActivityAt`.
- `src/lib/api.ts` must encode cursors with `lastActivityAt`.
- `src/lib/api.ts` search results must expose `lastActivityAt`.
- `sessionsSlice.ts` and `sessionsThunks.ts` must sort, merge, and regroup on `lastActivityAt`.
- Keep pagination container names such as `oldestLoadedTimestamp` unchanged.

**Step 4: Run the focused client data-layer green pack**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/api.test.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/sessionsSlice.pagination.test.ts
```

Expected: PASS

**Step 5: Commit the client data-layer cutover**

```bash
git add src/store/types.ts src/lib/api.ts src/store/sessionsSlice.ts src/store/sessionsThunks.ts test/unit/client/lib/api.test.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/sessionsSlice.pagination.test.ts
git commit -m "refactor: cut client session data to lastActivityAt"
```

### Task 7: Client Selectors and UI Session Contract

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

**Step 1: Write the failing client UI tests**

Convert the listed selector, unit, and e2e tests so session fixtures use `lastActivityAt` and still prove the same behavior.

Keep the assertions focused on existing behavior:

- sidebar ordering/search use semantic recency
- App websocket bootstrap handles the renamed session field
- HistoryView “Last used” data comes from `lastActivityAt`
- context-menu copied session metadata uses `lastActivityAt`
- no synthetic flash test is added

**Step 2: Run the focused client UI red pack**

Run:

```bash
npm run test:vitest -- test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/sidebar-busy-icon-flow.test.tsx
```

Expected: FAIL because the UI/session contract still expects `updatedAt`.

**Step 3: Implement the client UI cutover**

Implementation rules:

- `src/store/selectors/sidebarSelectors.ts` must build session timestamps from `session.lastActivityAt`.
- Leave fallback tab timestamps alone; they are not session-contract data.
- `src/components/HistoryView.tsx` must sort and display “Last used” from `lastActivityAt`.
- `src/components/context-menu/ContextMenuProvider.tsx` must use `lastActivityAt` for copied session metadata and `endDate`.
- `src/components/Sidebar.tsx` should only update naming/comments for the renamed session field; do not add render-only workarounds here.

**Step 4: Run the focused client UI green pack**

Run:

```bash
npm run test:vitest -- test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/sidebar-busy-icon-flow.test.tsx
```

Expected: PASS

**Step 5: Commit the client UI cutover**

```bash
git add src/store/selectors/sidebarSelectors.ts src/components/Sidebar.tsx src/components/HistoryView.tsx src/components/context-menu/ContextMenuProvider.tsx test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/sidebar-busy-icon-flow.test.tsx
git commit -m "refactor: cut client UI session recency to lastActivityAt"
```

### Task 8: Fallout Sweep and Full Verification

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
- Verify: `npm run test:status`

**Step 1: Sweep remaining session-domain stragglers**

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

**Step 3: Run the broad focused suites**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/coding-cli/claude-provider.test.ts test/unit/server/coding-cli/codex-provider.test.ts test/unit/server/coding-cli/opencode-provider.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts test/unit/server/session-association-coordinator.test.ts test/unit/server/session-directory/projection.test.ts test/unit/server/session-directory/service.test.ts test/unit/server/session-pagination.test.ts test/unit/server/session-search.test.ts test/unit/server/sessions-sync/diff.test.ts test/unit/server/sessions-sync/service.test.ts test/integration/server/session-directory-router.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts test/server/ws-handshake-snapshot.test.ts test/server/session-association.test.ts test/integration/server/codex-session-rebind-regression.test.ts test/unit/server/unified-rename.test.ts
npm run test:vitest -- test/unit/cli/commands.test.ts test/unit/client/lib/api.test.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/sessionsSlice.pagination.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/Sidebar.perf-audit.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/unit/client/components/MobileTabStrip.test.tsx test/unit/client/components/TabBar.test.tsx test/unit/client/components/TabSwitcher.test.tsx test/unit/client/components/component-edge-cases.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/store/state-edge-cases.test.ts test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/sidebar-busy-icon-flow.test.tsx
```

Expected: PASS

**Step 4: Check the coordinator and run the full suite**

Run:

```bash
npm run test:status
```

If another holder owns the broad-test gate, wait.

Then run:

```bash
FRESHELL_TEST_SUMMARY="semantic session recency contract" CI=true npm test
```

Expected: PASS

**Step 5: Commit the fully verified cut**

```bash
git add -A
git commit -m "refactor: land semantic session recency contract"
```

## Outcome Checklist

Before considering the work complete, confirm all of the following:

- Touching a session file without semantic transcript progress does not change `CodingCliSession.lastActivityAt`.
- Append-only reparses of the same file cannot move `lastActivityAt` backwards just because a truncated head/tail parse saw an incomplete semantic subset.
- `SessionsSyncService` does not broadcast `sessions.changed` when only projection-invisible session fields change.
- Session-directory routes, cursors, search results, pagination, and CLI output expose `lastActivityAt`.
- Sidebar ordering, HistoryView ordering, and context-menu “Last used” all render from `lastActivityAt`.
- No session-domain contract surface still exposes session `updatedAt`.
- Terminal metadata and other non-session domains still use their own `updatedAt` fields unchanged.
