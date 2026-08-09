# App WS Bootstrap Recovery Flake Fix Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

**Goal:** Eliminate the load-dependent flakiness of `test/unit/client/components/App.ws-bootstrap.test.tsx > "App WS bootstrap recovery > recovers bootstrap-owned provider availability and sidebar filters after transient pre-ready 503s"`, proven by deterministic reproduction(s) that fail before the fix and pass after, plus 3 consecutive green full client-suite runs.

**Architecture:** The observed organic failure is a selector-title mismatch at test line 598 — `expected [ 'Manual Session' ], received [ 'Codex', 'Manual Session' ]` (raw evidence: `/tmp/freshell-baseline.log:1861-1877`, suite seed `1786259877991`). Static analysis proves no data flow inside the fixed test store can produce a sidebar row titled `Codex` (selector inputs: 2-session payload with titles 'Hidden Auto Session'/'Manual Session', single shell tab, empty panes, `terminals=[]`; see evidence reports below). Therefore the contaminating state enters through a test-side leak channel whose exact content path the instrumented organic reproduction (Task 1) must capture. Independently, one such channel is already identified, deterministically reproduced, and closable by the decision rule in Task 2: this file never resets the module-level per-surface thunk state in `src/store/sessionsThunks.ts`/`src/store/terminalDirectoryThunks.ts`, so fire-and-forget refresh chains from shuffled sibling tests can consume the target test's call-count-sequenced mocks or abort its in-flight fetches. The fix is test-side hermeticization at the file's lifecycle boundaries plus instrumentation-informed hardening from Task 1's forensic capture. No product (`src/`) behavior changes unless Task 1's captured state dump proves a product race — in which case STOP and re-plan.

**Tech Stack:** Vitest 3.2.4 (threads pool, jsdom, `sequence.shuffle`), React Testing Library, Redux Toolkit, TypeScript.

## Global Constraints

- Red-Green-Refactor TDD; the RED evidence for the fix is: (a) the by-construction probe failing against the unfixed boundary, and (b) any organically captured instrumented failure. Both artifacts must exist before Task 2 commits.
- NEVER weaken the target test: no deleted or loosened assertions, no retry wrappers, no skips, no blanket timeout inflation. All test changes are additive (reset calls at boundaries; one added fence assertion; forensic instrumentation is added and then REMOVED before the final commit).
- Repo rules: broad test runs use repo-owned commands (`npm run test:vitest -- ...`, the repo-owned equivalent of the sanctioned baseline command `npx vitest run --config config/vitest/vitest.config.ts`; `test:vitest` runs under the shared coordinator). Set `FRESHELL_TEST_SUMMARY` for broad runs. Never run `pkill`/`kill` patterns against foreign test processes.
- Commits use the repo git identity; do not create a PR.
- Absolute run values for this plan (no placeholders): worktree = `/home/dan/code/freshell/.worktrees/ws-bootstrap-recovery-flake`; logs_dir = `/home/dan/code/freshell/.worktrees/.the-usual-logs/ws-bootstrap-recovery-flake/`; base_ref = `4c2297667f7c59758b4aeb8848cf7eddc1710cfc`; progress ledger = `<worktree git-dir>/usual-sdd/progress.md` (git-dir from `git rev-parse --git-dir`, currently `/home/dan/code/freshell/.git/worktrees/settings-proto-strict-reject`).

## Verification bar (from the task specification)

1. A deterministic reproduction fails before the fix and passes after.
2. The target test passes in isolation (its file alone).
3. The target test passes in 3 consecutive full client-suite runs (`npm run test:vitest -- run --config config/vitest/vitest.config.ts`, the repo-owned path for the baseline's exact command), with any other-test failures reproduced at base_ref before being recorded as allowed pre-existing load-flaky failures.

## Evidence base (already produced; absolute paths)

- `/home/dan/code/freshell/.worktrees/.the-usual-logs/ws-bootstrap-recovery-flake/reports/plan-bootstrap-code.md` — production-path trace.
- `/home/dan/code/freshell/.worktrees/.the-usual-logs/ws-bootstrap-recovery-flake/reports/plan-test-infra.md` — vitest mechanics (pool=threads, isolate=true, jsdom per file, shuffle covers file AND in-file order, no worker cap).
- `/home/dan/code/freshell/.worktrees/.the-usual-logs/ws-bootstrap-recovery-flake/reports/load-bearing-validator-B.md` — deterministic probe RED/GREEN (see Task 1 Step 2).
- `/home/dan/code/freshell/.worktrees/.the-usual-logs/ws-bootstrap-recovery-flake/reports/workspace-baseline.md` — orchestrator baseline.
- `/tmp/freshell-baseline.log` (raw, base_ref full-suite run at 2026-08-09 00:16): the organic failure — `AssertionError: expected [ 'Codex', 'Manual Session' ] to deeply equal [ 'Manual Session' ]` at `App.ws-bootstrap.test.tsx:598:91` after 486 ms (no timeout); the target test ran 6th of 36 in-file (BEFORE the queue-loop sibling tests at file lines 1801/1884/1973), so this organic instance is NOT explained by those siblings' residue.
- Reviewer hypothesis and its analysis — cross-file `BroadcastChannel` contamination (Fresh Eyes round 1, major finding 1): investigated and falsified as a mechanism. `persistBroadcast.ts` posts only from `persistMiddleware`, which this test file's stores never install, so nothing in this file posts; vitest gives each file a fresh jsdom (per-file globals) and Node's `BroadcastChannel` never crosses worker threads nor retains a backlog for later-created instances, so neither cross-file nor in-file cross-test delivery into `installCrossTabSync`'s listener (App.tsx:312-315) can occur here. The observed content must therefore come from a channel that ships REAL content into the target test's OWN store — captured empirically in Task 1 Step 1.

---

### Task 1: Deterministic reproduction and forensic capture

**Files:**
- Create (evidence, untracked): `/home/dan/code/freshell/.worktrees/.the-usual-logs/ws-bootstrap-recovery-flake/reports/flake-repro-evidence.md`
- Create (harness, untracked scratch): `/tmp/flake-repro-loop.sh` (exists), `/tmp/flake-hammer.sh` (exists), `test/unit/client/components/__ws-bootstrap-interlock.probe.test.tsx` (probe, exists)
-Modify (TEMPORARY, reverted before Task 2's commit): `test/unit/client/components/App.ws-bootstrap.test.tsx` — forensic try/catch around the line-598 assertion dumping full state + built selector items + mock call counts as a `FLAKE-DEBUG` JSON line on failure.

**Interfaces:**
- Produces: the evidence report, the organic `FLAKE-DEBUG` dump (or documented non-reproduction within the hammer budget), and the probe RED/GREEN logs.
- Consumes: existing harnesses and probe from planning/Stage 2.

- [ ] **Step 1: Capture an organic failure with instrumentation**

Run (as launched during planning; reuse its outputs if it already produced a reproduction): `bash /tmp/flake-hammer.sh` — up to 8 full client-suite runs of `FRESHELL_TEST_SUMMARY='flake hammer run <i>' npm run test:vitest -- run --config config/vitest/vitest.config.ts --reporter=basic`, stopping at the first run containing a `FLAKE-DEBUG` line; the dump lands in `/tmp/flake-hammer/FLAKE-DEBUG.json`.

Expected: either a captured dump (settle exactly which store field carries the `Codex` row: `sessions.projects` content, `windows.sidebar.projects`, `tabs`, item source flags `isFallback`/`liveTerminalOnly`, plus `bootstrapCalls`/`sidebarCalls`/snapshot mock call count), or 0 reproductions in 8 runs (documented; channel attribution then rests on the probe + static analysis and the fix is judged solely by Task 3's gate).

- [ ] **Step 2: Probe RED/GREEN pair (already captured — re-run only if logs are missing)**

- RED (unfixed boundary): `PROBE_RESET=0 npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/components/__ws-bootstrap-interlock.probe.test.tsx` → FAILS deterministically at the replica of the target's first fence (`expect(sidebarCalls).toBe(1)` receives 2 within `waitFor`'s 1s timeout) — the sibling straggler consumed the sequenced 503 quota call. Existing log: `/tmp/probe-reset0.log`.
- GREEN (fixed boundary: `_resetSessionWindowThunkState()` + `_resetTerminalDirectoryThunkControllers()` at the simulated boundary): same command with `PROBE_RESET=1` → PASSES. Existing log: `/tmp/probe-reset1.log`.

Scope note (honest epistemics): the probe demonstrates the in-file residue channel and that the boundary resets close it; it is mechanism evidence, not by itself proof that the organic `Codex` signature is fixed — that burden rests on Task 1 Step 1's captured dump and Task 3's gate.

- [ ] **Step 3: Record the evidence**

Write the evidence report with: mechanism narrative; organic dump analysis (per Step 1 outcome); probe logs; and the explicit verdict whether product code is implicated (gate: only if the dump shows a state contradiction the product alone could produce — else NO).

### Task 2: Fix — hermetic test-file isolation plus instrumentation-informed hardening

**Files:**
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx` (imports near :18; `beforeEach` at :266-307; `afterEach` at :309-312; target-test fence at :559-563; forensic instrumentation REMOVED)
- Test: same file (all 36 tests must pass in isolation and under adversarial in-file ordering).

**Interfaces:**
- Consumes: `_resetSessionWindowThunkState()` (`src/store/sessionsThunks.ts:59`), `_resetTerminalDirectoryThunkControllers()` (`src/store/terminalDirectoryThunks.ts:41`), and Task 1's dump.
- Produces: the fixed, hermetic test file.

- [ ] **Step 1: Apply the fix**

1. Add imports after line 18:
```ts
import { _resetSessionWindowThunkState } from '@/store/sessionsThunks'
import { _resetTerminalDirectoryThunkControllers } from '@/store/terminalDirectoryThunks'
```
2. `beforeEach`: immediately after `vi.resetAllMocks()`, call `_resetSessionWindowThunkState()` and `_resetTerminalDirectoryThunkControllers()`.
3. `afterEach`: immediately after `cleanup()`, call the same two resets. (The generation bump kills any sibling run-loop before it can issue another shared-mock call; `controllers`/`inFlightRequests`/`invalidationRefreshState` are cleared, so no cross-test abort/coalesce survives a boundary in EITHER shuffled direction. Mirrors the established pattern in `test/e2e/sidebar-search-flow.test.tsx:157/172`, `test/e2e/sidebar-repo-filter-flow.test.tsx:140/155`, `test/e2e/sidebar-agent-filter-flow.test.tsx:140/155`, `test/e2e/sidebar-refresh-dom-stability.test.tsx:227/259`, `test/unit/client/store/sidebar-staleness.test.ts:74/77`, `test/unit/client/store/sessionsThunks.test.ts:76/80`.)
4. Strengthen the target test's first fence (`waitFor` at ~:559-563) with ONE added assertion: `expect(wsMocks.connect).toHaveBeenCalledTimes(1)`. Rationale: `connect()` is the final awaited step of `bootstrap()` (App.tsx:1460), so the fence then proves the initial chain fully unwound before `ready` is injected; the preloaded `status==='disconnected'` check alone is vacuous. ADDITIVE — nothing else changes.
5. REMOVE the temporary forensic try/catch instrumentation from the target test (restore the exact pre-instrumentation assertion block).
6. ONLY IF Task 1 Step 1's organic dump demonstrates a contamination channel NOT closed by items 1-4 (e.g. a cross-test/mock-queue channel visible in the dump fields), add the minimal additional test-side closure for THAT channel and document it here. If the dump implicates product code instead, STOP and report for re-planning.

- [ ] **Step 2: Focused GREEN**

Run: `npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/components/App.ws-bootstrap.test.tsx`

Expected: 36/36 PASS — identical behavior in the idle case.

- [ ] **Step 3: Deterministic repro passes after the fix**

Run: `PROBE_RESET=1 npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/components/__ws-bootstrap-interlock.probe.test.tsx` → PASS (log to `/tmp/probe-reset1-postfix.log`); control `PROBE_RESET=0` → must STILL FAIL (log to `/tmp/probe-reset0-postfix.log`; if it passes too, the probe is broken — fix the probe, never pad it).

Expected: PASS / FAIL respectively.

- [ ] **Step 4: Adversarial sweep of the fixed file under saturation (strict accounting)**

Run: a strict sweep script at `/tmp/flake-sweep-fixed.sh` that (a) starts one `yes`-burner per core before the loop and kills them after; (b) for seeds 1..30 runs `npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/components/App.ws-bootstrap.test.tsx --sequence.seed=$i`; (c) ACCUMULATES failures, prints each failing seed, and exits NONZERO if any seed failed.

Expected: exit 0, 30/30 PASS.

- [ ] **Step 5: Neighbor-impact verification**

Run: `npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/store/terminalDirectoryThunks.test.ts test/unit/client/store/sidebar-staleness.test.ts`

Expected: PASS (helper semantics unchanged — only newly consumed by this file).

- [ ] **Step 6: Delete the scratch probe and commit**

```bash
rm test/unit/client/components/__ws-bootstrap-interlock.probe.test.tsx
git add test/unit/client/components/App.ws-bootstrap.test.tsx
git commit -m "test(app): hermetic thunk-state isolation for WS bootstrap recovery suite (load-flake fix)"
```

Expected: commit contains ONLY the test-file change; working tree otherwise clean.

### Task 3: Verification gate — 3 consecutive full client-suite runs + server suite

**Files:**
- Create (evidence, untracked): `/home/dan/code/freshell/.worktrees/.the-usual-logs/ws-bootstrap-recovery-flake/reports/verification-gate.md`
- No repository files changed.

**Interfaces:**
- Consumes: the committed Task 2 fix at the final HEAD.
- Produces: gate evidence satisfying the verification bar (3 consecutive client-suite passes with the target test passing) plus the executing-plans full-suite gate (both configs, coordinator-owned paths).

- [ ] **Step 1: Three consecutive full client-suite runs at the final HEAD (no extra load)**

Run three times, sequentially, with `FRESHELL_TEST_SUMMARY='ws-bootstrap flake fix gate <i>'` where `<i>` is 1, 2, 3:

`npm run test:vitest -- run --config config/vitest/vitest.config.ts`

Expected: green in all three runs; the target test passes in every run. Any other-test failure is recorded in the progress ledger as a bug unless it ALSO reproduces at base_ref — for those, run file-isolation plus (if isolation is green) one full-suite run at base_ref and record the reproduction receipt; only then may it be carried as an allowed pre-existing load-flaky failure.

- [ ] **Step 2: Server suite at the final HEAD**

Run: `npm run test:vitest -- run --config config/vitest/vitest.server.config.ts`

Expected: green except failures with base_ref reproduction receipts recorded in the progress ledger.

- [ ] **Step 3: Record the gate**

Write the gate report (per-run totals, target-test result per run, receipts for any carried pre-existing failures) and append the gate entry (time, HEAD, exact commands, trigger reason, result) to the progress ledger at `<git-dir>/usual-sdd/progress.md`.

---

## Notes and explicit non-goals

- **Production code is not changed** unless Task 1's captured dump forces it (STOP condition). The App.tsx recovery twin-guards (`bootstrapDataLoading` etc. returning `true` while a twin leg is in flight; one-deep rerun latch) remain a documented design smell (`plan-bootstrap-code.md` L2) for the recap/follow-up, not this change.
- **The in-file straggler channel is closed even though the captured organic instance is not yet proven to use it** — the organic instance ran BEFORE the known queue-loop siblings in shuffle order, so the organic channel may differ (the instrumented hammer decides). The boundary resets close ALL residue channels of that class symmetrically; the added fence makes the target test fail honestly if any channel reopens.
- The failure signature is taken from the raw baseline log (`/tmp/freshell-baseline.log:1861-1877`), not paraphrase: `App.ws-bootstrap.test.tsx:598:91`, duration 486 ms (not a timeout), suite seed `1786259877991`, machine `/home/dan/code/freshell/.worktrees/settings-proto-strict-reject` (same checkout path as this worktree's git metadata dir).
