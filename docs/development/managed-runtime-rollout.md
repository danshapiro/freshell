# Managed runtime rollout, migration, and rollback

Durable Souls ships behind an explicit supervisor rollout mode. The rollout is
stateful, auditable, and reversible at the routing layer; it does not delete
managed state.

## Full product scope and conservative defaults

All original coding agents and modes remain in scope. Current defaults still
enable managed shell/OpenCode; other adapters and fresh modes need actual
behavioral validation before their defaults change. Stage 5a replaces report
certification with ordinary tests, not an OpenCode-only release promise.

Provider facts and defaults live in one manifest embedded by Rust. Explicit
FRESHELL_MANAGED_PROVIDERS on web and supervisor selects implemented terminal
adapters using normal production routing. This is installation configuration,
not a qualification-only binary feature. Missing credentials, unsupported
providers, and missing adapters remain blockers. Neither a setting nor code
presence establishes readiness. Fresh-mode configuration is still separate.

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

For Amplifier, optionally point
`FRESHELL_MANAGED_AMPLIFIER_ONECLI_KEYS_FILE` at the approved private
`~/.amplifier/keys.env` (that canonical file is the default). No second endpoint
variable is required: the approved file is the source of truth for the
LunaRoute upstream and OneCLI proxy transport. The runtime image pins the same
provider-vllm source used by that setup and `glm-5.3`; the native
`session:config` event is the provider-effective authority for model/reasoning.
The keys file is parsed, never sourced; host-local OneCLI control URLs are not
forwarded into the container, while provider/proxy secret values exist only in
the child environment. A raw OAuth file, a different reference, malformed
transport URL, or an unapproved model fails closed.

These bootstrap paths configure the actual provider; they do not replace
behavioral testing or change installation enablement by themselves.

## Enabling managed default

Managed-default additionally requires:

- a consistent SQLite backup made by the supervisor backup API;
- recorded path, size/hash, and successful verification;
- clean registry integrity and ownership audit;
- no unknown pending cleanup;
- passing relevant deterministic, actual-provider/browser, and stress tests
  for the code being deployed, including the complete intended provider matrix.

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

## Verification before deployment

```bash
npm run check
npm run test:runtime:verify -- --suite all
```

The runtime command includes actual providers and long stress work; it needs
credentials and a Docker-capable configured browser runner. See
`test/runtime/README.md` for focused commands. Failed, skipped, and unrun
scenarios remain unresolved; no report import or clean-SHA certificate is needed.

Exercise each mode being enabled: exact native identity and follow-up
continuity, web/host/provider failure, blockers and repair, one writer across
views, approval/tool continuity, resource limits, and cleanup. Set ordinary
installation enablement or deliberately change defaults only after it works.
Keep a consistent registry backup, resource preflight, and safe rollback path.
All existing PR and production deployment approvals still apply.
