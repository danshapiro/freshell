//! Reversible managed-runtime rollout planning and read-only legacy import.
//!
//! Rollout state is operational routing policy, not ownership authority. A
//! transition never deletes the registry, provider volumes, legacy metadata,
//! or running managed hosts. `managed-default` additionally requires a
//! verified consistent SQLite backup before the mode row is updated.

use crate::{
    notice_outbox::increment_counter_in_tx,
    registry::{Registry, RegistryError},
};
use freshell_runtime_protocol::{
    ManagedRolloutMode, MigrationId, MigrationPlan, MigrationPlanRequest, RuntimeLimits,
};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

const MAX_LEGACY_IMPORT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_LEGACY_IMPORT_FILES: usize = 10_000;

impl Registry {
    pub async fn plan_or_apply_migration(
        &self,
        request: MigrationPlanRequest,
        controller_ready: bool,
        image_verified: bool,
    ) -> Result<MigrationPlan, RegistryError> {
        self.assert_epoch(request.expected_control_epoch)?;
        let db_path = self.database_path().to_path_buf();
        let legacy = request.legacy_metadata_path.clone();
        let requested_mode = request.requested_mode;
        let apply = request.apply;
        let migration_id = MigrationId::new();
        let backup_request = request.backup_path.clone();

        self.run_blocking(move |mut conn| {
            let current_mode = current_rollout_mode(&conn)?;
            let (managed_soul_count, projected_cpu_milli, projected_memory_bytes, projected_pids) =
                resource_preview(&conn)?;
            let (legacy_metadata_count, legacy_blocker) = match legacy.as_deref() {
                Some(path) => match count_legacy_metadata(Path::new(path)) {
                    Ok(count) => (count, None),
                    Err(error) => (0, Some(error)),
                },
                None => (0, None),
            };
            let registry_backup_required = apply
                && requested_mode == ManagedRolloutMode::ManagedDefault
                && current_mode != ManagedRolloutMode::ManagedDefault;
            let mut blockers = Vec::new();
            if !controller_ready {
                blockers.push("managed runtime controller is not ready".into());
            }
            if !image_verified {
                blockers.push("runtime image identity is not verified".into());
            }
            if let Some(error) = legacy_blocker {
                blockers.push(format!("legacy metadata preflight failed: {error}"));
            }
            if registry_backup_required && backup_request.as_deref().is_none_or(str::is_empty) {
                blockers.push("managed-default requires an explicit registry backup path".into());
            }

            let mut backup_path = None;
            let mut backup_verified = false;
            if apply && blockers.is_empty() && registry_backup_required {
                let requested = backup_request
                    .as_deref()
                    .expect("backup requirement checked above");
                let resolved = resolve_backup_path(requested, &migration_id)?;
                create_verified_backup(&mut conn, &db_path, &resolved)?;
                backup_verified = true;
                backup_path = Some(resolved.to_string_lossy().into_owned());
            } else if let Some(requested) = backup_request.as_deref().filter(|value| !value.is_empty()) {
                backup_path = Some(
                    preview_backup_path(requested, &migration_id)?
                        .to_string_lossy()
                        .into_owned(),
                );
            }

            let mut plan = MigrationPlan {
                migration_id: migration_id.clone(),
                current_mode,
                requested_mode,
                dry_run: !apply,
                controller_ready,
                image_verified,
                registry_backup_required,
                registry_backup_verified: backup_verified,
                registry_backup_path: backup_path.clone(),
                managed_soul_count,
                legacy_metadata_count,
                projected_cpu_milli,
                projected_memory_bytes,
                projected_pids,
                blockers,
            };

            if apply {
                if !plan.blockers.is_empty() {
                    return Err(RegistryError::MigrationBlocked(
                        plan.blockers.join("; "),
                    ));
                }
                // The backup uses VACUUM INTO on the same connection. Only
                // after it verifies do we begin the small mode transaction.
                let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
                let now = crate::registry::now_millis();
                tx.execute(
                    "UPDATE rollout_state SET mode=?1,updated_at=?2 WHERE singleton=1",
                    params![rollout_mode_name(requested_mode), now],
                )?;
                let plan_json = serde_json::to_string(&plan)?;
                tx.execute(
                    "INSERT INTO migration_runs \
                     (migration_id,current_mode,requested_mode,dry_run,plan_json,backup_path,applied_at,created_at) \
                     VALUES (?1,?2,?3,0,?4,?5,?6,?6)",
                    params![
                        migration_id.as_str(),
                        rollout_mode_name(current_mode),
                        rollout_mode_name(requested_mode),
                        plan_json,
                        backup_path,
                        now
                    ],
                )?;
                increment_counter_in_tx(
                    &tx,
                    "migration_outcome",
                    rollout_mode_name(requested_mode),
                    1,
                    now,
                )?;
                tx.commit()?;
                plan.current_mode = requested_mode;
            }
            Ok(plan)
        })
        .await
    }

    pub async fn rollout_mode(&self) -> Result<ManagedRolloutMode, RegistryError> {
        self.run_blocking(|conn| current_rollout_mode(&conn)).await
    }
}

fn current_rollout_mode(conn: &Connection) -> Result<ManagedRolloutMode, RegistryError> {
    let value = conn
        .query_row(
            "SELECT mode FROM rollout_state WHERE singleton=1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .unwrap_or_else(|| "legacy".into());
    parse_rollout_mode(&value)
}

fn resource_preview(conn: &Connection) -> Result<(u64, u64, u64, u64), RegistryError> {
    let mut statement = conn.prepare(
        "SELECT COALESCE(configured_limits,(SELECT requested_limits FROM incarnations i \
         WHERE i.soul_id=s.soul_id ORDER BY i.created_at DESC LIMIT 1)) \
         FROM souls s WHERE desired_state='running'",
    )?;
    let rows = statement.query_map([], |row| row.get::<_, Option<String>>(0))?;
    let mut count = 0_u64;
    let mut cpu = 0_u64;
    let mut memory = 0_u64;
    let mut pids = 0_u64;
    for row in rows {
        let Some(encoded) = row? else {
            continue;
        };
        let limits: RuntimeLimits = serde_json::from_str(&encoded)?;
        count = count.saturating_add(1);
        cpu = cpu.saturating_add(limits.cpu_milli);
        memory = memory.saturating_add(limits.memory_bytes);
        pids = pids.saturating_add(limits.pids_max);
    }
    Ok((count, cpu, memory, pids))
}

fn preview_backup_path(
    requested: &str,
    migration_id: &MigrationId,
) -> Result<PathBuf, RegistryError> {
    let requested = PathBuf::from(requested);
    if !requested.is_absolute() {
        return Err(RegistryError::InvalidState(
            "registry backup path must be absolute".into(),
        ));
    }
    Ok(if requested.is_dir() || requested.extension().is_none() {
        requested.join(format!("runtime-{}.sqlite3", migration_id.as_str()))
    } else {
        requested
    })
}

fn resolve_backup_path(
    requested: &str,
    migration_id: &MigrationId,
) -> Result<PathBuf, RegistryError> {
    let requested = PathBuf::from(requested);
    if !requested.is_absolute() {
        return Err(RegistryError::InvalidState(
            "registry backup path must be absolute".into(),
        ));
    }
    let resolved = if requested.is_dir() || requested.extension().is_none() {
        fs::create_dir_all(&requested)?;
        requested.join(format!("runtime-{}.sqlite3", migration_id.as_str()))
    } else {
        if let Some(parent) = requested.parent() {
            fs::create_dir_all(parent)?;
        }
        requested
    };
    if resolved.exists() {
        return Err(RegistryError::InvalidState(format!(
            "registry backup already exists: {}",
            resolved.display()
        )));
    }
    Ok(resolved)
}

fn create_verified_backup(
    conn: &mut Connection,
    source: &Path,
    target: &Path,
) -> Result<(), RegistryError> {
    if source == target {
        return Err(RegistryError::InvalidState(
            "registry backup cannot overwrite the active database".into(),
        ));
    }
    conn.execute_batch("PRAGMA wal_checkpoint(FULL);")?;
    if let Err(error) = conn.execute("VACUUM INTO ?1", params![target.to_string_lossy()]) {
        let _ = fs::remove_file(target);
        return Err(error.into());
    }
    fs::set_permissions(target, fs::Permissions::from_mode(0o600))?;
    let backup = Connection::open_with_flags(
        target,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let integrity: String = backup.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    let schema: u32 = backup.query_row(
        "SELECT schema_version FROM installation WHERE singleton=1",
        [],
        |row| row.get(0),
    )?;
    if integrity != "ok" || schema != crate::registry::SCHEMA_VERSION {
        let _ = fs::remove_file(target);
        return Err(RegistryError::Integrity(format!(
            "registry backup verification failed: integrity={integrity} schema={schema}"
        )));
    }
    std::fs::File::open(target)?.sync_all()?;
    if let Some(parent) = target.parent() {
        std::fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn count_legacy_metadata(path: &Path) -> Result<u64, String> {
    if !path.exists() {
        return Err(format!("{} does not exist", path.display()));
    }
    if path.is_file() {
        return count_legacy_file(path);
    }
    if !path.is_dir() {
        return Err(format!(
            "{} is neither a file nor directory",
            path.display()
        ));
    }
    let mut count = 0_u64;
    let mut files = 0_usize;
    let mut bytes = 0_u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(directory) = stack.pop() {
        for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let metadata = entry.metadata().map_err(|error| error.to_string())?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                stack.push(entry.path());
                continue;
            }
            let entry_path = entry.path();
            let extension = entry_path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if !matches!(extension, "json" | "jsonl") {
                continue;
            }
            files += 1;
            bytes = bytes.saturating_add(metadata.len());
            if files > MAX_LEGACY_IMPORT_FILES || bytes > MAX_LEGACY_IMPORT_BYTES {
                return Err("legacy metadata exceeds bounded dry-run limits".into());
            }
            count = count.saturating_add(count_legacy_file(&entry_path)?);
        }
    }
    Ok(count)
}

fn count_legacy_file(path: &Path) -> Result<u64, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_LEGACY_IMPORT_BYTES {
        return Err(format!(
            "{} exceeds legacy metadata byte cap",
            path.display()
        ));
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
        let mut count = 0_u64;
        for line in content.lines().filter(|line| !line.trim().is_empty()) {
            serde_json::from_str::<serde_json::Value>(line)
                .map_err(|error| format!("{}: {error}", path.display()))?;
            count = count.saturating_add(1);
        }
        return Ok(count);
    }
    let value: serde_json::Value =
        serde_json::from_str(&content).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(match value {
        serde_json::Value::Array(values) => values.len() as u64,
        serde_json::Value::Object(values) => values
            .get("records")
            .and_then(serde_json::Value::as_array)
            .map_or(1, |records| records.len() as u64),
        _ => 0,
    })
}

fn rollout_mode_name(mode: ManagedRolloutMode) -> &'static str {
    match mode {
        ManagedRolloutMode::Legacy => "legacy",
        ManagedRolloutMode::ManagedOptIn => "managed-opt-in",
        ManagedRolloutMode::ManagedDefault => "managed-default",
    }
}

fn parse_rollout_mode(value: &str) -> Result<ManagedRolloutMode, RegistryError> {
    match value {
        "legacy" => Ok(ManagedRolloutMode::Legacy),
        "managed-opt-in" => Ok(ManagedRolloutMode::ManagedOptIn),
        "managed-default" => Ok(ManagedRolloutMode::ManagedDefault),
        other => Err(RegistryError::Integrity(format!(
            "unknown managed rollout mode {other}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_import_is_read_only_and_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("tabs.jsonl");
        fs::write(&file, "{\"id\":1}\n{\"id\":2}\n").unwrap();
        let before = fs::read(&file).unwrap();
        assert_eq!(count_legacy_metadata(&file).unwrap(), 2);
        assert_eq!(fs::read(&file).unwrap(), before);
    }

    #[test]
    fn rollout_names_are_exact_and_reversible() {
        for mode in [
            ManagedRolloutMode::Legacy,
            ManagedRolloutMode::ManagedOptIn,
            ManagedRolloutMode::ManagedDefault,
        ] {
            assert_eq!(parse_rollout_mode(rollout_mode_name(mode)).unwrap(), mode);
        }
    }
    #[tokio::test]
    async fn dry_run_does_not_create_backup_directory_or_mutate_rollout() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path().join("registry"), None).unwrap();
        let backup_dir = dir.path().join("does-not-exist-yet");
        let plan = registry
            .plan_or_apply_migration(
                MigrationPlanRequest {
                    requested_mode: ManagedRolloutMode::ManagedDefault,
                    apply: false,
                    backup_path: Some(backup_dir.to_string_lossy().into_owned()),
                    legacy_metadata_path: None,
                    expected_control_epoch: Some(registry.control_epoch()),
                },
                true,
                true,
            )
            .await
            .unwrap();
        assert!(plan.dry_run);
        assert!(!backup_dir.exists());
        assert_eq!(
            registry.rollout_mode().await.unwrap(),
            ManagedRolloutMode::Legacy
        );
    }
}
