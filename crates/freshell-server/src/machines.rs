//! Server-owned machine identity directory.
//!
//! The tab-sync protocol still calls this identity `deviceId` for wire
//! compatibility. This module is the authoritative, durable directory that
//! turns those legacy device IDs into server-owned machine records without
//! changing an existing tab key or snapshot path.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::boot::{is_authed, unauthorized};

const MACHINE_DIRECTORY_VERSION: u32 = 1;
const FALLBACK_LEGACY_LABEL: &str = "Recovered device";

/// The public machine record returned by `/api/machines`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    pub id: String,
    pub label: String,
    pub created_at: i64,
    pub last_seen_at: i64,
}

/// An exact historical device identifier discovered before the machine
/// directory begins owning new IDs. The caller supplies candidates from both
/// the compact tabs registry and the immutable snapshot directories.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LegacyMachineCandidate {
    pub id: String,
    pub label: String,
    pub last_seen_at: i64,
}

impl LegacyMachineCandidate {
    pub fn new(id: impl Into<String>, label: impl Into<String>, last_seen_at: i64) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            last_seen_at,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MachineDirectoryFile {
    version: u32,
    machines: Vec<Machine>,
}

impl Default for MachineDirectoryFile {
    fn default() -> Self {
        Self {
            version: MACHINE_DIRECTORY_VERSION,
            machines: Vec::new(),
        }
    }
}

#[derive(Clone)]
struct MachineStorePaths {
    state: PathBuf,
    backup: PathBuf,
    state_tmp: PathBuf,
    backup_tmp: PathBuf,
}

impl MachineStorePaths {
    fn new(root: PathBuf) -> Self {
        let v1 = root.join("v1");
        Self {
            state: v1.join("state.json"),
            backup: v1.join("state.json.bak"),
            state_tmp: v1.join("state.json.tmp"),
            backup_tmp: v1.join("state.json.bak.tmp"),
        }
    }

    fn ensure_parent(&self) -> std::io::Result<()> {
        let parent = self
            .state
            .parent()
            .expect("machine state path always has a parent");
        std::fs::create_dir_all(parent)
    }
}

/// Load/persistence failures for the machine directory. The caller receives a
/// clear boot failure instead of silently changing historical identities.
#[derive(Debug)]
pub enum MachineStoreError {
    Io(std::io::Error),
    Invalid(String),
}

impl std::fmt::Display for MachineStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "machine directory I/O error: {error}"),
            Self::Invalid(message) => write!(f, "machine directory is invalid: {message}"),
        }
    }
}

impl std::error::Error for MachineStoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Invalid(_) => None,
        }
    }
}

impl From<std::io::Error> for MachineStoreError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Debug)]
pub enum MachineMutationError {
    NotFound,
    InvalidLabel,
    Storage(MachineStoreError),
}

impl std::fmt::Display for MachineMutationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => write!(f, "machine not found"),
            Self::InvalidLabel => write!(f, "machine label must not be empty"),
            Self::Storage(error) => error.fmt(f),
        }
    }
}

/// Cloneable process-local handle over one machine directory. Disk mutations
/// hold the mutex until their atomic publish completes, so an acknowledged
/// create/rename/touch is always the state a later request observes.
#[derive(Clone)]
pub struct MachineStore {
    state: Arc<Mutex<MachineDirectoryFile>>,
    paths: Option<Arc<MachineStorePaths>>,
}

impl MachineStore {
    /// Open the durable directory and import exact historical IDs before the
    /// server exposes either REST or WebSocket service. `None` is the
    /// deliberately ephemeral no-home mode used by isolated tests.
    pub fn open(
        root: Option<PathBuf>,
        legacy_candidates: Vec<LegacyMachineCandidate>,
    ) -> Result<Self, MachineStoreError> {
        let paths = root.map(MachineStorePaths::new).map(Arc::new);
        let (mut state, mut needs_publish) = match paths.as_deref() {
            Some(paths) => load_directory(paths)?,
            None => (MachineDirectoryFile::default(), false),
        };

        needs_publish |= normalize_directory(&mut state)?;
        let (imported, legacy_state_changed) =
            import_legacy_candidates(&mut state, legacy_candidates);
        needs_publish |= legacy_state_changed;

        if needs_publish {
            if let Some(paths) = paths.as_deref() {
                // A recovered backup must remain the fallback until a later,
                // healthy mutation succeeds; never replace it with the corrupt
                // primary bytes we just recovered from.
                persist_directory(paths, &state, false)?;
            }
        }

        if imported > 0 {
            tracing::info!(
                target: "freshell_server::machines",
                event = "machine_directory_legacy_imported",
                imported,
                total = state.machines.len(),
                "machine directory imported legacy identities"
            );
        }

        Ok(Self {
            state: Arc::new(Mutex::new(state)),
            paths,
        })
    }

    /// All known machines, newest activity first. The stable tie-breaks keep
    /// an empty chooser deterministic across refreshes.
    pub fn list(&self) -> Vec<Machine> {
        let mut machines = lock_unpoisoned(&self.state).machines.clone();
        machines.sort_by(|left, right| {
            right
                .last_seen_at
                .cmp(&left.last_seen_at)
                .then_with(|| right.created_at.cmp(&left.created_at))
                .then_with(|| left.id.cmp(&right.id))
        });
        machines
    }

    /// Server-mint a new identity. Client-supplied labels are suggestions;
    /// labels are normalized and made unique on the server.
    pub fn create(&self, requested_label: &str) -> Result<Machine, MachineMutationError> {
        let base =
            normalized_nonempty_label(requested_label).ok_or(MachineMutationError::InvalidLabel)?;
        let now = now_ms();
        let mut guard = lock_unpoisoned(&self.state);
        let mut next = guard.clone();
        let occupied = occupied_labels(&next.machines, None);
        let machine = Machine {
            id: Uuid::new_v4().to_string(),
            label: unique_label(&base, &occupied),
            created_at: now,
            last_seen_at: now,
        };
        next.machines.push(machine.clone());
        self.persist(&next).map_err(MachineMutationError::Storage)?;
        *guard = next;
        tracing::info!(
            target: "freshell_server::machines",
            event = "machine_created",
            machine_id = %machine.id,
            label = %machine.label,
            "machine created"
        );
        Ok(machine)
    }

    pub fn rename(
        &self,
        machine_id: &str,
        requested_label: &str,
    ) -> Result<Machine, MachineMutationError> {
        let base =
            normalized_nonempty_label(requested_label).ok_or(MachineMutationError::InvalidLabel)?;
        let now = now_ms();
        let mut guard = lock_unpoisoned(&self.state);
        let mut next = guard.clone();
        let Some(index) = next
            .machines
            .iter()
            .position(|machine| machine.id == machine_id)
        else {
            return Err(MachineMutationError::NotFound);
        };
        let occupied = occupied_labels(&next.machines, Some(machine_id));
        let machine = &mut next.machines[index];
        machine.label = unique_label(&base, &occupied);
        machine.last_seen_at = now.max(machine.created_at);
        let updated = machine.clone();
        self.persist(&next).map_err(MachineMutationError::Storage)?;
        *guard = next;
        tracing::info!(
            target: "freshell_server::machines",
            event = "machine_renamed",
            machine_id = %updated.id,
            label = %updated.label,
            "machine renamed"
        );
        Ok(updated)
    }

    /// Resolve an existing machine for tab sync, stamp its canonical label,
    /// and record activity. Returning `None` is intentional: callers reject
    /// an unknown legacy `deviceId` rather than silently creating it.
    pub fn resolve_for_tab_sync(
        &self,
        machine_id: &str,
    ) -> Result<Option<String>, MachineStoreError> {
        let now = now_ms();
        let mut guard = lock_unpoisoned(&self.state);
        let Some(index) = guard
            .machines
            .iter()
            .position(|machine| machine.id == machine_id)
        else {
            return Ok(None);
        };
        let mut next = guard.clone();
        let machine = &mut next.machines[index];
        machine.last_seen_at = now.max(machine.last_seen_at);
        let label = machine.label.clone();
        if next != *guard {
            self.persist(&next)?;
            *guard = next;
        }
        Ok(Some(label))
    }

    fn persist(&self, state: &MachineDirectoryFile) -> Result<(), MachineStoreError> {
        if let Some(paths) = self.paths.as_deref() {
            persist_directory(paths, state, true)?;
        }
        Ok(())
    }
}

impl freshell_ws::tabs::MachineIdentityStore for MachineStore {
    fn resolve_for_tab_sync(&self, machine_id: &str) -> Result<Option<String>, String> {
        self.resolve_for_tab_sync(machine_id)
            .map_err(|error| error.to_string())
    }

    fn machine_exists(&self, machine_id: &str) -> bool {
        lock_unpoisoned(&self.state)
            .machines
            .iter()
            .any(|machine| machine.id == machine_id)
    }
}

/// Collect exact historical IDs from both durable tabs sources. Snapshot files
/// are read-only here: importing a machine never rewrites, renames, or moves a
/// snapshot directory, which keeps `deviceId:tabId` provenance intact.
pub fn legacy_machine_candidates(
    tabs: &freshell_ws::tabs::TabsRegistry,
    snapshots_dir: Option<&Path>,
) -> Result<Vec<LegacyMachineCandidate>, MachineStoreError> {
    let mut candidates: Vec<LegacyMachineCandidate> = tabs
        .legacy_device_metadata()
        .into_iter()
        .map(|device| {
            LegacyMachineCandidate::new(device.device_id, device.device_label, device.last_seen_at)
        })
        .collect();

    let Some(snapshots_dir) = snapshots_dir else {
        return Ok(candidates);
    };
    for device_id in freshell_ws::tabs_persist::list_snapshot_devices(snapshots_dir)? {
        let Some((union, _generations)) =
            freshell_ws::tabs_persist::read_device_overview(snapshots_dir, &device_id)?
        else {
            continue;
        };
        let label = union
            .get("deviceLabel")
            .and_then(Value::as_str)
            .unwrap_or(FALLBACK_LEGACY_LABEL);
        let last_seen_at = union.get("capturedAt").and_then(Value::as_i64).unwrap_or(0);
        candidates.push(LegacyMachineCandidate::new(device_id, label, last_seen_at));
    }
    Ok(candidates)
}

#[derive(Clone)]
pub struct MachinesState {
    pub auth_token: Arc<String>,
    pub store: MachineStore,
}

/// Public REST contract used by the startup chooser and machine settings.
pub fn router(state: MachinesState) -> Router {
    Router::new()
        .route("/api/machines", get(list_machines).post(create_machine))
        .route("/api/machines/{machine_id}", patch(rename_machine))
        .with_state(state)
}

async fn list_machines(State(state): State<MachinesState>, headers: HeaderMap) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    Json(json!({ "machines": state.store.list() })).into_response()
}

async fn create_machine(
    State(state): State<MachinesState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let label = match body.get("label").and_then(Value::as_str) {
        Some(label) => label.to_string(),
        None => return invalid_machine_label(),
    };
    let store = state.store.clone();
    match tokio::task::spawn_blocking(move || store.create(&label)).await {
        Ok(Ok(machine)) => Json(json!({ "machine": machine })).into_response(),
        Ok(Err(error)) => mutation_error_response(error),
        Err(error) => {
            tracing::error!(target: "freshell_server::machines", error = %error,
                "machine_create_task_failed");
            machine_store_unavailable()
        }
    }
}

async fn rename_machine(
    State(state): State<MachinesState>,
    AxumPath(machine_id): AxumPath<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let label = match body.get("label").and_then(Value::as_str) {
        Some(label) => label.to_string(),
        None => return invalid_machine_label(),
    };
    let store = state.store.clone();
    match tokio::task::spawn_blocking(move || store.rename(&machine_id, &label)).await {
        Ok(Ok(machine)) => Json(json!({ "machine": machine })).into_response(),
        Ok(Err(error)) => mutation_error_response(error),
        Err(error) => {
            tracing::error!(target: "freshell_server::machines", error = %error,
                "machine_rename_task_failed");
            machine_store_unavailable()
        }
    }
}

fn invalid_machine_label() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": "machine label must be a non-empty string" })),
    )
        .into_response()
}

fn machine_store_unavailable() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "machine directory unavailable" })),
    )
        .into_response()
}

fn mutation_error_response(error: MachineMutationError) -> Response {
    match error {
        MachineMutationError::NotFound => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "machine not found" })),
        )
            .into_response(),
        MachineMutationError::InvalidLabel => invalid_machine_label(),
        MachineMutationError::Storage(error) => {
            tracing::error!(target: "freshell_server::machines", error = %error,
                "machine_directory_write_failed");
            machine_store_unavailable()
        }
    }
}

fn load_directory(
    paths: &MachineStorePaths,
) -> Result<(MachineDirectoryFile, bool), MachineStoreError> {
    paths.ensure_parent()?;
    match read_directory_file(&paths.state) {
        Ok(Some(directory)) => Ok((directory, false)),
        Ok(None) => match read_directory_file(&paths.backup) {
            Ok(Some(directory)) => {
                tracing::warn!(
                    target: "freshell_server::machines",
                    event = "machine_directory_recovered_from_backup",
                    state_path = %paths.state.display(),
                    "machine directory primary file missing; recovered backup"
                );
                Ok((directory, true))
            }
            Ok(None) => Ok((MachineDirectoryFile::default(), false)),
            Err(error) => reset_from_unreadable_state(paths, error),
        },
        Err(primary_error) => match read_directory_file(&paths.backup) {
            Ok(Some(directory)) => {
                archive_unreadable_primary(paths, &primary_error)?;
                tracing::warn!(
                    target: "freshell_server::machines",
                    event = "machine_directory_recovered_from_backup",
                    state_path = %paths.state.display(),
                    error = %primary_error,
                    "machine directory primary file unreadable; recovered backup"
                );
                Ok((directory, true))
            }
            Ok(None) | Err(_) => reset_from_unreadable_state(paths, primary_error),
        },
    }
}

fn reset_from_unreadable_state(
    paths: &MachineStorePaths,
    error: MachineStoreError,
) -> Result<(MachineDirectoryFile, bool), MachineStoreError> {
    archive_unreadable_primary(paths, &error)?;
    Ok((MachineDirectoryFile::default(), true))
}

fn archive_unreadable_primary(
    paths: &MachineStorePaths,
    error: &MachineStoreError,
) -> Result<(), MachineStoreError> {
    if paths.state.exists() {
        let archived = paths.state.with_file_name(format!(
            "state.json.corrupt-{}-{}",
            now_ms(),
            std::process::id()
        ));
        std::fs::rename(&paths.state, &archived)?;
        tracing::error!(
            target: "freshell_server::machines",
            event = "machine_directory_corrupt_state_archived",
            state_path = %paths.state.display(),
            archived_path = %archived.display(),
            error = %error,
            "machine directory unreadable state archived before recovery"
        );
    }
    Ok(())
}

fn read_directory_file(path: &Path) -> Result<Option<MachineDirectoryFile>, MachineStoreError> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(MachineStoreError::Io(error)),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| MachineStoreError::Invalid(format!("{}: {error}", path.display())))
}

fn persist_directory(
    paths: &MachineStorePaths,
    directory: &MachineDirectoryFile,
    preserve_previous: bool,
) -> Result<(), MachineStoreError> {
    paths.ensure_parent()?;
    if preserve_previous {
        if let Ok(Some(_)) = read_directory_file(&paths.state) {
            let bytes = std::fs::read(&paths.state)?;
            freshell_ws::tabs_persist::atomic_write_durable(
                &paths.backup,
                &paths.backup_tmp,
                &bytes,
            )?;
        }
    }
    let bytes = serde_json::to_vec(directory)
        .map_err(|error| MachineStoreError::Invalid(error.to_string()))?;
    freshell_ws::tabs_persist::atomic_write_durable(&paths.state, &paths.state_tmp, &bytes)?;
    Ok(())
}

fn normalize_directory(directory: &mut MachineDirectoryFile) -> Result<bool, MachineStoreError> {
    if directory.version != MACHINE_DIRECTORY_VERSION {
        return Err(MachineStoreError::Invalid(format!(
            "unsupported version {}",
            directory.version
        )));
    }
    let mut changed = false;
    let mut ids = HashSet::new();
    let mut labels = HashSet::new();
    for machine in &mut directory.machines {
        if machine.id.is_empty() {
            return Err(MachineStoreError::Invalid(
                "machine ID must not be empty".to_string(),
            ));
        }
        if !ids.insert(machine.id.clone()) {
            return Err(MachineStoreError::Invalid(format!(
                "duplicate machine ID {}",
                machine.id
            )));
        }
        if machine.created_at < 0 || machine.last_seen_at < 0 {
            return Err(MachineStoreError::Invalid(format!(
                "machine {} has a negative timestamp",
                machine.id
            )));
        }
        if machine.last_seen_at < machine.created_at {
            machine.last_seen_at = machine.created_at;
            changed = true;
        }
        let normalized = normalized_nonempty_label(&machine.label)
            .unwrap_or_else(|| FALLBACK_LEGACY_LABEL.to_string());
        let unique = unique_label(&normalized, &labels);
        if unique != machine.label {
            machine.label = unique.clone();
            changed = true;
        }
        labels.insert(unique.to_lowercase());
    }
    Ok(changed)
}

fn import_legacy_candidates(
    directory: &mut MachineDirectoryFile,
    candidates: Vec<LegacyMachineCandidate>,
) -> (usize, bool) {
    let mut imported = 0;
    let mut changed = false;
    let mut labels = occupied_labels(&directory.machines, None);
    // Once an administrator has named a persisted machine, its label is
    // authoritative. Only duplicate historical candidates discovered during
    // THIS import can refine an initially inferred label.
    let persisted_ids: HashSet<String> = directory
        .machines
        .iter()
        .map(|machine| machine.id.clone())
        .collect();
    for candidate in candidates {
        if candidate.id.is_empty() {
            tracing::warn!(
                target: "freshell_server::machines",
                event = "machine_directory_legacy_candidate_ignored",
                "ignored legacy machine candidate with an empty ID"
            );
            continue;
        }
        if let Some(index) = directory
            .machines
            .iter()
            .position(|machine| machine.id == candidate.id)
        {
            let existing_seen_at = directory.machines[index].last_seen_at;
            let existing_label = directory.machines[index].label.clone();
            let candidate_seen_at = candidate.last_seen_at.max(0);
            let candidate_label = normalized_nonempty_label(&candidate.label);
            let candidate_label_quality = candidate_label
                .as_deref()
                .map(legacy_label_quality)
                .unwrap_or(0);
            let existing_label_quality = legacy_label_quality(&existing_label);
            let should_replace_label = !persisted_ids.contains(&candidate.id)
                && candidate_label.is_some()
                && (candidate_label_quality > existing_label_quality
                    || (candidate_seen_at > existing_seen_at
                        && candidate_label_quality >= existing_label_quality));
            if should_replace_label {
                let occupied = occupied_labels(&directory.machines, Some(&candidate.id));
                let next_label = unique_label(
                    candidate_label.as_deref().expect("checked above"),
                    &occupied,
                );
                labels.remove(&existing_label.to_lowercase());
                labels.insert(next_label.to_lowercase());
                directory.machines[index].label = next_label;
                changed = true;
            }
            let next_seen_at = existing_seen_at.max(candidate_seen_at);
            if next_seen_at != existing_seen_at {
                directory.machines[index].last_seen_at = next_seen_at;
                changed = true;
            }
            continue;
        }
        let label = normalized_nonempty_label(&candidate.label)
            .unwrap_or_else(|| FALLBACK_LEGACY_LABEL.to_string());
        let label = unique_label(&label, &labels);
        labels.insert(label.to_lowercase());
        let seen = candidate.last_seen_at.max(0);
        directory.machines.push(Machine {
            id: candidate.id,
            label,
            created_at: seen,
            last_seen_at: seen,
        });
        imported += 1;
        changed = true;
    }
    (imported, changed)
}

fn normalized_nonempty_label(label: &str) -> Option<String> {
    let normalized = label.split_whitespace().collect::<Vec<_>>().join(" ");
    (!normalized.is_empty()).then_some(normalized)
}

fn legacy_label_quality(label: &str) -> u8 {
    match normalized_nonempty_label(label).as_deref() {
        None => 0,
        Some(FALLBACK_LEGACY_LABEL) => 1,
        Some(_) => 2,
    }
}

fn occupied_labels(machines: &[Machine], excluded_id: Option<&str>) -> HashSet<String> {
    machines
        .iter()
        .filter(|machine| Some(machine.id.as_str()) != excluded_id)
        .map(|machine| machine.label.to_lowercase())
        .collect()
}

fn unique_label(base: &str, occupied: &HashSet<String>) -> String {
    if !occupied.contains(&base.to_lowercase()) {
        return base.to_string();
    }
    for suffix in 2_u64.. {
        let candidate = format!("{base} {suffix}");
        if !occupied.contains(&candidate.to_lowercase()) {
            return candidate;
        }
    }
    unreachable!("u64 label suffixes cannot be exhausted")
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
#[path = "machines_tests.rs"]
mod tests;
