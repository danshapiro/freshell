//! Single-use, memory-only selected OpenCode auth lookup over private IPC.
//! The caller supplies an exact owned provider HOME; no host HOME fallback exists.
use std::{collections::BTreeMap, path::Path};

pub const MAX_AUTH_FRAME: usize = 1024 * 1024;

pub fn validate_keys(keys: &[String]) -> Result<(), &'static str> {
    crate::provider_environment_grants::resolve_opencode_auth_environment("{}", keys)
        .map(|_| ())
        .map_err(|_| "native auth selected keys are invalid")
}

pub fn validate_selected(
    keys: &[String],
    values: &BTreeMap<String, String>,
) -> Result<(), &'static str> {
    validate_keys(keys)?;
    let mut total = 0usize;
    for (key, value) in values {
        if !keys.contains(key) || value.len() > 64 * 1024 || value.contains('\0') {
            return Err("native auth selected values are invalid");
        }
        total = total
            .checked_add(key.len())
            .and_then(|n| n.checked_add(value.len()))
            .ok_or("native auth selected values exceed limit")?;
        if total > 256 * 1024 {
            return Err("native auth selected values exceed limit");
        }
    }
    Ok(())
}

struct BoundedFrame(Vec<u8>);
impl std::io::Write for BoundedFrame {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_AUTH_FRAME.saturating_sub(self.0.len()) {
            return Err(std::io::Error::other("native auth frame exceeds limit"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// The only serialized auth reply is sent directly to this private socket.
#[cfg(unix)]
fn selected_native_auth(
    home: &Path,
    keys: &[String],
) -> Result<BTreeMap<String, String>, &'static str> {
    use std::io::Read;
    validate_keys(keys)?;
    let home = std::fs::canonicalize(home).map_err(|_| "native auth HOME is unavailable")?;
    let path = home.join(".local/share/opencode/auth.json");
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(_) => return Err("native auth file is unavailable"),
        Ok(_) => {}
    }
    let canonical = std::fs::canonicalize(&path).map_err(|_| "native auth file is unavailable")?;
    if !canonical.starts_with(&home) {
        return Err("native auth file escaped owned HOME");
    }
    let file = std::fs::File::open(canonical).map_err(|_| "native auth file is unavailable")?;
    if !file
        .metadata()
        .map_err(|_| "native auth file metadata failed")?
        .is_file()
    {
        return Err("native auth file is not regular");
    }
    let mut bytes = Vec::new();
    file.take(128 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "native auth file read failed")?;
    if bytes.len() > 128 * 1024 {
        return Err("native auth file exceeds limit");
    }
    let raw = String::from_utf8(bytes).map_err(|_| "native auth file is not UTF-8")?;
    let selected =
        crate::provider_environment_grants::resolve_opencode_auth_environment(&raw, keys)
            .map_err(|_| "native auth file cannot be decoded")?;
    validate_selected(keys, &selected)?;
    Ok(selected)
}

#[cfg(unix)]
pub fn serve(home: &Path, socket: &Path) -> Result<(), &'static str> {
    use std::{
        io::{Read, Write},
        os::unix::net::UnixStream,
    };
    let mut stream = UnixStream::connect(socket).map_err(|_| "native auth exchange unavailable")?;
    let timeout = Some(std::time::Duration::from_secs(15));
    stream
        .set_read_timeout(timeout)
        .map_err(|_| "native auth exchange unavailable")?;
    stream
        .set_write_timeout(timeout)
        .map_err(|_| "native auth exchange unavailable")?;
    let mut length = [0; 4];
    stream
        .read_exact(&mut length)
        .map_err(|_| "native auth request unavailable")?;
    let length = u32::from_be_bytes(length) as usize;
    if length > 32 * 1024 {
        return Err("native auth request exceeds limit");
    }
    let mut request = vec![0; length];
    stream
        .read_exact(&mut request)
        .map_err(|_| "native auth request unavailable")?;
    let keys: Vec<String> =
        serde_json::from_slice(&request).map_err(|_| "native auth request invalid")?;
    let selected = selected_native_auth(home, &keys)?;
    let mut frame = BoundedFrame(Vec::new());
    serde_json::to_writer(&mut frame, &selected).map_err(|_| "native auth reply exceeds limit")?;
    stream
        .write_all(&(frame.0.len() as u32).to_be_bytes())
        .map_err(|_| "native auth reply unavailable")?;
    stream
        .write_all(&frame.0)
        .map_err(|_| "native auth reply unavailable")?;
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        os::unix::net::UnixListener,
    };

    #[test]
    fn selected_native_auth_values_travel_only_through_the_private_exchange() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("owned-home");
        let path = home.join(".local/share/opencode/auth.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let raw = r#"{"a":{"type":"wellknown","key":"PATH_INPUT","token":"/synthetic/selected"},"b":{"type":"api","key":"UNSELECTED","token":"PRIVATE_UNSELECTED_SENTINEL"}}"#;
        std::fs::write(&path, raw).unwrap();
        let socket = temp.path().join("reply.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let worker = std::thread::spawn(move || serve(&home, &socket));
        listener.set_nonblocking(true).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        let (mut stream, _) = loop {
            match listener.accept() {
                Ok(pair) => break pair,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if std::time::Instant::now() >= deadline {
                        panic!(
                            "native auth consumer did not connect: {:?}",
                            worker.join().unwrap()
                        );
                    }
                    std::thread::yield_now();
                }
                Err(error) => panic!("{error}"),
            }
        };
        let request = serde_json::to_vec(&vec!["PATH_INPUT"]).unwrap();
        stream
            .write_all(&(request.len() as u32).to_be_bytes())
            .unwrap();
        stream.write_all(&request).unwrap();
        let mut length = [0; 4];
        stream.read_exact(&mut length).unwrap();
        let mut reply = vec![0; u32::from_be_bytes(length) as usize];
        stream.read_exact(&mut reply).unwrap();
        let selected: BTreeMap<String, String> = serde_json::from_slice(&reply).unwrap();
        assert_eq!(
            selected.get("PATH_INPUT").map(String::as_str),
            Some("/synthetic/selected")
        );
        assert!(!String::from_utf8(reply)
            .unwrap()
            .contains("PRIVATE_UNSELECTED_SENTINEL"));
        assert_eq!(worker.join().unwrap(), Ok(()));
        assert_eq!(std::fs::read_to_string(path).unwrap(), raw);
    }

    #[test]
    fn native_auth_never_falls_back_to_an_outside_file_and_charges_actual_bytes() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("owned");
        let path = home.join(".local/share/opencode/auth.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let outside = temp.path().join("outside-auth");
        std::fs::write(&outside, "PRIVATE_SENTINEL").unwrap();
        symlink(&outside, &path).unwrap();
        assert_eq!(
            selected_native_auth(&home, &[]).unwrap_err(),
            "native auth file escaped owned HOME"
        );
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, vec![b' '; 128 * 1024 + 1]).unwrap();
        assert_eq!(
            selected_native_auth(&home, &[]).unwrap_err(),
            "native auth file exceeds limit"
        );
        std::fs::remove_file(&path).unwrap();
        assert!(selected_native_auth(&home, &[]).unwrap().is_empty());
    }
}
