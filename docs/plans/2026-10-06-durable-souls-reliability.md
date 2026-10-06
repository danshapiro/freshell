# Durable Souls Reliability Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Fix all durable-souls problems identified in the preceding diagnosis using the-usual: transfer and verify existing OpenCode history into the correct managed stores and prepare restoration of the seven surviving roots now referenced by nine lost souls with duplicate mappings; prevent loss certification from missing identity or uninspected provider storage; prove resumed identity from provider evidence; fix provider-config permission failures and reconcile blocked existing runtimes; put bounded restart-safe recovery retries in the supervisor; finish interrupted ordinary Stop transactions; qualify currently deferred Claude, Codex, Amplifier and fresh-agent modes with real provider recovery evidence; establish actual managed-runtime browser coverage and truthful current readiness evidence.

### Explicit constraints
- Use the-usual and dedicated git worktrees; preserve unrelated and existing repair work.
- If the worktree is not green, fix the failures and continue.
- Use meaningful red/green/refactor tests, integration and actual managed-runtime browser/smoke coverage, and independent reviews.
- Follow repository pnpm pins, test coordination, configured backends, OneCLI credential handling, structured logging and process safety.
- Do not create a PR without explicit approval for this change.
- Do not restart the live self-hosted server without the separate exact word APPROVED; prepare concrete reviewed restoration and deployment steps before requesting it.
- Do not discard, stash, revert, or remove unrelated changes; inspect existing repair work and reuse valid work safely.

### Accepted tradeoffs and residuals
- A failing starting worktree is acceptable; repair it and continue.
- Live deployment and state restoration remain subject to the repository's explicit production approval requirements.


**Goal:** Make managed conversations recover without inventing identity or loss evidence, complete durable recovery and Stop transactions after crashes, prove every requested provider mode on the actual managed runtime, and leave a reviewed nine-soul/seven-root restoration ready for separately approved deployment.

**Architecture:** Reuse the existing OpenCode exporter/importer, adoption baseline, stopped repair CAS, and exact withdrawal implementation by three-way integration, preserving newer main changes. Treat source census, installed-store readability, and launch-bound provider observation as distinct evidence; the supervisor owns persisted retry and Stop reconciliation. Run Cloud Run browsers through HTTP/WSS to an isolated rootless Docker managed rig, derive qualification receipts from real turns and lifecycle records, and bind release readiness to the final candidate.

**Tech Stack:** Rust/Tokio/Axum/rusqlite, rootless Docker, TypeScript/NodeNext, React/Redux, Vitest, Playwright, pnpm 10.34.5, existing OneCLI provider-reference interfaces, Cloud Run test backends.

## Global Constraints

1. Work only in `/home/dan/code/freshell/.worktrees/durable-souls-reliability`, branch `the-usual/durable-souls-reliability`, originally based on `d0cc7cb5e038811be0fb3ff5f4fc5812d2723228`. The clean-base receipt and fresh base confirmation belong to the parent run; do not repeat or silently replace their scope. Shared state and source worktrees have other owners.
2. Do not mutate either existing source worktree. Capture immutable source artifacts before destination integration. Source OpenCode HEAD is `8362581b8c90de7e192a353b2256a7a5e71b5494`, merge-base `e04a1d8601a2180c85128b3ed4154350d5e0ad25`; integrate its feature interval and coherent relevant dirty snapshot, not a whole-tree overlay. The environment source advanced from independently rejected `c4c55c1a2` to bounded repair commit `5033898b4` during planning. Capture that exact committed pair, independently test/review the three-file repair and its dependencies, and do not infer final prior-run approval. Safe reuse requires bounded committed snapshots or independently tested/reviewed captured patches, never waiting indefinitely or copying an active working file.
3. Current scope is **nine exact soul/incident targets and seven roots**. Do not assume eight targets, which roots have duplicates, or who owns a duplicate. Fresh body-free preflight supplies exact IDs/revisions/root mappings and typed canonical-owner decisions. Import each root once. A real conversation stays stopped; no test prompts or automatic real-session resume.
4. Requested identity, old transcript existence, imported structure, authenticated host status, and provider-observed replacement identity have different meanings. No request argument or old receipt may certify LIVE. Missing identity or unreadable/uninspected/partial/ambiguous stores cannot certify absence or loss. Preserve proven never-dispatched pristine-seed handling and shell terminal-end policy.
5. Respect the existing UID/GID and zero-capability provider boundary, read-only container root, writable provider volume, and rootless Docker broker. Do not add DAC_OVERRIDE/FOWNER, chmod host configuration, expose a Docker socket to Cloud Run, or mount operator homes.
6. Credentials use existing `FRESHELL_MANAGED_{CLAUDE,CODEX,OPENCODE,AMPLIFIER}_ONECLI_ENV_FILE` and `_AUTH_FILE`, plus OpenCode `_CA_FILE`, provisioned through OneCLI on garageserver. Mount exact readable canonical grants. Log references/status only; no secret values or transcript bodies in reports/runbooks. Retain the documented Kilroy Claude bootstrap exception.
7. Use pinned pnpm and frozen installs. NodeNext relative imports include `.js`. Coordinated broad gates use `GCLOUD_ROBOT_REQUIRE=1`, a meaningful `FRESHELL_TEST_SUMMARY`, and the configured cloud backends. Do not force local because managed specs are skipped in cloud. Complete the external HTTP/WSS topology. A backend failure is a failure until fixed or the user explicitly authorizes substitution.
8. Destructive tests run in disposable sandbox or the owned isolated rootless runtime rig. Stop only exact recorded PIDs/containers after ownership verification. The live server on 3001 is untouched. Use [test sandbox](../development/test-sandbox.md), [managed runtime](../development/managed-runtime.md), [rollout](../development/managed-runtime-rollout.md), [pre-push gate](../development/pre-push-gate.md), and [self-hosted launch runbook](../development/self-hosted-launch-runbook.md).
9. Emit structured events with severity for recovery classification, retry reservation/result/exhaustion, Stop continuation/result, config publication failure, source/import/adoption mismatch, and readiness refusal. Include soul/incarnation/revision/generation and typed reason; omit bodies and credential values. Observability is required; an audit subsystem is outside this task.
10. Every new behavioral slice uses a real failing test, the minimal production change, a green refactor, impacted tests, a focused commit, and independent specification and quality review. Imported historical red/green evidence is provenance, not current verification. Never accept skipped tests, zero selections, fixture-only transport, or hardcoded assertion flags as real qualification. Fix failures rather than reduce coverage.
11. No PR is currently authorized. Commit and push the clean feature branch after checks, then request explicit PR approval. Live deployment/restoration requires separate exact **APPROVED**. Do not recreate a local dev branch or restart production. This plan is agent documentation; end-user usage belongs in README.md. A significant UI change also updates docs/index.html.

---

## Evidence and file responsibilities

Planning inputs are the current run's `reports/plan-existing-repair.md` and `reports/plan-lifecycle-qualification.md` under `/home/dan/code/freshell/.worktrees/.the-usual-logs/durable-souls-reliability`. Those reports are read-only observations. Historic task PASS receipts do not certify the integrated tree. Source dirty repair addresses known defects but requires execution and new review.

Files below have one responsibility; Task Files lists are the authoritative mutation boundaries. Existing test modules may remain inline where the crate already uses them. Do not restructure unrelated runtime code.

| Files | Responsibility |
| --- | --- |
| `crates/freshell-sessions/src/opencode_transfer.rs`, `opencode_schema_v1_18_21.sql`, `tests/opencode_native_transfer.rs`, `src/lib.rs`, `src/directory_index.rs`, `Cargo.toml` | Exact pinned native export, complete reference closure, preserve current-main Codex discovery wiring |
| `crates/freshell-agent-runtime/src/lib.rs`, `crates/freshell-runtime-protocol/src/lib.rs`, `crates/freshell-runtime-client/src/lib.rs`, `port/contract/managed-runtime.schema.json`, `shared/managed-runtime.ts` | Transfer/import, typed evidence and exact repair request/reply contracts |
| `crates/freshell-supervisor/src/opencode_transfer.rs`, `opencode_transfer_tests.rs`, `stopped_repair_cas.rs`, `loss_report.rs`, `loss_report_tests.rs`, `notice_outbox.rs`, `resume_catalog.rs`, `backend/native_history.rs` | Import ownership, stopped restoration, source census, installed receipts, exact loss withdrawal |
| `crates/freshell-supervisor/src/registry.rs`, `recovery.rs`, `inventory.rs`, `service.rs`, `lib.rs`, new `recovery_retry.rs` | Durable lifecycle state, conservative probes, scheduled retries, ordinary Stop continuation |
| `crates/freshell-platform/src/provider_environment.rs`, `src/lib.rs`, `crates/freshell-session-host/src/main.rs` | Owned provider configuration staging/publication and provider-identity execution |
| `crates/freshell-session-host/src/pty.rs`, new `providers/native_identity.rs`, `providers/mod.rs`, `providers/fresh_agent.rs`, `providers/deterministic_fresh_agent.rs`, `crates/freshell-platform/src/cli_launch.rs` | Launch-correlated terminal/fresh identity observations; preserve Codex/OpenCode gates, existing Claude SessionStart hooks and Amplifier native lifecycle events |
| `crates/freshell-server/src/managed_runtime_api.rs`, `src/lib/recovery/managed-runtime-recovery.ts`, `src/lib/managed-runtime-retry.ts`, `src/components/ManagedRuntimeRecoveryCard.tsx` | Authenticated exact repair operation and contextual stopped Resume/failure/retry presentation |
| `extensions/opencode/freshell-rebind-plugin.ts`, `test/unit/extensions/opencode-rebind-plugin.test.ts` | Real pinned TUI slot registration and nonce/generation/root-bound adoption |
| `scripts/testing/runtime-sandbox.ts`, `runtime-test-broker.ts`, new `runtime-external-browser.ts`, `test/e2e-browser/helpers/managed-runtime.ts`, new `helpers/external-managed-runtime.ts` | Owned actual managed rig, finite broker actions, external Cloud browser target and cleanup |
| `test/e2e-browser/playwright.config.ts`, `playwright.cloud.config.ts`, `scripts/e2e-cloud.sh` | Closed external project selection, positive executed counts, backend-preserving dispatch |
| `scripts/testing/runtime-provider-qualification.ts`, `runtime-fresh-agent-qualification.ts`, `runtime-landing-campaign.ts`, `provider-qualification-receipt.ts`, `fresh-agent-qualification-receipt.ts`, new `qualification-observations.ts` | Provider selection/campaign dispatch and receipts derived from candidate-bound executed evidence |
| `test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts`, `runtime-managed-provider-qualification-rust.spec.ts`, `runtime-fresh-agent-qualification-rust.spec.ts`, `runtime-terminal-continuity-rust.spec.ts`, `runtime-lost-soul-notice-rust.spec.ts` | Actual browser repair/recovery/Stop and all terminal/fresh provider proofs |
| `test/e2e-browser/fixtures/managed-opencode-host-status.cjs`, `.node-test.cjs`, `managed-opencode-source.ts` | Imported isolated synthetic OpenCode graph/host fixtures; never real conversations |
| `docs/development/runtime-provider-capabilities.json`, `crates/freshell-supervisor/src/service.rs`, `scripts/testing/provider-certification.ts`, `runtime-gate.ts`, `runtime-gate-integrity.ts`, `runtime-phase-scope.ts`, `runtime-phase5-evidence-common.ts` | Synchronized capability promotion and final current-candidate Gate 5 readiness |
| `docs/development/durable-souls-restoration-runbook.md`, `AGENTS.md`, `README.md` | Reviewed agent operational procedure, link discovery, concise affected usage |

Line references in tasks refer to original base and may move during replay. Match named functions, not stale line numbers. Source plan changes are historical artifacts, not current authority; do not import old approval language into this plan or run-state.

## Execution topology and evidence contract

The rootless rig runs on the host whose Docker socket and source bind paths agree, normally garageserver. Build from an immutable clean candidate checkout there when needed; preserve local worktree ownership. Cloud Run Chromium receives only run-owned HTTPS/WSS endpoints and the run token. The rig owns source fixtures, volumes, restricted broker, registry, supervisor and web server. The external control surface accepts only that run ID/candidate, predeclared fixture IDs and exact managed handles. There is no generic shell, arbitrary path, Docker API forwarding, or production control route. Use an owned temporary tunnel following the environment work's validated seam, or an existing supported authenticated relay; record endpoint lifetime and cleanup, never treat a synthetic echo server as managed runtime evidence.

Every receipt records candidate SHA and clean tree/content fingerprint, runtime image digest, artifact hashes, explicit selections, executed/passed/skipped counts, run ID, actual provider executable/SDK version, provider-effective model/effort, exact soul/native root/store, replacement incarnation observations, real native completed-turn records, and owned cleanup status. Receipt validators independently derive claims from referenced artifacts and reject mismatches, missing artifacts, skipped/zero selections, or failed cleanup. Re-run candidate evidence after promotion/source changes; do not re-label historical receipts.

### Task 1: Preserve and integrate OpenCode repair for the exact nine-target batch

**Files:**
- Modify: `Cargo.lock`, `crates/freshell-agent-runtime/Cargo.toml`, `crates/freshell-platform/Cargo.toml`, `crates/freshell-runtime-protocol/Cargo.toml`, `crates/freshell-server/Cargo.toml`, `crates/freshell-session-host/Cargo.toml`, `crates/freshell-sessions/Cargo.toml`, `crates/freshell-supervisor/Cargo.toml` for imported feature dependencies.
- Modify: `crates/freshell-agent-runtime/src/lib.rs`, `crates/freshell-platform/src/cli_launch.rs`, `crates/freshell-platform/src/opencode_plugin.rs`, `crates/freshell-runtime-client/src/lib.rs`, `crates/freshell-runtime-protocol/src/lib.rs`.
- Create: `crates/freshell-agent-runtime/src/opencode_transfer.rs`, `crates/freshell-agent-runtime/src/opencode_transfer_tests.rs`, `crates/freshell-runtime-protocol/src/opencode_transfer_tests.rs`, `crates/freshell-sessions/src/opencode_transfer.rs`, `crates/freshell-sessions/src/opencode_schema_v1_18_21.sql`, `crates/freshell-sessions/tests/opencode_native_transfer.rs`.
- Modify: `crates/freshell-sessions/src/directory_index.rs`, `crates/freshell-sessions/src/lib.rs` at the OpenCode/Codex wiring overlap.
- Modify: `crates/freshell-server/src/managed_runtime.rs`, `crates/freshell-server/src/managed_runtime_api.rs`, `crates/freshell-server/src/managed_runtime_api_stop_tests.rs`, `crates/freshell-session-host/src/command_journal.rs`, `crates/freshell-session-host/src/main.rs`, `crates/freshell-session-host/src/providers/mod.rs`, `crates/freshell-session-host/src/providers/deterministic_fresh_agent.rs`, `crates/freshell-session-host/src/pty.rs`, `crates/freshell-session-host/tests/opencode_docker_contract.rs`.
- Modify: `crates/freshell-supervisor/src/backend.rs`, `crates/freshell-supervisor/src/backend/native_history.rs`, `crates/freshell-supervisor/src/lib.rs`, `crates/freshell-supervisor/src/loss_report.rs`, `crates/freshell-supervisor/src/loss_report_tests.rs`, `crates/freshell-supervisor/src/notice_outbox.rs`, `crates/freshell-supervisor/src/recovery.rs`, `crates/freshell-supervisor/src/registry.rs`, `crates/freshell-supervisor/src/resume_catalog.rs`, `crates/freshell-supervisor/src/service.rs`.
- Create: `crates/freshell-supervisor/src/opencode_transfer.rs`, `crates/freshell-supervisor/src/opencode_transfer_tests.rs`, `crates/freshell-supervisor/src/stopped_repair_cas.rs`.
- Modify: `docs/development/runtime-provider-capabilities.json`, `extensions/opencode/freshell-rebind-plugin.ts`, `src/components/ManagedRuntimeRecoveryCard.tsx`, `src/lib/managed-runtime-retry.ts`, `port/contract/managed-runtime.schema.json`, `shared/managed-runtime.ts`, `scripts/testing/runtime-sandbox.ts`, `scripts/testing/runtime-test-broker.ts`, `test/e2e-browser/helpers/managed-runtime.ts`, `test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts`.
- Test: `test/unit/client/components/ManagedRuntimeRecoveryCard.test.tsx`, `test/unit/extensions/opencode-rebind-plugin.test.ts`, `test/unit/lib/managed-runtime-retry.test.ts`, `test/unit/lib/managed-runtime-recovery.test.ts`, `test/unit/tooling/testing/runtime-test-broker.test.ts` and the imported Rust tests listed above.
- Create: `test/e2e-browser/fixtures/managed-opencode-host-status.cjs`, `test/e2e-browser/fixtures/managed-opencode-host-status.node-test.cjs`, `test/e2e-browser/fixtures/managed-opencode-source.ts`.

**Interfaces:**
- Consumes: immutable feature interval `e04a1d860..8362581b8` and coherent binary dirty patch plus three untracked fixtures; current base's Codex reconstruction and session directory behavior.
- Produces: existing `RestoreLostSoulsRequest::validate_exact_batch`, `ImportReceipt`, `InstalledStoreReadable`, and `ResumeSpec.opencode_adoption_baseline`, reconciled to accept exactly nine distinct soul/incident targets over exactly seven validated source roots. Counts in replies derive from validated sets; unique canonical ownership produces seven imports and preserves all explicit views.

**Before Step 1:** Capture source HEAD, `git status --porcelain=v1`, `git diff --binary HEAD`, and the exact three fixture bytes to the external run preservation directory, hash each, and recapture if source fingerprints differ before/after. Record no secret values. Replay chronological committed feature commits in the destination only, resolving each against current main. Never apply `git diff d0cc7cb5e..8362581b8` or a whole tree overlay. Apply the coherent captured dirty patch after replay. Keep source unchanged. Historical test code arrives with reuse; the following count regression is a fresh red phase. Repair compile/typecheck/Clippy blockers so the test fails for behavior.

- [ ] **Step 1: Write the failing behavioral test**

In the existing exact-batch tests, clone the eight-target fixture's valid duplicate target to a **different soul and incident** with its own revision, mapped to a second existing root. Run `validate_exact_batch()` and the stopped repair operation. Assert nine accepted targets, seven imports, seven stopped canonical owners, two redundant mappings removed only after explicit view rebind, nine exact incident withdrawals, and preserved unrelated notices. Add distinct cases for 8 and 10 targets, duplicate soul or incident, six/eight roots, conflicting owner receipts, sole eligible owner, retired duplicates, and a genuine unresolved owner with typed choices. The ninth target must be valid except for old count policy; do not make the test fail on absent APIs or fixture setup.

Replace the protocol's historical eight-target unit case with this complete behavioral case, then add the production stopped-repair cases above beside the existing fixture tests:

```rust
#[test]
fn stopped_repair_exact_batch_nine() {
    let request = RestoreLostSoulsRequest {
        targets: (0..9).map(|_| LostSoulRepairTarget {
            soul_id: SoulId::new(),
            incident_id: IncidentId::new(),
            expected_intent_revision: 1,
        }).collect(),
        canonical_owners: Vec::new(),
        expected_control_epoch: Some(1),
    };
    assert!(request.validate_exact_batch().is_ok());
    let mut eight = request.clone();
    eight.targets.pop();
    assert!(eight.validate_exact_batch().is_err());
    let mut ten = request.clone();
    ten.targets.push(LostSoulRepairTarget {
        soul_id: SoulId::new(),
        incident_id: IncidentId::new(),
        expected_intent_revision: 1,
    });
    assert!(ten.validate_exact_batch().is_err());
    let mut duplicate_soul = request.clone();
    duplicate_soul.targets[8].soul_id = duplicate_soul.targets[0].soul_id.clone();
    assert!(duplicate_soul.validate_exact_batch().is_err());
    let mut duplicate_incident = request.clone();
    duplicate_incident.targets[8].incident_id = duplicate_incident.targets[0].incident_id.clone();
    assert!(duplicate_incident.validate_exact_batch().is_err());
    let mut stale = request;
    stale.targets[0].expected_intent_revision = 0;
    assert!(stale.validate_exact_batch().is_err());
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-runtime-protocol stopped_repair_exact_batch_nine`

Run: `cargo test -p freshell-supervisor restore_lost_souls_nine`

Expected: FAIL because the integrated old implementation requires eight targets and has eight-count accounting.

- [ ] **Step 3: Add the minimal production implementation**

Apply this exact contract patch: define `LOST_SOUL_REPAIR_TARGET_COUNT: usize = 9` and `LOST_SOUL_REPAIR_ROOT_COUNT: usize = 7` next to `RestoreLostSoulsRequest`; validate distinct soul/incident target counts against the first and server-resolved distinct source roots against the second. Replace eight target assumptions in stopped-repair admission/CAS/withdrawal/result construction with those validated counts. Replace positional `targets[7]` duplicate handling with grouping by exact `(source_store_id, native_root_id)` and canonical-owner evidence. A sole eligible owner is chosen; multiple eligible candidates require explicit typed selection matching the current revision; no eligible owner blocks. Preserve receipt/import and exact CAS fencing. Reconcile the three sessions wiring overlaps by retaining current Codex modules/dependencies/indexing and adding OpenCode export wiring. Do not remove current-main fixes.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-runtime-protocol stopped_repair_exact_batch_nine`

Run: `cargo test -p freshell-supervisor restore_lost_souls_nine`

Expected: PASS; historical eight-batch tests are changed to run the actual revised behavior, not retained as static contract-copy assertions.

- [ ] **Step 5: Refactor while green**

Consolidate target/root count policy in the protocol constants and derive replies from operation state. Keep grouping/owner validation shared between preflight and CAS, without widening admission to arbitrary bulk operations.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-sessions -p freshell-runtime-protocol -p freshell-runtime-client -p freshell-agent-runtime -p freshell-supervisor`

Run: `cargo test -p freshell-session-host`

Run: `cargo test -p freshell-server --features managed-runtime-v1`

Run: `pnpm run test:vitest run test/unit/extensions/opencode-rebind-plugin.test.ts test/unit/lib/managed-runtime-recovery.test.ts test/unit/tooling/testing/runtime-test-broker.test.ts --config config/vitest/vitest.config.ts`

Run: `node --test test/e2e-browser/fixtures/managed-opencode-host-status.node-test.cjs`

Run: `cargo fmt --all --check`

Run: `cargo clippy -p freshell-sessions -p freshell-runtime-protocol -p freshell-runtime-client -p freshell-agent-runtime -p freshell-supervisor -p freshell-session-host -p freshell-server --all-targets --features freshell-server/managed-runtime-v1 -- -D warnings`

Run: `pnpm run typecheck`

Run: `scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-supervisor opencode_transfer_queue_recovers_after_supervisor_process_crash -- --ignored"`

Run: `scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-supervisor opencode_transfer_promoted_queue_recovers_after_supervisor_process_crash -- --ignored"`

Run: `scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-supervisor opencode_transfer_import_stage_recovers_each_durable_file_boundary_after_process_crash -- --ignored"`

Run: `scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-agent-runtime opencode_importer_restarts_after_native_transaction_boundaries -- --ignored"`

Run: `scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-session-host opencode_host_restarts_at_receipt_and_pre_pty_durable_boundaries -- --ignored"`

Run: `scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-supervisor opencode_registry_readiness_commit_survives_process_crash_and_reopen -- --ignored"`

Expected: PASS with newer Codex reconstruction intact and all six imported crash-parent matrices executed. Assert every selector has nonzero cases. Host-default ignored destructive cases do not count as executed. No capability/real-provider qualification is claimed by this task.

- [ ] **Step 7: Commit the task**

Stage only the reconciled OpenCode implementation and its exact fixture/tests, excluding unrelated source dirty files or historic plan edits. Run `git diff --cached --stat`, inspect every staged path, then `git commit -m "fix(runtime): integrate exact nine-soul OpenCode repair"`. Preserve replayed atomic source commits and record the capture hashes and final source/destination provenance in the external task report.

### Task 2: Publish provider configuration under its real filesystem identity

**Files:**
- Create by bounded source reuse: `crates/freshell-platform/src/provider_environment.rs`.
- Modify: `crates/freshell-platform/src/lib.rs`, `crates/freshell-session-host/src/main.rs:1180`, `crates/freshell-supervisor/src/recovery.rs:2064`.
- Create: `scripts/testing/probe-provider-config-readonly-home.py` from a coherent independently reviewed snapshot if available; otherwise implement that bounded probe here.
- Test: inline provider environment tests, session-host configuration tests, `test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts`.

**Interfaces:**
- Consumes: exact typed bootstrap references and owned provider HOME/UID/GID; existing bounded copier and projection API from the environment source, reviewed against its two recorded Critical defects.
- Produces: atomic refresh with staging inside an existing writable provider volume, preservation of pre-existing inodes/siblings on failure, creator-owned path ledger, and projection/readability under actual provider identity. Existing blocked souls can retry the exact root after fixture dependency repair.

- [ ] **Step 1: Write the failing behavioral test**

Extend the production copier/publication tests with a read-only parent and writable provider HOME on a different filesystem; prepare a pre-existing config containing executable-resource and unrelated sibling sentinels. Execute initial and resume projection as UID 65534/GID 0 with zero effective capabilities. Inject a copy/publication failure after replacing the first file. Assert original inode/bytes and siblings survive, no staging escapes the provider volume, the next refresh succeeds, and OpenCode expectation publication is readable/writable under the same provider identity. In an owned rig, create a soul blocked by this permission failure, fix only its fixture config dependency, retry, and assert same soul/native root/store plus exactly one replacement. Do not use a current-account temp-directory pass as the real-identity proof.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-platform provider_environment`

Run: `cargo test -p freshell-session-host provider_config`

Expected: FAIL on staging/rollback/ownership behavior. If a captured source fix already passes, retain its pre-fix failing receipt and verify the test against the rejected `c4c55c1a2` implementation in an isolated scratch checkout; do not revert the source or destination to manufacture red.

- [ ] **Step 3: Add the minimal production implementation**

Integrate only the bounded provider-environment fix from `c4c55c1a2` plus repair `5033898b4`, including writable-HOME staging and replacement recovery, after independently validating captured committed bytes; never trust rejected `c4c55c1a2` alone. The repair's exact three paths are provider_environment.rs, session-host main.rs and the Python probe. Reconcile against Task 1 launch/import gates rather than replacing main.rs wholesale. Source-to-stage copying reads canonical bounded files; stage files and parent directories are creator-owned inside the writable provider volume. Run private destination operations as the owning provider UID/GID, using the repository's subprocess privilege drop. Write/sync replacement files before rename, retain prior inode references until all publication steps succeed, and restore each replaced inode on failure. Cleanup removes only paths in this attempt's creator-owned ledger. Preserve executable resources without following escaped paths. Refresh the selected TUI/plugin config and adoption expectation under the same identity on exact resume; return a typed recoverable permission/preparation blocker with structured context. Do not broaden privileges or mutate host config.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-platform provider_environment`

Run: `cargo test -p freshell-session-host provider_config`

Run: `python3 scripts/testing/probe-provider-config-readonly-home.py`

Expected: PASS, and the real rootless probe reports UID/GID, zero capabilities, read-only root, writable volume, successful refresh and rollback preservation. The probe owns and cleans only its labeled fixture containers/volumes.

- [ ] **Step 5: Refactor while green**

Keep one bounded copier/publication implementation for initial and resumed launch. Share the replacement ledger and typed failure conversion; avoid a second bootstrap-only path with different ownership semantics.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-platform -p freshell-agent-runtime -p freshell-session-host -p freshell-supervisor`

Expected: PASS, including initial setup, concurrent selected-config generation, plugin expectation write and blocked exact-resume retry. The actual browser scenario runs through Task 8's supported cloud topology before final completion.

- [ ] **Step 7: Commit the task**

Run: `git add crates/freshell-platform/src/provider_environment.rs crates/freshell-platform/src/lib.rs crates/freshell-session-host/src/main.rs crates/freshell-supervisor/src/recovery.rs scripts/testing/probe-provider-config-readonly-home.py test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts`

Run: `git commit -m "fix(runtime): refresh provider config with owned filesystem identity"`

### Task 3: Prevent unsupported absence and loss certification

**Files:**
- Modify: `crates/freshell-supervisor/src/recovery.rs:1928`, `resume_catalog.rs`, `backend/native_history.rs`, `loss_report.rs`, `loss_report_tests.rs`, `crates/freshell-session-host/src/main.rs`.
- Test: existing recovery/loss/native-history test modules.

**Interfaces:**
- Consumes: `RecoveryContext`, `RecoveryProbe`, `EvidenceStoreState`, existing qualified exact-source census and verified `ResumeSpec`.
- Produces: `RecoveryProbe::Blocked` for dispatched coding souls without independent identity/storage proof; `DefinitivelyUnavailable` only for complete qualified exact absence. No new negative-evidence shortcut or session-selection heuristic.

- [ ] **Step 1: Write the failing behavioral test**

Add `dispatched_missing_identity_cannot_certify_loss` beside the current offline probe tests: use the existing dispatched coding context fixture, clear `native_session_id` and `resume_spec`, retain provider volume evidence, and run both online and offline production probes and the two-probe/final loss path. Assert Blocked/unknown, no loss certificate/outbox/tombstone, no provider-volume deletion, no replacement, and preserved outputs. Parameterize Claude, Codex, OpenCode, Amplifier and requested fresh modes freshclaude, Kilroy, freshcodex and freshopencode. Add unreadable, missing mount, incomplete/depth/byte-bound census, ambiguous root, conflicting identity and reader failure cases. Keep a fully inspected exact-row absent case that does certify genuine absence, a proved pristine-seed case, and existing shell terminal-end tests.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-supervisor dispatched_missing_identity_cannot_certify_loss`

Expected: FAIL because `offline_probe` currently labels native resume definitively unavailable and store Missing without provider inspection.

- [ ] **Step 3: Add the minimal production implementation**

Patch `offline_probe` in this order: preserve verified saved spec; preserve identity-without-spec blocker; preserve `never_dispatched` proof; for a dispatched coding provider with no verified exact native identity/spec, return the existing NativeResume StoreUnreadable blocker with reason `provider identity or exact storage census has not been verified`, rather than falling through checkpoint absence. Do not make the guard apply to a qualified shell policy. Online native readers and host probing apply the same invariant. A reader result is Absent only after complete canonical store inspection for the exact requested root under real provider identity/environment, with all candidates inspected and no truncation/errors/ambiguity; otherwise retain Unresolved/Blocked. `exact_resume_candidate` returning None for missing identity is unknown, never a missing-store certificate. Checkpoint absence cannot upgrade unknown native state. Final loss CAS revalidates qualified census/identity/intent generations and rejects any earlier unsupported negative. Retain imported-baseline receipts independent of transient recovery state.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-supervisor dispatched_missing_identity_cannot_certify_loss`

Run: `cargo test -p freshell-supervisor loss_report`

Expected: PASS for conservative unknown state and legitimate fully inspected loss, with no destructive effect in blocked cases.

- [ ] **Step 5: Refactor while green**

Centralize native evidence classification in the existing native-history/loss boundary; remove duplicate missing-ID absence conversion. Keep evidence bodies outside the registry; persist body-free qualified receipt references/generations only.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-agent-runtime -p freshell-session-host -p freshell-supervisor`

Expected: PASS for source census, true loss, pristine seed, materialization fencing, baseline retry persistence and retained output. No loss test is skipped or weakened.

- [ ] **Step 7: Commit the task**

Run: `git add crates/freshell-supervisor/src/recovery.rs crates/freshell-supervisor/src/resume_catalog.rs crates/freshell-supervisor/src/backend/native_history.rs crates/freshell-supervisor/src/loss_report.rs crates/freshell-supervisor/src/loss_report_tests.rs crates/freshell-session-host/src/main.rs`

Run: `git commit -m "fix(supervisor): require inspected evidence before native loss"`

### Task 4: Require provider-observed identity for every replacement

**Files:**
- Create: `crates/freshell-session-host/src/providers/native_identity.rs`.
- Modify: `crates/freshell-session-host/src/providers/mod.rs`, `crates/freshell-session-host/src/providers/fresh_agent.rs`, `crates/freshell-session-host/src/pty.rs:133`, `crates/freshell-session-host/src/main.rs`, `crates/freshell-platform/src/cli_launch.rs`, `crates/freshell-runtime-protocol/src/lib.rs`, `crates/freshell-supervisor/src/recovery.rs:1786`, `crates/freshell-supervisor/src/service.rs`, `crates/freshell-supervisor/src/registry.rs`, `extensions/opencode/freshell-rebind-plugin.ts`.
- Test: inline host/recovery/registry tests, `test/unit/extensions/opencode-rebind-plugin.test.ts`.

**Interfaces:**
- Consumes: requested native root from verified ResumeSpec, authenticated current host, current incarnation and generation, per-launch random nonce, provider-native events/store reads.
- Produces: additive `NativeIdentityObservation { native_session_id: String, incarnation_id: IncarnationId, launch_nonce: String, evidence_revision: u64, source: NativeIdentitySource, evidence_digest: String }`, with serde tagged `NativeIdentitySource` values `codex_app_server`, `opencode_tui`, `claude_native_event`, `amplifier_native_event`, `fresh_provider_handshake`. `native_session_id` remains null/unobserved until this evidence passes validation. Persist requested identity separately; preserve legacy response compatibility without certifying legacy echoes.

- [ ] **Step 1: Write the failing behavioral test**

Add `requested_identity_is_not_provider_observation` in the production host launch/status tests. Launch a resumable test provider with the correct requested root but no native acknowledgement and a pre-existing matching transcript. Assert host status has no observed identity and supervisor replacement never becomes LIVE. Then emit wrong-root, previous-incarnation/nonce, stale evidence revision, and correct current native acknowledgement; only the final one publishes LIVE. Exercise replacement through real host status, not a direct `verify_native_identity` call alone. Add provider exit, bounded timeout, Stop cancellation and post-repair baseline-only retries; wrong or missing observation cleans only the owned failed replacement, preserves original history/root and has one writer at most. Codex retains its app-server handshake/event and durable receipt tests; OpenCode resumes must run the existing TUI observation gate even when a resume ID was requested.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-session-host requested_identity_is_not_provider_observation`

Run: `cargo test -p freshell-supervisor provider_observed_replacement`

Expected: FAIL because non-Codex PTY initializes observed ID from request and because the supervisor accepts an authenticated echo.

- [ ] **Step 3: Add the minimal production implementation**

Replace PTY's initial identity assignment with `Arc::new(Mutex::new(None))` for every provider. Store requested identity only in the launch spec. OpenCode watcher/gate executes for both new and resumed sessions and accepts only a current TUI plugin native session/nonce/root/generation observation; a pre-existing SQL row is not adoption. Codex retains current native app-server identity receipts and adds the current observation binding. Claude reuses `claude_settings_json`'s actual SessionStart hook: inject a launch-specific signal directory into this managed child's hook settings/environment, retain the provider payload `session_id`/`source`, and validate `source=resume` and that exact current launch directory. Never consume arbitrary prior terminal signal files. Amplifier reuses its native `events.jsonl` lifecycle envelope (`event`, `session_id`, schema): capture exact file identity and EOF offset before spawn, tail only appended complete schema-valid `session:resume` or root `session:start` records for this exact owned provider root, reject subagent parent IDs, truncation/reset and stale prefixes, and bind that current provider event to the launch nonce/incarnation. The launcher-created Amplifier stub is not an observation. Use the existing bounded tailer/envelope format; where necessary add the existing freshell-activity dependency in session-host Cargo.toml rather than duplicating parsing. Their qualified native stores corroborate each event's exact root; do not infer acknowledgement from argv, newest file, sole row, arbitrary transcript timestamp, or host authentication. Fresh transports publish the provider-returned session/thread identity on actual handshake/load through `HostedTransport`'s `native_rx`/created receiver, requiring fresh provider acknowledgement and native completed-turn evidence using the actual sidecar/host actor, never a supplied session key. The new observation module validates current incarnation/nonce/root/revision and hashes body-free evidence before publishing. Host main returns that typed observation. `wait_for_native_identity` waits boundedly for valid current observation, checks provider exit and cancellation, revalidates intent/ownership before commit, and blocks LIVE on absence/mismatch. Observation persistence survives web reconnect but cannot be replayed across a replacement incarnation. Provider-specific unsupported observation is a failure to qualify, not permission to enable a mode.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-session-host requested_identity_is_not_provider_observation`

Run: `cargo test -p freshell-supervisor provider_observed_replacement`

Run: `pnpm run test:vitest run test/unit/extensions/opencode-rebind-plugin.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS for all fault cases and native observation acceptance. Task 9 supplies actual upstream-provider recovery evidence for each bridge.

- [ ] **Step 5: Refactor while green**

Use one observation binder/validator for terminal and fresh modes while leaving each native source adapter separate. Reuse Codex/OpenCode implementations; do not create a generic filesystem identity picker.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-runtime-protocol -p freshell-agent-runtime -p freshell-session-host -p freshell-supervisor -p freshell-server --features freshell-server/managed-runtime-v1`

Run: `pnpm run test:vitest run test/unit/extensions/opencode-rebind-plugin.test.ts test/unit/lib/managed-runtime-recovery.test.ts test/unit/port/managed-runtime-contract-freeze.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS. Replace any existing source-copy/hash assertion that blocks additive contract changes with a behavior-running round-trip/client test; never update prose/config hashes as coverage. The wire/launch identity interface spans the runtime; final full gate is mandatory.

- [ ] **Step 7: Commit the task**

Run: `git add crates/freshell-session-host/src/providers/native_identity.rs crates/freshell-session-host/src/providers/mod.rs crates/freshell-session-host/src/providers/fresh_agent.rs crates/freshell-session-host/src/pty.rs crates/freshell-session-host/src/main.rs crates/freshell-platform/src/cli_launch.rs crates/freshell-runtime-protocol/src/lib.rs crates/freshell-supervisor/src/recovery.rs crates/freshell-supervisor/src/service.rs crates/freshell-supervisor/src/registry.rs extensions/opencode/freshell-rebind-plugin.ts test/unit/extensions/opencode-rebind-plugin.test.ts`

Run: `git commit -m "fix(runtime): bind resumed identity to native provider observation"`

### Task 5: Persist bounded supervisor recovery retries

**Files:**
- Create: `crates/freshell-supervisor/src/recovery_retry.rs`.
- Modify: `crates/freshell-supervisor/src/lib.rs`, `registry.rs:1413`, `inventory.rs:198`, `recovery.rs`, `service.rs`.
- Test: new retry module and existing registry/recovery/inventory tests.

**Interfaces:**
- Consumes: typed recovery blocker/error, existing per-soul lifecycle lock, intent revision/control epoch, recovery attempt ID and ownership handle.
- Produces: internal `RecoveryRetry { soul_id: SoulId, intent_revision: u64, attempt_count: u8, next_due_at_ms: Option<i64>, reserved_attempt_id: Option<RecoveryAttemptId>, last_reason: String }`; registry APIs `reserve_due_recovery_retry(soul_id: SoulId, intent_revision: u64, now_ms: i64) -> Result<Option<RecoveryRetry>, RegistryError>` and `settle_recovery_retry(soul_id: SoulId, intent_revision: u64, attempt_id: RecoveryAttemptId, retryable: bool, recovered: bool, now_ms: i64) -> Result<(), RegistryError>`; initial + 2s + 10s automatic attempts, separate from five successful recoveries/hour flap budget.

- [ ] **Step 1: Write the failing behavioral test**

Add `automatic_retry_survives_restart_without_budget_reset`: use the existing registry/supervisor fixture and injected clock, cause typed transient provider/backend unavailability, complete the initial attempt, reopen the registry/supervisor at 1s, verify no attempt, at 2s verify one retry, reopen at 3s, and verify the remaining retry is due 10s after second settlement. Three failures exhaust without resetting on another restart. A dependency becoming available on attempt two recovers the same root once. Cover crash before reservation, after reservation/before dispatch, after replacement created/before settlement, and after settlement; adopt/inspect any reserved attempt through existing recovery ownership before retrying. Add Stop/new intent/manual retry/lost cancellation, stale revision, concurrent observer/startup reservation, and nonretryable wrong-identity/unqualified-source blockers. No wall-clock sleep is necessary for policy tests; actual crash cases run in sandbox.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-supervisor automatic_retry_survives_restart_without_budget_reset`

Expected: FAIL because blocked souls are excluded from continuing observation and failed-attempt due state is not persisted.

- [ ] **Step 3: Add the minimal production implementation**

Add a compatible registry schema migration with a retry row keyed by soul and intent revision, durable attempted/reserved state, next deadline, typed last reason and active recovery-attempt reference. Use the migration framework's next schema version after Task 1, not a hardcoded stale version. Initial attempt reservation consumes attempt 1; failed retryable settlement schedules attempt 2 at now+2000ms and attempt 3 at now+10000ms; failed attempt 3 has no next deadline and exposes RetryExhausted. Reservation and existing recovery-attempt creation commit together before external work. SQL updates check current desired Running, exact intent revision, not Lost, no conflicting active attempt, and due deadline. Observer/startup enumerate due retries as well as LIVE health observation, acquire the existing lifecycle lock and bounded concurrency permit, recheck reservation, then invoke the ordinary recovery path. Startup inspects/adopts a reserved in-flight recovery using owned handles and existing recovery journal; never blindly replays provider creation. Clock rollback cannot mint attempts; persisted deadlines remain deadlines. Only explicitly typed transient host/backend/config dependency/preparation failures are retryable; identity mismatch, ownership mismatch, incomplete evidence and required user owner choice are blocked until deliberate correction/manual retry. Manual retry rearms once under a fresh current intent action. Successful recovery, Stop, Lost, and revised intent clear/cancel pending schedules transactionally. Log scheduled/reserved/settled/exhausted/cancelled with severity and exact IDs. Keep success flap budget separate.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-supervisor automatic_retry_survives_restart_without_budget_reset`

Run: `cargo test -p freshell-supervisor retry_budget`

Expected: PASS for bounded restart-safe failed attempts and unchanged successful-recovery flap policy.

- [ ] **Step 5: Refactor while green**

Share registry eligibility/reservation between startup and observer; keep retries out of the web controller. Factor a pure due/settlement policy in `recovery_retry.rs`, retaining SQL transactional authority and existing lock ownership.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-supervisor`

Run: `scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-supervisor automatic_retry_crash -- --ignored"`

Expected: PASS with nonzero crash selectors; schema reopen, existing flap-budget/manual retry, source/identity mismatch, Stop fences and startup readiness continue to pass.

- [ ] **Step 7: Commit the task**

Run: `git add crates/freshell-supervisor/src/recovery_retry.rs crates/freshell-supervisor/src/lib.rs crates/freshell-supervisor/src/registry.rs crates/freshell-supervisor/src/inventory.rs crates/freshell-supervisor/src/recovery.rs crates/freshell-supervisor/src/service.rs`

Run: `git commit -m "fix(supervisor): persist bounded automatic recovery retries"`

### Task 6: Resume interrupted ordinary Stop transactions

**Files:**
- Modify: `crates/freshell-supervisor/src/service.rs:1787`, `registry.rs:706`, `inventory.rs:51`, `recovery.rs`.
- Test: inline registry/service/inventory tests and `test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts`.

**Interfaces:**
- Consumes: durable stopped intent, exact original `OwnedRuntimeHandle`, current incarnation/revision and recorded Stop outcome.
- Produces: `Registry::pending_stop_handles() -> Result<Vec<OwnedRuntimeHandle>, RegistryError>` and internal `Supervisor::finish_stop_handle(&OwnedRuntimeHandle) -> Result<StopOutcome, RuntimeError>`. This method does not commit a new intent; ordinary Stop and restart continuation share it.

- [ ] **Step 1: Write the failing behavioral test**

Add `ordinary_stop_crash` sandbox tests at durable intent commit before IPC, after graceful request, after force-stop/verified empty before outcome persistence, and after outcome commit before capability revocation. Restart supervisor; assert original intent revision/native root/store/history remain, no creation/grant/recovery occurs, only the exact owned handle is signaled, and state converges idempotently to VerifiedEmpty. Repeat with unavailable backend, surviving workload and ownership-label mismatch: state remains accurately BackendUnavailable/TerminationUnconfirmed/BlockedOwnership, never falsely stopped or resurrected. Add stale handle/new intent concurrency and an empty already-removed enclosure case. Add a browser test that clicks Stop, crashes the isolated supervisor at the intent boundary, reconnects and sees stopped with retained transcript.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-supervisor ordinary_stop_crash -- --ignored"`

Expected: FAIL because desired Stopped souls are not resumed by startup/observer ordinary Stop reconciliation. The parent suite validates a nonzero selected case count.

- [ ] **Step 3: Add the minimal production implementation**

Extract existing `stop`'s authenticated IPC/graceful/backend verification/force/verification/outcome sequence into `finish_stop_handle`; retain two-second graceful request and three-second bounded empty checks, exact ownership mismatch semantics and capability revocation. `stop` commits intent once, cancels retries in that transaction, then calls the helper under the lifecycle lock. Registry selects current desired Stopped handles whose durable Stop transaction is incomplete or whose verified cleanup/revocation remains pending. Startup and observer settle these before/alongside running recovery with existing concurrency limits; they do not call `begin_stop_expected` again or increment intent. Before each signal/outcome mutation, recheck current revision/handle ownership; stale/new intent returns without effect. If exact container is absent, backend's qualified empty result may finish Stop; arbitrary inspection failure may not. Persist outcome and pending capability revoke status so restart after empty/outcome can idempotently revoke without reopening provider. Preserve separate loss cleanup machinery and never convert an ordinary Stop to Lost. Emit continuation/result events.

- [ ] **Step 4: Run the focused test**

Run: `scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-supervisor ordinary_stop_crash -- --ignored"`

Expected: PASS at every selected boundary, including honest unresolved backend/ownership cases.

- [ ] **Step 5: Refactor while green**

Remove duplicate stop termination branches now shared by ordinary invocation/startup; reuse applicable exact-handle termination helpers in recovery only when semantics match. Keep lifecycle lock acquisition outside the helper to avoid recursive locking.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-supervisor`

Run: `scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-supervisor stop -- --ignored"`

Expected: PASS for Stop-vs-recovery CAS, tombstones, writer claim release, exact ownership and pending capability revocation. Browser proof executes in Task 8.

- [ ] **Step 7: Commit the task**

Run: `git add crates/freshell-supervisor/src/service.rs crates/freshell-supervisor/src/registry.rs crates/freshell-supervisor/src/inventory.rs crates/freshell-supervisor/src/recovery.rs test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts`

Run: `git commit -m "fix(supervisor): finish durable Stop after interruption"`

### Task 7: Prove stopped repair, baseline continuity and exact withdrawal

**Files:**
- Modify: `crates/freshell-supervisor/src/stopped_repair_cas.rs`, `registry.rs`, `resume_catalog.rs`, `notice_outbox.rs`, `loss_report_tests.rs`, `crates/freshell-server/src/managed_runtime_api.rs`.
- Modify: `test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts`, `runtime-lost-soul-notice-rust.spec.ts`, `test/e2e-browser/fixtures/managed-opencode-source.ts`, `test/e2e-browser/helpers/managed-runtime.ts`.
- Modify only if a test reveals missing contextual state: `src/lib/recovery/managed-runtime-recovery.ts`, `src/lib/managed-runtime-retry.ts`, `src/components/ManagedRuntimeRecoveryCard.tsx`, `test/unit/lib/managed-runtime-recovery.test.ts`, `test/unit/lib/managed-runtime-retry.test.ts`, `test/unit/client/components/ManagedRuntimeRecoveryCard.test.tsx`.

**Interfaces:**
- Consumes: nine exact target revisions, seven canonical roots/owners, exact generation-bound structural/readability receipts, immutable saved adoption baseline, stopped batch route and current provider-observed launch evidence.
- Produces: seven `DataRepairComplete` stopped/resume-ready canonical souls, preserved explicit views, exact nine-incident retraction, and same-soul Resume/failure/retry without losing baseline. Data repair makes no provider-running claim.

- [ ] **Step 1: Write the failing behavioral test**

Add `stopped_repair_resume_failure_retry_preserves_baseline`: run the actual synthetic nine-target/seven-root batch through the authenticated server route and real host import/read path, verify no PTY/process launches, leave canonical souls stopped, then explicitly Resume one synthetic soul through UI. Fault the first current launch observation, interrupt/restart supervisor, then Retry; assert same canonical soul/native root/store and complete original imported graph/baseline remain, matching current generation/nonce observation precedes input and LIVE. Run baseline-only host fault matrix for unreadable reader/assets, receipt/root/generation mismatch, stale observation, interrupted pre-PTY gate, Stop cancellation and recovered current tail. Add pending withdrawal blocking one incident while unrelated exports drain, exact `%`/`_` view prefix behavior, colliding sanitized notice receipts, malformed unclassifiable JSONL and concurrent stale exporter/rotator boundaries. Each test asserts actual filesystem/registry outcome, not just a manifest row count.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-supervisor stopped_repair_resume_failure_retry_preserves_baseline`

Run: `cargo test -p freshell-session-host baseline_only`

Expected: FAIL for any unimplemented integrated persistence/host transition; source tests previously doing direct registry begin/block do not fulfill this production path. If all current production cases already pass, record existing imported pre-fix failures and current positive execution without manufacturing a new defect.

- [ ] **Step 3: Add the minimal production implementation**

Ensure `registry` loads completed/owned import baseline by immutable receipt authority independent of transient DataRepairComplete/Blocked/Recovering state, and `resume_catalog` upgrades legacy spec environment and baseline atomically. Batch preflights **all seven roots/owners/targets** before any import, validates provider access under actual identity, commits exact captured revision CAS only after all seven independent readability receipts, and never starts providers. Root owner resolution returns typed choices only for real ambiguity. Preserve the cleanup/export coordinator through exact ID generation checks, file rewrite/sync and progress acknowledgement; deferred withdrawal records an error but does not suppress unrelated export drain or make startup entirely unavailable. Exact view projection cleanup parses the numeric revision following the full string prefix, never SQL LIKE matching unrelated IDs. Retraction progress is durable ID/generation/status/artifact metadata only. UI presents Resume for stopped repaired data; failed provider adoption presents same-soul Retry with retained baseline and honest blocker. Update README/mock only if this changes the source UI materially.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-supervisor stopped_repair_resume_failure_retry_preserves_baseline`

Run: `cargo test -p freshell-session-host baseline_only`

Run: `cargo test -p freshell-supervisor pending_stopped_repair_withdrawal_does_not_suppress_unrelated_exports`

Expected: PASS with exact seven-root import, nine target correction, complete baseline and unrelated records preserved.

- [ ] **Step 5: Refactor while green**

Keep structural verification, installed readability, repair CAS and later provider adoption as separate typed stages. Share exact target/notice/view selection helpers; remove copied historical eight-target logic and direct-state test shortcuts.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-supervisor -p freshell-session-host -p freshell-server --features freshell-server/managed-runtime-v1`

Run: `pnpm run test:vitest run test/unit/lib/managed-runtime-recovery.test.ts test/unit/extensions/opencode-rebind-plugin.test.ts --config config/vitest/vitest.config.ts`

Run: `scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-supervisor stopped_repair -- --ignored"`

Expected: PASS for auth/idempotency/count, exact retraction crash points, true-loss preservation and all relevant baseline-only host faults. Task 8 executes the browser cases through cloud and records actual nonzero counts.

- [ ] **Step 7: Commit the task**

Run: `git add crates/freshell-supervisor/src/stopped_repair_cas.rs crates/freshell-supervisor/src/registry.rs crates/freshell-supervisor/src/resume_catalog.rs crates/freshell-supervisor/src/notice_outbox.rs crates/freshell-supervisor/src/loss_report_tests.rs crates/freshell-server/src/managed_runtime_api.rs test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts test/e2e-browser/specs/runtime-lost-soul-notice-rust.spec.ts test/e2e-browser/fixtures/managed-opencode-source.ts test/e2e-browser/helpers/managed-runtime.ts`

If changed, also stage the three contextual UI files and required README/mock updates; inspect staged diff. Run: `git commit -m "fix(runtime): preserve repaired history through failed resume"`.

### Task 8: Run Cloud browsers against an actual isolated managed rig

**Files:**
- Create: `scripts/testing/runtime-external-browser.ts`, `test/e2e-browser/helpers/external-managed-runtime.ts`, `test/unit/tooling/testing/runtime-external-browser.test.ts`.
- Modify: `scripts/testing/runtime-sandbox.ts`, `scripts/testing/runtime-test-broker.ts`, `scripts/testing/runtime-provider-qualification.ts`, `scripts/testing/runtime-fresh-agent-qualification.ts`, `scripts/testing/runtime-landing-campaign.ts`, `scripts/e2e-cloud.sh`, `test/e2e-browser/helpers/managed-runtime.ts`, `test/e2e-browser/playwright.config.ts`, `test/e2e-browser/playwright.cloud.config.ts`.
- Modify: `test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts`, `test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts`, `test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts`, `test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts`, `test/e2e-browser/specs/runtime-lost-soul-notice-rust.spec.ts`, `test/e2e-browser/specs/runtime-opencode-provider-qualification-rust.spec.ts`, `test/e2e-browser/specs/runtime-tabs-rehydrate-rust.spec.ts`, `test/e2e-browser/specs/runtime-chaos-rust.spec.ts` to consume the shared colocated/external rig interface.
- Test: `test/unit/tooling/testing/runtime-test-broker.test.ts`, new external runner tests, existing provider/fresh selection tests; affected managed Playwright specs.

**Interfaces:**
- Consumes: `RuntimeHarness`, `ManagedRuntimeBrowserRig`, configured cloud backend, clean candidate/image, existing environment work's bounded external-target seam if independently reviewed.
- Produces: `chromium-external-target` project with `FRESHELL_E2E_TARGET_URL`, `FRESHELL_E2E_TARGET_WS_URL`, `FRESHELL_E2E_TARGET_TOKEN`, `FRESHELL_RUNTIME_EXTERNAL_RUN_ID` and `FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA`; existing qualification/synthetic flags are propagated as allowlisted metadata. New runner CLI: `pnpm exec tsx scripts/testing/runtime-external-browser.ts --spec <allowlisted-spec-path> [--grep <test-name>] [--provider claude|codex|opencode|amplifier | --mode freshclaude|kilroy|freshcodex|freshopencode]`, owning rig, tunnel, Cloud dispatch and cleanup.

- [ ] **Step 1: Write the failing behavioral test**

Execute producers with an injected child-process adapter and backend `cloud`; assert child is `pnpm`, arguments include `run test:e2e --project=chromium-external-target`, exact spec and selection, and do not contain npm forwarding separator or local override. Exercise `runtime-landing-campaign`'s `playwright()` producer dispatch as well: it currently bypasses the configured backend using direct mise/Playwright; every managed producer must call the shared external runner and retain campaign provenance. The runner test uses fake child lifecycle for dispatch only: invalid run/candidate/fixture/handle is refused, HTTPS+WSS are both published, nonzero actual executed test count is required, skipped/zero/failing result rejects receipt, dispatch failure still cleans exact owned tunnel/rig, and unrelated resources remain. Add a real Cloud smoke test loading the managed app, websocket ready/build identity and registry inventory from the isolated rig, then perform production source-to-soul import/adoption, stopped repair Resume/failure/Retry, config blocked retry and interrupted Stop browser cases. A passing fake echo target does not count.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/tooling/testing/runtime-external-browser.test.ts test/unit/tooling/testing/runtime-test-broker.test.ts test/unit/tooling/testing/provider-qualification-selection.test.ts test/unit/tooling/testing/fresh-agent-qualification.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL because producers spawn npm/local and actual managed specs are cloud-skipped.

- [ ] **Step 3: Add the minimal production implementation**

Integrate the validated external-target project narrowly if available; finish actual managed target support here regardless of the other campaign's progress. Create a run-owned rig on the rootless daemon host, build/verify candidate/image, start its web/controller/supervisor and mount only synthetic stores/exact provider grants. Publish its HTTP/WS over an owned temporary HTTPS/WSS relay with a run token. External helper implements the same finite managed fixture/control methods used by affected specs through a run-scoped broker: inventory, exact fixture creation, exact crash/restart, stopped repair request, native body-free reads, writer/cleanup observations. Validate candidate, fixture IDs and exact owned handles at every action; no generic exec/control endpoint. Broker stays separate from production API. External cloud config includes the eight migrated spec paths in this task's Files list under the closed external project; colocated local-only definitions remain local-only. Cloud dispatch forwards only closed target/selection metadata and never a local Docker socket/path. Both qualification producers and campaign `playwright()` producers call the new runner so selections/cleanup/provenance remain owned and `FRESHELL_E2E_BACKEND` is honored. Preserve receipt producers that do not use browser transport. Usage says pnpm. Runner parses machine-readable Playwright results and rejects zero selected/executed or skipped required cases before evidence publication. On failure, preserve diagnostic body-free artifacts and clean owned resources.

- [ ] **Step 4: Run the focused test**

Run: `pnpm run test:vitest run test/unit/tooling/testing/runtime-external-browser.test.ts test/unit/tooling/testing/runtime-test-broker.test.ts test/unit/tooling/testing/provider-qualification-selection.test.ts test/unit/tooling/testing/fresh-agent-qualification.test.ts --config config/vitest/vitest.config.ts`

Run: `FRESHELL_RUNTIME_SYNTHETIC_RESUME=1 FRESHELL_TEST_SUMMARY='actual managed OpenCode cloud repair and resume' GCLOUD_ROBOT_REQUIRE=1 pnpm exec tsx scripts/testing/runtime-external-browser.ts --spec test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts`

Expected: PASS with nonzero executed managed cases, actual imported-store/adoption/browser/stop evidence, matching candidate/image and complete owned cleanup.

- [ ] **Step 5: Refactor while green**

Reuse one external project/runner for synthetic managed browser and real qualification; remove forced-local producer branches. Keep fake-dispatch tests separate from actual managed coverage receipts.

- [ ] **Step 6: Run impacted-test verification**

Run: `pnpm run test:vitest run test/unit/tooling/testing/ --config config/vitest/vitest.config.ts`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm exec tsx scripts/testing/runtime-external-browser.ts --spec test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm exec tsx scripts/testing/runtime-external-browser.ts --spec test/e2e-browser/specs/runtime-lost-soul-notice-rust.spec.ts`

Expected: PASS for nonzero actual lifecycle/Stop/loss cases; explicitly record any provider opt-ins and selections. Shared browser configuration changes also require final coordinated full suite. Do not claim default `pnpm run test` includes external managed cases unless its receipt actually does.

- [ ] **Step 7: Commit the task**

Run: `git add scripts/testing/runtime-external-browser.ts test/e2e-browser/helpers/external-managed-runtime.ts test/unit/tooling/testing/runtime-external-browser.test.ts scripts/testing/runtime-sandbox.ts scripts/testing/runtime-test-broker.ts scripts/testing/runtime-provider-qualification.ts scripts/testing/runtime-fresh-agent-qualification.ts scripts/testing/runtime-landing-campaign.ts scripts/e2e-cloud.sh test/e2e-browser/helpers/managed-runtime.ts test/e2e-browser/playwright.config.ts test/e2e-browser/playwright.cloud.config.ts test/unit/tooling/testing/runtime-test-broker.test.ts test/unit/tooling/testing/provider-qualification-selection.test.ts test/unit/tooling/testing/fresh-agent-qualification.test.ts test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts test/e2e-browser/specs/runtime-lost-soul-notice-rust.spec.ts test/e2e-browser/specs/runtime-opencode-provider-qualification-rust.spec.ts test/e2e-browser/specs/runtime-tabs-rehydrate-rust.spec.ts test/e2e-browser/specs/runtime-chaos-rust.spec.ts`

Run: `git commit -m "test(runtime): exercise managed rig from configured Cloud browsers"`

### Task 9: Derive qualification from real post-crash turns and native evidence

**Files:**
- Create: `scripts/testing/qualification-observations.ts`, `test/unit/tooling/testing/qualification-observations.test.ts`.
- Modify: `scripts/testing/provider-qualification-receipt.ts`, `fresh-agent-qualification-receipt.ts`, `runtime-provider-qualification.ts`, `runtime-fresh-agent-qualification.ts`, `test/unit/tooling/testing/fresh-agent-qualification.test.ts`.
- Modify: `test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts`, `runtime-fresh-agent-qualification-rust.spec.ts`, `test/e2e-browser/helpers/managed-runtime.ts`, `external-managed-runtime.ts`.

**Interfaces:**
- Consumes: actual native events/stopped-store reads and lifecycle/broker/build/cleanup evidence from the run-owned rig, explicit provider/mode selection, exact launch observations from Task 4.
- Produces: `ObservedQualification { candidateSha: string, runtimeImageDigest: string, runId: string, selected: string[], executed: number, passed: number, skipped: number, stages: NativeRecoveryStageEvidence[] }`, where `NativeRecoveryStageEvidence` names `initial`, `after_session_host_crash`, `after_provider_process_crash`, actual root/store/incarnation, native completed-turn IDs/digests, nonce recall result, actual version/model/effort and lifecycle ordering references. Existing receipt schemas are additively strengthened or versioned with compatibility refusals; validators load/hash independently referenced artifacts and derive flags rather than trust row literals.

- [ ] **Step 1: Write the failing behavioral test**

Create observation tests that execute the receipt builder/validator using real-shaped native event fixtures. A receipt with initial two turns but no post-host/post-provider follow-up must fail; deleting a native completion, changing nonce recall, using a wrong root, duplicating prompt dispatch/completion, swapping candidate/image/artifact, removing exact empty-before-new-writer order, claiming unexecuted ingress, or copying terminal Claude version into a different sidecar must fail. Positive fixture contains distinct native completed no-tool turns at all three stages and independently matching lifecycle/native proof. Test the command producer's actual process invocation. Extend fresh real browser qualification to send a random nonce initially and a recall prompt **after each** web/host/provider recovery, assert returned nonce and no tool calls in native completion evidence, and read the stopped exact store for complete three-stage turns. Assertions must fail if the provider starts a new root or if recall is fabricated solely by test code.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/tooling/testing/qualification-observations.test.ts test/unit/tooling/testing/fresh-agent-qualification.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL because current fresh receipts trust literal claims and lack post-crash native recall evidence.

- [ ] **Step 3: Add the minimal production implementation**

Read actual completed turns/native store independently of browser presentation. For each terminal provider and each fresh mode, record a newly generated random nonce at initial native completion, crash the exact owned host/process, observe replacement exact identity, send a real no-tool recall turn, and assert the native assistant completion recalls that nonce under the same root. Repeat for provider crash; add web-reconnect continuity and second view/blocker interactions required by existing readiness scope. Use prompt dispatch IDs to count actual dispatch/completion once, writer leases plus actual process/enclosure inspection to prove one writer, and two independently allocated stores/enclosures to prove isolation. For providers supporting approvals, create a real supported approval, preserve across web/host recovery, resolve once and count provider-native decision/completion; unsupported is explicit provider capability evidence, never a fake `supported:false` escape. Exercise every claimed fresh ingress route and record only executed ones. Assert lifecycle verified-empty/claim release occurs before new writer grant. Build booleans from referenced observations; a supplied `true` flag with absent proof is invalid. Record actual terminal executable versions and actual sidecar SDK/runtime binary, including fresh Claude SDK 2.1.237 versus terminal 2.1.263 unless a supported explicit override changes the actual child. Record provider-effective model/effort, not picker/argv values. Existing low-cost terminal profiles are Claude Haiku-low, Codex GPT-5.6-Luna-low, OpenCode OpenAI GPT-5.6-Luna and Amplifier configured lunaroute glm-5.3; verify against pinned manifest and grants before execution. FreshOpenCode must use the approved manifest profile instead of unrecorded big-pickle. Receipt production requires positive executed selection, independently hashed artifacts, exact candidate/image and cleanup success.

- [ ] **Step 4: Run the focused test**

Run: `pnpm run test:vitest run test/unit/tooling/testing/qualification-observations.test.ts test/unit/tooling/testing/fresh-agent-qualification.test.ts --config config/vitest/vitest.config.ts`

Then execute each command separately, saving the run's actual receipt path and verdict:

```bash
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:runtime:provider-qualification --provider claude
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:runtime:provider-qualification --provider codex
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:runtime:provider-qualification --provider opencode
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:runtime:provider-qualification --provider amplifier
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:runtime:fresh-agent-qualification --mode freshclaude
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:runtime:fresh-agent-qualification --mode kilroy
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:runtime:fresh-agent-qualification --mode freshcodex
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:runtime:fresh-agent-qualification --mode freshopencode
```

Expected: all eight explicit live selections PASS through configured cloud external target, with real upstream calls, same-root post-crash recall and current native evidence. Failure is repaired and rerun, not reclassified as certified or silently deferred. Calls operate only on synthetic test conversations; existing seven real roots remain untouched.

- [ ] **Step 5: Refactor while green**

Share evidence derivation and integrity validation, leaving native reader/approval adapters provider-specific. Remove literal affirmative flags and inventory-copied ingress claims. Keep native turn IDs/body-free digests in durable reports rather than credential/transcript content.

- [ ] **Step 6: Run impacted-test verification**

Run: `pnpm run test:vitest run test/unit/tooling/testing/ --config config/vitest/vitest.config.ts`

Run: `cargo test -p freshell-agent-runtime -p freshell-session-host -p freshell-supervisor`

Expected: PASS, alongside the eight nonzero actual qualification receipts. Manifest remains blocked until Task 10's final candidate evidence. Historical qualifications or default suite green cannot replace any required real selection.

- [ ] **Step 7: Commit the task**

Run: `git add scripts/testing/qualification-observations.ts test/unit/tooling/testing/qualification-observations.test.ts scripts/testing/provider-qualification-receipt.ts scripts/testing/fresh-agent-qualification-receipt.ts scripts/testing/runtime-provider-qualification.ts scripts/testing/runtime-fresh-agent-qualification.ts test/unit/tooling/testing/fresh-agent-qualification.test.ts test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts test/e2e-browser/helpers/managed-runtime.ts test/e2e-browser/helpers/external-managed-runtime.ts`

Run: `git commit -m "test(runtime): derive live qualification from native recovery evidence"`

### Task 10: Promote proven modes and produce truthful current Gate 5 readiness

**Files:**
- Modify: `docs/development/runtime-provider-capabilities.json`, `crates/freshell-supervisor/src/service.rs:2484`, `scripts/testing/provider-certification.ts`, `runtime-gate.ts`, `runtime-gate-integrity.ts`, `runtime-phase-scope.ts`, `runtime-phase5-evidence-common.ts`.
- Test: `test/unit/tooling/testing/runtime-gate-integrity.test.ts`, provider/fresh receipt tests, existing Rust release-qualified-workload tests.

**Interfaces:**
- Consumes: all Task 9 native qualification plus actual managed browser/chaos/loss/soak receipts, exact final clean candidate and runtime image.
- Produces: synchronized capability/Rust release switches only for proven modes and a production Gate 5 receipt that derives current scope/selection/evidence, or truthful BLOCKED/FAILED with exact unmet requirements. All requested deferred modes remain an active obligation until proven; BLOCKED is not completion.

- [ ] **Step 1: Write the failing behavioral test**

Add readiness integration cases in the existing gate tests: missing Claude/Codex/Amplifier/fresh row, unexecuted ingress, pre-promotion candidate, wrong image, local-only skipped managed spec, absent post-crash recall, malformed cleanup, unsupported identity bridge and failed gate evidence each refuse production PASS. A full matching synthetic artifact set tests validation but does not certify providers. Rust release launch test verifies every promoted mode routes to its actual provider transport, with qualification-only override absent; manifest and runtime disagreeing causes refusal rather than silent fallback.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/tooling/testing/runtime-gate-integrity.test.ts test/unit/tooling/testing/fresh-agent-qualification.test.ts --config config/vitest/vitest.config.ts`

Run: `cargo test -p freshell-supervisor release_qualified_workload`

Expected: FAIL where current gates accept stale/literal scope evidence or the requested proven modes remain release-disabled.

- [ ] **Step 3: Add the minimal production implementation**

After independent review of Task 9 evidence, update manifest certification/release fields and matching Rust switches together. Require complete qualified rows for terminal Claude/Codex/OpenCode/Amplifier and freshclaude/Kilroy/freshcodex/freshopencode. Preserve deliberate unrelated provider deferrals. Production Gate 5 requires matching current clean candidate SHA/content and image digest, nonzero actual managed cloud browser results, all required real native recall/identity/ingress/writer/isolation/ordering proofs, required chaos/loss/soak evidence and cleanup. Reuse existing phase-5 evidence producers rather than make a new readiness system; replace false positive source assertions where found. Qualification routing alone never counts as release enabled. Commit promotion, build final artifacts, then rerun the eight live qualification commands on that exact committed candidate and run final Gate 5; every later implementation/review change invalidates candidate-bound evidence and triggers impacted/live final evidence again.

- [ ] **Step 4: Run the focused test**

Run: `pnpm run test:vitest run test/unit/tooling/testing/runtime-gate-integrity.test.ts test/unit/tooling/testing/fresh-agent-qualification.test.ts --config config/vitest/vitest.config.ts`

Run: `cargo test -p freshell-supervisor release_qualified_workload`

Expected: PASS for refusals and actual release routing. Commit the promotion before final real evidence so candidate identity is stable.

- [ ] **Step 5: Refactor while green**

Use existing candidate/receipt integrity APIs as the single authority. Remove duplicated affirmative readiness summaries; derive report status from validated current receipts. Do not edit receipts to match a changed candidate.

- [ ] **Step 6: Run impacted-test verification**

Run: `GCLOUD_ROBOT_REQUIRE=1 FRESHELL_TEST_SUMMARY='durable souls reliability final full gate' pnpm run test`

Run all eight explicit Task 9 live commands again on the committed promoted candidate. Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:runtime:raw gate phase-5 --mode production --require-live`

Expected: PASS full suite and production Gate 5 with all required current-candidate evidence. If the current phase-5 campaign needs individual soak/chaos/loss evidence, invoke the existing `pnpm run test:runtime:campaign` workflow documented in the runtime rollout and preserve its actual receipts; never skip its required durations/cases or claim raw gate alone generated missing artifacts. Missing provider setup, backend breakage or unresolved binding finding is FAILED/non-converged and remains work to resolve, never a completed residual.

- [ ] **Step 7: Commit the task**

Run: `git add docs/development/runtime-provider-capabilities.json crates/freshell-supervisor/src/service.rs scripts/testing/provider-certification.ts scripts/testing/runtime-gate.ts scripts/testing/runtime-gate-integrity.ts scripts/testing/runtime-phase-scope.ts scripts/testing/runtime-phase5-evidence-common.ts test/unit/tooling/testing/runtime-gate-integrity.test.ts`

Run: `git commit -m "feat(runtime): enable natively qualified durable provider modes"`

The Step 6 final candidate runs occur after this commit; do not commit generated private evidence into the repo. If readiness repair changes source, commit and repeat the affected final runs before acceptance.

### Task 11: Prepare concrete deployment and seven-root restoration without live mutation

**Files:**
- Create: `docs/development/durable-souls-restoration-runbook.md`.
- Modify: `AGENTS.md` to link the agent runbook; `README.md` for affected managed Resume/Stop usage only; `docs/index.html` only if Tasks 1/7 materially change UI.
- Create external reports: `reports/durable-souls-current-restoration-preflight.md`, `reports/durable-souls-final-verification.md` under the current run directory.

**Interfaces:**
- Consumes: final clean commit, independent reviews, successful current-candidate broad/managed/live Gate 5 evidence, exact authenticated repair route, body-free current read-only source/target inspection.
- Produces: concrete reviewed target manifest/runbook for nine incident/soul targets, seven original roots/canonical destinations and actual duplicate choices, preserving stopped state; reviewable PR/deployment/restoration request with exact approval boundary and rollback/recovery procedure.

- [ ] **Step 1: Write the failing operational smoke scenario**

Extend the owned synthetic restoration browser/rig scenario to execute the runbook operation using nine targets/seven roots, not a new soul import alone: capture revisions/store/root metadata, resolve actual duplicates, preflight all roots, submit authenticated idempotent stopped repair, verify seven installed graph digests and provider-identity access receipts, verify stopped state, all explicit views/retractions/unrelated records, then interrupt and rerun the same operation key. Change a captured intent/source revision before application and assert zero unauthorized correction; a partial import may exist only as a recoverable owned operation without early false-record withdrawal. No agent auto-start occurs. Verify rollback/recovery directions against a synthetic stale receipt and interrupted import/publication/withdrawal.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `FRESHELL_RUNTIME_SYNTHETIC_RESUME=1 GCLOUD_ROBOT_REQUIRE=1 pnpm exec tsx scripts/testing/runtime-external-browser.ts --spec test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts --grep 'stopped nine-soul restoration runbook'`

Expected: FAIL for any missing exact operational step. This task's red/green applies to the behavior-executing smoke scenario, not tests asserting runbook text. If Task 7 already protects the exact flow, reuse its executed behavior instead of inventing documentation-copy tests.

- [ ] **Step 3: Add the concrete runbook and current preflight**

Write an agent runbook linked from AGENTS.md. Use the existing self-hosted launcher and deployment instructions, not new deploy code. Include these exact phases:

1. **Before approvals, read-only current preflight:** inspect fresh live inventory/loss target metadata and source catalog without transcript bodies or mutation; record the nine `(soul, incident, intent revision)` targets, seven root/store IDs, duplicate groups and canonical-owner evidence/typed choice, source schema/pinned binary, graph counts/bytes/digests/assets, current source identity and target import/reader/adoption generations, notices/receipt/artifact identifiers and existing blocked runtime reasons. Explain any change from historical census instead of trusting 179-session/eight-target figures. A changed target set invalidates the prepared batch; never silently substitute another session. No real provider conversation starts. Real target values live in the body-free external report, not a historical blank eight-row map.
2. **Reviewable branch:** clean focused commits and successful current final gates/reviews; push feature branch using configured identity and pre-push gate. Ask separately for PR creation/landing approval; no PR exists before approval. On authorization open PR targeting main, wait required checks, merge and fast-forward local main. Historical source PR authorization does not apply.
3. **Immediately before asking exact APPROVED:** refresh read-only target revisions/source fingerprints/duplicate-owner choices, identify exact deployed/live binary commit via startup logs, record rollback binary/client artifact locations, candidate build/image and provider grant/reference prerequisites, and stage the fully specified authenticated nine-target request without sending it. Validate batch/readability steps in the isolated rig. Include explicit blocked-runtime reconciliation targets and allowed current intent revisions. Do not restart 3001 or mutate its runtime state. If ambiguity remains, request the user's owner strategy using exact typed choices; ambiguity is not automatic permission.
4. **Only after exact APPROVED for live deployment/restoration:** use `scripts/launch-rust.sh --restart --port 3001` from approved merged main with ownership verification, health/build identity and error logs. Apply the reviewed stopped batch through the authenticated route using current operation ID/targets and CAS; transfer exact seven roots once and verify installed complete history plus actual provider-identity readability. Leave all seven canonical owners stopped/resume-ready; no implicit prompts/resume. Confirm nine exact false incidents/notices/exports are withdrawn, explicit duplicate views rebound, duplicate owner retirement complete, unrelated records/source stores intact and data repair receipts distinct from provider-running evidence. Reconcile only approved existing blocked **desired-running** runtimes through revision-fenced supervisor retry after config fix; never restart user-stopped souls or use bulk process killing.
5. **Failure/recovery:** source/target mismatch or provider access failure keeps repair pending/stopped and preserves source/false artifacts until qualified completion. Partial staged imports recover by operation/generation receipts; retry same operation after fresh CAS inspection, never overwrite conflicting unreceipted target content. Incomplete withdrawal resumes exact durable progress while unrelated exports continue. Old production binary/client can be restored only by the approved launcher operation after checking schema compatibility; SQLite migration rollback is not a generic down-migration. Preserve upgraded registry/provider data and use the compatible prior artifact or fix-forward; obtain renewed approval if a distinct live restart is needed. Never discard source evidence or unrelated changes.
6. **After approved completion:** health, current build log, exact inventory/read receipts, stopped/resume-ready canonical mappings, truthful running observations for only explicitly reconciled desired-running targets, zero false artifacts, no owned cleanup pending, unrelated sessions unaffected, and final body-free outcome report. A later user Resume invokes the provider observation gate; restoration itself does not certify adoption of real conversations.

Do not run phases 2–6 before their approvals. User approval is the final step after all authorized code, test, review and preparation work is concrete.

- [ ] **Step 4: Run the operational smoke test**

Run: `FRESHELL_RUNTIME_SYNTHETIC_RESUME=1 GCLOUD_ROBOT_REQUIRE=1 pnpm exec tsx scripts/testing/runtime-external-browser.ts --spec test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts --grep 'stopped nine-soul restoration runbook'`

Expected: PASS with nonzero actual selected scenario and owned cleanup. Current real preflight is read-only evidence, not a live restoration PASS.

- [ ] **Step 5: Refactor while green**

Reference existing launcher/test/runbook procedures; remove repeated deployment code and historical eight-target assumptions. Keep private current identifiers in the body-free external report and general procedure in the agent runbook. No text/hash test is added.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo fmt --all --check`

Run: `pnpm run typecheck`

Run: `GCLOUD_ROBOT_REQUIRE=1 FRESHELL_TEST_SUMMARY='durable souls reliability completion verification' pnpm run test`

Expected: PASS after final source changes. Obtain independent full-branch specification and quality reviews and a final delta review after any repair. Record all findings with final dispositions under the supplied scope policy. Re-run impacted real candidate-bound qualification/managed/Gate 5 evidence if the final candidate changed; docs-only commits still need truthful candidate handling in receipt integrity, never forged SHA rewrites. Final report maps each claim to executed tests, counts, candidate, image and receipts and clearly says live deployment/restoration has not run. Native Windows filesystem behavior not actually executed on Linux is disclosed; if required by the modified platform path, run native Windows affected checks using the existing Windows runbook, not WSL substitutes.

- [ ] **Step 7: Commit the task**

Run: `git add docs/development/durable-souls-restoration-runbook.md AGENTS.md README.md test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts`

Stage docs/index.html only if materially changed. Run: `git commit -m "docs(runtime): prepare reviewed nine-soul restoration and deployment"`.

Push the clean branch after final required checks. Stop before PR creation and live deployment; provide the concrete approval request and exact approval sources. Code completion and prepared restoration are distinct from production completion.

## Acceptance and self-review map

| User obligation | Tasks | Observable evidence |
| --- | --- | --- |
| Preserve existing repair and unrelated work | 1–2 | Immutable capture hashes, three-way diff retaining current Codex fixes, source untouched, fresh impacted passes/reviews |
| Correct seven surviving roots / nine lost souls / duplicates | 1, 7, 11 | Exact nine-target route, seven installed graph/read receipts, one canonical owner/root, explicit views preserved, stopped smoke and current preflight |
| No loss from missing identity/uninspected storage | 3 | Online/offline/final loss behavior rejects unknown/unreadable/incomplete sources; no certificate/cleanup/replacement, genuine exact absence still works |
| Resume identity from provider evidence | 4, 9 | Current incarnation/nonce/native observation required before LIVE, real same-root post-crash recall for every requested mode |
| Config permissions and blocked runtime reconciliation | 2, 8, 11 | Real zero-capability UID rootless publication/rollback and exact blocked fixture retry; concrete approval-gated live targets |
| Restart-safe bounded automatic recovery | 5 | Durable failed-attempt budget/due/reservation crash matrix, no duplicate creation/reset or stale-intent retries |
| Finish interrupted ordinary Stop | 6, 8 | Exact-handle crash points converge to verified empty or honest blocked state with no resurrection; actual cloud browser Stop proof |
| Qualify deferred terminal/fresh modes | 8–10 | Eight positive actual provider selections, correct SDK/binary/profile, post-crash native recall, ingress/approval/writer/isolation/order artifacts |
| Actual managed browser and truthful readiness | 8–10 | Cloud browser talks to owned real rootless rig via HTTPS/WSS; positive execution counts, final candidate/image-bound production Gate 5 |
| Tests, independent reviews, logs, pnpm/backends/OneCLI/process safety | all | Focused red/green/refactor, sandbox/managed integration, full supported gate, independent review dispositions, structured diagnostic records |
| No premature PR/live restart or real conversation starts | 11 | Clean pushed reviewable branch, explicit pending approval boundaries, read-only preflight and stopped restoration procedure |

Before committing this plan, confirm the exact User Request block occurs once and unchanged; all requested behavior is assigned above; no required provider or real-browser outcome ends in a mock or deferred mode; every file/interface is introduced before use; test commands select real behavior with nonzero cases; code patches specify central branches and persistence; imported defects need fresh verification/review; operational recovery is included; and approval-gated live steps remain pending only because that is the user's accepted residual. Plan snippets are pre-implementation drafts: after execution starts, source code supersedes snippets, while User Request, goal, architecture, constraints and task intent remain authoritative. No source fixes are backported into this plan.
