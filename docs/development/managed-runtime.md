# Managed agent runtime architecture

This document describes the Phase 1 ownership boundary implemented by
`freshell-supervisor`, `freshell-session-host`, and
`freshell-runtime-protocol`. Production agent routes are intentionally not
switched to it yet.

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

The Phase 1 Docker backend requires:

- exact `sha256:` image identity;
- `NetworkMode=none`;
- private PID namespace;
- read-only root filesystem with a bounded `/tmp` tmpfs;
- all Linux capabilities dropped and `no-new-privileges`;
- explicit CPU, memory, swap, and PID limits;
- exactly two mounts: the read-only host binary and one incarnation directory;
- no Docker socket, supervisor registry, admin socket, provider home, or production port exposure.

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

## Production routing is deliberately disabled

Phase 1 does **not** import `freshell-supervisor` or `freshell-session-host` into
`freshell-server`, does not add an HTTP/WS/MCP managed-launch route, and does not
change the current server shutdown behavior. The Rust server reserves the Cargo
feature `managed-runtime-v1`, but it is disabled by default and intentionally
has no routing/dependency effect in this phase. The wire capability is not
advertised. Node remains wholly legacy. Therefore no user launch can silently
fall back from a failed managed launch to an unmanaged process and no operator
can obtain the managed guarantees merely by toggling a flag.

Phase 2/3 may wire the runtime client only after the corresponding live gates
prove PTY continuity and provider-native resume. Until then the only entrypoint
into this subsystem is the isolated runtime test harness.

## Remaining legacy process-ownership sites

The following are the coding-agent/terminal process lifecycle sites still outside
the supervisor. They are the migration checklist for later phases; Phase 1 does
not broaden their authority.

| Runtime family | Current production ownership/spawn/reap seams | Required migration destination |
|---|---|---|
| Rust terminal/PTy | `crates/freshell-terminal/src/pty.rs` (`PtyTerminal::spawn`, process-group kill) and `crates/freshell-terminal/src/registry.rs` (`PtyTerminal::spawn_with_sink`, `kill_all`) | Phase 2 session-host PTY ownership and runtime client facade. |
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

## Phase 1 handoff checklist

- Protocol/types: `crates/freshell-runtime-protocol`.
- Durable ownership/stop state machine: `crates/freshell-supervisor`.
- Grant-gated independent host and deterministic fixtures: `crates/freshell-session-host`.
- Restricted live Docker broker/harness: `scripts/testing/runtime-*` and
  `test/runtime/gates/phase-1.test.ts`.
- Destructive-test containment: `scripts/sandbox-test.sh --runtime-suite` and
  `scripts/sandbox-selftest.sh`.
- Legacy R04/R05 hardening: Codex launch lifecycle + sidecar sweep regressions.
- Production managed routing: **disabled**; no user launch is switched yet.
- Gate evidence is intentionally untracked under `.runtime-evidence/<candidate-sha>/<run-id>/`
  so each tested commit carries its own reproducible evidence rather than a
  stale checked-in success claim.

## Live gate

Run:

```bash
npm run test:runtime -- gate phase-1 --require-live
```

The gate executes `P1-G01` through `P1-G10` and writes reproducible evidence to
`.runtime-evidence/<candidate-sha>/<run-id>/`. Missing/skipped cases, cleanup
failure, or any unsafe destructive request fail the gate. Legacy process-kill
regressions run through `scripts/sandbox-test.sh --runtime-suite`, whose no-network/read-only-root mode is validated by `scripts/sandbox-selftest.sh`.

The runtime suite is excluded from ordinary Vitest discovery so `npm test`
never performs destructive lifecycle tests accidentally.
