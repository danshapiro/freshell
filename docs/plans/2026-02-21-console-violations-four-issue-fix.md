# Console Violations + Chunked Attach Stability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Use `@superpowers:executing-plans` for execution handoff.

**Goal:** Eliminate the four high-impact console issues by fixing chunked-attach routing noise, reducing WebSocket message-handler main-thread cost, removing forced reflow/slow RAF hotspots, and bounding `/api/logs/client` overhead.

**Architecture:** Split terminal data handling into a fast ingest path and a scheduled render path so `ws.onmessage` only routes/enqueues work. Tighten chunked-attach routing so non-owning panes ignore attach frames without warning spam. Coalesce terminal layout writes (`fit`, `resize`) and snapshot replay scroll work into a single frame scheduler (without changing live-output scroll behavior), and add client-log transport guards to prevent perf-log feedback loops.

**Tech Stack:** React 18, TypeScript, xterm.js, ws WebSocket protocol, Vitest (unit + e2e), superwstest integration tests.

---

## Scope Mapping (Issue -> Fix)

1. `ChunkedAttach` mismatched-terminal warning spam
- Route attach lifecycle frames only to the owning terminal view.
- Make mismatched frames a silent no-op (or rate-limited debug), not `warn`.

2. Slow `'message'` handlers + `perf.longtask`
- Move terminal output/snapshot writes off the `ws.onmessage` hot path.
- Cap server `terminal.output` frame size to avoid giant parse/write chunks on client.

3. Forced reflow + slow `requestAnimationFrame`
- Introduce frame-coalesced terminal layout scheduler (single RAF for `fit` + `resize` + optional scroll).
- Move snapshot replay scroll work behind the same RAF scheduler; do not alter live output scrolling semantics.

4. Slow `/api/logs/client` fetch overhead
- Add client-log dedupe/sampling/backoff.
- Break feedback loop by excluding logger transport resource entries from perf resource warnings.

---

### Task 1: Build Reproduction Guard Rails for All Four Issues

**Files:**
- Create: `test/e2e/terminal-console-violations-regression.test.tsx`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Modify: `test/unit/client/lib/client-logger.test.ts`
- Modify: `test/unit/client/lib/perf-logger.test.ts`

**Step 1: Write failing e2e regression test for multi-terminal attach/output pressure**

Create a single flow test that mounts two terminal panes and simulates:
- interleaved `terminal.attached.start/chunk/end` for both terminals,
- burst `terminal.output` frames,
- perf/resource logging enabled.

Use assertions that currently fail:

```ts
expect(consoleWarnSpy).not.toHaveBeenCalledWith(
  expect.stringContaining('ignoring chunk for mismatched terminal')
)
expect(wsHandlerDurationSamples.some((ms) => ms > 30)).toBe(false)
```

**Step 2: Run test to verify failure**

Run:

```bash
NODE_ENV=test npx vitest run test/e2e/terminal-console-violations-regression.test.tsx
```

Expected: FAIL with chunked-attach warning noise and slow-handler evidence.

**Step 3: Add focused failing unit tests for logger/perf recursion signal**

In `test/unit/client/lib/client-logger.test.ts`, add:

```ts
it('does not enqueue perf telemetry payloads for remote transport', async () => {
  const logger = createClientLogger({ enableNetwork: true, flushIntervalMs: 0 })
  const uninstall = logger.installConsoleCapture()

  console.warn({ event: 'perf.longtask', perf: true, durationMs: 120 })
  await logger.flush()

  uninstall()
  expect(fetch).not.toHaveBeenCalled()
})
```

In `test/unit/client/lib/perf-logger.test.ts`, add a filter assertion for `/api/logs/client` resource entries.

**Step 4: Run targeted tests to verify failure**

Run:

```bash
NODE_ENV=test npx vitest run test/unit/client/lib/client-logger.test.ts test/unit/client/lib/perf-logger.test.ts
```

Expected: FAIL (new filters not implemented yet).

**Step 5: Commit red tests**

```bash
git add test/e2e/terminal-console-violations-regression.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/lib/client-logger.test.ts test/unit/client/lib/perf-logger.test.ts
git commit -m "test(perf): add failing regression coverage for chunked-attach spam, ws handler stalls, and client-log recursion"
```

---

### Task 2: Fix Chunked-Attach Mismatch Spam with Terminal-Scoped Routing

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Test: `test/e2e/terminal-console-violations-regression.test.tsx`

**Step 1: Write/adjust failing tests for terminal-scoped chunk lifecycle handling**

Update existing mismatch test to assert silent ignore (no warning) and correct snapshot assembly for owning terminal.

```ts
expect(term.write).toHaveBeenCalledWith('abc', expect.any(Function))
expect(consoleWarnSpy).not.toHaveBeenCalledWith(
  expect.stringContaining('mismatched terminal')
)
```

**Step 2: Run targeted test to verify failure**

Run:

```bash
NODE_ENV=test npx vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: FAIL because current code emits warning spam.

**Step 3: Implement terminal-scoped routing before chunk lifecycle handler**

In `src/components/TerminalView.tsx`, gate lifecycle handling by terminal ownership before calling `handleChunkLifecycleMessage`:

```ts
const msgTerminalId = typeof (msg as { terminalId?: unknown }).terminalId === 'string'
  ? (msg as { terminalId: string }).terminalId
  : undefined
const currentTerminalId = terminalIdRef.current

const isChunkLifecycleType =
  msg.type === 'terminal.attached.start' ||
  msg.type === 'terminal.attached.chunk' ||
  msg.type === 'terminal.attached.end'

if (isChunkLifecycleType && msgTerminalId && currentTerminalId && msgTerminalId !== currentTerminalId) {
  return
}

if (handleChunkLifecycleMessage(msg)) return
```

Keep mismatch filtering in `TerminalView.tsx` only. Do not duplicate equivalent routing logic inside `useChunkedAttach.ts`; that would create dead/duplicated behavior paths.

**Step 4: Run tests to verify pass**

Run:

```bash
NODE_ENV=test npx vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/terminal-console-violations-regression.test.tsx
```

Expected: PASS for mismatch-warning assertions.

**Step 5: Commit**

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/terminal-console-violations-regression.test.tsx
git commit -m "fix(terminal): route chunked attach lifecycle by owning terminal and remove mismatched warning spam"
```

---

### Task 3: Cut `ws.onmessage` Hot-Path Cost with Client Write Queue + Server Output Frame Cap

**Files:**
- Create: `src/components/terminal/terminal-write-queue.ts`
- Modify: `src/components/TerminalView.tsx`
- Modify: `server/terminal-registry.ts`
- Modify: `shared/ws-protocol.ts` (docs/comments only if needed)
- Modify: `test/unit/client/components/terminal/terminal-write-queue.test.ts`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Modify: `test/unit/server/terminal-lifecycle.test.ts`
- Test: `test/e2e/terminal-console-violations-regression.test.tsx`

**Step 1: Write failing tests for time-sliced client write queue**

Create `test/unit/client/components/terminal/terminal-write-queue.test.ts`:

```ts
it('processes queued writes in slices and preserves order', async () => {
  const writes: string[] = []
  const rafCallbacks: FrameRequestCallback[] = []
  const queue = createTerminalWriteQueue({
    write: (chunk) => writes.push(chunk),
    requestFrame: (cb) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    },
    cancelFrame: () => {},
    budgetMs: 4,
  })

  queue.enqueue('A')
  queue.enqueue('B')
  queue.enqueue('C')

  rafCallbacks.shift()?.(16)
  rafCallbacks.shift()?.(32)
  expect(writes.join('')).toBe('ABC')
})
```

Add a test that enqueueing from WS handler does not synchronously call `term.write`.

**Step 2: Run tests to verify failure**

Run:

```bash
NODE_ENV=test npx vitest run test/unit/client/components/terminal/terminal-write-queue.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: FAIL (queue utility not present).

**Step 3: Implement client write queue and wire TerminalView to enqueue (not write inline)**

Create `src/components/terminal/terminal-write-queue.ts`:

```ts
export function createTerminalWriteQueue(params: {
  write: (data: string) => void
  onDrain?: () => void
  budgetMs?: number
  requestFrame?: (cb: FrameRequestCallback) => number
  cancelFrame?: (id: number) => void
}) {
  const queue: string[] = []
  let rafId: number | null = null
  const budgetMs = params.budgetMs ?? 8
  const requestFrame = params.requestFrame ?? requestAnimationFrame
  const cancelFrame = params.cancelFrame ?? cancelAnimationFrame

  const flush = (startedAt: number) => {
    rafId = null
    const deadline = startedAt + budgetMs
    while (queue.length > 0 && performance.now() < deadline) {
      const next = queue.shift()!
      params.write(next)
    }
    if (queue.length > 0) {
      rafId = requestFrame(flush)
      return
    }
    params.onDrain?.()
  }

  return {
    enqueue(data: string) {
      if (!data) return
      queue.push(data)
      if (rafId === null) {
        rafId = requestFrame(flush)
      }
    },
    clear() {
      queue.length = 0
      if (rafId !== null) {
        cancelFrame(rafId)
        rafId = null
      }
    },
  }
}
```

In `TerminalView.tsx`, replace direct `term.write(...)` in output/snapshot handlers with queue enqueue calls, keeping OSC52/turn-complete parsing but avoiding synchronous DOM work in `ws.onmessage`.

**Step 4: Add server output frame cap to prevent single giant `terminal.output` messages**

In `server/terminal-registry.ts`:

```ts
const MAX_OUTPUT_FRAME_CHARS = Number(process.env.MAX_OUTPUT_FRAME_CHARS || 8192)

private safeSendOutputFrames(client: WebSocket, terminalId: string, data: string, perf?: TerminalRecord['perf']) {
  if (!data) return
  for (let i = 0; i < data.length; i += MAX_OUTPUT_FRAME_CHARS) {
    this.safeSend(
      client,
      { type: 'terminal.output', terminalId, data: data.slice(i, i + MAX_OUTPUT_FRAME_CHARS) },
      { terminalId, perf },
    )
  }
}
```

Apply `safeSendOutputFrames(...)` in all three server send sites:
- `flushOutputBuffer` after `chunks.join('')` (split after join, not before).
- `sendTerminalOutput` immediate path (`!shouldBatch`).
- `sendTerminalOutput` overflow path (`nextSize > MAX_OUTPUT_BUFFER_CHARS` after flush).

Add unit tests in `test/unit/server/terminal-lifecycle.test.ts`:

```ts
it('splits oversized terminal.output payloads into bounded frames preserving order', () => {
  // emit > MAX_OUTPUT_FRAME_CHARS and assert multiple ordered terminal.output frames
})
```

**Step 5: Run tests**

Run:

```bash
NODE_ENV=test npx vitest run test/unit/client/components/terminal/terminal-write-queue.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/server/terminal-lifecycle.test.ts test/e2e/terminal-console-violations-regression.test.tsx
```

Expected: PASS; slow-handler regression assertions improve.

**Step 6: Commit**

```bash
git add src/components/terminal/terminal-write-queue.ts src/components/TerminalView.tsx server/terminal-registry.ts test/unit/client/components/terminal/terminal-write-queue.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/server/terminal-lifecycle.test.ts test/e2e/terminal-console-violations-regression.test.tsx
git commit -m "perf(terminal): time-slice client writes and cap terminal.output frame size to shrink ws handler long tasks"
```

---

### Task 4: Remove Forced Reflow and Slow RAF Hotspots in Terminal Layout Work

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Create: `src/components/terminal/layout-scheduler.ts`
- Modify: `test/unit/client/components/TerminalView.mobile-viewport.test.tsx`
- Modify: `test/unit/client/components/TerminalView.visibility.test.tsx`
- Test: `test/e2e/terminal-console-violations-regression.test.tsx`

**Step 1: Write failing tests for coalesced fit/resize scheduling**

Add tests that multiple resize/visibility triggers within one frame call `runtime.fit()` once.

```ts
expect(runtime.fit).toHaveBeenCalledTimes(1)
expect(ws.send).toHaveBeenCalledWith({ type: 'terminal.resize', terminalId: 'term-1', cols: 80, rows: 24 })
```

**Step 2: Run tests to verify failure**

Run:

```bash
NODE_ENV=test npx vitest run test/unit/client/components/TerminalView.mobile-viewport.test.tsx test/unit/client/components/TerminalView.visibility.test.tsx
```

Expected: FAIL because current code calls `fit` from multiple call sites with no frame coalescing.

**Step 3: Implement a shared layout scheduler**

Create `src/components/terminal/layout-scheduler.ts`:

```ts
export function createLayoutScheduler(run: () => void) {
  let rafId: number | null = null
  return {
    request() {
      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        run()
      })
    },
    cancel() {
      if (rafId !== null) cancelAnimationFrame(rafId)
      rafId = null
    },
  }
}
```

In `TerminalView.tsx`, use one scheduler instance for:
- `ResizeObserver` callback,
- "became visible" effect,
- initial post-open fit,
- snapshot replay completion scroll (not live output writes).

Replace direct inline fit/resize calls with scheduler requests.

**Step 4: Run tests**

Run:

```bash
NODE_ENV=test npx vitest run test/unit/client/components/TerminalView.mobile-viewport.test.tsx test/unit/client/components/TerminalView.visibility.test.tsx test/e2e/terminal-console-violations-regression.test.tsx
```

Expected: PASS; regression test no longer reports forced reflow/RAF spikes for synthetic load.

**Step 5: Commit**

```bash
git add src/components/terminal/layout-scheduler.ts src/components/TerminalView.tsx test/unit/client/components/TerminalView.mobile-viewport.test.tsx test/unit/client/components/TerminalView.visibility.test.tsx test/e2e/terminal-console-violations-regression.test.tsx
git commit -m "perf(layout): coalesce terminal fit/resize/scroll work into single RAF scheduler to reduce reflow and slow frame handlers"
```

---

### Task 5: Bound Client Log Transport and Break Perf-Log Feedback Loop

**Files:**
- Modify: `src/lib/client-logger.ts`
- Modify: `src/lib/perf-logger.ts`
- Modify: `test/unit/client/lib/client-logger.test.ts`
- Modify: `test/unit/client/lib/perf-logger.test.ts`
- Modify: `test/integration/server/client-logs-api.test.ts`
- Test: `test/e2e/terminal-console-violations-regression.test.tsx`

**Step 1: Write failing tests for transport filtering + dedupe + backoff**

Add tests in `test/unit/client/lib/client-logger.test.ts`:

```ts
it('drops duplicate warn entries within dedupe window', async () => {
  console.warn('[ChunkedAttach] noisy warning')
  console.warn('[ChunkedAttach] noisy warning')
  await logger.flush()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(parsed.entries).toHaveLength(1)
})

it('backs off network flush after slow send and retries later', async () => {
  fetch.mockImplementationOnce(() => new Promise((r) => setTimeout(() => r({ ok: true }), 2500)))
  // assert logger enters temporary backoff and does not spam concurrent requests
})
```

Add perf filter test in `test/unit/client/lib/perf-logger.test.ts` for ignoring `/api/logs/client` in resource observer.

**Step 2: Run tests to verify failure**

Run:

```bash
NODE_ENV=test npx vitest run test/unit/client/lib/client-logger.test.ts test/unit/client/lib/perf-logger.test.ts
```

Expected: FAIL (no dedupe/backoff/filter yet).

**Step 3: Implement logger transport controls in `client-logger.ts`**

Add three mechanisms:

1) Dedupe window:

```ts
const recentByFingerprint = new Map<string, number>()
const DEDUPE_WINDOW_MS = 5000

function shouldDropDuplicate(entry: ClientLogEntry): boolean {
  const eventKey = entry.event ?? entry.consoleMethod ?? 'unknown'
  const messageKey = entry.message ?? JSON.stringify(entry.args?.[0] ?? '')
  const fingerprint = `${entry.severity}:${eventKey}:${messageKey}`
  const now = Date.now()
  const last = recentByFingerprint.get(fingerprint)
  recentByFingerprint.set(fingerprint, now)
  return typeof last === 'number' && now - last < DEDUPE_WINDOW_MS
}
```

2) Perf telemetry filter for remote transport:

```ts
function isPerfTelemetryEntry(entry: ClientLogEntry): boolean {
  return entry.event?.startsWith('console.') && entry.args?.some((arg) => {
    return !!arg && typeof arg === 'object' && (arg as { perf?: unknown }).perf === true
  })
}
```

3) Slow-send backoff:

```ts
let nextFlushAllowedAt = 0
const SLOW_FLUSH_BACKOFF_MS = 5000

if (Date.now() < nextFlushAllowedAt) return
const startedAt = performance.now()
await sendBatch(batch)
if (performance.now() - startedAt > 1500) {
  nextFlushAllowedAt = Date.now() + SLOW_FLUSH_BACKOFF_MS
}
```

**Step 4: Implement perf resource filter in `perf-logger.ts`**

In `observeResources()`:

```ts
if (entry.name.includes('/api/logs/client')) continue
```

(Keep other resource logging unchanged.)

**Step 5: Run tests**

Run:

```bash
NODE_ENV=test npx vitest run test/unit/client/lib/client-logger.test.ts test/unit/client/lib/perf-logger.test.ts test/integration/server/client-logs-api.test.ts test/e2e/terminal-console-violations-regression.test.tsx
```

Expected: PASS; `/api/logs/client` chatter is bounded and no recursive perf-resource loop.

**Step 6: Commit**

```bash
git add src/lib/client-logger.ts src/lib/perf-logger.ts test/unit/client/lib/client-logger.test.ts test/unit/client/lib/perf-logger.test.ts test/integration/server/client-logs-api.test.ts test/e2e/terminal-console-violations-regression.test.tsx
git commit -m "perf(logging): add client-log dedupe/backoff and exclude log transport from perf resource warnings"
```

---

### Task 6: Full Verification + Documentation Update

**Files:**
- Modify: `docs/plans/2026-02-21-console-violations-four-issue-fix.md` (checklist + measured outcomes)
- Optional Modify (if UI behavior changed materially): `docs/index.html`

**Step 1: Run full project checks**

Run:

```bash
npm run lint
npm run check
npm test
```

Expected: PASS.

**Step 2: Verify perf outcomes in dev session with debug logging on**

Manual acceptance script:
1. Enable Debug logging in UI settings.
2. Open 3+ tabs with active terminals.
3. Trigger attach/reconnect and high output burst.
4. Confirm:
- No repeated `[chunked-attach] ignoring ... mismatched terminal` warnings.
- `perf.ws_message_handlers_slow` reduced; no repeated 150ms+ output handlers.
- No `Forced reflow while executing JavaScript` spikes during attach replay.
- `/api/logs/client` resource warnings significantly reduced/absent.

**Step 3: Update plan with measured before/after values**

Append a short result table in this plan doc:

```md
| Metric | Before | After |
| --- | --- | --- |
| chunked mismatch warns / min | 100+ | 0 |
| worst ws handler ms | 300+ | < 30 target |
| worst longtask ms | 3000+ | < 200 target |
| /api/logs/client slow events / 5 min | frequent | rare/0 |
```

**Step 4: Final commit**

```bash
git add docs/plans/2026-02-21-console-violations-four-issue-fix.md docs/index.html
git commit -m "chore(perf-plan): record verification outcomes for console violation fixes"
```

---

## Risks and Mitigations

- Risk: Time-sliced output queue could reorder snapshot/output writes.
  - Mitigation: single FIFO queue for both snapshot and output jobs; unit tests assert ordering.

- Risk: Output frame cap could increase message count under very high throughput.
  - Mitigation: keep server-side per-client buffering and tune `MAX_OUTPUT_FRAME_CHARS` with env override.

- Risk: Filtering perf telemetry from remote logs could hide useful diagnostics.
  - Mitigation: keep console output local; only suppress remote transport for high-volume perf events.

- Risk: RAF coalescing could under-send terminal resize events.
  - Mitigation: always send latest `cols/rows` at flush; test repeated resize bursts.

---

## Execution Notes

- Follow strict Red-Green-Refactor for every task.
- Keep commits small and task-scoped.
- Run targeted tests after each step, then full `npm test` before merge.
