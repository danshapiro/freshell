use crate::admission::{AdmissionPolicy, ReservationTotals};
use freshell_runtime_protocol::{
    AllocationState, CleanupState, DesiredState, DockerDaemonId, DurabilityState, FixtureKind,
    GrantId, HostBootId, IncarnationId, IncidentId, InstallationId, LaunchNonce, LaunchState,
    NoticeId, RecoveryAttemptId, RecoveryBlockReason, RecoveryPath, RecoveryState, RecoveryTrigger,
    RequestId, ResumeSpec, RuntimeLimits, RuntimeProfile, RuntimeView, SoulId, StopOutcome,
    TerminalLaunchSpec, ViewIntentRequest,
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::OpenOptions,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

pub const SCHEMA_VERSION: u32 = 6;
const ACTIVE_STATES: &str = "'prepared','created','starting','running','stopping'";

#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error("runtime registry is already owned by another supervisor")]
    Busy,
    #[error("runtime registry schema {found} is newer than supported schema {supported}")]
    NewerSchema { found: u32, supported: u32 },
    #[error("runtime registry integrity check failed: {0}")]
    Integrity(String),
    #[error("installation id does not match the existing registry")]
    InstallationMismatch,
    #[error("request id was reused with different semantic payload")]
    RequestConflict,
    #[error("another active incarnation already exists for soul {0}")]
    ActiveIncarnation(SoulId),
    #[error("managed runtime resource reservation exceeds {scope} budget")]
    BlockedResource { scope: &'static str },
    #[error("stale control epoch: expected {expected}, current {current}")]
    StaleControlEpoch { expected: u64, current: u64 },
    #[error("stale soul intent revision: expected {expected}, current {current}")]
    StaleIntentRevision { expected: u64, current: u64 },
    #[error("unknown incarnation {0}")]
    UnknownIncarnation(IncarnationId),
    #[error("unknown soul {0}")]
    UnknownSoul(SoulId),
    #[error("invalid registry state: {0}")]
    InvalidState(String),
    #[error("recovery is already in progress for soul {0}")]
    RecoveryInProgress(SoulId),
    #[error("recovery is blocked for soul {soul_id}: {reason}")]
    RecoveryBlocked { soul_id: SoulId, reason: String },
    #[error("native session identity conflicts with durable soul identity")]
    NativeIdentityConflict,
    #[error("loss certification is blocked: {0}")]
    LossCertificationBlocked(String),
    #[error("loss incident persistence failed: {0}")]
    IncidentPersistenceFailed(String),
    #[error("unknown loss incident {0}")]
    IncidentNotFound(IncidentId),
    #[error("unknown runtime notice {0}")]
    NoticeNotFound(NoticeId),
    #[error("managed rollout migration is blocked: {0}")]
    MigrationBlocked(String),
    #[error("runtime repair is blocked: {0}")]
    RepairBlocked(String),
    #[error("terminal input request id was reused with different data")]
    InputConflict,
    #[error("fault injected at registry barrier {0}")]
    FaultInjected(&'static str),
    #[error("registry I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("registry SQLite failed: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("registry JSON failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("registry blocking task failed: {0}")]
    Join(String),
}

#[derive(Clone)]
pub struct Registry {
    inner: Arc<RegistryInner>,
}

struct RegistryInner {
    db_path: PathBuf,
    installation_id: InstallationId,
    control_epoch: u64,
    #[allow(dead_code)]
    lock_file: std::fs::File,
}

#[derive(Debug, Clone)]
pub struct LaunchPreparation {
    pub soul_id: SoulId,
    pub provider: String,
    pub provider_store_id: String,
    pub native_session_id: Option<String>,
    pub creation_seed_ref: String,
    pub request_id: RequestId,
    pub payload_digest: String,
    pub requested_limits: RuntimeLimits,
    pub profile: RuntimeProfile,
    pub project_key: String,
    pub fixture: Option<FixtureKind>,
    pub terminal: Option<TerminalLaunchSpec>,
    pub view_intent: Option<ViewIntentRequest>,
    pub admission: AdmissionPolicy,
}

#[derive(Debug, Clone)]
pub struct PreparedLaunch {
    pub soul_id: SoulId,
    pub incarnation_id: IncarnationId,
    pub launch_nonce: LaunchNonce,
    pub state: LaunchState,
    pub intent_revision: u64,
    pub existing_request: bool,
}

#[derive(Debug, Clone)]
pub struct BackendCreatedRecord {
    pub daemon_id: DockerDaemonId,
    pub container_id: String,
    pub image_ref: String,
    pub runtime_dir: PathBuf,
    pub host_binary_path: PathBuf,
    pub immutable_config_digest: String,
}

#[derive(Debug, Clone)]
pub struct ExecutionGrantRecord {
    pub control_epoch: u64,
    pub execution_generation: u64,
    pub grant_id: GrantId,
    pub host_boot_id: HostBootId,
}

/// Capability proving that a mutation targets a container durably recorded by
/// this installation. Its fields are private and the constructor is crate-
/// private: callers cannot manufacture kill authority from a pid, label, name,
/// environment variable, or arbitrary container id.
#[derive(Debug, Clone)]
pub struct OwnedRuntimeHandle {
    installation_id: InstallationId,
    soul_id: SoulId,
    incarnation_id: IncarnationId,
    launch_nonce: LaunchNonce,
    daemon_id: DockerDaemonId,
    container_id: String,
    image_ref: String,
    runtime_dir: PathBuf,
    host_binary_path: PathBuf,
    immutable_config_digest: String,
    requested_limits: RuntimeLimits,
    fixture: Option<FixtureKind>,
    terminal: Option<TerminalLaunchSpec>,
    provider_volume_name: String,
}

impl OwnedRuntimeHandle {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_registry(
        installation_id: InstallationId,
        soul_id: SoulId,
        incarnation_id: IncarnationId,
        launch_nonce: LaunchNonce,
        daemon_id: DockerDaemonId,
        container_id: String,
        image_ref: String,
        runtime_dir: PathBuf,
        host_binary_path: PathBuf,
        immutable_config_digest: String,
        requested_limits: RuntimeLimits,
        fixture: Option<FixtureKind>,
        terminal: Option<TerminalLaunchSpec>,
        provider_volume_name: String,
    ) -> Self {
        Self {
            installation_id,
            soul_id,
            incarnation_id,
            launch_nonce,
            daemon_id,
            container_id,
            image_ref,
            runtime_dir,
            host_binary_path,
            immutable_config_digest,
            requested_limits,
            fixture,
            terminal,
            provider_volume_name,
        }
    }

    pub fn installation_id(&self) -> &InstallationId {
        &self.installation_id
    }
    pub fn soul_id(&self) -> &SoulId {
        &self.soul_id
    }
    pub fn incarnation_id(&self) -> &IncarnationId {
        &self.incarnation_id
    }
    pub fn launch_nonce(&self) -> &LaunchNonce {
        &self.launch_nonce
    }
    pub fn daemon_id(&self) -> &DockerDaemonId {
        &self.daemon_id
    }
    pub fn container_id(&self) -> &str {
        &self.container_id
    }
    pub fn image_ref(&self) -> &str {
        &self.image_ref
    }
    pub fn runtime_dir(&self) -> &Path {
        &self.runtime_dir
    }
    pub fn host_binary_path(&self) -> &Path {
        &self.host_binary_path
    }
    pub fn immutable_config_digest(&self) -> &str {
        &self.immutable_config_digest
    }
    pub fn requested_limits(&self) -> RuntimeLimits {
        self.requested_limits
    }
    pub fn fixture(&self) -> Option<FixtureKind> {
        self.fixture
    }
    pub fn terminal(&self) -> Option<&TerminalLaunchSpec> {
        self.terminal.as_ref()
    }
    pub fn provider_volume_name(&self) -> &str {
        &self.provider_volume_name
    }
}

#[derive(Debug, Clone)]
pub struct RecoveryContext {
    pub soul_id: SoulId,
    pub prior_handle: OwnedRuntimeHandle,
    pub provider: String,
    pub provider_store_id: String,
    pub native_session_id: Option<String>,
    pub creation_seed_ref: String,
    pub desired_state: DesiredState,
    pub intent_revision: u64,
    pub recovery_state: RecoveryState,
    pub durability_state: DurabilityState,
    pub allocation_state: AllocationState,
    pub checkpoint_revision: u64,
    pub evidence_revision: u64,
    pub resume_spec: Option<ResumeSpec>,
    pub project_key: String,
    pub profile: RuntimeProfile,
    pub fixture: Option<FixtureKind>,
    pub terminal: Option<TerminalLaunchSpec>,
    pub requested_limits: RuntimeLimits,
    pub accepted_command_count: u64,
    pub completed_command_count: u64,
    pub never_dispatched: bool,
    pub recovery_window_started_at: Option<i64>,
    pub successful_recoveries_in_window: u64,
}

#[derive(Debug, Clone)]
pub struct RecoveryStart {
    pub attempt_id: RecoveryAttemptId,
    pub context: RecoveryContext,
}

#[derive(Debug, Clone)]
pub struct ReplacementPreparation {
    pub prepared: PreparedLaunch,
    pub fixture: Option<FixtureKind>,
    pub terminal: Option<TerminalLaunchSpec>,
    pub resume_spec: Option<ResumeSpec>,
    pub prior_incarnation_id: IncarnationId,
    pub attempt_id: RecoveryAttemptId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputJournalDisposition {
    Dispatch,
    Completed,
    Ambiguous,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedInput {
    pub request_id: RequestId,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryDebugSnapshot {
    pub installation_id: InstallationId,
    pub control_epoch: u64,
    pub views: Vec<RuntimeView>,
}

impl Registry {
    pub fn open(
        root: impl AsRef<Path>,
        installation_hint: Option<InstallationId>,
    ) -> Result<Self, RegistryError> {
        let root = root.as_ref();
        std::fs::create_dir_all(root)?;
        // The registry contains protected queued input and durable provider
        // identity. Keep the entire SQLite/WAL directory supervisor-private.
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))?;
        let lock_path = root.join("supervisor.lock");
        let lock_file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(lock_path)?;
        acquire_exclusive_lock(&lock_file)?;

        let db_path = root.join("runtime.sqlite3");
        let mut conn = open_connection(&db_path)?;
        let existing = table_exists(&conn, "installation")?;
        if !existing {
            create_schema(&mut conn, installation_hint.clone().unwrap_or_default())?;
        } else {
            migrate_schema(&mut conn)?;
        }
        verify_schema_and_integrity(&conn)?;

        let (installation_raw, schema_version, epoch): (String, u32, u64) = conn.query_row(
            "SELECT installation_id, schema_version, control_epoch FROM installation WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        if schema_version > SCHEMA_VERSION {
            return Err(RegistryError::NewerSchema {
                found: schema_version,
                supported: SCHEMA_VERSION,
            });
        }
        let installation_id = InstallationId::parse(installation_raw)
            .map_err(|_| RegistryError::Integrity("invalid installation id".into()))?;
        if let Some(hint) = installation_hint {
            if hint != installation_id {
                return Err(RegistryError::InstallationMismatch);
            }
        }
        crate::view_intents::backfill_automatic_view_intents(&mut conn, &installation_id)?;

        let next_epoch = epoch
            .checked_add(1)
            .ok_or_else(|| RegistryError::Integrity("control epoch overflow".into()))?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "UPDATE installation SET control_epoch=?1 WHERE singleton=1 AND control_epoch=?2",
            params![next_epoch, epoch],
        )?;
        tx.commit()?;
        drop(conn);

        Ok(Self {
            inner: Arc::new(RegistryInner {
                db_path,
                installation_id,
                control_epoch: next_epoch,
                lock_file,
            }),
        })
    }

    pub fn installation_id(&self) -> &InstallationId {
        &self.inner.installation_id
    }
    pub fn control_epoch(&self) -> u64 {
        self.inner.control_epoch
    }
    pub(crate) fn database_path(&self) -> &Path {
        &self.inner.db_path
    }
    pub(crate) fn registry_root(&self) -> &Path {
        self.inner
            .db_path
            .parent()
            .expect("registry database always has a parent")
    }

    pub fn assert_epoch(&self, expected: Option<u64>) -> Result<(), RegistryError> {
        if let Some(expected) = expected {
            if expected != self.control_epoch() {
                return Err(RegistryError::StaleControlEpoch {
                    expected,
                    current: self.control_epoch(),
                });
            }
        }
        Ok(())
    }

    pub async fn prepare_launch(
        &self,
        input: LaunchPreparation,
    ) -> Result<PreparedLaunch, RegistryError> {
        let installation_id = self.installation_id().clone();
        self.run_blocking(move |mut conn| {
            failpoint("prepare")?;
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

            if let Some((existing_digest, incarnation_raw)) = tx
                .query_row(
                    "SELECT payload_digest, incarnation_id FROM commands WHERE soul_id=?1 AND request_id=?2",
                    params![input.soul_id.as_str(), input.request_id.as_str()],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?
            {
                if existing_digest != input.payload_digest {
                    return Err(RegistryError::RequestConflict);
                }
                let incarnation_id = IncarnationId::parse(incarnation_raw)
                    .map_err(|_| RegistryError::Integrity("invalid incarnation id".into()))?;
                let row = load_prepared_row(&tx, &incarnation_id)?;
                tx.commit()?;
                return Ok(PreparedLaunch { existing_request: true, ..row });
            }

            let now = now_millis();
            let profile_name = runtime_profile_name(input.profile);
            let provider_volume_name = stable_provider_volume_name(&installation_id, &input.soul_id);
            let soul_row: Option<(String, String, String, String, Option<String>, u64)> = tx
                .query_row(
                    "SELECT provider,provider_store_id,project_key,resource_profile,native_session_id,intent_revision FROM souls WHERE soul_id=?1",
                    params![input.soul_id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
                )
                .optional()?;
            let soul_intent_revision = if let Some((provider, store, project, profile, native, revision)) = soul_row {
                if provider != input.provider
                    || store != input.provider_store_id
                    || project != input.project_key
                    || profile != profile_name
                    || (native.is_some() && native != input.native_session_id)
                {
                    return Err(RegistryError::InvalidState(
                        "existing soul launch identity/profile does not match request".into(),
                    ));
                }
                revision
            } else {
                tx.execute(
                    "INSERT INTO souls (soul_id,provider,provider_store_id,native_session_id,creation_seed_ref,desired_state,intent_revision,recovery_state,recovery_reason,recovery_attempt_id,durability_state,allocation_state,resume_spec,checkpoint_revision,evidence_revision,recovery_window_started_at,successful_recoveries_in_window,project_key,resource_profile,provider_volume_name,configured_limits,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,'running',1,'live',NULL,NULL,'unknown','allocated',NULL,0,0,NULL,0,?6,?7,?8,?9,?10,?10)",
                    params![
                        input.soul_id.as_str(),
                        input.provider,
                        input.provider_store_id,
                        input.native_session_id,
                        input.creation_seed_ref,
                        input.project_key,
                        profile_name,
                        provider_volume_name,
                        serde_json::to_string(&input.requested_limits)?,
                        now
                    ],
                )?;
                1
            };
            if input.terminal.is_some() || input.view_intent.is_some() {
                crate::view_intents::ensure_automatic_primary_in_tx(
                    &tx,
                    &installation_id,
                    &input.soul_id,
                    &input.project_key,
                    &input.provider,
                    soul_intent_revision,
                    input.view_intent.as_ref(),
                    now,
                )?;
            }

            let active: Option<(String, String, String, String, Option<String>)> = tx
                .query_row(
                    &format!(
                        "SELECT i.incarnation_id,i.launch_state,s.desired_state,s.recovery_state,(SELECT c.payload_digest FROM commands c WHERE c.incarnation_id=i.incarnation_id ORDER BY c.created_at LIMIT 1) FROM incarnations i JOIN souls s ON s.soul_id=i.soul_id WHERE i.soul_id=?1 AND i.launch_state IN ({ACTIVE_STATES}) LIMIT 1"
                    ),
                    params![input.soul_id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
                )
                .optional()?;
            if let Some((incarnation_raw, launch_state, desired_state, recovery_state, active_digest)) = active {
                // A controller restart may present the same semantic launch
                // under a new request id. Adopt only a demonstrably live,
                // desired-running incarnation whose original durable command
                // digest exactly matches; never reinterpret a conflicting
                // request as continuity.
                if launch_state != "running"
                    || desired_state != "running"
                    || recovery_state != "live"
                    || active_digest.as_deref() != Some(input.payload_digest.as_str())
                {
                    return Err(RegistryError::ActiveIncarnation(input.soul_id));
                }
                let incarnation_id = IncarnationId::parse(incarnation_raw)
                    .map_err(|_| RegistryError::Integrity("invalid incarnation id".into()))?;
                tx.execute(
                    "INSERT INTO commands (soul_id,request_id,payload_digest,protected_payload_ref,state,provider_ack_id,incarnation_id,event_cursor,created_at,updated_at) VALUES (?1,?2,?3,NULL,'running',NULL,?4,0,?5,?5)",
                    params![input.soul_id.as_str(), input.request_id.as_str(), input.payload_digest, incarnation_id.as_str(), now],
                )?;
                let row = load_prepared_row(&tx, &incarnation_id)?;
                tx.commit()?;
                return Ok(PreparedLaunch {
                    existing_request: true,
                    ..row
                });
            }

            let installation_used = reservation_totals(&tx, None)?;
            if !input.admission.installation.admits(installation_used, input.requested_limits) {
                return Err(RegistryError::BlockedResource { scope: "installation" });
            }
            let project_used = reservation_totals(&tx, Some(&input.project_key))?;
            if !input.admission.project.admits(project_used, input.requested_limits) {
                return Err(RegistryError::BlockedResource { scope: "project" });
            }

            let incarnation_id = IncarnationId::new();
            let launch_nonce = LaunchNonce::new();
            let limits_json = serde_json::to_string(&input.requested_limits)?;
            let terminal_json = input.terminal.as_ref().map(serde_json::to_string).transpose()?;
            let terminal_id = input.terminal.as_ref().map(|t| t.terminal_id.as_str());
            let fixture_kind = input.fixture.map(fixture_kind_name);
            tx.execute(
                "INSERT INTO incarnations (incarnation_id,soul_id,launch_nonce,docker_daemon_id,container_id,image_ref,runtime_dir,host_binary_path,immutable_config_digest,launch_state,host_boot_id,execution_generation,grant_id,requested_limits,effective_limits,cleanup_state,fixture_kind,terminal_id,terminal_spec,prior_incarnation_id,recovery_attempt_id,exit_code,oom_killed,created_at,updated_at) VALUES (?1,?2,?3,NULL,NULL,NULL,NULL,NULL,NULL,'prepared',NULL,0,NULL,?4,NULL,'none',?5,?6,?7,NULL,NULL,NULL,0,?8,?8)",
                params![incarnation_id.as_str(), input.soul_id.as_str(), launch_nonce.as_str(), limits_json, fixture_kind, terminal_id, terminal_json, now],
            )?;
            tx.execute(
                "INSERT INTO admission_reservations (incarnation_id,project_key,cpu_milli,memory_bytes,pids_max,created_at) VALUES (?1,?2,?3,?4,?5,?6)",
                params![
                    incarnation_id.as_str(),
                    input.project_key,
                    input.requested_limits.cpu_milli,
                    input.requested_limits.memory_bytes,
                    input.requested_limits.pids_max,
                    now
                ],
            )?;
            if let Some(native_session_id) = input.native_session_id.as_deref() {
                tx.execute(
                    "INSERT INTO writer_claims (provider,provider_store_id,native_session_id,soul_id,incarnation_id,intent_revision) VALUES (?1,?2,?3,?4,?5,1)",
                    params![input.provider, input.provider_store_id, native_session_id, input.soul_id.as_str(), incarnation_id.as_str()],
                )?;
            }
            tx.execute(
                "INSERT INTO commands (soul_id,request_id,payload_digest,protected_payload_ref,state,provider_ack_id,incarnation_id,event_cursor,created_at,updated_at) VALUES (?1,?2,?3,NULL,'prepared',NULL,?4,0,?5,?5)",
                params![input.soul_id.as_str(), input.request_id.as_str(), input.payload_digest, incarnation_id.as_str(), now],
            )?;
            let intent_revision: u64 = tx.query_row(
                "SELECT intent_revision FROM souls WHERE soul_id=?1",
                params![input.soul_id.as_str()],
                |row| row.get(0),
            )?;
            tx.commit()?;
            Ok(PreparedLaunch { soul_id: input.soul_id, incarnation_id, launch_nonce, state: LaunchState::Prepared, intent_revision, existing_request: false })
        }).await
    }

    pub async fn commit_created(
        &self,
        incarnation_id: IncarnationId,
        created: BackendCreatedRecord,
    ) -> Result<(), RegistryError> {
        self.run_blocking(move |mut conn| {
            failpoint("commit_created")?;
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now = now_millis();
            let changed = tx.execute(
                "UPDATE incarnations SET docker_daemon_id=?1,container_id=?2,image_ref=?3,runtime_dir=?4,host_binary_path=?5,immutable_config_digest=?6,launch_state='created',updated_at=?7 WHERE incarnation_id=?8 AND launch_state='prepared' AND container_id IS NULL AND EXISTS (SELECT 1 FROM souls WHERE soul_id=incarnations.soul_id AND desired_state='running')",
                params![created.daemon_id.as_str(), created.container_id, created.image_ref, created.runtime_dir.to_string_lossy(), created.host_binary_path.to_string_lossy(), created.immutable_config_digest, now, incarnation_id.as_str()],
            )?;
            if changed != 1 { return Err(RegistryError::InvalidState(format!("cannot commit CREATED for {incarnation_id}"))); }
            tx.execute("UPDATE commands SET state='created',updated_at=?1 WHERE incarnation_id=?2", params![now, incarnation_id.as_str()])?;
            tx.commit()?;
            Ok(())
        }).await
    }

    pub async fn commit_execution_grant(
        &self,
        incarnation_id: IncarnationId,
        host_boot_id: HostBootId,
        effective_limits: RuntimeLimits,
    ) -> Result<ExecutionGrantRecord, RegistryError> {
        let control_epoch = self.control_epoch();
        self.run_blocking(move |mut conn| {
            failpoint("commit_grant")?;
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let existing: Option<(String, u64, String)> = tx.query_row(
                "SELECT host_boot_id,execution_generation,grant_id FROM incarnations WHERE incarnation_id=?1 AND launch_state='starting'",
                params![incarnation_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            ).optional()?;
            if let Some((boot, generation, grant)) = existing {
                let boot = HostBootId::parse(boot).map_err(|_| RegistryError::Integrity("invalid host boot id".into()))?;
                if boot != host_boot_id {
                    return Err(RegistryError::InvalidState("host boot changed while grant was outstanding".into()));
                }
                return Ok(ExecutionGrantRecord { control_epoch, execution_generation: generation, grant_id: GrantId::parse(grant).map_err(|_| RegistryError::Integrity("invalid grant id".into()))?, host_boot_id: boot });
            }

            let previous: u64 = tx.query_row(
                "SELECT i.execution_generation FROM incarnations i JOIN souls s ON s.soul_id=i.soul_id WHERE i.incarnation_id=?1 AND i.launch_state='created' AND s.desired_state='running'",
                params![incarnation_id.as_str()],
                |row| row.get(0),
            ).optional()?.ok_or_else(|| RegistryError::InvalidState(format!("cannot grant execution for {incarnation_id}; stop intent or lifecycle transition won")))?;
            let generation = previous.checked_add(1).ok_or_else(|| RegistryError::Integrity("execution generation overflow".into()))?;
            let grant_id = GrantId::new();
            let effective_json = serde_json::to_string(&effective_limits)?;
            let now = now_millis();
            let changed = tx.execute(
                "UPDATE incarnations SET launch_state='starting',host_boot_id=?1,execution_generation=?2,grant_id=?3,effective_limits=?4,updated_at=?5 WHERE incarnation_id=?6 AND launch_state='created' AND EXISTS (SELECT 1 FROM souls WHERE soul_id=incarnations.soul_id AND desired_state='running')",
                params![host_boot_id.as_str(), generation, grant_id.as_str(), effective_json, now, incarnation_id.as_str()],
            )?;
            if changed != 1 {
                return Err(RegistryError::InvalidState(format!(
                    "cannot persist execution grant for {incarnation_id}; stop intent won"
                )));
            }
            tx.execute("UPDATE commands SET state='starting',updated_at=?1 WHERE incarnation_id=?2", params![now, incarnation_id.as_str()])?;
            tx.commit()?;
            Ok(ExecutionGrantRecord { control_epoch, execution_generation: generation, grant_id, host_boot_id })
        }).await
    }

    pub async fn mark_running(&self, incarnation_id: IncarnationId) -> Result<(), RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now = now_millis();
            let changed = tx.execute(
                "UPDATE incarnations SET launch_state='running',updated_at=?1 WHERE incarnation_id=?2 AND launch_state='starting' AND EXISTS (SELECT 1 FROM souls WHERE soul_id=incarnations.soul_id AND desired_state='running')",
                params![now, incarnation_id.as_str()],
            )?;
            if changed != 1 { return Err(RegistryError::InvalidState(format!("cannot mark RUNNING for {incarnation_id}"))); }
            tx.execute("UPDATE commands SET state='running',updated_at=?1 WHERE incarnation_id=?2", params![now, incarnation_id.as_str()])?;
            tx.commit()?;
            Ok(())
        }).await
    }

    pub async fn owned_handle(
        &self,
        incarnation_id: IncarnationId,
    ) -> Result<OwnedRuntimeHandle, RegistryError> {
        let installation = self.installation_id().clone();
        self.run_blocking(move |conn| load_owned_handle(&conn, installation, &incarnation_id))
            .await
    }

    pub async fn active_handle_for_soul(
        &self,
        soul_id: SoulId,
    ) -> Result<OwnedRuntimeHandle, RegistryError> {
        let installation = self.installation_id().clone();
        self.run_blocking(move |conn| {
            let incarnation_raw: Option<String> = conn
                .query_row(
                    "SELECT i.incarnation_id FROM incarnations i JOIN souls s ON s.soul_id=i.soul_id WHERE i.soul_id=?1 AND i.launch_state='running' AND s.desired_state='running' AND s.recovery_state='live' ORDER BY i.created_at DESC LIMIT 1",
                    params![soul_id.as_str()],
                    |row| row.get(0),
                )
                .optional()?;
            let raw = incarnation_raw.ok_or_else(|| RegistryError::UnknownSoul(soul_id))?;
            let incarnation = IncarnationId::parse(raw)
                .map_err(|_| RegistryError::Integrity("invalid incarnation id".into()))?;
            load_owned_handle(&conn, installation, &incarnation)
        })
        .await
    }

    pub async fn begin_stop(&self, soul_id: SoulId) -> Result<OwnedRuntimeHandle, RegistryError> {
        self.begin_stop_expected(soul_id, None).await
    }

    pub async fn begin_stop_expected(
        &self,
        soul_id: SoulId,
        expected_intent_revision: Option<u64>,
    ) -> Result<OwnedRuntimeHandle, RegistryError> {
        let installation = self.installation_id().clone();
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let incarnation: Option<(String, String)> = tx
                .query_row(
                    &format!(
                        "SELECT incarnation_id,launch_state FROM incarnations WHERE soul_id=?1 ORDER BY CASE WHEN launch_state IN ({ACTIVE_STATES}) THEN 0 ELSE 1 END,created_at DESC LIMIT 1"
                    ),
                    params![soul_id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let Some((incarnation_raw, launch_state)) = incarnation else {
                return Err(RegistryError::UnknownSoul(soul_id));
            };
            let incarnation_id = IncarnationId::parse(incarnation_raw)
                .map_err(|_| RegistryError::Integrity("invalid incarnation id".into()))?;
            let (desired_state, revision): (String, u64) = tx.query_row(
                "SELECT desired_state,intent_revision FROM souls WHERE soul_id=?1",
                params![soul_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if let Some(expected) = expected_intent_revision {
                if expected != revision {
                    return Err(RegistryError::StaleIntentRevision {
                        expected,
                        current: revision,
                    });
                }
            }
            let now = now_millis();
            let committed_revision = if desired_state != "stopped" {
                let next = revision.checked_add(1).ok_or_else(|| {
                    RegistryError::Integrity("intent revision overflow".into())
                })?;
                tx.execute(
                    "UPDATE souls SET desired_state='stopped',intent_revision=?1,recovery_state='stopped',recovery_reason='STOP_INTENT',recovery_attempt_id=NULL,updated_at=?2 WHERE soul_id=?3",
                    params![next, now, soul_id.as_str()],
                )?;
                tx.execute(
                    "INSERT OR IGNORE INTO stop_tombstones (soul_id,intent_revision,actor,reason,committed_at) VALUES (?1,?2,'supervisor','managed stop',?3)",
                    params![soul_id.as_str(), next, now],
                )?;
                next
            } else {
                revision
            };
            crate::view_intents::hide_automatic_primary_in_tx(
                &tx,
                &soul_id,
                committed_revision,
                now,
            )?;
            if !matches!(launch_state.as_str(), "stopped" | "failed") {
                tx.execute(
                    "UPDATE incarnations SET launch_state='stopping',cleanup_state='requested',updated_at=?1 WHERE incarnation_id=?2",
                    params![now, incarnation_id.as_str()],
                )?;
            }
            tx.execute(
                "UPDATE input_commands SET state='ambiguous',updated_at=?1 WHERE soul_id=?2 AND state='dispatching'",
                params![now, soul_id.as_str()],
            )?;
            tx.commit()?;
            load_owned_handle(&conn, installation, &incarnation_id)
        })
        .await
    }

    pub async fn mark_stop_outcome(
        &self,
        incarnation_id: IncarnationId,
        outcome: StopOutcome,
    ) -> Result<(), RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let (launch_state, cleanup_state) = match outcome {
                StopOutcome::VerifiedEmpty => ("stopped", "verified_empty"),
                StopOutcome::BlockedOwnership => ("stopping", "blocked_ownership"),
                StopOutcome::BackendUnavailable | StopOutcome::TerminationUnconfirmed => ("stopping", "termination_unconfirmed"),
            };
            let now = now_millis();
            tx.execute("UPDATE incarnations SET launch_state=?1,cleanup_state=?2,updated_at=?3 WHERE incarnation_id=?4", params![launch_state, cleanup_state, now, incarnation_id.as_str()])?;
            if outcome == StopOutcome::VerifiedEmpty {
                tx.execute("DELETE FROM writer_claims WHERE incarnation_id=?1", params![incarnation_id.as_str()])?;
                tx.execute("DELETE FROM admission_reservations WHERE incarnation_id=?1", params![incarnation_id.as_str()])?;
                tx.execute("UPDATE commands SET state='stopped',updated_at=?1 WHERE incarnation_id=?2", params![now, incarnation_id.as_str()])?;
                tx.execute(
                    "UPDATE souls SET recovery_state='stopped',recovery_reason='STOP_INTENT',recovery_attempt_id=NULL,updated_at=?1 WHERE soul_id=(SELECT soul_id FROM incarnations WHERE incarnation_id=?2) AND desired_state='stopped' AND recovery_state!='lost'",
                    params![now, incarnation_id.as_str()],
                )?;
            }
            tx.commit()?;
            Ok(())
        }).await
    }

    pub async fn begin_input(
        &self,
        soul_id: SoulId,
        request_id: RequestId,
        data: &[u8],
    ) -> Result<(InputJournalDisposition, IncarnationId), RegistryError> {
        let payload_digest = format!("sha256:{:x}", Sha256::digest(data));
        let protected_payload = data.to_vec();
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if let Some((existing_digest, existing_payload, state, recorded_incarnation)) = tx
                .query_row(
                    "SELECT payload_digest,protected_payload,state,incarnation_id FROM input_commands WHERE soul_id=?1 AND request_id=?2",
                    params![soul_id.as_str(), request_id.as_str()],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Vec<u8>>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    },
                )
                .optional()?
            {
                if existing_digest != payload_digest || existing_payload != protected_payload {
                    return Err(RegistryError::InputConflict);
                }
                let recorded_incarnation = IncarnationId::parse(recorded_incarnation)
                    .map_err(|_| RegistryError::Integrity("invalid input incarnation id".into()))?;
                match state.as_str() {
                    "completed" => {
                        tx.commit()?;
                        return Ok((InputJournalDisposition::Completed, recorded_incarnation));
                    }
                    "dispatching" | "ambiguous" => {
                        tx.commit()?;
                        return Ok((InputJournalDisposition::Ambiguous, recorded_incarnation));
                    }
                    "queued" => {}
                    other => {
                        return Err(RegistryError::Integrity(format!(
                            "unknown input command state {other}"
                        )))
                    }
                }
            }

            let incarnation_raw: String = tx
                .query_row(
                    "SELECT i.incarnation_id FROM incarnations i JOIN souls s ON s.soul_id=i.soul_id WHERE i.soul_id=?1 AND i.launch_state='running' AND s.desired_state='running' AND s.recovery_state='live' ORDER BY i.created_at DESC LIMIT 1",
                    params![soul_id.as_str()],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| RegistryError::UnknownSoul(soul_id.clone()))?;
            let incarnation_id = IncarnationId::parse(incarnation_raw)
                .map_err(|_| RegistryError::Integrity("invalid incarnation id".into()))?;

            let now = now_millis();
            let changed = tx.execute(
                "UPDATE input_commands SET incarnation_id=?1,updated_at=?2 WHERE soul_id=?3 AND request_id=?4 AND state='queued'",
                params![incarnation_id.as_str(), now, soul_id.as_str(), request_id.as_str()],
            )?;
            if changed == 0 {
                tx.execute(
                    "INSERT INTO input_commands (soul_id,request_id,payload_digest,protected_payload,incarnation_id,state,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,'queued',?6,?6)",
                    params![soul_id.as_str(), request_id.as_str(), payload_digest, protected_payload, incarnation_id.as_str(), now],
                )?;
            }
            tx.commit()?;
            Ok((InputJournalDisposition::Dispatch, incarnation_id))
        })
        .await
    }

    pub async fn mark_input_dispatching(
        &self,
        soul_id: SoulId,
        request_id: RequestId,
    ) -> Result<(), RegistryError> {
        self.set_input_state(soul_id, request_id, "dispatching")
            .await
    }

    pub async fn mark_input_completed(
        &self,
        soul_id: SoulId,
        request_id: RequestId,
    ) -> Result<(), RegistryError> {
        self.set_input_state(soul_id, request_id, "completed").await
    }

    pub async fn mark_input_ambiguous(
        &self,
        soul_id: SoulId,
        request_id: RequestId,
    ) -> Result<(), RegistryError> {
        self.set_input_state(soul_id, request_id, "ambiguous").await
    }

    /// Atomically moves one never-dispatched command onto the replacement
    /// incarnation. Dispatching/ambiguous commands are deliberately excluded:
    /// response loss can never cause an interrupted prompt to be replayed.
    pub async fn claim_next_queued_input(
        &self,
        soul_id: SoulId,
        incarnation_id: IncarnationId,
    ) -> Result<Option<QueuedInput>, RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let valid_target: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM incarnations i JOIN souls s ON s.soul_id=i.soul_id WHERE i.incarnation_id=?1 AND i.soul_id=?2 AND i.launch_state='running' AND s.desired_state='running')",
                params![incarnation_id.as_str(), soul_id.as_str()],
                |row| row.get(0),
            )?;
            if !valid_target {
                return Err(RegistryError::InvalidState(format!(
                    "replacement incarnation {incarnation_id} is not running for {soul_id}"
                )));
            }
            let queued: Option<(String, Vec<u8>)> = tx
                .query_row(
                    "SELECT request_id,protected_payload FROM input_commands WHERE soul_id=?1 AND state='queued' ORDER BY created_at,request_id LIMIT 1",
                    params![soul_id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let Some((request_raw, payload)) = queued else {
                tx.commit()?;
                return Ok(None);
            };
            let request_id = RequestId::parse(request_raw)
                .map_err(|_| RegistryError::Integrity("invalid queued request id".into()))?;
            let data = String::from_utf8(payload)
                .map_err(|_| RegistryError::Integrity("queued terminal input is not UTF-8".into()))?;
            let changed = tx.execute(
                "UPDATE input_commands SET incarnation_id=?1,state='dispatching',updated_at=?2 WHERE soul_id=?3 AND request_id=?4 AND state='queued'",
                params![incarnation_id.as_str(), now_millis(), soul_id.as_str(), request_id.as_str()],
            )?;
            if changed != 1 {
                return Err(RegistryError::InvalidState(
                    "queued input changed during replacement claim".into(),
                ));
            }
            tx.commit()?;
            Ok(Some(QueuedInput { request_id, data }))
        })
        .await
    }

    async fn set_input_state(
        &self,
        soul_id: SoulId,
        request_id: RequestId,
        state: &'static str,
    ) -> Result<(), RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let changed = tx.execute(
                "UPDATE input_commands SET state=?1,updated_at=?2 WHERE soul_id=?3 AND request_id=?4",
                params![state, now_millis(), soul_id.as_str(), request_id.as_str()],
            )?;
            if changed != 1 {
                return Err(RegistryError::InvalidState(format!(
                    "input command {} is not journaled",
                    request_id
                )));
            }
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn record_native_session(
        &self,
        soul_id: SoulId,
        incarnation_id: IncarnationId,
        native_session_id: String,
    ) -> Result<(), RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let (provider, store, existing, intent): (String, String, Option<String>, u64) = tx
                .query_row(
                    "SELECT provider,provider_store_id,native_session_id,intent_revision FROM souls WHERE soul_id=?1",
                    params![soul_id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()?
                .ok_or_else(|| RegistryError::UnknownSoul(soul_id.clone()))?;
            let owner: String = tx
                .query_row(
                    "SELECT soul_id FROM incarnations WHERE incarnation_id=?1",
                    params![incarnation_id.as_str()],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| RegistryError::UnknownIncarnation(incarnation_id.clone()))?;
            if owner != soul_id.as_str() || existing.as_deref().is_some_and(|id| id != native_session_id) {
                return Err(RegistryError::NativeIdentityConflict);
            }
            let now = now_millis();
            tx.execute(
                "UPDATE souls SET native_session_id=?1,allocation_state=CASE WHEN allocation_state='verified_durable' THEN allocation_state ELSE 'materializing' END,updated_at=?2 WHERE soul_id=?3",
                params![native_session_id, now, soul_id.as_str()],
            )?;
            let existing_claim: Option<String> = tx
                .query_row(
                    "SELECT incarnation_id FROM writer_claims WHERE provider=?1 AND provider_store_id=?2 AND native_session_id=?3",
                    params![provider, store, native_session_id],
                    |row| row.get(0),
                )
                .optional()?;
            match existing_claim {
                Some(claim) if claim == incarnation_id.as_str() => {}
                Some(_) => return Err(RegistryError::NativeIdentityConflict),
                None => {
                    tx.execute(
                        "INSERT INTO writer_claims (provider,provider_store_id,native_session_id,soul_id,incarnation_id,intent_revision) VALUES (?1,?2,?3,?4,?5,?6)",
                        params![provider, store, native_session_id, soul_id.as_str(), incarnation_id.as_str(), intent],
                    )?;
                }
            }
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn store_verified_resume_spec(
        &self,
        soul_id: SoulId,
        mut resume_spec: ResumeSpec,
    ) -> Result<ResumeSpec, RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let (provider, store, native, evidence, existing): (
                String,
                String,
                Option<String>,
                u64,
                Option<String>,
            ) = tx
                .query_row(
                    "SELECT provider,provider_store_id,native_session_id,evidence_revision,resume_spec FROM souls WHERE soul_id=?1",
                    params![soul_id.as_str()],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )
                .optional()?
                .ok_or_else(|| RegistryError::UnknownSoul(soul_id.clone()))?;
            if provider != resume_spec.provider_session.provider
                || store != resume_spec.provider_session.provider_store_id
                || native.as_deref() != Some(resume_spec.provider_session.native_session_id.as_str())
            {
                return Err(RegistryError::NativeIdentityConflict);
            }
            if let Some(existing) = existing {
                let existing: ResumeSpec = serde_json::from_str(&existing)?;
                if existing.provider_session == resume_spec.provider_session
                    && existing.program == resume_spec.program
                    && existing.cwd == resume_spec.cwd
                    && existing.workspace_path == resume_spec.workspace_path
                    && existing.checkpoint_revision == resume_spec.checkpoint_revision
                    && existing.checkpoint_references == resume_spec.checkpoint_references
                    && existing.durable_position == resume_spec.durable_position
                {
                    tx.commit()?;
                    return Ok(existing);
                }
            }
            let next_evidence = evidence
                .checked_add(1)
                .ok_or_else(|| RegistryError::Integrity("evidence revision overflow".into()))?;
            resume_spec.evidence_revision = next_evidence;
            resume_spec.allocation_state = AllocationState::VerifiedDurable;
            let encoded = serde_json::to_string(&resume_spec)?;
            let durability_state = if resume_spec.checkpoint_revision > 0 {
                "checkpoint_captured"
            } else {
                "resume_captured"
            };
            tx.execute(
                "UPDATE souls SET resume_spec=?1,evidence_revision=?2,allocation_state='verified_durable',durability_state=?3,checkpoint_revision=?4,updated_at=?5 WHERE soul_id=?6",
                params![
                    encoded,
                    next_evidence,
                    durability_state,
                    resume_spec.checkpoint_revision,
                    now_millis(),
                    soul_id.as_str()
                ],
            )?;
            tx.commit()?;
            Ok(resume_spec)
        })
        .await
    }

    pub async fn recovery_context(
        &self,
        soul_id: SoulId,
    ) -> Result<RecoveryContext, RegistryError> {
        let installation = self.installation_id().clone();
        self.run_blocking(move |conn| load_recovery_context(&conn, installation, &soul_id))
            .await
    }

    /// Retire a recovery replacement that never acquired a protected Docker
    /// identity. A crash after `create_stopped` but before the container-id
    /// commit may leave an unregistered stopped Docker object; the supervisor
    /// must not infer authority over it. The protected PREPARED row can be
    /// retired because no execution grant could have existed, allowing a new
    /// exact-owned replacement attempt while preserving the forensic row.
    pub async fn retire_unowned_prepared_replacement(
        &self,
        soul_id: SoulId,
    ) -> Result<bool, RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let candidate: Option<(String, Option<String>)> = tx
                .query_row(
                    "SELECT incarnation_id,recovery_attempt_id FROM incarnations                      WHERE soul_id=?1 AND launch_state='prepared'                        AND prior_incarnation_id IS NOT NULL                        AND docker_daemon_id IS NULL AND container_id IS NULL                      ORDER BY created_at DESC LIMIT 1",
                    params![soul_id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let Some((incarnation_raw, attempt_raw)) = candidate else {
                tx.commit()?;
                return Ok(false);
            };
            let incarnation_id = IncarnationId::parse(incarnation_raw)
                .map_err(|_| RegistryError::Integrity("invalid incarnation id".into()))?;
            let now = now_millis();
            let changed = tx.execute(
                "UPDATE incarnations SET launch_state='failed',cleanup_state='termination_unconfirmed',updated_at=?1                  WHERE incarnation_id=?2 AND launch_state='prepared'                    AND docker_daemon_id IS NULL AND container_id IS NULL",
                params![now, incarnation_id.as_str()],
            )?;
            if changed != 1 {
                return Err(RegistryError::InvalidState(
                    "interrupted PREPARED replacement changed during retirement".into(),
                ));
            }
            // No provider could have executed without a committed container
            // identity and execution grant, so these provisional claims may be
            // released. The failed incarnation row itself remains forensics.
            tx.execute(
                "DELETE FROM writer_claims WHERE incarnation_id=?1",
                params![incarnation_id.as_str()],
            )?;
            tx.execute(
                "DELETE FROM admission_reservations WHERE incarnation_id=?1",
                params![incarnation_id.as_str()],
            )?;
            if let Some(attempt_id) = attempt_raw.as_deref() {
                tx.execute(
                    "UPDATE recovery_attempts SET verdict='interrupted_before_ownership_commit',evidence_ref='unregistered_stopped_object_quarantined',finished_at=?1                      WHERE attempt_id=?2 AND finished_at IS NULL",
                    params![now, attempt_id],
                )?;
            }
            tx.execute(
                "UPDATE souls SET recovery_state='blocked',recovery_reason='INTERRUPTED_BEFORE_OWNERSHIP_COMMIT',recovery_attempt_id=NULL,updated_at=?1                  WHERE soul_id=?2 AND recovery_state='recovering'",
                params![now, soul_id.as_str()],
            )?;
            tx.commit()?;
            Ok(true)
        })
        .await
    }

    pub async fn begin_recovery(
        &self,
        soul_id: SoulId,
        trigger: RecoveryTrigger,
        path: RecoveryPath,
    ) -> Result<RecoveryStart, RegistryError> {
        let installation = self.installation_id().clone();
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let context = load_recovery_context(&tx, installation, &soul_id)?;
            if context.desired_state == DesiredState::Stopped {
                return Err(RegistryError::RecoveryBlocked {
                    soul_id,
                    reason: "STOP_INTENT".into(),
                });
            }
            if context.recovery_state == RecoveryState::Recovering {
                return Err(RegistryError::RecoveryInProgress(soul_id));
            }
            let now = now_millis();
            let budget_available = freshell_agent_runtime::successful_recovery_budget_available(
                context.recovery_window_started_at,
                context.successful_recoveries_in_window,
                now,
            );
            if !budget_available && trigger != RecoveryTrigger::ManualRetry {
                let reason = "BLOCKED_RETRY_BUDGET";
                tx.execute(
                    "UPDATE souls SET recovery_state='blocked',recovery_reason=?1,updated_at=?2 WHERE soul_id=?3",
                    params![reason, now, context.soul_id.as_str()],
                )?;
                tx.commit()?;
                return Err(RegistryError::RecoveryBlocked {
                    soul_id: context.soul_id,
                    reason: reason.into(),
                });
            }
            if !budget_available && trigger == RecoveryTrigger::ManualRetry {
                // A deliberate user retry is the explicit rearm operation. It
                // clears the persisted flap window but keeps identity/history
                // intact and still runs through the same fenced transaction.
                tx.execute(
                    "UPDATE souls SET recovery_window_started_at=?1,successful_recoveries_in_window=0,updated_at=?1 WHERE soul_id=?2",
                    params![now, context.soul_id.as_str()],
                )?;
            }
            let attempt_id = RecoveryAttemptId::new();
            let trigger_name = recovery_trigger_name(trigger);
            tx.execute(
                "UPDATE souls SET recovery_state='recovering',recovery_reason=?1,recovery_attempt_id=?2,updated_at=?3 WHERE soul_id=?4 AND desired_state='running' AND intent_revision=?5",
                params![trigger_name, attempt_id.as_str(), now, context.soul_id.as_str(), context.intent_revision],
            )?;
            tx.execute(
                "UPDATE incarnations SET launch_state='stopping',cleanup_state='requested',recovery_attempt_id=?1,updated_at=?2 WHERE incarnation_id=?3 AND launch_state IN ('created','starting','running')",
                params![attempt_id.as_str(), now, context.prior_handle.incarnation_id().as_str()],
            )?;
            tx.execute(
                "UPDATE input_commands SET state='ambiguous',updated_at=?1 WHERE soul_id=?2 AND state='dispatching'",
                params![now, context.soul_id.as_str()],
            )?;
            tx.execute(
                "INSERT INTO recovery_attempts (attempt_id,soul_id,prior_incarnation_id,intent_revision,path,verdict,evidence_ref,started_at,finished_at) VALUES (?1,?2,?3,?4,?5,'started',NULL,?6,NULL)",
                params![attempt_id.as_str(), context.soul_id.as_str(), context.prior_handle.incarnation_id().as_str(), context.intent_revision, recovery_path_name(path), now],
            )?;
            tx.commit()?;
            Ok(RecoveryStart { attempt_id, context })
        })
        .await
    }

    pub async fn prepare_replacement(
        &self,
        start: RecoveryStart,
        terminal: Option<TerminalLaunchSpec>,
        resume_spec: Option<ResumeSpec>,
        path: RecoveryPath,
    ) -> Result<ReplacementPreparation, RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let (desired, intent, recovery_attempt): (String, u64, Option<String>) = tx
                .query_row(
                    "SELECT desired_state,intent_revision,recovery_attempt_id FROM souls WHERE soul_id=?1",
                    params![start.context.soul_id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
            if desired != "running"
                || intent != start.context.intent_revision
                || recovery_attempt.as_deref() != Some(start.attempt_id.as_str())
            {
                return Err(RegistryError::RecoveryBlocked {
                    soul_id: start.context.soul_id,
                    reason: "STOP_INTENT_OR_STALE_ATTEMPT".into(),
                });
            }
            let (old_state, old_cleanup): (String, String) = tx.query_row(
                "SELECT launch_state,cleanup_state FROM incarnations WHERE incarnation_id=?1",
                params![start.context.prior_handle.incarnation_id().as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if old_state != "stopped" || old_cleanup != "verified_empty" {
                return Err(RegistryError::RecoveryBlocked {
                    soul_id: start.context.soul_id,
                    reason: "OLD_RUNTIME_NOT_VERIFIED_EMPTY".into(),
                });
            }
            let active: Option<String> = tx
                .query_row(
                    &format!("SELECT incarnation_id FROM incarnations WHERE soul_id=?1 AND launch_state IN ({ACTIVE_STATES}) LIMIT 1"),
                    params![start.context.soul_id.as_str()],
                    |row| row.get(0),
                )
                .optional()?;
            if active.is_some() {
                return Err(RegistryError::ActiveIncarnation(start.context.soul_id));
            }
            let now = now_millis();
            let incarnation_id = IncarnationId::new();
            let launch_nonce = LaunchNonce::new();
            let limits_json = serde_json::to_string(&start.context.requested_limits)?;
            let terminal_json = terminal.as_ref().map(serde_json::to_string).transpose()?;
            let terminal_id = terminal.as_ref().map(|value| value.terminal_id.as_str());
            let fixture_kind = start.context.fixture.map(fixture_kind_name);
            tx.execute(
                "INSERT INTO incarnations (incarnation_id,soul_id,launch_nonce,docker_daemon_id,container_id,image_ref,runtime_dir,host_binary_path,immutable_config_digest,launch_state,host_boot_id,execution_generation,grant_id,requested_limits,effective_limits,cleanup_state,fixture_kind,terminal_id,terminal_spec,prior_incarnation_id,recovery_attempt_id,exit_code,oom_killed,created_at,updated_at) VALUES (?1,?2,?3,NULL,NULL,NULL,NULL,NULL,NULL,'prepared',NULL,0,NULL,?4,NULL,'none',?5,?6,?7,?8,?9,NULL,0,?10,?10)",
                params![incarnation_id.as_str(), start.context.soul_id.as_str(), launch_nonce.as_str(), limits_json, fixture_kind, terminal_id, terminal_json, start.context.prior_handle.incarnation_id().as_str(), start.attempt_id.as_str(), now],
            )?;
            tx.execute(
                "INSERT INTO admission_reservations (incarnation_id,project_key,cpu_milli,memory_bytes,pids_max,created_at) VALUES (?1,?2,?3,?4,?5,?6)",
                params![incarnation_id.as_str(), start.context.project_key, start.context.requested_limits.cpu_milli, start.context.requested_limits.memory_bytes, start.context.requested_limits.pids_max, now],
            )?;
            if let Some(spec) = resume_spec.as_ref() {
                tx.execute(
                    "INSERT INTO writer_claims (provider,provider_store_id,native_session_id,soul_id,incarnation_id,intent_revision) VALUES (?1,?2,?3,?4,?5,?6)",
                    params![spec.provider_session.provider, spec.provider_session.provider_store_id, spec.provider_session.native_session_id, start.context.soul_id.as_str(), incarnation_id.as_str(), start.context.intent_revision],
                )?;
            }
            tx.execute(
                "UPDATE recovery_attempts SET path=?1,verdict='replacement_prepared' WHERE attempt_id=?2",
                params![recovery_path_name(path), start.attempt_id.as_str()],
            )?;
            tx.commit()?;
            Ok(ReplacementPreparation {
                prepared: PreparedLaunch {
                    soul_id: start.context.soul_id,
                    incarnation_id,
                    launch_nonce,
                    state: LaunchState::Prepared,
                    intent_revision: start.context.intent_revision,
                    existing_request: false,
                },
                fixture: start.context.fixture,
                terminal,
                resume_spec,
                prior_incarnation_id: start.context.prior_handle.incarnation_id().clone(),
                attempt_id: start.attempt_id,
            })
        })
        .await
    }

    pub async fn mark_recovery_live(
        &self,
        soul_id: SoulId,
        incarnation_id: IncarnationId,
    ) -> Result<(), RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let running: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM incarnations i JOIN souls s ON s.soul_id=i.soul_id WHERE i.incarnation_id=?1 AND i.soul_id=?2 AND i.launch_state='running' AND s.desired_state='running')",
                    params![incarnation_id.as_str(), soul_id.as_str()],
                    |row| row.get(0),
                )?;
            if !running {
                return Err(RegistryError::RecoveryBlocked {
                    soul_id,
                    reason: "STOP_INTENT_OR_STALE_INCARNATION".into(),
                });
            }
            tx.execute(
                "UPDATE souls SET recovery_state='live',recovery_reason=NULL,recovery_attempt_id=NULL,updated_at=?1 WHERE soul_id=?2 AND desired_state='running'",
                params![now_millis(), soul_id.as_str()],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn mark_recovery_success(
        &self,
        soul_id: SoulId,
        incarnation_id: IncarnationId,
        attempt_id: RecoveryAttemptId,
    ) -> Result<(), RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now = now_millis();
            let (desired, current_attempt, window_start, successes): (
                String,
                Option<String>,
                Option<i64>,
                u64,
            ) = tx.query_row(
                "SELECT desired_state,recovery_attempt_id,recovery_window_started_at,successful_recoveries_in_window FROM souls WHERE soul_id=?1",
                params![soul_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            if desired != "running" || current_attempt.as_deref() != Some(attempt_id.as_str()) {
                return Err(RegistryError::RecoveryBlocked {
                    soul_id,
                    reason: "STOP_INTENT_OR_STALE_ATTEMPT".into(),
                });
            }
            let running: bool = tx.query_row(
                "SELECT launch_state='running' FROM incarnations WHERE incarnation_id=?1 AND soul_id=?2",
                params![incarnation_id.as_str(), soul_id.as_str()],
                |row| row.get(0),
            )?;
            if !running {
                return Err(RegistryError::InvalidState(
                    "replacement is not RUNNING".into(),
                ));
            }
            let (next_window, next_successes) = match window_start {
                Some(started)
                    if now.saturating_sub(started)
                        < freshell_agent_runtime::RECOVERY_WINDOW_MS =>
                {
                    (started, successes.saturating_add(1))
                }
                _ => (now, 1),
            };
            tx.execute(
                "UPDATE souls SET recovery_state='live',recovery_reason=NULL,recovery_attempt_id=NULL,recovery_window_started_at=?1,successful_recoveries_in_window=?2,updated_at=?3 WHERE soul_id=?4",
                params![next_window, next_successes, now, soul_id.as_str()],
            )?;
            tx.execute(
                "UPDATE recovery_attempts SET verdict='succeeded',finished_at=?1 WHERE attempt_id=?2",
                params![now, attempt_id.as_str()],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn mark_recovery_blocked(
        &self,
        soul_id: SoulId,
        attempt_id: Option<RecoveryAttemptId>,
        reason: RecoveryBlockReason,
        evidence: Vec<String>,
    ) -> Result<(), RegistryError> {
        self.finish_recovery_verdict(
            soul_id,
            attempt_id,
            RecoveryState::Blocked,
            recovery_block_reason_name(reason),
            evidence,
        )
        .await
    }

    pub async fn mark_recovery_lost(
        &self,
        soul_id: SoulId,
        attempt_id: Option<RecoveryAttemptId>,
        reason: String,
        evidence: Vec<String>,
    ) -> Result<(), RegistryError> {
        self.finish_recovery_verdict(soul_id, attempt_id, RecoveryState::Lost, reason, evidence)
            .await
    }

    async fn finish_recovery_verdict(
        &self,
        soul_id: SoulId,
        attempt_id: Option<RecoveryAttemptId>,
        state: RecoveryState,
        reason: String,
        evidence: Vec<String>,
    ) -> Result<(), RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now = now_millis();
            let state_name = recovery_state_name(state);
            tx.execute(
                "UPDATE souls SET recovery_state=?1,recovery_reason=?2,recovery_attempt_id=NULL,updated_at=?3 WHERE soul_id=?4 AND desired_state='running'",
                params![state_name, reason, now, soul_id.as_str()],
            )?;
            if let Some(attempt_id) = attempt_id {
                tx.execute(
                    "UPDATE recovery_attempts SET verdict=?1,evidence_ref=?2,finished_at=?3 WHERE attempt_id=?4",
                    params![state_name, serde_json::to_string(&evidence)?, now, attempt_id.as_str()],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn inventory(&self) -> Result<Vec<RuntimeView>, RegistryError> {
        self.run_blocking(move |conn| load_inventory(&conn)).await
    }

    pub async fn debug_snapshot(&self) -> Result<RegistryDebugSnapshot, RegistryError> {
        Ok(RegistryDebugSnapshot {
            installation_id: self.installation_id().clone(),
            control_epoch: self.control_epoch(),
            views: self.inventory().await?,
        })
    }

    pub(crate) async fn run_blocking<T, F>(&self, f: F) -> Result<T, RegistryError>
    where
        T: Send + 'static,
        F: FnOnce(Connection) -> Result<T, RegistryError> + Send + 'static,
    {
        let path = self.inner.db_path.clone();
        tokio::task::spawn_blocking(move || {
            let conn = open_connection(&path)?;
            f(conn)
        })
        .await
        .map_err(|e| RegistryError::Join(e.to_string()))?
    }
}

pub(crate) fn open_connection(path: &Path) -> Result<Connection, RegistryError> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(conn)
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool, RegistryError> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        params![table],
        |row| row.get(0),
    )?)
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, RegistryError> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    for candidate in columns {
        if candidate? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn reservation_totals(
    conn: &Connection,
    project_key: Option<&str>,
) -> Result<ReservationTotals, RegistryError> {
    let query = if project_key.is_some() {
        "SELECT COALESCE(SUM(cpu_milli),0),COALESCE(SUM(memory_bytes),0),COALESCE(SUM(pids_max),0) FROM admission_reservations WHERE project_key=?1"
    } else {
        "SELECT COALESCE(SUM(cpu_milli),0),COALESCE(SUM(memory_bytes),0),COALESCE(SUM(pids_max),0) FROM admission_reservations"
    };
    let row: (u64, u64, u64) = match project_key {
        Some(project) => conn.query_row(query, params![project], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?,
        None => conn.query_row(query, [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?,
    };
    Ok(ReservationTotals {
        cpu_milli: row.0,
        memory_bytes: row.1,
        pids_max: row.2,
    })
}

fn recovery_trigger_name(trigger: RecoveryTrigger) -> &'static str {
    match trigger {
        RecoveryTrigger::ProviderExit => "provider_exit",
        RecoveryTrigger::HostUnreachable => "host_unreachable",
        RecoveryTrigger::StartupReconcile => "startup_reconcile",
        RecoveryTrigger::ManualRetry => "manual_retry",
        RecoveryTrigger::RetryExhausted => "retry_exhausted",
        RecoveryTrigger::ExplicitRequest => "explicit_request",
    }
}

fn recovery_path_name(path: RecoveryPath) -> &'static str {
    match path {
        RecoveryPath::Reattach => "reattach",
        RecoveryPath::NativeResume => "native_resume",
        RecoveryPath::CheckpointRestore => "checkpoint_restore",
        RecoveryPath::PristineSeed => "pristine_seed",
        RecoveryPath::NativeImport => "native_import",
    }
}

fn recovery_state_name(state: RecoveryState) -> &'static str {
    match state {
        RecoveryState::Live => "live",
        RecoveryState::Recovering => "recovering",
        RecoveryState::Blocked => "blocked",
        RecoveryState::Lost => "lost",
        RecoveryState::Stopped => "stopped",
    }
}

fn recovery_block_reason_name(reason: RecoveryBlockReason) -> String {
    serde_json::to_value(reason)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "RECOVERY_BLOCKED".into())
}

fn fixture_kind_name(fixture: FixtureKind) -> &'static str {
    match fixture {
        FixtureKind::Heartbeat => "heartbeat",
        FixtureKind::DescendantSpawner => "descendant_spawner",
        FixtureKind::CpuBurner => "cpu_burner",
        FixtureKind::MemoryAllocator => "memory_allocator",
        FixtureKind::NativeSession => "native_session",
        FixtureKind::SecurityProbe => "security_probe",
    }
}

fn parse_fixture_kind(value: &str) -> Result<FixtureKind, RegistryError> {
    match value {
        "heartbeat" => Ok(FixtureKind::Heartbeat),
        "descendant_spawner" => Ok(FixtureKind::DescendantSpawner),
        "cpu_burner" => Ok(FixtureKind::CpuBurner),
        "memory_allocator" => Ok(FixtureKind::MemoryAllocator),
        "native_session" => Ok(FixtureKind::NativeSession),
        "security_probe" => Ok(FixtureKind::SecurityProbe),
        other => Err(RegistryError::Integrity(format!(
            "unknown fixture kind {other}"
        ))),
    }
}

fn runtime_profile_name(profile: RuntimeProfile) -> &'static str {
    match profile {
        RuntimeProfile::DefaultAgent => "default_agent",
        RuntimeProfile::TestFixture => "test_fixture",
        RuntimeProfile::Custom => "custom",
    }
}

fn parse_runtime_profile(value: &str) -> Result<RuntimeProfile, RegistryError> {
    match value {
        "default_agent" => Ok(RuntimeProfile::DefaultAgent),
        "test_fixture" => Ok(RuntimeProfile::TestFixture),
        "custom" => Ok(RuntimeProfile::Custom),
        other => Err(RegistryError::Integrity(format!(
            "unknown runtime profile {other}"
        ))),
    }
}

pub fn stable_provider_volume_name(installation: &InstallationId, soul: &SoulId) -> String {
    let digest = Sha256::digest(format!("{}\0{}", installation.as_str(), soul.as_str()).as_bytes());
    format!("freshell-provider-{digest:x}")[..42].to_string()
}

fn create_schema(
    conn: &mut Connection,
    installation_id: InstallationId,
) -> Result<(), RegistryError> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch(&format!(r#"
        CREATE TABLE installation (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            installation_id TEXT NOT NULL,
            schema_version INTEGER NOT NULL,
            control_epoch INTEGER NOT NULL,
            inventory_revision INTEGER NOT NULL DEFAULT 0,
            initial_scan_state TEXT NOT NULL DEFAULT 'pending',
            initial_scan_error TEXT,
            initial_scan_started_at INTEGER,
            initial_scan_finished_at INTEGER,
            initial_scan_peak_concurrency INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE souls (
            soul_id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            provider_store_id TEXT NOT NULL,
            native_session_id TEXT,
            creation_seed_ref TEXT NOT NULL,
            desired_state TEXT NOT NULL,
            intent_revision INTEGER NOT NULL,
            recovery_state TEXT NOT NULL,
            recovery_reason TEXT,
            recovery_attempt_id TEXT,
            durability_state TEXT NOT NULL,
            allocation_state TEXT NOT NULL,
            resume_spec TEXT,
            checkpoint_revision INTEGER NOT NULL,
            evidence_revision INTEGER NOT NULL,
            recovery_window_started_at INTEGER,
            successful_recoveries_in_window INTEGER NOT NULL,
            project_key TEXT NOT NULL,
            resource_profile TEXT NOT NULL,
            provider_volume_name TEXT NOT NULL,
            configured_limits TEXT,
            loss_incident_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE incarnations (
            incarnation_id TEXT PRIMARY KEY,
            soul_id TEXT NOT NULL REFERENCES souls(soul_id),
            launch_nonce TEXT NOT NULL UNIQUE,
            docker_daemon_id TEXT,
            container_id TEXT,
            image_ref TEXT,
            runtime_dir TEXT,
            host_binary_path TEXT,
            immutable_config_digest TEXT,
            launch_state TEXT NOT NULL,
            host_boot_id TEXT,
            execution_generation INTEGER NOT NULL,
            grant_id TEXT,
            requested_limits TEXT NOT NULL,
            effective_limits TEXT,
            cleanup_state TEXT NOT NULL,
            fixture_kind TEXT,
            terminal_id TEXT,
            terminal_spec TEXT,
            prior_incarnation_id TEXT,
            recovery_attempt_id TEXT,
            exit_code INTEGER,
            oom_killed INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX incarnation_container_identity ON incarnations(docker_daemon_id, container_id) WHERE container_id IS NOT NULL;
        CREATE UNIQUE INDEX one_active_incarnation_per_soul ON incarnations(soul_id) WHERE launch_state IN ({ACTIVE_STATES});
        CREATE TABLE writer_claims (
            claim_id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider TEXT NOT NULL,
            provider_store_id TEXT NOT NULL,
            native_session_id TEXT,
            soul_id TEXT NOT NULL REFERENCES souls(soul_id),
            incarnation_id TEXT NOT NULL REFERENCES incarnations(incarnation_id),
            intent_revision INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX one_native_writer ON writer_claims(provider,provider_store_id,native_session_id) WHERE native_session_id IS NOT NULL;
        CREATE TABLE commands (
            soul_id TEXT NOT NULL REFERENCES souls(soul_id),
            request_id TEXT NOT NULL,
            payload_digest TEXT NOT NULL,
            protected_payload_ref TEXT,
            state TEXT NOT NULL,
            provider_ack_id TEXT,
            incarnation_id TEXT NOT NULL REFERENCES incarnations(incarnation_id),
            event_cursor INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(soul_id, request_id)
        );
        CREATE TABLE input_commands (
            soul_id TEXT NOT NULL REFERENCES souls(soul_id),
            request_id TEXT NOT NULL,
            payload_digest TEXT NOT NULL,
            protected_payload BLOB NOT NULL,
            incarnation_id TEXT NOT NULL REFERENCES incarnations(incarnation_id),
            state TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(soul_id, request_id)
        );
        CREATE TABLE recovery_attempts (
            attempt_id TEXT PRIMARY KEY,
            soul_id TEXT NOT NULL REFERENCES souls(soul_id),
            prior_incarnation_id TEXT,
            intent_revision INTEGER NOT NULL,
            path TEXT NOT NULL,
            verdict TEXT NOT NULL,
            evidence_ref TEXT,
            started_at INTEGER NOT NULL,
            finished_at INTEGER
        );
        CREATE TABLE view_intents (
            view_id TEXT PRIMARY KEY,
            soul_id TEXT NOT NULL REFERENCES souls(soul_id),
            owner_id TEXT NOT NULL,
            workspace_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            preferred_tab_id TEXT NOT NULL,
            preferred_pane_id TEXT NOT NULL,
            title TEXT NOT NULL,
            placement_group TEXT NOT NULL,
            visibility TEXT NOT NULL,
            revision INTEGER NOT NULL,
            soul_intent_revision INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX one_automatic_primary_view_per_soul ON view_intents(owner_id,workspace_id,soul_id) WHERE kind='automatic_primary';
        CREATE TABLE outbox (
            event_id TEXT PRIMARY KEY,
            event_kind TEXT NOT NULL,
            payload TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            delivered_at INTEGER
        );
        CREATE TABLE loss_incidents (
            incident_id TEXT PRIMARY KEY,
            correlation_id TEXT NOT NULL,
            soul_id TEXT NOT NULL REFERENCES souls(soul_id),
            incarnation_id TEXT NOT NULL REFERENCES incarnations(incarnation_id),
            provider TEXT NOT NULL,
            provider_store_id TEXT NOT NULL,
            native_session_ref_hash TEXT NOT NULL,
            intent_revision INTEGER NOT NULL,
            decision_state TEXT NOT NULL,
            reason_code TEXT NOT NULL,
            certificate_json TEXT NOT NULL,
            cleanup_state TEXT NOT NULL,
            cleanup_json TEXT NOT NULL,
            observed_cause TEXT NOT NULL,
            missing_invariant TEXT NOT NULL,
            hypotheses_json TEXT NOT NULL,
            preventive_action TEXT NOT NULL,
            regression_case TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            closed_at INTEGER
        );
        CREATE UNIQUE INDEX one_loss_incident_per_soul_revision ON loss_incidents(soul_id,intent_revision);
        CREATE TABLE runtime_notices (
            notice_id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            message TEXT NOT NULL,
            reference TEXT NOT NULL,
            incident_ids_json TEXT NOT NULL,
            superseded_by TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE notice_receipts (
            notice_id TEXT NOT NULL REFERENCES runtime_notices(notice_id),
            profile_id TEXT NOT NULL,
            state TEXT NOT NULL,
            rendered_at INTEGER,
            acknowledged_at INTEGER,
            dismissed_at INTEGER,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(notice_id,profile_id)
        );
        CREATE TABLE runtime_counters (
            name TEXT NOT NULL,
            label TEXT NOT NULL,
            value INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(name,label)
        );
        CREATE TABLE rollout_state (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            mode TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE migration_runs (
            migration_id TEXT PRIMARY KEY,
            current_mode TEXT NOT NULL,
            requested_mode TEXT NOT NULL,
            dry_run INTEGER NOT NULL,
            plan_json TEXT NOT NULL,
            backup_path TEXT,
            applied_at INTEGER,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE repair_audits (
            audit_id TEXT PRIMARY KEY,
            audit_json TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE stop_tombstones (
            soul_id TEXT NOT NULL REFERENCES souls(soul_id),
            intent_revision INTEGER NOT NULL,
            actor TEXT NOT NULL,
            reason TEXT NOT NULL,
            committed_at INTEGER NOT NULL,
            PRIMARY KEY(soul_id, intent_revision)
        );
        CREATE TABLE admission_reservations (
            incarnation_id TEXT PRIMARY KEY REFERENCES incarnations(incarnation_id),
            project_key TEXT NOT NULL,
            cpu_milli INTEGER NOT NULL,
            memory_bytes INTEGER NOT NULL,
            pids_max INTEGER NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TRIGGER souls_inventory_insert AFTER INSERT ON souls BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
        CREATE TRIGGER souls_inventory_update AFTER UPDATE ON souls BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
        CREATE TRIGGER souls_inventory_delete AFTER DELETE ON souls BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
        CREATE TRIGGER incarnations_inventory_insert AFTER INSERT ON incarnations BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
        CREATE TRIGGER incarnations_inventory_update AFTER UPDATE ON incarnations BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
        CREATE TRIGGER incarnations_inventory_delete AFTER DELETE ON incarnations BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
        CREATE TRIGGER view_intents_inventory_insert AFTER INSERT ON view_intents BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
        CREATE TRIGGER view_intents_inventory_update AFTER UPDATE ON view_intents BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
        CREATE TRIGGER view_intents_inventory_delete AFTER DELETE ON view_intents BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
    "#))?;
    tx.execute("INSERT INTO installation (singleton,installation_id,schema_version,control_epoch,inventory_revision,initial_scan_state) VALUES (1,?1,?2,0,0,'pending')", params![installation_id.as_str(), SCHEMA_VERSION])?;
    tx.execute(
        "INSERT INTO rollout_state (singleton,mode,updated_at) VALUES (1,'legacy',?1)",
        params![now_millis()],
    )?;
    tx.commit()?;
    durable_sync_parent(conn.path().map(Path::new).and_then(Path::parent))?;
    Ok(())
}

fn migrate_schema(conn: &mut Connection) -> Result<(), RegistryError> {
    let mut schema: u32 = conn.query_row(
        "SELECT schema_version FROM installation WHERE singleton=1",
        [],
        |row| row.get(0),
    )?;
    if schema > SCHEMA_VERSION {
        return Err(RegistryError::NewerSchema {
            found: schema,
            supported: SCHEMA_VERSION,
        });
    }
    if schema == 1 {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(
            r#"
            ALTER TABLE souls ADD COLUMN project_key TEXT NOT NULL DEFAULT 'default';
            ALTER TABLE souls ADD COLUMN resource_profile TEXT NOT NULL DEFAULT 'custom';
            ALTER TABLE souls ADD COLUMN provider_volume_name TEXT NOT NULL DEFAULT '';
            ALTER TABLE incarnations ADD COLUMN terminal_id TEXT;
            ALTER TABLE incarnations ADD COLUMN terminal_spec TEXT;
            CREATE TABLE admission_reservations (
                incarnation_id TEXT PRIMARY KEY REFERENCES incarnations(incarnation_id),
                project_key TEXT NOT NULL,
                cpu_milli INTEGER NOT NULL,
                memory_bytes INTEGER NOT NULL,
                pids_max INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );
            UPDATE installation SET schema_version=2 WHERE singleton=1;
            "#,
        )?;
        tx.commit()?;
        schema = 2;
    }
    if schema == 2 {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(
            r#"
            ALTER TABLE souls ADD COLUMN recovery_reason TEXT;
            ALTER TABLE souls ADD COLUMN recovery_attempt_id TEXT;
            ALTER TABLE souls ADD COLUMN allocation_state TEXT NOT NULL DEFAULT 'allocated';
            ALTER TABLE souls ADD COLUMN resume_spec TEXT;
            ALTER TABLE souls ADD COLUMN evidence_revision INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE souls ADD COLUMN recovery_window_started_at INTEGER;
            ALTER TABLE souls ADD COLUMN successful_recoveries_in_window INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE incarnations ADD COLUMN fixture_kind TEXT;
            ALTER TABLE incarnations ADD COLUMN prior_incarnation_id TEXT;
            ALTER TABLE incarnations ADD COLUMN recovery_attempt_id TEXT;
            CREATE TABLE input_commands (
                soul_id TEXT NOT NULL REFERENCES souls(soul_id),
                request_id TEXT NOT NULL,
                payload_digest TEXT NOT NULL,
                incarnation_id TEXT NOT NULL REFERENCES incarnations(incarnation_id),
                state TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(soul_id, request_id)
            );
            UPDATE installation SET schema_version=3 WHERE singleton=1;
            "#,
        )?;
        tx.commit()?;
        schema = 3;
    }
    if schema == 3 {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(
            r#"
            ALTER TABLE input_commands ADD COLUMN protected_payload BLOB NOT NULL DEFAULT X'';
            UPDATE installation SET schema_version=4 WHERE singleton=1;
            "#,
        )?;
        tx.commit()?;
        schema = 4;
    }
    if schema == 4 {
        let add_inventory_revision = !column_exists(conn, "installation", "inventory_revision")?;
        let add_scan_state = !column_exists(conn, "installation", "initial_scan_state")?;
        let add_scan_error = !column_exists(conn, "installation", "initial_scan_error")?;
        let add_scan_started = !column_exists(conn, "installation", "initial_scan_started_at")?;
        let add_scan_finished = !column_exists(conn, "installation", "initial_scan_finished_at")?;
        let add_scan_peak = !column_exists(conn, "installation", "initial_scan_peak_concurrency")?;
        let add_configured_limits = !column_exists(conn, "souls", "configured_limits")?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if add_inventory_revision {
            tx.execute_batch(
                "ALTER TABLE installation ADD COLUMN inventory_revision INTEGER NOT NULL DEFAULT 0;",
            )?;
        }
        if add_scan_state {
            tx.execute_batch(
                "ALTER TABLE installation ADD COLUMN initial_scan_state TEXT NOT NULL DEFAULT 'pending';",
            )?;
        }
        if add_scan_error {
            tx.execute_batch("ALTER TABLE installation ADD COLUMN initial_scan_error TEXT;")?;
        }
        if add_scan_started {
            tx.execute_batch(
                "ALTER TABLE installation ADD COLUMN initial_scan_started_at INTEGER;",
            )?;
        }
        if add_scan_finished {
            tx.execute_batch(
                "ALTER TABLE installation ADD COLUMN initial_scan_finished_at INTEGER;",
            )?;
        }
        if add_scan_peak {
            tx.execute_batch(
                "ALTER TABLE installation ADD COLUMN initial_scan_peak_concurrency INTEGER NOT NULL DEFAULT 0;",
            )?;
        }
        if add_configured_limits {
            tx.execute_batch("ALTER TABLE souls ADD COLUMN configured_limits TEXT;")?;
        }
        tx.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS view_intents (
                view_id TEXT PRIMARY KEY,
                soul_id TEXT NOT NULL REFERENCES souls(soul_id),
                owner_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                preferred_tab_id TEXT NOT NULL,
                preferred_pane_id TEXT NOT NULL,
                title TEXT NOT NULL,
                placement_group TEXT NOT NULL,
                visibility TEXT NOT NULL,
                revision INTEGER NOT NULL,
                soul_intent_revision INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS one_automatic_primary_view_per_soul ON view_intents(owner_id,workspace_id,soul_id) WHERE kind='automatic_primary';
            CREATE TRIGGER IF NOT EXISTS souls_inventory_insert AFTER INSERT ON souls BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
            CREATE TRIGGER IF NOT EXISTS souls_inventory_update AFTER UPDATE ON souls BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
            CREATE TRIGGER IF NOT EXISTS souls_inventory_delete AFTER DELETE ON souls BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
            CREATE TRIGGER IF NOT EXISTS incarnations_inventory_insert AFTER INSERT ON incarnations BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
            CREATE TRIGGER IF NOT EXISTS incarnations_inventory_update AFTER UPDATE ON incarnations BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
            CREATE TRIGGER IF NOT EXISTS incarnations_inventory_delete AFTER DELETE ON incarnations BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
            CREATE TRIGGER IF NOT EXISTS view_intents_inventory_insert AFTER INSERT ON view_intents BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
            CREATE TRIGGER IF NOT EXISTS view_intents_inventory_update AFTER UPDATE ON view_intents BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
            CREATE TRIGGER IF NOT EXISTS view_intents_inventory_delete AFTER DELETE ON view_intents BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
            UPDATE souls SET configured_limits=(SELECT requested_limits FROM incarnations i WHERE i.soul_id=souls.soul_id ORDER BY i.created_at DESC LIMIT 1) WHERE configured_limits IS NULL;
            UPDATE installation SET schema_version=5,inventory_revision=inventory_revision+1 WHERE singleton=1;
            "#,
        )?;
        tx.commit()?;
        schema = 5;
    }
    if schema == 5 {
        let add_loss_incident_id = !column_exists(conn, "souls", "loss_incident_id")?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if add_loss_incident_id {
            tx.execute_batch("ALTER TABLE souls ADD COLUMN loss_incident_id TEXT;")?;
        }
        tx.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS loss_incidents (
                incident_id TEXT PRIMARY KEY,
                correlation_id TEXT NOT NULL,
                soul_id TEXT NOT NULL REFERENCES souls(soul_id),
                incarnation_id TEXT NOT NULL REFERENCES incarnations(incarnation_id),
                provider TEXT NOT NULL,
                provider_store_id TEXT NOT NULL,
                native_session_ref_hash TEXT NOT NULL,
                intent_revision INTEGER NOT NULL,
                decision_state TEXT NOT NULL,
                reason_code TEXT NOT NULL,
                certificate_json TEXT NOT NULL,
                cleanup_state TEXT NOT NULL,
                cleanup_json TEXT NOT NULL,
                observed_cause TEXT NOT NULL,
                missing_invariant TEXT NOT NULL,
                hypotheses_json TEXT NOT NULL,
                preventive_action TEXT NOT NULL,
                regression_case TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                closed_at INTEGER
            );
            CREATE UNIQUE INDEX IF NOT EXISTS one_loss_incident_per_soul_revision ON loss_incidents(soul_id,intent_revision);
            CREATE TABLE IF NOT EXISTS runtime_notices (
                notice_id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                message TEXT NOT NULL,
                reference TEXT NOT NULL,
                incident_ids_json TEXT NOT NULL,
                superseded_by TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS notice_receipts (
                notice_id TEXT NOT NULL REFERENCES runtime_notices(notice_id),
                profile_id TEXT NOT NULL,
                state TEXT NOT NULL,
                rendered_at INTEGER,
                acknowledged_at INTEGER,
                dismissed_at INTEGER,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(notice_id,profile_id)
            );
            CREATE TABLE IF NOT EXISTS runtime_counters (
                name TEXT NOT NULL,
                label TEXT NOT NULL,
                value INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(name,label)
            );
            CREATE TABLE IF NOT EXISTS rollout_state (
                singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                mode TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS migration_runs (
                migration_id TEXT PRIMARY KEY,
                current_mode TEXT NOT NULL,
                requested_mode TEXT NOT NULL,
                dry_run INTEGER NOT NULL,
                plan_json TEXT NOT NULL,
                backup_path TEXT,
                applied_at INTEGER,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS repair_audits (
                audit_id TEXT PRIMARY KEY,
                audit_json TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            INSERT OR IGNORE INTO rollout_state (singleton,mode,updated_at) VALUES (1,'legacy',0);
            UPDATE installation SET schema_version=6,inventory_revision=inventory_revision+1 WHERE singleton=1;
            "#,
        )?;
        tx.commit()?;
        schema = 6;
    }
    if schema != SCHEMA_VERSION {
        return Err(RegistryError::Integrity(format!(
            "unsupported older schema {schema}"
        )));
    }
    durable_sync_parent(conn.path().map(Path::new).and_then(Path::parent))?;
    Ok(())
}

fn verify_schema_and_integrity(conn: &Connection) -> Result<(), RegistryError> {
    let schema: u32 = conn.query_row(
        "SELECT schema_version FROM installation WHERE singleton=1",
        [],
        |row| row.get(0),
    )?;
    if schema > SCHEMA_VERSION {
        return Err(RegistryError::NewerSchema {
            found: schema,
            supported: SCHEMA_VERSION,
        });
    }
    if schema != SCHEMA_VERSION {
        return Err(RegistryError::Integrity(format!(
            "unsupported older schema {schema}; migration missing"
        )));
    }
    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(RegistryError::Integrity(integrity));
    }
    Ok(())
}

fn load_prepared_row(
    conn: &Connection,
    incarnation_id: &IncarnationId,
) -> Result<PreparedLaunch, RegistryError> {
    let raw: (String, String, String, u64) = conn.query_row(
        "SELECT i.soul_id,i.launch_nonce,i.launch_state,s.intent_revision FROM incarnations i JOIN souls s ON s.soul_id=i.soul_id WHERE i.incarnation_id=?1",
        params![incarnation_id.as_str()],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    Ok(PreparedLaunch {
        soul_id: SoulId::parse(raw.0)
            .map_err(|_| RegistryError::Integrity("invalid soul id".into()))?,
        incarnation_id: incarnation_id.clone(),
        launch_nonce: LaunchNonce::parse(raw.1)
            .map_err(|_| RegistryError::Integrity("invalid launch nonce".into()))?,
        state: parse_launch_state(&raw.2)?,
        intent_revision: raw.3,
        existing_request: true,
    })
}

pub(crate) fn load_owned_handle(
    conn: &Connection,
    installation: InstallationId,
    incarnation_id: &IncarnationId,
) -> Result<OwnedRuntimeHandle, RegistryError> {
    type OwnedRow = (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        String,
        Option<String>,
        Option<String>,
        String,
    );
    let raw: OwnedRow = conn.query_row(
        "SELECT i.soul_id,i.launch_nonce,i.docker_daemon_id,i.container_id,i.image_ref,i.runtime_dir,i.host_binary_path,i.immutable_config_digest,i.requested_limits,i.launch_state,i.fixture_kind,i.terminal_spec,s.provider_volume_name FROM incarnations i JOIN souls s ON s.soul_id=i.soul_id WHERE i.incarnation_id=?1",
        params![incarnation_id.as_str()],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?,row.get(11)?,row.get(12)?)),
    ).optional()?.ok_or_else(|| RegistryError::UnknownIncarnation(incarnation_id.clone()))?;
    if raw.9 == "prepared" {
        return Err(RegistryError::InvalidState(
            "PREPARED incarnation has no mutation authority".into(),
        ));
    }
    let require = |value: Option<String>, field: &str| {
        value.ok_or_else(|| RegistryError::Integrity(format!("owned incarnation missing {field}")))
    };
    let fixture = raw.10.as_deref().map(parse_fixture_kind).transpose()?;
    let terminal = raw
        .11
        .map(|value| serde_json::from_str(&value))
        .transpose()?;
    Ok(OwnedRuntimeHandle::from_registry(
        installation,
        SoulId::parse(raw.0).map_err(|_| RegistryError::Integrity("invalid soul id".into()))?,
        incarnation_id.clone(),
        LaunchNonce::parse(raw.1)
            .map_err(|_| RegistryError::Integrity("invalid launch nonce".into()))?,
        DockerDaemonId::parse(require(raw.2, "docker_daemon_id")?)
            .map_err(|_| RegistryError::Integrity("invalid daemon id".into()))?,
        require(raw.3, "container_id")?,
        require(raw.4, "image_ref")?,
        PathBuf::from(require(raw.5, "runtime_dir")?),
        PathBuf::from(require(raw.6, "host_binary_path")?),
        require(raw.7, "immutable_config_digest")?,
        serde_json::from_str(&raw.8)?,
        fixture,
        terminal,
        raw.12,
    ))
}

fn load_recovery_context(
    conn: &Connection,
    installation: InstallationId,
    soul_id: &SoulId,
) -> Result<RecoveryContext, RegistryError> {
    type SoulRecoveryRow = (
        String,
        String,
        Option<String>,
        String,
        String,
        u64,
        String,
        String,
        String,
        u64,
        u64,
        Option<String>,
        String,
        String,
        Option<i64>,
        u64,
        Option<String>,
    );
    let row: SoulRecoveryRow = conn
        .query_row(
            "SELECT provider,provider_store_id,native_session_id,creation_seed_ref,desired_state,intent_revision,recovery_state,durability_state,allocation_state,checkpoint_revision,evidence_revision,resume_spec,project_key,resource_profile,recovery_window_started_at,successful_recoveries_in_window,configured_limits FROM souls WHERE soul_id=?1",
            params![soul_id.as_str()],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                    row.get(11)?,
                    row.get(12)?,
                    row.get(13)?,
                    row.get(14)?,
                    row.get(15)?,
                    row.get(16)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| RegistryError::UnknownSoul(soul_id.clone()))?;
    let incarnation_raw: String = conn
        .query_row(
            &format!(
                "SELECT incarnation_id FROM incarnations WHERE soul_id=?1                  AND docker_daemon_id IS NOT NULL AND container_id IS NOT NULL                  AND image_ref IS NOT NULL AND runtime_dir IS NOT NULL                  AND host_binary_path IS NOT NULL AND immutable_config_digest IS NOT NULL                  ORDER BY CASE WHEN launch_state IN ({ACTIVE_STATES}) THEN 0 ELSE 1 END,created_at DESC LIMIT 1"
            ),
            params![soul_id.as_str()],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| RegistryError::InvalidState(format!("soul {soul_id} has no incarnation")))?;
    let incarnation_id = IncarnationId::parse(incarnation_raw)
        .map_err(|_| RegistryError::Integrity("invalid incarnation id".into()))?;
    let prior_handle = load_owned_handle(conn, installation, &incarnation_id)?;
    let (accepted_command_count, completed_command_count, dispatched_count): (u64, u64, u64) =
        conn.query_row(
            "SELECT COUNT(*),COALESCE(SUM(CASE WHEN state='completed' THEN 1 ELSE 0 END),0),COALESCE(SUM(CASE WHEN state IN ('dispatching','completed','ambiguous') THEN 1 ELSE 0 END),0) FROM input_commands WHERE soul_id=?1",
            params![soul_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
    let resume_spec = row
        .11
        .map(|value| serde_json::from_str(&value))
        .transpose()?;
    let never_dispatched = dispatched_count == 0 && row.2.is_none();
    Ok(RecoveryContext {
        soul_id: soul_id.clone(),
        provider: row.0,
        provider_store_id: row.1,
        native_session_id: row.2,
        creation_seed_ref: row.3,
        desired_state: parse_desired_state(&row.4)?,
        intent_revision: row.5,
        recovery_state: parse_recovery_state(&row.6)?,
        durability_state: parse_durability_state(&row.7)?,
        allocation_state: parse_allocation_state(&row.8)?,
        checkpoint_revision: row.9,
        evidence_revision: row.10,
        resume_spec,
        project_key: row.12,
        profile: parse_runtime_profile(&row.13)?,
        fixture: prior_handle.fixture(),
        terminal: prior_handle.terminal().cloned(),
        requested_limits: row
            .16
            .map(|value| serde_json::from_str(&value))
            .transpose()?
            .unwrap_or_else(|| prior_handle.requested_limits()),
        accepted_command_count,
        completed_command_count,
        never_dispatched,
        recovery_window_started_at: row.14,
        successful_recoveries_in_window: row.15,
        prior_handle,
    })
}

pub(crate) fn load_inventory(conn: &Connection) -> Result<Vec<RuntimeView>, RegistryError> {
    let mut stmt = conn.prepare(
        "SELECT i.soul_id,i.incarnation_id,i.launch_state,i.cleanup_state,s.intent_revision,i.container_id,i.host_boot_id,i.execution_generation,i.effective_limits,i.terminal_id,s.project_key,s.resource_profile,s.desired_state,s.recovery_state,s.durability_state,s.allocation_state,s.provider,s.native_session_id,s.recovery_reason,i.prior_incarnation_id,s.recovery_attempt_id,s.evidence_revision,s.successful_recoveries_in_window,i.terminal_spec,s.configured_limits,(SELECT MAX(v.revision) FROM view_intents v WHERE v.soul_id=i.soul_id),s.loss_incident_id FROM incarnations i JOIN souls s ON s.soul_id=i.soul_id ORDER BY i.created_at,i.incarnation_id",
    )?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let effective: Option<String> = row.get(8)?;
        let profile: String = row.get(11)?;
        let terminal_spec: Option<TerminalLaunchSpec> = row
            .get::<_, Option<String>>(23)?
            .map(|value| serde_json::from_str(&value))
            .transpose()?;
        out.push(RuntimeView {
            soul_id: SoulId::parse(row.get::<_, String>(0)?)
                .map_err(|_| RegistryError::Integrity("invalid soul id".into()))?,
            incarnation_id: IncarnationId::parse(row.get::<_, String>(1)?)
                .map_err(|_| RegistryError::Integrity("invalid incarnation id".into()))?,
            launch_state: parse_launch_state(&row.get::<_, String>(2)?)?,
            cleanup_state: parse_cleanup_state(&row.get::<_, String>(3)?)?,
            intent_revision: row.get(4)?,
            container_id: row.get(5)?,
            host_boot_id: row
                .get::<_, Option<String>>(6)?
                .map(HostBootId::parse)
                .transpose()
                .map_err(|_| RegistryError::Integrity("invalid host boot id".into()))?,
            execution_generation: row.get(7)?,
            effective_limits: effective.map(|v| serde_json::from_str(&v)).transpose()?,
            configured_limits: row
                .get::<_, Option<String>>(24)?
                .map(|value| serde_json::from_str(&value))
                .transpose()?,
            view_intent_revision: row.get(25)?,
            terminal_id: row.get(9)?,
            terminal_stream_id: terminal_spec.as_ref().map(|spec| spec.stream_id.clone()),
            terminal_mode: terminal_spec.as_ref().map(|spec| spec.mode.clone()),
            terminal_cwd: terminal_spec.as_ref().map(|spec| spec.cwd.clone()),
            terminal_create_request_id: terminal_spec
                .as_ref()
                .and_then(|spec| spec.create_request_id.clone()),
            terminal_resume_session_id: terminal_spec
                .as_ref()
                .and_then(|spec| spec.resume_session_id.clone()),
            project_key: Some(row.get(10)?),
            profile: Some(parse_runtime_profile(&profile)?),
            desired_state: parse_desired_state(&row.get::<_, String>(12)?)?,
            recovery_state: parse_recovery_state(&row.get::<_, String>(13)?)?,
            durability_state: parse_durability_state(&row.get::<_, String>(14)?)?,
            allocation_state: parse_allocation_state(&row.get::<_, String>(15)?)?,
            provider: Some(row.get(16)?),
            native_session_id: row.get(17)?,
            recovery_reason: row.get(18)?,
            incident_id: row
                .get::<_, Option<String>>(26)?
                .map(freshell_runtime_protocol::IncidentId::parse)
                .transpose()
                .map_err(|_| RegistryError::Integrity("invalid incident id".into()))?,
            prior_incarnation_id: row
                .get::<_, Option<String>>(19)?
                .map(IncarnationId::parse)
                .transpose()
                .map_err(|_| RegistryError::Integrity("invalid prior incarnation id".into()))?,
            recovery_attempt_id: row
                .get::<_, Option<String>>(20)?
                .map(RecoveryAttemptId::parse)
                .transpose()
                .map_err(|_| RegistryError::Integrity("invalid recovery attempt id".into()))?,
            evidence_revision: row.get(21)?,
            successful_recoveries_in_window: row.get(22)?,
        });
    }
    Ok(out)
}

fn parse_desired_state(value: &str) -> Result<DesiredState, RegistryError> {
    match value {
        "running" => Ok(DesiredState::Running),
        "stopped" => Ok(DesiredState::Stopped),
        other => Err(RegistryError::Integrity(format!(
            "unknown desired state {other}"
        ))),
    }
}

fn parse_recovery_state(value: &str) -> Result<RecoveryState, RegistryError> {
    match value {
        "live" => Ok(RecoveryState::Live),
        "recovering" => Ok(RecoveryState::Recovering),
        "blocked" => Ok(RecoveryState::Blocked),
        "lost" => Ok(RecoveryState::Lost),
        "stopped" => Ok(RecoveryState::Stopped),
        other => Err(RegistryError::Integrity(format!(
            "unknown recovery state {other}"
        ))),
    }
}

fn parse_durability_state(value: &str) -> Result<DurabilityState, RegistryError> {
    match value {
        "unknown" => Ok(DurabilityState::Unknown),
        "live_only" => Ok(DurabilityState::LiveOnly),
        "resume_captured" => Ok(DurabilityState::ResumeCaptured),
        "checkpoint_captured" => Ok(DurabilityState::CheckpointCaptured),
        "intrinsically_non_resumable" => Ok(DurabilityState::IntrinsicallyNonResumable),
        other => Err(RegistryError::Integrity(format!(
            "unknown durability state {other}"
        ))),
    }
}

fn parse_allocation_state(value: &str) -> Result<AllocationState, RegistryError> {
    match value {
        "allocated" => Ok(AllocationState::Allocated),
        "materializing" => Ok(AllocationState::Materializing),
        "verified_durable" => Ok(AllocationState::VerifiedDurable),
        "degraded" => Ok(AllocationState::Degraded),
        other => Err(RegistryError::Integrity(format!(
            "unknown allocation state {other}"
        ))),
    }
}

fn parse_launch_state(value: &str) -> Result<LaunchState, RegistryError> {
    Ok(match value {
        "prepared" => LaunchState::Prepared,
        "created" => LaunchState::Created,
        "starting" => LaunchState::Starting,
        "running" => LaunchState::Running,
        "stopping" => LaunchState::Stopping,
        "stopped" => LaunchState::Stopped,
        "failed" => LaunchState::Failed,
        other => {
            return Err(RegistryError::Integrity(format!(
                "unknown launch state {other}"
            )))
        }
    })
}

fn parse_cleanup_state(value: &str) -> Result<CleanupState, RegistryError> {
    Ok(match value {
        "none" => CleanupState::None,
        "requested" => CleanupState::Requested,
        "termination_unconfirmed" => CleanupState::TerminationUnconfirmed,
        "verified_empty" => CleanupState::VerifiedEmpty,
        "blocked_ownership" => CleanupState::BlockedOwnership,
        other => {
            return Err(RegistryError::Integrity(format!(
                "unknown cleanup state {other}"
            )))
        }
    })
}

pub(crate) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn durable_sync_parent(parent: Option<&Path>) -> Result<(), RegistryError> {
    if let Some(parent) = parent {
        let dir = std::fs::File::open(parent)?;
        dir.sync_all()?;
    }
    Ok(())
}

#[cfg(unix)]
fn acquire_exclusive_lock(file: &std::fs::File) -> Result<(), RegistryError> {
    use std::os::fd::AsRawFd;
    // SAFETY: the descriptor is valid for this call and owned by `file`.
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc == 0 {
        Ok(())
    } else if std::io::Error::last_os_error().kind() == std::io::ErrorKind::WouldBlock {
        Err(RegistryError::Busy)
    } else {
        Err(RegistryError::Io(std::io::Error::last_os_error()))
    }
}

#[cfg(not(unix))]
fn acquire_exclusive_lock(_file: &std::fs::File) -> Result<(), RegistryError> {
    Ok(())
}

#[cfg(feature = "runtime-test-faults")]
pub(crate) fn failpoint(name: &'static str) -> Result<(), RegistryError> {
    if std::env::var("FRESHELL_RUNTIME_DB_FAILPOINT")
        .ok()
        .as_deref()
        == Some(name)
    {
        return Err(RegistryError::FaultInjected(name));
    }
    Ok(())
}

#[cfg(not(feature = "runtime-test-faults"))]
pub(crate) fn failpoint(_name: &'static str) -> Result<(), RegistryError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> RuntimeLimits {
        RuntimeLimits {
            cpu_milli: 500,
            memory_bytes: 64 * 1024 * 1024,
            swap_bytes: 0,
            pids_max: 32,
        }
    }

    fn prep(soul: SoulId, request: RequestId, digest: &str) -> LaunchPreparation {
        LaunchPreparation {
            soul_id: soul,
            provider: "fixture".into(),
            provider_store_id: "store".into(),
            native_session_id: None,
            creation_seed_ref: "seed".into(),
            request_id: request,
            payload_digest: digest.into(),
            requested_limits: limits(),
            profile: RuntimeProfile::Custom,
            project_key: "test-project".into(),
            fixture: None,
            terminal: None,
            view_intent: None,
            admission: AdmissionPolicy::default(),
        }
    }

    async fn materialize_test_runtime(registry: &Registry, soul_id: SoulId) -> PreparedLaunch {
        let prepared = registry
            .prepare_launch(prep(soul_id, RequestId::new(), "materialized"))
            .await
            .unwrap();
        let daemon = DockerDaemonId::new();
        let runtime_dir = format!("/tmp/freshell-runtime-test/{}", prepared.incarnation_id);
        let host_binary = format!("{runtime_dir}/freshell-session-host");
        let conn = open_connection(&registry.inner.db_path).unwrap();
        conn.execute(
            "UPDATE incarnations SET docker_daemon_id=?1,container_id=?2,image_ref='phase3-test-image',runtime_dir=?3,host_binary_path=?4,immutable_config_digest='sha256:phase3-test',launch_state='running' WHERE incarnation_id=?5",
            params![
                daemon.as_str(),
                format!("container-{}", prepared.incarnation_id),
                runtime_dir,
                host_binary,
                prepared.incarnation_id.as_str()
            ],
        )
        .unwrap();
        prepared
    }

    #[tokio::test]
    async fn request_dedupe_returns_same_incarnation_and_conflict_rejects_changed_payload() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let request = RequestId::new();
        let first = registry
            .prepare_launch(prep(soul.clone(), request.clone(), "one"))
            .await
            .unwrap();
        let replay = registry
            .prepare_launch(prep(soul.clone(), request.clone(), "one"))
            .await
            .unwrap();
        assert_eq!(first.incarnation_id, replay.incarnation_id);
        assert!(replay.existing_request);
        let conflict = registry
            .prepare_launch(prep(soul, request, "two"))
            .await
            .unwrap_err();
        assert!(matches!(conflict, RegistryError::RequestConflict));
    }

    #[tokio::test]
    async fn request_dedupe_survives_registry_restart_with_active_incarnation() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let installation = registry.installation_id().clone();
        let soul = SoulId::new();
        let request = RequestId::new();
        let first = registry
            .prepare_launch(prep(soul.clone(), request.clone(), "one"))
            .await
            .unwrap();
        let conn = open_connection(&registry.inner.db_path).unwrap();
        conn.execute(
            "UPDATE incarnations SET docker_daemon_id=?1,container_id='container-one',image_ref='image-one',runtime_dir='/tmp/runtime-one',host_binary_path='/tmp/host-one',immutable_config_digest='digest-one',launch_state='running' WHERE incarnation_id=?2",
            params![DockerDaemonId::new().as_str(), first.incarnation_id.as_str()],
        )
        .unwrap();
        drop(conn);
        drop(registry);

        let reopened = Registry::open(dir.path(), Some(installation)).unwrap();
        let replay = reopened
            .prepare_launch(prep(soul, request, "one"))
            .await
            .unwrap();
        assert_eq!(first.incarnation_id, replay.incarnation_id);
        assert_eq!(replay.state, LaunchState::Running);
        assert!(replay.existing_request);
    }

    #[tokio::test]
    async fn new_request_adopts_only_semantically_identical_live_incarnation() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let first = materialize_test_runtime(&registry, soul.clone()).await;

        let adopted = registry
            .prepare_launch(prep(soul.clone(), RequestId::new(), "materialized"))
            .await
            .unwrap();
        assert_eq!(adopted.incarnation_id, first.incarnation_id);
        assert_eq!(adopted.state, LaunchState::Running);
        assert!(adopted.existing_request);

        let conflict = registry
            .prepare_launch(prep(soul.clone(), RequestId::new(), "different"))
            .await
            .unwrap_err();
        assert!(matches!(conflict, RegistryError::ActiveIncarnation(id) if id == soul));

        let conn = open_connection(&registry.inner.db_path).unwrap();
        let bound_commands: u64 = conn
            .query_row(
                "SELECT COUNT(*) FROM commands WHERE incarnation_id=?1",
                params![first.incarnation_id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(bound_commands, 2);
    }

    #[tokio::test]
    async fn amplifier_onecli_persists_only_the_secret_reference() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let keys = workspace.path().join("keys.env");
        let secret = "amplifier-onecli-secret-never-persist";
        std::fs::write(&keys, format!("ANTHROPIC_API_KEY={secret}\n")).unwrap();
        let keys = std::fs::canonicalize(keys).unwrap();
        let workspace_path = std::fs::canonicalize(workspace.path()).unwrap();

        let registry = Registry::open(dir.path(), None).unwrap();
        let mut launch = prep(SoulId::new(), RequestId::new(), "bootstrap-ref-only");
        launch.provider = "amplifier".into();
        launch.terminal = Some(TerminalLaunchSpec {
            terminal_id: "terminal-bootstrap".into(),
            stream_id: "stream-bootstrap".into(),
            mode: "amplifier".into(),
            program: "/bin/true".into(),
            args: Vec::new(),
            env: std::collections::BTreeMap::new(),
            cwd: workspace_path.to_string_lossy().into_owned(),
            run_as_uid: 65_534,
            run_as_gid: 0,
            cols: 80,
            rows: 24,
            project_key: "bootstrap-test".into(),
            workspace_path: workspace_path.to_string_lossy().into_owned(),
            git_common_dir: None,
            create_request_id: Some("create-bootstrap".into()),
            resume_session_id: Some("session-bootstrap".into()),
            provider_model: None,
            provider_reasoning_effort: None,
            provider_sandbox: None,
            provider_permission_mode: None,
            provider_bootstrap_files: Vec::new(),
            provider_secret_references: vec![
                freshell_runtime_protocol::ProviderSecretReference {
                    source_path: keys.to_string_lossy().into_owned(),
                    profile: freshell_runtime_protocol::ProviderSecretProfile::AmplifierOnecliAnthropicHaikuLow,
                    approved_endpoint: "https://onecli.example.invalid/v1".into(),
                },
            ],
        });
        registry.prepare_launch(launch).await.unwrap();

        let conn = open_connection(&registry.inner.db_path).unwrap();
        let terminal_json: String = conn
            .query_row(
                "SELECT terminal_spec FROM incarnations LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(terminal_json.contains(&keys.to_string_lossy().to_string()));
        assert!(terminal_json.contains("onecli.example.invalid"));
        assert!(!terminal_json.contains(secret));
        drop(conn);

        let mut durable_bytes = Vec::new();
        for candidate in [
            registry.inner.db_path.clone(),
            registry.inner.db_path.with_extension("sqlite3-wal"),
        ] {
            if let Ok(bytes) = std::fs::read(candidate) {
                durable_bytes.extend(bytes);
            }
        }
        assert!(
            !String::from_utf8_lossy(&durable_bytes).contains(secret),
            "OneCLI secret bytes must never enter supervisor durable state"
        );
    }

    #[test]
    fn second_supervisor_cannot_own_same_registry() {
        let dir = tempfile::tempdir().unwrap();
        let installation = InstallationId::new();
        let first = Registry::open(dir.path(), Some(installation.clone())).unwrap();
        let second = Registry::open(dir.path(), Some(installation));
        assert!(matches!(second, Err(RegistryError::Busy)));
        drop(first);
    }

    #[tokio::test]
    async fn handle_does_not_exist_until_container_identity_is_committed() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let prepared = registry
            .prepare_launch(prep(SoulId::new(), RequestId::new(), "x"))
            .await
            .unwrap();
        let err = registry
            .owned_handle(prepared.incarnation_id)
            .await
            .unwrap_err();
        assert!(matches!(err, RegistryError::InvalidState(_)));
    }

    #[tokio::test]
    async fn admission_is_transactional_and_same_request_does_not_reserve_twice() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let policy = AdmissionPolicy {
            installation: crate::admission::AdmissionBudget::new(500, 64 * 1024 * 1024, 32),
            project: crate::admission::AdmissionBudget::new(500, 64 * 1024 * 1024, 32),
        };
        let soul = SoulId::new();
        let request = RequestId::new();
        let mut first = prep(soul, request.clone(), "same");
        first.admission = policy;
        let prepared = registry.prepare_launch(first.clone()).await.unwrap();
        let replay = registry.prepare_launch(first).await.unwrap();
        assert_eq!(prepared.incarnation_id, replay.incarnation_id);
        let mut excess = prep(SoulId::new(), RequestId::new(), "other");
        excess.admission = policy;
        let error = registry.prepare_launch(excess).await.unwrap_err();
        assert!(matches!(error, RegistryError::BlockedResource { .. }));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn protected_command_journal_is_private_and_replays_only_queued_input() {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("registry");
        let registry = Registry::open(&root, None).unwrap();
        assert_eq!(
            std::fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );

        let soul = SoulId::new();
        let prepared = materialize_test_runtime(&registry, soul.clone()).await;
        let request = RequestId::new();
        let payload = b"queued prompt\n";
        let (disposition, incarnation) = registry
            .begin_input(soul.clone(), request.clone(), payload)
            .await
            .unwrap();
        assert_eq!(disposition, InputJournalDisposition::Dispatch);
        assert_eq!(incarnation, prepared.incarnation_id);

        let conn = open_connection(&registry.inner.db_path).unwrap();
        let (stored, state): (Vec<u8>, String) = conn
            .query_row(
                "SELECT protected_payload,state FROM input_commands WHERE soul_id=?1 AND request_id=?2",
                params![soul.as_str(), request.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(stored, payload);
        assert_eq!(state, "queued");
        drop(conn);

        let claimed = registry
            .claim_next_queued_input(soul.clone(), prepared.incarnation_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(claimed.request_id, request);
        assert_eq!(claimed.data.as_bytes(), payload);
        assert!(registry
            .claim_next_queued_input(soul.clone(), prepared.incarnation_id.clone())
            .await
            .unwrap()
            .is_none());

        registry
            .mark_input_ambiguous(soul.clone(), request.clone())
            .await
            .unwrap();
        let conn = open_connection(&registry.inner.db_path).unwrap();
        conn.execute(
            "UPDATE incarnations SET launch_state='stopped' WHERE incarnation_id=?1",
            params![prepared.incarnation_id.as_str()],
        )
        .unwrap();
        drop(conn);

        let (disposition, recorded_incarnation) = registry
            .begin_input(soul.clone(), request.clone(), payload)
            .await
            .unwrap();
        assert_eq!(disposition, InputJournalDisposition::Ambiguous);
        assert_eq!(recorded_incarnation, prepared.incarnation_id);
        assert!(matches!(
            registry.begin_input(soul, request, b"different\n").await,
            Err(RegistryError::InputConflict)
        ));
    }

    #[tokio::test]
    async fn retry_budget_is_persisted_and_manual_retry_rearms_without_identity_change() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let prepared = materialize_test_runtime(&registry, soul.clone()).await;
        let conn = open_connection(&registry.inner.db_path).unwrap();
        conn.execute(
            "UPDATE souls SET recovery_window_started_at=?1,successful_recoveries_in_window=5 WHERE soul_id=?2",
            params![now_millis(), soul.as_str()],
        )
        .unwrap();
        drop(conn);

        let blocked = registry
            .begin_recovery(
                soul.clone(),
                RecoveryTrigger::ProviderExit,
                RecoveryPath::NativeResume,
            )
            .await
            .unwrap_err();
        assert!(matches!(
            blocked,
            RegistryError::RecoveryBlocked { ref reason, .. }
                if reason == "BLOCKED_RETRY_BUDGET"
        ));

        let start = registry
            .begin_recovery(
                soul.clone(),
                RecoveryTrigger::ManualRetry,
                RecoveryPath::NativeResume,
            )
            .await
            .unwrap();
        assert_eq!(
            start.context.prior_handle.incarnation_id(),
            &prepared.incarnation_id
        );
        let conn = open_connection(&registry.inner.db_path).unwrap();
        let (state, count, native): (String, u64, Option<String>) = conn
            .query_row(
                "SELECT recovery_state,successful_recoveries_in_window,native_session_id FROM souls WHERE soul_id=?1",
                params![soul.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(state, "recovering");
        assert_eq!(count, 0);
        assert_eq!(native, None);
    }

    #[tokio::test]
    async fn stop_intent_fences_a_recovery_attempt_before_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        materialize_test_runtime(&registry, soul.clone()).await;
        let start = registry
            .begin_recovery(
                soul.clone(),
                RecoveryTrigger::ProviderExit,
                RecoveryPath::NativeResume,
            )
            .await
            .unwrap();
        registry.begin_stop(soul).await.unwrap();
        let error = registry
            .prepare_replacement(start, None, None, RecoveryPath::NativeResume)
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            RegistryError::RecoveryBlocked { ref reason, .. }
                if reason == "STOP_INTENT_OR_STALE_ATTEMPT"
        ));
    }

    #[tokio::test]
    async fn exact_resume_replacement_requires_verified_empty_and_keeps_one_writer() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let native_session_id = "ses_exact_recovery";
        let terminal = TerminalLaunchSpec {
            terminal_id: "terminal-exact-resume".into(),
            stream_id: "stream-exact-resume".into(),
            mode: "opencode".into(),
            program: "opencode".into(),
            args: vec!["--model".into(), "opencode/big-pickle".into()],
            env: std::collections::BTreeMap::from([(
                "HOME".into(),
                "/home/freshell/provider".into(),
            )]),
            cwd: "/workspace".into(),
            run_as_uid: 65_534,
            run_as_gid: 0,
            cols: 80,
            rows: 24,
            project_key: "project-exact-resume".into(),
            workspace_path: "/workspace".into(),
            git_common_dir: None,
            create_request_id: Some("create-exact-resume".into()),
            resume_session_id: None,
            provider_model: Some("opencode/big-pickle".into()),
            provider_reasoning_effort: None,
            provider_sandbox: None,
            provider_permission_mode: None,
            provider_bootstrap_files: Vec::new(),
            provider_secret_references: Vec::new(),
        };
        let mut launch = prep(soul.clone(), RequestId::new(), "exact-resume");
        launch.provider = "opencode".into();
        launch.provider_store_id = "store-exact-resume".into();
        launch.native_session_id = Some(native_session_id.into());
        launch.terminal = Some(terminal.clone());
        let original = registry.prepare_launch(launch).await.unwrap();
        let conn = open_connection(&registry.inner.db_path).unwrap();
        conn.execute(
            "UPDATE incarnations SET docker_daemon_id=?1,container_id=?2,image_ref='phase3-test-image',runtime_dir=?3,host_binary_path=?4,immutable_config_digest='sha256:phase3-test',launch_state='running' WHERE incarnation_id=?5",
            params![
                DockerDaemonId::new().as_str(),
                format!("container-{}", original.incarnation_id),
                format!("/tmp/freshell-runtime-test/{}", original.incarnation_id),
                format!("/tmp/freshell-runtime-test/{}/host", original.incarnation_id),
                original.incarnation_id.as_str(),
            ],
        )
        .unwrap();
        drop(conn);
        let resume_spec =
            freshell_agent_runtime::build_resume_spec(freshell_agent_runtime::ResumeSpecInput {
                provider: "opencode",
                provider_store_id: "store-exact-resume",
                native_session_id,
                terminal: &terminal,
                provider_version: Some("1.18.21".into()),
                creation_seed_ref: "seed".into(),
                checkpoint_revision: 0,
                evidence_revision: 0,
                never_dispatched: false,
            })
            .unwrap();
        let resume_spec = registry
            .store_verified_resume_spec(soul.clone(), resume_spec)
            .await
            .unwrap();
        let start = registry
            .begin_recovery(
                soul.clone(),
                RecoveryTrigger::ProviderExit,
                RecoveryPath::NativeResume,
            )
            .await
            .unwrap();

        let not_empty = registry
            .prepare_replacement(
                start.clone(),
                Some(terminal.clone()),
                Some(resume_spec.clone()),
                RecoveryPath::NativeResume,
            )
            .await
            .unwrap_err();
        assert!(matches!(
            not_empty,
            RegistryError::RecoveryBlocked { ref reason, .. }
                if reason == "OLD_RUNTIME_NOT_VERIFIED_EMPTY"
        ));

        registry
            .mark_stop_outcome(original.incarnation_id.clone(), StopOutcome::VerifiedEmpty)
            .await
            .unwrap();
        let replacement = registry
            .prepare_replacement(
                start,
                Some(terminal),
                Some(resume_spec),
                RecoveryPath::NativeResume,
            )
            .await
            .unwrap();
        assert_eq!(replacement.prior_incarnation_id, original.incarnation_id);
        assert_eq!(
            replacement
                .resume_spec
                .as_ref()
                .unwrap()
                .provider_session
                .native_session_id,
            native_session_id
        );
        assert!(replacement.terminal.is_some());
        let conn = open_connection(&registry.inner.db_path).unwrap();
        let claims: u64 = conn
            .query_row(
                "SELECT COUNT(*) FROM writer_claims WHERE soul_id=?1 AND native_session_id=?2",
                params![soul.as_str(), native_session_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(claims, 1, "exact recovery keeps one native-session writer");
    }

    #[tokio::test]
    async fn interrupted_prepared_replacement_is_retired_without_claiming_unknown_docker_object() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let original = materialize_test_runtime(&registry, soul.clone()).await;
        let start = registry
            .begin_recovery(
                soul.clone(),
                RecoveryTrigger::ProviderExit,
                RecoveryPath::PristineSeed,
            )
            .await
            .unwrap();
        registry
            .mark_stop_outcome(original.incarnation_id.clone(), StopOutcome::VerifiedEmpty)
            .await
            .unwrap();
        let replacement = registry
            .prepare_replacement(start, None, None, RecoveryPath::PristineSeed)
            .await
            .unwrap();

        assert!(registry
            .retire_unowned_prepared_replacement(soul.clone())
            .await
            .unwrap());
        assert!(!registry
            .retire_unowned_prepared_replacement(soul.clone())
            .await
            .unwrap());

        let context = registry.recovery_context(soul.clone()).await.unwrap();
        assert_eq!(
            context.prior_handle.incarnation_id(),
            &original.incarnation_id
        );
        assert_eq!(context.recovery_state, RecoveryState::Blocked);
        let conn = open_connection(&registry.inner.db_path).unwrap();
        let (state, cleanup, reservations, claims): (String, String, u64, u64) = conn
            .query_row(
                "SELECT i.launch_state,i.cleanup_state,                    (SELECT COUNT(*) FROM admission_reservations a WHERE a.incarnation_id=i.incarnation_id),                    (SELECT COUNT(*) FROM writer_claims w WHERE w.incarnation_id=i.incarnation_id)                 FROM incarnations i WHERE i.incarnation_id=?1",
                params![replacement.prepared.incarnation_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(state, "failed");
        assert_eq!(cleanup, "termination_unconfirmed");
        assert_eq!(reservations, 0);
        assert_eq!(claims, 0);
    }

    #[tokio::test]
    async fn one_recovery_attempt_cannot_create_two_active_incarnations() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let soul = SoulId::new();
        let prepared = materialize_test_runtime(&registry, soul.clone()).await;
        let start = registry
            .begin_recovery(
                soul.clone(),
                RecoveryTrigger::ProviderExit,
                RecoveryPath::PristineSeed,
            )
            .await
            .unwrap();
        registry
            .mark_stop_outcome(prepared.incarnation_id.clone(), StopOutcome::VerifiedEmpty)
            .await
            .unwrap();
        let replacement = registry
            .prepare_replacement(start.clone(), None, None, RecoveryPath::PristineSeed)
            .await
            .unwrap();
        assert_ne!(replacement.prepared.incarnation_id, prepared.incarnation_id);
        assert!(matches!(
            registry
                .prepare_replacement(start, None, None, RecoveryPath::PristineSeed)
                .await,
            Err(RegistryError::ActiveIncarnation(_))
        ));
        let conn = open_connection(&registry.inner.db_path).unwrap();
        let active: u64 = conn
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM incarnations WHERE soul_id=?1 AND launch_state IN ({ACTIVE_STATES})"
                ),
                params![soul.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(active, 1);
    }

    #[test]
    fn schema_three_migrates_protected_payload_without_recreating_registry() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("registry");
        let installation = InstallationId::new();
        let registry = Registry::open(&root, Some(installation.clone())).unwrap();
        let db = registry.inner.db_path.clone();
        drop(registry);

        let conn = open_connection(&db).unwrap();
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys=OFF;
            BEGIN IMMEDIATE;
            ALTER TABLE input_commands RENAME TO input_commands_v4;
            CREATE TABLE input_commands (
                soul_id TEXT NOT NULL REFERENCES souls(soul_id),
                request_id TEXT NOT NULL,
                payload_digest TEXT NOT NULL,
                incarnation_id TEXT NOT NULL REFERENCES incarnations(incarnation_id),
                state TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(soul_id, request_id)
            );
            DROP TABLE input_commands_v4;
            UPDATE installation SET schema_version=3 WHERE singleton=1;
            COMMIT;
            PRAGMA foreign_keys=ON;
            "#,
        )
        .unwrap();
        drop(conn);

        let migrated = Registry::open(&root, Some(installation)).unwrap();
        let conn = open_connection(&migrated.inner.db_path).unwrap();
        let schema: u32 = conn
            .query_row(
                "SELECT schema_version FROM installation WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(schema, SCHEMA_VERSION);
        let mut stmt = conn.prepare("PRAGMA table_info(input_commands)").unwrap();
        let columns: Vec<String> = stmt
            .query_map([], |row| row.get(1))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert!(columns.iter().any(|column| column == "protected_payload"));
    }

    fn drop_phase_six_schema(conn: &Connection) {
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys=OFF;
            BEGIN IMMEDIATE;
            DROP TABLE IF EXISTS notice_receipts;
            DROP TABLE IF EXISTS runtime_notices;
            DROP TABLE IF EXISTS runtime_counters;
            DROP TABLE IF EXISTS migration_runs;
            DROP TABLE IF EXISTS repair_audits;
            DROP INDEX IF EXISTS one_loss_incident_per_soul_revision;
            DROP TABLE IF EXISTS loss_incidents;
            DROP TABLE IF EXISTS rollout_state;
            ALTER TABLE souls DROP COLUMN loss_incident_id;
            COMMIT;
            PRAGMA foreign_keys=ON;
            "#,
        )
        .unwrap();
    }

    #[tokio::test]
    async fn schema_five_migration_preserves_views_and_adds_loss_operations_tables() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("registry");
        let installation = InstallationId::new();
        let registry = Registry::open(&root, Some(installation.clone())).unwrap();
        let db = registry.inner.db_path.clone();
        let soul = SoulId::new();
        registry
            .prepare_launch(prep(soul.clone(), RequestId::new(), "schema-five"))
            .await
            .unwrap();
        let before_views: u64 = open_connection(&db)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM view_intents", [], |row| row.get(0))
            .unwrap();
        drop(registry);

        let conn = open_connection(&db).unwrap();
        drop_phase_six_schema(&conn);
        conn.execute(
            "UPDATE installation SET schema_version=5 WHERE singleton=1",
            [],
        )
        .unwrap();
        drop(conn);

        let migrated = Registry::open(&root, Some(installation)).unwrap();
        let conn = open_connection(&migrated.inner.db_path).unwrap();
        let schema: u32 = conn
            .query_row(
                "SELECT schema_version FROM installation WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(schema, SCHEMA_VERSION);
        let after_views: u64 = conn
            .query_row("SELECT COUNT(*) FROM view_intents", [], |row| row.get(0))
            .unwrap();
        assert_eq!(after_views, before_views);
        for table in [
            "loss_incidents",
            "runtime_notices",
            "notice_receipts",
            "runtime_counters",
            "rollout_state",
            "migration_runs",
            "repair_audits",
        ] {
            assert!(table_exists(&conn, table).unwrap(), "missing {table}");
        }
        assert!(column_exists(&conn, "souls", "loss_incident_id").unwrap());
        let preserved: u64 = conn
            .query_row(
                "SELECT COUNT(*) FROM souls WHERE soul_id=?1",
                params![soul.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(preserved, 1);
    }

    #[tokio::test]
    async fn schema_four_migration_preserves_existing_rows_and_backfills_views() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("registry");
        let installation = InstallationId::new();
        let registry = Registry::open(&root, Some(installation.clone())).unwrap();
        let db = registry.inner.db_path.clone();
        let soul = SoulId::new();
        let prepared = registry
            .prepare_launch(prep(soul.clone(), RequestId::new(), "schema-four"))
            .await
            .unwrap();
        let conn = open_connection(&db).unwrap();
        conn.execute(
            "UPDATE incarnations SET terminal_spec='{}' WHERE incarnation_id=?1",
            params![prepared.incarnation_id.as_str()],
        )
        .unwrap();
        drop(conn);
        drop(registry);

        let conn = open_connection(&db).unwrap();
        drop_phase_six_schema(&conn);
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys=OFF;
            BEGIN IMMEDIATE;
            DROP TRIGGER IF EXISTS souls_inventory_insert;
            DROP TRIGGER IF EXISTS souls_inventory_update;
            DROP TRIGGER IF EXISTS souls_inventory_delete;
            DROP TRIGGER IF EXISTS incarnations_inventory_insert;
            DROP TRIGGER IF EXISTS incarnations_inventory_update;
            DROP TRIGGER IF EXISTS incarnations_inventory_delete;
            DROP TRIGGER IF EXISTS view_intents_inventory_insert;
            DROP TRIGGER IF EXISTS view_intents_inventory_update;
            DROP TRIGGER IF EXISTS view_intents_inventory_delete;
            DROP INDEX IF EXISTS one_automatic_primary_view_per_soul;
            DROP TABLE IF EXISTS view_intents;
            ALTER TABLE souls DROP COLUMN configured_limits;
            ALTER TABLE installation DROP COLUMN inventory_revision;
            ALTER TABLE installation DROP COLUMN initial_scan_state;
            ALTER TABLE installation DROP COLUMN initial_scan_error;
            ALTER TABLE installation DROP COLUMN initial_scan_started_at;
            ALTER TABLE installation DROP COLUMN initial_scan_finished_at;
            ALTER TABLE installation DROP COLUMN initial_scan_peak_concurrency;
            UPDATE installation SET schema_version=4 WHERE singleton=1;
            COMMIT;
            PRAGMA foreign_keys=ON;
            "#,
        )
        .unwrap();
        drop(conn);

        let migrated = Registry::open(&root, Some(installation.clone())).unwrap();
        assert_eq!(migrated.installation_id(), &installation);
        let conn = open_connection(&migrated.inner.db_path).unwrap();
        let schema: u32 = conn
            .query_row(
                "SELECT schema_version FROM installation WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(schema, SCHEMA_VERSION);
        let preserved: u64 = conn
            .query_row(
                "SELECT COUNT(*) FROM souls WHERE soul_id=?1",
                params![soul.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(preserved, 1);
        let views: Vec<(String, String, String)> = {
            let mut statement = conn
                .prepare("SELECT soul_id,kind,visibility FROM view_intents WHERE soul_id=?1")
                .unwrap();
            statement
                .query_map(params![soul.as_str()], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        assert_eq!(
            views,
            vec![(
                soul.to_string(),
                "automatic_primary".into(),
                "visible".into()
            )]
        );
        assert!(column_exists(&conn, "souls", "configured_limits").unwrap());
        assert!(column_exists(&conn, "installation", "inventory_revision").unwrap());
    }

    #[test]
    fn newer_schema_fails_closed_without_replacing_database() {
        let dir = tempfile::tempdir().unwrap();
        let installation = InstallationId::new();
        let first = Registry::open(dir.path(), Some(installation.clone())).unwrap();
        let db = first.inner.db_path.clone();
        drop(first);
        let conn = open_connection(&db).unwrap();
        conn.execute(
            "UPDATE installation SET schema_version=999 WHERE singleton=1",
            [],
        )
        .unwrap();
        drop(conn);
        let error = Registry::open(dir.path(), Some(installation))
            .err()
            .expect("newer schema must fail closed");
        assert!(matches!(
            error,
            RegistryError::NewerSchema { found: 999, .. }
        ));
        assert!(db.exists());
    }
}
