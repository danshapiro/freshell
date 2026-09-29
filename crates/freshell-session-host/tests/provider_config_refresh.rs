#[cfg(unix)]
#[test]
fn provider_uid_refresh_helper_updates_projection_without_erasing_provider_state() {
    use std::{fs, os::unix::fs::PermissionsExt, process::Command};

    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o755)).unwrap();
    let home = root.path().join("provider-home");
    let stage = root.path().join("stage");
    let plugins = home.join(".claude/plugins");
    let staged_plugins = stage.join("projection/.claude/plugins");
    fs::create_dir_all(&plugins).unwrap();
    fs::create_dir_all(&staged_plugins).unwrap();
    fs::write(plugins.join("old.js"), b"old").unwrap();
    fs::write(plugins.join("provider-created.js"), b"durable").unwrap();
    fs::write(staged_plugins.join("new.js"), b"new").unwrap();
    fs::write(
        home.join(".freshell-config-projection.json"),
        br#"[".claude",".claude/plugins",".claude/plugins/old.js"]"#,
    )
    .unwrap();
    fs::write(
        stage.join("projection/.freshell-config-projection.json"),
        br#"[".claude",".claude/plugins",".claude/plugins/new.js"]"#,
    )
    .unwrap();
    fs::write(stage.join("manifest.json"), br#"[".claude/plugins"]"#).unwrap();

    let uid = unsafe { libc::geteuid() };
    let gid = unsafe { libc::getegid() };
    let status = Command::new("/usr/bin/setpriv")
        .args([
            "--reuid",
            &uid.to_string(),
            "--regid",
            &gid.to_string(),
            "--keep-groups",
            "--no-new-privs",
            "--",
        ])
        .arg(env!("CARGO_BIN_EXE_freshell-session-host"))
        .arg("refresh-provider-config")
        .arg(&stage)
        .arg(&home)
        .status()
        .unwrap();
    assert!(
        status.success(),
        "provider UID/GID refresh helper failed: {status}"
    );
    assert!(!plugins.join("old.js").exists());
    assert_eq!(fs::read(plugins.join("new.js")).unwrap(), b"new");
    assert_eq!(
        fs::read(plugins.join("provider-created.js")).unwrap(),
        b"durable"
    );
}
