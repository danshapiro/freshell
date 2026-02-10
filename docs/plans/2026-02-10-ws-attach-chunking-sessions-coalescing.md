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
- These inline sends can exceed safe buffered thresholds and trigger backpressure closes.

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
- Do not yield between snapshot chunks.
- Keep the existing `setImmediate(() => finishAttachSnapshot(...))` timing model.
- Schedule `finishAttachSnapshot` exactly once, only after the final inline or chunked snapshot frame is queued.

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
- With `MAX_CHUNK_BYTES` (from env `MAX_WS_CHUNK_BYTES`) defaulting to ~500KB and snapshot upper bound 2MB, attach chunking is typically <= 4 chunks.
- The helper should avoid wasteful repeated full-envelope serialization in hot loops; precompute constant envelope costs where possible.
- Acceptance target: chunking a 2MB snapshot should stay within practical single-digit to low-double-digit milliseconds on dev hardware; treat >100ms as a regression to optimize.

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

For `terminal.create`, keep `terminal.created` but allow chunk follow-up:

```ts
{ type: 'terminal.created', requestId, terminalId, createdAt, effectiveResumeSessionId, snapshotChunked: true }
```

The existing `terminal.created` `snapshot` field remains unchanged for inline/small snapshots.

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
- honors long terminal IDs (simulate nanoid-length IDs).
- throws clear error when `maxBytes` is too small for minimal chunk envelope.
- preserves empty snapshot behavior (`[]`) so caller can choose inline path.
- runs within practical performance bounds for a 2MB snapshot payload.

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

  const envelopeBytes = Buffer.byteLength(JSON.stringify({
    type: 'terminal.attached.chunk',
    terminalId,
    chunk: '',
  }))

  if (envelopeBytes + 1 > maxBytes) {
    throw new Error('MAX_WS_CHUNK_BYTES too small for terminal.attached.chunk envelope')
  }

  const chunks: string[] = []
  let cursor = 0

  while (cursor < snapshot.length) {
    let lo = cursor + 1
    let hi = snapshot.length
    let best = cursor

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2)
      const candidate = snapshot.slice(cursor, mid)
      const bytes = Buffer.byteLength(JSON.stringify({
        type: 'terminal.attached.chunk',
        terminalId,
        chunk: candidate,
      }))
      if (bytes <= maxBytes) {
        best = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }

    if (best === cursor) throw new Error('Unable to chunk snapshot safely within max byte budget')

    chunks.push(snapshot.slice(cursor, best))
    cursor = best
  }

  return chunks
}
```

### Step 4. Run test (green)

`npm test -- test/unit/server/ws-chunking.test.ts`

### Step 5. Commit

```bash
git add test/unit/server/ws-chunking.test.ts server/ws-handler.ts
git commit -m "test(ws): add byte-accurate terminal snapshot chunking helper coverage"
```

---

## Task 2: Implement Chunked Attach Sending and Wire All Snapshot Codepaths

**Files:**
- Modify `server/ws-handler.ts`

### Step 1. Add failing integration tests first (red)

In `test/server/ws-edge-cases.test.ts`, add tests asserting:
1. Large `terminal.attach` sends `start -> chunk+ -> end` in order.
2. `terminal.output` queued during attach is emitted only after `terminal.attached.end`.
3. Large `terminal.create` snapshot paths also use chunk flow (at minimum one create path; ideally cover reused + new).
4. If connection closes mid-chunk stream, snapshot stream aborts and no attach-finalization flush occurs for that connection.

Note: this file uses `FakeRegistry.simulateOutput(...)` intentionally (test helper, not production `TerminalRegistry`).

Run: `npm test -- test/server/ws-edge-cases.test.ts -t "chunked attach"`

### Step 2. Implement server wiring

In `server/ws-handler.ts`:
- Extend `ClientState` with `supportsTerminalAttachChunkV1`.
- Parse new hello capability.
- Keep existing `send(ws, msg)` signature unchanged.
- Add `queueAttachFrame(ws, msg): boolean` helper for attach snapshot flow only:
  - returns `false` if socket is not open before send.
  - calls existing `send(ws, msg)`.
  - returns `ws.readyState === WebSocket.OPEN` after send (captures backpressure-close path).
- Add a private class method (inside `WsHandler`) that sends snapshot inline or chunked and finalizes attach only after a complete snapshot send:

```ts
private sendAttachSnapshotAndFinalize(
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

Method behavior:
- Inline path (small snapshot OR client not chunk-capable):
  - If `created` present, send `terminal.created` with `snapshot`.
  - Else send `terminal.attached` with `snapshot`.
  - If `queueAttachFrame` returns `true`, schedule `setImmediate(() => this.registry.finishAttachSnapshot(terminalId, ws))`.
- Chunk path (oversized + capable):
  - If `created`, send `terminal.created` with `snapshotChunked: true` and no snapshot body.
  - Chunk with `chunkTerminalSnapshot(snapshot, MAX_CHUNK_BYTES, terminalId)`.
  - If chunk helper returns `[]`, send inline snapshot path instead (no empty chunk stream).
  - Send `terminal.attached.start`, each `terminal.attached.chunk`, then `terminal.attached.end` with `totalCodeUnits`, checking `queueAttachFrame(...)` before continuing.
  - Schedule `setImmediate(() => finishAttachSnapshot(...))` only if all chunk frames were accepted.
  - If any frame enqueue returns `false`, abort remaining chunks and do not finish attach for that connection (connection is expected to close or already be closed).

### Step 3. Replace all four snapshot callsites

Replace direct snapshot sends + `setImmediate(finishAttachSnapshot)` in:
1. `terminal.create` reused-by-request path.
2. `terminal.create` reused-by-session path.
3. `terminal.create` new terminal path.
4. `terminal.attach` path.

All must call `sendAttachSnapshotAndFinalize(...)`.

### Step 4. Run tests (green)

```bash
npm test -- test/server/ws-edge-cases.test.ts -t "chunked attach"
npm test -- test/server/ws-edge-cases.test.ts -t "snapshot before any terminal.output"
```

### Step 5. Commit

```bash
git add server/ws-handler.ts test/server/ws-edge-cases.test.ts
git commit -m "feat(ws): chunk oversized attach snapshots and finalize attach without race"
```

---

## Task 3: Add Client Reassembly for Chunked Attach

**Files:**
- Modify `src/components/TerminalView.tsx`
- Modify `test/unit/client/components/TerminalView.lifecycle.test.tsx`

### Step 1. Write failing tests (red)

Add lifecycle tests for chunk flow:
- `terminal.attached.start` initializes buffer.
- `terminal.attached.chunk` accumulates.
- assert `term.write` is **not** called during chunk accumulation.
- `terminal.attached.end` clears terminal, writes reassembled snapshot once, sets status running, and sets attaching false.
- `terminal.created` with `snapshotChunked: true` does not prematurely clear attaching state.
- `totalCodeUnits` mismatch on `terminal.attached.end` drops snapshot (no partial render).
- incomplete stream cleanup:
  - on websocket reconnect/disconnect, buffered chunks for that terminal are dropped.
  - on timeout (no `terminal.attached.end` within `ATTACH_CHUNK_TIMEOUT_MS = 10_000`), buffered chunks are dropped and attach spinner is cleared.
  - on repeated `terminal.attached.start` for same terminal, previous in-flight chunks are replaced.

### Step 2. Implement client behavior

In `TerminalView.tsx`:
- Add `useRef<Map<string, string[]>>` for in-flight attach chunks.
- Add `useRef<Map<string, number>>` (or equivalent) for per-terminal chunk timeout timers.
- Add `const ATTACH_CHUNK_TIMEOUT_MS = 10_000`.
- Handle:
  - `terminal.attached.start`
  - `terminal.attached.chunk`
  - `terminal.attached.end`
- Preserve existing `terminal.attached` inline path.
- For `terminal.created`:
  - existing inline snapshot behavior unchanged.
  - if `snapshotChunked: true`, keep attaching state until `terminal.attached.end`.
- On reconnect/unmount/detach/terminal change, clear in-flight chunk buffers and timers.
- On chunk timeout, drop buffered chunks, clear timer, and set `isAttaching` false (do not render partial snapshot).
- On `terminal.attached.end`, validate `reassembled.length === totalCodeUnits`; if mismatch, discard snapshot and log warning/debug event.

Suggested local types:

```ts
type TerminalAttachChunkMsg =
  | { type: 'terminal.attached.start'; terminalId: string; totalCodeUnits: number; totalChunks: number }
  | { type: 'terminal.attached.chunk'; terminalId: string; chunk: string }
  | { type: 'terminal.attached.end'; terminalId: string; totalCodeUnits: number; totalChunks: number }
```

### Step 3. Run tests (green)

`npm test -- test/unit/client/components/TerminalView.lifecycle.test.tsx -t "chunked attach"`

### Step 4. Commit

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
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

Diff timing contract:
- `pendingTrailing` stores raw `ProjectGroup[]`.
- `diffProjects` is computed only in `flush(next)` against current `this.last` to avoid stale diff payloads.
- `this.last` / `hasLast` are updated only in `flush(next)` after diff computation; `publish(...)` never mutates them.

Add:
- `shutdown()` to clear timer and pending state.

### Step 3. Wire shutdown

In `server/index.ts` shutdown flow, call `sessionsSync.shutdown()` before exiting.

### Step 4. Run tests (green)

```bash
npm test -- test/unit/server/sessions-sync/service.test.ts
```

### Step 5. Commit

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

### Step 3. Commit

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
