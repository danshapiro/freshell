//! Selected native credentials cross only an owned provider-identity pipe.
use freshell_platform::native_auth_exchange::{
    read_selected_native_auth, validate_keys, validate_selected, MAX_AUTH_FRAME,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::Path,
};

const MAX_REQUEST: usize = 32 * 1024;

#[derive(Deserialize, Serialize)]
struct Reply {
    uid: u32,
    gid: u32,
    values: Result<BTreeMap<String, String>, String>,
}

// Keep the owning reader's fixed causes; never propagate an arbitrary reply
// body, filesystem contents, or serde decoding error into host diagnostics.
fn safe_cause(cause: &str) -> &str {
    match cause {
        "native auth selected keys are invalid"
        | "native auth HOME is unavailable"
        | "native auth file is unavailable"
        | "native auth file escaped owned HOME"
        | "native auth file metadata failed"
        | "native auth file is not regular"
        | "native auth file read failed"
        | "native auth file exceeds limit"
        | "native auth file is not UTF-8"
        | "native auth file cannot be decoded"
        | "native auth selected values are invalid"
        | "native auth selected values exceed limit" => cause,
        _ => "native auth reader failed without classified evidence",
    }
}

pub(crate) fn serve_stdio() -> Result<(), String> {
    let mut input = std::io::stdin().lock();
    let mut length = [0; 4];
    input
        .read_exact(&mut length)
        .map_err(|_| "native auth request unavailable")?;
    let length = u32::from_be_bytes(length) as usize;
    if length > MAX_REQUEST {
        return Err("native auth request exceeds limit".into());
    }
    let mut bytes = vec![0; length];
    input
        .read_exact(&mut bytes)
        .map_err(|_| "native auth request unavailable")?;
    let keys: Vec<String> =
        serde_json::from_slice(&bytes).map_err(|_| "native auth request invalid")?;
    let mut extra = [0];
    if input
        .read(&mut extra)
        .map_err(|_| "native auth request incomplete")?
        != 0
    {
        return Err("native auth request has trailing bytes".into());
    }
    validate_keys(&keys).map_err(str::to_string)?;
    let home = std::env::var_os("HOME").ok_or("native auth HOME is unavailable")?;
    let values = read_selected_native_auth(Path::new(&home), &keys)
        .map_err(|cause| safe_cause(cause).to_string());
    let reply = Reply {
        uid: unsafe { libc::geteuid() },
        gid: unsafe { libc::getegid() },
        values,
    };
    let bytes = freshell_runtime_protocol::bounded_json_bytes(&reply, MAX_AUTH_FRAME)
        .map_err(|_| "native auth reply exceeds limit")?;
    let mut output = std::io::stdout().lock();
    output
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .map_err(|_| "native auth reply unavailable")?;
    output
        .write_all(&bytes)
        .map_err(|_| "native auth reply unavailable")?;
    Ok(())
}

pub(crate) async fn read_selected(
    home: &Path,
    keys: &[String],
    identity: (u32, u32),
) -> Result<BTreeMap<String, String>, String> {
    validate_keys(keys).map_err(str::to_string)?;
    if identity == (unsafe { libc::geteuid() }, unsafe { libc::getegid() }) {
        return read_selected_native_auth(home, keys).map_err(str::to_string);
    }
    #[cfg(not(test))]
    let executable =
        std::env::current_exe().map_err(|_| "native auth reader artifact unavailable")?;
    #[cfg(test)]
    let executable = std::path::PathBuf::from("/runtime/freshell-session-host");
    let mut child = tokio::process::Command::new("/usr/bin/setpriv")
        .args(crate::provider_identity_args(identity.0, identity.1))
        .arg(executable)
        .arg("native-auth-stdio")
        .current_dir("/")
        .env_clear()
        .env("HOME", home)
        .env("PATH", "/usr/bin:/bin")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| "native auth reader could not start")?;
    let reader_pid = child.id();
    tracing::info!(
        event = "provider.inputs.native_auth.started",
        provider = "opencode",
        stage = "session_host",
        reader_pid,
        uid = identity.0,
        gid = identity.1,
        "Reading selected native authentication under provider identity"
    );
    let result = read_child(&mut child, keys, identity).await;
    match &result {
        Ok(_) => tracing::info!(
            event = "provider.inputs.native_auth.completed",
            provider = "opencode",
            stage = "session_host",
            reader_pid,
            "Selected native authentication reader joined"
        ),
        Err(cause) => {
            tracing::warn!(event="provider.inputs.native_auth.blocked", provider="opencode", stage="session_host", reader_pid, cause=%cause, "Selected native authentication unavailable")
        }
    }
    result
}

async fn read_child(
    child: &mut tokio::process::Child,
    keys: &[String],
    identity: (u32, u32),
) -> Result<BTreeMap<String, String>, String> {
    use freshell_runtime_protocol::{read_frame_with_limit, write_frame_with_limit};
    use tokio::io::AsyncReadExt;
    let exchange = async {
        let mut input = child
            .stdin
            .take()
            .ok_or("native auth reader pipe unavailable")?;
        let mut output = child
            .stdout
            .take()
            .ok_or("native auth reader pipe unavailable")?;
        write_frame_with_limit(&mut input, &keys, MAX_REQUEST)
            .await
            .map_err(|_| "native auth request incomplete")?;
        drop(input);
        let reply: Reply = read_frame_with_limit(&mut output, MAX_AUTH_FRAME)
            .await
            .map_err(|_| "native auth reply unavailable or exceeds limit")?;
        let mut trailing = [0];
        if output
            .read(&mut trailing)
            .await
            .map_err(|_| "native auth reader completion unavailable")?
            != 0
        {
            return Err("native auth reader emitted trailing bytes");
        }
        let status = child
            .wait()
            .await
            .map_err(|_| "native auth reader completion unavailable")?;
        Ok((reply, status))
    };
    let completed = match tokio::time::timeout(
        freshell_platform::provider_startup::PROVIDER_METADATA_READ_RUN,
        exchange,
    )
    .await
    {
        Ok(result) => result.map_err(str::to_string),
        Err(_) => Err("native auth reader timed out".into()),
    };
    let (reply, status) = match completed {
        Ok(value) => value,
        Err(cause) => {
            // Restricted root has no CAP_KILL. Signal this still-owned unreaped
            // child under its provider identity and join before returning.
            let cleanup = async {
                if child
                    .try_wait()
                    .map_err(|_| "native auth reader join failed")?
                    .is_none()
                {
                    let pid = child
                        .id()
                        .ok_or("native auth reader identity unavailable")?
                        .to_string();
                    let killed = tokio::process::Command::new("/usr/bin/setpriv")
                        .args(crate::provider_identity_args(identity.0, identity.1))
                        .args(["/usr/bin/kill", "-KILL", "--", &pid])
                        .env_clear()
                        .stdin(std::process::Stdio::null())
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status()
                        .await
                        .map_err(|_| "native auth reader termination failed")?;
                    if !killed.success()
                        && child
                            .try_wait()
                            .map_err(|_| "native auth reader join failed")?
                            .is_none()
                    {
                        return Err("native auth reader termination failed");
                    }
                }
                child
                    .wait()
                    .await
                    .map_err(|_| "native auth reader join failed")
            };
            tokio::time::timeout(
                freshell_platform::provider_startup::PROVIDER_METADATA_READ_CLEANUP,
                cleanup,
            )
            .await
            .map_err(|_| "native auth reader cleanup timed out")??;
            return Err(cause);
        }
    };
    if !status.success() || (reply.uid, reply.gid) != identity {
        return Err("native auth reader failed or returned a different identity".into());
    }
    let values = reply
        .values
        .map_err(|cause| safe_cause(&cause).to_string())?;
    validate_selected(keys, &values).map_err(str::to_string)?;
    Ok(values)
}
