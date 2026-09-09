# Managed runtime rollout, migration, and rollback

Durable Souls ships behind an explicit supervisor rollout mode. The rollout is
stateful, auditable, and reversible at the routing layer; it does not delete
managed state.

## Current staged release scope

The current release-qualified durable provider is **OpenCode 1.18.21** with the
free-tier `opencode/big-pickle` model. Claude, Codex, and Amplifier are
adapter-ready but remain explicitly release-disabled as
`PENDING_LIVE_QUALIFICATION`. Their ordinary legacy routes continue to work;
they are not eligible for managed ownership, managed-default routing, loss
certification, or a durable-provider support claim yet.

The capability manifest is executable policy. Rust WebSocket/REST routing and
direct supervisor launch admission all consume the same release flags. A
disabled provider cannot bypass the staged rollout through a lower-level API.

Each provider row carries an explicit `certificationState`. Claude, Codex, and
Amplifier are `pending_live_provider_certification`; OpenCode and the managed
shell are `certified`; the legacy extension providers are `not_applicable`. The
manifest's `certification` block names the deferred set, the landing gate that
may defer it, and the production gate that stays
`BLOCKED_PENDING_LIVE_PROVIDER_CERTIFICATION` until it is empty.

## Modes

| Mode | Meaning |
|---|---|
| `legacy` | Existing legacy routing remains authoritative. Managed registry data is retained, but definitive provider negatives remain blocked rather than authorizing Phase 5 loss cleanup. |
| `managed-opt-in` | Explicitly selected managed providers/routes use the supervisor, durable views, recovery, and loss pipeline. Other routes remain legacy. |
| `managed-default` | Managed routing is the default for every enabled provider/mode in the checked-in capability manifest. Requires a verified registry backup and a clean preflight. |

The mode is stored in the supervisor registry, not in browser local storage.
Changing it is a fenced, request-deduplicated control transaction.

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
legacy metadata mutation.

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
3. Apply `managed-opt-in` with the current control epoch and a unique request ID.
4. Verify the returned inventory revision and rollout mode.
5. Open one managed agent for every provider currently marked
   `managedEnabled && durableRecoveryEnabled`. For this landing that is
   OpenCode with `opencode/big-pickle` free tier.
6. Verify exact provider-native identity capture, one writer per soul, web
   replacement continuity, controller replacement recovery, resource limits,
   and zero false loss notices.

Unavailable required low-cost configuration is a rollout blocker. Do not
silently upgrade model cost or reasoning.

Before a deferred-provider live campaign, persist the exact coding-CLI launch
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

For Amplifier, point
`FRESHELL_MANAGED_AMPLIFIER_SETTINGS_FILE` at the settings file that selects
the approved lowest-cost model and point
`FRESHELL_MANAGED_AMPLIFIER_OAUTH_FILE` at its separate OAuth token file.
Defaults are `~/.amplifier/settings.yaml` and
`~/.amplifier/openai-chatgpt-oauth.json`. Both are canonical, reference-only
bootstrap inputs; do not inline their contents in settings, commands, or test
evidence.

These values and bootstrap paths make a live campaign reproducible. They do
not certify or enable Claude, Codex, or Amplifier; the capability manifest
remains authoritative until a later, receipt-bearing promotion change.

## Enabling managed default

Managed-default additionally requires:

- a consistent SQLite backup made by the supervisor backup API;
- recorded path, size/hash, and successful verification;
- clean registry integrity and ownership audit;
- no unknown pending cleanup;
- cumulative Gate 5 PASS on the exact candidate;
- final provider, browser chaos, and 30-minute soak receipts bound to that
  candidate.

Apply only after the backup and all blockers are recorded as successful. The
change affects subsequent routing; it does not recreate already running souls.

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

A release drill should prove:

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
~/.local/bin/mise exec node@22 -- npm run typecheck
~/.local/bin/mise exec node@22 -- npm run contract:generate
```

Candidate-bound live qualification. Generate the enabled-provider,
browser-loss, browser-chaos, Phase 2-4, and >=30-minute soak receipts with the
checked-in receipt producers first, then run the gate for the release state you
are actually claiming:

```bash
# Landing / pre-certification gate. Passes only when every non-deferred case
# passes and the ONLY deferrals are the manifest's deferrable providers
# (currently Claude, Codex, Amplifier).
npm run test:runtime -- gate landing --require-live

# Full production Gate 5. Stays BLOCKED (exit 2) with
# blockedReason "pending_live_provider_certification" until every required
# provider is live-certified. BLOCKED is never PASS.
npm run test:runtime -- gate phase-5 --require-live
```

Gate evidence is untracked beneath
`.runtime-evidence/<candidate-sha>/<run-id>/`. A receipt from another commit,
image, skipped test, failed cleanup, or unsafe broker attempt is not valid.
Every run also writes `deferred-providers.json`: the explicit manifest of what
the run did **not** prove.

## Promoting a deferred provider

Claude, Codex, and Amplifier are promoted one at a time, after live access is
available. Use the cost policy recorded in the capability manifest—Claude
Haiku/lowest reasoning, Codex GPT-5.6 Luna/lowest reasoning, and Amplifier's
approved lowest-cost model. The promotion candidate must directly observe a
real turn, exact native identity, native resume after both provider-process and
session-host loss, blocker classification, second-view one-writer behavior,
browser approval/tool continuity, safe cleanup, and a follow-up in the same
conversation. Then, in one candidate, flip that provider's `certificationState` to
`certified` together with `managedEnabled` and `durableRecoveryEnabled` (the
Rust capability table and its manifest test enforce that they move together),
rerun all SHA-bound browser and provider receipts, the pressure soak, the
landing gate, and cumulative production Gate 5. The production gate stops
reporting `BLOCKED_PENDING_LIVE_PROVIDER_CERTIFICATION` only when the last
deferred provider is certified. Never enable a
provider based only on adapter unit tests or CLI availability.
