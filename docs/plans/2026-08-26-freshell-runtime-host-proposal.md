# Freshell Runtime Host Proposal

**Date:** 2026-08-26

**Status:** Proposed

**Decision:** Create a separately supervised `freshell-runtime` process and move all live execution ownership out of `freshell-server`.

**Scope:** Rust Freshell on Linux/WSL first, with a transport abstraction that permits a Windows service and named pipe later.

**Supersedes:** The process-lifetime conclusion in [Restart Resilience Architecture Analysis](2026-07-24-restart-resilience-architecture-analysis.md). Its identity, reconciliation, and durable-ledger conclusions remain valid.

## Executive summary

Freshell should split into two local services:

- `freshell-server` remains the network-facing control plane. It owns HTTP and WebSocket authentication, browser protocol handling, tabs and layouts, history/search, settings APIs, and UI projections.
- `freshell-runtime` becomes the execution plane. It owns PTYs, scrollback, coding-agent processes, fresh-agent provider adapters and sidecars, live session leases, pane-to-runtime bindings, pending approvals, and execution events.

The services communicate over a private, versioned Unix-domain socket. Restarting or upgrading `freshell-server` disconnects browsers briefly, but it does not signal, reparent, recreate, or otherwise disturb execution. When the server returns, it reconnects to the same runtime epoch, obtains an authoritative inventory, resumes event subscriptions from cursors, and attaches browsers to the existing runtime IDs. Output produced during the outage is replayed from runtime-owned rings.

This is recommended over extending provider-by-provider resume logic. Resume reconstructs a new process from durable provider state; it cannot preserve an in-flight turn, a shell process tree, PTY state, scrollback, pending approval, or a tool/dev server whose parent was killed. A runtime host preserves those things uniformly and keeps provider resume as the necessary second line of defense for runtime-host or machine restarts.

The split also creates architectural and operational wins beyond restart safety:

- one lifecycle authority replaces several provider-specific survival mechanisms;
- the network server becomes smaller and safer to restart;
- agent workloads receive a separate cgroup, honest resource accounting, and independent CPU, memory, and task controls;
- browser/network faults are isolated from execution faults;
- server restarts no longer cause a provider spawn storm;
- live workload state has a transport-neutral boundary that can later support per-session workers, remote execution, and rolling runtime upgrades.

This proposal deliberately does **not** claim survival across a WSL VM shutdown, machine reboot, `freshell-runtime` restart, or host crash. Existing durable identity and provider-native transcripts remain the recovery path for those events.

## Why change now

### Production evidence from 2026-08-26

The production JSONL log at `~/.freshell/logs/rust-server.jsonl` records a SIGTERM restart in which the server shutdown path retired 12 tracked PTYs: 11 OpenCode terminal panes and one shell. After the browser reconnected, Freshell created nine OpenCode replacement processes with `resume_applied:true` and recreated the shell. Two OpenCode panes had previously emitted `terminal_identity_unresolved`; because no durable provider identity was available, they did not reconstruct.

There are two distinct losses in that incident:

1. **Live execution loss:** all 12 processes and anything in flight inside them stopped. This happened even for the nine OpenCode sessions that later reconstructed successfully.
2. **Durable session-link loss:** two OpenCode panes could not reconstruct because their pane-to-provider identity had never become durable.

The durable pane ledger, identity reconciliation, and exact provider-resume work address the second failure. They do not address the first. Both layers are required.

The same production service snapshot showed roughly 102.6 GB and 4,198 tasks charged to `freshell-rust.service`. Those are cgroup totals, not the Rust server's own RSS or thread count: they included coding agents, their tool processes, development servers, and tests descended from those agents. That distinction is the point. Today the service manager cannot tell the web/control-plane cost from the workload cost, nor place independent limits on them.

### Current ownership makes the loss intentional

The Rust server currently owns every execution manager directly:

- `freshell_ws::WsState` contains `TerminalRegistry`, `FreshCodexState`, `FreshClaudeState`, and `FreshOpencodeState`.
- `TerminalRegistry::kill_all` kills every tracked running PTY during server shutdown.
- `FreshCodexState::shutdown` closes and reaps fresh Codex app-server sidecars.
- `FreshClaudeState::shutdown` terminates Claude sidecars and their CLI descendants.
- `FreshAgentState::shutdown` terminates the shared `opencode serve` sidecar.

This is internally consistent, but it makes a network-server restart an execution-host restart.

The relevant implementation map is:

| Current area | Evidence | Consequence for extraction |
|---|---|---|
| `crates/freshell-ws/src/lib.rs` | `WsState` directly contains all terminal and fresh-agent managers | Introduce a runtime interface here instead of passing concrete registries through the web layer |
| `crates/freshell-terminal/src/registry.rs` | `TerminalRegistry` is connection-independent, has sequenced replay, and delivers through a transport-neutral `FrameSink`; `kill_all` owns shutdown | Reuse the registry core in the runtime and replace its sink adapter rather than rewriting PTY behavior |
| `crates/freshell-server/src/main.rs` | Startup constructs runtime managers and shutdown reaps PTYs/sidecars; terminal Codex has a special retain/reconcile path | Remove execution construction and shutdown ownership from the control plane; consolidate Codex under the runtime |
| `crates/freshell-freshagent/src/{lib,codex,claude,opencode_ws}.rs` | Provider state is mixed with Axum routers, serialized browser frames, and a shared broadcast bus | Split provider-domain commands/events from HTTP and browser transport before crossing IPC |
| `crates/freshell-ws/src/pane_ledger.rs` and `crates/freshell-codex/src/sidecar_store.rs` | Durable records already enforce single-writer locks and reconcile process identity | Move their writer authority with the workload; keep the storage formats initially |
| `installers/systemd/freshell-rust.service` | One service currently supervises the server and all descendants; no separate runtime unit exists | Add an independent unit/cgroup and ensure server restart relationships do not propagate to it |

Terminal-mode Codex has started to prove a different model. Its sidecar store records owned processes, boot reconciliation verifies survivors, and the launch manager can retain an adopted sidecar across server shutdown. That is valuable evidence that process adoption is feasible. It is not yet a general solution:

- it covers one provider adjunct, not PTY masters, shell trees, or other fresh-agent runtimes;
- it requires provider-specific process verification, record reconciliation, and garbage collection;
- the normal systemd `KillMode=control-group` behavior kills all processes remaining in the server's cgroup, regardless of Unix process-group detachment. The installed service uses this behavior, and the repository unit does not override the default. A retained child therefore cannot be treated as restart-safe merely because the server elects not to reap it.

The general fix is to put execution in a different service cgroup and give it a stable owner, rather than teaching each child how to outlive its owner.

### What the July analysis got right—and what changed

The July restart-resilience analysis correctly identified client-authoritative identity as the source of unrecoverable panes and recommended a server-authoritative ledger and reconciliation protocol. That work is still required because provider identity is the fallback after runtime or machine loss.

The July document also accepted that PTYs and sidecars would die with the web server and treated provider resume as the target recovery model. Three facts now justify revisiting that conclusion:

- production evidence shows that successful resume still destroys every in-flight process and turn;
- Codex sidecar reconciliation demonstrates that a restarted server can adopt a surviving runtime when ownership is represented explicitly;
- systemd cgroup behavior shows that reliable survival requires a service boundary, not only process detachment.

This proposal supersedes only the lifetime/ownership conclusion. It depends on, and strengthens, the prior identity work.

## Goals and non-goals

### Goals

1. Restart, crash, or upgrade `freshell-server` without changing any live agent, PTY, provider sidecar, shell descendant, pending approval, or tool process.
2. Reconnect to live runtimes by authoritative runtime ID and replay output/events produced while no server was connected.
3. Make one component the sole writer for execution lifecycle, identity bindings, leases, and sidecar records.
4. Preserve the current browser protocol during the first migration so the split does not require a simultaneous client rewrite.
5. Isolate production, worktree, and test runtime namespaces so a scratch server cannot accidentally control production agents.
6. Provide separate supervision, logging, resource accounting, and resource policy for control-plane and workload processes.
7. Retain durable provider resume for runtime-host restart, WSL shutdown, machine reboot, and crash recovery.
8. Create a clean boundary that can evolve toward per-session workers or remote runtimes without another server-wide extraction.

### Non-goals for the first version

- Surviving a `freshell-runtime` restart or crash with live processes intact.
- Surviving a WSL VM shutdown, machine reboot, kernel failure, or power loss.
- Running agents on a different machine.
- Active-active web servers or multiple concurrent runtime controllers.
- Replacing provider-native transcript stores.
- Changing the browser WebSocket schema except where a runtime-health indication is needed.
- Moving tabs, layouts, history indexing, summaries, or public authentication into the runtime.
- Implementing per-session worker processes in the first extraction.

## Options considered

| Option | Live turn and process continuity | Provider coverage | Operational complexity | Architectural effect |
|---|---|---|---|---|
| Continue improving identity and resume | No; processes are killed and reconstructed | Good where providers expose durable resume | Lowest near-term change | Necessary fallback, but leaves server and execution lifetimes coupled |
| Generalize detached-child adoption | Partial; only adoptable provider sidecars survive, not ordinary PTY masters | Requires custom logic per provider/process type | Grows with every provider | Produces several lifecycle systems and remains vulnerable to cgroup teardown |
| Put terminal panes in tmux | Terminal processes can survive | Terminal modes only; not fresh-agent RPC, events, approvals, or snapshots | Adds an external state model and translation layer | Solves part of PTY ownership while splitting fresh-agent behavior elsewhere |
| Dedicated runtime host | Yes for every workload it owns | Uniform across terminal and fresh-agent modes | Moderate, concentrated protocol/service work | Establishes one execution authority and clean control/execution separation |
| One durable worker per pane/session | Strongest isolation; can survive runtime-daemon replacement | Uniform in principle | Highest process, routing, upgrade, and garbage-collection complexity | Attractive future evolution behind a runtime host |

**Recommendation:** build the dedicated runtime host. Continue the durable identity/resume work as its recovery layer. Treat independently adoptable per-session workers as a later implementation behind the runtime protocol, not as a prerequisite.

Detached-child adoption is a useful bridge and an implementation technique inside the runtime, but it should not become the top-level architecture. `tmux` is similarly useful as prior art for PTY retention and replay, but it cannot represent Freshell's fresh-agent event model.

## Target architecture

```text
                  LAN / VPN / browser
                          |
                 HTTP + WebSocket + auth
                          |
                +---------------------+
                |  freshell-server    |
                |  control plane      |
                |                     |
                | tabs/layout/history |
                | browser projection  |
                +----------+----------+
                           |
                 private versioned IPC
                 Unix socket / named pipe
                           |
                +----------+----------+
                |  freshell-runtime   |
                |  execution plane    |
                |                     |
                | inventory + leases  |
                | event/output replay |
                | pane identity       |
                +----+------+---------+
                     |      |
                PTY trees   fresh-agent adapters
                     |      |
                shell/CLI   Codex / Claude / OpenCode
```

The browser never connects to `freshell-runtime`. The runtime has no TCP listener. `freshell-server` remains the only network trust boundary and translates between the existing browser protocol and the private runtime protocol.

### Control-plane ownership

`freshell-server` should own:

- network listeners, authentication, rate limiting, and browser connection lifecycle;
- the public HTTP, WebSocket, REST orchestration, and MCP surfaces;
- tabs, panes, layouts, device presence, and client registry snapshots;
- settings persistence and validation, while sending an immutable launch-settings snapshot with each runtime creation command;
- session directory/history indexing, search, summaries, and static client serving;
- projection of runtime inventory and events into the existing browser message shapes;
- runtime health presentation and reconnect policy.

### Execution-plane ownership

`freshell-runtime` should own:

- PTY master file descriptors and process trees;
- terminal input, resize, signal, kill, attach, and replay rings;
- terminal-mode provider locators, session association, activity detection, and provider-specific adjunct sidecars;
- fresh Codex, Claude/Kilroy, and OpenCode runtime managers, sidecars, streaming events, snapshots, pending questions/permissions, and interrupts;
- stable live runtime IDs and the mapping from pane identity to runtime identity;
- create idempotency, per-session mutation serialization, and single-writer leases;
- provider session references and the canonical pane identity ledger;
- sidecar/process records, ownership tags, liveness verification, and garbage collection;
- runtime event sequence numbers, replay buffers, and authoritative inventory;
- structured execution logs and process/resource metrics.

The owner of a process must also own every fact used to decide whether that process exists, can be resumed, or may be killed. This avoids the current cross-crate pattern in which a WebSocket state object owns runtime managers while other server components own pieces of identity and recovery.

### Identities must remain distinct

The protocol and stores should use distinct names for four concepts that are currently easy to conflate:

| Identity | Lifetime | Minted by | Purpose |
|---|---|---|---|
| `paneId` | Durable UI/layout lifetime | Control plane/client layout system | Identifies the user's pane |
| `runtimeId` | Lifetime of one live execution | Runtime host | Attach, input, resize, kill, and event routing |
| `sessionRef` | Provider-native durable conversation lifetime | Provider/runtime adapter | Resume after execution loss |
| `createRequestId` | One idempotent creation intent | Caller/control plane | Deduplicate retries; never a durable execution identity |

The runtime also mints a random `runtimeEpoch` on every runtime-host boot. It is independent of the web server's `bootId`. A changed `bootId` with the same `runtimeEpoch` means the control plane restarted and live work should be reattached. A changed `runtimeEpoch` means live runtime continuity was lost and durable reconciliation/resume is required.

## Runtime protocol

### Transport and authentication

On Linux/WSL, use a Unix-domain stream socket beneath `$XDG_RUNTIME_DIR/freshell/<namespace>/runtime.sock`, falling back to a user-private runtime directory only when `XDG_RUNTIME_DIR` is unavailable. The directory and socket must be user-only; the runtime should verify peer UID where the platform exposes peer credentials.

The connection handshake must include:

- protocol major/minor range;
- runtime namespace and instance identity;
- a generated controller credential;
- server `bootId` and requested last-seen cursors;
- runtime `runtimeEpoch`, capabilities, limits, and current controller status.

The namespace/credential prevents accidental cross-attachment by another worktree or test server running as the same user. It is not a hostile same-UID security boundary; a process with the same UID and filesystem access can generally inspect the user's processes and files already. On Windows, use a named pipe with an equivalent user ACL and the same logical handshake.

Use a framed, typed protocol over the stream rather than newline-delimited browser JSON. The envelope must carry an explicit message kind, schema version, request/command ID, and payload length; it must support raw byte fields without base64 expansion. The exact encoding should be selected with a small benchmark before implementation. A length-prefixed MessagePack map is the leading choice because it is compact, byte-friendly, and can evolve by adding ignored fields. The semantic contract is more important than the codec.

### Controller lease and single-writer rule

Version one should permit exactly one mutating control-plane connection per runtime namespace. A live socket holds the controller lease. A second server receives `controller_already_connected` and cannot create, input, kill, approve, or mutate sessions.

When the old server process exits, its socket closure releases the lease immediately and the replacement server can connect. If the server is partitioned but still alive, it remains the controller until the runtime detects connection loss; there is no time-based dual-controller window.

Once a workload kind is configured for external runtime ownership, `freshell-server` must **fail closed** if the runtime is unavailable. It must never silently spawn that workload in-process. Silent fallback would create two potential lifecycle writers and make reconnection capable of duplicating a provider session.

### Commands

Commands should be idempotent by `commandId` and typed by capability. The initial surface is approximately:

- `runtime.create`, `runtime.attach`, `runtime.detach`, `runtime.kill`;
- `terminal.input`, `terminal.resize`, `terminal.signal`;
- `freshAgent.send`, `freshAgent.interrupt`, `freshAgent.answer`, `freshAgent.fork`;
- `runtime.inventory`, `runtime.snapshot`, `runtime.subscribe`;
- `runtime.settingsChanged` only for settings that affect future launches or explicit live reconfiguration.

Create deduplication belongs in the runtime because only the runtime can prove whether a live process was created. A command retry must return the original result, not create a second process. Provider-session mutations must additionally serialize by `sessionRef` so different pane or client request IDs cannot become concurrent writers to one transcript.

### Events, cursors, and replay

Use two related sequence spaces:

1. A runtime-wide monotonic `eventSeq` for lifecycle, identity, activity, approval, status, completion, and error events.
2. A per-runtime `outputSeq` for terminal/output chunks. For terminal panes this should preserve the existing replay-ring sequence semantics rather than introduce a competing cursor.

The runtime keeps a bounded in-memory control-event journal and a bounded output/scrollback ring per runtime. Existing browser terminal cursors remain useful: the server forwards the client's last-applied `sinceSeq` when it reattaches, so the replacement server does not need to guess what xterm already rendered. The runtime also retains controller delivery cursors for low-volume control events across control-plane connections. On reconnect, the server supplies the applicable cursors:

- If the epoch matches and the cursor is retained, the runtime replays the gap.
- If the epoch matches but a cursor fell behind retention, the runtime sends an authoritative inventory/snapshot plus an explicit truncation marker before live delivery.
- If the epoch changed, the server discards live cursors and enters durable reconciliation/resume.

The runtime must not block an agent because the web server or a browser is slow. Subscriber queues are bounded. Terminal output may drop oldest retained bytes with a loud truncation event, matching the existing bounded-scrollback model. Low-volume control edges such as waiting, completion, materialization, and exit receive a separate retention budget and are recoverable from current-state snapshots where possible. Pending approvals live in runtime state and appear in reconnect snapshots; they are not merely transient browser notifications.

No on-disk event journal is required in version one: the runtime itself remains alive during the event gap. Durable metadata and provider transcripts cover runtime loss. Disk-journaling high-volume output would add write amplification without satisfying the live-process guarantee.

### Inventory and reconciliation

The runtime inventory is authoritative for live execution and should include:

- `runtimeEpoch`, `runtimeId`, kind, provider/mode, state, creation time, and process identity;
- bound `paneId`, `sessionRef`, launch settings, cwd, and idempotency key where applicable;
- output cursor/ring bounds;
- active turn, busy/waiting state, and pending approvals/questions;
- sidecar/provider health and degradation state;
- lease/controller attachment state.

On server reconnect, `freshell-server` joins this inventory with layouts and browser pane records. It does not infer liveness from local cached terminal IDs. Existing pane reconciliation can become the browser-facing projection of the runtime's answer rather than a second source of runtime truth.

## Persistent state and recovery layers

The design has two explicit recovery layers:

### Layer 1: live runtime continuity

As long as `freshell-runtime` and the OS instance remain alive, server and browser restarts attach to the same `runtimeId`. No provider resume or process recreation occurs.

### Layer 2: durable reconstruction

If the runtime epoch changes, live PTYs and processes are gone. The runtime uses the pane identity ledger, launch settings, and provider-native `sessionRef` to reconstruct resumable agent panes. Plain shells restart in their recorded context. This is the existing restart-resilience program, moved under the component that now owns execution.

The canonical pane ledger, terminal identity bindings, live leases, and sidecar records must move to the runtime as their workload kinds are externalized. Initially, the implementation can retain the existing atomic per-record stores and exclusive store locks; a storage-format rewrite is not required for the service split. The important migration is writer ownership. Consolidating stores later is reasonable if profiling or operability justifies it.

For every workload kind, there must be exactly one configured writer. During migration, terminal and fresh-agent backends may cut over at different milestones, but no individual provider/kind may be writable by both the in-process and external implementations.

## Service and process model

### systemd

Install two independent user services:

- `freshell-runtime.service` owns the runtime daemon and every workload descendant. `KillMode=control-group` is appropriate here because an explicit runtime stop means execution continuity is ending and no orphan should remain.
- `freshell-rust.service` owns only the network/control-plane process. It may use `Wants=freshell-runtime.service` and `After=freshell-runtime.service`, but not `PartOf=`, `BindsTo=`, or a shared slice whose stop propagates to the runtime.

Restarting `freshell-rust.service` therefore kills only the server cgroup. Agent processes remain in the runtime cgroup with stable PIDs. The server must reconnect if the runtime itself restarts; runtime failure should not require a server restart.

Resource policy can then be set independently:

- conservative `MemoryHigh`, `TasksMax`, `CPUWeight`, and optional `IOWeight` on the runtime;
- a smaller, stricter budget on the server;
- separate journal fields and service-level accounting;
- optional child cgroup/scope partitioning per session later, without changing the browser architecture.

The runtime should expose its own health and readiness over IPC. A TCP health endpoint would weaken the local-only boundary and is unnecessary.

### Detached launcher

`scripts/launch-rust.sh` must support the same separation for installations that do not use systemd. It should launch the runtime in its own session with a distinct pid file and log, then launch the server independently. Normal `--restart` should mean server-only restart. Runtime stop/restart should require a separate, explicit action and should report that it will end live execution.

The launcher must continue validating exact PIDs, executable paths, cwd, namespace, and ports/sockets. It must never infer ownership from a broad process pattern.

### Shutdown semantics

- `freshell-server` shutdown closes browser sockets, stops accepting HTTP, and disconnects from the runtime. It sends no runtime-wide shutdown command.
- `freshell-runtime` shutdown stops accepting creates, persists final metadata, asks owned children to terminate, and reaps the remaining cgroup within a bounded interval. This is an execution-ending operation.
- Machine/WSL shutdown ends both. At next boot, systemd starts the runtime first and durable reconstruction proceeds when the server/browser supplies layout intent.

## Failure behavior

| Failure | Expected behavior |
|---|---|
| Browser reload/disconnect | Current behavior: server and runtime continue; attach/replay on reconnect |
| `freshell-server` graceful restart | Runtime PIDs and turns unchanged; output buffered; reconnect by same epoch |
| `freshell-server` crash/SIGKILL | Same as graceful restart once the socket closes |
| IPC temporarily unavailable | Server shows runtime degraded, rejects mutations, retries with backoff; never spawns locally |
| Runtime queue/output ring overflows | Old output truncated with explicit marker; authoritative current state still supplied |
| Runtime crash/restart | Live processes end with its cgroup; server detects epoch change and uses durable reconstruction |
| Runtime protocol incompatibility | Server fails closed with an actionable version error; no execution mutation |
| Provider sidecar crash | Runtime performs the existing provider-specific recovery and emits degradation/exit state |
| Machine or WSL shutdown | Live execution ends; services return on boot and use durable reconstruction |
| Scratch server targets production namespace | Controller/namespace handshake rejects it; no mutation permitted |

The UI should distinguish “web server reconnecting” from “runtime unavailable” and “live runtime was lost; reconstructing.” A routine server restart should normally appear only as the existing short reconnect state.

## Performance and operational wins

### Avoided restart work

A server restart currently converts every open terminal/fresh-agent pane into a burst of process creation, provider initialization, disk probing, and transcript resume. At scale this is simultaneously the worst time to create load: the server is cold, every browser reconnects, and every pane asks for recovery.

With a runtime host, a server restart performs one IPC handshake, one inventory join, and bounded replay. Provider process births during the restart should be zero. In-flight provider turns continue, shell descendants and development servers keep listening, and scrollback remains warm.

### Smaller control-plane critical path

The server no longer needs to own PTY reader threads, provider transport consumers, approval state, or child reapers. Expensive and failure-prone execution paths move off the network event loop and out of the server's shutdown path. This should reduce server memory variance and make restart duration proportional to browser/control state rather than pane count.

### Honest accounting and containment

Separate cgroups answer questions that are currently ambiguous:

- Is Freshell itself using 100 GB, or are its agents?
- Which service exceeded the task or memory budget?
- Can the web UI remain responsive while an agent workload is CPU-saturated?
- Can a runaway pane be identified and constrained without restarting the control plane?

The first split provides service-level answers. Per-session child cgroups can later add pane-level answers.

### Cost of the IPC hop

Terminal bytes and agent events gain one local IPC hop and, depending on encoding, one additional copy. This is the principal steady-state performance risk. Mitigations are:

- batch adjacent output chunks on a short byte/time budget;
- carry byte arrays without base64;
- keep bounded queues and apply backpressure at the subscriber boundary, not the PTY reader;
- avoid reserializing browser JSON inside the runtime; emit typed domain events and serialize once in the server;
- benchmark before choosing the final codec.

Acceptance budgets should be baseline-relative: no more than 2 ms added p95 local input-to-echo latency under 20 active panes, at least 95% of current sustained aggregate terminal throughput, bounded memory per disconnected terminal, and no provider spawns attributable to a server-only restart.

## Code-shape implications

The extraction should not begin by copying `WsState` into a daemon. It should first separate runtime-domain behavior from Axum/WebSocket delivery.

The terminal crate is the closest to ready. `TerminalRegistry` is connection-independent and its `FrameSink` callback is intentionally transport-agnostic. That callback can feed either the current in-process adapter or the runtime protocol.

The fresh-agent crate needs a stronger split. It currently combines provider state, Axum routers, browser-frame serialization, and the shared Tokio broadcast bus. Refactor it so provider cores accept typed commands and emit typed domain events. Axum REST/WS adapters stay in `freshell-server`; process transports and provider state move to the runtime.

A likely crate shape is:

- `freshell-runtime-core`: typed runtime traits, IDs, commands, events, inventory, and an in-process implementation used during migration/tests;
- `freshell-runtime-protocol`: versioned wire envelopes and codec;
- `freshell-runtime-client`: reconnecting controller client used by `freshell-server`;
- `freshell-runtime`: daemon binary that owns terminal and fresh-agent managers.

This is a suggested boundary, not a requirement to create four crates immediately. The invariant is that browser/Axum types do not become the runtime protocol and execution managers do not depend on a network connection.

## Migration plan

### Phase 0: contract and destructive acceptance harness

Before moving ownership, write the restart contract as tests. Use fake provider processes for the default suite and real-provider contracts only in the existing opt-in lane. Process-kill and restart-storm tests must run through `scripts/sandbox-test.sh`, never against the host service.

Record current latency, throughput, spawn count, memory, task count, and reconnect timings as a baseline.

### Phase 1: introduce an in-process runtime boundary

Create a `RuntimeHost` command/event/inventory interface and adapt `freshell-server` to use an in-process implementation. Move no processes yet and preserve behavior. This phase proves that REST, WS, reconciliation, and tests can depend on the runtime contract rather than concrete registries.

Refactor fresh-agent managers to emit transport-neutral events during this phase. Keep the browser protocol adapter in the server.

### Phase 2: externalize PTYs first

Add the runtime protocol, daemon, reconnecting client, isolated namespace configuration, and separate service/launcher support. Move `TerminalRegistry`, PTY creation, output rings, activity, terminal provider locators, identity association, and terminal sidecar ownership together.

This slice directly fixes the observed OpenCode/shell restart incident and covers every terminal-mode coding agent. Do not leave provider locators or terminal sidecars in the server after their PTY moves; ownership must remain coherent.

Production cutover is all-terminal, not per pane. The in-process terminal fallback is disabled after cutover.

### Phase 3: externalize fresh OpenCode

Move the shared `opencode serve` manager, session materialization, event stream, settings snapshots, and session serialization. OpenCode is a useful first fresh-agent slice because it exercises a shared long-lived provider sidecar and durable database-backed sessions.

### Phase 4: externalize fresh Codex

Move Codex app-server transports, thread state, resume/adoption logic, completion events, snapshots, and existing sidecar records. Consolidate the terminal-Codex special retention path under runtime ownership rather than maintaining two Codex lifecycle authorities.

### Phase 5: externalize fresh Claude/Kilroy

Move Node sidecars, CLI descendants, stdio consumers, pending permission/question state, attach/resume, and transcript snapshots. This is likely the hardest provider because request/approval state currently lives close to the server-side stream consumer; moving it last lets the protocol and reconnect snapshot semantics mature first.

### Phase 6: finish authority transfer and remove fallbacks

Move the remaining pane ledger and sidecar-record writers into the runtime, delete in-process execution construction from production server startup, and make runtime absence/version mismatch a fail-closed health state. Retain in-process implementations only as test fixtures if useful.

Update operational tooling so server deploy/restart is the common safe action and runtime restart is visibly execution-ending.

### Phase 7: optional per-session workers

If runtime upgrades or fault containment later need stronger guarantees, let `freshell-runtime` supervise independently adoptable session workers. The server-facing runtime protocol and browser behavior need not change. This can provide live survival across runtime-daemon replacement and pane-level cgroups without making the first extraction carry that complexity.

## Verification plan

### Required end-to-end restart contract

For each supported pane type—shell, terminal Claude, terminal Codex, terminal OpenCode, fresh Claude/Kilroy, fresh Codex, and fresh OpenCode—the sandbox suite should:

1. create the pane and capture its pane, runtime, provider-session, and process identities;
2. begin a turn or long-running command that produces output on both sides of the restart window;
3. gracefully restart only `freshell-server`;
4. repeat with server SIGKILL;
5. assert agent/provider PIDs and process start times did not change;
6. assert the in-flight operation completed exactly once;
7. assert output produced during the outage replayed in order, with a truncation marker only when the configured bound was intentionally exceeded;
8. assert `runtimeEpoch`, `runtimeId`, and `sessionRef` remained stable while `bootId` changed;
9. assert no duplicate provider writer or replacement process was created;
10. assert the server cgroup has no workload descendants and the runtime cgroup contains them.

Fresh Claude/Kilroy coverage must include a pending approval or question during the server outage. Reconnection must show the still-pending request and answering it must unblock the original turn exactly once.

### Protocol and failure tests

- duplicate commands return the original result;
- concurrent creates for one idempotency key produce one process;
- concurrent mutations for one provider session serialize;
- controller lease rejects a second server;
- scratch/test namespace cannot attach to production;
- server reconnect replays retained event and output cursors;
- cursor gaps produce inventory/snapshot plus explicit truncation;
- runtime epoch change invokes durable reconstruction rather than live attach;
- runtime unavailable and version mismatch fail closed;
- server crash cannot cause the runtime to reap workloads;
- runtime shutdown does reap its owned cgroup and leaves durable records consistent;
- protocol N and the previous compatible server minor version interoperate for rollback.

### Load and performance tests

- restart the server with 20 active agent panes and assert zero provider spawn storm;
- repeat at a higher synthetic PTY count to bound reconnect inventory and replay time;
- compare p50/p95 input-to-echo latency and aggregate output throughput with the in-process baseline;
- disconnect the server for longer than the output-ring window and verify bounded memory plus correct truncation behavior;
- saturate runtime CPU and verify the server remains responsive under its separate resource policy;
- verify service-level memory/task accounting assigns agents and descendants to the runtime, not the server.

## Observability

Both processes must emit structured JSONL logs with stable event names and severity. Runtime events should include `runtimeEpoch`, `runtimeId`, kind/provider, command ID, controller boot ID where relevant, queue/ring bounds, and duration. Do not log prompts, terminal content, credentials, or raw provider payloads by default.

Minimum runtime signals:

- controller connected/disconnected/rejected and protocol negotiation result;
- active runtimes by kind/provider/state;
- child PID/start identity and verified ownership transitions;
- create/dedup/attach/kill outcomes;
- output and control journal bytes, cursors, drops, and truncations;
- pending approval count and age;
- provider-sidecar health and recovery outcome;
- IPC request latency and queue depth;
- runtime process/cgroup CPU, memory, and task counts where available;
- runtime shutdown reason and number of reaped workloads.

`freshell-server` should log runtime connection state and inventory/replay timings but not duplicate every execution event at info level. Debug/performance logging can expose sampled flow details when explicitly enabled.

## Deployment and rollback

The initial production deployment should be staged:

1. ship runtime-aware server code with the in-process backend still selected;
2. install the runtime binary and independent service/launcher support;
3. start the runtime with a production namespace and verify IPC health while it owns no workloads;
4. restart only the server with all terminal ownership switched to external;
5. verify PID/cgroup placement and run the restart contract before moving fresh-agent providers;
6. cut over fresh providers one at a time in later releases.

Every cutover must preserve a rollback version of `freshell-server` that understands the same runtime protocol. Rolling back to a pre-runtime server while live external workloads exist is not safe: it could neither attach to them nor prove it was the sole writer. If an incompatible rollback is unavoidable, it is an explicit execution-ending maintenance event, not an automatic fallback.

Protocol major changes require either an N/N-1 compatibility window or a drain of live runtimes. Minor additions must be capability-negotiated and ignore unknown fields.

## Risks and mitigations

### The runtime becomes a concentrated failure domain

That is intentional: it makes the existing execution failure domain explicit and independently supervised. Keep provider adapters isolated internally, catch task panics, bound queues/maps, and make runtime health observable. Per-session workers remain the path to finer fault domains.

### Dual writers during migration

This is the highest correctness risk. Enforce exclusive store locks, a single controller lease, provider/kind-wide backend selection, and no automatic local fallback. Tests must attempt the split-brain cases directly.

### IPC version skew blocks server startup

Use capability negotiation and an N/N-1 minor compatibility policy. Fail closed with an actionable health error rather than executing under an unknown contract.

### Extra latency and copying

Use byte-friendly framing, batching, bounded queues, and baseline-relative performance gates. Keep browser serialization in the server so the runtime emits domain events only once.

### Tests or worktrees attach to production

Make namespace, socket path, controller credential, data root, and ownership locks explicit inputs. Test harnesses create unique temporary values. A non-main worktree must never inherit the production runtime namespace implicitly.

### Runtime restart still loses in-flight work

State this boundary clearly in operations and UI. Runtime deploys require drain/maintenance until per-session worker handoff exists. Durable provider identity minimizes conversation loss but cannot preserve arbitrary process state.

## Decision record

Adopt `freshell-runtime` as the target owner of all live execution. Keep `freshell-server` as the sole network-facing control plane. Connect them through a private, versioned, single-controller IPC protocol. Move terminal execution first, then fresh-agent providers, and remove in-process production fallbacks after each ownership cutover.

This is the smallest architecture that uniformly satisfies the actual requirement: **a web/server restart must not be an agent-runtime restart**. It also preserves the work already invested in durable identity by assigning it the correct role—recovery from execution-host loss, rather than a substitute for live continuity.
