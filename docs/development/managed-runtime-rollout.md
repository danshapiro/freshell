# Managed runtime rollout, migration, and rollback

Durable Souls ships behind an explicit supervisor rollout mode. Changing the
routing mode preserves managed state. Reversing routing does not reverse a
registry schema upgrade.

## Current staged release scope

The current candidate checks for this repair are the four user-approved
ordinary turns: terminal Codex and OpenCode, plus FreshCodex and FreshOpenCode.
Claude live behavior remains unverified by explicit agreement. The configured
full-suite gate, affected managed browser/smoke checks, and required independent
reviews are also part of this run. Record actual results against the tested
candidate in the repair's run record. Native recovery proofs and the
backup/upgrade drill below are general rollout procedures, not acceptance
gates for this repair. This runbook
does not certify, promote, or describe an installed candidate. Managed
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
the feature and makes the Rust server depend on the supervisor. Restarting the
existing production server still requires the user's exact **APPROVED**. Do not
run Compose `down` or remove the runtime root during an ordinary rollout.

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
merely to upgrade. This repair's acceptance remains the four user-approved
ordinary-use checks, the final configured default suite, affected managed
browser/smoke checks, and required independent reviews. A failed or unobserved
check is not acceptance. The native recovery proofs and backup/upgrade drill
below remain
operator rollout guidance but are outside this repair's acceptance. The old
all-mode production/pressure campaign is not an additional delivery gate.
Selected-mode results must never be reported as global campaign or Gate 5 PASS.

## Upgrade an existing installation while preserving stores

Preparation does not write live artifacts, open the live registry with the
candidate, pause writers, or restart services. The deployment packet remains
in private files outside Git. Use the repair's run record for current test and
review results. The later operator rollout steps still require resolving running-owner
and artifact metadata, verifying backups where applicable, and obtaining
production approval.

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
7. Present the concrete installation packet for the separate exact
   **APPROVED**: verified artifacts and isolated backup/readability results,
   actual owner-specific installation and restart commands, any backup
   maintenance, live-backup boundary, post-install checks, and failure recovery.
   A live backup not yet taken stays explicitly pending. Do not request
   production approval while these preparation details are unresolved.
8. Only after that approval, recheck exact ownership and candidate/main pins.
   Create and independently verify the consistent old-schema live backup
   **before any candidate registry opener**. Abort installation if integrity,
   consistency, or old-build readability fails. Preserve the existing
   registry/control/runtime/provider/session paths and prior artifacts/config.
   Install the prepared candidate through the actual owning procedure in the
   [self-hosted launch runbook](self-hosted-launch-runbook.md#managed-runtime-upgrades).
   Restart the recorded supervisor first and verify control readiness, then
   restart the owning server retaining port 3001. A launcher-owned server uses
   `scripts/launch-rust.sh --skip-build --restart --port 3001` after installing
   the prepared managed-feature binary; its default rebuild omits that feature.
   Never use the launcher to control a systemd-owned server.
9. Check health, startup build/features, effective image, intended four-mode
   admission, structured errors, and preserved inventory/history metadata.
   Do not import, prompt, or start historical conversations as a smoke test.
   No historical repair route, duplicate-owner choice, notice withdrawal, or
   bulk reconciliation is part of this installation.

On failure preserve the upgraded state and stores, inspect the recorded logs,
and prefer a compatible fix-forward. An old binary may reject the new schema.
An old-state restore needs the verified old-schema backup, matching stores,
configuration/artifacts/image, and a separately approved concrete restore and
restart. Refuse a restore that would discard later writes or changed user
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
for prose changes. This repair's final record needs Task 9 ordinary-use results
for the four selected modes, the final configured full-suite gate, affected
managed browser/smoke checks, and the required Stage 5 review records. The
native-recovery rows and isolated backup/upgrade drill in the operator
procedure above are not acceptance gates for this repair. A deterministic
fixture does not replace a live ordinary-use result or a live recovery receipt
when a future rollout requires either one.

Existing full runtime gates and their receipt producers remain available for
claims that require them. They are not additional all-mode/pressure obligations
for this four-mode repair. Evidence is untracked beneath
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
