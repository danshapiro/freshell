# Dead-Session In-Pane Notice (No Modal) Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
- Freshell no longer shows the blocking "Dead sessions" modal dialog (DeadSessionPanel) on login/reconnect; a terminal pane whose saved session was deleted instead gets one notice line in its stale terminal buffer, and the user resolves it with existing pane chrome (close button; +/split, Replace pane, Reopen pane as for a fresh start).

### Explicit constraints
- No new in-pane UI components or actions (no cards, no new buttons) — existing pane chrome only.
- Fresh-agent panes keep their existing restoreError banner behavior.
- Keep the per-pane restoreError latch and keep auto-recovery stood down for dead sessions (no duplicate resume attempts); re-key TerminalView's stand-down gate from the deadSessionAdjudication list to that latch.
- Server side unchanged (verdicts, typed SESSION_MISSING refusal, pane ledger stay as-is) — client-only change.
- No auto-close: nothing closes the pane without an explicit user action.
- TDD red/green/refactor with unit and e2e coverage.

### Accepted tradeoffs and residuals
- Dead panes in background tabs no longer announce themselves beyond the existing tab status icon (explicit user product direction).
- The modal's "Start fresh here"/"Close pane" buttons go away; equivalent outcomes via existing pane affordances.

**Goal:** A terminal pane whose saved session was deleted from disk explains itself with one line in its own xterm buffer instead of raising a blocking modal on every login/reconnect; every existing safety guarantee (no auto-close, no silent substitution, no duplicate resume PTYs, typed refusals) is preserved.

**Architecture:** Delete the `DeadSessionPanel` modal component and the whole `deadSessionAdjudication` store slice (state, reducers, fold batching, App clear branch) — the per-pane persisted `restoreError` latch (`durable_artifact_missing`) becomes the single dead-session state. TerminalView re-keys its INVALID_TERMINAL_ID recovery stand-down gate from the (deleted) adjudication list to that latch, and gains one effect that writes a single `writeLocalXtermNotice` line into the pane's stale buffer, exactly once per dead adjudication (ref-latch idempotency, re-armed when the latch clears). Fresh-agent panes change nothing (their existing banner already reads the latch). All four `foldVerdicts` call sites keep dispatching `setPaneRestoreError`; only the entry accumulation and batch dispatch go away. Server code is untouched.

**Tech Stack:** React 18 + Redux Toolkit (src/store, src/components), xterm.js local notice idiom (`writeLocalXtermNotice`), Vitest (test/unit/client), Playwright against the real Rust server (test/e2e-browser). pnpm 10.34.5 only.

## Global Constraints

- **Client-only.** No changes under `crates/` — server verdicts, the typed `SESSION_MISSING` refusal, and the pane ledger are frozen. (Server test comments that mention the client dialog stay as-is; do not "fix" them, that would touch Rust and drag the required rust-gate.)
- **No new in-pane UI.** The only new presentation is the xterm notice line (buffer text). No new components, buttons, cards, banners, roles, or DOM nodes in the pane.
- **Fresh-agent panes:** zero behavior change. `FreshAgentView` is not modified.
- **Council rule 12 preserved:** dead_session remains UI state, not a deletion — nothing auto-closes; every pane waits for an explicit user action through existing chrome.
- **Reducer contracts preserved:** `resetPaneForReconcileCreate` / `resetFreshAgentPaneForReconcileCreate` / `setPaneRestoreError` / attach folds are not modified (their existing dispatchers — pane chrome, stuck card, failure card, exit banner, verdict folds — keep working; only the modal's dispatches disappear).
- **TDD per task:** red → green → refactor; never delete or weaken an unrelated passing test; every rewritten test must still run the behavior it protects.
- **Focused test commands** (narrowed selectors are coordinator-delegated; they do not hold the shared gate):
  - Unit: `pnpm run test:vitest run <paths...> --config config/vitest/vitest.config.ts`
  - Typecheck (no-write): `pnpm run typecheck:client`
  - Lint: `pnpm run lint`
  - E2e (final verification, cloud backend is the configured default): `FRESHELL_E2E_BACKEND=cloud pnpm run test:e2e:cloud <spec files>` — affected specs must actually run and pass there (a spec that matches nothing or sits in `CLOUD_SKIP_SPECS` is not coverage).
- **Baseline flakes (pre-existing, receipted):** `freshell-supervisor` `claude_source_observation` nested-source-reply test (kata arnn; passes isolated in 0.47s) and `test/integration/providers/claude-permission-contract.test.ts` cleanup race (kata bczx). If exactly these fail at a gate, attribute per the baseline receipts in the run record; anything else is this run's to fix.
- **Impacted broad gate:** this is a client-only change; the final full-suite gate goes through the shared coordinator (`pnpm run check` from the worktree) once at end of execution.
- `docs/index.html` does not model the modal (verified) — no mock update needed. Historical plans under `docs/plans/` are history; do not edit them.
- Companion exploration reports (authoritative line-number inventories; read before editing):
  - `.worktrees/.the-usual-logs/dead-session-no-modal/reports/dead-session-adjudication-map.md`
  - `.worktrees/.the-usual-logs/dead-session-no-modal/reports/terminal-notice-pattern.md`
  - `.worktrees/.the-usual-logs/dead-session-no-modal/reports/dead-session-test-landscape.md`

---

### Task 1: Re-key TerminalView's dead-session stand-down gate to the restoreError latch

The INVALID_TERMINAL_ID auto-recovery lane must stand down for a pane whose durable session artifact is gone, keyed on the pane's own persisted `restoreError` latch instead of the (soon-deleted) adjudication list. Narrow key: `reason === 'durable_artifact_missing'` only — other restoreError reasons (e.g. `dead_live_handle`) must NOT stand down, preserving today's recovery for launch-failure shapes.

**Files:**
- Modify: `src/components/TerminalView.tsx:709-719` (delete the `isDeadSessionAdjudicated` selector + ref mirror), `:6690-6701` (rewrite the stand-down gate + its invariant-7 comment)
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx:2368-2408` (re-key the stand-down test), new negatives beside it
- Test: `test/unit/client/components/TerminalView.codex-identity.test.tsx` (new second-round breadcrumb pin)

**Interfaces:**
- Consumes: pane content `restoreError: RestoreError` (mirrored into a render-body ref exactly like the deleted `isDeadSessionAdjudicatedRef` — see Step 3).
- Produces: none (internal gate); deletes the module's only read of `s.panes.deadSessionAdjudication`.

- [ ] **Step 1: Write the failing behavioral test (re-key the existing pin)**

In `TerminalView.lifecycle.test.tsx`, rewrite `does not auto-recover from INVALID_TERMINAL_ID while the pane awaits dead-session adjudication` (`:2368`, built by `setupReconcileOwnedPane(panesExtra)`, `:2313-2366`):

```tsx
it('does not auto-recover from INVALID_TERMINAL_ID while the pane holds a dead-session restoreError latch', async () => {
  // Seed the latch on the pane CONTENT (not the adjudication list):
  // adapt setupReconcileOwnedPane so the claude-mode leaf content carries
  //   restoreError: buildRestoreError('durable_artifact_missing')
  // (import { buildRestoreError } from '@shared/session-contract').
  // Keep the rest of the fixture identical: durable sessionRef, live terminalId, status 'running'.
  const harness = setupReconcileOwnedPaneWithLatch() // adapted helper
  harness.emitInvalidTerminalId() // existing INVALID_TERMINAL_ID emission (:2391-2398)
  // Keep every existing assertion verbatim (:2400-2407):
  // - createRequestId unchanged, terminalId kept, status stays 'running'
  // - ZERO terminal.create frames sent (no duplicate --resume of the dead session)
})
```

Add the negative in the same describe (proves the gate is narrow, not any-restoreError):

```tsx
it('still auto-recovers from INVALID_TERMINAL_ID for a non-dead restoreError reason (dead_live_handle)', async () => {
  // Same fixture shape but content.restoreError = buildRestoreError('dead_live_handle').
  // Expect the OPPOSITE: the recovery create IS minted
  // (createRequestId changes / terminal.create sent / status 'creating') —
  // mirroring the existing 'starts explicit fresh recovery for a live-only
  // INVALID_TERMINAL_ID reconnect' test (:6786-6790 comment) when no sessionRef
  // is recoverable, or the resume-recovery path when one is.
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx --config config/vitest/vitest.config.ts`

Expected: FAIL — the latch-seeded pane still auto-recovers (today the gate keys on the empty adjudication list), so `terminal.create` IS sent; and the `dead_live_handle` negative passes vacuously until the gate exists (run both; the first is the red one).

- [ ] **Step 3: Add the minimal production implementation**

In `src/components/TerminalView.tsx`:

1. Delete the selector + ref mirror at `:709-719` (`isDeadSessionAdjudicated`, `isDeadSessionAdjudicatedRef`, and their assignments).
2. Replace them with a render-body ref mirror of the pane's own latch (identical freshness to the deleted mirror — assigned during render, not effect-synced like `contentRef`, so no fold-to-gate lag window):

```tsx
// Dead-session stand-down latch (design invariant 7, re-keyed to the
// durable restoreError latch): a pane whose saved session artifact is gone
// must not mint a recovery create on an INVALID_TERMINAL_ID round — that
// would resume the dead session as an orphan PTY nothing adopts
// (duplicate `--resume <dead-session>` spawns after a restart). The
// persisted per-pane latch is strictly more accurate than the old
// adjudication list: per-pane and reload-surviving, and cleared exactly by
// the recovery folds (attach/reset), which re-arms auto-recovery the
// moment the pane legitimately moves on. Other restoreError reasons
// (dead_live_handle etc.) keep today's auto-recovery.
const deadSessionLatchRef = useRef(false)
deadSessionLatchRef.current =
  terminalContent?.restoreError?.reason === 'durable_artifact_missing'
```

3. Replace the gate at `:6701` with `if (deadSessionLatchRef.current) return`.

- [ ] **Step 4: Run the focused test**

Run: `pnpm run test:vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

None — load-bearing validation showed the planned "second-round codex breadcrumb" pin is vacuous (post-mint the pane has no terminalId, so the gated sub-branch — which requires `currentTerminalId && status !== 'exited'` — is unreachable; validator LB9, reports/load-bearing-validator-lb1.md context). Do not add it. The `dead_live_handle` negative from Step 1 is the reachable delimiting pin.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: TerminalView suites that exercise the INVALID_TERMINAL_ID lane and restoreError-carrying fixtures — `TerminalView.lifecycle.test.tsx`, `TerminalView.session-reserved.test.tsx`, `TerminalView.codex-identity.test.tsx`, `TerminalView.resumeSession.test.tsx` (delimiting tests `:2904`, `:3002`, `:3380`, `:3425` must stay green), plus `test/e2e/terminal-create-attach-ordering.test.tsx`.

Run: `pnpm run test:vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.session-reserved.test.tsx test/unit/client/components/TerminalView.codex-identity.test.tsx test/unit/client/components/TerminalView.resumeSession.test.tsx test/e2e/terminal-create-attach-ordering.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS (note: `TerminalView.session-reserved.test.tsx:402` still asserts the adjudication list — it stays green here because the state still exists; Task 4 removes that assert.)

- [ ] **Step 7: Commit the task**

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.codex-identity.test.tsx
git commit -m "feat(terminal): stand down INVALID_TERMINAL_ID recovery on the dead-session restoreError latch"
```

---

### Task 2: Dead-session notice line in the terminal pane's buffer

One `writeLocalXtermNotice` line, exactly once per dead adjudication per mount, into the pane's own stale xterm buffer. Re-arms when the latch clears (user resolved the pane); survives reconnect re-adjudication via a ref key.

**Keying (load-bearing-validated, LB1):** the notice must NOT key on raw `restoreError` — `durable_artifact_missing` is also minted on LIVE panes by the codex dead-live-handle recovery breadcrumb (`TerminalView.tsx:6792`, pane goes live with the latch persisted) and the server-folded `terminal.created` restoreError (`:5842`, pinned live by `test/e2e/codex-refresh-rehydrate-flow.test.tsx:556-577`). Instead the fold's terminal `dead_session` arm additionally mints the existing one-shot store field `reconcileNotice` with a dedicated dead copy — a signal no other producer can mint — and the effect consumes exactly that copy, then clears it (preventing both anchor double-writes and a stale copy riding `resetPaneForReconcileCreate` into the user's fresh pane via the `terminal.created` anchor). The fresh-agent dead arm does NOT mint the notice (FreshAgentView renders `reconcileNotice` as a 5-second transient status — an in-pane UI change the request forbids; fresh-agent panes keep their banner only). `reconcileNotice` is persistence-stripped (`persistMiddleware.ts:297`), so in the reload shape the notice arrives after the boot reconcile re-folds the verdict — not at mount; the reload-shape test reflects that timing.

**Files:**
- Modify: `src/lib/pane-reconcile.ts` (terminal dead arm `:556-574`: add the `setPaneReconcileNotice` dispatch beside the existing `setPaneRestoreError`; export the copy constant)
- Modify: `src/components/TerminalView.tsx` (new const + consume effect, placed immediately AFTER the "Init xterm once" effect block that ends at `:3162` — declaration order guarantees `termRef.current` is set for mount-time runs; the effect needs no term for the reload shape because the mint arrives post-reconcile)
- Test: `test/unit/client/components/TerminalView.session-reserved.test.tsx` (`:340` exhaustion test gains the notice assertions — the only unit test driving a real dead_session verdict end-to-end through TerminalView's own reconcile requester)
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx` (exactly-once, re-arm, reload-shape pins)

**Interfaces:**
- Consumes: `writeLocalXtermNotice(term, data)` (`TerminalView.tsx:1652`, caller frames `\r\n`), `setPaneReconcileNotice` / `clearPaneReconcileNotice` (existing actions), `shouldWaitForProviderBehavior`, `termRef`.
- Produces:
  - `export const DEAD_SESSION_RECONCILE_NOTICE = 'Saved session no longer exists on disk.'` in `src/lib/pane-reconcile.ts` (the fold-minted store-field copy — matched exactly, so the `invalid`-arm and reset notices can never trigger the effect);
  - `const DEAD_SESSION_BUFFER_NOTICE = "[This pane's saved session no longer exists on disk - close this pane or start a new one]"` (module-level const in TerminalView.tsx — the xterm line; unit and e2e tests pin this literal).

- [ ] **Step 1: Write the failing behavioral tests**

In `TerminalView.session-reserved.test.tsx`, extend `exhaustion auto-resolves via a single-pane reconcile — never a wedge` (`:340`, which folds a server `dead_session{session_file_missing}` verdict at `:386-398`):

```tsx
// After the existing restoreError assertion (:401), add:
// - exactly ONE xterm write containing the DEAD_SESSION_BUFFER_NOTICE line,
//   CRLF-framed: `\r\n[This pane's saved session no longer exists on disk - close this pane or start a new one]\r\n`
//   (use the suite's write-capture helper pattern; see the reconcileNotice
//   one-shot test :434 and terminalWriteStrings in TerminalView.lifecycle.test.tsx:324)
// - content.reconcileNotice is CLEARED after the write (consumed one-shot)
```

In `TerminalView.lifecycle.test.tsx`, add a focused describe (fixture donor: the Task-1 latch-seeded helper; simulate the fold by dispatching `setPaneRestoreError(...)` + `setPaneReconcileNotice({ ..., notice: DEAD_SESSION_RECONCILE_NOTICE })` together, exactly what the fold does):

```tsx
describe('dead-session notice line', () => {
  it('consumes the dead reconcileNotice copy and writes the buffer line once', async () => {
    // Latch + mint. Assert exactly one DEAD_SESSION_BUFFER_NOTICE write
    // and reconcileNotice cleared.
  })
  it('a re-fold (fresh restoreError + fresh notice copy, same session identity) does not rewrite', async () => {
    // Fold the SAME identity again (App's every-ready round does exactly
    // this on each reconnect — new object identities each time).
    // Assert the write count is STILL one (ref key absorbs), and the copy
    // was consumed (cleared) again — no stale field rides a reset.
  })
  it('re-arms after the latch clears', async () => {
    // Latch + mint → one write. Clear the latch (fold an attach/reset that
    // clears restoreError) → ref resets. Re-latch + re-mint for the NEW
    // identity → a SECOND write lands (count two).
  })
  it('reload shape: the persisted latch alone writes nothing; the boot re-fold mints and writes once', async () => {
    // Preload pane content with ONLY the persisted restoreError (no
    // terminalId, no reconcileNotice — it is persistence-stripped). Mount:
    // assert NO write yet. Then simulate the boot reconcile verdict fold
    // (latch + notice mint). Assert exactly one write. (Do NOT assert on
    // terminal.create frames here — the mount create path is ungated by
    // design and governed by the reconcile pending-window, not this effect.)
  })
  it('ignores non-dead reconcileNotice copies (invalid verdict)', async () => {
    // Mint the invalid-arm notice text instead. Assert NO buffer write of
    // the dead line.
  })
})
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/client/components/TerminalView.session-reserved.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx --config config/vitest/vitest.config.ts`

Expected: FAIL — no notice is written today (TerminalView renders nothing from `restoreError`, and the fold mints no dead `reconcileNotice`).

- [ ] **Step 3: Add the minimal production implementation**

In `src/lib/pane-reconcile.ts` (module scope):

```ts
/**
 * Dead-session verdict copy minted (terminal arm only) onto the pane's
 * one-shot reconcileNotice field. Matched EXACTLY by TerminalView's notice
 * effect; no other producer may mint this string. Fresh-agent dead arms do
 * NOT mint it (FreshAgentView would render it as a transient status).
 */
export const DEAD_SESSION_RECONCILE_NOTICE = 'Saved session no longer exists on disk.'
```

In the terminal `dead_session` arm (`:556-574`), beside the existing `setPaneRestoreError` dispatch:

```ts
dispatch(setPaneReconcileNotice({
  tabId,
  paneId,
  notice: DEAD_SESSION_RECONCILE_NOTICE,
}))
```

In `src/components/TerminalView.tsx` (module scope, near the other notice copy constants):

```tsx
/** One-line explanation a dead terminal pane writes into its own buffer. */
const DEAD_SESSION_BUFFER_NOTICE =
  "[This pane's saved session no longer exists on disk - close this pane or start a new one]"
```

Inside the component, after the init-xterm effect (after `:3162`):

```tsx
// Dead-session notice (replaces the removed DeadSessionPanel modal). The
// fold's terminal dead_session arm mints the one-shot reconcileNotice
// dead copy (the persisted restoreError latch alone cannot discriminate
// dead verdicts from live-recovery mints — see the run's load-bearing
// validator LB1). Consume-and-clear the copy unconditionally (it must not
// ride a reset into a fresh pane via the terminal.created anchor), then
// write the buffer line exactly once per dead adjudication per mount via
// the ref key. Declared AFTER the init-xterm effect so termRef is set for
// mount-adjacent runs; the shouldWaitForProviderBehavior dep covers an
// opencode pane whose surface mounts late.
const deadSessionNoticeKeyRef = useRef<string | null>(null)
useEffect(() => {
  const content = terminalContent
  if (!content) return
  if (content.reconcileNotice !== DEAD_SESSION_RECONCILE_NOTICE) return
  dispatch(clearPaneReconcileNotice({ tabId, paneId })) // consume one-shot
  const key = `${content.createRequestId ?? ''}|${content.sessionRef?.sessionId ?? '-'}`
  if (deadSessionNoticeKeyRef.current === key) return // re-fold: announced already
  deadSessionNoticeKeyRef.current = key
  const term = termRef.current
  if (!term) return // surface not mounted yet (rare provider-wait edge): line dropped this mount
  writeLocalXtermNotice(term, `\r\n${DEAD_SESSION_BUFFER_NOTICE}\r\n`)
}, [
  terminalContent?.reconcileNotice,
  terminalContent?.createRequestId,
  terminalContent?.sessionRef?.sessionId,
  shouldWaitForProviderBehavior,
  writeLocalXtermNotice,
  dispatch,
])
```

(Re-arm: when the latch clears via an attach/reset fold, the pane identity changes with it — a later dead adjudication of the new identity mints a new copy with a new key and writes again. `clearPaneReconcileNotice` is already imported by the anchor consumers.)

- [ ] **Step 4: Run the focused tests**

Run: `pnpm run test:vitest run test/unit/client/components/TerminalView.session-reserved.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/lib/pane-reconcile.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

None expected — the effect is additive and self-contained. The `[Resume failed]` refusal line (`:6512`) and `[Restore failed]` arm (`:6596`) stay as-is: in the reload shape the verdict line and the server's typed-refusal line legitimately stack and read coherently.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: all TerminalView unit suites + the React-level e2e restore suites that assert on xterm write strings, plus the fold suite.

Run: `pnpm run test:vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.session-reserved.test.tsx test/unit/client/components/TerminalView.codex-identity.test.tsx test/unit/client/components/TerminalView.resumeSession.test.tsx test/unit/client/components/TerminalView.launchRetry.test.tsx test/unit/client/lib/pane-reconcile.test.ts test/e2e/terminal-create-attach-ordering.test.tsx test/e2e/codex-refresh-rehydrate-flow.test.tsx test/e2e/terminal-restart-recovery.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/components/TerminalView.tsx src/lib/pane-reconcile.ts test/unit/client/components/TerminalView.session-reserved.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "feat(terminal): dead-session panes explain themselves with one in-buffer notice line"
```

---

### Task 3: Remove the DeadSessionPanel modal component and its mount

The modal goes away. The adjudication state stays (inert) until Task 4 — this keeps the slice compile-closed and independently reviewable.

**Files:**
- Delete: `src/components/DeadSessionPanel.tsx`
- Modify: `src/App.tsx:95` (import), `:2551` (mount)
- Delete: `test/unit/client/components/DeadSessionPanel.test.tsx` (modal tests die with the component)
- Create: `test/unit/client/components/ReconcileWarmingBanner.test.tsx` (new home for the 3 warming tests that lived in the deleted suite — `N warming panes produce exactly ONE banner with the count` `:271`, `Retry now re-sends a reconcile request for exactly the warming panes` `:278`, `Retry folds only its own reconcile result, skipping foreign reconcileIds` `:288`; ReconcileWarmingBanner has no other test file)
- Modify: `test/unit/client/components/App.machine-identity.test.tsx:39`, `test/unit/client/components/App.inventory-title-fold.test.tsx:31` (remove the `vi.mock('@/components/DeadSessionPanel', …)` lines — a vi.mock of a deleted module breaks the suite)

**Interfaces:**
- Consumes: none.
- Produces: no `DeadSessionPanel` anywhere in src/ or unit tests; `deadSessionAdjudication` state remains but is unread by any component.

- [ ] **Step 1: Write the failing behavioral test**

In `test/unit/client/components/App.reconcile-adoption.test.tsx` (real App render, no DeadSessionPanel mock — it already doesn't mock it), add:

```tsx
it('renders no dead-sessions dialog even when adjudication state is populated', async () => {
  // Boot the App harness as the existing tests do, dispatch
  // setDeadSessionAdjudication([{tabId, paneId, title: 'x', mode: 'claude'}])
  // (the state still exists in this task), then assert:
  //   screen.queryByRole('dialog', { name: 'Dead sessions' }) === null
  // Red today: the modal renders.
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/client/components/App.reconcile-adoption.test.tsx --config config/vitest/vitest.config.ts`

Expected: FAIL — the dialog renders today.

- [ ] **Step 3: Add the minimal production implementation**

1. Create `test/unit/client/components/ReconcileWarmingBanner.test.tsx`: copy the three warming tests from `DeadSessionPanel.test.tsx` (`:271-310` region) verbatim, dropping the `<DeadSessionPanel />` sibling from the render (render only `<ReconcileWarmingBanner />` with the same store seeding helper).
2. Delete `test/unit/client/components/DeadSessionPanel.test.tsx`.
3. Delete `src/components/DeadSessionPanel.tsx`.
4. In `src/App.tsx`: remove the import (`:95`) and the `<DeadSessionPanel />` mount (`:2551`). Leave the `clearDeadSessionAdjudication` import/call alone (Task 4).
5. Remove the two `vi.mock('@/components/DeadSessionPanel', …)` lines.

- [ ] **Step 4: Run the focused tests**

Run: `pnpm run test:vitest run test/unit/client/components/App.reconcile-adoption.test.tsx test/unit/client/components/ReconcileWarmingBanner.test.tsx test/unit/client/components/App.machine-identity.test.tsx test/unit/client/components/App.inventory-title-fold.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS (the new no-dialog test green; warming tests green in their new home; the two App suites green without the mocks).

- [ ] **Step 5: Refactor while green**

`pnpm run typecheck:client` and `pnpm run lint` must be clean (catches dangling imports).

- [ ] **Step 6: Run impacted-test verification**

Impacted set: every suite that imported or mocked the component — the four above, plus the store suites that render App-level reducers (they don't render the panel). Run the client component tree broadly:

Run: `pnpm run test:vitest run test/unit/client/components --config config/vitest/vitest.config.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add -A src/components/DeadSessionPanel.tsx src/App.tsx test/unit/client/components/DeadSessionPanel.test.tsx test/unit/client/components/ReconcileWarmingBanner.test.tsx test/unit/client/components/App.machine-identity.test.tsx test/unit/client/components/App.inventory-title-fold.test.tsx test/unit/client/components/App.reconcile-adoption.test.tsx
git commit -m "feat(ui): remove the auto-raised DeadSessionPanel modal"
```

(`git add -A` on the deleted path stages the deletion.)

---

### Task 4: Remove the deadSessionAdjudication store state and its producers

The store slice, fold batching, and App clear branch go away; the persisted per-pane `restoreError` latch is the single dead-session state.

**Files:**
- Modify: `src/store/paneTypes.ts` (`:626-640` delete `DeadSessionEntry` type; `:707-711` delete the `PanesState` field)
- Modify: `src/store/panesSlice.ts` (`:12` type import; `:2913-2927` three reducers; `:3077-3079` exports; `:490`,`:512` initial state; `:1324` `clearPanesForMachine`; `:2239` `hydratePanes`)
- Modify: `src/store/persistMiddleware.ts:681` (remove the `deadSessionAdjudication: _dsa` destructure-strip — a TS error surfaces once the field leaves `PanesState`)
- Modify: `src/lib/pane-reconcile.ts` (`:25` `DeadSessionEntry` import; `:35` `setDeadSessionAdjudication` import; `:323` `foldFreshAgentVerdict`'s `deadEntries: DeadSessionEntry[]` PARAMETER — outside the arm ranges, easy to miss; `:499` accumulator; `:557-564` terminal push; `:384-392` fresh-agent push; `:620-623` tail batch; `:291-304` delete `deadSessionTitle`; `:267` delete `FoldOutcome.dead`; `:398`,`:573` delete `outcome.dead++` — keep `folded = true` so `onVerdictFolded` still fires for dead panes, which App's held-create retract depends on. The Task-2 dead-copy `setPaneReconcileNotice` mint in the terminal arm STAYS.)
- Modify: `src/App.tsx:112` (import) and `:1565-1567` (delete the `outcome.dead === 0 → clear` branch; its whole reason — dismissing a batched dialog on a clean round — is gone; the latch clears itself via the attach/reset folds)
- Test updates (dead-session expects/mocks removed, warming halves kept): `test/unit/client/lib/pane-reconcile.test.ts` (`:316` expect in the routing test; `:367-374` batching test re-keyed), `test/unit/client/lib/pane-reconcile.fresh-agent.test.ts` (`:358-374` split: restoreError asserts stay), `test/unit/client/store/panesSlice.reconcile.test.ts` (`:290-302` reducer trio test deleted; `:342-377` persistence test keeps the per-pane volatile strip expects, drops the two adjudication expects), `test/unit/client/store/panesSlice.fresh-agent-reconcile.test.ts` (`:488/:510` anchor expect removed), `test/unit/client/components/App.reconcile-adoption.test.tsx` (`:546` dead half dropped, warming half kept; ALSO delete Task 3's added no-dialog test — its premise dispatches the deleted action; the no-dialog contract is pinned from here on by e2e + the component's absence), `test/unit/client/components/TerminalView.session-reserved.test.tsx:402` (drop the adjudication length assert; keep `:401`), `test/unit/client/components/ReconcileWarmingBanner.test.tsx` (strip the copied helper's `deadSessionAdjudication` seed/option and its `DeadSessionEntry` type import), state-shape preloads `test/unit/client/store/paneCloseGate.test.ts:1272`, `test/unit/client/store/terminalDetachMiddleware.test.ts:365`, `test/unit/lib/managed-runtime-recovery.test.ts:151` (drop the field literal)
- Dangling imports: after the named edits, `pnpm run typecheck:client` enumerates every test file still importing the deleted action creators/type (`pane-reconcile.test.ts:19`, `pane-reconcile.fresh-agent.test.ts:21`, `panesSlice.reconcile.test.ts:24-26`, `panesSlice.fresh-agent-reconcile.test.ts`, `App.reconcile-adoption.test.tsx:11`) — remove them as flagged.

**Interfaces:**
- Consumes: Task 3 (no component reads the state).
- Produces: `foldVerdicts(dispatch, request, result, opts?)` with unchanged signature; `FoldOutcome` without `dead` (`{ attached, respawned, fresh, warming, managedDeferred, invalid, cardinalityViolation }`); dead_session verdict folds dispatch exactly one `setPaneRestoreError` per pane and fire `onVerdictFolded`.

- [ ] **Step 1: Write the failing behavioral tests (re-key the batching pins)**

In `test/unit/client/lib/pane-reconcile.test.ts`, replace the batching test (`:367`, `dead sessions are batched into ONE setDeadSessionAdjudication dispatch (never N)`):

```ts
it('dead sessions get exactly one per-pane restoreError latch, one dead-copy reconcileNotice, and no batched dispatch', () => {
  const h = foldHarnessAllDead(3)
  const outcome = h.fold()
  expect(outcome.cardinalityViolation).toBe(false)
  const restoreErrors = h.dispatches.filter((a) => a.type === 'panes/setPaneRestoreError')
  expect(restoreErrors).toHaveLength(3)
  expect(restoreErrors.every((a) => a.payload.restoreError.code === 'RESTORE_UNAVAILABLE'
    && a.payload.restoreError.reason === 'durable_artifact_missing')).toBe(true)
  const deadNotices = h.dispatches.filter((a) => a.type === 'panes/setPaneReconcileNotice'
    && a.payload.notice === DEAD_SESSION_RECONCILE_NOTICE)
  expect(deadNotices).toHaveLength(3)
  // The batched adjudication dispatch is gone with the state — its absence
  // is compile-enforced once the action creator is deleted (nothing can
  // dispatch it), so no negative assertion is needed or written here.
})
```

(Also drop the single `setDeadSessionAdjudication` expect from the routing test at `:316`; widen the latch-breadcrumb test at `:375` to pin `reason: 'durable_artifact_missing'` and the dead-copy notice mint. NOTE: this test is being written in Task 2 already if Task 2 ran first — reconcile the two edits into one final shape.)

In `pane-reconcile.fresh-agent.test.ts`, split `:358` the same way for the LATCH only (2 dead fresh-agent verdicts → 2 `setPaneRestoreError`, zero batch dispatch, and ZERO `setPaneReconcileNotice` dead-copy mints — the fresh-agent arm must NOT mint the notice, per LB1's caveat; the existing restoreError asserts stay).

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/client/lib/pane-reconcile.test.ts test/unit/client/lib/pane-reconcile.fresh-agent.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL — the fold still dispatches `setDeadSessionAdjudication` today.

- [ ] **Step 3: Add the minimal production implementation**

Apply every edit in the Files list. Order suggestion: type first (`paneTypes.ts`), then let `pnpm run typecheck:client` enumerate every compile break (the reducers, the persist strip, the fold, App), fix each, then the test updates. Keep `setPaneRestoreError` dispatches (`:393-397`, `:568-572`) byte-identical. Delete `deadSessionTitle` (dead code — its only consumer was the entry push).

- [ ] **Step 4: Run the focused tests**

Run: `pnpm run test:vitest run test/unit/client/lib/pane-reconcile.test.ts test/unit/client/lib/pane-reconcile.fresh-agent.test.ts test/unit/client/store/panesSlice.reconcile.test.ts test/unit/client/store/panesSlice.fresh-agent-reconcile.test.ts test/unit/client/components/App.reconcile-adoption.test.tsx test/unit/client/store/paneCloseGate.test.ts test/unit/client/store/terminalDetachMiddleware.test.ts test/unit/lib/managed-runtime-recovery.test.ts --config config/vitest/vitest.config.ts && pnpm run typecheck:client`

Expected: PASS + typecheck clean.

- [ ] **Step 5: Refactor while green**

`pnpm run lint`. Grep-check for stragglers in PRODUCTION code: `rg -n 'deadSessionAdjudication|DeadSessionEntry|setDeadSessionAdjudication|resolveDeadSessionEntry|clearDeadSessionAdjudication|deadSessionTitle' src` must return nothing. In `test/unit`, typecheck already forbids live imports; remaining comment-only mentions in unrelated suites are optional cleanup only.

- [ ] **Step 6: Run impacted-test verification**

The state removal ripples across the client store surface — run the whole client unit tree:

Run: `pnpm run test:vitest run test/unit/client --config config/vitest/vitest.config.ts && pnpm run typecheck:client`

Expected: PASS (this is the broadest client-lane run; it is a narrowed vitest selector, coordinator-delegated).

- [ ] **Step 7: Commit the task**

```bash
git add src/store/paneTypes.ts src/store/panesSlice.ts src/store/persistMiddleware.ts src/lib/pane-reconcile.ts src/App.tsx test/unit/client/lib/pane-reconcile.test.ts test/unit/client/lib/pane-reconcile.fresh-agent.test.ts test/unit/client/store/panesSlice.reconcile.test.ts test/unit/client/store/panesSlice.fresh-agent-reconcile.test.ts test/unit/client/components/App.reconcile-adoption.test.tsx test/unit/client/store/paneCloseGate.test.ts test/unit/client/store/terminalDetachMiddleware.test.ts test/unit/lib/managed-runtime-recovery.test.ts
git commit -m "refactor(store): deadSessionAdjudication state removed; restoreError latch is the dead-session state"
```

---

### Task 5: E2E specs re-keyed to the no-modal contract

All four browser specs that interact with the dialog get rewritten to pin the new contract. The server-side wire test (`reconcile-handshake-rust.spec.ts:244`) and all Rust tests stay untouched.

**Files:**
- Modify: `test/e2e-browser/specs/reconcile-client-adoption-rust.spec.ts` (test 2 `:542-640` full rewrite; helpers `seedCodexAdoptionHome` `:189`, `openSeededCodexSession` `:251`, `retryWarmingIfVisible` `:100` reused)
- Modify: `test/e2e-browser/specs/freshclaude-identity-persistence-rust.spec.ts` (`:798-811` HAZARD GUARD re-key; `:824-858` keep assertions unchanged)
- Modify: `test/e2e-browser/specs/unified-agent-names-restart.spec.ts` (`:223-228` freshcodex branch)
- Modify: `test/e2e-browser/specs/freshclaude-zero-turn-restart-rust.spec.ts` (`:229-235` state half; `:246` restoreError negative stays)

**Interfaces:**
- Consumes: Task 2's `DEAD_SESSION_BUFFER_NOTICE` literal (pin the same string in the specs), Task 4's final state shape.
- Produces: the no-modal e2e contract: no `role="dialog"` named "Dead sessions" ever; dead panes show the notice line; latch stands; nothing auto-closes; resolution through existing chrome.

- [ ] **Step 1: Rewrite the specs (test-first: these specs are red against the branch until Tasks 1-4 land — after they land, run them red→green in the same commit order)**

**`reconcile-client-adoption-rust.spec.ts` test 2** — new name: `dead terminal sessions surface as one in-buffer notice line per pane, no modal`:

```
Setup: identical to today (seed two codex sessions CODEX_DEAD_SESSION_A/B via
seedCodexAdoptionHome, open both via openSeededCodexSession, capture each
pane's terminalId from harness state, retryWarmingIfVisible as needed).
Act: server.restart() with both session files deleted (existing :594-596 recipe).
Assert (live-reconnect shape):
 1. ZERO dialogs: await expect(page.getByRole('dialog', { name: 'Dead sessions' })).toHaveCount(0)
 2. Each dead pane's stale buffer (harness.getTerminalBuffer(<captured stale terminalId>))
    contains DEAD_SESSION_BUFFER_NOTICE exactly once (count the occurrences === 1).
 3. TestHarness.getState(): both leaves carry
    content.restoreError.reason === 'durable_artifact_missing'.
 4. No auto-close: pane count and tab count unchanged from pre-restart;
    server listTerminals shows no NEW PTYs (no duplicate --resume spawns).
Act 2 (reload shape drives the existing-chrome resolution): page.reload(),
waitForWsReady, retryWarmingIfVisible if the warming banner appears.
 5. The boot reconcile re-adjudicates both panes dead; the post-verdict
    create is refused typed SESSION_MISSING (no PTY) and each pane renders
    the existing TerminalLaunchFailureCard. NOTE (kata ebp6): this spec's
    codex seeding has a known flake (seeded leaf null after 20s); if the
    rewritten spec hits it, harden the seeding — do not skip.
 6. Click pane A's failure-card "Start fresh" (existing chrome; validated
    wiring LB3: it drives startNewManagedRuntimeConversation — NOT
    resetPaneForReconcileCreate — so assert pane A's createRequestId
    CHANGES and the new codex PTY is identity-less: no --resume of the
    dead session id in the server-side terminal argv; exactly ONE new PTY
    exists; pane A live with !restoreError).
 7. Close pane B via its pane header close button
    (getByRole('button', { name: 'Close pane' })). LB4 (validated): each
    dead pane is its own single-pane tab, so closing pane B removes B's
    TAB (pane A's tab survives); assert one tab gone, one fewer leaf, no
    PTY spawned.
 8. Final: still zero dialogs for the whole test; one live PTY; the second
    pane's departure was the user's click, not the verdict.
```

**`freshclaude-identity-persistence-rust.spec.ts` HAZARD GUARD** (`:754`): keep the fixture and every keep-assertion (`:805-807` leaf fresh-agent + `restoreError.reason === 'durable_artifact_missing'`; `:824-840` identity not swapped, latch standing, ZERO `freshAgent.create`; `:849-858` the FreshAgentView `role="alert"` banner text "This session cannot be resumed because the saved session artifact is no longer available." after second reload). LB5 (validated): the deleted `state.panes.deadSessionAdjudication` poll at `:798-804` was the ONLY verdict-synchronization wait between reconnect and the `:805-807` leaf asserts — replacing it with a bare instant no-dialog assert would race the boot-reconcile fold. Replace it with the suite's own idiom: an `expect.poll` on the leaf's `content.restoreError.reason === 'durable_artifact_missing'` (same shape as this spec `:564/:581` and the adoption spec's leaf-latch polls), and only THEN assert `expect(page.getByRole('dialog', { name: 'Dead sessions' })).toHaveCount(0)` (replacing both the state poll `:798-804` and the modal-visible assert `:811`).

**`unified-agent-names-restart.spec.ts` freshcodex branch** (`:223-228`): today it waits for the dialog and clicks "Start fresh here" (the modal's `resetFreshAgentPaneForReconcileCreate` — the one remint verb that preserved `createRequestId` and the name-inheritance record). LB7 (validated): the only existing-chrome remint reachable in the dead state is the composer's `/new` slash route, which calls `startNewManagedRuntimeConversation` — a NEW identity with the name record STRANDED (`panesSlice.ts:2018-2019` clears `nameRef`/`namingHandle`). No existing-chrome route preserves the modal's name-inheriting remint semantics, and adding one would violate the no-new-UI constraint. Re-scope the branch against the validated assertion map: KEEP `:236-238` (API-only readUpdate — pane-independent) and `:231-233` (pane-header PENDING_NAME — still passes while latched); REPLACE the dialog wait/click with: assert no dialog ever, the pane keeps its `restoreError` banner; DROP `:243+` (send-first-message materialization and every pane-dependent post-remint step — no honest existing-chrome route reaches them). Record the product residual in the spec's header comment: after this change a dead freshcodex session's durable name no longer carries onto a remint through pane chrome (`/new` starts a stranded-name new conversation; the pane's close button ends it) — surfaced to the user in the run recap as an accepted consequence of removing the modal.

**`freshclaude-zero-turn-restart-rust.spec.ts`** (`:229-235`): drop the dialog-count and `deadSessionAdjudication` state asserts; the must-NOT-be-dead intent stays pinned by `:246` (`leaf.content.restoreError?.reason` NOT `durable_artifact_missing`) — keep that line byte-identical.

- [ ] **Step 2: Run the specs and verify the failure mode (before Tasks 1-4 they are red; after, green)**

Run (cloud backend is the configured default; these are the affected specs):

```bash
FRESHELL_E2E_BACKEND=cloud pnpm run test:e2e:cloud test/e2e-browser/specs/reconcile-client-adoption-rust.spec.ts test/e2e-browser/specs/freshclaude-identity-persistence-rust.spec.ts test/e2e-browser/specs/unified-agent-names-restart.spec.ts test/e2e-browser/specs/freshclaude-zero-turn-restart-rust.spec.ts
```

Expected: PASS on the configured backend. Also verify none of the rewritten tests landed in `CLOUD_SKIP_SPECS` (`test/e2e-browser/playwright.cloud.config.ts`) — a skipped spec is not coverage; if any of these is in the skip list, also run it locally: `FRESHELL_E2E_BACKEND=local pnpm run test:e2e:local <spec>`.

- [ ] **Step 3: Minimal implementation**

None — this task is test-only (the specs pin behavior Tasks 1-4 implemented). If a spec surfaces a genuine product gap (e.g. the freshcodex pane exposes no remint affordance at all), STOP and report: do not add new in-pane UI to make a test pass (that violates the request); adjust the spec to the closest honest existing-chrome flow and record the decision in the run record.

- [ ] **Step 4: Run the focused specs**

Same command as Step 2. Expected: PASS.

- [ ] **Step 5: Refactor while green**

Deduplicate any helper the rewrites forced out (keep spec-local; no shared-harness changes unless a buffer-by-paneId accessor proved unavoidable — if added, it goes in `__FRESHELL_TEST_HARNESS__` mirroring `registerTerminalBuffer` and stays test-only).

- [ ] **Step 6: Run impacted-test verification**

Impacted set: the full e2e-browser suite is the safety net for client reconcile behavior; run the affected four plus their close neighbors:

```bash
FRESHELL_E2E_BACKEND=cloud pnpm run test:e2e:cloud test/e2e-browser/specs/reconcile-client-adoption-rust.spec.ts test/e2e-browser/specs/freshclaude-identity-persistence-rust.spec.ts test/e2e-browser/specs/unified-agent-names-restart.spec.ts test/e2e-browser/specs/freshclaude-zero-turn-restart-rust.spec.ts test/e2e-browser/specs/reconcile-handshake-rust.spec.ts test/e2e-browser/specs/restore-double-restart.spec.ts
```

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/reconcile-client-adoption-rust.spec.ts test/e2e-browser/specs/freshclaude-identity-persistence-rust.spec.ts test/e2e-browser/specs/unified-agent-names-restart.spec.ts test/e2e-browser/specs/freshclaude-zero-turn-restart-rust.spec.ts
git commit -m "test(e2e): pin the no-modal dead-session contract (notice line + existing-chrome resolution)"
```

---

### Post-execution gate (not a task)

After Task 5, run the full-suite gate once on the final HEAD through the shared coordinator:

```bash
FRESHELL_TEST_SUMMARY="the-usual dead-session-no-modal final full-suite gate" pnpm run check
```

Pass criterion: green excluding the two ledger-recorded baseline flakes (kata arnn `claude_source_observation` load flake; kata bczx `claude-permission-contract` ENOTEMPTY race), attributed per the baseline receipts. Anything else red is this run's to fix before the recap.
