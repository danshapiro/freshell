# Managed agent runtime architecture

This document describes the Phase 1 durable ownership boundary and the Phase 2
managed-terminal path implemented by `freshell-supervisor`,
`freshell-session-host`, `freshell-runtime-protocol`, and
`freshell-runtime-client`. Managed routing is explicit/opt-in: only the Rust
server built with `managed-runtime-v1`, booted with the runtime controller, and
a client that negotiated `managedRuntimeV1` can use it. Other routes remain
legacy.

## Scope, capabilities, and explicit enablement

The target remains every coding-agent mode in the original five-phase plan.
Stage 5a does not remove providers, operations, recovery paths, budgets, views,
incidents, or notices. Existing conservative defaults remain: shell/OpenCode
managed routing is on; other terminal adapters and fresh-agent modes still need
actual integration validation and deliberate enablement before deployment.

`docs/development/runtime-provider-capabilities.json` is the single declaration
of provider facts and defaults; Rust embeds it when building. There is no
runtime CertificationState or separate pending-provider qualification build.
FRESHELL_MANAGED_PROVIDERS selects an exact comma-separated list of implemented
terminal adapters on both supervisor and web. Unset uses checked-in defaults;
unknown/unimplemented names and malformed lists are rejected. Fresh-mode
configuration and the managed-runtime-v1 feature remain separate. Enablement
does not grant credentials or implement missing capabilities. Operational
authentication and isolation are unchanged.

Run the direct runtime tests described in test/runtime/README.md. Deterministic,
actual-provider/browser, and long stress scenarios have normal scoped results.
The former landing/production certificate workflow is retired. A green subset
is not an all-provider readiness claim.

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

## Managed truth versus the legacy disk index

A managed soul's provider state lives inside that soul's own runtime volume.
The web server's host-local session index cannot see it, so it must never
adjudicate one. Pane reconciliation (`crates/freshell-ws/src/reconcile.rs`)
resolves this in a fixed order before it consults the index:

1. **A live managed facade that owns the exact identity wins.** If a Running
   managed row carries this `(provider, sessionId)`, the verdict is `attach` to
   that terminal — whatever the host disk index believes. Without this, a
   perfectly healthy supervisor-owned conversation reads
   "ever observed, now absent" and is declared `dead_session`.
2. **Unknown managed truth withholds the death claim.** The managed pre-pass
   adopts each presented terminal from protected supervisor inventory. A lookup
   that *fails* (controller unreachable, protocol error) is recorded in
   `ManagedReconcileFacts`, and the ladder answers
   `error{managed_runtime_unavailable}` instead of a definitive
   `dead_session`. An unknown answer authorizes no loss.
3. Only when managed truth is known-absent does the ordinary legacy ladder run
   unchanged.

The browser folds `managed_runtime_unavailable` and
`managed_runtime_authoritative` as `managedDeferred` (`src/lib/pane-reconcile.ts`):
the pane is left exactly as it is, with no `restoreError` painted over it,
because `src/lib/recovery/managed-runtime-recovery.ts` is the authority and
will set the real state from the supervisor inventory. Suppression is scoped
per pane key, so an unrelated pane still gets its ordinary honest verdict.

## Bounded session-host IPC

The supervisor is the sole runtime authority; a session host is an untrusted
workload boundary. Every supervisor→host control round trip — the hello
handshake included — is bounded by
`FRESHELL_RUNTIME_HOST_COMMAND_TIMEOUT_MS` (default 10s). Exceeding it is a
typed `HostUnreachable`, after which the caller proceeds through the
Docker-level path it already owns.

This matters most for `stop`: the durable stop intent commits first, then the
graceful host stop is *attempted*. A host that accepts the control connection
and then goes silent used to hold the authoritative stop open forever. It is
now bounded, and `request_stop` → `verify_empty` → `force_stop` still reaches
`verified_empty`.

The session host itself keeps a worker-thread floor
(`HOST_MIN_WORKER_THREADS`). Inside a CPU-capped container
`available_parallelism()` routinely reports 1, and a single-worker runtime
makes the control plane share one thread with every workload task — a long
synchronous step then looks indistinguishable from a dead host.

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
- Claude: `codingCli.providers.claude.model = "haiku"` and
  `codingCli.providers.claude.effort = "low"`.
- Codex: `codingCli.providers.codex.model = "gpt-5.6-luna"` and
  `codingCli.providers.codex.effort = "minimal"`. The CLI receives the latter
  as the exact argument pair `-c model_reasoning_effort="minimal"`.
- Amplifier: the provider-approved lowest-cost model in the explicitly
  referenced settings file; record the resolved model in the receipt.

The model and effort fields are durable launch policy. They are copied into
the managed terminal spec and resume spec as typed fields, in addition to the
manifest-rendered provider argv, so recovery cannot silently return to a
provider default.

No gate may silently upgrade to a more expensive model or higher reasoning level. If the required low-cost model/configuration is unavailable, the lane is `BLOCKED` unless the test is explicitly about another model; such an override must be named in the scenario and recorded in evidence. Provider receipts record the actual model and reasoning/thinking setting when exposed by the provider.

## Phase 2 managed terminal routing

Phase 2 wires `freshell-runtime-client` into the Rust server behind the Cargo
feature `managed-runtime-v1`. At runtime, `FRESHELL_MANAGED_RUNTIME_V1=1` plus
a healthy authenticated supervisor is required before the server advertises
`ready.capabilities.managedRuntimeV1`. The client must opt in on the same
connection. Feature-off, controller-unavailable, Node-server, and non-negotiated
connections stay byte-for-byte on their legacy ownership path.

Phase 2 now negotiates **shell, Claude CLI, and OpenCode terminals** using a browser-facing
`TerminalRegistry` facade with no `PtyTerminal`/OS kill handle. The session host
owns the PTY reader/writer/waiter and continuously drains output into a bounded
1 MiB in-memory ring plus 64 MiB rotating spool (configurable with bounded
explicit runtime settings). Web attach hydrates the existing terminal replay
format from that host spool. Web shutdown, socket detach, idle cleanup, and
`kill_all` cannot reap a managed row. Explicit user close first commits the
pane close, then requires a supervisor `VerifiedEmpty` stop before removing the
facade. Managed terminal/stream IDs are deterministic from the pane's durable
`createRequestId`. Before constructing a launch transaction, the web controller
checks supervisor inventory for that stable soul/terminal pair; an already-
running incarnation is reattached directly. This is load-bearing once a native
provider session id has appeared, because restore metadata may be richer than
the original fresh-create payload. Existing stopped/non-running or mismatched
souls fail closed rather than being silently replaced.

Managed terminal specs use an explicit non-secret environment allowlist. Server
`AUTH_TOKEN`/`FRESHELL_TOKEN`, provider API/OAuth variables, cloud credentials,
and proxy credentials are never serialized into the supervisor registry. A
real Claude credential can instead be supplied by exact
`FRESHELL_MANAGED_CLAUDE_CREDENTIAL_FILE` reference; Docker mounts only that
file read-only and the host copies its bytes into the soul-owned provider volume.
Codex and OpenCode use the analogous
`FRESHELL_MANAGED_CODEX_AUTH_FILE` and
`FRESHELL_MANAGED_OPENCODE_AUTH_FILE` references. Amplifier instead accepts one
typed `FRESHELL_MANAGED_AMPLIFIER_ONECLI_KEYS_FILE` reference, restricted to
the approved private `~/.amplifier/keys.env` used by `amplifier-onecli`. The
runtime does not source or execute that file: the session host parses a bounded
allowlist and maps only the approved provider-vLLM upstream/API-key pair plus
canonical proxy and certificate transport into the Amplifier child. Host-local
`ONECLI_URL` and `NO_PROXY` are deliberately not forwarded into the enclosure,
so container loopback cannot impersonate the host gateway and the qualified
upstream cannot bypass it. The pinned runtime image installs the exact
provider-vLLM source and `glm-5.3` profile used by the approved OneCLI route;
reasoning remains the provider's native default. Raw OAuth and the obsolete
Anthropic/Haiku profile fail closed. Every source is canonicalized and admitted
by the runtime broker as an exact read-only single-file mount. The registry and
Docker create JSON contain only canonical references, never secret bytes.

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

Managed providers strip web-owned MCP/rebind machinery. Managed Claude omits
the legacy temporary `--mcp-config`; managed OpenCode omits the host rebind
plugin, project-local Freshell MCP mutation, host-side SQLite locator, and
web-side loopback SSE lane. OpenCode runs one pinned provider runtime per soul
on private loopback, with provider-native identity learned inside the enclosure.
The managed fresh-agent adapter routes create/send, interrupt, permission
resolutions, compact, rollback, event history, read-only transcript capture, and
supported provider-native fork operations through the session host. The Rust web
process remains only a gateway and event-projection surface. Provider snapshots
are projected through a strict capability intersection before they reach a
client, so malformed or mismatched capability payloads fail closed.

Provider topology is not Freshell lifecycle topology. Provider-native
subprocesses, subagents, and child threads remain descendants and read-only
nested snapshot state inside the parent soul; they consume that soul's cgroup
and reservation and never acquire synthesized `soulId` values. A
provider-native conversation fork, currently supported for Codex and OpenCode
when the native provider advertises it, is an in-soul session transition: the
host asks the existing provider runtime to branch, verifies the old provider
session is retired, updates the durable actor identity, and the supervisor
atomically replaces the parent writer claim with the child identity for the
same soul and incarnation. The old parent resume/checkpoint proof is invalidated
(`live_only` / `materializing`) until the child is re-probed. All current views
of that managed soul converge to the new native branch; no `Launch` or whole-soul
`Stop` is generated by the fork itself. If the host dies after provider
acceptance but before durable completion, the persisted command becomes
`AMBIGUOUS` and is never automatically replayed.

Independent worktree or child-agent creation remains unavailable unless an
explicit product operation requests a separately admitted Freshell soul with
its own lifecycle and resource ownership. There is no fallback to a legacy
web-owned spawn path for that operation.

## Remaining legacy process-ownership sites

The following are the coding-agent/terminal process lifecycle sites still outside
the supervisor. They are the migration checklist for later phases; Phase 2 does
not broaden their legacy authority beyond the explicitly managed shell/Claude/OpenCode lane.

| Runtime family | Current production ownership/spawn/reap seams | Required migration destination |
|---|---|---|
| Rust terminal/PTy | Managed shell/Claude/OpenCode use the session-host facade; non-managed modes still use `PtyTerminal::spawn_with_sink` and legacy `kill_all`. | Finish remaining terminal providers in Phase 3; managed rows must stay excluded from legacy kill/idle paths. |
| Rust FreshClaude/Kilroy | Managed mode routes the Node bridge through the per-soul session-host actor; legacy callers still exist in `crates/freshell-freshagent/src/claude.rs`. | Keep non-managed callers isolated; managed stop/recovery must remain enclosure-owned and exact-native. |
| Rust FreshCodex | Managed mode routes app-server transport through the per-soul session host and preserves exact native thread identity; legacy callers still exist in `crates/freshell-freshagent/src/codex.rs`. | Keep non-managed callers isolated; provider-native fork/child-thread semantics stay inside the managed soul. |
| Rust FreshOpenCode | Managed mode routes a per-soul provider transport through the session host; legacy shared-process callers remain in `crates/freshell-freshagent/src/opencode_ws.rs`. | Keep legacy shared ownership out of managed qualification and recovery. |
| Rust fresh-agent lease cleanup | Legacy adapters still contain PID/tree cleanup for non-managed callers. | Managed sessions use exact enclosure cleanup; retain legacy cleanup only for explicit legacy ownership paths. |
| Rust Codex terminal sidecar | `crates/freshell-codex/src/launch_lifecycle.rs` (detached launch, now hardened), `sidecar_sweep.rs`, and `transport.rs` | Fold into supervisor ownership; legacy safety fixes remain until last caller migrates. |
| Rust OpenCode | The managed terminal lane now runs one pinned OpenCode runtime per soul through the session host. `crates/freshell-opencode/src/serve.rs` + `transport.rs` still own the legacy shared serve process for non-managed callers. | Phase 3 routes managed tool traffic through the durable capability-scoped router and migrates the remaining legacy callers. |
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
- Production managed routing: explicit Rust `managedRuntimeV1` opt-in for shell,
  Claude CLI, and OpenCode; default/Node/non-negotiated routes remain legacy.
- Pinned workload image: Ubuntu 24.04 + Node 22.23.2 + Claude Code 2.1.263 +
  OpenCode 1.18.21; machine-readable versions in
  `docker/runtime/provider-versions.json`.
- Transactional resource admission, named profiles, bounded host replay/spool,
  durable input request dedupe, provider-home/worktree mounts, and safe
  credential-file bootstrap are Phase 2 contracts.
- Browser continuity remains P2-G01. Under the revised execution order, P2-G04 is the real-OpenCode continuity test; Claude and Codex become subsequent provider lanes using the test-cost policy above.
- Gate evidence is intentionally untracked under `.runtime-evidence/<candidate-sha>/<run-id>/`
  so each tested commit carries its own reproducible evidence rather than a
  stale checked-in success claim.

## Direct runtime verification

`npm run test:runtime:verify -- --suite all` selects the complete implemented
behavioral matrix, including actual-provider and stress scenarios. Use
`--suite deterministic`, `--suite live`, `--suite stress`, or `--only <step>`
for focused work. `npm run test:runtime -- gate phase-5 --require-live` runs
only the deterministic Docker subset. Neither imports an earlier certificate.

The configured browser backend must support Docker; unsupported execution is
reported as blocked, never silently replaced. Ordinary logs/results retain
build and provider identity without a clean-SHA or evidence-catalog prerequisite.
See test/runtime/README.md for coverage mapping and credential policy.

## Phase 4 durable views and startup reconciliation

The supervisor, not the web process, performs initial inventory reconciliation.
It limits concurrent recovery, records readiness and scan duration, and does not
expose the control socket as ready until the initial scan has converged or
recorded explicit blockers. A continuous observer checks only registry-issued
ownership handles.

A durable `view_intent` describes how a soul should appear to an owner and
workspace. Automatic primary placement is deterministic; explicit additional
views have independent view IDs but share the same soul and provider writer.
The supervisor writes revisioned projection events to its outbox. The Rust web
server applies those events idempotently, updates the pane identity ledger, and
ACKs only after durable projection. The browser always refreshes managed
inventory on `ready` and on revision broadcasts, merges missing views into the
saved layout, and does not replace unrelated tabs or steal focus.

Closing a view commits `detached`; stopping an agent commits a fenced soul stop
intent and hides automatic recreation. Old clients may adopt an already
managed deterministic terminal ID without advertising managed ownership, but
may not launch a second provider process.

## Phase 5 loss handling and operations

Phase 5 introduces a strict boundary between reversible recovery failure and
irreversible loss. Each enabled provider declares a complete ordered recovery
path inventory. Path probes return ready, blocked/unknown, or definitive
negative with typed store evidence. Any unknown, unreadable, incompatible,
rate-limited, credential, workspace, or backend state remains `blocked`.

When every applicable path is freshly definitive-negative, the supervisor
atomically persists a loss incident and stops the soul before sending any
cleanup signal. The durable loss record stores hashes/references rather than raw native
IDs or credentials. Cleanup then uses the exact registry ownership handle,
tries graceful host shutdown, escalates only inside that enclosure, verifies
backend emptiness, and finalizes the same incident. Named runtime-test
failpoints prove restart idempotency after incident commit, after cleanup, and
before export. They are compiled out of release behavior.

Incident export, metrics, and notices use durable outbox/idempotency keys. A
cleanup-failed notice remains truthful while ownership is unresolved; a later
verified result supersedes it with one final deliverable notice. Notice ACKs
are per profile and survive reconnect/restart. The ended pane keeps its soul,
provider/native identity in authenticated UI state, history, and incident link;
no blank replacement or ambiguous prompt replay is permitted.

Lifecycle logs use the shared runtime observability crate: sensitive fields and
exact process secrets are scrubbed before persistence, files are private and
bounded/rotated, and incident documents are atomic. Open incidents are never
removed by retention.

Rollout state is registry-owned (`legacy`, `managed-opt-in`, or
`managed-default`). Managed-default requires a verified consistent backup.
Rollback changes routing policy only; it preserves managed souls, ownership,
views, provider volumes, incidents, notices, and metrics. Repair can resume
idempotent registry-backed work but never infer ownership from labels, process
names, environment tags, cwd, or partial IDs.

### Stage 5a: secondary reporting does not veto committed cleanup

After SQLite commits the loss and exact cleanup intent, secondary incident-file
export is best effort. Failed exports stay queued while cleanup and notices
progress; reconciliation retries them. Authoritative database persistence and
cleanup-read failures remain blocking. The incident may omit unknown root-cause
commentary, hypotheses, preventive actions, and regression references. No
synthetic postmortem is required to perform a safe state transition.
