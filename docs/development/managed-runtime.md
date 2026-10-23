# Managed agent runtime architecture

This document describes the Phase 1 durable ownership boundary and the Phase 2
managed-terminal path implemented by `freshell-supervisor`,
`freshell-session-host`, `freshell-runtime-protocol`, and
`freshell-runtime-client`. Managed routing is explicit/opt-in: only the Rust
server built with `managed-runtime-v1`, booted with the runtime controller, and
a client that negotiated `managedRuntimeV1` can use it. Other routes remain
legacy.

Deploying or restarting the managed runtime is an operator procedure with its
own build surface, unit coupling, and restart effects — see "Redeploy managed
runtime" in the
[self-hosted launch runbook](self-hosted-launch-runbook.md). The build must
compile the feature in (`--features freshell-server/managed-runtime-v1`); the
runtime env var alone arms nothing.

## Current release qualification

OpenCode 1.18.21 (`openai/gpt-5.6-luna`, using the configured OpenAI OAuth
credential) is the only release-qualified durable coding provider in this
landing. Claude, Codex, and
Amplifier remain adapter-ready but route through their legacy ownership paths
until their real live campaigns pass. The checked-in capability manifest is
the source of truth for managed terminal admission. All hosted fresh-agent
modes are disabled in this release. Their separate
`FRESHELL_MANAGED_FRESH_AGENT_V1=1` opt-in is for isolated qualification only:
their live candidate-bound certification receipts are still pending. Historical sections below describe
adapter construction and earlier phase sequencing; they do not override the
current release flags.

## Certification state and the two release gates

Implementation support and a production promise are separate claims, so they
are tracked on separate axes in
`docs/development/runtime-provider-capabilities.json`:

| Field | Meaning |
|---|---|
| `certificationState` | Whether a live, candidate-bound certification campaign has actually passed for this provider. One of `certified`, `pending_live_provider_certification`, `not_applicable`. |
| `qualificationReady` | Whether the adapter can run in an explicitly selected qualification build. It does not enable a release route. |
| `managedEnabled` | Whether managed routing may own this provider at all. |
| `durableRecoveryEnabled` | Whether a durable-soul recovery promise is made for it. |

`certificationState` is the outer bound: a provider that is not `certified`
must be `managedEnabled: false`, `durableRecoveryEnabled: false`, routed by no
`managed` doorway, and absent from `releaseScope.managedTerminalProviders`.
`freshell_agent_runtime::durable_souls_certified` is the single predicate all
three conditions collapse into, and
`crates/freshell-agent-runtime/src/lib.rs` fails its own tests if the checked-in
manifest and the compiled table ever disagree. Deterministic adapter support
for a deferred provider may exist and be unit-tested; it grants no capability
negotiation, API, or UI durability claim.

Two gates consume that state:

| Gate | Command | Meaning |
|---|---|---|
| Landing / pre-certification | `npm run test:runtime -- gate landing --require-live` | The cumulative `P1-G*`…`P5-G*` body plus one `PC-<PROVIDER>` case each. It may PASS while exactly the manifest's `certification.landingGate.deferrableProviders` are recorded `DEFERRED_LIVE_PROVIDER_CERTIFICATION`. Every other case must genuinely PASS. |
| Full production Gate 5 | `npm run test:runtime -- gate phase-5 --require-live` | The same body in production mode. While any required provider is uncertified it exits 2 with status `BLOCKED` and `blockedReason: "pending_live_provider_certification"`. |

`BLOCKED` is never `PASS`. A landing run that defers anything other than the
manifest's deferrable set fails, and a deferral in production mode fails. Each
run writes `deferred-providers.json` next to `summary.json` so what is *not*
proven is explicit rather than inferred.

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

An execution grant is not a control round trip, so it has its own bound. The
host answers a grant only after it has prepared the selected provider inputs
and started the provider. The supervisor waits
`FRESHELL_RUNTIME_TERMINAL_DISPATCH_TIMEOUT_MS` for a terminal grant and
`FRESHELL_RUNTIME_FRESH_AGENT_COMMAND_TIMEOUT_MS` for a fresh-agent grant or
turn operation (both default 60s). That is a policy bound on one dispatch,
roughly ten times a healthy one, not the sum of the host's inner limits: one
Codex app-server start may take up to 45s and a terminal start retries it up
to five times (about 251s worst case), and an exact resume first runs the
provider-owned config refresh (25s, plus up to 32s of recovery).

So the grant carries its own dispatch budget (`dispatch_budget_ms`): the
supervisor's wait less a five-second reply allowance, never less than half the
wait (55s by default). The host stops there itself. Every awaited dispatch
stage runs inside the budget and is cut at the deadline; the native dispatch
boundary is never crossed once the budget is spent, so the grant stays
unconsumed; and the refusal is a typed `HostUnreachable` that names the stage
the budget ran out before. A synchronous stage (the provider projection, the
provider-owned refresh) cannot be cut; the host notices when it returns, and
the reply allowance covers that overrun. The supervisor therefore never
abandons a dispatch the host is still working on, and its recovery policy
decides whether a fresh incarnation tries again.

Every grant records a `host.grant_timing` event (in the incarnation's
`host-lifecycle.jsonl` and on the host's stderr) naming how long each dispatch
stage took, the budget it had (`budgetMs`) and, when it ran out, the stage it
ran out before (`budgetExhaustedBefore`), for accepted and refused grants
alike.

Recovery also calls back to the web server to prepare the replacement's
provider inputs. That callback waits 35s for the web server's own work; a
Claude recovery's callback waits 105s, because before it answers the web
server observes the current Claude sources and then the candidate projection,
back to back, through the supervisor. The wait covers two observations whose
reader succeeds on its first attempt (35s each: the reader's 25s attempt, its
5s cleanup and 5s of reply slack). The recovery scope those nested lookups
present lives exactly as long as the callback wait, and the supervisor ends
every recovery observation, its cleanup included, 5s before that scope does:
an observation never finds its scope expired, and a reader that needs a retry
uses only what is left of the scope. Outside a recovery an observation waits
up to 95s (the reader's bounded retry, 90s, plus the reply slack).

A launch or recovery holds the soul's lifecycle lock for its whole
activation, callback and grant included, and `stop` takes the same lock
before it commits the stop intent. A stop issued during activation therefore
waits for the activation to settle — up to the dispatch wait (60s by default)
when the host is slow or silent, plus the callback wait during a recovery.

The provider projection inside a grant makes every staged file durable before
it is published. Those flushes overlap (`PROVIDER_PROJECTION_SYNC_WORKERS`) so
the filesystem journal commits them together; one at a time, a selected
plugin with a 4,200-file `node_modules` spent 8-13s of the grant flushing.

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

### Short-lived helper containers

The Claude source readers (`freshell-claude-source-*`,
`freshell-claude-candidate-reader-*` with its `freshell-claude-candidate-*`
scratch volume) and the provider mountpoint helper (`freshell-mountpoints-*`)
are one-shot containers the supervisor creates, runs and removes.

A Docker container create can take tens of seconds on a busy host. Docker
mounts and unmounts the new container's overlay root filesystem, and the
kernel flushes the whole filesystem under Docker's data root when that mount
goes away, so the create waits for every unwritten change on that disk (on
the development host: about 0.1s idle, 4.5s with 1 GB unwritten, 16.7s with
3 GB; up to 48s during the provider parity runs, which build Rust release
binaries while up to 8 GB sits unwritten). The create right after it is fast
again, which is why managed-session creates stay quick while the helper
created just before them is slow. A host whose load far exceeds its cores
slows every Docker step the same way, exits and removals included.

- A helper create keeps running when its caller stops waiting, and cleanup
  waits for Docker's answer before it removes the helper by exact name. The
  supervisor owns a helper until its absence is confirmed. A removal gets 5s,
  or, inside a retried read, all the time the read still has reserved. A
  create Docker answers only after the caller's window has passed, or a
  removal that runs past its window or fails, goes to a background reaper. The reaper removes
  the helper (and, for a candidate read, the scratch volume after it), retrying
  with a growing wait for up to 120s; every try re-checks ownership. A create
  Docker answers after 5s or more is logged as `supervisor.helper.create_slow`
  (warn) with its latency. Lifecycle events: `supervisor.helper.cleanup.deferred`
  (warn, with `reason` `create_unanswered` or `removal_unconfirmed`), then
  `supervisor.helper.cleanup.removed` (info) or
  `supervisor.helper.cleanup.unconfirmed` (error).
- The Claude source reader retries a run that timed out, or whose create or
  start Docker refused with a server error or left unanswered. A timeout is
  retried whichever step it hit: the same flush that stalls a create also
  stalls a start, the reader's own writes and Docker's report of its exit (a
  candidate read whose create and start answered at once timed out while 2 GB
  of unwritten data drained, and its retry succeeded). Each attempt
  keeps the reader's 25s bound; the whole read gets up to 90s, three attempt
  lengths with their 5s cleanup: the attempt a stall times out, up to one
  more attempt length for Docker to answer that create, and one full retry;
  a third attempt fits only after a fast refusal. Inside a recovery the read
  also ends 5s before the recovery scope does (see above). Waits are 1s,
  then 2s, and a retry starts only after the previous attempt's helpers were
  removed, so retries never pile creates onto a stalled daemon. Every other failure (a client
  error, changed ownership or topology, a reader that exited without
  evidence, an unconfirmed cleanup) is final, as before. Events:
  `supervisor.helper.retry` (warn, per retry), `supervisor.helper.recovered`
  (info) and `supervisor.helper.retry_exhausted` (error). Their `step` names
  where a timed-out attempt's deadline hit: `prepare`, `create`, `start`,
  `read` (the reader's own work, until it replies), `exit` (Docker reporting
  its exit) or `verify`; a candidate read adds `scratch_create` and its
  mountpoint helper's `mountpoints_*` steps. A reader that hangs in `read`
  while Docker answers promptly is therefore visible as such.

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
  one named provider-home volume per soul, and a read-only operator-home mount
  at its canonical path with tmpfs masks over the control-plane subtrees
  (see [Operator home mounts](#operator-home-mounts) below);
- optional provider bootstrap files mounted read-only by exact canonical file
  reference and copied atomically into the provider volume with mode `0600`;
- no Docker socket, supervisor registry, admin socket, or production port
  exposure.

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

The execution order was revised after the initial Phase 2 shell/Claude implementation: **OpenCode is the first real coding-provider acceptance lane** because garageserver has a working OpenAI-authenticated OpenCode setup. The existing shell/Claude wiring on this branch is transitional infrastructure, not permission to declare the provider portion of Phase 2 complete before the OpenCode live gate passes.

For managed OpenCode, strict per-soul resource isolation requires **one OpenCode provider runtime per soul**. The legacy shared `OpencodeServeManager` is not a valid backing for two managed souls because a shared process cannot satisfy independent hard memory/CPU limits.

Routine real-provider tests use these cost controls:

- OpenCode: use the configured authenticated provider/model, with the resolved provider/model read from native session data and recorded. The provider credential and model provider must match.
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
and proxy credentials are never serialized into the supervisor registry. For
Claude, Codex, OpenCode, and Amplifier, configure provider-specific OneCLI
grants before launch. `FRESHELL_MANAGED_<PROVIDER>_ONECLI_ENV_FILE` references
a private environment grant; `FRESHELL_MANAGED_<PROVIDER>_ONECLI_AUTH_FILE`
references a private provider auth-file grant. The controller records only
typed, canonical file references. The broker mounts each grant read-only, and
the session host resolves its bounded contents immediately before launching
the provider child. Environment values reach only that child; auth-file grants
are staged in the enclosure's temporary auth directory and linked into the
provider home. Raw credential bytes are absent from durable registry state,
launch receipts, Docker create JSON, and logs.

Amplifier uses its ordinary configured bundle, provider, model, plugins, and
operations. An optional OneCLI environment or auth-file grant supplies its
credentials; no Amplifier provider/model profile is imposed by Freshell.
The legacy Kilroy fresh mode still has its separate raw Claude credential
bootstrap path. That exception does not apply to fresh Claude, Codex, or
OpenCode. OneCLI secret transport does not change ordinary MCP, configuration,
plugin, root, or operation behavior.

### Operator home mounts

The supported Phase 2 backend is rootless Docker. Its bind-mount ownership maps
the host user's workspace to container uid/gid 0, and the operator's home files
appear container-0-owned. Freshell therefore keeps the trusted host at uid 0
with only the three privilege-dropping/home-preparation capabilities above, and
runs the provider as uid `65534`, gid `0` — unchanged. Under the rootless
production daemon the child's gid 0 is the operator's group, so group-readable
reference targets (`0750` directories, `0640` key files) resolve with no
identity change: every soul mounts the operator home read-only at its canonical
host path, and absolute `{file:}` config references under it (for example
`{file:/home/dan/.amplifier/ms-runpod.key}`) resolve in-soul. The mapped
workspace remains group-writable without changing host modes, while the
root-owned `0600` incarnation secret and `host.sock` are not readable or
connectable by the provider. P2-G09 executes the permission/capability probe
from inside the provider PTY and fails if that boundary changes. Git receives
an ephemeral process-local `safe.directory` for the already-approved workspace;
no global git config is modified.

Inside the mounted home, three control-plane subtrees are tmpfs-masked so the
provider child can never read authorization material through the mount:
`~/.freshell` (incarnation secrets, MCP capability grants, and server config
secrets — the Freshell control plane), `~/.amplifier/onecli` (OneCLI's own
authorization material, distinct from the provider key files configs
reference), and `~/.config/gcloud` (gcloud robot infrastructure credentials).
Each entry is control-plane or infrastructure authorization material; the
provider key files that configs deliberately reference live outside the mask
set and are served by the group-read contract below.

The mount derives from the supervisor's `--operator-home <path>` flag, or from
the `HOME` env fallback only for a non-root host supervisor whose `HOME`
canonicalizes and is owned by the supervisor's own euid. The flag path applies
the same owner guard; containerized supervisors — the test rig and compose
deployments — pass the flag explicitly, because a root or containerized
supervisor's `HOME` is not the operator's host home and never mounts.
`docker/runtime/compose.yaml` wires the read-only bind and the flag with the
same canonical host path on both sides.

A mounted home stamps two additive env markers into the soul:
`FRESHELL_OPERATOR_HOME_MOUNT=1` and `FRESHELL_OPERATOR_HOME=<canonical path>`.
Pre-upgrade running containers lack them and keep their legacy mounts until
natural incarnation replacement; the marker is what gates verification's
home-mount assertions.

At startup the session host emits exactly one `operator_home_readiness` JSONL
event scoped to the home root: `path`, `present`, `uid`, `gid`, `mode` (octal
string), and `home_root_traversable_by_child` computed for the `65534:0` child;
a home that cannot even be stat'd reports `present: false` and startup
continues unaffected. When a `{file:}` reference fails, read that event first:
`home_root_traversable_by_child: false` means the home root is not
group-traversable and the prep step below has not run. On a rootful daemon
group 0 is not the operator's group, so the feature degrades to legacy
readability — observable there as the mount's absence: no marker env, no
readiness event, and exactly the pre-feature behavior (a root supervisor's
explicit flag is still owner-guarded, and an unowned or rootful-bound home is
declined). Launch never refuses over the home mount in any of these paths.

### Operator home prep

`scripts/prepare-operator-home.sh` is the owned, idempotent host-prep step; run
it once as the operator after deploying, and re-run it after any Amplifier key
rotation. It creates every mask destination that is absent (`~/.freshell`,
`~/.amplifier/onecli`, `~/.config/gcloud`), makes the home root and the known
config ancestors group-traversable (`g+rx` on the home root, `~/.local`,
`~/.config`, `~/.local/share`), and grants whole-tree group read under
`~/.amplifier` (directories `g+rx`, files `g+r`), covering keys regardless of
naming. A tracked upstream item asks Amplifier to write keys `0640` and
`~/.amplifier` `0750` going forward so rotation preserves this by itself. The
reasoning: under the rootless mapping, group access is effectively "processes
running as the operator" on this single-user host — no other identity on the
machine carries the operator's group.

### Accepted residuals of the operator-home mount

1. Boundary of the ratified mechanism, stated so the result and the tradeoff do
   not contradict each other: a config value referencing an in-home file the
   operator deliberately keeps owner-only (0600 file / 0700 subtree outside the
   prep-covered roots) — or a key freshly rotated at 0600 before the prep
   re-run — does not resolve until the operator extends the one-line prep (or
   re-runs it). The provider CLI's own error names the exact path. This
   mode-based boundary is the tradeoff the user accepted with the group-read
   ratification, not an uncovered defect: under the rootless mapping group bits
   grant exactly "processes running as the operator", which no other mechanism
   can express without the rejected scanner/copy machinery.

2. The mask set is computed at container creation: a control-plane path created
   after a soul is running is unmasked for that soul until its next
   incarnation. Primary protection is those paths' own owner-only modes
   (gcloud/onecli create `0700` dirs), and every new incarnation re-derives
   the masks from the filesystem. The prep/filter invariant pair closes the
   exposure window, in both halves: (a) the prep creates every mask
   destination at deploy, so on a prepared host each home-bound soul mounts
   the FULL mask set for its lifetime; (b) the prep NEVER grants group bits
   under the masked control-plane subtree — its group-read pass is pruned
   away from `~/.amplifier/onecli` and it actively revokes any group bits
   found there — so a prep re-run after onecli (or any control-plane path)
   appears cannot make its content readable to a soul whose mask was
   filtered at creation. On an unprepared host the filter can fire, but
   unprepared content is owner-only (`0700`/`0600`), so the unmasked paths
   expose nothing a child can read. Exposure would require simultaneously
   group-readable control-plane content AND a missing mask destination — the
   prep step creates exactly the opposite pairing on both sides; manual
   partial prep is out of model.

Managed providers retain ordinary provider capabilities: configured MCP servers,
provider config files (including `opencode.json` and `opencode.jsonc`), plugins,
approved user-provider roots, and provider-native operations. Freshell renders
its own MCP connection for each execution target, including the Codex TUI and
durable session-host app-server. The provider still runs in a soul-owned home;
OpenCode runs one pinned runtime per soul on private loopback, with native
identity learned inside that runtime. The web controller does not own provider
processes or reach into private provider state.

Provider resources are copied with the shared bounded copier during both
controller preparation and session-host staging. Copies retain executable bits
for scripts and binaries while using private permissions; the source files are
never chmodded. Configuration file references are resolved against the file
that declares them, including relative paths and supported environment
references, then staged under the provider home. A missing, unreadable, cyclic,
or oversized reference fails preparation with a typed explanation instead of
being silently removed. Native conversation databases and credential sources
are excluded from ordinary resource copying and continue to use their dedicated
store or secret-reference paths.

The shared resource copier accepts at most 100,000 entries, 512 MiB of file
contents in total, 128 MiB for any one file, and 64 directory levels; copied
metadata is capped at 64 MiB. A selected configuration source is limited to
16 MiB, with 64 MiB total for simultaneously retained source views. When a
selected file reference cannot be resolved, preparation reports
`SELECTED_REFERENCE_UNAVAILABLE` at stage `configuration`, operation
`resolve`, with the selected field and path in the user-facing detail. Repair
the named file or its declaring configuration rather than relying on Freshell
to omit that capability.

For OpenCode, `--env-file` and `--env-file-if-exists` paths selected from an
enabled local MCP command are handled as private file references. Freshell
resolves them from the MCP working directory or the selected wrapper's actual
script directory, excludes the source file from the ordinary resource copy,
and exposes it inside the provider home under
`/home/freshell/provider/.freshell/references/<index>`. Direct MCP arguments
and supported copied shell wrappers point Node at that private file; a wrapper
that runs from the mounted workspace can use a managed alias in its MCP
working directory. On recovery, Freshell removes only aliases recorded as its
own and no longer used by the current configuration. Node reads the file when
the MCP child starts, so the resulting variables belong to that child. The
file contents are not copied into ordinary resources, launch configuration,
registry metadata, or logs.

Modern fresh-agent sends may include a checkpoint attempt ID. The server takes
and verifies the pre-turn code snapshot for the selected workspace, then
records an outcome tied to that exact send before forwarding it to the provider.
A completed snapshot failure leaves rewind unavailable for that message but
does not discard the message. If snapshot work has not settled, the bounded
barrier keeps that send queued while the child is quarantined. Once settlement
is confirmed, the same send is forwarded exactly once with rewind unavailable;
if settlement cannot be confirmed, the send remains withheld. Durable outcome
storage read failures preserve the last complete attempt snapshot: known
dispatched or unsettled sends stay withheld, while a new settled attempt can
use a bounded process-local duplicate fence. If the store cannot be read before
any trusted snapshot is available, the send is withheld because prior dispatch
cannot be ruled out. Once a store has been observed or failed to read, a later
missing file remains a read failure. A restart during a process-local fallback
loses that temporary fence, so an unreadable store at startup fails closed.
The durable presence marker also keeps a removed outcome file from appearing
to be a first-use store after restart; restore the outcome file to resume sends
when that marker is present.
Provider identity is joined from persisted native IDs: Codex
associates its native turn ID only with the matching user row, Claude uses the
SDK replay UUID, and OpenCode uses the persisted message ID. Display text and
row order are not identity keys. A replayed turn without an exact identity
keeps rewind unavailable, including after the pane is remounted.
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
  typed OneCLI grant resolution are Phase 2 contracts.
- Browser continuity remains P2-G01. Under the revised execution order, P2-G04 is the real-OpenCode continuity receipt; Claude and Codex become subsequent provider lanes using the test-cost policy above.
- Gate evidence is intentionally untracked under `.runtime-evidence/<candidate-sha>/<run-id>/`
  so each tested commit carries its own reproducible evidence rather than a
  stale checked-in success claim.

## Live gate

Run:

```bash
npm run test:runtime -- gate phase-2 --require-live
```

The gate executes cumulative `P1-G01` through `P1-G10` and `P2-G01` through
`P2-G11`, imports commit- and image-bound browser/OpenCode receipts, and writes
reproducible evidence to `.runtime-evidence/<candidate-sha>/<run-id>/`, including
normalized browser artifacts and the actual provider version/model/native-session
result. Missing/skipped cases, stale or wrong-image receipts, cleanup failure, or
any unsafe destructive request fail the gate. Legacy process-kill regressions run
through `scripts/sandbox-test.sh --runtime-suite`, whose no-network/read-only-root
mode is validated by `scripts/sandbox-selftest.sh`.

The runtime suite is excluded from ordinary Vitest discovery so `npm test`
never performs destructive lifecycle tests accidentally.

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

## Phase 5 loss certification and operations

Phase 5 introduces a strict boundary between reversible recovery failure and
irreversible loss. Each enabled provider declares a complete ordered recovery
path inventory. Path probes return ready, blocked/unknown, or definitive
negative with typed store evidence. Any unknown, unreadable, incompatible,
rate-limited, credential, workspace, or backend state remains `blocked`.

When every applicable path is freshly definitive-negative, the supervisor
atomically persists a loss incident and stops the soul before sending any
cleanup signal. The certificate stores hashes/references rather than raw native
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
