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

Operators can update the web/API server and served client without restarting the durable supervisor or resetting managed coding sessions, update the web/client and durable runtime together, or update the durable runtime alone. The two reset-capable modes require an exact APPROVED line, preserve conversation history, reset managed coding sessions, and attempt reopening them on the updated runtime.

## Architecture

Add pnpm run update:managed-runtime with a web/client default and explicit --all and --durable-only modes. Resolve the supported systemd user-unit owner and its artifact/resource manifest before staging. Before any web restart, inspect the effective installed systemd dependency graph and refuse if an activation edge could start or restart the supervisor. The web unit drop-in uses ordering-only After= so ordinary web/client maintenance cannot activate or restart the supervisor. The updater explicitly sequences any supervisor and web starts it needs.

The default mode builds and stages the regular web server and served client, installs both, and restarts only freshell-rust.service. It makes no supervisor control request, does not stop managed sessions, and does not restart or activate the durable supervisor. Both reset modes require exact approval; a wrapper reads one raw stdin line, then a transient systemd user service revalidates that same line before owner inspection or other work so the operation can finish if stopping the web/API service kills its caller PTY. They stage all selected artifacts and compare candidate/current registry schema before stopping any service. Then they stop the web/API unit to close UI create/retry ingress, take one final inventory over the still-running supervisor's exact control socket, and submit typed per-soul Stops. After every selected Stop is verified empty, they stop the supervisor, install the selected artifacts, start the supervisor and wait for its control socket, then start the web/API unit and wait for readiness before attempting Reopen. A new supervisor admin CLI performs Inventory, typed Stops, and revision-fenced Reopen directly over the control socket. Reopen uses the web-owned MCP capability callback, first retries/confirms the exact prior Stop and grant revocation, and does not advance the stopped intent revision or create an incarnation while revocation is unresolved.

The new Reopen operation uses the stopped soul's saved launch/resume context, native identity, and provider store to create a new incarnation with the current runtime. A missing native ID keeps the soul in the reset set but yields an explicit unavailable-to-reopen result. An unresolved grant revocation yields a typed pending result at the same stopped revision; the caller can retry with a fresh request ID. A repeated completed request ID returns the same result without creating another incarnation. Do not fabricate a soul, native ID, or store. Keep the current Inventory/Stop protocol version and wire contract; send additive Reopen only to the updated supervisor. The compile repair is a prerequisite commit.

## Tech Stack

TypeScript/NodeNext, pnpm 10.34.5, Rust/Cargo managed-runtime feature, the existing supervisor control protocol and runtime client, a supervisor admin CLI, Docker workload image, systemd user units, Vitest, Playwright, and the managed-runtime fixture harness.

## Stage 2 decisions

The Stage 2 ledger and evidence are in /home/dan/code/freshell/.worktrees/.the-usual-logs/durable-maintenance-modes/load-bearing-ledger.md and its reports directory. This section records the decisions the implementation must follow.

- F01 was falsified. Existing browser Reopen and create/resume paths cannot start a new incarnation of a stopped soul on its retained provider volume. Add the narrow supervisor admin Reopen operation described above. It is revision-fenced and idempotent; it uses the saved context and current runtime. Missing native IDs remain reset targets and are reported unavailable.
- F02 is acceptable only for the existing systemd user-unit installation. Before staging or mutation, verify the current checkout matches the selected units' working directory and executable/install paths, identify the running supervisor and socket from those units, and refuse on ambiguity. Before any web stop/start, inspect the effective loaded systemd dependency graph (for example, `systemctl --user show` properties and transitive activation edges), not just checked-in files; refuse if an activation edge could start or restart the supervisor and explain that the unit/drop-in must be deployed and systemd reloaded before retrying. `After=` alone is ordering-only and does not activate the supervisor. Use the exact supervisor socket for Inventory, Stop, and Reopen through the supervisor admin CLI. Do not use an HTTP API for those operations or add an HTTP identity endpoint unless direct socket ownership cannot be established.
- F03 was falsified. Replace the web drop-in's Requires= with ordering-only After=; do not use Wants= or Requisite=. Web start/restart may fail when the supervisor is absent, but must not activate or restart it. The updater explicitly starts the supervisor before the web service when a reset mode needs both.
- F04 is acceptable with a bounded artifact/resource manifest tied to the verified owner: resolved served-client directory and web server binary for default and --all; supervisor and admin CLI for reset modes; session-host bind mount; managed workload image; host-side sidecar only if the managed path needs one; managed-runtime image-reference environment; and persistent registry, provider/history, runtime, and workspace roots to preserve. Build from the matching deployment checkout so compile-time resource paths remain valid. Use the supervisor's explicit Docker socket. Stage renamed artifacts on the destination filesystem. Replace a non-empty client directory with a same-filesystem two-rename swap through a unique sibling path; this creates a brief client-path availability gap. If the second rename fails, leave the old directory at the reported sibling path, do not restart the web service, and report the manual recovery path. Remove the old sibling after a successful swap. Refuse unresolved owner, path, or daemon information. Do not run prepare:rust-runtime from a task worktree or let it create/mutate a missing .env; inspect whether image-contained sidecar resources make host preparation unnecessary.
- F05 was falsified for inventory followed by sequential Stops while the web API remains open. Build and stage first, stop the web/API unit, then take the final fixed inventory and issue existing revision-fenced Stops through the still-running supervisor. This closes UI create/retry ingress before inventory and lets Stop cancel or drain recovery. Abort durable replacement on stale intent, timeout/unknown, or any outcome other than VerifiedEmpty. Record each result and never re-inventory to overwrite newer intent. A VerifiedEmpty Stop may still have a grant revocation pending; after installing and starting the new supervisor, start the web/API unit and wait for its MCP callback socket before attempting Reopen. Reopen retries/confirms the exact old Stop/revocation and cannot advance intent or create an incarnation while it remains unresolved. Do not add a global admission service or deployment transaction journal. If source review finds another supported production ingress outside the stopped unit, choose the narrowest correction that preserves the three modes.
- Preserve the managed-runtime rollout rule for schema-changing candidate registry openers without adding backup or rollback machinery: after exact mode approval and before stopping any service, compare the candidate opener's registry schema with the current registry. If migration would occur, refuse and direct the operator to the existing verified old-schema backup/upgrade procedure. This is a preflight safety check, not a compatibility-based approval decision.
- Do not automatically restore old binaries or image settings after the updated runtime may have opened persistent state. Build first; on post-stop failure report the failed phase and partial state, preserve persistent data, and follow the selected owner's forward-recovery runbook.
- Apply the direct corrections from the finder/strategist reports: keep reset targets separate from records with reopen references; do not use the fresh-agent history endpoint for terminal souls; inspect typed Stop outcomes; select coding providers while excluding shell; restrict the terminal continuity command to the provider-free shell case at runtime-terminal-continuity-rust.spec.ts:116; make the fixture observe the changed runtime marker, retained history, new incarnation, and follow-up use; stage renames on the destination filesystem; and do not claim that the provider-free fixture proves installed systemd wiring.

## Global Constraints

- Keep all work in /home/dan/code/freshell/.worktrees/durable-maintenance-modes on the-usual/durable-maintenance-modes. Do not run a production command or alter a live service.
- Behavioral tests use the disposable managed-runtime fixture and stub process, Docker, and systemd adapters. Do not run the updater against the self-hosted installation.
- Parse the mode first. Unknown or combined flags exit 2 without prompting or effects. For --all and --durable-only, read one raw stdin line and require exactly APPROVED before owner inspection, builds, API/control-socket calls, file writes, or service actions. After that check, place the exact line in a one-use mode-0600 file under the user's runtime directory; the transient worker reads, revalidates, and deletes it before owner inspection or other work. Do not put the approval line in command arguments, environment values, or logs. Missing, lowercase, padded, or extra-text input refuses without effects. Do not consult compatibility analysis. Default mode does not prompt or launch a detached worker.
- After approval where required, verify the supported systemd user-unit owner and resource manifest before any build, session change, or service action. The supported target is only the selected pair; refuse if checkout, executable, control socket, client, image daemon, or persistent-path ownership is ambiguous or mismatched. Before any web stop/start, inspect the effective loaded systemd dependency graph (including `systemctl --user show` properties and transitive activation edges), not just the checked-in drop-in; refuse if an installed Requires= or other activation edge could start/restart the supervisor, and explain that the unit/drop-in must be deployed and systemd reloaded before retrying. Resolve the Docker socket from the effective supervisor unit and verify the daemon through that explicit socket. Do not reveal secret values in output or logs.
- Default mode needs no approval. It verifies the selected web/client owner and safe effective dependency graph, runs client typecheck and builds the regular web server plus client, stages and installs both, then restarts only freshell-rust.service and waits for readiness. It prints that the supervisor and managed sessions were not restarted plus the exact-approval reminder for reset modes. It makes no supervisor control request and no supervisor service start/stop/restart call.
- --all stages the client, managed-feature server, supervisor, supervisor admin CLI, session-host, and workload image. --durable-only stages the supervisor, admin CLI, session-host, and workload image; it does not build or replace the server binary or client directory. Both reset modes reset active managed coding souls by default, preserve registry/provider/history/workspace data, attempt eligible Reopen operations, and have no no-reset flag.
- Select reset targets from one final inventory taken only after the web/API unit is stopped. Deduplicate by soul; include active/provisioning/stopping and desired-running or recovering souls; include pre-native targets without requiring a native session ID; exclude the provider shell and already-stopped souls. Keep available reopen references separate from the complete reset-target list.
- Use the exact control socket and the built supervisor admin CLI for Inventory, each revision-fenced Stop, and Reopen. Give each request a unique idempotency request ID. Inspect each typed Stop result and continue only when it is VerifiedEmpty. A stale revision, unknown timeout, missing soul/incarnation/revision needed for a valid Stop, or any other Stop outcome aborts durable replacement. A missing native session ID does not remove a soul from reset eligibility; it only makes its Reopen result unavailable. Record results without re-inventorying or overwriting a newer intent. Preserve stopped intent for souls that were stopped before the update.
- Build from the matching deployment checkout to preserve compile-time paths. Build the regular web server and client for default; build the managed-feature web server and client for --all. Build the server with freshell-server/managed-runtime-v1 only for --all. Build and inspect the workload image using the exact Docker socket selected from the supervisor unit; do not use ambient Docker context. Use a bounded resource manifest covering the resolved client, server when selected, supervisor/admin CLI, session-host bind path, image, image-reference environment, any required host-side sidecar, and persistent roots. Do not run prepare:rust-runtime from a task worktree or allow it to create/mutate a missing .env. Inspect whether the image-contained sidecar makes host preparation unnecessary.
- In reset modes, compare the candidate supervisor registry schema with the current persistent registry after exact approval and before stopping any service. If the candidate opener would migrate the registry, refuse and direct the operator to the existing verified old-schema backup/upgrade procedure. This safety preflight does not affect approval and adds no backup mechanism.
- Stage renamed outputs on each destination filesystem. Swap a non-empty client directory through a unique sibling path using two same-filesystem renames; cover the brief availability gap and second-rename failure in tests and report the sibling recovery path without restarting on failure. Install only selected artifacts. Do not capture or retain old binaries/image references for rollback, do not restore old code after a later update failure, and do not add backup or transaction-journal plumbing. A post-stop failure reports its exact phase and partial state, keeps persistent data intact, and points to the selected owner's forward-recovery runbook.
- Stopping freshell-rust.service closes web/API ingress but, with After= only, does not stop or start freshell-supervisor.service. The reset modes briefly stop and explicitly start the web/API unit. Start the updated supervisor first, then web/API and wait for readiness, then attempt Reopen so its callback can reach the web-owned mcp.sock. In --durable-only, this restarts the existing web server process while leaving its binary and resolved client assets unchanged; operator guidance must say this.
- Ordinary web/client maintenance has no APPROVED rule. The effective installed systemd relation must prevent it from activating the supervisor; the web service may fail to start when the supervisor is absent. The launcher remains limited to launch-owned Rust server processes, refuses systemd/unknown-owned ports, and never starts or restarts the supervisor. The updater explicitly starts the supervisor before the web service only in reset modes.
- Add structured JSONL records with severity for approval refusal, each build/install/service phase, per-soul Stop/Reopen outcomes, partial failure, and completion. Never log auth tokens, provider secrets, launch data that contains secrets, or conversation bodies.
- Use existing locked pnpm/Cargo commands and repo test lanes. Do not add prose/config snapshot tests. No planned test contacts a real provider, production Docker image, production service, or live systemd user-unit manager.

## File ownership

- crates/freshell-server/src/managed_provider_bootstrap.rs: repair qualification compile errors while preserving Codex approval policy and MCP preparation.
- scripts/update-managed-runtime.ts: define mode parsing, exact approval, transient reset worker and worker-side approval revalidation, owner and effective-systemd-graph verification, bounded artifact manifest, schema preflight, staging, action order, web/API unit stop/start, supervisor CLI calls, reset/reopen reporting, operator messages, recoverable worker status/logging, and structured event logging.
- package.json: expose update:managed-runtime.
- crates/freshell-runtime-protocol/src/lib.rs: add the typed, revision-fenced, idempotent supervisor Reopen request/result to the control protocol.
- crates/freshell-supervisor/src/registry.rs and crates/freshell-supervisor/src/service.rs: implement Reopen against the same stopped soul, stored launch/resume context, provider store, and native identity; return typed unavailable/failure results without fabricating identity.
- crates/freshell-runtime-client/src/lib.rs: expose the direct control-socket operations needed by the admin CLI.
- crates/freshell-runtime-client/src/bin/freshell-supervisor-admin.rs: add the CLI for exact-socket Inventory, Stop, and Reopen requests. It must not use the HTTP API.
- installers/systemd/freshell-rust.service.d/managed-runtime.conf: replace Requires= with ordering-only After=.
- test/unit/tooling/managed-runtime-update.test.ts: verify mode selection, exact approval and worker revalidation before effects, effective systemd graph refusal, candidate schema refusal before service stop, selected artifact boundaries, default server/client restart without supervisor access, ordered web-stop/fixed-inventory/typed-stop flow, no client/server replacement in durable-only, client-directory swap and failure behavior, partial Stop/Reopen reporting, forward-only failure handling, and redacted structured logs with disposable adapters.
- crates/freshell-supervisor/src/service.rs and crates/freshell-supervisor/src/registry.rs tests: verify Reopen callback availability, exact Stop/revoke retry, pending revoke without revision advance or new incarnation, revision fencing, idempotency, new incarnation, retained provider store/native identity, updated runtime selection, unavailable missing-native-ID behavior, and unchanged history.
- test/e2e-browser/specs/runtime-fresh-agent-fixture-rust.spec.ts: import scripts/update-managed-runtime.ts so typecheck:managed-tests checks it; prove default continuity, --all reset/reopen on a changed runtime marker with retained history, and --durable-only server restart with unchanged server/client artifacts using fixture-owned processes.
- scripts/testing/runtime-sandbox.ts: add the minimal fixture option to select a changed fixture workload image/reference when restarting its supervisor, so Reopen can prove the new runtime marker without contacting a production image or service.
- AGENTS.md: replace blanket live-server approval wording with the reset-mode rule and ordinary-restart behavior.
- scripts/launch-rust.sh: remove blanket approval wording while retaining PID ownership and systemd-owner safety checks; ordinary launcher operations remain Rust-only and never control the supervisor.
- docs/development/self-hosted-launch-runbook.md: document the three update modes, exact approval and transient worker recovery, effective dependency-graph refusal and deployment/reload guidance, and remove contradictory Requires= and blanket approval wording (including lines 300-307).
- docs/development/managed-runtime-rollout.md: update the existing runtime restart statement at lines 74-77; preserve its separate schema migration and verified backup/upgrade guidance and remove any promised automatic old-artifact rollback.

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
- Modify: scripts/testing/runtime-sandbox.ts
- Modify: crates/freshell-runtime-protocol/src/lib.rs
- Modify: crates/freshell-supervisor/src/registry.rs and crates/freshell-supervisor/src/service.rs
- Modify: crates/freshell-runtime-client/src/lib.rs
- Create: crates/freshell-runtime-client/src/bin/freshell-supervisor-admin.rs
- Modify: installers/systemd/freshell-rust.service.d/managed-runtime.conf
- Modify: AGENTS.md:76-109
- Modify: scripts/launch-rust.sh:28-34,152-159
- Modify: docs/development/self-hosted-launch-runbook.md:25-59,67-125,300-307,425-458
- Modify: docs/development/managed-runtime-rollout.md:74-77

**Interfaces:**
- Consumes: pnpm run update:managed-runtime [--all|--durable-only]; the selected systemd user-unit pair; an owner-derived artifact/resource manifest; exact stdin approval for reset modes; and direct supervisor control-socket Inventory, Stop, and Reopen commands.
- Produces: parseManagedUpdateMode(args: readonly string[]): 'client' | 'all' | 'durable-only' (where 'client' selects both web server and served client); runManagedRuntimeUpdate(args, dependencies): Promise<number>; ManagedCodingSoulResetTarget { soulId, expectedIntentRevision, provider, incarnationId? }; ReopenCandidate { soulId, stoppedIntentRevision, provider, sessionId }; StopResult { soulId, outcome, currentIntentRevision? }; and ReopenResult { soulId, outcome: 'reopened' | 'pending' | 'unavailable' | 'failed', newIncarnationId?, errorCode? }. Reset targets and records with native references are distinct collections. Dependencies separate approval, worker dispatch, owner and effective graph verification, schema preflight, staging, web unit, supervisor CLI, installation, readiness, output, recoverable worker status, and JSONL logging.

- [ ] **Step 1: Write failing updater, supervisor, and fixture tests**

Create test/unit/tooling/managed-runtime-update.test.ts. Inject dependencies that record ordered actions and never touch the host. Cover:

- Unknown and combined modes refuse before prompting or running any dependency.
- Missing, lowercase, padded, or extra-text approval refuses both reset modes before owner inspection, build, control-socket request, file write, or service action.
- Default mode verifies the web/client owner and safe effective systemd graph, typechecks, builds/stages and installs the regular web server plus client, restarts only the web/API unit, waits for readiness, prints both required reminders, and makes no supervisor control/service call.
- --all selects client, managed server, supervisor, admin CLI, session-host, and workload image artifacts. --durable-only skips client build/stage/replacement and managed server replacement, while briefly stopping and starting the existing web/API service.
- A seeded resolved-client digest is unchanged by --durable-only. The fixture also proves that the same served-client directory remains selected across the web-process restart.
- Owner mismatch, unsafe effective dependency graph, schema-changing candidate opener, unavailable selected socket/image daemon, or an unresolved path refuses before any service/session mutation. A graph refusal names deployment and systemd-reload guidance.
- Both reset modes run under a transient systemd user service after the wrapper accepts the exact line; the worker revalidates it before owner inspection and exposes recoverable status/logs after the caller PTY disappears. Both modes finish selected builds/staging and schema preflight before stopping web/API. They then stop web ingress before the one final inventory, submit exactly one Stop per selected coding soul, and do not stop the supervisor or install artifacts unless every Stop is VerifiedEmpty.
- The reset approval input is written only after the wrapper accepts the exact line, uses a mode-0600 one-use runtime file, is not placed in command arguments/environment/logs, and is deleted by the worker after validation. Refused input creates no request file.
- Target selection deduplicates souls, includes pre-native and desired-running/recovering coding souls, excludes provider shell and already-stopped souls, and never requires a native ID for reset eligibility.
- Stale intent, timeout/unknown, and each typed Stop outcome other than VerifiedEmpty are reported and prevent replacement. Continue through the captured target list only to report each target's one Stop result; never re-inventory or retry against a newer revision. If some Stops already succeeded, report those partial outcomes and prove persistent data remains intact.
- After the updated supervisor is ready, start the web/API unit and wait until its MCP callback socket is ready before attempting Reopen. Each Reopen first retries/confirms the exact captured Stop and grant revocation; if it remains pending, return a typed pending result without advancing the stopped intent revision or creating an incarnation. A fresh request ID may retry the same stopped revision. A missing native ID is reported unavailable without a fabricated identity or store; a failed Reopen does not prevent later candidates from being attempted and does not roll back the runtime. A repeated completed request ID returns the original result without creating another incarnation.
- The two-rename client-directory swap uses a unique same-filesystem sibling path, creates a tested brief availability gap, and reports the preserved sibling path if the second rename fails; it does not restart the web/API service on that failure.
- A post-stop install/start/readiness failure reports the exact failed phase and partial service state, preserves the registry/provider/history/workspace roots, and does not restore prior binaries, image settings, or client files.
- Structured log records include event, severity, mode, and phase where applicable, and never contain the seeded auth token, provider secret, launch data, or conversation body.
- The new admin CLI uses the existing control protocol version and Inventory/Stop wire contract against the pre-update supervisor; it sends Reopen only after the updated supervisor is listening.
- The changed-runtime fixture can select a second fixture-owned workload image/reference through scripts/testing/runtime-sandbox.ts; it exercises neither a production image nor the installed systemd manager.

If the new TypeScript module is needed for the red tests to load, add a temporary inert export of the updater interfaces and a run function that returns 2. The tests must load and fail on the default action behavior, not fail during module setup. The fixture spec imports the updater so pnpm run typecheck:managed-tests checks its types. Replace the scaffold in Step 3.

Before the Rust red run, add the minimal compile-safe typed Reopen request/result and service dispatch seam, with the seam returning a temporary typed unsupported result. The behavioral test must execute and fail because it receives unsupported instead of the expected Reopen behavior; do not use a compile error or zero-test run as the red result. Replace the temporary result in Step 3.

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

Also assert that a successful default order is: owner and effective graph verification; client typecheck plus regular server/client builds and staging; server install and two-step client-directory swap; restart only freshell-rust.service; wait for readiness and print reminders. No supervisor control call or supervisor service action occurs. For reset modes, assert: wrapper accepts exact approval and launches the transient worker; worker revalidates that exact line; owner and effective graph verification; selected builds/staging plus schema preflight; stop web/API; final supervisor Inventory; typed per-soul Stops; stop supervisor; install selected artifacts; start supervisor; wait for the exact control socket; start web/API; wait for readiness and callback availability; attempt Reopen operations. For --durable-only, assert the web process is restarted while neither the server binary nor resolved client directory is replaced.

In crates/freshell-supervisor/src/service.rs and registry.rs, add failing behavior tests for an idempotent Reopen request with the expected stopped intent revision, a stale-revision refusal that preserves newer intent, a new incarnation on the same soul/provider store/native ID using the current runtime marker, a typed unavailable result when native identity is absent, and a callback-ready launch. Prove that after Stop returns VerifiedEmpty while grant revocation is pending, Reopen retries/confirms that exact Stop/revoke; if still pending it returns typed pending without changing the stopped revision or creating an incarnation, and after settlement a fresh request ID reopens successfully without duplicate incarnation. Prove the history marker remains readable throughout. Keep the operation on the supervisor control protocol; do not add an HTTP route.

In test/e2e-browser/specs/runtime-fresh-agent-fixture-rust.spec.ts, add provider-free behavior cases:

1. Run the default updater with fixture-controlled owner, graph, build, install, and web-unit adapters. Let the updater replace the regular web server and client and restart only the fixture web process; assert supervisor and managed soul/incarnation/container/native-session identities and the history marker are unchanged and a follow-up turn completes.
2. Run --all with exact approval using fixture-owned transient worker, unit, inventory, Stop, install, restart, callback, and Reopen adapters. Observe a changed runtime marker, a new incarnation with the same soul/provider store/native session, the retained history marker, and a successful follow-up turn. Observe the direct Reopen control command and its request ID; do not assert an existing browser create/resume path.
3. Run --durable-only and assert the web process briefly stops/restarts, the resolved client directory and served-client digest remain unchanged, and a reset soul reopens on the changed runtime after callback readiness.

The fixture demonstrates the updater's mode ordering and runtime behavior. It does not certify the installed systemd dependency graph; test that graph through stubbed effective-unit properties. Add the minimal fixture image/reference option in scripts/testing/runtime-sandbox.ts so the changed runtime marker comes from a fixture-owned workload image. Do not use any real provider, production image, or production service.

- [ ] **Step 2: Run focused tests and verify the intended failures**

Run: pnpm run test:vitest run test/unit/tooling/managed-runtime-update.test.ts --config config/vitest/vitest.config.ts

Expected: FAIL on the new default web/client or reset-worker behavior because the temporary no-effect export performs no work. The config and imports must load.

Run: cargo test -p freshell-supervisor reopen_stopped_soul

Expected: FAIL at the executed behavioral assertion because the compile-safe service seam returns the temporary typed unsupported result. The selector must run at least one test and must not report a compile failure or zero-test pass.

Run: pnpm run test:runtime:fresh-agent-fixtures

Expected: FAIL at the new default, reset/reopen, or durable-only behavior assertion. Existing fixture tests must execute; a skipped new test is not a red result.

- [ ] **Step 3: Implement the supervisor Reopen operation, updater, and operator guidance**

Implement parseManagedUpdateMode so only no arguments, exactly --all, or exactly --durable-only are accepted; reject all other combinations before calling dependencies. The no-argument default builds and updates the regular web server plus client. --all builds the managed-feature web server plus client and selects durable artifacts; --durable-only selects only durable artifacts.

Keep importing scripts/update-managed-runtime.ts inert for unit and fixture tests. The reset-mode CLI wrapper reads one raw stdin line, requires exactly APPROVED, and only then writes it to a one-use mode-0600 file under the user's runtime directory and submits work to a transient systemd user service. Pass only the request-file path to the worker; it reads the raw line, revalidates it, and deletes the file before owner inspection or other work. Do not put the approval line in command arguments, environment values, or logs. Wait for the worker's result while the caller remains alive; the transient service continues independently if stopping freshell-rust.service kills its caller PTY. Use a recoverable, discoverable transient unit name and journal/structured logs so status and progress survive that interruption. The default mode does not launch a detached worker. Guard the CLI entrypoint, parse process.argv.slice(2) only from that entrypoint, and assign the returned status to process.exitCode.

Implement a direct supervisor Reopen control operation. It takes an idempotency request ID, soul ID, and expected current stopped intent revision; refuses stale intent without changing newer user state; and first retries/confirms the exact Stop and grant revocation for that revision. If revocation remains pending, return a typed pending result without advancing the stopped intent revision or creating an incarnation; allow retry at that revision with a fresh request ID. After settlement, transition the existing stopped soul to a new running incarnation and use that soul's persisted launch/resume context, provider-store ID/volume, and native identity while selecting the currently configured runtime image and session-host. The operation does not derive a replacement soul or store from the request ID. A missing required native identity returns typed unavailable. Repeating a completed request ID returns the recorded result and never creates a second incarnation. Reuse normal launch/recovery machinery where its preconditions fit, and preserve history. Reopen uses the web-owned capability callback, so the updater must start freshell-rust.service and wait for callback readiness before sending Reopen.

Implement a supervisor admin CLI backed by the runtime client and existing private control socket. It supports Inventory, revision-fenced Stop, and Reopen, accepts the exact owner-selected socket and secret-file paths, and emits typed machine-readable results without secret values. Build the CLI from the same deployment checkout as the selected systemd owner. Keep the existing control protocol version and Inventory/Stop wire contract so it can take the final snapshot and stop souls through the currently running supervisor before replacement. Send the additive Reopen command only to the updated supervisor after it is listening; do not add a second legacy CLI. Cover that ordering in the CLI/protocol tests; compatibility behavior never changes the user's approval requirement.

Implement the updater in this order:

1. Parse flags. Invalid input exits 2 without prompting or dependency calls. For either reset mode, read one raw stdin line and require exactly APPROVED before owner inspection or any other external effect. Do not trim it or consult compatibility analysis.
2. Verify the selected systemd user-unit owner using bounded, non-secret unit properties and process metadata. Confirm the current checkout equals the selected units' working directory and executable/install source, the running server and supervisor belong to those units, and the exact control socket is served by the selected supervisor. Before any web stop/start, inspect the effective installed dependency graph, including Requires= and any other activation edge that could start/restart the supervisor. Refuse before web actions when unsafe; report the installed unit/drop-in and tell the operator to deploy the After=-only relation and reload systemd. Resolve the Docker socket from the effective supervisor unit and verify its daemon through that explicit socket for reset modes. Resolve the actual served-client directory, selected binary paths, image-reference environment path, session-host bind path, sidecar use, and persistent roots. Refuse ambiguity before building or changing state.
3. Stage every selected artifact from that matching checkout. For default, typecheck the client and build the regular web server and client into isolated staging outputs. For --all, build the client and managed-feature web server plus supervisor, admin CLI, session-host, and workload image. For --durable-only, do not build the client or web server; build the supervisor, admin CLI, session-host, and workload image only. Build Rust outputs into an isolated staging target rather than overwriting installed binaries. Build and inspect the workload image by passing the verified socket path explicitly to Docker; use its immutable image ID. For reset modes, compare the candidate registry opener's schema with the current registry before stopping any service; if migration would occur, refuse and direct the operator to the existing verified old-schema backup/upgrade procedure. Inspect the image and call sites to determine whether host-side sidecar preparation is needed. If required host-side resources cannot be staged from the matching checkout without mutating an active dependency or creating/mutating a missing .env, fail before stopping any service. Do not run prepare:rust-runtime from a task worktree or allow it to bootstrap a missing .env.
4. For default, install the staged server binary and activate the client with a same-filesystem two-step directory swap: rename the non-empty current client directory to a unique sibling path, then rename the staged directory into its place, then remove the old sibling after activation. There is a brief interval when the client path is absent. If the second rename fails, leave the old directory at the reported sibling path, do not restart the web service, and report the manual recovery path. Restart only freshell-rust.service, wait for its readiness endpoint, print the required reminder, and finish without supervisor control or service calls.
5. For either reset mode, stop freshell-rust.service to close UI/API create/retry ingress. Through the exact supervisor socket, take one final Inventory snapshot and derive a fixed deduplicated coding-soul target set. Use the coding-provider allowlist and exclude shell. Include active/pre-native and desired-running/recovering souls; keep saved reopen references separate. Issue one Stop per target using its captured expectedIntentRevision and unique idempotency request ID. Inspect and record each typed outcome. Do not re-inventory, retry with a newer revision, or install anything unless every target is VerifiedEmpty.
6. After all Stops are verified empty, stop freshell-supervisor.service. Install only the selected staged files by destination-filesystem rename; use the two-step client-directory swap when client is selected. Update only the selected FRESHELL_RUNTIME_IMAGE entry in the verified owner environment file using an atomic same-filesystem write that preserves the other entries. Do not replace the resolved client or server binary in --durable-only. Do not copy or restore old artifacts.
7. Start freshell-supervisor.service explicitly and wait for the exact control socket to answer supervisor health. Then explicitly start freshell-rust.service and wait for server readiness and the web-owned MCP callback socket. Attempt Reopen for every available saved conversation against the new runtime, using the stopped revision and a unique idempotency request ID. The supervisor first retries/confirms that target's exact old Stop/grant revocation; a pending revoke returns typed pending without advancing intent or creating an incarnation. Record unavailable/missing-native, pending, and failed results without stopping later attempts. With After= only, neither service implicitly starts the other.
8. If a Stop batch fails while the supervisor is still running, report all captured Stop outcomes and any partial reset. Restart the web unit if it was stopped and the selected supervisor remains healthy; do not re-inventory or replace artifacts. For a failure after supervisor shutdown or artifact installation starts, report the failed phase, affected units, and partial state; preserve registry/provider/history/workspace data and follow the selected owner's forward-recovery runbook. Never claim rollback or restore older binaries/image settings. A failed or pending reopen after readiness is a partial success: continue all Reopen attempts, return 1, and say manual reopening may be needed.

Wrap build, stop, install, start, control-socket, Reopen, and readiness phases in structured JSONL logging with severity, mode, and phase. Log result counts and stable error codes only; omit secrets, launch data, and conversation contents.

Build commands must use the pinned repository toolchain and existing dependencies. Select freshell-server with freshell-server/managed-runtime-v1 only for --all; select freshell-supervisor, freshell-session-host, and the freshell-runtime-client supervisor-admin binary for both reset modes. Build the image from docker/runtime/Dockerfile through the explicit selected Docker socket. Add package.json script:

~~~json
"update:managed-runtime": "tsx scripts/update-managed-runtime.ts"
~~~

Operator guidance documents these outcomes: default updates the regular web server and served client without restarting the supervisor or managed sessions, restarts only freshell-rust.service, and reminds the operator that reset modes require one exact APPROVED line. --all updates web/client plus durable artifacts. --durable-only updates durable artifacts but briefly stops/restarts the existing web/API process while preserving its binary and client assets. Both reset modes preserve history and attempt to reopen each eligible conversation only after web/API callback readiness; reopening can be pending or fail, so history remains available and manual reopening or porting may be needed. Reset work runs in a transient user service; print its unit name and the systemctl --user status/journalctl commands needed to recover progress after the caller PTY disappears. Refuse a schema-changing candidate opener before service stop and direct the operator to the existing verified backup/upgrade procedure. Unknown/refused input exits 2; update or reopen failure exits 1; completed update and all successful reopen attempts exit 0. Ordinary web/client maintenance has no approval rule. If the installed dependency graph can activate the supervisor, refuse before any web restart and explain deployment plus daemon-reload guidance. Do not change README.md.

- [ ] **Step 4: Run the focused tests**

Run: pnpm run test:vitest run test/unit/tooling/managed-runtime-update.test.ts --config config/vitest/vitest.config.ts && pnpm run test:runtime:fresh-agent-fixtures

Expected: PASS; invalid/refused input has no external effects, default updates the regular web server and served client then restarts only the web/API unit and prints reminders, --all and --durable-only follow the fixed inventory/typed Stop sequence, --durable-only leaves client/server artifacts unchanged, Reopen waits for callback readiness and is revision-fenced/idempotent while retaining history, and all three modes pass the provider-free runtime fixture.

- [ ] **Step 5: Refactor while green**

Keep argument parsing, owner verification, manifest resolution, staging, mode action order, systemd commands, admin CLI calls, and output rendering in separate named functions. Share only artifact and service actions that are identical between reset modes. Keep exact approval before owner inspection for reset modes, fail closed on mismatched ownership, and ensure each Stop/Reopen result is recorded and every eligible Reopen is attempted. Do not add rollback, old-artifact backups, or a general transaction journal.

Run: pnpm run test:vitest run test/unit/tooling/managed-runtime-update.test.ts --config config/vitest/vitest.config.ts && pnpm run test:runtime:fresh-agent-fixtures

Expected: PASS.

- [ ] **Step 6: Run impacted-test verification**

Run: cargo fmt --all --check && cargo test -p freshell-runtime-protocol && cargo test -p freshell-supervisor reopen_stopped_soul && cargo test -p freshell-runtime-client --bin freshell-supervisor-admin && pnpm run typecheck:managed-tests && scripts/launch-rust.sh --help >/dev/null && pnpm run test:vitest run test/unit/tooling/managed-runtime-update.test.ts --config config/vitest/vitest.config.ts && pnpm run test:runtime:fresh-agent-fixtures && pnpm run test:e2e:local --project=chromium --grep "P2-G01: real browser shell survives ten graceful/abrupt web replacements" test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts

Expected: PASS; protocol and supervisor Reopen tests pass, typecheck:managed-tests checks the updater through the fixture-spec import, launcher parsing remains valid, all provider-free mode fixtures pass, and the terminal continuity command selects only the shell case at runtime-terminal-continuity-rust.spec.ts:116 rather than the real-provider P2-G04 case. Review git diff --check and manually reconcile approval wording, the effective dependency-graph check, and the After=-only relation across AGENTS.md, the launcher, systemd drop-in, and both operator runbooks. Do not add a prose/config snapshot test or run a production/systemd service operation.

- [ ] **Step 7: Commit the task**

~~~bash
git add scripts/update-managed-runtime.ts package.json test/unit/tooling/managed-runtime-update.test.ts test/e2e-browser/specs/runtime-fresh-agent-fixture-rust.spec.ts scripts/testing/runtime-sandbox.ts crates/freshell-runtime-protocol/src/lib.rs crates/freshell-supervisor/src/registry.rs crates/freshell-supervisor/src/service.rs crates/freshell-runtime-client/src/lib.rs crates/freshell-runtime-client/src/bin/freshell-supervisor-admin.rs installers/systemd/freshell-rust.service.d/managed-runtime.conf AGENTS.md scripts/launch-rust.sh docs/development/self-hosted-launch-runbook.md docs/development/managed-runtime-rollout.md
git commit -m "feat: add managed runtime update modes"
~~~

## Plan self-review

- The mandatory complete User Request block remains byte-for-byte unchanged and appears exactly once (SHA-256 recorded during this plan amendment: 121a5de05fd73ced7a8a7e54e34583f5aa561dab2eca973f74a62acf88874a88).
- Task 1 still fixes the qualification compile failure first, with a behavioral regression and focused compile/test verification.
- The three modes are explicit: default builds/updates regular web server plus client and restarts only freshell-rust.service; --all updates web/client using the managed-feature server plus durable artifacts; --durable-only updates durable artifacts while briefly restarting the existing web process and preserving its server binary and client directory.
- Both reset modes require exact APPROVED before owner inspection or effects. No compatibility analysis gates approval, and ordinary client/web maintenance has no approval rule.
- Reset mode runs in a transient systemd user service only after exact raw-line approval; its worker revalidates the same line from a one-use owner-only runtime file before owner inspection, deletes the file, and keeps unit status/logs available after caller-PTY loss. Default has no detached worker.
- F01's falsified existing-reopen assumption is replaced with the narrow, idempotent, revision-fenced supervisor Reopen operation. It uses the existing soul/store/context and reports missing native identity unavailable.
- Reopen occurs only after the updated supervisor and web/API are ready, so the web-owned callback socket is available. It retries/confirms the exact captured Stop/revocation before advancing the stopped revision; pending revocation creates no incarnation, and completed request IDs do not duplicate one.
- F02 and F04 use the accepted systemd-user-unit-only owner and bounded artifact manifest. The plan verifies matching checkout, units, process, socket, destinations, image daemon, persistent roots, and the effective installed dependency graph, then fails closed on ambiguity. It preserves the current Inventory/Stop protocol version and sends additive Reopen only to the updated supervisor. No HTTP owner-identity endpoint or inventory/Stop/Reopen route is introduced.
- F03 is resolved by ordering-only After=. The plan excludes Requires=, Wants=, and Requisite=, documents that web start can fail without activating the supervisor, and explicitly sequences updater starts.
- F05's falsified open-API inventory/Stop batch is replaced with build/stage first, stop web/API, one final fixed inventory, typed revision-fenced Stops, and no re-inventory or overwrite of newer intent. No global admission service or deployment journal is added.
- Schema-changing candidate openers are refused before service stop and directed to the existing verified backup/upgrade procedure; the plan adds no backup feature.
- Reset targets are separate from reopen records; shell is excluded; native identity is optional for reset; Stop outcome must be VerifiedEmpty; history sources are not treated as universal; and fixture assertions include changed runtime marker, retained history, new incarnation, and follow-up use.
- Old-binary/image rollback, backup plumbing, and transaction journal are absent. Failure tests require exact partial-state reporting and persistent-data preservation. Client replacement uses a tested same-filesystem two-step directory swap with a brief path gap and explicit second-rename failure reporting.
- Planned verification uses focused Rust/Vitest/runtime fixture tests and selects only the provider-free P2-G01 shell continuity case. The plan does not claim those process fixtures verify installed systemd wiring.
- Every owned source, test, unit, script, and guidance file, including scripts/testing/runtime-sandbox.ts, appears in Task 1 or Task 2 and the implementation commit command. Managed updater types are checked through typecheck:managed-tests because the fixture spec imports the module. The Rust red test executes a typed unsupported seam rather than failing compilation.
- Existing verified schema-migration backup/upgrade guidance remains the operator path when preflight finds a candidate migration. No production operation is planned.

---
