use crate::admission::{AdmissionPolicy, ReservationTotals};
use freshell_runtime_protocol::{
    CleanupState, DockerDaemonId, GrantId, HostBootId, IncarnationId, InstallationId, LaunchNonce,
    LaunchState, RequestId, RuntimeLimits, RuntimeProfile, RuntimeView, SoulId, StopOutcome,
    TerminalLaunchSpec,
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::OpenOptions,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

const SCHEMA_VERSION: u32 = 2;
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
    #[error("unknown incarnation {0}")]
    UnknownIncarnation(IncarnationId),
    #[error("unknown soul {0}")]
    UnknownSoul(SoulId),
    #[error("invalid registry state: {0}")]
    InvalidState(String),
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
    pub terminal: Option<TerminalLaunchSpec>,
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
    pub fn terminal(&self) -> Option<&TerminalLaunchSpec> {
        self.terminal.as_ref()
    }
    pub fn provider_volume_name(&self) -> &str {
        &self.provider_volume_name
    }
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
            let soul_row: Option<(String, String, String, String, Option<String>)> = tx
                .query_row(
                    "SELECT provider,provider_store_id,project_key,resource_profile,native_session_id FROM souls WHERE soul_id=?1",
                    params![input.soul_id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
                )
                .optional()?;
            if let Some((provider, store, project, profile, native)) = soul_row {
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
            } else {
                tx.execute(
                    "INSERT INTO souls (soul_id,provider,provider_store_id,native_session_id,creation_seed_ref,desired_state,intent_revision,recovery_state,durability_state,checkpoint_revision,project_key,resource_profile,provider_volume_name,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,'running',1,'live','unknown',0,?6,?7,?8,?9,?9)",
                    params![
                        input.soul_id.as_str(),
                        input.provider,
                        input.provider_store_id,
                        input.native_session_id,
                        input.creation_seed_ref,
                        input.project_key,
                        profile_name,
                        provider_volume_name,
                        now
                    ],
                )?;
            }

            let active: Option<String> = tx
                .query_row(
                    &format!("SELECT incarnation_id FROM incarnations WHERE soul_id=?1 AND launch_state IN ({ACTIVE_STATES}) LIMIT 1"),
                    params![input.soul_id.as_str()],
                    |row| row.get(0),
                )
                .optional()?;
            if active.is_some() {
                return Err(RegistryError::ActiveIncarnation(input.soul_id));
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
            tx.execute(
                "INSERT INTO incarnations (incarnation_id,soul_id,launch_nonce,docker_daemon_id,container_id,image_ref,runtime_dir,host_binary_path,immutable_config_digest,launch_state,host_boot_id,execution_generation,grant_id,requested_limits,effective_limits,cleanup_state,terminal_id,terminal_spec,exit_code,oom_killed,created_at,updated_at) VALUES (?1,?2,?3,NULL,NULL,NULL,NULL,NULL,NULL,'prepared',NULL,0,NULL,?4,NULL,'none',?5,?6,NULL,0,?7,?7)",
                params![incarnation_id.as_str(), input.soul_id.as_str(), launch_nonce.as_str(), limits_json, terminal_id, terminal_json, now],
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
                "UPDATE incarnations SET docker_daemon_id=?1,container_id=?2,image_ref=?3,runtime_dir=?4,host_binary_path=?5,immutable_config_digest=?6,launch_state='created',updated_at=?7 WHERE incarnation_id=?8 AND launch_state='prepared' AND container_id IS NULL",
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
                "SELECT execution_generation FROM incarnations WHERE incarnation_id=?1 AND launch_state='created'",
                params![incarnation_id.as_str()],
                |row| row.get(0),
            ).optional()?.ok_or_else(|| RegistryError::InvalidState(format!("cannot grant execution for {incarnation_id}")))?;
            let generation = previous.checked_add(1).ok_or_else(|| RegistryError::Integrity("execution generation overflow".into()))?;
            let grant_id = GrantId::new();
            let effective_json = serde_json::to_string(&effective_limits)?;
            let now = now_millis();
            tx.execute(
                "UPDATE incarnations SET launch_state='starting',host_boot_id=?1,execution_generation=?2,grant_id=?3,effective_limits=?4,updated_at=?5 WHERE incarnation_id=?6 AND launch_state='created'",
                params![host_boot_id.as_str(), generation, grant_id.as_str(), effective_json, now, incarnation_id.as_str()],
            )?;
            tx.execute("UPDATE commands SET state='starting',updated_at=?1 WHERE incarnation_id=?2", params![now, incarnation_id.as_str()])?;
            tx.commit()?;
            Ok(ExecutionGrantRecord { control_epoch, execution_generation: generation, grant_id, host_boot_id })
        }).await
    }

    pub async fn mark_running(&self, incarnation_id: IncarnationId) -> Result<(), RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now = now_millis();
            let changed = tx.execute("UPDATE incarnations SET launch_state='running',updated_at=?1 WHERE incarnation_id=?2 AND launch_state='starting'", params![now, incarnation_id.as_str()])?;
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
                    &format!("SELECT incarnation_id FROM incarnations WHERE soul_id=?1 AND launch_state IN ({ACTIVE_STATES}) ORDER BY created_at DESC LIMIT 1"),
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
        let installation = self.installation_id().clone();
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let active: Option<(String, String)> = tx.query_row(
                &format!("SELECT incarnation_id,launch_state FROM incarnations WHERE soul_id=?1 AND launch_state IN ({ACTIVE_STATES}) LIMIT 1"),
                params![soul_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).optional()?;
            let Some((incarnation_raw, state)) = active else { return Err(RegistryError::UnknownSoul(soul_id)); };
            let incarnation_id = IncarnationId::parse(incarnation_raw).map_err(|_| RegistryError::Integrity("invalid incarnation id".into()))?;
            if state != "stopping" {
                let revision: u64 = tx.query_row("SELECT intent_revision FROM souls WHERE soul_id=?1", params![soul_id.as_str()], |row| row.get(0))?;
                let next = revision.checked_add(1).ok_or_else(|| RegistryError::Integrity("intent revision overflow".into()))?;
                let now = now_millis();
                tx.execute("UPDATE souls SET desired_state='stopped',intent_revision=?1,updated_at=?2 WHERE soul_id=?3", params![next, now, soul_id.as_str()])?;
                tx.execute("UPDATE incarnations SET launch_state='stopping',cleanup_state='requested',updated_at=?1 WHERE incarnation_id=?2", params![now, incarnation_id.as_str()])?;
                tx.execute("INSERT OR IGNORE INTO stop_tombstones (soul_id,intent_revision,actor,reason,committed_at) VALUES (?1,?2,'supervisor','managed stop',?3)", params![soul_id.as_str(), next, now])?;
            }
            tx.commit()?;
            load_owned_handle(&conn, installation, &incarnation_id)
        }).await
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
            }
            tx.commit()?;
            Ok(())
        }).await
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

    async fn run_blocking<T, F>(&self, f: F) -> Result<T, RegistryError>
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

fn open_connection(path: &Path) -> Result<Connection, RegistryError> {
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
            control_epoch INTEGER NOT NULL
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
            durability_state TEXT NOT NULL,
            checkpoint_revision INTEGER NOT NULL,
            project_key TEXT NOT NULL,
            resource_profile TEXT NOT NULL,
            provider_volume_name TEXT NOT NULL,
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
            terminal_id TEXT,
            terminal_spec TEXT,
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
        CREATE TABLE outbox (
            event_id TEXT PRIMARY KEY,
            event_kind TEXT NOT NULL,
            payload TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            delivered_at INTEGER
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
    "#))?;
    tx.execute("INSERT INTO installation (singleton,installation_id,schema_version,control_epoch) VALUES (1,?1,?2,0)", params![installation_id.as_str(), SCHEMA_VERSION])?;
    tx.commit()?;
    durable_sync_parent(conn.path().map(Path::new).and_then(Path::parent))?;
    Ok(())
}

fn migrate_schema(conn: &mut Connection) -> Result<(), RegistryError> {
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
    if schema == SCHEMA_VERSION {
        return Ok(());
    }
    if schema != 1 {
        return Err(RegistryError::Integrity(format!(
            "unsupported older schema {schema}"
        )));
    }
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

fn load_owned_handle(
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
        String,
    );
    let raw: OwnedRow = conn.query_row(
        "SELECT i.soul_id,i.launch_nonce,i.docker_daemon_id,i.container_id,i.image_ref,i.runtime_dir,i.host_binary_path,i.immutable_config_digest,i.requested_limits,i.launch_state,i.terminal_spec,s.provider_volume_name FROM incarnations i JOIN souls s ON s.soul_id=i.soul_id WHERE i.incarnation_id=?1",
        params![incarnation_id.as_str()],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?,row.get(11)?)),
    ).optional()?.ok_or_else(|| RegistryError::UnknownIncarnation(incarnation_id.clone()))?;
    if raw.9 == "prepared" {
        return Err(RegistryError::InvalidState(
            "PREPARED incarnation has no mutation authority".into(),
        ));
    }
    let require = |value: Option<String>, field: &str| {
        value.ok_or_else(|| RegistryError::Integrity(format!("owned incarnation missing {field}")))
    };
    let terminal = raw
        .10
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
        terminal,
        raw.11,
    ))
}

fn load_inventory(conn: &Connection) -> Result<Vec<RuntimeView>, RegistryError> {
    let mut stmt = conn.prepare("SELECT i.soul_id,i.incarnation_id,i.launch_state,i.cleanup_state,s.intent_revision,i.container_id,i.host_boot_id,i.execution_generation,i.effective_limits,i.terminal_id,s.project_key,s.resource_profile FROM incarnations i JOIN souls s ON s.soul_id=i.soul_id ORDER BY i.created_at,i.incarnation_id")?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let effective: Option<String> = row.get(8)?;
        let profile: String = row.get(11)?;
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
            terminal_id: row.get(9)?,
            project_key: Some(row.get(10)?),
            profile: Some(parse_runtime_profile(&profile)?),
        });
    }
    Ok(out)
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

fn now_millis() -> i64 {
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
fn failpoint(name: &'static str) -> Result<(), RegistryError> {
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
fn failpoint(_name: &'static str) -> Result<(), RegistryError> {
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
            terminal: None,
            admission: AdmissionPolicy::default(),
        }
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
