# Terminal Stream V2 Responsiveness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Use `@superpowers:executing-plans` for execution handoff.

**Goal:** Replace reconnect-heavy terminal transport with a sequence-based, bounded, non-destructive streaming architecture so terminals remain interactive on slow/flaky links (SSH-like behavior).

**Architecture:** Introduce a server-side terminal stream broker that decouples PTY lifecycle from WebSocket transport, uses sequence replay (`sinceSeq`) instead of snapshot reattach, and applies bounded per-client output queues with explicit gap signaling (instead of routine socket closes). Perform a hard protocol cutover (no backward compatibility), plus a deterministic client upgrade path that clears/migrates stale persisted data while preserving auth token/cookie continuity.

**Tech Stack:** Node.js + `ws`, React 18, Redux Toolkit, TypeScript, Zod schemas, Vitest (unit/e2e/integration), xterm.js.

---

## Hard-Cutover Rules (Explicit)

1. No protocol compatibility shim for old attach/snapshot/chunk messages.
2. Client and server both require `WS_PROTOCOL_VERSION = 2`.
3. Persisted UI state is namespace-bumped (`*.v2`) and legacy persisted state is cleared during upgrade.
4. Auth continuity is preserved: keep token across storage reset and re-issue `freshell-auth` cookie.
5. Routine terminal slow-consumer handling must never close the websocket; only catastrophic safety breakers may close.

---

## System Invariants (Must Hold)

1. `terminal.input` path is independent from output backlog and remains low-latency.
2. Terminal output memory is bounded at all levels (PTY replay ring, broker queue, ws buffered amount guardrails).
3. If output is dropped due pressure, user receives explicit `terminal.output.gap` marker.
4. Reconnect/reattach sends only missing sequence range when possible.
5. No full-screen blocking reconnect spinner during normal degraded transport.

---

### Task 1: Define Terminal Stream V2 Protocol Contract (Breaking)

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-handler.ts`
- Modify: `src/lib/ws-client.ts`
- Test: `test/unit/server/ws-handler-sdk.test.ts`
- Test: `test/unit/client/lib/ws-client.test.ts`

**Step 1: Write failing protocol/version tests**

Add tests that require:
- `hello.protocolVersion === 2`
- server closes with `PROTOCOL_MISMATCH` when version missing/mismatched
- client treats mismatch as fatal upgrade-required state (no reconnect loop)

```ts
expect(close.code).toBe(4010)
expect(error.code).toBe('PROTOCOL_MISMATCH')
```

**Step 2: Run tests to verify failure**

Run:

```bash
npm test -- test/unit/server/ws-handler-sdk.test.ts -t "PROTOCOL_MISMATCH"
npm test -- test/unit/client/lib/ws-client.test.ts -t "protocol version"
```

Expected: FAIL (schemas and close handling not implemented).

**Step 3: Implement V2 protocol primitives**

In `shared/ws-protocol.ts`:

```ts
export const WS_PROTOCOL_VERSION = 2

export const HelloSchema = z.object({
  type: z.literal('hello'),
  token: z.string().optional(),
  protocolVersion: z.literal(WS_PROTOCOL_VERSION),
  ...
})

export const TerminalAttachSchema = z.object({
  type: z.literal('terminal.attach'),
  terminalId: z.string().min(1),
  sinceSeq: z.number().int().nonnegative().optional(),
})
```

Add/replace server message types with V2 stream messages:

```ts
type TerminalAttachReadyMessage = {
  type: 'terminal.attach.ready'
  terminalId: string
  headSeq: number
  replayFromSeq: number
  replayToSeq: number
}

type TerminalOutputMessage = {
  type: 'terminal.output'
  terminalId: string
  seqStart: number
  seqEnd: number
  data: string
}

type TerminalOutputGapMessage = {
  type: 'terminal.output.gap'
  terminalId: string
  fromSeq: number
  toSeq: number
  reason: 'queue_overflow' | 'replay_window_exceeded'
}
```

In `server/ws-handler.ts`, reject mismatched `protocolVersion` with close code `4010` and typed error.

In `src/lib/ws-client.ts`, handle `4010` as fatal (set explicit upgrade-required error, no reconnect timer).

**Step 4: Run tests to verify pass**

Run:

```bash
npm test -- test/unit/server/ws-handler-sdk.test.ts -t "PROTOCOL_MISMATCH"
npm test -- test/unit/client/lib/ws-client.test.ts -t "protocol version"
```

Expected: PASS.

**Step 5: Commit**

```bash
git add shared/ws-protocol.ts server/ws-handler.ts src/lib/ws-client.ts test/unit/server/ws-handler-sdk.test.ts test/unit/client/lib/ws-client.test.ts
git commit -m "feat(protocol): enforce websocket protocol v2 with hard mismatch rejection and attach sinceSeq contract"
```

---

### Task 2: Implement Deterministic Client Upgrade + Storage/Cookie Safety

**Files:**
- Create: `src/bootstrap/client-upgrade.ts`
- Modify: `src/main.tsx`
- Modify: `src/lib/auth.ts`
- Modify: `src/store/storage-migration.ts`
- Test: `test/unit/client/bootstrap/client-upgrade.test.ts`

**Step 1: Write failing upgrade tests**

Cover:
- preserves auth token while clearing legacy `freshell.*.v1`
- restores `freshell-auth` cookie from preserved token
- clears stale cookie when no token exists
- bumps migration marker and performs idempotent no-op on second run

```ts
expect(localStorage.getItem('freshell.auth-token')).toBe('token-123')
expect(document.cookie).toContain('freshell-auth=token-123')
expect(localStorage.getItem('freshell.tabs.v1')).toBeNull()
```

**Step 2: Run tests to verify failure**

Run:

```bash
npm test -- test/unit/client/bootstrap/client-upgrade.test.ts
```

Expected: FAIL (upgrade module missing).

**Step 3: Implement synchronous upgrade bootstrap**

In `src/bootstrap/client-upgrade.ts`:

```ts
const CLIENT_STORAGE_SCHEMA_VERSION = 3

export function runClientUpgrade(): void {
  const authToken = readBestAuthTokenSource() // URL token > localStorage > legacy session > cookie
  const current = Number(localStorage.getItem('freshell.storage-schema') || '0')
  if (current >= CLIENT_STORAGE_SCHEMA_VERSION) {
    if (authToken) persistAuthTokenAndCookie(authToken)
    return
  }

  clearLegacyFreshellKeysExceptAuth()
  if (authToken) persistAuthTokenAndCookie(authToken)
  else clearAuthCookie()

  localStorage.setItem('freshell.storage-schema', String(CLIENT_STORAGE_SCHEMA_VERSION))
}
```

In `src/main.tsx`, run upgrade before store creation by moving store import to bootstrap phase:

```ts
runClientUpgrade()
const { store } = await import('@/store/store')
```

(Use top-level async bootstrap function to avoid ESM import-order race.)

**Step 4: Run tests to verify pass**

Run:

```bash
npm test -- test/unit/client/bootstrap/client-upgrade.test.ts
npm test -- test/unit/client/lib/ws-client.test.ts -t "protocol version"
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/bootstrap/client-upgrade.ts src/main.tsx src/lib/auth.ts src/store/storage-migration.ts test/unit/client/bootstrap/client-upgrade.test.ts
git commit -m "feat(bootstrap): hard-cut client upgrade clears legacy storage while preserving auth token and cookie continuity"
```

---

### Task 3: Namespace Persisted Client State to V2 Keys

**Files:**
- Create: `src/store/storage-keys.ts`
- Modify: `src/store/persistedState.ts`
- Modify: `src/store/persistMiddleware.ts`
- Modify: `src/store/panesSlice.ts`
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/store/sessionActivitySlice.ts`
- Modify: `src/store/tabRegistrySlice.ts`
- Modify: `src/store/persistBroadcast.ts`
- Modify: `src/store/crossTabSync.ts`
- Test: `test/unit/client/store/persistedState.test.ts`
- Test: `test/unit/client/store/panesPersistence.test.ts`
- Test: `test/unit/client/store/tabsPersistence.test.ts`

**Step 1: Write failing key-namespace tests**

Require all store persistence reads/writes to use `.v2` keys and broadcast channel `freshell.persist.v2`.

```ts
expect(TABS_STORAGE_KEY).toBe('freshell.tabs.v2')
expect(PANES_STORAGE_KEY).toBe('freshell.panes.v2')
expect(PERSIST_BROADCAST_CHANNEL_NAME).toBe('freshell.persist.v2')
```

**Step 2: Run tests to verify failure**

Run:

```bash
npm test -- test/unit/client/store/persistedState.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/tabsPersistence.test.ts
```

Expected: FAIL.

**Step 3: Implement storage key centralization + migration-safe wiring**

Create `src/store/storage-keys.ts` and replace all hardcoded key strings.

```ts
export const STORAGE_KEYS = {
  tabs: 'freshell.tabs.v2',
  panes: 'freshell.panes.v2',
  sessionActivity: 'freshell.sessionActivity.v2',
  deviceId: 'freshell.device-id.v2',
  ...
} as const
```

Update broadcast channel constant to `freshell.persist.v2`.

**Step 4: Run tests to verify pass**

Run:

```bash
npm test -- test/unit/client/store/persistedState.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/tabsPersistence.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/store/storage-keys.ts src/store/persistedState.ts src/store/persistMiddleware.ts src/store/panesSlice.ts src/store/tabsSlice.ts src/store/sessionActivitySlice.ts src/store/tabRegistrySlice.ts src/store/persistBroadcast.ts src/store/crossTabSync.ts test/unit/client/store/persistedState.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/tabsPersistence.test.ts
git commit -m "refactor(storage): move persisted client state to v2 keys and channel namespace for hard protocol cutover"
```

---

### Task 4: Refactor TerminalRegistry to Transport-Agnostic PTY Core

**Files:**
- Modify: `server/terminal-registry.ts`
- Test: `test/unit/server/terminal-lifecycle.test.ts`
- Test: `test/server/ws-edge-cases.test.ts`

**Step 1: Write failing transport-decoupling tests**

Add tests that assert:
- registry emits terminal output events
- registry no longer directly owns websocket clients or sends frames
- terminal list `hasClients` derives from broker-managed attachment counts

```ts
expect(onOutput).toHaveBeenCalledWith(
  expect.objectContaining({ terminalId, data: 'hello' })
)
```

**Step 2: Run tests to verify failure**

Run:

```bash
npm test -- test/unit/server/terminal-lifecycle.test.ts -t "transport agnostic"
```

Expected: FAIL.

**Step 3: Implement registry decoupling**

Remove direct websocket send logic from `TerminalRegistry` (`sendTerminalOutput`, output buffer flushing, pending snapshot client maps).

Replace with events:

```ts
this.emit('terminal.output', {
  terminalId,
  data,
  at: Date.now(),
})
```

Track only opaque attachment count metadata:

```ts
attachClient(terminalId: string, clientId: string): boolean
detachClient(terminalId: string, clientId: string): boolean
```

**Step 4: Run tests to verify pass**

Run:

```bash
npm test -- test/unit/server/terminal-lifecycle.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/terminal-registry.ts test/unit/server/terminal-lifecycle.test.ts test/server/ws-edge-cases.test.ts
git commit -m "refactor(server): decouple terminal registry from websocket transport and emit output events"
```

---

### Task 5: Build Sequence Replay Ring (Server)

**Files:**
- Create: `server/terminal-stream/replay-ring.ts`
- Create: `test/unit/server/terminal-stream/replay-ring.test.ts`

**Step 1: Write failing replay ring tests**

Cover:
- monotonic sequence assignment
- bounded byte eviction
- replay since sequence
- replay miss detection (requested seq older than tail)

```ts
expect(ring.headSeq()).toBe(42)
expect(ring.tailSeq()).toBeGreaterThan(1)
expect(result.missedFromSeq).toBe(3)
```

**Step 2: Run tests to verify failure**

Run:

```bash
npm test -- test/unit/server/terminal-stream/replay-ring.test.ts
```

Expected: FAIL (module absent).

**Step 3: Implement replay ring**

`server/terminal-stream/replay-ring.ts`:

```ts
export type ReplayFrame = {
  seqStart: number
  seqEnd: number
  data: string
  bytes: number
  at: number
}

export class ReplayRing {
  append(data: string): ReplayFrame { ... }
  replaySince(sinceSeq?: number): { frames: ReplayFrame[]; missedFromSeq?: number } { ... }
  headSeq(): number { ... }
  tailSeq(): number { ... }
}
```

Use UTF-8 byte sizing (`Buffer.byteLength`) for memory budget enforcement.

**Step 4: Run tests to verify pass**

Run:

```bash
npm test -- test/unit/server/terminal-stream/replay-ring.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/terminal-stream/replay-ring.ts test/unit/server/terminal-stream/replay-ring.test.ts
git commit -m "feat(server): add bounded sequence replay ring for terminal output delta reattach"
```

---

### Task 6: Build Bounded Client Output Queue + Gap Signaling

**Files:**
- Create: `server/terminal-stream/client-output-queue.ts`
- Create: `test/unit/server/terminal-stream/client-output-queue.test.ts`

**Step 1: Write failing queue tests**

Cover:
- per-client bounded queue
- coalescing adjacent frames
- overflow drops oldest frames
- emits single coalesced gap range after overflow

```ts
expect(events).toContainEqual({
  type: 'gap',
  fromSeq: 120,
  toSeq: 180,
})
```

**Step 2: Run tests to verify failure**

Run:

```bash
npm test -- test/unit/server/terminal-stream/client-output-queue.test.ts
```

Expected: FAIL.

**Step 3: Implement queue semantics**

`server/terminal-stream/client-output-queue.ts`:

```ts
export class ClientOutputQueue {
  enqueue(frame: ReplayFrame): void
  nextBatch(maxBytes: number): Array<ReplayFrame | GapEvent>
  pendingBytes(): number
}
```

Policy:
- drop oldest data frames on overflow
- store dropped range as pending gap
- emit `gap` before next data batch

**Step 4: Run tests to verify pass**

Run:

```bash
npm test -- test/unit/server/terminal-stream/client-output-queue.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/terminal-stream/client-output-queue.ts test/unit/server/terminal-stream/client-output-queue.test.ts
git commit -m "feat(server): add bounded per-client terminal output queue with explicit overflow gap signaling"
```

---

### Task 7: Implement TerminalStreamBroker and Wire WsHandler

**Files:**
- Create: `server/terminal-stream/broker.ts`
- Create: `server/terminal-stream/types.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/index.ts`
- Test: `test/unit/server/ws-handler-backpressure.test.ts`
- Test: `test/server/ws-edge-cases.test.ts`
- Test: `test/server/ws-terminal-create-reuse-running-codex.test.ts`

**Step 1: Write failing broker integration tests**

Add tests requiring:
- `terminal.attach` with `sinceSeq` replays only missing frames
- no routine `4008` close under slow consumer simulation
- emits `terminal.output.gap` on bounded overflow instead of close

```ts
expect(closeCode).not.toBe(4008)
expect(messages.some((m) => m.type === 'terminal.output.gap')).toBe(true)
```

**Step 2: Run tests to verify failure**

Run:

```bash
npm test -- test/server/ws-edge-cases.test.ts -t "sinceSeq|output.gap|no routine 4008"
```

Expected: FAIL.

**Step 3: Implement broker and ws-handler delegation**

`server/terminal-stream/broker.ts` responsibilities:
- subscribe/unsubscribe websocket clients to terminal IDs
- route registry output events into replay ring + client queues
- handle `terminal.attach` replay (`sinceSeq`)
- emit `terminal.attach.ready`, `terminal.output`, `terminal.output.gap`
- maintain per-terminal attachment counts for list metadata

In `server/ws-handler.ts`, remove chunked attach snapshot path (`terminal.attached*`) and call broker APIs.

**Step 4: Run tests to verify pass**

Run:

```bash
npm test -- test/unit/server/ws-handler-backpressure.test.ts test/server/ws-edge-cases.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/terminal-stream/broker.ts server/terminal-stream/types.ts server/ws-handler.ts server/index.ts test/unit/server/ws-handler-backpressure.test.ts test/server/ws-edge-cases.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts
git commit -m "feat(server): add terminal stream broker with sinceSeq replay and non-destructive slow-consumer handling"
```

---

### Task 8: Update Client TerminalView for V2 Stream (No Chunked Attach)

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Delete: `src/components/terminal/useChunkedAttach.ts`
- Modify: `src/store/paneTypes.ts`
- Modify: `src/store/types.ts`
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Test: `test/e2e/terminal-console-violations-regression.test.tsx`

**Step 1: Write failing client stream tests**

Require:
- terminal attach sends `sinceSeq`
- `terminal.output` with sequence applies in-order
- `terminal.output.gap` renders system marker
- reconnect no longer depends on `terminal.attached.start/chunk/end`

```ts
expect(ws.send).toHaveBeenCalledWith({
  type: 'terminal.attach',
  terminalId: 'term-1',
  sinceSeq: 900,
})
```

**Step 2: Run tests to verify failure**

Run:

```bash
npm test -- test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: FAIL.

**Step 3: Implement TerminalView V2 stream handling**

In `src/components/TerminalView.tsx`:
- remove `useChunkedAttach` flow
- track `lastSeqRef` per terminal
- send `sinceSeq` on attach/reconnect
- on `terminal.output`: write and update `lastSeqRef`
- on `terminal.output.gap`: write explicit marker line

```ts
if (msg.type === 'terminal.output' && msg.terminalId === tid) {
  if (msg.seqEnd <= lastSeqRef.current) return
  enqueueTerminalWrite(msg.data)
  lastSeqRef.current = msg.seqEnd
}

if (msg.type === 'terminal.output.gap' && msg.terminalId === tid) {
  term.writeln(`\r\n[Output gap ${msg.fromSeq}-${msg.toSeq}: ${msg.reason}]\r\n`)
}
```

**Step 4: Run tests to verify pass**

Run:

```bash
npm test -- test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/terminal-console-violations-regression.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/TerminalView.tsx src/store/paneTypes.ts src/store/types.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/terminal-console-violations-regression.test.tsx
git rm src/components/terminal/useChunkedAttach.ts
git commit -m "feat(client): switch terminal view to v2 sequence stream and remove chunked attach snapshot path"
```

---

### Task 9: Make Reconnect UX Non-Blocking and Clean

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/store/connectionSlice.ts`
- Modify: `src/components/terminal/ConnectionErrorOverlay.tsx`
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Update: `docs/index.html`

**Step 1: Write failing UX tests**

Require:
- reconnect state does not render full-screen blocking overlay
- terminal remains focusable and can send input while stream recovers
- only severe/fatal states use blocking overlay

```ts
expect(screen.queryByText('Reconnecting...')).not.toBeInTheDocument()
expect(sendInputSpy).toHaveBeenCalled()
```

**Step 2: Run tests to verify failure**

Run:

```bash
npm test -- test/unit/client/components/TerminalView.lifecycle.test.tsx -t "non-blocking reconnect"
```

Expected: FAIL.

**Step 3: Implement non-blocking status treatment**

Change spinner overlay logic:

```ts
const showBlockingSpinner = terminalContent.status === 'creating' && connectionErrorCode !== 4003
```

Add inline status badge/banner for reconnect/degraded stream; keep `ConnectionErrorOverlay` only for fatal limits.

Update `docs/index.html` mock to reflect inline degraded status treatment.

**Step 4: Run tests to verify pass**

Run:

```bash
npm test -- test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/TerminalView.tsx src/store/connectionSlice.ts src/components/terminal/ConnectionErrorOverlay.tsx docs/index.html test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "feat(ui): make terminal reconnect state non-blocking and align mock docs with degraded-stream status"
```

---

### Task 10: Remove Obsolete Snapshot/Chunking Infrastructure

**Files:**
- Modify: `server/ws-handler.ts`
- Modify: `server/ws-chunking.ts`
- Modify: `shared/ws-protocol.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Test: `test/server/ws-edge-cases.test.ts`

**Step 1: Write failing cleanup tests**

Add assertions that legacy chunked attach message types are no longer emitted.

```ts
expect(messages.some((m) => m.type === 'terminal.attached.start')).toBe(false)
expect(messages.some((m) => m.type === 'terminal.attached.chunk')).toBe(false)
```

**Step 2: Run tests to verify failure**

Run:

```bash
npm test -- test/server/ws-edge-cases.test.ts -t "no legacy attach chunk messages"
```

Expected: FAIL.

**Step 3: Remove dead code and env docs**

Remove/replace:
- `terminal.attached*` stream sender paths
- attach chunk constants and timeouts
- legacy docs for `MAX_WS_ATTACH_CHUNK_BYTES` / `WS_ATTACH_FRAME_SEND_TIMEOUT_MS` where no longer used for terminal replay

Update README transport section to sequence replay and gap semantics.

**Step 4: Run tests to verify pass**

Run:

```bash
npm test -- test/server/ws-edge-cases.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/ws-handler.ts server/ws-chunking.ts shared/ws-protocol.ts .env.example README.md test/server/ws-edge-cases.test.ts
git commit -m "chore(transport): remove legacy attach snapshot chunk pipeline after v2 stream cutover"
```

---

### Task 11: Add Flaky-Network Regression Coverage (Unit + Integration + e2e)

**Files:**
- Create: `test/server/ws-terminal-stream-v2-replay.test.ts`
- Create: `test/e2e/terminal-flaky-network-responsiveness.test.tsx`
- Modify: `test/unit/server/ws-handler-backpressure.test.ts`
- Modify: `test/unit/client/lib/ws-client.test.ts`

**Step 1: Write failing resilience tests**

Add scenarios:
- simulated high `bufferedAmount` does not cause routine disconnect for terminal stream
- reconnect with `sinceSeq` recovers only delta
- queue overflow emits `terminal.output.gap` and continues streaming
- client no 5-second reconnect loop for ordinary backlog

```ts
expect(closeCodes).not.toContain(4008)
expect(replayedSeqStart).toBe(lastSeenSeq + 1)
expect(gapEvents.length).toBeGreaterThan(0)
```

**Step 2: Run tests to verify failure**

Run:

```bash
npm test -- test/unit/server/ws-handler-backpressure.test.ts test/server/ws-terminal-stream-v2-replay.test.ts test/e2e/terminal-flaky-network-responsiveness.test.tsx
```

Expected: FAIL.

**Step 3: Implement missing behavior discovered by tests**

Apply targeted fixes in broker/ws-client/TerminalView only where tests fail.

**Step 4: Run tests to verify pass**

Run:

```bash
npm test -- test/unit/server/ws-handler-backpressure.test.ts test/server/ws-terminal-stream-v2-replay.test.ts test/e2e/terminal-flaky-network-responsiveness.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/server/ws-terminal-stream-v2-replay.test.ts test/e2e/terminal-flaky-network-responsiveness.test.tsx test/unit/server/ws-handler-backpressure.test.ts test/unit/client/lib/ws-client.test.ts
git commit -m "test(resilience): lock in v2 terminal streaming behavior under flaky-network and backpressure conditions"
```

---

### Task 12: Observability, Final Verification, and Merge Readiness

**Files:**
- Modify: `server/perf-logger.ts`
- Modify: `server/terminal-stream/broker.ts`
- Modify: `src/lib/perf-logger.ts`
- Modify: `README.md`

**Step 1: Write failing observability tests**

Require logs/metrics for:
- replay hit/miss
- queue overflow count
- emitted gap ranges
- input-to-first-output latency percentile samples

```ts
expect(perfEvents).toContainEqual(expect.objectContaining({ event: 'terminal_stream_gap' }))
```

**Step 2: Run tests to verify failure**

Run:

```bash
npm test -- test/unit/server/ws-handler-backpressure.test.ts -t "terminal_stream_gap|replay"
```

Expected: FAIL.

**Step 3: Implement perf instrumentation + docs**

Add server events:
- `terminal_stream_replay_hit`
- `terminal_stream_replay_miss`
- `terminal_stream_gap`
- `terminal_stream_queue_pressure`

Document operational guidance and new env knobs in `README.md`.

**Step 4: Full verification run**

Run:

```bash
npm run lint
npm run check
npm test
npm run verify
```

Expected: all PASS.

**Step 5: Commit**

```bash
git add server/perf-logger.ts server/terminal-stream/broker.ts src/lib/perf-logger.ts README.md
git commit -m "chore(observability): add terminal stream v2 replay/gap/queue metrics and finalize operational docs"
```

---

## Final Cleanup Checklist (Before Fast-Forward to Main)

1. Confirm no references remain to `terminal.attached.start|chunk|end`.
2. Confirm no runtime path closes websocket for ordinary terminal output backpressure.
3. Confirm `freshell.*.v1` keys are never read or written by current code.
4. Confirm auth token survives upgrade and cookie is re-synced.
5. Confirm `docs/index.html` reflects non-blocking reconnect UX.

---

## Execution Notes

1. Keep commits exactly per task to simplify rollback and review.
2. If any pre-existing test fails during execution, stop and fix before continuing.
3. Do not merge into `main` directly; complete in this worktree branch and fast-forward only after full green suite.

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-02-21-terminal-stream-v2-responsiveness.md`.

Two execution options:

1. **Subagent-Driven (this session)** - Dispatch a fresh subagent per task, review output between tasks, and iterate quickly in this same worktree.
2. **Parallel Session (separate)** - Open a separate session in this worktree and execute with `@superpowers:executing-plans` in controlled batches with checkpoints.
