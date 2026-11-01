# Lost managed-agent runbook

This runbook covers Freshell managed-agent incidents whose recovery state is
`lost`. It applies only to supervisor-owned managed souls. A missing browser
pane, a disconnected web server, an unreadable provider store, a rate limit, an
expired credential, or a failed cleanup is **not** by itself proof of loss.

## Providers in scope

Loss certification and cleanup only ever apply to providers the capability
manifest marks `certificationState: "certified"` with managed and durable
recovery enabled, or fresh modes whose corresponding release policy admits
durable recovery. Managed shell is certified for isolation but is intrinsically
non-resumable and never produces a durable-soul loss certificate.

The candidate enables terminal Claude/Codex/OpenCode and
Freshclaude/Freshcodex/Freshopencode. This repair checks ordinary use in the
four Codex/OpenCode modes; Claude live behavior remains unverified by explicit
agreement. Native recovery campaigns are not acceptance gates for this repair.
Read the actual candidate's release policy when determining which modes may
produce incidents. Managed Amplifier and Kilroy remain disabled; ordinary
legacy CLI integrations are unaffected. If a release-disabled mode appears in
a managed incident, capture the incident and investigate before cleanup.

## Meaning of `lost`

Freshell may commit `lost` only after the supervisor has freshly evaluated every
recovery path declared for the provider and every applicable path returned a
**definitive negative**. The decision transaction records:

- the soul and prior incarnation;
- the provider and runtime variant;
- a hash of the provider-native identity, never the raw identity;
- each recovery path and its evidence state;
- the missing invariant and observed cause;
- the exact cleanup target issued from the registry ownership record;
- a stable incident ID and correlation ID.

The incident is persisted before any cleanup signal is sent. The pane/view is
retained as ended history and continues to carry the soul ID, provider-native
session reference in the authenticated UI, and incident link. Freshell does not
replace it with a blank conversation.

`blocked` means evidence is incomplete or a reversible prerequisite failed.
`lost` means all registered recovery paths are positively unavailable. Never
translate one into the other manually.

## First response

1. Open **Managed agents** and expand the ended agent.
2. Record the displayed incident reference. Do not copy the raw provider state
   or credentials into a ticket.
3. Open **Details**. Confirm the incident reports all of the following:
   - decision state `lost`;
   - a complete recovery-path inventory;
   - cleanup state `verified_empty`, or an explicit cleanup failure;
   - foreign objects touched `0`.
4. Check whether the notice says cleanup succeeded or failed. A cleanup-failed
   notice is deliberately not phrased as success.
5. Preserve the supervisor registry, provider volume, and exported incident
   artifact before attempting repair. Do not remove Docker objects by label,
   name prefix, environment marker, partial ID, or process-name scan.

## Read-only inspection

The authenticated runtime API exposes bounded summaries:

```text
GET /api/runtime/souls/<soul-id>
GET /api/runtime/incidents/<incident-id>/summary
GET /api/runtime/notices?profileId=<profile>&limit=100
GET /api/runtime/metrics
GET /api/runtime/migration
GET /api/runtime/repair
```

The supervisor control protocol exposes the equivalent `inventory_snapshot`,
`incident_summary`, `pending_notices`, `metrics_snapshot`, `migration_plan`, and
`repair_audit` commands. Use the web API for ordinary operations; use the
control protocol only through the repository client/harness or an approved
operator tool.

Incident exports live under the supervisor state directory's `incidents/`
subdirectory. Open incidents are never evicted. Closed incidents follow the
configured bounded retention policy. Exports are written atomically with
private permissions and are redacted before the first persistent byte.

Useful evidence fields:

- `observedCause`: what the supervisor observed;
- `missingInvariant`: the exact invariant that made resume impossible;
- `pathEvidence`: native resume, checkpoint, pristine seed, or other declared
  provider paths and whether each was missing, corrupt, or unknown;
- `cleanup`: target, attempts, final backend state, and foreign-object count;
- `hypotheses`, `preventiveAction`, and `regressionCase`: follow-up engineering
  guidance, not cleanup authority.

## Cleanup failure

If the incident is `cleanup_failed` or `termination_unconfirmed`:

1. Do **not** start a replacement writer.
2. Do **not** delete the ownership row.
3. Restore access to the exact recorded backend/daemon and retry through the
   supervisor. Startup reconciliation automatically resumes pending cleanup.
4. Verify the final incident says `verified_empty` before considering the soul
   reaped.
5. A later success notice supersedes the temporary failure notice. Both rows
   remain auditable; only the final notice remains deliverable.

A Docker error, signal delivery, vanished PID, or stale label is not emptiness.
The backend must positively report the exact recorded enclosure absent, exited,
or dead.

## Notice acknowledgement

Notices are durable and acknowledged per Freshell profile. The UI polls while
connected and also refreshes on inventory revisions. A notice remains pending
until its explicit ACK commits. Reconnects may redisplay an unacknowledged
notice, but a committed ACK suppresses it for that profile across web and
supervisor restart.

The message is intentionally brief. The incident details endpoint is the
source of truth. Never encode credentials, raw native session IDs, prompts, or
provider payloads into the notice.

## Safe repair

Run the repair audit in read-only mode first. It checks schema/integrity,
ownership completeness, pending incidents/exports/notices, and view/soul
consistency. Repair is allowed to resume idempotent transactions already backed
by registry authority. It must not:

- infer ownership from Docker labels, process names, environment variables, or
  filesystem guesses;
- invent a provider-native identity;
- choose the newest or only session as a substitute;
- delete a provider volume or registry row because a probe is unreadable;
- replay an ambiguous user prompt or tool approval.

Where the audit reports unknown ownership or unknown provider state, restore the
missing authoritative data or leave the soul blocked. Escalate rather than
improvise destructive cleanup.

## Restore from backup

A transition into managed-default creates and verifies a consistent registry
backup before changing routing policy. A dry-run `backupPath` creates nothing,
and applying the same already-default mode creates no new backup. The helper
runs after registry opening, so it cannot protect the old schema from an
upgrade. Before any candidate opener, follow the
[pre-upgrade backup and isolated drill](managed-runtime-rollout.md#upgrade-an-existing-installation-while-preserving-stores).

Preserve upgraded state and prefer a compatible fix-forward. Old binaries may
refuse an upgraded schema. Restoring older state requires its verified
old-schema backup with matching provider/session stores, configuration, and
artifacts/image; refuse restoration that would discard later writes or changed
user intent. A routing rollback is not a schema down-migration.

For a separately requested restore:

1. Stop only the exact test/staging supervisor or use the approved production
   maintenance procedure through its actual owner. Production restore,
   writer quiescence, and supervisor/server restart require a concrete packet
   and the separate exact **APPROVED**.
2. Preserve the current registry, provider/session stores, configuration, and
   incident directory separately. Confirm that no later writes or stopped
   intent will be lost before replacing anything.
3. Verify recorded backup hash/size, SQLite integrity/schema, and actual
   old-build readability. Keep private directories `0700` and files `0600`.
4. Restore the consistent snapshot with its matching stores and artifacts.
   SQLite online backup or `VACUUM INTO` captures a coherent database; never
   independently copy a live DB and WAL or mix them with an older snapshot.
5. Start the recorded compatible supervisor first, verify control readiness,
   then the owning server. Inspect inventory/history metadata and stopped intent
   before any separately requested routing change. Do not prompt existing
   conversations as a restore check.

Legacy metadata is an import source, never kill authority. Rollback changes
routing policy; it does not erase managed souls, incidents, views, or ownership
records and does not mass-stop runtimes.

This repaired deployment preserves stores without automatically importing
existing sessions, choosing duplicate owners, or withdrawing historical
notices. Those operations are outside this repair and require a separate
request; they are not prerequisites or promised follow-up work.

## Escalation checklist

Escalate with the incident reference and redacted artifact when any of these is
true:

- an applicable recovery path is absent from the certificate;
- a path is `unknown` or `unreadable` but the incident says `lost`;
- cleanup claims success without `verified_empty`;
- foreign objects touched is nonzero;
- more than one deliverable final notice exists for one incident/profile;
- a replacement incarnation exists for a soul certified lost;
- a raw credential, prompt, or provider-native identity appears in persistent
  logs or incident exports;
- an open incident was evicted or its artifact cannot be reconstructed.

The regression must be added to the Phase 5 runtime gate before the incident is
closed operationally.
