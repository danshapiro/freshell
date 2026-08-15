# Coding Agent Resource Containment Implementation Plan

> **For agentic workers:** Execute this plan task-by-task through the workflow execute stage: use a fresh implementer for each task, then specification review and quality review. Track steps with checkbox (`- [ ]`) syntax. A task is not GREEN, and its commit is not authorized, when any mandatory active/live cell is skipped, unavailable, absent, or failed.

**Goal:** Add opt-in, cooperative Linux cgroup-v2 resource containment to every Freshell-owned local-Linux coding-agent root admitted through the mandatory launch broker in both production backends, while leaving ordinary shells, external managers, native Windows processes, pre-existing work, and provider-internal remote execution outside the feature.

**Architecture:** One Unix UID plus canonical Freshell settings directory defines a resource domain. A process-lifetime cross-backend lease permits one Node or Rust server to own that domain; a crash-safe journal lets its actor adopt or reconcile the same systemd aggregate and owner generations before reopening admission. Fresh capacity validation feeds immutable policy generations; prepared owner leases create and freeze limited leaves before blocking `systemd-run --scope` attaches a target, and publication occurs only after verification, actor commit, thaw, and owner readiness. Protocol v8 carries bounded revisioned snapshots and generation-bound idempotent actions; a lower-crate Rust lifecycle actor and supervisor mirror the Node control plane.

**Tech Stack:** Node.js >=22.5.0, TypeScript 5.9/NodeNext, Zod 4, Express, node-pty, React 18, Redux Toolkit, Vitest 3, Playwright 1.58, Rust 1.96.0 (edition 2021), serde, Tokio, Axum, portable-pty, Linux `flock(2)`, systemd >=255 user units, and unified cgroup v2.

**Scope decision:** The compatibility floor is a separately releasable prerequisite. Feature implementation then proceeds through an approval-gated Phase 0 and sixteen dependency-ordered implementation/acceptance tasks. No product decision remains open: this plan chooses cooperative same-UID Linux control, one shared aggregate per settings home, enforceable broker coverage for Freshell-owned roots, protocol v8, leaf-local-or-ambiguous OOM attribution, and bounded aggregate-critical escalation. A failed or unavailable mandatory evidence gate stops the affected task or release; it never silently narrows these contracts.

**Current evidence state:** LB02 alone is verified: upstream systemd v236 and v255 register the blocking `systemd-run --scope` process in the scope, wait for manager realization/attachment, and only then execute the target. The supported product floor is nevertheless systemd 255. LB01 and LB03–LB21 remain falsified against the old plan; the tasks below replace their contracts and require new evidence rather than treating the old fake/live tests as proof.

## Global Constraints

1. Every command uses `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment` explicitly. Every Git command starts with `git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment`.
2. The feature is Linux-only, unified cgroup-v2-only, systemd-user-manager-only, and requires systemd >=255. There is no ulimit, Docker, VM, `.wslconfig`, Windows Job Object, privileged-broker, or cgroup-v1 fallback.
3. This is cooperative same-UID resource control, not hostile-code containment. Windows `.exe` roots/descendants and external manager work are excluded by typed provenance, not filename heuristics.
4. The compatibility-floor release must be deployed before any binary is allowed to persist `requiredConfigFeatures: ["resource-containment-v1"]`. Task 2 is the only separately deployable slice; Tasks 3–16 remain unreleased feature work, and no containment-capable release/deployment occurs until Task 17 has all mandatory evidence.
5. The canonical config is format v2, preserves unknown top-level and nested fields, and has a monotonically increasing safe-integer `configRevision`.
6. On Linux, the active Node or Rust server holds an exclusive nonblocking `flock(2)` on `<config-directory>/server.lock` for process lifetime. Node loads Linux-only optional dependency `fs-ext`; Rust uses `fs2`; both are proven to contend on the same kernel lock. A second same-home Linux server exits before serving or writing. On non-Linux, config-v2 migration/durable writes remain available but resource containment cannot be enabled; a persisted `resource-containment-v1` requirement causes fail-closed startup rather than loading `fs-ext` or pretending to hold the resource-domain lease. Tests use distinct temporary homes unless testing refusal.
7. Config and lifecycle-journal writes use same-directory unique temp, complete write, file sync, atomic rename, and parent-directory sync. No in-place fallback exists. Backups use the same primitive.
8. `PERSIST_FAILED` means failure is known to precede primary rename. `PERSIST_STATE_UNKNOWN` means rename may have occurred but durability was not established; reload the parseable file, enter degraded fail-closed state, reject new contained admissions, and require recovery/restart. Success is acknowledged only after file and directory sync.
9. No measured power-cut claim is made. Process-kill tests prove parseable old-or-new and recovery; a real power-cut claim would require a separately approved disposable block-device/VM test.
10. Stored limits remain `enabled` plus exactly fifteen canonical integers under `allAgents`, `eachAgent`, and `sharedOpenCode`. CPU values are positive 100-mCPU multiples; byte values are MiB multiples; tasks are positive integers; swap may be zero; all numbers are JSON-safe. Capability also requires a positive base page size that divides 1 MiB, so MiB inputs have exact raw cgroup readback rather than an implicit page-rounding tolerance.
11. First enable suggests values only from one fresh complete capacity observation. There is no fallback. Persisted values are absolute and never silently recalculated.
12. Fresh capacity/root validation occurs on first enable, re-enable, numeric save, and each contained admission. Unknown or smaller capacity returns `RESOURCE_LIMITS_UNAVAILABLE` or `RESOURCE_LIMITS_STALE`. Disable always remains available and requires no capability probe.
13. Numeric edits are locked while any admission lease, prepared/committed/compensating/retained/orphaned owner lease, pending resolution, or tracked group exists. Disable changes only later admissions; a pre-disable lease completes under its captured policy generation.
14. One stable resource-domain aggregate applies `allAgents`; ordinary and shared-OpenCode leaves apply their respective limits. Separate settings homes are separate domains and are documented as such.
15. On same-boot restart, startup reconciliation completes before launch admission. It adopts compatible committed generations, compensates incomplete generations, or remains degraded. On boot-ID change, missing prior units are resolved as interrupted history before a new aggregate is created.
16. Unit tokens are server-generated lowercase ASCII. Persist unit identity before unit/process creation. No unit/cgroup name is accepted from clients or sent on the wire.
17. The production control plane is CLI plus direct cgroupfs: argv-safe `systemctl --user`, blocking `systemd-run --user --scope --collect`, and direct bounded reads/writes. Do not use shell command strings, `exec`, `--no-block`, or an unproven D-Bus alternative.
18. Setup/readback/freeze precedes spawn. Spawn attaches into a frozen leaf. Verify all members/scopes, commit in the actor/journal, thaw, run owner readiness, then publish inventory/activity/output/created/ready.
19. Every Freshell-owned direct coding-agent process root uses typed `ExecutionDomain` and the mandatory broker. Enabled `localLinuxManaged` can only return contained admission or denial; missing control dependencies can never fall through to raw spawn.
20. Every owner preserves its own argv/cwd/environment/PTY or stdio/resize/cancellation/process-group/readiness/native-exit contract. The common wrapper is argv-only.
21. Root exit is not release. Population zero, final evidence capture, bounded stop/revert, and confirmed cleanup precede ownership removal. Partial compensation is persisted and retryable.
22. Protocol version is 8. Mixed v7/v8 closes 4010 before any containment operation. Snapshot transport is bounded, revisioned, replayed every five seconds, and closes an unsent/backpressured client with 4008.
23. All policy deadlines use monotonic time that excludes suspend. Wall clock is logging/retention only. The client animates remaining duration but never changes authoritative phase.
24. Stable OOM attribution uses only a stable rise in the same leaf’s `memory.events.local` `oom_kill` or `oom_group_kill` while its evidence is pinned. Aggregate counters and guessed signals never identify a leaf. Unstable/missing evidence is `ambiguous`.
25. Paused groups remain polled; owner health/lazy-start/recovery timers consume a pause generation and cannot kill/replace while paused. The escalation grace may start only after every effective unpaused freeze has been attempted or aggregate usage fails to decline after a freeze. If aggregate-critical pressure then remains persistent for ten monotonic seconds, stop one paused victim, wait for population zero and final evidence, and reassess before starting any new grace epoch.
26. Hard caps and budgets are normative: 64 runtime groups, 64 pending rows, 256 total members, 64 members/group, 256 UTF-8 label bytes, 128 identifier bytes, 16 KiB per persisted owner recipe, 2 MiB lifecycle journal, 256 KiB wire snapshot, 256 retained idempotency results, and 50 authenticated WebSocket connections.
27. The monitor is single-flight at a 1,000-ms cadence, reads at most aggregate + 64 groups, has a 500-ms snapshot/reduce/serialize p99 target and 750-ms complete-cycle p99 target, skips/coalesces overruns, and never bursts missed ticks.
28. Destructive process/config tests run in the repository sandbox. State-changing systemd/PTY/provider/OOM tests require explicit approval, unique owned units, a disposable helper/workload, and cleanup proof. They never touch/restart port 3001.
29. Every mandatory live cell is non-skipped before its controlled commit/release conclusion. Browser/fake/mirrored fixtures never substitute for a production controller or owner. Separate RC-LIVE-12/13 proof-index entries resolve only to fresh current-approval/run artifacts whose hashed bodies bind the canonical execution window, exact command, VM digests, capability, proof timestamps, host/guest identity, result, and measurements; `actualGuestPmSuspend` must be true and accepted hashes/run/execution IDs cannot be reused. Manifest rows remain the exact eleven-field contract.
30. Broad tests follow the repository coordinator gate: run `npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:status`, wait for any foreign holder, and never kill it.
31. No PR, deployment, service installation, or live-server restart is part of a task unless a later explicit user approval separately authorizes it.

> Freshell applies cooperative Linux cgroup limits to local processes launched through this server’s broker. This is not a security boundary: code running as the same Unix user may reconfigure or leave the hierarchy. Native Windows processes and their descendants are not covered. One combined cap is shared only by the active Node or Rust server and surviving generations that use the same Unix UID and canonical Freshell settings directory; a different settings directory is a different resource domain and has a separate cap.

## Conflict Resolutions and Product Contract

| Conflict | Final decision | Why this is the coherent choice |
|---|---|---|
| Delete `allAgents` versus retain aggregate policy | Retain the fifteen integers and implement **one shared per-settings-home resource domain**. | Aggregate pressure and iterative victims require the durability, singleton, journal, and actor machinery required by LB09/LB10/LB14. |
| Per-process aggregate versus cross-instance aggregate | One aggregate is shared by one Unix UID plus canonical Freshell settings directory. One Node or Rust server may hold that domain at a time. Restarts on the same boot adopt/reconcile before admission. Separate settings homes have separate caps. | This prevents same-home crash/backend multiplication without claiming a machine-wide cap. |
| Enumerated owners versus every future owner | Require typed execution-domain metadata, mandatory broker, shrinking raw-spawn allowlists, TypeScript AST and Rust `syn`/compile gates, and complete current inventory. | The enforceable promise is Freshell-owned direct local-Linux coding-agent roots; provider-internal remote work and hostile same-UID escape remain outside scope. |
| Ten integers versus fifteen | Keep `enabled` plus exactly fifteen integers under `allAgents`, `eachAgent`, and `sharedOpenCode`. | Runtime/config revisions are separate metadata. |
| Defer OOM versus implement OOM UI | Implement stable leaf-local attribution with explicit `ambiguous`; never infer a leaf from aggregate counters or signals. | Useful OOM behavior remains without false attribution. |
| Paused forever versus pressure escalation | Continue supervising paused groups. Attempt every effective unpaused freeze and reassess usage first; only when all effective freezes have been attempted or usage fails to decline may persistent aggregate-critical pressure start a server-authored ten-second monotonic grace. At expiry stop one paused victim, wait for population zero/final evidence, and reassess before a fresh epoch. | Frozen memory remains charged, but the grace must not bypass effective non-destructive freezes. |
| systemd v236 ordering versus feature floor | Support systemd 255 or newer while preserving the verified narrower attach-before-exec result. | v255 is the validated complete surface. |
| Source-order barrier versus frozen preparation | Configure/read back and freeze an empty leaf; blocking scope launch attaches before exec; verify frozen membership; commit; thaw; readiness; publish. | This preserves LB02 and blocks pre-commit side effects. |
| Memoized capacity versus fresh capacity | Probe fresh on enable, numeric save, and every contained admission; display is never launch authorization. | This closes stale authorization. |
| Local mutexes versus shared control order | One process-lifetime per-home advisory lease plus one control-plane actor per active backend. | This closes cross-process and in-process races. |
| Protocol conditionality versus v8 | Set both constants to 8 in one atomic contract commit; mismatches close 4010 first. | Old clients cannot resolve/supervise new states. |
| Amendment versus rewrite | Whole-document replacement. | Every old task was semantically affected. |

## Canonical Cross-Task Contracts

Rust defines one serde-equivalent shape per cross-boundary contract, using snake_case internally and exact camelCase config/wire names. TypeScript and Rust fixtures use independent expected literals.

### Limits, capacity, and config

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
  cpuQuotaMillis: number
  memoryBytes: number
  swapBytes: number
  tasksMax: number
}
export type CapabilityFingerprint = {
  bootId: string
  managerInvocationId: string
  cgroupMountId: string
  managerControlGroup: string
  delegatedControllers: readonly ['cpu', 'memory', 'pids']
  systemdVersion: number
}
export type ResourceControlCapability =
  | { available: true; observedAt: string; fingerprint: CapabilityFingerprint; effective: EffectiveResourceCapacity }
  | { available: false; code: 'NOT_LINUX' | 'SYSTEMD_TOO_OLD' | 'USER_MANAGER_UNAVAILABLE' | 'CGROUP_V2_UNAVAILABLE' | 'DELEGATION_MISSING' | 'REQUIRED_FILE_UNREADABLE' | 'CAPACITY_INCOMPLETE'; detail: string }
export type ConfigEnvelopeV2 = {
  configVersion: 2
  configRevision: number
  requiredConfigFeatures: string[]
  safety?: { codingAgentResourceLimits?: CodingAgentResourceLimits; [key: string]: unknown }
  [key: string]: unknown
}
```

Capacity is complete only when all four dimensions and the fingerprint are available. CPU capacity is the minimum of fresh process affinity from the running server process and the tightest finite manager-root ancestor `cpu.max`; memory, swap, and tasks use fresh `/proc/meminfo` `MemTotal`, `/proc/meminfo` `SwapTotal`, and `/proc/sys/kernel/pid_max`, each bounded by the tightest finite target ancestor. Explicit zero swap is known. A positive base page size that divides 1 MiB is mandatory. Missing data is unavailable, never “unlimited” and never replaced by a constant.

```text
allAgents.cpu = floor100(C / 2)
allAgents.memoryMax = floorMiB(2M / 3)
allAgents.memoryHigh = floorMiB(4 * memoryMax / 5)
allAgents.swap = floorMiB(min(S / 4, memoryMax / 4))
allAgents.tasks = floor(3P / 4)
eachAgent hard values = 50% of aggregate
sharedOpenCode hard values = 90% of aggregate
each leaf memoryHigh = 80% of its own memoryMax
```

Quantize before validation; reject any nonpositive required result or `memoryHighBytes >= memoryMaxBytes`.

### Resource domain, generations, and admission

```ts
export type ResourceDomainId = string
export type ServerEpoch = string
export type SettingsRevision = number
export type PolicyGeneration = number
export type LaunchId = string
export type LaunchGeneration = number
export type OwnerLeaseId = string
export type PaneContentId = string
export type PaneRevision = number
export type TargetRevision = number
export type MemberRevision = number
export type OperationId = string
export type PolicySnapshot = {
  serverEpoch: ServerEpoch
  settingsRevision: SettingsRevision
  policyGeneration: PolicyGeneration
  capabilityFingerprint: CapabilityFingerprint
  limits: Readonly<CodingAgentResourceLimits>
}
export type ExecutionDomain = 'localLinuxManaged' | 'windowsInterop' | 'externalManager' | 'ordinaryShell' | 'controlPlaneProbe'
export type OwnerKind = 'pty' | 'perSessionRoot' | 'pairedGeneration' | 'sharedService'
export type LaunchTarget = { paneId: string; paneContentId: PaneContentId; paneRevision: PaneRevision }
export type LaunchAdmission =
  | { mode: 'uncontained'; reason: 'disabled' | 'excluded'; domain: ExecutionDomain }
  | { mode: 'contained'; admissionLeaseId: string; policy: PolicySnapshot; launchId: LaunchId; generation: LaunchGeneration }
  | { mode: 'denied'; code: 'RESOURCE_CONTAINMENT_UNAVAILABLE' | 'RESOURCE_LIMITS_STALE' | 'RESOURCE_CONTAINMENT_CAPACITY' | 'RESOURCE_CONTAINMENT_DEGRADED' }
export type UncontainedPermit = {
  permitId: string
  operationId: OperationId
  launchId: LaunchId
  generation: LaunchGeneration
  targetRevision: TargetRevision
  settingsRevision: SettingsRevision
  consumed: boolean
}
```

`ResourceDomainId` is a stable SHA-256-derived token over the Unix UID and canonical config directory. It is never a bearer capability. `ServerEpoch` changes on every process start. Counters are JSON-safe positive integers and fail closed before overflow. `SettingsRevision` is the durably committed `ConfigEnvelopeV2.configRevision`; `PolicyGeneration` is a process-epoch-local sequence incremented when that settings revision is installed. The pair `{serverEpoch, policyGeneration}` identifies one immutable admission policy across restart boundaries. Enabled `localLinuxManaged` returns only contained or denied. Uncontained retry requires an actor-minted, persisted, single-use permit bound to the failed launch’s next generation and target revision.

### Argv wrapper and owner recipes

```ts
export type WrappedArgv = { scope: string; file: string; args: string[] }
export type TerminalOwnerRecipeV1 = { version:1; kind:'terminal'; target:LaunchTarget; mode:string; file:string; args:string[]; cwd:string; safeEnvironment:Record<string,string>; credentialRefs:string[]; resumeSessionId?:string; terminalOptions:Record<string,unknown> }
export type FreshOwnerRecipeV1 = { version:1; kind:'fresh'; target:LaunchTarget; provider:'claude'|'codex'; sessionType:'freshclaude'|'freshcodex'|'kilroy'; file:string; args:string[]; cwd:string; safeEnvironment:Record<string,string>; credentialRefs:string[]; resumeSessionId?:string; model?:string; permissionMode?:string; sandbox?:string; effort?:string; plugins:string[] }
export type ManagedCodexOwnerRecipeV1 = { version:1; kind:'managedCodex'; target:LaunchTarget; threadId:string; sidecar:{file:string;args:string[];cwd:string;credentialRefs:string[]}; pty:TerminalOwnerRecipeV1; retention:'quiescent'|'activeTurn' }
export type OpenCodeOwnerRecipeV1 = { version:1; kind:'openCodeService'; serviceKey:string; file:string; args:string[]; cwd:string; credentialRefs:string[]; attachments:Array<{memberId:string;paneId:string;paneContentId:PaneContentId;paneRevision:PaneRevision;sessionId:string}> }
export type OwnerRecipeV1 = TerminalOwnerRecipeV1 | FreshOwnerRecipeV1 | ManagedCodexOwnerRecipeV1 | OpenCodeOwnerRecipeV1
```

`WrappedArgv` promises only argv preservation and scope identity. Each owner retains cwd, environment, stdio/PTY, resize, cancellation, process group, readiness, and native exit. Recipes contain no bearer token or raw secret. Unresolvable credential references produce `recipe_stale` and deny restart.

### Owner leases, lifecycle, controller, and deadlines

```ts
export type OwnerLifecycleState = 'claimed'|'prepared'|'spawnedBlocked'|'verified'|'committed'|'starting'|'running'|'paused'|'classifying'|'compensating'|'clean'|'retainedAdoptable'|'releasing'|'released'|'orphaned'|'containmentFailed'
export type CompensationStep = 'revokeStartGate'|'cancelOwner'|'waitOwner'|'stopScopes'|'waitPopulationZero'|'captureFinalEvidence'|'revertUnits'|'removeProvisionalState'
export type StepOutcome = {state:'pending'} | {state:'complete';at:string} | {state:'retryable';code:string;detail:string}
export type PreparedOwnerLease = {
  leaseId: OwnerLeaseId
  launchId: LaunchId
  generation: LaunchGeneration
  policyGeneration: PolicyGeneration
  recipe: OwnerRecipeV1
  aggregateUnitToken: string
  leafUnitToken: string
  scopeTokens: string[]
  lifecycle: OwnerLifecycleState
  compensation: Record<CompensationStep,StepOutcome>
}
export type LifecycleJournalV1 = {
  version: 1
  resourceDomainId: ResourceDomainId
  bootId: string
  configRevision: SettingsRevision
  aggregate: {unitToken:string;policyGeneration:PolicyGeneration}|null
  leases: PreparedOwnerLease[]
  completedOperations: Array<{operationId:OperationId;targetRevision:TargetRevision;outcome:'succeeded'|'failed'|'stale';completedAt:string}>
}
export type NativeExit = {kind:'exited';code:number}|{kind:'signaled';signal:string}|{kind:'unknown';reportedCode?:number}
export type StableObservation = { kind:'stable'; observationId:string; launchId:LaunchId; generation:LaunchGeneration; acquiredStartTick:bigint; acquiredEndTick:bigint; memoryCurrent:number; memorySwapCurrent:number; memoryHigh:number; memoryMax:number; populated:boolean; frozen:boolean; localEvents:{high:number;max:number;oom:number;oomKill:number;oomGroupKill:number} }
export type PressureObservation = StableObservation | {kind:'ambiguous';observationId:string;launchId:LaunchId;generation:LaunchGeneration;reason:'events_changed'|'read_timeout'|'evidence_missing'}
export interface ResourceControl {
  ensureDomainAggregate(policy: PolicySnapshot): Promise<void>
  prepareOwnerLease(admission: Extract<LaunchAdmission,{mode:'contained'}>, recipe: OwnerRecipeV1): Promise<PreparedOwnerLease>
  wrapProcess(lease: PreparedOwnerLease, role: string, argv: readonly string[]): WrappedArgv
  verifyBlockedMembers(lease: PreparedOwnerLease, members: readonly {scope:string;pid:number}[]): Promise<void>
  thawCommittedLease(leaseId: OwnerLeaseId, generation: LaunchGeneration): Promise<void>
  observe(leaseId: OwnerLeaseId): Promise<PressureObservation>
  beginCompensation(leaseId: OwnerLeaseId, generation: LaunchGeneration): Promise<void>
  retryCompensation(leaseId: OwnerLeaseId): Promise<'complete'|'retryable'|'orphaned'>
  stopGeneration(leaseId: OwnerLeaseId, generation: LaunchGeneration): Promise<'stopped'|'retryable'|'orphaned'>
  reconcileOwnedUnits(): Promise<'clean'|'degraded'>
  closeAdmissionAndDrain(): Promise<void>
  disposeNonRetainedUnits(): Promise<void>
}
```

```text
Claimed -> Prepared(frozen, journaled) -> SpawnedBlocked -> Verified
        -> actor Committed -> thawed -> Starting -> Running -> published
Any pre-publication failure -> Compensating -> Clean -> ContainmentFailed
Running -> Classifying -> Releasing -> Released
Running -> RetainedAdoptable (managed Codex shutdown transfer only)
Any nonterminal state -> Reconcile on startup
```

Pending choices become actionable only after compensation is complete. Incomplete cleanup is `cleanup_pending`. The durable journal is capped at 2 MiB, 64 leases, and 256 terminal operation results; invalid/unknown records degrade admission rather than being discarded. Literal deadlines: command 2 s; cgroup read/write 250 ms; prepare/readback/freeze 5 s; membership audit 500 ms; thaw/freeze 2 s; owner stop 5 s; population zero 5 s; revert 5 s; compensation pass 15 s; observation/reduce/serialize 500 ms; complete monitor cycle 750 ms. Timeout preserves retryable identity.

### systemd topology and launch ordering

```text
freshellagents<domainToken>.slice
  freshellagents<domainToken>-agent<groupToken>.slice
    freshellagentproc<scopeToken>.scope
  freshellagents<domainToken>-opencode<groupToken>.slice
    freshellagentproc<scopeToken>.scope
```

The aggregate applies all five `allAgents` properties plus `memory.oom.group=0`; ordinary/OpenCode leaves apply their respective five properties plus `memory.oom.group=1`; scopes have no direct limits. Property argv is exactly `CPUQuota=<cpuQuotaMillis/10>%`, `MemoryHigh=<memoryHighBytes>`, `MemoryMax=<memoryMaxBytes>`, `MemorySwapMax=<swapMaxBytes>`, `TasksMax=<tasksMax>`. Raw normalized readback must equal policy exactly.

```text
systemd-run --user --scope --collect --quiet --unit=<scope> --slice=<leaf> -- <file> <arg0> ...
```

> The pre-exec guarantee relies on the verified blocking systemd ordering: `systemd-run --scope` is attached by the user manager before it executes the requested target. `--no-block` is forbidden. Freshell first creates, limits, reads back, and freezes an empty leaf; after `systemd-run` attaches into that frozen leaf, membership verification is defense-in-depth while target execution remains blocked. Only a durable actor commit permits thaw, readiness, and publication. If the active package-level sentinel contradicts this ordering, execution stops before controller APIs are accepted.

Exact order: actor identity/admission; persist tokens/recipe; set aggregate/leaf; exact readback; OOM-group reread and freeze empty leaf; stage real owner through `WrappedArgv`; blocking attach; verify every member frozen; durable actor commit; thaw confirmation; owner readiness; publish inventory/activity/output/created/ready.

### Protocol v8, snapshots, and actions

```ts
export type ActionEnvelopeBase = {operationId:OperationId;expectedRevision:TargetRevision;actionNonce:string;expectedMemberRevision?:MemberRevision}
export type ActionEnvelope =
  | (ActionEnvelopeBase & {kind:'pending';expectedSettingsRevision:SettingsRevision;choice:'launch_uncontained'|'disable_containment'|'close_pane'})
  | (ActionEnvelopeBase & {kind:'group';action:'pause_now'|'cancel_countdown'|'resume'|'stop_agent'|'restart_agent'|'close_pane'})
export type PendingSnapshot = {pendingId:string;launchId:LaunchId;generation:LaunchGeneration;paneId:string;paneContentId:PaneContentId;paneRevision:PaneRevision;targetRevision:TargetRevision;actionNonce:string;status:'cleanup_pending'|'awaiting_choice'|'resolving'}
export type GroupSnapshot = {launchId:LaunchId;generation:LaunchGeneration;targetRevision:TargetRevision;memberRevision:MemberRevision;actionNonce:string;kind:'ordinary'|'sharedOpenCode';label:string;phase:'idle'|'warning'|'paused'|'escalating'|'stopping'|'stopped'|'cleanup_pending'|'retained';deadlineRemainingMs?:number;escalationRemainingMs?:number;stopReason?:'user'|'policy'|'oom'|'natural_exit'|'interrupted'|'unknown';members:Array<{memberId:string;paneId:string;label:string}>}
export type ResourceContainmentUpdated = {type:'resource.containment.updated';streamId:string;revision:number;settingsRevision:SettingsRevision;pending:PendingSnapshot[];snapshot:{runningCount:number;settingsLocked:boolean;groups:GroupSnapshot[]}}
export type ResourceContainmentFailure = {code:'RESOURCE_CONTAINMENT_FAILED';launchId:LaunchId;generation:LaunchGeneration;targetRevision:TargetRevision;retryable:false}
```

A process UUID `streamId` has increasing revisions. A connection accepts the first frame and only greater revisions for that stream; reconnect resets acceptance and receives current state. Full state replays every 5,000 ms or sooner. Serialize once, assert <=256 KiB, fan out, inspect send results, and close unsent/backpressured clients 4008. v7↔v8 closes 4010 before semantics; v8↔v8 succeeds. Remaining durations derive from server monotonic state.

Possession of `AUTH_TOKEN` is explicitly full Freshell administrator authority. Destructive routes require `x-auth-token`, reject cookie-only authentication, reject disallowed `Origin`, reject cross-site Fetch Metadata, require JSON, and allow an omitted Origin only for a native client presenting header credentials. Non-loopback destructive access requires HTTPS/WSS or a configured encrypted tunnel/reverse proxy. The actor atomically claims `operationId` + nonce + target revision + optional member revision before external I/O. The same `operationId` returns the durable recorded result without repeating side effects; a different concurrent operation returns `409 RESOURCE_OPERATION_IN_PROGRESS`; stale nonce/revision/member revision returns 409 before side effects. Retain at most 256 completed idempotency records and evict only the oldest terminal records. Audit source/origin, operation, target generation/revisions, expected members, old/new state, outcome, and replay/stale disposition without secrets. `actionNonce` is at least 128 bits from the platform CSPRNG, base64url encoded, bound to the action set + launch generation + target/member/settings revisions, and replaced on every target mutation. Pending actions compare `expectedSettingsRevision` before disable, permit, or close side effects.

| HTTP | Code | Meaning |
|---:|---|---|
| 400 | `RESOURCE_ACTION_INVALID` / `RESOURCE_LIMITS_INVALID` | schema/value rejection before side effects |
| 401 | `AUTH_REQUIRED` | missing/wrong header or cookie-only destructive request |
| 403 | `ORIGIN_FORBIDDEN` / `TRUSTED_TRANSPORT_REQUIRED` | source/transport rejection |
| 404 | `RESOURCE_TARGET_NOT_FOUND` | immutable generation absent |
| 409 | `RESOURCE_LIMITS_ACTIVE` | nonterminal state blocks numeric edit |
| 409 | `RESOURCE_LIMITS_UNAVAILABLE` / `RESOURCE_LIMITS_STALE` | fresh capability cannot authorize values |
| 409 | `RESOURCE_CONTAINMENT_CAPACITY` | hard cap exceeded before side effects |
| 409 | `RESOURCE_TARGET_STALE` | revision/nonce/member mismatch |
| 409 | `RESOURCE_OPERATION_IN_PROGRESS` | another operation owns target |
| 500 | `PERSIST_FAILED` | failure known before primary rename |
| 503 | `PERSIST_STATE_UNKNOWN` / `RESOURCE_CONTAINMENT_DEGRADED` | indeterminate durability/incomplete reconciliation |

`RESOURCE_CONTAINMENT_FAILED` is request-correlated internal/transport failure only after durable compensation status; it is not a generic HTTP retry signal.

### Pressure, owner durability, and Rust shutdown

Observation reads leaf-local and aggregate `memory.events.local`, reads current/swap/high/max/population/freezer, then reads both local event files again. If relevant counters change, retry once inside 500 ms; otherwise return `ambiguous` and perform no irreversible transition. Growth is `max(0,currentTotal-previousTotal)`. Leaf high starts a 60-second monotonic warning; ten quiet monotonic seconds below high clears/rearms; expiry freezes after confirmation. Aggregate critical is current >=95% max or stable aggregate-local max rise. Choose one unpaused positive-growth leaf by growth descending, total descending, launch ID; with no grower choose largest unpaused total. Freeze one and reassess on the next complete cycle. Continue until every effective unpaused freeze has been attempted. Poll paused groups throughout. Eligibility is exactly `(all effective freezes have been attempted) OR (a completed post-freeze cycle proves aggregate usage did not decline)`. Once either branch latches during the current aggregate-critical episode, later usage decline does not clear eligibility; only loss of aggregate-critical pressure clears it. Eligible still-persistent aggregate-critical pressure starts a ten-second monotonic escalation epoch. At expiry stop one paused victim ordered by last positive growth, total, then launch ID; await population zero and final evidence; reassess on a complete cycle; every additional stop requires a fresh ten-second epoch. Only pinned stable same-leaf `oom_kill`/`oom_group_kill` rise classifies OOM. Missing/unstable evidence is `unknown`/`ambiguous` and suppresses automatic respawn. Explicit restart creates a fresh admission/generation/leaf.

Managed Codex sidecar+PTY are one generation/leaf/two scopes with joint commit. Quiescent shutdown releases; active graceful shutdown may transfer `retainedAdoptable` with exact PID/starttime/cmdline/cgroup identity. Same-backend restart validates/adopts; after adoption, only an explicit user resume may add a fresh recovery PTY scope to that same generation, and the new scope must pass prepare/frozen attach/verify/commit/thaw/readiness before publication. Incompatible state retires before admission and marks active work interrupted. Stop/policy/OOM also interrupts; durable thread history remains, but no transparent continuation or exactly-once provider work is promised.

OpenCode has one shared leaf/scope per immutable service generation. Running state, watcher/loss events, and attachments carry generation. Replacement commits G2, CAS-rebinds each member once, then retires G1. Late G1 cannot clear G2. Completed history remains reopenable after generation loss or replacement. Active responses become interrupted and never automatically continue; only explicit user restart creates new provider work. Pause suppresses timeout/loss/lazy replacement until resume revalidation.

Rust lower-crate commands are `PatchSettings`, `BeginLaunch`, `PrepareLaunch`, `CommitLaunch`, `AbortLaunch`, `RegisterOwner`, `OwnerExited`, `PaneMutation`, `ClaimAction`, `CompleteAction`, `PressureObservation`, `BeginShutdown`, `Reconcile`, and `Snapshot`, each with stable ID/oneshot ack. External I/O runs outside actor mutation under operation leases. Shutdown order is: reject admission; revoke nonces and join monitor/replay; close provider intake; join exit/classification/recovery; obtain owner stop/release/retention acks; drain compensation/population release; persist and close actor intake; dispose only non-retained units; join actor/all workers; emit `server.stopped`.

### Release evidence manifest

This acceptance-only canonical contract is not a protocol-v8 wire type. Task 15 produces the RC-LIVE-12/13 proof results; Task 17 owns the flat manifest/proof-index schema, validates every gate result, and makes the release decision. The manifest has exactly sixteen rows in ascending gate order: one, and only one, row for each `RC-LIVE-00` through `RC-LIVE-15`. Command execution follows the exact map: RC-LIVE-07 and RC-LIVE-08 share one combined invocation; RC-LIVE-13 requires ordered subcommands 13a and 13b; every other gate uses one invocation. The shared Node invocation emits one row for each of RC-LIVE-07/08 only after both selected tests pass. The RC-LIVE-13 aggregator emits one row only after both exact Rust subcommands pass. No gate emits child rows.

```ts
const RC_LIVE_GATE_IDS = [
  'RC-LIVE-00','RC-LIVE-01','RC-LIVE-02','RC-LIVE-03',
  'RC-LIVE-04','RC-LIVE-05','RC-LIVE-06','RC-LIVE-07',
  'RC-LIVE-08','RC-LIVE-09','RC-LIVE-10','RC-LIVE-11',
  'RC-LIVE-12','RC-LIVE-13','RC-LIVE-14','RC-LIVE-15',
] as const
type RcLiveGateId = typeof RC_LIVE_GATE_IDS[number]
type RcPressureGateId = 'RC-LIVE-12' | 'RC-LIVE-13'
type Sha256Ref = `sha256:${string}`
type ProductionProofKind =
  | 'maximum-scale-single-flight'
  | 'real-paused-sampling'
  | 'leaf-local-oom-or-ambiguous'
  | 'time-discontinuity'
const RC_PRESSURE_PROOF_KINDS = [
  'maximum-scale-single-flight', 'real-paused-sampling',
  'leaf-local-oom-or-ambiguous', 'time-discontinuity',
] as const satisfies readonly ProductionProofKind[]
type ProductionProofRefV1 = Sha256Ref

type EvidenceRowV1<G extends RcLiveGateId = RcLiveGateId> = {
  gateId: G
  backend: 'neutral/direct' | 'Node' | 'Rust'
  owner: string
  command: string
  testName: string
  gitCommit: string
  kernelVersion: string
  systemdVersion: string
  capabilityFingerprint: CapabilityFingerprint
  result: 'PASS'
  leftovers: []
}
type EvidenceManifestV1 = readonly [
  EvidenceRowV1<'RC-LIVE-00'>, EvidenceRowV1<'RC-LIVE-01'>,
  EvidenceRowV1<'RC-LIVE-02'>, EvidenceRowV1<'RC-LIVE-03'>,
  EvidenceRowV1<'RC-LIVE-04'>, EvidenceRowV1<'RC-LIVE-05'>,
  EvidenceRowV1<'RC-LIVE-06'>, EvidenceRowV1<'RC-LIVE-07'>,
  EvidenceRowV1<'RC-LIVE-08'>, EvidenceRowV1<'RC-LIVE-09'>,
  EvidenceRowV1<'RC-LIVE-10'>, EvidenceRowV1<'RC-LIVE-11'>,
  EvidenceRowV1<'RC-LIVE-12'>, EvidenceRowV1<'RC-LIVE-13'>,
  EvidenceRowV1<'RC-LIVE-14'>, EvidenceRowV1<'RC-LIVE-15'>,
]
type ApprovalScopeV1 = {
  gateId: RcPressureGateId
  backend: 'Node' | 'Rust'
  runId: string
  executionId: string
  executionStartedAt: string
  executionWindowEndsAt: string
  commandSha256: Sha256Ref
  vmImageDigest: Sha256Ref
  vmSnapshotDigest: Sha256Ref
  proofKinds: readonly ProductionProofKind[]
  destructiveResourceControl: true
  timeDiscontinuity: true
}
type SignedApprovalV1 = {
  approvalId: string
  scopes: readonly [ApprovalScopeV1, ApprovalScopeV1]
  issuedAt: string
  expiresAt: string
  signature: string
  signatureSha256: Sha256Ref
}
type ProofHostMetadataV1 = {
  hostname: string
  bootId: string
  kernelVersion: string
  libvirtVersion: string
}
type ProofGuestMetadataV1 = {
  hostname: string
  machineId: string
  bootId: string
  kernelVersion: string
  systemdVersion: string
  vmDomain: 'freshell-rc-live-disposable'
  vmSnapshot: 'systemd255-clean'
  vmImageDigest: Sha256Ref
  vmSnapshotDigest: Sha256Ref
}
type PassedCommand = { command: string; result: 'PASS' }
type ProductionProofArtifactBodyV1<K extends ProductionProofKind, M extends object> = {
  schemaVersion: 1
  kind: K
  gateId: RcPressureGateId
  backend: 'Node' | 'Rust'
  approvalId: string
  approvalScope: ApprovalScopeV1
  approvalSignatureSha256: Sha256Ref
  runId: string
  executionId: string
  executionStartedAt: string
  executionWindowEndsAt: string
  commandText: string
  commandSha256: Sha256Ref
  gitCommit: string
  startedAt: string
  endedAt: string
  host: ProofHostMetadataV1
  guest: ProofGuestMetadataV1
  capabilityFingerprint: CapabilityFingerprint
  source: 'production'
  fakeClockUsed: boolean
  result: 'PASS' | 'FAIL' | 'skipped' | 'unavailable'
  measurements: M
}
type ProductionProofArtifactV1<K extends ProductionProofKind, M extends object> =
  ProductionProofArtifactBodyV1<K, M> & { artifactHash: Sha256Ref }
type GateRunResultV1<G extends RcLiveGateId = RcLiveGateId> = {
  gateId: G
  backend: 'neutral/direct' | 'Node' | 'Rust'
  approvalId: string | null
  approvalScope: ApprovalScopeV1 | null
  runId: string
  executionId: string
  executionStartedAt: string
  executionWindowEndsAt: string
  gitCommit: string
  startedAt: string
  endedAt: string
  host: ProofHostMetadataV1
  guest: ProofGuestMetadataV1 | null
  capabilityFingerprint: CapabilityFingerprint
  passedCommands: readonly PassedCommand[]
  result: 'PASS' | 'FAIL' | 'skipped' | 'unavailable'
}
type ProductionProofIndexEntryV1<G extends RcLiveGateId = RcLiveGateId> = {
  gateId: G
  run: GateRunResultV1<G>
  artifactRefs: readonly ProductionProofRefV1[]
}
type ProductionProofIndexV1 = {
  schemaVersion: 1
  entriesByGateId: { [G in RcLiveGateId]: ProductionProofIndexEntryV1<G> }
  artifactsByHash: Readonly<Record<Sha256Ref, unknown>>
}
```

`EvidenceRowV1` is the specification's exact eleven-field flat shape; it never contains proof refs or nested proof data. `leftovers` is the literal zero-leftover assertion and serializes as `[]`. All hashes and provenance mappings live in the separate canonical `ProductionProofIndexV1`. Its `entriesByGateId` object has exactly one entry for every RC-LIVE-00–15 key; RC-LIVE-12/13 each map to four unique artifact hashes and every other gate maps to `[]`. Task 15 seals the artifacts and gate results. Task 17 parses and validates the complete sidecar—including duplicate JSON-key rejection, current approval/run windows, artifact hashes, and measured VM identity—before it may derive or accept any unchanged manifest row. Missing, extra, duplicate, stale, reused, mismatched, fake, or unavailable proof mappings fail release.

## File Structure Map

All plan file references are absolute. Canonical ownership includes:

- Shared/config/protocol: `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/shared/resource-limits.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/shared/settings.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/shared/ws-protocol.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/shared/ws-version.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/config-store.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/config-lease.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-protocol/src/resource_limits.rs`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-protocol/src/settings.rs`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-protocol/src/server_messages.rs`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-server/src/settings_store.rs`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-server/src/config_lease.rs`.
- Node control plane: `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/proc-info.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control/cgroup-path.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control/capability.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control/control-plane.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control/lifecycle-journal.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control/systemd.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control/controller.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control/spawn-broker.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control/pressure-policy.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control/router.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control/action-security.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control/audit.ts`.
- Rust control plane: `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/Cargo.toml` and `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src/capability.rs`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src/cgroup_path.rs`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src/controller.rs`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src/systemd.rs`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src/lifecycle.rs`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src/journal.rs`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src/launch.rs`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src/pressure.rs`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src/supervisor.rs`.
- Owners/client/docs: `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/terminal-registry.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/coding-cli/session-manager.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/extension-manifest.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/coding-cli/codex-app-server/runtime.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/coding-cli/codex-app-server/launch-planner.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/sdk-bridge.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/agent-api/layout-schema.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-terminal/src/registry.rs`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-terminal/src/pty.rs`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-ws/src/terminal.rs`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-freshagent/src/terminal_tabs.rs`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-freshagent/src/claude.rs`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-freshagent/src/codex.rs`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-codex/src/launch_plan.rs`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-codex/src/launch_lifecycle.rs`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-codex/src/sidecar_store.rs`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-opencode/src/serve.rs`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/src/store/resourceContainmentSlice.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/src/store/paneTypes.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/src/store/layoutMirrorMiddleware.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/src/components/settings/RuntimeSettings.tsx`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/src/components/ResourceContainmentModal.tsx`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/src/components/TerminalView.tsx`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/src/components/fresh-agent/FreshAgentView.tsx`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/src/lib/fresh-agent-ws.ts`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/README.md`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/docs/index.html`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/AGENTS.md`.

Protocol v8’s atomic file set additionally includes `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-protocol/src/lib.rs`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-protocol/src/common.rs`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-protocol/tests/version.rs`, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/port/contract/README.md`, generated contract JSON, `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/port/oracle/fixtures/handshake-transcript.json`, active T0/e2e handshake fixtures, and active port architecture/spec files. Historical captures/plans are not rewritten.

## Test-Double to Production-Proof Map

Deterministic fixtures driving production code are valid inputs. A fake replacing a production controller, owner, transport, middleware, or UI is not real outcome proof. Scheduled gates remain pending until executed.

| Test double / seam | Concrete production implementation | Required real outcome proof | Gate timing |
|---|---|---|---|
| Fake capability/process/filesystem I/O | Fresh Node/Rust probes and direct CLI/cgroupfs harness | Version, capacity, path, properties, freezer, ordering, population, cleanup | Task 1 before Task 2 |
| Config fault injector/in-memory store | Durable writers and per-home `flock(2)` | Sandbox process-kill old/new parseability, recovery, indeterminate degrade, Node×Rust refusal | Task 2 |
| Fake control-plane mailbox/clock | Node promise actor and production monitor using `process.hrtime.bigint()`; Rust Tokio actor and production monitor using `std::time::Instant` | Deterministic interleavings are inputs only. Mandatory approval-gated disposable-VM RC-LIVE-12/13 evidence must show the real production monitors at aggregate + 64 real leaves stay single-flight with no overlap, deliver every complete observation through the real production actor mailbox with one mutation turn at a time, and meet 500-ms snapshot/reduce/serialize plus 750-ms complete-cycle p99 budgets; an actually frozen real leaf remains sampled; actual guest suspend/resume and forward/backward wall-clock discontinuities do not advance the production actor’s policy elapsed time or phase. The gate-keyed proof-index entry must resolve to artifacts whose hashed bodies embed and match the current signed approval/scope, run/execution, canonical execution window, VM digests, capability, exact command, proof timestamps, host/guest identity, result, and measurements; the time payload requires `actualGuestPmSuspend === true`; injected/fake/stale/reused artifacts cannot satisfy the gate, and no hash enters the eleven-field row | Tasks 4–5 and Task 15 before commit/release |
| Fake systemd/cgroup I/O | Node production controller | Real create/readback/freeze/attach/thaw/population/revert/reconcile, no leftovers | Before Task 7 commit |
| Fake systemd/cgroup I/O | Rust production controller | Same independently | Before Task 8 commit |
| Mock node-pty | Production Node terminal/codingcli broker adapters | Real argv/cwd/env/TTY/I/O/resize/cancel/readiness/membership/cleanup | Before Task 9 commit |
| Mock portable-pty | Production Rust terminal/provisional registry | Same plus generation-tagged exit | Before Task 9 commit |
| Managed-Codex child fixture | Production Node/Rust pair owners | Two scopes, joint commit, teardown/retention/adoption, and explicit-resume recovery PTY prepared as a new scope in the adopted generation | Before Task 10 commit |
| SDK spawn fake | Production `SdkBridge` hook/installed SDK path | No pre-commit provider query; cwd/env/stdio/readiness/cancel | Before Task 11 commit |
| Tokio/native-child fake | Production Fresh Codex/fresh-agent owner | Native readiness/cancel/exit/membership/cleanup | Before Task 11 commit |
| OpenCode serve fixture | Production service manager/watcher | Post-ready loss, stale isolation, member handoff, pause behavior, reopenable completed history, and interrupted active response without automatic continuation | Before Task 12 commit |
| Fake WS frames/sender | Production handshake/broadcast/send-result | Mixed matrix, replay, 4008/reconnect, both browser backends | Tasks 13/17 |
| Fake auth/router | Real middleware and actor | Unauthorized/stale/replay has zero side effects; idempotency/audit | Task 14 |
| Fake layout/pane store | Production layout/reducers/views | Lifecycle races, sole resolution, no generic retry action | Tasks 14/17 |
| Fake pressure snapshots | Production Node/Rust single-flight monitors, real cgroup/controller observation, owner pause-generation hooks, and population-aware stop/release | Mandatory approval-gated RC-LIVE-12/13 artifacts must come from real cgroups and prove maximum-cardinality allocator efficacy, no-overlap/budgets, real paused sampling across at least three complete cycles after verified freeze, effective-victim freeze/reassessment, and stable leaf-local OOM or explicit ambiguous classification. Their hashed bodies must embed and match the current approval scope, run/execution window, VM digests, capability, exact command, proof timestamps, host/guest identity, result, and measurements; the gate-keyed sidecar mapping must name those hashes. Focused/injected/stale/reused snapshots cannot satisfy `result:'PASS'` | Task 15 before commit/release |
| Seeded exit code/signal | Owner-specific production exit adapters and pinned counters | Node signal/null, Tokio signal, portable-pty unknown, no false attribution | Tasks 9–15 |
| Fake journal/startup state | Versioned journal/reconciler | Kill boundaries, same-boot adoption, cross-boot cleanup, no duplicate spawn | Tasks 7–8/16 |
| Fake shutdown channels | Supervisor-owned joins/receivers | Close/drain/dispose; no late spawn or leaked task | Task 16 |
| `docs/index.html` visual mock | Real React settings/modal/reducers | Both Playwright backend projects | Task 17 |

## Execution Preflight

- [ ] Confirm Task 1’s active sentinel evidence before any controller contract commit.
- [ ] Record Task 2’s compatibility-floor release/deployment identifier before Task 3.
- [ ] Use unique temporary settings homes; same-home sharing only in explicit singleton/adoption tests.
- [ ] Run `npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:status` before broad tests and wait for foreign holders.
- [ ] Obtain explicit approval immediately before every RC-LIVE invocation; record kernel/systemd/capability and owned unit/PID prefixes.
- [ ] Run process/config destruction only via repository `test:sandbox`; run OOM only in the required disposable VM snapshot.
- [ ] RC-LIVE-12/13 additionally require a fresh approval file and the named disposable libvirt snapshot for real maximum-scale/paused sampling and the production-clock discontinuity subprotocol. Missing libvirt guest-agent suspend support, restricted time-setting authority, any fake clock/observation port, or any missing proof artifact blocks Task 15 and release.
- [ ] Never touch, deploy, or restart port 3001. Never create a PR/deploy without separate explicit approval.
- [ ] A missing/skipped/unavailable mandatory cell is an unmet gate and stops that task/release.

## Phase 0 — Approval-Gated Feasibility and Contract Freeze

### Task 1: Establish active systemd feasibility and freeze the package contract

**Files:**
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/helpers/resource-control-live.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/unit/server/resource-control-feasibility-harness.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/integration/real/resource-control-feasibility.test.ts`

**Interfaces:** consumes `CapabilityFingerprint`, `EffectiveResourceCapacity`, exact systemd topology/property argv, deadlines, blocking scope argv, and canonical `EvidenceRowV1`; produces `runActiveFeasibility`, package sentinel result, and one RC-LIVE-00 outcome that Task 17 serializes as exactly one row with `leftovers:[]`.

- [ ] **RED:** Add exact named cases `rejects systemd 254`, `rejects --no-block`, `rejects non-100-mCPU`, `rejects non-MiB`, `rejects missing required raw file`, `retains cleanup failure`, and `detects an early sentinel write`.

```ts
it.each(['systemd-254','no-block','cpu-125m','bytes-not-mib','missing-file','cleanup-retry','early-write'])(
  'rejects invalid feasibility transaction: %s', async fault => {
    expect(await runFeasibilityFixture({ fault })).toMatchObject({ ok: false })
  },
)
```

- [ ] Run the focused test before implementation:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/resource-control-feasibility-harness.test.ts \
  --config config/vitest/vitest.server.config.ts --run
```

Expected: FAIL because the complete direct harness/sentinel contract is absent.

- [ ] Implement argv-safe direct CLI/cgroupfs operations, systemd >=255, unique `freshellagentsfeas<uuid>` units, canonical quantization, every deadline, signal-safe cleanup, and this concrete surface/order:

```ts
export async function runActiveFeasibility(options: {
  unitPrefix: string
  sentinelPath: string
  timeoutSignal: AbortSignal
}): Promise<{
  fingerprint: CapabilityFingerprint
  capacity: EffectiveResourceCapacity
  cleanup: 'clean'
}> {
  const owned = new OwnedUnitSet(options.unitPrefix)
  const { fingerprint, capacity } = await probeCompleteHost(options.timeoutSignal)
  if (fingerprint.systemdVersion < 255) throw new FeasibilityError('SYSTEMD_TOO_OLD')
  try {
    const topology = await owned.createLimitedTopology(capacity)
    await topology.assertExactRawReadback()
    await topology.writeAndReadOomGroup()
    await topology.freezeEmptyLeaf()
    const sentinel = await topology.startBlockingSentinel(options.sentinelPath)
    await topology.assertFrozenMembership(sentinel.pid)
    await sentinel.assertNoWriteBeforeThaw()
    await topology.thawAndAssertSentinelWrite(sentinel)
    await topology.assertRootExitKeepsDescendantPopulated()
    await topology.assertBoundedFreezeThawStop()
  } finally {
    await owned.retryCleanupUntilTerminal()
  }
  if ((await owned.listSurvivors()).length !== 0) throw new FeasibilityError('CLEANUP_INCOMPLETE')
  return { fingerprint, capacity, cleanup: 'clean' }
}
```

- [ ] **GREEN:** Re-run the focused command. Expected: PASS; every injected fault fails closed and cleanup identity remains retryable.
- [ ] **Evidence gate RC-LIVE-00:** Obtain explicit approval, use a unique isolated home, then run:

```bash
FRESHELL_RUN_REAL_RESOURCE_CONTROL=1 \
  npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/integration/real/resource-control-feasibility.test.ts \
  --config config/vitest/vitest.server.config.ts --run
```

Expected: PASS proving version, root/mount agreement, aggregate→leaf→scope, exact normalized values, OOM/freezer write+reread, frozen-before-exec sentinel, blocking attachment, root-exit/live-descendant population, bounded freeze/thaw/stop, injected cleanup retry, revert/drop-in/cgroup disappearance, and zero surviving helpers/units. The reporter emits exactly one RC-LIVE-00 row with `leftovers:[]`; missing approval, skip, unavailable host, or any failure emits no PASS row, stops before Task 2, and forbids commit.

**Commit:**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add test/helpers/resource-control-live.ts test/unit/server/resource-control-feasibility-harness.test.ts test/integration/real/resource-control-feasibility.test.ts
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit -F - <<'EOF'
test(resource-control): establish active systemd feasibility gate

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
```

## Phase 1 — Compatibility Floor

### Task 2: Land config-v2 durability and one-server-per-home lease

**Files:**
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/config-store.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/config-lease.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/shared/settings.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-server/src/settings_store.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-server/src/config_lease.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/package.json`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/package-lock.json`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-server/Cargo.toml`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.lock`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/integration/server/config-store-crash-safety.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/integration/server/resource-settings-cross-process.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/specs/cfg03-backup-restore.spec.ts`

**Interfaces:** consumes `ConfigEnvelopeV2`; produces `ResourceDomainId` from SHA-256(Unix UID + canonical config directory), `acquireServerLease(configDirectory): ServerLease`, `durableReplace(path, bytes)`, `PERSIST_FAILED`, and `PERSIST_STATE_UNKNOWN`; Rust consumes/produces the serde-equivalent contracts on the same kernel lease.

- [ ] **RED:** Add exact kill points temp-write/file-sync/rename/directory-sync; last-good backup; v1→v2 recovery; unknown top/nested preservation; Node×Node, Rust×Rust, Node×Rust same-home refusal; separate-home success; required-feature startup refusal; downgrade only when disabled and lifecycle-empty.

```ts
it.each(['temp-write','file-sync','rename','directory-sync'])(
  'recovers a parseable old-or-new primary at %s', async boundary => {
    const result = await killWriterAt(boundary)
    expect(parseRecovered(result.path)).toEqualOneOf([result.old, result.next])
  },
)
```

- [ ] Run both focused commands before implementation:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:sandbox -- \
  "npm run test:vitest -- \
    test/integration/server/config-store-crash-safety.test.ts \
    test/integration/server/resource-settings-cross-process.test.ts \
    --config config/vitest/vitest.server.config.ts --run"

cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-server settings_store::
```

Expected: FAIL because config v2 durability and a cross-backend kernel lease are absent.

- [ ] Implement unique same-directory temp → complete write → file sync → atomic rename → directory sync; classify known-pre-rename versus indeterminate post-rename failures; reload parseable primary and degrade on indeterminate state. Preserve unknown fields and safely increment `configRevision`. Acquire nonblocking process-lifetime `<config-directory>/server.lock` with Linux-only `fs-ext`/`fs2`; fail before serving/writing. Backups use the identical durable primitive.

```ts
export async function durableReplace(path: string, bytes: Uint8Array): Promise<'committed'> {
  const temp = uniqueSibling(path)
  let renamed = false
  try {
    const file = await openExclusive(temp)
    await file.write(bytes)
    await file.sync()
    await file.close()
    await rename(temp, path)
    renamed = true
    await fsyncDirectory(dirname(path))
    return 'committed'
  } catch (error) {
    if (!renamed) throw persistError('PERSIST_FAILED', error)
    const recovered = await reloadParseablePrimary(path)
    enterConfigDegradedState(recovered)
    throw persistError('PERSIST_STATE_UNKNOWN', error)
  } finally {
    if (!renamed) await unlinkIfOwned(temp)
  }
}
```

- [ ] Tag the existing browser matrix so discovery is independent of nested title paths:

```diff
-test.describe('CFG-03 backup/fallback matrix', () => {
+test.describe('CFG-03 backup/fallback matrix @cfg03-backup-matrix', () => {
```

- [ ] Run the staged CFG03 browser artifact before commit:

```bash
cfg03_discovery="$(npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment exec playwright test -- \
  --config /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/playwright.config.ts \
  --project=legacy-chromium --project=rust-chromium \
  /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/specs/cfg03-backup-restore.spec.ts \
  --grep "@cfg03-backup-matrix" --list)"
test "$(printf '%s\n' "$cfg03_discovery" | grep -c '@cfg03-backup-matrix')" -gt 0
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment exec playwright test -- \
  --config /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/playwright.config.ts \
  --project=legacy-chromium --project=rust-chromium \
  /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/specs/cfg03-backup-restore.spec.ts \
  --grep "@cfg03-backup-matrix"
```

Expected: discovery exits 0 and finds at least one collected full-title path tagged `@cfg03-backup-matrix`; the execution then PASSes in both browser projects with identical Node/Rust old/new/backup recovery behavior.
- [ ] **GREEN:** Re-run both sandbox/Rust commands and the exact CFG03 browser command. Expected: PASS with old-or-new parseability, acknowledged-new restart, honest degraded state, backup recovery, and shared-kernel lock contention.
- [ ] **Evidence gate:** Destructive cases ran only in the repository sandbox. No power-cut durability claim is made.

**Commit:**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add server/config-store.ts server/config-lease.ts shared/settings.ts crates/freshell-server/src/settings_store.rs crates/freshell-server/src/config_lease.rs package.json package-lock.json crates/freshell-server/Cargo.toml Cargo.lock test/integration/server/config-store-crash-safety.test.ts test/integration/server/resource-settings-cross-process.test.ts test/e2e-browser/specs/cfg03-backup-restore.spec.ts
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit -F - <<'EOF'
fix(config): establish durable cross-backend compatibility floor

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
```

**Hard checkpoint:** Stop after commit. Obtain separate approval to merge/release/deploy this floor and record it as the minimum rollback target. No later task may write `resource-containment-v1` until that deployment is confirmed.

## Phase 2 — Settings, Capacity, and Control-Plane State

### Task 3: Define the canonical fifteen-integer contract and feature marker

**Files:**
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/shared/resource-limits.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/shared/settings.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-protocol/src/resource_limits.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-protocol/src/settings.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/unit/shared/resource-limits.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/unit/shared/settings.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-protocol/tests/roundtrip.rs`

**Interfaces:** consumes `EffectiveResourceCapacity` and `ConfigEnvelopeV2`; produces `ResourceLimitSet`, `CodingAgentResourceLimits`, `calculateInitialResourceLimits(capacity)`, exact validation, and atomic `requiredConfigFeatures` mutation.

- [ ] **RED:** Add independent TS/Rust expected literals for complete formulas, no fallback, 100-mCPU/MiB/page constraints, zero swap, safe-integer boundaries, child≤aggregate, exact no-op roundtrip of all fifteen integers, incomplete-capacity rejection, marker add on enable, marker removal only disabled+lifecycle-empty.

```ts
expect(() => calculateInitialResourceLimits({
  cpuQuotaMillis: 2_000,
  memoryBytes: undefined,
  swapBytes: 0,
  tasksMax: 512,
} as never)).toThrow('RESOURCE_LIMITS_UNAVAILABLE')
expect(flattenLimits(roundTrip(fifteenLiteral))).toEqual(flattenLimits(fifteenLiteral))
```

- [ ] Run focused commands before implementation:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/shared/resource-limits.test.ts test/unit/shared/settings.test.ts \
  --config config/vitest/vitest.config.ts --run
cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-protocol
```

Expected: FAIL because canonical TS/Rust parity and marker transitions are absent.

- [ ] Implement the exact canonical types/formulas, integer quantization before validation, complete capacity requirement, exact page constraint, safe integer checks, and unknown-field-preserving marker transitions.

```ts
export function calculateInitialResourceLimits(c: EffectiveResourceCapacity): CodingAgentResourceLimits {
  assertCompleteCapacity(c)
  const allAgents: ResourceLimitSet = {
    cpuQuotaMillis: floor100(c.cpuQuotaMillis / 2),
    memoryMaxBytes: floorMiB((2 * c.memoryBytes) / 3),
    memoryHighBytes: 0,
    swapMaxBytes: 0,
    tasksMax: Math.floor((3 * c.tasksMax) / 4),
  }
  allAgents.memoryHighBytes = floorMiB((4 * allAgents.memoryMaxBytes) / 5)
  allAgents.swapMaxBytes = floorMiB(Math.min(c.swapBytes / 4, allAgents.memoryMaxBytes / 4))
  const eachAgent = scaleHardLimits(allAgents, 50, 80)
  const sharedOpenCode = scaleHardLimits(allAgents, 90, 80)
  const limits = { enabled: true, allAgents, eachAgent, sharedOpenCode }
  validateCanonicalLimits(limits)
  return limits
}
```

- [ ] **GREEN:** Re-run both commands. Expected: PASS with independent language fixtures and exact integer roundtrips.
- [ ] **Evidence gate:** Verify Task 2’s deployed floor identifier is recorded before any enabled marker is persisted; otherwise stop.

**Commit:**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add shared/resource-limits.ts shared/settings.ts crates/freshell-protocol/src/resource_limits.rs crates/freshell-protocol/src/settings.rs test/unit/shared/resource-limits.test.ts test/unit/shared/settings.test.ts crates/freshell-protocol/tests/roundtrip.rs
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit -F - <<'EOF'
feat(resource-limits): add shared-domain limit contract

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
```

### Task 4: Build the Node actor, fresh capability, and admission generations

**Files:**
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/proc-info.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control/cgroup-path.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control/capability.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control/control-plane.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/platform-router.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/settings-router.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/config-store.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/index.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/unit/server/resource-control-capability.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/unit/server/resource-control-settings.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/unit/server/resource-control-control-plane.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/integration/server/settings-api.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/integration/server/platform-api.test.ts`

**Interfaces:** consumes Task-2 `ResourceDomainId`, `ConfigEnvelopeV2`, `ResourceControlCapability`, `CapabilityFingerprint`, and `PolicySnapshot`; produces a fresh process `ServerEpoch`, durable `SettingsRevision`, process-epoch-local `PolicyGeneration`, fresh `probeResourceControlCapability()`, `LaunchAdmission`, actor `PatchSettings`/`BeginLaunch`, and REST `settingsLocked`. The pair `{serverEpoch, policyGeneration}` is the immutable Node admission identity.

- [ ] **RED:** Encode concurrent first-enable exactly once; disjoint patches; edit×admission; disable×launch exact order; fresh process affinity and tightest ancestor `cpu.max`; fresh `/proc/meminfo` `MemTotal`/`SwapTotal` and `/proc/sys/kernel/pid_max` bounded by tightest ancestors; explicit zero swap; missing source unavailable; stale fingerprint; C1→C2; unavailable disable; `PERSIST_STATE_UNKNOWN` degrade; cap rejection before spawn; every nonterminal lease/group locks numeric edits. Add `all actorState mutation requires mailbox ownership`: concurrent dispatch must observe claim/plan and complete/record as two serialized mailbox turns with external I/O between them and no direct state method callable outside `actorMailbox.enqueue`.

```ts
await expect(history([
  'BeginLaunch@C1',
  'PatchSettings@C2',
  'CommitLaunch',
])).resolves.toEqual([
  'lease(policyGeneration=1)',
  'settingsRevision=2',
  'commit(policyGeneration=1)',
])
```

- [ ] Run the focused command before implementation:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/resource-control-capability.test.ts \
  test/unit/server/resource-control-settings.test.ts \
  test/unit/server/resource-control-control-plane.test.ts \
  test/integration/server/settings-api.test.ts \
  test/integration/server/platform-api.test.ts \
  --config config/vitest/vitest.server.config.ts --run
```

Expected: FAIL because no single Node ordering authority/fresh admission exists.

- [ ] Implement a promise-mailbox actor that owns settings/policy generations, admission leases, groups, pending rows, operation results, projection, and monitor handle. `actorState` is private to mailbox callbacks: claim/plan is one mailbox turn, immutable external work runs after that turn releases, and complete/record is a second mailbox turn. Probe fresh on enable/save/admission. No state read-modify-write or mutation is permitted outside `actorMailbox.enqueue`.

```ts
export interface ResourceControlActor {
  patchSettings(commandId: string, patch: unknown): Promise<{
    settingsRevision: SettingsRevision
    policyGeneration: PolicyGeneration
  }>
  beginLaunch(commandId: string, domain: ExecutionDomain, target: LaunchTarget): Promise<LaunchAdmission>
  snapshot(): Readonly<{ settingsRevision: SettingsRevision; settingsLocked: boolean }>
}

async function dispatch(command: ActorCommand): Promise<ActorReply> {
  const planned = await actorMailbox.enqueue(() => actorState.claimAndPlan(command))
  if (planned.kind === 'replay') return planned.recordedReply
  const external = await runPersistenceOrControllerIo(planned.request)
  return actorMailbox.enqueue(() => {
    const reply = actorState.completePlannedOperation(planned.operationToken, external)
    actorState.recordReply(command.commandId, reply)
    return reply
  })
}
```

- [ ] **GREEN:** Re-run the focused command. Expected: PASS with deterministic histories and no spawn call on rejection.
- [ ] **Evidence gate:** Fake process/filesystem inputs drive production probe code; Task 1 remains the required active package proof.

**Commit:**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add server/proc-info.ts server/resource-control/cgroup-path.ts server/resource-control/capability.ts server/resource-control/control-plane.ts server/platform-router.ts server/settings-router.ts server/config-store.ts server/index.ts test/unit/server/resource-control-capability.test.ts test/unit/server/resource-control-settings.test.ts test/unit/server/resource-control-control-plane.test.ts test/integration/server/settings-api.test.ts test/integration/server/platform-api.test.ts
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit -F - <<'EOF'
feat(resource-control): serialize Node settings and launch admission

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
```

### Task 5: Build the lower-crate Rust lifecycle actor and fresh capability

**Files:**
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/Cargo.toml`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src/lib.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src/capability.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src/cgroup_path.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src/lifecycle.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src/supervisor.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-server/src/main.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-server/src/settings_store.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.lock`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/tests/lifecycle.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-server/tests/resource_containment_settings.rs`

**Interfaces:** consumes serde-equivalent Task-2 `ResourceDomainId`, `ConfigEnvelopeV2`, `ResourceControlCapability`, `CapabilityFingerprint`, and `PolicySnapshot`; produces a fresh Rust `ServerEpoch`, process-epoch-local `PolicyGeneration`, `LifecycleClient`, typed `LifecycleCommand`, immutable watch snapshots, supervisor jobs, oneshot acknowledgements, and lower-crate persistence/controller traits. `{server_epoch, policy_generation}` is the Rust immutable admission identity.

- [ ] **RED:** Mirror every Task-4 interleaving with independent Rust literals and add acknowledgement, duplicate command ID, no mutex over await, closed intake, no self-sender cycle, and actor join. Prove the receive loop accepts `BeginShutdown` while a controller/persistence port future is pending; external I/O runs only in a supervisor-owned job; completion commits only through a typed `OperationCompleted` mailbox event; synchronous callbacks can only enqueue typed events through `LifecycleClient` and cannot reenter actor state.

```rust
#[tokio::test]
async fn duplicate_command_id_returns_recorded_ack_without_a_second_port_call() {
    let ports = CountingPorts::default();
    let (client, actor) = spawn_lifecycle_actor(ports.clone());
    let id = CommandId::from_u128(7);
    let first = client.patch_settings(id, patch_fixture()).await.unwrap();
    let replay = client.patch_settings(id, patch_fixture()).await.unwrap();
    assert_eq!(replay, first);
    assert_eq!(ports.persist_calls(), 1);
    client.begin_shutdown(CommandId::from_u128(8)).await.unwrap();
    actor.join().await.unwrap();
    assert_eq!(ports.live_jobs(), 0);
}
```

- [ ] Run before implementation:

```bash
cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-resource-control --test lifecycle duplicate_command_id_returns_recorded_ack_without_a_second_port_call -- --exact
cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-server --test resource_containment_settings
```

Expected: FAIL because the lower crate/actor and exact test targets do not exist.

- [ ] Implement one Tokio actor task; define persistence/controller traits in the lower crate and implementations in the server; provide immutable watch snapshots, closeable intake, stable command IDs, oneshot acknowledgements, and tracked supervisor jobs. The actor loop only claims/plans or commits typed completions. It never awaits a controller, persistence, filesystem, provider, or layout port. A supervisor job executes the immutable request outside actor mutation and sends `OperationCompleted { token, outcome }` back through the mailbox. Callbacks have no state reference and may only enqueue typed events through `LifecycleClient`; callback reentry is forbidden.

```rust
enum Envelope {
    Command { id: CommandId, command: LifecycleCommand, reply: oneshot::Sender<ActorReply> },
    OperationCompleted { token: OperationToken, outcome: PortOutcome },
    Callback(CallbackEvent),
}

fn dispatch_external_operation(
    supervisor: &mut Supervisor,
    ports: Arc<dyn ExternalPorts>,
    completion_tx: mpsc::WeakSender<Envelope>,
    planned: PlannedOperation,
) {
    supervisor.spawn(run_external_operation(ports, completion_tx, planned));
}

async fn run_external_operation(
    ports: Arc<dyn ExternalPorts>,
    completion_tx: mpsc::WeakSender<Envelope>,
    planned: PlannedOperation,
) {
    let outcome = ports.execute(planned.request).await;
    if let Some(completion_tx) = completion_tx.upgrade() {
        completion_tx.send(Envelope::OperationCompleted {
            token: planned.token,
            outcome,
        }).await.expect("actor completion intake remains open");
    }
}

async fn run_lifecycle_actor(mut state: State, mut rx: mpsc::Receiver<Envelope>) {
    while let Some(envelope) = rx.recv().await {
        match envelope {
            Envelope::Command { id, command, reply } => {
                if let Some(recorded) = state.completed.get(&id).cloned() {
                    let _ = reply.send(recorded);
                    continue;
                }
                let planned = state.plan_operation(id, command, reply).expect("validated command");
                dispatch_external_operation(
                    &mut state.supervisor,
                    state.ports.clone(),
                    state.completion_tx.clone(),
                    planned,
                );
            }
            Envelope::OperationCompleted { token, outcome } => {
                let completed = state.commit_operation(token, outcome);
                state.completed.insert(completed.command_id, completed.reply.clone());
                state.watch_tx.send_replace(state.snapshot());
                let _ = completed.ack.send(completed.reply);
            }
            Envelope::Callback(event) => state.reduce_callback_event(event),
        }
    }
    state.supervisor.join_all().await.expect("all actor jobs join");
}
```

- [ ] **GREEN:** Run the two exact commands above, then the complete lower-crate target:

```bash
cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-resource-control --test lifecycle
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-resource-control -p freshell-server resource_containment
```

Expected: PASS for both commands; the mandated cross-package `resource_containment` filter runs, every exact actor test passes, intake remains responsive during pending external I/O, callbacks do not reenter state, and every supervisor job joins.
- [ ] **Evidence gate:** Active Rust controller proof is owned by Task 8; this task cannot claim it from actor doubles.

**Commit:**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add Cargo.toml Cargo.lock crates/freshell-resource-control/Cargo.toml crates/freshell-resource-control/src/lib.rs crates/freshell-resource-control/src/capability.rs crates/freshell-resource-control/src/cgroup_path.rs crates/freshell-resource-control/src/lifecycle.rs crates/freshell-resource-control/src/supervisor.rs crates/freshell-resource-control/tests/lifecycle.rs crates/freshell-server/src/main.rs crates/freshell-server/src/settings_store.rs crates/freshell-server/tests/resource_containment_settings.rs
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit -F - <<'EOF'
feat(rust): add lifecycle actor and settings admission order

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
```

### Task 6: Add exact-value Runtime Settings and unavailable recovery

**Files:**
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/src/components/settings/RuntimeSettings.tsx`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/src/components/settings/settings-controls.tsx`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/src/store/settingsSlice.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/src/store/connectionSlice.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/src/store/store.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/src/App.tsx`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/unit/client/components/RuntimeSettings.resource-limits.test.tsx`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/unit/client/components/SettingsView.core.test.tsx`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/specs/settings-live-reload.spec.ts`

Do not modify `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/src/store/resourceContainmentSlice.ts` or any containment WebSocket shape before Task 13; Task 4 supplies REST `settingsLocked`.

**Interfaces:** consumes `CodingAgentResourceLimits`, `ResourceControlCapability`, REST `settingsLocked`, and existing `applyServerSetting`; produces accessible fifteen-integer controls, one local draft/complete save, and enable-only toggle patches.

- [ ] **RED:** Test absent+unavailable disables switch; stored enabled+unavailable permits enable-only disable; toggle sends only `{enabled}`; numeric save sends raw canonical integers; exact boundary no-op; server lock; stale capability error; guarded missing old-server field. Add the exact browser test title `resource containment settings live reload @resource-containment-settings`; the shared spec runs in both backend projects and the unique tag is the discovery filter.

```tsx
expect(await submittedToggle(false)).toEqual({
  safety: { codingAgentResourceLimits: { enabled: false } },
})
expect(readAllFifteen(renderedForm)).toEqual(fifteenLiteral)
```

- [ ] Run before implementation:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/client/components/RuntimeSettings.resource-limits.test.tsx \
  test/unit/client/components/SettingsView.core.test.tsx \
  --config config/vitest/vitest.config.ts --run
```

Expected: FAIL because the exact controls and unavailable recovery are absent.

- [ ] Implement accessible raw-integer inputs, one complete save, enable-only recovery, guarded old-server capability, and server-authored locking.

```tsx
function submitResourceDraft(draft: CodingAgentResourceLimits, enableOnly: boolean): void {
  if (enableOnly) {
    applyServerSetting({ safety: { codingAgentResourceLimits: { enabled: draft.enabled } } })
    return
  }
  if (settingsLocked) throw new UiValidationError('RESOURCE_LIMITS_ACTIVE')
  const canonical = parseAllFifteenSafeIntegers(draft)
  applyServerSetting({ safety: { codingAgentResourceLimits: canonical } })
}
```

Register the browser case with this exact discoverable title:

```ts
test('resource containment settings live reload @resource-containment-settings', async ({ page }) => {
  await exerciseUnavailableDisableExactFifteenValueSaveAndLiveReload(page)
})
```

Render this exact copy:

> Freshell applies cooperative Linux cgroup limits to local processes launched through this server’s broker. This is not a security boundary: code running as the same Unix user may reconfigure or leave the hierarchy. Native Windows processes and their descendants are not covered. One combined cap is shared only by the active Node or Rust server and surviving generations that use the same Unix UID and canonical Freshell settings directory; a different settings directory is a different resource domain and has a separate cap.

- [ ] Run the exact settings browser gate before commit:

```bash
settings_discovery="$(npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment exec playwright test -- \
  --config /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/playwright.config.ts \
  --project=legacy-chromium --project=rust-chromium \
  /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/specs/settings-live-reload.spec.ts \
  --grep "@resource-containment-settings" --list)"
test "$(printf '%s\n' "$settings_discovery" | grep -c '@resource-containment-settings')" -gt 0
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment exec playwright test -- \
  --config /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/playwright.config.ts \
  --project=legacy-chromium --project=rust-chromium \
  /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/specs/settings-live-reload.spec.ts \
  --grep "@resource-containment-settings"
```

Expected: discovery exits 0 and finds at least one collected full-title path tagged `@resource-containment-settings`; execution PASSes in both browser projects for unavailable disable, exact fifteen-value save, and live reload.
- [ ] **GREEN:** Re-run the focused Vitest command and exact browser command. Expected: PASS and all fifteen integers survive a no-op save exactly.
- [ ] **Evidence gate:** Both non-skipped browser projects must pass the exact titled case before commit; either missing cell is an unmet UI gate.

**Commit:**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add src/components/settings/RuntimeSettings.tsx src/components/settings/settings-controls.tsx src/store/settingsSlice.ts src/store/connectionSlice.ts src/store/store.ts src/App.tsx test/unit/client/components/RuntimeSettings.resource-limits.test.tsx test/unit/client/components/SettingsView.core.test.tsx test/e2e-browser/specs/settings-live-reload.spec.ts
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit -F - <<'EOF'
feat(client): add recoverable shared-domain resource settings

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
```

## Phase 3 — Controllers, Broker, and Owners

### Task 7: Implement the Node controller, journal, prepared leases, and reconciliation

**Files:**
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control/systemd.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control/controller.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control/lifecycle-journal.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control/control-plane.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/unit/server/resource-control-systemd.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/unit/server/resource-control-controller.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/unit/server/resource-control-lifecycle.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/integration/real/resource-control-node-systemd.test.ts`

**Interfaces:** consumes Task-2 `ResourceDomainId`, Task-4 `ServerEpoch`/`PolicyGeneration`, `PolicySnapshot`, `LaunchAdmission`, `OwnerRecipeV1`, and canonical `EvidenceRowV1`; produces `OwnerLeaseId`, `OwnerLifecycleState`, `CompensationStep`, `StepOutcome`, `PreparedOwnerLease`, `LifecycleJournalV1`, `ResourceControl`, `AdditionalScopeRequest`, `PreparedAdditionalScope`, `prepareAdditionalScope()`, `verifyAdditionalScope()`, `thawAdditionalScopeAfterCommit()`, `WrappedArgv`, `PressureObservation`, the Node controller port, and one RC-LIVE-01 outcome consumed by Task 17 as exactly one row with `leftovers:[]`. Tasks 9–12 consume these lifecycle/compensation contracts; Task 16 reconciles them.

- [ ] **RED:** Test exact topology/readback; prepared frozen leaf blocks execution; every compensation step after each injected failure; cancellation schedules compensation; root exit with live descendant; stop failure retains reverse identity; final evidence precedes population release; same-boot adoption; cross-boot cleanup; dispose closes admission; retained Codex is excluded from non-retained disposal. For an adopted thawed lease, `prepareAdditionalScope` must validate lease/generation, freeze the whole leaf, wait/read back `frozen=1`, pin existing member identities, and return a wrapper only after that barrier; stale generation or freeze/readback failure returns no wrapper and no spawn.

```ts
for (const boundary of lifecycleBoundaries) {
  const result = await faultAt(boundary)
  expect(result.compensation).toHaveEveryStepAttempted()
  expect(result.publication).toBe(false)
}
```

- [ ] Run unit files before implementation:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/resource-control-systemd.test.ts \
  test/unit/server/resource-control-controller.test.ts \
  test/unit/server/resource-control-lifecycle.test.ts \
  --config config/vitest/vitest.server.config.ts --run
```

Expected: FAIL because transactional controller/journal behavior is absent.

- [ ] Implement the exact `ResourceControl` surface, topology, deadlines, ordering barrier, durable `LifecycleJournalV1`, population-aware release, all-step retryable compensation, same/cross-boot reconciliation, and close/drain/dispose behavior. Do not change owner files.

```ts
async function prepareOwnerLease(
  admission: Extract<LaunchAdmission, { mode: 'contained' }>,
  recipe: OwnerRecipeV1,
): Promise<PreparedOwnerLease> {
  const lease = actor.claimPreparedIdentity(admission, recipe)
  await journal.replace(withState(lease, 'claimed'))
  await systemd.ensureAggregateAndLeaf(lease)
  await systemd.assertExactRawReadback(lease)
  await systemd.setOomGroupAndFreezeEmptyLeaf(lease)
  await journal.replace(withState(lease, 'prepared'))
  return lease
}

type AdditionalScopeRequest = Readonly<{
  leaseId: OwnerLeaseId
  generation: LaunchGeneration
  scopeToken: string
  role: string
  expectedExistingMembers: readonly ProcessIdentity[]
}>
type PreparedAdditionalScope = Readonly<{
  request: AdditionalScopeRequest
  frozenReadback: Readonly<{ cgroupFreeze: 1; cgroupEventsFrozen: 1 }>
  wrap(argv: readonly string[]): WrappedArgv
}>

async function prepareAdditionalScope(request: AdditionalScopeRequest): Promise<PreparedAdditionalScope> {
  const lease = await journal.requireAdoptedLease(request.leaseId, request.generation)
  await systemd.assertMembersExactly(lease.leaf, request.expectedExistingMembers)
  await systemd.freezeLeafAndWait(lease.leaf, controllerDeadlines.freezeMs)
  const frozenReadback = await systemd.readAndRequireFrozen(lease.leaf)
  await journal.replace(withAdditionalScopeState(lease, request.scopeToken, 'prepared-frozen'))
  return {
    request,
    frozenReadback,
    wrap: argv => wrapBlockingScopeArgv(lease, request.scopeToken, request.role, argv),
  }
}

async function verifyAdditionalScope(prepared: PreparedAdditionalScope, members: readonly ProcessIdentity[]): Promise<void> {
  await systemd.requireStillFrozen(prepared.request.leaseId, prepared.frozenReadback)
  await systemd.requireBlockedScopeMembers(prepared.request.scopeToken, members)
  await systemd.assertExactRawReadback(prepared.request.leaseId)
}

async function thawAdditionalScopeAfterCommit(prepared: PreparedAdditionalScope): Promise<void> {
  await journal.requireAdditionalScopeState(prepared.request.scopeToken, 'committed')
  await systemd.thawLeafAndWait(prepared.request.leaseId, controllerDeadlines.thawMs)
}

async function compensate(lease: PreparedOwnerLease): Promise<void> {
  for (const step of compensationOrder) {
    lease.compensation[step] = await attemptCompensationStep(step, lease)
    await journal.replace(updateLease(lease))
  }
}
```

- [ ] **GREEN:** Re-run the unit command. Expected: PASS with every fault boundary durable and retryable.
- [ ] **Evidence gate RC-LIVE-01:** After explicit approval and isolation, run:

```bash
FRESHELL_RUN_REAL_RESOURCE_CONTROL=1 \
  npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/integration/real/resource-control-node-systemd.test.ts \
  --config config/vitest/vitest.server.config.ts --run
```

Expected: PASS for real topology, exact readback, attach, freeze/thaw, population, revert, reconcile, and zero leftovers, producing exactly one RC-LIVE-01 row with `leftovers:[]`. Skip/unavailable/failure produces no PASS row and blocks commit.

**Commit:**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add server/resource-control/systemd.ts server/resource-control/controller.ts server/resource-control/lifecycle-journal.ts server/resource-control/control-plane.ts test/unit/server/resource-control-systemd.test.ts test/unit/server/resource-control-controller.test.ts test/unit/server/resource-control-lifecycle.test.ts test/integration/real/resource-control-node-systemd.test.ts
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit -F - <<'EOF'
feat(server): add verified transactional systemd controller

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
```

### Task 8: Implement the Rust controller and lower-actor integration

**Files:**
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src/controller.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src/systemd.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src/journal.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src/lifecycle.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src/supervisor.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src/lib.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-server/src/main.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/tests/systemd.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/tests/lifecycle.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/tests/reconcile.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/tests/live_systemd.rs`

**Interfaces:** consumes Task-2 `ResourceDomainId`, Task-5 `ServerEpoch`/`PolicyGeneration`, serde-equivalent `PolicySnapshot`, `LaunchAdmission`, `OwnerRecipeV1`, and canonical `EvidenceRowV1`; produces Rust `OwnerLeaseId`, `OwnerLifecycleState`, `CompensationStep`, `StepOutcome`, `PreparedOwnerLease`, `LifecycleJournalV1`, `ResourceControl`, Rust `AdditionalScopeRequest`/`PreparedAdditionalScope` and prepare/verify/thaw methods, acknowledged lower-actor integration, tracked compensation jobs, and one RC-LIVE-02 outcome consumed by Task 17 as exactly one row with `leftovers:[]`. Tasks 9–12 consume these lifecycle/compensation contracts; Task 16 reconciles them.

- [ ] **RED:** Independently encode every Task-7 lifecycle outcome plus RAII drop only enqueues compensation, tracked compensation joins, cleanup can remain ambiguous/retryable, controller generation invalidation, and shutdown closes admission. Rust additional-scope tests require adopted-generation validation, whole-leaf freeze and readback before returning wrapped argv, existing-member pinning, blocked-scope verification, commit-gated thaw, and no wrapper/spawn on stale identity or failed freeze/readback.

```rust
#[tokio::test]
async fn dropped_prepared_lease_is_not_clean_until_supervised_compensation_acks() {
    let journal = JournalFixture::new();
    let supervisor = SupervisorFixture::new();
    let lease = PreparedLeaseFixture::persisted(&journal).await;
    let lease_id = lease.lease_id;
    drop(lease);
    assert_eq!(journal.state(lease_id).await, OwnerLifecycleState::Compensating);
    supervisor.join_all().await.unwrap();
    assert_eq!(journal.state(lease_id).await, OwnerLifecycleState::Clean);
    assert_eq!(journal.pending_steps(lease_id).await, 0);
}
```

- [ ] Run before implementation:

```bash
cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-resource-control
```

Expected: FAIL because the production Rust controller/journal integration is absent.

- [ ] Implement independent argv-safe CLI/cgroupfs mechanics, exact normalization, journal/reconcile, and supervised compensation through lower actor ports. `Drop` may enqueue work but may not erase identity or claim async cleanup.

```rust
async fn prepare_owner_lease(
    &self,
    admission: ContainedAdmission,
    recipe: OwnerRecipeV1,
) -> Result<PreparedOwnerLease, ControlError> {
    let mut lease = self.lifecycle.claim(admission, recipe)?;
    self.journal.replace(&lease).await?;
    self.systemd.ensure_aggregate_and_leaf(&lease).await?;
    self.systemd.assert_exact_raw_readback(&lease).await?;
    self.systemd.set_oom_group_and_freeze_empty_leaf(&lease).await?;
    lease.lifecycle = OwnerLifecycleState::Prepared;
    self.journal.replace(&lease).await?;
    Ok(lease)
}

async fn prepare_additional_scope(
    &self,
    request: AdditionalScopeRequest,
) -> Result<PreparedAdditionalScope, ControlError> {
    let lease = self.journal.require_adopted_lease(request.lease_id, request.generation).await?;
    self.systemd.assert_members_exactly(&lease.leaf, &request.expected_existing_members).await?;
    self.systemd.freeze_leaf_and_wait(&lease.leaf, self.deadlines.freeze).await?;
    let frozen_readback = self.systemd.read_and_require_frozen(&lease.leaf).await?;
    self.journal.replace_additional_scope(&lease, &request, AdditionalScopeState::PreparedFrozen).await?;
    Ok(PreparedAdditionalScope::new(request, lease, frozen_readback))
}

async fn verify_additional_scope(
    &self,
    prepared: &PreparedAdditionalScope,
    members: &[ProcessIdentity],
) -> Result<(), ControlError> {
    self.systemd.require_still_frozen(prepared).await?;
    self.systemd.require_blocked_scope_members(&prepared.request.scope_token, members).await?;
    self.systemd.assert_exact_raw_readback(&prepared.lease).await
}

async fn thaw_additional_scope_after_commit(&self, prepared: PreparedAdditionalScope) -> Result<(), ControlError> {
    self.journal.require_additional_scope_state(&prepared.request.scope_token, AdditionalScopeState::Committed).await?;
    self.systemd.thaw_leaf_and_wait(&prepared.lease.leaf, self.deadlines.thaw).await
}
```

- [ ] **GREEN:** Re-run the crate command. Expected: PASS with independent fixtures and joined jobs.
- [ ] **Evidence gate RC-LIVE-02:** After explicit approval and isolation, run:

```bash
cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-resource-control --test live_systemd -- --ignored --nocapture
```

Expected: PASS independently for real topology/readback/attach/freeze/thaw/population/revert/reconcile, truthful cleanup, joined work, and zero survivors, producing exactly one RC-LIVE-02 row with `leftovers:[]`. Skip/unavailable/failure produces no PASS row and blocks commit.

**Commit:**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add crates/freshell-resource-control/src/controller.rs crates/freshell-resource-control/src/systemd.rs crates/freshell-resource-control/src/journal.rs crates/freshell-resource-control/src/lifecycle.rs crates/freshell-resource-control/src/supervisor.rs crates/freshell-resource-control/src/lib.rs crates/freshell-server/src/main.rs crates/freshell-resource-control/tests/systemd.rs crates/freshell-resource-control/tests/lifecycle.rs crates/freshell-resource-control/tests/reconcile.rs crates/freshell-resource-control/tests/live_systemd.rs
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit -F - <<'EOF'
feat(rust): add verified transactional systemd controller

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
```

### Task 9: Enforce the mandatory launch broker, inventory, execution domains, and staged PTYs

**Files:**
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control/spawn-broker.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/extension-manifest.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/terminal-registry.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/index.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/ws-handler.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/agent-api/router.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/coding-cli/session-manager.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src/launch.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-terminal/src/registry.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-terminal/src/pty.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-ws/src/lib.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-ws/src/terminal.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-freshagent/src/lib.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-freshagent/src/terminal_tabs.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-terminal/Cargo.toml`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-ws/Cargo.toml`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-freshagent/Cargo.toml`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/Cargo.toml`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.lock`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/unit/server/terminal-resource-control.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/unit/server/resource-control-spawn-architecture.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/tests/launch_architecture.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/tests/trybuild/raw_spawn_forbidden.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/tests/trybuild/raw_spawn_forbidden.stderr`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/integration/real/resource-control-node-owners.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-terminal/tests/live_resource_control_pty.rs`

**Interfaces:** consumes `ExecutionDomain`, `OwnerKind`, `LaunchTarget`, `LaunchAdmission`, `TerminalOwnerRecipeV1`, `PreparedOwnerLease`, `OwnerLifecycleState`, `CompensationStep`, `StepOutcome`, and canonical `EvidenceRowV1`; produces mandatory `SpawnBroker`, provisional PTY registrations, `WrappedArgv`, `NativeExit`, readiness acknowledgements, TypeScript AST/Rust `syn` enforcement results, and one outcome each for RC-LIVE-03/04, consumed by Task 17 as one row per ID with `leftovers:[]`.

The complete current inventory is normative:

| Root/ingress | ExecutionDomain | OwnerKind | Broker adapter | Evidence |
|---|---|---|---|---|
| Five Node PTY ingress paths | typed managed or ordinary | pty | Node PTY adapter | RC-LIVE-03 |
| Node recovery PTY | localLinuxManaged | pty | Node recovery adapter | RC-LIVE-03 |
| Node `codingcli.create` | localLinuxManaged | pty | codingcli adapter | RC-LIVE-03 |
| Rust WS PTY | typed managed or ordinary | pty | Rust terminal adapter | RC-LIVE-04 |
| Rust REST PTY | typed managed or ordinary | pty | Rust terminal adapter | RC-LIVE-04 |
| Rust recovery/auto-respawn | localLinuxManaged | pty | Rust recovery adapter | RC-LIVE-04/15 |
| Managed Codex sidecar+PTY | localLinuxManaged | pairedGeneration | Task-10 pair adapter | RC-LIVE-05/06 |
| Fresh Claude/Kilroy | localLinuxManaged | perSessionRoot | Task-11 SDK adapter | RC-LIVE-07 |
| Fresh Codex | localLinuxManaged | perSessionRoot | Task-11 native adapter | RC-LIVE-08/09 |
| Shared OpenCode | localLinuxManaged | sharedService | Task-12 service adapter | RC-LIVE-10/11 |
| OpenCode catalog probe | controlPlaneProbe | perSessionRoot | excluded probe adapter | negative gate |
| Claude discovery probe | controlPlaneProbe | perSessionRoot | excluded probe adapter | negative gate |
| Ordinary shell | ordinaryShell | pty | explicit uncontained adapter | PTY regression |
| Windows interop | windowsInterop | owner-specific | explicit uncontained adapter | provenance test |
| External manager | externalManager | owner-specific | explicit uncontained adapter | provenance test |

- [ ] **RED:** Registration without domain/adapter fails; enabled managed launch with missing control plane denies; no `.exe`/basename classification; ordinary/external/probe exclusions; provisional PTY has no inventory/activity/output; exact transaction order; close/cancel at every boundary; late generation exit ignored; `codingcli.create` covered; TypeScript AST and Rust `syn`/negative compile raw-spawn gates. Add workspace-pinned `syn = { version = "2.0", features = ["full", "visit"] }` and `trybuild = "1.0"`, consume both as `dev-dependencies` in `freshell-resource-control`, update `Cargo.lock`, and check in the Rust-1.96-generated `raw_spawn_forbidden.stderr` baseline before running RED.

```ts
expect(eventsFor(stagedPty)).toEqual([])
expect(spawnOrder).toEqual([
  'claim','prepare','frozen','stage','verify','commit','thaw','ready','publish',
])
```

- [ ] Run focused routing/architecture tests before implementation:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/terminal-resource-control.test.ts \
  test/unit/server/resource-control-spawn-architecture.test.ts \
  --config config/vitest/vitest.server.config.ts --run
cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-terminal -p freshell-ws launch
cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  --locked -p freshell-resource-control --test launch_architecture
```

Expected: FAIL: the Node gate reports uncovered/direct owner spawns or premature publication, and the Rust gate reports each nonallowlisted raw constructor with file/line or a compile-fail baseline mismatch. A zero-test trybuild run, missing dependency/lock entry, missing `.stderr`, stale allowlist entry, or unexpectedly compiling bypass fixture is a failure.

- [ ] Implement mandatory typed broker/provisional registries while preserving every owner option. During migration, the raw-spawn allowlist contains only exact owner files assigned to Tasks 10–12; the `syn` visitor rejects stale/absent allowlist entries and every owner task removes its entries. Add the pinned workspace dependencies and crate dev-dependencies in this task only, regenerate `Cargo.lock`, and keep the Rust-1.96 `trybuild` stderr baseline exact.

```ts
export async function launchThroughBroker(request: BrokerRequest): Promise<PublishedOwner> {
  const admission = await actor.beginLaunch(request.commandId, request.domain, request.target)
  if (request.domain === 'localLinuxManaged' && limits.enabled && admission.mode !== 'contained') {
    throw new LaunchDenied(admission)
  }
  if (admission.mode !== 'contained') return request.owner.spawnUncontained(admission)
  const lease = await controller.prepareOwnerLease(admission, request.recipe)
  const staged = await request.owner.stage(controller.wrapProcess(lease, request.role, request.argv))
  await controller.verifyBlockedMembers(lease, staged.members)
  await actor.commitLaunch(lease.leaseId, lease.generation)
  await controller.thawCommittedLease(lease.leaseId, lease.generation)
  await staged.awaitReadiness()
  return request.owner.publish(staged, lease)
}
```

The Rust architecture test is exact and independent of the TypeScript test:

```rust
const RAW_CONSTRUCTORS: &[&str] = &[
    "std::process::Command::new",
    "tokio::process::Command::new",
    "portable_pty::CommandBuilder::new",
    "portable_pty::native_pty_system",
];
const MIGRATION_ALLOWLIST: &[&str] = &[
    "crates/freshell-codex/src/launch_plan.rs",
    "crates/freshell-freshagent/src/claude.rs",
    "crates/freshell-freshagent/src/codex.rs",
    "crates/freshell-opencode/src/serve.rs",
];

#[test]
fn production_spawn_roots_require_broker_adapters() {
    let files = rust_source_files_under_workspace_crates_src();
    let mut violations = Vec::new();
    let mut exercised_allowlist = BTreeSet::new();
    for file in files {
        let syntax = syn::parse_file(&std::fs::read_to_string(&file).unwrap()).unwrap();
        let aliases = ImportAliases::collect(&syntax);
        let calls = RawSpawnVisitor::new(&aliases, RAW_CONSTRUCTORS).collect(&syntax);
        if calls.is_empty() { continue; }
        let relative = workspace_relative(&file);
        if MIGRATION_ALLOWLIST.contains(&relative.as_str()) {
            exercised_allowlist.insert(relative);
        } else if !is_exact_broker_or_adapter_infrastructure(&relative) {
            violations.extend(calls.into_iter().map(|call| (relative.clone(), call)));
        }
    }
    assert_eq!(exercised_allowlist, MIGRATION_ALLOWLIST.iter().map(ToString::to_string).collect());
    assert!(violations.is_empty(), "raw managed spawn roots: {violations:#?}");
}

#[test]
fn broker_authority_is_not_constructible_by_owner_crates() {
    trybuild::TestCases::new().compile_fail("tests/trybuild/raw_spawn_forbidden.rs");
}
```

The compile-fail fixture is exact:

```rust
use freshell_resource_control::launch::{spawn_managed, ManagedSpawnAuthority};

struct OwnerAuthority;
impl ManagedSpawnAuthority for OwnerAuthority {}

fn main() {
    spawn_managed(&OwnerAuthority, "owner", &["agent"]).unwrap();
}
```

`raw_spawn_forbidden.stderr` is generated and reviewed under `cargo +1.96.0`; it must contain the `OwnerAuthority: launch::sealed::Sealed` unsatisfied-bound diagnostic at the `impl ManagedSpawnAuthority` line and no unrelated warning/error. Any Rust-1.96 diagnostic drift fails trybuild and requires an explicit baseline review in this task, never `TRYBUILD=overwrite` in CI.

`RawSpawnVisitor` canonicalizes `use` aliases and fully qualified call paths, records file/line/constructor, skips `target`, tests, generated files, and comments, rejects any nonempty stale allowlist entry, and permits raw constructors only in the exact broker/adapter infrastructure predicate. `raw_spawn_forbidden.rs` attempts to implement the private sealed `ManagedSpawnAuthority` and call `spawn_managed` without a broker-issued authority; `raw_spawn_forbidden.stderr` is the checked Rust-1.96 diagnostic proving the sealed-trait bound cannot be satisfied. RED fails on current raw owner roots or a mismatched `.stderr`; GREEN requires both the AST scan and compile-fail baseline to pass.

- [ ] **GREEN:** Run the complete pre-commit gate literally:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/terminal-resource-control.test.ts \
  test/unit/server/resource-control-spawn-architecture.test.ts \
  --config config/vitest/vitest.server.config.ts --run
cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-terminal -p freshell-ws launch
cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  --locked -p freshell-resource-control --test launch_architecture
```

Expected: PASS with at least the AST and trybuild tests discovered, the Rust-1.96 `.stderr` baseline exact, dependencies resolved only from `Cargo.lock`, every nonallowlisted production raw constructor rejected, every migration allowlist entry exercised, and only exact Task-10–12 migration entries remaining before commit.
- [ ] **Evidence gates RC-LIVE-03/04:** After explicit approval and isolation, run:

```bash
FRESHELL_RUN_REAL_RESOURCE_CONTROL=1 \
  npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/integration/real/resource-control-node-owners.test.ts \
  --config config/vitest/vitest.server.config.ts --run -t "node-pty|codingcli"

cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-terminal --test live_resource_control_pty -- --ignored --nocapture
```

Expected: PASS for spaces/empty args, cwd, env, isatty, byte I/O, resize, cancellation, descendants, readiness, membership, provisional publication, truthful exit, cleanup, and zero survivors. The two commands produce exactly one RC-LIVE-03 row and one RC-LIVE-04 row, each with `leftovers:[]`; either absent cell blocks commit.

**Commit:**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add server/resource-control/spawn-broker.ts server/extension-manifest.ts server/terminal-registry.ts server/index.ts server/ws-handler.ts server/agent-api/router.ts server/coding-cli/session-manager.ts crates/freshell-resource-control/src/launch.rs crates/freshell-terminal/src/registry.rs crates/freshell-terminal/src/pty.rs crates/freshell-ws/src/lib.rs crates/freshell-ws/src/terminal.rs crates/freshell-freshagent/src/lib.rs crates/freshell-freshagent/src/terminal_tabs.rs crates/freshell-terminal/Cargo.toml crates/freshell-ws/Cargo.toml crates/freshell-freshagent/Cargo.toml crates/freshell-resource-control/Cargo.toml Cargo.toml Cargo.lock test/unit/server/terminal-resource-control.test.ts test/unit/server/resource-control-spawn-architecture.test.ts crates/freshell-resource-control/tests/launch_architecture.rs crates/freshell-resource-control/tests/trybuild/raw_spawn_forbidden.rs crates/freshell-resource-control/tests/trybuild/raw_spawn_forbidden.stderr test/integration/real/resource-control-node-owners.test.ts crates/freshell-terminal/tests/live_resource_control_pty.rs
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit -F - <<'EOF'
feat(agent-launch): broker and stage all managed PTY roots

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
```

### Task 10: Own managed Codex joint generations and retained adoption

**Files:**
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/coding-cli/codex-app-server/runtime.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/coding-cli/codex-app-server/launch-planner.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/terminal-registry.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/ws-handler.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/agent-api/router.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-codex/src/launch_plan.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-codex/src/launch_lifecycle.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-codex/src/sidecar_store.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-ws/src/terminal.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-freshagent/src/codex.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/unit/server/codex-resource-control.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/server/agent-tabs-write.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-codex/tests/resource_containment.rs`

**Interfaces:** consumes `ManagedCodexOwnerRecipeV1`, `PreparedOwnerLease`, `AdditionalScopeRequest`, `PreparedAdditionalScope`, controller `prepareAdditionalScope()`/`verifyAdditionalScope()`/`thawAdditionalScopeAfterCommit()` (and Rust equivalents), `OwnerLifecycleState`, `CompensationStep`, `StepOutcome`, `WrappedArgv`, `NativeExit`, and canonical `EvidenceRowV1`; produces paired-generation joint commit, `retainedAdoptable`, validated adoption, explicit-resume recovery PTY scope, `interrupted` disposition, and one outcome each for RC-LIVE-05/06, consumed by Task 17 as one row per ID with `leftovers:[]`.

- [ ] **RED:** Both scopes required; partial start compensates both; active shutdown transfers retained/adoptable; quiescent shutdown releases; explicit stop marks interrupted; startup validates PID/starttime/cmdline/cgroup; incompatible backend retires before admission; late G1 callback cannot mutate G2; pause suppresses timers; adopted active-turn state creates no PTY automatically; explicit resume claims/persists the scope token, calls controller `prepareAdditionalScope`, validates the adopted lease/generation and existing sidecar identity, freezes the whole leaf, waits for/readbacks `frozen=1`, obtains wrapped argv only after that barrier, stages the blocked recovery scope, verifies blocked membership/readback, commits, thaws, readies, and publishes exactly one recovery PTY scope in the same generation. Tests assert exact event order, no child call before prepare/readback/freeze, sidecar progress stops while frozen, stale-generation/freeze failure starts no child, and every cancellation boundary compensates then safely thaws the retained sidecar.

```ts
expect(await commitPair({ sidecar: 'verified', pty: 'missing' })).toMatchObject({
  state: 'compensating',
})
expect(lateExit('G1', stateAt('G2'))).toEqual(stateAt('G2'))
expect(await explicitResumeEventOrder()).toEqual([
  'claim-scope','persist-token','prepare-additional-scope','validate-generation',
  'freeze-leaf','readback-frozen','pin-existing-sidecar','return-wrapped-argv',
  'stage-blocked-scope','verify-members','verify-readback','commit-scope',
  'thaw-leaf','ready','publish',
])
expect(childCallsBefore('readback-frozen')).toBe(0)
```

- [ ] Run focused tests before implementation:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/codex-resource-control.test.ts test/server/agent-tabs-write.test.ts \
  --config config/vitest/vitest.server.config.ts --run
cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-codex -p freshell-ws -p freshell-freshagent resource_containment
```

Expected: FAIL because paired ownership/retention/adoption is absent.

- [ ] Implement one recipe/generation/leaf with two frozen verified scopes, joint commit, exact retention identity, compatible adoption, explicit-resume recovery PTY, incompatible retirement before admission, and interrupted active work without transparent continuation. Remove all Codex raw-spawn migration entries.

```ts
async function resumeAdoptedCodex(owner: AdoptedCodexOwner): Promise<PublishedPty> {
  if (!owner.userRequestedResume) throw new OwnerError('EXPLICIT_RESUME_REQUIRED')
  const claim = await actor.claimAdditionalScope({
    leaseId: owner.lease.leaseId,
    generation: owner.generation,
    role: 'codex-recovery-pty',
  })
  await journal.replace(owner.withProvisionalScope(claim.scopeToken))
  const prepared = await controller.prepareAdditionalScope({
    leaseId: owner.lease.leaseId,
    generation: owner.generation,
    scopeToken: claim.scopeToken,
    role: 'codex-recovery-pty',
    expectedExistingMembers: owner.adoptedSidecarIdentities,
  })
  const staged = await owner.stageRecoveryPty(prepared.wrap(owner.recoveryArgv))
  await controller.verifyAdditionalScope(prepared, staged.members)
  await actor.commitAdditionalScope(claim.operationToken, claim.scopeToken)
  await controller.thawAdditionalScopeAfterCommit(prepared)
  await staged.awaitReadiness()
  return owner.publishRecoveryPty(staged)
}
```

Rust uses the same explicit controller sequence and returns no child handle before preparation succeeds:

```rust
async fn resume_adopted_codex(owner: &mut AdoptedCodexOwner) -> Result<PublishedPty, OwnerError> {
    owner.require_explicit_resume()?;
    let claim = owner.actor.claim_additional_scope(owner.lease_id, owner.generation, "codex-recovery-pty").await?;
    owner.journal.persist_provisional_scope(&claim).await?;
    let prepared = owner.controller.prepare_additional_scope(AdditionalScopeRequest {
        lease_id: owner.lease_id,
        generation: owner.generation,
        scope_token: claim.scope_token.clone(),
        role: "codex-recovery-pty".into(),
        expected_existing_members: owner.adopted_sidecar_identities.clone(),
    }).await?;
    let staged = owner.stage_recovery_pty(prepared.wrap(&owner.recovery_argv)?).await?;
    owner.controller.verify_additional_scope(&prepared, &staged.members).await?;
    owner.actor.commit_additional_scope(claim.operation_token, &claim.scope_token).await?;
    owner.controller.thaw_additional_scope_after_commit(prepared).await?;
    staged.await_readiness().await?;
    owner.publish_recovery_pty(staged)
}
```

- [ ] **GREEN:** Re-run both focused commands. Expected: PASS including no automatic PTY on adoption, controller prepare/frozen readback before any child call, blocked attachment/verification before commit, sidecar-safe thaw only after durable commit, and exactly one recovery PTY on explicit resume in both Node and Rust owner tests.
- [ ] **Evidence gates RC-LIVE-05/06:** After explicit approval and isolation, run:

```bash
# RC-LIVE-05: Node managed Codex pair
FRESHELL_RUN_REAL_RESOURCE_CONTROL=1 \
  npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/integration/real/resource-control-node-owners.test.ts \
  --config config/vitest/vitest.server.config.ts --run -t "managed Codex"

# RC-LIVE-06: Rust managed Codex pair
cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-codex --test live_resource_control -- --ignored --nocapture
```

Expected: PASS for two scopes/one leaf, joint commit, stop, retained adoption, no automatic recovery spawn, explicit-resume recovery PTY as one newly verified scope in the adopted generation, joined Rust worker, and zero leftovers. The commands produce exactly one RC-LIVE-05 row and one RC-LIVE-06 row with `leftovers:[]`; both cells are mandatory before commit.

**Commit:**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add server/coding-cli/codex-app-server/runtime.ts server/coding-cli/codex-app-server/launch-planner.ts server/terminal-registry.ts server/ws-handler.ts server/agent-api/router.ts crates/freshell-codex/src/launch_plan.rs crates/freshell-codex/src/launch_lifecycle.rs crates/freshell-codex/src/sidecar_store.rs crates/freshell-ws/src/terminal.rs crates/freshell-freshagent/src/codex.rs test/unit/server/codex-resource-control.test.ts test/server/agent-tabs-write.test.ts crates/freshell-codex/tests/resource_containment.rs
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit -F - <<'EOF'
feat(codex): own joint contained generations and retained adoption

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
```

### Task 11: Prepare Fresh Claude/Kilroy and Fresh Codex roots transactionally

**Files:**
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/fresh-agent/runtime-adapter.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/agent-api/layout-store.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/agent-api/layout-schema.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/sdk-bridge.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/fresh-agent/adapters/claude/adapter.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/fresh-agent/adapters/codex/adapter.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-freshagent/src/lib.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-freshagent/src/claude.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-freshagent/src/codex.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/unit/server/fresh-agent/resource-control.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/unit/server/sdk-bridge.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-freshagent/tests/resource_containment.rs`

**Interfaces:** consumes `FreshOwnerRecipeV1`, `LaunchTarget`, `PreparedOwnerLease`, `OwnerLifecycleState`, `CompensationStep`, `StepOutcome`, `WrappedArgv`, `NativeExit`, and canonical `EvidenceRowV1`; produces authoritative pane claim/tombstone, SDK pre-spawn hook, native-child owner, generation-tagged internal failure, and exactly one outcome each for RC-LIVE-07/08/09. RC-LIVE-07/08 share the exact combined Node invocation; Task 17 still emits one row per ID with `leftovers:[]`.

- [ ] **RED:** Duplicate request/content claim; close/swap/replace tombstone during prepare; SDK hook only after frozen preparation; no provider query before actor commit/thaw; full recipe roundtrip; stale recipe denial; native exit shape; cancellation compensation; pause-generation timer suppression.

```ts
expect(providerQueriesBefore('actor-commit')).toBe(0)
expect(await claimSameContentTwice()).toEqual(['claimed', 'RESOURCE_TARGET_STALE'])
```

- [ ] Run before implementation:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/fresh-agent/resource-control.test.ts \
  test/unit/server/sdk-bridge.test.ts \
  --config config/vitest/vitest.server.config.ts --run
cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-freshagent resource_containment
```

Expected: FAIL because SDK/native roots bypass prepared ownership and authoritative pane claims.

- [ ] Implement complete recipes, actor-authoritative claims/tombstones, frozen SDK hook/native child, readiness/native exit/cancellation, and pause-generation checks. Remove these owners from migration allowlists. Do not modify protocol files.

```ts
async function startFreshOwner(claim: PaneClaim, recipe: FreshOwnerRecipeV1): Promise<void> {
  const admission = await actor.beginLaunch(claim.commandId, 'localLinuxManaged', recipe.target)
  if (admission.mode !== 'contained') throw new LaunchDenied(admission)
  const lease = await controller.prepareOwnerLease(admission, recipe)
  const child = await adapter.stageFrozenChild(controller.wrapProcess(lease, recipe.provider, [recipe.file, ...recipe.args]))
  await controller.verifyBlockedMembers(lease, child.members)
  await actor.commitLaunch(lease.leaseId, lease.generation)
  await controller.thawCommittedLease(lease.leaseId, lease.generation)
  await child.awaitReadiness()
  await layout.publishIfClaimCurrent(claim, child, lease)
}
```

- [ ] **GREEN:** Re-run both focused commands. Expected: PASS.
- [ ] **Evidence gates RC-LIVE-07/08/09:** After explicit approval and isolation, run:

```bash
# RC-LIVE-07 and RC-LIVE-08: Node SDK + Fresh Codex
FRESHELL_RUN_REAL_RESOURCE_CONTROL=1 \
  npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/integration/real/resource-control-node-owners.test.ts \
  --config config/vitest/vitest.server.config.ts --run -t "Claude SDK|Fresh Codex"

# RC-LIVE-09: Rust fresh child
cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-freshagent --test live_resource_control -- --ignored --nocapture
```

Expected: PASS with exactly one unique manifest row for each of RC-LIVE-07, RC-LIVE-08, and RC-LIVE-09, each using `leftovers:[]`, proving real hook/native child readiness/cancel/exit/membership/cleanup. The one exact combined Node invocation is recorded verbatim in both RC-LIVE-07 and RC-LIVE-08 rows only after both selected tests pass; the exact Rust invocation is recorded in RC-LIVE-09. Existing provider-contract fixtures are additional semantic inputs, not substitutes. All three cells are mandatory.

**Commit:**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add server/fresh-agent/runtime-adapter.ts server/agent-api/layout-store.ts server/agent-api/layout-schema.ts server/sdk-bridge.ts server/fresh-agent/adapters/claude/adapter.ts server/fresh-agent/adapters/codex/adapter.ts crates/freshell-freshagent/src/lib.rs crates/freshell-freshagent/src/claude.rs crates/freshell-freshagent/src/codex.rs test/unit/server/fresh-agent/resource-control.test.ts test/unit/server/sdk-bridge.test.ts crates/freshell-freshagent/tests/resource_containment.rs
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit -F - <<'EOF'
feat(fresh-agent): transact prepared roots with durable launch claims

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
```

### Task 12: Supervise OpenCode generations and attachment handoff

**Files:**
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/fresh-agent/adapters/opencode/serve-manager.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/fresh-agent/adapters/opencode/adapter.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-opencode/src/serve.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-opencode/src/transport.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-freshagent/src/lib.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-freshagent/src/opencode_ws.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-opencode/Cargo.toml`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-freshagent/Cargo.toml`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/unit/server/fresh-agent/opencode-serve-manager.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-opencode/tests/resource_containment.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/unit/server/resource-control-spawn-architecture.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/tests/launch_architecture.rs`

**Interfaces:** consumes `OpenCodeOwnerRecipeV1`, `PreparedOwnerLease`, `OwnerLifecycleState`, `CompensationStep`, `StepOutcome`, `MemberRevision`, `NativeExit`, and canonical `EvidenceRowV1`; produces immutable service generation, generation-tagged watcher, durable attachment records, compare-and-swap handoff, reopenable completed history, interrupted active-response state, and one outcome each for RC-LIVE-10/11, consumed by Task 17 as one row per ID with `leftovers:[]`.

- [ ] **RED:** Post-ready exit released once; late G1 cannot clear G2; dead running state never returned; every attachment rebinds once; attachments remain through handoff commit; pause timeout cannot replace; completed history remains reopenable after G1 loss/G2 replacement; interrupted active response never auto-continues and requires explicit restart; cap checked before attachment side effects.

```rust
assert_eq!(apply_exit(state_g2(), Exit { generation: 1 }), state_g2());
assert_eq!(rebind_counts(replace_g1_with_g2()), vec![1; member_count]);
```

- [ ] Run focused suites before implementation:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/fresh-agent/opencode-serve-manager.test.ts \
  test/unit/server/resource-control-spawn-architecture.test.ts \
  --config config/vitest/vitest.server.config.ts --run
cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-opencode -p freshell-freshagent resource_containment
```

Expected: FAIL because service/watcher/attachments are not generation-owned and raw owner spawns remain.

- [ ] Implement immutable service generation, truthful native wait, complete recipe/attachments, G2 commit → one CAS rebind/member → G1 retirement, pause gating, reopenable completed history, and interrupted-only active state. Remove final owner raw-spawn migration entries.

```ts
async function replaceOpenCodeService(previous: RunningServe, next: PreparedServe): Promise<void> {
  await actor.commitLaunch(next.leaseId, next.generation)
  await controller.thawCommittedLease(next.leaseId, next.generation)
  await next.awaitReadiness()
  for (const attachment of previous.attachments) {
    await layout.compareAndSwapAttachment(attachment.memberId, previous.generation, next.generation)
  }
  history.markCompletedSessionsReopenable(previous.generation)
  history.markActiveResponsesInterrupted(previous.generation)
  await retireGeneration(previous)
}
```

- [ ] Run the final architecture gates literally:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/resource-control-spawn-architecture.test.ts \
  --config config/vitest/vitest.server.config.ts --run
cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  --locked -p freshell-resource-control --test launch_architecture
```

Expected: PASS with broker/adapter infrastructure as the only raw-spawn allowance.
- [ ] **GREEN:** Re-run the focused commands and both exact architecture commands. Expected: PASS, completed history is reopenable, active response is interrupted, and raw-spawn allowlists contain broker/adapter infrastructure only.
- [ ] **Evidence gates RC-LIVE-10/11:** After explicit approval and isolation, run:

```bash
# RC-LIVE-10: Node shared OpenCode
FRESHELL_RUN_REAL_RESOURCE_CONTROL=1 \
  npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/integration/real/resource-control-node-owners.test.ts \
  --config config/vitest/vitest.server.config.ts --run -t "shared OpenCode"

# RC-LIVE-11: Rust shared OpenCode
cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-opencode --test live_resource_control -- --ignored --nocapture
```

Expected: PASS for generation loss, stale callback, all attachments, replacement, pause, reopenable completed history, interrupted active response with no automatic continuation, cleanup, and zero survivors. The commands produce exactly one RC-LIVE-10 row and one RC-LIVE-11 row with `leftovers:[]`; both cells are mandatory.

**Commit:**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add server/fresh-agent/adapters/opencode/serve-manager.ts server/fresh-agent/adapters/opencode/adapter.ts crates/freshell-opencode/src/serve.rs crates/freshell-opencode/src/transport.rs crates/freshell-freshagent/src/lib.rs crates/freshell-freshagent/src/opencode_ws.rs crates/freshell-opencode/Cargo.toml crates/freshell-freshagent/Cargo.toml test/unit/server/fresh-agent/opencode-serve-manager.test.ts crates/freshell-opencode/tests/resource_containment.rs test/unit/server/resource-control-spawn-architecture.test.ts crates/freshell-resource-control/tests/launch_architecture.rs
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit -F - <<'EOF'
feat(opencode): supervise service generations and attachment handoff

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
```

## Phase 4 — Protocol, Actions, Pressure, and Supervision

### Task 13: Land protocol v8 bounded projection atomically

**Files:**
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/shared/ws-protocol.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/shared/ws-version.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/src/store/resourceContainmentSlice.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-protocol/src/lib.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-protocol/src/common.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-protocol/src/server_messages.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-protocol/tests/version.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/port/contract/README.md`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/port/contract/ws-protocol.schema.json`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/port/contract/ws-server-messages.schema.json`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/port/contract/ws-message-inventory.json`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/port/oracle/fixtures/handshake-transcript.json`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/server/ws-tabs-registry.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/unit/port/oracle/external-handshake-t0.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/specs/freshagent-settings-resume-rust.spec.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/specs/terminal-activity-rust.spec.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/specs/amplifier-lane-resilience-rust.spec.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/specs/codex-status-completeness-rust.spec.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/specs/create-protection-isolation-rust.spec.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/specs/reconcile-handshake-rust.spec.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/specs/rest-spawn-gate-rust.spec.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/specs/leak-metrics.spec.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/helpers/ws-capture.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/port/machine/architecture-spec.md`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/port/machine/specs/terminal-core.md`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/port/machine/specs/coding-cli.md`
- Node/Rust sender adapters at `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/ws-handler.ts` and `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-ws/src/lib.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/unit/server/resource-control-snapshot.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/integration/server/resource-containment-mixed-version.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-protocol/tests/resource_containment_roundtrip.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/specs/resource-containment-mixed-version.spec.ts`

**Interfaces:** consumes `PendingSnapshot` and `GroupSnapshot`; produces protocol v8 `ResourceContainmentUpdated`, `ResourceContainmentFailure`, stream/revision acceptance, five-second replay, send-result close 4008, and mismatch close 4010.

- [ ] **RED:** Test stream/revision monotonicity; stale/duplicate/reorder rejection; reconnect reset; dropped final healed within five seconds; unsent→4008; maximum frame/count/byte caps; four mixed mismatch directions close 4010 before semantics; v8×v8 succeeds.

```ts
expect(reduceFrames([v8(3), v8(2), v8(3), v8(4)])).toEqual(snapshotAt(4))
expect(await mismatch('client7', 'server8')).toCloseWith(4010)
```

- [ ] Run focused tests before version change:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/resource-control-snapshot.test.ts \
  test/integration/server/resource-containment-mixed-version.test.ts \
  --config config/vitest/vitest.server.config.ts --run
cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-protocol
```

Expected: FAIL because v8 shapes, replay, send-result behavior, and mismatch contract are absent.

- [ ] Set both protocol constants to 8 before generation. Implement exact canonical shapes, caps, replay, sender result handling, reducer acceptance, independent Rust/TS literals, inventory discriminant, all active pins/T0/raw handshakes, and generated artifacts together. Do not rewrite historical captures or unrelated dated plans.

```ts
function publishProjection(next: Projection, now: MonotonicTick): void {
  const changed = !projectionEquals(next, currentProjection)
  if (changed) {
    currentProjection = next
    revision = checkedIncrement(revision)
  }
  if (!changed && now - lastFullReplay < 5_000) return
  const frame: ResourceContainmentUpdated = {
    type: 'resource.containment.updated',
    streamId,
    revision,
    settingsRevision: next.settingsRevision,
    pending: boundedPending(next.pending),
    snapshot: boundedSnapshot(next.snapshot),
  }
  const bytes = serializeOnce(frame)
  if (bytes.byteLength > 256 * 1024) throw new ProjectionError('RESOURCE_CONTAINMENT_CAPACITY')
  for (const client of authenticatedClients) {
    if (!client.trySend(bytes)) client.close(4008)
  }
  lastFullReplay = now
}
```

- [ ] Run the exact generate → stage → second generate → clean-diff → port-test sequence:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run contract:generate
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add \
  port/contract/README.md \
  port/contract/ws-protocol.schema.json \
  port/contract/ws-server-messages.schema.json \
  port/contract/ws-message-inventory.json
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run contract:generate
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment diff --exit-code -- port/contract
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:port
```

Expected: both generation commands exit 0, the post-second-generation `git diff --exit-code -- port/contract` exits 0, and `test:port` passes.
- [ ] **GREEN:** Re-run focused TS/Rust commands. Expected: PASS for all convergence, bounds, mixed-version, and v8×v8 cases.
- [ ] **Evidence gate:** Run the mixed-version browser spec in both projects:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment exec playwright test -- \
  --config /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/playwright.config.ts \
  --project=legacy-chromium --project=rust-chromium \
  /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/specs/resource-containment-mixed-version.spec.ts
```

Expected: PASS in both projects; any missing pin/generated artifact/browser cell blocks the atomic commit.

**Commit:**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add shared/ws-protocol.ts shared/ws-version.ts src/store/resourceContainmentSlice.ts crates/freshell-protocol/src/lib.rs crates/freshell-protocol/src/common.rs crates/freshell-protocol/src/server_messages.rs crates/freshell-protocol/tests/version.rs crates/freshell-protocol/tests/resource_containment_roundtrip.rs server/ws-handler.ts crates/freshell-ws/src/lib.rs port/contract/README.md port/contract/ws-protocol.schema.json port/contract/ws-server-messages.schema.json port/contract/ws-message-inventory.json port/oracle/fixtures/handshake-transcript.json test/server/ws-tabs-registry.test.ts test/unit/port/oracle/external-handshake-t0.test.ts test/e2e-browser/specs/freshagent-settings-resume-rust.spec.ts test/e2e-browser/specs/terminal-activity-rust.spec.ts test/e2e-browser/specs/amplifier-lane-resilience-rust.spec.ts test/e2e-browser/specs/codex-status-completeness-rust.spec.ts test/e2e-browser/specs/create-protection-isolation-rust.spec.ts test/e2e-browser/specs/reconcile-handshake-rust.spec.ts test/e2e-browser/specs/rest-spawn-gate-rust.spec.ts test/e2e-browser/specs/leak-metrics.spec.ts test/e2e-browser/helpers/ws-capture.ts port/machine/architecture-spec.md port/machine/specs/terminal-core.md port/machine/specs/coding-cli.md test/unit/server/resource-control-snapshot.test.ts test/integration/server/resource-containment-mixed-version.test.ts test/e2e-browser/specs/resource-containment-mixed-version.spec.ts
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit -F - <<'EOF'
feat(protocol)!: add v8 bounded containment snapshots

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
```

No earlier task may modify `shared/ws-protocol.ts`, protocol constants, or containment WebSocket state.

### Task 14: Add server lifecycle identity, sole resolution, secure actions, and UI

**Files:**
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control/control-plane.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control/router.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control/action-security.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control/audit.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/agent-api/layout-store.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/agent-api/layout-schema.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/agent-api/router.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/ws-handler.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/terminal-registry.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/fresh-agent/runtime-adapter.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/src/store/resourceContainmentSlice.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/src/store/paneTypes.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/src/store/layoutMirrorMiddleware.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/src/components/ResourceContainmentModal.tsx`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/src/components/TerminalView.tsx`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/src/components/fresh-agent/FreshAgentView.tsx`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/src/lib/fresh-agent-ws.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/src/App.tsx`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src/lifecycle.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-server/src/main.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-ws/src/lib.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/unit/server/resource-control-actions.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/unit/server/resource-control-router.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/unit/client/components/ResourceContainmentModal.test.tsx`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/unit/client/resource-containment-ui.test.tsx`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/specs/resource-containment-ui.spec.ts`

**Interfaces:** the UI produces a UUID `OperationId` per user intent and consumes server-issued `actionNonce`; server middleware/actor consume `OperationId`, `LaunchId`, `LaunchGeneration`, `PaneContentId`, `PaneRevision`, `TargetRevision`, `MemberRevision`, `ActionEnvelopeBase`, `ActionEnvelope`, and `ResourceContainmentFailure`; the server produces immutable `PendingSnapshot`/`GroupSnapshot`, rotated `actionNonce`, operation lease/durable result, `UncontainedPermit`, redacted audit, and sole-resolution UI state.

- [ ] **RED:** Close-before-commit/failure/pending; swap/replace; duplicate request/content; no generic Retry; pending only after clean compensation; header auth and cookie rejection; disallowed Origin and cross-site Fetch Metadata rejection; omitted Origin accepted only for a native client with header credentials; non-loopback request rejected without HTTPS/WSS or configured encrypted tunnel; JSON required; stale nonce/target/member/settings revision; nonce bound to action set + launch generation + target/member/settings revisions and rotated on every mutation; duplicate operation returns recorded result; concurrent different operation 409; only oldest terminal idempotency entries evicted; two restarts produce one replacement; post-commit response-loss replay; redacted audit; only-pane close→tab; shared attachment detach.

```ts
expect(await postAction({ ...valid, expectedRevision: old })).toMatchObject({
  status: 409,
  code: 'RESOURCE_TARGET_STALE',
})
expect(sideEffects()).toHaveLength(0)
expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
```

- [ ] Run focused tests before implementation:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/resource-control-actions.test.ts \
  test/unit/server/resource-control-router.test.ts \
  --config config/vitest/vitest.server.config.ts --run
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/client/components/ResourceContainmentModal.test.tsx \
  test/unit/client/resource-containment-ui.test.tsx \
  --config config/vitest/vitest.config.ts --run
cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-server -p freshell-ws resource_containment
```

Expected: FAIL because actions are not generation-authorized, idempotent, authenticated, or sole-resolution.

- [ ] Implement exact `ActionEnvelope`; server epoch/launch/generation/content/revisions; immutable pending; failure `retryable:false`; actor operation claim before await; single-use uncontained permit; full native-Origin/fetch/transport policy; durable idempotency with terminal-only eviction; nonce binding/rotation; redacted audit; exactly `launch_uncontained`, `disable_containment`, and `close_pane` pending choices.

```ts
async function executeAction(request: AuthenticatedActionRequest): Promise<ActionResult> {
  enforceHeaderToken(request)
  enforceNativeOrAllowedOrigin(request)
  enforceFetchMetadataJsonAndTrustedTransport(request)
  const envelope: ActionEnvelope = parseActionEnvelope(request.body)
  const claim = await actor.claimAction({
    operationId: envelope.operationId,
    nonce: envelope.actionNonce,
    targetRevision: envelope.expectedRevision,
    memberRevision: envelope.expectedMemberRevision,
    settingsRevision: envelope.kind === 'pending' ? envelope.expectedSettingsRevision : undefined,
  })
  if (claim.kind === 'replay') return claim.result
  const outcome = await runClaimedSideEffect(claim)
  return actor.completeAction(claim.leaseId, outcome, { evict: 'oldest-terminal-only' })
}
```

- [ ] **GREEN:** Re-run all focused commands. Expected: PASS with zero unauthorized/stale side effects, exact native-client Origin behavior, terminal-only idempotency eviction, full nonce binding, and no client-authored authoritative phase.
- [ ] **Evidence gate:** Run both real browser backend projects:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment exec playwright test -- \
  --config /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/playwright.config.ts \
  --project=legacy-chromium --project=rust-chromium \
  /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/specs/resource-containment-ui.spec.ts
```

Expected: PASS in both projects for close/swap/replace, sole resolution, idempotent action, and no generic Retry. Either skipped backend blocks commit.

**Commit:**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add server/resource-control/control-plane.ts server/resource-control/router.ts server/resource-control/action-security.ts server/resource-control/audit.ts server/agent-api/layout-store.ts server/agent-api/layout-schema.ts server/agent-api/router.ts server/ws-handler.ts server/terminal-registry.ts server/fresh-agent/runtime-adapter.ts src/store/resourceContainmentSlice.ts src/store/paneTypes.ts src/store/layoutMirrorMiddleware.ts src/components/ResourceContainmentModal.tsx src/components/TerminalView.tsx src/components/fresh-agent/FreshAgentView.tsx src/lib/fresh-agent-ws.ts src/App.tsx crates/freshell-resource-control/src/lifecycle.rs crates/freshell-server/src/main.rs crates/freshell-ws/src/lib.rs test/unit/server/resource-control-actions.test.ts test/unit/server/resource-control-router.test.ts test/unit/client/components/ResourceContainmentModal.test.tsx test/unit/client/resource-containment-ui.test.tsx test/e2e-browser/specs/resource-containment-ui.spec.ts
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit -F - <<'EOF'
feat(resource-control): add generation-authorized resolution and actions

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
```

### Task 15: Add bounded monotonic pressure, stable OOM, and paused escalation

**Files:**
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control/pressure-policy.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control/systemd.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control/control-plane.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/coding-cli/codex-app-server/runtime.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/fresh-agent/runtime-adapter.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/fresh-agent/adapters/opencode/serve-manager.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src/pressure.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src/systemd.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src/lifecycle.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-codex/src/launch_lifecycle.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-opencode/src/serve.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-freshagent/src/lib.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/src/components/ResourceContainmentModal.tsx`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/unit/server/resource-control-pressure.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/integration/server/resource-containment-scale.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/tests/pressure.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/helpers/resource-control-live.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/integration/real/resource-control-node-systemd.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/tests/live_systemd.rs`

**Interfaces:** consumes `StableObservation`, `PressureObservation`, `NativeExit`, launch/pause/member revisions, production `process.hrtime.bigint()`/`std::time::Instant`, `CurrentApprovedGateExecutionV1`, and canonical evidence/artifact types; produces the real single-flight monitor, policy transitions, local OOM/`ambiguous`, four sealed `ProductionProofArtifactV1` objects per RC-LIVE-12/13 execution, and `GateRunResultV1`. `createCurrentApprovedGateExecution` copies the signed `executionStartedAt`/`executionWindowEndsAt` into the immutable current-run context. `sealProductionProof` embeds those same fields with the approval scope, run/execution, VM digests, capability, exact command, proof timestamps, host/guest identity, result, and measurements before hashing. PASS requires byte-exact §9.1 commands, a complete gate-keyed proof-index mapping, true guest-PM evidence, and all real thresholds; the manifest remains the exact eleven-field flat row per gate.

- [ ] **RED:** Counter change→retry/ambiguous; leaf A OOM plus leaf B SIGKILL never attributes B; missing evidence; wall jump independence; suspend exclusion; no overlapping poll; overrun coalescing; read/action timeout; G=64/M=256/C=50; A=400 stable/B=300 stable/C=250 growing chooses C; next grower; no-growth largest; paused memory remains; every health/lazy/recovery path checks pause generation; escalation eligibility is exactly `(all effective freezes attempted) OR (a complete post-freeze comparison shows usage failed to decline)`; once either branch latches during a critical episode, later decline does not clear eligibility while aggregate pressure remains critical; then ten persistent monotonic seconds permit one stop; population-zero/final evidence precedes a complete reassessment and any fresh epoch; unknown suppresses respawn. Live RED additionally rejects an injected clock/observation/controller port, fewer than 64 real leaves, fewer than 100 real complete monitor cycles, `maxInFlight > 1`, either p99 budget exceeded, no post-freeze paused samples, no effective-victim reassessment, hypervisor pause substituted for guest PM suspend, absent forward/backward wall jump, missing or false `actualGuestPmSuspend`, omitted/invalid/mismatched `executionStartedAt` or `executionWindowEndsAt`, proof timestamps outside that signed current-run window, provenance absent from the artifact body, stale/foreign approval scope, reused run/execution ID or artifact hash, mismatched VM image/snapshot digest, capability, command text/digest, host/guest metadata or result, missing/wrong-backend proof-index entry/ref, or any unavailable/skipped real proof. Measurement and execution-window validation must fail before artifact hashing/writing.

```ts
expect(selectVictim([
  { id: 'A', growth: 0, total: 400 },
  { id: 'B', growth: 0, total: 300 },
  { id: 'C', growth: 25, total: 250 },
])).toBe('C')
expect(classifyOom({ leafA: { oomKill: 1 }, leafB: { signal: 'SIGKILL' } }).leafB).toBe('unknown')
expect(() => sealProductionProof(currentNodeRun, 'time-discontinuity',
  withoutKey(validTimeMeasurements, 'actualGuestPmSuspend') as TimeDiscontinuityProof,
  proofStart, proofEnd)).toThrow('release evidence gap')
expect(() => sealProductionProof(currentRustRun, 'time-discontinuity',
  { ...validTimeMeasurements, actualGuestPmSuspend: false }, proofStart, proofEnd))
  .toThrow('release evidence gap')
expect(() => createCurrentApprovedGateExecution(approvalWithout('executionStartedAt'), 'RC-LIVE-12', capturedNode))
  .toThrow('release evidence gap')
expect(() => createCurrentApprovedGateExecution(approvalWith({
  executionWindowEndsAt: beforeExecutionStart,
}), 'RC-LIVE-13', capturedRust)).toThrow('release evidence gap')
expect(() => sealProductionProof({
  ...currentNodeRun, executionStartedAt: afterProofStart,
}, 'maximum-scale-single-flight', validScaleMeasurements, proofStart, proofEnd))
  .toThrow('release evidence gap')
expect(() => sealProductionProof({
  ...currentRustRun, executionWindowEndsAt: beforeProofEnd,
}, 'time-discontinuity', validTimeMeasurements, proofStart, proofEnd))
  .toThrow('release evidence gap')
expect(productionProofIndex.writeCreateOnly).not.toHaveBeenCalled()
```

- [ ] Run focused tests before implementation:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/resource-control-pressure.test.ts \
  test/integration/server/resource-containment-scale.test.ts \
  --config config/vitest/vitest.server.config.ts --run
cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-resource-control pressure
```

Expected: FAIL because stable observation, monotonic deadlines, paused supervision, and iterative escalation are absent.

- [ ] Implement exact two-sample/retry observation, non-injected production monotonic clocks that exclude suspend, single-flight budgets/caps, 60-second warning/ten-second rearm, aggregate-critical ordering, paused polling, the exact latched OR prerequisite `(all effective freezes attempted) || usage failed to decline`, persistent-critical grace that clears only when critical pressure clears, ten-second one-victim epochs, pinned local OOM evidence, and no automatic respawn. Every owner timer consumes pause generation. Extend the exact selected Node `allocator efficacy` and Rust `allocator_efficacy` live cases—not their §9.1 commands—to call only the production monitor/controller against aggregate + 64 real leaf cgroups. Instrument production cycle start/end and actor acknowledgement events, not a replacement monitor/actor: collect at least 100 complete actor-acknowledged cycles, assert `maxInFlight === 1`, `maxConcurrentActorTurns === 1`, snapshot/reduce/serialize p99 <=500 ms, complete-cycle p99 <=750 ms, and no burst of missed ticks. Freeze and read back one real leaf, require that leaf in at least three subsequent stable production observations while frozen, then create growth in another real leaf, prove one effective-victim freeze, and require a next-complete-cycle usage/reassessment artifact. The exact leaf-OOM cases remain real local-counter proofs.

```ts
type LiveScaleMeasurements = {
  realAggregate: true
  realLeafCount: 64
  completeCycles: number
  maxInFlight: 1
  productionActor: true
  actorObservationAcks: number
  maxConcurrentActorTurns: 1
  snapshotReduceSerializeP99Ms: number
  completeCycleP99Ms: number
  missedTickBursts: 0
  effectiveVictim: { launchId: string; freezeCount: 1; reassessedNextCompleteCycle: true }
}
type LivePausedSamplingMeasurements = {
  launchId: string
  frozenReadback: true
  fromRealCgroupfs: true
  sampledCompleteCycles: number
  monitorStayedRunning: true
}
type LeafOomMeasurements = {
  fromRealCgroupfs: true
  classification: 'oom' | 'ambiguous'
  crossLeafAttribution: false
  localOomKillDelta: number
  localOomGroupKillDelta: number
}
type LiveAllocatorArtifacts = readonly [
  ProductionProofArtifactV1<'maximum-scale-single-flight', LiveScaleMeasurements>,
  ProductionProofArtifactV1<'real-paused-sampling', LivePausedSamplingMeasurements>,
]
type CurrentApprovedGateExecutionV1 = {
  approval: SignedApprovalV1
  gateId: RcPressureGateId
  backend: 'Node' | 'Rust'
  runId: string
  executionId: string
  executionStartedAt: string
  executionWindowEndsAt: string
  commandText: string
  commandSha256: Sha256Ref
  gitCommit: string
  host: ProofHostMetadataV1
  guest: ProofGuestMetadataV1
  capabilityFingerprint: CapabilityFingerprint
}

type CapturedGateEnvironmentV1 = {
  commandText: string
  gitCommit: string
  host: ProofHostMetadataV1
  guest: ProofGuestMetadataV1
  capabilityFingerprint: CapabilityFingerprint
}

function createCurrentApprovedGateExecution(
  approval: SignedApprovalV1,
  gateId: RcPressureGateId,
  captured: CapturedGateEnvironmentV1,
): CurrentApprovedGateExecutionV1 {
  verifyCurrentSignedApproval(approval, new Date())
  const scope = approvalScopeFor(approval, gateId)
  const executionStartedAt = parseRfc3339Utc(scope.executionStartedAt)
  const executionWindowEndsAt = parseRfc3339Utc(scope.executionWindowEndsAt)
  if (executionStartedAt < parseRfc3339Utc(approval.issuedAt) ||
      executionWindowEndsAt <= executionStartedAt ||
      executionWindowEndsAt > parseRfc3339Utc(approval.expiresAt)) {
    throw new EvidenceError('release evidence gap')
  }
  const commandSha256 = sha256Ref(Buffer.from(captured.commandText, 'utf8'))
  const execution = {
    approval, gateId, backend: scope.backend, runId: scope.runId,
    executionId: scope.executionId,
    executionStartedAt: scope.executionStartedAt,
    executionWindowEndsAt: scope.executionWindowEndsAt,
    commandText: captured.commandText, commandSha256, gitCommit: captured.gitCommit,
    host: captured.host, guest: captured.guest,
    capabilityFingerprint: captured.capabilityFingerprint,
  } satisfies CurrentApprovedGateExecutionV1
  if (scope.commandSha256 !== commandSha256 ||
      scope.vmImageDigest !== captured.guest.vmImageDigest ||
      scope.vmSnapshotDigest !== captured.guest.vmSnapshotDigest) {
    throw new EvidenceError('release evidence gap')
  }
  return Object.freeze(execution)
}

function approvalScopeFor(approval: SignedApprovalV1, gateId: RcPressureGateId): ApprovalScopeV1 {
  requireNonEmptyString(approval.approvalId)
  parseRfc3339Utc(approval.issuedAt)
  parseRfc3339Utc(approval.expiresAt)
  requireNonEmptyString(approval.signature)
  requireSha256Ref(approval.signatureSha256)
  if (approval.signatureSha256 !== sha256Ref(Buffer.from(approval.signature, 'utf8')) ||
      approval.scopes.length !== 2 ||
      !sameJson(approval.scopes.map(scope => scope.gateId).sort(), ['RC-LIVE-12','RC-LIVE-13'])) {
    throw new EvidenceError('release evidence gap')
  }
  const scope = approval.scopes.find(candidate => candidate.gateId === gateId)
  if (!scope) throw new EvidenceError('release evidence gap')
  return scope
}

function sealProductionProof<K extends ProductionProofKind, M extends object>(
  run: CurrentApprovedGateExecutionV1,
  kind: K,
  measurements: M,
  startedAt: string,
  endedAt: string,
): ProductionProofArtifactV1<K, M> {
  verifyCurrentSignedApproval(run.approval, new Date(endedAt))
  const approvalScope = approvalScopeFor(run.approval, run.gateId)
  assert.deepEqual(approvalScope, {
    gateId: run.gateId, backend: run.backend, runId: run.runId, executionId: run.executionId,
    executionStartedAt: run.executionStartedAt,
    executionWindowEndsAt: run.executionWindowEndsAt,
    commandSha256: run.commandSha256, vmImageDigest: run.guest.vmImageDigest,
    vmSnapshotDigest: run.guest.vmSnapshotDigest, proofKinds: RC_PRESSURE_PROOF_KINDS,
    destructiveResourceControl: true, timeDiscontinuity: true,
  })
  assert.equal(run.commandText, serializeCommandPlan(commandPlanFor(run.gateId)))
  assert.equal(run.commandSha256, sha256Ref(Buffer.from(run.commandText, 'utf8')))
  const start = parseRfc3339Utc(startedAt)
  const end = parseRfc3339Utc(endedAt)
  if (start < parseRfc3339Utc(run.approval.issuedAt) ||
      start < parseRfc3339Utc(run.executionStartedAt) ||
      end < start ||
      end > parseRfc3339Utc(run.approval.expiresAt) ||
      end > parseRfc3339Utc(run.executionWindowEndsAt)) {
    throw new EvidenceError('release evidence gap')
  }
  validateMeasurementsBeforeHash(kind, measurements, run.backend)
  const body: ProductionProofArtifactBodyV1<K, M> = {
    schemaVersion: 1, kind, gateId: run.gateId, backend: run.backend,
    approvalId: run.approval.approvalId, approvalScope,
    approvalSignatureSha256: run.approval.signatureSha256,
    runId: run.runId, executionId: run.executionId,
    executionStartedAt: run.executionStartedAt,
    executionWindowEndsAt: run.executionWindowEndsAt,
    commandText: run.commandText, commandSha256: run.commandSha256,
    gitCommit: run.gitCommit, startedAt, endedAt,
    host: run.host, guest: run.guest, capabilityFingerprint: run.capabilityFingerprint,
    source: 'production', fakeClockUsed: false, result: 'PASS', measurements,
  }
  const artifactHash = sha256Ref(Buffer.from(rfc8785CanonicalJson(body), 'utf8'))
  const artifact = { ...body, artifactHash } satisfies ProductionProofArtifactV1<K, M>
  productionProofIndex.writeCreateOnly(artifactHash, artifact)
  return artifact
}

function finishPressureGateProofEntry(
  execution: CurrentApprovedGateExecutionV1,
  passedCommands: readonly PassedCommand[],
  artifacts: readonly ProductionProofArtifactV1<ProductionProofKind, object>[],
  startedAt: string,
  endedAt: string,
): ProductionProofIndexEntryV1<RcPressureGateId> {
  const start = parseRfc3339Utc(startedAt)
  const end = parseRfc3339Utc(endedAt)
  if (start < parseRfc3339Utc(execution.executionStartedAt) ||
      end < start ||
      end > parseRfc3339Utc(execution.executionWindowEndsAt) ||
      artifacts.length !== 4 ||
      artifacts.some(artifact =>
        artifact.gateId !== execution.gateId ||
        artifact.runId !== execution.runId ||
        artifact.executionId !== execution.executionId ||
        artifact.executionStartedAt !== execution.executionStartedAt ||
        artifact.executionWindowEndsAt !== execution.executionWindowEndsAt)) {
    throw new EvidenceError('release evidence gap')
  }
  const run: GateRunResultV1<RcPressureGateId> = {
    gateId: execution.gateId, backend: execution.backend,
    approvalId: execution.approval.approvalId,
    approvalScope: approvalScopeFor(execution.approval, execution.gateId),
    runId: execution.runId, executionId: execution.executionId,
    executionStartedAt: execution.executionStartedAt,
    executionWindowEndsAt: execution.executionWindowEndsAt,
    gitCommit: execution.gitCommit, startedAt, endedAt,
    host: execution.host, guest: execution.guest,
    capabilityFingerprint: execution.capabilityFingerprint,
    passedCommands, result: 'PASS',
  }
  return {
    gateId: execution.gateId,
    run,
    artifactRefs: artifacts.map(artifact => artifact.artifactHash),
  }
}

async function proveRealScaleAndPausedSampling(
  run: CurrentApprovedGateExecutionV1,
  h: RealResourceControlHarness,
): Promise<LiveAllocatorArtifacts> {
  h.assertProductionPortsOnly()
  const startedAt = new Date().toISOString()
  const leaves = await h.createRealLeafCgroups(64)
  const monitor = h.startProductionMonitor({ cadenceMs: 1_000 })
  const baseline = await monitor.awaitCompleteCycles(100)
  assert.equal(baseline.maxInFlight, 1)
  assert.equal(baseline.productionActor, true)
  assert.ok(baseline.actorObservationAcks >= baseline.completeCycles)
  assert.equal(baseline.maxConcurrentActorTurns, 1)
  assert.ok(baseline.snapshotReduceSerializeP99Ms <= 500)
  assert.ok(baseline.completeCycleP99Ms <= 750)
  assert.equal(baseline.missedTickBursts, 0)
  const paused = await h.productionController.freezeAndReadBack(leaves[0])
  const pausedSamples = await monitor.awaitStableSamples(paused.launchId, 3)
  assert.ok(pausedSamples.every(sample => sample.frozen && sample.fromRealCgroupfs))
  const victim = await h.growRealLeaf(leaves[1])
  assert.deepEqual(await monitor.awaitEffectiveVictimFreeze(), { launchId: victim.launchId, freezeCount: 1 })
  assert.equal((await monitor.awaitNextCompleteReassessment()).completed, true)
  const endedAt = new Date().toISOString()
  return [
    sealProductionProof(run, 'maximum-scale-single-flight', {
      realAggregate: true, realLeafCount: 64, completeCycles: baseline.completeCycles,
      maxInFlight: 1, productionActor: true, actorObservationAcks: baseline.actorObservationAcks,
      maxConcurrentActorTurns: 1, snapshotReduceSerializeP99Ms: baseline.snapshotReduceSerializeP99Ms,
      completeCycleP99Ms: baseline.completeCycleP99Ms, missedTickBursts: 0,
      effectiveVictim: { launchId: victim.launchId, freezeCount: 1, reassessedNextCompleteCycle: true },
    }, startedAt, endedAt),
    sealProductionProof(run, 'real-paused-sampling', {
      launchId: paused.launchId, frozenReadback: true, fromRealCgroupfs: true,
      sampledCompleteCycles: pausedSamples.length, monitorStayedRunning: true,
    }, startedAt, endedAt),
  ]
}

function sealLeafOomProof(
  run: CurrentApprovedGateExecutionV1,
  observed: RealLeafOomObservation,
): ProductionProofArtifactV1<'leaf-local-oom-or-ambiguous', LeafOomMeasurements> {
  const measurements: LeafOomMeasurements = {
    fromRealCgroupfs: true,
    classification: observed.stableSameLeaf ? 'oom' : 'ambiguous',
    crossLeafAttribution: false,
    localOomKillDelta: observed.localOomKillDelta,
    localOomGroupKillDelta: observed.localOomGroupKillDelta,
  }
  return sealProductionProof(
    run, 'leaf-local-oom-or-ambiguous', measurements,
    observed.startedAt, observed.endedAt,
  )
}

function reducePressure(state: PressureState, sample: PressureObservation, now: SuspendExcludingTick): Decision[] {
  if (sample.kind === 'ambiguous') return []
  state.recordStable(sample)
  const decisions = reduceLeafWarningAndFreeze(state, sample, now)
  if (!state.aggregateCritical()) return decisions.concat(state.clearCriticalEpisode())
  const allEffectiveFreezesAttempted = state.allEffectiveFreezesAttempted()
  const usageFailedToDecline = state.hasCompletePostFreezeComparison()
    && !state.usageDeclinedAfterLastFreeze()
  if (!state.escalationEligibleThisCriticalEpisode()) {
    if (allEffectiveFreezesAttempted || usageFailedToDecline) {
      state.latchEscalationEligibility(now)
    } else {
      const nextUnpaused = state.nextEffectiveUnpausedVictim()
      return nextUnpaused
        ? decisions.concat({ kind: 'freeze', launchId: nextUnpaused.launchId })
        : decisions
    }
  }
  const grace = state.observePersistentCriticalGrace(now, 10_000)
  if (!grace.expired(now)) return decisions
  const paused = state.nextPausedVictim()
  return paused ? decisions.concat({ kind: 'stopAfterFinalEvidence', launchId: paused.launchId }) : decisions
}
```

- [ ] Implement the approval-gated real time-discontinuity subprotocol in `test/helpers/resource-control-live.ts`. It runs only against libvirt domain `freshell-rc-live-disposable` reverted to snapshot `systemd255-clean`; the VM uses a distinct UID/home/domain from the self-hosted server and must expose the libvirt guest agent plus restricted sudo for `timedatectl`/`date`. For each backend independently, launch the existing live test artifact with the production clock constructor and injection disabled, continuously sample wall and policy clocks, make an actual +3,600-second and -7,200-second guest wall-clock step, restore NTP, then execute guest power-management suspend with `virsh dompmsuspend ... mem --duration 12` (never `virsh suspend`). Record host elapsed time and post-resume samples. PASS requires `source:'production'`, clock source exactly `process.hrtime.bigint()` or `std::time::Instant`, `fakeClockUsed:false`, `actualGuestPmSuspend === true` populated from guest-agent-confirmed PM completion, the real production actor consuming the monitor observations, forward wall delta >=3,590,000 ms, backward wall delta <=-3,590,000 ms, host suspend elapsed >=12,000 ms, policy-clock suspend delta <=3,000 ms, zero actor phase transition or catch-up burst during excluded time, and a fresh actor-acknowledged complete production-monitor cycle after resume.

```ts
type TimeDiscontinuityProof = {
  clockSource: 'process.hrtime.bigint' | 'std::time::Instant'
  actualGuestPmSuspend: boolean
  productionActor: true
  actorPhaseTransitionsDuringExcludedTime: 0
  actorPostResumeObservationAck: true
  wallForwardDeltaMs: number
  wallBackwardDeltaMs: number
  hostSuspendElapsedMs: number
  policySuspendDeltaMs: number
  postResumeCompleteCycle: true
  catchUpBursts: 0
}

function requireScaleThresholds(scale: LiveScaleMeasurements): void {
  if (scale.realAggregate !== true || scale.realLeafCount !== 64 ||
      scale.completeCycles < 100 || scale.maxInFlight !== 1 ||
      scale.productionActor !== true || scale.actorObservationAcks < scale.completeCycles ||
      scale.maxConcurrentActorTurns !== 1 ||
      scale.snapshotReduceSerializeP99Ms > 500 || scale.completeCycleP99Ms > 750 ||
      scale.missedTickBursts !== 0 || scale.effectiveVictim.freezeCount !== 1 ||
      scale.effectiveVictim.reassessedNextCompleteCycle !== true) {
    throw new EvidenceError('release evidence gap')
  }
}
function requirePausedThresholds(paused: LivePausedSamplingMeasurements): void {
  if (paused.frozenReadback !== true || paused.fromRealCgroupfs !== true ||
      paused.sampledCompleteCycles < 3 || paused.monitorStayedRunning !== true) {
    throw new EvidenceError('release evidence gap')
  }
}
function requireLeafOomThresholds(oom: LeafOomMeasurements): void {
  if (oom.fromRealCgroupfs !== true || oom.crossLeafAttribution !== false ||
      !['oom','ambiguous'].includes(oom.classification) ||
      oom.localOomKillDelta < 0 || oom.localOomGroupKillDelta < 0 ||
      (oom.classification === 'oom' &&
       oom.localOomKillDelta + oom.localOomGroupKillDelta < 1)) {
    throw new EvidenceError('release evidence gap')
  }
}

function validateMeasurementsBeforeHash(
  kind: ProductionProofKind,
  value: object,
  backend: 'Node' | 'Rust',
): void {
  const measurements = parseExactMeasurements(kind, value)
  if (kind === 'maximum-scale-single-flight') {
    requireScaleThresholds(measurements as LiveScaleMeasurements)
  } else if (kind === 'real-paused-sampling') {
    requirePausedThresholds(measurements as LivePausedSamplingMeasurements)
  } else if (kind === 'leaf-local-oom-or-ambiguous') {
    requireLeafOomThresholds(measurements as LeafOomMeasurements)
  } else {
    const time = measurements as TimeDiscontinuityProof
    if (time.clockSource !== (backend === 'Node' ? 'process.hrtime.bigint' : 'std::time::Instant') ||
        time.actualGuestPmSuspend !== true || time.productionActor !== true ||
        time.wallForwardDeltaMs < 3_590_000 || time.wallBackwardDeltaMs > -3_590_000 ||
        time.hostSuspendElapsedMs < 12_000 || time.policySuspendDeltaMs > 3_000 ||
        time.actorPhaseTransitionsDuringExcludedTime !== 0 || time.catchUpBursts !== 0 ||
        time.actorPostResumeObservationAck !== true || time.postResumeCompleteCycle !== true) {
      throw new EvidenceError('release evidence gap')
    }
  }
}

const PRODUCTION_CLOCK_PROBES = {
  Node: ['npm','--prefix',ROOT,'run','test:vitest','--',
    'test/integration/real/resource-control-node-systemd.test.ts',
    '--config','config/vitest/vitest.server.config.ts','--run',
    '-t','production hrtime suspend and wall-clock discontinuity'],
  Rust: ['cargo','+1.96.0','test','--manifest-path',`${ROOT}/Cargo.toml`,
    '-p','freshell-resource-control','--test','live_systemd',
    'production_instant_suspend_wall_jump','--','--ignored','--nocapture'],
} as const

async function proveTimeDiscontinuity(
  run: CurrentApprovedGateExecutionV1,
  backend: keyof typeof PRODUCTION_CLOCK_PROBES,
): Promise<ProductionProofArtifactV1<'time-discontinuity', TimeDiscontinuityProof>> {
  assert.equal(run.backend, backend)
  const startedAt = new Date().toISOString()
  const approval = requireFreshSignedApproval('/run/user/' + process.getuid() + '/freshell-rc-live-approval', 10 * 60_000)
  assert.equal(approval.approvalId, run.approval.approvalId)
  const vm = await libvirt.revertRunning('freshell-rc-live-disposable', 'systemd255-clean')
  assert.equal(await vm.currentImageDigest(), run.guest.vmImageDigest)
  assert.equal(await vm.currentSnapshotDigest(), run.guest.vmSnapshotDigest)
  const probe = await vm.startGuestProductionProbe(PRODUCTION_CLOCK_PROBES[backend], { allowClockInjection: false })
  await probe.ready()
  await vm.guest.exec(['sudo','timedatectl','set-ntp','false'])
  const epoch = await vm.guest.readEpochSeconds()
  await vm.guest.exec(['sudo','date','-u',`--set=@${epoch + 3_600}`])
  await probe.awaitForwardWallJump()
  await vm.guest.exec(['sudo','date','-u',`--set=@${epoch - 3_600}`])
  await probe.awaitBackwardWallJump()
  await vm.guest.exec(['sudo','timedatectl','set-ntp','true'])
  const hostStart = process.hrtime.bigint()
  const pmRequest = await libvirt.domPmSuspend('freshell-rc-live-disposable', 'mem', 12)
  const pmCompletion = await vm.awaitGuestPmResume(pmRequest.operationId)
  const observed = await probe.finish({ hostSuspendElapsedNs: process.hrtime.bigint() - hostStart, approval })
  const measurements: TimeDiscontinuityProof = {
    clockSource: observed.clockSource,
    actualGuestPmSuspend: pmCompletion.guestAgentConfirmed === true && pmCompletion.mode === 'mem',
    productionActor: true,
    actorPhaseTransitionsDuringExcludedTime: observed.actorPhaseTransitionsDuringExcludedTime,
    actorPostResumeObservationAck: observed.actorPostResumeObservationAck,
    wallForwardDeltaMs: observed.wallForwardDeltaMs,
    wallBackwardDeltaMs: observed.wallBackwardDeltaMs,
    hostSuspendElapsedMs: observed.hostSuspendElapsedMs,
    policySuspendDeltaMs: observed.policySuspendDeltaMs,
    postResumeCompleteCycle: observed.postResumeCompleteCycle,
    catchUpBursts: observed.catchUpBursts,
  }
  const endedAt = new Date().toISOString()
  return sealProductionProof(run, 'time-discontinuity', measurements, startedAt, endedAt)
}
```

- [ ] After explicit approval and before either RC-LIVE-12/13 command, run this literal host-side prerequisite. Missing libvirt/guest-agent/time authority, a stale approval file, skipped backend, or any threshold failure is a hard gate failure:

```bash
set -euo pipefail
test -s "/run/user/$(id -u)/freshell-rc-live-approval"
FRESHELL_RC_LIVE_APPROVAL_FILE="/run/user/$(id -u)/freshell-rc-live-approval" \
FRESHELL_RC_VM_DOMAIN=freshell-rc-live-disposable \
FRESHELL_RC_VM_SNAPSHOT=systemd255-clean \
FRESHELL_RC_VM_SSH=freshell-rc-live-disposable \
FRESHELL_RC_VM_SUSPEND_SECONDS=12 \
FRESHELL_RC_VM_WALL_JUMP_SECONDS=3600 \
FRESHELL_RC_PROOF_INDEX=/tmp/freshell-resource-containment-proof-index.json \
  npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment exec tsx -- \
  /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/helpers/resource-control-live.ts time-discontinuity
```

Expected: PASS with two sealed production artifacts, `node-time-discontinuity` and `rust-time-discontinuity`, bound respectively to RC-LIVE-12/13; both embed the current signed scope/run/VM/command/host provenance and record forward/backward wall jumps, production clock sources, zero fake-clock use, and `actualGuestPmSuspend:true` from guest-agent-confirmed PM completion. Omission/false fails before hashing.

- [ ] **GREEN:** Re-run focused tests. Expected: PASS including deterministic histories, exact-key artifact envelopes, pre-hash omission/false rejection, and a valid time payload with `actualGuestPmSuspend:true`; then require current-approval/run-bound live scale/no-overlap/budget, paused/reassessment, OOM, and time artifacts below before Task 15 can stage or commit.
- [ ] **Evidence gates RC-LIVE-12/13:** Obtain one current signed approval whose two exact `ApprovalScopeV1` values name the current release `runId`, gate-specific `executionId`, canonical `executionStartedAt`/`executionWindowEndsAt`, backend, byte-exact command digest, observed VM image/snapshot digests, all four proof kinds, and destructive/time authority. `createCurrentApprovedGateExecution` verifies the signature and approved window, captures current host/guest/capability metadata, and copies both timestamps into the immutable current-run context before any measurement. Use the same disposable systemd-enabled VM snapshot, never the self-hosted account/domain, and run only the byte-exact mapped commands below. The selected allocator cases seal backend-specific scale and paused artifacts; the selected OOM cases seal local-counter artifacts; the prior subprotocol seals time artifacts. Each `sealProductionProof` body embeds both execution-window fields and requires every proof timestamp inside that window before hashing. Task 15 writes the two create-only `ProductionProofIndexEntryV1` fragments for RC-LIVE-12/13, each with four unique artifact refs and the complete run window. Task 17 later merges these with the other fourteen gate results into the canonical sixteen-key sidecar, validates it first, and only then emits exact eleven-field rows.

```bash
# RC-LIVE-12: Node allocator efficacy + isolated leaf OOM
FRESHELL_RUN_REAL_RESOURCE_CONTROL=1 FRESHELL_RUN_DESTRUCTIVE_RESOURCE_CONTROL=1 \
  npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/integration/real/resource-control-node-systemd.test.ts \
  --config config/vitest/vitest.server.config.ts --run -t "allocator efficacy|leaf OOM"

# RC-LIVE-13a: Rust allocator efficacy
FRESHELL_RUN_DESTRUCTIVE_RESOURCE_CONTROL=1 \
  cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-resource-control --test live_systemd allocator_efficacy -- --ignored --nocapture

# RC-LIVE-13b: Rust isolated leaf OOM
FRESHELL_RUN_DESTRUCTIVE_RESOURCE_CONTROL=1 \
  cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-resource-control --test live_systemd leaf_oom -- --ignored --nocapture
```

Expected: all three byte-exact commands PASS. Inside the selected allocator cases, Node and Rust each prove aggregate + 64 real leaves, >=100 complete production-monitor cycles, `maxInFlight=1`, both p99 budgets, zero missed-tick bursts, at least three real samples of a verified frozen leaf, one effective-victim freeze, and next-complete-cycle reassessment. The OOM cases prove stable same-leaf local counters or explicit ambiguous classification. The earlier actual time-discontinuity subprotocol supplies the matching backend proof. Any fake/injected port, absent real sample, missing ref, unavailable VM capability, skip, threshold failure, command failure, or survivor makes the gate result FAIL and blocks Task 15/17/release.

- [ ] Validate and freeze the two gate results after the exact commands. This command does not alter or replace §9.1:

```bash
FRESHELL_RC_PROOF_INDEX=/tmp/freshell-resource-containment-proof-index.json \
  npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment exec tsx -- \
  /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/helpers/resource-control-live.ts validate-proof-index \
  --gates RC-LIVE-12,RC-LIVE-13
```

Expected: PASS for the selected RC-LIVE-12/13 fragments only when each is self-keyed, has the four unique `sha256:<64-hex>` refs for scale, paused, OOM, and time, and has no extra/missing/duplicate mapping. Each referenced artifact body contains the current approval ID and exact signed scope, approval-signature digest, run/execution IDs, canonical execution-window fields, observed VM image/snapshot digests, capability fingerprint, exact command text/digest, git commit, proof start/end timestamps, host/guest metadata, production/fake-clock/result fields, and exact measurements. `artifactHash` equals SHA-256 of RFC-8785 canonical JSON of every body field, and proof timestamps fall within the embedded current approved execution window. Any stale/reused/mismatched envelope or mapping blocks Task 15. Task 17 later combines these two validated fragments with fourteen other gate results, enforces the canonical sixteen-key sidecar, and only then derives unchanged eleven-field rows with `leftovers:[]`.

**Commit:**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add server/resource-control/pressure-policy.ts server/resource-control/systemd.ts server/resource-control/control-plane.ts server/coding-cli/codex-app-server/runtime.ts server/fresh-agent/runtime-adapter.ts server/fresh-agent/adapters/opencode/serve-manager.ts crates/freshell-resource-control/src/pressure.rs crates/freshell-resource-control/src/systemd.rs crates/freshell-resource-control/src/lifecycle.rs crates/freshell-codex/src/launch_lifecycle.rs crates/freshell-opencode/src/serve.rs crates/freshell-freshagent/src/lib.rs src/components/ResourceContainmentModal.tsx test/unit/server/resource-control-pressure.test.ts test/integration/server/resource-containment-scale.test.ts crates/freshell-resource-control/tests/pressure.rs test/helpers/resource-control-live.ts test/integration/real/resource-control-node-systemd.test.ts crates/freshell-resource-control/tests/live_systemd.rs
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit -F - <<'EOF'
feat(resource-control): add bounded monotonic pressure supervision

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
```

### Task 16: Reconcile providers and join the shutdown DAG

**Files:**
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/index.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/resource-control/control-plane.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/coding-cli/codex-app-server/runtime.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/fresh-agent/runtime-adapter.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/server/fresh-agent/adapters/opencode/serve-manager.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-resource-control/src/supervisor.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-server/src/main.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-ws/src/auto_resume.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-codex/src/launch_lifecycle.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-opencode/src/serve.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/integration/server/resource-containment-shutdown.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-ws/tests/auto_resume_shutdown.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-server/tests/resource_containment_concurrency.rs`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/crates/freshell-server/tests/resource_containment_shutdown.rs`

**Interfaces:** consumes `ResourceDomainId`, `ServerEpoch`, `LifecycleJournalV1`, `OwnerLifecycleState`, `CompensationStep`, `StepOutcome`, `retainedAdoptable`, actor `BeginShutdown`, `Reconcile`, and canonical `EvidenceRowV1`; produces acknowledged close→drain→persist→dispose→join, same-boot adoption, cross-boot cleanup, terminal/retryable compensation records, final `server.stopped` emission, and one outcome each for RC-LIVE-14/15, consumed by Task 17 as one row per ID with `leftovers:[]`.

- [ ] **RED:** Shutdown during backoff; late exit after replacement; actor callback reentry; admission closes before drain; monitor/replay joined; Codex retain/release decision; OpenCode watcher joined; compensation terminal/retained before controller disposal; no strong sender cycle; no late spawn after `BeginShutdown`; same-boot adoption and cross-boot cleanup. `server.stopped` is absent on every failed/incomplete shutdown and is emitted exactly once only after non-retained disposal, all supervisor jobs, and the lifecycle actor have joined.

```rust
assert!(events.position("BeginShutdown") < events.position("disposeNonRetainedUnits"));
assert_eq!(supervisor.join_all().await, CompletedWorkers::ALL);
assert_eq!(events.count("server.stopped"), 1);
assert!(events.position("disposeNonRetainedUnits") < events.position("joinAllWorkers"));
assert!(events.position("joinAllWorkers") < events.position("joinLifecycleActor"));
assert!(events.position("joinLifecycleActor") < events.position("server.stopped"));
assert_eq!(events.last(), Some("server.stopped"));
```

- [ ] Run before implementation:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/integration/server/resource-containment-shutdown.test.ts \
  --config config/vitest/vitest.server.config.ts --run
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml -p freshell-ws --test auto_resume_shutdown
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml -p freshell-server --test resource_containment_concurrency
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml -p freshell-server --test resource_containment_shutdown
```

Expected: FAIL because workers, intake, ownership, and disposal do not form one joined DAG.

- [ ] Implement exact nine-step shutdown order, closeable intake, acknowledged owner dispositions, tracked jobs, final journal/snapshot, non-retained-only disposal, and joined actor/workers. Reconcile before reopening admission.

```rust
async fn shutdown(
    mut lifecycle: LifecycleClient,
    supervisor: Supervisor,
    server_events: &ServerEventEmitter,
) -> Result<(), ShutdownError> {
    lifecycle.begin_shutdown().await?;
    lifecycle.revoke_action_nonces().await?;
    supervisor.cancel_and_join_monitor_and_replay().await?;
    supervisor.close_provider_intake().await?;
    supervisor.join_exit_classification_and_recovery().await?;
    lifecycle.await_owner_dispositions().await?;
    lifecycle.drain_compensation_and_population_release().await?;
    lifecycle.persist_final_and_close_intake().await?;
    lifecycle.dispose_non_retained_units().await?;
    supervisor.join_all().await?;
    lifecycle.join_actor().await?;
    server_events.emit(ServerEvent::Stopped)?;
    Ok(())
}
```

- [ ] **GREEN:** Re-run all four commands. Expected: PASS with every join handle complete, no late spawn, no early/duplicate `server.stopped`, and the sole `server.stopped` event strictly after non-retained disposal, worker join, and actor join.
- [ ] **Evidence gates RC-LIVE-14/15:** After explicit approval and isolation, run:

```bash
# RC-LIVE-14: Node crash adoption + live shutdown
FRESHELL_RUN_REAL_RESOURCE_CONTROL=1 \
  npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/integration/real/resource-control-node-owners.test.ts \
  --config config/vitest/vitest.server.config.ts --run -t "crash adoption|shutdown drain"

# RC-LIVE-15: Rust adoption + supervisor drain
FRESHELL_RUN_REAL_RESOURCE_CONTROL=1 \
  cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-server --test resource_containment_shutdown -- --ignored --nocapture
```

Expected: PASS for crash adoption, partial compensation, close/drain/dispose, no late spawn, every Rust join, and zero leftovers. The commands produce exactly one RC-LIVE-14 row and one RC-LIVE-15 row with `leftovers:[]`; both cells are mandatory.

**Commit:**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add server/index.ts server/resource-control/control-plane.ts server/coding-cli/codex-app-server/runtime.ts server/fresh-agent/runtime-adapter.ts server/fresh-agent/adapters/opencode/serve-manager.ts crates/freshell-resource-control/src/supervisor.rs crates/freshell-server/src/main.rs crates/freshell-ws/src/auto_resume.rs crates/freshell-codex/src/launch_lifecycle.rs crates/freshell-opencode/src/serve.rs test/integration/server/resource-containment-shutdown.test.ts crates/freshell-ws/tests/auto_resume_shutdown.rs crates/freshell-server/tests/resource_containment_concurrency.rs crates/freshell-server/tests/resource_containment_shutdown.rs
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit -F - <<'EOF'
feat(resource-control): drain lifecycle actors and adopt surviving owners

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
```

## Phase 5 — Acceptance, Documentation, and Release Evidence

### Task 17: Run acceptance, evidence manifest, documentation, and final audits

**Files:**
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/integration/server/resource-containment.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/specs/resource-containment-ui.spec.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/specs/resource-containment-mixed-version.spec.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/helpers/resource-control-evidence.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/evidence/resource-containment.schema.json`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/evidence/resource-containment-manifest.json`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/evidence/resource-containment-proof-index.json`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/unit/docs/resource-containment-copy.test.ts`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/README.md`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/docs/index.html`
- `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/AGENTS.md`

**Interfaces:** consumes every canonical contract, canonical `RC_LIVE_GATE_IDS`/`EvidenceRowV1`/`EvidenceManifestV1`, current signed approvals/runs, RC-LIVE-00–15 command outputs, and canonical `ProductionProofIndexV1`; produces a validated gate-keyed proof index, exactly one unchanged eleven-field manifest row per unique gate ID, and the final release decision. `entriesByGateId` has exactly the sixteen canonical keys and one self-identifying entry per key. RC-LIVE-12/13 sidecar entries have four unique artifact refs; all others have `[]`. The sidecar validator rejects duplicate raw JSON keys, parses every execution-window field, validates all hashes/provenance/measurements/freshness against the current approval/run and prospective row metadata, and returns a branded validated index. Only then may `emitGateEvidence` derive rows. RC-LIVE-07/08 retain one combined command and RC-LIVE-13 retains ordered 13a+13b.

- [ ] **RED:** Manifest rejects length other than 16; any missing, extra, out-of-order, or duplicate gate ID; an empty command/test name; any command plan differing byte-for-byte from §9.1; separate RC-LIVE-07/08 Node invocations instead of the one combined invocation; RC-LIVE-13 emitted before exact ordered subcommands 13a and 13b both pass; nonempty/non-array `leftovers`; nested gate/result containers; or any twelfth row field. Independently, proof-index parsing rejects a missing/extra/duplicate raw gate key, more or less than one entry per gate, entry/key mismatch, extra entry/artifact fields, noncanonical/missing/duplicate artifact mappings, any refs outside RC-LIVE-12/13, omitted/invalid/mismatched `executionStartedAt` or `executionWindowEndsAt`, proof timestamps outside the current signed execution window, stale/reused artifacts/runs/executions, approval/VM/capability/command/host/guest/result mismatch, omitted/false `actualGuestPmSuspend`, fake ports, and unavailable/skipped/failed proof. The complete proof index must validate before any row is emitted or accepted. Docs-copy tests require cooperative/shared-domain/Windows/admin/pause/OOM/provider-state boundaries; acceptance requires deployed floor, every focused suite from Tasks 2–16, both browsers, v8 matrix, scale/budget, actor/shutdown, and every owner.

```ts
expect(validManifest).toHaveLength(16)
expect(validManifest.map(row => row.gateId)).toEqual(RC_LIVE_GATE_IDS)
expect(Object.keys(validManifest[0]).sort()).toEqual([
  'backend','capabilityFingerprint','command','gateId','gitCommit','kernelVersion',
  'leftovers','owner','result','systemdVersion','testName',
])
expect(EVIDENCE_KEYS).toHaveLength(11)
expect(Object.keys(evidenceSchema.prefixItems[0].properties).sort())
  .toEqual([...EVIDENCE_KEYS].sort())
expect(Object.keys(validManifest[0])).toHaveLength(11)
expect(() => validateEvidenceManifest(manifestMissing('RC-LIVE-09'), validatedProofIndex)).toThrow('release evidence gap')
expect(() => validateEvidenceManifest([...validManifest, extraGateRow()] as never, validatedProofIndex)).toThrow('release evidence gap')
expect(() => validateEvidenceManifest(withDuplicateGate(validManifest, 'RC-LIVE-12'), validatedProofIndex)).toThrow('release evidence gap')
expect(() => validateEvidenceManifest(withRowsSwapped(validManifest, 'RC-LIVE-07', 'RC-LIVE-08'), validatedProofIndex))
  .toThrow('release evidence gap')
expect(() => validateEvidenceManifest(withRow(validManifest, 'RC-LIVE-04', { leftovers: ['unit-survived'] }), validatedProofIndex))
  .toThrow('release evidence gap')
expect(() => validateEvidenceManifest(withUnexpectedField(validManifest), validatedProofIndex)).toThrow('release evidence gap')
expect(commandPlanFor('RC-LIVE-07')).toEqual(commandPlanFor('RC-LIVE-08'))
expect(commandPlanFor('RC-LIVE-07')).toEqual([EXACT_RC_LIVE_07_08])
expect(commandPlanFor('RC-LIVE-13')).toEqual([EXACT_RC_LIVE_13A, EXACT_RC_LIVE_13B])
expect(() => validateProductionProofIndex(indexWithRun(
  'RC-LIVE-13', runResult('RC-LIVE-13', [passed(EXACT_RC_LIVE_13A)]),
), currentRun, emptyRegistry))
  .toThrow('release evidence gap')
expect(() => parseProductionProofIndex(indexMissingEntry('RC-LIVE-09'))).toThrow('release evidence gap')
expect(() => parseProductionProofIndex(indexWithExtraEntry('RC-LIVE-16'))).toThrow('release evidence gap')
expect(() => parseProductionProofIndex(rawIndexWithDuplicateKey('RC-LIVE-12'))).toThrow('release evidence gap')
expect(() => parseProductionProofIndex(indexWithEntryKeyMismatch('RC-LIVE-12', 'RC-LIVE-13')))
  .toThrow('release evidence gap')
expect(Object.keys(parseProductionProofIndex(validProofIndex).entriesByGateId))
  .toEqual(RC_LIVE_GATE_IDS)
expect(Object.keys(parseProductionProofIndex(validProofIndex).entriesByGateId)).toHaveLength(16)
expect(() => parseProductionProofIndex(indexWithoutRunField('RC-LIVE-12', 'executionStartedAt')))
  .toThrow('release evidence gap')
expect(() => parseProductionProofIndex(indexWithoutRunField('RC-LIVE-13', 'executionWindowEndsAt')))
  .toThrow('release evidence gap')
expect(() => validateProductionProofIndex(indexWithoutArtifactRef(
  'RC-LIVE-12', 'real-paused-sampling',
), currentRun, emptyRegistry)).toThrow('release evidence gap')
expect(() => validateProductionProofIndex(indexWithDuplicateArtifactRef('RC-LIVE-13'), currentRun, emptyRegistry))
  .toThrow('release evidence gap')
expect(() => validateProductionProofIndex(indexWithArtifactRefs('RC-LIVE-11', validNodeRefs), currentRun, emptyRegistry))
  .toThrow('release evidence gap')
for (const key of ARTIFACT_KEYS) {
  expect(() => parseProductionProofArtifact(withoutKey(validScaleArtifact, key)))
    .toThrow('release evidence gap')
}
expect(ARTIFACT_KEYS).toHaveLength(24)
expect(APPROVAL_SCOPE_KEYS).toHaveLength(12)
expect(GATE_RUN_KEYS).toHaveLength(16)
expect(() => validateProductionProofIndex(withResealedArtifact(validProofIndex, 'RC-LIVE-12', { approvalId:'stale-approval' }), currentRun, emptyRegistry))
  .toThrow('release evidence gap')
expect(() => validateProductionProofIndex(withResealedArtifact(validProofIndex, 'RC-LIVE-12', { approvalSignatureSha256:otherDigest }), currentRun, emptyRegistry))
  .toThrow('release evidence gap')
expect(() => validateProductionProofIndex(withResealedArtifact(validProofIndex, 'RC-LIVE-12', { approvalScope:{...nodeScope, executionId:'foreign'} }), currentRun, emptyRegistry))
  .toThrow('release evidence gap')
expect(() => validateProductionProofIndex(withResealedArtifact(validProofIndex, 'RC-LIVE-13', { runId:'prior-run', executionId:'prior-execution' }), currentRun, emptyRegistry))
  .toThrow('release evidence gap')
expect(() => validateProductionProofIndex(withResealedArtifact(validProofIndex, 'RC-LIVE-12', { executionStartedAt:afterProofStart }), currentRun, emptyRegistry))
  .toThrow('release evidence gap')
expect(() => validateProductionProofIndex(withResealedArtifact(validProofIndex, 'RC-LIVE-13', { executionWindowEndsAt:beforeProofEnd }), currentRun, emptyRegistry))
  .toThrow('release evidence gap')
expect(() => validateProductionProofIndex(withResealedArtifact(validProofIndex, 'RC-LIVE-12', { commandText:'rewritten', commandSha256:sha256Ref('rewritten') }), currentRun, emptyRegistry))
  .toThrow('release evidence gap')
expect(() => validateProductionProofIndex(withResealedArtifact(validProofIndex, 'RC-LIVE-13', { guest:{...rustGuest, vmSnapshotDigest:otherDigest} }), currentRun, emptyRegistry))
  .toThrow('release evidence gap')
expect(() => validateProductionProofIndex(withResealedArtifact(validProofIndex, 'RC-LIVE-12', { capabilityFingerprint:otherCapability }), currentRun, emptyRegistry))
  .toThrow('release evidence gap')
expect(() => validateProductionProofIndex(withResealedArtifact(validProofIndex, 'RC-LIVE-12', { startedAt:beforeExecutionStart }), currentRun, emptyRegistry))
  .toThrow('release evidence gap')
expect(() => validateProductionProofIndex(withResealedArtifact(validProofIndex, 'RC-LIVE-13', { host:otherHost, result:'FAIL' }), currentRun, emptyRegistry))
  .toThrow('release evidence gap')
expect(() => validateEvidenceManifest(
  withRow(validManifest, 'RC-LIVE-12', { kernelVersion:'foreign-kernel' }), validatedProofIndex,
)).toThrow('release evidence gap')
expect(() => validateProductionProofIndex(withResealedArtifact(validProofIndex, 'RC-LIVE-12', { gitCommit:'foreign-commit' }), currentRun, emptyRegistry))
  .toThrow('release evidence gap')
expect(() => validateProductionProofIndex(withArtifactHashTampered(validProofIndex, 'RC-LIVE-12'), currentRun, emptyRegistry))
  .toThrow('release evidence gap')
expect(() => validateProductionProofIndex(withTimeMeasurementOmitted(validProofIndex, 'actualGuestPmSuspend'), currentRun, emptyRegistry))
  .toThrow('release evidence gap')
expect(() => validateProductionProofIndex(withTimeMeasurement(validProofIndex, { actualGuestPmSuspend:false }), currentRun, emptyRegistry))
  .toThrow('release evidence gap')
expect(() => validateProductionProofIndex(validProofIndex, currentRun, registryContaining(validNodeRefs[0])))
  .toThrow('release evidence gap')
const validated = validateProductionProofIndex(validProofIndex, currentRun, emptyRegistry)
const emitted = emitGateEvidence(validated.entryFor('RC-LIVE-12'))
expect(emitted.command).toBe(serializeCommandPlan(commandPlanFor(exactGateExecution.gateId)))
expect(emitted.testName).toBe(exactGateExecution.testName)
expect(Object.keys(emitted)).toHaveLength(11)
expect(emitted.leftovers).toEqual([])
expect(() => acceptReleaseEvidence(validManifest, validProofIndex, currentRun, emptyRegistry)).not.toThrow()
expect(documentText).toContain(exactThreatDisclosure)
```

- [ ] Run focused acceptance/docs/schema tests before implementation:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/integration/server/resource-containment.test.ts \
  test/unit/docs/resource-containment-copy.test.ts \
  --config config/vitest/vitest.server.config.ts --run
```

Expected: FAIL until the exact eleven-field manifest schema, sixteen-entry gate-keyed proof-index schema, execution-window/artifact validators, and exact documentation requirements are present.

- [ ] Implement evidence schema/helpers and update README, docs mock, and AGENTS operational guidance.

```ts
const EVIDENCE_KEYS = [
  'gateId','backend','owner','command','testName','gitCommit',
  'kernelVersion','systemdVersion','capabilityFingerprint','result','leftovers',
] as const
const PROOF_INDEX_KEYS = [
  'schemaVersion','entriesByGateId','artifactsByHash',
] as const
const PROOF_INDEX_ENTRY_KEYS = [
  'gateId','run','artifactRefs',
] as const
const GATE_RUN_KEYS = [
  'gateId','backend','approvalId','approvalScope','runId','executionId',
  'executionStartedAt','executionWindowEndsAt','gitCommit','startedAt','endedAt',
  'host','guest','capabilityFingerprint','passedCommands','result',
] as const
const ARTIFACT_KEYS = [
  'schemaVersion','kind','gateId','backend','approvalId','approvalScope',
  'approvalSignatureSha256','runId','executionId',
  'executionStartedAt','executionWindowEndsAt','commandText','commandSha256',
  'gitCommit','startedAt','endedAt','host','guest','capabilityFingerprint',
  'source','fakeClockUsed','result','measurements','artifactHash',
] as const
const APPROVAL_SCOPE_KEYS = [
  'gateId','backend','runId','executionId',
  'executionStartedAt','executionWindowEndsAt','commandSha256','vmImageDigest',
  'vmSnapshotDigest','proofKinds','destructiveResourceControl','timeDiscontinuity',
] as const
const HOST_KEYS = ['hostname','bootId','kernelVersion','libvirtVersion'] as const
const GUEST_KEYS = [
  'hostname','machineId','bootId','kernelVersion','systemdVersion','vmDomain',
  'vmSnapshot','vmImageDigest','vmSnapshotDigest',
] as const
const MEASUREMENT_KEYS: Record<ProductionProofKind, readonly string[]> = {
  'maximum-scale-single-flight': [
    'realAggregate','realLeafCount','completeCycles','maxInFlight','productionActor',
    'actorObservationAcks','maxConcurrentActorTurns','snapshotReduceSerializeP99Ms',
    'completeCycleP99Ms','missedTickBursts','effectiveVictim',
  ],
  'real-paused-sampling': [
    'launchId','frozenReadback','fromRealCgroupfs','sampledCompleteCycles','monitorStayedRunning',
  ],
  'leaf-local-oom-or-ambiguous': [
    'fromRealCgroupfs','classification','crossLeafAttribution',
    'localOomKillDelta','localOomGroupKillDelta',
  ],
  'time-discontinuity': [
    'clockSource','actualGuestPmSuspend','productionActor',
    'actorPhaseTransitionsDuringExcludedTime','actorPostResumeObservationAck',
    'wallForwardDeltaMs','wallBackwardDeltaMs','hostSuspendElapsedMs',
    'policySuspendDeltaMs','postResumeCompleteCycle','catchUpBursts',
  ],
}

function parseExactMeasurements(kind: ProductionProofKind, value: unknown): object {
  const measurements = requireExactObject(value, MEASUREMENT_KEYS[kind])
  if (kind === 'maximum-scale-single-flight') {
    requireExactObject(measurements.effectiveVictim, [
      'launchId','freezeCount','reassessedNextCompleteCycle',
    ])
  }
  return measurements
}

type ExactCommandLabel = RcLiveGateId | 'RC-LIVE-07/08' | 'RC-LIVE-13a' | 'RC-LIVE-13b'
const REQUIRED_RC_12_13_PROOFS = RC_PRESSURE_PROOF_KINDS
const COMMAND_PLAN_LABELS: Record<RcLiveGateId, readonly ExactCommandLabel[]> = {
  'RC-LIVE-00':['RC-LIVE-00'], 'RC-LIVE-01':['RC-LIVE-01'],
  'RC-LIVE-02':['RC-LIVE-02'], 'RC-LIVE-03':['RC-LIVE-03'],
  'RC-LIVE-04':['RC-LIVE-04'], 'RC-LIVE-05':['RC-LIVE-05'],
  'RC-LIVE-06':['RC-LIVE-06'], 'RC-LIVE-07':['RC-LIVE-07/08'],
  'RC-LIVE-08':['RC-LIVE-07/08'], 'RC-LIVE-09':['RC-LIVE-09'],
  'RC-LIVE-10':['RC-LIVE-10'], 'RC-LIVE-11':['RC-LIVE-11'],
  'RC-LIVE-12':['RC-LIVE-12'], 'RC-LIVE-13':['RC-LIVE-13a','RC-LIVE-13b'],
  'RC-LIVE-14':['RC-LIVE-14'], 'RC-LIVE-15':['RC-LIVE-15'],
}

function commandPlanFor(gateId: RcLiveGateId): readonly string[] {
  return COMMAND_PLAN_LABELS[gateId].map(label => exactCommandTextByLabel[label])
}
function serializeCommandPlan(commands: readonly string[]): string {
  return commands.join('\n\n')
}
type CurrentReleaseRunV1 = {
  runId: string
  now: string
  approval: SignedApprovalV1
  executionFor(gateId: RcLiveGateId): GateRunResultV1
  observedHostFor(executionId: string): ProofHostMetadataV1
  observedGuestFor(executionId: string): ProofGuestMetadataV1
  observedCapabilityFor(executionId: string): CapabilityFingerprint
}
type FreshnessClaimV1 = { artifactHash: Sha256Ref; runId: string; executionId: string }
type AcceptedEvidenceStateV1 = {
  artifactHashes: readonly Sha256Ref[]
  runIds: readonly string[]
  executionIds: readonly string[]
}

class AcceptedEvidenceRegistry {
  constructor(private readonly path: string, private readonly allowWrite = true) {}
  readOnly(): AcceptedEvidenceRegistry {
    return new AcceptedEvidenceRegistry(this.path, false)
  }
  assertNeverAccepted(claim: FreshnessClaimV1): void {
    const state = readAndParseAcceptedEvidenceState(this.path)
    if (state.artifactHashes.includes(claim.artifactHash) ||
        state.runIds.includes(claim.runId) ||
        state.executionIds.includes(claim.executionId)) {
      throw new EvidenceError('release evidence gap')
    }
  }
  claimAtomically(runId: string, claims: readonly FreshnessClaimV1[]): void {
    if (!this.allowWrite || claims.length !== 8 ||
        claims.some(claim => claim.runId !== runId) ||
        new Set(claims.map(claim => claim.artifactHash)).size !== 8 ||
        new Set(claims.map(claim => claim.executionId)).size !== 2) {
      throw new EvidenceError('release evidence gap')
    }
    withExclusiveFlock(this.path + '.lock', () => {
      const state = readAndParseAcceptedEvidenceState(this.path)
      for (const claim of claims) {
        if (state.artifactHashes.includes(claim.artifactHash) ||
            state.runIds.includes(claim.runId) ||
            state.executionIds.includes(claim.executionId)) {
          throw new EvidenceError('release evidence gap')
        }
      }
      durableReplaceJson(this.path, {
        artifactHashes: [...state.artifactHashes, ...claims.map(claim => claim.artifactHash)],
        runIds: [...state.runIds, runId],
        executionIds: [...state.executionIds, ...new Set(claims.map(claim => claim.executionId))],
      } satisfies AcceptedEvidenceStateV1)
    })
  }
}

function parseGateRunResult(value: unknown, gateId: RcLiveGateId): GateRunResultV1 {
  const run = requireExactObject(value, GATE_RUN_KEYS)
  if (run.gateId !== gateId ||
      !['neutral/direct','Node','Rust'].includes(run.backend as string) ||
      !['PASS','FAIL','skipped','unavailable'].includes(run.result as string)) {
    throw new EvidenceError('release evidence gap')
  }
  for (const field of [
    'runId','executionId','executionStartedAt','executionWindowEndsAt',
    'gitCommit','startedAt','endedAt',
  ] as const) {
    requireNonEmptyString(run[field])
  }
  for (const field of [
    'executionStartedAt','executionWindowEndsAt','startedAt','endedAt',
  ] as const) {
    parseRfc3339Utc(run[field])
  }
  requireExactObject(run.host, HOST_KEYS)
  parseCapabilityFingerprint(run.capabilityFingerprint)
  if (!Array.isArray(run.passedCommands)) throw new EvidenceError('release evidence gap')
  for (const command of run.passedCommands) {
    const parsed = requireExactObject(command, ['command','result'])
    requireNonEmptyString(parsed.command)
    if (parsed.result !== 'PASS') throw new EvidenceError('release evidence gap')
  }
  const pressureGate = gateId === 'RC-LIVE-12' || gateId === 'RC-LIVE-13'
  if (pressureGate) {
    requireNonEmptyString(run.approvalId)
    requireExactObject(run.approvalScope, APPROVAL_SCOPE_KEYS)
    requireExactObject(run.guest, GUEST_KEYS)
  } else if (run.approvalId !== null || run.approvalScope !== null || run.guest !== null) {
    throw new EvidenceError('release evidence gap')
  }
  return run as GateRunResultV1
}

function buildProductionProofIndex(
  entries: readonly ProductionProofIndexEntryV1[],
  artifacts: readonly ProductionProofArtifactV1<ProductionProofKind, object>[],
): ProductionProofIndexV1 {
  if (entries.length !== RC_LIVE_GATE_IDS.length ||
      new Set(entries.map(entry => entry.gateId)).size !== RC_LIVE_GATE_IDS.length ||
      artifacts.length !== 8 ||
      new Set(artifacts.map(artifact => artifact.artifactHash)).size !== 8) {
    throw new EvidenceError('release evidence gap')
  }
  const entryById = new Map(entries.map(entry => [entry.gateId, entry]))
  const entriesByGateId = Object.fromEntries(
    RC_LIVE_GATE_IDS.map(gateId => [gateId, entryById.get(gateId)]),
  )
  const artifactsByHash = Object.fromEntries(
    [...artifacts]
      .sort((a, b) => a.artifactHash.localeCompare(b.artifactHash))
      .map(artifact => [artifact.artifactHash, artifact]),
  )
  return parseProductionProofIndex(rfc8785CanonicalJson({
    schemaVersion: 1, entriesByGateId, artifactsByHash,
  }))
}

function parseProductionProofIndex(input: unknown): ProductionProofIndexV1 {
  const decoded = typeof input === 'string'
    ? parseCanonicalJsonRejectDuplicateKeys(input)
    : input
  const root = requireExactObject(decoded, PROOF_INDEX_KEYS)
  if (root.schemaVersion !== 1) throw new EvidenceError('release evidence gap')
  const rawEntries = requirePlainObject(root.entriesByGateId)
  if (!sameJson(Object.keys(rawEntries), RC_LIVE_GATE_IDS)) {
    throw new EvidenceError('release evidence gap')
  }
  const entriesByGateId = {} as ProductionProofIndexV1['entriesByGateId']
  for (const gateId of RC_LIVE_GATE_IDS) {
    const entry = requireExactObject(rawEntries[gateId], PROOF_INDEX_ENTRY_KEYS)
    if (entry.gateId !== gateId || !Array.isArray(entry.artifactRefs) ||
        new Set(entry.artifactRefs).size !== entry.artifactRefs.length) {
      throw new EvidenceError('release evidence gap')
    }
    for (const ref of entry.artifactRefs) requireSha256Ref(ref)
    entriesByGateId[gateId] = {
      gateId,
      run: parseGateRunResult(entry.run, gateId),
      artifactRefs: [...entry.artifactRefs],
    } as never
  }
  const artifactsByHash = requirePlainObject(root.artifactsByHash)
  for (const key of Object.keys(artifactsByHash)) requireSha256Ref(key)
  return { schemaVersion: 1, entriesByGateId, artifactsByHash } as ProductionProofIndexV1
}

function parseProductionProofArtifact(value: unknown): ProductionProofArtifactV1<ProductionProofKind, object> {
  const artifact = requireExactObject(value, ARTIFACT_KEYS)
  if (artifact.schemaVersion !== 1 ||
      !RC_PRESSURE_PROOF_KINDS.includes(artifact.kind as ProductionProofKind) ||
      !['RC-LIVE-12','RC-LIVE-13'].includes(artifact.gateId as string) ||
      !['Node','Rust'].includes(artifact.backend as string) ||
      artifact.source !== 'production' ||
      typeof artifact.fakeClockUsed !== 'boolean' ||
      !['PASS','FAIL','skipped','unavailable'].includes(artifact.result as string)) {
    throw new EvidenceError('release evidence gap')
  }
  for (const field of [
    'approvalId','runId','executionId','executionStartedAt','executionWindowEndsAt',
    'commandText','gitCommit','startedAt','endedAt',
  ] as const) {
    requireNonEmptyString(artifact[field])
  }
  for (const field of [
    'executionStartedAt','executionWindowEndsAt','startedAt','endedAt',
  ] as const) {
    parseRfc3339Utc(artifact[field])
  }
  for (const field of [
    'approvalSignatureSha256','commandSha256','artifactHash',
  ] as const) {
    requireSha256Ref(artifact[field])
  }

  const scope = requireExactObject(artifact.approvalScope, APPROVAL_SCOPE_KEYS)
  for (const field of [
    'runId','executionId','executionStartedAt','executionWindowEndsAt',
  ] as const) {
    requireNonEmptyString(scope[field])
  }
  parseRfc3339Utc(scope.executionStartedAt)
  parseRfc3339Utc(scope.executionWindowEndsAt)
  for (const field of ['commandSha256','vmImageDigest','vmSnapshotDigest'] as const) {
    requireSha256Ref(scope[field])
  }
  if (!['RC-LIVE-12','RC-LIVE-13'].includes(scope.gateId as string) ||
      !['Node','Rust'].includes(scope.backend as string) ||
      scope.destructiveResourceControl !== true || scope.timeDiscontinuity !== true ||
      !sameJson(scope.proofKinds, RC_PRESSURE_PROOF_KINDS)) {
    throw new EvidenceError('release evidence gap')
  }

  const host = requireExactObject(artifact.host, HOST_KEYS)
  for (const field of HOST_KEYS) requireNonEmptyString(host[field])
  const guest = requireExactObject(artifact.guest, GUEST_KEYS)
  for (const field of ['hostname','machineId','bootId','kernelVersion','systemdVersion'] as const) {
    requireNonEmptyString(guest[field])
  }
  if (guest.vmDomain !== 'freshell-rc-live-disposable' ||
      guest.vmSnapshot !== 'systemd255-clean') {
    throw new EvidenceError('release evidence gap')
  }
  requireSha256Ref(guest.vmImageDigest)
  requireSha256Ref(guest.vmSnapshotDigest)
  parseCapabilityFingerprint(artifact.capabilityFingerprint)
  parseExactMeasurements(artifact.kind as ProductionProofKind, artifact.measurements)
  return artifact as ProductionProofArtifactV1<ProductionProofKind, object>
}

function validateProductionProofArtifact(
  ref: ProductionProofRefV1,
  entry: ProductionProofIndexEntryV1<RcPressureGateId>,
  index: ProductionProofIndexV1,
  current: CurrentReleaseRunV1,
  freshness: AcceptedEvidenceRegistry,
): { kind: ProductionProofKind; claim: FreshnessClaimV1 } {
  const artifact = parseProductionProofArtifact(index.artifactsByHash[ref])
  const { artifactHash, ...body } = artifact
  if (artifactHash !== ref ||
      sha256Ref(Buffer.from(rfc8785CanonicalJson(body), 'utf8')) !== ref) {
    throw new EvidenceError('release evidence gap')
  }
  const gateId = entry.gateId
  const run = entry.run
  const backend = gateId === 'RC-LIVE-12' ? 'Node' : 'Rust'
  const approval = current.approval
  const approvalScope = approvalScopeFor(approval, gateId)
  const currentExecution = current.executionFor(gateId)
  verifyCurrentSignedApproval(approval, new Date(current.now))
  if (!sameJson(run, currentExecution)) throw new EvidenceError('release evidence gap')

  const commandText = serializeCommandPlan(commandPlanFor(gateId))
  const commandSha256 = sha256Ref(Buffer.from(commandText, 'utf8'))
  if (run.backend !== backend ||
      artifact.gateId !== gateId || artifact.backend !== backend ||
      run.approvalId !== approval.approvalId ||
      !sameJson(run.approvalScope, approvalScope) ||
      artifact.approvalId !== approval.approvalId ||
      !sameJson(artifact.approvalScope, approvalScope) ||
      artifact.approvalSignatureSha256 !== sha256Ref(Buffer.from(approval.signature, 'utf8')) ||
      artifact.runId !== current.runId || artifact.runId !== run.runId ||
      artifact.executionId !== run.executionId ||
      artifact.executionStartedAt !== run.executionStartedAt ||
      artifact.executionWindowEndsAt !== run.executionWindowEndsAt ||
      artifact.commandText !== commandText ||
      artifact.commandSha256 !== commandSha256 ||
      artifact.gitCommit !== run.gitCommit ||
      artifact.source !== 'production' || artifact.fakeClockUsed !== false ||
      artifact.result !== 'PASS' || run.result !== 'PASS') {
    throw new EvidenceError('release evidence gap')
  }

  if (run.guest === null) throw new EvidenceError('release evidence gap')
  const exactScope: ApprovalScopeV1 = {
    gateId, backend, runId: current.runId, executionId: run.executionId,
    executionStartedAt: run.executionStartedAt,
    executionWindowEndsAt: run.executionWindowEndsAt,
    commandSha256, vmImageDigest: artifact.guest.vmImageDigest,
    vmSnapshotDigest: artifact.guest.vmSnapshotDigest,
    proofKinds: RC_PRESSURE_PROOF_KINDS,
    destructiveResourceControl: true, timeDiscontinuity: true,
  }
  if (!sameJson(approvalScope, exactScope) ||
      !sameJson(artifact.host, current.observedHostFor(run.executionId)) ||
      !sameJson(artifact.host, run.host) ||
      !sameJson(artifact.guest, current.observedGuestFor(run.executionId)) ||
      !sameJson(artifact.guest, run.guest) ||
      !sameCapabilityFingerprint(artifact.capabilityFingerprint, current.observedCapabilityFor(run.executionId)) ||
      !sameCapabilityFingerprint(artifact.capabilityFingerprint, run.capabilityFingerprint)) {
    throw new EvidenceError('release evidence gap')
  }

  const approvalStart = parseRfc3339Utc(approval.issuedAt)
  const approvalEnd = parseRfc3339Utc(approval.expiresAt)
  const executionStart = parseRfc3339Utc(artifact.executionStartedAt)
  const executionEnd = parseRfc3339Utc(artifact.executionWindowEndsAt)
  const runStart = parseRfc3339Utc(run.startedAt)
  const runEnd = parseRfc3339Utc(run.endedAt)
  const proofStart = parseRfc3339Utc(artifact.startedAt)
  const proofEnd = parseRfc3339Utc(artifact.endedAt)
  if (executionStart < approvalStart || executionEnd <= executionStart ||
      executionEnd > approvalEnd ||
      runStart < executionStart || runEnd < runStart || runEnd > executionEnd ||
      proofStart < executionStart || proofEnd < proofStart || proofEnd > executionEnd ||
      proofEnd > parseRfc3339Utc(current.now)) {
    throw new EvidenceError('release evidence gap')
  }

  validateMeasurementsBeforeHash(artifact.kind, artifact.measurements, artifact.backend)
  freshness.assertNeverAccepted({
    artifactHash: ref, runId: artifact.runId, executionId: artifact.executionId,
  })
  return {
    kind: artifact.kind,
    claim: { artifactHash: ref, runId: artifact.runId, executionId: artifact.executionId },
  }
}

type ValidatedProofIndexEntryV1<G extends RcLiveGateId = RcLiveGateId> = {
  validated: true
  entry: ProductionProofIndexEntryV1<G>
}
type ValidatedProductionProofIndexV1 = {
  runId: string
  freshnessClaims: readonly FreshnessClaimV1[]
  entryFor<G extends RcLiveGateId>(gateId: G): ValidatedProofIndexEntryV1<G>
}

function validateProductionProofIndex(
  input: unknown,
  current: CurrentReleaseRunV1,
  freshness: AcceptedEvidenceRegistry,
): ValidatedProductionProofIndexV1 {
  const index = parseProductionProofIndex(input)
  const validatedByGate = {} as Record<RcLiveGateId, ValidatedProofIndexEntryV1>
  const claims: FreshnessClaimV1[] = []
  const referencedHashes: ProductionProofRefV1[] = []
  for (const gateId of RC_LIVE_GATE_IDS) {
    const entry = index.entriesByGateId[gateId]
    const run = entry.run
    const currentExecution = current.executionFor(gateId)
    if (!sameJson(run, currentExecution) || run.runId !== current.runId) {
      throw new EvidenceError('release evidence gap')
    }
    const expected = commandPlanFor(gateId)
    if (run.result !== 'PASS' || run.passedCommands.length !== expected.length ||
        run.passedCommands.some((item, i) =>
          item.result !== 'PASS' || item.command !== expected[i])) {
      throw new EvidenceError('release evidence gap')
    }
    const pressureGate = gateId === 'RC-LIVE-12' || gateId === 'RC-LIVE-13'
    if (!pressureGate) {
      if (entry.artifactRefs.length !== 0) throw new EvidenceError('release evidence gap')
    } else {
      if (entry.artifactRefs.length !== 4 ||
          new Set(entry.artifactRefs).size !== 4) {
        throw new EvidenceError('release evidence gap')
      }
      const validatedArtifacts = entry.artifactRefs.map(ref =>
        validateProductionProofArtifact(
          ref,
          entry as ProductionProofIndexEntryV1<RcPressureGateId>,
          index,
          current,
          freshness,
        ))
      if (!sameJson(
        validatedArtifacts.map(item => item.kind).sort(),
        [...REQUIRED_RC_12_13_PROOFS].sort(),
      )) {
        throw new EvidenceError('release evidence gap')
      }
      referencedHashes.push(...entry.artifactRefs)
      claims.push(...validatedArtifacts.map(item => item.claim))
    }
    validatedByGate[gateId] = { validated: true, entry } as never
  }
  const storedHashes = Object.keys(index.artifactsByHash).sort()
  if (new Set(referencedHashes).size !== 8 ||
      !sameJson(storedHashes, [...referencedHashes].sort())) {
    throw new EvidenceError('release evidence gap')
  }
  return Object.freeze({
    runId: current.runId,
    freshnessClaims: Object.freeze(claims),
    entryFor: <G extends RcLiveGateId>(gateId: G) =>
      validatedByGate[gateId] as ValidatedProofIndexEntryV1<G>,
  })
}

function emitGateEvidence<G extends RcLiveGateId>(
  validated: ValidatedProofIndexEntryV1<G>,
): EvidenceRowV1<G> {
  if (validated.validated !== true) throw new EvidenceError('release evidence gap')
  const run = validated.entry.run
  return buildEvidenceRow(run.gateId, {
    backend: run.backend,
    command: serializeCommandPlan(commandPlanFor(run.gateId)),
    gitCommit: run.gitCommit,
    kernelVersion: run.guest?.kernelVersion ?? run.host.kernelVersion,
    systemdVersion: run.guest?.systemdVersion
      ?? String(run.capabilityFingerprint.systemdVersion),
    capabilityFingerprint: run.capabilityFingerprint,
    result: 'PASS',
    leftovers: [],
  }) as EvidenceRowV1<G>
}

function validateEvidenceManifest(
  rows: readonly EvidenceRowV1[],
  validatedIndex: ValidatedProductionProofIndexV1,
): asserts rows is EvidenceManifestV1 {
  requireExactFlatKeys(rows, EVIDENCE_KEYS)
  if (rows.length !== RC_LIVE_GATE_IDS.length) throw new EvidenceError('release evidence gap')
  const gateIds = rows.map(row => row.gateId)
  if (new Set(gateIds).size !== RC_LIVE_GATE_IDS.length ||
      !gateIds.every((gateId, index) => gateId === RC_LIVE_GATE_IDS[index])) {
    throw new EvidenceError('release evidence gap')
  }
  for (const row of rows) {
    const derived = emitGateEvidence(validatedIndex.entryFor(row.gateId))
    if (!sameEvidenceRow(row, derived) ||
        row.command !== serializeCommandPlan(commandPlanFor(row.gateId)) ||
        row.testName.length === 0 || row.result !== 'PASS' ||
        !Array.isArray(row.leftovers) || row.leftovers.length !== 0) {
      throw new EvidenceError('release evidence gap')
    }
  }
}

function acceptReleaseEvidence(
  rows: readonly EvidenceRowV1[],
  proofIndex: unknown,
  current: CurrentReleaseRunV1,
  freshness: AcceptedEvidenceRegistry,
): asserts rows is EvidenceManifestV1 {
  const validated = validateProductionProofIndex(
    proofIndex, current, freshness.readOnly(),
  )
  validateEvidenceManifest(rows, validated)
  freshness.claimAtomically(validated.runId, validated.freshnessClaims)
}

const evidenceSchema = {
  type: 'array', minItems: 16, maxItems: 16,
  prefixItems: RC_LIVE_GATE_IDS.map(gateId => ({
    type: 'object', additionalProperties: false,
    required: EVIDENCE_KEYS,
    properties: {
      gateId: { const: gateId },
      backend: { enum: ['neutral/direct','Node','Rust'] },
      owner: { type: 'string', minLength: 1 },
      command: { type: 'string', minLength: 1 },
      testName: { type: 'string', minLength: 1 },
      gitCommit: { type: 'string', minLength: 40 },
      kernelVersion: { type: 'string', minLength: 1 },
      systemdVersion: { type: 'string', minLength: 1 },
      capabilityFingerprint: capabilityFingerprintSchema,
      result: { const: 'PASS' },
      leftovers: { type: 'array', maxItems: 0 },
    },
  })),
  items: false,
} as const
```

`exactCommandTextByLabel` is a total checked-in `String.raw` map whose values are copied byte-for-byte from the labeled literal manifest matrix below, preserving environment assignments, line continuations, paths, filters, and order. Labels `RC-LIVE-07/08`, `RC-LIVE-13a`, and `RC-LIVE-13b` implement the shared/split structure; no normalization, shell reformatting, or added flag is allowed. The test helper compares every label’s bytes to the authoritative §9.1 block before accepting evidence.

`resource-containment-proof-index.json` is the separate canonical proof sidecar. Its only top-level keys are `schemaVersion`, `entriesByGateId`, and `artifactsByHash`. A duplicate-key-aware JSON parser runs before object conversion. `entriesByGateId` then must have the sixteen RC-LIVE-00–15 keys in canonical order, one self-identifying exact-key entry per gate: RC-LIVE-12/13 each contain four unique artifact refs and all other entries contain `[]`. `artifactsByHash` must have exactly the eight referenced hashes—no orphan, missing, or extra artifact. All trusted provenance is inside `ProductionProofArtifactBodyV1`; refs are hash-only. `artifactHash` is SHA-256 of RFC-8785 canonical JSON over every body field, including `executionStartedAt` and `executionWindowEndsAt`. The validator binds both fields to the signed scope, sidecar run, and current execution, then proves each run/proof interval falls inside the approved window. It also validates command, VM, host/guest, capability, result, measurement, and freshness before returning a branded index. No manifest row is emitted before this succeeds.

`resource-containment.schema.json` is the deterministic JSON serialization of `evidenceSchema`. `prefixItems` binds each ascending position to one exact gate ID; `minItems:16`, `maxItems:16`, `items:false`, `additionalProperties:false`, `EVIDENCE_KEYS`, and the duplicate-ID check enforce the specification's exact eleven fields. `leftovers` remains `[]`. Proof-index schema and validation are separate and cannot add a twelfth manifest field.

A successful row serializes exactly like this concrete JSON example (the full manifest has the other fifteen unique rows in canonical order):

```json
{
  "gateId": "RC-LIVE-00",
  "backend": "neutral/direct",
  "owner": "installed systemd package",
  "command": "FRESHELL_RUN_REAL_RESOURCE_CONTROL=1 npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- test/integration/real/resource-control-feasibility.test.ts --config config/vitest/vitest.server.config.ts --run",
  "testName": "Phase-0 active feasibility and frozen sentinel",
  "gitCommit": "0123456789abcdef0123456789abcdef01234567",
  "kernelVersion": "6.6.87.2-microsoft-standard-WSL2",
  "systemdVersion": "255",
  "capabilityFingerprint": {
    "bootId": "11111111-2222-3333-4444-555555555555",
    "managerInvocationId": "66666666-7777-8888-9999-aaaaaaaaaaaa",
    "cgroupMountId": "0:29",
    "managerControlGroup": "/user.slice/user-1000.slice/user@1000.service",
    "delegatedControllers": ["cpu", "memory", "pids"],
    "systemdVersion": 255
  },
  "result": "PASS",
  "leftovers": []
}
```

The evidence reporter consumes a fully validated proof-index entry, not an individual test case or an unvalidated run. A one-command gate emits one exact eleven-field row after its sidecar entry passes. The shared RC-LIVE-07/08 invocation emits two rows with the identical command; RC-LIVE-13 emits one row after 13a then 13b and joins their exact text with one blank line. Hashes never enter rows. Missing, extra, duplicate, reordered, rewritten, stale, reused, provenance-mismatched, hash-invalid, fake, unavailable, failed, or skipped command/proof mapping emits no PASS row; cleanup must prove `leftovers:[]`.

`/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/README.md` must include this exact disclosure:

> Freshell applies cooperative Linux cgroup limits to local processes launched through this server’s broker. This is not a security boundary: code running as the same Unix user may reconfigure or leave the hierarchy. Native Windows processes and their descendants are not covered. One combined cap is shared only by the active Node or Rust server and surviving generations that use the same Unix UID and canonical Freshell settings directory; a different settings directory is a different resource domain and has a separate cap.

`/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/docs/index.html` must independently include this exact disclosure:

> Freshell applies cooperative Linux cgroup limits to local processes launched through this server’s broker. This is not a security boundary: code running as the same Unix user may reconfigure or leave the hierarchy. Native Windows processes and their descendants are not covered. One combined cap is shared only by the active Node or Rust server and surviving generations that use the same Unix UID and canonical Freshell settings directory; a different settings directory is a different resource domain and has a separate cap.

Also document `AUTH_TOKEN` as full administrator authority, trusted non-loopback transport, pause/escalation, leaf-local-or-ambiguous OOM, interrupted provider work, compatibility floor, literal caps, and no port-3001 restart.

- [ ] Run this literal focused acceptance matrix. Any production defect returns to its owning task/commit and forces that task’s evidence rerun; Task 17 introduces no production fix.

Focused-suite completeness index (each suite has its literal command below; Task 13 contract generation and `test:port` are also written literally in the immediately following final non-live block):

| Task | Focused suites rerun by Task 17 |
|---:|---|
| 2 | sandbox config crash/cross-process, Rust `settings_store::`, CFG03 discovery and both browsers |
| 3 | shared limits/settings Vitest; `freshell-protocol` |
| 4 | capability/settings/control-plane/settings-API/platform-API Vitest |
| 5 | full lifecycle target; server settings target; mandated cross-package `resource_containment` filter |
| 6 | both Runtime Settings component suites; tagged discovery and both browsers |
| 7 | Node systemd/controller/lifecycle unit suites |
| 8 | complete `freshell-resource-control` crate suite |
| 9 | terminal/spawn architecture Vitest; terminal/WS launch tests; locked Rust architecture gate |
| 10 | Codex/agent-tabs suites; Codex/WS/freshagent Rust filter |
| 11 | fresh-agent/SDK suites; freshagent Rust filter |
| 12 | OpenCode/spawn architecture suites; OpenCode/freshagent Rust filter; final locked architecture gate |
| 13 | snapshot/mixed-version suites; protocol crate; deterministic contract generation/`test:port`; mixed-version browsers |
| 14 | action/router and client modal/UI suites; server/WS Rust filter; UI browsers |
| 15 | pressure/scale suites; Rust pressure filter |
| 16 | Node shutdown plus WS auto-resume, concurrency, and shutdown Rust targets |

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:sandbox -- \
  "npm run test:vitest -- test/integration/server/config-store-crash-safety.test.ts test/integration/server/resource-settings-cross-process.test.ts --config config/vitest/vitest.server.config.ts --run"
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml -p freshell-server settings_store::
cfg03_discovery="$(npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment exec playwright test -- \
  --config /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/playwright.config.ts \
  --project=legacy-chromium --project=rust-chromium \
  /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/specs/cfg03-backup-restore.spec.ts \
  --grep "@cfg03-backup-matrix" --list)"
test "$(printf '%s\n' "$cfg03_discovery" | grep -c '@cfg03-backup-matrix')" -gt 0
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment exec playwright test -- \
  --config /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/playwright.config.ts \
  --project=legacy-chromium --project=rust-chromium \
  /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/specs/cfg03-backup-restore.spec.ts \
  --grep "@cfg03-backup-matrix"

npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/shared/resource-limits.test.ts test/unit/shared/settings.test.ts --config config/vitest/vitest.config.ts --run
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml -p freshell-protocol

npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/resource-control-capability.test.ts test/unit/server/resource-control-settings.test.ts \
  test/unit/server/resource-control-control-plane.test.ts test/integration/server/settings-api.test.ts \
  test/integration/server/platform-api.test.ts --config config/vitest/vitest.server.config.ts --run

cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-resource-control --test lifecycle
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-server --test resource_containment_settings
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-resource-control -p freshell-server resource_containment

npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/client/components/RuntimeSettings.resource-limits.test.tsx \
  test/unit/client/components/SettingsView.core.test.tsx --config config/vitest/vitest.config.ts --run
settings_discovery="$(npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment exec playwright test -- \
  --config /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/playwright.config.ts \
  --project=legacy-chromium --project=rust-chromium \
  /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/specs/settings-live-reload.spec.ts \
  --grep "@resource-containment-settings" --list)"
test "$(printf '%s\n' "$settings_discovery" | grep -c '@resource-containment-settings')" -gt 0
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment exec playwright test -- \
  --config /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/playwright.config.ts \
  --project=legacy-chromium --project=rust-chromium \
  /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/specs/settings-live-reload.spec.ts \
  --grep "@resource-containment-settings"

npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/resource-control-systemd.test.ts test/unit/server/resource-control-controller.test.ts \
  test/unit/server/resource-control-lifecycle.test.ts --config config/vitest/vitest.server.config.ts --run
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-resource-control

npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/terminal-resource-control.test.ts test/unit/server/resource-control-spawn-architecture.test.ts \
  --config config/vitest/vitest.server.config.ts --run
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-terminal -p freshell-ws launch
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  --locked -p freshell-resource-control --test launch_architecture

npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/codex-resource-control.test.ts test/server/agent-tabs-write.test.ts \
  --config config/vitest/vitest.server.config.ts --run
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-codex -p freshell-ws -p freshell-freshagent resource_containment

npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/fresh-agent/resource-control.test.ts test/unit/server/sdk-bridge.test.ts \
  --config config/vitest/vitest.server.config.ts --run
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-freshagent resource_containment

npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/fresh-agent/opencode-serve-manager.test.ts test/unit/server/resource-control-spawn-architecture.test.ts \
  --config config/vitest/vitest.server.config.ts --run
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-opencode -p freshell-freshagent resource_containment
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  --locked -p freshell-resource-control --test launch_architecture

npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/resource-control-snapshot.test.ts test/integration/server/resource-containment-mixed-version.test.ts \
  --config config/vitest/vitest.server.config.ts --run
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml -p freshell-protocol
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment exec playwright test -- \
  --config /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/playwright.config.ts --project=legacy-chromium --project=rust-chromium \
  /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/specs/resource-containment-mixed-version.spec.ts

npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/resource-control-actions.test.ts test/unit/server/resource-control-router.test.ts \
  --config config/vitest/vitest.server.config.ts --run
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/client/components/ResourceContainmentModal.test.tsx test/unit/client/resource-containment-ui.test.tsx \
  --config config/vitest/vitest.config.ts --run
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-server -p freshell-ws resource_containment
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment exec playwright test -- \
  --config /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/playwright.config.ts --project=legacy-chromium --project=rust-chromium \
  /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/e2e-browser/specs/resource-containment-ui.spec.ts

npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/unit/server/resource-control-pressure.test.ts test/integration/server/resource-containment-scale.test.ts \
  --config config/vitest/vitest.server.config.ts --run
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-resource-control pressure

npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/integration/server/resource-containment-shutdown.test.ts --config config/vitest/vitest.server.config.ts --run
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml -p freshell-ws --test auto_resume_shutdown
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml -p freshell-server --test resource_containment_concurrency
cargo +1.96.0 test --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml -p freshell-server --test resource_containment_shutdown
```

Expected: every literal focused suite from Tasks 2–16 exits 0, including Task 5’s mandated cross-package `-p freshell-resource-control -p freshell-server resource_containment` command; both label-filter discovery assertions find a positive test count; all absolute config/spec Playwright invocations pass in both browser projects; any failure returns to the named owning task before Task 17 continues.
- [ ] Run the final non-live block after the coordinator is free:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:status

cargo +1.96.0 fmt \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  --all --check
cargo +1.96.0 clippy \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  --workspace --all-targets -- -D warnings
cargo +1.96.0 clippy \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-codex --features real-transport --all-targets -- -D warnings
cargo +1.96.0 clippy \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-opencode --features real-transport --all-targets -- -D warnings
cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  --workspace

npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run lint
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run typecheck
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run contract:generate
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add \
  port/contract/README.md \
  port/contract/ws-protocol.schema.json \
  port/contract/ws-server-messages.schema.json \
  port/contract/ws-message-inventory.json
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run contract:generate
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment diff --exit-code -- port/contract
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment diff --cached --exit-code -- port/contract
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:port

FRESHELL_E2E_BACKEND=local \
  npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:e2e:local -- \
  --grep "resource containment"

FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 \
  npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  run test/integration/real/ --config config/vitest/vitest.server.config.ts

FRESHELL_TEST_SUMMARY="resource containment final verification" \
  npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run check
```

Expected: PASS. If status reports a foreign holder, wait and rerun status before the coordinated command. Contract generation runs twice around exact staging; both working-tree and cached `port/contract` diff checks exit 0, proving Task 17 introduces no generated change. Unavailable provider credentials/binaries are a release gap.

- [ ] **Real time-proof prerequisite:** With fresh explicit approval, revert the disposable VM and rerun the same literal production-clock subprotocol before the final RC-LIVE matrix. It writes final content-addressed Node/Rust time refs into the proof index; no fake clock or host-only pause is accepted.

```bash
set -euo pipefail
test -s "/run/user/$(id -u)/freshell-rc-live-approval"
FRESHELL_RC_LIVE_APPROVAL_FILE="/run/user/$(id -u)/freshell-rc-live-approval" \
FRESHELL_RC_VM_DOMAIN=freshell-rc-live-disposable \
FRESHELL_RC_VM_SNAPSHOT=systemd255-clean \
FRESHELL_RC_VM_SSH=freshell-rc-live-disposable \
FRESHELL_RC_VM_SUSPEND_SECONDS=12 \
FRESHELL_RC_VM_WALL_JUMP_SECONDS=3600 \
FRESHELL_RC_PROOF_INDEX=/tmp/freshell-resource-containment-proof-index.json \
  npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment exec tsx -- \
  /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/helpers/resource-control-live.ts time-discontinuity
```

Expected: PASS for both production clock sources, actual forward/backward guest wall jumps, actual guest PM suspend/resume, excluded policy elapsed time, no catch-up burst, and post-resume complete monitor cycles. Missing/skipped/unavailable evidence blocks the matrix and release.

- [ ] **Evidence gate:** With explicit approval, unique `FRESHELL_HOME`, owned prefixes, host metadata, and zero-leftover checks, run this complete literal manifest matrix. The §9.1 command bytes below remain authoritative; selected allocator tests produce real scale/paused refs without added flags or filters:

```bash
# RC-LIVE-00
FRESHELL_RUN_REAL_RESOURCE_CONTROL=1 \
  npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/integration/real/resource-control-feasibility.test.ts \
  --config config/vitest/vitest.server.config.ts --run

# RC-LIVE-01
FRESHELL_RUN_REAL_RESOURCE_CONTROL=1 \
  npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/integration/real/resource-control-node-systemd.test.ts \
  --config config/vitest/vitest.server.config.ts --run

# RC-LIVE-02
cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-resource-control --test live_systemd -- --ignored --nocapture

# RC-LIVE-03
FRESHELL_RUN_REAL_RESOURCE_CONTROL=1 \
  npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/integration/real/resource-control-node-owners.test.ts \
  --config config/vitest/vitest.server.config.ts --run -t "node-pty|codingcli"

# RC-LIVE-04
cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-terminal --test live_resource_control_pty -- --ignored --nocapture

# RC-LIVE-05: Node managed Codex pair
FRESHELL_RUN_REAL_RESOURCE_CONTROL=1 \
  npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/integration/real/resource-control-node-owners.test.ts \
  --config config/vitest/vitest.server.config.ts --run -t "managed Codex"

# RC-LIVE-06: Rust managed Codex pair
cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-codex --test live_resource_control -- --ignored --nocapture

# RC-LIVE-07 and RC-LIVE-08: Node SDK + Fresh Codex
FRESHELL_RUN_REAL_RESOURCE_CONTROL=1 \
  npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/integration/real/resource-control-node-owners.test.ts \
  --config config/vitest/vitest.server.config.ts --run -t "Claude SDK|Fresh Codex"

# RC-LIVE-09: Rust fresh child
cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-freshagent --test live_resource_control -- --ignored --nocapture

# RC-LIVE-10: Node shared OpenCode
FRESHELL_RUN_REAL_RESOURCE_CONTROL=1 \
  npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/integration/real/resource-control-node-owners.test.ts \
  --config config/vitest/vitest.server.config.ts --run -t "shared OpenCode"

# RC-LIVE-11: Rust shared OpenCode
cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-opencode --test live_resource_control -- --ignored --nocapture

# RC-LIVE-12: Node allocator efficacy + isolated leaf OOM
FRESHELL_RUN_REAL_RESOURCE_CONTROL=1 FRESHELL_RUN_DESTRUCTIVE_RESOURCE_CONTROL=1 \
  npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/integration/real/resource-control-node-systemd.test.ts \
  --config config/vitest/vitest.server.config.ts --run -t "allocator efficacy|leaf OOM"

# RC-LIVE-13a: Rust allocator efficacy
FRESHELL_RUN_DESTRUCTIVE_RESOURCE_CONTROL=1 \
  cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-resource-control --test live_systemd allocator_efficacy -- --ignored --nocapture

# RC-LIVE-13b: Rust isolated leaf OOM
FRESHELL_RUN_DESTRUCTIVE_RESOURCE_CONTROL=1 \
  cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-resource-control --test live_systemd leaf_oom -- --ignored --nocapture

# RC-LIVE-14: Node crash adoption + live shutdown
FRESHELL_RUN_REAL_RESOURCE_CONTROL=1 \
  npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/integration/real/resource-control-node-owners.test.ts \
  --config config/vitest/vitest.server.config.ts --run -t "crash adoption|shutdown drain"

# RC-LIVE-15: Rust adoption + supervisor drain
FRESHELL_RUN_REAL_RESOURCE_CONTROL=1 \
  cargo +1.96.0 test \
  --manifest-path /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/Cargo.toml \
  -p freshell-server --test resource_containment_shutdown -- --ignored --nocapture
```

Expected: the exact mapped command sequence passes byte-for-byte: one shared invocation supplies the distinct RC-LIVE-07 and RC-LIVE-08 rows, and ordered RC-LIVE-13a plus RC-LIVE-13b jointly supply the single RC-LIVE-13 row. Their selected allocator cases run the real production monitor/controller at aggregate + 64 real leaves and produce scale/no-overlap/budget, paused-sampling, effectiveness/reassessment refs; the OOM cases produce real local-counter refs.

- [ ] Build all sixteen canonical gate-keyed sidecar entries, merge RC-LIVE-12/13 run results with their hash-addressed artifacts, validate both execution-window fields and every embedded provenance field against the current signed approval/run and prospective eleven-field row metadata, reject duplicate/missing/extra mappings, then write the checked-in proof index used by acceptance:

```bash
FRESHELL_RC_PROOF_INDEX=/tmp/freshell-resource-containment-proof-index.json \
  npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment exec tsx -- \
  /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/helpers/resource-control-live.ts validate-proof-index \
  --gates RC-LIVE-12,RC-LIVE-13 \
  --output /home/dan/code/freshell/.worktrees/coding-agent-resource-containment/test/evidence/resource-containment-proof-index.json
```

Expected: PASS only when the duplicate-key-aware proof-index parser finds exactly one canonical entry for each RC-LIVE-00–15 key, RC-LIVE-12/13 each map exactly four unique hashes, all other entries map `[]`, the artifact map contains exactly those eight objects, every artifact body/hash/measurement validates, and both canonical execution-window fields match the signed scope and current run with proof timestamps inside the window. The proof index validates before the exact sixteen eleven-field rows are derived in ascending order, each with literal PASS and `leftovers:[]`. Missing, extra, duplicate, out-of-order, rewritten, stale, reused, mismatched, fake, unavailable, skipped, failed, proofless, or survivor-bearing evidence blocks release.
- [ ] **GREEN:** Run the final acceptance/docs/schema command literally:

```bash
npm --prefix /home/dan/code/freshell/.worktrees/coding-agent-resource-containment run test:vitest -- \
  test/integration/server/resource-containment.test.ts \
  test/unit/docs/resource-containment-copy.test.ts \
  --config config/vitest/vitest.server.config.ts --run
```

Expected: PASS only after compatibility deployment, every focused suite from Tasks 2–16, both browser legs, provider contracts, and the exact sixteen-row eleven-field manifest pass. Before row derivation, the separate proof index must have exactly one entry per gate; RC-LIVE-12/13 entries each map four current-approval/run-window-bound hashes, all other entries map `[]`, every embedded field/hash/measurement matches current execution and prospective row metadata, the time artifacts have `actualGuestPmSuspend:true`, and no hash/run/execution was previously accepted. Every row has `leftovers:[]`; missing, extra, duplicate, stale, reused, mismatched, skipped, unavailable, false-PM, or fake proof is a release failure.

**Commit:**

```bash
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment add test/integration/server/resource-containment.test.ts test/e2e-browser/specs/resource-containment-ui.spec.ts test/e2e-browser/specs/resource-containment-mixed-version.spec.ts test/helpers/resource-control-evidence.ts test/evidence/resource-containment.schema.json test/evidence/resource-containment-manifest.json test/evidence/resource-containment-proof-index.json test/unit/docs/resource-containment-copy.test.ts README.md docs/index.html AGENTS.md
git -C /home/dan/code/freshell/.worktrees/coding-agent-resource-containment commit -F - <<'EOF'
test(resource-control): prove durability ownership pressure and boundary docs

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
```

Task 17 stages tests/helpers/docs/evidence only. No production source is allowed in this commit.

## Backend × Owner Evidence Matrix

| Gate | Backend | Production owner/control path | Minimum real proof |
|---|---|---|---|
| RC-LIVE-00 | neutral/direct | installed systemd package | Complete Phase-0 feasibility and frozen sentinel |
| RC-LIVE-01 | Node | production systemd controller | topology, normalization, attach, freeze/thaw, population, revert, reconcile |
| RC-LIVE-02 | Rust | production systemd controller | same outcomes independently |
| RC-LIVE-03 | Node | node-pty terminal + `codingcli.create` | argv/cwd/env/TTY/I/O/resize/cancel/readiness/membership/cleanup |
| RC-LIVE-04 | Rust | portable-pty WS/REST terminal | same plus provisional publication and truthful unknown exit |
| RC-LIVE-05 | Node | managed Codex sidecar+PTY | two scopes/one leaf, joint commit, stop, retained adoption, explicit-resume recovery PTY scope |
| RC-LIVE-06 | Rust | managed Codex sidecar+PTY | same plus joined worker and no automatic recovery spawn |
| RC-LIVE-07 | Node | Claude/Kilroy SDK spawn hook | frozen preparation before SDK execution, stdio/readiness/cancel |
| RC-LIVE-08 | Node | Fresh Codex native child | native spawn/exit/cancel/cleanup |
| RC-LIVE-09 | Rust | fresh-agent Tokio child | native spawn/exit/cancel/cleanup |
| RC-LIVE-10 | Node | shared OpenCode service | generation loss, all attachments, replacement, pause, reopenable completed history, interrupted active response, cleanup |
| RC-LIVE-11 | Rust | shared OpenCode service | generation watcher, stale callback, attachment handoff, reopenable completed history, no automatic active continuation, cleanup |
| RC-LIVE-12 | Node | production actor/monitor/observation using real cgroups and `process.hrtime.bigint()` | its sidecar entry maps four current signed-approval/run-window-bound artifacts for exact allocator/OOM command, aggregate + 64 leaves, >=100 actor-acknowledged cycles, single-flight/one actor turn, 500/750-ms p99, >=3 frozen-leaf samples, reassessment, local OOM/ambiguous, and actual wall jumps/guest PM suspend with `actualGuestPmSuspend:true`; the manifest row stays eleven fields |
| RC-LIVE-13 | Rust | production actor/monitor/observation using real cgroups and `std::time::Instant` | its sidecar entry independently binds four artifacts and exact ordered 13a/13b to the same provenance, execution window, scale, no-overlap/budget, paused/reassessment, OOM, and true guest-PM time outcomes; hashes/run/execution IDs must be fresh and the row stays eleven fields |
| RC-LIVE-14 | Node | control plane + journal + shutdown | crash adoption, partial compensation, close/drain/dispose, no late spawn |
| RC-LIVE-15 | Rust | actor/supervisor + journal | same plus every join handle completes |

The matrix is a one-to-one manifest index: its sixteen gate rows serialize to exactly sixteen eleven-field `EvidenceRowV1` objects, in this order, with no missing, extra, or duplicate ID and with `leftovers:[]`. Command cardinality is separate from row cardinality: RC-LIVE-07/08 share one exact command and RC-LIVE-13 aggregates two exact ordered commands, while still producing one row per gate. Every invocation is approval-gated and ownership-isolated, uses unique units and a temporary home, captures host metadata, and asserts no unit/cgroup/drop-in/helper survives. Separately, the proof index has exactly one keyed entry per gate. RC-LIVE-12/13 entries each map four hashes to artifacts whose embedded signed scope, current run/execution window, VM digests, capability, exact command, proof timestamps, host/guest identity, result, and measurements match the current execution and prospective row metadata; other entries map no artifacts. The time artifact requires `actualGuestPmSuspend === true`; no stale/reused/mismatched/fake proof can validate. Task 17 validates the complete sidecar first, then emits the exact §9.1 rows. A browser test is never evidence for RC-LIVE-00–15.

## LB01–LB21 Traceability

LB02 is the sole preserved verified premise. LB01 and LB03–LB21 are plan corrections whose execution-time evidence remains pending.

| ID | Replacement decision | Implementing task(s) | Required evidence |
|---|---|---:|---|
| LB01 | systemd >=255, complete fresh probe, fixed normalization, bounded CLI/cgroupfs, early active gate | 1, 4, 5, 7, 8 | RC-LIVE-00/01/02 |
| LB02 | preserve verified blocking attach-before-exec; forbid `--no-block`; freeze before spawn; package sentinel | 1, 7–12 | RC-LIVE-00 and every owner cell observes blocked sentinel |
| LB03 | `WrappedArgv` only; owner-specific transport/readiness/exit; no lossy universal signal | 9–12, 15 | RC-LIVE-03–11 plus native-exit tests |
| LB04 | population-aware retirement, final evidence pin, retryable compensation/reconciliation | 7, 8, 16 | root-exit descendant, stop-failure retry, crash adoption |
| LB05 | cooperative same-UID Linux-only/non-Windows/non-hostile public boundary | Global, 6, 14, 17 | exact copy tests and docs audits |
| LB06 | no fallback; fresh complete capacity/fingerprint on enable/save/admission; stale absolute values block | 3–6 | C1→C2/unknown/root-change tests |
| LB07 | stable per-home resource domain, same-home Node/Rust singleton, shared aggregate/journal/adoption; separate homes separate | 2, 4, 5, 7, 8, 16 | lock matrix, two-server refusal, survivor adoption |
| LB08 | mandatory typed broker, current inventory, AST/`syn`/negative gates, no owner fail-open | 9–12 | architecture gates plus RC-LIVE-03–11 |
| LB09 | config v2 compatibility floor, lossless unknown preservation, durable replace, honest indeterminate state | 2 | sandbox crash/migration/rollback-floor evidence |
| LB10 | one actor order: Node claim/plan and complete/record mutate only in mailbox turns; Rust external I/O runs in supervisor jobs and returns operation-token completion; no locks/callback reentry across await | 4, 5, 7–12 | linearizability, pending-I/O intake, callback, and actor schedules |
| LB11 | canonical raw integers; enable-only toggle; unavailable disable/repair path | 3, 6 | no-op roundtrip and both-backend browser test |
| LB12 | unconditional protocol v8 and strict 4010 mixed-version behavior | 13 | four-direction mismatch plus v8 success |
| LB13 | stream/revision, stale rejection, five-second replay, send-result close, hard bounds | 13, 17 | dropped-final/reconnect/max-size tests |
| LB14 | prepared frozen owner lease and prepared additional scope: adopted leaves freeze/read back before wrapped argv/staging; publication follows verify/commit/thaw/readiness; compensation remains retryable | 7–12 | boundary faults, recovery-order assertions, and real owner cells |
| LB15 | server launch/generation/content revisions, tombstones, immutable pending, no generic Retry | 11, 14 | layout races and both browser backends |
| LB16 | header auth, origin/fetch policy, target/member revision, nonce, operation idempotency, audit | 14 | real middleware/replay/concurrency tests |
| LB17 | lower Rust actor/watch/client/supervisor: actor only plans/commits typed events, supervisor jobs await ports, weak completion sender forbids cycles/reentry, all joins precede `server.stopped` | 5, 8, 16 | pending-I/O schedules, exact terminal ordering, and RC-LIVE-15 |
| LB18 | Codex retained/adoptable state with explicit-resume recovery PTY prepared by controller freeze/readback before spawn; OpenCode generation watcher, full attachment handoff, reopenable completed history | 7, 8, 10, 12, 16 | RC-LIVE-05/06/10/11 preparation/recovery/history/interruption tests |
| LB19 | stable-or-ambiguous observation, leaf-local OOM, production clocks, paused polling, and escalation eligibility latched by `(all freezes) OR (failed decline)` until critical pressure clears | 15 | focused histories plus mandatory current-approval/run-bound RC-LIVE-12/13 hashed paused-sampling, OOM, and actual suspend/wall-jump artifacts |
| LB20 | hard G/P/M/C/byte caps, suspend-excluding monotonic deadlines, single-flight budgets, iterative effective victims | 13, 15, 17 | mandatory current-run provenance-bound RC-LIVE-12/13 aggregate + 64 real-leaf, >=100-cycle, no-overlap, 500/750-ms p99, effectiveness/reassessment artifacts plus focused cap tests |
| LB21 | active feasibility before contracts; Node/Rust controller and backend×owner gates before commits; final rerun | 1, 7–12, 15, 17 | all RC-LIVE-00–15 non-skipped PASS |

## User-Story and Invariant Traceability

| User outcome/invariant | Exact tasks | Highest-level proof |
|---|---:|---|
| Supported user enables only from complete fresh capability | 3–6 | API histories plus browser settings |
| Fifteen stored integers display/save exactly | 3, 6 | TS/Rust parity, no-op form, both browsers |
| Stale absolute settings never silently recalculate | 3–6 | C1→C2 admission/save histories |
| Enabled settings remain disableable when capability is unavailable | 4–6 | API and both-browser recovery |
| One settings home has one active Node/Rust server and aggregate; separate homes are separate domains | 2, 7, 8, 16 | lock matrix and crash adoption |
| Every broker-managed local-Linux root is contained or denied; typed exclusions remain unchanged | 9–12 | architecture gates and RC-LIVE-03–11 |
| No target executes or publishes before frozen verification and durable commit | 1, 7–12 | sentinel plus every owner cell |
| Every failure compensates all obligations and stays retryable until clean | 7–12, 16 | boundary faults and adoption |
| Server generation/pane-content identity yields exactly three pending choices and no generic Retry | 11, 14 | layout races and both browsers |
| Protocol v8 snapshots converge after loss/reorder/reconnect within five seconds and remain bounded | 13, 17 | mixed/replay/max-frame/browser tests |
| Destructive actions are revision/nonce/member-bound, authenticated, idempotent, and audited | 14 | real middleware and concurrency |
| Sustained leaf pressure warns then pauses on suspend-excluding production monotonic deadlines | 15 | focused policy histories plus current-approval/run-window-bound RC-LIVE-12/13 time artifacts with `actualGuestPmSuspend === true` in the gate-keyed sidecar |
| Paused groups remain supervised; escalation eligibility latches when all effective freezes are attempted OR usage fails to decline, is not cleared by later decline while still critical, then persistent critical pressure may complete a ten-second one-victim epoch | 15 | focused histories plus current-run-window-bound hashed real frozen-leaf sampling and next-cycle reassessment artifacts mapped by both RC-LIVE-12/13 sidecar entries |
| OOM is leaf-local or explicitly unknown/ambiguous | 15 | cross-leaf test plus current-run-window-bound local-counter artifacts mapped by exact RC-LIVE-12 and RC-LIVE-13 sidecar entries |
| Managed Codex/OpenCode preserve only truthfully adoptable/rebindable state; Codex explicit resume freezes/readbacks the adopted leaf before recovery staging; OpenCode completed history reopens; active work becomes interrupted | 7, 8, 10, 12, 16 | RC-LIVE-05/06/10/11 preparation/recovery/history/adoption/interruption tests |
| Shutdown closes admission, drains/retains owners, disposes non-retained units, joins every worker and actor, then emits exactly one terminal `server.stopped` | 16 | exact ordering assertion and RC-LIVE-14/15 |
| Every backend×owner production cell passes before release | 17 | validated sixteen-row manifest plus RC-LIVE-12/13 production-proof index; each ID exactly once and `leftovers:[]` |
| No command deploys or restarts port 3001 | Global, 1–17 | command/cleanup audit |

### Product-Decision Traceability

| ID | Product decision | Implementing task(s) | Highest-level proof |
|---|---|---:|---|
| P01 | Retain fifteen integers and one shared per-home aggregate | 3–5, 7–8, 15 | parity tests, RC-LIVE-01/02, RC-LIVE-12/13 |
| P02 | One UID + canonical-home domain, one active backend, restart adoption | 2, 4–5, 7–8, 16 | cross-backend lock matrix and RC-LIVE-14/15 |
| P03 | Typed execution domains, mandatory broker, static gates | 9–12 | Task-9 AST/`syn` gates and RC-LIVE-03–11 |
| P04 | Exactly fifteen stored integers | 3, 6 | independent TS/Rust literals and both-browser no-op form |
| P05 | Leaf-local OOM or `ambiguous` | 15 | cross-leaf test plus current-approval/run-window-bound hashed local-counter artifacts mapped by exact RC-LIVE-12/13 sidecar entries |
| P06 | Poll paused groups and stop one after each qualified ten-second epoch | 10–12, 15–16 | focused escalation histories plus current-run-window-bound hashed paused-sampling/effectiveness/reassessment artifacts mapped by RC-LIVE-12/13 sidecar entries |
| P07 | systemd 255 product floor | 1, 4–5, 7–8 | RC-LIVE-00/01/02 |
| P08 | Freeze + blocking attach + durable commit + thaw/readiness/publish | 1, 7–12 | Phase-0 sentinel and every production owner cell |
| P09 | Fresh capability on enable/save/admission, no fallback | 3–6 | C1→C2/unavailable histories and settings browser gate |
| P10 | Per-home OS lease plus one actor | 2, 4–5 | Node×Rust refusal and actor linearizability tests |
| P11 | Atomic protocol v8 and 4010 mismatch | 13 | deterministic generation, mismatch integration, both browsers |
| P12 | Whole-document replacement rather than amendment | 17 and this documentation edit | one-file full replacement diff and final plan audit |

### Global-Constraint Traceability

| ID | Global Constraint | Implementing task(s) | Highest-level proof |
|---|---|---:|---|
| GC01 | Absolute worktree commands and required Git prefix | 1–17 | command-literalness audit over every task |
| GC02 | Linux/unified-v2/systemd-user/systemd-255 only; no fallback | 1, 4–5, 7–8, 17 | RC-LIVE-00/01/02 and docs audit |
| GC03 | Cooperative same-UID boundary and typed Windows/external exclusions | 6, 9, 14, 17 | provenance tests, exact copy, both browsers |
| GC04 | Compatibility floor deployed before marker; release after Task 17 evidence | 2, 3, 17 | hard checkpoint plus manifest acceptance |
| GC05 | Config v2, unknown preservation, safe monotonic revision | 2–5 | migration/crash and actor-history tests |
| GC06 | Cross-backend lifetime `flock(2)` and non-Linux fail-closed behavior | 2 | Node×Node/Rust×Rust/Node×Rust matrix |
| GC07 | Temp/write/fsync/rename/dir-fsync for config/journal/backups | 2, 7–8 | sandbox kill boundaries and reconcile tests |
| GC08 | Honest `PERSIST_FAILED` versus `PERSIST_STATE_UNKNOWN` | 2, 4–5 | fault classification/degraded-admission tests |
| GC09 | No measured power-cut claim | 2, 17 | sandbox evidence wording and docs audit |
| GC10 | Exact fifteen integer/value/page constraints | 3, 6 | parity/roundtrip/browser form |
| GC11 | First-enable suggestion from one complete observation; absolute storage | 3–5 | complete-capacity and re-enable tests |
| GC12 | Fresh enable/re-enable/save/admission; disable without probe | 4–6 | actor/API/browser histories |
| GC13 | Numeric lock over every nonterminal state; captured generation survives disable | 4–6, 7–16 | controlled interleavings and lifecycle tests |
| GC14 | One stable aggregate; ordinary/OpenCode leaf policies; separate homes | 3, 7–12, 15 | controller/owner/pressure live cells |
| GC15 | Same/cross-boot reconciliation before admission | 7–8, 16 | reconcile faults and RC-LIVE-14/15 |
| GC16 | Server tokens persisted before creation; none client/wire-authored | 7–8, 13–14 | lifecycle boundary faults and protocol/action tests |
| GC17 | Argv-safe CLI/direct cgroupfs; no shell/exec/nonblocking/D-Bus | 1, 7–8 | RC-LIVE-00/01/02 argv evidence |
| GC18 | Prepare/freeze/attach/verify/commit/thaw/readiness/publish | 7–12 | sentinel and RC-LIVE-03–11 |
| GC19 | Every owned local root typed/brokered; no fail-open | 9–12 | Task-9 AST/`syn` gate and production owners |
| GC20 | Preserve each owner transport/readiness/native-exit contract | 9–12, 15 | RC-LIVE-03–11 and native-exit tests |
| GC21 | Root exit is not release; final evidence/population/cleanup first | 7–8, 16 | descendant, compensation, adoption cells |
| GC22 | v8, 4010, bounded revision/replay, 4008 | 13, 17 | mixed matrix, replay/send-result, both browsers |
| GC23 | Suspend-excluding monotonic deadlines; client display non-authoritative | 13, 15 | current-approval/run-window-bound hashed RC-LIVE-12/13 actual guest PM suspend/resume and wall-jump artifacts with `actualGuestPmSuspend === true`, sidecar mappings, plus reducers |
| GC24 | Stable same-leaf OOM only; otherwise ambiguous | 15 | cross-leaf test plus current-run-window-bound hashed local-counter artifacts mapped by exact RC-LIVE-12/13 sidecar entries |
| GC25 | Paused polling, pause generation, qualified ten-second one-victim escalation | 10–12, 15–16 | focused histories plus current-run-window-bound hashed RC-LIVE-12/13 frozen-leaf/effectiveness/reassessment artifacts mapped by the sidecar |
| GC26 | Literal group/pending/member/label/recipe/journal/wire/idempotency/WS caps | 4–5, 12–15, 17 | scale/max-frame/manifest tests |
| GC27 | Single-flight one-second monitor and p99 budgets | 15, 17 | current-approval/run-window-bound hashed RC-LIVE-12/13 aggregate + 64 real-leaf, >=100 actor-acknowledged-cycle, `maxInFlight=1`, `maxConcurrentActorTurns=1`, zero-burst, 500/750-ms p99 artifacts mapped by the sidecar |
| GC28 | Sandbox/approval/isolation/cleanup safety; no port 3001 | 1–2, 7–17 | gate command audit and sixteen-row manifest with `leftovers:[]` |
| GC29 | Mandatory live cells non-skipped before commit/release; RC-LIVE-12/13 artifacts current-bound and non-reusable | 1, 7–12, 15–17 | owning gates, exact gate-keyed sidecar, embedded execution-window/provenance/hash/freshness validation, unchanged eleven-field manifest |
| GC30 | Broad-test coordinator gate | 17 | literal `test:status` before `check` |
| GC31 | No PR/deploy/service/restart without separate approval | 1–17 | command audit and release documentation |

### Canonical-Contract Traceability

| ID | Canonical contract family | Implementing task(s) | Highest-level proof |
|---|---|---:|---|
| CC01 | Limits, capacity, and config | 2–6 | crash/migration, TS/Rust parity, API/browser tests |
| CC02 | Resource domain and generations | 2, 4–5, 7–16 | lock matrix, actor histories, journal/adoption cells |
| CC03 | Execution classification and admission | 4–5, 9–14 | AST/`syn` gates and RC-LIVE-03–11 |
| CC04 | Argv wrapper and owner recipes | 7–12, 16 | recipe roundtrips and real owner cells |
| CC05 | Owner lifecycle and journal | 7–12, 14, 16 | every lifecycle boundary fault and RC-LIVE-14/15 |
| CC06 | Controller, native exit, observations, deadlines | 1, 7–8, 15–16 | RC-LIVE-00–04/12–15 |
| CC07 | systemd topology and launch order | 1, 7–12 | Phase-0 sentinel, controller and owner cells |
| CC08 | Protocol-v8 snapshots, actions, security, errors | 13–14, 17 | mismatch/replay/middleware/idempotency/browsers |
| CC09 | Pressure, OOM, and escalation | 15 | focused histories plus current-approval/run-window-bound hashed RC-LIVE-12/13 scale/no-overlap/budget, paused/reassessment, OOM, and true guest-PM time artifacts mapped by the sidecar |
| CC10 | Rust actor, supervisor, and shutdown | 5, 8, 14–16 | actor schedules and RC-LIVE-15 |
| CC11 | Codex and OpenCode ownership | 10, 12, 15–16 | recovery-PTY/reopenable-history tests and RC-LIVE-05/06/10/11 |

## Writing-Plans Self-Review Rerun

Eighth-rerun objective evidence: 17/17 tasks; generated Files-inventory validator PASS with `files_sections=17 files_bullets=240 absolute_paths=241 dual_path_bullets=1 unlisted_commit_paths=0`; 45/45 prescribed `export` declarations token-equal plus acceptance-only sidecar/artifact types; traceability P12/12, GC31/31, CC11/11, LB21/21, user outcomes 18/18; 16/16 unique manifest rows with the specification's exact 11 keys and no proof hash; proof index exactly 16 keyed entries with 8 artifacts only under RC-LIVE-12/13; artifact body and `ARTIFACT_KEYS` are field-equal and include both execution-window fields; 17/17 exact commit footers; 59/59 bash fences parse and 220 fence markers balance; placeholder/stale/shortcut matches 0. The §9.1 byte extractor still matches every owning-task and Task-17 RC-LIVE-05–15 stanza. Provenance/hash/freshness and `actualGuestPmSuspend` assertions remain mandatory.

### Item 1 — specification coverage

Plan-completeness PASS after the eighth full rerun. Final traceability contains P01–P12, GC01–GC31, CC01–CC11, LB01–LB21, and all 18 user outcomes; every row names implementing Tasks 1–17 and highest proof. All 17 task sections and every global section were reviewed. The execution-window and manifest/sidecar correction propagates through both double-map rows, canonical acceptance types, Task 15 RED/construction/sealing/GREEN/gates, Task 17 row/schema/proof-index/artifact/freshness validation, matrix, traceability, completion criteria, and this review. §9.1 command bytes and sixteen-row cardinality remain unchanged. Manifest rows are restored to the exact eleven fields; all hashes remain in the gate-keyed sidecar. No affected task was omitted.

### Item 1b — no silent deferrals

Plan-completeness PASS; execution evidence remains pending. The complete Test-Double to Production-Proof Map was rebuilt row-by-row against the backend×owner matrix, owning-task gate, Task-17 rerun, and mandatory proof-index validation.

- Category (a), deterministic inputs that drive production code without claiming external behavior: capability/process/filesystem read fixtures, config fault boundaries, actor mailbox schedules, provider protocol fixtures, seeded exits, journal records, and shutdown schedules.
- Category (b), substitutes that cannot prove production behavior: fake systemd/cgroup ports, mock PTYs, injected clocks, replacement WS/auth/layout implementations, fake pressure snapshots, and the `docs/index.html` visual mock.
- Filesystems, process launchers, PTYs, clocks, controller ports, actor mailboxes, WS frames/senders, auth middleware, layout stores, pressure snapshots, provider fixtures, journal states, shutdown channels, and `docs/index.html` were inventoried. Every category (b) has a production implementation and approval-gated real proof where §8 requires one.
- **Fake control-plane mailbox/clock row resolved:** deterministic mailbox histories remain category (a), but cannot close the clock/monitor seam. Task 15 constructs `CurrentApprovedGateExecutionV1` from the signed scope, copies `executionStartedAt`/`executionWindowEndsAt`, and seals them into every canonical artifact body. Task 17 exact-key parses both fields from scope, run, and artifact; binds them to the current execution; proves run/proof timestamps fall within the approval window; recomputes hashes; requires >=100 actor-acknowledged real cycles and actual guest PM suspend/wall jumps with `actualGuestPmSuspend === true`; and rejects stale/reused/mismatched artifacts.
- **Fake pressure snapshots row resolved:** exact allocator/OOM cases seal real cgroup scale, paused, reassessment, and local-counter measurements in the same current-run-window provenance envelope. Focused snapshots are inputs only. An artifact absent from the one canonical gate mapping, or whose provenance/measurements do not match the current prospective row metadata and approval, cannot satisfy the gate.
- RC-LIVE-12/13 retain exact eleven-field rows with no hashes. `ProductionProofIndexV1.entriesByGateId` separately contains exactly one entry for each RC-LIVE-00–15 key; only RC-LIVE-12/13 map four unique hashes and all other entries map `[]`. Duplicate raw keys, missing/extra/key-mismatched entries, orphan/missing artifacts, wrong proof kinds, and previously accepted hashes/run/execution IDs are rejected before row emission. Shared 07/08 and ordered 13a/13b remain unchanged.
- The managed-Codex fixture still maps to concrete prepare/freeze/readback/verify/commit/thaw production paths; fake mailbox mutation maps to mailbox-only Node turns and Rust operation-token completion. No double remains without a scheduled production implementation and real closure gate.
- RC-LIVE-00–15 were not executed during this documentation rewrite. Item 1b passes for plan completeness only and makes no execution-evidence claim. If execution reveals a missing artifact, record `UNRESOLVED COVERAGE GAP` and stop the owning task/release.

### Item 2 — placeholder and contradicted-contract scan

Plan-completeness PASS. The complete pre-review plan has zero matches for all 9 placeholder/defer phrases, all 15 stale-contract phrases, and cross-task command shortcuts. Every task has concrete fenced implementation content; every bash fence parses. All Playwright paths remain absolute with positive tagged discovery. Task 17 covers every focused suite from Tasks 2–16 and retains Task 5’s exact mandated cross-package command. The live-command audit extracts §9.1 labels and proves byte equivalence at every owning-task and Task-17 occurrence, including combined 07/08 and split 13a/13b. No run step lacks an exact outcome.

### Item 3 — type/interface consistency

Plan-completeness PASS. The 45 prescribed canonical exports remain token-equal. `EvidenceRowV1`, `EVIDENCE_KEYS`, schema properties, JSON example, emitter, and validator all have the exact eleven specification fields. `ProductionProofIndexV1` alone owns gate-to-hash mappings. `ProductionProofArtifactBodyV1` and `ARTIFACT_KEYS` have the same complete field set, including `executionStartedAt` and `executionWindowEndsAt`; constructor, scope, run result, sealer body, parser, and validator all carry both. `artifactHash` covers RFC-8785 canonical body bytes. `TimeDiscontinuityProof.actualGuestPmSuspend: boolean` remains producer-populated and strictly true for PASS. Task 17 validates the complete sidecar before emitting rows, then atomically claims freshness only after the exact manifest matches. Shared 07/08, ordered 13a/13b, `leftovers:[]`, protocol-v8 atomicity, and every task shape remain intact.

### Context-specific Item 4 — evidence and commit boundaries

Plan-completeness PASS. Task 1 remains before systemd-controlled contracts; Task 2 remains the separate compatibility floor; Tasks 7–12 and 15 block on live cells; Task 9 owns the locked static gate and Task 12 reruns it; Task 16 emits `server.stopped` after all joins. Task 15 cannot stage/commit without exact §9.1 results and freshly sealed current-approval/run-window artifact envelopes, including true guest-PM evidence. Task 17 reruns focused suites, the approval-gated time subprotocol, and exact shared-07/08/ordered-13a/13b map; it validates the whole proof index first, derives and validates exactly sixteen eleven-field rows second, then atomically claims freshness. Production defects return to Task 15. All 17 footers and required `git -C` prefixes remain exact.

Plan-structure verdict: PASS only if items 1–4 have no gap.
Execution-evidence verdict: PENDING — RC-LIVE-00–15 and the compatibility-floor deployment occur during plan execution, not during this documentation rewrite.

## Completion Criteria

1. The old 6,227-line plan is replaced by this one coherent document, not an amendment.
2. Every conflict decision is consistent across front matter, constraints, interfaces, tasks, tests, documentation, traceability, and final claims.
3. One shared per-home aggregate is implemented; no machine-wide or separate-home aggregation claim exists.
4. The cooperative Linux-only threat boundary is exact in Global Constraints, Runtime Settings, README requirements, and `docs/index.html` requirements.
5. Phase 0 is first, approval-gated, systemd >=255, and preserves LB02 without broadening it.
6. Config v2 and compatibility-floor deployment precede feature enablement.
7. Exactly fifteen integers remain; no fallback or stale-capacity authorization remains.
8. Settings revision, policy/admission generation, launch/generation, target/member revision, snapshot stream/revision, operation ID, and nonce have distinct roles.
9. Protocol v8 and all mixed-version behavior are final, atomic, and testable.
10. Prepared/frozen owner leases, staged publication, retryable compensation, population release, and startup reconciliation are exact.
11. Spawn coverage is enforced by broker, metadata, static/negative gates and includes `codingcli.create`, every current owner, and typed exclusion.
12. Node mutation occurs only in mailbox turns; Rust ownership is a lower-crate actor/supervisor whose operation-token jobs await external I/O outside actor mutation, return typed completion events, forbid callback reentry, and join on shutdown.
13. Codex/OpenCode retention, generation, and attachment semantics are explicit: Codex recovery PTY requires explicit resume plus controller prepare/frozen readback before staging in the adopted generation; OpenCode completed history remains reopenable; active work never continues transparently.
14. OOM is leaf-local or ambiguous; production clocks exclude suspend; paused work remains supervised; escalation eligibility is the latched OR of all effective freezes attempted or usage failed to decline, persists while critical pressure persists, and permits exact one-victim fresh epochs. Approval-gated RC-LIVE-12/13 sidecar mappings must resolve to current-run-window-bound artifacts demonstrating real maximum-scale monitors/cgroups, real frozen-leaf sampling, and actual guest suspend/wall-clock discontinuities with `actualGuestPmSuspend === true`; focused/fake/stale evidence cannot close them, and no proof hash is added to a manifest row.
15. Every cap, byte bound, cadence, timeout, p99 budget, close code, and error outcome is literal.
16. RC-LIVE-00–15 appear at owning task boundaries and in Task 17 using the byte-exact §9.1 map: combined RC-LIVE-07/08, split ordered RC-LIVE-13a/13b, and exact single commands otherwise. The manifest is exactly sixteen flat eleven-field rows, one per gate with `leftovers:[]`. A separate canonical sidecar has exactly one keyed entry per gate; RC-LIVE-12/13 entries each map four current-run-window-bound artifacts and all others map `[]`. Missing/extra/duplicate mappings; artifact/body-key mismatch; approval/run/execution-window/VM/capability/command/proof-timestamp/host/guest/result/hash mismatch; `actualGuestPmSuspend !== true`; reuse; fake; unavailable; incomplete; reordered; or rewritten evidence is rejected before row emission. Task 16 emits `server.stopped` exactly once after all dispose/joins.
17. P01–P12, GC01–GC31, CC01–CC11, LB01–LB21, and all 18 user outcomes map to tasks and highest proof; LB02 is the sole preserved verified result.
18. Self-review items 1, 1b, 2, 3, and 4 are rerun without the invalid old evidence claim.
19. Every Task 1–17 is implementation-ready with absolute Files, exact Interfaces, concrete RED/GREEN cases, exact commands/outcomes, evidence gate, and focused commit.
20. Documentation-only validation of this plan passes; installation changes only `/home/dan/code/freshell/.worktrees/coding-agent-resource-containment/docs/plans/2026-08-14-coding-agent-resource-containment.md`. No implementation, generated, config, test, live-system, PR, deployment, service, or port-3001 action occurs during the documentation rewrite.

Implementation/release completion requires both a gap-free plan structure and real execution evidence. Until the compatibility-floor deployment and every mandatory RC-LIVE cell exist, execution-evidence status remains PENDING.
