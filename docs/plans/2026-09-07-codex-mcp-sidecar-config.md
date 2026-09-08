# Managed Codex Sidecar MCP Parity Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Fix managed Codex startup so the Codex TUI and its separate app-server receive the same Freshell MCP configuration and terminal context, eliminating the indefinite “Booting MCP server: node_repl” state while preserving the Freshell MCP’s working tool access.

### Explicit constraints
- Use the-usual repair-and-review workflow.
- Work in a dedicated repository worktree; do not modify or restart the live self-hosted Freshell server without explicit APPROVED authorization.
- Preserve the managed Codex launch architecture and verify the affected behavior with meaningful automated coverage.

### Accepted tradeoffs and residuals
- Starting the Freshell MCP alongside node_repl may add roughly half a second to the startup round; the servers start concurrently.

**Goal:** Every newly spawned managed Codex TUI/app-server pair receives one semantically identical Freshell MCP definition and one matching parent-process Freshell context, so the app-server can start and use the Freshell MCP instead of leaving the TUI waiting on the incomplete startup round.

**Architecture:** Resolve the Freshell MCP command recipe once, render it separately for the TUI execution target and the host-native app-server execution target, and add a value-free Codex `env_vars` declaration that forwards the six existing `FRESHELL_*` names from each parent process. Carry the host-side rendering and parent environment through the managed launch plan only to a newly spawned app-server; a verified survivor remains deliberately unmodified. Reserve the terminal identity before restore preplanning, retain it with the prepared launch, and make failed adoption tear down the still-owned sidecar transactionally.

**Tech Stack:** Rust 2021 workspace; Tokio process spawning and WebSocket proxy; `freshell-platform` MCP injection/target helpers; existing Rust fake-sidecar integration tests; existing opt-in real Codex provider-contract harness for final acceptance.

## Global Constraints

- Work only in `/home/dan/code/freshell/.worktrees/codex-mcp-sidecar-config` on `the-usual/codex-mcp-sidecar-config`; do not restart or otherwise mutate the live port-3001 Freshell server.
- Keep the managed topology intact: one app-server, one loopback proxy, and one TUI. Preserve the explicit `FRESHELL_CODEX_MANAGED_LAUNCH=0` plain-CLI opt-out, planning queue, retry budget, durable sidecar identity checks, and existing fresh-agent lane.
- Codex 0.153.4 clears the stdio MCP child's inherited environment. The only safe transport for Freshell values is actual parent-process environment plus the fixed value-free `mcp_servers.freshell.env_vars` list below. Never serialize a token, endpoint, terminal id, tab id, or pane id into inline TOML, argv, a durable sidecar record, logs, errors, or Debug output.

  ```text
  FRESHELL
  FRESHELL_URL
  FRESHELL_TOKEN
  FRESHELL_TERMINAL_ID
  FRESHELL_TAB_ID
  FRESHELL_PANE_ID
  ```

- A TUI may run in a different Windows/WSL namespace from the host-native sidecar. Equality is therefore semantic (one tagged recipe, the same literals and `env_vars` names), not byte-for-byte equality of rendered argv. The sidecar always receives host-native `resolve_mcp_cwd(...)`, never the raw requested create cwd.
- A sidecar that is already running before a new restore cannot be reconfigured. Preserve its current verified-survivor reattach behavior; do not claim that it received the replacement TUI's context, do not kill it, and do not make its record's new ownership metadata a parity signal. The correction applies to every newly spawned/retry sidecar. This avoids interrupting active Codex work.
- Do not alter the generic non-managed `generate_mcp_injection` behavior merely to serve this managed topology. Use a managed-Codex rendering helper. Do not alter the fresh-agent sidecar other than explicitly passing the default empty context through the shared spawn-spec API.
- The existing raw sidecar command-line record may continue to persist static command/path and `env_vars` *names*. Do not perform a schema migration: actual Freshell values remain in process environment only, so a durable-record redesign is outside this request.
- Treat the fake-sidecar integration test as process-construction/proxy coverage, not proof of Codex's literal terminal display. A separate isolated real-provider acceptance run is the only evidence allowed to make that display claim.

## File Responsibilities

| File | Responsibility in this change |
| --- | --- |
| `crates/freshell-platform/src/mcp_inject.rs` | Resolve the tagged MCP recipe once and render safe target-specific managed-Codex injections with the fixed `env_vars` declaration. |
| `crates/freshell-platform/src/mcp_inject_tests.rs` | Pin recipe-once behavior, no-value TOML, and Unix/WSL/Windows rendering matrix. |
| `crates/freshell-codex/src/launch_plan.rs` | Own redacted sidecar context and deterministic app-server argv/environment composition. |
| `crates/freshell-codex/src/launch_lifecycle.rs` | Apply context only to spawned runtimes and retain/discard launch ownership correctly after adoption failure. |
| `crates/freshell-codex/src/runtime_select.rs` | Give a spawned runtime the context while preserving a reattached runtime unchanged. |
| `crates/freshell-codex/tests/launch_lifecycle.rs` | Cover context spawn shape, redaction, and failed-adoption cleanup. |
| `crates/freshell-ws/src/terminal.rs` | Build one private managed setup for each spawned WS terminal; reserve/reuse its id through restore preplanning and auto-resume. |
| `crates/freshell-freshagent/src/terminal_tabs.rs` | Apply the same managed setup at the REST/MCP terminal-tab creation door. |
| `crates/freshell-freshagent/src/codex.rs` | Keep the unrelated fresh-agent sidecar explicitly empty-context. |
| `crates/freshell-ws/tests/codex_managed_launch_e2e.rs` | Observe both spawned roles and prove semantic config/context parity plus proxy initialization. |
| `crates/freshell-ws/tests/codex_sidecar_reattach_e2e.rs` | Preserve and label the survivor-reattach boundary without treating it as a parity case. |

---

### Task 1: Render one managed Codex MCP recipe safely for both execution targets

**Files:**

- Modify: `crates/freshell-platform/src/mcp_inject.rs:53-245,535-561`
- Modify: `crates/freshell-platform/src/mcp_inject_tests.rs:34-194`

**Interfaces:**

- Consumes: one `Vec<McpServerArg>` returned by `McpRuntime::server_command_args`, the selected TUI `ProviderTarget`, host `HostOs`, WSL regime, and `Env` for native-Windows-to-WSL conversion.
- Produces:

  ```rust
  pub const FRESHELL_MCP_CONTEXT_ENV_VARS: [&str; 6];

  #[derive(Debug, Clone, PartialEq, Eq)]
  pub struct ManagedCodexMcpRenderings {
      pub tui: McpInjection,
      pub sidecar: McpInjection,
  }

  pub fn build_managed_codex_mcp_renderings(
      runtime: &dyn McpRuntime,
      env: &dyn Env,
      host_os: HostOs,
      is_wsl_env: bool,
      tui_target: ProviderTarget,
  ) -> Result<ManagedCodexMcpRenderings, McpInjectError>;
  ```

- Preserves: `generate_mcp_injection`'s existing five-mode behavior and its existing `g_x4`/`g_w1` compatibility goldens. The new helper is used only by a managed Codex launch.

- [ ] **Step 1: Write the failing behavioral tests**

  Extend `FakeRt` with a shared `Arc<AtomicUsize>` call counter. Add these focused tests in `mcp_inject_tests.rs`:

  1. `managed_codex_renderings_resolve_one_recipe_and_forward_only_names`: use `MapEnv` with synthetic `FRESHELL_TOKEN=token-not-in-argv`; assert `server_command_args()` was called once; both renderings contain exactly one command pair, args pair, then `mcp_servers.freshell.env_vars=["FRESHELL", ...]`; neither rendering has `mcp_servers.freshell.env=`, `token-not-in-argv`, a terminal id, or a URL.
  2. `managed_codex_renderings_use_unc_for_wsl_windows_tui_and_posix_for_sidecar`: use Linux/WSL host inputs and a Windows TUI target; assert the TUI path values are UNC-rendered and the sidecar values remain POSIX.
  3. `managed_codex_renderings_use_wsl_paths_for_native_windows_unix_tui`: use native-Windows host inputs, Windows recipe paths, and a Unix TUI target; assert the TUI has `/mnt/<drive>/...` paths and the sidecar has Windows paths. A conversion failure must return `McpInjectError`, never pass a Windows path to the Unix TUI unchanged.

  Each test must compare complete `-c` pairs, not substring-only prose. Keep the existing generic `g_w1_native_windows_host_unix_target_keeps_windows_paths` test unchanged to prove the new managed helper, not a global behavior rewrite, owns the correction.

- [ ] **Step 2: Run the focused tests and verify the intended failure**

  Run:

  ```bash
  cargo test -p freshell-platform managed_codex_renderings
  ```

  Expected: FAIL because there is no managed rendering helper, the generic Codex injection resolves the recipe per call, has no `env_vars` pair, and cannot produce separate target renderings.

- [ ] **Step 3: Add the minimal production implementation**

  In `mcp_inject.rs`:

  1. Define `FRESHELL_MCP_CONTEXT_ENV_VARS` in fixed uppercase order.
  2. Split the current `build_mcp_server_command_args` operation into a recipe-resolution boundary and a pure renderer. The managed helper calls `server_command_args()` once, retains the returned `McpServerArg` tags, and renders that one recipe twice.
  3. Preserve the current WSL-to-Windows conversion for a Windows target on WSL. Add only the managed native-Windows-to-Unix branch using the existing `convert_windows_path_to_wsl_path`; map a nonconvertible tagged `Path` to a loud `McpInjectError` rather than emitting a wrong-namespace path.
  4. Derive the sidecar target from the actual host: `ProviderTarget::Windows` only for native Windows, otherwise `ProviderTarget::Unix`. It must not inherit the TUI wrapper target.
  5. Add a managed-only inline TOML builder that appends one deterministic `env_vars` `-c` pair after the existing command/args pairs. It serializes only the six names with `toml_escape`; it must never accept environment values as input.

  The resulting vectors have this exact field order:

  ```text
  -c mcp_servers.freshell.command="node"
  -c mcp_servers.freshell.args=[...target-rendered recipe...]
  -c mcp_servers.freshell.env_vars=["FRESHELL", "FRESHELL_URL", "FRESHELL_TOKEN", "FRESHELL_TERMINAL_ID", "FRESHELL_TAB_ID", "FRESHELL_PANE_ID"]
  ```

- [ ] **Step 4: Run the focused tests**

  Run:

  ```bash
  cargo test -p freshell-platform managed_codex_renderings
  ```

  Expected: PASS. The counter proves a single semantic recipe; target-specific path spellings and static `env_vars` order are exact; no synthetic value reaches TOML.

- [ ] **Step 5: Refactor while green**

  Keep one renderer over tagged `McpServerArg` values. Do not parse rendered TOML back into paths, duplicate the server-command discovery, or change the generic `generate_mcp_injection` Codex branch. Retain the existing public `build_mcp_server_command_args` as a thin one-rendering wrapper if existing callers require it.

- [ ] **Step 6: Run impacted-test verification**

  Run:

  ```bash
  cargo test -p freshell-platform
  cargo fmt --all -- --check
  ```

  Expected: PASS. This shared platform module owns every provider-injection golden, so its complete crate suite is the impacted set.

- [ ] **Step 7: Commit the task**

  ```bash
  git add -- crates/freshell-platform/src/mcp_inject.rs crates/freshell-platform/src/mcp_inject_tests.rs
  git commit -m "fix: render managed Codex MCP context per target"
  ```

### Task 2: Carry value-free sidecar configuration and clean up failed adoption transactionally

**Files:**

- Modify: `crates/freshell-codex/src/launch_plan.rs:162-343`
- Modify: `crates/freshell-codex/src/launch_lifecycle.rs:796-850,1125-1305`
- Modify: `crates/freshell-codex/src/runtime_select.rs:17-40`
- Modify: `crates/freshell-freshagent/src/codex.rs:3714-3745`
- Modify: `crates/freshell-codex/tests/launch_lifecycle.rs`

**Interfaces:**

- Consumes: target-specific sidecar config args and the canonical `BTreeMap<String, String>` terminal environment supplied by a terminal-pane door.
- Produces:

  ```rust
  #[derive(Clone, PartialEq, Eq, Default)]
  pub struct CodexSidecarLaunchContext {
      pub config_args: Vec<String>,
      pub env: BTreeMap<String, String>,
  }
  ```

  `CodexLaunchPlanInput` owns a `sidecar_context`, `CodexLaunchPlan` retains its clone, and `SpawnedCodexAppServerRuntime::with_context(context)` is the only runtime constructor that consumes it.

- Preserves: `CodexLaunchRuntime::ensure_ready(cwd)`, all reattached runtime behavior, existing `CODEX_MANAGED_REMOTE_CONFIG_ARGS` ordering, durable record schema, and empty-context direct/fresh-agent callers.

- [ ] **Step 1: Write the failing behavioral tests**

  Add tests beside the existing planner/lifecycle fakes:

  1. `sidecar_spawn_spec_places_context_before_app_server_and_redacts_values`: use a context containing static MCP pairs and synthetic `FRESHELL_TOKEN=not-visible`; assert `spec.args` is `-c features.apps=false`, context config pairs, `app-server --listen`; assert `spec.env` contains the token only as an environment value; assert ownership wins over a duplicate ownership key; assert `format!("{spec:?}")` and `format!("{context:?}")` contain environment key names but not `not-visible`.
  2. `spawned_runtime_receives_context_but_reattached_runtime_does_not`: use the runtime-selection seam to assert a no-survivor plan constructs a spawned runtime whose fake child sees the supplied env/config; retain the existing survivor selector expectation and assert it does not start a second child.
  3. `failed_adoption_discards_the_still_owned_launch`: make the fake runtime fail `update_ownership_metadata`, call `CodexTerminalLaunchManager::adopt`, and assert the original error is returned, proxy/child shutdown is attempted, and the planned sidecar is no longer retained in the planner active map.

- [ ] **Step 2: Run the focused tests and verify the intended failure**

  Run:

  ```bash
  cargo test -p freshell-codex sidecar_spawn_spec_places_context_before_app_server_and_redacts_values
  cargo test -p freshell-codex failed_adoption_discards_the_still_owned_launch
  ```

  Expected: FAIL because the spawn spec has no context parameter and `adopt` returns early on the fallible sidecar adoption, leaving the moved launch without immediate cleanup.

- [ ] **Step 3: Add the minimal production implementation**

  1. Add `CodexSidecarLaunchContext` next to `CodexSidecarSpawnSpec`. Implement custom `Debug` for both structures: show config args and sorted environment keys only, never values.
  2. Add an owned default context to `CodexLaunchPlanInput` and clone it into `CodexLaunchPlan`. Update every full-plan golden to expect `CodexSidecarLaunchContext::default()` unless it deliberately supplies a context.
  3. Change `codex_sidecar_spawn_spec(listen_ws_url, ownership_id, context)` to append `context.config_args` before `app-server`, merge `context.env` into a `BTreeMap`, then insert `FRESHELL_CODEX_SIDECAR_ID` last and return deterministic entries. Do not add literal `mcp_servers.freshell.env` values to config args.
  4. Give `SpawnedCodexAppServerRuntime` a context field, keep `new()` as an empty-context convenience constructor, add `with_context`, and use the context in `ensure_ready`. `select_codex_runtime` passes `plan.sidecar_context.clone()` only when it creates a spawned runtime. The reattached branch remains byte-for-byte behaviorally unchanged.
  5. In `CodexTerminalLaunchManager::adopt`, retain ownership of `launch` across `launch.sidecar.adopt(...)`. On error, call the existing best-effort discard/shutdown while still owning the launch, log a separate cleanup failure if one occurs, and return the original adoption error. Only build the event drain and insert into `adopted` after successful adoption.
  6. Update `freshell-freshagent/src/codex.rs` to pass `&CodexSidecarLaunchContext::default()` to the shared spawn builder. It must not inherit terminal-pane MCP arguments or environment.

- [ ] **Step 4: Run the focused tests**

  Run:

  ```bash
  cargo test -p freshell-codex sidecar_spawn_spec_places_context_before_app_server_and_redacts_values
  cargo test -p freshell-codex failed_adoption_discards_the_still_owned_launch
  ```

  Expected: PASS. A spawned fake sees the supplied environment, no debug path reveals a value, and failed adoption has an immediate cleanup owner.

- [ ] **Step 5: Refactor while green**

  Centralize argv/environment merging in `codex_sidecar_spawn_spec`; do not duplicate it in the runtime or terminal layers. Keep the transactional cleanup inside the manager so WS, auto-resume, and REST/MCP callers receive the repair without separate error-path code.

- [ ] **Step 6: Run impacted-test verification**

  Run:

  ```bash
  cargo test -p freshell-codex
  cargo test -p freshell-freshagent codex
  cargo check -p freshell-ws --all-targets
  cargo fmt --all -- --check
  ```

  Expected: PASS. If Cargo selects no fresh-agent tests for `codex`, also run `cargo check -p freshell-freshagent --all-targets`; do not count a zero-test filter as behavioral coverage.

- [ ] **Step 7: Commit the task**

  ```bash
  git add -- crates/freshell-codex/src/launch_plan.rs crates/freshell-codex/src/launch_lifecycle.rs crates/freshell-codex/src/runtime_select.rs crates/freshell-codex/tests/launch_lifecycle.rs crates/freshell-freshagent/src/codex.rs
  git commit -m "fix: carry managed Codex sidecar context safely"
  ```

### Task 3: Build one launch setup at every terminal-pane spawn door and prove spawned-pair parity

**Files:**

- Modify: `crates/freshell-ws/src/terminal.rs:2475-2526,2644-2715,2946-3820,4330-4602,5141-5175`
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs:352-384,1500-2010`
- Modify: `crates/freshell-ws/tests/codex_managed_launch_e2e.rs:65-420`
- Modify: `crates/freshell-ws/tests/codex_sidecar_reattach_e2e.rs:671-978`
- Test: `crates/freshell-ws/src/terminal.rs`
- Test: `crates/freshell-freshagent/src/terminal_tabs.rs`

**Interfaces:**

- Consumes: final terminal id, selected TUI target, host/WSL inputs, resolved native MCP cwd, requested tab/pane identities, and `build_terminal_base_env` output.
- Produces a private, deliberately non-`Debug` setup in each terminal-pane layer:

  ```rust
  struct CodexManagedLaunchSetup {
      terminal_id: String,
      runtime_cwd: Option<String>,
      tui_mcp_injection: McpInjection,
      terminal_env: BTreeMap<String, String>,
      sidecar_context: CodexSidecarLaunchContext,
  }
  ```

- Preserves: terminal base-environment optional tab/pane semantics, plain opt-out behavior, fresh restore exclusion, resume gate ordering, queue cancellation, survivor reattachment, browser reconnect, non-Codex launch paths, and all existing session-id arguments.

- [ ] **Step 1: Write the failing behavioral tests**

  Extend the ignored dual-process fixture before production code:

  1. Have the fake TUI dispatcher write its complete argv plus an allowlisted map of only the six Freshell environment fields. Keep the fake app-server's existing capture and make it record the same allowlist. Use synthetic values; never print them in assertion messages.
  2. Add `freshell_mcp_pairs(argv)` which extracts complete `-c` pairs beginning `mcp_servers.freshell.`. Add `assert_spawned_pair_parity(tui, sidecar, expected_terminal_id)` that asserts: exact static `env_vars` pair; command/args semantic recipe equality on the current target; equal six-key parent environment maps; expected terminal id; config pairs appear before sidecar `app-server`; and neither argv contains a synthetic token value.
  3. Run that assertion for a fresh WS create and a resume/no-survivor or retry-spawn leg. Include `tabId` and `paneId` on the fresh leg, and assert the intentional absence behavior on auto-resume.
  4. Add a REST/MCP terminal-tabs test using the same fake command/capture seam. It must verify this door supplies the context to a newly spawned sidecar rather than merely compiling after the type change.
  5. Rename/adapt the survivor reattach test so it asserts the same verified PID is retained and no replacement child starts, but explicitly does **not** compare a newly minted setup to the survivor or call the outcome parity coverage.
  6. Add a focused prepared-restore/adoption-failure test proving the reserved terminal id is reused exactly once and the prepared launch is discarded after a post-PTY adoption error.

- [ ] **Step 2: Run the focused tests and verify the intended failure**

  Run:

  ```bash
  cargo test -p freshell-ws --test codex_managed_launch_e2e -- --ignored --test-threads=1
  cargo test -p freshell-ws prepared_codex_launch_reuses_reserved_setup_and_discards_after_adopt_failure
  cargo test -p freshell-freshagent managed_codex_terminal_tab_supplies_sidecar_context -- --nocapture
  ```

  Expected: the ignored integration test fails because the sidecar has neither Freshell MCP config nor terminal context; the preparation test fails because no setup/id travels with the prepared launch; the REST path has the same missing sidecar context.

- [ ] **Step 3: Add the minimal production implementation**

  1. In each terminal-pane layer, add one setup-construction helper. It resolves `mcp_cwd` with `resolve_mcp_cwd`, derives the actual TUI `ProviderTarget`, calls `build_managed_codex_mcp_renderings` once, builds `terminal_env` once, and constructs `sidecar_context` from the **sidecar** rendering followed by `terminal_env` so the canonical terminal values win on an overlapping key. Its `runtime_cwd` is the resolved host-native MCP cwd. Its TUI injection is the **TUI** rendering.
  2. In WS interactive create, mint the normal terminal id before managed planning, construct this setup after all existing validation/duplicate gates, pass its `runtime_cwd` and `sidecar_context` to `plan_codex_managed_launch`, then use its TUI injection/environment when spawning the PTY.
  3. In WS restore preplanning, after resume validation but before `plan_codex_managed_launch`, reserve one UUID only for a managed Codex resume that will plan. Build the setup from that id and store both setup and launch in a structured `PreparedCodexLaunch`. Change `take()` to return both; `Drop` continues to discard an unconsumed launch. In `handle_create`, reuse the stored id/setup rather than minting or rendering a second time. Non-Codex and managed-disabled preplanning remain unchanged.
  4. In auto-resume/recovery, build the setup from the replacement terminal id and its intentionally absent tab/pane values before planning a new sidecar. Reuse its TUI rendering/environment for the replacement PTY.
  5. Apply the same construction/order in `freshell-freshagent/src/terminal_tabs.rs`: it already has terminal, tab, and pane ids before the managed plan; create the setup before planning and use it for both sidecar plan and CLI PTY. Do not default its sidecar context empty.
  6. When runtime selection returns a verified survivor, retain the current reattach behavior. The plan's context is consumed only by a spawned runtime; do not add a survivor kill path, durable context snapshot, or a log that says the survivor was reconfigured.
  7. Keep the explicit `FRESHELL_CODEX_MANAGED_LAUNCH=0` test leg unchanged: it must not receive a remote proxy or managed-sidecar-only config.

- [ ] **Step 4: Run the focused tests**

  Run:

  ```bash
  cargo test -p freshell-ws --test codex_managed_launch_e2e -- --ignored --test-threads=1
  cargo test -p freshell-ws prepared_codex_launch_reuses_reserved_setup_and_discards_after_adopt_failure
  cargo test -p freshell-freshagent managed_codex_terminal_tab_supplies_sidecar_context -- --nocapture
  cargo test -p freshell-ws --test codex_sidecar_reattach_e2e -- --ignored --test-threads=1
  ```

  Expected: PASS. Each newly spawned WS/REST/retry pair has semantic MCP/context parity; the proxy still relays initialize; a retained survivor is explicitly preserved without a false parity assertion; failed adoption does not leave the prepared sidecar active.

- [ ] **Step 5: Refactor while green**

  Collapse duplicated WS construction into one helper and keep REST's equivalent helper limited to its existing layer. Do not make a global environment mutation, store setup in durable sidecar state, or force a survivor replacement. Ensure `PreparedCodexLaunch` has one clear owner for its launch and no terminal resource is created solely by UUID reservation.

- [ ] **Step 6: Run impacted-test verification**

  Run:

  ```bash
  cargo test -p freshell-ws
  cargo test -p freshell-freshagent
  cargo test -p freshell-codex
  cargo test -p freshell-ws --test codex_managed_launch_e2e -- --ignored --test-threads=1
  cargo test -p freshell-ws --test codex_sidecar_reattach_e2e -- --ignored --test-threads=1
  cargo check --workspace --all-targets
  cargo fmt --all -- --check
  ```

  Expected: PASS. The integration tests run alone because they mutate process-global launch seams and use the singleton manager.

- [ ] **Step 7: Commit the task**

  ```bash
  git add -- crates/freshell-ws/src/terminal.rs crates/freshell-freshagent/src/terminal_tabs.rs crates/freshell-ws/tests/codex_managed_launch_e2e.rs crates/freshell-ws/tests/codex_sidecar_reattach_e2e.rs
  git commit -m "fix: configure spawned managed Codex pairs consistently"
  ```

## Final Verification

After task reviews pass, run the full branch verification through the repository coordinator and record the exact receipt in the external run state:

```bash
FRESHELL_TEST_SUMMARY='the-usual: managed Codex MCP parity' npm test
```

Expected: PASS through the coordinator from this branch worktree. Do not restart, deploy, or replace the live Rust server as part of verification.

The final handoff must distinguish these facts accurately:

1. Newly spawned and retry-spawned managed Codex pairs have automated semantic configuration/context parity and working MCP transport coverage.
2. A sidecar already retained before a replacement TUI is deliberately reattached unchanged; it cannot receive the new context and may retain pre-fix behavior until a fresh managed launch. Active work is not forcibly interrupted.
3. The literal `Booting MCP server: node_repl` claim is supported only by a bounded, isolated real-provider A/B acceptance run: the same Codex version/topology/node_repl configuration and scratch `CODEX_HOME`, with only app-server MCP parity varied. It must prove the corrected spawned pair clears the display within its declared timeout and a harmless MCP tool is discoverable/callable. If that lane is unavailable or its negative control does not reproduce, say that configuration transport and tool access were verified but do not claim causal proof of the exact TUI display.
