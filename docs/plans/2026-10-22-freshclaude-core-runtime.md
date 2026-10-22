# freshclaude core runtime: final design

Status: design, not yet implemented. Branch `feat/freshclaude-parity` (worktree `.worktrees/freshclaude-parity`), based on `origin/main` 1c7e4dff7.
Scope: freshclaude and kilroy (provider `claude`, one runtime: `FreshClaudeState` plus the Node sidecar in `crates/freshell-claude-sidecar`). Kilroy is sessionType `kilroy` on the same runtime. Every rule below applies to it unless a line says otherwise.
Pinned provider: Claude Agent SDK 0.3.237 with its bundled CLI 2.1.237.

This document merges three candidate designs ("sdk-identity", "codex-parity", "sidecar-authoritative") and the verdicts of two judges. It covers the core-runtime gaps G01–G09, G14–G16, G21–G24, G27 and G32 from the audit, plus part 2 of G25. It also states the interfaces three parallel workstream plans depend on (§9). All scratch evidence lives under `/tmp/claude-1000/-home-dan-code-freshell/1374fc0b-889d-437e-b369-0aa473c2880f/scratchpad/` (below, `$S`).

---

## 0. Decisions in one page

1. **Rust owns turn accounting and alerts.** Rust decides whether the session is busy, handles Stop (the "Stop latch"), and creates every attention edge (`turn.complete`, `turn.waiting`) on one clock per session. The sidecar becomes a thin translator that forwards facts from the CLI. This is the sdk-identity base. Codex and opencode already work this way.
2. **Rust mints the Claude session UUID at create** and passes it to the SDK as `sessionId`. One id serves as map key, envelope stamp, ledger key and pane id from the first frame. Ids that have no transcript yet carry a **genesis** in their binding row: `Fresh`, or `Fork{parent, at, dropsTurn}`. The genesis is cleared only after the transcript has been observed on disk. Reconcile treats a bound id with a genesis as present, so it is restarted after a reboot rather than declared dead.
3. **Boot is verified without a prompt.** The sidecar answers `created` only after `initializationResult()` resolves. Boot refusals come back as typed `create.failed` codes. Nothing ever waits for `system/init`, which only arrives with a prompt. This is the fix for G01 and the basis for fork (G09).
4. **Busy is tracked per command, not per result.** Every send carries a Rust-minted UUID. The CLI's per-command lifecycle frames, its `session_state_changed` frames (enabled by an environment flag the sidecar sets), and turn evidence feed one pure `ClaudeTurnLedger`. CLI-initiated turns are covered, and a conversation reset (`/clear`) re-keys the session to the new id.
5. **Stop targets one thing:** the running command, or else the oldest command not yet started. Commands another device queued keep running and ring when they finish. Rust re-sends the interrupt if the target starts after the Stop, whichever receipt shape the CLI returned. The result verdict depends on the outcome: a Stop that landed is silent, and anything else rings.
6. **A session end is a process end.** The sidecar exits whenever its SDK stream ends. Rust's end-of-output (EOF) path is the only death path. It sends `status: exited`, rings if work was owed, and keeps a dead-session record so the next send, attach or configure resumes the session transparently.
7. **A stuck deadman** watches each busy session. Tool heartbeats count as activity only up to a cap of 12 minutes. A hung MCP tool is therefore flagged (about 22 min), while a Bash call within its 10-minute cap is not. `recovery.stop` is routed to claude.
8. **Undo/redo/fork spawn and boot-verify the replacement before touching the live session.** A drops-turn guard refusal is a typed `ROLLBACK_REFUSED` that keeps the original live, as the SDK requires. It is never retried without the guard.
9. **Delivery order:** alert fixes first, then the lifecycle fixes, then G01, then the move of turn accounting into Rust, then recovery, then the identity migration. Every commit is green and shippable on its own, and old frames stay alive until their consumer switches over.
10. **Test realism (G04).** A real-CLI contract suite pins the facts this design depends on. A simulator plugged into the sidecar's `FRESHELL_CLAUDE_SDK_QUERY_MODULE` seam must match the real CLI. Every Rust and browser test then runs the real `index.mjs`, and the two hand-written protocol fakes are deleted.

---

## 1. How the judges' disagreement was resolved

The judges split. Judge 1 chose sidecar-authoritative (7.3 against 6.6 and 6.4). Judge 2 chose sdk-identity (40 against 37 and 37). **This design starts from sdk-identity's ownership model**, for these reasons:

- **One owner removes a whole class of bugs.** G08 (drifting counters) and G24 (two clocks) both come from splitting busy and edge state between Node and Rust. With Rust as the only owner, they cannot recur. Sidecar-authoritative removes the split in the other direction, but it needs new request/response round trips: a send acknowledgement that waits up to 10 s for the sidecar, a busy refusal decided in the sidecar, and a quiesce probe. It also adds about ten protocol frames to a 24k-line file that is already dense with fences.
- **The flaws that cost sdk-identity points can be fixed by grafting.** Judge 1 penalized it for the /clear crash, death after restart, the genesis flush window, the guard-less retry, Stop over-targeting and a 1-hour heartbeat cap. Each has a fix that the judges themselves listed as a graft (§12 maps every one). Sidecar-authoritative's structural cost cannot be grafted away.
- **It matches the repo's existing pattern.** The AGENTS.md alert contract is server-authoritative. Codex and opencode already own their edges in Rust. The codex `QuietDeadman` and synthesized-edge clock become shared modules (codex-parity's graft).

Where the judges disagreed on facts, I re-checked against the code and the CLI:

| Question | Re-check | Result in this design |
|---|---|---|
| Cold-Stop receipt: `still_queued: []` or `[uuid]`? | `$S/core-design-probe/probe-design2.out` P4: the receipt is `[]` (t=7409) and arrives in the same millisecond as the command's `queued` lifecycle, with `started` 6 ms later. Judge 2's re-run of `design-probes/probe-stop.mjs` gave `[uuid]`. The SDK doc (sdk.d.ts:3765) says survivors are listed and "[] does not mean nothing will run". | Both shapes are real and the order is racy. The re-send rule (§5.4) handles both. No contract test may pin the receipt contents; tests assert the outcome (the turn is aborted, no bell). |
| What does `/clear` leave on disk? | New probe `$S/final-probe/probe-clear-disk.mjs`: `type:'conversation_reset'` (stamped with old id A), then init with new id B. The `/clear` result and its lifecycle carry B. `B.jsonl` exists right after the `/clear` turn, and `resume: B` boots. | /clear re-keys A→B (§4.6). B is treated as materialized, and a `Fresh` genesis covers the flush window. |
| Are CLI-initiated turns visible? | New probe `$S/final-probe/probe-cli-turn.mjs`: after a background Agent finishes, the CLI emits `task_notification`, `session_state_changed: running`, init, result #2, then `idle`. No `command_lifecycle` frame appears, because the turn has no uuid. | The ledger opens a turn on `session_state` running or on turn evidence, so such a turn is busy and rings (§5.2). |
| Does a hung MCP tool heartbeat forever? | Judge 1's `$S/judge1-probe/probe-mcp-hang.mjs`: `tool_progress {heartbeat:true}` every 30 s with no end. | Heartbeats feed the deadman only up to a 12-minute cap (§5.6). |
| After a restart, does reconcile declare zero-turn panes dead? | `crates/freshell-ws/src/reconcile_freshagent.rs:186-196`: Absent plus `ever_observed` gives GoneObserved, which gives DeadSession `session_not_on_disk`. `existence.rs:48-60`: `ever_observed` counts ledger bindings. The terminal claude carve-out at `reconcile.rs:436-470` is the precedent. | A genesis-aware presence rule is added (§4.4). |
| Does the hosted session host wait for init? | `crates/freshell-session-host/src/providers/fresh_agent.rs:436` calls `wait_exact_native(expected)`. The bridge learns claude identity only from init and from `materialized` (`:1110-1160`). | `created` carries `sessionRef` from C10, and the bridge reads identity from it (§7.3). |
| Can the hosted proxy stop a session for recovery? | `crates/freshell-server/src/fresh_agent_proxy.rs:291-300` always answers `UNSUPPORTED_CAPABILITY`. | The client falls back to kill plus resume (§8). |

---

## 2. Ground truth: pinned CLI behavior this design relies on

Each fact was observed against CLI 2.1.237 / SDK 0.3.237 and a local fake Anthropic endpoint. The real API was never contacted.

| # | Fact | Evidence |
|---|---|---|
| T1 | `system/init` is emitted at the start of every turn, and only once a prompt has been pushed. | `$S/init-probe/probe-fork2.mjs`; `design-probe` P1 |
| T2 | `query.initializationResult()` resolves in about 0.6–1.5 s with no prompt. It returns `commands`, `models`, `account`, `pid` (the CLI's pid) and `current_permission_mode`. | `design-probe` P18; `design-probes/probe-boot.mjs` |
| T3 | `sessionId: X` with no resume is honored: init echoes X. Nothing is written until the first prompt. The transcript appears around the first result, and each line lags the SDK frame by 95–200 ms. | `design-probe` P1; `core-design-probe` P1; `live-probe` F7 |
| T4 | `sessionId: X` when `X.jsonl` already exists: boot rejects with `Session ID X is already in use.` and the CLI exits 1. | `design-probe` P3 |
| T5 | Boot refusals arrive with no prompt. First an `error_during_execution` result with `num_turns: 0` arrives on the stream. Then `initializationResult()` rejects and the iterator throws. Messages: `No conversation found with session ID: …` (missing resume), `No message found with message.uuid of: …` (bad fork point), `Resume rejected by --resume-drops-turn: …` (guard). | `core-design-probe/probe-fork-ready.out` R2–R5; `design-probe` P4, P6 |
| T6 | Lazy fork `{resume: P, resumeSessionAt: a, forkSession: true, sessionId: F}`: it boots, and nothing is written until the first prompt. Then `F.jsonl` holds the prefix with P's line uuids preserved, and P is unchanged. Re-spawning the same fork options before that prompt is safe. | `design-probe` P5, P7 |
| T7 | `setModel` and `setPermissionMode` before the first prompt succeed and write nothing to disk. | `design-probe` P8 |
| T8 | Every uuid-stamped send gets `command_lifecycle {command_uuid, state}`: queued, then started, then completed or cancelled. Init advertises `msg_lifecycle_v1`. The frame is @internal and absent from sdk.d.ts. Every executed send is also replayed (`isReplay`) with our uuid, including slash commands. An unknown slash command is not replayed but still gets a lifecycle. The CLI also replays uuids we never sent. | `design-probe` P9; `design-probes` F4–F6, F19 |
| T9 | With `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, `system/session_state_changed` reports `running` when work starts and `idle` when the queue drains, once per drain (not between queued turns). It brackets CLI-initiated turns. | `design-probe` P10; `$S/final-probe/probe-cli-turn.mjs` |
| T10 | A send pushed during a tool call is absorbed: both commands start, one result arrives, and the first command's `completed` follows the result. A send pushed during streamed text queues as its own turn with its own result. | `design-probe` P11, P12 |
| T11 | A warm interrupt produces `subtype: error_during_execution`, `is_error: true`, `terminal_reason: aborted_streaming` (text) or `aborted_tools` (tool), `errors: ["[ede_diagnostic] …"]`, and lifecycle `cancelled`. The receipt arrives before the result. | `design-probe` P13; `init-probe/probe-interrupt.mjs` |
| T12 | A Stop while a second send is queued returns a receipt of `still_queued: [u2]`. The running turn is aborted, and u2 then runs as its own turn. | `core-design-probe` P5 |
| T13 | A cold Stop (CLI still starting): the receipt is `[]` when the interrupt overtook the message, or `[uuid]` when the message was already queued. In both cases the command then runs to `success/completed`. Re-sending `interrupt()` when that command reaches `started`, or when it is replayed, aborts it. | `core-design-probe` P4; `design-probes/probe-stop.mjs` coldretry; judge 2's re-run |
| T14 | If the CLI is SIGKILLed mid-turn, the iterator throws `Claude Code process terminated by signal SIGKILL`. No result arrives, and Node stays alive. A later push is lost. | `design-probe` P15 |
| T15 | `/compact` is an ordinary command with one result. The sequence is `status: compacting`, then `status: null` with `compact_result`, then `compact_boundary`, then the result. A failed compaction also ends in exactly one result. | `design-probes` F17; `live-probe` F8/F9 |
| T16 | `/clear` (also plan-mode exit and fresh-session flows, sdk.d.ts:4129) sends `type: 'conversation_reset' {new_conversation_id}`, then init with the new id B. The result carries B. `B.jsonl` exists right away, and `resume: B` boots. | `$S/final-probe/probe-clear-disk.mjs` |
| T17 | While a tool runs, `tool_progress {heartbeat: true, elapsed_time_seconds}` arrives every 30 s, including for an MCP tool that never answers. A foreground Bash call is capped at 10 min by the CLI (`BASH_MAX_TIMEOUT_MS`). | `design-probe` P17; `judge1-probe/probe-mcp-hang.mjs`; `core-design-probe/probe-heartbeat-70s` |
| T18 | An API error produces an assistant line with `isApiErrorMessage`, then a result with `subtype: success`, `is_error: true`, `terminal_reason: api_error`. | `verify/probe-apierr.mjs` |
| T19 | Background-agent completion starts an unsolicited CLI turn (`task_notification`, init, result) that carries no uuid and no lifecycle. | `live-probe` F6; `$S/final-probe/probe-cli-turn.mjs` |

---

## 3. Architecture

### 3.1 Ownership

| Concern | Owner | Notes |
|---|---|---|
| Session identity, genesis, boot plan, re-keys | Rust | Minted before spawn. Persisted in the binding row. |
| SDK mechanics: query options, boot handshake, input queue, `canUseTool` parking, settings calls | Sidecar | The sidecar makes no turn or attention decisions. |
| Turn ledger (busy), Stop latch, effective status, deadman | Rust | Folded from the facts the sidecar forwards (§5). |
| Attention edges (`turn.complete`, `turn.waiting`) | Rust | One choke point, `ClaudeEdgeHub::emit` (§5.5), with one `AttentionClock` per durable id. The clock survives death, resume and re-keys. |
| Death detection | Rust | EOF on the sidecar's stdout. The sidecar exits whenever its SDK stream ends. |
| Logs | Both | The sidecar writes JSONL with a severity to stderr. Rust re-emits it through `tracing`, and logs every edge and decision itself. |

### 3.2 Module layout (new code goes into small modules, not the 24k-line `claude.rs`)

| Module | Contents |
|---|---|
| `crates/freshell-freshagent/src/attention.rs` (shared) | `AttentionClock` (`mint`, `observe`, `floor`), `turn_complete_event`, `mint_synthesized_edge`. Moved from codex (`codex.rs:11162`); codex becomes a thin wrapper. |
| `crates/freshell-freshagent/src/quiet_deadman.rs` (shared) | `QuietDeadman` and its waiter, moved from `codex.rs:693-711, 7768-7849, 10465-10530`. Adds `window_from_env`. Codex behavior is unchanged. |
| `claude_turns.rs` | `ClaudeTurnLedger`, `StopLatch`, `ResultVerdict`, `effective_status`. Pure and synchronous. |
| `claude_launch.rs` | `ClaudeGenesis`, `ClaudeBoot`, `ClaudeLaunchSpec`, `decide_boot`, `create_request()` (the only builder of a sidecar `create` line). |
| `claude_sidecar_io.rs` | `SidecarWriter` (one writer task per runtime, with a write timeout) and `spawn_stderr_logger`. |
| `claude_edges.rs` | `ClaudeEdgeHub` (the choke point), `ClaudeTurnEvent`, the `AttentionObserver` trait. |
| `claude.rs` | Handlers, `establish_runtime`, `ensure_runtime`, the consumer, the rollback/fork flows. |
| `claude_spawn.rs` | **Reserved for the API/ops workstream** (G30/G31: `ClaudeNodeCommand`, `SidecarTreeGuard`). Core does not use this name. |
| Sidecar `boot.mjs` | `bootOptions(boot, sessionId)` and `classifyBootError(err)`. Pure and unit-tested on the exact real-CLI strings. |
| Sidecar `sdk-message-frames.mjs` | The pure mapping from SDK message to frames. Created by whichever lands first, transcript-live B1 or core C05, and shared (§9.1 N6). |
| Sidecar `log.mjs` | `log(severity, event, fields)` |

### 3.3 Session record

```rust
/// One open claude pane lineage, keyed by its durable id. Removed on kill.
struct ClaudeSession {
    durable_id: String,                       // map key == envelope stamp == ledger key (from C23)
    session_type: SessionType,                // Freshclaude | Kilroy
    config: ClaudeConfiguration,              // settings (+plugins), commands, runtime_cwd
    ledger: Arc<StdMutex<ClaudeTurnLedger>>,  // the busy truth (§5.2)
    pending: Arc<StdMutex<ClaudePending>>,    // approvals/questions (existing type)
    clock: AttentionClock,                    // shared attention clock (§5.5)
    deadman: QuietDeadmanHandle,              // §5.6
    turn_lock: Arc<TokioMutex<()>>,           // send / configure / compact / rollback / fork serialization
    published_status: Arc<StdMutex<String>>,  // last broadcast effective status
    runtime: ClaudeRuntime,                   // writer, child, pids, ownership_id, consumer, stderr task
    owning_operation: Option<String>, owning_generation: Option<u64>,  // as today
}

/// Kept after an unrequested death (bounded LRU, 256 entries, mirroring codex's dead-thread cache).
struct DeadClaudeSession {
    durable_id, session_type, config, clock: AttentionClock, turn_lock, cause: ExitCause, at_ms,
}
```

Deleted over the sequence: `in_turn`, `turn_tracker`, `result_idle_pair_pending`, `rollback_probe_slot`, `last_status`, `last_synthesized_complete_at`, `broadcast_id`, `cli_session_id`, `sidecar_session_id`. The incarnation guard becomes `ownership_id`, which is unique per spawn. On `FreshClaudeState`, these go: `cli_index`, `naming_handles` and `close_pending`. The `alias_tombstones` write path goes too, but the **read** path stays (§4.7).

---

## 4. Identity, boot and history

### 4.1 Durable id and genesis

`handle_create` (fresh lane, from C23) mints `D = Uuid::new_v4()` when the request arrives. D is:
- the map key and the envelope stamp;
- `freshAgent.created.sessionId`, with `sessionRef = {claude, D}`;
- the binding, rollback-record and ownership-coordinator key;
- the naming target;
- the SDK `sessionId` for a fresh boot, or the `resume` value for every later boot.

```rust
enum ClaudeGenesis {
    Fresh,                                                             // boot with sessionId: id
    Fork { parent: String, at: Option<String>, drops_turn: Option<String> }, // boot as a lazy fork
}
```

The genesis is stored in `BindingRow.genesis`, which is serde-optional under `LEDGER_VERSION` 1. **It is cleared only after the transcript has been observed on disk.** This happens at the first `sdk.result` while a genesis is set: a `spawn_blocking` locate retries up to 10 times, 200 ms apart, then rewrites the binding with `genesis: None`. `decide_boot` also clears it whenever it finds the transcript. So a CLI death in the window before the transcript is flushed never loses the session (T3). And a transcript that was conversed and later deleted is still judged gone, because by then the genesis is cleared.

### 4.2 Boot decision (`decide_boot`, used by every launch)

| Transcript for id | Genesis | Boot |
|---|---|---|
| Found | any (cleared lazily) | `Resume{resume: id}`, or the transcript path when the original cwd is gone (today's escape hatch) |
| Absent | `Fresh` | `Fresh{sessionId: id}` |
| Absent | `Fork{parent, at, dropsTurn}` | `Fork{resume: parent, resumeSessionAt: at, forkSession: true, sessionId: id, resumeDropsTurn}`. With `at: None`, fork the whole parent. |
| Absent | none | **Lost**: the nested `INVALID_SESSION_ID` lost frame. Never spawn. |
| Unreadable (IO error, no store root) | – | **Transient**, never Lost. This uses G28's `TranscriptLocation`. If that has not landed, it uses the existing `locate_transcript_checked` (§9.3 I8). |

How each typed boot failure (`create.failed.code`) is handled:

| Code | Source string (T4/T5) | Handling |
|---|---|---|
| `SESSION_ID_IN_USE` | `Session ID … is already in use` | A transcript appeared between the check and the spawn. Retry once as `Resume`. |
| `CONVERSATION_NOT_FOUND` | `No conversation found with session ID` | With a genesis: retry once per the genesis. Otherwise: Lost. |
| `RESUME_POINT_NOT_FOUND` | `No message found with message.uuid of` | Rollback/fork: typed `ROLLBACK_REFUSED` or `FORK_REFUSED`. The original stays live. |
| `FORK_GUARD_REFUSED` | `Resume rejected by --resume-drops-turn` | Typed `ROLLBACK_REFUSED` ("Claude folded another message into that turn, so it can't be undone to that point"). **No guard-less retry.** The SDK says consumers "MUST … clear the pending fork target and resume plainly … not retry" (sdk.d.ts:1877-1880), and the plain resume is simply the still-live original. |
| `BOOT_FAILED` / budget timeout (45 s) | anything else | Transient |
| `SIDECAR_PROTOCOL_MISMATCH` | `created.protocol != 2` | Transient. Logged at error. It catches a packaged app pairing a stale sidecar with a new server. |

**Boot results never reach the turn machinery.** The real CLI emits the refusal as an `error_during_execution` result before `initializationResult()` rejects (T5). The sidecar holds a `booted` flag that is false until `created` is emitted. Before that, a `result` only supplies the `create.failed` message, and every other frame is dropped. The Rust handshake reader forwards nothing before `created`: pre-`created` lines are logged at debug and dropped. Tests on both sides pin this.

### 4.3 Zero-turn sessions and pending forks

| Case | Behavior |
|---|---|
| Create, no send, reload | The attach finds the live record and acknowledges `idle`. The snapshot returns 200 with empty `turns` (served from the `Fresh` genesis). |
| Create, no send, server restart | Reconcile says `respawn` (§4.4). The attach finds no record, and establish boots `Fresh{sessionId: D}` (T3). |
| Create, no send, sidecar crash | The dead record goes to `exited`. Resume boots `Fresh` again. There is no file, so no collision (T4 cannot happen). |
| Model or mode changed before the first send | Written to the binding settings (T7). A later boot uses them. |
| Undo, then restart before sending | The binding for C holds `Fork{A, at}`. Reconcile says `respawn`. Establish re-boots the same fork (T6). The snapshot is A's prefix through `at`. |
| Crash between the first prompt and the transcript flush | The genesis is still set (§4.1), so the boot follows the genesis. Once the file exists, `Resume` wins. |

### 4.4 Reconcile and existence (the restart fix)

`reconcile_freshagent.rs` (presence arm, `:178-205`):
- `has_live_session(id)` is true only for a Live record. A dead record is not live: presence falls through to the existence probe, the verdict is `respawn`, and the client's attach brings it back through `ensure_runtime`.
- New rule for claude, mirroring the terminal carve-out at `reconcile.rs:436`: if the probe says `Absent`, **and** `pane_ledger.binding_genesis("claude", id).is_some()`, **and** `!existence.ever_observed_on_disk("claude", id)`, then presence is `OnDisk` and the verdict is `respawn` (subject to the existing respawn cap). An id whose transcript was once seen and is now gone still falls through to `GoneObserved`, which gives `dead_session`.
- New `PaneLedger::binding_genesis(provider, id) -> Option<Value>` (an in-memory read). The same rule is applied in `existence.rs`'s gate path, so the warm and cold paths agree.

### 4.5 Rollback v2 (undo/redo) and fork

**Effective transcript of a session X:**
- if X is materialized, `X.jsonl`;
- if X is a pending `Fork{P, at}`, P's raw chain truncated through `at` (inclusive, using the existing raw-chain helpers);
- if X is `Fresh`, empty.

**Source collapse:** forking from a pending fork forks its parent P at the new point instead. Chains never nest, so a second undo without a send in between works.

**Rollback anchors** (fixes transcript plan N7): a single predicate `is_rollback_anchor` replaces `is_user_anchor` (`claude_snapshot.rs:789`), and the transcript projector shares it. A real prompt anchors, and so does a `<command-name>` user line. `<local-command-stdout|stderr>` wrappers, lines with `origin.kind == "task-notification"`, `isMeta` lines and compact summaries do not. Undo steps therefore match the turns the pane renders.

**`handle_rollback` v2:**
1. Resolve A (§4.8). Take the `rollback_in_flight(A)` single-flight, then `turn_lock(A)`. The lock order is unchanged.
2. Busy gate: `ledger.busy()` refuses with `BUSY_TURN`. Until C17 lands, the existing tracker plus the quiesce probe make this check.
3. Compute the keep point on A's effective transcript with the existing helpers (`resolve_resume_point`, `redo_resume_target`, tip and longest-common-prefix checks). The source is A, or A's parent after collapse (undo), or the chain root (redo).
4. Mint C. The genesis is `Fork{source, at, dropsTurn: guard}`, or `Fresh` for a first-turn undo. A full redo to the root tip uses `Resume{root}`.
5. Pre-write the rollback record so it is durable before anything changes (as today). Emit the pending-card cancellations for A.
6. **Spawn before teardown:** `establish_runtime(C)` runs while A is still alive. A is idle, and the fork only reads A's file and writes nothing until its first prompt (T6). On any failure: compensate the record, tear down the half-spawned C, and answer the typed error. **A is untouched and still live.** `FORK_GUARD_REFUSED` and `RESUME_POINT_NOT_FOUND` become `ROLLBACK_REFUSED`.
7. One awaited ledger batch: binding C (`genesis`, A's settings and plugins, `supersedes: A`, `name_transition: InternalContinuation`) plus the rollback-record re-key A→C.
8. `rekey_record(A → C, Rollback)` (§4.6): runtime C goes in, and the clock, `turn_lock` and pending state carry over. Then tear down A's runtime as a requested, silent teardown.
9. Broadcast `session.materialized {A→C}` and `rolledBack`, then acknowledge the requester.

A send that was parked on `turn_lock(A)` re-resolves after the lock through the **durable ledger chain** (`pane_ledger.lookup_by_session("claude", A)` gives the corrected terminus C). It is never resolved through an in-memory forward with a time limit, and never through `decide_boot(A)`. A's transcript exists, so that would revive the pre-rollback conversation as a second live session.

**`handle_fork` (G09), with an eager, boot-verified child runtime (codex/opencode parity):**
1. Resolve parent A and take its `turn_lock`. Refuse with `BUSY_TURN` while busy.
2. The keep point is the last chain entry of the step group containing `input.atTurnId` (strip any `:row-N` suffix, as codex does), or the tip. Apply source collapse.
3. Mint C. Run `establish_runtime(C, Fork{source, at, drops_turn: None})`. The binding gets provenance from the forking connection and **no** `supersedes`.
4. Reply `freshAgent.forked {parentSessionId: A, sessionId: C, sessionRef, requestId}` on the requesting connection. The client re-points the pane and kills A (the existing flow at `FreshAgentView.tsx:3188-3230`).
5. Remove the claude cell from the refusal table (`terminal.rs:9553-9562`), add the claude arm (`terminal.rs:2226-2256`) and route fork in the session host. The snapshot stamps `capabilities.fork: true`; the client already gates it on idle.

**Pending-fork snapshot:** the source's prefix rebuilt with the existing parser, stamped `threadId = sessionId = C`, with `revision = max(binding.updated_at, record.last_op_at_ms)`. Line uuids survive a fork (T6), so turn ids do not change when the fork materializes.

### 4.6 Re-keys: rollback, conversation reset and the legacy migration

`rekey_record(old, new, reason)` is the only place an envelope id changes:
- **Under the map lock:** move the record (runtime, ledger, pending, clock, deadman, `turn_lock`) from `old` to `new`.
- **Ledger:** write binding `new` with `supersedes: old`. The genesis depends on the reason: `Fork…` for a rollback, `Fresh` for a reset (it covers the flush window and is cleared lazily), none for the legacy migration.
- **Broadcast** `freshAgent.session.materialized {previousSessionId: old, sessionId: new, sessionRef}`.
- **Notify** `AttentionObserver::on_rekeyed(old, new)` (§9.2 I-2).
- **Session host:** the bridge emits `AgentEvent::Started{new}` on `materialized`, as it does today.

**Conversation reset (T16).** The sidecar maps `type: 'conversation_reset'` to `sdk.session.rekeyed {sessionId: A, newSessionId: B, reason: 'conversation_reset'}`. Rust calls `rekey_record(A → B, Reset)`. The ledger entry (the `/clear` command is still in flight) moves with the record, so its result retires normally under B.
- **Init becomes verify-only.** If `cliSessionId != durable_id` and no reset preceded it, log at error (`freshagent.claude.unannounced_rekey`) and still `rekey_record(…, Unannounced)`. The CLI decides which file it writes, so following it is safer than letting the snapshot freeze. The session is never torn down.

### 4.7 Legacy placeholder data (backward compatibility)

| Case | Behavior |
|---|---|
| L1: a persisted pane has a nanoid `sessionId` and a durable `sessionRef` | Client hydration re-keys `sessionId := sessionRef.sessionId` (C26). For tabs that stayed open across the deploy, the server's attach path covers it: a non-UUID id with a durable `sessionRef` establishes the durable id, broadcasts `materialized(placeholder → durable)`, then acknowledges. |
| L2: a placeholder pane with no `sessionRef` (zero-turn under the old code) | The lost frame, then today's recovery recreates the session. Unchanged. |
| L3: a kill by placeholder | The persisted alias-tombstone **read** path (`claude.rs:3940-3956`, `sink.alias_tombstone_records`) still resolves the placeholder to its durable row for the retire. No new tombstones are written after C27. The read path stays for at least one release. |
| L4: old binding rows (no genesis, no plugins) | Resume from the transcript, exactly as today. Plugins come from the request when present. |
| L5: rollback records | The schema and `ROLLBACK_RECORD_VERSION` 1 are unchanged. The genesis lives in the binding row. |
| L6: orphaned `record_pending` markers | No longer written for claude. They age out through the boot scan (`PENDING_MARKER_ORPHAN_TTL_MS`). |
| L7: old client, new server | `created` carries a UUID plus `sessionRef`. The client already accepts UUID claude ids. `freshAgent.result.sessionBusy` is additive. |
| L8: new client, old server | The new client behavior (Resume, stop-for-recovery for claude, `sessionBusy`) only triggers on statuses and fields an old server never sends. |
| L9: a create re-driven after a restart | `identity_sink.lookup_by_create_request_id` maps the requestId to the id it already minted. The create becomes a resume. |

### 4.8 Resolving an incoming id (every handler)

Each handler resolves the id it receives in this order, and stops at the first match:
1. A map hit (a Live record).
2. The ledger chain terminus: `lookup_by_session(...)` with `corrected` true means a different terminus, so use it (an attach also gets a `materialized` frame on the reply sink).
3. A legacy placeholder: before C27 through `cli_index`, after that through the tombstone read (kill), or `sessionRef` (attach).
4. The dead map, which leads to `ensure_runtime`.
5. A UUID with a transcript or genesis, which leads to `ensure_runtime`.
6. Otherwise, the nested lost frame (`INVALID_SESSION_ID`). A send also gets a request-correlated error, so the client's owned-send cleanup runs.

`ensure_runtime(id, fence)` is the analog of codex's `ensure_session_alive`. It is single-flight through `resuming`. It runs `establish_runtime(decide_boot(id))` under the existing lease, ownership claim and kill-fence discipline, then removes the dead entry and moves its clock and `turn_lock` across.

### 4.9 `establish_runtime`: one spawn and commit path

```
claim(ownership, id) → lease(id) → decide_boot (§4.2) → spawn_sidecar → write create_request(spec)
  → await created | create.failed            (SIDECAR_CREATE_BUDGET = 45 s; typed retries per §4.2)
  → commit_session_claim (kill fence) → register record → post-registration dead-state recheck
  → binding write (awaited: settings + plugins + genesis [+ supersedes]) → lease.complete
  → commit_lane_claim Live → naming bind → Established{cli_pid}
```

`establish_runtime` absorbs the spawn/commit bodies of `handle_create` (resume lane), `resume_for_attach`, `resume_for_handoff` and the rollback respawn. Every existing guard is **moved, not rewritten**: the `claim_dead_state` snapshot, the post-registration recheck, the lease-revoke arm and the commit-stale arm. The existing kill/claim/commit race tests run against it unchanged. `ClaudeLaunchSpec::create_request()` is the only builder of a `create` line, and it always carries `plugins` and `hostedMcp: self.hosted_mcp` (G15).

---

## 5. Turns, Stop, alerts, stuck

### 5.1 Sidecar ⇄ Rust protocol v2 (stdio NDJSON)

Rust → sidecar:

| Frame | Shape | From |
|---|---|---|
| `create` | `{protocol: 2, requestId, sessionId, sessionType, boot: {kind:'fresh'} \| {kind:'resume', resume} \| {kind:'fork', resume, resumeSessionAt?, dropsTurn?}, cwd?, model?, permissionMode?, effort?, plugins?, hostedMcp?}`. Mapping: fresh → `{sessionId}`; resume → `{resume}` (never `sessionId`, which the SDK forbids with resume unless forking); fork → `{resume, resumeSessionAt, forkSession: true, sessionId, resumeDropsTurn}`. Before C23, `sessionId` is required only for fork and rollback. | C10, C13, C23 |
| `send` | `{sessionId, uuid (required, Rust-minted), text, images?, checkpointAttempt?: {logicalAttemptId, requestId}}`. The checkpoint attempt reuses `uuid`. | C16 |
| `interrupt` | `{sessionId, stopId}` | C18 |
| `configure`, `permission.respond`, `question.respond`, `shutdown` | unchanged | |
| `rollback.quiesce` | **removed** | C17 |

Sidecar → Rust:

| Frame | Shape / meaning | From |
|---|---|---|
| `created` | `{requestId, sessionId, protocol: 2, cliPid}`, emitted only after `initializationResult()` resolves. The command catalog is published from that result. | C10 |
| `create.failed` | `{requestId, code, message}` (codes in §4.2). The sidecar then exits with code 2. | C10 |
| `sdk.session.init` | `{sessionId, cliSessionId, model, cwd, tools, capabilities}`. Rust verifies the id only (§4.6). | C10/C24 |
| `sdk.session.rekeyed` | `{sessionId: A, newSessionId: B, reason: 'conversation_reset'}` | C24 |
| `sdk.command` | `{sessionId, uuid, state: queued\|started\|completed\|cancelled\|discarded\|replayed}`. `replayed` is sent when a sent uuid is replayed (the fallback for CLIs without lifecycle frames, and the "first content" signal in §5.4). Unknown uuids are not forwarded. | C16 |
| `sdk.session.state` | `{sessionId, state: running\|idle\|requires_action}`. The sidecar sets `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` in the CLI environment. | C16 |
| `sdk.status` | `{sessionId, status: 'compacting' \| null, compactResult?, compactError?, permissionMode?}`. `null` is new (T15). The `requesting` status is turn evidence. | C16 |
| `sdk.heartbeat` | `{sessionId, kind: 'tool'\|'task'\|'retry', toolUseId?, elapsedMs?}`, rate-limited to one per 5 s per kind. It comes from `tool_progress`, `task_*` and `api_retry`. It is liveness only and is never forwarded to clients. | C16 |
| `sdk.result` | `{sessionId, subtype, isError, terminalReason, numTurns, errorText?, durationMs, costUsd, usage}`. `errorText` is `errors.join` with every `[ede_diagnostic] …` entry removed. | C16 |
| `sdk.interrupt_settled` | `{sessionId, stopId, ok, stillQueued?: [uuid], message?}` | C18 |
| `sdk.send.rejected` | `{sessionId, uuid, code: 'INVALID_IMAGE'\|…, message}`. A bad image no longer crashes the sidecar. | C16 |
| `sdk.stream.ended` | `{sessionId, reason: 'cli_exited'\|'stream_error'\|'stream_eof', message}`. The last line before exit code 3. A requested teardown exits 0 without it. | C08 |
| Content frames | `sdk.assistant`, `sdk.stream`, `sdk.compact_boundary`, `sdk.session.changed`, `sdk.configured`, `sdk.permission.*`, `sdk.question.*`, `sdk.checkpointTurnIdentity`, plus workstream frames (`sdk.retry`, `sdk.notice`, `sdk.session.metadata`). `sdk.session.changed{session-commands}` is published only when the catalog actually changes. | unchanged |
| `sdk.error` | Narrowed to request-level failures. The `turnFailure` and `sessionNotFound` variants are removed. | C18 |
| `sdk.turn.complete`, `sdk.turn.waiting`, `sdk.status:'idle'`, `sdk.exit`, `sdk.rollback.quiesced` | **Removed.** Each is kept alive until its Rust consumer switches over (the staging rule in §10), then deleted in the same commit as that switch. | C17/C18 |

### 5.2 `ClaudeTurnLedger` (pure; `claude_turns.rs`)

```rust
struct ClaudeTurnLedger {
    commands: VecDeque<Cmd>,          // acceptance order; Cmd{uuid, request_id, kind: Turn|Compact, phase: Accepted|Queued|Started}
    turn_open: bool,                  // the CLI is working on a turn (any origin)
    compacting: bool,
    lifecycle_capable: bool,          // first sdk.command, or init capability msg_lifecycle_v1
    stop: Option<StopLatch>,
}
busy() = !commands.is_empty() || turn_open || compacting
```

| Input | Effect |
|---|---|
| `arm(uuid, request_id, kind)` | Runs under `turn_lock`, before the write. Pushes `Accepted`. If busy rises, publish `running`. |
| `undo_arm(uuid)` | On a write failure or `sdk.send.rejected`. |
| `sdk.command queued` | Sets the phase. |
| `sdk.command started` / `replayed` (first one wins) | Sets phase `Started` and `turn_open = true`. |
| `sdk.command completed/cancelled/discarded` | Removes the command (idempotent). An unknown uuid is ignored and logged at debug. |
| `sdk.session.state running/requires_action` | `turn_open = true`. This covers CLI-initiated turns (T9, T19). |
| `sdk.session.state idle` | `turn_open = false`. Every `Started` command is removed (a started command cannot outlive an idle). `compacting = false`. `Accepted`/`Queued` commands stay, because a just-pushed send can race an idle (T9). |
| Turn evidence: `sdk.session.init`, `sdk.status requesting`, `sdk.assistant`, `sdk.stream` | `turn_open = true`. This is the fallback when `session_state` is absent. Trailers after a result (lifecycle `completed`, `idle`) never open a turn. |
| `sdk.status compacting` / `null`, `sdk.compact_boundary` | Sets or clears `compacting`. |
| `sdk.result` | Computes the verdict first (§5.3). Then `retired` = every `Started` command (exact: only one turn runs at a time, and absorbed commands start inside it, T10). Old-CLI fallback: if none started and `!lifecycle_capable`, retire the oldest `Accepted` command (the unknown-slash-command case, T8), logged as `ledger.fallback_head_retire`. Remove `retired`, then set `turn_open = false` and `compacting = false`. |
| EOF | Returns `owed = busy()`, then clears everything. |

Retiring at the result, and closing `turn_open` there, is what makes a single ring per result exact. A CLI death after the result but before the trailing lifecycle or idle finds nothing owed, so it adds no second ring.

`effective_status(dead, stuck)`: `exited`, else `stuck`, else `compacting`, else `running` if busy, else `idle`. This one function feeds status pushes, attach acknowledgements and snapshot overlays.

`publish_status()` runs after every ledger, deadman or lifecycle change and broadcasts `freshAgent.status` on change. **After every forwarded `freshAgent.result`, Rust also re-broadcasts the effective status whenever it is not `idle`.** The result frame carries `sessionBusy: ledger.busy()`, computed after the fold. Together these fix the client's `turnResult`, which today forces `idle` (`freshAgentSlice.ts:585-597`), while a queued command is still owed (T10).

### 5.3 Result verdict

```
aborted = terminalReason ∈ {aborted_streaming, aborted_tools}
          || (terminalReason absent && subtype == error_during_execution && stop armed)   // older CLIs
silent  = aborted && stop armed
          && (retired non-empty && retired ⊆ stop.targets  ||  retired empty && stop.target == CliTurn)
on sdk.result:
   silent                       → no turn.complete, no banner; latch cleared
   subtype != success           → turn.complete + nested freshAgent.error CLAUDE_TURN_FAILED (sanitized errorText,
                                   else per-subtype copy; an abort with no user Stop: "Claude stopped the turn
                                   before it finished.")
   else (incl. success+is_error) → turn.complete   (no banner: the transcript plan renders the API-error item, T18)
```

"Silent" applies only to work the Stop targeted. A command that started after the Stop, or another device's command that a mistaken re-send aborted, rings.

### 5.4 Stop latch (single target, re-send rule)

```
handle_interrupt(msg):
  dead → re-broadcast status exited; unknown → nested INVALID_SESSION_ID
  !busy → no-op (logged freshagent.claude.stop {outcome: idle})
  target = Started commands (the running turn)           → awaiting_start = None
         | else oldest Accepted/Queued command T          → awaiting_start = Some(T)
         | else turn_open (CLI-initiated turn)            → CliTurn
  stop = StopLatch{stop_id, targets, awaiting_start, receipt: Pending, t_lifecycle_before_receipt: false, reissues: 0}
  write interrupt{stopId}; write failure → stop = None, nested CLAUDE_INTERRUPT_FAILED
sdk.interrupt_settled ok:false            → stop = None; nested CLAUDE_INTERRUPT_FAILED (requestId = the interrupt's)
sdk.interrupt_settled ok:true{stillQueued} → receipt = Received{lists_target: stillQueued ∋ T}; evaluate
sdk.command queued/started/replayed (T)   → note it (and whether it came before the receipt); evaluate
evaluate (awaiting_start = Some(T), T unsettled, reissues < 2):
  Case A — receipt lists T, OR the receipt arrived before any lifecycle frame of T:
           re-send when BOTH the receipt and T `started` (or `replayed`) have been seen (whichever is second)
  Case B — receipt [] AND T's queued/started arrived before the receipt (ambiguous: the interrupt may
           have landed on T, or the observed order swapped): re-send on T's first content (`replayed`, or an
           sdk.assistant/sdk.stream while T is the only Started command), unless T settles first
  after a re-send: reissues += 1; awaiting_start = None   (the new interrupt aborts the running T)
latch clears: every target retired (result, terminal lifecycle, idle), EOF, kill, recovery stop
```

Why this shape:
- **Both cold-receipt shapes are real (T13), and the order of receipt versus lifecycle is racy.** Case A handles the overtaking and pre-wait shapes either way round.
- **Case B waits for content** because the turn only produces content if the first interrupt did not land on it. P4 shows the replay about 80 ms after `started`, so the cost is a fraction of a second of extra running.
- **A wrong re-send costs little.** It hits an idle CLI (a no-op) or the next queued command. That command is not a target, so its turn rings (§5.3). Nothing is silenced by mistake, and every re-send is logged with its case.
- **Single target (codex-parity).** Commands queued behind the running turn are listed as survivors and "WILL run" (T12, sdk.d.ts:3765). They are left alone and ring normally. Stopping another device's queued message would be an unrequested change to the product.

### 5.5 Attention edges: one choke point

`ClaudeEdgeHub::emit(record, kind: TurnComplete|Waiting, source: Result|Death|Deadman|Pending)`:
1. Mints `at` on the record's `AttentionClock`. This is `next_monotonic_turn_complete_at` over one stored value, so the result, death and deadman sources cannot collide (G24). The clock carries across rekeys and death/resume, and starts fresh after a server restart (the regime AGENTS.md already accepts).
2. Logs `freshagent.turn.complete` or `freshagent.turn.waiting` at info, with `provider, session_id, session_type, source, at`. Ids only, never content (codex DIAG-01 shape).
3. Broadcasts the existing client frame. The shape is unchanged.
4. Calls `AttentionObserver` hooks (client-alerts plan I-1).
5. Publishes a typed `ClaudeTurnEvent` (API plan I3).

Edge sources:

| Source | Rule |
|---|---|
| Result | The verdict in §5.3. |
| Death (unrequested EOF) | Rings if `ledger.owed` was true. Idle deaths and requested teardowns (kill, rollback swap, recovery stop, shutdown) are silent. |
| Deadman | §5.6 |
| Waiting | When `fold_pending_frame` reports that the pending approvals and questions went from 0 to 1 or more. It uses its own namespace on the client, unchanged. When pending drops back to 0: `AttentionObserver::on_pending_drained`. |

### 5.6 Stuck deadman (shared `quiet_deadman.rs`)

- **Window:** `W = FRESHELL_FRESHCLAUDE_QUIET_WINDOW_MS`, default 600 000 ms (10 minutes, codex parity).
- **In flight:** `ledger.busy() && pending.is_empty()`. A pending approval or question pauses the deadman: the user is blocking, not the agent, and `turn.waiting` has already rung. Codex does not pause here; that part is not copied.
- **Feed:** every sidecar stdout line re-arms the window, including the transcript plan's `sdk.retry`/`sdk.notice`/`sdk.session.changed`, **except** an `sdk.heartbeat{kind:'tool'}` whose `elapsedMs >= C`. The cap `C = FRESHELL_FRESHCLAUDE_TOOL_HEARTBEAT_CAP_MS`, default `BASH_MAX_TIMEOUT_MS` from the server environment (else 600 000) + 120 000, which is 12 minutes. In practice:
  - A legitimate Bash call within its 10-minute CLI cap is never flagged.
  - A turn with no frames at all (an API stall) is flagged at W, 10 minutes.
  - A hung MCP tool that heartbeats forever (T17) is flagged at about C + W, roughly 22 minutes, instead of never (sidecar-authoritative) or after 70 minutes (sdk-identity's 1-hour cap).
  - Task/subagent and retry heartbeats always feed, because they are progress.
- **Fire:** if the generation is unchanged and the session is busy and not paused, the status becomes `stuck` and the hub emits one edge (`source: quiet_deadman`). Any later line clears `stuck` (back to `running`) and re-arms. A later real result rings its own edge (codex parity).
- **Recovery:** `freshAgent.recovery.stop` routes by provider (`terminal.rs:2136-2143`). `FreshClaudeState::handle_recovery_stop` does a requested teardown of the process only, keeps the row bound, moves the record to the dead map with cause `RecoveryStop`, and answers `freshAgent.recovery.stopped`. The client then calls `triggerRecovery()`.

### 5.7 Death and the sidecar's end of stream

- **Sidecar `consumeStream` finally block:** cancel pending cards. If the end was not requested, emit `sdk.stream.ended{reason, message}`, flush stdout, and exit with code 3. A requested abort or shutdown exits 0 and emits nothing alert-related.
- **Rust EOF arm**, after checking `ownership_id` so a stale consumer is ignored:
  - Evict the record into the dead map and release the lease and ownership stamp (as today's eviction does). Disarm the deadman.
  - Broadcast `freshAgent.status{exited}`.
  - Broadcast nested `freshAgent.error{SIDECAR_EXITED}` with the cause from `sdk.stream.ended` or the exit status.
  - If `owed`, the hub emits a death edge.
  - Publish `ClaudeTurnEvent::Ended{reason}`.
- **Interim, from C08 until C18:** the sidecar still creates the result-less edge in its `finally` block. During that window the Rust EOF arm **skips its own ring when `sdk.stream.ended` was seen**, and rings only for a Node death, which produces no `stream.ended`. Tests pin exactly one `turn.complete` per result-less end in each phase.

### 5.8 Stdin writer (G27)

`SidecarWriter` is a task that owns `ChildStdin`, fed through an mpsc channel. Each write gets `timeout(FRESHELL_FRESHCLAUDE_WRITE_TIMEOUT_MS = 10 s, write_all + flush)`. Handlers clone the writer under the map lock, drop the lock, then await. A timeout or a broken pipe means the sidecar is wedged: kill the child **without** removing the record, so the unrequested EOF path runs (ring if owed, then `exited`, then transparent resume). `respond_session_guard` returns a writer and a pending handle instead of a `MappedMutexGuard` over the whole map.

### 5.9 Logging (G14)

**Sidecar** (`log.mjs`, JSONL on stderr):
- `sidecar.ready`, `boot.ok`: info. `boot.failed`: warn.
- `interrupt.failed`, `configure.failed`, `respond.unknown`, `send.rejected`: warn.
- `stream.ended`: warn for an error, info for EOF.
- `cli.stderr`: info, truncated to 2 KiB. In hosted mode, a byte count only, as today.
- Prompt text is never logged.

**Rust** (`spawn_stderr_logger` replaces `drain_reader`, `claude.rs:9709`):
- Parses each line and re-emits it at its severity, with `session_id`, `session_type` and `ownership_id`.
- Non-JSON lines are logged at warn with `raw=true` (truncated to 4 KiB; byte count only in hosted mode).
- Rate-limited to 50 lines/s per sidecar, with a periodic dropped-lines summary.

**Rust decisions:**
- `freshagent.turn.complete` and `freshagent.turn.waiting` (info, with source);
- `freshagent.claude.stop` (info: `stop_id`, target, case, reissues);
- `freshagent.claude.boot` (info: boot kind, retry, code);
- `freshagent.claude.status` (debug, on change);
- `freshagent.claude.deadman` (armed, paused, fired);
- `freshagent.claude.sidecar_exit` (warn: cause, exit status);
- `freshagent.claude.rekey` (info: reason);
- `ledger.fallback_head_retire` (warn).

### 5.10 Restart notice (G25 part 2; client-alerts plan I-5)

`FreshClaudeState::shutdown`: before draining, for every Live record whose ledger is owed, call `PaneIdentitySink::mark_turn_interrupted("claude", id, at)`. This is backed by a new serde-optional `BindingRow.turn_interrupted_at`, awaited with a 500 ms bound. On the next `establish_runtime` of that id, after the acknowledgement, broadcast nested `freshAgent.error{code: 'TURN_INTERRUPTED_BY_RESTART', message: 'The server restarted while this turn was running. The turn was stopped. Send a message to continue.'}`, then clear the marker. No edge is sent, because a restart is a requested teardown under AGENTS.md.

---

## 6. Rust → client frames

| Frame | Change |
|---|---|
| `freshAgent.created` | Carries `sessionRef` for resume creates from C10. From C23, `sessionId` is the durable UUID, always with `sessionRef`. Sent after the boot is verified. |
| `freshAgent.send.accepted` | `submittedTurnId` is the send's UUID (C16), which equals the persisted user line's uuid and so the snapshot `turnId`. Absorbed sends have no own user line. |
| `freshAgent.event{freshAgent.status}` | Rust-authored for claude: `running` (at accept), `idle`, `compacting`, `stuck`, `exited`. Re-broadcast after a result while not idle. |
| `freshAgent.result` | Adds `sessionBusy` (additive). |
| `freshAgent.event{freshAgent.turn.complete \| turn.waiting}` | Shape unchanged. Rust-minted only. |
| `freshAgent.event{freshAgent.error}` | `CLAUDE_TURN_FAILED` (sanitized), `SIDECAR_EXITED` (with cause), `CLAUDE_INTERRUPT_FAILED` (nested, with requestId), `CLAUDE_SEND_REJECTED` (with requestId), `INVALID_SESSION_ID` (nested, for configure/interrupt/send on unresolvable ids), `TURN_INTERRUPTED_BY_RESTART`. None for a user Stop. |
| `freshAgent.session.materialized` | Rollback, conversation reset, unannounced re-key and legacy placeholder migration. On an attach by a superseded id, also sent on the reply sink. |
| `freshAgent.forked` | New for claude, sent on the requesting connection. |
| `freshAgent.recovery.stopped` | New for claude and kilroy. |
| `freshAgent.event{freshAgent.session.snapshot}` (attach acknowledgement) | Sent **on the requesting connection only**, with the effective status (G21). |
| REST snapshot | Served for zero-turn ids and pending forks. `statusFromLiveState: true` for Live and dead records (`exited`). `capabilities.fork: true`. |

---

## 7. Attach, multi-device, hosted

### 7.1 `handle_attach(msg, reply: ConnSink)`

`terminal.rs:1965` passes the connection sink.

| State | Action |
|---|---|
| Live (map hit) | Run the coordinator gate (unchanged). Send `status_snapshot_frame(id, effective_status)` on `reply`. |
| Superseded (ledger terminus ≠ id) | Send `materialized(id → terminus)` on `reply`, then handle the terminus. |
| Dead | `ensure_runtime`, then acknowledge (Recovered). |
| No record, UUID with transcript or genesis | `ensure_runtime`, then acknowledge. |
| Non-UUID with durable `sessionRef`/`resumeSessionId` (L1) | Establish the durable id, broadcast `materialized(placeholder → durable)`, then acknowledge. |
| Otherwise | The lost frame (unchanged client recovery). |

`try_rebind_to_live`'s stamp flip is deleted (C25). Every device addresses the session by the same durable id, so the G16 split cannot happen. A create-resume from a second device finds the live record and answers `created{durable}`.

### 7.2 Configure, compact, interrupt on non-live ids (G22)

- **configure:** on a Live record, apply it. On a dead record, store the settings in the dead entry and the binding, answer `freshAgent.session.metadata`, and apply them at the next establish. On an unknown id, the nested lost frame.
- **compact:** goes through the send path, after `ensure_runtime`.
- **interrupt:** §5.4.

### 7.3 Hosted session host

`crates/freshell-session-host/src/providers/fresh_agent.rs`:
- **C10:** for claude/kilroy, `start` takes the native id from `freshAgent.created.sessionRef.sessionId` (resume) instead of `wait_exact_native(expected)` waiting for an init. The bridge stops emitting `AgentEvent::Started` on every per-turn init and emits it once, at `created` (when the id is known) or at `materialized`.
- **C23:** fresh starts also resolve from `created.sessionId`, which is now a UUID.
- **C14:** `fork()` routes claude to `FreshClaudeState::handle_fork`.
- `hostedMcp` rides every launch through `create_request()`.
- The hosted web proxy still refuses `recovery.stop` (`fresh_agent_proxy.rs:291`). The client falls back (§8). Routing it through the host is optional follow-up work in the API plan's G29 PR.

---

## 8. Client changes (core-owned)

- **`src/store/freshAgentSlice.ts`:**
  - `turnResult` writes `running` when `sessionBusy === true`, else `idle`.
  - Status `exited` replaces `compacting`. Pinned by a test.
- **`src/lib/fresh-agent-ws.ts`:** passes `sessionBusy` through. `CLAUDE_SEND_REJECTED` with a requestId is routed to the owned-send failure path.
- **`src/components/fresh-agent/FreshAgentView.tsx`:**
  - The session-ended card (≈4624) shows **Resume session** for `provider === 'claude'` (freshclaude and kilroy) when the status is `exited` and a canonical id is present. It reuses `triggerRecovery`.
  - `restartStuckSidecar` (≈2398) sends `freshAgent.recovery.stop` for claude with the pane's own provider and sessionType, instead of the hard-coded `'freshcodex'`. On `UNSUPPORTED_CAPABILITY` (hosted proxy) it falls back to kill plus `triggerRecovery`.
  - Owned-send failure (≈3063-3121): for claude (`SESSION_NOT_FOUND`, `INVALID_SESSION_ID`, `CLAUDE_SEND_REJECTED`), the text goes back into the composer with "Message not sent: <reason>".
- **Pane hydration:** the L1 claude placeholder re-key (`sessionId := sessionRef.sessionId` when the id is not a UUID and `sessionRef.provider === 'claude'`).
- **Fork affordances** appear through `capabilities.fork`. No code change; capability tests only.

---

## 9. Interface contract with the three workstream plans

### 9.1 Transcript and live rendering ([transcript-live plan](2026-10-22-freshclaude-transcript-live.md), G10/G12/G13)

| ID | Their need | What core provides | When | If core has not landed |
|---|---|---|---|---|
| N1 | A real `index.mjs` plus scripted-SDK harness for WS and browser tests | One simulator, `test/fixtures/claude-cli-sim/query.mjs`, through `FRESHELL_CLAUDE_SDK_QUERY_MODULE`, with scenario programs through `FRESHELL_CLAUDE_SIM_PROGRAM`. The transcript plan's `FRESHELL_CLAUDE_SDK_SCRIPT` is an alias. Rust `RealSidecarSim`/`RealSidecarCli` rigs live in `crates/freshell-ws/tests/common/claude_rig.rs`. | C02–C04 | If their E1 lands first, core's C02 extends that module. There is only ever one simulator. |
| N2 | `running` at accept; effective status on acknowledgements | Rust-authored `freshAgent.status` from the ledger. Rust consumes `sdk.status` (`compacting`/`null`) and never forwards it raw. Their interim `sdk.status running` after a compaction is unnecessary: when `compacting` clears, the ledger recomputes `running`. | C17 (C25 for acknowledgements) | If their interim frame lands first, C17 deletes it. The ledger treats `sdk.status running` as a no-op. |
| N3 | Sidecar stderr JSON reaches `tracing` | `spawn_stderr_logger` | C07 | – |
| N4 | Unsolicited CLI turns (task notifications) handled for busy and the bell | `sdk.session.state` plus turn evidence open a turn with no command. Its result rings. | C16–C18 | – |
| N5 | New exit signals reach `sessionExited`/`status exited/stuck` | `freshAgent.status{exited}` (C09) and `{stuck}` (C22), only through `freshAgent.status` | C09, C22 | – |
| N6 | `case 'result'` and the interrupt paths are owned by core; the pure mapper is shared | Core edits `sdk-message-frames.mjs`, one function per SDK message kind. Core owns `result`, `command_lifecycle`, `session_state_changed`, `conversation_reset`, `tool_progress`/`task_*` (heartbeat), and `status` compacting/null. The transcript plan owns `assistant`/`stream_event`/`user` content, `sdk.retry`, `sdk.notice` and `sdk.session.changed{transcript}`. | C05 creates the module if B1 has not | The second to land rebases. Each function has its own unit tests. |
| N7 | `is_user_anchor` mis-steps on command, stdout and notification lines | A shared `is_rollback_anchor` predicate (§4.5), also used by their projector | C13 | – |
| – | Deadman awareness of their new frames | Any stdout line feeds the deadman, so `sdk.retry`/`sdk.notice`/`sdk.session.changed` count as activity | C22 | – |
| – | API-error banner policy | Core sends no banner for `success && is_error`. Their projector renders the error item. | C18 | – |

### 9.2 Client alerts and UX ([client-alerts-ux plan](2026-10-22-freshclaude-client-alerts-ux.md), G11/G17/G20/G25/G26)

| ID | Their need | What core provides | When |
|---|---|---|---|
| I-1 | One edge choke point | `ClaudeEdgeHub::emit` (§5.5), plus `trait AttentionObserver: Send + Sync { fn on_registered(&self, id, session_type); fn on_turn_complete(&self, id, session_type, at); fn on_waiting(&self, id, session_type, at); fn on_pending_drained(&self, id); fn on_rekeyed(&self, old, new); fn on_forgotten(&self, id); }`, held as `Option<Arc<dyn AttentionObserver>>` on `FreshClaudeState` (installed with `with_attention_observer`). Their `AttentionLedger` implements it. Before C18, C07 routes the two existing mint/forward sites through a `emit_attention_edge` shim so that they have a hook from C07 on. | C07 (shim), C18 (hub) |
| I-2 | A hook whenever the envelope id changes | `rekey_record` is the only place ids change, and it calls `on_rekeyed`. After C23 there are no stamp flips, only rekeys. | C13, C24, C26 |
| I-3 | The fake supports permission suggestions, `blockedPath`, `decisionReason`, `ExitPlanMode` and permission-mode reporting | The simulator drives `canUseTool` with those fields and emits `system/status {permissionMode}` as the CLI does. Their D0 contract test is the source of truth. | C02 |
| I-4 | Busy and status truth | C09, C17 | |
| I-5 | Restart notice | §5.10 | C28 |
| I-6 | Plan-mode change (part of G12) | Core does not fold `permissionMode`. It forwards `sdk.status.permissionMode` untouched, and their mapper function emits `sdk.session.metadata`. | – |

### 9.3 API, MCP, hosted, operations ([api-hosted-ops plan](2026-10-22-freshclaude-api-hosted-ops.md), G18/G19/G28–G31)

| ID | Their need | What core provides | When |
|---|---|---|---|
| I1 | `handle_create(msg, provenance) -> ClaudeCreateOutcome` | `enum ClaudeCreateOutcome { Created { session_id, session_ref: Option<SessionLocator> }, Failed { code, message, retryable, owner: Option<TerminalOwnerFields> } }`. WS frames stay byte-identical, and the dispatcher ignores the value. | C11 |
| I2 | `handle_send(msg) -> ClaudeSendOutcome` | `enum ClaudeSendOutcome { Accepted { session_key, submitted_turn_id }, Refused { code, message } }`. Also `FreshClaudeState::session_busy(id) -> Option<bool>`. | C16 |
| I3 | A typed turn-event stream | `FreshClaudeState::subscribe_turn_events() -> broadcast::Receiver<ClaudeTurnEvent>`, where `enum ClaudeTurnEvent { Settled { session_key, retired_request_ids: Vec<String>, retired_command_ids: Vec<String>, outcome: Completed\|Failed\|Interrupted, at: Option<i64> }, Waiting { session_key, at }, Ended { session_key, reason } }`. It is published from the hub on a dedicated low-volume channel, so it can never lag because of `sdk.stream` traffic. `Settled` is published for silent results too, with `at: None`. | C18 |
| I4 | One launch builder | `ClaudeLaunchSpec` plus `create_request()` in `claude_launch.rs`. The G19 fields (`freshellMcp`, `freshellContext`) are added there by their PR3, as `Option` fields that core passes through unchanged. | C11 |
| I5 | Resume-on-send for a dead session | `ensure_runtime` | C20 |
| I6 | `created.session_id` may change | It becomes the durable UUID. Treat it as opaque. | C23 |
| I7 | Real `index.mjs` plus scripted-SDK Rust harness | `claude_rig.rs` | C04 |
| I8 | G01 consumes the G28 `TranscriptLocation` | `decide_boot` and rollback match on `TranscriptLocation::{Found, Absent, Unreadable}`. **Their PR1 (G28) should land before C11.** If it has not, C11 adds the enum under their names in `claude_snapshot.rs`, and PR1 only extends it. | C11 |
| G31 | Graceful teardown and a tree guard | Core's sidecar exits 0 silently on `shutdown`, and the EOF arm treats a record removed before teardown as requested, so their "write shutdown, then wait 2 s for the child" composes. `establish_runtime` stores whatever guard `spawn_sidecar` returns. The module name `claude_spawn.rs` is theirs. | – |
| G29 | Hosted configure routing | Core's configure semantics (dead → store + metadata, unknown → nested lost frame) apply unchanged inside the session host. | – |
| e2e | Their specs use `fake-claude-sdk-sidecar.mjs` | C30 retires that fake. Their specs move to the real sidecar plus the simulator (I7) in the same commit. | C30 |

---

## 10. Ordered TDD commit sequence

Every commit is red → green → refactor and leaves the suite green. Five rules apply throughout:
1. **Red tests drive real code.** When a commit changes an area, that area's tests move off the protocol fakes onto the real `index.mjs` plus the simulator, and the moved tests are the red tests.
2. **Old frames stay alive until their consumer switches.** A sidecar frame keeps being emitted until the Rust consumer is switched over, and both change in the same commit.
3. **Nothing is skipped.** Tests that encoded fake-only framing are rewritten, never skipped.
4. **Characterization commits are the exception.** C01 is green when written: it pins the external CLI and fails on drift.
5. **PR boundaries.** Each PR (A–G) can merge on its own.

### PR-A: ground truth and alert containment (sidecar fixes; Rust keeps its current turn logic)

| # | Commit | Red first | Notes and tests that change |
|---|---|---|---|
| C01 | `test(claude): real-CLI contract suite pins the CLI facts` | `test/integration/providers/claude-cli-contract.test.ts`, one named `it` per fact T1–T19 | Extracts the fake endpoint into `test/integration/providers/claude-local-provider.mjs`, with modes: text, slow, Bash tool, API error status, hang, a hung stdio MCP server, and an async Agent. The existing `claude-checkpoint-uuid-replay.mjs` imports it. Cold-Stop scenarios assert the outcome (aborted after a re-send), never the receipt contents. The suite fails, rather than skips, when the pinned CLI is missing. |
| C02 | `test(claude): CLI simulator that matches the real CLI` | `claude-cli-conformance.test.ts` with `target: sim` fails | The simulator implements T1–T19: per-turn init, lifecycle, session state, replays, absorption vs queueing, both cold-Stop receipt shapes (a knob), boot refusals, `sessionId`/fork lazy JSONL under `CLAUDE_CONFIG_DIR`, `/compact`, `/clear`, CLI-initiated turns, heartbeats (`FRESHELL_CLAUDE_SIM_TIME_SCALE`), crash, hang, stdin stall, and `canUseTool` with suggestions and `ExitPlanMode`. Programs come from `FRESHELL_CLAUDE_SIM_PROGRAM` (it ports the e2e fake's rule language). The test compares normalized traces against `target: real`. |
| C03 | `test(claude-sidecar): unit tests run the real index.mjs over the simulator` | (port) | `test/unit/claude-sidecar/harness.ts` (`startRealSidecar`). Ports `interrupt-idle-gate`, `user-message-replay`, `permission-channel`, `rollback-quiesce` and `session-settings` with unchanged assertions; only their init-at-create fixtures go. |
| C04 | `test(rust): RealSidecarSim and RealSidecarCli rigs` | `freshagent_claude_real_cli.rs::create_send_result_rings_once` | `crates/freshell-ws/tests/common/claude_rig.rs`, behind a `test-support` feature. A green smoke test on both rigs (today's plain turn works). |
| C05 | `fix(freshclaude): a user Stop shows no error banner (G03)` | A sidecar harness test: Stop mid-turn (real T11 shape) gives no `sdk.error`. A unit test: `[ede_diagnostic]` is stripped. e2e `fresh-agent-error-turn-attention.spec.ts` Stop lane (moved to real sidecar plus simulator): no "Agent error" banner. | Creates `sdk-message-frames.mjs` if transcript B1 has not. The gate's verdict is consulted before the failure banner. |
| C06 | `fix(freshclaude): the Stop gate silences only aborted results (G06 bell)` | Sidecar harness: a cold-window Stop followed by `success/completed` gives `sdk.turn.complete`. A stale mark never swallows the next turn's bell. | `turn-complete-gate.mjs` takes the result. Interim, deleted in C18. |
| C07 | `feat(freshclaude): structured sidecar logs and edge logs (G14)` | Rust: a sidecar writing JSONL stderr produces captured `tracing` events at the parsed severity (rate-limit summary; hosted byte counts). Sidecar: `ready` at info. Rust: a forwarded `sdk.turn.complete` is logged as `freshagent.turn.complete`. | `log.mjs`, `spawn_stderr_logger`, and the `emit_attention_edge` shim around the two existing edge sites (I-1). |

### PR-B: lifecycle truth (G02, G05 status, G23, boot handshake)

| # | Commit | Red first | Notes and tests that change |
|---|---|---|---|
| C08 | `fix(freshclaude): the sidecar exits when its SDK stream ends (G02, G23)` | Sidecar: a simulator crash produces `sdk.stream.ended` and exit code 3; shutdown exits 0 silently. WS (RealSidecarSim): a CLI crash mid-turn gives **exactly one** `turn.complete` and `SIDECAR_EXITED` with the cause, and the sidecar process is gone. A natural end of stream mid-turn leaves the session not busy. A Node SIGKILL mid-turn gives exactly one ring. | Deletes `result_idle_pair_pending`, its tests and its doc comment (`claude.rs:638-653`). Interim ring rule (§5.7). The fakes stop emitting a per-turn idle. The e2e STREAM_ERROR lane (`fresh-agent-error-turn-attention.spec.ts:89-97`) now expects an exit. |
| C09 | `feat(freshclaude): exited status, dead-session record and Resume (G05)` | WS: SIGKILL mid-`/compact` gives `status exited`, one ring, and an `exited` snapshot. An idle death does not ring. A send to a dead id gives the nested lost frame plus a request error. `has_live_session` is false for a dead id. Client: Resume is rendered for claude/kilroy on `exited`; `exited` replaces `compacting`; a failed send restores the composer. e2e: a background crash gives `turnCompletion.seq` +1, a highlight and Resume, and the Resume restores the conversation with no reload (freshclaude and kilroy). | The dead map (§3.3). The kilroy crash lane in `fresh-agent-control-rust.spec.ts` asserts `turnCompletion.seq` and Resume. |
| C10 | `feat(freshclaude): created only after the CLI boots; typed boot failures` | Sidecar: the `classifyBootError` table on the exact T4/T5 strings. A refused boot emits **no** `sdk.result` and exits 2. A protocol mismatch fails fast. WS: a create-resume of a missing transcript gives `create.failed`, not `created` followed by a zombie. A bad `CLAUDE_CMD` gives `create.failed`. The handshake reader forwards no line before `created`. Session host: a claude resume `start` resolves from `created.sessionRef` with no prompt (fails today). | `boot.mjs`. `protocol: 2`. The commands catalog comes from `initializationResult()` and is published only on change. `created.sessionRef` is set for resume creates. The bridge emits `Started` once. |

### PR-C: launch, genesis, history (G15, G01, G09)

| # | Commit | Red first | Notes and tests that change |
|---|---|---|---|
| C11 | `refactor(freshclaude): one launch spec and one establish path (G15)` | A create-line parity test: the create, attach-resume, handoff-resume and rollback lines all carry `plugins` and `hostedMcp` (the simulator records the `query()` options). A ledger round trip of `BindingRow.plugins`. The existing kill/claim/commit race tests run unchanged against `establish_runtime`. | `claude_launch.rs`. `FreshAgentSettings.plugins`. `ClaudeCreateOutcome` (I1). `TranscriptLocation` (I8). |
| C12 | `feat(freshclaude): genesis in the binding row; genesis-aware snapshot and reconcile` | `pane_ledger_tests`: the field round-trips, an old row parses, and the genesis is cleared lazily. `claude_snapshot`: `Fresh` gives empty; `Fork` gives the parent prefix through `at` with turn ids preserved; unreadable gives Io. Reconcile: Absent + genesis + never on disk gives `respawn`; Absent + once-observed gives `dead_session`. REST: a bound pending id gives 200. | Inert until C13 writes a genesis. |
| C13 | `fix(freshclaude): undo/redo through a boot-verified fork runtime (G01)` | `freshagent_claude_rollback.rs` moved to RealSidecarSim **fails today**, because no init ever arrives. New tests: undo answers within the budget with `materialized A→C`; the next send materializes C; redo works; undo twice without a send works (source collapse); first-turn undo works; a guard refusal gives `ROLLBACK_REFUSED` and A is still live and accepts a send; a spawn failure leaves A live; a send parked on the lock lands on C through the ledger chain; restart after an undo restores the pending fork. Anchor-predicate tests on real `/cost`, `/compact` and task-notification lines. Real-CLI lane: undo, then send, then redo. e2e: `fresh-agent-rollback-rust.spec.ts` on the real sidecar plus simulator, plus "undo, restart before sending, the prefix is kept". | Deletes `read_session_init`, `rollback_spawn_create` and the init pre-read. The busy gate is still the tracker plus quiesce until C17. C is registered as already adopted (key = broadcast id = cli id = C). |
| C14 | `feat(freshclaude): fork a conversation (G09)` | `freshagent_claude_fork.rs`: `forked` arrives on the requesting connection; the child snapshot is the parent prefix; the child's first send materializes the same id; the parent transcript is untouched; busy gives `BUSY_TURN`. Session-host fork test. Client capability test. e2e `freshclaude-fork-rust.spec.ts` (freshclaude and kilroy). | The refusal-table test drops the claude case. |

### PR-D: turns and alerts owned by Rust (G08, G21, G24, final G03/G06, G27)

| # | Commit | Red first | Notes and tests that change |
|---|---|---|---|
| C15 | `refactor(freshagent): shared quiet_deadman and attention modules` | Unit: `observe(T)` then `mint()` with `now <= T` returns T+1. Direct `QuietDeadman` API tests. Codex deadman tests stay green and unchanged. | A behavior-preserving codex refactor. |
| C16 | `feat(freshclaude): uuid-stamped sends and lifecycle facts` | Sidecar harness: each send's uuid is on the `SDKUserMessage`; `sdk.command`/`sdk.session.state`/`sdk.heartbeat`/`sdk.status null`/enriched `sdk.result`/`stillQueued` are forwarded; a bad image gives `sdk.send.rejected` and the process survives. WS: `send.accepted.submittedTurnId` equals the snapshot `turnId`. | Legacy `sdk.turn.complete`/`turn.waiting`/idle are **still emitted** (staging rule). `ClaudeSendOutcome` (I2). |
| C17 | `feat(freshclaude): per-command turn ledger in Rust (G08, G23, G21)` | Ledger table tests from the recorded traces (`design-probe` H I J K L M N, `final-probe` CLI turn). Property tests: random interleavings consistent with T8–T10 end idle exactly when the CLI is idle, with one verdict per result. WS: an absorbed send from a second connection leaves both idle, configure is accepted and the next turn rings; a queued send keeps the client `running` between results (`sessionBusy`); `running` at accept and before any assistant frame; a CLI-initiated turn is busy. Client: `turnResult` honors `sessionBusy`. | Deletes `TurnTracker`, the compact candidate, `absorb_unstarted_compact_debt`, `fold_terminal_edge`, the quiesce protocol and their tests (`claude.rs` ≈20774–23113, `rollback-quiesce.test.ts`). Each protected property is re-expressed as a ledger test. The rollback busy gate becomes `ledger.busy()`. |
| C18 | `feat(freshclaude): Rust mints every attention edge; Stop latch (G03, G06, G24)` | WS: a warm Stop gives no `turn.complete` and no `freshAgent.error`. A cold Stop with receipt `[]` (simulator knob) is aborted and silent; with receipt `[uuid]` it is aborted and silent; with case-B ordering it is aborted on the replay. A Stop racing completion rings. A Stop with another device's queued send: the queued send runs and rings. An idle Stop is a no-op. A CLI-initiated turn rings. An API-error result rings with no banner; `error_max_turns` rings with a banner. A death after a result in the same millisecond gives a strictly larger `at`. The waiting edge is minted in Rust. `subscribe_turn_events` delivers `Settled` with `retired_request_ids`. | `claude_edges.rs` (hub, observer, I3). Deletes the sidecar gate, `sdk.turn.complete`/`turn.waiting`/idle/`exit` emissions, the `finally` mint, `emitWaitingEdge`, and `pendingResults`/`turnOpen`/`handedCompactLikely`. `interrupt-idle-gate.test.ts` now asserts the sidecar emits **no** edges. |
| C19 | `perf(freshclaude): per-session stdin writer (G27)` | A RealSidecarSim session whose sidecar stops reading stdin (`FRESHELL_CLAUDE_SIM_STALL_STDIN`): another session's send, snapshot and kill complete within 1 s, and the stalled session is killed after `FRESHELL_FRESHCLAUDE_WRITE_TIMEOUT_MS=500` through the EOF path. | `claude_sidecar_io.rs` |

### PR-E: recovery and stuck (G05 transparent resume, G22, G07)

| # | Commit | Red first | Notes and tests that change |
|---|---|---|---|
| C20 | `feat(freshclaude): transparent resume on send, attach, configure, compact (G05)` | After a crash, a send from a second connection is accepted on a respawned runtime (`resume: D`) and its turn completes. A zero-turn death followed by a send relaunches `Fresh`. Configure on a dead id is stored and applied at the next establish. Unresolvable ids give the nested lost frame. | `ensure_runtime` replaces C09's interim lost frames for resolvable ids. |
| C21 | `fix(freshclaude): visible control failures (G22)` | `freshagent_claude_kill_interrupt.rs`: configure or interrupt on an unknown id gives nested `INVALID_SESSION_ID`; an interrupt settle `ok:false` or write failure gives nested `CLAUDE_INTERRUPT_FAILED` with the requestId; interrupt on a dead id re-broadcasts `exited`. | The existing top-level `SESSION_NOT_FOUND` assertions change. |
| C22 | `feat(freshclaude): stuck deadman and recovery stop (G07)` | Integration with `W=200 ms`, simulator `HANG`: `stuck` plus exactly one ring. A pending approval pauses it. A tool heartbeat under the cap feeds; one over the cap does not. Activity after `stuck` gives `running`. `recovery.stop` stops the process, keeps the row bound, and the attach resumes. **Real-CLI lane:** a hung stdio MCP tool with `W=5 s`, `C=1 s` reaches `stuck` plus one ring. Client: `restartStuckSidecar` sends `recovery.stop` for claude/kilroy and falls back to kill plus resume on `UNSUPPORTED_CAPABILITY` (hosted-mode test). e2e stuck lane. | `terminal.rs` recovery-stop routing. |

### PR-F: identity (G32, G16, G21 acknowledgements)

| # | Commit | Red first | Notes and tests that change |
|---|---|---|---|
| C23 | `feat(freshclaude): mint the durable session id at create (G32)` | New `freshagent_claude_identity.rs`: `created.sessionId` is a UUID equal to `sessionRef`; the binding row exists at create with genesis `Fresh`; the snapshot before the first send is 200 and empty; the first send's init id equals it; there is no `materialized`. Kill and reopen of a zero-turn session. Restart then attach resumes zero-turn with boot `fresh`. A create re-driven after a restart resumes through `lookup_by_create_request_id`. Kilroy variants. Session host: a fresh `start` resolves from `created`. | T2 placeholder-shape tests (`t2-invariants.test.ts`, `harness-06/kilroy-runtime.test.ts`) assert a UUID. `rest_claude_identity.rs`, `freshclaude-identity-persistence-rust.spec.ts`, `unified-agent-names-freshclaude.spec.ts` and `freshclaude-zero-turn-restart-rust.spec.ts` move to create-time identity. Ownership is claimed on D (no `pending-create-` key, no `rekey_starting`). Naming binds at create (kilroy is skipped). |
| C24 | `feat(freshclaude): conversation reset (/clear) re-keys the session` | Simulator `/clear` gives `materialized A→B`, a binding for B `supersedes A`, later frames stamped B, and a ledger that retires the `/clear` command under B. An unannounced init mismatch is logged at error and re-keyed. Real-CLI lane `/clear`. | Init becomes verify-only. The per-init re-adoption (`claude.rs:7806-7812`) is deleted. |
| C25 | `feat(freshclaude): attach acknowledgements go to the requester with effective status (G21, G16)` | Rewritten `claude_session_rebind.rs`: two observers on the durable id both receive status, stream, error, permission and `turn.complete`; an attach mid-thinking acknowledges `running` to the requester only; the other device's streaming is not reset. | `handle_attach(msg, reply)`. `try_rebind_to_live`'s flip is deleted. |
| C26 | `feat(freshclaude): migrate legacy placeholder panes` | A client hydration unit test (L1 re-key; L2 untouched). A Rust attach with placeholder plus `sessionRef` gives `materialized`, a resume and the acknowledgement. A kill by placeholder after a restart resolves through the tombstone read. e2e: a seeded legacy pane reloads and works. | – |
| C27 | `refactor(freshclaude): delete placeholder machinery (G32)` | – (pure deletion; suite green) | Deletes `cli_index`, `broadcast_id`, deferred and per-turn adoption, `naming_handles`, `close_pending`, tombstone **writes**, the adoption test seams and their tests. Keeps and tests the tombstone **read**. |

### PR-G: finish

| # | Commit | Red first | Notes |
|---|---|---|---|
| C28 | `feat(freshclaude): notice for a turn cut off by a server restart (G25 part 2)` | WS: a busy session, then shutdown, then a new state on the same ledger, then attach: `TURN_INTERRUPTED_BY_RESTART` once, with no edge. An idle session at shutdown gets no notice. | §5.10 (client plan I-5). |
| C29 | `test(freshclaude): complete the real-CLI WS lane and the alert e2e matrix (G04)` | §11.5 and §11.6 | – |
| C30 | `test(freshclaude): retire the protocol-level fakes (G04)` | – | Move the remaining in-crate tests and e2e specs (including the API plan's) to the real sidecar plus simulator. Delete `FAKE_CLAUDE_SIDECAR_SOURCE` (`claude.rs` ≈11271), `test/e2e-browser/fixtures/providers/fake-claude-sdk-sidecar.mjs` and `monotonic-clock.mjs`. A guard test fails if any test spawns a claude sidecar other than `index.mjs`; the `exec-profile` and crash-probe fixtures are exempt. |
| C31 | `docs: freshclaude identity, alerts, stuck and fork` | – | Rewrite the claude sentences in the AGENTS.md "Agent Status Indicators" section (Rust-minted edges, single-target Stop latch, EOF death, deadman with the heartbeat cap, recovery stop, `exited` and Resume). Rewrite the sidecar protocol header. Add the fork affordance on a freshclaude turn to `docs/index.html`. |

---

## 11. Test plan

### 11.1 Sidecar unit tests (vitest; real `index.mjs` over the simulator unless pure)

- **Pure modules.**
  - `bootOptions`: fresh, resume and fork map to the right options, and resume never sets `sessionId`.
  - `classifyBootError`: the exact T4/T5 strings, plus an unknown string.
  - `resultErrorText`: diagnostics are stripped.
  - Mapper functions: one case per SDK message kind.
- **Boot.**
  - `created` arrives only after `initializationResult()`, with `cliPid` and `protocol: 2`.
  - A refused boot produces `create.failed{code}`, **no `sdk.result`**, and exit 2.
  - The commands catalog comes from the init result and is published only on change.
  - A second `create` is refused.
- **Frames.**
  - The uuid is stamped on every send, and the checkpoint attempt reuses it.
  - Lifecycle, `replayed`, session state, `status null` and heartbeats are forwarded; heartbeats are rate-limited.
  - `conversation_reset` becomes `sdk.session.rekeyed`.
  - A bad image produces `sdk.send.rejected` and the process survives.
  - From C18, **no** `sdk.turn.complete`, `sdk.turn.waiting`, `turnFailure` or idle frame is ever emitted.
- **Stream end.** A crash, error or EOF produces `sdk.stream.ended` and exit 3. Abort, shutdown or stdin close exits 0 with nothing alert-related.
- **Interrupt.** The settle echoes `stopId` and `stillQueued`. Pending cards are cancelled with deny.

### 11.2 Rust unit tests

- **`ClaudeTurnLedger`:**
  - a table test per recorded trace (H, I, J, K, L, M, N; `/clear`; CLI turn);
  - idle reconciliation;
  - lifecycle and turn-evidence fallbacks;
  - the head-retire fallback;
  - unknown uuids are ignored;
  - undo of an arm;
  - EOF `owed`;
  - property tests (§C17).
- **`StopLatch`:**
  - target selection (Started, else oldest Accepted/Queued, else CliTurn, else no-op);
  - case A and case B in both arrival orders;
  - the re-send cap;
  - `ok:false` disarms;
  - clearing on retire, idle and EOF;
  - an older CLI with no lifecycle.
- **Result verdict:** every row of §5.3, including the non-target command that rings.
- **`AttentionClock`:** strictly increasing across result, death and deadman mints within one millisecond and after a backward clock step; it carries across rekey and death/resume.
- **`decide_boot`:** every row of §4.2, including Unreadable giving Transient and each typed-retry rule.
- **Genesis:** lazy clearing (cleared only after the file is observed; kept across a crash in the flush window).
- **Snapshot source:** `Fresh`, `Fork` with and without `at` (raw chain, sidechain and compaction lines), revision floors.
- **Anchor predicate:** real CLI lines for prompt, `<command-name>`, stdout/stderr wrapper, task notification, meta and compact summary.
- **`effective_status`:** precedence.
- **Deadman:** arm, feed, pause, fire; a stale generation never fires; the heartbeat cap; the env windows.
- **Writer:** timeout kills the runtime; order is kept per session.
- **Stderr logger:** levels, truncation, rate limit, hosted redaction.

### 11.3 Rust integration tests (`crates/freshell-ws/tests`; RealSidecarSim unless noted)

- `freshagent_claude_identity.rs` (C23, C26)
- `freshagent_claude_turns.rs` (C16–C18): absorbed and queued sends, every Stop shape, CLI turn, API error, waiting edge, `submittedTurnId`, status pushes, `sessionBusy`, turn events
- `freshagent_claude_lifecycle.rs` (C08–C10, C19–C22, C28): CLI death, Node death (busy and idle), mid-compact death, dead snapshot, transparent resume, writer isolation, control failures, deadman, recovery stop, restart notice, boot failures
- `freshagent_claude_rollback.rs` (rewritten, C13) and `freshagent_claude_fork.rs` (C14)
- `claude_session_rebind.rs` (rewritten, C25)
- `freshagent_claude_attach.rs`, `freshagent_claude_kill_interrupt.rs`, `freshagent_claude_kill_after_restart.rs`, `claude_restore_unavailable.rs`, `rest_claude_identity.rs` (moved to the rig and updated where noted)
- `pane_reconcile_freshagent.rs`: zero-turn and pending-fork presence (C12)
- Session host: claude start (resume and fresh) resolves from `created`; fork routing (C10, C14, C23)

### 11.4 Real-CLI contract tests (vitest, default suite, `test/integration/providers`)

- `claude-cli-contract.test.ts`: T1–T19 as named facts, so a CLI upgrade that breaks one fails by name.
- `claude-cli-conformance.test.ts`: the same scenarios on `real` and `sim`, compared as normalized traces.
- `claude-checkpoint-uuid-replay.test.ts`: unchanged.

These are the upgrade gate for any pinned-CLI bump: a failure means the simulator or the design changes first.

### 11.5 Real-CLI Rust lane (`freshagent_claude_real_cli.rs`, RealSidecarCli)

This lane drives the real `index.mjs` and the pinned CLI against the local fake endpoint. It is run by rust-gate. It never contacts the real API: `ANTHROPIC_BASE_URL` points at localhost and the key is a dummy. It fails, rather than skips, when the CLI is missing.

1. Create, send, one `turn.complete`.
2. A warm Stop is silent, with no banner.
3. A cold Stop (create with an initial prompt, Stop at 0 ms) is aborted and silent.
4. An absorbed send (`TOOL:sleep=3`) from a second connection leaves both idle; the next turn rings.
5. Undo, send, redo; undo twice without a send.
6. Fork at a turn, then send.
7. `/clear`, then send (re-keyed).
8. SIGKILL of the CLI mid-turn: one ring, `exited`, Resume.
9. A hung stdio MCP tool reaches `stuck` plus one ring (short W and C).
10. Zero-turn restart (boot `fresh` with the same id).

### 11.6 Browser e2e (Playwright `rust-chromium`; real `index.mjs` plus simulator; parametrized over freshclaude and kilroy; none in `CLOUD_SKIP_SPECS`)

New `freshclaude-alerts-rust.spec.ts`. Each lane asserts `turnCompletion.seq`, the tab highlight, the sidebar row mark, the pane-header mark and the ring count (through the existing ring-queue test hook):

| Lane | Expected |
|---|---|
| Finish (background) | seq +1, every mark, one bell |
| Error (`error_max_turns`) | Same as finish, plus a clean banner |
| API error | One bell, no banner (the transcript shows the error) |
| Waiting | One bell. freshclaude uses an approval in default mode; kilroy uses a question under bypass. |
| Crash mid-turn | One bell, the ended card with Resume, and Resume restores a working composer with no reload |
| Stuck (short window) | The amber card plus one bell; "Restart sidecar" recovers; no stuck card while an approval is pending |
| User Stop (watched and background) | No seq change, **no "Agent error" banner**, no mark; the pane returns to idle |
| Cold Stop (pane created with an initial prompt) | Silent, and no assistant text after the Stop |
| Two pages, second page sends during a tool | Both panes return to idle; the next turn rings once per page |
| Watched finish | A tab-strip-only mark, no sound |

Updated specs:
- `fresh-agent-error-turn-attention.spec.ts`
- `fresh-agent-control-rust.spec.ts`
- `fresh-agent-rollback-rust.spec.ts` (undo, redo, undo twice, undo then restart)
- new `freshclaude-fork-rust.spec.ts`
- `freshclaude-zero-turn-restart-rust.spec.ts`
- `freshclaude-restart-parity-rust.spec.ts`
- `freshclaude-identity-persistence-rust.spec.ts`
- a legacy-migration lane (seeded placeholder pane)

All of them must pass on the configured `FRESHELL_E2E_BACKEND` before any PR is filed.

### 11.7 Client unit tests

- **`FreshAgentView`:**
  - Resume appears for claude/kilroy when exited.
  - `restartStuckSidecar` sends recovery stop for claude and falls back on `UNSUPPORTED_CAPABILITY`.
  - A failed claude send restores the composer.
  - Fork affordances follow `capabilities.fork`.
- **`freshAgentSlice`:** `sessionBusy` keeps `running`; `exited` replaces `compacting`.
- **Hydration:** the placeholder migration.
- **`fresh-agent-snapshot-thread`:** a UUID `sessionId` from create resolves the thread id.

---

## 12. Every judge must-fix, and where it is resolved

| Must-fix (judge) | Resolution |
|---|---|
| Deadman fed forever by tool heartbeats (J1); 1-hour cap too long (J2) | A 12-minute heartbeat cap, so a hung MCP tool is flagged at about 22 minutes. A real-CLI hung-MCP lane (§5.6, C22, §11.5 item 9). |
| Stop re-send for both receipt shapes and either arrival order; no contract test pins `[]` (J1, J2) | §5.4 cases A and B; C01 asserts outcomes only; C18 uses simulator knobs for both shapes. |
| Stop must not abort another device's queued send (J2) | Single target (§5.4); C18 test. |
| /clear crash (J2) | §4.6 rekey; C24; real-CLI lane item 7. |
| Hosted session host waits for init (J1) | `created.sessionRef` / `created.sessionId`; the bridge emits `Started` once; C10/C23 tests (§7.3). |
| Keep the persisted alias-tombstone read path (J1) | L3 (§4.7); C26/C27 tests. |
| No 10-minute in-memory forward; resolve through the ledger chain (J1) | §4.5 and §4.8; C13 parked-send test. |
| Drops-turn refusal must not retry without the guard (J1, J2) | `ROLLBACK_REFUSED`, with A still live (§4.2); C13 test. |
| Boot-refusal result before `initializationResult` rejects (J1, J2) | §4.2 "Boot results never reach the turn machinery"; C10 tests on both sides. |
| Reconcile turns zero-turn/pending-fork ids into dead or fresh after a restart (J1, J2) | §4.4 genesis presence rule; `has_live_session` is Live-only; C12 tests plus the C13 and C23 restart tests. |
| Genesis cleared before the transcript is flushed (J1) | Lazy clearing after the file is observed (§4.1). |
| EOF double ring (J1); C08 interim double ring (J2) | A single minter, retire-at-result, and `turn_open` closed at the result (§5.2, §5.5). Interim rule in §5.7; C08 asserts exactly one ring per phase. |
| `publish_status` versus the client's forced idle (J2) | `sessionBusy` plus a forced re-broadcast after a result (§5.2); C17 test. |
| Hosted recovery stop refused by the proxy (J2) | Client fallback to kill plus resume; hosted test in C22 (§8). |

---

## 13. Per-gap table (all 32 audit gaps)

| Gap | Sev. | Owner | Resolution | Commit(s) |
|---|---|---|---|---|
| G01 undo/redo wait for an init that never comes | high | core | A boot-verified fork runtime with a child UUID and `Fork` genesis; spawn before teardown; `ROLLBACK_REFUSED`; source collapse; restart-safe through reconcile; anchors fixed | C10–C13 |
| G02 zombie session when the SDK stream ends | high | core | The sidecar exits on stream end; the Rust EOF path runs; the dead record leads to transparent resume | C08, C09, C20 |
| G03 red banner on every Stop | high | core | Interim: the sidecar suppresses `turnFailure` for an interrupted turn and strips diagnostics. Final: Rust verdict (§5.3) | C05, C18 |
| G04 fakes diverge from the real CLI | high | core | Contract suite, simulator, real `index.mjs` everywhere, real-CLI Rust lane, kilroy and crash bell e2e, fakes deleted | C01–C04, C29, C30 |
| G05 dead pane looks usable; no Resume; `compacting` stays | med | core | `exited` status, dead record, Resume, composer restore, transparent resume | C09, C20 |
| G06 cold-start Stop misses and swallows the bell | med | core | Interim: only an aborted result is silenced. Final: single-target latch with the re-send rule | C06, C18 |
| G07 no stuck detection | med | core | Shared deadman with pause and heartbeat cap; `stuck` plus a ring; recovery stop; client restart and fallback | C15, C22 |
| G08 absorbed sends wedge busy | med | core | Per-command ledger; `sessionBusy`; single-target Stop | C16, C17 |
| G09 no fork | med | core | `handle_fork` with an eager boot-verified child; routing; capability; session host | C14 |
| G10 no live in-turn rendering | med | transcript plan | – (core provides N1–N6) | – |
| G11 saved default model ignored | med | client-alerts plan | – | – |
| G12 dropped SDK message types | med | transcript plan (client plan takes the permission-mode part) | Core forwards `sdk.status null` and `compactResult`, and turns retries into heartbeats. Banner policy in §5.3. | C16 |
| G13 transcript projection gaps | med | transcript plan | Core shares the anchor predicate | C13 |
| G14 stderr discarded; edges not logged | med | core | `log.mjs`, stderr logger, edge and decision logs | C07, C18 |
| G15 resume paths drop plugins and hostedMcp | med | core | One `create_request()` builder; plugins persisted | C11 |
| G16 second-device attach redirects broadcasts | med | core | One durable id from create; no stamp flip; legacy migration | C23, C25, C26 |
| G17 mobile has no attention mark | med | client-alerts plan | – | – |
| G18 REST/MCP cannot drive freshclaude | med | API plan | Core provides I1–I7 | C11, C16, C18, C20 |
| G19 no Freshell MCP in freshclaude panes | low | API plan | Core provides I4 | C11 |
| G20 approval suggestions dropped | low | client-alerts plan | The simulator supports I-3 | C02 |
| G21 stale idle in acknowledgements | low | core | Effective status everywhere; `running` at accept; acknowledgement to the requester only | C17, C25 |
| G22 invisible control failures | low | core | Nested errors with requestIds; configure on a dead id is stored | C09, C21 |
| G23 result+idle pair assumption | low | core | Latch deleted; ledger plus stream end | C08, C17 |
| G24 two alert clocks | low | core | One `AttentionClock` per record, used by every mint | C15, C18 |
| G25 alerts lost while disconnected; restart notice | low | client-alerts plan (part 1); **core** (part 2) | Part 1 uses the I-1/I-2 observer hooks. Part 2 is §5.10. | C07, C18, C28 |
| G26 bell queue and hidden-pane approvals | low | client-alerts plan | – | – |
| G27 global mutex held across stdin writes | low | core | Per-session writer with a timeout | C19 |
| G28 transcript locator IO and Windows home | low | API plan (PR1, ideally before C11) | Core consumes `TranscriptLocation` (I8) | C11 |
| G29 hosted configure routing | low | API plan | Core configure semantics apply in the host | – |
| G30 catalog probe environment | low | API plan | – | – |
| G31 teardown and process tree | low | API plan | Core's silent requested exit composes with their graceful wait; `claude_spawn.rs` is theirs | – |
| G32 placeholder-id complexity | low | core | Mint at create, genesis, establish path, verify-only init, rekeys, deletion | C10–C13, C23–C27 |

---

## 14. Risks and containment

| Risk | Containment |
|---|---|
| **Undocumented CLI signals.** `command_lifecycle` is @internal, and `session_state_changed` needs an environment flag. | Both are pinned by the contract suite, which is the upgrade gate. Fallbacks: replay for lifecycle; turn evidence for session state; head-retire for unknown commands. The deadman and the idle reconciliation backstop any wedge. Every fallback is logged. |
| **A mistaken Stop re-send** (case B) aborts the next queued command | Narrow (it needs another device's queued command to start within milliseconds), capped at 2, and logged. The aborted command is not a target, so it rings (§5.3). No alert is lost. |
| **Deadman false positives** (a legitimate MCP tool longer than about 22 min) | The window and cap are env-tunable. Activity clears `stuck`. Restart recovers. A later real result rings its own edge. |
| **Ledger compatibility** (new binding fields, old rows, downgrade) | `plugins`, `genesis` and `turn_interrupted_at` are serde-optional under `LEDGER_VERSION` 1. `BindingRow` does not deny unknown fields. A downgraded server ignores the genesis, so pending forks and zero-turn ids become recreatable rather than resumable; transcript-backed sessions are unaffected. The rollback record schema is unchanged. |
| **Restart mid-operation** | Create: the binding is written only after the boot verdict; a re-driven create maps through `lookup_by_create_request_id`. Rollback: the record is pre-written, and the swap batch is atomic. Pending forks re-boot from the genesis (T6), and zero-turn ids from `Fresh`. |
| **Two CLIs alive during a rollback or fork** | The original is idle under `turn_lock`. The fork writes nothing until its first prompt. Ownership keys and leases differ. The original is torn down before the child can receive a send. |
| **Boot handshake latency** (+0.6–1.5 s per create, resume, rollback or fork) | The pane already shows "starting". In exchange, create failures are truthful (bad `CLAUDE_CMD`, missing transcript), and most of the cold-Stop window disappears. |
| **Stop re-send latency** (a Rust round trip) | A few ms, against ≥30 ms of turn warm-up (P4: started, then requesting 32 ms later, then replay 80 ms later). |
| **Refactoring a 24k-line file** (ownership fences, kill races) | New logic goes into small modules. Guards are moved, not rewritten, and the existing race tests run against `establish_runtime`. Deletions (C17, C18, C27) come only after the replacements are green. PRs ship independently. |
| **Merge friction with the three workstreams** | Interface contract in §9. The shared mapper module with one function per kind. Ownership of each sidecar message kind is stated (N6). |
| **Kilroy differences** | Same runtime. Naming is skipped at the create-time bind. Approvals are rare under bypass, so kilroy's waiting tests use questions. Every alert and lifecycle e2e lane is parametrized over kilroy. |
| **Simulator drift** | The simulator is valid only while the conformance suite is green. Any new behavior the design relies on gets a contract scenario first. |

---

## 15. Decisions for the product owner

1. **Stop stops the running turn only.** Messages another device queued behind it still run and ring. This is today's semantics and codex's. "Stop everything" would need the CLI's `cancel_queued`, which the SDK's public `interrupt()` does not expose.
2. **Undo refuses honestly when Claude folded another message into the turn being undone.** It is not retried without the guard, which would silently drop the folded message.
3. **Stuck defaults:** 10 minutes of silence, and tool heartbeats trusted for up to 12 minutes, so a hung MCP tool is flagged at about 22 minutes. Both are env-tunable.
4. **Pane creation, resume, undo and fork wait about 0.6–1.5 s for the CLI to confirm it booted.** In exchange, failures are truthful and early Stops are reliable.
5. **Fork opens a live child right away,** like codex and opencode. It does not wait for the child's first message.
