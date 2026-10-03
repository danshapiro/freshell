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

**Architecture:** Add an OpenCode-specific, bounded native-history transfer from the selected host session into the soul-owned provider store. Before PTY spawn, independently verify that a consistent source snapshot has been imported in full; after spawn, require a provider-produced signal that OpenCode actually adopted the exact root before treating the conversation as restored or accepting input. Keep the immutable import-baseline manifest valid across legitimate later provider writes, and never copy unrelated host conversations or place history bodies in control metadata, registry rows, logs, or incident records. Fence transfer, readiness, loss certification, and restoration with durable identity/revision checks, then reconcile the exact seven conversations and withdraw only their eight false-loss incidents and dependent exports.

**Tech Stack:** Rust workspace crates, SQLite/rusqlite, serde protocol messages, Tokio session-host lifecycle, fake OpenCode integration fixtures, Vitest helper tests, and Playwright managed-runtime coverage.

## Global Constraints

- Work only in `/home/dan/code/freshell/.worktrees/managed-opencode-session-recovery` on `the-usual/managed-opencode-session-recovery`, based on `origin/main` `922a9241533d409cedfd323f1585eddf908848bd`; keep the primary checkout untouched.
- Use pnpm 10.34.5 with the committed lockfile. Follow `scripts/base-gate.sh`, the test coordinator, cloud backend configuration, and repo test-sandbox rules for the relevant test levels.
- Use red-green-refactor for each behavior change. Add tests that fail for the missing behavior, preserve existing coverage, run impacted tests and the full supported gate, and commit each accepted task.
- Keep OpenCode history separate from provider configuration, credentials, bootstrap files, and control-frame metadata. Resolve source identity on the trusted host from the selected provider store; never accept an arbitrary filesystem path from the client.
- Preserve exact native IDs, parent/child edges, row ordering, timestamps, opaque provider data, and required provider-owned referenced assets. Fail closed on partial, unreadable, unsupported, ambiguous, or conflicting source state.
- Do not modify unrelated runtime records or delete the only recoverable copy. Remove the exact false-loss artifacts only after independent continuity verification; leave unrelated incidents, notices, writer claims, and user stop intent intact.
- Finish implementation, verification, review, and the authorized PR before any production restoration. Do not restart the self-hosted Freshell server without the exact approval word `APPROVED`. Any live data correction is limited to the seven verified sessions and their eight exact false-loss records, and occurs only after source and destination continuity are proven.
- Every PR targets `main`; wait for required checks and merge through the PR, then fast-forward local `main` from `origin/main`.

---

## File Responsibilities and Interfaces

The load-bearing stage must settle the precise source snapshot mechanism, provider-owned tables/assets required by the pinned OpenCode version, transfer channel, and restoration transaction before code work starts. The responsibilities below define the required boundaries; the final plan revision records the selected concrete types and paths based on those checks.

- `crates/freshell-runtime-protocol/src/lib.rs`: versioned, OpenCode-only transfer reference and receipt metadata. It binds exact provider/store/root IDs, source snapshot generation and manifest digest, destination-relative database location, and import state; it contains no transcript rows or credentials.
- Host-side native history module under `crates/freshell-sessions/` or another existing SQLite-owning crate selected by load-bearing validation: read a consistent source snapshot, compute the exact recursive session closure and dependency manifest, and expose an exact-session export without mutating the source.
- `crates/freshell-server/src/managed_runtime.rs` and, only if required by the validated transfer channel, `crates/freshell-supervisor/src/backend.rs`: resolve/stage the selected source snapshot and bind it to the launch incarnation without exposing the host-wide store.
- `crates/freshell-session-host/src/main.rs`: import and verify the exact history before provider setup reaches PTY spawn; incomplete transfer must fail the launch as blocked and retryable.
- `crates/freshell-agent-runtime/src/lib.rs`, `crates/freshell-session-host/src/pty.rs`, and `docs/development/runtime-provider-capabilities.json`: distinguish requested identity, pre-spawn import verification, and post-spawn provider-observed adoption; declare native import as a recovery path.
- `crates/freshell-supervisor/src/registry.rs`, `recovery.rs`, `loss_report.rs`, `loss_report_tests.rs`, and notice/outbox helpers: enforce durable materialization/loss fencing, support explicit restoration of a Lost soul, prevent stale cleanup/export from undoing restoration, and retract exact false incident data.
- `crates/freshell-session-host/src/main.rs` tests, `crates/freshell-agent-runtime/src/lib.rs` tests, supervisor unit tests, and `test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts`: prove the exact user-visible handoff, failures, recovery, and future writes under the same native session ID.
- `test/unit/tooling/testing/provider-native-history.test.ts` and fake OpenCode fixtures: build deterministic synthetic SQLite graphs, validate exact structural transfer and source WAL handling without real conversation bodies.

The transfer interface must be defined before task 2: a bounded staged-source handle plus manifest/version/digest and a destination import receipt. Pre-spawn imported readiness independently verifies every imported row and dependency. Post-spawn adoption is a separate state requiring an actual provider-produced signal for the exact root; neither the requested argument, an imported row, nor generic process liveness proves adoption. The immutable import-baseline manifest must allow legitimate subsequent provider writes without masking removal or corruption of imported history. The supervisor's loss fence must capture the exact native identity and current intent/materialization generation, and its commit must fail if either changes before the loss transaction.

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
- Produces: an idempotent `ImportReceipt` proving the source snapshot's exact imported baseline is present in the destination. The session host completes independent structural verification before `HostedPty::spawn`; any partial/ambiguous/conflicting import returns blocked and retryable and cannot launch. The receipt does not claim OpenCode has adopted the root.

- [ ] **Step 1: Write failing protocol, import, and launch-order tests**

Add protocol serialization/validation tests for an OpenCode-only optional transfer reference, exact requested ID/provider-store binding, bounded metadata, and rejection for another provider or mismatched root. Add destination DB tests showing atomic rollback on injected mid-import failure, idempotent replay of the same digest, rejection of a conflicting source import without rejecting legitimate later destination appends, exact imported graph/opaque value preservation, and exclusion of an unrelated session. Extend the grant-handler test with an event log and assert `snapshot -> import -> independent verify -> provider spawn`; assert provider adoption remains pending until a separate post-spawn signal, and no spawn occurs for missing, unsupported, or partial imports.

- [ ] **Step 2: Run the focused tests and verify the intended failure**

Run: `cargo test -p freshell-runtime-protocol opencode_session_transfer && cargo test -p freshell-session-host opencode_transfer`

Expected: FAIL because the typed transfer reference, atomic importer, and pre-spawn ordering do not exist.

- [ ] **Step 3: Add typed handoff, importer, and pre-spawn integration**

Add optional serde-compatible OpenCode transfer metadata to the persisted launch spec and its validation. Resolve the staged source on the trusted host, transfer it through the narrow private handoff selected in the load-bearing stage, and import only the manifest's exact graph inside one destination transaction. Verify the destination from a separate read-only connection, write a durable import-baseline receipt keyed by digest/generation, then allow PTY spawn. Retries with the same source digest are idempotent. A different source digest that conflicts with an existing import blocks for explicit reconciliation; legitimate provider appends remain allowed and do not rewrite the import baseline. Stale, partial, unsupported, or oversized transfers fail closed. Do not reuse `ProviderBootstrapFile`, `ProviderConfigReference`, or transcript projections for the history payload.

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

### Task 3: Separate Verified Import from Provider Adoption

**Files:**
- Modify: `crates/freshell-agent-runtime/src/lib.rs`
- Modify: `crates/freshell-session-host/src/pty.rs`
- Modify: `docs/development/runtime-provider-capabilities.json`
- Modify: focused agent-runtime and session-host tests

**Interfaces:**
- Consumes: requested resume ID, import receipt/manifest digest, and independently probed destination DB.
- Produces: distinct requested, imported, and provider-observed identity evidence. `ImportedVerified` means the import-baseline rows/dependencies match before spawn; `ProviderObserved` means a provider-produced post-spawn signal confirms the exact root was adopted. Neither a matching DB row nor an argv resume flag proves provider adoption. User input and successful restore publication wait for `ProviderObserved`; unknown/unresolved states remain blocked.

- [ ] **Step 1: Write failing readiness and identity tests**

Extend the OpenCode probe tests: exact session row with no complete messages/parts is not imported-verified; partial child/message/part graph is blocked; a complete graph matching the import baseline is `ImportedVerified` before spawn; later provider-created rows do not invalidate that baseline, while removal or corruption of an imported row does. Extend PTY identity tests so requested ID and process liveness are not reported as provider adoption; only the pinned provider's independently identified success signal changes state to `ProviderObserved`, while an explicit provider rejection stays blocked. Add a capability test requiring `NativeImport` and exact import evidence.

- [ ] **Step 2: Run tests and verify the intended failure**

Run: `cargo test -p freshell-agent-runtime opencode_probe && cargo test -p freshell-session-host requested_resume_is_not_observed`

Expected: FAIL because current probe checks only `session.id`, and PTY initializes provider identity from the requested ID without a separate post-spawn adoption signal.

- [ ] **Step 3: Strengthen readiness evidence**

Make the read-only pre-spawn probe validate the immutable import baseline against exact root/descendant sessions, messages, parts, and required dependencies, while allowing identified legitimate destination evolution and rejecting loss/corruption of baseline rows. Preserve `Ready` / definitive absence / `Blocked` at the import layer and add a separate post-spawn provider-observed adoption state based on the signal verified in load-bearing validation. Track request intent separately from both states; never derive observation from `--session`, row presence, or liveness. Do not require post-spawn adoption before spawn. Declare OpenCode's import recovery path and keep its source verdict unresolved until import evidence is durable.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-agent-runtime opencode_probe && cargo test -p freshell-session-host requested_resume_is_not_observed`

Expected: PASS with complete import baseline accepted pre-spawn, incomplete/corrupted baseline blocked, provider-written additions accepted, and requested-only identity not treated as provider confirmation; post-spawn rejection never publishes restored success.

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

Add tests proving `Allocated`/`Materializing` OpenCode souls cannot produce `Lost`; unresolved or available `NativeImport` blocks loss; a transfer or native identity recorded after the final probe prevents `prepare_loss`; an absent complete source set can still produce true loss; simultaneous claims for the same `(provider, source-store identity, native id)` across two different destination soul stores yield one winner; and cleanup for the losing soul cannot delete the winner's exact claim. Include a zero-input requested-ID case so request presence cannot masquerade as dispatched or durable history.

- [ ] **Step 2: Run tests and verify the intended failure**

Run: `cargo test -p freshell-supervisor materializing_cannot_be_lost && cargo test -p freshell-supervisor loss_commit_rejects_newer_materialization && cargo test -p freshell-supervisor native_id_has_one_writer`

Expected: FAIL because loss currently ignores allocation/durability state and its final commit does not compare captured native identity/evidence generation.

- [ ] **Step 3: Add a durable materialization/loss fence**

Use the per-soul lifecycle lock for materialization and explicit recovery probes, and add a SQLite transaction-level compare-and-set over intent revision, evidence/materialization generation, exact native identity, desired state, and allowed recovery state. Identity/resume writes use the same revision boundary and reject writes after stop/loss. Add OpenCode `NativeImport` to the declared path inventory; require a definitive absent source verdict before loss, and require completed exact transfer before verified durable state. A missing initial identity or requested ID alone never satisfies dispatch or durability checks.

- [ ] **Step 4: Run focused tests**

Run: `cargo test -p freshell-supervisor materializing_cannot_be_lost && cargo test -p freshell-supervisor loss_commit_rejects_newer_materialization && cargo test -p freshell-supervisor native_id_has_one_writer`

Expected: PASS for stale-writer rejection, one source-root owner across distinct destination stores, blocked unresolved paths, and a preserved genuine-loss path.

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

Add a registry/filesystem fixture containing a Lost soul, its exact `loss_incidents` row, loss-created stop tombstone, pending open/final export events, open/closed JSON exports, incident JSONL entry, and a batched notice that also references an unrelated incident. Assert restore is rejected for stale incident/revision, ambiguous source-root ownership, or unverified import; restore remains pending until the provider's post-spawn adoption signal; launch failure remains retryable; and an already-claimed cleanup worker can affect only the old incarnation. After adopted restore, assert repeated correction is idempotent; exact false records and exports disappear; unrelated incident/notice references and separate user stop tombstones remain. If crash retry needs a temporary progress marker, assert it contains only exact IDs/revision/status and is deleted after withdrawal completes. Add the duplicate-root case and require one canonical soul to own/reopen that source root.

- [ ] **Step 2: Run tests and verify the intended failure**

Run: `cargo test -p freshell-supervisor restore_lost_soul && cargo test -p freshell-supervisor withdraw_false_incident`

Expected: FAIL because Lost souls have no restore transition and incident exports/notices have no correction lifecycle.

- [ ] **Step 3: Add revisioned restore and exact incident withdrawal**

Under the lifecycle lock, stage restoration with the exact incident/revision and source-root owner, durably invalidate cleanup for the old exact incarnation, verify the imported baseline, launch the new incarnation, and wait for the independent provider-adoption signal before publishing restored success. Preserve retryable correction state and do not withdraw false incident records if launch/adoption fails. After adoption, use a durable compare-and-set to publish the restored view and claim exact false-incident withdrawal. Serialize export and cleanup workers against this correction state through their filesystem effect. Remove only the exact false `loss_incidents` rows, loss-created stop tombstones, export outbox entries, notice/projection references, open/closed JSON files, and exact JSONL lines. A minimal ID/revision/status progress marker may bridge DB and filesystem cleanup if required; delete it once every targeted surface is withdrawn and stale workers can no longer recreate them. Never retain the false certificate/body or a backup archive. Repeated calls must be safe.

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

### Task 6: Prove Managed Resume End to End and Prepare the Production Runbook

**Files:**
- Modify: `test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts`
- Modify: existing synthetic managed-runtime fixture and provider-native-history helper files used by that spec
- Modify: only the smallest synthetic runtime fixture/API needed to exercise the production transfer and restore paths
- Create: `<logs_dir>/reports/managed-opencode-restoration.md` (post-merge runbook; no real session contents or false incident exports)

**Interfaces:**
- Consumes: production launch and restore behavior from tasks 1–5 and isolated synthetic OpenCode source DBs.
- Produces: automated proof that a fresh soul imports and verifies a complete synthetic conversation before spawn, receives the provider's exact post-spawn adoption signal before accepting input, appends a new synthetic turn under the same ID, and reopens without losing imported rows; a body-free, exact-target production runbook to use only after PR merge and the required `APPROVED` restart authorization.

- [ ] **Step 1: Write the failing managed-runtime continuity scenario**

Extend the existing managed OpenCode resurrection spec with an isolated host source DB and empty soul provider volume. Seed a synthetic root plus descendants, ordered messages, linked parts, and an unrelated session. Assert source snapshot/import/independent baseline verification precede PTY spawn, and the post-spawn provider signal precedes user input or restored success. Read all expected synthetic history, send a synthetic follow-up, and assert new rows append under the same root ID while imported row identities and required data remain. Simulate an interrupted partial transfer, an unresolved source, provider rejection, and a stale cleanup result; assert none creates a Lost view, false incident export, or second writer. Retain the positive test that a truly absent, fully checked source may be lost.

- [ ] **Step 2: Run the focused test and verify the intended failure**

Run: `FRESHELL_TEST_SUMMARY='managed OpenCode source-to-soul resume' GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e:cloud --project=rust-chromium --grep='managed OpenCode source-to-soul resume' test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts`

Expected: FAIL because the current launch does not transfer host-side native history or independently observe provider adoption.

- [ ] **Step 3: Complete E2E wiring and run exact-scope restore**

Implement only synthetic test harness integration needed to drive production interfaces. Run the E2E until it proves import verification, provider adoption, exact full-history continuity, and future append. Prepare the post-merge production runbook with exact API sequence, preflight fields, canonical-owner check, post-adoption withdrawal order, rollback/retry behavior, and the exact `APPROVED` restart gate. Do not read or mutate real session state in this task, and never send a test prompt to a real conversation. The later authorized repair receipt may contain only target IDs, graph counts, digests, revision/status codes, and completion status; it must not retain transcript bodies or obsolete incident exports.

- [ ] **Step 4: Run E2E and live restoration verification**

Run: `FRESHELL_TEST_SUMMARY='managed OpenCode source-to-soul resume cloud' GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e:cloud --project=rust-chromium --grep='managed OpenCode source-to-soul resume' test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts`

Expected: PASS for synthetic exact-history import, pre-spawn verification, post-spawn adoption, new-turn append/reopen, fail-closed partial transfer, stale cleanup fencing, and false-loss prevention. The runbook contains no real session contents or incident exports.

- [ ] **Step 5: Refactor while green**

Remove temporary test-only hooks and duplicated fixture setup. Confirm false incident cleanup is driven only by the exact verified target set and is idempotent. Re-run the configured cloud E2E and inspect the runbook for exact restart and data-restoration gates.

- [ ] **Step 6: Run impacted-test and full verification**

Run: `FRESHELL_TEST_SUMMARY='managed OpenCode session recovery full gate' GCLOUD_ROBOT_REQUIRE=1 pnpm run test`

Expected: PASS for coordinated client, Rust, and Electron coverage. Then run the affected Playwright spec on the configured cloud backend as required by the repo PR gate: `FRESHELL_TEST_SUMMARY='managed OpenCode source-to-soul resume cloud' GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e:cloud --project=rust-chromium --grep='managed OpenCode source-to-soul resume' test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts`.

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts test/e2e-browser/fixtures test/e2e-browser/helpers
git commit -m "test(runtime): prove managed OpenCode history recovery"
```

## Code and PR Completion Gate

- [ ] All six task commits are reviewed; the branch is clean and based on current `origin/main`.
- [ ] Synthetic coverage proves exact import, provider adoption, append/reopen, single-writer ownership across different destination stores, fail-closed source handling, and exact false-incident withdrawal while preserving unrelated notices and user stop intent.
- [ ] Incomplete or unresolved source transfer cannot launch or become Lost; a truly absent complete source inventory can still follow existing true-loss behavior.
- [ ] The full supported suite and affected E2E coverage pass; whole-branch and final delta reviews have no unresolved must-fix findings.
- [ ] Open and merge the authorized PR targeting `main`, wait for required checks, merge, fast-forward local `main`, and clean up the feature worktree per repository instructions.
- [ ] **Post-merge live restoration (separate approval gate):** verify the exact seven source roots and eight incident references using only body-free metadata; resolve the canonical duplicate owner; then request exact `APPROVED` before restarting/deploying the self-hosted server. After approval, use the merged restore flow, verify imported history and provider adoption for all seven roots, withdraw the eight exact false incidents and dependent exports, verify unrelated incidents/notices/user stops remain, and delete any temporary withdrawal-progress marker. Until this finishes, report the live restoration as pending; PR merge alone is not completion of the data repair.
