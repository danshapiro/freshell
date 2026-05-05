# Codex Sidecar Lifecycle Architecture Brief

Worktree: `.worktrees/debug-codex-app-server-leak` (branch `debug/codex-app-server-leak`).

## Goal

Freshell always clears dead Codex sidecar sessions at the correct lifecycle boundary, without operator cleanup and without risking live panes.

This is a go-forward lifecycle fix. Historical orphans from the pre-ownership implementation are out of scope for runtime automation and should be handled only by a separately approved one-time cleanup with an exact process list.

## Recommendation

Keep per-terminal Codex sidecars and add real ownership for the whole wrapper/native app-server bundle.

The smallest solid fix is not a global process reconciler and not a rollback to PR298-era shared app-server runtime. It is an atomic change across six already-coupled boundaries:

1. `CodexAppServerRuntime` owns one sidecar process group from spawn through verified teardown.
2. Ownership metadata exists immediately after spawn, before app-server `initialize`.
3. Durable recovery readiness uses candidate-local app-server state, not observer notifications that are not guaranteed for `thread/resume`.
4. Verified teardown failure becomes sticky blocking state for the owner that observed it; later startup, recovery, create, publish, and retry paths must not progress past that ownership until it is verified gone or the server is exiting.
5. Registry retries, recovery publication, final close, and shutdown await sidecar teardown before moving to the next lifecycle state.
6. Server shutdown creates an admission barrier before joining registry and planner shutdown work, so existing WebSocket clients cannot create new Codex sidecars during shutdown.

These pieces must ship together. Process ownership without readiness still leaves users in false recovery loops. Readiness without process ownership still leaks on future startup and candidate failures. Retry changes without initial-create and shutdown coverage leave non-recovery leaks behind. Verified teardown without sticky blocking state only moves the leak to the next lifecycle entry point.

## Current Architecture

Each Codex pane is a bundle:

- a visible worker PTY running `codex --remote <wsUrl> ...`
- an invisible app-server sidecar running `codex app-server --listen <wsUrl>`
- optional MCP temp state
- current generation and durable session identity tracked by `TerminalRegistry`

The sidecar process launched by Freshell is not the long-lived native process. On this installation the command shape is:

```text
node <npm-prefix>/bin/codex ... app-server --listen ws://127.0.0.1:NNNNN
  +-- <npm-prefix>/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex/codex \
       ... app-server --listen ws://127.0.0.1:NNNNN
```

Current code records and signals the wrapper PID returned by `spawn()`. The native child can survive if the wrapper exits hard or is killed while the child keeps running. On the observed machine, orphaned native children reparented to the WSL `/init` shim with a non-1 parent PID from Freshell's point of view, so cleanup or diagnostics must not rely on `PPID == 1`.

## Root Cause

Freshell models the app-server sidecar as a child process, but operationally it is a wrapper/native process group.

Five whys:

1. Why did dead app-server sessions remain? Because `runtime.stopActiveChild()` signals only the spawned wrapper PID and does not prove the native app-server child is gone.
2. Why was Freshell blind after the wrapper exited? Because ownership metadata records the wrapper PID and the reaper removes metadata when that PID no longer exists.
3. Why can a sidecar exist without an ownership record? Because metadata is written only after `ensureReady()` receives app-server readiness; startup, initialize, create, or recovery failures can happen before then.
4. Why did failures multiply? Because per-terminal sidecars plus durable recovery candidates made the latent wrapper/native bug happen once per pane or retry, and the retry loop is intentionally unbounded.
5. Why did killing by process name hurt live panes? Because live and dead app-servers have the same native command shape; deadness was inferred from process name instead of Freshell ownership state.

The second active failure is independent but coupled: durable recovery waits for observer-side `thread/started` or idle `thread/status/changed` evidence after spawning `codex --remote <wsUrl> resume <sessionId>`. The remote TUI owns the `thread/resume` response, and the app-server protocol does not guarantee a `thread/started` notification for resume. The official Codex app-server README documents `thread/loaded/list` for loaded in-memory thread ids and says clients should send `initialized` after `initialize`: <https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>.

## Why Not Revert PR298-Era Architecture

The PR298-era shared app-server runtime would lower process count, but it reopens larger ownership problems:

- A single shared app-server changes the failure domain. One pane's failed recovery candidate cannot be torn down independently without affecting unrelated panes.
- The earlier planner pre-created or resumed Codex sessions before PTY adoption. If terminal creation failed after planning, durable sessions could be orphaned.
- Current recovery logic treats a generation bundle as sidecar plus remote TUI PTY plus MCP state. Shared runtime does not match that boundary.
- Current per-sidecar runtime has fixes worth preserving: cwd/environment scoping, stdio draining, startup retry behavior, and disconnect fatal handling.

The regression after PR298 was not "per-terminal sidecars are wrong." It was "per-terminal sidecars inherited wrapper-only ownership and readiness assumptions that were acceptable only while the blast radius was small."

## Alternatives Considered

### A. Per-terminal sidecars with real bundle ownership

Recommended.

This keeps the current isolation and recovery model while fixing the real resource boundary. Each sidecar gets its own process group, an ownership id, early metadata, and verified teardown. Registry state remains responsible for current/candidate generation decisions.

### B. Roll back toward a shared app-server runtime

Rejected.

This is a larger architectural move than the bug requires. It changes pane isolation, candidate teardown, MCP state coupling, and durable session adoption semantics. It also risks reintroducing pre-created-session ownership bugs from the PR298 era.

### C. Minimal PID-only patch over current classes

Rejected.

Killing and recording only the wrapper PID cannot prove the native child is gone. Adding more retries, warning logs, or runbook cleanup would hide the symptom and leave the failure mode intact.

### D. Global process-name reconciler

Rejected.

Historical sidecars were not launched in their own process groups; a prior snapshot showed leaked native processes in the same process group as the running Freshell server. Runtime cleanup must not scan by command name or assume `/init` parentage means dead.

## Proposed Atomic Design

### 1. Sidecar process ownership

Create a small ownership layer in `CodexAppServerRuntime`. The runtime owns the ownership id, process group, metadata file, and teardown proof because it is the only class that controls spawn and shutdown. `CodexTerminalSidecar` should only enrich the runtime-owned record with terminal/generation/codexHome details and delegate shutdown to the runtime.

The runtime creates an `ownershipId` before spawn and launches the sidecar wrapper with:

- a Unix process group owned by the runtime (`detached: true` on Unix)
- inherited `FRESHELL_CODEX_SIDECAR_ID=<ownershipId>`
- a new-schema metadata file written immediately after successful spawn and before any app-server `initialize` attempt

Minimum metadata fields:

- `schemaVersion`
- `ownershipId`
- `serverInstanceId`
- `ownerServerPid`
- `terminalId` or `null`
- `generation` or `null`
- `wsUrl`
- `wrapperPid`
- `processGroupId`
- wrapper process identity using the existing Linux identity shape: command line, cwd, and start-time ticks
- `createdAt`
- `updatedAt`
- optional `codexHome`

Do not put registry-only state such as `role`, `candidate`, `retiring`, or durable readiness into the process metadata unless implementation proves it is necessary. The registry already owns generation state.

If the metadata write fails after spawn, startup fails and the runtime tears the process group down before retrying. Freshell must not continue with an unowned sidecar. If wrapper identity cannot be read after spawn, that missing identity is itself a startup failure. The runtime still owns the newly created process group by `ownershipId` and `processGroupId`, must not continue to app-server initialize or ready publication with empty wrapper identity metadata, and must attempt verified teardown before any retry.

### 2. Verified process-group teardown

`CodexAppServerRuntime.shutdown()` tears down the process group, not just `child.pid`.

Teardown sequence:

1. Close the app-server client best-effort.
2. Verify the process group still belongs to the ownership record using process group id plus wrapper identity or inherited ownership id on a group member. Wrapper identity proof is valid only when the recorded wrapper PID is currently a member of the recorded `processGroupId`, and the current wrapper identity matches the stored command line, cwd, and start-time ticks. A matching wrapper PID/start time must not authorize signals to a different process group. Ownership-id proof is valid only when the matching process is a member of the recorded `processGroupId`.
3. Send `SIGTERM` to the process group with the Unix group-signal form, `process.kill(-processGroupId, 'SIGTERM')`.
4. Wait until the owned group is gone. On Linux this can be checked with `process.kill(-processGroupId, 0)` returning `ESRCH`, backed by `/proc` group-member scanning when diagnostics need exact remaining PIDs. If `/proc` cannot be read, ownership proof is unavailable; an empty or failed scan must not be treated as evidence that a live process group is gone.
5. If still alive after the grace period, reverify ownership and send `SIGKILL` with `process.kill(-processGroupId, 'SIGKILL')`.
6. Wait until the owned group is gone.
7. Remove metadata only after verified teardown.

If verification cannot prove ownership, throw a structured teardown error and leave metadata in place for diagnosis. The owner enters a blocking teardown-failed state for that ownership. The runtime must preserve the failed ownership record and refuse future `ensureReady()`, `listLoadedThreads()`, `adopt()`, or startup work on that runtime until the ownership is verified gone or the server process exits. Registry and planner callers must treat that error as a failed lifecycle boundary, not as best-effort cleanup.

The teardown-failed state is sticky across asynchronous stimuli. A later wrapper exit, lifecycle-loss notification, retry timer, create request, or shutdown callback must join or report the same failed ownership instead of starting a sibling sidecar that overwrites it.

Sticky teardown failure also means the owner retains a joinable handle. Do not reduce a failed sidecar teardown to only a stored error, log line, or cleared local variable. Runtime ownership, planner-owned sidecars, registry current sidecars, recovery candidates, retiring sidecars, natural PTY-exit shutdowns, and close/shutdown join sets may remove their sidecar handle or shutdown promise only after verified teardown succeeds, ownership transfers to another explicit owner, or the server process exits.

On unsupported platforms, fail clearly before spawning. The Unix implementation may rely on process groups plus Linux `/proc` ownership proof; if the platform cannot provide the proof this design requires, Codex sidecar mode should reject startup before it creates an app-server process. If Windows behavior must be supported in the same PR, stop and design a platform-appropriate owner such as a job object.

### 3. Startup cleanup for new-schema records only

Replace the existing PID-only `reapOrphanedSidecars()` behavior with a new-schema reaper. Startup cleanup should read ownership records written by this fixed implementation. It may reap only sidecars that it can prove are stale and owned:

- the record is new schema
- the owning server process recorded in metadata is gone
- the process group is not Freshell's current process group
- the process group ownership proof still matches the record

Startup reaper failure is a startup blocker, not a warning fallback. If the new-schema reaper throws while reading, verifying, signaling, waiting for teardown, or removing verified-dead metadata, Freshell must fail startup before accepting Codex creates. The same rule applies when the reaper returns unreaped new-schema ownership records.

Unreaped new-schema records are not successful cleanup merely because the recorded `ownerServerPid` is currently live or because the recorded process group matches Freshell's current process group. PID liveness alone does not prove that the original owning server still owns the sidecar; it may be PID reuse or unrelated process state. Current-process-group matches must not be signaled, but unless the reaper has explicitly verified the record is handled by the current server, they are still unreaped new-schema ownership evidence and must block startup.

Legacy metadata should not be used for automatic native cleanup. Old records can be removed if they contain no actionable new-schema ownership, but they must not trigger process-name scans or run through the old wrapper-PID signaling path in parallel with the new reaper. The parser must distinguish records that are not new-schema from malformed new-schema records. If a JSON record declares `schemaVersion: 1` but is missing required fields or has invalid field types, the reaper must leave the file for diagnosis and report it as failed ownership evidence so startup blocks instead of deleting the only durable ownership clue.

### 4. Candidate-local durable readiness

Add app-server protocol support for:

- `initialized` notification after successful `initialize`
- `thread/loaded/list` returning loaded thread ids

After spawning a durable recovery candidate's remote TUI, poll the candidate sidecar's app-server with `thread/loaded/list` until either:

- it contains the expected durable session id and the candidate PTY is still alive, in which case the candidate is ready
- the existing readiness timeout expires, in which case the candidate fails

Keep lifecycle notifications for loss detection:

- `thread/closed`
- documented `thread/status/changed` payloads whose status object has type `notLoaded`
- documented `thread/status/changed` payloads whose status object has type `systemError`

Do not use spawn success, first PTY output, elapsed time, or fake `thread/started` broadcasts as readiness proof.

### 5. Retry and recovery transaction boundaries

Keep recovery retries unbounded. A durable pane should not become permanently dead because an arbitrary attempt budget expired.

Change the transaction boundary:

- at most one active replacement attempt per terminal
- failed candidate PTY is killed
- failed candidate sidecar shutdown is awaited through verified process-group teardown
- failed candidate sidecar teardown failure keeps the unpublished candidate ownership attached to the terminal or registry join set
- retry delay starts only after teardown completes successfully
- failed teardown marks the recovery transaction blocked and prevents later lifecycle-loss notifications from spawning another candidate for the same terminal
- final close clears timers and prevents future recovery starts

The invariant is that repeated failed readiness attempts do not increase the live sidecar process count.

Recovery publication has its own transaction boundary:

1. build an unpublished candidate sidecar and candidate PTY
2. prove candidate readiness with loaded-thread evidence and live candidate PTY state
3. mark the old PTY/sidecar as retiring so its natural exit cannot mark the terminal finally closed
4. retire the old sidecar through verified teardown
5. publish the candidate as current only after the old sidecar teardown succeeds and the candidate PTY is still alive

If old-sidecar teardown fails, the terminal remains in a blocked recovery state with the failed retiring ownership still joinable. The registry must not publish the candidate, forget the failed old ownership, or treat the failure as a retryable candidate failure.

If unpublished candidate teardown fails, the terminal also remains in a blocked recovery state with the failed candidate ownership still joinable. Final close, `terminal.kill`, and graceful shutdown must be able to join or report that same failed candidate ownership instead of depending on a local recovery-attempt variable that can be swallowed or cleared.

The same blocked-recovery rule applies when recovery candidate planning fails before a `CodexLaunchPlan` is returned. If `recovery.planCreate()` or the planner/runtime cleanup it performs fails because sidecar teardown could not be verified, the registry must treat that failure as a recovery teardown boundary, keep the failed planner-owned ownership joinable through the planner/runtime owner, and prevent later retry timers or lifecycle-loss notifications from creating another sibling candidate for that terminal.

### 6. Initial create and unowned-plan cleanup

Apply the same ownership guarantees to non-recovery paths:

- `CodexLaunchPlanner.planCreate()` startup failure
- `runCodexLaunchWithRetry()` launch retry
- WebSocket `terminal.create` failure after planning but before registry adoption
- agent API create/run/split/respawn failure after planning but before registry adoption

These paths may still use existing local ownership transfer variables. The important rule is that a sidecar has exactly one owner at a time: unowned launch plan, initial-create publication candidate, registry current sidecar, or active replacement candidate.

Initial resume-create paths have the same publication proof requirement as recovery candidates. WebSocket `terminal.create` and agent API create/run/split/respawn calls that resume an existing Codex session must publish success only after both candidate-local loaded-list readiness proves the expected session is loaded and the created PTY is still alive immediately before publication. If the remote TUI exits before publication, the create path fails and cleanup covers both the created PTY and the sidecar.

Initial create publication is the boundary where a sidecar may become registry-current and durable-recovery eligible. Before adoption succeeds and, for resume creates, loaded-list readiness plus live-PTY proof succeeds, lifecycle-loss notifications from that sidecar must not start durable recovery for the not-yet-published terminal. A lifecycle-loss event before publication is a create failure and should drive create cleanup, not recovery.

Ownership transfer must be explicit and checked. `CodexLaunchPlanner.adopt()` should fail clearly if the runtime no longer has an active ownership record to enrich, and planner shutdown should only stop sidecars still owned by the planner. Adoption is allowed only while the planner still accepts ownership transfer for that sidecar. If planner shutdown has begun, or if shutdown for that sidecar is already in progress, `adopt()` must reject clearly, leave ownership with the planner, and allow the in-progress teardown to finish. Planner-owned sidecars remain planner-owned after a failed shutdown attempt and are removed from the planner's active set only after verified teardown succeeds or ownership is explicitly transferred by adoption. Once a sidecar is adopted by the registry, planner shutdown must not stop it as if it were still in planning.

Create-failure cleanup is part of the lifecycle boundary. If WebSocket or agent API create/run/split/respawn fails after planning or registry creation, cleanup must cover both the sidecar and any created PTY. If verified cleanup fails, the caller should surface the cleanup failure as the blocking lifecycle error instead of hiding it behind the original create/adopt error.

### 7. Final close and server shutdown

Final close is terminal:

- no new recovery attempt starts
- current timers are cleared
- current sidecar shutdown is awaited
- unpublished candidate sidecar shutdown is awaited
- published candidate sidecar shutdown is awaited
- registry graceful shutdown waits for Codex sidecar teardown before server process exit

It is acceptable for event handlers to schedule async failure handling, but close/shutdown paths must be able to join the pending teardown work. `terminal.kill` is a final-close request: it must await Codex teardown and send a clear protocol error if verified teardown fails instead of allowing the WebSocket message handler to reject without a response.

Final-close and shutdown joins must be all-work joins, not first-error short-circuits. If a recovery attempt, current sidecar shutdown, unpublished candidate shutdown, published candidate shutdown, or tracked shutdown entry rejects, the close/shutdown path still waits for the other pending Codex teardown work before reporting the relevant lifecycle error.

Server shutdown must establish an admission barrier before waiting for Codex teardown. Existing WebSocket clients should be closed or made to reject `terminal.create` before `registry.shutdownGracefully()` and `CodexLaunchPlanner.shutdown()` join existing sidecar work. HTTP agent API routes that can create or respawn Codex terminals (`/tabs`, `/run`, split/respawn flows, and equivalent future create paths) are part of the same barrier and must not publish a new Codex PTY/sidecar after shutdown has started. The barrier applies to in-flight creates as well as new requests: after shutdown begins, WebSocket and HTTP create paths must re-check admission before planning, before registry creation, before adoption, before readiness waits, and before publishing a created terminal. `CodexLaunchPlanner.planCreate()` should reject after planner shutdown begins. Registry shutdown must join Codex recovery attempts and sidecar shutdowns for all terminal records, including records already marked exited, not only records that are running in the first shutdown snapshot.

## Restart Conditions

Stop implementation and redesign if any of these prove true:

- the installed Codex provider lacks `thread/loaded/list` or its response does not reliably show a remotely resumed thread
- the npm shim/native child does not stay in the spawned process group or does not inherit `FRESHELL_CODEX_SIDECAR_ID`
- `initialized` changes provider behavior enough to require compatibility work
- current/candidate/retiring generation state cannot be kept local to the registry without putting registry semantics into process metadata
- Windows sidecar cleanup must be fixed in the same atomic PR and Unix process groups are insufficient

## Test Plan

Use red-green-refactor. Add process-level tests where process behavior is the requirement; keep registry tests mocked where only state ordering matters.

### Runtime and ownership tests

- fake wrapper spawns a fake native child; `runtime.shutdown()` removes both
- fake native child ignores `SIGTERM`; runtime escalates to `SIGKILL` and keeps metadata until the group is gone
- metadata is written immediately after spawn, before app-server initialize
- app-server initialize timeout tears down the failed attempt before startup retry
- metadata write failure after spawn tears down the process group and fails startup
- wrapper identity read failure after spawn is the direct startup failure: force identity lookup to return null without also forcing initialize failure, then assert the owned process group is torn down before retry and startup does not proceed with empty wrapper identity metadata
- inherited ownership id is visible on the fake native child
- startup reaper ignores legacy records, does not signal current-process-group records, and blocks startup for any unreaped new-schema record that is not explicitly verified as handled
- startup reaper removes only verified stale new-schema groups
- startup fails when the new-schema reaper returns unreaped active/skipped ownership records, including live `ownerServerPid` and current-process-group cases
- startup fails when the new-schema reaper throws from ownership verification, process-group signaling, waiting, or metadata removal
- malformed `schemaVersion: 1` ownership records are retained and reported as startup-blocking failures, not deleted as legacy records
- direct-child sidecars still work
- corrupted or mismatched ownership metadata cannot authorize teardown of another live process group: wrapper identity must match command line, cwd, start-time ticks, and current membership in the recorded `processGroupId`; ownership-id proof must come from a member of that same group
- failed process-group teardown leaves runtime ownership in sticky failed state and a later `ensureReady()` does not spawn a new sidecar
- thrown teardown errors, such as signal or metadata-removal failures, also set runtime sticky failed state before propagating
- missing command or child-process `error` rejects startup with a clear launch error and does not crash the server process
- unsupported platforms or missing `/proc` ownership proof reject before spawning a sidecar process
- teardown does not treat a live process group as gone when `/proc` member scanning fails or returns no readable members

### Protocol and readiness tests

- client sends `initialized` after successful `initialize`
- client exposes `thread/loaded/list`
- fake app-server is configured to omit `thread/started` on `thread/resume`
- durable recovery succeeds when `thread/loaded/list` contains the expected session without a resume `thread/started` broadcast
- durable recovery fails when the loaded list never contains the expected session
- durable recovery does not publish a candidate when loaded-list readiness succeeds after the candidate PTY has exited
- initial WebSocket and agent API resume-create paths do not publish or return success when loaded-list readiness succeeds after the created PTY has exited
- initial WebSocket and agent API resume-create paths treat sidecar lifecycle-loss before adoption/readiness publication as create failure cleanup, not durable recovery
- lifecycle-loss detection still reacts to `thread/closed` and documented status-object `notLoaded` and `systemError` payloads

### Registry lifecycle tests

- candidate readiness timeout awaits sidecar teardown before scheduling the next retry
- repeated readiness failures do not increase active fake sidecar count
- recovery `planCreate()` failure caused by failed planner/runtime sidecar teardown blocks that terminal's recovery transaction and does not schedule another candidate over the failed ownership
- teardown failure during recovery records a blocked terminal/recovery state and repeated lifecycle-loss notifications do not spawn another candidate
- unpublished candidate teardown failure remains joinable by final close, `terminal.kill`, and graceful shutdown
- retiring old-sidecar teardown failure is treated as a blocked recovery boundary, not as a retryable candidate failure
- recovery publication proves the candidate PTY is alive immediately before publication
- old PTY exit during retiring does not mark the terminal finally closed or tear down the ready replacement
- final close during pending launch does not start recovery later
- final close with unpublished candidate awaits candidate shutdown
- final close with published candidate awaits candidate shutdown
- final close with a rejecting recovery attempt still joins current sidecar shutdown and tracked candidate/sidecar shutdown entries before reporting the teardown error
- natural PTY exit observes sidecar shutdown failures and keeps them joinable for shutdown
- `terminal.kill` returns a clear protocol error when Codex verified teardown fails
- graceful server shutdown waits for Codex recovery attempts and sidecar shutdown promises for running and already-exited records
- shutdown closes or rejects existing and in-flight WebSocket `terminal.create` before joining registry and planner teardown work
- shutdown rejects or blocks existing and in-flight HTTP agent API Codex create/run/split/respawn work before joining registry and planner teardown work
- HTTP agent API shutdown-admission tests close admission while async provider settings are resolving and assert no `CodexLaunchPlanner.planCreate()` call occurs before rejection for the shared create/run/split/respawn helper paths
- WebSocket create failure after planning awaits sidecar and created-PTY cleanup and surfaces cleanup failure
- agent API create/run/split/respawn failure after planning awaits sidecar and created-PTY cleanup and surfaces cleanup failure
- planner `planCreate()` rejects after shutdown begins
- planner shutdown only stops unadopted sidecars, failed unadopted teardown remains planner-owned and joinable, adoption fails clearly when the runtime has no active ownership to transfer, and a sidecar cannot be adopted after planner shutdown or that sidecar's shutdown has begun

### Integration and provider smoke tests

- fake wrapper/native integration proves retiring app-server process exits and later input uses only the replacement
- default automated test suites contain no `.skip`, `.skipIf`, or early-pass environment gates for required coverage
- real-provider smoke is an explicit opt-in command outside the default suite unless the provider prerequisites are guaranteed in CI; when invoked without prerequisites it fails with a clear prerequisite error instead of passing as skipped
- real-provider smoke starts a real Codex app-server, resumes through the actual `codex --remote <wsUrl> resume <sessionId>` path, observes readiness through loaded-list, shuts down, and asserts no process with the test ownership id remains

Baseline focused checks already run during investigation, before architecture implementation:

```bash
npm run test:vitest -- test/unit/server/terminal-registry.codex-recovery.test.ts test/unit/server/coding-cli/codex-app-server/recovery-policy.test.ts
```

Result: 37 tests passed across 2 files.

## Acceptance Criteria

- A live Codex pane is never reaped because of process name alone.
- Creating a Codex pane either succeeds or leaves no owned wrapper/native app-server process behind.
- Closing a Codex pane removes its owned wrapper/native app-server processes before close is considered complete.
- Failed verified teardown leaves a sticky blocking state and a retained joinable ownership handle; later lifecycle events cannot spawn or publish another sidecar over the failed ownership.
- Server shutdown rejects or closes new and in-flight terminal creation before joining Codex sidecar teardown.
- Restarting Freshell removes only verified stale new-schema sidecars from prior server instances.
- Historical legacy sidecars are not automatically process-killed by runtime cleanup.
- Recovery replacement retires the old generation without touching unrelated panes, and publication only occurs while the candidate PTY is alive.
- A candidate that fails readiness is fully torn down before the next retry starts.
- Retry remains unbounded while the pane exists, but failed attempts are serialized behind teardown.
- Many consecutive recovery failures do not grow wrapper/native process count.
- Durable recovery can become ready from candidate-local loaded-thread proof without a `thread/started` resume broadcast.
- Logs identify `ownershipId`, `terminalId`, `generation`, `wsUrl`, `wrapperPid`, `processGroupId`, and `serverInstanceId` for recovery and teardown events.
