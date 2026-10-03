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
- Unsupported or mutable external references keep that source blocked until the resolver can prove and preserve them; they are never skipped silently.
- A bundle larger than 8 GiB remains blocked and needs a revised reviewed limit. The exact body-free preflight size/count check occurs before live staging; the persistent spool is capped at 16 GiB and queues further transfers rather than filling disk.
- The TUI plugin's expected-tail observation confirms the visible conversation tail only. The full imported closure is checked independently before launch.
- Repaired souls stay stopped; restoring their data does not start agents or override later explicit user actions.
- The host-to-soul transfer is a one-time snapshot seed. It leaves the host source untouched and does not synchronize later host writes into the soul; subsequent managed writes remain in the soul's provider store. The canonical-owner rule prevents duplicate managed souls, not independent host-side copies.
- Receipt collisions use `dismissed > acknowledged > rendered > absent` to preserve terminal notification suppression without retaining obsolete false-bearing notice IDs.
- An ambiguous canonical owner or an unclassifiable incident-log fragment pauses the exact batch before it reports completion; ask the user only if body-free metadata cannot resolve the owner safely.

**Goal:** Managed OpenCode can resume the exact pre-existing native conversation with its required history. Failed or incomplete first materialization remains retryable and cannot be declared lost. The seven repaired souls remain stopped and resume-ready; this correction does not start seven agents or override any existing stopped state.

**Architecture:** Resolve the selected host OpenCode store through the trusted session inventory, including its effective `OPENCODE_DB` or installation-channel path; zero or multiple exact-root matches are unresolved. Capture one committed SQLite snapshot. Copy only assets whose pinned-provider semantics make them immutable or whose exact bytes can be verified and mapped; block unsupported or mutable references rather than treating pre/post-copy stability as proof of snapshot consistency. The supervisor owns a durable private staging bundle and exposes it read-only to the trusted session host through an exact per-launch mount. Send bounded bundle chunks through dedicated authenticated history-transfer commands over the existing supervisor Unix socket; never place session bodies in the launch descriptor, registry, or logs. Bind the source schema fingerprint and target image/build receipt before importing, and never run migrations against the host source. Independently verify every imported row and asset before PTY spawn. OpenCode emits no history-loaded event, so post-spawn adoption is a separate Freshell plugin observation: the exact root and its expected imported tail message must appear in hydrated TUI state, correlated to this terminal incarnation; route intent, argv, process liveness, and a database row alone do not qualify. This TUI observation confirms the displayed tail, while the pre-spawn manifest proves the full imported closure. Keep the import-baseline manifest immutable while accepting only identified provider changes. Persist source/import state and fence identity, dispatch, stop, loss, restore, export, and cleanup writes with durable generations. Repair the seven souls as stopped and resume-ready, choose one transcript-free canonical owner for the duplicate root from exact durable metadata, and withdraw only the eight false-loss incidents and their dependent artifacts.

**Tech Stack:** Rust workspace crates, SQLite/rusqlite, serde protocol messages, Tokio session-host lifecycle, fake OpenCode integration fixtures, Vitest helper tests, and Playwright managed-runtime coverage.

## Global Constraints

- Work only in `/home/dan/code/freshell/.worktrees/managed-opencode-session-recovery` on `the-usual/managed-opencode-session-recovery`, based on `origin/main` `922a9241533d409cedfd323f1585eddf908848bd`; keep the primary checkout untouched.
- Use pnpm 10.34.5 with the committed lockfile. Follow `scripts/base-gate.sh`, the test coordinator, cloud backend configuration, and repo test-sandbox rules for the relevant test levels.
- Use red-green-refactor for each behavior change. Add tests that fail for the missing behavior, preserve existing coverage, run impacted tests and the full supported gate, and commit each accepted task.
- Keep OpenCode history separate from provider configuration, credentials, bootstrap files, and control-frame metadata. Resolve source identity on the trusted host from the selected provider store; never accept an arbitrary filesystem path from the client.
- Resolve the exact source store from the trusted host session inventory, honoring `OPENCODE_DB` and installation-channel paths. Never accept a client-supplied path. Zero/multiple matching stores, unreadable paths, permission errors, broken links, unsupported schema, and unavailable assets are unresolved, never absent. Do not migrate or write the host database.
- Bind imports to a source schema/DDL and migration-journal fingerprint plus the target OpenCode package version and immutable runtime image/build receipt. Support only source/target pairs covered by the versioned importer and disposable reopen/append qualification; reject unknown pairs. Any migration is performed only on the staged copy/destination, never on the original host database.
- Keep the import-time baseline immutable and row-keyed. Later recovery must verify all unchanged imported rows/edges/assets and accept changes only through typed OpenCode transitions: unique ordered appends with contiguous event sequences; completion updates tied to their provider events; allowlisted metadata/counter, context-epoch, todo, and pending-input changes; supported compaction boundaries; and reverts tied to an exact revert event/boundary with no pre-boundary row loss. Missing/deleted baseline state without a durable supported transition is `Blocked`, never `Ready` or `Lost`. A deleted session is not recoverable; do not infer user deletion from a missing row. A later changed host source is not re-imported over an evolved soul by timestamp or last-writer-wins.
- Preserve the exact recursive root/descendant graph, native IDs, row relationships/order, timestamps, and opaque provider values. The pinned built-in closure includes session, project, workspace, project-directory, permission, message, part, event-sequence, event, v2 session-message, pending-input, context-epoch, and todo rows. An unrecognized schema, table, relationship, URI, or plugin-owned dependency blocks the transfer rather than being silently omitted.
- Preserve inline `data:` content exactly. Enumerate top-level and nested file parts, v1/v2 tool-output references, and snapshot/revert trees. Keep a reference at its existing path only when it is under the exact workspace mount and the referenced bytes are verified there. Resolve content-addressed snapshot/Git objects by identity; prove the alternate object store is available at the same managed path or stage the complete required object closure. Copy tool-output files only when the pinned writer uses write-once paths; apply an explicit typed mapping to supported provider fields. Reject arbitrary/opaque file references, unknown URI schemes, and unsupported plugin data. Keep arbitrary opaque provider fields unchanged. Record per-row and per-asset digests in an immutable import baseline.
- The initial bundle consists of one consistent SQLite snapshot plus every validated required asset. External bytes must be immutable by provider contract/content address, or the transfer is unresolved; matching metadata before and after a mutable copy is not sufficient to bind it to the database snapshot. Hash each staged and installed byte. Bound each bundle to 8 GiB, stream in chunks no larger than 256 KiB, cap persistent staging at 16 GiB, and check available space before install. Queue transfers that exceed current aggregate capacity and fail before install if a per-bundle bound is exceeded. The manifest digest is the generation used for retries and ownership.
- Do not modify unrelated runtime records or delete the only recoverable copy. Remove the exact false-loss rows, outbox payloads, notice references, incident exports, and exact lifecycle-log records only after all seven destinations pass full imported-baseline verification. Preserve `desired_state=stopped`; the correction never starts a provider, and the user can resume each soul explicitly after repair. Preserve unrelated notices/incidents and any later intent through revision checks.
- Finish implementation, verification, review, and the authorized PR before any production restoration. Do not restart the self-hosted Freshell server without the exact approval word `APPROVED`. Any live data correction is limited to the seven verified sessions and their eight exact false-loss records, and occurs only after source and destination continuity are proven.
- Every PR targets `main`; wait for required checks and merge through the PR, then fast-forward local `main` from `origin/main`.

---

## File Responsibilities and Interfaces

The adversarial review rejected the claim that the missing transfer alone explains every past exit. It established a missing host-to-soul history handoff and eight false-loss records across seven roots, including a duplicate root; the full causal attribution remains unproven. Stage 2 fixed the pinned built-in row closure and identified the source, asset, staging, compatibility, readiness, and correction-publication checks below. Disposable runtime behavior must be proven before any live repair.

- `crates/freshell-runtime-protocol/src/lib.rs`: versioned OpenCode transfer descriptor and receipt metadata only: source-store identity, transfer ID/generation, manifest digest, target root, and state. Never place transcript rows, bodies, credentials, or an unbounded payload in launch/control metadata.
- A native history module under `crates/freshell-sessions/` or the selected SQLite-owning crate: resolve the exact store from trusted session discovery, bind its source schema/migration fingerprint, take a consistent SQLite Online Backup snapshot including committed WAL state, export the exact native closure, enumerate only supported typed assets, and produce the exact-session bundle and immutable manifest without modifying the source.
- `crates/freshell-server/src/managed_runtime.rs` plus the supervisor staging/control path: use dedicated authenticated begin/chunk/finalize history-transfer commands over the existing supervisor Unix socket. Each chunk is at most 256 KiB (below the 1 MiB frame cap); each bundle is at most 8 GiB and the persistent spool at most 16 GiB, with backpressure, digest, quota, and free-space checks. Never log chunk content or place it in the launch descriptor or registry. The supervisor retains the bundle across retries, then mounts only that bundle read-only into the exact incarnation. Verify the session host UID can read the mount and the provider UID cannot read staging, in the actual Docker namespace mode used by managed runtimes. Do not mount the host-wide OpenCode data directory or reuse the writable runtime directory containing the control socket/secrets as the history mount.
- `crates/freshell-session-host/src/main.rs`: verify the staged bundle, install assets and rows idempotently into the soul-owned provider store, re-read and compare the full baseline, persist a receipt, and only then permit PTY spawn. Incomplete transfer remains blocked/retryable.
- `crates/freshell-agent-runtime/src/lib.rs`, `crates/freshell-session-host/src/pty.rs`, `extensions/opencode/freshell-rebind-plugin.ts`, and `docs/development/runtime-provider-capabilities.json`: keep requested, imported, and observed identities distinct. OpenCode 1.18.21 has no history-loaded event/error receipt; the plugin observes the exact session object and expected imported tail message ID in hydrated TUI state, and reports timeout/navigation failure as blocked. This is post-spawn adoption evidence for the displayed tail, not a substitute for the full pre-spawn manifest check. Route-only signals never count. Gate accepted input and restored-success on the correlated observation.
- `crates/freshell-supervisor/src/registry.rs`, `recovery.rs`, `loss_report.rs`, `loss_report_tests.rs`, and notice/outbox/export helpers: persist source/import phases and generations; CAS-fence identity, dispatch, stop, loss, and restore writes; restore Lost souls as stopped/resume-ready; enforce one source-root owner across destination stores; and withdraw exact false incidents without stale exporters recreating artifacts.
- Session-host, agent-runtime, and supervisor tests plus `test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts`: prove exact handoff, failure/retry, provider adoption, single ownership, stopped-ready restoration, and future writes under the same native session ID.
- `test/unit/tooling/testing/provider-native-history.test.ts` and the fake OpenCode fixtures: model the pinned native schema (including both legacy and v2 rows), recursive descendants, references, WAL snapshot behavior, and asset closure without real conversation bodies.

The transfer interface is bounded metadata plus authenticated begin/chunk/finalize commands over the supervisor Unix socket into durable staging. Each chunk is at most 256 KiB, each bundle at most 8 GiB, and the persistent spool at most 16 GiB; capacity pressure queues work. Its manifest binds the unique resolved source store, source DDL/migration fingerprint, exact SQLite snapshot, native closure, typed external assets, destination store/root, target image/build receipt, and import generation. The importer checks quota/free space and rehashes staging and installed bytes after restart. It publishes assets write-once before the native-row transaction and never replaces conflicting content. A crash can leave only blocked, revalidatable staging/assets or a committed DB plus an absent receipt; no such state is ready, and retry reconstructs/compares the receipt from bytes. The immutable import baseline remains separate from verified legitimate provider evolution. Pre-spawn full-manifest verification and post-spawn TUI tail observation are separate phases. Every participating supervisor write captures and compares the required intent, identity, evidence, active-incarnation, attempt, and import generations; provider bytes have their own manifest fence. Restoration and incident withdrawal stay retryable across process restart, and every stale worker rechecks authorization immediately before its side effect.

## Tasks

### Task 1: Lossless, Exact-Session OpenCode Snapshot and Manifest

**Files:**
- Create: `crates/freshell-sessions/src/opencode_transfer.rs` (or the SQLite-owning module selected by the load-bearing stage)
- Modify: `crates/freshell-sessions/src/lib.rs` and its Cargo manifest only if the selected module requires an existing workspace dependency adjustment
- Test: `crates/freshell-sessions/tests/opencode_native_transfer.rs`
- Test: `test/unit/tooling/testing/provider-native-history.test.ts`
- Modify: `test/e2e-browser/fixtures/fake-opencode.cjs` only to add missing deterministic schema behavior needed by the test

**Interfaces:**
- Consumes: exact root native session ID and the effective OpenCode source resolver on the trusted host. Honor `OPENCODE_DB` and installation-channel path selection; never accept an arbitrary source path from a client.
- Produces: a versioned exact-session bundle and manifest for the root and descendants. Include `session`, referenced `project`/`workspace`/`project_directory`/`permission`, `message`, `part`, `event_sequence`, `event`, `session_message`, `session_input`, `session_context_epoch`, and `todo` rows, plus validated referenced assets. Preserve IDs, opaque data, ordering, relationships, and sequence values. Reject an invalid root parent, dangling reference, unrecognized source DDL/table, unsupported plugin data, or external reference that cannot be captured and mapped.
- The source database is read through SQLite Online Backup from one committed snapshot including visible WAL state; the host DB is never opened by a mutating provider or migrated. Record source schema, migration-journal and SQLite-version fingerprints. Assets enter the bundle only under pinned-provider write-once/content-addressed semantics; copy and hash them into a content-addressed immutable bundle. Snapshot trees must resolve against the exact Git object store identity; require that store at the same managed path or stage its complete reachable closure. Typed tool-output path fields may be remapped only through an explicit reversible manifest mapping; arbitrary opaque fields remain unchanged. Mutable or unclassified files are unresolved even if pre/post-copy metadata happens to match.

- [ ] **Step 1: Write failing synthetic behavior tests**

Create a synthetic pinned-schema DB with a root, child, grandchild, unrelated root, v1 and v2 message/event rows, pending input, context epoch, todo, project/workspace/directory/permission dependencies, and sentinel opaque values. Assert exact closure/order, no unrelated session, preserved IDs/edges/opaque values, committed WAL visibility, uncommitted-write exclusion, and no logical source changes. Test trusted store resolution through discovered `OPENCODE_DB` and channel paths; duplicate IDs across stores are ambiguous, while permission errors, broken links, and malformed paths are unresolved rather than absent. Add inline data, write-once tool-output files, content-addressed snapshot trees with and without an accessible alternate object store, unsupported URI/plugin/schema cases, missing assets, and a mutable/unclassified file; unresolved cases must return Blocked without publishing a bundle. Keep all fixtures synthetic.

- [ ] **Step 2: Run the new tests and verify the intended failure**

Run: `cargo test -p freshell-sessions --test opencode_native_transfer`

Expected: FAIL because no lossless exact-session snapshot/manifest API exists yet.

- [ ] **Step 3: Add the snapshot exporter and manifest**

Resolve one unique trusted source store, verify its effective path and source schema fingerprint against the supported version matrix, and take a SQLite Online Backup snapshot. Traverse the root and recursive descendants and validate the complete v1/v2/project dependency closure. Enumerate typed file and snapshot references; accept only write-once or content-addressed assets and verify the required Git object store or stage its complete reachable closure. Preserve native IDs and opaque payload fields; record reversible mappings only for recognized typed paths. Produce deterministic per-row/per-asset digests and a bundle generation. Return `Blocked` for ambiguous source selection, unsafe links, unknown migration state, unsupported schema/reference, missing asset/object, mutable/unclassified external bytes, quota/free-space limit, or any incomplete edge; never reinterpret those states as source absence.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-sessions --test opencode_native_transfer`

Expected: PASS, including WAL snapshot semantics, full native closure, asset mapping, source logical immutability, unrelated-session exclusion, opaque-data preservation, and blocked incomplete/unstable sources.

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
- Modify: `crates/freshell-supervisor/src/service.rs`, `registry.rs`, and `backend.rs` for durable staging identity, bounded transfer, exact mount, and receipt cleanup
- Modify: `crates/freshell-session-host/src/main.rs`
- Create: `crates/freshell-agent-runtime/src/opencode_transfer.rs` or the validated destination-import module
- Modify: corresponding Rust unit and grant-handler test modules

**Interfaces:**
- Consumes: task 1's immutable bundle streamed in authenticated chunks of at most 256 KiB into persistent supervisor-owned staging, plus exact source-store/root/generation/schema fingerprint/manifest, destination, target image/build receipt, transfer ID, and incarnation metadata.
- Produces: an idempotent `ImportReceipt` proving the source snapshot's exact imported baseline is present in the destination. The session host completes independent structural verification before `HostedPty::spawn`; any partial/ambiguous/conflicting import returns blocked and retryable and cannot launch. The receipt does not claim OpenCode has adopted the root.
- Mount/lifetime: enforce an 8 GiB per-bundle ceiling, aggregate staging quota, and free-space check before install. The supervisor verifies the bundle and mounts only its exact directory read-only into the session-host container. In the actual managed Docker namespace mode, prove root session-host access and provider-UID denial. Do not use the 16 MiB private tmpfs, the writable runtime directory, the host-wide provider store, or a control frame for bundle bytes. Keep staged bytes until the durable import receipt is independently revalidated; on startup, revalidate or resume every referenced transfer before removing it.

- [ ] **Step 1: Write failing protocol, import, and launch-order tests**

Add protocol tests for an OpenCode-only transfer descriptor with exact provider/source/destination/root/incarnation binding, source schema fingerprint, target artifact receipt, and bounded metadata. Add streaming tests for chunk ordering, backpressure, digest mismatch, interruption/retry, queueing at the 16 GiB spool limit, free-space rejection, 8 GiB per-bundle bound, and no chunk larger than 256 KiB. Add mount-plan and disposable Docker tests in the managed runtime's actual namespace mode proving the exact staged directory is read-only, readable by the session-host UID, unavailable to the provider UID, and unrelated provider data is not mounted. Add destination tests for atomic DB rollback, idempotent identical transfer, conflict rejection, exact native graph/asset mapping, and destination path agreement with the managed `OPENCODE_DB`/XDG configuration. Inject process crashes after each staged file write/sync/rename, asset publication, native DB transaction, receipt publication, registry readiness commit, and before PTY spawn; every restart must reconstruct or reject state without Ready or overwrite. Against a disposable target image whose digest is bound to a build receipt, exercise provider-owned append, in-flight completion, metadata/context/todo/input updates, compaction, and revert with synthetic data and no model/network call; reopen after each transition and assert the typed evolution comparator, including a revert boundary that never removes pre-boundary rows. Never run the provider on the host source. The grant-handler event log must show `stage -> verify stage -> install assets -> import transaction -> independent verify -> durable receipt -> PTY spawn`; no spawn for partial, unsupported, missing, unstable, incompatible, or conflicting input.

- [ ] **Step 2: Run the focused tests and verify the intended failure**

Run: `cargo test -p freshell-runtime-protocol opencode_session_transfer && cargo test -p freshell-session-host opencode_transfer`

Expected: FAIL because the typed transfer reference, atomic importer, and pre-spawn ordering do not exist.

- [ ] **Step 3: Add typed handoff, importer, and pre-spawn integration**

Add optional serde-compatible transfer metadata to the launch spec and persist only its descriptor. Stream chunks into a dedicated supervisor-owned persistent staging path with the 256 KiB chunk and 8 GiB bundle bounds, quota/free-space checks, and content digest; bind it to transfer ID, unique source-store identity/schema, root, destination, target image receipt, and incarnation. Expose exactly that staged bundle read-only to the trusted session host and verify the actual UID/mount behavior. Install validated immutable assets first using write-once/no-replace publication with file and directory sync; then insert native rows in one destination transaction without overwriting conflicting IDs. Independently compare every row and asset from a read-only connection, durably publish a local receipt, and only then permit PTY spawn and registry readiness. If a crash follows the DB commit but precedes the receipt, reconstruct a receipt only after a full rehash and structural compare; if any state differs, remain blocked. On every retry or restart, rehash staging and installed data before trusting the receipt. A same-generation retry is a verified no-op; a changed or conflicting generation blocks. Never use `ProviderBootstrapFile`, `ProviderConfigReference`, transcript projections, or a control frame for history bytes.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-runtime-protocol opencode_session_transfer && cargo test -p freshell-agent-runtime opencode_transfer && cargo test -p freshell-session-host opencode_transfer`

Expected: PASS for backward-compatible protocol round trips, atomic import, exact graph verification, idempotency/conflict handling, and pre-spawn gating.

- [ ] **Step 5: Refactor while green**

Consolidate manifest verification so the importer and recovery probe share one structural contract while each opens its own read-only DB connection. Make staged-bundle retention/restart cleanup refer to the durable transfer and import generations. Remove the staged copy only after the installed receipt has been durably reverified and no prepared retry references it. Re-run all focused tests.

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
- Modify: `extensions/opencode/freshell-rebind-plugin.ts`
- Modify: `docs/development/runtime-provider-capabilities.json`
- Modify: `test/unit/extensions/opencode-rebind-plugin.test.ts`
- Modify: focused agent-runtime and session-host tests

**Interfaces:**
- Consumes: requested ID, import receipt/manifest digest, exact root ID, and the exact expected last root-message IDs from the immutable baseline.
- Produces: distinct requested, imported, and observed identity evidence. `ImportedVerified` means every baseline row and dependency matches before spawn. `ProviderObserved` means the Freshell plugin running inside the OpenCode TUI sees the exact session object and expected root-history tail message IDs in hydrated TUI state and emits an incarnation-correlated receipt. OpenCode has no history-loaded event, per-session completion flag, or structured load error. The plugin must treat a missing/mismatched tail, route exit, or timeout as blocked; its tail observation does not claim the TUI loaded older pages or prove the full graph. The independent pre-spawn manifest does that. The current route-only signal is not adoption evidence. Do not rely on process liveness or a second database probe. Input and restored-success wait for `ProviderObserved`; failures remain contextual and do not add persistent readiness UI.

- [ ] **Step 1: Write failing readiness and identity tests**

Extend the OpenCode probe tests: exact session row alone is not imported-verified; missing child/message/part/event/asset rows block; full baseline match is imported-verified. Exercise typed transition cases for ordered append/contiguous sequence, in-flight assistant/shell completion, metadata/counters, context epoch, todo/input transitions, compaction, and exact revert boundary; missing pre-boundary rows, session deletion, sequence gap, reused IDs, and unexplained corruption block rather than becoming Ready or Lost. Add plugin tests showing route intent and argv cannot emit adoption; the signal appears only when the actual TUI state contains the exact root and expected imported tail, is bound to terminal/incarnation, and cannot be replayed from an earlier terminal. Empty state, failed message reads, navigation away, missing/mismatched tail, and timeout stay blocked. Assert no user input is accepted before the signal. Add `NativeImport` capability and durable source/import status tests.

- [ ] **Step 2: Run tests and verify the intended failure**

Run: `cargo test -p freshell-agent-runtime opencode_probe && cargo test -p freshell-session-host requested_resume_is_not_observed`

Expected: FAIL because current probe checks only `session.id`, and PTY initializes provider identity from the requested ID without a separate post-spawn adoption signal.

- [ ] **Step 3: Strengthen readiness evidence**

Make the pre-spawn importer validate every row/edge/asset against the immutable baseline and bind its format to the target image receipt. On later recovery, compare unchanged baseline rows and require a complete typed transition chain for any evolved rows: ordered unique append with contiguous sequence; completion updates linked to provider events; allowlisted metadata/context/todo/input changes; supported compaction; and explicit revert event plus boundary. A missing event, sequence gap, unexplained deletion, reused ID, or missing asset blocks; a whole-store digest replacement is not an evolution proof. A deleted exact session cannot be Ready or certified Lost from a row miss. Return distinct pending/imported/unresolved/authoritatively-absent states; never use one destination-row miss as source absence. In the Freshell TUI plugin, watch hydrated session state and emit adoption only when the exact route root, session metadata, and expected imported tail IDs are present; include terminal/incarnation nonce, native root, and baseline digest. If OpenCode returns no tail or navigates home after a load failure, report blocked on mismatch/timeout; do not claim a provider error event exists. Keep route identity, imported identity, and observed identity separate. Require `ProviderObserved` before accepting user input, but only after spawn. Declare OpenCode `NativeImport`; persist exact source locator/store, source generation/schema fingerprint, import status/result, and refresh authority so restart recovery can distinguish pending, failed, available, absent, unresolved, expired-stage, and completed imports. Legacy records with unknown source state remain blocked. An observed/requested native ID or zero dispatch count never enables a pristine replacement seed.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-agent-runtime opencode_probe && cargo test -p freshell-session-host requested_resume_is_not_observed`

Expected: PASS with complete baseline accepted pre-spawn; valid append/completion/metadata/context/todo/input/compaction/revert transitions accepted; unsupported changes, missing pre-boundary rows, event gaps, and deletion blocked; route-only intent rejected; exact TUI tail accepted; mismatched/timed-out launch blocked; no input before adoption or false seed/loss from unresolved source state.

- [ ] **Step 5: Refactor while green**

Factor exact closure comparison into a small value-oriented helper shared by probe and tests; keep body values absent from structured logs and probe results. Re-run focused tests.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-agent-runtime && cargo test -p freshell-session-host && cargo test -p freshell-supervisor && pnpm run test:vitest run test/unit/extensions/opencode-rebind-plugin.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS, preserving other provider probes and resume flows.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-agent-runtime crates/freshell-session-host/src/pty.rs extensions/opencode/freshell-rebind-plugin.ts test/unit/extensions/opencode-rebind-plugin.test.ts docs/development/runtime-provider-capabilities.json
git commit -m "fix(runtime): require verified OpenCode history for readiness"
```

### Task 4: Fence Materialization, Ownership, Retry, and Loss Certification

**Files:**
- Modify: `crates/freshell-supervisor/src/registry.rs`
- Modify: `crates/freshell-supervisor/src/recovery.rs`
- Modify: `crates/freshell-supervisor/src/loss_report.rs`
- Modify: `crates/freshell-supervisor/src/loss_report_tests.rs`
- Modify: supervisor registry/recovery tests

**Interfaces:**
- Consumes: a captured durable tuple of control epoch, intent revision, identity revision, evidence/import revision, active incarnation, recovery attempt, exact native identity, and source/import generation, as applicable.
- Produces: every participating write rejects stale observations by a SQLite compare-and-set in the same transaction that writes the result. A loss certificate is possible only for a previously verified materialized identity when the complete declared source inventory is authoritatively absent and the commit still matches the captured tuple. Pending first import, available, unresolved, unreadable, unsupported, expired stage, partial import, or legacy-unknown source state remains retryable/blocked.
- Source ownership is keyed by `(provider, stable source-store identity, native root)` in a durable origin-owner table, separate from per-incarnation writer claims. Only one soul may prepare or commit adoption for an origin. Schema migration must not guess a winner: backfill claims only for unambiguous existing origins, leave duplicate roots explicitly unclaimed/ambiguous, and preserve both soul rows until the exact repair resolves them from permitted metadata. Do not use age, lexical IDs, or row order. Ambiguous metadata blocks restoration and preserves both rows.

- [ ] **Step 1: Write failing loss-fence and ownership tests**

Add tests proving `Allocated`/`Materializing` souls cannot be Lost; every pending/available/unresolved `NativeImport` state blocks loss; `Path::exists`-style I/O errors cannot become absence; a late source/import/identity write invalidates an old loss certificate; only a complete absent source inventory can certify loss; and an observed/requested ID can never become a pristine seed from a stale `never_dispatched` snapshot. Race two destination stores for one origin key and assert one durable owner; retire the other incarnation without deleting the winner's origin claim. Test explicit legacy-unknown state and repeated/reordered refreshes.

- [ ] **Step 2: Run tests and verify the intended failure**

Run: `cargo test -p freshell-supervisor materializing_cannot_be_lost && cargo test -p freshell-supervisor loss_commit_rejects_newer_materialization && cargo test -p freshell-supervisor native_id_has_one_writer`

Expected: FAIL because loss currently ignores allocation/durability state and its final commit does not compare captured native identity/evidence generation.

- [ ] **Step 3: Add a durable materialization/loss fence**

Add a shared per-soul coordinator for mutating identity/import/dispatch/recovery operations, while the durable CAS remains the correctness boundary. Capture the expected generation tuple before asynchronous work and compare it in every commit that writes identity, resume evidence, import, loss, or restore state. Stop commits its intent revision before waiting for the coordinator so it can invalidate in-flight work; destructive cleanup then revalidates the same exact incarnation. Split locked and already-locked probe helpers to avoid nested non-reentrant mutex deadlocks. Writers must check affected-row counts. Add an origin-owner table and unique transaction claim; backfill only unique legacy origins and leave duplicate roots unclaimed for the explicit repair. Persist source/import verdicts and refresh authority; a missing path/error is `Unresolved`, not `Absent`. Add OpenCode `NativeImport`; require complete authoritative source absence before loss, and a full verified baseline before durable resume readiness. Requested identity or zero dispatch alone never enables a seed.

- [ ] **Step 4: Run focused tests**

Run: `cargo test -p freshell-supervisor materializing_cannot_be_lost && cargo test -p freshell-supervisor loss_commit_rejects_newer_materialization && cargo test -p freshell-supervisor native_id_has_one_writer`

Expected: PASS for stale-writer rejection after Stop/import, deadlock-free nested probes, one source-root owner across distinct stores, blocked unknown/unresolved sources and safe pristine-seed gating, and a preserved genuine-loss path.

- [ ] **Step 5: Refactor while green**

Keep lock ordering consistent: commit Stop intent first, then acquire the per-soul coordinator for cleanup; never hold a SQLite transaction during provider I/O. Keep DB CAS as the durable fence even where the in-process coordinator applies. Ensure loss finalization, import, and cleanup compare source/identity/evidence generations. Re-run race and ownership tests repeatedly.

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
- Consumes: the seven exact Lost root mappings, all eight incident IDs/revisions, unique canonical source-root ownership, verified import receipts, and exact false artifact references.
- Produces: seven stopped/resume-ready canonical souls for seven distinct roots, with no provider process launched. The duplicate soul is retired only after its explicit views are rebound, redundant automatic views/projections are removed, and exact cleanup is settled. The operation fences cleanup of exact old incarnations and idempotently withdraws only false loss rows, outbox payloads, notice/projection references, loss-generated tombstones, and exact filesystem exports. A concurrent user action invalidates the captured revision and leaves the operation retryable.
- Withdrawal runs under one registry-owned export/retraction coordinator held from fresh authorization through every filesystem effect. Every exporter rechecks the exact current outbox/incident generation under that coordinator before writing. A durable progress record contains target IDs/generation/status/artifact names only, never a certificate or payload; startup resumes it before normal export draining. Delete the progress record after every target file/log update is synced and verified.
- For each notice with false IDs, calculate the new deterministic notice identity from its surviving incident-ID set. Remove false-only notices; rebuild mixed notices without false IDs; redirect supersession edges and outbox projections. If several sanitized notices collapse to one ID, merge profile receipts by `dismissed > acknowledged > rendered > absent`, retaining terminal suppression and the latest timestamp for the chosen state. Do not retain old false-bearing notice IDs or weaken a terminal receipt.
- Request boundary: add one authenticated batch operation such as `POST /api/runtime/soul-loss-repairs` that accepts only the exact eight `(soul_id, incident_id, expected_intent_revision)` targets and an operation idempotency key. Resolve source roots/stores server-side, reject any target-set mismatch or ambiguous owner, and return per-root import status plus final correction status. The route accepts no native filesystem path or transcript data.

- [ ] **Step 1: Write failing restore and withdrawal tests**

Add a registry/filesystem fixture with Lost souls, exact loss rows/tombstones, pending and delivered open/final export payloads, open/closed JSON plus temp files, active and rotated incident JSONL entries, lifecycle references, mixed and false-only notices, supersession chains, receipts, duplicate-root souls/views, and a concurrent stale exporter. Assert correction rejects stale revisions, ambiguous ownership, or unverified import. It always leaves canonical souls stopped and never launches a provider; a concurrent explicit user action makes the CAS fail and leaves correction retryable. Verify cleanup claims cannot signal after correction, and any issued signal must settle against the exact old handle. After correction, assert idempotency, absence of exact false evidence everywhere requested, untouched unrelated records, correct mixed-notice IDs/references/receipts, and no stale writer recreation. Merge receipts by `dismissed > acknowledged > rendered > absent` if sanitized notice IDs collide, and verify terminal suppression is not weakened. Simulate crashes after every DB/file boundary; the progress marker contains only target IDs/generations/status/artifact names and disappears after completed cleanup. Add exact duplicate-root ownership, view-rebind/delete, projection, and foreign-key/order cases.

- [ ] **Step 2: Run tests and verify the intended failure**

Run: `cargo test -p freshell-supervisor restore_lost_souls && cargo test -p freshell-supervisor withdraw_false_incident`

Expected: FAIL because Lost souls have no restore transition and incident exports/notices have no correction lifecycle.

- [ ] **Step 3: Add revisioned restore and exact incident withdrawal**

Stage the seven-root correction under one operation ID and captured identity/intent/source generations. Resolve the duplicate root owner from exact body-free source-store/root, import-receipt, soul-revision, and view metadata; never choose by age, lexical ID, or row order. If that evidence has no unique owner, stop before mutation and request the user's choice. Persist a cleanup generation that makes an old worker recheck before signaling; if its signal already went out, wait for the exact old handle to settle. Import and verify each distinct root once into its single canonical soul-owned provider volume without starting an agent. Identical existing rows are no-ops; any conflicting unreceipted content blocks rather than being overwritten. Do not begin false-record withdrawal until all seven import receipts are independently revalidated. In one CAS transaction, mark canonical souls verified, resume-ready, and stopped; rebind explicit views from the duplicate to the canonical owner, keep at most one automatic view per root, remove redundant duplicate automatic views, then remove the duplicate soul only after its view/projection/cleanup references are settled. Remove the exact eight false loss rows/outbox certificate payloads and only their loss-generated tombstones, and enqueue durable ID-only withdrawal progress.

Rebuild only notices whose incident sets intersect the false IDs, redirect supersession edges, and remove false-only notices. If sanitized notice identities collide, merge receipts using the tested `dismissed > acknowledged > rendered > absent` rule, so terminal suppression is never weakened and no obsolete false-bearing notice ID remains. Under the registry-owned export/retraction coordinator, remove exact open/closed JSON and target temp files; filter exact incident IDs from active and rotated `incidents.jsonl`; and remove exact lifecycle events that name those incidents from active and rotated lifecycle logs. Exporters re-read the outbox event and correction generation immediately before file effects and hold the coordinator through file sync and acknowledgement. A durable progress marker is committed before file cleanup and contains only target IDs, generations, status, and artifact names. On restart, retry that exact cleanup before normal export draining. Preserve every unrelated valid record; match structured incident IDs exactly, never by substring. Sync changed files and parent directories before clearing progress. A malformed JSONL record that cannot be classified without risking unrelated data keeps correction pending. Never retain false certificates or backup copies after successful correction.

- [ ] **Step 4: Run focused tests**

Run: `cargo test -p freshell-supervisor restore_lost_souls && cargo test -p freshell-supervisor withdraw_false_incident`

Expected: PASS for stopped/resume-ready repair, one-owner safety, duplicate view/soul cleanup, stale-cleanup fencing, crash-retryable exact withdrawal, safe receipt collision handling, serialized exporter/lifecycle-log updates, and absence of false artifacts without touching unrelated incidents or concurrent user intent.

- [ ] **Step 5: Refactor while green**

Consolidate exact-ID selection, receipt merge, progress recovery, and serialized export-file mutation. Keep ordinary true-loss export behavior unchanged. Re-run stale-exporter, malformed/partial JSONL, crash-retry, duplicate-view, and mixed-notice tests.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-supervisor && cargo test -p freshell-server`

Expected: PASS, including true-loss notices, summary APIs, cleanup retry, batch route auth/idempotency, duplicate-view migration, and stopped-ready projections.

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
- Produces: automated proof that a fresh soul imports and verifies a complete synthetic conversation before spawn, receives the TUI-tail observation before accepting input, appends a synthetic turn under the same ID, and reopens without losing its full imported baseline; a body-free production correction runbook that imports seven distinct roots, retires the duplicate soul, leaves canonical souls stopped/resume-ready, and withdraws false incidents after PR merge and the separately approved restart.

- [ ] **Step 1: Write the failing managed-runtime continuity scenario**

Extend the existing managed OpenCode resurrection spec with an isolated host source DB and empty soul provider volume. Seed a synthetic root plus descendants, ordered messages, linked parts, and an unrelated session. Assert source snapshot/import/independent full-baseline verification precede PTY spawn, and the post-spawn plugin observation of the exact TUI session plus expected imported tail precedes user input or restored success. The plugin signal must fail closed on empty/missing/mismatched tail or navigation away; it does not claim to prove older pages were loaded. Read all expected synthetic history through the provider contract, send a synthetic follow-up, and assert new rows append under the same root ID while every imported baseline row and required asset remains. Simulate an interrupted partial transfer, unresolved source, incompatible target artifact, provider rejection, stale loss/cleanup results, duplicate-root contention, and correction restart; assert none creates a Lost view, false incident export, or second writer. Retain the positive test that only a complete authoritative absence can be lost.

- [ ] **Step 2: Run the focused test and verify the intended failure**

Run: `FRESHELL_TEST_SUMMARY='managed OpenCode source-to-soul resume' GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e:cloud --project=rust-chromium --grep='managed OpenCode source-to-soul resume' test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts`

Expected: FAIL because the current launch does not transfer host-side native history or independently observe provider adoption.

- [ ] **Step 3: Complete synthetic E2E wiring and prepare the correction runbook**

Implement only synthetic harness integration needed to drive production interfaces. Run the E2E until it proves full imported-baseline verification, TUI-tail observation, full synthetic-history continuity, gated input, append/reopen, supported transition validation, stopped/resume-ready repair, duplicate soul/view retirement, and exact artifact withdrawal. Prepare the post-merge runbook in two phases: first perform a read-only body-free preflight after merge and before requesting restart approval (exact target mapping, source/target fingerprints, closure counts/size/digests, referenced-asset availability, canonical owner, notices, receipts, and artifact locations); then, only after exact `APPROVED`, restart/deploy and apply the already-reviewed batch correction. The preflight must not inspect transcript bodies or mutate data. Do not inspect real session state in this synthetic task, and never send a test prompt to a real conversation. Any later repair receipt may contain only target IDs, graph counts, digests, revision/status codes, and completion status; it must not retain transcript bodies, false certificates, or obsolete incident exports.

- [ ] **Step 4: Run the synthetic E2E verification**

Run: `FRESHELL_TEST_SUMMARY='managed OpenCode source-to-soul resume cloud' GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e:cloud --project=rust-chromium --grep='managed OpenCode source-to-soul resume' test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts`

Expected: PASS for synthetic exact-history import, pre-spawn verification, exact TUI-tail observation, gated input, append/reopen, fail-closed partial transfer, stale cleanup/export fencing, stopped/resume-ready correction, and false-loss prevention. The runbook contains no real session contents or incident exports.

- [ ] **Step 5: Refactor while green**

Remove temporary test-only hooks and duplicated fixture setup. Confirm false incident cleanup uses only the exact verified target set, is idempotent, never starts the seven souls automatically, and leaves them stopped/resume-ready. Re-run the configured cloud E2E and inspect the runbook for exact restart and data-restoration gates.

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
- [ ] Synthetic coverage proves exact import, TUI-tail provider observation, append/reopen, single-origin ownership across different destination stores, fail-closed source/asset/artifact handling, stopped/resume-ready repair, duplicate soul/view retirement, and exact false-incident withdrawal while preserving unrelated notices and concurrent user intent.
- [ ] Incomplete or unresolved source transfer cannot launch or become Lost; a truly absent complete source inventory can still follow existing true-loss behavior.
- [ ] The full supported suite and affected E2E coverage pass; whole-branch and final delta reviews have no unresolved must-fix findings.
- [ ] Open and merge the authorized PR targeting `main`, wait for required checks, merge, fast-forward local `main`, and clean up the feature worktree per repository instructions.
- [ ] **Post-merge live restoration (separate approval gate):** first, while the old service is still running, perform the authorized body-free read-only preflight and report the exact seven-root/eight-incident mapping, source/target fingerprints, closure counts/size/digests, asset availability, canonical duplicate owner, notice/receipt collisions, and artifact locations. Do not write or restart. Then request the exact word `APPROVED`. Only after it arrives, restart/deploy the merged code, import each distinct root into its canonical soul, independently verify all rows/assets, and keep every soul stopped. If any mapping or artifact is ambiguous, stop before mutation and ask the user for the one needed decision. Only after all seven receipts verify, retire the duplicate soul/views and withdraw the eight exact false incidents, notice/outbox references, JSON/JSONL exports, and lifecycle entries. Verify unrelated incidents/notices remain and remove the temporary withdrawal-progress marker. PR merge alone is not completion of the data repair.
