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

  it('clear drops all pending sends', () => {
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
  singleton?.resetForTests()
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
- Test: `test/unit/client/ws-client-protocol-reload.test.ts` (add stagger assertions)
- Test: `test/unit/client/lib/ws-client.test.ts` (add stagger assertions)

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

4. Add a `sendCreateNow` helper method (near `sendNow` at line 946):
```typescript
private sendCreateNow(msg: unknown) {
  this.terminalCreateStagger.enqueue(() => this.sendNow(msg))
}
```

5. Route `terminal.create` sends through the stagger. At each create-related `sendNow` call site, replace `this.sendNow(msg)` with a check:

**Line 852** (direct-ready path in `send`): the message could be any type. Replace:
```typescript
      this.sendNow(msg)
```
with:
```typescript
      if (isTerminalCreateMessage(msg)) {
        this.sendCreateNow(msg)
      } else {
        this.sendNow(msg)
      }
```

**Line 210** (`setReconcilePendingCreates`): these are always create messages from `heldCreates`. Replace `this.sendNow(msg)` with `this.sendCreateNow(msg)`.

**Line 231** (`clearReconcileCreateHold`): these are always create messages. Replace `this.sendNow(msg)` with `this.sendCreateNow(msg)`.

**Line 320** (ready handler non-reconcile flush): these are always create messages from `preReadyCreateQueue`. Replace `this.sendNow(createMsg)` with `this.sendCreateNow(createMsg)`.

**Line 356** (reconnect re-send): these are always create messages from `inFlightCreates`. Replace `this.sendNow(entry.message)` with `this.sendCreateNow(entry.message)`.

6. Clear the stagger on each `ready` frame. At the beginning of the `ready` block (line 263, right after `if (msg.type === 'ready') {`):
```typescript
      this.terminalCreateStagger.clear()
```

This ensures stale entries from a dead socket are dropped before the ready handler flushes/re-sends creates through the fresh stagger.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/lib/ws-client.test.ts -t "terminal.create stagger" --config config/vitest/vitest.config.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Review the call sites for consistency. The `sendCreateNow` helper is the single point that routes through the stagger — verify all five call sites use it correctly and no `terminal.create` message bypasses it.

- [ ] **Step 6: Run impacted-test verification**

The stagger affects ALL tests that send `terminal.create` messages through the ws-client. Run the ws-client suites and the TerminalView lifecycle suites:

Run: `npm run test:vitest -- run test/unit/client/lib/ws-client.test.ts test/unit/client/lib/ws-client-protocol-reload.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.launchRetry.test.tsx test/unit/client/components/TerminalView.hidden-rebind.test.tsx test/e2e/terminal-create-attach-ordering.test.tsx test/e2e/terminal-restart-recovery.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS. Tests that assert `terminal.create` sends arrive immediately may need to advance fake timers by 450ms to flush the stagger. If any existing test fails because it expects an immediate `terminal.create` but the stagger delays it, advance the test's fake timers by `STAGGER_INTERVAL_MS` (450) to flush the send. Do NOT reduce the stagger interval or disable the stagger for tests — the test must accommodate the real behavior.

- [ ] **Step 7: Commit the task**

```bash
git add src/lib/ws-client.ts test/unit/client/lib/ws-client.test.ts
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

Create `test/e2e-browser/specs/restore-create-stagger-rust.spec.ts` following the patterns from `create-protection-restore-storm-rust.spec.ts` and `restore-matrix.spec.ts`:

```typescript
// test/e2e-browser/specs/restore-create-stagger-rust.spec.ts
import { test, expect } from '@playwright/test'
import { createE2eServerHandle } from '../helpers/e2e-server'
// ... copy per-spec helpers per repo convention (collectLeaves, allLeafTerminalIds,
//     selectShellIfPickerShowing) from existing specs

test.describe('restore create stagger', () => {
  test('multiple persisted terminal panes space terminal.create sends >=400ms on reload', async () => {
    // 1. Start an ephemeral Rust server (createE2eServerHandle, rust-only)
    // 2. Open browser, connect, create 5+ terminal panes (shell mode for simplicity)
    // 3. Persist state (flush localStorage)
    // 4. Restart the Rust server (so panes have no live terminals)
    // 5. Reload the page
    // 6. Wait for all panes to anchor (allLeafTerminalIds)
    // 7. Read getSentWsMessagesWithTimestamps()
    // 8. Filter for type === 'terminal.create'
    // 9. Assert: for every consecutive pair, timestamp[i+1] - timestamp[i] >= 400
    // 10. Assert: all panes eventually anchor (no wedge)
  })
})
```

The implementer should follow the existing spec patterns: use `createE2eServerHandle` for an ephemeral Rust server, `TestHarness` for the browser interaction, and per-spec-copied helpers (`collectLeaves`, `allLeafTerminalIds`, `selectShellIfPickerShowing`) per the repo convention (specs copy helpers, don't import across spec boundaries).

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
// Line 188: add implementation (after getSentWsMessages)
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
git add src/lib/test-harness.ts test/e2e-browser/helpers/test-harness.ts test/e2e-browser/specs/restore-create-stagger-rust.spec.ts
git commit -m "test(e2e): add restore-create-stagger e2e spec and sentWsMessage timestamps

E2E spec persists multiple terminal panes, restarts the server, reloads,
and asserts terminal.create wire sends are spaced >=400ms apart — proving
the TerminalCreateStagger prevents the concurrent-launch crash window on
restore (kata rf0v).

Adds __sentAt timestamps to the test harness sentWsMessages recording so
e2e specs can assert wire-send timing. The field is additive and backward
compatible with existing getSentWsMessages() consumers."
```
