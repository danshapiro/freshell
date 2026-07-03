# Stable Replay Retention Stream Implementation Plan

> **For agentic workers:** This plan was written for a session where the user explicitly requested "the usual", which authorizes the plan/load-bearing/Fresh Eyes/execution skills named in AGENTS.md. If that explicit request is not present, follow AGENTS.md and do not invoke skills. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ordinary terminal scrollback expiration keep the live terminal stream stable, while stale reconnects receive an explicit replay gap and continue with retained output.

**Architecture:** Replay retention remains a bounded moving window. When that window evicts old frames, the broker logs retention and lets reconnect replay report `terminal.output.gap`; it does not rotate stream identity or retag live/replay frames. True stream changes still use `terminal.stream.changed` for PTY replacement, Codex recovery, and incompatible server-retention recovery.

**Tech Stack:** TypeScript, Node.js/Express, WebSocket `ws`, Vitest, React terminal attach state tests.

## Global Constraints

- Work in `.worktrees/stable-replay-retention-stream` on branch `fix/stable-replay-retention-stream`.
- Server imports use NodeNext/ESM and relative imports must include `.js` extensions.
- Do not restart the self-hosted Freshell server.
- Do not modify `docs/index.html`; this is a backend/protocol stability fix, not a user-facing UI feature.
- Preserve the shared protocol schema value `terminal.stream.changed.reason === 'retention_lost'` for backward compatibility, but stop emitting it for ordinary replay eviction.
- Treat external consumers of `retention_lost` stream-change messages as a residual compatibility risk; local clients handle stream changes generically and the server will stop emitting this value for ordinary retention.
- Keep changes scoped to terminal stream retention behavior and direct tests.

---

## File Structure

- Modify `server/terminal-stream/broker.ts`
  - Stop calling `replaceStreamIdentity()` from replay retention loss.
  - Keep retention logging, attachment counts, tail/head sequence, retained bytes, max bytes, and suppression count.
  - Change retention logging's `reason` type away from `TerminalStreamReplacementReason`, because retention remains an observability event with `reason: 'retention_lost'` after it stops being a stream replacement reason.
  - Change the retention log message so it no longer says stream identity changed.
  - Remove retention-only queue/staging retagging in `replaceStreamIdentity()`.
- Modify `server/terminal-stream/stream-identity.ts`
  - Remove `retention_lost` from the server-local `TerminalStreamReplacementReason` union.
  - Keep `new_pty_session` only if TypeScript or a static audit shows an active server emitter still uses it; otherwise leave it only in the shared wire schema for compatibility.
- Modify `server/terminal-stream/replay-ring.ts`
  - Remove the retention-only `retagRetainedStreamSuffix()` wrapper if no other code uses it.
- Modify `server/terminal-stream/replay-deque.ts`
  - Remove the retention-only `retagRetainedStreamSuffix()` method if no other code uses it.
- Modify `server/terminal-stream/client-output-queue.ts`
  - Remove `retagPendingStream()` if no other code uses it after retention no longer rotates streams.
- Modify `test/unit/server/ws-handler-backpressure.test.ts`
  - Rewrite retention tests from "retention rotates stream" to "retention keeps stream stable and gaps only stale replay."
  - Add sustained retention churn regression coverage.
  - Add replay-cursor-under-retention coverage for the previously unproven paced replay edge.
- Modify `test/unit/server/terminal-stream/stream-identity.test.ts`
  - Stop expecting `retention_lost` to be a stream replacement reason.
- Modify `test/unit/server/terminal-stream/client-output-queue.test.ts`
  - Remove the retention-only retagging test if `retagPendingStream()` is deleted.
- Modify `test/server/ws-terminal-stream-v2-replay.test.ts`
  - Add an integration test proving stale reconnects receive a same-stream replay gap and retained tail without `terminal.stream.changed`.
- Modify `test/unit/client/lib/terminal-attach-seq-state.test.ts`
  - Add direct client sequence-state coverage for same-stream `replay_window_exceeded` gaps preserving forward progress and preventing unsafe checkpointing across the lost range.
- Optionally modify `test/unit/client/components/TerminalView.lifecycle.test.tsx`
  - Only add a UI lifecycle regression if the direct sequence-state test misses a behavior that the component layer changes.

### Task 1: Red Server Contract Tests

**Files:**
- Modify: `test/unit/server/ws-handler-backpressure.test.ts`

**Interfaces:**
- Consumes: Existing `FakeBrokerRegistry`, `createMockWs()`, `structuredLogs()`, `TerminalStreamBroker`.
- Produces: Failing tests that define stable-stream retention semantics.

- [ ] **Step 1: Rewrite the structured retention log test**

Change the test name at `test/unit/server/ws-handler-backpressure.test.ts:626` to:

```ts
it('logs replay retention without rotating stream identity', async () => {
```

Update the assertions so the retention log has the original stream ID and no `previousStreamId`:

```ts
expect(retentionLogs[0]).toEqual(expect.objectContaining({
  event: 'terminal.replay.retention',
  severity: 'warn',
  terminalId: 'term-structured-retention',
  attachRequestIds: ['structured-retention-attach'],
  attachmentCount: 1,
  streamId: ready.streamId,
  reason: 'retention_lost',
  retainedBytes: expect.any(Number),
  maxBytes: 6,
  tailSeq: expect.any(Number),
  headSeq: expect.any(Number),
}))
expect(retentionLogs[0]?.previousStreamId).toBeUndefined()
expect(retentionLogs[0]?.attachRequestId).toBeUndefined()
```

- [ ] **Step 2: Rewrite the one-raw-append coalescing test**

Rename the test at `test/unit/server/ws-handler-backpressure.test.ts:665` to:

```ts
it('keeps one raw append on the current stream when replay retention evicts older frames', async () => {
```

Replace the stream-change expectations with:

```ts
expect(streamChanges).toEqual([])
expect(liveOutputs.length).toBeGreaterThan(1)
expect(liveOutputs.every((payload) => payload.streamId === initialReady.streamId)).toBe(true)
```

Update replay assertions to use the initial stream:

```ts
expect(replayReady).toEqual(expect.objectContaining({
  terminalId,
  attachRequestId: 'retention-replay-attach',
  streamId: initialReady.streamId,
}))
expect(replayGaps).toEqual([
  expect.objectContaining({
    terminalId,
    attachRequestId: 'retention-replay-attach',
    streamId: initialReady.streamId,
    reason: 'replay_window_exceeded',
  }),
])
expect(replayOutputs.length).toBeGreaterThan(0)
expect(replayOutputs.every((payload) => payload.streamId === initialReady.streamId)).toBe(true)
```

Also remove the old tail assertion that every stream-bearing replay payload differs from
`initialReady.streamId`; that assertion enforced the previous buggy behavior and directly
contradicts the stable-stream contract.

- [ ] **Step 3: Rewrite active-live retention tests**

Rename and update the tests at `test/unit/server/ws-handler-backpressure.test.ts:1346`, `:1395`, `:1440`, and `:1482`:

```ts
it('keeps active clients on the same stream when replay retention evicts older frames', async () => {
```

```ts
it('keeps queued live output on the same stream across replay retention', async () => {
```

```ts
it('keeps fragmented live output on the same stream across replay retention', async () => {
```

```ts
it('replays retained frames on the same stream after replay retention eviction', async () => {
```

Replace retention stream-change expectations using the payload collection already present
in each test. Do not paste this snippet blindly into tests that use a different payload
variable name:

```ts
const streamChanges = payloads.filter((payload) => payload?.type === 'terminal.stream.changed')
expect(streamChanges).toEqual([])
```

For the replay-after-loss test, use `payloadsAfterLoss`:

```ts
const streamChangesAfterLoss = payloadsAfterLoss.filter((payload) => payload?.type === 'terminal.stream.changed')
expect(streamChangesAfterLoss).toEqual([])
```

For live output assertions, require the ready stream. Use the local output collection in
each test, such as `outputs`, `liveOutputs`, or the specific output value already under
assertion:

```ts
expect(outputs.every((payload) => payload.streamId === ready.streamId)).toBe(true)
```

For replay-after-loss assertions, require:

```ts
expect(readyAfterLoss?.streamId).toBe(initialStreamId)
expect(gapAfterLoss).toMatchObject({
  streamId: initialStreamId,
  fromSeq: 1,
  toSeq: 1,
  reason: 'replay_window_exceeded',
})
expect(replayOutputsAfterLoss.map((payload) => String(payload.data)).join('')).toBe('bbbccc')
expect(replayOutputsAfterLoss.every((payload) => payload.streamId === initialStreamId)).toBe(true)
```

- [ ] **Step 4: Add sustained churn regression**

Add a new test near the other retention tests:

```ts
it('does not emit stream-change churn during sustained replay retention evictions', async () => {
  const registry = new FakeBrokerRegistry()
  registry.setReplayRingMaxBytes(6)
  const broker = new TerminalStreamBroker(registry as any, vi.fn())
  const terminalId = 'term-retention-sustained'
  registry.createTerminal(terminalId)

  const ws = createMockWs()
  await broker.attach(ws as any, terminalId, 'viewport_hydrate', 80, 24, 0, 'retention-sustained-attach')
  const ready = ws.send.mock.calls
    .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
    .find((payload) => payload?.type === 'terminal.attach.ready')
  expect(ready?.streamId).toEqual(expect.any(String))
  ws.send.mockClear()

  for (let i = 0; i < 50; i += 1) {
    registry.emit('terminal.output.raw', { terminalId, data: `x${String(i).padStart(2, '0')}`, at: Date.now() })
  }
  vi.advanceTimersByTime(5)

  const payloads = ws.send.mock.calls
    .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
  expect(payloads.filter((payload) => payload?.type === 'terminal.stream.changed')).toEqual([])
  expect(payloads.filter((payload) => payload?.type === 'terminal.output')
    .every((payload) => payload.streamId === ready.streamId)).toBe(true)

  const retentionLogs = structuredLogs('warn', 'terminal.replay.retention')
    .filter((payload) => payload.terminalId === terminalId)
  expect(retentionLogs.length).toBeGreaterThan(0)
  expect(retentionLogs.every((payload) => payload.streamId === ready.streamId)).toBe(true)

  broker.close()
})
```

- [ ] **Step 5: Add replay-cursor retention regression**

Add a test near the replay/backpressure tests:

```ts
it('keeps a paced replay cursor on the same stream when retention moves before replay drains', async () => {
  const registry = new FakeBrokerRegistry()
  registry.setReplayRingMaxBytes(12)
  const broker = new TerminalStreamBroker(registry as any, vi.fn())
  const terminalId = 'term-retention-replay-cursor'
  registry.createTerminal(terminalId)

  for (const data of ['aaa', 'bbb', 'ccc', 'ddd']) {
    registry.emit('terminal.output.raw', { terminalId, data, at: Date.now() })
  }

  const ws = createMockWs({ bufferedAmount: 1024 * 1024 })
  await broker.attach(ws as any, terminalId, 'viewport_hydrate', 80, 24, 0, 'cursor-retention-attach')
  const payloadsAfterAttach = ws.send.mock.calls
    .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
  const ready = payloadsAfterAttach.find((payload) => payload?.type === 'terminal.attach.ready')
  expect(ready?.streamId).toEqual(expect.any(String))
  ws.send.mockClear()

  registry.emit('terminal.output.raw', { terminalId, data: 'eee', at: Date.now() })
  registry.emit('terminal.output.raw', { terminalId, data: 'fff', at: Date.now() })
  ws.bufferedAmount = 0
  vi.advanceTimersByTime(5)

  const payloads = ws.send.mock.calls
    .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
  expect(payloads.filter((payload) => payload?.type === 'terminal.stream.changed')).toEqual([])
  const replayGap = payloads.find((payload) => payload?.type === 'terminal.output.gap')
  expect(replayGap).toMatchObject({
    terminalId,
    streamId: ready.streamId,
    reason: 'replay_window_exceeded',
    attachRequestId: 'cursor-retention-attach',
  })
  const replayOutputs = payloads.filter((payload) => payload?.type === 'terminal.output')
  expect(replayOutputs.every((payload) => payload.streamId === ready.streamId)).toBe(true)

  broker.close()
})
```

If a 5ms timer does not flush the replay cursor, use the delay pattern already present in `ws-handler-backpressure.test.ts` for replay backpressure tests.

- [ ] **Step 6: Run server tests and verify they fail for the right reason**

Run:

```bash
npm run test:vitest -- run test/unit/server/ws-handler-backpressure.test.ts --config config/vitest/vitest.server.config.ts
```

Expected: FAIL because retention still emits `terminal.stream.changed` with `reason: 'retention_lost'`, changes stream IDs, and converts paced replay cursors through stream replacement.

### Task 2: Implement Stable Server Retention

**Files:**
- Modify: `server/terminal-stream/broker.ts`
- Modify: `server/terminal-stream/stream-identity.ts`
- Modify: `server/terminal-stream/replay-ring.ts`
- Modify: `server/terminal-stream/replay-deque.ts`
- Modify: `server/terminal-stream/client-output-queue.ts`
- Modify: `test/unit/server/terminal-stream/stream-identity.test.ts`
- Modify: `test/unit/server/terminal-stream/client-output-queue.test.ts`

**Interfaces:**
- Consumes: Red tests from Task 1.
- Produces: `handleReplayRetentionLoss(terminalId, state): void` that logs retention without replacing the stream.

- [ ] **Step 1: Remove retention from server-local stream replacement reasons**

In `server/terminal-stream/stream-identity.ts`, change the union to:

```ts
export type TerminalStreamReplacementReason =
  | 'codex_pty_recovery'
  | 'server_restart_incompatible_retention'
```

If a static audit or typecheck shows an active `new_pty_session` server emitter, keep that value in this union. Do not keep `retention_lost` in this server-local type.

Do not change `shared/ws-protocol.ts` in this step; preserving the old wire value keeps older messages parseable.

- [ ] **Step 2: Remove retention-only retagging in broker replacement**

In `server/terminal-stream/broker.ts`, simplify `replaceStreamIdentity()`:

```ts
private replaceStreamIdentity(terminalId: string, reason: TerminalStreamReplacementReason): string {
  const streamId = this.streamIdentity.replaceStream(terminalId, reason)
  const state = this.terminals.get(terminalId)
  if (state) {
    for (const attachment of state.clients.values()) {
      this.sendStreamChanged(
        attachment.ws,
        terminalId,
        streamId,
        reason,
        attachment.activeAttachRequestId,
      )
      this.convertReplayCursorToCurrentStreamGap(terminalId, attachment, streamId)
    }
  }
  log.info({
    terminalId,
    streamId,
    reason,
  }, 'Terminal output stream identity replaced')
  return streamId
}
```

- [ ] **Step 3: Make replay retention logging stream-stable**

In `server/terminal-stream/broker.ts`, replace `handleReplayRetentionLoss()` with:

```ts
private handleReplayRetentionLoss(
  terminalId: string,
  state: BrokerTerminalState,
): void {
  if (!state.replayRing.consumeRetentionLoss()) return
  const streamId = this.streamIdentity.ensureStream(terminalId)
  const now = Date.now()
  const lastLogAt = state.replayRetentionLogLastAt
  if (
    typeof lastLogAt === 'number'
    && now - lastLogAt < TERMINAL_REPLAY_RETENTION_LOG_RATE_LIMIT_MS
  ) {
    state.replayRetentionLogSuppressed = (state.replayRetentionLogSuppressed ?? 0) + 1
    return
  }
  const suppressedCount = state.replayRetentionLogSuppressed ?? 0
  state.replayRetentionLogLastAt = now
  state.replayRetentionLogSuppressed = 0
  this.logTerminalReplayRetention({
    terminalId,
    streamId,
    attachRequestIds: [...state.clients.values()]
      .map((attachment) => attachment.activeAttachRequestId)
      .filter((attachRequestId): attachRequestId is string => Boolean(attachRequestId)),
    attachmentCount: state.clients.size,
    reason: 'retention_lost',
    retainedBytes: state.replayRing.retainedBytes(),
    maxBytes: state.replayRing.retentionMaxBytes(),
    tailSeq: state.replayRing.tailSeq(),
    headSeq: state.replayRing.headSeq(),
    ...(suppressedCount > 0 ? { suppressedCount } : {}),
  })
}
```

Update both call sites:

```ts
// getOrCreateTerminalState(), after state.replayRing.setMaxBytes(replayRingMaxBytes)
this.handleReplayRetentionLoss(terminalId, state)
```

```ts
// appendOutputFrames(), after appending fragments
this.handleReplayRetentionLoss(terminalId, state)
return frames
```

Remove the old retained-stream return value from `appendOutputFrames()`:

```ts
const retainedStreamId = this.handleReplayRetentionLoss(terminalId, state, streamId)
if (retainedStreamId) {
  this.retagFrames(frames, streamId, retainedStreamId)
}
```

Delete the old block above, then remove the `retagFrames()` helper if it becomes unused.

Also update `logTerminalReplayRetention()`:

```ts
private logTerminalReplayRetention(input: {
  terminalId: string
  streamId: string
  attachRequestIds: string[]
  attachmentCount: number
  reason: 'retention_lost'
  retainedBytes: number
  maxBytes: number
  tailSeq: number
  headSeq: number
  suppressedCount?: number
}): void {
  const basePayload = {
    event: 'terminal.replay.retention',
    severity: 'warn',
    terminalId: input.terminalId,
    streamId: input.streamId,
    attachRequestIds: input.attachRequestIds,
    attachmentCount: input.attachmentCount,
    reason: input.reason,
    retainedBytes: input.retainedBytes,
    maxBytes: input.maxBytes,
    tailSeq: input.tailSeq,
    headSeq: input.headSeq,
    ...(typeof input.suppressedCount === 'number' && input.suppressedCount > 0
      ? { suppressedCount: input.suppressedCount }
      : {}),
  }
  log.warn(basePayload, 'Terminal replay retention evicted old output')
}
```

- [ ] **Step 4: Remove unused retention retag helpers**

Delete these methods if TypeScript confirms no other code uses them:

```ts
// server/terminal-stream/replay-ring.ts
retagRetainedStreamSuffix(fromStreamId: string, toStreamId: string): void {
  this.storage.retagRetainedStreamSuffix(fromStreamId, toStreamId)
}
```

```ts
// server/terminal-stream/replay-deque.ts
retagRetainedStreamSuffix(fromStreamId: string, toStreamId: string): void {
  for (let index = this.frames.length - 1; index >= this.startIndex; index -= 1) {
    const frame = this.frames[index]
    if (frame.streamId !== fromStreamId) break
    frame.streamId = toStreamId
  }
}
```

```ts
// server/terminal-stream/client-output-queue.ts
retagPendingStream(fromStreamId: string, toStreamId: string): void {
  // delete the full method when unused
}
```

- [ ] **Step 5: Update narrow unit tests for deleted helpers**

In `test/unit/server/terminal-stream/stream-identity.test.ts`, remove expectations that call:

```ts
tracker.replaceStream('term-1', 'retention_lost')
```

Keep coverage for remaining active stream replacement reasons:

```ts
const afterCodexRecovery = tracker.replaceStream('term-1', 'codex_pty_recovery')
const afterRestartRecovery = tracker.replaceStream('term-1', 'server_restart_incompatible_retention')
```

In `test/unit/server/terminal-stream/client-output-queue.test.ts`, delete the `retagPendingStream` test if the method is removed.

- [ ] **Step 6: Run server unit tests**

Run:

```bash
npm run test:vitest -- run test/unit/server/ws-handler-backpressure.test.ts test/unit/server/terminal-stream/stream-identity.test.ts test/unit/server/terminal-stream/client-output-queue.test.ts --config config/vitest/vitest.server.config.ts
```

Expected: PASS.

### Task 3: Integration And Client Replay Gap Coverage

**Files:**
- Modify: `test/server/ws-terminal-stream-v2-replay.test.ts`
- Modify: `test/unit/client/lib/terminal-attach-seq-state.test.ts`
- Optionally modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`

**Interfaces:**
- Consumes: Stable server retention behavior from Task 2.
- Produces: End-to-end proof that stale reconnects use same-stream replay gaps and client sequence state stays fail-closed across lost ranges.

- [ ] **Step 1: Add server integration test**

In `test/server/ws-terminal-stream-v2-replay.test.ts`, add a test after the existing replay-window tests:

First update the local `createTerminal()` helper to return the `terminal.attach.ready`
message it already waits for. Existing callers can ignore the extra property:

```ts
async function createTerminal(ws: WebSocket, requestId: string): Promise<{ terminalId: string; ready: any }> {
  // existing create body...
  const ready = await waitForMessage(ws, (msg) => msg.type === 'terminal.attach.ready' && msg.terminalId === terminalId)
  expect(ready.terminalId).toBe(terminalId)
  return { terminalId, ready }
}
```

```ts
it('reconnects from evicted history with a same-stream replay gap and no stream change', async () => {
  registry.setReplayRingMaxChars(6)
  const { ws: ws1, close: close1 } = await createAuthenticatedConnection(port)
  const { terminalId, ready: seedReady } = await createTerminal(ws1, 'stable-retention-create')
  const seedStreamId = seedReady.streamId
  expect(seedStreamId).toEqual(expect.any(String))

  for (const chunk of ['aaa', 'bbb', 'ccc']) {
    registry.simulateOutput(terminalId, chunk)
  }
  await waitForMessage(
    ws1,
    (msg) => msg.type === 'terminal.output' && msg.terminalId === terminalId && msg.seqEnd >= 3,
  )

  const { ws: wsReconnect, close: closeReconnect } = await createAuthenticatedConnection(port)
  const observedPromise = collectMessages(wsReconnect, 100)
  const reconnectReadyPromise = waitForMessage(wsReconnect, (msg) => msg.type === 'terminal.attach.ready')
  const gapPromise = waitForMessage(wsReconnect, (msg) => msg.type === 'terminal.output.gap')
  const outputPromise = waitForMessage(wsReconnect, (msg) => msg.type === 'terminal.output' || msg.type === 'terminal.output.batch')
  sendAttach(wsReconnect, terminalId, {
    sinceSeq: 0,
    attachRequestId: 'stable-retention-reconnect',
  })

  const reconnectReady = await reconnectReadyPromise
  const gap = await gapPromise
  const output = await outputPromise
  const observed = await observedPromise

  expect(observed.filter((msg) => msg.type === 'terminal.stream.changed')).toEqual([])
  expect(reconnectReady.streamId).toBe(seedStreamId)
  expect(gap).toMatchObject({
    terminalId,
    streamId: seedStreamId,
    reason: 'replay_window_exceeded',
    attachRequestId: 'stable-retention-reconnect',
  })
  expect(output.streamId).toBe(seedStreamId)

  await close1()
  await closeReconnect()
})
```

If `FakeRegistry` in this file does not expose a replay-ring max override, add a per-test override that defaults to normal behavior and is consumed by the existing registry interface:

```ts
private replayRingMaxChars: number | undefined

setReplayRingMaxChars(next: number | undefined) {
  this.replayRingMaxChars = next
}

getReplayRingMaxChars() {
  return this.replayRingMaxChars
}
```

- [ ] **Step 2: Add direct sequence-state coverage**

In `test/unit/client/lib/terminal-attach-seq-state.test.ts`, add:

```ts
it('treats same-stream replay gaps as lost history without making later output unsafe to accept', () => {
  let state = beginAttach(createAttachSeqState({ lastSeq: 0 }))
  state = onAttachReady(state, { headSeq: 8, replayFromSeq: 6, replayToSeq: 8 })

  const gap = onOutputGap(state, { fromSeq: 1, toSeq: 5 })
  expect(gap.state.knownLostRanges).toEqual([{ fromSeq: 1, toSeq: 5 }])
  expect(gap.surfaceSafeForDeltaReplay).toBe(false)
  expect(gap.requiresSurfaceQuarantine).toBe(true)

  const frame = expectAcceptedFrame(onOutputFrame(gap.state, { seqStart: 6, seqEnd: 8 }))
  expect(frame.freshReset).toBe(false)
  expect(frame.state.lastSeq).toBe(8)
  expect(frame.state.pendingReplay).toBeNull()
  expect(markParserAppliedSeq(frame.state, 8).parserAppliedSeq).toBe(0)
})
```

- [ ] **Step 3: Run integration and client tests**

Run:

```bash
npm run test:vitest -- run test/server/ws-terminal-stream-v2-replay.test.ts --config config/vitest/vitest.server.config.ts
npm run test:vitest -- run test/unit/client/lib/terminal-attach-seq-state.test.ts
```

Expected: PASS.

Only add or adjust `test/unit/client/components/TerminalView.lifecycle.test.tsx` if these direct tests pass while a manual inspection shows `TerminalView` still retries or checkpoints unsafely.

### Task 4: Verification And Commit

**Files:**
- Commit all modified files from Tasks 1-3.

**Interfaces:**
- Consumes: All implementation tasks.
- Produces: A focused, committed branch ready for Fresh Eyes delta review.

- [ ] **Step 1: Typecheck**

Run:

```bash
npm run typecheck:server
npm run typecheck:client
```

Expected: both commands exit `0`.

- [ ] **Step 2: Focused regression suite**

Run:

```bash
npm run test:vitest -- run test/unit/server/ws-handler-backpressure.test.ts test/unit/server/terminal-stream/stream-identity.test.ts test/unit/server/terminal-stream/client-output-queue.test.ts --config config/vitest/vitest.server.config.ts
npm run test:vitest -- run test/server/ws-terminal-stream-v2-replay.test.ts --config config/vitest/vitest.server.config.ts
npm run test:vitest -- run test/unit/client/lib/terminal-attach-seq-state.test.ts
npm run test:vitest -- run test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: all focused commands exit `0`.

- [ ] **Step 3: Coordinated repo check**

Run:

```bash
FRESHELL_TEST_SUMMARY='stable replay retention stream final check' npm run check
```

Expected: coordinated `check` exits `0`.

- [ ] **Step 4: Commit**

Run:

```bash
git status --short
git add server/terminal-stream/broker.ts server/terminal-stream/stream-identity.ts server/terminal-stream/replay-ring.ts server/terminal-stream/replay-deque.ts server/terminal-stream/client-output-queue.ts test/unit/server/ws-handler-backpressure.test.ts test/unit/server/terminal-stream/stream-identity.test.ts test/unit/server/terminal-stream/client-output-queue.test.ts test/server/ws-terminal-stream-v2-replay.test.ts test/unit/client/lib/terminal-attach-seq-state.test.ts docs/superpowers/plans/2026-06-25-stable-replay-retention-stream.md
git commit -m "fix: keep terminal stream stable across replay retention"
```

Expected: one focused commit with the plan and code changes.

## Self-Review

**Spec coverage:** The plan implements the requested behavior: old scrollback expiration no longer resets the live stream, stale reconnects get a gap, and live output keeps flowing. It also preserves compatibility by leaving the shared protocol schema value in place.

**Placeholder scan:** No `TBD`, `TODO`, "implement later", or unspecified test steps remain.

**Type consistency:** `TerminalStreamReplacementReason` remains the server-local type for real stream replacement events. Replay retention logging still uses `reason: 'retention_lost'` as an observability value, not as a stream replacement reason.

**Load-bearing updates:** Validation confirmed replay eviction is ordinary byte-cap retention, sequence numbers remain monotonic across eviction, clients already fail closed across same-stream replay gaps, and the product already renders a gap marker before retained tail. Validation was inconclusive for replay retention while a paced replay cursor is active, so Task 1 requires a dedicated red test for that edge. Validation also showed `new_pty_session` may be compatibility-only in current server emitters, so Task 2 makes keeping that server-local reason conditional on type/static usage.
