# Managed agent runtime architecture

This document describes the Phase 1 durable ownership boundary and the Phase 2
managed-terminal path implemented by `freshell-supervisor`,
`freshell-session-host`, `freshell-runtime-protocol`, and
`freshell-runtime-client`. Managed routing is explicit/opt-in: only the Rust
server built with `managed-runtime-v1`, booted with the runtime controller, and
a client that negotiated `managedRuntimeV1` can use it. Other routes remain
legacy.

## Identity and authority

A **soul** is the durable logical coding-agent identity. An **incarnation** is a
particular runtime process/container that may be replaced without losing the
soul. A pane is a view and is not process ownership.

The supervisor is the only component allowed to turn a durable registry row
into an `OwnedRuntimeHandle`. That Rust type has no public constructor. Backend
mutation methods accept this capability rather than a PID, process name,
label, cwd, environment tag, or caller-supplied container id. Docker labels are
bookkeeping only.

Phase 1 registry storage is SQLite with foreign keys, WAL, `synchronous=FULL`,
a single-supervisor flock, an installation ID, monotonically increasing control
epoch, command request-id/digest deduplication, and unique active-incarnation
constraints. Newer/unknown schema versions and integrity failures fail closed.
All SQLite calls run on the registry's dedicated blocking executor rather than
Tokio's async I/O loop.

The initial schema is installed transactionally and contains `installation`,
`souls`, `incarnations`, `writer_claims`, `commands`, `recovery_attempts`,
`outbox`, and `stop_tombstones`. An active-incarnation partial unique index
covers `prepared`, `created`, `starting`, `running`, and `stopping`; a failed
stop therefore keeps the ownership claim instead of making a replacement look
safe. Raw credentials are not stored in these tables.

## Launch transaction

Managed launch is intentionally staged:

1. Commit `PREPARED` launch intent and request digest.
2. Ask Docker to **create, not start**, an isolated container with resource limits.
3. Commit exact Docker daemon identity, full 64-character container ID, image identity, mounts, and immutable-config digest.
4. Start only the trusted session host.
5. Challenge/response authenticate that host and read effective cgroup limits.
6. Commit an execution grant with control epoch, host boot ID, generation, and grant ID.
7. Enable the long-lived restart policy and deliver the already-durable grant.
8. The host durably consumes a grant at most once for a host boot, then launches the fixture/provider worker.
9. Mark the incarnation `RUNNING` only after the host acknowledges the worker.

A crash after Docker create but before container-ID commit can leave a stopped
candidate; because it never received a grant it cannot run agent code. The test
broker retains an independent exact receipt so the test owner can clean it.

### Launch state diagram

```text
          registry commit
NEW ───────────────► PREPARED
                       │
                       │ Docker create only (restart=no; provider cannot run)
                       ▼
                    CREATED
                       │
                       │ exact daemon/container identity committed
                       │ host starts + authenticates + limits verified
                       ▼
                    STARTING
                       │
                       │ execution grant committed BEFORE delivery
                       │ host durably consumes that grant at most once/boot
                       ▼
                    RUNNING

Any failure before RUNNING stays represented by durable ownership evidence.
A new hostBootId cannot replay an old grant; it waits for reconciliation.
```

## Stop transaction

Stop commits desired state and a stop tombstone before any signal. It then asks
the authenticated host to stop gracefully, requests stop for the exact recorded
Docker object, escalates only through that exact object, and verifies the
container is absent/exited/dead before persisting `VerifiedEmpty`.

`BlockedOwnership`, `BackendUnavailable`, and `TerminationUnconfirmed` retain
ownership evidence. Sending a signal or receiving a Docker error is never
translated into "reaped".

### Stop state diagram

```text
RUNNING (or other potentially-active state)
   │
   │ commit desiredState=STOPPED + increment intentRevision + stop tombstone
   ▼
STOPPING / cleanup=PENDING
   │
   ├─ ownership/config mismatch ───────► BLOCKED_OWNERSHIP   (record retained)
   ├─ Docker unavailable ──────────────► BACKEND_UNAVAILABLE (record retained)
   ├─ stop/kill cannot prove empty ────► TERMINATION_UNCONFIRMED (record retained)
   │
   └─ exact enclosure positively absent/exited/dead
                                      ▼
                           STOPPED / VERIFIED_EMPTY
                                      │
                                      └─ only here may writer/resource claims release
```

## Isolation boundary

The Docker backend requires exact `sha256:` image identity. Phase 1 fixture
workloads use `NetworkMode=none`; Phase 2 terminal workloads use an isolated
container bridge network so real providers can reach their upstream services.
Both require:

- private PID namespace;
- read-only root filesystem with a bounded `/tmp` tmpfs;
- fixture workloads drop all Linux capabilities; terminal workloads drop all and add only `CHOWN`/`SETUID`/`SETGID` to the trusted host, while the provider PTY runs as uid `65534`, gid `0`, with zero effective/permitted/inheritable/ambient capabilities and `no-new-privileges`;
- explicit CPU, memory, swap, and PID limits;
- the read-only host binary and one incarnation control directory;
- for terminals only, canonical same-path workspace/Git-common-dir mounts plus
  one named provider-home volume per soul;
- optional provider bootstrap files mounted read-only by exact canonical file
  reference and copied atomically into the provider volume with mode `0600`;
- no Docker socket, supervisor registry, admin socket, unrelated home, or
  production port exposure.

The live test runner owns the real rootless Docker socket. The SUT supervisor
sees only a restricted Unix-socket proxy. The proxy forwards create/inspect/
start/stop/update operations only for exact full container IDs it issued during
the current test run. A proxy refusal of an unsafe destructive SUT request is a
gate **failure**, not a pass.

## Protocol

Control frames are versioned, length-prefixed JSON with a 1 MiB limit. Web/admin
and supervisor/runtime roles are distinct. Each incarnation gets a secret known
only to the supervisor and its host. Host hello uses a random challenge and an
HMAC scoped to the host boot ID and incarnation; subsequent host commands use a
separate authenticated proof. Control epochs fence old supervisors and execution
generations fence stale grants.

## Legacy Codex hardening

Phase 1 also closes two pre-existing gaps before the new runtime is used in
production:

- A retained Codex app-server whose durable ownership row cannot be written is
  now terminated via the exact `Child` handle and the launch fails. It can no
  longer continue detached and untracked.
- A sidecar sweep reports `Reaped` only after positive disappearance evidence
  for the captured tree. Identity decay, refused escalation, or other uncertain
  outcomes retain the ownership row as `termination-unconfirmed`.

The old environment-tag `/proc` scan remains in legacy cleanup code, but the
new supervisor never uses it as kill authority. In the hardened sweep the tag
scan is verification-only after exact recorded-PID handling.

## Provider acceptance order and test-cost policy

The execution order was revised after the initial Phase 2 shell/Claude implementation: **OpenCode is the first real coding-provider acceptance lane** because its free-tier path makes repeated restart/resource/recovery testing sustainable. The existing shell/Claude wiring on this branch is transitional infrastructure, not permission to declare the provider portion of Phase 2 complete before the OpenCode live gate passes.

For managed OpenCode, strict per-soul resource isolation requires **one OpenCode provider runtime per soul**. The legacy shared `OpencodeServeManager` is not a valid backing for two managed souls because a shared process cannot satisfy independent hard memory/CPU limits.

Routine real-provider tests use these cost controls:

- OpenCode: free-tier path first/default, with the resolved provider/model recorded.
- Claude: **Haiku**, lowest available thinking/reasoning setting.
- Codex: **GPT-5.6 Luna**, lowest available thinking/reasoning setting.

No gate may silently upgrade to a more expensive model or higher reasoning level. If the required low-cost model/configuration is unavailable, the lane is `BLOCKED` unless the test is explicitly about another model; such an override must be named in the scenario and recorded in evidence. Provider receipts record the actual model and reasoning/thinking setting when exposed by the provider.

## Phase 2 managed terminal routing

Phase 2 wires `freshell-runtime-client` into the Rust server behind the Cargo
feature `managed-runtime-v1`. At runtime, `FRESHELL_MANAGED_RUNTIME_V1=1` plus
a healthy authenticated supervisor is required before the server advertises
`ready.capabilities.managedRuntimeV1`. The client must opt in on the same
connection. Feature-off, controller-unavailable, Node-server, and non-negotiated
connections stay byte-for-byte on their legacy ownership path.

The current transitional implementation has negotiated **shell and Claude CLI terminals** using a browser-facing
`TerminalRegistry` facade with no `PtyTerminal`/OS kill handle. The session host
owns the PTY reader/writer/waiter and continuously drains output into a bounded
1 MiB in-memory ring plus 64 MiB rotating spool (configurable with bounded
explicit runtime settings). Web attach hydrates the existing terminal replay
format from that host spool. Web shutdown, socket detach, idle cleanup, and
`kill_all` cannot reap a managed row. Explicit user close first commits the
pane close, then requires a supervisor `VerifiedEmpty` stop before removing the
facade. Managed terminal/stream IDs are deterministic from the pane's durable
`createRequestId`, making web-restart launch retries payload-identical.

Managed terminal specs use an explicit non-secret environment allowlist. Server
`AUTH_TOKEN`/`FRESHELL_TOKEN`, provider API/OAuth variables, cloud credentials,
and proxy credentials are never serialized into the supervisor registry. A
real Claude credential can instead be supplied by exact
`FRESHELL_MANAGED_CLAUDE_CREDENTIAL_FILE` reference; Docker mounts only that
file read-only and the host copies its bytes into the soul-owned provider volume.
The persisted spec contains paths, not secret bytes.

The supported Phase 2 backend is rootless Docker. Its bind-mount ownership maps
the host user's workspace to container uid/gid 0. Freshell therefore keeps the
trusted host at uid 0 with only the three privilege-dropping/home-preparation
capabilities above, and runs the provider as uid `65534`, gid `0`. The mapped
workspace remains group-writable without changing host modes, while the
root-owned `0600` incarnation secret and `host.sock` are not readable or
connectable by the provider. P2-G09 executes the permission/capability probe from
inside the provider PTY and fails if that boundary changes. Git receives an
ephemeral process-local `safe.directory` for the already-approved workspace; no
global git config is modified.

Phase 2 deliberately strips the legacy temporary `--mcp-config` injection for
managed Claude. That MCP child depends on web-owned `FRESHELL_TOKEN` and would
violate web-process independence. Phase 3 replaces it with the durable,
capability-scoped tool router. Fresh-agent providers, Codex/OpenCode terminal
sidecars, Amplifier, and Node-server routes remain legacy until their Phase 3
adapters land.

## Remaining legacy process-ownership sites

The following are the coding-agent/terminal process lifecycle sites still outside
the supervisor. They are the migration checklist for later phases; Phase 2 does
not broaden their legacy authority beyond the explicitly managed shell/Claude lane.

| Runtime family | Current production ownership/spawn/reap seams | Required migration destination |
|---|---|---|
| Rust terminal/PTy | Managed shell/Claude use the session-host facade; non-managed modes still use `PtyTerminal::spawn_with_sink` and legacy `kill_all`. | Finish remaining terminal providers in Phase 3; managed rows must stay excluded from legacy kill/idle paths. |
| Rust FreshClaude/Kilroy | `crates/freshell-freshagent/src/claude.rs` (Node bridge spawn, child kills, `/proc` tag sweep) | Phase 3 per-soul host transport + native provider recovery. |
| Rust FreshCodex | `crates/freshell-freshagent/src/codex.rs` (app-server spawn/kill/exit watcher) | Phase 3 per-soul host transport + exact native session resume. |
| Rust fresh-agent lease cleanup | `crates/freshell-freshagent/src/session_lease.rs` (PID/tree SIGTERM/SIGKILL) | Retire for managed sessions in favor of exact enclosure cleanup. |
| Rust Codex terminal sidecar | `crates/freshell-codex/src/launch_lifecycle.rs` (detached launch, now hardened), `sidecar_sweep.rs`, and `transport.rs` | Fold into supervisor ownership; legacy safety fixes remain until last caller migrates. |
| Rust OpenCode | `crates/freshell-opencode/src/serve.rs` + `transport.rs` (shared serve process, child/tag cleanup) | Phase 3 one managed OpenCode runtime per soul. |
| Rust server shutdown coupling | `crates/freshell-server/src/main.rs` calls terminal `kill_all` and fresh-agent/sidecar shutdown routines | Managed runtimes must be absent from this shutdown fanout; web shutdown becomes connection-only. |
| Node terminal/PTy | `server/terminal-registry.ts` (`pty.spawn`, kill, shutdown) | Remains legacy until a supervisor-backed Node client exists; must never claim `managedRuntimeV1`. |
| Node coding CLI sessions | `server/coding-cli/session-manager.ts` | Same: legacy-only process ownership. |
| Node Codex app-server | `server/coding-cli/codex-app-server/runtime.ts` + `codex-child-registry.ts` | Legacy-only; no process-group cleanup is accepted as managed ownership. |
| Node fresh-agent dispatch | `server/fresh-agent/runtime-manager.ts` delegates adapter kill; `server/fresh-agent/adapters/opencode/serve-manager.ts` owns the OpenCode serve child/tag cleanup | Legacy-only until explicitly supervisor-backed. |

Adjacent subprocesses that are **not** coding-agent souls are intentionally not
part of this migration list: extension servers, file openers, Git/checkpoint
helpers, networking helpers, Tauri's owned Freshell server child, model/history
probe workers, and build-script commands. If a later phase makes one of those a
child of a managed coding agent, it must execute inside that soul's enclosure
and budget; otherwise its existing lifecycle remains separate.

This inventory can be refreshed with focused searches for `PtyTerminal::spawn`,
`pty.spawn`, `Command::new`, `.spawn`, `start_kill`, `process.kill`,
`libc::kill`, `SIGTERM`, and `SIGKILL` in the files above. New managed ingress
is not complete until it has zero calls into these legacy ownership paths.

## Phase 2 handoff checklist

- Protocol/types: `crates/freshell-runtime-protocol`.
- Durable ownership/stop state machine: `crates/freshell-supervisor`.
- Grant-gated independent host and deterministic fixtures: `crates/freshell-session-host`.
- Restricted live Docker broker/harness: `scripts/testing/runtime-*` and
  `test/runtime/gates/phase-1.test.ts`.
- Destructive-test containment: `scripts/sandbox-test.sh --runtime-suite` and
  `scripts/sandbox-selftest.sh`.
- Legacy R04/R05 hardening: Codex launch lifecycle + sidecar sweep regressions.
- Production managed routing: explicit Rust `managedRuntimeV1` opt-in for shell
  and Claude CLI; default/Node/non-negotiated routes remain legacy.
- Pinned workload image: Ubuntu 24.04 + Node 22.23.2 + Claude Code 2.1.263;
  machine-readable versions in `docker/runtime/provider-versions.json`.
- Transactional resource admission, named profiles, bounded host replay/spool,
  durable input request dedupe, provider-home/worktree mounts, and safe
  credential-file bootstrap are Phase 2 contracts.
- Browser continuity remains P2-G01. Under the revised execution order, P2-G04 is the real-OpenCode continuity receipt; Claude and Codex become subsequent provider lanes using the test-cost policy above.
- Gate evidence is intentionally untracked under `.runtime-evidence/<candidate-sha>/<run-id>/`
  so each tested commit carries its own reproducible evidence rather than a
  stale checked-in success claim.

## Live gate

Run:

```bash
npm run test:runtime -- gate phase-2 --require-live
```

The gate executes `P1-G01` through `P1-G10` and writes reproducible evidence to
`.runtime-evidence/<candidate-sha>/<run-id>/`. Missing/skipped cases, cleanup
failure, or any unsafe destructive request fail the gate. Legacy process-kill
regressions run through `scripts/sandbox-test.sh --runtime-suite`, whose no-network/read-only-root mode is validated by `scripts/sandbox-selftest.sh`.

The runtime suite is excluded from ordinary Vitest discovery so `npm test`
never performs destructive lifecycle tests accidentally.
