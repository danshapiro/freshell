use freshell_runtime_protocol::{
    RetainedStoreCompatibilityReceipt, RetainedStoreCompatibilityRequest,
};
use std::path::Path;

pub(crate) fn run(args: &[String]) -> Result<(), String> {
    let encoded = args
        .first()
        .filter(|_| args.len() == 1)
        .ok_or("retained-store worker requires one bounded request")?;
    if encoded.len() > 8192 {
        return Err("retained-store request exceeds its bound".into());
    }
    let request: RetainedStoreCompatibilityRequest =
        serde_json::from_str(encoded).map_err(|_| "retained-store request is invalid")?;
    pinned_version_probe(&mut std::process::Command::new("opencode"))?;
    let receipt = qualify(&request)?;
    serde_json::to_writer(std::io::stdout(), &receipt)
        .map_err(|_| "retained-store receipt could not be written".into())
}

fn pinned_version_probe(command: &mut std::process::Command) -> Result<(), String> {
    // Native startup initializes HOME even for --version. Keep that work
    // separate from the receipt-owned provider volume, which stays read-only.
    let home = tempfile::tempdir().map_err(|_| "current-image version HOME cannot be staged")?;
    command
        .env("HOME", home.path())
        .env("XDG_DATA_HOME", home.path().join(".local/share"))
        .env("XDG_CONFIG_HOME", home.path().join(".config"))
        .env("XDG_STATE_HOME", home.path().join(".local/state"))
        .env("XDG_CACHE_HOME", home.path().join(".cache"))
        .env_remove("OPENCODE_DB");
    let version = command
        .arg("--version")
        .output()
        .map_err(|_| "current-image OpenCode executable is unavailable")?;
    let expected = freshell_agent_runtime::pinned_provider_version("opencode")
        .ok_or("current-image OpenCode pin is unavailable")?;
    if !version.status.success()
        || std::str::from_utf8(&version.stdout).ok().map(str::trim) != Some(expected.as_str())
    {
        return Err("current-image OpenCode executable does not match its pin".into());
    }
    Ok(())
}

fn source_blocker(error: &freshell_sessions::opencode_transfer::TransferError) -> &'static str {
    use freshell_sessions::opencode_transfer::TransferError;
    match error {
        TransferError::Io(_) => "source_io_unavailable",
        TransferError::Sqlite(_) => "sqlite_source_unavailable",
        TransferError::Serialization(_) => "native_row_unreadable",
        TransferError::Blocked(reason)
            if reason.contains("schema") || reason.contains("migration") =>
        {
            "unsupported_schema_or_migration"
        }
        TransferError::Blocked(reason)
            if ["workspace", "asset", "file", "tool-output"]
                .iter()
                .any(|name| reason.contains(name)) =>
        {
            "workspace_or_asset_unavailable"
        }
        TransferError::Blocked(reason)
            if ["root", "session", "closure", "inventory"]
                .iter()
                .any(|name| reason.contains(name)) =>
        {
            "exact_graph_unavailable"
        }
        TransferError::Blocked(_) => "source_qualification_pending",
    }
}

fn qualify(
    request: &RetainedStoreCompatibilityRequest,
) -> Result<RetainedStoreCompatibilityReceipt, String> {
    use freshell_sessions::opencode_transfer::{
        export_exact_session, ExportOptions, HostOpenCodeInventory,
    };
    super::validate_opencode_helper_identity(request.provider_uid, request.provider_gid)?;
    if request.provider_store_id.is_empty()
        || request.native_session_id.is_empty()
        || request.image_ref.len() != 71
        || !request.image_ref.starts_with("sha256:")
    {
        return Err("retained-store request has no exact identity or current-image binding".into());
    }
    let home = Path::new(&request.provider_home);
    let workspace = Path::new(&request.workspace_path);
    let cwd = Path::new(&request.cwd);
    let env = std::collections::BTreeMap::from([
        ("HOME".into(), request.provider_home.clone()),
        (
            "XDG_DATA_HOME".into(),
            home.join(".local/share").to_string_lossy().into(),
        ),
        (
            "XDG_CONFIG_HOME".into(),
            home.join(".config").to_string_lossy().into(),
        ),
        (
            "OPENCODE_DB".into(),
            home.join(".local/share/opencode/opencode.db")
                .to_string_lossy()
                .into(),
        ),
    ]);
    let paths = super::validate_opencode_reader_paths_at(&env, workspace, cwd, home)?;
    let temporary =
        tempfile::tempdir().map_err(|_| "retained-store extraction could not be staged")?;
    let snapshot=export_exact_session(&HostOpenCodeInventory::new(paths.database).with_trusted_mount_for_selected_session(paths.cwd),&request.native_session_id,ExportOptions::new(temporary.path().join("extraction"))).map_err(|error|format!("retained OpenCode qualification blocked ({}); preserve the store and repair the dependency",source_blocker(&error)))?;
    let manifest = snapshot.manifest();
    Ok(RetainedStoreCompatibilityReceipt {
        request: request.clone(),
        provider_version: freshell_agent_runtime::pinned_provider_version("opencode")
            .ok_or("OpenCode pin is unavailable")?,
        source_schema_fingerprint: manifest.source_schema_fingerprint.clone(),
        migration_journal_fingerprint: manifest.migration_journal_fingerprint.clone(),
        generation: manifest.generation.clone(),
        row_count: manifest.row_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_version_probe_uses_disposable_home_without_changing_retained_store() {
        use std::os::unix::fs::PermissionsExt;
        let root = crate::tests::executable_fixture();
        let home = root.path().join("retained");
        std::fs::create_dir(&home).unwrap();
        let database = home.join("saved-native.db");
        std::fs::write(&database, b"retained native state").unwrap();
        let cli = root.path().join("native-version-cli");
        std::fs::write(&cli,"#!/bin/sh\nset -eu\ntest \"$1\" = --version\nmkdir -p \"$HOME/native-cli-initialized\"\nif test -n \"${OPENCODE_DB:-}\"; then printf changed >> \"$OPENCODE_DB\"; fi\nprintf '1.18.21\\n'\n").unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut command = std::process::Command::new(&cli);
        command
            .env("HOME", &home)
            .env("OPENCODE_DB", &database)
            .env("XDG_DATA_HOME", home.join(".local/share"))
            .env("XDG_CONFIG_HOME", home.join(".config"));
        pinned_version_probe(&mut command).unwrap();
        assert_eq!(
            std::fs::read(&database).unwrap(),
            b"retained native state",
            "version initialization cannot write the saved provider database"
        );
        assert!(
            !home.join("native-cli-initialized").exists(),
            "native version initialization belongs in creator-owned scratch HOME"
        );
    }

    #[test]
    fn retained_store_qualifies_exact_graph_and_refuses_unknown_schema_without_writes() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("provider");
        let workspace = root.path().join("workspace");
        std::fs::create_dir_all(home.join(".local/share/opencode")).unwrap();
        std::fs::create_dir_all(home.join(".config")).unwrap();
        std::fs::create_dir(&workspace).unwrap();
        let database = home.join(".local/share/opencode/opencode.db");
        let conn = rusqlite::Connection::open(&database).unwrap();
        conn.execute_batch(freshell_sessions::opencode_transfer::pinned_destination_schema_sql())
            .unwrap();
        for migration in freshell_sessions::opencode_transfer::pinned_destination_migration_ids() {
            conn.execute(
                "INSERT INTO migration (id,time_completed) VALUES (?1,0)",
                [migration],
            )
            .unwrap();
        }
        conn.execute("INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES ('project',?1,1,1,'{}')",[workspace.to_string_lossy().as_ref()]).unwrap();
        conn.execute("INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated) VALUES ('ses_exact','project','slug',?1,'synthetic','1.18.21',1,1)",[workspace.to_string_lossy().as_ref()]).unwrap();
        conn.execute("INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ('msg_exact','ses_exact',1,1,'{}')",[]).unwrap();
        drop(conn);
        let before = std::fs::read(&database).unwrap();
        let request = RetainedStoreCompatibilityRequest {
            provider_store_id: "exact-store".into(),
            native_session_id: "ses_exact".into(),
            image_ref: format!("sha256:{}", "a".repeat(64)),
            provider_home: home.to_string_lossy().into(),
            workspace_path: workspace.to_string_lossy().into(),
            cwd: workspace.to_string_lossy().into(),
            provider_uid: unsafe { libc::geteuid() },
            provider_gid: unsafe { libc::getegid() },
        };
        let receipt = qualify(&request).unwrap();
        assert_eq!(receipt.request, request);
        assert!(receipt.row_count >= 3);
        assert_eq!(
            std::fs::read(&database).unwrap(),
            before,
            "qualification must preserve the retained store"
        );
        let mut missing = request.clone();
        missing.native_session_id = "ses_missing".into();
        assert!(qualify(&missing)
            .unwrap_err()
            .contains("exact_graph_unavailable"));
        let conn = rusqlite::Connection::open(&database).unwrap();
        conn.execute_batch("CREATE TABLE unsupported_schema (id TEXT)")
            .unwrap();
        drop(conn);
        let unsupported = std::fs::read(&database).unwrap();
        assert!(
            qualify(&request)
                .unwrap_err()
                .contains("unsupported_schema_or_migration"),
            "unknown provider schema must remain precisely blocked"
        );
        assert_eq!(std::fs::read(&database).unwrap(), unsupported);
    }
}
