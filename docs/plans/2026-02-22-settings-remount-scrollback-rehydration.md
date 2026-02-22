# Settings Remount Scrollback Rehydration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore terminal scrollback when users navigate away (for example to Settings) and return, without reintroducing the reconnect bandwidth regression.

**Architecture:** Make terminal attach intent explicit and visibility-aware. On remount, only the visible pane should hydrate from `sinceSeq=0`; hidden panes should keep delta replay initially and perform one deferred hydration only when they become visible. On the server side, size replay retention from configured scrollback and harden `ReplayRing` so single oversized frames are truncated and retained instead of being dropped.

**Tech Stack:** React 18 + Redux Toolkit + xterm.js (client), Node/Express + ws + terminal stream broker (server), Vitest (unit + e2e-style tests).

---

## Investigation Summary (Root Cause)

1. Switching to `Settings` replaces the terminal view tree in `src/App.tsx`, so all `TerminalView` instances unmount and xterm in-memory scrollback is lost.
2. Current attach logic in `src/components/TerminalView.tsx` always uses high-water delta (`sinceSeq = max(lastSeq, persistedSeq)`), which is correct for transport reconnect but wrong for fresh xterm remount hydration.
3. Naively forcing `sinceSeq=0` on every remount attach would replay full history for hidden tabs too; because all tab panes mount together, this can recreate the performance regression the refactor was designed to prevent.
4. `ReplayRing` remains fixed at `256KB` by default (`server/terminal-stream/replay-ring.ts`) and is not wired to runtime scrollback settings (`server/terminal-registry.ts`), so moderate detour output can exceed retention and produce `replay_window_exceeded` gaps.
5. `ReplayRing.append` currently evicts whole frames. A single frame larger than budget can evict everything and still leave no replayable data, causing avoidable gap behavior.

---

### Task 1: Add Failing Client Tests for Visibility-Aware Remount Attach

**Files:**
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`

**Step 1: Add a failing visible-remount hydration test**

Add a regression test that unmounts/remounts a visible terminal and asserts remount attach sends `sinceSeq: 0`.

```ts
it('uses sinceSeq=0 when a visible terminal remounts into a fresh xterm viewport', async () => {
  // arrange: mounted running terminal with prior output and cursor > 0
  // act: unmount + remount as visible
  // assert: first remount attach uses sinceSeq: 0
})
```

**Step 2: Add a failing hidden-remount keepalive test**

Add a test that remounts with `hidden={true}` and asserts initial attach remains delta/high-water (not `0`).

```ts
it('keeps hidden remount attach on delta path to avoid replay storms', async () => {
  // arrange: persisted cursor exists
  // act: remount hidden terminal
  // assert: attach sinceSeq > 0 (cursor/high-water), not 0
})
```

**Step 3: Add a failing deferred-hydration-on-visible test**

Add a test for hidden -> visible transition after remount:
- hidden remount uses delta attach,
- first visible transition triggers one hydration attach with `sinceSeq: 0`.

```ts
it('performs one deferred viewport hydration attach when a remounted hidden pane becomes visible', async () => {
  // assert call order: delta attach first, then one sinceSeq=0 attach on visible transition
})
```

**Step 4: Keep warm reconnect contract covered**

Retain/extend existing reconnect tests proving `onReconnect` still uses high-water delta attach.

**Step 5: Run focused tests (expect fail first)**

Run: `npm run test -- test/unit/client/components/TerminalView.lifecycle.test.tsx`

Expected: new remount tests fail before implementation.

**Step 6: Commit failing tests**

```bash
git add test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "test(terminal-view): codify visibility-aware remount attach semantics"
```

---

### Task 2: Implement Client Attach Intent Split with Deferred Hidden-Pane Hydration

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Optional cleanup: `src/lib/terminal-cursor.ts` (only if helper cleanup is needed)

**Step 1: Add explicit attach intents**

```ts
type AttachIntent =
  | 'viewport_hydrate'      // fresh xterm viewport needs replay window
  | 'keepalive_delta'       // hidden remount path to avoid full replay flood
  | 'transport_reconnect'   // websocket reconnect path
```

**Step 2: Track viewport hydration requirement across remount**

Introduce refs that distinguish transport continuity from viewport continuity.

```ts
const needsViewportHydrationRef = useRef(true)
const pendingDeferredHydrationRef = useRef(false)
```

Rules:
- Fresh xterm mount starts with `needsViewportHydrationRef=true`.
- Visible remount hydration clears it.
- Hidden remount keepalive leaves it true and marks deferred hydration pending.

**Step 3: Make attach behavior intent-aware**

```ts
function attach(tid: string, intent: AttachIntent, opts?: { clearViewportFirst?: boolean }) {
  setIsAttaching(true)
  awaitingFreshSequenceRef.current = true

  const persistedSeq = loadTerminalCursor(tid)
  const deltaSeq = Math.max(lastSeqRef.current, persistedSeq)
  const sinceSeq = intent === 'viewport_hydrate' ? 0 : deltaSeq

  if (intent === 'viewport_hydrate') {
    if (opts?.clearViewportFirst) {
      try { termRef.current?.clear() } catch { /* disposed */ }
    }
    lastSeqRef.current = 0
    clearTerminalCursor(tid)
  } else {
    lastSeqRef.current = deltaSeq
  }

  ws.send({ type: 'terminal.attach', terminalId: tid, sinceSeq })
}
```

**Step 4: Wire call sites carefully**

- Initial remount attach:
  - visible pane => `viewport_hydrate`
  - hidden pane => `keepalive_delta`
- `onReconnect` callback => `transport_reconnect`
- Hidden -> visible transition:
  - if `needsViewportHydrationRef` true, send one deferred `viewport_hydrate` attach (`clearViewportFirst: true`).

**Step 5: Ensure hydration completion bookkeeping is correct**

When hydration attach is satisfied (`terminal.output` and/or `terminal.attach.ready` after hydration request), clear deferred flags so we do not repeatedly rehydrate on every visibility toggle.

**Step 6: Run focused client tests**

Run: `npm run test -- test/unit/client/components/TerminalView.lifecycle.test.tsx`

Expected: PASS.

**Step 7: Commit implementation**

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "fix(terminal-view): hydrate only visible remounts and defer hidden-pane replay"
```

---

### Task 3: Add Failing Server Tests for Dynamic Replay Budget and Oversized Frames

**Files:**
- Modify: `test/unit/server/terminal-stream/replay-ring.test.ts`
- Modify: `test/unit/server/ws-handler-backpressure.test.ts`

**Step 1: Add failing runtime resize test**

```ts
it('supports runtime max-byte resize and re-evicts to the new budget', () => {
  const ring = new ReplayRing(1024)
  ring.append('x'.repeat(300))
  ring.append('y'.repeat(300))
  ring.append('z'.repeat(300))

  ring.setMaxBytes(400)

  const replay = ring.replaySince(0)
  const total = replay.frames.reduce((sum, f) => sum + f.bytes, 0)
  expect(total).toBeLessThanOrEqual(400)
})
```

**Step 2: Add failing oversized-frame retention test**

```ts
it('retains truncated tail bytes when a single append exceeds maxBytes', () => {
  const ring = new ReplayRing(8)
  ring.append('0123456789')

  const replay = ring.replaySince(0)
  expect(replay.frames).toHaveLength(1)
  expect(replay.frames[0].seqStart).toBe(1)
  expect(replay.frames[0].bytes).toBeLessThanOrEqual(8)
  expect(replay.missedFromSeq).toBeUndefined()
})
```

**Step 3: Add failing broker test for settings-sized budget**

In `FakeBrokerRegistry`, add budget setter/getter used by broker.

```ts
registry.setReplayRingMaxBytes(1_000_000)
// emit ~400KB output
await broker.attach(wsReplay as any, 'term-replay-budget', 0)
expect(wsReplay.send).not.toHaveBeenCalledWith(expect.stringContaining('"type":"terminal.output.gap"'))
```

**Step 4: Add failing broker test for oversized single frame**

Assert that attaching after one oversized frame yields replay output (truncated frame) and does not emit `replay_window_exceeded`.

**Step 5: Run focused server tests (expect fail first)**

Run:
- `npm run test -- test/unit/server/terminal-stream/replay-ring.test.ts`
- `npm run test -- test/unit/server/ws-handler-backpressure.test.ts`

Expected: FAIL before implementation.

**Step 6: Commit failing tests**

```bash
git add test/unit/server/terminal-stream/replay-ring.test.ts test/unit/server/ws-handler-backpressure.test.ts
git commit -m "test(terminal-stream): lock replay budget + oversized-frame retention behavior"
```

---

### Task 4: Implement Server Replay Budget Wiring and Oversized-Frame Truncation

**Files:**
- Modify: `server/terminal-stream/replay-ring.ts`
- Modify: `server/terminal-stream/broker.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `test/unit/server/terminal-stream/replay-ring.test.ts`
- Modify: `test/unit/server/ws-handler-backpressure.test.ts`

**Step 1: Make ReplayRing budget mutable at runtime**

```ts
setMaxBytes(nextMaxBytes?: number): void {
  this.maxBytes = resolveMaxBytes(nextMaxBytes)
  this.evictIfNeeded()
}
```

If needed, remove `readonly` from `maxBytes`.

**Step 2: Truncate oversized append frames instead of dropping all data**

Add a helper that byte-caps large frame payloads to the tail of the output before insertion.

```ts
private normalizeFrameData(data: string): string {
  // Keep the newest bytes up to maxBytes, preserving replayability for sinceSeq=0 attaches.
}
```

Use normalized data in `append`, then run normal eviction.

**Step 3: Expose replay budget from TerminalRegistry**

```ts
getReplayRingMaxBytes(): number {
  return this.scrollbackMaxChars
}
```

**Step 4: Apply dynamic budget in broker state lifecycle**

- Resolve budget from registry (`getReplayRingMaxBytes` when present).
- Use it in `new ReplayRing(maxBytes)`.
- Re-apply via `state.replayRing.setMaxBytes(maxBytes)` on subsequent attach paths.

**Step 5: Run focused server tests**

Run:
- `npm run test -- test/unit/server/terminal-stream/replay-ring.test.ts`
- `npm run test -- test/unit/server/ws-handler-backpressure.test.ts`

Expected: PASS.

**Step 6: Commit implementation**

```bash
git add server/terminal-stream/replay-ring.ts server/terminal-stream/broker.ts server/terminal-registry.ts test/unit/server/terminal-stream/replay-ring.test.ts test/unit/server/ws-handler-backpressure.test.ts
git commit -m "fix(terminal-stream): size replay budget from scrollback and retain oversized frame tails"
```

---

### Task 5: Add End-to-End Regression for Settings Detour with Hidden Tabs

**Files:**
- Create: `test/e2e/terminal-settings-remount-scrollback.test.tsx`
- Modify (if needed): shared e2e harness files under `test/e2e/`

**Step 1: Write failing e2e scenario for active + hidden panes**

Scenario:
- render app with at least two running terminal tabs,
- emit output for both,
- navigate `terminal -> settings -> terminal`,
- assert active tab remount attach uses `sinceSeq: 0`,
- assert hidden tab remount attach stays on delta,
- switch to hidden tab and assert one deferred hydration attach (`sinceSeq: 0`),
- verify replayed output appears without `replay_window_exceeded` in bounded-history case.

**Step 2: Run test (expect fail first)**

Run: `npm run test -- test/e2e/terminal-settings-remount-scrollback.test.tsx`

Expected: FAIL until implementation is complete.

**Step 3: Stabilize harness timing**

Use deterministic message ordering and RAF/flush patterns (same strategy as existing flaky-network terminal tests).

**Step 4: Re-run and commit**

```bash
git add test/e2e/terminal-settings-remount-scrollback.test.tsx
git commit -m "test(e2e): cover settings remount hydration without hidden-tab replay flood"
```

---

### Task 6: Full Verification, Refactor, and Safe Landing

**Files:**
- Modify: any touched files for cleanup/doc comments

**Step 1: Refactor pass**

- Remove obsolete comments/pathways from old attach logic.
- Keep intent semantics explicit in code comments: visible remount hydration vs hidden keepalive vs transport reconnect.

**Step 2: Run verification in safe order**

Run:
- `npm test`
- `npm run check`

Then run `npm run build` only from a worktree/non-live context (not on the actively served main session).

**Step 3: Merge discipline for main safety**

- In worktree feature branch: merge/rebase latest `main` and resolve there.
- Re-run `npm test` and `npm run build` in that worktree.
- Fast-forward `main` only: `git merge --ff-only <feature-branch>`.

**Step 4: Final cleanup commit (if needed)**

```bash
git add -A
git commit -m "chore(terminal-stream): finalize remount hydration and replay retention hardening"
```

---

## Risks and Guardrails

- Risk: remount hydration floods WS for every hidden pane.
  Guardrail: hidden remounts stay delta; only visible pane hydrates immediately; hidden panes hydrate once on first visibility.
- Risk: deferred hydration duplicates output in hidden pane when it becomes visible.
  Guardrail: clear viewport before deferred hydrate attach and guard with one-shot hydration flag.
- Risk: replay retention still misses after large single append.
  Guardrail: truncate oversized frame data to byte budget rather than evicting to empty.
- Risk: memory growth from larger retention budget.
  Guardrail: derive budget from existing scrollback clamp (`TerminalRegistry.computeScrollbackMaxChars`) and keep min/max bounds.
- Risk: build step disrupts live instance.
  Guardrail: `npm run check` on live session; run `npm run build` in worktree before landing.

---

## Acceptance Criteria

- `terminal -> settings -> terminal` restores visible terminal scrollback within retained history.
- Warm transport reconnect remains delta/high-water and does not duplicate history.
- Initial remount does not full-replay all hidden tabs.
- A remounted hidden tab hydrates history once when first shown.
- Oversized single output frames remain replayable (truncated to budget) rather than causing immediate replay-window gaps.
- `npm test` and `npm run check` pass; `npm run build` passes in worktree before fast-forwarding `main`.
