## Harness Requirements

The implementation plan still supports the testing strategy. The only adjustment is to make the remote TUI PTY exit path a first-class acceptance surface, because the observed app-server WebSocket reset can surface to Freshell as PTY process exit rather than only as sidecar/runtime exit. This does not change cost or scope; it uses the planned registry and integration harnesses.

1. **Codex supervisor unit harness**
   - Does: creates `TerminalRegistry` records with mocked PTYs, fake Codex sidecars, fake launch factories, fake timers, event collectors, and test access to emitted terminal output/status/exit events.
   - Exposes: PTY `onData`/`onExit` triggers, sidecar fatal/lifecycle triggers, launch success/failure controls, input/resize/kill calls, timer advancement, emitted event capture, buffer snapshots, and launch argument capture.
   - Complexity: medium. Existing `test/unit/server/terminal-registry.test.ts` already mocks `node-pty`; add a focused `test/unit/server/terminal-registry.codex-recovery.test.ts`.
   - Tests depending on it: 2, 3, 8, 10, 11, 14-25, 30.

2. **Fake Codex app-server and fake remote CLI integration harness**
   - Does: runs the existing fake app-server fixture and fake Codex CLI through the real `WsHandler`, `CodexLaunchPlanner`, `CodexTerminalSidecar`, `CodexAppServerRuntime`, and `TerminalRegistry`.
   - Exposes: provider-shaped lifecycle notifications, app-server socket close, app-server child exit, thread operation logs, duplicate-active-thread assertions, fake CLI remote attach/resume/start behavior, and terminal WebSocket messages.
   - Complexity: medium. Extend `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs` and the existing `test/integration/server/codex-session-flow.test.ts` helper.
   - Tests depending on it: 1, 4, 6, 12, 25, 29.

3. **WebSocket and agent API launch retry harness**
   - Does: exercises `terminal.create` over WebSocket and Codex pane creation/split/respawn/run through the agent API with a launch planner that fails and then succeeds, or fails all attempts.
   - Exposes: WebSocket frames, HTTP responses, registry create calls, sidecar cleanup calls, and terminal record count.
   - Complexity: low to medium. Extend `test/server/ws-terminal-create-reuse-running-codex.test.ts`, `test/server/agent-panes-write.test.ts`, and related agent API tests with the existing fake launch planner.
   - Tests depending on it: 12, 13, 31.

4. **TerminalView status flow harness**
   - Does: renders `TerminalView` with the mocked WebSocket client and Redux store, then injects server messages.
   - Exposes: pane content, tab status, outgoing terminal input/attach/resize messages, and xterm writes.
   - Complexity: low. Extend existing `TerminalView.lifecycle.test.tsx` and create `test/e2e/codex-session-resilience-flow.test.tsx` from existing e2e-style React harnesses.
   - Tests depending on it: 7, 9, 31.

5. **Gated real-provider readiness contract harness**
   - Does: starts the installed Codex app-server and proves the provider emits current-generation lifecycle evidence naming the resumed durable thread.
   - Exposes: app-server runtime readiness, observer client lifecycle events, actor client resume calls, and optional lifecycle-loss event proof when the provider has a documented immediate signal.
   - Complexity: medium, but gated. Runs only with `FRESHELL_REAL_PROVIDER_CONTRACTS=1`; normal local runs skip it.
   - Tests depending on it: 5 and the optional real-provider portion of 6.

## Test Plan

1. **Durable sidecar failure keeps the Codex terminal alive**
   - **Type**: regression
   - **Disposition**: extend
   - **Harness**: Fake Codex app-server and fake remote CLI integration harness.
   - **Preconditions**: A Codex terminal is created through WebSocket, promoted to a durable session ID, and has one attached client.
   - **Actions**: Configure the fake app-server to exit after the durable thread is active. Send `terminal.create`; wait for `terminal.created`; wait for durable promotion; trigger fake app-server process exit.
   - **Expected outcome**: The WebSocket client receives `terminal.status` with `status: 'recovering'`, never receives `terminal.exit`, then receives `terminal.status` with `status: 'running'` after the replacement app-server emits lifecycle proof for the same durable session. The terminal ID remains unchanged, and later `terminal.input` reaches the replacement worker. Source of truth: implementation plan User-Visible Behavior and Acceptance Criteria.
   - **Interactions**: `WsHandler`, `TerminalRegistry`, `CodexTerminalSidecar`, `CodexAppServerRuntime`, fake CLI, terminal stream broker.

2. **Durable remote TUI process exit is recovered instead of finalizing the pane**
   - **Type**: scenario
   - **Disposition**: new
   - **Harness**: Codex supervisor unit harness.
   - **Preconditions**: A Codex terminal record is running with a known durable session ID, current generation PTY, current sidecar, attached client, and buffered scrollback.
   - **Actions**: Fire the current generation PTY `onExit` callback without a Freshell final-close reason.
   - **Expected outcome**: No `terminal.exit` is emitted; the record status stays running; a whole-bundle replacement starts with `resume <durable-session-id>` and a new `--remote` URL; the old bundle is retired; terminal ID, clients, buffer, and durable binding are preserved. Source of truth: implementation plan Contracts And Invariants and User-Visible Behavior.
   - **Interactions**: PTY lifecycle callbacks, generation guards, sidecar shutdown, launch factory, status broadcast.

3. **Remote TUI transport-fatal output triggers recovery while the PTY is still alive**
   - **Type**: regression
   - **Disposition**: new
   - **Harness**: Codex supervisor unit harness.
   - **Preconditions**: A durable Codex terminal is running; current PTY remains live.
   - **Actions**: Deliver PTY output containing `ERROR: remote app server ... transport failed: WebSocket protocol error: Connection reset without closing handshake`, including a split-across-chunks and ANSI-wrapped variant.
   - **Expected outcome**: The raw diagnostic is appended to terminal output and replay state, then recovery starts through whole-bundle replacement without `terminal.exit`. Ordinary output such as `working on it` does not trigger recovery. Source of truth: implementation plan remote TUI fatal-output detector contract and the incident text in the transcript.
   - **Interactions**: PTY data path, scrollback, terminal stream broker, remote TUI failure detector, recovery coalescing.

4. **App-server client socket disconnect recovers even when the child process stays alive**
   - **Type**: integration
   - **Disposition**: new
   - **Harness**: Fake Codex app-server and fake remote CLI integration harness.
   - **Preconditions**: A durable Codex terminal is running through the real server components.
   - **Actions**: Configure the fake app-server with `closeSocketAfterMethodsOnce` on `thread/resume` or another active method; create and promote the terminal; let the app-server close the JSON-RPC socket while leaving the process alive.
   - **Expected outcome**: Runtime/sidecar reports a worker failure; Freshell emits `terminal.status` recovering, does not emit `terminal.exit`, starts a new bundle, resumes the same durable session, and returns to running after lifecycle proof. Source of truth: implementation plan Task 1 and Acceptance Criteria.
   - **Interactions**: app-server client close/error callbacks, runtime exit handlers, sidecar fatal forwarding, registry replacement.

5. **Real provider durable resume emits current-generation readiness evidence**
   - **Type**: integration
   - **Disposition**: new
   - **Harness**: Gated real-provider readiness contract harness.
   - **Preconditions**: `FRESHELL_REAL_PROVIDER_CONTRACTS=1` and an authenticated installed Codex app-server are available.
   - **Actions**: Start `CodexAppServerRuntime`; create or identify a durable test thread; attach an observer client to lifecycle notifications; resume that exact thread through an actor client on the same app-server generation.
   - **Expected outcome**: The observer receives a current-generation lifecycle notification naming the expected durable thread after the actor resumes it. If unavailable, the test skips; if it runs and fails, durable seamless recovery cannot be claimed. Source of truth: implementation plan provider readiness contract note and Required Final Verification.
   - **Interactions**: installed provider, app-server runtime, app-server client lifecycle parsing.

6. **Provider lifecycle-loss evidence for the active durable thread starts replacement**
   - **Type**: integration
   - **Disposition**: new
   - **Harness**: Fake Codex app-server and fake remote CLI integration harness, plus optional gated real-provider contract when a documented immediate signal exists.
   - **Preconditions**: A durable Codex terminal is running or recovering; PTY remains alive.
   - **Actions**: Broadcast provider-shaped `thread/closed`, `thread/status/changed` with `status.type: 'notLoaded'`, and `thread/status/changed` with `status.type: 'systemError'` for the expected durable thread. Repeat with a nonmatching thread ID.
   - **Expected outcome**: Matching lifecycle-loss events trigger one whole-bundle replacement and no `terminal.exit`; nonmatching lifecycle-loss events are ignored. If lifecycle loss happens for the active unpublished candidate, the current attempt fails and the next attempt is scheduled. Source of truth: implementation plan Contracts And Invariants and Task 8 lifecycle handling.
   - **Interactions**: protocol parsing, sidecar lifecycle replay, active candidate guards, replacement-attempt failure path.

7. **Recoverable terminal.status never clears the pane terminal ID**
   - **Type**: scenario
   - **Disposition**: new
   - **Harness**: TerminalView status flow harness.
   - **Preconditions**: A `TerminalView` pane has `terminalId: 'term-1'`, status `running`, and an attached WebSocket client.
   - **Actions**: Inject `terminal.status` recovering for `term-1`; inject `terminal.status` running; inject `terminal.status` recovery_failed; finally inject `terminal.exit`.
   - **Expected outcome**: For all `terminal.status` messages, Redux pane content keeps `terminalId: 'term-1'` and updates only status. Only `terminal.exit` clears the terminal ID and marks the pane exited. Source of truth: implementation plan public message contract and User-Visible Behavior.
   - **Interactions**: shared WebSocket protocol type, TerminalView message handling, panes slice, tabs slice, status indicator mapping.

8. **Input during durable recovery is not written to a dead worker and flushes only after readiness**
   - **Type**: scenario
   - **Disposition**: new
   - **Harness**: Codex supervisor unit harness.
   - **Preconditions**: A durable Codex terminal is in `recovering_durable`; the old PTY is retired; a replacement attempt is active but not ready.
   - **Actions**: Call `registry.input(terminalId, 'abc')`; deliver process start and first PTY output; deliver current-generation `thread/started` for the expected durable session after candidate publication.
   - **Expected outcome**: Input is not written to the old PTY, not flushed on process start, not flushed on first output, and flushes once to the replacement PTY only after current-generation readiness proof. `registry.input` returns true so `ws-handler` does not send `INVALID_TERMINAL_ID`. Source of truth: implementation plan Retry And Input Policy and Task 8.
   - **Interactions**: input API, recovery buffer, readiness gate, WebSocket error behavior.

9. **Recovery failure leaves the pane useful enough to close and explains rejected input**
   - **Type**: scenario
   - **Disposition**: new
   - **Harness**: TerminalView status flow harness and Codex supervisor unit harness.
   - **Preconditions**: A Codex pane has a stable terminal ID and the server has exhausted recovery attempts.
   - **Actions**: Server emits `terminal.status` recovery_failed; user input is sent to the same terminal ID; then the user activates Freshell close/kill.
   - **Expected outcome**: The pane keeps its terminal ID and displays recovery_failed status; input appends `[Freshell] Codex recovery failed. Close this pane or refresh after checking the server logs.` through terminal output, with no `INVALID_TERMINAL_ID`; explicit close emits `terminal.exit`. Source of truth: implementation plan Retry And Input Policy and User-Visible Behavior.
   - **Interactions**: registry input handling, local terminal diagnostics, TerminalView status handling, final close path.

10. **Resize during recovery preserves the latest terminal dimensions**
    - **Type**: invariant
    - **Disposition**: new
    - **Harness**: Codex supervisor unit harness.
    - **Preconditions**: A Codex terminal is recovering and the current worker PTY is retired or unavailable.
    - **Actions**: Call `registry.resize(terminalId, 132, 41)` during recovery; complete replacement launch and readiness.
    - **Expected outcome**: `resize()` returns true, updates stable `cols` and `rows`, does not resize the retired PTY, and spawns or resizes the replacement PTY to `132x41` before buffered input is flushed. Source of truth: implementation plan resize invariant and Task 8 Step 4b.
    - **Interactions**: WebSocket terminal.resize, terminal stream broker attach hydration, PTY spawn options.

11. **Pre-durable worker failure retries the original launch without inventing identity**
    - **Type**: boundary
    - **Disposition**: new
    - **Harness**: Codex supervisor unit harness.
    - **Preconditions**: A fresh Codex terminal has no durable session ID and then its current worker fails.
    - **Actions**: Trigger sidecar/runtime failure before durable promotion; let the next replacement attempt start; exhaust retries in a second variant.
    - **Expected outcome**: Replacement uses the original fresh launch inputs and no guessed resume ID. If attempts are exhausted, the same terminal ID enters `recovery_failed` without `terminal.exit` and without a durable binding. Source of truth: implementation plan Plan Verdict and Task 9.
    - **Interactions**: launch factory, retry policy, pre-durable readiness state, terminal status broadcast.

12. **Initial Codex launch retries before terminal.created over WebSocket**
    - **Type**: integration
    - **Disposition**: new
    - **Harness**: WebSocket and agent API launch retry harness.
    - **Preconditions**: No terminal record exists yet; a `terminal.create` request for Codex has a launch planner configured to fail attempts 1 and 2, then succeed.
    - **Actions**: Send `terminal.create` over WebSocket. Repeat with the planner failing all five attempts.
    - **Expected outcome**: Success case sends one `terminal.created`, no `error`, and creates one terminal record with the preallocated terminal ID. Failure case sends one clear create error and creates no terminal record. Any sidecar created by a failed planning attempt is shut down. Source of truth: implementation plan Plan Verdict startup boundary and Task 6 Step 1b.
    - **Interactions**: WebSocket idempotency lock, rate limit bypass for restore, launch planner cleanup, registry create.

13. **Agent API Codex creation paths use the same launch retry and recovery inputs**
    - **Type**: integration
    - **Disposition**: extend
    - **Harness**: WebSocket and agent API launch retry harness.
    - **Preconditions**: Agent API routes that create Codex terminals are configured with a fake launch planner and a fake registry/layout store.
    - **Actions**: Call the Codex pane creation, pane split, pane respawn, and detached run endpoints with planner fail-then-succeed and fail-all variants.
    - **Expected outcome**: Each path retries initial launch before creating a terminal record, cleans failed sidecars, returns a clear error on exhaustion, and passes a stored launch factory/recovery inputs to the registry on success. Source of truth: implementation plan modified `server/agent-api/router.ts` requirements and Task 6.
    - **Interactions**: HTTP API, layout store preallocated terminal IDs, config defaults, registry create.

14. **Durable replacement uses the stored launch identity and a new app-server URL**
    - **Type**: integration
    - **Disposition**: new
    - **Harness**: Codex supervisor unit harness.
    - **Preconditions**: A durable Codex terminal was initially created with cwd, env context, provider settings, and durable session ID.
    - **Actions**: Trigger a worker failure and capture launch factory input and replacement PTY spawn args.
    - **Expected outcome**: Launch factory receives the original terminal ID, cwd, env context, sanitized provider settings, and durable session ID. Replacement PTY args include `--remote <new-ws-url>` and `resume <durable-session-id>`; the old URL is not reused as a branch. Source of truth: implementation plan File Structure, Task 6, and Acceptance Criteria.
    - **Interactions**: launch planner, provider settings, MCP config generation, PTY spawn.

15. **Duplicate failure signals from one generation coalesce into one recovery attempt**
    - **Type**: invariant
    - **Disposition**: new
    - **Harness**: Codex supervisor unit harness.
    - **Preconditions**: A durable Codex generation is current and has no active recovery attempt.
    - **Actions**: Trigger sidecar fatal, app-server exit, PTY exit, and fatal PTY output for the same generation in rapid succession.
    - **Expected outcome**: Freshell starts one replacement attempt, emits one recovering status for the episode, consumes one retry attempt, and logs later signals as coalesced or cleanup. Source of truth: implementation plan coalescing invariant and Task 7 Step 1b.
    - **Interactions**: async failure sources, retry budget, structured logs.

16. **Replacement launch and spawn failures retry once per failed attempt and preserve binding**
    - **Type**: boundary
    - **Disposition**: new
    - **Harness**: Codex supervisor unit harness.
    - **Preconditions**: A durable Codex terminal is recovering.
    - **Actions**: Make launch factory reject; make launch succeed but PTY spawn throw; repeat until retry budget is exhausted.
    - **Expected outcome**: Each failure consumes exactly one attempt, shuts down candidate sidecars and MCP config when created, never emits `terminal.exit`, preserves durable binding, schedules the documented backoff, and enters `recovery_failed` only after five failed attempts. Source of truth: implementation plan Retry And Input Policy and Task 7 replacement spawn rules.
    - **Interactions**: launch factory, PTY spawn, cleanupMcpConfig, retry timers, status broadcast.

17. **Explicit Freshell final close during recovery cancels all in-flight work**
    - **Type**: boundary
    - **Disposition**: new
    - **Harness**: Codex supervisor unit harness.
    - **Preconditions**: A replacement attempt is active with backoff/readiness timers, buffered input, and an unresolved launch promise.
    - **Actions**: Call `kill()` and `remove()` variants while recovery is in progress; later resolve the launch promise with a sidecar.
    - **Expected outcome**: Final close emits one `terminal.exit`, clears timers and buffered input, invalidates the active attempt, shuts down any late candidate sidecar, installs no replacement PTY, and emits no later recovery status. Source of truth: implementation plan final-close invariant and Task 12.
    - **Interactions**: kill/remove, async continuations, timer cleanup, sidecar cleanup.

18. **Freshell close is final, but in-TUI quit for a durable Codex session is recovered**
    - **Type**: scenario
    - **Disposition**: new
    - **Harness**: Codex supervisor unit harness.
    - **Preconditions**: A durable Codex terminal has a current PTY.
    - **Actions**: Variant A calls `registry.kill(terminalId)`; variant B fires PTY exit without a Freshell final-close reason.
    - **Expected outcome**: Variant A emits `terminal.exit` and releases the binding. Variant B starts whole-bundle recovery and preserves the binding. Source of truth: implementation plan User-Visible Behavior and close-intent contract.
    - **Interactions**: PTY exit classification, binding authority, terminal.exit broadcast.

19. **Stale and retiring generation callbacks cannot mutate stable terminal state**
    - **Type**: invariant
    - **Disposition**: new
    - **Harness**: Codex supervisor unit harness.
    - **Preconditions**: Generation N is retired and generation N+1 is current or active candidate.
    - **Actions**: Deliver old PTY data, PTY exit, sidecar fatal, runtime exit, lifecycle event, watcher callback, rollout callback, metadata cleanup callback, and timer callback from generation N.
    - **Expected outcome**: Stable buffer, broker replay, perf counters, startup probe state, remote TUI failure detector, durable binding, retry budget, and terminal status are unchanged. Source of truth: implementation plan Contracts And Invariants.
    - **Interactions**: all disposable worker callbacks, cleanup paths, output pipeline.

20. **Fast candidate readiness is latched until the replacement bundle is fully published**
    - **Type**: invariant
    - **Disposition**: new
    - **Harness**: Codex supervisor unit harness.
    - **Preconditions**: A durable replacement attempt has installed sidecar callbacks but has not published the candidate generation as current.
    - **Actions**: Emit `onDurableSession` and `thread/started` for the expected durable ID before PTY handler installation and before `workerGeneration` publication; then complete publication.
    - **Expected outcome**: Before publication, no running status is emitted and buffered input is not flushed. After publication, matching pending durable identity and readiness are consumed, status becomes running, dimensions are current, and input flushes once. Source of truth: implementation plan candidate generation promotion invariants and Task 8.
    - **Interactions**: sidecar lifecycle replay, active replacement attempt ID, readiness timers, input buffer.

21. **Worker generation numbers are monotonic and failed unpublished candidates stay stale**
    - **Type**: invariant
    - **Disposition**: new
    - **Harness**: Codex supervisor unit harness.
    - **Preconditions**: A durable terminal has generation N current.
    - **Actions**: Start a replacement candidate N+1 and fail it before publication; start candidate N+2 and publish it; later deliver callbacks from N+1.
    - **Expected outcome**: N+1 is never reused, late N+1 callbacks are ignored even after N+2 is current, and no stale callback mutates state. Source of truth: implementation plan generation allocation invariant.
    - **Interactions**: candidate allocation, active attempt state, late async callbacks.

22. **Pre-durable recovery becomes live only after the attach-stability window**
    - **Type**: boundary
    - **Disposition**: new
    - **Harness**: Codex supervisor unit harness.
    - **Preconditions**: A pre-durable Codex terminal is recovering and has no durable session ID.
    - **Actions**: Complete sidecar readiness, PTY spawn, handler installation, latest resize application, and worker publication; advance fake timers less than and then past the 1500 ms stability window. Variant: emit durable lifecycle proof before the window elapses.
    - **Expected outcome**: Before the window elapses, no running status and no input flush. After an uninterrupted window, state becomes `running_live_only`, running status emits, and non-expired buffered input flushes. If durable proof arrives first, the pre-durable timer is canceled and durable readiness rules take over. Source of truth: implementation plan Task 9.
    - **Interactions**: pre-durable timers, durable promotion, input expiry, resize application.

23. **Idle kill skips recovery states but still kills ordinary detached terminals**
    - **Type**: regression
    - **Disposition**: extend
    - **Harness**: Codex supervisor unit harness.
    - **Preconditions**: Auto-kill idle minutes is enabled; terminals are detached and past the threshold.
    - **Actions**: Run `enforceIdleKillsForTest()` for terminals in `recovering_pre_durable`, `recovering_durable`, `recovery_failed`, ordinary detached running shell, and ordinary detached running Codex.
    - **Expected outcome**: Recovery and recovery_failed Codex terminals are not killed. Ordinary detached running terminals still follow the existing idle-kill policy. Source of truth: implementation plan idle-kill invariant and Task 12.
    - **Interactions**: settings safety policy, recovery state, kill path.

24. **Shutdown paths are final and never start recovery loops**
    - **Type**: regression
    - **Disposition**: extend
    - **Harness**: Codex supervisor unit harness.
    - **Preconditions**: Running, recovering, and recovery_failed Codex terminals exist.
    - **Actions**: Call `shutdown()` and `shutdownGracefully()` variants.
    - **Expected outcome**: All terminals are finalized through explicit shutdown/final-close semantics; no replacement launch starts; sidecars and PTYs are signaled once; terminal exit waiting resolves. Source of truth: implementation plan shutdown invariant and Task 12.
    - **Interactions**: registry shutdown, PTY kill/SIGTERM, sidecar shutdown, recovery cancellation.

25. **Local recovery diagnostics are replayable after detach and reattach**
    - **Type**: integration
    - **Disposition**: new
    - **Harness**: Codex supervisor unit harness plus terminal stream broker.
    - **Preconditions**: A Codex terminal is recovering or recovery_failed and has a broker attached client.
    - **Actions**: Overflow or expire recovery input, or send input while recovery_failed; detach the client; reattach with replay.
    - **Expected outcome**: The local diagnostic appears in live terminal output and in replay after reattach because it was emitted through `terminal.output.raw` and appended to the same buffer. Source of truth: implementation plan local recovery message invariant and Retry And Input Policy.
    - **Interactions**: registry buffer, `terminal.output.raw`, `TerminalStreamBroker`, attach replay.

26. **App-server client parses lifecycle notifications and reports socket disconnects**
    - **Type**: unit
    - **Disposition**: extend
    - **Harness**: Fake Codex app-server and app-server client unit harness.
    - **Preconditions**: `CodexAppServerClient` is connected to the fake app-server.
    - **Actions**: Broadcast `thread/started`, `thread/closed`, and `thread/status/changed`; close the client socket unexpectedly; emit socket error in a variant.
    - **Expected outcome**: Client invokes `onThreadLifecycle` with normalized lifecycle events and invokes `onDisconnect` with close/error reason after rejecting pending requests. Source of truth: implementation plan Task 1 client contract.
    - **Interactions**: WebSocket JSON-RPC envelope parsing, request cleanup.

27. **App-server runtime exit errors preserve incident diagnostics**
    - **Type**: unit
    - **Disposition**: extend
    - **Harness**: Fake Codex app-server runtime unit harness.
    - **Preconditions**: Runtime starts a fake app-server process that writes stdout/stderr and then exits unexpectedly.
    - **Actions**: Configure fake behavior to write a diagnostic tail and exit after initialize; call `ensureReady()` or an RPC; observe `onExit`.
    - **Expected outcome**: The error includes PID, WebSocket port or URL, exit code, signal, elapsed time, stdout tail, and stderr tail, bounded by the configured caps. Source of truth: implementation plan Task 2 and Observability acceptance criterion.
    - **Interactions**: child stdio draining, bounded output tails, runtime state cleanup.

28. **Sidecar replays lifecycle evidence observed before terminal attachment**
    - **Type**: unit
    - **Disposition**: extend
    - **Harness**: Sidecar unit harness with fake runtime and fake rollout tracker.
    - **Preconditions**: Runtime emits thread lifecycle evidence before `attachTerminal()` is called.
    - **Actions**: Emit `thread/started`, `thread/closed`, and `thread/status/changed`; attach a terminal.
    - **Expected outcome**: Attached terminal receives the bounded replay synchronously; shutdown suppresses lifecycle/fatal forwarding. Source of truth: implementation plan Task 1 Step 4 and readiness latching requirement.
    - **Interactions**: sidecar lifecycle queue, rollout tracker, terminal attachment callbacks.

29. **Durable recovery resumes the existing upstream thread and never starts duplicate active work**
    - **Type**: invariant
    - **Disposition**: new
    - **Harness**: Fake Codex app-server and fake remote CLI integration harness.
    - **Preconditions**: A durable Codex session is active and fake app-server `assertNoDuplicateActiveThread` is enabled.
    - **Actions**: Trigger durable worker failure and observe replacement fake CLI RPCs through the app-server thread operation log.
    - **Expected outcome**: Recovery calls `thread/resume` for the durable ID and does not call `thread/start` for a new active thread. The test fails if duplicate active work is started. Source of truth: implementation plan single recovery primitive and duplicate-session guard.
    - **Interactions**: fake app-server active thread tracking, fake CLI RPCs, launch args.

30. **Terminal inventory reports runtime status without changing the final status contract**
    - **Type**: integration
    - **Disposition**: extend
    - **Harness**: WebSocket server protocol harness and Codex supervisor unit harness.
    - **Preconditions**: Running, recovering, recovery_failed, and exited terminal records exist.
    - **Actions**: Request or receive terminal inventory; force registry status broadcasts.
    - **Expected outcome**: Inventory keeps `status: 'running' | 'exited'` and adds optional `runtimeStatus: 'running' | 'recovering' | 'recovery_failed'` for live terminals. `terminal.status` never carries `exited`; finality is represented only by `terminal.exit`. Source of truth: implementation plan State Model and public message contract.
    - **Interactions**: shared protocol types, ws-handler inventory snapshot, old-client compatibility.

31. **Recovery status and handled recovery input do not trigger INVALID_TERMINAL_ID reconnect**
    - **Type**: regression
    - **Disposition**: extend
    - **Harness**: TerminalView status flow harness and WebSocket launch retry harness.
    - **Preconditions**: A durable Codex pane has a terminal ID and sessionRef.
    - **Actions**: Inject `terminal.status` recovering; simulate user input and resize accepted by server during recovery; inject no `INVALID_TERMINAL_ID`; then inject `terminal.status` running.
    - **Expected outcome**: TerminalView does not clear terminal ID, does not start a new `terminal.create`, and input after running targets the original terminal ID. The existing `INVALID_TERMINAL_ID` reconnect behavior remains covered separately for actual missing terminals. Source of truth: implementation plan User-Visible Behavior and Retry And Input Policy.
    - **Interactions**: TerminalView error handling, ws-handler input/resize false path, restore reconnect logic.

32. **Recovery policy has the documented retry, backoff, reset, and input-buffer limits**
    - **Type**: unit
    - **Disposition**: new
    - **Harness**: Codex supervisor unit harness, pure recovery policy module.
    - **Preconditions**: A new recovery episode starts with fake time at zero.
    - **Actions**: Request attempts through the sequence, advance fake time during recovery, mark stable running for 10 minutes, buffer input up to and beyond 8 KiB, and expire buffered input after 10 seconds.
    - **Expected outcome**: Delays are `0`, `250`, `1000`, `2000`, `5000`; the sixth failed attempt is exhausted; time in recovery does not replenish attempts; stable running for 10 minutes resets budget; input buffer caps and TTL return explicit overflow/expired results. Source of truth: implementation plan Retry And Input Policy and Task 3.
    - **Interactions**: recovery scheduler, input gating, retry exhaustion.

33. **Focused server and client regression suites pass after implementation**
    - **Type**: regression
    - **Disposition**: existing
    - **Harness**: Existing coordinated Vitest harness.
    - **Preconditions**: All implementation tasks are complete.
    - **Actions**: Run:
      ```bash
      npm run test:vitest -- test/unit/server/coding-cli/codex-app-server test/unit/server/terminal-registry.test.ts test/unit/server/terminal-registry.codex-recovery.test.ts
      npm run test:vitest -- test/integration/server/codex-session-flow.test.ts test/integration/server/codex-session-rebind-regression.test.ts
      npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.resumeSession.test.tsx test/e2e/codex-session-resilience-flow.test.tsx
      ```
    - **Expected outcome**: All focused checks pass. Source of truth: implementation plan Task 14.
    - **Interactions**: app-server units, registry supervisor, integration server flow, client lifecycle.

34. **Typecheck, lint, and broad coordinated verification pass**
    - **Type**: regression
    - **Disposition**: existing
    - **Harness**: Existing repo scripts and test coordinator.
    - **Preconditions**: Focused suites are green and client files changed.
    - **Actions**: Run:
      ```bash
      npm run typecheck
      npm run lint
      npm run test:status
      FRESHELL_TEST_SUMMARY="codex session resilience final verification" npm run check
      git diff --check
      ```
    - **Expected outcome**: Typecheck, lint, coordinated full check, and whitespace check pass. If the real-provider contract is available, run it as in Test 5 and require pass before claiming the durable seamless recovery guarantee. Source of truth: implementation plan Required Final Verification and repo AGENTS instructions.
    - **Interactions**: full client/server test suite, a11y lint, test coordinator gate, build/type contracts.

## Coverage Summary

Covered action space:

- WebSocket `terminal.create` for Codex fresh and durable resume, including initial app-server launch retries before a terminal record exists.
- WebSocket `terminal.input`, `terminal.resize`, `terminal.attach`, `terminal.detach`, and `terminal.kill` while a Codex terminal is running, recovering, recovery_failed, and exited.
- Server-to-client `terminal.created`, `terminal.status`, `terminal.output`, `terminal.output.gap`, `terminal.attach.ready`, `terminal.exit`, `terminal.session.associated`, and terminal inventory messages.
- Agent API Codex terminal creation surfaces: pane creation, pane split, pane respawn, and detached run.
- Codex app-server JSON-RPC actions used by Freshell: `initialize`, `thread/start`, `thread/resume`, `fs/watch`, `fs/unwatch`, and provider lifecycle notifications.
- Worker failure sources: PTY exit, sidecar fatal, app-server child/runtime exit, app-server client disconnect, remote TUI fatal output, provider lifecycle loss, readiness timeout, replacement launch failure, and replacement spawn failure.
- Recovery controls: whole-bundle retirement, candidate generation publication, readiness proof, retry exhaustion, final close cancellation, input buffering, resize persistence, local diagnostics, idle-kill protection, and shutdown finality.
- Client UI behavior: mounted Codex pane remains mounted through `terminal.status`, terminal ID persists until `terminal.exit`, recovery status maps to accessible status styling, and recovery handling avoids the existing `INVALID_TERMINAL_ID` reconnect path.

Explicit exclusions:

- No manual QA or human visual inspection. UI coverage uses React Testing Library state/message assertions; no screenshot diff is required because the visible change is status state, not a visual layout redesign.
- No production or paid external provider dependency in the default suite. The real-provider readiness contract is gated by `FRESHELL_REAL_PROVIDER_CONTRACTS=1`; if unavailable, implementation can still merge only with that limitation documented, but the durable seamless recovery guarantee must not be claimed as provider-proven.
- No performance benchmark beyond broad verification. The risk is correctness of async failure boundaries, not a performance-sensitive path; catastrophic regressions are covered by existing typecheck, lint, and coordinated tests.
- No in-place sidecar-only, PTY-only, or JSON-RPC-client-only reconnect path is tested because the architecture explicitly forbids those alternate recovery branches.

Residual risks:

- The fake provider can prove routing and recovery invariants, but only the gated real-provider contract can prove that the installed provider supplies the required durable readiness evidence.
- Backpressure bursts with many simultaneous Codex terminals are represented through coalescing and failure-source tests, not a long-running load reproduction. This is acceptable because the product guarantee is that each terminal’s worker failure is recoverable, not that upstream never drops transport.
