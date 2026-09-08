# Stagger Restore-Driven terminal.create Launches Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Fix freshell kata rf0v: stagger restore-driven `terminal.create` dispatches (~400–500ms per pane) so a client reload/reconnect restoring multiple persisted panes never spawns multiple agent processes within the same ~100ms window, avoiding the known OpenCode/Bun concurrent-launch crash.

### Explicit constraints
- Fix only kata rf0v (restore-launch staggering); the build-mismatch deployment-hygiene item was explicitly excluded by the user.
- TDD (red-green-refactor) with unit and e2e coverage per repo rules.
- Work in a dedicated worktree branch; land via PR only after the user's explicit approval.

### Accepted tradeoffs and residuals
- Interactive launches don't strictly need staggering; sharing the same throttle is accepted as harmless.
- This is a client-side mitigation; the upstream Bun bug remains unfixed (defense-in-depth if upstream lands a fix).

**Goal:** A client reload/reconnect restoring N persisted terminal panes spaces `terminal.create` wire sends ~450ms apart so no two agent processes spawn within the same ~100ms window.

**Architecture:** A new `TerminalCreateStagger` module paces `terminal.create` wire sends at a 450ms minimum interval. It sits inside `WsClient` at the `sendNow` level — the single wire-level chokepoint that all create paths (direct-ready, pre-verdict held-creates flush, ready-handler preReadyCreateQueue flush, reconnect re-send) funnel through. Non-create messages bypass the stagger entirely. The stagger is cleared on each `ready` frame so stale entries from a dead socket don't double-send. This mirrors the existing `RebindQueue` precedent (which paces `freshAgent.create` for hidden panes) but operates at the wire level rather than the view level, ensuring the stagger survives the ws-client's internal hold/queue/flush mechanisms.

**Tech Stack:** TypeScript, React 18, Vitest (jsdom), Playwright (e2e), WebSocket

## Global Constraints

- Client-side code only (Vite-bundled `src/`); no server changes.
- `@/` path alias → `src/`.
- Follow existing patterns: `RebindQueue` (src/lib/rebind-queue.ts) for queue structure; `rebind-queue.test.ts` for test patterns.
- Fake timers (`vi.useFakeTimers` + `vi.advanceTimersByTime`) for stagger timing assertions.
- Singleton modules need `resetXxxForTests()` called in `test/setup/dom.ts` afterEach.
- E2E specs run on cloud backend (`FRESHELL_E2E_BACKEND=cloud`); use `GCLOUD_ROBOT_HOME` for identity.
- Pre-existing baseline failure: `test/unit/client/components/Sidebar.mobile.test.tsx` (kata ecsx) — not introduced by this work; excluded from the gate pass criterion.

---

### Task 1: Create TerminalCreateStagger module with unit tests

**Files:**
- Create: `src/lib/terminal-create-stagger.ts`
- Test: `test/unit/client/lib/terminal-create-stagger.test.ts`
- Modify: `test/setup/dom.ts:126` (add reset to afterEach)

**Interfaces:**
- Produces: `TerminalCreateStagger` class, `getTerminalCreateStagger()`, `resetTerminalCreateStaggerForTests()` — used by Task 2 in `ws-client.ts`

- [ ] **Step 1: Write the failing behavioral tests**

```typescript
// test/unit/client/lib/terminal-create-stagger.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalCreateStagger,
  getTerminalCreateStagger,
  resetTerminalCreateStaggerForTests,
} from '@/lib/terminal-create-stagger'

describe('TerminalCreateStagger', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetTerminalCreateStaggerForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the first message immediately (no prior send)', () => {
    const stagger = new TerminalCreateStagger()
    const sent: string[] = []
    stagger.enqueue(() => { sent.push('a') })
    vi.advanceTimersByTime(0)
    expect(sent).toEqual(['a'])
  })

  it('spaces subsequent sends by STAGGER_INTERVAL_MS (450ms)', () => {
    const stagger = new TerminalCreateStagger()
    const sent: string[] = []
    stagger.enqueue(() => { sent.push('a') })
    stagger.enqueue(() => { sent.push('b') })
    stagger.enqueue(() => { sent.push('c') })
    vi.advanceTimersByTime(0)
    expect(sent).toEqual(['a'])
    vi.advanceTimersByTime(450)
    expect(sent).toEqual(['a', 'b'])
    vi.advanceTimersByTime(450)
    expect(sent).toEqual(['a', 'b', 'c'])
  })

  it('no two sends land within the same 100ms window', () => {
    const stagger = new TerminalCreateStagger()
    const timestamps: number[] = []
    for (let i = 0; i < 5; i++) {
      stagger.enqueue(() => { timestamps.push(Date.now()) })
    }
    vi.advanceTimersByTime(0)
    vi.advanceTimersByTime(450)
    vi.advanceTimersByTime(450)
    vi.advanceTimersByTime(450)
    vi.advanceTimersByTime(450)
    expect(timestamps).toHaveLength(5)
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i] - timestamps[i - 1]).toBeGreaterThanOrEqual(450)
    }
  })

  it('clear drops all pending sends and resets lastSendAt', () => {
    const stagger = new TerminalCreateStagger()
    const sent: string[] = []
    stagger.enqueue(() => { sent.push('a') })
    stagger.enqueue(() => { sent.push('b') })
    stagger.enqueue(() => { sent.push('c') })
    vi.advanceTimersByTime(0)
    expect(sent).toEqual(['a'])
    stagger.clear()
    vi.advanceTimersByTime(1000)
    expect(sent).toEqual(['a'])
    // After clear(), lastSendAt is reset — next send goes immediately
    stagger.enqueue(() => { sent.push('d') })
    vi.advanceTimersByTime(0)
    expect(sent).toEqual(['a', 'd'])
  })

  it('resetForTests clears pending and resets lastSendAt', () => {
    const stagger = new TerminalCreateStagger()
    const sent: string[] = []
    stagger.enqueue(() => { sent.push('a') })
    vi.advanceTimersByTime(0)
    expect(sent).toEqual(['a'])
    stagger.resetForTests()
    stagger.enqueue(() => { sent.push('b') })
    vi.advanceTimersByTime(0)
    expect(sent).toEqual(['a', 'b'])
  })

  it('getTerminalCreateStagger returns a singleton reset by resetTerminalCreateStaggerForTests', () => {
    const first = getTerminalCreateStagger()
    expect(getTerminalCreateStagger()).toBe(first)
    resetTerminalCreateStaggerForTests()
    expect(getTerminalCreateStagger()).not.toBe(first)
  })

  it('handles enqueue from within a send callback (pump re-entrancy)', () => {
    const stagger = new TerminalCreateStagger()
    const sent: string[] = []
    stagger.enqueue(() => {
      sent.push('a')
      stagger.enqueue(() => { sent.push('b') })
    })
    vi.advanceTimersByTime(0)
    expect(sent).toEqual(['a'])
    vi.advanceTimersByTime(450)
    expect(sent).toEqual(['a', 'b'])
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/lib/terminal-create-stagger.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL because `src/lib/terminal-create-stagger.ts` does not exist (import error).

- [ ] **Step 3: Add the minimal production implementation**

```typescript
// src/lib/terminal-create-stagger.ts

const STAGGER_INTERVAL_MS = 450

/**
 * TerminalCreateStagger — paces `terminal.create` wire sends at a minimum
 * interval of STAGGER_INTERVAL_MS so a client reload/reconnect restoring
 * multiple persisted panes never lands two agent-process spawns within the
 * same ~100ms window (the known OpenCode/Bun concurrent-launch crash,
 * upstream anomalyco/opencode#38366).
 *
 * Sits inside WsClient at the sendNow level — the single wire-level chokepoint
 * that all create paths (direct-ready, held-creates flush, ready-handler
 * flush, reconnect re-send) funnel through. Non-create messages bypass.
 *
 * Mirrors the RebindQueue precedent (src/lib/rebind-queue.ts) which paces
 * freshAgent.create for hidden panes, but operates at the wire level rather
 * than the view level.
 */
export class TerminalCreateStagger {
  private pending: Array<() => void> = []
  private lastSendAt = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  enqueue(send: () => void): void {
    this.pending.push(send)
    this.pump()
  }

  clear(): void {
    this.pending = []
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.lastSendAt = 0
  }

  resetForTests(): void {
    this.clear()
    this.lastSendAt = 0
  }

  private pump(): void {
    if (this.timer !== null || this.pending.length === 0) return
    const elapsed = Date.now() - this.lastSendAt
    const delay = Math.max(0, STAGGER_INTERVAL_MS - elapsed)
    this.timer = setTimeout(() => {
      this.timer = null
      this.lastSendAt = Date.now()
      const next = this.pending.shift()
      if (next) next()
      this.pump()
    }, delay)
  }
}

let singleton: TerminalCreateStagger | null = null

export function getTerminalCreateStagger(): TerminalCreateStagger {
  if (!singleton) singleton = new TerminalCreateStagger()
  return singleton
}

export function resetTerminalCreateStaggerForTests(): void {
  singleton?.clear()
  singleton = null
}
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/lib/terminal-create-stagger.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS (all 7 tests)

- [ ] **Step 5: Refactor while green**

No refactor needed — the module is minimal and focused.

- [ ] **Step 6: Run impacted-test verification**

Add the stagger reset to `test/setup/dom.ts` afterEach (line 126, after `resetTerminalReleaseMarks()`):

```typescript
import { resetTerminalCreateStaggerForTests } from '@/lib/terminal-create-stagger'
// ... in afterEach:
  resetWsClientForTests()
  resetTerminalReleaseMarks()
  resetTerminalCreateStaggerForTests()
```

Run: `npm run test:vitest -- run test/unit/client/lib/terminal-create-stagger.test.ts test/unit/client/lib/rebind-queue.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS (both stagger and rebind-queue suites green; the setup change doesn't break anything).

- [ ] **Step 7: Commit the task**

```bash
git add src/lib/terminal-create-stagger.ts test/unit/client/lib/terminal-create-stagger.test.ts test/setup/dom.ts
git commit -m "feat(ws): add TerminalCreateStagger module for terminal.create wire-send pacing

New module paces terminal.create wire sends at a 450ms minimum interval to
prevent concurrent agent-process launches from crashing OpenCode/Bun on
reload/reconnect (kata rf0v, upstream anomalyco/opencode#38366).

Mirrors the RebindQueue precedent but operates at the WsClient.sendNow wire
level, ensuring the stagger survives the ws-client's internal hold/queue/flush
mechanisms. Includes singleton + resetForTests for test isolation."
```

---

### Task 2: Wire the stagger into WsClient

**Files:**
- Modify: `src/lib/ws-client.ts` (import stagger, add field, route creates, clear on ready)
- Test: `test/unit/client/lib/ws-client.test.ts` (add stagger assertions)
- Test: `test/unit/client/lib/ws-client.reconcile.test.ts` (modify existing tests for setTimeout(0) stagger)

**Interfaces:**
- Consumes: `getTerminalCreateStagger()` from Task 1
- Produces: `WsClient` routes `terminal.create` messages through the stagger at the wire level

- [ ] **Step 1: Write the failing behavioral tests**

Add a test to `test/unit/client/lib/ws-client.test.ts` that asserts `terminal.create` sends are staggered when multiple creates are sent while ready:

```typescript
// Add to test/unit/client/lib/ws-client.test.ts
import { resetTerminalCreateStaggerForTests } from '@/lib/terminal-create-stagger'

describe('WsClient terminal.create stagger', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetTerminalCreateStaggerForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('paces terminal.create sends 450ms apart when multiple are ready', () => {
    // ... setup: create WsClient with a mock WebSocket in 'ready' state
    // ... send 3 terminal.create messages via wsClient.send()
    // ... assert first sent immediately, second after 450ms, third after 900ms
    // ... use the mock WebSocket's sent messages to verify timing
  })

  it('non-create messages bypass the stagger (sent immediately)', () => {
    // ... send a terminal.create then a terminal.input
    // ... assert terminal.create sent at t=0, terminal.input also sent at t=0
    // ... (not delayed behind the create stagger)
  })

  it('clears the stagger on ready (no stale sends from dead socket)', () => {
    // ... enqueue creates, disconnect, reconnect (ready)
    // ... assert stagger was cleared and re-sent creates start fresh
  })

  it('clears the stagger on disconnect — stale timer does NOT fire on replacement socket before ready', () => {
    // 1. Setup: WsClient with mock WebSocket, connect → ready
    // 2. Send a terminal.create (first one fires immediately via setTimeout(0))
    // 3. Send a second terminal.create (queued, timer armed for 450ms)
    // 4. Disconnect the socket (simulate onclose)
    // 5. Connect a replacement mock WebSocket (simulate reconnect, but do NOT deliver ready yet)
    // 6. Advance fake timers by 450ms — the stale timer from step 3 would fire here
    // 7. Assert the replacement socket received ZERO terminal.create messages
    //    (the disconnect clear dropped the pending callback before it could fire)
    // 8. Now deliver the ready frame
    // 9. Assert the create is re-sent through the fresh stagger (via inFlightCreates replay)
  })

  it('cancelCreate retracts a queued create — stagger callback skips the send', () => {
    // 1. Setup: WsClient with mock WebSocket, connect → ready
    // 2. Send 3 terminal.create messages (first sends immediately, 2nd/3rd queued)
    // 3. Call wsClient.cancelCreate(requestId_of_2nd) before the 450ms timer fires
    // 4. Advance fake timers by 450ms — 2nd create's timer fires but skips send
    //    (inFlightCreates no longer has the requestId)
    // 5. Advance fake timers by 450ms — 3rd create sends normally
    // 6. Assert: mock socket received 1st and 3rd creates, NOT 2nd
  })
})
```

The implementer should follow the existing `ws-client.test.ts` patterns for mocking the WebSocket and driving the WsClient through connect→ready→send. See `test/unit/client/ws-client-protocol-reload.test.ts` for the `MockWebSocket` class pattern.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/lib/ws-client.test.ts -t "terminal.create stagger" --config config/vitest/vitest.config.ts`

Expected: FAIL because the stagger is not yet wired into WsClient (all creates sent immediately, no 450ms spacing).

- [ ] **Step 3: Add the minimal production implementation**

In `src/lib/ws-client.ts`:

1. Import the stagger at the top:
```typescript
import { getTerminalCreateStagger, type TerminalCreateStagger } from '@/lib/terminal-create-stagger'
```

2. Add a type guard for `terminal.create` messages (near `isCreateMessage` at line 109):
```typescript
function isTerminalCreateMessage(msg: unknown): boolean {
  if (!msg || typeof msg !== 'object') return false
  return (msg as { type?: unknown }).type === 'terminal.create'
}
```

3. Add the stagger field to the `WsClient` class (near line 164):
```typescript
private terminalCreateStagger: TerminalCreateStagger = getTerminalCreateStagger()
```

4. Add a `sendCreateNow` helper method (near `sendNow` at line 946). This method filters by message type — only `terminal.create` is staggered; `freshAgent.create` and other create-type messages bypass the stagger and send immediately:

```typescript
private sendCreateNow(msg: unknown) {
  if (!isTerminalCreateMessage(msg)) {
    this.sendNow(msg)
    return
  }
  const requestId = (msg as { requestId?: string }).requestId
  this.terminalCreateStagger.enqueue(() => {
    // Guard: cancelCreate may have retracted this create while it was
    // queued in the stagger. If so, skip the send entirely. This preserves
    // the existing cancelCreate → reconcile-verdict-fold contract from
    // App.tsx (lines 1203-1207) where stale create parameters are
    // retracted before the fold-corrected resend.
    if (requestId && !this.inFlightCreates.has(requestId)) return
    this.sendNow(msg)
  })
}
```

5. Route create-related sends through the stagger. At each create-related `sendNow` call site, replace `this.sendNow(msg)` with `this.sendCreateNow(msg)`. Since `sendCreateNow` internally checks `isTerminalCreateMessage`, it is a safe drop-in: `terminal.create` messages are staggered; all others (including `freshAgent.create`) send immediately.

**Line 852** (direct-ready path in `send`): replace `this.sendNow(msg)` with `this.sendCreateNow(msg)`.

**Line 210** (`setReconcilePendingCreates`): replace `this.sendNow(msg)` with `this.sendCreateNow(msg)`.

**Line 231** (`clearReconcileCreateHold`): replace `this.sendNow(msg)` with `this.sendCreateNow(msg)`.

**Line 320** (ready handler non-reconcile flush): replace `this.sendNow(createMsg)` with `this.sendCreateNow(createMsg)`.

**Line 356** (reconnect re-send): replace `this.sendNow(entry.message)` with `this.sendCreateNow(entry.message)`.

Non-create paths (line 341 pendingMessages, line 510 hello, line 750/813 ping, line 898 terminal.interest) keep calling `this.sendNow(...)` directly.

6. Clear the stagger on ALL socket teardown paths AND on each `ready` frame. Between a socket disconnect and the next `ready`, stale timer callbacks from the dead socket can fire and call `sendNow` on the replacement socket (which may already be OPEN but not yet `ready`), reopening the crash window. Clear on both transitions:

**On all socket teardown** — in every path that transitions the connection to a non-ready state: the `onclose` handler, the `onerror` handler, the public `disconnect()` method, AND `abandonStaleSocket()` (which detaches `onclose` before opening a replacement — an `onclose`-only clear would miss it). Add `this.terminalCreateStagger.clear()` to each of these paths.

**On `ready`** — at the beginning of the `ready` block (line 263, right after `if (msg.type === 'ready') {`):
```typescript
      this.terminalCreateStagger.clear()
```

The teardown clear drops stale callbacks that haven't fired yet (covering onclose, onerror, disconnect, and abandonStaleSocket). The ready clear is a belt-and-suspenders defense: if a callback fired between teardown and ready (race window), the ready clear drops any remaining entries before the ready handler flushes/re-sends creates through the fresh stagger.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/lib/ws-client.test.ts -t "terminal.create stagger" --config config/vitest/vitest.config.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Review the call sites for consistency. The `sendCreateNow` helper is the single point that routes through the stagger — verify all five call sites use it correctly and no `terminal.create` message bypasses it.

- [ ] **Step 6: Run impacted-test verification**

The stagger affects ALL tests that send `terminal.create` messages through the ws-client. Run the ws-client suites and the TerminalView lifecycle suites:

Run: `npm run test:vitest -- run test/unit/client/lib/ws-client.test.ts test/unit/client/lib/ws-client.reconcile.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.launchRetry.test.tsx test/unit/client/components/TerminalView.hidden-rebind.test.tsx test/e2e/terminal-create-attach-ordering.test.tsx test/e2e/terminal-restart-recovery.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS. Tests that assert `terminal.create` sends arrive immediately may need to advance fake timers by 450ms to flush the stagger. Do NOT reduce the stagger interval or disable the stagger for tests — the test must accommodate the real behavior.

**Important:** Approximately 6 existing tests in `test/unit/client/lib/ws-client.test.ts` AND several tests in `test/unit/client/lib/ws-client.reconcile.test.ts` send `terminal.create` through the real `WsClient` and assert on `MockWebSocket.instances[N].sent` immediately after `await p` (which flushes microtasks only). The stagger's first send uses `setTimeout(0)` (a macrotask), which does not fire on `await`. These tests need `vi.advanceTimersByTime(0)` (for the first create) or `vi.advanceTimersByTime(450 * N)` (for N creates) added after `await p` and before asserting on `.sent`. The specific tests in `ws-client.test.ts` are: "connect-time queued create flushes after ready" (~line 137), "connect failure then ready flush sends queued create exactly once" (~line 153), "reconnect with unknown terminalId resends in-flight create" (~line 193), "does not resend a create after terminal.created already cleared it" (~line 212), "evicted queued creates" (~line 239), "resends an in-flight create after reconnect" (~line 271). In `ws-client.reconcile.test.ts`: "keeps the legacy replay", "releases creates OUTSIDE the pending set", "without paneReconcileV1 the pre-ready flush is byte-identical", and any other test that flushes creates through the real WsClient. Line numbers may drift; the implementer should identify all tests that send `terminal.create` and assert on `.sent` without advancing timers.

- [ ] **Step 7: Commit the task**

```bash
git add src/lib/ws-client.ts test/unit/client/lib/ws-client.test.ts test/unit/client/lib/ws-client.reconcile.test.ts
git commit -m "feat(ws): route terminal.create through TerminalCreateStagger in WsClient

All terminal.create wire sends now pass through the TerminalCreateStagger
which paces them 450ms apart at the sendNow level — the single wire-level
chokepoint. This catches all paths: direct-ready, held-creates flush,
ready-handler preReadyCreateQueue flush, and reconnect re-send.

Non-create messages (freshAgent.create, terminal.input, etc.) bypass the
stagger entirely. The stagger is cleared on each ready frame to drop stale
entries from a dead socket.

Fixes kata rf0v."
```

---

### Task 3: E2E test — restore stagger invariant on reload

**Files:**
- Modify: `src/lib/test-harness.ts:115-122` (add send timestamps to sentWsMessages)
- Modify: `src/lib/test-harness.ts:57-58` (add getSentWsMessagesWithTimestamps to interface)
- Modify: `src/lib/test-harness.ts:188` (add getSentWsMessagesWithTimestamps implementation)
- Modify: `test/e2e-browser/helpers/test-harness.ts` (add getSentWsMessagesWithTimestamps proxy)
- Create: `test/e2e-browser/specs/restore-create-stagger-rust.spec.ts`

**Interfaces:**
- Consumes: `WsClient` with stagger from Task 2
- Produces: E2E proof that a multi-pane reload spaces terminal.create sends ≥400ms apart

- [ ] **Step 1: Write the failing behavioral test**

Create `test/e2e-browser/specs/restore-create-stagger-rust.spec.ts` following the patterns from `create-protection-restore-storm-rust.spec.ts` and `restore-matrix.spec.ts`. Use `RustServer` from `../helpers/rust-server.js` (NOT `createE2eServerHandle` which does not exist). Register the spec in `RUST_ONLY_SPECS` in `test/e2e-browser/playwright.config.ts`. Seed `panes.defaultNewPane: 'shell'` in the server config so tab-add creates shell terminals directly (the default `'ask'` mode creates picker panes with zero `terminal.create` sends).

```typescript
// test/e2e-browser/specs/restore-create-stagger-rust.spec.ts
import { test, expect } from '../helpers/fixtures.js'
import { RustServer, type TestServerInfo } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
// ... copy per-spec helpers per repo convention (collectLeaves, allLeafTerminalIds,
//     selectShellIfPickerShowing) from existing specs

test.describe('restore create stagger', () => {
  test('multiple persisted terminal panes space terminal.create sends >=400ms on reload', async () => {
    // 1. Start an ephemeral Rust server: new RustServer({ ... }) with server.start()
    // 2. Seed config: setupHome callback sets config.json with
    //    { version: 1, settings: { panes: { defaultNewPane: 'shell' } } }
    //    (matching create-protection-restore-storm-rust.spec.ts:98-105)
    // 3. Open browser, connect, create 5+ terminal panes via tab-add
    // 4. Dismiss the boot tab's picker pane via selectShellIfPickerShowing
    // 5. Persist state (flush localStorage)
    // 6. Capture idsBefore = allLeafTerminalIds() (terminal IDs before restart)
    // 7. Restart the Rust server (server.restartAbrupt()) so panes have no live terminals
    // 8. Reload the page
    // 9. Wait for all panes to anchor with NEW terminal IDs:
    //    poll allLeafTerminalIds() until every pane has a terminalId that is
    //    non-null AND NOT in idsBefore (proves they're fresh creates, not stale
    //    pre-restart IDs — matching create-protection-restore-storm-rust.spec.ts pattern)
    // 10. Read getSentWsMessagesWithTimestamps()
    // 11. Filter for type === 'terminal.create'
    // 12. Assert: at least 2 terminal.create messages were captured (cardinality check)
    // 13. Assert: for every consecutive pair, timestamp[i+1] - timestamp[i] >= 400
    // 14. Assert: all panes eventually anchor (no wedge)
  })
})

// Also modify test/e2e-browser/playwright.config.ts:
// 1. Add /restore-create-stagger-rust\.spec\.ts$/ to RUST_ONLY_SPECS array
//    (excludes it from the match-all chromium project)
// 2. Add /restore-create-stagger-rust\.spec\.ts$/ to the rust-chromium
//    project's testMatch array (the explicit list that DOES collect rust-only specs)
// Both additions are needed — RUST_ONLY_SPECS alone excludes from chromium but
// does NOT include in rust-chromium (which has its own explicit testMatch list).
```

Also modify `src/lib/test-harness.ts` to add timestamps:

```typescript
// Line 115: modify recordSentWsMessage to include a timestamp
const recordSentWsMessage = (msg: unknown) => {
  try {
    const copy = JSON.parse(JSON.stringify(msg))
    ;(copy as { __sentAt?: number }).__sentAt = Date.now()
    sentWsMessages.push(copy)
  } catch {
    ;(msg as { __sentAt?: number }).__sentAt = Date.now()
    sentWsMessages.push(msg)
  }
  if (sentWsMessages.length > 500) sentWsMessages.shift()
}
```

```typescript
// Line 57-58: add to interface
  getSentWsMessagesWithTimestamps?: () => Array<{ __sentAt?: number; type?: string; requestId?: string }>
```

```typescript
// Line 188: modify getSentWsMessages to strip __sentAt (backward compatible)
    getSentWsMessages: () => sentWsMessages.map((msg) => {
      const { __sentAt, ...rest } = msg as { __sentAt?: number }
      return rest
    }),
    getSentWsMessagesWithTimestamps: () => [...sentWsMessages] as Array<{ __sentAt?: number; type?: string; requestId?: string }>,
```

```typescript
// test/e2e-browser/helpers/test-harness.ts: add proxy method
  async getSentWsMessagesWithTimestamps(): Promise<Array<{ __sentAt?: number; type?: string; requestId?: string }>> {
    return this.page.evaluate(() => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      if (!harness) throw new Error('Test harness not installed')
      return harness.getSentWsMessagesWithTimestamps?.() ?? []
    })
  }
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `FRESHELL_E2E_BACKEND=cloud GCLOUD_ROBOT_HOME=$HOME/.codex/skills/gcloud-robot npm run test:e2e -- --grep "restore create stagger"`

Expected: FAIL — the stagger is wired but the test may fail if the e2e harness or spec setup is incorrect. The primary failure to verify: `terminal.create` sends are NOT spaced ≥400ms apart (or the test infrastructure isn't set up yet). If the stagger from Task 2 is working, the test should PASS — if so, verify it FAILS when the stagger is disabled (e.g., by temporarily setting STAGGER_INTERVAL_MS to 0) to confirm the test actually detects the missing behavior.

- [ ] **Step 3: Add the minimal production implementation**

The test-harness timestamp additions (above) are the production code for this task. The e2e spec itself is the test. No additional production code beyond the test-harness changes.

- [ ] **Step 4: Run the focused test**

Run: `FRESHELL_E2E_BACKEND=cloud GCLOUD_ROBOT_HOME=$HOME/.codex/skills/gcloud-robot npm run test:e2e -- --grep "restore create stagger"`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Review the e2e spec for unnecessary complexity. Ensure it follows the per-spec helper convention and doesn't import across spec boundaries.

- [ ] **Step 6: Run impacted-test verification**

The test-harness change (adding `__sentAt` to sentWsMessages) affects all e2e tests that read `getSentWsMessages()`. The `__sentAt` field is additive and should not break existing assertions (they check `msg.type`, `msg.requestId`, etc., not strict equality). Run a sample of existing e2e specs to verify:

Run: `FRESHELL_E2E_BACKEND=cloud GCLOUD_ROBOT_HOME=$HOME/.codex/skills/gcloud-robot npm run test:e2e -- --grep "terminal.create|restore|reconnect"`

Expected: PASS (existing specs unaffected by the additive `__sentAt` field).

- [ ] **Step 7: Commit the task**

```bash
git add src/lib/test-harness.ts test/e2e-browser/helpers/test-harness.ts test/e2e-browser/specs/restore-create-stagger-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): add restore-create-stagger e2e spec and sentWsMessage timestamps

E2E spec persists multiple terminal panes, restarts the server, reloads,
and asserts terminal.create wire sends are spaced >=400ms apart — proving
the TerminalCreateStagger prevents the concurrent-launch crash window on
restore (kata rf0v).

Adds __sentAt timestamps to the test harness sentWsMessages recording so
e2e specs can assert wire-send timing. The field is additive and backward
compatible with existing getSentWsMessages() consumers."
```
