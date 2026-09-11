# Freshell: durable souls, bounded runtimes, and safe automatic recovery

## Five-phase execution plan

**Prepared:** September 6, 2026.  
**Inspected repository:** `/home/sentinelx/workspace/freshell`, clean `main`, commit `78b8d9d7ae6c02f81646fe22f11bd7e286f0054c`.  
**Preparation status (September 6):** This document was prepared as an implementation specification, not a test-pass report. No repository files, agents, or services were modified during that preparation. Its original **NEW** path labels describe planned deliverables. The companion `freshell-runtime-gate-manifest.json` freezes the required gate IDs and assertions and has since been installed at `test/runtime/gate-manifest.json`.

**Production readiness (September 9): BLOCKED.** Code and gate harnesses for all five phases are present, and the latest ordinary regression check passes with 11,896 tests passed and 27 optional tests skipped. Exact-resume bootstrap and release-gate integrity fixes are committed. This does **not** establish a production runtime PASS: Claude, Codex, and Amplifier live certification remains pending; the required Docker-backed browser qualification lane needs resolution under the configured cloud-backend policy; and the final clean-candidate cumulative chaos/soak campaign has not been qualified. See [the production-readiness record](freshell-durable-souls-production-readiness.md) for commits, evidence, and remaining ship gates. The acceptance contract below is unchanged.

### Stage 5a amendment (September 11, 2026)

[Stage 5a — feature-preserving runtime simplification](freshell-durable-souls-stage-5a.md)
supersedes the certification/report-attestation requirements and the requirement
that secondary incident export succeed before cleanup. Product scope and
behavioral safeguards remain unchanged; all coding agents remain in scope.
Authoritative durable cleanup intent is still required before destruction.

### Outcome

Every Freshell-managed coding agent has a stable logical identity, its own enforced local CPU/memory/process budget, and a runtime independent of the web server. Restarting the web server restores its connection and tabs. When a runtime cannot be reattached, Freshell terminates that exact owned runtime and automatically uses the coding agent's valid recovery path. Only an agent with neither a usable live runtime nor any viable continuity-preserving resurrection path is a **lost soul**. Lost owned processes are reaped, the user receives a brief notice, and durable diagnostic evidence explains the loss and cleanup.

**Do not implement this as a broader process-name or environment-tag sweep.**

## Implementation contract — read before any phase

### A. Scope and fixed decisions

The first release targets the Linux Rust server and every coding-agent launch mode enabled in that installation. The implementation backend is **rootless Docker with cgroup v2**, not an ad hoc host-process backend. Session hosts are separate containers from the web server and supervisor. A future systemd backend may implement the same interface, but building it is not part of these five phases.

Node remains a supported legacy backend, with unchanged legacy behavior and an explicit `managedRuntimeV1: false` capability. It must reject configuration that claims these managed guarantees until it has a supervisor-backed implementation. Do not silently route a managed Rust session through Node's legacy spawn path. Linux managed mode must likewise fail closed rather than fall back to unmanaged processes when Docker or resource enforcement is unavailable.

The boundary is one **Freshell-managed agent runtime**, not one tab and not one provider brand. Two views of the same soul share one runtime and one budget. Provider-internal subprocesses and internal subagents share that budget. Independently managed child agents receive separate budgets through the supervisor and count against a project/installation aggregate admission budget. Do not claim to separately limit two provider-internal logical agents sharing one process.

A resumable historical session is not automatically a desired running agent. Startup recovers souls whose durable desired state is `RUNNING`; it does not start every transcript discovered in the user's history.

This design preserves work across web-server and supervisor restarts. It does not preserve OS processes across a machine reboot, undo external tool side effects, or guarantee protection against host administrator/kernel compromise. Durable provider recovery should still work after an ordinary reboot, but testing an actual machine reboot requires a separate disposable-machine environment; never reboot garageserver as a test.

### B. Definitions and decisions that must remain distinct

| Term | Exact meaning |
|---|---|
| `installationId` | Persistent UUID for this supervisor installation; not a server boot ID. |
| `soulId` | Stable UUID for one logical coding-agent conversation. Survives process replacement and view reconstruction. |
| `incarnationId` | UUID for one authorized provider-runtime launch. Never reuse it for another provider launch. |
| `providerSessionRef` | Provider name, provider-store namespace, and native durable session ID. Never use only a title or the most recent session. |
| `runtimeHandle` | Docker daemon identity plus full container ID and recorded launch generation. A PID, label, name, or environment value is not this handle. |
| `hostBootId` | Random value for the current session-host process. Changes even if Docker restarts the same container. |
| `paneId` / `tabId` | View identities; never determine whether an OS process is owned. |
| `controlEpoch` | Monotonic supervisor fencing generation; stale controllers cannot mutate a host. |
| `desiredState` | `RUNNING` or `STOPPED`, plus a monotonically increasing intent revision. Detached views do not necessarily mean stopped agents. |
| `recoveryState` | `LIVE`, `RECOVERING`, `BLOCKED`, `LOST`, or `STOPPED`; separate from process state and desired state. |
| `cleanupState` | `NOT_NEEDED`, `PENDING`, `VERIFIED_EMPTY`, or `FAILED`. A soul may be `LOST` while cleanup is still `FAILED`. |

Use the following recovery precedence, both at startup and after runtime failure:

1. Preserve and reattach a healthy, controllable current incarnation.
2. Reconnect through any supported compatible host/provider transport without replacing the provider process.
3. Resume the exact native coding-agent session from its existing durable state.
4. Restore a verified provider-compatible checkpoint/export and resume it, preserving the soul and recording checkpoint position and any missing tail.
5. Recreate a pristine pre-dispatch agent from its saved creation seed **only when durable command records prove no provider input was dispatched**. This is empty-agent reconstruction, not pretending that a missing conversation was resumed.
6. Use another implemented, verified provider-native import/continuation path with demonstrable conversation lineage. A newly generated summary prompt in an unrelated session is not automatically equivalent recovery.
7. If evidence or a credible recovery path exists but is temporarily unusable or lacks an adapter, classify `BLOCKED`, preserve it, and expose a specific repair requirement.
8. Only when every applicable path has a definitive negative result, with no unresolved probe or recoverable evidence remaining, classify `LOST` and reap exact owned leftovers.

A missing session ID alone does not establish loss: inspect the durable launch receipt, host journal, provider artifacts in that soul's namespace, and lineage records. Any identity found must be uniquely associated with the soul. Never guess from timestamps, cwd, names, or nearby transcripts.

**Never equate retries exhausted with lost.** Authentication failures, network failures, rate limits, storage I/O errors, missing workspace mounts, missing compatible binaries, unsupported protocol/schema versions, insufficient resources, and ambiguous session identity are `BLOCKED`. A healthy live incarnation with damaged resume state remains live; mark its durability degraded instead of killing it.

### C. Safety invariants

The implementation and tests must enforce all of these:

| ID | Invariant |
|---|---|
| I01 | Ownership is committed before provider code executes. Failed registry persistence cannot produce a successfully acknowledged unmanaged launch. |
| I02 | At most one active or potentially active incarnation may write a given `(provider, providerStoreId, nativeSessionId)`. A lease timeout alone never proves the old writer dead. |
| I03 | Kill APIs accept typed owned handles obtained from the protected registry, never arbitrary PIDs, Docker labels, user-supplied container IDs, or process patterns. |
| I04 | Web disconnect, browser closure, and web-server shutdown do not stop managed agents or close provider-facing transport. |
| I05 | Old owned workload termination is verified before a replacement provider writer starts. Failed verification blocks recovery. |
| I06 | Resume preserves the intended conversation. Wrong native identity is rejected; silent `SpawnFresh`, `thread/start`, `--continue`, and “latest session” fallbacks are forbidden in automatic recovery. |
| I07 | User stop wins every race with startup, resume, delayed create acknowledgment, and tab restoration. |
| I08 | Every desired running soul is represented in server-side inventory and the user's tabs, including recovery-blocked placeholders, without requiring browser localStorage to be empty. |
| I09 | Required CPU, memory, swap, and process limits are measured as effective; displaying requested settings is not proof. |
| I10 | Unknown ownership always means no destructive action. It does not prevent showing a diagnostic. |
| I11 | “Cleaned up” is emitted only after the owned enclosure is verified empty. Retain ownership records on cleanup failure. |
| I12 | Loss decisions and stop intentions have durable incident/outbox records before destructive actions. Diagnostic logging cannot be debug-only. |
| I13 | Retry budgets, stop revisions, recovery decisions, and command deduplication survive controller restart. |
| I14 | No workload receives the host Docker socket, host PID namespace, supervisor registry, administrative credentials, or arbitrary host mount capability. |
| I15 | Recovery does not automatically replay a prompt/tool action whose provider acceptance or side effects are ambiguous. |

### D. Repository evidence and implementation seams

The source labels below refer to the inspected commit, not an assumed future HEAD. Re-find symbols after pulling; do not apply patches by stale line number.

| Source | Existing seam and why it matters |
|---|---|
| R01 | `AGENTS.md`; `/home/sentinelx/AGENTS.md`; `/home/sentinelx/SECURITY.md`: worktrees, green-base gate, destructive-test sandbox, no production restart without `APPROVED`, no PR creation without explicit approval. |
| R02 | `crates/freshell-server/src/main.rs:364–414,1172–1216,1985–2028`: in-process provider construction, Codex startup sweep, and shutdown destruction/retention wiring. |
| R03 | `crates/freshell-terminal/src/pty.rs`, `registry.rs`: web-owned PTY handles and lifecycle. Move ownership, not just spawn calls. |
| R04 | `crates/freshell-codex/src/launch_lifecycle.rs:1172–1195,1244–1295`: detached spawn precedes durable registration; record-write failure currently permits untracked continuation. |
| R05 | `crates/freshell-codex/src/sidecar_sweep.rs:195–227`: the kill branch records `Reaped` and removes the record without requiring verified-empty completion. |
| R06 | `crates/freshell-freshagent/src/session_lease.rs:46–118`: existing tagged-process/PID cleanup. Managed mode must not reach it. Preserve lease semantics while replacing kill authority. |
| R07 | `crates/freshell-freshagent/src/claude.rs`, `codex.rs`, `identity_sink.rs`; `crates/freshell-claude-sidecar/index.mjs:567–571`: provider transport/state and identity capture; Claude stdin-close currently ends queries. |
| R08 | `crates/freshell-opencode/src/serve.rs:622,656,899–955,1318`; `transport.rs`: shared serving manager, provider session APIs, child-process lifecycle. Actual manager file is `serve.rs`, not `manager.rs`. |
| R09 | `crates/freshell-ws/src/pane_ledger.rs`, `reconcile.rs`, `tabs_persist.rs`; `crates/freshell-server/src/recovery_inventory.rs`; `src/components/RecoveryOfferPanel.tsx:86`; `src/lib/recovery/build-recovery-plan.ts`; `src/lib/ws-client.ts:295–316`: reuse identity/tombstones/tab persistence, remove the empty-layout restriction only for the new automatic managed path. |
| R10 | `crates/freshell-platform/src/resume_gate.rs:8–11,27–38,49–65`: existing missing-session policy can return `SpawnFresh`. This is incompatible with automatic soul recovery. |
| R11 | `crates/freshell-ws/src/auto_resume.rs:1–48`: existing auto-resume covers only selected WS-created CLI terminals, with bounded retries. Do not create a second competing restart owner. |
| R12 | `crates/freshell-freshagent/src/lib.rs:1976–2025`; `crates/freshell-platform/src/mcp_inject.rs`; `server/mcp/`: external API/provider routing and injected tool endpoints. Internal resume must not depend on an external route that does not support that provider. |
| R13 | `scripts/base-gate.sh`; `scripts/sandbox-test.sh`; `docs/development/test-sandbox.md`; `scripts/testing/coordinator-command-matrix.ts`; `test-coordinator.ts`: test coordination and physical isolation. |
| R14 | `test/e2e-browser/helpers/rust-server.ts`; `playwright.config.ts`; `playwright.cloud.config.ts`; existing restart/identity/recovery specs: owned server fixture and test-selection rules. Current Rust fixture tears down descendants, so do not reuse its stop behavior for managed siblings unchanged. |
| R15 | `test/integration/real/coding-cli-session-contract.test.ts`; `test/helpers/coding-cli/real-session-contract-harness.ts`; `docs/lab-notes/2026-04-20-coding-cli-session-contract.md`: existing real-provider probes, currently skippable and not themselves Freshell E2E tests. The note distinguishes allocated IDs from durable sessions. |
| R16 | `crates/freshell-server/src/logging.rs`: existing redaction and JSONL rotation. Reuse the behavior in the supervisor/host without making those crates depend on the server binary. |
| R17 | `shared/ws-protocol.ts`; `port/contract/generate-ws-contract.ts`; `crates/freshell-protocol`: shared protocol and generated/frozen contract. Add compatibility tests for new fields rather than editing generated artifacts alone. |

Read-only host inspection also reported Docker `29.7.2`, cgroup driver `systemd`, cgroup version `2`, and CPU-quota/memory/swap/PID-limit support. It reported no cpuset or I/O-controller support. Therefore use CPU quota, not CPU affinity, and do not promise disk-I/O throttling. No enforcement workload was run during this review.

### E. Common execution and gate rules

**Before implementation:** read current instructions; fetch `origin`; fast-forward a clean local `main`; run `scripts/base-gate.sh test` with `FRESHELL_TEST_SUMMARY` set. If it fails, stop before creating the feature worktree and report the exact failure. The base script fetches again: record the SHA it actually tested and ensure the worktree uses that same green base. Work only in `.worktrees/`. Use one sequential feature branch or phase branches only after predecessor changes are integrated. Do not open a PR or restart production without the required explicit approvals.

Each numbered task below is one Red–Green–Refactor unit. Add the failing test first, implement, refactor, run the focused tests, then commit a coherent change. Do not start the next phase until the preceding phase's complete gate is green. Do not weaken assertions, mark a required case skipped, or substitute a fixture for a required real-provider leg to get green.

**Create the following entry point in Phase 1:**

```bash
npm run test:runtime -- gate phase-1 --require-live
npm run test:runtime -- gate phase-2 --require-live
npm run test:runtime -- gate phase-3 --require-live
npm run test:runtime -- gate phase-4 --require-live
npm run test:runtime -- gate phase-5 --require-live
```

`test:runtime` is a new coordinator-managed workload. The dispatcher validates the phase name, acquires the shared coordinator once, checks capabilities and the gate manifest, builds the candidate commit, starts the disposable runtime test suite, runs the current and all earlier phase cases, runs the required regression commands, validates evidence, and tears down only its own test resources. Exit `0` only for `PASS`; exit `1` for assertion/build failure; exit `2` for missing prerequisites or blocked infrastructure. A blocked gate is not a pass.

Avoid nested coordinator deadlocks: register a single runtime gate workload and have its internal executor run the underlying test commands while holding the existing lease. Separately invoked `npm run check` or `npm run test:e2e` is not called recursively from a held lease. Use the repository coordinator's established executor patterns and add a test proving a foreign holder is waited for, never killed.

The gate runs typechecking, lint, coordinated default/server/electron tests according to existing support, affected Rust unit/integration tests, affected existing browser tests, and the runtime cases. Rust destructive suites and restart/fault tests run inside the Docker sandbox. Do not use a broad `cargo test --workspace` that unexpectedly builds desktop/Tauri targets; name the affected crates. Add the new browser specs explicitly to `RUST_ONLY_SPECS` and the `rust-chromium` selection. Assert `--list` yields every required case. No required runtime case may disappear into `CLOUD_SKIP_SPECS`.

Keep existing `FRESHELL_VITEST_BACKEND` and `FRESHELL_E2E_BACKEND` choices. This plan adds a separate **runtime-integration sandbox lane** because it needs real Docker control/resource observations. It is not a covert local fallback for cloud tests. When no appropriate configured runner exists, the runtime gate is blocked until an approved capable runner is available. Provider tests use only approved test credentials/models/budget; missing credentials block the relevant live gate, never trigger an authentication workaround or an unapproved paid run.

**Every passing gate produces:**

```text
.runtime-evidence/<candidate-sha>/<run-id>/
  manifest.json                  # expected case IDs and expanded provider/ingress matrix
  summary.json                   # PASS/FAIL/BLOCKED, counts, zero missing required cases
  build.json                     # commit, dirty diff hash if any, binary hashes, image digests
  capabilities.json              # Docker/controller support and measured effective limits
  ownership-before.json
  ownership-after.json
  lifecycle.jsonl                # supervisor + host + web correlation IDs
  assertions.jsonl               # machine-checkable test facts, not just console messages
  provider-results.json          # actual CLI/SDK version, model, native IDs, resume evidence
  browser/                       # Playwright trace, screenshots, browser console, WS evidence
  incidents/                     # diagnostic reports from intentionally induced failures
  cleanup.json                   # exact created IDs, confirmed teardown, foreign sentinels alive
```

Protect evidence as sensitive test data. Redact tokens and message bodies from general logs and traces; retain only synthetic test conversation content where the test explicitly needs it. Paths and external provider identifiers can be hashed in exported reports. Evidence failure, cleanup failure, no matched tests, skipped required tests, and wrong-binary execution all fail the gate. Never present a flaky first failure as an unconditional pass after rerun; keep both attempts and repair unexplained flakiness.

## Phase 1 — durable ownership, safe launch/stop, and the live test harness

**End state:** a production-quality supervisor core can launch and terminate bounded test runtimes without ever acquiring authority over unrelated processes. Existing production launch paths remain legacy/feature-disabled. New managed ownership and stop semantics are exercised through real Docker and IPC, not only mocked unit tests.

### Files

**NEW:** `crates/freshell-runtime-protocol/`, `crates/freshell-supervisor/`, `crates/freshell-session-host/`; `docker/runtime/`; `scripts/testing/runtime-gate.ts`; `scripts/testing/runtime-sandbox.ts`; `scripts/testing/runtime-test-broker.ts`; `test/runtime/fixtures/`; `test/runtime/gates/phase-1.test.ts`; `test/runtime/gate-manifest.json`; `docs/development/managed-runtime.md`.

**MODIFY:** root `Cargo.toml`/`Cargo.lock`, `package.json`/lock as needed; coordinator files R13; sandbox entrypoint/selftest; Codex lifecycle and sweep R04/R05. New crate dependencies must reuse versions already resolved where practical, including the existing bundled `rusqlite` family; record any deliberately added dependency.

### P1.1 — freeze types and threat boundary

Create serializable Rust newtypes for all identities in B. No `String`-typed public `kill` method. Define `OwnedRuntimeHandle` with private constructor accessible only to the ownership repository. Define command request IDs, error codes, and `RuntimeLimits { cpuMilli, memoryBytes, swapBytes, pidsMax }`.

Document that the supervisor is trusted with the rootless Docker account, while workloads are not. The web server is authorized for Freshell operations but never receives the Docker socket. Only installation-scoped registry membership grants runtime management. Test helpers have a separate test-run ownership namespace and cannot grant production ownership.

### P1.2 — build the protected registry

Create a SQLite database on a supervisor-only named volume, outside all workspace binds and provider homes. Use foreign keys, WAL, full synchronous commit, schema migrations in transactions, and a single supervisor ownership lock. Refuse startup mutation on unknown/newer schema or integrity failure; do not create an empty replacement database over evidence of an existing installation. Put SQLite work on a dedicated blocking/database executor, not an async event-loop thread. Verify durability assumptions on the target local filesystem. [W06]

Create these tables and constraints:

| Table | Required fields / constraints |
|---|---|
| `installation` | Singleton `installation_id`, `schema_version`, `control_epoch`; lock ownership is external to row contents. |
| `souls` | `soul_id` PK, provider, provider_store_id, native_session_id nullable, creation_seed_ref, desired_state, intent_revision, recovery_state, durability_state, checkpoint_revision, timestamps. |
| `incarnations` | `incarnation_id` PK, soul FK, launch_nonce, Docker daemon ID, full container ID nullable, launch_state, host_boot_id nullable, execution_generation, requested/effective limits, cleanup_state, exit/OOM info. Unique full daemon/container pair. |
| `writer_claims` | Unique `(provider, provider_store_id, native_session_id)` when materialized, soul, incarnation, intent_revision; release only after verified empty or proved never started. |
| `commands` | Unique `(soul_id, request_id)`, payload digest, protected payload ref, state, provider acknowledgment/turn ID nullable, incarnation, event cursor. Same key with different payload is `409 REQUEST_ID_CONFLICT`. |
| `recovery_attempts` | Correlation/attempt ID, soul, prior incarnation, intent revision, path, structured verdict, evidence references, timestamps. |
| `outbox` | Durable lifecycle/notice events with deterministic event IDs; delivery may repeat, effects must deduplicate. |
| `stop_tombstones` | Soul, intent revision, actor/reason, commit time; never expire while an older incarnation can remain. |

Also enforce one active/potentially active incarnation per soul with a transactional claim or partial unique index covering `PREPARED`, `CREATED`, `STARTING`, `RUNNING`, and `STOPPING`. A stop failure remains in that active set. Keep stopped incarnation rows for forensics. Do not store raw credentials in these tables.

### P1.3 — implement the Docker backend with no process-creation gap

Implement `RuntimeBackend::{create_stopped, start_host, inspect, request_stop, force_stop, verify_empty, list_known, read_limits}`. All mutations after creation require an owned handle. Pin image digests. Use the Docker Engine API/client with argument/value separation, not shell-expanded Docker commands.

Launch order is mandatory:

1. Commit `PREPARED`, resource reservation, request dedupe, creation seed, and a random launch nonce.
2. **Create, but do not start**, a container with the complete isolation/limit configuration and `restart=no` during staging.
3. Commit its full daemon/container ID as `CREATED`. If this write fails, do not start it. A crash between create and registration may leave a stopped Docker object, never executing agent code; quarantine that object rather than infer kill authority from its label.
4. Start only the trusted session-host entrypoint. It exposes health/bootstrap IPC and cannot launch provider code until granted execution.
5. Inspect and verify effective limits and authenticate the expected host. Commit `STARTING`/host identity and an execution grant for the recorded intent revision.
6. Enable the intended long-lived container policy. The host still needs a valid current execution grant before launching a provider. Commit the grant before sending it.
7. The host durably records grant consumption and starts the provider at most once for that host boot. Repeated grant delivery returns the original result.
8. Capture provider identity/durability separately, then emit the launch result. Do not call an allocated native ID a durable checkpoint.

If Docker restarts the host container, a changed `hostBootId` invalidates any prior execution grant. The new host must wait; it may not autonomously replay a provider launch. Reconciliation terminates/retires the failed incarnation and creates a new incarnation as appropriate. This prevents Docker restart policy from bypassing the supervisor's one-writer rule.

### P1.4 — implement authoritative stop

Commit the stop intent and advance the soul's intent revision before signaling anything. Fence new commands. Ask the host to stop gracefully; after a configurable grace period, stop/kill the exact full container ID through Docker. Verify the container has no running/restarting/paused workload before committing `VERIFIED_EMPTY`. Handle paused containers through the backend's tested stop/unpause escalation, not a hung grace timer.

Return one of `VerifiedEmpty`, `BlockedOwnership`, `BackendUnavailable`, or `TerminationUnconfirmed`. Only the first releases writer/resource claims. Container removal and provider-data deletion are separate operations; automatic process cleanup must not delete durable conversations.

Every runtime reinspection checks daemon identity, exact full ID, immutable expected mount/isolation configuration, and incarnation association. Treat mismatch as blocked, not permission to kill whatever has the old name. Never use `docker kill $(docker ps ...)`, label-wide deletion, `pkill`, tagged-environment scans, or naked saved PIDs.

### P1.5 — harden legacy hazards without broadening legacy authority

Add failing regressions for R04/R05. In the legacy detached path, refuse a successful retained launch when durable registration fails and safely terminate only the exact child handle still owned by that invocation; do not broaden a legacy scan. Retain unresolved ownership evidence and report failure.

Change the legacy sweep so an attempted kill is not unconditionally called `Reaped`. Preserve records on refused or unconfirmed termination. This is interim hardening, **not** a claim that legacy detached processes now satisfy the new atomic launch guarantee. Existing legacy crash windows are eliminated for newly managed sessions by P1.3 and later routing.

### P1.6 — construct physically isolated live tests

Extend the existing sandbox with a validated `runtime-suite` mode; leave ordinary sandbox behavior intact. The trusted test orchestrator/broker alone holds the rootless Docker socket. The SUT supervisor accesses a restricted Docker API proxy that permits only this run's approved container templates, images, workspace paths, volumes, and exact creation receipts. Browser, fixture providers, and coding agents never get the socket.

Use `project=freshell` and a random `runtimeTestRunId` for bookkeeping, but authorize teardown from the broker's exact creation receipts, not labels. Bind only the test root, never real provider homes, supervisor data, host PID namespace, host network, or production ports. Create sibling web/supervisor/runtime containers so web stop cannot kill runtime siblings. Re-run `scripts/sandbox-selftest.sh` after changing sandbox code.

The proxy is defense in depth, not permission for a broken reaper: assert that foreign-target tests cause **no attempted destructive Docker request from the SUT**. A proxy refusal after an unsafe SUT request is a failing test.

Fixture executables are real processes: an echo/heartbeat worker, descendant spawner with `setsid`/double-fork, bounded CPU burner, bounded memory allocator, and a deterministic native-session fixture with create/resume/history endpoints and disk state. Add named failpoints only to a test build/feature. A normal release must neither expose the fault routes nor honor fault-injection environment variables.

### P1.7 — protocol and evidence scaffolding

Use a versioned, length-bounded JSON IPC protocol with explicit request IDs and capabilities. Production transport is a private Unix-domain socket namespace: a supervisor-only IPC volume, a separate web-control subdirectory, and only the specific incarnation subdirectory mounted into each runtime (Docker volume subpaths). Never mount the parent IPC namespace into workloads. Use a challenge/response secret scoped to the incarnation plus role/method authorization; possessing an incarnation credential never grants supervisor administrative or other-soul access. Authenticate the expected runtime against its registry-backed container identity as well. [W07]

Set a 1 MiB maximum control frame; transfer large snapshots/output in bounded chunks. Admin and runtime-event message types must be distinct. Invalid roles, overlarge frames, wrong generation, and unknown identity return typed errors and never dispatch a stop.

### Gate 1 — required live cases

| Case | Procedure | Pass assertion |
|---|---|---|
| P1-G01 | Run the sandbox selftest, then start the compiled supervisor/host and real heartbeat worker through actual IPC/Docker. | Correct binary/image hashes, usable worker, committed owned ID, effective limits, no production mounts/ports. |
| P1-G02 | Crash the supervisor at each launch barrier: after intent, after Docker create, after ID commit, after host start, before/after grant commit and delivery. Restart with the same volume. | No provider before ownership/grant; at most one authorized launch; unregistered created objects are stopped; no acknowledged untracked worker. |
| P1-G03 | Make registry writes fail before launch, at ID commit, and at grant commit. | API errors; no provider execution and no success acknowledgment; recoverable evidence remains. |
| P1-G04 | Start unrelated sentinel processes and containers with matching executable names, cwd strings, labels, and copied environment tags; submit stale/wrong handles. | Sentinels keep heartbeating; SUT emits no destructive request for them. Test owner cleans them later by its separate receipts. |
| P1-G05 | Let an owned worker fork/double-fork, change session/group, and spawn during stop. | Exact enclosure becomes empty; all owned descendants stop; unrelated sentinel stays alive. |
| P1-G06 | Inject Docker timeout/stop failure and then restore Docker control. | First outcome is unconfirmed, record/claim retained; later stop verifies empty; no premature `Reaped` or notice. |
| P1-G07 | Start two supervisors against the same registry; replay stale epoch commands and reused request IDs with a changed payload. | One controller; stale control rejected; conflicting request rejected; no duplicate worker. |
| P1-G08 | Exercise legacy registration-write failure and legacy sweep kill refusal in the destructive sandbox. | No successful retained untracked launch; no unconditional `Reaped`; no foreign signal. |
| P1-G09 | Attempt runtime access to Docker/admin IPC, another incarnation's socket, registry files, and host PID namespace. | Access denied; own allowed IPC still functions. |
| P1-G10 | Run a normal release image with test fault settings, then intentionally leave a required test unmatched/skipped in a harness selftest. | Release fault hooks absent; the gate checker fails the deliberately incomplete run. |

**Phase handoff:** protocol/schema docs, launch/stop state diagrams, passing Gate 1 evidence, migration-disabled feature flag, and a list of every remaining legacy spawn/kill site. Do not enable managed user launches yet.

## Phase 2 — independent PTY/session hosts and enforced per-agent budgets

**End state:** a managed terminal and its coding CLI continue running through web-server and supervisor restarts. The host—not the web server—owns the PTY, consumes output, and applies a tested isolation profile. The first native live-provider terminal path is working behind an explicit managed-mode feature flag.

### Files

**NEW:** `crates/freshell-runtime-client/`; supervisor modules `backend/docker.rs`, `admission.rs`, `limits.rs`; host modules `pty.rs`, `command_journal.rs`, `output_journal.rs`, `control.rs`; `docker/runtime/Dockerfile`; `docker/runtime/compose.yaml`; `docker/runtime/provider-versions.json`; `test/e2e-browser/helpers/managed-runtime.ts`; `test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts`; `test/runtime/gates/phase-2.test.ts`.

**MODIFY:** R02/R03 terminal registry and server wiring; `crates/freshell-ws/src/terminal.rs`; `crates/freshell-freshagent/src/terminal_tabs.rs`; terminal restore/transport helpers; sandbox browser fixtures and project selection R14. Reuse the project's CLI launch construction in `crates/freshell-platform/src/cli_launch.rs` rather than inventing flag strings in the web layer.

### P2.1 — define the workload image and persistent mounts

Build a pinned image containing the session-host binary and required shell/toolchain. Pin Node and provider versions; record the image digest and exact CLI/SDK versions in every launch and gate. The installed repository requires Node at least 22.5 and declares Rust 1.96 as its workspace minimum; follow the current lockfiles/toolchain after updating the base rather than selecting floating `latest`. R15 is historical observation, not a current-version guarantee.

Every managed container uses its own PID/network/cgroup namespaces, all Linux capabilities dropped unless a specifically tested requirement is documented, no privileged mode, no host PID/network, and no Docker socket. Use a read-only image root with bounded writable temp space. Run with the least privilege compatible with rootless bind ownership; if container UID 0 is used to map the invoking unprivileged host user for workspace access, document that mapping and prove capabilities/namespace restrictions. Do not solve permissions by broad `chmod`/`chown` of the user's home or repository.

Allocate a persistent provider-state/home volume per soul, surviving incarnation replacement. Mount only that soul's home into its runtime. Registry and execution-grant authority live on a different supervisor-only volume. Temporary runtime state is per incarnation. Retained conversation/checkpoint storage is not deleted when a container is removed.

Preserve the canonical working-directory path inside the container by mounting approved workspace paths at the same absolute path. Validate symlinks and reject any bind that would expose supervisor volumes, control directories, Docker sockets, or unrelated homes. For Git worktrees, also make the exact required common Git directory available at its referenced path; test `git status`, edits, and the normal build command. Mount project assets/tool caches only through a named allowlisted workspace profile. Do not mount the whole host home to avoid missing-file errors.

Derive provider homes explicitly: `HOME`, Claude's documented/configured home variable, `CODEX_HOME`, and OpenCode's XDG data/config roots. Clear conflicting inherited home overrides, following the existing isolated-home helper R14. Store these choices in `ResumeSpec`, not ambient shell configuration.

### P2.2 — limits and admission

Define configured profiles, with these **initial implementation defaults to review before production rollout**, not claims about measured provider needs:

```json
{
  "defaultAgent": {
    "cpuMilli": 2000,
    "memoryBytes": 4294967296,
    "swapBytes": 0,
    "pidsMax": 512
  },
  "testFixture": {
    "cpuMilli": 500,
    "memoryBytes": 268435456,
    "swapBytes": 0,
    "pidsMax": 64
  }
}
```

Map `cpuMilli / 1000` to Docker CPU quota; `2000` means two CPUs' worth of aggregate time, not two pinned cores. Map `memoryBytes` to hard memory; Docker's memory-plus-swap setting is `memoryBytes + swapBytes`, so zero allowed swap requires memory-swap equal to memory. Map `pidsMax` to the cgroup process/thread limit. Reject zero/unbounded/malformed values in managed profiles. Read effective values back after create/start; fail launch if required controls are unavailable. Do not substitute `nice`, a language heap flag, or `ulimit` for a whole-workload limit. [W01–W03]

Do not write directly into Docker-owned host cgroup directories. Read namespace-scoped cgroup metrics from the trusted host and Docker stats/inspect; let Docker be the writer of its managed limits. Do not advertise `memory.high`, CPU affinity, or I/O controls unless a supported backend implementation actually applies and verifies them.

Configure explicit installation/project aggregate reservation budgets. Admission occurs transactionally before creation; running, starting, and cleanup-unconfirmed incarnations count. Sum reservations rather than sampled usage. Include fixed control-plane/test-run headroom outside the agent total. Nested Freshell-created child agents consume both child and parent/project aggregate allowance. A second view consumes no additional allowance.

Treat unavailable admission as `BLOCKED_RESOURCE`, not lost. Preserve requested versus effective profiles and rejected reasons. Initial resource edits apply to the next incarnation; changing an active hard memory ceiling or forcing an agent restart requires an explicit apply-now action. Recovery reuses the saved profile unless the user changes it; never silently enlarge limits after OOM.

### P2.3 — move PTY ownership out of the web server

Extract the real PTY spawning/reader/writer/waiter ownership into `freshell-session-host`. Keep terminal IDs and public WS semantics stable. Replace the managed `TerminalRegistry` entry with a facade that forwards input/resize/attach and subscribes to host output. It must not own an OS kill-on-drop handle for managed runtimes.

A managed entry's web shutdown closes only its runtime-client subscription. Audit all registry `kill_all`, `Drop`, idle cleanup, exit callbacks, and create-cancellation paths. User-requested kill becomes a supervisor stop transaction; do not silently turn view detach into stop. Legacy entries retain legacy behavior until migrated.

The supervisor reconnects to existing hosts after its own restart; session hosts keep running without a controller connection. Restarting a web or supervisor container must not run compose-wide `down` or include session hosts in that service's destruction scope. Infrastructure launch scripts must start/restart named services, not the entire project.

### P2.4 — bounded output and durable commands

The host continuously drains the PTY even with zero web/browser subscribers. Start with a 1 MiB bounded in-memory output ring, a 64 MiB per-soul rotating terminal spool, and 64 KiB transport chunks; make them configurable. These are replay buffers, not substitutes for provider transcripts. Slow clients cannot block provider output or create an unbounded queue. If a cursor is older than retained output, respond with an explicit reset/snapshot and a truncation marker.

Identify every stream by `(incarnationId, streamEpoch, sequence)`. A subscriber obtains a snapshot at sequence `S`, then events strictly after `S`; event replay is deduplicated. Resume in a new incarnation resets its stream epoch, never reuses an old cursor as if it were continuous raw terminal output. Persist title/cwd/dimensions/settings needed to reconstruct the view.

Before forwarding semantic commands, persist a request ID, protected input payload, and command state. Use `QUEUED`, `DISPATCHING`, `PROVIDER_ACKED`, `COMPLETED`, `AMBIGUOUS`, `CANCELLED`. Never infer delivery from a missing HTTP acknowledgment. A crash in the dispatch/ack gap becomes `AMBIGUOUS` unless provider evidence resolves it. Raw terminal input frames also receive transport sequence/dedupe, but do not claim arbitrary shell side effects are exactly-once.

### P2.5 — first real coding CLI and server adapter

Use **OpenCode as the first real-provider managed slice**. The reason is operational as well as architectural: OpenCode has a free-tier path, so the high-frequency continuity/restart/resource gates can run repeatedly without making provider spend the limiting factor. Use OpenCode's real CLI/server/session behavior and real native session identity; do not add a canned mock adapter and call that the live-provider gate. Route both WS and REST terminal creation through one managed launch service, preserving dedupe, cwd, environment allowlists, terminal IDs, pane provenance, and per-soul provider state.

Pin the Phase 2 lane to **OpenCode 1.18.21** and the anonymous free-tier model **`opencode/big-pickle`**, with `autoupdate:false`; record and verify those values instead of silently accepting upstream drift. OpenCode's TUI requires executable temporary storage, so keep global `/tmp` noexec and provide only OpenCode a bounded 64 MiB exec tmpfs at `/run/opencode-tmp` via `TMPDIR`. The soul uses fixed private `127.0.0.1:4096`; no web-host port allocator, host rebind plugin, or project-local Freshell MCP mutation is part of the managed lane. Native `ses_*` identity is discovered from the soul-local DB by an unprivileged provider-UID helper inside the enclosure and then folded through the normal pane ledger.

OpenCode must run **one provider runtime per soul** for this lane. Do not reuse the legacy shared `OpencodeServeManager` process for two souls and then claim per-agent memory/CPU isolation; the process and all descendants for a managed OpenCode soul belong inside that soul's runtime enclosure. Phase 2's first native-provider continuity gate therefore proves OpenCode process continuity, native-session continuity, provider-home persistence, and per-soul isolation before Claude or Codex are used as acceptance dependencies.

The new `ManagedRuntime` capability is negotiated before the browser creates/restores managed terminals. Keep the existing restore-create hold during startup reconciliation. A restart retry computes the stable soul/terminal identity first and consults supervisor inventory before constructing a new launch payload: if that exact soul/terminal is already `RUNNING`, reattach it directly even when the browser now knows a native session id that was absent on the original fresh create. Any existing stopped/non-running or terminal-mismatched soul fails closed. This prevents evolved restore metadata from turning a live incarnation into a request-digest conflict or accidental replacement. Managed handles must not enter legacy R06/R11 kill/auto-resume code. Phase 3 supplies comprehensive provider resume; Phase 2 must already prove live-process continuity without replacements.

#### Provider test-cost policy

Use the least-cost real model/configuration that still exercises the provider's true session and tool path. This is a test invariant, not an optional optimization:

- **OpenCode:** use its free-tier path for the first and default repeated live-provider gates whenever that path supports the behavior under test. Record the actual provider/model selected by OpenCode in the gate receipt.
- **Claude:** all routine continuity, resume, recovery, permission, and tool-path testing uses **Haiku** at the provider's lowest available thinking/reasoning setting. Do not silently fall back or upgrade to Sonnet/Opus for these gates.
- **Codex:** all routine continuity, resume, recovery, permission, and tool-path testing uses **GPT-5.6 Luna** at the **lowest available thinking/reasoning setting**. Do not silently fall back or upgrade to a higher-cost model or thinking level.
- A test whose explicit subject is model selection/model-specific behavior may override the preceding model only when the scenario names that override and the evidence records the resolved model and reasoning/thinking setting.
- If a requested low-cost model/setting is unavailable, mark the provider lane **BLOCKED** with the resolved availability error; do not substitute a more expensive model and call the required gate passed.

Every real-provider gate records provider, CLI version, resolved model, resolved thinking/reasoning setting (when the provider exposes one), native session ID, and whether a paid or free-tier path was used.

### P2.6 — OOM, exit, and test fixtures

Observe Docker OOM/die events and per-workload resource metrics. The supervisor still notices an OOM if the host dies before writing a final log. An agent child can be OOM-killed while the host survives: the host must report the provider exit and trigger the same failed-incarnation handling, not leave a green-but-useless terminal.

Create a managed browser fixture with separate `restartWeb`, `crashWeb`, `restartSupervisor`, `stopSoul`, and `destroyTestRig` methods. `restartWeb` must not enumerate or kill runtime descendants. `destroyTestRig` uses exact test creation receipts and independently verifies foreign sentinels survived. Keep the old fixture for legacy regression tests.

### Gate 2 — required live cases, plus Gate 1

| Case | Procedure | Pass assertion |
|---|---|---|
| P2-G01 | Through the real browser, open a managed shell running a heartbeat and a long child command. Gracefully restart web, then SIGKILL web, ten cycles total. | Same soul, incarnation, container, host boot, and child process identity; output advances; input remains usable; one tab/view association. |
| P2-G02 | Close all browsers and stop web for 60 seconds while output is produced; reconnect with old and expired cursors. | Worker continues; output replay is ordered/deduped; explicit reset on expired cursor; queues/spool stay within configured bounds. |
| P2-G03 | Restart and crash the supervisor while web and the worker run. | Same provider incarnation keeps running; new supervisor adopts it; stale epoch control is rejected. |
| P2-G04 | Start OpenCode 1.18.21 with `opencode/big-pickle` on the anonymous free-tier path, complete a first Bash-tool turn, begin a controlled long Bash tool, SIGKILL/restart web while the tool is running, then run a second provider-side tool in a follow-up. | Same native `ses_*`, soul, OS incarnation, container and host boot; first/long/follow-up tool effects each occur exactly once as applicable; provider launch count remains one; no paid-model fallback or CLI auto-update. |
| P2-G05 | Run CPU burners with four descendants under a 500-milliCPU fixture profile while an independent sentinel runs. Measure 30 seconds after warmup. | Effective `cpu.max` matches; aggregate CPU time stays at or below 0.60 CPU-seconds/second over the window; throttling counters increase when schedulable; sentinel remains responsive. If host starvation prevents proving throttling, mark infrastructure blocked, not pass. |
| P2-G06 | Grow touched memory beyond the 256 MiB fixture cap, including a child-only allocation case. | Effective memory/swap bounds match; cgroup OOM/exit observed; web and unrelated sentinel survive; no unbounded allocation; no false lost verdict. |
| P2-G07 | Spawn bounded descendants until the PID/thread ceiling rejects more; also test a double-fork/setsid descendant. | Effective process ceiling enforced; every descendant remains in the same quota boundary; complete owned cleanup. |
| P2-G08 | Submit concurrent launches that exceed the configured aggregate budget and attach a second view to one soul. | Admitted reservations never exceed budget; excess launches blocked; second view creates neither worker nor reservation. |
| P2-G09 | Use a real Git worktree, file edit/build command, provider home, and saved cwd; recreate only the web container. | Git/common-dir paths and edits work; files and provider state persist; registry/control secrets inaccessible from workload. |
| P2-G10 | Lose command acknowledgment, retry the same request, then stop while a create/input acknowledgment is delayed. | No duplicate dispatch; conflicting reuse rejected; user stop wins; no replacement spawned by a web exit callback. |
| P2-G11 | Restart only named web/supervisor services using deployment commands, then intentionally recreate the host process. | Web/supervisor restarts preserve host; host restart changes boot ID and cannot execute an old grant or create an unregistered second provider. |

**Phase handoff:** first real-provider continuity trace, measured resource report, managed terminal facade, exact mount profile, bounded replay/dedupe contract, and passing Gate 2. Managed mode stays explicit and opt-in.

## Phase 3 — all provider adapters and automatic soul resurrection

**End state:** each enabled managed provider supports independent hosting, accurate recovery capability, and automatic native resurrection. A broken incarnation with a valid recovery path is stopped and replaced without losing its soul or opening a new unrelated conversation.

### Files

**NEW:** `crates/freshell-agent-runtime/` for reusable provider runtime logic; supervisor modules `recovery.rs`, `resume_catalog.rs`, `checkpoints.rs`; host modules `providers/{claude,codex,opencode,cli}.rs`; `docs/development/runtime-provider-capabilities.json`; `test/runtime/gates/phase-3.test.ts`; `test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts`.

**MODIFY:** R04/R07/R08 provider implementations; `crates/freshell-platform/src/resume_gate.rs`; R06/R11 lease/auto-resume; `identity_sink.rs`; actual create paths in `freshell-ws`, `freshell-freshagent`, terminal API and MCP bridge. Move shared logic into the new lower-level crate rather than copying several thousand lines into a host-specific fork. Dependency direction is protocol → runtime/client → server/host; the provider core cannot depend on HTTP server startup or UI stores.

### P3.1 — inventory every provider/mode and launch doorway

Generate a checked-in capability manifest from current provider registrations. Minimum expected matrix at the inspected base:

| Provider/mode | Hosting work | Recovery operation |
|---|---|---|
| Claude CLI terminal | PTY + native CLI identity hooks in host | Explicit native ID resume, preserving home/cwd/options. |
| FreshClaude | Node SDK bridge, request/approval maps, query lifetime in host | SDK resume with explicit saved session ID; verify returned identity. |
| Kilroy fresh-agent mode | Its complete configured SDK/runtime variant in host | Preserve runtime variant/bundle/configuration as well as its native session ID; prove with its actual enabled runtime. |
| Codex terminal | Managed app-server, proxy/TUI plumbing, and PTY in one owned host boundary | Resume recorded thread; no proxy/TUI path may mint a replacement thread during recovery. |
| FreshCodex | App-server transport, notifications, turn/approval state in host | `thread/resume` of exact thread; reject wrong ID. |
| OpenCode terminal | PTY plus any local serving backend launched for that agent | Explicit session selection in the same persistent provider-store namespace. |
| FreshOpenCode | One `opencode serve` per soul, event reader and session adapter in host | Load exact existing session and append future prompts to that ID. |
| Amplifier terminal | Existing bundle/environment and CLI launch logic in host | Existing explicit native resume contract, verified against the actual pinned binary. |
| Any enabled Gemini/Kimi/plugin mode | Generic owned host is mandatory | Implement and test advertised native recovery; absent/unimplemented capability is explicitly classified, never guessed. |

The manifest records real executable/SDK version, supported creation modes/ingresses, durable identity capture point, store scope, read-only probe, native resume operation, zero-turn behavior, checkpoint/export capability, bootstrap requirements, error mapping, and tested gate cases. Do not invent resume flags. Use the repository adapters and current actual binaries/specs. Claude, Codex, and OpenCode official documentation describe the distinct resume/session APIs, but only the pinned live tests authorize a version-specific contract. [W04, W05, W08]

List all **Freshell-managed runtime creation** sources: browser picker, split, history resume, WS create/attach, REST tab/split, MCP new-tab/split, restore/reconcile, auto-resume, and any product action that explicitly requests another independently managed agent. Each of those must invoke the same supervisor operation. Do **not** classify a provider's internal subagent, child thread, or native conversation fork as a new Freshell soul merely because the provider calls it a child/fork. Provider-internal topology remains owned by the parent soul and consumes the parent's enclosure/budget unless the product explicitly asks Freshell for an independently managed runtime. Add structural tests and a manually reviewed spawn-site inventory so no actual managed-runtime creation path bypasses ownership or limits.

### P3.2 — move the complete provider conversation machinery

For Claude/Kilroy, move Node bridge stdin/stdout ownership, pending permissions/questions, provider request correlation, and ongoing SDK query into the session host. Web socket disappearance cannot close Node stdin. For Codex, move the app-server connection, subscriptions, command correlation, and terminal proxy control together. For OpenCode, remove shared-server ownership for managed souls: one serving process and one scoped persistent state home per agent, even if views are shared.

Keep a single provider writer when switching between terminal and fresh-agent presentations. Reuse the same runtime's projections when supported; otherwise perform an explicit stop-and-resume incarnation transition. Never launch a second client that creates/resumes a competing writer on the same thread merely to render a second view.

Keep provider execution topology separate from Freshell lifecycle topology. Native subagents and child threads are projections of the parent provider runtime, not independent souls; surface them from the host-owned provider snapshot and keep their work inside the parent cgroup/resource reservation. A provider-native conversation fork is likewise a semantic session operation unless the user explicitly requests a separately managed Freshell agent. Only that explicit independent-agent operation allocates another soul, reservation, host, and stop/recovery lifecycle. Never create a second managed soul merely to preserve parity with a provider's naming or wire shape.

For provider-native fork, preserve the same soul and incarnation while transitioning native session identity. The host must durably fence the request before dispatch, retire the old native provider session before reporting success, and the supervisor must atomically move the writer claim to the child identity while invalidating the parent's resume/checkpoint proof. A lost acknowledgement after provider acceptance is an explicit ambiguous-operation state and must never trigger automatic re-dispatch. Every attached or later-reconciled view of that soul converges to the current native branch. Provider child-thread/subagent metadata remains nested provider state and must not synthesize `soulId` values.

Agent-required local services must also survive web replacement. Put provider approval handling and durable tool results in the host. Move needed Freshell tool operations to a capability-scoped supervisor/host tool router backed by durable inventory. Pure UI-only operations may return a typed transient dependency failure while web is unavailable; they must not hang indefinitely or be silently replayed after uncertain side effects. Keep user approval policy intact; a disconnected user does not grant approval.

### P3.3 — capture recoverability, not just an ID

`ResumeSpec` must include schema version, provider/mode/runtime variant, native ID and provider-store ID, persistent volume reference, canonical cwd/workspace profile, model/effort/permission settings needed for continuation, pinned compatible image/provider version, identity provenance, latest verified durable position, supported checkpoint/restore references, and credential **references**. Host-specific paths are not interchangeable with provider-store identity.

Persist allocation and durability as separate milestones: `ALLOCATED`, `MATERIALIZING`, `VERIFIED_DURABLE`, `DEGRADED`. Continue to publish honest status while a zero-turn session is not yet durable. A zero-turn ID or `ephemeral:false` is not proof that a usable transcript exists (R15). Do not inject paid synthetic turns just to manufacture a checkpoint.

Before first provider dispatch, write the user's accepted input into the protected command journal. A pristine creation seed is recoverable only if the journal proves dispatch never occurred. If dispatch may have occurred but native state vanished, classify the input/side effects as ambiguous and inspect recoverable evidence; do not claim empty-agent reconstruction preserved a conversation.

Persist identity updates before announcing them to the web client. If local provider identity exists but registry persistence fails, keep the existing live host when safe, mark durability degraded, retry bounded persistence, and reject actions requiring a false durable guarantee. Do not discard the only remaining live conversation to satisfy a status flag.

### P3.4 — implement typed recovery probes and the full ladder

Return explicit probe results:

```text
ReattachReady(handle, protocolVersion)
ResumeReady(resumeSpec, evidenceRevision)
PristineSeedReady(seed, neverDispatchedProof)
DefinitivelyUnavailable(path, reason, evidence)
Blocked(path, reason, retryHint, evidence)
```

Treat authoritative absence as distinct from parse errors, permission errors, timeouts, and missing/unmounted stores. Native resume validation may need a provider process: any probe runtime must itself be owned and limited, and must not become a second session writer. Use read-only native APIs or a consistent copy for validation where available. If no non-mutating probe exists, record that limitation and only perform writer-opening resume after the previous writer is confirmed stopped.

Implement the ladder in B as a state machine, with one serialized recovery transaction per soul. Validate compatible snapshots using provider-supported export/checkpoint APIs or consistent stopped-state backups. Never copy a live SQLite main file without its transactional state and call the copy a valid OpenCode checkpoint. Never overwrite the sole surviving provider state with a speculative repair. Restore into a separate validated staging volume, retain the source, and promote only after identity/continuation proof.

If native history remains but no implemented reader/importer can recover it, that is `BLOCKED_RECOVERY_IMPLEMENTATION`, not `LOST`. Do not promise that capturing an ID makes a soul immortal: the actual durable state and compatible execution environment must remain available.

### P3.5 — automatic replacement, no competing restart loops

For desired-running failed incarnations with a valid path: compare the current intent revision, fence commands, commit the recovery/stop reason, terminate and verify the old enclosure, acquire the materialized-session writer claim, create a new incarnation, resume, verify native identity, commit the binding, and publish one inventory transition.

Keep the same `soulId`, pane identity, title, cwd and resource profile. Record old/new incarnation lineage. Retire R11 auto-resume and R06 lease reapers for managed sessions; their callers delegate to this single state machine. A delayed old provider event cannot rebind the old incarnation after replacement.

Use the existing two fast retry delays of 2 and 10 seconds as initial policy, with a persisted five-successful-recoveries-per-hour flap ceiling consistent with R11. Counters survive web/supervisor restart. Retry exhaustion becomes `BLOCKED_RETRY_BUDGET`; manual Retry or a recorded dependency repair can rearm it. Never call it lost, silently bump limits, or start an infinite crash loop.

Successful resume restores the conversation and permits a follow-up. It does not automatically resend the interrupted user prompt. If the native provider can safely continue an existing turn, use its documented semantics and verify them; otherwise show the interrupted/ambiguous state and wait for new input or explicit continuation.

### P3.6 — remove fresh-session substitution from automatic recovery

Add an explicit recovery intent to the resume gate so managed recovery cannot return `SpawnFresh`. Keep existing deliberate “New agent” UX separate. Tests must traverse each relevant actual caller, including REST/MCP/WS paths, not merely test the pure enum.

A definitively missing primary transcript triggers remaining recovery candidates, not immediate loss. A successful resume returning the wrong native identity triggers cleanup of that newly owned failed attempt and a blocked/diagnostic result; it never overwrites the soul's identity. New conversation creation requires a distinct user action/new soul, except the proven pristine-seed case.

### Gate 3 — required live cases, plus Gates 1–2

| Case | Procedure | Pass assertion |
|---|---|---|
| P3-G01 | For every enabled provider/mode in the manifest, create through its actual Freshell UI/API path, complete a turn, and verify native durability. | Actual provider binary/SDK used; version recorded; exact native ID and scoped state captured; no skipped enabled mode. |
| P3-G02 | Store a random 128-bit nonce in a completed conversation, then stop the web client, make its owned host unreconnectable, restart web, and let recovery run. Ask for the prior nonce without including it in the new prompt or workspace files. | Old enclosure verified empty before replacement; new incarnation, same soul/native conversation; live follow-up returns nonce; provider trace shows no tool read used to recover nonce from test files. |
| P3-G03 | Kill the provider process while host survives; separately kill the host while native state persists. Run for every enabled provider family. | Automatically resumed native session; correct resource profile; only one writer; no user action needed to begin resurrection. |
| P3-G04 | Delete the primary state only in an isolated synthetic test soul with a verified provider-compatible backup/checkpoint. | Backup recovery tried before loss; source evidence retained; correct history/native lineage; no unrelated fresh conversation. |
| P3-G05 | Force expired credentials, rate limit, provider outage, unreadable/missing mount, incompatible binary, and retry exhaustion; then repair the dependency. | Remains `BLOCKED`, never lost; state preserved; repair leads to the same soul's native resume without needing a blank replacement. |
| P3-G06 | Return the wrong native ID from a fixture resume and exercise each managed caller through the former `SpawnFresh` policy. | Wrong ID rejected, failed attempt safely removed, original identity retained; no fresh-session fallback or silent success. |
| P3-G07 | Restart before zero-turn materialization, after input journaling but before dispatch, and in the dispatch/ack gap. | Proven pristine seed/queued input can recover; dispatched-ambiguous input is not replayed; no allocated ID is misreported as durable. |
| P3-G08 | Deliver concurrent restore/create requests, race user Stop with resume, and restart supervisor during replacement. | At most one writer; stop intent wins; no activation before old runtime verified empty; stale events cannot resurrect old bindings. |
| P3-G09 | Open two managed OpenCode souls and stress/kill one; repeat with Codex terminal plus a second view. | OpenCode processes/budgets are independent; second soul unaffected; second view does not launch a second provider writer. |
| P3-G10 | Leave a real provider permission prompt/tool in progress, restart web and supervisor, and resolve the prompt on reconnect. | Pending decision survives same-host restart; no accidental approval; tool completes once; no provider dependence on dead web-owned stdin. |
| P3-G11 | Cause repeated resumable crashes and restart controllers between attempts. | Persisted retry/flap bounds hold; paused but resumable soul is blocked, not lost; repaired/manual retry reuses the same conversation. |
| P3-G12 | Exercise every supported ingress in the generated doorway matrix, including MCP and API creates without a connected browser. | Exactly one supervised/limited runtime per requested soul; zero managed calls to legacy spawn/kill/auto-resume sites. |

**Live-provider policy:** fixture protocols are required for deterministic impossible-to-request faults, but cannot replace P3-G01–03's real coding-agent proof. Certification tests semantic product invariants, not a synthetic cross-provider artifact shape: use the strongest trustworthy native evidence each pinned provider actually exposes (for example stable message IDs where guaranteed, or append-only durable record boundaries where IDs are not part of the provider contract). Never modify or wrap a provider solely to manufacture certification metadata. Use actual enabled Kilroy/Amplifier/plugin runtimes; a missing runtime or test credential blocks release of that enabled mode. Explicitly disabled modes are recorded as out of scope, never silently skipped inside an enabled matrix.

**Phase handoff:** complete capability manifest, native-resume receipts and nonce proofs, recovery classifier/error map, one-writer race evidence, and passing Gate 3. No lost-soul reaper is enabled until Phase 5's diagnostic/cleanup gate passes.

## Phase 4 — startup reconciliation and automatic tab reconstruction

**End state:** starting Freshell inventories and recovers desired-running souls before any browser appears. Every such soul then has a usable tab or an honest recovery-blocked placeholder. Existing localStorage, several devices, duplicate reconnects, and explicit close/stop history do not hide agents or create duplicate runtimes.

### Files

**NEW:** `crates/freshell-server/src/managed_runtime_api.rs`; supervisor modules `inventory.rs`, `view_intents.rs`; `src/lib/recovery/managed-runtime-recovery.ts`; `src/components/ManagedAgentRecoveryStatus.tsx`; `src/components/AgentResourceLimits.tsx`; `test/e2e-browser/specs/runtime-tabs-rehydrate-rust.spec.ts`; `test/runtime/gates/phase-4.test.ts`.

**MODIFY:** R09 ledger/reconcile/layout/recovery components; `src/App.tsx`, tab/pane Redux slices and persist middleware; R17 shared/Rust WS schema and generator; server startup readiness; resource/settings schema; `docs/index.html` for the significant UI change. Reuse the existing pane-recovery builders, rather than creating a second renderer with different close semantics.

### P4.1 — implement controller-first startup reconciliation

Start supervisor recovery independently of the web server. Web startup requests a snapshot and subscribes to versioned inventory changes. For each desired-running soul, join registry intent, exact known Docker handles, authenticated host inventory, provider recovery evidence, and current pane/tombstone records.

Do not use browser registration as the authority that keeps a soul alive. Do not wait 30 minutes for a browser to claim a managed agent before deciding whether it deserves recovery. Browserless REST/MCP agents must be discoverable too.

Separate web liveness from managed readiness. `/api/health` remains a web liveness check; add an authenticated runtime-readiness surface showing inventory revision, initial-scan state, and blocked subsystems. The UI may connect while individual souls recover, but managed creation/restoration is held until their reconciliation verdicts are available. Failed scanning is an explicit degraded/blocking state, not an empty successful inventory.

### P4.2 — persist view intent and bridge the existing ledger

Add a `view_intents` table with soul, owner/workspace, preferred tab/pane IDs, title, layout placement hint, visibility intent, and monotonic revision. Enforce one **automatic primary recovery placement** per `(owner, workspace, soul)`; additional explicit views remain allowed.

Use a durable outbox to project supervisor identity/view changes into the pane ledger/tab persistence. The SQLite registry and existing ledger files are not one transaction: commit the outbox alongside the soul transition, consume idempotently, write the ledger durably, then acknowledge. Retry interrupted projection. Before projecting, recheck current intent/tombstone revision so an older event cannot recreate a stopped agent.

When a live/resumed soul has a valid existing pane association, restore it in place. When the association is absent or irreparably conflicts, create a deterministic recovered pane/tab placement and title in a **Recovered agents** group. Derive automatic placement IDs from the stable owner/workspace/soul key or persist generated IDs once; never derive them from server boot or incarnation IDs.

The server's required managed-view set is authoritative. Old whole-layout browser snapshots may not erase newly recovered agents merely because they lack them. Merge against revisioned view intent; preserve the user's other tabs and layout rather than replacing the entire workspace.

### P4.3 — extend the public contract compatibly

Add optional `soulId`, `incarnationId`, `runtimeState`, and resource/recovery summary fields to managed pane/terminal/fresh-agent projections. Add negotiated `managedRuntimeV1` capability to the handshake. Update the shared Zod source, regenerate the contract with existing `npm run contract:generate`, update Rust representations, and add backward/forward roundtrip tests. Do not change legacy mandatory fields or silently bump the whole wire protocol without a compatibility decision/test.

Add authenticated, installation/owner-scoped routes:

```text
GET   /api/runtime/souls?workspaceId=<id>
GET   /api/runtime/souls/<soulId>
POST  /api/runtime/souls/<soulId>/retry
POST  /api/runtime/souls/<soulId>/stop
PATCH /api/runtime/souls/<soulId>/limits
GET   /api/runtime/incidents/<incidentId>/summary
```

Mutating requests include `requestId` and expected intent/revision for conflict detection. Never accept raw Docker/PID handles from the browser. Do not expose private registry paths, provider credentials, or unrestricted incident payloads. Keep `GET /api/recovery/inventory` compatible by adding a managed section or linking its managed inventory revision; avoid contradictory liveness answers from two implementations.

Old clients/Node servers without the capability retain legacy behavior. Do not allow an old client's generic restore-create to accidentally spawn a new unmanaged runtime for a managed soul: reject the unsafe request with a clear upgrade-required error or supply a proven compatible read-only projection. Test this explicitly.

### P4.4 — always reconcile the managed set on the client

Run the managed recovery subscriber regardless of `hadPersistedLayoutAtBoot`. Keep the historical recovery-offer dialog's current eligibility for non-managed historical layouts. These are two different jobs; removing the gate globally would create unwanted historical recovery prompts.

Render these states distinctly: **Reconnecting**, **Restarting agent**, **Recovery blocked: <brief reason>**, **Ready**, and **Stopped**. Show the same soul's prior transcript while resuming, not a blank conversation labeled as ready. A blocked soul remains represented even if resource admission or provider availability prevents an active process.

Preserve existing titles, pane splits where valid, cwd, provider/model settings, and tab order. Avoid stealing focus when recovered tabs arrive; add them visibly and show a small recovered-count status. Busy/completion/approval state uses the hosted provider's authoritative events; rehydration must not synthesize a turn-complete chime.

### P4.5 — close, detach, stop, and cross-device behavior

Keep `Close view` and `Stop agent` separate. Explicit stop commits `desiredState=STOPPED`/tombstone before acknowledging the UI. Closing a view that intentionally leaves an agent running keeps the soul desired-running; under the requested all-live-agents-visible startup policy, it may reappear as a recovered view at the next startup. Explain that behavior in the UI rather than treating close as a hidden stop.

A stopped historical soul stays in history but is not auto-started or auto-tabbed. An explicit user Resume can create a new intent revision for that same soul after validating its native history; generic browser restore cannot clear the stop tombstone.

Two devices may display the same soul, but neither creates another runtime or steals the other's pane identity. Deduplicate automatic placements per device/workspace projection while keeping one canonical server view intent. A user with several existing intentional views does not lose them; automatic recovery only ensures at least one appropriate representation.

### P4.6 — resource settings and recovery actions

Expose per-agent configured CPU/memory/PID limits and a clear effective-enforcement indicator. Show actual incarnation usage separately from the logical conversation. Validate edits server-side, persist them, and report whether they take effect now or at the next incarnation. Do not infer limits from a browser-only field.

Retry on `BLOCKED` reevaluates the saved recovery paths with the same soul, respecting stop revision and budget. It is not a New Agent action. A separate New Agent action creates a new soul and never overwrites the blocked/lost history.

Use accessible roles and labels for recovery status, limits controls, Retry, Stop Agent, and any incident-details affordance. Tests interact through roles/names; add semantic controls rather than brittle CSS-only selectors.

### Gate 4 — required live browser cases, plus Gates 1–3

| Case | Procedure | Pass assertion |
|---|---|---|
| P4-G01 | Create multiple real managed agents through REST/MCP with no browser, restart web, then open a fresh browser. | Recovery occurs before browser arrival; every desired-running soul appears in tabs with the correct identity/state. |
| P4-G02 | Keep a nonempty saved localStorage layout, remove one soul's UI association in isolated test state, and restart. | Missing soul receives one recovered view; existing tabs/layout survive; no recovery-offer acceptance required. |
| P4-G03 | Clear browser storage completely, then refresh repeatedly and connect two independent browser contexts simultaneously. | Same souls and native IDs; deterministic recovered views; zero duplicate runtimes/reservations. |
| P4-G04 | Mix live, resumable-dead, resource-blocked, credential-blocked, explicitly stopped, and historical-only sessions. | Live adopted, dead resumable resurrected, blocked visible, stopped/history not auto-started. |
| P4-G05 | Race Stop Agent with startup, resume completion, old ledger outbox replay, and a stale whole-layout snapshot. | Stop revision wins; no active replacement and no resurrected running tab. |
| P4-G06 | Detach a view without stopping, restart, and separately create two intentional views of one soul. | Running detached soul becomes visible again under policy; intentional extra views survive; one runtime total. |
| P4-G07 | Crash during view-intent commit, ledger projection, and projection acknowledgment; restart both controllers. | Idempotent recovery placement; no lost associations, duplicate tabs, or stopped-soul resurrection. |
| P4-G08 | Use real provider conversation history before/after resume; exercise pending approval, busy state, and completion notifications. | History remains visible; correct lifecycle status; no fabricated completion/chime; follow-up actually works. |
| P4-G09 | Simulate supervisor scan failure/unknown schema and recover it while browser remains open. | Explicit degraded/blocked state, not empty success; no automatic destructive cleanup; inventory eventually converges. |
| P4-G10 | Use an old-capability client/legacy Node backend against relevant shared schemas; change limits through the real UI. | No unsafe unmanaged restore fallback; backward contract tests pass; effective limit changes match server policy and survive restart. |
| P4-G11 | Rehydrate at least 50 fixture souls with mixed states and a concurrency cap of four provider starts, plus the enabled real-provider smoke set. | No request-rate restore storm, bounded startup queue, all intended tabs represented, interactive UI; measured timings recorded without dropping slow souls. |

**Phase handoff:** browser traces/screenshots, inventory-to-pane equivalence assertions, tombstone race evidence, updated user-facing mock/docs, and passing Gate 4. Recovery is functional; loss cleanup remains feature-disabled pending Phase 5.

## Phase 5 — genuine lost-soul reaping, forensic observability, and controlled rollout

**End state:** only genuinely unrecoverable souls enter loss cleanup. Exact owned leftovers are terminated, the user gets a brief truthful notice, and a persistent, correlated diagnostic report records what failed and what could prevent recurrence. The release is gated by a cumulative live chaos/negative-safety campaign and a reversible opt-in migration.

### Files

**NEW:** supervisor modules `loss_report.rs`, `notice_outbox.rs`, `migration.rs`, `repair.rs`; `docs/development/lost-soul-runbook.md`; `docs/development/managed-runtime-rollout.md`; `test/runtime/gates/phase-5.test.ts`; `test/e2e-browser/specs/runtime-lost-soul-notice-rust.spec.ts`; `test/e2e-browser/specs/runtime-chaos-rust.spec.ts`.

**MODIFY:** R16 logging extracted into a reusable lower-level crate/module for server/supervisor/host; managed recovery/incident API; UI notices and stopped-pane presentation; runtime compose/launch documentation; test coverage/CI configuration. Keep native transcript files separate from redacted operational logs.

### P5.1 — implement a loss decision certificate

A `LostDecision` cannot be constructed from an exception string or a timeout. Its constructor requires:

* Current soul/intent revision and a failed or absent live-reattach verdict.
* A complete list of applicable recovery paths from the provider capability manifest.
* A definitive-negative evidence record for every applicable path.
* No unresolved identity search, unreadable store, viable checkpoint, missing credential, unknown compatible-runtime requirement, or unimplemented recovery path with credible retained data.
* Separate exact ownership/cleanup eligibility for every leftover runtime.

Recheck intent and current liveness immediately before committing loss. If a previously uncertain host has become controllable, adopt it instead. A late recovered checkpoint/native ID cancels the planned loss before destructive commit. Once a stop/loss action starts, fence old callbacks and complete its state transition explicitly; do not race a new writer into the same store.

A pristine never-dispatched agent remains reconstructable from its saved seed. A plain shell whose live PTY is gone may have no resume path; classify it as a non-resumable terminal, not a failed coding-provider resurrection. It still uses exact owned cleanup and may be included in the user's brief lost-process count. A live controllable shell is never killed merely because it lacks a transcript.

### P5.2 — make incident persistence part of cleanup

Before terminating a truly lost workload, commit a loss incident, the cleanup target/ownership proof reference, and an outbox event. Then execute the P1 stop sequence. After verified empty, commit final cleanup outcome and a success notice. If cleanup fails, retain the records, show a brief cleanup-failed notice, and retry only the exact owned target under bounded policy.

No notification can say “cleaned up” while cleanup is pending, refused, timed out, or merely signaled. If a soul is irrecoverable but no process remains, do not count it as a process that was cleaned up; use an ended-state explanation if the user had a visible view.

Unknown-ownership objects are quarantined from destructive automation. A malformed/missing registry does not license scanning or killing lookalike processes. Read-only repair tooling may reconstruct authority only from independently verified protected launch receipts; it must present unresolved objects as blocked. Do not claim retroactive ownership over legacy sessions based on transcript discovery.

### P5.3 — structured logs that support an actual explanation

Emit machine-readable JSONL to both the service log and an installation-scoped durable incident store. Use the existing redaction/rotation behavior R16, generalized for every process role. Loss reports are always enabled and survive ordinary web restarts. Use an outbox so temporary sink failure cannot erase an already committed incident; retry export later. If neither registry nor incident intent can be durably written, block automated loss cleanup and emit an emergency error; do not perform silent destructive maintenance.

Every report contains the following fields (use explicit schema/versioned structures, not one opaque message):

```json
{
  "schemaVersion": 1,
  "event": "soul.loss.finalized",
  "incidentId": "uuid",
  "correlationId": "uuid",
  "installationId": "uuid",
  "soulId": "uuid",
  "provider": "claude",
  "providerStoreId": "opaque-id",
  "nativeSessionRefHash": "sha256",
  "intentRevision": 7,
  "incarnations": ["old-incarnation-id"],
  "builds": {
    "webCommit": "sha",
    "supervisorCommit": "sha",
    "hostImageDigest": "sha256:...",
    "providerVersion": "actual-version",
    "protocolVersion": 1,
    "registrySchemaVersion": 1
  },
  "timeline": [
    {"seq": 1, "at": "ISO8601", "event": "last_verified_checkpoint", "evidenceRef": "..."},
    {"seq": 2, "at": "ISO8601", "event": "incarnation_exit", "exitCode": 1, "oomKilled": false}
  ],
  "recoveryPaths": [
    {"path": "reattach", "verdict": "definitive_negative", "reasonCode": "...", "evidenceRef": "..."},
    {"path": "native_resume", "verdict": "definitive_negative", "reasonCode": "...", "evidenceRef": "..."},
    {"path": "checkpoint_restore", "verdict": "definitive_negative", "reasonCode": "...", "evidenceRef": "..."}
  ],
  "decision": {
    "state": "LOST",
    "reasonCode": "all_applicable_recovery_paths_definitively_unavailable",
    "unknownPaths": 0,
    "retainedRecoverableEvidence": false
  },
  "cleanup": {
    "ownedHandleRef": "protected-registry-reference",
    "ownershipVerified": true,
    "gracefulAttempt": "timed_out",
    "forcedAttempt": "completed",
    "verifiedEmpty": true,
    "verifiedAt": "ISO8601",
    "foreignObjectsTouched": 0
  },
  "analysis": {
    "observedCause": "native provider state missing after last verified checkpoint",
    "missingInvariant": "checkpoint retention did not cover the lost artifact",
    "hypotheses": [],
    "preventiveAction": "retain a verified provider-compatible checkpoint before rotating the sole artifact",
    "regressionCase": "P5-G02"
  },
  "notice": {"noticeId": "stable-id", "deliveryState": "pending"}
}
```

This is an illustrative schema; actual reports contain every applicable path, each attempt/duration, before/after states, latest known successful transition, requested/effective resource limits, backend errors, receipt hashes, and cleanup verification. Include provider-store existence/readability and consistent backup metadata so “missing state” can be distinguished from “failed to read state.”

Separate facts, hypotheses, and recommended prevention. When the root cause is unknown, say `unknown` and record the missing evidence. Do not generate a convincing fictional explanation. Do not log prompts, credentials, approval secrets, full environment dumps, or raw provider errors without redaction. Preserve forensic references/hashes without duplicating confidential transcripts into operational logs.

Keep incidents outside the short rolling service-log window: initially retain 90 days or 1,000 closed incidents, whichever policy is reached first, with a 100 MiB incident-summary budget and warnings before rotation. Open incidents and unresolved cleanup records are not silently evicted; saturation blocks optional new launches/log-heavy work and raises a storage fault. Provider transcripts/checkpoints follow their separate documented retention policy and are never pruned by the incident logger. These defaults are reviewable configuration, not an excuse to delete source evidence during repair.

### P5.4 — brief notices, durable delivery

After one or more verified cleanups, use:

> Found and cleaned up 2 lost agent processes. Details are in the server logs. Reference: ABC123.

Count lost managed runtimes/root processes, not an unstable enumeration of every descendant. For failed cleanup:

> Found a lost agent process, but cleanup could not be completed. Details are in the server logs. Reference: ABC123.

Coalesce a startup batch but retain individual incident IDs in its durable record. Notification IDs are stable across reconnects. Browser rendering deduplicates delivery using the stable notice ID and a durable per-profile receipt; acknowledge/dismissal state also persists per user. Reconcile receipts after reconnect so a web-server restart does not repeat a notice indefinitely. Clearing that browser's receipt storage before the server receives an acknowledgment can cause a repeat; do not claim impossible global exactly-once visual delivery across that boundary. If no browser is connected, queue it for the next connection. Do not claim transport-level exactly-once delivery; implement at-least-once transport with idempotent display.

For a previously visible lost agent, retain a compact ended pane with its old title and an explanation. Do not erase history or silently swap it for a new agent. An optional Details action exposes only a redacted incident summary; the full analysis remains available in durable server/supervisor logs.

### P5.5 — metrics and regression feedback

Add counters for recovery outcomes (`reattached`, `resumed`, `restored_checkpoint`, `recreated_pristine`, `blocked`, `lost`), lost reason categories, cleanup outcomes, duplicate launches prevented, rejected foreign-target operations, effective-limit failures, OOMs, and recovery duration. Use bounded label sets: never put soul IDs, PIDs, or arbitrary error text in metric labels.

For every unexpected lost-soul incident encountered during implementation, add a deterministic regression fixture reproducing its failing durability transition. Record the new test ID in the incident analysis. A release must have zero unexplained genuine-loss events in the normal live-provider recovery campaign; intentionally induced loss cases are distinguished by test-run IDs.

### P5.6 — migration and rollback

Ship three explicit feature states: `legacy`, `managed-opt-in`, and `managed-default`. Enable new ownership only for newly launched managed souls. Import legacy **conversation metadata** read-only for user-requested resume; do not adopt/kill legacy OS processes from names/tags. Existing legacy sessions remain marked as such until they exit or an explicitly approved stop/resume migration is performed.

A rollout script performs dry-run inventory, controller/limit preflight, image/version verification, registry backup via a consistent database backup mechanism, and a resource-budget preview. It must not restart the live self-hosted server until Dan explicitly supplies `APPROVED`. Do not create a PR until separately authorized. In this planning task, neither action is authorized or performed.

Rollback changes the web binary/feature policy but leaves current managed hosts and compatible supervisor available. Never roll back by deleting the supervisor DB, switching managed souls to legacy process ownership, or `docker compose down` of all runtime containers. Keep protocol compatibility for at least the immediately preceding released host version. Unknown-newer schemas stay untouched/read-only and block mutation. To remove managed infrastructure, require an explicit drain/stop operation and verify each owned runtime independently before retiring it.

Retain the Linux/non-Linux and Rust/Node capability distinction in docs and UI. Unsupported installations must not advertise hard limits/persistence that have not been implemented and gated.

### Gate 5 — required live/chaos cases, plus all earlier gates

| Case | Procedure | Pass assertion |
|---|---|---|
| P5-G01 | For each enabled real provider family, preserve its native state while making the old runtime unusable, then restart web/supervisor. | Native recovery succeeds; zero lost notices; old owned workload cleaned before replacement; real follow-up works. |
| P5-G02 | In an isolated real-provider test soul, remove its primary resumable state **and every registered checkpoint**; retain only non-resumable diagnostic metadata/hashes, not an undisclosed usable transcript backup. Leave an owned non-reconnectable worker. | Only after all applicable definitive negatives: loss committed, exact owned enclosure reaped, non-resumable diagnostic evidence/incident retained, brief notice displayed. No credentials/real user state touched. |
| P5-G03 | Provide each recoverable alternative: healthy host despite missing disk state, native resume, valid older checkpoint, uniquely attributable recovered identity, pristine seed. | None classified lost; correct path wins; live last-copy host is not destroyed just for missing checkpoint. |
| P5-G04 | Make provider stores unreadable, registry corrupt, credentials absent, protocol too new, workspace missing, or a recovery adapter temporarily unavailable. | All blocked, never lost; no unsafe cleanup; repairing prerequisites restores the same souls. |
| P5-G05 | Create foreign sentinels with copied names/argv/env/tags/labels and a container replacing a deleted one's old name; inject stale records and daemon-ID mismatch. | Zero foreign-target destructive API attempts and zero foreign signals; all sentinels alive until the test owner's separate teardown. |
| P5-G06 | Fail graceful/forced stop, pause the runtime, disconnect Docker during verification, and fail incident export. | No false cleaned-up notice; record/claim retained; outbox survives; eventual verified cleanup produces one correct notice. |
| P5-G07 | Crash after loss intent, after stop, after verified-empty, after notice enqueue, and after browser render but before ack. | Idempotent cleanup; stable incident/notice IDs; no duplicate notice in a profile retaining its receipt, and no new incarnation; pending notice reaches the next browser. A separately tested cleared-receipt/undelivered-ack case may redeliver the same incident, never repeat cleanup. |
| P5-G08 | Inject synthetic tokens/cookies/secrets into provider errors; rotate logs and restart all web/supervisor services. | No secret in any output artifact; durable incident still reconstructs the full decision/cleanup timeline; cause vs hypothesis clearly separated. |
| P5-G09 | Run 100 fixture-backed web restart/failure cycles, 20 supervisor cycles, and controlled host/provider crashes across mixed souls. Include one active long tool and one pending approval in the real-provider smoke subset. | No duplicate writers, hidden desired-running souls, unbounded retry loops, false loss, growing orphan counts, or unrelated interruption. Record all resource/queue measurements. |
| P5-G10 | Run a 30-minute mixed fixture soak with CPU/memory/PID pressure confined to one runtime, repeated client disconnects, 50 desired souls, and bounded output. | Control-plane remains responsive under the configured admission budget; resource/spool bounds hold; cleanup returns to baseline. Durations are test specifications, not delivery promises. |
| P5-G11 | Dry-run migrate legacy metadata, perform an approved test-only migration, then roll the web binary back to the previous compatible version. | Legacy foreign processes untouched; managed runtime remains controlled/visible or explicitly upgrade-blocked; no DB downgrade/reset and no mass stop. |
| P5-G12 | Run final non-fault release images, the full enabled-provider/ingress matrix, all earlier gates, and affected existing regression suites. | Every required case actually ran and passed; no enabled provider skipped; no fault hooks; zero unexplained loss events; independent ownership-after audit shows only intended surviving test sentinels before their explicit teardown. |

**Release handoff:** cumulative gate report, pinned provider/image capability manifest, audited launch/kill-site inventory, redacted sample incident and browser notice, exact rollout/rollback commands, and explicit outstanding approvals. A passing test campaign permits proposing rollout; it does not itself authorize a production restart.

## Concrete implementation layout and small-agent work order

The five phases above remain the only phases. This section resolves scaffolding choices inside their numbered tasks.

### Crate/module ownership

| Deliverable | Files to establish first | Allowed responsibility/dependency direction |
|---|---|---|
| `freshell-runtime-protocol` | `src/{lib,ids,messages,errors,limits}.rs` | Plain versioned types and validation; no Docker, SQLite, provider process, HTTP startup, or UI dependency. |
| `freshell-supervisor` | `src/{main,lib,registry,ownership,launch,stop,ipc,outbox}.rs`; `src/backend/{mod,docker}.rs`; `migrations/0001_registry.sql` | Depends on protocol and backend libraries. Sole runtime ownership/launch/stop authority. Later add admission, recovery catalog, view-intent, checkpoint, and incident modules in their assigned phases. |
| `freshell-session-host` | `src/{main,lib,bootstrap,control,pty,command_journal,output_journal}.rs`; later `src/providers/` | Owns one incarnation's PTY/provider connections. Depends on protocol, extracted PTY primitives, and provider core. Never depends on the supervisor database or web-server binary. |
| `freshell-runtime-client` | `src/{lib,connection,subscription,requests}.rs` | Typed reconnecting IPC client for the web facade; no direct Docker access and no independent recovery policy. |
| `freshell-agent-runtime` | `src/{lib,events,capabilities,claude,codex,opencode,cli}.rs` | Reusable provider transport/conversation logic extracted from existing implementations. Can use existing provider protocol/transport libraries, but not `freshell-server` or browser-state stores. |

Do not duplicate ownership repositories in web and host. Extract any required PTY primitive below `TerminalRegistry` before introducing a dependency cycle. Compile after each extraction with behavior unchanged; then substitute the hosted implementation behind the feature gate. Generated wire types and provider-specific structs remain separate.

### IPC operations to implement in order

Use protocol version 1 and distinct `WebControl`, `HostEvents`, and `SupervisorToHost` method enums. The following names are the new internal contract, not existing Freshell public endpoints:

| Role/direction | Methods | Required safety inputs |
|---|---|---|
| Web → supervisor | `CreateSoul`, `GetSoul`, `ListSouls`, `SubscribeInventory`, `RetryRecovery`, `StopSoul`, `SetLimits` | Authenticated installation/owner; request ID; expected intent revision for mutations; approved workspace/profile references, never raw mounts or Docker handles. |
| Host → supervisor | `RegisterHost`, `IdentityObserved`, `DurabilityObserved`, `CommandOutcome`, `ProviderExited`, `ResourceObservation` | Incarnation-scoped authentication; expected host boot and execution generation; monotonically ordered event identity. Host events report facts, not authority to stop another workload. |
| Supervisor → host | `GrantExecution`, `DescribeRuntime`, `Snapshot`, `SubscribeOutput`, `SendInput`, `Resize`, `Interrupt`, `ResolvePermission`, `PrepareStop` | Current controller epoch; incarnation/host boot; intent revision where relevant; request/event cursor; explicit permission-request identity. |

Expose only the minimum subset for each phase. Unknown methods/fields are handled by the versioned compatibility policy; never coerce an unknown command into a generic shell execution. Health inspection and provider bootstrap are not permission to dispatch user input. Persist secrets only in protected installation or incarnation-scoped state, never generated source files or command-line logs.

### Decomposing provider work without changing the acceptance criteria

For each row of P3.1, execute the same sequence as small commits: (a) capture existing request/event contracts in failing tests; (b) extract transport and conversation state without behavior changes; (c) connect host construction and disconnect behavior; (d) implement durable identity/probe/error mapping; (e) implement exact-ID resume and one-writer fencing; (f) connect every applicable ingress; (g) run the provider's real create, continuous-live restart, dead-incarnation resume, and blocked-dependency cases; (h) refactor duplication and rerun the gate. Finish a provider row before beginning the next. A mock protocol test proves step (a), never step (g).

Freeze the enabled-provider and supported-ingress matrix before a gate begins. Configuration changes that remove providers require a separately recorded user decision; an agent may not disable an inconvenient provider to turn a blocked gate green. Each parameterized case expands into stable IDs such as `P3-G02/claude/fresh/ws`. Save expected and actual expanded IDs, and require exact coverage rather than a minimum passing-test count.

## Agent handoff protocol

At the end of each task, leave a short worktree note containing the task ID, changed files/symbols, invariant addressed, failing test before the change, exact green commands after it, commit SHA, evidence directory, and the next task ID. Do not mark a phase complete from unit tests alone. The next agent reads this plan, current AGENTS files, the preceding gate summary, and the capability manifest before editing.

Use these status words consistently: `NOT_STARTED`, `IN_PROGRESS`, `BLOCKED`, `GATE_FAILED`, `GATE_PASSED`. A blocked provider/runner/credential is a concrete prerequisite to resolve, not a reason to alter the acceptance criteria. Do not ask a successor to infer what happened from terminal scrollback.

## Source notes and technical verification

Repository facts above are from the indicated files at the inspected commit. This is a static architecture review plus read-only Docker capability inspection; no test results are implied. The following primary references were checked September 6, 2026. Implementation must validate behavior against its pinned deployed versions, particularly provider identity materialization and native resume APIs.

| Ref | Primary reference and narrow fact used |
|---|---|
| W01 | Docker, **Rootless mode tips — Limiting resources**, `https://docs.docker.com/engine/security/rootless/tips/`: rootless cgroup-related resource flags require cgroup v2/systemd and appropriate controller delegation; unsupported configurations can ignore flags. |
| W02 | Docker, **Resource constraints**, `https://docs.docker.com/engine/containers/resource_constraints/`: CPU/memory/PID settings are explicit; memory-swap is total memory plus swap, and equality with memory disallows swap. |
| W03 | Linux kernel, **Control Group v2**, `https://docs.kernel.org/admin-guide/cgroup-v2.html`: hierarchical resource accounting, process inheritance, CPU quota and memory/PID controls. Its `cgroup.kill` describes whole-subtree kill; this plan uses Docker as cgroup owner rather than writing directly to Docker-owned host paths. |
| W04 | Anthropic, **Work with sessions**, `https://code.claude.com/docs/en/agent-sdk/sessions`: explicit session ID resume, persistence versus in-memory operation, and provider-state/cwd considerations across hosts. Use pinned SDK/CLI behavior, not an assumed current doc feature absent from the installed version. |
| W05 | OpenAI, **Codex App Server**, `https://developers.openai.com/codex/app-server`: initialize handshake and distinct thread start/resume/read operations; `thread/resume` is not a new `thread/start`. |
| W06 | SQLite, **PRAGMA synchronous**, **Write-Ahead Logging**, and **Online Backup API**, `https://www.sqlite.org/pragma.html#pragma_synchronous`, `https://www.sqlite.org/wal.html`, `https://www.sqlite.org/backup.html`: transaction durability configuration and consistent backup requirements. Confirm target filesystem assumptions rather than extrapolating process-crash tests into power-loss guarantees. |
| W07 | Docker, **Volumes — Mount a volume subdirectory**, `https://docs.docker.com/engine/storage/volumes/`: a runtime can mount only its IPC subdirectory; the subdirectory must exist before mounting. |
| W08 | OpenCode, **Server**, `https://opencode.ai/docs/server/`: standalone serving runtime, scoped session APIs, event stream, and generated API schema. Test its actual pinned session/storage semantics. |
| W09 | Docker, **Start containers automatically**, `https://docs.docker.com/engine/containers/start-containers-automatically/`: restart policy is container lifecycle behavior, not permission to replay a provider command. The explicit host-boot execution-grant barrier is this plan's required safeguard. |

## Final acceptance statement

The work is complete only when a live coding agent can survive a web-server restart unchanged; an unattachable but resumable agent is automatically replaced using its real coding-agent history; every desired-running soul is represented in tabs; each workload's resource cap is measurably enforced; an actually unrecoverable soul's exact owned remnants are cleaned up with a brief truthful notice and durable diagnostic analysis; and adversarial lookalike tests demonstrate that no unrelated process is targeted.
