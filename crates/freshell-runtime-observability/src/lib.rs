//! Shared, fail-closed runtime observability primitives.
//!
//! The web server, supervisor, and session host all need the same two
//! guarantees: secrets are removed before the first byte reaches disk, and
//! long-running JSONL evidence remains size bounded. This crate deliberately
//! has no process-management or runtime-registry authority.

use regex::Regex;
use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
};

fn token_field_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)"([a-z0-9_-]*(?:token|secret|password|credential|api[_-]?key)[a-z0-9_-]*)"\s*:\s*"((?:\\.|[^"\\])*)""#)
            .expect("valid secret-field redaction regex")
    })
}

fn cookie_field_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)"(cookie|authorization)"\s*:\s*"((?:\\.|[^"\\])*)""#)
            .expect("valid auth-field redaction regex")
    })
}

fn cookie_header_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\b(cookie|set-cookie|authorization)\s*:\s*[^\r\n\x22]+")
            .expect("valid auth-header redaction regex")
    })
}

fn bearer_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}").expect("valid bearer redaction regex")
    })
}

fn common_secret_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})\b",
        )
        .expect("valid common-secret redaction regex")
    })
}

fn secret_query_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)([?&](?:token|access_token|api[_-]?key|secret|password)=)[^&#\s]+")
            .expect("valid secret-query redaction regex")
    })
}

/// Scrub one already-rendered record before it reaches any persistent sink.
///
/// The exact process secret is replaced everywhere, then common and future
/// credential-bearing JSON fields are redacted by name. The failure direction
/// is over-redaction; never preserve a suspicious credential value.
pub fn scrub(line: &str, process_secret: &str) -> String {
    let mut out = line.to_string();
    if !process_secret.is_empty() {
        out = out.replace(process_secret, "***REDACTED***");
    }
    out = token_field_re()
        .replace_all(&out, |caps: &regex::Captures| {
            format!("\"{}\":\"***REDACTED***\"", &caps[1])
        })
        .into_owned();
    out = cookie_field_re()
        .replace_all(&out, |caps: &regex::Captures| {
            format!("\"{}\":\"***REDACTED***\"", &caps[1])
        })
        .into_owned();
    out = cookie_header_re()
        .replace_all(&out, |caps: &regex::Captures| {
            format!("{}: ***REDACTED***", &caps[1])
        })
        .into_owned();
    out = bearer_re()
        .replace_all(&out, "Bearer ***REDACTED***")
        .into_owned();
    out = common_secret_re()
        .replace_all(&out, "***REDACTED***")
        .into_owned();
    secret_query_re()
        .replace_all(&out, "$1***REDACTED***")
        .into_owned()
}

struct RotatingInner {
    path: PathBuf,
    max_bytes: u64,
    max_backups: u32,
    file: File,
    size: u64,
    process_secret: String,
}

impl RotatingInner {
    fn backup_path(&self, n: u32) -> PathBuf {
        let mut value = self.path.as_os_str().to_os_string();
        value.push(format!(".{n}"));
        PathBuf::from(value)
    }

    fn rotate(&mut self) -> std::io::Result<()> {
        self.file.sync_all()?;
        if self.max_backups == 0 {
            let _ = fs::remove_file(&self.path);
        } else {
            let _ = fs::remove_file(self.backup_path(self.max_backups));
            for n in (1..self.max_backups).rev() {
                let from = self.backup_path(n);
                let to = self.backup_path(n + 1);
                if from.exists() {
                    fs::rename(from, to)?;
                }
            }
            if self.path.exists() {
                fs::rename(&self.path, self.backup_path(1))?;
            }
        }
        self.file = secure_append_file(&self.path)?;
        self.size = 0;
        Ok(())
    }
}

/// Synchronous redacting JSONL sink with bounded active/backup files.
/// Every successful write is flushed; [`sync_all`](Self::sync_all) gives
/// callers an explicit incident-before-cleanup durability barrier.
pub struct RotatingJsonlWriter {
    inner: Mutex<RotatingInner>,
}

impl RotatingJsonlWriter {
    pub fn create(
        path: impl Into<PathBuf>,
        max_bytes: u64,
        max_backups: u32,
        process_secret: impl Into<String>,
    ) -> std::io::Result<Self> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
            fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
        }
        let file = secure_append_file(&path)?;
        let size = file.metadata()?.len();
        Ok(Self {
            inner: Mutex::new(RotatingInner {
                path,
                max_bytes: max_bytes.max(1),
                max_backups,
                file,
                size,
                process_secret: process_secret.into(),
            }),
        })
    }

    pub fn write_line(&self, line: &str) -> std::io::Result<()> {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let scrubbed = scrub(line, &inner.process_secret);
        let mut bytes = scrubbed.into_bytes();
        bytes.push(b'\n');
        if inner.size > 0 && inner.size.saturating_add(bytes.len() as u64) > inner.max_bytes {
            inner.rotate()?;
        }
        inner.file.write_all(&bytes)?;
        inner.file.flush()?;
        inner.size = inner.size.saturating_add(bytes.len() as u64);
        Ok(())
    }

    pub fn write_json<T: Serialize>(&self, value: &T) -> std::io::Result<()> {
        let line = serde_json::to_string(value).map_err(std::io::Error::other)?;
        self.write_line(&line)
    }

    pub fn sync_all(&self) -> std::io::Result<()> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .file
            .sync_all()
    }
}

/// Atomically replace a private JSON document after redaction and fsync both
/// the file and containing directory. The caller supplies a stable final path;
/// temporary names never contain provider/native identity.
pub fn atomic_write_redacted_json<T: Serialize>(
    path: &Path,
    value: &T,
    process_secret: &str,
) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("document path has no parent"))?;
    fs::create_dir_all(parent)?;
    fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
    let encoded = serde_json::to_string_pretty(value).map_err(std::io::Error::other)?;
    let redacted = scrub(&encoded, process_secret);
    static TEMP_NONCE: AtomicU64 = AtomicU64::new(1);
    let nonce = TEMP_NONCE.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("tmp-{}-{nonce}", std::process::id()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&tmp)?;
    let result = (|| {
        file.write_all(redacted.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&tmp, path)?;
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

pub fn now_rfc3339_millis() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn secure_append_file(path: &Path) -> std::io::Result<File> {
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)?;
    fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrub_removes_exact_and_schema_named_secrets() {
        let secret = "never-persist-this-secret";
        let line = format!(r#"{{"token":"{secret}","futureCredential":"other","safe":"value"}}"#);
        let out = scrub(&line, secret);
        assert!(!out.contains(secret));
        assert!(!out.contains("other"));
        assert!(out.contains("\"safe\":\"value\""));
        let unstructured = scrub(
            "authorization: Bearer abcdefghijklmnop sk-abcdefghijklmnop https://x.test/?access_token=secret-value",
            "",
        );
        assert!(!unstructured.contains("abcdefghijklmnop"));
        assert!(!unstructured.contains("secret-value"));
    }

    #[test]
    fn rotation_and_atomic_documents_are_private_and_bounded() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        let writer = RotatingJsonlWriter::create(&path, 180, 2, "secret").unwrap();
        for index in 0..100 {
            writer
                .write_json(&serde_json::json!({
                    "index": index,
                    "authorization": "secret-value",
                    "padding": "padding padding padding"
                }))
                .unwrap();
        }
        writer.sync_all().unwrap();
        assert!(path.exists());
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(!fs::read_to_string(&path).unwrap().contains("secret-value"));
        let count = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("events.jsonl")
            })
            .count();
        assert!(count <= 3);

        let document = dir.path().join("incident.json");
        atomic_write_redacted_json(
            &document,
            &serde_json::json!({"apiKey":"secret-value","safe":1}),
            "",
        )
        .unwrap();
        let content = fs::read_to_string(&document).unwrap();
        assert!(!content.contains("secret-value"));
        assert_eq!(
            fs::metadata(document).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
