# Codex Turn-Completion Durability Implementation Plan

> **For Claude:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex terminal restore identity mandatory, observable, and promoted only by deterministic evidence. A fresh Codex pane must not accept user input until Freshell has persisted the provider-reported candidate thread id and rollout path, must not treat that candidate as durable, and must promote to `sessionRef` only after the exact rollout file proves the same Codex root TUI `ThreadId`.

**Architecture:** Add a Freshell-owned websocket proxy between the visible Codex TUI and the Codex app-server sidecar. The proxy observes `thread/start` responses and `thread/started` notifications for candidate capture, observes `turn/completed` for the mandatory proof-check boundary, and forwards traffic normally. Terminal input is gated only until the candidate is atomically written to the Freshell server-side durability store. Durable promotion is an event-driven one-shot proof read of the exact rollout path, not a polling loop.

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
- `server/terminal-registry.ts` writes PTY input immediately once the terminal exists. It has no state that can block input until candidate persistence is complete.
- `src/components/TerminalView.tsx` persists canonical identity only after `terminal.session.associated`; it has no candidate-only Codex durability state and no acknowledgement path back to the server.
- The sidebar and persisted tab state can represent `sessionRef` or legacy `resumeSessionId`, but not a non-canonical Codex candidate. This is why an unpromoted live Codex pane can appear as a generic grey terminal and then split into a second entry when canonical metadata appears later.
- The research document also mentions `durable-rollout-tracker.ts` and a pre-durable stability timer that promotes to `running_live_only` in `/home/user/code/freshell/.worktrees/dev` (`docs/lab-notes/2026-05-13-coding-cli-session-restore-research.md:576-582`). That timer-based promotion is not present in this `origin/main`-based implementation worktree. A `running_live_only` type string still exists in recovery policy code, so this plan avoids removing the enum value unless implementation proves it is dead.

## State Model To Implement

- `identity_pending`: fresh Codex TUI has been spawned through the proxy, but no candidate has been durably saved by Freshell. PTY output and resize pass through. User-originating input is dropped, not buffered or replayed, and the server emits `terminal.input.blocked` for observability.
- `captured_pre_turn`: Freshell has atomically persisted `{ provider: "codex", candidateThreadId, rolloutPath, source, capturedAt }` in the server-side durability store. Input is allowed. This is not restorable/durable. Client localStorage acknowledgement may arrive later and is idempotent.
- `turn_in_progress_unproven`: the proxy observed `turn/start` or equivalent user-turn activity for the candidate. Live use continues. This is not restorable/durable.
- `proof_checking`: `turn/completed` or a deterministic repair trigger fired and one exact proof read is running.
- `durable`: the proof succeeded. Freshell sends the existing `terminal.session.associated` message with `sessionRef.provider == "codex"` and `sessionRef.sessionId == candidateThreadId`; normal resume uses that id.
- `durable_resuming`: a terminal launched from an existing canonical Codex `sessionRef`. It starts from already-proven durable identity and does not return to candidate capture. Normal launch trusts the saved canonical `sessionRef`; if durable proof metadata with `rolloutPath` is also available, repair/list/open paths may proof-read it before resume. If no proof metadata exists, Freshell must not invent one from cwd/time/title.
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
- [ ] Create `server/coding-cli/codex-app-server/durability-store.ts`.
  - [ ] Atomically persist candidate and proof-state records under a Freshell-owned directory, defaulting to `~/.freshell/codex-durability/`.
  - [ ] Key records by `terminalId`, and include `tabId`, `paneId`, `candidateThreadId`, `rolloutPath`, `state`, `capturedAt`, and `serverInstanceId`.
  - [ ] Treat this server-side write as the authoritative gate-release persistence. Client localStorage persistence is still required for refresh/reopen UX, but it is not what releases PTY input.
  - [ ] Make duplicate writes idempotent when `candidateThreadId` and `rolloutPath` match; reject mismatched rewrites for the same terminal.
  - [ ] Delete records when the terminal is killed and either durable `sessionRef` was promoted or the candidate is intentionally abandoned.
- [ ] Add `test/unit/server/coding-cli/codex-app-server/durability-proof.test.ts`.
  - [ ] Success: first line is matching `session_meta`.
  - [ ] Failure: missing path, directory, empty file, malformed first line, first line not `session_meta`, missing `payload.id`, mismatched id.
  - [ ] Regression: a later matching line must not succeed if the first record is wrong.
- [ ] Add `test/unit/server/coding-cli/codex-app-server/durability-store.test.ts`.
  - [ ] Atomic write/read round trip.
  - [ ] Duplicate matching candidate is idempotent.
  - [ ] Mismatched candidate for the same terminal is rejected.
  - [ ] Missing older persisted layouts with no Codex durability data read cleanly and never synthesize a candidate from `resumeSessionId`.

Run:

```bash
npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/durability-proof.test.ts test/unit/server/coding-cli/codex-app-server/durability-store.test.ts --run
```

Commit:

```bash
git add shared/codex-durability.ts server/coding-cli/codex-app-server/durability-proof.ts server/coding-cli/codex-app-server/durability-store.ts test/unit/server/coding-cli/codex-app-server/durability-proof.test.ts test/unit/server/coding-cli/codex-app-server/durability-store.test.ts
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
  - [ ] Parse client-to-server `turn/start` as a generic JSON-RPC envelope by method name; do not require a full request-params Zod schema unless the implementation needs fields beyond the method and id.
  - [ ] Observe server-to-client JSON-RPC responses. For a `thread/start` response, parse the `thread` payload and emit candidate `{ threadId, rolloutPath, source: "thread_start_response" }`.
  - [ ] Observe server-to-client notifications. Emit candidate from `thread/started` if no response candidate has been persisted yet; emit `turn_started`, `turn_completed`, `fs_changed`, lifecycle loss, and connection loss events.
  - [ ] If a `turn/start` request arrives before the server-side candidate persistence write completes, hold that request until the write completes. If the write fails, the terminal is shutting down, or `5_000ms` elapse without a persisted candidate, fail the held request with JSON-RPC error code `-32000` and message `Freshell could not persist Codex restore identity before accepting user input.` Transition the terminal to `non_restorable`, stop that fresh TUI, and fresh-create only if the user explicitly retries.
  - [ ] Also start a candidate-capture deadline when the visible TUI is spawned, independent of user input. If no candidate has been persisted within `10_000ms`, transition the terminal to `non_restorable`, emit `terminal.codex.durability.updated`, send `terminal.input.blocked` with terminal reason `codex_identity_capture_timeout` for any later input, and stop the fresh TUI/sidecar.
  - [ ] Apply the candidate-capture deadline and `turn/start` hold only to fresh Codex launches that do not yet have a canonical durable `sessionRef`. Durable resume launches still pass through the proxy for turn/lifecycle observation, but the proxy must start with candidate persistence disabled, must not arm the fresh-candidate timeout, and must not hold `turn/start`.
  - [ ] On held `turn/start` failure or candidate-capture timeout, return the JSON-RPC error if a request is pending, then close the proxy websocket and kill the PTY process for that failed fresh TUI. Do not leave Codex running against a dead or untrusted proxy, and do not replay held user bytes into a replacement session.
  - [ ] Do not periodically query the app-server or filesystem from the proxy.
  - [ ] Include structured logs for proxy start, candidate observed, held turn request, released turn request, turn completed, proof trigger, and proxy close/error.
- [ ] Ensure readiness ordering is explicit.
  - [ ] `CodexRemoteProxy.start()` must resolve only after the local proxy websocket server is listening and all local event handlers are installed.
  - [ ] `launch-planner.ts` must await proxy readiness before returning the plan that will spawn the visible TUI.
  - [ ] Freshell-owned upstream observer/listener setup must complete before `buildSpawnSpec()` can hand the proxy URL to Codex.
- [ ] Add `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`.
  - [ ] Fresh TUI traffic through the proxy captures candidate from `thread/start` response.
  - [ ] Candidate can also be captured from `thread/started` notification.
  - [ ] `turn/start` before server-side candidate persistence is held, then forwarded after the store write completes.
  - [ ] `turn/start` times out and fails cleanly if candidate persistence never completes.
  - [ ] Candidate-capture timeout fires even when the user never types and no `turn/start` request arrives.
  - [ ] Durable resume proxy traffic forwards `turn/start` immediately and does not emit candidate-capture timeout when no fresh candidate is expected.
  - [ ] Timeout/failure closes the proxy websocket and terminates the failed TUI rather than leaving it running.
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
  - [ ] Start and await a `CodexRemoteProxy` before returning the plan.
  - [ ] Return a launch plan whose `sessionId` is undefined for fresh launches. The fresh visible command must be `codex --remote <proxyWsUrl>` with no `resume <threadId>`.
  - [ ] For durable resume launches, keep `sessionId == resumeSessionId`, route the TUI through the proxy, and keep readiness behavior for the durable id.
  - [ ] Durable resume launches start in `durable_resuming`/`durable`; they construct the proxy with fresh-candidate persistence disabled, do not arm candidate-capture timeout, and do not re-promote on `thread/started`.
  - [ ] Sidecar shutdown must close the proxy and the runtime sidecar.
  - [ ] Sidecar adoption must still update sidecar ownership metadata with terminal id and generation.
  - [ ] Expose proxy events on the sidecar: `onCandidate`, `markCandidatePersisted`, `onTurnStarted`, `onTurnCompleted`, `onRepairTrigger`, `onLifecycleLoss`, and `onFsChanged`.
- [ ] Update `server/ws-handler.ts`.
  - [ ] Do not overwrite `effectiveResumeSessionId` with a fresh Codex plan id when the launch is fresh.
  - [ ] Continue passing `effectiveResumeSessionId` only for proven durable resumes.
  - [ ] Record lifecycle events distinguishing `codex_candidate_pending`, `codex_candidate_captured`, and `codex_durable_session_observed`.
  - [ ] Remove the existing adoption-time `codex_durable_session_observed` emission for fresh Codex. That event must be emitted only after rollout proof success; durable resume can log `codex_durable_resume_started`.
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
  - [ ] Register `terminal.codex.candidate.persisted` in every server-side websocket validator, including the dynamic schema built by `server/ws-handler.ts`, so browser acknowledgements cannot be rejected as `INVALID_MESSAGE`.
  - [ ] Add optional `codexDurability` to `terminal.create` so persisted captured-but-unproven panes can be repaired or fresh-created deterministically on reopen.
  - [ ] Add server-to-client `terminal.input.blocked` with `reason: "codex_identity_pending"` for diagnostic UI/logging when PTY input arrives during the narrow gate. Do not send `INVALID_TERMINAL_ID` for gated input.
- [ ] Update `src/store/paneTypes.ts`, `src/store/types.ts`, `src/store/persistedState.ts`, `src/store/storage-migration.ts`, `src/store/panesSlice.ts`, and `src/store/tabsSlice.ts`.
  - [ ] Add optional `codexDurability?: CodexDurabilityRef` to terminal pane content and tab metadata.
  - [ ] Persist it in localStorage.
  - [ ] Preserve it across tab/pane merge logic.
  - [ ] When canonical `sessionRef.provider == "codex"` is set for the same thread id, retain durable proof metadata if available with `state: "durable"` and clear only degraded/pending warnings. Do not keep a stale non-canonical pending state next to a matching canonical `sessionRef`.
  - [ ] Do not backfill it from `resumeSessionId`, cwd, title, or time.
  - [ ] Add a named migration test: older persisted layouts with no `codexDurability` field must load cleanly and must not synthesize candidate state from `resumeSessionId`.
- [ ] Update `src/components/TerminalView.tsx`.
  - [ ] On `terminal.codex.durability.updated`, update pane content with the candidate/degraded state and flush persisted layout immediately.
  - [ ] After flush succeeds, send `terminal.codex.candidate.persisted` for candidate states. This acknowledgement is idempotent and observational; it must not be required for server-side gate release because the server-side durability store is authoritative.
  - [ ] On `terminal.session.associated`, clear matching `codexDurability` and set the canonical `sessionRef` through the existing durable path.
  - [ ] Include persisted `codexDurability` in `terminal.create` when there is no canonical Codex `sessionRef`.
  - [ ] Do not send a candidate thread id as `resumeSessionId`.
- [ ] Update `server/terminal-registry.ts`.
  - [ ] Extend `TerminalRecord` with `codexDurability` and `codexInputGate`.
  - [ ] When proxy emits a candidate, write it to the server-side durability store first. After that atomic write succeeds, transition to `captured_pre_turn`, emit `terminal.codex.durability.updated`, call sidecar/proxy `markCandidatePersisted()`, and release held `turn/start` requests.
  - [ ] If the candidate store write fails, do not release PTY input or held `turn/start`. Mark the terminal `non_restorable`, log the failure, and keep user work from entering an untracked Codex session.
  - [ ] Change `input()` to return `TerminalInputResult`:
    - [ ] `{ status: "written" }`
    - [ ] `{ status: "blocked_codex_identity_pending"; terminalId: string }`
    - [ ] `{ status: "no_terminal" }`
    - [ ] `{ status: "not_running" }`
  - [ ] Update all callers of `TerminalRegistry.input()` to handle the new result shape.
  - [ ] Keep terminal resize and output flowing while input is gated.
  - [ ] Duplicate or replayed client `terminal.codex.candidate.persisted` acknowledgements succeed only when they match the stored candidate; mismatched acks are logged and ignored.
- [ ] Update `server/ws-handler.ts`.
  - [ ] Handle `terminal.codex.candidate.persisted` and call the registry acknowledgement method.
  - [ ] For blocked input, log at debug/info with terminal id and bytes, send `terminal.input.blocked`, and do not misreport it as `INVALID_TERMINAL_ID`.
  - [ ] Blocked input is dropped, not buffered and not replayed. The user can type again after the gate opens; Freshell must not silently submit stale pre-capture bytes.
- [ ] Add/update tests:
  - [ ] `test/unit/server/terminal-registry.codex-sidecar.test.ts`: input is blocked before server-side candidate persistence and written after the store write completes.
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
  - [ ] Watch the exact rollout path and parent through the Freshell-owned runtime/client connection, not by injecting requests into the TUI proxy socket. This avoids JSON-RPC request-id collisions with the visible TUI. Treat `fs/changed` only as a repair trigger that calls the same proof reader (`docs/lab-notes/2026-05-13-coding-cli-session-restore-research.md:482-490`, `:528-538`).
  - [ ] On PTY exit or app-server/proxy close/error, run one proof read before finalizing state.
- [ ] Update `server/ws-handler.ts`.
  - [ ] Ensure `terminal.session.associated` is sent only after proof success for fresh Codex.
  - [ ] Ensure `sendError` logs server-side structured errors for `RESTORE_UNAVAILABLE` and Codex proof failures. This closes the silent logging gap from the original observation.
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
  - [ ] Ensure all user restore/list/open surfaces funnel through this create/reuse decision: sidebar row click, tab restore, background terminal restore, MCP/new-tab restore, and any history/session open path that creates a Codex terminal.
  - [ ] When `terminal.create` includes `codexDurability` and no canonical `sessionRef`, ask the registry to run one proof read before deciding how to open.
  - [ ] Permit `restore: true` for Codex candidate-only requests when `codexDurability.candidate` is present, even without `sessionRef`, so the proof-first path runs instead of rejecting the request before repair.
  - [ ] Reopen of `durability_unproven_after_completion` follows the same proof-first path as captured-but-unproven. Success promotes; failure with an exact live candidate attaches live and remains degraded; failure with no live attachable terminal becomes `non_restorable` and fresh-creates only for a new Codex session.
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
  - [ ] Own the state-to-sidebar mapping in `src/store/selectors/sidebarSelectors.ts` and render it in `src/components/Sidebar.tsx` or the row component it delegates to:
    - [ ] `identity_pending`: "Starting Codex; restore identity not captured."
    - [ ] `captured_pre_turn`: "Codex identity captured; restore proof pending."
    - [ ] `turn_in_progress_unproven`: "Codex turn running; restore proof pending."
    - [ ] `proof_checking`: "Checking Codex restore proof."
    - [ ] `durability_unproven_after_completion`: "Codex restore proof failed after turn completion."
    - [ ] `non_restorable`: "Codex session could not be proven restorable."
    - [ ] `durable` / `durable_resuming`: normal Codex restorable display.
- [ ] Add tests:
  - [ ] Server: captured unproven reopen proof success resumes durable id.
  - [ ] Server: captured unproven reopen proof fail plus live exact candidate attaches live and stays degraded.
  - [ ] Server: captured unproven reopen proof fail plus no live exact candidate fresh-creates without passing candidate to resume.
  - [ ] Server websocket tests must exercise the real client shape with `restore: true` and candidate-only `codexDurability`, not only raw `terminal.create` messages without restore semantics.
  - [ ] Client/sidebar: live pending Codex appears as Codex, not a generic grey terminal; durable promotion updates the same entry rather than adding a duplicate.
  - [ ] Each restore/list/open surface above uses the same proof-first path and has no independent cwd/time/title matching.

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
  - [ ] Fresh Codex launch: candidate captured, input initially gated, server-side candidate persistence releases input, `turn/completed` promotes to canonical `sessionRef`.
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

### 11. Review Hardening Items

These checks come from the implementation reviews and are part of the same one-shot delivery, not follow-up work.

- [ ] Arm fresh Codex candidate-capture timeout when the proxy is ready, even if the visible Codex TUI never connects. This closes the stuck `identity_pending` state described in the research evidence that input must not be accepted until Freshell has server-persisted Codex's reported restore identity (`/home/user/code/freshell/.worktrees/codex-stability-implementation-20260514/docs/lab-notes/2026-04-20-coding-cli-session-contract.md`, "Working Codex contract").
- [ ] Initialize durable Codex resume records as durable in `TerminalRegistry.create()` when the caller supplies a canonical `sessionRef`. The research says `sessionRef` is the only durable restore identity; a terminal created from one must advertise that same identity through inventory and sidebar state (`/home/user/code/freshell/.worktrees/codex-stability-implementation-20260514/docs/lab-notes/2026-04-20-coding-cli-session-contract.md`, "Recommendation").
- [ ] On final Codex process loss, run exactly one rollout proof if a candidate exists, even if the `turn/completed` notification was lost. Ordinary repair events still wait for `turn/completed`; final loss is the last chance to avoid falsely discarding a restorable session (`/home/user/code/freshell/.worktrees/codex-stability-implementation-20260514/docs/lab-notes/2026-04-20-coding-cli-session-contract.md`, "What remains unproven").
- [ ] Preserve captured candidate state across browser refresh and use it for the recreate request after the old live terminal id is gone. This is the client-side half of "prefer terminal, then proof-read candidate, then fresh-create if proof fails" (`/home/user/code/freshell/.worktrees/codex-stability-implementation-20260514/docs/lab-notes/2026-04-20-coding-cli-session-contract.md`, "Failure handling without polling").
- [ ] Extend the fake app-server/fake TUI integration path so tests exercise actual proxy candidate capture, input, `turn/completed`, rollout proof, durable promotion, and sidebar/inventory exposure instead of only direct sidecar callbacks.
- [ ] Delete transient Codex durability store records when the owning terminal is killed, removed, or reaped. The server-side store is a crash bridge for an active terminal, not a durable session database.
- [ ] If rollout proof succeeds but canonical session binding fails, do not broadcast `terminal.session.associated`; mark the terminal non-restorable instead so the client cannot persist a session the server does not own.
- [ ] After an async candidate-store write completes, re-check that the same terminal is still running and still accepting a candidate before mutating in-memory state or calling `markCandidatePersisted()`.
- [ ] Report input after a candidate-capture timeout as `terminal.input.blocked` with `codex_identity_capture_timeout`, not as a generic invalid/dead terminal.

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

- [ ] Use Freshell orchestration against `http://127.0.0.1:3477` and run each fixture-backed scenario at least three times:
  - [ ] Fresh Codex pane: before candidate capture, input is not accepted; after server-side candidate persistence, input works.
  - [ ] Fresh Codex pane with fake TUI: send a test prompt, wait for fake `turn/completed`, verify canonical `sessionRef` is persisted and sidebar entry remains a single Codex item.
  - [ ] Fresh Codex pane: close/reopen after durable promotion, verify it resumes with `codex --remote <proxy> resume <durableThreadId>`.
  - [ ] Fresh Codex pane: reload browser before first turn completes, verify candidate state is preserved and no candidate id is used as `resumeSessionId`.
  - [ ] Fresh Codex pane: restart only the temporary server after durable promotion, verify reopen resumes durable id.
  - [ ] Fresh Codex pane: simulate/mutate missing rollout after `turn/completed`, verify degraded state and no fake green/normal state.
  - [ ] Captured-but-unproven pane after temporary server restart: verify Freshell proof-reads once and fresh-creates if proof fails, without trying `codex resume <candidateThreadId>`.
  - [ ] Existing durable Codex pane: sidecar lifecycle loss triggers durable recovery and preserves the same sidebar item.
  - [ ] Shell and Claude panes: create, type, close/reopen, and server restart to verify Codex changes did not regress non-Codex terminal state.
- [ ] Run a real Codex smoke only if the machine has working Codex auth and model access:
  - [ ] Fresh real Codex pane: send a short harmless prompt, wait for completion, verify canonical `sessionRef` is persisted and restore works.
  - [ ] If real Codex auth/model access is unavailable, record the skipped reason and rely on fixture-backed scenarios plus unit/integration coverage.

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
