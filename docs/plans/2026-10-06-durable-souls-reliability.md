# Durable Souls Reliability Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Fix all known durable-souls problems, complete ordinary use in the four selected Codex/OpenCode modes, fix cold sandbox startup, and perform a thorough review of the entire committed change. Diagnose actual failures, repair substantiated defects, verify the result, and report remaining limitations in plain English. Continue the existing the-usual workflow; the latest request authorizes renewed repairs and review after the earlier review attempts ended without complete coverage.

### Explicit constraints
- Use the-usual workflow and a dedicated worktree; fix test failures found in this repair and continue.
- Focus the current live checks on terminal Codex and OpenCode plus FreshCodex and FreshOpenCode; skip Claude, Amplifier and Kilroy live checks.
- Keep verification proportional to the stated threat model: behavior tests and diagnosable logs are enough; do not build a formal certification or audit campaign.
- Avoid strict provider-session continuity or automatic migration across a transition. If existing sessions need moving, manual porting later is acceptable.
- Use the easiest already authorized Codex account path and existing OneCLI references. Do not change shared credentials without separate approval.
- Use actual error diagnostics to investigate failures. Protect secret values; the earlier blanket restriction on reading diagnostic output was not a user requirement.
- For Stage 5 Fresh Eyes, use the runner's `--gpt` option because other models are unavailable; this is the user's explicit exception to the different-model-family preference.
- For the complete Stage 5 review, the independent GPT reviewer may use up to three independent GPT helpers and produce one integrated verdict. This is an exception only to the prohibition on secondary reviewers; the severity rubric, review limit and independence requirements remain unchanged.
- Do not make changes to the rubric while its example wording remains under discussion.
- The user approved local execution for the selected live specs because they are excluded from Cloud; keep the configured backends for other checks.
- Review the entire change, including recovery behavior and integration between components. Track actual file coverage and review subsequent repairs; do not count a failed reviewer launch as code-review evidence.

- Rebase this repair branch onto the latest main at a suitable committed checkpoint before final review and verification.

### Accepted tradeoffs and residuals
- Existing provider sessions may not survive a runtime transition; manual porting may be needed later.
- Amplifier and Kilroy are outside this repair's live checks.
- Claude live behavior remains unverified; proceeding without it is accepted. Earlier provider access failures are historical observations, not a diagnosis of current account availability.

**Goal:** Fix the diagnosed durable-souls defects and verify ordinary one-turn use in the four selected non-Claude modes without requiring same-session continuity across a transition.

**Architecture:** Correct the existing runtime paths and use focused behavior tests plus isolated managed-browser smoke checks. Preserve existing session data; do not add an audit or certification campaign. If a provider transition leaves an old conversation behind, manual porting is acceptable.

**Tech Stack:** Rust/Tokio/Axum/rusqlite, rootless Docker, TypeScript/NodeNext, React/Redux, Vitest, Playwright, pnpm 10.34.5, existing OneCLI provider-reference interfaces, Cloud Run test backends.

## Global Constraints

1. Work in `/home/dan/code/freshell/.worktrees/durable-souls-reliability` on the recorded feature branch. Preserve existing commits, historical receipts and unrelated work. Do not merge, push, create a PR or deploy without the approvals required by repository instructions.
2. The live mode checks cover terminal Codex and OpenCode plus FreshCodex and FreshOpenCode. The user accepted proceeding without Claude live verification; earlier access failures do not diagnose current account availability. Skip Amplifier and Kilroy live checks; leave their existing code and meaningful tests alone.
3. Do not require automatic migration of existing conversations or exact provider-native session continuity across a transition. Do not touch real existing session stores. A later manual port is an accepted option if needed.
4. Keep recovery truthful: a requested or missing identity, unreadable/partial provider storage, or stale observation cannot be treated as proof that a conversation is absent or lost. Retain the existing pristine-seed and ordinary Stop semantics.
5. Respect the rootless runtime boundary, provider UID/GID, zero capabilities, read-only container root, private writable provider volumes and exact process/resource ownership. Destructive tests use the disposable sandbox or an isolated owned rig.
6. Use existing typed OneCLI references and the easiest existing authorized Codex account path. Preserve provider auth formats and never log secret values or transcript bodies.
7. Use pnpm 10.34.5 and the configured test backends. Coordinate broad tests, require the configured robot identity for agent-launched cloud gates, and do not replace a failing backend silently or count skipped/zero-match tests as coverage.
8. Keep structured diagnostic logs for recovery failures and outcomes. Clear diagnostics are required; a formal audit trail or certification subsystem is not.
9. Use meaningful red/green/refactor tests for code changes, run affected checks, preserve existing regression coverage, and obtain independent review. Existing historical PASS/FAIL receipts retain their original meaning.
10. Do not restart the production Freshell server without the exact `APPROVED` required by repository instructions. End-user documentation belongs in README.md; update other docs only when the repaired behavior requires it.
---

## Evidence and file responsibilities

Tasks 1–7 below are completed source work; their task sections retain the specific files and historical checks. Historical source reports and receipts remain useful context but do not replace checks on the joined candidate.

The remaining browser verification uses the already-built external managed-runtime runner and the selected ordinary-Stop and four-mode smoke cases in the existing managed-runtime and fresh-agent specs. If a behavior regression is found, change only its owning source and tests. The four-mode smoke reuses the isolated rig, mode selection, and configured credentials. It proves an ordinary launch and one completed response per selected mode; it does not publish a qualification receipt or assert recovery after a crash.

The strengthened terminal Codex and OpenCode checks passed at `a62b7b3436afba07cb86a2def2b0519fe8edb9bd`, including a newly rendered answer and successful completion for the allocated native conversation. The unchanged FreshCodex and FreshOpenCode successful-answer checks passed at `3dcd7884236e4184859a2e40c7115383f5de6831`, as did the selected interrupted-Stop browser case. Each live run verified owned-resource cleanup. Older terminal receipts retain their original assertion meaning and do not establish the strengthened check.

The renewed saved-history browser checks passed at `e7c8dd1c1c7c4c13f78fda21c76b1eb2b95a6595`; the corrected settings case and two neighboring cases passed at that same commit. The stale-loss reload check passed at `d3b9744d6fbec7d0198968cd813a8c2ccb1c99de`. The run ledger records each actual tested commit and the subsequent changes considered when reusing evidence. These results do not claim execution on a later commit. The config/legacy retry case remains outside the accepted transition scope. Remaining work is the integrated full-suite gate, whole-change review, Stage 5 independent review, and its final browser-evidence assessment. No production backup, deployment packet, real-session import, transition rehearsal or all-mode campaign is part of this repair.

## Completed source work and current remaining work

Tasks 1–7 below retain the completed source work, tests and historical checkmarks. The remaining scope is Tasks 8–9. The earlier plan required strict native-session continuity through host/provider crashes; the user has explicitly relaxed that requirement. This amendment removes the transition test and the unrequested backup/deployment preparation. It does not discard completed source work or weaken its ordinary regression tests.

The former all-mode source run is historical evidence and not a pass for the newly scoped smoke. Exact cleanup was verified; preserve its result without repeating the out-of-scope transition campaign.

### Task 1: Preserve and integrate OpenCode repair for the exact nine-target batch

**Files:**
- Modify: `Cargo.lock`, `crates/freshell-agent-runtime/Cargo.toml`, `crates/freshell-platform/Cargo.toml`, `crates/freshell-runtime-protocol/Cargo.toml`, `crates/freshell-server/Cargo.toml`, `crates/freshell-session-host/Cargo.toml`, `crates/freshell-sessions/Cargo.toml`, `crates/freshell-supervisor/Cargo.toml` for imported feature dependencies.
- Modify: `crates/freshell-agent-runtime/src/lib.rs`, `crates/freshell-platform/src/cli_launch.rs`, `crates/freshell-platform/src/opencode_plugin.rs`, `crates/freshell-runtime-client/src/lib.rs`, `crates/freshell-runtime-protocol/src/lib.rs`.
- Create: `crates/freshell-agent-runtime/src/opencode_transfer.rs`, `crates/freshell-agent-runtime/src/opencode_transfer_tests.rs`, `crates/freshell-runtime-protocol/src/opencode_transfer_tests.rs`, `crates/freshell-sessions/src/opencode_transfer.rs`, `crates/freshell-sessions/src/opencode_schema_v1_18_21.sql`, `crates/freshell-sessions/tests/opencode_native_transfer.rs`.
- Modify: `crates/freshell-sessions/src/directory_index.rs`, `crates/freshell-sessions/src/lib.rs` at the OpenCode/Codex wiring overlap.
- Modify: `crates/freshell-server/src/managed_runtime.rs`, `crates/freshell-server/src/managed_runtime_api.rs`, `crates/freshell-server/src/managed_runtime_api_stop_tests.rs`, `crates/freshell-session-host/src/command_journal.rs`, `crates/freshell-session-host/src/main.rs`, `crates/freshell-session-host/src/providers/mod.rs`, `crates/freshell-session-host/src/providers/deterministic_fresh_agent.rs`, `crates/freshell-session-host/src/pty.rs`, `crates/freshell-session-host/tests/opencode_docker_contract.rs`.
- Modify: `crates/freshell-supervisor/src/backend.rs`, `crates/freshell-supervisor/src/backend/native_history.rs`, `crates/freshell-supervisor/src/lib.rs`, `crates/freshell-supervisor/src/loss_report.rs`, `crates/freshell-supervisor/src/loss_report_tests.rs`, `crates/freshell-supervisor/src/notice_outbox.rs`, `crates/freshell-supervisor/src/recovery.rs`, `crates/freshell-supervisor/src/registry.rs`, `crates/freshell-supervisor/src/resume_catalog.rs`, `crates/freshell-supervisor/src/service.rs`.
- Create: `crates/freshell-supervisor/src/opencode_transfer.rs`, `crates/freshell-supervisor/src/opencode_transfer_tests.rs`, `crates/freshell-supervisor/src/stopped_repair_cas.rs`.
- Create: `scripts/testing/opencode-restoration-rehearsal.ts`, `crates/freshell-agent-runtime/examples/opencode_restoration_rehearsal.rs`, `test/unit/tooling/testing/opencode-restoration-rehearsal.test.ts`. Modify: `tsconfig.runtime.json` to include the new TypeScript driver explicitly. Create: `scripts/testing/opencode-native-transfer-check.ts`, `test/unit/tooling/testing/opencode-native-transfer-check.test.ts`; include both new drivers explicitly in `tsconfig.runtime.json`. Behavioral pipeline cases live in the imported existing `crates/freshell-agent-runtime/src/opencode_transfer_tests.rs`; no new ignored test.
- Modify: `docs/development/runtime-provider-capabilities.json`, `extensions/opencode/freshell-rebind-plugin.ts`, `src/components/ManagedRuntimeRecoveryCard.tsx`, `src/lib/managed-runtime-retry.ts`, `port/contract/managed-runtime.schema.json`, `shared/managed-runtime.ts`, `scripts/testing/runtime-sandbox.ts`, `scripts/testing/runtime-test-broker.ts`, `test/e2e-browser/helpers/managed-runtime.ts`, `test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts`.
- Test: `test/unit/client/components/ManagedRuntimeRecoveryCard.test.tsx`, `test/unit/extensions/opencode-rebind-plugin.test.ts`, `test/unit/lib/managed-runtime-retry.test.ts`, `test/unit/lib/managed-runtime-recovery.test.ts`, `test/unit/tooling/testing/runtime-test-broker.test.ts` and the imported Rust tests listed above.
- Create: `test/unit/lib/managed-runtime-wire.test.ts` for behavioral production-schema/client parsing; regenerate the production contract before assessing `test/unit/port/managed-runtime-contract-freeze.test.ts`; remove it only if its static text/schema comparison still blocks this change after regeneration and recording the failure. Never update its expected text or treat it as behavior coverage.
- Create: `test/e2e-browser/fixtures/managed-opencode-host-status.cjs`, `test/e2e-browser/fixtures/managed-opencode-host-status.node-test.cjs`, `test/e2e-browser/fixtures/managed-opencode-source.ts`.

**Interfaces:**
- Consumes: immutable feature interval `e04a1d860..8362581b8` and coherent binary dirty patch plus three untracked fixtures; current base's Codex reconstruction and session directory behavior.
- Produces: `RepairBatchScope { scope_id, source_store_id, source_fingerprint, targets, roots }`, resolved by the supervisor from qualified source roots and eligible registry incidents; each target retains exact soul/incident/intent/identity/import revisions and each root retains its graph digest and eligible owner set. `RestoreLostSoulsRequest` carries `scope_id`, targets and typed canonical-owner choices. `validate_exact_batch(&self, scope: &RepairBatchScope)` checks exact membership/revisions/root mapping, not count constants. Existing `ImportReceipt`, `InstalledStoreReadable` and `ResumeSpec.opencode_adoption_baseline` remain. The current frozen scope yields nine targets/seven imports; reply counts derive from validated sets.

**Before Step 1:** Verify the existing immutable `preservation/opencode-20261006T074448Z/manifest.json`, source HEAD `8362581b8c90de7e192a353b2256a7a5e71b5494`, merge-base `e04a1d8601a2180c85128b3ed4154350d5e0ad25`, tracked patch SHA256 `b61d22f940e1103e7d847213c25d42efc2f6075c308092212ec5c338460493d2` and each exact captured fixture hash/length. Its coherent flag and immutable bytes are authoritative for this integration; no new source capture is needed when they verify. Record no secret values. Replay chronological committed feature commits in the destination only, resolving each against current main. Never apply `git diff d0cc7cb5e..8362581b8` or a whole tree overlay. Apply the coherent captured dirty patch after replay. Keep source unchanged. Historical test code arrives with reuse; the following count regression is a fresh red phase. Repair compile/typecheck/Clippy blockers so the test fails for behavior.

- [x] **Step 1: Write the failing behavioral test**

In the existing exact-batch tests, clone the eight-target fixture's valid duplicate target to a **different soul and incident** with its own revision, mapped to a second existing root. Run `validate_exact_batch(&scope)` and the stopped repair operation. Assert nine accepted targets, seven imports, seven stopped canonical owners, two redundant mappings removed only after explicit view rebind, nine exact incident withdrawals, and preserved unrelated notices. Against the independently frozen nine-target/seven-root scope, reject 8 or 10 submitted targets, duplicate soul/incident, substituted or missing/extra roots, stale source/target revisions, conflicting owner receipts and stale canonical choices. Exercise sole eligible owner, retired duplicates and a genuine unresolved owner with typed choices. Then add a valid tenth eligible target: the old scope refuses drift before writes; a freshly server-resolved ten-target scope succeeds with the same binary, imports each distinct root once and preserves unrelated records. The ninth target must be valid except for old count policy; do not make the test fail on absent APIs or fixture setup.

Replace the historical count unit case with production request validation exercising nine distinct soul/incident IDs and current revisions: nine succeeds against its frozen scope; eight, ten, repeated soul/incident and stale revision fail against that scope; ten succeeds only against a new independently resolved ten-target scope. Use the integrated request's real fields and fixture constructors; then run the stopped transaction cases above. The revised cases exercise actual validation and transaction behavior; source-copy or hash assertions do not count as coverage.

Also construct the current schema-7 fixture from F02's metadata shape: nine stopped/lost targets, intent revision 2, incident revision 1, verified-empty closed prior incarnations, absent identity/import revision columns and absent origin/repair tables. Migrate through the integrated production opener and prove typed legacy-unknown/unbound fences, not fabricated zero-certified source authority. Use fictional synthetic source identity `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` with roots `ses_fixture_root_alpha` and `ses_fixture_root_beta`, and bind it only to independently verified fixture roots and completed import/read receipts. Test both fictional eligible duplicate pairs returning deliberate typed owner choices; no timestamps or incidental row order settle them. Reject unreceipted conflicting destination data without overwrite. Preserve the exact F02 incident/view/notice/receipt/outbox/export identifiers only in the external current preflight/restoration proposal; synthetic tests use fictional IDs of the same metadata shape.

Add native transfer qualification regressions before any complete-export claim: equivalent whitespace and message_seq TEXT/INTEGER case with the exact 38 migration names must be admitted only by narrow semantic schema checks; changed keys, column types, nullability, foreign-key relationships, indexes/triggers or migrations must be refused. Arbitrary ToolState.metadata dictionaries with type=file/no URL and FilePart.source attribution are preserved without becoming attachment authority; genuine FilePart and native tool-attachment authority positions in parts/events retain complete asset validation. Test saved full/part revert and ordinary prompt cleanup without losing immutable baseline evidence or silently dropping saved references. Default Rust tests run these cases through the actual production exporter/importer/installed reader APIs against SQLite/file fixtures owned by the ordinary current UID; no external CLI, Docker, root/sudo, UID switch or special filesystem is required. The separate native driver below repeats them against the pinned consumer in its owned rootless rig. Neither schema-hash assertions nor fixture decoding qualify that native consumer.

Prepare the finite native driver/adapter as test-fixture plumbing before changing the production transfer behavior, so its red execution uses the pre-fix exporter/importer/reader and never fails merely because the driver or binary is missing. Build the pre-fix owned session-host/image with pinned consumer, record its immutable digest as owning-shell `opencode_transfer_image_digest`, and retain imported pre-fix behavior receipts for branches already repaired by integration. Assign the count tests the exact names `stopped_repair_exact_batch_nine` in runtime-protocol and `restore_lost_souls_nine` in supervisor. Add normally running, nonignored `durable_souls_rehearsal_pipeline` behavioral cases in `crates/freshell-agent-runtime/src/opencode_transfer_tests.rs`: use bounded fictional source fixtures to run the same public `export_exact_session`/`import_bundle_payload`/`verify_installed_store` pipeline used by the real driver. Compare complete imported native rows/assets and independently read results; mutate one source reference, truncate payload, reduce destination capacity, conflict destination, mismatch root/digest and supply unreadable provider context to prove refusal without source writes or partial-completion claims. Add default-included driver tests executing finite manifest admission, child lifecycle and receipt derivation: missing/private-input/candidate/real-source binding refuses, failed native consumer or cleanup refuses, six/eight completed roots refuses, and synthetic fixture metadata never qualifies as real rehearsal. No ignored/skipped/environment-conditional test or default synthetic success counts as real evidence. The strict driver/adapter and its default behavior tests remain as implemented; Task 11 does not execute a real-root rehearsal. Prefix every added schema-7 fence, semantic-schema admission/refusal, attachment-authority, saved-revert and cleanup regression with `durable_souls_` in its owning sessions/agent-runtime/supervisor/session-host test module or native-transfer integration test. All default-run `durable_souls_` cases use pure code/SQLite and ordinary current-UID owned temporary files, including real production reader-context/copier calls with deterministic fault injection. Cargo workspace CI requires no rig, installed provider CLI or conditional skips. The separate finite native driver uses pinned OpenCode 1.18.21 in an owned rootless rig with synthetic data, no provider prompt/grant mutation, and cannot be counted from cargo fixture results. Add wire tests executing the exported production schemas on valid scoped nine-target requests/replies, absent/malformed scope and duplicate payloads, then run semantic membership/stale-revision refusals through the actual server/client route (a schema alone cannot know the server scope), then feed accepted replies through the existing client recovery path; legacy payloads retain their documented semantics. Each selector below must list and execute positive case counts. Imported behavior already fixed needs its executed historical red receipt plus current positive coverage; record each genuinely missing branch's fresh red failure before fixing it.

- [x] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-runtime-protocol stopped_repair_exact_batch_nine`

Run: `cargo test -p freshell-supervisor restore_lost_souls_nine`

Run: `cargo test -p freshell-agent-runtime durable_souls_rehearsal_pipeline`

Run: `pnpm run test:vitest run test/unit/tooling/testing/opencode-restoration-rehearsal.test.ts --config config/vitest/vitest.config.ts`

Run: `cargo test -p freshell-sessions -p freshell-agent-runtime -p freshell-supervisor -p freshell-session-host durable_souls_`

Run: `pnpm run test:vitest run test/unit/lib/managed-runtime-wire.test.ts --config config/vitest/vitest.config.ts`

Run: `pnpm exec tsx scripts/testing/opencode-native-transfer-check.ts --image-digest "$opencode_transfer_image_digest" --case all`

Expected: all four native groups execute positively; genuinely missing semantic/asset/revert/transfer branches FAIL for their actual native behavior, and already-fixed imported branches retain actual pre-fix evidence plus current execution. Missing prerequisite/binary/image/driver is not behavioral red. The named scope tests FAIL because the integrated old implementation requires eight targets and cannot bind independently resolved membership; each missing schema/fence/asset/revert/cleanup/parser branch also has an executed intended red failure or imported pre-fix failure evidence. Confirm nonzero executed fixture tests for every selected package and the native-transfer integration target (which exercises Rust APIs, not the external pinned consumer); setup, missing binaries and fetch errors do not count as red.

- [x] **Step 3: Add the minimal production implementation**

Create the finite owner-side `scripts/testing/opencode-restoration-rehearsal.ts` driver with CLI `--mode real --manifest-file <absolute-private-json-path> --scratch-dir <fresh-private-absolute-directory>`. All three arguments are required; there is no default/synthetic/fixture CLI mode. Missing argument/file/real-source provenance, nonprivate input/scratch, wrong candidate/image or invalid scope fails nonzero before transfer. `runRealRootRehearsal({ manifestFile, scratchDir }): Promise<RehearsalReceipt>` consumes an explicitly supplied private manifest, revalidates read-only source identity/root fingerprints against current external preflight and uses existing `RuntimeHarness` for only owned rootless containers, immutable image, exact provider UID/GID, finite native decoder and cleanup. `RehearsalReceipt { kind: 'real-root-rehearsal'; candidateSha; imageDigest; sourceIdentity; targetScopeDigest; runCount; expectedRootCount; exportedRootCount; importedRootCount; nativeReadableRootCount; failedRootCount; cleanupStatus; rootEvidence }` derives every count from completed original per-root artifacts; the historical driver contract requires one run/seven distinct real roots, zero failed roots and successful owned-resource cleanup. Any fixture/synthetic artifact, missing reference, count mismatch or failed root/cleanup refuses a real receipt; no catch-and-fallback path.

The bounded Rust example `crates/freshell-agent-runtime/examples/opencode_restoration_rehearsal.rs` supplies only fixed export/import/read stages to that owner driver using public `freshell_sessions::opencode_transfer::export_exact_session`, `ExportOptions::new`, `freshell_agent_runtime::opencode_transfer::import_bundle_payload` and `verify_installed_store`/`InstalledStoreReaderContext`. It accepts `--stage export|import|read --request-file <private-json>`; the request is a driver-created exact scratch descriptor with source snapshot/store/root, extraction/destination/workspace paths, candidate/image and provider context. It has no model/start/resume or shell/SQL interface. Export uses the independently consistent private snapshot; import consumes the verified descriptor/payload as the provider UID; read uses exact installed native reader context. Serialized bytes remain in private files/pipes and stage stdout is body-free status/count/digest/reference only. The driver invokes these fixed stages in the existing owned rig, then the pinned native read/export decoder without opening a conversation; normal pipeline tests call the same public APIs and fixture decoder as the current unprivileged UID. The fixture decoder is not pinned-native qualification. This is a transfer validator, not deployment code or a general probe framework. Add this driver to `tsconfig.runtime.json`; Rust example compilation is checked explicitly below and by existing all-target Clippy. Define the separate finite `opencode-native-transfer-check.ts` CLI with required `--image-digest <sha256:...> --case all`; `all` expands exactly to `native-transfer-boundaries`, `semantic-schema`, `attachment-authority`, and `saved-revert-cleanup`. It uses existing `RuntimeHarness` and the same Rust example stages with fresh synthetic stores only, UID 65534/GID 0, zero capabilities/read-only root and writable private volume, then pinned native decoder/read/export/cleanup transitions. It produces body-free per-case originals and positive selected/executed/passed/failed/cleanup counts, refuses missing image/selectors, failures/zero/skips or leaked owned resources, and has no real-source fallback. Default-included `opencode-native-transfer-check.test.ts` executes finite dispatch/refusal/count derivation/cleanup with child fixtures without Docker/CLI; that coverage never qualifies the native matrix. Execute every genuinely missing native branch before its fix and preserve its intended behavior failure; imported already-fixed branches use actual prior red evidence plus current positive native execution. Task 1 cannot finish until this separate native matrix passes on garageserver; repeat on the final candidate before PR/readiness. It never substitutes for actual managed browser recovery; no seven-real-root rehearsal remains required.

Apply this exact contract patch: add authenticated `POST /api/runtime/soul-loss-repairs/preflight`, accepting the exact inspected source-store reference and root selection. The supervisor independently reads the qualified source and registry, resolves every eligible stopped false-loss target for those roots, and returns a read-only `RepairBatchScope` preview with a scope ID computed from its complete source/member/revision descriptor using the existing digest helper; it creates no live registry row. The request cannot define its own expected target set: on first apply the supervisor independently resolves that same scope again, compares the scope ID and every submitted member/revision/choice, then stores the validated original scope transactionally in the existing stopped-repair operation. A completed/pending retry loads that original operation scope and validates its exact operation progress rather than regenerating removed incidents. No signature/key/audit system is introduced. Return body-free exact members/revisions/fingerprint and typed owner alternatives. The existing `POST /api/runtime/soul-loss-repairs` restore route/runtime-client/protocol pass `scope_id` to `validate_exact_batch(&scope)`; missing/unknown scope or any member, revision, root mapping, eligible-owner or source-fingerprint drift refuses before import. Freeze scope with the repair operation and recheck its CAS at commit; completed retries use the same original scope and durable progress rather than resolving withdrawn rows anew. Replace eight assumptions with equality against these frozen sets, including admission/CAS/withdrawal/results. Counts derive from the sets; no production 9/7 or 8 constants remain. Replace positional `targets[7]` duplicate handling with grouping by exact `(source_store_id, native_root_id)` and canonical-owner evidence. A sole eligible owner is chosen; multiple eligible candidates require explicit typed selection matching the current revision; no eligible owner blocks. Preserve receipt/import and exact CAS fencing. Execute schema-7 migration/backfill and exact unbound-legacy admission against the nine-row shape before treating protected identity/import revisions as usable. Current F02 metadata has two equally eligible duplicate pairs; historical owner selection required deliberate typed strategy, independent of chronology; no owner selection is part of the current deployment. Reconcile the three sessions wiring overlaps by retaining current Codex modules/dependencies/indexing and adding OpenCode export wiring. Do not remove current-main fixes. Replace raw sqlite_master formatting-hash equality with narrow semantically qualified source-schema relationships and exact migration-set checks; do not use blanket SQL normalization or accept an arbitrary new schema. Native asset recognition follows the pinned FilePart/tool-attachment authority positions while preserving arbitrary metadata and source attribution unchanged. Snapshot lookup uses native datahome/snapshot/project-ID/SHA1(canonical real Git worktree), with exact tree closure and managed representation checks. One current saved tree is unavailable at the inspected workspace and derived pinned store; this is not global absence. Retain its reference and complete source graph, search only qualified retained artifact locations, and qualify supported preservation/asset representation rather than fabricate a tree. Ordinary native prompt cleanup removes reverted messages/parts and clears revert without snapshot.restore; admit that current projection only through proven pinned native transition authority while retaining the immutable imported baseline independently. Undo/unrevert still needs the exact saved tree: do not report recovered undo assets without it. Full bounded serialization, actual destination capacity, complete closure/import and provider-UID readability remain gates for all seven roots; raw SQL size or operator reads do not clear them.

- [x] **Step 4: Run the focused test**

Run: `cargo test -p freshell-runtime-protocol stopped_repair_exact_batch_nine`

Run: `cargo test -p freshell-supervisor restore_lost_souls_nine`

Run: `cargo test -p freshell-agent-runtime durable_souls_rehearsal_pipeline`

Run: `pnpm run test:vitest run test/unit/tooling/testing/opencode-restoration-rehearsal.test.ts --config config/vitest/vitest.config.ts`

Run: `cargo test -p freshell-sessions -p freshell-agent-runtime -p freshell-supervisor -p freshell-session-host durable_souls_`

Run: `pnpm run test:vitest run test/unit/lib/managed-runtime-wire.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS with nonzero execution of all named count and added regression families using ordinary unprivileged current-UID fixtures. The separate mandatory driver supplies pinned-native consumer evidence. Historical eight-batch tests run the revised behavior; no static contract-copy assertion replaces them.

Run: `pnpm run typecheck:runtime`

Run: `pnpm run test:vitest run test/unit/tooling/testing/opencode-native-transfer-check.test.ts --config config/vitest/vitest.config.ts`

Resolve the Task 1 candidate image digest on the owned garageserver rig and set owning-shell `opencode_transfer_image_digest` to that exact immutable digest recorded in the task report. Run: `pnpm exec tsx scripts/testing/opencode-native-transfer-check.ts --image-digest "$opencode_transfer_image_digest" --case all`

Expected: PASS for exactly four selected/executed native case groups, each with positive assertions, zero failed/skipped groups and verified owned cleanup. This native matrix is separate from normal cargo tests.

- [x] **Step 5: Refactor while green**

Consolidate exact-scope equality and source/revision checks in one shared validator; derive counts/replies from frozen operation state. Keep grouping/owner validation shared between preflight and CAS, without widening admission to arbitrary bulk operations.

- [x] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-sessions -p freshell-runtime-protocol -p freshell-runtime-client -p freshell-agent-runtime -p freshell-supervisor`

Run: `cargo test -p freshell-session-host`

Run: `cargo test -p freshell-server --features managed-runtime-v1`

Run: `pnpm run test:vitest run test/unit/extensions/opencode-rebind-plugin.test.ts test/unit/lib/managed-runtime-recovery.test.ts test/unit/lib/managed-runtime-retry.test.ts test/unit/client/components/ManagedRuntimeRecoveryCard.test.tsx test/unit/tooling/testing/runtime-test-broker.test.ts --config config/vitest/vitest.config.ts`

Run: `pnpm run test:vitest run test/unit/lib/managed-runtime-wire.test.ts --config config/vitest/vitest.config.ts`

First regenerate the production contract after schema edits with `pnpm exec tsx port/contract/generate-managed-runtime-contract.ts`. Then run `pnpm run test:vitest run test/unit/port/managed-runtime-contract-freeze.test.ts --config config/vitest/vitest.port.config.ts` while that existing file remains. Only if it still blocks the required change after regeneration, record the executed blocker and delete the static test under the user's rule; never update its expected text or delete it because pre-regeneration output differed. Run the default-included behavioral wire/client and Rust route tests regardless. Stage a conditional deletion separately with `git add -u test/unit/port/managed-runtime-contract-freeze.test.ts`.

Run: `node --test test/e2e-browser/fixtures/managed-opencode-host-status.node-test.cjs`

Run: `cargo check -p freshell-agent-runtime --example opencode_restoration_rehearsal`

Run: `cargo test -p freshell-agent-runtime durable_souls_rehearsal_pipeline`

Run: `pnpm run test:vitest run test/unit/tooling/testing/opencode-restoration-rehearsal.test.ts --config config/vitest/vitest.config.ts`

Run: `cargo fmt --all --check`

Run: `cargo clippy -p freshell-sessions -p freshell-runtime-protocol -p freshell-runtime-client -p freshell-agent-runtime -p freshell-supervisor -p freshell-session-host -p freshell-server --all-targets --features freshell-server/managed-runtime-v1 -- -D warnings`

Run: `pnpm run typecheck`

Before the six offline crash-parent commands, populate the same sandbox Cargo registry/git volumes from the updated lockfile. Run: `scripts/sandbox-test.sh "cargo fetch --locked"`. Expected: PASS in the ordinary isolated bridge-network sandbox. Then keep `--runtime-suite` network-free for every destructive run; repeat the locked prefetch after any later dependency change, never enable networking in a destructive runtime suite.

Run: `scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-supervisor opencode_transfer_queue_recovers_after_supervisor_process_crash -- --ignored"`

Run: `scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-supervisor opencode_transfer_promoted_queue_recovers_after_supervisor_process_crash -- --ignored"`

Run: `scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-supervisor opencode_transfer_import_stage_recovers_each_durable_file_boundary_after_process_crash -- --ignored"`

Run: `scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-agent-runtime opencode_importer_restarts_after_native_transaction_boundaries -- --ignored"`

Run: `scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-session-host opencode_host_restarts_at_receipt_and_pre_pty_durable_boundaries -- --ignored"`

Run: `scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-supervisor opencode_registry_readiness_commit_survives_process_crash_and_reopen -- --ignored"`

Expected: PASS with newer Codex reconstruction intact and all six imported crash-parent matrices executed. Assert every selector has nonzero cases. Host-default ignored destructive cases do not count as executed. No capability/real-provider qualification is claimed by this task.

- [x] **Step 7: Commit the task**

Stage only the reconciled OpenCode implementation and its exact fixture/tests, excluding unrelated source dirty files or historic plan edits. Explicitly stage the required rehearsal driver/adapter/test/config with `git add scripts/testing/opencode-native-transfer-check.ts test/unit/tooling/testing/opencode-native-transfer-check.test.ts scripts/testing/opencode-restoration-rehearsal.ts crates/freshell-agent-runtime/examples/opencode_restoration_rehearsal.rs test/unit/tooling/testing/opencode-restoration-rehearsal.test.ts crates/freshell-agent-runtime/src/opencode_transfer_tests.rs tsconfig.runtime.json`. Run `git diff --cached --stat`, inspect every staged path, then `git commit -m "fix(runtime): integrate exact nine-soul OpenCode repair"`. Preserve replayed atomic source commits and record the capture hashes and final source/destination provenance in the external task report.

### Task 2: Publish provider configuration under its real filesystem identity

**Files:**
- Create by bounded source reuse: `crates/freshell-platform/src/provider_environment.rs`.
- Modify: `crates/freshell-platform/src/lib.rs`, `crates/freshell-session-host/src/main.rs:1180`, `crates/freshell-supervisor/src/recovery.rs:2064`, `crates/freshell-supervisor/src/backend.rs`, `crates/freshell-supervisor/src/registry.rs`, `crates/freshell-runtime-protocol/src/lib.rs` for launch-time profile compatibility and retained-host capability handling.
- Create: `scripts/testing/probe-provider-config-readonly-home.py` from a coherent independently reviewed snapshot if available; otherwise implement that bounded probe here.
- Modify: `crates/freshell-server/src/managed_provider_bootstrap.rs`, `crates/freshell-session-host/src/provider_secret_resolution.rs`, `crates/freshell-platform/src/managed_child_secrets.rs` only for necessary typed provider-specific auth/CA preparation.
- Modify necessary controller and rig dependencies: `crates/freshell-server/src/managed_mcp_capability.rs` for actual bounded controller publication, `crates/freshell-server/src/managed_runtime.rs` and `crates/freshell-server/src/fresh_agent_proxy.rs` for preparation-result propagation, `crates/freshell-server/src/managed_runtime_api_stop_tests.rs` for mechanical nullable launch-policy fixture compatibility, `crates/freshell-supervisor/src/backend/native_history.rs` for the existing read-only current-image compatibility helper, and `scripts/testing/runtime-sandbox.ts` plus `scripts/testing/runtime-amplifier-onecli.ts` solely for exact typed CA admission to the owned rig. These are the named implementation dependencies of this same task, not additional functionality.
- Modify creator-ledger dependencies: `crates/freshell-sessions/src/amplifier_stub.rs` for actual-created inode and atomic seed-output bookkeeping, and `crates/freshell-session-host/src/providers/mod.rs` solely to propagate created paths.
- Adapt mechanical execution dependencies: `crates/freshell-session-host/src/retained_store.rs` for the read-only current-image exact OpenCode graph worker; `crates/freshell-supervisor/src/service.rs` for retaining authenticated Hello features and nullable policy propagation; `crates/freshell-supervisor/src/loss_report_tests.rs` for the mechanical nullable-policy fixture; `docker/runtime/Dockerfile` solely to preinstall the ordinary selected Amplifier profile’s three exact pinned native modules; `scripts/testing/runtime-test-broker.ts` and its existing `test/unit/tooling/testing/runtime-test-broker.test.ts` solely to admit that receipt-owned read-only helper; and `test/unit/tooling/testing/runtime-amplifier-onecli.test.ts` for executable typed CA admission. These resolve required publication/compatibility/profile callsites under execution preflight without adding functionality.
- Create: `scripts/testing/task002-config-legacy-fixtures.ts` for the finite owned actual config blocker, immutable historical creator upgrade, concurrent writer and interrupted retry matrix; extend the existing `scripts/testing/runtime-sandbox.ts` artifact admission solely to bind these prebuilt exact fixture binaries. Mechanically correct the existing `test/e2e-browser/helpers/managed-runtime.ts` obsolete type-only import to the existing Rust fixture `E2eServerInfo`, as required by the exact browser definition typecheck. Include the driver in `tsconfig.runtime.json` for the existing no-emit runtime typecheck. Reuse the existing owned RustServer helper and actual MCP producer, with isolated synthetic HOME, no operator configuration/grants or inference.
- Test: inline platform provider environment, server resolver/bootstrap, runtime-protocol profile/CA serialization and session-host configuration tests, `test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts`.

**Interfaces:**
- Consumes: exact typed bootstrap references and owned provider HOME/UID/GID; existing bounded copier and projection API from the environment source, reviewed against its two recorded Critical defects.
- Produces: atomic refresh with staging inside an existing writable provider volume, preservation of pre-existing inodes/siblings on failure, creator-owned path ledger, and projection/readability under actual provider identity. Existing blocked souls can retry the exact root after fixture dependency repair. Persisted/versioned launch-time policy defines ownership matching; narrow legacy recognition preserves saved identity/digest and distinguishes an owned policy mismatch from a foreign enclosure. Authenticated reattach requires the needed host capabilities, qualified store evidence and current native observation; an alive status never bypasses a blocked reader. Provider-specific CA reference support, if needed, uses exact canonical private regular-file references named in Global Constraint 6, typed protocol/bootstrap allowlisting, and provider-owned `.config/onecli/gateway-ca.pem` publication; this includes conditional Claude CA support with native Node `NODE_EXTRA_CA_CERTS` pointing only to that mounted provider-owned path, covered by bootstrap/resolver/protocol/provider-UID readability and actual trust tests. Supply the actual supported native trust variable for each selected provider pointing to that mounted path. No generic environment-name pass-through or unmounted CA path is accepted.

- [x] **Step 1: Write the failing behavioral test**

Extend default production copier/publication tests with normal current-UID owned temporary directories and deterministic filesystem/publication fault injection; prepare a pre-existing config containing executable-resource and unrelated sibling sentinels. They call the actual production copier/projection and require no root/sudo, UID switch, Docker, second physical filesystem or installed CLI. Separately extend finite owned `probe-provider-config-readonly-home.py` to repeat initial/resume/fault publication as UID 65534/GID 0 with zero capabilities, read-only container root and writable provider HOME on a verified different filesystem (record distinct device IDs); no current-account fixture result qualifies that physical boundary. Inject a copy/publication failure after replacing the first file. Assert original inode/bytes and siblings survive, no staging escapes the provider volume, the next refresh succeeds, and OpenCode expectation publication is readable/writable under the same provider identity. Add resolver-to-bootstrap-to-publication tests for typed selected-agent auth mode/stub shape, private CA reference/readability, valid typed-auth plus proxy-only environment, conflicting auth mode, alias disagreement/loopback refusal, native trust path and refresh ownership. In an owned rig, create a soul blocked by this permission failure, fix only its fixture config dependency, retry, and assert same soul/native root/store plus exactly one replacement. Define independent synthetic browser cases `synthetic config-blocked exact retry` and `synthetic legacy retained-runtime exact retry` in `runtime-managed-provider-qualification-rust.spec.ts`, gated by exact `FRESHELL_RUNTIME_SYNTHETIC_RESUME=1` independently of provider live qualification; the first covers the config blocker, the second the legacy fixtures below. Task 8 executes both on configured Cloud without Task 9 native semantics. Do not use a current-account temp-directory pass as the real-identity proof. Add a scratch retained-container fixture for the exact known legacy mount shape (/tmp and /run/opencode-tmp, no /run/freshell-private and no provider context requiring it), matching saved labels/full ID/image/digest; test narrow recognition across supervisor upgrade, epoch 1 to 3, extra/missing/foreign mounts, unreachable or capability-unknown old host, blocked store with exited=false, exact fenced replacement, interrupted retry and one writer. A mutable host binary pathname does not identify the old running build. Record detailed pre-attempt matcher/capability/store reason before retry budget is consumed.

- [x] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-platform provider_environment`

Run: `cargo test -p freshell-session-host provider_config`

Prepare the owned pre-fix candidate session-host/image and extended finite fixture probe before publication fixes; do not overwrite or invoke the live binary. Run: `python3 scripts/testing/probe-provider-config-readonly-home.py --image freshell-managed-runtime:phase2 --binary target/release/freshell-session-host`

Expected: three positive native initial/refresh/rollback-fault groups execute; missing publication behavior FAILS with actual UID/capabilities/distinct-filesystem evidence. Missing binary/image is a setup failure, never red. Default Rust tests independently FAIL on staging/rollback/ownership behavior. If a captured source fix already passes, retain its pre-fix failing receipt and verify the test against the rejected `c4c55c1a2` implementation in an isolated scratch checkout; do not revert the source or destination to manufacture red.

- [x] **Step 3: Add the minimal production implementation**

Integrate only the bounded provider-environment fix from `c4c55c1a2` plus repair `5033898b4`, including writable-HOME staging and replacement recovery, after independently validating captured committed bytes; never trust rejected `c4c55c1a2` alone. The repair's exact three paths are provider_environment.rs, session-host main.rs and the Python probe; review any needed later `d39188f1f` changes independently and reuse only bounded relevant bytes. Reconcile against Task 1 launch/import gates rather than replacing main.rs wholesale. Source-to-stage copying reads canonical bounded files; stage files and parent directories are creator-owned inside the writable provider volume. Run private destination operations as the owning provider UID/GID, using the repository's subprocess privilege drop. Write/sync replacement files before rename, retain prior inode references until all publication steps succeed, and restore each replaced inode on failure. Cleanup removes only paths in this attempt's creator-owned ledger. Preserve executable resources without following escaped paths. Refresh the selected TUI/plugin config and adoption expectation under the same identity on exact resume; return a typed recoverable permission/preparation blocker with structured context. Persist/version the launch-time profile for new enclosures and recognize only the exact known legacy profile when every protected ownership comparison still matches; never ignore mount policy broadly or rewrite saved digest. Retain required Hello capabilities and reject an old host whose feature semantics are unknown. If exact reattach cannot qualify current store and native observation, use the existing verified-empty-before-replacement transaction only after retained-store/current-image compatibility passes in scratch. Preserve blocked stores on unknown compatibility, never fall back to a new root. Before Task 4 native probes, privately prepare genuine selected-provider authorization through OneCLI on garageserver. Its process-local API is 127.0.0.1:10254 and gateway 10255; host loopback is not container reachability. The earlier 20-row inventory was capped and does not establish Anthropic absence. Establish exact project/organization/selected-agent authority and deployed response contract, obtain complete metadata privately, and prefer supported genuine existing grants. Initialization-capable preparation belongs to implementation, distinct from read-only Stage 2; never expose raw responses or secret values. Generic secret --file sends bytes verbatim and does not extract native Claude OAuth JSON. Actual Haiku access remains separately required for terminal Claude/FreshClaude/Kilroy.

Use the effective selected-agent server contract with a typed private response retaining credentialStubs: installed generic CLI decoding drops that field, and standalone Codex stubs select capped project-first metadata. Validate scope/auth mode, use the supported Codex-shaped OAuth stub and preserve native ChatGPT precedence. Narrowly allow proxy/CA-only transport with valid typed auth if needed; do not invent a dummy key. OpenCode requires its own provider-keyed OAuth format and qualified client/gateway expiry/refresh ownership, not copied Codex JSON. Preserve existing grants and validate effective source-agent scope. Stage approved CA bytes at exact per-provider paths and actual native trust variables (including Rust Codex SSL_CERT_FILE); add typed CA support only where needed. Prove provider-UID reads, container gateway network/HTTP/WS/CA and controlled refresh before campaigns. File/policy presence never proves entitlement.

Amplifier uses the intended effective agent (prior LunaRoute metadata belongs to garageserver), identified ordinary bundle/provider configuration and resolved module/logging revisions. Generic bootstrap does not automatically select specialized LunaRoute-to-VLLM mapping; use supported VLLM api_key/base_url/model config or bounded managed mapping and prove native lunaroute instance alias plus actual upstream origin. CLI pins do not freeze dynamic bundles. Receipt relabeling/model aliases cannot substitute for native evidence. Preserve Kilroy's documented bootstrap exception. Repair failed grant/network/profile prerequisites before early native gates or broad qualification. Do not broaden privileges or mutate host config.

- [x] **Step 4: Run the focused test**

Run: `cargo test -p freshell-platform provider_environment`

Run: `cargo test -p freshell-session-host provider_config`

Build/prepare the owned candidate session-host and `freshell-managed-runtime:phase2` image through the existing runtime rig first, binding their resulting digest/hash in the task report. Run: `python3 scripts/testing/probe-provider-config-readonly-home.py --image freshell-managed-runtime:phase2 --binary target/release/freshell-session-host`

Expected: PASS, and the real rootless probe reports UID/GID, zero capabilities, read-only root, writable volume, successful selected-plugin exact-resume refresh and full rollback preservation after the first replacement. The separate fault case must verify every original inode/byte/sibling survives, rather than count initial preparation as rollback proof. The probe owns and cleans only its labeled fixture containers/volumes; missing native prerequisites or zero/skipped cases fail nonzero. Require positive selected/executed counts for initial, exact-resume refresh and rollback-fault groups, distinct filesystem device evidence, and zero failed/skipped groups. Preserve executed native behavioral red before missing publication fixes (or imported pre-fix evidence for already repaired branches). This mandatory garageserver gate is separate from ordinary cargo CI and repeats on the final candidate before PR/readiness.

- [x] **Step 5: Refactor while green**

Keep one bounded copier/publication implementation for initial and resumed launch. Share the replacement ledger and typed failure conversion; avoid a second bootstrap-only path with different ownership semantics.

- [x] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-platform -p freshell-runtime-protocol -p freshell-agent-runtime -p freshell-session-host -p freshell-supervisor -p freshell-server --features freshell-server/managed-runtime-v1`

Expected: PASS, including initial setup, concurrent selected-config generation, plugin expectation write and blocked exact-resume retry. The actual browser scenario runs through Task 8's supported cloud topology before final completion.

- [x] **Step 7: Commit the task**

Run: `git add crates/freshell-platform/src/provider_environment.rs crates/freshell-platform/src/lib.rs crates/freshell-session-host/src/main.rs crates/freshell-supervisor/src/recovery.rs crates/freshell-supervisor/src/backend.rs crates/freshell-supervisor/src/registry.rs crates/freshell-runtime-protocol/src/lib.rs scripts/testing/probe-provider-config-readonly-home.py crates/freshell-server/src/managed_provider_bootstrap.rs crates/freshell-session-host/src/provider_secret_resolution.rs crates/freshell-platform/src/managed_child_secrets.rs test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts crates/freshell-server/src/managed_mcp_capability.rs crates/freshell-server/src/managed_runtime.rs crates/freshell-server/src/fresh_agent_proxy.rs crates/freshell-server/src/managed_runtime_api_stop_tests.rs crates/freshell-supervisor/src/backend/native_history.rs scripts/testing/runtime-sandbox.ts scripts/testing/runtime-amplifier-onecli.ts crates/freshell-sessions/src/amplifier_stub.rs crates/freshell-session-host/src/providers/mod.rs crates/freshell-session-host/src/retained_store.rs crates/freshell-supervisor/src/service.rs crates/freshell-supervisor/src/loss_report_tests.rs docker/runtime/Dockerfile scripts/testing/runtime-test-broker.ts test/unit/tooling/testing/runtime-test-broker.test.ts test/unit/tooling/testing/runtime-amplifier-onecli.test.ts scripts/testing/task002-config-legacy-fixtures.ts tsconfig.runtime.json test/e2e-browser/helpers/managed-runtime.ts`

Run: `git commit -m "fix(runtime): refresh provider config with owned filesystem identity"`

### Task 3: Prevent unsupported absence and loss certification

**Files:**
- Modify: `crates/freshell-supervisor/src/recovery.rs:1928`, `resume_catalog.rs`, `backend.rs` (existing owned-volume census caller), `backend/native_history.rs`, `loss_report.rs`, `loss_report_tests.rs`, `crates/freshell-session-host/src/main.rs`, `crates/freshell-agent-runtime/src/lib.rs` (the actual online provider-store readers).
- Test: existing recovery/loss/native-history test modules, inline agent-runtime provider-store behavior tests, `crates/freshell-supervisor/src/registry.rs`'s existing source-inventory behavior fixture (actual reader evidence at each captured revision), and `crates/freshell-server/src/managed_runtime_api_stop_tests.rs`'s existing Stop/history/scoped-route fixtures (actual reader evidence).

**Interfaces:**
- Consumes: `RecoveryContext`, `RecoveryProbe`, `EvidenceStoreState`, existing qualified exact-source census and verified `ResumeSpec`.
- Produces: `RecoveryProbe::Blocked` for dispatched coding souls without independent identity/storage proof; `DefinitivelyUnavailable` only for complete qualified exact absence. No new negative-evidence shortcut or session-selection heuristic.

- [x] **Step 1: Write the failing behavioral test**

Add `dispatched_missing_identity_cannot_certify_loss` beside the current offline probe tests: use the existing dispatched coding context fixture, clear `native_session_id` and `resume_spec`, retain provider volume evidence, and run both online and offline production probes and the two-probe/final loss path. Assert Blocked/unknown, no loss certificate/outbox/tombstone, no provider-volume deletion, no replacement, and preserved outputs. Parameterize Claude, Codex, OpenCode, Amplifier and requested fresh modes freshclaude, Kilroy, freshcodex and freshopencode. Add unreadable, missing mount, incomplete/depth/byte-bound census, ambiguous root, conflicting identity and reader failure cases. Keep a fully inspected exact-row absent case that does certify genuine absence, a proved pristine-seed case, and existing shell terminal-end tests.

- [x] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-supervisor dispatched_missing_identity_cannot_certify_loss`

Expected: FAIL because `offline_probe` currently labels native resume definitively unavailable and store Missing without provider inspection.

- [x] **Step 3: Add the minimal production implementation**

Patch `offline_probe` in this order: preserve verified saved spec; preserve identity-without-spec blocker; preserve `never_dispatched` proof; for a dispatched coding provider with no verified exact native identity/spec, return the existing NativeResume StoreUnreadable blocker with reason `provider identity or exact storage census has not been verified`, rather than falling through checkpoint absence. Do not make the guard apply to a qualified shell policy. Online native readers and host probing apply the same invariant. A reader result is Absent only after complete canonical store inspection for the exact requested root under real provider identity/environment, with all candidates inspected and no truncation/errors/ambiguity; otherwise retain Unresolved/Blocked. `exact_resume_candidate` returning None for missing identity is unknown, never a missing-store certificate. Checkpoint absence cannot upgrade unknown native state. Final loss CAS revalidates qualified census/identity/intent generations and rejects any earlier unsupported negative. Retain imported-baseline receipts independent of transient recovery state.

- [x] **Step 4: Run the focused test**

Run: `cargo test -p freshell-supervisor dispatched_missing_identity_cannot_certify_loss`

Run: `cargo test -p freshell-supervisor loss_report`

Expected: PASS for conservative unknown state and legitimate fully inspected loss, with no destructive effect in blocked cases.

- [x] **Step 5: Refactor while green**

Centralize native evidence classification in the existing native-history/loss boundary; remove duplicate missing-ID absence conversion. Keep evidence bodies outside the registry; persist body-free qualified receipt references/generations only.

- [x] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-agent-runtime -p freshell-session-host -p freshell-supervisor`

Expected: PASS for source census, true loss, pristine seed, materialization fencing, baseline retry persistence and retained output. No loss test is skipped or weakened.

- [x] **Step 7: Commit the task**

Run: `git add crates/freshell-supervisor/src/recovery.rs crates/freshell-supervisor/src/resume_catalog.rs crates/freshell-supervisor/src/backend.rs crates/freshell-supervisor/src/backend/native_history.rs crates/freshell-supervisor/src/loss_report.rs crates/freshell-supervisor/src/loss_report_tests.rs crates/freshell-session-host/src/main.rs crates/freshell-agent-runtime/src/lib.rs crates/freshell-supervisor/src/registry.rs crates/freshell-server/src/managed_runtime_api_stop_tests.rs`

Run: `git commit -m "fix(supervisor): require inspected evidence before native loss"`

### Task 4: Require provider-observed identity for every replacement

**Files:**
- Modify: `crates/freshell-freshagent/src/codex.rs` only for the read-only current registered live-session incarnation accessor backed by existing sidecar ownership identity, consumed by HostedTransport's proven pre-mutation rollback-refusal settlement. Preserve all native handlers, mutation, observations and ownership semantics; actual hosted-adapter behavioral tests cover unchanged and replaced runtime.
- Create: `crates/freshell-session-host/src/providers/native_identity.rs`, `scripts/testing/runtime-native-feasibility.ts`, `test/unit/tooling/testing/runtime-native-feasibility.test.ts`.
- Modify: `crates/freshell-session-host/src/providers/mod.rs`, `crates/freshell-session-host/src/providers/fresh_agent.rs`, `crates/freshell-session-host/src/pty.rs:133`, `crates/freshell-session-host/src/main.rs`, `crates/freshell-platform/src/cli_launch.rs`, `crates/freshell-runtime-protocol/src/lib.rs`, `crates/freshell-supervisor/src/recovery.rs:1786`, `crates/freshell-supervisor/src/service.rs`, `crates/freshell-supervisor/src/registry.rs`, `extensions/opencode/freshell-rebind-plugin.ts`.
- Modify: `crates/freshell-server/src/managed_runtime.rs` for the managed launch environment seam; `crates/freshell-freshagent/src/claude.rs`, `crates/freshell-claude-sidecar/index.mjs`, `crates/freshell-claude-sidecar/permission-channel.mjs`, `crates/freshell-agent-runtime/src/host_actor.rs`, `crates/freshell-agent-runtime/src/host_actor_tests.rs` for normalized init, native permission/result propagation and bounded pending continuation; `docker/runtime/Dockerfile` for pinned native adapter application.
- Modify: `shared/managed-runtime.ts`, `port/contract/managed-runtime.schema.json`, `test/unit/lib/managed-runtime-wire.test.ts` for additive observation projection and behavioral parsing/legacy compatibility. Conditional remove: `test/unit/port/managed-runtime-contract-freeze.test.ts` only on an executed static-comparison blocker, as in Task 1.
- Modify: `tsconfig.runtime.json` to include `scripts/testing/runtime-native-feasibility.ts` in its actual NodeNext explicit include list when created.
- Create: `crates/freshell-runtime-protocol/examples/native-identity-wire.rs` to emit actual current Rust DTO serialization for the behavioral TypeScript parser/consumer test, rather than a static copy assertion.
- Modify: `scripts/testing/runtime-sandbox.ts` only for the finite owned native preparation/cleanup seam consumed by the early runner; `crates/freshell-supervisor/src/resume_catalog.rs` and `crates/freshell-server/src/managed_runtime_api.rs` only for mechanically necessary launch/context/view fixture callers.
- Modify: `crates/freshell-supervisor/src/resume_catalog.rs` additionally only for fresh Claude/logical Kilroy `provider_version` selection of the independently observed SDK default child 2.1.237 through the existing inventory authority. Modify `docker/runtime/provider-versions.json` only to add the optional Claude `sdkNativeVersion` pin, `crates/freshell-agent-runtime/src/provider_inventory.rs` only for its bounded fresh mode-aware reader and inline behavioral tests, and already-owned `lib.rs` only for the necessary re-export. Missing SDK pin stays unknown/refused without terminal fallback; preserve terminal 2.1.263, other records/modes, stored immutable ResumeSpecs, all guards, schema/package/image behavior, with no new file/framework/wire or Task9 TypeScript consumer change.
- Modify: `crates/freshell-server/src/fresh_agent_proxy.rs` for finite structured observations at the existing managed-create failure boundaries and only the existing `FreshProvider::native_family()` selection for its three native dependency calls (`issue_mcp_capability`, named OneCLI references, and provider launch context). Test its executed missing-cwd, typed supervisor Launch refusals, and logical Kilroy/native Claude dependency preservation in `crates/freshell-server/src/fresh_agent_proxy_tests.rs`, with only that target admitted to the existing `crates/freshell-server/src/test_trace_capture.rs` collector. Preserve public 503 behavior, logical provider/session/runtime variant, the Kilroy raw bootstrap exception, message/body/path exclusion, allowlists, and all native/store/credential gates; this records the root-authorized necessary managed-launch caller and its behavioral test dependencies.
- Modify: `crates/freshell-supervisor/src/backend.rs` only to include logical Kilroy in the existing bounded private tmpfs mode match shared by creation and ownership validation, with executed create/ownership and changed-mount refusal tests. Preserve the existing 16MiB/noexec/nosuid/nodev/0700 policy, read-only root, UID/GID/capabilities, logical identity, raw bootstrap exception and legacy fences; this is the root-authorized caller adaptation for the observed managed Kilroy configuration publication failure.
- Modify: `crates/freshell-supervisor/src/loss_report_tests.rs` only for the shared setup helper and required imports: bind the actual current launch and record a controlled matching OpenCodeTui observation through the real registry APIs before initial Running publication. Preserve fixture=None, every loss assertion and production guard; this root-authorized existing-test caller adaptation is controlled setup, not native qualification.
- Modify: `crates/freshell-server/src/managed_runtime_api_stop_tests.rs` only for `fixture_fresh_soul_with_cleanup` setup and necessary imports: bind the actual current execution grant/incarnation/nonce/revision/generation/requested native ID and record a controlled matching FreshProviderHandshake through real registry APIs before the existing Running publication. Preserve fixture=None, existing allocation setup, every assertion and all production gates; this ROOT-authorized sibling caller correction is controlled setup, not native qualification. The existing registry.rs `bind_native_identity_launch` and `record_native_identity_observation` visibility may change only from pub(crate) to pub, preserving signatures, bodies and all guards.
- Create: `crates/freshell-claude-sidecar/native-session-channel.mjs` for the supported native SessionStart/settings acknowledgement and checkpoint channel; `crates/freshell-claude-sidecar/native-process.mjs` for the SDK's supported custom spawn boundary and real native control-write acknowledgement. These remain within the existing sidecar, preserve actual child selection and distinguish dispatch from effect.
- Create: `crates/freshell-claude-sidecar/native-checkpoint-state.mjs` and `test/unit/claude-sidecar/native-checkpoint-state.test.ts` only for the restricted solo native checkpoint's body-free current profile/control phases and non-replayable ambiguous transitions. Mechanically update `crates/freshell-freshagent/tests/claude_sidecar_interrupt_dispatch.rs` to stage the newly imported real helper modules; preserve its actual child/interrupt assertions.
- Test: `test/unit/claude-sidecar/native-session-channel.test.ts`, `native-process.test.ts`, `native-result.test.ts`, and controlled fixtures `test/unit/claude-sidecar/fixtures/native-startup-query.mjs`, `native-result-query.mjs` exercise the actual command hook, supported child-write boundary, production sidecar no-input gate and native result projection. These prove the bounded sidecar behavior; they do not substitute for genuine managed native matrices.
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs` only for managed pre-input native session creation/load using the existing native materialization/ownership path; preserve ordinary unmanaged lazy creation. This is the actual existing API seam needed to prevent a fresh OpenCode requested-ID echo from becoming a native handshake.
- Modify: `crates/freshell-agent-runtime/src/lib.rs` only for READY classification of exact completed ordinary Amplifier native saves with known backup files and complete correlated history; preserve the existing exhaustive pristine-stub/absence/loss census unchanged. Its inline behavioral tests protect native-save readiness and malformed/truncated/wrong-root/unknown-child refusal.
- Create: `extensions/amplifier/freshell-native-resume.patch` containing only the verified pinned CLI load/context-restore acknowledgement integration, selected after the early native feasibility gate below.
- Create: `docker/runtime/prepare-amplifier-modes.py` and `docker/runtime/prepare-amplifier-profile.py` for the ordinary CLI's required packaged modes bundle/module source binding and supported AppSettings projection of its already selected provider rows. These are exact native launch prerequisites; preserve selected model, provider configuration, modes context/definitions and approval policies.
- Test: inline host/recovery/registry/actor and `crates/freshell-platform/src/cli_launch.rs` behavioral launch/child tests. Conditional remove: `crates/freshell-platform/src/cli_launch_goldens.rs` only its executed static blocker after preserving behavioral protection; no expected-copy updates.
- Test: `test/unit/claude-sidecar/permission-channel.test.ts`, `test/unit/claude-sidecar/session-settings.test.ts`, `test/unit/extensions/opencode-rebind-plugin.test.ts`, actual owned native startup/approval smoke cases in `test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts` and `runtime-managed-provider-qualification-rust.spec.ts`.

- Root exact native-resume prerequisite: crates/freshell-codex/src/remote_proxy.rs and crates/freshell-codex/tests/remote_proxy_relay.rs; crates/freshell-codex/src/remote_proxy_side_effects.rs only if necessary for truthful ThreadResumeResponse provenance/shared existing extraction and existing inline behavior tests. Already-owned crates/freshell-session-host/src/pty.rs may extend only its existing inline codex_identity_tests as needed; no other new path or observer/schema framework.

- ROOT exact controlled parity producer exception: modify existing test/fixtures/providers/parity-provider.mjs ONLY for configured current Claude hook/statusline startup production under the existing parity-specific opt-in, and existing test/e2e-browser/fixtures/fake-codex-terminal.mjs ONLY for the parity-specific pre-input current proxy handshake. These are EXACT two additional ORIGINAL Source paths, not child ownership. Preserve normal shared Enter/startup/rollout and no transcript/user-turn/model before Enter; exercise missing/stale/wrong/current-launch refusal with actual spawned producer/configured native consumer in already-owned qualification runner/unit and host inline tests. No new test module, fake OpenCode change, protocol/schema/env-allowlist/native-guard bypass or generic framework.

**Root-authorized parent-backed Claude fork prerequisite:**
- The Finding 1 repair additionally admits exactly `crates/freshell-runtime-protocol/src/lib.rs` (optional internal body-free fork recipe in ResumeSpec/host acknowledgement), `crates/freshell-agent-runtime/src/lib.rs` (distinct positive verified parent-backed store classification), `crates/freshell-supervisor/src/resume_catalog.rs` (current recipe propagation), `crates/freshell-session-host/src/providers/mod.rs` (typed positive probe conversion), `crates/freshell-freshagent/src/claude_snapshot.rs` (bounded read-only native prefix projection through the existing chain parser), and `crates/freshell-session-host/src/providers/deterministic_fresh_agent.rs` (additive fixture defaults only). Existing Task 4 actor, host, registry/service/recovery, Claude, sidecar and behavioral test paths implement the remaining integration. No additional file, public command, history writer or general provenance framework is introduced.
- Persist actual child/parent identity, provider-relative source path, cutoff or explicit empty kind, accepted native drop-turn guard and stable quiesced source digest atomically with actor operation state and registry child/writer ownership under current launch/revision fences. Preserve the private serialized Claude rollback context across actor reopen for Redo and the selected model/effort/profile. Recovery intent never substitutes for a current native observation. Ordinary child transcript proof takes precedence; only actual bounded provider-UID inspection of a matching parent recipe permits a distinct parent-backed recovery result. Missing, changed, unreadable or ambiguous source/recipe blocks without absence or loss certification.
- Invalidate the persisted parent fallback atomically before potentially accepted child input/effect dispatch in both supervisor and actor authority. An ambiguous dispatch must never reconstruct an older prefix or replay effects. The live query may retain its separately bounded verified pre-input prefix for checkpoint/input inspection. Successive Undo/Redo and first-turn empty Undo restore a recipe only through an authorized actual native transition while retaining native UUID anchors and all deferred-tool/current-query/Stop guards. Use the next actual registry migration version; retain host UID0/GID0 CapEff0xC1 and native provider/reader UID65534/GID0 CapEff0, private native 0700/0600 permissions and no provider history edits.
- Before implementation, execute meaningful RED coverage through actor/host/registry/probe for crash after fork acknowledgement before first child input, matching requested and observed child UUID, persisted current rollback context, source-backed checkpoint/input handling, before-dispatch invalidation and ambiguous-input refusal. Cover successive Undo/Redo and actor reopen, absent/changed/wrong source/cutoff, stale child/query/launch, Stop and API failures. GREEN and refactor preserve all ordinary store/input/LIVE gates, existing guard fallback, source image and ownership fences. Run affected crate/sidecar checks and prove genuine zero-input Undo, ReattachReady and exact-child recovery using the retained two-input native history, current pins/UID/TLS and exact owned cleanup. The total model cap stays three (two existing seed inputs plus at most the separately authorized one child context turn); no new seed or paid matrix repeat. Parent-backed recoverability must be reported separately from child transcript existence. This prerequisite does not grant Task 4 acceptance; independent specification and quality reviews and final gates remain unchanged.

**Interfaces:**
- Consumes: requested native root from verified ResumeSpec, authenticated current host, current incarnation and generation, per-launch random nonce, provider-native events/store reads.
- Produces: additive `NativeIdentityObservation { native_session_id: String, incarnation_id: IncarnationId, launch_nonce: String, evidence_revision: u64, source: NativeIdentitySource, evidence_digest: String }`, with serde tagged `NativeIdentitySource` values `codex_app_server`, `opencode_tui`, `claude_native_event`, `amplifier_native_loaded_context`, `fresh_provider_handshake`. `native_session_id` remains null/unobserved until this evidence passes validation. Persist requested identity separately; preserve legacy response compatibility without certifying legacy echoes. The finite early runner consumes existing `RuntimeHarness` and exact selected grants, owns candidate image/synthetic stores/cleanup, and accepts `--provider claude|codex|opencode|amplifier` or `--mode freshclaude|kilroy|freshcodex|freshopencode`, plus `--case startup|native-turn|approval-checkpoint`. Startup fault matrices cover terminal Claude/Amplifier and FreshClaude/Kilroy; approval-checkpoint is restricted to the two Claude-backed fresh modes. Native-turn selects one bounded real native turn/schema/profile inspection. Candidate packaging may use the existing test qualification routing without promoting production manifest fields. The runner stays a finite native experiment, with no arbitrary shell/production command interface or general probe framework. This native-only implementation probe is not Cloud browser qualification or a backend substitute; it must never operate on existing real roots.

- [x] **Step 1: Write the failing behavioral test**

Add `requested_identity_is_not_provider_observation` in the production host launch/status tests and `provider_observed_replacement` in supervisor's production replacement fixture. Launch a resumable test provider with the correct requested root but no native acknowledgement and a pre-existing matching transcript. Assert host status has no observed identity and supervisor replacement never becomes LIVE. Then emit wrong-root, previous-incarnation/nonce, stale evidence revision, and correct current native acknowledgement; only the final one publishes LIVE. Exercise replacement through real host status, not a direct `verify_native_identity` call alone. Add provider exit, bounded timeout, Stop cancellation and post-repair baseline-only retries; wrong or missing observation cleans only the owned failed replacement, preserves original history/root and has one writer at most. Codex retains its app-server handshake/event and durable receipt tests; OpenCode resumes must run the existing TUI observation gate even when a resume ID was requested. Reattach of an existing retained enclosure uses the same current-store/observation/capability gates; `exited=false` must not bypass Blocked or DefinitivelyUnavailable store evidence.

Extend `managed-runtime-wire.test.ts` to parse actual serialized production observations and inventory/detail projections through the exported runtime schemas and client consumer. A valid current observation round-trips, invalid source tags/missing nonce/wrong revision types refuse, and legacy payloads without observation remain unobserved instead of throwing or certifying an echo. Wrong-root/incarnation/revision checks execute the real host/supervisor gate, since syntactically valid JSON alone cannot prove binding. Do not snapshot `NativeIdentityObservation`, generated schema, prose or config text.

Add production normalized-sidecar-channel tests: real `sdk.session.init` passes through the upstream normalizer to `freshAgent.session.init` and reaches HostedTransport's native receiver; missing native cliSessionId, local placeholder/session key and wrong root cannot fill it. Typed unknown/stale permission responses and sidecar/native write failures must propagate through actor and host protocol rather than return Completed. Trace the actual tool-result/result/denial stream so callback acceptance, native dispatch and native effect completion remain different states.

Include the new runner explicitly in `tsconfig.runtime.json` now, retaining actual NodeNext/strict runtime options and `.js` relative imports; its NodeNext check is a Task 4 acceptance, not postponed to Task 8. The early runner test must execute its process dispatch/selection/ownership and failure cleanup, rejecting invalid selectors, real/unowned roots, incomplete provenance and any timeout/failure reported as success; fake dispatch proves only orchestration. Use the existing owner-side rootless harness, not the later Task 8 external browser runner.

**Earliest native feasibility slice, before broad campaigns:** use only isolated synthetic conversations, reviewed selected grants/profile and the candidate image. For terminal Claude run actual 2.1.263 no-input exact-resume with the synchronous SessionStart observation, including fork/wrong root, stale/shared signal, disabled hooks, trust refusal, unwritable path, timeout/exit/cancellation and a hook followed by restoration failure. For FreshClaude and Kilroy separately run SDK 0.3.237/default native 2.1.237 empty-input create/exact-resume, production normalized event, wrong ID and 50-second timeout cases. The SDK control initialization/startup result contains no native ID and is never proof. Establish the genuine pre-input native loader acknowledgement (including a qualified native SessionStart hook where applicable) and implement/prove that boundary if ordinary system/init is emitted only after input; no synthetic prompt, placeholder or old metadata releases LIVE/input.

For Amplifier select and identify the actual CLI/core/foundation/provider/logging bundle revisions, then prove no-input exact native resume after transcript restoration. Existing session:resume/session:start fires only on first prompt, and module-ready runs before transcript restoration. Add a narrow pinned CLI acknowledgement at the successful native load and successful context.set_messages boundary in the selected managed native route; refuse missing set_messages/load failure, rather than treating a warning-and-continue path as restored. Correlate native selected root, root parent=None, current launch and source-file identity; do not force a prompt to obtain a lifecycle event. Confine the exact pin-checked adapter to the managed image and pinned CLI boundary; record patch/effective-executable provenance and roll back by candidate image, with no host install or live mutation. Prove real no-input create/exact-resume/wrong-root/missing-history/timeout and native follow-up through this route before broad qualification; patch-text tests are not coverage.

Also prove the bounded native approval path early for both FreshClaude and Kilroy: one fixture-owned harmless solo tool, native PreToolUse defer checkpoint, durable checkpoint inspection, host/enclosure death, exact root resume with current native gate, current same-ToolUseID request, Allow/Deny, correlated native result and independently counted effect (one/zero respectively). The selected native supports defer only for print mode and a single tool batch; continuation occurs on first input and does not solve startup identity by itself. Crash before checkpoint, changed/missing tool/input/profile/root, multiple tools, stale callback and effect-before-observation retain honest interrupted/ambiguous state without automatic replay. A durable UI card is never a resurrected callback. If this restricted mechanism cannot deliver requested pending continuity, independently implement and prove a supported native alternative before broad qualification; safe refusal is containment, not qualification PASS or a permanent deferral.

- [x] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-session-host requested_identity_is_not_provider_observation`

Run: `cargo test -p freshell-supervisor provider_observed_replacement`

Run: `pnpm run test:vitest run test/unit/lib/managed-runtime-wire.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL because non-Codex PTY initializes observed ID from request and because the supervisor accepts an authenticated echo.

- [x] **Step 3: Add the minimal production implementation**

Keep requested root only in the launch specification; observed identity begins absent for all providers and is published solely from the current native acknowledgement. OpenCode's initial and resumed native TUI gate uses the actual public `slots.register({slots: ...})` wrapper, whose host supplies the registration ID; do not add an unsupported caller ID. Derive the active V1 message tail using saved full/part revert semantics, rather than the raw last message, and qualify exact-root hydration completion. Global TUI ready or a V2-empty projection alone cannot prove V1 active history is loaded/empty. Preserve the independent full baseline/store check, nonce/incarnation/generation revalidation and input blocking. Run actual null-slot render/disposal, root/load-error, V1/V2 empty, full/part revert, baseline-only resume and cancellation cases against the pinned TUI.

Claude terminal reuses the enabled synchronous native SessionStart contract but gives each managed launch a provider-owned writable signal directory and a typed supported launch binding. Include the durable settings validator/regenerator (currently two approved recipe hashes) and managed environment allowlist in the change; either a host-local typed overlay or an approved bounded parameter must survive that boundary and old saved recipe conversion. Preserve selected ordinary settings/policies; absent/disabled/trust-denied/write-failed hook blocks explicitly. Verify session_id/source=resume from the actual loader against current root/nonce/incarnation, reject fork/shared old evidence, and keep host exit/restoration failure meaningful after emission.

Amplifier uses the early-proven native loaded-context acknowledgement described above. Identify the selected bundle/module revisions and preserve ordinary selected configuration. Bind file device/inode identity and captured EOF prefix across reads; reject first-file absence without qualified creation, replacement/truncation/reset, old writers, malformed envelopes and parent-bearing root events. Existing prompt-time lifecycle records may corroborate later native execution but cannot release the pre-input gate.

Fresh Claude/Kilroy consume the normalized `freshAgent.session.init` at the host bridge, preserve genuine native cliSessionId/version in the upstream `claude.rs`/sidecar projection, and remove local sessionId/profile/session-key fallbacks from identity certification. Use the actually qualified native acknowledgement established by the no-prompt slice, not eager SDK control initialization. Keep actual child selection separately identified from terminal pin; native SDK 0.3.237 and default child 2.1.237 are distinct. Other fresh transports keep provider-returned exact session/thread identity on actual native load and current receiver evidence.

For pending approval, persist body-free exact root/native ToolUseID/input digest plus current native control request/incarnation/generation binding, preserve the original deferred native checkpoint, and rebind only a proven native same-operation request. Do not map orphan callbacks by display text or tool name. Expose a recoverable pending card only after the native no-effect checkpoint exists; multi-tool/non-checkpoint cases remain honestly interrupted or ambiguous. Return typed unknown/stale/cancel/write errors through real sidecar/Rust/host transport. Native dispatch acknowledgement does not imply effect; retain native tool_result, result session/UUID, supported denial/deferred fields and observed effect counts for actual completion. Existing Dispatching-to-Ambiguous/no-replay behavior remains. No general external-effect exactly-once/audit machinery is added.

The observation module hashes body-free producer evidence and validates exact current incarnation/nonce/root/revision. Host main returns typed source evidence. Supervisor waits boundedly, checks exit/Stop/cancellation, revalidates store/intent/ownership/capability before committing LIVE, and cannot replay observations across replacement incarnations. The same requirements cover legacy reattach and new replacements. Every early feasibility failure must be resolved before the mode's broad/final qualification; it never authorizes requested-ID echoes, synthetic prompts, unsupported flags or deferred completion.

- [x] **Step 4: Run the focused test**

Run: `cargo test -p freshell-session-host requested_identity_is_not_provider_observation`

Run: `cargo test -p freshell-supervisor provider_observed_replacement`

Run: `pnpm run test:vitest run test/unit/lib/managed-runtime-wire.test.ts --config config/vitest/vitest.config.ts`

Run: `pnpm run test:vitest run test/unit/extensions/opencode-rebind-plugin.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS for all fault cases and native observation acceptance. Before marking this task complete, execute these finite early scenarios through the owned real managed image, binding actual SDK/child/module/profile and original artifacts:

Run: `pnpm run typecheck:runtime`

Run: `pnpm run test:vitest run test/unit/tooling/testing/runtime-native-feasibility.test.ts --config config/vitest/vitest.config.ts`

Run: `pnpm exec tsx scripts/testing/runtime-native-feasibility.ts --provider claude --case startup`

Run: `pnpm exec tsx scripts/testing/runtime-native-feasibility.ts --provider amplifier --case startup`

Run: `pnpm exec tsx scripts/testing/runtime-native-feasibility.ts --mode freshclaude --case startup`

Run: `pnpm exec tsx scripts/testing/runtime-native-feasibility.ts --mode kilroy --case startup`

Run: `pnpm exec tsx scripts/testing/runtime-native-feasibility.ts --mode freshclaude --case approval-checkpoint`

Run: `pnpm exec tsx scripts/testing/runtime-native-feasibility.ts --mode kilroy --case approval-checkpoint`

Expected: positive execution of each full described fault matrix; no-input native acknowledgement precedes input, and checkpoint/native outcomes/effect counts meet the bounded contract with exact owned cleanup. Task 9 still supplies full upstream recovery/continuity campaigns; these early gates do not replace them.

- [x] **Step 5: Refactor while green**

Use one observation binder/validator for terminal and fresh modes while leaving each native source adapter separate. Reuse Codex/OpenCode implementations; do not create a generic filesystem identity picker.

- [x] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-platform -p freshell-runtime-protocol -p freshell-agent-runtime -p freshell-freshagent -p freshell-session-host -p freshell-supervisor -p freshell-server --features freshell-server/managed-runtime-v1`

Run: `pnpm run test:vitest run test/unit/claude-sidecar/ --config config/vitest/vitest.config.ts`

Run: `pnpm run test:vitest run test/unit/extensions/opencode-rebind-plugin.test.ts test/unit/lib/managed-runtime-recovery.test.ts --config config/vitest/vitest.config.ts`

Run: `pnpm run test:vitest run test/unit/lib/managed-runtime-wire.test.ts --config config/vitest/vitest.config.ts`

Regenerate the additive contract using `pnpm exec tsx port/contract/generate-managed-runtime-contract.ts`. After that regeneration, if the existing freeze test remains, execute it with `config/vitest/vitest.port.config.ts`; record and delete it only if it still blocks the required change, never update its static assertion or delete it on pre-regeneration evidence. Also protect actual native CLI argv and child invocation in platform launch tests: enabled/disabled hook binding, exact resume root/nonce/current signal path, preserved ordinary arguments/settings and stale/fork refusal run the production builder and owned child. Existing `cli_launch_goldens.rs` is in the platform run: if a static expected-argv/text case blocks the actual change, delete only that blocker after recording it under the user's rule; never update hash/text expectations or remove behavior-executing cases. Add behavioral cases in the existing platform launch test module, staged with `cli_launch.rs`; stage any conditional golden deletion separately with `git add -u crates/freshell-platform/src/cli_launch_goldens.rs`. Expected: PASS for executed production parsing, actual launch/child invocation, valid/invalid observation, legacy compatibility and host/supervisor behavior. The wire/launch identity interface spans the runtime; final full gate is mandatory.

Root-admitted resume-response prerequisite under G/root-task004-codex-resume-observation-resolution.md: execute real-WebSocket correlated successful thread/resume response tests, without a thread/started notification, that obtain the actual returned loaded-thread candidate with truthful resume provenance and identical forwarded bytes. Preserve small/bounded-large streaming behavior, errors/unknown request IDs/unrelated methods/missing or malformed IDs/ephemeral/wrong or competing identities and every existing host input/native identity gate; never infer loaded identity from a requested argument or rendered history. Run RED/GREEN/refactor and full affected Codex/dependent host checks and Clippy, bind genuine default host/SP/private artifacts, then necessary current native recovery and independent exact cleanup. The old397 wire was not captured, so its exact cause remains unknown and that receipt stays failed. This scope repairs the independently confirmed adapter gap; it does not grant Task 4 acceptance or loosen other gates. Source owns the three-path prerequisite and safe plan-only application; coordinator remains G-only.

- [x] **Step 7: Commit the task**

Run: `git add tsconfig.runtime.json scripts/testing/runtime-native-feasibility.ts test/unit/tooling/testing/runtime-native-feasibility.test.ts crates/freshell-session-host/src/providers/native_identity.rs crates/freshell-session-host/src/providers/mod.rs crates/freshell-session-host/src/providers/fresh_agent.rs crates/freshell-session-host/src/pty.rs crates/freshell-session-host/src/main.rs crates/freshell-platform/src/cli_launch.rs crates/freshell-runtime-protocol/src/lib.rs shared/managed-runtime.ts port/contract/managed-runtime.schema.json test/unit/lib/managed-runtime-wire.test.ts crates/freshell-supervisor/src/recovery.rs crates/freshell-supervisor/src/service.rs crates/freshell-supervisor/src/registry.rs crates/freshell-server/src/managed_runtime.rs crates/freshell-freshagent/src/claude.rs crates/freshell-claude-sidecar/index.mjs crates/freshell-claude-sidecar/permission-channel.mjs crates/freshell-agent-runtime/src/host_actor.rs crates/freshell-agent-runtime/src/host_actor_tests.rs extensions/amplifier/freshell-native-resume.patch docker/runtime/Dockerfile extensions/opencode/freshell-rebind-plugin.ts test/unit/extensions/opencode-rebind-plugin.test.ts test/unit/claude-sidecar/permission-channel.test.ts test/unit/claude-sidecar/session-settings.test.ts test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts`

If the freeze test was deleted on a recorded blocker, additionally stage only that tracked deletion with `git add -u test/unit/port/managed-runtime-contract-freeze.test.ts`.

Run: `git commit -m "fix(runtime): bind resumed identity to native provider observation"`

Also stage the Task 4 caller/support files above when actually changed: `git add crates/freshell-runtime-protocol/examples/native-identity-wire.rs scripts/testing/runtime-sandbox.ts crates/freshell-supervisor/src/resume_catalog.rs crates/freshell-server/src/managed_runtime_api.rs crates/freshell-claude-sidecar/native-session-channel.mjs crates/freshell-claude-sidecar/native-process.mjs`. This records necessary filenames and existing native/wire boundaries; it changes no requested result, acceptance gate, task count or authority.

Also stage the ROOT-authorized bounded fresh-native version metadata correction and behavioral recovery-profile/inventory-reader tests: `git add crates/freshell-supervisor/src/resume_catalog.rs docker/runtime/provider-versions.json crates/freshell-agent-runtime/src/provider_inventory.rs crates/freshell-agent-runtime/src/lib.rs`. Limit the JSON to optional Claude SDK-native child pin, the existing reader to its fresh mode accessor and lib.rs to the re-export; preserve terminal/other records/modes/stored specs/all guards/schema/package/image behavior and interfaces, with no duplicate version table or Task9 TypeScript consumer change.

Also stage the existing exact native store reader and its inline READY-only Amplifier compatibility tests when changed: `git add crates/freshell-agent-runtime/src/lib.rs`. This records the actual native-resume prerequisite filename; existing pristine-stub/absence/loss policy and all acceptance remain unchanged.

Also stage the bounded sidecar behavior tests/controlled fixtures and the managed OpenCode API seam when changed: `git add test/unit/claude-sidecar/native-session-channel.test.ts test/unit/claude-sidecar/native-process.test.ts test/unit/claude-sidecar/native-result.test.ts test/unit/claude-sidecar/fixtures/native-startup-query.mjs test/unit/claude-sidecar/fixtures/native-result-query.mjs crates/freshell-freshagent/src/opencode_ws.rs`. This is a filename correction within the existing native producer/response contract, not a new task or a native qualification claim. The root-task004-opencode-abort-fixture-resolution.md dependency additionally permits only finite body-free diagnosis in the existing accepted-daemon-turn kill test/AbortRecordingHttp fixture and deterministic fixture correction after an established cause, preserving every assertion/default budget and all production Stop/ownership behavior.

Also stage the bounded Amplifier native CLI prerequisite scripts when changed: `git add docker/runtime/prepare-amplifier-modes.py docker/runtime/prepare-amplifier-profile.py`. Their actual ordinary CLI setup failures are recorded separately from native behavior RED; full managed startup and fault acceptance remains required.

Also stage the restricted checkpoint helper/test and necessary real-module staging fixture when changed: `git add crates/freshell-claude-sidecar/native-checkpoint-state.mjs test/unit/claude-sidecar/native-checkpoint-state.test.ts crates/freshell-freshagent/tests/claude_sidecar_interrupt_dispatch.rs`. This names the existing bounded native continuation and real dispatch test dependencies without changing task acceptance.

Also stage the root-authorized existing managed-create failure observations, exact three native-family dependency selections, and their executed event/native-family tests when changed: `git add crates/freshell-server/src/fresh_agent_proxy.rs crates/freshell-server/src/fresh_agent_proxy_tests.rs crates/freshell-server/src/test_trace_capture.rs`. This mechanical caller/test inventory correction adds no public API, logger subsystem, provider allowlist or permission change, or native qualification claim.

Also stage the root-authorized logical Kilroy private tmpfs inclusion and its executed create/ownership tests when changed: `git add crates/freshell-supervisor/src/backend.rs`. Both paths continue sharing the existing bounded mount policy; no root filesystem, privilege, legacy ownership, native or credential fence changes.

Also stage the root-authorized existing loss-test setup caller when changed: `git add crates/freshell-supervisor/src/loss_report_tests.rs`. Limit it to the current launch/controlled OpenCodeTui observation setup and required imports; preserve all loss behavior assertions, fixture=None and the native publication guard.

Also stage the ROOT-authorized existing server Stop fixture setup caller when changed: `git add crates/freshell-server/src/managed_runtime_api_stop_tests.rs`. Limit it to the shared `fixture_fresh_soul_with_cleanup` current launch/controlled FreshProviderHandshake setup and necessary imports; preserve fixture=None, existing allocation setup, all assertions and production Stop/loss/native gates. Stage the exact two existing-method visibility changes in already-owned `crates/freshell-supervisor/src/registry.rs` coherently with the helper; signatures, bodies and all guards remain unchanged.

Also stage ONLY the ROOT-admitted controlled parity producer files when actually changed: git add test/fixtures/providers/parity-provider.mjs test/e2e-browser/fixtures/fake-codex-terminal.mjs. Perform meaningful actual spawned-producer/configured-native-consumer RED/GREEN/refactor and full current affected checks with only already-owned qualification runner/unit and host inline tests. Preserve every original argv/profile/config/auth/MCP/history/resume assertion and normal shared Enter behavior; no transcript/user-turn/model before Enter, requested-ID echo, arbitrary observation JSON, native guard weakening, new test module or OpenCode adoption fabrication. The AMP worker underlying cause remains unknown until minimum existing body-free error detail; current genuine OpenCode/TUI is separate and unqualified. Necessary corrected terminal parity verification waits actual current OpenCode/AMP prerequisites, never repeat a known-blocked suite. Whole Task4 nativeTUI11/current semantic definitions/seven-crate and TS gates/fresh specification then quality reviews, all11 final gates and ROOT approvals remain unchanged; Source alone owns code/index/build and safe atomic plan-only application.

### Task 5: Persist bounded supervisor recovery retries

**Files:**
- Create: `crates/freshell-supervisor/src/recovery_retry.rs`.
- Modify: `crates/freshell-supervisor/src/lib.rs`, `registry.rs:1413`, `inventory.rs:198`, `recovery.rs`, `service.rs`.
- Modify: `crates/freshell-server/src/managed_runtime.rs` (recovery scheduling/output state and inline caller/supervisor integration tests only).
- Test: new retry module and existing registry/recovery/inventory tests. Include actual server-controller/supervisor coverage with `cargo test -p freshell-server --features managed-runtime-v1 managed_runtime::tests`; supervisor alone must own retry delays/exhaustion, and pending automatic recovery must not leave a stale terminal block after success.

**Interfaces:**
- Consumes: typed recovery blocker/error, existing per-soul lifecycle lock, intent revision/control epoch, recovery attempt ID and ownership handle.
- Produces: internal `RecoveryRetry { soul_id: SoulId, intent_revision: u64, attempt_count: u8, next_due_at_ms: Option<i64>, reserved_attempt_id: Option<RecoveryAttemptId>, last_reason: String }`; registry APIs `reserve_due_recovery_retry(soul_id: SoulId, intent_revision: u64, now_ms: i64) -> Result<Option<RecoveryRetry>, RegistryError>` and `settle_recovery_retry(soul_id: SoulId, intent_revision: u64, attempt_id: RecoveryAttemptId, retryable: bool, recovered: bool, now_ms: i64) -> Result<(), RegistryError>`; initial + 2s + 10s automatic attempts, separate from five successful recoveries/hour flap budget.

- [x] **Step 1: Write the failing behavioral test**

Add `automatic_retry_survives_restart_without_budget_reset`: use the existing registry/supervisor fixture and injected clock, cause typed transient provider/backend unavailability, complete the initial attempt, reopen the registry/supervisor at 1s, verify no attempt, at 2s verify one retry, reopen at 3s, and verify the remaining retry is due 10s after second settlement. Three failures exhaust without resetting on another restart. A dependency becoming available on attempt two recovers the same root once. Cover crash before reservation, after reservation/before dispatch, after replacement created/before settlement, and after settlement; adopt/inspect any reserved attempt through existing recovery ownership before retrying. Add Stop/new intent/manual retry/lost cancellation, stale revision, concurrent observer/startup reservation, and nonretryable wrong-identity/unqualified-source blockers. No wall-clock sleep is necessary for policy tests. Define exactly four ignored destructive parent tests `automatic_retry_crash_before_reservation`, `automatic_retry_crash_after_reservation_before_dispatch`, `automatic_retry_crash_after_replacement_before_settlement`, and `automatic_retry_crash_after_settlement` in the existing supervisor recovery/service test module, each exercising its named production boundary through subprocess crash/reopen and exact owned handle/attempt/budget checks. Mark each ignored with the Docker-sandbox-only reason; ordinary cargo tests never launch them. Run the `automatic_retry_crash` prefix in both red and green phases exclusively through documented `scripts/sandbox-test.sh --runtime-suite`; require four selected/executed parents and positive boundary assertions.

- [x] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-supervisor automatic_retry_survives_restart_without_budget_reset`

Run: `scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-supervisor automatic_retry_crash -- --ignored"`

Expected: FAIL because blocked souls are excluded from continuing observation and failed-attempt due state is not persisted; require exactly four destructive parents with intended behavior failures, never zero-selection/setup failures.

- [x] **Step 3: Add the minimal production implementation**

Add a compatible registry schema migration with a retry row keyed by soul and intent revision, durable attempted/reserved state, next deadline, typed last reason and active recovery-attempt reference. Use the migration framework's next schema version after Task 1, not a hardcoded stale version. Initial attempt reservation consumes attempt 1; failed retryable settlement schedules attempt 2 at now+2000ms and attempt 3 at now+10000ms; failed attempt 3 has no next deadline and exposes RetryExhausted. Reservation and existing recovery-attempt creation commit together before external work. SQL updates check current desired Running, exact intent revision, not Lost, no conflicting active attempt, and due deadline. Observer/startup enumerate due retries as well as LIVE health observation, acquire the existing lifecycle lock and bounded concurrency permit, recheck reservation, then invoke the ordinary recovery path. Startup inspects/adopts a reserved in-flight recovery using owned handles and existing recovery journal; never blindly replays provider creation. Clock rollback cannot mint attempts; persisted deadlines remain deadlines. Only explicitly typed transient host/backend/config dependency/preparation failures are retryable; identity mismatch, ownership mismatch, incomplete evidence and required user owner choice are blocked until deliberate correction/manual retry. Manual retry rearms once under a fresh current intent action. Successful recovery, Stop, Lost, and revised intent clear/cancel pending schedules transactionally. Log scheduled/reserved/settled/exhausted/cancelled with severity and exact IDs. Keep success flap budget separate.

- [x] **Step 4: Run the focused test**

Run: `cargo test -p freshell-supervisor automatic_retry_survives_restart_without_budget_reset`

Run: `cargo test -p freshell-supervisor retry_budget`

Run: `scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-supervisor automatic_retry_crash -- --ignored"`

Expected: PASS for bounded restart-safe failed attempts and unchanged successful-recovery flap policy, plus four actually executed crash parents and no host execution.

- [x] **Step 5: Refactor while green**

Share registry eligibility/reservation between startup and observer; keep retries out of the web controller. Factor a pure due/settlement policy in `recovery_retry.rs`, retaining SQL transactional authority and existing lock ownership.

- [x] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-supervisor`

Run: `scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-supervisor automatic_retry_crash -- --ignored"`

Expected: PASS with nonzero crash selectors; schema reopen, existing flap-budget/manual retry, source/identity mismatch, Stop fences and startup readiness continue to pass.

- [x] **Step 7: Commit the task**

Run: `git add crates/freshell-supervisor/src/recovery_retry.rs crates/freshell-supervisor/src/lib.rs crates/freshell-supervisor/src/registry.rs crates/freshell-supervisor/src/inventory.rs crates/freshell-supervisor/src/recovery.rs crates/freshell-supervisor/src/service.rs`

Run: `git commit -m "fix(supervisor): persist bounded automatic recovery retries"`

### Task 6: Resume interrupted ordinary Stop transactions

**Files:**
- Modify: `crates/freshell-supervisor/src/service.rs:1787`, `registry.rs:706`, `inventory.rs:51`, `recovery.rs`.
- Modify narrowly: `crates/freshell-supervisor/src/backend.rs` only qualified owned never-started Created emptiness and inline production-path behavioral coverage.
- Test: inline registry/service/inventory tests and `test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts`.

**Interfaces:**
- Consumes: durable stopped intent, exact original `OwnedRuntimeHandle`, current incarnation/revision and recorded Stop outcome.
- Produces: `Registry::pending_stop_handles() -> Result<Vec<OwnedRuntimeHandle>, RegistryError>` and internal `Supervisor::finish_stop_handle(&OwnedRuntimeHandle) -> Result<StopOutcome, RuntimeError>`. This method does not commit a new intent; ordinary Stop and restart continuation share it.

- [x] **Step 1: Write the failing behavioral test**

Add `ordinary_stop_crash` sandbox tests at durable intent commit before IPC, after graceful request, after force-stop/verified empty before outcome persistence, and after outcome commit before capability revocation. Restart supervisor; assert original intent revision/native root/store/history remain, no creation/grant/recovery occurs, only the exact owned handle is signaled, and state converges idempotently to VerifiedEmpty. Repeat with unavailable backend, surviving workload and ownership-label mismatch: state remains accurately BackendUnavailable/TerminationUnconfirmed/BlockedOwnership, never falsely stopped or resurrected. Add stale handle/new intent concurrency and an empty already-removed enclosure case. Add the exact browser case `synthetic interrupted ordinary Stop preserves history`: click Close pane to invoke ordinary Stop on a registered synthetic managed pane, crash the isolated supervisor at the intent boundary, reconnect and see stopped with retained transcript and unchanged root/intent revision; assert zero replacement/writer/grant recreation. Gate only this case on exact `FRESHELL_RUNTIME_SYNTHETIC_RESUME=1` independently of live provider flags; Task 8 and final-candidate coverage select it explicitly through configured Cloud.

Extend the schema fixture produced by Task 5: reopen a pre-Task-6 registry with an incomplete ordinary Stop, migrate it, and prove pending capability revocation survives reopen and completes once after a crash between outcome persistence and revoke. A completed legacy Stop is not turned into a new stop intent or provider start. Run the migration/revocation case with the `ordinary_stop_crash` parent matrix, not a static schema equality check.

- [x] **Step 2: Run the test and verify the intended failure**

Run: `scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-supervisor ordinary_stop_crash -- --ignored"`

Expected: FAIL because desired Stopped souls are not resumed by startup/observer ordinary Stop reconciliation. The parent suite validates a nonzero selected case count.

- [x] **Step 3: Add the minimal production implementation**

Extract existing `stop`'s authenticated IPC/graceful/backend verification/force/verification/outcome sequence into `finish_stop_handle`; retain two-second graceful request and three-second bounded empty checks, exact ownership mismatch semantics and capability revocation. `stop` commits intent once, cancels retries in that transaction, then calls the helper under the lifecycle lock. Registry selects current desired Stopped handles whose durable Stop transaction is incomplete or whose verified cleanup/revocation remains pending. Startup and observer settle these before/alongside running recovery with existing concurrency limits; they do not call `begin_stop_expected` again or increment intent. Before each signal/outcome mutation, recheck current revision/handle ownership; stale/new intent returns without effect. If exact container is absent, backend's qualified empty result may finish Stop; arbitrary inspection failure may not. Positively inspected exactly owned never-started Created enclosures also finish Stop without starting a provider. Bound the actual initial observation, graceful/force calls and each observation within the three-second empty-check window; a silent backend leaves an honest unresolved outcome and releases the lifecycle lock for later same-intent continuation. Add the next registry migration after Task 5's actual version for durable ordinary-Stop progress/outcome and pending capability revoke status, keyed by exact soul/incarnation/intent revision and recorded grant identity. Transactionally persist the outcome plus revoke obligation before external revoke; mark settled only after successful acknowledgement, retry failures idempotently without reopening provider. Migrate legacy completed rows conservatively without fabricating absent grant authority. Preserve separate loss cleanup machinery and never convert an ordinary Stop to Lost. Emit continuation/result events.

- [x] **Step 4: Run the focused test**

Run: `scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-supervisor ordinary_stop_crash -- --ignored"`

Expected: PASS at every selected boundary, including honest unresolved backend/ownership cases.

- [x] **Step 5: Refactor while green**

Remove duplicate stop termination branches now shared by ordinary invocation/startup; reuse applicable exact-handle termination helpers in recovery only when semantics match. Keep lifecycle lock acquisition outside the helper to avoid recursive locking.

- [x] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-supervisor`

Run: `scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-supervisor stop -- --ignored"`

Expected: PASS for Stop-vs-recovery CAS, tombstones, writer claim release, exact ownership and pending capability revocation. Browser proof executes in Task 8.

- [x] **Step 7: Commit the task**

Run: `git add crates/freshell-supervisor/src/backend.rs crates/freshell-supervisor/src/service.rs crates/freshell-supervisor/src/registry.rs crates/freshell-supervisor/src/inventory.rs crates/freshell-supervisor/src/recovery.rs test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts`

Run: `git commit -m "fix(supervisor): finish durable Stop after interruption"`

### Task 7: Prove stopped repair, baseline continuity and exact withdrawal

**Files:**
- Modify: `crates/freshell-supervisor/src/stopped_repair_cas.rs`, `registry.rs`, `resume_catalog.rs`, `notice_outbox.rs`, `loss_report_tests.rs`, `crates/freshell-server/src/managed_runtime_api.rs`.
- Modify: `crates/freshell-server/src/managed_runtime_api_stop_tests.rs` (only stateful occupied/empty Stop backend fixture and actual uncertainty/Retry/verified-cleanup route tests; preserve all existing outcome, identity, loss, view, writer and exact-target assertions; no production Stop-policy change; the bounded shared-fixture resolution additionally admits pub(super) visibility for fixture_fresh_soul_with_cleanup, web_router, repair_post and start_control, plus start_control accepting Arc<dyn RuntimeBackend>, solely for sibling inline auth/fence tests).
- Modify: `crates/freshell-supervisor/src/recovery.rs` (only the actual stopped-import post-publication crash seam and minimum behavior-demonstrated stopped repair/Resume/baseline/export fixes; preserve accepted Running retries and ordinary Stop), `crates/freshell-session-host/src/main.rs` (actual `baseline_only` exact-resume/adoption behavior tests and minimum demonstrated fixes/fault seams). A necessary `pty.rs` change requires an exact observed failure and proposal before editing.
- Modify: `crates/freshell-supervisor/src/backend/native_history.rs` (only bounded stopped-import helper failure diagnostics before exact cleanup and existing inline behavioral tests; preserve helper admission, provider identity, all mounts/capabilities, successful stdout receipts and lifecycle bounds).
- Modify: `crates/freshell-supervisor/src/backend.rs` (only stopped-helper-specific BackendError variant and local safe diagnostic type reexport; preserve all traits, protocol/schema and unrelated native/error behavior).
- Modify: `test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts`, `runtime-lost-soul-notice-rust.spec.ts`, `scripts/testing/runtime-sandbox.ts` (only the relocated synthetic OpenCode seeder block; preserve Task 4 native/preparation reservations), `test/e2e-browser/helpers/managed-runtime.ts`.
- Modify: `test/unit/tooling/testing/runtime-native-feasibility.test.ts` (only canonical single-root/seven-family seeder behavior coverage and required local fixture/import setup; preserve existing native tests and production native helper/proof/preparation semantics).
- Modify only if a test reveals missing contextual state: `src/lib/recovery/managed-runtime-recovery.ts`, `src/lib/managed-runtime-retry.ts`, `src/components/ManagedRuntimeRecoveryCard.tsx`, `test/unit/lib/managed-runtime-recovery.test.ts`, `test/unit/lib/managed-runtime-retry.test.ts`, `test/unit/client/components/ManagedRuntimeRecoveryCard.test.tsx`.

**Interfaces:**
- Consumes: nine exact target revisions, seven canonical roots/owners, exact generation-bound structural/readability receipts, immutable saved adoption baseline, stopped batch route and current provider-observed launch evidence.
- Produces: seven `DataRepairComplete` stopped/resume-ready canonical souls, preserved explicit views, exact nine-incident retraction, and same-soul Resume/failure/retry without losing baseline. Data repair makes no provider-running claim.

- [x] **Step 1: Write the failing behavioral test**

Add `stopped_repair_resume_failure_retry_preserves_baseline`: run the actual synthetic nine-target/seven-root batch through the authenticated server route and real host import/read path, verify no PTY/provider-session process launches; the real authenticated positive path runs in the required owned Docker browser runbook, while the named supervisor test protects persisted baseline continuity with genuine exporter/importer/reader library receipts and actual Resume/Retry transitions; host-process test receipts must never be relabelled as container receipts; record actual setup/import helper starts, leave canonical souls stopped, then explicitly Resume one synthetic soul through UI. Fault the first current launch observation, interrupt/restart supervisor, then Retry; assert same canonical soul/native root/store and complete original imported graph/baseline remain, matching current generation/nonce observation precedes input and LIVE. Run baseline-only host fault matrix for unreadable reader/assets, receipt/root/generation mismatch, stale observation, interrupted pre-PTY gate, Stop cancellation and recovered current tail. Include schema-7 migration with exact verified source/import fences and deliberate choices for both eligible duplicate pairs, native full/part revert active-tail hydration, ordinary native prompt cleanup removing current rows/clearing revert while immutable original evidence remains, V1/V2 empty/load failure and unavailable saved undo-tree preservation. Add pending withdrawal blocking one incident while unrelated exports drain, exact `%`/`_` view prefix behavior, colliding sanitized notice receipts, malformed unclassifiable JSONL and concurrent stale exporter/rotator boundaries. Each test asserts actual filesystem/registry outcome, not just a manifest row count. Define exactly three ignored destructive parents in `loss_report_tests.rs`: `stopped_repair_crash_after_import_publication`, `stopped_repair_crash_after_repair_cas_before_withdrawal`, and `stopped_repair_crash_during_withdrawal_before_ack`. Each interrupts its named actual durable boundary, reopens supervisor/registry and repeats the same operation, verifying exact imported graph/baseline/CAS/retraction progress and unrelated artifacts. Mark these Docker-sandbox-only ignored; run only `stopped_repair_crash_` through documented `scripts/sandbox-test.sh --runtime-suite`, with exactly three selected/executed parents in red and green phases.

Provide all seven fictional root families in one source store through the Task7-owned canonical seeder, preserving its existing single-root default and immutable baselines. A private historical schema-7/Lost/duplicate fixture producer in existing `loss_report_tests.rs` is setup only, invoked as a known compiled test artifact before the owned registry opens; old fictional observations never count as current import, readability or runtime evidence. Task8 owns the finite batch-fixture runner operations/transport and exact production stopped-import helper admission/cleanup; agree that minimum contract before dependent browser execution.

The existing four finite batch operations additionally admit the fixed `source_generation_change` and `pending_withdrawal` presets, for seven presets total. After stopping and joining the owned web and supervisor and settling source consumers, source generation changes only the registered fictional first root's title; clearing it verifies the expected closed database SHA and absence of SQLite sidecars, then atomically restores only captured original generated-fictional source bytes. Pending withdrawal creates only the registered supervisor's actual `runtime_root.parent()/evidence/lifecycle.jsonl.1` obstruction, which production scans; clearing verifies and removes only those owned bytes. Restart the same registry and volumes without automatic Resume. Never restore historical registry, imported store or real history; preserve all native identity, receipt and input fences.

For these finite fault replacements, retain the exact new owned supervisor handle before awaiting health; a health failure still propagates and remains available to the next finite observation or cleanup. The browser may qualify that expected failure only with the matching actual current supervisor crash marker, joined separately to the same operation in the current registry. The failed first Resume is evidenced by its actual soul/incarnation/generation event before failed-host cleanup; successful Retry still requires current matching host and registry observations. Preserve honest measured activity fields `setupHelpersCompleted`, `helperStartRequests`, `providerContainerStartRequests`, and `providerLaunchRunningEvents`; forwarded requests are not successful starts or PTY counts, and combined import/read helper requests are not separate successful-import totals.

When that exact owned supervisor is stopped, a fixed private query-only reader may mount only its registered current registry volume read-only and publish the finite operation projection. This owner-local metadata reader runs as UID 0, is tracked for exact cleanup, and grants no provider-identity proof or broker mount widening. Installed-store readability continues to require the separate actual UID 65534/GID 0 provider reader. These clarifications implement the bounded fault-handle, counts/markers and stopped-reader resolutions without adding an operation, preset or arbitrary execution/path interface.

Add the browser scenario with exact name `stopped nine-soul restoration runbook` here, before final candidate campaigns. Capture nine targets/seven roots and revisions/store metadata, resolve both deliberate duplicate choices, preflight all roots, submit authenticated idempotent stopped repair, verify seven installed graph digests and provider-identity access receipts, stopped state, explicit view rebind, exact nine retractions and unrelated records. Interrupt and repeat the same operation key at import/publication/withdrawal boundaries; change intent/source revision before apply and assert zero unauthorized correction. Partial import remains an owned recoverable operation without early false-record withdrawal. Exercise recovery against a stale receipt and verify no auto-start or real conversation use. Task 8 migrates and executes this scenario on the configured browser backend; The synthetic regression remains useful behavior coverage; Task 11 prepares deployment without invoking the production repair route.

- [x] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-supervisor stopped_repair_resume_failure_retry_preserves_baseline`

Run: `cargo test -p freshell-session-host baseline_only`

Run: `scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-supervisor stopped_repair_crash_ -- --ignored"`

Expected: exactly three destructive parents selected/executed; FAIL for any unimplemented integrated persistence/host transition; source tests previously doing direct registry begin/block do not fulfill this production path. If all current production cases already pass, record existing imported pre-fix failures and current positive execution without manufacturing a new defect.

- [x] **Step 3: Add the minimal production implementation**

Ensure `registry` loads completed/owned import baseline by immutable receipt authority independent of transient DataRepairComplete/Blocked/Recovering state, and `resume_catalog` upgrades legacy spec environment and baseline atomically. Batch preflights **all seven roots/owners/targets** before any import, validates provider access under actual identity, commits exact captured revision CAS only after all seven independent readability receipts, and never starts providers. Root owner resolution returns typed choices only for real ambiguity. Preserve the cleanup/export coordinator through exact ID generation checks, file rewrite/sync and progress acknowledgement; deferred withdrawal records an error but does not suppress unrelated export drain or make startup entirely unavailable. Exact view projection cleanup parses the numeric revision following the full string prefix, never SQL LIKE matching unrelated IDs. Retraction progress is durable ID/generation/status/artifact metadata only. UI presents Resume for stopped repaired data; failed provider adoption presents same-soul Retry with retained baseline and honest blocker. Update README/mock only if this changes the source UI materially.

- [x] **Step 4: Run the focused test**

Run: `cargo test -p freshell-supervisor stopped_repair_resume_failure_retry_preserves_baseline`

Run: `cargo test -p freshell-session-host baseline_only`

Run: `cargo test -p freshell-supervisor pending_stopped_repair_withdrawal_does_not_suppress_unrelated_exports`

Run: `scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-supervisor stopped_repair_crash_ -- --ignored"`

Expected: PASS with exact seven-root import, nine target correction, complete baseline and unrelated records preserved, including all three actually executed destructive parents.

- [x] **Step 5: Refactor while green**

Keep structural verification, installed readability, repair CAS and later provider adoption as separate typed stages. Share exact target/notice/view selection helpers; remove copied historical eight-target logic and direct-state test shortcuts.

- [x] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-supervisor -p freshell-session-host -p freshell-server --features freshell-server/managed-runtime-v1`

Run: `pnpm run test:vitest run test/unit/lib/managed-runtime-recovery.test.ts test/unit/extensions/opencode-rebind-plugin.test.ts --config config/vitest/vitest.config.ts`

Run: `scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-supervisor stopped_repair_crash_ -- --ignored"`

Expected: PASS for auth/idempotency/count, exact retraction crash points, true-loss preservation and all relevant baseline-only host faults. Task 7 explicitly retains `FRESHELL_RUNTIME_SYNTHETIC_RESUME=1`, already present in immutable `tracked.patch` at the source-to-soul browser test skip guard. Gate the new `stopped nine-soul restoration runbook` test on that exact flag independently of `FRESHELL_RUNTIME_PHASE3_LIVE`; it uses fictional fixtures, no provider prompts or grants. Unset/other values skip that opt-in test honestly and never publish a qualifying receipt; set value selects and executes it. Task 8 allowlists/forwards this flag to Cloud and validates positive selected/executed counts. Task 8 executes these browser cases through cloud and records actual nonzero counts.

- [x] **Step 7: Commit the task**

Run: `git add crates/freshell-supervisor/src/stopped_repair_cas.rs crates/freshell-supervisor/src/registry.rs crates/freshell-supervisor/src/resume_catalog.rs crates/freshell-supervisor/src/notice_outbox.rs crates/freshell-supervisor/src/loss_report_tests.rs crates/freshell-supervisor/src/recovery.rs crates/freshell-session-host/src/main.rs crates/freshell-server/src/managed_runtime_api.rs test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts test/e2e-browser/specs/runtime-lost-soul-notice-rust.spec.ts scripts/testing/runtime-sandbox.ts test/e2e-browser/helpers/managed-runtime.ts`

If changed, also stage the three contextual UI files and required README/mock updates; inspect staged diff. Run: `git commit -m "fix(runtime): preserve repaired history through failed resume"`.

### Task 8: Verify affected managed-browser behavior on the current candidate

**Files:**
- Test: `test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts`
- Test: `test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts`
- Modify only if a reproduced behavior failure requires it: the owning production file and its behavior tests.

**Interfaces:**
- Consumes: the clean current candidate and its already-built isolated managed-runtime/browser images, configured Cloud backend, existing exact owner and cleanup interfaces.
- Produces: a positive result for the selected existing synthetic interrupted-Stop browser case, with exact owned cleanup. Config and legacy-runtime transition retries are omitted under the accepted manual-porting scope. The provider-free Fresh History browser check already passed on candidate `0779df04e9e03d87c0b607d65653c219c8958c82`.

- [x] **Step 1: Confirm the candidate and shared test coordinator are ready**

Run: `git status --short --branch`

Run: `pnpm run test:status`

Expected: the candidate worktree is clean and the shared coordinator is idle before dispatch.

- [x] **Step 2: Exclude transition-retry cases under the accepted scope**

The configured runner rejected this selector before owner/job creation because the candidate-bound Task 2 fixture manifest is absent. The selected cases exercise runtime transition/retry state; the user accepted not requiring exact transition behavior and manual session porting later. No transition test is a delivery gate.

- [x] **Step 3: Run the interrupted-Stop browser case**

Run: `FRESHELL_RUNTIME_SYNTHETIC_RESUME=1 GCLOUD_ROBOT_REQUIRE=1 pnpm exec tsx scripts/testing/runtime-external-browser.ts --spec test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts --grep 'synthetic interrupted ordinary Stop preserves history$'`

Expected: the selected case executes and passes; the owned runtime and cloud job are verified absent. These synthetic checks do not invoke live models or certify native-session continuity. On candidate `93fb42e1db6007f5d1dd78dc7558e2118d642756`, run `b028dc91-e985-43ee-832e-9564431df53c` passed and exact cleanup was verified.

- [x] **Step 4: Fix any reproduced in-scope failure and rerun only affected cases**

No in-scope failure was reproduced. The excluded selector stopped at admission before creating any test owner or Cloud job; it did not exercise application behavior.

- [x] **Step 5: Review and commit any repair**

Run: `git diff --check`

Run: `git status --short --branch`

No source/test repair was needed for Task 8, so no empty commit was made. The run result and scope decision are recorded above.

### Task 9: Smoke-test ordinary use in the four selected non-Claude modes

**Files:**
- Modify: `test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts` to add a narrowly selected terminal-provider smoke that launches each selected provider and observes one completed response.
- Modify: `test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts` to add the corresponding fresh-agent smoke using the existing isolated rig and a visible/provider-native completion signal.
- Modify: the external runner only if the exact new test titles require an allowlist adjustment.

**Interfaces:**
- Consumes: the existing explicit provider/mode selectors, isolated managed runtime, actual application pane creation, actual selected provider binary and configured account references.
- Produces: one ordinary completed response each for Codex and OpenCode in terminal and fresh-agent modes, with exact resource cleanup. Claude live behavior remains unverified under the accepted scope. These checks produce no qualification/certification receipt and make no claim about same-session restoration after a transition.

- [x] **Step 1: Add the focused behavior checks**

Add one separately selectable browser case to each existing live spec. Each selected mode creates an isolated pane and sends one bounded harmless prompt. For FreshAgent, require successful completion for the sent session after that send and newly displayed nonempty assistant text in that pane. For terminal mode, ask for the lowercase form of a unique uppercase marker; the expected answer must be absent from both the literal prompt and the pre-send terminal buffer. Capture the selected terminal's stream, sequence and allocated native conversation, then require the sent request, matching provider activity, fresh output, the expected answer rendered in that terminal's xterm buffer, and an advanced `terminal.turn.complete` with explicit successful outcome for that same native conversation. Observe these signals independently of arrival order and preserve valid evidence through buffer rollover. A matching failed outcome ends the wait promptly with diagnostic outcome and sequence information; a foreign conversation's completion or failure does not satisfy or terminate this wait. Summaries return booleans, counts and identity/sequence metadata. Actual errors and owned diagnostic output may be inspected while protecting literal secrets. Prompt echo, loading output, raw answer bytes without rendering, acceptance or allocation alone do not establish success. Do not crash/restart the host or provider, compare native session IDs across incarnations, test pending approval, or import existing sessions.

- [x] **Step 2: Run the four selected non-Claude cases locally**

These specs are listed in `LOCAL_ONLY_SPECS` and excluded by the Cloud configuration. The user approved `--local` for the selected mode checks. Run one mode at a time so each has its own result and cleanup receipt.

Run: `FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE=1 FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_PROVIDERS=codex pnpm run test:e2e --local --project=chromium test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts --grep 'each selected terminal provider completes one ordinary turn$'`

Run: `FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE=1 FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_PROVIDERS=opencode pnpm run test:e2e --local --project=chromium test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts --grep 'each selected terminal provider completes one ordinary turn$'`

Run: `FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_LIVE=1 FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_MODES=freshcodex pnpm run test:e2e --local --project=chromium test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts --grep 'each selected fresh-agent mode completes one ordinary turn$'`

Run: `FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_LIVE=1 FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_MODES=freshopencode pnpm run test:e2e --local --project=chromium test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts --grep 'each selected fresh-agent mode completes one ordinary turn$'`

Historical first rerun: Codex terminal failed at terminal creation with `PTY_SPAWN_FAILED`, before the Codex process started; FreshCodex sent input but its session exited without a completed turn; OpenCode produced output but no completion event; FreshOpenCode passed. These failures were subsequently repaired. All four modes passed their then-current assertions at `3dcd7884236e4184859a2e40c7115383f5de6831`, and terminal Codex passed those assertions again after relay repairs at `7d7a91baaf1f7cf1b99b5ee89c4ce8799b5ffce1`. The original terminal assertion accepted activity/output/completion without proving a rendered answer for the allocated conversation, so those receipts do not establish the strengthened Step 1 assertion. The strengthened terminal Codex and OpenCode reruns both passed at `a62b7b3436afba07cb86a2def2b0519fe8edb9bd`, with exact cleanup verified. Retain the unchanged FreshCodex/FreshOpenCode successful-answer evidence at `3dcd7884236e4184859a2e40c7115383f5de6831`; no shared login was changed. Final Task 9 acceptance still requires the integrated full-suite gate and complete-change review, followed by the post-Stage-5 browser-evidence assessment in Step 6. Record actual tested commits and reuse decisions in the run ledger.

Expected: all four selected browser cases pass, each records one body-free completion event, and all owned resources close cleanly. A failed case proceeds to Step 3 and is not counted as acceptance. No global campaign status or certification is produced.

- [x] **Step 3: Diagnose and repair any ordinary-use failure**

If a mode fails, inspect actual errors and owned diagnostic logs to distinguish a product failure from an unavailable provider account or transport. Fix a product defect with a meaningful regression test and rerun the affected mode. Do not refresh, replace or broaden shared credentials without explicit authorization; never expose secret material.

- [x] **Step 4: Run affected checks and refactor while green**

Run: `pnpm run typecheck:runtime`

Run: `pnpm run typecheck:managed-tests`

Run: `pnpm run lint:managed-tests`

Run the affected final behavior checks through the configured Cloud backend: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:cloud --shards=1 test/unit/tooling/testing/terminal-ordinary-turn.test.ts test/unit/tooling/testing/runtime-external-browser.test.ts test/unit/tooling/testing/runtime-owner-facts.test.ts test/unit/tooling/testing/provider-response-sequencing.test.ts`.

Expected: the new selectors and existing test callers typecheck and pass; lint has no errors. Preserve the existing broader transition specs as optional regression coverage, but do not make them a delivery gate.

The R17 follow-up at `04c75d65e6331da529567938fa7801ed7d8d9f5c` passed both typechecks, affected lint and 723 tests across these four Cloud files, with zero failures or skips. Its 18 new terminal behavior cases first failed against the earlier observer and waiter. Earlier R18 fixes passed 1195 tests in nine Cloud files; the follow-up retains those fixes and reruns their affected terminal/diagnostic neighbors. Detailed execution and cleanup receipts remain in the run ledger.

- [x] **Step 5: Commit the focused smoke coverage or repair**

Run: `git diff --cached --stat`

Run: `git diff --cached --check`

Expected: the staged diff contains only the reviewed smoke test changes and any directly required product fix. Commit with a focused message; do not include external run evidence or credentials.

- [ ] **Step 6: Run the final browser checks after the Stage 5 review loop**

Assess these exact selected cases after Stage 5 is complete. Retain passing evidence when later changes do not affect the exercised path; rerun the affected case when a repair changes that path or leaves a concrete concern. A commit-ID change alone does not require repeating a paid provider call:

Run: `FRESHELL_RUNTIME_SYNTHETIC_RESUME=1 GCLOUD_ROBOT_REQUIRE=1 pnpm exec tsx scripts/testing/runtime-external-browser.ts --spec test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts --grep 'synthetic interrupted ordinary Stop preserves history$'`

Run: `FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE=1 FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_PROVIDERS=codex,opencode GCLOUD_ROBOT_REQUIRE=1 pnpm exec tsx scripts/testing/runtime-external-browser.ts --spec test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts --grep 'each selected terminal provider completes one ordinary turn$'`

Run: `FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_LIVE=1 FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_MODES=freshcodex,freshopencode GCLOUD_ROBOT_REQUIRE=1 pnpm exec tsx scripts/testing/runtime-external-browser.ts --spec test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts --grep 'each selected fresh-agent mode completes one ordinary turn$'`

Expected: all four selected non-Claude modes and the interrupted-Stop case have executed passing evidence that covers their resulting behavior, with their existing Task 8/9 assertions and verified cleanup. Record the tested commit and any reuse rationale; do not describe an earlier run as execution on a later commit. Any rerun required by a Stage 5 repair runs against the resulting final candidate.

- [ ] **Step 7: Verify the configured full-suite gate after the last behavior change**

Run `pnpm run test` on the committed integrated repairs before the Stage 4 whole-branch review, using the configured `FRESHELL_VITEST_BACKEND` and `FRESHELL_E2E_BACKEND`. Include the required local companion for Cloud-excluded server tests. Agent-launched Cloud lanes must set `GCLOUD_ROBOT_REQUIRE=1` and use the configured robot identity; do not silently change backends or treat skipped/zero-match cases as coverage. After Stage 5, reuse this passing gate if that stage made no implementation fixes. If Stage 5 produced fix commits, run the full-suite gate once on the final resulting code after its focused verification. Step 6's final browser-evidence assessment remains required in either case; a prose-only bookkeeping change does not itself require another full suite.

Expected: the coordinated full suite and required companion have passing evidence for the final implementation, excluding only failures recorded in the baseline ledger with reproduction evidence at `base_ref`. Record the exact command, tested commit, result and any evidence-reuse rationale in the run ledger; do not describe an earlier execution as a run on a later commit.

## Acceptance and self-review map

| User obligation | Tasks | Observable evidence |
| --- | --- | --- |
| Fix diagnosed durable-souls defects and preserve meaningful regressions | 1–8 | Existing source repair tests, affected browser cases, configured full-suite gate and independent review |
| Avoid false loss conclusions from missing/unreadable identity or storage | 3, 4, 8 | Existing behavior tests reject unknown or incomplete evidence without treating it as absence |
| Fix configuration, blocked recovery, retry and interrupted Stop behavior | 2, 5, 6, 8 | Provider-identity config tests, retry tests, and the selected interrupted-Stop browser case; config/legacy transition browser cases are outside the accepted manual-porting scope |
| Make normal use work across four selected non-Claude modes | 9 | One completed ordinary response per selected terminal and fresh-agent mode; exact cleanup |
| Skip Amplifier and Kilroy live work | 9 | No Amplifier/Kilroy model, credential or qualification operation; existing code/tests preserved |
| Allow manual session porting if transition changes a native session | Global 3, 9 | No automatic startup or transition import; selected OpenCode resume remains available on demand, with no same-native-session-across-restart claim |
| Keep verification proportional to the threat model | all | Behavior tests, clear diagnostics, no certification campaign or audit subsystem |

The user's current request appears once above. Tasks 1–7 and prior receipts describe completed history; current code and the latest scope control remaining work. The former six-mode crash/recall campaign and deployment/backup preparation are removed from the remaining gates, not reported as completed. Full-suite and independent delta review remain required by the-usual workflow.
