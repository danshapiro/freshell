# Fresh Agent Progressive Hydration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore fresh-agent panes from the newest useful transcript page first, then load older transcript pages through one canonical fresh-agent hydration path with clear restore errors.

**Architecture:** The server owns provider-specific history reading and always emits the shared fresh-agent snapshot/page/body contracts. The client renders transcript history from paged fresh-agent state, not from terminal replay and not from provider-specific fallback paths. Freshopencode runtime restore accepts canonical OpenCode `ses_*` ids; unrecoverable old placeholder state surfaces a clear error instead of being silently guessed.

**Tech Stack:** React 18, Redux Toolkit, Express read-model routes, Zod shared contracts, Vitest, Testing Library.

## Global Constraints

- Fresh-agent behavior only. Do not modify terminal/CLI restore behavior or terminal replay behavior.
- Do not modify Codex app-server protocol wrappers for this change; freshcodex hydration should use the existing metadata read and turn-list methods.
- Keep one canonical fresh-agent hydration path: provider adapter -> shared snapshot/page/body contract -> Redux history state -> transcript renderer.
- Restore first renders the newest page, normalized by the server into chronological display order, anchored at the latest turn; older pages are prepended above it.
- After the first page renders, start bounded background catch-up immediately. Do not depend on provider cursors staying valid until a later user scroll.
- Use existing fresh-agent snapshot/page/body routes and thunks instead of inventing a new streaming transport.
- Revision-less `/turns` reads are allowed only for the first page. Older-page cursor reads must carry the revision returned by the first page.
- Turn-page `bodies` must be merged into the rendered turn list when `includeBodies=true`; summary-only page entries are not enough for a restored transcript.
- History page, body, and failure actions must carry a hydration request key or equivalent generation guard. Reducers must ignore stale results after the pane target changes, after a newer first-page request starts, or after a clear restore error is set.
- Live/local transcript turns are temporary overlays. Incoming durable page turns must dedupe by contract fields only: non-temporary `turnId`, non-temporary `id`, and `messageId`. Local echo reconciliation that needs pending-send metadata stays in `FreshAgentView` through the existing `localEchoLanded` path; do not add non-contract fields to `FreshAgentTurn`.
- Do not add a hidden legacy runtime fallback. If old/corrupt Freshopencode state cannot be normalized to a canonical `ses_*` id, fail with a visible restore error.
- If old Freshopencode state contains both a temporary `freshopencode-*` id and a canonical `ses_*` id, normalize it to the canonical `ses_*` id before using the main path.
- Provider-specific code stays inside provider adapters; the React transcript path must not branch on Claude/Codex/OpenCode history formats.
- Provider adapters must normalize native provider page ordering before returning `FreshAgentTurnPage`. The client always receives page turns oldest-to-newest within that page, and `nextCursor` always means older history.
- Do not auto-load unbounded transcript history in one blocking request. Load the newest page immediately, then drain older pages in small background batches until complete or until a clear safety cap/error is reached; transcript virtualization is a separate measured follow-up.
- Run npm commands in this worktree with `env -u NODE_ENV -u INIT_CWD ...` so inherited self-hosted app environment does not resolve dependencies from the main checkout.

---

## File Structure

- Modify `shared/read-models.ts`: make fresh-agent turn-page `revision` optional for first-page reads.
- Modify `server/fresh-agent/runtime-adapter.ts`: allow snapshot/page adapter options without changing the shared output contract.
- Modify `server/fresh-agent/runtime-manager.ts`: pass optional page revisions through and keep contract validation centralized.
- Modify `server/fresh-agent/router.ts`: accept revision-less `/turns` requests and return provider errors clearly.
- Modify `server/fresh-agent/history/claude/history-service.ts`: use the current history revision when a first-page request omits `revision` and normalize returned page order for display.
- Modify `server/fresh-agent/adapters/claude/adapter.ts`: forward optional revisions to the history service.
- Modify `server/fresh-agent/adapters/codex/adapter.ts`: derive first-page revision from `readThread({ includeTurns: false })` metadata plus `thread/turns/list`; do not use full-thread transcript reads as the normal restore or snapshot path.
- Modify `server/fresh-agent/adapters/opencode/adapter.ts`: keep canonical `ses_*` restore, remove runtime placeholder guessing, and make placeholder restore failures clear.
- Modify `server/fresh-agent/adapters/opencode/normalize.ts`: include page bodies when requested by the OpenCode adapter.
- Modify `shared/fresh-agent-turns.ts`: add contract-field turn identity helpers for durable history plus live overlays.
- Modify `shared/fresh-agent.ts`: normalize Freshopencode placeholder persisted identity to canonical `ses_*` when possible or to a visible restore error when not.
- Modify `src/store/freshAgentSlice.ts`: merge first/older pages into durable history, dedupe by contract identity, ignore stale page results, ensure page actions initialize sessions, and keep live turns as an overlay.
- Modify `src/store/freshAgentTypes.ts`: add page loading/backfill state plus hydration request guard fields.
- Modify `src/store/freshAgentThunks.ts`: support first-page loads without a revision and add bounded background catch-up for older pages.
- Modify `src/lib/api.ts`: make `revision` optional for fresh-agent turn-page requests.
- Modify `src/components/fresh-agent/FreshAgentView.tsx`: start first-page hydration immediately, use Redux page history plus live-turn overlay as transcript source, keep snapshot metadata separate, and preflight legacy Freshopencode placeholder state into a visible restore error.
- Modify `src/components/fresh-agent/FreshAgentTranscript.tsx`: show older-history loading/error state and preserve scroll anchoring while older pages are prepended.
- Modify `src/store/persistMiddleware.ts`: never persist temporary Freshopencode ids as durable restore identity.
- Modify `server/agent-api/layout-store.ts`: apply the same Freshopencode identity normalization to server-held layouts.
- Test `test/unit/server/fresh-agent/router.test.ts`: route accepts first-page `/turns` without revision.
- Test `test/unit/server/fresh-agent/claude-history-service.test.ts`: revision-less first-page read returns current revision, returns turns in display order, and keeps stale cursor checks.
- Test `test/unit/server/fresh-agent/codex-adapter.test.ts`: revision-less first-page read uses metadata-only `thread/read` plus `thread/turns/list`, avoids full-thread reads, and rejects later revision drift.
- Test `test/unit/server/fresh-agent/opencode-serve-adapter.test.ts`: placeholder resume fails clearly and canonical `ses_*` restore still works.
- Test `test/unit/shared/fresh-agent-turns.test.ts`: durable turns dedupe by non-temporary `turnId`/`id` and `messageId` without relying on non-contract aliases.
- Test `test/unit/client/store/freshAgentSlice.test.ts`: first page replaces, older page prepends with dedupe, stale page results are ignored, and live turns reconcile without losing restored pages.
- Test `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`: top loading control calls `onLoadOlder`, displays errors, and preserves scroll position when older turns are prepended.
- Test `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`: restore renders the first page from `/turns`, loads older pages using `nextCursor`, and surfaces restore errors.
- Test `test/unit/client/store/persistedState.test.ts` and `test/unit/server/agent-api/layout-store-fresh-agent.test.ts`: Freshopencode placeholders normalize at persisted and server-layout boundaries.

---

### Task 1: Revision-Less First Page Reads

**Files:**
- Modify: `shared/read-models.ts`
- Modify: `server/fresh-agent/runtime-adapter.ts`
- Modify: `server/fresh-agent/runtime-manager.ts`
- Modify: `server/fresh-agent/router.ts`
- Modify: `server/fresh-agent/history/claude/history-service.ts`
- Modify: `server/fresh-agent/adapters/claude/adapter.ts`
- Modify: `server/fresh-agent/adapters/codex/adapter.ts`
- Modify: `server/fresh-agent/adapters/opencode/adapter.ts`
- Modify: `server/fresh-agent/adapters/opencode/normalize.ts`
- Test: `test/unit/server/fresh-agent/router.test.ts`
- Test: `test/unit/server/fresh-agent/claude-history-service.test.ts`
- Test: `test/unit/server/fresh-agent/claude-adapter.test.ts`
- Test: `test/unit/server/fresh-agent/codex-adapter.test.ts`
- Test: `test/unit/server/fresh-agent/opencode-serve-adapter.test.ts`

**Interfaces:**
- Consumes: existing `FreshAgentTurnPageSchema`, `FreshAgentThreadTurnsQuerySchema`, provider `getTurnPage`.
- Produces: `/api/fresh-agent/threads/:sessionType/:provider/:threadId/turns` accepts omitted `revision` only when `cursor` is omitted, returns `revision` in the response, and returns page turns oldest-to-newest within each page.

- [ ] **Step 1: Write failing route test**

Add to `test/unit/server/fresh-agent/router.test.ts`:

```ts
it('loads the first fresh-agent turn page without requiring a client revision', async () => {
  const runtimeManager = {
    getTurnPage: vi.fn(async () => ({
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: 'ses_first_page',
      revision: 123,
      nextCursor: 'older-cursor',
      turns: [],
      bodies: {},
    })),
  }
  const app = createFreshAgentRouterHarness({ runtimeManager })

  const response = await request(app)
    .get('/api/fresh-agent/threads/freshopencode/opencode/ses_first_page/turns?limit=40&includeBodies=true')
    .expect(200)

  expect(response.body.revision).toBe(123)
  expect(response.body.nextCursor).toBe('older-cursor')
  expect(runtimeManager.getTurnPage).toHaveBeenCalledWith(expect.objectContaining({
    sessionType: 'freshopencode',
    provider: 'opencode',
    threadId: 'ses_first_page',
    revision: undefined,
    limit: 40,
    includeBodies: true,
  }))
})
```

If `router.test.ts` does not already have `createFreshAgentRouterHarness`, add a small local helper or adapt the existing `FreshAgentRuntimeManager` test setup; do not leave the snippet as a reference to a non-existent helper.

- [ ] **Step 2: Run route test to verify it fails**

Run: `env -u NODE_ENV -u INIT_CWD npm run test:vitest -- test/unit/server/fresh-agent/router.test.ts --run`

Expected: FAIL because `FreshAgentThreadTurnsQuerySchema` currently requires `revision`.

- [ ] **Step 3: Make first-page route query revision optional**

In `shared/read-models.ts`, change the query schema and add a refinement that keeps cursor reads versioned:

```ts
export const FreshAgentThreadTurnsQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  priority: ReadModelPrioritySchema.optional(),
  revision: z.coerce.number().int().nonnegative().optional(),
  cwd: z.string().trim().min(1).optional(),
  limit: z.number().int().positive().max(MAX_FRESH_AGENT_THREAD_TURNS).optional(),
  includeBodies: z.union([
    z.boolean(),
    z.enum(['true', 'false']).transform((v) => v === 'true'),
  ]).optional(),
}).superRefine((value, ctx) => {
  if (value.cursor && value.revision == null) {
    ctx.addIssue({
      code: 'custom',
      path: ['revision'],
      message: 'revision is required when cursor is provided',
    })
  }
})
```

In `server/fresh-agent/runtime-manager.ts`, change the `getTurnPage` input type:

```ts
revision?: number
```

Do not change `FreshAgentTurnPageSchema`; every provider must still return a concrete `revision`.

Add a route assertion that cursor requests without a revision are rejected:

```ts
await request(app)
  .get('/api/fresh-agent/threads/freshopencode/opencode/ses_first_page/turns?cursor=older')
  .expect(400)
```

- [ ] **Step 4: Write failing Claude history and adapter tests**

Update existing `test/unit/server/fresh-agent/claude-history-service.test.ts` expectations that intentionally change under the new contract:

- Rename `returns recent-first timeline pages with a cursor` to `returns display-ordered newest timeline pages with a cursor`.
- Change its first-page expectation from `['latest user turn', 'middle assistant turn']` to `['middle assistant turn', 'latest user turn']`.
- Replace `rejects timeline-page reads that omit the accepted restore revision` with a test that omits `revision` on a cursorless first-page request and expects the current history revision.

Add or update a service test:

```ts
it('loads the newest page with the current revision when no revision is supplied', async () => {
  const service = createClaudeHistoryServiceHarness()
  await service.writeTranscript('session-a', [
    userRecord('turn-1', 'first'),
    assistantRecord('turn-2', 'second'),
  ])

  const page = await service.getThreadTurnPage({
    sessionId: 'session-a',
    limit: 1,
    includeBodies: true,
  })

  expect(page.revision).toBeGreaterThan(0)
  expect(page.items).toHaveLength(1)
  expect(page.nextCursor).toEqual(expect.any(String))
  expect(page.bodies?.[page.items[0].turnId]).toBeDefined()
})
```

Adapt this snippet to the existing `claude-history-service.test.ts` harness: construct the service with `createClaudeFreshAgentHistoryService({ agentHistorySource: { resolve } })` and use the file's existing `toResolvedHistory`/message fixtures instead of inventing new permanent helpers.

Add a second assertion with `limit: 2` that the newest page is display ordered, using turn IDs that the fixture actually creates:

```ts
expect(page.items.map((item) => item.summary)).toEqual(['middle assistant turn', 'latest user turn'])
```

Add to `test/unit/server/fresh-agent/claude-adapter.test.ts`:

```ts
it('forwards omitted first-page revisions to the history service as undefined', async () => {
  const historyService = {
    getSnapshot: vi.fn(),
    getThreadTurnPage: vi.fn().mockResolvedValue({
      sessionType: 'freshclaude',
      sessionId: 'claude-session-1',
      revision: 13,
      items: [],
      nextCursor: null,
      bodies: {},
    }),
    getTurnBody: vi.fn(),
  }
  const adapter = createClaudeFreshAgentAdapter({
    sdkBridge: { createSession: vi.fn() } as any,
    historyService: historyService as any,
  })

  await adapter.getTurnPage?.(
    { sessionType: 'freshclaude', provider: 'claude', threadId: 'claude-session-1' },
    { limit: 40, includeBodies: true },
  )

  expect(historyService.getThreadTurnPage).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: 'claude-session-1',
    revision: undefined,
  }))
})
```

- [ ] **Step 5: Implement Claude current-revision fallback**

In `server/fresh-agent/history/claude/history-service.ts`, replace the hard revision requirement with history-derived revision:

```ts
const history = await loadHistoryRecords(query.sessionId)
throwIfAborted(query.signal)
const requestedRevision = query.revision ?? history.revision
if (requestedRevision !== history.revision) {
  throw new ClaudeFreshAgentStaleHistoryRevisionError(requestedRevision, history.revision)
}
if (cursor && cursor.revision !== history.revision) {
  throw new ClaudeFreshAgentStaleHistoryRevisionError(cursor.revision, history.revision)
}
```

Keep the existing cursor revision check unchanged.

Do not change Claude cursor behavior: cursor reads must still be checked against the requested revision and the cursor's embedded revision.

In `server/fresh-agent/adapters/claude/adapter.ts`, stop coercing missing revision to `NaN`:

```ts
revision: typeof query.revision === 'number' ? query.revision : undefined,
```

Normalize the returned page items to display order after selecting the newest page window:

```ts
// server/fresh-agent/history/claude/history-service.ts
const pageItems = history.records.slice(offset, offset + limit).reverse()
```

- [ ] **Step 6: Write failing Codex adapter tests**

Add to `test/unit/server/fresh-agent/codex-adapter.test.ts`:

```ts
it('uses metadata-only read plus turn list for revision-less first-page reads', async () => {
  const runtime = {
    startThread: vi.fn(),
    resumeThread: vi.fn(),
    readThread: vi.fn(async () => ({
      thread: { id: 'codex-thread-1', updatedAt: 456, status: 'idle', turns: [] },
    })),
    listThreadTurns: vi.fn(async () => ({
      nextCursor: null,
      turns: [makeCodexTurn('turn-a')],
    })),
    readThreadTurn: vi.fn(),
  }
  const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

  const page = await adapter.getTurnPage?.(
    { sessionType: 'freshcodex', provider: 'codex', threadId: 'codex-thread-1' },
    { limit: 10 },
  )

  expect(page).toMatchObject({
    sessionType: 'freshcodex',
    provider: 'codex',
    threadId: 'codex-thread-1',
    revision: 456,
  })
  expect(runtime.readThread).toHaveBeenCalledWith({
    threadId: 'codex-thread-1',
    includeTurns: false,
  })
  expect(runtime.listThreadTurns).toHaveBeenCalledWith(expect.objectContaining({
    threadId: 'codex-thread-1',
    limit: 1,
    itemsView: 'full',
  }))
  expect(runtime.readThread).not.toHaveBeenCalledWith(expect.objectContaining({ includeTurns: true }))
})

it('uses metadata-only snapshots so restored Codex panes do not full-read transcripts', async () => {
  const runtime = {
    startThread: vi.fn(),
    resumeThread: vi.fn(),
    readThread: vi.fn(async () => ({
      thread: { id: 'codex-thread-1', updatedAt: 456, status: 'idle', turns: [] },
    })),
    listThreadTurns: vi.fn(),
    readThreadTurn: vi.fn(),
  }
  const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })

  const snapshot = await adapter.getSnapshot?.({
    sessionType: 'freshcodex',
    provider: 'codex',
    threadId: 'codex-thread-1',
  })

  expect(snapshot).toMatchObject({ sessionId: 'codex-thread-1', revision: 456, turns: [] })
  expect(runtime.readThread).toHaveBeenCalledWith({ threadId: 'codex-thread-1', includeTurns: false })
  expect(runtime.readThread).not.toHaveBeenCalledWith(expect.objectContaining({ includeTurns: true }))
})
```

- [ ] **Step 7: Implement Codex metadata-only revision discovery**

In `server/fresh-agent/adapters/codex/adapter.ts`, keep `normalizeDisplayTurnPage`'s `revision` input concrete. Instead, make `getTurnPage` derive a concrete revision before calling it:

1. For cursor reads, require and pass the caller revision exactly as today.
2. For cursorless first-page reads with no caller revision, call `runtime.readThread({ threadId, includeTurns: false })` and use `thread.updatedAt` as the revision.
3. Then call the existing `thread/turns/list` path through `normalizeDisplayTurnPage` with that revision. If the page includes its own finite revision and it differs from metadata, throw `FreshAgentStaleThreadRevisionError`.
4. If metadata has no finite `updatedAt`, throw `FreshAgentUnprovableThreadRevisionError` with a clear message instead of falling back to a full transcript read.

Change `getSnapshot` to use `runtime.readThread({ threadId, includeTurns: false })` in the normal path and return a metadata snapshot with `turns: []`. Snapshot is no longer the transcript source; Task 3 uses paged history for transcript display. Do not call `readThread({ includeTurns: true })` in the normal restore path.

Keep the existing `normalizeDisplayTurnPage` page-revision check, but make it tolerant of providers that omit `rawPage.revision` by treating the concrete metadata revision as the expected page revision. If `rawPage.revision` is present and finite, it must equal the metadata/caller revision.

- [ ] **Step 8: Add OpenCode revision and body tests**

Add to `test/unit/server/fresh-agent/opencode-serve-adapter.test.ts`:

```ts
it('rejects stale OpenCode older-page revisions instead of silently returning a mismatched page', async () => {
  const manager = makeFakeManager()
  manager.getSession = vi.fn(async () => ({ id: 'ses_real_1', title: 'Kimi chat', time: { updated: 20 } }))
  manager.listMessages = vi.fn(async () => ({ messages, nextCursor: null }))
  const adapter = makeAdapter(manager)
  await adapter.attach?.({ sessionType: 'freshopencode', provider: 'opencode', sessionId: 'ses_real_1', cwd: '/repo/history' })

  await expect(adapter.getTurnPage?.(
    { sessionType: 'freshopencode', provider: 'opencode', threadId: 'ses_real_1' },
    { revision: 19, cursor: 'older-cursor', limit: 40, includeBodies: true },
  )).rejects.toMatchObject({ code: 'STALE_THREAD_REVISION' })
})

it('returns OpenCode page bodies keyed by turn id when includeBodies is true', async () => {
  const manager = makeFakeManager()
  manager.getSession = vi.fn(async () => ({ id: 'ses_real_1', title: 'Kimi chat', time: { updated: 20 } }))
  manager.listMessages = vi.fn(async () => ({ messages, nextCursor: null }))
  const adapter = makeAdapter(manager)
  await adapter.attach?.({ sessionType: 'freshopencode', provider: 'opencode', sessionId: 'ses_real_1', cwd: '/repo/history' })

  const page = await adapter.getTurnPage?.(
    { sessionType: 'freshopencode', provider: 'opencode', threadId: 'ses_real_1' },
    { limit: 40, includeBodies: true },
  )

  expect(page?.turns.map((turn) => turn.turnId)).toEqual(['msg_user_1', 'msg_assistant_1'])
  expect(page?.bodies?.['msg_user_1']?.items[0]).toMatchObject({ kind: 'text', text: 'reply ok' })
})
```

- [ ] **Step 9: Implement OpenCode revision checks and body map**

In `server/fresh-agent/adapters/opencode/adapter.ts`, import `FreshAgentStaleThreadRevisionError` from the runtime manager. After `assembleExport` returns a page revision:

```ts
if (typeof query.revision === 'number' && query.revision !== revision) {
  throw new FreshAgentStaleThreadRevisionError(revision)
}
```

Pass full page bodies when `query.includeBodies === true`:

```ts
return normalizeOpencodeTurnPage({
  threadId: thread.threadId,
  exported,
  revision,
  nextCursor,
  includeBodies: query.includeBodies === true,
})
```

Update `normalizeOpencodeTurnPage` to include:

```ts
bodies: includeBodies ? Object.fromEntries(turns.map((turn) => [turn.turnId, turn])) : undefined
```

- [ ] **Step 10: Run focused server tests**

Run: `env -u NODE_ENV -u INIT_CWD npm run test:vitest -- --config vitest.server.config.ts test/unit/server/fresh-agent/router.test.ts test/unit/server/fresh-agent/claude-history-service.test.ts test/unit/server/fresh-agent/claude-adapter.test.ts test/unit/server/fresh-agent/codex-adapter.test.ts test/unit/server/fresh-agent/opencode-serve-adapter.test.ts --run`

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add shared/read-models.ts server/fresh-agent/runtime-adapter.ts server/fresh-agent/runtime-manager.ts server/fresh-agent/router.ts server/fresh-agent/history/claude/history-service.ts server/fresh-agent/adapters/claude/adapter.ts server/fresh-agent/adapters/codex/adapter.ts server/fresh-agent/adapters/opencode/adapter.ts server/fresh-agent/adapters/opencode/normalize.ts test/unit/server/fresh-agent/router.test.ts test/unit/server/fresh-agent/claude-history-service.test.ts test/unit/server/fresh-agent/claude-adapter.test.ts test/unit/server/fresh-agent/codex-adapter.test.ts test/unit/server/fresh-agent/opencode-serve-adapter.test.ts
git commit -m "feat: allow fresh-agent first-page hydration without client revision"
```

---

### Task 2: Canonical Paged History State

**Files:**
- Modify: `shared/fresh-agent-turns.ts`
- Modify: `src/store/freshAgentSlice.ts`
- Modify: `src/store/freshAgentTypes.ts`
- Modify: `src/store/freshAgentThunks.ts`
- Modify: `src/lib/api.ts`
- Test: `test/unit/shared/fresh-agent-turns.test.ts`
- Test: `test/unit/client/store/freshAgentSlice.test.ts`
- Test: `test/unit/client/lib/api.test.ts`

**Interfaces:**
- Consumes: Task 1 revision-less page API.
- Produces: first page replaces the durable hydrated page, older pages prepend by cursor, stale async page results are ignored, live turns are kept as an overlay, and duplicate durable/live turns dedupe only by shared contract fields (`turnId`, `id`, `messageId`).

- [ ] **Step 1: Write failing identity and slice tests**

Add to `test/unit/shared/fresh-agent-turns.test.ts`:

```ts
it('matches durable and live turns by contract messageId', () => {
  expect(freshAgentTurnsReferToSameDisplayTurn(
    turn('live-assistant-1', { messageId: 'message-a' }),
    turn('durable-assistant-1', { messageId: 'message-a' }),
  )).toBe(true)
})

it('does not treat generated live ids as durable identity by themselves', () => {
  expect(freshAgentTurnsReferToSameDisplayTurn(
    turn('live-assistant-1'),
    turn('live-assistant-1'),
  )).toBe(false)
})
```

If `fresh-agent-turns.test.ts` does not already have a `turn()` helper, add a local helper that returns a strict `FreshAgentTurn` with `id`, `turnId`, `summary`, and `items`.

Add to `test/unit/client/store/freshAgentSlice.test.ts`:

```ts
it('replaces history with the newest page and stores its older cursor', () => {
  const state = reducer(undefined, historyPageReceived({
    sessionId: 'ses_a',
    sessionType: 'freshopencode',
    provider: 'opencode',
    turns: [turn('newer-user'), turn('newer-agent')],
    nextCursor: 'older-1',
    revision: 10,
  }))

  const session = state.sessions['freshopencode:opencode:ses_a']
  expect(session.historyItems.map((item) => item.turnId)).toEqual(['newer-user', 'newer-agent'])
  expect(session.nextHistoryCursor).toBe('older-1')
  expect(session.historyRevision).toBe(10)
})

it('prepends older pages and dedupes repeated boundary turns', () => {
  let state = reducer(undefined, historyPageReceived({
    sessionId: 'ses_a',
    sessionType: 'freshopencode',
    provider: 'opencode',
    turns: [turn('turn-2'), turn('turn-3')],
    nextCursor: 'older-1',
    revision: 10,
  }))

  state = reducer(state, historyPageReceived({
    sessionId: 'ses_a',
    sessionType: 'freshopencode',
    provider: 'opencode',
    cursor: 'older-1',
    turns: [turn('turn-1'), turn('turn-2')],
    nextCursor: null,
    revision: 10,
  }))

  expect(state.sessions['freshopencode:opencode:ses_a'].historyItems.map((item) => item.turnId))
    .toEqual(['turn-1', 'turn-2', 'turn-3'])
  expect(state.sessions['freshopencode:opencode:ses_a'].nextHistoryCursor).toBeNull()
})

it('keeps live assistant turns as a display overlay without dropping restored history', () => {
  let state = reducer(undefined, historyPageReceived({
    sessionId: 'ses_a',
    sessionType: 'freshopencode',
    provider: 'opencode',
    turns: [turn('turn-1')],
    nextCursor: null,
    revision: 10,
  }))

  state = reducer(state, addAssistantMessage({
    sessionId: 'ses_a',
    sessionType: 'freshopencode',
    provider: 'opencode',
    content: [{ type: 'text', text: 'live answer' }],
  }))

  const session = state.sessions['freshopencode:opencode:ses_a']
  expect(session.historyItems.map((item) => item.summary)).toEqual(['turn-1'])
  expect(selectFreshAgentTranscriptTurns(session).map((item) => item.summary))
    .toEqual(['turn-1', 'live answer'])
})

it('dedupes a live overlay when durable history shares the same contract messageId', () => {
  const session = freshAgentSessionState({
    sessionId: 'ses_a',
    sessionType: 'freshopencode',
    provider: 'opencode',
    historyItems: [turn('durable-assistant-1', { messageId: 'message-a' })],
    turns: [turn('live-assistant-1', { messageId: 'message-a', source: 'live' })],
  })

  expect(selectFreshAgentTranscriptTurns(session).map((item) => item.turnId))
    .toEqual(['durable-assistant-1'])
})

it('ignores stale page results after a newer first-page request starts', () => {
  let state = reducer(undefined, historyLoadStarted({
    sessionId: 'ses_a',
    sessionType: 'freshopencode',
    provider: 'opencode',
    requestKey: 'hydrate:old',
  }))
  state = reducer(state, historyLoadStarted({
    sessionId: 'ses_a',
    sessionType: 'freshopencode',
    provider: 'opencode',
    requestKey: 'hydrate:new',
  }))

  state = reducer(state, historyPageReceived({
    sessionId: 'ses_a',
    sessionType: 'freshopencode',
    provider: 'opencode',
    requestKey: 'hydrate:old',
    turns: [turn('stale-turn')],
    bodies: {},
    nextCursor: null,
    revision: 9,
  }))

  expect(state.sessions['freshopencode:opencode:ses_a'].historyItems).toEqual([])
})
```

Use the existing slice test session factory if one exists; otherwise add a small local `freshAgentSessionState` helper that returns a valid `FreshAgentSessionState` with sensible defaults.

- [ ] **Step 2: Run slice test to verify it fails**

Run: `env -u NODE_ENV -u INIT_CWD npm run test:vitest -- test/unit/shared/fresh-agent-turns.test.ts test/unit/client/store/freshAgentSlice.test.ts --run`

Expected: FAIL because older pages replace rather than prepend and live turns reset history.

- [ ] **Step 3: Implement contract-field history merge helpers**

In `shared/fresh-agent-turns.ts`, keep `getFreshAgentDisplayTurnKey` for stable durable IDs and add contract-field identity helpers. Do not add `requestId`, `submittedTurnId`, or any other non-contract field to `FreshAgentTurnSchema`.

```ts
export function isTemporaryFreshAgentTurnId(value: string | undefined): boolean {
  return typeof value === 'string' && (
    value.startsWith('live-')
    || value.startsWith('__local-echo:')
  )
}

export function getFreshAgentTurnIdentityKeys(turn: Pick<FreshAgentTurn, 'id' | 'turnId' | 'messageId'>): string[] {
  const keys = new Set<string>()
  for (const candidate of [turn.turnId, turn.id]) {
    if (candidate && !isTemporaryFreshAgentTurnId(candidate)) keys.add(`turn:${candidate}`)
  }
  if (turn.messageId) keys.add(`message:${turn.messageId}`)
  return [...keys]
}

export function freshAgentTurnsReferToSameDisplayTurn(a: FreshAgentTurn, b: FreshAgentTurn): boolean {
  const aKeys = new Set(getFreshAgentTurnIdentityKeys(a))
  return getFreshAgentTurnIdentityKeys(b).some((key) => aKeys.has(key))
}
```

Import the shared helpers and add merge helpers near `resetHydratedHistoryState` in `src/store/freshAgentSlice.ts`:

```ts
import {
  getFreshAgentTurnIdentityKeys,
} from '@shared/fresh-agent-turns'

function mergeUniqueTurnsByIdentity(
  first: FreshAgentSessionState['historyItems'],
  second: FreshAgentSessionState['historyItems'],
): FreshAgentSessionState['historyItems'] {
  const seen = new Set<string>()
  const merged: FreshAgentSessionState['historyItems'] = []
  for (const turn of [...first, ...second]) {
    const keys = getFreshAgentTurnIdentityKeys(turn)
    if (keys.some((key) => seen.has(key))) continue
    for (const key of keys) seen.add(key)
    merged.push(turn)
  }
  return merged
}

function appendLiveTurn(session: FreshAgentSessionState, turn: FreshAgentSessionState['historyItems'][number]): void {
  session.turns = mergeUniqueTurnsByIdentity(session.turns, [turn])
  session.historyBodies[turn.turnId] = turn
}
```

Add these fields to `FreshAgentSessionState` in `src/store/freshAgentTypes.ts`:

```ts
historyInitialLoading?: boolean
historyOlderLoading?: boolean
historyOlderError?: string
historyBackfillComplete?: boolean
historyBackfillPaused?: boolean
historyInitialRequestKey?: string
historyOlderRequestKey?: string
```

Update `historyLoadStarted` and `historyPageReceived` so page actions create the session entry before the snapshot arrives:

```ts
const session = resolveOrEnsureSession(state, action.payload)
if (!session) return
```

Use `action.payload.cursor` to set loading state:

```ts
if (action.payload.cursor) {
  session.historyOlderLoading = true
  session.historyOlderError = undefined
  session.historyOlderRequestKey = action.payload.requestKey
} else {
  session.historyInitialLoading = true
  session.historyError = undefined
  session.historyInitialRequestKey = action.payload.requestKey
}
```

Before applying `historyPageReceived` or `historyLoadFailed`, ignore stale results:

```ts
const expectedRequestKey = action.payload.cursor
  ? session.historyOlderRequestKey
  : session.historyInitialRequestKey
if (action.payload.requestKey && expectedRequestKey && action.payload.requestKey !== expectedRequestKey) {
  return
}
if (session.restoreFailureMessage) return
```

Update `historyPageReceived`:

```ts
const incoming = action.payload.turns
session.historyInitialLoading = false
session.historyOlderLoading = false
session.historyLoading = false
session.historyLoaded = true
session.historyItems = action.payload.cursor
  ? mergeUniqueTurnsByIdentity(incoming, session.historyItems)
  : incoming
for (const turn of incoming) {
  session.historyBodies[turn.turnId] = turn
}
for (const [turnId, body] of Object.entries(action.payload.bodies ?? {})) {
  session.historyBodies[turnId] = body
}
session.nextHistoryCursor = action.payload.nextCursor
session.historyRevision = action.payload.revision ?? session.historyRevision
session.historyBackfillComplete = action.payload.nextCursor == null
session.historyBackfillPaused = false
```

Add and export a selector-style helper from `src/store/freshAgentSlice.ts`:

```ts
export function selectFreshAgentTranscriptTurns(session: FreshAgentSessionState): FreshAgentTurn[] {
  return mergeUniqueTurnsByIdentity(session.historyItems, session.turns)
}
```

Update `addUserMessage` and `addAssistantMessage` to build contract-valid `FreshAgentTurn` objects and call `appendLiveTurn(session, turn)` instead of assigning `session.historyItems = session.turns`.

Update `turnBodyReceived` to ignore stale bodies if `action.payload.revision` does not equal the current `session.historyRevision`.

- [ ] **Step 4: Make API and thunk revisions optional**

In `src/lib/api.ts`, change the `getFreshAgentTurnPage` query type:

```ts
revision?: number
```

In `src/store/freshAgentThunks.ts`, change input:

```ts
revision?: number
requestKey?: string
priority?: 'visible' | 'background'
```

Keep `revision` in the query string only when defined.

Ensure caller code supplies `revision` whenever it supplies `cursor`; the route rejects cursor-without-revision.

Forward `priority` to `getFreshAgentTurnPage`:

```ts
const page = await getFreshAgentTurnPage(
  input.sessionType,
  input.provider,
  input.sessionId,
  {
    revision: input.revision,
    cursor: input.cursor,
    priority: input.priority,
    limit: input.limit,
    includeBodies: input.includeBodies,
    cwd: input.cwd,
    signal: controller.signal,
  },
)
```

When dispatching page actions, carry the request key and page bodies:

```ts
dispatch(historyLoadStarted(input))
// ...
dispatch(historyPageReceived({
  ...input,
  turns: page.turns,
  bodies: page.bodies ?? {},
  nextCursor: page.nextCursor,
  revision: page.revision,
}))
```

Add a new thunk in `src/store/freshAgentThunks.ts`:

```ts
const BACKGROUND_HISTORY_MAX_PAGES_PER_BATCH = 8

export const backfillFreshAgentOlderHistory = createAsyncThunk(
  'freshAgent/backfillOlderHistory',
  async (
    input: FreshAgentThreadThunkLocator & {
      revision: number
      cursor: string
      requestKey: string
      limit?: number
    },
    { dispatch },
  ) => {
    let cursor: string | null | undefined = input.cursor
    let revision = input.revision
    for (let page = 0; cursor && page < BACKGROUND_HISTORY_MAX_PAGES_PER_BATCH; page += 1) {
      const result = await dispatch(loadFreshAgentThreadTurns({
        ...input,
        revision,
        cursor,
        priority: 'background',
        limit: input.limit ?? 40,
        includeBodies: true,
      })).unwrap()
      cursor = result.nextCursor
      revision = result.revision
    }
    return { nextCursor: cursor ?? null, revision }
  },
)
```

If the thunk sees an invalid/expired cursor error, dispatch a clear `historyLoadFailed` message: `Older history cursor expired; refresh history to continue.` Do not silently fall back to a different path.

- [ ] **Step 5: Add API test for revision-less page request**

Add to `test/unit/client/lib/api.test.ts`:

```ts
it('omits revision when loading the first fresh-agent turn page', async () => {
  mockApiGet.mockResolvedValue({
    sessionType: 'freshopencode',
    provider: 'opencode',
    threadId: 'ses_a',
    revision: 10,
    nextCursor: null,
    turns: [],
  })

  await getFreshAgentTurnPage('freshopencode', 'opencode', 'ses_a', { limit: 40, includeBodies: true })

  expect(mockApiGet).toHaveBeenCalledWith(
    '/api/fresh-agent/threads/freshopencode/opencode/ses_a/turns?limit=40&includeBodies=true',
    expect.any(Object),
  )
})
```

- [ ] **Step 6: Run focused client state/API tests**

Run: `env -u NODE_ENV -u INIT_CWD npm run test:vitest -- test/unit/shared/fresh-agent-turns.test.ts test/unit/client/store/freshAgentSlice.test.ts test/unit/client/lib/api.test.ts --run`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add shared/fresh-agent-turns.ts src/store/freshAgentSlice.ts src/store/freshAgentTypes.ts src/store/freshAgentThunks.ts src/lib/api.ts test/unit/shared/fresh-agent-turns.test.ts test/unit/client/store/freshAgentSlice.test.ts test/unit/client/lib/api.test.ts
git commit -m "feat: merge fresh-agent history pages in canonical state"
```

---

### Task 3: Progressive Restore UI

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentView.tsx`
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`

**Interfaces:**
- Consumes: Task 2 `historyItems`, `turns`, `nextHistoryCursor`, `historyLoading`, `historyError`, `selectFreshAgentTranscriptTurns`, request-key guarded thunks, and revision-less first-page thunk.
- Produces: first page renders from `/turns`; bounded background catch-up starts after the first page; top-of-scroll can request more if catch-up pauses; snapshot metadata still drives controls, approvals, questions, and status.

- [ ] **Step 1: Write failing FreshAgentView restore test**

Add to `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`:

```ts
it('renders the newest turn page before relying on snapshot turns', async () => {
  deferFreshAgentSnapshot()
  mockGetFreshAgentTurnPage.mockResolvedValue({
    sessionType: 'freshopencode',
    provider: 'opencode',
    threadId: 'ses_restore',
    revision: 22,
    nextCursor: 'older-page',
    turns: [freshAgentTurn('turn-newest', 'assistant', 'Newest restored answer')],
    bodies: {},
  })

  renderFreshAgentView({
    sessionType: 'freshopencode',
    provider: 'opencode',
    sessionId: 'ses_restore',
    sessionRef: { provider: 'opencode', sessionId: 'ses_restore' },
    status: 'connected',
  })

  expect(await screen.findByText('Newest restored answer')).toBeInTheDocument()
  expect(mockGetFreshAgentTurnPage).toHaveBeenCalledWith(
    'freshopencode',
    'opencode',
    'ses_restore',
    expect.objectContaining({ limit: 40, includeBodies: true, revision: undefined }),
  )
})
```

Before adding the tests, update the file's `@/lib/api` mock to include `getFreshAgentTurnPage`, and add or reuse local helpers for deferred snapshots, rendering, and strict `FreshAgentTurn` fixtures. Do not let these tests hit the real `api.get` path in jsdom.

Add a second test that resolves the first page with `nextCursor` and verifies bounded background catch-up starts with the first page revision and cursor:

```ts
expect(mockGetFreshAgentTurnPage).toHaveBeenNthCalledWith(
  2,
  'freshopencode',
  'opencode',
  'ses_restore',
  expect.objectContaining({
    cursor: 'older-page',
    revision: 22,
    priority: 'background',
    includeBodies: true,
  }),
)
```

- [ ] **Step 2: Write failing Transcript older-page test**

Add to `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`:

```ts
it('loads older history from the top control', async () => {
  const onLoadOlder = vi.fn().mockResolvedValue(undefined)
  render(
    <FreshAgentTranscript
      turns={[freshAgentTurn('turn-2', 'assistant', 'Second')]}
      hasOlderHistory
      onLoadOlder={onLoadOlder}
    />,
  )

  await userEvent.click(screen.getByRole('button', { name: /load older/i }))

  expect(onLoadOlder).toHaveBeenCalledTimes(1)
})

it('shows history load errors without hiding restored turns', () => {
  render(
    <FreshAgentTranscript
      turns={[freshAgentTurn('turn-2', 'assistant', 'Second')]}
      hasOlderHistory
      historyError="Could not load older history"
    />,
  )

  expect(screen.getByText('Second')).toBeInTheDocument()
  expect(screen.getByText('Could not load older history')).toBeInTheDocument()
})
```

If `FreshAgentTranscript.test.tsx` does not already have `freshAgentTurn(...)`, add a local helper that returns a strict `FreshAgentTurn`.

- [ ] **Step 3: Wire FreshAgentView to canonical history state**

In `src/components/fresh-agent/FreshAgentView.tsx`, import the thunks and selector helper:

```ts
import { backfillFreshAgentOlderHistory, loadFreshAgentThreadTurns } from '@/store/freshAgentThunks'
import { selectFreshAgentTranscriptTurns } from '@/store/freshAgentSlice'
```

Select the current fresh-agent session by the same id used for page loading:

```ts
const transcriptSessionId = snapshotThreadId ?? paneContent.sessionId
const freshAgentSessionKey = transcriptSessionId
  ? makeFreshAgentSessionKey({
      sessionId: transcriptSessionId,
      sessionType: paneContent.sessionType,
      provider: paneContent.provider,
    })
  : null
const freshAgentSession = useAppSelector((state) => (
  freshAgentSessionKey ? state.freshAgent.sessions[freshAgentSessionKey] : undefined
))
```

Start the first page as soon as `snapshotThreadId` exists:

```ts
useEffect(() => {
  if (!snapshotThreadId) return
  const current = paneContentRef.current
  const requestKey = [
    current.createRequestId,
    current.sessionType,
    current.provider,
    snapshotThreadId,
  ].join(':')
  void dispatch(loadFreshAgentThreadTurns({
    sessionId: snapshotThreadId,
    sessionType: current.sessionType,
    provider: current.provider,
    cwd: current.initialCwd,
    limit: 40,
    includeBodies: true,
    requestKey,
  })).unwrap().then((page) => {
    if (!page.nextCursor) return
    void dispatch(backfillFreshAgentOlderHistory({
      sessionId: snapshotThreadId,
      sessionType: current.sessionType,
      provider: current.provider,
      cwd: current.initialCwd,
      revision: page.revision,
      cursor: page.nextCursor,
      requestKey,
      limit: 40,
    }))
  }).catch(() => {})
}, [dispatch, snapshotThreadId, paneContent.provider, paneContent.sessionType])
```

When snapshot resolves, keep metadata but do not replace page history:

```ts
dispatch(freshAgentSnapshotReceived({ snapshot: displaySnapshot, hydrateHistory: false }))
```

Add `hydrateHistory?: boolean` to the `freshAgentSnapshotReceived` payload. When false, update `snapshot`, status, metadata, approvals, questions, token usage, and `historyRevision`, but do not overwrite `historyItems`, `historyBodies`, or live `turns`.

Use canonical page history plus live overlay as the transcript source:

```ts
const turns = freshAgentSession ? selectFreshAgentTranscriptTurns(freshAgentSession) : []
```

Replace snapshot-only transcript decisions with the same `turns` source:

- Local echo landing should call `localEchoLanded(turns, echo, pendingSendMetadataRef.current.get(echo.requestId))`.
- Auto-title "has user turn" checks should use a new helper such as `freshAgentTurnsHaveUserTurn(turns)` or `freshAgentSnapshotHasUserTurn({ turns })`.
- `rewindToTurn`, fork target lookup, and checkpoint picking should use `turns` rather than `snapshot?.turns`.

Keep the local echo visual append, but rely on Task 2 reconciliation to remove it when the durable page turn lands.

- [ ] **Step 4: Add older-page callback**

In `FreshAgentView.tsx`, add:

```ts
const olderHistoryCursorInFlightRef = useRef<string | null>(null)

const loadOlderHistory = useCallback(() => {
  const session = freshAgentSession
  if (!session?.nextHistoryCursor || session.historyLoading) return
  if (olderHistoryCursorInFlightRef.current === session.nextHistoryCursor) return
  olderHistoryCursorInFlightRef.current = session.nextHistoryCursor
  void dispatch(loadFreshAgentThreadTurns({
    sessionId: session.sessionId,
    sessionType: session.sessionType,
    provider: session.provider,
    cwd: paneContentRef.current.initialCwd,
    revision: session.historyRevision,
    cursor: session.nextHistoryCursor,
    requestKey: session.historyInitialRequestKey ?? `${session.sessionType}:${session.provider}:${session.sessionId}`,
    limit: 40,
    includeBodies: true,
  })).finally(() => {
    if (olderHistoryCursorInFlightRef.current === session.nextHistoryCursor) {
      olderHistoryCursorInFlightRef.current = null
    }
  })
}, [dispatch, freshAgentSession])
```

Pass to transcript:

```tsx
<FreshAgentTranscript
  turns={localEcho ? [...turns, localEchoTurn] : turns}
  hasOlderHistory={Boolean(freshAgentSession?.nextHistoryCursor)}
  isLoadingOlder={freshAgentSession?.historyLoading === true}
  historyError={freshAgentSession?.historyError}
  onLoadOlder={loadOlderHistory}
  ...
/>
```

- [ ] **Step 5: Implement Transcript older-history UI and scroll anchoring**

Extend props in `FreshAgentTranscript.tsx`:

```ts
hasOlderHistory?: boolean
isLoadingOlder?: boolean
historyError?: string
onLoadOlder?: () => void | Promise<void>
```

Add a top control before `displayTurns.map`:

```tsx
{hasOlderHistory || historyError ? (
  <div className="fresh-agent-load-older flex justify-center py-2">
    {historyError ? (
      <span className="text-xs text-destructive">{historyError}</span>
    ) : (
      <button
        type="button"
        className="rounded border border-border px-2 py-1 text-xs text-muted-foreground"
        onClick={() => void onLoadOlder?.()}
        disabled={isLoadingOlder}
        aria-label="Load older history"
      >
        {isLoadingOlder ? 'Loading older...' : 'Load older'}
      </button>
    )}
  </div>
) : null}
```

In `onScroll`, trigger near the top:

```ts
if (node.scrollTop < 48 && hasOlderHistory && !isLoadingOlder) {
  void onLoadOlder?.()
}
```

Preserve scroll position when prepending older turns by recording `scrollHeight` before `onLoadOlder` and adjusting after `transcriptSignature` changes.

- [ ] **Step 6: Run focused UI tests**

Run: `env -u NODE_ENV -u INIT_CWD npm run test:vitest -- test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx --run`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/fresh-agent/FreshAgentView.tsx src/components/fresh-agent/FreshAgentTranscript.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx
git commit -m "feat: progressively hydrate fresh-agent transcripts"
```

---

### Task 4: Clear Freshopencode Restore Errors

**Files:**
- Modify: `server/fresh-agent/adapters/opencode/adapter.ts`
- Modify: `server/fresh-agent/runtime-adapter.ts`
- Modify: `server/ws-handler.ts`
- Modify: `shared/ws-protocol.ts`
- Modify: `shared/fresh-agent.ts`
- Modify: `src/components/fresh-agent/FreshAgentView.tsx`
- Modify: `src/store/persistedState.ts`
- Modify: `src/store/storage-migration.ts`
- Modify: `src/store/persistMiddleware.ts`
- Modify: `server/agent-api/layout-store.ts`
- Test: `test/unit/server/fresh-agent/opencode-serve-adapter.test.ts`
- Test: `test/unit/server/ws-handler-fresh-agent.test.ts`
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
- Test: `test/unit/client/lib/fresh-agent-ws.test.ts`
- Test: `test/unit/client/store/persistedState.test.ts`
- Test: `test/unit/server/agent-api/layout-store-fresh-agent.test.ts`

**Interfaces:**
- Consumes: existing `FreshAgentLostSessionError`, existing visible restore/load error surfaces.
- Produces: runtime restore of `freshopencode-*` placeholder ids fails clearly; canonical `ses_*` restore remains supported; persisted placeholder-plus-canonical state normalizes to `ses_*`; unrecoverable placeholder-only state becomes a visible restore error.

- [ ] **Step 1: Write failing OpenCode adapter test**

Add to `test/unit/server/fresh-agent/opencode-serve-adapter.test.ts`:

```ts
it('fails legacy freshopencode placeholder resume instead of guessing a durable session', async () => {
  const manager = makeFakeManager()
  const adapter = makeAdapter(manager)

  await expect(adapter.resume?.({
    requestId: 'restore-1',
    sessionType: 'freshopencode',
    provider: 'opencode',
    resumeSessionId: 'freshopencode-old-placeholder',
    cwd: '/repo',
  })).rejects.toMatchObject({
    name: 'FreshAgentLostSessionError',
    code: 'FRESH_AGENT_LOST_SESSION',
    message: expect.stringContaining('cannot be restored because it is not a canonical OpenCode session id'),
  })
})
```

Add persisted-state and layout-store tests:

```ts
it('normalizes Freshopencode placeholder state to a canonical ses id when one is available', () => {
  const content = migrateLegacyFreshAgentContent({
    kind: 'fresh-agent',
    sessionType: 'freshopencode',
    provider: 'opencode',
    sessionRef: { provider: 'opencode', sessionId: 'freshopencode-old-placeholder' },
    resumeSessionId: 'ses_real',
  })

  expect(content.sessionRef).toEqual({ provider: 'opencode', sessionId: 'ses_real' })
  expect(content.restoreError).toBeUndefined()
})

it('normalizes Freshopencode placeholder-only state to a restore error', () => {
  const content = migrateLegacyFreshAgentContent({
    kind: 'fresh-agent',
    sessionType: 'freshopencode',
    provider: 'opencode',
    sessionRef: { provider: 'opencode', sessionId: 'freshopencode-old-placeholder' },
  })

  expect(content.sessionRef).toBeUndefined()
  expect(content.resumeSessionId).toBeUndefined()
  expect(content.restoreError).toEqual({
    code: 'RESTORE_UNAVAILABLE',
    reason: 'invalid_legacy_restore_target',
  })
})
```

- [ ] **Step 2: Remove runtime placeholder resolver and stop sending legacy restore context**

In `server/fresh-agent/adapters/opencode/adapter.ts`, delete:

```ts
const legacyReader = (): OpencodeHistoryReader => { ... }
async function resolveLegacyPlaceholder(...) { ... }
```

Remove any imports that become unused after deleting the runtime placeholder resolver, including legacy history reader/runner types that are no longer referenced.

In `server/fresh-agent/runtime-adapter.ts`, `shared/ws-protocol.ts`, and `server/ws-handler.ts`, remove the legacy `legacyRestoreContext` field from fresh-agent create/resume input. It is currently forwarded by `ws-handler.ts`; delete that forwarding path and update `test/unit/server/ws-handler-fresh-agent.test.ts` so it no longer asserts that legacy context is accepted or forwarded.

In `resume`, replace placeholder handling with:

```ts
if (isPlaceholderOpencodeSessionId(sessionId)) {
  throw new FreshAgentLostSessionError(
    `OpenCode session ${sessionId} cannot be restored because it is not a canonical OpenCode session id.`,
  )
}
```

Keep `create()` placeholders for not-yet-materialized new live sessions. Keep promotion from placeholder to `ses_*` when OpenCode materializes a real session.

In `src/components/fresh-agent/FreshAgentView.tsx`, stop sending `legacyRestoreContext` for Freshopencode restore/create. If a restored Freshopencode pane only has a `freshopencode-*` id, normalize it locally to a restore error before sending any fresh-agent create/resume message.

Use this visible message:

```ts
This Freshopencode pane cannot be restored because it only saved a temporary id. Start a new Freshopencode session.
```

Do not include the placeholder in `sessionId`, `sessionRef`, or `resumeSessionId` after this normalization; keep it only inside restore-error details if needed for debugging.

- [ ] **Step 3: Update client visible message for Freshopencode placeholders**

In `src/components/fresh-agent/FreshAgentView.tsx`, update the restore/load error text path so local placeholder normalization and any server `FRESH_AGENT_LOST_SESSION` for Freshopencode say:

```ts
This Freshopencode pane cannot be restored because it only saved a temporary id. Start a new Freshopencode session.
```

Do not add a retry path that reuses the placeholder.

Make the restore error message provider-aware: `invalid_legacy_restore_target` should keep the existing Claude wording for Claude, but Freshopencode placeholder normalization must render the temporary-id message above. Update all existing FreshAgentView placeholder/restore-error tests that asserted legacy-context retry behavior.

In `shared/fresh-agent.ts`, update `migrateLegacyFreshAgentDurableState` with provider-specific OpenCode validation:

- If `sessionRef.provider === 'opencode'` and `sessionRef.sessionId` is canonical `ses_*`, keep it.
- If `sessionRef.provider === 'opencode'` is a `freshopencode-*` placeholder and `resumeSessionId` is canonical `ses_*`, return the canonical `sessionRef`.
- If the only OpenCode identity is `freshopencode-*`, return the visible restore error and clear identity fields.
- If an OpenCode identity is neither canonical `ses_*` nor a known live placeholder, return the same visible restore error.

In `src/store/persistedState.ts`, `src/store/storage-migration.ts`, `src/store/persistMiddleware.ts`, and `server/agent-api/layout-store.ts`, use the shared normalization path so temporary Freshopencode ids are not round-tripped as durable restore state.

- [ ] **Step 4: Update client test**

In `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`, update the existing placeholder restore test to assert the visible clear error and no legacy retry/resolution request.

```ts
expect(await screen.findByText(/only saved a temporary id/i)).toBeInTheDocument()
expect(mockGetFreshAgentThreadSnapshot).not.toHaveBeenCalledWith(
  expect.anything(),
  expect.anything(),
  'freshopencode-old-placeholder',
  expect.anything(),
)
```

- [ ] **Step 5: Run focused OpenCode/error tests**

Run: `env -u NODE_ENV -u INIT_CWD npm run test:vitest -- test/unit/server/fresh-agent/opencode-serve-adapter.test.ts test/unit/server/ws-handler-fresh-agent.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/store/persistedState.test.ts test/unit/server/agent-api/layout-store-fresh-agent.test.ts --run`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/fresh-agent/adapters/opencode/adapter.ts server/fresh-agent/runtime-adapter.ts server/ws-handler.ts shared/ws-protocol.ts shared/fresh-agent.ts src/components/fresh-agent/FreshAgentView.tsx src/store/persistedState.ts src/store/storage-migration.ts src/store/persistMiddleware.ts server/agent-api/layout-store.ts test/unit/server/fresh-agent/opencode-serve-adapter.test.ts test/unit/server/ws-handler-fresh-agent.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/store/persistedState.test.ts test/unit/server/agent-api/layout-store-fresh-agent.test.ts
git commit -m "feat: fail freshopencode legacy restore clearly"
```

---

### Task 5: Integration Verification and Cleanup

**Files:**
- Modify only files needed to fix review/test findings from Tasks 1-4.
- Test: focused tests from Tasks 1-4.
- Test: `npm run check`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: branch with green focused tests, green typecheck, and a clear implementation summary.

- [ ] **Step 1: Run all focused tests from this plan**

Run:

```bash
env -u NODE_ENV -u INIT_CWD npm run test:vitest -- \
  test/unit/server/fresh-agent/router.test.ts \
  test/unit/server/fresh-agent/claude-history-service.test.ts \
  test/unit/server/fresh-agent/claude-adapter.test.ts \
  test/unit/server/fresh-agent/codex-adapter.test.ts \
  test/unit/server/fresh-agent/opencode-serve-adapter.test.ts \
  test/unit/server/ws-handler-fresh-agent.test.ts \
  test/unit/shared/fresh-agent-turns.test.ts \
  test/unit/client/store/freshAgentSlice.test.ts \
  test/unit/client/lib/api.test.ts \
  test/unit/client/lib/fresh-agent-ws.test.ts \
  test/unit/client/store/persistedState.test.ts \
  test/unit/server/agent-api/layout-store-fresh-agent.test.ts \
  test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx \
  --run
```

Expected: PASS.

- [ ] **Step 2: Run coordinated check**

Run: `env -u NODE_ENV -u INIT_CWD FRESHELL_TEST_SUMMARY='fresh-agent progressive hydration final check' npm run check`

Expected: typecheck PASS and coordinated test suite PASS.

- [ ] **Step 3: Inspect diff for accidental CLI/terminal behavior changes**

Run:

```bash
git diff --stat origin/main...HEAD
git diff --name-only origin/main...HEAD
```

Expected: changed files are fresh-agent contracts, fresh-agent server adapters/routes, fresh-agent store/UI, and related tests only. No terminal replay, terminal spawning, Codex app-server protocol-wrapper, or user-visible CLI mode behavior files should be changed for this feature.

Also run:

```bash
git diff origin/main...HEAD -- server/coding-cli src/components/TerminalView.tsx shared/ws-protocol.ts
```

Expected: no terminal/CLI behavior changes and no `server/coding-cli` changes. A `shared/ws-protocol.ts` change is acceptable only if it removes unused Freshopencode legacy restore context from the fresh-agent message surface.

- [ ] **Step 4: Commit final cleanup if needed**

If Step 1 or Step 2 required fixes:

```bash
git add <fixed-files>
git commit -m "fix: stabilize fresh-agent progressive hydration"
```

If no fixes were needed, do not create an empty commit.

- [ ] **Step 5: Final branch review prep**

Run:

```bash
git log --oneline origin/main..HEAD
git status --short --branch
```

Expected: focused commits exist, worktree is clean, branch is still `feature/fresh-agent-progressive-hydration`.

---

## Self-Review

**Spec coverage:** The plan covers fresh-agent-only behavior, newest-page-first restore, canonical provider adapters, clear Freshopencode errors, no CLI behavior changes, and no hidden fallback path.

**Placeholder scan:** The plan contains no TBD/TODO placeholders. Every task names files, commands, expected outcomes, and concrete code shapes.

**Type consistency:** The same terms are used throughout: `historyItems`, `nextHistoryCursor`, `historyRevision`, `loadFreshAgentThreadTurns`, `getFreshAgentTurnPage`, and `FreshAgentLostSessionError`.
