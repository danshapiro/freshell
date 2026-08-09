# App WS Bootstrap Recovery Flake Fix Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.
>
> **STATUS: EXECUTED.** All checkboxes are now checked as executed; in-flight corrections
> recorded by delta review are annotated inline. Execution ledger: this worktree's git dir `usual-sdd/progress.md`. Addenda: gate remediations `6fd4e1ec1`/`54993c4f1`/`7d009f995` (server onceIdle, causally disjoint from the fix, receipted at base_ref afterwards) and committed regression guard `1b8f57e71` (delta-review round 4).

**Goal:** Eliminate the load-dependent flakiness of `test/unit/client/components/App.ws-bootstrap.test.tsx > "App WS bootstrap recovery > recovers bootstrap-owned provider availability and sidebar filters after transient pre-ready 503s"`, proven by a deterministic reproduction of the observed failure signature that fails before the fix and passes after, plus the task's full verification bar.

**Architecture:** Root cause (empirically established — see evidence base): the vitest jsdom environment injects Node's worker-global `BroadcastChannel` into every test file's window, so `persistMiddleware` layout broadcasts from OTHER test files can be delivered into a listener registered later by **this** file's mounted `App` (`installCrossTabSync`, App.tsx:312-315 → `handleIncomingRawDeduped` → `dispatchHydrateLayoutFromPersisted`, crossTabSync.ts:150-225/363-372). Delivery is intermittent (worker pairing + teardown timing — measured 2/6 with a two-file probe), which is the flake's load/shuffle dependence. When a broadcast layout containing a codex tab titled `Codex` lands during the target test's bootstrap window, `handleIncomingRaw` hydrates it into the test store's `tabs`/`panes`, the sidebar selector's tab/pane fallback path (`buildSessionItems`, sidebarSelectors.ts:374-469) emits a fallback row titled `Codex`, which activity-sorts ahead of the two payload sessions (timestamps 10/9 vs a real epoch) — producing the exact observed diff `expected [ 'Manual Session' ], received [ 'Codex', 'Manual Session' ]` at test line 598 with intact mock counters and no timeout (486 ms). In-file intransit copies are impossible (selector inputs carry no `Codex`-titled rows); the delivered layout is the only consistent explanation. Fix (test-side only, analogous to the file's existing ws-client mock): stub `BroadcastChannel` with an inert implementation for THIS test file's lifecycle so no cross-file layout can be hydrated mid-test, plus the repo-established thunk-state resets that close a second, independently proven in-file residue channel (queue-refresh stragglers consuming the test's sequenced mock quotas), plus one additive fence assertion.

**Tech Stack:** Vitest 3.2.4 (threads pool, jsdom, `sequence.shuffle`), React Testing Library, Redux Toolkit, TypeScript.

## Global Constraints

- Red-Green-Refactor TDD. The RED evidence for the fix is the poison-transport probe (Task 1) failing with the EXACT observed signature against the unfixed file; the organic instrumented capture is best-effort enrichment, NOT a commit gate (an 0-of-N organic result is a recorded outcome, not a deadlock) — the root cause is already established by the channel experiments below.
- NEVER weaken the target test: no deleted or loosened assertions, no retry wrappers, no skips, no timeout inflation. All changes are additive (a beforeEach environment stub; thunk-state reset calls matching six sibling files; one added fence assertion). Test-side environment isolation is the same legitimate move as the file's existing `@/lib/ws-client` and `@/lib/api` mocks; cross-tab layout sync is not what this file tests (its stores never install `persistMiddleware`, and nothing in it asserts cross-tab behavior).
- No `src/` changes in this plan. Test-file scope: `test/unit/client/components/App.ws-bootstrap.test.tsx` carries the fix. EXCEPTION RECORDED DURING EXECUTION (delta-review round 1, finding 2): a full-suite gate failure in `test/unit/server/fresh-agent/opencode-serve-manager.test.ts` (onceIdle) could not be reproduced at base_ref in 4 runs but is provably causally disjoint from this delta (the server vitest config does not include client tests) — per the executing-plans gate's remediation rule it was remediated in-branch as a gate gatekeeper action (original commit 6fd4e1ec1, corrected by 54993c4f1 after review found the first remediation targeted the wrong timeout: the inner `onceIdle(..., 100)` deadline, whose expiry rejects and tears down the poll loop, deadlocking the test — now raised to 10s alongside the outer budget). The remediating scope expansion is thus deliberate and auditable, not accidental. Scratch probes are untracked and deleted before the final fix commit.
- Broad runs: the task text pins `npx vitest run --config config/vitest/vitest.config.ts` as the gate command (a specific instruction that outranks generic repo guidance). `npm run test:vitest -- run --config config/vitest/vitest.config.ts` is the repo-owned wrapper for that exact command. Known limitation (delta-review round 1, finding 3): this is a coordinator passthrough, so the pre-run `npm run test:status` check has a TOCTOU race — another agent could take the gate just after the check. Accepted mitigations actually used: status-checked immediately before each run, runs strictly sequential, `FRESHELL_TEST_SUMMARY` set so a later holder sees the human-meaningful reason, no foreign process ever killed. The composite `npm test` is NOT used for this bar because its runner terminates the sibling suite on first failure, which would corrupt exactly the "3 consecutive full client-suite runs" evidence the task demands. Residual risk is documented, not hidden.
- Commits use the repo git identity; do not create a PR.
- Absolute run values (no placeholders): worktree = `/home/dan/code/freshell/.worktrees/ws-bootstrap-recovery-flake`; logs_dir = `/home/dan/code/freshell/.worktrees/.the-usual-logs/ws-bootstrap-recovery-flake/`; base_ref = `4c2297667f7c59758b4aeb8848cf7eddc1710cfc`; progress ledger = `<git-dir>/usual-sdd/progress.md` where git-dir comes from `git rev-parse --git-dir` (currently `/home/dan/code/freshell/.git/worktrees/settings-proto-strict-reject`).

## Verification bar (from the task specification)

1. A deterministic reproduction fails before the fix and passes after (Task 1 probe RED → Task 2 probe GREEN).
2. The target test passes in isolation (its file alone).
3. The target test passes in 3 consecutive full client-suite runs of `npx vitest run --config config/vitest/vitest.config.ts` (executed via the repo-owned passthrough `npm run test:vitest -- run --config config/vitest/vitest.config.ts`, same command semantics). Each of the three runs must let that client suite run to completion; a run counts only if the target test passed, and any other failure must carry a base_ref reproduction receipt recorded in the progress ledger before the run is allowed. The server config is also run once at final HEAD under the same receipt rule.

## Evidence base (already produced; absolute paths)

- `/tmp/freshell-baseline.log:1861-1877` — the raw organic failure at base_ref: `AssertionError: expected [ 'Codex', 'Manual Session' ] to deeply equal [ 'Manual Session' ]` at `App.ws-bootstrap.test.tsx:598:91`, 486 ms (no timeout), suite seed `1786259877991`, one failure / 4912 tests.
- `/home/dan/code/freshell/.worktrees/.the-usual-logs/ws-bootstrap-recovery-flake/reports/plan-bootstrap-code.md` — production-path trace (bootstrap/recovery legs, thunk module state, selector purity).
- `/home/dan/code/freshell/.worktrees/.the-usual-logs/ws-bootstrap-recovery-flake/reports/plan-test-infra.md` — vitest mechanics.
- `/home/dan/code/freshell/.worktrees/.the-usual-logs/ws-bootstrap-recovery-flake/reports/load-bearing-validator-B.md` — in-file straggler-quota probe RED/GREEN (secondary channel).
- Cross-file channel experiments (this investigation; logs under `/tmp/xshare-*` and summarized in the Task 1 evidence report):
  1. The test env's `BroadcastChannel` is NOT jsdom-native: jsdom has no living implementation; vitest's jsdom env injects the worker's Node `globalThis.BroadcastChannel` (`node_modules/vitest/dist/chunks/index.CmSc2RE5.js:441-452`). So the channel sphere is shared beyond a single file's jsdom/registry.
  2. Two-file probe (`__xshare-a` posts `{…note:'Codex'}` on `freshell.persist.v2`, keeps the channel open; `__xshare-b` registers later): the later file's listener RECEIVED the earlier file's message in 2/6 runs (and the enclosing file showed fresh globals/localStorage). Delivery is real and intermittent — the flake's statistical profile.
  3. Hydration accepts a parseable layout and merges it into the mounted store (`dispatchHydrateLayoutFromPersisted`, crossTabSync.ts:150-225); `persistedAt` arbitration only governs conflicts over tabs that exist locally — remote-only tabs/layouts are always merged in, so an empty local `persistedAt` never blocks the poison.
- In-file failing-order replay: vitest's installed shuffle algorithm with seed `1786259877991` places the target test 10th of 36, directly after siblings that start fire-and-forget queue refreshes (`terminal.inventory` at file line 973-977) — additional in-file residue exposure, addressed by the secondary fix items.
- Falsified alternate hypothesis (recorded for the record): per-file isolation of globals/localStorage held (experiment measured nulls); the ONLY measured cross-file transport is the BroadcastChannel.

---

### Task 1: Deterministic reproduction of the observed signature (poison-transport probe)

**Files:**
- Create (scratch, untracked): `test/unit/client/components/__ws-bootstrap-broadcast-poison.probe.test.tsx`
- Create (evidence, untracked): `/home/dan/code/freshell/.worktrees/.the-usual-logs/ws-bootstrap-recovery-flake/reports/flake-repro-evidence.md`
- No tracked repository files are added, modified, or deleted.

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the RED log `/tmp/probe-poison-nofix.log` showing the exact organic signature, and the evidence report.

- [x] **Step 1: Build the poison-transport probe**

The probe file replicates the target test's ENTIRE setup (copy the imports/mocks/`createStore`/`beforeEach`/`afterEach` from the unfixed `App.ws-bootstrap.test.tsx`) and contains ONE test that runs the target test's exact flow with ONE addition: while App is mounted and its `installCrossTabSync` BroadcastChannel listener is live, post the poison layout through a REAL `BroadcastChannel` on `freshell.persist.v2` (delivery to an already-registered listener in the same jsdom sphere is deterministic — no backlog dependence):

1. Build the poison message exactly as `persistBroadcast.broadcastPersistedRaw` does (`{ type: 'persist', key: LAYOUT_STORAGE_KEY, raw, sourceId: 'poison-probe' }` posted via `new BroadcastChannel('freshell.persist.v2')`), where `raw` is a JSON layout `{ version: 4, persistedAt: Date.now(), tabs: { activeTabId: 'poison-codex-tab', tabs: [{ id: 'poison-codex-tab', mode: 'codex', status: 'running', title: 'Codex', createdAt: <now>, lastActivityAt: <now> }] }, panes: { version: 7, layouts: { 'poison-codex-tab': { type: 'leaf', id: 'poison-pane', content: { kind: 'terminal', createRequestId: 'poison-req', status: 'running', mode: 'codex', shell: 'system', terminalId: 'poison-term', sessionRef: { provider: 'codex', sessionId: 'poison-codex-session' } } } }, activePane: { 'poison-codex-tab': 'poison-pane' }, paneTitles: {}, paneTitleSetByUser: {} }, tombstones: [] }`.
2. Injection timing: inside an `act()` immediately after the target flow's first `waitFor` (the posted message is delivered asynchronously on the channel; the flow's remaining `waitFor`s give it ample room to hydrate before the final selector assertion).
3. Every other assertion of the target test remains UNCHANGED — including the final selector assertion `expect(…titles…).toEqual(['Manual Session'])`.

Run: `npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/components/__ws-bootstrap-broadcast-poison.probe.test.tsx --reporter=basic` (log to `/tmp/probe-poison-nofix.log`)

Expected: FAIL deterministically at the replicated line-598 assertion, with received `[ 'Codex', 'Manual Session' ]` — byte-identical in shape to `/tmp/freshell-baseline.log:1861`. If the hydrolysis does not take (e.g. `hydrateTabs` declines without a local `persistedAt`), inject earlier/more visibly and/or craft `persistedAt`/`localStorage` seeding per the `installCrossTabSync` dedupe reading (crossTabSync.ts:303-311) until RED reproduces; the probe must DEMONSTRATE the channel, and the report must record what was needed. If no crafting makes it RED, STOP — the root cause story is wrong; report for re-planning.

- [x] **Step 2: Record the evidence**

Write the evidence report containing: the root-cause narrative; the two-file channel experiment results (2/6 delivery, fresh globals/localStorage otherwise); the poison probe's RED excerpt; the secondary in-file channel summary (validator-B); the explicit conclusion that product code is behaving as designed and the defect is test-environment isolation (if the probe disagreed, stop and re-plan instead).

### Task 2: Fix — hermetic test environment for this file

**Files:**
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx` (imports near :18; `beforeEach` at :266-307; `afterEach` at :309-312; target-test fence at ~:559-563)
- Test: same file (36 tests must pass in isolation and adversarial orderings).

**Interfaces:**
- Consumes: nothing beyond the file itself and the two reset helpers (`src/store/sessionsThunks.ts:59`, `src/store/terminalDirectoryThunks.ts:41`).
- Produces: the fixed, hermetic test file.

- [x] **Step 1: Apply the fix (additive edits only)**

1. Add imports after line 18:
```ts
import { _resetSessionWindowThunkState } from '@/store/sessionsThunks'
import { _resetTerminalDirectoryThunkControllers } from '@/store/terminalDirectoryThunks'
```
2. Add near the other mock helpers:
```ts
// This environment's BroadcastChannel is the worker-global Node channel injected
// into every jsdom by vitest, so persistMiddleware layout broadcasts from OTHER
// test files can be delivered into installCrossTabSync's listener mid-test
// (observed empirically). This file does not test cross-tab sync, so isolate it.
class InertBroadcastChannel {
  static readonly name = 'BroadcastChannel'
  readonly name: string
  onmessage: ((event: MessageEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  constructor(channelName: string) {
    this.name = channelName
  }
  postMessage(_message: unknown): void {}
  close(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean { return false }
}
```
3. In `beforeEach`, after `vi.resetAllMocks()`: `vi.stubGlobal('BroadcastChannel', InertBroadcastChannel)` and then `_resetSessionWindowThunkState()` + `_resetTerminalDirectoryThunkControllers()`.
4. In `afterEach`, after `cleanup()`: `_resetSessionWindowThunkState()` and `_resetTerminalDirectoryThunkControllers()`. (`vi.unstubAllGlobals()` already runs there and removes the stub.)
5. In the target test's first `waitFor` (~:559-563) add ONE assertion: `expect(wsMocks.connect).toHaveBeenCalledTimes(1)` — `connect()` is bootstrap's final awaited step, so this proves the initial chain fully unwound before `ready` is injected; additive only.
6. Ensure any temporary forensic instrumentation is absent (the tree must not contain it).

- [x] **Step 2: Focused GREEN**

Run: `npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/components/App.ws-bootstrap.test.tsx`

Expected: 36/36 PASS.

- [x] **Step 3: Deterministic repro passes after the fix — REVISED during execution (delta-review round 2, finding 1)**

The first probe revision was vacuous post-fix: its poison sender was built with the stubbed inert class, so no message was ever attempted. The executed revision (Task 5) uses the real fixed topology: the probe captures the worker-native `BroadcastChannel` at module scope (`const NativeBroadcastChannel = globalThis.BroadcastChannel`) and posts the poison layout with the NATIVE class (exactly what a foreign test file's `persistMiddleware` does), while the mounted App's receiver is whatever the copied file's hooks installed. Two scratch variants: `__ws-bootstrap-poison-v2-unfixed.probe.test.tsx` (no stub in `beforeEach`) and `__ws-bootstrap-poison-v2-fixed.probe.test.tsx` (stub present — mirrors the fixed file).

Evidence: unfixed variant → FAILS with the exact organic signature, 3/3 (`/tmp/probe-poison-v2-nofix.log`); fixed variant → PASSES 2/2 (`/tmp/probe-poison-v2-fixed.log`). A fixed-variant failure with the Codex row would have meant incomplete receiver isolation — it did not occur.

- [x] **Step 4: Adversarial sweep under saturation (strict, self-contained)**

Create `/tmp/flake-sweep-fixed.sh` with EXACTLY this content (strict failure accounting, burner lifecycle, failing-seed replay included):

```bash
#!/usr/bin/env bash
set -u
SWEEP_OUT=/tmp/flake-sweep-fixed
mkdir -p "$SWEEP_OUT"
BURNERS=()
for _ in $(seq 1 "$(nproc)"); do (yes > /dev/null 2>&1) & BURNERS+=($!); done
cleanup() { kill "${BURNERS[@]}" 2>/dev/null || true; wait 2>/dev/null || true; }
trap cleanup EXIT
FAILS=0
# Recorded organic failing in-file order first
for rep in 1 2 3 4 5; do
  npm run test:vitest -- run --config config/vitest/vitest.config.ts \
    test/unit/client/components/App.ws-bootstrap.test.tsx \
    --sequence.seed=1786259877991 --reporter=basic > "$SWEEP_OUT/replay-$rep.log" 2>&1 \
    || { FAILS=$((FAILS+1)); echo "FAILING SEED REPLAY $rep FAILED"; }
done
for i in $(seq 1 30); do
  npm run test:vitest -- run --config config/vitest/vitest.config.ts \
    test/unit/client/components/App.ws-bootstrap.test.tsx \
    --sequence.seed="$i" --reporter=basic > "$SWEEP_OUT/seed-$i.log" 2>&1 \
    || { FAILS=$((FAILS+1)); echo "SEED $i FAILED"; }
done
echo "sweep failures: $FAILS"
[ "$FAILS" -eq 0 ]
```

Run: `bash /tmp/flake-sweep-fixed.sh`

Expected: `sweep failures: 0`, script exit status 0 (35/35).

- [x] **Step 5: Neighbor-impact verification**

Run: `npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/store/terminalDirectoryThunks.test.ts test/unit/client/store/sidebar-staleness.test.ts`

Expected: PASS (helper semantics unchanged; cross-tab-sync tests in other files are untouched because the stub is scoped to this file's lifecycle hooks).

- [x] **Step 6: Delete scratch probes and commit**

```bash
rm -f test/unit/client/components/__ws-bootstrap-interlock.probe.test.tsx \
      test/unit/client/components/__ws-bootstrap-broadcast-poison.probe.test.tsx \
      test/unit/client/components/__ws-bootstrap-poison-v2-fixed.probe.test.tsx \
      test/unit/client/components/__ws-bootstrap-poison-v2-unfixed.probe.test.tsx \
      test/unit/client/__xshare-a.probe.test.ts \
      test/unit/client/__xshare-b.probe.test.ts
git add test/unit/client/components/App.ws-bootstrap.test.tsx
git commit -m "test(app): isolate WS bootstrap recovery suite from cross-file broadcasts and thunk residue (load-flake fix)"
```

(Executed note: delta-review round 3 caught that the v2 probes — added after this command was first written — matched vitest's default `*.test.tsx` discovery and would have entered (and failed) subsequent full-suite gate runs. They were deleted before any further gate run. Every scratch probe is now listed here; the worktree must show zero untracked `*.probe.test.*` files before Task 3.)

Expected: commit contains ONLY the target test file; working tree otherwise clean (scratch probes never committed).

### Task 3: Verification gate — 3 consecutive full client-suite runs + server suite

**Files:**
- Create (evidence, untracked): `/home/dan/code/freshell/.worktrees/.the-usual-logs/ws-bootstrap-recovery-flake/reports/verification-gate.md`
- No repository files changed.

**Interfaces:**
- Consumes: the committed Task 2 fix at the final HEAD.
- Produces: gate evidence satisfying the verification bar.

- [x] **Step 1: Three consecutive full client-suite runs at the final HEAD**

For each run `<i>` of 1, 2, 3, sequentially, with NO other load on the machine: first `npm run test:status` (if another broad run holds the coordinator, wait); then:

`FRESHELL_TEST_SUMMARY="ws-bootstrap flake fix gate <i>" npm run test:vitest -- run --config config/vitest/vitest.config.ts`

Expected per run: the suite runs to completion and the target test passes. Any other failure is recorded in the progress ledger as a bug; it may be carried past the gate only after it ALSO reproduces at base_ref (file-isolation run plus, if isolation is green, one full-suite run at base_ref) with the reproduction receipt recorded in the ledger. A run in which the target test fails can never count; all three runs must satisfy the criterion consecutively.

- [x] **Step 2: Server suite at the final HEAD**

Same discipline, one run: `FRESHELL_TEST_SUMMARY="ws-bootstrap flake fix gate server" npm run test:vitest -- run --config config/vitest/vitest.server.config.ts`

Expected: suite completes; failures only with base_ref reproduction receipts in the ledger.

- [x] **Step 3: Record the gate**

Write the gate report (per-run totals, target-test result per run, receipts) and append the gate entry (time, HEAD, exact commands, trigger reason, result) to the progress ledger.

---

## Notes and explicit non-goals

- **Production code is not changed.** `installCrossTabSync` doing cross-tab layout hydration during bootstrap is intended product behavior; the defect is that the test environment lets OTHER FILES' broadcasts deliver into it. Repo-wide test-hygiene follow-up (out of scope, for the recap): consider namespacing or stubbing `BroadcastChannel` in `test/setup/dom.ts` for all jsdom tests, since any App-mounting test file is exposed to the same poisoning. Files whose tests DO exercise cross-tab sync/persist (e.g. crossTabSync/persist/tabRegistrySync suites) must keep a functional channel, which is why this plan stubs only the affected file.
- **Secondary channel kept in scope:** the in-file thunk-residue channel (probe-proven quota drift) is closed by the boundary resets, mirroring six sibling files (`test/e2e/sidebar-search-flow.test.tsx:157/172`, `test/e2e/sidebar-repo-filter-flow.test.tsx:140/155`, `test/e2e/sidebar-agent-filter-flow.test.tsx:140/155`, `test/e2e/sidebar-refresh-dom-stability.test.tsx:227/259`, `test/unit/client/store/sidebar-staleness.test.ts:74/77`, `test/unit/client/store/sessionsThunks.test.ts:76/80`).
- **The App.tsx recovery twin-guards** (`bootstrapDataLoading`/`platformDetailsLoading`/`sidebarWindowLoading` returning `true` while a twin leg is in flight; the one-deep recovery rerun latch) remain a documented design smell (`plan-bootstrap-code.md` L2) for the recap/follow-up, not this change.
- Failing-run in-file order (replay of the installed shuffle with seed `1786259877991`): target 10th of 36. This informed the secondary-channel analysis; the primary channel is the cross-file broadcast poison established above.
