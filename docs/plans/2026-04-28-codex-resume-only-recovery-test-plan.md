# Codex Resume-Only Recovery Test Plan

## Harness Requirements

The implementation plan does not require a new paid service, external Codex API, or live ChatGPT/Oracle dependency. The existing local test harnesses cover the required surfaces. Strategy adjustment: `recovery_failed` is treated only as legacy persisted input or malformed inbound protocol data. It is not a normal runtime state to assert in server, protocol, or UI flow tests.

1. Existing server unit harness
   - What it does: Instantiates `CodexRecoveryPolicy` and `TerminalRegistry` with mocked PTYs, mocked Codex sidecars, fake timers, and event listeners.
   - Exposes: Policy API calls, registry `create/input/enforceIdleKillsForTest`, emitted `terminal.status`, `terminal.exit`, and terminal buffer contents.
   - Complexity: Existing, low extension cost.
   - Dependent tests: 1-5.

2. Existing WebSocket protocol and handshake harness
   - What it does: Validates shared WebSocket message types and terminal inventory snapshots.
   - Exposes: Schema/type fixtures and serialized handshake inventory payloads.
   - Complexity: Existing, low extension cost.
   - Dependent tests: 6-7.

3. Existing server integration harness with fake Codex app-server and fake remote Codex process
   - What it does: Starts the real server-side WebSocket flow against local fake Codex sidecars and PTYs.
   - Exposes: User-facing WebSocket messages, terminal input delivery, fake thread operation JSONL (`thread/start`, `thread/resume`), registry records for diagnosis, and controllable sidecar failures.
   - Complexity: Existing. Extend only by using the already available append-style operation log and a scoped `CodexLaunchPlanner.planCreate` spy for repeated replacement launch failures.
   - Dependent tests: 8-13.

4. Existing React/Redux component and scenario harness
   - What it does: Renders `TerminalView`, `TabSwitcher`, and store flows with mocked WebSocket callbacks.
   - Exposes: Rendered UI, Redux pane/tab state, WebSocket sends, reconnect callbacks, and terminal input simulation.
   - Complexity: Existing, low extension cost.
   - Dependent tests: 14-20.

5. Existing persistence and migration unit harness
   - What it does: Parses persisted pane/tab JSON and runs localStorage layout migration.
   - Exposes: Parsed/migrated pane layouts, tab records, terminal content fields, and restore errors.
   - Complexity: Existing, low extension cost.
   - Dependent tests: 21-24.

## Test Plan

1. **Name:** Recovery policy keeps retrying with capped delay instead of exhausting
   - **Type:** unit
   - **Disposition:** extend
   - **Harness:** Existing server unit harness.
   - **Preconditions:** New `CodexRecoveryPolicy` with deterministic `now`.
   - **Actions:** Call `nextAttempt()` seven times.
   - **Expected outcome:** Attempts are `{ attempt: 1, delayMs: 0 }`, `{ attempt: 2, delayMs: 250 }`, `{ attempt: 3, delayMs: 1000 }`, `{ attempt: 4, delayMs: 2000 }`, `{ attempt: 5, delayMs: 5000 }`, `{ attempt: 6, delayMs: 5000 }`, `{ attempt: 7, delayMs: 5000 }`. No `{ ok: false, reason: 'exhausted' }` result exists. Source of truth: implementation plan Chunk 2 Task 1 and user requirement that durable sessions cannot park in failed state.
   - **Interactions:** Pure policy logic used by `TerminalRegistry`.

2. **Name:** Recovery policy resets retry sequence only after stable running window
   - **Type:** unit
   - **Disposition:** extend
   - **Harness:** Existing server unit harness.
   - **Preconditions:** Policy has already issued many retry attempts.
   - **Actions:** Call `markStableRunning()`, advance time beyond `CODEX_RECOVERY_STABLE_RESET_MS`, then call `nextAttempt()`.
   - **Expected outcome:** The next attempt is `{ attempt: 1, delayMs: 0 }`. Merely advancing time during ongoing recovery keeps capped attempts at 5000ms. Source of truth: implementation plan Chunk 2 Task 1.
   - **Interactions:** Guards against tight retry loops after long stable sessions.

3. **Name:** Repeated durable replacement launch failures keep retrying `codex resume`
   - **Type:** regression
   - **Disposition:** extend
   - **Harness:** Existing server unit harness.
   - **Preconditions:** A Codex terminal is created with `resumeSessionId: 'thread-durable-1'`; its launch factory rejects replacement launches.
   - **Actions:** Trigger the current PTY `onExit`, run pending timers enough to exceed the old five-attempt budget.
   - **Expected outcome:** `terminal.exit` is not emitted, `terminal.status` includes `status: 'recovering'`, `status: 'recovery_failed'` is never emitted, launch attempts exceed five, and every launch factory input has `resumeSessionId: 'thread-durable-1'`. Source of truth: implementation plan Chunk 2 Task 2 and the user's “resume using codex resume” requirement.
   - **Interactions:** Registry recovery state, launch factory, PTY exit handling, event emissions.

4. **Name:** Retiring a failed worker after many failures schedules another durable resume attempt
   - **Type:** regression
   - **Disposition:** extend
   - **Harness:** Existing server unit harness.
   - **Preconditions:** A Codex terminal has durable identity and its policy has already consumed more than the old retry budget.
   - **Actions:** Trigger PTY exit for the failed worker.
   - **Expected outcome:** The failed generation is marked `recovery_retire`, sidecar shutdown and PTY kill happen once, recovery state remains `recovering_durable`, another launch attempt is scheduled, and no `recovery_failed` status is emitted. Source of truth: implementation plan Chunk 2 Task 2.
   - **Interactions:** Worker-generation guard, sidecar shutdown, MCP cleanup path incidentally.

5. **Name:** Input during durable recovery is buffered, not converted to failed-recovery copy
   - **Type:** boundary
   - **Disposition:** extend
   - **Harness:** Existing server unit harness.
   - **Preconditions:** A durable Codex terminal is in `recovering_durable`.
   - **Actions:** Call `registry.input(terminalId, 'abc')`.
   - **Expected outcome:** The call returns true, PTY `write` is not called while recovery is active, buffered input can flush after recovery readiness, and terminal output does not contain “Codex recovery failed”. Source of truth: implementation plan Chunk 2 Task 2 and Chunk 5 search invariant.
   - **Interactions:** Terminal input API, recovery input buffer, local terminal diagnostics.

6. **Name:** Idle enforcement does not kill active Codex recovery states
   - **Type:** invariant
   - **Disposition:** extend
   - **Harness:** Existing server unit harness.
   - **Preconditions:** One Codex terminal in `recovering_pre_durable`, one in `recovering_durable`, and one ordinary shell terminal all have stale `lastActivityAt`.
   - **Actions:** Run `enforceIdleKillsForTest()`.
   - **Expected outcome:** Both Codex recovery terminals remain running; the shell terminal exits. No test fixture uses `recovery_failed` as a protected runtime state. Source of truth: implementation plan Chunk 2 Task 2.
   - **Interactions:** Safety idle-kill policy and registry runtime state projection.

7. **Name:** WebSocket terminal status contract excludes `recovery_failed`
   - **Type:** invariant
   - **Disposition:** extend
   - **Harness:** Existing WebSocket protocol harness.
   - **Preconditions:** Shared protocol tests compile against `TerminalStatusMessage`.
   - **Actions:** Parse/compile fixtures for `terminal.status` with `running` and `recovering`; include a negative fixture for `recovery_failed` if the schema harness supports invalid-message assertions.
   - **Expected outcome:** `running` and `recovering` are valid; `recovery_failed` is not a valid runtime status. Source of truth: implementation plan Chunk 3 Task 8.
   - **Interactions:** Shared server/client WebSocket type boundary.

8. **Name:** Handshake inventory reports recovering runtime but never failed recovery runtime
   - **Type:** integration
   - **Disposition:** extend
   - **Harness:** Existing WebSocket handshake snapshot harness.
   - **Preconditions:** Snapshot fixture includes running, recovering, and exited terminals.
   - **Actions:** Build terminal inventory snapshot.
   - **Expected outcome:** Running terminals may have `runtimeStatus: 'running'`; recovering Codex terminals may have `runtimeStatus: 'recovering'`; exited terminals omit `runtimeStatus`; no fixture or output contains `runtimeStatus: 'recovery_failed'`. Source of truth: implementation plan Chunk 3 Task 8.
   - **Interactions:** Registry terminal inventory, ready/handshake payload surface.

9. **Name:** Codex app-server client disconnect recovers the pane with the same thread
   - **Type:** scenario
   - **Disposition:** extend
   - **Harness:** Existing server integration harness with fake Codex app-server.
   - **Preconditions:** Fake app-server is configured to close the socket after a watched method; client sends `terminal.create` for Codex with `sessionRef: { provider: 'codex', sessionId: 'thread-existing-1' }`.
   - **Actions:** Wait for `terminal.created`, observe recovery, then send `terminal.input` after recovery.
   - **Expected outcome:** User-visible WebSocket messages include `terminal.status: recovering` followed by `terminal.status: running`; no `terminal.exit` and no `recovery_failed` status are emitted; fake remote stdin receives the post-recovery input; operation log contains at least two `thread/resume` operations for `thread-existing-1` and zero `thread/start` operations. Source of truth: implementation plan Chunk 2 Task 5 and the user requirement for seamless retry using `codex resume`.
   - **Interactions:** WebSocket `terminal.create`, app-server client disconnect, sidecar replacement, PTY respawn, terminal input delivery.

10. **Name:** Owning Codex sidecar death after launch recovers and remains interactive
   - **Type:** scenario
   - **Disposition:** extend
   - **Harness:** Existing server integration harness with fake Codex app-server.
   - **Preconditions:** Fresh Codex terminal starts without a session id; fake app-server exits after the first turn creates durable `thread-new-1`.
   - **Actions:** Send `terminal.create`, wait until the registry binds `thread-new-1`, wait for recovering then running, then send terminal input.
   - **Expected outcome:** Pane terminal id stays alive, no `terminal.exit` is emitted, post-recovery input reaches fake remote stdin, operation log has initial `thread/start` for the new session and later `thread/resume` for `thread-new-1`. Source of truth: implementation plan Chunk 3 Task 9 and transcript finding that sidecar failure must be a worker failure, not pane death.
   - **Interactions:** Fresh-session durable promotion, sidecar fatal path, resume replacement.

11. **Name:** Provider reports durable thread closed and recovery resumes the same thread
   - **Type:** integration
   - **Disposition:** extend
   - **Harness:** Existing server integration harness with fake Codex app-server.
   - **Preconditions:** Durable Codex terminal for `thread-existing-1`; fake app-server emits `thread/closed` for that thread after resume.
   - **Actions:** Send `terminal.create` with Codex `sessionRef`, wait through recovery.
   - **Expected outcome:** WebSocket status transitions are recovering then running; no `terminal.exit` or `recovery_failed`; operation log uses `thread/resume` for `thread-existing-1` and no `thread/start`. Source of truth: implementation plan Chunk 3 Task 9.
   - **Interactions:** Provider lifecycle notifications, registry failure source `provider_thread_lifecycle_loss`.

12. **Name:** Provider reports notLoaded or systemError and recovery resumes the same thread
   - **Type:** integration
   - **Disposition:** extend
   - **Harness:** Existing server integration harness with fake Codex app-server.
   - **Preconditions:** Durable Codex terminal for `thread-existing-1`; fake app-server emits `thread/status/changed` with `notLoaded` or `systemError`.
   - **Actions:** Run one scenario for each status, creating the terminal and waiting through recovery.
   - **Expected outcome:** Each scenario emits recovering then running, never emits `terminal.exit` or `recovery_failed`, and logs only `thread/resume` for the durable id after initial create. Source of truth: implementation plan Chunk 3 Task 9.
   - **Interactions:** Provider lifecycle failure mapping, replacement readiness evidence.

13. **Name:** Durable Codex PTY exit recovers by resuming the existing upstream thread
   - **Type:** regression
   - **Disposition:** extend
   - **Harness:** Existing server integration harness with fake Codex app-server and fake PTY.
   - **Preconditions:** `terminal.create` uses Codex `sessionRef` for `thread-existing-1`; fake remote exits/sleeps enough to trigger PTY failure.
   - **Actions:** Observe WebSocket messages until recovery completes.
   - **Expected outcome:** User-visible messages include recovering then running; no `terminal.exit` for the terminal; no `recovery_failed`; operation log has repeated `thread/resume` for `thread-existing-1` and no `thread/start`. Source of truth: implementation plan Chunk 2 Task 5.
   - **Interactions:** PTY exit handler, replacement launch, readiness timers.

14. **Name:** Replacement launch failures beyond the old retry budget still recover when a later resume succeeds
   - **Type:** regression
   - **Disposition:** new
   - **Harness:** Existing server integration harness with scoped `CodexLaunchPlanner.planCreate` spy.
   - **Preconditions:** Durable Codex terminal for `thread-existing-1` is already created; after initial create, `planCreate` is spied to fail the first five replacement calls for that session and then call through.
   - **Actions:** Kill the active PTY directly, wait up to the capped backoff window for `terminal.status: running`.
   - **Expected outcome:** The terminal never exits, never emits `recovery_failed`, emits recovering and then running, operation log includes successful `thread/resume` for `thread-existing-1`, no `thread/start`, and the spy saw at least six replacement resume attempts. Source of truth: implementation plan Chunk 2 Task 5.
   - **Interactions:** Real timers, launch planner, fake app-server process creation, retry policy.

15. **Name:** TerminalView ignores legacy `recovery_failed` status for durable Codex panes
   - **Type:** regression
   - **Disposition:** new
   - **Harness:** Existing React/Redux component harness.
   - **Preconditions:** Render a Codex `TerminalView` with durable `sessionRef`; mock WebSocket reports `terminal.created` and `terminal.status: running`.
   - **Actions:** Deliver a malformed/legacy `terminal.status` message with `status: 'recovery_failed'`.
   - **Expected outcome:** The pane keeps the same terminal id and remains `status: 'running'`; no tab state is updated to `recovery_failed`. Source of truth: implementation plan Chunk 2 Task 3 and protocol contract in Chunk 3 Task 8.
   - **Interactions:** WebSocket message handler, panes slice update, tabs slice update.

16. **Name:** TerminalView keeps terminal id through recovering then running
   - **Type:** scenario
   - **Disposition:** extend
   - **Harness:** Existing React/Redux component harness.
   - **Preconditions:** Mounted Codex terminal pane with `terminalId: 'term-status'`.
   - **Actions:** Deliver `terminal.status: recovering`, then `terminal.status: running`.
   - **Expected outcome:** The same terminal id remains attached and pane/tab status updates to recovering then running. The test no longer treats `recovery_failed` as recoverable. Source of truth: implementation plan Chunk 2 Task 3.
   - **Interactions:** TerminalView lifecycle and persisted pane content updates.

17. **Name:** TerminalView still treats explicit terminal exit as final terminal exit
   - **Type:** regression
   - **Disposition:** existing
   - **Harness:** Existing React/Redux component harness.
   - **Preconditions:** Mounted terminal pane with attached terminal id.
   - **Actions:** Deliver `terminal.exit` for that terminal id.
   - **Expected outcome:** The pane clears `terminalId` and becomes `status: 'exited'`. This protects unchanged terminal lifecycle behavior outside the Codex recovery path. Source of truth: current WebSocket lifecycle contract and implementation plan scope note that only parked Codex recovery is removed.
   - **Interactions:** TerminalView exit handling and tab status update.

18. **Name:** Codex session resilience scenario recovers without a failed parked status
   - **Type:** scenario
   - **Disposition:** extend
   - **Harness:** Existing e2e-style React/Redux scenario harness.
   - **Preconditions:** Store contains a Codex pane created from durable resume metadata.
   - **Actions:** Render `TerminalView`, deliver `terminal.created`, `terminal.attach.ready`, `terminal.status: recovering`, and `terminal.status: running`; simulate terminal input after running.
   - **Expected outcome:** The mounted pane keeps its terminal id, final pane status is running, and input sends `terminal.input` for that id. No `recovery_failed` status is delivered or persisted. Source of truth: implementation plan Chunk 2 Task 3.
   - **Interactions:** Terminal attach, terminal input, pane state.

19. **Name:** Reattach while recovering stays recovering until server reports running
   - **Type:** scenario
   - **Disposition:** extend
   - **Harness:** Existing e2e-style React/Redux scenario harness.
   - **Preconditions:** Codex pane is attached and server has reported `terminal.status: recovering`.
   - **Actions:** Trigger WebSocket reconnect handler, deliver new `terminal.attach.ready`, then deliver `terminal.status: running`.
   - **Expected outcome:** Reattach does not invent a failed state; pane remains recovering until the running status arrives, then becomes running with the same terminal id. Source of truth: implementation plan Chunk 2 Task 3.
   - **Interactions:** Reconnect handler, attach request ids, server-authoritative status.

20. **Name:** Tab switcher shows recovering Codex panes without failed recovery UI
   - **Type:** scenario
   - **Disposition:** extend
   - **Harness:** Existing React component harness.
   - **Preconditions:** Store has running, recovering, exited, and error tabs.
   - **Actions:** Open/render `TabSwitcher`.
   - **Expected outcome:** Recovering tabs show “Recovering”; exited and error tabs remain destructive; no card, label, or destructive status for “Recovery failed” exists. Source of truth: implementation plan Chunk 4 Task 10.
   - **Interactions:** Tab status labels, terminal status indicator styling.

21. **Name:** Persisted durable legacy Codex `recovery_failed` pane becomes a creating resume pane
   - **Type:** regression
   - **Disposition:** new
   - **Harness:** Existing persistence unit harness.
   - **Preconditions:** Raw persisted panes JSON contains a Codex terminal with `status: 'recovery_failed'`, stale `terminalId`, stale `restoreError`, and `sessionRef: { provider: 'codex', sessionId: 'thread-durable-1' }`.
   - **Actions:** Call `parsePersistedPanesRaw(raw)`.
   - **Expected outcome:** Parsed content has `status: 'creating'`, preserves the Codex `sessionRef` and `initialCwd`, strips `terminalId`, and strips stale `restoreError`. Source of truth: implementation plan Chunk 2 Task 4 and Chunk 4 Task 11.
   - **Interactions:** Pane persistence parser, durable session migration.

22. **Name:** Persisted non-resumable legacy Codex `recovery_failed` pane becomes restore-unavailable error
   - **Type:** boundary
   - **Disposition:** new
   - **Harness:** Existing persistence unit harness.
   - **Preconditions:** Raw persisted panes JSON contains a Codex terminal with `status: 'recovery_failed'` but no `sessionRef` or valid durable id.
   - **Actions:** Call `parsePersistedPanesRaw(raw)`.
   - **Expected outcome:** Parsed content has `status: 'error'`, no `terminalId`, and `restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'invalid_legacy_restore_target' }`. Source of truth: implementation plan Chunk 2 Task 4.
   - **Interactions:** Prevents accidental fresh Codex session creation from non-resumable legacy state.

23. **Name:** LocalStorage migration repairs durable legacy Codex failed panes
   - **Type:** regression
   - **Disposition:** new
   - **Harness:** Existing storage migration unit harness.
   - **Preconditions:** localStorage layout payload contains a durable Codex pane with `status: 'recovery_failed'`, stale `terminalId`, and `sessionRef`.
   - **Actions:** Run storage migration by importing/calling the migration helper as the existing tests do.
   - **Expected outcome:** Migrated layout content is `status: 'creating'`, preserves `sessionRef` and `initialCwd`, and removes `terminalId`/stale restore error. Source of truth: implementation plan Chunk 2 Task 4 and Chunk 4 Task 11.
   - **Interactions:** Browser localStorage migration and persisted layout versioning.

24. **Name:** LocalStorage migration marks non-resumable legacy Codex failed panes unavailable
   - **Type:** boundary
   - **Disposition:** new
   - **Harness:** Existing storage migration unit harness.
   - **Preconditions:** localStorage layout payload contains a Codex `recovery_failed` pane with no durable session identity.
   - **Actions:** Run storage migration.
   - **Expected outcome:** Migrated content is `status: 'error'`, has no `terminalId`, and has `RESTORE_UNAVAILABLE` with `invalid_legacy_restore_target`. Source of truth: implementation plan Chunk 2 Task 4.
   - **Interactions:** Startup migration, restore error contract.

25. **Name:** Hydrated legacy tab status becomes creating, not recovery failed
   - **Type:** regression
   - **Disposition:** new
   - **Harness:** Existing tabs slice unit harness.
   - **Preconditions:** Hydrate tabs with a Codex tab whose persisted status is `recovery_failed` and sessionRef points at `thread-durable-1`.
   - **Actions:** Dispatch the existing hydrate/remote-tabs action used by `tabsSlice` tests.
   - **Expected outcome:** Hydrated tab has `status: 'creating'` and preserves `sessionRef`; no tab status remains `recovery_failed`. Source of truth: implementation plan Chunk 4 Task 11.
   - **Interactions:** Tabs persistence, remote/local layout merge.

26. **Name:** Opening a completed Codex history row creates a terminal resume pane
   - **Type:** scenario
   - **Disposition:** new
   - **Harness:** Existing tabs slice unit harness.
   - **Preconditions:** Store starts without a tab for `thread-durable-1`.
   - **Actions:** Dispatch `openSessionTab({ sessionId: 'thread-durable-1', title: 'Existing Codex session', cwd: '/repo', provider: 'codex', sessionType: 'codex' })`.
   - **Expected outcome:** Store contains a tab with `sessionRef: { provider: 'codex', sessionId: 'thread-durable-1' }`; its pane layout is a terminal pane with `mode: 'codex'`, same `sessionRef`, `initialCwd: '/repo'`, and `status: 'creating'`; it is not a transcript-only tab. Source of truth: user correction “only resume using codex resume” and implementation plan Chunk 2 Task 4.
   - **Interactions:** History row open action, `buildResumeContent`, layout initialization.

27. **Name:** Production code contains no parked Codex failed-recovery runtime state
   - **Type:** invariant
   - **Disposition:** new
   - **Harness:** Search/check command.
   - **Preconditions:** Implementation complete.
   - **Actions:** Run `rg -n "recovery_failed|Codex recovery failed" server shared src --glob '!src/store/persistedState.ts' --glob '!src/store/storage-migration.ts'`.
   - **Expected outcome:** No output. Allowed production references are only legacy migration predicates in `persistedState.ts` and `storage-migration.ts`. Source of truth: implementation plan Chunk 5 Task 13.
   - **Interactions:** Whole production codebase.

28. **Name:** Test references to `recovery_failed` are only legacy or invalid-message assertions
   - **Type:** invariant
   - **Disposition:** new
   - **Harness:** Search/check command.
   - **Preconditions:** Implementation complete.
   - **Actions:** Run `rg -n "recovery_failed" test`.
   - **Expected outcome:** Remaining matches are limited to legacy persisted input, storage migration input, invalid inbound-message/no-persistence assertions, or explicit no-emission assertions. No test blesses `recovery_failed` as a stable runtime status. Source of truth: implementation plan Chunk 5 Task 13.
   - **Interactions:** Whole automated suite intent.

29. **Name:** Focused recovery, protocol, integration, and client suites pass
   - **Type:** invariant
   - **Disposition:** existing
   - **Harness:** Repo-owned Vitest focused runs.
   - **Preconditions:** All implementation tasks complete.
   - **Actions:** Run the three focused commands from the implementation plan: server recovery tests, protocol/integration tests, and client lifecycle/store tests.
   - **Expected outcome:** All focused runs pass. Source of truth: implementation plan Chunk 5 Task 14.
   - **Interactions:** Server unit, protocol, server integration, React component, e2e-style, and store tests.

30. **Name:** Typecheck and coordinated full suite pass
   - **Type:** invariant
   - **Disposition:** existing
   - **Harness:** Repo typecheck and coordinated test runner.
   - **Preconditions:** Focused tests pass and coordinator is available.
   - **Actions:** Run `npm run typecheck`, `npm run test:status`, and `FRESHELL_TEST_SUMMARY="codex resume-only recovery" npm test`.
   - **Expected outcome:** Typecheck passes and coordinated full suite passes. Source of truth: repo rules and implementation plan Chunk 5 Tasks 14-15.
   - **Interactions:** Full repo test surface and coordinator gate.

## Coverage Summary

Covered action space:

- WebSocket `terminal.create` for Codex fresh sessions and durable resume sessions.
- WebSocket `terminal.input` while running and after automatic recovery.
- Server-originated `terminal.status` transitions: `recovering` and `running`.
- Server-originated `terminal.exit` handling for unchanged explicit exits, plus assertions that recovery failures do not emit it.
- Terminal inventory/handshake runtime status.
- Codex app-server client disconnect, sidecar death, PTY exit, provider thread closed, provider notLoaded/systemError, replacement launch failure, readiness/retry behavior, and worker retirement.
- Fake app-server `thread/start` and `thread/resume` operation log validation.
- React `TerminalView` message handling, reconnect/reattach behavior, and xterm input send path.
- `TabSwitcher` status labels and destructive styling.
- Persisted pane parsing, localStorage migration, tab hydration, and history-row open action.
- Search invariants proving the old stable failed-recovery state is removed from production runtime code.

Explicit exclusions:

- Live upstream Codex CLI/app-server behavior against the real installed binary is excluded from automated acceptance. The source of truth for this change is Freshell’s resilience contract, and the local fake app-server exercises the same Freshell-owned protocol edges without paid or external infrastructure.
- Manual browser QA and screenshots are excluded because the user-visible changes are state/lifecycle semantics covered by structured UI/store assertions; there is no visual redesign.
- Performance benchmarking is excluded beyond the retry backoff timing in integration tests. The change is not performance-critical; the relevant performance risk is runaway retries, covered by capped-delay assertions.
- Transcript rendering fallback is excluded by user instruction. The only acceptable recovery surface is `codex resume <sessionId>`.

Residual risks:

- The real Codex CLI may fail every resume attempt indefinitely. This plan verifies Freshell does not park the pane in a dead runtime state and keeps retrying with capped backoff, but it cannot guarantee upstream success.
- In-flight terminal output during upstream failure may still be lost by the upstream transport. This plan verifies Freshell preserves pane usefulness and input delivery after recovery, not perfect replay of bytes the upstream never delivered.
