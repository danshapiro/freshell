//! Current-launch binding for provider-origin loader acknowledgements.
//! This module does not select sessions or infer identity from retained files.

use freshell_runtime_protocol::{
    NativeIdentityLaunch, NativeIdentityObservation, NativeIdentitySource,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const LAUNCH_ENV: &str = "FRESHELL_NATIVE_IDENTITY_LAUNCH";
pub const SIGNAL_DIR_ENV: &str = "FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR";

pub fn bind_provider_observation(
    launch: &NativeIdentityLaunch,
    native_session_id: &str,
    source: NativeIdentitySource,
    body_free_evidence: &Value,
) -> Option<NativeIdentityObservation> {
    let observation = NativeIdentityObservation {
        native_session_id: native_session_id.into(),
        incarnation_id: launch.incarnation_id.clone(),
        launch_nonce: launch.launch_nonce.clone(),
        evidence_revision: launch.evidence_revision,
        source,
        evidence_digest: format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(body_free_evidence).ok()?)
        ),
    };
    observation.matches_launch(launch).then_some(observation)
}

pub fn launch_from_environment(
    environment: &std::collections::BTreeMap<String, String>,
) -> Result<Option<NativeIdentityLaunch>, String> {
    environment
        .get(LAUNCH_ENV)
        .map(|value| {
            let launch: NativeIdentityLaunch = serde_json::from_str(value)
                .map_err(|_| "native launch binding is malformed".to_string())?;
            if launch.launch_nonce.is_empty() || launch.execution_generation == 0 {
                return Err("native launch binding is incomplete".into());
            }
            Ok(launch)
        })
        .transpose()
}

pub fn signal_directory(
    home: &std::path::Path,
    launch: &NativeIdentityLaunch,
) -> Result<std::path::PathBuf, String> {
    if !launch
        .launch_nonce
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err("native launch nonce is not a path component".into());
    }
    Ok(home
        .join(".freshell/native-identity")
        .join(&launch.launch_nonce))
}

fn read_signal(path: &std::path::Path) -> Result<Option<Value>, String> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("native signal is unreadable".into()),
    };
    if !metadata.is_file() || metadata.len() > 65_536 {
        return Err("native signal is not a bounded regular file".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "native signal read failed")?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "native signal is malformed".into())
}

pub fn read_claude_observation(
    path: &std::path::Path,
    uid: u32,
    gid: u32,
    launch: &NativeIdentityLaunch,
    expected_source: &str,
    expected_cwd: &std::path::Path,
) -> Result<Option<NativeIdentityObservation>, String> {
    let value = read_signal_as_provider(path, uid, gid)?;
    let Some(value) = value else { return Ok(None) };
    let actual: NativeIdentityLaunch = serde_json::from_value(value["launch"].clone())
        .map_err(|_| "native signal lacks a typed launch")?;
    if &actual != launch {
        return Ok(None);
    }
    let native = &value["native"];
    if native["hook_event_name"] != "SessionStart" || native["source"] != expected_source {
        return Ok(None);
    }
    let Some(root) = native["session_id"]
        .as_str()
        .filter(|root| uuid::Uuid::parse_str(root).is_ok())
    else {
        return Ok(None);
    };
    let Some(loaded) =
        read_signal_as_provider(&path.with_file_name("statusline-loaded.json"), uid, gid)?
    else {
        return Ok(None);
    };
    let loaded_launch: NativeIdentityLaunch = serde_json::from_value(loaded["launch"].clone())
        .map_err(|_| "native post-load signal lacks a typed launch")?;
    let status = &loaded["native"];
    let cwd = expected_cwd.to_string_lossy();
    if &loaded_launch != launch
        || status["session_id"] != root
        || status["transcript_path"] != native["transcript_path"]
        || !status["transcript_path"]
            .as_str()
            .is_some_and(|path| std::path::Path::new(path).is_absolute())
        || native["cwd"] != cwd.as_ref()
        || status["workspace"]["current_dir"] != cwd.as_ref()
        || status["version"] != "2.1.263"
        || status["model"]["id"]
            .as_str()
            .is_none_or(|id| id.is_empty())
        || status["context_window"]["context_window_size"]
            .as_u64()
            .is_none_or(|size| size == 0)
        || !status["context_window"]
            .as_object()
            .is_some_and(|context| context.contains_key("current_usage"))
        || !(status["context_window"]["current_usage"].is_null()
            || status["context_window"]["current_usage"].is_object())
    {
        return Ok(None);
    }
    Ok(bind_provider_observation(
        launch,
        root,
        NativeIdentitySource::ClaudeNativeEvent,
        &serde_json::json!({"sessionStart":value,"loadedContext":loaded}),
    ))
}

fn read_signal_as_provider(
    path: &std::path::Path,
    uid: u32,
    gid: u32,
) -> Result<Option<Value>, String> {
    let value = if uid == unsafe { libc::geteuid() } && gid == unsafe { libc::getegid() } {
        read_signal(path)?
    } else {
        let executable =
            std::env::current_exe().map_err(|_| "native reader executable unavailable")?;
        let output = std::process::Command::new("/usr/bin/setpriv")
            .args(crate::provider_identity_args(uid, gid))
            .arg(executable)
            .arg("native-identity-read")
            .arg("--path")
            .arg(path)
            .output()
            .map_err(|_| "native reader did not start")?;
        if !output.status.success() {
            return Err("native reader failed under provider identity".into());
        }
        serde_json::from_slice::<Option<Value>>(&output.stdout)
            .map_err(|_| "native reader returned malformed signal")?
    };
    Ok(value)
}

pub fn run_signal_read_worker(args: &[String]) -> Result<(), String> {
    if args.len() != 2 || args[0] != "--path" {
        return Err("native reader requires one current signal path".into());
    }
    let signal = read_signal(std::path::Path::new(&args[1]))?;
    println!(
        "{}",
        serde_json::to_string(&signal).map_err(|_| "native signal encoding failed")?
    );
    Ok(())
}

pub fn read_amplifier_observation(
    path: &std::path::Path,
    uid: u32,
    gid: u32,
    launch: &NativeIdentityLaunch,
    expected_source: &str,
) -> Result<Option<NativeIdentityObservation>, String> {
    let Some(value) = read_signal_as_provider(path, uid, gid)? else {
        return Ok(None);
    };
    let actual: NativeIdentityLaunch = serde_json::from_value(value["launch"].clone())
        .map_err(|_| "native Amplifier signal lacks a typed launch")?;
    let native = &value["native"];
    let Some(root) = native["session_id"]
        .as_str()
        .filter(|root| !root.is_empty())
    else {
        return Ok(None);
    };
    let load = &native["load"];
    if &actual != launch
        || native["source"] != expected_source
        || !native["parent_id"].is_null()
        || native["cli_pin"] != "1873aa980535c99a743b17172e4231833f6c8741"
        || native["producer_sha256"]
            != "1682141140822739c4cd88b7314c3b0daff7ccae1ffb55b7b72f235759123690"
        || load["sessionId"] != root
        || !load["parentId"].is_null()
    {
        return Ok(None);
    };
    let (Some(loaded), Some(accepted)) = (
        load["messageCount"].as_u64(),
        native["acceptedMessageCount"].as_u64(),
    ) else {
        return Ok(None);
    };
    if accepted < loaded || accepted.saturating_sub(loaded) > 1 {
        return Ok(None);
    };
    for name in ["transcript", "metadata"] {
        let witness = &load[name];
        if !witness["path"]
            .as_str()
            .is_some_and(|path| std::path::Path::new(path).is_absolute())
            || ["device", "inode", "size", "mtimeNs", "ctimeNs"]
                .iter()
                .any(|key| witness[key].as_u64().is_none())
            || !witness["eofSha256"].as_str().is_some_and(|digest| {
                digest.len() == 64
                    && digest
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
        {
            return Ok(None);
        }
    }
    Ok(bind_provider_observation(
        launch,
        root,
        NativeIdentitySource::AmplifierNativeLoadedContext,
        &value,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amplifier_observation_requires_current_native_loaded_context() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("amplifier-loaded-context.json");
        let launch = NativeIdentityLaunch {
            incarnation_id: freshell_runtime_protocol::IncarnationId::new(),
            launch_nonce: "nonce".into(),
            evidence_revision: 0,
            execution_generation: 1,
            requested_native_session_id: Some("native-root".into()),
        };
        let witness = serde_json::json!({"path":"/native/transcript.jsonl","device":1,"inode":2,
            "size":0,"mtimeNs":1_790_000_000_000_000_001_u64,"ctimeNs":1_790_000_000_000_000_002_u64,
            "eofSha256":"a".repeat(64)});
        let mut value = serde_json::json!({"launch":launch,"native":{"session_id":"native-root",
            "parent_id":null,"source":"resume","cli_pin":"1873aa980535c99a743b17172e4231833f6c8741",
            "producer_sha256":"1682141140822739c4cd88b7314c3b0daff7ccae1ffb55b7b72f235759123690",
            "load":{"sessionId":"native-root","parentId":null,"transcript":witness,
                "metadata":witness,"messageCount":0},"acceptedMessageCount":0}});
        let read = |value: &Value| {
            std::fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
            read_amplifier_observation(
                &path,
                unsafe { libc::geteuid() },
                unsafe { libc::getegid() },
                &launch,
                "resume",
            )
            .unwrap()
        };
        let observed = read(&value).expect("accepted actual native loader/context observation");
        assert_eq!(observed.native_session_id, "native-root");
        assert_eq!(
            observed.source,
            NativeIdentitySource::AmplifierNativeLoadedContext
        );
        value["launch"]["launchNonce"] = serde_json::json!("old");
        assert!(read(&value).is_none());
        value["launch"]["launchNonce"] = serde_json::json!("nonce");
        value["native"]["parent_id"] = serde_json::json!("fork");
        assert!(read(&value).is_none());
        value["native"]["parent_id"] = Value::Null;
        value["native"]["load"]["sessionId"] = serde_json::json!("wrong");
        assert!(read(&value).is_none());
        value["native"]["load"]["sessionId"] = serde_json::json!("native-root");
        value["native"]["load"]["transcript"]["eofSha256"] = Value::Null;
        assert!(read(&value).is_none());
    }
}
