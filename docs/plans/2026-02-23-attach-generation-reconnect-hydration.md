# Attach Generation and Hydration-Safe Reconnect Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate stale attach/replay races and stop noisy `reconnect window exceeded` warnings during visible refresh hydration while preserving forward-only sequence correctness.

**Architecture:** Add an `attachRequestId` to each `terminal.attach` request and have the server echo that ID on `terminal.attach.ready`, `terminal.output`, and `terminal.output.gap` for that attachment. On the client, treat `attachRequestId` as the attach generation token and drop stale messages from older generations, scoped per terminal ID so one terminal's attach generation cannot suppress another terminal's messages. Because `terminal.created` auto-attach currently does not originate from `attachTerminal`, explicitly clear client attach-generation state in the `terminal.created` handler so untagged create-path replay/output is accepted. Keep gap sequence advancement behavior, but suppress the hydration-only replay miss banner (`replay_window_exceeded`) for `viewport_hydrate` attaches.

**Tech Stack:** React 18 + Redux Toolkit + xterm.js, Node.js + ws, Zod shared protocol types, Vitest (unit + server integration + e2e-style client tests).

---

## Preflight (Worktree + Context)

1. Confirm you are in the dedicated worktree branch:
   - Run: `git status -sb`
   - Expected: `## plan/output-gap-attach-generation-v1`
2. Read these files before editing:
   - `shared/ws-protocol.ts`
   - `server/ws-handler.ts`
   - `server/terminal-stream/broker.ts`
   - `server/terminal-stream/client-output-queue.ts`
   - `server/terminal-stream/types.ts`
   - `src/components/TerminalView.tsx`
   - `test/unit/server/ws-handler-backpressure.test.ts`
   - `test/unit/client/components/TerminalView.lifecycle.test.tsx`
   - `test/e2e/terminal-settings-remount-scrollback.test.tsx`
3. Keep implementation DRY/YAGNI. Do not introduce legacy-protocol compatibility paths.
4. During execution, use `@superpowers:executing-plans` in task-sized batches.

---

### Task 1: Add Server Red Tests for Attach Generation Echo

**Files:**
- Modify: `test/unit/server/ws-handler-backpressure.test.ts`
- Modify: `test/server/ws-terminal-stream-v2-replay.test.ts`

**Step 1: Write the failing unit test for attachRequestId echo on ready/output/gap**

Add a new test in `test/unit/server/ws-handler-backpressure.test.ts` that directly exercises `TerminalStreamBroker.attach` with a request ID:

```ts
it('echoes attachRequestId on attach.ready, output, and output.gap for a client attachment', async () => {
  const registry = new FakeBrokerRegistry()
  const broker = new TerminalStreamBroker(registry as any, vi.fn())
  registry.createTerminal('term-attach-id')

  const ws = createMockWs()
  const attached = await broker.attach(ws as any, 'term-attach-id', 0, 'attach-1')
  expect(attached).toBe(true)

  registry.emit('terminal.output.raw', { terminalId: 'term-attach-id', data: 'seed', at: Date.now() })
  vi.advanceTimersByTime(5)

  const payloads = ws.send.mock.calls
    .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
    .filter((payload): payload is Record<string, any> => !!payload && typeof payload === 'object')

  expect(payloads.some((m) => m.type === 'terminal.attach.ready' && m.attachRequestId === 'attach-1')).toBe(true)
  expect(payloads.some((m) => m.type === 'terminal.output' && m.attachRequestId === 'attach-1')).toBe(true)

  broker.close()
})
```

Add a replay miss assertion in `test/server/ws-terminal-stream-v2-replay.test.ts` for attach ID on `terminal.attach.ready` and `terminal.output.gap`:

```ts
ws2.send(JSON.stringify({
  type: 'terminal.attach',
  terminalId,
  sinceSeq: 1,
  attachRequestId: 'attach-replay-1',
}))

expect(ready.attachRequestId).toBe('attach-replay-1')
expect(gap.attachRequestId).toBe('attach-replay-1')
```

**Step 2: Run tests to verify they fail**

Run:

```bash
npm run test -- test/unit/server/ws-handler-backpressure.test.ts test/server/ws-terminal-stream-v2-replay.test.ts
```

Expected: FAIL with TypeScript/runtime errors because `attachRequestId` is not yet in method signatures/payloads.

**Step 3: Implement minimal protocol + broker echo support**

Update shared protocol contracts in `shared/ws-protocol.ts`:

```ts
export const TerminalAttachSchema = z.object({
  type: z.literal('terminal.attach'),
  terminalId: z.string().min(1),
  sinceSeq: z.number().int().nonnegative().optional(),
  attachRequestId: z.string().min(1).optional(),
})

export type TerminalAttachReadyMessage = {
  type: 'terminal.attach.ready'
  terminalId: string
  headSeq: number
  replayFromSeq: number
  replayToSeq: number
  attachRequestId?: string
}

export type TerminalOutputMessage = {
  type: 'terminal.output'
  terminalId: string
  seqStart: number
  seqEnd: number
  data: string
  attachRequestId?: string
}

export type TerminalOutputGapMessage = {
  type: 'terminal.output.gap'
  terminalId: string
  fromSeq: number
  toSeq: number
  reason: 'queue_overflow' | 'replay_window_exceeded'
  attachRequestId?: string
}
```

Update broker attachment tracking in `server/terminal-stream/types.ts`:

```ts
export type BrokerClientAttachment = {
  ws: LiveWebSocket
  mode: 'attaching' | 'live'
  queue: ClientOutputQueue
  attachStaging: ReplayFrame[]
  lastSeq: number
  flushTimer: NodeJS.Timeout | null
  catastrophicClosed: boolean
  activeAttachRequestId?: string
  catastrophicSince?: number
}
```

Update broker + ws handler signatures:

```ts
// server/terminal-stream/broker.ts
async sendCreatedAndAttach(
  ws: LiveWebSocket,
  created: CreatedEnvelope,
  sinceSeq: number | undefined = 0,
  attachRequestId?: string,
): Promise<boolean> { ... }

async attach(
  ws: LiveWebSocket,
  terminalId: string,
  sinceSeq: number | undefined,
  attachRequestId?: string,
): Promise<boolean> { ... }

// server/ws-handler.ts
const attached = await this.terminalStreamBroker.attach(ws, m.terminalId, m.sinceSeq, m.attachRequestId)
```

Keep `sendCreatedAndAttach(...)` call sites in `server/ws-handler.ts` unchanged for now (no client-provided `attachRequestId` on create path), and pass through optional attach ID if a future caller provides one:

```ts
return await this.attach(ws, created.terminalId, sinceSeq, attachRequestId)
```

Send echoed ID from broker:

```ts
attachment.activeAttachRequestId = attachRequestId

this.safeSend(ws, {
  type: 'terminal.attach.ready',
  terminalId,
  headSeq,
  replayFromSeq,
  replayToSeq,
  ...(attachment.activeAttachRequestId ? { attachRequestId: attachment.activeAttachRequestId } : {}),
})
```

And in `sendFrame` / `sendGap` include `attachRequestId` from the active attachment at every send call site (not just helper signatures):

```ts
const attachRequestId = attachment.activeAttachRequestId

// attach() replay-miss path
this.safeSend(ws, {
  type: 'terminal.output.gap',
  terminalId,
  fromSeq: replay.missedFromSeq,
  toSeq: missedToSeq,
  reason: 'replay_window_exceeded',
  ...(attachRequestId ? { attachRequestId } : {}),
})

// attach() replay + staged loops
this.sendFrame(ws, terminalId, frame, attachRequestId)

// flushAttachment() batch loop
this.sendGap(ws, terminalId, item, attachRequestId)
this.sendFrame(ws, terminalId, item, attachRequestId)
```

**Step 4: Run tests to verify pass**

Run:

```bash
npm run test -- test/unit/server/ws-handler-backpressure.test.ts test/server/ws-terminal-stream-v2-replay.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add shared/ws-protocol.ts server/ws-handler.ts server/terminal-stream/broker.ts server/terminal-stream/types.ts test/unit/server/ws-handler-backpressure.test.ts test/server/ws-terminal-stream-v2-replay.test.ts
git commit -m "feat(terminal-stream): tag attach replay/output payloads with attachRequestId generation"
```

---

### Task 2: Superseding Attach Should Clear Stale Queues in Broker

**Files:**
- Modify: `test/unit/server/ws-handler-backpressure.test.ts`
- Modify: `server/terminal-stream/client-output-queue.ts`
- Modify: `server/terminal-stream/broker.ts`

**Step 1: Write failing test for same-socket reattach supersession**

Add a test proving reattach to same terminal/socket replaces the active generation and does not keep stale queued frames:

```ts
it('superseding attach on same socket clears stale queued frames and switches attachRequestId', async () => {
  const registry = new FakeBrokerRegistry()
  const broker = new TerminalStreamBroker(registry as any, vi.fn())
  registry.createTerminal('term-supersede')

  const ws = createMockWs()
  await broker.attach(ws as any, 'term-supersede', 0, 'attach-old')
  registry.emit('terminal.output.raw', { terminalId: 'term-supersede', data: 'old-frame', at: Date.now() })

  await broker.attach(ws as any, 'term-supersede', 0, 'attach-new')
  registry.emit('terminal.output.raw', { terminalId: 'term-supersede', data: 'new-frame', at: Date.now() })
  vi.advanceTimersByTime(5)

  const outputs = ws.send.mock.calls
    .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
    .filter((m) => m?.type === 'terminal.output')

  expect(outputs.some((m) => m.data.includes('new-frame') && m.attachRequestId === 'attach-new')).toBe(true)
  expect(outputs.some((m) => m.data.includes('old-frame') && m.attachRequestId === 'attach-old')).toBe(false)

  broker.close()
})
```

**Step 2: Run test to verify failure**

Run:

```bash
npm run test -- test/unit/server/ws-handler-backpressure.test.ts -t "superseding attach"
```

Expected: FAIL because queue/reset behavior is not implemented.

**Step 3: Implement queue reset support and call it on attach start**

Add `clear()` API in `server/terminal-stream/client-output-queue.ts`:

```ts
clear(): void {
  this.frames = []
  this.totalBytes = 0
  this.pendingGap = null
}
```

At the start of `attach()` lock section in `server/terminal-stream/broker.ts`, reset per-client transient state:

```ts
if (attachment.flushTimer) {
  clearTimeout(attachment.flushTimer)
  attachment.flushTimer = null
}

attachment.mode = 'attaching'
attachment.activeAttachRequestId = attachRequestId
attachment.attachStaging = []
attachment.queue.clear()
```

Keep existing replay/staging flow unchanged otherwise.

**Step 4: Run targeted server tests**

Run:

```bash
npm run test -- test/unit/server/ws-handler-backpressure.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/terminal-stream/client-output-queue.ts server/terminal-stream/broker.ts test/unit/server/ws-handler-backpressure.test.ts
git commit -m "fix(terminal-stream): clear stale queue state when a newer attach generation supersedes"
```

---

### Task 3: Add Client Red Tests for Stale Attach Message Rejection

**Files:**
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Modify: `src/components/TerminalView.tsx`

**Step 1: Write failing lifecycle tests for attach generation handling**

Add tests that verify:
1. `TerminalView` sends `attachRequestId` on every `terminal.attach`.
2. Messages from an older attach generation are ignored.
3. Existing exact-match `terminal.attach` assertions are updated for the new field.
4. `terminal.created` auto-attach messages (which may not carry `attachRequestId`) are still accepted after a prior attach generation existed.

Example test skeleton:

```ts
it('drops stale terminal.output from an older attachRequestId generation', async () => {
  const { terminalId, term } = await renderTerminalHarness({ status: 'running', terminalId: 'term-attach-gen' })

  const firstAttach = wsMocks.send.mock.calls
    .map(([msg]) => msg)
    .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
  expect(firstAttach?.attachRequestId).toBeTruthy()

  wsMocks.send.mockClear()
  reconnectHandler?.()

  const secondAttach = wsMocks.send.mock.calls
    .map(([msg]) => msg)
    .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)

  expect(secondAttach?.attachRequestId).toBeTruthy()
  expect(secondAttach?.attachRequestId).not.toBe(firstAttach?.attachRequestId)

  messageHandler!({
    type: 'terminal.output',
    terminalId,
    seqStart: 1,
    seqEnd: 1,
    data: 'STALE',
    attachRequestId: firstAttach!.attachRequestId,
  } as any)

  messageHandler!({
    type: 'terminal.output',
    terminalId,
    seqStart: 2,
    seqEnd: 2,
    data: 'FRESH',
    attachRequestId: secondAttach!.attachRequestId,
  } as any)

  const writes = term.write.mock.calls.map(([d]) => String(d)).join('')
  expect(writes).toContain('FRESH')
  expect(writes).not.toContain('STALE')
})
```

Also update all legacy exact attach assertions in this file from strict object equality to partial matching so `attachRequestId` does not break unrelated assertions:

```ts
expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
  type: 'terminal.attach',
  terminalId,
  sinceSeq: 0,
  attachRequestId: expect.any(String),
}))
```

Apply this at the current assertion sites around:
- lines `1501`, `1523`, `1622`, `1642`, `1663`, `1685`, `1707`, `1722`, `1773`, `1804`, `1814`, `1838`, `1898`, `1936`, `2026`.

Add a regression test for create-path untagged messages:

```ts
it('accepts terminal.created auto-attach messages without attachRequestId after prior attach generation state', async () => {
  const { requestId, term } = await renderTerminalHarness({
    status: 'running',
    terminalId: 'term-old-generation',
  })

  // Establish prior attach generation state.
  reconnectHandler?.()
  wsMocks.send.mockClear()

  // Simulate create path switching to a new terminal.
  messageHandler!({
    type: 'terminal.created',
    requestId,
    terminalId: 'term-created-no-id',
    createdAt: Date.now(),
  } as any)

  messageHandler!({
    type: 'terminal.attach.ready',
    terminalId: 'term-created-no-id',
    headSeq: 1,
    replayFromSeq: 2,
    replayToSeq: 1,
  } as any)

  messageHandler!({
    type: 'terminal.output',
    terminalId: 'term-created-no-id',
    seqStart: 2,
    seqEnd: 2,
    data: 'created-live',
  } as any)

  const writes = term.write.mock.calls.map(([d]) => String(d)).join('')
  expect(writes).toContain('created-live')
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm run test -- test/unit/client/components/TerminalView.lifecycle.test.tsx -t "attachRequestId|stale"
```

Expected: FAIL because client does not send/track attach IDs yet.

**Step 3: Implement attach generation tracking in `TerminalView`**

Add attach context refs near existing sequence refs:

```ts
const attachCounterRef = useRef(0)
const currentAttachRef = useRef<{
  requestId: string
  intent: AttachIntent
  terminalId: string
} | null>(null)

const isCurrentAttachMessage = (msg: { terminalId?: string; attachRequestId?: string }) => {
  const current = currentAttachRef.current
  if (!current) return true
  if (msg.terminalId && msg.terminalId !== current.terminalId) return true
  if (!msg.attachRequestId) return false
  return msg.attachRequestId === current.requestId
}
```

When sending an attach:

```ts
const requestId = `${paneIdRef.current}:${++attachCounterRef.current}:${nanoid(6)}`
currentAttachRef.current = { requestId, intent, terminalId: tid }

ws.send({
  type: 'terminal.attach',
  terminalId: tid,
  sinceSeq,
  attachRequestId: requestId,
})
```

In each message branch (`terminal.attach.ready`, `terminal.output`, `terminal.output.gap`), ignore stale generation messages early:

```ts
if (!isCurrentAttachMessage(msg)) {
  if (debugRef.current) log.debug('Ignoring stale attach generation message', {
    paneId: paneIdRef.current,
    terminalId: msg.terminalId,
    attachRequestId: msg.attachRequestId,
    currentAttachRequestId: currentAttachRef.current?.requestId,
    type: msg.type,
  })
  return
}
```

And clear stale attach-generation context on lifecycle boundaries where the terminal ID changes or terminates:

```ts
if (msg.type === 'terminal.created' && msg.requestId === reqId) {
  currentAttachRef.current = null
  // ...existing created handling...
}

if (msg.type === 'terminal.exit' && msg.terminalId === tid) {
  currentAttachRef.current = null
  // ...existing exit handling...
}
```

**Step 4: Run targeted client lifecycle tests**

Run:

```bash
npm run test -- test/unit/client/components/TerminalView.lifecycle.test.tsx -t "attachRequestId|stale|non-blocking reconnect"
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "fix(terminal-view): track attach generation IDs and drop stale replay/output frames"
```

---

### Task 4: Make Hydration Replay Miss Non-Noisy (But Still Correct)

**Files:**
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Modify: `test/e2e/terminal-settings-remount-scrollback.test.tsx`
- Modify: `src/components/TerminalView.tsx`

**Step 1: Add failing tests for hydration replay miss banner suppression**

Add a unit test in `test/unit/client/components/TerminalView.lifecycle.test.tsx`:

```ts
it('suppresses replay_window_exceeded banner during viewport_hydrate attach generation', async () => {
  const { terminalId, term } = await renderTerminalHarness({ status: 'running', terminalId: 'term-hydrate-gap' })

  const attach = wsMocks.send.mock.calls
    .map(([msg]) => msg)
    .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)

  term.writeln.mockClear()

  messageHandler!({
    type: 'terminal.output.gap',
    terminalId,
    fromSeq: 1,
    toSeq: 50,
    reason: 'replay_window_exceeded',
    attachRequestId: attach!.attachRequestId,
  } as any)

  expect(term.writeln).not.toHaveBeenCalledWith(expect.stringContaining('reconnect window exceeded'))
})
```

Add an e2e-style assertion in `test/e2e/terminal-settings-remount-scrollback.test.tsx` that remains strict for no hydration replay miss banner in remount flow.

**Step 2: Run tests to verify failure**

Run:

```bash
npm run test -- test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/terminal-settings-remount-scrollback.test.tsx
```

Expected: FAIL because client always writes replay miss banner.

**Step 3: Implement conditional gap rendering in `TerminalView`**

In `terminal.output.gap` handler:

```ts
const currentAttach = currentAttachRef.current
const suppressHydrationReplayMiss =
  msg.reason === 'replay_window_exceeded'
  && currentAttach?.terminalId === msg.terminalId
  && currentAttach.intent === 'viewport_hydrate'
  && awaitingViewportHydrationRef.current

if (!suppressHydrationReplayMiss) {
  const reason = msg.reason === 'replay_window_exceeded'
    ? 'reconnect window exceeded'
    : 'slow link backlog'
  term.writeln(`\r\n[Output gap ${msg.fromSeq}-${msg.toSeq}: ${reason}]\r\n`)
}

// Keep existing correctness behavior:
// - onOutputGap(...)
// - applySeqState(... persistCursor: true)
// - completion bookkeeping
```

Do not skip sequence/cursor advancement; only skip visual noise.

**Step 4: Run tests to verify pass**

Run:

```bash
npm run test -- test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/terminal-settings-remount-scrollback.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/terminal-settings-remount-scrollback.test.tsx
git commit -m "fix(terminal-view): suppress hydration-only replay miss banner while preserving gap cursor advancement"
```

---

### Task 5: Integration Hardening for Attach Generation Contract

**Files:**
- Modify: `test/server/ws-edge-cases.test.ts`
- Modify: `test/server/ws-terminal-stream-v2-replay.test.ts`
- Modify: `server/terminal-stream/broker.ts` (only if integration failures expose missing propagation)

**Step 1: Add failing integration tests asserting attachRequestId continuity**

In `test/server/ws-edge-cases.test.ts`, add a test where client sends `attachRequestId` and asserts:
- `terminal.attach.ready.attachRequestId` matches
- replay `terminal.output.attachRequestId` matches
- replay miss `terminal.output.gap.attachRequestId` matches

```ts
ws2.send(JSON.stringify({
  type: 'terminal.attach',
  terminalId,
  sinceSeq: 2,
  attachRequestId: 'attach-int-1',
}))

expect(ready.attachRequestId).toBe('attach-int-1')
expect(replay.attachRequestId).toBe('attach-int-1')
```

**Step 2: Run integration tests to verify failure**

Run:

```bash
npm run test -- test/server/ws-edge-cases.test.ts test/server/ws-terminal-stream-v2-replay.test.ts
```

Expected: FAIL if any path misses attach ID propagation.

**Step 3: Fill remaining server propagation gaps**

If any path still omits `attachRequestId`, patch broker send helpers consistently:

```ts
private sendFrame(ws: LiveWebSocket, terminalId: string, frame: ReplayFrame, attachRequestId?: string): boolean {
  return this.safeSend(ws, {
    type: 'terminal.output',
    terminalId,
    seqStart: frame.seqStart,
    seqEnd: frame.seqEnd,
    data: frame.data,
    ...(attachRequestId ? { attachRequestId } : {}),
  })
}
```

Do the same for `sendGap` and all call sites, including:
- both replay frame loops in `attach()`
- replay miss `terminal.output.gap` send in `attach()`
- both branches in `flushAttachment()`

Concrete `flushAttachment()` shape:

```ts
const attachRequestId = attachment.activeAttachRequestId
for (const item of batch) {
  if (isGapEvent(item)) {
    if (!this.sendGap(ws, terminalId, item, attachRequestId)) return
    continue
  }
  if (!this.sendFrame(ws, terminalId, item, attachRequestId)) return
}
```

**Step 4: Re-run integration tests**

Run:

```bash
npm run test -- test/server/ws-edge-cases.test.ts test/server/ws-terminal-stream-v2-replay.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/terminal-stream/broker.ts test/server/ws-edge-cases.test.ts test/server/ws-terminal-stream-v2-replay.test.ts
git commit -m "test(terminal-stream): lock attachRequestId generation continuity through replay, output, and gaps"
```

---

### Task 6: Full Verification + Cleanup Refactor

**Files:**
- Modify: `test/unit/client/lib/terminal-attach-seq-state.test.ts`
- Modify: `src/lib/terminal-attach-seq-state.ts` (if needed for test clarity/hardening)
- Modify: `src/components/TerminalView.tsx` (small cleanup only)

**Step 1: Add failing unit test documenting replay-window overlap assumptions**

Add a unit test for merged frame behavior so the assumption is explicit and guarded:

```ts
it('accepts merged frames that overlap pending replay when they advance lastSeq', () => {
  let state = beginAttach(createAttachSeqState({ lastSeq: 0 }))
  state = onAttachReady(state, { headSeq: 12, replayFromSeq: 8, replayToSeq: 10 })

  const decision = onOutputFrame(state, { seqStart: 8, seqEnd: 11 })
  expect(decision.accept).toBe(true)
  if (decision.accept) {
    expect(decision.state.lastSeq).toBe(11)
  }
})
```

**Step 2: Run test to verify current behavior (red or flaky expectation mismatch)**

Run:

```bash
npm run test -- test/unit/client/lib/terminal-attach-seq-state.test.ts
```

Expected: If failing, adjust implementation; if passing, keep as coverage hardening.

**Step 3: Refactor for clarity without behavior change**

If needed, replace recursion in `onOutputFrame` with explicit one-shot reset flow to make bounded behavior obvious:

```ts
const shouldFreshReset =
  state.awaitingFreshSequence
  && frame.seqStart === 1
  && state.lastSeq > 0

const effectiveState = shouldFreshReset
  ? { ...state, lastSeq: 0, pendingReplay: null }
  : state
```

Then continue overlap checks against `effectiveState` (no recursive call).

**Step 4: Run full relevant suite**

Run:

```bash
npm run test -- test/unit/client/lib/terminal-attach-seq-state.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/server/ws-handler-backpressure.test.ts test/server/ws-terminal-stream-v2-replay.test.ts test/server/ws-edge-cases.test.ts test/e2e/terminal-settings-remount-scrollback.test.tsx
npm run check
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/terminal-attach-seq-state.ts test/unit/client/lib/terminal-attach-seq-state.test.ts src/components/TerminalView.tsx
git commit -m "refactor(terminal-seq): harden overlap semantics and document merged-frame replay expectations"
```

---

## Final Verification (Before Merge)

1. Run full tests:

```bash
npm test
```

Expected: PASS.

2. Inspect diff for scope:

```bash
git status -sb
git diff --stat main...HEAD
```

Expected: only protocol + broker + terminal view + listed tests.

3. Validate no legacy attach paths were reintroduced:

```bash
rg "terminal\.attached\.start|terminal\.attached\.chunk|terminal\.attached\.end" src server shared test
```

Expected: no matches.

4. Merge safety reminder:
- Merge/rebase `main` into this worktree branch first.
- Then fast-forward `main` only with `git merge --ff-only`.
