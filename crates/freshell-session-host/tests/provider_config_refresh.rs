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

#[cfg(unix)]
#[test]
fn provider_config_spawned_helper_emits_safe_jsonl_for_success_and_typed_failure() {
    use std::{fs, process::Command};
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let stage = root.path().join("stage");
    fs::create_dir(&home).unwrap();
    fs::create_dir_all(stage.join("projection/skills")).unwrap();
    fs::write(stage.join("provider.json"), r#""codex""#).unwrap();
    fs::write(stage.join("manifest.json"), r#"["skills"]"#).unwrap();
    fs::write(
        stage.join("projection/.freshell-config-projection.json"),
        r#"["skills","skills/config"]"#,
    )
    .unwrap();
    let marker = "synthetic-config-secret-outgoing-message-marker";
    fs::write(stage.join("projection/skills/config"), marker).unwrap();
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_freshell-session-host"))
            .arg("refresh-provider-config")
            .arg(&stage)
            .arg(&home)
            .output()
            .unwrap()
    };
    let success = run();
    assert!(success.status.success(), "{success:?}");
    assert!(
        success.stdout.is_empty(),
        "logging must preserve protocol stdout"
    );
    assert_eq!(
        fs::read(home.join("skills/config")).unwrap(),
        marker.as_bytes()
    );
    let parse = |bytes: &[u8]| -> Vec<serde_json::Value> {
        let text = std::str::from_utf8(bytes).unwrap();
        assert!(!text.contains(marker));
        text.lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    };
    let events = parse(&success.stderr);
    assert_eq!(events.len(), 2, "copy logs must be per-operation");
    for event in &events {
        eprintln!("{event}");
    }
    let started = events
        .iter()
        .find(|event| event["event"] == "provider.environment.copy.started")
        .expect("actual helper must emit copy start");
    assert_eq!(started["provider"], "codex");
    assert_eq!(started["stage"], "provider_publication");
    assert_eq!(started["selections"], 1);
    let completed = events
        .iter()
        .find(|event| event["event"] == "provider.environment.copy.completed")
        .expect("actual helper must emit completion");
    assert_eq!(completed["provider"], "codex");
    assert_eq!(completed["stage"], "provider_publication");
    assert!(completed["entries"].as_u64().unwrap() >= 2);
    assert_eq!(completed["bytes"], marker.len());
    assert!(completed["elapsed_ms"].as_u64().is_some());
    // An oversized sparse fixture fails during planning without reading contents.
    fs::File::create(stage.join("projection/skills/oversized"))
        .unwrap()
        .set_len(128 * 1024 * 1024 + 1)
        .unwrap();
    let failed = run();
    assert!(!failed.status.success());
    assert!(failed.stdout.is_empty());
    let events = parse(&failed.stderr);
    assert_eq!(events.len(), 3, "start, typed failure and final fatal only");
    for event in &events {
        eprintln!("{event}");
    }
    let failure = events
        .iter()
        .find(|event| event["event"] == "provider.environment.copy.failed")
        .expect("actual helper must emit typed copy failure");
    assert_eq!(failure["provider"], "codex");
    assert_eq!(failure["stage"], "provider_publication");
    assert_eq!(failure["relative_path"], "skills/oversized");
    assert!(failure["operation"].as_str().is_some());
    assert_eq!(failure["limit_kind"], "file_bytes");
    assert_eq!(failure["observed"], 128 * 1024 * 1024 + 1_u64);
    assert_eq!(failure["permitted"], 128 * 1024 * 1024_u64);
    assert!(failure["corrective_message"].as_str().is_some());
    assert!(failure["elapsed_ms"].as_u64().is_some());
    assert_eq!(
        fs::read(home.join("skills/config")).unwrap(),
        marker.as_bytes()
    );
}
