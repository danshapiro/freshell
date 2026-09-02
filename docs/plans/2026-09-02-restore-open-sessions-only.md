# Recovery Offer Excludes Never-Open Sessions — Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Freshell's restore-from-server-memory path (the "Restore N panes from server memory?" recovery offer and its inventory→plan→rebuild pipeline) no longer offers or recreates sessions that were not actually open in the user's tabs; accepting the prompt restores exactly the sessions that were genuinely open, in their original tabs, instead of dumping never-open sessions into the last tab.

### Explicit constraints
- Investigate and fix the restore path itself (the recovery inventory and plan pipeline), not merely the visible symptom.
- Work happens in the dedicated worktree `the-usual/restore-open-sessions-only`; use the repository's coordinated test commands for verification.
- No pull request is created without explicit user approval.

### Accepted tradeoffs and residuals
- None stated.

**Goal:** The recovery offer's ledger-derived "Recovered sessions" tab only ever contains sessions provably open when the server lost the client — the 30-day tail of Bound ledger bindings (closed fresh-agent panes, natural-exit CLI rows, headless REST/MCP lineage rows) never reaches the offer or the rebuilt layout.

**Architecture:** The junk enters server-side: `build_inventory` (`crates/freshell-server/src/recovery_inventory.rs:254-265`) emits as `ledgerOnly` every Bound ledger row unreferenced by any snapshot union and not live — with no recency floor. Ledger rows survive 30 days and are retired only by the WS `terminal.kill` path; fresh-agent pane closes (`freshAgent.kill`), natural CLI exits, and headless REST/MCP bindings never retire their rows, so every such session becomes a permanent offer candidate (a prior live probe measured 301 rows). The client (`build-recovery-plan.ts:62-70`) dumps that bucket into ONE trailing "Recovered sessions" tab, which also becomes the active tab. The fix keeps the bucket but grounds it in evidence: an unreferenced Bound row is offered ONLY if it was bound within one grace window (15s = 3× the client's 5s diff-push cadence) of the newest retained snapshot evidence (`capturedAt` — server-stamped at persist — over the already-selected foreign generation unions). A row older than that was provably absent from a push made *after* it bound, i.e. it was not actually open when the evidence was captured. This preserves the deliberate SIGKILL-within-5s-of-creation identity-survival contract (the row is bound seconds before the evidence froze) while permanently excluding the never-open tail. No client changes; the response shape is unchanged (`ledgerOnly` stays, now tightly scoped).

**Tech Stack:** Rust workspace crates (`freshell-server` inventory builder + tests, `freshell-ws` comment truthfulness), Vitest/Playwright e2e (`test/e2e-browser/specs/recover-my-panes-rust.spec.ts`, rust-chromium project).

## Global Constraints

- Work ONLY in `/home/dan/code/freshell/.worktrees/restore-open-sessions-only` on branch `the-usual/restore-open-sessions-only`. Never commit to or push `main`. No PR creation (user approval gate stays with the orchestrator).
- TDD red→green→refactor for every behavior change; never weaken, skip, or delete tests to obtain a green run. A deliberately-flipped contract pin is rewritten to assert the NEW contract, never vacated, and never asserted vacuously (a pin whose scenario cannot produce the junk row pre-fix is a test bug, not a pass).
- Test commands: no raw `npx vitest` — use `npm run test:vitest -- ...`; cargo tests run from the worktree root and are NOT behind the coordinator gate; broad suites only via `npm run check`/`npm test` (coordinator-aware); check the coordinator with `npm run test:status` first and never kill a foreign holder. Set `FRESHELL_TEST_SUMMARY` for broad runs.
- Rust CI parity: `cargo clippy --workspace --all-targets -- -D warnings` must be clean.
- Never set `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1`. Never restart the live production server (port 3001) or any server this run did not start. E2E servers use the RustServer helper's ephemeral loopback ports only.
- Follow repo comment/doc conventions: comments that describe behavior this change removes must be re-worded to stay truthful (`docs/index.html` and `AGENTS.md` are checked and only touched if they actually describe the old behavior; historical plan docs under `docs/plans/` are never rewritten).
- Commits use the repo's existing git identity; commit messages follow the repo's conventional-commit style.

### Contract supersession note (for reviewers)

`docs/plans/2026-07-26-recover-my-panes.md` D4 defined `ledgerOnly` as "all bound rows referenced by no device union and not live". This plan narrows that rule with the evidence-recency floor above (call it **D8**). Pinned tests that encode the old blanket rule are rewritten to the new contract — they are listed by name in Task 2. Deliberate residual accepted by this contract: a pane created in the final seconds of a browser's FIRST-EVER session (before its very first WS-ready push, with zero retained generations anywhere) has no snapshot evidence and is not offered; every other kill-near-create case retains recovery because pushes begin at WS-ready.

---

### Task 1: E2E contract pin — never-open sessions are invisible in the inventory, the offer, and therefore the rebuilt layout

**Files:**
- Modify: `test/e2e-browser/specs/recover-my-panes-rust.spec.ts` (append one scenario to the existing serial describe; follow the file's idioms exactly — `installFakeCli`, `seedConfig`, `selectShellIfPickerShowing`, `openCliPane`, `connect`, `openFreshContextWithOffer`, `waitForSnapshotContaining`, the standalone-`APIRequestContext` probe idiom of `waitForRecoverable`, `readArgvLog`/`sessionIdsOf`)

**Interfaces:**
- Consumes: the spec's existing helpers and shared serial-suite state (ONE owned Rust server across scenarios); `GET /api/recovery/inventory` authenticated with the `x-auth-token` header via a STANDALONE Playwright `APIRequestContext` (`request.newContext({ baseURL: info.baseUrl, extraHTTPHeaders: { 'x-auth-token': info.token } })`) — never `page.request` and never the navigated page (a booted page registers as a tabs.sync client and entangles the inventory; see the `waitForRecoverable` comment at spec :171-181).
- Produces: a new test named so a `-g` filter selects it: `test('stale never-open ledger rows are never offered', ...)`.

- [ ] **Step 1: Write the failing behavioral test**

Append one scenario that proves the user's story end to end. The scenario needs a ledger row that is (a) BOUND, (b) UNREFERENCED by every newest-per-client retained union, and (c) bound well before the newest snapshot evidence. **Producer hazard — the pin is vacuous if the row gets retired:** closing a UI terminal pane sends the WS `terminal.kill`, which is the ONLY `retire_closed` caller (retired rows are excluded from the bucket regardless of this fix). The scenario must therefore use a producer whose row stays Bound after the pane goes away. Recipe decision rule (Stage 2 validator resolves; implement ONLY the resolved recipe):

1. **Primary candidate — fresh-agent pane closed via UI:** `freshAgent.kill` never retires the ledger row (no close hook on the identity sink), so the row stays Bound; the post-close push makes it unreferenced. Use only if the validator confirms this suite can drive a fake fresh-agent pane deterministically with the existing harnesses.
2. **Fallback — natural-exit CLI pane, then UI close:** the fake CLI exits on its own (row stays Bound — natural exit never retires), then the UI pane close. Use only if the validator confirms the kill path for an already-exited terminal does NOT retire the row (`terminal.rs` kill/retire reachability for exited terminals).
3. **Fallback — REST/headless lineage binding:** a REST-driven agent row never enters any snapshot (unreferenced from birth) and is never retired. Use only if the validator confirms the REST path is drivable in this suite without a real provider.

Whichever producer is used, the scenario's shape and assertions are producer-agnostic:

1. Create the junk session in context A (already-connected or a fresh `browser.newContext(FRESH_CONTEXT_OPTIONS)` with `connect`), capture its `SESSION_ID` (argv log idiom or REST response), and wait for its ledger binding row on disk under `<home>/.freshell/pane-ledger/bindings/` capturing the row's `createdAt` as `bindMs` (scenario 1's disk-wait idiom at spec :384-390).
2. Ensure at least one retained union REFERENCES the session's pane if it had one (snapshot-content wait idiom); for a headless producer nothing references it from birth — both classes must be handled identically by the assertions below.
3. Remove the pane (per the resolved recipe's close/kill) and let a post-removal push land: poll the newest persisted generation under `<home>/.freshell/tabs-snapshots/` (the `waitForNewestGenerationRecordCount` ranking idiom) until its `capturedAt > bindMs + 20_000` AND its content no longer contains `SESSION_ID`. If the recipe relies on a diff push and the close happened within the grace window, first wait (bounded, documented: the 15s grace is physical wall-clock semantics) until `Date.now() >= bindMs + 16_000` before the removal, so the post-removal diff push satisfies the threshold within ~5s. Poll timeout 120s.
4. `server.restart()` (the spec-local idiom from scenario 1), then — BEFORE opening any page — assert via the standalone API probe: the inventory's `ledgerOnly` array contains NO entry with `sessionId === SESSION_ID` (and assert the array is empty, recording in the report if shared-suite state makes a non-empty-but-excluding-SESSION_ID result necessary — do not weaken the assertion silently). RED TODAY: the row is present.
5. Open context B with `openFreshContextWithOffer(browser, 'junk-exclusion')` (fresh context = empty storage by definition; SW already blocked; the offer is REQUIRED here because the surviving snapshot panes keep `recoverable` true) and assert the offer's rendered list never mentions `SESSION_ID`.
6. The dump-into-last-tab mechanism itself is transitively pinned — do NOT click accept (the shared-suite primary union may carry scenario-4's 40-tab phone layout within its staleness window, making post-accept tab counts non-deterministic): the client unit pin `build-recovery-plan.test.ts:85-95` already maps every `ledgerOnly` entry to the trailing "Recovered sessions" tab, so an empty bucket provably produces no junk tab. Record this reasoning in the test comment.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/recover-my-panes-rust.spec.ts -g 'stale never-open ledger rows'`

Expected: FAIL because the stale row is still returned in `ledgerOnly` and rendered in the offer — assertions 4-5 trip on the current blanket bucket. A failure caused by the row having been retired (hazard above), by harness/timing mistakes, or by the offer not appearing is NOT acceptable red: iterate until it fails on the row's presence.

- [ ] **Step 3: Minimal production implementation**

None in this task — the pin lands RED against the unfixed server by design; Task 2 turns it green.

- [ ] **Step 4: Run the focused test**

Same command as Step 2. Expected: FAIL (the pinned red). Record the failure output excerpt in the implementer report as the RED evidence for Task 2's green.

- [ ] **Step 5: Refactor while green**

No green refactor here; ensure the scenario matches the file's conventions (helper reuse, comment style, serial-suite ordering — append LAST so shared state is never disturbed for earlier scenarios).

- [ ] **Step 6: Run impacted-test verification**

The new scenario is additive and the describe is serial; run the whole spec to prove earlier scenarios still pass with it appended:

Run: `npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/recover-my-panes-rust.spec.ts`

Expected: every pre-existing scenario PASS; ONLY the new scenario FAILS (the pinned red, recorded in the progress ledger as intentional red-until-Task-2). Any broad suite is NOT run at this stage.

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/recover-my-panes-rust.spec.ts
git commit -m "test(recovery): pin that stale never-open ledger rows are never offered

Red e2e contract pin: the recovery inventory's ledgerOnly bucket (and the
recovery offer built from it) currently includes Bound ledger rows from
sessions that were not actually open when the newest snapshot evidence was
captured (freshAgent.kill closes, natural exits, headless REST/MCP rows) —
they get dumped into a trailing 'Recovered sessions' tab. This scenario
asserts the new contract (D8 evidence-recency floor); it is RED until the
server-side filter lands."
```

---

### Task 2: Server-side evidence-recency floor for the ledgerOnly bucket (+ comment truthfulness)

**Files:**
- Modify: `crates/freshell-server/src/recovery_inventory.rs` (filter, constant, union-evidence computation)
- Modify: `crates/freshell-server/src/recovery_inventory_tests.rs` (contract rewrite — listed below)
- Modify: `crates/freshell-ws/src/pane_ledger.rs:~615-623` (`delete_binding` doc comment)
- Modify: `crates/freshell-ws/src/terminal.rs:~3337-3346` (spawn-failure comment)
- Modify: `crates/freshell-ws/src/pane_ledger_tests.rs` (comment near `:446-450`)
- Modify: `crates/freshell-ws/tests/pane_ledger_triggers.rs` (comment near `:118-126`)

**Interfaces:**
- Consumes: `BindingRow.created_at` (`crates/freshell-ws/src/pane_ledger.rs:108`) — the durable bind time; the already-plumbed `DeviceUnion.union_doc["capturedAt"]` values (max server-stamped capture of each union's selected generations, composed in `tabs_persist.rs`); existing filters (`row_is_bound`, A4 referenced-rule, D7 live-rule) in `build_inventory`.
- Produces: no public API change — `GET /api/recovery/inventory` keeps its shape; `ledgerOnly` now contains only rows within the grace window. One new private constant documented as D8:
  `const UNSNAPSHOTTED_BINDING_GRACE_MS: u64 = 15_000;`

- [ ] **Step 1: Write the failing behavioral tests (unit + route contract rewrite)**

In `recovery_inventory_tests.rs`, rewrite the blanket-era pins to the D8 matrix. Drafts (adapt to the file's existing fixture builders; unions carry explicit `capturedAt` so the matrix is wall-clock-free):

```rust
// REPLACES unreferenced_bound_rows_become_ledger_only (:227-232)
#[test]
fn unreferenced_row_bound_within_grace_of_latest_evidence_is_offered() {
    // evidence capturedAt = 1_000_000; row created_at = 995_000 (5s before
    // the evidence froze — the SIGKILL-within-5s window) => STILL offered.
    ...
    assert_eq!(out["ledgerOnly"][0]["sessionId"], "C9");
}

// NEW — the user's bug
#[test]
fn unreferenced_row_bound_before_latest_evidence_minus_grace_is_not_offered() {
    // evidence capturedAt = 1_000_000; row created_at = 900_000
    // (bound 100s before the newest retained snapshot) => excluded,
    // and when nothing else remains, not recoverable.
    ...
    assert_eq!(out["ledgerOnly"].as_array().unwrap().len(), 0);
    assert_eq!(out["recoverable"], false); // when the row was the only candidate
}

// NEW — no snapshot evidence at all means nothing unreferenced is provably open
#[test]
fn ledger_only_rows_without_any_snapshot_evidence_are_not_offered() {
    // unions empty; one Bound row => ledgerOnly empty, recoverable false.
    ...
}
```

The `route_serves_ledger_only_recovery_without_snapshots` route test (:514-536) is rewritten in place to the new contract: bound row, no snapshot contents → 200 OK with `recoverable == false`, `device == null`, empty `ledgerOnly`.
KEEP unchanged (must still pass as-is or with only fixture-clock alignment): `bound_row_referenced_by_non_primary_device_is_not_ledger_only` (:234), `live_effective_ref_marks_pane_live_and_live_rows_never_ledger_only` (:267), and the two `ledgerOnly == []` asserts (:145/:195 — align fixture clocks so each fixture's evidence is within grace of its rows).
Every rewritten test must assert behavior (row membership/absence, recoverable), never static copy — and each kept test must still exercise its original behavior, not a vacated version of it.

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `cargo test -p freshell-server recovery_inventory`

Expected: FAIL — the two new exclusion tests and the rewritten route test trip on the current blanket bucket; the within-grace keep-test passes already.

- [ ] **Step 3: Add the minimal production implementation**

In `crates/freshell-server/src/recovery_inventory.rs`:

1. Add the documented constant next to `STALE_CLIENT_MS` (:16):

```rust
/// D8 (restore-open-sessions-only): an unreferenced Bound row is offered only
/// when it was bound within one grace window of the newest retained snapshot
/// evidence (`capturedAt`, server-stamped at persist — see tabs_persist.rs).
/// Rows older than that were provably absent from a push made AFTER they
/// bound: they were not actually open when the evidence was captured. 15s =
/// 3x the client's 5s diff-push cadence (tabRegistrySync), so the
/// SIGKILL-within-5s-of-creation window stays recoverable while the 30-day
/// Bound tail (closed fresh-agent panes, natural exits, headless REST/MCP
/// rows) never reaches the offer.
const UNSNAPSHOTTED_BINDING_GRACE_MS: u64 = 15_000;
```

2. In `build_inventory`, after the `other_devices` block (:252), compute the evidence and gate `ledger_only` (:254-265):

```rust
// D8: newest snapshot evidence across ALL selected unions (self-excluded and
// post-boot clients already dropped by read_foreign_unions selection, so a
// fresh requester's own pushes never count as evidence of a lost session).
let latest_evidence_ms: Option<u64> = unions
    .iter()
    .filter_map(|u| u.union_doc["capturedAt"].as_u64())
    .max();
```

…and one additional filter in the existing chain:

```rust
.filter(|r| match latest_evidence_ms {
    Some(evidence) => (r.created_at.max(0) as u64)
        .saturating_add(UNSNAPSHOTTED_BINDING_GRACE_MS)
        >= evidence,
    // No snapshot evidence: nothing unreferenced is provably open (D8).
    None => false,
})
```

3. Observability (silent exclusion is undebuggable): after applying the filter, emit one structured debug line on the route's existing tracing target when rows WERE dropped, e.g. `tracing::debug!(target: "freshell_server::recovery_inventory", dropped, latest_evidence_ms, "D8 excluded stale unreferenced ledger rows from ledgerOnly")` — count only, no session payloads; gated on `dropped > 0`.

4. Re-word the four comments…

3. Re-word the four comments the D8 contract makes stale, keeping them truthful about what ghost-row deletion still protects (durable-ledger truthfulness for existence/pending-reader semantics; the offer can now only surface such a row within one grace window): the four files listed above.    Delete NOTHING in those paths — the deletion machinery is untouched; comments only.
5. Docs sweep (record findings in the implementer report): `rg -n 'ledgerOnly|recovery inventory|Recovered sessions' docs/ README.md AGENTS.md` — only edit a file if it actually documents the old blanket behavior (expected: none; historical `docs/plans/` files are never rewritten).

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-server recovery_inventory`

Expected: PASS (all D8 matrix tests green).

Then confirm Task 1's red pin turns green:

Run: `npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/recover-my-panes-rust.spec.ts -g 'stale never-open ledger rows'`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Check the filter reads as one coherent rule beside the existing A4/D7 filters (keep the chain style); confirm no now-dead imports/helpers (`row_mode`/`row_cwd` stay used — the bucket still emits rows). Re-run the Step 4 commands after any refactor.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: the whole `freshell-server` crate tests (inventory plumbing touches shared fixtures), the whole `freshell-ws` crate tests (comment-only edits — cheap full safety), the SIGKILL-within-5s contract pin (the behavior the grace window preserves), the whole recover-my-panes spec (the offer surface), the client recovery unit suites (client untouched — regression sanity), plus static checks:

```bash
cargo test -p freshell-server
cargo test -p freshell-ws
cargo clippy --workspace --all-targets -- -D warnings
npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/restore-contract-wall-rust.spec.ts -g 'SIGKILL-within-5s'
npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/recover-my-panes-rust.spec.ts
npm run test:vitest -- run test/unit/client/lib/recovery test/unit/client/components/RecoveryOfferPanel.test.tsx test/unit/client/components/RecoveryOfferPanel.persisted-boot.test.tsx
npm run typecheck
npm run lint
```

Expected: all PASS. (If the SIGKILL-5s test fails, the grace computation is wrong — fix the filter, never the pin's intent.)

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-server/src/recovery_inventory.rs crates/freshell-server/src/recovery_inventory_tests.rs crates/freshell-ws/src/pane_ledger.rs crates/freshell-ws/src/terminal.rs crates/freshell-ws/src/pane_ledger_tests.rs crates/freshell-ws/tests/pane_ledger_triggers.rs
git commit -m "fix(recovery): gate ledgerOnly offers on snapshot-evidence recency (D8)

The recovery inventory offered every Bound ledger row referenced by no
snapshot union and not live. With no recency floor, a user's 30-day tail
of never-retired bindings (freshAgent.kill closes, natural exits,
headless REST/MCP rows) was vacuumed into the offer and dumped into a
trailing 'Recovered sessions' tab of sessions that were never open.

An unreferenced Bound row is now offered only when bound within 15s
(3x the client's 5s diff-push cadence) of the newest retained snapshot
evidence; rows provably absent from a push made after they bound were
not open when the evidence was captured. The SIGKILL-within-5s
identity-survival contract is preserved; the blanket-era pins are
rewritten to the D8 matrix."
```

---

## Final verification (executed by the orchestrator after Task 2 review closes)

The coordinated full-suite gate (run by the orchestrator, not the task implementers):

```bash
FRESHELL_TEST_SUMMARY='restore-open-sessions-only full-suite gate' npm run check
cargo test -p freshell-server -p freshell-ws
```

plus re-confirmation of the two rust e2e specs above if the gate's suite does not include them. Gate passes = green run at final HEAD; pre-existing-failure exceptions require reproduction at base_ref `bb1fb59f9fece93dc4ef8bf4cea6cd707fc87276`.
