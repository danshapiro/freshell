# Codex Turn-Completion Durability Implementation Plan

> **For Claude:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex terminal restore identity mandatory, observable, and promoted only by deterministic evidence. A fresh Codex pane must not accept user input until Freshell has persisted the provider-reported candidate thread id and rollout path, must not treat that candidate as durable, and must promote to `sessionRef` only after the exact rollout file proves the same Codex root TUI `ThreadId`.

**Architecture:** Add a Freshell-owned websocket proxy between the visible Codex TUI and the Codex app-server sidecar. The proxy observes `thread/start` responses and `thread/started` notifications for candidate capture, observes `turn/completed` for the mandatory proof-check boundary, and forwards traffic normally. Terminal input is gated only until candidate persistence is acknowledged. Durable promotion is an event-driven one-shot proof read of the exact rollout path, not a polling loop.

**Tech Stack:** Node.js/TypeScript ESM, `ws`, `node-pty`, Express WebSocket protocol, React 18, Redux Toolkit, Zod, Vitest, Testing Library, superwstest, Freshell orchestration.

---

## Research Contract

- Codex durable restore identity is not a title, cwd, launch time, shell snapshot, or the bare bootstrap id. It is the root TUI `ThreadId` after the exact provider-reported `.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` begins with matching `session_meta` (`docs/lab-notes/2026-05-13-coding-cli-session-restore-research.md:9`, `:15-19`, `:492-504`).
- Fresh `codex --remote <ws>` creates a thread before user work. Freshell must capture that candidate before letting user input through, persist it as candidate-only state, and promote only after rollout proof (`docs/lab-notes/2026-05-13-coding-cli-session-restore-research.md:16`, `:99-127`, `:561-570`).
- Pre-creating a thread through the app-server and launching the TUI with `codex resume <threadId>` before the rollout exists fails with `no rollout found for thread id`; this implementation must remove that launch pattern for fresh Codex panes (`docs/lab-notes/2026-05-13-coding-cli-session-restore-research.md:19`, `:369-412`, `:474-480`, `:550`).
- The Codex source proves the TUI receives `thread/start` response before the `thread/started` notification, both with the candidate id/path, and it does not read terminal input until after the thread is started. Freshell still needs a PTY-side input gate because terminal bytes can queue outside Codex before Freshell persists the candidate (`docs/lab-notes/2026-05-13-coding-cli-session-restore-research.md:440-446`, `:551-553`).
- `turn/completed` is the required proof-check boundary, not proof. On that event for the candidate thread, Freshell must run exactly one direct proof read of the stored rollout path. It promotes only if the file is regular, readable JSONL whose first record is `type == "session_meta"` and `payload.id == candidateThreadId` (`docs/lab-notes/2026-05-13-coding-cli-session-restore-research.md:17`, `:124-134`, `:456`, `:466-468`, `:520-526`, `:555`).
- `fs/watch` is only a wake-up source. A missed filesystem event was observed in the probe, so it cannot be the only promotion path. It also cannot replace the direct proof read (`docs/lab-notes/2026-05-13-coding-cli-session-restore-research.md:325-331`, `:482-490`, `:554`, `:586-588`).
- After `turn/completed`, proof failure is not an acceptable green, grey, or silently live-only steady state. It is `durability_unproven_after_completion` until a deterministic one-shot repair trigger succeeds or the pane becomes non-restorable (`docs/lab-notes/2026-05-13-coding-cli-session-restore-research.md:506-518`, `:520-538`, `:584-590`).
- Reopen of captured-but-unproven Codex state proof-reads first. If proof succeeds, promote and resume. If proof fails and a live terminal is attachable, attach live while keeping the degraded state visible. If no live terminal is attachable, fresh-create a Codex pane and show that the old captured Codex state could not be proven restorable. Do not try `codex resume <candidateThreadId>` before proof (`docs/lab-notes/2026-05-13-coding-cli-session-restore-research.md:540-544`).

## Current Gap In This Worktree

- `server/coding-cli/codex-app-server/launch-planner.ts` currently calls `runtime.startThread()` for fresh Codex launches and returns that id as the launch `sessionId`; `server/ws-handler.ts` then passes it as `resumeSessionId`, so `buildSpawnSpec()` launches the visible TUI with `codex --remote <ws> resume <threadId>`. This is exactly the pre-durable resume pattern the research rejects.
- `server/coding-cli/codex-app-server/protocol.ts`, `client.ts`, and `runtime.ts` handle `thread/started`, lifecycle loss, and `fs/changed`, but do not expose `turn/completed`.
- `server/terminal-registry.ts` writes PTY input immediately once the terminal exists. It has no state that can block input until candidate persistence is acknowledged.
- `src/components/TerminalView.tsx` persists canonical identity only after `terminal.session.associated`; it has no candidate-only Codex durability state and no acknowledgement path back to the server.
- The sidebar and persisted tab state can represent `sessionRef` or legacy `resumeSessionId`, but not a non-canonical Codex candidate. This is why an unpromoted live Codex pane can appear as a generic grey terminal and then split into a second entry when canonical metadata appears later.

## State Model To Implement

- `identity_pending`: fresh Codex TUI has been spawned through the proxy, but no candidate has been durably saved by Freshell. PTY output and resize pass through. User-originating input is blocked.
- `captured_pre_turn`: Freshell has persisted `{ provider: "codex", candidateThreadId, rolloutPath, source, capturedAt }` and received client acknowledgement. Input is allowed. This is not restorable/durable.
- `turn_in_progress_unproven`: the proxy observed `turn/start` or equivalent user-turn activity for the candidate. Live use continues. This is not restorable/durable.
- `proof_checking`: `turn/completed` or a deterministic repair trigger fired and one exact proof read is running.
- `durable`: the proof succeeded. Freshell sends the existing `terminal.session.associated` message with `sessionRef.provider == "codex"` and `sessionRef.sessionId == candidateThreadId`; normal resume uses that id.
- `durability_unproven_after_completion`: proof failed after completion. Live terminal access remains possible if the PTY is alive, but sidebar/pane state must be degraded, not green/normal.
- `non_restorable`: no durable proof exists and no live terminal is attachable. Reopening fresh-creates Codex and keeps a local restore-error explanation.

## Implementation Tasks

### 1. Add Codex Durability Types And Proof Reader

- [ ] Create `shared/codex-durability.ts`.
  - [ ] Export `CodexDurabilityStateName` with the exact state names above.
  - [ ] Export `CodexCandidateIdentity` with `provider: "codex"`, `candidateThreadId`, `rolloutPath`, `source`, `capturedAt`, and optional `cliVersion`.
  - [ ] Export `CodexDurabilityRef` with `schemaVersion: 1`, `state`, `candidate`, optional `turnCompletedAt`, optional `lastProofFailure`, optional `durableThreadId`, and optional `nonRestorableReason`.
  - [ ] Add Zod schemas so persisted client state and websocket payloads are validated instead of using ad hoc objects.
  - [ ] Keep names explicit: use `candidateThreadId`, `rolloutProofId`, and `durableThreadId`, matching the research terminology (`docs/lab-notes/2026-05-13-coding-cli-session-restore-research.md:492-504`).
- [ ] Create `server/coding-cli/codex-app-server/durability-proof.ts`.
  - [ ] Export `proofCodexRollout({ rolloutPath, candidateThreadId, fsImpl? })`.
  - [ ] Require `rolloutPath` to be absolute and non-empty.
  - [ ] `stat()` the exact path and require a regular file.
  - [ ] Read only enough data to parse the first JSONL record; do not scan globs or nearby files.
  - [ ] Require first record JSON to have `type === "session_meta"` and `payload.id === candidateThreadId`.
  - [ ] Return a typed success/failure result with a machine-readable reason: `missing`, `not_regular_file`, `empty`, `malformed_json`, `wrong_record_type`, `missing_payload_id`, `mismatched_thread_id`, `read_error`.
  - [ ] Do not check cwd, date directories, shell snapshots, or filename proximity. The proof is the exact path plus first-record identity (`docs/lab-notes/2026-05-13-coding-cli-session-restore-research.md:456`, `:520-526`).
- [ ] Add `test/unit/server/coding-cli/codex-app-server/durability-proof.test.ts`.
  - [ ] Success: first line is matching `session_meta`.
  - [ ] Failure: missing path, directory, empty file, malformed first line, first line not `session_meta`, missing `payload.id`, mismatched id.
  - [ ] Regression: a later matching line must not succeed if the first record is wrong.

Run:

```bash
npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/durability-proof.test.ts --run
```

Commit:

```bash
git add shared/codex-durability.ts server/coding-cli/codex-app-server/durability-proof.ts test/unit/server/coding-cli/codex-app-server/durability-proof.test.ts
git commit -m "Add Codex rollout durability proof reader"
```

### 2. Add App-Server Event Schemas For Turns

- [ ] Update `server/coding-cli/codex-app-server/protocol.ts`.
  - [ ] Add `CodexTurnStartedNotificationSchema` if the protocol surface is present in the observed app-server traffic or fake server tests need it.
  - [ ] Add `CodexTurnCompletedNotificationSchema` for `method: "turn/completed"` with `params.threadId` and pass-through turn fields.
  - [ ] Export inferred types.
  - [ ] Keep lifecycle parsing separate from turn parsing so lifecycle loss recovery behavior remains unchanged.
- [ ] Update `server/coding-cli/codex-app-server/client.ts`.
  - [ ] Add `onTurnStarted` and `onTurnCompleted` handlers.
  - [ ] Dispatch turn events from notification parsing before generic handling.
  - [ ] Preserve existing `thread/started`, lifecycle loss, disconnect, and `fs/changed` behavior.
- [ ] Update `server/coding-cli/codex-app-server/runtime.ts`.
  - [ ] Re-emit client turn events with `onTurnStarted` and `onTurnCompleted`.
- [ ] Add/update unit tests in:
  - [ ] `test/unit/server/coding-cli/codex-app-server/client.test.ts`
  - [ ] `test/unit/server/coding-cli/codex-app-server/runtime.test.ts`

Run:

```bash
npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/client.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts --run
```

Commit:

```bash
git add server/coding-cli/codex-app-server/protocol.ts server/coding-cli/codex-app-server/client.ts server/coding-cli/codex-app-server/runtime.ts test/unit/server/coding-cli/codex-app-server/client.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts
git commit -m "Observe Codex turn lifecycle notifications"
```

### 3. Add A Freshell-Owned Codex Remote Websocket Proxy

- [ ] Create `server/coding-cli/codex-app-server/remote-proxy.ts`.
  - [ ] Allocate a loopback websocket endpoint for the visible TUI.
  - [ ] Forward TUI websocket traffic to the real app-server sidecar endpoint.
  - [ ] Observe client-to-server JSON-RPC requests and remember request id to method for `thread/start`, `thread/resume`, `turn/start`, and any turn methods present in fixtures.
  - [ ] Observe server-to-client JSON-RPC responses. For a `thread/start` response, parse the `thread` payload and emit candidate `{ threadId, rolloutPath, source: "thread_start_response" }`.
  - [ ] Observe server-to-client notifications. Emit candidate from `thread/started` if no response candidate has been persisted yet; emit `turn_started`, `turn_completed`, `fs_changed`, lifecycle loss, and connection loss events.
  - [ ] If a `turn/start` request arrives before the candidate persistence acknowledgement, hold that request until the acknowledgement completes. If acknowledgement fails or the terminal is shutting down, fail the held request with a clear JSON-RPC error. This is a secondary safety net; the PTY input gate remains the primary guard (`docs/lab-notes/2026-05-13-coding-cli-session-restore-research.md:551-553`).
  - [ ] Do not periodically query the app-server or filesystem from the proxy.
  - [ ] Include structured logs for proxy start, candidate observed, held turn request, released turn request, turn completed, proof trigger, and proxy close/error.
- [ ] Add `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`.
  - [ ] Fresh TUI traffic through the proxy captures candidate from `thread/start` response.
  - [ ] Candidate can also be captured from `thread/started` notification.
  - [ ] `turn/start` before candidate ack is held, then forwarded after ack.
  - [ ] `turn/completed` is emitted with the matching thread id.
  - [ ] Proxy close/error emits a deterministic repair trigger and shuts down without leaking sockets.

Run:

```bash
npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --run
```

Commit:

```bash
git add server/coding-cli/codex-app-server/remote-proxy.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts
git commit -m "Proxy Codex remote traffic for deterministic identity capture"
```

### 4. Replace Fresh Codex Pre-Create/Resume With Fresh Remote Launch

- [ ] Update `server/coding-cli/codex-app-server/launch-planner.ts`.
  - [ ] For fresh Codex launch, call `runtime.ensureReady()` instead of `runtime.startThread()`.
  - [ ] Start a `CodexRemoteProxy` before returning the plan.
  - [ ] Return a launch plan whose `sessionId` is undefined for fresh launches. The fresh visible command must be `codex --remote <proxyWsUrl>` with no `resume <threadId>`.
  - [ ] For durable resume launches, keep `sessionId == resumeSessionId`, route the TUI through the proxy, and keep readiness behavior for the durable id.
  - [ ] Sidecar shutdown must close the proxy and the runtime sidecar.
  - [ ] Sidecar adoption must still update sidecar ownership metadata with terminal id and generation.
  - [ ] Expose proxy events on the sidecar: `onCandidate`, `markCandidatePersisted`, `onTurnStarted`, `onTurnCompleted`, `onRepairTrigger`, `onLifecycleLoss`, and `onFsChanged`.
- [ ] Update `server/ws-handler.ts`.
  - [ ] Do not overwrite `effectiveResumeSessionId` with a fresh Codex plan id when the launch is fresh.
  - [ ] Continue passing `effectiveResumeSessionId` only for proven durable resumes.
  - [ ] Record lifecycle events distinguishing `codex_candidate_pending`, `codex_candidate_captured`, and `codex_durable_session_observed`.
- [ ] Update `server/terminal-registry.ts` recovery spawning.
  - [ ] Durable recovery still spawns `resume <durableThreadId>`.
  - [ ] Fresh launch never spawns `resume <candidateThreadId>`.
- [ ] Update `test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts`.
  - [ ] Fresh `planCreate({ cwd })` must not call `startThread`.
  - [ ] Fresh launch plan remote wsUrl is the proxy wsUrl.
  - [ ] Fresh plan has no durable `sessionId`.
  - [ ] Durable `planCreate({ resumeSessionId })` uses resume id and readiness as before.
- [ ] Update `test/unit/server/ws-handler-sdk.test.ts` or add a focused server WS test.
  - [ ] Fresh `terminal.create` for Codex does not return `effectiveResumeSessionId`.
  - [ ] Durable `terminal.create` for Codex still returns the durable resume id.

Run:

```bash
npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts test/unit/server/ws-handler-sdk.test.ts --run
```

Commit:

```bash
git add server/coding-cli/codex-app-server/launch-planner.ts server/ws-handler.ts server/terminal-registry.ts test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts test/unit/server/ws-handler-sdk.test.ts
git commit -m "Launch fresh Codex without pre-durable resume"
```

### 5. Persist Candidate State Before Releasing Input

- [ ] Update `shared/ws-protocol.ts`.
  - [ ] Add server-to-client `terminal.codex.durability.updated` payload carrying `terminalId` and `CodexDurabilityRef`.
  - [ ] Add client-to-server `terminal.codex.candidate.persisted` with `terminalId`, `candidateThreadId`, `rolloutPath`, and `capturedAt`.
  - [ ] Add optional `codexDurability` to `terminal.create` so persisted captured-but-unproven panes can be repaired or fresh-created deterministically on reopen.
  - [ ] Add error code `CODEX_IDENTITY_PENDING` only if the existing error schema needs a specific code for rejected held input; prefer the durability update path over noisy user-facing errors during normal startup.
- [ ] Update `src/store/paneTypes.ts`, `src/store/types.ts`, `src/store/persistedState.ts`, `src/store/storage-migration.ts`, `src/store/panesSlice.ts`, and `src/store/tabsSlice.ts`.
  - [ ] Add optional `codexDurability?: CodexDurabilityRef` to terminal pane content and tab metadata.
  - [ ] Persist it in localStorage.
  - [ ] Preserve it across tab/pane merge logic.
  - [ ] Clear it when a canonical `sessionRef.provider == "codex"` is set for the same thread id.
  - [ ] Do not backfill it from `resumeSessionId`, cwd, title, or time.
- [ ] Update `src/components/TerminalView.tsx`.
  - [ ] On `terminal.codex.durability.updated`, update pane content with the candidate/degraded state and flush persisted layout immediately.
  - [ ] After flush succeeds, send `terminal.codex.candidate.persisted` for candidate states.
  - [ ] On `terminal.session.associated`, clear matching `codexDurability` and set the canonical `sessionRef` through the existing durable path.
  - [ ] Include persisted `codexDurability` in `terminal.create` when there is no canonical Codex `sessionRef`.
  - [ ] Do not send a candidate thread id as `resumeSessionId`.
- [ ] Update `server/terminal-registry.ts`.
  - [ ] Extend `TerminalRecord` with `codexDurability` and `codexInputGate`.
  - [ ] When proxy emits a candidate, transition to `captured_pre_turn` only after sending `terminal.codex.durability.updated` and receiving the matching `terminal.codex.candidate.persisted` acknowledgement.
  - [ ] While `identity_pending`, `input()` returns a blocked result that `server/ws-handler.ts` can distinguish from invalid terminal id. It must not write to PTY.
  - [ ] Once acknowledgement arrives, call sidecar/proxy `markCandidatePersisted()` and release blocked `turn/start` requests.
  - [ ] Keep terminal resize and output flowing while input is gated.
- [ ] Update `server/ws-handler.ts`.
  - [ ] Handle `terminal.codex.candidate.persisted` and call the registry acknowledgement method.
  - [ ] For blocked input, log at debug/info with terminal id and bytes, but do not misreport it as `INVALID_TERMINAL_ID`.
- [ ] Add/update tests:
  - [ ] `test/unit/server/terminal-registry.codex-sidecar.test.ts`: input is blocked before candidate ack and written after ack.
  - [ ] `test/unit/client/components/TerminalView.test.tsx` or nearest focused test: candidate update persists and sends ack; canonical association clears candidate state.
  - [ ] `test/unit/client/store/*`: persisted state keeps `codexDurability`.

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-registry.codex-sidecar.test.ts test/unit/client/components/TerminalView.test.tsx test/unit/client/store --run
```

Commit:

```bash
git add shared/ws-protocol.ts shared/codex-durability.ts src/store src/components/TerminalView.tsx server/terminal-registry.ts server/ws-handler.ts test/unit/server/terminal-registry.codex-sidecar.test.ts test/unit/client
git commit -m "Persist Codex candidate identity before accepting input"
```

### 6. Promote Durable Codex Identity At Turn Completion

- [ ] Update `server/terminal-registry.ts`.
  - [ ] Subscribe each Codex sidecar/proxy to `turn_started`, `turn_completed`, `fs_changed`, proxy close/error, and lifecycle loss events.
  - [ ] On `turn_started` for the candidate, transition to `turn_in_progress_unproven`.
  - [ ] On `turn_completed` for the candidate, transition to `proof_checking`, run one `proofCodexRollout()` call, and then:
    - [ ] Success: transition to `durable`, bind `resumeSessionId` through the existing `bindSessionToTerminal()` path, emit `terminal.session.associated`, record `codex_durable_session_observed`, and clear candidate state in the client.
    - [ ] Failure: transition to `durability_unproven_after_completion`, emit `terminal.codex.durability.updated`, keep the live PTY attachable if running, and log structured proof failure data.
  - [ ] Coalesce overlapping deterministic proof triggers into at most one extra immediate proof read after the current one finishes. Do not use `setInterval`, delayed backoff loops, or path-existence polling (`docs/lab-notes/2026-05-13-coding-cli-session-restore-research.md:526`).
  - [ ] Watch the exact rollout path and parent if the app-server accepts it, but treat `fs/changed` only as a repair trigger that calls the same proof reader (`docs/lab-notes/2026-05-13-coding-cli-session-restore-research.md:482-490`, `:528-538`).
  - [ ] On PTY exit or app-server/proxy close/error, run one proof read before finalizing state.
- [ ] Update `server/ws-handler.ts`.
  - [ ] Ensure `terminal.session.associated` is sent only after proof success for fresh Codex.
  - [ ] Ensure `sendError` logs server-side structured errors for `RESTORE_UNAVAILABLE`, `CODEX_IDENTITY_PENDING` if added, and Codex proof failures. This closes the silent logging gap from the original observation.
- [ ] Add/update tests:
  - [ ] `test/unit/server/terminal-registry.codex-sidecar.test.ts`: `turn_completed` plus matching rollout emits canonical `terminal.session.associated`.
  - [ ] `test/unit/server/terminal-registry.codex-sidecar.test.ts`: `turn_completed` plus missing/malformed/mismatched rollout emits degraded state and does not bind `resumeSessionId`.
  - [ ] Test trigger coalescing: two repair events during a proof read cause one extra read, not an unbounded loop.
  - [ ] Test PTY exit before/after turn completion.

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-registry.codex-sidecar.test.ts test/unit/server/ws-handler-sdk.test.ts --run
```

Commit:

```bash
git add server/terminal-registry.ts server/ws-handler.ts test/unit/server/terminal-registry.codex-sidecar.test.ts test/unit/server/ws-handler-sdk.test.ts
git commit -m "Promote Codex sessions only after rollout proof"
```

### 7. Reopen Captured-But-Unproven State Deterministically

- [ ] Update `server/ws-handler.ts` create/reuse flow.
  - [ ] When `terminal.create` includes `codexDurability` and no canonical `sessionRef`, ask the registry to run one proof read before deciding how to open.
  - [ ] If proof succeeds, set `effectiveResumeSessionId` to the proven `durableThreadId` and launch a durable resume.
  - [ ] If proof fails and a live terminal on this server matches the exact candidate thread id and rollout path, attach that live terminal and keep degraded/unproven state visible.
  - [ ] If proof fails and no live terminal is attachable, fresh-create a new Codex terminal. Do not pass the candidate as `resumeSessionId`; attach a clear local restore-error/non-restorable state to the pane.
- [ ] Add `TerminalRegistry.findRunningCodexTerminalByCandidate({ candidateThreadId, rolloutPath })`.
  - [ ] Match only exact candidate thread id and exact rollout path stored in the live record.
  - [ ] Do not match by cwd, time, title, or shell snapshot (`docs/lab-notes/2026-05-13-coding-cli-session-restore-research.md:540-544`).
- [ ] Update client sidebar/state rendering.
  - [ ] A live open terminal can show a live/attached indicator only from terminal inventory.
  - [ ] A Codex pane/session must not show normal restorable/durable state until canonical `sessionRef` exists.
  - [ ] `durability_unproven_after_completion` shows degraded/restoration-not-proven state even if live terminal attach is available.
  - [ ] Newly created Codex panes appear in the sidebar immediately as live pending/captured rather than generic grey entries.
- [ ] Add tests:
  - [ ] Server: captured unproven reopen proof success resumes durable id.
  - [ ] Server: captured unproven reopen proof fail plus live exact candidate attaches live and stays degraded.
  - [ ] Server: captured unproven reopen proof fail plus no live exact candidate fresh-creates without passing candidate to resume.
  - [ ] Client/sidebar: live pending Codex appears as Codex, not a generic grey terminal; durable promotion updates the same entry rather than adding a duplicate.

Run:

```bash
npm run test:vitest -- test/unit/server/ws-handler-sdk.test.ts test/unit/server/terminal-registry.findRunningTerminal.test.ts test/unit/client --run
```

Commit:

```bash
git add server/ws-handler.ts server/terminal-registry.ts src test
git commit -m "Repair captured Codex reopen without nondeterministic matching"
```

### 8. Extend Fake Codex Fixtures For Realistic Tests

- [ ] Update `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`.
  - [ ] Keep current app-server fixture mode for `app-server --listen`.
  - [ ] Add fake TUI mode for `--remote <ws>` that connects to the proxy, sends `thread/start` for fresh launch, writes a visible PTY banner, reads stdin, sends `turn/start`, optionally writes rollout JSONL, then sends `turn/completed`.
  - [ ] Add fixture controls for delayed candidate, missing rollout, malformed rollout, mismatched rollout id, delayed `turn/completed`, proxy close, and app-server close.
  - [ ] Ensure fixture processes are tagged with temp env vars so cleanup cannot kill real user sessions.
- [ ] Add or update e2e/integration tests:
  - [ ] Fresh Codex launch: candidate captured, input initially gated, ack releases input, `turn/completed` promotes to canonical `sessionRef`.
  - [ ] Missing rollout after `turn/completed`: state becomes degraded and no canonical `sessionRef` is persisted.
  - [ ] Reopen degraded with later rollout proof: proof-read repairs and resumes durable id.
  - [ ] Reopen degraded without proof after server restart: fresh-creates Codex and does not call `resume <candidateThreadId>`.
  - [ ] Duplicate sidebar regression: a new live Codex terminal stays one sidebar item before and after durable promotion.

Run:

```bash
npm run test:vitest -- test/e2e/codex-session-resilience-flow.test.tsx test/e2e/codex-refresh-rehydrate-flow.test.tsx --run
```

Commit:

```bash
git add test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs test/e2e
git commit -m "Cover Codex durability flow end to end"
```

### 9. Observability And Logging

- [ ] Update `server/session-lifecycle-logger.ts` or the nearest lifecycle telemetry module.
  - [ ] Add lifecycle event kinds for `codex_candidate_observed`, `codex_candidate_persist_requested`, `codex_candidate_persisted`, `codex_input_gate_blocked`, `codex_turn_completed`, `codex_rollout_proof_success`, `codex_rollout_proof_failure`, `codex_repair_triggered`, `codex_reopen_fresh_created`.
- [ ] Update `server/ws-handler.ts` `sendError`.
  - [ ] Log every server-sent error with code, message, requestId, terminalId/session id when present, and connection id.
  - [ ] Avoid relying on stdout/stderr-only messages from child processes; structured server logs should show the reason Freshell chose degraded/fresh-create/restore-unavailable.
- [ ] Add log assertions in focused unit tests where practical, especially for proof failure and restore-unavailable paths.

Run:

```bash
npm run test:vitest -- test/unit/server/ws-handler-sdk.test.ts test/unit/server/terminal-registry.codex-sidecar.test.ts --run
```

Commit:

```bash
git add server test
git commit -m "Log Codex durability transitions and server errors"
```

### 10. Broad Verification

- [ ] Run typecheck and focused tests:

```bash
npm run typecheck
npm run test:vitest -- test/unit/server/coding-cli/codex-app-server test/unit/server/terminal-registry.codex-sidecar.test.ts test/unit/server/ws-handler-sdk.test.ts test/unit/client test/e2e/codex-session-resilience-flow.test.tsx test/e2e/codex-refresh-rehydrate-flow.test.tsx --run
```

- [ ] Run coordinated full check when focused tests are green:

```bash
FRESHELL_TEST_SUMMARY="codex turn-completion durability implementation" npm run check
```

- [ ] Commit any fixes:

```bash
git status --short
git add <changed-files>
git commit -m "Stabilize Codex durability verification"
```

## Temporary Server Validation

Use a port that does not interfere with dev, for example `3477`. Do not restart `/home/user/code/freshell/.worktrees/dev`.

- [ ] Build from the implementation worktree:

```bash
npm run build
```

- [ ] Start a temporary server from this worktree only:

```bash
PORT=3477 npm start > /tmp/freshell-codex-durability-3477.log 2>&1 & echo $! > /tmp/freshell-codex-durability-3477.pid
```

- [ ] Verify the PID belongs to this worktree before stopping it later:

```bash
ps -fp "$(cat /tmp/freshell-codex-durability-3477.pid)"
```

- [ ] Use Freshell orchestration against `http://127.0.0.1:3477` and run each scenario at least three times:
  - [ ] Fresh Codex pane: before candidate capture, input is not accepted; after candidate ack, input works.
  - [ ] Fresh Codex pane: send a real test prompt, wait for Codex to finish, verify canonical `sessionRef` is persisted and sidebar entry remains a single Codex item.
  - [ ] Fresh Codex pane: close/reopen after durable promotion, verify it resumes with `codex --remote <proxy> resume <durableThreadId>`.
  - [ ] Fresh Codex pane: reload browser before first turn completes, verify candidate state is preserved and no candidate id is used as `resumeSessionId`.
  - [ ] Fresh Codex pane: restart only the temporary server after durable promotion, verify reopen resumes durable id.
  - [ ] Fresh Codex pane: simulate/mutate missing rollout after `turn/completed`, verify degraded state and no fake green/normal state.
  - [ ] Captured-but-unproven pane after temporary server restart: verify Freshell proof-reads once and fresh-creates if proof fails, without trying `codex resume <candidateThreadId>`.
  - [ ] Existing durable Codex pane: sidecar lifecycle loss triggers durable recovery and preserves the same sidebar item.
  - [ ] Shell and Claude panes: create, type, close/reopen, and server restart to verify Codex changes did not regress non-Codex terminal state.

- [ ] Inspect `/tmp/freshell-codex-durability-3477.log`.
  - [ ] Confirm structured events exist for candidate observed, candidate persisted, input gate release, turn completed, proof success/failure, and reopen decisions.
  - [ ] Confirm no proof-read polling loop is visible.
  - [ ] Confirm no server-sent errors are silent.

- [ ] Stop only the temporary server:

```bash
kill "$(cat /tmp/freshell-codex-durability-3477.pid)" && rm -f /tmp/freshell-codex-durability-3477.pid
```

## Done Criteria

- Fresh Codex launch no longer pre-creates an app-server thread and no longer TUI-resumes a pre-durable id.
- User-originating Codex input is blocked only until Freshell has persisted the candidate thread id and rollout path.
- `turn/completed` triggers one exact proof read of the provider-reported rollout path.
- Canonical Codex `sessionRef` is persisted only after first-record `session_meta.payload.id` matches the candidate thread id.
- Captured-but-unproven Codex reopen never matches by cwd/time/title and never tries `codex resume <candidateThreadId>` before proof.
- New live Codex panes appear in the sidebar immediately as Codex entries, do not stay generic grey, and do not duplicate on promotion.
- Post-completion proof failure is visible degraded state, not a normal grey/green state.
- Unit, integration/e2e, coordinated check, and repeated temporary-server scenarios pass.
