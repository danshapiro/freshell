# Durable Managed Runtime Maintenance Modes Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Implement the three managed-runtime update modes: default updates the web/client without restarting the durable supervisor or resetting managed coding sessions; `--all` updates the web/client and durable runtime; `--durable-only` updates durable components while leaving the web/client unchanged. Also fix the pre-existing managed-provider qualification compile failure in a dedicated worktree so tests can run, then continue the update-mode implementation.

### Explicit constraints
- Require the user to say “APPROVED” verbatim before either reset-capable mode, based on the mode/action category and without compatibility analysis.
- Both reset-capable modes reset managed coding sessions by default after approval, preserve conversation history, and attempt to reopen saved conversations against the updated runtime.
- Default mode reminds the operator that the supervisor and managed sessions were not restarted and that reset-capable updates require verbatim approval.
- Remove the existing broad approval restriction for ordinary web/client restarts; do not replace it with another web/client approval rule.
- Ensure ordinary web/client maintenance cannot indirectly restart the durable supervisor.
- Use the-usual workflow.
- Fix the baseline compile failure in the dedicated worktree under the user's explicit exception, then continue the requested update-mode implementation.

### Accepted tradeoffs and residuals
- An approved update may interrupt active coding sessions; saved history remains and reopening is attempted, but recovery is not guaranteed. Manually reopening or porting sessions afterward is acceptable if needed.

## Goal

Operators can update the served client alone, update the client and durable runtime together, or update the durable runtime alone. The two reset-capable modes require an exact APPROVED line, preserve conversation history, reset managed coding sessions, and attempt reopening them on the updated runtime.

## Architecture

Add pnpm run update:managed-runtime with a client-only default and explicit --all and --durable-only modes. Resolve the supported systemd user-unit owner and its artifact/resource manifest before staging. The web unit drop-in uses ordering-only After= so ordinary web/client maintenance cannot activate or restart the supervisor. The updater explicitly sequences any supervisor and web starts it needs.

The default mode stages and activates only the selected served client directory. It does not call the supervisor, stop managed sessions, or restart a service. Both reset modes require exact approval, stage all selected artifacts first, stop the web/API unit to close UI create/retry ingress, then take one final inventory over the still-running supervisor's exact control socket. A new supervisor admin CLI performs inventory, typed per-soul Stops, and a narrow revision-fenced Reopen operation directly over that socket. The updater stops the supervisor only after every selected Stop is verified empty, installs the selected artifacts, starts the supervisor, waits for its control socket, attempts eligible reopens, starts the web/API unit, and waits for server readiness.

The new Reopen operation uses the stopped soul's saved launch/resume context, native identity, and provider store to create a new incarnation with the current runtime. A missing native ID keeps the soul in the reset set but yields an explicit unavailable-to-reopen result. Do not fabricate a soul, native ID, or store. The compile repair is a prerequisite commit.

## Tech Stack

TypeScript/NodeNext, pnpm 10.34.5, Rust/Cargo managed-runtime feature, the existing supervisor control protocol and runtime client, a supervisor admin CLI, Docker workload image, systemd user units, Vitest, Playwright, and the managed-runtime fixture harness.

## Stage 2 decisions

The Stage 2 ledger and evidence are in /home/dan/code/freshell/.worktrees/.the-usual-logs/durable-maintenance-modes/load-bearing-ledger.md and its reports directory. This section records the decisions the implementation must follow.

- F01 was falsified. Existing browser Reopen and create/resume paths cannot start a new incarnation of a stopped soul on its retained provider volume. Add the narrow supervisor admin Reopen operation described above. It is revision-fenced and idempotent; it uses the saved context and current runtime. Missing native IDs remain reset targets and are reported unavailable.
- F02 is acceptable only for the existing systemd user-unit installation. Before staging or mutation, verify the current checkout matches the selected units' working directory and executable/install paths, identify the running supervisor and socket from those units, and refuse on ambiguity. Use that exact socket for inventory, Stop, and Reopen through the supervisor admin CLI. Do not use an HTTP API for those operations or add an HTTP identity endpoint unless direct socket ownership cannot be established.
- F03 was falsified. Replace the web drop-in's Requires= with ordering-only After=; do not use Wants= or Requisite=. Web start/restart may fail when the supervisor is absent, but must not activate or restart it. The updater explicitly starts the supervisor before the web service when a reset mode needs both.
- F04 is acceptable with a bounded artifact/resource manifest tied to the verified owner: resolved served-client directory; server binary only for --all; supervisor and admin CLI; session-host bind mount; managed workload image; host-side sidecar only if the managed path needs one; managed-runtime image-reference environment; and persistent registry, provider/history, runtime, and workspace roots to preserve. Build from the matching deployment checkout so compile-time resource paths remain valid. Use the supervisor's explicit Docker socket. Stage any renamed artifact on the destination filesystem and refuse unresolved owner, path, or daemon information. Do not run prepare:rust-runtime from a task worktree or let it create/mutate a missing .env; inspect whether image-contained sidecar resources make host preparation unnecessary.
- F05 was falsified for inventory followed by sequential Stops while the web API remains open. Build and stage first, stop the web/API unit, then take the final fixed inventory and issue existing revision-fenced Stops through the still-running supervisor. This closes UI create/retry ingress before inventory and lets Stop cancel or drain recovery. Abort durable replacement on stale intent, timeout/unknown, or any outcome other than VerifiedEmpty. Record each result and never re-inventory to overwrite newer intent. Do not add a global admission service or deployment transaction journal. If source review finds another supported production ingress outside the stopped unit, choose the narrowest correction that preserves the three modes.
- Do not automatically restore old binaries or image settings after the updated runtime may have opened persistent state. Build first; on post-stop failure report the failed phase and partial state, preserve persistent data, and follow the selected owner's forward-recovery runbook.
- Apply the direct corrections from the finder/strategist reports: keep reset targets separate from records with reopen references; do not use the fresh-agent history endpoint for terminal souls; inspect typed Stop outcomes; select coding providers while excluding shell; restrict the terminal continuity command to the provider-free shell case at runtime-terminal-continuity-rust.spec.ts:116; make the fixture observe the changed runtime marker, retained history, new incarnation, and follow-up use; stage renames on the destination filesystem; and do not claim that the provider-free fixture proves installed systemd wiring.

## Global Constraints

- Keep all work in /home/dan/code/freshell/.worktrees/durable-maintenance-modes on the-usual/durable-maintenance-modes. Do not run a production command or alter a live service.
- Behavioral tests use the disposable managed-runtime fixture and stub process, Docker, and systemd adapters. Do not run the updater against the self-hosted installation.
- Parse the mode first. Unknown or combined flags exit 2 without prompting or effects. For --all and --durable-only, read one raw stdin line and require exactly APPROVED before owner inspection, builds, API/control-socket calls, file writes, or service actions. Missing, lowercase, padded, or extra-text input refuses without effects. Do not consult compatibility analysis.
- After approval where required, verify the supported systemd user-unit owner and resource manifest before any build, session change, or service action. The supported target is only the selected pair; refuse if checkout, executable, control socket, client, image daemon, or persistent-path ownership is ambiguous or mismatched. Resolve the Docker socket from the effective supervisor unit and verify the daemon through that explicit socket. Do not reveal secret values in output or logs.
- Default mode needs no approval. It verifies the selected client owner, runs client typecheck, stages and activates only the resolved served-client directory, and prints that the supervisor and managed sessions were not restarted plus the exact-approval reminder for reset modes. It makes no supervisor control request and no service start/stop/restart call.
- --all stages the client, managed-feature server, supervisor, supervisor admin CLI, session-host, and workload image. --durable-only stages the supervisor, admin CLI, session-host, and workload image; it does not build or replace the server binary or client directory. Both reset modes reset active managed coding souls by default, preserve registry/provider/history/workspace data, attempt eligible Reopen operations, and have no no-reset flag.
- Select reset targets from one final inventory taken only after the web/API unit is stopped. Deduplicate by soul; include active/provisioning/stopping and desired-running or recovering souls; include pre-native targets without requiring a native session ID; exclude the provider shell and already-stopped souls. Keep available reopen references separate from the complete reset-target list.
- Use the exact control socket and the built supervisor admin CLI for Inventory, each revision-fenced Stop, and Reopen. Give each request a unique idempotency request ID. Inspect each typed Stop result and continue only when it is VerifiedEmpty. A stale revision, unknown timeout, missing soul/incarnation/revision needed for a valid Stop, or any other Stop outcome aborts durable replacement. A missing native session ID does not remove a soul from reset eligibility; it only makes its Reopen result unavailable. Record results without re-inventorying or overwriting a newer intent. Preserve stopped intent for souls that were stopped before the update.
- Build from the matching deployment checkout to preserve compile-time paths. Build the managed server with freshell-server/managed-runtime-v1 only when selected. Build and inspect the workload image using the exact Docker socket selected from the supervisor unit; do not use ambient Docker context. Use a bounded resource manifest covering the resolved client, server when selected, supervisor/admin CLI, session-host bind path, image, image-reference environment, any required host-side sidecar, and persistent roots. Do not run prepare:rust-runtime from a task worktree or allow it to create/mutate a missing .env. Inspect whether the image-contained sidecar makes host preparation unnecessary.
- Stage renamed outputs on each destination filesystem. Install only selected artifacts. Do not capture or retain old binaries/image references for rollback, do not restore old code after a failure, and do not add backup or transaction-journal plumbing. A post-stop failure reports its exact phase and partial state, keeps persistent data intact, and points to the selected owner's forward-recovery runbook.
- Stopping freshell-rust.service closes web/API ingress but, with After= only, does not stop or start freshell-supervisor.service. The reset modes briefly stop and explicitly start the web/API unit. In --durable-only, this restarts the existing web server process while leaving its binary and resolved client assets unchanged; operator guidance must say this.
- Ordinary web/client maintenance has no APPROVED rule. The systemd relation prevents it from activating the supervisor; the web service may fail to start when the supervisor is absent. The launcher remains limited to launch-owned Rust server processes, refuses systemd/unknown-owned ports, and never starts or restarts the supervisor. The updater explicitly starts the supervisor before the web service only in reset modes.
- Add structured JSONL records with severity for approval refusal, each build/install/service phase, per-soul Stop/Reopen outcomes, partial failure, and completion. Never log auth tokens, provider secrets, launch data that contains secrets, or conversation bodies.
- Use existing locked pnpm/Cargo commands and repo test lanes. Do not add prose/config snapshot tests. No planned test contacts a real provider, production Docker image, production service, or live systemd user-unit manager.

## File ownership

- crates/freshell-server/src/managed_provider_bootstrap.rs: repair qualification compile errors while preserving Codex approval policy and MCP preparation.
- scripts/update-managed-runtime.ts: define mode parsing, exact approval, owner verification, bounded artifact manifest, staging, action order, web/API unit stop/start, supervisor CLI calls, reset/reopen reporting, operator messages, and structured event logging.
- package.json: expose update:managed-runtime.
- crates/freshell-runtime-protocol/src/lib.rs: add the typed, revision-fenced, idempotent supervisor Reopen request/result to the control protocol.
- crates/freshell-supervisor/src/registry.rs and crates/freshell-supervisor/src/service.rs: implement Reopen against the same stopped soul, stored launch/resume context, provider store, and native identity; return typed unavailable/failure results without fabricating identity.
- crates/freshell-runtime-client/src/lib.rs: expose the direct control-socket operations needed by the admin CLI.
- crates/freshell-runtime-client/src/bin/freshell-supervisor-admin.rs: add the CLI for exact-socket Inventory, Stop, and Reopen requests. It must not use the HTTP API.
- installers/systemd/freshell-rust.service.d/managed-runtime.conf: replace Requires= with ordering-only After=.
- test/unit/tooling/managed-runtime-update.test.ts: verify mode selection, exact approval before effects, owner refusal, selected artifact boundaries, ordered web-stop/fixed-inventory/typed-stop flow, no client/server replacement in durable-only, partial Stop/Reopen reporting, forward-only failure handling, and redacted structured logs with disposable adapters.
- crates/freshell-supervisor/src/service.rs and crates/freshell-supervisor/src/registry.rs tests: verify Reopen revision fencing, idempotency, new incarnation, retained provider store/native identity, updated runtime selection, unavailable missing-native-ID behavior, and unchanged history.
- test/e2e-browser/specs/runtime-fresh-agent-fixture-rust.spec.ts: prove default continuity, --all reset/reopen on a changed runtime marker with retained history, and --durable-only server restart with unchanged server/client artifacts using fixture-owned processes.
- AGENTS.md: replace blanket live-server approval wording with the reset-mode rule and ordinary-restart behavior.
- scripts/launch-rust.sh: remove blanket approval wording while retaining PID ownership and systemd-owner safety checks; ordinary launcher operations remain Rust-only and never control the supervisor.
- docs/development/self-hosted-launch-runbook.md: document the three update modes and remove contradictory blanket approval wording.
- docs/development/managed-runtime-rollout.md: update only the existing runtime restart statement; preserve its separate migration guidance and remove any promised automatic old-artifact rollback.

---

### Task 1: Repair Managed Provider Qualification Compilation

**Files:**
- Modify: crates/freshell-server/src/managed_provider_bootstrap.rs:92-133,364-385,654-676

**Interfaces:**
- Consumes: provider_launch_context_for_managed(provider, workspace, mcp_capability) and ProviderPreparation::Codex { approval_default, tui_args, sidecar_args }.
- Produces: a compiling managed-provider-qualification server target; Codex starts with empty MCP args without a capability, and with_managed_mcp_reference updates only MCP args/capability while preserving approval_default.

- [ ] **Step 1: Write the failing behavioral regression**

Extend managed_codex_provider_context_renders_tui_and_sidecar_mcp with the no-capability case while retaining its capability-present assertions:

~~~rust
let without_capability =
    provider_launch_context_for_managed("codex", workspace.path(), None).unwrap();
let ProviderPreparation::Codex {
    approval_default,
    tui_args,
    sidecar_args,
} = &without_capability.preparation
else {
    panic!("Codex preparation missing");
};
assert!(approval_default.is_none());
assert!(tui_args.is_empty());
assert!(sidecar_args.is_empty());
without_capability.validate("codex").unwrap();
~~~

- [ ] **Step 2: Run the test and verify the intended failure**

Run: cargo test -p freshell-server --features managed-provider-qualification --bin freshell-server managed_provider_bootstrap::tests::managed_codex_provider_context_renders_tui_and_sidecar_mcp -- --exact

Expected: FAIL during compilation because mcp_enabled is undefined in provider_launch_context_from_home_at_with_selected_roots and the Codex pattern in with_managed_mcp_reference omits approval_default (E0425 and E0027). The failure must identify these existing source errors.

- [ ] **Step 3: Add the minimal production implementation**

Initialize source-less Codex preparation with empty MCP argument vectors; the optional capability branch later fills them through with_managed_mcp_reference. Ignore the policy field in the mutable match so its existing value remains intact:

~~~rust
ProviderPreparation::Codex {
    approval_default: None,
    tui_args: Vec::new(),
    sidecar_args: Vec::new(),
}
~~~

~~~rust
ProviderPreparation::Codex {
    tui_args,
    sidecar_args,
    ..
} => {
    let args =
        managed_codex_mcp_args().ok_or("managed Codex MCP preparation unavailable")?;
    *tui_args = args.clone();
    *sidecar_args = args;
}
~~~

- [ ] **Step 4: Run the focused test**

Run: cargo test -p freshell-server --features managed-provider-qualification --bin freshell-server managed_provider_bootstrap::tests::managed_codex_provider_context_renders_tui_and_sidecar_mcp -- --exact

Expected: PASS for capability-present and capability-absent behavior.

- [ ] **Step 5: Refactor while green**

Keep both argument vectors initialized empty and assigned only by the capability helper; this removes the nonexistent toggle without adding another source of MCP enablement.

Run: cargo fmt --all --check

Expected: PASS.

- [ ] **Step 6: Run impacted-test verification**

Run: cargo test -p freshell-server --features managed-provider-qualification --bin freshell-server managed_provider_bootstrap::tests::managed_codex_provider_context_renders_tui_and_sidecar_mcp -- --exact && cargo test -p freshell-server --features managed-provider-qualification --bin freshell-server managed_mcp_capability::tests::managed_provider_codex_selected_inputs_reach_private_generation -- --exact

Expected: PASS; the first test covers both MCP paths and the second proves the source-aware Codex approval default still reaches private generation.

- [ ] **Step 7: Commit the task**

~~~bash
git add crates/freshell-server/src/managed_provider_bootstrap.rs
git commit -m "fix: restore managed provider qualification compilation"
~~~

### Task 2: Implement the Three Update Modes and Prove Session Behavior

**Files:**
- Create: scripts/update-managed-runtime.ts
- Modify: package.json scripts block to add update:managed-runtime.
- Create: test/unit/tooling/managed-runtime-update.test.ts
- Modify: test/e2e-browser/specs/runtime-fresh-agent-fixture-rust.spec.ts
- Modify: crates/freshell-runtime-protocol/src/lib.rs
- Modify: crates/freshell-supervisor/src/registry.rs and crates/freshell-supervisor/src/service.rs
- Modify: crates/freshell-runtime-client/src/lib.rs
- Create: crates/freshell-runtime-client/src/bin/freshell-supervisor-admin.rs
- Modify: installers/systemd/freshell-rust.service.d/managed-runtime.conf
- Modify: AGENTS.md:76-109
- Modify: scripts/launch-rust.sh:28-34,152-159
- Modify: docs/development/self-hosted-launch-runbook.md:25-59,67-125,425-458
- Modify: docs/development/managed-runtime-rollout.md:80-86

**Interfaces:**
- Consumes: pnpm run update:managed-runtime [--all|--durable-only]; the selected systemd user-unit pair; an owner-derived artifact/resource manifest; and direct supervisor control-socket Inventory, Stop, and Reopen commands.
- Produces: parseManagedUpdateMode(args: readonly string[]): 'client' | 'all' | 'durable-only'; runManagedRuntimeUpdate(args, dependencies): Promise<number>; ManagedCodingSoulResetTarget { soulId, expectedIntentRevision, provider, incarnationId? }; ReopenCandidate { soulId, stoppedIntentRevision, provider, sessionId }; StopResult { soulId, outcome, currentIntentRevision? }; and ReopenResult { soulId, outcome: 'reopened' | 'unavailable' | 'failed', newIncarnationId?, errorCode? }. Reset targets and records with native references are distinct collections. Dependencies separate approval, owner verification, staging, web unit, supervisor CLI, installation, readiness, output, and JSONL logging.

- [ ] **Step 1: Write failing updater, supervisor, and fixture tests**

Create test/unit/tooling/managed-runtime-update.test.ts. Inject dependencies that record ordered actions and never touch the host. Cover:

- Unknown and combined modes refuse before prompting or running any dependency.
- Missing, lowercase, padded, or extra-text approval refuses both reset modes before owner inspection, build, control-socket request, file write, or service action.
- Default mode verifies the client owner, typechecks, stages and activates only the client, prints both required reminders, and makes no supervisor control or service call.
- --all selects client, managed server, supervisor, admin CLI, session-host, and workload image artifacts. --durable-only skips client build/stage/replacement and managed server replacement, while briefly stopping and starting the existing web/API service.
- A seeded resolved-client digest is unchanged by --durable-only. The fixture also proves that the same served-client directory remains selected across the web-process restart.
- Owner mismatch, unavailable selected socket/image daemon, or an unresolved path refuses before any service/session mutation.
- Both reset modes finish selected builds/staging before stopping web/API. They then stop web ingress before the one final inventory, submit exactly one Stop per selected coding soul, and do not stop the supervisor or install artifacts unless every Stop is VerifiedEmpty.
- Target selection deduplicates souls, includes pre-native and desired-running/recovering coding souls, excludes provider shell and already-stopped souls, and never requires a native ID for reset eligibility.
- Stale intent, timeout/unknown, and each typed Stop outcome other than VerifiedEmpty are reported and prevent replacement. Continue through the captured target list only to report each target's one Stop result; never re-inventory or retry against a newer revision. If some Stops already succeeded, report those partial outcomes and prove persistent data remains intact.
- Reopen is attempted for every candidate after the new supervisor is ready. A missing native ID is reported unavailable without a fabricated identity or store; a failed reopen does not prevent later candidates from being attempted and does not roll back the runtime.
- A post-stop install/start/readiness failure reports the exact failed phase and partial service state, preserves the registry/provider/history/workspace roots, and does not restore prior binaries, image settings, or client files.
- Structured log records include event, severity, mode, and phase where applicable, and never contain the seeded auth token, provider secret, launch data, or conversation body.
- The new admin CLI uses the existing control protocol version and Inventory/Stop wire contract against the pre-update supervisor; it sends Reopen only after the updated supervisor is listening.

If the new TypeScript module is needed for the red tests to load, add a temporary inert export of the updater interfaces and a run function that returns 2. The tests must load and fail on the default action behavior, not fail during module setup. Replace this scaffold in Step 3.

Use this central assertion:

~~~typescript
it('refuses reset modes before owner inspection or side effects unless approval is exact', async () => {
  for (const approval of [undefined, '', 'approved', ' APPROVED ', 'APPROVED extra']) {
    for (const flag of ['--all', '--durable-only']) {
      const fixture = updateFixture(approval)
      expect(await runManagedRuntimeUpdate([flag], fixture.dependencies)).toBe(2)
      expect(fixture.actions).toEqual([])
      expect(fixture.approvalReads).toBe(1)
    }
  }
})
~~~

Also assert that successful reset order is: owner verification; selected builds and staging; stop web/API; final supervisor Inventory; typed per-soul Stops; stop supervisor; install selected artifacts; start supervisor; wait for the exact control socket; attempt Reopen operations; start web/API; wait for server readiness. For --durable-only, assert the web process is restarted while neither the server binary nor resolved client directory is replaced.

In crates/freshell-supervisor/src/service.rs and registry.rs, add failing behavior tests for an idempotent Reopen request with the expected stopped intent revision, a stale-revision refusal that preserves newer intent, a new incarnation on the same soul/provider store/native ID using the current runtime marker, and a typed unavailable result when native identity is absent. Prove the history marker remains readable after Stop and Reopen. Keep the operation on the supervisor control protocol; do not add an HTTP route.

In test/e2e-browser/specs/runtime-fresh-agent-fixture-rust.spec.ts, add provider-free behavior cases:

1. Run the default updater with fixture-controlled owner/build adapters, perform the ordinary web replacement, then assert supervisor and managed soul/incarnation/container/native-session identities and the history marker are unchanged and a follow-up turn completes.
2. Run --all with exact approval using fixture-owned unit, inventory, Stop, install, restart, and Reopen adapters. Observe a changed runtime marker, a new incarnation with the same soul/provider store/native session, the retained history marker, and a successful follow-up turn. Observe the direct Reopen control command and its request ID; do not assert an existing browser create/resume path.
3. Run --durable-only and assert the web process briefly stops/restarts, the resolved client directory and served-client digest remain unchanged, and a reset soul reopens on the changed runtime.

The fixture demonstrates the updater's mode ordering and runtime behavior. It does not certify the installed systemd dependency graph. Do not use any real provider or production service.

- [ ] **Step 2: Run focused tests and verify the intended failures**

Run: pnpm run test:vitest run test/unit/tooling/managed-runtime-update.test.ts --config config/vitest/vitest.config.ts

Expected: FAIL on the new client/update behavior because the temporary no-effect export performs no work. The config and imports must load.

Run: cargo test -p freshell-supervisor reopen_stopped_soul

Expected: FAIL because the supervisor Reopen operation does not yet exist. The selector must run at least one test and must not report a zero-test pass.

Run: pnpm run test:runtime:fresh-agent-fixtures

Expected: FAIL at the new default, reset/reopen, or durable-only behavior assertion. Existing fixture tests must execute; a skipped new test is not a red result.

- [ ] **Step 3: Implement the supervisor Reopen operation, updater, and operator guidance**

Implement parseManagedUpdateMode so only no arguments, exactly --all, or exactly --durable-only are accepted; reject all other combinations before calling dependencies.

Keep importing scripts/update-managed-runtime.ts inert for unit and fixture tests. Guard the CLI entrypoint, parse process.argv.slice(2) only from that entrypoint, and assign the returned status to process.exitCode.

Implement a direct supervisor Reopen control operation. It takes an idempotency request ID, soul ID, and expected current intent revision; refuses stale intent without changing newer user state; transitions the existing stopped soul to a new running incarnation; and uses that soul's persisted launch/resume context, provider-store ID/volume, and native identity while selecting the currently configured runtime image and session-host. The operation does not derive a replacement soul or store from the request ID. Return a typed unavailable result if required native identity is missing. Reuse normal launch/recovery machinery where its preconditions fit, and preserve history.

Implement a supervisor admin CLI backed by the runtime client and existing private control socket. It supports Inventory, revision-fenced Stop, and Reopen, accepts the exact owner-selected socket and secret-file paths, and emits typed machine-readable results without secret values. Build the CLI from the same deployment checkout as the selected systemd owner. The CLI must use the existing control protocol version and preserve the existing Inventory/Stop wire contract so it can take the final snapshot and stop souls through the currently running supervisor before replacement. Send the new Reopen command only after the updated supervisor is listening. Cover that ordering in the CLI/protocol tests; compatibility behavior never changes the user's approval requirement.

Implement the updater in this order:

1. Parse flags. Invalid input exits 2 without prompting or dependency calls. For either reset mode, read one raw stdin line and require exactly APPROVED before owner inspection or any other external effect. Do not trim it or consult compatibility analysis.
2. Verify the selected systemd user-unit owner using bounded, non-secret unit properties and process metadata. Confirm the current checkout equals the selected units' working directory and executable/install source, the running server and supervisor belong to those units, and the exact control socket is served by the selected supervisor. Resolve the Docker socket from the effective supervisor unit and verify its daemon through that explicit socket for reset modes. Resolve the actual served-client directory, selected binary paths, image-reference environment path, session-host bind path, sidecar use, and persistent roots. Refuse ambiguity before building or changing state.
3. Stage every selected artifact from that matching checkout. For default, typecheck the client and run Vite into a temporary sibling of the resolved client destination. For --all, do the same and also build the managed-feature server, supervisor, admin CLI, session-host, and workload image. For --durable-only, do not build the client or web server; build the supervisor, admin CLI, session-host, and workload image only. Build Rust outputs into an isolated staging target rather than overwriting installed binaries. Build and inspect the workload image by passing the verified socket path explicitly to Docker; use its immutable image ID. Inspect the image and call sites to determine whether host-side sidecar preparation is needed. If required host-side resources cannot be staged from the matching checkout without mutating an active dependency or creating/mutating a missing .env, fail before stopping any service. Do not run prepare:rust-runtime from a task worktree or allow it to bootstrap a missing .env.
4. For default, activate only the staged client through a destination-filesystem rename, print the required reminder, and finish without a service or supervisor-control call.
5. For either reset mode, stop freshell-rust.service to close UI/API create/retry ingress. Through the exact supervisor socket, take one final Inventory snapshot and derive a fixed deduplicated coding-soul target set. Use the coding-provider allowlist and exclude shell. Include active/pre-native and desired-running/recovering souls; keep saved reopen references separate. Issue one Stop per target using its captured expectedIntentRevision and unique idempotency request ID. Inspect and record each typed outcome. Do not re-inventory, retry with a newer revision, or install anything unless every target is VerifiedEmpty.
6. After all Stops are verified empty, stop freshell-supervisor.service. Install only the selected staged files by destination-filesystem rename; update only the selected FRESHELL_RUNTIME_IMAGE entry in the verified owner environment file using an atomic same-filesystem write that preserves the other entries. Do not replace the resolved client or server binary in --durable-only. Do not copy or restore old artifacts.
7. Start freshell-supervisor.service explicitly and wait for the exact control socket to answer supervisor health. Attempt a Reopen for every available saved conversation against the new runtime, using the stopped revision and a unique idempotency request ID. Record unavailable/missing-native and failed results without stopping later attempts. Then explicitly start freshell-rust.service and wait for its existing readiness endpoint. With After= only, neither service implicitly starts the other.
8. If a Stop batch fails while the supervisor is still running, report all captured Stop outcomes and any partial reset. Restart the web unit if it was stopped and the selected supervisor remains healthy; do not re-inventory or replace artifacts. For a failure after supervisor shutdown or artifact installation starts, report the failed phase, affected units, and partial state; preserve registry/provider/history/workspace data and follow the selected owner's forward-recovery runbook. Never claim rollback or restore older binaries/image settings. A failed reopen after readiness is a partial success: continue all reopen attempts, return 1, and say manual reopening may be needed.

Wrap build, stop, install, start, control-socket, Reopen, and readiness phases in structured JSONL logging with severity, mode, and phase. Log result counts and stable error codes only; omit secrets, launch data, and conversation contents.

Build commands must use the pinned repository toolchain and existing dependencies. Select freshell-server with freshell-server/managed-runtime-v1 only for --all; select freshell-supervisor, freshell-session-host, and the freshell-runtime-client supervisor-admin binary for both reset modes. Build the image from docker/runtime/Dockerfile through the explicit selected Docker socket. Add package.json script:

~~~json
"update:managed-runtime": "tsx scripts/update-managed-runtime.ts"
~~~

Operator guidance documents these outcomes: default updates only the served client and reminds the operator that the supervisor and managed sessions were not restarted and that reset modes require one exact APPROVED line. --all stages and updates client plus durable artifacts. --durable-only updates durable artifacts but briefly stops/restarts the existing web/API process while preserving its binary and client assets. Both reset modes preserve history and attempt to reopen each eligible conversation; reopening can fail, so history remains available and manual reopening or porting may be needed. Unknown/refused input exits 2; update or reopen failure exits 1; completed update and all successful reopen attempts exit 0. Ordinary client/web maintenance has no approval rule. Do not change README.md.

- [ ] **Step 4: Run the focused tests**

Run: pnpm run test:vitest run test/unit/tooling/managed-runtime-update.test.ts --config config/vitest/vitest.config.ts && pnpm run test:runtime:fresh-agent-fixtures

Expected: PASS; invalid/refused input has no external effects, default changes only the selected client and reminds the operator, --all and --durable-only follow the fixed inventory/typed Stop sequence, --durable-only leaves client/server artifacts unchanged, Reopen is revision-fenced/idempotent and retains history, and all three modes pass the provider-free runtime fixture.

- [ ] **Step 5: Refactor while green**

Keep argument parsing, owner verification, manifest resolution, staging, mode action order, systemd commands, admin CLI calls, and output rendering in separate named functions. Share only artifact and service actions that are identical between reset modes. Keep exact approval before owner inspection for reset modes, fail closed on mismatched ownership, and ensure each Stop/Reopen result is recorded and every eligible Reopen is attempted. Do not add rollback, old-artifact backups, or a general transaction journal.

Run: pnpm run test:vitest run test/unit/tooling/managed-runtime-update.test.ts --config config/vitest/vitest.config.ts && pnpm run test:runtime:fresh-agent-fixtures

Expected: PASS.

- [ ] **Step 6: Run impacted-test verification**

Run: cargo fmt --all --check && cargo test -p freshell-runtime-protocol && cargo test -p freshell-supervisor reopen_stopped_soul && cargo test -p freshell-runtime-client --bin freshell-supervisor-admin && pnpm run typecheck:runtime && scripts/launch-rust.sh --help >/dev/null && pnpm run test:vitest run test/unit/tooling/managed-runtime-update.test.ts --config config/vitest/vitest.config.ts && pnpm run test:runtime:fresh-agent-fixtures && pnpm run test:e2e:local --project=chromium --grep "P2-G01: real browser shell survives ten graceful/abrupt web replacements" test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts

Expected: PASS; protocol and supervisor Reopen tests pass, the updater typechecks, launcher parsing remains valid, all provider-free mode fixtures pass, and the terminal continuity command selects only the shell case at runtime-terminal-continuity-rust.spec.ts:116 rather than the real-provider P2-G04 case. Review git diff --check and manually reconcile approval wording and the After=-only relation across AGENTS.md, the launcher, systemd drop-in, and both operator runbooks. Do not add a prose/config snapshot test or run a production/systemd service operation.

- [ ] **Step 7: Commit the task**

~~~bash
git add scripts/update-managed-runtime.ts package.json test/unit/tooling/managed-runtime-update.test.ts test/e2e-browser/specs/runtime-fresh-agent-fixture-rust.spec.ts crates/freshell-runtime-protocol/src/lib.rs crates/freshell-supervisor/src/registry.rs crates/freshell-supervisor/src/service.rs crates/freshell-runtime-client/src/lib.rs crates/freshell-runtime-client/src/bin/freshell-supervisor-admin.rs installers/systemd/freshell-rust.service.d/managed-runtime.conf AGENTS.md scripts/launch-rust.sh docs/development/self-hosted-launch-runbook.md docs/development/managed-runtime-rollout.md
git commit -m "feat: add managed runtime update modes"
~~~

## Plan self-review

- The mandatory complete User Request block remains byte-for-byte unchanged and appears exactly once.
- Task 1 still fixes the qualification compile failure first, with a behavioral regression and focused compile/test verification.
- The three modes are explicit: default stages and activates only the resolved client; --all updates client and durable artifacts; --durable-only updates durable artifacts while briefly restarting the existing web process and preserving its server binary and client directory.
- Both reset modes require exact APPROVED before owner inspection or effects. No compatibility analysis gates approval, and ordinary client/web maintenance has no approval rule.
- F01's falsified existing-reopen assumption is replaced with the narrow, idempotent, revision-fenced supervisor Reopen operation. It uses the existing soul/store/context and reports missing native identity unavailable.
- F02 and F04 use the accepted systemd-user-unit-only owner and bounded artifact manifest. The plan verifies matching checkout, units, process, socket, destinations, image daemon, and persistent roots, then fails closed on ambiguity. The runtime client protocol is direct; no HTTP owner-identity endpoint or inventory/Stop/Reopen route is introduced.
- F03 is resolved by ordering-only After=. The plan excludes Requires=, Wants=, and Requisite=, documents that web start can fail without activating the supervisor, and explicitly sequences updater starts.
- F05's falsified open-API inventory/Stop batch is replaced with build/stage first, stop web/API, one final fixed inventory, typed revision-fenced Stops, and no re-inventory or overwrite of newer intent. No global admission service or deployment journal is added.
- Reset targets are separate from reopen records; shell is excluded; native identity is optional for reset; Stop outcome must be VerifiedEmpty; history sources are not treated as universal; and fixture assertions include changed runtime marker, retained history, new incarnation, and follow-up use.
- Old-binary/image rollback and backup plumbing are absent. Failure tests require exact partial-state reporting and persistent-data preservation. Filesystem rename staging stays on the destination filesystem.
- Planned verification uses focused Rust/Vitest/runtime fixture tests and selects only the provider-free P2-G01 shell continuity case. The plan does not claim those process fixtures verify installed systemd wiring.
- Every owned source, test, unit, script, and guidance file appears in Task 1 or Task 2. No placeholder, unresolved Stage 2 assumption, real-provider call, production operation, or unrelated feature remains in the plan.

---
