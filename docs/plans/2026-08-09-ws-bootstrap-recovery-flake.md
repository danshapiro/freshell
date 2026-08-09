# App WS Bootstrap Recovery Flake Fix Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

**Goal:** Eliminate the load-dependent flakiness of `test/unit/client/components/App.ws-bootstrap.test.tsx > "App WS bootstrap recovery > recovers bootstrap-owned provider availability and sidebar filters after transient pre-ready 503s"` by making the test file hermetic to async residue from sibling tests, proven by a deterministic reproduction that fails before the fix and passes after.

**Architecture:** The failure channel is test-side shared state, not product logic: `src/store/sessionsThunks.ts` keeps module-level per-surface state (`controllers`, `inFlightRequests`, `invalidationRefreshState`, `sessionWindowThunkGeneration`) that this test file never resets, while sibling tests in the same file drive fire-and-forget `queueActiveSessionWindowRefresh`/`fetchSessionWindow` chains against the same module-level mocks. Under full-suite load (`sequence.shuffle: true`, 32 thread workers) a sibling's unsettled chain can land inside the target test and consume its call-count-sequenced mock quotas (`bootstrapCalls`/`sidebarCalls`) or abort its in-flight fetch, scrambling the test's deterministic orchestration. The repo-established remedy — `_resetSessionWindowThunkState()` (+ `_resetTerminalDirectoryThunkControllers()` for the sibling directory thunks) in `beforeEach` AND `afterEach`, used by six other test files — closes every such channel; additionally the target test's first fence is strengthened so `ready` can only be injected after the bootstrap chain has fully unwound (the `ws.connect` call is the chain's last step).

**Tech Stack:** Vitest 3.2.4 (threads pool, jsdom, `sequence.shuffle`), React Testing Library, Redux Toolkit, TypeScript.

## Global Constraints

- Red-Green-Refactor TDD; the RED evidence for Task 2 is the deterministic reproduction from Task 1 (a timing-channel flake is red = "harness fires the flake against the unfixed file").
- NEVER weaken the target test: no deleted or loosened assertions, no retry wrappers, no skips, no blanket timeout inflation. All test changes are additive (new reset calls, one additional fence assertion).
- No product-code (`src/`) behavior changes in this plan: static analysis (see evidence reports) shows the product bootstrap/recovery path is deterministic for the mocked inputs; only test-file shared-state leakage varies under load. If Task 1's reproduction contradicts this, STOP and report — do not silently expand scope.
- Repo rules: server uses NodeNext/ESM (irrelevant here — no server code touched); commits use `Dan Shapiro <3732858+danshapiro@users.noreply.github.com>`; no PR creation in this plan.
- Verification bar (from the task specification): the deterministic repro fails before the fix and passes after; the target test passes in isolation; and the target test passes in 3 consecutive full client-suite runs (`npx vitest run --config config/vitest/vitest.config.ts`).

## Evidence base (already produced during planning)

- `reports/plan-bootstrap-code.md` — full production-path trace (App.tsx bootstrap/recovery, sessionsThunks multimaps, sidebarSelectors purity). Key facts: the sidebar selector is a pure function of the test's own store, and no payload in the file can produce a sidebar row titled `Codex` with `terminals=[]`; the sequenced mocks are shared hoisted `vi.fn`s consulted by every thunk in the file.
- `reports/plan-test-infra.md` — vitest mechanics: `pool: threads`, `isolate: true`, `sequence.shuffle: true` (shuffles BOTH file order and in-file test order), no `maxWorkers` cap (32 workers on 32 CPUs), `restoreMocks`/`unstubGlobals` off, RTL `waitFor` default 1000 ms/50 ms. Conclusion: cross-FILE content injection is structurally impossible; the load-flake must be an in-file/asynchronous-ordering channel.
- Baseline (`reports/workspace-baseline.md`): the target test failed full-suite at base_ref and at HEAD~2 but passed 36/36 in isolation.
- Code-verified leak channels in the unfixed file (vs. sibling-file practice):
  1. `App.ws-bootstrap.test.tsx` never calls `_resetSessionWindowThunkState()`; sibling files (`test/e2e/sidebar-search-flow.test.tsx:157/172`, `test/e2e/sidebar-repo-filter-flow.test.tsx:140/155`, `test/e2e/sidebar-agent-filter-flow.test.tsx:140/155`, `test/e2e/sidebar-refresh-dom-stability.test.tsx:227/259`, `test/unit/client/store/sidebar-staleness.test.ts:74/77`, `test/unit/client/store/sessionsThunks.test.ts:76/80`) call it in `beforeEach` and `afterEach`.
  2. `App.ws-bootstrap.test.tsx` never calls `_resetTerminalDirectoryThunkControllers()` (sessionsThunks' directory twin in `src/store/terminalDirectoryThunks.ts:41-50`).
  3. Sibling tests in the same file (`:1801`, `:1884`, `:1973`) start `queueActiveSessionWindowRefresh` run-loops and direct fetches that are never drained before test end; their continuation can consume the target test's sequenced quota (`fetchSidebarSessionsSnapshot` call 1 = the seeded 503) or `abortSurface('sidebar')` an in-flight target fetch.
  4. The target test's fence `waitFor #1` (test line 559-563) checks `connection.status==='disconnected'`, which is the preloaded state and therefore vacuous as a synchronization edge; its real ordering comes only from the two counters, which a straggler can scramble during the real 150 ms bootstrap retry window.

---

### Task 1: Deterministic reproduction and forensic evidence

**Files:**
- Create (evidence, untracked): `<logs_dir>/reports/flake-repro-evidence.md`
- Create (harness, untracked scratch): `/tmp/flake-repro-loop.sh` (already built during planning), `test/unit/client/components/__ws-bootstrap-interlock.probe.test.tsx` (deterministic by-construction probe, written in Step 2, deleted in Task 2 Step 6)
- No repository files are added, modified, or deleted by this task.

**Interfaces:**
- Produces: `<logs_dir>/reports/flake-repro-evidence.md` containing (a) at least one captured real failure of the target test (raw vitest output with the exact failing assertion), or a documented negative result plus the by-construction probe output; (b) the probe's RED output against the unfixed file.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Capture an organic failure under load**

Run the stressed loop harness (40 iterations, rotating `--sequence.seed`, CPU-saturated with one `yes` burner per core):

Run: `bash /tmp/flake-repro-loop.sh 40 /tmp/flake-repro-b`

Expected: iterations may FAIL with the target test's load-flake signatures; a 0/40 outcome is ALSO acceptable evidence (it bounds the organic rate and forces reliance on Step 2's deterministic probe). Record every failing iteration's raw assertion diff.

- [ ] **Step 2: Build the by-construction straggler-channel probe (deterministic RED)**

Create an untracked scratch probe test at `test/unit/client/components/__ws-bootstrap-interlock.probe.test.tsx` (never committed; deleted in Task 2 Step 6). It reuses the target test file's mock setup (copy imports/mocks/`createStore` `beforeEach` essence) and contains ONE test with two phases separated by a simulated test boundary:

1. **Phase "sibling":** mount `App` with a `fetchSidebarSessionsSnapshot` implementation whose FIRST call returns a manually-held promise (`let release; new Promise((r) => (release = r))`). Inject two `sessions.changed` WS messages: the first starts `queueActiveSessionWindowRefresh`, whose run-loop dispatches `fetchSessionWindow`, which parks on the held promise; the second sets `queued = true` on the in-flight invalidation state. Confirm the first mock call happened, then `cleanup()` (RTL unmount) — the run-loop is now a live straggler awaiting resolution past its test's lifetime.
2. **Boundary:** if env `PROBE_RESET === '1'`, call `_resetSessionWindowThunkState()` and `_resetTerminalDirectoryThunkControllers()` (mirrors the fixed file's `afterEach`+`beforeEach`); if `'0'`, do nothing (mirrors the unfixed file).
3. **Phase "target":** run the target test's unmodified flow (same sequenced 503 mocks + quota counters) in a fresh store. Immediately before the fresh mount's bootstrap begins, call `release(payload)` so the straggler resolves: unfixed, its run-loop continues and issues a SECOND `fetchSidebarSessionsSnapshot` call (queued lap), consuming the target-era quota (`sidebarCalls` becomes 1 before the app's own sidebar leg, which then gets the SUCCESS response pre-ready) → the target test's `waitFor #1` (`sidebarCalls === 1`) can never hold → deterministic timeout FAIL. With `PROBE_RESET=1`, the generation bump plus controller abort makes the straggler exit at its next `while` check with no second call → the target flow runs clean → PASS.

Run: `PROBE_RESET=0 npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/components/__ws-bootstrap-interlock.probe.test.tsx`

Expected: FAIL deterministically at the target-phase `waitFor #1` (or the terminal count assertions), proving the cross-test straggler channel is real and sufficient to break this exact test, with zero timing luck. Save raw output into the evidence report. (If `PROBE_RESET=0` unexpectedly passes, the probe's straggler did not survive the boundary — inspect and correct the probe until it does; the probe must demonstrate the leak, not assume it.)

- [ ] **Step 3: Record the evidence**

Write `<logs_dir>/reports/flake-repro-evidence.md` with: organic-loop results, the probe's exact failing assertion output, the identified channel, and the conclusion whether product code is implicated (expected: no; if yes, stop and re-plan).

### Task 2: Hermetic test-file isolation (the fix)

**Files:**
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx` (imports near :18; `beforeEach` at :266-307; `afterEach` at :309-312; target-test fence at :559-563)
- Test: `test/unit/client/components/App.ws-bootstrap.test.tsx` (all 36 tests must still pass, including under adversarial in-file ordering)

**Interfaces:**
- Consumes: `_resetSessionWindowThunkState()` from `src/store/sessionsThunks.ts:59`; `_resetTerminalDirectoryThunkControllers()` from `src/store/terminalDirectoryThunks.ts:41`.
- Produces: the fixed, hermetic test file; behavior of every test unchanged in the idle case.

- [ ] **Step 1: Add the hermeticity resets and the fence strengthening**

Exact diff intent:

1. Add imports (after line 18):
```ts
import { _resetSessionWindowThunkState } from '@/store/sessionsThunks'
import { _resetTerminalDirectoryThunkControllers } from '@/store/terminalDirectoryThunks'
```
2. In `beforeEach` (after `vi.resetAllMocks()`):
```ts
_resetSessionWindowThunkState()
_resetTerminalDirectoryThunkControllers()
```
3. In `afterEach` (after `cleanup()`):
```ts
_resetSessionWindowThunkState()
_resetTerminalDirectoryThunkControllers()
```
   Rationale: the generation bump in `_resetSessionWindowThunkState()` makes any sibling run-loop exit at its next `while (generation === sessionWindowThunkGeneration)` check without issuing further mock calls, and clears `controllers`/`inFlightRequests`/`invalidationRefreshState` so no cross-test abort/coalesce can occur. The afterEach reset kills residue created by the test itself, so SHUFFLED orderings are symmetric — no test can leak into whatever runs next. This mirrors the established pattern in the six sibling files cited above.
4. Strengthen the target test's first fence (`waitFor` at :559-563) by adding:
```ts
expect(wsMocks.connect).toHaveBeenCalledTimes(1)
```
   Rationale: `connect()` is the final awaited step of the bootstrap chain (App.tsx:1460); requiring it proves the chain fully unwound (`bootstrapCalls===2`/`sidebarCalls===1` alone are counter assertions that a straggler could have scrambled into transient truth). This is an ADDED assertion — nothing is deleted or loosened. In the intended timeline it is already true, so the test's pass/fail semantics are unchanged when idle.

- [ ] **Step 2: Run the focused test file and confirm GREEN**

Run: `npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/components/App.ws-bootstrap.test.tsx`

Expected: PASS (36/36), identical to pre-fix idle behavior.

- [ ] **Step 3: Run the probe in post-fix boundary mode (deterministic GREEN)**

The probe from Task 1 Step 2 already exists at `test/unit/client/components/__ws-bootstrap-interlock.probe.test.tsx` and imports the now-fixed setup. Run it with the boundary reset enabled — this applies exactly the boundary operations the fixed file's hooks now perform:

Run: `PROBE_RESET=1 npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/components/__ws-bootstrap-interlock.probe.test.tsx`

Expected: PASS — the straggler run-loop exits at its generation check without issuing the second mock call, the target phase's quotas stay intact, and the complete target flow (including its unmodified assertions) passes. Also re-run `PROBE_RESET=0` to confirm the probe still demonstrates the leak in unfixed mode (it must still FAIL — the probe is the fixed-vs-unfixed discriminator; if the `PROBE_RESET=0` control now passes too, the probe is broken, not the fix). Save both outputs into the evidence report.

- [ ] **Step 4: Adversarial sweep of the fixed file**

Run: `for i in $(seq 1 30); do npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/components/App.ws-bootstrap.test.tsx --sequence.seed=$i || echo "SEED $i FAILED"; done` (with CPU saturation)

Expected: PASS on all 30 shuffled in-file orders.

- [ ] **Step 5: Neighbor-impact verification**

The change touches one test file only; impacted set = that file plus any file importing the two reset helpers (behavior of the helpers is unchanged — they are only newly called here). Run the store-level thunk suites to confirm no interaction with the helper contract:

Run: `npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/store/terminalDirectoryThunks.test.ts test/unit/client/store/sidebar-staleness.test.ts`

Expected: PASS.

- [ ] **Step 6: Delete the scratch probe and commit**

The probe file is untracked scratch; remove it so the delta contains only the test-file fix:

```bash
rm test/unit/client/components/__ws-bootstrap-interlock.probe.test.tsx
git add test/unit/client/components/App.ws-bootstrap.test.tsx
git commit -m "test(app): hermetic thunk-state isolation for WS bootstrap recovery suite (load-flake fix)"
```

### Task 3: Verification gate — 3 consecutive full client-suite runs + server suite

**Files:**
- Create (evidence, untracked): `<logs_dir>/reports/verification-gate.md`
- No repository files changed.

**Interfaces:**
- Consumes: the committed Task 2 fix.
- Produces: gate evidence satisfying the task's verification bar plus the executing-plans full-suite gate (both vitest configs).

- [ ] **Step 1: Run the full client suite three times consecutively at the final HEAD, without extra machine load**

Run (three times, sequentially): `FRESHELL_TEST_SUMMARY='ws-bootstrap flake fix gate <n>' npx vitest run --config config/vitest/vitest.config.ts`

Expected: PASS (0 failed) in all three runs. Any failure of ANOTHER test must be reproduced at base_ref before being recorded as a ledger-allowed pre-existing load-flaky failure; the target test must pass in every run.

- [ ] **Step 2: Run the server suite once at the final HEAD**

Run: `npx vitest run --config config/vitest/vitest.server.config.ts`

Expected: PASS except ledger-recorded base_ref-reproduced failures only.

- [ ] **Step 3: Record the gate**

Write `<logs_dir>/reports/verification-gate.md` with per-run totals and the target test's result in each, and update the executing-plans progress ledger gate entry.

---

## Notes and explicit non-goals

- **Production code is not changed.** The App.tsx recovery twin-guards (`bootstrapDataLoading`/`platformDetailsLoading`/`sidebarWindowLoading` returning `true` when a twin leg is in flight, `recoverMissingStartupState`'s one-deep rerun latch) are a real product design smell documented in `reports/plan-bootstrap-code.md` (L2), but the target test — once hermetic — never presents a mid-flight state to the recovery path, and no observed failure evidence implicates product behavior. Changing it would expand scope and risk; it is listed here as an explicit non-goal, to be surfaced as a follow-up in the recap.
- **The quoted failure signature** (`expected ['Manual Session'], received ['Codex', 'Manual Session']`) cannot be produced by any in-file data flow under `terminals=[]` (selector is pure; no payload titles `Codex`; proven in `reports/plan-bootstrap-code.md` §0/§4.5 and re-verified against `sidebarSelectors.ts`/`sessionsSlice.ts` directly). Task 1's forensic capture settles what the raw failure prints; the hermeticity fix removes ALL cross-test channels regardless of which micro-signature an individual run manifests. If Task 1 captures a signature the test-side fix cannot explain, STOP and re-plan instead of forcing this fix.
