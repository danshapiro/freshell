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
    use freshell_runtime_protocol::{
        bounded_json_bytes, read_frame_with_limit, write_frame_with_limit,
    };
    use tokio::io::AsyncReadExt;
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
    let exchange = async {
        let mut input = child
            .stdin
            .take()
            .ok_or("Claude final source pipe unavailable")?;
        let mut output = child
            .stdout
            .take()
            .ok_or("Claude final source pipe unavailable")?;
        write_frame_with_limit(&mut input, &request, MAX_REQUEST_BYTES)
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
        Ok(reply)
    };
    let exchange = tokio::time::timeout(std::time::Duration::from_secs(20), exchange).await;
    let cleanup = async {
        if !matches!(&exchange, Ok(Ok(_))) {
            child
                .kill()
                .await
                .map_err(|_| "Claude final source reader termination failed")?;
        }
        child
            .wait()
            .await
            .map_err(|_| "Claude final source reader join failed")
    };
    let status = tokio::time::timeout(std::time::Duration::from_secs(5), cleanup).await;
    let result = (|| {
        let status = status.map_err(|_| "Claude final source reader cleanup timed out")??;
        let reply = exchange.map_err(|_| "Claude final source reader timed out")??;
        if !status.success() {
            return Err("Claude final source reader failed without complete evidence".to_string());
        }
        reply.validate_for_request(&request, &request_sha256)?;
        expected.require_same_selection(&reply.observation)
    })();
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
