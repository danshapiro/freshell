//! One finite metadata request from an owned parent. No provider is dispatched;
//! request and reply bodies use private pipes, never command arguments or logs.
use freshell_platform::claude_inputs::observation::{
    observe, ObservationReply, ObservationRequest, MAX_REPLY_BYTES, MAX_REQUEST_BYTES,
};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

pub(crate) async fn verify_final(
    context: Option<&freshell_runtime_protocol::ProviderLaunchContext>,
    stage: &std::path::Path,
    cwd: &std::path::Path,
    home: &std::path::Path,
    uid: u32,
    gid: u32,
    runtime: freshell_platform::claude_inputs::NativeSourceRuntime,
) -> Result<(), String> {
    use freshell_runtime_protocol::bounded_json_bytes;
    let Some((request, expected)) = crate::provider_input_preparation::final_claude_source_request(
        context, stage, cwd, home, runtime,
    )?
    else {
        return Ok(());
    };
    if (expected.uid, expected.euid, expected.gid, expected.egid) != (uid, uid, gid, gid) {
        return Err("Claude actual provider identity differs from accepted inputs; retain inputs and reprepare".into());
    }
    let raw = bounded_json_bytes(&request, MAX_REQUEST_BYTES)
        .map_err(|_| "Claude final source request exceeds its finite metadata profile")?;
    let request_sha256 = format!("{:x}", Sha256::digest(raw));
    let executable = std::env::current_exe().map_err(|_| {
        "Claude final source reader artifact unavailable; retain inputs and reprepare"
    })?;
    let mut command = tokio::process::Command::new("/usr/bin/setpriv");
    command
        .args(crate::provider_identity_args(uid, gid))
        .arg(executable)
        .arg("observe-claude-sources")
        .current_dir(cwd)
        .env_clear()
        .env("HOME", home)
        .env("PATH", "/usr/bin:/bin")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let started = std::time::Instant::now();
    let mut child = command
        .spawn()
        .map_err(|_| "Claude final source reader could not start; retain inputs and reprepare")?;
    let reader_pid = child.id();
    tracing::info!(
        event = "provider.inputs.native_final.started",
        provider = "claude",
        stage = "session_host",
        reader_pid,
        uid,
        gid,
        "Observing final native provider source selection"
    );
    let result = read_final_child(
        &mut child,
        &request,
        &request_sha256,
        std::time::Duration::from_secs(20),
        std::time::Duration::from_secs(5),
    )
    .await
    .and_then(|reply| expected.require_same_selection(&reply.observation));
    match &result {
        Ok(()) => tracing::info!(
            event = "provider.inputs.native_final.completed",
            provider = "claude",
            stage = "session_host",
            reader_pid,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "Final native provider source selection agrees"
        ),
        Err(reason) => {
            tracing::warn!(event="provider.inputs.native_final.blocked",provider="claude",stage="session_host",
            reader_pid,elapsed_ms=started.elapsed().as_millis() as u64,cause=%reason,"Final native provider source selection unavailable or changed")
        }
    }
    result.map_err(|reason| {
        if reason.contains("retain inputs and reprepare") {
            reason
        } else {
            format!("{reason}; retain inputs and reprepare")
        }
    })
}

async fn read_final_child(
    child: &mut tokio::process::Child,
    request: &ObservationRequest,
    request_sha256: &str,
    exchange_timeout: std::time::Duration,
    cleanup_timeout: std::time::Duration,
) -> Result<ObservationReply, String> {
    use freshell_runtime_protocol::{read_frame_with_limit, write_frame_with_limit};
    use tokio::io::AsyncReadExt;
    let exchange = async {
        let mut input = child
            .stdin
            .take()
            .ok_or("Claude final source pipe unavailable")?;
        let mut output = child
            .stdout
            .take()
            .ok_or("Claude final source pipe unavailable")?;
        write_frame_with_limit(&mut input, request, MAX_REQUEST_BYTES)
            .await
            .map_err(|_| "Claude final source request incomplete")?;
        drop(input);
        let reply: ObservationReply = read_frame_with_limit(&mut output, MAX_REPLY_BYTES)
            .await
            .map_err(|_| {
                "Claude final source evidence unavailable or exceeds its finite profile"
            })?;
        let mut trailing = [0];
        if output
            .read(&mut trailing)
            .await
            .map_err(|_| "Claude final reader completion unavailable")?
            != 0
        {
            return Err("Claude final reader emitted extra evidence");
        }
        // A complete pipe reply is not process completion. Keep its owned
        // process join inside the exchange deadline so a reader that closes
        // stdout but remains alive enters the same bounded kill/wait cleanup.
        let status = child
            .wait()
            .await
            .map_err(|_| "Claude final source reader completion unavailable")?;
        Ok((reply, status))
    };
    let exchange = tokio::time::timeout(exchange_timeout, exchange).await;
    let completed = match exchange {
        Ok(result) => result.map_err(str::to_string),
        Err(_) => Err("Claude final source reader timed out".to_string()),
    };
    let (reply, status) = match completed {
        Ok(completed) => completed,
        Err(reason) => {
            let cleanup = async {
                child
                    .start_kill()
                    .map_err(|_| "Claude final source reader termination failed")?;
                child
                    .wait()
                    .await
                    .map_err(|_| "Claude final source reader join failed")
            };
            tokio::time::timeout(cleanup_timeout, cleanup)
                .await
                .map_err(|_| "Claude final source reader cleanup timed out")??;
            return Err(reason);
        }
    };
    if !status.success() {
        return Err("Claude final source reader failed without complete evidence".to_string());
    }
    reply.validate_for_request(request, request_sha256)?;
    Ok(reply)
}

pub(crate) fn serve_stdio() -> Result<(), String> {
    exchange(&mut std::io::stdin().lock(), &mut std::io::stdout().lock())
}

pub(crate) fn serve_private() -> Result<(), String> {
    let mut input =
        std::os::unix::net::UnixStream::connect("/run/freshell-source-exchange/reply.sock")
            .map_err(|_| "Claude observation private exchange unavailable")?;
    let timeout = Some(std::time::Duration::from_secs(15));
    input
        .set_read_timeout(timeout)
        .map_err(|_| "Claude observation private timeout unavailable")?;
    input
        .set_write_timeout(timeout)
        .map_err(|_| "Claude observation private timeout unavailable")?;
    let mut output = input
        .try_clone()
        .map_err(|_| "Claude observation private exchange unavailable")?;
    exchange(&mut input, &mut output)
}

fn exchange(input: &mut impl Read, output: &mut impl Write) -> Result<(), String> {
    let mut length = [0; 4];
    input
        .read_exact(&mut length)
        .map_err(|_| "Claude observation request header unavailable")?;
    let length = u32::from_be_bytes(length) as usize;
    if length > MAX_REQUEST_BYTES {
        return Err(
            "Claude observation request exceeds the metadata profile; retain inputs and reprepare"
                .into(),
        );
    }
    let mut raw = Vec::new();
    raw.try_reserve_exact(length)
        .map_err(|_| "Claude observation request allocation unavailable")?;
    raw.resize(length, 0);
    input
        .read_exact(&mut raw)
        .map_err(|_| "Claude observation request incomplete")?;
    let request: ObservationRequest = serde_json::from_slice(&raw)
        .map_err(|_| "Claude observation request is invalid; retain inputs and reprepare")?;
    request.validate()?;
    let cwd = std::env::current_dir().map_err(|_| {
        "Claude observation native launch cwd is unavailable; retain inputs and repair it"
    })?;
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .ok_or("Claude observation native HOME is unavailable; retain inputs and repair it")?;
    if cwd != request.cwd || home != request.home {
        return Err("Claude observation native launch cwd or HOME changed; retain inputs and reprepare before dispatch".into());
    }
    let observation = observe(
        &cwd,
        &home,
        request.native_source_runtime,
        &request.setting_sources,
    )?;
    let reply = ObservationReply {
        request_sha256: format!("{:x}", Sha256::digest(&raw)),
        observation,
    };
    let bytes =
        freshell_runtime_protocol::bounded_json_bytes(&reply, MAX_REPLY_BYTES).map_err(|_| {
            "Claude observation reply exceeds the metadata profile; retain inputs and reprepare"
        })?;
    output
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .map_err(|_| "Claude observation response header unavailable")?;
    output
        .write_all(&bytes)
        .map_err(|_| "Claude observation response incomplete")?;
    output
        .flush()
        .map_err(|_| "Claude observation response incomplete")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Error, ErrorKind};

    struct ReaderCase {
        result: Result<ObservationReply, String>,
        joined_before_test_cleanup: bool,
        elapsed: std::time::Duration,
    }

    async fn reader_case(mode: &str) -> ReaderCase {
        use freshell_platform::claude_inputs::NativeSourceRuntime;
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("cwd");
        let home = root.path().join("home");
        std::fs::create_dir(&cwd).unwrap();
        std::fs::create_dir(&home).unwrap();
        let request = ObservationRequest {
            version: 1,
            request_id: uuid::Uuid::new_v4().to_string(),
            native_source_runtime: NativeSourceRuntime::Terminal,
            cwd: cwd.clone(),
            home: home.clone(),
            setting_sources: vec![],
            selector_manifest_sha256: "a".repeat(64),
            plan_revision: 0,
        };
        let raw =
            freshell_runtime_protocol::bounded_json_bytes(&request, MAX_REQUEST_BYTES).unwrap();
        let request_sha256 = format!("{:x}", Sha256::digest(raw));
        let mut reply = ObservationReply {
            request_sha256: request_sha256.clone(),
            observation: observe(&cwd, &home, NativeSourceRuntime::Terminal, &[]).unwrap(),
        };
        if mode == "wrong-binding" {
            reply.request_sha256 = "b".repeat(64);
        } else if mode == "wrong-runtime" {
            reply.observation.native_source_runtime = NativeSourceRuntime::Sdk;
        }
        let mut bytes = serde_json::to_vec(&reply).unwrap();
        if matches!(mode, "near-cap" | "oversized") {
            bytes.resize(MAX_REPLY_BYTES, b' ');
        } else if mode == "invalid" {
            bytes = b"PRIVATE_READER_BODY_SENTINEL".to_vec();
        }
        let body = root.path().join("reply.bin");
        std::fs::write(&body, bytes).unwrap();
        std::fs::set_permissions(&body, std::fs::Permissions::from_mode(0o600)).unwrap();
        let script = root.path().join("reader.cjs");
        std::fs::write(&script, r#"const fs=require('node:fs');
const mode=process.argv[2],body=fs.readFileSync(process.argv[3]);
process.stdin.on('data',()=>{}).on('end',()=>{
 const header=Buffer.alloc(4);header.writeUInt32BE(body.length+(mode==='oversized'||mode==='short-body'?1:0));
 if(mode==='stall'){setInterval(()=>{},10000);return;}
 if(mode==='oversized'){process.stdout.write(header);setInterval(()=>{},10000);return;}
 if(mode==='short-header'){process.stdout.write(header.subarray(0,2));return;}
 const frame=Buffer.concat([header,body]);
 if(mode==='eof-stall'){process.stdout.write(frame,()=>{fs.closeSync(1);setInterval(()=>{},10000)});return;}
 process.stdout.write(mode==='extra'?Buffer.concat([frame,Buffer.from([1])]):frame);
 if(mode==='nonzero')process.exitCode=6;
});
"#).unwrap();
        let mut child = tokio::process::Command::new("node")
            .arg(&script)
            .arg(mode)
            .arg(&body)
            .current_dir(&cwd)
            .env_clear()
            .env("HOME", &home)
            .env("PATH", std::env::var_os("PATH").unwrap())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let started = std::time::Instant::now();
        let result = read_final_child(
            &mut child,
            &request,
            &request_sha256,
            std::time::Duration::from_secs(2),
            std::time::Duration::from_millis(200),
        )
        .await;
        let elapsed = started.elapsed();
        let joined_before_test_cleanup = child.id().is_none();
        // Join every owned fault child before any assertion can panic. This
        // fallback records a failed production join; it cannot make it pass.
        if !joined_before_test_cleanup {
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                child.kill().await.unwrap();
                child.wait().await.unwrap();
            })
            .await
            .expect("test-owned reader cleanup must finish");
        }
        ReaderCase {
            result,
            joined_before_test_cleanup,
            elapsed,
        }
    }

    #[tokio::test]
    async fn claude_final_reader_real_pipe_bounds_binding_failures_and_joins() {
        for mode in [
            "valid",
            "near-cap",
            "oversized",
            "short-header",
            "short-body",
            "invalid",
            "extra",
            "nonzero",
            "wrong-binding",
            "wrong-runtime",
            "stall",
        ] {
            let case = reader_case(mode).await;
            assert!(
                case.joined_before_test_cleanup,
                "owned reader must already be joined for {mode}"
            );
            assert_eq!(
                case.result.is_ok(),
                matches!(mode, "valid" | "near-cap"),
                "actual reader result for {mode}"
            );
            assert!(
                case.elapsed < std::time::Duration::from_secs(3),
                "finite reader exchange for {mode}"
            );
            if let Err(error) = case.result {
                assert!(!error.contains("PRIVATE_READER_BODY_SENTINEL"));
            }
        }
    }

    #[tokio::test]
    async fn claude_final_reader_complete_reply_without_process_exit_terminates_and_joins() {
        let case = reader_case("eof-stall").await;
        assert!(
            case.result.is_err(),
            "a reply alone cannot establish process completion"
        );
        assert!(
            case.joined_before_test_cleanup,
            "complete reply plus EOF must not leave the owned reader running after cleanup timeout"
        );
        assert!(case.elapsed < std::time::Duration::from_secs(3));
    }

    struct HeaderOnly {
        header: Cursor<[u8; 4]>,
        body_reads: usize,
    }
    impl Read for HeaderOnly {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            if self.header.position() == 4 {
                self.body_reads += 1;
                return Err(Error::new(ErrorKind::Other, "body must remain unread"));
            }
            self.header.read(bytes)
        }
    }

    #[test]
    fn claude_observation_rejects_oversized_header_before_reading_or_allocating_body() {
        for length in [MAX_REQUEST_BYTES as u32 + 1, u32::MAX] {
            let mut input = HeaderOnly {
                header: Cursor::new(length.to_be_bytes()),
                body_reads: 0,
            };
            let mut output = Vec::new();
            let error = exchange(&mut input, &mut output).unwrap_err();
            assert!(error.contains("exceeds the metadata profile"));
            assert_eq!(input.body_reads, 0);
            assert!(output.is_empty());
        }
    }

    #[test]
    fn claude_observation_incomplete_request_never_emits_partial_evidence_or_private_input() {
        let private = b"PRIVATE_INCOMPLETE_METADATA_SENTINEL";
        let mut input = Vec::from((private.len() as u32 + 1).to_be_bytes());
        input.extend(private);
        let mut output = Vec::new();
        let error = exchange(&mut Cursor::new(input), &mut output).unwrap_err();
        assert!(error.contains("request incomplete"));
        assert!(!error
            .as_bytes()
            .windows(private.len())
            .any(|window| window == private));
        assert!(output.is_empty());
    }
}
