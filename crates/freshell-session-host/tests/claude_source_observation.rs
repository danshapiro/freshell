#![cfg(unix)]

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{os::unix::process::CommandExt, path::Path, process::Stdio, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn read_metadata(cwd: &Path, home: &Path, request: &[u8]) -> Result<Vec<u8>, &'static str> {
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_freshell-session-host"));
    command
        .arg("observe-claude-sources")
        .current_dir(cwd)
        .env_clear()
        .env("HOME", home)
        .env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    command.as_std_mut().process_group(0);
    let mut child = command
        .spawn()
        .map_err(|_| "owned reader could not start")?;
    let mut input = child.stdin.take().unwrap();
    let mut output = child.stdout.take().unwrap();
    let operation = async {
        input
            .write_u32(request.len() as u32)
            .await
            .map_err(|_| "request header failed")?;
        input
            .write_all(request)
            .await
            .map_err(|_| "request body failed")?;
        drop(input);
        let length = output
            .read_u32()
            .await
            .map_err(|_| "response header unavailable")? as usize;
        if length > 1024 * 1024 {
            return Err("response exceeds metadata profile");
        }
        let mut bytes = vec![0; length];
        output
            .read_exact(&mut bytes)
            .await
            .map_err(|_| "response body incomplete")?;
        let mut trailing = [0];
        if output
            .read(&mut trailing)
            .await
            .map_err(|_| "completion unavailable")?
            != 0
        {
            return Err("reader emitted an extra frame");
        }
        Ok(bytes)
    };
    let result = tokio::time::timeout(Duration::from_secs(10), operation).await;
    if !matches!(result, Ok(Ok(_))) {
        let _ = child.kill().await;
    }
    let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .map_err(|_| "owned reader join timed out")?
        .map_err(|_| "owned reader join failed")?;
    if !status.success() {
        return Err("reader failed without complete evidence");
    }
    result.map_err(|_| "reader timed out")?
}

#[tokio::test]
async fn session_host_claude_observer_returns_bound_metadata_without_consuming_settings() {
    let owned = tempfile::tempdir().unwrap();
    let root = owned.path().join("root");
    let home = owned.path().join("home");
    let cwd = root.join("nested");
    for path in [
        &home,
        &root.join(".git"),
        &root.join(".claude"),
        &cwd.join(".claude"),
    ] {
        std::fs::create_dir_all(path).unwrap();
    }
    let poison = b"PRIVATE_METADATA_ONLY_SETTINGS_SENTINEL: invalid JSON";
    let selected = root.join(".claude/settings.local.json");
    std::fs::write(&selected, poison).unwrap();
    for runtime in ["terminal", "sdk"] {
        let request = serde_json::to_vec(&json!({
            "version":1,"requestId":uuid::Uuid::new_v4().to_string(),
            "nativeSourceRuntime":runtime,"cwd":cwd,"home":home,"settingSources":["local"],
            "selectorManifestSha256":"a".repeat(64),"planRevision":0
        }))
        .unwrap();
        let bytes = read_metadata(&cwd, &home, &request)
            .await
            .expect("the production reader must return complete bound metadata");
        assert!(!bytes.windows(poison.len()).any(|window| window == poison));
        let reply: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            reply["requestSha256"],
            format!("{:x}", Sha256::digest(&request))
        );
        let observed: freshell_platform::claude_inputs::observation::NativeObservation =
            serde_json::from_value(reply["observation"].clone()).unwrap();
        observed.validate().unwrap();
        assert_eq!(observed.uid, unsafe { libc::getuid() });
        assert_eq!(observed.euid, unsafe { libc::geteuid() });
        assert_eq!(observed.gid, unsafe { libc::getgid() });
        assert_eq!(observed.egid, unsafe { libc::getegid() });
        assert_eq!(
            observed.local_settings,
            [cwd.join(".claude/settings.local.json"), selected.clone()]
        );
        assert!(
            std::fs::read(&selected).unwrap() == poison,
            "metadata observation must retain the private settings file"
        );
    }
}

#[tokio::test]
async fn session_host_claude_observer_rejects_a_different_native_cwd_or_home_and_retains_inputs() {
    let owned = tempfile::tempdir().unwrap();
    let cwd = owned.path().join("actual-cwd");
    let other_cwd = owned.path().join("other-cwd");
    let home = owned.path().join("actual-home");
    let other_home = owned.path().join("other-home");
    for path in [&cwd, &other_cwd, &home, &other_home] {
        std::fs::create_dir(path).unwrap();
    }
    let prior = home.join("accepted-prior-inputs");
    std::fs::write(&prior, b"immutable-prior-inputs").unwrap();
    for role in ["cwd", "home"] {
        let request = serde_json::to_vec(&json!({
            "version":1,"requestId":uuid::Uuid::new_v4().to_string(),"nativeSourceRuntime":"terminal",
            "cwd":if role == "cwd" { &other_cwd } else { &cwd },
            "home":if role == "home" { &other_home } else { &home },
            "settingSources":["local"],"selectorManifestSha256":"b".repeat(64),"planRevision":0
        })).unwrap();
        assert!(
            read_metadata(&cwd, &home, &request).await.is_err(),
            "a request for another native {role} must not become source-selection evidence"
        );
        assert_eq!(std::fs::read(&prior).unwrap(), b"immutable-prior-inputs");
    }
}
