# Managed runtime rollout, migration, and rollback

Durable Souls ships behind an explicit supervisor rollout mode. Changing the
routing mode preserves managed state. Reversing routing does not reverse a
registry schema upgrade.

## Current staged release scope

The capability manifest enables four ordinary routes: terminal Codex and
OpenCode, plus FreshCodex and FreshOpenCode. The provider-free UI continuity
fixture for this repair creates all four through the ordinary picker paths and
checks their identities across a web-only update, reload, and follow-up turn.
It uses no live provider credentials or external model calls. The configured
full-suite gate, affected managed browser/smoke checks, and required
independent reviews are also part of this run. Record actual results against
the tested candidate in the repair's run record. Native recovery proofs and
the backup/upgrade drill below are general rollout procedures, not acceptance
gates for this repair. This runbook does not certify, promote, or describe an
installed candidate. Managed
Amplifier and Kilroy remain unqualified and release-disabled. Their exclusion
does not remove ordinary legacy CLI integrations or existing regression tests.

The capability manifest is executable policy. Before release, verify that Rust
WebSocket/REST routing and direct supervisor launch admission enforce the same
release flags, including refusal of disabled managed modes through lower-level
APIs. This is a candidate verification requirement, not a claim that pending
source work or native qualification has passed.

Each provider row carries an explicit `certificationState`; fresh modes have
their own release metadata. Required proof follows the advertised managed
release scope. Qualification readiness, a successful unit test, or a CLI being
installed cannot enable a production route. Confirm the reviewed candidate's
manifest and actual server/supervisor admission agree before installation;
production uses the normal managed build without qualification overrides.

This repair preserves existing registry, provider, and session stores. It does
not require automated existing-session transition, import, duplicate-owner
selection, historical notice withdrawal, or a nine-soul/seven-root restoration
campaign. An individual existing-session import is outside this repair and
requires a separate request. The generic import and repair tools below remain
available for that purpose.

## Modes

| Mode | Meaning |
|---|---|
| `legacy` | Existing legacy routing remains authoritative. Managed registry data is retained, but definitive provider negatives remain blocked rather than authorizing Phase 5 loss cleanup. |
| `managed-opt-in` | Explicitly selected managed providers/routes use the supervisor, durable views, recovery, and loss pipeline. Other routes remain legacy. |
| `managed-default` | Managed routing is the default for every enabled provider/mode in the checked-in capability manifest. Requires a verified registry backup and a clean preflight. |

The mode is stored in the supervisor registry, not in browser local storage.
Changing it is a fenced, request-deduplicated control transaction.

## Host services

On a self-hosted Linux machine using systemd user services, the managed
supervisor and web server run as the same user and share a private persistent
state root. Build the server with `managed-runtime-v1`, plus the supervisor and
session host:

```bash
cargo build --release -p freshell-server -p freshell-supervisor \
  -p freshell-session-host --locked --features freshell-server/managed-runtime-v1
```

Build the pinned workload image from `docker/runtime/Dockerfile` and record its
immutable `sha256:` image ID in
`~/.config/freshell/managed-runtime.env` as `FRESHELL_RUNTIME_IMAGE`. Keep the
image digest, registry, control socket/secret, and runtime root stable across
restarts. Create the control secret as a private random value; it is separate
from provider credentials and is read only by the supervisor and web server.

Install `installers/systemd/freshell-supervisor.service` and
`installers/systemd/freshell-rust.service.d/managed-runtime.conf` under
`~/.config/systemd/user/`, then reload systemd. Enable and start the supervisor
first; verify its control socket exists with mode `0600`. The drop-in enables
the feature and orders the web server after the supervisor. It must not include
`Requires=`, `Wants=`, or `Requisite=` between those units, because a web
restart must not restart or stop the supervisor. When changing the installed
drop-in, inspect the effective unit, install the ordering-only relationship,
and run `systemctl --user daemon-reload` before updating. The updater rejects an
effective graph where a web action can affect the supervisor. Fixture tests do
not certify the installed unit graph. Do not run Compose `down` or remove the
runtime root during an ordinary rollout.

The canonical launcher adds the `managed-runtime-v1` feature to its build
when `FRESHELL_MANAGED_RUNTIME_V1=1` is set and rejects a featureless binary.
It can start a managed server only when that port is inactive and the
configured supervisor socket and readable secret are available. Before
printing ready, it checks authenticated runtime readiness and confirms that
the readiness response matches the same supervisor identity before and after
the request. It reports host-managed and unknown panes as outside durable-soul
protection and leaves them running. Its `--stop` and `--restart` actions
refuse a running managed server because they do not perform the pane census.

The updater currently supports systemd-owned deployments only. A featureless
or legacy server that returns 404 for authenticated
`/api/runtime/readiness` cannot provide a complete pane census. The updater
refuses before building or changing services; it cannot safely bootstrap that
install. Keep existing work running, save or port host-agent sessions, and use
a separate deliberate approved recovery. Verify authenticated runtime
readiness against the intended supervisor before describing those agents as
protected.

For the intended fresh modes, the server also needs
`FRESHELL_MANAGED_FRESH_AGENT_V1=1`. The checked-in managed-runtime server
drop-in supplies `FRESHELL_MANAGED_RUNTIME_V1=1` and the control socket/secret
paths; it does not supply the fresh-agent opt-in. Record the latter in the
actual server owner's environment. The supervisor's environment file supplies
`FRESHELL_RUNTIME_IMAGE`; writing it there alone does not set server flags.
Keep resolved owner-specific paths and settings in the private deployment
packet rather than assuming these example unit paths match the running host.

Route protected runtime API calls through OneCLI. Its credential grant should
be limited to the server host and `/api/runtime/*`, inject only `x-auth-token`,
and be granted only to the machine's named agent. The OneCLI bridge must be
allowed to reach the host's runtime API port; requests must actually use the
OneCLI proxy rather than bypassing it through `NO_PROXY`.

## Managed maintenance update modes

Run updates from a host shell in the deployment checkout. A Freshell-managed
pane runs inside a soul container and does not own the host systemd user
manager or deployment checkout. The ordinary web/client update has no
`APPROVED` gate and does not restart the durable supervisor or managed coding
sessions. Use the reset-capable modes only when that reset is intended:

```bash
# Default: update web/client and restart only the web service.
pnpm exec tsx scripts/update-managed-runtime.ts

# Update web/client and durable runtime after resetting managed coding sessions.
pnpm exec tsx scripts/update-managed-runtime.ts --all

# Update durable runtime after reset; keep old web executable, client, callback.
pnpm exec tsx scripts/update-managed-runtime.ts --durable-only
```

The default mode prints and records a reminder that the supervisor and managed
sessions were not restarted and that reset-capable updates require the exact
word `APPROVED`. It verifies authenticated runtime readiness and the intended
supervisor installation identity before success. Generic HTTP health and a
connected socket alone do not prove readiness.

When `FRESHELL_MANAGED_RUNTIME_V1=1` is set, the web binary must include the
compile-time `managed-runtime-v1` Cargo feature. The server refuses startup
with a useful error if that feature is missing. The updater checks the staged
server feature marker before installation, so a routine web update cannot
install a binary that silently disables requested managed runtime.

`--all` and `--durable-only` first resolve the selected mode, run read-only
ownership, service-graph, persistent-resource, and candidate schema checks,
then read one raw approval line. They accept only exactly `APPROVED`. Both
reset managed coding sessions by default, preserve saved conversation
history, and attempt to reopen saved conversations against the updated
runtime. Recovery may need manual reopening or session porting. The updater
does not guarantee successful recovery.

Before reset-capable modes, complete the read-only registry preflight and
verified old-schema backup procedure in
[Upgrade an existing installation while preserving stores](#upgrade-an-existing-installation-while-preserving-stores).
The candidate schema is checked before a candidate opens the live registry.
The updater also checks the current/candidate schema versions before applying
the selected mode. Do not treat a migration preview as a backup.

Before build or service effects in any mode, the updater reads authenticated
runtime readiness and the pane-ownership census. If an open pane is known to
be host-managed or ownership cannot be established, it reports the pane and
refuses before mutation. A known host-managed process remains running and
usable. Unknown ownership is not evidence that a process is still running;
the updater fails closed without trying to interrupt or migrate it. A second
census runs after admitted work drains. If a host-owned pane appears during
artifact preparation, the updater releases the temporary admission lease,
refuses before stopping services, and leaves that known host-owned work
running. Any migration that may interrupt such work is a separate deliberate
operation.

`--all` installs and starts the new web/client and durable runtime. The
`--durable-only` mode keeps the old web executable, client directory, and
callback peer selected while replacing the supervisor/workload; it restarts
the old web process only as needed to restore and verify its callback to the
new supervisor. The default mode replaces web/client and restarts only the
web unit. All successful paths verify callback readiness where applicable and
the authenticated runtime API against the intended supervisor identity.

After the updater prints its run ID and transient unit, check service status
and the unit journal, then inspect the JSONL completion record:

```bash
systemctl --user status freshell-rust.service freshell-supervisor.service
journalctl --user -u <printed-transient-update-unit> --no-pager
less ~/.freshell/logs/managed-runtime-update-<run-id>.jsonl
```

The JSONL log records candidate checks, ownership/readiness, service effects,
reopen results, and `update.completed` or `update.failed`. On partial failure,
preserve registry, provider/history, runtime, workspace, and installed
artifacts. Use the log phase and live service state for forward recovery; do
not assume automatic artifact rollback. Verify the old web process has
stopped before reopening host-agent admission. Use the separate verified
backup restore procedure only when it will not discard later writes or user
intent.

## Preflight and dry run

Always begin with a dry run:

```text
migration_plan {
  requestedMode: "managed-opt-in" | "managed-default" | "legacy",
  apply: false,
  backupPath?: <approved-supervisor-backup-directory>,
  legacyMetadataPath?: <read-only-import-source>,
  expectedControlEpoch: <current-epoch>
}
```

The response inventories:

- current and requested mode;
- enabled provider/mode capability matrix;
- managed soul/view counts;
- pending recovery, cleanup, export, and notice work;
- legacy metadata rows visible to the importer;
- blockers and required operator actions;
- backup requirements and verification status.

Dry run performs no routing change, no provider launch, no cleanup, and no
legacy metadata mutation. `apply: false` and a returned `backupPath` do not
create a backup. The supervisor creates a verified backup only when applying
a transition into `managed-default` from another mode. That helper runs after
the registry has opened; it is not a pre-schema-upgrade backup and creates no
new backup for an already-default registry. Follow the upgrade procedure below
before any candidate registry opener.

## Legacy import

Legacy metadata is read-only input. The importer may create durable identity or
view records only where provider, native identity, workspace, and provenance are
unambiguous. Ambiguous, missing, or unreadable records remain blocked for human
review. Import is idempotent: replaying the same source does not mint a second
soul, view, writer, or incident.

The importer never treats a process name, label, environment tag, cwd, newest
session, or sole remaining session as ownership or identity proof.

## Enabling managed opt-in

1. Run the dry run and resolve all blockers.
2. Run the repository's managed provider acceptance tests for the intended
   provider/mode.
   The P2-G04 isolated browser test harness requires
   `FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE` to point to the private
   existing OpenCode `auth.json`; its temporary server home cannot discover
   the host credential. This uses the same typed OneCLI reference as managed
   provider launches.
3. Apply `managed-opt-in` with the current control epoch and a unique request ID.
4. Verify the returned inventory revision and rollout mode.
5. Open one managed agent for every provider currently marked
   `managedEnabled && durableRecoveryEnabled`, using isolated synthetic
   conversations. Qualification must use the candidate's actual production
   routing once the intended provider has been promoted.
6. Verify exact provider-native identity capture, one writer per soul, web
   replacement continuity, controller replacement recovery, resource limits,
   and zero false loss notices.

Unavailable required low-cost configuration is a rollout blocker. Do not
silently upgrade model cost or reasoning.

Before an authorized provider qualification, persist the exact coding-CLI launch
policy rather than relying on a provider default:

```json
{
  "codingCli": {
    "providers": {
      "claude": { "model": "haiku", "effort": "low" },
      "codex": { "model": "gpt-5.6-luna", "effort": "minimal" }
    }
  }
}
```

For Amplifier, configure the desired bundle, provider, model, plugins, and
operations as for an ordinary Amplifier session. If the provider needs a
secret, supply its private OneCLI environment grant with
`FRESHELL_MANAGED_AMPLIFIER_ONECLI_ENV_FILE`, or an auth-file grant with
`FRESHELL_MANAGED_AMPLIFIER_ONECLI_AUTH_FILE`. The controller stores only the
typed canonical reference; the session host resolves it for the child. The
supervisor registry and logs never receive secret values. The native
`session:config` event records the effective model and reasoning. Bundle MCP
remains available when the bundle mounts `tool-mcp`.

These values and typed grant references make qualification reproducible.
They do not certify or enable a provider; the capability manifest remains
authoritative. Amplifier configuration above documents the existing tooling,
not a live qualification or release step for this repair.

## Enabling managed default

Managed-default additionally requires:

- a consistent SQLite backup verified by the applied migration;
- recorded path, size/hash, and successful verification;
- clean registry integrity and ownership audit;
- no unknown pending cleanup;
- current verification for the intended release scope on the exact candidate.

Apply only after the backup and all blockers are recorded as successful. The
change affects subsequent routing; it does not recreate already running souls.

An existing managed-default installation does not need a routing transition
merely to upgrade. This repair's provider-free UI continuity acceptance covers
ordinary Codex and OpenCode terminal creation plus FreshCodex and FreshOpenCode
through the same web-only update, reload, and follow-up turn. It runs alongside
the separately selected update-mode, ownership, and maintenance-gate checks.
The final configured default suite, affected managed browser/smoke checks, and
required independent reviews are also part of the run. A failed or unobserved
check is not acceptance. The native recovery proofs and backup/upgrade drill
below remain operator rollout guidance but are outside this repair's
acceptance. The old all-mode production/pressure campaign is not an additional
delivery gate. Selected-mode results must never be reported as global campaign
or Gate 5 PASS.

## Upgrade an existing installation while preserving stores

Preparation does not write live artifacts, open the live registry with the
candidate, pause writers, or restart services. The deployment packet remains
in private files outside Git. Use the repair's run record for current test and
review results. Before a live update, resolve running-owner and artifact
metadata and verify backups where the selected update can open or change the
registry. The ordinary web/client update has no mode approval gate; the updater
requires the exact word `APPROVED` only for `--all` and `--durable-only`.

### Retaining processes from a legacy installation

The supervisor can continue an already running protocol-1 terminal host after
verifying its recorded incarnation, container ownership, configuration, boot
identity, and execution generation. This compatibility path supports terminal
input, output, resizing, status, and the older host's supported controls. It
does not create native recovery evidence or enable protocol-2 fresh-agent
operations on that host. New hosts use protocol 2. Missing ownership evidence
or a changed boot or generation blocks continuation without launching a
replacement. Recheck the retained identities and working input/output in the
isolated upgrade rehearsal.

A saved Codex terminal can also reuse its retained host-side app-server when
the exact native session and terminal-sidecar ownership record verify against
the running process. This restore keeps its existing host ownership even when
the client negotiates managed routing. A lost claim refuses the restore;
it must not silently launch another writer. This process remains host-managed
and is still reported by the normal updater's ownership census.

An existing host Claude conversation resumes through its original host
history when a terminal tab restores or opens that exact native identity.
The source must have one verified transcript, native UUID, original working
directory, and selected Claude configuration root. The source is checked
again before spawning; a missing, ambiguous, or changed source refuses without
starting a replacement. Existing managed adoption runs first, and fresh
managed creates keep their normal route. Direct REST creation refuses a
verified host-history resume and directs the caller to its terminal tab.
This preserves the conversation, not the old Claude process, and the resumed
terminal remains host-managed. Qualify the actual source and interruption
plan before bootstrap.

Host OpenCode terminal resumes use the exact-session transfer path. Qualify
the actual native identities, source and pinned target schema, required
descendants and assets, and imported native history. Native history readback
alone does not establish live PTY adoption; verify that separately after the
approved startup. Other host-managed providers need a separately verified
recovery procedure.

An installation without the authenticated readiness or maintenance APIs
cannot use the current updater for its initial upgrade. Its deliberate
bootstrap needs a concrete, separately approved procedure recording the
actual service owners, retained processes, host-agent interruption and recovery,
candidate artifacts, consistent old-schema backup, and old-build readability
checks. Preserve the exact running executables as well as the installed files:
a running deleted executable can differ from its installed pathname. Before
any candidate registry opener, an aborted bootstrap must select the verified
prior executable before starting the prior service. After a schema upgrade or
new writes, preserve the state and follow the fix-forward guidance below.
The reset-capable updater modes still reset managed sessions.

### Upgrade procedure

1. Identify the actual port-3001 server owner and supervisor owner, effective
   unit/drop-in or launcher commands, PID/cwd/executable, startup build identity,
   registry/schema, control/runtime roots, image digest, and client, sidecar,
   server, supervisor, and session-host artifact paths. Read metadata rather
   than conversation bodies. Record prior artifacts/configuration and candidate
   commit/tree/hashes/image privately. A mutable executable pathname alone
   does not identify the running build. Record how startup reconciles already
   desired-running managed agents while preserving user-stopped intent.
2. Prepare the reviewed candidate in an isolated build checkout. Use the
   managed-feature Rust command above, `pnpm install --frozen-lockfile`, and
   `pnpm run build:client`; retain the prepared Claude sidecar tree. Build the
   workload image from `docker/runtime/Dockerfile` and record its immutable
   digest. Resolve effective image, control settings, both server opt-ins, and
   artifact installation paths. Qualification overrides and fixture modes
   must be absent from the production configuration. Do not build into or
   replace live binary, sidecar, configuration, or client paths.
3. Rehearse the exact backup procedure on owned isolated stores from the prior
   build/schema, with synthetic provider/session data. Use SQLite online backup
   or `VACUUM INTO` to produce a consistent old-schema snapshot. Independently
   open it read-only, check `PRAGMA integrity_check` and the registry's
   `installation.schema_version`, record size/hash, and sync backup files and
   their directory. Keep directories `0700` and files `0600`. Preserve matching
   configuration, provider/session stores, referenced history assets, and prior
   artifacts/image. Active provider SQLite/WAL stores also require consistent
   snapshots; copying a live DB and WAL independently is unsafe.
4. Start the candidate only against a working copy of those isolated stores.
   Check upgraded identity/history, stopped intent, ordinary retries, and
   interrupted Stop completion. Demonstrate that the old artifact opens a
   separate working copy of the untouched old-schema backup and matching
   stores. Run existing `cargo test -p freshell-supervisor migration::tests`
   coverage as part of preparation; it does not substitute for this upgrade
   drill. Record actual results rather than labelling a proposed procedure
   verified. A successful isolated drill is not a live backup.
5. Resolve exact live backup commands against the recorded owner's paths. Use
   a supported consistent read-only source capture if available. Otherwise
   specify the required writer quiescence/maintenance and backup commands in
   the approval packet, having rehearsed them in isolation. The migration
   helper's `wal_checkpoint(FULL)` and `VACUUM INTO` are not a read-only source
   operation. No live source-side write or pause is authorized by preparation.
6. Complete current candidate checks and independent reviews, commit and push
   the clean feature branch through its pre-push gate, then request explicit
   approval to create/land this change's PR. Follow the normal PR-to-main flow
   only after that approval and fast-forward clean local main. Compare the
   merged source tree with the verified candidate; a changed runtime tree
   needs the relevant checks. Historical PR approval is not approval here.
7. Complete the separately authorized deployment packet with verified
   artifacts and isolated backup/readability results, the actual owner and
   checkout, any required live backup, post-update checks, and failure
   recovery. A live backup not yet taken stays explicitly pending. Do not
   deploy while ownership, backup, or recovery details are unresolved.
8. Recheck exact ownership and candidate/main pins. Create and independently
   verify the consistent old-schema live backup **before any candidate
   registry opener**. Abort if integrity, consistency, or old-build
   readability fails. Preserve registry/control/runtime/provider/session
   paths and prior artifacts/config. From the host shell, run the selected
   updater mode in the deployment checkout as described in the
   [self-hosted launch runbook](self-hosted-launch-runbook.md#managed-runtime-update-modes).
   The default mode needs no mode approval and changes only web/client; the
   updater itself accepts the exact word `APPROVED` only for `--all` and
   `--durable-only`. Do not use the launcher's `--stop` or `--restart` for a
   live managed installation; those actions do not perform the ownership
   census. The updater supports systemd-owned installations only.
9. Check the authenticated runtime readiness response and supervisor
   installation identity, startup build/features, effective image, callback
   readiness, intended release-mode admission as recorded in the candidate
   manifest, structured errors, and preserved inventory/history metadata. Do
   not import, prompt, or start historical
   conversations as a smoke test. No historical repair route, duplicate-owner
   choice, notice withdrawal, or bulk reconciliation is part of this update.

On failure preserve the upgraded state and stores, inspect the recorded logs,
and prefer a compatible fix-forward. An old binary may reject the new schema.
An old-state restore needs the verified old-schema backup, matching stores,
configuration/artifacts/image, and a separately authorized concrete restore
and restart. Refuse a restore that would discard later writes or changed user
intent; preserve that state and fix forward. There is no generic down-migration
or permission to destroy source stores. See the existing
[restore guidance](lost-soul-runbook.md#restore-from-backup).

## Rollback

Rollback sets the routing mode to `legacy` or, where supported, back to
`managed-opt-in`. It deliberately preserves:

- managed soul/incarnation and ownership records;
- provider-state volumes and checkpoints;
- durable view intents and ended history;
- incidents, notice receipts, metrics, and migration audit rows;
- running managed agents, unless separately and explicitly stopped.

Rollback must not mass-kill runtimes or delete registry state. Existing managed
souls continue to be owned and cleaned only by the supervisor. Legacy clients
must not claim `managedRuntimeV1`; compatible views may reattach to an existing
managed terminal without launching a duplicate.

After rollback, run the read-only repair audit and verify every running soul has
exactly one active writer and every cleanup-pending soul retains its ownership
record.

## Backup and restore drills

Existing migration regression coverage should prove:

1. dry-run leaves legacy metadata byte-identical;
2. managed-default refuses without a verified backup;
3. backup opens cleanly and passes SQLite integrity checks;
4. opt-in/default/legacy transitions are request-idempotent and epoch-fenced;
5. rollback leaves managed souls and unrelated sentinels running;
6. restore from backup retains soul/native identity, view intent, incident, and
   notice receipt rows;
7. no transition issues an unsafe broker request.

## Observability and alerts

Track bounded counters/gauges for recovery outcomes, cleanup outcomes, pending
incidents/exports/notices, duplicate-writer violations, false-loss notices,
and startup convergence. Logs are structured, private, rotated, and redacted
before persistence. Alert on:

- `lost` with any unknown path evidence;
- cleanup not converging to `verified_empty`;
- notice backlog growth or repeated unacknowledged final notice for one profile;
- outbox/export backlog;
- repair reporting unknown ownership;
- more than one running incarnation per soul;
- unsafe broker attempts;
- unbounded log/output growth.

## Qualification commands

Focused checks:

```bash
~/.local/bin/mise exec rust@1.96 -- cargo test \
  -p freshell-runtime-protocol \
  -p freshell-runtime-observability \
  -p freshell-agent-runtime \
  -p freshell-supervisor \
  -p freshell-runtime-client \
  -p freshell-session-host \
  -p freshell-server --all-features
pnpm run typecheck
pnpm run contract:generate
```

Follow repository test coordination and destructive-test containment for these
checks. Reuse current candidate results rather than repeating suites solely
for prose changes. This repair's final record needs Task 6 ordinary UI
continuity results for OpenCode terminal and Freshcodex, the final configured
full-suite gate, affected managed browser/smoke checks, and the required
independent review records. The
native-recovery rows and isolated backup/upgrade drill in the operator
procedure above are not acceptance gates for this repair. A deterministic
fixture does not replace a live ordinary-use result or a live recovery receipt
when a future rollout requires either one.

Existing full runtime gates and their receipt producers remain available for
claims that require them. They are not additional all-mode/pressure obligations
for this repair. Evidence is untracked beneath
`.runtime-evidence/<candidate-sha>/<run-id>/` or in the current private run
directory. Another commit/image, a skipped test, failed cleanup, or an unsafe
broker attempt does not establish a pass. Report exactly what ran and what
remains pending; selected-mode evidence is not global Gate 5 certification.

## Promoting a deferred provider

Promote only modes included in the authorized release scope after their actual
live recovery evidence is available. Use the configured qualification cost
policy and authorized credential path. Terminal OpenCode's configured OpenAI
profile and fresh OpenCode's configured free profile are distinct; do not
silently substitute one for the other. The promotion candidate must observe a
real turn, exact native identity, native resume after both provider-process and
session-host loss, blocker classification, second-view one-writer behavior,
browser approval/tool continuity, safe cleanup, and a follow-up in the same
conversation. Then, in one candidate, flip that provider's `certificationState` to
`certified` together with `managedEnabled` and `durableRecoveryEnabled` (the
Rust capability table and its manifest test enforce that they move together),
verify the affected production routing and recovery against that candidate,
and complete the required default/browser checks and reviews. Fresh-agent
release metadata and native admission must agree as well. Amplifier/Kilroy are
not promoted by this repair. Never enable a provider based only on adapter unit
tests or CLI availability.
