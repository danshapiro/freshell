# WS Attach Snapshot Chunking + Sessions Publish Coalescing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Remove attach-time websocket backpressure spikes and reduce session update storms without removing any existing behavior.

**Architecture:** Keep terminal/session semantics unchanged; change transport behavior under load.
- Oversized terminal attach snapshots become chunked streams.
- Small snapshots keep existing inline messages.
- Sessions sync keeps `sessions.patch` semantics but coalesces burst updates.

**Tech Stack:** Node.js, TypeScript, Express, ws, React 18, xterm.js, Vitest.

---

## Detailed Justification

1. **Attach snapshots are currently sent as one large frame.**
- `WsHandler` sends full snapshots inline in four places:
  - `terminal.create` reused-by-request path
  - `terminal.create` reused-by-session path
  - `terminal.create` new terminal path
  - `terminal.attach` path
- The highest oversized-snapshot risk is in reused/reattach paths (existing buffered scrollback).
- The new-terminal create path is usually small, but remains part of the unified send path for consistency and future-proofing.
- Any oversized inline send can exceed safe buffered thresholds and trigger backpressure closes.

2. **Bursty index updates publish too often.**
- `codingCliIndexer.onUpdate` calls `sessionsSync.publish(projects)` for every update callback.
- Under churn, this produces many large `sessions.patch` messages close together.

3. **The issue is send shape and scheduling, not missing features.**
- We should not drop scrollback or remove patch behavior.
- We can preserve functionality and improve stability by chunking attach payloads and coalescing publish bursts.

4. **This is idiomatic for the current architecture.**
- Existing websocket code already has chunking behavior (`sendChunkedSessions`), so extending that pattern is low risk.
- Existing attach queueing in `TerminalRegistry` already enforces snapshot-before-live-output ordering; we just need to preserve that invariant during chunked send.

---

## Expected Results

1. No oversized single-frame terminal snapshot sends for chunk-capable clients.
2. Reduced probability of `4008` backpressure closes during terminal attach.
3. Lower `sessions.patch` burst volume during indexer churn.
4. No regression in snapshot-first attach semantics.
5. No reduction in terminal/session feature set.

---

## Design Decisions

1. **Chunk protocol gated by capability.**
- Add `hello.capabilities.terminalAttachChunkV1`.
- New clients advertise support; server uses chunked attach only when supported.
- Non-capable clients keep current inline behavior (compatibility fallback).

2. **Race-free attach completion.**
- Never call `finishAttachSnapshot` before the full snapshot sequence completes.
- Chunk frames are sent sequentially with explicit enqueue success/failure checks; only finalize attach after `end` is accepted.
- With async frame enqueue, call `finishAttachSnapshot` immediately after successful completion of the snapshot send sequence (no additional timer hop).

3. **Partial chunk streams must fail safely.**
- If socket backpressure/close happens during chunk send, abort the stream and do not call `finishAttachSnapshot`.
- Client must discard incomplete chunk buffers on reconnect, detach, or timeout so partial snapshots are never rendered.

4. **Byte-safe chunk sizing uses actual envelope fields.**
- Chunk helper must account for the real `terminalId` and message envelope when enforcing `maxBytes`.
- Include guard behavior when `maxBytes` is too small for even minimal chunk envelope.

5. **Coalescing policy: immediate-first, trailing-coalesced.**
- First `publish` in a window flushes immediately (keeps low latency for isolated updates).
- Additional publishes during the window collapse to latest state.
- At window end, latest pending state flushes once; if new pending exists, continue another window.

6. **Type safety for new server->client message shapes.**
- No server-side incoming Zod change is required for outbound-only messages.
- Add explicit TypeScript types/guards in client paths handling new attach chunk messages.

7. **Chunking algorithm cost is bounded for current limits.**
- With `MAX_CHUNK_BYTES` (from env `MAX_WS_CHUNK_BYTES`) defaulting to ~500KB and snapshot upper bound 2M UTF-16 code units, chunk counts vary by serialized byte size.
- ANSI/control-character-heavy content can expand significantly under JSON escaping, so chunk count can exceed 4 for the same character count.
- Exact byte safety requires candidate-string serialization in the probe loop; optimize by precomputing stable envelope fragments and limiting probe count.
- Reference algorithm is O(N log N) due binary-search probing, but practical runtime is dominated by repeated `JSON.stringify` in probes; keep probe count bounded and payload sizes capped.
- Acceptance target: <= 200ms for a 2MB serialized payload on baseline dev hardware; treat sustained regressions above that as optimization work.

8. **Chunk ordering relies on websocket/TCP in-order delivery for a single connection.**
- `terminal.attached.chunk` intentionally has no explicit sequence index.
- Client validates count + metadata consistency (`start` vs `end`) and discards on mismatch.

9. **Do not block the websocket message loop while chunking.**
- `onMessage` handlers enqueue attach snapshot work into per-terminal-per-connection promise chains and return immediately.
- `sendAttachSnapshotAndFinalize` runs only inside the chain, and errors are handled/logged inside the chain to avoid unhandled rejections.

10. **Client/server timeout coordination avoids routine overlap races.**
- Server attach frame timeout remains 30s default (`ATTACH_FRAME_SEND_TIMEOUT_MS`, from env `WS_ATTACH_FRAME_SEND_TIMEOUT_MS`).
- Client chunk completion timeout is set to 35s default (`ATTACH_CHUNK_TIMEOUT_MS`) and must satisfy:
  - `ATTACH_CHUNK_TIMEOUT_MS >= ATTACH_FRAME_SEND_TIMEOUT_MS + reconnectMinDelay`.
- No client-side cancel message is added in v1; timeout alignment prevents clients from routinely abandoning streams before server-side timeout handling completes.

11. **Keep protocol/state-machine logic out of rendering components.**
- Implement chunk reassembly, timeout handling, generation guards, and auto-reattach policy in a dedicated client hook (`useChunkedAttach`) or transport helper.
- `TerminalView` should remain a thin integration surface that consumes hook outputs and renders UI.

---

## Protocol Changes

### Hello capability extension

Add optional capability in `server/ws-handler.ts` hello schema:

```ts
capabilities: z.object({
  sessionsPatchV1: z.boolean().optional(),
  terminalAttachChunkV1: z.boolean().optional(),
}).optional(),
```

Add client advertisement in `src/lib/ws-client.ts` hello payload:

```ts
capabilities: {
  sessionsPatchV1: true,
  terminalAttachChunkV1: true,
}
```

### New server->client attach chunk messages

For chunk-capable clients and oversized snapshots:

```ts
{ type: 'terminal.attached.start', terminalId, totalCodeUnits, totalChunks }
{ type: 'terminal.attached.chunk', terminalId, chunk }
{ type: 'terminal.attached.end', terminalId, totalCodeUnits, totalChunks }
```

`totalCodeUnits` is explicitly `snapshot.length` (UTF-16 code units).
It is for reassembly validation only; transport chunk sizing is always byte-based (`Buffer.byteLength` over serialized envelope).
Ordering guarantee relies on websocket/TCP message order on a single connection.

For `terminal.create`, keep `terminal.created` but allow chunk follow-up:

```ts
{ type: 'terminal.created', requestId, terminalId, createdAt, effectiveResumeSessionId, snapshotChunked: true, snapshot?: string }
```

The existing `terminal.created` `snapshot` field remains unchanged for inline/small snapshots.
When `snapshotChunked: true`, omit `snapshot` entirely (do not send empty string placeholders).
If a non-capable client ever receives chunk message types due to server bug/regression, they remain safely ignorable as unknown message types.

---

## Task 1: Add Failing Unit Tests for Snapshot Chunking Helper

**Files:**
- Modify `test/unit/server/ws-chunking.test.ts`
- Target `server/ws-handler.ts`

### Step 1. Write failing tests

Add tests for `chunkTerminalSnapshot(snapshot, maxBytes, terminalId)`:
- returns single chunk for small snapshot.
- splits large snapshot into multiple chunks under byte limit using real envelope.
- handles unicode text and round-trips exactly.
- does not split surrogate pairs across chunk boundaries.
- handles minimal surrogate-pair boundary cases where step-back would otherwise regress to `cursor`.
- honors long terminal IDs (simulate nanoid-length IDs).
- throws clear error when `maxBytes` is too small for minimal chunk envelope.
- preserves empty snapshot behavior (`[]`) so caller can choose inline path.
- runs within practical performance bounds for a 2MB snapshot payload.
- enforces explicit perf threshold: <= 200ms for 2MB serialized payload at default chunk size.

Use exact envelope check in test:

```ts
const bytes = Buffer.byteLength(JSON.stringify({
  type: 'terminal.attached.chunk',
  terminalId: termId,
  chunk,
}))
expect(bytes).toBeLessThanOrEqual(maxBytes)
```

### Step 2. Run test (red)

`npm test -- test/unit/server/ws-chunking.test.ts`

### Step 3. Implement minimal helper

In `server/ws-handler.ts`:

```ts
export function chunkTerminalSnapshot(snapshot: string, maxBytes: number, terminalId: string): string[] {
  if (!snapshot) return []

  const prefix = `{"type":"terminal.attached.chunk","terminalId":${JSON.stringify(terminalId)},"chunk":`
  const suffix = '}'
  const payloadBytes = (chunk: string) =>
    Buffer.byteLength(prefix) + Buffer.byteLength(JSON.stringify(chunk)) + Buffer.byteLength(suffix)

  const chunks: string[] = []
  let cursor = 0

  while (cursor < snapshot.length) {
    let lo = cursor + 1
    let hi = snapshot.length
    let best = cursor

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2)
      const candidate = snapshot.slice(cursor, mid)
      const bytes = payloadBytes(candidate)
      if (bytes <= maxBytes) {
        best = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }

    if (best < snapshot.length && best > cursor) {
      // If boundary lands between high+low surrogate, step back one code unit.
      const prev = snapshot.charCodeAt(best - 1)
      const next = snapshot.charCodeAt(best)
      const prevIsHigh = prev >= 0xd800 && prev <= 0xdbff
      const nextIsLow = next >= 0xdc00 && next <= 0xdfff
      if (prevIsHigh && nextIsLow) {
        best -= 1
      }
    }

    if (best === cursor) {
      // Final safety: always advance by one full code point or fail.
      // This intentionally handles cases where surrogate step-back regressed to cursor.
      const cp = snapshot.codePointAt(cursor)
      const next = cursor + (cp !== undefined && cp > 0xffff ? 2 : 1)
      const candidate = snapshot.slice(cursor, next)
      if (payloadBytes(candidate) > maxBytes) {
        throw new Error('Unable to advance chunk cursor safely within max byte budget')
      }
      best = next
    }

    chunks.push(snapshot.slice(cursor, best))
    cursor = best
  }

  return chunks
}
```

### Step 4. Run test (green)

`npm test -- test/unit/server/ws-chunking.test.ts`

### Step 5. Refactor (required)

- Refactor helper/test naming and small internals for clarity without changing byte-safety behavior.
- Keep surrogate-boundary guarantees and perf threshold assertions intact.
- Re-run Task 1 targeted tests after refactor.

### Step 6. Commit

```bash
git add test/unit/server/ws-chunking.test.ts server/ws-handler.ts
git commit -m "feat(ws): add byte-accurate terminal snapshot chunking helper and coverage"
```

---

## Task 2: Implement Chunked Attach Sending and Wire All Snapshot Codepaths

**Files:**
- Modify `server/ws-handler.ts`
- Modify `src/lib/ws-client.ts`

### Step 1. Add failing integration tests first (red)

In `test/server/ws-edge-cases.test.ts`, add tests asserting:
1. Large `terminal.attach` sends `start -> chunk+ -> end` in order.
2. `terminal.output` queued during attach is emitted only after `terminal.attached.end`.
3. Large `terminal.create` snapshot paths also use chunk flow (at minimum one create path; ideally cover reused + new).
4. If connection closes mid-chunk stream, snapshot stream aborts and no attach-finalization flush occurs for that connection.
5. Empty snapshots always use inline path and never advertise `snapshotChunked: true`.
6. Concurrent attach/create attempts for the same terminal+connection do not interleave chunk streams.
   - Use a controllable barrier in send/attach sequencing so a second attach starts while first is in-flight.
   - Recommended harness: wrap/mock the test websocket `send` callback to pause resolution for a targeted frame until the test releases a deferred promise.
   - Assert each attach stream still emits ordered, non-interleaved `start/chunk/end` triplets per request.

Note: this file uses `FakeRegistry.simulateOutput(...)` intentionally (test helper, not production `TerminalRegistry`).

Run: `npm test -- test/server/ws-edge-cases.test.ts -t "chunked attach"`

### Step 2. Implement server wiring

In `server/ws-handler.ts`:
- Extend `ClientState` with `supportsTerminalAttachChunkV1`.
- Parse new hello capability.
- Keep existing `send(ws, msg)` signature unchanged.
- Add attach chunk size floor for safety:
  - `ATTACH_CHUNK_BYTES = Number(process.env.MAX_WS_ATTACH_CHUNK_BYTES || process.env.MAX_WS_CHUNK_BYTES || 500 * 1024)`.
  - `MIN_ATTACH_CHUNK_BYTES = 16 * 1024`.
  - `effectiveAttachChunkBytes = Math.max(ATTACH_CHUNK_BYTES, MIN_ATTACH_CHUNK_BYTES)` in attach chunking path.
- Add `queueAttachFrame(ws, msg): Promise<boolean>` helper for attach snapshot flow only:
  - resolves `false` if socket is not open before send.
  - performs the same backpressure guard behavior as `send` (including `4008` close on overflow) before enqueue.
  - enqueues with `ws.send(payload, callback)` and resolves `false` on callback error.
  - resolves `false` on socket `close` event while frame is in-flight.
  - includes a bounded send timeout `ATTACH_FRAME_SEND_TIMEOUT_MS` (default 30s; env-overridable) so an in-flight send cannot hang indefinitely.
  - on timeout, resolves `false` and proactively closes the socket with `4008` (`Attach send timeout`) to avoid dangling in-flight state.
  - must be single-settlement: callback, close-handler, and timeout-handler all converge through one `settle(result)` guard so the promise can resolve exactly once.
  - must remove `close` listeners and clear timeout inside `settle(...)` before resolving to prevent leaks and double-resolution races.
  - this helper is dedicated to attach snapshot sequencing and should not change non-attach send semantics.
- Add per-terminal-per-connection attach send serialization (promise chaining) so async attach flows cannot interleave.
  - Store chains in `attachSendChains: Map<string, Promise<void>>` keyed by `${connectionId}:${terminalId}`.
  - Maintain secondary index `attachChainKeysByConnection: Map<string, Set<string>>` for efficient cleanup by connection.
  - On completion/failure, clear map entry in `finally` if it still points to the active promise.
  - On websocket close, clear all chain keys for that connection ID via the secondary index, then clear the index entry.
  - Cleanup operations are idempotent; missing keys are treated as no-op.
  - Rely on existing websocket close detach behavior to clear `pendingSnapshotClients` server-side for that connection.
- Add a private class method (inside `WsHandler`) that sends snapshot inline or chunked and finalizes attach only after a complete snapshot send:

```ts
private async sendAttachSnapshotAndFinalize(
  ws: LiveWebSocket,
  state: ClientState,
  args: {
    terminalId: string
    snapshot: string
    created?: {
      requestId: string
      createdAt: number
      effectiveResumeSessionId?: string
    }
  }
): Promise<void>
```

- Add a small wrapper that enqueues chain work and returns immediately from message handlers:

```ts
private enqueueAttachSnapshotSend(
  ws: LiveWebSocket,
  state: ClientState,
  args: {
    terminalId: string
    snapshot: string
    created?: {
      requestId: string
      createdAt: number
      effectiveResumeSessionId?: string
    }
  }
): void
```

`enqueueAttachSnapshotSend(...)` requirements:
- Compute chain key `${ws.connectionId}:${args.terminalId}`.
- Append `sendAttachSnapshotAndFinalize(...)` to the key's promise chain.
- Use identity-safe cleanup pattern, e.g.:

```ts
const key = `${ws.connectionId}:${args.terminalId}`
const previous = this.attachSendChains.get(key) ?? Promise.resolve()
const current = previous
  .catch(() => undefined)
  .then(() => this.sendAttachSnapshotAndFinalize(ws, state, args))
  .catch((error) => {
    this.logger.warn('attach_snapshot_send_failed', { key, terminalId: args.terminalId, error })
  })
  .finally(() => {
    if (this.attachSendChains.get(key) === current) {
      this.attachSendChains.delete(key)
    }
  })
this.attachSendChains.set(key, current)
```

- Catch/log inside the chain so the websocket message loop is never blocked and never gets unhandled rejection noise.
- Keep `onMessage` handlers non-blocking by calling this wrapper and returning immediately (do not `await` chain completion in handlers).
- In `onClose(...)`, perform `attachChainKeysByConnection` cleanup using `ws.connectionId`.

Implementation safety:
- Wrap chunking + send sequence in `try/catch`.
- On chunk helper/send-sequencing exception, log context, abort stream, and avoid `finishAttachSnapshot` for that connection.

Method behavior:
- Decide inline vs chunked **before** sending any frame.
- Inline path (small snapshot OR client not chunk-capable):
  - If `created` present, send `terminal.created` with `snapshot`.
  - Else send `terminal.attached` with `snapshot`.
  - If `await queueAttachFrame(...)` returns `true`, call `this.registry.finishAttachSnapshot(terminalId, ws)` immediately.
  - Rationale: frame enqueue has already completed, and websocket/TCP preserves send order for subsequent output frames.
- Chunk path (oversized + capable):
  - Compute chunks first via `chunkTerminalSnapshot(..., effectiveAttachChunkBytes, ...)`.
  - If chunks are empty or a single chunk, use inline path (do not send `snapshotChunked: true`).
  - If `created`, send `terminal.created` with `snapshotChunked: true` and omit `snapshot`.
  - Send `terminal.attached.start`, each `terminal.attached.chunk`, then `terminal.attached.end` with `totalCodeUnits`, awaiting `queueAttachFrame(...)` at each step.
  - Call `finishAttachSnapshot(...)` only if all chunk frames were accepted.
  - If any frame enqueue returns `false`, abort remaining chunks and do not finish attach for that connection.

In `src/lib/ws-client.ts`:
- add `terminalAttachChunkV1: true` to hello capabilities so chunk-capable clients actually negotiate this path.

### Step 3. Replace all four snapshot callsites

Replace direct snapshot sends + `setImmediate(finishAttachSnapshot)` in:
1. `terminal.create` reused-by-request path.
2. `terminal.create` reused-by-session path.
3. `terminal.create` new terminal path.
4. `terminal.attach` path.

All must call `enqueueAttachSnapshotSend(...)` (which internally serializes and invokes `sendAttachSnapshotAndFinalize(...)`).

### Step 4. Run tests (green)

```bash
npm test -- test/server/ws-edge-cases.test.ts -t "chunked attach"
npm test -- test/server/ws-edge-cases.test.ts -t "snapshot before any terminal.output"
```

### Step 5. Refactor (required)

- Refactor for readability/idiomatic server structure while keeping tests green:
  - extract small private helpers if `ws-handler.ts` grows too complex (e.g., chain-key helpers/cleanup).
  - keep send-order and attach-finalization invariants unchanged.
- Re-run Task 2 targeted tests after refactor.

### Step 6. Commit

```bash
git add server/ws-handler.ts src/lib/ws-client.ts test/server/ws-edge-cases.test.ts
git commit -m "feat(ws): chunk oversized attach snapshots and finalize attach without race"
```

---

## Task 3: Add Client Reassembly for Chunked Attach

**Files:**
- Modify `src/components/TerminalView.tsx`
- Add `src/components/terminal/useChunkedAttach.ts` (or equivalent colocated hook)
- Modify `test/unit/client/components/TerminalView.lifecycle.test.tsx`

### Step 1. Write failing tests (red)

Add lifecycle tests for chunk flow:
- `terminal.attached.start` initializes buffer.
- `terminal.attached.chunk` accumulates.
- assert `term.write` is **not** called during chunk accumulation.
- `terminal.attached.end` clears terminal, writes reassembled snapshot once, sets status running, and sets attaching false.
- `terminal.created` with `snapshotChunked: true` does not prematurely clear attaching state.
- `totalCodeUnits` mismatch on `terminal.attached.end` drops snapshot (no partial render).
- `totalChunks` mismatch between advertised and received chunk count drops snapshot (no partial render).
- `start` vs `end` metadata mismatch (`totalCodeUnits` or `totalChunks`) drops snapshot (no partial render).
- chunk messages with mismatched `terminalId` for an active chunk sequence are ignored and logged.
- `terminal.exit` for the same terminal during chunk accumulation cancels the sequence and clears timers/buffers.
- incomplete stream cleanup:
  - on websocket reconnect/disconnect, buffered chunks for that terminal are dropped.
  - on timeout (no `terminal.attached.end` within `ATTACH_CHUNK_TIMEOUT_MS = 35_000`), buffered chunks are dropped and attach spinner is cleared.
- on repeated `terminal.attached.start` for same terminal, previous in-flight chunks are replaced.
- reconnect/disconnect increments a local connection-generation token and clears all in-flight buffers for prior generation.
- timeout recovery keeps terminal usable for subsequent live output (no permanent error state).
- timeout recovery performs one guarded auto-reattach attempt (`terminal.attach` only, no detach) to restore snapshot context; if it fails, continue in degraded live-output-only mode with warning.
- auto-reattach guard scope: at most one automatic retry per `terminalId` per connection generation; if that retry also fails/times out, no further automatic retries until manual user action or generation changes.
- Explicit timeout coordination:
  - server in-flight frame timeout: 30s default (`ATTACH_FRAME_SEND_TIMEOUT_MS`, from env `WS_ATTACH_FRAME_SEND_TIMEOUT_MS`)
  - client chunk completion timeout: 35s default (`ATTACH_CHUNK_TIMEOUT_MS`)
  - ws reconnect min delay after backpressure close: 5s
  - invariant: `ATTACH_CHUNK_TIMEOUT_MS >= ATTACH_FRAME_SEND_TIMEOUT_MS + reconnectMinDelay`
  - client disconnect cleanup runs immediately and clears chunk buffers before timer fallback.

### Step 2. Implement client behavior

In `src/components/terminal/useChunkedAttach.ts` (new hook):
- Add `useRef<Map<string, string[]>>` for in-flight attach chunks.
- Add `useRef<Map<string, number>>` (or equivalent) for per-terminal chunk timeout timers.
- Add `useRef<number>` (connection generation token) incremented on reconnect/disconnect cleanup.
- Add `useRef<Set<string>>` for consumed auto-reattach guards keyed by `${terminalId}:${generation}`.
- Add `const ATTACH_CHUNK_TIMEOUT_MS = 35_000`.
- Handle:
  - `terminal.attached.start`
  - `terminal.attached.chunk`
  - `terminal.attached.end`
- Preserve existing `terminal.attached` inline path.
- For `terminal.created`:
  - existing inline snapshot behavior unchanged.
  - if `snapshotChunked: true`, keep attaching state until `terminal.attached.end`.
- Explicitly skip `setIsAttaching(false)` in the `terminal.created` handler when `snapshotChunked: true`.
- When `snapshotChunked: true`, set an explicit local snapshot state (`pending` -> `complete`/`degraded`) so UI behavior is deterministic.
- On reconnect/unmount/detach/terminal change, clear in-flight chunk buffers and timers.
- On reconnect/disconnect, clear chunk state immediately and bump generation token so stale chunks from prior connection are ignored.
- Reset auto-reattach guard set when generation changes.
- On chunk timeout, drop buffered chunks, clear timer, and set `isAttaching` false (do not render partial snapshot).
- On `terminal.attached.end`, validate `reassembled.length === totalCodeUnits`; if mismatch, discard snapshot and log warning/debug event.
- On `terminal.attached.end`, validate received chunk count matches `totalChunks`; if mismatch, discard snapshot and log warning/debug event.
- Validate `start` metadata and `end` metadata agree; on mismatch, discard snapshot and log warning/debug event.
- Process chunk frames only for the active `terminalId`; ignore unrelated message types and unrelated terminal chunk frames.
- If `terminal.exit` arrives for the active terminal before `end`, cancel chunk state and transition to exited behavior.
- Timeout path should not mark pane as errored; keep normal runtime/output handling active.
- Auto-reattach is attempted at most once per terminal per connection generation; failed retries transition directly to degraded snapshot state without further automatic retries.
- On any end-of-stream validation failure, clear `isAttaching` immediately and run the same one-shot guarded auto-reattach path.
- If reattach fails, keep pane status as running, mark snapshot state as degraded, and show a one-time warning banner/message.

In `src/components/TerminalView.tsx`:
- Replace inline chunk state machine branches with hook integration points:
  - pass websocket messages/terminal identity into the hook.
  - apply hook outputs from `useState`/hook callbacks (`snapshotText`, `snapshotState`, `shouldAutoReattach`, warnings) to existing render and terminal write flows.
- Keep rendering/UI responsibilities in `TerminalView`; keep protocol sequencing and retries in the hook.

Suggested local types:

```ts
type TerminalAttachChunkMsg =
  | { type: 'terminal.attached.start'; terminalId: string; totalCodeUnits: number; totalChunks: number }
  | { type: 'terminal.attached.chunk'; terminalId: string; chunk: string }
  | { type: 'terminal.attached.end'; terminalId: string; totalCodeUnits: number; totalChunks: number }
```

### Step 3. Run tests (green)

`npm test -- test/unit/client/components/TerminalView.lifecycle.test.tsx -t "chunked attach"`

### Step 4. Refactor (required)

- Refactor hook API and callsites for clarity and minimal coupling.
- Ensure `TerminalView` remains render-focused and does not reacquire protocol state-machine complexity.
- Re-run Task 3 targeted tests after refactor.

### Step 5. Commit

```bash
git add src/components/terminal/useChunkedAttach.ts src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "feat(client): reassemble chunked terminal attach snapshots safely"
```

---

## Task 4: Implement Session Publish Coalescing with Immediate-First Semantics

**Files:**
- Modify `server/sessions-sync/service.ts`
- Modify `test/unit/server/sessions-sync/service.test.ts`
- Modify `server/index.ts`

### Step 1. Write failing unit tests (red)

In `test/unit/server/sessions-sync/service.test.ts` using fake timers:
1. first publish flushes immediately when coalescing enabled.
2. multiple rapid publishes during active window emit one trailing publish using latest state.
3. if burst continues across windows, one publish per window with latest state.
4. `shutdown()` clears timer and pending state.
5. `coalesceMs=0` disables coalescing.
6. no-change trailing flush (`last -> next` diff empty, e.g. A->B->A) emits nothing, updates baseline state, and stops timer when no pending remains.

### Step 2. Implement service

In `server/sessions-sync/service.ts`:

```ts
type SessionsSyncWs = {
  broadcastSessionsPatch: (msg: { type: 'sessions.patch'; upsertProjects: ProjectGroup[]; removeProjectPaths: string[] }) => void
  broadcastSessionsUpdatedToLegacy: (projects: ProjectGroup[]) => void
  broadcastSessionsUpdated: (projects: ProjectGroup[]) => void
}

type SessionsSyncOptions = { coalesceMs?: number }
```

Constructor signature:

```ts
constructor(ws: SessionsSyncWs, options: SessionsSyncOptions = {})
```

Add fields:
- `private pendingTrailing: ProjectGroup[] | null = null`
- `private timer: NodeJS.Timeout | null = null`
- `private coalesceMs: number`

Constructor default:
- `coalesceMs` defaults to `Number(process.env.SESSIONS_SYNC_COALESCE_MS || 150)` and clamps invalid/negative values to `0`.

Publish logic:
- `coalesceMs <= 0`: flush immediately.
- no active timer: flush immediately, start window timer.
- active timer: overwrite `pendingTrailing` with latest.
- timer callback flushes pendingTrailing once (if present); if it flushed, start next window; if nothing pending, stop timer.
- In `flush(next)`, preserve existing patch-size fallback:
  - compute patch diff.
  - read `MAX_WS_CHUNK_BYTES` the same way current service does (per-flush, not constructor-cached), to preserve existing runtime/env behavior.
  - if patch payload exceeds `MAX_CHUNK_BYTES`, send full `sessions.updated` fallback (`broadcastSessionsUpdated(next)`) exactly as current behavior.
  - otherwise keep patch-first (`broadcastSessionsPatch`) + legacy snapshot (`broadcastSessionsUpdatedToLegacy`) behavior.

Diff timing contract:
- `pendingTrailing` stores raw `ProjectGroup[]`.
- `diffProjects` is computed only in `flush(next)` against current `this.last` to avoid stale diff payloads.
- `this.last` / `hasLast` are updated only in `flush(next)` after diff computation; `publish(...)` never mutates them.
- No-change edge case is explicit:
  - if `diffProjects(this.last, next)` is empty, broadcast nothing, clear consumed pending state, and treat the callback as "no flush emitted".
  - still update `this.last = next` and `hasLast = true` so future diffs compare against the latest canonical state.
  - timer continuation rule keys off "pending exists" (not "anything emitted"): if pending remains after callback, schedule next window; otherwise stop timer.

Add:
- `shutdown()` to clear timer and pending state.

### Step 3. Wire shutdown

In `server/index.ts` shutdown flow:
- ensure `sessionsSync` is instantiated in `main()` scope that the `shutdown` closure captures.
- constructor signature remains backward-compatible via default second parameter (`options = {}`); existing callsites compile unchanged unless custom options are needed.
- call `sessionsSync.shutdown()` as an explicit early shutdown step immediately after `server.close(...)` and before registry/CLI/ws shutdown actions, so no coalesced timer can fire during shutdown.

### Step 4. Run tests (green)

```bash
npm test -- test/unit/server/sessions-sync/service.test.ts
```

### Step 5. Refactor (required)

- Refactor timer/pending logic for readability (small private helpers for window start/stop and flush decision).
- Re-run Task 4 targeted tests after refactor.

### Step 6. Commit

```bash
git add server/sessions-sync/service.ts test/unit/server/sessions-sync/service.test.ts server/index.ts
git commit -m "feat(sync): coalesce burst publishes with immediate-first delivery and clean shutdown"
```

---

## Task 5: Add Integration Coverage for Sessions Coalescing

**Files:**
- Modify `test/server/ws-sessions-patch.test.ts`

### Step 1. Add failing test (red)

Add integration test using real `WsHandler` + `SessionsSyncService`:
- connect patch-capable client, receive initial snapshot.
- call `publish` rapidly with coalescing enabled.
- assert immediate first patch and one trailing patch for burst latest state.
- assert no extra patches after timer settles.

### Step 2. Run test (red -> green after implementation)

`npm test -- test/server/ws-sessions-patch.test.ts -t "coalesc"`

### Step 3. Refactor (required)

- Refactor only test structure/readability if needed; keep assertions and behavior unchanged.
- Re-run Task 5 targeted integration test after refactor.

### Step 4. Commit

```bash
git add test/server/ws-sessions-patch.test.ts
git commit -m "test(sync): verify sessions patch coalescing behavior end-to-end"
```

---

## Task 6: Full Regression Verification

### Step 1. Targeted tests

```bash
npm test -- test/unit/server/ws-chunking.test.ts
npm test -- test/server/ws-edge-cases.test.ts
npm test -- test/unit/client/components/TerminalView.lifecycle.test.tsx
npm test -- test/unit/server/sessions-sync/service.test.ts
npm test -- test/server/ws-sessions-patch.test.ts
```

### Step 2. Full suite

`npm test`

### Step 3. Perf validation (manual)

Compare before/after from server stdout/stderr perf logs (and `~/.freshell/logs/server-debug.jsonl` when debug logging to file is enabled):
- count of large `terminal.attached` sends
- count of `ws_backpressure_close`
- `sessions.patch` volume during burst windows

---

## Non-Goals

1. No `sessions.patch` schema redesign.
2. No reduction in scrollback size.
3. No user-visible feature removal.

---

## Rollout and Risk Notes

1. **Compatibility:** capability-gated chunk flow keeps old clients functional.
2. **Ordering risk:** resolved by eliminating asynchronous chunk-yield between snapshot chunks and finishing attach only after final snapshot frame.
3. **Latency risk for session updates:** immediate-first coalescing keeps isolated update latency unchanged while reducing burst churn.
4. **Observability:** keep debug/perf logging off by default; use only for targeted validation.
