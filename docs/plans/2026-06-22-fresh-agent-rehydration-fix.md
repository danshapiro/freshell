# Fresh-Agent Rehydration Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore persisted FreshOpenCode panes quickly after reload/restart without reintroducing the PR #468 body-heavy restart regression.

**Architecture:** Treat fresh-agent snapshots as a control-plane/status contract only: status, capabilities, pending control requests, usage totals, sidebars, and revision metadata. Treat `/api/fresh-agent/threads/:sessionType/:provider/:threadId/turns` and `/turns/:turnId` as the only transcript loading paths; the canonical display history is ordered `/turns` history plus live/local overlays, and every transcript-dependent behavior uses that source instead of `snapshot.turns`. The client loads one visible page with bounded bodies when a pane is actually visible, warms older history for hidden/inactive idle panes through a strict background budget, lets explicit user actions fetch one page immediately, and keeps busy/status polling separate from transcript fetching. Add structured server logs for each served turn page so request count, payload size, `includeBodies`, priority, turn count, and duration are measurable from JSONL logs.

**Tech Stack:** React 18, Redux Toolkit async thunks, Express, Zod shared contracts, Pino JSONL logs, Vitest, Testing Library, Supertest, Playwright.

## Global Constraints

- Baseline is current `origin/main` after rollback PR #470; rollback merge commit is `a4c75e14c7b61c838e01a0d47bf78cbf3d1fa6aa`, and this plan was authored from `99ee54d462fd52d4f2fa20b1560ff79e5b45a542` which includes PR #471.
- Do not revive PR #468's restart-time automatic deep backfill behavior.
- Do not add `backfillFreshAgentOlderHistory`, `BACKGROUND_HISTORY_MAX_PAGES_PER_BATCH`, or any automatic multi-page body backfill on mount/restart.
- Snapshots are status/control metadata, not transcript bodies/history. Any snapshot response containing transcript turns is a contract violation.
- `/turns` is the transcript path. `includeBodies=true` is allowed for the first actually visible page, explicit user-driven older-page loads, and budgeted background warm-history loads for idle panes only.
- `/turns` returns turns chronological oldest-to-newest within the returned window. The first visible page is the newest bounded window in chronological order; a cursor page returns the next older bounded window in chronological order and the client prepends it.
- `/turns` body hydration accepts both shapes: full bodies in `page.bodies[turnId]` and provider-inline full `turn.items` in `page.turns`. OpenCode currently uses the inline path.
- The first visible page must have a server-side payload guard. If provider bodies would exceed the configured byte cap, the server returns summary-only rows for oversized turns and the client can lazy-load full bodies through `/turns/:turnId`.
- Busy/status polling must not trigger repeated `/turns?includeBodies=true` requests.
- Background warm-history is allowed for hidden or inactive panes only after the pane is idle, under a global byte/page/concurrency budget. It fetches one page at a time, stops at the budget, yields to visible requests, and never runs for running/busy FreshOpenCode sessions.
- Explicit user history actions bypass the background queue for one page at a time, still with the server-side payload cap.
- Revision `0` is valid. Do not use truthiness checks for revisions.
- Structured logs must not include raw thread IDs, raw turn IDs, raw cwd paths, prompts, or transcript bodies.
- Use red/green/refactor TDD. Prefer integration/e2e/smoke tests over narrow tautological unit tests.
- Run broad coordinated suites through `npm run test:status` and the repo coordinator. Do not kill another holder.
- Do not deploy, restart production, or restart the self-hosted Freshell server unless the user explicitly says `APPROVED`.

---

## File Structure

- Modify `shared/fresh-agent-contract.ts`: make `FreshAgentSnapshotSchema.turns` metadata-only by rejecting non-empty turn arrays; keep `FreshAgentTurnPageSchema` and `FreshAgentTurnBodySchema` as the transcript contracts.
- Modify `server/fresh-agent/adapters/opencode/adapter.ts`: make `getSnapshot` call OpenCode session metadata only, not `listMessages`; keep message listing inside `getTurnPage`.
- Modify `server/fresh-agent/adapters/opencode/normalize.ts`: keep `normalizeOpencodeSnapshot` capable of building a metadata-only snapshot with empty `turns`; keep transcript normalization in `normalizeOpencodeTurnPage` and `normalizeOpencodeTurnBody`.
- Modify `server/fresh-agent/adapters/codex/adapter.ts`: make `getSnapshot` call `readThread({ includeTurns: false })`; keep full/display turn hydration in `getTurnPage` and `getTurnBody`.
- Modify `server/fresh-agent/adapters/claude/adapter.ts` and `server/fresh-agent/adapters/claude/normalize.ts`: make snapshots emit empty `turns` and avoid durable full-history loads for status-only snapshots.
- Modify `server/fresh-agent/runtime-manager.ts`: enforce transcript page ordering and cap first-page body payload size before contract validation.
- Create `server/fresh-agent/turn-page-payload.ts`: shared helpers for chronological turn-page normalization, payload byte counting, inline/body truncation, and body-cap metrics.
- Modify `src/store/freshAgentTypes.ts`: add small request bookkeeping fields for visible transcript hydration, not multi-page backfill.
- Modify `src/store/freshAgentSlice.ts`: merge `/turns` pages and `bodies` into `historyItems`/`historyBodies`; stop copying snapshot turns into history.
- Modify `src/store/freshAgentThunks.ts`: preserve `page.bodies` when dispatching `historyPageReceived`; do not add background backfill thunks.
- Create `src/store/freshAgentHistoryWarmQueue.ts`: budgeted low-priority history queue for hidden/inactive idle panes, with global concurrency 1, byte/page budget accounting, request dedupe, and visible-request preemption.
- Modify `src/components/fresh-agent/FreshAgentView.tsx`: split status snapshot refresh from transcript page hydration; render, auto-title, local echo landing, checkpoint rewind, and fork/rewind context from canonical display history, not snapshot turns.
- Modify `src/components/fresh-agent/FreshAgentTranscript.tsx`: add an accessible "Load older history" control that fires one page request per click.
- Modify `server/fresh-agent/observability.ts`: add `fresh_agent_turn_page_served` structured event.
- Modify `server/fresh-agent/router.ts`: log `fresh_agent_turn_page_served` after successful `/turns` responses.
- Modify `test/e2e-browser/fixtures/fake-opencode.cjs`: support the `opencode serve` endpoints used by the current FreshOpenCode adapter (`GET /session/:id`, `GET /session/:id/message`, `GET /session/:id/message/:messageId`, `POST /session/:id/prompt_async`).
- Modify tests:
  - `test/unit/shared/fresh-agent-contract.test.ts`
  - `test/unit/server/fresh-agent/turn-page-payload.test.ts`
  - `test/unit/server/fresh-agent/opencode-serve-adapter.test.ts`
  - `test/unit/server/fresh-agent/codex-adapter.test.ts`
  - `test/unit/server/fresh-agent/claude-adapter.test.ts`
  - `test/unit/server/fresh-agent/router.test.ts`
  - `test/unit/server/fresh-agent/observability.test.ts`
  - `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
  - `test/e2e-browser/specs/freshopencode-db-history.spec.ts`

## Task 1: Make Snapshots Metadata-Only By Contract

**Files:**
- Modify: `shared/fresh-agent-contract.ts`
- Modify: `server/fresh-agent/adapters/opencode/adapter.ts`
- Modify: `server/fresh-agent/adapters/opencode/normalize.ts`
- Modify: `server/fresh-agent/adapters/codex/adapter.ts`
- Modify: `server/fresh-agent/adapters/claude/adapter.ts`
- Modify: `server/fresh-agent/adapters/claude/normalize.ts`
- Test: `test/unit/shared/fresh-agent-contract.test.ts`
- Test: `test/unit/server/fresh-agent/opencode-serve-adapter.test.ts`
- Test: `test/unit/server/fresh-agent/codex-adapter.test.ts`
- Test: `test/unit/server/fresh-agent/claude-adapter.test.ts`
- Test: `test/unit/server/fresh-agent/router.test.ts`
- Test: `test/unit/server/fresh-agent/observability.test.ts`

**Interfaces:**
- Consumes: existing `FreshAgentSnapshotSchema`, `FreshAgentTurnPageSchema`, adapter `getSnapshot(thread, revision?)`, adapter `getTurnPage(thread, query)`.
- Produces: `FreshAgentSnapshotSchema` rejects non-empty `turns`; all adapter snapshots return `turns: []`; transcript payloads remain available only through `getTurnPage` and `getTurnBody`.

- [ ] **Step 1: Add the failing shared contract test**

In `test/unit/shared/fresh-agent-contract.test.ts`, add:

```ts
it('rejects snapshot transcript turns so snapshots stay metadata-only', () => {
  const result = FreshAgentSnapshotSchema.safeParse({
    sessionType: 'freshopencode',
    provider: 'opencode',
    threadId: 'ses_contract_1',
    sessionId: 'ses_contract_1',
    revision: 12,
    latestTurnId: 'msg_2',
    status: 'idle',
    capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: true },
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
    pendingApprovals: [],
    pendingQuestions: [],
    worktrees: [],
    diffs: [],
    childThreads: [],
    turns: [{
      id: 'msg_2',
      turnId: 'msg_2',
      role: 'assistant',
      summary: 'body should not be here',
      items: [{ id: 'msg_2:text', kind: 'text', text: 'large transcript body' }],
    }],
    extensions: {},
  })

  expect(result.success).toBe(false)
})
```

- [ ] **Step 2: Add the failing FreshOpenCode adapter test**

In `test/unit/server/fresh-agent/opencode-serve-adapter.test.ts`, replace the current `getSnapshot assembles HTTP messages into the normalized transcript` test with:

```ts
it('getSnapshot reads session metadata without listing transcript messages', async () => {
  const manager = makeFakeManager()
  manager.getSession = vi.fn(async () => ({
    id: 'ses_real_1',
    title: 'Kimi chat',
    time: { updated: 12 },
    tokens: { input: 3, output: 5, total: 8 },
  }))
  manager.listMessages = vi.fn(async () => {
    throw new Error('snapshot must not list transcript messages')
  })
  const adapter = makeAdapter(manager)
  await adapter.attach?.({
    sessionType: 'freshopencode',
    provider: 'opencode',
    sessionId: 'ses_real_1',
    cwd: '/repo/history',
  })

  await expect(adapter.getSnapshot?.({
    sessionType: 'freshopencode',
    provider: 'opencode',
    threadId: 'ses_real_1',
  })).resolves.toMatchObject({
    sessionId: 'ses_real_1',
    summary: 'Kimi chat',
    revision: 12,
    turns: [],
    tokenUsage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
  })
  expect(manager.getSession).toHaveBeenCalledWith('ses_real_1', { cwd: '/repo/history' })
  expect(manager.listMessages).not.toHaveBeenCalled()
})
```

- [ ] **Step 3: Add failing Codex and Claude snapshot tests**

In `test/unit/server/fresh-agent/codex-adapter.test.ts`, add a test near existing `getSnapshot` coverage:

```ts
it('reads snapshot metadata without requesting Codex thread turns', async () => {
  const runtime = makeRuntime()
  runtime.readThread = vi.fn(async (input: any) => {
    expect(input).toEqual({ threadId: 'thread-new-1', includeTurns: false })
    return {
      thread: {
        id: 'thread-new-1',
        sessionId: 'thread-new-1',
        updatedAt: 7,
        status: { type: 'idle' },
        turns: [{
          id: 'turn-should-not-appear',
          items: [{ type: 'agentMessage', id: 'item-1', text: 'large body' }],
        }],
      },
    }
  })
  const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any, displayIdSecret: 'metadata-only' })

  const snapshot: any = await adapter.getSnapshot?.({
    sessionType: 'freshcodex',
    provider: 'codex',
    threadId: 'thread-new-1',
  })

  expect(snapshot.turns).toEqual([])
  expect(JSON.stringify(snapshot)).not.toContain('large body')
})
```

Use the local runtime factory already present in that file. If the helper name differs, adapt only the helper call, not the assertion shape.

In `test/unit/server/fresh-agent/claude-adapter.test.ts`, add:

```ts
it('normalizes Claude metadata snapshots without transcript turns or duplicate history resolution', async () => {
  const resolved = {
    kind: 'resolved' as const,
    timelineSessionId: 'claude-session-1',
    latestTurnId: 'msg-1',
    revision: 0,
    turns: [{
      turnId: 'msg-1',
      messageId: 'msg-1',
      ordinal: 0,
      source: 'durable' as const,
      message: {
        messageId: 'msg-1',
        role: 'assistant' as const,
        timestamp: '2026-06-22T12:00:00.000Z',
        content: [{ type: 'text' as const, text: 'large Claude body' }],
      },
    }],
  }
  const agentHistorySource = { resolve: vi.fn(async () => resolved) }
  const sdkBridge = makeSdkBridge({
    messages: [],
  })
  const adapter = createClaudeFreshAgentAdapter({ sdkBridge, agentHistorySource })

  const snapshot: any = await adapter.getSnapshot?.({
    sessionType: 'freshclaude',
    provider: 'claude',
    threadId: 'claude-session-1',
  })

  expect(snapshot.turns).toEqual([])
  expect(snapshot.revision).toBe(0)
  expect(JSON.stringify(snapshot)).not.toContain('large Claude body')
  expect(agentHistorySource.resolve).toHaveBeenCalledTimes(1)
})
```

Use the local SDK bridge helper already present in `claude-adapter.test.ts`; keep the expected body string unique. The assertion on `revision: 0` is intentional because `0` is a valid revision and must not be dropped by truthiness checks.

- [ ] **Step 4: Run the focused tests and verify they fail**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/shared/fresh-agent-contract.test.ts \
  test/unit/server/fresh-agent/opencode-serve-adapter.test.ts \
  test/unit/server/fresh-agent/codex-adapter.test.ts \
  test/unit/server/fresh-agent/claude-adapter.test.ts
```

Expected: FAIL. The contract still accepts snapshot turns; FreshOpenCode snapshot still calls `listMessages`; Codex still reads with `includeTurns: true`; Claude still serializes live turns.

- [ ] **Step 5: Implement the metadata-only snapshot contract**

In `shared/fresh-agent-contract.ts`, change the snapshot `turns` field to reject non-empty arrays:

```ts
turns: z.array(FreshAgentTurnSchema)
  .max(0, 'Fresh-agent snapshots are metadata-only; load transcript turns through /turns.')
  .default([]),
```

In `server/fresh-agent/adapters/opencode/adapter.ts`, keep `assembleExport` for turn pages, and add a metadata helper:

```ts
async function readSessionMetadata(
  realSessionId: string,
  route?: { cwd: string },
): Promise<{ info: Record<string, any>; revision: number }> {
  const session = await (route
    ? serveManager.getSession(realSessionId, route)
    : serveManager.getSession(realSessionId)
  ).catch(() => ({} as Record<string, unknown>))
  const sessionInfo = session && typeof session === 'object' ? session as Record<string, any> : {}
  const sessionTime = sessionInfo.time && typeof sessionInfo.time === 'object'
    ? sessionInfo.time as Record<string, unknown>
    : {}
  const revision = Number.isFinite(Number(sessionTime.updated)) ? Number(sessionTime.updated) : 0
  return { info: { id: realSessionId, ...sessionInfo }, revision }
}
```

Then replace `getSnapshot`'s `assembleExport(...limit: DEFAULT_SNAPSHOT_TURN_LIMIT...)` call with:

```ts
const { info, revision } = await readSessionMetadata(realId, route)
return normalizeOpencodeSnapshot({
  sessionType: 'freshopencode',
  threadId: thread.threadId,
  exported: {
    info: {
      ...info,
      time: { ...((info.time) ?? {}), updated: revision },
    },
    messages: [],
  },
  status: liveState?.status ?? 'idle',
  model: liveState?.model,
  effort: liveState?.effort,
})
```

In `server/fresh-agent/adapters/opencode/normalize.ts`, ensure `normalizeOpencodeSnapshot` still parses empty `messages` and returns `turns: []`. Keep message-to-turn conversion only for `normalizeOpencodeTurnPage` and `normalizeOpencodeTurnBody`.

In `server/fresh-agent/adapters/codex/adapter.ts`, change `getSnapshot` to request no turns and return an empty transcript:

```ts
rawSnapshot = await runtime.readThread({ threadId: thread.threadId, includeTurns: false })
...
return normalizeCodexThreadSnapshot({
  threadId: thread.threadId,
  revision: revisionNumber,
  status: normalizeCodexThreadStatus(rawSnapshot.thread?.status),
  transcript: { turns: [] },
  rawSnapshot,
})
```

Do not fall back to `includeTurns: true` in the snapshot path. If `includeTurns: false` is unsupported, fail the snapshot path clearly and keep transcript loading on `/turns`.

In `server/fresh-agent/adapters/claude/normalize.ts`, keep metadata and live control fields but emit empty snapshot turns:

```ts
const turns: FreshAgentNormalizedTurn[] = []
...
turns,
```

In `server/fresh-agent/adapters/claude/adapter.ts`, avoid calling durable full-history snapshot loading just to serve status. For non-live sessions, use a metadata-only history method from the next local edit:

```ts
async function loadResolvedMetadata(threadId: string, revision?: number) {
  if (!historyService) throw new Error('Claude history service is not configured')
  return await historyService.getSnapshotMetadata({ sessionId: threadId, revision })
}
```

Add `getSnapshotMetadata` to `ClaudeFreshAgentHistoryService` in `server/fresh-agent/history/claude/history-service.ts`. It returns only:

```ts
{
  sessionId: history.sessionId,
  latestTurnId: history.latestTurnId,
  revision: history.revision,
  turns: [],
}
```

Use the same revision and restore-resolution errors as `getSnapshot`, but do not build or return message bodies. Refactor `buildResolvedHistoryRecords` so metadata and page/body paths share resolution error handling without requiring metadata snapshots to call `agentHistorySource.resolve()` a second time. In `createClaudeFreshAgentAdapter.getSnapshot`, call exactly one of these per request:

- live session path: `agentHistorySource.resolve(threadId, { liveSessionOverride })` once, then normalize metadata from that resolved value.
- durable-only path: `historyService.getSnapshotMetadata({ sessionId: threadId, revision })` once.

Do not call `loadResolved(...)` and then `deps.agentHistorySource.resolve(...)` again in the same snapshot request.

- [ ] **Step 6: Run the focused tests and verify they pass**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/shared/fresh-agent-contract.test.ts \
  test/unit/server/fresh-agent/opencode-serve-adapter.test.ts \
  test/unit/server/fresh-agent/codex-adapter.test.ts \
  test/unit/server/fresh-agent/claude-adapter.test.ts
```

Expected: PASS. Snapshots reject transcript bodies and adapter snapshots return empty `turns`.

- [ ] **Step 7: Update snapshot observability expectations**

In `test/unit/server/fresh-agent/router.test.ts`, update the snapshot-served test so the runtime returns a metadata-only snapshot and the assertions prove the rollback contract:

```ts
expect(payload.turnCount).toBe(0)
expect(payload.payloadBytes).toBeGreaterThan(0)
expect(payload.payloadBytes).toBeLessThan(16 * 1024)
```

Keep the raw-id redaction assertion. In `test/unit/server/fresh-agent/observability.test.ts`, change the `fresh_agent_snapshot_served` example `turnCount` from `3` to `0` and remove `lastTurnIdHash` from the happy-path example unless the snapshot still has `latestTurnId` metadata. Snapshot observability must make `fresh_agent_snapshot_served.turnCount === 0` visible in tests.

- [ ] **Step 8: Commit Task 1**

Run:

```bash
git add shared/fresh-agent-contract.ts \
  server/fresh-agent/adapters/opencode/adapter.ts \
  server/fresh-agent/adapters/opencode/normalize.ts \
  server/fresh-agent/adapters/codex/adapter.ts \
  server/fresh-agent/adapters/claude/adapter.ts \
  server/fresh-agent/adapters/claude/normalize.ts \
  server/fresh-agent/history/claude/history-service.ts \
  test/unit/shared/fresh-agent-contract.test.ts \
  test/unit/server/fresh-agent/opencode-serve-adapter.test.ts \
  test/unit/server/fresh-agent/codex-adapter.test.ts \
  test/unit/server/fresh-agent/claude-adapter.test.ts \
  test/unit/server/fresh-agent/router.test.ts \
  test/unit/server/fresh-agent/observability.test.ts
git commit -m "fix(fresh-agent): make snapshots metadata-only"
```

Expected: local commit created; no push.

## Task 2: Load The Visible Transcript Through `/turns`

**Files:**
- Modify: `src/store/freshAgentTypes.ts`
- Modify: `src/store/freshAgentSlice.ts`
- Modify: `src/store/freshAgentThunks.ts`
- Modify: `src/components/fresh-agent/FreshAgentView.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

**Interfaces:**
- Consumes: metadata-only snapshots from Task 1; `loadFreshAgentThreadTurns(input)` from `src/store/freshAgentThunks.ts`; `FreshAgentTurnPage.bodies`.
- Produces: visible page hydration keyed by `{ sessionType, provider, threadId, revision }`; `historyItems` contains chronological page summaries; `historyBodies` contains hydrated bodies from `page.bodies`; rendered transcript uses canonical display history (`/turns` history plus live/local overlays) and never falls back to `snapshot.turns`.

- [ ] **Step 1: Add API mocks for turn pages**

In `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`, extend `apiMock`:

```ts
const apiMock = vi.hoisted(() => ({
  getFreshAgentThreadSnapshot: vi.fn(),
  getFreshAgentTurnPage: vi.fn(),
  getFreshAgentTurnBody: vi.fn(),
  getFreshAgentModelCapabilities: vi.fn(),
  post: vi.fn(),
  setSessionMetadata: vi.fn().mockResolvedValue(undefined),
}))
```

Extend the `@/lib/api` mock:

```ts
getFreshAgentTurnPage: apiMock.getFreshAgentTurnPage,
getFreshAgentTurnBody: apiMock.getFreshAgentTurnBody,
```

In `beforeEach`, reset and default the new mocks:

```ts
apiMock.getFreshAgentTurnPage.mockReset()
apiMock.getFreshAgentTurnBody.mockReset()
apiMock.getFreshAgentTurnPage.mockResolvedValue({
  sessionType: 'freshcodex',
  provider: 'codex',
  threadId: 'thread-default',
  revision: 1,
  nextCursor: null,
  turns: [],
  bodies: {},
})
apiMock.getFreshAgentTurnBody.mockResolvedValue(null)
```

- [ ] **Step 2: Add the failing visible-page hydration test**

In the `FreshAgentView` describe block, add:

```ts
it('rehydrates a restored Freshopencode pane from one visible /turns page instead of snapshot turns', async () => {
  const store = createStore()
  apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
    sessionType: 'freshopencode',
    provider: 'opencode',
    threadId: 'ses_restore_fast',
    sessionId: 'ses_restore_fast',
    revision: 45,
    latestTurnId: 'msg_assistant_1',
    status: 'idle',
    summary: 'OpenCode restored',
    capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: true },
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
    pendingApprovals: [],
    pendingQuestions: [],
    worktrees: [],
    diffs: [],
    childThreads: [],
    turns: [],
    extensions: {},
  })
  apiMock.getFreshAgentTurnPage.mockResolvedValueOnce({
    sessionType: 'freshopencode',
    provider: 'opencode',
    threadId: 'ses_restore_fast',
    revision: 45,
    nextCursor: null,
    turns: [
      { id: 'msg_user_1', turnId: 'msg_user_1', role: 'user', summary: 'Restore prompt', items: [] },
      { id: 'msg_assistant_1', turnId: 'msg_assistant_1', role: 'assistant', summary: 'Restore answer summary', items: [] },
    ],
    bodies: {
      msg_user_1: {
        id: 'msg_user_1',
        turnId: 'msg_user_1',
        role: 'user',
        summary: 'Restore prompt',
        items: [{ id: 'msg_user_1:text', kind: 'text', text: 'Restore prompt' }],
      },
      msg_assistant_1: {
        id: 'msg_assistant_1',
        turnId: 'msg_assistant_1',
        role: 'assistant',
        summary: 'Restore answer summary',
        items: [{ id: 'msg_assistant_1:text', kind: 'text', text: 'Restore answer body' }],
      },
    },
  })
  store.dispatch(initLayout({
    tabId: 'tab-1',
    paneId: 'pane-1',
    content: {
      kind: 'fresh-agent',
      sessionType: 'freshopencode',
      provider: 'opencode',
      createRequestId: 'req-restore-fast',
      sessionId: 'ses_restore_fast',
      sessionRef: { provider: 'opencode', sessionId: 'ses_restore_fast' },
      resumeSessionId: 'ses_restore_fast',
      initialCwd: '/repo/restore-fast',
      status: 'connected',
    },
  }))

  render(
    <Provider store={store}>
      <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
    </Provider>,
  )

  await waitFor(() => {
    expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledWith(
      'freshopencode',
      'opencode',
      'ses_restore_fast',
      expect.objectContaining({ cwd: '/repo/restore-fast' }),
    )
  })
  await waitFor(() => {
    expect(apiMock.getFreshAgentTurnPage).toHaveBeenCalledWith(
      'freshopencode',
      'opencode',
      'ses_restore_fast',
      expect.objectContaining({
        revision: 45,
        priority: 'visible',
        includeBodies: true,
        limit: 30,
        cwd: '/repo/restore-fast',
      }),
    )
  })
  expect(await screen.findByText('Restore answer body')).toBeInTheDocument()
  expect(apiMock.getFreshAgentTurnPage).toHaveBeenCalledTimes(1)
})
```

Also add a test proving OpenCode inline bodies render even when `page.bodies` is absent:

```ts
it('renders Freshopencode inline turn items when the turn page has no bodies map', async () => {
  const store = createStore()
  apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
    sessionType: 'freshopencode',
    provider: 'opencode',
    threadId: 'ses_inline_items',
    sessionId: 'ses_inline_items',
    revision: 0,
    latestTurnId: 'msg_inline_assistant',
    status: 'idle',
    capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: true },
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
    pendingApprovals: [],
    pendingQuestions: [],
    worktrees: [],
    diffs: [],
    childThreads: [],
    turns: [],
    extensions: {},
  })
  apiMock.getFreshAgentTurnPage.mockResolvedValueOnce({
    sessionType: 'freshopencode',
    provider: 'opencode',
    threadId: 'ses_inline_items',
    revision: 0,
    nextCursor: null,
    turns: [{
      id: 'msg_inline_assistant',
      turnId: 'msg_inline_assistant',
      role: 'assistant',
      summary: 'Inline summary',
      items: [{ id: 'inline:text', kind: 'text', text: 'Inline OpenCode body' }],
    }],
  })
  store.dispatch(initLayout({
    tabId: 'tab-1',
    paneId: 'pane-1',
    content: {
      kind: 'fresh-agent',
      sessionType: 'freshopencode',
      provider: 'opencode',
      createRequestId: 'req-inline-items',
      sessionId: 'ses_inline_items',
      sessionRef: { provider: 'opencode', sessionId: 'ses_inline_items' },
      resumeSessionId: 'ses_inline_items',
      status: 'connected',
    },
  }))

  render(
    <Provider store={store}>
      <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
    </Provider>,
  )

  expect(await screen.findByText('Inline OpenCode body')).toBeInTheDocument()
  expect(apiMock.getFreshAgentTurnPage).toHaveBeenCalledWith(
    'freshopencode',
    'opencode',
    'ses_inline_items',
    expect.objectContaining({ revision: 0, includeBodies: true }),
  )
})
```

Add a visibility guard test that starts hidden and proves no body-heavy turn page is requested until the pane becomes visible:

```ts
it('does not request the visible body page while the pane is hidden', async () => {
  const store = createStore()
  apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
    sessionType: 'freshopencode',
    provider: 'opencode',
    threadId: 'ses_hidden',
    sessionId: 'ses_hidden',
    revision: 4,
    latestTurnId: null,
    status: 'idle',
    capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: true },
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
    pendingApprovals: [],
    pendingQuestions: [],
    worktrees: [],
    diffs: [],
    childThreads: [],
    turns: [],
    extensions: {},
  })
  apiMock.getFreshAgentTurnPage.mockResolvedValue({
    sessionType: 'freshopencode',
    provider: 'opencode',
    threadId: 'ses_hidden',
    revision: 4,
    nextCursor: null,
    turns: [],
    bodies: {},
  })
  const paneContent = {
    kind: 'fresh-agent' as const,
    sessionType: 'freshopencode' as const,
    provider: 'opencode' as const,
    createRequestId: 'req-hidden',
    sessionId: 'ses_hidden',
    sessionRef: { provider: 'opencode' as const, sessionId: 'ses_hidden' },
    resumeSessionId: 'ses_hidden',
    status: 'connected' as const,
  }

  const view = render(
    <Provider store={store}>
      <FreshAgentView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden />
    </Provider>,
  )

  await act(async () => { await Promise.resolve() })
  expect(apiMock.getFreshAgentTurnPage).not.toHaveBeenCalled()

  view.rerender(
    <Provider store={store}>
      <FreshAgentView tabId="tab-1" paneId="pane-1" paneContent={paneContent} />
    </Provider>,
  )

  await waitFor(() => {
    expect(apiMock.getFreshAgentTurnPage).toHaveBeenCalledWith(
      'freshopencode',
      'opencode',
      'ses_hidden',
      expect.objectContaining({ includeBodies: true, priority: 'visible', revision: 4 }),
    )
  })
})
```

- [ ] **Step 3: Run the test and verify it fails**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx -t "rehydrates a restored Freshopencode pane from one visible /turns page"
```

Expected: FAIL because `FreshAgentView` still renders from `snapshot.turns`, does not call `getFreshAgentTurnPage`, does not accept revision `0` in the hydration effect, and does not yet prove hidden panes avoid `includeBodies=true`.

- [ ] **Step 4: Preserve `/turns` bodies in Redux and reject stale pages**

In `src/store/freshAgentTypes.ts`, add request bookkeeping:

```ts
  historyThreadId?: string
  visibleHistoryRequestKey?: string
  visibleHistoryLoadedKey?: string
```

In `src/store/freshAgentThunks.ts`, include `page.bodies`, the original `cursor`, `includeBodies`, and a deterministic request key:

```ts
const historyRequestKey = [
  input.sessionType,
  input.provider,
  input.sessionId,
  input.revision,
  input.cursor ?? 'first',
  input.includeBodies === true ? 'bodies' : 'summary',
].join(':')

dispatch(historyLoadStarted({
  ...input,
  cursor: input.cursor,
  includeBodies: input.includeBodies,
  historyRequestKey,
}))

const page = await getFreshAgentTurnPage(...)
dispatch(historyPageReceived({
  ...input,
  cursor: input.cursor,
  includeBodies: input.includeBodies,
  historyRequestKey,
  turns: page.turns,
  bodies: page.bodies,
  nextCursor: page.nextCursor,
  revision: page.revision,
}))
```

Do not drop `revision: 0`; the request key must include the numeric value as provided.

In `src/store/freshAgentSlice.ts`, add helpers near the other session helpers:

```ts
function isVisibleBodyFirstPage(payload: { cursor?: string; includeBodies?: boolean }): boolean {
  return !payload.cursor && payload.includeBodies === true
}

function resetHistoryForSnapshotRevision(session: FreshAgentSessionState, snapshot: FreshAgentSnapshot): void {
  const revisionChanged = session.historyRevision !== undefined && session.historyRevision !== snapshot.revision
  const threadChanged = session.historyThreadId !== undefined && session.historyThreadId !== snapshot.threadId
  session.historyThreadId = snapshot.threadId
  session.historyRevision = snapshot.revision
  if (!revisionChanged && !threadChanged) return
  session.historyItems = []
  session.historyBodies = {}
  session.nextHistoryCursor = undefined
  session.historyLoaded = false
  session.historyLoading = false
  session.visibleHistoryRequestKey = undefined
  session.visibleHistoryLoadedKey = undefined
}
```

In `freshAgentSnapshotReceived`, stop copying `snapshot.turns` into history and reset visible request keys when the thread or revision changes:

```ts
session.snapshot = snapshot
session.status = snapshot.status as FreshAgentSessionStatus
session.latestTurnId = snapshot.latestTurnId
resetHistoryForSnapshotRevision(session, snapshot)
session.pendingPermissions = Object.fromEntries(snapshot.pendingApprovals.map((approval) => [String(approval.requestId), approval]))
session.pendingQuestions = Object.fromEntries(snapshot.pendingQuestions.map((question) => [String(question.requestId), question]))
session.totalInputTokens = snapshot.tokenUsage.inputTokens
session.totalOutputTokens = snapshot.tokenUsage.outputTokens
session.totalCostUsd = snapshot.tokenUsage.costUsd ?? 0
session.awaitingDurableHistory = false
```

Update `historyLoadStarted`:

```ts
historyLoadStarted(state, action: PayloadAction<SessionMutationPayload & {
  cursor?: string
  includeBodies?: boolean
  revision: number
  historyRequestKey: string
}>) {
  const key = resolveSessionKey(state, action.payload)
  if (!key) return
  const session = state.sessions[key]
  if (session.historyRevision !== undefined && session.historyRevision !== action.payload.revision) return
  session.historyLoading = true
  session.historyError = undefined
  if (isVisibleBodyFirstPage(action.payload)) {
    session.visibleHistoryRequestKey = action.payload.historyRequestKey
  }
}
```

Extend `historyPageReceived`. It must ignore stale thread/revision/request responses, merge body maps, replace the first page, and prepend cursor pages because page windows are chronological oldest-to-newest:

```ts
historyPageReceived(state, action: PayloadAction<SessionMutationPayload & {
  cursor?: string
  includeBodies?: boolean
  historyRequestKey: string
  turns: FreshAgentSessionState['historyItems']
  bodies?: Record<string, FreshAgentSessionState['historyItems'][number]>
  nextCursor?: string | null
  revision: number
}>) {
  const key = resolveSessionKey(state, action.payload)
  if (!key) return
  const session = state.sessions[key]
  if (session.historyThreadId !== undefined && session.historyThreadId !== action.payload.sessionId) return
  if (session.historyRevision !== undefined && session.historyRevision !== action.payload.revision) return
  if (
    isVisibleBodyFirstPage(action.payload)
    && session.visibleHistoryRequestKey
    && session.visibleHistoryRequestKey !== action.payload.historyRequestKey
  ) return

  session.historyLoading = false
  session.historyLoaded = true
  session.historyThreadId = action.payload.sessionId
  session.historyRevision = action.payload.revision
  session.nextHistoryCursor = action.payload.nextCursor
  const existingIds = new Set(session.historyItems.map((turn) => turn.turnId))
  const incomingUnique = action.payload.turns.filter((turn) => !existingIds.has(turn.turnId))
  session.historyItems = action.payload.cursor
    ? [...incomingUnique, ...session.historyItems]
    : action.payload.turns
  if (action.payload.bodies) {
    for (const [turnId, turn] of Object.entries(action.payload.bodies)) {
      session.historyBodies[turnId] = turn
    }
  }
  if (isVisibleBodyFirstPage(action.payload)) {
    session.visibleHistoryLoadedKey = action.payload.historyRequestKey
    session.visibleHistoryRequestKey = undefined
  }
}
```

Update `historyLoadFailed` to clear `visibleHistoryRequestKey` only when the failed key matches the current visible request key.

- [ ] **Step 5: Hydrate the first visible page from `FreshAgentView`**

In `src/components/fresh-agent/FreshAgentView.tsx`, import the thunk:

```ts
import { loadFreshAgentThreadTurns } from '@/store/freshAgentThunks'
```

Add local helpers near other pure helpers:

```ts
function hydrateTurnSummaries(
  items: FreshAgentTurn[],
  bodies: Record<string, FreshAgentTurn> | undefined,
): FreshAgentTurn[] {
  return items.map((turn) => {
    const body = bodies?.[turn.turnId]
    if (body) return body
    if (turn.items.length > 0) return turn
    return turn
  })
}

function mergeCanonicalDisplayTurns(
  historyItems: FreshAgentTurn[],
  historyBodies: Record<string, FreshAgentTurn> | undefined,
  liveTurns: FreshAgentTurn[],
): FreshAgentTurn[] {
  const hydrated = hydrateTurnSummaries(historyItems, historyBodies)
  const seen = new Set(hydrated.map((turn) => turn.turnId))
  const liveOverlay = liveTurns.filter((turn) => !seen.has(turn.turnId))
  return [...hydrated, ...liveOverlay]
}

function hasUserTurns(turns: FreshAgentTurn[]): boolean {
  return turns.some((turn) => turn.role === 'user')
}
```

After `agentSession` and `snapshotThreadId` are available, compute the canonical display turns from Redux history plus live overlay. Do not read `snapshot.turns`:

```ts
const displayTurns = useMemo(() => (
  mergeCanonicalDisplayTurns(
    agentSession?.historyItems ?? [],
    agentSession?.historyBodies,
    agentSession?.turns ?? [],
  )
), [agentSession?.historyBodies, agentSession?.historyItems, agentSession?.turns])
```

Use `displayTurns` everywhere the component currently uses transcript context:

- rendering `FreshAgentTranscript`
- `localEchoLanded(...)`
- first-message auto-title checks
- `pickCheckpointForTurn(...)`
- fork/rewind context

Delete the `snapshot?.turns ?? []` fallback. A live-only overlay comes from `agentSession.turns`, not HTTP snapshot turns.

Add a visible page loading effect:

```ts
useEffect(() => {
  if (hidden) return
  if (!snapshotThreadId || snapshot?.revision === undefined || snapshot?.revision === null) return
  if (paneContent.provider === 'claude' && claudeSession?.lost) return
  const key = `${paneContent.sessionType}:${paneContent.provider}:${snapshotThreadId}:${snapshot.revision}:visible`
  if (agentSession?.visibleHistoryLoadedKey === key || agentSession?.visibleHistoryRequestKey === key) return
  dispatch(loadFreshAgentThreadTurns({
    sessionType: paneContent.sessionType,
    provider: paneContent.provider,
    sessionId: snapshotThreadId,
    revision: snapshot.revision,
    priority: 'visible',
    includeBodies: true,
    limit: 30,
    ...(paneContent.initialCwd ? { cwd: paneContent.initialCwd } : {}),
  }))
}, [
  agentSession?.visibleHistoryLoadedKey,
  agentSession?.visibleHistoryRequestKey,
  claudeSession?.lost,
  dispatch,
  hidden,
  paneContent.initialCwd,
  paneContent.provider,
  paneContent.sessionType,
  snapshot?.revision,
  snapshotThreadId,
])
```

The visible page effect must not include `snapshotRefreshNonce`, busy status, or pane focus as dependencies that can replay the body-heavy request. It is gated by `hidden`, the concrete `snapshotThreadId`, and exact numeric `snapshot.revision`.

- [ ] **Step 6: Run the visible hydration test and verify it passes**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx -t "rehydrates a restored Freshopencode pane from one visible /turns page"
```

Expected: PASS.

- [ ] **Step 7: Run focused client state coverage**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx \
  test/unit/client/store/freshAgentSlice.test.ts
```

Expected: PASS. If `test/unit/client/store/freshAgentSlice.test.ts` does not exist, add it with focused reducer tests for:

- `historyPageReceived` replacing the first page.
- cursor pages being prepended, not appended.
- `page.bodies` merging into `historyBodies`.
- inline `turn.items` displaying without a `bodies` entry.
- stale thread/revision responses being ignored.
- visible request keys resetting on thread or revision changes, including revision `0`.

Before committing, run:

```bash
rg -n "snapshot\\?\\.turns|snapshot\\.turns|snapshot turns|turns: \\[\\{" src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/e2e-browser/specs
```

Expected: no production `FreshAgentView.tsx` use of `snapshot.turns`, and remaining tests/browser route fixtures only use `turns: []` in snapshots or move transcript rows into `/turns` responses.

- [ ] **Step 8: Commit Task 2**

Run:

```bash
git add src/store/freshAgentTypes.ts \
  src/store/freshAgentSlice.ts \
  src/store/freshAgentThunks.ts \
  src/components/fresh-agent/FreshAgentView.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx \
  test/unit/client/store/freshAgentSlice.test.ts
git commit -m "fix(fresh-agent): hydrate visible transcript through turns"
```

Expected: local commit created; no push.

## Task 3: Warm Older History Under A Budget

**Files:**
- Create: `src/store/freshAgentHistoryWarmQueue.ts`
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx`
- Modify: `src/components/fresh-agent/FreshAgentView.tsx`
- Modify: `src/store/freshAgentSlice.ts`
- Modify: `src/store/freshAgentThunks.ts`
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
- Test: `test/unit/client/store/freshAgentHistoryWarmQueue.test.ts`

**Interfaces:**
- Consumes: `agentSession.nextHistoryCursor`, `agentSession.historyLoading`, `loadFreshAgentThreadTurns`.
- Produces: `FreshAgentTranscript` props `hasOlder`, `loadingOlder`, `onLoadOlder`; one visible-priority `/turns` page request per "Load older history" click; a global low-priority warm-history queue that fetches older pages for hidden/inactive idle panes one at a time until a byte/page budget is exhausted.

**Background Warm-History Rules:**
- Warm only sessions whose effective status is idle. For FreshOpenCode, do not warm while status is `running`, `busy`, `starting`, `connecting`, or any other active state.
- Warm hidden or inactive panes as background work after the first visible page or metadata snapshot identifies a stable `{ sessionType, provider, sessionId, cwd, revision, cursor }`.
- Use `priority: 'background'`, `includeBodies: true`, `limit: 30`, and the same server-side payload cap from Task 5.
- Use global concurrency `1`; visible user requests always run before queued warm requests.
- Budget by bytes and pages, not just page count. Start with `MAX_WARM_HISTORY_BYTES_PER_REHYDRATION = 5 * 1024 * 1024` and `MAX_WARM_HISTORY_PAGES_PER_SESSION = 10`. Stop a session when either budget is exhausted, the cursor ends, the pane becomes busy, the pane becomes visible and issues a visible request, or the revision changes.
- Deduplicate by `{ sessionType, provider, sessionId, cwd, revision, cursor }` so visible hydration and background warming never fetch the same page twice.
- Store warmed pages in the same chronological `historyItems`/`historyBodies` cache. A later tab flip should reuse warm history without issuing another body-heavy latest-page request.

- [ ] **Step 1: Add the failing explicit older-page test**

In `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`, add:

```ts
it('loads one visible older Freshopencode page immediately when the user clicks Load older history', async () => {
  const store = createStore()
  apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
    sessionType: 'freshopencode',
    provider: 'opencode',
    threadId: 'ses_older_pages',
    sessionId: 'ses_older_pages',
    revision: 9,
    latestTurnId: 'msg_new',
    status: 'idle',
    capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: true },
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
    pendingApprovals: [],
    pendingQuestions: [],
    worktrees: [],
    diffs: [],
    childThreads: [],
    turns: [],
    extensions: {},
  })
  apiMock.getFreshAgentTurnPage
    .mockResolvedValueOnce({
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: 'ses_older_pages',
      revision: 9,
      nextCursor: 'older-cursor-1',
      turns: [{ id: 'msg_new', turnId: 'msg_new', role: 'assistant', summary: 'Newest answer', items: [] }],
      bodies: {
        msg_new: { id: 'msg_new', turnId: 'msg_new', role: 'assistant', summary: 'Newest answer', items: [{ id: 'new:text', kind: 'text', text: 'Newest answer' }] },
      },
    })
    .mockResolvedValueOnce({
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: 'ses_older_pages',
      revision: 9,
      nextCursor: null,
      turns: [{ id: 'msg_old', turnId: 'msg_old', role: 'user', summary: 'Older prompt', items: [] }],
      bodies: {
        msg_old: { id: 'msg_old', turnId: 'msg_old', role: 'user', summary: 'Older prompt', items: [{ id: 'old:text', kind: 'text', text: 'Older prompt' }] },
      },
    })
  store.dispatch(initLayout({
    tabId: 'tab-1',
    paneId: 'pane-1',
    content: {
      kind: 'fresh-agent',
      sessionType: 'freshopencode',
      provider: 'opencode',
      createRequestId: 'req-older-pages',
      sessionId: 'ses_older_pages',
      sessionRef: { provider: 'opencode', sessionId: 'ses_older_pages' },
      resumeSessionId: 'ses_older_pages',
      status: 'connected',
    },
  }))

  render(
    <Provider store={store}>
      <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
    </Provider>,
  )

  expect(await screen.findByText('Newest answer')).toBeInTheDocument()
  await act(async () => { await Promise.resolve() })
  expect(apiMock.getFreshAgentTurnPage).toHaveBeenCalledTimes(1)

  fireEvent.click(screen.getByRole('button', { name: 'Load older history' }))

  await waitFor(() => {
    expect(apiMock.getFreshAgentTurnPage).toHaveBeenCalledTimes(2)
  })
  expect(apiMock.getFreshAgentTurnPage).toHaveBeenLastCalledWith(
    'freshopencode',
    'opencode',
    'ses_older_pages',
    expect.objectContaining({
      revision: 9,
      cursor: 'older-cursor-1',
      priority: 'visible',
      includeBodies: true,
      limit: 30,
    }),
  )
  expect(await screen.findByText('Older prompt')).toBeInTheDocument()
  const older = screen.getByText('Older prompt')
  const newest = screen.getByText('Newest answer')
  expect(older.compareDocumentPosition(newest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx -t "loads exactly one older Freshopencode page"
```

Expected: FAIL because there is no "Load older history" control and older pages are not wired.

- [ ] **Step 3: Add the transcript control**

In `src/components/fresh-agent/FreshAgentTranscript.tsx`, extend props:

```ts
  hasOlder?: boolean
  loadingOlder?: boolean
  onLoadOlder?: () => void
```

Destructure defaults:

```ts
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
```

Render this before `displayTurns.map(...)` inside the transcript scroller:

```tsx
{hasOlder && onLoadOlder ? (
  <div className="flex justify-center pb-2">
    <button
      type="button"
      className="rounded border border-border bg-background px-3 py-1 text-xs text-muted-foreground shadow-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
      onClick={onLoadOlder}
      disabled={loadingOlder}
      aria-label="Load older history"
    >
      {loadingOlder ? 'Loading older history' : 'Load older history'}
    </button>
  </div>
) : null}
```

- [ ] **Step 4: Wire one-page older loading in `FreshAgentView`**

In `src/components/fresh-agent/FreshAgentView.tsx`, add:

```ts
const loadOlderHistory = useCallback(() => {
  if (!snapshotThreadId || snapshot?.revision === undefined || snapshot?.revision === null) return
  if (!agentSession?.nextHistoryCursor || agentSession.historyLoading) return
  dispatch(loadFreshAgentThreadTurns({
    sessionType: paneContent.sessionType,
    provider: paneContent.provider,
    sessionId: snapshotThreadId,
    revision: snapshot.revision,
    cursor: agentSession.nextHistoryCursor,
    priority: 'visible',
    includeBodies: true,
    limit: 30,
    ...(paneContent.initialCwd ? { cwd: paneContent.initialCwd } : {}),
  }))
}, [
  agentSession?.historyLoading,
  agentSession?.nextHistoryCursor,
  dispatch,
  paneContent.initialCwd,
  paneContent.provider,
  paneContent.sessionType,
  snapshot?.revision,
  snapshotThreadId,
])
```

Pass props to `FreshAgentTranscript`:

```tsx
hasOlder={Boolean(agentSession?.nextHistoryCursor)}
loadingOlder={Boolean(agentSession?.historyLoading && agentSession?.nextHistoryCursor)}
onLoadOlder={loadOlderHistory}
```

This click path is visible-priority and does not wait for the background queue. It still dedupes against any matching warm request key already in flight.

- [ ] **Step 5: Add the failing warm-history queue tests**

Create `test/unit/client/store/freshAgentHistoryWarmQueue.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_WARM_HISTORY_BYTES_PER_REHYDRATION,
  MAX_WARM_HISTORY_PAGES_PER_SESSION,
  createFreshAgentHistoryWarmQueue,
} from '@/store/freshAgentHistoryWarmQueue'

describe('freshAgentHistoryWarmQueue', () => {
  it('warms hidden idle panes one page at a time under byte and page budgets', async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ nextCursor: 'cursor-2', payloadBytes: 1024 })
      .mockResolvedValueOnce({ nextCursor: null, payloadBytes: 2048 })
    const queue = createFreshAgentHistoryWarmQueue({ fetchPage })

    queue.enqueue({
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionId: 'ses_warm_idle',
      cwd: '/repo',
      revision: 12,
      cursor: 'cursor-1',
      status: 'idle',
    })
    await queue.drainForTest()

    expect(fetchPage).toHaveBeenCalledTimes(2)
    expect(fetchPage.mock.calls[0][0]).toMatchObject({
      sessionId: 'ses_warm_idle',
      revision: 12,
      cursor: 'cursor-1',
      priority: 'background',
      includeBodies: true,
      limit: 30,
    })
    expect(fetchPage.mock.calls[1][0]).toMatchObject({ cursor: 'cursor-2' })
    expect(queue.statsForTest()).toMatchObject({
      bytesUsed: 3072,
      pagesBySession: { ses_warm_idle: 2 },
    })
  })

  it('does not warm busy Freshopencode sessions', async () => {
    const fetchPage = vi.fn()
    const queue = createFreshAgentHistoryWarmQueue({ fetchPage })

    queue.enqueue({
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionId: 'ses_busy_hidden',
      revision: 5,
      cursor: 'cursor-1',
      status: 'running',
    })
    await queue.drainForTest()

    expect(fetchPage).not.toHaveBeenCalled()
  })

  it('stops before exceeding global byte and per-session page budgets', async () => {
    const fetchPage = vi.fn(async () => ({
      nextCursor: 'next',
      payloadBytes: Math.ceil(MAX_WARM_HISTORY_BYTES_PER_REHYDRATION / 2),
    }))
    const queue = createFreshAgentHistoryWarmQueue({ fetchPage })

    queue.enqueue({
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionId: 'ses_budget',
      revision: 5,
      cursor: 'cursor-1',
      status: 'idle',
    })
    await queue.drainForTest()

    expect(fetchPage.mock.calls.length).toBeLessThanOrEqual(MAX_WARM_HISTORY_PAGES_PER_SESSION)
    expect(queue.statsForTest().bytesUsed).toBeLessThanOrEqual(MAX_WARM_HISTORY_BYTES_PER_REHYDRATION)
  })

  it('deduplicates background and visible request keys', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ nextCursor: null, payloadBytes: 512 })
    const queue = createFreshAgentHistoryWarmQueue({ fetchPage })
    const input = {
      sessionType: 'freshopencode' as const,
      provider: 'opencode' as const,
      sessionId: 'ses_dedupe',
      revision: 8,
      cursor: 'cursor-1',
      status: 'idle' as const,
    }

    queue.enqueue(input)
    queue.enqueue(input)
    await queue.drainForTest()

    expect(fetchPage).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 6: Run the warm-history queue tests and verify they fail**

Run:

```bash
npm run test:vitest -- --run test/unit/client/store/freshAgentHistoryWarmQueue.test.ts
```

Expected: FAIL because `freshAgentHistoryWarmQueue` does not exist.

- [ ] **Step 7: Implement the budgeted warm-history queue**

Create `src/store/freshAgentHistoryWarmQueue.ts`:

```ts
import type { FreshAgentRuntimeProvider, FreshAgentSessionType, FreshAgentSessionStatus } from '@shared/fresh-agent'

export const MAX_WARM_HISTORY_BYTES_PER_REHYDRATION = 5 * 1024 * 1024
export const MAX_WARM_HISTORY_PAGES_PER_SESSION = 10
export const WARM_HISTORY_PAGE_LIMIT = 30

const ACTIVE_STATUSES = new Set<FreshAgentSessionStatus>([
  'starting',
  'connecting',
  'running',
  'busy',
  'needs_input',
])

export type WarmHistoryInput = {
  sessionType: FreshAgentSessionType
  provider: FreshAgentRuntimeProvider
  sessionId: string
  cwd?: string
  revision: number
  cursor: string
  status: FreshAgentSessionStatus
}

export type WarmHistoryFetchInput = Omit<WarmHistoryInput, 'status'> & {
  priority: 'background'
  includeBodies: true
  limit: number
}

export type WarmHistoryFetchResult = {
  nextCursor?: string | null
  payloadBytes: number
}

type QueueDeps = {
  fetchPage(input: WarmHistoryFetchInput): Promise<WarmHistoryFetchResult>
}

function keyFor(input: Pick<WarmHistoryInput, 'sessionType' | 'provider' | 'sessionId' | 'cwd' | 'revision' | 'cursor'>): string {
  return [input.sessionType, input.provider, input.sessionId, input.cwd ?? '', input.revision, input.cursor].join('\u0000')
}

function canWarm(input: WarmHistoryInput): boolean {
  return !ACTIVE_STATUSES.has(input.status)
}

export function createFreshAgentHistoryWarmQueue(deps: QueueDeps) {
  const pending: WarmHistoryInput[] = []
  const seen = new Set<string>()
  const pagesBySession: Record<string, number> = {}
  let bytesUsed = 0
  let running = false

  async function pump(): Promise<void> {
    if (running) return
    running = true
    try {
      while (pending.length > 0) {
        const next = pending.shift()
        if (!next || !canWarm(next)) continue
        if (bytesUsed >= MAX_WARM_HISTORY_BYTES_PER_REHYDRATION) continue
        const pages = pagesBySession[next.sessionId] ?? 0
        if (pages >= MAX_WARM_HISTORY_PAGES_PER_SESSION) continue

        const result = await deps.fetchPage({
          sessionType: next.sessionType,
          provider: next.provider,
          sessionId: next.sessionId,
          cwd: next.cwd,
          revision: next.revision,
          cursor: next.cursor,
          priority: 'background',
          includeBodies: true,
          limit: WARM_HISTORY_PAGE_LIMIT,
        })
        bytesUsed += Math.max(0, result.payloadBytes)
        pagesBySession[next.sessionId] = pages + 1
        if (
          result.nextCursor
          && bytesUsed < MAX_WARM_HISTORY_BYTES_PER_REHYDRATION
          && pagesBySession[next.sessionId] < MAX_WARM_HISTORY_PAGES_PER_SESSION
        ) {
          enqueue({ ...next, cursor: result.nextCursor })
        }
      }
    } finally {
      running = false
    }
  }

  function enqueue(input: WarmHistoryInput): void {
    if (!canWarm(input)) return
    const key = keyFor(input)
    if (seen.has(key)) return
    seen.add(key)
    pending.push(input)
    void pump()
  }

  return {
    enqueue,
    drainForTest: pump,
    statsForTest: () => ({ bytesUsed, pagesBySession: { ...pagesBySession } }),
  }
}
```

When wiring this queue into Redux/React, use `dispatch(loadFreshAgentThreadTurns(...)).unwrap()` as `fetchPage`, then return `{ nextCursor: page.nextCursor, payloadBytes: page.payloadBytes ?? Buffer.byteLength(JSON.stringify(page), 'utf8') }`. If `Buffer` is unavailable in the browser bundle, use `new TextEncoder().encode(JSON.stringify(page)).byteLength`.

- [ ] **Step 8: Enqueue hidden idle sessions from `FreshAgentView`**

In `src/components/fresh-agent/FreshAgentView.tsx`, after the first metadata snapshot and `agentSession.nextHistoryCursor` are known, enqueue the warm-history cursor when the pane is hidden or inactive and idle:

```ts
useEffect(() => {
  if (!hidden) return
  if (!snapshotThreadId || snapshot?.revision === undefined || snapshot?.revision === null) return
  if (!agentSession?.nextHistoryCursor) return
  if (!effectiveStatus || BUSY_STATES.has(effectiveStatus) || EARLY_STATES.has(effectiveStatus)) return
  freshAgentHistoryWarmQueue.enqueue({
    sessionType: paneContent.sessionType,
    provider: paneContent.provider,
    sessionId: snapshotThreadId,
    cwd: paneContent.initialCwd,
    revision: snapshot.revision,
    cursor: agentSession.nextHistoryCursor,
    status: effectiveStatus,
  })
}, [
  agentSession?.nextHistoryCursor,
  effectiveStatus,
  hidden,
  paneContent.initialCwd,
  paneContent.provider,
  paneContent.sessionType,
  snapshot?.revision,
  snapshotThreadId,
])
```

Visible panes use the visible-priority path from Task 2 and the click path above. Background warming must never block visible hydration.

- [ ] **Step 9: Run the explicit older-page and warm-history tests and verify they pass**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx -t "loads exactly one older Freshopencode page"
npm run test:vitest -- --run test/unit/client/store/freshAgentHistoryWarmQueue.test.ts
```

Expected: PASS. The explicit click path runs one visible-priority page immediately. The background queue warms hidden idle sessions under a byte/page budget, skips busy FreshOpenCode sessions, and deduplicates matching page keys.

- [ ] **Step 10: Commit Task 3**

Run:

```bash
git add src/store/freshAgentHistoryWarmQueue.ts \
  test/unit/client/store/freshAgentHistoryWarmQueue.test.ts \
  src/store/freshAgentThunks.ts \
  src/components/fresh-agent/FreshAgentView.tsx \
  src/components/fresh-agent/FreshAgentTranscript.tsx \
  src/store/freshAgentSlice.ts \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
git commit -m "fix(fresh-agent): warm older transcript history under budget"
```

Expected: local commit created; no push.

## Task 4: Decouple Busy/Status Refresh From Transcript Loading

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentView.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

**Interfaces:**
- Consumes: visible page hydration from Task 2.
- Produces: separate metadata refresh and transcript refresh triggers; busy polling refreshes snapshots only; transcript body page requests are deduped by `{ threadId, revision, reason }`.

- [ ] **Step 1: Add the failing busy-poll regression test**

In `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`, add:

```ts
it('busy status polling refreshes snapshots without repeating body-heavy turn pages', async () => {
  vi.useFakeTimers()
  try {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: 'ses_busy_poll',
      sessionId: 'ses_busy_poll',
      revision: 31,
      latestTurnId: 'msg_busy',
      status: 'running',
      capabilities: { send: false, interrupt: true, approvals: false, questions: false, fork: true },
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      pendingApprovals: [],
      pendingQuestions: [],
      worktrees: [],
      diffs: [],
      childThreads: [],
      turns: [],
      extensions: {},
    })
    apiMock.getFreshAgentTurnPage.mockResolvedValue({
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: 'ses_busy_poll',
      revision: 31,
      nextCursor: null,
      turns: [{ id: 'msg_busy', turnId: 'msg_busy', role: 'assistant', summary: 'Busy body', items: [] }],
      bodies: {
        msg_busy: { id: 'msg_busy', turnId: 'msg_busy', role: 'assistant', summary: 'Busy body', items: [{ id: 'busy:text', kind: 'text', text: 'Busy body' }] },
      },
    })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-busy-poll',
        sessionId: 'ses_busy_poll',
        sessionRef: { provider: 'opencode', sessionId: 'ses_busy_poll' },
        resumeSessionId: 'ses_busy_poll',
        status: 'running',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    expect(await screen.findByText('Busy body')).toBeInTheDocument()
    expect(apiMock.getFreshAgentTurnPage).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(6500)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(apiMock.getFreshAgentThreadSnapshot.mock.calls.length).toBeGreaterThan(1)
    expect(apiMock.getFreshAgentTurnPage).toHaveBeenCalledTimes(1)
    expect(apiMock.getFreshAgentTurnPage.mock.calls[0][3]).toMatchObject({ includeBodies: true })
  } finally {
    vi.useRealTimers()
  }
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx -t "busy status polling refreshes snapshots"
```

Expected: FAIL if the busy poll still shares the same trigger as transcript body loading.

- [ ] **Step 3: Split refresh triggers**

In `src/components/fresh-agent/FreshAgentView.tsx`, replace the single transcript-affecting `snapshotRefreshNonce` with:

```ts
const [metadataRefreshNonce, setMetadataRefreshNonce] = useState(0)
const [transcriptRefreshNonce, setTranscriptRefreshNonce] = useState(0)
const lastVisibleBodyPageKeyRef = useRef<string | null>(null)
```

Use `metadataRefreshNonce` in the snapshot effect dependency list. Do not include `transcriptRefreshNonce` in that effect.

In the WebSocket handler:

```ts
if (message.type === 'freshAgent.send.accepted' && typeof message.requestId === 'string') {
  ...
  setTranscriptRefreshNonce((value) => value + 1)
}

if (
  message.type === 'freshAgent.event'
  && message.sessionId === paneContent.sessionId
  && message.sessionType === paneContent.sessionType
  && message.provider === paneContent.provider
) {
  const eventType = typeof message.event === 'object' && message.event && 'type' in message.event
    ? (message.event as { type?: unknown }).type
    : undefined
  if (eventType === 'freshAgent.session.changed') {
    setTranscriptRefreshNonce((value) => value + 1)
  } else {
    setMetadataRefreshNonce((value) => value + 1)
  }
}
```

In the busy interval effect, increment only metadata:

```ts
const timer = window.setInterval(() => {
  setMetadataRefreshNonce((value) => value + 1)
}, 3000)
```

In the visible page effect from Task 2, dedupe body page requests:

```ts
const key = `${paneContent.sessionType}:${paneContent.provider}:${snapshotThreadId}:${snapshot.revision}:visible:${transcriptRefreshNonce}`
if (lastVisibleBodyPageKeyRef.current === key) return
lastVisibleBodyPageKeyRef.current = key
```

Only increment `transcriptRefreshNonce` for transcript-change events. Do not increment it for status snapshots, `freshAgent.status`, `sdk.session.snapshot`, idle/running polling, or pane focus.

- [ ] **Step 4: Run the busy-poll regression test and verify it passes**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx -t "busy status polling refreshes snapshots"
```

Expected: PASS.

- [ ] **Step 5: Run the FreshAgentView suite**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
```

Expected: PASS. Update older snapshot-refresh tests so they expect transcript changes through `/turns`, not snapshot `turns`.

- [ ] **Step 6: Commit Task 4**

Run:

```bash
git add src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
git commit -m "fix(fresh-agent): separate status polling from transcript hydration"
```

Expected: local commit created; no push.

## Task 5: Cap Turn Page Payloads And Add Structured Observability

**Files:**
- Create: `server/fresh-agent/turn-page-payload.ts`
- Test: `test/unit/server/fresh-agent/turn-page-payload.test.ts`
- Modify: `server/fresh-agent/runtime-manager.ts`
- Modify: `server/fresh-agent/observability.ts`
- Modify: `server/fresh-agent/router.ts`
- Test: `test/unit/server/fresh-agent/observability.test.ts`
- Test: `test/unit/server/fresh-agent/router.test.ts`

**Interfaces:**
- Consumes: `/fresh-agent/threads/:sessionType/:provider/:threadId/turns` response object.
- Produces: capped first-page body payloads, chronological page windows, and `fresh_agent_turn_page_served` JSONL events with hashed IDs and fields `payloadBytes`, `includeBodies`, `priority`, `turnCount`, `durationMs`, and `truncatedBodyCount`.

- [ ] **Step 1: Add the failing payload-cap unit tests**

Create `test/unit/server/fresh-agent/turn-page-payload.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { capFreshAgentTurnPagePayload } from '../../../../server/fresh-agent/turn-page-payload.js'
import type { FreshAgentTurnPage } from '../../../../shared/fresh-agent-contract.js'

function makePage(text: string): FreshAgentTurnPage {
  return {
    sessionType: 'freshopencode',
    provider: 'opencode',
    threadId: 'ses_payload_cap',
    revision: 0,
    nextCursor: null,
    turns: [{
      id: 'msg-1',
      turnId: 'msg-1',
      role: 'assistant',
      summary: 'Large output',
      items: [{ id: 'msg-1:text', kind: 'text', text }],
    }],
  }
}

describe('capFreshAgentTurnPagePayload', () => {
  it('leaves small inline OpenCode turn bodies intact', () => {
    const result = capFreshAgentTurnPagePayload(makePage('small body'), {
      includeBodies: true,
      maxPayloadBytes: 1024,
    })

    expect(result.truncatedBodyCount).toBe(0)
    expect(result.page.turns[0].items).toEqual([{ id: 'msg-1:text', kind: 'text', text: 'small body' }])
  })

  it('converts oversized inline bodies to summary-only rows under the payload cap', () => {
    const result = capFreshAgentTurnPagePayload(makePage('x'.repeat(20_000)), {
      includeBodies: true,
      maxPayloadBytes: 4096,
    })

    expect(result.truncatedBodyCount).toBe(1)
    expect(result.payloadBytes).toBeLessThanOrEqual(4096)
    expect(result.page.turns[0]).toMatchObject({
      turnId: 'msg-1',
      summary: 'Large output',
      items: [],
    })
  })

  it('caps oversized entries from the bodies map without dropping chronological turn rows', () => {
    const page = makePage('summary row')
    page.bodies = {
      'msg-1': {
        ...page.turns[0],
        items: [{ id: 'msg-1:body', kind: 'text', text: 'y'.repeat(20_000) }],
      },
    }

    const result = capFreshAgentTurnPagePayload(page, {
      includeBodies: true,
      maxPayloadBytes: 4096,
    })

    expect(result.truncatedBodyCount).toBe(1)
    expect(result.page.turns.map((turn) => turn.turnId)).toEqual(['msg-1'])
    expect(result.page.bodies).toEqual({})
  })
})
```

- [ ] **Step 2: Add the payload cap helper and runtime-manager hook**

Create `server/fresh-agent/turn-page-payload.ts`:

```ts
import type { FreshAgentTurn, FreshAgentTurnPage } from '../../shared/fresh-agent-contract.js'

export const MAX_FRESH_AGENT_TURN_PAGE_BODY_BYTES = 128 * 1024

export type FreshAgentTurnPagePayloadCapResult = {
  page: FreshAgentTurnPage
  payloadBytes: number
  truncatedBodyCount: number
}

const capMetricsSymbol = Symbol('freshAgentTurnPagePayloadCapMetrics')

export function readFreshAgentTurnPagePayloadCapMetrics(
  page: FreshAgentTurnPage,
): { payloadBytes: number; truncatedBodyCount: number } | undefined {
  return (page as FreshAgentTurnPage & {
    [capMetricsSymbol]?: { payloadBytes: number; truncatedBodyCount: number }
  })[capMetricsSymbol]
}

function attachMetrics(
  page: FreshAgentTurnPage,
  metrics: { payloadBytes: number; truncatedBodyCount: number },
): FreshAgentTurnPage {
  Object.defineProperty(page, capMetricsSymbol, {
    value: metrics,
    enumerable: false,
    configurable: false,
  })
  return page
}

function payloadBytes(page: FreshAgentTurnPage): number {
  return Buffer.byteLength(JSON.stringify(page), 'utf8')
}

function summaryOnly(turn: FreshAgentTurn): FreshAgentTurn {
  return { ...turn, items: [] }
}

function chronologicalTurns(turns: FreshAgentTurn[]): FreshAgentTurn[] {
  return [...turns].sort((a, b) => {
    const ordinalA = typeof a.ordinal === 'number' ? a.ordinal : Number.POSITIVE_INFINITY
    const ordinalB = typeof b.ordinal === 'number' ? b.ordinal : Number.POSITIVE_INFINITY
    if (ordinalA !== ordinalB) return ordinalA - ordinalB
    const timeA = a.timestamp ? Date.parse(a.timestamp) : Number.NaN
    const timeB = b.timestamp ? Date.parse(b.timestamp) : Number.NaN
    if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) return timeA - timeB
    return 0
  })
}

export function normalizeFreshAgentTurnPageOrder(page: FreshAgentTurnPage): FreshAgentTurnPage {
  const turns = chronologicalTurns(page.turns)
  return { ...page, turns }
}

export function capFreshAgentTurnPagePayload(
  page: FreshAgentTurnPage,
  options: { includeBodies?: boolean; maxPayloadBytes?: number } = {},
): FreshAgentTurnPagePayloadCapResult {
  const maxPayloadBytes = options.maxPayloadBytes ?? MAX_FRESH_AGENT_TURN_PAGE_BODY_BYTES
  let nextPage: FreshAgentTurnPage = {
    ...page,
    turns: [...page.turns],
    ...(page.bodies ? { bodies: { ...page.bodies } } : {}),
  }
  let truncatedBodyCount = 0
  if (!options.includeBodies || payloadBytes(nextPage) <= maxPayloadBytes) {
    const bytes = payloadBytes(nextPage)
    return { page: attachMetrics(nextPage, { payloadBytes: bytes, truncatedBodyCount }), payloadBytes: bytes, truncatedBodyCount }
  }

  if (nextPage.bodies) {
    for (const turnId of Object.keys(nextPage.bodies)) {
      const candidate = { ...nextPage, bodies: { ...nextPage.bodies } }
      delete candidate.bodies?.[turnId]
      if (payloadBytes(candidate) < payloadBytes(nextPage)) {
        nextPage = candidate
        truncatedBodyCount += 1
      }
      if (payloadBytes(nextPage) <= maxPayloadBytes) {
        const bytes = payloadBytes(nextPage)
        return { page: attachMetrics(nextPage, { payloadBytes: bytes, truncatedBodyCount }), payloadBytes: bytes, truncatedBodyCount }
      }
    }
  }

  for (let index = nextPage.turns.length - 1; index >= 0; index -= 1) {
    if (nextPage.turns[index].items.length === 0) continue
    nextPage = {
      ...nextPage,
      turns: nextPage.turns.map((turn, turnIndex) => (
        turnIndex === index ? summaryOnly(turn) : turn
      )),
    }
    truncatedBodyCount += 1
    if (payloadBytes(nextPage) <= maxPayloadBytes) break
  }

  const bytes = payloadBytes(nextPage)
  return { page: attachMetrics(nextPage, { payloadBytes: bytes, truncatedBodyCount }), payloadBytes: bytes, truncatedBodyCount }
}
```

In `server/fresh-agent/runtime-manager.ts`, call the helper after `adapter.getTurnPage(...)` and before `FreshAgentTurnPageSchema.safeParse(page)`:

```ts
import {
  capFreshAgentTurnPagePayload,
  normalizeFreshAgentTurnPageOrder,
} from './turn-page-payload.js'

const orderedPage = normalizeFreshAgentTurnPageOrder(page)
const capped = capFreshAgentTurnPagePayload(orderedPage, { includeBodies: input.includeBodies === true })
const parsed = FreshAgentTurnPageSchema.safeParse(capped.page)
...
return parsed.data
```

Keep the returned value contract-compatible. If the helper needs to expose `payloadBytes` and `truncatedBodyCount` to the router without changing the shared page schema, attach them through a non-enumerable symbol exported from `turn-page-payload.ts`, or recompute the metrics in the router from the capped page. Do not add raw transcript text to logs.

- [ ] **Step 3: Add the failing observability unit test**

In `test/unit/server/fresh-agent/observability.test.ts`, add:

```ts
it('logs fresh_agent_turn_page_served with request-shape metrics and hashed ids', () => {
  recordFreshAgentObservabilityEvent({
    kind: 'fresh_agent_turn_page_served',
    sessionType: 'freshopencode',
    provider: 'opencode',
    threadIdHash: hashForLogs('ses_real_1'),
    httpStatus: 200,
    durationMs: 18.25,
    payloadBytes: 4096,
    turnCount: 20,
    truncatedBodyCount: 0,
    includeBodies: true,
    priority: 'visible',
    revision: 45,
    cursorPresent: false,
    nextCursorPresent: true,
  })

  expect(infoSpy).toHaveBeenCalledTimes(1)
  const [payload, msg] = infoSpy.mock.calls[0]
  expect(payload).toMatchObject({
    event: 'fresh_agent_turn_page_served',
    component: 'fresh-agent-observability',
    sessionType: 'freshopencode',
    provider: 'opencode',
    threadIdHash: hashForLogs('ses_real_1'),
    httpStatus: 200,
    durationMs: 18.25,
    payloadBytes: 4096,
    turnCount: 20,
    truncatedBodyCount: 0,
    includeBodies: true,
    priority: 'visible',
    revision: 45,
    cursorPresent: false,
    nextCursorPresent: true,
  })
  expect(msg).toBe('fresh_agent_turn_page_served')
  expect(JSON.stringify(payload)).not.toContain('ses_real_1')
})
```

- [ ] **Step 4: Add the failing router integration test**

In `test/unit/server/fresh-agent/router.test.ts`, add a helper beside `findSnapshotServedEvents`:

```ts
function findTurnPageServedEvents(): Array<Record<string, unknown>> {
  return observabilityMocks.recordFreshAgentObservabilityEvent.mock.calls
    .map(([event]) => event as Record<string, unknown>)
    .filter((event) => event.kind === 'fresh_agent_turn_page_served')
}
```

Add:

```ts
it('logs fresh_agent_turn_page_served for successful /turns responses', async () => {
  observabilityMocks.recordFreshAgentObservabilityEvent.mockClear()
  const manager = {
    getTurnPage: vi.fn().mockResolvedValue({
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: 'ses_turn_page_1',
      revision: 9,
      nextCursor: 'cursor-2',
      turns: [
        { id: 'msg-1', turnId: 'msg-1', role: 'user', summary: 'hello', items: [] },
        { id: 'msg-2', turnId: 'msg-2', role: 'assistant', summary: 'world', items: [] },
      ],
      bodies: {
        'msg-1': { id: 'msg-1', turnId: 'msg-1', role: 'user', summary: 'hello', items: [{ id: 'msg-1:text', kind: 'text', text: 'hello' }] },
      },
    }),
  } as unknown as FreshAgentRuntimeManager
  const app = express()
  app.use('/api', createFreshAgentRouter({ runtimeManager: manager }))

  await request(app)
    .get('/api/fresh-agent/threads/freshopencode/opencode/ses_turn_page_1/turns?revision=9&priority=visible&includeBodies=true&limit=2')
    .expect(200)

  const events = findTurnPageServedEvents()
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    sessionType: 'freshopencode',
    provider: 'opencode',
    httpStatus: 200,
      turnCount: 2,
      truncatedBodyCount: 0,
      includeBodies: true,
    priority: 'visible',
    revision: 9,
    cursorPresent: false,
    nextCursorPresent: true,
  })
  expect(events[0].payloadBytes).toBeGreaterThan(0)
  expect(events[0].durationMs).toBeGreaterThanOrEqual(0)
  expect(JSON.stringify(events[0])).not.toContain('ses_turn_page_1')
})
```

- [ ] **Step 5: Run the tests and verify they fail**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/server/fresh-agent/observability.test.ts \
  test/unit/server/fresh-agent/router.test.ts -t "fresh_agent_turn_page_served|turn page"
```

Expected: FAIL because the payload cap helper, event kind, and router logging do not exist.

- [ ] **Step 6: Add the event type and payload builder**

In `server/fresh-agent/observability.ts`, extend `FreshAgentObservabilityEvent`:

```ts
  | {
    kind: 'fresh_agent_turn_page_served'
    sessionType: string
    provider: string
    threadIdHash: string
    httpStatus: number
    durationMs: number
    payloadBytes: number
    turnCount: number
    truncatedBodyCount: number
    includeBodies: boolean
    priority: 'visible' | 'background'
    revision?: number
    cursorPresent: boolean
    nextCursorPresent: boolean
    cwdHash?: string
  }
```

Add a `buildPayload` case:

```ts
case 'fresh_agent_turn_page_served':
  return {
    ...base,
    sessionType: event.sessionType,
    provider: event.provider,
    threadIdHash: event.threadIdHash,
    httpStatus: event.httpStatus,
    durationMs: event.durationMs,
    payloadBytes: event.payloadBytes,
    turnCount: event.turnCount,
    truncatedBodyCount: event.truncatedBodyCount,
    includeBodies: event.includeBodies,
    priority: event.priority,
    ...(event.revision !== undefined ? { revision: event.revision } : {}),
    cursorPresent: event.cursorPresent,
    nextCursorPresent: event.nextCursorPresent,
    ...(event.cwdHash ? { cwdHash: event.cwdHash } : {}),
  }
```

- [ ] **Step 7: Record the event in the router**

In `server/fresh-agent/router.ts`, add a start timestamp before scheduling `/turns` work:

```ts
import { readFreshAgentTurnPagePayloadCapMetrics } from './turn-page-payload.js'

const turnPageStart = Date.now()
```

After the page is produced and before or immediately after `res.json(page)`, compute payload bytes once:

```ts
const payloadBytes = Buffer.byteLength(JSON.stringify(page), 'utf8')
setResponsePerfContext(res, {
  readModelLane: query.data.priority ?? 'visible',
  responsePayloadBytes: payloadBytes,
})
res.json(page)
recordFreshAgentObservabilityEvent({
  kind: 'fresh_agent_turn_page_served',
  sessionType: params.data.sessionType,
  provider: params.data.provider,
  threadIdHash: hashForLogs(params.data.threadId),
  httpStatus: 200,
  durationMs: Date.now() - turnPageStart,
  payloadBytes,
  turnCount: Array.isArray((page as { turns?: unknown[] }).turns) ? (page as { turns: unknown[] }).turns.length : 0,
  truncatedBodyCount: readFreshAgentTurnPagePayloadCapMetrics(page)?.truncatedBodyCount ?? 0,
  includeBodies: query.data.includeBodies === true,
  priority: query.data.priority ?? 'visible',
  ...(typeof (page as { revision?: unknown }).revision === 'number' ? { revision: (page as { revision: number }).revision } : {}),
  cursorPresent: Boolean(query.data.cursor),
  nextCursorPresent: Boolean((page as { nextCursor?: unknown }).nextCursor),
  ...(query.data.cwd ? { cwdHash: hashForLogs(query.data.cwd) } : {}),
})
```

Do not log failures as served events. Existing HTTP request logs will still record non-200 status.

- [ ] **Step 8: Run observability tests and verify they pass**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/server/fresh-agent/observability.test.ts \
  test/unit/server/fresh-agent/router.test.ts \
  test/unit/server/fresh-agent/turn-page-payload.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 5**

Run:

```bash
git add server/fresh-agent/observability.ts \
  server/fresh-agent/turn-page-payload.ts \
  server/fresh-agent/runtime-manager.ts \
  server/fresh-agent/router.ts \
  test/unit/server/fresh-agent/turn-page-payload.test.ts \
  test/unit/server/fresh-agent/observability.test.ts \
  test/unit/server/fresh-agent/router.test.ts
git commit -m "feat(fresh-agent): log turn page serving metrics"
```

Expected: local commit created; no push.

## Task 6: Prove The Restored FreshOpenCode User Story End-To-End

**Files:**
- Modify: `test/e2e-browser/fixtures/fake-opencode.cjs`
- Modify: `test/e2e-browser/specs/freshopencode-db-history.spec.ts`

**Interfaces:**
- Consumes: TestServer, fake OpenCode `serve` endpoints, metadata-only snapshots, visible `/turns` page hydration, `fresh_agent_turn_page_served` logs.
- Produces: Playwright smoke proving a restored FreshOpenCode pane renders from one bounded visible body page after reload, uses `opencode serve` session/message endpoints, and does not repeat body-heavy requests.

- [ ] **Step 1: Extend the fake OpenCode serve endpoints**

In `test/e2e-browser/fixtures/fake-opencode.cjs`, add helpers after `readExport(sessionId)`:

```js
function readSessionInfo(sessionId) {
  const exported = readExport(sessionId)
  return exported.info || { id: sessionId, time: { updated: 0 } }
}

function readMessagePage(sessionId, input = {}) {
  const limit = Number.isFinite(Number(input.limit)) ? Math.max(1, Number(input.limit)) : 30
  const exported = readExport(sessionId)
  const messages = Array.isArray(exported.messages) ? exported.messages : []
  const before = typeof input.before === 'string' && input.before.length > 0 ? input.before : null
  const beforeIndex = before ? messages.findIndex((message) => message?.info?.id === before) : -1
  const endExclusive = beforeIndex >= 0 ? beforeIndex : messages.length
  const start = Math.max(0, endExclusive - limit)
  return {
    messages: messages.slice(start, endExclusive),
    nextCursor: start > 0 ? messages[start].info.id : null,
  }
}

function readSingleMessage(sessionId, messageId) {
  return readExport(sessionId).messages.find((message) => message?.info?.id === messageId) || null
}
```

Add these HTTP handlers before the final 404:

```js
const sessionMatch = url.pathname.match(/^\/session\/([^/]+)$/)
if (sessionMatch && req.method === 'GET') {
  const sessionId = decodeURIComponent(sessionMatch[1])
  appendAudit({ event: 'serve_session_get', sessionId, dbPath })
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(readSessionInfo(sessionId)))
  return
}

const messagePageMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/)
if (messagePageMatch && req.method === 'GET') {
  const sessionId = decodeURIComponent(messagePageMatch[1])
  const page = readMessagePage(sessionId, {
    limit: url.searchParams.get('limit'),
    before: url.searchParams.get('before'),
  })
  appendAudit({ event: 'serve_message_list', sessionId, limit: url.searchParams.get('limit'), before: url.searchParams.get('before'), dbPath })
  res.writeHead(200, {
    'content-type': 'application/json',
    ...(page.nextCursor ? { 'x-next-cursor': page.nextCursor } : {}),
  })
  res.end(JSON.stringify(page.messages))
  return
}

const messageBodyMatch = url.pathname.match(/^\/session\/([^/]+)\/message\/([^/]+)$/)
if (messageBodyMatch && req.method === 'GET') {
  const sessionId = decodeURIComponent(messageBodyMatch[1])
  const messageId = decodeURIComponent(messageBodyMatch[2])
  const message = readSingleMessage(sessionId, messageId)
  appendAudit({ event: 'serve_message_get', sessionId, messageId, dbPath })
  res.writeHead(message ? 200 : 404, { 'content-type': 'application/json' })
  res.end(JSON.stringify(message ?? { error: 'not found' }))
  return
}

const promptAsyncMatch = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/)
if (promptAsyncMatch && req.method === 'POST') {
  const sessionId = decodeURIComponent(promptAsyncMatch[1])
  let bodyText = ''
  req.setEncoding('utf8')
  req.on('data', (chunk) => { bodyText += chunk })
  req.on('end', () => {
    const input = parseJsonText(bodyText) || {}
    const prompt = Array.isArray(input.parts)
      ? input.parts.map((part) => typeof part.text === 'string' ? part.text : '').join('\n').trim()
      : ''
    const responseText = process.env.FAKE_OPENCODE_RESPONSE_TEXT || `Fake OpenCode response: ${prompt}`
    seedRunDatabase({ sessionId, prompt, responseText })
    appendAudit({ event: 'serve_prompt_async', sessionId, prompt, dbPath })
    setTimeout(() => {
      for (const client of eventClients) {
        client.write(`data: ${JSON.stringify({ type: 'session.idle', properties: { sessionID: sessionId } })}\n\n`)
      }
    }, 10)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  return
}
```

This fixture change matches the current adapter path: `OpencodeServeManager.getSession()` calls `GET /session/:id`, `listMessages()` calls `GET /session/:id/message`, `getMessage()` calls `GET /session/:id/message/:messageId`, and sends use `POST /session/:id/prompt_async`.

- [ ] **Step 2: Add request and log helpers to the spec**

In `test/e2e-browser/specs/freshopencode-db-history.spec.ts`, add:

```ts
async function readJsonl(filePath: string): Promise<Array<Record<string, any>>> {
  const text = await fsp.readFile(filePath, 'utf8')
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>)
}

function isFreshopencodeTurnsUrl(rawUrl: string): boolean {
  const url = new URL(rawUrl)
  return /^\/api\/fresh-agent\/threads\/freshopencode\/opencode\/[^/]+\/turns$/.test(url.pathname)
}

function isFreshopencodeSnapshotUrl(rawUrl: string): boolean {
  const url = new URL(rawUrl)
  return /^\/api\/fresh-agent\/threads\/freshopencode\/opencode\/[^/]+$/.test(url.pathname)
}
```

- [ ] **Step 3: Add the failing smoke test**

In `test/e2e-browser/specs/freshopencode-db-history.spec.ts`, rename the describe block from `Freshopencode DB history restore` to `Freshopencode serve history restore`, then add:

```ts
test('restored Freshopencode pane hydrates quickly with one body-heavy visible page', async ({ page }) => {
  const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-freshopencode-rehydrate-'))
  const binDir = path.join(sharedRoot, 'bin')
  const logsDir = path.join(sharedRoot, 'logs')
  const auditLogPath = path.join(sharedRoot, 'fake-opencode-audit.jsonl')
  const sharedOpencodeDataDir = path.join(sharedRoot, 'opencode-data')
  const cwd = path.join(sharedRoot, 'project')
  const prompt = 'Restore without repeated body requests'
  const response = 'Freshopencode fast rehydration response'
  const requestUrls: string[] = []
  await fsp.mkdir(cwd, { recursive: true })
  await installFakeOpencode(binDir)

  const server = new TestServer(createServerOptions({
    binDir,
    auditLogPath,
    logsDir,
    sharedOpencodeDataDir,
    env: {
      FAKE_OPENCODE_TRUNCATE_EXPORT: '1',
      FAKE_OPENCODE_RESPONSE_TEXT: response,
    },
  }))

  page.on('request', (req) => {
    const url = req.url()
    if (isFreshopencodeTurnsUrl(url) || isFreshopencodeSnapshotUrl(url)) {
      requestUrls.push(url)
    }
  })

  try {
    const info = await server.start()
    await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
    const harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()
    await enableFreshOpencode(page)
    await createFreshopencodePane(page, cwd)
    await sendFreshAgentPrompt(page, prompt)
    await expect(page.getByText(response)).toBeVisible({ timeout: 30_000 })

    await page.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
    })

    requestUrls.length = 0
    const reloadStartedAt = Date.now()
    await page.reload()
    await harness.waitForHarness()
    await harness.waitForConnection()
    await expect(page.getByText(prompt)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(response)).toBeVisible({ timeout: 10_000 })
    const restoredVisibleMs = Date.now() - reloadStartedAt

    const turnUrls = requestUrls.filter(isFreshopencodeTurnsUrl)
    const bodyTurnUrls = turnUrls.filter((url) => new URL(url).searchParams.get('includeBodies') === 'true')
    const snapshotUrls = requestUrls.filter(isFreshopencodeSnapshotUrl)
    expect(snapshotUrls.length).toBeGreaterThanOrEqual(1)
    expect(bodyTurnUrls).toHaveLength(1)
    expect(turnUrls.length).toBe(1)
    expect(restoredVisibleMs).toBeLessThan(10_000)

    const serverLogs = await readJsonl(info.debugLogPath)
    const turnPageEvents = serverLogs.filter((entry) => entry.event === 'fresh_agent_turn_page_served')
    const bodyEvents = turnPageEvents.filter((entry) => entry.provider === 'opencode' && entry.includeBodies === true)
    expect(bodyEvents).toHaveLength(1)
    expect(bodyEvents[0]).toMatchObject({
      sessionType: 'freshopencode',
      provider: 'opencode',
      priority: 'visible',
      includeBodies: true,
      turnCount: expect.any(Number),
      payloadBytes: expect.any(Number),
      durationMs: expect.any(Number),
    })
    expect(bodyEvents[0].payloadBytes).toBeLessThan(128 * 1024)

    const auditEvents = (await readJsonl(auditLogPath)).map((entry) => entry.event)
    expect(auditEvents).toContain('serve_session_get')
    expect(auditEvents).toContain('serve_message_list')
    expect(auditEvents).toContain('serve_prompt_async')
    expect(auditEvents).not.toContain('export')
  } finally {
    await server.stop().catch(() => {})
    await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
  }
})
```

- [ ] **Step 4: Run the smoke test and verify it fails before the implementation is complete**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/freshopencode-db-history.spec.ts -g "one body-heavy visible page"
```

Expected before Tasks 1-5: FAIL because the fake OpenCode fixture does not yet expose the current `opencode serve` message endpoints, snapshots or repeated `/turns?includeBodies=true` requests still carry body-heavy transcript load, or turn page payloads are not capped. This command builds the isolated worktree client/server through Playwright global setup; it does not deploy or restart production.

- [ ] **Step 5: Run the smoke test after Tasks 1-5 and verify it passes**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/freshopencode-db-history.spec.ts -g "one body-heavy visible page"
```

Expected after Tasks 1-5: PASS. The restored pane shows prompt and response within 10 seconds, makes exactly one `includeBodies=true` `/turns` request after reload, uses the fake `serve_*` endpoints instead of `export`, and emits exactly one matching capped `fresh_agent_turn_page_served` event.

- [ ] **Step 6: Commit Task 6**

Run:

```bash
git add test/e2e-browser/fixtures/fake-opencode.cjs \
  test/e2e-browser/specs/freshopencode-db-history.spec.ts
git commit -m "test(fresh-agent): cover fast freshopencode rehydration"
```

Expected: local commit created; no push.

## Final Verification

- [ ] **Step 1: Check coordinator status before broad verification**

Run:

```bash
npm run test:status
```

Expected: if state is idle, continue. If another holder is active, wait rather than killing it.

- [ ] **Step 2: Run all focused tests from this plan**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/shared/fresh-agent-contract.test.ts \
  test/unit/server/fresh-agent/opencode-serve-adapter.test.ts \
  test/unit/server/fresh-agent/codex-adapter.test.ts \
  test/unit/server/fresh-agent/claude-adapter.test.ts \
  test/unit/server/fresh-agent/turn-page-payload.test.ts \
  test/unit/server/fresh-agent/observability.test.ts \
  test/unit/server/fresh-agent/router.test.ts \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx \
  test/unit/client/store/freshAgentSlice.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the FreshOpenCode browser smoke**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/freshopencode-db-history.spec.ts
```

Expected: PASS. This uses an isolated TestServer and fake OpenCode binary; it does not touch production.

- [ ] **Step 4: Run the coordinated check**

Run:

```bash
FRESHELL_TEST_SUMMARY="fresh-agent rehydration fix" npm run check
```

Expected: PASS. If the coordinator reports an active holder, wait for it.

- [ ] **Step 5: Inspect the final diff**

Run:

```bash
git diff origin/main...HEAD -- \
  shared/fresh-agent-contract.ts \
  server/fresh-agent \
  src/store/freshAgentTypes.ts \
  src/store/freshAgentSlice.ts \
  src/store/freshAgentThunks.ts \
  src/store/freshAgentHistoryWarmQueue.ts \
  src/components/fresh-agent/FreshAgentView.tsx \
  src/components/fresh-agent/FreshAgentTranscript.tsx \
  test/unit/shared/fresh-agent-contract.test.ts \
  test/unit/server/fresh-agent \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx \
  test/unit/client/store/freshAgentHistoryWarmQueue.test.ts \
  test/e2e-browser/fixtures/fake-opencode.cjs \
  test/e2e-browser/specs/freshopencode-db-history.spec.ts
```

Expected: diff contains only fresh-agent rehydration, observability, and test changes.

- [ ] **Step 6: Final commit if verification changed files**

If verification fixes were needed, run:

```bash
git add shared/fresh-agent-contract.ts \
  server/fresh-agent \
  src/store/freshAgentTypes.ts \
  src/store/freshAgentSlice.ts \
  src/store/freshAgentThunks.ts \
  src/store/freshAgentHistoryWarmQueue.ts \
  src/components/fresh-agent/FreshAgentView.tsx \
  src/components/fresh-agent/FreshAgentTranscript.tsx \
  test/unit/shared/fresh-agent-contract.test.ts \
  test/unit/server/fresh-agent \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx \
  test/unit/client/store/freshAgentSlice.test.ts \
  test/unit/client/store/freshAgentHistoryWarmQueue.test.ts \
  test/e2e-browser/fixtures/fake-opencode.cjs \
  test/e2e-browser/specs/freshopencode-db-history.spec.ts
git commit -m "fix(fresh-agent): verify rehydration contract"
```

Expected: either no changes are left, or a small verification commit exists.

## Deployment And Observability Verification

- [ ] **Step 1: Do not restart production without explicit approval**

Do not stop, start, restart, deploy, or rebuild the self-hosted Freshell production server unless the user explicitly says `APPROVED`.

- [ ] **Step 2: After an approved deployment, verify turn page metrics from logs**

After the change is deployed by an approved process, watch debug JSONL logs:

```bash
tail -F ~/.freshell/logs/server-debug.*.jsonl | jq -c 'select(.event == "fresh_agent_turn_page_served") | {provider, sessionType, includeBodies, priority, turnCount, payloadBytes, durationMs}'
```

Expected after restoring a FreshOpenCode pane:

```json
{"provider":"opencode","sessionType":"freshopencode","includeBodies":true,"priority":"visible","turnCount":20,"payloadBytes":12345,"durationMs":42}
```

Expected over the restart window:

```bash
jq -s '[.[] | select(.event == "fresh_agent_turn_page_served" and .provider == "opencode")] | {requests: length, bodyRequests: map(select(.includeBodies == true)) | length, payloadBytes: map(.payloadBytes) | add}' ~/.freshell/logs/server-debug.*.jsonl
```

The accepted shape is one initial visible body request per restored visible pane, bounded background warm-history requests for hidden/inactive idle panes, no background body requests for busy FreshOpenCode panes, no repeated body-heavy requests from busy/status polling, and payload totals controlled by the configured warm-history byte budget rather than by the number of restored panes.

## Load-Bearing Analysis

Verdict: FIXED. The rollback-remediation architecture is sound, but the original plan was not executable unchanged. The high-risk assumptions below were validated with read-only code inspection in this worktree; falsified assumptions are reflected in the tasks above.

| ID | Assumption (falsifiable claim) | Decision controlled | Method | Status | Evidence / finding |
|----|--------------------------------|---------------------|--------|--------|--------------------|
| LB-1 | Client display behavior can stop depending on snapshot turns without defining a replacement transcript source. | Whether snapshots can become metadata-only safely. | Inspect `FreshAgentView` and fresh-agent slice. | Falsified | `src/components/fresh-agent/FreshAgentView.tsx:1128`, `:1511`, `:1530`, and `:1730` use snapshot/display turns for local echo, checkpoints, content, and rendering; `src/store/freshAgentSlice.ts:373-375` copies `snapshot.turns` into history. Plan now defines canonical display history as ordered `/turns` history plus live/local overlays and uses it for rendering, local echo, auto-title, checkpoint rewind, and fork/rewind context. |
| LB-2 | Snapshot turns are already prohibited by the shared/runtime contract. | Whether Task 1 only changes adapters or must change schema/runtime tests too. | Inspect shared schema and runtime manager. | Falsified | `shared/fresh-agent-contract.ts:230-245` currently allows `turns: z.array(...).default([])`; `server/fresh-agent/runtime-manager.ts:298-302` validates snapshots against that schema. Plan keeps the schema `.max(0)` test and adapter tests. |
| LB-3 | `/turns?includeBodies=true` always carries full turn bodies in `page.bodies`. | Client hydration shape and OpenCode regression tests. | Inspect OpenCode and Codex normalizers. | Falsified | `server/fresh-agent/adapters/opencode/normalize.ts:407-426` returns full inline `turn.items` and no `bodies`; Codex builds `bodies` in `server/fresh-agent/adapters/codex/adapter.ts:504-513`. Plan now accepts both `bodies[turnId]` and inline `turn.items`, with a dedicated OpenCode inline test. |
| LB-4 | `/turns` ordering is already defined as display chronological. | Reducer merge direction and older-page UX. | Inspect Claude history service and existing reducer plan. | Falsified | `server/fresh-agent/history/claude/history-service.ts:100-107` reverses records and `:193-200` slices that order, so ordering is provider-specific today. Plan now defines the API contract as chronological oldest-to-newest within each loaded window and requires cursor pages to prepend. |
| LB-5 | A 30-turn visible page is bounded enough even when tool output is huge. | Whether observability alone is enough. | Inspect read-model limits, router, and OpenCode normalization. | Falsified | `shared/read-models.ts:77-86` caps count only; `server/fresh-agent/router.ts:266-270` serializes the whole page; `server/fresh-agent/adapters/opencode/normalize.ts:333-354` preserves full item text. Plan adds `capFreshAgentTurnPagePayload` and tests inline/body-map truncation under a byte cap. |
| LB-6 | The FreshOpenCode e2e can prove the current adapter path using existing fake OpenCode DB/export behavior. | Smoke-test source path. | Inspect serve manager, adapter, and fake fixture. | Falsified | `server/fresh-agent/adapters/opencode/serve-manager.ts:343-368` calls `GET /session/:id` and `/session/:id/message`; `server/fresh-agent/adapters/opencode/adapter.ts:410-444` uses those paths for snapshot/page; `test/e2e-browser/fixtures/fake-opencode.cjs:471-529` only implements collection `/session` before the 404. Plan extends fake `opencode serve` endpoints and audits `serve_*` events instead of DB/export assumptions. |
| LB-7 | The client has enough visibility state to keep visible-priority body hydration out of hidden panes while still enqueueing background warm-history separately. | Whether visible hydration and background warming can be scheduled differently. | Inspect component tree. | Verified | `src/components/fresh-agent/FreshAgentView.tsx:409-418` accepts `hidden`; `src/components/panes/PaneContainer.tsx:822-826` passes it; `src/components/TabContent.tsx:76-78` marks hidden tab content. Plan keeps visible-priority hydration gated on `hidden` and adds a separate background queue for hidden/inactive idle panes. |
| LB-8 | Revision `0` is valid and must survive request keys/effects. | Revision checks and stale-response handling. | Inspect schemas. | Verified | `shared/fresh-agent-contract.ts:232` and `shared/read-models.ts:80` use nonnegative integer revisions. Plan replaces truthiness checks with explicit `undefined`/`null` checks and includes revision `0` tests. |
| LB-9 | Existing history reducer/thunk bookkeeping is sufficient to ignore stale thread/revision responses. | Client data-race safety. | Inspect thunk and reducer. | Falsified | `src/store/freshAgentThunks.ts:55-60` dispatches page results without a request key/body map; `src/store/freshAgentSlice.ts:488-500` accepts pages without checking current thread/revision. Plan adds request keys, revision/thread checks, and reset-on-revision-change behavior. |
| LB-10 | Snapshot observability can prove snapshots stayed small and metadata-only. | Operational proof after implementation. | Inspect router observability and tests. | Verified with required test changes | `server/fresh-agent/router.ts:202-220` already records snapshot `payloadBytes` and `turnCount`; `test/unit/server/fresh-agent/router.test.ts:249` currently expects `turnCount > 0`. Plan changes assertions to `turnCount === 0` and small payloads. |
| LB-11 | Claude metadata snapshots can avoid a second full-history resolution. | Adapter/server cost for snapshots. | Inspect Claude adapter and history service. | Falsified | `server/fresh-agent/adapters/claude/adapter.ts:230-231` calls `loadResolved(...)` and then `agentHistorySource.resolve(...)`; `server/fresh-agent/history/claude/history-service.ts:153-164` builds full snapshot turns. Plan adds `getSnapshotMetadata` and a test that `agentHistorySource.resolve` is called once. |
| LB-12 | Existing tests/browser route stubs already align with metadata-only snapshots. | Test migration scope. | Search test fixtures. | Falsified | `rg` found many snapshot `turns: [...]` stubs in `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` and browser specs. Plan adds a pre-commit `rg` check requiring transcript rows to move to `/turns` responses while snapshots use `turns: []`. |
| LB-13 | FreshOpenCode transcript reads can run in the background while a session is busy without sharing the active sidecar path. | Whether background warm-history can include long-running busy panes. | Inspect OpenCode adapter and serve manager. | Falsified | `server/fresh-agent/adapters/opencode/adapter.ts:410-447` routes snapshot/page/body reads through `serveManager.getSession`, `listMessages`, and `getMessage`; `server/fresh-agent/adapters/opencode/serve-manager.ts:350-466` uses the same `opencode serve` HTTP sidecar for prompt/status/message endpoints. Plan now warms hidden/inactive FreshOpenCode panes only after they are idle; visible tab flips still get a bounded visible-priority latest page. |

## Self-Review

**Spec coverage:**

- Requirement 1, cheap snapshots by contract: Task 1 changes `FreshAgentSnapshotSchema` and all adapters so snapshot turns are empty and non-empty snapshot turns fail validation.
- Requirement 2, `/turns` transcript loading: Task 2 loads the visible transcript page through `loadFreshAgentThreadTurns` and renders from `historyItems`/`historyBodies`.
- Requirement 3, smooth scroll without restart storms: Task 3 adds a budgeted background warm-history queue for hidden/inactive idle panes, keeps explicit "Load older history" as an immediate one-page visible action, and forbids unbounded automatic cursor chasing.
- Requirement 4, status decoupled from transcript: Task 4 splits metadata and transcript refresh triggers and tests busy polling against repeated body-heavy turn requests.
- Requirement 5, bounded visible body pages and structured observability: Task 5 caps first-page body payloads, preserves chronological page windows, and adds `fresh_agent_turn_page_served` with request count by event count, payload size, `includeBodies`, priority, turn count, truncation count, and duration.
- Requirement 6, meaningful tests: Tasks 1-6 add contract, adapter, router, client integration, and Playwright smoke tests proving restored FreshOpenCode panes rehydrate with one body-heavy visible request.

**Placeholder scan:**

- No banned placeholder markers or vague deferred-work phrasing are used as instructions.
- Domain uses of "placeholder" refer to FreshOpenCode provisional session IDs, not plan blanks.

**Type consistency:**

- `FreshAgentSnapshotSchema`, `FreshAgentTurnPageSchema`, `FreshAgentTurnBodySchema`, `capFreshAgentTurnPagePayload`, `createFreshAgentHistoryWarmQueue`, `loadFreshAgentThreadTurns`, `historyPageReceived`, `historyBodies`, `nextHistoryCursor`, and `FreshAgentTranscript` prop names are consistent across tasks.
- The plan uses `sessionId` as the client thunk input and maps it to server `threadId` through existing API helpers, matching current `src/store/freshAgentThunks.ts`.
