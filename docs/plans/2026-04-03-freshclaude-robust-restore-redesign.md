# FreshClaude Robust Restore Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace FreshClaude's reconstructive restore flow with one authoritative, atomic, revision-pinned restore system that survives reloads, reconnects, remounts, and server restarts without split-brain state, heuristic drift, or half-created sessions.

**Architecture:** Introduce a canonical server-side restore ledger that becomes the only restore authority for both WebSocket snapshots and HTTP timeline reads. The ledger owns stable turn/message identity, typed restore outcomes, monotonic revisioning, and late durable-id upgrades; `WsHandler` becomes a protocol adapter on top of that ledger, including transactional `sdk.create` and explicit restore failure semantics. The client restores only against revision-pinned ledger snapshots, immediately flushes the canonical durable id when it upgrades, and rejects stale cross-tab state that would regress recovery identity.

**Tech Stack:** TypeScript, React 18, Redux Toolkit, Express, WebSocket (`ws`), Anthropic Claude Agent SDK, Vitest, Testing Library

---

## Architecture

## Why This Is The Right End State

- The current restore behavior is reconstructive: it rebuilds one session from persisted pane state, live SDK memory, and durable Claude JSONL using different rules in different layers.
- That is the real failure mode. The bug class is not "a loader might throw"; it is "more than one component is allowed to decide what restore means."
- The robust solution is therefore not a primary path plus fallback path. It is one authoritative restore model with explicit typed outcomes.

## Root Cause Analysis To Carry Into Implementation

- Durable-history I/O was not the confirmed root cause of the observed failures.
- Ordinary durable loader failures already collapse to `null` in the existing `loadSessionHistory()` and cache path; the dangerous behavior came from contract ambiguity above that layer.
- `AgentHistorySource` was meant to reconcile durable and live state, but `WsHandler` still retained its own restore interpretation and client-visible sequencing rules.
- That split ownership let tests and implementation normalize "resolver rejected" as a restore variant instead of a boundary failure.
- The redesign must therefore remove ownership ambiguity:
  - the ledger resolves restore state
  - `WsHandler` only maps typed outcomes to protocol messages
  - the client only consumes those protocol messages and revision-pinned HTTP reads

## User-Visible Behavior

- Reloading a live FreshClaude pane restores the same canonical transcript and current streaming state without duplicated or reordered turns.
- Reconnecting or remounting during an active run never mixes an old snapshot with a newer HTTP timeline page.
- Resuming from a named session before the canonical durable Claude UUID is known is allowed, but the session is still coherent:
  - the client sees one authoritative `live_only` restore state
  - when the durable UUID becomes known later, the same ledger upgrades in place
  - the client retries restore once against the new revision and never silently splices data from two revisions
- If restore cannot be made coherent, the user gets an explicit restore failure instead of fabricated history or a half-created session.
- If `sdk.create` fails during restore initialization, the client never receives a usable session id and can retry cleanly.

## End-State Contracts And Invariants

### 1. One authoritative restore ledger

- Create one canonical ledger per restore identity.
- A ledger can be addressed by:
  - live SDK session id
  - canonical durable Claude session id
  - temporary named-resume id until durable identity is known
- A ledger may be in one of these readiness modes:
  - `durable_only`
  - `live_only`
  - `merged`
- A ledger revision is a monotonic integer incremented on every canonical state change:
  - initial hydrate
  - live append
  - durable-id upgrade
  - durable backlog promotion
- While a live SDK session exists, both `sdk.session.snapshot` and `/api/agent-sessions/...` reads must come from the same in-memory ledger instance.
- When no live session exists, the server rebuilds a durable-only ledger from JSONL and still serves both surfaces from that same ledger contract.

### 2. Stable identity before transport

- Canonical turns must not be identified by array position.
- Every canonical turn exposed outside the ledger must have:
  - `turnId`
  - `messageId`
  - `ordinal`
  - `source`
- Durable identity rules:
  - preserve upstream durable ids if Claude JSONL already provides them
  - otherwise synthesize deterministic durable ids from canonical semantic fingerprints plus a per-fingerprint occurrence index
- Canonical durable fingerprint algorithm:
  - build a canonical JSON object with:
    - `role`
    - ordered `content` blocks
    - `model` when present
    - upstream parent/reference ids when present and semantically meaningful
  - block normalization rules:
    - `text`: preserve interior whitespace, normalize Unicode to NFC, normalize line endings to `\n`, trim only trailing whitespace at the end of the block
    - `thinking`: same normalization as `text`
    - `tool_use`: include `id`, `name`, and sorted-key JSON for `input`
    - `tool_result`: include `tool_use_id`, `is_error`, and sorted-key JSON for structured `content`
  - ignore timestamps, cache metadata, JSONL byte layout, raw formatting, and read-order artifacts
  - serialize with stable sorted-key JSON and hash that representation
- Equivalent JSONL rewrites must preserve synthesized durable ids. Material conversation rewrites may produce new ids and therefore a new durable revision.
- Live message ids are assigned at ingest time and remain stable for the lifetime of the session. If the SDK later exposes authoritative ids, prefer them and keep local ids only as fallback.
- Merge policy:
  - primary algorithm is id-first merge with append ordinals
  - content/timestamp overlap heuristics remain only as an explicit compatibility path for legacy durable sessions that truly lack stable identity

### 3. Transactional `sdk.create`

- `sdk.create` is atomic from the client's perspective.
- The client must never see a live session id before coherent restore state exists.
- Required server sequence:
  1. create or resume the SDK session internally
  2. establish a gated replay handle for early SDK events before anything can be sent to the client
  3. create or hydrate the ledger
  4. derive the authoritative snapshot from the ledger
  5. emit `sdk.created`
  6. emit `sdk.session.snapshot`
  7. emit a server-synthesized preliminary `sdk.session.init`
  8. replay gated early SDK events in protocol order, with raw early `system/init` downgraded to a metadata refresh after the synthesized init
  9. switch the client to the normal live subscription path
- Early SDK event handling must be explicit:
  - add a replay-drain API at the bridge boundary so `WsHandler` can inspect buffered early events before they are pushed to the client
  - partition replayed events into `system/init` vs non-init messages
  - replay non-init events after the synthesized init
  - replay the raw buffered `system/init` last, as a metadata update, not as the readiness gate
- If steps 3-4 fail:
  - kill the tentative session
  - do not emit `sdk.created`
  - emit request-scoped `sdk.create.failed`

### 4. Revision-pinned restore hydration

- `sdk.session.snapshot` must carry the canonical ledger revision.
- Timeline page requests and turn-body requests must include the revision they are restoring against.
- Cursor payloads must encode the revision.
- The HTTP timeline layer must reject mismatched revisions with `RESTORE_STALE_REVISION` instead of silently serving newer state.
- Client retry policy is fixed and finite:
  - one automatic retry per restore attempt
  - retry means reacquire a fresh snapshot and restart hydration from scratch
  - if the second attempt also receives `RESTORE_STALE_REVISION`, surface a visible restore failure

### 5. Immediate canonical durable-id persistence

- The canonical durable Claude id is recovery-critical.
- As soon as a session upgrades from named resume or live-only identity to a canonical durable id, the client must:
  - update pane content
  - update tab fallback metadata
  - dispatch a targeted immediate persistence flush
- This is not a general synchronous persistence policy.
- Cross-tab rebroadcast must reject older payloads that would overwrite a newer canonical durable id after that flush.

### 6. Explicit restore failure semantics

- Add request-scoped `sdk.create.failed` for pre-created-session failure.
- Keep session-scoped `sdk.error` for runtime failures on existing sessions.
- Restore-related codes must distinguish:
  - `RESTORE_NOT_FOUND`
  - `RESTORE_UNAVAILABLE`
  - `RESTORE_INTERNAL`
  - `RESTORE_STALE_REVISION`
  - `RESTORE_DIVERGED`
- `INVALID_SESSION_ID` remains the signal for "known live session is gone" and should continue to drive lost-session recovery.

## File Structure

- Create: `server/agent-timeline/ledger.ts`
  Responsibility: canonical ledger data model, revisioning, stable id generation, id-first merge, late durable-id upgrade, and typed restore outcomes.
- Modify: `server/agent-timeline/history-source.ts`
  Responsibility: replace `ResolvedAgentHistory | null` with ledger-backed `RestoreResolution` results and keep the legacy compatibility seam narrow and explicit.
- Modify: `server/agent-timeline/types.ts`
  Responsibility: carry canonical turn/message identity, revision-aware page query types, and stale-revision result types through the timeline layer.
- Modify: `server/agent-timeline/service.ts`
  Responsibility: serve timeline pages and turn bodies directly from the ledger, including revision checks and revision-bearing cursors.
- Modify: `server/agent-timeline/router.ts`
  Responsibility: parse revision-bearing requests, return restore-specific HTTP failures, and preserve revision through pagination.
- Modify: `server/session-history-loader.ts`
  Responsibility: preserve upstream durable ids when present and synthesize deterministic durable ids when absent.
- Modify: `server/sdk-bridge-types.ts`
  Responsibility: add canonical live message identity, ordinal, replay-drain types, and any ledger linkage metadata needed during create.
- Modify: `server/sdk-bridge.ts`
  Responsibility: assign live ids at ingest, buffer and expose early replay safely for transactional create, and append live events into the ledger.
- Modify: `server/ws-handler.ts`
  Responsibility: transactional `sdk.create`, typed restore outcome mapping, explicit create failure, replay ordering, and attach semantics against the ledger.
- Modify: `server/index.ts`
  Responsibility: instantiate the ledger manager, inject it into both `WsHandler` and the timeline router/service, and ensure both surfaces share one runtime authority.
- Modify: `shared/ws-protocol.ts`
  Responsibility: define `sdk.create.failed`, revision-bearing snapshots, and restore-specific error codes.
- Modify: `shared/read-models.ts`
  Responsibility: define revision-bearing agent timeline queries and stale-revision response schema.
- Modify: `src/lib/api.ts`
  Responsibility: send revision-pinned timeline and turn-body requests and surface stale-revision failures distinctly.
- Modify: `src/store/agentChatTypes.ts`
  Responsibility: represent canonical ids, revision-aware restore state, pending create failures, and stale-revision retry state.
- Modify: `src/store/agentChatSlice.ts`
  Responsibility: store create failure, revision-aware snapshots, canonical durable-id upgrades, and restore retry bookkeeping.
- Modify: `src/store/agentChatThunks.ts`
  Responsibility: restart restore exactly once on stale revision and preserve coherent state transitions.
- Modify: `src/lib/sdk-message-handler.ts`
  Responsibility: handle request-scoped create failure separately from session-lost runtime failure and preserve create-order invariants.
- Modify: `src/components/agent-chat/AgentChatView.tsx`
  Responsibility: drive one atomic restore flow, dispatch immediate flush on durable-id upgrade, and stop using timeout-based compensation where the protocol is now explicit.
- Create: `src/store/persistControl.ts`
  Responsibility: provide a targeted immediate layout flush action and selector helpers for recovery-critical persistence.
- Modify: `src/store/persistMiddleware.ts`
  Responsibility: honor targeted flush without changing normal debounce behavior.
- Modify: `src/store/crossTabSync.ts`
  Responsibility: reject stale layout payloads that would regress canonical durable identity after a newer flush.
- Modify: `test/unit/server/agent-timeline-history-source.test.ts`
  Responsibility: pin typed restore outcomes and explicitly narrow the legacy compatibility path.
- Create: `test/unit/server/agent-timeline-ledger.test.ts`
  Responsibility: verify stable ids, late durable-id upgrade, id-first merge, revisioning, and deterministic durable-id synthesis.
- Modify: `test/unit/server/ws-handler-sdk.test.ts`
  Responsibility: verify transactional `sdk.create`, create failure cleanup, replay ordering, and attach behavior against ledger outcomes.
- Modify: `test/integration/server/agent-timeline-router.test.ts`
  Responsibility: verify revision-pinned reads, stale-revision rejection, and revision-bearing cursors.
- Modify: `test/unit/client/sdk-message-handler.test.ts`
  Responsibility: verify request-scoped create failure and restore-specific error handling.
- Create: `test/unit/client/lib/sdk-message-handler.session-lost.test.ts`
  Responsibility: verify `INVALID_SESSION_ID` still triggers lost-session recovery while `sdk.create.failed` does not impersonate a lost session.
- Modify: `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`
  Responsibility: verify one-retry stale-revision behavior, canonical durable-id flush, and coherent restore sequencing.
- Create: `test/unit/client/store/persistControl.test.ts`
  Responsibility: verify only the canonical durable-id upgrade path forces immediate flush.
- Modify: `test/unit/client/store/crossTabSync.test.ts`
  Responsibility: verify stale rebroadcast cannot overwrite a newer canonical durable id.
- Modify: `test/e2e/agent-chat-restore-flow.test.tsx`
  Responsibility: verify the full reload/reconnect restore contract.
- Modify: `test/e2e/agent-chat-resume-history-flow.test.tsx`
  Responsibility: verify resumed create remains atomic, coherent, and durable-id upgrade-safe.

## Strategy Gate

- Do not keep two peer restore paths.
- Do not expose a session id to the client before coherent restore state exists.
- Do not use array index as canonical turn identity.
- Do not make content/timestamp overlap the primary merge algorithm.
- Do not make all persistence synchronous.
- Do not allow the HTTP timeline layer to serve a different revision than the snapshot without an explicit stale-revision error.
- Do not rely on later review rounds to resolve init ordering, runtime wiring, Redux shape, or persistence ownership; those are core design constraints now.

---

## Execution Tasks

### Task 1: Build The Canonical Ledger, Identity Rules, And Runtime Wiring

**Files:**
- Create: `server/agent-timeline/ledger.ts`
- Modify: `server/agent-timeline/history-source.ts`
- Modify: `server/agent-timeline/types.ts`
- Modify: `server/session-history-loader.ts`
- Modify: `server/sdk-bridge-types.ts`
- Modify: `server/sdk-bridge.ts`
- Modify: `server/index.ts`
- Test: `test/unit/server/agent-timeline-ledger.test.ts`
- Test: `test/unit/server/agent-timeline-history-source.test.ts`

- [ ] **Step 1: Write the failing server ledger and identity tests**

```ts
it('assigns deterministic durable ids for idless jsonl records using semantic fingerprints', async () => {
  const messages = extractChatMessagesFromJsonl(jsonlFixtureWithoutIds)
  expect(messages.map((m) => m.messageId)).toEqual([
    'durable:cli-1:4d5c9d2a:0',
    'durable:cli-1:ab17f0e3:0',
  ])
})

it('keeps durable ids stable across equivalent jsonl rewrites', async () => {
  const original = extractChatMessagesFromJsonl(jsonlFixtureWithoutIds)
  const rewritten = extractChatMessagesFromJsonl(jsonlFixtureEquivalentRewriteWithoutIds)
  expect(rewritten.map((m) => m.messageId)).toEqual(original.map((m) => m.messageId))
})

it('upgrades a live_only ledger in place when the canonical durable id arrives', () => {
  const ledger = createAgentRestoreLedger({ liveSessionId: 'sdk-1', timelineSessionId: 'named-resume' })
  const initialRevision = ledger.snapshot().revision
  ledger.appendLiveTurn(makeLiveTurn('live:sdk-1:0', 0))
  ledger.promoteDurableHistory({
    timelineSessionId: '00000000-0000-4000-8000-000000000321',
    turns: [makeDurableTurn('durable:cli-1:abc:0', 0)],
  })
  expect(ledger.snapshot()).toEqual(expect.objectContaining({
    mode: 'merged',
    timelineSessionId: '00000000-0000-4000-8000-000000000321',
    revision: initialRevision + 2,
  }))
})

it('returns typed restore outcomes instead of null-or-throw states', async () => {
  await expect(source.resolve('missing-cli')).resolves.toEqual({
    kind: 'missing',
    code: 'RESTORE_NOT_FOUND',
  })
})
```

- [ ] **Step 2: Run the focused server tests to verify they fail**

Run:

```bash
FRESHELL_TEST_SUMMARY="robust restore ledger red" npm run test:vitest -- --config vitest.server.config.ts test/unit/server/agent-timeline-ledger.test.ts test/unit/server/agent-timeline-history-source.test.ts
```

Expected: FAIL because the ledger, deterministic identity rules, typed outcomes, and shared runtime wiring do not exist yet.

- [ ] **Step 3: Implement the ledger, deterministic identity, and shared server wiring**

```ts
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

- Implement the canonical fingerprint algorithm exactly as defined above rather than leaving normalization to local judgment.
- Introduce a single ledger manager instance in `server/index.ts` and pass it into both `createAgentHistorySource()` and `createAgentTimelineService()` so the WebSocket and HTTP surfaces share one runtime authority.

- [ ] **Step 4: Re-run the focused server tests**

Run the command from Step 2.

Expected: PASS with stable identity, late durable-id upgrade support, and typed restore outcomes.

- [ ] **Step 5: Refactor and verify the server foundation**

Tighten naming and narrow compatibility seams so only the history source owns legacy heuristic merge behavior.

Run:

```bash
FRESHELL_TEST_SUMMARY="robust restore ledger verify" npm run test:vitest -- --config vitest.server.config.ts test/unit/server/agent-timeline-ledger.test.ts test/unit/server/agent-timeline-history-source.test.ts
```

Expected: PASS with no test weakening.

- [ ] **Step 6: Commit the ledger foundation**

```bash
git add server/agent-timeline/ledger.ts server/agent-timeline/history-source.ts server/agent-timeline/types.ts server/session-history-loader.ts server/sdk-bridge-types.ts server/sdk-bridge.ts server/index.ts test/unit/server/agent-timeline-ledger.test.ts test/unit/server/agent-timeline-history-source.test.ts
git commit -m "refactor: add canonical freshclaude restore ledger"
```

### Task 2: Make `sdk.create` Transactional And Replay-Ordered

**Files:**
- Modify: `server/sdk-bridge-types.ts`
- Modify: `server/sdk-bridge.ts`
- Modify: `server/ws-handler.ts`
- Modify: `shared/ws-protocol.ts`
- Modify: `src/lib/sdk-message-handler.ts`
- Modify: `src/store/agentChatTypes.ts`
- Modify: `src/store/agentChatSlice.ts`
- Test: `test/unit/server/ws-handler-sdk.test.ts`
- Test: `test/unit/client/sdk-message-handler.test.ts`
- Test: `test/unit/client/lib/sdk-message-handler.session-lost.test.ts`

- [ ] **Step 1: Write the failing transactional create and replay-order tests**

```ts
it('does not emit sdk.created when create-time restore fails', async () => {
  mockResolveRestore.mockResolvedValue({ kind: 'fatal', code: 'RESTORE_INTERNAL', message: 'boom' })
  const messages = await sendSdkCreateAndCollect()
  expect(messages.some((m) => m.type === 'sdk.created')).toBe(false)
  expect(messages).toContainEqual({
    type: 'sdk.create.failed',
    requestId: 'req-1',
    code: 'RESTORE_INTERNAL',
    message: 'boom',
    retryable: true,
  })
  expect(mockSdkBridge.killSession).toHaveBeenCalledWith('sdk-1')
})

it('emits created then snapshot then synthesized init before replaying buffered init metadata', async () => {
  const messages = await sendSdkCreateWithEarlyBufferedInit()
  expect(messages.map((m) => m.type)).toEqual([
    'sdk.created',
    'sdk.session.snapshot',
    'sdk.session.init',
    'sdk.status',
    'sdk.session.init',
  ])
})

it('treats sdk.create.failed as a retryable pending-create failure, not a lost session', () => {
  dispatch(handleSdkMessage(store.dispatch, {
    type: 'sdk.create.failed',
    requestId: 'req-1',
    code: 'RESTORE_INTERNAL',
    message: 'boom',
  }))
  expect(selectPendingCreate(state, 'req-1')).toBeUndefined()
  expect(selectSession(state, 'sdk-1')?.lost).not.toBe(true)
})
```

- [ ] **Step 2: Run the focused protocol and client tests to verify they fail**

Run:

```bash
FRESHELL_TEST_SUMMARY="robust restore create red" npm run test:vitest -- test/unit/server/ws-handler-sdk.test.ts test/unit/client/sdk-message-handler.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts
```

Expected: FAIL because request-scoped create failure, replay draining, and ordered transactional create do not exist yet.

- [ ] **Step 3: Implement request-scoped create failure and explicit replay draining**

```ts
export type SdkCreateFailedMessage = {
  type: 'sdk.create.failed'
  requestId: string
  code: 'RESTORE_NOT_FOUND' | 'RESTORE_UNAVAILABLE' | 'RESTORE_INTERNAL' | 'RESTORE_DIVERGED'
  message: string
  retryable?: boolean
}
```

- Add a bridge-level replay-drain seam so `WsHandler` can:
  - collect early buffered events without immediately broadcasting them
  - separate raw `system/init` from other replayable messages
  - emit the synthesized init first
  - replay the raw init last as a metadata refresh
- Extend `src/store/agentChatTypes.ts` in this task so Redux explicitly models:
  - pending create failure by `requestId`
  - snapshot revision
  - canonical `turnId` / `messageId` on timeline state

- [ ] **Step 4: Re-run the focused protocol and client tests**

Run the command from Step 2.

Expected: PASS with no half-created sessions and with explicit, deterministic replay order.

- [ ] **Step 5: Refactor and verify transactional ordering**

Remove redundant old assumptions that `sdk.created` must arrive merely to guard buffered bridge replay.

Run:

```bash
FRESHELL_TEST_SUMMARY="robust restore create verify" npm run test:vitest -- test/unit/server/ws-handler-sdk.test.ts test/unit/client/sdk-message-handler.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the transactional protocol change**

```bash
git add server/sdk-bridge-types.ts server/sdk-bridge.ts server/ws-handler.ts shared/ws-protocol.ts src/lib/sdk-message-handler.ts src/store/agentChatTypes.ts src/store/agentChatSlice.ts test/unit/server/ws-handler-sdk.test.ts test/unit/client/sdk-message-handler.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts
git commit -m "refactor: make freshclaude create transactional"
```

### Task 3: Make Snapshot And HTTP Restore Reads Revision-Coherent

**Files:**
- Modify: `shared/read-models.ts`
- Modify: `server/agent-timeline/types.ts`
- Modify: `server/agent-timeline/service.ts`
- Modify: `server/agent-timeline/router.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/store/agentChatTypes.ts`
- Modify: `src/store/agentChatSlice.ts`
- Modify: `src/store/agentChatThunks.ts`
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Test: `test/integration/server/agent-timeline-router.test.ts`
- Test: `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`
- Test: `test/e2e/agent-chat-restore-flow.test.tsx`

- [ ] **Step 1: Write the failing stale-revision tests**

```ts
it('rejects a timeline request whose revision does not match the ledger', async () => {
  const response = await request(app)
    .get('/api/agent-sessions/cli-1/timeline?priority=visible&revision=12')
  expect(response.status).toBe(409)
  expect(response.body).toEqual({
    error: 'Stale restore revision',
    code: 'RESTORE_STALE_REVISION',
    currentRevision: 13,
  })
})

it('restarts restore hydration once when the first visible page returns RESTORE_STALE_REVISION', async () => {
  mockGetAgentTimelinePage
    .mockRejectedValueOnce(staleRevisionError(13))
    .mockResolvedValueOnce(freshPage(13))
  // Expect one restart against a fresh snapshot and no mixed-state render.
})

it('fails visibly after a second stale-revision response', async () => {
  mockGetAgentTimelinePage.mockRejectedValue(staleRevisionError(13))
  // Expect exactly one automatic retry, then a visible restore error state.
})
```

- [ ] **Step 2: Run the revision-coherence tests to verify they fail**

Run:

```bash
FRESHELL_TEST_SUMMARY="robust restore revision red server" npm run test:vitest -- --config vitest.server.config.ts test/integration/server/agent-timeline-router.test.ts
FRESHELL_TEST_SUMMARY="robust restore revision red client" npm run test:vitest -- test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/e2e/agent-chat-restore-flow.test.tsx
```

Expected: FAIL because snapshot revision is not yet a strict read contract.

- [ ] **Step 3: Implement revision-pinned queries, responses, and one-retry client restart**

```ts
export const AgentTimelinePageQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  priority: ReadModelPrioritySchema.optional(),
  revision: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(MAX_AGENT_TIMELINE_ITEMS).optional(),
  includeBodies: z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]).optional(),
})
```

- Encode the revision into timeline cursors so pagination cannot drift.
- Extend `src/store/agentChatTypes.ts` in this task with:
  - `restoreRevision`
  - `restoreRetryCount`
  - `restoreFailureCode`
- Remove any timeout-based "maybe it will recover" logic in `AgentChatView.tsx` that conflicts with explicit stale-revision handling.

- [ ] **Step 4: Re-run the revision-coherence tests**

Run the commands from Step 2.

Expected: PASS with explicit stale-revision rejection and exactly one automatic restart.

- [ ] **Step 5: Refactor and verify revision coherence**

Tighten error translation so stale-revision HTTP errors stay distinct from generic read failures end-to-end.

Run:

```bash
FRESHELL_TEST_SUMMARY="robust restore revision verify server" npm run test:vitest -- --config vitest.server.config.ts test/integration/server/agent-timeline-router.test.ts
FRESHELL_TEST_SUMMARY="robust restore revision verify client" npm run test:vitest -- test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/e2e/agent-chat-restore-flow.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit revision coherence**

```bash
git add shared/read-models.ts server/agent-timeline/types.ts server/agent-timeline/service.ts server/agent-timeline/router.ts src/lib/api.ts src/store/agentChatTypes.ts src/store/agentChatSlice.ts src/store/agentChatThunks.ts src/components/agent-chat/AgentChatView.tsx test/integration/server/agent-timeline-router.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/e2e/agent-chat-restore-flow.test.tsx
git commit -m "refactor: pin freshclaude restore to ledger revision"
```

### Task 4: Persist Canonical Durable Identity Immediately And Defend It Across Tabs

**Files:**
- Create: `src/store/persistControl.ts`
- Modify: `src/store/persistMiddleware.ts`
- Modify: `src/store/crossTabSync.ts`
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Modify: `src/store/agentChatTypes.ts`
- Modify: `src/store/agentChatSlice.ts`
- Test: `test/unit/client/store/persistControl.test.ts`
- Test: `test/unit/client/store/crossTabSync.test.ts`
- Test: `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`

- [ ] **Step 1: Write the failing persistence and cross-tab protection tests**

```ts
it('dispatches a targeted flush when a canonical durable id upgrades from named resume', async () => {
  render(<AgentChatView ... />)
  deliverSdkSnapshot({
    sessionId: 'sdk-1',
    timelineSessionId: '00000000-0000-4000-8000-000000000321',
    revision: 9,
    latestTurnId: 'turn-live-4',
    status: 'running',
  })
  await waitFor(() => expect(storeDispatch).toHaveBeenCalledWith(flushPersistedLayoutNow()))
})

it('rejects stale rebroadcast layout that would overwrite a newer canonical durable id', () => {
  hydrateLocalStateWithResumeId('00000000-0000-4000-8000-000000000321')
  deliverCrossTabLayoutWithResumeId('named-resume')
  expect(selectPaneResumeSessionId(store.getState(), 'pane-1')).toBe('00000000-0000-4000-8000-000000000321')
})

it('does not force immediate flush for unrelated session updates', () => {
  store.dispatch(setSessionStatus({ sessionId: 'sdk-1', status: 'idle' }))
  expect(localStorage.setItem).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run the targeted persistence tests to verify they fail**

Run:

```bash
FRESHELL_TEST_SUMMARY="robust restore persist red" npm run test:vitest -- test/unit/client/store/persistControl.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx
```

Expected: FAIL because no targeted flush control or stale rebroadcast rejection exists yet.

- [ ] **Step 3: Implement targeted flush and stale overwrite protection**

```ts
export const flushPersistedLayoutNow = createAction('persist/flushNow')
```

- Use canonical durable-id transition detection in Redux/client state, not ad hoc component-local comparison, so the flush rule has one owner.
- Update `crossTabSync.ts` to compare incoming persisted identity against local canonical identity and ignore regressive payloads while still accepting non-conflicting remote changes.

- [ ] **Step 4: Re-run the targeted persistence tests**

Run the command from Step 2.

Expected: PASS with the crash window closed and no blanket synchronous persistence.

- [ ] **Step 5: Refactor and verify persistence ownership**

Make sure the flush trigger is specific to the canonical durable-id upgrade and does not expand into a general persistence bypass.

Run:

```bash
FRESHELL_TEST_SUMMARY="robust restore persist verify" npm run test:vitest -- test/unit/client/store/persistControl.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit the recovery-critical persistence behavior**

```bash
git add src/store/persistControl.ts src/store/persistMiddleware.ts src/store/crossTabSync.ts src/components/agent-chat/AgentChatView.tsx src/store/agentChatTypes.ts src/store/agentChatSlice.ts test/unit/client/store/persistControl.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx
git commit -m "fix: persist canonical freshclaude identity immediately"
```

### Task 5: Lock In Adversarial Coverage, Documentation, And Final Verification

**Files:**
- Modify: `docs/plans/2026-04-02-freshclaude-restore-audit.md`
- Modify: `docs/plans/2026-04-02-freshclaude-restore-audit-test-plan.md`
- Modify: `test/e2e/agent-chat-resume-history-flow.test.tsx`
- Modify: `test/e2e/agent-chat-restore-flow.test.tsx`
- Modify: `test/unit/server/agent-timeline-history-source.test.ts`
- Modify: `test/unit/server/ws-handler-sdk.test.ts`

- [ ] **Step 1: Add the remaining adversarial coverage**

Add or extend tests for:
- create failure cleanup and no leaked visible session id
- named-resume upgrade from `live_only` to canonical durable id
- durable-only restore after server restart
- legacy idless durable-session compatibility path
- stale-revision retry limit
- stale cross-tab overwrite rejection after immediate flush

- [ ] **Step 2: Run the focused adversarial suite**

Run:

```bash
FRESHELL_TEST_SUMMARY="robust restore adversarial" npm run test:vitest -- --config vitest.server.config.ts test/unit/server/agent-timeline-history-source.test.ts test/unit/server/ws-handler-sdk.test.ts
FRESHELL_TEST_SUMMARY="robust restore adversarial client" npm run test:vitest -- test/e2e/agent-chat-restore-flow.test.tsx test/e2e/agent-chat-resume-history-flow.test.tsx
```

Expected: PASS with no restore regression gaps left untested.

- [ ] **Step 3: Update the superseded April 2 plan docs**

Add a short note at the top of both April 2 docs that this April 3 redesign supersedes them as the authoritative restore direction because it removes split ownership and fallback-style restore semantics.

- [ ] **Step 4: Run the broad coordinated verification**

Run:

```bash
FRESHELL_TEST_SUMMARY="robust restore full verify" npm run check
FRESHELL_TEST_SUMMARY="robust restore full test" npm test
```

Expected: PASS across client, server, and electron with no skipped restore tests.

- [ ] **Step 5: Refactor and verify no test was weakened**

Review the changed restore tests and remove any assertions that merely mirror implementation details without protecting user-visible behavior or invariants.

Run:

```bash
FRESHELL_TEST_SUMMARY="robust restore final spot-check" npm run test:vitest -- test/e2e/agent-chat-restore-flow.test.tsx test/e2e/agent-chat-resume-history-flow.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit adversarial coverage and documentation handoff**

```bash
git add docs/plans/2026-04-02-freshclaude-restore-audit.md docs/plans/2026-04-02-freshclaude-restore-audit-test-plan.md test/e2e/agent-chat-resume-history-flow.test.tsx test/e2e/agent-chat-restore-flow.test.tsx test/unit/server/agent-timeline-history-source.test.ts test/unit/server/ws-handler-sdk.test.ts
git commit -m "test: lock in robust freshclaude restore contract"
```

## Execution Notes

- This plan intentionally lands the steady-state architecture directly. Do not reintroduce interim restore fallbacks as a separate final design.
- The only compatibility bridge that remains acceptable is the explicit legacy idless durable-session path inside the ledger boundary; even that path should stay narrow and well tested.
- If implementation discovers authoritative upstream message ids in Claude JSONL or the SDK stream, prefer plumbing them immediately rather than continuing to synthesize local ids where unnecessary.
- If a full-suite failure reveals an unrelated regression already present on branch, stop and fix it before merge as required by repo policy; do not declare restore work complete with a red broad suite.
