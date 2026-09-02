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

**Goal:** The recovery offer's ledger-derived "Recovered sessions" tab only ever contains sessions plausibly open when the server lost the client — the 30-day tail of Bound ledger bindings (closed fresh-agent panes, natural-exit CLI rows, headless REST/MCP lineage rows) never reaches the offer or the rebuilt layout, while the SIGKILL-near-create/resume window stays recoverable.

**Architecture:** The junk enters server-side: `build_inventory` (`crates/freshell-server/src/recovery_inventory.rs:254-265`) emits as `ledgerOnly` every Bound ledger row unreferenced by the newest-per-client snapshot unions and not live — with no recency floor. Ledger rows survive 30 days and are retired only by the WS `terminal.kill` path; fresh-agent pane closes (`freshAgent.kill`), natural CLI exits, plain pane-X closes (`terminal.detach`), and headless REST/MCP bindings never retire rows, so every such session accumulates (a prior live probe measured 301 rows). The client (`build-recovery-plan.ts:62-70`) dumps that bucket into ONE trailing "Recovered sessions" tab, which also becomes the active tab. The fix keeps the bucket but grounds it in evidence (**D8**): a Bound, unreferenced, not-live row is offered only if `row_time + 15_000 >= evidence_floor` (inclusive), where `row_time` = the row's last bind/refresh (`updated_at.max(created_at)` — re-binds refresh `updated_at` while preserving `created_at`), and `evidence_floor` = the MINIMUM, across every client that survives the existing A15/A16 selection (all device dirs), of that client's newest retained generation `capturedAt` (server-stamped at persist). Semantics: a row is dropped only when EVERY still-relevant client's evidence window closed before the row was bound — otherwise it keeps the benefit of the doubt (a kill-near-create/resume row is bound seconds before the client's frozen last push, and a single plausibly-parent client is enough to keep it). A 30-day-old row predates the whole surviving cohort's pushes and dies. `None` floor (no retained generations at all) = nothing unreferenced is provably open = offer nothing. The grace 15s = 3× the client's 5s diff-push cadence. The selection layer (`select_foreign_recent_generation_ids`) surfaces survivors' newest `capturedAt` values; `read_foreign_unions` aggregates the global min; `build_inventory` receives it as a new trailing param. No client changes; response shape unchanged.

**Tech Stack:** Rust workspace crates (`freshell-server` inventory builder/selection + tests, `freshell-ws` comment truthfulness), Vitest/Playwright e2e (`test/e2e-browser/specs/recover-my-panes-rust.spec.ts`, rust-chromium project).

## Global Constraints

- Work ONLY in `/home/dan/code/freshell/.worktrees/restore-open-sessions-only` on branch `the-usual/restore-open-sessions-only`. Never commit to or push `main`. No PR creation (user approval gate stays with the orchestrator).
- TDD red→green→refactor for every behavior change; never weaken, skip, or delete tests to obtain a green run. A deliberately-flipped contract pin is rewritten to assert the NEW contract, never vacated, and never asserted vacuously (a pin whose scenario cannot produce the junk row pre-fix is a test bug, not a pass).
- Test commands: no raw `npx vitest` — use `npm run test:vitest -- ...`; cargo tests run from the worktree root and are NOT behind the coordinator gate; broad suites only via `npm run check`/`npm test` (coordinator-aware); check the coordinator with `npm run test:status` first and never kill a foreign holder. Set `FRESHELL_TEST_SUMMARY` for broad runs.
- Rust CI parity: `cargo clippy --workspace --all-targets -- -D warnings` must be clean.
- Never set `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1`. Never restart the live production server (port 3001) or any server this run did not start. E2E servers use the RustServer helper's ephemeral loopback ports only.
- Follow repo comment/doc conventions: comments that describe behavior this change removes must be re-worded to stay truthful (`docs/index.html` and `AGENTS.md` are checked and only touched if they actually describe the old behavior; historical plan docs under `docs/plans/` are never rewritten).
- Commits use the repo's existing git identity; commit messages follow the repo's conventional-commit style.

### Contract supersession note (for reviewers)

`docs/plans/2026-07-26-recover-my-panes.md` D4 defined `ledgerOnly` as "all bound rows referenced by no device union and not live". D8 narrows that rule with the evidence-recency floor above. Pinned tests encoding the old blanket rule are rewritten to the new contract — listed by name in Task 2. Deliberate residuals accepted by D8:

- A pane created in the final seconds of a browser's FIRST-EVER session (before its very first WS-ready push; zero retained generations anywhere) has no snapshot evidence and is not offered. Every other kill-near-create case retains recovery (pushes begin at WS-ready, and a post-restart WS reconnect push re-references the pane into the union anyway — such rows leave the bucket because the snapshot now contains them, which is the correct surfacing).
- Sessions whose only snapshot evidence lives in clients already evicted by the pre-existing A15 staleness rule (newest push >15 min older than the freshest surviving client) were already absent from the offered unions; D8 aligns the ledger bucket with that same eviction.
- Generation ranking is revision-first while the floor uses raw capturedAt-max per client (the selection layer's existing `newest_by_client`); the discrepancy needs a ≥15s backward server-clock step inside one client's retention window, biases keep-side only (never drops a genuinely-open row), and is documented rather than redesigned.
- After this lands, a previously-dismissed offer's `contentId` changes once; a dismissed offer may re-appear at most once.

---

### Task 1: E2E contract pin — a stale never-open session never reaches the inventory's ledgerOnly or the offer

**Files:**
- Modify: `test/e2e-browser/specs/recover-my-panes-rust.spec.ts` (extend the shared `beforeAll` seed/env; copy the freshclaude donor helpers per the file's per-spec-ownership convention; append ONE scenario LAST in the existing serial describe)

**Interfaces:**
- Consumes: existing spec helpers (`installFakeCli`, `seedConfig`, `selectShellIfPickerShowing`, `connect`, `openFreshContextWithOffer`, `waitForSnapshotContaining`, `waitForRecoverable`, `readArgvLog` idioms) plus helpers copied from `test/e2e-browser/specs/hidden-pane-rebind-rust.spec.ts`: `createFreshclaudePane` (:153-182), the `findFreshAgentLeaf` walker (:118-128), and the `connection/setAvailableClis` dispatch + durable-UUID poll idioms (:159-164, :311-318).
- Producer recipe (validator-proven; reports/load-bearing-validator-v1-recipe.md): a freshclaude pane split beside the boot shell pane, closed via the PLAIN pane-X, leaves its pane-ledger row Bound (the fresh-agent identity sink has NO retire method — `crates/freshell-freshagent/src/identity_sink.rs:46-72`; `retire_closed`'s only caller is WS `terminal.kill`, `crates/freshell-ws/src/terminal.rs:5184-5208`) and unreferenced after the client's next push. Fallback if and only if the primary is blocked (never silently substitute): recipe (b) natural-exit claude pane via SIGTERM to the argv-log pid with `FRESHELL_AUTO_RESUME_MAX_CYCLES=0` in the shared env + plain-X close (validator report lines 384-391); see the implementer brief for the full safety gates.

- [ ] **Step 1: Write the failing behavioral test**

1. Suite `beforeAll` amendments (inert for the pre-existing scenarios — nothing in scenarios 1-4 issues a fresh-agent create, and `FRESHELL_CLAUDE_SIDECAR` is read only at freshclaude sidecar spawn, `claude.rs:2056-2066`):
   - `seedConfig()` (:66-82): add `"freshAgent": { "enabled": true }` beside `codingCli.enabledProviders` (donor shape: hidden-pane-rebind :84-96).
   - Env (:311-312): add `FRESHELL_CLAUDE_SIDECAR: path.resolve(__dirname, '../fixtures/fake-claude-sidecar.mjs')` and `FAKE_CLAUDE_SIDECAR_LOG: path.join(sharedRoot, 'claude-sidecar-requests.jsonl')`.
   - Copy in (per-spec-ownership header convention :34-36 imports stay as-is): `createFreshclaudePane`, `findFreshAgentLeaf`, and the durable-UUID poll idiom from hidden-pane-rebind.
2. Append the scenario LAST in the existing serial describe, with `test.setTimeout(240_000)` (scenario-1 precedent; budget: 21s grace-gate wait + ≤120s generation poll + restart + two boots):

```ts
test('stale never-open ledger rows are never offered', async ({ browser, e2eServerKind }) => {
  expect(e2eServerKind).toBe('rust')
  test.setTimeout(240_000)
  // 1. Re-base the evidence base (A1/H6): earlier scenarios' clients hold frozen
  //    generations within the A15 window whose clocks would drag the D8
  //    per-client floor BELOW the junk bind. No client is connected at this
  //    point in the serial suite, so wiping the generation store is safe; this
  //    scenario's own context rebuilds the evidence (and keeps the offer
  //    recoverable via the surviving shell tab).
  await fs.rm(path.join(capturedHome, '.freshell', 'tabs-snapshots'), { recursive: true, force: true })
  // 2. Context A: boot shell pane, then SPLIT a freshclaude pane beside it
  //    (H1: never close a tab's only pane — that collapses to closeTab, whose
  //    closed-tab record would re-reference the row forever).
  //    ctxA = browser.newContext(FRESH_CONTEXT_OPTIONS); connect(pageA, info);
  //    selectShellIfPickerShowing(pageA); expect .xterm visible.
  //    markerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'junk-freshclaude-'))
  //    await createFreshclaudePane(pageA, harnessA, markerDir)
  // 3. Acquire SESSION_ID via the harness poll (sessionRef/resumeSessionId
  //    durable-UUID regex idiom), disk-wait the binding row
  //    <capturedHome>/.freshell/pane-ledger/bindings/claude/<SESSION_ID>.json
  //    and read bindMs (row JSON createdAt — serde camelCase).
  // 4. Prove it WAS snapshot-open: await waitForSnapshotContaining([SESSION_ID]).
  // 5. H3 timing gate: bounded-wait until Date.now() >= bindMs + 21_000
  //    (15s D8 grace + one full 5s push tick + 1s slack; the grace is physical
  //    wall-clock — without it the post-close generation can predate
  //    bindMs + 20s and the poll in step 7 would time out).
  // 6. Close via the PLAIN pane-X — never shift+close, never the Stop button
  //    (H2/H9: terminal.kill would retire the row and vacate the pin):
  //    pageA.locator("[data-pane-id][data-context='pane']:has([data-context='fresh-agent']) button[title='Close pane']").click()
  //    (shell sibling keeps the tab alive; closePane, not closeTab, fires).
  // 7. Re-based evidence-advance: poll the newest generation per client under
  //    <capturedHome>/.freshell/tabs-snapshots/ (waitForNewestGenerationRecordCount's
  //    ranking idiom generalized to every device dir) until for EVERY client the
  //    newest generation has capturedAt > bindMs + 20_000 AND its content does
  //    not contain SESSION_ID (timeout 120s).
  // 8. await ctxA.close(); await waitForRecoverable(info) (file's close→restart
  //    discipline parity); info = await server.restart()  (reassign info).
  // 9. RED/GREEN inventory assertion via a STANDALONE probe — never page.request,
  //    never a navigated page (it would register as a tabs.sync client):
  //    const req = await request.newContext({ baseURL: info.baseUrl,
  //      extraHTTPHeaders: { 'x-auth-token': info.token } })
  //    const body = await (await req.get(
  //      '/api/recovery/inventory?clientInstanceId=freshell-test-probe&bootAgoMs=0')).json()
  //    await req.dispose()
  //    expect(body.ledgerOnly.every((e) => e.sessionId !== SESSION_ID)).toBe(true)
  //    (membership-absence, NOT emptiness — strategist A10: other legit rows may exist)
  // 10. Offer assertion (H4 — the panel renders ledgerOnly rows as
  //    "{mode} session — {cwd}", never the sessionId, so the marker cwd
  //    discriminates): const { ctx: ctxB, page: pageB } =
  //    await openFreshContextWithOffer(browser, 'junk-exclusion')
  //    const panel = pageB.getByTestId('recovery-offer-panel')
  //    await expect(panel.locator('ul li', { hasText: 'junk-freshclaude-' })).toHaveCount(0)
  // 11. Do NOT click accept: the dump-into-last-tab mechanism is transitively
  //    pinned — build-recovery-plan.test.ts:85-95 maps every ledgerOnly entry
  //    to the trailing "Recovered sessions" tab
  //    (src/lib/recovery/build-recovery-plan.ts:62-70), so an empty bucket
  //    provably produces no junk tab; post-accept tab counts would be
  //    non-deterministic in this shared suite. Record this in a comment.
  // 12. await ctxB.close() (finally-style cleanup consistent with the file).
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/recover-my-panes-rust.spec.ts -g 'stale never-open ledger rows'`

Expected: FAIL — step 9's probe assertion trips because the stale row IS in `ledgerOnly` today (and step 10's list assertion would trip on the rendered `junk-freshclaude-` marker line). A failure from the row being retired (wrong close affordance), from the offer not appearing, or from timing is NOT acceptable red: iterate the recipe until the failure is exactly "stale row present".

- [ ] **Step 3: Minimal production implementation**

None in this task — the pin lands RED against the unfixed server by design; Task 2 turns it green.

- [ ] **Step 4: Run the focused test**

Same command as Step 2. Expected: FAIL (the pinned red). Record the failure output excerpt in the implementer report as the RED evidence for Task 2's green.

- [ ] **Step 5: Refactor while green**

No green refactor here; ensure the scenario matches the file's conventions (helper reuse, comment style, serial ordering — it MUST remain LAST in the describe so the evidence wipe cannot corrupt earlier scenarios' assertions).

- [ ] **Step 6: Run impacted-test verification**

The scenario is additive; the beforeAll seed/env additions must be proven inert for the earlier scenarios:

Run: `npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/recover-my-panes-rust.spec.ts`

Expected: scenarios 1-4 PASS; ONLY the new scenario FAILS (the pinned red, recorded in the progress ledger as intentional red-until-Task-2). Any broad suite is NOT run at this stage.

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

### Task 2: Server-side D8 evidence-recency floor (+ comment truthfulness)

**Files:**
- Modify: `crates/freshell-server/src/recovery_inventory.rs` (selection-layer floor surfacing, `read_foreign_unions` aggregation, `build_inventory` param + filter, route plumbing, D8 constant + comments, debug observability line)
- Modify: `crates/freshell-server/src/recovery_inventory_tests.rs` (contract rewrite — listed below)
- Modify: `crates/freshell-ws/src/pane_ledger.rs:~615-623` (`delete_binding` doc comment)
- Modify: `crates/freshell-ws/src/terminal.rs:~3337-3346` (spawn-failure comment)
- Modify: `crates/freshell-ws/src/pane_ledger_tests.rs` (comment near `:446-450`)
- Modify: `crates/freshell-ws/tests/pane_ledger_triggers.rs` (comment near `:118-126`)

**Interfaces:**
- Consumes: `BindingRow.updated_at`/`created_at` (`crates/freshell-ws/src/pane_ledger.rs:108-109`; re-bind refreshes `updated_at`, never `created_at` — validator-verified across all bind lanes); the selection layer's per-client newest times (computed at `recovery_inventory.rs:35-47` as `newest_by_client`, A15-survivor-filtered :49-61); the existing filter chain (`row_is_bound` :256, A4 referenced-rule :258, D7 live-rule :260).
- Produces (additive; response shape unchanged):
  - One documented private constant: `const UNSNAPSHOTTED_BINDING_GRACE_MS: u64 = 15_000;`
  - `select_foreign_recent_generation_ids` returns the selected generation ids PLUS the selected (A15/A16-surviving) clients' newest `capturedAt` values — as a named struct per the file's existing idiom (the file already returns structs/tuples for paired results; validator V3 identified exactly two production call sites to update: `recovery_inventory.rs` `read_foreign_unions` (:520-547 region) and the selection unit tests ~:341/:351/:797/:807).
  - `read_foreign_unions` returns `(Vec<DeviceUnion>, Option<u64>)` — unions plus the global floor = min over all device dirs' surviving clients' newest times (`None` when no surviving generation exists anywhere).
  - `build_inventory(device_unions, bindings, live_session_keys, evidence_floor_ms: Option<u64>)`.
  - The route handler passes the floor through (:397-420 region).

- [ ] **Step 1: Write the failing behavioral tests (unit + route contract rewrite)**

In `recovery_inventory_tests.rs` (fixture builders `union_doc(device, captured_at, panes)` :20-26 and `binding_row_at(provider, sid, state, updated_at)` :54-81 already exist; with the floor as a PARAM no fixture surgery is needed — drafts below adapt to real signatures):

```rust
// REWRITES unreferenced_bound_rows_become_ledger_only (:227-232) — blanket era
#[test]
fn unreferenced_row_within_grace_of_evidence_floor_is_offered() {
    // floor F = 1_000_000; row updated_at = F - 15_000 (inclusive boundary) => offered.
    ... assert_eq!(out["ledgerOnly"][0]["sessionId"], "C9");
}

#[test]
fn unreferenced_row_before_evidence_floor_is_not_offered() {
    // floor F = 1_000_000; row updated_at = F - 15_001 => excluded; when no
    // other candidate exists, recoverable flips false.
    ... assert_eq!(out["ledgerOnly"].as_array().unwrap().len(), 0);
       assert_eq!(out["recoverable"], false);
}

#[test]
fn ledger_only_rows_without_any_snapshot_evidence_are_not_offered() {
    // evidence_floor_ms = None; one Bound unreferenced row => empty bucket, recoverable false.
}
```

Plus floor-semantics tests at the selection/aggregation layer:
- `read_foreign_unions`-level: two device dirs with surviving clients NEWEST 900_000 and 1_000_000 ⇒ floor `Some(900_000)` (per-client min, NOT per-union max); a cohort client evicted by A15 (newest >15 min older than the device max) contributes NOTHING to the floor; no generations ⇒ `None`.
- Selection-fn return-shape tests: update ~:341/:351/:797/:807 to the struct return (destructure only; behavioral assertions unchanged).

And the contract rewrites:
- `route_serves_ledger_only_recovery_without_snapshots` (:514-536) → rewrites in place to the new contract: one Bound row, no snapshot contents ⇒ 200 with `recoverable == false`, `device == null`, `ledgerOnly == []`.
- NEW route-level within-grace positive (write one snapshot generation into the temp dir via the test harness's `write_snapshot` helper — generation fields: deviceId/clientInstanceId/serverInstanceId/deviceLabel/capturedAt/snapshotRevision/records with status "open" — and a ledger row with `updated_at = CAP - 5_000`) ⇒ offered and recoverable.
- `content_id_is_stable_and_input_sensitive` (:300-306) repair: pass `Some` floors aligned so BOTH fixtures' rows stay offered (`floor ≤ row.updated_at + 15_000`); the `assert_ne` stays non-vacuous (still detects content/blind-exclusion regressions).
- KEEP behaviorally (each must still exercise its original behavior — pass a floor value preserving it; `:308` gets a `Some` floor aligned to its fixture per validator V4): `bound_row_referenced_by_non_primary_device_is_not_ledger_only` (:234), `live_effective_ref_marks_pane_live_and_live_rows_never_ledger_only` (:267), the empty-bucket asserts (:145, :195) — for the KEEP set floor = `None` preserves meaning (their rows are referenced/live/absent, so the D8 gate never applies).
- All OTHER `build_inventory` test call sites (~12): pass the floor that preserves each test's behavioral meaning; record the per-site choice in the implementer report.

Every rewritten test must assert behavior (membership/absence/recoverable/floor), never static copy.

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `cargo test -p freshell-server recovery_inventory`

Expected: FAIL — the two new exclusion tests, the None-floor test, the route rewrite, and the floor-semantics tests trip on the current blanket bucket / pre-floor signatures; the within-grace keep-test passes already.

- [ ] **Step 3: Add the minimal production implementation**

In `crates/freshell-server/src/recovery_inventory.rs`:

1. Documented constant next to `STALE_CLIENT_MS` (:16):

```rust
/// D8 (restore-open-sessions-only): an unreferenced Bound row is offered only
/// when its last bind/refresh lies within one grace window of the per-client
/// snapshot-evidence floor (the MIN over A15/A16-surviving clients' newest
/// retained `capturedAt`, server-stamped at persist). A row dropped by this
/// rule was provably absent from EVERY surviving client's pushes made after
/// it was bound — it was not actually open when the evidence was captured.
/// 15s = 3x the client's 5s diff-push cadence (tabRegistrySync), so
/// kill-near-create/resume rows keep recovery while the 30-day Bound tail
/// (closed fresh-agent panes, natural exits, plain-detach closes, headless
/// REST/MCP lineage rows) never reaches the offer. Floor vs union-max:
/// capturedAt ranking is revision-first in unions, raw-max per client here —
/// the discrepancy needs a >=15s backward server-clock step and biases
/// keep-side only; documented, not redesigned.
const UNSNAPSHOTTED_BINDING_GRACE_MS: u64 = 15_000;
```

2. Selection layer: extend `select_foreign_recent_generation_ids` to also return the surviving clients' newest `capturedAt` values (reuse the already-computed `newest_by_client` restricted to the A15/A16 survivor predicate — one named struct per the file idiom); `read_foreign_unions` aggregates `Option<u64>` = min across all device dirs' survivors and returns it with the unions (compute the floor from the FINAL retry attempt's selection in the :522-547 region, per validator V3); handler passes it to `build_inventory`.
3. `build_inventory` filter (the chain at :254-265 gains ONE filter):

```rust
.filter(|r| match evidence_floor_ms {
    Some(floor) => {
        let row_time = r.updated_at.max(r.created_at).max(0) as u64;
        row_time.saturating_add(UNSNAPSHOTTED_BINDING_GRACE_MS) >= floor
    }
    // No snapshot evidence: nothing unreferenced is provably open (D8).
    None => false,
})
```

4. Observability: after the filter, one structured debug line on the route's tracing target when rows were dropped (count only, no payloads, gated on `dropped > 0`):

```rust
tracing::debug!(target: "freshell_server::recovery_inventory",
    dropped, evidence_floor_ms, "D8 excluded stale unreferenced ledger rows from ledgerOnly");
```

5. Re-word the four comments the D8 contract makes stale, keeping them truthful about what ghost-row deletion still protects (durable-ledger truthfulness for existence/pending-reader semantics; the offer can now only surface such a row within one grace window of the evidence floor): `pane_ledger.rs` `delete_binding` doc, `terminal.rs` spawn-failure branch, `pane_ledger_tests.rs` :446-450, `pane_ledger_triggers.rs` :118-126. Delete NOTHING — comments only.
6. Docs sweep (record findings in the implementer report): `rg -n 'ledgerOnly|recovery inventory|Recovered sessions' docs/ README.md AGENTS.md` — edit a file only if it actually documents the old blanket behavior (expected: none; historical `docs/plans/` files are never rewritten).

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-server recovery_inventory`

Expected: PASS (all D8 matrix + floor-semantics tests green).

Then confirm Task 1's red pin turns green:

Run: `npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/recover-my-panes-rust.spec.ts -g 'stale never-open ledger rows'`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Check the filter reads as one coherent rule beside the A4/D7 filters; confirm no now-dead imports/helpers; confirm the struct name and floor threading match the file's naming. Re-run Step 4 commands after any refactor.

- [ ] **Step 6: Run impacted-test verification**

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

Expected: all PASS. Wall-test note (validator V4, analyzed and accepted): after a slow server reboot the OLD page's reconnect `pushNow(true)` can land before `page.goto` clears storage — that push RE-REFERENCES the just-created pane into the union, so the row leaves `ledgerOnly` because the snapshot now contains it (the correct surfacing); the test's two-path poll (auto-restored pane OR visible offer) stays green either way. A failure from the offer not appearing at all means the floor mishandled the frozen-evidence case — fix the filter, never the pin's intent.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-server/src/recovery_inventory.rs crates/freshell-server/src/recovery_inventory_tests.rs crates/freshell-ws/src/pane_ledger.rs crates/freshell-ws/src/terminal.rs crates/freshell-ws/src/pane_ledger_tests.rs crates/freshell-ws/tests/pane_ledger_triggers.rs
git commit -m "fix(recovery): gate ledgerOnly offers on snapshot-evidence recency (D8)

The recovery inventory offered every Bound ledger row referenced by no
snapshot union and not live. With no recency floor, a user's 30-day tail
of never-retired bindings (freshAgent.kill closes, natural exits,
plain-detach closes, headless REST/MCP rows) was vacuumed into the offer
and dumped into a trailing 'Recovered sessions' tab of sessions that were
never open.

An unreferenced Bound row is now offered only when its last bind/refresh
(updated_at, creation-preserved) lies within 15s (3x the client's 5s
diff-push cadence) of the per-client evidence floor — the MIN over
A15/A16-surviving clients' newest retained capturedAt. A dropped row was
provably absent from every surviving client's pushes after its bind: not
actually open when the evidence was captured. Kill-near-create/resume
recovery (SIGKILL-within-5s contract) is preserved; the blanket-era pins
are rewritten to the D8 matrix."
```

---

## Final verification (executed by the orchestrator after Task 2 review closes)

The coordinated full-suite gate (run by the orchestrator, not the task implementers):

```bash
FRESHELL_TEST_SUMMARY='restore-open-sessions-only full-suite gate' npm run check
cargo test -p freshell-server -p freshell-ws
```

plus re-confirmation of the two rust e2e specs above if the gate's suite does not include them. Gate passes = green run at final HEAD; pre-existing-failure exceptions require reproduction at base_ref `bb1fb59f9fece93dc4ef8bf4cea6cd707fc87276`.
