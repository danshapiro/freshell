# Managed OpenCode Session Recovery Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh implementer and a specification-plus-quality review after every task. Track progress with the checkbox steps below.

## User Request

### Requested result
Fix managed OpenCode resume for pre-existing host sessions by transferring and verifying the exact native session history needed for continuity before launch; prevent failed initial materialization or available/unresolved source data from being certified lost; restore the seven affected OpenCode conversations, reconcile all eight false-lost soul/incident rows (including duplicate ownership), remove their obsolete incident records/exports, and land the code on `main` through a PR.

### Explicit constraints
- Use the-usual workflow and its isolated-worktree, test-first, review, and PR gates.
- Preserve all seven existing OpenCode conversations and the native history required to use them.
- Do not retain their erroneous lost-soul rows or incident exports as evidence after successful restoration.
- Have an independent adversarial high-reasoning review challenge and pressure-test the diagnosis before implementation. (Completed; see `/home/dan/code/freshell/.worktrees/.the-usual-logs/managed-opencode-session-recovery/reports/adversarial-hypothesis-review.md`.)
- Do not restart the self-hosted Freshell server without the exact approval word `APPROVED`.
- Land the code on main through a PR.

### Accepted tradeoffs and residuals
- None stated.

**Goal:** A managed OpenCode terminal resumes the exact pre-existing native conversation with its complete required history before launching, and unresolved or incomplete recovery remains retryable instead of being declared lost.

**Architecture:** Add an OpenCode-specific, bounded native-history transfer from the selected host session into the soul-owned provider store. The transfer uses a consistent source snapshot, a versioned structural manifest, a transactional destination import, and independent destination verification before PTY spawn; it never copies unrelated host conversations or places history bodies in the control protocol, registry, logs, or incident records. Fence transfer, readiness, loss certification, and restoration with durable identity/revision checks, then reconcile the exact seven conversations and withdraw only their eight false-loss incidents and dependent exports.

**Tech Stack:** Rust workspace crates, SQLite/rusqlite, serde protocol messages, Tokio session-host lifecycle, fake OpenCode integration fixtures, Vitest helper tests, and Playwright managed-runtime coverage.

## Global Constraints

- Work only in `/home/dan/code/freshell/.worktrees/managed-opencode-session-recovery` on `the-usual/managed-opencode-session-recovery`, based on `origin/main` `922a9241533d409cedfd323f1585eddf908848bd`; keep the primary checkout untouched.
- Use pnpm 10.34.5 with the committed lockfile. Follow `scripts/base-gate.sh`, the test coordinator, cloud backend configuration, and repo test-sandbox rules for the relevant test levels.
- Use red-green-refactor for each behavior change. Add tests that fail for the missing behavior, preserve existing coverage, run impacted tests and the full supported gate, and commit each accepted task.
- Keep OpenCode history separate from provider configuration, credentials, bootstrap files, and control-frame metadata. Resolve source identity on the trusted host from the selected provider store; never accept an arbitrary filesystem path from the client.
- Preserve exact native IDs, parent/child edges, row ordering, timestamps, opaque provider data, and required provider-owned referenced assets. Fail closed on partial, unreadable, unsupported, ambiguous, or conflicting source state.
- Do not modify unrelated runtime records or delete the only recoverable copy. Remove the exact false-loss artifacts only after independent continuity verification; leave unrelated incidents, notices, writer claims, and user stop intent intact.
- Do not restart the self-hosted Freshell server without the exact approval word `APPROVED`. Any requested live data correction is limited to the seven verified sessions and their eight exact false-loss records, and occurs only after source and destination continuity are proven.
- Every PR targets `main`; wait for required checks and merge through the PR, then fast-forward local `main` from `origin/main`.

---

## File Responsibilities and Interfaces

The load-bearing stage must settle the precise source snapshot mechanism, provider-owned tables/assets required by the pinned OpenCode version, transfer channel, and restoration transaction before code work starts. The responsibilities below define the required boundaries; the final plan revision records the selected concrete types and paths based on those checks.

- `crates/freshell-runtime-protocol/src/lib.rs`: versioned, OpenCode-only transfer reference and receipt metadata. It binds exact provider/store/root IDs, source snapshot generation and manifest digest, destination-relative database location, and import state; it contains no transcript rows or credentials.
- Host-side native history module under `crates/freshell-sessions/` or another existing SQLite-owning crate selected by load-bearing validation: read a consistent source snapshot, compute the exact recursive session closure and dependency manifest, and expose an exact-session export without mutating the source.
- `crates/freshell-server/src/managed_runtime.rs` and, only if required by the validated transfer channel, `crates/freshell-supervisor/src/backend.rs`: resolve/stage the selected source snapshot and bind it to the launch incarnation without exposing the host-wide store.
- `crates/freshell-session-host/src/main.rs`: import and verify the exact history before provider setup reaches PTY spawn; incomplete transfer must fail the launch as blocked and retryable.
- `crates/freshell-agent-runtime/src/lib.rs` and `docs/development/runtime-provider-capabilities.json`: distinguish requested identity from verified/imported and provider-observed identity; report readiness only after complete history verification; declare native import as a recovery path.
- `crates/freshell-supervisor/src/registry.rs`, `recovery.rs`, `loss_report.rs`, `loss_report_tests.rs`, and notice/outbox helpers: enforce durable materialization/loss fencing, support explicit restoration of a Lost soul, prevent stale cleanup/export from undoing restoration, and retract exact false incident data.
- `crates/freshell-session-host/src/main.rs` tests, `crates/freshell-agent-runtime/src/lib.rs` tests, supervisor unit tests, and `test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts`: prove the exact user-visible handoff, failures, recovery, and future writes under the same native session ID.
- `test/unit/tooling/testing/provider-native-history.test.ts` and fake OpenCode fixtures: build deterministic synthetic SQLite graphs, validate exact structural transfer and source WAL handling without real conversation bodies.

The transfer interface must be defined before task 2: a bounded staged-source handle plus manifest/version/digest and a destination import receipt. The receipt is not readiness by itself; readiness additionally requires the destination DB to independently verify the complete expected session/dependency graph and the provider to reopen the exact root ID. The supervisor's loss fence must capture the exact native identity and current intent/materialization generation, and its commit must fail if either changes before the loss transaction.

## Tasks

### Task 1: Lossless, Exact-Session OpenCode Snapshot and Manifest

**Files:**
- Create: `crates/freshell-sessions/src/opencode_transfer.rs` (or the SQLite-owning module selected by the load-bearing stage)
- Modify: `crates/freshell-sessions/src/lib.rs` and its Cargo manifest only if the selected module requires an existing workspace dependency adjustment
- Test: `crates/freshell-sessions/tests/opencode_native_transfer.rs`
- Test: `test/unit/tooling/testing/provider-native-history.test.ts`
- Modify: `test/e2e-browser/fixtures/fake-opencode.cjs` only to add missing deterministic schema behavior needed by the test

**Interfaces:**
- Consumes: exact root native session ID and a trusted OpenCode data-home/database handle selected by the host; no user-supplied path.
- Produces: a versioned exact-session snapshot and structural manifest covering the root plus all descendants, linked messages and parts, ordering, required auxiliary rows/assets, source generation, byte count, and content digests. The snapshot must be consistent with committed SQLite WAL state and leave the host database unchanged.

- [ ] **Step 1: Write failing synthetic behavior tests**

Create a temporary source DB with a root, a child, a grandchild, an unrelated root in the same project, ordered user/assistant messages, parent-linked messages, text/tool/task parts, and sentinel data in every opaque native payload. Assert export includes the exact recursive closure and ordering, excludes the unrelated session, preserves all IDs/edges/opaque values, includes a committed WAL write, excludes an uncommitted transaction, and does not modify source DB/WAL bytes or source row counts. Add an unsupported-schema and missing-reference case that returns a typed blocked result and emits no payload. Keep all fixtures synthetic.

- [ ] **Step 2: Run the new tests and verify the intended failure**

Run: `cargo test -p freshell-sessions --test opencode_native_transfer`

Expected: FAIL because no lossless exact-session snapshot/manifest API exists yet.

- [ ] **Step 3: Add the snapshot exporter and manifest**

Implement a read-only, SQLite-consistent snapshot of the selected store, then traverse the selected root and recursive child closure. Copy every validated required native row and referenced dependency without rewriting identifiers or provider payloads. Produce a deterministic manifest and digest from structural data, keep bodies out of logs, and return `Blocked` for unsupported schema versions, unsafe file types, incomplete dependency closure, or a source that changes outside the snapshot boundary.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-sessions --test opencode_native_transfer`

Expected: PASS, including the WAL consistency, exact closure, exclusion, opacity, and fail-closed cases.

- [ ] **Step 5: Refactor while green**

Extract reusable SQLite snapshot/manifest helpers only where they reduce duplication with existing provider-history readers. Keep the native transfer payload independent from the bounded transcript projection helper. Re-run the focused test after refactoring.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-sessions`

Expected: PASS for OpenCode discovery, exact session tree relationships, and the new export contract.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-sessions test/unit/tooling/testing/provider-native-history.test.ts test/e2e-browser/fixtures/fake-opencode.cjs
git commit -m "feat(sessions): export exact OpenCode history snapshots"
```

### Task 2: Typed Staging and Transactional Import Before PTY Spawn

**Files:**
- Modify: `crates/freshell-runtime-protocol/src/lib.rs`
- Modify: `crates/freshell-server/src/managed_runtime.rs`
- Modify: `crates/freshell-supervisor/src/backend.rs` only if the selected private handoff requires volume plumbing
- Modify: `crates/freshell-session-host/src/main.rs`
- Create: `crates/freshell-agent-runtime/src/opencode_transfer.rs` or the validated destination-import module
- Modify: corresponding Rust unit and grant-handler test modules

**Interfaces:**
- Consumes: task 1's immutable staged snapshot handle, exact root/descendant manifest, source generation/digest, destination relative path, provider/runtime schema version, and exact incarnation identity.
- Produces: an idempotent `ImportReceipt` proving destination root/child/message/part IDs and relationships match the source manifest. The session host must complete and verify the receipt before calling `HostedPty::spawn`; any partial/ambiguous/conflicting import returns blocked and cannot launch.

- [ ] **Step 1: Write failing protocol, import, and launch-order tests**

Add protocol serialization/validation tests for an OpenCode-only optional transfer reference, exact requested ID/provider-store binding, bounded metadata, and rejection for another provider or mismatched root. Add destination DB tests showing atomic rollback on injected mid-import failure, idempotent replay of the same digest, conflict rejection for a different digest under an existing native ID, exact graph/opaque value preservation, and exclusion of an unrelated session. Extend the grant-handler test with an event log and assert `snapshot -> import -> independent verify -> provider spawn`, plus no spawn for missing, unsupported, or partially imported data.

- [ ] **Step 2: Run the focused tests and verify the intended failure**

Run: `cargo test -p freshell-runtime-protocol opencode_session_transfer && cargo test -p freshell-session-host opencode_transfer`

Expected: FAIL because the typed transfer reference, atomic importer, and pre-spawn ordering do not exist.

- [ ] **Step 3: Add typed handoff, importer, and pre-spawn integration**

Add optional serde-compatible OpenCode transfer metadata to the persisted launch spec and its validation. Resolve the staged source on the trusted host, transfer it through the narrow private handoff selected in the load-bearing stage, and import only the manifest's exact graph inside one destination transaction. Verify the destination from a separate read-only connection, write a durable import-complete marker keyed by digest/generation, then allow PTY spawn. Retries with the same source digest are idempotent; stale, partial, conflicting, unsupported, or oversized transfers fail closed. Do not reuse `ProviderBootstrapFile`, `ProviderConfigReference`, or transcript projections for the history payload.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-runtime-protocol opencode_session_transfer && cargo test -p freshell-agent-runtime opencode_transfer && cargo test -p freshell-session-host opencode_transfer`

Expected: PASS for backward-compatible protocol round trips, atomic import, exact graph verification, idempotency/conflict handling, and pre-spawn gating.

- [ ] **Step 5: Refactor while green**

Consolidate manifest verification so the importer and readiness probe share one structural contract while each opens its own read-only DB connection. Confirm transfer handles expire or are cleaned after the launch receipt is committed, without deleting an in-use snapshot during retry. Re-run all focused tests.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-runtime-protocol && cargo test -p freshell-agent-runtime && cargo test -p freshell-session-host && cargo test -p freshell-server`

Expected: PASS for launch protocol compatibility, provider preparation, exact resume argument behavior, and server launch construction.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-runtime-protocol crates/freshell-server/src/managed_runtime.rs crates/freshell-supervisor/src/backend.rs crates/freshell-session-host crates/freshell-agent-runtime
git commit -m "feat(runtime): import OpenCode history before managed launch"
```

### Task 3: Readiness Requires Imported History and Provider-Observed Identity

**Files:**
- Modify: `crates/freshell-agent-runtime/src/lib.rs`
- Modify: `crates/freshell-session-host/src/pty.rs`
- Modify: `docs/development/runtime-provider-capabilities.json`
- Modify: focused agent-runtime and session-host tests

**Interfaces:**
- Consumes: requested resume ID, import receipt/manifest digest, and independently probed destination DB.
- Produces: distinct requested, imported, and provider-observed identity evidence. `Ready` requires the exact imported closure to match and the provider to reopen the exact root; row presence or an argv resume flag alone is insufficient. Unresolved import remains `Blocked`.

- [ ] **Step 1: Write failing readiness and identity tests**

Extend the OpenCode probe tests: exact session row with no complete messages/parts is not ready; partial child/message/part graph is blocked; exact complete graph with matching import receipt is ready; exact complete local store without a required import receipt is not misreported as newly adopted. Extend PTY identity tests so a requested ID is not reported as observed until the provider watcher or an explicit post-launch check confirms it. Add a capability test requiring `NativeImport` and exact import evidence.

- [ ] **Step 2: Run tests and verify the intended failure**

Run: `cargo test -p freshell-agent-runtime opencode_probe && cargo test -p freshell-session-host requested_resume_is_not_observed`

Expected: FAIL because current probe checks only `session.id`, and PTY initializes provider identity from the requested ID.

- [ ] **Step 3: Strengthen readiness evidence**

Make the read-only probe validate the stored manifest against exact root/descendant sessions, messages, parts, and required provider-owned dependencies. Preserve the three-way `Ready` / definitive absence / `Blocked` distinction. Track request intent separately from verified import and observed runtime identity; never derive observed identity from `--session`. Declare OpenCode's import recovery path and keep its importer verdict unresolved until the receipt is independently verified.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-agent-runtime opencode_probe && cargo test -p freshell-session-host requested_resume_is_not_observed`

Expected: PASS with complete history accepted, incomplete history blocked, and requested-only identity not treated as provider confirmation.

- [ ] **Step 5: Refactor while green**

Factor exact closure comparison into a small value-oriented helper shared by probe and tests; keep body values absent from structured logs and probe results. Re-run focused tests.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-agent-runtime && cargo test -p freshell-session-host && cargo test -p freshell-supervisor`

Expected: PASS, preserving other provider probes and resume flows.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-agent-runtime crates/freshell-session-host/src/pty.rs docs/development/runtime-provider-capabilities.json
git commit -m "fix(runtime): require verified OpenCode history for readiness"
```

### Task 4: Fence Materialization, Retry, and Loss Certification

**Files:**
- Modify: `crates/freshell-supervisor/src/registry.rs`
- Modify: `crates/freshell-supervisor/src/recovery.rs`
- Modify: `crates/freshell-supervisor/src/loss_report.rs`
- Modify: `crates/freshell-supervisor/src/loss_report_tests.rs`
- Modify: supervisor registry/recovery tests

**Interfaces:**
- Consumes: current intent revision, materialization/evidence generation, native ID ownership, declared recovery-path results, and transfer source state.
- Produces: a loss certificate only for a running, fully materialized identity after every applicable source path is definitively absent and a SQLite compare-and-set confirms no newer identity/evidence/intent exists. Materializing, available, unresolved, or stale results remain retryable/blocked.

- [ ] **Step 1: Write failing loss-fence and ownership tests**

Add tests proving `Allocated`/`Materializing` OpenCode souls cannot produce `Lost`; unresolved or available `NativeImport` blocks loss; a transfer or native identity recorded after the final probe prevents `prepare_loss`; an absent complete source set can still produce true loss; simultaneous claims for the same `(provider, store, native id)` across two souls yield one winner; and cleanup for the losing soul cannot delete the winner's exact claim. Include a zero-input requested-ID case so request presence cannot masquerade as dispatched or durable history.

- [ ] **Step 2: Run tests and verify the intended failure**

Run: `cargo test -p freshell-supervisor materializing_cannot_be_lost && cargo test -p freshell-supervisor loss_commit_rejects_newer_materialization && cargo test -p freshell-supervisor native_id_has_one_writer`

Expected: FAIL because loss currently ignores allocation/durability state and its final commit does not compare captured native identity/evidence generation.

- [ ] **Step 3: Add a durable materialization/loss fence**

Use the per-soul lifecycle lock for materialization and explicit recovery probes, and add a SQLite transaction-level compare-and-set over intent revision, evidence/materialization generation, exact native identity, desired state, and allowed recovery state. Identity/resume writes use the same revision boundary and reject writes after stop/loss. Add OpenCode `NativeImport` to the declared path inventory; require a definitive absent source verdict before loss, and require completed exact transfer before verified durable state. A missing initial identity or requested ID alone never satisfies dispatch or durability checks.

- [ ] **Step 4: Run focused tests**

Run: `cargo test -p freshell-supervisor materializing_cannot_be_lost && cargo test -p freshell-supervisor loss_commit_rejects_newer_materialization && cargo test -p freshell-supervisor native_id_has_one_writer`

Expected: PASS for stale-writer rejection, one exact claim owner, blocked unresolved paths, and a preserved genuine-loss path.

- [ ] **Step 5: Refactor while green**

Keep lock ordering consistent across materialize, recover, stop, and loss cleanup. Keep DB CAS as the cross-process fence even where the in-process lifecycle lock applies. Re-run the new race/ownership tests repeatedly.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-supervisor && cargo test -p freshell-agent-runtime`

Expected: PASS for existing loss certificates, retries, stop semantics, provider inventories, and import readiness.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-supervisor crates/freshell-agent-runtime/src/lib.rs docs/development/runtime-provider-capabilities.json
git commit -m "fix(supervisor): fence managed OpenCode loss decisions"
```

### Task 5: Restore Lost Souls and Withdraw Exact False Incidents

**Files:**
- Modify: `crates/freshell-supervisor/src/registry.rs`
- Modify: `crates/freshell-supervisor/src/loss_report.rs`
- Modify: `crates/freshell-supervisor/src/notice_outbox.rs`
- Modify: `crates/freshell-supervisor/src/recovery.rs`
- Modify: `crates/freshell-server/src/managed_runtime_api.rs`
- Modify: supervisor and managed-runtime API tests

**Interfaces:**
- Consumes: exact Lost soul ID, current incident ID and intent revision, canonical native-session writer owner, verified imported history receipt, and exact false incident artifacts to withdraw.
- Produces: a revisioned restored-running view with one active writer for each native conversation, a canceled cleanup/export state that stale workers must re-check, and idempotent withdrawal of only the false incident's DB rows, pending exports, notices/projections, stop tombstone, and filesystem exports/JSONL entries. Separate user stop intent and unrelated notices/incidents remain intact.
- Request boundary: add `POST /api/runtime/souls/{soul_id}/restore` with an exact `incident_id` and `expected_intent_revision`; return the restored soul projection or a conflict response. The route accepts no native filesystem path or transcript data.

- [ ] **Step 1: Write failing restore and withdrawal tests**

Add an end-to-end registry fixture containing a Lost soul, its exact `loss_incidents` row, loss-created stop tombstone, pending open/final export events, open/closed JSON exports, incident JSONL entry, and a batched notice that also references an unrelated incident. Assert restore is rejected for stale incident/revision, ambiguous writer ownership, or unverified history; accepted restore publishes a newer view revision; repeating restore is idempotent; stale cleanup/export workers cannot stop the restored runtime or recreate the false incident; exact false records and exports disappear; unrelated incident/notice references and user stop tombstones remain. Add the duplicate-root case and require only the canonical soul to own/reopen that native ID.

- [ ] **Step 2: Run tests and verify the intended failure**

Run: `cargo test -p freshell-supervisor restore_lost_soul && cargo test -p freshell-supervisor withdraw_false_incident`

Expected: FAIL because Lost souls have no restore transition and incident exports/notices have no correction lifecycle.

- [ ] **Step 3: Add revisioned restore and exact incident withdrawal**

Under the lifecycle lock, first prove the source transfer and canonical exact writer claim. In one immediate SQLite transaction, compare incident ID, intent revision, evidence generation, and current state; claim/cancel pending cleanup and exports; move the soul/incarnation to the restored state; publish a newer view revision; remove only the exact false loss incident and its loss-created stop tombstone; and recompute affected notice/outbox projections without dropping unrelated incident references. Export workers and cleanup workers must re-read the durable canceled/corrected state after taking their claim/lock and before writing or signaling. After the DB transition commits, remove only the matching open/closed JSON files and the exact matching lines from active and rotated incident JSONL files under the same export serialization mechanism. Repeated calls must be safe.

- [ ] **Step 4: Run focused tests**

Run: `cargo test -p freshell-supervisor restore_lost_soul && cargo test -p freshell-supervisor withdraw_false_incident`

Expected: PASS for exact restoration, cleanup cancellation, artifact withdrawal, idempotency, and preservation of unrelated notices, incidents, and stop intent.

- [ ] **Step 5: Refactor while green**

Consolidate exact-incident selection and serialized export-file mutation. Keep ordinary true-loss export/retention behavior unchanged. Re-run stale-worker race and mixed-notice tests.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-supervisor && cargo test -p freshell-server`

Expected: PASS, including true-loss notices, summary APIs, cleanup retry, route auth, and restored-view projection.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-supervisor crates/freshell-server
git commit -m "feat(supervisor): restore souls and retract false loss incidents"
```

### Task 6: Prove Managed Resume End to End and Restore the Seven Conversations

**Files:**
- Modify: `test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts`
- Modify: existing synthetic managed-runtime fixture and provider-native-history helper files used by that spec
- Modify: only the smallest runtime recovery fixture/API needed to exercise the production restore path
- Runbook/PR evidence: `<logs_dir>/reports/managed-opencode-restoration.md` (external run artifact; do not commit real session contents)

**Interfaces:**
- Consumes: production launch and restore behavior from tasks 1–5, plus synthetic E2E source DBs for automated tests and the exact seven host native roots for the requested live data repair.
- Produces: automated proof that a fresh soul can read the complete original synthetic conversation, launch on the same exact ID, append a new turn, and re-open it; operational proof for all seven real roots and eight incident references containing IDs/counts/digests only, not transcript bodies; only after that proof, remove the exact false incident data and files.

- [ ] **Step 1: Write the failing managed-runtime continuity scenario**

Extend the existing managed OpenCode resurrection spec with an isolated host source DB and empty soul provider volume. Seed a synthetic root plus descendants, ordered messages, linked parts, and an unrelated session. Launch the managed soul with the exact root, assert source snapshot/import/readiness precede PTY spawn, read all expected synthetic history from the provider, send a synthetic follow-up, and assert the added rows append under the same root ID while all original row IDs/edges remain. Then simulate an interrupted partial transfer and an unresolved host source; assert neither creates a Lost view, loss certificate, cleanup signal, or incident export. Retain the existing positive test that a truly absent, fully checked source may be lost.

- [ ] **Step 2: Run the focused test and verify the intended failure**

Run: `FRESHELL_TEST_SUMMARY='managed OpenCode source-to-soul resume' pnpm run test:e2e:local --project=rust-chromium --grep='managed OpenCode source-to-soul resume' test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts`

Expected: FAIL because the current launch does not transfer host-side native history into an empty soul store.

- [ ] **Step 3: Complete E2E wiring and run exact-scope restore**

Implement only test harness integration necessary to drive the production transfer/restore interfaces. Run the synthetic E2E until it proves exact full-history continuity and future append. Then use the same production restore operation for the seven verified existing native roots. Resolve duplicate ownership before starting either soul; restore only one canonical soul for the shared root. For each root, require an independent provider-readable history check plus a synthetic append/reopen check in a disposable copy before removing its false incident artifacts. Never send a test prompt to the real conversation. Store an operational receipt containing root/soul/incident identifiers, graph counts, digests, and status only; do not store bodies or preserve the false incident exports as evidence.

- [ ] **Step 4: Run E2E and live restoration verification**

Run: `FRESHELL_TEST_SUMMARY='managed OpenCode source-to-soul resume' pnpm run test:e2e:local --project=rust-chromium --grep='managed OpenCode source-to-soul resume' test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts`

Expected: PASS for synthetic exact-history resume, new-turn append/reopen, fail-closed partial transfer, and false-loss prevention. The operational receipt reports seven restored roots, one canonical owner per root, eight false incident references withdrawn, and zero transcript bodies recorded.

- [ ] **Step 5: Refactor while green**

Remove temporary test-only hooks and duplicated fixture setup. Confirm false incident cleanup is driven only by the exact verified set and is idempotent. Re-run the focused E2E and inspect the operational receipt for body-free output.

- [ ] **Step 6: Run impacted-test and full verification**

Run: `FRESHELL_TEST_SUMMARY='managed OpenCode session recovery full gate' GCLOUD_ROBOT_REQUIRE=1 pnpm run test`

Expected: PASS for coordinated client, Rust, and Electron coverage. Then run the affected Playwright spec on the configured cloud backend as required by the repo PR gate: `FRESHELL_TEST_SUMMARY='managed OpenCode source-to-soul resume cloud' GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e:cloud --project=rust-chromium --grep='managed OpenCode source-to-soul resume' test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts`.

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts test/e2e-browser/fixtures test/e2e-browser/helpers
git commit -m "test(runtime): prove managed OpenCode history recovery"
```

## Completion Gate

- [ ] All six task commits are reviewed; the branch is clean and based on current `origin/main`.
- [ ] The original seven native roots and all required recursive history/dependencies remain intact; each root has one canonical managed writer and passes provider-readable reopen plus synthetic append/reopen verification.
- [ ] The eight false-lost soul/incident references are reconciled; exact incident DB rows, loss-created tombstones, pending/delivered exports, notices/projections, open/closed JSON files, and active/rotated JSONL entries no longer surface these false incidents. Unrelated incidents, notices, and user stop intent remain.
- [ ] Incomplete or unresolved source transfer cannot launch or become Lost; a truly absent complete source inventory can still follow existing true-loss behavior.
- [ ] The full supported suite and affected E2E coverage pass; whole-branch and final delta reviews have no unresolved must-fix findings.
- [ ] Open and merge the authorized PR targeting `main`, wait for required checks, merge, fast-forward local `main`, and clean up the feature worktree per repository instructions.
- [ ] Do not restart the self-hosted Freshell server; that requires the explicit word `APPROVED`.
