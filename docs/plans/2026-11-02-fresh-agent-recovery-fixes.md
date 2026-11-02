# Fresh-Agent Recovery Fixes Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Root-cause and fix four open Kata issues in the Freshell repository, each with its own correct recovery/test behavior proven by focused evidence:

1. gc1p — Managed Codex recovery exhausts retries after a native crash with archived history: the supervisor replaces the host three times against the old native identity, each replacement fails with FRESH_AGENT_OPEN_FAILED, recovery exhausts RETRY_BUDGET, and the next prompt through the original Freshell session is rejected without reaching the actor command journal. Fix so recovery handles this situation correctly: capture the actual replacement-open error with useful structured, redacted diagnostics; reproduce the managed native-PID crash + history-archive sequence with the provider-exit observer active, retaining exact ownership and original-history byte guards; prove the intended recovery contract through the original public reference (accepted post-crash prompt, saved settings, committed native identity, pending-question resolution, second prompt, and old/new history/name policies) — or, if product policy should stop on history loss instead, explicitly resolve the conflicting contract and cover the truthful blocked state.
2. cnr1 — The Rust test `providers::fresh_agent::tests::actual_claude_clear_backlog_replays_in_order_and_reopens_current_root` counted an unexpected fourth native-input record (expected exactly two explicit /clear commands and one original input). Identify the retained actual command sequence and a supported cause; repair fixture isolation/readiness or production dispatch according to evidence, preserving exact clear/input counts, original-input ownership, native roots, settings/history/ordering and no-tool-effect guards.
3. wjwa — The Rust test `providers::fresh_agent::tests::hosted_claude_rejected_rollback_preserves_current_parent_and_followup` intermittently fails with `initial parent observation missing`. Determine whether the test checks too early or the backend fails to report that the conversation/actor is ready; fix only the supported layer — no sleeps, no weakened assertions, no bypassed native-identity proof.
4. czzp — The Rust test `providers::fresh_agent::tests::hosted_actor_checkpoint_recovery_preserves_the_created_root_and_current_card` failed `NativeIdentityMismatch` in a package-selected diagnostic build but passed in the original workspace build. Distinguish a build/test-setup problem from a recovery bug; determine which native identity/launch/readiness contract rejects the current checkpoint in the package build; fix a substantiated fixture or production contract issue and verify/disclose both package and workspace feature contexts.

### Explicit constraints
- Run this work with the-usual workflow in a dedicated worktree (`.worktrees/fresh-agent-recovery-fixes`, branch `the-usual/fresh-agent-recovery-fixes`).
- Follow repo rules: pnpm 10.34.5 with `--frozen-lockfile`, TDD red/green/refactor, both unit and e2e coverage of fixes, structured logging conventions.
- Destructive/crash-recovery reproductions run in the disposable Docker sandbox (`FRESHELL_RUST_TEST_SANDBOX=1` or `scripts/sandbox-test.sh`); never reproduce destructive steps against the live self-hosted server; never restart production without explicit approval.
- Broad repo-supported test runs go through the shared coordinator gate with `GCLOUD_ROBOT_REQUIRE=1`; do not kill foreign holders.
- Do not weaken tests, skip tests, retry-until-green, accept 3-or-4 counts, add sleeps, or bypass identity/ownership/history assertions to make failures pass.
- Do not create or open a PR without explicit user approval; committing and pushing the branch is fine.
- Kata issues gc1p, cnr1, wjwa, czzp must be tracked to closure when their acceptance criteria are met; do not close fy2w or conflate its cause.

### Accepted tradeoffs and residuals
- None stated.

**Goal:** Make managed Codex recovery survive a native crash with archived history per the documented recover-on-send contract (with typed redacted diagnostics), and make the three flaky/failing Claude session-host tests deterministic and evidence-retaining, so the full suite is green at this branch's HEAD for exactly the four tracked Kata failures it fixes.

**Architecture:** Two work streams. (A) Test-reliability stream (Tasks 1–4): all three Claude test failures are test/fixture-layer readiness or isolation defects — the production announce-vs-evidence transport contract is deliberate and stays intact; fixes mirror existing in-repo waiting patterns and add fixture isolation plus failure-evidence retention. (B) Production-recovery stream (Tasks 5–8): gc1p is a real managed-Codex recovery bug with two layers — a stale stored resume spec clobbering the incarnation's folded settings at grant execution (Fix A), and THREE blockers preempting the proven send-driven recover-on-send path for a native-provider exit in a live host (Fix B): the supervisor's whole-host replacement observer, the admission gate's blanket `status.exited` refusal, and the session-host send-time current-native-observation guard whose only rescue arm is Claude-only (load-bearing validation falsified the two-blocker design; see `reports/load-bearing-validator-lb1.md`). Plus an opaque error surface that must become typed redacted diagnostics (Fix C). The installed parity integration case in the disposable sandbox is the acceptance proof.

**Tech Stack:** Rust (freshell-supervisor, freshell-session-host, freshell-agent-runtime, freshell-runtime-protocol, freshell-server crates; cargo `--locked`), Node sidecar fixture (`test/unit/claude-sidecar/fixtures/native-startup-query.mjs`, `crates/freshell-claude-sidecar`), Vitest for client/tooling tests, Docker sandbox via `scripts/sandbox-test.sh`, KataTracker (`kata`) for issue tracking.

## Global Constraints

- Package manager: pnpm 10.34.5 exactly; installs `pnpm install --frozen-lockfile`; run binaries with `pnpm exec`; `pnpm run <script> <args...>` forwards args without a `--` separator. Never `npm ci`/`npm install` in this tree.
- Rust: build/test with `--locked` (no dependency edits are planned). Direct Cargo lanes run inside the disposable Docker sandbox: `bash scripts/sandbox-test.sh "<cargo command>"` (see `docs/development/test-sandbox.md`); pnpm-run Rust lanes export `FRESHELL_RUST_TEST_SANDBOX=1`. Destructive process-kill/crash sequences never run against the host's live processes and never touch the live self-hosted server (port 3001); production is never restarted.
- Test coordination: broad repo-supported runs (zero-arg/broad `test`, `check`, `verify`, `test:rust`, `test:server`, `test:integration`) go through the shared coordinator gate with `GCLOUD_ROBOT_REQUIRE=1` and a `FRESHELL_TEST_SUMMARY` holder note; if another agent holds the gate, wait — never kill a foreign holder. Narrowed selectors (single tests, single files, targeted cargo selectors) are delegated lanes and do not hold the gate.
- Focused Vitest path: `pnpm run test:vitest run <paths...> --config config/vitest/vitest.config.ts`.
- TDD red/green/refactor for every behavior change. Never weaken assertions, skip tests, add sleeps, widen counts (no "3 or 4"), retry-until-green, or bypass identity/ownership/history guards. A flaky test gets a cause diagnosis and a deterministic fix, not a mask.
- Secret redaction: error/diagnostic changes carry closed enum values and field NAMES only — never provider prose, request bodies, environment values, or credentials. Structured logging is JSONL.
- TypeScript (tools/tests) uses NodeNext/ESM: relative imports need `.js` extensions.
- Commit style: focused conventional messages (`fix:`, `test:`, `feat:`, `docs:`); one logical change per commit; never sweep unrelated files.
- No user-facing UI change is planned, so `docs/index.html` needs no update.
- Kata tracking: at the end of Tasks 1–2 (cnr1), 3 (wjwa), 4 (czzp), and 8 (gc1p), post an evidence comment to the matching Kata issue (`kata comment <id> --body "..."`) with the command, result, and retained evidence path. Do not close the issues during execution; closure is a coordinator action after the final delta review passes. Do not comment/close fy2w from this run.
- The four root-cause planning reports under `/home/dan/code/freshell/.worktrees/.the-usual-logs/fresh-agent-recovery-fixes/reports/` (`plan-gc1p-managed-codex-recovery.md`, `plan-cnr1-clear-replay-extra-command.md`, `plan-wjwa-initial-parent-observation.md`, `plan-czzp-checkpoint-identity-mismatch.md`) are the detailed evidence maps; this plan cites their key line references (valid at base_ref `e6d341b62`); execution may re-derive exact lines as they shift.
- Work only inside `/home/dan/code/freshell/.worktrees/fresh-agent-recovery-fixes`. Never modify the main checkout, other agents' worktrees, or production state.

---

### Task 1: cnr1 (a) — retain the actual native-input command sequence on assertion failure

**Files:**
- Modify: `crates/freshell-session-host/src/providers/fresh_agent.rs` (test `actual_claude_clear_backlog_replays_in_order_and_reopens_current_root`, base_ref lines: test at :7768, poll at :7958-7964, count assertion at :7976-7980; sibling patterns at :7730-7746 and :7750-7753)

**Interfaces:**
- Consumes: the test's existing `consumed: Vec<serde_json::Value>` of native-input rows (fields `uuid`, `text`, `nativeSessionId`, `pid`).
- Produces: a test-local row formatter (e.g. `format_native_input_rows(&[Value]) -> String`) embedding `uuid`/`text`/`nativeSessionId`/`pid` per row, used by the count assertion's panic message; a complete-JSONL-record wait in the poll. No production code changes; later tasks do not depend on internals.

- [ ] **Step 1: Write the failing behavioral test**

Add a small focused unit test in the same `#[cfg(test)]` module protecting the formatter the assertion will use (it must fail while the helper is absent):

```rust
#[test]
fn native_input_row_evidence_format_embeds_identity_fields() {
    let rows: Vec<serde_json::Value> = vec![
        serde_json::json!({"uuid": "u-1", "text": "/clear", "nativeSessionId": "root-A", "pid": 4242u32}),
        serde_json::json!({"text": "Continue only the original pending native operation. Do not select another tool.", "nativeSessionId": "root-E", "pid": 4343u32}),
    ];
    let rendered = format_native_input_rows(&rows);
    assert!(rendered.contains("u-1") && rendered.contains("/clear") && rendered.contains("root-A") && rendered.contains("4242"));
    assert!(rendered.contains("root-E") && rendered.contains("4343"));
    // A row without a uuid must be visible as such (the cnr1 fourth-row fingerprint).
    assert!(rendered.contains("<no-uuid>") || rendered.contains("no uuid"));
}
```

(Exact helper name may follow neighboring test helpers; the test must assert the identifying fields are embedded and that a uuid-less row is still rendered.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `bash scripts/sandbox-test.sh "cargo test --locked -p freshell-session-host --bin freshell-session-host native_input_row_evidence_format_embeds_identity_fields -- --exact --nocapture"`

Expected: FAIL because the helper does not exist (compile error: cannot find function) — the missing behavior is failure-evidence formatting, not a syntax accident.

- [ ] **Step 3: Add the minimal production implementation**

Add the test-local `format_native_input_rows` helper next to the sibling formatting code (mirror the repo's own row-formatting pattern at base_ref :7750-7753); then:

1. Change the count assertion (:7976-7980) to embed the rendered rows in its panic message — expected count stays exactly 3 (two `/clear` + one original input); no count relaxation.
2. Adopt the sibling's complete-JSONL discipline in the poll (:7958-7964 mirrors :7730-7746): wait for a complete trailing record before parsing instead of parsing a possibly-torn last line. A torn line must be awaited, not counted or panicked on.

- [ ] **Step 4: Run the focused test**

Run: `bash scripts/sandbox-test.sh "cargo test --locked -p freshell-session-host --bin freshell-session-host providers::fresh_agent::tests::actual_claude_clear_backlog_replays_in_order_and_reopens_current_root -- --exact --nocapture"`

Expected: PASS (the case is currently green in isolation; the change must keep it green).

- [ ] **Step 5: Refactor while green**

If neighboring tests duplicate row formatting, share the helper; otherwise no refactor.

- [ ] **Step 6: Run impacted-test verification**

The neighboring sidecar-spawning provider tests that parse native-inputs or use the same poll pattern: run the whole session-host provider test group.

Run: `bash scripts/sandbox-test.sh "cargo test --locked -p freshell-session-host --bin freshell-session-host -- --nocapture"`

Expected: PASS (330+ passed, 0 failed; the 3 pre-existing ignored stay ignored).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-session-host/src/providers/fresh_agent.rs
git commit -m "test: retain native-input evidence in clear-backlog count assertion"
```

---

### Task 2: cnr1 (b) — fixture isolation for the auto-continuation chain (starvation repro + opt-out flag)

**Files:**
- Modify: `test/unit/claude-sidecar/fixtures/native-startup-query.mjs` (checkpoint iterator; base_ref :60-63 row writer, :111 row log call, :122-130 checkpoint branch, :182 allow/effect-count writer)
- Modify: `crates/freshell-session-host/src/providers/fresh_agent.rs` (clear-backlog test env block :7811-7832 and `SnapshotProviderEnv` keys :7781-7789)
- Test: `test/unit/claude-sidecar/native-continuation-lifecycle.test.ts` (harness template :14-58, existing chain test :60-96)

**Interfaces:**
- Consumes: the fixture's `logNativeInput` seam and checkpoint branch (Task 1's retention is already in place so any future mismatch is diagnosable).
- Produces: a new fixture opt-out environment variable `FRESHELL_SIDECAR_TEST_INPUT_WITHOUT_TOOL_CONTINUATION=1` under which the checkpoint iterator yields a plain result (no synthesized solo-tool `tool_use`+`defer`) for non-`/clear`, non-`/compact` inputs; the clear-backlog Rust test sets it.

- [ ] **Step 1: Reproduce under controlled starvation (diagnostic only — no repo change)**

Run the exact clear-backlog test inside the runtime sandbox with deliberate CPU pressure against the test process (busy-loop helpers or `taskset` pinning, the retained driver-episode pattern) while a pre-opened read FD retains `native-inputs.jsonl` outside the TempDir. Success criterion: a fourth row appears matching the predicted fingerprint — no `uuid`, bare-string text `Continue only the original pending native operation. Do not select another tool.`, root E, row-3's PID. If the row differs or cannot be produced within a bounded episode, stop and re-investigate (the planning report §4.2–4.7 statically excludes all other writers); record the outcome either way in the task report — the isolation repair may proceed labeled "statically proven" if the episode is inconclusive.

- [ ] **Step 2: Write the failing behavioral test**

Add to `test/unit/claude-sidecar/native-continuation-lifecycle.test.ts`, following the file's existing real-sidecar spawn harness:

```ts
it('with FRESHELL_SIDECAR_TEST_INPUT_WITHOUT_TOOL_CONTINUATION a plain input logs exactly one row and never continues a deferred tool', async () => {
  const { rows, events } = await driveSidecarScenario({
    env: { FRESHELL_SIDECAR_TEST_CHECKPOINT: '1', FRESHELL_SIDECAR_TEST_INPUT_WITHOUT_TOOL_CONTINUATION: '1' },
    inputs: [{ type: 'user', text: 'original pending native operation' }],
  });
  expect(rows).toHaveLength(1);
  expect(rows[0].text).toBe('original pending native operation');
  expect(events.some(e => e.type === 'tool_deferred')).toBe(false);
  expect(events.some(e => e.type === 'native_continuation_push')).toBe(false);
});
```

(Adapt helper names to the file's real harness; the protected behavior: under the flag there is exactly one input row, no deferred result, no continuation push. Checkpoint branch still active for `/clear` root transitions.)

- [ ] **Step 3: Run the test and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/claude-sidecar/native-continuation-lifecycle.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL because the fixture ignores the unknown env var and still runs the synthesized solo-tool defer chain (extra row / deferred event present).

- [ ] **Step 4: Add the minimal production implementation**

In `native-startup-query.mjs`'s checkpoint iterator, when `process.env.FRESHELL_SIDECAR_TEST_INPUT_WITHOUT_TOOL_CONTINUATION === '1'` and the input is not `/clear`/`/compact`, yield a plain assistant result instead of the synthesized solo-Bash `tool_use` (so the sidecar's PreToolUse `defer` never fires). The `/clear` and `/compact` handling and the allow-path `effect-count` writer (:182) stay untouched. Then set the flag in the clear-backlog Rust test's env block and add it to the `SnapshotProviderEnv` keys so snapshot isolation sees it.

- [ ] **Step 5: Run the focused test**

Run: `pnpm run test:vitest run test/unit/claude-sidecar/native-continuation-lifecycle.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS — the new flag test green AND the existing no-flag defer→continuation chain tests stay green.

- [ ] **Step 6: Refactor while green**

None expected; keep the fixture diff minimal.

- [ ] **Step 7: Run impacted-test verification**

1. Rust clear-backlog case (now with the flag set): `bash scripts/sandbox-test.sh "cargo test --locked -p freshell-session-host --bin freshell-session-host providers::fresh_agent::tests::actual_claude_clear_backlog_replays_in_order_and_reopens_current_root -- --exact --nocapture"` — PASS, including once under the Step-1 starvation shape (deterministic 3 rows).
2. The checkpoint-dependent Rust tests that must keep the chain (no flag): `... providers::fresh_agent::tests::hosted_checkpoint_recovery_stages_without_input_and_releases_current_native_ask_once -- --exact --nocapture` and `... providers::fresh_agent::tests::hosted_actor_checkpoint_recovery_preserves_the_created_root_and_current_card -- --exact --nocapture` — PASS.
3. Full sidecar unit dir: `pnpm run test:vitest run test/unit/claude-sidecar --config config/vitest/vitest.config.ts` — PASS.

Expected: all PASS.

- [ ] **Step 8: Commit the task**

```bash
git add test/unit/claude-sidecar/fixtures/native-startup-query.mjs test/unit/claude-sidecar/native-continuation-lifecycle.test.ts crates/freshell-session-host/src/providers/fresh_agent.rs
git commit -m "test: isolate clear-backlog replay from fixture tool-continuation chain"
```

- [ ] **Step 9: Post the cnr1 kata evidence comment** (`kata comment cnr1 --body "..."`) with the starvation-repro outcome, the fingerprint confirmation, and retained evidence paths.

---

### Task 3: wjwa — bounded readiness wait for the initial parent observation

**Files:**
- Modify: `crates/freshell-session-host/src/providers/fresh_agent.rs` (test `hosted_claude_rejected_rollback_preserves_current_parent_and_followup`; base_ref: single-shot read at :6370, panic site :6517:24; sibling bounded poll at :7629-7638; near-identical polls at :6441-6448)

**Interfaces:**
- Consumes: `crate::fresh_native_observation(&launch, &actor) -> Option<...>` (an `Option` query by contract), the sibling poll pattern, the retained group-run failure as RED evidence.
- Produces: a bounded event-conditioned wait before the first observation read; all later assertions (:6371-6511 refusal/followup/Undo/retired-writer/history) untouched. No production change.

- [ ] **Step 1: Establish the RED (live, temporary, uncommitted)**

Using a temporary local edit (never committed) that delays the sidecar's init/evidence frame (fixture or sidecar test knob if one already exists; otherwise a temporary insertion-point delay in the test's own fixture wiring), show that the current single-shot read at :6370 fails with `initial parent observation missing` when evidence publication is delayed past the announce — proving the test checks too early and the actor contract (announce at `start`, evidence one frame later) is intact. Record the observed failure verbatim in the task report. (Retained RED corroboration: `test-results/viewport-screenshots/claude-clear-evidence/original_target/failure-excerpt.txt` — group-run-only failure, 4/4 exact-run passes.)

- [ ] **Step 2: Add the bounded wait**

Mirror the sibling's exact bounded poll (:7629-7638) at :6370 — wait up to a bounded timeout (sibling's 8s/10ms cadence) for `fresh_native_observation(&launch, &actor)` to become `Some`, then bind `before` from it; keep the `ok_or("initial parent observation missing")` failure for a genuine timeout so the readiness contract stays falsifiable:

```rust
let before = tokio::time::timeout(std::time::Duration::from_secs(8), async {
    loop {
        if let Some(obs) = crate::fresh_native_observation(&launch, &actor) {
            return obs;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
})
.await
.ok_or("initial parent observation missing")?;
```

(Adapt to the sibling's exact style/signatures; no sleeps on the success path beyond the poll cadence, no assertion changes.)

- [ ] **Step 3: Verify the wait is required and sufficient (GREEN)**

With the same temporary delay from Step 1 still applied, run the test: the bounded wait must carry it to green. Then remove the temporary delay entirely and run again: PASS.

Run (each): `bash scripts/sandbox-test.sh "cargo test --locked -p freshell-session-host --bin freshell-session-host providers::fresh_agent::tests::hosted_claude_rejected_rollback_preserves_current_parent_and_followup -- --exact --nocapture"`

Expected: PASS without the delay; with the temporary delay, passes only after the wait lands (Step-1 shape went red pre-wait).

- [ ] **Step 4: Refactor while green**

The poll now appears (near-identically) at :6370, :6441-6448, and :7629-7638 — factor a small `#[cfg(test)]` helper (e.g. `await_fresh_native_observation(&launch, &actor, timeout)`) and use it at all three sites; rerun the three focused tests.

- [ ] **Step 5: Run impacted-test verification**

The failing shape was the 101-test group run at 4 libtest / 2 Tokio threads. Run the whole session-host provider group repeatedly (at least 3 consecutive group runs):

Run: `bash scripts/sandbox-test.sh "cargo test --locked -p freshell-session-host --bin freshell-session-host -- --nocapture"` (with `RUST_TEST_THREADS=4` and `TOKIO_WORKER_THREADS=2` if the sandbox wrapper passes env; match the retained receipts' shape)

Expected: PASS every run (330+ passed, 0 failed); retain the run logs as the no-flake evidence.

- [ ] **Step 6: Commit the task**

```bash
git add crates/freshell-session-host/src/providers/fresh_agent.rs
git commit -m "test: await native identity evidence before rollback parent observation"
```

- [ ] **Step 7: Post the wjwa kata evidence comment** with the temporary-delay RED, the green runs, and the group-run repetition evidence.

---

### Task 4: czzp — readiness gate before checkpoint release in the package-build context

**Files:**
- Modify: `crates/freshell-session-host/src/providers/fresh_agent.rs` (test `hosted_actor_checkpoint_recovery_preserves_the_created_root_and_current_card`; base_ref: reopen at :9347-9349, resume at :9361, failing assertion :9398)
- Test (new, characterization): same file — a focused transport-level test driving the announce-only path.

**Interfaces:**
- Consumes: `FreshAgentHostActor::prepare_native_readiness()` (base_ref host_actor.rs:960-972 — waits for identity.root + published evidence + watch; fresh_agent.rs:830-855), the production gate precedent `ensure_current_fresh_native_observation` → `prepare_native_readiness` (main.rs:1044-1047, 2657-2685).
- Produces: the checkpoint test becomes deterministic across build contexts; a committed characterization test protecting the announce-vs-evidence refusal contract. Every existing assertion (:9398 receipt `Ok(())`, :9402-9405 exact checkpoint card `nativeRequestId == "native-new"`, :9406-9409 duplicate-release idempotency, :9410-9412 identity before/after, :9413-9417 byte-identical transcript, :9418 no `effect-count`) stays byte-for-byte intact.

- [ ] **Step 1: Write the characterization test (protects the refusal contract; expect PASS at base)**

Add a focused test in the same provider test module that drives ONLY the announce path (the transport's `freshAgent.created` with a claude `sessionRef`, bridge announce at base_ref :2450-2459/:2772-2787) and asserts: (i) `native_identity_evidence()` is `None` while the native watch is `Some(root)`; (ii) `resume_pending_native_permissions` refuses with `NativeIdentityMismatch` in that state. This documents the deliberate announce/publish split that makes the readiness gate necessary; it must fail if anyone weakens the guard or makes announce publish evidence.

- [ ] **Step 2: Run it and confirm the contract**

Run: `bash scripts/sandbox-test.sh "cargo test --locked -p freshell-session-host --bin freshell-session-host <new characterization test name> -- --exact --nocapture"`

Expected: PASS (this is a contract characterization, not the behavior change; its RED role is guarding the fix's premise — the refusal is correct and must not be bypassed).

- [ ] **Step 3: Add the readiness gate (the fix)**

In the checkpoint test, after the second `FreshAgentHostActor::open` (:9347-9349) and before `resume_pending_native_permissions` (:9361), insert the production readiness verb:

```rust
current
    .prepare_native_readiness()
    .await
    .expect("reopened checkpoint actor must reach native readiness");
```

This mirrors exactly the precondition production enforces (main.rs:1047) and is a no-op re-observation for a live reopened session. No assertion changes, no `NativeIdentityMismatch` bypass — the release must still be checked at :9398.

- [ ] **Step 4: Run the focused test**

Run (package context — the context that failed): `bash scripts/sandbox-test.sh "cargo test --locked -p freshell-session-host --bin freshell-session-host providers::fresh_agent::tests::hosted_actor_checkpoint_recovery_preserves_the_created_root_and_current_card -- --exact --nocapture"`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

None (single-line gate; helper already exists in production).

- [ ] **Step 6: Run impacted-test verification — both feature contexts, per acceptance**

1. Package context, group shape (the failing shape), repeated ≥3: `bash scripts/sandbox-test.sh "cargo test --locked -p freshell-session-host --bin freshell-session-host -- --nocapture"` — PASS every run.
2. Package pre-push shape: `bash scripts/sandbox-test.sh "cargo test --locked -p freshell-session-host"` — PASS.
3. Workspace context (the `rust-gate` shape, narrowed selector first, full lane later in the gate): `bash scripts/sandbox-test.sh "cargo test --workspace --locked providers::fresh_agent::tests::hosted_actor_checkpoint_recovery_preserves_the_created_root_and_current_card -- --exact --nocapture"` — PASS.
4. Regression probe: one group run with `RUST_TEST_THREADS=1` — PASS (documents the mechanism).

Expected: all PASS; retain the receipts for both contexts and disclose the package/workspace distinction in the task report (package context is covered today by the pre-push targeted lane; workspace by required `rust-gate`).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-session-host/src/providers/fresh_agent.rs
git commit -m "test: gate checkpoint release on native readiness across build contexts"
```

- [ ] **Step 8: Post the czzp kata evidence comment** with both-context results and the characterization-test name.

---

### Task 5: gc1p Fix C — typed, redacted replacement-open diagnostics end-to-end

**Files:**
- Modify: `crates/freshell-runtime-protocol/src/lib.rs` (near `FreshAgentOpenFailed` :1199 and `FreshAgentProviderStartDiagnostic` :1208-1232)
- Modify: `crates/freshell-session-host/src/main.rs` (`map_fresh_agent_open_error` :1522-1541; unit tests :9740-9762)
- Modify: `crates/freshell-supervisor/src/service.rs` (`activation_failure_data` :9961-9981)
- Modify: `crates/freshell-supervisor/src/recovery.rs` (`recovery_activation_failure_data` :5885-5905)
- Modify: `crates/freshell-server/src/fresh_agent_proxy.rs` (`dispatch_send` :169-219, error_event codes :177-185)
- Test: `crates/freshell-server/src/freshell_proxy_tests.rs` (frame contract :1434+)

**Interfaces:**
- Consumes: `ActorError` variants (host_actor.rs:422-445: NativeIdentityMismatch, WriterBusy, Persistence, AmbiguousDispatch, transport), the redaction rationale at main.rs:1517-1518, existing JSONL event fields.
- Produces: a closed, body-free `FreshAgentOpenFailureSubtype` enum (`profile_mismatch`, `writer_busy`, `state_unreadable`, `ambiguous_identity`, `transport`, …) carried from actor-open through supervisor activation/recovery failure events to a typed gateway refusal code. Tasks 6–7 rely on these diagnostics to make their failures diagnosable.

- [ ] **Step 1: Write the failing behavioral test (host mapping)**

Extend the `map_fresh_agent_open_error` unit tests (main.rs:9740-9762): for each `ActorError` variant the mapping must emit the closed subtype — e.g. `NativeIdentityMismatch` → `profile_mismatch` including the mismatched field NAMES (never values), `WriterBusy` → `writer_busy`, `Persistence` → `state_unreadable`, `AmbiguousDispatch` → `ambiguous_identity`; and no provider prose, secrets, or values cross.

Run: `bash scripts/sandbox-test.sh "cargo test --locked -p freshell-session-host --bin freshell-session-host map_fresh_agent_open_error -- --nocapture"` (adapt selector to the actual test names)

Expected: FAIL because the mapping currently collapses everything into opaque `FRESH_AGENT_OPEN_FAILED` (the missing behavior is the typed subtype).

- [ ] **Step 2: Implement the host-side subtype**

Add the closed enum to `freshell-runtime-protocol` (mirroring `FreshAgentProviderStartDiagnostic`'s shape) and extend `map_fresh_agent_open_error` to emit it per variant; for `profile_mismatch` include only field names.

- [ ] **Step 3: Write the failing tests (supervisor carry-through + gateway)**

1. Supervisor: `recovery_activation_failure_data` must carry `failureReason` (and the new subtype where the host provides it) — today it drops it entirely; `activation_failure_data` must include the subtype alongside `failureReason`. RED test asserting the event fields.
2. Gateway: `fresh_agent_proxy_tests.rs` — a supervisor `RecoveryBlocked`/open-failure reason must surface as a typed closed-enum `error_event` code in the refusal frame instead of only the fixed `MANAGED_FRESH_AGENT_ERROR` message. RED test asserting the frame's code.

Run: `bash scripts/sandbox-test.sh "cargo test --locked -p freshell-supervisor -- --nocapture"` and `bash scripts/sandbox-test.sh "cargo test --locked -p freshell-server -- --nocapture"` (narrowed selectors)

Expected: FAIL (fields/code absent).

- [ ] **Step 4: Implement the carry-through**

Wire the subtype and failureReason through `activation_failure_data`, `recovery_activation_failure_data`, and the gateway's existing `error_event`/`error_event_code` mechanism (closed enum values only; the human-readable message may stay generic).

- [ ] **Step 5: Run the focused tests**

Rerun the Step 1/3 selectors: all PASS.

- [ ] **Step 6: Refactor while green**

Keep the enum closed and the mapping table-driven if the sibling diagnostic mapping is table-driven; no behavior additions.

- [ ] **Step 7: Run impacted-test verification**

Redaction contracts that must stay green: `activation_failure_diagnostic_names_the_exact_stage_and_redacts_detail` (service.rs:7320), `codex_prepare_stage_diagnostics_reach_the_body_free_failure_reason` (service.rs:7372), `map_fresh_agent_open_error` secret-leak tests (main.rs:9740-9762), the whole `freshell_proxy_tests.rs` lane, and the supervisor recovery-retry unit set (`recovery.rs` retry tests, `registry.rs` budget tests).

Run: `bash scripts/sandbox-test.sh "cargo test --locked -p freshell-session-host -p freshell-supervisor -p freshell-server -- --nocapture"`

Expected: PASS.

- [ ] **Step 8: Commit the task**

```bash
git add crates/freshell-runtime-protocol/src/lib.rs crates/freshell-session-host/src/main.rs crates/freshell-supervisor/src/service.rs crates/freshell-supervisor/src/recovery.rs crates/freshell-server/src/fresh_agent_proxy.rs crates/freshell-server/src/freshell_proxy_tests.rs
git commit -m "feat: typed redacted fresh-agent open-failure diagnostics end-to-end"
```

---

### Task 6: gc1p Fix A1 — stop the stale resume spec from clobbering folded recovery settings

**Files:**
- Modify: `crates/freshell-session-host/src/main.rs` (grant-execution resume branch, base_ref :2310-2330; identity checks :2310-2325 stay intact; overwrite at :2326-2330)
- Test: `crates/freshell-session-host/src/main.rs` (new focused grant test) and keep `crates/freshell-supervisor/src/registry.rs:9656` `accepted_fresh_agent_turn_settings_are_part_of_exact_recovery_profile` green (the invariant's reference).

**Interfaces:**
- Consumes: the stored soul-level resume spec (`souls.resume_spec`, frozen at creation), the incarnation's folded launch spec (`context.fresh_agent` recovery profile per service.rs:2897-2901), `build_resume_spec` terminal semantics (freshell-agent-runtime lib.rs:732-810).
- Produces: grant-time composition rule — identity/environment/program come from the stored spec; turn settings (`model`, `reasoning_effort`/effort, `permission_mode`, `cwd`) come from the incarnation's folded launch spec when it carries them, and from the stored spec only for genuinely-absent fields (first-ever resume with no folded settings). Task 7 builds on this consistency.

- [ ] **Step 1: Write the failing behavioral test**

A focused session-host test: save an actor, then update its turn settings (model/effort/permission/cwd — exactly the `fresh_agent_configure` recovery-profile fold), then drive a resume through the grant-execution path and assert the launched actor uses the FOLDED settings (and opens successfully), not the stale stored spec. This mirrors the registry invariant test at registry.rs:9656 but exercises the host-side grant composition end-to-end. RED: today the stored spec overwrites the folded fields and the actor-open profile comparison rejects the launch (`NativeIdentityMismatch` → `FRESH_AGENT_OPEN_FAILED`) or silently launches with stale settings.

Run: `bash scripts/sandbox-test.sh "cargo test --locked -p freshell-session-host --bin freshell-session-host <new test name> -- --exact --nocapture"`

Expected: FAIL (stale spec wins).

- [ ] **Step 2: Add the minimal production implementation**

In the grant-execution resume branch (main.rs:2326-2330), stop overwriting `model`/`effort`/`permission_mode`/`cwd` from the stored spec when the incoming launch spec already carries the incarnation's folded settings; keep populating fields that are genuinely absent (first-ever resume). Identity fields (`native_session_id`, provider/store identity, program) still come from the stored spec; the identity checks at :2310-2325 are untouched. State the rule in a doc comment citing service.rs:2897-2901 ("the launch's folded settings ARE the recovery profile").

- [ ] **Step 3: Run the focused test**

Rerun Step 1's selector: PASS.

- [ ] **Step 4: Refactor while green**

If the branch duplicates field-by-field copying, extract a small `compose_resume_launch` helper with the rule stated once; no behavior change.

- [ ] **Step 5: Run impacted-test verification**

1. Supervisor spec/budget invariants: `bash scripts/sandbox-test.sh "cargo test --locked -p freshell-supervisor -- --nocapture"` — PASS (spec-equality list registry.rs:2779-2790 unchanged; the two `accepted_fresh_agent_turn_settings…` and idempotency-digest tests green).
2. Session-host direct-actor suite: `bash scripts/sandbox-test.sh "cargo test --locked -p freshell-session-host --bin freshell-session-host -- --nocapture"` — PASS (resume-ordering tests around :4006/:4310 "old native id must actually attempt resume", task008 settings tests, task010 mint-new test all green).

- [ ] **Step 6: Commit the task**

```bash
git add crates/freshell-session-host/src/main.rs
git commit -m "fix: folded recovery settings win over stale stored resume spec at grant execution"
```

---

### Task 7: gc1p Fix B1 — send-driven recovery for a codex native-provider exit in a live host

**Files:**
- Modify: `crates/freshell-supervisor/src/inventory.rs` (provider-exit observer classification, base_ref :316-340)
- Modify: `crates/freshell-supervisor/src/service.rs` (admission gate `authenticate_current_fresh_host` :2582-2694 — typed recoverable state instead of the blanket `status.exited` refusal at :2674-2693; codex readiness arm analogous to `can_prepare` :2601-2603)
- Modify: `crates/freshell-session-host/src/main.rs` (send-time guard: `HostCommand::FreshAgentSend` handler runs `ensure_current_fresh_native_observation` before `actor.dispatch`, base_ref :1078 and :1086-1094; `FreshAgentPrepareNative` gate :1021 — third blocker found by load-bearing validation)
- Modify: `crates/freshell-session-host/src/providers/fresh_agent.rs` (`prepare_native_readiness` codex arm, base_ref :790-793 — currently a no-op for codex; `observed_native_session_id` returns `None` when `!is_live` per host_actor.rs:1006-1009 → codex `has_live_session` codex.rs:7292-7297)
- Modify (as needed): `crates/freshell-supervisor/src/recovery.rs` (suppress whole-host replacement for the new live-host class; keep replacement + RETRY_BUDGET for host-process death/OOM)
- Test: supervisor unit tests (new classification + admission tests), session-host unit tests (new send-guard recoverable-state test), and the existing neighbors stay green.

**Interfaces:**
- Consumes: Task 5's typed diagnostics (failure visibility), Task 6's settings consistency (replacement launches, other failure classes, stay correct), the direct adapter's proven send path (`ensure_session_alive` mint-new on `threadNotFound`, codex.rs:7636-7667) and its typed `NativeDispatchIdentity` commit (providers/fresh_agent.rs:1189-1226 → service.rs:2511-2537), the `is_codex_thread_not_found` classifier, the owned-tree proof discipline (`task010_failed_resume_confirms_its_owned_tree_before_minting_again`, providers/fresh_agent.rs:3422).
- Produces: a supervisor classification distinguishing (i) host-process death (or other whole-host classes) — existing whole-host replacement + RETRY_BUDGET semantics unchanged — from (ii) a codex native-provider exit while the host process and durable actor are intact: the soul remains send-admitted, no whole-host replacement, and the next send drives the existing recover-on-send path whose typed identity commit moves the native root durably. The SAME typed recoverable state must be recognized at BOTH gates on the send path: the supervisor admission gate AND the session-host send-time current-native-observation guard, which must route the send to the actor's recover-on-send (owned-tree proof → mint-new → typed commit) instead of refusing with `NATIVE_IDENTITY_UNOBSERVED` (`RecoveryWrongIdentity`). Scoped to codex managed sessions; claude/kilroy/opencode crash policies and the guard's Claude rescue arm are unchanged.

- [ ] **Step 1: Write the failing behavioral test (observer classification)**

Supervisor unit test: a provider-exit observation for a codex managed session whose HOST process is alive (and durable actor intact) must classify as send-recoverable (NOT whole-host-replaceable) and must not flip the soul out of its live/recovery-neutral state; a host-process death observation must still classify as whole-host-replaceable. RED: today provider-exit in a live host triggers whole-host replacement.

Run: `bash scripts/sandbox-test.sh "cargo test --locked -p freshell-supervisor -- --nocapture"` (narrowed to the new test name)

Expected: FAIL (no such class exists).

- [ ] **Step 2: Implement the classification**

Split the observer classification in inventory.rs (:316-340) per the interface contract; record the class in the supervisor's soul/session status as a typed, honest state (e.g. exited-send-recoverable), and suppress the whole-host replacement for class (ii) in recovery.rs. Budget semantics (3 attempts, RETRY_BUDGET persisted verdict, manual rearm) stay byte-identical for class (i). Add a focused registry test asserting the original writer claim on the old root still exists when the commit's writer-claim clause runs (validator new-assumption 1).

- [ ] **Step 3: Write the failing behavioral test (admission gate)**

Supervisor unit test: a send through the original public reference against a soul in the send-recoverable class is ADMITTED (drives the actor recover-on-send path) instead of the blanket refusal at :2674-2693; a send against a genuinely dead host still refuses with the existing typed error. RED: today the gate refuses on `status.exited` unconditionally.

Run: same narrowed selector.

Expected: FAIL (blanket refusal).

- [ ] **Step 4: Implement the admission gate**

In `authenticate_current_fresh_host` (:2582-2694), replace the blanket `status.exited` refusal with a typed recoverable-state branch for the codex live-host class: admit the send to the actor lane. The codex readiness arm mirrors `can_prepare` (:2601-2603). Non-codex providers and genuinely-dead hosts keep today's behavior.

- [ ] **Step 5: Write the failing behavioral test (session-host send-time guard — the third blocker)**

Session-host unit test: with a codex session whose host process and durable actor are alive but whose native process is dead (native root's history archived/absent), a `FreshAgentSend` that carries the typed recoverable state must reach the actor's recover-on-send (eventually minting a new native conversation and committing the typed identity) instead of being refused at `ensure_current_fresh_native_observation` with `NATIVE_IDENTITY_UNOBSERVED`; the same send WITHOUT the recoverable state (an unclassified dead-native session) must still refuse exactly as today (the identity fence stays intact for everyone else). RED: today the guard refuses unconditionally because `observed_native_session_id` is `None` when `!is_live` and the only rescue arm (`prepare_native_readiness`) is a no-op for codex.

Run: `bash scripts/sandbox-test.sh "cargo test --locked -p freshell-session-host --bin freshell-session-host <new test name> -- --exact --nocapture"`

Expected: FAIL (send-time refusal).

- [ ] **Step 6: Implement the send-guard routing**

Make the send-time guard recoverable-state-aware for the codex live-host class, mirroring the production Claude rescue shape: either the guard's `prepare_native_readiness` path gains a codex arm (no longer a no-op for a live-host/dead-native codex session, routing into the actor's recover-on-send) or the `FreshAgentSend`/`FreshAgentPrepareNative` handlers (main.rs:1078/:1021) accept the supervisor's typed recoverable marker and dispatch to the actor lane that runs `ensure_session_alive` (owned-tree proof → proved `threadNotFound` → mint-new → typed `NativeDispatchIdentity` commit). Choose the arm that keeps the guard's intent — never write into an identity you cannot prove you own; the mint path itself proves ownership through the durable actor/journal (`task010` discipline). Ownership invariants preserved: public alias and original reference survive; the native root moves ONLY through the typed commit; archived original bytes are never written. Watch the naming-handle interaction the validator flagged (new-assumption 2): a freshly minted thread's `pending_naming_handle` is expected `None` and the parity test's old/new name-policy assertions must still hold — cover it in this task's focused tests.

- [ ] **Step 7: Run the focused tests**

Rerun Steps 1/3/5 selectors: PASS.

- [ ] **Step 8: Refactor while green**

Keep the classification a pure function over the observation + host liveness facts; no new policy knobs or config.

- [ ] **Step 9: Run impacted-test verification**

1. Supervisor lanes: `bash scripts/sandbox-test.sh "cargo test --locked -p freshell-supervisor -- --nocapture"` — PASS (all recovery.rs retry tests, registry budget/spec tests, plus the new writer-claim test).
2. Session-host lanes: `bash scripts/sandbox-test.sh "cargo test --locked -p freshell-session-host --bin freshell-session-host -- --nocapture"` — PASS (task008 settings tests, task010 owned-tree mint-new test, resume-ordering tests around :4006/:4310, the map_fresh_agent_open_error tests from Task 5).
3. Client-side budget semantics: `pnpm run test:vitest run test/runtime/gates/phase-3.test.ts --config config/vitest/vitest.config.ts` — PASS (RETRY_BUDGET persistence + manual-retry semantics unchanged).
4. Managed terminal-provider crash lanes (different provider class — must be undisturbed): `FRESHELL_RUST_TEST_SANDBOX=1 pnpm run test:vitest run test/integration/server/managed-provider-parity.test.ts --config config/vitest/vitest.config.ts` — PASS.

- [ ] **Step 10: Commit the task**

```bash
git add crates/freshell-supervisor/src/inventory.rs crates/freshell-supervisor/src/service.rs crates/freshell-supervisor/src/recovery.rs crates/freshell-session-host/src/main.rs crates/freshell-session-host/src/providers/fresh_agent.rs
git commit -m "feat: send-driven managed codex recovery for native exit in a live host"
```

---

### Task 8: gc1p acceptance — full installed parity case + both Rust contexts + retained evidence

**Files:**
- No new files expected; fix-ups land in the files from Tasks 5-7 if the case exposes gaps (each fix-up gets its own focused test and commit).

**Interfaces:**
- Consumes: Tasks 5-7 complete; the installed parity case's post-crash contract (test/integration/server/fresh-agent-parity.test.ts, base_ref post-crash section :1000-1100: first recovery send accepted through the ORIGINAL public reference, saved settings retained, committed native identity, pending-question resolution, second prompt, old/new history and name policies, archived original bytes preserved).

- [ ] **Step 1: Run the entire installed Codex parity case in the disposable sandbox**

Run: `GCLOUD_ROBOT_REQUIRE=1 FRESHELL_RUST_TEST_SANDBOX=1 FRESHELL_TEST_SUMMARY='gc1p installed parity acceptance' pnpm run test:vitest run test/integration/server/fresh-agent-parity.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS — the whole case, including every post-crash assertion that previously failed at the first recovery send (base_ref :1041). If any assertion fails, capture the Task-5 diagnostics from the retained JSONL logs, fix the substantiated gap in the owning task's files with its own focused test, and rerun. Do not relax any assertion. This run also settles the validator's gateway-ownership-fence assumption (the case drives the recovery send through the original public reference with the gateway's ownership fence active — retained evidence proves the fence held pre-crash, and this run proves it holds across the identity commit).

- [ ] **Step 2: Run the managed-recovery neighbor lanes**

Run: `FRESHELL_RUST_TEST_SANDBOX=1 pnpm run test:vitest run test/integration/server/managed-provider-parity.test.ts --config config/vitest/vitest.config.ts` and `FRESHELL_RUST_TEST_SANDBOX=1 pnpm run test:vitest run test/runtime/gates/phase-3.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS (terminal-provider crash/host-restart and budget semantics undisturbed).

- [ ] **Step 3: Both Rust contexts green**

1. Package pre-push shape (narrowed/delegated): `bash scripts/sandbox-test.sh "cargo test --locked -p freshell-session-host"` — PASS.
2. Workspace shape, narrowed provider-group selector (delegated): `bash scripts/sandbox-test.sh "cargo test --workspace --locked providers::fresh_agent::tests -- --nocapture"` — PASS (the cnr1/wjwa/czzp cases deterministic after Tasks 1-4).
3. Full coordinated Rust lane (gate-holding): `FRESHELL_RUST_TEST_SANDBOX=1 GCLOUD_ROBOT_REQUIRE=1 FRESHELL_TEST_SUMMARY='gc1p acceptance workspace rust lane' pnpm run test:rust` — wait for the shared coordinator gate; PASS. (The execution-end full-suite gate re-covers the whole workspace.)

Expected: PASS; retain receipts for both contexts.

- [ ] **Step 4: Retain evidence and post the gc1p kata comment**

Save the parity-case log, the JSONL lifecycle/frame evidence, and the Rust receipts under the run's reports dir; `kata comment gc1p --body "..."` summarizing: root cause (two layers), the fixes (A1, B1, C), the acceptance commands and results, and the evidence paths. Do not close the issue yet — closure follows the final delta review.

- [ ] **Step 5: Commit any fix-ups (or none)**

If Step 1-3 required fix-ups, each is already committed with its focused test; otherwise note "no fix-ups needed" in the task report. There is no separate commit for this task's verification work.

---

## Verification summary (whole plan)

- Focused lanes: the per-task commands above (sandboxed cargo selectors, repo-owned Vitest paths, sidecar lifecycle tests).
- Whole-branch: the coordinator-gated full suite at execution end (`GCLOUD_ROBOT_REQUIRE=1 FRESHELL_TEST_SUMMARY='...' pnpm run check` or `pnpm run test` per the gate procedure), green excluding nothing — the four tracked Kata failures must be FIXED, not excluded.
- Kata closure after the final delta review passes: `kata close gc1p`, `kata close cnr1`, `kata close wjwa`, `kata close czzp` with closing comments referencing the branch commits and evidence; fy2w untouched.
