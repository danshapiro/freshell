//! Current-launch binding for provider-origin loader acknowledgements.
//! This module does not select sessions or infer identity from retained files.

use freshell_runtime_protocol::{
    NativeIdentityLaunch, NativeIdentityObservation, NativeIdentitySource,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct SignalFileIdentity {
    device: u64,
    inode: u64,
    length: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
    eof_sha256: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct CapturedSignal {
    identity: SignalFileIdentity,
    value: Value,
}

/// One native publisher writes one immutable ACK for this launch. Retain the
/// actual file and complete EOF binding across host status reads; a changed ACK
/// cannot recover identity within the same launch by restoring old JSON bytes.
#[derive(Default)]
pub struct AmplifierObservationReader {
    first: Option<SignalFileIdentity>,
    refused: bool,
}

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

#[cfg(unix)]
fn capture_signal(path: &std::path::Path) -> Result<Option<CapturedSignal>, String> {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    let start = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("native signal is unreadable".into()),
    };
    if !start.is_file() || start.len() > 65_536 {
        return Err("native signal is not a bounded regular file".into());
    }
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| "native signal open failed")?;
    let opened = file.metadata().map_err(|_| "native signal stat failed")?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(65_537)
        .read_to_end(&mut bytes)
        .map_err(|_| "native signal read failed")?;
    let end = file.metadata().map_err(|_| "native signal stat failed")?;
    let current =
        std::fs::symlink_metadata(path).map_err(|_| "native signal disappeared during read")?;
    let stat = |metadata: &std::fs::Metadata| {
        (
            metadata.dev(),
            metadata.ino(),
            metadata.len(),
            metadata.mtime(),
            metadata.mtime_nsec(),
            metadata.ctime(),
            metadata.ctime_nsec(),
        )
    };
    if !opened.is_file()
        || !current.is_file()
        || bytes.len() > 65_536
        || bytes.len() as u64 != end.len()
        || stat(&start) != stat(&opened)
        || stat(&opened) != stat(&end)
        || stat(&end) != stat(&current)
    {
        return Err("native signal changed during read".into());
    }
    let value = serde_json::from_slice(&bytes).map_err(|_| "native signal is malformed")?;
    Ok(Some(CapturedSignal {
        identity: SignalFileIdentity {
            device: end.dev(),
            inode: end.ino(),
            length: end.len(),
            modified_seconds: end.mtime(),
            modified_nanoseconds: end.mtime_nsec(),
            changed_seconds: end.ctime(),
            changed_nanoseconds: end.ctime_nsec(),
            eof_sha256: format!("{:x}", Sha256::digest(&bytes)),
        },
        value,
    }))
}

#[cfg(not(unix))]
fn capture_signal(_path: &std::path::Path) -> Result<Option<CapturedSignal>, String> {
    Err("native signal capture requires the managed Unix provider boundary".into())
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
    if native["hook_event_name"] != "SessionStart" {
        return Ok(None);
    }
    let source = match native["source"].as_str() {
        Some("clear") => NativeIdentitySource::ClaudeNativeClear,
        Some(source) if source == expected_source => NativeIdentitySource::ClaudeNativeEvent,
        _ => return Ok(None),
    };
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
        source,
        &serde_json::json!({"sessionStart":value,"loadedContext":loaded}),
    ))
}

pub fn read_opencode_observation(
    path: &std::path::Path,
    uid: u32,
    gid: u32,
    launch: &NativeIdentityLaunch,
) -> Result<Option<NativeIdentityObservation>, String> {
    let Some(value) = read_signal_as_provider(path, uid, gid)? else {
        return Ok(None);
    };
    let actual: NativeIdentityLaunch = serde_json::from_value(value["launch"].clone())
        .map_err(|_| "native OpenCode signal lacks a typed launch")?;
    if &actual != launch {
        return Ok(None);
    }
    let native = &value["native"];
    if native["source"] != "opencode-tui-native-loader"
        || native["hydrated"] != true
        || native.get("parent_id").is_none()
        || !native["parent_id"].is_null()
    {
        return Ok(None);
    }
    let Some(root) = native["session_id"].as_str().filter(|root| {
        root.strip_prefix("ses_")
            .is_some_and(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_alphanumeric()))
    }) else {
        return Ok(None);
    };
    let Some(count) = native["active_message_count"].as_u64() else {
        return Ok(None);
    };
    let tail = native["tail_message_id"].as_str();
    if count == 0 {
        if native["messages_read"] != "empty_confirmed"
            || native.get("tail_message_id").is_none()
            || !native["tail_message_id"].is_null()
        {
            return Ok(None);
        }
    } else if native["messages_read"] != "success"
        || !tail.is_some_and(|tail| {
            tail.strip_prefix("msg_").is_some_and(|id| {
                !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_alphanumeric())
            })
        })
    {
        return Ok(None);
    }
    Ok(bind_provider_observation(
        launch,
        root,
        NativeIdentitySource::OpencodeTui,
        &serde_json::json!({"launch":actual,"native":{
            "source":"opencode-tui-native-loader","session_id":root,"parent_id":null,
            "hydrated":true,"messages_read":native["messages_read"],"active_message_count":count,
            "tail_message_id":tail,
        }}),
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
        serde_json::from_slice::<Option<Value>>(&provider_signal_read(path, uid, gid, false)?)
            .map_err(|_| "native reader returned malformed signal")?
    };
    Ok(value)
}

fn provider_signal_read(
    path: &std::path::Path,
    uid: u32,
    gid: u32,
    capture: bool,
) -> Result<Vec<u8>, String> {
    let executable = std::env::current_exe().map_err(|_| "native reader executable unavailable")?;
    let mut command = std::process::Command::new("/usr/bin/setpriv");
    command
        .args(crate::provider_identity_args(uid, gid))
        .arg(executable)
        .arg("native-identity-read")
        .arg("--path")
        .arg(path);
    if capture {
        command.arg("--capture");
    }
    let output = command
        .output()
        .map_err(|_| "native reader did not start")?;
    if !output.status.success() {
        return Err("native reader failed under provider identity".into());
    }
    Ok(output.stdout)
}

pub fn run_signal_read_worker(args: &[String]) -> Result<(), String> {
    if !matches!(args.len(), 2 | 3)
        || args[0] != "--path"
        || (args.len() == 3 && args[2] != "--capture")
    {
        return Err("native reader requires one current signal path".into());
    }
    let path = std::path::Path::new(&args[1]);
    let encoded = if args.len() == 3 {
        serde_json::to_string(&capture_signal(path)?)
    } else {
        serde_json::to_string(&read_signal(path)?)
    }
    .map_err(|_| "native signal encoding failed")?;
    println!("{encoded}");
    Ok(())
}

impl AmplifierObservationReader {
    pub fn read(
        &mut self,
        path: &std::path::Path,
        uid: u32,
        gid: u32,
        launch: &NativeIdentityLaunch,
        expected_source: &str,
    ) -> Result<Option<NativeIdentityObservation>, String> {
        if self.refused {
            return Err("native Amplifier signal changed within launch".into());
        }
        let captured = if uid == unsafe { libc::geteuid() } && gid == unsafe { libc::getegid() } {
            capture_signal(path)
        } else {
            (|| {
                serde_json::from_slice::<Option<CapturedSignal>>(&provider_signal_read(
                    path, uid, gid, true,
                )?)
                .map_err(|_| "native reader returned malformed capture".into())
            })()
        };
        let captured = match captured {
            Ok(Some(captured)) => captured,
            Ok(None) if self.first.is_none() => return Ok(None),
            Ok(None) => {
                self.refused = true;
                return Err("native Amplifier signal disappeared within launch".into());
            }
            Err(reason) => {
                self.refused = true;
                return Err(reason);
            }
        };
        if self
            .first
            .as_ref()
            .is_some_and(|first| first != &captured.identity)
        {
            self.refused = true;
            return Err("native Amplifier signal changed within launch".into());
        }
        self.first.get_or_insert(captured.identity);
        validate_amplifier_observation(&captured.value, launch, expected_source)
    }
}

fn validate_amplifier_observation(
    value: &Value,
    launch: &NativeIdentityLaunch,
    expected_source: &str,
) -> Result<Option<NativeIdentityObservation>, String> {
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
        value,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_terminal_compaction_preserves_current_loader_observation() {
        let root = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        for source in ["startup", "resume"] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("session-start.json");
            let launch = NativeIdentityLaunch {
                incarnation_id: freshell_runtime_protocol::IncarnationId::new(),
                launch_nonce: "current".into(),
                evidence_revision: 1,
                execution_generation: 1,
                requested_native_session_id: (source == "resume").then(|| root.into()),
            };
            let native = serde_json::json!({"hook_event_name":"SessionStart","source":source,
                "session_id":root,"cwd":"/owned","transcript_path":"/owned/session.jsonl"});
            let loaded = serde_json::json!({"launch":launch,"native":{"session_id":root,
                "transcript_path":"/owned/session.jsonl","workspace":{"current_dir":"/owned"},
                "version":"2.1.263","model":{"id":"synthetic"},
                "context_window":{"context_window_size":200000,"current_usage":null}}});
            std::fs::write(
                directory.path().join("statusline-loaded.json"),
                serde_json::to_vec(&loaded).unwrap(),
            )
            .unwrap();
            let publish = |native: &Value| {
                let module = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../freshell-claude-sidecar/native-session-channel.mjs");
                let output = std::process::Command::new("node")
                    .args(["--input-type=module", "--eval",
                        "const {writeNativeSessionSignal}=await import(process.argv[1]);await writeNativeSessionSignal(JSON.parse(process.argv[2]));"])
                    .arg(module)
                    .arg(serde_json::to_string(native).unwrap())
                    .env(LAUNCH_ENV, serde_json::to_string(&launch).unwrap())
                    .env(SIGNAL_DIR_ENV, directory.path())
                    .output().unwrap();
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
            };
            let read = || {
                read_claude_observation(
                    &path,
                    unsafe { libc::geteuid() },
                    unsafe { libc::getegid() },
                    &launch,
                    source,
                    std::path::Path::new("/owned"),
                )
                .unwrap()
            };
            publish(&native);
            assert_eq!(read().unwrap().native_session_id, root);
            for _ in 0..2 {
                let mut compact = native.clone();
                compact["source"] = "compact".into();
                publish(&compact);
                assert_eq!(
                    read()
                        .expect("same-session compaction keeps terminal input ready")
                        .native_session_id,
                    root
                );
            }
            let mut switched = native.clone();
            switched["source"] = "compact".into();
            switched["session_id"] = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into();
            publish(&switched);
            assert!(
                read().is_none(),
                "another native root cannot reuse the original receipt"
            );
        }
    }

    #[test]
    fn amplifier_ack_file_replacement_truncation_or_reset_cannot_recertify_identity() {
        let mut refused = Vec::new();
        for fault in [
            "replacement",
            "truncation",
            "reset",
            "disappearance",
            "malformed",
            "oversized",
            "symlink",
        ] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("amplifier-loaded-context.json");
            let launch = NativeIdentityLaunch {
                incarnation_id: freshell_runtime_protocol::IncarnationId::new(),
                launch_nonce: "current".into(),
                evidence_revision: 7,
                execution_generation: 3,
                requested_native_session_id: Some("native-root".into()),
            };
            let witness = serde_json::json!({"path":"/native/transcript.jsonl","device":1,"inode":2,
                "size":0,"mtimeNs":1,"ctimeNs":1,"eofSha256":"a".repeat(64)});
            let mut value = serde_json::json!({"launch":launch,"native":{"session_id":"native-root",
                "parent_id":null,"source":"resume","cli_pin":"1873aa980535c99a743b17172e4231833f6c8741",
                "producer_sha256":"1682141140822739c4cd88b7314c3b0daff7ccae1ffb55b7b72f235759123690",
                "load":{"sessionId":"native-root","parentId":null,"transcript":witness,
                    "metadata":witness,"messageCount":0},"acceptedMessageCount":0}});
            let mut bytes = serde_json::to_vec(&value).unwrap();
            bytes.extend_from_slice(b"\n \n");
            std::fs::write(&path, &bytes).unwrap();
            let mut reader = AmplifierObservationReader::default();
            let mut read = || {
                reader
                    .read(
                        &path,
                        unsafe { libc::geteuid() },
                        unsafe { libc::getegid() },
                        &launch,
                        "resume",
                    )
                    .ok()
                    .flatten()
            };
            assert!(read().is_some(), "first current native acknowledgement");
            assert!(read().is_some(), "unchanged native ACK remains observed");
            match fault {
                "replacement" => {
                    let replacement = path.with_extension("replacement");
                    std::fs::write(&replacement, &bytes).unwrap();
                    std::fs::rename(replacement, &path).unwrap();
                }
                "truncation" => {
                    let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
                    file.set_len((bytes.len() - 3) as u64).unwrap();
                }
                "reset" => {
                    value["native"]["acceptedMessageCount"] = serde_json::json!(1);
                    std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
                }
                "disappearance" => std::fs::remove_file(&path).unwrap(),
                "malformed" => std::fs::write(&path, b"owned invalid envelope\n").unwrap(),
                "oversized" => std::fs::write(&path, vec![b' '; 65_537]).unwrap(),
                "symlink" => {
                    let old = path.with_extension("original");
                    std::fs::rename(&path, &old).unwrap();
                    std::os::unix::fs::symlink(old, &path).unwrap();
                }
                _ => unreachable!(),
            }
            refused.push((fault, read().is_none()));
            if path.exists() {
                std::fs::remove_file(&path).unwrap();
            }
            std::fs::write(&path, &bytes).unwrap();
            assert!(
                read().is_none(),
                "restoring old bytes must not repair this launch"
            );
        }
        assert_eq!(
            refused,
            vec![
                ("replacement", true),
                ("truncation", true),
                ("reset", true),
                ("disappearance", true),
                ("malformed", true),
                ("oversized", true),
                ("symlink", true)
            ],
            "no replaced, truncated or reset native ACK may recertify identity"
        );
    }

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
            AmplifierObservationReader::default()
                .read(
                    &path,
                    unsafe { libc::geteuid() },
                    unsafe { libc::getegid() },
                    &launch,
                    "resume",
                )
                .unwrap()
        };
        let observed = read(&value).expect("accepted actual native loader/context observation");
        let missing = path.with_extension("not-yet-created");
        let mut reader = AmplifierObservationReader::default();
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        assert!(reader
            .read(&missing, uid, gid, &launch, "resume")
            .unwrap()
            .is_none());
        std::fs::write(&missing, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(reader
            .read(&missing, uid, gid, &launch, "resume")
            .unwrap()
            .is_some());
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
