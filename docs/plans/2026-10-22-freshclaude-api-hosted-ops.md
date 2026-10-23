# Plan: freshclaude/kilroy — Agent API, MCP, hosted gateway, and operations workstream

Scope: audit gaps G18, G19, G28, G29, G30, G31. Worktree `/home/dan/code/freshell/.worktrees/freshclaude-parity` (branch `feat/freshclaude-parity`, identical to `origin/main` 1c7e4dff7). Kilroy is sessionType `kilroy` on the same `FreshClaudeState` runtime, so every item below covers it unless a line says otherwise. All line numbers were checked against that tree.

This is a design document. No repository file was changed.

---

## 0. Decisions at a glance

| # | Item | Decision | Why |
|---|------|----------|-----|
| G28 | Three-state transcript locator, plus the shared `home_dir()` fallback for every Claude store-root caller | **This effort. Ship first.** | It is a small correctness fix. On the Windows desktop app (no `HOME`), freshclaude history, resume and undo fail. A transient IO error is reported as "session lost". The G18 capture work and the core-runtime attach/rollback work both build on the new locator. |
| G31 | Graceful sidecar shutdown, plus a process-tree guard: a Windows job object, and a Unix process group for macOS | **This effort.** | Confirmed with a live probe (§3.1): a hard-killed Node sidecar leaves the real CLI running the current turn until that turn finishes. Windows and macOS are both shipping Electron targets (`config/electron-builder.yml:90-102`), and on them nothing reaps the CLI. The job-object code already exists privately in `freshell-server/src/checkpoints.rs:819-960`, so this is a lift-and-reuse. |
| G30 | Model-catalog probe environment parity | **Partly this effort.** Shared JS clean-env module, and one shared Rust node-command builder (which also gives the probe the G31 tree guard). **Deferred:** routing the probe through the session host in managed mode. | The shared builders remove the drift at its source. They also fix a real leak: on Windows and macOS, a probe that times out leaves its CLI grandchild behind. Routing through the host needs a new supervisor/session-host RPC. It matters only in the opt-in managed mode, where the static model list is already the fallback. That work belongs to `docs/plans/2026-10-05-managed-provider-environment.md`. |
| G19 | Ordinary Freshell MCP server inside freshclaude/kilroy panes, gated on `settings.codingCli.mcpServer` | **This effort.** **Deferred:** gating terminal-mode CLIs (GitHub #446) goes to its own follow-up PR. | It restores what the legacy freshclaude had, and it is cheap because the platform command resolver exists. A probe (§3.2) confirmed that the endpoint and token can travel through the inherited environment and never through argv. Gating terminal panes changes behavior for every terminal CLI, so it is outside freshclaude parity. The shared gate helper makes that follow-up a one-line change. |
| G18 | REST/MCP create, split, send-keys and capture for freshclaude/kilroy in the default server | **This effort. Biggest item.** It depends on core-runtime interfaces I1–I3 (§1). **Deferred:** an in-process codex lane (that would be a new codex feature), and moving opencode onto the lane abstraction. | This is the only medium-severity gap here. The lane drives the same `FreshClaudeState::handle_create`/`handle_send` that a browser's `freshAgent.create`/`send` reach, deduplicated on the pane's `createRequestId`. That gives exactly one writer. It is not a second implementation the way the opencode REST lane is (`lib.rs:6339-6800`). |
| G29 | Hosted gateway routing for `freshAgent.configure`, plus a routing test that checks every message type | **This effort. Last, as its own PR.** Contents: routing, a no-wildcard routing classifier, and a real hosted `configure` RPC that follows the existing `compact` pattern. | If configure is routed to the gateway with nothing behind it, the user gets either a fake error or a silent drop. The `compact` RPC already shows the five-crate path. The classifier makes it a compile error to add a fresh-agent message without deciding its routing. This touches managed-runtime crates, so it ships as a separate PR the managed-runtime owners can review. |

Suggested PR slices, in order: **PR1 G28 → PR2 G31+G30 → PR3 G19 → PR4 G18 → PR5 G29.** PR4 waits on core-runtime I1–I3. PR1–PR3 do not depend on core-runtime.

---

## 1. Interfaces needed from the core-runtime workstream

Core-runtime (G01–G09, G14–G16, G21–G24, G27, G32) restructures `claude.rs` handlers and the consumer. This plan needs the interfaces below. Where an interface is missing, I give the fallback this plan would ship with instead.

| ID | Interface | Used by | Fallback if absent |
|----|-----------|---------|--------------------|
| **I1** | `FreshClaudeState::handle_create(msg, provenance) -> ClaudeCreateOutcome`, where `ClaudeCreateOutcome = Created { session_id, session_ref: Option<SessionLocator> } \| Failed { code, message, retryable, owner: Option<TerminalOwnerFields> }`. The WS frames it broadcasts stay byte-identical, and the WS dispatcher ignores the return value. It is a mechanical change: each of the 19 `self.fail_create*(…); return;` exits becomes `return self.fail_create*(…)`, and `fail_create*` (`claude.rs:2698-2763`) both broadcasts and returns `Failed`. The success tail (`claude.rs:2672-2696`) and the replay arm (`1885-1904`) return `Created`. | G18 create/split | PR4 makes this change itself, in one refactor commit placed before its first red test. |
| **I2** | `handle_send(msg) -> ClaudeSendOutcome = Accepted { session_key } \| Refused { code, message }`, with the same idea. `send_error` (`claude.rs:7428`) returns `Refused`; the `send.accepted` broadcast (`claude.rs:4619`) returns `Accepted`. | G18 send-keys | Same: PR4 makes the change. |
| **I3** | A typed lane-event observer: `FreshClaudeState::subscribe_turn_events() -> broadcast::Receiver<ClaudeTurnEvent>`, with `ClaudeTurnEvent::{ Settled { session_key, retired_request_ids: Vec<String>, at }, Waiting { session_key, at }, Ended { session_key, reason } }`. It is published from the single attention-edge emitter that the G14/G24 fixes introduce (log, then broadcast, then notify). `retired_request_ids` is the G08 fix (stamp a uuid on each send, retire by replay) exposed as Rust request ids. A dedicated low-volume channel never carries `sdk.stream` deltas, so it cannot lag. | G18 send-keys turn correlation | **Idle-required semantics.** REST send-keys answers `409 SESSION_BUSY` (retryable) while the session has a turn in flight. Otherwise it waits for the first `freshAgent.turn.complete` stamped for the session after `Accepted`, read from the shared broadcast bus. That is correct for the REST-only case. A browser send racing in can make REST report done one turn early. That race is documented and is removed once I3 lands. |
| **I4** | One launch-profile builder used by every sidecar `create` line the lane writes. That is `handle_create`, `resume_for_attach` (`7173-7183`), `resume_for_handoff`, and the rollback fork (`6312-6343`). This is the G15 fix. Shape: `fn sidecar_create_request(&self, profile: &ClaudeLaunchProfile) -> Value`. | G19 (adds `freshellMcp` and `freshellContext`) | PR3 adds the two fields at all four sites itself. |
| **I5** | G05 resume-on-send for a dead session addressed by its durable id (codex `ensure_session_alive` style). | G18 (benefits automatically) | REST send to a session that is not live answers `409 FRESH_AGENT_SESSION_NOT_LIVE` with `retryAfterMs`. The browser's attach-on-reload stays the recovery driver. REST never starts a second recovery driver. |
| **I6** | G32 (Rust mints the durable UUID with the SDK `sessionId` option) may change what `created.session_id` is. | G18 | None needed. The lane treats the id as opaque and also returns `sessionRef` when it knows one. |
| **I7** | G04: a Rust integration harness that runs the **real** `index.mjs` with `FRESHELL_CLAUDE_SDK_QUERY_MODULE` pointing at a scripted SDK, instead of inline fake sidecars. | G18/G19/G31 integration tests | Use the request-logging inline-fake pattern of `crates/freshell-ws/tests/freshagent_claude_attach.rs:26-130`, and port to the real-sidecar harness when it lands. |
| **I8** | G01's rollback rewrite consumes the G28 `TranscriptLocation` and does not call `locate_transcript` directly. | G28 | PR1 converts the five rollback call sites minimally (§2.1). |

Ordering constraint: **PR1 (G28) should land before core-runtime touches `resume_for_attach` or the rollback sites,** so that core-runtime builds on the three-state locator.

---

## 2. Items: current behavior, target, design, files

### 2.1 G28: three-state transcript locator and the shared home fallback

**Verified current behavior**
- `claude_home_candidates()` reads only `CLAUDE_CONFIG_DIR`, `CLAUDE_HOME` and `HOME` (`claude_snapshot.rs:31-54`). It has no Windows `USERPROFILE` fallback, and on POSIX it has no passwd-entry fallback.
- Only `locate_transcript_selected` (the naming path) adds `USERPROFILE`, under `cfg(windows)` (`claude_snapshot.rs:96-122`). A third resolver, `freshell-ws/src/claude_truth.rs:170-200`, uses `std::env::home_dir()` on Windows only. A fourth, `session_directory::provider_home()` (`freshell-server/src/session_directory.rs:1039`), already uses `std::env::home_dir()` everywhere. That is exactly the CLI's `os.homedir()` behavior.
- `find_transcript` turns IO failures into "missing": `read_dir(...).ok()?`, `.flatten()`, and `Path::is_file()` (`claude_snapshot.rs:196-245`). `locate_transcript` (`65-69`) inherits this.
- Callers that treat "missing" as proof the session is gone:
  - `resume_for_attach` maps it to `ResumeClaudeError::NotFound` (`claude.rs:7085-7087`). That leads to `lost_session_frame` and `INVALID_SESSION_ID` (`claude.rs:6980-6982`).
  - The snapshot returns `NotFound` → 404 `FRESH_AGENT_LOST_SESSION` (`claude_snapshot.rs:1204`, `snapshot.rs:355-359`).
  - The rollback sites answer `NOTHING_TO_UNDO` or `REDO_UNAVAILABLE` (`claude.rs:5783, 5897, 5912`; `6262` silently falls back).
  - The reconcile existence probe returns `Absent` (`freshell-server/src/existence.rs:265-283, 305-321`). Its type `ClaudeTranscriptLocator = Arc<dyn Fn(&str) -> Option<PathBuf>>` (`existence.rs:50`) has no error channel. The comment at `:270` says so.
- With no roots at all (Windows with no `HOME`): the snapshot returns an Io error (500) and attach returns `Transient` (`claude_snapshot.rs:1198-1202`; `claude.rs:7076-7082`). Electron passes `process.env` through and sets no `HOME` (`electron/server-spawner.ts:238-257`).
- An error-aware `locate_transcript_checked` exists (`claude_snapshot.rs:259-275`), but only the resume-resolve endpoint uses it (`main.rs:3858-3900`). Its traversal layout also differs on purpose (Node parity: direct plus `subagents/`).

**Target**
- One store-root resolver for every Claude caller: `CLAUDE_CONFIG_DIR`, then `CLAUDE_HOME`, then `std::env::home_dir()/.claude`, de-duplicated. On Windows that is USERPROFILE; on POSIX it is HOME, falling back to the passwd entry. This matches what the real CLI does.
- One traversal with three outcomes: `TranscriptLocation::{ Found(PathBuf), Absent, Unreadable(LocateError) }`, where `LocateError = NoStoreRoot | Io { root, kind, message }`.
  - `Found` if the file is found under any root, even when another root errors.
  - Otherwise `Unreadable` if any root failed with an error other than `NotFound`/`NotADirectory`, or if there are no roots.
  - Otherwise `Absent`.
  - The traversal stays the existing `find_transcript` layout: direct, plus one nested level. The Node-parity resolve endpoint keeps its own checked layout.
- How each caller maps the result:
  - attach: `Unreadable` → `Transient` (never lost).
  - snapshot: `Unreadable` → `Io` → 500.
  - rollback: `Unreadable` → `INTERNAL_ERROR` (retryable), which is the same code the existing read-error branch uses at `claude.rs:5791-5796`.
  - existence probe: `Unreadable` → `SessionExistence::Unknown` (a bounded deferral, never `dead_session`).
  - naming (`locate_transcript_selected`): `Found` only, on the shared candidates. Its `cfg(windows)` special case is deleted.

**File-by-file**
- `crates/freshell-freshagent/src/claude_snapshot.rs`
  - Add `pub(crate) fn claude_home_candidates_from(var: impl Fn(&str) -> Option<String>, home: Option<PathBuf>) -> Vec<PathBuf>` (pure), with `claude_home_candidates()` calling it as `(|k| std::env::var(k).ok(), std::env::home_dir())`.
  - Add `pub enum TranscriptLocation`, `pub enum LocateError`, `pub fn locate_transcript_state(id) -> TranscriptLocation`, and `fn find_transcript_state(root, id)`. The latter uses `read_dir_sorted_or_empty`/`candidate_is_file`, which already exist at `:297-330`, but keeps the existing layout and the directory-only filter. Errors keep scanning; the first error is remembered and a later hit still wins.
  - `find_transcript` becomes `find_transcript_state(..).found()`, so there is one traversal.
  - `locate_transcript` stays as a thin `Found`-only wrapper for display-only callers (`claude_can_redo_now :1102`, `native_history.rs:398`). Each is reviewed: unreadable reads as "no redo" or a history error, never as "lost".
  - `get_claude_snapshot` (`:1190-1205`) maps the three states. The separate `claude_home_candidates().is_empty()` branch is deleted because it is now `Unreadable(NoStoreRoot)`, and the existing message text stays.
  - `locate_transcript_selected` uses the shared candidates and its `cfg(windows)` block is deleted.
- `crates/freshell-freshagent/src/claude.rs`
  - `resume_for_attach` (`7076-7087`) matches on `locate_transcript_state`. Its own empty-candidates branch is deleted. It logs `warn` with event `freshagent.claude.transcript_unreadable`, the root and the io error kind, and never the path contents.
  - Rollback sites `5783, 5837, 5897, 5912, 6262`: `Unreadable` → `rollback_error_frame(op, "INTERNAL_ERROR", "claude transcript store unreadable: <kind>")`. Coordinate through I8.
  - `:8211` (naming config root) uses the shared candidates.
- `crates/freshell-freshagent/src/lib.rs:72` re-exports `TranscriptLocation` and `locate_transcript_state`.
- `crates/freshell-server/src/existence.rs`: `ClaudeTranscriptLocator = Arc<dyn Fn(&str) -> TranscriptLocation + Send + Sync>`. Both sites map `Found` → Present (plus an observed-set insert), `Absent` → fall through (or Absent at `:272`), `Unreadable` → `Unknown`. Update the `direct_locator_over` test helper (`:536`).
- `crates/freshell-server/src/main.rs:2110-2114`: the closure returns `freshell_freshagent::locate_transcript_state(id)`.
- `crates/freshell-ws/src/claude_truth.rs:170-200`: `ClaudeRoots::from_env` delegates to `freshell_freshagent::claude_home_candidates()` (made `pub`). That removes the last divergent resolver. This is a refactor: its tests pin the outcome, not the code.

### 2.2 G31: graceful shutdown and process-tree guard

**Verified current behavior**
- `teardown_removed_session` (`claude.rs:10101-10148`) writes `{"type":"shutdown"}`, then immediately calls `terminate_pid` (SIGTERM) and `child.start_kill()` (SIGKILL), then reaps by `/proc` tag. `shutdown()` (`claude.rs:1828-1848`) does the same, one session at a time.
- `terminate_pid`, `reap_owned_claude_sidecars` and the tree confirmation are no-ops off Linux (`claude.rs:9865-9889, 10064-10073`). Teardown answers `TeardownConfirmation::PlatformLimited` (`10135-10147`), and the session-handoff stop answers `StopResult::PlatformLimited` (`claude.rs:1195, 1242-1247`).
- `spawn_sidecar` (`claude.rs:9639-9720`) uses `kill_on_drop(true)`. On Windows that ends only `node.exe`. There is no job object and no process group.
- The sidecar's shutdown handler is `shutdown(); process.exit(0)` (`index.mjs:625-633, 680`). The SDK's CLI spawn is **not** detached (the `SOe(t,n,{cwd,stdio,signal,env,windowsHide})` call in the vendored `sdk.mjs`), so the CLI shares node's process group.
- A private, Windows-only `WindowsJob` (create kill-on-close job, assign a suspended process, resume, count active processes, terminate, settle) already exists in `crates/freshell-server/src/checkpoints.rs:819-960`, behind the target dependency `windows-sys =0.61.2` with `Win32_System_JobObjects` (`freshell-server/Cargo.toml:160-170`).

**Probe evidence:** see §3.1. The graceful path kills the CLI in about 100 ms. A hard kill of node leaves the CLI streaming the turn until it ends.

**Target**
1. **Grace first.** Write the shutdown line, then `tokio::time::timeout(SIDECAR_GRACEFUL_EXIT = 2s, child.wait())`. Escalate (SIGTERM, then SIGKILL, then reap) only if node has not exited. Tree confirmation runs either way. `shutdown()` tears sessions down concurrently (`futures::future::join_all`), so a server stop is bounded by about one grace period, not N of them. Log at `info`: `freshagent.claude.teardown` with `{session_id, graceful: bool, elapsed_ms, confirmation}`.
2. **Process-tree guard (RAII).** `spawn_sidecar` returns a `SidecarTreeGuard` stored on `ClaudeSession`. Dropping it, or calling `terminate()`, kills the whole tree on every platform. That also covers the roughly 15 early-return `start_kill` sites in `handle_create`, and panics, without editing each site.
   - **Windows:** spawn with `CREATE_SUSPENDED`, assign to a `KillOnCloseJob`, then resume (the existing helper does this). Teardown calls `job.terminate()` then `job.settle()`, which waits until active processes reach 0. `teardown_removed_session` returns `Confirmed` instead of `PlatformLimited`, so handoff gets a real stop confirmation on Windows.
   - **All Unix:** spawn with `process_group(0)`. Escalation also does `killpg`. On non-Linux Unix (macOS), confirmation is "the group is gone" (`kill(-pgid, 0)` returns ESRCH, as in `checkpoints.rs:808-818`). Linux keeps its stronger start-time-checked `/proc` confirmation. The `killpg` escalation runs on Linux too, so CI exercises the wiring.
   - If creating the guard fails (job or group), log `error` with event `freshagent.claude.tree_guard_unavailable` and continue with today's behavior. A pane never fails because of this.

**File-by-file**
- `crates/freshell-platform/src/process_job.rs` (new, `cfg(windows)`): move `WindowsJob` here as `KillOnCloseJob`, unchanged. Add the `windows-sys =0.61.2` target dependency (same features) to `crates/freshell-platform/Cargo.toml`.
- `crates/freshell-server/src/checkpoints.rs:819-960`: use `freshell_platform::process_job::KillOnCloseJob`. This is a pure refactor, covered by the existing checkpoint tests in the Windows lane.
- `crates/freshell-freshagent/src/claude_spawn.rs` (new):
  - `SidecarTreeGuard` (per-platform implementation).
  - `ClaudeNodeCommand` builder, shared with G30 (§2.3).
  - `async fn graceful_then_kill(child, stdin, guard, grace) -> TeardownConfirmation`.
- `crates/freshell-freshagent/src/claude.rs`: `ClaudeSession` gains `tree: SidecarTreeGuard`. `spawn_sidecar` (`9639`) returns it. `teardown_removed_session` (`10101`) and `shutdown()` (`1828`) go through `graceful_then_kill`. Delete the now-redundant `terminate_pid` stub for non-Linux.
- `crates/freshell-freshagent/Cargo.toml`: add a `cfg(windows)` `windows-sys` dependency only if the guard calls Win32 directly. It should not, because the guard calls `freshell-platform`.

### 2.3 G30: model-catalog probe environment parity

**Verified current behavior**
- `model-catalog.mjs:9` always strips `ANTHROPIC_API_KEY`.
- `index.mjs:117-121` (`createClaudeSdkCleanEnv`) keeps it when `FRESHELL_CLAUDE_ONECLI_API_KEY === '1'`.
- `ClaudeCatalogProbe` (`model_capabilities.rs:150-215`) spawns `node model-catalog.mjs` with no managed secrets, no ONECLI flag, no `setpriv` run-as wrapper and no provider-exec check. `spawn_sidecar` applies all four (`claude.rs:9650-9701`).
- On timeout, the probe kills the process group only on Linux (`model_capabilities.rs:182-205`). On Windows and macOS the probe's SDK-spawned CLI is left behind.
- In the default server none of these differences matter, because managed secrets are installed only in the session host (`freshell-session-host/src/main.rs:1327`). The audit's corrected text agrees.

**Target (this effort)**
- **JS:** one clean-env function. Add `crates/freshell-claude-sidecar/sdk-env.mjs` exporting `createClaudeSdkCleanEnv(env)`. `index.mjs` and `model-catalog.mjs` both import it. The probe then keeps the key exactly when the sidecar would.
- **Rust:** one builder. `ClaudeNodeCommand::new(entry).with_managed_environment().with_run_as().with_ownership_tag(id).spawn_guarded()` does the following: resolves `FRESHELL_CLAUDE_NODE`; applies the setpriv wrapper; applies managed secrets plus the ONECLI flag; runs `provider_exec::check_command`; sets the ownership tag; returns `(Child, SidecarTreeGuard)`. `spawn_sidecar` and `ClaudeCatalogProbe` both use it. The probe's timeout path calls `guard.terminate()` instead of the Linux-only `killpg`.
- Inject the secrets and environment source so tests are hermetic: `ClaudeNodeCommand::from_parts(env: &dyn Fn(&str)->Option<String>, secrets: Option<BTreeMap<..>>)`.

**Deferred: routing the probe through the session host in managed mode.** It needs a `capabilities.probe` admin/host RPC and a supervisor route, which is owned by the managed-provider-environment plan. It affects only the opt-in managed mode where OneCLI is the only authentication, and there the dialog already falls back to the static list. Recorded as a follow-up.

### 2.4 G19: ordinary Freshell MCP inside freshclaude/kilroy panes

**Verified current behavior**
- The sidecar deliberately leaves out the MCP injection (`index.mjs:64-68`). Its only `mcpServers` source is `hostedMcpServers(req.hostedMcp)` (`index.mjs:445`), which returns undefined unless hosted Claude is active (`hosted-mcp.mjs:3-6`).
- The terminal lanes inject MCP through `generate_mcp_injection` (`terminal_tabs.rs:2593-2600`) and give the terminal `FRESHELL/FRESHELL_URL/FRESHELL_TOKEN/FRESHELL_TERMINAL_ID/FRESHELL_TAB_ID/FRESHELL_PANE_ID` via `build_terminal_base_env`. That function is duplicated at `freshell-ws/src/terminal.rs:8773-8803` and `freshell-freshagent/src/terminal_tabs.rs:387`.
- `settings.codingCli.mcpServer` is declared (`freshell-protocol/src/settings.rs:98`), defaults to true (`freshell-server/src/settings.rs:49`), and is toggled in the UI (`AdvancedSettings.tsx:66-77`). No Rust code reads it. GitHub #446 is open.
- The MCP client takes its endpoint and token from `FRESHELL_URL`/`FRESHELL_TOKEN` (`tools/freshell-mcp/http-client.ts:17-18`) and its caller pane from `FRESHELL_TAB_ID`/`FRESHELL_PANE_ID` (`freshell-tool.ts:126-136, 220-235`).
- `RealMcpRuntime::server_command` resolves `FRESHELL_MCP_NODE`+`FRESHELL_MCP_ENTRY` (which Electron sets, `server-spawner.ts:256-257`), else the dist build, else tsx source (`mcp_inject.rs:186-219`). `build_mcp_server_command(rt, target)` (`:447`) renders it for a provider target.
- The SDK passes `mcpServers` to the CLI as `--mcp-config <json>` **on argv** (seen in the vendored `sdk.mjs`). Any `env` in that config would therefore show up in `ps`. This is why the hosted design keeps the grant in the inherited environment (`hosted-mcp.mjs:1-2`).

**Probe evidence:** see §3.2. A stdio MCP child receives the `env` given to the SDK `query()` (FRESHELL_* arrived intact). It starts about 800 ms after CLI start even with no prompt, and the init message reports `freshell: connected`.

**Target**
- When `settings.codingCli.mcpServer` is true (read **live** at each sidecar create, so no restart is needed) and the lane is not hosted, the sidecar's `query()` gets `mcpServers.freshell = { command, args }`. Only paths and flags travel in the create line. No token or env goes into the config.
- The sidecar process environment carries the endpoint: Rust sets `FRESHELL=1`, `FRESHELL_URL` and `FRESHELL_TOKEN` at spawn, from the server's own bound port and auth token. These are injected values, not re-read from env. The pane context `FRESHELL_TAB_ID`/`FRESHELL_PANE_ID` arrives as `freshellContext` in the create line. The sidecar merges it into the `env` passed to `query()`, so it reaches the CLI and from there the MCP child.
- This matches terminal panes, which already expose `FRESHELL_TOKEN` to the agent's shell, so it adds no new exposure. The token never appears on argv. A contract test proves that (§5.4).
- On a resume or respawn (attach-resume, handoff, rollback), the same recipe and context are reapplied through I4. The pane context comes from new optional `paneId` on `freshAgent.create` (`tabId` already exists) and new optional `tabId`/`paneId` on `freshAgent.attach`. The context is stored in the session's launch profile.
- If the MCP command cannot be resolved (for example, no dist and no tsx), log `warn` with event `freshagent.claude.mcp_unavailable` and the error text, and create the pane without MCP. The pane never fails over this.
- Kilroy gets the same treatment. The hosted lane is unchanged: it keeps its fixed recipe and never gets the ordinary one.
- **Open decision (from core PR-A review F6): hosted kilroy.** The session host sets `FRESHELL_HOSTED_FRESH_AGENT=kilroy` for hosted kilroy (`freshell-supervisor/src/backend.rs`). Core moved every read of that variable into `crates/freshell-claude-sidecar/hosted.mjs`: `isHostedSidecar` (any hosted sidecar, log redaction) and `usesHostedClaudeRuntime` (hosted `claude` only: the managed spawn check in `exec-profile.mjs` and the fixed hosted recipe). So hosted kilroy today gets neither the managed spawn check nor the fixed recipe. This workstream decides whether it should, and changes `usesHostedClaudeRuntime` (and the case in `test/unit/claude-sidecar/hosted.test.ts` that pins today's split) in a red-first commit.

**File-by-file**
- `crates/freshell-platform/src/freshell_context_env.rs` (new): `FreshellEndpoint { url, token }` and `fn freshell_context_env(endpoint, terminal_id: Option<&str>, tab_id, pane_id) -> BTreeMap`. Both `build_terminal_base_env` copies delegate to it (a refactor; the existing tests at `terminal.rs:11544-11575` keep pinning the behavior).
- `crates/freshell-protocol/src/settings.rs`: `impl ServerSettings { pub fn agent_mcp_server_enabled(&self) -> bool }`. This is the one shared gate; the #446 follow-up uses it.
- `crates/freshell-protocol/src/client_messages.rs`: optional `pane_id` on `FreshAgentCreate`; optional `tab_id`/`pane_id` on `FreshAgentAttach`. `shared/ws-protocol.ts` (`FreshAgentCreateSchema :847-872` and the attach schema) gets the matching optional fields.
- `crates/freshell-freshagent/src/claude.rs`:
  - `FreshClaudeState` gains `freshell_endpoint: Arc<OnceLock<FreshellEndpoint>>` and `freshell_mcp: Arc<OnceLock<ClaudeFreshellMcpProvider>>`, where `ClaudeFreshellMcpProvider = Arc<dyn Fn() -> BoxFuture<'static, Option<ClaudeFreshellMcp>> + Send + Sync>` and `ClaudeFreshellMcp { command, args }`. Setters follow the `set_identity_sink` pattern.
  - `spawn_sidecar` takes the endpoint and sets the env.
  - The create line gets `"freshellMcp"` and `"freshellContext": {tabId, paneId}` (through I4).
  - Log `info` with event `freshagent.claude.mcp_injection` and `{session_type, enabled, resolved}`.
- `crates/freshell-server/src/main.rs` (next to `fresh_claude_state` wiring, `1054-1088`):
  - Install the endpoint from `PORT`/bind and `auth_token`.
  - Install a provider closure that reads `settings_store.shared_settings_lock()` (`settings_store.rs:335`), checks `agent_mcp_server_enabled()`, then calls `build_mcp_server_command(&RealMcpRuntime, host_native_target())`. `host_native_target()` is `ProviderTarget::Windows` on a Windows host and `Unix` otherwise.
  - The session host never installs either.
- `crates/freshell-claude-sidecar/mcp-servers.mjs` (new, absorbing `hosted-mcp.mjs`): `export function mcpServersFor(req, env)`. It returns the hosted recipe, the ordinary recipe or `undefined`, never both, and never an `env` key. `index.mjs:445` calls it, and `index.mjs` merges `req.freshellContext` into the SDK `env`. Update the scope comment at `index.mjs:64-68`.
- Client: `FreshAgentView.tsx` `buildCreateMessage` (`:2030-2068`) adds `paneId`. The attach builders (`:640`, `sendFencedFreshAgentAttach`) add `tabId`/`paneId`.

**Deferred: gating terminal-mode injection on the same setting (#446).** It changes behavior for every terminal CLI (claude, codex, gemini, kimi, opencode), so it is not freshclaude parity. Do it immediately after, as its own PR, using `agent_mcp_server_enabled()`. There is a known inconsistency until then: turning the toggle off removes MCP from freshclaude panes but not from terminal panes. Note this in the PR description.

### 2.5 G18: REST/MCP agent API for freshclaude/kilroy in the default server

**Verified current behavior**
- `create_tab` maps `claude|kilroy|codex|opencode` (`lib.rs:1962-1970`). With a hosted gateway it calls `create_hosted_agent_tab`. Without one, it returns **503 "durable fresh-agent gateway is not installed"** for anything except opencode (`lib.rs:4814-4862`).
- Split with `agent` returns the same 503 for every provider (`pane_ops.rs:185-199`).
- `pane_entry_for_request` reads the REST-only pane map. It falls back to the layout only when a gateway exists (`lib.rs:5106-5149`, the `state.hosted_rest_gateway()?` at `:5110`). So send-keys on a UI-created freshclaude pane returns 404, and capture returns 422 (`lib.rs:6286-6330, 6981-7055`).
- The gateway is installed only under `feature="managed-runtime-v1"` plus an explicit opt-in (`main.rs:1197-1221`).
- The seam is already provider-generic: `HostedFreshAgentRestGateway { snapshot, create_agent, send_agent, capture }` (`hosted_rest.rs:123-145`). The hosted implementation builds a `FreshAgentCreate` exactly as a browser would and calls the same create path (`fresh_agent_proxy_rest.rs:124-163`). It waits for `freshAgent.turn.complete` or `status: idle` (`:264-276`).
- `render_snapshot_text` (role-prefixed plain text with a UTF-8-safe byte cap) lives privately in `freshell-session-host/src/providers/fresh_agent.rs:1274-1316`.
- `handle_create` dedupes on `requestId` and replays `created` (`claude.rs:1885-1904`). It broadcasts `created` to every connection (`2686`). A conn-less caller passes `provenance: None`, as documented at `:1871-1873`. The session host already drives it this way (`fresh_agent.rs:417-458`).
- The client does not snapshot a Claude placeholder: `getFreshAgentSnapshotThreadId` keys on the durable UUID (`src/lib/fresh-agent-snapshot-thread.ts:50-56`). So a pane born as `{sessionId: <placeholder>, status: 'connected'}` behaves like a UI-created pane after `created`. The hosted REST path already depends on that.
- MCP `new-tab` posts `/api/tabs`, then send-keys with `data: "<prompt>\r"` (`freshell-tool.ts:469-505`). Its instructions steer agents to `agent:"opencode"` (`:58-61`). The resume shorthand excludes Claude (`:367-370`).
- The client resolves Claude pane defaults: `permissionMode` from saved settings, else `bypassPermissions`; model `opus[1m]`; effort; `defaultPlugins` (`PaneContainer.tsx:706-760`, registry `fresh-agent-registry.ts:63-110`). The REST and hosted paths send none of these today. A REST-created freshclaude pane would therefore run with SDK `permissionMode` undefined, while a UI-created one runs `bypassPermissions`.

**Design (one writer)**
- Rename the seam to what it is. In `hosted_rest.rs`, `trait HostedFreshAgentRestGateway` becomes `rest_lane.rs` `trait FreshAgentRestLane`, and the `HostedRest*` types become `RestLane*`. `create_hosted_agent_tab` becomes `create_lane_agent_tab`. Add `FreshAgentState::rest_lane_for(provider) -> Option<SharedFreshAgentRestLane>`, which returns:
  - the hosted gateway if one is installed (all providers, exactly today's behavior);
  - otherwise the in-process **Claude lane** for `provider == "claude"` (freshclaude and kilroy);
  - otherwise `None`. Opencode keeps its own path. Codex keeps its 503 (deferred).
- `ClaudeRestLane` (new, `crates/freshell-freshagent/src/claude_rest_lane.rs`) holds a `FreshClaudeState` clone, the `freshAgent.enabled` gate (`Arc<dyn Fn() -> bool>`, backed by `fresh_codex.is_enabled()` in `main.rs`, the same gate the WS create uses at `terminal.rs:1890`), and a settings reader.
  - **create:** check the gate. If disabled, answer `403 FRESH_AGENT_DISABLED`. Otherwise build a `FreshAgentCreate` with `request_id` set to a server-minted id that also becomes the pane's `createRequestId`. Apply the resolved Claude defaults (below), `session_ref` (resume), `tab_id`/`pane_id`, and `naming_handle` (body or minted; omitted for kilroy, matching `naming::is_unified_agent_mode`). Call `handle_create(create, None)` and map I1:
    - `Created` → 200;
    - `SESSION_RESERVED` with owner → 409 via `fail_json_conflict_with_owner` (`lib.rs:4704`);
    - half-sent fence or invalid input → 400;
    - `CLAUDE_SIDECAR_*` (spawn or write) → 503;
    - anything else → 500.

    Because the pane's `createRequestId` equals the create's `requestId`, any later browser `freshAgent.create` for that pane replays the same session through `create_dedup`. That makes "no parallel writer" hold by construction, not by convention.
  - **send:** strip exactly one trailing `\r` or `\n` (the submit key). A payload made only of line terminators is a **no-op 200 `{status:"noop"}`**, so the MCP pattern of sending literal text and then a separate `ENTER` works. Resolve the session id: `sessionRef` durable if known, else the pane's `sessionId`. If it is not live, answer `409 FRESH_AGENT_SESSION_NOT_LIVE` (retryable; see I5). Otherwise subscribe to I3, call `handle_send` with `request_id: Some(rid)` and `settings: None`, then wait for `Settled` with `rid` in `retired_request_ids`:
    - before the deadline: 200 `{status:"idle", submittedTurnId: rid, sessionRef}`;
    - deadline reached: approx `{status:"approx"}`;
    - `Ended`: `409 FRESH_AGENT_SESSION_ENDED`.

    The turn goes through the normal consumer, so the unified `freshAgent.turn.complete` edge, the bell and attention all fire unchanged.
  - **capture:** find the durable id (pane `sessionRef`, else a new `FreshClaudeState::durable_id_for(id)` that reverse-looks-up `cli_index`). With no durable id, return empty text (no turn yet). Otherwise read `get_snapshot(session_type, durable)` and render with the shared `render_snapshot_text`. G28 states: `Absent` and live → empty text; `Absent` and not live → 404; `Unreadable` → 503.
- **Ordering for create and split:** mint the layout ids first (`layout.create_tab` / `layout.split_pane`). Then create the session with that pane context, which G19's `FRESHELL_PANE_ID` needs. Then attach content, register the `PaneEntry`, and broadcast `tab.create`/`pane.split` with `activate:false` (focus-neutral contract). On failure, close the tentative pane or tab. Split already works this way (`pane_ops.rs:185-260`). The hosted lane moves to the same order, with no visible change.
- **Defaults:** `claude_create_defaults.rs` provides `fn resolve_claude_rest_create(session_type, body: &RestLaneProviderInputs, settings: &ServerSettings) -> ResolvedClaudeCreate`. It mirrors `PaneContainer.tsx:706-760` for the Claude runtime:
  - model = body, else registry `opus[1m]`. This mirrors the client's current rule; G11 will change both sides.
  - `permissionMode` = body, else `settings.freshAgent.providers[st].defaultPermissionMode`, else `bypassPermissions`.
  - effort = body, else provider effort, else `high`.
  - plugins = body, else `settings.freshAgent.defaultPlugins`.
  - `modelSelection` = body, else provider.

  The same values go into the create and into `paneContent`, so the browser displays and later sends identical settings. These defaults also apply to Claude through the **hosted** lane, which fixes the same divergence there. Codex and opencode are untouched.
- **`pane_entry_for_request`:** replace the gateway-only fallback with "layout fallback when `rest_lane_for(content.provider)` is `Some`". Also parse a provider-matched `sessionRef` into `PaneEntry.durable_id`.
- **MCP tool (`tools/freshell-mcp/freshell-tool.ts`):** `agentResumeProvider` accepts `'claude'` (and `'kilroy'`, which maps to provider `claude`). Update the `INSTRUCTIONS` "Fresh agents" text (`:58-61`) to say `agent:"claude"|"kilroy"|"opencode"`. No test asserts on that text.
- **Docs:** update the AGENTS.md "Fresh-Agent Orchestration" paragraph and add a README usage line. `docs/index.html` is not affected (no UI change).
- **Logging (JSONL, ids only, never prompt text):** `freshagent.claude.rest_lane.create` (`info`: request_id, session_type, outcome, code, elapsed_ms) and `freshagent.claude.rest_lane.send` (`info`: pane_id, session_id, request_id, outcome, completed, waited_ms). Refusals log at `warn`.

**Alternative considered and rejected:** let the browser perform the create (REST broadcasts a `creating` pane and waits for the browser's `freshAgent.created`). This hangs headless callers that have no browser connected. It makes REST latency depend on a browser, and it needs a server fallback anyway, which would mean two create drivers racing on one `requestId`.

**Deferred.**
- An in-process **codex** REST lane: it would be a new codex feature. After this PR it is about one struct plus the `rest_lane_for` arm.
- Moving **opencode's** bespoke REST lane (`lib.rs:4864-4990, 6339-6960`) onto `FreshAgentRestLane`: a separate cleanup.
- Early return on `Waiting` (an approval is pending): rare under the bypass default; follow-up.

### 2.6 G29: hosted gateway routing for `freshAgent.configure`

**Verified current behavior**
- `HostedFreshAgentCommand` and `from_message` cover create, attach, send, interrupt, kill, recovery.stop, approval, question, compact, fork, undo and redo. They do **not** cover `FreshAgentConfigure` (`freshell-ws/src/hosted_fresh_agent.rs:16-48`). It ends in a `_ => None` wildcard, so nothing forces new variants to be classified.
- `dispatch_if_installed` runs first, under the rule "never allowed to fall through" (`terminal.rs:1091-1096`). Configure falls through to the in-process states (`terminal.rs:2092-2113`), which do not own hosted sessions. The result is:
  - Claude: an invisible top-level `SESSION_NOT_FOUND` (`claude.rs:4748-4750`).
  - Codex: a nested `INVALID_SESSION_ID`, which falsely marks the pane lost.
- In hosted mode each send already carries the pane's settings. The actor writes them into the soul profile (`host_actor.rs:581-630, 1207-1223`). So a hosted model change today only takes effect at the next turn, and other devices are not told about it.
- `compact` already shows the full hosted RPC path: `FreshAgentCompactRequest` (`freshell-runtime-protocol/src/fresh_agent_ops.rs:8`), `AdminCommand::FreshAgentCompact` (`lib.rs:2863`), supervisor (`service.rs:531, 1699`), session host (`main.rs:622`), actor `FreshAgentOperation::Compact` (`host_actor.rs:182-193`), and transport `dispatch_operation` (`fresh_agent.rs:784-890`).

**Target**
- **Classifier.** `pub(crate) fn hosted_route(&ClientMessage) -> HostedRoute { Gateway(HostedFreshAgentCommand), NotFreshAgent }`, written as an exhaustive `match` over all 44 `ClientMessage` variants with **no wildcard**. Adding a variant fails to compile in `freshell-ws` until someone decides where it goes. `dispatch_if_installed` uses it. Add `HostedFreshAgentCommand::Configure`.
- **Proxy** (`fresh_agent_proxy.rs:193-450`): add a `Configure` arm. It resolves the soul and calls `client.fresh_agent_configure(request_id, soul, turn_settings(settings, cwd))`. An unknown soul or an RPC failure produces `operation_error_event`, a nested error the user can see.
- **Runtime RPC (compact pattern):**
  - `FreshAgentConfigureRequest { soul_id, settings: FreshAgentTurnSettings, expected_control_epoch }`
  - `AdminCommand::FreshAgentConfigure` / `HostCommand::FreshAgentConfigure`
  - runtime-client method `fresh_agent_configure`
  - supervisor route
  - session-host dispatch
  - actor `configure()`: `apply_turn_settings` to the profile, persist, then `transport.dispatch_operation(&FreshAgentOperation::Configure { settings })`
  - `HostedTransport` arm: build `FreshAgentConfigure`, then call the provider's `handle_configure`. The resulting `freshAgent.session.metadata` or error frames reach the browser through the existing provider-event relay.

  Saving the intent before the live apply matches the current per-send rule. If the live apply is refused (Claude refuses mid-turn), the setting still applies at the next turn, as it does today.

---

## 3. New probe evidence (real CLI 2.1.237 / SDK 0.3.237, local fake endpoint; Anthropic API never contacted)

### 3.1 Sidecar shutdown versus hard kill (G31)
Scripts: `/tmp/claude-1000/-home-dan-code-freshell/1374fc0b-889d-437e-b369-0aa473c2880f/scratchpad/shutdown-probe/harness.mjs` and `/tmp/claude-1000/-home-dan-code-freshell/1374fc0b-889d-437e-b369-0aa473c2880f/scratchpad/shutdown-probe/child.mjs`. A child node process acts as the sidecar and holds one streaming turn. The fake provider streams for about 6 s.

| Mode | Node exit | Provider request closed | CLI death |
|------|-----------|-------------------------|-----------|
| `graceful`: `abort.abort(); q.close(); process.exit(0)` (exactly `index.mjs` `shutdown`) | +24 ms after the shutdown signal | +54 ms | **+126 ms** |
| `hard`: SIGKILL node mid-turn (what Windows `start_kill` does when it beats the shutdown line) | immediate | **only when the provider finished the turn (+5.8 s)** | +2.1 s after the turn ended |

Conclusions:
- The graceful path reliably stops the CLI. A 2 s grace period is generous (about 15 times the observed time).
- When node is killed hard, the orphaned CLI **keeps executing the in-flight turn until it ends**. With tool use that can be minutes of file edits. It does then exit on stdin EOF.
- On Linux the `/proc` tag reaper covers this today. On Windows and macOS nothing does. Hence the grace period plus the tree guard.

### 3.2 MCP environment inheritance (G19)
Scripts: `/tmp/claude-1000/-home-dan-code-freshell/1374fc0b-889d-437e-b369-0aa473c2880f/scratchpad/mcp-env-probe/probe.mjs` and `/tmp/claude-1000/-home-dan-code-freshell/1374fc0b-889d-437e-b369-0aa473c2880f/scratchpad/mcp-env-probe/mcp-server.mjs`.
- The stdio MCP child received `FRESHELL`, `FRESHELL_URL`, `FRESHELL_TOKEN`, `FRESHELL_TAB_ID` and `FRESHELL_PANE_ID` from the SDK `env` option, unchanged.
- It started about 806 ms after `query()` both with a prompt and with **no prompt**. The `system/init` message reported `mcp_servers: [{name:"freshell", status:"connected"}]`.
- The vendored `sdk.mjs` builds `Z.push("--mcp-config", JSON({mcpServers}))`, so MCP config goes on argv. A token must therefore never go in `mcpServers.env`.

---

## 4. Ordered TDD commits

Each step: write the failing test (red), make it pass (green), then refactor. A "refactor" commit has no behavior change and is pinned by the tests named in it. Commit messages end with the attribution trailer.

### PR1: G28
1. **red:** `claude_snapshot.rs` unit tests for `claude_home_candidates_from`:
   - (a) HOME unset, injected home `/h` → `[/h/.claude]`;
   - (b) Windows-shaped input (no HOME, injected `C:\Users\u`) → `[C:\Users\u\.claude]`;
   - (c) order `CONFIG_DIR > CLAUDE_HOME > home`, with duplicates removed.

   **green:** pure function plus wrapper. **refactor:** delete the `cfg(windows)` branch in `locate_transcript_selected`. Rewrite `snapshot_with_no_resolvable_store_root_is_io_not_notfound` (`:1733-1748`) to drive "no roots" through the pure seam. Its intent (cannot check, so must not deny) is kept: on POSIX, `home_dir()` can no longer be emptied through env.
2. **red:** locator tests:
   - missing `projects` → `Absent`;
   - `projects` with mode 000 → `Unreadable(Io{kind: PermissionDenied})` (skipped when `geteuid()==0`);
   - a hit under root 2 while root 1 is unreadable → `Found`;
   - root 1 unreadable and root 2 absent → `Unreadable`;
   - the nested layout is still found;
   - no roots → `Unreadable(NoStoreRoot)`.

   **green:** `locate_transcript_state`, `find_transcript_state`; `find_transcript` becomes a projection of it.
3. **red:** `get_claude_snapshot` with `CLAUDE_CONFIG_DIR` → mode-000 projects → `Io` (500), not `NotFound`. **green:** map the three states.
4. **red:** `crates/freshell-ws/tests/freshagent_claude_attach.rs`. Attach by durable UUID with an unreadable store: assert **no** `INVALID_SESSION_ID` frame, and that the resume answers transiently. **green:** `resume_for_attach` match.
5. **red:** `crates/freshell-ws/tests/freshagent_claude_rollback.rs`. Undo with an unreadable store → `INTERNAL_ERROR`, not `NOTHING_TO_UNDO`. Redo with an unreadable original → `INTERNAL_ERROR`, not `REDO_UNAVAILABLE`. **green:** the five rollback sites.
6. **red:** `freshell-server/src/existence.rs` test with an injected locator returning `Unreadable` → `SessionExistence::Unknown` (both the cold and warm-fallback paths). **green:** change the locator type and wire `main.rs:2110`.
7. **refactor:** `claude_truth.rs` `ClaudeRoots::from_env` delegates to the shared candidates. Its existing tests pin the result.

### PR2: G31 and G30
8. **refactor:** move `WindowsJob` to `freshell-platform::process_job::KillOnCloseJob`, and have checkpoints use it. Pinned by the existing checkpoint tests in the native Windows lane (`docs/development/windows-electron-build.md`).
9. **red (Linux):** `claude_spawn.rs` test. A fake sidecar script writes `shutdown-handled` and exits 0 on the shutdown line, and writes `sigterm` from its SIGTERM trap. `graceful_then_kill` must leave only `shutdown-handled` and return within the grace period. A second fake ignores the shutdown line: teardown must still finish within grace plus the confirmation budget, the process must be dead, and the log must say `graceful:false`. **green:** `graceful_then_kill`, used by `teardown_removed_session` and `shutdown()` (concurrent).
10. **red (Linux):** the `SidecarTreeGuard` Unix arm. Spawn `sh -c 'sleep 300 & sleep 300'` through the builder with `process_group(0)`. `guard.terminate()` must leave no group members (`kill(-pgid,0)` returns ESRCH). **green:** the Unix arm, wired into `spawn_sidecar`. The Linux `/proc` confirmation stays.
11. **red (`cfg(windows)`):** spawn `node -e "spawn(process.execPath,['-e','setInterval(()=>{},1e3)']); setInterval(()=>{},1e3)"` through the builder. Dropping the guard must reach `active_processes()==0` within 5 s, and `teardown_removed_session` must return `Confirmed`. **green:** the Windows arm (suspended spawn, assign, resume). Runs in the native Windows lane.
12. **red (JS):** `test/unit/claude-sidecar/sdk-env.test.ts`. It strips `CLAUDECODE`; it strips `ANTHROPIC_API_KEY` unless `FRESHELL_CLAUDE_ONECLI_API_KEY==='1'`; it drops the flag itself. Extend `model-catalog.test.ts`: with the flag set, the fake `query` receives the key. **green:** `sdk-env.mjs`, imported by both entry points.
13. **red (Rust):** `ClaudeNodeCommand::from_parts` tests. With an injected secrets snapshot `{ANTHROPIC_API_KEY}` and `FRESHELL_PROVIDER_RUN_AS_*`, the sidecar command and the catalog-probe command produce the same program, wrapper args, ONECLI flag and secret env. Only the entry file differs. **green:** the builder. `spawn_sidecar` and `ClaudeCatalogProbe` use it, and the probe's timeout calls `guard.terminate()`.
14. **contract (real CLI):** `test/integration/providers/claude-sidecar-shutdown.{mjs,test.ts}`, modelled on `claude-checkpoint-uuid-replay.*`. It runs the **real** `index.mjs` with the pinned CLI and a local fake endpoint, mid-turn. Sending `{"type":"shutdown"}` must make node exit, the CLI pid disappear, and the provider request close, all within 1 s. This pins the assumption the grace period depends on.

### PR3: G19
15. **refactor:** add `freshell_platform::freshell_context_env`. Both `build_terminal_base_env` copies delegate. Pinned by `terminal.rs:11544-11575` and the `terminal_tabs` env tests.
16. **red (JS):** `test/unit/claude-sidecar/mcp-servers.test.ts`.
    - Ordinary request → `{freshell:{command,args}}`.
    - Hosted request with hosted env → the fixed hosted recipe.
    - Neither → `undefined`.
    - Both set → hosted wins and ordinary is ignored.
    - The returned config **never has an `env` key**. That is the behavior that keeps a token off argv.

    Second case: `freshellContext` is merged into the `env` that the fake `query` receives. **green:** `mcp-servers.mjs`; `index.mjs` uses it.
17. **red (protocol):** serde round-trip for `FreshAgentCreate.pane_id` and `FreshAgentAttach.{tab_id,pane_id}`. An absent field is omitted on serialize, and old frames still parse. **green.** Matching zod change; extend `test/unit/shared` ws-protocol tests.
18. **red (Rust integration, I7 harness or request-log fake):**
    - With a fake MCP provider returning `Some`, the create line has `freshellMcp`. The spawn env has `FRESHELL_URL`/`FRESHELL_TOKEN`. `freshellContext` matches the create's `tabId`/`paneId`. Same for kilroy.
    - With the provider returning `None`, no `freshellMcp`.
    - With `with_hosted_mcp(true)`, never `freshellMcp`.
    - Attach-resume and rollback respawn carry the same recipe and context (through I4).

    **green:** state setters, `spawn_sidecar` env, and the create builder.
19. **red (`freshell-server`):** the provider closure built in `main.rs` (extract a `fn claude_mcp_provider(settings_lock, runtime)` for testing). After `PATCH /api/settings {codingCli:{mcpServer:false}}` it returns `None`, and after flipping back it returns `Some`, with no restart. **green.**
20. **red (client):** the `FreshAgentView` tests that capture sent frames assert that `freshAgent.create` includes `paneId` and `freshAgent.attach` includes `tabId`/`paneId`. **green.**
21. **contract (real CLI):** `test/integration/providers/claude-freshell-mcp.{mjs,test.ts}`. Real `index.mjs` and the pinned CLI. Create with `freshellMcp` pointing at a probe MCP server, and give the sidecar env `FRESHELL_URL`/`FRESHELL_TOKEN=<random>`. Assert:
    - init reports `freshell: connected`;
    - the probe server saw `FRESHELL_URL`/`FRESHELL_TOKEN`/`FRESHELL_TAB_ID`/`FRESHELL_PANE_ID`;
    - `/proc/<cli pid>/cmdline` does **not** contain the token.

### PR4: G18 (needs I1–I3, or their fallbacks)
22. **refactor (only if I1/I2 have not landed):** the typed `ClaudeCreateOutcome` and `ClaudeSendOutcome` returns, with WS frames byte-identical. Pinned by every existing `freshagent_claude_*` test.
23. **refactor:** rename `hosted_rest` to `rest_lane` (trait and types), and `create_hosted_agent_tab` to `create_lane_agent_tab`. Add `rest_lane_for`. Pinned by `pane_ops_tests.rs`, `pane_ops_tab_tests.rs`, `snapshot.rs:513`, `lib.rs:9231` and `fresh_agent_proxy_tests.rs`.
24. **refactor:** move `render_snapshot_text` into `freshell-agent-runtime` (`snapshot_text.rs`) and have session-host use it. Its test `snapshot_text_renderer_is_plain_and_utf8_bounded` moves along.
25. **red:** a shared fixture `test/fixtures/fresh-agent/claude-create-defaults.json` (settings input → expected create fields).
    - A vitest test runs the extracted pure `buildFreshAgentPaneContent` (moved out of the `createContentForType` callback at `PaneContainer.tsx:692`) over the fixture.
    - A Rust test runs `resolve_claude_rest_create` over the same fixture.

    Both run real resolvers, and either side's drift fails its own test. **green:** extract the TS function; add the Rust resolver.
26. **red (`lib.rs` unit, fake `FreshClaudeState` sidecar or the I7 harness), no gateway:**
    - `POST /api/tabs {agent:"claude"}` → 200 `{tabId,paneId,sessionId}`. The broadcast `tab.create` has `paneContent{provider:"claude", sessionType:"freshclaude", sessionId, createRequestId, status:"connected", model:"opus[1m]", permissionMode:"bypassPermissions", effort:"high"}`.
    - `agent:"kilroy"` is the same apart from `sessionType` and no `namingHandle`.
    - `agent:"codex"` is still 503.
    - With the gate off → 403 `FRESH_AGENT_DISABLED`, and no layout tab is left behind.

    **green:** `ClaudeRestLane`, plus `set_claude_rest_lane` in `main.rs`.
27. **red:** create failure mapping. A `SESSION_RESERVED` with owner → 409 with `ownerKind`/`ownerGeneration`. A sidecar spawn failure (bad `FRESHELL_CLAUDE_NODE`) → 503. Both roll the tentative tab back. **green.**
28. **red:** `POST /api/panes/:id/split {agent:"claude"}` creates through the lane and broadcasts `pane.split` with `activate:false`. On failure the split is closed. **green.**
29. **red:** `pane_entry_for_request` resolves a UI-created freshclaude pane (layout only, with `sessionRef`) with no gateway. Send-keys and capture reach the lane. **green.**
30. **red:** send-keys.
    - An idle session's turn → 200 `{status:"idle", submittedTurnId}` after `Settled` names the request id.
    - `"\r"` alone → 200 `noop`, and nothing is sent to the sidecar.
    - A trailing `\r` is stripped (the sidecar request log shows the text without it).
    - A session that is not live → 409 `FRESH_AGENT_SESSION_NOT_LIVE`.
    - Deadline → `approx`.
    - Fallback build (no I3): busy → 409 `SESSION_BUSY`.

    **green.**
31. **red:** capture.
    - After a scripted turn → `"user: …\nassistant: …"`.
    - No turn yet → empty 200.
    - Unreadable store (G28) → 503.

    **green.**
32. **integration:** `crates/freshell-ws/tests/rest_freshclaude_lane.rs`, using the merged REST and WS harness (`rest_claude_identity.rs:52-…`) and I7.
    - `POST /api/tabs {agent:"claude"}`; a WS observer sees `freshAgent.created` and `ui.command tab.create`.
    - Send-keys returns idle. The observer sees `freshAgent.turn.complete` for that session (the unified edge).
    - Capture shows the assistant text.
    - **One writer:** a second WS client sends `freshAgent.create` with the pane's `createRequestId`, gets the replayed `created` with the same id, and the fake's spawn counter is still 1.
33. **red (`test/unit/mcp/freshell-tool.test.ts`):** `new-tab {agent:"claude", resume:<uuid>}` posts `sessionRef {provider:"claude", sessionId}`, and `kilroy` maps to the same. **green:** `agentResumeProvider`. Then update the instructions text (not tested).
34. **e2e:** see §5.5. Then the docs commit (AGENTS.md, README).

### PR5: G29
35. **red (`freshell-ws`):** `hosted_route` unit test. One sample frame of every `freshAgent.*` type (create, attach, send, interrupt, configure, compact, approval.respond, question.respond, kill, recovery.stop, fork, undo, redo) must classify as `Gateway`. Configure is red today. **green:** the exhaustive no-wildcard classifier, plus `Configure`.
36. **red (`freshell-runtime-protocol`):** `FreshAgentConfigureRequest` serde round-trip in `fresh_agent_ops_tests.rs`, and `AdminCommand`/`HostCommand` variants. **green.**
37. **red (supervisor `service.rs` tests):** admin configure routes to the soul's host and keeps the epoch fence. **green.**
38. **red (`host_actor` tests):** `configure()` persists the settings into the profile (they survive `FreshAgentHostActor::open` on the same state dir) and calls `transport.dispatch_operation(Configure)`. A refused live apply still keeps the intent. **green.**
39. **red (session-host):** add `Configure` to `semantic_operations()` and `direct_and_hosted_provider_transport_operations_have_matching_rows` (`fresh_agent.rs:2326, 2597`). Direct and hosted rows must match, and the Claude row's provider frames include `freshAgent.session.metadata`. **green:** the `HostedTransport` arm.
40. **red (`fresh_agent_proxy_tests.rs`):** Configure with an unknown soul → a nested `freshAgent.error`. Configure with a known soul → `fresh_agent_configure` called with the mapped settings. **green:** the proxy arm and the runtime-client method.

---

## 5. Test plan by layer

### 5.1 Unit (Rust)
- `claude_snapshot.rs`: candidates (pure seam), three-state traversal, snapshot mapping.
- `claude_spawn.rs`: graceful versus forced teardown with timing bounds, Unix process-group guard, builder parity. Windows job tests are `cfg(windows)`.
- `claude_create_defaults.rs`: fixture-driven.
- `claude_rest_lane.rs`: create, send and capture mapping, against the request-log fake.
- `lib.rs` / `pane_ops*` tests: lane selection, layout rollback, pane-entry fallback.
- `freshell-protocol`: serde for the new optional fields, and `agent_mcp_server_enabled`.
- `freshell-ws` `hosted_fresh_agent.rs`: the classifier.
- `freshell-runtime-protocol`, `freshell-supervisor`, `freshell-agent-runtime` `host_actor`: configure.
- `freshell-server` `existence.rs` (`Unreadable` → `Unknown`) and the settings-driven MCP provider.

### 5.2 Unit (JS/TS)
- `test/unit/claude-sidecar/sdk-env.test.ts`, `mcp-servers.test.ts`, and `model-catalog.test.ts` (extended).
- `test/unit/mcp/freshell-tool.test.ts` (Claude resume shorthand).
- Client: `FreshAgentView` frame tests (`paneId`/`tabId` on create and attach), and the `buildFreshAgentPaneContent` fixture test.
- `shared/ws-protocol` schema tests.

### 5.3 Integration (Rust, `crates/freshell-ws/tests`)
- `freshagent_claude_attach.rs`: unreadable store is not lost.
- `freshagent_claude_rollback.rs`: unreadable store gives `INTERNAL_ERROR`.
- New `rest_freshclaude_lane.rs`: create, send, complete edge, capture, one-writer dedup, split, layout fallback after the REST pane map is cleared (simulates a web restart).
- New `freshagent_claude_mcp_launch.rs`: `freshellMcp`/context on create, attach-resume and rollback; hosted exclusion.
- All of these use the real `index.mjs` plus the scripted SDK once I7 lands.

### 5.4 Contract (real pinned CLI, local fake endpoint, `test/integration/providers/`)
- `claude-sidecar-shutdown`: the graceful shutdown stops the CLI within 1 s.
- `claude-freshell-mcp`: the MCP child inherits the endpoint and context, init reports connected, and the token is absent from CLI argv.

### 5.5 Browser e2e (Playwright `rust-chromium`, `RustServer` with the fake Claude SDK sidecar `test/e2e-browser/fixtures/providers/fake-claude-sdk-sidecar.mjs`)
Run these on the configured `FRESHELL_E2E_BACKEND`. They must not be in `CLOUD_SKIP_SPECS`.
- **New `fresh-agent-rest-claude-rust.spec.ts`** (G18):
  1. Through `McpStdioClient` (`helpers/mcp-stdio-client.ts`): `new-tab {agent:"claude", prompt:"hello"}`. The browser shows a Freshclaude tab without taking focus (`activate:false`), and the transcript shows the scripted reply.
  2. With the user on another tab, the new tab gets the needs-attention mark and exactly one bell (the alert contract holds for REST-driven turns).
  3. `capture-pane` returns the reply.
  4. `split-pane {agent:"kilroy"}` with the kilroy flag on.
  5. `send-keys` to a **UI-created** freshclaude pane (picker → Freshclaude) runs a turn that is visible in that pane.
  6. A web-server restart, then `capture-pane` on the same pane, still works (layout fallback).
- **G19:** teach the e2e fake sidecar a scripted rule `__call_freshell_mcp__`. When the create line has `freshellMcp`, the fake spawns that command with its inherited env, performs MCP `initialize` and `tools/call` (`freshell` `list-tabs`), and returns the result as assistant text. The spec types that prompt in a Freshclaude pane and asserts that the reply lists the open tabs. This proves end to end that the command Rust resolves (`dist/tools/freshell-mcp/server.js` through `ensureMcpServerBuilt`), the endpoint env and the token work against the real server. A second case turns the Settings toggle "Agent MCP server" off, opens a new pane, and asserts the fake reports that no MCP was configured.
- **G28/G31/G30/G29:** no browser surface beyond what is listed. They are covered by unit, integration, contract and the Windows lane. If managed-mode e2e is enabled in CI (`runtime-fresh-agent-qualification-rust.spec.ts`), add one case: change the model in the model dialog, and a second page converges without a send.

### 5.6 Windows native lane
`cfg(windows)` tests for `KillOnCloseJob` reuse and the Claude tree guard. Also a manual Electron check: close a freshclaude pane mid-turn and confirm no `claude.exe` remains (Task Manager or `Get-Process claude`). Use the documented rsync plus `cmd.exe` pnpm flow (`docs/development/windows-electron-build.md`).

---

## 6. Risks and mitigations

1. **Interface churn with core-runtime** (I1–I4 touch the handlers core-runtime is rewriting). Mitigation: agree on the signatures in §1 before PR4. PR1–PR3 do not depend on them. Every interface has a documented fallback.
2. **REST send-keys correlation without I3** can report one turn early when a browser send races in. Mitigation: the idle-required fallback, documented, and removed once I3 lands.
3. **Default resolution exists twice (TypeScript and Rust).** Mitigation: the shared fixture runs both resolvers. G11 (saved default model) must update the fixture, and with it both sides.
4. **`home_dir()` semantics on POSIX with HOME unset** now use the passwd home. This matches the CLI, but a deployment that deliberately unset HOME to hide the store would now find it. That is acceptable: the CLI itself uses the same root.
5. **Grace period delays teardown** when a sidecar is wedged (at most 2 s per session). It runs concurrently at server stop. The kill path already waits on tree confirmation, so the difference is small.
6. **Windows job edge cases:**
   - Nested jobs (Windows 8+ supports them).
   - `CREATE_SUSPENDED` and resuming the main thread (the existing helper `find_process_thread` handles it).
   - A server that is itself in a job forbidding nested assignment: the failure is logged and the pane works without the guard.
7. **Token in the freshclaude CLI environment.** The Bash tool can read `FRESHELL_TOKEN`, as it already can in terminal panes. Under the threat model this is acceptable. It is never on argv, and the contract test enforces that.
8. **User-level MCP named `freshell`** (from `~/.claude.json`, with settingSources `user,project,local`) could clash with the injected one. Terminal mode's `--mcp-config` has the same behavior today. Note it in the PR; there is no special handling.
9. **The setting is inconsistent until #446** (freshclaude honors it, terminals do not). Mitigation: the follow-up PR is queued immediately.
10. **The managed-runtime crates** (G29) belong to another plan. Mitigation: a separate PR5, using the compact pattern, with the routing test and classifier first.
11. **The `existence.rs` type change** touches `freshell-server` wiring that the kata 09v1 reconcile relies on. Mitigation: `Unreadable` → `Unknown` is the deferral that existing reconcile code already handles. The cold and warm paths are both tested.
12. **Unix process group for the sidecar.** Terminal Ctrl-C no longer reaches sidecars directly under `pnpm run dev`. They still exit through server `shutdown()` or stdin EOF (`index.mjs:684-686`). The Linux `/proc` reaping is unchanged.

---

## 7. Deferred, with reasons
- **In-process codex REST lane:** a new codex feature, out of scope. It is a small follow-up after PR4 (one `FreshAgentRestLane` implementation).
- **Moving opencode onto `FreshAgentRestLane`:** a cleanup with no freshclaude impact.
- **Gating terminal MCP injection on `codingCli.mcpServer` (#446):** changes terminal behavior for all CLIs. Do it next, as its own PR, using `agent_mcp_server_enabled()`.
- **Hosted catalog probe through the session host (G30 remainder):** managed opt-in mode only, needs a new RPC, and the static fallback exists. Belongs to the managed-provider-environment plan.
- **REST early return on `Waiting`:** rare under the bypass default. Follow-up.
- **macOS tree-kill verification beyond the shared Unix process-group code:** no macOS CI. The code is exercised on Linux. Verify manually on a macOS Electron build when one is next produced.
