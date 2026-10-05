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
- The transfer boundary applies only to what is copied from the host store. Repaired managed OpenCode keeps the same provider configuration, OneCLI secret access, MCP access, and other features as a non-managed OpenCode session. A zero-message native root is adoptable only if fresh TUI state shows the exact session and a qualified error-aware provider messages read confirms that exact root is successfully empty; otherwise it remains blocked.

**Goal:** Managed OpenCode can resume the exact pre-existing native conversation with its required history. Failed or incomplete first materialization remains retryable and cannot be declared lost. The seven repaired souls remain stopped and resume-ready; this correction does not start seven agents or override any existing stopped state.

**Architecture:** Resolve the selected host OpenCode store through the trusted session inventory, including its effective `OPENCODE_DB` or installation-channel path; zero or multiple exact-root matches are unresolved. Use a committed SQLite snapshot only as a private host-local extraction intermediate, then construct a new bundle containing only the selected native session graph and required assets. Never send the whole host database, unrelated roots, or account/credential/configuration tables through supervisor staging. This transfer-only boundary does not limit provider capabilities in the managed session. Copy only assets whose pinned-provider semantics make them immutable or whose exact bytes can be verified and mapped; block unsupported or mutable references rather than treating pre/post-copy stability as proof of snapshot consistency. The supervisor owns a durable private staging bundle and exposes it read-only to the trusted session host through an exact per-launch mount. Send bounded bundle chunks through dedicated authenticated history-transfer commands over the existing supervisor Unix socket; never place session bodies in the launch descriptor, registry, or logs. Bind the source schema fingerprint and target image/build receipt before importing, and never run migrations against the host source. Independently verify every imported row and asset before PTY spawn. Keep the import-baseline manifest immutable while accepting only identified provider changes. On each launch, verify the current destination state against that baseline and the supported transition chain, then derive the expected root-message tail from that current verified generation. OpenCode emits no history-loaded event, so post-spawn adoption is a separate Freshell plugin observation: the exact root and current tail must appear in fresh hydrated TUI state, correlated to this terminal incarnation and the generation verified when the observation is accepted; route intent, argv, process liveness, cached/request-only state, and a database row alone do not qualify. If the destination changes before input is released, reverify it and require a fresh matching TUI observation; timeout or mismatch stays blocked. The tail observation confirms the displayed current tail, while the full manifest and transition verifier prove the native graph. Persist source/import state and fence identity, dispatch, stop, loss, restore, export, and cleanup writes with durable generations. Repair the seven souls as stopped and resume-ready, choose one transcript-free canonical owner for the duplicate root from exact durable metadata, and withdraw only the eight false-loss incidents and their dependent artifacts after structural and provider-reader verification.

**Tech Stack:** Rust workspace crates, SQLite/rusqlite, serde protocol messages, Tokio session-host lifecycle, fake OpenCode integration fixtures, Vitest helper tests, and Playwright managed-runtime coverage.

## Global Constraints

- Work only in `/home/dan/code/freshell/.worktrees/managed-opencode-session-recovery` on `the-usual/managed-opencode-session-recovery`, based on `origin/main` `922a9241533d409cedfd323f1585eddf908848bd`; keep the primary checkout untouched.
- Use pnpm 10.34.5 with the committed lockfile. Follow `scripts/base-gate.sh`, the test coordinator, cloud backend configuration, and repo test-sandbox rules for the relevant test levels.
- Run process-kill, crash/restart, and config-corruption fault injection only through `scripts/sandbox-test.sh` in disposable Docker storage; never target the host provider store or live Freshell service.
- Use red-green-refactor for each behavior change. Add tests that fail for the missing behavior, preserve existing coverage, run impacted tests and the full supported gate, and commit each accepted task.
- Keep the history-transfer payload separate from provider configuration, credentials, bootstrap files, and control-frame metadata; this does not restrict what the managed provider can access. Resolve source identity on the trusted host from the selected provider store; never accept an arbitrary filesystem path from the client.
- Resolve the exact source store from the trusted host session inventory, honoring `OPENCODE_DB` and installation-channel paths. Never accept a client-supplied path. Zero/multiple matching stores, unreadable paths, permission errors, broken links, unsupported schema, and unavailable assets are unresolved, never absent. Do not migrate or write the host database.
- Bind imports to a source schema/DDL and migration-journal fingerprint plus the target OpenCode package version and immutable runtime image/build receipt. Support only source/target pairs covered by the versioned importer and disposable reopen/append qualification; reject unknown pairs. Any migration is performed only on the staged copy/destination, never on the original host database.
- Keep the import-time baseline immutable and row-keyed. Later recovery must verify all unchanged imported rows/edges/assets and accept changes only through typed OpenCode transitions: unique ordered appends with contiguous event sequences; completion updates tied to their provider events; allowlisted metadata/counter, context-epoch, todo, and pending-input changes; supported compaction boundaries; and reverts tied to an exact revert event/boundary with no pre-boundary row loss. Missing/deleted baseline state without a durable supported transition is `Blocked`, never `Ready` or `Lost`. A deleted session is not recoverable; do not infer user deletion from a missing row. A later changed host source is not re-imported over an evolved soul by timestamp or last-writer-wins.
- Preserve the exact recursive root/descendant graph, native IDs, row relationships/order, timestamps, and opaque provider values. The pinned built-in closure includes session, project, workspace, project-directory, permission, message, part, event-sequence, event, v2 session-message, pending-input, context-epoch, and todo rows. An unrecognized schema, table, relationship, URI, or plugin-owned dependency blocks the transfer rather than being silently omitted.
- Preserve inline `data:` content exactly. Enumerate top-level and nested file parts, v1/v2 tool-output references, and snapshot/revert trees. Keep a reference at its existing path only when it is under the exact workspace mount and the referenced bytes are verified there. Resolve content-addressed snapshot/Git objects by identity; prove the alternate object store is available at the same managed path or stage the complete required object closure. Copy tool-output files only when the pinned writer uses write-once paths; apply an explicit typed mapping to supported provider fields. Reject arbitrary/opaque file references, unknown URI schemes, and unsupported plugin data. Keep arbitrary opaque provider fields unchanged. Record per-row and per-asset digests in an immutable import baseline.
- The consistent SQLite Online Backup is a private host-local extraction intermediate, never the transmitted bundle or supervisor spool. From it, serialize a new exact-session representation containing only allowlisted native session-graph rows and their validated required assets. Exclude unrelated roots and account, credential, and provider-configuration tables/values; if the selected native closure depends on unsupported data, block instead of transferring it. Carry source DDL/migration and SQLite-version fingerprints as bounded metadata only. Do not prune a full backup and send it, because deleted pages or WAL content could retain excluded values. Keep the intermediate in a restricted temporary location, remove its exact database/WAL/SHM files after extraction, and sweep only abandoned intermediates from that location on recovery. External bytes must be immutable by provider contract/content address, or the transfer is unresolved; matching metadata before and after a mutable copy is not sufficient to bind it to the database snapshot. Hash each staged and installed byte. Bound each exact-session bundle to 8 GiB, stream in chunks no larger than 256 KiB, cap persistent staging at 16 GiB, and check available space before install. Queue transfers that exceed current aggregate capacity and fail before install if a per-bundle bound is exceeded. The manifest digest is the generation used for retries and ownership.
- Do not modify unrelated runtime records or delete the only recoverable copy. Remove the exact false-loss rows, outbox payloads, notice references, incident exports, and exact lifecycle-log records only after all seven destinations pass both full imported-baseline verification and a body-free provider-reader/access check for the installed generation under the actual provider UID, HOME/XDG, `OPENCODE_DB`, cwd, and mounts. This stopped-state repair check must not launch an agent or send a prompt. Preserve `desired_state=stopped`; the correction never starts a provider, and the user can resume each soul explicitly after repair. Preserve unrelated notices/incidents and any later intent through revision checks. A later explicit launch separately requires `ProviderObserved` before accepting input.
- Finish implementation, verification, review, and the authorized PR before any production restoration. Do not restart the self-hosted Freshell server without the exact approval word `APPROVED`. Any live data correction is limited to the seven verified sessions and their eight exact false-loss records, and occurs only after source and destination continuity are proven.
- Every PR targets `main`; wait for required checks and merge through the PR, then fast-forward local `main` from `origin/main`.

---

## File Responsibilities and Interfaces

The adversarial review rejected the claim that the missing transfer alone explains every past exit. It established a missing host-to-soul history handoff and eight false-loss records across seven roots, including a duplicate root; the full causal attribution remains unproven. Stage 2 fixed the pinned built-in row closure and identified the source, asset, staging, compatibility, readiness, and correction-publication checks below. Disposable runtime behavior must be proven before any live repair.

- `crates/freshell-runtime-protocol/src/lib.rs`: versioned OpenCode transfer descriptor and receipt metadata only: source-store identity, transfer ID/generation, manifest digest, target root, and state. Never place transcript rows, bodies, credentials, or an unbounded payload in launch/control metadata.
- A native history module under `crates/freshell-sessions/` or the selected SQLite-owning crate: resolve the exact store from trusted session discovery, bind its source schema/migration fingerprint, take a consistent SQLite Online Backup snapshot including committed WAL state as a private host-local extraction intermediate, export only the exact native closure and supported typed assets into a new exact-session bundle, and remove the intermediate after extraction/recovery cleanup without modifying the source.
- `crates/freshell-server/src/managed_runtime.rs` plus the supervisor staging/control path: use dedicated authenticated begin/chunk/finalize history-transfer commands over the existing supervisor Unix socket. Each chunk is at most 256 KiB (below the 1 MiB frame cap); each bundle is at most 8 GiB and the persistent spool at most 16 GiB, with backpressure, digest, quota, and free-space checks. Never log chunk content or place it in the launch descriptor or registry. The supervisor retains the bundle across retries, then mounts only that bundle read-only into the exact incarnation. Verify the session host UID can read the mount and the provider UID cannot read staging, in the actual Docker namespace mode used by managed runtimes. Do not mount the host-wide OpenCode data directory or reuse the writable runtime directory containing the control socket/secrets as the history mount.
- `crates/freshell-session-host/src/main.rs`: verify the staged bundle, install assets and rows idempotently into the soul-owned provider store, re-read and compare the full baseline, persist a receipt, and only then permit PTY spawn. Incomplete transfer remains blocked/retryable.
- `crates/freshell-agent-runtime/src/lib.rs`, `crates/freshell-session-host/src/pty.rs`, `extensions/opencode/freshell-rebind-plugin.ts`, and `docs/development/runtime-provider-capabilities.json`: keep requested, imported, repair-verified, and observed identities distinct. OpenCode 1.18.21 has no history-loaded event/error receipt; the plugin observes the exact session object and current root-message tail in fresh hydrated TUI state, and reports timeout/navigation failure as blocked. The expectation comes from a full current-destination verification against the immutable import baseline plus supported transitions and is bound to that destination evidence generation and incarnation. A changed tail/generation requires re-verification and a fresh matching observation before input. For an empty root, require both exact-session presence in fresh TUI state and a qualified error-aware provider messages read that confirms this root is empty; the qualification must prove read errors cannot be represented as successful empty history. Otherwise block. This is post-spawn adoption evidence for the displayed current tail, not a substitute for the full pre-spawn manifest check or the stopped repair reader check. Route-only, cached, or request-only signals never count. Gate accepted input on correlated `ProviderObserved`; stopped repair completion does not require a running provider observation.
- `crates/freshell-supervisor/src/registry.rs`, `recovery.rs`, `loss_report.rs`, `loss_report_tests.rs`, and notice/outbox/export helpers: persist source/import phases and generations; CAS-fence identity, dispatch, stop, loss, and restore writes; restore Lost souls as stopped/resume-ready; enforce one source-root owner across destination stores; and withdraw exact false incidents without stale exporters recreating artifacts.
- Session-host, agent-runtime, and supervisor tests plus `test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts`: prove exact handoff, failure/retry, provider adoption, single ownership, stopped-ready restoration, and future writes under the same native session ID.
- `test/unit/tooling/testing/provider-native-history.test.ts` and the fake OpenCode fixtures: model the pinned native schema (including both legacy and v2 rows), recursive descendants, references, WAL snapshot behavior, and asset closure without real conversation bodies.

The transfer interface is bounded metadata plus authenticated begin/chunk/finalize commands over the supervisor Unix socket into durable staging. Each chunk is at most 256 KiB, each exact-session bundle at most 8 GiB, and the persistent spool at most 16 GiB; capacity pressure queues work. Its manifest binds the unique resolved source store, source DDL/migration and SQLite-version fingerprints, selected native rows, typed external assets, destination store/root, target image/build receipt, and import generation. It never contains a full host database or unrelated account/credential/configuration values. The importer checks quota/free space and rehashes staging and installed bytes after restart. It publishes assets write-once before the native-row transaction and never replaces conflicting content. A crash can leave only blocked, revalidatable staging/assets or a committed DB plus an absent receipt; no such state is ready, and retry reconstructs/compares the receipt from bytes. The immutable import baseline remains separate from verified legitimate provider evolution. For stopped correction, an `InstalledStoreReadable` receipt comes only from a body-free read-only native-reader probe qualified against the pinned OpenCode build and run with the actual provider UID, HOME/XDG, `OPENCODE_DB`, cwd, and mounts against the exact installed generation. It must open the provider-selected DB and traverse the imported graph/assets without returning message bodies or launching an agent; inability to make that exact check leaves repair pending. `DataRepairComplete` means structural baseline verification plus that reader/access receipt and the exact correction CAS. It is distinct from `ProviderObserved`, which is generated only after a later explicit launch and is required before input. Pre-spawn full-manifest verification, stopped provider-reader verification, and post-spawn TUI tail observation are separate phases. Every participating supervisor write captures and compares the required intent, identity, evidence, active-incarnation, attempt, and import generations; provider bytes have their own manifest fence. Restoration and incident withdrawal stay retryable across process restart, and every stale worker rechecks authorization immediately before its side effect.

## Tasks

### Task 1: Lossless, Exact-Session OpenCode Snapshot and Manifest

**Files:**
- Create: `crates/freshell-sessions/src/opencode_transfer.rs` (or the SQLite-owning module selected by the load-bearing stage)
- Modify: `crates/freshell-sessions/src/lib.rs` and its Cargo manifest only if the selected module requires an existing workspace dependency adjustment
- Test: `crates/freshell-sessions/tests/opencode_native_transfer.rs`
- Test: `test/unit/tooling/testing/provider-native-history.test.ts`
- Modify: `test/e2e-browser/fixtures/fake-opencode.cjs` only to add missing deterministic schema behavior needed by the test

**Interfaces:**
- Consumes: exact root native session ID and the effective OpenCode source resolver on the trusted host. Honor `OPENCODE_DB` and installation-channel path selection; never accept an arbitrary source path from a client. The full SQLite Online Backup is only a private local extraction intermediate.
- Produces: a versioned exact-session bundle and manifest for the root and descendants. Include `session`, referenced `project`/`workspace`/`project_directory`/`permission`, `message`, `part`, `event_sequence`, `event`, `session_message`, `session_input`, `session_context_epoch`, and `todo` rows, plus validated referenced assets. Preserve IDs, opaque data, ordering, relationships, and sequence values. Reject an invalid root parent, dangling reference, unrecognized source DDL/table, unsupported plugin data, or external reference that cannot be captured and mapped.
- Read the source through SQLite Online Backup from one committed snapshot including visible WAL state; the host DB is never opened by a mutating provider or migrated. Use that full backup only in a private host-local temporary location to extract the selected native closure into a new exact-session representation. Never prune and transmit the full backup or its WAL. Record source schema, migration-journal and SQLite-version fingerprints as bounded metadata. Include only allowlisted session-graph rows and required assets; exclude unrelated roots and account/credential/provider-configuration tables. If a required dependency is outside the supported closure, block. Assets enter the bundle only under pinned-provider write-once/content-addressed semantics; copy and hash them into a content-addressed immutable bundle. Snapshot trees must resolve against the exact Git object store identity; require that store at the same managed path or stage its complete reachable closure. Typed tool-output path fields may be remapped only through an explicit reversible manifest mapping; arbitrary opaque fields remain unchanged. Mutable or unclassified files are unresolved even if pre/post-copy metadata happens to match. Remove the exact local backup and SQLite sidecars after extraction and on recovery from an interrupted extraction.

- [x] **Step 1: Write failing synthetic behavior tests**

Create a synthetic pinned-schema DB with a root, child, grandchild, unrelated root, v1 and v2 message/event rows, pending input, context epoch, todo, project/workspace/directory/permission dependencies, a `message_seq` table matching the host-census mention, and sentinel opaque values. Resolve the `message_seq` discrepancy against the pinned source DDL before accepting the compatibility matrix: classify it explicitly as a supported dependency or a known unrelated/derived table with a test proving safe omission. Add separate unrelated account/credential/configuration tables with unique sentinel values. Assert exact closure/order, no unrelated session or account/credential/configuration value in the decoded serialized bundle or any begin/chunk/finalize payload, preserved IDs/edges/opaque values, committed WAL visibility, uncommitted-write exclusion, and no logical source changes. Test trusted store resolution through discovered `OPENCODE_DB` and channel paths; duplicate IDs across stores are ambiguous, while permission errors, broken links, and malformed paths are unresolved rather than absent. Add inline data, write-once tool-output files, content-addressed snapshot trees with and without an accessible alternate object store, unsupported URI/plugin/schema cases, missing assets, and a mutable/unclassified file; unresolved cases must return Blocked without publishing a bundle. Assert the full SQLite backup and its WAL/SHM sidecars are not copied into supervisor staging and are removed after successful and interrupted extraction recovery. Keep all fixtures synthetic.

- [x] **Step 2: Run the new tests and verify the intended failure**

Run: `cargo test -p freshell-sessions --test opencode_native_transfer`

Expected: FAIL because no lossless exact-session snapshot/manifest API exists yet.

- [x] **Step 3: Add the snapshot exporter and manifest**

Resolve one unique trusted source store, verify its effective path and source schema fingerprint against the supported version matrix, and take a SQLite Online Backup snapshot in a private host-local extraction directory. Traverse the root and recursive descendants and validate the complete v1/v2/project dependency closure. Reconcile the reported `message_seq` table with the exact source DDL and encode its explicit classification in the supported schema matrix; do not waive unknown-table blocking based on the name alone. Serialize only those allowlisted rows and validated required assets into a new exact-session bundle; never copy/prune the full backup into the payload. Exclude unrelated session and account/credential/configuration data, and keep schema/migration fingerprints as metadata. Enumerate typed file and snapshot references; accept only write-once or content-addressed assets and verify the required Git object store or stage its complete reachable closure. Preserve native IDs and opaque payload fields; record reversible mappings only for recognized typed paths. Produce deterministic per-row/per-asset digests and a bundle generation, then remove the local extraction intermediate and its sidecars. Return `Blocked` for ambiguous source selection, unsafe links, unknown migration state, unsupported schema/reference, missing asset/object, mutable/unclassified external bytes, quota/free-space limit, or any incomplete edge; never reinterpret those states as source absence.

- [x] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-sessions --test opencode_native_transfer`

Expected: PASS, including WAL snapshot semantics, full native closure, asset mapping, source logical immutability, unrelated-session exclusion, opaque-data preservation, and blocked incomplete/unstable sources.

- [x] **Step 5: Refactor while green**

Extract reusable SQLite snapshot/manifest helpers only where they reduce duplication with existing provider-history readers. Keep the native transfer payload independent from the bounded transcript projection helper. Re-run the focused test after refactoring.

- [x] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-sessions`

Expected: PASS for OpenCode discovery, exact session tree relationships, and the new export contract.

- [x] **Step 7: Commit the task**

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
- Produces: an idempotent `ImportReceipt` proving the source snapshot's exact imported baseline is present in the destination, followed by a distinct `InstalledStoreReadable` receipt. The latter comes from a body-free, read-only native-reader probe qualified against the pinned OpenCode build and run against the exact installed generation under the actual provider UID, HOME/XDG, `OPENCODE_DB`, cwd, and relevant mounts. It must open the provider-selected destination DB and traverse the imported graph and required assets without returning message bodies or launching an agent. If that exact read check is unavailable or fails, the import remains blocked/retryable and cannot launch. Neither receipt claims that OpenCode has adopted the root.
- Mount/lifetime: enforce an 8 GiB per-bundle ceiling, aggregate staging quota, and free-space check before install. The supervisor verifies the bundle and mounts only its exact directory read-only into the session-host container. In the actual managed Docker namespace mode, prove root session-host access and provider-UID denial. Do not use the 16 MiB private tmpfs, the writable runtime directory, the host-wide provider store, or a control frame for bundle bytes. Keep staged bytes until the durable import receipt is independently revalidated; on startup, revalidate or resume every referenced transfer before removing it.

- [x] **Step 1: Write failing protocol, import, and launch-order tests**

- Add protocol tests for an OpenCode-only transfer descriptor with exact provider/source/destination/root/incarnation binding, source schema fingerprint, target artifact receipt, and bounded metadata. Add streaming tests for chunk ordering, backpressure, digest mismatch, interruption/retry, queueing at the 16 GiB spool limit, free-space rejection, 8 GiB per-bundle bound, and no chunk larger than 256 KiB. Add mount-plan and disposable Docker tests in the managed runtime's actual namespace mode proving the exact staged directory is read-only, readable by the session-host UID, unavailable to the provider UID, and unrelated provider data is not mounted. Add destination tests for atomic DB rollback, idempotent identical transfer, conflict rejection, exact native graph/asset mapping, and destination path agreement with the managed `OPENCODE_DB`/XDG configuration. Exercise the `InstalledStoreReadable` probe with the actual provider UID and environment: root-level structural verification must not be sufficient when that identity cannot read the installed DB or any required asset. Assert the probe returns no bodies and launches no provider. Inject process crashes after each applicable staged file write/sync/rename, native DB transaction, host receipt/state publication, registry readiness commit, and immediately before PTY spawn; every restart must reconstruct or reject state without Ready or overwrite. The supported bundle stores workspace-file and Git-tree assets as references that are rehashed in place; it has no separate asset-publication operation, so test the actual referenced asset through import and provider-identity reads instead. Task 3 owns later typed history evolution tests (append, completion, metadata/context/todo/input updates, compaction, and revert boundaries). Never run the provider on the host source. The grant-handler event log must show `stage -> verify stage -> import transaction -> structural verify -> provider-identity reader verify -> durable receipts -> PTY spawn`; no spawn for partial, unsupported, missing, unstable, incompatible, unreadable, or conflicting input.

- [x] **Step 2: Run the focused tests and verify the intended failure**

Run: `cargo test -p freshell-runtime-protocol opencode_session_transfer && cargo test -p freshell-session-host opencode_transfer`

Expected: FAIL because the typed transfer reference, atomic importer, and pre-spawn ordering do not exist.

- [x] **Step 3: Add typed handoff, importer, and pre-spawn integration**

Add optional serde-compatible transfer metadata to the launch spec and persist only its descriptor. Stream chunks into a dedicated supervisor-owned persistent staging path with the 256 KiB chunk and 8 GiB bundle bounds, quota/free-space checks, and content digest; bind it to transfer ID, unique source-store identity/schema, root, destination, target image receipt, and incarnation. Expose exactly that staged bundle read-only to the trusted session host and verify the actual UID/mount behavior. Validate supported workspace/Git asset references and their digests in place; no separate asset file is published. Then insert native rows in one destination transaction without overwriting conflicting IDs. Independently compare every row and referenced asset from a read-only connection, durably publish a local receipt, and only then permit PTY spawn and registry readiness. If a crash follows the DB commit but precedes the receipt, reconstruct a receipt only after a full rehash and structural compare; if any state differs, remain blocked. On every retry or restart, rehash staging and installed data before trusting the receipt. A same-generation retry is a verified no-op; a changed or conflicting generation blocks. Never use `ProviderBootstrapFile`, `ProviderConfigReference`, transcript projections, or a control frame for history bytes.

- [x] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-runtime-protocol opencode_session_transfer && cargo test -p freshell-agent-runtime opencode_transfer && cargo test -p freshell-session-host opencode_transfer`

Expected: PASS for backward-compatible protocol round trips, atomic import, exact graph verification, idempotency/conflict handling, provider-identity native-reader access, and pre-spawn gating.

- [x] **Step 5: Refactor while green**

Consolidate manifest verification so the importer and recovery probe share one structural contract while each opens its own read-only DB connection. Make staged-bundle retention/restart cleanup refer to the durable transfer and import generations. Remove the staged copy only after the installed receipt has been durably reverified and no prepared retry references it. Re-run all focused tests.

- [x] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-runtime-protocol && cargo test -p freshell-agent-runtime && cargo test -p freshell-session-host && cargo test -p freshell-server`

Expected: PASS for launch protocol compatibility, provider preparation, exact resume argument behavior, and server launch construction.

- [x] **Step 7: Commit the task**

```bash
git add crates/freshell-runtime-protocol crates/freshell-server/src/managed_runtime.rs crates/freshell-supervisor/src/backend.rs crates/freshell-session-host crates/freshell-agent-runtime
git commit -m "feat(runtime): import OpenCode history before managed launch"
```

### Task 3: Separate Verified Import from Provider Adoption

**Files:**
- Modify: `crates/freshell-agent-runtime/src/lib.rs` and `opencode_transfer.rs`
- Modify: `crates/freshell-runtime-protocol/src/lib.rs` for launch and observation evidence
- Modify: `crates/freshell-session-host/src/main.rs` and `pty.rs` for receipt handling and input gating
- Modify: `crates/freshell-supervisor/src/recovery.rs` and `resume_catalog.rs` for current-generation verification and adoption gating
- Modify: `extensions/opencode/freshell-rebind-plugin.ts`
- Modify: `docs/development/runtime-provider-capabilities.json`
- Modify: `test/unit/extensions/opencode-rebind-plugin.test.ts`
- Modify: focused agent-runtime and session-host tests

**Interfaces:**
- Consumes: requested ID, immutable import receipt/manifest digest, exact root ID, and the expected current root-message tail derived from a fresh full-destination verification against the immutable baseline and supported transition chain. Bind the tail to a durable destination evidence generation and this launch's incarnation nonce; do not reuse the import-time tail on later launches.
- Produces: distinct requested, imported, repair-verified, and observed identity evidence. `ImportedVerified` means every immutable baseline row and dependency matches before spawn. `InstalledStoreReadable` means the exact installed destination generation is readable through the qualified body-free provider native-reader probe under the actual provider identity/environment. `ProviderObserved` means the Freshell plugin running inside the OpenCode TUI reports the exact session object and current root-history tail from fresh hydrated TUI state, and the session host correlates that tail to the currently verified destination evidence generation and incarnation. OpenCode has no history-loaded event, per-session completion flag, or structured load error. The plugin must treat a missing/mismatched tail, cached/request-only state, route exit, or timeout as blocked; its tail observation does not claim the TUI loaded older pages or prove the full graph. The independent verifier does that. The current route-only signal is not adoption evidence. If the destination generation or root tail changes before input is released, re-run full destination verification, derive the new current tail, and require a fresh plugin observation for it; timeout or mismatch remains blocked. For an empty root, require a qualified successful provider read that distinguishes a loaded empty history from a failed read; otherwise block. Do not rely on process liveness as proof. Stopped data repair completes with `ImportedVerified` plus `InstalledStoreReadable` and the exact correction CAS; it does not require a running `ProviderObserved`. A later explicit launch requires `ProviderObserved` before accepting input. Failures remain contextual and do not add persistent readiness UI.

- [x] **Step 1: Write failing readiness and identity tests**

Extend the OpenCode probe tests: exact session row alone is not imported-verified; missing child/message/part/event/asset rows block; full baseline match is imported-verified. Exercise typed transition cases for ordered append/contiguous sequence, in-flight assistant/shell completion, metadata/counters, todo/input transitions, supported compaction and exact V2 revert boundary. A changed `session_context_epoch` snapshot and V1 transcript removals remain blocked because the pinned durable events do not yet witness their exact projection. Missing pre-boundary rows, session deletion, sequence gap, reused IDs, and unexplained corruption block rather than becoming Ready or Lost. Add plugin tests showing route intent and argv cannot emit adoption; the signal appears only when fresh actual TUI state contains the exact root and the current tail from the verified destination generation, is bound to terminal/incarnation, and cannot be replayed from an earlier terminal. Reopen after enough appends to move the import-time tail beyond the 100-message hydration page and after a supported revert removes that old tail; both must adopt using the newly verified current tail. Simulate a destination change between verification and observation and require re-verification plus a fresh matching plugin event. Empty state, failed message reads, navigation away, missing/mismatched tail, and timeout stay blocked; a genuinely empty root is accepted only when exact-session TUI state is fresh and the qualified error-aware messages read positively confirms empty history. Assert no user input is accepted before the signal. Add `NativeImport` capability and durable source/import status tests.

- [x] **Step 2: Run tests and verify the intended failure**

Run: `cargo test -p freshell-agent-runtime current_store_verification && cargo test -p freshell-session-host managed_opencode_adoption`

Expected: FAIL because current probe checks only `session.id`, and PTY initializes provider identity from the requested ID without a separate post-spawn adoption signal.

- [x] **Step 3: Strengthen readiness evidence**

Make the pre-spawn importer validate every row/edge/asset against the immutable baseline and bind its format to the target image receipt. Validate every baseline and current durable event against the complete pinned OpenCode v1.18.21 V1/V2 payload schema and reject unknown, wrong-version, and non-durable rows. On every later recovery, compare unchanged baseline rows and require a complete typed transition chain for any evolved rows: ordered unique append with contiguous sequence; completion updates linked to provider events; allowlisted metadata/todo/input changes; exact event-backed append-only V2 context and compaction messages; and explicit V2 revert event plus boundary. Replaying V2 session-message projections must account for the entire ordered durable suffix. A changed `session_context_epoch` snapshot, V1 transcript-removal projection, missing event, sequence gap, unexplained deletion, reused ID, or missing asset blocks; a whole-store digest replacement is not an evolution proof. Derive the expected root-message tail from this verified current destination snapshot and bind it to a durable evidence generation plus incarnation; never compare every reopen to the immutable import-time tail. The plugin reports the current exact root and tail from fresh hydrated TUI state. At receipt handling and immediately before input release, verify the destination generation still matches; if it changed, re-run full verification, derive a new current tail, and require a fresh matching plugin observation. A deleted exact session cannot be Ready or certified Lost from a row miss. Return distinct pending/imported/unresolved/authoritatively-absent states; never use one destination-row miss as source absence. If the current root has messages, positive presence of the exact current tail in fresh TUI state is sufficient for this tail-only signal; request/route echoes, stale cached state, errors, missing/mismatched tail, and timeout remain blocked. For a zero-message root, require fresh exact-session TUI state and a qualified error-aware provider messages read that confirms empty history rather than a read failure; if the pinned provider exposes no such positive result, keep it blocked. Keep route identity, imported identity, repair-readable identity, and observed identity separate. Require `ProviderObserved` before accepting user input, but only after spawn. Stopped repair readiness instead requires structural baseline verification and `InstalledStoreReadable` under the actual provider identity/environment; no provider is started for this check. Declare OpenCode `NativeImport`; persist exact source locator/store, source generation/schema fingerprint, import status/result, and refresh authority so restart recovery can distinguish pending, failed, available, absent, unresolved, expired-stage, and completed imports. Legacy records with unknown source state remain blocked. An observed/requested native ID or zero dispatch count never enables a pristine replacement seed.

- [x] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-agent-runtime current_store_verification && cargo test -p freshell-session-host managed_opencode_adoption`

Expected: PASS with complete immutable baseline accepted pre-spawn; valid append/completion/metadata/todo/input/event-backed context/compaction/V2-revert transitions accepted; changed context snapshots, unsupported V1 removals, other unsupported changes, missing pre-boundary rows, event gaps, and unexplained deletion blocked; malformed or unknown baseline event rows rejected; route-only/cached intent rejected; exact current tail accepted after more than 100 appends and supported revert; a changed destination generation requires a fresh observation; qualified empty-root behavior is explicit; mismatched/timed-out launch blocked; no input before adoption or false seed/loss from unresolved source state.

- [x] **Step 5: Refactor while green**

Factor exact closure comparison into a small value-oriented helper shared by probe and tests; keep body values absent from structured logs and probe results. Re-run focused tests.

- [x] **Step 6: Run impacted-test verification**

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
- Consumes: a captured durable tuple of control epoch, persisted user-intent/correction revision, soul intent revision, identity revision, evidence/import revision, active incarnation, recovery attempt, exact native identity, and source/import generation, as applicable.
- Produces: every participating write rejects stale observations by a SQLite compare-and-set in the same transaction that writes the result. A loss certificate is possible only for a previously verified materialized identity when the complete declared source inventory is authoritatively absent and the commit still matches the captured tuple. Pending first import, available, unresolved, unreadable, unsupported, expired stage, partial import, or legacy-unknown source state remains retryable/blocked.
- Source ownership is keyed by `(provider, stable source-store identity, native root)` in a durable origin-owner table, separate from per-incarnation writer claims. Only one soul may prepare or commit adoption for an origin. Schema migration must not guess a winner: backfill claims only for unambiguous existing origins, leave duplicate roots explicitly unclaimed/ambiguous, and preserve both soul rows until the exact repair resolves them from permitted metadata. Do not use age, lexical IDs, or row order. Ambiguous metadata blocks restoration and preserves both rows.

- [ ] **Step 1: Write failing loss-fence and ownership tests**

Add tests proving `Allocated`/`Materializing` souls cannot be Lost; every pending/available/unresolved `NativeImport` state blocks loss; `Path::exists`-style I/O errors cannot become absence; a late source/import/identity write invalidates an old loss certificate; only a complete absent source inventory can certify loss; and an observed/requested ID can never become a pristine seed from a stale `never_dispatched` snapshot. Race two destination stores for one origin key and assert one durable owner; retire the other incarnation without deleting the winner's origin claim. Test explicit legacy-unknown state and repeated/reordered refreshes.

- [ ] **Step 2: Run tests and verify the intended failure**

Run: `cargo test -p freshell-supervisor materializing_cannot_be_lost && cargo test -p freshell-supervisor loss_commit_rejects_newer_materialization && cargo test -p freshell-supervisor native_id_has_one_writer`

Expected: FAIL because loss currently ignores allocation/durability state and its final commit does not compare captured native identity/evidence generation.

- [ ] **Step 3: Add a durable materialization/loss fence**

Add a shared per-soul coordinator for mutating identity/import/dispatch/recovery operations, while the durable CAS remains the correctness boundary. Capture the expected generation tuple before asynchronous work and compare it in every commit that writes identity, resume evidence, import, loss, or restore state. Stop commits its intent revision before waiting for the coordinator so it can invalidate in-flight work; destructive cleanup then revalidates the same exact incarnation. A Stop or repair choice made while a soul is already Lost and stopped must still advance a persisted user-intent/correction revision; never infer the user's latest choice from a loss-generated tombstone. Split locked and already-locked probe helpers to avoid nested non-reentrant mutex deadlocks. Writers must check affected-row counts. Add an origin-owner table and unique transaction claim; backfill only unique legacy origins and leave duplicate roots unclaimed for the explicit repair. Persist source/import verdicts and refresh authority; a missing path/error is `Unresolved`, not `Absent`. Add OpenCode `NativeImport`; require complete authoritative source absence before loss, and a full verified baseline before durable resume readiness. Requested identity or zero dispatch alone never enables a seed.

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
- Modify: `crates/freshell-runtime-protocol/src/lib.rs` and `crates/freshell-runtime-client/src/lib.rs` for the exact batch repair request/reply
- Modify: supervisor and managed-runtime API tests

**Interfaces:**
- Consumes: the seven exact Lost root mappings, all eight incident IDs/revisions, unique canonical source-root ownership, revalidated `ImportReceipt` and `InstalledStoreReadable` receipts for each exact installed generation, and exact false artifact references.
- Produces: seven stopped/resume-ready canonical souls for seven distinct roots. `DataRepairComplete` is true only when each root has both full structural imported-baseline verification and a body-free provider-reader/access result for the exact installed generation under its actual provider identity/environment, and the batch correction CAS still matches the captured intent/source/identity generations. No provider process launches for this check. A later explicit launch remains pending until its own correlated `ProviderObserved` receipt. The duplicate soul is retired only after its explicit views are rebound, redundant automatic views/projections are removed, and exact cleanup is settled. The operation fences cleanup of exact old incarnations and idempotently withdraws only false loss rows, outbox payloads, notice/projection references, loss-generated tombstones, and exact filesystem exports. A concurrent user action invalidates the captured revision and leaves the operation retryable.
- Withdrawal runs under one registry-owned export/retraction coordinator held from fresh authorization through every filesystem effect. Every exporter rechecks the exact current outbox/incident generation under that coordinator before writing. A durable progress record contains target IDs/generation/status/artifact names only, never a certificate or payload; startup resumes it before normal export draining. Delete the progress record after every target file/log update is synced and verified.
- For each notice with false IDs, calculate the new deterministic notice identity from its surviving incident-ID set. Remove false-only notices; rebuild mixed notices without false IDs; redirect supersession edges and outbox projections. If several sanitized notices collapse to one ID, merge profile receipts by `dismissed > acknowledged > rendered > absent`, retaining terminal suppression and the latest timestamp for the chosen state. Do not retain old false-bearing notice IDs or weaken a terminal receipt.
- Request boundary: add one authenticated batch operation such as `POST /api/runtime/soul-loss-repairs` that accepts only the exact eight `(soul_id, incident_id, expected_intent_revision)` targets and an operation idempotency key. Resolve source roots/stores server-side, reject any target-set mismatch or ambiguous owner, and return per-root import status plus final correction status. The route accepts no native filesystem path or transcript data.
- Stopped repair path: the seven Lost souls need an explicit transfer/import/readability operation that does not use the normal launch/grant path, create a PTY, or start OpenCode. It must install the exact imported baseline into the canonical provider volume, run the body-free native-reader probe under that provider's actual UID/HOME/XDG/`OPENCODE_DB`/cwd/mounts, and persist receipts bound to the exact installed generation before the batch correction CAS. Root-side structural verification alone is insufficient. This path is required to produce the `ImportReceipt` and `InstalledStoreReadable` inputs described above.

- [ ] **Step 1: Write failing restore and withdrawal tests**

Add a registry/filesystem fixture with Lost souls, exact loss rows/tombstones, pending and delivered open/final export payloads, open/closed JSON plus temp files, active and rotated incident JSONL entries, lifecycle references, mixed and false-only notices, supersession chains, receipts, duplicate-root souls/views, and concurrent stale incident and lifecycle writers/rotators. Assert correction rejects stale revisions, ambiguous ownership, structural-only imports without `InstalledStoreReadable`, and stale reader generations. Include a case where the session host can read the installed DB/assets as root but the actual provider UID cannot read the DB or a required asset; correction remains pending, all false artifacts remain, and no provider is launched. It always leaves canonical souls stopped; a concurrent explicit user action makes the CAS fail and leaves correction retryable. Verify cleanup claims cannot signal after correction, and any issued signal must settle against the exact old handle. After correction, assert idempotency, absence of exact false evidence everywhere requested, untouched unrelated records, correct mixed-notice IDs/references/receipts, and no stale writer recreation. Merge receipts by `dismissed > acknowledged > rendered > absent` if sanitized notice IDs collide, and verify terminal suppression is not weakened. Simulate crashes after every DB/file boundary; the progress marker contains only target IDs/generations/status/artifact names and disappears after completed cleanup. Add exact duplicate-root ownership, view-rebind/delete, projection, and foreign-key/order cases.

- [ ] **Step 2: Run tests and verify the intended failure**

Run: `cargo test -p freshell-supervisor restore_lost_souls && cargo test -p freshell-supervisor withdraw_false_incident`

Expected: FAIL because Lost souls have no restore transition and incident exports/notices have no correction lifecycle.

- [ ] **Step 3: Add revisioned restore and exact incident withdrawal**

Stage the seven-root correction under one operation ID and captured identity/intent/source generations. Resolve the duplicate root owner from exact body-free source-store/root, import-receipt, soul-revision, and view metadata; never choose by age, lexical ID, or row order. If that evidence has no unique owner, stop before mutation and request the user's choice. Persist a cleanup generation that makes an old worker recheck before signaling; if its signal already went out, wait for the exact old handle to settle. Import and structurally verify each distinct root once into its single canonical soul-owned provider volume without starting an agent. Then run the qualified read-only native-reader/access probe for each exact installed generation under its actual provider UID, HOME/XDG, `OPENCODE_DB`, cwd, and mounts; it must traverse the required graph/assets without returning bodies or launching a provider. Identical existing rows are no-ops; any conflicting unreceipted content blocks rather than being overwritten. Do not begin false-record withdrawal until all seven structural receipts and all seven current `InstalledStoreReadable` receipts independently revalidate against the captured generations. If provider access is missing or cannot be proven, report repair pending and preserve every false artifact. In one CAS transaction, mark canonical souls `DataRepairComplete`, resume-ready, and stopped; this state does not assert a running `ProviderObserved` result. Rebind explicit views from the duplicate to the canonical owner, keep at most one automatic view per root, remove redundant duplicate automatic views, then remove the duplicate soul only after its view/projection/cleanup references are settled. Remove the exact eight false loss rows/outbox certificate payloads and only their loss-generated tombstones, and enqueue durable ID-only withdrawal progress.

Rebuild only notices whose incident sets intersect the false IDs, redirect supersession edges, and remove false-only notices. If sanitized notice identities collide, merge receipts using the tested `dismissed > acknowledged > rendered > absent` rule, so terminal suppression is never weakened and no obsolete false-bearing notice ID remains. Under one registry-owned export/retraction coordinator, remove exact open/closed JSON and target temp files; filter exact incident IDs from active and rotated `incidents.jsonl`; and remove exact lifecycle events that name those incidents from active and rotated lifecycle logs. Every lifecycle appender, exporter, rotator, and rewriter that can touch those paths participates in the same coordinator; an incident-export-only lock is insufficient. Each writer rechecks the current generation immediately before its file effect and holds the coordinator through sync/acknowledgement. A durable progress marker is committed before file cleanup and contains only target IDs, generations, status, and artifact names. On restart, retry that exact cleanup before normal export draining. Preserve every unrelated valid record; match structured incident IDs exactly, never by substring. Sync changed files and parent directories before clearing progress. A malformed JSONL record that cannot be classified without risking unrelated data keeps correction pending. Never retain false certificates or backup copies after successful correction.

- [ ] **Step 4: Run focused tests**

Run: `cargo test -p freshell-supervisor restore_lost_souls && cargo test -p freshell-supervisor withdraw_false_incident`

Expected: PASS for stopped/resume-ready `DataRepairComplete`, provider-identity read failures preserving all false artifacts, one-owner safety, duplicate view/soul cleanup, stale-cleanup fencing, crash-retryable exact withdrawal, safe receipt collision handling, serialized exporter/lifecycle-log updates, and absence of false artifacts without touching unrelated incidents or concurrent user intent.

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
- Produces: automated proof that a fresh soul imports and verifies a complete synthetic conversation and provider-identity native readability before spawn, receives the generation-bound current TUI-tail observation before accepting input, appends a synthetic turn under the same ID, and reopens without losing its full imported baseline; a body-free production correction runbook that imports seven distinct roots, verifies each installed store under its actual provider identity, retires the duplicate soul, leaves canonical souls stopped/resume-ready, and withdraws false incidents after PR merge and the separately approved restart.
- Backend constraint: the current resurrection spec is local-only, its managed-runtime rig requires Docker and shared host paths, and the configured Cloud Run test image has no Docker socket or remote broker. Do not remove that exclusion or silently substitute a local run. Before the E2E gate, either add a cloud-capable broker/harness with safe shared-path handling or use the user's explicit approval for a one-time local-only run of this synthetic Docker test; keep other configured test lanes on cloud.

- [ ] **Step 1: Write the failing managed-runtime continuity scenario**

Extend the existing managed OpenCode resurrection spec with an isolated host source DB and empty soul provider volume. Seed a synthetic root plus descendants, ordered messages, linked parts, an unrelated session, and sentinel account/credential/configuration rows. Assert the encoded exact-session transfer consumed by begin/chunk/finalize excludes all unrelated and account/credential/configuration sentinels; source snapshot/import/full-baseline verification and provider-identity read verification precede PTY spawn. The post-spawn plugin observation of the exact TUI session plus the tail from the current verified destination generation precedes user input. Reopen after more than 100 appended messages and after a supported revert removes the original import tail; derive and observe each new current tail. Simulate a destination generation change between verification and observation and require fresh verification and a matching event. The plugin signal must fail closed on empty/missing/mismatched tail, stale/cached state, or navigation away; a truly empty root is accepted only through the qualified successful empty-read path. It does not claim to prove older pages were loaded. Read all expected synthetic history through the provider contract, send a synthetic follow-up, and assert new rows append under the same root ID while every imported baseline row and required asset remains. Prove that structural reads as root cannot substitute for the installed provider-identity reader when the provider UID lacks access to the DB or required asset; stopped correction must preserve false artifacts until the read check passes. Simulate an interrupted partial transfer, unresolved source, incompatible target artifact, provider rejection, stale loss/cleanup results, duplicate-root contention, and correction restart; assert none creates a Lost view, false incident export, or second writer. Retain the positive test that only a complete authoritative absence can be lost.

- [ ] **Step 2: Run the focused test and verify the intended failure**

Run: `FRESHELL_TEST_SUMMARY='managed OpenCode source-to-soul resume' GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e:cloud --project=chromium --grep='managed OpenCode source-to-soul resume' test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts`

Expected: FAIL because the current launch does not transfer host-side native history or independently observe provider adoption.

- [ ] **Step 3: Complete synthetic E2E wiring and prepare the correction runbook**

Implement only synthetic harness integration needed to drive production interfaces. Run the E2E until it proves exact-payload exclusion of unrelated/account/credential/configuration data, full imported-baseline verification, provider-identity reader verification, generation-bound current TUI-tail observation, full synthetic-history continuity, gated input, append/reopen after >100 messages and supported revert, destination-race handling, supported transition validation, stopped/resume-ready repair, duplicate soul/view retirement, and exact artifact withdrawal. Prepare the post-merge runbook in two phases: first perform a read-only body-free preflight after merge and before requesting restart approval. Reconcile the exact seven-root/eight-incident target map with the prior body-free 179-session source-store census and explain any current aggregate difference without broadening the target set; classify the reported `message_seq` table against the exact pinned source DDL. Include source/target fingerprints, closure counts/size/digests, referenced-asset availability, canonical owner, provider-reader/access readiness, notices, receipts, and artifact locations. Then, only after exact `APPROVED`, restart/deploy and apply the already-reviewed batch correction. The preflight must not inspect transcript bodies or mutate data. Do not inspect real session state in this synthetic task, and never send a test prompt to a real conversation. Any later repair receipt may contain only target IDs, graph counts, digests, revision/status codes, and completion status; it must not retain transcript bodies, false certificates, or obsolete incident exports.

- [ ] **Step 4: Run the synthetic E2E verification**

Run: `FRESHELL_TEST_SUMMARY='managed OpenCode source-to-soul resume cloud' GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e:cloud --project=chromium --grep='managed OpenCode source-to-soul resume' test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts`

Expected: PASS for synthetic exact-session payload boundaries, complete import and provider-reader verification, generation-bound current-tail observation, gated input, append/reopen after history-window shift and supported revert, fail-closed partial transfer, stale cleanup/export fencing, stopped/resume-ready correction, and false-loss prevention. The runbook contains no real session contents or incident exports. Run through cloud only if the synthetic managed-runtime path is made cloud-capable; otherwise require the user's explicit one-time local-only approval as described above.

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
- [ ] Synthetic coverage proves that serialized bundles exclude unrelated roots/account/credential/configuration values; exact import and actual-provider-identity reader access; generation-bound current-tail observation after long append and supported revert; single-origin ownership across different destination stores; fail-closed source/asset/artifact handling; stopped `DataRepairComplete` without starting a provider; duplicate soul/view retirement; and exact false-incident withdrawal while preserving unrelated notices and concurrent user intent.
- [ ] Incomplete or unresolved source transfer cannot launch or become Lost; a truly absent complete source inventory can still follow existing true-loss behavior.
- [ ] The full supported suite and affected E2E coverage pass; whole-branch and final delta reviews have no unresolved must-fix findings.
- [ ] Open and merge the authorized PR targeting `main`, wait for required checks, merge, fast-forward local `main`, and clean up the feature worktree per repository instructions.
- [ ] **Post-merge live restoration (separate approval gate):** first, while the old service is still running, perform the authorized body-free read-only preflight and report the exact seven-root/eight-incident mapping, reconcile the prior body-free 179-session source-store census and explain aggregate differences, classify `message_seq` against the exact source DDL, and report source/target fingerprints, closure counts/size/digests, asset availability, canonical duplicate owner, notice/receipt collisions, and artifact locations. Do not write or restart. Then request the exact word `APPROVED`. Only after it arrives, restart/deploy the merged code, import each distinct root into its canonical soul, independently verify all rows/assets, and run the body-free reader/access check under each actual provider identity and installed environment. Keep every soul stopped; the repair does not produce `ProviderObserved` or start a provider. If any mapping, reader result, or artifact is ambiguous, stop before withdrawal and ask the user for the one needed decision. Only after all seven `DataRepairComplete` receipts verify, retire the duplicate soul/views and withdraw the eight exact false incidents, notice/outbox references, JSON/JSONL exports, and lifecycle entries. Verify unrelated incidents/notices remain and remove the temporary withdrawal-progress marker. PR merge alone is not completion of the data repair.
