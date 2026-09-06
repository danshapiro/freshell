# Coding Agent Resource Containment Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Add optional, user-configurable cgroup-v2 resource containment to every future long-lived coding-agent session or service launched by the Rust production server, while leaving Freshell, ordinary shells, existing sessions, and short-lived discovery probes unchanged.

**Architecture:** The Rust server owns one boot-scoped aggregate systemd slice and one logical leaf slice per coding-agent session, plus one shared OpenCode leaf. Aggregate, ordinary-child, and shared-OpenCode limits are explicit persisted settings. The Rust server creates and verifies slices through systemd, wraps each long-lived child with `systemd-run --user --scope --slice=<leaf> --property=OOMPolicy=kill`, monitors cgroup-v2 counters, and freezes selected logical leaves under sustained memory pressure. One Rust `ResourceController`, named from the fresh `boot_id`, is cloned into every Rust launch state. The retained React/TypeScript client displays settings and server-authoritative runtime prompts only when `/api/platform` advertises the Rust capability; a backend that omits it is unsupported.

**Tech Stack:** Rust 1.96, Tokio, serde, axum, portable-pty, systemd 255+ where required, cgroup v2, React/Redux/TypeScript/Zod, Rust unit/integration/live tests, client Vitest, and explicitly registered Playwright `rust-chromium` tests.

---

## Authoritative Backend Scope

- The production feature target is `crates/freshell-server`; the frozen legacy backend under `server/` receives no containment code, settings behavior, launch interception, persistence change, or runtime test.
- Shared TypeScript files may change only to describe client-visible settings, platform capability, and additive Rust server messages.
- The sanctioned Claude JavaScript sidecar remains in scope because `FreshClaudeState` in Rust owns its process spawn.
- Containment covers every **long-lived** process tree launched by the Rust server:
  - every PTY whose mode resolves from the registered `CliCommandSpec` list, including Claude, Codex, OpenCode, Amplifier, Gemini, Kimi, and future registered coding-agent extensions;
  - registered-agent PTYs launched through WebSocket create, Rust REST tab/pane create, and Rust auto-respawn;
  - Fresh Claude and Fresh Codex managed roots;
  - terminal-mode managed Codex app-server roots;
  - the one shared Fresh OpenCode service, including active/candidate/retiring overlap.
- Containment explicitly excludes Freshell itself, ordinary `mode="shell"` terminals, existing sessions, extension `which`/`where.exe` discovery, model/catalog/metadata probes, Docker/BuildKit-daemon work, Windows interoperability processes, remote workers/services, external process managers, and disk-I/O control.
- Frozen legacy `codingcli.*`/AUTO-12 behavior is neither implemented nor retired here. If a future Rust API launches a long-lived registered coding agent, that future implementation must call the same explicit containment launch seam.

## Related landed work

- [`docs/plans/2026-08-26-freshell-runtime-host-proposal.md`](../../plans/2026-08-26-freshell-runtime-host-proposal.md) was merged in PR #696. It proposes separating agent workloads from the network/control-plane host, including separate cgroups. This plan is independent: it owns agent-side cgroup enforcement—aggregate and leaf limits, freeze/pause, and user-configurable limits—inside the normal Rust server.
- [`docs/plans/2026-08-25-host-pressure-pane.md`](../../plans/2026-08-25-host-pressure-pane.md) shipped in PR #700. Its PSI and cgroup **readers** may be reused where they fit, but containment pressure **decisions** remain the `memory.events.local` watchers specified here; this plan does not adopt PSI.
- If the runtime-host proposal is later implemented, its membranes and launch boundaries must not double-wrap or conflict with this plan's systemd scopes. Whichever implementation lands later must explicitly reconcile cgroup ownership and launch wrapping with the one already present.

## Canonical Settings Contract

```ts
export type ResourceLimitSet = Readonly<{
  cpuQuotaMillis: number
  memoryHighBytes: number
  memoryMaxBytes: number
  swapMaxBytes: number
  tasksMax: number
}>

export type CodingAgentResourceLimits = Readonly<{
  enabled: boolean
  allAgents: ResourceLimitSet
  eachAgent: ResourceLimitSet
  sharedOpenCode: ResourceLimitSet
}>
```

`ServerSettings.safety.codingAgentResourceLimits?: CodingAgentResourceLimits` is absent until first enablement. Absence means disabled and never calculated. On the first Rust `PATCH /api/settings` carrying `{safety:{codingAgentResourceLimits:{enabled:true}}}`, the Rust handler calculates and persists all 15 numeric fields. Once present:

- disable retains all values;
- re-enable reuses them without calculation;
- users may edit every All agents, Each agent, and Shared OpenCode value only while the Rust controller reports zero contained logical groups;
- a numeric save racing the first launch is accepted: each launch captures one complete immutable old-or-new value set, never a mixed set.

The first-enable calculation uses effective static boundaries only. For a dimension that cannot be read, substitute the conservative capacity CPU `2000m`, memory `4 GiB`, swap `512 MiB`, or tasks `512`, then derive:

- aggregate CPU: `floor(C / 2)` to `100m`;
- aggregate `MemoryMax`: `floor(2M / 3)` to MiB;
- aggregate `MemoryHigh`: `floor(4 * MemoryMax / 5)` to MiB;
- aggregate `SwapMax`: `floor(min(S / 4, MemoryMax / 4))` to MiB;
- aggregate `TasksMax`: `floor(3P / 4)`;
- Each agent CPU/MemoryMax/SwapMax/TasksMax: 50% of aggregate, rounded down; its `MemoryHigh` starts at 80% of its own `MemoryMax`;
- Shared OpenCode CPU/MemoryMax/SwapMax/TasksMax: 90% of aggregate, rounded down; its `MemoryHigh` starts at 80% of its own `MemoryMax`.

Validation is identical in TypeScript and Rust: CPU, MemoryHigh, MemoryMax, and TasksMax are positive; SwapMax is nonnegative; every `MemoryHigh < MemoryMax`; and every Each agent/Shared OpenCode field is `<=` its All agents counterpart.

## Global Constraints — Do Not Add

These are product requirements, not suggestions:

- no recalculation button, startup recalculation, provenance, or stale-policy handling;
- no pending-drain workflow, policy generation, admission lock, or policy-swap lock;
- no PSI/`memory.pressure`, trend prediction, current-load sampling, or predictive pressure model;
- no multi-server coordination, cross-server lock, leader election, or shared global pool;
- no `.wslconfig` editing/guidance, alternate containment, disk-I/O controller, or external PTY custody;
- no Escape, Ctrl-C, provider interrupt API, or other turn interruption;
- no startup adoption added by containment, transport adoption, durable launch replay/result store, or responder reconstruction;
- no journal/signature/exit-code OOM inference, retry-event correlation, or exact-SIGKILL attribution;
- no direct systemd D-Bus acknowledgement redesign, helper/FIFO/suspended-child launch handshake, raw writes to systemd-owned cgroup files, or global spawn interceptor;
- no universal/global action queue; the only action serialization is one in-memory mutex stored on each logical-group record;
- no automatic **pressure-policy** termination of a healthy paused agent;
- no containment lifecycle management for short-lived extension, metadata, model, or catalog probes.

“Paused agents are never automatically killed” applies to containment/pressure policy while the Rust server runs. Existing whole-server graceful/fatal cleanup remains authoritative and may terminate contained or paused processes. A child OOM cleanup may stop known sibling scopes after the kernel has already destroyed one child; that is best-effort OOM cleanup, not pressure-policy killing of a healthy paused group.

## Capability Support Floor

Capability detection is static and performs no transient-unit launch:

1. Require Linux, a unified cgroup-v2 mount, a reachable user manager, delegated `cpu memory pids`, and freezer support.
2. Read the current process cgroup and the user manager’s delegated `ControlGroup`.
3. Supported placement is either:
   - Freshell already lies beneath that delegated `ControlGroup`; or
   - Freshell lies outside it **and** systemd is version 255+, the system bus is reachable, and the same-UID `user@UID.service` is active with `Delegate=yes` and delegated `cpu memory pids`.
4. An unknown or older outside-subtree arrangement is unavailable.

Do not require Freshell to run as a user service. Do not require transient services during capability detection. Actual slice/scope creation remains fail-closed at launch even after the static support check passes.

The Rust `/api/platform` payload adds:

```ts
resourceContainment?: {
  available: boolean
  unavailableReason?: string
}
```

The client treats a missing field exactly like `{available:false}`. Therefore a backend that does not advertise the Rust capability gets an honest unavailable UI and no fallback implementation.

## Lifecycle and Safety Invariants

1. Construct exactly one Rust `ResourceController` from `main.rs`’s fresh `boot_id` (`crates/freshell-server/src/main.rs:241-246`), never from persistent `server_instance_id` (`main.rs:208-240`). Clone that same handle into `WsState`, `FreshAgentState`, `FreshClaudeState`, `FreshCodexState`, `FreshOpencodeState`, the terminal-mode Codex launch manager, and Rust REST/runtime route state.
2. Use `systemctl --user set-property --runtime` to configure and read back aggregate and logical-leaf CPU, MemoryHigh, MemoryMax, MemorySwapMax, and TasksMax before spawning. Never write or require `memory.oom.group` on a systemd-owned slice.
3. Every owned long-lived child scope/service receives supported `OOMPolicy=kill`. `systemd-run` successful scope creation and placement-before-agent-exec is the authoritative containment barrier. The manager may either accept the child scope with that property or fail before the agent command executes.
4. Read the child unit’s `ControlGroup`, then its actual `memory.oom.group`; `1` confirms `OOMPolicy=kill`. For managed roots whose existing health/created handshake occurs before publication, require this confirmation before publishing readiness. For a generic PTY, wrapper launch may fail after `terminal.created`; subsequent membership/OOM readback is diagnostic only and never claims no useful code ran. A late wrapper failure appears as a terminal that immediately exits and does not reopen the launch-choice prompt.
5. Unit names use normalized boot/group UUIDs and are never reused within a boot. Explicit Restart consumes the old logical-group ID, allocates a new ID, and makes actions against the old ID return 404.
6. Each launch reads settings once and owns one immutable `Arc<CodingAgentResourceLimits>` for all slice and child properties. A settings save race yields all-old or all-new values.
7. The authoritative root for current agent modes is the PTY or managed sidecar root tracked by its existing owner. Active/candidate/retiring child scopes may overlap under one logical leaf. No second per-scope lifecycle registry is added.
8. Final root exit under the per-group mutex:
   - may stop/release an exact **unpaused** leaf and its known residual descendants;
   - must retain a **paused** leaf while `cgroup.events populated=1` until Resume, Stop agent, or kernel termination;
   - may finalize a paused leaf after `populated=0`;
   - Resume after its root already exited thaws first, then performs normal exact-leaf cleanup.
9. Monitor aggregate/leaf `memory.events.local` for `high` and `max`. Baseline every counter at attachment. Do not use PSI.
10. Monitor every known child scope’s own `memory.events.local` `oom_group_kill`. A rising child counter marks the logical group kernel-stopped, suppresses retry/respawn, and under the existing group mutex invokes the existing Stop path for known sibling scopes. This is best-effort rather than kernel-atomic whole-leaf OOM. The leaf’s hierarchical `memory.events` may wake a rescan but is not exact attribution. A very fast release race may remain inconclusive; add no journal or correlation mechanism.
11. One EOF thaw guard exists per Rust server boot outside the aggregate. It shares the exact boot UUID with the aggregate. Before and after every freeze, require the guard service active; otherwise do not freeze and leave hard limits active. This is a best-effort fail-safe, not a guarantee.
12. On server loss, surviving processes are best-effort recursively thawed and remain under existing hard limits. PTY/pipe-backed processes may exit or become unusable. There is no adoption or useful-survival promise.
13. Preserve the existing Rust shutdown-owner order. Immediately after `shutdown_signal(...).await`, call the resource controller/guard `dispose()` so closing its pipe attempts thaw before the existing `rebind.shutdown_all().await`; do not move any existing owner. The sequence then remains: conditionally call `begin_shutdown_retention()` (`crates/freshell-server/src/main.rs:1941-1942`), `registry.kill_all()` (`:1943`), wait 300 ms and re-sweep (`:1952-1953`), then `fresh_agent_state.shutdown()` (`:1954`), `fresh_codex_state.shutdown()` (`:1957`), `fresh_claude_state.shutdown()` (`:1961`), and `CodexTerminalLaunchManager::global().shutdown()` (`:1972-1975`). The existing `SHUTDOWN_HARD_TIMEOUT` remains 5 seconds (`:1990`). Shutdown may terminate contained or paused agents.
14. The containment conditioning point is only the existing `begin_shutdown_retention()` call at `main.rs:1941-1942`: call it when containment is disabled and skip it when containment is enabled. `settings` is already in scope because settings load completes at `main.rs:276-277`, before boot reconciliation at `main.rs:1133-1178`. When retention is skipped, the unchanged manager shutdown at `main.rs:1972-1975` takes its existing non-retain branch and reaps (`crates/freshell-codex/src/launch_lifecycle.rs:963-970`). Do not reorder the shutdown sequence. For previous-generation survivors, reuse `SidecarReconciler::boot_reconcile` (`sidecar_reconcile.rs`; sole production caller `main.rs:1152`), its TOCTOU-safe `SidecarReconciler::sweep_unclaimed` (`sidecar_sweep.rs:131-163`), and public `kill_verified_sidecar_tree(record) -> KillTreeOutcome` (`sidecar_sweep.rs:494`), which re-verifies each PID and performs SIGTERM → a 5-second poll-gone call at `sidecar_sweep.rs:591` → SIGKILL. Containment's pre-spawn reap must use that awaited helper, never the best-effort, no-wait `reap_owned_codex_sidecars` in `crates/freshell-codex/src/transport.rs:91`. Mismatched/unverifiable identities are never signalled; an unverifiable candidate makes contained resume fail. With containment disabled, existing retention/reattachment behavior is unchanged. Contained Codex deliberately loses cross-server continuity.

## Pressure Actions and Final Copy

- **Leaf warning:** local `high` increases → server-owned 60-second countdown for that leaf; clear/rearm after 10 seconds with no new local high event.
- **Aggregate warning:** aggregate local `high` increases → snapshot each leaf as `memory.current + memory.swap.current`; countdown targets the largest running leaf.
- **Critical:** leaf/aggregate `memory.current >= 95% MemoryMax` or local `max` increases → pause immediately. Aggregate critical pauses at most two largest leaves in one episode. If aggregate warning already paused one, critical may pause one more. Rearm only after aggregate usage drops below aggregate MemoryHigh and aggregate events stay quiet 10 seconds.
- **Freeze:** verify guard active, `systemctl --user freeze <exact-leaf>`, verify guard still active, then verify `cgroup.events frozen=1`. No interruption key/API is sent.
- **Paused:** retains memory and is never pressure-policy terminated. Resume thaws; Stop agent explicitly frees resources.

Final client copy/actions:

- **Known-before-publication launch failure, one pane** — title `Freshell couldn't limit this agent`; body `Freshell limits coding agents so they can't overwhelm this machine. Those limits could not be applied, so the agent has not started. Launch it without limits, turn containment off, or close the pane.`; actions `Launch uncontained`, `Disable containment`, `Close pane`.
- **Known-before-publication shared/multi-pane failure** — same plain body, list all affected panes, use `Cancel launches` rather than `Close pane`.
- **Headless zero-pane failure** — typed error with `affectedPaneIds: []`; no invented pane and no popup.
- **Warning** — title `` `${label} will pause in 00:60` ``; body `This agent is using too much memory. Freshell limits coding agents so they can't overwhelm this machine. It will pause if memory stays high. Linux may stop it first if memory rises too far.`; actions `Pause now`, `Cancel countdown`.
- **Paused** — title `` `${label} is paused because it's using too much memory` ``; body `This agent is not doing any work, but it still holds its memory.`; exactly `Resume` and `Stop agent`; no dismiss, close, Escape, or backdrop action. Ignoring it leaves the agent paused.
- **Kernel stopped** — title `` `Linux stopped ${label}` ``; body `This agent reached its emergency memory limit before Freshell could pause it. Linux stopped it to protect the rest of the machine. Restart it when you're ready, or close the pane.`; actions `Restart agent`, `Close pane`.

Browser reconnect to the same live Rust server restores warning/paused runtime state. Launch-choice gates are one-shot and are never replayed on reconnect. Server loss triggers the thaw guard; no old popup or adoption UI appears on a new server.

## Approved Topology

```text
freshellthawguard<bootuuid>.service             # outside aggregate; sole pipe writer is Freshell

freshellagents<bootuuid>.slice                  # aggregate limits; no oom.group override
  ├─ freshellagents<bootuuid>-agent<groupuuid>.slice
  │    ├─ freshellagentproc<scopeuuid>.scope    # PTY or managed root; OOMPolicy=kill
  │    └─ freshellagentproc<scopeuuid>.scope    # sidecar/candidate overlap; OOMPolicy=kill
  └─ freshellagents<bootuuid>-opencode<groupuuid>.slice
       ├─ freshellagentproc<scopeuuid>.scope    # active serve; OOMPolicy=kill
       └─ freshellagentproc<scopeuuid>.scope    # candidate/retiring overlap; OOMPolicy=kill
```

## File-Decomposition Inventory

### Shared client contracts

- create `shared/resource-limits.ts`;
- modify `shared/settings.ts:149-193,744-884,1038-1309,1408-1445`;
- modify `shared/read-models.ts:17-24` and `src/App.tsx:131-158,537-646` for optional capability parsing;
- modify `shared/ws-protocol.ts:887-938,1101-1214` only for additive server→client runtime messages;
- protocol changes remain additive at the current version (8); keep `shared/ws-version.ts` unchanged at 8, regenerate `port/contract/*.json`, and update Rust server-message mirrors.

### Rust settings and controller

- create `crates/freshell-protocol/src/resource_limits.rs`;
- modify `crates/freshell-protocol/src/{lib,settings,server_messages}.rs` and tests;
- modify `crates/freshell-server/src/{settings,settings_store,boot,main}.rs`;
- create `crates/freshell-server/src/resource_containment.rs`;
- create crate `crates/freshell-resource-control/` with `Cargo.toml` and `src/{lib,capability,capacity,systemd,guard,controller,pressure}.rs`;
- modify workspace `Cargo.toml` and `Cargo.lock`.

### Rust launch owners

- modify `crates/freshell-ws/src/{lib,terminal,auto_resume}.rs` and `crates/freshell-ws/tests/auto_resume_respawn.rs`;
- modify `crates/freshell-freshagent/src/{lib,terminal_tabs,claude,codex,opencode_ws}.rs`;
- modify `crates/freshell-codex/src/{launch_lifecycle,sidecar_store,sidecar_reconcile,sidecar_sweep,runtime_select}.rs` and existing tests;
- modify `crates/freshell-opencode/src/{serve,transport}.rs` and existing tests;
- do not modify `crates/freshell-freshagent/src/model_capabilities.rs` beyond a negative test proving its short-lived probe does not enter containment.

### Client UI and Rust-only verification

- modify `src/components/settings/{RuntimeSettings,settings-controls}.tsx`, `src/components/SettingsView.tsx`, and focused client tests;
- create `src/store/resourceContainmentSlice.ts`, `src/components/ResourceContainmentModal.tsx`, and focused client tests;
- create `crates/freshell-resource-control/tests/live_systemd.rs`, `crates/freshell-server/tests/resource_control_wiring.rs`, and Rust integration coverage;
- create `test/e2e-browser/specs/resource-containment-rust.spec.ts`, register it in `test/e2e-browser/playwright.config.ts` under `RUST_ONLY_SPECS` and `rust-chromium.testMatch`;
- modify `docs/index.html` and `AGENTS.md` when the feature ships.

# Phase 1 — shared contract, pure calculation, Rust persistence

## Task 1: Define the Shared and Rust Settings Contract

**Files:** create `shared/resource-limits.ts`, `test/unit/shared/resource-limits.test.ts`, `crates/freshell-protocol/src/resource_limits.rs`; modify `shared/settings.ts:149-193,744-884,1038-1309,1408-1445`, `test/unit/shared/settings.test.ts`, `crates/freshell-protocol/src/{lib,settings}.rs`, `crates/freshell-protocol/tests/roundtrip.rs`.

**Interfaces consumed:** strict `ServerSettingsSchema`/patch schema in `shared/settings.ts`; closed Rust `SettingsSafety`/`ServerSettings` in `crates/freshell-protocol/src/settings.rs:42-46,117-136`.

**Interfaces produced:** `ResourceLimitSet`, `CodingAgentResourceLimits`, strict TypeScript schemas, Rust serde mirrors, `validate_resource_limits`, `calculate_initial_resource_limits(EffectiveResourceCapacity)`, and `capture_resource_policy(&ServerSettings) -> Option<Arc<CodingAgentResourceLimits>>`.

- [ ] **RED tests:**
  ```ts
  it('rejects child limits above aggregate and high at max', () => {
    expect(ResourceLimitsSchema.safeParse({...VALID, eachAgent:{...VALID.eachAgent,tasksMax:VALID.allAgents.tasksMax+1}}).success).toBe(false)
    expect(ResourceLimitsSchema.safeParse({...VALID, sharedOpenCode:{...VALID.sharedOpenCode,memoryHighBytes:VALID.sharedOpenCode.memoryMaxBytes}}).success).toBe(false)
  })
  ```
  ```rust
  #[test]
  fn derives_all_three_groups_with_required_rounding() {
      let got = calculate_initial_resource_limits(EffectiveResourceCapacity {
          cpu_quota_millis: Some(16_000), memory_bytes: Some(48 * GIB),
          swap_bytes: Some(16 * GIB), tasks_max: Some(8_192),
      });
      assert_eq!(got.all_agents.cpu_quota_millis, 8_000);
      assert_eq!(got.each_agent.cpu_quota_millis, 4_000);
      assert_eq!(got.shared_open_code.cpu_quota_millis, 7_200);
      assert!(validate_resource_limits(&got).is_ok());
  }
  ```
- [ ] **RED command / expected failure:**
  ```bash
  npm run test:vitest -- test/unit/shared/resource-limits.test.ts test/unit/shared/settings.test.ts --config config/vitest/vitest.config.ts --run
  cargo test -p freshell-protocol resource_limits
  ```
  Both fail because the optional settings field, schemas, Rust models, formulas, and validator do not exist.
- [ ] **Minimal implementation:** implement integer-only ratios and required floors; use fallback capacities only for missing dimensions; make the full field optional, never synthesize it in defaults/deserialization; share one TypeScript `superRefine` and one Rust validator; deep-clone into a new `Arc` for every capture.
- [ ] **GREEN command / expected result:** rerun both RED commands; all selected tests pass, including JSON camelCase roundtrip.
- [ ] **Broader verification:** `npm run typecheck:client && cargo test -p freshell-protocol --test roundtrip`.
- [ ] **Commit:**
  ```bash
  git add shared/resource-limits.ts shared/settings.ts test/unit/shared/resource-limits.test.ts test/unit/shared/settings.test.ts crates/freshell-protocol
  git commit -m "feat(settings): define coding-agent resource limits" \
    -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
    -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
  ```

## Task 2: Implement First-Enable Persistence and Complete-Snapshot Saves in Rust

**Files:** modify `crates/freshell-server/src/settings.rs:32-84`, `crates/freshell-server/src/settings_store.rs:367-651,2089-2165,2187-5516`; create focused tests in the existing `settings_store.rs` test module.

**Interfaces consumed:** Task 1 models/calculator/validator; `SettingsStore::patch` persistence-before-live-update order at `settings_store.rs:408-448`; `SettingsRouterState`/`patch_settings` at `settings_store.rs:2089-2165`.

**Interfaces produced:** `ResourceSettingsHooks { effective_capacity, active_group_count }`; first-enable patch expansion; numeric-edit 409 while groups exist; disabled-value retention; `SettingsStore::capture_resource_policy()` returning one immutable complete `Arc`.

- [ ] **RED tests:**
  ```rust
  #[tokio::test]
  async fn enable_calculates_once_disable_retains_and_reenable_reuses() {
      let h = settings_harness_with_capacity(capacity(8_000, 24 * GIB, 8 * GIB, 4_096));
      let first = h.patch(json!({"safety":{"codingAgentResourceLimits":{"enabled":true}}})).await.unwrap();
      h.replace_capacity(capacity(2_000, 4 * GIB, MIB * 512, 512));
      let off = h.patch(json!({"safety":{"codingAgentResourceLimits":{"enabled":false}}})).await.unwrap();
      let again = h.patch(json!({"safety":{"codingAgentResourceLimits":{"enabled":true}}})).await.unwrap();
      assert_eq!(first.safety.coding_agent_resource_limits.unwrap().all_agents,
                 again.safety.coding_agent_resource_limits.unwrap().all_agents);
      assert!(!off.safety.coding_agent_resource_limits.unwrap().enabled);
  }

  #[tokio::test]
  async fn launch_snapshot_is_complete_old_or_complete_new() {
      let h = settings_harness_with_limits(policy("old"));
      let old = h.store.capture_resource_policy().unwrap();
      h.replace_limits(policy("new")).await;
      assert_eq!(old.as_ref(), &policy("old"));
      assert_eq!(h.store.capture_resource_policy().unwrap().as_ref(), &policy("new"));
  }
  ```
  Add a 409 assertion for numeric edits with one active group while an `enabled:false` patch remains allowed.
- [ ] **RED command / expected failure:** `cargo test -p freshell-server settings_store::tests::resource_limits` fails because the hooks, expansion, active-group guard, and capture API are absent.
- [ ] **Minimal implementation:** normalize only the exact first-enable shape before strict merge; persist before replacing the shared settings lock; never calculate on load/boot/re-enable; active count is a lock-free observation, not an admission lock, so the save/launch race remains intentionally possible.
- [ ] **GREEN command / expected result:** rerun the RED command; all resource-limit persistence tests pass and prior config-copy-forward tests remain green.
- [ ] **Broader verification:** `cargo test -p freshell-server settings_store && cargo clippy -p freshell-server -- -D warnings`.
- [ ] **Commit:**
  ```bash
  git add crates/freshell-server/src/settings.rs crates/freshell-server/src/settings_store.rs
  git commit -m "feat(rust-settings): persist first-enable resource limits" \
    -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
    -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
  ```

# Phase 2 — static capability and minimal Runtime UI

## Task 3: Detect the Supported Rust/Systemd Environment and Advertise It

**Files:** create `crates/freshell-resource-control/Cargo.toml`, `crates/freshell-resource-control/src/{lib,capability,capacity}.rs`; modify root `Cargo.toml`, `Cargo.lock`, `crates/freshell-server/src/main.rs:1190-1204,2390-2416`, `crates/freshell-server/src/boot.rs:47-60,99-163,205-210`, `shared/read-models.ts:17-24`, `src/App.tsx:131-158,537-646`; add crate tests and focused client bootstrap tests.

**Interfaces consumed:** `/proc/self/cgroup`; cgroup-v2 mount/controller/static boundary files; `systemctl --user show`; system-bus `systemctl show user@UID.service`; `systemd --version`; existing `build_platform_payload` and bootstrap platform payload.

**Interfaces produced:**
```rust
pub struct ResourceControlCapability {
    pub available: bool,
    pub unavailable_reason: Option<String>,
    pub effective: EffectiveResourceCapacity,
    pub user_manager_control_group: Option<PathBuf>,
}
pub fn detect_capability(io: &dyn CapabilityIo) -> ResourceControlCapability;
```
The platform payload carries optional `resourceContainment`; the client treats absence as unavailable.

- [ ] **RED test:**
  ```rust
  #[test]
  fn outside_user_subtree_requires_255_active_same_uid_delegation_and_system_bus() {
      assert!(detect(fixture().self_cgroup("/init.scope").systemd(255)
          .system_bus(true).user_unit(1000, "active", true, "cpu memory pids")).available);
      assert!(!detect(fixture().self_cgroup("/init.scope").systemd(254)
          .system_bus(true).user_unit(1000, "active", true, "cpu memory pids")).available);
      assert!(detect(fixture().self_cgroup("/user.slice/user-1000.slice/user@1000.service/app.slice/x.scope")
          .systemd(252).delegated_user_manager()).available);
  }
  ```
  Add cases for wrong UID, inactive unit, unreachable user/system bus, missing freezer, and a missing capacity dimension falling back only during Task 1 calculation.
- [ ] **RED command / expected failure:** `cargo test -p freshell-resource-control capability capacity && cargo test -p freshell-server platform_payload_resource_containment` fails because the crate and payload field do not exist.
- [ ] **Minimal implementation:** pure parsing plus thin live readers; no transient unit, no user-service requirement, no mutation; compute tightest static affinity/cpuset/ancestor quotas; advertise unavailable rather than guessing in an older/unknown outside-subtree environment.
- [ ] **GREEN command / expected result:** rerun RED command; support-floor matrix and platform serialization pass.
- [ ] **Broader verification:** `cargo fmt --check && cargo clippy -p freshell-resource-control -p freshell-server -- -D warnings && npm run typecheck:client`.
- [ ] **Commit:**
  ```bash
  git add Cargo.toml Cargo.lock crates/freshell-resource-control crates/freshell-server/src/main.rs crates/freshell-server/src/boot.rs shared/read-models.ts src/App.tsx
  git commit -m "feat(rust-platform): advertise cgroup containment support" \
    -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
    -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
  ```

## Task 4: Add the Three-Group Advanced → Runtime Settings UI

**Files:** modify `src/components/settings/RuntimeSettings.tsx:72-111`, `src/components/settings/settings-controls.tsx:6-53,93-125,230-337`, `src/components/SettingsView.tsx:100-154`; create `test/unit/client/components/settings/RuntimeSettings.test.tsx` from scratch (the removed file must not be treated as an extension target).

**Interfaces consumed:** optional capability from Task 3; optional persisted settings from Tasks 1-2; existing `SettingsSection`, `SettingsRow`, switch, numeric input/slider, and disclosure controls.

**Interfaces produced:** optional **Coding agent resource limits** section with editable groups All agents, Each agent, Shared OpenCode; fields CPU, Memory throttle, Memory maximum, Swap maximum, Processes and threads; first-enable switch; unavailable and active-group locked states.

- [ ] **RED client test:**
  ```tsx
  it('treats missing capability as unavailable and exposes all fields when available', async () => {
    const {rerender}=renderRuntime({platform:{},settings:{safety:{}}})
    expect(screen.getByText(/resource limits are unavailable/i)).toBeVisible()
    expect(screen.getByRole('switch',{name:/coding agent resource limits/i})).toBeDisabled()
    rerender(runtime({platform:{resourceContainment:{available:true}},settings:WITH_LIMITS}))
    for (const group of ['All agents','Each agent','Shared OpenCode']) expect(screen.getByText(group)).toBeVisible()
    expect(screen.getAllByLabelText(/memory maximum/i)).toHaveLength(3)
  })
  ```
  Add validation-message tests and a test that numeric fields lock while `activeGroupCount>0` but the enable switch remains usable.
- [ ] **RED command / expected failure:** first create `test/unit/client/components/settings/RuntimeSettings.test.tsx` from scratch with the RED client test above, then run `npm run test:vitest -- test/unit/client/components/settings/RuntimeSettings.test.tsx --config config/vitest/vitest.config.ts --run`; it fails because the section and capability gate are absent.
- [ ] **Minimal implementation:** reuse existing controls; do not add top-level settings navigation; show a concise unsupported reason; save explicit values through existing settings PATCH; add no calculate/recalculate control or calculation notification.
- [ ] **GREEN command / expected result:** rerun RED command; accessibility queries and all three groups pass.
- [ ] **Broader verification:** `npm run typecheck:client && npm run lint`.
- [ ] **Commit:**
  ```bash
  git add src/components/settings src/components/SettingsView.tsx test/unit/client/components/settings
  git commit -m "feat(settings-ui): configure Rust agent resource limits" \
    -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
    -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
  ```

# Phase 3 — systemd mechanics and every Rust long-lived launch path

## Task 5: Implement Slice Setup and OOMPolicy Child-Scope Launching

**Files:** create `crates/freshell-resource-control/src/{systemd,controller}.rs` and tests.

**Interfaces consumed:** Task 1 limits; Task 3 capability/user-manager path; external `systemctl --user set-property/show` and `systemd-run --user --scope` CLIs.

**Interfaces produced:**
```rust
pub enum LogicalGroupKind { Agent, SharedOpenCode }
pub struct LogicalGroupHandle { pub id: Uuid, pub leaf_unit: String }
pub struct ChildScopeHandle { pub unit: String, pub control_group: Option<PathBuf> }
impl ResourceController {
    pub async fn prepare_group(&self, kind: LogicalGroupKind, policy: Arc<CodingAgentResourceLimits>, panes: Vec<String>) -> Result<LogicalGroupHandle, ContainmentError>;
    pub fn wrap_scope(&self, group: &LogicalGroupHandle, spec: SpawnSpec) -> Result<(SpawnSpec, String), ContainmentError>;
    pub async fn attach_child_scope(&self, group_id: Uuid, unit: &str, publication: PublicationBoundary) -> Result<ChildScopeHandle, ContainmentError>;
}
```

- [ ] **RED test:**
  ```rust
  #[tokio::test]
  async fn configures_slices_without_oom_group_and_wraps_every_child_with_oom_policy() {
      let h = systemd_harness();
      let group = h.controller.prepare_group(LogicalGroupKind::Agent, policy(), vec!["p1".into()]).await.unwrap();
      let (wrapped, unit) = h.controller.wrap_scope(&group, command("agent", &["--run"])).unwrap();
      assert_eq!(h.set_property_calls()[0].properties, aggregate_properties(policy().all_agents));
      assert_eq!(h.set_property_calls()[1].properties, leaf_properties(policy().each_agent));
      assert!(h.all_commands().iter().all(|c| !c.contains("memory.oom.group")));
      assert!(wrapped.args.windows(2).any(|w| w == ["--property=OOMPolicy=kill", "--"]));
      assert_ne!(unit, h.controller.wrap_scope(&group, command("agent", &[])).unwrap().1);
  }
  ```
  Add readback mismatch tests for CPU/MemoryHigh/MemoryMax/MemorySwapMax/TasksMax; managed-boundary `memory.oom.group!=1` rejection; PTY diagnostic-only mismatch; and unit-name normalization.
- [ ] **RED command / expected failure:** `cargo test -p freshell-resource-control systemd controller` fails because systemd setup, wrappers, and child-scope semantics are absent.
- [ ] **Minimal implementation:** create slices only through `systemctl --user set-property --runtime`; read properties back before spawn; pass `--collect --unit=<unique> --slice=<leaf> --property=OOMPolicy=kill`; derive the child cgroup from systemd `ControlGroup`; read but never write child `memory.oom.group`; no D-Bus acknowledgement or universal process interceptor.
- [ ] **GREEN command / expected result:** rerun RED command; exact command/property tests pass.
- [ ] **Broader verification:** `cargo clippy -p freshell-resource-control -- -D warnings`.
- [ ] **Commit:**
  ```bash
  git add crates/freshell-resource-control/src
  git commit -m "feat(resource-control): create systemd slices and child scopes" \
    -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
    -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
  ```

## Task 6: Add the EOF Thaw Guard and Wire One Boot-ID Controller Everywhere

**Files:** create `crates/freshell-resource-control/src/guard.rs`, `crates/freshell-server/src/resource_containment.rs`, `crates/freshell-server/tests/resource_control_wiring.rs`; modify `crates/freshell-server/src/main.rs:208-280,323-374,780-1045,1880-1990`, `crates/freshell-ws/src/lib.rs:96-190`, `crates/freshell-freshagent/src/lib.rs:155-326,387-423`, and constructors in `claude.rs`, `codex.rs`, `opencode_ws.rs`.

**Interfaces consumed:** fresh `boot_id`; Task 5 controller; existing Rust state constructors and graceful shutdown ordering.

**Interfaces produced:** one `ResourceController::new(boot_id, ...)`; clone-shared state fields/builders; one `ThawGuard` whose writer is held only by Freshell; `ResourceController::dispose()` closes that writer immediately after `shutdown_signal(...).await` and before the existing `rebind.shutdown_all().await`; `freeze_allowed()` requires immediate pre/post service health.

- [ ] **RED wiring test:**
  ```rust
  #[test]
  fn controller_names_use_fresh_boot_id_and_never_persistent_instance_id() {
      let wired = wire_for_test("boot-aaaaaaaa", "srv-persistent");
      assert!(wired.all_controller_arcs_point_to_same_allocation());
      assert!(wired.aggregate_unit.contains("aaaaaaaa"));
      assert!(!wired.aggregate_unit.contains("persistent"));
      assert_eq!(wired.guard_uuid(), wired.aggregate_uuid());
  }
  ```
  Add a fake-guard test proving a failed pre-freeze or post-freeze health check suppresses `freeze` while limits stay active. Add an ordering test that inserts `resource_controller.dispose()` after `shutdown_signal` and before `rebind.shutdown_all`, while preserving the landed order `conditional begin_shutdown_retention → registry.kill_all → 300 ms settle/re-sweep → fresh_agent_state.shutdown → fresh_codex_state.shutdown → fresh_claude_state.shutdown → CodexTerminalLaunchManager::shutdown`.
- [ ] **RED command / expected failure:** `cargo test -p freshell-server --test resource_control_wiring && cargo test -p freshell-resource-control guard` fails because the guard and state wiring are absent.
- [ ] **Minimal implementation:** start exactly one transient guard service outside the aggregate with a pipe reader and exact aggregate thaw cleanup; no scan/daemon fleet/UI; thread the same concrete controller handle through each named state; initialize the terminal-mode Codex global manager explicitly from it rather than minting another controller. Nest `dispose()` inside the landed shutdown sequence at the point above; do not reorder any existing shutdown owner or alter the 5-second hard timeout.
- [ ] **GREEN command / expected result:** rerun RED command; Arc identity, ID source, guard health, and shutdown ordering pass.
- [ ] **Broader verification:** `cargo test -p freshell-ws -p freshell-freshagent --no-fail-fast && cargo clippy -p freshell-server -- -D warnings`.
- [ ] **Commit:**
  ```bash
  git add crates/freshell-resource-control/src/guard.rs crates/freshell-server crates/freshell-ws/src/lib.rs crates/freshell-freshagent/src
  git commit -m "feat(rust-server): wire one guarded resource controller" \
    -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
    -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
  ```

## Task 7: Route Every Registered-Agent PTY Door Through the Explicit Seam

**Files:** modify `crates/freshell-ws/src/terminal.rs:2431-2459,2950-3152,3558-3990`, `crates/freshell-ws/src/auto_resume.rs`, `crates/freshell-ws/tests/auto_resume_respawn.rs`, `crates/freshell-freshagent/src/terminal_tabs.rs:806-900,1780-1850`; add focused crate-local tests.

**Interfaces consumed:** registered `state.cli_commands`; Task 5 group/wrapper API; immutable policy capture; existing `build_pty_exit_hook`; existing REST spawn pipeline and `respawn_agent_terminal`.

**Interfaces produced:** explicit `prepare_registered_agent_pty(mode, pane_ids)` call at WebSocket, REST, and auto-respawn doors; ordinary shell bypass; root registration/finalization; typed prepublication failure with zero/one/many panes.

- [ ] **RED tests:**
  ```rust
  #[tokio::test]
  async fn registered_future_mode_is_contained_but_shell_is_not() {
      let h = terminal_launch_harness().with_cli("future-agent");
      h.create("future-agent", Some("pane-1")).await.unwrap();
      assert_eq!(h.prepared_modes(), ["future-agent"]);
      assert_eq!(h.spawned_program("future-agent"), "systemd-run");
      h.create("shell", Some("pane-2")).await.unwrap();
      assert_eq!(h.spawned_program("shell"), h.system_shell());
  }

  #[tokio::test]
  async fn rust_auto_respawn_rechecks_group_phase_and_uses_a_new_child_scope() {
      let h = respawn_harness();
      let first = h.spawn_and_crash().await;
      let second = h.run_respawn().await.unwrap();
      assert_ne!(first.scope_unit, second.scope_unit);
      assert_eq!(first.group_id, second.group_id);
  }
  ```
  Add REST `spawn_terminal_pane` coverage and an OOM/paused Stop-winning test that suppresses auto-respawn.
- [ ] **RED command / expected failure:**
  ```bash
  cargo test -p freshell-ws --test auto_resume_respawn
  cargo test -p freshell-ws registered_agent_resource_control
  cargo test -p freshell-freshagent registered_agent_resource_control
  ```
  Failures show all three doors still call `registry.create` with an unwrapped spec.
- [ ] **Minimal implementation:** branch only on membership in `cli_commands`; prepare leaf before `registry.create`; wrap just that spec; attach child diagnostics after spawn; extend the existing exit hook with group/root identity; do not change `freshell-terminal` into a global interceptor. A late `systemd-run` failure remains an ordinary immediate PTY exit.
- [ ] **GREEN command / expected result:** rerun RED commands; WS, REST, and auto-respawn registered modes are contained and shell remains outside.
- [ ] **Broader verification:** `cargo test -p freshell-ws terminal_create_ordering && cargo test -p freshell-freshagent terminal_tabs`.
- [ ] **Commit:**
  ```bash
  git add crates/freshell-ws crates/freshell-freshagent/src/terminal_tabs.rs
  git commit -m "feat(rust-pty): contain every registered agent launch door" \
    -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
    -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
  ```

## Task 8: Contain Fresh Claude and Fresh Codex Roots Without Capturing Probes

**Files:** modify `crates/freshell-freshagent/src/claude.rs:73-115,1882-1923`, `crates/freshell-freshagent/src/codex.rs:695,792,2134,2660,2893,3070-3110,3415-3492`; add focused crate-local tests and extend `crates/freshell-freshagent/tests/claude_sidecar_interrupt_dispatch.rs` only for launch setup assertions, not interruption behavior.

**Interfaces consumed:** state-injected controller; Fresh create/resume pane IDs; Claude sidecar `created` handshake; Fresh Codex app-server handshake and existing retry/respawn owners.

**Interfaces produced:** one ordinary logical leaf per Fresh session; each root/replacement is a unique child scope; Fresh Codex checks the per-group suppression state inside its single `spawn_sidecar` chokepoint immediately before `cmd.spawn()` (`crates/freshell-freshagent/src/codex.rs:3110`), covering all six callers—create (`:695`), resume (`:792`), fork (`:2134`), `ensure_session_alive` respawn (`:2660`), `respawn_as_new_thread_after_crash` (`:2893`), and `ensure_session_resumable` (`:3492`). The alternative would be a check in `ensure_session_resumable` after session-lease acquisition (`codex.rs:3449-3489`) and immediately before its spawn (`:3492`), but implement only the shared `spawn_sidecar` chokepoint to avoid duplication. The expired-lease arm already awaits tree death through `kill_and_confirm_tree_dead` (`codex.rs:3474-3479`; `crates/freshell-freshagent/src/session_lease.rs:65`). Managed publication still requires observed child scope and `memory.oom.group=1`; stale/removed/suppressed group state prevents `cmd.spawn()`.

- [ ] **RED tests:**
  ```rust
  #[tokio::test]
  async fn fresh_codex_spawn_chokepoint_suppresses_attempt_two() {
      let h = fresh_codex_harness().suppress_group_after_first_spawn();
      let result = h.retry_through_a_second_spawn_sidecar_call().await;
      assert!(result.unwrap_err().contains("resource policy"));
      assert_eq!(h.spawn_count(), 1);
      assert_eq!(h.spawn_suppression_checks(), 2);
  }

  #[tokio::test]
  async fn model_catalog_probe_never_allocates_a_containment_group() {
      let h = fresh_state_with_recording_controller();
      h.query_model_capabilities().await.unwrap();
      assert!(h.controller_calls().is_empty());
  }
  ```
  Add Claude created-before-publication OOMPolicy confirmation and same-leaf Fresh Codex replacement tests.
- [ ] **RED command / expected failure:** `cargo test -p freshell-freshagent fresh_resource_control` fails because both direct spawn functions bypass the controller and Fresh Codex's `spawn_sidecar` has no per-group suppression check immediately before `cmd.spawn()`.
- [ ] **Minimal implementation:** wrap only long-lived roots; keep the sanctioned JS sidecar contract unchanged; carry immutable group identity in existing session records; add the one per-group suppression check in `spawn_sidecar` immediately before `cmd.spawn()` so all six current callers are covered. On stale, removed, or suppressed group state, return without spawning; do not duplicate the check at the callers or touch model-capability transport construction.
- [ ] **GREEN command / expected result:** rerun RED command; Fresh roots are scoped, retries are suppressible, and probes record zero controller calls.
- [ ] **Broader verification:** `cargo test -p freshell-freshagent claude && cargo test -p freshell-freshagent codex`.
- [ ] **Commit:**
  ```bash
  git add crates/freshell-freshagent
  git commit -m "feat(fresh-agent): contain Rust-owned Claude and Codex roots" \
    -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
    -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
  ```

## Task 9: Give the Rust OpenCode Manager One Shared Leaf and Identity-Safe Replacement

**Files:** modify `crates/freshell-opencode/src/serve.rs:320-464,539-590`, `crates/freshell-opencode/src/transport.rs:204-314`, `crates/freshell-freshagent/src/{lib,opencode_ws}.rs`; add/extend crate-local tests.

**Interfaces consumed:** Shared OpenCode policy; existing `OpencodeServeManager::ensure_started`, `ProcessSpawner`, event stream handle, and single-flight startup; pane IDs from Rust Fresh-agent callers.

**Interfaces produced:** one manager-owned shared logical leaf; immutable `ServeInstanceHandle { instance_id, process, ownership_id, event_stream, scope_unit }`; active/candidate/retiring child scopes in that leaf; one one-shot startup gate shared by current waiters with `affectedPaneIds`; exact-handle retirement and release only when no child scopes remain.

- [ ] **RED tests:**
  ```rust
  #[tokio::test]
  async fn late_retirement_of_old_instance_cannot_clear_or_stop_candidate() {
      let h = opencode_replacement_harness();
      let old = h.start_first().await;
      let candidate = h.publish_candidate_while_old_retirement_waits().await;
      h.finish_retirement(old).await;
      assert_eq!(h.current_instance_id().await, candidate.instance_id);
      assert!(!candidate.was_stopped());
      assert!(h.loss_events_for(candidate.instance_id).is_empty());
  }

  #[tokio::test]
  async fn shared_startup_gate_collects_zero_one_or_many_affected_panes() {
      let h = failing_startup_harness();
      let a = h.ensure_started(Some("p1")).await_pending();
      let b = h.ensure_started(Some("p2")).await_pending();
      assert_eq!(h.pending_decision().affected_pane_ids, vec!["p1", "p2"]);
      h.cancel();
      assert!(a.await.is_err() && b.await.is_err());
  }
  ```
  Add zero-pane typed error/no popup, bounded overlap, same leaf, unique scope, and final-scope-only leaf release tests.
- [ ] **RED command / expected failure:** `cargo test -p freshell-opencode shared_leaf replacement && cargo test -p freshell-freshagent opencode_resource_control` fails because `RunningServe` lacks immutable identity/scope and startup has no shared containment gate.
- [ ] **Minimal implementation:** candidate-first publication; retire only captured handle; clear/emit loss only when current `Arc` identity still matches; controller child-count owns leaf release. Existing provider instance identity is process identity, not a containment policy generation.
- [ ] **GREEN command / expected result:** rerun RED commands; all overlap and waiter-cardinality tests pass.
- [ ] **Broader verification:** `cargo test -p freshell-opencode && cargo test -p freshell-freshagent opencode`.
- [ ] **Commit:**
  ```bash
  git add crates/freshell-opencode crates/freshell-freshagent/src/lib.rs crates/freshell-freshagent/src/opencode_ws.rs
  git commit -m "feat(opencode): contain the shared Rust service by identity" \
    -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
    -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
  ```

## Task 10: Contain Terminal-Mode Codex and Replace Cross-Server Retention Safely

**Files:** modify `crates/freshell-codex/src/launch_lifecycle.rs:420-489,617-987,990-1418`, `sidecar_store.rs:38-76,174-247`, `sidecar_reconcile.rs:86-187`, `sidecar_sweep.rs:131-163,470-615`, `runtime_select.rs`; modify `crates/freshell-server/src/main.rs:276-277,1133-1178,1902-1990`; extend `crates/freshell-codex/tests/launch_lifecycle.rs`, sidecar tests, and `crates/freshell-ws/tests/codex_managed_launch_e2e.rs`.

**Interfaces consumed:** terminal group prepared in Task 7; current `CodexLaunchPlanner::plan_create_with_retry` (`crates/freshell-codex/src/launch_lifecycle.rs:449`); existing `/proc` `(pid,starttime,cmdline)` verification; `SidecarReconciler::boot_reconcile`, `SidecarReconciler::sweep_unclaimed`, and `kill_verified_sidecar_tree(record) -> KillTreeOutcome`; current retention/reconcile/store; controller mode and per-group suppression state. The legacy Node `startRuntime` (`server/coding-cli/codex-app-server/runtime.ts:1810`) is excluded.

**Interfaces produced:** sidecar and PTY child scopes under one ordinary leaf; a per-group suppression consult inside `CodexLaunchPlanner::plan_create_with_retry` at the awaited backoff boundary, after `tokio::time::sleep` and immediately before attempt N+1 re-enters `plan_create` (`launch_lifecycle.rs:449,468-471`); containment-aware use of existing survivor-reconciliation/reaping entry points; current uncontained retention/reattachment preserved byte-for-byte. The managed planner already awaits prior-sidecar teardown at `launch_lifecycle.rs:434-440`, and `CodexLaunchError::Config` is never retried (`launch_plan.rs:362-369`).

- [ ] **RED tests:**
  ```rust
  #[tokio::test]
  async fn contained_shutdown_reaps_and_removes_record_uncontained_shutdown_retains() {
      let contained = lifecycle_harness(true).with_adopted_sidecar().await;
      contained.shutdown().await;
      assert!(contained.pid_gone().await && contained.records().is_empty());
      let uncontained = lifecycle_harness(false).with_adopted_sidecar().await;
      uncontained.begin_shutdown_retention(); uncontained.shutdown().await;
      assert!(uncontained.pid_alive() && uncontained.record_is_retained());
  }

  #[tokio::test]
  async fn contained_resume_never_signals_unverifiable_or_mismatched_identity() {
      let h = previous_generation_harness(IdentityVerdict::Unverifiable);
      assert!(h.resume_contained().await.is_err());
      assert!(h.signals().is_empty());
  }

  #[tokio::test]
  async fn managed_planner_suppresses_attempt_two_after_backoff() {
      let h = managed_retry_harness().suppress_group_during_first_backoff();
      assert!(h.plan_create_with_retry().await.is_err());
      assert_eq!(h.spawn_count(), 1);
  }
  ```
  Add Verified → `kill_verified_sidecar_tree` → await PID disappearance → remove row → fresh spawn; Mismatch/Unverifiable → no signal; managed-planner backoff-boundary suppression with no second spawn; active/candidate/retiring overlap in one leaf; and a main shutdown test proving only `begin_shutdown_retention()` is gated off when containment is enabled while the landed owner order remains unchanged.
- [ ] **RED command / expected failure:**
  ```bash
  cargo test -p freshell-codex --test launch_lifecycle contained
  cargo test -p freshell-codex sidecar_reconcile contained
  cargo test -p freshell-ws --test codex_managed_launch_e2e containment
  cargo test -p freshell-server contained_codex_shutdown
  ```
  Fail because the current manager always supports retention/reattachment and direct sidecar spawn is unscoped.
- [ ] **Minimal implementation:** inject the boot controller into the terminal Codex manager and keep one leaf through PTY/sidecar replacement overlap. In `plan_create_with_retry`, after the existing awaited backoff and before looping into attempt N+1, consult the per-group state; stale, removed, or suppressed means return without another `plan_create` or spawn. Leave the existing awaited teardown at `launch_lifecycle.rs:434-440` and never-retry-config behavior untouched. Gate only `begin_shutdown_retention()` at `main.rs:1941-1942`; preserve the existing shutdown order and let the unchanged manager shutdown at `:1972-1975` reap when the flag is unset. For contained survivor cleanup, call `SidecarReconciler::boot_reconcile` (production caller `main.rs:1152`) and the TOCTOU-safe `sweep_unclaimed` contract (`sidecar_sweep.rs:131-163`), with `kill_verified_sidecar_tree` (`:494`) as the awaited identity-safe signal path. It re-verifies per PID and runs SIGTERM → 5-second `poll_incarnation_gone` call (`:591`) → SIGKILL. Do not use best-effort, no-wait `reap_owned_codex_sidecars` (`transport.rs:91`) for the pre-spawn reap, and never adopt previous-generation processes in contained mode.
- [ ] **GREEN command / expected result:** rerun RED commands; contained and uncontained variants pass, including lost cross-server continuity for contained Codex.
- [ ] **Broader verification:** `cargo test -p freshell-codex && cargo test -p freshell-ws codex`.
- [ ] **Commit:**
  ```bash
  git add crates/freshell-codex crates/freshell-ws/tests/codex_managed_launch_e2e.rs crates/freshell-server/src/main.rs
  git commit -m "feat(codex): contain roots and reap retained survivors safely" \
    -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
    -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
  ```

# Phase 4 — pressure, OOM cleanup, Rust runtime protocol, and prompts

## Task 11: Implement Pressure Episodes, Child-Scope OOM Attribution, and Per-Group Mutexes

**Files:** create `crates/freshell-resource-control/src/pressure.rs`; extend `controller.rs`, `systemd.rs`, and crate tests; modify existing Rust root-exit/retry call sites from Tasks 7-10.

**Interfaces consumed:** aggregate/leaf `memory.events.local` high/max; child-scope local `oom_group_kill`; leaf current/swap; `cgroup.events populated/frozen`; thaw guard; known child-scope set; exact existing Stop path.

**Interfaces produced:** `PressureEpisode`, 60-second warning/10-second quiet reset, 95% critical detection, hog selection, max-two aggregate latch, child OOM classifier, local `tokio::Mutex<()>` per group, `pause/resume/stop/finalize/register_replacement` phase-safe actions.

- [ ] **RED tests:**
  ```rust
  #[tokio::test]
  async fn child_oom_marks_group_stopped_and_best_effort_stops_known_siblings() {
      let h = group_harness().with_children(["pty.scope", "sidecar.scope"]);
      h.baseline_child_oom("sidecar.scope", 3);
      h.set_child_oom("sidecar.scope", 4);
      h.poll().await;
      assert_eq!(h.phase(), GroupPhase::KernelStopped);
      assert_eq!(h.stopped_siblings(), ["pty.scope"]);
      assert!(h.retry_suppressed());
  }

  #[tokio::test]
  async fn leaf_local_oom_is_not_used_as_exact_attribution() {
      let h = group_harness().with_leaf_events("oom_group_kill 9");
      h.poll().await;
      assert_ne!(h.phase(), GroupPhase::KernelStopped);
  }

  #[tokio::test]
  async fn resume_stop_pause_exit_and_retry_serialize_and_recheck() {
      let h = locked_group_harness(GroupPhase::Paused);
      let resume = h.resume_with_blocked_thaw();
      assert_eq!(h.try_stop().await.status(), 409);
      h.finish_thaw(); resume.await.unwrap();
      assert_eq!(h.phase(), GroupPhase::Running);
  }
  ```
  Add warning/cancel/quiet-rearm, aggregate top-two latch, warning-counts-as-one, current+swap ordering, guard failure no-freeze, frozen=1 verification, pause-vs-exit, and retry-vs-stop tests.
- [ ] **RED command / expected failure:** `cargo test -p freshell-resource-control pressure oom mutex root_exit` fails because monitoring and serialized actions do not exist.
- [ ] **Minimal implementation:** poll/select outside group mutex, recheck phase/root/episode inside, hold through one systemd action or replacement registration; child local counter is the only exact OOM evidence; hierarchical leaf summary may trigger child rescan; accept the tiny read/release residual without extra machinery; never Stop a healthy paused group from pressure policy.
- [ ] **GREEN command / expected result:** rerun RED command; deterministic episode, OOM, and race tests pass.
- [ ] **Broader verification:** `cargo test -p freshell-resource-control && cargo clippy -p freshell-resource-control -- -D warnings`.
- [ ] **Commit:**
  ```bash
  git add crates/freshell-resource-control crates/freshell-ws crates/freshell-freshagent crates/freshell-codex crates/freshell-opencode
  git commit -m "feat(resource-control): monitor pressure and serialize group actions" \
    -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
    -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
  ```

## Task 12: Add Rust Runtime Routes, One-Shot Launch Decisions, and Additive Messages

**Files:** extend `crates/freshell-server/src/resource_containment.rs`; modify `crates/freshell-server/src/main.rs` router assembly, `crates/freshell-protocol/src/server_messages.rs`, `shared/ws-protocol.ts:887-938,1101-1214`, `port/contract/*.json`; add Rust server/protocol tests.

**Interfaces consumed:** Task 11 state/actions; SettingsStore; broadcast bus; launch failures known before publication; affected pane IDs; explicit restart launch parameters.

**Interfaces produced:** authenticated `GET /api/resource-containment`; `POST /api/resource-containment/groups/:id/actions`; `POST /api/resource-containment/launch-decisions/:id`; additive server messages for runtime updates and one-shot launch decisions; in-memory oneshot decision map only while original launch/service operation awaits.

- [ ] **RED tests:**
  ```rust
  #[tokio::test]
  async fn launch_choice_continues_same_operation_once_and_is_absent_on_reconnect() {
      let h = route_harness(vec!["p1"]);
      let pending = h.begin_launch();
      h.resolve("launch_uncontained").await;
      assert_eq!(pending.await.unwrap().continuations, 1);
      assert!(h.runtime_snapshot().launch_decisions.is_empty());
      h.fail_continuation_later();
      assert_eq!(h.decision_open_count(), 1);
  }

  #[tokio::test]
  async fn restart_consumes_old_group_id() {
      let h = stopped_group_harness("old");
      let new_id = h.action("old", "restart_agent").await.unwrap().new_group_id;
      assert_ne!(new_id, "old");
      assert_eq!(h.action("old", "resume").await.unwrap_err().status, 404);
  }
  ```
  Add disable-persist-then-same-operation, cancel rollback, zero-pane typed error/no broadcast, multi-pane `Cancel launches`, 409 incompatible action, and same-server runtime snapshot tests.
- [ ] **RED command / expected failure:**
  ```bash
  cargo test -p freshell-server resource_containment
  cargo test -p freshell-protocol resource_containment
  npm run contract:generate && git diff --exit-code -- port/contract
  ```
  Rust tests fail because routes/messages are absent; contract generation changes once additive messages are authored.
- [ ] **Minimal implementation:** one ephemeral map of decision ID to oneshot sender and affected panes, deleted on resolve/cancel/operation drop; launch uncontained and disable continue the original operation once; later failures are ordinary. Keep all new client actions on authenticated HTTP, so `ClientMessageSchema` is unchanged. The messages and optional settings/platform fields remain additive at the current protocol version (8); regenerate contract artifacts and update the existing inventory assertions for the new server messages. For the pre-change drift guard, phrase the assertion as **“baseline equals the counts asserted by the existing inventory test”** (`crates/freshell-protocol/tests/inventory.rs`; currently 36 client / 60 server / 96 total), rather than duplicating those numeric literals in another test or this plan's executable examples.
- [ ] **GREEN command / expected result:** rerun Rust tests, then `npm run contract:generate`; generated artifacts are committed and `crates/freshell-protocol/tests/version.rs` still passes at the current version (8), while the client-message inventory remains unchanged from the baseline asserted by the existing inventory test.
- [ ] **Broader verification:** `cargo test -p freshell-protocol --test version && npm run test:port && npm run typecheck:client`.
- [ ] **Commit:**
  ```bash
  git add crates/freshell-server/src/resource_containment.rs crates/freshell-server/src/main.rs crates/freshell-protocol shared/ws-protocol.ts port/contract
  git commit -m "feat(resource-control): expose Rust runtime actions and decisions" \
    -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
    -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
  ```

## Task 13: Implement the Non-Dismissible Runtime Prompt and Same-Server Restore

**Files:** create `src/store/resourceContainmentSlice.ts`, `src/components/ResourceContainmentModal.tsx`, `test/unit/client/components/ResourceContainmentModal.test.tsx`; modify `src/App.tsx`, reuse `src/components/ui/confirm-modal.tsx` styling without its dismiss behavior.

**Interfaces consumed:** Task 12 REST snapshot/actions and additive messages; final copy/actions above; existing auth/bootstrap/reconnect flow.

**Interfaces produced:** warning countdown, paused, kernel-stopped, and known launch-failure prompt surfaces; same-server snapshot restore; no launch-decision restore; exact contextual Close/Cancel labels.

- [ ] **RED client test:**
  ```tsx
  it('keeps paused prompt present with exactly Resume and Stop agent', async () => {
    renderContainment({phase:'paused',groupId:'g1',label:'Claude',affectedPaneIds:['p1']})
    expect(screen.getByText("Claude is paused because it's using too much memory")).toBeVisible()
    expect(screen.getAllByRole('button').map(b=>b.textContent)).toEqual(['Resume','Stop agent'])
    await user.keyboard('{Escape}')
    expect(screen.getByText(/is paused because/i)).toBeVisible()
    fireEvent.mouseDown(document.body)
    expect(screen.getByText(/is paused because/i)).toBeVisible()
  })
  ```
  Add exact copy tests for warning/kernel-stop/launch failure; multi-pane list; zero-pane no modal; reconnect snapshot restores paused; reconnect does not restore launch choice; new server boot ID clears old runtime state.
- [ ] **RED command / expected failure:** `npm run test:vitest -- test/unit/client/components/ResourceContainmentModal.test.tsx --config config/vitest/vitest.config.ts --run` fails because slice/modal do not exist.
- [ ] **Minimal implementation:** one app-level modal driven solely by Rust server state; paused variant uses a dialog shell with no close callback, Escape handler, or backdrop dismissal; countdown uses server deadline; actions call Task 12 routes and wait for server update.
- [ ] **GREEN command / expected result:** rerun RED command; all exact-copy and non-dismissal assertions pass.
- [ ] **Broader verification:** `npm run typecheck:client && npm run lint`.
- [ ] **Commit:**
  ```bash
  git add src/store/resourceContainmentSlice.ts src/components/ResourceContainmentModal.tsx src/App.tsx test/unit/client/components/ResourceContainmentModal.test.tsx
  git commit -m "feat(resource-ui): add server-authoritative containment prompts" \
    -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
    -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
  ```

# Phase 5 — Rust integration, live cgroup proof, Rust-only E2E, and docs

## Task 14: Prove Rust Lifecycle and systemd Behavior End to End

**Files:** create `crates/freshell-resource-control/tests/live_systemd.rs`; extend `crates/freshell-server/tests/resource_control_wiring.rs`, `crates/freshell-ws/tests/auto_resume_respawn.rs`, `crates/freshell-ws/tests/codex_managed_launch_e2e.rs`, and focused Fresh/OpenCode/Codex Rust tests.

**Interfaces consumed:** Tasks 1-13 only; no new production interface.

**Interfaces produced:** Rust integration/live evidence only.

- [ ] **RED integration matrix:** cover support-floor inside/outside branches; first enable/fallback/retention; complete settings snapshot race; aggregate/leaf readback; all registered PTY doors; Fresh Claude/Codex; shared OpenCode overlap; terminal Codex contained/uncontained shutdown; Fresh Codex `spawn_sidecar` chokepoint suppression; managed Codex planner backoff-boundary suppression; child-scope OOM sibling cleanup; pressure latch; root-exit paused exception; restart IDs; one-shot decisions; mutex races.
- [ ] **RED command / expected failure:**
  ```bash
  cargo test -p freshell-server --test resource_control_wiring
  cargo test -p freshell-ws --test auto_resume_respawn --test codex_managed_launch_e2e
  cargo test -p freshell-resource-control --test live_systemd -- --ignored
  ```
  Before adding the integration/live cases, named filters are absent or fail to prove live cgroup state.
- [ ] **Live scope/OOM test:** create unique scratch aggregate/leaf/child units; assert set-property readback; launch through `systemd-run --user --scope --slice=<leaf> --property=OOMPolicy=kill`; observe exact child `ControlGroup`, `memory.oom.group=1`, and child-local `oom_group_kill` after a bounded scratch allocator; verify no slice `memory.oom.group` mutation is attempted; clean only recorded unique units.
- [ ] **Live thaw-guard test:** an observer starts a detached scratch counter and a separate scratch parent process. That parent alone owns the sole writer, starts the guard, freezes aggregate plus leaf, writes exact unit metadata, then blocks. The independent observer terminates and waits for the parent, bounded-polls guard cleanup and recursive thaw, sees the counter advance, and confirms hard limits remain. This proves best-effort behavior only and never asserts a real agent survives.
- [ ] **Minimal implementation:** tests only; panic-safe cleanup records exact units/PIDs; never bind/restart/touch live port 3001; no broad kill command.
- [ ] **GREEN command / expected result:** rerun RED commands; all Rust integration and ignored live tests pass with concrete cgroup evidence.
- [ ] **Broader verification:** `cargo fmt --check && cargo clippy --workspace -- -D warnings && cargo test --workspace`.
- [ ] **Commit:**
  ```bash
  git add crates/freshell-resource-control/tests crates/freshell-server/tests/resource_control_wiring.rs crates/freshell-ws/tests crates/freshell-freshagent crates/freshell-codex crates/freshell-opencode
  git commit -m "test(resource-control): prove Rust cgroup and lifecycle behavior" \
    -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
    -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
  ```

## Task 15: Add Explicit rust-chromium Acceptance and Update User/Agent Documentation

**Files:** create `test/e2e-browser/specs/resource-containment-rust.spec.ts`; modify `test/e2e-browser/playwright.config.ts:176-292,318-505`, `docs/index.html`, `AGENTS.md`.

**Interfaces consumed:** final Rust API/UI from Tasks 1-14; existing owned `RustServer` Playwright helper; `RUST_ONLY_SPECS` and `rust-chromium.testMatch` registration.

**Interfaces produced:** Rust-only browser acceptance and current documentation.

- [ ] **RED E2E:** register the spec in both `RUST_ONLY_SPECS` and the `rust-chromium` project. Test unavailable when capability field is absent; first enable creates all three editable groups; edits lock while contained; known launch failure choices; warning countdown cancel/pause; non-dismissible paused Resume/Stop; same-server reconnect restore; new-server no adoption; shared OpenCode affected-pane list; old restart ID 404.
- [ ] **RED command / expected failure:**
  ```bash
  npm exec playwright test -- --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/resource-containment-rust.spec.ts
  ```
  `test/unit/client/components/settings/RuntimeSettings.test.tsx` is the new resource-limits test created from scratch in Task 4, not an extension of a pre-existing file.
  The newly registered journey fails until all final UI/server behavior is present. Do not run it under `chromium` or `legacy-chromium`.
- [ ] **Documentation:** update `docs/index.html` Advanced → Runtime mock with the three groups and unsupported state; update `AGENTS.md` Rust-server architecture notes with scope/exclusions, settings location, child OOM best-effort semantics, guard/shutdown caveat, and contained Codex’s loss of cross-server continuity.
- [ ] **GREEN command / expected result:** rerun the exact RED E2E command; all tests pass against an owned ephemeral Rust server.
- [ ] **Broader verification:**
  ```bash
  npm run typecheck:client
  npm run lint
  npm run test:vitest -- test/unit/shared/resource-limits.test.ts test/unit/client/components/settings/RuntimeSettings.test.tsx test/unit/client/components/ResourceContainmentModal.test.tsx --config config/vitest/vitest.config.ts --run
  npm run contract:generate
  npm run test:port
  cargo fmt --check
  cargo clippy --workspace -- -D warnings
  cargo test --workspace
  cargo test -p freshell-resource-control --test live_systemd -- --ignored
  npm exec playwright test -- --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/resource-containment-rust.spec.ts
  ```
  These gates contain no legacy-backend runtime test and no default Node-backed Playwright project.
- [ ] **Forbidden-complexity audit:** search the diff for recalculation/provenance/stale-policy/drain/generation/PSI/trend/multi-server/adoption/interrupt/journal/durable-replay/global-queue/raw-cgroup-write/global-interceptor/probe-lifecycle additions. Every hit must either be this prohibition/documentation or be removed.
- [ ] **Commit:**
  ```bash
  git add test/e2e-browser/specs/resource-containment-rust.spec.ts test/e2e-browser/playwright.config.ts docs/index.html AGENTS.md
  git commit -m "test(resource-control): add Rust-only browser acceptance" \
    -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
    -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
  ```

This plan comprises exactly 5 phases and 15 independently testable tasks.