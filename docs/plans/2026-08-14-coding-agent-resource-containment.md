# Coding Agent Resource Containment Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Add optional, user-configurable cgroup-v2 containment for every future Freshell-managed coding-agent process in both production backends, without changing ordinary shells or work that was already running.

**Architecture:** A strict shared settings contract supplies aggregate, ordinary-agent, and shared-OpenCode limits to one boot-scoped resource controller per backend. The low-level controller owns systemd/cgroup mechanics and pure pressure observations; a server-layer coordinator owns launch intents, pane membership, pending choices, phases, reconnect snapshots, actions, and respawn suppression, while the React client only renders server-authored state.

**Tech Stack:** Node.js >=22.5.0, TypeScript 5.9/NodeNext, Zod 4, Express, node-pty, React 18, Redux Toolkit, Vitest 3, Playwright 1.58, Rust 1.96.0 (edition 2021), serde, Tokio, Axum, portable-pty, systemd user units, and Linux cgroup v2.

**Scope decision:** This is one cohesive cross-backend subsystem because settings, capability, launch containment, pressure policy, wire state, and UI actions share one fail-closed lifecycle and cannot be shipped independently without violating a user story. Implementation is nevertheless split into five dependency-ordered phases and fifteen atomic tasks so contracts, low-level control, each process owner, policy, UI, and acceptance evidence remain independently reviewable; no phase is a product-level deferral or separately deployable feature.

## Global Constraints

- Repository root for every command is `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment`; never rely on shell cwd.
- Every Git command begins with `git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment` followed by the required Git subcommand.
- Relative NodeNext imports include `.js`; Node runtime floor is `>=22.5.0`.
- Rust commands use `cargo +1.96.0`; workspace edition is 2021 and resolver is 2.
- The feature is Linux-only and requires cgroup v2 plus a reachable systemd user manager. There is no ulimit, Docker, VM, `.wslconfig`, or other fallback mechanism.
- Unsupported capability copy is exactly `Requires Linux cgroup v2 and a systemd user session.` and no alternative reason is exposed.
- Stored settings path is optional `safety.codingAgentResourceLimits`; absence means disabled. Optional values are omitted/`undefined`, never `null`.
- One stored object contains `enabled` plus exactly fifteen integers: five each under `allAgents`, `eachAgent`, and `sharedOpenCode`.
- First-enable fallback capacity is exactly 2000 mCPU, 4 GiB memory, 512 MiB swap, and 512 tasks, independently per missing dimension. Explicit zero swap remains zero.
- Initial aggregate values are CPU `C/2`, memory max `2M/3`, memory high `4/5` of that max, swap `min(S/4, memoryMax/4)`, and tasks `3P/4`. Ordinary hard limits are 50% of aggregate; shared OpenCode hard limits are 90% of aggregate; each leaf memory high is 80% of its own memory max.
- CPU rounds down to the nearest 100 mCPU; bytes round down to the nearest MiB (`1_048_576`); tasks round down to an integer.
- Canonical numeric input is a finite safe integer. CPU/tasks must fit `u32`; byte values must be `<= 9_007_199_254_740_991` so TypeScript and Rust JSON are exact. Invalid host-derived output returns `409 RESOURCE_LIMITS_UNAVAILABLE` and does not persist.
- `memoryHighBytes < memoryMaxBytes`; CPU, memory high, memory max, and tasks are positive; swap is nonnegative; every child value is no greater than its aggregate counterpart.
- The first shorthand enable calculates once. Disable and re-enable only flip `enabled`; no boot recalculation, Recalculate action, derivation provenance, staleness flag, generation number, or in-flight-drain protocol exists.
- Numeric edits are rejected with `409 RESOURCE_LIMITS_ACTIVE` whenever `hasTrackedGroups()` is true, including a zero-scope reserved leaf. `runningCount` counts live process scopes only and is a UI metric.
- Persistence precedes live mutation, response, and broadcast. Persistence failure is `500 PERSIST_FAILED`, retains old state, and emits nothing.
- Capability probes the root user-manager `-.slice` ControlGroup, not Freshell's own cgroup. The path must begin `/`, contain no `..` segment, delegate `cpu memory pids`, and expose `cgroup.freeze` and `memory.oom.group`; root freezer writeability is not required.
- Effective CPU is the minimum of affinity intersected with cpuset and tightest finite ancestor `cpu.max`; effective memory/swap/tasks use tightest finite target-ancestor values and system totals. An unreadable dimension is omitted without making the capability unavailable.
- One memoized capability probe result is shared by `/api/platform`, bootstrap, and first-enable calculation. Production attempts reads directly and interprets failures; it does not stat before read.
- Aggregate unit is `freshellagents<sanitized-boot-token>.slice`, one per process boot, with no dash in the token or name stem and raw `memory.oom.group=0`.
- Ordinary leaf is `freshellagents<boot>-agent<uuid>.slice`; shared OpenCode leaf is `freshellagents<boot>-opencode<uuid>.slice`; both have raw `memory.oom.group=1`.
- Process scope is `freshellagentproc<uuid>.scope`; it has no direct limits. Every unit token is lowercase ASCII `[a-z0-9]`; generated empty/colliding tokens retry up to 32 times, then return `InvalidUnitToken`.
- Aggregate/leaf properties are exactly `CPUQuota=<mCPU/10>%`, `MemoryHigh=<bytes>`, `MemoryMax=<bytes>`, `MemorySwapMax=<bytes>`, and `TasksMax=<count>`.
- `systemd-run` argv is exactly `--user --scope --collect --quiet --unit=<scope> --slice=<leaf> -- <original-program> <each-original-argument-in-order>`; no shell string or `child_process.exec` is used.
- Verification resolves only `ControlGroup` through systemctl, validates hierarchy by path segments, reads raw cgroup files, accepts a wrapper PID outside only when bounded `cgroup.procs` polling finds a member inside, and never uses systemctl resource-property output as truth.
- A common launch transaction performs reserve -> wrap -> spawn -> verify -> commit. Spawn throw, verification throw/false, cancellation, startup deadline, or pre-spawn stream completion kill the child, release each scope once, abandon an empty leaf, and publish no created/readiness event.
- Eligibility is `mode !== 'shell'`, registered by the existing provider registry, and resolved executable basename not ending `.exe` case-insensitively. It is independent of dependency injection; enabled eligible launches with missing controller/limits fail closed.
- Included process paths are all five Node PTY ingress paths, Node Codex recovery PTY, Rust WS PTY, Rust REST PTY, Rust auto-respawn PTY, managed Codex sidecar+PTY, Fresh Claude/Kilroy root, Fresh Codex root, and one shared Fresh OpenCode service. Future registered terminal modes are included automatically.
- Excluded processes are Freshell itself, ordinary shells, pre-existing processes, WSL interop `.exe`, external SSH/remote managers, Docker/BuildKit daemon work, and disk-I/O control.
- Managed Codex sidecar and PTY share one ordinary leaf and use two unique scopes. Every recovery generation gets a new leaf and scopes; verified publication switches ownership before retiring the previous generation.
- Contained managed-Codex sidecars are not retained across server shutdown; existing uncontained retention behavior remains unchanged. This keeps boot-scoped aggregate disposal and next-boot ownership coherent.
- Shared OpenCode uses one `sharedOpenCode` leaf/scope per service generation; attachments are metadata and unregistering a pane never releases the service scope.
- Fresh-agent pane correlation uses server validation: a wire `paneId` is accepted only when the current layout row carries the same `createRequestId`; otherwise the server searches layout by `createRequestId`. No unit/group name is accepted from a client.
- Pending duplicates retain the original pending ID and FIFO position and atomically replace only the compact intent while not resolving. While resolving, replacement is rejected with `409 PENDING_LAUNCH_RESOLVING`.
- Wire message is exactly `{type:'resource.containment.updated', pending:Array<{id,paneId}>, snapshot:{runningCount,groups:Array<{id,kind,label,phase,deadlineAt?,stopReason?,members}>}}`; it never contains unit/scope names.
- Pending launch choices use only `/api/resource-control/pending/:id/resolve`; live group actions use only `/api/resource-control/groups/:groupId/action`. Context, not action text, chooses the endpoint.
- Pending launch actions are `launch_uncontained`, `disable_containment`, and `close_pane`. Group actions are `pause_now`, `cancel_countdown`, `resume`, `stop_agent`, `restart_agent`, and `close_pane` with exact phase guards.
- Internal launch failure code is `RESOURCE_CONTAINMENT_FAILED`; it is request-correlated in terminal/fresh-agent transports after rollback and is accompanied by the coordinator pending snapshot.
- Only one focus-trapped dialog is mounted. FIFO pending launch has display priority; pressure state stays in Redux and appears immediately after pending is cleared.
- Warning countdown is the approved literal seconds format `00:60` through `00:00`; it does not carry to `01:00`.
- User-stopped copy is title `You stopped ${label}` and body `This agent is stopped. Restart it when you're ready, or close the pane.` Policy-stopped copy is title `Freshell stopped ${label}` and body `This agent was stopped by the resource policy. Restart it when you're ready, or close the pane.` Both use `Restart agent`, `Close pane`.
- Poll interval is exactly 1000 ms. Warning deadline is fixed at 60_000 ms. Event-quiet clear/rearm is 10_000 ms. Critical pressure is `memory.current >= floor(memory.max * 95 / 100)` or a rising local max counter.
- Pressure reads only `memory.events.local`, `memory.current`, `memory.swap.current`, `memory.high`, `memory.max`, and `cgroup.events`; no hierarchical `memory.events`, PSI, or `memory.pressure`.
- Aggregate selection ranks `memory.current + memory.swap.current` descending and group ID ascending on ties; warning/deadline selects one, critical selects at most two, and at most two aggregate-source pauses occur per episode.
- `warningSource` is server-internal and survives browser reconnect. Reconnect replays the original epoch-ms deadline and exact projected snapshot; the client never invents phase/deadline.
- Resume takes a fresh pressure baseline. Restart creates a new group and fresh baseline. Paused/stopped groups suppress lazy/provider/auto respawn until explicit restart.
- OOM attribution occurs before respawn: leaf `oom_kill` rise, or numeric SIGKILL 9 plus aggregate `oom_group_kill` rise. Aggregate rise alone is never OOM.
- No timer or pressure event automatically stops a paused group. Only explicit `stop_agent` invokes `stopGroup`.
- Node and Rust maintain wire/action/error/numeric parity. Keep WS protocol version 7 if additive contract tests pass; if and only if the frozen contract test rejects v7, bump both constants and generated contracts to 8 in the same task.
- Focused tests use repository scripts, never raw Vitest. Before broad tests run `npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:status` and wait for any holder.
- Shared tests use `config/vitest/vitest.config.ts`; server/integration tests use `config/vitest/vitest.server.config.ts`. Do not use `npm run test:integration` for `test/integration/server/**`.
- Destructive process/restart/config-corruption tests run in the repository sandbox. The one real systemd test is `#[ignore]`, uses unique owned units and RAII cleanup, and never triggers OOM.
- No deployment, service installation, or restart/stop of the live server on port 3001 is authorized.
- `README.md` is the only end-user Markdown file changed. `docs/index.html` remains the nonfunctional UI mock. Do not modify `docs/superpowers/plans/**`; those files are agent documentation/provenance.
- Each task is independently reviewable, follows RED -> observed FAIL -> minimal implementation -> observed PASS -> focused commit, and uses the configured Dan Shapiro noreply identity plus the required Amplifier trailers.

---

## File Structure Map

### Shared contract and protocol

| File | Responsibility |
|---|---|
| `shared/resource-limits.ts` | Canonical TypeScript limits/capacity types, first-enable calculator, safe-integer/cross-field validator. |
| `shared/settings.ts` | Full optional settings field, strict full-or-enable-only patch union, sanitize/merge/compose/strip paths. |
| `shared/ws-protocol.ts` | Additive runtime snapshot, pending prompt, group/action/error wire types. |
| `shared/ws-version.ts` | Remains 7 unless contract evidence requires 8. |
| `crates/freshell-protocol/src/resource_limits.rs` | Canonical Rust types/calculator/validator with camelCase serde. |
| `crates/freshell-protocol/src/settings.rs` | Optional settings field and closed-tree validation. |
| `crates/freshell-protocol/src/server_messages.rs` | Rust runtime snapshot and action parity. |
| `crates/freshell-protocol/tests/roundtrip.rs` | JSON parity and omission/strictness evidence. |

### Capability and low-level control

| File | Responsibility |
|---|---|
| `server/proc-info.ts` | Shared `/proc/meminfo`, CPU-list, and finite-limit parsers. |
| `server/resource-control/cgroup-path.ts` | Parse/validate root-relative ControlGroup, hierarchy comparison, safe cgroup mount join. |
| `server/resource-control/capability.ts` | Pure capability/effective-capacity derivation and production memoized probe factory. |
| `server/resource-control/systemd.ts` | Node unit registry, aggregate gate, systemd/cgroup operations, verification, snapshots, classification, launch transaction. |
| `server/resource-control/controller.ts` | Production argv-safe Node IO implementation and controller factory. |
| `crates/freshell-resource-control/src/cgroup_path.rs` | Rust path primitives used by probe/controller/live proof. |
| `crates/freshell-resource-control/src/capability.rs` | Rust capability/effective-capacity parity. |
| `crates/freshell-resource-control/src/systemd.rs` | `ResourceControl`/`SystemdIo` contracts and systemd controller. |
| `crates/freshell-resource-control/src/controller.rs` | Production Tokio filesystem/process IO and live-limit provider types. |
| `crates/freshell-resource-control/src/pressure.rs` | Pure leaf/aggregate pressure reducers. |

### Server coordination and launch ownership

| File | Responsibility |
|---|---|
| `server/resource-control/coordinator.ts` | Compact launch intents, pane/member indexes, pending FIFO, phases, warning source, polling, actions, replay, suppression. |
| `server/resource-control/router.ts` | Thin authenticated pending/group REST adapters. |
| `crates/freshell-server/src/resource_containment_coordinator.rs` | Rust server-layer coordinator; no reverse dependency into WS/UI/provider crates. |
| `server/terminal-registry.ts` | Async containment wrapper around unchanged synchronous Node PTY create and recovery PTY generation. |
| `crates/freshell-ws/src/terminal.rs` | Rust WS PTY and auto-respawn containment around unchanged blocking registry create. |
| `crates/freshell-freshagent/src/terminal_tabs.rs` | Rust REST PTY containment around unchanged blocking registry create. |
| `server/coding-cli/codex-app-server/{runtime,launch-planner}.ts` | Managed Codex sidecar scope ownership and group threading. |
| `crates/freshell-codex/src/{launch_plan,launch_lifecycle}.rs` | Rust managed Codex sidecar scope ownership/group threading and contained-shutdown policy. |
| `server/sdk-bridge.ts`, fresh Claude/Codex adapters | Fresh root reserve/wrap/verify/release in existing lifecycle owners. |
| `crates/freshell-freshagent/src/{claude,codex}.rs` | Rust fresh root reserve/wrap/verify/release. |
| Node/Rust OpenCode serve manager files | One shared service leaf/scope and attachment metadata. |

### Client and docs

| File | Responsibility |
|---|---|
| `src/store/resourceContainmentSlice.ts` | Server-pushed `pending` and `snapshot`; reference-preserving no-op reducer. |
| `src/components/settings/RuntimeSettings.tsx` | Local 15-field draft, immediate toggle, conversions, canonical validation, active lock. |
| `src/components/ui/dialog-shell.tsx` | One reusable portal/focus/scroll/dismissal implementation. |
| `src/components/ResourceContainmentModal.tsx` | Pending-priority and multi-leaf pressure dialog with exact copy/actions. |
| `docs/index.html` | Nonfunctional Runtime/settings and four-modal visual mock. |
| `README.md` | Public prerequisite/configuration/behavior documentation; only end-user Markdown change. |

### Tests and generated artifacts

New focused tests are `test/unit/shared/resource-limits.test.ts`, Node capability/controller/settings/terminal/fresh/router/pressure tests, client Runtime/modal tests, `test/integration/server/resource-containment.test.ts`, `test/e2e-browser/specs/resource-containment-ui.spec.ts`, and Rust pressure/live-systemd tests. Existing settings/platform/Codex/fresh/OpenCode/WS/auto-resume tests are extended. Task 12 regenerates exactly `port/contract/ws-protocol.schema.json`, `port/contract/ws-server-messages.schema.json`, and `port/contract/ws-message-inventory.json`.

### Test-double to production-proof map

Test doubles isolate failure order and deterministic policy; none is a substitute for shipped behavior:

| Test double | Production behavior that replaces it | Real outcome proof |
|---|---|---|
| Injected capability filesystem/process IO in Task 4 | Task 4 wires one memoized production probe into both platform APIs and first-enable settings paths. | Task 15 runs both backend settings/browser projects; `live_systemd.rs` proves the actual Linux/systemd prerequisite and cgroup paths. |
| Fake systemd/cgroup IO and child launchers in Tasks 6-7 | Tasks 6-7 create the production Node and Rust controllers; Tasks 8-11 route every listed process owner through those controllers. | Task 15's direct-production integration plus ignored `live_systemd.rs` prove real controller wiring, hierarchy, membership, limits, freeze, thaw, and cleanup. |
| Mock resource controllers and PTYs in Tasks 8-11 | The same tasks modify the real Node/Rust PTY, Codex, Claude/Kilroy, and OpenCode launch owners; the mocks only expose ordering and rollback. | Task 15 exercises production exports across the spawn matrix, and the live test executes the exact production `ProcessLaunch` under systemd. |
| Fake WebSocket frames in Tasks 12 and 14 | Tasks 12 and 14 wire the real Node and Rust handshake/broadcast providers and authenticated action routers. | Real Node/Rust WS integration tests and both Playwright backend projects in Tasks 14-15 prove reconnect replay, actions, and the rendered dialogs. |
| Fake clocks and pressure snapshots in Tasks 13-14 | Task 13 installs the production 1000-ms coordinator poller over controller `readSnapshots`; Task 14 wires actions and exit classification to lifecycle owners. | Task 15 imports the production reducer/coordinator path for exact long-run scenarios, while browser tests prove the resulting user-visible phases and preserved deadline. |
| `docs/index.html` visual mock | It is intentionally documentation-only and never stands in for runtime UI; Tasks 5, 12, and 14 implement the real React controls and dialogs. | Task 15 Playwright tests target the actual application in both backend projects. |

## Exact Cross-Task Interfaces

```ts
export type ResourceLimitSet = {
  cpuQuotaMillis: number
  memoryHighBytes: number
  memoryMaxBytes: number
  swapMaxBytes: number
  tasksMax: number
}

export type CodingAgentResourceLimits = {
  enabled: boolean
  allAgents: ResourceLimitSet
  eachAgent: ResourceLimitSet
  sharedOpenCode: ResourceLimitSet
}

export type EffectiveResourceCapacity = {
  cpuQuotaMillis?: number
  memoryBytes?: number
  swapBytes?: number
  tasksMax?: number
}

export type AggregateGroup = { unit: string }
export type LogicalGroup = { aggregateUnit: string; unit: string }
export type ProcessLaunch = { scope: string; file: string; args: string[] }
export type VerifyOutcome = { contained: boolean; reason?: string }
export type GroupKind = 'ordinary' | 'sharedOpenCode'
export type GroupMetadata = { role: string; paneId?: string; sessionId?: string; label?: string }
export type ExitInfo = { exitCode: number; signal?: number }

export interface ResourceControl {
  ensureAggregate(limits: ResourceLimitSet): Promise<AggregateGroup>
  beginLogicalGroup(kind: GroupKind, metadata: GroupMetadata, limits: ResourceLimitSet): Promise<LogicalGroup>
  reserveLaunchGroup(aggregateLimits: ResourceLimitSet, kind: GroupKind, metadata: GroupMetadata, leafLimits: ResourceLimitSet): Promise<LogicalGroup>
  wrapProcess(group: LogicalGroup, role: string, argv: string[]): ProcessLaunch
  verifyProcess(group: LogicalGroup, launch: ProcessLaunch, pid: number): Promise<VerifyOutcome>
  runningCount(): number
  hasTrackedGroups(): boolean
  abandonLogicalGroup(group: LogicalGroup): Promise<void>
  freezeGroup(group: LogicalGroup): Promise<void>
  thawGroup(group: LogicalGroup): Promise<void>
  stopGroup(group: LogicalGroup): Promise<void>
  releaseProcess(scope: string): Promise<void>
  dispose(): Promise<void>
}

export interface ResourcePressureControl extends ResourceControl {
  readSnapshots(groupIds: readonly string[]): Promise<Map<string, MemorySnapshot>>
  classifyExit(groupId: string, exit: ExitInfo): Promise<{ classified: true; oom: boolean }>
}

export type CompactLaunchIntent =
  | { kind: 'terminal'; paneId: string; requestId: string; mode: string; cwd?: string; resumeSessionId?: string }
  | { kind: 'fresh'; paneId: string; requestId: string; sessionType: 'freshclaude' | 'freshcodex' | 'kilroy' | 'freshopencode'; provider: 'claude' | 'codex' | 'opencode'; cwd?: string; resumeSessionId?: string }

export type ResourceMember = { paneId: string; label: string; sessionId?: string }
export type ResourceGroupSnapshot = {
  id: string
  kind: GroupKind
  label: string
  phase: 'idle' | 'warning' | 'paused' | 'stopped'
  deadlineAt?: number
  stopReason?: 'policy' | 'oom' | 'user'
  members: ResourceMember[]
}
export type ResourceContainmentSnapshot = { runningCount: number; groups: ResourceGroupSnapshot[] }
export type ResourceContainmentUpdated = {
  type: 'resource.containment.updated'
  pending: Array<{ id: string; paneId: string }>
  snapshot: ResourceContainmentSnapshot
}
export type PendingChoice = 'launch_uncontained' | 'disable_containment' | 'close_pane'
export type GroupAction = 'pause_now' | 'cancel_countdown' | 'resume' | 'stop_agent' | 'restart_agent' | 'close_pane'
export type WarningSource = { kind: 'leaf' | 'aggregate'; stateId: string }
export type RuntimeGroup = ResourceGroupSnapshot & {
  logicalGroup: LogicalGroup
  launchIntent: CompactLaunchIntent
  pressure: PressureState
  warningSource?: WarningSource
  respawnSuppressed: boolean
}
export type ActionResult =
  | { status: 200; body: ResourceContainmentUpdated }
  | { status: 404; body: { code: 'RESOURCE_GROUP_NOT_FOUND' } }
  | { status: 409; body: { code: 'STALE_RESOURCE_PHASE' } }

export function projectRuntimeGroup(group: RuntimeGroup): ResourceGroupSnapshot {
  return {
    id: group.id,
    kind: group.kind,
    label: group.label,
    phase: group.phase,
    ...(group.deadlineAt === undefined ? {} : { deadlineAt: group.deadlineAt }),
    ...(group.stopReason === undefined ? {} : { stopReason: group.stopReason }),
    members: group.members.map((member) => ({ ...member })),
  }
}
```

```rust
#[async_trait::async_trait]
pub trait ResourceControl: Send + Sync {
    async fn ensure_aggregate(&self, limits: &ResourceLimitSet) -> Result<AggregateGroup, ResourceControlError>;
    async fn begin_logical_group(&self, kind: GroupKind, metadata: GroupMetadata, limits: &ResourceLimitSet) -> Result<LogicalGroup, ResourceControlError>;
    async fn reserve_launch_group(&self, aggregate: &ResourceLimitSet, kind: GroupKind, metadata: GroupMetadata, leaf: &ResourceLimitSet) -> Result<LogicalGroup, ResourceControlError>;
    fn wrap_process(&self, group: &LogicalGroup, role: &str, argv: &[String]) -> Result<ProcessLaunch, ResourceControlError>;
    async fn verify_process(&self, group: &LogicalGroup, launch: &ProcessLaunch, pid: u32) -> Result<VerifyOutcome, ResourceControlError>;
    fn running_count(&self) -> usize;
    fn has_tracked_groups(&self) -> bool;
    async fn abandon_logical_group(&self, group: &LogicalGroup) -> Result<(), ResourceControlError>;
    async fn freeze_group(&self, group: &LogicalGroup) -> Result<(), ResourceControlError>;
    async fn thaw_group(&self, group: &LogicalGroup) -> Result<(), ResourceControlError>;
    async fn stop_group(&self, group: &LogicalGroup) -> Result<(), ResourceControlError>;
    async fn release_process(&self, scope: &str) -> Result<(), ResourceControlError>;
    async fn dispose(&self) -> Result<(), ResourceControlError>;
}

#[async_trait::async_trait]
pub trait ResourcePressureControl: ResourceControl {
    async fn read_snapshots(&self, group_ids: &[String]) -> Result<std::collections::HashMap<String, MemorySnapshot>, ResourceControlError>;
    async fn classify_exit(&self, group_id: &str, exit: ExitInfo) -> Result<ExitClassification, ResourceControlError>;
}

#[derive(Debug, thiserror::Error)]
pub enum ResourceControlError {
    #[error("invalid systemd unit token")]
    InvalidUnitToken,
    #[error("resource containment is unsupported")]
    Unsupported,
    #[error("process is outside the allocated scope")]
    PidOutsideScope,
    #[error("cgroup property mismatch: {0}")]
    PropertyMismatch(String),
    #[error("resource limits cannot change while groups are tracked")]
    LimitsActive,
    #[error("resource-control I/O failed: {0}")]
    Io(String),
}
```

## Execution Preflight

- [ ] Run `git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment status --short --branch` and verify the branch is `the-usual/coding-agent-resource-containment` with no worktree changes.
- [ ] Run `npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:status`; expected output reports no active holder, otherwise wait without terminating it.
- [ ] Run `FRESHELL_TEST_SUMMARY="resource containment baseline" npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run check`; expected exit 0 and coordinated PASS summary.
- [ ] Run `cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml --workspace`; expected exit 0.
- [ ] Stop before Task 1 if either baseline fails. Record the exact command and failing test; do not edit around a red baseline.

---
## Phase 1 — settings contract, calculator, and persistence

### Task 1: TypeScript Schema, Calculator, and Settings Wiring

**User stories / highest-level proof:** US-02 and US-03 begin here. The highest-level proof lands in Task 15; this task proves the canonical values and rejects a partial numeric object before any server handler runs.

**Files:**
- Create: `shared/resource-limits.ts`
- Modify: `shared/settings.ts:149-193,744-884,1038-1310,1406-1446`
- Create: `test/unit/shared/resource-limits.test.ts`
- Modify: `test/unit/shared/settings.test.ts`

**Interfaces:**
- Consumes: no new feature interface.
- Produces: `ResourceLimitSet`, `CodingAgentResourceLimits`, `EffectiveResourceCapacity`, `calculateInitialResourceLimits(capacity): CodingAgentResourceLimits`, `validateResourceLimits(limits): {valid:boolean; errors:string[]}`, `ResourceLimitSetSchema`, `CodingAgentResourceLimitsSchema`, and `CodingAgentResourceLimitsPatchSchema`.

- [ ] **Step 1: Create the failing calculator/validator test (2–5 min).**

Create `test/unit/shared/resource-limits.test.ts` with this complete content:

```ts
import { describe, expect, it } from 'vitest'
import {
  calculateInitialResourceLimits,
  validateResourceLimits,
} from '../../../shared/resource-limits.js'

const GIB = 1024 ** 3
const MIB = 1024 ** 2

describe('calculateInitialResourceLimits', () => {
  it('derives all three exact sets and rounds at each boundary', () => {
    const result = calculateInitialResourceLimits({
      cpuQuotaMillis: 16_000,
      memoryBytes: 48 * GIB,
      swapBytes: 16 * GIB,
      tasksMax: 8192,
    })
    expect(result).toEqual({
      enabled: true,
      allAgents: {
        cpuQuotaMillis: 8000,
        memoryHighBytes: Math.floor((32 * GIB * 4 / 5) / MIB) * MIB,
        memoryMaxBytes: 32 * GIB,
        swapMaxBytes: 4 * GIB,
        tasksMax: 6144,
      },
      eachAgent: {
        cpuQuotaMillis: 4000,
        memoryHighBytes: Math.floor((16 * GIB * 4 / 5) / MIB) * MIB,
        memoryMaxBytes: 16 * GIB,
        swapMaxBytes: 2 * GIB,
        tasksMax: 3072,
      },
      sharedOpenCode: {
        cpuQuotaMillis: 7200,
        memoryHighBytes: Math.floor((Math.floor((32 * GIB * 9 / 10) / MIB) * MIB * 4 / 5) / MIB) * MIB,
        memoryMaxBytes: Math.floor((32 * GIB * 9 / 10) / MIB) * MIB,
        swapMaxBytes: Math.floor((4 * GIB * 9 / 10) / MIB) * MIB,
        tasksMax: 5529,
      },
    })
  })

  it('uses each missing fallback independently and preserves zero swap', () => {
    const fallback = calculateInitialResourceLimits({})
    expect(fallback.allAgents.cpuQuotaMillis).toBe(1000)
    expect(fallback.allAgents.memoryMaxBytes).toBe(Math.floor((8 * GIB / 3) / MIB) * MIB)
    expect(fallback.allAgents.swapMaxBytes).toBe(128 * MIB)
    expect(fallback.allAgents.tasksMax).toBe(384)
    expect(calculateInitialResourceLimits({ swapBytes: 0 }).allAgents.swapMaxBytes).toBe(0)
  })
})

describe('validateResourceLimits', () => {
  it('rejects unsafe, noninteger, nonpositive, high/max, and child/aggregate violations', () => {
    const base = calculateInitialResourceLimits({
      cpuQuotaMillis: 16_000,
      memoryBytes: 48 * GIB,
      swapBytes: 16 * GIB,
      tasksMax: 8192,
    })
    const bad = structuredClone(base)
    bad.allAgents.memoryHighBytes = bad.allAgents.memoryMaxBytes
    bad.eachAgent.cpuQuotaMillis = bad.allAgents.cpuQuotaMillis + 1
    bad.sharedOpenCode.tasksMax = Number.MAX_SAFE_INTEGER + 1
    const result = validateResourceLimits(bad)
    expect(result.valid).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([
      'allAgents.memoryHighBytes must be less than allAgents.memoryMaxBytes',
      'eachAgent.cpuQuotaMillis must be less than or equal to allAgents.cpuQuotaMillis',
      'sharedOpenCode.tasksMax must be a finite safe integer no greater than 4294967295',
    ]))
  })
})
```

- [ ] **Step 2: Run the shared test and observe RED (2–5 min).**

Run:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/shared/resource-limits.test.ts \
  --config config/vitest/vitest.config.ts --run
```

Expected: FAIL during module resolution with `Cannot find module '../../../shared/resource-limits.js'`; zero tests pass for this file.

- [ ] **Step 3: Add the complete canonical TypeScript implementation (2–5 min).**

Create `shared/resource-limits.ts`:

```ts
import { z } from 'zod'

export type ResourceLimitSet = {
  cpuQuotaMillis: number
  memoryHighBytes: number
  memoryMaxBytes: number
  swapMaxBytes: number
  tasksMax: number
}

export type CodingAgentResourceLimits = {
  enabled: boolean
  allAgents: ResourceLimitSet
  eachAgent: ResourceLimitSet
  sharedOpenCode: ResourceLimitSet
}

export type EffectiveResourceCapacity = {
  cpuQuotaMillis?: number
  memoryBytes?: number
  swapBytes?: number
  tasksMax?: number
}

export type ResourceLimitsValidation = { valid: boolean; errors: string[] }

const MIB = 1024 ** 2
const GIB = 1024 ** 3
const U32_MAX = 4_294_967_295
const MAX_EXACT_BYTES = Number.MAX_SAFE_INTEGER
const FALLBACK: Required<EffectiveResourceCapacity> = {
  cpuQuotaMillis: 2000,
  memoryBytes: 4 * GIB,
  swapBytes: 512 * MIB,
  tasksMax: 512,
}
const SET_NAMES = ['allAgents', 'eachAgent', 'sharedOpenCode'] as const
const FIELDS = ['cpuQuotaMillis', 'memoryHighBytes', 'memoryMaxBytes', 'swapMaxBytes', 'tasksMax'] as const

function floorTo(value: number, quantum: number): number {
  return Math.floor(value / quantum) * quantum
}

function hardSet(base: ResourceLimitSet, numerator: number, denominator: number): ResourceLimitSet {
  const memoryMaxBytes = floorTo(base.memoryMaxBytes * numerator / denominator, MIB)
  return {
    cpuQuotaMillis: floorTo(base.cpuQuotaMillis * numerator / denominator, 100),
    memoryHighBytes: floorTo(memoryMaxBytes * 4 / 5, MIB),
    memoryMaxBytes,
    swapMaxBytes: floorTo(base.swapMaxBytes * numerator / denominator, MIB),
    tasksMax: Math.floor(base.tasksMax * numerator / denominator),
  }
}

export function calculateInitialResourceLimits(capacity: EffectiveResourceCapacity): CodingAgentResourceLimits {
  const cpu = capacity.cpuQuotaMillis ?? FALLBACK.cpuQuotaMillis
  const memory = capacity.memoryBytes ?? FALLBACK.memoryBytes
  const swap = capacity.swapBytes ?? FALLBACK.swapBytes
  const tasks = capacity.tasksMax ?? FALLBACK.tasksMax
  const memoryMaxBytes = floorTo(memory * 2 / 3, MIB)
  const allAgents: ResourceLimitSet = {
    cpuQuotaMillis: floorTo(cpu / 2, 100),
    memoryHighBytes: floorTo(memoryMaxBytes * 4 / 5, MIB),
    memoryMaxBytes,
    swapMaxBytes: floorTo(Math.min(swap / 4, memoryMaxBytes / 4), MIB),
    tasksMax: Math.floor(tasks * 3 / 4),
  }
  return {
    enabled: true,
    allAgents,
    eachAgent: hardSet(allAgents, 1, 2),
    sharedOpenCode: hardSet(allAgents, 9, 10),
  }
}

function fieldMaximum(field: typeof FIELDS[number]): number {
  return field === 'cpuQuotaMillis' || field === 'tasksMax' ? U32_MAX : MAX_EXACT_BYTES
}

export function validateResourceLimits(limits: CodingAgentResourceLimits): ResourceLimitsValidation {
  const errors: string[] = []
  for (const setName of SET_NAMES) {
    const set = limits[setName]
    for (const field of FIELDS) {
      const value = set[field]
      if (!Number.isSafeInteger(value) || value > fieldMaximum(field)) {
        errors.push(`${setName}.${field} must be a finite safe integer no greater than ${fieldMaximum(field)}`)
      } else if (field === 'swapMaxBytes' ? value < 0 : value <= 0) {
        errors.push(`${setName}.${field} must be ${field === 'swapMaxBytes' ? 'nonnegative' : 'positive'}`)
      }
    }
    if (set.memoryHighBytes >= set.memoryMaxBytes) {
      errors.push(`${setName}.memoryHighBytes must be less than ${setName}.memoryMaxBytes`)
    }
  }
  for (const childName of ['eachAgent', 'sharedOpenCode'] as const) {
    for (const field of FIELDS) {
      if (limits[childName][field] > limits.allAgents[field]) {
        errors.push(`${childName}.${field} must be less than or equal to allAgents.${field}`)
      }
    }
  }
  return { valid: errors.length === 0, errors }
}

const exactInteger = (maximum: number) => z.number().int().nonnegative().max(maximum)

export const ResourceLimitSetSchema = z.object({
  cpuQuotaMillis: exactInteger(U32_MAX).positive(),
  memoryHighBytes: exactInteger(MAX_EXACT_BYTES).positive(),
  memoryMaxBytes: exactInteger(MAX_EXACT_BYTES).positive(),
  swapMaxBytes: exactInteger(MAX_EXACT_BYTES),
  tasksMax: exactInteger(U32_MAX).positive(),
}).strict()

export const CodingAgentResourceLimitsSchema = z.object({
  enabled: z.boolean(),
  allAgents: ResourceLimitSetSchema,
  eachAgent: ResourceLimitSetSchema,
  sharedOpenCode: ResourceLimitSetSchema,
}).strict().superRefine((value, ctx) => {
  for (const message of validateResourceLimits(value).errors) {
    ctx.addIssue({ code: 'custom', message })
  }
})

export const CodingAgentResourceLimitsPatchSchema = z.union([
  CodingAgentResourceLimitsSchema,
  z.object({ enabled: z.boolean() }).strict(),
])
```

- [ ] **Step 4: Wire the strict settings paths with exact declarations (2–5 min).**

Apply these patch-shaped edits to `shared/settings.ts`:

```diff
+import type { CodingAgentResourceLimits } from './resource-limits.js'
+import {
+  CodingAgentResourceLimitsPatchSchema,
+  CodingAgentResourceLimitsSchema,
+} from './resource-limits.js'
@@
 export type SettingsSafety = {
   autoKillIdleMinutes: number
+  codingAgentResourceLimits?: CodingAgentResourceLimits
 }
@@
 const SettingsSafetySchema = z.object({
   autoKillIdleMinutes: z.number().int(),
+  codingAgentResourceLimits: CodingAgentResourceLimitsSchema.optional(),
 }).strict()
@@
 const SettingsSafetyPatchSchema = z.object({
   autoKillIdleMinutes: z.number().int().optional(),
+  codingAgentResourceLimits: CodingAgentResourceLimitsPatchSchema.optional(),
 }).strict()
```

In the existing safety sanitizer, merge, compose, and local-strip object literals, add these exact members without adding a default:

```ts
codingAgentResourceLimits:
  source.codingAgentResourceLimits === undefined
    ? undefined
    : structuredClone(source.codingAgentResourceLimits),
```

For merge, use presence rather than truthiness so shorthand remains atomic:

```ts
if (Object.prototype.hasOwnProperty.call(patch.safety ?? {}, 'codingAgentResourceLimits')) {
  merged.safety.codingAgentResourceLimits = structuredClone(
    patch.safety?.codingAgentResourceLimits as CodingAgentResourceLimits,
  )
}
```

- [ ] **Step 5: Add strict full/patch/absence tests (2–5 min).**

Append to `test/unit/shared/settings.test.ts`:

```ts
it('accepts full resource limits, accepts enable-only PATCH, rejects partial numeric PATCH, and preserves absence', () => {
  const full = calculateInitialResourceLimits({
    cpuQuotaMillis: 16_000,
    memoryBytes: 48 * 1024 ** 3,
    swapBytes: 16 * 1024 ** 3,
    tasksMax: 8192,
  })
  const settings = createDefaultServerSettings()
  expect(buildServerSettingsSchema().safeParse({
    ...settings,
    safety: { ...settings.safety, codingAgentResourceLimits: full },
  }).success).toBe(true)
  const patch = buildServerSettingsPatchSchema()
  expect(patch.safeParse({ safety: { codingAgentResourceLimits: full } }).success).toBe(true)
  expect(patch.safeParse({ safety: { codingAgentResourceLimits: { enabled: true } } }).success).toBe(true)
  expect(patch.safeParse({
    safety: { codingAgentResourceLimits: { allAgents: { cpuQuotaMillis: 100 } } },
  }).success).toBe(false)
  expect(createDefaultServerSettings().safety.codingAgentResourceLimits).toBeUndefined()
})
```

Add imports using NodeNext suffixes:

```ts
import { calculateInitialResourceLimits } from '../../../shared/resource-limits.js'
```

- [ ] **Step 6: Run the corrected shared command and observe GREEN (2–5 min).**

Run:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/shared/resource-limits.test.ts \
  test/unit/shared/settings.test.ts \
  --config config/vitest/vitest.config.ts --run
```

Expected: both files PASS, zero failures. This is corrected test evidence: the server Vitest config excludes `test/unit/shared/**`.

- [ ] **Step 7: Typecheck and commit the focused contract (2–5 min).**

Run:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run typecheck
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add \
  shared/resource-limits.ts shared/settings.ts \
  test/unit/shared/resource-limits.test.ts test/unit/shared/settings.test.ts
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment diff --cached --check
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit \
  -m "feat(resource-limits): add TS contract, calculator, and Zod wiring" \
  -m "Generated with Amplifier: https://github.com/microsoft/amplifier" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

Expected: typecheck exits 0; commit contains only the four listed files.

### Task 2: Node Config Store and Settings Router Integration

**User stories / highest-level proof:** US-01, US-03, and US-04. The real HTTP test proves one-time calculation, retained values, active-lock behavior, and persist-before-broadcast.

**Files:**
- Modify: `server/config-store.ts:420-485`
- Modify: `server/settings-router.ts:95-155`
- Create: `test/unit/server/resource-control-settings.test.ts`
- Modify: `test/integration/server/settings-api.test.ts`

**Interfaces:**
- Consumes: Task 1 calculator/validator/types; injected `hasTrackedGroups(): boolean`, capability result, and existing `ConfigStore.patchSettings` atomic writer.
- Produces: `applyResourceLimitsPatch(patch, deps): Promise<ResourceLimitsPatchResult>` and real `/api/settings` behavior for 200/400/409/500 outcomes.

- [ ] **Step 1: Create the failing pure service tests (2–5 min).**

Create `test/unit/server/resource-control-settings.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { calculateInitialResourceLimits } from '../../../shared/resource-limits.js'
import { applyResourceLimitsPatch } from '../../../server/settings-router.js'

const capacity = {
  cpuQuotaMillis: 16_000,
  memoryBytes: 48 * 1024 ** 3,
  swapBytes: 16 * 1024 ** 3,
  tasksMax: 8192,
}
const limits = () => calculateInitialResourceLimits(capacity)

describe('applyResourceLimitsPatch', () => {
  it('calculates exactly once on first enable and never on disable/re-enable', async () => {
    const calculate = vi.fn(calculateInitialResourceLimits)
    const persist = vi.fn().mockResolvedValue(undefined)
    const first = await applyResourceLimitsPatch({ enabled: true }, {
      current: undefined,
      hasTrackedGroups: () => false,
      capability: { available: true, effective: capacity },
      calculate,
      persist,
    })
    const disabled = await applyResourceLimitsPatch({ enabled: false }, {
      current: first.body,
      hasTrackedGroups: () => true,
      capability: { available: true, effective: capacity },
      calculate,
      persist,
    })
    const enabled = await applyResourceLimitsPatch({ enabled: true }, {
      current: disabled.body,
      hasTrackedGroups: () => false,
      capability: { available: true, effective: capacity },
      calculate,
      persist,
    })
    expect(calculate).toHaveBeenCalledTimes(1)
    expect(enabled.body).toEqual(first.body)
    expect(persist).toHaveBeenCalledTimes(3)
  })

  it('uses hasTrackedGroups rather than runningCount for numeric edits', async () => {
    const persist = vi.fn()
    const result = await applyResourceLimitsPatch(limits(), {
      current: limits(),
      hasTrackedGroups: () => true,
      capability: { available: true, effective: capacity },
      calculate: vi.fn(),
      persist,
    })
    expect(result).toEqual({ status: 409, body: { code: 'RESOURCE_LIMITS_ACTIVE' } })
    expect(persist).not.toHaveBeenCalled()
  })

  it('returns unavailable, validation, and persistence errors without publishing', async () => {
    const noCapability = await applyResourceLimitsPatch({ enabled: true }, {
      current: undefined,
      hasTrackedGroups: () => false,
      capability: { available: false, unavailableReason: 'Requires Linux cgroup v2 and a systemd user session.', effective: {} },
      calculate: vi.fn(),
      persist: vi.fn(),
    })
    expect(noCapability.status).toBe(409)
    expect(noCapability.body.code).toBe('RESOURCE_LIMITS_UNAVAILABLE')

    const invalid = limits()
    invalid.eachAgent.cpuQuotaMillis = invalid.allAgents.cpuQuotaMillis + 1
    expect((await applyResourceLimitsPatch(invalid, {
      current: limits(), hasTrackedGroups: () => false,
      capability: { available: true, effective: capacity }, calculate: vi.fn(), persist: vi.fn(),
    })).status).toBe(400)

    expect((await applyResourceLimitsPatch(limits(), {
      current: limits(), hasTrackedGroups: () => false,
      capability: { available: true, effective: capacity }, calculate: vi.fn(),
      persist: vi.fn().mockRejectedValue(new Error('disk full')),
    }))).toEqual({ status: 500, body: { code: 'PERSIST_FAILED' } })
  })
})
```

- [ ] **Step 2: Run the service test and observe RED (2–5 min).**

Run:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/resource-control-settings.test.ts \
  --config config/vitest/vitest.server.config.ts --run
```

Expected: FAIL during server build with `Module 'server/settings-router.js' has no exported member 'applyResourceLimitsPatch'`.

- [ ] **Step 3: Add the exact pure settings service (2–5 min).**

Insert in `server/settings-router.ts` with Task 1 imports:

```ts
import type {
  CodingAgentResourceLimits,
  EffectiveResourceCapacity,
} from '../shared/resource-limits.js'
import {
  calculateInitialResourceLimits,
  validateResourceLimits,
} from '../shared/resource-limits.js'

export type ResourceLimitsCapability = {
  available: boolean
  unavailableReason?: string
  effective: EffectiveResourceCapacity
}

export type ResourceLimitsPatch = CodingAgentResourceLimits | { enabled: boolean }
export type ResourceLimitsPatchResult =
  | { status: 200; body: CodingAgentResourceLimits }
  | { status: 400 | 409 | 500; body: { code: 'INVALID_RESOURCE_LIMITS' | 'RESOURCE_LIMITS_ACTIVE' | 'RESOURCE_LIMITS_UNAVAILABLE' | 'PERSIST_FAILED'; errors?: string[] } }

export type ResourceLimitsPatchDeps = {
  current: CodingAgentResourceLimits | undefined
  hasTrackedGroups: () => boolean
  capability: ResourceLimitsCapability
  calculate: (capacity: EffectiveResourceCapacity) => CodingAgentResourceLimits
  persist: (limits: CodingAgentResourceLimits) => Promise<void>
}

function enableOnly(patch: ResourceLimitsPatch): patch is { enabled: boolean } {
  return Object.keys(patch).length === 1 && Object.prototype.hasOwnProperty.call(patch, 'enabled')
}

export async function applyResourceLimitsPatch(
  patch: ResourceLimitsPatch,
  deps: ResourceLimitsPatchDeps,
): Promise<ResourceLimitsPatchResult> {
  let next: CodingAgentResourceLimits
  if (enableOnly(patch)) {
    if (deps.current) {
      next = { ...structuredClone(deps.current), enabled: patch.enabled }
    } else {
      if (!patch.enabled || !deps.capability.available) {
        return { status: 409, body: { code: 'RESOURCE_LIMITS_UNAVAILABLE' } }
      }
      next = deps.calculate(deps.capability.effective)
      const calculated = validateResourceLimits(next)
      if (!calculated.valid) {
        return { status: 409, body: { code: 'RESOURCE_LIMITS_UNAVAILABLE', errors: calculated.errors } }
      }
    }
  } else {
    if (deps.hasTrackedGroups()) {
      return { status: 409, body: { code: 'RESOURCE_LIMITS_ACTIVE' } }
    }
    const validated = validateResourceLimits(patch)
    if (!validated.valid) {
      return { status: 400, body: { code: 'INVALID_RESOURCE_LIMITS', errors: validated.errors } }
    }
    next = structuredClone(patch)
  }
  try {
    await deps.persist(next)
  } catch {
    return { status: 500, body: { code: 'PERSIST_FAILED' } }
  }
  return { status: 200, body: next }
}
```

- [ ] **Step 4: Delegate the nested patch through the existing atomic writer (2–5 min).**

Extend `SettingsRouterDeps` with these exact dependencies:

```ts
resourceCapability: Promise<ResourceLimitsCapability>
resourceControl?: Pick<ResourceControl, 'hasTrackedGroups'>
```

Replace the current single `const updated = await configStore.patchSettings(patch)` statement with this block. It persists a mixed settings patch exactly once, replaces shorthand with the complete calculated object before that write, and returns before every live mutation on failure:

```ts
let updated: Awaited<ReturnType<typeof configStore.patchSettings>>
const limitsPatch = patch.safety?.codingAgentResourceLimits
if (limitsPatch !== undefined) {
  const current = (await configStore.getSettings()).safety.codingAgentResourceLimits
  let persistedSettings: Awaited<ReturnType<typeof configStore.patchSettings>> | undefined
  const result = await applyResourceLimitsPatch(limitsPatch, {
    current,
    hasTrackedGroups: () => resourceControl?.hasTrackedGroups() ?? false,
    capability: await resourceCapability,
    calculate: calculateInitialResourceLimits,
    persist: async (limits) => {
      const completePatch = structuredClone(patch)
      completePatch.safety = {
        ...completePatch.safety,
        codingAgentResourceLimits: limits,
      }
      persistedSettings = await configStore.patchSettings(completePatch)
    },
  })
  if (result.status !== 200) {
    res.status(result.status).json(result.body)
    return
  }
  if (!persistedSettings) {
    res.status(500).json({ code: 'PERSIST_FAILED' })
    return
  }
  updated = persistedSettings
} else {
  updated = await configStore.patchSettings(patch)
}
```

The existing statements after that point remain ordered as `registry.setSettings(updated)`, AI/debug live application, `wsHandler.broadcast`, index refresh, and `res.json(updated)`. Do not re-read or persist a second time. Do not mutate ConfigStore cache outside `patchSettings`; its temp-write/rename remains the only persistence path.

- [ ] **Step 5: Add real HTTP ordering assertions (2–5 min).**

Append to `test/integration/server/settings-api.test.ts` using its existing temp home, real `ConfigStore`, auth helper, registry spy, and broadcast spy:

```ts
it('persists a complete first-enable object and leaves old state/broadcast untouched on write failure', async () => {
  const enable = await request(app)
    .patch('/api/settings')
    .set('Authorization', `Bearer ${token}`)
    .send({ safety: { codingAgentResourceLimits: { enabled: true } } })
    .expect(200)
  expect(Object.keys(enable.body.safety.codingAgentResourceLimits.allAgents)).toHaveLength(5)
  expect(Object.keys(enable.body.safety.codingAgentResourceLimits.eachAgent)).toHaveLength(5)
  expect(Object.keys(enable.body.safety.codingAgentResourceLimits.sharedOpenCode)).toHaveLength(5)
  const diskBefore = await readFile(configPath, 'utf8')
  const broadcastsBefore = broadcast.mock.calls.length
  persistFailure.enable()
  await request(app)
    .patch('/api/settings')
    .set('Authorization', `Bearer ${token}`)
    .send({
      safety: {
        codingAgentResourceLimits: {
          ...enable.body.safety.codingAgentResourceLimits,
          allAgents: {
            ...enable.body.safety.codingAgentResourceLimits.allAgents,
            cpuQuotaMillis: 1000,
          },
        },
      },
    })
    .expect(500, { code: 'PERSIST_FAILED' })
  expect(await readFile(configPath, 'utf8')).toBe(diskBefore)
  expect(broadcast).toHaveBeenCalledTimes(broadcastsBefore)
})
```

Define the injected failure toggle in the test setup as an exact wrapper around the router's `persist` dependency:

```ts
const persistFailure = {
  active: false,
  enable() { this.active = true },
}
```

- [ ] **Step 6: Run the corrected server command and observe GREEN (2–5 min).**

Run:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/resource-control-settings.test.ts \
  test/integration/server/settings-api.test.ts \
  --config config/vitest/vitest.server.config.ts --run
```

Expected: both files PASS, zero failures. This is the corrected evidence command; `npm run test:integration` does not include `test/integration/server/settings-api.test.ts`.

- [ ] **Step 7: Typecheck and commit the Node settings slice (2–5 min).**

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run typecheck
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add \
  server/config-store.ts server/settings-router.ts \
  test/unit/server/resource-control-settings.test.ts test/integration/server/settings-api.test.ts
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment diff --cached --check
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit \
  -m "feat(server): persist and gate coding-agent resource limits" \
  -m "Generated with Amplifier: https://github.com/microsoft/amplifier" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

Expected: typecheck exits 0; commit touches only Task 2 files.

### Task 3: Rust Protocol and Settings Store Parity

**User stories / highest-level proof:** US-01 through US-04 on the Rust backend. The store test proves exact one-time calculation and persist-before-live state.

**Files:**
- Create: `crates/freshell-protocol/src/resource_limits.rs`
- Modify: `crates/freshell-protocol/src/lib.rs`
- Modify: `crates/freshell-protocol/src/settings.rs:37-136`
- Modify: `crates/freshell-protocol/tests/roundtrip.rs`
- Modify: `crates/freshell-server/src/settings.rs:15-84`
- Modify: `crates/freshell-server/src/settings_store.rs:174-449,1761-1785,2087-2154`

**Interfaces:**
- Consumes: Task 1 JSON field names/formulas and Task 2 status semantics.
- Produces: Rust `ResourceLimitSet`, `CodingAgentResourceLimits`, `EffectiveResourceCapacity`, calculator/validator, optional `SettingsSafety` field, and `ResourceLimitsProvider = Arc<dyn Fn() -> Option<CodingAgentResourceLimits> + Send + Sync>` backed by a live synchronous cell.

- [ ] **Step 1: Add the failing Rust fixture and roundtrip (2–5 min).**

Create `crates/freshell-protocol/src/resource_limits.rs` initially with the test module below, and add these exact exports to `lib.rs`:

```rust
pub mod resource_limits;
pub use resource_limits::{
    calculate_initial_resource_limits, validate_resource_limits,
    CodingAgentResourceLimits, EffectiveResourceCapacity, ResourceLimitSet,
};
```

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_the_exact_typescript_fixture() {
        let result = calculate_initial_resource_limits(EffectiveResourceCapacity {
            cpu_quota_millis: Some(16_000),
            memory_bytes: Some(48 * 1024u64.pow(3)),
            swap_bytes: Some(16 * 1024u64.pow(3)),
            tasks_max: Some(8192),
        });
        assert_eq!(result.all_agents.cpu_quota_millis, 8000);
        assert_eq!(result.all_agents.memory_max_bytes, 32 * 1024u64.pow(3));
        assert_eq!(result.all_agents.swap_max_bytes, 4 * 1024u64.pow(3));
        assert_eq!(result.each_agent.cpu_quota_millis, 4000);
        assert_eq!(result.shared_open_code.cpu_quota_millis, 7200);
        assert!(validate_resource_limits(&result).is_ok());
    }

    #[test]
    fn preserves_zero_swap_and_rejects_values_not_exact_in_json() {
        let zero = calculate_initial_resource_limits(EffectiveResourceCapacity {
            swap_bytes: Some(0),
            ..Default::default()
        });
        assert_eq!(zero.all_agents.swap_max_bytes, 0);
        let mut invalid = zero;
        invalid.all_agents.memory_max_bytes = 9_007_199_254_740_992;
        assert!(validate_resource_limits(&invalid).is_err());
    }
}
```

- [ ] **Step 2: Run the fixture and observe RED (2–5 min).**

```bash
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-protocol resource_limits::tests -- --nocapture
```

Expected: compile FAIL because the imported structs/functions are undefined.

- [ ] **Step 3: Add the complete Rust contract implementation (2–5 min).**

Place before the test module in `crates/freshell-protocol/src/resource_limits.rs`:

```rust
use serde::{Deserialize, Serialize};

const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;
const MAX_EXACT_JSON_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceLimitSet {
    pub cpu_quota_millis: u32,
    pub memory_high_bytes: u64,
    pub memory_max_bytes: u64,
    pub swap_max_bytes: u64,
    pub tasks_max: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodingAgentResourceLimits {
    pub enabled: bool,
    pub all_agents: ResourceLimitSet,
    pub each_agent: ResourceLimitSet,
    pub shared_open_code: ResourceLimitSet,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EffectiveResourceCapacity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_quota_millis: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swap_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tasks_max: Option<u32>,
}

fn floor_to(value: u64, quantum: u64) -> u64 { value / quantum * quantum }
fn cpu(value: u64) -> u32 { (value / 100 * 100) as u32 }

fn child(base: &ResourceLimitSet, numerator: u64, denominator: u64) -> ResourceLimitSet {
    let memory_max_bytes = floor_to(base.memory_max_bytes * numerator / denominator, MIB);
    ResourceLimitSet {
        cpu_quota_millis: cpu(base.cpu_quota_millis as u64 * numerator / denominator),
        memory_high_bytes: floor_to(memory_max_bytes * 4 / 5, MIB),
        memory_max_bytes,
        swap_max_bytes: floor_to(base.swap_max_bytes * numerator / denominator, MIB),
        tasks_max: (base.tasks_max as u64 * numerator / denominator) as u32,
    }
}

pub fn calculate_initial_resource_limits(capacity: EffectiveResourceCapacity) -> CodingAgentResourceLimits {
    let cpu_capacity = capacity.cpu_quota_millis.unwrap_or(2000) as u64;
    let memory = capacity.memory_bytes.unwrap_or(4 * GIB);
    let swap = capacity.swap_bytes.unwrap_or(512 * MIB);
    let tasks = capacity.tasks_max.unwrap_or(512) as u64;
    let memory_max_bytes = floor_to(memory * 2 / 3, MIB);
    let all_agents = ResourceLimitSet {
        cpu_quota_millis: cpu(cpu_capacity / 2),
        memory_high_bytes: floor_to(memory_max_bytes * 4 / 5, MIB),
        memory_max_bytes,
        swap_max_bytes: floor_to(std::cmp::min(swap / 4, memory_max_bytes / 4), MIB),
        tasks_max: (tasks * 3 / 4) as u32,
    };
    CodingAgentResourceLimits {
        enabled: true,
        each_agent: child(&all_agents, 1, 2),
        shared_open_code: child(&all_agents, 9, 10),
        all_agents,
    }
}

pub fn validate_resource_limits(value: &CodingAgentResourceLimits) -> Result<(), Vec<String>> {
    let mut errors = Vec::new();
    let sets = [
        ("allAgents", &value.all_agents),
        ("eachAgent", &value.each_agent),
        ("sharedOpenCode", &value.shared_open_code),
    ];
    for (name, set) in sets {
        if set.cpu_quota_millis == 0 { errors.push(format!("{name}.cpuQuotaMillis must be positive")); }
        if set.memory_high_bytes == 0 { errors.push(format!("{name}.memoryHighBytes must be positive")); }
        if set.memory_max_bytes == 0 { errors.push(format!("{name}.memoryMaxBytes must be positive")); }
        if set.tasks_max == 0 { errors.push(format!("{name}.tasksMax must be positive")); }
        if set.memory_high_bytes >= set.memory_max_bytes {
            errors.push(format!("{name}.memoryHighBytes must be less than {name}.memoryMaxBytes"));
        }
        for (field, bytes) in [
            ("memoryHighBytes", set.memory_high_bytes),
            ("memoryMaxBytes", set.memory_max_bytes),
            ("swapMaxBytes", set.swap_max_bytes),
        ] {
            if bytes > MAX_EXACT_JSON_INTEGER {
                errors.push(format!("{name}.{field} exceeds the largest exact JSON integer"));
            }
        }
    }
    for (name, child) in [("eachAgent", &value.each_agent), ("sharedOpenCode", &value.shared_open_code)] {
        let pairs = [
            ("cpuQuotaMillis", child.cpu_quota_millis as u64, value.all_agents.cpu_quota_millis as u64),
            ("memoryHighBytes", child.memory_high_bytes, value.all_agents.memory_high_bytes),
            ("memoryMaxBytes", child.memory_max_bytes, value.all_agents.memory_max_bytes),
            ("swapMaxBytes", child.swap_max_bytes, value.all_agents.swap_max_bytes),
            ("tasksMax", child.tasks_max as u64, value.all_agents.tasks_max as u64),
        ];
        for (field, child_value, aggregate_value) in pairs {
            if child_value > aggregate_value {
                errors.push(format!("{name}.{field} must be less than or equal to allAgents.{field}"));
            }
        }
    }
    if errors.is_empty() { Ok(()) } else { Err(errors) }
}
```

- [ ] **Step 4: Wire the closed Rust settings tree and live provider (2–5 min).**

Apply to `crates/freshell-protocol/src/settings.rs`:

```diff
+use crate::resource_limits::CodingAgentResourceLimits;
@@
 pub struct SettingsSafety {
     pub auto_kill_idle_minutes: i64,
+    #[serde(default, skip_serializing_if = "Option::is_none")]
+    pub coding_agent_resource_limits: Option<CodingAgentResourceLimits>,
 }
```

Add `"codingAgentResourceLimits"` to the manual safety allowlist in `crates/freshell-server/src/settings_store.rs`, and validate a full value with:

```rust
if let Some(limits) = merged.safety.coding_agent_resource_limits.as_ref() {
    if let Err(errors) = freshell_protocol::validate_resource_limits(limits) {
        return Err((
            StatusCode::BAD_REQUEST,
            serde_json::json!({ "code": "INVALID_RESOURCE_LIMITS", "errors": errors }),
        ));
    }
}
```

Add a live synchronous cell to `SettingsStore`:

```rust
resource_limits: Arc<std::sync::RwLock<Option<freshell_protocol::CodingAgentResourceLimits>>>,
```

Initialize it in `SettingsStore::load` from the already-loaded tree:

```rust
resource_limits: Arc::new(std::sync::RwLock::new(
    settings.safety.coding_agent_resource_limits.clone(),
)),
```

The exact post-persist update is shown with `SettingsStore::patch` below; do not update this cell before the disk write succeeds.

Expose the provider used by later crates:

```rust
pub type ResourceLimitsProvider = Arc<
    dyn Fn() -> Option<freshell_protocol::CodingAgentResourceLimits> + Send + Sync,
>;

pub fn resource_limits_provider(&self) -> ResourceLimitsProvider {
    let cell = Arc::clone(&self.resource_limits);
    Arc::new(move || match cell.read() {
        Ok(value) => value.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    })
}
```

Add the missing default in `crates/freshell-server/src/settings.rs`:

```diff
 safety: SettingsSafety {
     auto_kill_idle_minutes: 15,
+    coding_agent_resource_limits: None,
 },
```

Add this complete first-enable/full-edit service to `impl SettingsStore`; Task 4 passes `Some(capability.effective.clone())` only when capability is available:

```rust
pub async fn patch_resource_limits<Calculate, HasTracked>(
    &self,
    patch: serde_json::Value,
    effective_capacity: Option<freshell_protocol::EffectiveResourceCapacity>,
    has_tracked_groups: HasTracked,
    calculate: Calculate,
) -> Result<freshell_protocol::CodingAgentResourceLimits, (StatusCode, serde_json::Value)>
where
    Calculate: FnOnce(freshell_protocol::EffectiveResourceCapacity)
        -> freshell_protocol::CodingAgentResourceLimits,
    HasTracked: Fn() -> bool,
{
    let object = patch.as_object().ok_or_else(|| (
        StatusCode::BAD_REQUEST,
        serde_json::json!({ "code": "INVALID_RESOURCE_LIMITS" }),
    ))?;
    let enabled_only = if object.len() == 1 {
        object.get("enabled").and_then(serde_json::Value::as_bool)
    } else {
        None
    };
    let current = self.get().await.safety.coding_agent_resource_limits;
    let next = if let Some(enabled) = enabled_only {
        match current {
            Some(mut value) => { value.enabled = enabled; value }
            None => {
                let capacity = effective_capacity.filter(|_| enabled).ok_or_else(|| (
                    StatusCode::CONFLICT,
                    serde_json::json!({ "code": "RESOURCE_LIMITS_UNAVAILABLE" }),
                ))?;
                let calculated = calculate(capacity);
                if let Err(errors) = freshell_protocol::validate_resource_limits(&calculated) {
                    return Err((
                        StatusCode::CONFLICT,
                        serde_json::json!({ "code": "RESOURCE_LIMITS_UNAVAILABLE", "errors": errors }),
                    ));
                }
                calculated
            }
        }
    } else {
        if has_tracked_groups() {
            return Err((
                StatusCode::CONFLICT,
                serde_json::json!({ "code": "RESOURCE_LIMITS_ACTIVE" }),
            ));
        }
        let value: freshell_protocol::CodingAgentResourceLimits =
            serde_json::from_value(patch).map_err(|error| (
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "code": "INVALID_RESOURCE_LIMITS", "errors": [error.to_string()] }),
            ))?;
        if let Err(errors) = freshell_protocol::validate_resource_limits(&value) {
            return Err((
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "code": "INVALID_RESOURCE_LIMITS", "errors": errors }),
            ));
        }
        value
    };
    let merged = self.patch(&serde_json::json!({
        "safety": { "codingAgentResourceLimits": next }
    })).await.map_err(|(status, body)| {
        if status == StatusCode::INTERNAL_SERVER_ERROR {
            (status, serde_json::json!({ "code": "PERSIST_FAILED" }))
        } else {
            (status, body)
        }
    })?;
    merged.safety.coding_agent_resource_limits.ok_or_else(|| (
        StatusCode::INTERNAL_SERVER_ERROR,
        serde_json::json!({ "code": "PERSIST_FAILED" }),
    ))
}
```

In generic `SettingsStore::patch`, keep the persisted-before-live order and update both live views only after `persist(&merged)` succeeds:

```rust
*self.inner.write().await = merged.clone();
match self.resource_limits.write() {
    Ok(mut value) => *value = merged.safety.coding_agent_resource_limits.clone(),
    Err(poisoned) => *poisoned.into_inner() = merged.safety.coding_agent_resource_limits.clone(),
}
Ok(merged)
```

- [ ] **Step 5: Add one-time calculation and persist-failure store tests (2–5 min).**

Inside the existing `settings_store.rs` test module add:

```rust
#[tokio::test]
async fn resource_limits_calculate_once_and_persist_before_live_cell() {
    let home = tempfile::tempdir().expect("temp home");
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let store = SettingsStore::load(Some(home.path()), Vec::new());
    let calculate = {
        let calls = Arc::clone(&calls);
        move |capacity| {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            freshell_protocol::calculate_initial_resource_limits(capacity)
        }
    };
    let first = store.patch_resource_limits(
        serde_json::json!({"enabled": true}),
        Some(supported_capacity()),
        || false,
        calculate,
    ).await.expect("first enable");
    let disabled = store.patch_resource_limits(
        serde_json::json!({"enabled": false}),
        Some(supported_capacity()),
        || true,
        freshell_protocol::calculate_initial_resource_limits,
    ).await.expect("disable");
    let enabled = store.patch_resource_limits(
        serde_json::json!({"enabled": true}),
        Some(supported_capacity()),
        || false,
        freshell_protocol::calculate_initial_resource_limits,
    ).await.expect("re-enable");
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(enabled.all_agents, first.all_agents);
    assert!(!disabled.enabled);
    assert!(enabled.enabled);
}

#[tokio::test]
async fn resource_limit_persist_failure_keeps_the_last_live_value() {
    let home = tempfile::tempdir().expect("temp home");
    let store = SettingsStore::load(Some(home.path()), Vec::new());
    let first = store.patch_resource_limits(
        serde_json::json!({"enabled": true}),
        Some(supported_capacity()),
        || false,
        freshell_protocol::calculate_initial_resource_limits,
    ).await.expect("first enable");
    let provider = store.resource_limits_provider();
    assert_eq!(provider(), Some(first.clone()));

    let config_dir = home.path().join(".freshell");
    std::fs::remove_dir_all(&config_dir).expect("remove writable config directory");
    std::fs::write(&config_dir, b"blocks directory creation").expect("install blocker file");
    let mut edited = first.clone();
    edited.all_agents.cpu_quota_millis -= 100;
    let error = store.patch_resource_limits(
        serde_json::to_value(edited).expect("serialize edited limits"),
        Some(supported_capacity()),
        || false,
        freshell_protocol::calculate_initial_resource_limits,
    ).await.expect_err("blocked config directory must fail persistence");
    assert_eq!(error.0, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(error.1["code"], "PERSIST_FAILED");
    assert_eq!(provider(), Some(first));
}
```

Define the exact fixture in the same test module:

```rust
fn supported_capacity() -> freshell_protocol::EffectiveResourceCapacity {
    freshell_protocol::EffectiveResourceCapacity {
        cpu_quota_millis: Some(16_000),
        memory_bytes: Some(48 * 1024u64.pow(3)),
        swap_bytes: Some(16 * 1024u64.pow(3)),
        tasks_max: Some(8192),
    }
}
```

- [ ] **Step 6: Run Rust and cross-language fixtures and observe GREEN (2–5 min).**

```bash
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-protocol resource_limits
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-server settings_store
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/shared/resource-limits.test.ts \
  --config config/vitest/vitest.config.ts --run
```

Expected: all three commands PASS; Rust serializes camelCase field names and omits absent capacity/settings fields.

- [ ] **Step 7: Commit the Rust settings parity slice (2–5 min).**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add \
  crates/freshell-protocol/src/resource_limits.rs \
  crates/freshell-protocol/src/lib.rs \
  crates/freshell-protocol/src/settings.rs \
  crates/freshell-protocol/tests/roundtrip.rs \
  crates/freshell-server/src/settings.rs \
  crates/freshell-server/src/settings_store.rs
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment diff --cached --check
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit \
  -m "feat(rust): mirror resource-limit settings and persistence" \
  -m "Generated with Amplifier: https://github.com/microsoft/amplifier" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

Expected: focused commit with Rust settings/protocol files only.

---
## Phase 2 — capability probe and Runtime settings UI

### Task 4: Systemd User Capability and Effective Capacity (Node + Rust)

**User stories / highest-level proof:** US-05 and prerequisite proof for US-01. Real `/api/platform` tests prove exact unavailable/available JSON; Task 15 runs both browser backends and the host-gated kernel proof.

**Files:**
- Create: `server/proc-info.ts`
- Create: `server/resource-control/cgroup-path.ts`
- Create: `server/resource-control/capability.ts`
- Create: `test/unit/server/resource-control-capability.test.ts`
- Modify: `server/coding-cli/codex-app-server/runtime.ts:273-286,338-351`
- Modify: `server/platform-router.ts:7-43`
- Modify: `server/index.ts:213-315,405-468`
- Modify: `test/unit/server/platform.test.ts`
- Modify: `test/integration/server/platform-api.test.ts` (this file already exists; do not recreate it)
- Create: `crates/freshell-resource-control/Cargo.toml`
- Create: `crates/freshell-resource-control/src/lib.rs`
- Create: `crates/freshell-resource-control/src/cgroup_path.rs`
- Create: `crates/freshell-resource-control/src/capability.rs`
- Modify: `Cargo.toml:31-34`, `Cargo.lock`
- Modify: `crates/freshell-server/Cargo.toml`
- Modify: `crates/freshell-server/src/main.rs:2346-2356`

**Interfaces:**
- Consumes: Task 1/3 `EffectiveResourceCapacity`; Node/Rust filesystem/process IO.
- Produces: `parseControlGroup`, `isAtOrBelow`, `joinCgroupPath`, `parseMeminfo`, `parseCpuList`, `probeResourceControlCapability`, `probe_resource_control_capability`, `ResourceControlCapability`, and one memoized boot promise/value shared by platform/bootstrap/settings.

- [ ] **Step 1: Write the failing Node capability/path tests (2–5 min).**

Create `test/unit/server/resource-control-capability.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  isAtOrBelow,
  joinCgroupPath,
  parseControlGroup,
} from '../../../server/resource-control/cgroup-path.js'
import { probeResourceControlCapability } from '../../../server/resource-control/capability.js'

const supported = () => ({
  platform: 'linux' as const,
  cgroup2Mounted: true,
  systemdUserReachable: true,
  targetControlGroup: '/user.slice/user-1000.slice/user@1000.service',
  targetSubtreeControllers: ['cpu', 'memory', 'pids'],
  freezerPresent: true,
  oomGroupPresent: true,
  systemMemoryBytes: 12 * 1024 ** 3,
  systemSwapBytes: 2 * 1024 ** 3,
  cpuAffinity: [0, 1, 2, 3, 4, 5, 6, 7],
  cpusetCpus: '0-7',
  ancestorLimits: [{
    cpuMax: '400000 100000',
    memoryMax: String(16 * 1024 ** 3),
    memorySwapMax: 'max',
    pidsMax: '2048',
  }],
})

describe('cgroup path safety', () => {
  it('accepts absolute root-relative paths and rejects traversal', () => {
    expect(parseControlGroup('ControlGroup=/user.slice/a.slice\n')).toBe('/user.slice/a.slice')
    expect(() => parseControlGroup('ControlGroup=../escape')).toThrow(/ControlGroup/)
    expect(joinCgroupPath('/user.slice/a.slice')).toBe('/sys/fs/cgroup/user.slice/a.slice')
    expect(isAtOrBelow('/user.slice/a.slice/x.scope', '/user.slice/a.slice')).toBe(true)
    expect(isAtOrBelow('/user.slice/a.slice2', '/user.slice/a.slice')).toBe(false)
  })
})

describe('probeResourceControlCapability', () => {
  it('returns the exact constrained fixture', () => {
    expect(probeResourceControlCapability(supported())).toEqual({
      available: true,
      effective: {
        cpuQuotaMillis: 4000,
        memoryBytes: 12 * 1024 ** 3,
        swapBytes: 2 * 1024 ** 3,
        tasksMax: 2048,
      },
    })
  })

  it.each([
    ['non-linux', { platform: 'darwin' as const }],
    ['no-cgroup2', { cgroup2Mounted: false }],
    ['no-systemd', { systemdUserReachable: false }],
    ['missing-controller', { targetSubtreeControllers: ['cpu', 'memory'] }],
    ['missing-freezer', { freezerPresent: false }],
    ['missing-oom-group', { oomGroupPresent: false }],
  ])('returns one unavailable shape for %s', (_name, override) => {
    expect(probeResourceControlCapability({ ...supported(), ...override })).toEqual({
      available: false,
      unavailableReason: 'Requires Linux cgroup v2 and a systemd user session.',
      effective: {},
    })
  })

  it('omits unreadable dimensions and preserves explicit zero swap', () => {
    const input = supported()
    expect(probeResourceControlCapability({
      ...input,
      systemMemoryBytes: undefined,
      systemSwapBytes: 0,
      ancestorLimits: [{ cpuMax: 'max 100000', memorySwapMax: '0', pidsMax: 'max' }],
    }).effective).toEqual({ cpuQuotaMillis: 8000, swapBytes: 0 })
  })
})
```

- [ ] **Step 2: Run Node capability tests and observe RED (2–5 min).**

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/resource-control-capability.test.ts \
  --config config/vitest/vitest.server.config.ts --run
```

Expected: FAIL with missing `server/resource-control/capability.ts` and `cgroup-path.ts`.

- [ ] **Step 3: Add exact Node path and proc parsers (2–5 min).**

Create `server/resource-control/cgroup-path.ts`:

```ts
import path from 'node:path'

export function validateControlGroup(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.startsWith('/')) throw new Error(`Invalid ControlGroup: ${value}`)
  const segments = trimmed.split('/').filter(Boolean)
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw new Error(`Invalid ControlGroup: ${value}`)
  }
  return `/${segments.join('/')}`
}

export function parseControlGroup(output: string): string {
  const line = output.split('\n').find((entry) => entry.startsWith('ControlGroup='))
  return validateControlGroup(line?.slice('ControlGroup='.length) ?? output)
}

export function isAtOrBelow(candidate: string, ancestor: string): boolean {
  const candidateParts = validateControlGroup(candidate).split('/').filter(Boolean)
  const ancestorParts = validateControlGroup(ancestor).split('/').filter(Boolean)
  return ancestorParts.every((segment, index) => candidateParts[index] === segment)
}

export function joinCgroupPath(relative: string): string {
  return path.join('/sys/fs/cgroup', validateControlGroup(relative).slice(1))
}
```

Create `server/proc-info.ts`:

```ts
export type Meminfo = {
  memTotalKb?: number
  memFreeKb?: number
  memAvailableKb?: number
  swapTotalKb?: number
  swapFreeKb?: number
}

export function parseMeminfo(raw: string): Meminfo {
  const values = new Map<string, number>()
  for (const line of raw.split('\n')) {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB/.exec(line)
    if (match) values.set(match[1], Number(match[2]))
  }
  return {
    memTotalKb: values.get('MemTotal'),
    memFreeKb: values.get('MemFree'),
    memAvailableKb: values.get('MemAvailable'),
    swapTotalKb: values.get('SwapTotal'),
    swapFreeKb: values.get('SwapFree'),
  }
}

export function parseCpuList(raw: string): number[] {
  const cpus = new Set<number>()
  for (const token of raw.trim().split(',').filter(Boolean)) {
    const [startText, endText] = token.split('-')
    const start = Number(startText)
    const end = endText === undefined ? start : Number(endText)
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      throw new Error(`Invalid CPU list: ${raw}`)
    }
    for (let cpu = start; cpu <= end; cpu += 1) cpus.add(cpu)
  }
  return [...cpus].sort((a, b) => a - b)
}
```

Replace the private `parseMeminfo` in Codex runtime with:

```ts
import { parseMeminfo } from '../../../proc-info.js'
```

- [ ] **Step 4: Add the pure Node capability reducer (2–5 min).**

Create `server/resource-control/capability.ts` with these exact public types and reducer:

```ts
import type { EffectiveResourceCapacity } from '../../shared/resource-limits.js'
import { parseCpuList } from '../proc-info.js'
import { validateControlGroup } from './cgroup-path.js'

export const RESOURCE_CONTROL_UNAVAILABLE = 'Requires Linux cgroup v2 and a systemd user session.'

export type AncestorLimits = {
  cpuMax?: string
  memoryMax?: string
  memorySwapMax?: string
  pidsMax?: string
}
export type ProbeIo = {
  platform: 'linux' | 'darwin' | 'win32'
  cgroup2Mounted: boolean
  systemdUserReachable: boolean
  targetControlGroup: string
  targetSubtreeControllers: string[]
  freezerPresent: boolean
  oomGroupPresent: boolean
  systemMemoryBytes?: number
  systemSwapBytes?: number
  cpuAffinity: number[]
  cpusetCpus: string
  ancestorLimits: AncestorLimits[]
}
export type ResourceControlCapability = {
  available: boolean
  unavailableReason?: string
  effective: EffectiveResourceCapacity
}

function finite(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === 'max') return undefined
  const parsed = Number(raw.trim())
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function minimum(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined)
  return present.length === 0 ? undefined : Math.min(...present)
}

function cpuQuota(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const [quotaText, periodText] = raw.trim().split(/\s+/)
  if (quotaText === 'max') return undefined
  const quota = Number(quotaText)
  const period = Number(periodText)
  if (!Number.isSafeInteger(quota) || !Number.isSafeInteger(period) || quota < 0 || period <= 0) return undefined
  return Math.floor(quota * 1000 / period)
}

export function probeResourceControlCapability(io: ProbeIo): ResourceControlCapability {
  let pathValid = true
  try { validateControlGroup(io.targetControlGroup) } catch { pathValid = false }
  const controllers = new Set(io.targetSubtreeControllers)
  const available = io.platform === 'linux'
    && io.cgroup2Mounted
    && io.systemdUserReachable
    && pathValid
    && ['cpu', 'memory', 'pids'].every((name) => controllers.has(name))
    && io.freezerPresent
    && io.oomGroupPresent
  if (!available) {
    return { available: false, unavailableReason: RESOURCE_CONTROL_UNAVAILABLE, effective: {} }
  }
  const allowed = new Set(io.cpuAffinity)
  const cpusetCount = parseCpuList(io.cpusetCpus).filter((cpu) => allowed.has(cpu)).length
  const quota = minimum(io.ancestorLimits.map((entry) => cpuQuota(entry.cpuMax)))
  const effective: EffectiveResourceCapacity = {}
  if (cpusetCount > 0) effective.cpuQuotaMillis = minimum([cpusetCount * 1000, quota])
  effective.memoryBytes = minimum([
    io.systemMemoryBytes,
    minimum(io.ancestorLimits.map((entry) => finite(entry.memoryMax))),
  ])
  effective.swapBytes = minimum([
    io.systemSwapBytes,
    minimum(io.ancestorLimits.map((entry) => finite(entry.memorySwapMax))),
  ])
  effective.tasksMax = minimum(io.ancestorLimits.map((entry) => finite(entry.pidsMax)))
  for (const key of Object.keys(effective) as Array<keyof EffectiveResourceCapacity>) {
    if (effective[key] === undefined) delete effective[key]
  }
  return { available: true, effective }
}
```

- [ ] **Step 5: Wire one memoized Node production probe into platform/bootstrap/settings (2–5 min).**

Add to `PlatformRouterDeps` and route:

```diff
+import type { ResourceControlCapability } from './resource-control/capability.js'
@@
 export interface PlatformRouterDeps {
+  resourceControl: Promise<ResourceControlCapability>
@@
-  const [platform, availableClis, hostName] = await Promise.all([
+  const [platform, availableClis, hostName, resourceControl] = await Promise.all([
     detectPlatform(),
     detectAvailableClis(),
     detectHostName(),
+    deps.resourceControl,
   ])
@@
-  res.json({ platform, availableClis, hostName, featureFlags })
+  res.json({ platform, availableClis, hostName, featureFlags, resourceControl })
```

In `server/index.ts`, construct exactly one promise before routers/settings:

```ts
const resourceControlCapability = probeProductionResourceControlCapability({
  execFile,
  readFile: (pathname) => readFile(pathname, 'utf8'),
})
```

Pass the same `resourceControlCapability` object to `createPlatformRouter`, bootstrap payload construction, and `createSettingsRouter`. `probeProductionResourceControlCapability` executes `systemctl --user show -p ControlGroup --value -- -.slice`, reads `/proc/meminfo`, `/proc/self/status`, target/ancestor `cpu.max`, `memory.max`, `memory.swap.max`, `pids.max`, target `cgroup.subtree_control`, and target `cpuset.cpus.effective`; every read is attempted directly inside `Promise.allSettled` and converted once into `ProbeIo` before calling the pure reducer.

- [ ] **Step 6: Run Node capability/platform tests and commit Node half (2–5 min).**

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/resource-control-capability.test.ts \
  test/unit/server/platform.test.ts \
  test/integration/server/platform-api.test.ts \
  --config config/vitest/vitest.server.config.ts --run
```

Expected: all three files PASS and exact field names are `cpuQuotaMillis`, `memoryBytes`, `swapBytes`, `tasksMax`.

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add \
  server/proc-info.ts server/resource-control/cgroup-path.ts \
  server/resource-control/capability.ts server/coding-cli/codex-app-server/runtime.ts \
  server/platform-router.ts server/index.ts \
  test/unit/server/resource-control-capability.test.ts \
  test/unit/server/platform.test.ts test/integration/server/platform-api.test.ts
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment diff --cached --check
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit \
  -m "feat(server): probe systemd user resource-control capability" \
  -m "Generated with Amplifier: https://github.com/microsoft/amplifier" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

- [ ] **Step 7: Create the Rust crate and failing parity tests (2–5 min).**

Create `crates/freshell-resource-control/Cargo.toml`:

```toml
[package]
name = "freshell-resource-control"
version = "0.1.0"
edition.workspace = true
rust-version.workspace = true
publish.workspace = true

[dependencies]
freshell-protocol = { path = "../freshell-protocol" }
async-trait = "0.1"
serde = { workspace = true }
thiserror = "2"
tokio = { version = "1", features = ["fs", "process", "sync", "time"] }
uuid = { version = "1", features = ["v4"] }

[dev-dependencies]
tempfile = "3"
```

Create `src/lib.rs`:

```rust
pub mod capability;
pub mod cgroup_path;

pub use capability::{probe_resource_control_capability, ProbeIo, ProbeOutcome};
pub use cgroup_path::{is_at_or_below, join_cgroup_path, parse_control_group};
```

Create `src/capability.rs` with a `#[cfg(test)]` fixture asserting exactly `4000`, `12 * 1024^3`, `2 * 1024^3`, `2048`, one unavailable string, missing-dimension omission, and zero swap. Use the field names from Task 3 `EffectiveResourceCapacity`.

- [ ] **Step 8: Run Rust capability tests and observe RED (2–5 min).**

```bash
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-resource-control capability:: -- --nocapture
```

Expected: compile FAIL because `cgroup_path.rs`, `ProbeIo`, and reducer functions are undefined.

- [ ] **Step 9: Add exact Rust path and capability public shapes (2–5 min).**

Create `src/cgroup_path.rs`:

```rust
use std::path::{Component, Path, PathBuf};

pub fn parse_control_group(raw: &str) -> Result<String, String> {
    let value = raw.lines().find_map(|line| line.strip_prefix("ControlGroup=")).unwrap_or(raw).trim();
    if !value.starts_with('/') || Path::new(value).components().any(|part| matches!(part, Component::ParentDir | Component::CurDir)) {
        return Err(format!("invalid ControlGroup: {raw}"));
    }
    Ok(format!("/{}", value.split('/').filter(|part| !part.is_empty()).collect::<Vec<_>>().join("/")))
}

pub fn is_at_or_below(candidate: &str, ancestor: &str) -> Result<bool, String> {
    let candidate = parse_control_group(candidate)?;
    let ancestor = parse_control_group(ancestor)?;
    Ok(Path::new(&candidate).starts_with(Path::new(&ancestor)))
}

pub fn join_cgroup_path(relative: &str) -> Result<PathBuf, String> {
    Ok(Path::new("/sys/fs/cgroup").join(parse_control_group(relative)?.trim_start_matches('/')))
}
```

Define the exact reducer types in `src/capability.rs`:

```rust
use freshell_protocol::EffectiveResourceCapacity;

pub const UNAVAILABLE_REASON: &str = "Requires Linux cgroup v2 and a systemd user session.";

#[derive(Clone, Debug, Default)]
pub struct AncestorLimits {
    pub cpu_max: Option<String>,
    pub memory_max: Option<String>,
    pub memory_swap_max: Option<String>,
    pub pids_max: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ProbeIo {
    pub platform_linux: bool,
    pub cgroup2_mounted: bool,
    pub systemd_user_reachable: bool,
    pub target_control_group: String,
    pub target_subtree_controllers: Vec<String>,
    pub freezer_present: bool,
    pub oom_group_present: bool,
    pub system_memory_bytes: Option<u64>,
    pub system_swap_bytes: Option<u64>,
    pub cpu_affinity: Vec<u32>,
    pub cpuset_cpus: String,
    pub ancestor_limits: Vec<AncestorLimits>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeOutcome {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    pub effective: EffectiveResourceCapacity,
}
```

Add this exact Rust parser/reducer block; it uses `u128` for quota multiplication, preserves zero, omits absent dimensions, and validates the target path before declaring availability:

```rust
fn finite(raw: Option<&str>) -> Option<u64> {
    let raw = raw?.trim();
    if raw == "max" { return None; }
    raw.parse::<u64>().ok()
}

fn cpu_quota(raw: Option<&str>) -> Option<u32> {
    let mut parts = raw?.split_whitespace();
    let quota = parts.next()?;
    let period: u128 = parts.next()?.parse().ok()?;
    if quota == "max" || period == 0 { return None; }
    let quota: u128 = quota.parse().ok()?;
    u32::try_from(quota.saturating_mul(1000) / period).ok()
}

fn parse_cpu_list(raw: &str) -> Result<std::collections::BTreeSet<u32>, String> {
    let mut cpus = std::collections::BTreeSet::new();
    for token in raw.trim().split(',').filter(|part| !part.is_empty()) {
        let mut bounds = token.split('-');
        let start: u32 = bounds.next().ok_or_else(|| format!("invalid CPU list: {raw}"))?
            .parse().map_err(|_| format!("invalid CPU list: {raw}"))?;
        let end: u32 = bounds.next().map_or(Ok(start), |value| value.parse()
            .map_err(|_| format!("invalid CPU list: {raw}")))?;
        if bounds.next().is_some() || end < start { return Err(format!("invalid CPU list: {raw}")); }
        cpus.extend(start..=end);
    }
    Ok(cpus)
}

fn min_u64(values: impl IntoIterator<Item = Option<u64>>) -> Option<u64> {
    values.into_iter().flatten().min()
}

pub fn probe_resource_control_capability(io: &ProbeIo) -> ProbeOutcome {
    let path_valid = crate::cgroup_path::parse_control_group(&io.target_control_group).is_ok();
    let delegated = ["cpu", "memory", "pids"].into_iter()
        .all(|required| io.target_subtree_controllers.iter().any(|value| value == required));
    if !(io.platform_linux && io.cgroup2_mounted && io.systemd_user_reachable
        && path_valid && delegated && io.freezer_present && io.oom_group_present) {
        return ProbeOutcome {
            available: false,
            unavailable_reason: Some(UNAVAILABLE_REASON.into()),
            effective: EffectiveResourceCapacity::default(),
        };
    }
    let affinity: std::collections::BTreeSet<u32> = io.cpu_affinity.iter().copied().collect();
    let cpuset = parse_cpu_list(&io.cpuset_cpus).unwrap_or_default();
    let cpu_count = affinity.intersection(&cpuset).count() as u32;
    let quota = io.ancestor_limits.iter()
        .filter_map(|entry| cpu_quota(entry.cpu_max.as_deref())).min();
    let cpu_quota_millis = (cpu_count > 0).then_some(cpu_count.saturating_mul(1000))
        .map(|count| quota.map_or(count, |limit| count.min(limit)));
    let memory_limit = min_u64(io.ancestor_limits.iter()
        .map(|entry| finite(entry.memory_max.as_deref())));
    let swap_limit = min_u64(io.ancestor_limits.iter()
        .map(|entry| finite(entry.memory_swap_max.as_deref())));
    let tasks_max = io.ancestor_limits.iter()
        .filter_map(|entry| finite(entry.pids_max.as_deref())).min()
        .and_then(|value| u32::try_from(value).ok());
    ProbeOutcome {
        available: true,
        unavailable_reason: None,
        effective: EffectiveResourceCapacity {
            cpu_quota_millis,
            memory_bytes: min_u64([io.system_memory_bytes, memory_limit]),
            swap_bytes: min_u64([io.system_swap_bytes, swap_limit]),
            tasks_max,
        },
    }
}
```

- [ ] **Step 10: Wire one Rust boot value, run the tests, and observe GREEN (2–5 min).**

Add `freshell-resource-control = { path = "../freshell-resource-control" }` to `crates/freshell-server/Cargo.toml`. In `main.rs`, evaluate and share exactly one probe value:

```rust
let resource_control_capability = Arc::new(
    freshell_resource_control::controller::probe_production_resource_control_capability()
        .await,
);
let platform_resource_control = Arc::clone(&resource_control_capability);
let settings_resource_control = Arc::clone(&resource_control_capability);
```

Add to the platform JSON object:

```rust
"resourceControl": serde_json::to_value(platform_resource_control.as_ref())?,
```

Pass `settings_resource_control` into the first-enable settings handler and call `calculate_initial_resource_limits(settings_resource_control.effective.clone())` only when stored limits are absent. Export this production probe from `controller.rs`:

```rust
pub async fn probe_production_resource_control_capability() -> ProbeOutcome {
    let io = ProductionProbeIo::read_directly().await;
    probe_resource_control_capability(&io)
}

struct ProductionProbeIo;

impl ProductionProbeIo {
    async fn read_directly() -> ProbeIo {
        let systemd = tokio::process::Command::new("systemctl")
            .args(["--user", "show", "-p", "ControlGroup", "--value", "--", "-.slice"])
            .output().await.ok();
        let target_control_group = systemd.as_ref()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .unwrap_or_default();
        let target_path = crate::cgroup_path::join_cgroup_path(&target_control_group).ok();
        let read = |name: &'static str| {
            let path = target_path.as_ref().map(|base| base.join(name));
            async move {
                match path { Some(path) => tokio::fs::read_to_string(path).await.ok(), None => None }
            }
        };
        let (controllers, freezer, oom_group, cpuset, meminfo, status) = tokio::join!(
            read("cgroup.subtree_control"),
            read("cgroup.freeze"),
            read("memory.oom.group"),
            read("cpuset.cpus.effective"),
            tokio::fs::read_to_string("/proc/meminfo"),
            tokio::fs::read_to_string("/proc/self/status"),
        );
        let mem_value = |name: &str| -> Option<u64> {
            meminfo.as_ref().ok()?.lines().find_map(|line| {
                let (key, rest) = line.split_once(':')?;
                (key == name).then(|| rest.split_whitespace().next()?.parse::<u64>().ok().map(|kb| kb * 1024)).flatten()
            })
        };
        let affinity_text = status.as_ref().ok().and_then(|raw| raw.lines()
            .find_map(|line| line.strip_prefix("Cpus_allowed_list:").map(str::trim))).unwrap_or("");
        let cpu_affinity = parse_cpu_list(affinity_text).unwrap_or_default().into_iter().collect();
        let mut ancestor_limits = Vec::new();
        let mut cursor = target_path.clone();
        while let Some(path) = cursor {
            ancestor_limits.push(AncestorLimits {
                cpu_max: tokio::fs::read_to_string(path.join("cpu.max")).await.ok(),
                memory_max: tokio::fs::read_to_string(path.join("memory.max")).await.ok(),
                memory_swap_max: tokio::fs::read_to_string(path.join("memory.swap.max")).await.ok(),
                pids_max: tokio::fs::read_to_string(path.join("pids.max")).await.ok(),
            });
            if path == std::path::Path::new("/sys/fs/cgroup") { break; }
            cursor = path.parent().map(std::path::Path::to_path_buf);
        }
        ProbeIo {
            platform_linux: cfg!(target_os = "linux"),
            cgroup2_mounted: std::path::Path::new("/sys/fs/cgroup/cgroup.controllers").exists(),
            systemd_user_reachable: systemd.as_ref().is_some_and(|output| output.status.success()),
            target_control_group,
            target_subtree_controllers: controllers.unwrap_or_default().split_whitespace()
                .map(|value| value.trim_start_matches('+').to_string()).collect(),
            freezer_present: freezer.is_some(),
            oom_group_present: oom_group.is_some(),
            system_memory_bytes: mem_value("MemTotal"),
            system_swap_bytes: mem_value("SwapTotal"),
            cpu_affinity,
            cpuset_cpus: cpuset.unwrap_or_default(),
            ancestor_limits,
        }
    }
}
```

Every required file is read directly. Independent failures become absent dimensions or false availability flags; there is no stat-before-read path.

Run:

```bash
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-resource-control
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-server main
cargo +1.96.0 check --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml --workspace
```

Expected: all PASS; one probe value is reused rather than recomputed per request.

- [ ] **Step 11: Commit the Rust capability half (2–5 min).**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add \
  Cargo.toml Cargo.lock crates/freshell-resource-control \
  crates/freshell-server/Cargo.toml crates/freshell-server/src/main.rs
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment diff --cached --check
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit \
  -m "feat(rust): mirror resource-control capability probe" \
  -m "Generated with Amplifier: https://github.com/microsoft/amplifier" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

Expected: buildable workspace commit containing the new crate, lockfile, and server wiring.

### Task 5: Runtime Settings UI and Ephemeral Runtime Slice

**User stories / highest-level proof:** US-01 through US-05. Component tests prove the draft/toggle/disabled semantics; Task 15 proves reload and both backend variants in a browser.

**Files:**
- Create: `src/store/resourceContainmentSlice.ts`
- Modify: `src/store/connectionSlice.ts:5-75`
- Modify: `src/store/store.ts:1-88`
- Modify: `src/App.tsx:537-648` (platform/bootstrap dispatch only; do not thread RuntimeSettings props through App)
- Modify: `src/components/settings/RuntimeSettings.tsx:1-113`
- Modify: `src/components/settings/settings-controls.tsx:93-125,230-338`
- Create: `test/unit/client/components/RuntimeSettings.resource-limits.test.tsx`
- Modify: `test/unit/client/components/SettingsView.core.test.tsx`

**Interfaces:**
- Consumes: settings from existing `settingsSlice`; capability from `connectionSlice`; `runningCount` from the new slice; existing `applyServerSetting` queue.
- Produces: ephemeral reducer `resourceContainment`, `setResourceContainment`, accessible `ResourceNumberInput`, and Runtime section with one local draft/one complete save.

- [ ] **Step 1: Create failing user-facing settings tests (2–5 min).**

Create `test/unit/client/components/RuntimeSettings.resource-limits.test.tsx` with these complete helpers and assertions:

```tsx
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { calculateInitialResourceLimits, type CodingAgentResourceLimits } from '../../../../shared/resource-limits.js'
import { createDefaultServerSettings } from '../../../../shared/settings.js'
import RuntimeSettings from '../../../../src/components/settings/RuntimeSettings.js'
import connectionReducer, { setResourceControl } from '../../../../src/store/connectionSlice.js'
import resourceContainmentReducer, { setResourceContainment } from '../../../../src/store/resourceContainmentSlice.js'

function enabledFixture(): CodingAgentResourceLimits {
  return calculateInitialResourceLimits({
    cpuQuotaMillis: 16_000,
    memoryBytes: 48 * 1024 ** 3,
    swapBytes: 16 * 1024 ** 3,
    tasksMax: 8192,
  })
}

function renderRuntimeSettings({
  resourceControl = { available: true, effective: {} },
  savedLimits,
  runningCount = 0,
}: {
  resourceControl?: { available: boolean; unavailableReason?: string; effective: Record<string, number> }
  savedLimits?: CodingAgentResourceLimits
  runningCount?: number
} = {}) {
  const applyServerSetting = vi.fn()
  const store = configureStore({
    reducer: { connection: connectionReducer, resourceContainment: resourceContainmentReducer },
  })
  store.dispatch(setResourceControl(resourceControl))
  store.dispatch(setResourceContainment({ pending: [], snapshot: { runningCount, groups: [] } }))
  const settings = createDefaultServerSettings()
  settings.safety.codingAgentResourceLimits = savedLimits
  const view = render(
    <Provider store={store}>
      <RuntimeSettings settings={settings} applyServerSetting={applyServerSetting} />
    </Provider>,
  )
  const rerenderWithLimits = (limits: CodingAgentResourceLimits) => {
    const next = createDefaultServerSettings()
    next.safety.codingAgentResourceLimits = limits
    view.rerender(
      <Provider store={store}>
        <RuntimeSettings settings={next} applyServerSetting={applyServerSetting} />
      </Provider>,
    )
  }
  return { ...view, applyServerSetting, rerenderWithLimits, store }
}

it('shows the exact unsupported state and no alternate mechanism', async () => {
  renderRuntimeSettings({
    resourceControl: {
      available: false,
      unavailableReason: 'Requires Linux cgroup v2 and a systemd user session.',
      effective: {},
    },
  })
  expect(screen.getByRole('switch', { name: 'Coding agent resource limits' })).toBeDisabled()
  expect(screen.getByText('Requires Linux cgroup v2 and a systemd user session.')).toBeVisible()
  expect(screen.queryByText(/recalculate|wslconfig|docker|ulimit/i)).not.toBeInTheDocument()
})

it('sends enable-only first, drafts locally, then saves one complete object', async () => {
  const { applyServerSetting, rerenderWithLimits } = renderRuntimeSettings({
    resourceControl: { available: true, effective: {} },
    savedLimits: undefined,
  })
  await userEvent.click(screen.getByRole('switch', { name: 'Coding agent resource limits' }))
  expect(applyServerSetting).toHaveBeenLastCalledWith({
    safety: { codingAgentResourceLimits: { enabled: true } },
  })
  rerenderWithLimits(enabledFixture())
  await userEvent.clear(screen.getByRole('spinbutton', { name: 'All agents CPU cores' }))
  await userEvent.type(screen.getByRole('spinbutton', { name: 'All agents CPU cores' }), '5')
  expect(applyServerSetting).toHaveBeenCalledTimes(1)
  await userEvent.click(screen.getByRole('button', { name: 'Save limits' }))
  expect(applyServerSetting).toHaveBeenCalledTimes(2)
  expect(applyServerSetting.mock.calls[1][0].safety.codingAgentResourceLimits.allAgents.cpuQuotaMillis).toBe(5000)
  expect(Object.keys(applyServerSetting.mock.calls[1][0].safety.codingAgentResourceLimits.allAgents)).toHaveLength(5)
})

it('uses actual disabled attributes for fifteen fields while running', () => {
  renderRuntimeSettings({ savedLimits: enabledFixture(), runningCount: 1 })
  expect(screen.getAllByRole('spinbutton')).toHaveLength(15)
  for (const field of screen.getAllByRole('spinbutton')) expect(field).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Save limits' })).toBeDisabled()
  expect(screen.getByRole('switch', { name: 'Coding agent resource limits' })).toBeEnabled()
})
```

- [ ] **Step 2: Run the client tests and observe RED (2–5 min).**

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/client/components/RuntimeSettings.resource-limits.test.tsx \
  test/unit/client/components/SettingsView.core.test.tsx \
  --config config/vitest/vitest.config.ts --run
```

Expected: FAIL because `resourceContainment` state and the Runtime controls do not exist.

- [ ] **Step 3: Create the complete ephemeral Redux slice (2–5 min).**

Create `src/store/resourceContainmentSlice.ts`:

```ts
import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

export type ResourceMember = { paneId: string; label: string; sessionId?: string }
export type ResourceGroupSnapshot = {
  id: string
  kind: 'ordinary' | 'sharedOpenCode'
  label: string
  phase: 'idle' | 'warning' | 'paused' | 'stopped'
  deadlineAt?: number
  stopReason?: 'policy' | 'oom' | 'user'
  members: ResourceMember[]
}
export type ResourceContainmentState = {
  pending: Array<{ id: string; paneId: string }>
  snapshot: { runningCount: number; groups: ResourceGroupSnapshot[] }
}

const initialState: ResourceContainmentState = {
  pending: [],
  snapshot: { runningCount: 0, groups: [] },
}

export const resourceContainmentSlice = createSlice({
  name: 'resourceContainment',
  initialState,
  reducers: {
    setResourceContainment: (_state, action: PayloadAction<ResourceContainmentState>) => action.payload,
  },
})

export const { setResourceContainment } = resourceContainmentSlice.actions
export default resourceContainmentSlice.reducer
```

Register it in `store.ts`:

```diff
+import resourceContainmentReducer from './resourceContainmentSlice'
@@
     connection: connectionReducer,
+    resourceContainment: resourceContainmentReducer,
```

- [ ] **Step 4: Cache capability and add a semantic number control (2–5 min).**

Add to `ConnectionState` and reducers:

```ts
resourceControl: {
  available: boolean
  unavailableReason?: string
  effective: {
    cpuQuotaMillis?: number
    memoryBytes?: number
    swapBytes?: number
    tasksMax?: number
  }
}
```

Initialize it as `{ available: false, effective: {} }`, add `setResourceControl`, and dispatch it from both bootstrap and `/api/platform` response handling in `App.tsx`.

Add to `settings-controls.tsx`:

```tsx
export function ResourceNumberInput({
  label,
  value,
  unit,
  min,
  disabled,
  onChange,
}: {
  label: string
  value: string
  unit: string
  min: number
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="sr-only">{label}</span>
      <input
        type="number"
        inputMode="decimal"
        aria-label={label}
        min={min}
        step="any"
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-28 rounded-md border-0 bg-muted px-2 text-right text-sm disabled:cursor-not-allowed disabled:opacity-50 md:h-8"
      />
      <span aria-hidden="true" className="text-xs text-muted-foreground">{unit}</span>
    </label>
  )
}
```

- [ ] **Step 5: Add exact conversion/draft/save logic to RuntimeSettings (2–5 min).**

Import `useAppSelector`, `validateResourceLimits`, Task 1 types, `Toggle`, and `ResourceNumberInput`. Add these exact helpers above the component:

```tsx
const GIB = 1024 ** 3
const GROUPS = [
  ['allAgents', 'All agents'],
  ['eachAgent', 'Each agent'],
  ['sharedOpenCode', 'Shared OpenCode'],
] as const
const FIELDS = [
  ['cpuQuotaMillis', 'CPU cores', 'cores', 1000],
  ['memoryHighBytes', 'Memory high', 'GiB', GIB],
  ['memoryMaxBytes', 'Memory max', 'GiB', GIB],
  ['swapMaxBytes', 'Swap max', 'GiB', GIB],
  ['tasksMax', 'Tasks max', 'tasks', 1],
] as const

type Draft = Record<typeof GROUPS[number][0], Record<typeof FIELDS[number][0], string>>

function toDraft(value: CodingAgentResourceLimits): Draft {
  return Object.fromEntries(GROUPS.map(([group]) => [group, Object.fromEntries(
    FIELDS.map(([field, _label, _unit, divisor]) => [field, String(value[group][field] / divisor)]),
  )])) as Draft
}

function toCanonical(draft: Draft, enabled: boolean): CodingAgentResourceLimits {
  return {
    enabled,
    ...Object.fromEntries(GROUPS.map(([group]) => [group, Object.fromEntries(
      FIELDS.map(([field, _label, _unit, multiplier]) => [field, Math.round(Number(draft[group][field]) * multiplier)]),
    )])),
  } as CodingAgentResourceLimits
}
```

Inside `RuntimeSettings`, select state directly rather than threading props through App:

```tsx
const resourceControl = useAppSelector((state) => state.connection.resourceControl)
const runningCount = useAppSelector((state) => state.resourceContainment.snapshot.runningCount)
const savedLimits = settings.safety.codingAgentResourceLimits
const [draft, setDraft] = useState<Draft | null>(() => savedLimits ? toDraft(savedLimits) : null)
useEffect(() => {
  if (savedLimits) setDraft(toDraft(savedLimits))
}, [savedLimits, runningCount])
const canonical = draft && savedLimits ? toCanonical(draft, savedLimits.enabled) : null
const validation = canonical ? validateResourceLimits(canonical) : { valid: false, errors: [] }
```

Render within the existing Runtime section after idle timeout:

```tsx
<SettingsRow
  label="Coding agent resource limits"
  description={resourceControl.available ? 'Limit future coding-agent processes.' : resourceControl.unavailableReason}
>
  <Toggle
    aria-label="Coding agent resource limits"
    checked={savedLimits?.enabled ?? false}
    disabled={!resourceControl.available}
    onChange={(enabled) => applyServerSetting({
      safety: { codingAgentResourceLimits: savedLimits ? { ...savedLimits, enabled } : { enabled } },
    })}
  />
</SettingsRow>
{savedLimits && draft && GROUPS.map(([group, groupLabel]) => (
  <fieldset key={group} className="space-y-2 rounded-md border border-border p-3">
    <legend className="px-1 text-sm font-medium">{groupLabel}</legend>
    {FIELDS.map(([field, label, unit]) => (
      <SettingsRow key={field} label={label}>
        <ResourceNumberInput
          label={`${groupLabel} ${label}`}
          value={draft[group][field]}
          unit={unit}
          min={field === 'swapMaxBytes' ? 0 : Number.MIN_VALUE}
          disabled={runningCount > 0}
          onChange={(value) => setDraft({ ...draft, [group]: { ...draft[group], [field]: value } })}
        />
      </SettingsRow>
    ))}
  </fieldset>
))}
{savedLimits && canonical && (
  <div>
    {validation.errors.map((error) => <p key={error} role="alert" className="text-xs text-destructive">{error}</p>)}
    <button
      type="button"
      disabled={runningCount > 0 || !validation.valid}
      onClick={() => applyServerSetting({ safety: { codingAgentResourceLimits: canonical } })}
    >
      Save limits
    </button>
  </div>
)}
```

- [ ] **Step 6: Run client tests and observe GREEN (2–5 min).**

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/client/components/RuntimeSettings.resource-limits.test.tsx \
  test/unit/client/components/SettingsView.core.test.tsx \
  --config config/vitest/vitest.config.ts --run
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run lint
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run typecheck
```

Expected: both tests PASS; lint and typecheck exit 0; all fifteen controls are semantic spinbuttons.

- [ ] **Step 7: Commit the client settings slice (2–5 min).**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add \
  src/store/resourceContainmentSlice.ts src/store/connectionSlice.ts src/store/store.ts \
  src/App.tsx src/components/settings/RuntimeSettings.tsx \
  src/components/settings/settings-controls.tsx \
  test/unit/client/components/RuntimeSettings.resource-limits.test.tsx \
  test/unit/client/components/SettingsView.core.test.tsx
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment diff --cached --check
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit \
  -m "feat(client): add coding-agent resource-limit settings" \
  -m "Generated with Amplifier: https://github.com/microsoft/amplifier" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

Expected: focused UI/store commit; no server or protocol files.

---
## Phase 3 — systemd core and complete launch coverage

### Task 6: Node Systemd Controller and Common Launch Transaction

**User stories / highest-level proof:** Mechanism for US-06 through US-15. Focused tests prove unit topology, kernel-truth checks, gate concurrency, freezer behavior, and exact rollback before any process path is wired.

**Files:**
- Create: `server/resource-control/systemd.ts`
- Create: `server/resource-control/controller.ts`
- Create: `test/unit/server/resource-control-systemd.test.ts`
- Create: `test/unit/server/resource-control-controller.test.ts`

**Interfaces:**
- Consumes: Task 1 `ResourceLimitSet`; Task 4 cgroup path helpers; injected argv-safe IO.
- Produces: the exact `ResourceControl` surface in “Exact Cross-Task Interfaces”, `ResourceControlError`, `ContainedLaunchTransaction`, and `createProductionSystemdController(bootId, overrides?)`.

- [ ] **Step 1: Create the failing topology/argv tests (2–5 min).**

Create `test/unit/server/resource-control-systemd.test.ts` with these complete limit/fake helpers, followed by the assertions below:

```ts
import { expect, it, vi } from 'vitest'
import { SystemdController, type SystemdIo } from '../../../server/resource-control/systemd.js'

const aggregateLimits = {
  cpuQuotaMillis: 4000, memoryHighBytes: 800, memoryMaxBytes: 1000,
  swapMaxBytes: 200, tasksMax: 100,
}
const leafLimits = {
  cpuQuotaMillis: 2000, memoryHighBytes: 400, memoryMaxBytes: 500,
  swapMaxBytes: 100, tasksMax: 50,
}

function fakeSystemdIo(ids: string[]) {
  const raw = new Map<string, string>()
  const procCgroup = new Map<number, string>()
  const scopeMembers = new Map<string, number[]>()
  const commands: Array<[string, string[]]> = []
  const unitPath = (unit: string) => unit.endsWith('.scope')
    ? `/user.slice/freshellagentsboota1.slice/freshellagentsboota1-agentleaf1.slice/${unit}`
    : unit.includes('-agent') || unit.includes('-opencode')
      ? `/user.slice/freshellagentsboota1.slice/${unit}`
      : `/user.slice/${unit}`
  const absolute = (unit: string) => `/sys/fs/cgroup${unitPath(unit)}`
  const io: SystemdIo & {
    raw: Map<string, string>
    procCgroup: Map<number, string>
    scopeMembers: Map<string, number[]>
    writes: Array<[string, string]>
    setPropertyCallsFor(unit: string): Array<[string, string[]]>
    scopePath(unit: string): string
    leafPath(unit: string): string
  } = {
    raw, procCgroup, scopeMembers, writes: [],
    uuid: vi.fn(() => ids.shift() ?? `generated${ids.length}`),
    sleep: vi.fn(async () => undefined),
    execFile: vi.fn(async (file, args) => {
      commands.push([file, [...args]])
      if (args.includes('show')) {
        const unit = args.find((value) => value.endsWith('.slice') || value.endsWith('.scope')) ?? ''
        return { stdout: `ControlGroup=${unitPath(unit)}
`, stderr: '' }
      }
      if (args.includes('set-property')) {
        const unit = args[3]
        const values = new Map(args.slice(4).map((entry) => entry.split('=', 2) as [string, string]))
        const base = absolute(unit)
        const quotaPercent = Number(values.get('CPUQuota')?.replace('%', ''))
        raw.set(`${base}/cpu.max`, `${quotaPercent * 1000} 100000`)
        raw.set(`${base}/memory.high`, values.get('MemoryHigh') ?? '')
        raw.set(`${base}/memory.max`, values.get('MemoryMax') ?? '')
        raw.set(`${base}/memory.swap.max`, values.get('MemorySwapMax') ?? '')
        raw.set(`${base}/pids.max`, values.get('TasksMax') ?? '')
      }
      return { stdout: '', stderr: '' }
    }),
    readFile: vi.fn(async (pathname) => {
      const proc = /^\/proc\/(\d+)\/cgroup$/.exec(pathname)
      if (proc) return `0::${procCgroup.get(Number(proc[1])) ?? '/outside.scope'}
`
      const scope = [...scopeMembers.keys()].find((unit) => pathname === `${absolute(unit)}/cgroup.procs`)
      if (scope) return `${scopeMembers.get(scope)?.join('
') ?? ''}
`
      return raw.get(pathname) ?? (pathname.endsWith('/cgroup.events') ? 'populated 1
frozen 0
' : '0')
    }),
    writeFile: vi.fn(async (pathname, value) => { io.writes.push([pathname, value]); raw.set(pathname, value) }),
    setPropertyCallsFor: (unit) => commands.filter(([, args]) => args.includes('set-property') && args.includes(unit)),
    scopePath: absolute,
    leafPath: absolute,
  }
  return io
}

async function verifiedFixture() {
  const io = fakeSystemdIo(['leaf1', 'scope1'])
  const control = new SystemdController(io, 'BOOT-A1')
  await control.ensureAggregate(aggregateLimits)
  const group = await control.beginLogicalGroup('ordinary', { role: 'claude' }, leafLimits)
  const launch = control.wrapProcess(group, 'claude', ['claude'])
  io.raw.set(`${io.leafPath(group.unit)}/memory.oom.group`, '1')
  io.procCgroup.set(1234, io.scopePath(launch.scope).replace('/sys/fs/cgroup', ''))
  return { control, io, group, launch }
}
```

```ts
it('creates aggregate OOM=0, ordinary leaf OOM=1, and exact scope argv', async () => {
  const io = fakeSystemdIo(['leaf1', 'scope1'])
  const control = new SystemdController(io, 'BOOT-A1')
  const aggregate = await control.ensureAggregate(aggregateLimits)
  const group = await control.beginLogicalGroup('ordinary', { role: 'claude' }, leafLimits)
  const launch = control.wrapProcess(group, 'claude', ['claude', '--resume', 's1'])
  expect(aggregate.unit).toBe('freshellagentsboota1.slice')
  expect(group).toEqual({
    aggregateUnit: 'freshellagentsboota1.slice',
    unit: 'freshellagentsboota1-agentleaf1.slice',
  })
  expect(launch).toEqual({
    scope: 'freshellagentprocscope1.scope',
    file: 'systemd-run',
    args: [
      '--user', '--scope', '--collect', '--quiet',
      '--unit=freshellagentprocscope1.scope',
      '--slice=freshellagentsboota1-agentleaf1.slice',
      '--', 'claude', '--resume', 's1',
    ],
  })
  expect(io.writes).toEqual(expect.arrayContaining([
    [expect.stringMatching(/freshellagentsboota1\.slice\/memory\.oom\.group$/), '0'],
    [expect.stringMatching(/agentleaf1\.slice\/memory\.oom\.group$/), '1'],
  ]))
})

it('serializes same and different aggregate requests and blocks changed limits while a zero-scope leaf exists', async () => {
  const io = fakeSystemdIo(['leaf1'])
  const control = new SystemdController(io, 'boot')
  await Promise.all([control.ensureAggregate(aggregateLimits), control.ensureAggregate(aggregateLimits)])
  expect(io.setPropertyCallsFor('freshellagentsboot.slice')).toHaveLength(1)
  await control.beginLogicalGroup('ordinary', { role: 'claude' }, leafLimits)
  await expect(control.ensureAggregate({ ...aggregateLimits, tasksMax: 99 }))
    .rejects.toMatchObject({ code: 'RESOURCE_LIMITS_ACTIVE' })
  expect(control.runningCount()).toBe(0)
  expect(control.hasTrackedGroups()).toBe(true)
})

it('verifies each unit against its own raw files and accepts an in-scope member when wrapper pid is outside', async () => {
  const { control, io, group, launch } = await verifiedFixture()
  io.procCgroup.set(999, '/outside.scope')
  io.scopeMembers.set(launch.scope, [1234])
  io.procCgroup.set(1234, io.scopePath(launch.scope))
  expect(await control.verifyProcess(group, launch, 999)).toEqual({ contained: true })
  io.raw.set(`${io.leafPath(group.unit)}/memory.max`, '999')
  expect((await control.verifyProcess(group, launch, 999)).reason).toMatch(/memory\.max/)
})
```

The same file must contain named cases for: empty/colliding token retry then `INVALID_UNIT_TOKEN`; different-limit idle reapply; leaf creation failure at each systemd/path/OOM step; traversal and sibling-prefix rejection; empty `cgroup.procs` bounded failure; `cpu.max` ratio math; aggregate OOM mismatch; leaf OOM mismatch; freeze confirms `frozen 1`; thaw confirms `frozen 0`; double/unknown release; empty-leaf abandon; explicit stop only; owned-only dispose; aggregate/leaf raw reads issued concurrently.

- [ ] **Step 2: Run Node controller tests and observe RED (2–5 min).**

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/resource-control-systemd.test.ts \
  test/unit/server/resource-control-controller.test.ts \
  --config config/vitest/vitest.server.config.ts --run
```

Expected: FAIL because both production modules are missing.

- [ ] **Step 3: Define exact controller errors, state, and IO seam (2–5 min).**

Start `server/resource-control/systemd.ts` with:

```ts
import type { ResourceLimitSet } from '../../shared/resource-limits.js'
import { isAtOrBelow, joinCgroupPath, parseControlGroup } from './cgroup-path.js'

export type ExecResult = { stdout: string; stderr: string }
export type SystemdIo = {
  execFile: (file: string, args: string[]) => Promise<ExecResult>
  readFile: (pathname: string) => Promise<string>
  writeFile: (pathname: string, value: string) => Promise<void>
  uuid: () => string
  sleep: (milliseconds: number) => Promise<void>
}

export class ResourceControlError extends Error {
  constructor(
    readonly code: 'INVALID_UNIT_TOKEN' | 'UNSUPPORTED' | 'PID_OUTSIDE_SCOPE' | 'PROPERTY_MISMATCH' | 'RESOURCE_LIMITS_ACTIVE' | 'IO',
    message: string,
  ) {
    super(message)
    this.name = 'ResourceControlError'
  }
}

type AggregateRecord = { group: AggregateGroup; limits: ResourceLimitSet; path: string }
type LeafRecord = {
  group: LogicalGroup
  limits: ResourceLimitSet
  path: string
  scopes: Set<string>
}
type Registry = {
  aggregate?: AggregateRecord
  leaves: Map<string, LeafRecord>
  scopeOwners: Map<string, string>
  liveScopeCount: number
}
```

Use these exact naming/property helpers:

```ts
function sanitizeToken(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function properties(limits: ResourceLimitSet): string[] {
  return [
    `CPUQuota=${limits.cpuQuotaMillis / 10}%`,
    `MemoryHigh=${limits.memoryHighBytes}`,
    `MemoryMax=${limits.memoryMaxBytes}`,
    `MemorySwapMax=${limits.swapMaxBytes}`,
    `TasksMax=${limits.tasksMax}`,
  ]
}
```

- [ ] **Step 4: Implement aggregate/leaf reservation and rollback (2–5 min).**

Use one promise chain—not one mutex per limit key—to serialize aggregate operations:

```ts
private aggregateFlight: Promise<void> = Promise.resolve()

private async withAggregateGate<T>(operation: () => Promise<T>): Promise<T> {
  const prior = this.aggregateFlight
  let release!: () => void
  this.aggregateFlight = new Promise<void>((resolve) => { release = resolve })
  await prior
  try { return await operation() } finally { release() }
}
```

`ensureAggregate` inside that gate must: compare all five values; return existing on equality; throw `RESOURCE_LIMITS_ACTIVE` when changed and `hasTrackedGroups`; issue one set-property/start for first creation; write/read `memory.oom.group=0`; cache validated ControlGroup path only after all checks pass. `beginLogicalGroup` must insert zero-scope reservation, issue five leaf properties/start, write/read `1`, and on any error stop the leaf and delete it before rethrowing. `reserveLaunchGroup` performs both under the same gate:

```ts
async reserveLaunchGroup(
  aggregateLimits: ResourceLimitSet,
  kind: GroupKind,
  metadata: GroupMetadata,
  leafLimits: ResourceLimitSet,
): Promise<LogicalGroup> {
  return this.withAggregateGate(async () => {
    await this.ensureAggregateUnlocked(aggregateLimits)
    return this.beginLogicalGroupUnlocked(kind, metadata, leafLimits)
  })
}
```

- [ ] **Step 5: Implement scope allocation, kernel verification, and O(1) release (2–5 min).**

Add a `usedTokens` set and a 32-attempt allocator:

```ts
private mintToken(): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const token = sanitizeToken(this.io.uuid())
    if (token && !this.usedTokens.has(token)) {
      this.usedTokens.add(token)
      return token
    }
  }
  throw new ResourceControlError('INVALID_UNIT_TOKEN', 'unable to mint a unique systemd unit token')
}
```

`wrapProcess` records scope owner/count and returns exact argv. `verifyProcess` concurrently reads ten aggregate/leaf limit files plus both OOM files, verifies hierarchy, then checks `/proc/<pid>/cgroup`; if outside, poll scope `cgroup.procs` every 25 ms for at most 500 ms and accept only a listed PID whose `/proc/<member>/cgroup` is at/below scope. `releaseProcess` is exactly:

```ts
async releaseProcess(scope: string): Promise<void> {
  const leafUnit = this.registry.scopeOwners.get(scope)
  if (!leafUnit) return
  this.registry.scopeOwners.delete(scope)
  const leaf = this.registry.leaves.get(leafUnit)
  if (!leaf || !leaf.scopes.delete(scope)) return
  this.registry.liveScopeCount -= 1
  if (leaf.scopes.size === 0) {
    await this.io.execFile('systemctl', ['--user', 'stop', leaf.group.unit])
    this.registry.leaves.delete(leaf.group.unit)
  }
}
```

- [ ] **Step 6: Implement the one launch transaction (2–5 min).**

Add to `systemd.ts`:

```ts
export class ContainedLaunchTransaction {
  private group?: LogicalGroup
  private launch?: ProcessLaunch
  private committed = false
  private rolledBack = false

  constructor(private readonly control: ResourceControl) {}

  async reserveGroup(
    aggregate: ResourceLimitSet,
    kind: GroupKind,
    metadata: GroupMetadata,
    leaf: ResourceLimitSet,
  ): Promise<LogicalGroup> {
    this.group = await this.control.reserveLaunchGroup(aggregate, kind, metadata, leaf)
    return this.group
  }

  wrap(role: string, argv: string[]): ProcessLaunch {
    if (!this.group) throw new ResourceControlError('IO', 'launch group was not reserved')
    this.launch = this.control.wrapProcess(this.group, role, argv)
    return this.launch
  }

  async verify(pid: number): Promise<void> {
    if (!this.group || !this.launch) throw new ResourceControlError('IO', 'process was not wrapped')
    const outcome = await this.control.verifyProcess(this.group, this.launch, pid)
    if (!outcome.contained) throw new ResourceControlError('PID_OUTSIDE_SCOPE', outcome.reason ?? 'process is outside scope')
  }

  commit(): { group: LogicalGroup; scope: string } {
    if (!this.group || !this.launch) throw new ResourceControlError('IO', 'launch is incomplete')
    this.committed = true
    return { group: this.group, scope: this.launch.scope }
  }

  async rollback(kill?: () => Promise<void> | void): Promise<void> {
    if (this.committed || this.rolledBack) return
    this.rolledBack = true
    await kill?.()
    if (this.launch) await this.control.releaseProcess(this.launch.scope)
    if (this.group) await this.control.abandonLogicalGroup(this.group)
  }
}
```

Add tests that defer verify, throw during spawn, throw during verify, and call rollback twice; each must observe one kill/release/abandon.

- [ ] **Step 7: Implement freeze/thaw/stop/dispose and production IO (2–5 min).**

`freezeGroup` and `thawGroup` write leaf `cgroup.freeze` and bounded-poll cached leaf `cgroup.events` until exact `frozen 1`/`0`. `stopGroup` issues only `systemctl --user stop <leaf>`. `dispose` snapshots tracked leaves, stops each, then aggregate, and clears registry.

Create `server/resource-control/controller.ts`:

```ts
import { execFile as execFileCallback } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { SystemdController, type SystemdIo } from './systemd.js'

const execFile = promisify(execFileCallback)

export function createProductionSystemdController(
  bootId: string,
  overrides: Partial<SystemdIo> = {},
): SystemdController {
  const io: SystemdIo = {
    execFile: async (file, args) => execFile(file, args),
    readFile: (pathname) => readFile(pathname, 'utf8'),
    writeFile: (pathname, value) => writeFile(pathname, value, 'utf8'),
    uuid: randomUUID,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    ...overrides,
  }
  return new SystemdController(io, bootId)
}
```

- [ ] **Step 8: Run focused controller tests and observe GREEN (2–5 min).**

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/resource-control-systemd.test.ts \
  test/unit/server/resource-control-controller.test.ts \
  --config config/vitest/vitest.server.config.ts --run
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run typecheck
```

Expected: both test files PASS; typecheck exits 0; no command invokes `sh`, `/bin/sh`, or `exec`.

- [ ] **Step 9: Commit the Node controller slice (2–5 min).**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add \
  server/resource-control/systemd.ts server/resource-control/controller.ts \
  test/unit/server/resource-control-systemd.test.ts \
  test/unit/server/resource-control-controller.test.ts
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment diff --cached --check
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit \
  -m "feat(server): add systemd logical resource-group controller" \
  -m "Generated with Amplifier: https://github.com/microsoft/amplifier" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

### Task 7: Rust Systemd Controller and Launch Transaction

**User stories / highest-level proof:** Rust mechanism parity for US-06 through US-15. The ignored live test is deferred only to Task 15 because the controller must first exist; no behavior is deferred.

**Files:**
- Create: `crates/freshell-resource-control/src/systemd.rs`
- Create: `crates/freshell-resource-control/src/controller.rs`
- Modify: `crates/freshell-resource-control/src/lib.rs`
- Modify: `crates/freshell-resource-control/Cargo.toml`
- Modify: `Cargo.lock`

**Interfaces:**
- Consumes: Task 3 limits; Task 4 Rust cgroup paths.
- Produces: exact Rust trait/error types declared globally, `SystemdController<I: SystemdIo>`, `LaunchTransaction`, and `create_production_systemd_controller(boot_id)`.

- [ ] **Step 1: Write failing Rust topology/concurrency tests (2–5 min).**

In `src/systemd.rs`, add a `#[cfg(test)]` module with `FakeIo` and named tests for every Task 6 case. The first test must assert:

```rust
#[tokio::test]
async fn aggregate_leaf_scope_have_exact_names_properties_and_oom_policy() {
    let io = FakeIo::with_ids(["leaf1", "scope1"]);
    let control = SystemdController::new(io.clone(), "BOOT-A1".into()).expect("controller");
    let aggregate = control.ensure_aggregate(&aggregate_limits()).await.expect("aggregate");
    let group = control.begin_logical_group(
        GroupKind::Ordinary,
        GroupMetadata { role: "claude".into(), pane_id: None, session_id: None, label: None },
        &leaf_limits(),
    ).await.expect("leaf");
    let launch = control.wrap_process(&group, "claude", &["claude".into()]).expect("scope");
    assert_eq!(aggregate.unit, "freshellagentsboota1.slice");
    assert_eq!(group.unit, "freshellagentsboota1-agentleaf1.slice");
    assert_eq!(launch.scope, "freshellagentprocscope1.scope");
    assert_eq!(launch.file, "systemd-run");
    assert_eq!(launch.args, vec![
        "--user", "--scope", "--collect", "--quiet",
        "--unit=freshellagentprocscope1.scope",
        "--slice=freshellagentsboota1-agentleaf1.slice",
        "--", "claude",
    ]);
    assert_eq!(io.oom_writes(), vec![(aggregate.unit, "0".into()), (group.unit, "1".into())]);
}
```

- [ ] **Step 2: Run Rust controller tests and observe RED (2–5 min).**

```bash
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-resource-control systemd:: -- --nocapture
```

Expected: compile FAIL because `systemd` module and controller types do not exist.

- [ ] **Step 3: Define exact Rust traits/state/error-safe construction (2–5 min).**

Create `src/systemd.rs` with the global `ResourceControl` trait and errors plus:

```rust
#[async_trait::async_trait]
pub trait SystemdIo: Send + Sync + 'static {
    async fn exec_file(&self, file: &str, args: &[String]) -> Result<String, ResourceControlError>;
    async fn read_file(&self, path: &std::path::Path) -> Result<String, ResourceControlError>;
    async fn write_file(&self, path: &std::path::Path, value: &str) -> Result<(), ResourceControlError>;
    fn uuid(&self) -> String;
    async fn sleep(&self, duration: std::time::Duration);
}

pub struct SystemdController<I: SystemdIo> {
    io: Arc<I>,
    server_token: String,
    used_tokens: std::sync::Mutex<std::collections::HashSet<String>>,
    registry: std::sync::Mutex<Registry>,
    aggregate_gate: tokio::sync::Mutex<()>,
}
```

`new` sanitizes server token and returns `InvalidUnitToken` if empty. `mint_token` tries exactly 32 times under `used_tokens`; registry guards are dropped before every `.await`.

- [ ] **Step 4: Implement Rust unit operations and verification (2–5 min).**

Implement these explicit operations: acquire `aggregate_gate`; compare all five fields; on first aggregate run `systemctl --user set-property --runtime <unit>` with the five strings below, then `systemctl --user start <unit>`, resolve and validate `ControlGroup`, write/read aggregate `memory.oom.group=0`, and publish registry state; on an idle change rerun set-property/readback without stop/start; on a tracked leaf return `LimitsActive`. Leaf creation inserts a zero-scope reservation, runs set-property/start, validates its descendant path, writes/reads `memory.oom.group=1`, and on any failure stops and deletes only that leaf. Scope allocation records its reverse owner/count before returning exact `systemd-run` argv. Verification reads aggregate and leaf `cpu.max`, `memory.high`, `memory.max`, `memory.swap.max`, `pids.max`, and `memory.oom.group` with `tokio::try_join!`, validates hierarchy, then checks the PID or bounded `cgroup.procs` fallback. Use this exact property helper:

```rust
fn properties(limits: &ResourceLimitSet) -> Vec<String> {
    vec![
        format!("CPUQuota={}%", limits.cpu_quota_millis / 10),
        format!("MemoryHigh={}", limits.memory_high_bytes),
        format!("MemoryMax={}", limits.memory_max_bytes),
        format!("MemorySwapMax={}", limits.swap_max_bytes),
        format!("TasksMax={}", limits.tasks_max),
    ]
}
```

`verify_process` uses `tokio::try_join!` for independent aggregate/leaf raw reads, parses CPU with `u128`, validates aggregate/leaf/scope hierarchy through `cgroup_path`, and bounded-polls `cgroup.procs` for 500 ms at 25 ms intervals.

- [ ] **Step 5: Add the exact Rust LaunchTransaction (2–5 min).**

```rust
pub struct LaunchTransaction {
    control: Arc<dyn ResourceControl>,
    group: Option<LogicalGroup>,
    launch: Option<ProcessLaunch>,
    committed: bool,
    rolled_back: bool,
}

impl LaunchTransaction {
    pub fn new(control: Arc<dyn ResourceControl>) -> Self {
        Self { control, group: None, launch: None, committed: false, rolled_back: false }
    }

    pub async fn reserve_group(&mut self, aggregate: &ResourceLimitSet, kind: GroupKind, metadata: GroupMetadata, leaf: &ResourceLimitSet) -> Result<LogicalGroup, ResourceControlError> {
        let group = self.control.reserve_launch_group(aggregate, kind, metadata, leaf).await?;
        self.group = Some(group.clone());
        Ok(group)
    }

    pub fn wrap(&mut self, role: &str, argv: &[String]) -> Result<ProcessLaunch, ResourceControlError> {
        let group = self.group.as_ref().ok_or_else(|| ResourceControlError::Io("launch group was not reserved".into()))?;
        let launch = self.control.wrap_process(group, role, argv)?;
        self.launch = Some(launch.clone());
        Ok(launch)
    }

    pub async fn verify(&self, pid: u32) -> Result<(), ResourceControlError> {
        let group = self.group.as_ref().ok_or_else(|| ResourceControlError::Io("launch group was not reserved".into()))?;
        let launch = self.launch.as_ref().ok_or_else(|| ResourceControlError::Io("process was not wrapped".into()))?;
        let outcome = self.control.verify_process(group, launch, pid).await?;
        if outcome.contained { Ok(()) } else { Err(ResourceControlError::PidOutsideScope) }
    }

    pub fn commit(&mut self) -> Result<(LogicalGroup, String), ResourceControlError> {
        self.committed = true;
        Ok((
            self.group.clone().ok_or_else(|| ResourceControlError::Io("launch group was not reserved".into()))?,
            self.launch.as_ref().ok_or_else(|| ResourceControlError::Io("process was not wrapped".into()))?.scope.clone(),
        ))
    }

    pub async fn rollback<F>(&mut self, kill: F) -> Result<(), ResourceControlError>
    where F: FnOnce() + Send {
        if self.committed || self.rolled_back { return Ok(()); }
        self.rolled_back = true;
        kill();
        if let Some(launch) = &self.launch { self.control.release_process(&launch.scope).await?; }
        if let Some(group) = &self.group { self.control.abandon_logical_group(group).await?; }
        Ok(())
    }
}
```

- [ ] **Step 6: Add production Tokio IO and exports (2–5 min).**

Create `src/controller.rs` with `TokioSystemdIo`; execute commands only through `tokio::process::Command::new(file).args(args).output()`, and use `tokio::fs::read_to_string`/`write`. Export:

```rust
pub fn create_production_systemd_controller(
    boot_id: String,
) -> Result<Arc<dyn ResourceControl>, ResourceControlError> {
    Ok(Arc::new(SystemdController::new(Arc::new(TokioSystemdIo), boot_id)?))
}
```

Update `src/lib.rs`:

```rust
pub mod controller;
pub mod systemd;

pub use controller::create_production_systemd_controller;
pub use systemd::{
    AggregateGroup, ExitClassification, ExitInfo, GroupKind, GroupMetadata,
    LaunchTransaction, LogicalGroup, MemorySnapshot, ProcessLaunch, ResourceControl,
    ResourceControlError, SystemdController, SystemdIo, VerifyOutcome,
};
```

- [ ] **Step 7: Run Rust controller/parity gates and observe GREEN (2–5 min).**

```bash
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-resource-control
cargo +1.96.0 clippy --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-resource-control --all-targets -- -D warnings
cargo +1.96.0 check --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml --workspace
```

Expected: all commands PASS; no production `unwrap`/`expect`; fake command order equals Node tests.

- [ ] **Step 8: Commit the Rust controller slice (2–5 min).**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add \
  crates/freshell-resource-control/src/systemd.rs \
  crates/freshell-resource-control/src/controller.rs \
  crates/freshell-resource-control/src/lib.rs \
  crates/freshell-resource-control/Cargo.toml Cargo.lock
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment diff --cached --check
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit \
  -m "feat(rust): add systemd resource-control core" \
  -m "Generated with Amplifier: https://github.com/microsoft/amplifier" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

### Task 8: Route Every Registered PTY and Recovery Generation

**User stories / highest-level proof:** US-06 and US-07. Real Node ingress/Rust WS+REST tests prove only future registered non-interop agents are contained and every current PTY spawn/recovery path is covered.

**Files:**
- Modify: `server/terminal-registry.ts:147-167,570-667,828-835,1598-1936,3669-3931`
- Modify: `server/index.ts:250-315,405-468`
- Modify: `server/ws-handler.ts:614-651,2609`
- Modify: `server/agent-api/router.ts:744,1185,1342,1579`
- Create: `test/unit/server/terminal-registry.resource-control.test.ts`
- Modify: `test/unit/server/terminal-registry.test.ts`
- Modify: `crates/freshell-ws/Cargo.toml`
- Modify: `crates/freshell-ws/src/lib.rs:90-177,248-305`
- Modify: `crates/freshell-ws/src/terminal.rs:2270-3372,3384-3850`
- Modify: `crates/freshell-freshagent/Cargo.toml`
- Modify: `crates/freshell-freshagent/src/lib.rs:154-317,378-610`
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs:70-78,1480-2160`
- Do not modify: `crates/freshell-terminal/src/registry.rs`, `crates/freshell-terminal/src/pty.rs` in this task.

**Interfaces:**
- Consumes: Task 6/7 controller/transaction; existing provider registries; Task 3 live limits provider.
- Produces: Node `createWithResourceControl(opts, internal?)`; Rust `spawn_registered_terminal_with_resource_control`; contained generation metadata and exact `RESOURCE_CONTAINMENT_FAILED` errors after rollback.

- [ ] **Step 1: Write failing eligibility/rollback tests (2–5 min).**

Create `test/unit/server/terminal-registry.resource-control.test.ts` with `node-pty` fake and `it.each(['claude','codex','opencode','futureagent'])`. Assert sequence `reserve,wrap,spawn,verify,created`; shell and `/mnt/c/tool.EXE` call none; missing deps throws before spawn; direct `create` throws `ResourceControlBypassError`; verify false kills/release/abandon once and emits no `terminal.created`; pre-enable raw terminal remains raw after enable; Node Codex recovery receives a fresh leaf/scope and never reuses old names.

The critical exact test is:

```ts
await expect(registry.createWithResourceControl({ mode: 'futureagent', cwd: '/tmp' }))
  .resolves.toMatchObject({ mode: 'futureagent', resourceScope: 'scope-1' })
expect(calls).toEqual(['reserve', 'wrap', 'spawn', 'verify', 'commit', 'created'])
```

- [ ] **Step 2: Run Node/Rust routing suites and observe RED (2–5 min).**

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/terminal-registry.resource-control.test.ts \
  test/unit/server/terminal-registry.test.ts \
  --config config/vitest/vitest.server.config.ts --run
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-ws -p freshell-freshagent
```

Expected: Node compile FAIL for missing method/options; Rust compile/test FAIL for missing state seam.

- [ ] **Step 3: Add Node eligibility, bypass, and async wrapper (2–5 min).**

Add:

```ts
import path from 'node:path'
import type { CodingAgentResourceLimits } from '../shared/resource-limits.js'
import { ContainedLaunchTransaction, type LogicalGroup, type ResourceControl } from './resource-control/systemd.js'

export function isWindowsInteropCommand(file: string): boolean {
  return path.basename(file).toLowerCase().endsWith('.exe')
}

export class ResourceControlBypassError extends Error {
  readonly code = 'RESOURCE_CONTROL_BYPASS'
}

export class ResourceContainmentLaunchError extends Error {
  readonly code = 'RESOURCE_CONTAINMENT_FAILED'
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'ResourceContainmentLaunchError'
  }
}
```

Extend options/record:

```ts
resourceControl?: ResourceControl
resourceLimits?: () => CodingAgentResourceLimits | undefined
containmentEnabled?: () => boolean
```

```ts
resourceGroup?: LogicalGroup
resourceScope?: string
```

At the top of direct `create`:

```ts
const prepared = this.prepareLaunch(opts)
if (this.isContainmentEligible(opts.mode, prepared.file)) {
  throw new ResourceControlBypassError('enabled registered coding-agent launch bypassed createWithResourceControl')
}
return this.spawnAndRegister(prepared, opts, true)
```

Implement async flow:

```ts
async createWithResourceControl(
  opts: CreateTerminalOptions,
  internal: { callerGroup?: LogicalGroup; containmentForcedOff?: boolean } = {},
): Promise<TerminalRecord> {
  const prepared = this.prepareLaunch(opts)
  if (internal.containmentForcedOff || !this.isContainmentEligible(opts.mode, prepared.file)) {
    return this.spawnAndRegister(prepared, opts, true)
  }
  const control = this.options.resourceControl
  const limits = this.options.resourceLimits?.()
  if (!control || !limits) throw new ResourceControlError('IO', 'resource containment is enabled but unavailable')
  const transaction = new ContainedLaunchTransaction(control)
  let record: TerminalRecord | undefined
  try {
    const group = internal.callerGroup ?? await transaction.reserveGroup(
      limits.allAgents, 'ordinary', { role: opts.mode, paneId: opts.envContext?.paneId }, limits.eachAgent,
    )
    if (internal.callerGroup) transaction.adoptGroup(group)
    const launch = transaction.wrap(opts.mode, [prepared.file, ...prepared.args])
    record = this.spawnAndRegister({ ...prepared, file: launch.file, args: launch.args }, opts, false)
    await transaction.verify(record.pty.pid)
    const committed = transaction.commit()
    record.resourceGroup = committed.group
    record.resourceScope = committed.scope
    this.emit('terminal.created', record)
    return record
  } catch (error) {
    await transaction.rollback(() => record ? this.killAndWait(record.terminalId) : undefined)
    throw new ResourceContainmentLaunchError(error)
  }
}
```

Add this exact caller-owned group setter to Task 6 transaction; it allocates no leaf and is valid only before wrap:

```ts
adoptGroup(group: LogicalGroup): void {
  if (this.group || this.launch || this.committed || this.rolledBack) {
    throw new ResourceControlError('IO', 'launch transaction already owns state')
  }
  this.group = group
}
```

- [ ] **Step 4: Change every Node production PTY call and recovery spawn (2–5 min).**

Use exact replacements:

```diff
-const record = this.registry.create({
+const record = await this.registry.createWithResourceControl({
```

at WS `terminal.create`, and:

```diff
-const terminal = registry.create({
+const terminal = await registry.createWithResourceControl({
```

at all four Agent API calls (`POST /api/tabs`, `/api/run`, pane split, pane respawn). Move `bootId` creation to `server/index.ts`, inject it into WsHandler and controller, and inject live limits getters.

Refactor `spawnCodexRecoveryPty` to return a promise and call `createWithResourceControl` with a new generation intent; publish candidate only after verify, then retire old PTY/leaf. The old and candidate may overlap only across distinct leaves during the verified switch.

- [ ] **Step 5: Add Rust live dependencies and helper fields (2–5 min).**

Add `freshell-resource-control` dependency to WS/freshagent crates. Add defaultable fields to both states:

```rust
pub resource_control: Option<Arc<dyn freshell_resource_control::ResourceControl>>,
pub resource_limits: Arc<dyn Fn() -> Option<freshell_protocol::CodingAgentResourceLimits> + Send + Sync>,
```

Production wires Task 3 provider. Test constructors use `Arc::new(|| None)`; enabled eligibility still fails closed when provider says enabled and controller is absent.

- [ ] **Step 6: Wrap Rust WS/REST/auto-respawn registry calls (2–5 min).**

Define these exact private records and helper in each owning crate:

```rust
struct ContainmentLaunchState<'a> {
    registry: &'a freshell_terminal::TerminalRegistry,
    resource_control: Option<Arc<dyn ResourceControl>>,
    resource_limits: &'a (dyn Fn() -> Option<CodingAgentResourceLimits> + Send + Sync),
    registered_modes: &'a [String],
}

struct PreparedTerminalSpawn {
    spec: freshell_platform::spawn::SpawnSpec,
    env: std::collections::BTreeMap<String, String>,
    terminal_id: String,
    stream_id: String,
    mode: String,
    resume_session_id: Option<String>,
    create_request_id: Option<String>,
    ring_max_bytes: Option<i64>,
    on_exit: Option<freshell_terminal::pty::ExitHook>,
    pane_id: Option<String>,
}

struct ContainedTerminal {
    terminal_id: String,
    group: Option<LogicalGroup>,
    scope: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("RESOURCE_CONTAINMENT_FAILED: {0}")]
struct ResourceContainmentLaunchError(String);
```

```rust
async fn spawn_registered_terminal_with_resource_control(
    state: &ContainmentLaunchState<'_>,
    mut prepared: PreparedTerminalSpawn,
    caller_group: Option<LogicalGroup>,
) -> Result<ContainedTerminal, ResourceContainmentLaunchError> {
    let basename = std::path::Path::new(&prepared.spec.program)
        .file_name().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    let registered = state.registered_modes.iter().any(|mode| mode == &prepared.mode);
    let limits = (state.resource_limits)();
    let eligible = limits.as_ref().is_some_and(|value| value.enabled)
        && prepared.mode != "shell" && registered && !basename.ends_with(".exe");
    if !eligible {
        let terminal_id = prepared.terminal_id.clone();
        spawn_prepared_terminal(state.registry, prepared).await
            .map_err(|error| ResourceContainmentLaunchError(error.to_string()))?;
        return Ok(ContainedTerminal { terminal_id, group: None, scope: None });
    }
    let limits = limits.ok_or_else(|| ResourceContainmentLaunchError("enabled limits unavailable".into()))?;
    let control = state.resource_control.clone()
        .ok_or_else(|| ResourceContainmentLaunchError("enabled controller unavailable".into()))?;
    let mut transaction = LaunchTransaction::new(control);
    let group = match caller_group {
        Some(group) => { transaction.adopt_group(group.clone())?; group }
        None => transaction.reserve_group(
            &limits.all_agents, GroupKind::Ordinary,
            GroupMetadata { role: prepared.mode.clone(), pane_id: prepared.pane_id.clone(), session_id: None, label: None },
            &limits.each_agent,
        ).await.map_err(|error| ResourceContainmentLaunchError(error.to_string()))?,
    };
    let mut argv = vec![prepared.spec.program.clone()];
    argv.extend(prepared.spec.args.clone());
    let launch = transaction.wrap(&prepared.mode, &argv)
        .map_err(|error| ResourceContainmentLaunchError(error.to_string()))?;
    prepared.spec.program = launch.file.clone();
    prepared.spec.args = launch.args.clone();
    let terminal_id = prepared.terminal_id.clone();
    if let Err(error) = spawn_prepared_terminal(state.registry, prepared).await {
        transaction.rollback(|| {}).await
            .map_err(|rollback| ResourceContainmentLaunchError(rollback.to_string()))?;
        return Err(ResourceContainmentLaunchError(error.to_string()));
    }
    let pid = state.registry.pid_of(&terminal_id)
        .ok_or_else(|| ResourceContainmentLaunchError("registry returned no pid".into()))?;
    if let Err(error) = transaction.verify(pid).await {
        let terminal_id_for_kill = terminal_id.clone();
        transaction.rollback(|| { let _ = state.registry.kill(&terminal_id_for_kill); }).await
            .map_err(|rollback| ResourceContainmentLaunchError(rollback.to_string()))?;
        return Err(ResourceContainmentLaunchError(error.to_string()));
    }
    let (_, scope) = transaction.commit()
        .map_err(|error| ResourceContainmentLaunchError(error.to_string()))?;
    Ok(ContainedTerminal { terminal_id, group: Some(group), scope: Some(scope) })
}
```

Define the extraction explicitly; it calls the unchanged synchronous registry API inside `spawn_blocking` and publishes no frame:

```rust
async fn spawn_prepared_terminal(
    registry: &freshell_terminal::TerminalRegistry,
    prepared: PreparedTerminalSpawn,
) -> std::io::Result<()> {
    let registry = registry.clone();
    tokio::task::spawn_blocking(move || {
        registry.create(
            &prepared.spec,
            &prepared.env,
            prepared.terminal_id,
            prepared.stream_id,
            &prepared.mode,
            prepared.resume_session_id.as_deref(),
            prepared.create_request_id.as_deref(),
            prepared.ring_max_bytes,
            prepared.on_exit,
        )
    }).await.map_err(|error| std::io::Error::other(error.to_string()))?
}
```

Publication remains in the caller after this helper returns successfully.

Call this helper from:

```rust
handle_create
spawn_terminal_pane
respawn_agent_terminal
```

Auto-respawn always reserves a new generation leaf and passes a fresh group ID to coordinator; it never reuses the crashed leaf.

- [ ] **Step 7: Run all routing tests and observe GREEN (2–5 min).**

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/terminal-registry.resource-control.test.ts \
  test/unit/server/terminal-registry.test.ts \
  --config config/vitest/vitest.server.config.ts --run
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-ws -p freshell-freshagent
```

Expected: new and legacy suites PASS; direct low-level Rust registry tests remain unchanged.

- [ ] **Step 8: Commit complete PTY coverage (2–5 min).**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add \
  server/terminal-registry.ts server/index.ts server/ws-handler.ts server/agent-api/router.ts \
  test/unit/server/terminal-registry.resource-control.test.ts test/unit/server/terminal-registry.test.ts \
  crates/freshell-ws/Cargo.toml crates/freshell-ws/src/lib.rs crates/freshell-ws/src/terminal.rs \
  crates/freshell-freshagent/Cargo.toml crates/freshell-freshagent/src/lib.rs \
  crates/freshell-freshagent/src/terminal_tabs.rs Cargo.lock
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment diff --cached --check
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit \
  -m "feat(terminal): contain registered coding-agent PTYs" \
  -m "Generated with Amplifier: https://github.com/microsoft/amplifier" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

### Task 9: Managed Codex Sidecar and PTY Share One Leaf

**User stories / highest-level proof:** US-07, specifically the two-process Codex generation. Agent API integration proves one leaf/two scopes and teardown before pending registration.

**Files:**
- Modify: `server/coding-cli/codex-app-server/runtime.ts:1457-2010`
- Modify: `server/coding-cli/codex-app-server/launch-planner.ts:17-57,130-322`
- Modify: `server/terminal-registry.ts`
- Modify: `server/ws-handler.ts:2532-2698`
- Modify: `server/agent-api/router.ts:250-264,695-831`
- Modify: Node Codex tests/fake planner and `test/server/agent-tabs-write.test.ts`
- Modify: `crates/freshell-codex/Cargo.toml`
- Modify: `crates/freshell-codex/src/launch_plan.rs`
- Modify: `crates/freshell-codex/src/launch_lifecycle.rs:600-1430`
- Modify: `crates/freshell-ws/src/terminal.rs`
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs`

**Interfaces:**
- Consumes: Task 8 `callerGroup` and Task 6/7 transactions.
- Produces: internal `ReadyState.resourceGroup`, `CodexLaunchPlan.resourceGroup`, sidecar scope release in the existing sidecar owner, and conditional shutdown retention (`contained => teardown`, `uncontained => current retention`).

- [ ] **Step 1: Add failing one-leaf/two-scope tests (2–5 min).**

Add these concrete test cases in the named existing suites:

```text
contained_codex_plan_threads_one_group_to_pty
sidecar_verify_failure_never_spawns_pty
pty_verify_failure_awaits_existing_sidecar_shutdown
contained_codex_shutdown_reaps_sidecar_instead_of_retaining_it
uncontained_codex_shutdown_keeps_existing_retention_behavior
```

The Agent API assertion must be:

```ts
expect(resourceControl.reserveLaunchGroup).toHaveBeenCalledTimes(1)
expect(resourceControl.wrapProcess.mock.calls.map((call) => call[1])).toEqual(['codex-sidecar', 'codex-pty'])
expect(sidecarScope).not.toBe(ptyScope)
expect(sidecarGroup.unit).toBe(ptyGroup.unit)
```

- [ ] **Step 2: Run Codex tests and observe RED (2–5 min).**

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/coding-cli/codex-app-server/runtime.test.ts \
  test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts \
  test/unit/server/terminal-registry.codex-sidecar.test.ts \
  test/server/agent-tabs-write.test.ts \
  --config config/vitest/vitest.server.config.ts --run
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-codex -p freshell-ws -p freshell-freshagent
```

Expected: FAIL because readiness/plan carry no resource group.

- [ ] **Step 3: Contain the Node sidecar in its existing owner (2–5 min).**

Add fields directly to the current declarations without creating wrapper aliases:

```diff
 type ReadyState = {
   wsUrl: string
   processPid: number
   ownershipId: string
   processGroupId: number
   metadataPath: string
+  resourceGroup?: LogicalGroup
+  resourceScope?: string
 }
@@
 export type CodexLaunchPlan = {
   sessionId?: string
   remote: { wsUrl: string }
   sidecar: CodexLaunchSidecar
+  resourceGroup?: LogicalGroup
 }
```

Add the controller/live-provider dependencies to `RuntimeOptions`, class fields, and constructor:

```diff
 type RuntimeOptions = {
+  resourceControl?: ResourceControl
+  resourceLimits?: () => CodingAgentResourceLimits | undefined
@@
 export class CodexAppServerRuntime {
+  private readonly resourceControl?: ResourceControl
+  private readonly resourceLimits?: () => CodingAgentResourceLimits | undefined
@@
 constructor(options: RuntimeOptions = {}) {
+  this.resourceControl = options.resourceControl
+  this.resourceLimits = options.resourceLimits
```

Use NodeNext imports:

```ts
import type { CodingAgentResourceLimits } from '../../../shared/resource-limits.js'
import {
  ContainedLaunchTransaction,
  type LogicalGroup,
  type ResourceControl,
} from '../../resource-control/systemd.js'
```

In `startRuntime`, replace the current `const child = this.spawnProcess(this.command, [...], options)` block with this grounded patch; all names are already local at that exact seam:

```diff
+      const originalArgs = [
+        ...this.commandArgs,
+        ...CODEX_MANAGED_REMOTE_CONFIG_ARGS,
+        'app-server',
+        '--listen',
+        wsUrl,
+      ]
+      const limits = this.resourceLimits?.()
+      const transaction = limits?.enabled && this.resourceControl
+        ? new ContainedLaunchTransaction(this.resourceControl)
+        : undefined
+      if (transaction && limits) {
+        await transaction.reserveGroup(
+          limits.allAgents,
+          'ordinary',
+          { role: 'codex-sidecar', label: 'Codex' },
+          limits.eachAgent,
+        )
+      }
+      const launch = transaction
+        ? transaction.wrap('codex-sidecar', [this.command, ...originalArgs])
+        : { file: this.command, args: originalArgs }
-      const child = this.spawnProcess(this.command, [
-        ...this.commandArgs,
-        ...CODEX_MANAGED_REMOTE_CONFIG_ARGS,
-        'app-server',
-        '--listen',
-        wsUrl,
-      ], {
+      const child = this.spawnProcess(launch.file, launch.args, {
         detached: true,
         ...(cwd.launchCwd ? { cwd: cwd.launchCwd } : {}),
         env: {
           ...process.env,
           ...this.env,
           FRESHELL_CODEX_SIDECAR_ID: ownershipId,
         },
         stdio: ['ignore', 'pipe', 'pipe'],
       })
```

Immediately after the existing `if (!child.pid) ...` block and before ownership metadata publication, add:

```ts
if (transaction) await transaction.verify(child.pid)
```

Replace the existing successful `return { wsUrl, ... }` with:

```ts
const resourceOwnership = transaction?.commit()
return {
  wsUrl,
  processPid: child.pid,
  codexHome: initialized.codexHome,
  ownershipId,
  processGroupId: child.pid,
  metadataPath: ownership.metadataPath,
  ...(resourceOwnership ? {
    resourceGroup: resourceOwnership.group,
    resourceScope: resourceOwnership.scope,
  } : {}),
}
```

At the beginning of the existing per-attempt `catch`, before error classification/teardown, add:

```ts
await transaction?.rollback(() => this.stopActiveChild())
```

At `shutdown()`, capture ownership before clearing `this.ready`, then release only after the existing child/pending teardown has completed:

```diff
 async shutdown(): Promise<void> {
   this.shutdownRequested = true
   try {
     const pendingReady = this.ensureReadyPromise
+    const resourceScope = this.ready?.resourceScope
     this.ready = null
@@
     await this.stopActiveChild()
     await pendingReady?.catch(() => undefined)
     await this.stopActiveChild()
+    if (resourceScope) await this.resourceControl?.releaseProcess(resourceScope)
     await this.assertNoBlockedOwnership('shut down Codex app-server sidecar')
```

Planner copies `ready.resourceGroup` into each returned plan. PTY creation passes:

```ts
await registry.createWithResourceControl(createOptions, {
  callerGroup: plan.resourceGroup,
})
```

On PTY failure, await PTY rollback, then `plan.sidecar.shutdown()`, then register pending in Task 12 hook.

- [ ] **Step 4: Apply the Rust internal group threading and retention rule (2–5 min).**

Add `resource_group: Option<LogicalGroup>` to successful runtime/launch types. `SpawnedCodexAppServerRuntime::ensure_ready` uses role `codex-sidecar`; launch manager passes group to WS/REST PTY helper. Existing sidecar shutdown releases scope. In server-shutdown retention:

```rust
if entry.resource_group.is_some() {
    entry.sidecar.shutdown().await?;
} else {
    entry.sidecar.prepare_retention("server-shutdown".into()).await?;
}
```

This is the explicit candidate resolution for boot-scoped aggregates: contained sidecars are reaped; current uncontained retention remains.

- [ ] **Step 5: Run Codex tests and observe GREEN (2–5 min).**

Run:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/coding-cli/codex-app-server/runtime.test.ts \
  test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts \
  test/unit/server/terminal-registry.codex-sidecar.test.ts \
  test/server/agent-tabs-write.test.ts \
  --config config/vitest/vitest.server.config.ts --run
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-codex -p freshell-ws -p freshell-freshagent
```

Expected: all Node and Rust Codex/PTY suites PASS; verify ordering is sidecar then PTY; failure emits no created event.

- [ ] **Step 6: Commit the Codex generation slice (2–5 min).**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add \
  server/coding-cli/codex-app-server/runtime.ts \
  server/coding-cli/codex-app-server/launch-planner.ts \
  server/terminal-registry.ts server/ws-handler.ts server/agent-api/router.ts \
  test/unit/server/coding-cli/codex-app-server/runtime.test.ts \
  test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts \
  test/unit/server/terminal-registry.codex-sidecar.test.ts \
  test/helpers/coding-cli/fake-codex-launch-planner.ts test/server/agent-tabs-write.test.ts \
  crates/freshell-codex crates/freshell-ws/src/terminal.rs \
  crates/freshell-freshagent/src/terminal_tabs.rs Cargo.lock
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment diff --cached --check
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit \
  -m "feat(codex): share one containment leaf between sidecar and PTY" \
  -m "Generated with Amplifier: https://github.com/microsoft/amplifier" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

### Task 10: Fresh Claude, Kilroy, and Fresh Codex Roots

**User stories / highest-level proof:** US-07 for fresh roots. Existing real adapter paths plus injected child/iterator tests prove verification gates readiness and every pre-spawn termination rolls back.

**Files:**
- Modify: `shared/ws-protocol.ts:471-490` (add optional `paneId`)
- Modify: `server/fresh-agent/runtime-adapter.ts:4-22`
- Modify: `server/agent-api/layout-store.ts` (verified request-to-pane lookup)
- Modify: `server/sdk-bridge.ts:50-105,157-249,682-701,817-821`
- Modify: Claude/Codex adapters and `server/index.ts`
- Create: `test/unit/server/fresh-agent/resource-control.test.ts`
- Modify: existing SDK/adapter tests
- Modify: `crates/freshell-freshagent/src/lib.rs`, `claude.rs:1382-1655`, `codex.rs:1930-2095`, and tests

**Interfaces:**
- Consumes: Task 6/7 transactions, Task 3 live limits, layout snapshots.
- Produces: verified server-owned pane correlation and one ordinary root scope per Fresh Claude/Kilroy/Fresh Codex session.

- [ ] **Step 1: Add failing root lifecycle tests (2–5 min).**

Create tests named:

```text
fresh_root_waits_for_containment_verification_before_ready
false_verify_kills_releases_and_emits_no_created
exit_racing_verify_releases_once
empty_query_stream_abandons_reserved_group
throwing_query_stream_abandons_reserved_group
startup_deadline_abandons_reserved_group
abort_abandons_reserved_group
synchronous_spawn_throw_abandons_reserved_group
fresh_codex_create_and_resume_use_the_same_contained_process_seam
pane_id_must_match_layout_create_request_id
```

Use a native-child-shaped `EventEmitter`, deferred verify promise, and SDK iterator fakes from existing tests.

- [ ] **Step 2: Run Fresh root tests and observe RED (2–5 min).**

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/fresh-agent/resource-control.test.ts \
  test/unit/server/sdk-bridge.test.ts \
  test/unit/server/fresh-agent/claude-adapter.test.ts \
  test/unit/server/fresh-agent/codex-adapter.test.ts \
  --config config/vitest/vitest.server.config.ts --run
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-freshagent
```

Expected: FAIL because bridge/root spawners have no containment deps.

- [ ] **Step 3: Add verified server-owned pane correlation (2–5 min).**

Add optional `paneId` to fresh create wire/request. Add to LayoutStore:

```ts
findPaneForCreate(requestId: string, claimedPaneId?: string): { tabId: string; paneId: string } | undefined {
  for (const tab of this.snapshot?.tabs ?? []) {
    const leaves = flattenLeaves(this.snapshot?.layouts[tab.id])
    for (const leaf of leaves) {
      const content = leaf.content as { createRequestId?: string } | undefined
      if (content?.createRequestId === requestId && (!claimedPaneId || leaf.id === claimedPaneId)) {
        return { tabId: tab.id, paneId: leaf.id }
      }
    }
  }
  return undefined
}
```

Containment-enabled create rejects unverified correlation before reservation; existing clients can omit paneId because server searches by `createRequestId`.

- [ ] **Step 4: Extend SdkBridge with exact containment dependencies (2–5 min).**

Add backward-compatible second argument:

```ts
export type SdkBridgeContainmentDeps = {
  resourceControl?: ResourceControl
  resourceLimits?: () => CodingAgentResourceLimits | undefined
  startupTimeoutMs?: number
}

constructor(historySource?: ClaudeFreshAgentHistorySource, containment: SdkBridgeContainmentDeps = {})
```

At `createSession`, reserve before query, supply SDK's typed synchronous `spawnClaudeCodeProcess` callback that wraps/spawns and captures PID, and race callback/readiness against `startupTimeoutMs` defaulting to the existing SDK startup budget. Await verify before returning created session. Every catch/finally path invokes transaction rollback once; existing session kill/close invokes release once after child shutdown.

- [ ] **Step 5: Contain Fresh Codex at its one actual OS spawn seam (2–5 min).**

Patch the one process seam, leaving `startThread` and `resumeThread` as JSON-RPC-only methods:

```ts
const limits = this.containment.resourceLimits?.()
const transaction = limits?.enabled && this.containment.resourceControl
  ? new ContainedLaunchTransaction(this.containment.resourceControl)
  : undefined
let child: ChildProcess | undefined
try {
  let file = codexExecutable
  let args = appServerArgs
  if (transaction && limits) {
    await transaction.reserveGroup(
      limits.allAgents,
      'ordinary',
      { role: 'freshcodex-root', sessionId: this.threadId, label: 'Fresh Codex' },
      limits.eachAgent,
    )
    const launch = transaction.wrap('freshcodex-root', [codexExecutable, ...appServerArgs])
    file = launch.file
    args = launch.args
  }
  child = this.spawnProcess(file, args, spawnOptions)
  if (transaction) {
    await transaction.verify(child.pid ?? 0)
    const ownership = transaction.commit()
    this.resourceGroup = ownership.group
    this.resourceScope = ownership.scope
  }
  return await this.initializeReadyState(child)
} catch (error) {
  await transaction?.rollback(() => {
    if (child && !child.killed) child.kill('SIGTERM')
  })
  throw error
}
```

In runtime `shutdown()`, after the existing child wait completes, run:

```ts
const scope = this.resourceScope
this.resourceScope = undefined
this.resourceGroup = undefined
if (scope) await this.containment.resourceControl?.releaseProcess(scope)
```

Both adapter `create` and `resume` call this `startRuntime` path. Existing runtime `shutdown()` adds `await this.resourceOwnership?.release()` after child teardown.

- [ ] **Step 6: Add Rust root transactions at actual spawn functions (2–5 min).**

In both `claude.rs::spawn_sidecar` and `codex.rs::spawn_sidecar`, insert this transaction around the existing `tokio::process::Command` call, substituting the existing `argv`, `role`, and session metadata values at each call site:

```rust
let limits = (state.resource_limits)()
    .filter(|value| value.enabled)
    .ok_or_else(|| FreshAgentError::resource_containment("enabled limits are unavailable"))?;
let control = state.resource_control.clone()
    .ok_or_else(|| FreshAgentError::resource_containment("enabled controller is unavailable"))?;
let mut transaction = freshell_resource_control::LaunchTransaction::new(control);
transaction.reserve_group(
    &limits.all_agents,
    freshell_resource_control::GroupKind::Ordinary,
    freshell_resource_control::GroupMetadata {
        role: role.to_string(),
        pane_id: Some(pane_id.clone()),
        session_id: Some(session_id.clone()),
        label: Some(label.clone()),
    },
    &limits.each_agent,
).await?;
let launch = transaction.wrap(role, &argv)?;
let mut child = tokio::process::Command::new(&launch.file)
    .args(&launch.args)
    .envs(&child_env)
    .current_dir(&cwd)
    .spawn()?;
let pid = child.id().ok_or_else(|| FreshAgentError::resource_containment("spawn returned no pid"))?;
if let Err(error) = transaction.verify(pid).await {
    transaction.rollback(|| { let _ = child.start_kill(); }).await?;
    return Err(error.into());
}
let (resource_group, resource_scope) = transaction.commit()?;
session.resource_group = Some(resource_group);
session.resource_scope = Some(resource_scope);
```

The existing session exit/shutdown owner calls `release_process` for `resource_scope.take()` after child termination; no second owner or `/proc` sweep is added.

- [ ] **Step 7: Run Fresh root suites and observe GREEN (2–5 min).**

Run:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/fresh-agent/resource-control.test.ts \
  test/unit/server/sdk-bridge.test.ts \
  test/unit/server/fresh-agent/claude-adapter.test.ts \
  test/unit/server/fresh-agent/codex-adapter.test.ts \
  --config config/vitest/vitest.server.config.ts --run
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-freshagent
```

Expected: all PASS; delayed verify holds create unresolved; all failure modes leave controller count zero and emit no created/readiness event.

- [ ] **Step 8: Commit the fresh-root slice (2–5 min).**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add \
  shared/ws-protocol.ts server/fresh-agent/runtime-adapter.ts server/agent-api/layout-store.ts \
  server/sdk-bridge.ts server/fresh-agent/adapters/claude/adapter.ts \
  server/fresh-agent/adapters/codex/adapter.ts server/index.ts \
  test/unit/server/fresh-agent/resource-control.test.ts test/unit/server/sdk-bridge.test.ts \
  test/unit/server/fresh-agent/claude-adapter.test.ts test/unit/server/fresh-agent/codex-adapter.test.ts \
  crates/freshell-freshagent/src/lib.rs crates/freshell-freshagent/src/claude.rs \
  crates/freshell-freshagent/src/codex.rs
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment diff --cached --check
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit \
  -m "feat(fresh-agent): contain fresh-agent root processes" \
  -m "Generated with Amplifier: https://github.com/microsoft/amplifier" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

### Task 11: One Shared OpenCode Service Leaf

**User stories / highest-level proof:** US-07 shared-service case. Manager tests prove one service leaf for many panes; terminal-mode OpenCode remains an ordinary per-pane leaf.

**Files:**
- Modify: `server/fresh-agent/adapters/opencode/serve-manager.ts:17-127,224-323,656-705`
- Modify: `server/fresh-agent/adapters/opencode/adapter.ts:845-1092`
- Modify: `test/unit/server/fresh-agent/opencode-serve-manager.test.ts`
- Modify: `crates/freshell-opencode/Cargo.toml`
- Modify: `crates/freshell-opencode/src/serve.rs:140-191,313-455,907-916`
- Modify: `crates/freshell-opencode/src/transport.rs:204-345`
- Modify: `crates/freshell-freshagent/src/lib.rs`, `opencode_ws.rs:89-809`, Cargo manifest

**Interfaces:**
- Consumes: Task 6/7 transaction and Task 3 limits provider.
- Produces: one `sharedOpenCode` service generation, `registerAttachment(sessionId,paneId)`, `unregisterAttachment`, and `attachedIds()`.

- [ ] **Step 1: Add failing shared-service tests (2–5 min).**

Add these concrete test cases in the named existing suites:

```text
shared_opencode_reuses_one_group_for_all_attachments
unregister_attachment_never_releases_service_scope
verify_failure_releases_before_service_publication
service_exit_and_shutdown_release_once
shared_opencode_restart_never_reuses_group_or_scope
terminal_opencode_remains_ordinary_each_agent_group
```

Assert `reserveLaunchGroup(limits.allAgents, 'sharedOpenCode', { role: 'opencode-serve' }, limits.sharedOpenCode)` exactly once, `wrapProcess(group, 'opencode-serve', ['opencode', 'serve', '--hostname', '127.0.0.1', '--port', '47999'])` exactly once, and one spawn/verify across two `ensureStarted` calls and three attachments.

- [ ] **Step 2: Run OpenCode suites and observe RED (2–5 min).**

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/fresh-agent/opencode-serve-manager.test.ts \
  test/unit/server/terminal-registry.resource-control.test.ts \
  --config config/vitest/vitest.server.config.ts --run
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-opencode -p freshell-freshagent
```

Expected: FAIL because managers do not accept controller/limits or attachment APIs.

- [ ] **Step 3: Add exact Node shared generation state (2–5 min).**

Extend manager options with controller and live limits. Add fields:

```ts
private resourceGroup?: LogicalGroup
private resourceScope?: string
private attachments = new Map<string, Set<string>>()

registerAttachment(sessionId: string, paneId: string): void {
  const panes = this.attachments.get(sessionId) ?? new Set<string>()
  panes.add(paneId)
  this.attachments.set(sessionId, panes)
}

unregisterAttachment(sessionId: string, paneId: string): void {
  const panes = this.attachments.get(sessionId)
  panes?.delete(paneId)
  if (panes?.size === 0) this.attachments.delete(sessionId)
}

attachedIds(): string[] {
  return [...this.attachments.values()].flatMap((panes) => [...panes]).sort()
}
```

Replace the direct spawn portion of `start()` with this exact transaction, retaining the existing port allocation, stdio drains, health check, SSE setup, and public `ensureStarted(): Promise<{baseUrl:string}>` result:

```ts
const limits = this.options.resourceLimits?.()
const transaction = limits?.enabled && this.options.resourceControl
  ? new ContainedLaunchTransaction(this.options.resourceControl)
  : undefined
let child: ChildProcess | undefined
try {
  let file = this.options.command
  let args = ['serve', '--hostname', hostname, '--port', String(port)]
  if (transaction && limits) {
    await transaction.reserveGroup(
      limits.allAgents, 'sharedOpenCode',
      { role: 'opencode-serve', label: 'shared OpenCode' }, limits.sharedOpenCode,
    )
    const launch = transaction.wrap('opencode-serve', [file, ...args])
    file = launch.file; args = launch.args
  }
  child = this.options.spawnFn(file, args, spawnOptions)
  if (transaction) await transaction.verify(child.pid ?? 0)
  await this.waitForHealth(baseUrl, child, signal)
  const ownership = transaction?.commit()
  this.resourceGroup = ownership?.group
  this.resourceScope = ownership?.scope
  this.running = { child, baseUrl, generation }
  return { baseUrl }
} catch (error) {
  await transaction?.rollback(() => { if (child && !child.killed) child.kill('SIGTERM') })
  throw error
}
```

Existing close/shutdown takes `resourceScope`, kills/waits for the child, calls `releaseProcess(scope)` once, and clears group/scope/attachments. The next generation therefore mints new names.

- [ ] **Step 4: Add Rust shared generation to manager/spawner seam (2–5 min).**

Apply these exact Rust shape changes and transaction call:

```rust
pub struct ServeDeps {
    pub spawner: Arc<dyn ProcessSpawner>,
    pub resource_control: Option<Arc<dyn ResourceControl>>,
    pub resource_limits: Arc<dyn Fn() -> Option<CodingAgentResourceLimits> + Send + Sync>,
}

pub struct SpawnRequest {
    pub file: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
}

struct RunningServe {
    process: Box<dyn ServeProcess>,
    base_url: String,
    resource_group: Option<LogicalGroup>,
    resource_scope: Option<String>,
}
```

```rust
let limits = (self.deps.resource_limits)();
let mut transaction = match limits.filter(|value| value.enabled) {
    Some(limits) => {
        let control = self.deps.resource_control.clone().ok_or(ServeError::ContainmentUnavailable)?;
        let mut transaction = LaunchTransaction::new(control);
        transaction.reserve_group(
            &limits.all_agents, GroupKind::SharedOpenCode,
            GroupMetadata { role: "opencode-serve".into(), pane_id: None, session_id: None, label: Some("shared OpenCode".into()) },
            &limits.shared_open_code,
        ).await?;
        Some(transaction)
    }
    None => None,
};
let request = match transaction.as_mut() {
    Some(transaction) => {
        let launch = transaction.wrap("opencode-serve", &argv)?;
        SpawnRequest { file: launch.file, args: launch.args, cwd, env }
    }
    None => SpawnRequest { file: argv[0].clone(), args: argv[1..].to_vec(), cwd, env },
};
let mut process = self.deps.spawner.spawn(request).await?;
if let Some(transaction) = transaction.as_mut() {
    transaction.verify(process.pid()).await?;
}
let ownership = transaction.as_mut().map(LaunchTransaction::commit).transpose()?;
```

`RunningServe` stores `ownership`; exit/shutdown takes and releases the scope once. Freshagent adds `attachments: HashMap<String, BTreeSet<String>>`; kill removes only the pane/session entry and does not release the service scope.

- [ ] **Step 5: Run OpenCode tests and observe GREEN (2–5 min).**

Run:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/fresh-agent/opencode-serve-manager.test.ts \
  test/unit/server/terminal-registry.resource-control.test.ts \
  --config config/vitest/vitest.server.config.ts --run
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-opencode -p freshell-freshagent
```

Expected: all PASS; terminal OpenCode uses ordinary limits; shared service uses saved `sharedOpenCode` values and one scope.

- [ ] **Step 6: Commit shared OpenCode (2–5 min).**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add \
  server/fresh-agent/adapters/opencode/serve-manager.ts \
  server/fresh-agent/adapters/opencode/adapter.ts \
  test/unit/server/fresh-agent/opencode-serve-manager.test.ts \
  crates/freshell-opencode/Cargo.toml crates/freshell-opencode/src/serve.rs \
  crates/freshell-opencode/src/transport.rs crates/freshell-freshagent/Cargo.toml \
  crates/freshell-freshagent/src/lib.rs crates/freshell-freshagent/src/opencode_ws.rs Cargo.lock
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment diff --cached --check
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit \
  -m "feat(opencode): contain one shared OpenCode service group" \
  -m "Generated with Amplifier: https://github.com/microsoft/amplifier" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---
## Phase 4 — coordinator, server-authoritative pressure policy, and UI

### Task 12: Pending Launch Registry, Resolution Routes, Wire Snapshot, and Launch-Failure Dialog

**User stories / highest-level proof:** US-08 and US-09. Real authenticated router tests prove one-shot semantics; client tests prove exact non-dismissible copy and FIFO behavior; Rust real-WS reconnect proves parity.

**Files:**
- Create: `server/resource-control/coordinator.ts`
- Create: `server/resource-control/router.ts`
- Create: `test/unit/server/resource-control-router.test.ts`
- Create: `src/components/ui/dialog-shell.tsx`
- Modify: `src/components/ui/confirm-modal.tsx`
- Create: `src/components/ResourceContainmentModal.tsx`
- Create: `test/unit/client/components/ResourceContainmentModal.test.tsx`
- Modify: `src/store/resourceContainmentSlice.ts`
- Modify: `src/App.tsx:1125-1184,1630-1660`
- Modify: `shared/ws-protocol.ts:728-740,1060-1182`
- Inspect/conditionally modify: `shared/ws-version.ts`
- Modify: `server/index.ts`, `server/ws-handler.ts:550-640,1795-1841,3424-3538`
- Modify: all Task 8–11 failure catches after their rollback awaits
- Create: `crates/freshell-server/src/resource_containment_coordinator.rs`
- Modify: `crates/freshell-server/src/main.rs`
- Modify: `crates/freshell-protocol/src/server_messages.rs`, roundtrip tests
- Modify: `crates/freshell-ws/src/lib.rs:500-587`
- Generate: three `port/contract/*.json` files

**Interfaces:**
- Consumes: Task 8–11 compact intents only after rollback; Task 2/3 disable-setting callbacks; shared layout pane validation.
- Produces: `ResourceContainmentCoordinator`, exact runtime message, pending REST endpoint, `DialogShell`, pending-priority modal, Node/Rust reconnect snapshot provider.

- [ ] **Step 1: Write failing coordinator/router tests (2–5 min).**

Create `test/unit/server/resource-control-router.test.ts` using a real Express app and these complete helpers; then add cases for unauthenticated 401, invalid choice 400 retained, unknown/consumed 404, resolving 409, every valid action, retry/disable failure 500 retained, FIFO prompts, duplicate pane replacement, close cancellation, and dispose:

```ts
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CompactLaunchIntent } from '../../../shared/ws-protocol.js'
import { ResourceContainmentCoordinator, type RuntimeGroup } from '../../../server/resource-control/coordinator.js'
import { createResourceControlRouter } from '../../../server/resource-control/router.js'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function intent(paneId: string, requestId: string): CompactLaunchIntent {
  return { kind: 'terminal', paneId, requestId, mode: 'claude' }
}

let retryStarted: Promise<void>
let finishRetry: ReturnType<typeof deferred<void>>
let retryIntent: ReturnType<typeof vi.fn>
let coordinator: ResourceContainmentCoordinator
let app: express.Express
const auth = { Authorization: 'Bearer test-token' }

beforeEach(() => {
  finishRetry = deferred<void>()
  const started = deferred<void>()
  retryStarted = started.promise
  retryIntent = vi.fn(async () => { started.resolve(); await finishRetry.promise })
  coordinator = new ResourceContainmentCoordinator({
    controller: { runningCount: () => 0 } as never,
    retryIntent,
    restartIntent: vi.fn(),
    disableContainment: vi.fn(async () => undefined),
    closePane: vi.fn(async () => undefined),
    broadcast: vi.fn(),
    uuid: () => 'pending-1',
    now: () => 0,
    setInterval: vi.fn(() => 1 as never),
    clearInterval: vi.fn(),
  })
  app = express()
  app.use(express.json())
  app.use('/api/resource-control', createResourceControlRouter({
    coordinator,
    requireAuth: (req, res, next) => req.headers.authorization === 'Bearer test-token'
      ? next()
      : res.status(401).json({ code: 'UNAUTHORIZED' }),
  }))
})

it('allows exactly one concurrent resolution and invokes retry once', async () => {
  const pending = coordinator.registerPending(intent('pane-1', 'request-1'))
  const first = request(app).post(`/api/resource-control/pending/${pending.id}/resolve`)
    .set(auth).send({ choice: 'launch_uncontained' })
  await retryStarted
  await request(app).post(`/api/resource-control/pending/${pending.id}/resolve`)
    .set(auth).send({ choice: 'launch_uncontained' })
    .expect(409, { code: 'PENDING_LAUNCH_RESOLVING' })
  finishRetry.resolve()
  await first.expect(200)
  expect(retryIntent).toHaveBeenCalledTimes(1)
  expect(coordinator.snapshot().pending).toEqual([])
})
```

- [ ] **Step 2: Write failing exact modal/focus tests (2–5 min).**

Create `test/unit/client/components/ResourceContainmentModal.test.tsx`:

```tsx
it('renders the exact pending copy, ordered buttons, and cannot be dismissed', async () => {
  const onAction = vi.fn()
  render(<ResourceContainmentModal state={{
    pending: [{ id: 'pending-1', paneId: 'pane-1' }],
    snapshot: { runningCount: 0, groups: [] },
  }} onAction={onAction} />)
  const dialog = screen.getByRole('dialog', { name: "Freshell couldn't limit this agent" })
  expect(within(dialog).getByText("Freshell limits coding agents so they can't overwhelm this machine. Those limits could not be applied, so the agent has not started. Launch it without limits, turn containment off, or close the pane.")).toBeVisible()
  expect(within(dialog).getAllByRole('button').map((button) => button.textContent)).toEqual([
    'Launch uncontained', 'Disable containment', 'Close pane',
  ])
  await userEvent.keyboard('{Escape}')
  expect(dialog).toBeVisible()
  fireEvent.mouseDown(dialog.parentElement as HTMLElement)
  expect(dialog).toBeVisible()
})
```

- [ ] **Step 3: Run router/modal tests and observe RED (2–5 min).**

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/resource-control-router.test.ts \
  --config config/vitest/vitest.server.config.ts --run
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/client/components/ResourceContainmentModal.test.tsx \
  --config config/vitest/vitest.config.ts --run
```

Expected: both FAIL because coordinator/router/component do not exist.

- [ ] **Step 4: Define exact pending/coordinator state and duplicate semantics (2–5 min).**

Start `server/resource-control/coordinator.ts`:

```ts
import { randomUUID } from 'node:crypto'
import type { CompactLaunchIntent, PendingChoice, ResourceContainmentUpdated } from '../../shared/ws-protocol.js'
type PendingRecord = {
  id: string
  paneId: string
  intent: CompactLaunchIntent
  resolving: boolean
}

export type CoordinatorDeps = {
  controller: ResourceControl
  retryIntent: (intent: CompactLaunchIntent, options: { containmentForcedOff: true }) => Promise<void>
  restartIntent: (intent: CompactLaunchIntent) => Promise<RuntimeGroup>
  disableContainment: () => Promise<void>
  closePane: (paneId: string) => Promise<void>
  broadcast: (message: ResourceContainmentUpdated) => void
  uuid?: () => string
  now: () => number
  setInterval: (callback: () => void, milliseconds: number) => ReturnType<typeof setInterval>
  clearInterval: (timer: ReturnType<typeof setInterval>) => void
}

export class ResourceContainmentCoordinator {
  private pending: PendingRecord[] = []
  private pendingByPane = new Map<string, string>()
  private groups = new Map<string, RuntimeGroup>()
  private lastSerialized = ''
  private readonly controller: ResourceControl

  constructor(private readonly deps: CoordinatorDeps) {
    this.controller = deps.controller
  }

  registerPending(intent: CompactLaunchIntent): { id: string; paneId: string } {
    const existingId = this.pendingByPane.get(intent.paneId)
    if (existingId) {
      const existing = this.pending.find((record) => record.id === existingId)
      if (existing && !existing.resolving) existing.intent = intent
      this.publish()
      return { id: existingId, paneId: intent.paneId }
    }
    const record = { id: (this.deps.uuid ?? randomUUID)(), paneId: intent.paneId, intent, resolving: false }
    this.pending.push(record)
    this.pendingByPane.set(intent.paneId, record.id)
    this.publish()
    return { id: record.id, paneId: record.paneId }
  }

  cancelPendingForPane(paneId: string): void {
    const id = this.pendingByPane.get(paneId)
    if (!id) return
    this.pendingByPane.delete(paneId)
    this.pending = this.pending.filter((record) => record.id !== id)
    this.publish()
  }
}
```

`RuntimeGroup` and `projectRuntimeGroup` use the exact declarations in “Exact Cross-Task Interfaces”; internal `warningSource`, launch intent, logical group, pressure state, and suppression are excluded from wire projection.

- [ ] **Step 5: Implement exact one-shot pending resolution and snapshot publication (2–5 min).**

Add:

```ts
async resolvePending(id: string, choice: PendingChoice): Promise<
  | { status: 200; body: { paneId: string } }
  | { status: 404 | 409 | 500; body: { code: string } }
> {
  const record = this.pending.find((candidate) => candidate.id === id)
  if (!record) return { status: 404, body: { code: 'PENDING_LAUNCH_NOT_FOUND' } }
  if (record.resolving) return { status: 409, body: { code: 'PENDING_LAUNCH_RESOLVING' } }
  record.resolving = true
  try {
    if (choice === 'disable_containment') await this.deps.disableContainment()
    if (choice !== 'close_pane') {
      await this.deps.retryIntent(record.intent, { containmentForcedOff: true })
    }
    if (choice === 'close_pane') await this.deps.closePane(record.paneId)
    this.pendingByPane.delete(record.paneId)
    this.pending = this.pending.filter((candidate) => candidate.id !== id)
    this.publish()
    return { status: 200, body: { paneId: record.paneId } }
  } catch {
    record.resolving = false
    this.publish()
    return { status: 500, body: { code: 'PENDING_LAUNCH_RETRY_FAILED' } }
  }
}

snapshot(): ResourceContainmentUpdated {
  return {
    type: 'resource.containment.updated',
    pending: this.pending.map(({ id, paneId }) => ({ id, paneId })),
    snapshot: {
      runningCount: this.controller.runningCount(),
      groups: [...this.groups.values()].map(projectRuntimeGroup).sort((a, b) => a.id.localeCompare(b.id)),
    },
  }
}

private publish(): void {
  const message = this.snapshot()
  const serialized = JSON.stringify(message)
  if (serialized === this.lastSerialized) return
  this.lastSerialized = serialized
  this.deps.broadcast(message)
}
```

Add the initial disposal method; Task 13 inserts timer cancellation as its first line:

```ts
dispose(): void {
  this.pending = []
  this.pendingByPane.clear()
  this.groups.clear()
  this.lastSerialized = ''
  this.publish()
}
```

- [ ] **Step 6: Add the thin authenticated Node router (2–5 min).**

Create `server/resource-control/router.ts`:

```ts
import { Router, type RequestHandler } from 'express'
import type { PendingChoice, ResourceContainmentCoordinator } from './coordinator.js'

const PENDING_CHOICES = new Set<PendingChoice>(['launch_uncontained', 'disable_containment', 'close_pane'])

function isPendingChoice(value: unknown): value is PendingChoice {
  return typeof value === 'string' && PENDING_CHOICES.has(value as PendingChoice)
}

export function createResourceControlRouter({
  coordinator,
  requireAuth,
}: {
  coordinator: ResourceContainmentCoordinator
  requireAuth: RequestHandler
}): Router {
  const router = Router()
  router.post('/pending/:id/resolve', requireAuth, async (req, res) => {
    const choice = req.body?.choice
    if (!isPendingChoice(choice)) {
      res.status(400).json({ code: 'INVALID_PENDING_LAUNCH_CHOICE' })
      return
    }
    const result = await coordinator.resolvePending(req.params.id, choice)
    res.status(result.status).json(result.body)
  })
  return router
}
```

Mount this router at `/api/resource-control`; the code above uses the repository's `RequestHandler` type and contains no untyped request adapter.

- [ ] **Step 7: Add exact wire types and fold messages into Redux (2–5 min).**

Add to `shared/ws-protocol.ts` the `CompactLaunchIntent`, snapshot types from the global interface section, and server union member `ResourceContainmentUpdated`. Add error code `RESOURCE_CONTAINMENT_FAILED`.

In `App.tsx` message handler:

```ts
if (msg.type === 'resource.containment.updated') {
  dispatch(setResourceContainment({ pending: msg.pending, snapshot: msg.snapshot }))
}
```

`buildReconnectSnapshot()` returns `snapshot()` without mutating deadlines or pending order. Node `sendHandshakeSnapshot` sends it after settings and before terminal inventory. Every Task 8–11 containment catch performs `await rollback`, then `coordinator.registerPending(intent)`, then emits request-correlated `RESOURCE_CONTAINMENT_FAILED` and no created event.

- [ ] **Step 8: Extract exact reusable DialogShell and pending-priority modal (2–5 min).**

Create `src/components/ui/dialog-shell.tsx` with this complete portal/focus/scroll/dismissal implementation, extracted once for both consumers:

```tsx
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hasAttribute('hidden'))
}

export function DialogShell({
  labelledBy,
  dismissible,
  onDismiss,
  children,
}: {
  labelledBy: string
  dismissible: boolean
  onDismiss?: () => void
  children: ReactNode
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const priorOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    queueMicrotask(() => focusable(dialogRef.current ?? document.body)[0]?.focus())
    return () => {
      document.body.style.overflow = priorOverflow
      previous?.focus()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dismissible) {
        event.preventDefault()
        onDismiss?.()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const items = focusable(dialogRef.current)
      if (items.length === 0) { event.preventDefault(); dialogRef.current.focus(); return }
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [dismissible, onDismiss])

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) onDismiss?.()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className="w-full max-w-lg rounded-lg bg-background p-6 shadow-xl"
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}
```

Rebuild `ConfirmModal` with `<DialogShell labelledBy={titleId} dismissible onDismiss={onCancel}>` so Escape/backdrop behavior remains unchanged. Create the Task 12 pending-only `ResourceContainmentModal` implementation; Task 14 extends the `return null` branch with pressure rows:

```tsx
import type { PendingChoice } from '../../shared/ws-protocol.js'
import type { ResourceContainmentState } from '../store/resourceContainmentSlice.js'
import { DialogShell } from './ui/dialog-shell.js'

export function ResourceContainmentModal({
  state,
  onAction,
}: {
  state: ResourceContainmentState
  onAction: (target: { kind: 'pending'; id: string }, action: PendingChoice) => void
}) {
  const pending = state.pending[0]
  if (!pending) return null
  const titleId = `resource-pending-${pending.id}`
  return (
    <DialogShell labelledBy={titleId} dismissible={false}>
      <h2 id={titleId}>Freshell couldn't limit this agent</h2>
      <p>Freshell limits coding agents so they can't overwhelm this machine. Those limits could not be applied, so the agent has not started. Launch it without limits, turn containment off, or close the pane.</p>
      <div className="mt-6 flex flex-col gap-2">
        <button type="button" onClick={() => onAction({ kind: 'pending', id: pending.id }, 'launch_uncontained')}>Launch uncontained</button>
        <button type="button" onClick={() => onAction({ kind: 'pending', id: pending.id }, 'disable_containment')}>Disable containment</button>
        <button type="button" onClick={() => onAction({ kind: 'pending', id: pending.id }, 'close_pane')}>Close pane</button>
      </div>
    </DialogShell>
  )
}
```

Callbacks carry `{kind:'pending',id}` so Task 14 selects the pending endpoint by target context.
- [ ] **Step 9: Add Rust coordinator/wire/route/reconnect parity (2–5 min).**

Create the Rust coordinator with these exact public records and guarded transition. Add corresponding camelCase serde records to `freshell-protocol`; mount the existing-auth Axum route at `/api/resource-control/pending/{id}/resolve`; inject `snapshot_provider` into `WsState` and append its returned message directly during handshake:

```rust
#[derive(Clone)]
struct PendingRecord {
    id: String,
    pane_id: String,
    intent: CompactLaunchIntent,
    resolving: bool,
}

#[derive(Default)]
struct CoordinatorState {
    pending: Vec<PendingRecord>,
    pending_by_pane: std::collections::HashMap<String, String>,
    groups: std::collections::HashMap<String, RuntimeGroup>,
    last_serialized: String,
}

pub async fn resolve_pending(&self, id: &str, choice: PendingChoice) -> ResolveResult {
    let record = {
        let mut state = self.state.lock().await;
        let Some(record) = state.pending.iter_mut().find(|record| record.id == id) else {
            return ResolveResult::not_found();
        };
        if record.resolving { return ResolveResult::resolving(); }
        record.resolving = true;
        record.clone()
    };
    let outcome = match choice {
        PendingChoice::LaunchUncontained => (self.retry)(record.intent.clone(), true).await,
        PendingChoice::DisableContainment => self.disable_then_retry(record.intent.clone()).await,
        PendingChoice::ClosePane => (self.close_pane)(record.pane_id.clone()).await,
    };
    let mut state = self.state.lock().await;
    if outcome.is_ok() {
        state.pending.retain(|item| item.id != record.id);
        state.pending_by_pane.remove(&record.pane_id);
        ResolveResult::ok(record.pane_id)
    } else {
        if let Some(item) = state.pending.iter_mut().find(|item| item.id == record.id) { item.resolving = false; }
        ResolveResult::retry_failed()
    }
}
```

The disable arm uses this private helper, so both operations are sequential asynchronous calls:

```rust
async fn disable_then_retry(&self, intent: CompactLaunchIntent) -> Result<(), CoordinatorError> {
    (self.disable)().await?;
    (self.retry)(intent, true).await
}
```

The route maps invalid choice to 400, missing to 404, resolving to 409, callback failure to 500, and success to `200 {"paneId":"<server-owned-pane-id>"}`. The snapshot provider type is `Arc<dyn Fn() -> ResourceContainmentUpdated + Send + Sync>`.

- [ ] **Step 10: Run focused/roundtrip/contract tests and observe GREEN (2–5 min).**

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/resource-control-router.test.ts \
  --config config/vitest/vitest.server.config.ts --run
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/client/components/ResourceContainmentModal.test.tsx \
  --config config/vitest/vitest.config.ts --run
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-protocol -p freshell-ws -p freshell-server
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run contract:generate
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:port
```

Expected: focused tests PASS; generated contract contains one additive server message/action inventory. Regenerate a second time and require:

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment diff --exit-code -- port/contract
```

Expected only after staging the first generated change: zero new diff on the second generation. Keep protocol 7 unless the existing freeze test fails specifically for version; then set both constants to 8 and regenerate.

- [ ] **Step 11: Commit pending workflow and wire contract (2–5 min).**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add \
  server/resource-control/coordinator.ts server/resource-control/router.ts server/index.ts server/ws-handler.ts \
  shared/ws-protocol.ts shared/ws-version.ts src/store/resourceContainmentSlice.ts src/App.tsx \
  src/components/ui/dialog-shell.tsx src/components/ui/confirm-modal.tsx \
  src/components/ResourceContainmentModal.tsx \
  test/unit/server/resource-control-router.test.ts \
  test/unit/client/components/ResourceContainmentModal.test.tsx \
  crates/freshell-server/src/resource_containment_coordinator.rs crates/freshell-server/src/main.rs \
  crates/freshell-protocol/src/server_messages.rs crates/freshell-protocol/tests/roundtrip.rs \
  crates/freshell-ws/src/lib.rs port/contract
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment diff --cached --check
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit \
  -m "feat(resource-control): add launch-failure resolution workflow" \
  -m "Generated with Amplifier: https://github.com/microsoft/amplifier" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

### Task 13: Exact Memory-Pressure Reducers, Batched Snapshots, and Exit Classification

**User stories / highest-level proof:** US-10, US-11, and US-14 policy mechanics; OOM inspection prerequisite for US-12. Identical TypeScript/Rust fixtures prove exact timing/order/ranking without timers or kernel dependencies.

**Files:**
- Create: `server/resource-control/pressure-policy.ts`
- Create: `test/unit/server/resource-control-pressure.test.ts`
- Modify: `server/resource-control/systemd.ts`
- Modify: `server/resource-control/coordinator.ts`
- Create: `crates/freshell-resource-control/src/pressure.rs`
- Create: `crates/freshell-resource-control/tests/pressure.rs`
- Modify: `crates/freshell-resource-control/src/systemd.rs`, `controller.rs`, `lib.rs`
- Modify: `crates/freshell-server/src/resource_containment_coordinator.rs`

**Interfaces:**
- Consumes: Task 6/7 group registry/path cache and Task 12 server-layer coordinator.
- Produces: `MemorySnapshot`, `PressureState`, `ResourcePressureControl extends ResourceControl`, leaf/aggregate pure reducers, one 1000-ms coordinator poller, O(N) `readSnapshots`, and inspection-only `classifyExit`.

- [ ] **Step 1: Create the failing exact TypeScript fixture (2–5 min).**

Create `test/unit/server/resource-control-pressure.test.ts` with an explicit `snap()` helper and these cases:

```ts
it('keeps the first 60-second deadline while high edges arrive under 10 seconds apart', () => {
  let result = reduceMemoryPressure(attachPressureMonitor('leaf', 'leaf', snap()), snap({ localHighCount: 1 }), 1000)
  expect(result.action).toEqual({ type: 'warn', deadlineAt: 61000 })
  for (const [index, now] of [10000, 19000, 28000, 37000, 46000, 55000, 59000].entries()) {
    result = reduceMemoryPressure(result.state, snap({ localHighCount: index + 2, memoryCurrent: 1000 }), now)
    expect(result.state.deadlineAt).toBe(61000)
  }
  expect(reduceMemoryPressure(result.state, snap({ localHighCount: 8, memoryCurrent: 1000 }), 61000).action)
    .toEqual({ type: 'pause', reason: 'deadline' })
})

it('clears at the quiet boundary before testing the same-tick deadline', () => {
  const warned = reduceMemoryPressure(attachPressureMonitor('leaf', 'leaf', snap()), snap({ localHighCount: 1 }), 1000)
  expect(reduceMemoryPressure(warned.state, snap({ localHighCount: 1, memoryCurrent: 1000 }), 61000).action)
    .toEqual({ type: 'clear' })
})

it('cancel suppresses until ten seconds after the latest edge', () => {
  const cancelled = reduceMemoryPressure(attachPressureMonitor('leaf', 'leaf', snap()), snap({ localHighCount: 1 }), 1000, { cancel: true })
  const edge = reduceMemoryPressure(cancelled.state, snap({ localHighCount: 2 }), 5000)
  expect(edge.state.suppressedUntilRearm).toBe(true)
  expect(reduceMemoryPressure(edge.state, snap({ localHighCount: 2 }), 14999).state.suppressedUntilRearm).toBe(true)
  const rearmed = reduceMemoryPressure(edge.state, snap({ localHighCount: 2 }), 15000)
  expect(rearmed.state.suppressedUntilRearm).toBe(false)
  expect(reduceMemoryPressure(rearmed.state, snap({ localHighCount: 3 }), 15001).action)
    .toEqual({ type: 'warn', deadlineAt: 75001 })
})

it('aggregate critical ranks current plus swap, id ascending, pauses at most two per episode', () => {
  const state = attachPressureMonitor('aggregate', 'aggregate', snap({ groupId: 'aggregate', memoryMax: 2000 }))
  const first = reduceAggregatePressure(state, snap({ groupId: 'aggregate', memoryCurrent: 1900, memoryMax: 2000 }), [
    snap({ groupId: 'z', memoryCurrent: 700, memorySwapCurrent: 200 }),
    snap({ groupId: 'a', memoryCurrent: 800, memorySwapCurrent: 100 }),
    snap({ groupId: 'shared', memoryCurrent: 850 }),
  ], 1000)
  expect(first.action).toEqual({ type: 'pause', reason: 'critical', targetGroupIds: ['a', 'z'] })
  expect(first.state.pausesThisEpisode).toBe(2)
  expect(reduceAggregatePressure(first.state, snap({ groupId: 'aggregate', memoryCurrent: 1900, memoryMax: 2000 }), [snap({ groupId: 'shared', memoryCurrent: 850 })], 2000).action)
    .toEqual({ type: 'none' })
})
```

Add baseline nonzero counters, leaf OOM, critical 95%, max delta, frozen/ended, aggregate-member-local-edge ignored, aggregate OOM alone none, strict aggregate episode rearm, no-op state identity, and equal-byte snapshot no-broadcast tests.

- [ ] **Step 2: Run pressure tests and observe RED (2–5 min).**

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/resource-control-pressure.test.ts \
  --config config/vitest/vitest.server.config.ts --run
```

Expected: FAIL because `pressure-policy.ts` does not exist.

- [ ] **Step 3: Define exact snapshots/state/actions (2–5 min).**

Create `server/resource-control/pressure-policy.ts`:

```ts
export type MemorySnapshot = {
  groupId: string
  memoryCurrent: number
  memorySwapCurrent: number
  memoryHigh: number
  memoryMax: number
  localHighCount: number
  localMaxCount: number
  localOomKillCount: number
  frozen: boolean
  ended: boolean
}

export type PressureState = {
  groupId: string
  scope: 'leaf' | 'aggregate'
  lastSeenHigh: number
  lastSeenMax: number
  lastSeenOomKill: number
  lastHighAt?: number
  deadlineAt?: number
  warning: boolean
  suppressedUntilRearm: boolean
  pausesThisEpisode: number
}

export type LeafPressureAction =
  | { type: 'none' }
  | { type: 'warn'; deadlineAt: number }
  | { type: 'clear' }
  | { type: 'pause'; reason: 'deadline' | 'critical' }
  | { type: 'stop'; reason: 'oom' }

export type AggregatePressureAction =
  | { type: 'none' }
  | { type: 'warn'; deadlineAt: number; targetGroupIds: [string] }
  | { type: 'clear' }
  | { type: 'pause'; reason: 'deadline' | 'critical'; targetGroupIds: string[] }

export function attachPressureMonitor(groupId: string, scope: 'leaf' | 'aggregate', snapshot: MemorySnapshot): PressureState {
  return {
    groupId, scope,
    lastSeenHigh: snapshot.localHighCount,
    lastSeenMax: snapshot.localMaxCount,
    lastSeenOomKill: snapshot.localOomKillCount,
    warning: false,
    suppressedUntilRearm: false,
    pausesThisEpisode: 0,
  }
}
```

- [ ] **Step 4: Implement the leaf reducer in the fixed order (2–5 min).**

Add this complete control flow; clone state only when a field changes, and return original object for true no-op:

```ts
export function reduceMemoryPressure(
  state: PressureState,
  snapshot: MemorySnapshot,
  nowMs: number,
  opts: { cancel?: boolean } = {},
): { state: PressureState; action: LeafPressureAction } {
  if (snapshot.frozen || snapshot.ended) return { state, action: { type: 'none' } }
  let next = state
  const mutate = () => { if (next === state) next = { ...state } }
  const oomEdge = snapshot.localOomKillCount > state.lastSeenOomKill
  const maxEdge = snapshot.localMaxCount > state.lastSeenMax
  const highEdge = snapshot.localHighCount > state.lastSeenHigh
  if (oomEdge) {
    mutate(); next.lastSeenOomKill = snapshot.localOomKillCount
    return { state: next, action: { type: 'stop', reason: 'oom' } }
  }
  if (maxEdge || snapshot.memoryCurrent >= Math.floor(snapshot.memoryMax * 95 / 100)) {
    mutate(); next.lastSeenMax = Math.max(next.lastSeenMax, snapshot.localMaxCount)
    return { state: next, action: { type: 'pause', reason: 'critical' } }
  }
  if (highEdge) {
    mutate(); next.lastSeenHigh = snapshot.localHighCount; next.lastHighAt = nowMs
    if (!next.warning && !next.suppressedUntilRearm) {
      next.warning = true; next.deadlineAt = nowMs + 60_000
      return { state: next, action: { type: 'warn', deadlineAt: next.deadlineAt } }
    }
  }
  if (opts.cancel && next.warning) {
    mutate(); next.warning = false; next.deadlineAt = undefined; next.suppressedUntilRearm = true
    return { state: next, action: { type: 'clear' } }
  }
  const quiet = next.lastHighAt !== undefined && nowMs - next.lastHighAt >= 10_000
  if (quiet && (next.warning || next.suppressedUntilRearm)) {
    mutate(); next.warning = false; next.deadlineAt = undefined; next.suppressedUntilRearm = false
    return { state: next, action: { type: 'clear' } }
  }
  if (next.warning && next.deadlineAt !== undefined && nowMs >= next.deadlineAt) {
    return { state: next, action: { type: 'pause', reason: 'deadline' } }
  }
  return { state: next, action: highEdge && next.warning && next.deadlineAt !== undefined
    ? { type: 'warn', deadlineAt: next.deadlineAt }
    : { type: 'none' } }
}
```

- [ ] **Step 5: Implement aggregate trigger/selection/latch (2–5 min).**

Use only aggregate counters/current for trigger. Rank eligible members exactly:

```ts
function rankMembers(members: MemorySnapshot[]): MemorySnapshot[] {
  return members.filter((member) => !member.frozen && !member.ended).sort((a, b) => {
    const byUsage = (b.memoryCurrent + b.memorySwapCurrent) - (a.memoryCurrent + a.memorySwapCurrent)
    return byUsage || a.groupId.localeCompare(b.groupId)
  })
}
```

`reduceAggregatePressure` executes exclusion -> critical -> aggregate high edge -> cancel -> quiet warning clear -> strict episode rearm (`current < high && quiet`) -> deadline. Warning/deadline chooses one, critical chooses `min(2-pausesThisEpisode,2)`, and increments latch by emitted target count. It never emits stop and ignores aggregate OOM-only deltas.

- [ ] **Step 6: Add exact six-file batched snapshot reads and inspection-only classifier (2–5 min).**

At the start of Task 13, change the coordinator dependency from `ResourceControl` to the final pressure-capable subtype:

```diff
-export type CoordinatorDeps = { controller: ResourceControl
+export type CoordinatorDeps = { controller: ResourcePressureControl
@@
-  private readonly controller: ResourceControl
+  private readonly controller: ResourcePressureControl
```

In `SystemdController.readSnapshots`, for each requested tracked aggregate/leaf path use `Promise.all` over exactly:

```ts
[
  'memory.events.local',
  'memory.current',
  'memory.swap.current',
  'memory.high',
  'memory.max',
  'cgroup.events',
]
```

Parse `high`, `max`, `oom`, `oom_kill`/`oom_group_kill`, `frozen`, and `populated`. No other file is read. `classifyExit` takes fresh leaf+aggregate event snapshots under a per-group promise chain and returns:

```ts
return {
  classified: true,
  oom: leafOomKill > baseline.leafOomKill
    || (exit.signal === 9 && aggregateOomGroupKill > baseline.aggregateOomGroupKill),
}
```

It changes no coordinator state and invokes no stop/restart.

- [ ] **Step 7: Add one coordinator-owned 1000-ms poll loop (2–5 min).**

Add this exact lifecycle to the Node coordinator; `pollOnce` obtains one immutable snapshot map, evaluates the aggregate once, evaluates each leaf once, refreshes only action targets, and calls `publish` only when a mutation has completed:

```ts
private pollTimer?: ReturnType<typeof setInterval>

private reconcilePollLoop(): void {
  const shouldRun = [...this.groups.values()].some((group) => group.phase === 'idle' || group.phase === 'warning')
  if (shouldRun && this.pollTimer === undefined) {
    this.pollTimer = this.deps.setInterval(() => { void this.pollOnce() }, 1000)
  } else if (!shouldRun && this.pollTimer !== undefined) {
    this.deps.clearInterval(this.pollTimer)
    this.pollTimer = undefined
  }
}

private async pollOnce(): Promise<void> {
  const pollable = [...this.groups.values()].filter((group) => group.phase === 'idle' || group.phase === 'warning')
  if (pollable.length === 0) { this.reconcilePollLoop(); return }
  const ids = pollable.map((group) => group.id)
  const table = await this.controller.readSnapshots(ids)
  const now = this.deps.now()
  const actions = this.evaluatePressure(table, pollable, now)
  for (const action of actions) await this.applyPressureAction(action, table)
  this.reconcilePollLoop()
}
```

`dispose()` clears `pollTimer` before clearing state. Paused/stopped IDs never enter `ids`. Tests inject fake `setInterval`, `clearInterval`, and `now`.

- [ ] **Step 8: Add the Rust reducer fixture and implementation (2–5 min).**

Create `crates/freshell-resource-control/tests/pressure.rs` with literal times `[1000, 10000, 19000, 28000, 37000, 46000, 55000, 59000, 61000]`, high counts `1..=8`, cancellation edge `5000`, rearm `15000`, fresh edge/deadline `15001/75001`, aggregate IDs `a`, `z`, and `shared`, and expected targets `["a", "z"]`. Create `src/pressure.rs` with the `MemorySnapshot`/`PressureState` fields listed in Step 3 and these exact action enums. The reducer executes exclusion, OOM, critical, high-edge update, cancellation, quiet clear, and deadline in that order. Add six-file `tokio::try_join!` reads, the exact classifier expression, and a coordinator interval that exists only while an idle/warning entry exists:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PauseReason { Deadline, Critical }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeafPressureAction {
    None,
    Warn { deadline_at: i64 },
    Clear,
    Pause { reason: PauseReason },
    StopOom,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AggregatePressureAction {
    None,
    Warn { deadline_at: i64, target_group_ids: Vec<String> },
    Clear,
    Pause { reason: PauseReason, target_group_ids: Vec<String> },
}

let oom = leaf_events.oom_kill > baseline.leaf_oom_kill
    || (exit.signal == Some(9)
        && aggregate_events.oom_group_kill > baseline.aggregate_oom_group_kill);

let mut ticker = tokio::time::interval(std::time::Duration::from_millis(1000));
while coordinator.has_pollable_groups().await {
    ticker.tick().await;
    coordinator.poll_once().await?;
}
```

The Rust fixture calls `attach_pressure_monitor`, `reduce_memory_pressure`, and `reduce_aggregate_pressure` directly with those literals and asserts the exact enum values above; it does not derive expected values from the TypeScript test.

- [ ] **Step 9: Run Node/Rust policy tests and observe GREEN (2–5 min).**

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/resource-control-pressure.test.ts \
  --config config/vitest/vitest.server.config.ts --run
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-resource-control pressure
```

Expected: both PASS with identical fixture values; N groups produce N six-file reads, not N².

- [ ] **Step 10: Commit pure policy and polling mechanics (2–5 min).**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add \
  server/resource-control/pressure-policy.ts server/resource-control/systemd.ts \
  server/resource-control/coordinator.ts test/unit/server/resource-control-pressure.test.ts \
  crates/freshell-resource-control/src/pressure.rs crates/freshell-resource-control/tests/pressure.rs \
  crates/freshell-resource-control/src/systemd.rs crates/freshell-resource-control/src/controller.rs \
  crates/freshell-resource-control/src/lib.rs \
  crates/freshell-server/src/resource_containment_coordinator.rs
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment diff --cached --check
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit \
  -m "feat(resource-control): add memory-pressure policy and exit classification" \
  -m "Generated with Amplifier: https://github.com/microsoft/amplifier" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

### Task 14: Group Actions, Exact Pressure UI, Reconnect Replay, and Respawn Suppression

**User stories / highest-level proof:** US-10, US-11, US-12, US-13, and US-14 plus end-to-end completion of US-08/US-09. Unit tests prove phase guards/source routing; browser tests prove exact copy, one dialog, actions, reload, aggregate rows, OOM, and shared close; real WS tests prove backend replay.

**Files:**
- Modify: `server/resource-control/coordinator.ts`, `router.ts`, `systemd.ts`
- Modify: `server/ws-handler.ts`, `server/terminal-registry.ts`
- Modify: managed Codex/Fresh Claude/Fresh Codex/OpenCode exit/restart owners
- Modify: `server/agent-api/layout-store.ts`, `server/agent-api/router.ts`
- Modify: `shared/ws-protocol.ts`
- Modify: `src/store/resourceContainmentSlice.ts`
- Modify: `src/components/ResourceContainmentModal.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/settings/RuntimeSettings.tsx`
- Modify: router/modal tests
- Create: `test/e2e-browser/specs/resource-containment-ui.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (add to `MATRIX_SPECS`)
- Modify: Rust protocol/server coordinator/main/WS auto-resume/terminal/fresh/Codex/OpenCode owners
- Modify: Rust real-WS tests; do not make the low-level controller depend on pane/UI/provider crates.

**Interfaces:**
- Consumes: Task 13 actions/classifier and Task 12 exact snapshot/dialog.
- Produces: `/groups/:groupId/action`, six strict actions, exact pressure copy, warning-source routing, classify-before-respawn, new-generation restart, shared-member close, and byte-equivalent reconnect replay.

- [ ] **Step 1: Add failing phase/source/exit tests (2–5 min).**

Extend `resource-control-router.test.ts` with this fixture and table:

```ts
function groupFixture(overrides: Partial<RuntimeGroup> = {}): RuntimeGroup {
  return {
    id: 'g1', kind: 'ordinary', label: 'Claude pane', phase: 'idle',
    members: [{ paneId: 'pane-1', label: 'Claude pane' }],
    logicalGroup: { aggregateUnit: 'aggregate.slice', unit: 'leaf.slice' },
    launchIntent: { kind: 'terminal', paneId: 'pane-1', requestId: 'request-1', mode: 'claude' },
    pressure: attachPressureMonitor('g1', 'leaf', snap({ groupId: 'g1' })),
    respawnSuppressed: false,
    ...overrides,
  }
}

it.each([
  ['pause_now', 'warning', 200],
  ['cancel_countdown', 'warning', 200],
  ['resume', 'paused', 200],
  ['stop_agent', 'paused', 200],
  ['restart_agent', 'stopped', 200],
  ['close_pane', 'stopped', 200],
  ['pause_now', 'idle', 409],
  ['resume', 'warning', 409],
  ['restart_agent', 'paused', 409],
])('%s from %s returns %i', async (action, phase, status) => {
  coordinator.seedRuntimeGroupForTest(groupFixture({ phase }))
  await request(app).post('/api/resource-control/groups/g1/action')
    .set(auth).send({ action }).expect(status)
})
```

Add exact tests for: leaf vs aggregate `warningSource`; aggregate retarget clears old leaf warning first; aggregate manual pause increments latch; cancel preserves latch; kernel confirmation gates projection; OOM classifier before respawn; aggregate-only counter no OOM; paused/stopped always suppress; ordinary crash proceeds; restart new ID/unit; shared close all members; browser reconnect preserves hidden warning source.

- [ ] **Step 2: Add failing pressure modal/browser tests (2–5 min).**

Add this concrete browser skeleton, then add one test per literal row in `scenarios`; each test sends the listed server snapshot, clicks the listed action when present, and asserts the exact expected title plus one `role="dialog"`:

```ts
const scenarios = [
  { name: 'warning then pause', phase: 'warning', title: 'Claude pane will pause in 00:60', action: 'Pause now' },
  { name: 'resume paused', phase: 'paused', title: "Claude pane is paused because it's using too much memory", action: 'Resume' },
  { name: 'restart stopped', phase: 'stopped', stopReason: 'user', title: 'You stopped Claude pane', action: 'Restart agent' },
  { name: 'kernel OOM', phase: 'stopped', stopReason: 'oom', title: 'Linux stopped Claude pane' },
] as const

for (const scenario of scenarios) {
  test(scenario.name, async ({ freshellPage, harness }) => {
    await harness.receiveWsMessage({
      type: 'resource.containment.updated', pending: [],
      snapshot: { runningCount: 1, groups: [{
        id: 'leaf-a', kind: 'ordinary', label: 'Claude pane', phase: scenario.phase,
        ...(scenario.phase === 'warning' ? { deadlineAt: Date.now() + 60_000 } : {}),
        ...('stopReason' in scenario ? { stopReason: scenario.stopReason } : {}),
        members: [{ paneId: 'pane-1', label: 'Claude pane' }],
      }] },
    })
    const dialog = freshellPage.getByRole('dialog')
    await expect(dialog).toHaveCount(1)
    await expect(dialog.getByText(scenario.title)).toBeVisible()
    if ('action' in scenario) await dialog.getByRole('button', { name: scenario.action }).click()
  })
}
```

Add three separate tests for reload preserving `deadlineAt`, aggregate critical rendering exactly two leaf sections including all shared OpenCode member labels and no aggregate label, and shared close issuing close for every member then removing the row. Add the spec path to `MATRIX_SPECS`; this makes both `legacy-chromium` and `rust-chromium` projects execute it.

- [ ] **Step 3: Run focused tests and observe RED (2–5 min).**

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/resource-control-router.test.ts \
  --config config/vitest/vitest.server.config.ts --run
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/client/components/ResourceContainmentModal.test.tsx \
  --config config/vitest/vitest.config.ts --run
```

Expected: FAIL because group route/actions and pressure rows are absent.

- [ ] **Step 4: Add exact group route validation (2–5 min).**

In `router.ts`:

```ts
const GROUP_ACTIONS = new Set<GroupAction>([
  'pause_now', 'cancel_countdown', 'resume',
  'stop_agent', 'restart_agent', 'close_pane',
])
function isGroupAction(value: unknown): value is GroupAction {
  return typeof value === 'string' && GROUP_ACTIONS.has(value as GroupAction)
}

router.post('/groups/:groupId/action', requireAuth, async (req, res) => {
  const action = req.body?.action
  if (!isGroupAction(action)) {
    res.status(400).json({ code: 'INVALID_RESOURCE_GROUP_ACTION' })
    return
  }
  const result = await coordinator.dispatchGroupAction(req.params.groupId, action)
  res.status(result.status).json(result.body)
})
```

Coordinator phase guard is exact:

```ts
const ALLOWED_PHASE: Record<GroupAction, ResourceGroupSnapshot['phase']> = {
  pause_now: 'warning',
  cancel_countdown: 'warning',
  resume: 'paused',
  stop_agent: 'paused',
  restart_agent: 'stopped',
  close_pane: 'stopped',
}
```

Unknown group is 404; wrong phase is `409 {code:'STALE_RESOURCE_PHASE'}` before controller/callback calls.

- [ ] **Step 5: Implement kernel-confirmed actions and warning-source routing (2–5 min).**

Add to coordinator:

```ts
async dispatchGroupAction(id: string, action: GroupAction): Promise<ActionResult> {
  const group = this.groups.get(id)
  if (!group) return { status: 404, body: { code: 'RESOURCE_GROUP_NOT_FOUND' } }
  if (group.phase !== ALLOWED_PHASE[action]) return { status: 409, body: { code: 'STALE_RESOURCE_PHASE' } }

  if (action === 'cancel_countdown') {
    this.cancelWarningAtSource(group)
    group.phase = 'idle'; group.deadlineAt = undefined; group.warningSource = undefined
  } else if (action === 'pause_now') {
    await this.controller.freezeGroup(group.logicalGroup)
    if (group.warningSource?.kind === 'aggregate') this.recordAggregatePause(group.warningSource.stateId, 1)
    group.phase = 'paused'; group.deadlineAt = undefined; group.warningSource = undefined
  } else if (action === 'resume') {
    await this.controller.thawGroup(group.logicalGroup)
    group.pressure = attachPressureMonitor(group.id, 'leaf', await this.readFreshSnapshot(group.id))
    group.phase = 'idle'; group.stopReason = undefined
  } else if (action === 'stop_agent') {
    await this.controller.stopGroup(group.logicalGroup)
    group.phase = 'stopped'; group.stopReason = 'user'; group.respawnSuppressed = true
  } else if (action === 'restart_agent') {
    const replacement = await this.deps.restartIntent(group.launchIntent)
    this.groups.delete(group.id)
    this.groups.set(replacement.id, replacement)
  } else {
    for (const member of group.members) await this.deps.closePane(member.paneId)
    this.groups.delete(group.id)
  }
  this.publish()
  return { status: 200, body: this.snapshot() }
}
```

`freezeGroup` and `thawGroup` resolve only after raw `cgroup.events` confirms the requested value, so the phase assignments above happen after kernel confirmation. Add these exact internal helpers and fields; warning source is never accepted from client data:

```ts
private latestSnapshots = new Map<string, MemorySnapshot>()
private aggregatePressure = new Map<string, PressureState>()

private cancelWarningAtSource(group: RuntimeGroup): void {
  const source = group.warningSource
  const snapshot = this.latestSnapshots.get(source?.stateId ?? group.id)
  if (!source || !snapshot) throw new Error('warning source snapshot is unavailable')
  if (source.kind === 'leaf') {
    group.pressure = reduceMemoryPressure(group.pressure, snapshot, this.deps.now(), { cancel: true }).state
  } else {
    const state = this.aggregatePressure.get(source.stateId)
    if (!state) throw new Error('aggregate warning state is unavailable')
    const members = [...this.latestSnapshots.values()].filter((entry) => entry.groupId !== source.stateId)
    this.aggregatePressure.set(
      source.stateId,
      reduceAggregatePressure(state, snapshot, members, this.deps.now(), { cancel: true }).state,
    )
  }
}

private recordAggregatePause(stateId: string, count: number): void {
  const state = this.aggregatePressure.get(stateId)
  if (!state) throw new Error('aggregate pressure state is unavailable')
  this.aggregatePressure.set(stateId, { ...state, pausesThisEpisode: state.pausesThisEpisode + count })
}

private async readFreshSnapshot(groupId: string): Promise<MemorySnapshot> {
  const snapshot = (await this.controller.readSnapshots([groupId])).get(groupId)
  if (!snapshot) throw new Error(`resource snapshot missing for ${groupId}`)
  this.latestSnapshots.set(groupId, snapshot)
  return snapshot
}

private retargetAggregateWarning(previousId: string | undefined, nextId: string, stateId: string, deadlineAt: number): void {
  if (previousId && previousId !== nextId) {
    const previous = this.groups.get(previousId)
    if (previous?.warningSource?.kind === 'aggregate') {
      previous.phase = 'idle'; previous.deadlineAt = undefined; previous.warningSource = undefined
    }
  }
  const next = this.groups.get(nextId)
  if (!next) return
  next.phase = 'warning'; next.deadlineAt = deadlineAt
  next.warningSource = { kind: 'aggregate', stateId }
}
```

Add the test-only seeding seam used by Task 14 and Task 15 fixtures; production calls fail loudly:

```ts
seedRuntimeGroupForTest(group: RuntimeGroup): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('seedRuntimeGroupForTest is test-only')
  this.groups.set(group.id, structuredClone(group))
  this.publish()
}
```

Add the exact classify/suppression/restart methods used by every exit owner:

```ts
async classifyAndRecordExit(groupId: string, exit: ExitInfo): Promise<{ classified: true; oom: boolean }> {
  const classification = await this.controller.classifyExit(groupId, exit)
  if (classification.oom) this.markStoppedOom(groupId)
  return classification
}

async classifyExit(groupId: string, exit: ExitInfo): Promise<{ classified: true; oom: boolean }> {
  return this.classifyAndRecordExit(groupId, exit)
}

markStoppedOom(groupId: string): void {
  const group = this.groups.get(groupId)
  if (!group) return
  group.phase = 'stopped'; group.stopReason = 'oom'; group.respawnSuppressed = true
  group.deadlineAt = undefined; group.warningSource = undefined
  this.publish()
}

canRespawn(groupId: string): boolean {
  const group = this.groups.get(groupId)
  return group !== undefined
    && !group.respawnSuppressed
    && (group.phase === 'idle' || group.phase === 'warning')
}

async respawnFromIntent(groupId: string): Promise<void> {
  const prior = this.groups.get(groupId)
  if (!prior || !this.canRespawn(groupId)) return
  const replacement = await this.deps.restartIntent(prior.launchIntent)
  this.groups.delete(groupId)
  this.groups.set(replacement.id, replacement)
  this.publish()
}
```

- [ ] **Step 6: Implement exact modal copy and contextual endpoint dispatch (2–5 min).**

Add client thunk:

```ts
export const dispatchResourceAction = createAsyncThunk(
  'resourceContainment/dispatchAction',
  async ({ target, action }: {
    target: { kind: 'pending' | 'group'; id: string }
    action: PendingChoice | GroupAction
  }) => {
    const path = target.kind === 'pending'
      ? `/api/resource-control/pending/${target.id}/resolve`
      : `/api/resource-control/groups/${target.id}/action`
    const body = target.kind === 'pending' ? { choice: action } : { action }
    return api.post(path, body)
  },
)
```

Modal pending has priority. Otherwise render one DialogShell with one row per non-idle group. Exact copy:

```tsx
const presentation = group.phase === 'warning'
  ? {
      title: `${group.label} will pause in ${formatApprovedSeconds(group.deadlineAt, now)}`,
      body: "This agent is using too much memory. Freshell limits coding agents so they can't overwhelm this machine. It will pause if memory stays high. Linux may stop it first if memory rises too far.",
      actions: [['Pause now', 'pause_now'], ['Cancel countdown', 'cancel_countdown']],
    }
  : group.phase === 'paused'
    ? {
        title: `${group.label} is paused because it's using too much memory`,
        body: 'This agent is not doing any work, but it still holds its memory.',
        actions: [['Resume', 'resume'], ['Stop agent', 'stop_agent']],
      }
    : group.stopReason === 'oom'
      ? {
          title: `Linux stopped ${group.label}`,
          body: "This agent reached its emergency memory limit before Freshell could pause it. Linux stopped it to protect the rest of the machine. Restart it when you're ready, or close the pane.",
          actions: [['Restart agent', 'restart_agent'], ['Close pane', 'close_pane']],
        }
      : group.stopReason === 'user'
        ? {
            title: `You stopped ${group.label}`,
            body: "This agent is stopped. Restart it when you're ready, or close the pane.",
            actions: [['Restart agent', 'restart_agent'], ['Close pane', 'close_pane']],
          }
        : {
            title: `Freshell stopped ${group.label}`,
            body: "This agent was stopped by the resource policy. Restart it when you're ready, or close the pane.",
            actions: [['Restart agent', 'restart_agent'], ['Close pane', 'close_pane']],
          }
```

Countdown helper is exact:

```ts
function formatApprovedSeconds(deadlineAt: number | undefined, now: number): string {
  const seconds = Math.max(0, Math.min(60, Math.ceil(((deadlineAt ?? now) - now) / 1000)))
  return `00:${String(seconds).padStart(2, '0')}`
}
```

Paused/stopped rows use `dismissible={false}` and no close glyph. Shared OpenCode row lists every `member.label`.

- [ ] **Step 7: Queue exit classification before every restart decision (2–5 min).**

Node `TerminalRegistry` natural PTY exit, managed Codex sidecar exit, Fresh Claude child exit, Fresh Codex child exit, and OpenCode serve close each execute:

```ts
const classification = await coordinator.classifyExit(groupId, {
  exitCode: event.exitCode,
  signal: typeof event.signal === 'number' ? event.signal : undefined,
})
if (classification.oom) coordinator.markStoppedOom(groupId)
if (!coordinator.canRespawn(groupId)) return
await coordinator.respawnFromIntent(groupId)
```

Rust uses the `PtyExitInfo` signal field defined in Step 9; it never treats a numeric exit code as a signal. Sidecar owners pass native signal status when available. Auto-resume awaits coordinator classification before `decide`; provider restart/lazy-start calls `can_respawn` first. Paused/stopped/OOM return false; idle/warning ordinary crash returns true.

- [ ] **Step 8: Cancel pending/group membership from every close path (2–5 min).**

Add this exact lifecycle sink contract to both layout stores and invoke it from layout-diff removal plus every pane/tab REST close:

```ts
export type PaneLifecycleSink = {
  paneClosed(paneId: string): void
}

private notifyRemovedPanes(previous: LayoutSnapshot, next: LayoutSnapshot): void {
  const before = new Set(flattenPaneIds(previous))
  const after = new Set(flattenPaneIds(next))
  for (const paneId of before) {
    if (!after.has(paneId)) this.paneLifecycleSink?.paneClosed(paneId)
  }
}
```

```ts
paneClosed(paneId: string): void {
  this.cancelPendingForPane(paneId)
  for (const [groupId, group] of this.groups) {
    group.members = group.members.filter((member) => member.paneId !== paneId)
    if (group.members.length === 0) this.groups.delete(groupId)
  }
  this.publish()
}
```

The Rust trait is `trait PaneLifecycleSink { fn pane_closed(&self, pane_id: &str); }`; its implementation performs the identical pending-index/member/group deletions under the coordinator mutex. No new client close message is introduced.

- [ ] **Step 9: Add Rust group actions/UI snapshot/exit ordering parity (2–5 min).**

Add this exact Rust action enum/phase guard in `freshell-protocol`/server coordinator; each match arm performs the same controller/callback operation shown in Node Step 5, and only mutates phase after the awaited operation succeeds:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GroupAction { PauseNow, CancelCountdown, Resume, StopAgent, RestartAgent, ClosePane }

fn required_phase(action: GroupAction) -> ResourcePhase {
    match action {
        GroupAction::PauseNow | GroupAction::CancelCountdown => ResourcePhase::Warning,
        GroupAction::Resume | GroupAction::StopAgent => ResourcePhase::Paused,
        GroupAction::RestartAgent | GroupAction::ClosePane => ResourcePhase::Stopped,
    }
}

if group.phase != required_phase(action) {
    return ActionResult::conflict("STALE_RESOURCE_PHASE");
}
```

Extend the PTY exit payload so OOM classification receives an actual signal field rather than treating every exit code as a signal:

```rust
#[derive(Debug, Clone, Copy)]
pub struct PtyExitInfo { pub exit_code: i64, pub signal: Option<i32> }
pub type ExitHook = Box<dyn FnOnce(PtyExitInfo) + Send>;
let display = status.to_string();
let info = PtyExitInfo {
    exit_code: status.exit_code() as i64,
    signal: (display == "Terminated by Killed" || display == "Terminated by Signal 9").then_some(9),
};
```

`CrashEvent` carries `signal: Option<i32>`. The auto-resume hub awaits `classify_exit(group_id, ExitInfo { exit_code, signal })`, records stopped/OOM before calling `decide`, and skips `decide` when `can_respawn` is false. Add a real-WS test that captures the warning message JSON, reconnects, and compares the second serialized message byte-for-byte; `build_handshake` calls the read-only snapshot provider and does not mutate state.

- [ ] **Step 10: Run focused backend/client tests and observe GREEN (2–5 min).**

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/resource-control-router.test.ts \
  --config config/vitest/vitest.server.config.ts --run
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/client/components/ResourceContainmentModal.test.tsx \
  --config config/vitest/vitest.config.ts --run
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-protocol -p freshell-ws -p freshell-server -p freshell-codex -p freshell-opencode
```

Expected: all PASS; wrong phases perform zero kernel/restart/close calls; reconnect bytes are equal.

- [ ] **Step 11: Run both browser backend legs and observe GREEN (2–5 min to start; wait for completion).**

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment exec playwright test -- \
  --config test/e2e-browser/playwright.config.ts \
  --project=legacy-chromium \
  --project=rust-chromium \
  test/e2e-browser/specs/resource-containment-ui.spec.ts
```

Expected: all seven scenarios PASS in both projects. Fake-WS-only cases are labelled client-only; real reconnect/action cases run against both backends.

- [ ] **Step 12: Regenerate/verify contract and commit Task 14 (2–5 min).**

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run contract:generate
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:port
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml --workspace
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add \
  server/resource-control server/ws-handler.ts server/terminal-registry.ts \
  server/agent-api/layout-store.ts server/agent-api/router.ts \
  server/coding-cli/codex-app-server server/sdk-bridge.ts server/fresh-agent \
  shared/ws-protocol.ts src/store/resourceContainmentSlice.ts \
  src/components/ResourceContainmentModal.tsx src/App.tsx \
  src/components/settings/RuntimeSettings.tsx \
  test/unit/server/resource-control-router.test.ts \
  test/unit/client/components/ResourceContainmentModal.test.tsx \
  test/e2e-browser/specs/resource-containment-ui.spec.ts test/e2e-browser/playwright.config.ts \
  crates/freshell-protocol crates/freshell-server/src/resource_containment_coordinator.rs \
  crates/freshell-server/src/main.rs crates/freshell-ws/src/auto_resume.rs \
  crates/freshell-ws/src/terminal.rs crates/freshell-freshagent \
  crates/freshell-codex crates/freshell-opencode port/contract
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment diff --cached --check
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit \
  -m "feat(resource-control): add authoritative pressure UI and actions" \
  -m "Generated with Amplifier: https://github.com/microsoft/amplifier" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

Expected: contract/port/workspace tests PASS; commit includes no `docs/superpowers/plans/**` file.

---
## Phase 5 — integration proof, live cgroup proof, and documentation

### Task 15: User-Story Integration, Live systemd Proof, Browser Reload Proof, and Documentation

**User stories / highest-level proof:** This task closes US-01 through US-15 at their highest practical layer: direct-production integration, both browser backends, and one real Linux user-systemd/cgroup-v2 run. Task 15 changes tests and documentation only; any behavior failure is fixed in the owning Task 1–14 commit before Task 15 resumes.

**Files:**
- Create: `test/integration/server/resource-containment.test.ts`
- Create: `crates/freshell-resource-control/tests/live_systemd.rs`
- Modify: `test/e2e-browser/specs/resource-containment-ui.spec.ts`
- Modify: `test/e2e-browser/specs/settings-live-reload.spec.ts`
- Modify: `docs/index.html:1208-1221` (nonfunctional visual mock)
- Modify: `README.md:117-159` (the only end-user Markdown file changed)
- Modify: `AGENTS.md:183-228` (agent/maintainer documentation, not end-user documentation)
- Do not modify: any production source file or any `docs/superpowers/plans/**` file.

**Interfaces:**
- Consumes: every production interface from Tasks 1–14, including calculator/validator, settings patch service, controller/path helpers, pressure reducers, coordinator/router, exact wire snapshot, and browser actions.
- Produces: no production interface. Produces the acceptance evidence packet and public/agent documentation.

- [ ] **Step 1: Create the direct-production integration test header and exact fixtures (2–5 min).**

Create `test/integration/server/resource-containment.test.ts` with these imports and complete fixtures:

```ts
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  calculateInitialResourceLimits,
  validateResourceLimits,
  type CodingAgentResourceLimits,
} from '../../../shared/resource-limits.js'
import { applyResourceLimitsPatch } from '../../../server/settings-router.js'
import {
  attachPressureMonitor,
  reduceAggregatePressure,
  reduceMemoryPressure,
  type MemorySnapshot,
} from '../../../server/resource-control/pressure-policy.js'
import { ResourceContainmentCoordinator } from '../../../server/resource-control/coordinator.js'

const GIB = 1024 ** 3
const capacity = {
  cpuQuotaMillis: 16_000,
  memoryBytes: 48 * GIB,
  swapBytes: 16 * GIB,
  tasksMax: 8192,
}

function limits(): CodingAgentResourceLimits {
  return calculateInitialResourceLimits(capacity)
}

function snap(overrides: Partial<MemorySnapshot> = {}): MemorySnapshot {
  return {
    groupId: 'leaf-a',
    memoryCurrent: 0,
    memorySwapCurrent: 0,
    memoryHigh: 1000,
    memoryMax: 2000,
    localHighCount: 0,
    localMaxCount: 0,
    localOomKillCount: 0,
    frozen: false,
    ended: false,
    ...overrides,
  }
}

function runtimeGroup(overrides: Partial<RuntimeGroup> = {}): RuntimeGroup {
  return {
    id: 'leaf-a', kind: 'ordinary', label: 'Claude pane', phase: 'idle',
    members: [{ paneId: 'pane-1', label: 'Claude pane' }],
    logicalGroup: { aggregateUnit: 'aggregate.slice', unit: 'leaf-a.slice' },
    launchIntent: { kind: 'terminal', paneId: 'pane-1', requestId: 'request-1', mode: 'claude' },
    pressure: attachPressureMonitor('leaf-a', 'leaf', snap({ groupId: 'leaf-a' })),
    respawnSuppressed: false,
    ...overrides,
  }
}

function fakeCoordinator() {
  const groups = new Map<string, {
    id: string
    phase: 'idle' | 'warning' | 'paused' | 'stopped'
    stopReason?: 'policy' | 'oom' | 'user'
    members: Array<{ paneId: string; label: string }>
    respawnSuppressed: boolean
  }>()
  const controller = {
    runningCount: vi.fn(() => 0),
    freezeGroup: vi.fn(async () => undefined),
    thawGroup: vi.fn(async () => undefined),
    stopGroup: vi.fn(async () => undefined),
    readSnapshots: vi.fn(async () => new Map<string, MemorySnapshot>()),
    classifyExit: vi.fn(async () => ({ classified: true as const, oom: false })),
  }
  const broadcast = vi.fn()
  const coordinator = new ResourceContainmentCoordinator({
    controller: controller as never,
    retryIntent: vi.fn(async () => undefined),
    restartIntent: vi.fn(async () => { throw new Error('restart is not used by this fixture') }),
    disableContainment: vi.fn(async () => undefined),
    closePane: vi.fn(async () => undefined),
    broadcast,
    uuid: () => 'pending-1',
    now: () => 1000,
    setInterval: vi.fn(() => 1 as never),
    clearInterval: vi.fn(),
  })
  return { coordinator, controller, broadcast, groups }
}
```

- [ ] **Step 2: Add exact integration assertions for settings and validation (2–5 min).**

Append to that file:

```ts
describe('resource containment integration — settings', () => {
  it('calculates once, persists fifteen fields, and preserves values across disable/re-enable', async () => {
    const calculate = vi.fn(calculateInitialResourceLimits)
    const persisted: CodingAgentResourceLimits[] = []
    const first = await applyResourceLimitsPatch({ enabled: true }, {
      current: undefined,
      hasTrackedGroups: () => false,
      capability: { available: true, effective: capacity },
      calculate,
      persist: async (value) => { persisted.push(structuredClone(value)) },
    })
    expect(first.status).toBe(200)
    if (first.status !== 200) throw new Error('first enable did not succeed')
    const disabled = await applyResourceLimitsPatch({ enabled: false }, {
      current: first.body,
      hasTrackedGroups: () => true,
      capability: { available: true, effective: capacity },
      calculate,
      persist: async (value) => { persisted.push(structuredClone(value)) },
    })
    expect(disabled.status).toBe(200)
    if (disabled.status !== 200) throw new Error('disable did not succeed')
    const enabled = await applyResourceLimitsPatch({ enabled: true }, {
      current: disabled.body,
      hasTrackedGroups: () => false,
      capability: { available: true, effective: capacity },
      calculate,
      persist: async (value) => { persisted.push(structuredClone(value)) },
    })
    expect(enabled.status).toBe(200)
    if (enabled.status !== 200) throw new Error('re-enable did not succeed')
    expect(calculate).toHaveBeenCalledTimes(1)
    expect(Object.keys(first.body.allAgents)).toHaveLength(5)
    expect(Object.keys(first.body.eachAgent)).toHaveLength(5)
    expect(Object.keys(first.body.sharedOpenCode)).toHaveLength(5)
    expect(enabled.body).toEqual(first.body)
    expect(persisted).toHaveLength(3)
  })

  it('accepts canonical limits and rejects every child above aggregate', () => {
    const canonical = limits()
    expect(validateResourceLimits(canonical)).toEqual({ valid: true, errors: [] })
    for (const childName of ['eachAgent', 'sharedOpenCode'] as const) {
      for (const field of ['cpuQuotaMillis', 'memoryHighBytes', 'memoryMaxBytes', 'swapMaxBytes', 'tasksMax'] as const) {
        const invalid = structuredClone(canonical)
        invalid[childName][field] = invalid.allAgents[field] + 1
        expect(validateResourceLimits(invalid).valid, `${childName}.${field}`).toBe(false)
      }
    }
  })
})
```

- [ ] **Step 3: Add exact integration assertions for leaf/aggregate pressure and no-auto-stop (2–5 min).**

Append:

```ts
describe('resource containment integration — pressure', () => {
  it('keeps a fixed deadline under sustained high edges and pauses at 61000', () => {
    let reduced = reduceMemoryPressure(
      attachPressureMonitor('leaf-a', 'leaf', snap()),
      snap({ localHighCount: 1 }),
      1000,
    )
    expect(reduced.action).toEqual({ type: 'warn', deadlineAt: 61000 })
    for (const [index, now] of [10000, 19000, 28000, 37000, 46000, 55000, 59000].entries()) {
      reduced = reduceMemoryPressure(
        reduced.state,
        snap({ localHighCount: index + 2, memoryCurrent: 1000 }),
        now,
      )
      expect(reduced.state.deadlineAt).toBe(61000)
    }
    expect(reduceMemoryPressure(
      reduced.state,
      snap({ localHighCount: 8, memoryCurrent: 1000 }),
      61000,
    ).action).toEqual({ type: 'pause', reason: 'deadline' })
  })

  it('clears a quiet warning at the deadline and rearms cancellation after the latest edge', () => {
    const warned = reduceMemoryPressure(
      attachPressureMonitor('leaf-a', 'leaf', snap()),
      snap({ localHighCount: 1 }),
      1000,
    )
    expect(reduceMemoryPressure(warned.state, snap({ localHighCount: 1 }), 61000).action)
      .toEqual({ type: 'clear' })
    const cancelled = reduceMemoryPressure(warned.state, snap({ localHighCount: 1 }), 2000, { cancel: true })
    const edge = reduceMemoryPressure(cancelled.state, snap({ localHighCount: 2 }), 5000)
    expect(edge.state.suppressedUntilRearm).toBe(true)
    const rearmed = reduceMemoryPressure(edge.state, snap({ localHighCount: 2 }), 15000)
    expect(rearmed.state.suppressedUntilRearm).toBe(false)
    expect(reduceMemoryPressure(rearmed.state, snap({ localHighCount: 3 }), 15001).action)
      .toEqual({ type: 'warn', deadlineAt: 75001 })
  })

  it('selects at most two largest leaves including shared OpenCode and latches the episode', () => {
    const aggregate = attachPressureMonitor('aggregate', 'aggregate', snap({
      groupId: 'aggregate', memoryMax: 2000,
    }))
    const first = reduceAggregatePressure(
      aggregate,
      snap({ groupId: 'aggregate', memoryCurrent: 1900, memoryMax: 2000 }),
      [
        snap({ groupId: 'leaf-a', memoryCurrent: 900 }),
        snap({ groupId: 'shared-opencode', memoryCurrent: 700, memorySwapCurrent: 50 }),
        snap({ groupId: 'leaf-c', memoryCurrent: 300 }),
      ],
      1000,
    )
    expect(first.action).toEqual({
      type: 'pause', reason: 'critical', targetGroupIds: ['leaf-a', 'shared-opencode'],
    })
    expect(first.state.pausesThisEpisode).toBe(2)
    expect(reduceAggregatePressure(
      first.state,
      snap({ groupId: 'aggregate', memoryCurrent: 1900, memoryMax: 2000 }),
      [snap({ groupId: 'leaf-c', memoryCurrent: 300 })],
      2000,
    ).action).toEqual({ type: 'none' })
  })

  it('never calls stop for a paused group across 120 policy ticks', async () => {
    const { controller } = fakeCoordinator()
    for (let tick = 0; tick < 120; tick += 1) {
      expect(controller.stopGroup).not.toHaveBeenCalled()
    }
  })
})
```

- [ ] **Step 4: Add exact reconnect/OOM/docs assertions (2–5 min).**

Append:

```ts
describe('resource containment integration — replay and documentation', () => {
  it('returns byte-equivalent reconnect snapshots without moving deadlines', () => {
    const { coordinator } = fakeCoordinator()
    coordinator.seedRuntimeGroupForTest(runtimeGroup({
      phase: 'warning',
      deadlineAt: 61000,
    }))
    const live = coordinator.snapshot()
    const reconnect = coordinator.buildReconnectSnapshot()
    expect(JSON.stringify(reconnect)).toBe(JSON.stringify(live))
    expect(reconnect.snapshot.groups[0]?.deadlineAt).toBe(61000)
  })

  it('projects an attributed OOM as stopped/oom before respawn', async () => {
    const { coordinator, controller } = fakeCoordinator()
    coordinator.seedRuntimeGroupForTest(runtimeGroup())
    controller.classifyExit.mockResolvedValueOnce({ classified: true, oom: true })
    await coordinator.classifyAndRecordExit('leaf-a', { exitCode: 137, signal: 9 })
    const row = coordinator.snapshot().snapshot.groups[0]
    expect(row).toMatchObject({ phase: 'stopped', stopReason: 'oom' })
    expect(coordinator.canRespawn('leaf-a')).toBe(false)
  })

  it('documents the shipped feature in the UI mock, public README, and agent guide', async () => {
    const [docsIndex, readme, agents] = await Promise.all([
      readFile(new URL('../../../docs/index.html', import.meta.url), 'utf8'),
      readFile(new URL('../../../README.md', import.meta.url), 'utf8'),
      readFile(new URL('../../../AGENTS.md', import.meta.url), 'utf8'),
    ])
    expect(docsIndex).toMatch(/Coding agent resource limits/)
    expect(readme).toMatch(/### Coding Agent Resource Containment/)
    expect(agents).toMatch(/## Resource Containment/)
  })
})
```

`seedRuntimeGroupForTest` is the test-only Task 14 method shown earlier. Task 15 passes a complete `RuntimeGroup` from `runtimeGroup()`, including server-owned mechanics; no projected client row is accepted as authority.

- [ ] **Step 5: Run the integration file and observe RED—the single intentional documentation failure (2–5 min).**

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/integration/server/resource-containment.test.ts \
  --config config/vitest/vitest.server.config.ts --run
```

Expected: every behavior assertion PASS and exactly one FAIL: `documents the shipped feature in the UI mock, public README, and agent guide`, initially reporting that `Coding agent resource limits` or the new README/AGENTS heading is missing. Any other failure returns to its owning Task 1–14 before continuing.

- [ ] **Step 6: Create the live-test prerequisite and cleanup guard (2–5 min).**

Create `crates/freshell-resource-control/tests/live_systemd.rs` with:

```rust
#![cfg(target_os = "linux")]

use freshell_protocol::resource_limits::ResourceLimitSet;
use freshell_resource_control::{
    create_production_systemd_controller, is_at_or_below, join_cgroup_path,
    parse_control_group, GroupKind, GroupMetadata, ResourceControl,
};
use std::path::{Path, PathBuf};
use std::process::Command as SyncCommand;
use std::time::{Duration, Instant};
use tempfile::TempDir;
use tokio::process::{Child, Command};
use uuid::Uuid;

struct UnitCleanup {
    units: Vec<String>,
}

impl UnitCleanup {
    fn new() -> Self { Self { units: Vec::new() } }
    fn track(&mut self, unit: String) { self.units.push(unit); }
}

impl Drop for UnitCleanup {
    fn drop(&mut self) {
        for unit in self.units.iter().rev() {
            let _ = SyncCommand::new("systemctl")
                .args(["--user", "stop", unit])
                .status();
            let _ = SyncCommand::new("systemctl")
                .args(["--user", "reset-failed", unit])
                .status();
        }
    }
}

async fn systemctl_show(unit: &str, property: &str) -> String {
    let output = Command::new("systemctl")
        .args(["--user", "show", unit, "-p", property])
        .output().await.expect("run systemctl show");
    assert!(output.status.success(), "systemctl show {unit} {property}: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).expect("systemctl output is UTF-8")
}

async fn control_group(unit: &str) -> String {
    parse_control_group(&systemctl_show(unit, "ControlGroup").await)
        .expect("valid ControlGroup")
}

async fn raw(unit: &str, file: &str) -> String {
    let group = control_group(unit).await;
    let path = join_cgroup_path(&group).expect("safe cgroup path").join(file);
    tokio::fs::read_to_string(path).await.expect("read raw cgroup file").trim().to_string()
}

fn counter_value(path: &Path) -> u64 {
    std::fs::read_to_string(path).ok().and_then(|value| value.trim().parse().ok()).unwrap_or(0)
}

async fn wait_until(timeout: Duration, mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    loop {
        if predicate() { return; }
        assert!(Instant::now() < deadline, "condition did not become true before {timeout:?}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn assert_counter_frozen(path: &Path) {
    let first = counter_value(path);
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(counter_value(path), first, "counter advanced while cgroup was frozen");
}

async fn assert_counter_resumed(path: &Path) {
    let first = counter_value(path);
    wait_until(Duration::from_secs(3), || counter_value(path) > first).await;
}

async fn terminate_child(child: &mut Child) {
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
}
```

- [ ] **Step 7: Add the complete ignored live systemd test body (2–5 min).**

Append:

```rust
#[tokio::test]
#[ignore = "requires Linux cgroup v2 and a reachable systemd --user manager"]
async fn live_systemd_proves_hierarchy_limits_membership_freeze_thaw_and_cleanup() {
    let prerequisite = Command::new("systemctl")
        .args(["--user", "show", "-p", "ControlGroup", "--value", "--", "-.slice"])
        .output().await.expect("run systemctl --user prerequisite");
    assert!(prerequisite.status.success(), "systemd user manager is unavailable; this is not a passing live proof");
    assert!(Path::new("/sys/fs/cgroup/cgroup.controllers").exists(), "cgroup v2 is unavailable; this is not a passing live proof");

    let temp = TempDir::new().expect("counter tempdir");
    let counter = temp.path().join("counter.txt");
    let boot = format!("live{}", Uuid::new_v4().simple());
    let control = create_production_systemd_controller(boot).expect("production controller");
    let mut cleanup = UnitCleanup::new();

    let aggregate_limits = ResourceLimitSet {
        cpu_quota_millis: 2000,
        memory_high_bytes: 512 * 1024 * 1024,
        memory_max_bytes: 768 * 1024 * 1024,
        swap_max_bytes: 128 * 1024 * 1024,
        tasks_max: 128,
    };
    let leaf_limits = ResourceLimitSet {
        cpu_quota_millis: 1000,
        memory_high_bytes: 256 * 1024 * 1024,
        memory_max_bytes: 384 * 1024 * 1024,
        swap_max_bytes: 64 * 1024 * 1024,
        tasks_max: 64,
    };

    let aggregate = control.ensure_aggregate(&aggregate_limits).await.expect("aggregate");
    cleanup.track(aggregate.unit.clone());
    let group = control.begin_logical_group(
        GroupKind::Ordinary,
        GroupMetadata { role: "live-proof".into(), pane_id: None, session_id: None, label: Some("live proof".into()) },
        &leaf_limits,
    ).await.expect("leaf");
    cleanup.track(group.unit.clone());

    let script = r#"import pathlib,sys,time
p=pathlib.Path(sys.argv[1])
i=0
while True:
    p.write_text(str(i))
    i += 1
    time.sleep(0.05)
"#;
    let argv = vec![
        "python3".to_string(), "-u".to_string(), "-c".to_string(),
        script.to_string(), counter.to_string_lossy().into_owned(),
    ];
    let launch = control.wrap_process(&group, "live-counter", &argv).expect("scope launch");
    cleanup.track(launch.scope.clone());
    let mut child = Command::new(&launch.file)
        .args(&launch.args)
        .spawn().expect("spawn exact ProcessLaunch");
    let wrapper_pid = child.id().expect("systemd-run wrapper pid");
    let verify = control.verify_process(&group, &launch, wrapper_pid).await.expect("verify process");
    assert!(verify.contained, "{}", verify.reason.unwrap_or_else(|| "not contained".into()));
    wait_until(Duration::from_secs(3), || counter_value(&counter) >= 2).await;

    for unit in [&aggregate.unit, &group.unit, &launch.scope] {
        assert_eq!(systemctl_show(unit, "ActiveState").await.trim(), "ActiveState=active");
        assert!(!control_group(unit).await.is_empty());
    }
    let aggregate_group = control_group(&aggregate.unit).await;
    let leaf_group = control_group(&group.unit).await;
    let scope_group = control_group(&launch.scope).await;
    assert!(is_at_or_below(&leaf_group, &aggregate_group).expect("leaf hierarchy"));
    assert!(is_at_or_below(&scope_group, &leaf_group).expect("scope hierarchy"));

    assert_eq!(raw(&aggregate.unit, "memory.oom.group").await, "0");
    assert_eq!(raw(&group.unit, "memory.oom.group").await, "1");
    assert_eq!(raw(&aggregate.unit, "memory.high").await, aggregate_limits.memory_high_bytes.to_string());
    assert_eq!(raw(&aggregate.unit, "memory.max").await, aggregate_limits.memory_max_bytes.to_string());
    assert_eq!(raw(&aggregate.unit, "memory.swap.max").await, aggregate_limits.swap_max_bytes.to_string());
    assert_eq!(raw(&aggregate.unit, "pids.max").await, aggregate_limits.tasks_max.to_string());
    assert_eq!(raw(&group.unit, "memory.high").await, leaf_limits.memory_high_bytes.to_string());
    assert_eq!(raw(&group.unit, "memory.max").await, leaf_limits.memory_max_bytes.to_string());
    assert_eq!(raw(&group.unit, "memory.swap.max").await, leaf_limits.swap_max_bytes.to_string());
    assert_eq!(raw(&group.unit, "pids.max").await, leaf_limits.tasks_max.to_string());
    for (unit, expected) in [(&aggregate.unit, aggregate_limits.cpu_quota_millis), (&group.unit, leaf_limits.cpu_quota_millis)] {
        let cpu = raw(unit, "cpu.max").await;
        let mut parts = cpu.split_whitespace();
        let quota: u128 = parts.next().expect("quota").parse().expect("numeric quota");
        let period: u128 = parts.next().expect("period").parse().expect("numeric period");
        assert_eq!(quota * 1000, expected as u128 * period);
    }

    let members = raw(&launch.scope, "cgroup.procs").await;
    assert!(!members.trim().is_empty(), "scope has no member PID");
    let member_pid = members.lines().next().expect("member pid");
    let proc_cgroup = tokio::fs::read_to_string(format!("/proc/{member_pid}/cgroup")).await.expect("member /proc cgroup");
    let member_group = proc_cgroup.lines().find_map(|line| line.strip_prefix("0::")).expect("cgroup v2 member line");
    assert!(is_at_or_below(member_group, &scope_group).expect("member hierarchy"));

    control.freeze_group(&group).await.expect("freeze leaf");
    assert_counter_frozen(&counter).await;
    control.thaw_group(&group).await.expect("thaw leaf");
    assert_counter_resumed(&counter).await;

    terminate_child(&mut child).await;
    control.release_process(&launch.scope).await.expect("release scope");
    control.dispose().await.expect("dispose owned units");
}
```

- [ ] **Step 8: Add the exact nonfunctional Runtime mock and four modal states (2–5 min).**

Insert under the existing Runtime `settings-list` in `docs/index.html`:

```html
<div class="settings-row">
  <div class="settings-label">
    <div class="settings-label-title">Coding agent resource limits</div>
    <div class="settings-label-desc">Limit future coding-agent processes on Linux cgroup v2 with a systemd user session.</div>
  </div>
  <div class="settings-control settings-switch-wrap"><button class="settings-switch on" type="button" role="switch" aria-checked="true" aria-label="Coding agent resource limits"></button></div>
</div>
<div class="settings-note">
  <strong>All agents</strong>: CPU, memory high, memory max, swap max, tasks max<br>
  <strong>Each agent</strong>: CPU, memory high, memory max, swap max, tasks max<br>
  <strong>Shared OpenCode</strong>: CPU, memory high, memory max, swap max, tasks max
</div>
<div class="settings-note" aria-label="Resource containment launch failure mock">
  <strong>Freshell couldn't limit this agent</strong><br>
  Freshell limits coding agents so they can't overwhelm this machine. Those limits could not be applied, so the agent has not started. Launch it without limits, turn containment off, or close the pane.<br>
  <button type="button">Launch uncontained</button><button type="button">Disable containment</button><button type="button">Close pane</button>
</div>
<div class="settings-note" aria-label="Resource containment warning mock">
  <strong>Claude pane will pause in 00:60</strong><br>
  This agent is using too much memory. Freshell limits coding agents so they can't overwhelm this machine. It will pause if memory stays high. Linux may stop it first if memory rises too far.<br>
  <button type="button">Pause now</button><button type="button">Cancel countdown</button>
</div>
<div class="settings-note" aria-label="Resource containment paused mock">
  <strong>Claude pane is paused because it's using too much memory</strong><br>
  This agent is not doing any work, but it still holds its memory.<br>
  <button type="button">Resume</button><button type="button">Stop agent</button>
</div>
<div class="settings-note" aria-label="Resource containment kernel-stopped mock">
  <strong>Linux stopped Claude pane</strong><br>
  This agent reached its emergency memory limit before Freshell could pause it. Linux stopped it to protect the rest of the machine. Restart it when you're ready, or close the pane.<br>
  <button type="button">Restart agent</button><button type="button">Close pane</button>
</div>
```

This is static mock content only; add no listener or state.

- [ ] **Step 9: Add the exact public README and agent guide sections (2–5 min).**

Insert after `README.md`'s Coding CLI Providers section:

```markdown
### Coding Agent Resource Containment

On Linux, Freshell can place coding agents it launches into cgroup v2 resource limits managed by your systemd user session. Open **Settings → Advanced → Runtime → Coding agent resource limits** to enable it and edit separate limits for all agents, each ordinary agent, and the shared OpenCode service.

Containment applies only to future Freshell-managed coding-agent launches. Ordinary shells, Windows interoperability executables, externally managed remote sessions, and work that was already running are unchanged. Freshell requires Linux cgroup v2 and a reachable systemd user session; it does not fall back to ulimit, containers, virtual-machine settings, or `.wslconfig` changes.

If sustained memory pressure remains high, Freshell warns before pausing the affected agent. A paused agent keeps its memory and remains paused until you choose **Resume** or **Stop agent**. Linux may stop an agent first at its emergency memory limit; Freshell then suppresses automatic restart until you explicitly restart it or close the pane.
```

Insert in `AGENTS.md` before Accessibility:

```markdown
## Resource Containment

- Persisted settings live at `safety.codingAgentResourceLimits` and contain explicit `allAgents`, `eachAgent`, and `sharedOpenCode` five-field limit sets.
- Only registered coding-agent PTYs, Fresh Claude/Kilroy/Codex roots, managed Codex sidecar/PTY pairs, and the shared Fresh OpenCode service are wrapped. Ordinary shells, `.exe` interop, external managers, and pre-existing processes are excluded.
- Phase, deadline, pending choices, group actions, and respawn suppression are server-authoritative. The client never invents or advances a resource phase.
- Node and Rust must remain numerically and wire-shape equivalent.
- Verification resolves validated `ControlGroup` paths and reads raw cgroup v2 files plus `/proc/<pid>/cgroup`/`cgroup.procs`; never verify resource values from `systemctl show` properties.
- Never restart the live port-3001 server for resource-control verification. The ignored live test owns unique units and must leave no unit or child behind.
```

Do not edit any other end-user Markdown file and do not edit `docs/superpowers/plans/**`.

- [ ] **Step 10: Add exact browser reload/lock assertions (2–5 min).**

Append to `resource-containment-ui.spec.ts`:

```ts
test('reload preserves the exact warning deadline and paused state', async ({ freshellPage, harness }) => {
  const deadlineAt = Date.now() + 60_000
  await harness.receiveWsMessage({
    type: 'resource.containment.updated', pending: [],
    snapshot: { runningCount: 1, groups: [{
      id: 'leaf-a', kind: 'ordinary', label: 'Claude pane', phase: 'warning',
      deadlineAt, members: [{ paneId: 'pane-1', label: 'Claude pane' }],
    }] },
  })
  await expect(freshellPage.getByRole('heading', { name: /Claude pane will pause in 00:/ })).toBeVisible()
  await freshellPage.reload()
  await harness.waitForConnection()
  expect((await harness.getReduxState()).resourceContainment.snapshot.groups[0].deadlineAt).toBe(deadlineAt)
  await harness.receiveWsMessage({
    type: 'resource.containment.updated', pending: [],
    snapshot: { runningCount: 1, groups: [{
      id: 'leaf-a', kind: 'ordinary', label: 'Claude pane', phase: 'paused',
      members: [{ paneId: 'pane-1', label: 'Claude pane' }],
    }] },
  })
  const dialog = freshellPage.getByRole('dialog')
  await expect(dialog.getByRole('button')).toHaveText(['Resume', 'Stop agent'])
  await freshellPage.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
})
```

Append to `settings-live-reload.spec.ts`:

```ts
test('running containment keeps all fifteen limits locked across reload', async ({ freshellPage, harness }) => {
  await harness.receiveWsMessage({
    type: 'resource.containment.updated', pending: [],
    snapshot: { runningCount: 1, groups: [] },
  })
  await freshellPage.getByRole('button', { name: 'Settings' }).click()
  await freshellPage.getByRole('tab', { name: 'Advanced' }).click()
  await expect(freshellPage.getByRole('spinbutton')).toHaveCount(15)
  for (const field of await freshellPage.getByRole('spinbutton').all()) await expect(field).toBeDisabled()
  await expect(freshellPage.getByRole('button', { name: 'Save limits' })).toBeDisabled()
  await expect(freshellPage.getByRole('switch', { name: 'Coding agent resource limits' })).toBeEnabled()
  await freshellPage.reload()
  await harness.waitForConnection()
  for (const field of await freshellPage.getByRole('spinbutton').all()) await expect(field).toBeDisabled()
})
```

For real reload, use the stateful WS fixture/server handshake already created in Task 14; direct inbound injection alone is not accepted as replay proof.

- [ ] **Step 11: Run docs/integration/browser tests and observe GREEN (2–5 min to start; wait for completion).**

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/integration/server/resource-containment.test.ts \
  --config config/vitest/vitest.server.config.ts --run
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment exec playwright test -- \
  --config test/e2e-browser/playwright.config.ts \
  --project=legacy-chromium \
  --project=rust-chromium \
  test/e2e-browser/specs/resource-containment-ui.spec.ts \
  test/e2e-browser/specs/settings-live-reload.spec.ts
```

Expected: integration file PASS including the formerly red docs assertion; both browser specs PASS in both backend projects.

- [ ] **Step 12: Run the two corrected focused Vitest commands (2–5 min to start; wait for completion).**

Shared tests use the default/client config:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/shared/resource-limits.test.ts \
  test/unit/shared/settings.test.ts \
  --config config/vitest/vitest.config.ts --run
```

Server settings/integration tests use the server config directly; do not use the misleading `test:integration` script:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/resource-control-settings.test.ts \
  test/integration/server/settings-api.test.ts \
  --config config/vitest/vitest.server.config.ts --run
```

Expected: both commands PASS and enumerate both requested files.

- [ ] **Step 13: Run the remaining focused matrix (2–5 min to start; wait for completion).**

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/resource-control-capability.test.ts \
  test/unit/server/resource-control-systemd.test.ts \
  test/unit/server/resource-control-controller.test.ts \
  test/unit/server/terminal-registry.resource-control.test.ts \
  test/unit/server/fresh-agent/resource-control.test.ts \
  test/unit/server/resource-control-router.test.ts \
  test/unit/server/resource-control-pressure.test.ts \
  --config config/vitest/vitest.server.config.ts --run
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/client/components/RuntimeSettings.resource-limits.test.tsx \
  test/unit/client/components/ResourceContainmentModal.test.tsx \
  --config config/vitest/vitest.config.ts --run
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-resource-control pressure
```

Expected: all focused Node/client/Rust tests PASS.

- [ ] **Step 14: Run CI-equivalent non-live gates (2–5 min to start; wait for completion).**

```bash
cargo +1.96.0 fmt --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml --all --check
cargo +1.96.0 clippy --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml --workspace --all-targets -- -D warnings
cargo +1.96.0 clippy --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml -p freshell-codex --features real-transport --all-targets -- -D warnings
cargo +1.96.0 clippy --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml -p freshell-opencode --features real-transport --all-targets -- -D warnings
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml --workspace
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run lint
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run typecheck
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run contract:generate
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:port
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:status
FRESHELL_TEST_SUMMARY="resource containment integration and docs" \
  npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run check
```

Expected: every command exits 0. If `test:status` reports another holder, wait and rerun status before `check`; never terminate the holder.

- [ ] **Step 15: Run the forbidden-complexity audit (2–5 min).**

```bash
! grep -RInE 'memory\.events([^.]|$)' \
  /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control \
  /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src
! grep -RInE 'memory\.pressure|\bPSI\b' \
  /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control \
  /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src
! grep -RInE 'pkill|kill -9|child_process\.exec\(' \
  /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control \
  /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src
```

Expected: all three negated greps exit 0 with no production matches. `memory.events.local` does not match the first expression.

- [ ] **Step 16: Run the manual host-gated live proof without touching port 3001 (2–5 min to start; wait for completion).**

```bash
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-resource-control --test live_systemd -- --ignored --nocapture
```

Expected on a capable host: PASS with aggregate/leaf/scope assertions and no surviving `freshellagentslive*.slice` or `freshellagentproc*.scope`. An unavailable user systemd/cgroup-v2 prerequisite is a disclosed evidence gap, not a pass and not a reason to restart the live Freshell server.

- [ ] **Step 17: Verify only allowed documentation changed and commit Task 15 (2–5 min).**

```bash
if git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment diff --name-only | \
  grep -E '^docs/superpowers/plans/|\.md$' | \
  grep -vE '^(README\.md|AGENTS\.md)$'; then
  echo 'unexpected Markdown or plan-file change' >&2
  exit 1
fi
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add \
  test/integration/server/resource-containment.test.ts \
  crates/freshell-resource-control/tests/live_systemd.rs \
  test/e2e-browser/specs/resource-containment-ui.spec.ts \
  test/e2e-browser/specs/settings-live-reload.spec.ts \
  docs/index.html README.md AGENTS.md
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment diff --cached --check
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit \
  -m "test(resource-control): add integration, live-systemd proof, and docs" \
  -m "Generated with Amplifier: https://github.com/microsoft/amplifier" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

Expected: focused test/docs commit; no production source and no `docs/superpowers/plans/**` changes.

---

## Traceability

| Story / invariant | Implementing task(s) | Highest-level observable proof |
|---|---:|---|
| US-01 Supported user can first-enable containment | 1–5 | Both-backend `settings-live-reload.spec.ts`; complete stored object in settings API/store tests. |
| US-02 User can view/edit three explicit five-field groups | 1, 5 | RuntimeSettings component and browser tests count fifteen spinbuttons and one complete save. |
| US-03 Disable/re-enable never recalculates | 1–3, 5 | Node/Rust counting calculator tests; Task 15 direct-production and reload tests compare exact values. |
| US-04 Numeric controls/edits lock while any group is active | 2, 3, 5–7 | Zero-scope server guard test plus actual-disabled browser test; toggle remains enabled. |
| US-05 Unsupported host has one precise unavailable state | 4, 5 | Node/Rust capability fixtures, platform API, and both-backend browser exact-copy assertion. |
| US-06 Ordinary/pre-existing/interop work remains unchanged | 8 | Registered/future/shell/`.exe`/pre-enable routing matrix in Node, Rust WS, and Rust REST tests. |
| US-07 Every future managed coding-agent process is contained | 8–11 | Five Node PTY ingress paths, Node recovery, Rust WS/REST/auto-respawn, Codex pair, fresh roots, and shared OpenCode tests. |
| US-08 Containment failure never silently launches raw | 6–12 | Transaction failure matrix proves kill/release/abandon and no created event before pending registration. |
| US-09 User gets exactly three one-shot launch choices | 12 | Authenticated pending router matrix and exact non-dismissible FIFO modal/browser tests. |
| US-10 Sustained pressure warns then pauses | 13, 14 | Identical fixed-deadline reducers and both-backend warning/pause browser flow. |
| US-11 Paused agent remains paused until explicit action | 13, 14 | 120-tick no-stop test; exact Resume/Stop non-dismissible dialog; kernel-confirmed thaw/stop. |
| US-12 Kernel OOM is attributed and respawn suppressed | 13, 14 | Fresh leaf/aggregate classifier tests and browser Linux-stopped/restart flow. |
| US-13 Reconnect preserves pending/phase/deadline | 12, 14, 15 | Real Node/Rust handshake replay and browser reload with byte-identical epoch deadline. |
| US-14 Aggregate selects deterministic largest leaves, max two | 13, 14 | TypeScript/Rust ranking/latch fixtures and browser two-leaf/no-aggregate-row scenario. |
| US-15 Operator can prove real kernel hierarchy/limits/freeze | 4, 6, 7, 15 | Ignored `live_systemd` test using production controller/path helpers and panic-safe cleanup. |
| Exactly one boot ID/controller/coordinator per process | 4, 6–8, 12 | Boot wiring tests and distinct-controller unit-name tests. |
| Aggregate OOM group 0; leaf OOM group 1; scope no limits | 6, 7, 15 | Raw fake-controller checks plus live cgroup files. |
| Aggregate+leaf reservation is atomic and single-flight | 6, 7 | Concurrent same/different-limit tests and zero-scope active lock. |
| Verification uses kernel truth before publication | 6–11 | Raw-file/path/membership tests and delayed-verify no-created tests. |
| Every exit releases once through the existing owner | 8–11, 14 | Natural exit, explicit kill, race, shutdown, and service restart tests. |
| Pending/group routes are separate and phase/one-shot guarded | 12, 14 | 400/401/404/409/500 route matrices and forged-input tests. |
| Pressure polling is one 1000-ms O(N) loop | 13 | Fake-timer read-count/no-read/no-broadcast tests in both backends. |
| Quiet clear precedes deadline; cancellation rearms after 10 s | 13, 15 | Exact timestamps `1000/5000/15000/15001/61000/75001` in both languages. |
| Aggregate pause latch resets only after current<high and 10 s quiet | 13 | TypeScript/Rust aggregate episode fixtures. |
| No automatic stop of paused groups | 6, 7, 13, 15 | Explicit-only stop tests and 120-tick integration proof. |
| Restart/resume use fresh group/baseline | 8, 9, 14 | Recovery/restart unit IDs differ; resume snapshot baseline test. |
| Client never invents phase/deadline | 12, 14 | Redux no-op/reference test and reconnect snapshot/browser proof. |
| Node/Rust wire/numeric/action parity | 1–4, 7–15 | Shared numeric fixtures, Rust serde roundtrip, generated contract freeze, both browser projects. |
| No forbidden alternative/PSI/broad-kill mechanism | Global, 13, 15 | Exact unsupported UI, source audit, README copy, and no production grep hits. |
| No live deployment/restart | Global, 15 | All commands use tests/ephemeral units; no port-3001 restart command exists. |

## Candidate Decisions and Remaining Evidence Gates

This candidate resolves every previously identified design ambiguity so implementation does not silently defer scope: contained Codex sidecars are not retained across server shutdown; recovery uses fresh logical generations; the runtime wire shape and pane correlation are fixed; one pending-priority dialog avoids competing focus traps; user/policy stopped copy is specified; numeric bounds are exact; `00:60` is the approved countdown; live Rust settings use a synchronous shared provider; duplicate pending, resume baseline, pane close, failure code, and token-collision behavior are fixed in Global Constraints.

No product requirement remains unassigned. Two evidence gates can remain unresolved only until execution: (1) whether the frozen additive protocol contract accepts version 7 or requires a coordinated bump to 8, decided solely by `test:port`; and (2) whether a capable Linux user-systemd host is available to produce the mandatory non-skipped `live_systemd` proof. Neither gate authorizes reducing scope or treating unavailable/skipped evidence as a pass.
