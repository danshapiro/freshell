# Semantic Session Recency Contract Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Eliminate idle sidebar flashes by making session recency semantic and stable, so touch-only or housekeeping-only session-file writes do not reorder the sidebar or emit `sessions.changed`.

**Architecture:** Providers will derive `createdAt` and `lastActivityAt` from transcript events that represent user-visible session progress. The session indexer will keep filesystem `mtimeMs` and `size` private to cache invalidation, carry semantic clocks forward monotonically across append-only reparses, and expose `lastActivityAt` across every session-domain contract surface. Session-directory invalidation will stay projection-driven, so projection-invisible metadata churn cannot trigger websocket refreshes.

**Tech Stack:** Node.js, TypeScript, Express, React 18, Redux Toolkit, Zod, Vitest, Testing Library

---

## Strategy Gate

This is a contract bug with a rendering symptom. The sidebar flashes because session file observation time currently leaks into session recency, which then drives session-directory ordering and websocket invalidation. Fixing the renderer would only hide bad data while the server keeps publishing false recency changes.

Decisions for this plan:

- Rename session-domain recency from `updatedAt` to `lastActivityAt` everywhere session contracts are exposed.
- Do not ship an alias window. The branch can evolve incrementally, but the landed contract is `lastActivityAt`.
- Keep non-session `updatedAt` fields untouched: terminal metadata, codex activity records, tab registry entries, device records, and other unrelated domains remain as-is.
- Filesystem `mtimeMs` and `size` stay internal to `CodingCliSessionIndexer`; they must never be copied onto `CodingCliSession`.
- Providers must derive semantic clocks from transcript events only. Housekeeping records such as Claude `file-history-snapshot` and Codex `token_count` / `turn_context` must not move `lastActivityAt`.
- For truncated append-only reparses of the same resolved session, semantic clocks must be monotonic: `createdAt` may stay the same or move earlier, and `lastActivityAt` may stay the same or move later, but neither may regress because a truncated parse saw an incomplete subset.
- The invalidation boundary is the session-directory projection. If only projection-invisible fields change, `SessionsSyncService` must not broadcast `sessions.changed`.
- Do not add a renderer-only “flash detector” test or an animation tweak. Fix the contract at the source.
- `docs/index.html` stays untouched. This is a correctness fix, not a product-surface change.

Provider semantic-clock policy:

- Claude semantic records: `system` init records, user messages, assistant messages with visible content, reasoning/thinking content, tool-use/tool-result content, and result/error completion records.
- Claude non-semantic records: `file-history-snapshot`, queue bookkeeping, and assistant payloads that contain usage only and no visible content.
- Codex semantic records: `session_meta`, `response_item` values `message`, `function_call`, `function_call_output`, and `event_msg` values `agent_reasoning`, `task_started`, `task_complete`, `turn_aborted`.
- Codex non-semantic records: `token_count`, `turn_context`, and metadata-only snapshots that do not represent visible session progress.

Rejected approaches:

- Silently redefining session-domain `updatedAt` while leaving the misleading name in place.
- Any client-only sidebar suppression while the server keeps emitting `mtime`-driven invalidations.
- Falling back to filesystem `mtime` for session recency when semantic timestamps are missing.
- A staged compatibility period where some session surfaces expose `updatedAt` and others expose `lastActivityAt`.

### Task 1: Claude Provider Semantic Clocks

**Files:**
- Modify: `server/coding-cli/types.ts`
- Modify: `server/coding-cli/providers/claude.ts`
- Modify: `test/unit/server/coding-cli/claude-provider.test.ts`

**Step 1: Write the failing Claude semantic-clock tests**

Add these tests to `test/unit/server/coding-cli/claude-provider.test.ts`:

```ts
it('derives Claude createdAt and lastActivityAt from semantic transcript records', () => {
  const meta = parseSessionContent([
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: '11111111-1111-1111-1111-111111111111',
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

Expected: FAIL because `parseSessionContent()` and its return type do not yet expose semantic clocks.

**Step 3: Implement the Claude semantic clock**

In `server/coding-cli/types.ts`, extend the parsed-session contract:

```ts
export interface ParsedSessionMeta {
  sessionId?: string
  cwd?: string
  createdAt?: number
  lastActivityAt?: number
  // existing fields stay intact
}
```

In `server/coding-cli/providers/claude.ts`:

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

- Add explicit helpers such as `parseTimestampMs()`, `assistantHasVisibleContent()`, and `isClaudeSemanticRecord()` instead of scattering timestamp rules inline.
- `JsonlMeta` must also expose `createdAt` and `lastActivityAt`, because `parseSessionContent()` returns that type directly.
- `file-history-snapshot` must never move the semantic clock.
- Assistant payloads that contain usage only and no visible content must never move the semantic clock.
- Keep existing title, summary, first-user-message, git, dirty-state, and token-usage extraction intact.

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

### Task 2: Codex Provider Semantic Clocks

**Files:**
- Modify: `server/coding-cli/providers/codex.ts`
- Modify: `test/unit/server/coding-cli/codex-provider.test.ts`

**Step 1: Write the failing Codex semantic-clock tests**

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
const SEMANTIC_CODEX_EVENT_TYPES = new Set(['agent_reasoning', 'task_started', 'task_complete', 'turn_aborted'])
```

Implementation rules:

- `session_meta` is semantic and can establish both `createdAt` and `lastActivityAt`.
- `response_item` is semantic only for the allow-listed response types.
- `event_msg` is semantic only for the allow-listed event types.
- `token_count` and `turn_context` must never move the semantic clock.
- Keep existing title, summary, first-user-message, git, dirty-state, token-usage, and task-event extraction intact.

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

### Task 3: Core Session Model and Monotonic Indexer Recency

**Files:**
- Modify: `server/coding-cli/types.ts`
- Modify: `server/coding-cli/session-indexer.ts`
- Modify: `server/coding-cli/providers/opencode.ts`
- Modify: `test/unit/server/coding-cli/session-indexer.test.ts`
- Modify: `test/unit/server/coding-cli/opencode-provider.test.ts`

**Step 1: Write the failing core-model tests**

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

Update `test/unit/server/coding-cli/opencode-provider.test.ts` so the provider expectation uses `lastActivityAt` instead of session-domain `updatedAt`.

**Step 2: Run the focused core-model red pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/coding-cli/opencode-provider.test.ts
```

Expected: FAIL because `CodingCliSession` still uses `updatedAt` and the indexer still copies file `mtime` into session recency.

**Step 3: Implement the core-model cutover**

Rename the session-domain field in `server/coding-cli/types.ts`:

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

In `server/coding-cli/session-indexer.ts`, carry semantic clocks forward only when the same resolved session reparses append-only:

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
- Update all indexer sort points from `updatedAt` to `lastActivityAt`, including `detectNewSessions()`, group sorting, and project sorting.
- `updateDirectCacheEntry()` may keep using a synthetic `mtimeMs` for cache bookkeeping, but the session payload itself must use `lastActivityAt`.
- `server/coding-cli/providers/opencode.ts` must map SQL `time_updated` into `lastActivityAt`.

**Step 4: Run the focused core-model green pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/coding-cli/opencode-provider.test.ts
```

Expected: PASS

**Step 5: Commit the core-model cutover**

```bash
git add server/coding-cli/types.ts server/coding-cli/session-indexer.ts server/coding-cli/providers/opencode.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/coding-cli/opencode-provider.test.ts
git commit -m "refactor: make session index recency semantic"
```

### Task 4: Server Consumers of `lastActivityAt`

**Files:**
- Modify: `server/session-association-coordinator.ts`
- Modify: `server/coding-cli/codex-activity-tracker.ts`
- Modify: `server/index.ts`
- Modify: `server/sessions-sync/diff.ts`
- Modify: `test/unit/server/session-association-coordinator.test.ts`
- Modify: `test/unit/server/coding-cli/codex-activity-tracker.test.ts`
- Modify: `test/unit/server/sessions-sync/diff.test.ts`
- Modify: `test/server/session-association.test.ts`
- Modify: `test/server/ws-codex-activity.test.ts`
- Modify: `test/server/codex-activity-exact-subset.test.ts`
- Modify: `test/server/ws-terminal-create-session-repair.test.ts`
- Modify: `test/server/ws-session-repair-activity.test.ts`

**Step 1: Write the failing server-consumer tests**

Convert the session-domain fixtures and assertions in the listed tests from `updatedAt` to `lastActivityAt`.

Keep these expectations explicit:

- association eligibility compares session `lastActivityAt` against terminal creation time
- association watermarks advance on `lastActivityAt`
- codex activity tracker stores the latest session activity timestamp, not an `updatedAt` alias
- `sessions-sync/diff` still compares all own enumerable fields after the rename

Representative assertion:

```ts
expect(result.associated).toBe(true)
expect(coordinator.noteSession({ ...session, lastActivityAt: session.lastActivityAt + 1 })).toBe(true)
```

**Step 2: Run the focused server-consumer red pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/session-association-coordinator.test.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts test/unit/server/sessions-sync/diff.test.ts test/server/session-association.test.ts test/server/ws-codex-activity.test.ts test/server/codex-activity-exact-subset.test.ts test/server/ws-terminal-create-session-repair.test.ts test/server/ws-session-repair-activity.test.ts
```

Expected: FAIL because these server consumers still expect session `updatedAt`.

**Step 3: Implement the server-consumer cutover**

Implementation rules:

- In `server/session-association-coordinator.ts`, rename helpers like `normalizeUpdatedAt()` to `normalizeLastActivityAt()` and compare against `session.lastActivityAt`.
- In `server/coding-cli/codex-activity-tracker.ts`, rename the session-derived tracker field to `lastSeenSessionLastActivityAt` so the semantic leak is removed there too.
- In `server/index.ts`, pass `lastActivityAt` into the association coordinator.
- `server/sessions-sync/diff.ts` should keep its “compare all enumerable fields” behavior exactly as-is; only the session fixture field name changes.

**Step 4: Run the focused server-consumer green pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/session-association-coordinator.test.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts test/unit/server/sessions-sync/diff.test.ts test/server/session-association.test.ts test/server/ws-codex-activity.test.ts test/server/codex-activity-exact-subset.test.ts test/server/ws-terminal-create-session-repair.test.ts test/server/ws-session-repair-activity.test.ts
```

Expected: PASS

**Step 5: Commit the server-consumer cutover**

```bash
git add server/session-association-coordinator.ts server/coding-cli/codex-activity-tracker.ts server/index.ts server/sessions-sync/diff.ts test/unit/server/session-association-coordinator.test.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts test/unit/server/sessions-sync/diff.test.ts test/server/session-association.test.ts test/server/ws-codex-activity.test.ts test/server/codex-activity-exact-subset.test.ts test/server/ws-terminal-create-session-repair.test.ts test/server/ws-session-repair-activity.test.ts
git commit -m "refactor: cut server session consumers to lastActivityAt"
```

### Task 5: Shared Session-Directory Schema and Projection

**Files:**
- Modify: `shared/read-models.ts`
- Modify: `server/session-directory/types.ts`
- Modify: `server/session-directory/projection.ts`
- Modify: `test/unit/server/session-directory/projection.test.ts`

**Step 1: Write the failing projection tests**

Update `test/unit/server/session-directory/projection.test.ts` so it asserts:

- `toSessionDirectoryComparableItem()` exposes `lastActivityAt`
- projection equality ignores `tokenUsage`, `sourceFile`, and project color
- changing `lastActivityAt` is projection-visible

Representative expectation:

```ts
expect(toSessionDirectoryComparableItem(session)).toMatchObject({
  provider: 'codex',
  sessionId: 's1',
  lastActivityAt: 100,
})
```

**Step 2: Run the focused projection red test**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/session-directory/projection.test.ts
```

Expected: FAIL because the projection contract still uses `updatedAt` and there is no shared session-directory schema yet.

**Step 3: Implement the shared session-directory contract**

In `shared/read-models.ts`, add shared page schemas:

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

Implementation rules:

- `server/session-directory/types.ts` should alias from the shared schema instead of maintaining a duplicate shape.
- `server/session-directory/projection.ts` must compare and sort on `lastActivityAt`.
- Keep projection-invisible fields invisible; that boundary is what suppresses false invalidations.

**Step 4: Run the focused projection green test**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/session-directory/projection.test.ts
```

Expected: PASS

**Step 5: Commit the shared projection contract**

```bash
git add shared/read-models.ts server/session-directory/types.ts server/session-directory/projection.ts test/unit/server/session-directory/projection.test.ts
git commit -m "refactor: define shared session directory lastActivityAt contract"
```

### Task 6: Session-Directory Service Cursor and Invalidation Boundary

**Files:**
- Modify: `server/session-directory/service.ts`
- Modify: `test/unit/server/session-directory/service.test.ts`
- Modify: `test/unit/server/sessions-sync/service.test.ts`
- Modify: `test/server/ws-sidebar-snapshot-refresh.test.ts`

**Step 1: Write the failing service and invalidation tests**

Update the listed tests so they assert:

- cursor payloads use `{ lastActivityAt, key }`
- directory revision stays `max(session.lastActivityAt, terminalMeta.updatedAt)`
- publishes that change only projection-invisible fields do not broadcast a second `sessions.changed`

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

**Step 2: Run the focused service/invalidation red pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/session-directory/service.test.ts test/unit/server/sessions-sync/service.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts
```

Expected: FAIL because the cursor payload, filters, and fixtures still use `updatedAt`.

**Step 3: Implement the service and invalidation cutover**

In `server/session-directory/service.ts`, rename the cursor payload:

```ts
type CursorPayload = {
  lastActivityAt: number
  key: string
}
```

Implementation rules:

- `decodeCursor()` must validate `lastActivityAt`.
- pagination filtering must compare on `item.lastActivityAt`.
- `nextCursor` must encode `{ lastActivityAt: tail.lastActivityAt, key }`.
- `revision` must still include terminal metadata `updatedAt`, because that domain is unrelated and still correct.
- `test/server/ws-sidebar-snapshot-refresh.test.ts` should remain focused on invalidation behavior, not snapshot payloads.

**Step 4: Run the focused service/invalidation green pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/session-directory/service.test.ts test/unit/server/sessions-sync/service.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts
```

Expected: PASS

**Step 5: Commit the service and invalidation cutover**

```bash
git add server/session-directory/service.ts test/unit/server/session-directory/service.test.ts test/unit/server/sessions-sync/service.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts
git commit -m "refactor: cut session directory cursors to lastActivityAt"
```

### Task 7: Search, Pagination, Router, and CLI Session Contract

**Files:**
- Modify: `server/session-search.ts`
- Modify: `server/session-pagination.ts`
- Modify: `server/cli/index.ts`
- Modify: `test/unit/server/session-search.test.ts`
- Modify: `test/unit/server/session-pagination.test.ts`
- Modify: `test/integration/server/session-directory-router.test.ts`
- Modify: `test/integration/server/codex-session-rebind-regression.test.ts`
- Modify: `test/unit/cli/commands.test.ts`

**Step 1: Write the failing public-contract tests**

Convert the session-domain fixtures and assertions in the listed tests from `updatedAt` to `lastActivityAt`.

Keep these expectations explicit:

- search results expose `lastActivityAt`
- pagination sorts by `lastActivityAt` descending with the same tie-break rules
- router responses expose `lastActivityAt`
- CLI `list-sessions` and search output expose `lastActivityAt`

Representative assertion:

```ts
expect(results[0].lastActivityAt).toBeGreaterThanOrEqual(results[results.length - 1].lastActivityAt)
```

**Step 2: Run the focused public-contract red pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/session-search.test.ts test/unit/server/session-pagination.test.ts test/integration/server/session-directory-router.test.ts test/integration/server/codex-session-rebind-regression.test.ts
npm run test:vitest -- test/unit/cli/commands.test.ts
```

Expected: FAIL because the remaining public session contract still expects `updatedAt`.

**Step 3: Implement the public-contract cutover**

In `server/session-search.ts`, rename the schema field:

```ts
export const SearchResultSchema = z.object({
  sessionId: z.string(),
  provider: z.string().min(1),
  projectPath: z.string(),
  title: z.string().optional(),
  summary: z.string().optional(),
  matchedIn: z.enum(['title', 'userMessage', 'assistantMessage', 'summary']),
  snippet: z.string().optional(),
  lastActivityAt: z.number(),
  createdAt: z.number().optional(),
  archived: z.boolean().optional(),
  cwd: z.string().optional(),
})
```

Implementation rules:

- `server/session-search.ts` must sort on `lastActivityAt`.
- `server/session-pagination.ts` must compare and paginate on `lastActivityAt` while leaving container names like `oldestIncludedTimestamp` unchanged.
- `server/cli/index.ts` must rename its local `SessionDirectoryItem` shape and its `sessionDirectoryPageToProjects()` / `sessionDirectoryPageToSearchResponse()` mappings.
- Do not reintroduce `updatedAt` aliases in CLI output.

**Step 4: Run the focused public-contract green pack**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/session-search.test.ts test/unit/server/session-pagination.test.ts test/integration/server/session-directory-router.test.ts test/integration/server/codex-session-rebind-regression.test.ts
npm run test:vitest -- test/unit/cli/commands.test.ts
```

Expected: PASS

**Step 5: Commit the public-contract cutover**

```bash
git add server/session-search.ts server/session-pagination.ts server/cli/index.ts test/unit/server/session-search.test.ts test/unit/server/session-pagination.test.ts test/integration/server/session-directory-router.test.ts test/integration/server/codex-session-rebind-regression.test.ts test/unit/cli/commands.test.ts
git commit -m "refactor: cut public session contracts to lastActivityAt"
```

### Task 8: Client API Contract and Shared Schema Adoption

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/lib/api.ts`
- Modify: `test/unit/client/lib/api.test.ts`

**Step 1: Write the failing client API tests**

Update `test/unit/client/lib/api.test.ts` so it asserts:

- `fetchSidebarSessionsSnapshot()` groups sessions using `lastActivityAt`
- session-directory cursors encode `{ lastActivityAt, key }`
- `searchSessions()` returns `lastActivityAt`

Representative expectation:

```ts
expect(response.projects[0]?.sessions[0]).toMatchObject({
  sessionId: 'session-1',
  lastActivityAt: 1_000,
})
```

**Step 2: Run the focused client API red test**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/api.test.ts
```

Expected: FAIL because the client API layer still expects `updatedAt` and duplicates the directory response shape.

**Step 3: Implement the client API contract**

In `src/store/types.ts`, rename the session field:

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

In `src/lib/api.ts`, parse the HTTP response with the shared schema:

```ts
const page = SessionDirectoryPageSchema.parse(await getSessionDirectoryPage(...))
```

Implementation rules:

- Delete the duplicate local `SessionDirectoryItemResponse` / `SessionDirectoryPageResponse` shapes in favor of the shared schema.
- Rename `encodeLegacySessionCursor()` to a non-legacy helper and encode `{ lastActivityAt, key }`.
- `groupDirectoryItemsAsProjects()` and `searchSessions()` must map `lastActivityAt` through unchanged.
- Keep `oldestIncludedTimestamp` and `before` container names unchanged to avoid unrelated API churn.

**Step 4: Run the focused client API green test**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/api.test.ts
```

Expected: PASS

**Step 5: Commit the client API contract**

```bash
git add src/store/types.ts src/lib/api.ts test/unit/client/lib/api.test.ts
git commit -m "refactor: cut client api session contracts to lastActivityAt"
```

### Task 9: Client Session State and Thunks

**Files:**
- Modify: `src/store/sessionsSlice.ts`
- Modify: `src/store/sessionsThunks.ts`
- Modify: `test/unit/client/store/sessionsSlice.test.ts`
- Modify: `test/unit/client/store/sessionsThunks.test.ts`
- Modify: `test/unit/client/sessionsSlice.pagination.test.ts`

**Step 1: Write the failing session-state tests**

Convert the listed tests to expect `lastActivityAt` instead of session `updatedAt`.

Keep these expectations explicit:

- project grouping and sorting use semantic recency
- pagination state still stores `oldestLoadedTimestamp`
- search-result regrouping preserves `lastActivityAt`

Representative expectation:

```ts
expect(window.oldestLoadedTimestamp).toBe(1_000)
expect(window.projects[0]?.sessions[0]?.lastActivityAt).toBe(2_000)
```

**Step 2: Run the focused session-state red pack**

Run:

```bash
npm run test:vitest -- test/unit/client/store/sessionsSlice.test.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/sessionsSlice.pagination.test.ts
```

Expected: FAIL because the session slice and thunk helpers still use `updatedAt`.

**Step 3: Implement the session-state cutover**

Implementation rules:

- In `src/store/sessionsSlice.ts`, rename helper logic like `projectNewestUpdatedAt()` to use `lastActivityAt`.
- In `src/store/sessionsThunks.ts`, `searchResultsToProjects()` must populate `lastActivityAt`, and `oldestLoadedTimestamp` must be sourced from `result.lastActivityAt`.
- Keep loading-kind behavior exactly the same; only the session recency field changes.

**Step 4: Run the focused session-state green pack**

Run:

```bash
npm run test:vitest -- test/unit/client/store/sessionsSlice.test.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/sessionsSlice.pagination.test.ts
```

Expected: PASS

**Step 5: Commit the session-state cutover**

```bash
git add src/store/sessionsSlice.ts src/store/sessionsThunks.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/sessionsSlice.pagination.test.ts
git commit -m "refactor: cut client session state to lastActivityAt"
```

### Task 10: Sidebar Selectors and Session Timestamp Mapping

**Files:**
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Modify: `test/unit/client/store/selectors/sidebarSelectors.test.ts`
- Modify: `test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts`
- Modify: `test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts`

**Step 1: Write the failing selector tests**

Convert the listed selector tests so session fixtures use `lastActivityAt`.

Keep these expectations explicit:

- sidebar ordering uses semantic recency
- known-key generation still uses provider + sessionId
- running-terminal decoration still works after the rename

**Step 2: Run the focused selector red pack**

Run:

```bash
npm run test:vitest -- test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts
```

Expected: FAIL because the selector still builds item timestamps from `session.updatedAt`.

**Step 3: Implement the selector cutover**

Implementation rule:

- In `src/store/selectors/sidebarSelectors.ts`, map session timestamps from `session.lastActivityAt`.
- Leave fallback tab timestamps alone; they are not part of the session contract being fixed here.

Representative mapping:

```ts
timestamp: session.lastActivityAt,
```

**Step 4: Run the focused selector green pack**

Run:

```bash
npm run test:vitest -- test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts
```

Expected: PASS

**Step 5: Commit the selector cutover**

```bash
git add src/store/selectors/sidebarSelectors.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts
git commit -m "refactor: cut sidebar selectors to lastActivityAt"
```

### Task 11: Client UI Session Contract

**Files:**
- Modify: `src/components/HistoryView.tsx`
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `test/unit/client/components/App.test.tsx`
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx`
- Modify: `test/unit/client/components/Sidebar.test.tsx`
- Modify: `test/unit/client/components/ContextMenuProvider.test.tsx`
- Modify: `test/unit/client/components/HistoryView.mobile.test.tsx`
- Modify: `test/unit/client/components/HistoryView.a11y.test.tsx`
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`
- Modify: `test/e2e/sidebar-click-opens-pane.test.tsx`
- Modify: `test/e2e/sidebar-busy-icon-flow.test.tsx`

**Step 1: Write the failing client-UI tests**

Convert the listed unit and e2e tests so session fixtures use `lastActivityAt`.

Keep these assertions focused on existing behavior:

- HistoryView “Last used” renders from `lastActivityAt`
- context-menu copied session metadata uses `lastActivityAt`
- App bootstrap and sidebar tests consume the renamed field
- no synthetic flash test is added

**Step 2: Run the focused client-UI red pack**

Run:

```bash
npm run test:vitest -- test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/sidebar-busy-icon-flow.test.tsx
```

Expected: FAIL because these views and fixtures still expect session `updatedAt`.

**Step 3: Implement the client-UI cutover**

Implementation rules:

- `src/components/HistoryView.tsx` must sort and display “Last used” from `lastActivityAt`.
- `src/components/context-menu/ContextMenuProvider.tsx` must use `lastActivityAt` for copied session metadata and `endDate`.
- `src/components/Sidebar.tsx` should only update naming and comments for the renamed session field; do not add render-only workarounds here.

Representative update:

```ts
const lastActivityAt = info.session.lastActivityAt
```

**Step 4: Run the focused client-UI green pack**

Run:

```bash
npm run test:vitest -- test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/sidebar-busy-icon-flow.test.tsx
```

Expected: PASS

**Step 5: Commit the client-UI cutover**

```bash
git add src/components/HistoryView.tsx src/components/context-menu/ContextMenuProvider.tsx src/components/Sidebar.tsx test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/sidebar-busy-icon-flow.test.tsx
git commit -m "refactor: cut client ui session recency to lastActivityAt"
```

### Task 12: Fallout Sweep and Full Verification

**Files:**
- Modify: `test/unit/client/components/MobileTabStrip.test.tsx`
- Modify: `test/unit/client/components/Sidebar.mobile.test.tsx`
- Modify: `test/unit/client/components/Sidebar.perf-audit.test.tsx`
- Modify: `test/unit/client/components/TabBar.test.tsx`
- Modify: `test/unit/client/components/TabSwitcher.test.tsx`
- Modify: `test/unit/client/components/component-edge-cases.test.tsx`
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx`
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
- codex activity records
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
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/coding-cli/claude-provider.test.ts test/unit/server/coding-cli/codex-provider.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/coding-cli/opencode-provider.test.ts test/unit/server/session-association-coordinator.test.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts test/unit/server/sessions-sync/diff.test.ts test/unit/server/session-directory/projection.test.ts test/unit/server/session-directory/service.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/session-search.test.ts test/unit/server/session-pagination.test.ts test/integration/server/session-directory-router.test.ts test/integration/server/codex-session-rebind-regression.test.ts test/server/session-association.test.ts test/server/ws-codex-activity.test.ts test/server/codex-activity-exact-subset.test.ts test/server/ws-terminal-create-session-repair.test.ts test/server/ws-session-repair-activity.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts test/server/ws-handshake-snapshot.test.ts test/unit/server/unified-rename.test.ts
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
- Append-only reparses of the same file cannot move `lastActivityAt` backwards just because a truncated parse saw an incomplete semantic subset.
- `SessionsSyncService` does not broadcast `sessions.changed` when only projection-invisible session fields change.
- Session-directory routes, cursors, search results, pagination, and CLI output expose `lastActivityAt`.
- Sidebar ordering, HistoryView ordering, and context-menu “Last used” all render from `lastActivityAt`.
- No session-domain contract surface still exposes session `updatedAt`.
- Terminal metadata and other non-session domains still use their own `updatedAt` fields unchanged.
