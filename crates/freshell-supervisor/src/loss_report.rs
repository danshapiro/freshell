//! Certified managed-soul loss decisions and durable incident export.
//!
//! A loss decision is deliberately harder to construct than an ordinary
//! recovery result. The constructor consumes the provider capability
//! manifest's complete path inventory and refuses every unknown, unreadable,
//! ambiguous, viable, or unimplemented path. The resulting certificate
//! contains only hashes/references for provider-native identity and can be
//! committed before exact cleanup begins.

use crate::{
    notice_outbox::{enqueue_notice_in_tx, increment_counter_in_tx, millis_to_timestamp},
    registry::{load_owned_handle, OwnedRuntimeHandle, RecoveryContext, Registry, RegistryError},
    view_intents::{enqueue_projection, load_view_intent},
};
use freshell_agent_runtime::{managed_recovery_enabled, recovery_paths};
use freshell_runtime_observability::{
    atomic_write_redacted_json, now_rfc3339_millis, RotatingJsonlWriter,
};
use freshell_runtime_protocol::{
    CleanupDecisionEvidence, CorrelationId, DesiredState, EvidenceStoreState, IncidentAnalysis,
    IncidentId, IncidentTimelineEvent, InstallationId, LossBuildEvidence, LossCleanupReport,
    LossDecisionState, LossDecisionSummary, LostDecisionCertificate, NoticeKind,
    RecoveryEvidenceVerdict, RecoveryPath, RecoveryPathEvidence, RecoveryState, RuntimeNotice,
    StopOutcome, LOSS_REPORT_SCHEMA_VERSION,
};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    time::{Duration, SystemTime},
};

pub const INCIDENT_RETENTION_DAYS: u64 = 90;
pub const INCIDENT_RETENTION_COUNT: usize = 1_000;
pub const INCIDENT_RETENTION_BYTES: u64 = 100 * 1024 * 1024;
pub const INCIDENT_LOG_MAX_BYTES: u64 = 10 * 1024 * 1024;
pub const INCIDENT_LOG_BACKUPS: u32 = 4;

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum LossDecisionError {
    #[error("loss certification requires the durable desired state to remain RUNNING")]
    StopIntent,
    #[error("loss certification cannot run for an already terminal soul")]
    AlreadyTerminal,
    #[error("pristine-seed recovery is still available because no input was dispatched")]
    PristineSeedAvailable,
    #[error("a verified native resume specification is still available")]
    NativeResumeAvailable,
    #[error("a checkpoint revision is retained and its restoration state is unresolved")]
    CheckpointAvailableOrUnknown,
    #[error("provider {0} has no managed recovery capability inventory")]
    MissingCapability(String),
    #[error("provider {0} is not enabled for managed runtime ownership")]
    DisabledProvider(String),
    #[error("applicable recovery path inventory does not match the provider manifest")]
    IncompletePathInventory,
    #[error("recovery path {0} did not produce exactly one definitive-negative record")]
    MissingPathEvidence(&'static str),
    #[error("recovery path {0} retained unknown or unreadable evidence")]
    UnknownPathEvidence(&'static str),
    #[error("recovery path {0} has no durable evidence reference")]
    MissingEvidenceReference(&'static str),
    #[error("cleanup authority is not the exact registry-owned prior incarnation")]
    UnsafeCleanupAuthority,
    #[error("incident analysis field {0} is empty")]
    MissingAnalysis(&'static str),
}

#[derive(Debug, Clone)]
pub struct LossDecisionInput<'a> {
    pub installation_id: &'a InstallationId,
    pub context: &'a RecoveryContext,
    pub cleanup_handle: &'a OwnedRuntimeHandle,
    pub path_evidence: Vec<RecoveryPathEvidence>,
    pub builds: LossBuildEvidence,
    pub timeline: Vec<IncidentTimelineEvent>,
    pub analysis: IncidentAnalysis,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LostDecision {
    certificate: LostDecisionCertificate,
}

impl LostDecision {
    pub fn try_new(input: LossDecisionInput<'_>) -> Result<Self, LossDecisionError> {
        let context = input.context;
        if context.desired_state != DesiredState::Running {
            return Err(LossDecisionError::StopIntent);
        }
        if matches!(
            context.recovery_state,
            RecoveryState::Lost | RecoveryState::Stopped
        ) {
            return Err(LossDecisionError::AlreadyTerminal);
        }
        if context.never_dispatched {
            return Err(LossDecisionError::PristineSeedAvailable);
        }
        // A persisted resume specification is an identity/argv contract, not
        // proof that its referenced provider state still exists. The typed
        // NativeResume path evidence below decides viability; a present spec
        // cannot override a fresh, definitive missing-store probe.
        // A recorded checkpoint revision is only a locator. The complete,
        // freshly evaluated CheckpointRestore path evidence below determines
        // whether the referenced checkpoint is still present and verified.
        if input.cleanup_handle.soul_id() != &context.soul_id
            || input.cleanup_handle.incarnation_id() != context.prior_handle.incarnation_id()
            || input.cleanup_handle.installation_id() != input.installation_id
        {
            return Err(LossDecisionError::UnsafeCleanupAuthority);
        }

        let applicable_paths = recovery_paths(&context.provider)
            .ok_or_else(|| LossDecisionError::MissingCapability(context.provider.clone()))?;
        if !managed_recovery_enabled(&context.provider) {
            return Err(LossDecisionError::DisabledProvider(
                context.provider.clone(),
            ));
        }
        validate_path_inventory(applicable_paths, &input.path_evidence)?;
        validate_analysis(&input.analysis)?;

        let state = if context.provider == "shell" {
            LossDecisionState::NonResumableTerminalEnded
        } else {
            LossDecisionState::Lost
        };
        let reason_code = match state {
            LossDecisionState::Lost => "all_applicable_recovery_paths_definitively_unavailable",
            LossDecisionState::NonResumableTerminalEnded => {
                "non_resumable_terminal_ended_after_dispatch"
            }
        };
        let incident_id = IncidentId::new();
        let correlation_id = CorrelationId::new();
        let created_at = input.created_at.unwrap_or_else(now_rfc3339_millis);
        let native_session_ref_hash = hash_native_session_reference(
            &context.provider,
            &context.provider_store_id,
            context.native_session_id.as_deref(),
        );
        let certificate = LostDecisionCertificate {
            schema_version: LOSS_REPORT_SCHEMA_VERSION,
            event: "soul.loss.finalized".into(),
            incident_id,
            correlation_id,
            installation_id: input.installation_id.clone(),
            soul_id: context.soul_id.clone(),
            provider: context.provider.clone(),
            provider_store_id: context.provider_store_id.clone(),
            native_session_ref_hash,
            intent_revision: context.intent_revision,
            incarnations: vec![context.prior_handle.incarnation_id().clone()],
            builds: input.builds,
            timeline: input.timeline,
            recovery_paths: input.path_evidence,
            decision: LossDecisionSummary {
                state,
                reason_code: reason_code.into(),
                unknown_paths: 0,
                retained_recoverable_evidence: false,
            },
            cleanup_target: CleanupDecisionEvidence {
                owned_handle_ref: format!(
                    "registry://installation/{}/soul/{}/incarnation/{}",
                    input.installation_id,
                    context.soul_id,
                    context.prior_handle.incarnation_id()
                ),
                ownership_verified: true,
                incarnation_id: context.prior_handle.incarnation_id().clone(),
            },
            analysis: input.analysis,
            created_at,
        };
        Ok(Self { certificate })
    }

    pub fn certificate(&self) -> &LostDecisionCertificate {
        &self.certificate
    }

    pub fn into_certificate(self) -> LostDecisionCertificate {
        self.certificate
    }
}

fn validate_path_inventory(
    applicable_paths: &[RecoveryPath],
    evidence: &[RecoveryPathEvidence],
) -> Result<(), LossDecisionError> {
    let applicable = path_multiset(applicable_paths.iter().copied());
    let observed = path_multiset(evidence.iter().map(|row| row.path));
    if applicable != observed {
        return Err(LossDecisionError::IncompletePathInventory);
    }
    for path in applicable_paths {
        let rows: Vec<_> = evidence.iter().filter(|row| row.path == *path).collect();
        if rows.len() != 1 || rows[0].verdict != RecoveryEvidenceVerdict::DefinitiveNegative {
            return Err(LossDecisionError::MissingPathEvidence(path_name(*path)));
        }
        let row = rows[0];
        if matches!(
            row.store_state,
            EvidenceStoreState::Unknown | EvidenceStoreState::PresentUnreadable
        ) {
            return Err(LossDecisionError::UnknownPathEvidence(path_name(*path)));
        }
        if row.evidence_refs.is_empty()
            || row.evidence_refs.iter().any(|item| item.trim().is_empty())
        {
            return Err(LossDecisionError::MissingEvidenceReference(path_name(
                *path,
            )));
        }
    }
    Ok(())
}

fn validate_analysis(analysis: &IncidentAnalysis) -> Result<(), LossDecisionError> {
    for (name, value) in [
        ("observed_cause", analysis.observed_cause.as_str()),
        ("missing_invariant", analysis.missing_invariant.as_str()),
        ("preventive_action", analysis.preventive_action.as_str()),
        ("regression_case", analysis.regression_case.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(LossDecisionError::MissingAnalysis(name));
        }
    }
    Ok(())
}

fn path_multiset(paths: impl Iterator<Item = RecoveryPath>) -> BTreeMap<&'static str, usize> {
    let mut counts = BTreeMap::new();
    for path in paths {
        *counts.entry(path_name(path)).or_insert(0) += 1;
    }
    counts
}

pub fn path_name(path: RecoveryPath) -> &'static str {
    match path {
        RecoveryPath::Reattach => "reattach",
        RecoveryPath::NativeResume => "native_resume",
        RecoveryPath::CheckpointRestore => "checkpoint_restore",
        RecoveryPath::PristineSeed => "pristine_seed",
        RecoveryPath::NativeImport => "native_import",
    }
}

pub fn hash_native_session_reference(
    provider: &str,
    provider_store_id: &str,
    native_session_id: Option<&str>,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"freshell-loss-native-session-v1\0");
    hasher.update(provider.as_bytes());
    hasher.update(b"\0");
    hasher.update(provider_store_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(native_session_id.unwrap_or("<none>").as_bytes());
    format!("sha256:{:x}", hasher.finalize())
}

pub fn hash_loss_certificate(certificate: &LostDecisionCertificate) -> String {
    let encoded = serde_json::to_vec(certificate).expect("loss certificate is serializable");
    format!("{:x}", Sha256::digest(encoded))
}

#[derive(Clone)]
pub struct IncidentExporter {
    root: PathBuf,
    process_secret: String,
}

impl IncidentExporter {
    pub fn new(root: impl Into<PathBuf>, process_secret: impl Into<String>) -> Self {
        Self {
            root: root.into(),
            process_secret: process_secret.into(),
        }
    }

    pub fn export_certificate(
        &self,
        certificate: &LostDecisionCertificate,
    ) -> std::io::Result<PathBuf> {
        fs::create_dir_all(&self.root)?;
        fs::set_permissions(&self.root, std::fs::Permissions::from_mode(0o700))?;
        let path = self
            .root
            .join(format!("{}.open.json", certificate.incident_id));
        atomic_write_redacted_json(&path, certificate, &self.process_secret)?;
        let writer = RotatingJsonlWriter::create(
            self.root.join("incidents.jsonl"),
            INCIDENT_LOG_MAX_BYTES,
            INCIDENT_LOG_BACKUPS,
            self.process_secret.clone(),
        )?;
        writer.write_json(certificate)?;
        writer.sync_all()?;
        Ok(path)
    }

    pub fn export_summary<T: serde::Serialize>(
        &self,
        incident_id: &IncidentId,
        closed: bool,
        value: &T,
    ) -> std::io::Result<PathBuf> {
        fs::create_dir_all(&self.root)?;
        let suffix = if closed { "closed" } else { "open" };
        let target = self.root.join(format!("{incident_id}.{suffix}.json"));
        atomic_write_redacted_json(&target, value, &self.process_secret)?;
        if closed {
            let open = self.root.join(format!("{incident_id}.open.json"));
            match fs::remove_file(open) {
                Ok(()) => std::fs::File::open(&self.root)?.sync_all()?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        self.enforce_retention()?;
        Ok(target)
    }

    /// Enforce the closed-incident age/count/byte bounds. Open incidents have
    /// an `.open.json` suffix and are deliberately never considered here.
    pub fn enforce_retention(&self) -> std::io::Result<Vec<PathBuf>> {
        fs::create_dir_all(&self.root)?;
        let mut closed = fs::read_dir(&self.root)?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !name.ends_with(".closed.json") {
                    return None;
                }
                let metadata = entry.metadata().ok()?;
                let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                Some((entry.path(), modified, metadata.len()))
            })
            .collect::<Vec<_>>();
        closed.sort_by_key(|(_, modified, _)| *modified);
        let cutoff = SystemTime::now()
            .checked_sub(Duration::from_secs(INCIDENT_RETENTION_DAYS * 24 * 60 * 60))
            .unwrap_or(SystemTime::UNIX_EPOCH);
        let mut total_bytes = closed.iter().map(|(_, _, bytes)| *bytes).sum::<u64>();
        let mut remaining = closed.len();
        let mut removed = Vec::new();
        for (path, modified, bytes) in closed {
            let over_age = modified < cutoff;
            let over_count = remaining > INCIDENT_RETENTION_COUNT;
            let over_bytes = total_bytes > INCIDENT_RETENTION_BYTES;
            if !(over_age || over_count || over_bytes) {
                continue;
            }
            fs::remove_file(&path)?;
            remaining = remaining.saturating_sub(1);
            total_bytes = total_bytes.saturating_sub(bytes);
            removed.push(path);
        }
        Ok(removed)
    }
}

use std::os::unix::fs::PermissionsExt;

#[derive(Debug, Clone)]
pub struct PreparedLoss {
    pub certificate: LostDecisionCertificate,
    pub handle: OwnedRuntimeHandle,
    pub committed_intent_revision: u64,
}

#[derive(Debug, Clone)]
pub struct PendingIncidentExport {
    pub event_id: String,
    pub event_kind: String,
    pub incident_id: IncidentId,
    pub payload: serde_json::Value,
}

impl Registry {
    /// Commit the loss certificate, stop/loss intent, exact cleanup target, and
    /// export outbox event in one FULL-synchronous transaction. No signal is
    /// sent before this method returns successfully.
    pub async fn prepare_loss(
        &self,
        decision: LostDecision,
    ) -> Result<PreparedLoss, RegistryError> {
        let installation = self.installation_id().clone();
        let certificate = decision.into_certificate();
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if let Some((existing_json, incarnation_raw, committed_revision, desired, recovery, current_incident)) = tx
                .query_row(
                    "SELECT certificate_json,incarnation_id, \
                     (SELECT intent_revision FROM souls WHERE soul_id=loss_incidents.soul_id), \
                     (SELECT desired_state FROM souls WHERE soul_id=loss_incidents.soul_id), \
                     (SELECT recovery_state FROM souls WHERE soul_id=loss_incidents.soul_id), \
                     (SELECT loss_incident_id FROM souls WHERE soul_id=loss_incidents.soul_id) \
                     FROM loss_incidents WHERE soul_id=?1 AND intent_revision=?2",
                    params![certificate.soul_id.as_str(), certificate.intent_revision],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, u64>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, Option<String>>(5)?,
                        ))
                    },
                )
                .optional()?
            {
                let existing: LostDecisionCertificate = serde_json::from_str(&existing_json)?;
                if existing != certificate {
                    return Err(RegistryError::RequestConflict);
                }
                let expected_committed_revision = certificate
                    .intent_revision
                    .checked_add(1)
                    .ok_or_else(|| RegistryError::Integrity("intent revision overflow".into()))?;
                if committed_revision != expected_committed_revision
                    || desired != "stopped"
                    || recovery != "lost"
                    || current_incident.as_deref() != Some(certificate.incident_id.as_str())
                {
                    return Err(RegistryError::StaleIntentRevision {
                        expected: expected_committed_revision,
                        current: committed_revision,
                    });
                }
                let incarnation_id = freshell_runtime_protocol::IncarnationId::parse(incarnation_raw)
                    .map_err(|_| RegistryError::Integrity("invalid loss incarnation id".into()))?;
                let handle = load_owned_handle(&tx, installation, &incarnation_id)?;
                tx.commit()?;
                return Ok(PreparedLoss {
                    certificate: existing,
                    handle,
                    committed_intent_revision: committed_revision,
                });
            }

            let (desired_state, current_revision, recovery_state): (String, u64, String) = tx
                .query_row(
                    "SELECT desired_state,intent_revision,recovery_state FROM souls WHERE soul_id=?1",
                    params![certificate.soul_id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?
                .ok_or_else(|| RegistryError::UnknownSoul(certificate.soul_id.clone()))?;
            if desired_state != "running"
                || current_revision != certificate.intent_revision
                || matches!(recovery_state.as_str(), "lost" | "stopped")
            {
                return Err(RegistryError::StaleIntentRevision {
                    expected: certificate.intent_revision,
                    current: current_revision,
                });
            }
            let incarnation_id = certificate.cleanup_target.incarnation_id.clone();
            let active: Option<String> = tx
                .query_row(
                    "SELECT incarnation_id FROM incarnations WHERE soul_id=?1 \
                     AND launch_state IN ('created','starting','running','stopping') \
                     ORDER BY created_at DESC LIMIT 1",
                    params![certificate.soul_id.as_str()],
                    |row| row.get(0),
                )
                .optional()?;
            if active.as_deref() != Some(incarnation_id.as_str()) {
                return Err(RegistryError::InvalidState(
                    "loss cleanup target is not the current active incarnation".into(),
                ));
            }
            let handle = load_owned_handle(&tx, installation, &incarnation_id)?;
            if !certificate.cleanup_target.ownership_verified
                || handle.soul_id() != &certificate.soul_id
            {
                return Err(RegistryError::InvalidState(
                    "loss certificate lacks exact owned cleanup authority".into(),
                ));
            }
            let next_revision = current_revision
                .checked_add(1)
                .ok_or_else(|| RegistryError::Integrity("intent revision overflow".into()))?;
            let now = crate::registry::now_millis();
            let initial_cleanup = LossCleanupReport {
                owned_handle_ref: certificate.cleanup_target.owned_handle_ref.clone(),
                ownership_verified: true,
                graceful_attempt: "not_started".into(),
                forced_attempt: "not_started".into(),
                verified_empty: false,
                verified_at: None,
                foreign_objects_touched: 0,
            };
            let certificate_json = serde_json::to_string(&certificate)?;
            tx.execute(
                "INSERT INTO loss_incidents \
                 (incident_id,correlation_id,soul_id,incarnation_id,provider,provider_store_id, \
                  native_session_ref_hash,intent_revision,decision_state,reason_code,certificate_json, \
                  cleanup_state,cleanup_json,observed_cause,missing_invariant,hypotheses_json, \
                  preventive_action,regression_case,created_at,updated_at,closed_at) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'cleanup_pending',?12,?13,?14,?15,?16,?17,?18,?18,NULL)",
                params![
                    certificate.incident_id.as_str(),
                    certificate.correlation_id.as_str(),
                    certificate.soul_id.as_str(),
                    incarnation_id.as_str(),
                    certificate.provider,
                    certificate.provider_store_id,
                    certificate.native_session_ref_hash,
                    certificate.intent_revision,
                    loss_decision_state_name(certificate.decision.state),
                    certificate.decision.reason_code,
                    certificate_json,
                    serde_json::to_string(&initial_cleanup)?,
                    certificate.analysis.observed_cause,
                    certificate.analysis.missing_invariant,
                    serde_json::to_string(&certificate.analysis.hypotheses)?,
                    certificate.analysis.preventive_action,
                    certificate.analysis.regression_case,
                    now,
                ],
            )?;
            tx.execute(
                "UPDATE souls SET desired_state='stopped',intent_revision=?1,recovery_state='lost', \
                 recovery_reason=?2,recovery_attempt_id=NULL,loss_incident_id=?3,updated_at=?4 \
                 WHERE soul_id=?5 AND intent_revision=?6 AND desired_state='running'",
                params![
                    next_revision,
                    format!("LOSS_CERTIFIED:{}", certificate.incident_id),
                    certificate.incident_id.as_str(),
                    now,
                    certificate.soul_id.as_str(),
                    current_revision,
                ],
            )?;
            tx.execute(
                "UPDATE incarnations SET launch_state='stopping',cleanup_state='requested',updated_at=?1 \
                 WHERE incarnation_id=?2",
                params![now, incarnation_id.as_str()],
            )?;
            tx.execute(
                "INSERT INTO stop_tombstones (soul_id,intent_revision,actor,reason,committed_at) \
                 VALUES (?1,?2,'loss-certificate',?3,?4)",
                params![
                    certificate.soul_id.as_str(),
                    next_revision,
                    format!("certified loss {}", certificate.incident_id),
                    now
                ],
            )?;

            // Every visible view remains as compact ended history. Advance the
            // soul fence and projection revision, but do not delete/detach it.
            let view_ids = {
                let mut statement = tx.prepare(
                    "SELECT view_id FROM view_intents WHERE soul_id=?1 ORDER BY view_id",
                )?;
                let rows = statement.query_map(params![certificate.soul_id.as_str()], |row| {
                    row.get::<_, String>(0)
                })?;
                rows.collect::<Result<Vec<_>, _>>()?
            };
            for raw in view_ids {
                let view_id = freshell_runtime_protocol::ViewIntentId::parse(raw)
                    .map_err(|_| RegistryError::Integrity("invalid view id".into()))?;
                let current = load_view_intent(&tx, &view_id)?
                    .ok_or_else(|| RegistryError::Integrity("view disappeared".into()))?;
                let view_revision = current
                    .revision
                    .checked_add(1)
                    .ok_or_else(|| RegistryError::Integrity("view revision overflow".into()))?;
                tx.execute(
                    "UPDATE view_intents SET revision=?1,soul_intent_revision=?2,updated_at=?3 \
                     WHERE view_id=?4 AND revision=?5",
                    params![
                        view_revision,
                        next_revision,
                        now,
                        view_id.as_str(),
                        current.revision
                    ],
                )?;
                let updated = load_view_intent(&tx, &view_id)?
                    .ok_or_else(|| RegistryError::Integrity("updated view disappeared".into()))?;
                enqueue_projection(&tx, &updated)?;
            }

            let export_event_id = format!("projection-loss-open-{}", certificate.incident_id);
            tx.execute(
                "INSERT INTO outbox (event_id,event_kind,payload,created_at,delivered_at) \
                 VALUES (?1,'loss_incident.open',?2,?3,NULL)",
                params![export_event_id, serde_json::to_string(&certificate)?, now],
            )?;
            crate::registry::failpoint("loss_before_incident_commit")?;
            increment_counter_in_tx(
                &tx,
                "recovery_outcome",
                match certificate.decision.state {
                    LossDecisionState::Lost => "lost",
                    LossDecisionState::NonResumableTerminalEnded => "terminal_ended",
                },
                1,
                now,
            )?;
            tx.commit()?;
            Ok(PreparedLoss {
                certificate,
                handle,
                committed_intent_revision: next_revision,
            })
        })
        .await
    }

    pub async fn finalize_loss_cleanup(
        &self,
        incident_id: IncidentId,
        outcome: StopOutcome,
        cleanup: LossCleanupReport,
    ) -> Result<RuntimeNotice, RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let (soul_id, incarnation_id, current_state, certificate_json, persisted_cleanup_json): (
                String,
                String,
                String,
                String,
                String,
            ) = tx
                .query_row(
                    "SELECT soul_id,incarnation_id,cleanup_state,certificate_json,cleanup_json FROM loss_incidents WHERE incident_id=?1",
                    params![incident_id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
                )
                .optional()?
                .ok_or_else(|| {
                    RegistryError::IncidentNotFound(incident_id.clone())
                })?;
            let certificate: LostDecisionCertificate = serde_json::from_str(&certificate_json)?;
            if current_state == "closed" {
                let persisted_cleanup: LossCleanupReport = serde_json::from_str(&persisted_cleanup_json)?;
                let kind = if persisted_cleanup.graceful_attempt == "not_required" {
                    NoticeKind::EndedWithoutProcess
                } else {
                    NoticeKind::CleanupSucceeded
                };
                let notice = enqueue_notice_in_tx(
                    &tx,
                    kind,
                    std::slice::from_ref(&incident_id),
                    persisted_cleanup.foreign_objects_touched,
                    crate::registry::now_millis(),
                )?;
                tx.commit()?;
                return Ok(notice);
            }
            if cleanup.owned_handle_ref != certificate.cleanup_target.owned_handle_ref
                || cleanup.foreign_objects_touched != 0
            {
                return Err(RegistryError::InvalidState(
                    "loss cleanup result does not match the exact certified ownership handle".into(),
                ));
            }
            let expected_revision = certificate
                .intent_revision
                .checked_add(1)
                .ok_or_else(|| RegistryError::Integrity("intent revision overflow".into()))?;
            let (desired_state, current_revision, recovery_state, current_incident): (
                String,
                u64,
                String,
                Option<String>,
            ) = tx.query_row(
                "SELECT desired_state,intent_revision,recovery_state,loss_incident_id FROM souls WHERE soul_id=?1",
                params![soul_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            if desired_state != "stopped"
                || current_revision != expected_revision
                || recovery_state != "lost"
                || current_incident.as_deref() != Some(incident_id.as_str())
            {
                return Err(RegistryError::StaleIntentRevision {
                    expected: expected_revision,
                    current: current_revision,
                });
            }
            let now = crate::registry::now_millis();
            let verified = outcome == StopOutcome::VerifiedEmpty && cleanup.verified_empty;
            if verified && !cleanup.ownership_verified {
                return Err(RegistryError::InvalidState(
                    "verified-empty cleanup lacks exact ownership verification".into(),
                ));
            }
            let (incident_state, launch_state, cleanup_state, notice_kind) = if verified {
                (
                    "closed",
                    "stopped",
                    "verified_empty",
                    if cleanup.graceful_attempt == "not_required" {
                        NoticeKind::EndedWithoutProcess
                    } else {
                        NoticeKind::CleanupSucceeded
                    },
                )
            } else {
                (
                    "cleanup_failed",
                    "stopping",
                    match outcome {
                        StopOutcome::BlockedOwnership => "blocked_ownership",
                        _ => "termination_unconfirmed",
                    },
                    NoticeKind::CleanupFailed,
                )
            };
            let incident_changed = tx.execute(
                "UPDATE loss_incidents SET cleanup_state=?1,cleanup_json=?2,updated_at=?3,closed_at=?4 \
                 WHERE incident_id=?5 AND cleanup_state=?6",
                params![
                    incident_state,
                    serde_json::to_string(&cleanup)?,
                    now,
                    verified.then_some(now),
                    incident_id.as_str(),
                    current_state,
                ],
            )?;
            if incident_changed != 1 {
                return Err(RegistryError::RequestConflict);
            }
            let incarnation_changed = tx.execute(
                "UPDATE incarnations SET launch_state=?1,cleanup_state=?2,updated_at=?3 \
                 WHERE incarnation_id=?4 AND soul_id=?5",
                params![launch_state, cleanup_state, now, incarnation_id, soul_id],
            )?;
            if incarnation_changed != 1 {
                return Err(RegistryError::InvalidState(
                    "loss cleanup incarnation no longer belongs to the certified soul".into(),
                ));
            }
            if verified {
                tx.execute(
                    "DELETE FROM writer_claims WHERE incarnation_id=?1",
                    params![incarnation_id],
                )?;
                tx.execute(
                    "DELETE FROM admission_reservations WHERE incarnation_id=?1",
                    params![incarnation_id],
                )?;
                tx.execute(
                    "UPDATE commands SET state='lost',updated_at=?1 WHERE incarnation_id=?2",
                    params![now, incarnation_id],
                )?;
                tx.execute(
                    "UPDATE input_commands SET state='cancelled',updated_at=?1 \
                     WHERE incarnation_id=?2 AND state NOT IN ('completed','cancelled')",
                    params![now, incarnation_id],
                )?;
            }
            let soul_changed = tx.execute(
                "UPDATE souls SET recovery_state='lost',recovery_reason=?1,recovery_attempt_id=NULL, \
                 loss_incident_id=?2,updated_at=?3 WHERE soul_id=?4 AND intent_revision=?5 \
                 AND desired_state='stopped' AND recovery_state='lost' AND loss_incident_id=?2",
                params![
                    format!("LOSS_CERTIFIED:{incident_id}"),
                    incident_id.as_str(),
                    now,
                    soul_id,
                    expected_revision,
                ],
            )?;
            if soul_changed != 1 {
                return Err(RegistryError::StaleIntentRevision {
                    expected: expected_revision,
                    current: current_revision,
                });
            }
            let notice = enqueue_notice_in_tx(
                &tx,
                notice_kind,
                std::slice::from_ref(&incident_id),
                cleanup.foreign_objects_touched,
                now,
            )?;
            if verified {
                // A later verified cleanup supersedes the earlier failure
                // notice for this incident. Keep both durable for audit, but
                // deliver only the final truthful state to each profile.
                let candidates = {
                    let mut statement = tx.prepare(
                        "SELECT notice_id,incident_ids_json FROM runtime_notices                          WHERE superseded_by IS NULL AND notice_id!=?1",
                    )?;
                    let rows = statement.query_map(params![notice.notice_id.as_str()], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })?;
                    rows.collect::<Result<Vec<_>, _>>()?
                };
                for (prior_notice_id, incident_json) in candidates {
                    let incident_ids: Vec<IncidentId> = serde_json::from_str(&incident_json)?;
                    if incident_ids.iter().any(|candidate| candidate == &incident_id) {
                        tx.execute(
                            "UPDATE runtime_notices SET superseded_by=?1,updated_at=?2 WHERE notice_id=?3",
                            params![notice.notice_id.as_str(), now, prior_notice_id],
                        )?;
                    }
                }
            }
            let certificate_sha256 = hash_loss_certificate(&certificate);
            let summary = serde_json::json!({
                "incidentId": incident_id,
                "event": "soul.loss.finalized",
                "certificate": certificate,
                "certificateSha256": certificate_sha256,
                "cleanupState": incident_state,
                "cleanup": cleanup,
                "noticeId": notice.notice_id,
                "updatedAt": millis_to_timestamp(now),
            });
            tx.execute(
                "INSERT OR REPLACE INTO outbox (event_id,event_kind,payload,created_at,delivered_at) \
                 VALUES (?1,'loss_incident.final',?2,?3,NULL)",
                params![
                    format!("projection-loss-final-{incident_id}"),
                    serde_json::to_string(&summary)?,
                    now
                ],
            )?;
            increment_counter_in_tx(
                &tx,
                "cleanup_outcome",
                if verified {
                    "verified_empty"
                } else {
                    cleanup_state
                },
                1,
                now,
            )?;
            tx.commit()?;
            Ok(notice)
        })
        .await
    }

    pub async fn pending_incident_exports(
        &self,
        limit: u32,
    ) -> Result<Vec<PendingIncidentExport>, RegistryError> {
        let limit = i64::from(limit.clamp(1, 100));
        self.run_blocking(move |conn| {
            let mut statement = conn.prepare(
                "SELECT event_id,event_kind,payload FROM outbox WHERE event_kind IN ('loss_incident.open','loss_incident.final') \
                 AND delivered_at IS NULL ORDER BY created_at,event_id LIMIT ?1",
            )?;
            let rows = statement.query_map(params![limit], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
            let mut exports = Vec::new();
            for row in rows {
                let (event_id, event_kind, payload) = row?;
                let payload: serde_json::Value = serde_json::from_str(&payload)?;
                let raw = payload
                    .get("incidentId")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| RegistryError::Integrity("incident export has no incidentId".into()))?;
                exports.push(PendingIncidentExport {
                    event_id,
                    event_kind,
                    incident_id: IncidentId::parse(raw)
                        .map_err(|_| RegistryError::Integrity("invalid incident id".into()))?,
                    payload,
                });
            }
            Ok(exports)
        })
        .await
    }

    pub async fn acknowledge_incident_export(&self, event_id: String) -> Result<(), RegistryError> {
        self.run_blocking(move |conn| {
            let changed = conn.execute(
                "UPDATE outbox SET delivered_at=COALESCE(delivered_at,?1) \
                 WHERE event_id=?2 AND event_kind IN ('loss_incident.open','loss_incident.final')",
                params![crate::registry::now_millis(), event_id],
            )?;
            if changed == 0 {
                return Err(RegistryError::InvalidState(
                    "unknown incident export event".into(),
                ));
            }
            Ok(())
        })
        .await
    }

    pub async fn loss_certificate(
        &self,
        incident_id: IncidentId,
    ) -> Result<LostDecisionCertificate, RegistryError> {
        self.run_blocking(move |conn| {
            let encoded = conn
                .query_row(
                    "SELECT certificate_json FROM loss_incidents WHERE incident_id=?1",
                    params![incident_id.as_str()],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .ok_or_else(|| RegistryError::IncidentNotFound(incident_id.clone()))?;
            Ok(serde_json::from_str(&encoded)?)
        })
        .await
    }
}

fn loss_decision_state_name(state: LossDecisionState) -> &'static str {
    match state {
        LossDecisionState::Lost => "lost",
        LossDecisionState::NonResumableTerminalEnded => "non_resumable_terminal_ended",
    }
}

#[cfg(test)]
#[path = "loss_report_tests.rs"]
mod tests;
