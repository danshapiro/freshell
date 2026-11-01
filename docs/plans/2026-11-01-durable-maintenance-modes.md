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

Operators can update the client alone, client and durable runtime together, or durable runtime alone, with exact approval before modes that reset managed coding sessions and with saved conversation recovery attempted afterward.

## Architecture

Add one operator command, pnpm run update:managed-runtime, with a client-only default and explicit --all and --durable-only modes. The default builds the client only. The two reset-capable modes gate all effects on a verbatim APPROVED input, update the selected artifacts, stop managed coding souls through the existing revision-fenced API, restart the documented durable-runtime owner, and attempt to reopen saved conversations through the recovery path validated in Stage 2. The compile repair is a prerequisite commit.

## Tech Stack

TypeScript/NodeNext, pnpm 10.34.5, Rust/Cargo managed-runtime feature, Docker workload image, systemd user units, Vitest, Playwright, and the existing managed-runtime fixture harness.

## Global Constraints

- Keep all work in /home/dan/code/freshell/.worktrees/durable-maintenance-modes on the-usual/durable-maintenance-modes. Do not run a production command or alter a live service.
- Do not run the updater against the self-hosted installation during implementation. Behavioral tests use the disposable managed-runtime fixture and stub build/service commands.
- Approval is mode-based, without compatibility analysis. --all and --durable-only require one exact input line, APPROVED, before the first API call, build, file write, install, or service action. Missing, lowercase, padded, or extra-text input refuses with no effects.
- Parse the mode and read approval before creating RUN_DIR or UPDATE_TAG; rejected reset modes leave no temp files and run no command or API request. If any build or preparation step fails before the service stop, remove RUN_DIR and leave sessions and services untouched.
- Default mode requires no approval. It runs only pnpm run typecheck:client and pnpm run build:client. It never builds or installs managed binaries or an image, calls systemd, stops a managed soul, or changes session/history data. It prints the required reminder after a successful client build.
- --all includes client and managed durable artifacts. --durable-only does not build or replace the client artifact. Both reset active managed coding souls by default after approval, retain their history/provider data, and attempt to reopen their saved conversation references. Do not add a no-reset flag.
- A coding-soul reset uses the current expectedIntentRevision and a new crypto.randomUUID() requestId for each POST /api/runtime/souls/{soul_id}/stop. Do not use retry as a restart operation. Preserve stopped intent for souls that were already stopped and do not stop ordinary shell souls.
- Keep the managed server build feature-enabled: cargo build --release -p freshell-server -p freshell-supervisor -p freshell-session-host --locked --features freshell-server/managed-runtime-v1. Prepare the runtime sidecar with pnpm run --silent prepare:rust-runtime and build/pin the workload image from docker/runtime/Dockerfile. Never overwrite a managed deployment with the plain build:rust artifact.
- Before stopping any session or service, finish every selected build, prepare the Rust runtime sidecar/auth prerequisite, stage the client when selected, and capture the previous deployable artifacts and runtime-image reference. If install or restart fails after stopping begins, restore the previous selected artifacts and image reference, then start the prior systemd pair and wait for readiness; retain the staging directory and report both the original failure and any recovery failure. Keep this recovery local to the updater rather than introducing a general rollback system.
- In the checked-in systemd topology, restarting freshell-supervisor.service also restarts its dependent freshell-rust.service. --durable-only must leave dist/client byte-for-byte unchanged even if systemd restarts the server process as a dependency.
- Keep ordinary web/client restarts free of an approval rule. The default update mode must not call freshell-supervisor.service directly or through a combined service target.
- Add structured JSONL records with severity for approval refusal, reset/reopen results, each build/install/service phase, and final completion. Never log auth tokens, provider secrets, or conversation bodies.
- Use the existing locked pnpm install and repo test commands. Do not add prose/config snapshot tests. No planned test contacts a live provider, production Docker image, or production service.

## Load-bearing assumptions for Stage 2

Resolve these claims in the Stage 2 load-bearing ledger before implementation; amend this plan with verified interfaces if either claim is false.

1. **Reset and reopen:** A managed coding soul can be stopped through the existing revision-fenced per-soul route without deleting its provider-state/history data, and the saved pane/session reference can be used by the existing browser recovery path to attempt a new managed incarnation after the supervisor update. Stage 2 must trace the saved-reference source, stop request, post-restart create/resume request, and history read in the provider-free fixture. If automatic pane recovery does not attempt the reopen, Stage 2 must identify the smallest existing API/client seam that does and revise Task 2 before implementation.
2. **Systemd topology:** The supported managed deployment owner for this command is the documented systemd user-unit pair, and restarting freshell-supervisor.service causes the dependent Rust server process to restart while leaving the static client directory untouched in --durable-only. Stage 2 must confirm this against the checked-in unit/drop-in relationship and an isolated fixture. If “web/client unchanged” means the Rust server process must also stay alive, the current Requires= relationship cannot satisfy that contract and Stage 2 must revise the service-topology plan rather than reinterpret the requirement.

## File ownership

- crates/freshell-server/src/managed_provider_bootstrap.rs: repair qualification compile errors while preserving Codex approval policy and MCP preparation.
- scripts/update-managed-runtime.ts: define mode parsing, exact approval, action order, production command adapters, session reset/reopen, operator messages, and structured event logging.
- package.json: expose update:managed-runtime.
- test/unit/tooling/managed-runtime-update.test.ts: verify mode selection, approval refusal before effects, client inclusion/exclusion, output, and partial reopen reporting with a disposable action trace.
- test/e2e-browser/specs/runtime-fresh-agent-fixture-rust.spec.ts: prove default continuity and approved reset/reopen with fixture-owned managed sessions.
- AGENTS.md: replace blanket live-server approval wording with the reset-mode rule and ordinary-restart behavior.
- scripts/launch-rust.sh: remove blanket approval wording while retaining PID ownership and systemd-owner safety checks.
- docs/development/self-hosted-launch-runbook.md: document the three update modes and remove contradictory blanket approval wording.
- docs/development/managed-runtime-rollout.md: narrow only the existing restart statement; preserve the separate migration/backup procedure.

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
- Modify: package.json scripts block to add update:managed-runtime beside the Rust-runtime preparation commands.
- Create: test/unit/tooling/managed-runtime-update.test.ts
- Modify: test/e2e-browser/specs/runtime-fresh-agent-fixture-rust.spec.ts
- Modify: AGENTS.md:76-109
- Modify: scripts/launch-rust.sh:28-34,152-159
- Modify: docs/development/self-hosted-launch-runbook.md:25-59,67-125,425-458
- Modify: docs/development/managed-runtime-rollout.md:80-86

**Interfaces:**
- Consumes: pnpm run update:managed-runtime [--all|--durable-only]; GET /api/runtime/souls, GET /api/runtime/souls/{soul_id}/history, and revision-fenced POST /api/runtime/souls/{soul_id}/stop; checked-in systemd user units; and the session-reference recovery path selected by Stage 2.
- Produces: parseManagedUpdateMode(args: readonly string[]): 'client' | 'all' | 'durable-only'; runManagedRuntimeUpdate(args, dependencies): Promise<number>; SavedManagedConversation { soulId, expectedIntentRevision, sessionRef, mode, cwd }; and ReopenResult { sessionRef, ok, errorCode? }. The exported ManagedRuntimeUpdateDependencies contains named methods for approval, client/durable build, session snapshot/stop, artifact install, supervisor/socket/server/readiness, reopen, output, and JSONL logging.

- [ ] **Step 1: Write the failing unit and fixture tests**

Create test/unit/tooling/managed-runtime-update.test.ts. Inject dependencies that record ordered actions and never touch the host. Cover default mode; missing, lowercase, padded, or extra-text approval; conflicting/unknown modes; --all versus --durable-only artifact inclusion; a seeded client artifact hash unchanged by --durable-only; a failed reopen followed by attempts for all saved references; and an install/restart failure that restores prior artifacts and brings the prior service pair to readiness.

Use this central assertion:

~~~typescript
it('refuses reset modes before any action unless approval is exact', async () => {
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

Also assert that default action order is exactly typecheck-client, build-client, with no approval read, service action, or session action. Assert that --all stages the client plus durable runtime, while --durable-only skips the client stage, stops/restarts managed runtime, and attempts reopening. For both reset modes, assert all build and sidecar-preparation actions precede session stop and service stop. Inject an installation failure and a new-runtime readiness failure; in both cases assert that recovery stops both units, restores prior artifacts, starts the supervisor, waits for its socket, starts the Rust server, and reaches readiness. Inject a separate restore failure; assert the staging directory remains and the command reports failed update/recovery phases and unit names without claiming readiness. Verify structured log records carry event/severity/phase fields for build/install/service phases and never contain the seeded auth token or conversation body. Keep the failed-reopen fixture's history marker unchanged and verify both saved session references were attempted.

In the same red step, add a no-effect export so the test module loads and fails on the client behavior assertion rather than module setup. The following interface stub is temporary and is replaced in Step 3:

~~~typescript
export type ManagedRuntimeUpdateMode = 'client' | 'all' | 'durable-only'
export type SavedManagedConversation = {
  soulId: string
  expectedIntentRevision: number
  sessionRef: { provider: string; sessionId: string }
  mode: string
  cwd: string
}
export type ReopenResult = {
  sessionRef: SavedManagedConversation['sessionRef']
  ok: boolean
  errorCode?: string
}
export type ManagedRuntimeUpdateDependencies = {
  requestApproval: () => Promise<string | undefined>
  typecheckClient: () => Promise<void>
  buildClient: () => Promise<void>
  stageClient: () => Promise<void>
  prepareRustRuntime: () => Promise<void>
  buildManagedRuntime: () => Promise<void>
  snapshotManagedCodingSessions: () => Promise<SavedManagedConversation[]>
  capturePriorDeployment: (mode: Exclude<ManagedRuntimeUpdateMode, 'client'>) => Promise<void>
  stopManagedCodingSessions: (saved: SavedManagedConversation[]) => Promise<void>
  stopSupervisor: () => Promise<void>
  installManagedRuntime: (mode: Exclude<ManagedRuntimeUpdateMode, 'client'>) => Promise<void>
  restorePriorDeployment: (mode: Exclude<ManagedRuntimeUpdateMode, 'client'>) => Promise<void>
  stopServicesForRecovery: () => Promise<void>
  startSupervisor: () => Promise<void>
  waitForControlSocket: () => Promise<void>
  startRustServer: () => Promise<void>
  waitForReadiness: () => Promise<void>
  reopenSavedConversations: (saved: SavedManagedConversation[]) => Promise<ReopenResult[]>
  write: (line: string) => void
  log: (record: { severity: 'info' | 'warn' | 'error'; event: string; mode?: string; phase?: string }) => void
}
export async function runManagedRuntimeUpdate(
  _args: readonly string[],
  _dependencies: ManagedRuntimeUpdateDependencies,
): Promise<number> {
  return 2
}
~~~

Add two provider-free tests under the existing managed fresh-agent deterministic fixture suite in test/e2e-browser/specs/runtime-fresh-agent-fixture-rust.spec.ts:

1. Start a fixture Codex conversation and record supervisor PID/container, soul/incarnation/container/native-session identity, and a unique history marker. Run default update through the shared mode orchestrator with only the client-build action stubbed, perform rig.restartWeb(), then verify supervisor and managed identities and the history marker remain unchanged and a follow-up turn completes.
2. Start and complete a fixture conversation, record its saved sessionRef and history marker, then run --all with exact approval through the same orchestrator using the fixture's owned Stop and restart operations. Observe a real freshAgent.create carrying the original sessionRef, a new incarnation with the same native session ID, readable history, and a successful follow-up turn. The test must use the automatic pane-reopen path only if Stage 2 confirms it; otherwise use the smallest validated API/client seam. No test may call production systemd or manipulate the live service.

Use this assertion at the real recovery boundary:

~~~typescript
expect(sent.filter(frame => frame.type === 'freshAgent.create' &&
  frame.sessionRef?.provider === saved.provider &&
  frame.sessionRef?.sessionId === saved.sessionId)).not.toHaveLength(0)
expect(after.incarnationId).not.toBe(before.incarnationId)
expect(after.nativeSessionId).toBe(saved.sessionId)
expect((await fixtureState(rig, after)).completionCount).toBeGreaterThan(beforeState.completionCount)
~~~

- [ ] **Step 2: Run the focused tests and verify the intended failure**

Run: pnpm run test:vitest run test/unit/tooling/managed-runtime-update.test.ts --config config/vitest/vitest.config.ts

Expected: FAIL because the temporary no-effect export returns status 2 and records no client actions. The Vitest config and imports must load.

Run: pnpm run test:runtime:fresh-agent-fixtures

Expected: FAIL at the new mode assertion because the no-effect updater refuses the default update or does not run the approved reset/reopen sequence. Existing fixture tests must execute; a skipped new test is not a red result.

- [ ] **Step 3: Add the minimal production implementation and operator guidance**

Implement parseManagedUpdateMode so only no arguments, exactly --all, or exactly --durable-only are accepted; reject all other combinations before calling dependencies.

Keep importing scripts/update-managed-runtime.ts inert for unit and fixture tests: add an `isDirectInvocation()` guard around the CLI entrypoint, parse `process.argv.slice(2)` only inside that entrypoint, and assign the returned status to `process.exitCode`.

Implement runManagedRuntimeUpdate with this action order. All stages that can fail without service interruption complete before the managed sessions or units are stopped:

~~~typescript
if (mode === 'client') {
  await dependencies.typecheckClient()
  await dependencies.buildClient()
  dependencies.write('The supervisor and managed sessions were not restarted or reset.')
  dependencies.write('Use --all or --durable-only to reset managed coding sessions; type APPROVED exactly when prompted.')
  dependencies.log({ severity: 'info', event: 'managed_update.completed', mode })
  return 0
}

if (await dependencies.requestApproval() !== 'APPROVED') {
  dependencies.log({ severity: 'warn', event: 'managed_update.approval_refused', mode })
  dependencies.write('No update actions were run; approval must be exactly APPROVED.')
  return 2
}

if (mode === 'all') {
  await dependencies.typecheckClient()
  await dependencies.stageClient()
}
await dependencies.prepareRustRuntime()
await dependencies.buildManagedRuntime()
const saved = await dependencies.snapshotManagedCodingSessions()
await dependencies.capturePriorDeployment(mode)
await dependencies.stopManagedCodingSessions(saved)
let phase = 'stop-supervisor'
try {
  await dependencies.stopSupervisor()
  phase = 'install'
  await dependencies.installManagedRuntime(mode)
  phase = 'start-supervisor'
  await dependencies.startSupervisor()
  phase = 'wait-for-control-socket'
  await dependencies.waitForControlSocket()
  phase = 'start-rust-server'
  await dependencies.startRustServer()
  phase = 'wait-for-readiness'
  await dependencies.waitForReadiness()
} catch {
  let recoveryPhase = 'stop-services'
  try {
    await dependencies.stopServicesForRecovery()
    recoveryPhase = 'restore-prior-deployment'
    await dependencies.restorePriorDeployment(mode)
    recoveryPhase = 'start-supervisor'
    await dependencies.startSupervisor()
    recoveryPhase = 'wait-for-control-socket'
    await dependencies.waitForControlSocket()
    recoveryPhase = 'start-rust-server'
    await dependencies.startRustServer()
    recoveryPhase = 'wait-for-readiness'
    await dependencies.waitForReadiness()
  } catch {
    dependencies.log({ severity: 'error', event: 'managed_update.recovery_failed', mode, phase: recoveryPhase })
    dependencies.write(`Update failed during ${phase}; recovery failed during ${recoveryPhase}. Keep RUN_DIR and inspect freshell-supervisor.service and freshell-rust.service.`)
    return 1
  }
  dependencies.log({ severity: 'error', event: 'managed_update.recovered_previous_runtime', mode, phase })
  const recoveryReopens = await dependencies.reopenSavedConversations(saved)
  reportRecoveryAndReopenResults(phase, recoveryReopens, dependencies)
  return 1
}
const reopenResults = await dependencies.reopenSavedConversations(saved)
return reportUpdateAndReopenResults(mode, reopenResults, dependencies)
~~~

The production adapters for `prepareRustRuntime`, `buildManagedRuntime`, `capturePriorDeployment`, and `stageClient` must complete before either stop call. `prepareRustRuntime` runs `pnpm run --silent prepare:rust-runtime`; it prepares the local prerequisite tree and auth bootstrap and must not be deferred to a post-stop restart hook. `capturePriorDeployment` copies the currently installed selected binaries and, for `--all`, `dist/client`, into `RUN_DIR`, and records the previous `FRESHELL_RUNTIME_IMAGE` value. Keep the prior image available by digest; do not prune it. Install selected files by copying them to temporary siblings in each destination filesystem and renaming into place. Update only the image-reference line with an atomic environment-file write. Wrap each build, install, service, and readiness action in `runLoggedPhase(mode, phase, action)`; emit JSONL `managed_update.phase_started`, `.phase_completed`, and `.phase_failed` records with severity, mode, and phase, and omit raw exception text or secret/session values. `reportUpdateAndReopenResults` emits per-reference reopen result events and a final `managed_update.completed` record, including when the runtime is ready but one or more reopens failed; report counts and return 1 for partial reopen failure.

The recovery branch is deliberately narrow: after a failure in installation, supervisor stop/start, control-socket wait, Rust server startup, or readiness, stop both systemd units, restore the prior selected binaries/client and prior image-reference value from `RUN_DIR`, then start the supervisor, wait for its socket, start the Rust server, and wait for readiness. Preserve managed registry and provider/history stores throughout. If recovery itself fails, retain `RUN_DIR`, emit a separate structured recovery-failure record, print the exact failed phase and unit names, and return 1; do not delete runtime state or claim service recovery. Reopen saved conversations after successful recovery when possible and report that the update failed and recovery reopened or could not reopen them. A failed conversation reopen after a successful new-runtime readiness check does not roll back the deployment: continue all reopen attempts and return 1 with manual reopen guidance.

Read approval from one raw line on stdin with node:readline/promises; do not trim, normalize, or accept it from a compatibility-analysis result. The prompt must say that the selected mode stops managed coding sessions and requires exactly APPROVED. The production adapters must perform these effects:

- Default: pnpm run typecheck:client, then pnpm run build:client. No API request, Docker/Cargo build, install, systemd command, session stop, or history write.
- --all: typecheck the client, stage the Vite output with `pnpm exec vite build --config config/vite/vite.config.ts --outDir "$RUN_DIR/client" --emptyOutDir`, build the managed server/supervisor/session-host into `"$RUN_DIR/cargo-target"` with `CARGO_TARGET_DIR="$RUN_DIR/cargo-target" cargo build --release -p freshell-server -p freshell-supervisor -p freshell-session-host --locked --features freshell-server/managed-runtime-v1`, build the workload image with `docker build --pull=false --provenance=false --sbom=false -f docker/runtime/Dockerfile -t "$UPDATE_TAG" .`, and resolve its local immutable image ID with `docker image inspect --format '{{.Id}}' "$UPDATE_TAG"`. Run all of these and `pnpm run --silent prepare:rust-runtime` before stopping sessions or services.
- --durable-only: build and stage the same three binaries and workload image, and run `pnpm run --silent prepare:rust-runtime` before stopping sessions or services. Do not run client typecheck/build and do not replace `dist/client`.
- For both reset modes, after staging, capture the old selected binaries/client and previous `FRESHELL_RUNTIME_IMAGE` value in `RUN_DIR`. Read the managed inventory and each saved history reference, stop only active coding souls with their current expectedIntentRevision and a new `crypto.randomUUID()` requestId per stop request, then run `systemctl --user stop freshell-supervisor.service` (the Requires= dependency also stops the Rust server). Install staged binaries by copying to temporary siblings in each destination filesystem and renaming them into place. For `--all`, stage `dist/client` beside its destination, rename the old directory to a RUN_DIR backup, then rename the staged directory into `dist/client`. Update only the `FRESHELL_RUNTIME_IMAGE` line in `~/.config/freshell/managed-runtime.env` with an atomic write that retains other entries. Do not delete the registry or provider/session stores.
- Restart through the installed systemd owner: `systemctl --user start freshell-supervisor.service`; wait for the effective `--control-socket` from `systemctl --user cat freshell-supervisor.service`; `systemctl --user start freshell-rust.service`; then wait for authenticated `GET /api/runtime/readiness`. Never use scripts/launch-rust.sh to control a systemd-owned port.
- If installation or supervisor/server startup/readiness fails, stop both systemd units, restore the previous selected binaries/client and image-reference value from `RUN_DIR`, start `freshell-supervisor.service`, wait for its control socket, start `freshell-rust.service`, and wait for readiness. Preserve registry/provider/history stores. Emit a structured recovery result with the failed update/recovery phases. On successful recovery, attempt to reopen the saved conversations against the restored service and return 1 while explaining the update failed. If recovery fails, return 1, retain `RUN_DIR`, print the failed phases and unit names, and state that service recovery did not complete.
- Attempt to reopen each saved sessionRef using the Stage 2 validated flow. Continue after one failed reopen, keep history accessible, log the failure without conversation contents, print success/failure counts, and return status 1 if any reopen failed while stating the runtime update completed and manual reopening remains available.
- Create RUN_DIR with fs.promises.mkdtemp(path.join(os.tmpdir(), 'freshell-managed-update-')) and a unique UPDATE_TAG from crypto.randomUUID(). Remove the staging directory after a successful readiness/reopen pass. Retain it on an error after installation begins for inspection and recovery.

Add package.json script:
~~~json
"update:managed-runtime": "tsx scripts/update-managed-runtime.ts"
~~~

The documented operator commands are `pnpm run update:managed-runtime` (client build only; exit 0 and print that the supervisor and managed sessions were not restarted/reset, with reset modes requiring exact approval), `pnpm run update:managed-runtime --all` (prompt for one exact `APPROVED` line, then update client and durable runtime), and `pnpm run update:managed-runtime --durable-only` (same approval and durable restart, with no client build or client-directory replacement). Unknown or combined flags and refused approval exit 2 without command, API, file, or service effects. Successful update plus successful reopen exits 0; update/recovery failure or any failed reopen exits 1 with a count and manual recovery/reopen guidance.

Update AGENTS.md, scripts/launch-rust.sh comments/status, and both operator runbooks to describe the three update modes, the managed session reset/reopen behavior, and systemd restart coupling. Remove the blanket APPROVED wording for ordinary web/client restarts without adding a new client approval rule. Preserve the launcher PID/systemd owner guards and the existing rollout backup steps. Do not change README.md; this is operator guidance.

- [ ] **Step 4: Run the focused tests**

Run: pnpm run test:vitest run test/unit/tooling/managed-runtime-update.test.ts --config config/vitest/vitest.config.ts && pnpm run test:runtime:fresh-agent-fixtures

Expected: PASS; exact approval blocks all effects for reset modes, default touches only the client and reminds the operator, --all includes client plus durable work, --durable-only preserves the client hash, both reset modes perform reset/reopen, and the fixture proves identity/history continuity.

- [ ] **Step 5: Refactor while green**

Keep argument parsing, action ordering, real process/API adapters, and output rendering in separate named functions in scripts/update-managed-runtime.ts. Share the durable build/install implementation between --all and --durable-only. Keep exact approval before every side effect and ensure every reopen result is attempted and logged.

Run: pnpm run test:vitest run test/unit/tooling/managed-runtime-update.test.ts --config config/vitest/vitest.config.ts && pnpm run test:runtime:fresh-agent-fixtures

Expected: PASS.

- [ ] **Step 6: Run impacted-test verification**

Run: pnpm run typecheck:runtime && scripts/launch-rust.sh --help >/dev/null && pnpm run test:vitest run test/unit/tooling/managed-runtime-update.test.ts --config config/vitest/vitest.config.ts && pnpm run test:runtime:fresh-agent-fixtures && pnpm run test:e2e:local --project=chromium test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts

Expected: PASS; the updater typechecks, the launcher still parses, the new action and runtime behavior pass, and ordinary server continuity remains covered with an explicitly local fixture lane. Review git diff --check and manually reconcile approval wording across the four instruction surfaces; do not add a static text test.

- [ ] **Step 7: Commit the task**

~~~bash
git add scripts/update-managed-runtime.ts package.json test/unit/tooling/managed-runtime-update.test.ts test/e2e-browser/specs/runtime-fresh-agent-fixture-rust.spec.ts AGENTS.md scripts/launch-rust.sh docs/development/self-hosted-launch-runbook.md docs/development/managed-runtime-rollout.md
git commit -m "feat: add managed runtime update modes"
~~~

## Plan self-review

- The complete dispatcher-authored User Request block appears unchanged exactly once above.
- Task 1 fixes the baseline compilation failure before the mode work and preserves the Codex approval policy.
- Task 2 maps default, --all, and --durable-only to distinct observed actions; both reset modes require one exact approval line before any effect and never consult compatibility analysis.
- All client/durable builds and `prepare:rust-runtime` precede session and service stops; install/restart failures restore prior artifacts and attempt the prior service pair. The unit tests cover these orders and failure outcomes.
- The unit tests cover gate refusal, client inclusion/exclusion, saved history behavior, failure recovery, structured redacted logs, and failed reopen reporting. The fixture test checks real supervisor/session identities, native session references, history, and a follow-up turn.
- Stage 2 owns the two unresolved source-level assumptions; neither is silently treated as verified in this plan.
- Every changed file has one responsibility and appears in Task 1 or Task 2. Commands use repo-supported Cargo, pnpm, launcher, and explicit local Playwright lanes.
- No schema migration, credential qualification campaign, production rollout, backup certification, or unrelated feature is added.

---
