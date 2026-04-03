# FreshClaude Robust Restore Redesign Implementation Plan

> **For Claude:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace FreshClaude's reconstructive restore flow with one authoritative, atomic, revision-pinned restore system that survives reloads, reconnects, remounts, and server restarts without split-brain state or heuristic drift.

**Architecture:** Introduce a canonical server-side restore ledger that becomes the only source for live-session restore snapshots and HTTP timeline reads. The ledger hydrates from durable Claude JSONL once, appends live SDK events with stable turn identity and monotonic revision, and exposes typed restore outcomes to `WsHandler` so `sdk.create` can become transactional and request-scoped on failure. The client then restores against that single ledger contract: snapshot and timeline hydration are revision-pinned, canonical durable identity is flushed immediately when upgraded, and stale/mismatched restore reads fail loudly instead of being papered over with fallback heuristics.

**Tech Stack:** TypeScript, React 18, Redux Toolkit, Express, WebSocket (`ws`), Anthropic Claude Agent SDK, Vitest, Testing Library

---

## Chunk 1: Architecture

## Why This Supersedes The Current Direction

- The current branch still treats restore as reconstruction from three partially overlapping systems:
  - durable Claude JSONL
  - live SDK session memory
  - persisted pane/tab client state
- That architecture is inherently fragile because correctness is distributed across:
  - `server/agent-timeline/history-source.ts`
  - `server/ws-handler.ts`
  - `src/lib/sdk-message-handler.ts`
  - `src/components/agent-chat/AgentChatView.tsx`
- The robust fix is not "more careful merging" or "more recovery glue." The robust fix is to create one canonical restore model and make every server/client restore surface consume that model.

## Chosen End-State

### 1. One authoritative server restore ledger

- Create a server-side canonical history/restore ledger for each FreshClaude session identity.
- A ledger may start in `live_only` mode when a live SDK session exists but the canonical durable Claude id is not known yet, then upgrade in place to `merged` or `durable_only` once the durable id is discovered.
- While a live SDK session exists, the ledger is authoritative for:
  - `sdk.session.snapshot`
  - `/api/agent-sessions/:sessionId/timeline`
  - `/api/agent-sessions/:sessionId/turns/:turnId`
- When no live SDK session exists, the ledger is rebuilt from durable Claude JSONL only and remains authoritative for durable-only restore.
- The ledger must be addressable by both live SDK session id and canonical durable Claude session id when both exist so attach-by-durable-id and attach-by-live-id resolve to the same canonical state.
- `WsHandler` stops inferring restore semantics from `null` vs `throw` vs success. It only maps typed ledger outcomes to protocol messages.
- Named resume with late durable-id disclosure must be explicit:
  - initialize the ledger in `live_only` mode if the canonical durable UUID is not yet known
  - when Claude later reveals the durable UUID, hydrate the durable backlog exactly once, prepend it ahead of recorded live ordinals, and bump the ledger revision
  - any in-flight restore reads pinned to the pre-upgrade revision must fail stale and retry against the upgraded ledger

### 2. Stable turn identity before transport

- Stop treating turn identity as array position.
- Every canonical turn in the ledger must have:
  - `turnId`: stable server-facing turn identity
  - `messageId`: stable message identity
  - `ordinal`: strictly increasing position within the canonical timeline
  - `source`: `durable` | `live`
- Durable history must preserve any upstream identity available in Claude JSONL.
- If upstream identity is absent, synthesize deterministic durable message ids from a normalized message fingerprint plus the occurrence index of that fingerprint within the durable session, not from the current array index.
- That synthesis rule must remain stable across equivalent JSONL rewrites and cache rebuilds. If Claude compaction materially rewrites the conversation content, treat that as a new durable revision; do not allow byte-level formatting changes to churn ids.
- Live SDK events must receive stable ids at ingest time and append-only ordinals in memory.
- Merging durable backlog with live delta becomes id-first and ordinal-based. Content/timestamp heuristics are kept only as an explicit legacy compatibility fallback for old idless durable sessions, not as the main algorithm.

### 3. Transactional `sdk.create`

- `sdk.create` must not expose a session to the client until restore state is coherent.
- "Coherent" does not mean "durable id already known." For named resumes, a coherent initial state can still be `live_only` if that is the best authoritative state available before Claude reveals the durable UUID.
- Required server sequence:
  1. create or resume the SDK session internally
  2. hydrate or initialize the canonical ledger
  3. build the authoritative snapshot from the ledger
  4. emit `sdk.created`
  5. emit `sdk.session.snapshot`
  6. emit preliminary `sdk.session.init`
  7. subscribe/replay live buffered SDK events
- If steps 2-3 fail, the server must kill the tentative SDK session and emit a request-scoped create failure. The client must never see a half-created session id.

### 4. Revision-pinned restore hydration

- Snapshot and HTTP hydration must be part of the same consistency contract.
- `sdk.session.snapshot` must include the canonical ledger revision.
- The first timeline page request and subsequent turn-body requests must send the revision they are restoring against.
- The timeline router/service must reject revision mismatches with a restore-specific stale response instead of silently serving the newest state.
- Cursor payloads for agent timeline reads must encode the revision so pagination cannot drift across revisions.

### 5. Immediate durable identity persistence

- As soon as the canonical durable Claude id becomes known, the client must:
  - persist it into pane content
  - persist it into tab fallback metadata
  - force a targeted immediate layout flush
- This is not a blanket synchronous persistence policy.
- Only the "canonical durable id upgraded" transition gets an immediate flush, because that transition is the recovery-critical one.

### 6. Explicit restore-specific failure semantics

- Add request-scoped create failure and restore-specific error codes.
- Do not overload session-scoped `sdk.error` for pre-created-session failures.
- The protocol must distinguish:
  - `RESTORE_NOT_FOUND`
  - `RESTORE_UNAVAILABLE`
  - `RESTORE_INTERNAL`
  - `RESTORE_STALE_REVISION`
  - `RESTORE_DIVERGED`

## Invariants

- There is exactly one authoritative restore model per session identity at any moment.
- Named resumes are first-class: they may restore as coherent `live_only` sessions first and then upgrade identity later, but they still use the same ledger and protocol contract.
- A live session never re-merges against the evolving durable file on every restore read. The ledger hydrates durable backlog once, then appends live delta.
- `sdk.create` is atomic from the client’s perspective.
- Snapshot and visible-first HTTP hydration are revision-coherent or they fail explicitly.
- Canonical durable identity is persisted before the browser can reasonably lose power without a flush attempt.
- A freshly upgraded canonical durable id cannot be overwritten by stale cross-tab rebroadcast state.
- User-visible failures are explicit and actionable. No silent local fallbacks that fabricate history.

## File Structure

- Create: `server/agent-timeline/ledger.ts`
  Responsibility: canonical ledger types, stable turn/message identity generation, revision management, and id-first merge logic.
- Modify: `server/agent-timeline/history-source.ts`
  Responsibility: replace ad hoc `ResolvedAgentHistory | null` with a typed restore outcome that is backed by the ledger.
- Modify: `server/agent-timeline/types.ts`
  Responsibility: carry stable `turnId`, `messageId`, and revision-pinned read types through the HTTP timeline layer.
- Modify: `server/agent-timeline/service.ts`
  Responsibility: serve pages and turn bodies from the ledger using revision-aware queries.
- Modify: `server/agent-timeline/router.ts`
  Responsibility: accept revision on timeline and turn-body requests, reject stale mismatches, and encode revision into pagination flow.
- Modify: `server/session-history-loader.ts`
  Responsibility: preserve upstream durable identity when present and synthesize deterministic durable message ids when absent.
- Modify: `server/sdk-bridge-types.ts`
  Responsibility: extend live session state with canonical turn ids, message ids, append ordinals, and ledger linkage.
- Modify: `server/sdk-bridge.ts`
  Responsibility: assign live message ids at ingest time, append live turns to the ledger, and expose the ledger-backed snapshot state.
- Modify: `server/ws-handler.ts`
  Responsibility: make `sdk.create` transactional, map typed restore outcomes to protocol messages, and remove half-created-session behavior.
- Modify: `server/index.ts`
  Responsibility: instantiate the ledger and wire it into both WebSocket restore and HTTP timeline routes.
- Modify: `shared/ws-protocol.ts`
  Responsibility: define request-scoped create failure, restore-specific error codes, and revision-carrying snapshot messages.
- Modify: `shared/read-models.ts`
  Responsibility: add optional `revision` to agent timeline page and turn-body queries and define stale-revision response semantics if needed.
- Modify: `src/lib/api.ts`
  Responsibility: send revision-pinned timeline and turn-body restore requests.
- Modify: `src/store/agentChatTypes.ts`
  Responsibility: store canonical turn identity and revision-aware restore status in Redux.
- Modify: `src/store/agentChatSlice.ts`
  Responsibility: ingest request-scoped create failure, revision-aware snapshot state, and stale-revision restore outcomes.
- Modify: `src/store/agentChatThunks.ts`
  Responsibility: send snapshot revision on restore fetches and restart hydration cleanly on stale-revision responses.
- Modify: `src/lib/sdk-message-handler.ts`
  Responsibility: handle request-scoped create failure separately from session-scoped runtime failure.
- Modify: `test/unit/client/lib/sdk-message-handler.session-lost.test.ts`
  Responsibility: verify `INVALID_SESSION_ID` still triggers lost-session recovery while request-scoped create failure does not impersonate a lost live session.
- Modify: `src/components/agent-chat/AgentChatView.tsx`
  Responsibility: drive one atomic restore flow, trigger targeted immediate flush when durable identity upgrades, and remove timeout-driven compensation where protocol becomes explicit.
- Create: `src/store/persistControl.ts`
  Responsibility: expose a targeted `flushPersistedLayoutNow` action for immediate recovery-critical layout flushes.
- Modify: `src/store/persistMiddleware.ts`
  Responsibility: honor the targeted flush action without changing the normal debounce policy for unrelated UI writes.
- Modify: `src/store/crossTabSync.ts`
  Responsibility: reject stale layout rebroadcast that would overwrite a newer canonical durable id after an immediate flush.
- Modify: `test/unit/server/agent-timeline-history-source.test.ts`
  Responsibility: pin typed restore outcomes and legacy-fallback boundaries.
- Create: `test/unit/server/agent-timeline-ledger.test.ts`
  Responsibility: verify stable turn ids, deterministic durable ids, live append ordinals, and id-first merge behavior.
- Modify: `test/unit/server/ws-handler-sdk.test.ts`
  Responsibility: verify transactional `sdk.create`, request-scoped create failure, and absence of half-created sessions.
- Modify: `test/integration/server/agent-timeline-router.test.ts`
  Responsibility: verify revision-pinned timeline reads, stale-revision rejection, and cursor stability.
- Modify: `test/unit/client/sdk-message-handler.test.ts`
  Responsibility: verify request-scoped create failure and restore-specific error handling.
- Modify: `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`
  Responsibility: verify revision-pinned restore, canonical durable-id flush, and stale-revision rehydrate behavior.
- Create: `test/unit/client/store/persistControl.test.ts`
  Responsibility: verify only the targeted durable-id-upgrade path forces immediate flush.
- Modify: `test/unit/client/store/crossTabSync.test.ts`
  Responsibility: verify stale rebroadcast cannot overwrite a newer canonical durable id.
- Modify: `test/e2e/agent-chat-restore-flow.test.tsx`
  Responsibility: verify the full restore contract under reload, reconnect, and stale-revision retry.
- Modify: `test/e2e/agent-chat-resume-history-flow.test.tsx`
  Responsibility: verify resumed-create restore remains atomic and coherent.

## Strategy Gate

- Do not keep two peer restore paths.
- Do not expose SDK session ids to the client before restore succeeds.
- Do not keep array-index `turnId`s in the final design.
- Do not use content/timestamp matching as the primary merge algorithm.
- Do not make all persistence synchronous.
- Do not allow the HTTP timeline layer to return a different revision from the one the snapshot declared without an explicit stale-revision response.

---

## Chunk 2: Execution Tasks

### Task 1: Build The Canonical Ledger And Stable Identity Model

**Files:**
- Create: `server/agent-timeline/ledger.ts`
- Modify: `server/agent-timeline/history-source.ts`
- Modify: `server/agent-timeline/types.ts`
- Modify: `server/session-history-loader.ts`
- Modify: `server/sdk-bridge-types.ts`
- Modify: `server/sdk-bridge.ts`
- Test: `test/unit/server/agent-timeline-ledger.test.ts`
- Test: `test/unit/server/agent-timeline-history-source.test.ts`

- [ ] **Step 1: Write the failing server identity tests**

```ts
it('assigns stable deterministic durable message ids for idless jsonl records', async () => {
  const messages = extractChatMessagesFromJsonl(jsonlFixtureWithoutIds)
  expect(messages.map((m) => m.messageId)).toEqual([
    'durable:cli-1:8f7c...',
    'durable:cli-1:29ab...',
  ])
})

it('appends live turns after the durable base without recomputing overlap from content', () => {
  const ledger = createAgentRestoreLedger(makeBaseHistory('cli-1', durableTurns))
  ledger.appendLiveTurn(makeLiveTurn('sdk-1', 3, 'live:sdk-1:3'))
  expect(ledger.snapshot().turns.map((t) => t.turnId)).toEqual([
    'turn:durable:1',
    'turn:durable:2',
    'turn:live:3',
  ])
})

it('returns a typed restore outcome instead of null-or-throw domain states', async () => {
  await expect(source.resolve('missing-cli')).resolves.toEqual({
    kind: 'missing',
    code: 'RESTORE_NOT_FOUND',
  })
})
```

- [ ] **Step 2: Run focused server tests to verify they fail**

Run:

```bash
FRESHELL_TEST_SUMMARY="robust restore ledger red" npm run test:vitest -- --config vitest.server.config.ts test/unit/server/agent-timeline-ledger.test.ts test/unit/server/agent-timeline-history-source.test.ts
```

Expected: FAIL because ledger types, `messageId`, and typed restore outcomes do not exist yet.

- [ ] **Step 3: Implement ledger types and deterministic identity**

```ts
export type CanonicalTurn = {
  turnId: string
  messageId: string
  ordinal: number
  source: 'durable' | 'live'
  message: ChatMessage
}

export type RestoreResolution =
  | { kind: 'missing'; code: 'RESTORE_NOT_FOUND' }
  | { kind: 'fatal'; code: 'RESTORE_UNAVAILABLE' | 'RESTORE_INTERNAL' | 'RESTORE_DIVERGED'; message: string }
  | {
      kind: 'ready'
      mode: 'durable_only' | 'live_only' | 'merged'
      liveSessionId?: string
      timelineSessionId?: string
      revision: number
      turns: CanonicalTurn[]
      streamingActive?: boolean
      streamingText?: string
    }
```

- [ ] **Step 4: Re-run the focused server tests**

Run the command from Step 2.

Expected: PASS with stable turn identity and typed restore outcomes.

- [ ] **Step 5: Commit the ledger foundation**

```bash
git add server/agent-timeline/ledger.ts server/agent-timeline/history-source.ts server/agent-timeline/types.ts server/session-history-loader.ts server/sdk-bridge-types.ts server/sdk-bridge.ts test/unit/server/agent-timeline-ledger.test.ts test/unit/server/agent-timeline-history-source.test.ts
git commit -m "refactor: add canonical freshclaude restore ledger"
```

### Task 2: Make `sdk.create` Transactional And Restore Failures Explicit

**Files:**
- Modify: `server/ws-handler.ts`
- Modify: `shared/ws-protocol.ts`
- Modify: `src/lib/sdk-message-handler.ts`
- Modify: `src/store/agentChatSlice.ts`
- Test: `test/unit/server/ws-handler-sdk.test.ts`
- Test: `test/unit/client/sdk-message-handler.test.ts`
- Test: `test/unit/client/lib/sdk-message-handler.session-lost.test.ts`

- [ ] **Step 1: Write the failing protocol and transactional-create tests**

```ts
it('does not emit sdk.created when create-time restore fails', async () => {
  mockRestore.resolve.mockResolvedValue({ kind: 'fatal', code: 'RESTORE_INTERNAL', message: 'boom' })
  const messages = await sendSdkCreateAndCollect()
  expect(messages.some((m) => m.type === 'sdk.created')).toBe(false)
  expect(messages).toContainEqual({
    type: 'sdk.create.failed',
    requestId: 'req-1',
    code: 'RESTORE_INTERNAL',
    message: 'boom',
  })
  expect(mockSdkBridge.killSession).toHaveBeenCalled()
})

it('clears the pending create when sdk.create.failed arrives', () => {
  dispatch(handleSdkMessage(store.dispatch, {
    type: 'sdk.create.failed',
    requestId: 'req-1',
    code: 'RESTORE_INTERNAL',
    message: 'boom',
  }))
  expect(selectPendingCreate('req-1')).toBeUndefined()
})

it('returns the pane to a retryable create state without marking the session lost', () => {
  dispatch(handleSdkMessage(store.dispatch, {
    type: 'sdk.create.failed',
    requestId: 'req-1',
    code: 'RESTORE_INTERNAL',
    message: 'boom',
  }))
  expect(selectPaneContent('p1')).toEqual(expect.objectContaining({
    sessionId: undefined,
    status: 'creating',
  }))
  expect(selectSession('sdk-sess-1')?.lost).not.toBe(true)
})
```

- [ ] **Step 2: Run focused protocol/client tests to verify they fail**

Run:

```bash
FRESHELL_TEST_SUMMARY="robust restore transactional create red" npm run test:vitest -- test/unit/server/ws-handler-sdk.test.ts test/unit/client/sdk-message-handler.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts
```

Expected: FAIL because `sdk.create.failed` and transactional semantics do not exist yet.

- [ ] **Step 3: Implement request-scoped create failure and transactional ordering**

```ts
type SdkCreateFailedMessage = {
  type: 'sdk.create.failed'
  requestId: string
  code: 'RESTORE_NOT_FOUND' | 'RESTORE_UNAVAILABLE' | 'RESTORE_INTERNAL' | 'RESTORE_DIVERGED'
  message: string
  retryable?: boolean
}
```

- [ ] **Step 4: Re-run the focused protocol/client tests**

Run the command from Step 2.

Expected: PASS with no half-created client-visible sessions.

- [ ] **Step 5: Commit the transactional protocol change**

```bash
git add server/ws-handler.ts shared/ws-protocol.ts src/lib/sdk-message-handler.ts src/store/agentChatSlice.ts test/unit/server/ws-handler-sdk.test.ts test/unit/client/sdk-message-handler.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts
git commit -m "refactor: make freshclaude restore create transactional"
```

### Task 3: Make Snapshot And Timeline Hydration Revision-Coherent

**Files:**
- Modify: `shared/read-models.ts`
- Modify: `server/agent-timeline/service.ts`
- Modify: `server/agent-timeline/router.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/store/agentChatThunks.ts`
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Test: `test/integration/server/agent-timeline-router.test.ts`
- Test: `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`
- Test: `test/e2e/agent-chat-restore-flow.test.tsx`

- [ ] **Step 1: Write the failing stale-revision tests**

```ts
it('rejects a timeline request whose requested revision no longer matches the ledger', async () => {
  const response = await request(app).get('/api/agent-sessions/cli-1/timeline?priority=visible&revision=12')
  expect(response.status).toBe(409)
  expect(response.body).toEqual({ error: 'Stale restore revision', code: 'RESTORE_STALE_REVISION', currentRevision: 13 })
})

it('restarts restore hydration when the first visible page returns RESTORE_STALE_REVISION', async () => {
  mockGetAgentTimelinePage.mockRejectedValueOnce({ status: 409, message: 'Stale restore revision', details: { code: 'RESTORE_STALE_REVISION', currentRevision: 13 } })
  // Expect the component to request a fresh snapshot/attach path instead of rendering mixed state.
})
```

- [ ] **Step 2: Run router/client/e2e restore tests to verify they fail**

Run:

```bash
FRESHELL_TEST_SUMMARY="robust restore revision red" npm run test:vitest -- --config vitest.server.config.ts test/integration/server/agent-timeline-router.test.ts
FRESHELL_TEST_SUMMARY="robust restore revision red client" npm run test:vitest -- test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/e2e/agent-chat-restore-flow.test.tsx
```

Expected: FAIL because revision is currently metadata only.

- [ ] **Step 3: Implement revision-pinned restore requests and stale response handling**

```ts
export const AgentTimelinePageQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  priority: ReadModelPrioritySchema.optional(),
  revision: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(MAX_AGENT_TIMELINE_ITEMS).optional(),
  includeBodies: z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]).optional(),
})
```

- [ ] **Step 4: Re-run the revision tests**

Run the commands from Step 2.

Expected: PASS with explicit stale-revision behavior instead of mixed snapshot/timeline state.

- [ ] **Step 5: Commit revision coherence**

```bash
git add shared/read-models.ts server/agent-timeline/service.ts server/agent-timeline/router.ts src/lib/api.ts src/store/agentChatThunks.ts src/components/agent-chat/AgentChatView.tsx test/integration/server/agent-timeline-router.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/e2e/agent-chat-restore-flow.test.tsx
git commit -m "refactor: pin freshclaude restore to snapshot revision"
```

### Task 4: Flush Canonical Durable Identity Immediately And Only There

**Files:**
- Create: `src/store/persistControl.ts`
- Modify: `src/store/persistMiddleware.ts`
- Modify: `src/store/crossTabSync.ts`
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Test: `test/unit/client/store/persistControl.test.ts`
- Test: `test/unit/client/store/crossTabSync.test.ts`
- Test: `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`

- [ ] **Step 1: Write the failing crash-window persistence tests**

```ts
it('dispatches the targeted flush action when the component learns a new canonical durable id', async () => {
  render(<AgentChatView ... />)
  deliverSdkSnapshot({
    sessionId: 'sdk-1',
    latestTurnId: 'turn-4',
    status: 'running',
    timelineSessionId: '00000000-0000-4000-8000-000000000321',
    revision: 9,
  })
  await waitFor(() => expect(storeDispatch).toHaveBeenCalledWith(flushPersistedLayoutNow()))
})

it('ignores stale rebroadcast layout that would overwrite a newer canonical durable id', () => {
  hydrateLocalStateWithResumeId('00000000-0000-4000-8000-000000000321')
  deliverCrossTabLayoutWithResumeId('named-resume')
  expect(selectPaneResumeSessionId('p1')).toBe('00000000-0000-4000-8000-000000000321')
})

it('does not force immediate flush for unrelated pane status changes', () => {
  store.dispatch(setSessionStatus({ sessionId: 'sdk-1', status: 'idle' }))
  expect(localStorage.setItem).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run the targeted persistence tests to verify they fail**

Run:

```bash
FRESHELL_TEST_SUMMARY="robust restore persist red" npm run test:vitest -- test/unit/client/store/persistControl.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx
```

Expected: FAIL because no targeted flush control exists.

- [ ] **Step 3: Implement the targeted flush action and wire it to durable-id upgrade**

```ts
export const flushPersistedLayoutNow = createAction('persist/flushNow')
```

- [ ] **Step 4: Re-run the persistence tests**

Run the command from Step 2.

Expected: PASS with the crash window closed and normal debounce behavior unchanged elsewhere.

- [ ] **Step 5: Commit the recovery-critical flush behavior**

```bash
git add src/store/persistControl.ts src/store/persistMiddleware.ts src/components/agent-chat/AgentChatView.tsx test/unit/client/store/persistControl.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx
git commit -m "fix: flush canonical restore identity immediately"
```

### Task 5: Run The Adversarial Suite And Update Plan Docs

**Files:**
- Modify: `docs/plans/2026-04-02-freshclaude-restore-audit.md`
- Modify: `docs/plans/2026-04-02-freshclaude-restore-audit-test-plan.md`
- Modify: `test/e2e/agent-chat-resume-history-flow.test.tsx`
- Modify: `test/unit/server/agent-timeline-history-source.test.ts`
- Modify: `test/e2e/agent-chat-restore-flow.test.tsx`

- [ ] **Step 1: Add the remaining adversarial coverage**

Add tests for:
- create failure cleanup
- stale-revision retry
- durable-only restore after restart
- legacy idless durable session fallback
- no stale named resume overwrite after durable-id upgrade
- no stale cross-tab rebroadcast overwrite after targeted flush

- [ ] **Step 2: Run the broad coordinated verification**

Run:

```bash
FRESHELL_TEST_SUMMARY="robust restore full verify" npm run check
FRESHELL_TEST_SUMMARY="robust restore full test" npm test
```

Expected: PASS across client, server, and electron suites with no skipped restore tests.

- [ ] **Step 3: Update the existing April 2 restore docs to note they were superseded**

Add a short top-note in both existing docs pointing to this redesign plan as the new authoritative direction.

- [ ] **Step 4: Commit the adversarial verification and doc handoff**

```bash
git add docs/plans/2026-04-02-freshclaude-restore-audit.md docs/plans/2026-04-02-freshclaude-restore-audit-test-plan.md test/e2e/agent-chat-resume-history-flow.test.tsx test/unit/server/agent-timeline-history-source.test.ts test/e2e/agent-chat-restore-flow.test.tsx test/unit/client/store/crossTabSync.test.ts
git commit -m "test: lock in robust freshclaude restore contract"
```

## Execution Notes

- This plan intentionally chooses robustness over incremental compatibility. Do not split off "just the protocol" or "just the persistence" as independent final designs.
- The only tolerated compatibility bridge is the legacy idless durable-session fallback inside the ledger. Everything else should converge on the new canonical model in one redesign.
- If implementation uncovers an upstream Claude JSONL field that already provides stable message ids, prefer plumbing it rather than continuing to synthesize ids.
- If the SDK exposes stable message ids later in the stream API, immediately switch live ids to those upstream values and keep the local ids only as fallback.
