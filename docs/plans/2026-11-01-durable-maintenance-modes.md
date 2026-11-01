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

Operators can update the web/API server and served client without restarting the durable supervisor or resetting managed coding sessions, update the web/client and durable runtime together, or update the durable runtime alone. Every mode runs in a discoverable transient systemd user service under one per-user exclusive update lock, so the work and its durable logs survive caller loss and concurrent update modes cannot overlap. The two reset-capable modes require an exact APPROVED line, preserve conversation history, reset only coding-provider souls whose authoritative `desired_state` is `running`, and attempt reopening saved conversations on the updated runtime. Souls already marked stopped are never stopped again or reopened; an unverified prior Stop blocks replacement and is reported without retrying or polling it.

## Architecture

Add `pnpm run update:managed-runtime` with default web/client maintenance and explicit `--all` and `--durable-only` modes. Every valid mode runs in a discoverable transient systemd user service, under one per-user `flock` held for the worker's full lifetime. The bootstrap and worker use absolute paths and a minimal allowlisted toolchain environment. Resolve tsx's JavaScript entrypoint through Node package resolution and invoke it with the pinned absolute Node executable; never pass `node_modules/.bin/tsx` to Node. The wrapper prints the unit name, `systemctl --user status` and `journalctl --user -u` commands, durable JSONL path, and mode reminder before handoff. Worker output goes only to the journal and JSONL. Reset modes require one exact `APPROVED` line in a one-use owner-only file, revalidated and deleted by the worker before owner/effect work; default mode neither prompts nor creates that file.

Resolve the supported systemd user-unit owner and artifact/resource manifest before staging. Before any web stop, start, or restart, inspect effective loaded properties and transitive relationships from both selected units, including forward activation and reverse stop/restart propagation. Account for `Requires=`, `Wants=`, `Requisite=`, `PartOf=`, `BindsTo=`, `Upholds=`, `PropagatesStopTo=`, and effective inverse relationships such as `ConsistsOf=`, `BoundBy=`, and `UpheldBy=`. Refuse before web actions if any effective relationship could start, restart, or stop the durable supervisor as a consequence of a web action. The installed web drop-in uses ordering-only `After=`; the updater explicitly starts services when a reset mode needs them.

Default mode builds and stages a `managed-runtime-v1` web server plus the served client, installs them, restarts only `freshell-rust.service`, and waits for readiness. It does not access supervisor control or call supervisor service actions. It prints before handoff that supervisor and managed sessions were not restarted and that reset-capable modes require exact `APPROVED`. The durable completion JSONL event carries the same reminder so it survives caller loss.

Both reset modes build and stage selected artifacts and compare the candidate's compiled schema version with the installed read-only `installation.schema_version` before stopping any service. The side-effect-free candidate command prints compiled `SCHEMA_VERSION` without opening a registry. Schema mismatch refuses before stopping the web/API unit and points to the existing verified-backup/upgrade procedure. Reopen remains migration-free and reuses schema 19's `commands` journal for successful incarnation idempotency: the request ID/digest, incarnation association, automatic-primary-view restoration, and stopped-to-running CAS commit atomically. Exact replay is checked before the advanced revision. Pending revocation commits no new command, incarnation, view restoration, or revision; retry uses a fresh ID. The journal does not promise exact durable replay for every failure or unavailable result.

After schema preflight, reset modes stop the web/API unit to close UI create/retry ingress and take one final Inventory snapshot over the selected supervisor's exact control socket. For each soul, resolve the exact incarnation Stop would address (active incarnation first, otherwise latest); use only that incarnation's cleanup state when deciding whether a previously stopped soul is `VerifiedEmpty`, and ignore unrelated historical rows. A stopped soul is never stopped again or reopened. If its selected incarnation is not already verified empty, abort before new Stops. Then select coding-provider souls whose authoritative `desired_state=running`, including provisioning/pre-native/recovering souls regardless of launch state. Send one revision-fenced Stop at a time; after the first result other than `VerifiedEmpty`, stop sending requests, report the attempted prefix and verified-empty stopped set, and do not replace the supervisor. If any abort occurs after the web unit stops but before supervisor shutdown, restore the web unit when the selected supervisor is healthy, including Inventory/socket errors, a prior-stopped refusal, and the first Stop failure.

The final Inventory is also the updater's authoritative saved-conversation-reference source. Join its per-incarnation `RuntimeView` rows to reset targets by `soul_id`; resolve the provider and native identity from the same active-or-latest incarnation selection that Stop addresses. For fresh-agent conversations use that row's `fresh_agent_session_id`; for managed terminal conversations use its provider plus soul-level `native_session_id`, retaining `terminal_resume_session_id` only as launch/resume context. Do not use browser local storage, session-directory scans, or the fresh-agent history endpoint for terminal souls. Keep reset targets separate from eligible saved-reference candidates. A target without a saved conversation context is reported as having no eligible saved reference; a target with a resumable saved context but missing required native identity is reported `unavailable` without Reopen dispatch. Intersect candidates only with successfully stopped targets. After installing selected artifacts, start the supervisor, wait for its exact control socket, start the web/API unit, and wait for readiness plus callback-socket availability before Reopen. Preserve history and never fabricate a soul, identity, or store.

For `--durable-only`, do not build or replace the web binary or client. Before stopping the web unit, compare the running process executable identity (`/proc/<MainPID>/exe` device/inode and resolved executable path) with the selected on-disk binary; refuse before any web action if either identity differs or cannot be verified. The web process may then restart from that same binary while the updated supervisor/workload is installed. For `--all`, update web/client and durable artifacts together.

Do not automatically restore old binaries or image settings after the updated runtime may have opened persistent state. Build first; on later failure report the failed phase and partial state, preserve persistent data, and follow the selected owner's forward-recovery runbook. An approved update may interrupt active sessions; retained history remains and reopen is attempted, but recovery is not guaranteed.
## Tech Stack

TypeScript/NodeNext, pnpm 10.34.5, Rust/Cargo managed-runtime feature, the existing supervisor control protocol and runtime client, a supervisor admin CLI, Docker workload image, systemd user units, Vitest, Playwright, and the managed-runtime fixture harness.

## Stage 2 decisions

The Stage 2 ledger and evidence are in /home/dan/code/freshell/.worktrees/.the-usual-logs/durable-maintenance-modes/load-bearing-ledger.md and its reports directory. This section records the decisions the implementation must follow.

- F01 was falsified. Existing browser Reopen and create/resume paths cannot start a new incarnation of a stopped soul on its retained provider volume. Add the narrow supervisor admin Reopen operation described above. It is revision-fenced and reuses the existing schema-19 `commands` journal for successful incarnation idempotency; do not add a schema migration or promise exact durable replay for failures/unavailable results. Missing native IDs remain reset targets and are reported unavailable outside Reopen dispatch.
- F02 is acceptable only for the existing systemd user-unit installation. Before staging or mutation, verify the current checkout matches the selected units' working directory and executable/install paths, identify the running supervisor and socket from those units, and refuse on ambiguity. Before any web stop/start/restart, inspect the effective loaded graph from both selected units, including transitive activation and reverse stop/restart propagation through `Requires=`, `Wants=`, `Requisite=`, `PartOf=`, `BindsTo=`, `Upholds=`, `PropagatesStopTo=`, and effective inverse properties; refuse if any relationship could start, restart, or stop the supervisor and explain that the After-only unit/drop-in must be deployed and systemd reloaded before retrying. `After=` alone is ordering-only and does not activate the supervisor. Use the exact supervisor socket for Inventory, Stop, and Reopen through the supervisor admin CLI. Do not use an HTTP API for those operations or add an HTTP identity endpoint unless direct socket ownership cannot be established.
- F03 was falsified. Replace the web drop-in's Requires= with ordering-only After=; do not use Wants= or Requisite=. Web start/restart may fail when the supervisor is absent, but must not activate or restart it. The updater explicitly starts the supervisor before the web service when a reset mode needs both.
- F04 is acceptable with a bounded artifact/resource manifest tied to the verified owner: resolved served-client directory and web server binary built with managed-runtime-v1 for default and --all; no web server build for --durable-only; supervisor and admin CLI for reset modes; session-host bind mount; managed workload image; host-side sidecar only if the managed path needs one; managed-runtime image-reference environment; and persistent registry, provider/history, runtime, and workspace roots to preserve. Build from the matching deployment checkout so compile-time resource paths remain valid. Use the supervisor's explicit Docker socket. Stage renamed artifacts on the destination filesystem. Replace a non-empty client directory with a same-filesystem two-rename swap through a unique sibling path; this creates a brief client-path availability gap. If the second rename fails, leave the old directory at the reported sibling path, do not restart the web service, and report the manual recovery path. Remove the old sibling after a successful swap. Refuse unresolved owner, path, or daemon information. Do not run prepare:rust-runtime from a task worktree or let it create/mutate a missing .env; inspect whether image-contained sidecar resources make host preparation unnecessary.
- F05 was falsified for inventory followed by sequential Stops while the web API remains open. Build and stage first, stop the web/API unit, then take the final fixed inventory. Inspect desired state before launch state: desired-stopped souls are never stopped/reopened and must already be VerifiedEmpty or the updater aborts before any new Stop, without re-Stopping or polling. Select only coding-provider souls with desired_state=running, then issue revision-fenced Stops sequentially, at most one per selected soul, stopping immediately after the first non-VerifiedEmpty result. Do not send later Stops; report the attempted prefix and verified-empty stopped set. If this aborts before supervisor shutdown and the supervisor remains healthy, restart the web/API unit. The Stop request ID is a correlation ID only; expected intent revision is the actual fence and the supervisor does not deduplicate Stop by request ID. This closes UI create/retry ingress before inventory and lets Stop cancel or drain recovery. Abort durable replacement on stale intent, timeout/unknown, or any outcome other than VerifiedEmpty. Record each result and never re-inventory to overwrite newer intent. A VerifiedEmpty Stop may still have a grant revocation pending; after installing and starting the new supervisor, start the web/API unit and wait for its MCP callback socket before attempting Reopen. Reopen retries/confirms the exact old Stop/revocation and cannot advance intent or create an incarnation while it remains unresolved. Do not add a global admission service or deployment transaction journal. If source review finds another supported production ingress outside the stopped unit, choose the narrowest correction that preserves the three modes.
- Keep Reopen migration-free by reusing the current schema-19 `commands` journal for successful incarnation results. The candidate supervisor must expose a side-effect-free compiled schema-version command that never calls `Registry::open`; compare it with a read-only query of current `installation.schema_version` before stopping any service. Refuse a mismatch and direct the operator to the existing verified old-schema backup/upgrade procedure. This is a preflight safety check, not a compatibility-based approval decision; do not add backup/rollback code.
- Every mode runs in a discoverable transient user service. Print its unit name, `systemctl --user status` and `journalctl --user -u` commands, and durable JSONL path before handoff. Keep bootstrap/worker output on journal and durable log only, with no caller pipe. Use absolute executable/script/cwd paths and a minimal explicit toolchain environment; do not forward secrets. A Node bootstrap invokes `flock -n -E 75` and holds the lock through the actual worker. When busy, it records a structured JSONL event with `event=update.lock_contention`, `severity=error`, `mode`, `phase=lock`, and `error_code=update_lock_busy`, then exits with reserved status 75 before owner/build/control/service effects; on success, the actual worker runs as the child of `flock` until it finishes. The busy path removes only that invocation's owner-only approval file, if present, without reading/logging its contents. Keep this as a simple per-user file lock, not an admission service or transaction journal.
- Do not automatically restore old binaries or image settings after the updated runtime may have opened persistent state. Build first; on post-stop failure report the failed phase and partial state, preserve persistent data, and follow the selected owner's forward-recovery runbook.
- Apply the direct corrections from the finder/strategist reports: keep reset targets separate from records with reopen references; do not use the fresh-agent history endpoint for terminal souls; inspect typed Stop outcomes; select coding providers while excluding shell; restrict the terminal continuity command to the provider-free shell case at runtime-terminal-continuity-rust.spec.ts:116; make the fixture observe the changed runtime marker, retained history, new incarnation, and follow-up use; stage renames on the destination filesystem; and do not claim that the provider-free fixture proves installed systemd wiring.


### Final implementation clarifications

- On a reset-mode abort after `freshell-rust.service` has stopped but before `freshell-supervisor.service` has stopped, restore the web unit if the selected supervisor remains healthy. This includes Inventory/socket failure, refusal because a desired-stopped soul is not empty, and the first non-`VerifiedEmpty` Stop result. Report restoration failure with the original cause and current unit state.
- A Stop batch ends on its first non-`VerifiedEmpty` outcome. Do not Stop later targets. Report the attempted prefix, each outcome in that prefix, and the verified-empty stopped set.
- Desired-stopped `VerifiedEmpty` uses only the incarnation Stop would address: active first, otherwise latest. Historical incarnation rows do not block an update. If no incarnation is addressable, require an explicit no-runtime empty result; otherwise refuse as unresolved.
- The Reopen stopped-to-running transaction also restores the hidden automatic primary view. A fixture assertion verifies the view is visible immediately after the atomic transition.
- Saved conversation references come from the final supervisor Inventory, joined to targets by `soul_id` and taken from the active-or-latest incarnation Stop would address. The provider-native identity is authoritative. Record no-reference, ineligible-reference, and missing-required-identity outcomes explicitly; a resumable reference with missing native identity is `unavailable` and returns failure. Never use browser-local state, a session-directory scan, or the fresh-agent history endpoint for terminal references.
- The frozen legacy callback peer covers the unchanged real actions and payloads required by the exercised paths: `issue`, `activate`, `commit`, `abort`, and `revoke`, not only `issue` and `activate`.
- The `--durable-only` worker proves that the running web executable and selected on-disk executable are the same file before restart. Effective systemd graph checks cover activation and reverse stop/restart propagation, including `PartOf=`, `BindsTo=`, `Upholds=`, `PropagatesStopTo=`, and effective inverse properties.
- Default mode writes the supervisor/session reminder into its durable completion JSONL event as well as printing it before handoff. The updater's internal Node command names the resolved tsx JavaScript entrypoint and invokes that file with the pinned Node binary.
- Run exact, named red and green selectors for the schema-version test, Reopen journal test, frozen-v2 CLI peer test, legacy callback peer test, and each newly added fixture case. A broad selector that can pass without executing the named new case is not acceptable.

## Global Constraints

- Keep all work in `/home/dan/code/freshell/.worktrees/durable-maintenance-modes` on `the-usual/durable-maintenance-modes`. Do not run production commands or alter a live service.
- Tests use disposable managed-runtime fixtures and stub process, Docker, and systemd adapters. No test may use the self-hosted installation or live systemd user-unit manager.
- Parse mode before prompting or doing work. Unknown or combined flags exit 2 with no effects. Default does not prompt or create an approval file. `--all` and `--durable-only` read one raw line and require exactly `APPROVED` before creating a one-use mode-0600 file or submitting a worker. The worker revalidates the line, deletes the file, and only then begins owner/effect work. Never put the approval line in arguments, environment, logs, or journal output. Do not consult compatibility analysis.
- Every valid mode runs in a uniquely named transient systemd user service, `freshell-update-managed-runtime-<UTC timestamp>-<random suffix>.service`, with `systemd-run --user --unit=<unit> --working-directory=<absolute checkout> --wait` and without `--pipe` or `--collect`. Print the unit name, `systemctl --user status <unit>`, `journalctl --user -u <unit>`, durable JSONL path `<resolved home>/.freshell/logs/managed-runtime-update-<same id>.jsonl`, and required mode reminder before handoff. A Node bootstrap invokes `/absolute/flock -n -E 75 $XDG_RUNTIME_DIR/freshell-update-managed-runtime.lock`; status 75 is reserved for contention and must be logged before owner/build/control/service effects as `event=update.lock_contention`, `severity=error`, `mode`, `phase=lock`, `error_code=update_lock_busy`. On contention remove only that invocation's approval file without reading it. On success, flock holds the actual worker until completion and returns the worker's 0/1/2 status. The worker receives only the derived `FRESHELL_UPDATE_LOG_PATH` in its allowlisted environment. Worker output goes to the unit journal and durable JSONL only, so caller loss does not end the work.
- Use absolute Node, resolved tsx JavaScript entrypoint, updater script, checkout, pnpm, Cargo, Docker, and flock paths with a minimal explicit allowlisted environment. Invoke the tsx JavaScript file with `/absolute/node /absolute/tsx-entry.js`; never invoke `node_modules/.bin/tsx` as JavaScript. The initial `env -i` includes only `HOME`, `XDG_RUNTIME_DIR`, resolved toolchain `PATH`, `PNPM_HOME`, `CARGO_HOME`, `RUSTUP_HOME`, and isolated `CARGO_TARGET_DIR` when needed; the bootstrap adds only `FRESHELL_UPDATE_LOG_PATH` for the worker. Do not forward arbitrary caller variables or secrets. Docker always names the verified socket explicitly with `--host`.
- After approval where required and before building or changing state, verify that the current checkout, selected web/supervisor units, executable paths, exact control socket, client directory, image daemon, environment file, and persistent roots have one unambiguous owner. Refuse on mismatch or ambiguity. Before every web stop/start/restart, inspect effective loaded systemd properties from both selected units and their transitive/inverse relationships. Include activation and reverse stop/restart propagation: `Requires=`, `Wants=`, `Requisite=`, `PartOf=`, `BindsTo=`, `Upholds=`, `PropagatesStopTo=`, and the effective inverse properties (`ConsistsOf=`, `BoundBy=`, `UpheldBy=`, and any reported inverse of stop propagation). Refuse before web action if any relationship could start, restart, or stop the supervisor. Explain that the ordering-only unit change must be deployed and systemd reloaded. The checked-in web drop-in uses only ordering-only `After=` for the supervisor; `After=` alone does not activate either unit.
- Default builds/stages the `managed-runtime-v1` web server and client, then restarts only `freshell-rust.service`. It makes no supervisor control or service call and does not reset sessions. Print the reminder before handoff and include it in the durable completion JSONL event. Ordinary web/client maintenance and web/API restarts have no APPROVED rule.
- `--all` stages managed-runtime-v1 web/client and durable artifacts. `--durable-only` stages durable artifacts and does not build or replace the web binary or client. Before it stops the web unit, compare the live executable identity with the selected on-disk web executable; refuse if the device/inode or resolved path differs or is unverifiable. It may restart the web process from that same binary after the supervisor/workload update.
- For reset modes, stage all selected artifacts and compare the candidate's side-effect-free compiled schema version with the current `installation.schema_version` queried through read-only SQLite before stopping any service. Reuse schema 19's `commands` table for successful Reopen idempotency; do not add a migration, backup mechanism, or failure receipt table. On mismatch, refuse before web stop and point to the existing verified-backup/upgrade procedure.
- Take one final Inventory only after stopping web/API ingress. Deduplicate by soul while preserving its authoritative desired state. For cleanup checks and Reopen reference selection, resolve the same incarnation Stop addresses (active first, otherwise latest); historical rows do not block forever. A desired-stopped soul is never stopped or reopened. If its addressed incarnation is not `VerifiedEmpty`, refuse before new Stops and do not retry or poll it. If no incarnation is addressable, require an explicit no-runtime empty result or refuse as unresolved.
- Select reset targets only from coding-provider souls with `desired_state=running`, excluding shell and including provisioning/pre-native/recovering souls regardless of launch state. Send one revision-fenced Stop at a time and stop issuing requests after the first result other than `VerifiedEmpty`. Report the attempted prefix and verified-empty stopped set. The request ID is only a correlation ID; the captured intent revision is the fence. Do not re-inventory or retry against a newer revision. Every reset-mode abort after web stop and before supervisor stop restores the web unit if the selected supervisor is healthy, including Inventory/socket errors, prior-stopped refusal, and first Stop failure.
- The final supervisor Inventory is the authoritative saved-conversation-reference source. Join RuntimeView rows to targets by `soul_id` and use the addressed active-or-latest row: `fresh_agent_session_id` identifies a saved fresh-agent conversation, while provider plus `native_session_id` identifies a managed terminal conversation; `terminal_resume_session_id` remains launch/resume context. Keep reset targets separate from eligible conversation references. Record no-reference and ineligible-reference counts. A saved resumable context missing its required native identity is `unavailable`, has no Reopen dispatch, and makes the update fail. Intersect eligible references only with successfully stopped targets. Do not use browser local storage, session-directory scans, or the fresh-agent history endpoint for terminal souls.
- Start the updated supervisor before the web/API unit, wait for its exact control socket and then wait for web readiness and the web-owned callback socket before Reopen. Reopen uses saved launch/resume context and provider store, preserves history, retries/confirms the exact prior Stop/revoke, and returns pending without changing revision or creating an incarnation while revocation remains unresolved. Reopen success atomically records the command, incarnation association, stopped-to-running CAS, and restored automatic primary view. Exact successful replay is checked before advanced revision. Attempt every eligible Reopen and report every result. Any unavailable, pending, or failed result returns 1 and reports manual recovery. Return 0 for no reset targets or no eligible saved conversations only when Inventory shows none are waiting on a missing required identity.
- Exit 2 for unknown/combined flags, missing or inexact reset approval, and pre-effect owner/graph/schema refusal. Exit 1 for update, partial-state, or Reopen failure. Exit 0 only after the requested update succeeds and all eligible saved conversations reopen, or when no reset targets/conversations exist and none are waiting on missing required identity.
- Build web server and client for default/`--all` with `managed-runtime-v1`, reusing `cargo build --release -p freshell-server --features managed-runtime-v1 --locked` from the existing managed-server recipe. Build supervisor, admin CLI, session-host, and managed workload image for reset modes. The owner-derived resource manifest covers the served-client directory; selected server/supervisor/admin CLI; session-host bind path; workload image and image-reference environment; any needed host-side sidecar; and persistent registry, provider/history, runtime, and workspace roots. Build from the matching deployment checkout, stage artifacts on destination filesystems, and replace a non-empty client directory using a same-filesystem two-rename swap through a unique sibling. If the second rename fails, retain and report the old sibling and do not restart web. Do not run `prepare:rust-runtime` from a task worktree or create/mutate a missing `.env`; inspect whether image-contained sidecar resources make host preparation unnecessary.
- Do not restore older binaries/image settings after the updated runtime may have opened persistent state. Build before stopping; for later failures report the phase and partial state, preserve registry/provider/history/workspace data, and follow the selected owner's forward-recovery runbook. JSONL records have severity, mode, and phase where applicable; omit approval text, auth/provider secrets, secret-bearing launch data, and conversation bodies.
- Operator guidance says to run the updater from a host shell, not a Freshell-managed container pane: managed panes run inside soul containers and do not own the host systemd user manager or deployment checkout. Do not modify README.md. Do not add prose/config snapshot tests. The provider-free fixture does not certify installed systemd wiring; test effective unit behavior through stubs.

## File ownership

- Task 1 owns only `crates/freshell-server/src/managed_provider_bootstrap.rs`.
- Task 2 owns the supervisor control protocol and Reopen implementation: `crates/freshell-runtime-protocol/src/lib.rs`, `crates/freshell-supervisor/src/main.rs`, `registry.rs`, `service.rs`, and the supervisor's unit tests. It also owns the runtime-client control operations and admin CLI: `crates/freshell-runtime-client/src/lib.rs`, `src/bin/freshell-supervisor-admin.rs`, and `tests/supervisor_admin_legacy_peer.rs`.
- Task 3 owns updater orchestration: `scripts/update-managed-runtime.ts`, the `package.json` script entry, and `test/unit/tooling/managed-runtime-update.test.ts`.
- Task 4 owns fixture, systemd, operator guidance, and policy surfaces: `scripts/testing/runtime-sandbox.ts`, `test/e2e-browser/specs/runtime-fresh-agent-fixture-rust.spec.ts`, `installers/systemd/freshell-rust.service.d/managed-runtime.conf`, `AGENTS.md`, `scripts/launch-rust.sh`, `scripts/prebuild-guard.ts`, `test/unit/tooling/prebuild-guard.test.ts`, both extension-installer skill copies, and the two managed-runtime operator runbooks.

Each task is implemented and reviewed before the next starts. The review scope is its owned files and the exact behavioral selectors listed in that task. Keep commits limited to that task's owned files; the compile repair is a prerequisite commit.

### Task 1: Repair Managed Provider Qualification Compilation

**Files:**
- Modify: crates/freshell-server/src/managed_provider_bootstrap.rs:92-133,364-385,654-676
- Modify: crates/freshell-server/src/managed_runtime_opencode_replan_tests.rs:188 (add the missing `native_identity` field to an existing test fixture so the focused feature-gated test target compiles).

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

Expected: The first compile may also reveal an existing E0063 in `managed_runtime_opencode_replan_tests.rs` because a `HostResult::FreshAgentCommand` test fixture omits `native_identity`. Add `native_identity: None` to that fixture, then rerun the focused command while the two production defects remain; it must fail on the intended E0425 (`mcp_enabled`) and E0027 (`approval_default`) errors rather than stopping at unrelated test-fixture compilation.

- [ ] **Step 3: Add the minimal production implementation**

Initialize source-less Codex preparation with empty MCP argument vectors; the optional capability branch later fills them through with_managed_mcp_reference. Ignore the policy field in the mutable match so its existing value remains intact. The `native_identity: None` fixture correction is test setup only and does not change behavior:

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
git add crates/freshell-server/src/managed_provider_bootstrap.rs crates/freshell-server/src/managed_runtime_opencode_replan_tests.rs
git commit -m "fix: restore managed provider qualification compilation"
~~~

### Task 2: Implement Supervisor Reopen, Schema Reporting, and Admin CLI

**Files:**
- Modify: `crates/freshell-runtime-protocol/src/lib.rs`.
- Modify: `crates/freshell-supervisor/src/main.rs`, `registry.rs`, `service.rs`, `recovery.rs`, and `backend.rs`.
- Modify: `crates/freshell-runtime-client/src/lib.rs`.
- Create: `crates/freshell-runtime-client/src/bin/freshell-supervisor-admin.rs`.
- Create: `crates/freshell-runtime-client/tests/supervisor_admin_legacy_peer.rs`.
- Add focused unit tests in the owned supervisor modules.

**Interfaces:**
- Consumes the current protocol-v2 Health/Inventory/Stop contract, a typed Reopen command with request ID, soul ID, and expected stopped intent revision, the persisted soul launch/resume context, provider store, native identity, and the existing web-owned MCP capability callback.
- Produces typed `reopened`/`pending`/`failed` Reopen results; a side-effect-free `schema-version` command; and an admin CLI for exact-socket Health, Inventory, revision-fenced Stop, and Reopen. Missing-native `unavailable` is generated by the updater, never sent to the supervisor.
- Keeps `CONTROL_PROTOCOL_VERSION` at 2 and preserves all existing Health/Inventory/Stop wire fields. Reopen is additive and used only against the updated supervisor.

- [ ] **Step 1: Add executable failing behavior tests**

Write exact tests for: side-effect-free compiled schema reporting without registry creation/open; successful Reopen journal replay before revision validation; conflicting digest and stale revision refusal; pending revocation with no revision, command association, or incarnation change; new incarnation on the same soul/provider store/native identity and changed runtime marker; retained history; atomic restoration of the hidden automatic primary view; and real legacy callback behavior.

Also add regression tests for the six findings from Task 2's independent review:

- Ordinary non-fixture provider startup waits for native identity while the exact prepared Reopen remains stopped; a newer concurrent Stop cancels startup and prevents publication.
- When an ordinary terminal has a saved native identity but no persisted `ResumeSpec` and no original resume argument, Reopen builds a provider-correct exact-resume workload for that identity; the host receives the resume and retained conversation history remains readable.
- Exact-resume Reopen completes renewed provider preparation (`revoke`, `issue`, `activate`, `commit`) before success publication. Injected commit failure does not publish success.
- Failures before container creation, after grant, and during provider commit settle the exact prepared replacement: retire never-created reservations; stop and verify created replacements before releasing authority; preserve explicit unresolved cleanup if verification fails; and permit retry after verified cleanup.
- If a renewed capability was issued but no container was created and its revoke is pending, retry the recorded capability-only revoke without manufacturing an owned runtime handle or contacting Docker. Keep revision/incarnation unchanged and return pending until revoke settles; only then allow replacement.
- If Docker create may have succeeded but its reply or identity commit was lost, do not infer VerifiedEmpty from missing committed Docker columns. Only a proven pre-create/definitive rejection can use the no-runtime release path; otherwise retain claims/reservations and explicit unresolved cleanup, block another replacement, and report the exact recovery state. Do not add a broad orphan-container sweeper.
- A successful Reopen request replayed after a later Stop/recovery returns its original incarnation without creating or launching another one, regardless of current lifecycle state.
- The schema-version behavior test executes the actual command-dispatch path with an injected/observable registry opener (or an isolated built-binary subprocess) and proves that the command reports the compiled version without trying to open/create a registry. It must fail if registry initialization is moved before command dispatch.

The legacy callback peer reads each raw JSON request through EOF and validates frozen old request shapes with unknown fields rejected. Exercise the unchanged actions and payloads required by the paths: `issue`, `activate`, `commit`, `abort`, and `revoke`. Cover exact revoke retry after a verified-empty Stop, activation commit, failed preparation abort, and successful Reopen. It must not use current request types to define its expected wire shape.

Add a temporary frozen-v2 Unix-socket peer for the admin CLI. It accepts only the old Health, Inventory, and Stop methods and old-shaped VerifiedEmpty results, and records protocol version, Web role, method/field names, and expected revision. It rejects Reopen before supervisor replacement. Before the CLI exists, add a compile-safe stub binary that starts but returns an intentional unsupported result; the new integration test must run it and fail on the old peer's observed/missing frames, not fail because Cargo cannot find a binary target.

Use these exact red commands and confirm each executes the named new test and fails at its behavior assertion, rather than at compilation or zero tests:

~~~bash
cargo test -p freshell-supervisor --bin freshell-supervisor tests::schema_version_command_does_not_open_registry -- --exact
cargo test -p freshell-supervisor --lib service::tests::reopen_success_replay_returns_same_incarnation_before_revision_validation -- --exact
cargo test -p freshell-supervisor --lib service::tests::reopen_uses_frozen_legacy_callback_actions -- --exact
cargo test -p freshell-runtime-client --test supervisor_admin_legacy_peer admin_cli_preserves_frozen_v2_wire_contract -- --exact
cargo test -p freshell-supervisor --lib service::tests::reopen_native_readiness_only_accepts_current_prepared_attempt -- --exact
cargo test -p freshell-supervisor --lib service::tests::reopen_native_identity_without_resume_spec_builds_exact_resume_workload -- --exact
cargo test -p freshell-supervisor --lib service::tests::reopen_resume_commits_provider_preparation_before_publish -- --exact
cargo test -p freshell-supervisor --lib service::tests::reopen_failure_cleanup_retires_replacement_and_allows_retry -- --exact
cargo test -p freshell-supervisor --lib service::tests::reopen_pending_no_runtime_revoke_retries_without_docker -- --exact
cargo test -p freshell-supervisor --lib service::tests::reopen_uncertain_create_retains_authority_until_verified -- --exact
cargo test -p freshell-supervisor --lib service::tests::reopen_success_replay_survives_later_stop -- --exact
cargo test -p freshell-supervisor --bin freshell-supervisor tests::schema_version_startup_dispatch_never_opens_registry -- --exact
~~~

- [ ] **Step 2: Implement the protocol, schema command, Reopen, and CLI**

Keep Reopen revision-fenced and migration-free. The candidate `schema-version` command prints compiled `SCHEMA_VERSION` without calling `Registry::open`. On Reopen, first retry/confirm the exact prior Stop and grant revocation. Pending returns at the unchanged stopped revision without committing a successful command association, creating an incarnation, or making the automatic primary view visible. After settlement, use the existing soul's saved context, provider store, and identity to create a new incarnation with the current runtime. In one transaction, commit the stopped-to-running CAS, successful command/digest/incarnation association, and restoration of the hidden automatic primary view. Check exact successful replay before the now-advanced revision. A fresh request ID may retry a pending revoke. Do not promise exact durable replay for failures or unavailable results.

Keep the soul stopped and its automatic view hidden through preparation, grant delivery, provider-native observation, and provider-preparation commit. Carry the exact `reopen_prepared` attempt/incarnation/revision authority through native readiness checks; only that current attempt may pass the stopped-intent gate, and any newer Stop cancels it. If a stored native identity exists without a `ResumeSpec`, construct and validate the provider-specific exact-resume workload from the saved native identity, provider store, and saved launch settings before creating the replacement. Do not mistake an observation fence for provider resume arguments. Complete renewed provider preparation for resumed workloads before `finish_reopen`. On every failure after preparation, settle only the exact replacement: release unused reservation/claims if no runtime was created; stop and verify any created runtime before releasing authority; retain explicit unresolved cleanup state when verification is inconclusive. The stopped-to-running CAS, successful command/incarnation association, recovery/writer completion, and view visibility remain one final transaction. A matching successful command/digest replay returns its original incarnation before current lifecycle/revision validation, even if that incarnation later stops or is replaced; it causes no new launch or preparation.

For a pending revoke on an exact no-runtime Reopen receipt, use a revision-fenced capability-only continuation; do not invent an `OwnedRuntimeHandle`, inspect/stop Docker, or create another incarnation. Return pending while callback revoke is unresolved and allow retry at the same stopped revision. For Docker create, carry explicit outcome certainty from the backend into failure settlement. Only an error proven to occur before creation, or a definitive backend rejection guaranteeing no container acquired the mounts, may release claims as `VerifiedEmpty`. A create with uncertain outcome or a created container whose registry identity was not committed remains blocked with claims/reservations and explicit unresolved cleanup; do not infer absence from null identity columns and do not introduce a general orphan scanner.

Build the supervisor admin CLI over the runtime-client private control socket. Accept owner-selected socket and secret-file paths, never secret values; return typed machine-readable output; do not use HTTP. Keep old protocol-v2 Health/Inventory/Stop shapes byte-compatible. Additive Reopen is sent only after the updated supervisor is listening.

- [ ] **Step 3: Run exact green tests and refactor**

Run every exact command from Step 1 and confirm it passes. Real provider-stub cases must cover native observation, exact resume arguments, callback commit and commit failure, verified failure cleanup and retry, newer Stop interruption, and replay after later lifecycle changes. The schema test must exercise command dispatch, not only its output helper. The callback peer must demonstrate all five old actions and payloads. Run `cargo fmt --all --check`.

Refactor request validation, replay lookup, revocation settlement, incarnation creation, view restoration, and command association into named paths while preserving atomicity and existing protocol behavior. Review only the Task 2 files and tests.

- [ ] **Step 4: Commit the task**

~~~bash
git add crates/freshell-runtime-protocol/src/lib.rs crates/freshell-supervisor/src/main.rs crates/freshell-supervisor/src/registry.rs crates/freshell-supervisor/src/service.rs crates/freshell-supervisor/src/recovery.rs crates/freshell-supervisor/src/backend.rs crates/freshell-runtime-client/src/lib.rs crates/freshell-runtime-client/src/bin/freshell-supervisor-admin.rs crates/freshell-runtime-client/tests/supervisor_admin_legacy_peer.rs
git commit -m "feat: add managed runtime reopen control"
~~~

### Task 3: Implement Updater Orchestration and Mode Tests

**Files:**
- Create: `scripts/update-managed-runtime.ts`.
- Modify: `package.json` scripts block to add `update:managed-runtime`.
- Create: `test/unit/tooling/managed-runtime-update.test.ts`.

**Interfaces:**
- Consumes `pnpm run update:managed-runtime [--all|--durable-only]`, the selected unit pair, owner-derived artifact/resource manifest, exact reset-mode approval, and the Task 2 admin CLI.
- Produces `parseManagedUpdateMode(args): 'client' | 'all' | 'durable-only'`; `runManagedRuntimeUpdate(args, dependencies): Promise<number>`; `ManagedCodingSoulResetTarget`; typed `StopResult`; `ReopenCandidate`; and updater-level `ReopenResult` with `reopened`, `pending`, `unavailable`, or `failed`. Keep reset targets separate from saved-reference candidates. Missing-native `unavailable` is reported without Reopen dispatch.

- [ ] **Step 1: Add failing updater behavior tests**

Use injected adapters that record ordered effects and never touch the host. Cover:

- Unknown/combined modes and malformed approvals refuse before effects. Default makes no approval read/file. Reset modes require exact raw `APPROVED`, use a one-use mode-0600 file, never expose its contents in arguments/environment/logs, and validate/delete it in the worker before owner inspection.
- All modes use a discoverable transient systemd user service with absolute commands, pinned Node plus the resolved tsx JavaScript entrypoint, minimal allowlisted environment, unit/status/journal/log details before handoff, no `--pipe`, and a shared flock. A real temp-lock subprocess proves contention logs `update.lock_contention` with severity/error/mode/phase/code, removes only that invocation's approval file, exits 75, and performs no owner/build/control/service action. A process-boundary test proves completion and durable logs after the launching process exits.
- Default builds/stages `managed-runtime-v1` server/client, restarts only the web unit, waits for readiness, preserves managed attach/follow-up, makes no supervisor calls, and prints the reminder before handoff and inside the completion JSONL event.
- `--all` selects web/client and durable artifacts. `--durable-only` skips web/client build and replacement and refuses before web stop if the running `/proc/<MainPID>/exe` device/inode or resolved executable path differs from the selected on-disk binary or cannot be verified.
- Owner/path/socket/image ambiguity and schema mismatch refuse before service/session mutation. Candidate schema output is side-effect-free; current schema is read-only. Effective systemd graph stubs cover forward activation and reverse propagation from both unit directions, including `Requires`, `Wants`, `Requisite`, `PartOf`, `BindsTo`, `Upholds`, `PropagatesStopTo`, and effective inverse properties. Every relation that could start, restart, or stop the supervisor blocks a web action.
- The updater resolves the Node package's actual tsx JavaScript entrypoint and invokes `/absolute/node /absolute/tsx-entry.js ...`; tests reject `.bin/tsx` as the JS file. The public package script can still use the package manager's normal executable shim.
- Reset mode action order is exact approval, transient handoff, worker approval revalidation/deletion, owner/graph verification, builds/staging/schema preflight, web stop, one final Inventory, desired-stopped validation, one-at-a-time Stops, supervisor stop, install, supervisor start/health, web start/readiness/callback readiness, then eligible Reopen. No artifact/service replacement occurs before all Stops are VerifiedEmpty.
- Desired-stopped cleanup examines only the active incarnation Stop would address, otherwise latest; historical rows do not block forever. If no incarnation is addressable, require explicit no-runtime VerifiedEmpty or refuse unresolved. Fixture inventory includes an old non-empty historical row and a current empty addressed row, plus active-incarnation cases.
- Stop requests stop immediately after the first non-VerifiedEmpty outcome; the attempted prefix and verified-empty stopped set are reported, with no later Stop and no re-inventory. Inventory/socket errors, prior-stopped refusal, and the first Stop failure restore the web unit if the selected supervisor is still healthy. A restoration failure reports the original cause and resulting unit state.
- Saved references come only from final supervisor Inventory RuntimeView rows joined to targets by `soul_id`, using the same active-or-latest row as Stop. Use provider/native identity and provider-specific conversation identity; do not use browser storage, directory scans, or fresh-agent history for terminal souls. Report no-reference and ineligible counts. Missing required native identity on a resumable target is `unavailable`; no Reopen is dispatched. Reopen candidates intersect only with the successfully stopped target set.
- A client directory swap uses two same-filesystem renames through a unique sibling. On second-rename failure, preserve/report the old sibling and do not restart web. Post-stop failure reports phase/partial state, preserves persistent data, does not restore old binaries/image settings, and points to forward recovery. Reopen pending/failure does not stop later candidates from being attempted.

Add a no-effect updater scaffold if needed so tests load and fail on the expected action assertion. Ensure test titles are unique and use exact Vitest `-t` selectors for red and green runs. The implementation module is also typechecked through the Task 4 fixture import.

- [ ] **Step 2: Run the focused red behavior selectors**

Each command must execute its named test; a missing or skipped new case is not a red result.

~~~bash
pnpm run test:vitest run test/unit/tooling/managed-runtime-update.test.ts --config config/vitest/vitest.config.ts -t '^reset abort restores web before supervisor shutdown$'
pnpm run test:vitest run test/unit/tooling/managed-runtime-update.test.ts --config config/vitest/vitest.config.ts -t '^stop batch halts after first nonverified outcome$'
pnpm run test:vitest run test/unit/tooling/managed-runtime-update.test.ts --config config/vitest/vitest.config.ts -t '^durable-only refuses changed web executable$'
pnpm run test:vitest run test/unit/tooling/managed-runtime-update.test.ts --config config/vitest/vitest.config.ts -t '^default completion event includes reminder$'
pnpm run test:vitest run test/unit/tooling/managed-runtime-update.test.ts --config config/vitest/vitest.config.ts -t '^bootstrap invokes resolved tsx entrypoint with pinned node$'
~~~

- [ ] **Step 3: Implement mode parsing, worker dispatch, and update flow**

Parse flags before input/effects. Reset modes accept one exact line before writing an owner-only approval file; worker validates/unlinks it before owner/effect work. Generate a unique transient unit/log ID, print unit/status/journal/log paths and reminder, then call `systemd-run --user --unit=<unit> --working-directory=<absolute checkout> --wait` without `--pipe`/`--collect`. Its command uses `/usr/bin/env -i`, allowlisted assignments, pinned Node, resolved tsx JS entrypoint, absolute script, internal mode, unit name, and reset-only approval-file path. Bootstrap derives the JSONL path, invokes `flock -n -E 75`, and starts the worker as the locked child. On contention, log before effects, remove only that invocation's approval file without reading it, and exit 75. Worker/bootstrap stdout/stderr remains in journal/JSONL, not a caller pipe.

Before build or effects, resolve the supported systemd user-unit owner and bounded resource manifest. Confirm checkout, working directory, executable/install paths, live processes, exact control socket, client directory, Docker socket, environment file, and persistent roots. Inspect effective forward activation plus reverse stop/restart propagation from both selected units and their reported inverse relationships. Refuse any web action that can start, restart, or stop the supervisor and tell the operator to deploy the After-only unit relation and reload systemd.

Build selected artifacts from the matching checkout. Default and `--all` use the existing managed-server recipe with `managed-runtime-v1` and build client assets into isolated staging. `--all` also stages supervisor, admin CLI, session-host, and managed workload image. `--durable-only` stages only durable artifacts, and first proves live/on-disk web executable identity by resolved path and device/inode before it stops web. Build the image through the selected explicit Docker socket and use its immutable image ID. Inspect image/call sites to determine host sidecar requirements; do not run `prepare:rust-runtime` from this task worktree or create/mutate `.env`. For reset modes, run candidate `schema-version` and compare with a read-only SQLite query before stopping web.

For a reset mode, stop web/API ingress and take one final Inventory over the selected exact socket. Resolve each soul's Stop incarnation using the same active-first/otherwise-latest ordering as supervisor Stop. Validate desired-stopped souls before new Stops; never re-Stop/poll/reopen them. Select only desired-running coding-provider souls, excluding shell. Issue one revision-fenced Stop per target, sequentially; stop at first non-VerifiedEmpty, report attempted prefix and successful stopped set, and do not stop/replace supervisor. On any abort before supervisor shutdown, restore the web unit if the selected supervisor is healthy. After all Stops verify empty, stop supervisor, install only selected artifacts with destination-filesystem renames, update only the selected image reference atomically, start supervisor and wait for exact health, then web and readiness/callback socket. Join saved conversation references from final Inventory by soul ID, explicitly account for no/ineligible/missing identity, and dispatch Reopen only for saved references intersecting successfully stopped targets. Log each phase and per-soul result. Default's completion event repeats its pre-handoff reminder.

Add `"update:managed-runtime": "tsx scripts/update-managed-runtime.ts"` to `package.json`. Keep all updater dependencies injectable and each mode's action order explicit. Preserve persistent history/data and use forward recovery only.

- [ ] **Step 4: Run exact green selectors and refactor**

Run the five named Vitest commands from Step 2 and all remaining named new updater tests with exact `-t` selectors. Also run the full new unit file and `pnpm run typecheck:managed-tests` after Task 4 imports the updater. Expected: every targeted case executes and passes, with no prose/config snapshot tests.

Refactor parsing, approval, transient dispatch, lock ownership, owner/graph verification, manifest resolution, staging, each mode's actions, admin CLI calls, and output/logging into separate named functions. Keep failures recoverable and ensure web restoration runs on every applicable pre-supervisor-stop abort. Review only Task 3 files and tests.

- [ ] **Step 5: Commit the task**

~~~bash
git add scripts/update-managed-runtime.ts package.json test/unit/tooling/managed-runtime-update.test.ts
git commit -m "feat: add managed runtime update modes"
~~~

### Task 4: Integrate Fixtures, Systemd, Operator Guidance, and Safety Rules

**Files:**
- Modify: `scripts/testing/runtime-sandbox.ts`.
- Modify: `test/e2e-browser/specs/runtime-fresh-agent-fixture-rust.spec.ts`.
- Modify: `installers/systemd/freshell-rust.service.d/managed-runtime.conf`.
- Modify: `AGENTS.md` and `scripts/launch-rust.sh`.
- Modify: `scripts/prebuild-guard.ts` and its behavior test `test/unit/tooling/prebuild-guard.test.ts`.
- Modify both `.claude/skills/extension-installer/SKILL.md` and `.codex/skills/extension-installer/SKILL.md`.
- Modify: `docs/development/self-hosted-launch-runbook.md` and `docs/development/managed-runtime-rollout.md`.

**Interfaces:**
- Consumes the Task 3 updater and Task 2 control operations, plus disposable fixture adapters and the selected systemd unit pair.
- Produces provider-free evidence for all modes, an ordering-only web/supervisor relation, consistent operator guidance, and removal of ordinary web/client restart approval gates from repo-owned policy surfaces.

- [ ] **Step 1: Add failing fixture and guard behavior cases**

Add three named provider-free fixture cases and a fixture-owned second workload image/reference option:

1. `managed update modes - default preserves running souls and reports reminder`: updater replaces managed-runtime-v1 web/client and restarts only fixture web. Assert bridge remains enabled; supervisor, soul, incarnation, container, native-session, and history identities remain unchanged; follow-up succeeds; reminder is printed before handoff and present in completion JSONL.
2. `managed update modes - all reopens on updated runtime and restores primary view`: exact approval, fixture-owned transient worker and services, changed runtime marker, new incarnation on the same soul/provider store/native identity, retained history, visible automatic primary view immediately after atomic Reopen, and successful follow-up. Observe the direct Reopen command/request ID.
3. `managed update modes - durable-only preserves old web and client`: old web executable/version and old callback shape remain selected; only fixture supervisor/workload changes; web restarts only to restore callback readiness; client directory and digest remain unchanged; Reopen reaches the changed runtime through the old web peer.

These fixture cases must fail through executed assertions before the fixture option/behavior is implemented. Run these exact red selectors and confirm the named new test executes and fails behaviorally:

~~~bash
pnpm run test:runtime:fresh-agent-fixtures --grep '^managed update modes - default preserves running souls and reports reminder$'
pnpm run test:runtime:fresh-agent-fixtures --grep '^managed update modes - all reopens on updated runtime and restores primary view$'
pnpm run test:runtime:fresh-agent-fixtures --grep '^managed update modes - durable-only preserves old web and client$'
~~~

The fixture cannot test installed systemd wiring; the updater's Task 3 stubbed graph cases own that behavior.

Add a `prebuild-guard` behavior test that runs the guard's real production-health probe against a disposable fake Freshell server. It must prove the guard still blocks an in-place build that would overwrite a live `dist/`, while its actionable path no longer says an ordinary web/client restart needs approval and points to the default managed updater. Do not add a prose snapshot or compare a full help-text blob; assert the guard's exit/block behavior and the relevant actionable outcome. Run this exact red selector before changing the guard message and confirm it fails on the old action path:

~~~bash
pnpm run test:vitest run test/unit/tooling/prebuild-guard.test.ts --config config/vitest/vitest.config.ts -t '^live production build guard recommends updater without approval gate$'
~~~

- [ ] **Step 2: Implement compatibility, systemd, and policy corrections**

Change the installed drop-in to ordering-only `After=freshell-supervisor.service`; no `Requires=`, `Wants=`, or `Requisite=`. Preserve direct supervisor start/stop sequencing in the updater. Update `AGENTS.md`, `scripts/launch-rust.sh`, both extension-installer skills, and runbooks to remove blanket APPROVED restrictions for ordinary web/client restarts. Keep exact APPROVED only for `--all` and `--durable-only`, based on mode/action category and without compatibility analysis. In both skill copies, update every repeated reference about extension activation/restart, not just the first paragraph. Ordinary extension activation can occur with a normal web/client restart under the no-indirect-supervisor-restart rule.

Update `scripts/prebuild-guard.ts` guidance so it still blocks building over a live production `dist/` but directs operators to the default updater for ordinary web/client maintenance without an approval gate. Keep launcher PID ownership and systemd/unknown-owner safety checks. The effective-graph behavior is implemented/tested through Task 3 adapters, not guessed from the checked-in unit alone.

Both operator runbooks must say to invoke the updater from a host shell, not a Freshell-managed container pane: managed panes run inside soul containers and lack the host user systemd manager and matching deployment checkout. Document the three modes, exact reset approval, reminder/completion record, unit/status/journal/JSONL recovery, schema preflight, old-web/new-supervisor `--durable-only` behavior, failure/partial-state reporting, graph refusal and deployment/reload guidance, callback readiness, history retention, manual recovery, and forward-recovery runbook. Preserve the existing schema migration/verified backup procedure. Do not promise automatic artifact rollback. Do not change README.md.

- [ ] **Step 3: Run exact green fixture and guard tests**

Run each newly added fixture case by its complete title so the selector cannot pass without executing it, then run the real guard behavior test:

~~~bash
pnpm run test:runtime:fresh-agent-fixtures --grep '^managed update modes - default preserves running souls and reports reminder$'
pnpm run test:runtime:fresh-agent-fixtures --grep '^managed update modes - all reopens on updated runtime and restores primary view$'
pnpm run test:runtime:fresh-agent-fixtures --grep '^managed update modes - durable-only preserves old web and client$'
pnpm run test:vitest run test/unit/tooling/prebuild-guard.test.ts --config config/vitest/vitest.config.ts -t '^live production build guard recommends updater without approval gate$'
~~~

Expected: each named behavior executes and passes. The default and reset fixture outcomes, view visibility, retained history, old callback compatibility, changed runtime marker, and unchanged durable-only web/client are asserted. No fixture contacts real providers, production images/services, or live systemd.

- [ ] **Step 4: Run impacted checks and review this task**

Run: `cargo fmt --all --check`, `pnpm run typecheck:managed-tests`, the full `pnpm run test:runtime:fresh-agent-fixtures` lane, and the exact prebuild-guard test above. Also run `pnpm run test:e2e:local --project=chromium --grep '^P2-G01: real browser shell survives ten graceful/abrupt web replacements$' test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts`; the selector must execute only the shell case, not provider-backed P2-G04. Review `git diff --check`, systemd's ordering-only `After=`, absence of ordinary restart approval wording in all named surfaces, reset-only exact approval, host-shell guidance, all mode reminders, and compatibility behavior. Do not operate the live user systemd manager.

- [ ] **Step 5: Commit the task**

~~~bash
git add scripts/testing/runtime-sandbox.ts test/e2e-browser/specs/runtime-fresh-agent-fixture-rust.spec.ts installers/systemd/freshell-rust.service.d/managed-runtime.conf AGENTS.md scripts/launch-rust.sh scripts/prebuild-guard.ts test/unit/tooling/prebuild-guard.test.ts .claude/skills/extension-installer/SKILL.md .codex/skills/extension-installer/SKILL.md docs/development/self-hosted-launch-runbook.md docs/development/managed-runtime-rollout.md
git commit -m "feat: complete managed runtime update integration"
~~~

## Plan self-review

- The complete User Request block remains byte-for-byte identical to the block at original plan commit `76701e039`, appears exactly once, and retains hash `e692116fad48424da56cfb1c577231258ad9b4f16aded3cabc1652328c94aecf`.
- The implementation is split into sequential reviewable tasks: compile repair; supervisor protocol/Reopen/schema/admin CLI; updater orchestration; fixture, systemd, operator guidance, and safety surfaces. Each task owns a disjoint file set, has an explicit interface and review boundary, lists focused commands, and commits only its files.
- Task 1 also repairs one pre-existing feature-gated test-fixture compile error (`native_identity` omitted) that the focused server test exposed after the two planned production errors; its only change is a `None` fixture value.
- All 14 final-review findings are concrete plan requirements: ordinary restart wording is removed from both extension skills and prebuild guidance with a runtime behavior test; reset-mode aborts restore healthy web service; Reopen atomically restores automatic primary view; Stops halt at the first non-VerifiedEmpty outcome; durable-only checks running/on-disk executable identity; callback peer covers issue/activate/commit/abort/revoke; desired-stopped emptiness checks the addressed incarnation; Inventory is the authoritative saved-reference source joined by soul ID; schema/Reopen/CLI/callback red and green commands target exact named tests; implementation tasks are split; operator guidance specifies host shell and why; graph checks include forward and reverse activation/propagation relations; the default completion event includes the reminder; and worker invokes the resolved tsx JavaScript entrypoint with pinned Node.
- Reset targets remain separate from saved-reference candidates. The fixed Inventory is taken after web ingress closes; Stop uses the supervisor's active-first/otherwise-latest incarnation selection; targets are coding-provider souls with desired-running state; missing required identity yields unavailable without Reopen; Reopen candidates intersect only the successfully stopped set.
- Reopen remains migration-free. The candidate schema command avoids registry open; current schema is read-only. Successful command/digest/incarnation association, stopped-to-running CAS, and automatic-primary-view restoration commit atomically; exact replay precedes revision validation; pending revocation creates no command/incarnation/view/revision and retries with a fresh ID.
- The plan preserves the After-only service relation, owner-derived artifact manifest, explicit Docker socket, destination-filesystem staging, two-rename client swap, transient worker/lock/log design, exact reset-only approval, caller-loss completion, forward-recovery-only failure handling, and the accepted interruption/history tradeoff. No test claims to certify installed systemd wiring and no README change is planned.
- Task 2's implementation review found six Important gaps in real provider startup/resume, preparation commit, failure cleanup, successful replay after later lifecycle changes, and startup-path schema coverage. Task 2 now requires provider-stub regressions for each finding before it can pass task review; these findings remain open until a fixer commit and independent re-review clear them.
- Task 2 ownership includes `recovery.rs` because independent review proved stopped-intent cancellation occurs in the native-readiness path there; the fix must allow only the exact prepared Reopen attempt through that existing gate.
- Task 2 review re-review left two Important R4 subfindings: retrying pending revoke for an uncreated replacement without Docker, and distinguishing uncertain Docker-create outcomes from proven no-create. The task now includes backend outcome evidence, exact regressions, and a no-orphan-sweeper constraint.
- This amendment is plan-only. Do not run tests, builds, or service operations while reconciling it; review the diff and whitespace, preserve the User Request hash, and commit the plan correction only.
---
