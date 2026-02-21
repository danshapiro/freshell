# Terminal Stream V2 Responsiveness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Use `@superpowers:executing-plans` for execution handoff.

**Goal:** Replace reconnect-heavy terminal transport with a sequence-based, bounded, non-destructive streaming architecture so terminals stay interactive and low-latency on slow/flaky links.

**Architecture:** Introduce a server-side terminal stream broker that decouples PTY lifecycle from WebSocket transport, uses sequence replay (`sinceSeq`) instead of snapshot reattach, and applies bounded per-client output queues with explicit gap signaling (instead of routine socket closes). Perform a hard protocol cutover (no backward compatibility), plus a deterministic client upgrade path that clears/migrates stale persisted data while preserving auth token/cookie continuity.

**Tech Stack:** Node.js + `ws`, React 18, Redux Toolkit, TypeScript, Zod schemas, Vitest (unit/e2e/integration), xterm.js.

---

## Hard-Cutover Rules (Explicit)

1. No protocol compatibility shim for old attach/snapshot/chunk messages.
2. Client and server both require `WS_PROTOCOL_VERSION = 2`.
3. Persisted UI state is namespace-bumped (`*.v2`) and legacy persisted state is cleared during upgrade.
4. Auth continuity is preserved: keep token across storage reset and re-issue `freshell-auth` cookie.
5. Routine terminal slow-consumer handling must never close the websocket.
6. Catastrophic safety breaker is explicit: close with `4008` only if `ws.bufferedAmount > 16 MiB` for `>= 10s` despite queue shedding.

---

## System Invariants (Must Hold)

1. `terminal.input` path is independent from output backlog and remains low-latency.
2. Terminal output memory is bounded at all levels (PTY replay ring, broker queue, ws buffered amount guardrails and catastrophic breaker).
3. If output is dropped due pressure, user receives explicit `terminal.output.gap` marker.
4. Reconnect/reattach sends only missing sequence range when possible.
5. No full-screen blocking reconnect spinner during normal degraded transport.
6. Sequence semantics are explicit and consistent across server/client/tests: all `seq*` and gap ranges are inclusive.

---

## Protocol Semantics (Normative)

1. `protocolVersion` in `hello` is new in v2; pre-v2 clients send no version and are rejected by design.
2. Sequence domain is per terminal and starts at `1`.
3. `seqStart` and `seqEnd` are inclusive frame sequence numbers.
4. `sinceSeq` means "highest contiguous sequence already rendered by the client"; server replays `seq > sinceSeq`.
5. `terminal.output.gap.fromSeq` and `.toSeq` are inclusive dropped ranges.
6. `headSeq` is the current inclusive high-water mark at the end of attach replay assembly.
7. Legacy hello capabilities for chunk attach (`terminalAttachChunkV1`) are removed in v2; no downgrade negotiation.
8. `sinceSeq = 0` and `sinceSeq = undefined` both mean "no output rendered yet; replay from first available sequence."

---

## Attach Replay Atomicity (Normative)

Broker attach for one terminal is executed under a per-terminal critical section:

1. Register client as an attaching consumer (starts buffering live frames in an attach-staging queue).
2. Snapshot replay window from replay ring using `sinceSeq`.
3. Send `terminal.attach.ready` with replay bounds.
4. Send replay frames in-order.
5. Flush attach-staging queue frames with `seq > replayToSeq` in-order.
6. Promote client from attaching to live stream consumer.

This guarantees no output loss/reorder across the attach boundary, replacing current `pendingSnapshotClients` behavior.

---

### Task 1: Define Terminal Stream V2 Protocol Contract (Breaking)

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-handler.ts`
- Modify: `src/lib/ws-client.ts`
- Test: `test/server/ws-edge-cases.test.ts`
- Test: `test/unit/client/lib/ws-client.test.ts`

**Step 1: Write failing protocol/version tests**

Add tests that require:
- `hello.protocolVersion === 2`
- server closes with `PROTOCOL_MISMATCH` when version missing/mismatched (including old clients with no version field)
- client treats mismatch as fatal upgrade-required state (no reconnect loop)
- legacy `capabilities.terminalAttachChunkV1` is removed from hello payload construction
- `terminal.created` no longer contains snapshot payload fields in v2

```ts
expect(close.code).toBe(4010)
expect(error.code).toBe('PROTOCOL_MISMATCH')
```

**Step 2: Run tests to verify failure**

Run:

```bash
npm test -- test/server/ws-edge-cases.test.ts -t "PROTOCOL_MISMATCH|protocol version"
npm test -- test/unit/client/lib/ws-client.test.ts -t "protocol version"
```

Expected: FAIL (schemas and close handling not implemented).

**Step 3: Implement V2 protocol primitives**

In `shared/ws-protocol.ts`:

```ts
export const WS_PROTOCOL_VERSION = 2

export const ErrorCode = z.enum([
  ...,
  'PROTOCOL_MISMATCH',
])

export const HelloSchema = z.object({
  type: z.literal('hello'),
  token: z.string().optional(),
  protocolVersion: z.literal(WS_PROTOCOL_VERSION),
  // no v1 chunk capability negotiation in protocol v2
  capabilities: z.object({
    sessionsPatchV1: z.boolean().optional(),
  }).optional(),
  ...
})

export const TerminalAttachSchema = z.object({
  type: z.literal('terminal.attach'),
  terminalId: z.string().min(1),
  // 0 or undefined => replay from first available sequence
  sinceSeq: z.number().int().nonnegative().optional(),
})
```

Add/replace server message types with V2 stream messages:

```ts
type TerminalCreatedMessage = {
  type: 'terminal.created'
  requestId: string
  terminalId: string
  createdAt: number
  effectiveResumeSessionId?: string
  // no snapshot payload in protocol v2
}

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
  // inclusive sequence range
  seqStart: number
  seqEnd: number
  data: string
}

type TerminalOutputGapMessage = {
  type: 'terminal.output.gap'
  terminalId: string
  // inclusive dropped range
  fromSeq: number
  toSeq: number
  reason: 'queue_overflow' | 'replay_window_exceeded'
}
```

Also update `ServerMessage` union in `shared/ws-protocol.ts` to:
- replace old `TerminalOutputMessage` shape with sequenced v2 shape
- include `TerminalAttachReadyMessage` and `TerminalOutputGapMessage`
- update `TerminalCreatedMessage` to the snapshot-free v2 shape

In `server/ws-handler.ts`, add `CLOSE_CODES.PROTOCOL_MISMATCH = 4010`.

In `server/ws-handler.ts`, reject mismatched `protocolVersion` with close code `4010` and typed error.

In `src/lib/ws-client.ts`, include `protocolVersion: WS_PROTOCOL_VERSION` in hello, remove chunk-attach capability, and handle `4010` as fatal (set explicit upgrade-required error, no reconnect timer).

**Step 4: Run tests to verify pass**

Run:

```bash
npm test -- test/server/ws-edge-cases.test.ts -t "PROTOCOL_MISMATCH|protocol version"
npm test -- test/unit/client/lib/ws-client.test.ts -t "protocol version"
```

Expected: PASS.

**Step 5: Commit**

```bash
git add shared/ws-protocol.ts server/ws-handler.ts src/lib/ws-client.ts test/server/ws-edge-cases.test.ts test/unit/client/lib/ws-client.test.ts
git commit -m "feat(protocol): enforce websocket protocol v2 with hard mismatch rejection and attach sinceSeq contract"
```

---

### Task 2: Implement Deterministic Client Upgrade + Storage/Cookie Safety

**Files:**
- Modify: `src/main.tsx`
- Modify: `src/lib/auth.ts`
- Modify: `src/store/storage-migration.ts`
- Modify: `src/store/store.ts`
- Create: `test/unit/client/store/storage-migration.test.ts`
- Modify: `test/unit/client/lib/auth.test.ts`

**Step 1: Write failing upgrade tests**

Cover:
- bumping existing `STORAGE_VERSION` clears legacy `freshell.*.v1` while preserving `freshell.auth-token`
- migration clears stale `freshell-auth` cookie when no auth token remains
- bootstrap order is deterministic without dynamic imports: storage migration module executes before store module initialization
- second migration run is idempotent no-op

```ts
expect(localStorage.getItem('freshell.auth-token')).toBe('token-123')
expect(document.cookie).toContain('freshell-auth=token-123')
expect(localStorage.getItem('freshell.tabs.v1')).toBeNull()
```

**Step 2: Run tests to verify failure**

Run:

```bash
npm test -- test/unit/client/store/storage-migration.test.ts test/unit/client/lib/auth.test.ts
```

Expected: FAIL (migration/auth bootstrap behavior not updated).

**Step 3: Implement synchronous upgrade using existing migration system**

In `src/store/storage-migration.ts`:

```ts
const STORAGE_VERSION = 3
const AUTH_STORAGE_KEY = 'freshell.auth-token'

function clearFreshellKeysExcept(keep: string[]): void {
  const keepSet = new Set(keep)
  for (const key of Object.keys(localStorage)) {
    if ((key.startsWith('freshell.') || key === 'freshell_version') && !keepSet.has(key)) {
      localStorage.removeItem(key)
    }
  }
}

export function runStorageMigration(): void {
  const currentVersion = readStorageVersion()
  if (currentVersion >= STORAGE_VERSION) return

  const preservedAuthToken = localStorage.getItem(AUTH_STORAGE_KEY)
  clearFreshellKeysExcept([AUTH_STORAGE_KEY])
  if (preservedAuthToken) localStorage.setItem(AUTH_STORAGE_KEY, preservedAuthToken)
  else clearAuthCookie()

  localStorage.setItem('freshell_version', String(STORAGE_VERSION))
}

// Execute on import so migration runs before store initialization.
runStorageMigration()
```

In `src/main.tsx`, keep synchronous bootstrap and enforce import order:

```ts
import '@/store/storage-migration'
import { store } from '@/store/store'

initializeAuthToken()
```

In `src/store/store.ts`, remove side-effect import of `./storage-migration` (migration now owned by `main.tsx` import order). This preserves static module graph for Vite HMR and avoids async dynamic-import bootstrap complexity.

In `src/lib/auth.ts`, add and use `clearAuthCookie()` helper instead of duplicating token-source logic. Keep `initializeAuthToken()` as the single source of truth for URL/session/local token bootstrap.

**Step 4: Run tests to verify pass**

Run:

```bash
npm test -- test/unit/client/store/storage-migration.test.ts test/unit/client/lib/auth.test.ts
npm test -- test/unit/client/lib/ws-client.test.ts -t "protocol version"
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/main.tsx src/lib/auth.ts src/store/storage-migration.ts src/store/store.ts test/unit/client/store/storage-migration.test.ts test/unit/client/lib/auth.test.ts
git commit -m "feat(bootstrap): use existing storage migration v3 to clear legacy state while preserving auth token and cookie continuity"
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
- Modify: `src/store/sessionActivityPersistence.ts`
- Modify: `src/store/tabRegistrySlice.ts`
- Modify: `src/store/persistBroadcast.ts`
- Modify: `src/store/crossTabSync.ts`
- Test: `test/unit/client/store/persistedState.test.ts`
- Test: `test/unit/client/store/panesPersistence.test.ts`
- Test: `test/unit/client/store/tabsPersistence.test.ts`
- Create: `test/unit/client/store/persistBroadcast.test.ts`

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
npm test -- test/unit/client/store/persistedState.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/tabsPersistence.test.ts test/unit/client/store/persistBroadcast.test.ts
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

Explicitly refactor duplicated constants in `src/store/persistMiddleware.ts` to import from `src/store/storage-keys.ts` (do not leave local `.v1` literals).

Update broadcast channel constant to `freshell.persist.v2` in `src/store/persistBroadcast.ts`, and keep `src/store/crossTabSync.ts` consuming the shared `PERSIST_BROADCAST_CHANNEL_NAME` export (no separate channel constant).

Add migration note in comments/docs: storage key namespace suffix (`.v1`, `.v2`) is independent from `freshell_version` migration counter (`STORAGE_VERSION`).

In `src/store/panesSlice.ts`, remove or refactor legacy `.v1` recovery helpers (`applyLegacyResumeSessionIds`, `cleanOrphanedLayouts`) that become dead after Task 2's full storage reset on version bump.

**Step 4: Run tests to verify pass**

Run:

```bash
npm test -- test/unit/client/store/persistedState.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/tabsPersistence.test.ts test/unit/client/store/persistBroadcast.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/store/storage-keys.ts src/store/persistedState.ts src/store/persistMiddleware.ts src/store/panesSlice.ts src/store/tabsSlice.ts src/store/sessionActivitySlice.ts src/store/sessionActivityPersistence.ts src/store/tabRegistrySlice.ts src/store/persistBroadcast.ts src/store/crossTabSync.ts test/unit/client/store/persistedState.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/tabsPersistence.test.ts test/unit/client/store/persistBroadcast.test.ts
git commit -m "refactor(storage): move persisted client state to v2 keys and channel namespace for hard protocol cutover"
```

---

### Task 4: Refactor TerminalRegistry to Transport-Agnostic PTY Core

**Files:**
- Modify: `server/terminal-registry.ts`
- Create: `server/terminal-stream/registry-events.ts`
- Test: `test/unit/server/terminal-lifecycle.test.ts`
- Test: `test/server/ws-edge-cases.test.ts`

**Step 1: Write failing registry-surface extraction tests**

Add tests that assert:
- registry emits `terminal.output.raw` event for every PTY output chunk
- registry exposes attachment-count helpers needed by broker metadata (`getAttachedClientCount`)
- existing behavior is preserved during this step (no regression in current attach/snapshot flow)

```ts
expect(onOutput).toHaveBeenCalledWith(
  expect.objectContaining({ terminalId, data: 'hello', at: expect.any(Number) })
)
```

**Step 2: Run tests to verify failure**

Run:

```bash
npm test -- test/unit/server/terminal-lifecycle.test.ts -t "transport agnostic"
```

Expected: FAIL.

**Step 3: Implement staged decoupling seam (no behavior removal yet)**

Create broker-facing event types in `server/terminal-stream/registry-events.ts` and emit them from `TerminalRegistry`:

```ts
this.emit('terminal.output.raw', {
  terminalId,
  data,
  at: Date.now(),
})
```

Add explicit APIs for broker handoff:

```ts
getAttachedClientCount(terminalId: string): number
listAttachedClientIds(terminalId: string): string[]
```

Document exact concern migration destination in code comments and plan notes:

1. `pendingSnapshotClients` ordering logic -> broker attach-staging queue (Task 7, atomic attach flow).
2. `outputBuffers`/flush timers/mobile batching -> broker client-output queue (Tasks 6-7).
3. `safeSendOutputFrames` splitting + `safeSend` backpressure guards -> broker send scheduler and catastrophic breaker (Task 7).

Do not delete legacy transport code in this task; this task establishes a safe extraction seam so Task 7 can cut over without large blind rewrites.

**Step 4: Run tests to verify pass**

Run:

```bash
npm test -- test/unit/server/terminal-lifecycle.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/terminal-registry.ts server/terminal-stream/registry-events.ts test/unit/server/terminal-lifecycle.test.ts test/server/ws-edge-cases.test.ts
git commit -m "refactor(server): add terminal registry event seam and explicit concern-migration path for broker cutover"
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
- default memory budget (`256 KiB`) enforcement

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

Use UTF-8 byte sizing (`Buffer.byteLength`) for memory budget enforcement. Define `DEFAULT_TERMINAL_REPLAY_RING_MAX_BYTES = 256 * 1024` and apply env override `TERMINAL_REPLAY_RING_MAX_BYTES` when set.

Handle `sinceSeq` normalization explicitly (avoid truthy/falsy mistakes):

```ts
const normalizedSinceSeq = sinceSeq === undefined || sinceSeq === 0 ? 0 : sinceSeq
```

Document rationale: enough reconnect delta room while keeping per-terminal memory bounded.

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
- default `TERMINAL_CLIENT_QUEUE_MAX_BYTES = 128 * 1024` per attached client

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
- Create: `server/terminal-stream/constants.ts`
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
- attach boundary ordering: output produced during attach replay is delivered after replay (no loss/reorder)
- catastrophic breaker: `4008` only when `bufferedAmount` exceeds hard threshold for sustained stall window
- `terminal.create` path auto-attaches creator via broker without snapshot payload fields

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
- handle `terminal.create` auto-attach (`sinceSeq=0`) for creator websocket
- emit `terminal.attach.ready`, `terminal.output`, `terminal.output.gap`
- maintain per-terminal attachment counts for list metadata
- enforce per-terminal attach critical section and attach-staging queue flush (replaces `pendingSnapshotClients`)
- run catastrophic breaker guard:
  - do not close for ordinary queue overflow
  - close with `4008` only when `ws.bufferedAmount > TERMINAL_WS_CATASTROPHIC_BUFFERED_BYTES` continuously for `TERMINAL_WS_CATASTROPHIC_STALL_MS`

In `server/ws-handler.ts`, remove attach call sites/wiring for legacy snapshot flow (including `terminal.attach` branches, `attachSendChains` usage, and calls into `sendAttachSnapshotAndFinalize`) and delegate both:
- explicit reattach (`terminal.attach`) to broker replay APIs
- create-time attach (after `terminal.create`) to broker auto-attach APIs
Leave only dead helper definitions/constants/types cleanup for Task 10.

**Step 4: Run tests to verify pass**

Run:

```bash
npm test -- test/unit/server/ws-handler-backpressure.test.ts test/server/ws-edge-cases.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/terminal-stream/broker.ts server/terminal-stream/types.ts server/terminal-stream/constants.ts server/ws-handler.ts server/index.ts test/unit/server/ws-handler-backpressure.test.ts test/server/ws-edge-cases.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts
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
- preserve existing RAF-based `term.write` batching (no synchronous write in WS handler)
- `terminal.created` handling does not expect/consume snapshot payload in v2

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
- keep existing `enqueueTerminalWrite` + RAF queue behavior to avoid WS message-loop blocking
- assume broker emits strictly increasing, non-overlapping sequence ranges
- on `terminal.created`: set terminal state only (no snapshot parsing), rely on broker auto-attach stream

```ts
if (msg.type === 'terminal.output' && msg.terminalId === tid) {
  if (import.meta.env.DEV && msg.seqStart <= lastSeqRef.current) {
    console.warn('Unexpected overlapping sequence range', msg.seqStart, msg.seqEnd, lastSeqRef.current)
  }
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
- Test: `test/unit/client/lib/ws-client.test.ts`
- Update: `docs/index.html`

**Step 1: Write failing UX tests**

Require:
- non-fatal reconnect/reattach states do not render full-screen blocking overlay
- terminal remains focusable during attach replay/degraded streaming
- when websocket is disconnected, input events are queued via `wsClient.send` (not dropped), and UI shows non-blocking offline status
- only severe/fatal states use blocking overlay

```ts
expect(screen.queryByText('Reconnecting...')).not.toBeInTheDocument()
expect(wsSendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal.input' }))
```

**Step 2: Run tests to verify failure**

Run:

```bash
npm test -- test/unit/client/components/TerminalView.lifecycle.test.tsx -t "non-blocking reconnect"
npm test -- test/unit/client/lib/ws-client.test.ts -t "queues input while disconnected"
```

Expected: TerminalView reconnect UX assertions FAIL. WsClient queueing test may already PASS (existing behavior), and should be kept as a guardrail.

**Step 3: Implement non-blocking status treatment**

Change spinner overlay logic:

```ts
const showBlockingSpinner = terminalContent.status === 'creating' && connectionErrorCode !== 4003
```

Separate state presentation:
- `connection.status !== 'ready'`: inline offline/retrying status (non-blocking), no claim of immediate delivery.
- `connection.status === 'ready'` + attach replay in progress: inline "recovering output" status (non-blocking).
- keep `ConnectionErrorOverlay` only for fatal limits (`4003`, protocol mismatch fatal, auth fatal).

In `test/unit/client/lib/ws-client.test.ts`, add/keep regression coverage for existing queue semantics (`_state !== 'ready'` queues bounded pending messages with `maxQueueSize = 1000`). Do not change ws-client runtime behavior unless tests show a real gap.

Update `docs/index.html` mock to reflect inline degraded status treatment.

**Step 4: Run tests to verify pass**

Run:

```bash
npm test -- test/unit/client/components/TerminalView.lifecycle.test.tsx
npm test -- test/unit/client/lib/ws-client.test.ts -t "queues input while disconnected"
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/TerminalView.tsx src/store/connectionSlice.ts src/components/terminal/ConnectionErrorOverlay.tsx docs/index.html test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/lib/ws-client.test.ts
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
- remaining `terminal.attached*` supporting code after Task 7 cutover (legacy message types/schemas/constants/helpers)
- remove deprecated `terminal.snapshot` type/message definitions in `shared/ws-protocol.ts`
- remove dead helpers: `sendAttachSnapshotAndFinalize`, `enqueueAttachSnapshotSend`, local `chunkTerminalSnapshot` path in `server/ws-handler.ts`
- attach chunk constants and timeouts
- remove terminal snapshot chunking export from `server/ws-chunking.ts`; retain non-terminal sessions chunking only if still used
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
- Modify (if required by failing assertions): `server/terminal-stream/broker.ts`
- Modify (if required by failing assertions): `src/lib/ws-client.ts`
- Modify (if required by failing assertions): `src/components/TerminalView.tsx`

**Step 1: Write failing resilience tests**

Add scenarios:
- simulated high `bufferedAmount` does not cause routine disconnect for terminal stream
- simulated sustained catastrophic `bufferedAmount` does close with `4008`
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

**Step 3: Implement explicit fixes for any failing resilience case**

Fix only the concrete failed assertions:

1. Replay delta failure -> correct inclusive sequence comparisons (`sinceSeq`, `seqStart`, `seqEnd`) in broker/client.
2. Attach-boundary race failure -> ensure attach-staging queue flush runs after replay completion under same terminal lock.
3. Catastrophic breaker failure -> enforce "sustained threshold exceedance" logic (`bytes + stall duration`) before close.
4. Client reconnect-loop failure -> keep ordinary queue pressure as non-fatal and retain queued input sends.

**Step 4: Run tests to verify pass**

Run:

```bash
npm test -- test/unit/server/ws-handler-backpressure.test.ts test/server/ws-terminal-stream-v2-replay.test.ts test/e2e/terminal-flaky-network-responsiveness.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/server/ws-terminal-stream-v2-replay.test.ts test/e2e/terminal-flaky-network-responsiveness.test.tsx test/unit/server/ws-handler-backpressure.test.ts test/unit/client/lib/ws-client.test.ts server/terminal-stream/broker.ts src/lib/ws-client.ts src/components/TerminalView.tsx
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
- `terminal_stream_catastrophic_close`

Document operational guidance and env knobs in `README.md`:
- `TERMINAL_REPLAY_RING_MAX_BYTES` (default `262144`)
- `TERMINAL_CLIENT_QUEUE_MAX_BYTES` (default `131072`)
- `TERMINAL_WS_CATASTROPHIC_BUFFERED_BYTES` (default `16777216`)
- `TERMINAL_WS_CATASTROPHIC_STALL_MS` (default `10000`)

Include memory budgeting formula and examples:
- per-terminal baseline: `TERMINAL_REPLAY_RING_MAX_BYTES`
- per attached client overhead: `TERMINAL_CLIENT_QUEUE_MAX_BYTES`
- approximate per-terminal total: `ring + (attachedClients * queue)`

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
3. Confirm catastrophic close only occurs after sustained hard-threshold exceedance (bytes + duration).
4. Confirm no runtime path reads/writes `pendingSnapshotClients`.
5. Confirm `freshell.*.v1` keys are never read or written by current code.
6. Confirm auth token survives upgrade and cookie is re-synced.
7. Confirm `docs/index.html` reflects non-blocking reconnect UX.

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
