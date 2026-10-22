//! Unified agent names (Task 7) — the ONE-TIME legacy-name consolidation.
//!
//! Before serving canonical naming reads, this boot migration reads every
//! supported legacy title-evidence source — `config.sessionOverrides`,
//! identity-resolvable `config.terminalOverrides`, server-saved tab/pane
//! registry snapshots, and genuinely active `session-metadata.json`
//! `derivedTitle` fields — backs the original raw payloads up immutably at
//! `<Freshell data directory>/name-migration-v1/server.json` (durable
//! create-once), and consolidates them through
//! [`SessionNames::import_legacy`] under the SAME strict name transaction
//! every server participant uses (never a separate locking scheme).
//!
//! Classification (server-authoritative): a `titleSource:"user"` session
//! override is the one reliable explicit-rename evidence (only the
//! user-facing session Rename ever wrote it) → manual; an old manual /
//! protected flag with lossy provenance (terminal overrides, tab
//! user-set flags, unsourced title rows) → `legacy_protected` with
//! `legacyOrigin:"unknown"` — protection is retained, human intent is
//! never recovered; every other row keeps its known automatic source
//! (`ai` → Freshell AI, `first-message`/`dir` → their rungs, a snapshot
//! pane/tab label without a flag or a `derivedTitle` → provider AI, the
//! parsed provider title those mirrors carried). Generic `updatedAt`,
//! file mtime and registry times are NEVER explicit-rename recency.
//!
//! After the receipt commits — winners, winning evidence and the
//! acknowledged candidate ids land per ≤100-candidate import chunk, and
//! `completed` commits once every chunk acknowledged — the scope-only
//! cleanup removes the migrated title fields — `titleOverride`/`titleSource`
//! from scoped session-override rows, `titleOverride` from
//! identity-resolvable terminal overrides, `derivedTitle` from active
//! metadata entries — never the summary/archive/delete/description data on
//! those rows, never a row outside the three scoped providers. Canonical
//! readers stop consulting the migrated fields the moment the receipt
//! commits (the in-memory override maps lose the fields in the same boot
//! step, before any request is served); if the physical cleanup cannot
//! flush, the next boot retries it idempotently.
//!
//! Browser imports through `POST /api/session-names/import` apply only
//! while the receipt is still open (with per-candidate acknowledgment and
//! their own immutable per-import backups), and can never replace a
//! post-migration manual or accepted-Freshell-AI name. Once the receipt
//! has committed, every browser import is acknowledged without any effect
//! — no record, stored candidate id or backup (name-reliability Task 3,
//! `session_name_import_policy`). The Amplifier-only
//! `run_ai_title_shadow_cleanup` stays separate.
//!
//! Recovery policy: the immutable `server.json` / `imports/*.json`
//! backups plus their evidence indexes ARE the retained recovery copies.
//! Recovery from a bad consolidation submits a deliberate canonical user
//! rename through the normal API — never a backup copied over the live
//! document, never a reactivated alias. A pre-feature binary rollback
//! requires an approved stopped scratch/maintenance restore; automatic
//! rollback is not part of this feature.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use freshell_freshagent::naming::SessionNaming;
use freshell_protocol::session_names::{
    legacy_name_candidate_id, LegacyCandidateIdInput, LegacyCandidateScope, LegacyEvidenceEnvelope,
    LegacyNameCandidate, LegacyNameImport, LegacyNameTarget, LegacyProtectionEvidence, NameSource,
    NamedProvider, SessionNameRef,
};
use freshell_ws::identity::TerminalIdentityRegistry;
use freshell_ws::tabs_persist::atomic_write_durable;
use serde_json::{json, Map, Value};

use crate::session_metadata::SessionMetadataStore;
use crate::session_names::{
    digest_bytes, order_boot_legacy_candidates, SessionNames, NAME_MIGRATION_BOOT_IMPORT_ID,
    NAME_MIGRATION_DIR_NAME, NAME_MIGRATION_IMPORT_CANDIDATE_LIMIT,
};
use crate::settings_store::SettingsStore;

/// The boot backup file name under `name-migration-v1/`.
const SERVER_BACKUP_FILE_NAME: &str = "server.json";

/// Everything the consolidation gathered from one boot's evidence sources.
struct LegacyEvidence {
    candidates: Vec<LegacyNameCandidate>,
    /// Scoped `sessionOverrides` rows still carrying title fields (cleanup
    /// targets) — `"<provider>:<sessionId>"`.
    session_rows_with_title: Vec<String>,
    /// Terminal override ids whose title cleanup is authorized (resolved to
    /// a scoped session through the identity ledger or retained snapshot
    /// evidence).
    resolved_terminal_ids: Vec<String>,
    /// Terminal override ids that stayed unresolved — recovery-only, their
    /// overrides are never touched.
    unresolved_terminal_ids: Vec<String>,
    /// `(provider, sessionId)` metadata entries with a genuinely active
    /// `derivedTitle` (cleanup targets).
    metadata_rows_with_derived_title: Vec<(String, String)>,
    /// The evidence index: ambiguous/unresolved candidate descriptions
    /// retained with the backup.
    ambiguous_index: Vec<String>,
    /// The raw evidence payload (byte-equivalent original content) for the
    /// immutable server backup.
    raw_sources: Map<String, Value>,
}

/// Run the one-time consolidation (and its idempotent cleanup retry). Safe
/// to call on every boot: a committed receipt skips straight to the cleanup
/// retry. Must complete before the server serves canonical naming reads.
pub(crate) async fn run_session_name_consolidation(inputs: SessionNameConsolidationInputs) {
    let SessionNameConsolidationInputs {
        names,
        settings,
        metadata,
        identity,
        data_dir,
        snapshots_dir,
    } = inputs;

    let mut evidence = gather_legacy_evidence(
        &settings,
        &metadata,
        &identity,
        &names,
        snapshots_dir.as_deref(),
    )
    .await;

    // The immutable server backup: durable create-once, byte-equivalent
    // original content plus the ambiguous/unresolved evidence index. A
    // present file is never rewritten.
    if let Err(error) = write_server_backup_once(&data_dir, &evidence) {
        tracing::error!(
            target: "freshell_server::session_names",
            op = "legacy_name_backup",
            name_ref = "-",
            revision = 0,
            class = "persistence",
            attempt = 1,
            "session_names.operation_failed: cannot write the legacy-name server backup: {error}"
        );
        // Without the backup the consolidation never runs: the originals
        // stay intact and the next boot retries.
        return;
    }

    let receipt_was_complete = names.migration_completed();
    if !receipt_was_complete {
        // The plan's batching rule: at most 100 candidates per
        // envelope/importId. Order the gathered candidates best-first
        // (rank, rename recency, scope; then candidate id) first, THEN
        // chunk: the ordering keeps every chunk's membership — and which of
        // several equal candidates installs first and stays — stable across
        // boots (the create-once per-import backups and the per-candidate
        // acknowledgment replay both key off the chunk ids).
        let mut candidates = std::mem::take(&mut evidence.candidates);
        order_boot_legacy_candidates(&mut candidates);
        let envelopes = boot_evidence_envelopes(&evidence);
        let chunked = candidates.len() > NAME_MIGRATION_IMPORT_CANDIDATE_LIMIT;
        let mut acknowledged = 0usize;
        let mut changed = 0usize;
        for (index, chunk) in candidates
            .chunks(NAME_MIGRATION_IMPORT_CANDIDATE_LIMIT)
            .enumerate()
        {
            let import = LegacyNameImport {
                version: 1,
                import_id: if chunked {
                    format!("{}--{index}", NAME_MIGRATION_BOOT_IMPORT_ID)
                } else {
                    NAME_MIGRATION_BOOT_IMPORT_ID.to_string()
                },
                evidence: envelopes.clone(),
                candidates: chunk.to_vec(),
            };
            match names.import_legacy(import).await {
                Ok(result) => {
                    acknowledged += result.acknowledged.len();
                    changed += result.names.iter().filter(|update| update.changed).count();
                }
                Err(error) => {
                    tracing::error!(
                        target: "freshell_server::session_names",
                        op = "legacy_name_consolidation",
                        name_ref = "-",
                        revision = 0,
                        class = %error.code(),
                        attempt = 1,
                        chunk = index,
                        "session_names.operation_failed: legacy-name consolidation \
                         failed on import chunk {index}; originals retained, the \
                         receipt stays open, retrying next boot: {error}"
                    );
                    // Not every chunk committed — do not complete the
                    // receipt and do not clean up either: the legacy
                    // fields stay live until a boot that commits every
                    // chunk (per-candidate acknowledgment makes the landed
                    // chunks resume-safe no-ops).
                    return;
                }
            }
        }
        // The receipt: committed only once EVERY chunk acknowledged — a
        // boot interrupted between chunks leaves it open and the next
        // boot resumes the remaining chunks.
        if let Err(error) = names.complete_legacy_migration().await {
            tracing::error!(
                target: "freshell_server::session_names",
                op = "legacy_name_consolidation",
                name_ref = "-",
                revision = 0,
                class = %error.code(),
                attempt = 1,
                "session_names.operation_failed: cannot commit the legacy-name \
                 consolidation receipt; originals retained, retrying next boot: {error}"
            );
            return;
        }
        tracing::info!(
            target: "freshell_server::session_names",
            op = "legacy_name_consolidation",
            name_ref = "-",
            revision = 0,
            acknowledged,
            changed,
            "one-time legacy-name consolidation committed"
        );
    }

    // Scope-only cleanup — idempotent, retried every boot while any migrated
    // field survives. Failures log loudly and leave the retry to the next
    // boot; canonical readers already stopped consulting the fields the
    // moment the receipt committed.
    //
    // Round-2 carried finding F3 (adjudicated): once the receipt was ALREADY
    // complete at boot, any title field still in the fresh evidence was
    // written POST-migration — in the narrow dual-server scenario that is a
    // side-by-side legacy binary, whose value the closed receipt can never
    // import and the create-once `server.json` can never cover. Preserve it
    // in a content-addressed create-once LATE backup before suppression —
    // the same recovery policy as a late BROWSER import's per-import
    // backup: the alias is never reactivated, but the string is never lost.
    if receipt_was_complete && evidence_has_title_fields(&evidence) {
        if let Err(error) = write_late_legacy_evidence_once(&data_dir, &evidence) {
            tracing::error!(
                target: "freshell_server::session_names",
                op = "legacy_name_late_backup",
                name_ref = "-",
                revision = 0,
                class = "persistence",
                attempt = 1,
                "session_names.operation_failed: cannot write the late legacy-evidence \
                 backup; keeping the late fields for the next boot instead of losing \
                 them to cleanup: {error}"
            );
            return;
        }
    }
    cleanup_legacy_title_fields(&settings, &metadata, &evidence).await;
}

/// Whether the freshly gathered evidence still carries any scoped title
/// field to suppress.
fn evidence_has_title_fields(evidence: &LegacyEvidence) -> bool {
    !evidence.session_rows_with_title.is_empty()
        || !evidence.resolved_terminal_ids.is_empty()
        || !evidence.metadata_rows_with_derived_title.is_empty()
}

/// The create-once, content-addressed backup of POST-migration legacy
/// title evidence: one file per distinct evidence snapshot under
/// `name-migration-v1/late-legacy-evidence/`, never rewritten, mirroring
/// `server.json`'s body shape (raw sources plus the affected keys) so the
/// documented recovery procedure — a deliberate canonical user rename
/// through the normal API, never restoring a backup — has the string.
fn write_late_legacy_evidence_once(
    data_dir: &Path,
    evidence: &LegacyEvidence,
) -> Result<(), String> {
    let dir = data_dir
        .join(NAME_MIGRATION_DIR_NAME)
        .join("late-legacy-evidence");
    let body = json!({
        "version": 1,
        "migration": "unified-agent-names-v1",
        "phase": "late",
        "sources": evidence.raw_sources,
        "sessionRowsWithTitle": evidence.session_rows_with_title,
        "resolvedTerminals": evidence.resolved_terminal_ids,
        "metadataRowsWithDerivedTitle": evidence.metadata_rows_with_derived_title,
        "unresolvedTerminals": evidence.unresolved_terminal_ids,
        // Recovery policy: same as server.json — never copy this over the
        // live name document or reactivate an alias.
        "recovery": "submit a deliberate canonical user rename through the normal API; \
                     never restore a backup over the live document",
    });
    let bytes = serde_json::to_vec(&body)
        .map_err(|e| format!("cannot serialize the late legacy-evidence backup: {e}"))?;
    let digest = digest_bytes(&bytes);
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    let path = dir.join(format!("{hex}.json"));
    if path.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let tmp = dir.join(format!(".{hex}.json.tmp"));
    atomic_write_durable(&path, &tmp, &bytes)
        .map_err(|e| format!("late legacy-evidence backup write failed: {e}"))
}

/// The boot module's wiring inputs.
pub(crate) struct SessionNameConsolidationInputs {
    pub names: Arc<SessionNames>,
    pub settings: Arc<SettingsStore>,
    pub metadata: Arc<SessionMetadataStore>,
    pub identity: TerminalIdentityRegistry,
    /// The configured Freshell data directory (`<home>/.freshell`) — where
    /// the name document and the migration backups live.
    pub data_dir: PathBuf,
    /// The server-saved tab-registry snapshot directory, when one exists.
    pub snapshots_dir: Option<PathBuf>,
}

/// Gather every supported legacy title-evidence source for the scoped
/// providers. Missing files mean no evidence; a corrupt source is retained
/// verbatim in the backup and diagnosed, never silently replaced.
///
/// Delta-review round 4, finding 1: the KILROY-MODE rows among the
/// candidates are excluded by the shared kilroy-lane seam
/// (`crate::kilroy_lane`) — a kilroy-only session never imports (never the
/// Global Constraint's forbidden competing Kilroy record) and is never a
/// cleanup target, so its rows stay in the legacy lane the sweep still
/// serves. The dual-mode reasoning (the Global Constraint's singular-name
/// rule, made explicit): the exclusion is per-ROW — a row is excluded only
/// when its session is kilroy-ONLY, i.e. metadata-typed kilroy AND holding
/// NO canonical record. At consolidation time the identity ledger is empty
/// (the boot runs before any terminal restore), so the live-scoped-terminal
/// component is vacuous and the RECORD is the operative dual-mode evidence:
/// a session whose canonical record already exists (a previously landed
/// chunk of this same migration, an earlier boot's sweep hydration, a
/// create-lane bind) is NOT kilroy-only — its legacy rows still import and
/// clean exactly like any scoped row, the supported-mode record keeps
/// owning its ONE singular name, and no second record is ever minted. A
/// first-boot kilroy-typed row with no other evidence stays legacy, which
/// matches the sweep's judgment of that same instant; if the session later
/// opens through a supported mode, the sweep hydrates it as scoped and the
/// directory's lane closes on the record — the retained legacy string
/// stays recoverable through the immutable `server.json` backup and a
/// deliberate canonical rename.
async fn gather_legacy_evidence(
    settings: &SettingsStore,
    metadata: &SessionMetadataStore,
    identity: &TerminalIdentityRegistry,
    names: &Arc<SessionNames>,
    snapshots_dir: Option<&Path>,
) -> LegacyEvidence {
    let mut evidence = LegacyEvidence {
        candidates: Vec::new(),
        session_rows_with_title: Vec::new(),
        resolved_terminal_ids: Vec::new(),
        unresolved_terminal_ids: Vec::new(),
        metadata_rows_with_derived_title: Vec::new(),
        ambiguous_index: Vec::new(),
        raw_sources: Map::new(),
    };

    let overrides = settings.session_overrides();
    let metadata_entries = metadata.get_all().await;
    let kilroy_only = {
        let mut candidates: Vec<crate::kilroy_lane::KilroyLaneCandidate> = Vec::new();
        for key in overrides.keys().chain(metadata_entries.keys()) {
            let Some((provider, session_id)) = key.split_once(':') else {
                continue;
            };
            candidates.push(crate::kilroy_lane::KilroyLaneCandidate {
                provider: provider.to_string(),
                session_id: session_id.to_string(),
                cwd: None, // config/metadata rows carry no cwd
            });
        }
        let naming: Arc<dyn SessionNaming> = names.clone();
        crate::kilroy_lane::kilroy_only_keys(
            &metadata_entries,
            Some(&naming),
            identity,
            // No terminal registry at consolidation time — see the doc
            // comment above for why the record component is the operative
            // dual-mode evidence here.
            None,
            &candidates,
        )
        .await
    };

    gather_session_overrides(&overrides, &kilroy_only, &mut evidence);
    let snapshot_pane_terminals = gather_snapshot_evidence(snapshots_dir, &mut evidence);
    gather_terminal_overrides(settings, identity, &snapshot_pane_terminals, &mut evidence);
    gather_metadata_derived_titles(&metadata_entries, &kilroy_only, &mut evidence);
    evidence
}

/// `config.sessionOverrides` — the old durable session-title ladder. Only
/// the three scoped providers migrate; every other provider's rows stay
/// untouched (Amplifier, Gemini, …), and — since delta-review round 4,
/// finding 1 — the KILROY-MODE rows among the scoped providers stay in the
/// legacy lane too (never a candidate, never a cleanup target), keeping
/// the module's "Kilroy rows stay untouched" contract true.
fn gather_session_overrides(
    overrides: &Map<String, Value>,
    kilroy_only: &HashSet<String>,
    evidence: &mut LegacyEvidence,
) {
    evidence.raw_sources.insert(
        "config.sessionOverrides".to_string(),
        Value::Object(overrides.clone()),
    );
    for (key, row) in overrides {
        let Some((provider, session_id)) = key.split_once(':') else {
            // A key with no ':' is a legacy pre-provider row ("claude" by
            // Node's convention). It is out of the three scoped providers'
            // composite space — treat it as unsupported and leave it.
            continue;
        };
        if freshell_freshagent::naming::named_provider_for(Some(provider), None).is_none() {
            continue;
        }
        // A kilroy-mode row keeps the legacy lane — the sweep still writes
        // and reads these titles for kilroy's existing UI.
        if kilroy_only.contains(key) {
            continue;
        }
        let has_title_fields =
            row.get("titleOverride").is_some() || row.get("titleSource").is_some();
        if !has_title_fields {
            continue;
        }
        evidence.session_rows_with_title.push(key.clone());
        let Some(title) = row
            .get("titleOverride")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .map(str::to_string)
        else {
            continue;
        };
        let source_row = row.get("titleSource").and_then(Value::as_str);
        let (source, protection) = match source_row {
            Some("user") => (NameSource::Manual, LegacyProtectionEvidence::ExplicitRename),
            // The old generate-title ladder's accepted Freshell AI row.
            Some("ai") => (NameSource::FreshellAi, LegacyProtectionEvidence::None),
            Some("first-message") => (NameSource::FirstMessage, LegacyProtectionEvidence::None),
            Some("dir") => (NameSource::Directory, LegacyProtectionEvidence::None),
            // 'legacy', or a title with no recorded source: an old override
            // with lossy provenance — protected, never human-claimed.
            _ => (
                NameSource::LegacyProtected,
                LegacyProtectionEvidence::LegacyFlag,
            ),
        };
        evidence.candidates.push(LegacyNameCandidate {
            id: legacy_name_candidate_id(LegacyCandidateIdInput {
                storage_key: "config.sessionOverrides",
                device_id: None,
                tab_id: None,
                pane_id: None,
                scope: LegacyCandidateScope::Session,
                provider: Some(provider),
                session_id: Some(session_id),
                name: &title,
                source,
                protection_evidence: protection,
                explicit_rename_at: None,
            }),
            target: LegacyNameTarget::Canonical(SessionNameRef::Session {
                provider: freshell_freshagent::naming::named_provider_for(Some(provider), None)
                    .expect("scoped above"),
                session_id: session_id.to_string(),
            }),
            name: title,
            source,
            scope: LegacyCandidateScope::Session,
            explicit_rename_at: None,
            evidence_key: format!("session-override:{key}"),
            protection_evidence: protection,
        });
    }
}

/// Server-saved tab-registry snapshots: per-device unions hold the closed
/// and open records with their tab labels, user-set flags, pane payloads
/// and (post-Task-6) `nameSource` pointers. A record's generic
/// `updatedAt`/`revision` are NOT rename recency — only `titleSetByUser`
/// claims protection, with unknown origin.
///
/// Returns terminal-id → resolved scoped session identity found in snapshot
/// pane payloads — the retained native evidence the identity-ledger miss
/// falls back to for terminal overrides.
fn gather_snapshot_evidence(
    snapshots_dir: Option<&Path>,
    evidence: &mut LegacyEvidence,
) -> HashMap<String, SessionNameRef> {
    let mut terminal_index: HashMap<String, SessionNameRef> = HashMap::new();
    let Some(dir) = snapshots_dir else {
        return terminal_index;
    };
    let devices = match freshell_ws::tabs_persist::list_snapshot_devices(dir) {
        Ok(devices) => devices,
        Err(error) => {
            tracing::warn!(
                target: "freshell_server::session_names",
                op = "legacy_name_snapshots",
                name_ref = "-",
                revision = 0,
                class = "io",
                "session_names.operation_failed: cannot list tab-registry snapshots for the \
                 legacy-name consolidation: {error}"
            );
            return terminal_index;
        }
    };
    let mut snapshot_sources = Map::new();
    for device in devices {
        let union = match freshell_ws::tabs_persist::read_device_union(dir, &device) {
            Ok(Some(union)) => union,
            Ok(None) => continue,
            Err(error) => {
                tracing::warn!(
                    target: "freshell_server::session_names",
                    op = "legacy_name_snapshots",
                    name_ref = "-",
                    revision = 0,
                    class = "io",
                    "session_names.operation_failed: cannot read tab-registry snapshot for \
                     device {device}: {error}"
                );
                continue;
            }
        };
        snapshot_sources.insert(device.clone(), union.clone());
        let Some(records) = union.get("records").and_then(Value::as_array) else {
            continue;
        };
        for record in records {
            gather_snapshot_record(&device, record, evidence, &mut terminal_index);
        }
    }
    evidence
        .raw_sources
        .insert("tabs-registry".to_string(), Value::Object(snapshot_sources));
    terminal_index
}

/// One snapshot record's tab label and pane labels.
fn gather_snapshot_record(
    device: &str,
    record: &Value,
    evidence: &mut LegacyEvidence,
    terminal_index: &mut HashMap<String, SessionNameRef>,
) {
    let tab_key = record
        .get("tabKey")
        .and_then(Value::as_str)
        .unwrap_or("<unknown>");
    let tab_id = record.get("tabId").and_then(Value::as_str);
    let tab_name = record
        .get("tabName")
        .and_then(Value::as_str)
        .filter(|n| !n.is_empty());
    let tab_flagged = record
        .get("titleSetByUser")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let panes = record.get("panes").and_then(Value::as_array).cloned();
    let Some(panes) = panes else { return };

    // Resolve each pane's scoped identity once.
    let mut resolved_panes: Vec<(String, Option<SessionNameRef>)> = Vec::new();
    for pane in &panes {
        let pane_id = pane.get("paneId").and_then(Value::as_str).unwrap_or("");
        let payload = pane
            .get("payload")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let kind = pane.get("kind").and_then(Value::as_str).unwrap_or("");
        let mode = payload.get("mode").and_then(Value::as_str);
        let session_type = payload.get("sessionType").and_then(Value::as_str);
        let scoped = freshell_freshagent::naming::is_unified_agent_mode(mode, session_type)
            && (kind == "terminal" || kind == "fresh-agent");
        let identity = if !scoped {
            None
        } else {
            resolve_snapshot_pane_identity(kind, &payload, terminal_index)
        };
        resolved_panes.push((pane_id.to_string(), identity));
    }

    // One source-tab label maps only to its resolved naming-source session —
    // the record's persisted `nameSource` pane when present, else the
    // deterministic original candidate (the FIRST pane, when scoped).
    let source_pane = record
        .get("nameSource")
        .filter(|ns| ns.get("kind").and_then(Value::as_str) == Some("session"))
        .and_then(|ns| ns.get("paneId").and_then(Value::as_str))
        .and_then(|pane_id| resolved_panes.iter().find(|(id, _)| id == pane_id).cloned())
        .or_else(|| {
            // The deterministic original candidate (plan "Stable tab
            // ownership"): only the FIRST pane decides — a scoped first
            // leaf owns the tab; a non-agent first leaf keeps the tab's
            // legacy naming and its label is never applied to a later
            // agent someone split in.
            resolved_panes
                .first()
                .filter(|(_, identity)| identity.is_some())
                .cloned()
        });
    if let (Some(tab_name), Some((pane_id, Some(identity)))) = (tab_name, source_pane) {
        let (source, protection) = if tab_flagged {
            (
                NameSource::LegacyProtected,
                LegacyProtectionEvidence::LegacyFlag,
            )
        } else {
            (NameSource::ProviderAi, LegacyProtectionEvidence::None)
        };
        evidence.candidates.push(LegacyNameCandidate {
            id: legacy_name_candidate_id(LegacyCandidateIdInput {
                storage_key: &format!("tabs-registry:{device}"),
                device_id: Some(device),
                tab_id,
                pane_id: Some(&pane_id),
                scope: LegacyCandidateScope::SourceTab,
                provider: provider_of_ref(&identity).map(|named| named.as_str()),
                session_id: session_id_of_ref(&identity),
                name: tab_name,
                source,
                protection_evidence: protection,
                explicit_rename_at: None,
            }),
            target: LegacyNameTarget::Canonical(identity),
            name: tab_name.to_string(),
            source,
            scope: LegacyCandidateScope::SourceTab,
            explicit_rename_at: None,
            evidence_key: format!("tabs-registry:{device}:{tab_key}:source-tab"),
            protection_evidence: protection,
        });
    } else if let Some(tab_name) = tab_name {
        // An unbound or legacy-named tab label: recovery-only, never applied
        // to a session it cannot be proven to name.
        evidence.ambiguous_index.push(format!(
            "tab {tab_key} label {tab_name:?} has no unambiguous scoped naming source"
        ));
    }

    // Per-pane labels — a snapshot pane title is a display projection of the
    // provider/AI title; with no per-pane user flag in the registry record
    // its provenance stays automatic.
    for (pane, (pane_id, identity)) in panes.iter().zip(&resolved_panes) {
        let Some(title) = pane
            .get("title")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
        else {
            continue;
        };
        let Some(identity) = identity else {
            evidence.ambiguous_index.push(format!(
                "pane {tab_key}/{pane_id} title {title:?} has no resolvable scoped identity"
            ));
            continue;
        };
        evidence.candidates.push(LegacyNameCandidate {
            id: legacy_name_candidate_id(LegacyCandidateIdInput {
                storage_key: &format!("tabs-registry:{device}"),
                device_id: Some(device),
                tab_id,
                pane_id: Some(pane_id),
                scope: LegacyCandidateScope::Pane,
                provider: provider_of_ref(identity).map(|named| named.as_str()),
                session_id: session_id_of_ref(identity),
                name: title,
                source: NameSource::ProviderAi,
                protection_evidence: LegacyProtectionEvidence::None,
                explicit_rename_at: None,
            }),
            target: LegacyNameTarget::Canonical(identity.clone()),
            name: title.to_string(),
            source: NameSource::ProviderAi,
            scope: LegacyCandidateScope::Pane,
            explicit_rename_at: None,
            evidence_key: format!("tabs-registry:{device}:{tab_key}:{pane_id}"),
            protection_evidence: LegacyProtectionEvidence::None,
        });
    }
}

/// Resolve one snapshot pane payload's scoped naming identity: the durable
/// `sessionRef`, else the persisted `nameRef`, else the pending
/// `namingHandle`. Also indexes the pane's `terminalId` for terminal-
/// override resolution (the retained native evidence).
fn resolve_snapshot_pane_identity(
    kind: &str,
    payload: &Map<String, Value>,
    terminal_index: &mut HashMap<String, SessionNameRef>,
) -> Option<SessionNameRef> {
    let identity = (|| {
        if let Some(session_ref) = payload.get("sessionRef").and_then(Value::as_object) {
            let provider = session_ref.get("provider").and_then(Value::as_str)?;
            let session_id = session_ref.get("sessionId").and_then(Value::as_str)?;
            let named = freshell_freshagent::naming::named_provider_for(Some(provider), None)?;
            return Some(SessionNameRef::Session {
                provider: named,
                session_id: session_id.to_string(),
            });
        }
        let name_ref = payload
            .get("nameRef")
            .and_then(|raw| serde_json::from_value::<SessionNameRef>(raw.clone()).ok());
        if let Some(name_ref) = name_ref {
            return Some(name_ref);
        }
        let handle = payload
            .get("namingHandle")
            .and_then(Value::as_str)
            .filter(|h| !h.is_empty())?;
        Some(SessionNameRef::Pending {
            id: handle.to_string(),
        })
    })();
    if kind == "terminal" {
        if let (Some(identity), Some(terminal_id)) = (
            identity.clone(),
            payload.get("terminalId").and_then(Value::as_str),
        ) {
            terminal_index.insert(terminal_id.to_string(), identity);
        }
    }
    identity
}

/// `config.terminalOverrides` — a per-terminal title override is an old
/// protected flag with lossy provenance. Resolution goes through the
/// identity ledger first (live and retired entries — their `nameRef` is
/// the canonical naming identity), then the retained snapshot pane
/// evidence. Unresolvable overrides stay recovery-only and untouched.
fn gather_terminal_overrides(
    settings: &SettingsStore,
    identity: &TerminalIdentityRegistry,
    snapshot_pane_terminals: &HashMap<String, SessionNameRef>,
    evidence: &mut LegacyEvidence,
) {
    let overrides = settings.terminal_overrides();
    evidence.raw_sources.insert(
        "config.terminalOverrides".to_string(),
        Value::Object(overrides.clone()),
    );
    for (terminal_id, row) in &overrides {
        let Some(title) = row
            .get("titleOverride")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
        else {
            continue;
        };
        let resolved = resolve_terminal_identity(identity, terminal_id)
            .or_else(|| snapshot_pane_terminals.get(terminal_id).cloned());
        let Some(resolved) = resolved else {
            evidence.unresolved_terminal_ids.push(terminal_id.clone());
            evidence.ambiguous_index.push(format!(
                "terminal override for {terminal_id} ({title:?}) has no resolvable scoped identity"
            ));
            continue;
        };
        evidence.resolved_terminal_ids.push(terminal_id.clone());
        evidence.candidates.push(LegacyNameCandidate {
            id: legacy_name_candidate_id(LegacyCandidateIdInput {
                storage_key: "config.terminalOverrides",
                device_id: None,
                tab_id: None,
                pane_id: None,
                scope: LegacyCandidateScope::Terminal,
                provider: provider_of_ref(&resolved).map(|named| named.as_str()),
                session_id: session_id_of_ref(&resolved),
                name: title,
                source: NameSource::LegacyProtected,
                protection_evidence: LegacyProtectionEvidence::LegacyFlag,
                explicit_rename_at: None,
            }),
            target: LegacyNameTarget::Canonical(resolved),
            name: title.to_string(),
            source: NameSource::LegacyProtected,
            scope: LegacyCandidateScope::Terminal,
            explicit_rename_at: None,
            evidence_key: format!("terminal-override:{terminal_id}"),
            protection_evidence: LegacyProtectionEvidence::LegacyFlag,
        });
    }
}

/// Resolve a terminal id through the identity ledger: the entry's canonical
/// `nameRef` first, else its provider/session association when scoped.
pub(crate) fn resolve_terminal_identity(
    identity: &TerminalIdentityRegistry,
    terminal_id: &str,
) -> Option<SessionNameRef> {
    let entry = identity.get(terminal_id)?;
    if let Some(name_ref) = entry.name_ref {
        return Some(name_ref);
    }
    let provider = entry.provider.as_deref()?;
    let session_id = entry.session_id.as_deref()?;
    let named = freshell_freshagent::naming::named_provider_for(Some(provider), None)?;
    Some(SessionNameRef::Session {
        provider: named,
        session_id: session_id.to_string(),
    })
}

/// `session-metadata.json` `derivedTitle` fields: the indexer's parsed
/// provider-title fallback ("genuinely active" = non-empty), at derived
/// scope and provider-AI rank — never rename recency, never protection.
/// Delta-review round 4, finding 1: a KILROY-MODE entry stays in the legacy
/// lane — never a candidate, never a `clear_derived_title` cleanup target.
fn gather_metadata_derived_titles(
    entries: &HashMap<String, Value>,
    kilroy_only: &HashSet<String>,
    evidence: &mut LegacyEvidence,
) {
    let mut raw = Map::new();
    for (key, entry) in entries {
        raw.insert(key.clone(), entry.clone());
        let Some((provider, session_id)) = key.split_once(':') else {
            continue;
        };
        if freshell_freshagent::naming::named_provider_for(Some(provider), None).is_none() {
            continue;
        }
        if kilroy_only.contains(key) {
            continue;
        }
        let Some(title) = entry
            .get("derivedTitle")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
        else {
            continue;
        };
        evidence
            .metadata_rows_with_derived_title
            .push((provider.to_string(), session_id.to_string()));
        evidence.candidates.push(LegacyNameCandidate {
            id: legacy_name_candidate_id(LegacyCandidateIdInput {
                storage_key: "session-metadata.json",
                device_id: None,
                tab_id: None,
                pane_id: None,
                scope: LegacyCandidateScope::Derived,
                provider: Some(provider),
                session_id: Some(session_id),
                name: title,
                source: NameSource::ProviderAi,
                protection_evidence: LegacyProtectionEvidence::None,
                explicit_rename_at: None,
            }),
            target: LegacyNameTarget::Canonical(SessionNameRef::Session {
                provider: freshell_freshagent::naming::named_provider_for(Some(provider), None)
                    .expect("scoped above"),
                session_id: session_id.to_string(),
            }),
            name: title.to_string(),
            source: NameSource::ProviderAi,
            scope: LegacyCandidateScope::Derived,
            explicit_rename_at: None,
            evidence_key: format!("session-metadata:{key}"),
            protection_evidence: LegacyProtectionEvidence::None,
        });
    }
    evidence
        .raw_sources
        .insert("session-metadata.json".to_string(), Value::Object(raw));
}

/// The evidence envelopes riding the boot import — the raw bytes of each
/// server source, one envelope per source.
fn boot_evidence_envelopes(evidence: &LegacyEvidence) -> Vec<LegacyEvidenceEnvelope> {
    evidence
        .raw_sources
        .iter()
        .map(|(storage_key, value)| LegacyEvidenceEnvelope {
            storage_key: storage_key.clone(),
            raw: serde_json::to_string(value).unwrap_or_else(|_| value.to_string()),
        })
        .collect()
}

/// The immutable server backup — durable create-once. A present file is
/// never rewritten; corrupt/missing sources are retained verbatim in
/// `raw_sources` (the gatherer never repairs them).
fn write_server_backup_once(data_dir: &Path, evidence: &LegacyEvidence) -> Result<(), String> {
    let dir = data_dir.join(NAME_MIGRATION_DIR_NAME);
    let path = dir.join(SERVER_BACKUP_FILE_NAME);
    if path.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let body = json!({
        "version": 1,
        "migration": "unified-agent-names-v1",
        "sources": evidence.raw_sources,
        "unresolvedTerminals": evidence.unresolved_terminal_ids,
        "ambiguousCandidates": evidence.ambiguous_index,
        // Recovery policy: never copy this backup over the live name
        // document or reactivate an alias — recover through a deliberate
        // canonical user rename via the normal API.
        "recovery": "submit a deliberate canonical user rename through the normal API; \
                     never restore a backup over the live document",
    });
    let bytes = serde_json::to_vec_pretty(&body)
        .map_err(|e| format!("cannot serialize the server backup: {e}"))?;
    let tmp = dir.join(format!(".{SERVER_BACKUP_FILE_NAME}.tmp"));
    atomic_write_durable(&path, &tmp, &bytes)
        .map_err(|e| format!("server backup write failed: {e}"))
}

/// Scope-only cleanup: remove the migrated title fields after the receipt
/// committed — `titleOverride`/`titleSource` from scoped session-override
/// rows, `titleOverride` from resolved terminal overrides, `derivedTitle`
/// from active metadata entries. Never a whole row: summary, archive,
/// delete and description data on the same rows always survive, and rows
/// outside the three scoped providers are never touched. Idempotent.
async fn cleanup_legacy_title_fields(
    settings: &SettingsStore,
    metadata: &SessionMetadataStore,
    evidence: &LegacyEvidence,
) {
    for key in &evidence.session_rows_with_title {
        settings
            .patch_session_override(key, &[("titleOverride", None), ("titleSource", None)])
            .await;
    }
    for terminal_id in &evidence.resolved_terminal_ids {
        settings
            .patch_terminal_override(terminal_id, &[("titleOverride", None)])
            .await;
    }
    for (provider, session_id) in &evidence.metadata_rows_with_derived_title {
        if let Err(error) = metadata.clear_derived_title(provider, session_id).await {
            tracing::warn!(
                target: "freshell_server::session_names",
                op = "legacy_name_cleanup",
                name_ref = format!("{provider}:{session_id}"),
                revision = 0,
                class = "io",
                "session_names.operation_failed: derivedTitle cleanup failed \
                 (retried idempotently next boot): {error}"
            );
        }
    }
    if !evidence.session_rows_with_title.is_empty() || !evidence.resolved_terminal_ids.is_empty() {
        if let Err(error) = settings.flush_to_disk().await {
            tracing::warn!(
                target: "freshell_server::session_names",
                op = "legacy_name_cleanup",
                name_ref = "-",
                revision = 0,
                class = "persistence",
                "session_names.operation_failed: legacy title-field cleanup did not flush \
                 (in-memory readers already stopped consulting them; retried next boot): {error}"
            );
        }
    }
    if !evidence.session_rows_with_title.is_empty()
        || !evidence.resolved_terminal_ids.is_empty()
        || !evidence.metadata_rows_with_derived_title.is_empty()
    {
        tracing::info!(
            target: "freshell_server::session_names",
            op = "legacy_name_cleanup",
            name_ref = "-",
            revision = 0,
            session_rows = evidence.session_rows_with_title.len(),
            terminal_rows = evidence.resolved_terminal_ids.len(),
            metadata_rows = evidence.metadata_rows_with_derived_title.len(),
            "legacy title-field cleanup pass complete"
        );
    }
}

/// A session ref's provider for the candidate-id tuple — `None` for a
/// pending ref (the tuple's absent entries are null).
fn provider_of_ref(reference: &SessionNameRef) -> Option<NamedProvider> {
    match reference {
        SessionNameRef::Session { provider, .. } => Some(*provider),
        SessionNameRef::Pending { .. } => None,
    }
}

/// A session ref's session id for the candidate-id tuple — `None` for a
/// pending ref (the handle lives in the candidate target, never the
/// tuple's provider/sessionId slots).
fn session_id_of_ref(reference: &SessionNameRef) -> Option<&str> {
    match reference {
        SessionNameRef::Session { session_id, .. } => Some(session_id.as_str()),
        SessionNameRef::Pending { .. } => None,
    }
}

#[cfg(test)]
#[path = "session_name_migration_tests.rs"]
mod tests;
